---
title: Sharding and Partitioning
description: How to split data across many databases without creating hot spots, how to reshard without downtime, and why unique IDs get hard once you shard
difficulty: Advanced
tags: [sharding, partitioning, consistent-hashing, distributed-systems, scalability]
---

Sharding is what you reach for once a single database genuinely cannot hold or serve your data, and it is one of the highest-stakes decisions in a system design interview because the shard key choice is nearly impossible to change later without a painful migration. This page covers picking a key, the four partitioning strategies, and the problems sharding introduces that a single database never had.

## Vertical vs horizontal partitioning

| | Vertical partitioning | Horizontal partitioning (sharding) |
|---|---|---|
| **Splits by** | Columns/tables | Rows |
| **Example** | User profile table on one DB, user activity logs on another | Users A–M on shard 1, N–Z on shard 2 |
| **Solves** | One table/feature is a hotspot; isolate it | One table is too big/busy for any single machine |
| **Cross-shard complexity** | Low — different tables, different concerns | High — same logical table split across machines |

> [!KEY]
> "Sharding" specifically means horizontal partitioning — splitting rows of the *same* logical table across multiple machines. Vertical partitioning (splitting by table/column) is a different, usually simpler, technique and often the first thing to try before sharding.

## Choosing a shard key — the most important decision

Everything else in this topic is secondary to this choice, because resharding after data has grown is expensive and risky.

| Property | Why it matters | Bad example | Good example |
|---|---|---|---|
| **High cardinality** | Enough distinct values to spread across many shards | `country` (a few hundred values) | `userId`, `orderId` |
| **Even distribution** | No single value dominates the dataset | `status` (most rows are "active") | A well-distributed hash of an ID |
| **Matches the query pattern** | Most queries should hit one shard, not fan out | Sharding by `createdAt` when queries filter by `userId` | Shard by the field most WHERE clauses filter on |

Hashing a high-cardinality key like `userId` spreads writes evenly across shards; sharding by a low-cardinality field like `country` piles almost all the traffic onto whichever shard holds the largest country, while others sit nearly empty:

![Hashing user ID spreading writes evenly across three shards, compared with sharding by country overloading the China shard while New Zealand's sits nearly empty](notes/05-HighLevelDesign/SystemDesign/image-9.png)

> [!TIP]
> Say this out loud: *"I'd shard by `userId` because it's high-cardinality, evenly distributed, and it's the field nearly every query already filters by — so most reads stay on one shard."* Naming all three properties, not just one, is what separates a strong answer.

## Range, hash, directory-based and consistent hashing

```mermaid
flowchart TD
    K["Shard key"] --> S{"Strategy"}
    S -->|"Range"| R["Sorted ranges<br/>A-F, G-M, N-Z"]
    S -->|"Hash"| H["hash(key) % N"]
    S -->|"Consistent hashing"| C["hash(key) on a ring"]
    S -->|"Directory"| D["Lookup service<br/>key to shard"]
```

| Strategy | How | Pros | Cons |
|---|---|---|---|
| **Range** | Contiguous key ranges assigned to shards | Efficient range queries, simple | Hot shards if data/access is skewed (e.g. timestamps — all recent writes hit the newest shard) |
| **Hash** | `hash(key) % N` decides the shard | Even distribution if hash is good | Changing `N` remaps **almost every key** — a full data migration |
| **Consistent hashing** *(default at scale)* | Hash both shards and keys onto a ring; a key belongs to the next shard clockwise | Adding/removing a shard only remaps keys **between it and its neighbor** | Needs a good hash function; uneven load without virtual nodes |
| **Directory-based** | A lookup service maps each key (or key range) to a shard | Maximum flexibility, easy rebalancing | Extra network hop; the directory service is a new SPOF/bottleneck |

> [!WARNING]
> Plain hash sharding (`hash(key) % N`) is a trap many candidates fall into: it distributes evenly *today*, but adding a single shard changes `N` and remaps nearly every key, forcing a near-total data migration. Consistent hashing exists specifically to avoid this.

## Consistent hashing in detail

```mermaid
flowchart LR
    R(("Hash ring"))
    S1["Shard A<br/>hash=10"] -.-> R
    S2["Shard B<br/>hash=90"] -.-> R
    S3["Shard C<br/>hash=200"] -.-> R
    K1["key1, hash=15"] -->|"next clockwise"| S2
    K2["key2, hash=95"] -->|"next clockwise"| S3
```

Shards and keys are both hashed onto the same circular space (e.g. 0 to 2³²−1). A key is owned by the **first shard found moving clockwise** from the key's position. Adding a new shard only steals the keys between it and its predecessor on the ring — every other assignment is untouched, which is the entire point.

**Virtual nodes**: mapping each physical shard to *multiple* points on the ring (not just one) evens out load, because a single unlucky hash placement for one physical shard would otherwise give it a disproportionate share of the ring. This is how Cassandra, DynamoDB and most CDNs actually implement it in practice.

## Hot partitions — detecting and fixing them

A hot partition (or hot shard) is one shard receiving disproportionate traffic — a celebrity's posts, a viral product, a popular timestamp bucket — which becomes a bottleneck even though every *other* shard is fine.

| Detection signal | Fix |
|---|---|
| One shard's CPU/latency/queue depth far exceeds peers | Give the hot key its **own dedicated shard** |
| A specific key dominates a shard's traffic | **Salt/suffix the key** (`key#1`..`key#N`) and fan out, re-aggregating on read |
| A range shard receives all new writes (timestamp keys) | Switch to hash or consistent hashing for that dimension, or add a random prefix |

> [!DANGER]
> A hot partition doesn't show up in aggregate cluster metrics — average CPU across 50 shards looks fine while one shard is pegged at 100%. Always monitor **per-shard**, not just cluster-wide averages, or you will miss this until users complain.

## Resharding and rebalancing without downtime

Adding shards or fixing an uneven distribution while the system stays live is one of the hardest operational problems in this space.

```mermaid
sequenceDiagram
    participant OLD as "Old shard set"
    participant NEW as "New shard set"
    participant APP as "Application"
    APP->>OLD: "reads and writes, normal"
    APP->>NEW: "dual write begins"
    NEW->>OLD: "backfill historical data"
    APP->>APP: "verify NEW matches OLD"
    APP->>NEW: "cut over reads"
    APP->>OLD: "stop writing, decommission"
```

The pattern is always the same shape: **dual-write** to old and new, **backfill** history into the new layout, **verify** consistency, then **cut over** reads and finally stop writing to the old set. This is exactly why consistent hashing is preferred operationally — it minimizes how much data this whole dance has to move.

## Cross-shard queries and joins

The moment data is split across shards, two things that were free on a single database become expensive:

| Operation | Single DB | Sharded |
|---|---|---|
| Join across entities | One query | **Scatter-gather**: query every shard, join in the application |
| `ORDER BY` / aggregate across all data | One query | Query every shard, merge-sort/aggregate in the application |
| Unique constraint across the whole dataset | Native | Requires a separate global lookup (e.g. a reservation table) |

The fix is almost always to **shape the schema and shard key around the query pattern** so common queries hit exactly one shard, and to accept that rare cross-shard queries (reporting, admin search) either fan out and merge, or run against a separately-maintained analytics store (a data warehouse) instead of the live sharded OLTP database.

## Distributed transactions across shards

An operation that must atomically update rows on two different shards (e.g. "move funds from an account on shard 1 to an account on shard 2") no longer has a single database's ACID guarantee to lean on.

| Approach | How | Trade-off |
|---|---|---|
| **Two-phase commit (2PC)** | A coordinator asks all shards to "prepare", then "commit" only if all agree | Strong atomicity, but **blocking** — a stalled participant blocks everyone, and the coordinator is a SPOF |
| **Saga pattern** *(preferred at scale)* | A sequence of local transactions, each with a **compensating action** to undo it on failure | No blocking, scales well, but only **eventually** consistent, and compensations must be idempotent |

> [!TIP]
> The senior answer to "how do you move money between shards" is almost always the saga pattern: debit shard A, then credit shard B; if the credit fails, run a compensating "refund" on shard A. Naming 2PC and immediately explaining why you'd avoid it at scale (blocking, coordinator SPOF) is a strong signal.

## The ID generation problem

Once data is sharded, a single database's auto-increment counter no longer works — two shards would both hand out ID `1001`. This forces a distributed unique ID strategy.

| Method | Sortable | Coordination | Notes |
|---|---|---|---|
| **UUID v4** | ❌ | None | Simple, but random inserts hurt B-tree index locality |
| **UUID v7 / ULID** | ✅ | None | Timestamp-prefixed + random — modern default, index-friendly |
| **Snowflake (Twitter)** | ✅ | Machine/shard ID only | 64-bit: `41-bit timestamp + 10-bit machine id + 12-bit sequence` ≈ 4096 IDs/ms/node |
| **Ticket server / range allocation** | ✅ | Occasional | Each shard reserves a block of IDs (e.g. 1,000) and hands them out locally |

> [!KEY]
> Snowflake-style IDs are the standard interview answer because they're generated **locally with no coordination** (each node just needs its own machine ID and a clock), are roughly **time-sortable** (useful for pagination and indexing), and embed enough entropy to avoid collisions across a large fleet of shards.

## Cheat sheet

- **Sharding = horizontal partitioning** — splitting rows of the same table across machines. Vertical partitioning (by table/column) is different and often tried first.
- **Shard key choice is the most important decision** — high cardinality, even distribution, and it must match the query pattern.
- **Hash sharding remaps almost everything when N changes; consistent hashing only remaps a small neighborhood** — use consistent hashing at scale.
- Use **virtual nodes** with consistent hashing to smooth out uneven load from unlucky hash placements.
- **Monitor per-shard**, not cluster-wide averages, or hot partitions hide in plain sight.
- **Resharding pattern**: dual-write → backfill → verify → cut over → decommission old.
- **Cross-shard joins/queries become scatter-gather** — shape the shard key around your dominant query pattern to avoid them.
- **Distributed transactions across shards**: prefer the **saga pattern** (compensating actions) over 2PC (blocking, coordinator SPOF) at scale.
- **Auto-increment breaks once sharded** — use Snowflake-style or UUID v7/ULID IDs instead.

## Common mistakes

| Mistake | Fix |
|---|---|
| Sharding by timestamp or auto-increment ID | Choose a key with high cardinality that matches queries (e.g. `userId`) |
| Plain `hash(key) % N` sharding | Use consistent hashing so adding shards doesn't remap everything |
| Monitoring only cluster-wide average load | Monitor per-shard metrics to catch hot partitions |
| Sharding "because the data is big" | Shard only when a single DB genuinely can't handle the load — shard by query pattern, not volume |
| Using 2PC for cross-shard writes at scale | Prefer the saga pattern with idempotent compensating actions |
| Relying on DB auto-increment for IDs after sharding | Use Snowflake-style IDs, UUID v7, or ULIDs |
| Treating resharding as a one-shot cutover | Dual-write, backfill, verify, then cut over — never migrate blind |

## Summary

Sharding solves the problem a single database eventually hits — too much data or too much write throughput for one machine — by splitting rows across many machines, but the shard key choice is the single highest-leverage (and hardest to reverse) decision in the whole design. Consistent hashing is preferred over plain modulo hashing specifically because it minimizes data movement when shards are added or removed, and per-shard monitoring is essential because hot partitions hide behind healthy cluster-wide averages. Sharding also introduces problems a single database never had — expensive cross-shard joins, no free distributed transactions, and no working auto-increment — each with its own accepted pattern: shape queries to avoid fan-out, prefer sagas over 2PC, and generate IDs with a scheme like Snowflake that needs no central coordination.

## Top Interview Questions

### Q1. What makes a good shard key, and why is timestamp usually a bad choice?

A good shard key has high cardinality (many distinct values so it can spread across many shards), even distribution (no single value dominates the data), and alignment with the dominant query pattern (most queries should be satisfiable from one shard). Timestamp fails on distribution and, more importantly, creates a severe hot spot: if you range-shard by time, every new write goes to whichever shard owns the current time range, meaning the "newest" shard absorbs 100% of write traffic while older shards sit idle — the opposite of what sharding is supposed to achieve. `userId` or `orderId` are the standard good examples because real-world access is naturally spread across many users/orders.

### Q2. Explain consistent hashing and why it's preferred over `hash(key) % N`.

With plain hash sharding, a key's shard is `hash(key) % N`; the moment you add or remove a shard, `N` changes, and because the modulo operation depends on the exact value of `N`, nearly every key's assigned shard changes too, forcing a near-total data migration just to add one machine. Consistent hashing instead places both shards and keys onto the same circular hash space, with each key owned by the next shard found moving clockwise from its position; adding a shard only reassigns the keys that fall between the new shard and its immediate predecessor on the ring, leaving every other key's assignment untouched. This dramatically reduces the data movement cost of scaling the cluster, which is why it's the default strategy in systems like Cassandra, DynamoDB, and most CDNs.

### Q3. What are virtual nodes in consistent hashing, and what problem do they solve?

With a naive consistent hashing setup, each physical shard maps to exactly one point on the ring, and if a shard's hash happens to land in a way that gives it a disproportionately large or small arc of the ring, it ends up over- or under-loaded purely by chance of the hash function, regardless of how "good" the hash is on average. Virtual nodes fix this by mapping each physical shard to many points scattered around the ring (dozens to hundreds), so each shard's *total* share of key space is the sum of many small, independently-distributed arcs, which averages out much closer to an even split across all shards. This also makes rebalancing smoother when a shard is added or removed, since its virtual nodes are scattered rather than concentrated.

### Q4. How do you detect and fix a hot partition in production?

Detection requires monitoring per-shard metrics — CPU, request latency, queue depth — rather than cluster-wide averages, because a single overloaded shard can be invisible in an aggregate view while the rest of the cluster looks healthy. Once identified, the fix depends on the cause: if one specific key (a viral post, a celebrity account) dominates a shard's traffic, salt the key with a suffix (`key#1` through `key#N`), spread writes across those suffixes, and re-aggregate on read; if an entire shard is structurally hot due to the sharding strategy (e.g. a timestamp-based range shard always receiving the newest writes), switch to hash-based or consistent-hash sharding for that dimension, or give the specific hot key its own dedicated shard.

### Q5. Walk through how you'd reshard a live system from 4 shards to 8 without downtime.

Start by dual-writing every new write to both the old 4-shard layout and the new 8-shard layout, so no new data is missed during the migration. Then run a backfill process that copies historical data from the old shards into their correct new-shard locations according to the new hashing scheme, ideally using consistent hashing so this backfill only needs to move roughly half the data rather than nearly everything. After backfilling, run a verification pass comparing data (or checksums) between old and new layouts to catch discrepancies before committing to the cutover. Finally, switch reads over to the new 8-shard layout, monitor for correctness and performance, and only then stop writing to and decommission the old 4-shard layout.

### Q6. Why do cross-shard joins become expensive, and how do you avoid needing them?

A join across sharded data can no longer happen inside the database engine in a single query, because the related rows may live on entirely different physical machines; instead the application (or a query router) must fan a request out to every shard that might hold relevant rows (scatter-gather), collect the partial results, and join or merge them in application code — which is slower, more complex, and doesn't benefit from the database's own query optimizer. The way to avoid this is to choose a shard key that keeps commonly-joined data together — for example, sharding both `orders` and `order_items` by the same `userId` so a user's orders and their line items always land on the same shard — so the majority of real-world queries never need to cross shard boundaries in the first place.

### Q7. How do you handle a transaction that needs to atomically update data on two different shards?

A single database's ACID transaction guarantee doesn't extend across shard boundaries, so you need an explicit strategy. Two-phase commit (2PC) has a coordinator ask all involved shards to "prepare" the change, then instructs them all to "commit" only if every shard agreed — this gives strong atomicity but is blocking (a slow or crashed participant stalls everyone) and introduces the coordinator as a new single point of failure, so it's rarely used at scale. The saga pattern instead runs a sequence of local transactions, one per shard, each paired with a compensating action that can undo it if a later step fails — debit shard A, then credit shard B, and if the credit fails, run a compensating refund against shard A — trading strict atomicity for eventual consistency and much better scalability, which is why it's the preferred pattern in most modern sharded systems.

### Q8. Why does a database's auto-increment ID stop working once you shard, and what would you replace it with?

Auto-increment relies on a single, centralized counter that only makes sense within one database instance; once data is split across multiple independent shards, each shard would generate its own sequence starting from 1, so two different rows on two different shards could easily end up with the same ID, breaking uniqueness across the whole dataset. The standard replacement is a scheme that generates unique IDs without central coordination — Snowflake-style IDs encode a timestamp, a machine/shard identifier, and a per-millisecond sequence number into a single 64-bit integer, giving you roughly time-sortable, globally unique IDs generated entirely locally on each node; UUID v7 or ULID are simpler alternatives with similar timestamp-prefixed properties.

### Q9. What's the difference between vertical partitioning and sharding (horizontal partitioning), and when would you use vertical partitioning instead?

Vertical partitioning splits a schema by table or column — for example, moving a rarely-queried, large `user_activity_log` table onto its own database, separate from the frequently-queried `users` table — without changing how any single table's rows are distributed. Sharding (horizontal partitioning) splits the *rows* of the same logical table across multiple machines, which is a much bigger operational undertaking involving a shard key, routing logic, and all the cross-shard problems that come with it. Vertical partitioning is usually tried first because it's simpler and can relieve significant pressure — isolating a hot or oversized table from the rest of the schema — before committing to the complexity of full horizontal sharding.

### Q10. A directory-based sharding scheme's lookup service goes down. What's the blast radius, and how would you mitigate it?

Every request that needs to resolve a key to its shard now fails or stalls, because the directory service sits on the critical path for essentially all reads and writes — this is exactly the "extra hop, potential SPOF" trade-off directory-based sharding is known for. Mitigation follows the standard playbook for any critical lookup service: run it as a highly available, replicated cluster rather than a single instance; cache the key-to-shard mapping aggressively on the calling services (mappings change rarely, so a short-TTL or event-invalidated cache absorbs the vast majority of lookups without hitting the directory service at all); and design clients to fail gracefully (serve from cache, queue writes) rather than hard-failing the moment the directory is briefly unreachable.

### Q11. When would you choose leaderless/quorum-based replication combined with consistent hashing, versus a more traditional single-leader sharded relational database?

Leaderless systems with consistent hashing (DynamoDB, Cassandra) are the right fit when you need very high write availability and throughput, can tolerate eventual consistency or tunable consistency per request, and your access patterns are largely key-based lookups rather than complex relational queries or joins — this combination scales writes and reads almost linearly by adding nodes with minimal rebalancing thanks to consistent hashing. A traditionally-sharded relational database (single-leader per shard) fits better when you need strong consistency within a shard, richer query capability (joins, transactions) at the per-shard level, and your write volume, while high, doesn't require the extreme availability guarantees leaderless systems are built for. The deciding question to ask out loud: "do I need strong consistency and relational query power per unit of data, or maximum availability and horizontal write scale with simpler access patterns?"

### Q12. How would you design sharding for a multi-tenant SaaS product where some tenants are far larger than others?

Sharding by tenant ID is the natural first choice since most queries are already scoped to a single tenant, keeping cross-shard queries rare — but a naive hash-based assignment risks putting several large tenants on the same shard purely by chance, creating a hot shard even though the sharding key itself is reasonable. The standard fix is a hybrid: use consistent hashing (or a directory-based mapping) for the bulk of small-to-medium tenants so they distribute evenly and rebalance cheaply, but give the handful of largest tenants their own dedicated shard (or even their own dedicated database) explicitly, monitored and provisioned separately from the shared pool. This mirrors the general hot-key mitigation pattern — isolate the known outliers, let consistent hashing handle the long tail — and is a very common real-world pattern for SaaS platforms with highly skewed tenant sizes.
