---
title: Percentiles and Saturation
description: Why averages hide latency problems, how tail latency amplifies across fan-out, and how to read saturation metrics to find the actual bottleneck resource
difficulty: Core
tags: [observability, latency, percentiles, capacity, performance]
---

"The average response time is 80ms" can be true while 1 in 50 users waits 4 seconds. Percentiles and saturation metrics are how you see past the average to the resource that is actually running out of headroom — and this is usually the fastest path to a root cause once metrics have told you *something* is wrong.

## Why averages hide problems

Consider 100 requests: 95 take 50ms and 5 take 2,000ms (a slow downstream dependency timing out for a subset of traffic).

| Statistic | Value |
|---|---|
| Average | 147.5ms |
| p50 (median) | 50ms |
| p95 | 50ms |
| p99 | ~2,000ms |

The average (147.5ms) doesn't represent *any* real user's experience — it's pulled upward by a handful of outliers while looking only moderately bad, masking that 5% of users are having a genuinely broken experience. The median (p50) looks great and completely hides the problem. Only the upper percentiles reveal it.

> [!KEY]
> An average is a single number computed over a skewed distribution — it represents nobody. Always look at percentiles, and always look at more than one (p50 and p99 together tell you both "typical" and "worst common" experience).

## p50 / p90 / p95 / p99 / p99.9 — who experiences each

| Percentile | Meaning | Who feels it | Typical use |
|---|---|---|---|
| p50 (median) | Half of requests are faster than this | The "typical" user | Baseline, day-to-day health |
| p90 | 9 in 10 requests are faster | A meaningfully worse-than-typical user | Secondary SLO target |
| p95 | 19 in 20 requests are faster | A commonly cited SLO threshold | Standard SLO target for many APIs |
| p99 | 99 in 100 requests are faster | 1% of your traffic — at scale, thousands of users/day | Tail-latency SLO, often paired with p50 |
| p99.9 | 999 in 1,000 requests are faster | The genuinely worst-served slice | High-scale/critical-path services only |

> [!TIP]
> At 1 million requests/day, p99.9 still represents 1,000 bad requests every single day. "It's only the 99.9th percentile" sounds negligible until you multiply by your actual traffic — always translate a percentile back into an absolute daily/hourly count in an interview answer.

## Tail latency amplification across fan-out

If a single request fans out to call N downstream services in parallel and waits for all of them, the *overall* request's latency is the **maximum** of the N calls, not their average. This means the probability of hitting at least one slow (p99) call rises sharply as fan-out width increases.

If each individual call has a 1% chance of being slow (p99), the probability that **none** of N parallel calls are slow is `(0.99)^N`:

| Fan-out width (N) | P(at least one call is slow) |
|---|---|
| 1 | 1% |
| 10 | ~9.6% |
| 50 | ~39.5% |
| 100 | ~63.4% |

With 100-way fan-out, a call that is individually "only" slow 1% of the time makes the *overall* request slow nearly two-thirds of the time. This is why wide fan-out architectures (search aggregators, dashboards querying many services) see much worse tail latency than any single dependency's own numbers would suggest — it is one of the most senior-sounding points you can make about latency in a microservices interview.

## Why you cannot average percentiles across instances

A p99 computed on one instance and a p99 computed on another **cannot be averaged** to get a fleet-wide p99 — percentiles are not linear, so `avg(p99_a, p99_b) ≠ p99(a ∪ b)`. If instance A's p99 is 100ms and instance B's is 900ms (because B got a burst of slow requests), the true combined p99 depends on the actual shape of both distributions, not their average, and is very unlikely to be 500ms.

The fix is to aggregate the **raw histogram buckets** first, across all instances, and *then* compute the quantile once over the combined data — this is exactly what `histogram_quantile()` in PromQL is designed to do, and why histograms (not client-side summary quantiles) are the correct metric type for anything you need fleet-wide.

## Histogram buckets and accuracy trade-off

A histogram metric groups observations into pre-defined buckets (e.g., `<=10ms`, `<=50ms`, `<=100ms`, `<=500ms`, `<=1s`, `+Inf`) and counts how many observations fall in each. The quantile is then *interpolated* between bucket boundaries, so accuracy is limited by how many buckets you define near the range you actually care about.

| Bucket design | Effect |
|---|---|
| Too few buckets, widely spaced | Cheap to store, but quantile interpolation is coarse — p99 could be reported as anywhere within a wide bucket |
| Many buckets concentrated near your SLO threshold | Precise around the number you actually alert on |
| Buckets chosen without checking real traffic | Common mistake — e.g., all buckets under 100ms when your real p99 is 2 seconds, so everything above lands in one useless `+Inf` bucket |

> [!DANGER]
> If your histogram's highest finite bucket boundary is 500ms and your actual p99.9 is 3 seconds, every slow request just gets lumped into the `+Inf` bucket — you'll see *that* something crossed 500ms, but you'll have no idea if it's 501ms or 8 seconds. Bucket boundaries should be chosen deliberately around your SLO thresholds, then revisited as real traffic data comes in.

## Coordinated omission in load tests

A subtle but classic load-testing bug: if a load generator sends requests at a fixed rate and *waits for each response before sending the next* (closed-loop), then during a slowdown it sends fewer requests — meaning the requests that *would* have been sent (and would have queued and been slow) are never sent or measured at all. The result is a load test that reports suspiciously good latency numbers precisely during the period the system was struggling most.

The fix is an **open-loop load generator** that keeps sending requests at the target rate regardless of how long previous ones take, so queued/delayed requests are actually measured. If your load-testing tool reports a beautiful flat p99 even while your dashboard shows the server was clearly struggling, suspect coordinated omission before you trust the load test.

## Saturation metrics and the utilisation-latency curve

Saturation is how much queued/unserved demand exists for a resource beyond what it can currently handle. As utilisation of a resource climbs, queueing delay does not increase linearly — it grows sharply as you approach 100%.

```mermaid
flowchart LR
    A["Utilisation 0-60%<br/>latency flat, low"] --> B["Utilisation 60-85%<br/>latency creeping up"]
    B --> C["Utilisation 85-95%<br/>latency rising sharply"]
    C --> D["Utilisation 95-100%<br/>queueing dominates,<br/>latency explodes"]
```

This is a direct consequence of queueing theory (an M/M/1-style queue's expected wait time scales with `ρ / (1 − ρ)` where ρ is utilisation) — the curve is nearly flat until roughly 70–80% utilisation, then bends sharply upward. This is why "CPU at 90%" is a genuinely different risk level than "CPU at 60%", even though both sound like "not maxed out."

| Resource | Saturation signal | What it queues |
|---|---|---|
| CPU | Run queue length, scheduling delay | Threads waiting for a core |
| Memory | Page faults, GC pause frequency/duration | Allocations waiting on collection |
| Disk I/O | I/O wait time, queue depth | Reads/writes waiting on the device |
| Connection pool | Wait-for-connection time, pool exhaustion count | Requests waiting for a free connection |
| Thread pool | Queue length, queued task age | Work items waiting for a free thread |
| Message queue | Consumer lag, queue depth | Messages waiting to be processed |

## Identifying the saturated resource

A symptom-to-cause table is often the fastest way to reason through this live in an interview or an actual incident:

| Saturation signal | Likely cause |
|---|---|
| High CPU run queue, low actual CPU% | Too few cores relative to concurrent work, or lock contention serialising work |
| Rising GC pause time/frequency | Allocation rate too high, objects living too long, heap sized too small |
| Connection pool wait time climbing | Pool size too small, or a downstream dependency slowing down and holding connections longer |
| Thread pool queue growing | Not enough worker threads, or handlers blocking synchronously on I/O |
| Disk I/O wait climbing, CPU idle | Underlying storage (or noisy neighbour on shared storage) is the bottleneck, not compute |
| Queue consumer lag growing | Consumers too slow or too few relative to producer rate |

> [!TIP]
> The senior move here is naming the **specific queued resource**, not just saying "it's under load." "CPU is fine but the DB connection pool wait time went from 2ms to 400ms — we're pool-bound, not CPU-bound" is a concrete, checkable claim; "the server seems overloaded" is not.

## Cheat sheet

- Averages hide skewed distributions — always report percentiles, and report more than one (p50 + p99 at minimum).
- p99 at scale still means real, absolute daily bad-request counts — translate the percentage to a number.
- Parallel fan-out amplifies tail latency: overall latency ≈ max of N calls, so P(at least one slow) grows fast with N.
- Never average percentiles across instances — aggregate histogram buckets first, then compute the quantile once.
- Histogram bucket boundaries fix your quantile accuracy — place them densely around your actual SLO threshold.
- Coordinated omission in closed-loop load tests hides exactly the slowdown you're trying to measure — use open-loop generators.
- Utilisation-latency is nonlinear — queueing delay explodes above roughly 80% utilisation, not at 100%.
- Saturation metrics (queue depth, wait time, pool exhaustion) identify *which* resource is the actual bottleneck.

## Common mistakes

| Mistake | Fix |
|---|---|
| Reporting only average latency | Report p50 and at least one tail percentile (p95/p99) |
| Averaging p99 values across instances/pods | Aggregate raw histogram buckets, then compute the quantile once |
| Histogram buckets that don't cover the real tail | Set bucket boundaries based on actual observed traffic and your SLO |
| Assuming closed-loop load test results during a slowdown | Use an open-loop generator to avoid coordinated omission |
| Treating CPU% alone as "is the system saturated" | Check queueing/wait-time signals per resource, not just utilisation % |
| Ignoring fan-out amplification when estimating latency | Model overall latency as the max across parallel calls, not the average |

## Summary

Averages flatten skewed latency distributions into a number that represents nobody's actual experience, which is why percentiles — especially the tail, p95/p99/p99.9 — are the correct way to reason about and set targets for latency. Fan-out amplifies tail latency because overall request time is bounded by the slowest of many parallel calls, and percentiles must never be averaged across instances because they are not linear; aggregate histograms first. Saturation metrics identify which specific resource is actually the bottleneck by measuring queued, unserved demand, and the utilisation-latency curve explains why a resource at 90% is a fundamentally different risk than one at 60%, not just "a bit more."

## Top Interview Questions

### Q1. Why is average latency a poor metric, and what would you use instead?

Average latency is pulled by outliers and computed over a distribution that's usually heavily right-skewed (most requests fast, a small tail very slow), so it doesn't represent any real user's actual experience — a system can show a perfectly reasonable 150ms average while 5% of users wait 2+ seconds. The fix is to report percentiles instead, typically both a low one (p50, the typical experience) and a high one (p95 or p99, the tail experience), since together they show both "what's normal" and "how bad does it get for the unlucky slice" — a gap between them that a single average number can never expose.

### Q2. Why can't you average p99 latency values computed on different instances to get a fleet-wide p99?

Percentiles are not a linear statistic, so combining them by averaging is mathematically invalid — if instance A has a p99 of 100ms and instance B has a p99 of 900ms because it took a burst of slow requests, the true combined p99 across both instances' actual traffic depends on the full shape of both underlying distributions, and there's no guarantee it's anywhere near 500ms. The correct approach is to aggregate the raw histogram bucket counts from every instance first, and only then compute the quantile once over the combined buckets — this is exactly what a function like PromQL's `histogram_quantile()` does, which is why histograms, not client-side pre-computed summary quantiles, are the right metric type whenever you need a fleet-wide view.

### Q3. Explain tail latency amplification in a fan-out architecture with an example.

When a request fans out to call N downstream services in parallel and waits for all of them to respond, the overall latency is bounded by the **slowest** of the N calls, not their average — so the probability that the *overall* request is slow rises quickly as fan-out width increases, even if each individual dependency is well-behaved. Concretely, if each call independently has a 1% chance of being a "slow" (p99) call, the chance that at least one of 100 parallel calls is slow is `1 − 0.99^100 ≈ 63%` — meaning nearly two-thirds of requests through that fan-out will experience tail latency from at least one call, even though each individual dependency's own p99 metric looks perfectly acceptable. This is why search aggregators, dashboards, and other wide-fan-out services need much tighter per-call latency budgets than a simple single-hop service.

### Q4. What determines the accuracy of a percentile computed from a histogram metric?

The bucket boundaries you defined when instrumenting the metric — a histogram counts how many observations fall into each pre-defined bucket, and the quantile is interpolated between the boundaries of the bucket containing that percentile, so accuracy is limited to the granularity of buckets near the value you care about. If your buckets are `<=100ms, <=500ms, +Inf` and your real p99 is 2 seconds, every slow request lands in the `+Inf` bucket and you lose all ability to distinguish a 501ms request from an 8-second one. The fix is to define buckets densely around your actual SLO thresholds and known traffic distribution, and to revisit them once you have real production data rather than guessing upfront.

### Q5. What is coordinated omission in load testing, and how would you detect it?

It's a measurement bug in closed-loop load generators: if the generator waits for each response before issuing the next request at a fixed concurrency, then during a real slowdown it automatically sends *fewer* requests, meaning the requests that would have queued and suffered are simply never sent and never measured — so the reported latency numbers look artificially good exactly during the period the system was actually struggling. You'd detect it by cross-checking the load test's reported latency against server-side metrics (request rate, queue depth, actual server-side latency) for the same time window — if the server dashboard shows clear stress but the load tool reports a suspiciously flat p99, that mismatch is the signature of coordinated omission. The fix is switching to an open-loop load generator that keeps issuing requests at the target rate regardless of response time, so genuinely slow/queued periods are captured.

### Q6. Why does latency rise sharply as utilisation approaches 100% rather than increasing linearly?

This follows from queueing theory: for a simple queueing model, expected wait time scales roughly with `ρ / (1 − ρ)` where ρ is utilisation, a function that stays small and nearly flat until roughly 70-80% utilisation and then rises sharply and non-linearly as ρ approaches 1. Intuitively, at low utilisation there's almost always a free server/thread/connection ready immediately, but as utilisation climbs, the probability that an arriving request finds everything busy — and therefore has to queue behind other requests — rises fast, and each queued request adds to everyone behind it. This is why "CPU at 90%" is a materially different risk from "CPU at 60%" even though both sound like "under 100%" — the practical implication is you should alert and act well before a resource nears full utilisation, not at 100%.

### Q7. A service's CPU is at 40% but p99 latency has spiked. What resources would you check next, and why?

Since CPU clearly isn't the bottleneck, I'd look at other saturation signals in roughly this order: connection pool wait time (a downstream dependency slowing down can cause requests to hold connections longer, exhausting the pool even with low CPU use), thread pool queue depth (synchronous blocking I/O inside handlers can starve the thread pool without raising CPU), GC pause frequency and duration (a memory pressure issue can pause execution without showing as sustained high CPU utilisation), and disk I/O wait time (a storage bottleneck, especially on shared/network storage, shows as idle CPU while requests wait on I/O). The general principle is that CPU is only one of several resources that can be saturated, and low CPU utilisation specifically rules out CPU as the bottleneck, pointing you toward pool, thread, memory, or I/O saturation instead.

### Q8. Why might a system report a healthy average latency and a healthy p50 while still having angry users?

Because a meaningful fraction of the actual complaints can come from the tail that neither the average nor the median reflects — if 2% of requests take 5 seconds while 98% take 50ms, both the average (only mildly elevated) and the p50 (looking perfect) can hide this completely, while that 2% at real production traffic volumes represents thousands of genuinely bad experiences per day, concentrated perhaps among a specific customer segment, region, or request type. The fix is always to look at p95/p99/p99.9 alongside p50, and to slice those percentiles by dimension (region, customer tier, endpoint) rather than looking only at a single fleet-wide aggregate, since a bad tail is often concentrated in one slice rather than spread evenly.

### Q9. How would you decide which percentile to use as your SLO target for a given service?

I'd base it on how forgiving the user journey is and what "unacceptable" concretely means for it — a low-stakes, best-effort background sync might reasonably use p90 or even just an average, while a checkout or search request on the critical path, where a slow response directly costs revenue or trust, warrants a p99 or even p99.9 target because that's the experience of real, meaningful daily traffic at scale. I'd also sanity check the target against historical data rather than picking an arbitrary percentile — if the natural p99 has always hovered around 1.2 seconds, setting a target of 500ms isn't a percentile choice problem, it's an achievability problem that needs actual engineering work, not just a tighter SLO number.

### Q10. What saturation metrics would you look at for a connection pool specifically, and what do they tell you?

I'd look at wait-time-for-a-connection (how long a request waits before getting a connection from the pool — the direct saturation signal), pool utilisation (in-use connections over total pool size), and the rate of pool exhaustion events or timeouts (requests that gave up waiting entirely). Rising wait time with high utilisation but a stable request rate usually means the pool is simply undersized for current concurrency; rising wait time with a *falling or stable* pool utilisation percentage but requests holding connections longer is a signature of a slow downstream dependency causing connections to be held longer per request rather than the pool itself being too small — an important distinction because the fix is completely different (resize the pool vs. fix the downstream call).

### Q11. Explain the difference between latency and saturation as two of the "four golden signals."

Latency measures how long requests actually take — it's an outcome, measured directly from the request path, usually as a distribution/percentile. Saturation measures how "full" a resource is — how much queued, unserved demand exists relative to its capacity — and it's typically a leading indicator: saturation on a resource often rises before it fully translates into visible latency, especially once you cross the steep part of the utilisation-latency curve. In practice you use latency to detect that something is wrong for users right now, and saturation metrics (per resource: CPU run queue, GC pauses, pool wait time, thread pool queue depth) to localise *which specific resource* is causing it — they answer different questions and you generally need saturation data to explain a latency spike, not just latency data alone.

### Q12. If asked to design an alert for tail latency, would you alert on p99 directly or something else? Why?

I'd generally alert on the **percentage of requests exceeding a fixed threshold** derived from the SLO (e.g., "more than X% of requests over 1 second in a 5-minute window") rather than alerting directly on a raw p99 number, because a raw percentile value can be noisy at lower traffic volumes and doesn't naturally tie back to an error-budget-style burn-rate calculation. Framing it as "percentage of requests violating the latency SLO" lets you reuse the same multi-window multi-burn-rate alerting pattern used for availability SLOs, which filters short blips while still catching sustained degradations — and it's a more directly actionable framing than "p99 crossed 1.4 seconds," which doesn't by itself say how much of your traffic or budget is actually affected.
