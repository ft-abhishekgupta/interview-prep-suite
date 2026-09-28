---
title: Load and Performance Testing
description: The six load test types compared, open versus closed workload models, coordinated omission, and how to read percentiles correctly under load
difficulty: Advanced
tags: [performance-testing, load-testing, percentiles, capacity-planning]
---

Performance testing is where a lot of engineers say correct-sounding words ("we tested at 1000 rps") without understanding what the number actually measured. The interview signal is precision: which test type, which workload model, which metric, and what you did with the result.

## The six types of performance test

| Type | Question it answers | Typical shape |
|---|---|---|
| Smoke | Does the system work at all under a trivial load? | Very low load, short duration, run after every deploy |
| Load | Does the system meet its SLOs at expected/peak traffic? | Realistic load profile, sustained for minutes |
| Stress | Where does the system break, and how does it fail? | Load increased past expected peak until errors/degradation appear |
| Spike | Can the system survive a sudden, large jump in traffic? | Near-instant jump from baseline to high load, then back down |
| Soak (endurance) | Does the system degrade over long sustained operation? | Moderate load sustained for hours/days |
| Breakpoint (capacity) | What is the exact maximum throughput before failure? | Load ramped gradually until the system fails, to find the ceiling |

> [!KEY]
> Each type answers a different question — running only "load" tests and calling it "performance testing" leaves soak-related bugs (memory leaks, connection pool exhaustion, log disk fill-up) and stress-related failure modes (does it degrade gracefully or fall over entirely) completely uncovered.

## Defining a workload model from real traffic

A performance test is only as good as its workload model — the shape of requests it replays. Pull the model from production observability, not guesswork:

- **Request mix** — the real ratio of endpoints hit (e.g., 70% product view, 20% search, 8% add-to-cart, 2% checkout), not a uniform distribution across all endpoints.
- **Arrival pattern** — steady, bursty, or following a daily/weekly curve (e.g., lunchtime spike for a food delivery app).
- **Payload realism** — real data sizes and shapes (a search for one word vs. ten words behaves very differently under load).
- **Think time** — the pause a real user takes between actions, which affects how many concurrent sessions are needed to produce a given request rate.

> [!TIP]
> "We replayed a day of real production traffic at 3x, sampled from the busiest hour, with real request-mix ratios" is a far stronger answer than "we hit the login endpoint 1000 times a second," because it shows you understand that unrealistic workload shapes can hide or invent bottlenecks that don't reflect reality.

## Open versus closed workload models

This is the single most misunderstood concept in load testing, and naming it correctly is a strong signal.

| Model | How new requests arrive | Real-world analogy | Risk if used wrong |
|---|---|---|---|
| Closed | A fixed number of "virtual users" each wait for their previous request to finish before sending the next | A fixed number of people in a queue, one in, one out | Understates the true impact of slowdowns — if the system gets slower, the closed model's users just wait longer, arrival rate drops, and the system self-regulates in a way real independent users never would |
| Open | New requests arrive at a target rate regardless of whether previous requests have finished | Real independent users hitting a public website, all unaware of each other | Correctly reveals a system falling behind — the queue of unanswered requests grows without bound, which is what actually happens in production |

```mermaid
flowchart TD
    subgraph "Closed model"
        C1["Virtual user"] --> C2["Send request"] --> C3["Wait for response"] --> C1
    end
    subgraph "Open model"
        O1["Requests arrive at fixed rate<br/>independent of prior responses"] --> O2["System"]
    end
```

> [!DANGER]
> Most load-testing tools default to a closed model (fixed thread/user count). If your real traffic is open (independent users, e.g., a public API or website), a closed-model test will systematically hide the exact failure mode you're trying to find — a slowing system, under a closed model, just makes each virtual user wait longer instead of piling up a growing backlog, which is precisely what would happen for real.

## Coordinated omission

A closed-model measurement bug that inflates apparent performance: if a request takes far longer than expected, the *next* request from that same virtual user is delayed in starting — so the tool never measures the wait that a real, independently-arriving user would have experienced during that stall. The result is that reported percentiles look better than reality, sometimes dramatically so, especially at the tail.

```text
Real open-model arrivals every 100ms: request 1 issued at t=0, expected next at t=100ms
System stalls: request 1 takes 5000ms
Closed model:  next request only issued at t=5000ms (waited for the stall) — that 4900ms "missing" wait is never recorded
Open model:    requests kept arriving every 100ms regardless — the pile-up and its latency are fully recorded
```

Tools aware of this (later versions of `wrk2`, Gatling, k6 with the right configuration) correct for it by scheduling requests at the intended open-model rate and recording the full wait, even when a request "should" have started earlier.

## Measuring correctly

| What to measure | Why | Common mistake |
|---|---|---|
| Percentiles (p50, p95, p99, p99.9) | Averages hide tail latency that a meaningful fraction of real users experience | Reporting only the average/mean latency |
| Error rate under load | A system returning fast error responses looks "fast" on latency alone | Ignoring errors while celebrating low average latency |
| Saturation of the system under test | CPU, memory, connection pool, thread pool, disk I/O — where the *system* is maxed out | Only watching the load generator's own resource usage |
| Saturation of the load generator | If the generator itself is CPU-bound, it can't produce the load you think it's producing | Trusting the reported rps without checking generator health |

> [!WARNING]
> If your load generator's own CPU is pegged at 100%, the test results describe the load generator's limits, not your system's. Always monitor the generator's resource usage alongside the target system's — a classic silent-invalidator of load test results.

## Finding the knee of the curve

Plotting latency (or error rate) against increasing load reveals a "knee" — the point where latency stops growing linearly with load and starts growing sharply, usually because some resource (a connection pool, a thread pool, a CPU core) has saturated and requests start queueing.

```text
Throughput →
Latency
  |                                    ___/
  |                              _____/
  |                        _____/
  |            ___________/
  |___________/
  +----------------------------------------→ Load
              knee point: latency starts
              growing much faster than load
```

The knee, not the point of total failure, is usually the number you want for capacity planning — operating near or past it means latency is already degrading for real users even though the system hasn't fully fallen over yet.

## Profiling to find the bottleneck after the test

A load test tells you *that* the system degrades at a given point; it doesn't tell you *why*. After identifying the knee or a stress-test failure, profile the system during a repeat run: CPU flame graphs, database query plans (is a query doing a full table scan under load that an index would fix), connection pool metrics (are requests queueing for a database connection), GC pause frequency, thread pool starvation. The load test finds *where* to look; profiling finds *what's actually wrong*.

## Environment fidelity and cost

| Environment | Fidelity | Cost | When it's enough |
|---|---|---|---|
| Local/dev machine | Low | Free | Never for real capacity numbers — different hardware, no realistic network |
| Shared staging, undersized | Medium | Low | Relative comparisons between two versions of your own code |
| Production-sized, isolated | High | High (duplicate infra) | Absolute capacity numbers you'll actually rely on |
| Production itself (shadow/canary traffic) | Highest | Managed carefully | Validating real-world behaviour without a parallel environment |

Running a full-scale test against a production-sized clone is expensive, so many teams use a smaller environment for regression comparisons ("is this release 10% slower than last release, tested consistently") and reserve full-fidelity testing for major capacity milestones or before a known traffic event (a sale, a launch).

## Testing in production with shadow traffic

Shadow (or "dark") traffic duplicates real production requests to a new version of the system without returning its responses to real users, letting you validate performance and correctness under genuinely real traffic patterns and data — the highest-fidelity test possible — without any user-facing risk, since the shadow responses are discarded or only compared, never served.

## Performance regression gates in CI

Running a lightweight load test (a fixed, small load profile, short duration) on every build or nightly, and failing the build if p95 latency or error rate regresses beyond a threshold versus the last known-good baseline, catches performance regressions while they're a one-line diff instead of an accumulated mess discovered during a pre-launch stress test three sprints later.

```yaml
# Simplified CI gate example
- name: Run performance regression check
  run: k6 run --out json=results.json perf/checkout-smoke.js
- name: Compare against baseline
  run: python perf/compare_baseline.py results.json --max-p95-regression-pct 10
```

## Worked example: interpreting results

A load test against a checkout API at a target of 500 rps (open model) reports: p50 = 45ms, p95 = 210ms, p99 = 1,800ms, error rate = 0.4%, database connection pool utilisation = 98%.

The senior read: the p50 looks healthy, but the p99 is 40x the p50 — a strong sign of queueing, not uniformly slow processing, and the near-saturated connection pool is the prime suspect (requests waiting for a free connection would show exactly this pattern — fast when a connection is free, very slow when queued behind others). The fix to investigate first is connection pool sizing (and whether the database itself, not just the pool, is the actual bottleneck) before anything else — profiling would confirm whether pool wait time or actual query time is the dominant contributor to that p99.

## Tool choices and micro-benchmarks

Tool choice should follow the protocol, workload model and team ecosystem. A JavaScript-friendly platform team may choose k6, a JVM-heavy performance team may choose Gatling, and a .NET backend team may prefer NBomber because scenarios are written in C# and can reuse internal clients.

| Tool | Scripting language | Model | Best for | Main limitation |
|---|---|---|---|---|
| k6 | JavaScript | Code-first load tests with strong CI output | Modern HTTP, gRPC and WebSocket checks in pipelines | JavaScript runtime is not a browser and complex protocols may need extensions |
| JMeter | GUI plans plus plugins and scripts | Thread and sampler based test plans | Enterprise estates with many protocols such as HTTP, JDBC and JMS | Heavy plans can be hard to version, review and keep realistic |
| Gatling | Scala or Java DSL | Scenario-based virtual users with strong reports | High-scale HTTP tests and detailed latency analysis | JVM and DSL learning curve can be high for non-JVM teams |
| Locust | Python | User behavior classes executed by distributed workers | Python teams and custom workflows that need ordinary code | Requires careful worker sizing or the generator becomes the bottleneck |
| NBomber | C# and F# | Step and scenario based load simulations | .NET services, service clients, queues and protocol mixes | Smaller ecosystem than JMeter or k6 and less universal hiring familiarity |

None of these tools replaces observability on the system under test. A load tool can tell you response time, throughput and errors from the client side; it cannot by itself tell you whether the root cause is a database pool, GC pause, lock contention or downstream dependency.

### BenchmarkDotNet is not a load test

BenchmarkDotNet measures a small piece of code in-process: parsing, serialization, allocation-heavy transformations, hashing, routing helpers, custom collections. It does not answer whether an API survives 1,000 rps, because it does not include the deployed service, network, database, thread pool pressure or realistic concurrency.

Do not benchmark serious .NET code with `Stopwatch` in a loop. That usually measures JIT warm-up, tiered compilation, dead-code elimination, GC noise, CPU frequency changes and harness overhead. BenchmarkDotNet handles warm-up, multiple iterations, statistical summaries and diagnosers.

```csharp
using BenchmarkDotNet.Attributes;
using BenchmarkDotNet.Running;

[MemoryDiagnoser]
public class OrderParserBenchmarks
{
    private readonly string _json = "{\"id\":42,\"total\":99.95}";

    [Benchmark]
    public OrderDto ParseOrder() => OrderParser.Parse(_json);
}

public static class Program
{
    public static void Main() => BenchmarkRunner.Run<OrderParserBenchmarks>();
}
```

`[MemoryDiagnoser]` reports allocations, bytes allocated per operation and garbage collection counts. That is valuable when p99 latency points toward allocation pressure or GC pauses, but it is still a microscope for one code path. Use it after profiling suggests a hot method matters; use load tests to validate the whole system under realistic traffic.

## Cheat sheet

- Smoke, load, stress, spike, soak, breakpoint each answer a different question — pick deliberately, don't rely on just one.
- Build the workload model from real production traffic: request mix, arrival pattern, payload realism, think time.
- Open model = independent arrivals (usually reality); closed model = fixed virtual users waiting in turn — mismatched model choice hides real failure modes.
- Coordinated omission makes closed-model tools under-report tail latency during a stall — use tools that correct for it.
- Report percentiles (p95/p99), error rate, and saturation of the *system under test* — not just the average, and not the load generator's own limits.
- The "knee of the curve" (where latency starts growing much faster than load) is usually the practical capacity number, not the point of total collapse.
- Load testing finds where to look; profiling finds what's actually wrong.
- Shadow traffic and CI regression gates extend performance testing beyond one-off pre-launch events.
- k6, JMeter, Gatling, Locust and NBomber are workload tools; choose by protocol, ecosystem and CI fit.
- BenchmarkDotNet is for in-process micro-benchmarks and allocation analysis, not service capacity.

## Common mistakes

| Mistake | Fix |
|---|---|
| Reporting only average latency | Report p50/p95/p99(.9) and error rate together |
| Using a closed-model tool for open-model real traffic | Choose a tool/config that models open arrivals, or correct for coordinated omission |
| Trusting rps numbers without checking the load generator's own CPU/memory | Monitor the generator alongside the target system |
| Testing only "load" and skipping stress/soak/spike | Run the type that matches the actual risk being investigated |
| Load testing on an undersized environment and reporting numbers as absolute capacity | Use a production-sized environment for absolute numbers; smaller environments only for relative regression comparisons |
| Treating the point of total failure as the usable capacity | Use the knee of the latency curve, which usually appears well before total failure |
| Using `Stopwatch` loops as micro-benchmarks | Use BenchmarkDotNet so warm-up, JIT, GC and allocation noise are handled properly |
| Choosing a load tool because it is popular | Match tool, protocol, scripting language and workload model to the team's system |

## Summary

Performance testing is precise work: choosing the right test type for the question being asked, building a workload model from real traffic rather than guesswork, and correctly distinguishing open from closed arrival models so tail latency isn't silently hidden by coordinated omission. Measuring percentiles, error rate, and the saturation of the system under test (not the generator) turns a load test into an actionable result, and the knee of the latency curve is usually the number worth planning capacity around. Tools such as k6, JMeter, Gatling, Locust and NBomber generate workload; BenchmarkDotNet measures local code paths. A load test tells you where to look, profiling and micro-benchmarks explain what is hot, and shadow traffic plus CI regression gates keep the discipline ongoing.

## Top Interview Questions

### Q1. Explain the difference between load, stress, and spike testing.

Load testing validates that the system meets its latency and error-rate targets under the traffic it's actually expected to handle, sustained for a realistic duration — it answers "does this work at expected peak." Stress testing deliberately pushes load beyond that expected peak, increasing until something breaks, to answer "where is the ceiling, and does the system degrade gracefully (shed load, return errors cleanly) or fail catastrophically (crash, cascade failures to dependencies)." Spike testing applies a near-instantaneous jump from baseline to a high load level and back down, answering a narrower question: can the system survive a sudden burst — like a marketing email blast or a viral social post — without the sudden ramp itself (rather than sustained high load) causing a failure, such as autoscaling not reacting fast enough or a connection pool being exhausted before new capacity comes online.

### Q2. What is the difference between an open and a closed workload model, and why does it matter?

In a closed model, a fixed number of virtual users each send a request, wait for the response, and only then send their next request — so if the system slows down, each virtual user simply waits longer and the effective arrival rate drops, meaning the system's own slowdown throttles the offered load. In an open model, new requests arrive at a target rate independent of whether earlier requests have finished, which is how real independent users actually behave on a public-facing system — if the system slows down, unanswered requests pile up and the queue (and its latency) grows, which is the failure mode that actually matters in production. Using a closed-model tool to test a system whose real traffic is open can make a system that's genuinely falling over look like it's merely "a bit slower under load," because the tool never lets the true backlog form.

### Q3. What is coordinated omission and why does it matter for interpreting load test results?

Coordinated omission is a measurement artifact in closed-model load-testing tools: when a request stalls for far longer than expected, the tool waits for that response before issuing the next request from the same virtual user, so it never records the wait that a real, independently-arriving request would have experienced during that stall. The practical effect is that reported latency percentiles — especially p99 and above — look significantly better than what real users actually experienced, because the tool effectively "forgives" the exact scenario (repeated stalls) it should be measuring most carefully. Tools and configurations that correct for this schedule requests at the intended constant rate regardless of prior response times and record the true, uncorrected wait, giving an honest picture of tail latency during instability.

### Q4. Why should you always measure percentiles instead of just the average latency?

Averages are dominated by the bulk of fast requests and can look perfectly healthy even when a meaningful fraction of real users are experiencing serious slowness — for instance, an average of 50ms can coexist with a p99 of 3 seconds if 1% of requests are hitting a slow path (a cache miss, a lock contention, a GC pause). Since a system serving millions of requests a day turns even a small percentage into a large absolute number of badly-served users, percentiles (p50, p95, p99, sometimes p99.9) are what actually describe the experience of real users at the tail, which is usually where the interesting and fixable problems live. A senior answer also connects this to SLOs: most real service-level objectives are defined in percentile terms (e.g., "p99 under 500ms") precisely because averages are too easy to satisfy while still failing real users.

### Q5. How do you identify the actual bottleneck once a load test shows the system degrading?

The load test itself only shows *that* and *at what load* degradation begins (often visible as the "knee" in a latency-versus-load curve); finding *why* requires profiling a repeat run at or near that load level. Check resource saturation on the system under test specifically — CPU, memory, database connection pool utilisation, thread pool queue length, disk I/O, garbage collection pause frequency — and correlate the metric that saturates with the point where latency inflects. From there, targeted profiling (a CPU flame graph, a database query plan, connection pool wait-time metrics) pinpoints the specific resource or code path responsible, rather than guessing — a very large p99-to-p50 gap combined with a near-saturated connection pool, for example, points strongly at requests queueing for a scarce connection rather than the requests themselves being slow to execute.

### Q6. Your load test shows great average latency but a poor p99. What would you investigate?

A large gap between p50/average and p99 usually points to queueing or contention rather than uniformly slow processing — something is fast most of the time but occasionally forces a subset of requests to wait significantly. Likely candidates: a connection pool or thread pool that's undersized relative to load, causing some requests to queue for a free resource; garbage collection pauses in a managed runtime causing periodic stalls; a cache with a low hit rate where cache misses fall back to a much slower path; or lock contention on a shared resource that only bites under concurrent load. The investigation would check pool utilisation metrics and GC pause logs first (cheap to check), then move to distributed tracing or profiling on a sample of the actual slow requests to confirm which of these is the dominant cause, since fixing the wrong one wastes effort without moving the p99.

### Q7. Why might a load test give misleadingly good results even though the system genuinely can't handle the target load in production?

Several ways this happens: the load generator itself may be resource-constrained (CPU-bound) and unable to actually produce the intended request rate, so the "results" describe the generator's ceiling, not the target system's; the test may use a closed workload model against a system whose real traffic is open, which — combined with coordinated omission — hides tail latency and backlog growth entirely; the test environment may be undersized or differently configured (different database size, warmer caches from repeated runs, no realistic network latency) compared to production; or the workload model itself may not reflect real request mix, payload sizes, or arrival patterns, testing a scenario that's easier than reality. A trustworthy result requires checking generator health, matching the workload model (open vs. closed, realistic mix) to real traffic, and running against a production-representative environment.

### Q8. How would you build a realistic workload model for a load test of an e-commerce checkout API?

Pull the actual request mix and arrival pattern from production observability rather than guessing — for example, if analytics show 70% of traffic is product browsing, 20% search, 8% add-to-cart, and 2% checkout, the test should replay that ratio rather than hammering the checkout endpoint alone, since the shared infrastructure (database connections, caches, load balancers) is affected by the whole mix, not just the endpoint being focused on. Capture realistic payload variation (cart sizes, item counts, promo code usage) and a realistic arrival pattern (a lunchtime or evening peak shape rather than a flat rate) sampled from an actual busy period, and include "think time" between a session's actions to correctly translate a target request rate into the right number of concurrent virtual sessions. The result should be validated by comparing the test's traffic shape against a real traffic graph from the same time-of-day window before trusting the load test's conclusions.

### Q9. What is a soak (endurance) test for, and what specific problems does it catch that a load test wouldn't?

A soak test sustains a moderate, realistic load for a long duration (hours to days) specifically to catch problems that only manifest from cumulative effects rather than instantaneous load — memory leaks that slowly grow until an out-of-memory crash, connection or file-handle leaks that eventually exhaust a pool, log files filling up disk space, gradual fragmentation or cache growth degrading performance over time, or scheduled background jobs interacting badly with sustained traffic. A standard load test running for 10–15 minutes would never surface these, since the system simply hasn't run long enough to accumulate the leak to a failure point; the failure is a function of elapsed time and repeated operations, not of instantaneous request rate.

### Q10. How would you set up a performance regression gate in a CI pipeline, and what are the trade-offs?

Run a small, fast, fixed-load performance test (not a full-scale load test — that would be too slow for every build) against a representative environment on a schedule (nightly, or on every merge to main), capturing key metrics like p95 latency and error rate, and compare them against a stored baseline from the last known-good run, failing the build if the regression exceeds a threshold (e.g., p95 worse by more than 10%). The trade-off is fidelity versus speed and cost: a lightweight, small-scale test that runs frequently catches regressions early — while they're a small, easy-to-bisect diff — but at lower fidelity than a full production-scale test, so it won't catch every capacity-related issue; a full-scale test gives higher confidence but is too slow and expensive to run on every commit, so it's reserved for periodic or pre-release milestones.

### Q11. Why is BenchmarkDotNet not a replacement for a load test?

BenchmarkDotNet measures a small piece of .NET code inside one process, such as a parser, serializer, mapper or allocation-heavy hot method. It handles warm-up, tiered JIT behaviour, repeated iterations, statistics and diagnosers like `[MemoryDiagnoser]`, which a `Stopwatch` loop does not. A load test measures a deployed system under concurrent traffic: network, HTTP stack, thread pool, database, queues, caches, downstream dependencies and realistic request arrival patterns. The two answer different questions. Use load testing to discover that p99 latency degrades and profiling to identify a hot path; then use BenchmarkDotNet to compare candidate fixes for that hot path. Passing a micro-benchmark says nothing about service capacity by itself.

### Q12. A stakeholder asks "what's our system's capacity?" after a load test. How do you answer precisely rather than giving a single vague number?

Answer with the knee of the latency curve, not the point of total failure — the load level at which latency starts growing much faster than load, since operating anywhere past that point already means degraded experience for real users even though the system hasn't fully collapsed. Frame the number with its conditions: the workload model it was measured under (request mix, open vs. closed arrival model), the environment it was tested in (production-sized or not, and what that implies about confidence in the absolute number), and which specific resource saturates at that point (so the answer also tells you what to scale first). A precise answer sounds like: "at roughly 650 rps under our real request mix, p99 latency starts climbing sharply because the database connection pool saturates; up to about 550 rps we hold p99 under 300ms" — which is both a capacity number and an actionable next step, rather than a single unqualified "we can handle X requests per second."
