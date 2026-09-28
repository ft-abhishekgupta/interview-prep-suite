---
title: Capacity Planning
description: How to measure headroom, find the knee of the load curve, forecast growth, and size a service for peak traffic and partial failure without overspending
difficulty: Core
tags: [observability, capacity-planning, scalability, performance, load-testing]
---

Capacity planning answers a deceptively simple question — "how much load can this handle before it falls over, and do we have enough headroom for tomorrow's peak" — with real numbers instead of a guess. It combines load testing, queueing behaviour, and cost trade-offs, and it is the piece that turns "latency spiked" into "we were at 92% of capacity and a deploy pushed us over."

## Measuring current headroom

Headroom is the gap between current peak usage and the point where the system degrades. You cannot plan capacity without first measuring it honestly against real production peak, not an average day.

| Signal | What it tells you |
|---|---|
| Peak CPU/memory utilisation over the last 30 days | How close you already run to the edge on your worst day |
| Peak requests per second vs. known safe capacity | Direct comparison to your last load test result |
| Saturation metrics at peak (queue depth, pool wait time) | Whether you're already queueing during normal peak, not just in an incident |
| Time since last load test | Stale load tests don't reflect current code, traffic mix, or dependency behaviour |

> [!KEY]
> Headroom should be measured against your **worst recent peak**, not your average load. A service running comfortably at 30% average CPU can still be dangerously close to its limit if its peak (Black Friday, a marketing push, a batch job overlapping with traffic) already touches 85%.

## Load testing to find the knee of the curve

The "knee" is the point on the load-vs-latency curve where latency stops being flat and starts rising sharply — this is your real usable capacity, not the point where the service finally falls over completely.

```mermaid
flowchart LR
    A["Low load<br/>flat latency"] --> B["Knee<br/>latency starts climbing"]
    B --> C["Overload<br/>latency explodes,<br/>errors begin"]
```

Run a load test that steps load upward (not a single fixed-rate run) and plot latency and error rate against load. The knee — not the collapse point — is where you should set your capacity target, with margin below it.

> [!TIP]
> A senior answer to "how do you size a service" names the knee explicitly: *"We load-tested and found latency starts degrading past 4,000 RPS per instance; we plan for a working ceiling of 3,000 RPS to leave margin, not the 4,500 RPS point where it actually falls over."*

## Single-instance capacity and horizontal scaling maths

Once you know one instance's safe throughput, scaling out is arithmetic — with an important caveat about shared, non-horizontally-scaled resources.

```text
instances needed = ceil(target peak RPS / safe RPS per instance) + spare capacity for N+1
```

**Worked example:** target peak = 12,000 RPS, one instance handles 2,500 RPS safely (at the knee, with margin).

| Step | Calculation | Result |
|---|---|---|
| Base instances needed | 12,000 / 2,500 | 4.8 → 5 |
| N+1 for one instance failure | 5 + 1 | 6 |
| Round up for deploy headroom (rolling deploys take one out at a time) | 6 + 1 | 7 |

> [!WARNING]
> Horizontal scaling maths assumes the bottleneck actually scales horizontally. If every instance shares one database connection pool, one downstream rate limit, or one message broker partition, adding instances beyond that shared limit does nothing — you will hit the shared constraint long before compute runs out. Always check whether the *actual* bottleneck (found via saturation metrics) scales with instance count before using this formula.

## Peak-to-average ratio and seasonal spikes

Provisioning for average load guarantees failure at peak. The peak-to-average ratio tells you how much above typical traffic you must plan for.

| Traffic pattern | Typical peak-to-average ratio | Planning implication |
|---|---|---|
| Steady B2B API, business hours only | 2–3x | Modest headroom, autoscale comfortably covers it |
| Consumer app with daily commute peaks | 3–5x | Clear daily pattern, predictable autoscaling schedule |
| E-commerce with sales events (Black Friday) | 10–20x+ | Pre-provision ahead of the event; autoscaling reaction time is too slow to rely on alone |
| Ticket/flash-sale drop | 50–100x+ in seconds | Requires queueing/load-shedding design, not just more instances |

## Growth forecasting

Capacity planning is not just "handle today's peak" — it's "handle the peak we'll have in 6–12 months." Combine historical growth rate, known upcoming product launches/marketing events, and seasonality, then add a safety margin (commonly 20–30%) for forecast error. Re-forecast on a regular cadence (quarterly is typical) rather than once a year, since a stale forecast is often worse than a rough but current one.

## Constraints that bite before CPU does

The most common capacity-planning mistake is watching only CPU/memory and missing the constraint that actually breaks first.

| Constraint | Why it bites early | Fix |
|---|---|---|
| Database connection pool | Fixed size, shared across all instances; doesn't scale by adding app instances | Increase pool size (bounded by DB capacity), use pooling proxies (PgBouncer), reduce connection hold time |
| Downstream rate limit | A third-party API caps requests/sec regardless of your own scale | Negotiate a higher limit, cache, batch requests, add a circuit breaker/queue |
| Message broker partition count | Consumer parallelism is capped by partition count, not consumer count | Increase partitions ahead of expected load (repartitioning later is disruptive) |
| DNS/connection setup overhead at high fan-out | New connection cost dominates at very high request rates | Connection pooling/keep-alive, reduce cold connection churn |
| License-limited components | Some software is licensed per-core or per-node | Factor license cost/limits into the scaling plan explicitly |

> [!DANGER]
> Teams that autoscale application instances but never revisit the database connection pool size are the classic failure: CPU graphs look fine, instance count climbs, and the system still falls over — because every new instance just adds more contention for the same fixed pool.

## Cost per request and efficiency

Capacity planning is also a cost conversation. Track cost per request (or per 1,000 requests) alongside raw capacity, and watch its trend as you scale — a service that gets *more* expensive per request as it grows usually has an inefficiency (over-provisioned baseline, an O(n²) hot path, excessive redundant calls) worth fixing before just adding more instances.

## Over-provisioning vs autoscaling lag

| Approach | Pros | Cons |
|---|---|---|
| Static over-provisioning | Instantly absorbs spikes, simple to reason about | Pays for idle capacity most of the time |
| Reactive autoscaling (metric-triggered) | Cost-efficient at steady state | Lags behind sudden spikes — new instances take time to start, warm caches, join load balancer pool |
| Scheduled/predictive scaling | Pre-scales ahead of known patterns (daily peak, planned event) | Requires accurate forecasting; doesn't help with truly unexpected spikes |
| Hybrid (baseline + reactive + scheduled for known events) | Balances cost and responsiveness | More operational complexity to tune correctly |

"Autoscaling lag" is a real number, not a hand-wave: if it takes 90 seconds for a new instance to be healthy and receiving traffic, and your spike ramps in 30 seconds, autoscaling alone will not save you — you need either a static buffer sized for that ramp rate, or a queue/load-shedding layer to survive the gap.

## Planning for failover — N+1 and losing a region

Capacity planning must account for **losing capacity**, not just gaining load — a region outage, an AZ failure, or a bad deploy taking instances out of rotation.

- **N+1** — always provision at least one more instance/AZ than the minimum needed for peak, so a single failure doesn't immediately cause overload on the survivors.
- **Losing a whole region** — if you run active-active across two regions and one goes down, the surviving region must absorb 100% of traffic. Sizing each region at only 50% of peak means a regional failure doubles load on the survivor into overload; sizing at closer to 100% (accepting the cost) or having a fast-scaling burst plan is the trade-off to name explicitly.

```mermaid
flowchart TD
    A["Measure current peak + headroom"] --> B["Load test to find the knee"]
    B --> C["Forecast growth<br/>+ seasonal peak-to-average"]
    C --> D["Compute instances needed<br/>+ N+1 + rolling-deploy margin"]
    D --> E{"Check non-horizontal constraints<br/>DB pool, rate limits, partitions"}
    E -->|Constrained| F["Fix the shared bottleneck first"]
    E -->|Clear| G["Provision baseline<br/>+ autoscaling + failover margin"]
```

## Worked capacity calculation

**Target:** 8,000 QPS peak, p99 under 200ms, must survive losing one of three AZs.

| Step | Value |
|---|---|
| Safe throughput per instance (from load test, at the knee) | 1,200 QPS |
| Instances for peak load (8,000 / 1,200) | 6.7 → 7 |
| N+1 for a single instance failure | 8 |
| Spread across 3 AZs, must survive losing 1 AZ (2/3 must absorb full load) | 8 / (2/3) ≈ 12 total, 4 per AZ |
| Rolling deploy headroom (+1 during deploys) | 13 total |

## Load-test types and what each tells you

| Test type | What it does | What it tells you |
|---|---|---|
| Load test | Sustained expected traffic | Does the system handle normal peak comfortably |
| Stress test | Push beyond expected peak until it breaks | Where the knee and the collapse point actually are |
| Soak test | Sustained load over a long duration (hours+) | Memory leaks, connection leaks, slow degradation over time |
| Spike test | Sudden burst far above baseline | Autoscaling reaction time, queueing/shedding behaviour under shock |
| Failover/chaos test | Kill an instance/AZ/dependency during load | Whether N+1 and failover assumptions actually hold under real load |

## Cheat sheet

- Measure headroom against your worst recent peak, not average load.
- The "knee" of the load curve — where latency starts climbing — is your real capacity, not the collapse point.
- Horizontal scaling maths only works if the actual bottleneck scales horizontally — check DB pools, rate limits, and partition counts first.
- Peak-to-average ratio drives whether autoscaling alone is enough or you need pre-provisioning for known events.
- Track cost per request; a rising trend usually signals an inefficiency, not just success.
- Autoscaling has real lag — size a static buffer for spikes that ramp faster than new instances can become healthy.
- N+1 covers a single failure; surviving a whole-region/AZ loss requires sizing closer to real peak, not half of it.
- Run load, stress, soak, spike, and failover tests — each answers a different capacity question.

## Common mistakes

| Mistake | Fix |
|---|---|
| Sizing capacity from average load | Size from worst recent peak plus forecasted growth |
| Treating the collapse point as the capacity limit | Use the knee of the latency curve, with margin below it |
| Only watching CPU/memory | Check DB pools, rate limits, and partition counts — the real first bottleneck |
| Assuming autoscaling reacts instantly | Measure actual scale-up time and size a static buffer for faster spikes |
| Sizing each region at 50% "just in case" | Size for the load a surviving region/AZ must absorb after a real failure |
| Running one load test years ago and trusting it forever | Re-test after significant code, traffic, or dependency changes |

## Summary

Capacity planning starts with honestly measuring headroom against your worst peak, finding the real usable ceiling via load testing (the knee, not the collapse point), and forecasting growth with margin for error. Horizontal scaling math is straightforward once you know per-instance safe throughput, but it only holds if the bottleneck actually scales with instance count — shared database pools, downstream rate limits, and broker partitions routinely break that assumption first. Provisioning must also cover losing capacity, not just gaining load: N+1 for a single failure, and enough headroom to survive losing a whole AZ or region without cascading into overload.

## Top Interview Questions

### Q1. What is the "knee" of the load curve and why do you size capacity there instead of at the failure point?

The knee is the point on a load-vs-latency curve where latency stops being flat and starts climbing steeply — it's the boundary between "operating normally" and "starting to queue and degrade." The actual collapse point, where the service falls over completely, is further out and much less safe to plan against because the transition from the knee to collapse can be fast and because real traffic has variance — sizing right at the edge of collapse means a normal fluctuation in traffic or a slow downstream dependency can push you over. You size at or below the knee, with margin, so normal variance stays in the flat part of the curve and never triggers the sharp climb.

### Q2. Walk through the maths of how many instances you need for a target peak load.

Start from the safe per-instance throughput determined by load testing at the knee — say 2,500 RPS. Divide the target peak (say 12,000 RPS) by that to get the base instance count: 12,000 / 2,500 = 4.8, rounded up to 5. Then add N+1 for resilience to a single instance failure (6), and typically one more for rolling-deploy headroom, since a rolling deploy takes one instance out of rotation at a time (7). The same logic extends across availability zones: if you must survive losing one of three AZs, the remaining two-thirds of your fleet must be able to absorb full peak load, which increases the total instance count further.

### Q3. Why doesn't adding more application instances always increase real capacity?

Because horizontal scaling only helps if the actual bottleneck scales with instance count, and several common constraints don't: a database connection pool is often a fixed size shared across all instances, so more instances just means more contention for the same pool; a downstream third-party API rate limit is capped regardless of how many of your instances are calling it; a message broker's consumer parallelism is capped by its partition count, not by how many consumer processes you run. The fix is to identify the actual saturated resource via saturation metrics before scaling out, and to explicitly check these shared, non-horizontally-scaling constraints — otherwise you get more instances with CPU graphs that look fine while the system is still falling over on the shared constraint.

### Q4. What is peak-to-average ratio and why does it matter for provisioning?

It's the ratio between a service's peak traffic and its typical/average traffic, and it directly determines whether reactive autoscaling alone is sufficient or whether you need pre-provisioning ahead of known events. A steady B2B API might see a peak-to-average ratio of 2-3x, which autoscaling can usually absorb reactively. An e-commerce site during a major sale event might see 10-20x or more, often ramping up faster than new instances can become healthy — in that case you pre-provision ahead of the known event date rather than relying on autoscaling to react in time, because the cost of running out of capacity during a planned, revenue-critical event far outweighs the cost of some idle capacity beforehand.

### Q5. Your service autoscales based on CPU, but during a traffic spike it still falls over before new instances come online. What's happening and how do you fix it?

This is autoscaling lag: there's a real delay between the metric crossing the scale-up threshold and a new instance becoming healthy and actually receiving traffic — instance startup, application warm-up, cache priming, and load balancer health checks all take time, commonly on the order of tens of seconds to a couple of minutes. If the traffic spike ramps up faster than that delay, the existing instances get overloaded before help arrives. The fix is one or a combination of: sizing a static buffer of spare capacity large enough to absorb the ramp rate you actually see, using a leading indicator (queue depth or request rate trend) rather than CPU as the scaling trigger so you react earlier, pre-scaling ahead of known events on a schedule, and adding a queueing or load-shedding layer so the system degrades gracefully instead of falling over while waiting for new capacity.

### Q6. Why is it dangerous to provision each of two active-active regions at 50% of total peak capacity?

Because if one region fails completely, the surviving region must absorb 100% of total traffic, but it only has capacity for 50% — meaning a regional failure doesn't just lose that region's traffic, it actively causes an overload cascade in the *surviving* region right when you can least afford it. The correct sizing accounts for what a surviving region/AZ must handle after a realistic failure, not a naive equal split of total capacity — which usually means each region needs capacity much closer to full peak, or a very fast, reliable burst-scaling mechanism that can react before the surviving region degrades. This is a specific, quantifiable version of the more general N+1 principle applied at the region level.

### Q7. What's the difference between a load test, a stress test, a soak test, and a spike test, and when would you run each?

A load test applies expected/normal peak traffic to confirm the system handles it comfortably — you'd run this before any major launch or after significant architecture changes. A stress test pushes well beyond expected peak until the system actually breaks, specifically to find the knee and the collapse point so you know your real ceiling and margin. A soak test applies sustained load over a long duration (hours to days) to catch slow degradation — memory leaks, connection leaks, gradually growing queue depth — that a short test wouldn't reveal. A spike test applies a sudden burst far above baseline to validate autoscaling reaction time and queueing/load-shedding behaviour under shock, which is the scenario that most directly answers "what happens during a flash sale or a viral traffic event."

### Q8. How would you approach growth forecasting for capacity planning, and how much margin would you build in?

I'd combine three inputs: historical organic growth rate extrapolated forward, known upcoming events (planned launches, marketing campaigns, seasonal patterns specific to the business), and current headroom against the most recent peak. I'd then add a safety margin — commonly in the 20-30% range — on top of the forecasted number to absorb forecast error, since growth forecasts are reliably wrong to some degree and it's cheaper to slightly over-provision than to be caught short during an actual peak. Critically, I'd re-forecast on a regular cadence, quarterly being typical, rather than treating a single annual forecast as durable, since traffic patterns, architecture, and business priorities all shift faster than an annual cycle captures.

### Q9. What is coordinated omission's relevance to capacity planning specifically, separate from general load testing?

If a load test tool is closed-loop (waits for each response before sending the next at a fixed concurrency), it will under-report both latency and effective request rate exactly during the period the system is most saturated — because it simply sends fewer requests when responses are slow, rather than queuing the ones that would have been sent. For capacity planning this is dangerous in a specific way: it can make a test's reported "safe" throughput look higher than it actually is, because the test never really pushed the system into its true degraded state — leading you to size capacity based on an artificially optimistic knee. The fix is the same as for general load testing: use an open-loop load generator that maintains the target request rate regardless of response time, so the true behaviour under saturation is captured.

### Q10. How do you decide between over-provisioning and relying on autoscaling for a given service?

I'd base it on the ratio between how fast the traffic can spike and how fast new capacity can come online: if a service's worst-case spike ramps up much faster than instances take to become healthy, reactive autoscaling alone will lag and you need a static buffer or pre-scheduled scaling for known events. I'd also weigh cost sensitivity and criticality — a customer-facing, revenue-critical path with unpredictable spikes justifies paying for a bigger idle buffer, while an internal, less time-sensitive batch service can lean much more heavily on reactive autoscaling to save cost. In practice most mature setups use a hybrid: a baseline sized with some margin, reactive autoscaling for organic variation, and scheduled pre-scaling layered on top for known high-risk events.

### Q11. A team's CPU and memory dashboards all look healthy, but they're getting timeouts under load. What would you check next?

I'd move past compute utilisation to saturation metrics on shared, potentially non-horizontally-scaling resources: database connection pool wait time and exhaustion, downstream API rate-limit responses, thread pool queue depth, and message broker consumer lag or partition-level throughput limits. This is the classic pattern where application instances look fine individually because the actual constraint is a shared resource that doesn't grow when you add more app instances — a fixed-size DB connection pool, a third-party rate limit, or a broker with too few partitions for the desired consumer parallelism. Confirming which specific shared resource is the bottleneck (via its own wait-time/queue-depth metric, not CPU) tells you exactly what to fix, rather than continuing to add compute that won't help.

### Q12. How would you calculate and use "cost per request" in a capacity planning conversation?

I'd compute it as total infrastructure cost for the service over a period divided by total requests served in that period, tracked as a trend over time rather than a single snapshot, and I'd watch specifically whether it's rising, flat, or falling as traffic grows. A rising cost-per-request as you scale usually signals an inefficiency worth fixing before simply adding more capacity — an over-provisioned baseline that doesn't need to scale linearly with traffic, an accidentally quadratic hot path, or redundant calls to a paid downstream service — whereas a falling cost-per-request as you scale (economies of scale from shared fixed costs) is a healthy sign. I'd bring this number into a capacity conversation specifically to justify prioritising an efficiency fix over "just add more instances" when the trend is unfavourable, since the latter is often the more expensive long-term answer.
