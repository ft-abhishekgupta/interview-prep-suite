---
title: Replication
description: How single-leader, multi-leader and leaderless replication trade off consistency, availability and conflict handling, and how failover can go wrong
difficulty: Core
tags: [replication, databases, failover, consistency, read-replicas]
---

Replication means keeping copies of the same data on multiple machines, and it is the foundation almost every other scaling and reliability technique builds on — read replicas, failover, geo-distribution, and disaster recovery all start here. The interview conversation is really about which of three topologies you pick, and what breaks when the network between replicas misbehaves.

## The three topologies

```mermaid
flowchart LR
    subgraph SL["Single-leader"]
        L1["Leader"] --> F1["Follower"]
        L1 --> F2["Follower"]
    end
```

```mermaid
flowchart LR
    subgraph ML["Multi-leader"]
        LA["Leader A<br/>Region 1"] <--> LB["Leader B<br/>Region 2"]
    end
```

```mermaid
flowchart LR
    subgraph LL["Leaderless"]
        N1["Node 1"] <--> N2["Node 2"]
        N2 <--> N3["Node 3"]
        N1 <--> N3
    end
```

| Topology | Writes go to | Reads scale via | Conflict handling needed | Example |
|---|---|---|---|---|
| **Single-leader** *(default)* | One primary | Followers (replicas) | No — one writer, no conflicts | PostgreSQL, MySQL, MongoDB (replica set) |
| **Multi-leader** | Any of several leaders | All leaders | Yes — concurrent writes to the same key can conflict | Multi-region active-active setups, CouchDB |
| **Leaderless** | Any node (quorum-based) | Any node | Yes — via versioning/quorum reconciliation | DynamoDB, Cassandra, Riak |

> [!KEY]
> The number of leaders is the whole decision. One leader means no write conflicts but a single point of write scaling and failover complexity. More than one leader means writes scale and survive a region going down, but you now must resolve conflicting writes to the same key — there is no free lunch.

## Synchronous vs asynchronous vs semi-synchronous

Independent of topology, each replication link has its own durability/latency dial.

| Mode | Leader waits for | Data loss risk (RPO) | Latency cost |
|---|---|---|---|
| **Synchronous** | At least one follower to confirm before acknowledging the write | None, for that follower | Write latency includes the round trip to the follower |
| **Asynchronous** *(most common default)* | Nothing — acknowledges immediately, replicates in the background | A crashed leader can lose unreplicated writes | Fastest writes |
| **Semi-synchronous** | One follower synchronously, the rest asynchronously | Bounded — at least one up-to-date copy always exists | Middle ground |

> [!TIP]
> Say this: *"I'd run semi-synchronous — one synchronous follower guarantees at least one durable copy for failover, while the rest replicate async so I don't pay full multi-node latency on every write."* This is what many managed databases do by default (e.g. a "durable" replica plus additional read replicas).

## Replication lag and read-your-own-writes

Asynchronous replication means a follower can be milliseconds (or, under load, seconds) behind the leader. The most common user-visible symptom: a user writes something, then immediately reads it back from a lagging replica and doesn't see it.

```mermaid
sequenceDiagram
    participant U as "User"
    participant L as "Leader"
    participant F as "Follower (lagging)"
    U->>L: "write: update profile"
    L-->>U: "ack"
    U->>F: "read: get profile (routed to replica)"
    F-->>U: "stale data — replication hasn't caught up yet"
```

Fixes: route a user's own subsequent reads to the **leader** for a short window (or use a **session token** carrying the write's version, and require the serving replica to be at least that fresh), rather than making every read strongly consistent.

## Failover and split brain

When a leader fails, the system must promote a follower — automatically (most managed databases) or manually. This is riskier than it sounds.

| Step | Risk |
|---|---|
| Detect the leader is actually down | A slow leader can look "down" during a network blip and trigger an unnecessary failover |
| Pick the most up-to-date follower | Picking a lagging follower loses the writes the old leader had but hadn't replicated |
| Promote it, redirect clients | Old leader can come back online and **still think it's the leader** — split brain |

**Split brain** — two nodes both accepting writes as "the leader" simultaneously — is the classic failure mode, and it's why failover systems use **fencing** (the old leader is explicitly told, or forced via a fencing token/STONITH, to stop accepting writes) and require a **quorum/consensus** decision (a majority of nodes must agree on who the new leader is) rather than each node deciding unilaterally.

> [!DANGER]
> "Just promote a follower automatically on any failure" without fencing is how you get two leaders accepting conflicting writes simultaneously. Always pair automatic failover with a mechanism that guarantees the old leader stops, not just that a new one starts.

## What gets replicated: log vs statement vs row

| Method | What's shipped | Pros | Cons |
|---|---|---|---|
| **Statement-based** | The SQL statement itself (`UPDATE ... WHERE ...`) | Compact | Non-deterministic functions (`NOW()`, `RAND()`) replay differently on each replica |
| **Write-ahead log (WAL) shipping** *(common default)* | The database's own low-level log of disk changes | Exact, byte-for-byte consistent | Tightly coupled to storage engine version |
| **Row-based (logical) replication** | The actual before/after row values that changed | Deterministic, portable across versions, enables CDC | Larger payload than statement-based |

Row-based/logical replication is also the basis for **change data capture (CDC)** — reading the replication stream to feed a search index, cache, or downstream service, rather than a second follower database.

## Conflict resolution (multi-leader and leaderless)

Whenever more than one node can accept a write to the same key, you need a strategy for what happens when two writes to the same key arrive at different nodes before either has propagated.

| Strategy | Idea | Trade-off |
|---|---|---|
| **Last-write-wins (LWW)** | Attach a timestamp; the highest timestamp wins | Simple, but **silently discards** the losing write; clock skew can pick the wrong "latest" |
| **Vector clocks** | Track causal history per replica to detect true concurrency vs one write causally following another | Correctly *detects* conflicts; doesn't resolve them — the app still has to merge |
| **CRDTs** (Conflict-free Replicated Data Types) | Data structures mathematically designed to merge without conflict (counters, sets, sequences) | No app-level merge logic needed, but limited to specific data shapes |
| **Application-level merge** | Present both versions to the app (or user) and merge explicitly | Correct for the domain, but requires bespoke logic per case |

> [!WARNING]
> Last-write-wins is the easiest to implement and the easiest to get silently wrong: if two users edit the same document offline and reconnect, LWW just throws one edit away with no warning. Mention this trade-off explicitly if you propose LWW.

## Read replicas for scale

Even single-leader replication, the simplest topology, is worth deploying purely to **scale reads**: writes still go to the one leader, but reads can be spread across many followers, multiplying read capacity without touching the write path at all. This is usually the very first scaling move after caching, precisely because it requires no application redesign — only a decision about which reads can tolerate replication lag and which must go to the leader.

## Cheat sheet

- **Single-leader**: no write conflicts, but one write bottleneck and a failover story to get right — the default choice.
- **Multi-leader**: writes scale and survive a region outage, but you now need conflict resolution.
- **Leaderless (quorum-based)**: any node can serve reads/writes; consistency is tuned via `W + R > N`.
- **Sync** replication = no data loss, higher latency. **Async** = fast, but `RPO > 0`. **Semi-sync** is a common middle ground.
- **Replication lag** breaks read-your-own-writes — fix by routing that user's reads to the leader, not by making everything synchronous.
- **Split brain** happens when a recovered old leader still thinks it's in charge — always pair failover with **fencing** and a **quorum** decision.
- **Row-based/logical replication** enables CDC; statement-based replication can replay non-deterministically.
- **LWW is simple but silently drops data**; vector clocks detect conflicts but don't resolve them; CRDTs merge automatically for specific data shapes.
- **Read replicas are usually the first scaling move** after caching — no application redesign required for reads that can tolerate lag.

## Common mistakes

| Mistake | Fix |
|---|---|
| Assuming replication always means zero data loss | Only true for synchronous replication; async has `RPO > 0` |
| Automatic failover with no fencing of the old leader | Force the old leader to stop (fencing/STONITH) before promoting a new one |
| Fixing read-your-own-writes by making all reads synchronous | Route only that user's own reads to the leader, or use a session/version token |
| Choosing last-write-wins without acknowledging data loss | State explicitly that LWW silently discards the losing concurrent write |
| Treating multi-leader/leaderless as a free scaling win | Conflict resolution is mandatory the moment more than one node can write the same key |
| Using statement-based replication with non-deterministic SQL | Prefer row-based/logical replication for determinism and CDC compatibility |

## Summary

Replication is the base layer for scaling reads, surviving failures, and going multi-region, and the topology choice — single-leader, multi-leader, or leaderless — determines whether you get conflict-free simplicity or write scalability at the price of conflict resolution. Independent of topology, the sync/async dial trades latency against data-loss risk, replication lag creates the read-your-own-writes problem that's best solved by routing, and failover must be paired with fencing to avoid split brain when a recovered leader still believes it's in charge. Multi-leader and leaderless systems additionally need an explicit conflict resolution strategy — LWW, vector clocks, CRDTs, or application merge — because concurrent writes to the same key are a certainty, not an edge case, once more than one node can accept them.

## Top Interview Questions

### Q1. Compare single-leader, multi-leader and leaderless replication, and explain when you'd choose each.

Single-leader routes all writes through one primary and fans reads out to followers — it's the simplest model because there's exactly one writer, so no conflicting writes are possible, and it's the right default for most systems. Multi-leader allows writes at more than one node (typically one leader per region for a multi-region active-active setup), which improves write availability and latency across regions but requires conflict resolution since two leaders can accept writes to the same key concurrently. Leaderless (Dynamo-style) lets any node accept reads or writes and relies on quorum overlap (`W + R > N`) for consistency, which maximizes availability and write throughput at the cost of needing the client or coordinator to reconcile divergent replica states. Choose single-leader by default, multi-leader when you need low-latency writes in multiple regions and can tolerate conflict resolution, and leaderless when you need extreme write availability and can design around eventual consistency.

### Q2. What is the difference between synchronous, asynchronous, and semi-synchronous replication?

Synchronous replication means the leader waits for at least one follower to confirm receipt of the write before acknowledging it to the client, guaranteeing zero data loss for that follower's copy at the cost of added write latency (the round trip to the follower). Asynchronous replication acknowledges the write immediately and replicates in the background, giving the fastest writes but risking data loss if the leader crashes before the write reaches any follower — a non-zero recovery point objective (RPO). Semi-synchronous is the common middle ground: one follower is updated synchronously (guaranteeing at least one durable, up-to-date copy exists for failover) while the remaining followers replicate asynchronously, balancing durability against latency.

### Q3. A user updates their profile and immediately can't see the change on the next page load. What's happening and how do you fix it?

This is classic replication lag breaking read-your-own-writes: the write went to the leader and was acknowledged, but the subsequent read was routed to a follower that hasn't yet caught up asynchronously. The fix is not to make every read strongly consistent — that would tank read throughput system-wide — but to specifically route that user's own reads to the leader (or a replica known to be at least as fresh as their last write) for a short window after they write, often implemented via a session token carrying the write's version or timestamp that the serving node must satisfy before answering.

### Q4. What is split brain, and how do you prevent it during failover?

Split brain occurs when a leader fails, a follower is promoted to take over, but the original leader later recovers from what was actually a transient network issue (not a true crash) and continues believing it's still the leader — now two nodes are simultaneously accepting writes, which can silently diverge the data. Preventing it requires two things together: a quorum/consensus-based decision about who the new leader is (so a minority partition can't unilaterally promote itself), and explicit fencing of the old leader — forcing it to stop accepting writes (via a fencing token checked by clients/storage, or a hard mechanism like STONITH — "shoot the other node in the head") before the new leader is trusted. Automatic failover without fencing is a common, serious production risk.

### Q5. Why would you choose asynchronous replication for read replicas but semi-synchronous for the primary failover follower?

Read replicas exist purely to scale read throughput, and if one falls slightly behind, the cost is at worst a stale read on a request that can tolerate it — async keeps write latency low since the leader isn't waiting on every replica. The follower designated as the failover target, however, needs a durability guarantee: if the leader crashes, you want confidence that this specific follower has every acknowledged write, which requires it to be updated synchronously (or semi-synchronously) so no committed write can be lost on failover. This split — one durable follower, many fast async followers — gets you both safety and read scale without paying full multi-node synchronous latency on every write.

### Q6. Explain the difference between statement-based, log-shipping (WAL), and row-based replication.

Statement-based replication ships the actual SQL statement to followers, which is compact but breaks down for non-deterministic statements — `UPDATE ... SET updated_at = NOW()` or anything using `RAND()` can produce different results when replayed on a follower at a slightly different time. Write-ahead log (WAL) shipping replicates the database's own low-level record of physical disk changes, which is exact and byte-for-byte consistent but tightly couples replication to the same storage engine and version on both sides. Row-based (logical) replication ships the actual before/after values of changed rows, which is deterministic, portable across engine versions, and — importantly — is what powers change data capture (CDC), letting you feed a search index or cache from the same stream used for replication.

### Q7. What's the difference between last-write-wins, vector clocks, and CRDTs for resolving replication conflicts?

Last-write-wins attaches a timestamp to each write and keeps whichever has the latest one on conflict — simple to implement, but it silently and permanently discards the losing write, and clock skew between nodes can make "latest" pick the wrong one. Vector clocks track causal history per replica so the system can correctly *detect* whether two writes were truly concurrent (a real conflict) versus one causally following the other (no conflict) — but detecting a conflict isn't resolving it, so the application still needs logic to merge or choose between concurrent versions once flagged. CRDTs (Conflict-free Replicated Data Types) are data structures — counters, sets, certain sequence types — mathematically designed so that any two divergent replicas can be merged automatically without conflict or data loss, eliminating the need for application-level merge logic, but only for the specific data shapes they support.

### Q8. Why are read replicas usually the first thing you add when a single database can't handle read load, before considering sharding?

Adding a read replica requires no change to how data is modeled or partitioned — writes continue to go to the same single leader exactly as before, and you simply point some fraction of read traffic at one or more followers instead, multiplying read capacity with a comparatively small operational change. Sharding, in contrast, requires choosing a shard key, handling cross-shard queries, and often significant application changes — it's a much larger undertaking reserved for when write volume (not just read volume) genuinely exceeds what a single primary can handle. The order — cache, then read replicas, then sharding — reflects increasing implementation cost and should be walked through explicitly to show you don't reach for the heaviest tool first.

### Q9. In a multi-leader setup across two regions, both regions update the same customer record within the same second, offline from each other. What actually happens, and what would you tell the interviewer you'd do about it?

Each regional leader accepts its local write immediately (that's the point of multi-leader — low local write latency) and asynchronously propagates it to the other region; when the two writes cross, the replication layer detects that the same record was modified concurrently by both leaders and must apply a conflict resolution strategy. The honest answer names the trade-off: last-write-wins is simplest but could silently drop one region's legitimate update; if the field is something mergeable (e.g. a set of tags), a CRDT avoids the conflict entirely; if it's a structured record needing business judgment (e.g. conflicting address updates), the safest approach is flagging it for application-level merge or, in high-stakes cases, avoiding multi-leader writes for that specific record type altogether and routing it through a single leader.

### Q10. How would you decide between single-leader and multi-leader replication for a global chat application?

The deciding factor is where the write-heavy, latency-sensitive traffic actually happens: if most conversations are effectively local to a region (users chatting with others in the same region), multi-leader lets each region write locally with low latency and only needs conflict resolution for the comparatively rare cross-region conversation. If instead most conversations span regions symmetrically, the added complexity of conflict resolution buys less benefit, and a single-leader design with read replicas per region (accepting the extra write latency of a round trip to one primary region) might be simpler to reason about and operate. In practice, most chat systems partition conversations by a key (like conversation ID) and can make this decision per-partition rather than globally, which is worth mentioning as the more nuanced, production-realistic answer.

### Q11. What would you monitor to catch a dangerous level of replication lag before it causes user-facing problems?

Track the lag itself directly — most databases expose a metric like seconds-behind-leader or a log sequence number gap between the leader and each follower — and alert when it exceeds a threshold tied to your product's tolerance (e.g. a few seconds for read-your-own-writes-sensitive features, longer for pure analytics replicas). Also watch for the downstream symptoms: a spike in "read your own write" failures reported by the application layer, or growing divergence between what's served from replicas versus the leader on the same query. In production, replication lag commonly spikes during large batch writes, schema migrations, or a follower under CPU/IO pressure, so correlating lag alerts with deploy and batch-job timing helps distinguish a systemic issue from a transient one.

### Q12. A follower has been offline for six hours and just reconnected. Walk through what needs to happen for it to safely rejoin as a replica.

The follower needs to catch up on everything it missed while disconnected — if the leader's write-ahead log (or replication log) still retains all changes since the follower went offline, it can simply resume streaming from its last known position and replay forward until caught up. If the leader has already discarded log entries older than the follower's last known position (common if retention is shorter than six hours), the follower can't resume incrementally and must instead be rebuilt from a fresh full snapshot of the leader's current state before resuming streaming replication from that snapshot's position. Until it's fully caught up, the follower should not be eligible to serve reads that need freshness guarantees, and it should definitely not be a candidate for promotion during this window — both of which a production system should enforce automatically, not rely on an operator remembering.
