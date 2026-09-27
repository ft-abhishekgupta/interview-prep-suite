---
title: Azure SQL and Azure Cache for Redis
description: Azure SQL deployment and purchasing options, high availability and geo-replication, and Redis tiers and patterns for caching on Azure
difficulty: Core
tags: [azure, sql, redis, caching, databases]
---

Azure SQL and Azure Cache for Redis are the two services almost every Azure system design answer eventually reaches for — a relational store for transactional integrity, a cache in front of it for latency. Interviewers expect fluency in both the deployment/pricing options and the failure-handling patterns, not just "SQL for structured data, Redis for speed".

## Azure SQL deployment options

| Option | Isolation | Best for |
|---|---|---|
| **Single database** | Fully isolated database with its own resources | Simple apps, one database per workload, easiest to reason about |
| **Elastic pool** | Many databases share a pool of resources (DTUs/vCores) | Many databases with unpredictable, non-simultaneous peaks — SaaS with one database per tenant |
| **Managed Instance** | Near-complete SQL Server surface area (cross-database queries, SQL Agent, CLR, linked servers) in a fully managed PaaS instance, in your VNet | Lift-and-shift of on-prem SQL Server with minimal app changes, needs SQL Server features single database doesn't expose |

```mermaid
flowchart TD
    A["Azure SQL"] --> B["Single Database"]
    A --> C["Elastic Pool<br/>(shared DTU/vCore budget)"]
    A --> D["Managed Instance<br/>(full SQL Server surface, VNet-joined)"]
    B --> B1["App 1 DB"]
    C --> C1["Tenant DB 1"]
    C --> C2["Tenant DB 2"]
    C --> C3["Tenant DB 3"]
```

> [!KEY]
> Managed Instance exists specifically to close the gap between "cloud-native single database" and "everything our legacy SQL Server app relies on" — cross-database queries, SQL Agent jobs, Service Broker. If a candidate answer says "just use single database" for a lift-and-shift with cross-database stored procedures, that's a red flag.

## Purchasing models

| Model | Billing unit | Scaling | Best for |
|---|---|---|---|
| **DTU-based** | Bundled compute+storage+IO "Database Transaction Unit" tiers (Basic/Standard/Premium) | Fixed tier steps | Simple, predictable workloads; easiest initial choice |
| **vCore-based (provisioned)** | Compute and storage billed/scaled independently, choice of hardware generation | Fine-grained, can reuse Azure Hybrid Benefit for licensing savings | Workloads needing control over compute/storage ratio or existing SQL Server licences |
| **vCore Serverless** | Auto-pauses during inactivity, billed per second of actual vCore usage | Auto-scales within min/max vCore bounds | Intermittent, unpredictable workloads (dev/test, low-traffic apps) — avoid for latency-sensitive prod (cold start after pause) |
| **Hyperscale** | vCore-based, but storage scales independently to 100 TB+ with fast backups/restores via storage snapshots | Very large or rapidly growing databases needing fast restores regardless of size | Large OLTP databases where traditional backup/restore times become a problem |

> [!TIP]
> Say the trade-off, not just the name: "Hyperscale decouples storage growth from restore time by using storage-layer snapshots instead of full backup restores, so a 10 TB Hyperscale database restores about as fast as a 100 GB one — that's the specific problem it solves."

## High availability and failover groups

- **Zone-redundant HA** (built into General Purpose/Business Critical/Hyperscale tiers) replicates across availability zones within a region for automatic failover on a zone failure, with no application change needed.
- **Auto-failover groups** add cross-**region** protection: a group of databases replicates to a secondary region, exposed through a stable read-write and read-only listener endpoint, so failover doesn't require changing the connection string — you just point at the group's listener, and Azure redirects it to whichever region is currently primary.
- **Active geo-replication** is the more granular, single-database building block underneath failover groups — up to 4 readable secondary replicas in different regions, with manual or (via failover groups) automatic failover.

```mermaid
flowchart LR
    App["Application"] --> Listener["Failover group listener<br/>(stable endpoint)"]
    Listener --> Primary[("Primary region DB")]
    Primary -->|"async replication"| Secondary[("Secondary region DB")]
    Listener -.->|"on failover"| Secondary
```

## Backup, point-in-time restore, and connection resiliency

- **Automated backups** (full weekly, differential, log backups every 5-10 minutes) enable **point-in-time restore (PITR)** to any moment within the retention window (7-35 days by default, longer with long-term retention policies configured separately).
- **Transient fault handling** is mandatory, not optional — Azure SQL can throttle or briefly drop connections during failover, load balancing, or plan changes, and the SDK/ADO.NET does not retry automatically by default.

```csharp
// EF Core — enable the built-in retrying execution strategy for transient faults
services.AddDbContext<AppDbContext>(options =>
    options.UseSqlServer(connectionString,
        sql => sql.EnableRetryOnFailure(maxRetryCount: 5, maxRetryDelay: TimeSpan.FromSeconds(10), errorNumbersToAdd: null)));
```

> [!WARNING]
> Wrapping a manually-managed transaction in a retry loop is unsafe unless the retry strategy is transaction-aware — EF Core's execution strategy handles this correctly by re-running the whole logical transaction on retry, but a naive `try/catch` retry around a `SqlTransaction` can silently commit a partial retry. Use the framework's execution strategy rather than hand-rolled retry-around-transaction code.

## Azure Cache for Redis tiers

| Tier | SLA | Clustering | Persistence | Typical use |
|---|---|---|---|---|
| **Basic** | None (single node) | No | No | Dev/test only |
| **Standard** | 99.9%, two-node replicated | No | No | Simple production caching with basic HA |
| **Premium** | 99.9%, replicated | Yes (up to 10 shards) | Yes (RDB/AOF), VNet, geo-replication | Production caching needing persistence, clustering, or private networking |
| **Enterprise / Enterprise Flash** | 99.99%, Redis Enterprise (RedisLabs) engine | Yes, larger scale | Yes | Very large datasets, modules (RedisJSON, RediSearch, etc), highest availability |

- **Clustering** (Premium+) shards data across nodes for capacity and throughput beyond a single node's limit; client libraries need cluster-mode support enabled.
- **Persistence** (RDB snapshots or AOF append-only file, Premium+) lets the cache survive a full restart without becoming a cold cache instantly — important if the cache is also acting as a fast primary store for ephemeral data, not just a lookaside cache.
- **Private endpoints** (Premium+) put the cache inside your VNet, removing public internet exposure entirely — the default posture for production.
- **Eviction policies** (`volatile-lru`, `allkeys-lru`, `volatile-ttl`, `noeviction`, etc.) control what happens when memory fills up; `noeviction` causes writes to fail once full, which is correct only if you're using Redis for more than pure caching (e.g. as a queue or session store where losing data silently is worse than an error).

```csharp
// StackExchange.Redis — cache-aside pattern
var cache = ConnectionMultiplexer.Connect(redisConnectionString).GetDatabase();
string cacheKey = $"product:{productId}";
var cached = await cache.StringGetAsync(cacheKey);
if (cached.HasValue) return JsonSerializer.Deserialize<Product>(cached!);

var product = await LoadFromSqlAsync(productId);
await cache.StringSetAsync(cacheKey, JsonSerializer.Serialize(product), TimeSpan.FromMinutes(10));
return product;
```

## Typical cache patterns

| Pattern | Description |
|---|---|
| Cache-aside (lazy loading) | App checks cache first, falls back to the database on miss, then populates the cache | 
| Write-through | App writes to cache and database together, keeping cache always warm for that key |
| Session store | Redis holds web session state so any app instance behind a load balancer can serve any user |
| Rate limiting / counters | Atomic `INCR` with TTL implements sliding-window rate limits cheaply |
| Pub/sub | Lightweight fan-out messaging between app instances (not a durable queue — no persistence of missed messages) |

## Choosing between Azure SQL and Redis for a workload

Redis is never a replacement for Azure SQL's durability and query guarantees — it's a complement. The decision is really "what's in front of what": Azure SQL is the durable source of truth for relational/transactional data with rich querying (joins, aggregates, constraints); Redis sits in front of it to absorb read-heavy, latency-sensitive, or ephemeral-state traffic (sessions, rate limits, hot lookups) that doesn't need SQL's transactional guarantees on every access.

> [!DANGER]
> Using Redis as a primary data store without persistence enabled (Basic/Standard tiers, or Premium with persistence off) means a restart or failover silently loses all data. If Redis holds anything you can't cheaply regenerate from SQL, enable persistence and treat it as a real dependency in your DR plan, not "just a cache".

## Cheat sheet

- Azure SQL deployment: **single database** (isolated), **elastic pool** (shared budget, many DBs), **Managed Instance** (near-full SQL Server surface, VNet-joined).
- Purchasing models: **DTU** (bundled, simple), **vCore provisioned** (fine-grained, licence reuse), **vCore serverless** (auto-pause, intermittent workloads), **Hyperscale** (independent storage scaling, fast restores at any size).
- **Auto-failover groups** give a stable endpoint across regions; **active geo-replication** is the underlying single-database building block (up to 4 readable secondaries).
- Backups enable **PITR** within the retention window; always implement **transient fault retry** (e.g. EF Core `EnableRetryOnFailure`).
- Redis tiers: **Basic** (dev/test), **Standard** (basic HA), **Premium** (clustering, persistence, VNet), **Enterprise** (highest SLA, modules).
- Eviction policy choice matters: `noeviction` fails writes at capacity instead of silently dropping data — right for non-pure-cache use cases.
- Cache-aside is the default pattern; write-through keeps the cache always warm at the cost of write latency.
- Redis without persistence is not a source of truth — treat data loss on restart as expected unless persistence is explicitly enabled.

## Common mistakes

| Mistake | Fix |
|---|---|
| No retry logic around Azure SQL connections | Enable transient fault handling (e.g. EF Core `EnableRetryOnFailure`) everywhere |
| Choosing single database for a lift-and-shift needing cross-database queries/SQL Agent | Use Managed Instance instead |
| Assuming Basic/Standard Redis has clustering or persistence | Only Premium and above offer clustering, persistence, and VNet integration |
| Treating Redis as durable storage without enabling persistence | Enable RDB/AOF if Redis holds anything not trivially recomputable, or accept the data-loss risk explicitly |
| Using `allkeys-lru` when some keys must never be evicted | Use `volatile-lru`/`volatile-ttl` and only set TTL on genuinely evictable keys |
| Assuming failover groups change the connection string on failover | The listener endpoint stays constant; that's the entire point |

## Summary

Azure SQL's deployment options (single database, elastic pool, Managed Instance) and purchasing models (DTU, vCore, serverless, Hyperscale) trade isolation, cost predictability, and feature surface against operational simplicity, while failover groups and geo-replication provide regional resilience through a stable connection endpoint. Azure Cache for Redis complements rather than replaces SQL, absorbing latency-sensitive and ephemeral workloads, with tier choice (Basic through Enterprise) determining whether you get clustering, persistence, and private networking at all. The senior framing for both: know exactly what durability and availability guarantee you're buying at each tier, and never assume a default configuration gives you more resilience than it actually does.

## Top Interview Questions

### Q1. What's the difference between Azure SQL single database, elastic pools, and Managed Instance?

Single database is a fully isolated database with its own dedicated resources — simplest to reason about, best for one workload per database. An elastic pool lets many databases share a pool of DTUs or vCores, which is cost-effective when you have many databases (e.g. one per SaaS tenant) whose usage peaks don't all happen simultaneously — you provision for the aggregate, not the sum of individual peaks. Managed Instance provides near-complete SQL Server instance-level compatibility — cross-database queries, SQL Agent, Service Broker, linked servers — running inside your VNet, aimed specifically at lift-and-shift migrations from on-prem SQL Server that rely on instance-level features single database doesn't expose at all.

### Q2. Explain the difference between DTU-based and vCore-based purchasing models, including serverless and Hyperscale.

DTU-based pricing bundles compute, storage, and IO into fixed tiers (Basic/Standard/Premium) — simple to reason about but opaque about which resource is the bottleneck. vCore-based pricing bills compute and storage independently, lets you choose hardware generation, and supports Azure Hybrid Benefit to reuse existing SQL Server licences for a discount — better for workloads where you know your compute/storage ratio doesn't match a DTU tier well. Serverless is a vCore variant that auto-scales within a min/max vCore range and auto-pauses (billing only storage) during inactivity — good for spiky dev/test or low-traffic workloads, risky for latency-sensitive production due to cold-start delay after a pause. Hyperscale decouples storage from compute entirely, scaling storage to 100+ TB via a distributed storage layer with snapshot-based backups, so restore time stays fast regardless of database size — solving the specific problem of very large databases having painfully slow traditional restores.

### Q3. How do auto-failover groups work, and why do they matter for application design?

A failover group wraps one or more databases with asynchronous geo-replication to a secondary region, and — critically — exposes a stable, unchanging read-write listener endpoint (and a separate read-only listener) that the application always connects to. When a regional outage triggers failover (automatically, if configured, or manually), Azure repoints that listener to whichever region is now primary, so the application's connection string never needs to change — it just experiences a brief connection interruption during the cutover. This matters for application design because it means DR doesn't require any application-level region-awareness or configuration change; the only work needed on the app side is having transient fault retry logic to gracefully handle the brief reconnect during the actual failover event.

### Q4. What's the difference between active geo-replication and failover groups?

Active geo-replication is the underlying single-database primitive: it lets you create up to 4 readable secondary replicas of one database in different regions, with manual failover control per replica, and each secondary can be used for read scale-out or DR. Failover groups build on top of this for a group of one or more databases, adding the stable listener endpoint and, crucially, the option for **automatic** failover based on configurable policy (grace period before triggering), rather than requiring someone to manually initiate failover on each database. In practice, most production setups use failover groups rather than raw active geo-replication precisely because of the stable endpoint and automatic failover option, but understanding that failover groups are built on the geo-replication primitive helps explain behaviors like the async replication lag during failover.

### Q5. Why is transient fault handling mandatory for Azure SQL, and what happens if you skip it?

Azure SQL, as a multi-tenant PaaS service, can briefly throttle, drop, or reset connections during normal platform operations — load balancing, automatic failover, plan/patch changes, or transient network issues — none of which indicate a real outage, but a naive application without retry logic will surface these as user-facing errors or transaction failures. Skipping it means intermittent, hard-to-reproduce failures in production that look like "random flakiness" and erode trust in the platform, when in fact they're an expected, documented characteristic of the service. The fix is enabling a retry-on-transient-failure strategy (e.g. EF Core's `EnableRetryOnFailure`, or Polly-based retry policies for ADO.NET) that specifically retries the known set of transient SQL error codes with exponential backoff, and — critically — is transaction-aware so a retry re-runs the whole logical unit of work rather than committing a partial one.

### Q6. What is point-in-time restore, and what are its limits?

PITR lets you restore a database to any specific timestamp within the configured backup retention window (7 to 35 days by default for short-term retention), reconstructed from a combination of weekly full backups, more frequent differential backups, and continuous transaction log backups. It creates a **new** database rather than overwriting the existing one, so recovering from an accidental bad deployment or a bulk data-corruption bug means restoring to a new database and then reconciling/cutting over, not an instant in-place rollback. Its limits: it only covers the configured retention window (longer retention requires separately configured long-term retention backups, stored for months to years), and on Hyperscale the restore mechanism is snapshot-based rather than full backup replay, which is why Hyperscale restores stay fast even at very large database sizes.

### Q7. Compare the Redis tiers on Azure Cache for Redis — what do you actually give up on Basic and Standard?

Basic is a single node with no SLA and no replication — appropriate only for dev/test, since any node restart or failure loses the cache entirely with no failover. Standard adds a two-node replicated setup with a 99.9% SLA, giving basic high availability, but still no clustering (so total memory/throughput is capped to one node's size), no persistence (a full outage loses all data, though replication protects against a single node failure), and no VNet/private endpoint support. Premium is the first tier with clustering (sharding across up to 10 shards for capacity/throughput beyond one node), persistence (RDB/AOF so data survives a full restart), private endpoints/VNet integration, and geo-replication. Enterprise/Enterprise Flash tiers run the Redis Enterprise engine for a 99.99% SLA and support additional modules like RedisJSON and RediSearch. The practical takeaway: any production workload with real availability or data-loss requirements should start at Premium, not Standard.

### Q8. What Redis eviction policies exist, and how do you choose one?

Common policies: `noeviction` (reject writes once memory is full, returning an error), `allkeys-lru`/`allkeys-lfu` (evict least-recently/frequently-used keys regardless of TTL), `volatile-lru`/`volatile-lfu`/`volatile-ttl` (only evict among keys that have a TTL set, using LRU/LFU/nearest-expiry respectively), and `allkeys-random`/`volatile-random`. The choice depends on what Redis is being used for: a pure cache-aside cache typically uses `allkeys-lru` or `volatile-lru` so the least-useful data is dropped silently and regenerated from the source of truth on next access. If Redis is also holding data that must never silently disappear (a distributed lock, a queue, session state without a fallback), `noeviction` is safer because a write failing loudly is better than data disappearing invisibly — but that requires actually monitoring for and handling those write failures, and usually right-sizing memory so it's a rare event.

### Q9. Describe the cache-aside pattern and its failure modes.

In cache-aside, the application checks Redis first on a read; on a cache miss, it loads from the database, then populates the cache with a TTL before returning the result; writes typically go to the database and either invalidate or update the corresponding cache entry. Failure modes to design around: a **cache stampede**, where many concurrent requests miss the cache simultaneously (e.g. right after an entry expires) and all hammer the database at once — mitigated with request coalescing/locking around the cache-population step, or staggered TTLs (jitter) to avoid mass simultaneous expiry. Another is **stale reads after a write**, if the write path updates the database but doesn't invalidate/update the cache entry — leading to serving old data until the TTL naturally expires; a write-through or explicit cache invalidation on write closes this gap at the cost of extra write-path complexity.

### Q10. A production Redis cache is returning connection timeouts intermittently under load — what would you investigate?

I'd first check the instance's memory usage and eviction/fragmentation metrics — a cache near its memory limit or spending significant CPU on eviction/fragmentation can degrade latency for everything else. I'd check the tier and whether it's clustered — a single-shard Standard/Premium instance under high throughput can simply be undersized for the workload, in which case scaling up (more memory) or out (clustering with more shards) is the fix. I'd also check client-side connection pooling configuration — a common StackExchange.Redis mistake is creating a new `ConnectionMultiplexer` per request instead of a single long-lived, shared instance, which exhausts connections and causes exactly this symptom under load. Finally I'd check for "big key" or "hot key" patterns — a single very large value or a single key receiving disproportionate traffic can bottleneck one shard even when overall cluster capacity looks fine.

### Q11. When would you choose Azure SQL Hyperscale over General Purpose or Business Critical?

Hyperscale is the right choice once database size and backup/restore time become the actual constraint — General Purpose and Business Critical both scale storage up to a few TB with traditional backup/restore mechanisms whose duration grows with database size, which becomes painful for very large or rapidly growing OLTP databases. Hyperscale decouples storage into a separate, distributed layer that scales to 100 TB+ and uses storage snapshots for near-instant backups and fast restores regardless of database size, and it also allows scaling compute independently and quickly, including adding read replicas for scale-out reads. It's not automatically the right default for every workload though — Business Critical remains preferable when the absolute lowest write latency and built-in local SSD-backed HA (via Always On availability groups) matter more than storage scale, since Hyperscale's architecture introduces a small amount of additional write-path complexity through its log service tier.

### Q12. How would you decide whether a given workload needs Redis in front of Azure SQL at all?

I'd look at the actual read pattern and latency budget: if reads are dominated by a small number of hot, frequently-repeated queries (a product catalog, a user's profile, a leaderboard) where slightly stale data is acceptable, a cache in front of SQL meaningfully reduces both latency and database load, and is worth the added complexity of cache invalidation. If the workload is write-heavy, requires strong consistency on every read (financial balances, inventory counts feeding into other transactional logic), or has genuinely diverse, low-repeat query patterns where a cache would rarely hit, adding Redis mostly adds operational complexity and cache-invalidation bugs without a proportional latency win — in that case, I'd instead look at SQL-side optimizations (indexing, read replicas via geo-replication, query tuning) before reaching for a cache layer.
