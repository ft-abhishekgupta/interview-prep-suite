---
title: Clocks and Event Ordering
description: Why you cannot trust wall-clock time in a distributed system and what to use instead to order events correctly
difficulty: Advanced
tags: [clocks, ordering, consistency, distributed-systems]
---

"Just use the timestamp" is one of the most common wrong answers in a system design interview. Every machine's clock drifts, jumps and disagrees with every other machine's clock, so ordering events by wall-clock time alone silently produces wrong answers. This page covers why, and the actual tools — Lamport clocks, vector clocks, hybrid logical clocks and TrueTime — that let distributed systems agree on order without a shared clock.

## Why wall-clock time lies

Every server has a local clock that is synchronized to real time via **NTP** (Network Time Protocol), but that synchronization is neither instant nor perfect.

| Problem | What happens |
|---|---|
| **Clock drift** | Cheap crystal oscillators gain or lose a few tens of milliseconds per day; two unsynchronized machines diverge continuously |
| **NTP correction jumps** | NTP periodically corrects drift, sometimes stepping the clock **backwards** — a timestamp can appear to go back in time |
| **Leap seconds** | Occasionally a minute has 61 seconds; naive clocks either jump or repeat a second unless "smeared" |
| **Network delay asymmetry** | Even a perfectly synced clock can't tell you "which event happened first" across machines within the sync error margin (typically 1–10 ms, worse across regions) |

> [!WARNING]
> Two events on two different machines with timestamps 5 ms apart **cannot be reliably ordered** — that gap is well within typical NTP sync error. Treating `t1 < t2` as proof that event 1 happened first is a common and dangerous assumption.

### Monotonic vs wall clock

Most languages expose two different clocks, and conflating them is a classic bug:

| Clock type | Guarantees | Use for |
|---|---|---|
| **Wall clock** (`Instant.now()`, `System.currentTimeMillis()`) | Tells "real" calendar time; can jump backwards or forwards | Timestamps for logs/humans, "when did this happen" for display |
| **Monotonic clock** (`System.nanoTime()`) | Never goes backwards; has no meaning across machines | Measuring elapsed time/durations, timeouts |

> [!DANGER]
> Computing a duration as `wallClockEnd - wallClockStart` can produce a **negative number** if NTP stepped the clock backwards mid-measurement. Always use a monotonic clock for elapsed-time measurements, never wall clock.

## Happens-before and logical clocks

Since wall clocks can't be trusted for ordering, distributed systems use **logical clocks**, which capture causality — "did A definitely happen before B" — instead of real time.

The **happens-before relation** (`→`) is defined as: if A and B are on the same process and A comes first, `A → B`. If A is sending a message and B is receiving it, `A → B`. It's transitive. Two events that satisfy neither `A → B` nor `B → A` are **concurrent** — genuinely simultaneous from the system's point of view, order undefined.

### Lamport timestamps

A Lamport clock is a single counter per process, incremented on every local event, and updated on message receipt to be greater than both the local counter and the sender's stamped value.

```
Rule 1: on any local event, counter = counter + 1
Rule 2: on send, attach current counter to the message
Rule 3: on receive, counter = max(local counter, message counter) + 1
```

This guarantees `A → B ⟹ L(A) < L(B)` — but **not the converse**: `L(A) < L(B)` does not prove `A → B`, because concurrent events can still get arbitrarily ordered timestamps. Lamport clocks give you *a* consistent total order (useful for things like tie-breaking), not *the* causal truth.

### Vector clocks

A vector clock fixes that gap by giving every process its **own counter in a vector**, one slot per process. On a local event, a process increments its own slot; on receive, it takes the element-wise max with the incoming vector, then increments its own slot.

```mermaid
sequenceDiagram
    participant P1 as "Process 1 [1,0,0]"
    participant P2 as "Process 2 [0,1,0]"
    participant P3 as "Process 3 [0,0,1]"
    P1->>P2: msg [1,0,0]
    Note over P2: [1,2,0]
    P2->>P3: msg [1,2,0]
    Note over P3: [1,2,2]
    P1->>P3: msg [2,0,0] (concurrent with P2->>P3)
```

Now you *can* detect concurrency precisely: if neither vector dominates the other (each has some component greater than the other's), the events are concurrent — genuinely, not just by timestamp coincidence. This is exactly how Amazon's Dynamo detected conflicting concurrent writes to the same key and surfaced both versions to the application to resolve. The cost: a vector clock's size grows with the number of processes/replicas, which doesn't scale to millions of clients.

### Hybrid logical clocks (HLC)

HLCs combine both worlds: a value that looks like a wall-clock timestamp (so it's human-readable and roughly comparable to real time) but that also carries a logical counter component guaranteeing the happens-before property like a Lamport clock. Practically: `HLC = (physical time, logical counter)`, where the logical counter only increments when physical clocks would otherwise tie or go backwards. CockroachDB and MongoDB both use HLCs — you get "approximately real time" ordering with a correctness guarantee logical clocks alone don't give you against clock skew.

## Google TrueTime and bounded uncertainty

Google Spanner takes a different approach: instead of pretending clocks are perfect, TrueTime makes uncertainty **explicit**. Every timestamp read is not a single value but an interval `[earliest, latest]`, backed by atomic clocks and GPS receivers in every datacenter, bounding the actual uncertainty (typically under 7 ms).

> [!KEY]
> Spanner's trick for external consistency: after assigning a commit timestamp, it **waits out the uncertainty window** ("commit wait") before acknowledging, guaranteeing that any transaction that starts later is assigned a strictly later timestamp. It doesn't eliminate clock uncertainty — it waits long enough that the uncertainty no longer matters.

This lets Spanner offer globally-consistent, externally-ordered transactions across regions — a genuinely hard problem — at the cost of that wait (single-digit milliseconds) on every commit, and specialized hardware most companies don't have.

## Last-write-wins and its data loss problem

A common shortcut for resolving conflicting concurrent writes is **last-write-wins (LWW)**: keep whichever write has the higher timestamp, discard the other. It's simple and requires no vector clocks — but it silently **loses data** whenever two writes are genuinely concurrent, because "later timestamp" is often just clock skew, not real precedence.

| Approach | Behaviour on conflict | Data loss risk |
|---|---|---|
| **LWW** | Keep highest timestamp, discard the rest | High — concurrent writes lose one side silently |
| **Vector clocks + app resolution** | Detect concurrency, surface both versions to the app/user | Low — but requires conflict-resolution logic |
| **CRDTs** | Merge concurrent updates mathematically (e.g. counters, sets) | None, for supported data types |
| **Application-level merge** | Domain logic decides (e.g. merge shopping carts) | Depends on the merge quality |

> [!DANGER]
> DynamoDB and Cassandra both default to LWW at the column/cell level unless you opt into more careful conflict handling. In an interview, naming this trade-off explicitly ("LWW is simple but can silently drop a concurrent write — I'd only accept that for data where losing an update is cheap") is a strong signal.

## Ordering guarantees in message systems and idempotency as an alternative

Message brokers offer ordering per-partition (Kafka) or per-queue/session (Service Bus/RabbitMQ), not globally — a common question is "how do I guarantee global order," and the honest answer is usually "you don't; you don't need to."

```mermaid
flowchart LR
    P["Producer"] -->|"key = userId"| K1["Partition 0"]
    P -->|"key = userId"| K2["Partition 1"]
    K1 --> C1["Consumer A"]
    K2 --> C2["Consumer B"]
```

Instead of forcing total order (which caps throughput to a single partition/consumer), most systems reach for **idempotency keys**: attach a unique key to every operation so that no matter the order or number of times it's delivered, applying it twice has the same effect as applying it once. This sidesteps ordering entirely for a huge class of problems — "process this payment" only needs "exactly-once effect," not "exactly this order relative to everything else."

> [!TIP]
> When an interviewer pushes on "how do you guarantee ordering across the whole system," the strong answer is often: "I'd scope ordering to what actually needs it — per-key via a partition key — and make the rest of the operations idempotent so ordering doesn't matter for them."

## Cheat sheet

- **Wall clocks drift, jump, and disagree** — never assume `timestamp1 < timestamp2` proves causal order across machines.
- **Monotonic clock for durations, wall clock for calendar time** — never mix them.
- **Happens-before (`→`)** is the real notion of order; events that satisfy neither direction are **concurrent**.
- **Lamport timestamps**: single counter, gives *a* total order, `A → B ⟹ L(A) < L(B)` but not the converse.
- **Vector clocks**: one counter per process, can detect true concurrency, cost grows with node count.
- **HLC**: physical time + logical counter — human-readable and causally correct, used by CockroachDB/MongoDB.
- **TrueTime**: explicit uncertainty interval + commit wait; Spanner's way of buying global consistency with atomic clocks.
- **LWW is simple but loses data on real concurrent writes** — know when that's acceptable.
- **Message queues order per-partition/per-key, not globally** — design for that instead of fighting it.
- **Idempotency keys sidestep ordering** for a huge class of "exactly-once effect" problems.

## Common mistakes

| Mistake | Fix |
|---|---|
| Ordering events by wall-clock timestamp across machines | Use logical clocks (Lamport/vector) or a sequence assigned by one authority |
| Computing elapsed time with wall-clock subtraction | Use a monotonic clock (`System.nanoTime()`) |
| Assuming a lower Lamport timestamp means "happened before" | Lamport only guarantees the forward direction; concurrent events can get any relative order |
| Defaulting to LWW without considering data loss | Use vector clocks/CRDTs/app-level merge where losing a concurrent write is unacceptable |
| Trying to enforce global message order for throughput's sake | Partition by key for local order, make cross-key operations idempotent |
| Assuming NTP keeps clocks perfectly in sync | Budget for milliseconds of skew; use commit-wait style techniques if you need strict ordering |

## Summary

Distributed systems cannot rely on wall-clock time to order events because clocks drift, jump and disagree by amounts that dwarf the gaps between real events. Logical clocks — Lamport timestamps for a cheap total order, vector clocks for detecting true concurrency, hybrid logical clocks for a practical middle ground — capture causality directly instead. Google's TrueTime shows the other end of the spectrum: make clock uncertainty explicit and pay a small wait to get real global ordering. In practice, most systems avoid the whole problem for large classes of operations by scoping ordering to a partition key and making everything else idempotent.

## Top Interview Questions

### Q1. Why can't you just use wall-clock timestamps to order events across two different machines?

Because clocks on different machines are never perfectly synchronized. NTP keeps them close, but typical sync error is single-digit to tens of milliseconds, and NTP corrections can even step a clock backwards. If two events happen 5 ms apart on different machines, their timestamps might show either one as "earlier" depending on each machine's drift at that moment — the timestamp order doesn't reliably reflect the real order. This matters concretely: using timestamps to decide "which write is newest" (last-write-wins) can silently discard the actually-newer write if the winning machine's clock happened to be running fast.

### Q2. What is the difference between a monotonic clock and a wall clock, and where does mixing them up cause bugs?

A wall clock reports calendar/real time and can jump — forward or backward — due to NTP corrections, manual adjustment, or leap seconds. A monotonic clock only ever moves forward and has no meaning outside the local process (you can't compare monotonic values between two machines), but it is exactly what you want for measuring elapsed time. The classic bug: computing a request's duration as `Instant.now()` at the end minus `Instant.now()` at the start. If NTP steps the wall clock backwards mid-request, that subtraction can be negative, which then breaks a metric, a timeout calculation, or a rate limiter. Use `System.nanoTime()` for durations, wall clock only for "what time did this happen" logging.

### Q3. Explain the happens-before relation and what it means for two events to be concurrent.

Happens-before (`A → B`) is a partial order capturing causality: it holds if A and B occur in sequence on the same process, or if A is a message send and B is the corresponding receive, and it's transitive across chains of these. If neither `A → B` nor `B → A` holds, the events are **concurrent** — there is no causal link between them, so no correct system should assume one happened before the other. This matters practically: if two writes to the same record are concurrent, there's no "true" winner to pick by causality alone, and a system must either merge them, pick a rule (like last-write-wins), or ask the application to resolve the conflict.

### Q4. How do Lamport timestamps work, and what do they guarantee versus not guarantee?

Each process keeps a single counter, incremented on every local event; when sending a message, it attaches its current counter, and on receiving, the recipient sets its counter to `max(local, received) + 1`. This guarantees that if `A → B` in the happens-before sense, then `L(A) < L(B)` — a real causal link is always reflected in increasing timestamps. What it does **not** guarantee is the converse: two concurrent events (no causal link) can still end up with `L(A) < L(B)` purely because of counter bookkeeping, so you cannot conclude causality just from comparing Lamport values. They're useful for producing a consistent total order (e.g. as tie-breakers), not for detecting true concurrency.

### Q5. How do vector clocks improve on Lamport timestamps, and what's the cost?

A vector clock gives every process its own slot in a vector; each process increments only its own slot on a local event, and on receiving a message takes the element-wise maximum with the incoming vector before incrementing its own slot. This lets you compare two vector clocks and definitively say whether one causally precedes the other (every component ≤, at least one <), the other precedes it, or — if neither vector dominates — the events are genuinely concurrent. That precision is exactly what Amazon Dynamo used to detect real write conflicts and surface both versions rather than silently picking one. The cost is that a vector's size scales with the number of participating processes/replicas, which becomes unwieldy with many nodes or, worse, many clients.

### Q6. What is a hybrid logical clock and why would a database like CockroachDB or MongoDB use one?

An HLC combines a physical-time component with a logical counter: the timestamp looks like (and mostly tracks) real wall-clock time, so it's human-readable and roughly comparable across nodes, but the logical counter increments to preserve the happens-before guarantee whenever physical clocks would otherwise tie or appear to go backward. This gives you the best of both: timestamps that are meaningful "as of now" for operational purposes (like reasoning about staleness), and a mathematical guarantee that causally-related events always get increasing HLC values, which pure wall-clock timestamps can't promise under clock skew. Databases use it to order transactions/writes correctly without needing specialized atomic-clock hardware like Google TrueTime.

### Q7. What is Google TrueTime, and how does Spanner use "commit wait" to achieve external consistency?

TrueTime is Google's API that returns not a single timestamp but a bounded interval `[earliest, latest]` representing the true current time with known uncertainty, backed by atomic clocks and GPS receivers in every datacenter (uncertainty typically under 7 ms). Spanner uses this by, after choosing a commit timestamp for a transaction, deliberately **waiting** until it is certain that timestamp is in the past everywhere — i.e., waiting out the uncertainty window — before acknowledging the commit. This guarantees that any transaction starting after the commit is acknowledged gets a strictly later timestamp, giving Spanner externally-consistent, globally-ordered transactions across regions. The trade-off is a small latency cost (single-digit milliseconds) on every commit and reliance on specialized hardware most organizations don't have.

### Q8. What is last-write-wins conflict resolution, and when is it a bad choice?

LWW resolves a conflicting write to the same key by keeping whichever write carries the higher timestamp and discarding the other — simple, requires no extra metadata, and is the default in systems like Cassandra and DynamoDB at the column level. It's a bad choice whenever two writes can be genuinely concurrent and losing one silently is unacceptable: because "higher timestamp" is often an artifact of clock skew rather than true precedence, a real, intentional write can be discarded without anyone noticing. Better options — vector clocks that detect true concurrency and surface both versions to the application, or CRDTs that merge concurrent updates mathematically for supported data types (counters, sets) — cost more complexity but avoid silent data loss. I'd accept LWW only where losing an update is genuinely cheap, e.g. a "last seen" timestamp or a cache entry.

### Q9. Scenario: two users concurrently update the same shopping cart from different devices and one item silently disappears. What went wrong and how would you fix it?

This is a classic lost-update anomaly from naive last-write-wins conflict resolution: both devices read the cart, added an item locally, and wrote back the full cart object; whichever write landed with the later timestamp overwrote the other entirely, discarding the first item. The fix is to detect the concurrency instead of blindly overwriting — use a vector clock (or a version/ETag with optimistic concurrency) so the system recognizes these two writes are concurrent, not sequential, and either merges them (union the cart contents, which is what Amazon's original Dynamo did for shopping carts) or surfaces both versions for the client to reconcile. In general, whenever "add an item" is really "read-modify-write the whole object," you're at risk of this — modeling it as an additive operation (append to a cart-items log) sidesteps the conflict entirely.

### Q10. How does message ordering typically work in Kafka or similar systems, and why don't these systems guarantee global order?

Ordering is guaranteed only **within a partition** — messages with the same partition key are delivered to the same partition and consumed in the order they were written. Across partitions, there is no ordering guarantee at all, and that's a deliberate trade-off: a single global order would mean a single writer/reader bottleneck, which caps throughput to what one partition can handle. Systems scale by partitioning on a key that captures the ordering you actually need (e.g. `userId`, so all of one user's events are ordered) and accepting that unrelated keys can interleave in any order, since they don't have a real causal relationship anyway.

### Q11. Why would you use idempotency keys instead of trying to guarantee strict message ordering?

Guaranteeing strict global ordering is expensive — it usually means funneling everything through a single writer or partition, which limits throughput and creates a single point of contention. Idempotency keys solve a different, often sufficient problem: instead of requiring operations to arrive in a specific order, you make each operation safe to apply more than once (or in any order relative to unrelated operations) by tagging it with a unique key and having the receiver check "have I already applied this key?" before acting. For something like "charge this payment" or "deduct this inventory," what actually matters is that the effect happens exactly once, not that it happens in a particular global sequence — so idempotency is both cheaper and directly solves the real requirement.

### Q12. In production, how would you detect that clock skew is causing incorrect behavior, and what would you do about it?

Watch for negative or implausible duration metrics (a request that appears to take -50 ms), timestamp-ordering complaints from users ("my newer comment shows up before my older one"), or unexplained LWW data loss reported as "my change disappeared." I'd instrument NTP sync status/offset per host as a first-class metric and alert if any host's offset exceeds a threshold (a few tens of milliseconds), since that's usually the root cause. For the underlying design problem, I'd migrate any ordering-sensitive logic off raw wall-clock comparison and onto a logical or hybrid logical clock, and for conflict resolution, move away from naive LWW toward vector-clock-based or idempotent/CRDT-based approaches for data where silent loss is costly.
