---
title: Performance Profiling
description: How to find the real bottleneck in a slow system using data instead of guesswork, and how to talk through that process in an interview
difficulty: Core
tags: [performance, profiling, debugging, dotnet]
---

"It's slow" is not a diagnosis. Performance work is an investigation with a hypothesis, a measurement, and a fix — in that order. Interviewers use this topic to see whether you reach for tools and data or start randomly changing code.

## Measure first, and Amdahl's law

The single biggest mistake is optimising the part of the system you *assume* is slow. Profile first, form a hypothesis from the data, fix the biggest contributor, then re-measure. Anything else is guessing with extra steps.

Amdahl's law formalises why this matters: the speed-up from optimising one part of a system is capped by how much time that part actually consumes.

```text
Speedup = 1 / ((1 - P) + P / S)
```

Where `P` is the fraction of total time spent in the part you're speeding up, and `S` is how much faster you make it. If a component is only 10% of total time, making it infinitely fast saves at most 10% overall — no matter how proud you are of the fix.

> [!KEY]
> Optimise the largest bar in the profiler, not the ugliest piece of code. A perfectly tuned function that consumes 2% of runtime is a waste of a sprint.

## The four resources

Every performance problem eventually traces back to contention on one of four resources. Knowing the symptom table cold lets you triage in seconds.

| Resource | Symptom | Common tools |
|---|---|---|
| CPU | High CPU%, requests queue up, latency scales with load | `dotnet-trace`, flame graphs, `perf`, Task Manager |
| Memory | Growing working set, frequent GC pauses, eventual `OutOfMemoryException` | `dotnet-counters`, `dotnet-gcdump`, memory profiler |
| Disk IO | High queue length, latency spikes on read/write, `await` stalls near file/db calls | `iostat`, Resource Monitor, DB wait stats |
| Network | Latency proportional to round trips, timeouts under load, works fine locally | `Wireshark`, `netstat`, APM traces |

> [!TIP]
> A senior answer names the resource *before* naming the fix: "CPU is pegged at 100% on all cores, so this is compute-bound — I'd profile hot paths, not add more threads."

## CPU profiling: sampling vs instrumenting

There are two fundamentally different ways to capture where CPU time goes.

| Approach | How it works | Overhead | Best for |
|---|---|---|---|
| Sampling | Interrupts the process periodically (e.g. every 1ms) and records the call stack | Low (~1-5%) | Production-safe profiling, general hot-path discovery |
| Instrumenting | Injects timing code at every method entry/exit | High (can be 10x+ slowdown) | Precise call counts and exact timings in dev/test |

A **flame graph** is the standard way to read sampling output. Each box is a function; width is proportion of samples (time), and stacking shows the call hierarchy — a child box sits directly above its caller.

```mermaid
graph TD
    A["HandleRequest — 100% width"] --> B["ParseJson — 15%"]
    A --> C["QueryDatabase — 60%"]
    A --> D["RenderResponse — 25%"]
    C --> E["Npgsql.ExecuteReader — 55%"]
    C --> F["Mapping — 5%"]
```

Read it as: wide, flat plateaus are your bottleneck. `QueryDatabase` dominates here, so that's where you dig next — not `ParseJson`, even if its code looks messier.

```bash
# Capture a CPU trace of a running .NET process (sampling profiler)
dotnet-trace collect --process-id 1234 --providers Microsoft-DotNETCore-SampleProfiler
# Then open the .nettrace file in PerfView, Visual Studio, or speedscope for a flame graph
```

## Allocation profiling and GC pressure

Allocating too much, too often, forces the garbage collector to run constantly, and every GC pause steals CPU from real work. `dotnet-counters` surfaces `% Time in GC` and `Gen 0/1/2` collection rates live; a healthy service spends well under 5-10% of CPU time in GC.

Common allocation hot spots: boxing value types, LINQ over hot paths (`.Select().Where().ToList()` allocates iterators and lists), string concatenation, and closures capturing variables. Gen 2 collections are expensive because they scan long-lived objects; Large Object Heap (LOH, objects ≥85KB) allocations are especially costly because the LOH is not compacted by default.

```csharp
// Allocates a new closure, iterator and list on every call — fine at low volume, deadly at 50k req/s
var active = users.Where(u => u.IsActive).Select(u => u.Name).ToList();

// Fewer allocations on the hot path: one pre-sized result list, no iterator chain
var active = new List<string>(users.Count);
foreach (var u in users)
    if (u.IsActive) active.Add(u.Name);
```

## Lock contention and thread-pool starvation

Under load, two very different symptoms look similar (everything gets slow) but have opposite fixes.

- **Lock contention**: threads block waiting for a `lock`/`Monitor`/`SemaphoreSlim` held by another thread. Visible as high "wait" time with low CPU, and it gets *worse* as concurrency increases. Fix by shrinking the critical section, using lock-free structures (`ConcurrentDictionary`), or partitioning the lock.
- **Thread-pool starvation**: the pool has too few worker threads to service queued work, because existing threads are blocked (often by synchronous IO or `.Result`/`.Wait()` on a `Task`). Visible as growing queue length in `ThreadPool.PendingWorkItemCount` while CPU sits idle.

> [!DANGER]
> Blocking on async code with `.Result` or `.Wait()` is the single most common cause of thread-pool starvation in ASP.NET Core services. It ties up a thread pool thread doing nothing while waiting for another thread pool thread to finish — under enough load, the pool simply runs out.

## Async and the hidden serialisation trap

`async`/`await` frees up threads while waiting on IO, but it does not automatically parallelise anything. A common bug: awaiting several independent operations sequentially instead of starting them together.

```csharp
// Serialised — total time = sum of all three (bad)
var user = await GetUserAsync(id);
var orders = await GetOrdersAsync(id);
var prefs = await GetPreferencesAsync(id);

// Parallel — total time = the slowest of the three
var userTask = GetUserAsync(id);
var ordersTask = GetOrdersAsync(id);
var prefsTask = GetPreferencesAsync(id);
await Task.WhenAll(userTask, ordersTask, prefsTask);
```

The first version reads fine and passes code review, which is exactly why it's a classic interview "spot the bug" scenario.

## The database is the usual culprit

In most CRUD-style services, the database — not the CPU — is the real bottleneck. The three repeat offenders:

1. **N+1 queries** — one query to fetch a list, then one more query per row to fetch related data. Fix with a join, an `Include()`, or batch loading.
2. **Missing index** — a query that should be `O(log n)` degrades to a full table scan, `O(n)`, and gets worse as the table grows. `EXPLAIN`/execution plans reveal this instantly.
3. **Chatty calls** — many small round trips instead of one batched call; each round trip pays full network latency even if the query itself is trivial.

## Latency budget decomposition

Break a single request into a budget, then measure where the actual time goes. This turns "the API feels slow" into a specific, fixable line item.

| Stage | Budget | Typical actual (unoptimised) |
|---|---|---|
| Load balancer + TLS | 1-2 ms | 1-2 ms |
| Auth/middleware | 1-3 ms | 1-3 ms |
| App logic (CPU) | 2-5 ms | 2-5 ms |
| Database round trip | 5-15 ms | 80-300 ms (N+1 or missing index) |
| Downstream service call | 10-30 ms | 10-30 ms |
| Serialization | 1-2 ms | 1-2 ms |
| **Total** | **~20-60 ms** | **~200-500 ms** |

## Caching as the last resort, not the first

Caching hides a slow path instead of fixing it, and it adds invalidation complexity, stale-data bugs, and a new failure mode (cache stampede) to your system. The order of operations should be: fix the algorithm, fix the query/index, batch the calls — *then* cache what's left, because it's expensive by nature (e.g. a genuinely heavy aggregation) rather than expensive by accident.

> [!WARNING]
> Caching a symptom (a slow N+1 query) instead of the cause means the underlying query still runs on every cache miss and every cold start, and now you also have to reason about staleness.

## Benchmarking correctly

Microbenchmarks are easy to get subtly wrong. **BenchmarkDotNet** exists specifically to eliminate the usual mistakes: it runs a warm-up phase so the JIT has compiled and optimised the method, runs many iterations to get statistically stable numbers, and isolates each benchmark in its own process.

```csharp
[MemoryDiagnoser]
public class StringBench
{
    private readonly string[] _parts = Enumerable.Range(0, 100).Select(i => i.ToString()).ToArray();

    [Benchmark(Baseline = true)]
    public string Concat() {
        var s = "";
        foreach (var p in _parts) s += p; // O(n²) — quadratic copying
        return s;
    }

    [Benchmark]
    public string Builder() {
        var sb = new StringBuilder();
        foreach (var p in _parts) sb.Append(p);
        return sb.ToString();
    }
}
```

Pitfalls to name out loud: forgetting **warm-up** (the first call always includes JIT compilation time), the **JIT** inlining or eliminating code differently in `Debug` vs `Release`, and **dead-code elimination** silently dropping a computed-but-unused result so you end up benchmarking nothing. Always consume the result (return it, or assign to a field BenchmarkDotNet tracks) and always benchmark a `Release` build.

## A diagnosis flowchart

```mermaid
flowchart TD
    A["Slow request reported"] --> B{"CPU high?"}
    B -->|"Yes"| C["CPU profile: flame graph"]
    B -->|"No"| D{"GC time high?"}
    D -->|"Yes"| E["Allocation profile: reduce allocs"]
    D -->|"No"| F{"Waiting on IO?"}
    F -->|"DB"| G["Check query plan, N+1, indexes"]
    F -->|"Network"| H["Trace round trips, check DNS/TLS"]
    F -->|"No"| I["Check lock contention & thread pool"]
```

## Cheat sheet

- Measure before you optimise — profile, hypothesise, fix, re-measure.
- Amdahl's law: speed-up is capped by the fraction of time the part you fixed actually consumed.
- Four resources: CPU, memory, disk IO, network — each has its own symptom signature.
- Sampling profilers are production-safe; instrumenting profilers are precise but heavy.
- Flame graph width = time; look for wide plateaus, not deep stacks.
- High GC time = allocation problem, not CPU problem.
- `.Result`/`.Wait()` on async code is the classic thread-pool starvation cause.
- The database is usually the bottleneck — check N+1, indexes, and round trips first.
- Cache last, after the algorithm and the query are actually fixed.
- BenchmarkDotNet handles warm-up and JIT for you; watch for dead-code elimination.

## Common mistakes

| Mistake | Fix |
|---|---|
| Optimising the part that "looks slow" without profiling | Always start from a flame graph or trace |
| Adding threads to fix a lock-contention problem | Shrink the critical section instead — more threads just queue up faster |
| Awaiting independent async calls sequentially | Start them together and `Task.WhenAll` |
| Benchmarking a `Debug` build | Always benchmark `Release`, with warm-up |
| Caching a query instead of fixing its index | Fix the query first; cache only genuinely expensive work |
| Ignoring Gen 2 and LOH pressure | Gen 2 pauses are expensive, and the LOH is not compacted by default — watch object sizes |

## Summary

Performance debugging is a disciplined loop: profile to find where time actually goes, form a hypothesis grounded in one of the four resources, fix the single largest contributor, and re-measure before moving on. CPU, memory, IO and network each leave a distinct fingerprint, and .NET ships the tools to see all four (`dotnet-trace`, `dotnet-counters`, `dotnet-gcdump`). Caching and micro-optimisation are the last steps, not the first — fix the algorithm and the query before reaching for either.

## Top Interview Questions

### Q1. Walk me through how you'd investigate an API endpoint that suddenly got slower in production.

First, check what changed: deploys, traffic volume, data size, or a downstream dependency. Then look at the four resources: is CPU pegged (compute-bound), is GC time elevated (allocation-bound), is the thread pool queue growing while CPU is idle (starvation), or is latency proportional to a DB/network call (IO-bound)? I'd pull a CPU trace or flame graph if compute-bound, or check the database's slow-query log and execution plans if IO-bound, since the DB is the most common real culprit. I'd fix the single largest contributor first and re-measure rather than changing several things at once, since that makes it impossible to know what actually helped.

### Q2. What is Amdahl's law and why does it matter when prioritising performance work?

Amdahl's law says the maximum speed-up from optimising part of a system is `1 / ((1 - P) + P/S)`, where `P` is the fraction of total time that part consumes and `S` is its speed-up factor. If a function is only 5% of total runtime, making it infinitely fast still only saves 5% overall. It matters because it forces you to look at a profile before committing time: without data, engineers gravitate towards the ugliest or most familiar code, which is often not where the time actually goes. The practical takeaway is to always optimise the widest bar in the profiler, not the messiest function.

### Q3. What's the difference between a sampling profiler and an instrumenting profiler?

A sampling profiler periodically interrupts the process (e.g. every millisecond) and records the current call stack, building up a statistical picture of where time is spent, with low overhead — typically a few percent — which makes it safe to run in production. An instrumenting profiler injects timing code at every method's entry and exit, giving exact call counts and precise per-call timing, but the injected code itself can slow the program down by 10x or more, and can even change which code path the JIT chooses. In interviews, the expected answer is: use sampling for finding hot paths in a live or realistic environment, and instrumenting when you need exact call counts in a controlled dev/test run.

### Q4. How do you read a flame graph?

Each box represents a function on the call stack; the y-axis (stacking) shows caller-callee relationships — a box's parent is the function that called it. The x-axis is *not* time-ordered; width represents the proportion of total samples in which that function was on the stack, i.e. how much time it (and everything it calls) consumed. You look for wide, flat plateaus near the top of the stack — those are the functions actually burning CPU, as opposed to a function that is wide only because a child of it is expensive. A tall, narrow spike is a deep call chain that doesn't cost much time; a short, wide box is where the real work happens.

### Q5. What causes thread-pool starvation in an ASP.NET Core app, and how do you detect it?

Starvation happens when there is more queued work than available worker threads, and the pool can't create new threads fast enough (it grows slowly, about one thread every couple of hundred milliseconds under sustained demand). The most common cause is blocking a thread-pool thread on synchronous work that's actually asynchronous underneath — calling `.Result` or `.Wait()` on a `Task`, or doing synchronous file/DB IO on a request thread. Symptoms: `ThreadPool.PendingWorkItemCount` grows, request latency climbs even though CPU usage is low, and `dotnet-counters` shows a rising queue length. The fix is to use `async`/`await` all the way down and never block on a `Task` from request-handling code.

### Q6. Why is caching considered a "last resort" rather than a first optimisation?

Caching doesn't fix the underlying cost — it hides it behind a fast path that only works until the cache misses, expires, or is invalidated. It also introduces new problems the original code didn't have: staleness bugs, invalidation complexity, memory pressure from the cache itself, and a "cache stampede" failure mode where many requests miss simultaneously and hammer the origin at once. The right order is to fix the algorithm's complexity, fix missing indexes and N+1 queries, and batch chatty calls first — those fixes make every request faster with no added state. Cache only what remains genuinely expensive, such as a heavy cross-service aggregation that's identical for many callers.

### Q7. What's the difference between lock contention and thread-pool starvation, and how do their symptoms differ?

Lock contention is threads actively blocked waiting to acquire a lock held by another thread; it shows up as high "wait" or blocked time, often with moderate CPU usage, and gets measurably worse as you add concurrency, since more threads compete for the same lock. Thread-pool starvation is a shortage of worker threads to pick up queued work at all, typically because existing threads are blocked on synchronous IO; it shows up as a growing work-item queue with *low* CPU usage, because nothing is actually executing. The fix for contention is to shrink or eliminate the critical section (or use a lock-free structure); the fix for starvation is to stop blocking threads and let async code yield them back to the pool.

### Q8. Why can allocation-heavy code be slow even if it isn't algorithmically slow?

Allocating objects fills up the managed heap, and once a generation fills, the garbage collector runs a collection — walking live objects, and for Gen 2/LOH, potentially compacting memory. Every GC pause consumes CPU that isn't doing application work, and under high allocation rates this can dominate total CPU time even if the algorithm itself is `O(n)`. Boxing value types, LINQ chains on hot paths, and per-request closures are common silent sources. The fix is to profile allocations (`dotnet-counters`, `dotnet-gcdump`), find the top allocators, and replace them with pre-sized collections, `Span<T>`, or manual loops where the hot path demands it — while leaving cold paths readable with LINQ.

### Q9. What mistakes commonly invalidate a BenchmarkDotNet (or any microbenchmark) result?

Skipping warm-up means the first few iterations include JIT compilation time, which skews results toward "slow"; BenchmarkDotNet handles this automatically by running a pilot phase. Benchmarking a `Debug` build is a classic mistake, since `Debug` disables many JIT optimisations that `Release` applies. Dead-code elimination is subtler: if a benchmarked method's result is never consumed, the JIT (or even the benchmark harness without proper handling) may skip computing it entirely, making an expensive operation look free — always return or consume the computed value. Finally, running on a laptop with background load, power-saving CPU throttling, or without isolating iterations produces noisy, non-repeatable numbers.

### Q10. A batch job reads three independent pieces of data per record using `await` and it's much slower than expected. What's wrong and how do you fix it?

The likely bug is sequential awaiting: `var a = await FetchA(); var b = await FetchB(); var c = await FetchC();` runs three round trips back-to-back, so total latency is the *sum* of all three, even though they don't depend on each other. The fix is to start all three tasks first, then await them together: `var ta = FetchA(); var tb = FetchB(); var tc = FetchC(); await Task.WhenAll(ta, tb, tc);` — total latency becomes the *slowest* of the three instead of the sum. For a batch job processing many records, I'd also check whether the same fix should apply across records (e.g. bounded parallelism with `Task.WhenAll` over chunks or a `SemaphoreSlim` to cap concurrency) rather than looping one record at a time.
