---
title: Processes, Threads and Scheduling
description: How the operating system isolates and schedules work, why context switches are expensive, and how this maps to threads in .NET
difficulty: Core
tags: [operating-systems, concurrency, scheduling, dotnet]
---

Every concurrency bug and every "why is this slow under load" question eventually traces back to how the OS models processes, threads, and scheduling. Interviewers use this topic to check whether you understand what's actually happening below your `async` keyword.

## Process vs thread

A **process** is an isolated unit of execution with its own virtual address space; a **thread** is a unit of scheduling *within* a process, sharing that address space with its sibling threads.

| Property | Process | Thread |
|---|---|---|
| Address space | Own, isolated | Shared with sibling threads |
| Creation cost | High (100s of µs — allocate address space, tables) | Low (~10s of µs — reuse existing address space) |
| Isolation | Strong — one process can't corrupt another's memory | Weak — a bad pointer in one thread can crash the whole process |
| Communication | IPC required (pipes, sockets, shared memory) | Direct — shared heap, shared globals |
| Failure blast radius | Contained to the process | Contained to the process — one thread crashing takes down all threads |
| Context switch cost | Higher (address space/TLB flush) | Lower (registers + stack pointer only) |

> [!KEY]
> Threads are cheap to create and communicate through shared memory, but that same sharing is exactly what causes races, and one crashed thread kills every other thread in the process.

## Context switching and its real cost

A context switch is the CPU saving one thread's state (registers, program counter, stack pointer) and loading another's. Between threads of the *same* process this is relatively cheap — shared address space means the memory management unit (MMU) mappings stay valid. Between *processes*, the switch also invalidates the translation lookaside buffer (TLB), a small cache mapping virtual to physical addresses, forcing subsequent memory accesses to walk page tables again until the cache warms back up.

Rough orders of magnitude: a thread context switch costs **1-10 microseconds**; a full process switch with a TLB flush can cost several times that. At high concurrency, if you have far more runnable threads than CPU cores, the scheduler spends a growing share of wall-clock time switching rather than running your code — this is why unbounded thread creation under load degrades throughput instead of improving it.

## User threads, kernel threads, and green threads

| Model | Who schedules it | Blocking behaviour | Example |
|---|---|---|---|
| Kernel thread (1:1) | OS scheduler | One thread blocking (e.g. on IO) doesn't affect others | .NET `Thread`, Java platform threads, POSIX threads |
| Green thread / user thread (N:1 or M:N) | A runtime scheduler, mapped onto fewer OS threads | Cooperative — a blocking syscall can stall the whole group unless the runtime intercepts it | Goroutines, Erlang processes, .NET `Task` continuations on the thread pool |

.NET's `async`/`await` is closer to the green-thread idea: an `await` doesn't block an OS thread, it registers a continuation and returns the thread to the pool, letting a small number of OS threads service a much larger number of logical, in-flight operations.

## The OS scheduler

Modern OS schedulers are **preemptive**: they can interrupt a running thread even if it hasn't voluntarily yielded, using a hardware timer interrupt. Each thread gets a **time slice** (typically single-digit to tens of milliseconds) before being preempted so others get a turn. Threads are assigned **priorities**, and the scheduler generally favours higher-priority runnable threads — but a naive priority scheme can cause **starvation**, where a low-priority thread never runs because higher-priority threads keep arriving. Most production schedulers counter this with **priority aging** (gradually boosting the priority of threads that have waited a long time).

```mermaid
stateDiagram-v2
    [*] --> Ready
    Ready --> Running: "scheduler dispatches"
    Running --> Ready: "time slice expires (preempted)"
    Running --> Blocked: "waits on IO/lock"
    Blocked --> Ready: "IO completes / lock acquired"
    Running --> Terminated: "returns / exits"
    Terminated --> [*]
```

> [!TIP]
> A strong interview answer names the trade-off: preemptive scheduling guarantees fairness and responsiveness at the cost of context-switch overhead; cooperative scheduling (older systems, some green-thread runtimes) is cheaper but one badly behaved task can starve everyone else.

## CPU-bound vs IO-bound: picking the right model

| Workload | Bottleneck | Right concurrency model |
|---|---|---|
| CPU-bound (image resizing, hashing, number crunching) | Available cores | One worker roughly per core; more threads than cores just adds switching overhead |
| IO-bound (HTTP calls, DB queries, file reads) | Waiting on external systems, not CPU | Async/non-blocking IO so few threads service many concurrent operations |

A classic mistake is spinning up hundreds of threads for an IO-bound workload — the threads spend nearly all their time blocked waiting, not computing, so you pay full context-switch and memory cost (each OS thread reserves stack space, often 1MB by default) for almost no benefit. The correct answer for IO-bound work in .NET is `async`/`await` over `Task`, letting the runtime multiplex many logical waits onto a small thread pool.

## Concurrency vs parallelism

Concurrency is about **structure**: dealing with multiple tasks that are in progress at overlapping times, potentially interleaved on a single core. Parallelism is about **execution**: multiple tasks literally running at the same instant on multiple cores.

```mermaid
flowchart LR
    subgraph "Concurrency — 1 core, interleaved"
        A1["Task A"] -.-> B1["Task B"] -.-> A2["Task A"] -.-> B2["Task B"]
    end
    subgraph "Parallelism — 2 cores, simultaneous"
        C1["Task A — Core 1"]
        C2["Task B — Core 2"]
    end
```

You can have concurrency without parallelism (single-core async code juggling many `await`s) and parallelism without much concurrency (a `Parallel.For` running the same simple loop body on every core). Async IO in .NET is concurrency; `Parallel.For`/`PLINQ` is parallelism.

## IPC mechanisms

Since processes don't share memory by default, they need explicit inter-process communication.

| Mechanism | Direction | Typical use | Notes |
|---|---|---|---|
| Pipe (anonymous) | One-way, parent-child | Shell pipelines (`cmd1 \| cmd2`) | Simple, no naming needed |
| Named pipe | Two-way, unrelated processes | Local RPC-style communication | Exposed as a file-like handle |
| Socket | Two-way, local or networked | Client-server, microservices | Works across machines, not just processes |
| Shared memory | Two-way, same machine | High-throughput data sharing (e.g. media buffers) | Fastest IPC, but needs manual synchronization |
| Message queue | One-way (per message), buffered | Decoupled producer/consumer | OS or broker manages the buffer, e.g. POSIX MQ, RabbitMQ |
| Signal | One-way, asynchronous notification | "Are you still alive", graceful shutdown (`SIGTERM`) | Carries no payload beyond the signal number |

## Zombie and orphan processes

A **zombie process** has finished executing but still has an entry in the process table because its parent hasn't called `wait()` to read its exit status yet — it's dead but not yet reaped. An **orphan process** is the opposite: still running, but its parent has exited first; it gets re-parented (on Unix, typically to `init`/PID 1), which then reaps it when it eventually finishes. Zombies accumulating in a process table is a real production symptom of a parent that forks children but never reaps them.

> [!WARNING]
> A pile of zombie processes doesn't consume CPU or much memory — just a process-table slot — but enough of them can exhaust the OS's max-PID limit and block new processes from being created, which is a subtle way to bring a host down.

## Mapping to .NET threads and the thread pool

.NET maps cleanly onto these OS concepts: `Process.Start` creates a real OS process; `new Thread(...)` creates a dedicated kernel thread with its own stack; the **`ThreadPool`** maintains a pool of reusable worker threads to avoid the cost of creating a new OS thread per unit of work. `Task`/`async`/`await` is built on top of the thread pool — a `Task` isn't a thread, it's a unit of work that a pool thread executes, and `await` on IO frees the pool thread entirely rather than blocking it. The pool grows slowly under sustained demand (roughly one new thread every couple hundred milliseconds past the configured minimum), which is exactly why blocking pool threads under load causes starvation — creation can't keep pace.

```csharp
// Dedicated OS thread — expensive to create, appropriate for long-running/background work
var t = new Thread(DoWork) { IsBackground = true };
t.Start();

// Thread-pool work item — cheap, reused, appropriate for short CPU-bound bursts
ThreadPool.QueueUserWorkItem(_ => DoWork());

// Task over async IO — no thread blocked while waiting
await httpClient.GetAsync(url);
```

## Cheat sheet

- Process = isolated address space; thread = scheduling unit sharing that space.
- Threads are cheap to create and communicate directly; that's also why they're unsafe without synchronization.
- Context switches cost microseconds; process switches cost more due to TLB flushes.
- Preemptive scheduling + time slices + priorities can starve low-priority threads without aging.
- CPU-bound → roughly one worker per core. IO-bound → async, few threads, many concurrent waits.
- Concurrency = dealing with many things at once (structure). Parallelism = doing many things at once (execution).
- IPC needed because processes don't share memory: pipes, sockets, shared memory, queues, signals.
- Zombie = finished but not reaped. Orphan = still running, parent gone, gets re-parented.
- `Task` ≠ thread — it's work scheduled onto the thread pool; `await` frees the thread while waiting.
- Blocking a pool thread (`.Result`, `.Wait()`) under load causes starvation because the pool grows slowly.

## Common mistakes

| Mistake | Fix |
|---|---|
| Creating a new `Thread` per request in a web app | Use the thread pool / async IO instead |
| Assuming more threads always means more throughput | True only while cores are underutilised and workload is CPU-bound |
| Treating `Task` as "a thread" | It's a scheduled unit of work; may run on any pool thread or none while awaiting IO |
| Not reaping child processes | Leads to zombie accumulation and eventual PID exhaustion |
| Using threads to parallelise IO-bound work | Async/non-blocking IO scales much further with far fewer OS resources |
| Ignoring priority inversion/starvation risk | Use fair scheduling or priority aging where starvation is possible |

## Summary

A process is an isolated address space; a thread is a schedulable unit that shares it, which makes threads cheap and fast to communicate through but unsafe without coordination. The OS scheduler is preemptive, dispatching threads for a time slice and honouring priorities while guarding against starvation. The concurrency model should match the workload: roughly one worker per core for CPU-bound work, and async/non-blocking IO for anything spending most of its time waiting. .NET's `Task`/`async`/`await` implements exactly this pattern over the thread pool, which is why blocking a pool thread under load is one of the most common causes of production slowdowns.

## Top Interview Questions

### Q1. What is the difference between a process and a thread?

A process is an isolated execution unit with its own virtual address space, file handles, and resources; the OS guarantees one process cannot directly read or corrupt another's memory. A thread is a unit of scheduling *within* a process — multiple threads in the same process share the same address space, heap, and open handles, communicating directly through shared memory rather than needing IPC. This makes threads much cheaper to create and communicate between, but also means a single thread's bug (a bad pointer, an unhandled exception) can corrupt shared state or crash every thread in that process, whereas one process crashing doesn't directly affect sibling processes.

### Q2. Why is a context switch expensive, and does it cost the same between threads as between processes?

A context switch saves the current thread's CPU register state, stack pointer, and program counter, then loads another thread's. Between threads of the same process this is relatively cheap because they share the same virtual address space, so the memory management unit's mappings remain valid — typically low single-digit microseconds. Switching between processes is more expensive because it also invalidates the TLB (translation lookaside buffer), a small hardware cache of virtual-to-physical address translations; after the switch, memory accesses must walk page tables again until the cache re-warms, adding real, measurable latency. This is one reason threads within a process are preferred over separate processes for tightly cooperating work.

### Q3. What's the difference between concurrency and parallelism?

Concurrency is a property of a program's *structure* — dealing with multiple tasks that are in progress over overlapping time periods, which can happen even on a single CPU core by interleaving execution. Parallelism is a property of *execution* — multiple tasks literally running at the same instant, which requires multiple cores. You can have concurrency without parallelism, such as single-threaded `async`/`await` code juggling many in-flight IO operations on one core, and you can have parallelism with little concurrency, such as a `Parallel.For` loop running identical, independent iterations across cores. The distinction matters because the fix for a CPU-bound bottleneck (more parallelism, more cores) is different from the fix for an IO-bound bottleneck (more concurrency, less blocking).

### Q4. When would you choose more threads versus async IO to scale a workload?

The right choice depends on whether the workload is CPU-bound or IO-bound. For CPU-bound work — image processing, compression, hashing — there's a hard ceiling at the number of physical cores; adding threads beyond that just adds scheduling overhead without more actual computation happening. For IO-bound work — HTTP calls, database queries, file reads — threads spend nearly all their time blocked waiting, not computing, so creating one OS thread per concurrent request wastes memory (each reserves stack space, often ~1MB) and adds context-switch overhead for no benefit; async/non-blocking IO lets a small number of threads service thousands of concurrent waits, since a thread is only occupied while doing actual CPU work.

### Q5. What is thread starvation and how does a scheduler typically prevent it?

Starvation happens when a runnable thread is repeatedly passed over for scheduling because other, higher-priority threads keep becoming ready to run, so the low-priority thread never gets CPU time even though it's not blocked on anything. Naive strict-priority scheduling is vulnerable to this. Most production schedulers mitigate it with priority aging: the longer a thread waits without running, the more its effective priority is boosted, until it eventually outranks the threads that were starving it. This guarantees eventual progress (fairness) at a small cost to strict priority ordering, which is usually the right trade-off in a general-purpose OS.

### Q6. What is a zombie process, and how is it different from an orphan process?

A zombie process has already finished executing, but its entry remains in the process table because the parent process hasn't yet called `wait()`/`waitpid()` to collect its exit status — the process is dead, but its metadata is still "owed" to the parent. An orphan process is the reverse situation: the process is still running, but its parent has already exited; on Unix it gets re-parented, typically to PID 1 (`init`/`systemd`), which then reaps it normally when it finishes. A zombie only costs a process-table slot, not CPU or significant memory, but enough accumulated zombies can exhaust the OS's maximum process/PID limit and prevent new processes from starting — a subtle but real production outage cause if a service forks children without properly reaping them.

### Q7. In .NET, is `Task.Run(...)` the same as creating a new thread?

No. `Task.Run` schedules a unit of work onto the shared thread pool, which reuses a small, dynamically sized set of OS threads rather than creating a dedicated one per task — this avoids the ~100s-of-microseconds cost and ~1MB stack overhead of spinning up a new OS thread for every unit of work. A `new Thread(...)` genuinely creates a dedicated kernel thread that lives until it finishes, appropriate for a long-running or background operation you want isolated from pool scheduling. Crucially, when a `Task` awaits IO, the pool thread it was running on is released back to the pool entirely — the operation isn't "occupying a thread" while it waits, which is what lets a handful of pool threads service thousands of concurrent in-flight requests.

### Q8. You notice request latency climbing under load even though CPU usage stays low. What would you investigate?

Low CPU with rising latency points away from a compute bottleneck and toward either blocking IO or thread-pool exhaustion. I'd check `ThreadPool.PendingWorkItemCount` and the count of available vs busy worker threads — if the queue is growing while threads sit blocked, that's thread-pool starvation, commonly caused by code calling `.Result` or `.Wait()` on a `Task`, or doing synchronous file/database calls on request threads. I'd grep for blocking calls on hot paths and replace them with proper `async`/`await`, and check `ThreadPool.SetMinThreads` isn't being used as a band-aid over the real bug. If threads aren't the issue, I'd check whether a downstream dependency (DB, external API) has degraded, since that also inflates latency without raising local CPU.

### Q9. Why does creating one OS thread per incoming request not scale well for a high-throughput web service?

Each OS thread reserves resources up front — typically around 1MB of stack space by default — and the scheduler has to context-switch between them, which gets more expensive as the count grows well past the number of cores. For IO-bound work like handling HTTP requests, most of that thread's life is spent blocked waiting on a database or another service, not computing, so you're paying real memory and scheduling cost for threads that are mostly idle. At a few hundred concurrent requests this is tolerable; at tens of thousands it exhausts memory and causes excessive context switching, degrading throughput rather than improving it. This is exactly the problem `async`/`await` over the thread pool solves — a small, bounded number of threads services a much larger number of logical in-flight requests.

### Q10. What IPC mechanism would you choose to share a large video buffer between two processes on the same machine with minimal latency, and why?

Shared memory, because it avoids copying the data at all — both processes map the same physical memory region into their own virtual address space, so writes by one are immediately visible to the other without going through the kernel on every access, unlike pipes or sockets which copy data into and out of kernel buffers. The trade-off is that shared memory provides no built-in synchronization, so the processes need an explicit mechanism — a semaphore, mutex, or a ring-buffer protocol — to coordinate reads and writes and avoid tearing or races. I'd pair it with a lightweight signal or a small message queue purely to notify "new frame ready", keeping the bulk data path on shared memory and the coordination path on a cheap notification mechanism.
