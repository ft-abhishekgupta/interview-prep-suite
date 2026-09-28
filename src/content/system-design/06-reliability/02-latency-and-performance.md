---
title: Latency and Performance
description: How to reason about tail latency, queueing, and fan-out amplification instead of quoting a single average response time
difficulty: Core
tags: [latency, performance, queueing, percentiles]
---

"Average response time is 50ms" is close to meaningless in a system with real traffic. This page covers the vocabulary that makes latency conversations precise in an interview — percentiles, tail amplification, Little's Law, queueing behavior, and where the milliseconds actually go on a request's path.

## Latency, throughput and bandwidth

These three get conflated constantly, and an interviewer will notice if you don't separate them.

| Term | Definition | Unit | Improving one doesn't fix the other |
|---|---|---|---|
| **Latency** | Time for one request to complete | ms | Fast pipe doesn't mean fast individual response if the request itself is slow |
| **Throughput** | Requests (or bytes) processed per unit time | req/s, MB/s | High throughput can coexist with high per-request latency if you parallelize enough |
| **Bandwidth** | Maximum data transfer capacity of a link | Mbps/Gbps | Bandwidth is a *ceiling* on throughput, not a guarantee of low latency |

A classic analogy: a fleet of trucks moving cargo has huge **throughput** (tons/day) but terrible **latency** (days per shipment) — bandwidth and throughput can be scaled by adding trucks, but latency for any single shipment doesn't improve.

## Percentiles, and why averages lie

The average hides the shape of the distribution — and in production, the shape is almost never a symmetric bell curve; it has a long tail of slow requests dragging behind a cluster of fast ones.

| Percentile | Meaning | Typical use |
|---|---|---|
| **p50** (median) | Half of requests are faster than this | "Typical" experience |
| **p90** | 90% of requests are faster than this | Reasonable SLO target |
| **p99** | 99% of requests are faster than this | Where real user pain starts showing up |
| **p99.9** | 999 out of 1000 requests are faster than this | What large-scale systems actually optimize for |

> [!KEY]
> At 10,000 requests/second, p99.9 represents **10 requests every second** that are having a bad time. At large enough scale, "rare" tail latency becomes a constant, guaranteed stream of unhappy users — never dismiss it as an edge case.

> [!WARNING]
> Averages are easily dominated by the bulk of fast requests and can look great even while a meaningful fraction of users have a terrible experience. Always ask "average of what distribution?" and push for percentiles in any latency discussion — including in an interview.

## Tail latency amplification in fan-out systems

If a single request depends on many parallel sub-requests, and the overall response can't return until **all** of them finish, the odds of hitting at least one slow one grow fast — a single request's p99 turns into the *whole system's* p50 or worse.

```mermaid
flowchart TD
    C["Client request"] --> G["Gateway"]
    G --> S1["Shard 1<br/>p99 = 100ms"]
    G --> S2["Shard 2<br/>p99 = 100ms"]
    G --> S3["Shard 3<br/>...<br/>p99 = 100ms"]
    G --> S20["Shard 20<br/>p99 = 100ms"]
    S1 & S2 & S3 & S20 --> M["Merge — waits<br/>for the slowest"]
```

If each of 20 parallel calls has a 1% chance of being slow (that's its own p99), the chance that *at least one* of the 20 is slow is `1 - 0.99²⁰ ≈ 18%`. Fan out to 100 shards and it's `1 - 0.99¹⁰⁰ ≈ 63%` — the majority of overall requests now hit at least one slow shard. This is **tail latency amplification**, and it's why systems that fan out widely (search, ad serving, recommendation systems) obsess over p99.9 at the leaf level, not just the average.

### Hedged requests and cancellation

A practical mitigation: send a duplicate ("hedged") request to a second replica if the first hasn't responded within, say, the p95 latency for that call, and take whichever answer comes back first, cancelling the other. This trades a small amount of extra load (only paid when a request is already running slow) for a big cut in tail latency — Google's "The Tail at Scale" paper popularized this technique. **Request cancellation** matters just as much: if a client gives up and the server doesn't know, work continues wastefully; propagating cancellation (e.g. via a cancellation token or a context deadline) frees resources immediately.

> [!TIP]
> A senior answer names the cost: *"Hedging cuts tail latency but increases total load on the backend — I'd only hedge the slowest fraction of requests, and only for idempotent, cheap-to-duplicate operations."*

## Little's Law and queueing intuition

**Little's Law** relates the average number of requests in a system (`L`), the average arrival rate (`λ`), and the average time each request spends in the system (`W`):

```text
L = λ × W
```

It's a simple, universal relationship — no assumptions about the distribution — and it's the tool for a quick sanity check: if 1,000 requests/sec arrive and each spends 200ms in the system on average, there are on average `1000 × 0.2 = 200` requests in flight at any moment. If your connection pool or thread pool has fewer than 200 slots, requests are queueing (or being rejected) — this is often the fastest way to explain "why is latency suddenly terrible" in an interview: **not enough concurrency capacity for the arrival rate**.

### Utilisation vs latency

Queueing theory's most important qualitative result: latency doesn't grow linearly with utilization — it grows **explosively** as utilization approaches 100%.

```mermaid
flowchart LR
    A["Utilisation 50%"] -->|"latency ~baseline"| B["Utilisation 80%"]
    B -->|"latency creeping up"| C["Utilisation 95%"]
    C -->|"latency spikes 5-10x"| D["Utilisation 99%+"]
    D -->|"queue grows unbounded"| E["Effectively unavailable"]
```

For an M/M/1 queue, expected wait time scales with `ρ / (1 - ρ)` where `ρ` is utilization — at 50% utilization the factor is 1, at 90% it's 9, at 99% it's 99. This is why healthy systems target **60-80% utilization**, not 95%+: the last bit of "efficiency" from running hot costs a disproportionate amount of latency, and leaves no headroom to absorb a traffic spike.

> [!DANGER]
> "Our servers are only at 90% CPU, we have headroom" is a trap — at that utilization, queueing delay is already growing fast, and a modest additional load spike (even 10-15%) can push latency into a cliff, not a gentle slope.

## Where latency actually comes from

Breaking down a request's time budget is a strong interview move — it shows you know the request path, not just the abstract terms.

| Source | Typical cost | Notes |
|---|---|---|
| **Network round trip (same DC)** | ~0.5 ms | TCP/TLS handshake adds more on new connections |
| **Network round trip (cross-region)** | 50–150 ms | Speed of light + routing hops; irreducible without moving data closer |
| **Serialization/deserialization** | 0.1–5 ms | JSON is slower than protobuf/binary formats at scale |
| **Disk seek (HDD)** | ~10 ms | Rare in modern backend paths, but still shows up in cold storage |
| **SSD read** | ~0.1 ms | |
| **GC pause** | 1ms – 100s of ms | Depends on runtime/heap size; a classic invisible latency spike |
| **Lock contention** | Highly variable | A hot lock under load turns into effectively unbounded queueing |
| **DB query (cached)** | < 5 ms | |
| **DB query (uncached, indexed)** | 5–20 ms | |

## Budgeting latency across a request path

If a user-facing request has a 300ms latency budget and touches four services in sequence, you don't get 300ms per hop — the budget must be split, with margin left over for network overhead between each hop.

```mermaid
flowchart LR
    C["Client budget: 300ms"] --> GW["Gateway: 10ms"]
    GW --> AUTH["Auth check: 20ms"]
    AUTH --> SVC["Business logic: 150ms"]
    SVC --> DB["DB query: 80ms"]
    DB --> BUF["Network + margin: 40ms"]
```

Explicitly budgeting this way during design (rather than discovering it in production) is what lets you say, in an interview, exactly which hop has to be fast and which has room — and it's how real systems set **per-hop timeouts** that add up sensibly instead of arbitrarily.

## Cheat sheet

- **Latency ≠ throughput ≠ bandwidth** — a wide pipe doesn't make one request faster.
- **Report percentiles, not averages** — p50/p90/p99/p99.9. Averages hide the tail.
- **At scale, "rare" tail latency (p99.9) is a constant stream of unhappy users**, not an edge case.
- **Fan-out amplifies tail latency**: `1 - (1 - tailProb)^N` grows fast as N (number of parallel calls) grows.
- **Hedged requests** trade a little extra load for a big cut in tail latency — use for idempotent, cheap calls.
- **Little's Law**: `L = λ × W` — a quick way to estimate concurrent in-flight requests and spot undersized pools.
- **Latency explodes near 100% utilization** — target 60-80%, not "just under the redline."
- **Know the numbers**: same-DC round trip ~0.5ms, cross-region 50-150ms, SSD ~0.1ms, HDD ~10ms.
- **Budget latency across hops explicitly** — set per-hop timeouts that sum sensibly to the overall SLA.

## Common mistakes

| Mistake | Fix |
|---|---|
| Quoting only average latency | Always pair with p99/p99.9; averages hide the tail |
| Assuming fan-out latency equals the slowest single call's average | Model it as "probability at least one of N calls is slow" — it compounds |
| Running servers at 90%+ CPU and calling it "efficient" | Target 60-80% utilization to keep queueing delay sane and leave headroom |
| Retrying/hedging every request indiscriminately | Hedge only slow-tail, idempotent, cheap operations — it adds backend load |
| Ignoring GC pauses and lock contention as "not real latency" | Both show up directly in p99+ and must be profiled |
| Setting the same timeout at every hop regardless of the overall budget | Derive per-hop timeouts from the end-to-end latency budget |

## Summary

Latency conversations that stop at "the average is 50ms" miss almost everything that matters: the shape of the distribution, what happens when many calls fan out in parallel, and how latency behaves non-linearly as utilization climbs. Percentiles (especially p99 and p99.9), Little's Law for sizing concurrency, and an explicit per-hop latency budget are the tools that turn "it feels slow sometimes" into a precise, defendable design conversation — and knowing roughly where the milliseconds go (network, serialization, disk, GC, locks) is what lets you diagnose it fast when it happens.

## Top Interview Questions

### Q1. Why do averages give a misleading picture of system latency, and what should you report instead?

An average collapses an entire distribution into one number, and production latency distributions are rarely symmetric — there's usually a cluster of fast requests and a long tail of slow ones caused by GC pauses, cache misses, lock contention, or network hiccups. A system can have an excellent average (50ms) while a meaningful fraction of users experience 2-5 second responses, and the average won't reveal it. The fix is to report percentiles: p50 for the typical experience, and critically p99 and p99.9, which capture the tail where real user pain lives. At scale, even a "rare" p99.9 event happens continuously — at 10,000 req/s, p99.9 is ten unhappy requests every single second.

### Q2. What is tail latency amplification, and why does it matter for fan-out systems like search or ad serving?

When a single user-facing request depends on multiple parallel backend calls and can't complete until all of them return, the overall latency is bounded by the *slowest* of those calls, not the average. If each of N parallel calls independently has a small probability `p` of being slow (its own tail), the probability that *at least one* of them is slow is `1 - (1-p)^N`, which grows quickly with N. For example, with a 1% per-call tail probability and 100 parallel calls, roughly 63% of overall requests hit at least one slow call — the rare tail becomes the common case at the aggregate level. This is why fan-out-heavy systems obsess over p99.9 at the leaf/shard level rather than the average, and often use hedged requests to cut it down.

### Q3. What are hedged requests, and what's the trade-off in using them?

A hedged request is a duplicate of an in-flight request sent to a different replica if the original hasn't returned within a threshold (often close to that call's own p95 or p99 latency), with the first response to arrive winning and the other cancelled. It directly attacks tail latency: a request that would have been stuck behind a slow replica gets a second chance via a fast one, without needing to identify *which* replica is slow ahead of time. The trade-off is extra load — every hedge is (usually) a duplicate unit of work on the backend — so it should be applied selectively (only to the slow tail, only for cheap/idempotent operations) rather than to every request, or it can create a feedback loop that makes the backend slower overall.

### Q4. State Little's Law and explain how you'd use it to debug a "why is latency suddenly bad" incident.

Little's Law states `L = λ × W`: the average number of requests in the system (`L`) equals the average arrival rate (`λ`) times the average time each request spends in the system (`W`). If throughput (`λ`) suddenly increases or per-request latency (`W`) increases for any reason (a slow downstream dependency, a lock, GC pauses), `L` — the number of concurrently in-flight requests — goes up proportionally. If your connection pool, thread pool, or worker count is fixed and smaller than the new `L`, requests start queueing (or get rejected), which itself increases `W` further, compounding the problem. In an incident, this is often the fastest explanation: something upstream got slower, in-flight concurrency ballooned past the pool size, and now everything is queueing behind a fixed number of workers.

### Q5. Why does latency increase non-linearly as utilization approaches 100%, rather than gradually?

Queueing theory shows that expected wait time scales roughly with `ρ / (1 - ρ)`, where `ρ` is utilization — a formula that stays small at low-to-moderate utilization but blows up as `ρ` approaches 1. At 50% utilization the multiplier is 1x; at 90% it's 9x; at 99% it's 99x. The intuition: near full utilization, there's essentially no slack to absorb any variance in arrival rate or service time, so any burst compounds into a growing queue that takes a long time to drain. This is why healthy systems deliberately run at 60-80% utilization rather than "as high as possible" — the last 10-20% of "efficiency" isn't worth the latency cliff, and it also removes any headroom to absorb a traffic spike.

### Q6. Walk through where latency actually comes from in a typical backend request, in rough order of magnitude.

Same-datacenter network round trips cost roughly 0.5ms; a fresh TCP+TLS handshake adds more on top if the connection isn't already warm/pooled. Serialization/deserialization (JSON parsing, protobuf encoding) typically costs sub-millisecond to a few milliseconds depending on payload size and format. A cached database read is under 5ms; an uncached but indexed read is 5-20ms; a full table scan or badly-indexed query can be orders of magnitude worse. Storage itself: SSD reads are about 0.1ms, HDD seeks about 10ms. Two often-overlooked sources that show up specifically in tail latency: garbage collection pauses (from sub-millisecond to hundreds of milliseconds depending on runtime and heap size) and lock contention, where a hot lock under load effectively becomes an unbounded queue.

### Q7. How would you set timeouts for a request that fans out to four sequential services with an overall 300ms SLA?

I would not give each hop 300ms — that both wastes budget (four services each allowed to be slow serially blows past the SLA) and misrepresents dependency risk. Instead, I'd explicitly budget: assign each hop a slice of the 300ms based on its expected cost plus margin (e.g. gateway 10ms, auth 20ms, business logic 150ms, DB query 80ms, leaving ~40ms of network/margin), and set each hop's timeout to its budgeted slice, not the full 300ms. This has two benefits: it forces you to identify which hop is actually the bottleneck (worth optimizing first), and it means a single slow hop fails fast rather than silently consuming the whole budget and leaving nothing for the remaining hops.

### Q8. What's the difference between throughput and bandwidth, and can you increase one without the other?

Bandwidth is the maximum capacity of a link or channel (e.g. a 10 Gbps network interface) — a hard ceiling. Throughput is the actual rate of useful work processed (requests/sec or bytes/sec actually transferred), which is bounded by bandwidth but usually falls well short of it due to protocol overhead, processing time, or backpressure elsewhere in the system. You can increase throughput without touching bandwidth by parallelizing more (more connections, more workers) up to the point bandwidth or another resource (CPU, DB connections) becomes the bottleneck; conversely, increasing bandwidth (a bigger network pipe) doesn't help throughput at all if the bottleneck is elsewhere, e.g. single-threaded processing or a slow downstream dependency.

### Q9. Scenario: p50 latency looks great, but p99 latency has crept up 5x over the last month with no code changes. What would you investigate?

Since there's no code change, I'd look for a shift in the underlying system's behavior: growing data volume (an index that used to fit comfortably in memory/cache now spills, causing occasional slow uncached lookups), increased traffic pushing utilization into the non-linear queueing regime even though p50 barely moves, or a noisy-neighbor effect (shared infrastructure, autoscaling lag causing occasional under-provisioning at peak). I'd also check GC metrics and lock-wait metrics specifically, since both manifest almost exclusively in the tail rather than the median, and check whether a downstream dependency's own tail latency has grown, since that would propagate as amplified tail latency through fan-out. The key diagnostic move is correlating the p99 latency time series against traffic volume, memory/heap graphs, and dependency latency — not code diffs.

### Q10. When would you choose to trade some throughput for lower tail latency, and give a concrete technique?

I'd make that trade whenever the product is latency-sensitive at the individual-request level and a modest capacity cost is acceptable — e.g. a live search-as-you-type feature, or a payment confirmation page, where users directly feel a slow p99 far more than they'd notice slightly higher average infrastructure cost. A concrete technique is hedged requests: fire a duplicate request to a second replica if the first hasn't returned within a threshold close to the expected p95, and take whichever comes back first. This costs extra backend load (fewer requests can be served per unit of capacity, since some are duplicated) but directly and predictably cuts tail latency, which is exactly the trade a latency-sensitive, moderately-loaded system wants to make.
