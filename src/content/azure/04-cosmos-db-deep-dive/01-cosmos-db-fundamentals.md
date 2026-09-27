---
title: Cosmos DB Fundamentals
description: The resource model, APIs, throughput options and SLAs that every Cosmos DB interview question builds on before diving into partitioning
difficulty: Core
tags: [azure, cosmos-db, nosql, databases]
---

Cosmos DB interview questions almost never start with "how do you write a query" — they start with "how is data organised and paid for". Get the account/database/container/item model, the API choice, and the throughput model solid first; everything else (partitioning, consistency, change feed) is built on top of these four ideas.

## The resource hierarchy

```mermaid
flowchart TD
    A["Cosmos DB Account<br/>(one API, one billing boundary)"] --> D1["Database A"]
    A --> D2["Database B"]
    D1 --> C1["Container: Orders<br/>(own throughput, partition key)"]
    D1 --> C2["Container: Customers"]
    C1 --> I1["Item: order-1<br/>(JSON document)"]
    C1 --> I2["Item: order-2"]
    C1 --> I3["Item: order-3"]
```

- **Account** — the top-level resource; you pick the API here (NoSQL, MongoDB, Cassandra, Gremlin, Table) and it cannot be changed afterwards. Also the boundary for global distribution, failover policy, and keys/RBAC.
- **Database** — a namespace for containers; can optionally hold shared throughput.
- **Container** — the unit of storage and throughput scaling; roughly analogous to a table/collection, but backed by physical partitions that split automatically as data grows.
- **Item** — a single JSON document (or row/vertex/edge depending on API), up to 2 MB.

> [!KEY]
> A **container** — not a database — is where partition key and throughput decisions live. Interviewers listen for whether you know throughput and partitioning are container-scoped concepts.

## Choosing an API

Cosmos DB is a multi-model engine underneath, but you commit to one wire protocol per account.

| API | Data model | When to use | When to avoid |
|---|---|---|---|
| NoSQL (Core/SQL) | JSON documents, SQL-like query language | Default choice for new applications; full feature access (change feed, best indexing control) | N/A — this is the reference API |
| MongoDB API | BSON documents, MongoDB wire protocol | Lift-and-shift existing MongoDB apps/drivers with minimal code change | New greenfield apps — you lose some NoSQL-API-only features and must track MongoDB API version compatibility |
| Cassandra API | Wide-column, CQL | Migrating existing Cassandra workloads without rewriting drivers | New apps — smaller ecosystem of Azure-native tooling than NoSQL API |
| Gremlin API | Property graph, Gremlin traversal | Graph-shaped problems — social graphs, recommendation, fraud rings | High-throughput OLTP or simple key-value access — graph traversal has different cost characteristics |
| Table API | Key-value, Azure Table Storage protocol | Migrating from Azure Table Storage while gaining global distribution/SLA upgrades | New apps — NoSQL API is a strict superset of capability |

> [!TIP]
> Say out loud: "unless there's an existing MongoDB/Cassandra/Gremlin/Table investment to preserve, I default to the NoSQL API — it gets first access to new features like hierarchical partition keys and the richest indexing control."

## Throughput: where it lives and how it's shaped

Throughput is measured in **Request Units per second (RU/s)** and can be provisioned at two scopes:

- **Database-level (shared) throughput** — one RU/s pool shared across all containers in the database; simplest for many small, low-traffic containers, but one noisy container can starve the others.
- **Container-level (dedicated) throughput** — RU/s provisioned per container; isolates workloads from each other, required once a container needs predictable performance or exceeds shared limits.

| Mode | Billing | Scaling | Best for |
|---|---|---|---|
| **Provisioned (manual)** | Pay for RU/s reserved, 24/7, whether used or not | You set and change RU/s manually or via autoscale rules/automation | Stable, predictable traffic |
| **Autoscale** | Pay for the peak RU/s used in each hour, scales instantly between 10% and 100% of a max you set | Automatic within the configured band | Spiky or unpredictable traffic where you don't want to hand-tune |
| **Serverless** | Pay per RU consumed, no reservation | No provisioning at all, but capped total storage (50 GB) and RU/s ceiling per container | Dev/test, low/intermittent traffic, new workloads with unknown shape |

> [!WARNING]
> Serverless containers cannot be converted in-place to provisioned/autoscale (and vice versa) — migrating requires creating a new container and copying data. Choosing the wrong mode early is a real migration cost, not just a config toggle.

## Global distribution and SLAs

Cosmos DB replicates a container's data to any Azure region you associate with the account, with per-region reads and (optionally) per-region writes. This is covered in depth in the change feed and multi-region page, but the headline SLA numbers are worth memorising:

| SLA dimension | Guarantee |
|---|---|
| Availability, single region | 99.99% |
| Availability, multi-region (multiple write regions) | 99.999% |
| Throughput | 100% of provisioned RU/s honoured if within limits |
| Latency (point read/write, P99) | < 10 ms |
| Consistency | Guaranteed per the configured consistency level (see the consistency page) |

These are backed by financial credits — the kind of concrete number an interviewer expects you to know without hesitation.

## RUs as the unified currency

Every operation — a point read, a query, a write, a stored procedure execution — costs a number of **Request Units**, a normalized measure of CPU, memory and IO cost abstracted away from the underlying hardware. A 1 KB point read by ID and partition key costs roughly 1 RU; writes cost more because they also update indexes. Thinking in RUs rather than "how many requests per second" is the mental shift Cosmos DB expects from anyone used to traditional databases — capacity planning, cost estimation and throttling are all expressed in this one currency.

```csharp
// The SDK exposes RU charge on every response — instrument this in production
ItemResponse<Order> response = await container.ReadItemAsync<Order>(
    id: order.Id, partitionKey: new PartitionKey(order.CustomerId));
Console.WriteLine($"RU charge: {response.RequestCharge}");
```

## When Cosmos DB is the wrong choice

- **Complex multi-record ACID transactions across partition keys** — Cosmos transactions (via stored procedures/transactional batch) are scoped to a single logical partition key; if your domain needs cross-entity transactions routinely, a relational database is a better fit.
- **Ad-hoc analytical queries over the whole dataset** — Cosmos is optimised for known access patterns at low latency, not for arbitrary joins/aggregations across large datasets; pair it with the analytical store (Synapse Link) or export to a warehouse instead.
- **Heavy relational joins** — there is no native cross-container join; you either denormalise or do the join client-side, both of which push you toward relational modelling if joins are the primary access pattern.
- **Tight, fixed budgets with unpredictable low traffic** — provisioned throughput bills 24/7; serverless helps but has ceilings, so a workload that's mostly idle with occasional huge spikes may cost more than a well-sized relational instance.
- **Strong need for full-text or complex ranking search** — Cosmos indexing supports range/equality/spatial, not the analyzer/ranking features of a dedicated search engine — pair with Azure AI Search instead.

> [!DANGER]
> A classic interview trap: describing Cosmos DB as "just a JSON database" and reaching for it by default. The correct signal is recognising Cosmos as the right tool specifically when you need **guaranteed low single-digit-millisecond latency at any scale, global distribution, and elastic throughput** — not simply "we store JSON".

## Cheat sheet

- Hierarchy: **account → database → container → item**; API is chosen once, per account.
- Throughput and partition key live at the **container** level (or shared at database level).
- Five APIs: NoSQL (default/richest), MongoDB, Cassandra, Gremlin, Table — pick non-NoSQL only to preserve an existing investment.
- Three throughput modes: **provisioned** (manual, 24/7 billing), **autoscale** (auto within a band, pay for peak), **serverless** (pay-per-RU, capped storage).
- SLA numbers to memorise: 99.99% single-region / 99.999% multi-region availability, <10 ms P99 for point ops.
- **Request Units (RUs)** are the single normalized cost metric for every operation — reads, writes, queries, index updates.
- Item size limit is **2 MB**.
- Serverless and provisioned containers cannot be converted in place.
- Cosmos is wrong for cross-partition ACID transactions, ad-hoc analytics, heavy relational joins, and full-text search.

## Common mistakes

| Mistake | Fix |
|---|---|
| Assuming you can switch API after account creation | The API is fixed at account creation — plan it up front |
| Provisioning throughput per-database "to save money" for workloads with very different traffic shapes | Use container-level throughput to isolate noisy neighbours |
| Treating serverless as a free scaling mode for production | It has hard storage (50 GB/container) and RU/s ceilings — check them against real projected load |
| Expecting cross-container joins | Denormalise or do client-side composition; Cosmos has no native join |
| Quoting "99.99% availability" without knowing it needs single-region and specific config | Know the multi-region 99.999% figure and what unlocks it (multiple write regions) |
| Sizing a container by "rows" instead of RU/s and GB | Cosmos capacity planning is RU/s and storage GB, not row counts |

## Summary

Cosmos DB's mental model is a strict hierarchy — account, database, container, item — with API chosen once at the account level and throughput/partitioning decisions made at the container level. Provisioned, autoscale and serverless throughput modes trade predictability for elasticity for simplicity, and every single operation is billed in the same normalized currency: Request Units. Knowing the SLA numbers cold, and being able to say precisely when Cosmos is the wrong tool — cross-partition transactions, ad-hoc analytics, heavy joins, full-text search — is what separates "I've used Cosmos" from "I understand Cosmos".

## Top Interview Questions

### Q1. Walk through the Cosmos DB resource hierarchy.

An **account** is the top-level resource — it fixes the API (NoSQL, MongoDB, Cassandra, Gremlin, Table) for its lifetime and is the boundary for global distribution, failover configuration, and keys. Inside an account, one or more **databases** act as namespaces. Inside a database, one or more **containers** hold the actual data; a container is the unit that owns a partition key and (usually) its own throughput, and is backed transparently by one or more **physical partitions** that Cosmos manages and splits automatically. Inside a container, **items** are individual JSON documents (or the API-equivalent: row, vertex/edge) up to 2 MB each. The two decisions that matter most operationally — partition key and throughput — are made at the container level, not the database or account level.

### Q2. What are the five Cosmos DB APIs and how do you choose between them?

NoSQL (the native/Core API), MongoDB, Cassandra, Gremlin and Table. NoSQL is the reference API and gets new features first (hierarchical partition keys, latest indexing options), so it's the default for greenfield projects. The other four exist to preserve existing investments: MongoDB API for teams with existing Mongo drivers/tooling, Cassandra API for existing CQL-based systems, Gremlin for graph-shaped data with an existing Gremlin/TinkerPop toolchain, and Table API for migrating off Azure Table Storage while gaining global distribution and stronger SLAs. The API is chosen at account creation and cannot be changed afterward, so it's a decision to make deliberately, not default to without asking about existing systems.

### Q3. What's the difference between provisioned, autoscale, and serverless throughput?

**Provisioned** throughput reserves a fixed RU/s 24/7 — you pay for it whether used or not, and you scale it manually or via scheduled automation; best for stable, predictable traffic. **Autoscale** sets a maximum RU/s and Cosmos scales instantly between 10% and 100% of that ceiling based on actual usage, billing for the highest RU/s used in each hour — best for spiky or unknown traffic where you don't want to hand-tune capacity. **Serverless** has no reservation at all — you pay per RU actually consumed, with no minimum bill, but the container is capped at roughly 50 GB storage and a lower RU/s ceiling — ideal for dev/test or genuinely low/intermittent production traffic. A key production detail: you cannot convert a serverless container to provisioned/autoscale in place; migrating means creating a new container and copying data.

### Q4. What is a Request Unit, and why does Cosmos DB use this abstraction?

A Request Unit (RU) is a normalized measure of the compute, memory, and IO cost of an operation, decoupled from the underlying hardware — a 1 KB point read by ID and partition key costs about 1 RU regardless of which physical machine serves it. Cosmos uses this abstraction so that capacity planning, throttling, and billing are all expressed in one consistent unit across every operation type: point reads, queries, writes, deletes, even stored procedure execution. This means you can reason about cost and capacity purely from RU/s provisioned versus RU/s consumed, without needing to know CPU/memory specifics of the backing nodes — and it's why every Cosmos SDK response exposes a request charge you should log and alert on in production.

### Q5. What SLAs does Cosmos DB guarantee, and what unlocks the highest tier?

Cosmos DB guarantees 99.99% availability for a single-region account, and 99.999% (five nines) once you configure multiple write regions (multi-region writes), alongside a <10 ms P99 latency guarantee for point reads and writes, 100% throughput guarantee (provisioned RU/s honoured within limits), and a consistency guarantee tied to whichever of the five consistency levels you've configured. These are financially backed SLAs, not marketing numbers — Microsoft issues service credits if they're breached. The practical takeaway for an interview: getting to 99.999% availability requires deliberately enabling multi-region writes, not just deploying to multiple regions for read replicas.

### Q6. When is Cosmos DB the wrong choice for a workload?

Four recurring cases: (1) workloads needing **ACID transactions across many entities or partition keys** — Cosmos transactions are scoped to a single logical partition key, so cross-entity consistency needs either careful data modelling or a different database; (2) **ad-hoc analytical queries** over the full dataset — Cosmos is built for known, low-latency access patterns, not arbitrary aggregation, so pair it with Synapse Link or export to a warehouse; (3) workloads dominated by **relational joins** — there's no native cross-container join, forcing denormalisation or client-side composition; (4) **full-text or ranked search** — Cosmos indexing is range/equality/spatial only, so a dedicated search engine like Azure AI Search is the right complement. Recognising these boundaries is more valuable in an interview than reciting Cosmos features.

### Q7. Explain the difference between database-level and container-level throughput.

Database-level (shared) throughput provisions one RU/s pool across every container in that database — it's simpler to manage for many small, low-traffic containers, but a spike in one container consumes RU/s from the shared pool and can starve siblings ("noisy neighbour"). Container-level (dedicated) throughput provisions RU/s specifically for one container, isolating its performance from others at the cost of managing more individual RU/s settings. In production, the common pattern is dedicated throughput for high-traffic or latency-sensitive containers, and shared database throughput for a handful of small reference/lookup containers that rarely see contention.

### Q8. A team wants to migrate from Azure Table Storage to Cosmos DB — what would you tell them?

Cosmos DB's Table API is designed exactly for this: it speaks the same wire protocol as Azure Table Storage, so existing SDK code (Azure.Data.Tables) largely works unchanged, while gaining Cosmos's global distribution, tunable consistency, higher throughput ceilings, and financially backed SLAs that Table Storage doesn't offer. I'd flag the trade-offs though: Table API is a compatibility layer, so it doesn't expose Cosmos-native features like hierarchical partition keys or the fullest indexing control that the NoSQL API gets first, and it's usually more expensive than raw Table Storage for equivalent low-throughput workloads. If there's appetite for a client rewrite, moving straight to the NoSQL API instead of Table API is worth the extra effort for long-term feature access.

### Q9. What is the maximum item size in Cosmos DB, and how does that shape data modelling?

2 MB per item. This caps how much you can embed inside a single document before you must reference rather than embed — a customer document with an unbounded array of historical orders will eventually break this limit, so unbounded one-to-many relationships need to be modelled as separate items (referenced by a shared partition key or foreign key) rather than nested arrays. It also affects transactional batch design, since a transactional batch operates on items within a single logical partition key and the cumulative payload has its own limits. In interviews, tying the 2 MB limit back to embedding-vs-referencing decisions (covered in data modelling) shows you understand it as a modelling constraint, not just a trivia fact.

### Q10. How would you estimate the throughput (RU/s) a new Cosmos container needs before going to production?

Start from expected operation mix and volume: estimate reads/sec, writes/sec, and typical item size, then use published/benchmarked RU costs (roughly 1 RU per 1 KB point read, more like 5-10 RU per 1 KB write depending on indexed properties) to get a rough RU/s figure, then load test against a representative container with realistic data and indexing policy to get the SDK's actual reported request charges rather than trusting estimates alone. I'd provision with autoscale initially so unexpected spikes don't cause 429s while I gather real telemetry, then switch to provisioned throughput once traffic patterns are well understood and predictable, since manually tuned provisioned throughput is usually the cheaper steady-state option.

### Q11. Why might an interviewer push back if you say "Cosmos DB is just a document database"?

Because that description misses the properties that actually justify choosing it: elastic, RU-metered throughput that scales independently per container; transparent global distribution with configurable multi-region reads and writes; five tunable consistency levels trading latency/availability for guarantees; and financially backed single-digit-millisecond latency SLAs at any scale. Plenty of document databases exist without any of that. The strong answer frames Cosmos as "a globally distributed, horizontally partitioned database with tunable consistency and elastic throughput that happens to speak several data models" — which is also precisely the set of trade-offs you need to justify choosing it over a single-region relational or document store.

### Q12. What happens if you try to convert a serverless container to provisioned throughput?

You can't do it in place — Cosmos DB does not support converting the throughput mode of an existing container between serverless and provisioned/autoscale. The supported path is to create a new container with the desired throughput mode and migrate data into it, typically using the change feed, the Cosmos DB data migration tool, or an export/import pipeline, then cut traffic over once migration and validation are complete. This is worth deciding correctly up front in a design: if there's any realistic chance production traffic will exceed serverless's storage/RU ceilings, starting with autoscale (which can later be switched to manual provisioned throughput without recreating the container) avoids a disruptive migration later.
