---
title: Tasks, Cancellation and Pitfalls
description: How cancellation tokens, WhenAll versus WaitAll, fire-and-forget, and the classic deadlock actually work in real async C# code
difficulty: Core
tags: [async-await, task, cancellation, csharp]
---

Writing one correct `await` is easy. Writing a whole async pipeline that cancels cleanly, reports errors correctly, and never deadlocks is where interviewers separate people who use async from people who understand it. This page covers the operational side: cancellation, composition, and the mistakes that show up in production incidents.

## CancellationToken and cooperative cancellation

Cancellation in .NET is **cooperative** — nothing forcibly kills a running operation. A `CancellationTokenSource` owns a `CancellationToken`; calling `Cancel()` flips a flag that any code holding the token can observe and react to, by throwing `OperationCanceledException` (usually via `token.ThrowIfCancellationRequested()`) or by checking `token.IsCancellationRequested` in a loop.

```csharp
public async Task ProcessItemsAsync(IEnumerable<Item> items, CancellationToken token)
{
    foreach (var item in items)
    {
        token.ThrowIfCancellationRequested(); // cooperative check
        await ProcessAsync(item, token);       // most async APIs accept a token too
    }
}
```

> [!KEY]
> Cancellation is a request, not a command. If your code never checks the token — inside a tight CPU loop, or by ignoring the token parameter on an API call — cancellation silently does nothing.

### Linked tokens and timeouts

`CancellationTokenSource.CreateLinkedTokenSource` combines multiple sources so that cancelling *any* of them cancels the linked token — useful for "cancel if the caller cancels **or** a timeout elapses":

```csharp
using var timeoutCts = new CancellationTokenSource(TimeSpan.FromSeconds(5));
using var linkedCts = CancellationTokenSource.CreateLinkedTokenSource(
    callerToken, timeoutCts.Token);

await CallDownstreamAsync(linkedCts.Token);
// linkedCts.Token is cancelled if the caller cancels OR 5 seconds pass
```

`Task.Delay(timeout, token)` and `CancellationTokenSource(timeout)` are the two idiomatic ways to express a timeout; a `try/catch (OperationCanceledException)` around the awaited call distinguishes "caller cancelled" from "we gave up" if you check which token was the one actually signalled.

## WhenAll vs WhenAny vs WaitAll

| API | Returns | Blocks caller thread? | Exception behaviour |
|---|---|---|---|
| `Task.WhenAll(tasks)` | A `Task` that completes when **all** finish | No — awaitable | Throws the **first** exception on await; all exceptions available via `Task.Exception` (`AggregateException`) |
| `Task.WhenAny(tasks)` | A `Task<Task>` that completes when **one** finishes | No — awaitable | The winning task's exception only; others are unobserved unless you also await them |
| `Task.WaitAll(tasks)` | `void` | **Yes**, blocks | Throws `AggregateException` with all failures |
| `Task.WaitAny(tasks)` | `int` (index) | **Yes**, blocks | Throws only if the *first completed* task faulted |

```csharp
var results = await Task.WhenAll(FetchAsync(1), FetchAsync(2), FetchAsync(3));

// Only the first exception is thrown here — inspect .Exception for all of them
try { await Task.WhenAll(tasks); }
catch (Exception)
{
    var allErrors = tasks.Where(t => t.IsFaulted)
                          .SelectMany(t => t.Exception!.InnerExceptions);
}
```

> [!WARNING]
> `await Task.WhenAll(...)` only rethrows the **first** faulted task's exception, even if three tasks failed for different reasons. Always inspect each task's `.Exception` if you need to log or handle all of them — this is a common "why did I lose an error" production bug.

## Fire-and-forget, done properly

"Fire-and-forget" means starting an async operation without awaiting it inline. Done carelessly, exceptions vanish and the operation's lifetime is untracked. Done properly, you still observe failures and give the operation a chance to be tracked or cancelled:

```csharp
public void QueueBackgroundWork(Item item, CancellationToken appShutdown)
{
    _ = Task.Run(async () =>
    {
        try
        {
            await ProcessAsync(item, appShutdown);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Background processing failed for {Id}", item.Id);
        }
    }, appShutdown);
}
```

> [!TIP]
> In ASP.NET Core, never fire-and-forget work tied to a request's lifetime — the request can complete and dispose scoped services while your task is still running. Use `IHostedService`/`BackgroundService`, or a proper queue, so background work has its own lifetime independent of any single request.

## Task.Run when it is (and is not) appropriate

`Task.Run` schedules work onto the thread pool. It is the right tool for **CPU-bound** work you want to move off a thread that must stay responsive (a UI thread, or to parallelize independent CPU work). It is the wrong tool for **I/O-bound** work — wrapping an already-async I/O call in `Task.Run` just burns a thread pool thread to babysit something that didn't need a thread at all.

| Situation | Use `Task.Run`? |
|---|---|
| CPU-bound calculation called from a UI event handler | Yes — keeps the UI thread free |
| Calling an `async` I/O method (`HttpClient`, EF Core, file I/O) | No — just `await` it directly |
| ASP.NET Core controller action doing CPU-bound work | Rarely — usually better to scale out; can still starve the pool under load |
| Parallelizing several independent CPU-bound computations | Yes, or `Parallel.For`/PLINQ |

## The .Result / .Wait() deadlock, precisely

This is the single most-asked async debugging question. It requires a `SynchronizationContext` that only allows one thread to run at a time (classic ASP.NET's request context, or a UI dispatcher).

```mermaid
sequenceDiagram
    participant UI as "UI Thread"
    participant Task as "Async Task"
    participant Ctx as "SynchronizationContext"

    UI->>Task: Call DoWorkAsync().Result
    Note over UI: UI thread blocks here, waiting
    Task->>Ctx: await completes, wants to resume on captured context
    Ctx-->>Task: Queue continuation, waiting for UI thread
    Note over Task,UI: UI thread is blocked (step 1)<br/>and is the only thread allowed<br/>to run the continuation
    Note over UI,Task: Deadlock — neither can proceed
```

The blocked thread is waiting for the async method to finish; the async method's continuation is waiting for that same thread to become free to run on the context it captured. Neither side yields. `ConfigureAwait(false)` breaks this by letting the continuation run on any thread-pool thread instead of demanding the original context — but the real fix is "await all the way up", not `.Result` anywhere in the chain.

> [!DANGER]
> ASP.NET Core mostly avoids this specific deadlock because it has no request `SynchronizationContext` by default — but blocking on `.Result`/`.Wait()` there still starves the thread pool under load and should be treated as a bug, not a "safe here" exception.

## TaskCompletionSource

`TaskCompletionSource<T>` lets you create a `Task<T>` you control manually — essential for wrapping callback-based or event-based APIs into an awaitable one.

```csharp
public Task<string> WaitForMessageAsync(CancellationToken token)
{
    var tcs = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
    token.Register(() => tcs.TrySetCanceled(token));
    _connection.OnMessage += msg => tcs.TrySetResult(msg); // completes the task
    return tcs.Task;
}
```

`RunContinuationsAsynchronously` avoids continuations running synchronously on whatever thread calls `SetResult`, which otherwise can cause reentrancy or deadlocks.

## IAsyncEnumerable and Parallel.ForEachAsync

`IAsyncEnumerable<T>` lets you stream items where each one may itself require an asynchronous fetch (e.g. paged API results), consumed with `await foreach`:

```csharp
public async IAsyncEnumerable<Order> GetOrdersAsync(
    [EnumeratorCancellation] CancellationToken token = default)
{
    string cursor = null;
    do
    {
        var page = await FetchPageAsync(cursor, token);
        foreach (var order in page.Items) yield return order;
        cursor = page.NextCursor;
    } while (cursor != null);
}

await foreach (var order in GetOrdersAsync(token))
{
    Process(order);
}
```

`Parallel.ForEachAsync` (since .NET 6) combines async work with bounded concurrency, replacing the old pattern of manually chunking `Task.WhenAll` calls:

```csharp
await Parallel.ForEachAsync(orderIds,
    new ParallelOptions { MaxDegreeOfParallelism = 8, CancellationToken = token },
    async (id, ct) => await ProcessOrderAsync(id, ct));
```

## Cheat sheet

- Cancellation is cooperative — code must check the token or pass it to APIs that do.
- `CreateLinkedTokenSource` combines a caller's token with a timeout token.
- `WhenAll` waits for everything and surfaces only the first exception on await; check `.Exception` for the rest.
- `WaitAll`/`WaitAny`/`.Result`/`.Wait()` block the calling thread — avoid in async code.
- Fire-and-forget must still catch exceptions and have a lifetime independent of the triggering request.
- `Task.Run` is for CPU-bound work; never wrap an already-async I/O call in it.
- The classic deadlock needs a `SynchronizationContext` that allows only one thread at a time plus a blocking wait.
- `TaskCompletionSource` bridges callback-based APIs into awaitable `Task<T>`.
- `IAsyncEnumerable` + `await foreach` streams async-fetched sequences; `Parallel.ForEachAsync` bounds concurrent async work.

## Common mistakes

| Mistake | Fix |
|---|---|
| Ignoring the `CancellationToken` parameter inside a loop | Call `token.ThrowIfCancellationRequested()` or pass it to inner async calls |
| Assuming `Task.WhenAll` throws all exceptions | Await it in a try/catch, then inspect each task's `.Exception` |
| Blocking with `.Result` inside a UI or classic ASP.NET method | `await` all the way up the call chain |
| Firing off `Task.Run(async () => await X())` and forgetting the try/catch | Always wrap fire-and-forget bodies in try/catch and log failures |
| Wrapping `HttpClient` calls in `Task.Run` "to make them async" | They're already async — just `await` directly |
| Creating unbounded `Task.WhenAll(hugeList.Select(...))` | Use `Parallel.ForEachAsync` or manual batching to bound concurrency |

## Summary

Cancellation in .NET is cooperative, composed through `CancellationTokenSource`/`CancellationToken` and linked tokens for timeouts. Task composition APIs (`WhenAll`, `WhenAny`, `WaitAll`) differ in whether they block and how they surface exceptions, and `AggregateException` handling is a frequent source of "lost" errors. `Task.Run` belongs on CPU-bound work, never on already-async I/O, and blocking calls like `.Result`/`.Wait()` are the direct cause of the classic async deadlock. `TaskCompletionSource`, `IAsyncEnumerable`, and `Parallel.ForEachAsync` round out the toolkit for bridging callbacks, streaming async sequences, and bounding concurrent async work.

## Top Interview Questions

### Q1. How does cancellation work in .NET, and why is it called "cooperative"?

A `CancellationTokenSource` produces a `CancellationToken` that is passed down through async call chains. Calling `Cancel()` on the source simply flips an internal flag and fires any registered callbacks — it does not forcibly stop any running code. Cancellation only takes effect where code explicitly checks `IsCancellationRequested` or calls `ThrowIfCancellationRequested()`, or where it hands the token to an API (like `HttpClient` or `Task.Delay`) that checks it internally. It's called cooperative because every layer of the call chain must actively participate; a tight CPU-bound loop that never checks the token will run to completion regardless of cancellation.

### Q2. What's the difference between Task.WhenAll and Task.WaitAll?

Both wait for a set of tasks to finish, but `WhenAll` returns a `Task` you `await` — the calling thread is never blocked, and it composes naturally inside other async methods. `WaitAll` is synchronous and **blocks the calling thread** until every task completes, which is dangerous in a context with a `SynchronizationContext` and wasteful of a pool thread otherwise. Exception-wise, `await Task.WhenAll(...)` throws only the first exception encountered (though all are available via each task's `.Exception`), while `WaitAll` throws an `AggregateException` containing every failure immediately. In async code, always prefer `WhenAll`.

### Q3. Why does `await Task.WhenAll(tasks)` only throw one exception even if three tasks failed?

`WhenAll` returns a single `Task` whose exception is set from the *first* faulted task it observes for propagation purposes, to keep the `await` semantics simple and consistent with a normal `await`'s single-exception-per-throw model. All failures are still recorded — each individual `Task` in the array keeps its own `Exception` — so if you need every error, you should iterate the original tasks after the `await` throws (in a catch block) or check `IsFaulted`/`.Exception` on each before or instead of relying on the aggregate rethrow. This is a well-known "silent data loss" trap in production logging.

### Q4. Explain precisely why blocking on `.Result` can deadlock a UI or classic ASP.NET application.

It requires a `SynchronizationContext` that marshals continuations back onto a single thread (the UI thread, or the original ASP.NET request thread). When you call `.Result` on that thread, it blocks and waits for the task to finish. Internally, the awaited operation eventually completes and tries to resume its continuation on the captured context — but the only thread allowed to run that context is the one currently blocked on `.Result`. Neither side can proceed: the blocked thread waits for the task, and the task's continuation waits for the blocked thread. `ConfigureAwait(false)` prevents this by letting the continuation run on any thread-pool thread instead of demanding the original context, but the robust fix is to never block on async code — await all the way up.

### Q5. When is `Task.Run` the right tool, and when is it misused?

`Task.Run` is right for moving **CPU-bound** work off a thread that needs to stay responsive — a UI thread, or to parallelize independent CPU-heavy computations across the thread pool. It is misused when wrapped around code that is already asynchronous I/O, such as `Task.Run(() => httpClient.GetAsync(url))` — that already-async call doesn't need a dedicated thread to "run" it; wrapping it just consumes a pool thread pointlessly while it waits. In ASP.NET Core specifically, using `Task.Run` inside a request handler to "parallelize" work is often counterproductive too, since it consumes the same thread pool that serves incoming requests, and can make thread-pool starvation worse under load rather than better.

### Q6. What is fire-and-forget, and how do you do it safely?

Fire-and-forget means starting an async operation without the caller awaiting it — the caller continues immediately while the operation runs independently. Done unsafely, exceptions thrown inside are never observed (they may crash the process via the `TaskScheduler.UnobservedTaskException` path, or simply vanish), and the operation's lifetime is tied to nothing, so it can be cut short if the process or request scope ends. Done safely: wrap the body in a try/catch that logs failures, use `Task.Run` with an independent `CancellationToken` (not tied to a request that might end), and in ASP.NET Core prefer a proper background mechanism like `IHostedService`/`BackgroundService` or a message queue so the work has its own supervised lifetime.

### Q7. What is `TaskCompletionSource<T>` used for?

It lets you manually create and control a `Task<T>` that isn't backed by running code — useful for adapting event-based or callback-based APIs into something awaitable. You create the `TaskCompletionSource`, return its `.Task` to the caller, and call `SetResult`/`SetException`/`SetCanceled` (or the `Try*` variants) from wherever the underlying event fires. It's the building block behind many `async` wrappers over legacy APIs, socket libraries, and hand-rolled timeout/cancellation logic. A subtle but important detail: pass `TaskCreationOptions.RunContinuationsAsynchronously` so that continuations don't run synchronously on the thread that calls `SetResult`, which can otherwise cause unexpected reentrancy or deadlocks.

### Q8. How would you fetch and process 10,000 records via a paged API without exhausting memory or connections?

Use `IAsyncEnumerable<T>` to stream pages lazily via `await foreach`, so records are processed as they arrive rather than all being buffered in memory at once. For any per-record async work (e.g. writing each to a database), use `Parallel.ForEachAsync` with a bounded `MaxDegreeOfParallelism` instead of firing thousands of tasks via `Task.WhenAll`, which would open far too many concurrent connections. Pass a shared `CancellationToken` through both the enumeration and the per-item work so a timeout or shutdown signal stops the whole pipeline cleanly, and wrap per-item processing in a try/catch so one bad record doesn't abort the entire stream unless that's the desired behaviour.

### Q9. A background job occasionally hangs forever with no error logged. What would you investigate?

First check whether it's blocked on `.Result`/`.Wait()`/`.GetAwaiter().GetResult()` somewhere with no timeout — if the awaited task never completes (e.g. a network call to a dead endpoint with no timeout configured), the thread waits indefinitely and nothing times out or logs. Second, check whether a `CancellationToken` is actually threaded through every downstream call, or if it's created but never passed to the HTTP client, database call, etc. Third, check whether the job's own exception handling swallows failures without rethrowing or logging (an empty `catch { }` block). The fix is usually: apply a timeout via a linked `CancellationTokenSource`, ensure every async call receives the token, and always log or rethrow inside catch blocks in background code, since there's no request pipeline to surface an unhandled exception.

### Q10. What's the difference between `Task.WhenAny` and `Task.WaitAny`, and where would you use `WhenAny`?

`Task.WhenAny` is the awaitable, non-blocking version — it returns a `Task<Task>` that completes as soon as any one of the input tasks finishes, without blocking the calling thread. `Task.WaitAny` is synchronous and blocks until one completes, returning the array index. `WhenAny` is commonly used to implement a manual timeout pattern: `await Task.WhenAny(actualCall, Task.Delay(timeout))`, then checking which task won to decide whether to treat it as a timeout — though in modern code a `CancellationTokenSource` with a timeout is usually cleaner. It's also useful for "take whichever of several redundant calls responds first" patterns, such as querying multiple mirrored endpoints and using the fastest response.
