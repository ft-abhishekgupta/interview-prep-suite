---
title: Change Feed and Multi Region
description: How the Cosmos DB change feed streams writes in order, how the change feed processor scales, and how multi-region reads and writes actually behave
difficulty: Advanced
tags: [azure, cosmos-db, change-feed, multi-region]
---

The change feed is Cosmos DB's answer to "how do I react to every write without polling", and multi-region configuration is how Cosmos delivers its headline global-scale story. Both come up constantly in system design interviews once Cosmos is on the table, and both have sharp edges that separate real experience from surface knowledge.

## Change feed semantics

The change feed is a persistent, ordered log of every insert and update (by default) in a container, exposed per logical partition key. It is **not** a general-purpose event stream with arbitrary retention — it reflects the container's own data.

- **Ordered per partition key** — within one logical partition, changes appear in the order they were committed. There is no global ordering guarantee across different partition keys.
- **No deletes by default** — the classic "latest version" change feed mode only surfaces creates and updates; a delete simply removes the item, leaving no change feed entry, unless you either soft-delete (a `ttl`/`isDeleted` flag update, which does appear in the feed) or use the newer **all-versions-and-deletes** mode.
- **At-least-once delivery** to consumers — a change may be observed more than once after a consumer restart, so downstream processing must be idempotent.

| Mode | What it shows | Notes |
|---|---|---|
| Latest version (default) | Only the most recent state per changed item, creates + updates | No deletes; simplest and cheapest; good enough for most projections |
| All versions and deletes | Every intermediate change **and** deletes, as a true audit log | Needed for CDC-style pipelines, audit trails, or exact replication; requires explicit container configuration |

> [!KEY]
> "Change feed shows deletes" is a common false assumption — with the default mode, a hard delete is invisible to the feed. If deletes matter downstream, either soft-delete or enable all-versions-and-deletes mode explicitly.

## Change feed processor and lease container

The **Change Feed Processor** (part of the SDK) is the standard way to consume the feed reliably at scale: it reads changes, tracks progress, and distributes work across multiple instances automatically using a **lease container** — a small, separate Cosmos container that stores one lease document per partition key range, recording which consumer instance owns it and its last processed continuation token.

```mermaid
sequenceDiagram
    participant Src as "Monitored container"
    participant Lease as "Lease container"
    participant P1 as "Processor instance 1"
    participant P2 as "Processor instance 2"
    P1->>Lease: Acquire lease for range 0-3
    P2->>Lease: Acquire lease for range 4-7
    Src-->>P1: Changes for range 0-3
    Src-->>P2: Changes for range 4-7
    P1->>Lease: Checkpoint continuation token
    P2->>Lease: Checkpoint continuation token
```

- Leases are distributed roughly evenly across running instances; add more instances and leases automatically rebalance (up to one instance per partition key range — extra instances beyond that sit idle as standby).
- If an instance crashes, its leases expire after a configurable timeout and are picked up by surviving instances, resuming from the last checkpointed continuation token — this is what gives at-least-once, not exactly-once, delivery.

```csharp
ChangeFeedProcessor processor = client
    .GetContainer("db", "orders")
    .GetChangeFeedProcessorBuilder<Order>("orderProjectionProcessor", HandleChangesAsync)
    .WithInstanceName(Environment.MachineName)
    .WithLeaseContainer(client.GetContainer("db", "leases"))
    .Build();
await processor.StartAsync();

async Task HandleChangesAsync(ChangeFeedProcessorContext ctx, IReadOnlyCollection<Order> changes, CancellationToken ct)
{
    foreach (var order in changes)
        await UpdateMaterializedViewAsync(order); // must be idempotent
}
```

## Change feed use cases

| Use case | How it works |
|---|---|
| Materialised views / denormalised read models | Project changes into a differently-shaped or differently-partitioned container optimised for a specific query |
| Cache invalidation | Emit an event or directly evict/update a cache entry (Redis) whenever the source item changes |
| Event publishing | Forward changes onto Service Bus/Event Hubs so other bounded contexts react without polling Cosmos |
| Cross-region/cross-database replication | Read the feed and write into another store (e.g. a search index, a different Cosmos account, an on-prem system) |
| Analytics/ETL | Stream changes into a data lake or warehouse for batch or near-real-time analytics without impacting OLTP RU budget |
| Azure Functions Cosmos DB trigger | A fully managed change feed processor — Functions handles lease container wiring and scaling for you |

```csharp
[Function("OnOrderChanged")]
public async Task Run(
    [CosmosDBTrigger(databaseName: "db", containerName: "orders",
        Connection = "CosmosConnection", LeaseContainerName = "leases",
        CreateLeaseContainerIfNotExists = true)] IReadOnlyList<Order> changes)
{
    foreach (var order in changes) await PublishOrderChangedEventAsync(order);
}
```

> [!TIP]
> The Functions Cosmos DB trigger is change feed processor under the hood — mentioning that explicitly (rather than describing it as some separate mechanism) signals you understand the underlying model, not just the binding syntax.

## Multi-region topology

```mermaid
flowchart LR
    subgraph "Region: East US (write)"
        W1["App instance"] --> C1[("Cosmos replica")]
    end
    subgraph "Region: West Europe (write)"
        W2["App instance"] --> C2[("Cosmos replica")]
    end
    subgraph "Region: Southeast Asia (read only)"
        R1["App instance"] --> C3[("Cosmos replica")]
    end
    C1 <-->|"async replication"| C2
    C1 -->|"async replication"| C3
    C2 -->|"async replication"| C3
```

- **Single-region writes, multi-region reads** — one region accepts writes, replicated asynchronously to any number of read regions; simplest conflict-free model, and what most accounts use by default.
- **Multi-region writes** — every associated region can accept writes for the same container, giving the lowest possible write latency globally (writes land in the nearest region) at the cost of needing conflict resolution, since the same logical partition can be written concurrently in two regions.

## Conflict resolution

Multi-region writes require a conflict resolution policy per container:

| Policy | Behaviour |
|---|---|
| **Last-writer-wins (LWW)** | Default; resolved automatically using a system or user-defined numeric property (e.g. a timestamp) — the higher value wins |
| **Custom (stored procedure)** | A stored procedure receives both conflicting versions and returns the merged/resolved document — needed when losing either version outright is unacceptable (e.g. merging two updates to different fields of the same document) |

> [!WARNING]
> Last-writer-wins silently discards the losing write's changes to fields the winning write didn't touch. If your domain needs field-level merge (e.g. one region updated `stock`, another updated `price`, on the same item), LWW will still pick one whole document version and drop the other's change — you need a custom merge procedure to actually combine them.

## Failover: manual vs automatic

- **Manual failover** — you explicitly trigger a region priority change (e.g. during a planned drill or a detected regional issue not yet reflected by Cosmos's own health signals).
- **Automatic failover** — Cosmos detects a regional outage and fails over write traffic to the next region in your configured priority list without intervention, typically within minutes; must be explicitly enabled per account.
- **Availability zones** — within a single region, replicas can additionally be spread across availability zones for resilience to a datacenter-level failure without needing a cross-region failover at all; recommended wherever the region supports it, at no RU cost, only a small storage redundancy cost.

## RU cost of multi-region writes

Enabling multi-region writes does **not** multiply the RU/s you provision per region for storage — each region's container is provisioned with the same RU/s independently and billed per region (so a 3-write-region account roughly triples total RU/s cost, since each region needs its own capacity to accept and replicate writes). Conflict resolution and cross-region replication add a small, usually negligible, additional RU overhead on writes, but the dominant cost driver is simply "you're paying for provisioned throughput in every write region, not just one".

## Cheat sheet

- Change feed is ordered **per partition key**, at-least-once delivery, no global cross-partition order.
- Default mode shows creates/updates only — **no deletes**; use soft-delete or all-versions-and-deletes mode if deletes matter.
- Change Feed Processor uses a **lease container** to distribute partition key ranges across instances and checkpoint progress.
- Azure Functions' Cosmos DB trigger **is** a managed change feed processor.
- Multi-region writes need a **conflict resolution policy**: last-writer-wins (field-blind) or a custom stored procedure (field-aware merge).
- **Automatic failover** must be explicitly enabled; **availability zones** protect against datacenter failure without any region failover at all.
- Multi-region writes roughly **multiply RU/s cost by region count**, since each region provisions its own throughput.
- Idempotent consumers are mandatory for change feed processing — delivery is at-least-once.

## Common mistakes

| Mistake | Fix |
|---|---|
| Assuming change feed shows deletes | Use soft-delete flags or all-versions-and-deletes mode |
| Building change feed consumers that aren't idempotent | Delivery is at-least-once; design for safe reprocessing |
| Expecting global cross-partition ordering from the change feed | Ordering is only guaranteed within a single logical partition key |
| Choosing last-writer-wins for domains needing field-level merges | Use a custom conflict resolution stored procedure instead |
| Assuming automatic failover is always on | It must be explicitly enabled per account; test failover in staging |
| Forgetting multi-region writes multiply RU/s cost per region | Budget provisioned throughput per write region, not once globally |

## Summary

The change feed turns Cosmos DB into an event source for the rest of your architecture, but only for creates and updates by default, ordered within a partition key, delivered at-least-once — which pushes real responsibility onto consumer idempotency. The Change Feed Processor and its lease container handle distributing and scaling that consumption automatically, and Azure Functions' Cosmos trigger is simply a managed wrapper around the same mechanism. Multi-region configuration extends this global story to writes, at the cost of needing an explicit conflict resolution policy and roughly proportional RU/s spend per region — know both trade-offs cold, because they are exactly where interviewers probe for real production exposure.

## Top Interview Questions

### Q1. What does the Cosmos DB change feed actually guarantee, and what does it not guarantee?

It guarantees an ordered stream of creates and updates **within a single logical partition key**, delivered at-least-once to consumers — so a consumer processing one partition key's feed sequentially sees changes in the order they were committed. It does **not** guarantee ordering across different partition keys (there's no single global sequence), does not include deletes by default (the standard "latest version" mode only shows current state after creates/updates, so a hard delete simply vanishes from the feed), and does not guarantee exactly-once delivery — a consumer restart can replay already-processed changes, so downstream logic must be idempotent. These caveats are exactly what interviewers probe for beyond "it's like Kafka for Cosmos".

### Q2. How would you use the change feed to know when an item was deleted?

By default you can't — deletes are invisible to the standard change feed. Two options: soft-delete, where instead of a hard delete you update the item with a flag like `isDeleted: true` (optionally paired with a TTL to actually purge it later), which does produce a change feed entry consumers can react to; or enable the **all-versions-and-deletes** change feed mode (a more recent Cosmos capability), which surfaces every intermediate change and explicit delete operations as distinct feed entries, effectively giving you a true CDC-style audit log at the cost of higher storage/retention overhead and requiring the mode to be configured on the container up front.

### Q3. Explain how the Change Feed Processor scales across multiple instances.

It uses a separate **lease container**, where each document represents ownership of one partition key range plus a checkpoint (continuation token) of how far that range has been processed. When multiple processor instances start with the same processor name and lease container, they coordinate by acquiring leases — Cosmos aims to distribute partition key ranges roughly evenly across running instances, so adding instances (up to the number of partition key ranges) increases parallelism, while excess instances beyond that sit idle as hot standbys. If an instance crashes or is scaled down, its leases expire after a timeout and are picked up by remaining instances, which resume from the last checkpointed token — this is why delivery is at-least-once rather than exactly-once, since a crash between processing and checkpointing causes reprocessing.

### Q4. Is the Azure Functions Cosmos DB trigger a different mechanism from the Change Feed Processor?

No — the Functions Cosmos DB trigger is a managed wrapper around the same Change Feed Processor library; Functions handles creating and wiring the lease container (optionally auto-creating it), scaling instances based on the Functions host's own scale controller, and exposing the batched changes to your function code. Understanding this matters because the same semantics apply: at-least-once delivery, ordering only within a partition key, no deletes without soft-delete or all-versions-and-deletes mode, and the same need for idempotent processing. It also means the same operational levers apply — lease container throughput needs to be sized appropriately, since heavy lease contention can itself become a bottleneck at high scale.

### Q5. What's the difference between last-writer-wins and custom conflict resolution in a multi-region-write account?

Last-writer-wins (LWW) is the default policy: Cosmos compares a numeric property (by default a system timestamp, or a user-specified property) between two conflicting versions of the same item written concurrently in different regions, and keeps the entire document with the higher value, discarding the other whole document version. Custom conflict resolution instead runs a stored procedure you write, which receives both conflicting versions and returns a merged or otherwise resolved document — necessary when the two concurrent writes touched different fields of the same item and you don't want to lose either change outright. The trade-off: LWW is simple and requires no code, but silently loses data at the field level; custom resolution requires you to write and maintain merge logic but preserves intent from both writers.

### Q6. When would you need multi-region writes instead of single-region writes with multi-region reads?

Multi-region writes matter when write latency for globally distributed users is a hard requirement — with single-region writes, every write (regardless of where the user is) must round-trip to the one write region, adding real latency for users far from it; with multi-region writes, each region accepts writes locally and replicates asynchronously, so a user in Southeast Asia writing to a Southeast Asia region gets local-region latency. The cost is needing an explicit conflict resolution policy (since the same logical partition could theoretically be written concurrently in two regions) and paying for provisioned throughput in every write region rather than just one. If your write latency requirement is already satisfied by single-region writes (e.g. a mostly-read, occasional-write workload, or writes are naturally regionally partitioned by user), single-region writes with multi-region reads is simpler and cheaper.

### Q7. Does enabling multi-region writes affect Cosmos DB's RU/s billing?

Yes, materially — each write region provisions and bills its own RU/s capacity independently, so an account with three write regions roughly triples the total provisioned-throughput cost compared to a single-region account at the same per-region RU/s, because each region needs enough capacity to accept, index, and replicate writes on its own. There's also a small additional RU overhead for conflict detection/resolution machinery on writes, though it's typically minor compared to the region-count multiplier. This is a common design-review gotcha: teams enable multi-region writes purely for the "five nines" availability SLA without realizing the throughput cost scales with region count, not just once globally.

### Q8. What's the difference between automatic failover and availability zones, and when would you use each?

Availability zones protect against a **datacenter-level failure within one region** — Cosmos replicas are spread across physically separate zones inside the region, so losing one zone doesn't cause a regional outage or require any cross-region failover at all; this should generally be enabled wherever the region supports it, at a small storage redundancy cost and no RU cost. Automatic failover protects against a **full regional outage** — if enabled, Cosmos detects the outage and redirects write traffic to the next region in your configured priority list without manual intervention, typically within minutes. They're complementary, not alternatives: availability zones reduce how often you'd ever need a regional failover in the first place, while automatic failover is the safety net for the rarer case of a whole-region event.

### Q9. Walk through a materialised view use case built on the change feed.

Suppose an `Orders` container is partitioned by `customerId` for efficient per-customer access, but a reporting feature needs "all orders shipped in the last hour across all customers", which would be an expensive cross-partition query if run directly against `Orders`. I'd build a change feed processor watching `Orders`, and on each change, upsert a projection into a separate `ShippedOrdersByHour` container partitioned by an hour-bucket key that matches the reporting query's access pattern — turning an expensive ad-hoc cross-partition query into a cheap, purpose-built single-partition read. Because change feed delivery is at-least-once, the upsert into the materialised view must be idempotent (keyed by order ID so reprocessing overwrites rather than duplicates), and because deletes aren't in the default feed, I'd need a soft-delete flag on `Orders` if removed orders must also disappear from the projection.

### Q10. How do you make change feed consumers safe against reprocessing after a crash?

Design every side effect as idempotent with respect to the item's identity and its latest state, not as an incremental "apply this delta" operation. Concretely: upserts keyed by the source item's ID (so reprocessing the same change twice just overwrites with the same result) rather than increment/append operations; deduplication using the item's `_ts` or an explicit version/ETag field if a downstream system can't naturally tolerate replays (e.g. skip processing if the stored version is already >= the incoming version); and avoiding non-idempotent external calls (like "send an email" or "charge a card") directly inside the change feed handler — instead, publish an idempotent event with a stable ID to a queue and let a separate, dedup-aware consumer handle the side effect exactly-once via its own deduplication table.

### Q11. Can you replay the change feed from the beginning, and why would you want to?

Yes — the Change Feed Processor supports starting from the beginning of the container's history (subject to any TTL-based expiry on the source items themselves, since the feed only reflects data still present or its retained change history depending on mode), from a specific point in time, or from "now" onward. You'd replay from the beginning when bootstrapping a brand-new downstream consumer — for example, standing up a new materialised view or search index for the first time and needing it backfilled with all existing data, not just future changes — by pointing a fresh lease container at the source container and letting the processor walk the entire existing history before catching up to live changes.

### Q12. A downstream materialised view built from the change feed is missing some deletes — what's the likely root cause and fix?

The likely cause is that the container is using the default "latest version" change feed mode, which never surfaces hard deletes — items removed with a straightforward delete operation simply disappear from the source container without any corresponding feed entry, so a downstream projection built purely from the feed retains stale copies of deleted items indefinitely. The fix is either to stop hard-deleting and instead soft-delete (set an `isDeleted` flag, optionally with a TTL for eventual physical cleanup), which does generate a feed entry the consumer can act on, or to migrate the container to all-versions-and-deletes mode, which explicitly surfaces delete operations as their own feed entries — the latter is a more invasive change since it affects retention and requires consumer code updates to handle a new entry type.
