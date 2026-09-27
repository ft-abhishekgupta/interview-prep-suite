---
title: Multi Region Architecture
description: How to reason about why and how to run a system across multiple regions, and the real cost in latency, complexity and money
difficulty: Advanced
tags: [multi-region, replication, availability, latency]
---

Going multi-region is one of the most expensive decisions in system design, and interviewers probe whether you'd reach for it reflexively or only when the problem genuinely demands it. This page covers the reasons to go multi-region, the traffic-routing and replication mechanics, and the failure modes — split brain, conflict resolution, data residency — that make it hard.

## Why go multi-region

There are exactly three legitimate drivers, and naming them precisely (instead of "for scale") is what separates a senior answer.

| Driver | What it buys | Example |
|---|---|---|
| **Latency** | Serve users from a nearby region instead of one far away | A user in Singapore hitting a US-only backend eats 200ms+ round trip before any real work happens |
| **Availability** | Survive a full region outage (power, network, natural disaster) | AWS/Azure region-wide outages happen a few times a year across the industry |
| **Data residency / compliance** | Keep certain users' data physically within a legal jurisdiction | GDPR-style requirements that EU citizen data stay in the EU |

> [!KEY]
> "We might need to scale" is not a reason to go multi-region — a single region with multiple availability zones already gives you strong fault isolation and horizontal scale. Multi-region is specifically for **latency to distant users**, **surviving a whole region's failure**, or **legal data placement** — say which one you're solving for.

## Active-passive vs active-active vs read-local-write-global

| Model | Writes | Reads | Failover | Complexity | Cost |
|---|---|---|---|---|---|
| **Active-passive** | Only in primary region | Only in primary (or replicas for read-only) | Manual/automatic promotion, minutes | Low | Standby capacity mostly idle |
| **Active-active** | Accepted in every region | Served locally everywhere | None — traffic just avoids the dead region | High — conflict resolution required | Full duplicate capacity everywhere |
| **Read-local, write-global** | Routed to a single "home" region per entity | Served from the nearest region (often via replica/cache) | Fast for reads, writes to that entity are impacted if home region is down | Medium | Read replicas everywhere, single write owner |

```mermaid
flowchart TB
    subgraph "Active-Passive"
        U1["Users"] --> P["Primary region<br/>(writes + reads)"]
        P -.->|"replicate"| S["Standby region<br/>(idle, promoted on failure)"]
    end
```

```mermaid
flowchart TB
    subgraph "Active-Active"
        U2["Users (US)"] --> R1["Region US<br/>(read + write)"]
        U3["Users (EU)"] --> R2["Region EU<br/>(read + write)"]
        R1 <-->|"async replicate,<br/>conflict resolution"| R2
    end
```

> [!TIP]
> "Read-local, write-global" is the pragmatic middle ground many real systems land on: a user's profile "lives" in one home region (so writes for that user are simple, single-region transactions), but reads are served from the nearest replica everywhere — most traffic is reads, so this captures most of the latency win with a fraction of active-active's conflict-resolution complexity.

## Traffic routing

Getting a user's request to the right region is its own layer, independent of what happens once it arrives.

| Mechanism | How it works | Granularity | Failover speed |
|---|---|---|---|
| **GeoDNS** | DNS resolver returns a different IP based on the requester's geographic location | Coarse (DNS-level) | Slow — bound by DNS TTL, can take minutes to propagate |
| **Anycast** | Same IP address announced from multiple locations; network routing (BGP) sends the packet to the nearest one | Network-level | Fast — routing reacts to the underlying network topology directly |
| **Global load balancer** (Azure Front Door, AWS Global Accelerator, Traffic Manager) | Application-aware routing with active health checks, can route by latency, weighted split, or explicit failover priority | Fine-grained, health-check driven | Fast — actively probes backend health |

> [!WARNING]
> Pure DNS-based failover is one of the most common things to get wrong: clients and resolvers cache DNS answers for the TTL duration (sometimes minutes, sometimes much longer with misbehaving resolvers), so "failing over via DNS" can leave a meaningful fraction of traffic stuck hitting the dead region well past when you flipped the record.

## Data replication and conflict resolution

Once you have multiple regions, the database itself must replicate across them, and the replication topology directly decides your consistency and conflict story.

```mermaid
flowchart LR
    W["Write in Region A"] -->|"async replication,<br/>50-150ms lag"| RB["Replica in Region B"]
    W2["Concurrent write<br/>in Region B"] -.->|"conflict?"| RB
```

- **Single-leader, cross-region replicas**: one region is the source of truth for writes, others hold read-only replicas. Simple, no write conflicts, but writes from a distant region pay the full cross-region round trip.
- **Multi-leader (active-active)**: every region accepts writes locally, replicating asynchronously to others. Fast local writes everywhere, but **concurrent writes to the same entity in different regions can conflict** — resolved via last-write-wins (simple, can lose data — see the clocks page), vector clocks/CRDTs (detect/merge properly), or application-level merge logic.
- **Consensus-based (e.g. Spanner)**: uses a quorum across regions for every write, giving strong consistency globally — at the cost of every write paying a cross-region round trip for the quorum, which is inherently slower than either option above.

> [!DANGER]
> Multi-leader replication silently reintroduces every isolation anomaly discussed on the clocks and sagas pages — lost updates, dirty reads of soon-to-be-reverted data — except now the conflicting writes can be tens or hundreds of milliseconds apart in wall-clock time and still be genuinely concurrent, because that's roughly the cross-region replication lag.

## Cross-region latency reality check

| Route | Typical round-trip |
|---|---|
| Same datacenter | ~0.5 ms |
| Same region, different AZ | 1–2 ms |
| Same continent, different region (e.g. US East ↔ US West) | 60–80 ms |
| Cross-continent (US ↔ Europe) | 80–100 ms |
| Cross-continent (US ↔ Asia) | 150–200 ms |

These numbers are bounded by the speed of light over real fiber routes — no amount of engineering budget removes them. Any design that requires a **synchronous** cross-region round trip on the request's critical path (e.g. a consensus write, or a synchronous call to a service in another region) bakes that 60-200ms directly into user-facing latency, which is why active-active and read-local designs go out of their way to avoid synchronous cross-region calls on the hot path.

## Failover, failback, and split brain

Failover (routing traffic away from a failed region) is usually the easy half; **failback** — returning to normal once the failed region recovers — is where real incidents get worse. If the passive/failed region recovers and starts accepting traffic again while still holding stale data, or while the promoted region has since diverged, you get **split brain**: two regions both believe they're the authoritative source of truth, accepting conflicting writes.

```mermaid
sequenceDiagram
    participant A as "Region A (was primary)"
    participant B as "Region B (promoted)"
    Note over A: Network partition heals
    A->>A: Resumes accepting writes (stale state)
    B->>B: Still accepting writes (promoted)
    Note over A,B: Both think they are primary — split brain
```

The standard defenses: **fencing tokens** (a monotonically increasing generation number; the old primary's writes are rejected once a newer generation exists), quorum-based promotion (only promote a new primary if a majority of nodes agree, preventing two simultaneous promotions), and a deliberate, often manual, failback procedure that reconciles state before resuming dual-region operation rather than just "flipping it back on."

> [!DANGER]
> A rushed failback is a common cause of a *second*, worse outage right after the first one is resolved. Treat failback as its own careful procedure — verify data consistency, replicate the recovered region back up to date, then cut over — not as "just undo the failover."

## Data residency and GDPR

Some data legally cannot leave a jurisdiction — GDPR-style rules require EU citizens' personal data to be stored (and sometimes processed) within the EU, and similar rules exist in other jurisdictions (data localization laws in India, China, Russia). This turns multi-region from a pure performance/availability decision into a **hard constraint**: a user's data must be pinned to a specific home region regardless of where they're currently connecting from, and cross-region replication of that data may be restricted or banned entirely. In practice this pushes designs toward "read-local, write-global with a legally-determined home region," and requires care that backups, logs, and even metrics/traces don't inadvertently leak personal data across the boundary.

## Cost

Multi-region is expensive in ways that compound: duplicate compute and storage capacity in every active region, cross-region data transfer/egress fees (often the most underestimated line item), and the engineering cost of building and testing conflict resolution, failover and failback procedures. A rough rule of thumb: active-active roughly doubles (or more) infrastructure spend versus a single region, on top of the added engineering complexity — which is exactly why the decision should be driven by a named, concrete requirement (latency SLA, availability SLA, legal mandate), not general risk-aversion.

## Cheat sheet

- **Three legitimate reasons to go multi-region**: latency to distant users, surviving a whole-region failure, data residency/compliance. Name which one.
- **Active-passive**: simple, cheap, slower failover. **Active-active**: fast failover, full cost, needs conflict resolution. **Read-local-write-global**: pragmatic middle ground for read-heavy workloads.
- **GeoDNS is slow to fail over (TTL-bound)**; anycast and global load balancers with active health checks fail over faster.
- **Multi-leader replication reintroduces every isolation anomaly** — plan conflict resolution (LWW, vector clocks/CRDTs, app-level merge) explicitly.
- **Cross-region round trips are 60-200ms, bounded by physics** — never put one on a synchronous hot path if avoidable.
- **Failback is harder than failover** — a rushed failback causes split brain and a second outage.
- **Fencing tokens + quorum-based promotion** are the standard defenses against split brain.
- **Data residency (GDPR etc.) can force a home region per user**, independent of performance considerations.
- **Active-active roughly doubles infrastructure cost** — justify it against a specific SLA or legal requirement.

## Common mistakes

| Mistake | Fix |
|---|---|
| Going multi-region "for scale" without a specific latency/availability/compliance driver | Name the concrete requirement first; a single region with multiple AZs often suffices |
| Relying solely on DNS TTL for failover | Use anycast or an active-health-checked global load balancer for fast failover |
| Assuming active-active writes never conflict | Design explicit conflict resolution — LWW, vector clocks/CRDTs, or app-level merge |
| Rushing failback immediately after failover succeeds | Treat failback as a separate, careful, verified procedure |
| Putting a synchronous cross-region call on the request's hot path | Prefer async replication and local reads/writes; reserve sync cross-region calls for cases that truly need strong consistency |
| Ignoring cross-region egress cost until the bill arrives | Model data-transfer cost explicitly when comparing single vs multi-region designs |

## Summary

Multi-region architecture is justified by one of three concrete needs — latency to distant users, surviving a region-wide outage, or legal data residency — and the right topology (active-passive, active-active, or read-local-write-global) follows from which of those you're solving for for. The mechanics that make it hard are traffic routing that fails over fast enough, replication that either avoids conflicts (single-leader) or resolves them explicitly (multi-leader), and a disciplined failback procedure that avoids split brain. None of this is free: cross-region latency is bounded by physics, and active-active roughly doubles infrastructure cost, so the decision should always be traceable back to a specific SLA or legal requirement rather than general caution.

## Top Interview Questions

### Q1. What are the legitimate reasons to make a system multi-region, and why isn't "for scale" one of them?

The three real drivers are latency (serving users from a region physically near them instead of routing everyone to one distant datacenter), availability (surviving the complete loss of a region — power, network, natural disaster — which single-region multi-AZ designs cannot protect against), and data residency/compliance (legal requirements that certain users' data stay within a jurisdiction, like GDPR for EU citizens). "Scale" isn't a valid driver on its own because a single region with multiple availability zones already provides strong fault isolation and can scale horizontally to enormous capacity — going multi-region for pure throughput adds massive complexity (replication, conflict resolution, routing) without solving a problem multi-AZ scaling doesn't already solve.

### Q2. Compare active-passive, active-active, and read-local-write-global multi-region models.

Active-passive keeps one region as the sole writer and reader, replicating to a standby that's promoted on failure — simple and cheap, but failover takes seconds to minutes (promotion plus traffic redirection) and the standby capacity sits mostly idle. Active-active accepts writes and reads in every region simultaneously, giving near-zero failover time (traffic just avoids the dead region) at the cost of full duplicate infrastructure everywhere and the need to resolve concurrent writes to the same data landing in different regions. Read-local-write-global assigns each entity a single "home" region for writes (keeping writes simple, single-region transactions) while serving reads from the nearest regional replica — since most traffic in typical systems is reads, this captures much of the latency benefit of active-active with a fraction of its conflict-resolution complexity.

### Q3. Why is GeoDNS often insufficient for fast failover, and what would you use instead?

GeoDNS routes users to a region based on their location by returning different IPs from DNS, but DNS answers are cached by resolvers and clients for the record's TTL — which can be minutes, and in practice sometimes much longer if a resolver misbehaves or ignores TTL. When you flip the DNS record to redirect traffic away from a failed region, a meaningful fraction of clients keep resolving to the old (dead) IP until their cached entry expires, so the "failover" is slow and inconsistent across your user base. Anycast (announcing the same IP from multiple locations and letting network-level BGP routing send packets to the nearest live instance) or an active-health-checked global load balancer (Azure Front Door, AWS Global Accelerator) react much faster because they operate below the DNS-caching layer or actively probe backend health rather than relying on client-side cache expiry.

### Q4. What conflict resolution strategies exist for multi-leader (active-active) replication, and how would you choose between them?

Last-write-wins is the simplest — keep whichever write has the later timestamp — but as covered on the clocks page, cross-region clock skew means "later timestamp" often isn't the true causal winner, so LWW can silently discard a legitimate concurrent write; it's acceptable only where losing an update is cheap. Vector clocks (or CRDTs for specific data types like counters and sets) detect true concurrency and either surface both versions to the application or merge them mathematically without loss, at the cost of extra metadata and engineering complexity. Application-level merge logic encodes domain knowledge directly — e.g. merging two concurrently-modified shopping carts by unioning their items rather than picking one wholesale. I'd choose based on how costly silent data loss is for that specific entity: cheap/ephemeral data can use LWW, anything a user would notice losing needs vector clocks/CRDTs or explicit merge logic.

### Q5. What is split brain in a multi-region context, and how do you prevent it?

Split brain occurs when two regions simultaneously believe they are the authoritative primary and both accept writes — typically after a network partition where a passive region gets promoted (because it can no longer see the primary) while the original primary, unaware it was ever demoted, keeps serving writes once the partition heals or even during it. This produces two diverging, conflicting sets of writes with no inherent way to reconcile which is correct. Prevention relies on **quorum-based promotion** (a new primary is only promoted if a majority of nodes agree it's needed, which a genuinely partitioned old-primary can't achieve on its own) and **fencing tokens** (a monotonically increasing generation/epoch number attached to writes; once a higher generation exists, the old primary's writes are rejected by storage/consumers even if it doesn't know it's been superseded).

### Q6. Why is failback often more dangerous than the original failover?

Failover typically has one clear direction — move traffic and write authority away from a failing region toward a known-healthy one — and is usually well-rehearsed and automated. Failback requires reconciling two potentially diverged data sets: the recovered region may hold stale data from before it failed, while the region that was promoted has since accepted new writes; naively "switching back" before that reconciliation is complete effectively creates a temporary split-brain or, worse, silently overwrites newer data with the recovered region's stale copy. The safe procedure treats failback as its own deliberate operation: first bring the recovered region's replica fully up to date with everything the promoted region accepted during the outage, verify consistency, and only then cut traffic back — never just "undo" the failover flag.

### Q7. How does data residency (e.g. GDPR) change a multi-region design compared to one driven purely by latency or availability?

A purely latency- or availability-driven design is free to replicate any user's data to any region for performance or redundancy. Data residency requirements make the region assignment a **hard legal constraint** rather than a performance optimization: an EU citizen's personal data must be stored (and often processed) only within the EU, regardless of where they happen to be connecting from, and it may be illegal to even replicate it to a region outside that boundary for disaster recovery purposes. This typically forces a "home region per user, determined by data residency rules" model — closer to read-local-write-global, but where the home region is fixed by law rather than chosen for latency — and requires auditing that logs, backups, traces, and analytics pipelines don't inadvertently copy that data across the legal boundary.

### Q8. What's a realistic cross-region latency budget, and what design implication does it have?

Cross-region round trips typically run 60-80ms within the same continent (e.g. US East to US West) and 80-200ms across continents (US to Europe, US to Asia), bounded by the physical speed of light over real fiber routes — no amount of engineering effort removes this floor. The implication is that any synchronous operation that must cross regions on the user's request path — a consensus write requiring quorum across continents, or a service making a blocking call to another region — bakes that full round trip directly into user-facing latency, often dominating the entire request budget. This is why active-active and read-local designs deliberately avoid synchronous cross-region calls on the hot path, preferring asynchronous replication and serving both reads and (where possible) writes from the nearest region.

### Q9. Scenario: a customer in the EU reports their write occasionally "disappears" after being read back immediately, only in a multi-region active-active deployment. What's the likely cause?

This points to asynchronous replication lag combined with the client's read hitting a different region than the one their write landed in — the write committed locally in region A, but the client's next read (perhaps due to a routing change, a retried request, or a load balancer sending it elsewhere) hit region B before A's write had replicated there, showing stale data. If the client is also served a version resolved via naive last-write-wins during that lag window, a genuinely later read from B could even get merged/resolved against a concurrent write in a way that appears to "lose" the original write. The fix is either "read-your-own-writes" session affinity (route a given client/session consistently to the region that handled their last write, or forward reads to that region for a short window) or, for stronger guarantees, switch that class of write to bounded-staleness or session-consistency semantics rather than pure eventual consistency.

### Q10. When would you deliberately avoid active-active despite it giving the best failover characteristics?

I'd avoid active-active when the data model doesn't tolerate the conflict-resolution complexity it requires — e.g. financial ledgers or inventory counts where concurrent writes from two regions genuinely cannot both be "correct" and merging them isn't semantically sound (you can't average two conflicting balance updates). I'd also avoid it when the cost — full duplicate infrastructure in every region plus the substantial engineering investment in conflict resolution, testing, and operational tooling — isn't justified by the actual availability or latency requirement; if a warm-standby active-passive setup already meets the RTO/RPO the business actually needs, active-active is pure added risk and expense. In those cases, read-local-write-global (single home region per entity, replicas elsewhere for reads) or a straightforward active-passive setup is the better trade.

### Q11. How would you test that your multi-region failover actually works, rather than just trusting the architecture diagram?

I'd run controlled chaos experiments that simulate a real region loss — blocking all traffic to/from a region at the network level, or actually failing over DNS/global load balancer routing in a game-day exercise — and measure whether traffic actually redirects within the expected time, whether in-flight requests are handled gracefully (retried elsewhere, not just dropped), and whether the promoted region's data is consistent with what clients expect. I'd do this on a schedule (quarterly game days are common) rather than only once at launch, because regional infrastructure, dependency graphs, and traffic patterns change over time, and a failover mechanism that worked a year ago may have quietly broken due to a new dependency that wasn't multi-region-aware. I'd also explicitly test failback, not just failover, since that's the step most likely to be undertested and most likely to cause a second incident.

### Q12. How would you estimate the added cost of going from single-region to active-active multi-region for a system, and how would you present that trade-off to stakeholders?

I'd break the cost into three buckets: duplicated compute/storage capacity (roughly 2x baseline infrastructure spend if running full capacity in two active regions, more for three or more), cross-region data transfer/egress fees (often underestimated — continuous replication traffic between regions adds up, especially for write-heavy workloads), and the engineering investment in building, testing, and operating conflict resolution, routing, and failover/failback tooling (a real, ongoing cost, not a one-time project). I'd present this against the specific requirement driving the decision — "this SLA requires surviving a full region outage with near-zero downtime" or "this latency target requires serving APAC users locally" — framed as "here's the SLA/compliance requirement, here's the roughly 2x-plus cost and complexity to meet it, here's a cheaper alternative (active-passive, or accepting a looser SLA) and what it would cost us instead," letting the business make an informed trade rather than presenting multi-region as a foregone technical necessity.
