---
title: CAP and Consistency Models
description: What CAP actually forces you to choose during a network partition, and how to place a system anywhere on the spectrum from linearizable to eventual
difficulty: Advanced
tags: [cap-theorem, consistency, distributed-systems, quorum, pacelc]
---

CAP theorem gets misquoted in almost every interview that mentions it, usually as "pick two of three, always". The correct statement is much narrower, and the more useful interview skill is knowing the *spectrum* of consistency models between "always exactly right" and "eventually right" — because real systems rarely sit at either extreme.

## CAP theorem, stated correctly

CAP says: in the presence of a **network partition**, a distributed data store must choose between **consistency** and **availability** — it cannot offer both. It says nothing about the normal, non-partitioned case.

| Guarantee | Meaning |
|---|---|
| **Consistency (C)** | Every read receives the most recent write, or an error — not stale data |
| **Availability (A)** | Every request receives a (non-error) response — but not necessarily the latest data |
| **Partition tolerance (P)** | The system keeps operating despite dropped/delayed messages between nodes |

> [!KEY]
> The common misstatement is "you can only have two of C, A, P, so pick your two." The correct statement: **partition tolerance is not optional** in any real distributed system — networks *will* drop packets — so the actual choice is what happens *during a partition*: return an error/stale-refusal (favor C) or return a possibly-stale answer (favor A). Outside of a partition, a well-built system can be both consistent and available.

```mermaid
flowchart TD
    P["Network partition occurs<br/>between node A and node B"] --> D{"A request arrives at node A"}
    D -->|"Favor Consistency"| C["Refuse or block the request<br/>until the partition heals"]
    D -->|"Favor Availability"| AV["Answer with the local (possibly stale) data"]
```

## PACELC — the more complete framing

PACELC extends CAP by also covering the **normal, no-partition case**, which CAP is silent on: **P**artition — trade off **A**vailability vs **C**onsistency; **E**lse (no partition) — trade off **L**atency vs **C**onsistency.

| System | During partition (PA/PC) | Else (EL/EC) |
|---|---|---|
| DynamoDB, Cassandra | **PA** — stays available, returns possibly stale data | **EL** — low latency, eventual consistency by default |
| MongoDB (majority writes), traditional RDBMS with sync replication | **PC** — refuses/blocks rather than risk stale data | **EC** — waits for replication, higher latency |
| Cosmos DB | Tunable per request | Tunable per request — the whole point of the 5-level dial |

> [!TIP]
> Mentioning PACELC instead of just CAP is a strong senior signal — it shows you know the interesting trade-off (latency vs consistency) actually happens *all the time*, not just during the relatively rare event of a partition.

## The consistency spectrum

Consistency is not binary. Real systems pick a point on a spectrum, and picking correctly for each *part* of a system (not the system as a whole) is the mark of a strong design.

| Model | Guarantee | Example use |
|---|---|---|
| **Linearizable / strong** | Every read sees the latest write, globally, as if there were one copy | Bank balance, inventory count, leader election |
| **Sequential** | All nodes see operations in the *same* order, not necessarily real-time order | Distributed logs, some replicated state machines |
| **Causal** | Operations that are causally related are seen in order everywhere; unrelated ones may reorder | Comment appears after the post it replies to |
| **Read-your-writes** | A user always sees their own writes, even if other users see them late | You see your own comment immediately after posting |
| **Monotonic reads** | Once you've seen a value, you never see an older one on a later read | Avoids a page "going back in time" on refresh |
| **Bounded staleness** | Reads lag writes by at most a configured time/version bound | Cosmos DB's bounded-staleness level |
| **Eventual** | Given no new writes, all replicas *eventually* converge | Social media like counts, DNS propagation |

> [!WARNING]
> "Eventual consistency" does not specify a bound on *how* eventual — it could be milliseconds or, in a network partition, much longer. If a design needs a bound, say "bounded staleness" or a specific SLA, not just "eventual".

## Quorum reads and writes

For leaderless/multi-replica systems, you tune consistency **per operation** using a quorum: with `N` replicas, `W` write acknowledgments required, and `R` read acknowledgments required, the classic rule is:

**`W + R > N` guarantees the read set and the write set overlap by at least one replica — so at least one node in any read quorum has seen the latest write.**

```mermaid
flowchart LR
    subgraph Cluster["N = 3 replicas"]
        R1["Replica 1"]
        R2["Replica 2"]
        R3["Replica 3"]
    end
    W["Write, W=2"] --> R1
    W --> R2
    Rd["Read, R=2"] --> R2
    Rd --> R3
```

| Configuration | Behavior | Trade-off |
|---|---|---|
| `W=1, R=N` | Write-optimized, fast writes | Slow, but strongly consistent reads |
| `W=N, R=1` | Read-optimized, fast reads | Slow writes; any replica down blocks writes |
| `W=R=⌈(N+1)/2⌉` *(balanced default)* | Majority for both | Tolerates minority failures either way |
| `W + R ≤ N` | Faster, but **no consistency guarantee** | Pure eventual consistency, tunable for speed |

This is exactly what Cosmos DB's five consistency levels and DynamoDB's "strongly consistent read" flag are doing under the hood — letting you dial `R` and `W` (or an equivalent) per request instead of fixing one system-wide guarantee.

## What "eventually consistent" means to a user

Concretely, and this is the answer that shows you've thought about the product, not just the theory: a user might post something and, on refresh a moment later, not see it reflected in an aggregate (like counts, follower counts) that lags behind, even though the write already succeeded. Whether that's acceptable depends entirely on the field — a "like count" lagging by a second is invisible to users; a "balance available for withdrawal" lagging by a second is a real bug.

## How to choose in an interview

Walk the interviewer through this decision per **field or workflow**, not for the system as a whole:

| Question to ask yourself | If yes → lean toward |
|---|---|
| Does a stale read cause real financial/safety harm? | Strong consistency |
| Is the field a counter/aggregate users don't compare in real time? | Eventual consistency |
| Does the *same user* need to see their own write immediately? | Read-your-writes (route to primary, or session token) |
| Do ordered events matter (comment after post) but absolute global order doesn't? | Causal consistency |
| Is latency or availability the primary product concern? | Favor availability, tune consistency down |

> [!DANGER]
> A common interview mistake: declaring "this whole system will be strongly consistent" for a design with a shopping cart, a payment ledger, and a "recently viewed" list all together. Different fields need different guarantees — the payment ledger might genuinely need strong consistency while "recently viewed" is happily eventual.

## Cheat sheet

- CAP: partition tolerance is **mandatory** in practice — the real choice is C vs A **only during a partition**.
- **PACELC** captures the trade-off that actually matters most of the time: latency vs consistency, even with no partition.
- The spectrum, strongest to weakest: **linearizable → sequential → causal → read-your-writes → monotonic reads → bounded staleness → eventual**.
- **Quorum rule: `W + R > N`** guarantees overlap between write and read sets — the basis of tunable consistency.
- "Eventual consistency" has **no built-in time bound** — say "bounded staleness" if you need one.
- Pick consistency **per field/workflow**, not for the whole system — a payment ledger and a like counter don't need the same guarantee.
- **Read-your-writes** is usually solved by routing a user's own reads to the primary or a session-pinned replica, not by making everything strongly consistent.

## Common mistakes

| Mistake | Fix |
|---|---|
| "CAP means pick two of three" | Partition tolerance isn't optional; the real choice is C vs A during a partition |
| Treating consistency as all-or-nothing for the whole system | Choose per field/workflow — most systems mix strong and eventual |
| Saying "eventually consistent" with no bound | Specify bounded staleness or an SLA if one is needed |
| Ignoring PACELC and only discussing the partition case | Mention the latency-vs-consistency trade-off during normal operation too |
| Assuming quorum systems are automatically strongly consistent | Only true if `W + R > N`; otherwise it's tunable, possibly weaker |
| Solving read-your-writes by making everything strongly consistent | Route that user's own reads to the primary or use session consistency |

## Summary

CAP theorem only forces a choice between consistency and availability during an actual network partition — partition tolerance itself is not optional in any real distributed system, so the useful conversation is about what happens when packets are dropped, and PACELC extends that conversation to the far more common case of trading latency for consistency even when the network is healthy. Consistency is a spectrum, not a switch, running from linearizable down to plain eventual, with read-your-writes, causal and bounded-staleness models solving specific real product needs in between. Quorum systems (`W + R > N`) let you tune where a given operation sits on that spectrum per request. The senior move is choosing the right point on the spectrum for each field or workflow in a design, not declaring the whole system strong or eventual.

## Top Interview Questions

### Q1. State the CAP theorem correctly, and explain the most common way people get it wrong.

CAP theorem says that during a network partition, a distributed data store must choose between consistency (every read reflects the latest write) and availability (every request gets a non-error response) — it cannot fully guarantee both while nodes can't communicate. The common misstatement is "you can only pick two of C, A, and P", implying partition tolerance is an optional design choice like the other two; in reality, any real distributed system spanning more than one machine over an unreliable network *will* experience partitions, so partition tolerance isn't something you opt out of — the actual decision is what your system does *during* a partition: refuse/error (favor consistency) or answer with potentially stale data (favor availability).

### Q2. What is PACELC and why does it matter more than CAP for most day-to-day design decisions?

PACELC extends CAP: if there's a **P**artition, choose **A**vailability or **C**onsistency (the CAP trade-off); **E**lse, when the network is healthy, choose **L**atency or **C**onsistency. This matters because partitions are relatively rare events, but the latency-versus-consistency trade-off is present on essentially every single request a distributed system serves — do you wait for a majority of replicas to acknowledge a write (higher latency, stronger consistency) or return as soon as one replica has it (lower latency, weaker consistency)? Naming PACELC shows you understand that the interesting trade-off in most systems' daily operation is this second one, not the partition scenario CAP focuses on.

### Q3. Walk through the consistency spectrum from strongest to weakest, with an example for each.

Linearizable/strong consistency means every read sees the most recent write as if there were a single copy of the data — used for bank balances or leader election, where staleness is unacceptable. Sequential consistency guarantees all nodes agree on one global order of operations, though not necessarily real-time order. Causal consistency preserves the order of operations that are causally related (a reply appears after the comment it replies to) while allowing unrelated operations to be seen in different orders on different nodes. Read-your-writes guarantees a user always sees their own writes immediately, even if others see them with delay. Monotonic reads guarantee you never see data "go backward" in time on successive reads. Bounded staleness caps how far behind a read can lag, in time or version count. Eventual consistency only guarantees convergence given no further writes, with no bound on how long that takes.

### Q4. Explain the quorum formula `W + R > N` and why it guarantees consistency.

With `N` total replicas, `W` is the number of replicas that must acknowledge a write before it's considered successful, and `R` is the number of replicas a read must query before returning a result. If `W + R > N`, the write set and any possible read set are guaranteed to overlap by at least one replica, because you can't select two disjoint subsets of size `W` and `R` from a set of size `N` if their sizes sum to more than `N`. That guaranteed overlap means at least one node in every read quorum has seen the most recent write, so the read is guaranteed to observe it (assuming appropriate versioning to pick the latest among the responses). If `W + R ≤ N`, no such overlap is guaranteed, and you've traded consistency for speed.

### Q5. Give a concrete example of what "eventual consistency" looks like from a user's point of view, and when it's acceptable versus not.

A user likes a post, and a moment later a friend on a different server refreshes the page and still sees the old like count for a second or two before it updates — the write succeeded, but the aggregate hadn't propagated yet. This is entirely acceptable for social counters, view counts, or search index freshness, because the cost of staleness is invisible or trivial to the user. It is not acceptable for something like "funds available for withdrawal" or "seats remaining for this flight," where a stale read can let a user take an action (spend money they don't have, book a seat that's gone) that the system then has to detect and unwind — those need strong consistency or, at minimum, a conditional write that re-validates at commit time.

### Q6. How would you solve "read-your-own-writes" in a system using asynchronous read replicas, without making the whole system strongly consistent?

Rather than upgrading every read in the system to strong consistency (expensive and usually unnecessary), route just the *acting user's own subsequent reads* to the primary (or a replica known to be caught up) for a short window after their write — often implemented via a "session consistency" token that records the last write's version/timestamp and requires any read serving that session to be at least that fresh. Everyone else's reads can continue to hit any replica under normal eventual consistency, since they don't have the same expectation of seeing that specific write immediately. This targeted fix — Cosmos DB's default "Session" consistency level works exactly this way — solves the actual user complaint ("I posted a comment and it disappeared when I refreshed") without paying the cost of strong consistency everywhere.

### Q7. A candidate says "I'll make my whole system strongly consistent to keep things simple." What's the problem with that answer, and how do you push back constructively?

Strong consistency across an entire system usually means routing all reads and writes through a single leader or waiting for majority acknowledgment on every operation, which caps throughput, adds latency to every request, and creates a single point of contention — often forcing the whole design's scalability to match its most consistency-sensitive field, even if 95% of the data (view counts, recommendations, activity feeds) doesn't need that guarantee. The constructive pushback is to ask "does every field in this design actually need that guarantee, or just the payment/inventory state?" and then show that different consistency levels for different data (strong for the ledger, eventual for the feed) gets you both correctness where it matters and scale where it doesn't.

### Q8. What does "bounded staleness" mean, and why might you choose it over strict eventual consistency?

Bounded staleness guarantees that a read lags behind the most recent write by at most a configured bound — either a number of versions (e.g. "no more than K writes behind") or a time window (e.g. "no more than 5 seconds stale") — giving you a predictable worst case rather than an open-ended "eventually." You'd choose it when plain eventual consistency's lack of any guarantee is operationally risky (you need to reason about how stale a dashboard or replicated cache can possibly be) but full strong consistency's latency and availability cost isn't justified. Cosmos DB exposes this as one of its five tunable consistency levels specifically for this middle ground.

### Q9. During a network partition, your primary database region can't reach its replicas in another region. What are your options, and what does each cost?

You can favor consistency by refusing writes (or serving only reads) in the isolated minority region until the partition heals, guaranteeing no data ever diverges but at the cost of an outage for users in that region — this is the "PC" choice. Alternatively, you can favor availability and continue accepting writes in both regions independently, which keeps the system responsive everywhere but risks conflicting writes that must be reconciled once the partition heals (last-write-wins, vector clocks, or application-level merge) — the "PA" choice. The right answer depends on the data: a social media post can tolerate eventual reconciliation; a bank transfer generally cannot, so many real systems apply PC to some data paths and PA to others within the same overall architecture.

### Q10. How do DynamoDB and Cosmos DB let you tune consistency per request rather than fixing it system-wide?

DynamoDB exposes a `ConsistentRead` flag per read request: set to true, the read is routed to guarantee it reflects the latest successful write (at some latency cost); left false (the default), it may read a replica that hasn't yet caught up, favoring lower latency. Cosmos DB goes further with five named consistency levels (Strong, Bounded Staleness, Session, Consistent Prefix, Eventual) that can be set at the account level as a default but overridden per individual request, effectively letting you pick a point on the whole spectrum, request by request, based on that specific read's needs. Both designs reflect the same underlying idea: consistency is a per-operation dial, tuned by adjusting how many replicas must participate (quorum `R`/`W`), not a single global property of the database.

### Q11. Why is "sequential consistency" different from "linearizable consistency," and does the distinction matter in interviews?

Linearizability requires that operations appear to take effect at some single instant between their invocation and completion, consistent with real (wall-clock) time — if operation A completes before operation B starts, every observer must see A before B. Sequential consistency only requires that *all* nodes agree on *some* single total order of operations, but that order doesn't have to respect real-time — an operation that started later could appear "before" one that started earlier, as long as everyone agrees on the same order. In practice, the distinction rarely needs to be litigated precisely in an interview, but knowing it exists lets you correctly describe systems (some replicated logs, some in-memory data structures) that offer a consistent global order without paying for real-time linearizability, which is a meaningfully cheaper guarantee to implement.

### Q12. How would you design consistency for an e-commerce checkout flow that touches inventory, cart, and order history?

Inventory decrement needs strong consistency (or at least a conditional/optimistic write with a quorum guarantee) because overselling a limited-stock item is a real business problem, not a cosmetic one — this is the field where `W + R > N` or a single-writer primary matters most. The shopping cart itself can tolerate read-your-writes consistency rather than global strong consistency — the user needs to see their own cart updates immediately, but it's fine if a cart replica in another region briefly shows a stale count, since only the owning user interacts with it. Order history, once an order is placed, can be eventually consistent from the user's perspective — a slight propagation delay before an order appears in a "past orders" list causes no real harm. This mix — strong for inventory, session/read-your-writes for the cart, eventual for history — is a realistic answer that shows per-field reasoning rather than one blanket consistency choice for the whole checkout system.
