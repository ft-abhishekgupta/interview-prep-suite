---
title: Caching Strategies
description: Where caches live in a system, the five core read and write patterns, how to pick a TTL and eviction policy, and how to size a cache with real numbers
difficulty: Foundational
tags: [caching, redis, performance, data-access-patterns]
---

Caching is the highest leverage-per-line-of-explanation topic in system design: a correct cache strategy can turn a database that falls over at scale into one that barely notices load. The trap is naming "add a cache" without saying which pattern, what gets evicted, and what happens on a miss.

## Where caches live

A request can be served from a cache at several layers before it ever reaches the source of truth, and each layer trades off differently.

![alt text](notes/05-HighLevelDesign/Caching/image.png)

| Layer | Example | Scope | Notes |
|---|---|---|---|
| Client | Browser cache, mobile app local storage | Single user | Fastest, but not server-controlled and can go stale silently |
| CDN / edge | Cloudflare, Front Door | Geographic region | Best for static or widely shared content |
| Gateway | API gateway response cache | All clients of one route | Good for public, cacheable API responses |
| Application | In-process (local) or Redis/Memcached (distributed) | One instance or the whole fleet | The layer most "caching strategy" discussions are about |
| Database | Query cache, buffer pool, materialized views | Within the database itself | Often already managed for you; still worth naming |

| Layer in practice | Reference |
|---|---|
| External / distributed cache — shared and scalable (Redis, Memcached); the default choice for anything the whole fleet needs to agree on | ![alt text](notes/05-HighLevelDesign/Caching/image-8.png) |
| In-process / in-memory cache — fastest possible access, but local to one instance, not shared (L1/L2/L3, plain RAM) | ![alt text](notes/05-HighLevelDesign/Caching/image-9.png) |
| CDN cache — caches static assets at edge servers close to users specifically to cut cross-region latency | ![alt text](notes/05-HighLevelDesign/Caching/image-10.png) |
| Client-side cache — lives on the browser/app, cuts server round trips but is not server-controlled and can go stale unnoticed | ![alt text](notes/05-HighLevelDesign/Caching/image-11.png) |

> [!KEY]
> The further from the origin data a cache sits, the cheaper the hit and the harder the invalidation. Pick the layer based on how shareable and how volatile the data is, not just "closest to the user is always best."

## The five core patterns

These describe how reads and writes interact with the cache and the source of truth (usually a database).

| Pattern | Read path | Write path | Best for |
|---|---|---|---|
| Cache-aside (lazy loading) | App checks cache, on miss reads DB and populates cache | App writes DB, then invalidates/updates the cache entry | **Default choice** — simple, only caches what's actually requested |
| Read-through | Cache itself loads from DB on a miss, transparent to the app | Usually paired with write-through | Simplifies app code; cache library owns the loading logic |
| Write-through | Reads hit cache | App writes to cache, cache synchronously writes to DB | Read-heavy data that also updates often; cache and DB never disagree |
| Write-behind (write-back) | Reads hit cache | App writes to cache, cache asynchronously flushes to DB later | Very write-heavy workloads that can tolerate a small durability window |
| Refresh-ahead | Cache proactively refreshes a hot key **before** it expires | N/A (background refresh, not driven by the write path) | Known-hot keys where a cache miss would be expensive and predictable |

![alt text](notes/05-HighLevelDesign/Caching/image-12.png){width=400}
![alt text](notes/05-HighLevelDesign/Caching/image-13.png){width=400}
![alt text](notes/05-HighLevelDesign/Caching/image-14.png){width=400}
![alt text](notes/05-HighLevelDesign/Caching/image-15.png){width=400}

### Cache-aside

The application owns the caching logic entirely: check cache, on miss read the database, then populate the cache for next time. A fleet of application servers checking a shared external cache first, and falling back to the database only on a miss, is the pattern in its simplest form:

![Application servers checking an external cache first and reading from the database as a fallback on a cache miss](notes/05-HighLevelDesign/AsyncSystems/image-8.png)

This is the most common pattern because it only caches data that is actually requested, and a cache outage simply means every read falls through to the database — degraded, not broken.

### Write-through

```mermaid
sequenceDiagram
    participant App
    participant Cache
    participant DB
    App->>Cache: write(key, value)
    Cache->>DB: write(key, value)
    DB-->>Cache: ack
    Cache-->>App: ack
```

Every write goes to the cache first, and the cache synchronously persists it to the database before acknowledging. Reads are always served from a warm cache because nothing is written without also being cached. The cost is write latency — every write now waits on both the cache and the database.

> [!TIP]
> Say the trade-off explicitly: *"Write-through guarantees the cache is never stale after a write, at the cost of slower writes. Write-behind flips that trade — fast writes, but a window where a cache failure can lose unflushed data."*

### Write-behind and refresh-ahead

Write-behind (write-back) acknowledges the write as soon as it hits the cache, then flushes to the database asynchronously in the background — batching writes for efficiency, but risking data loss if the cache crashes before the flush completes. Refresh-ahead is different in kind: it's not about writes at all, it's a background process that proactively re-fetches a key **before** its TTL expires, so a known-hot key never actually experiences a cache miss in the request path — useful when you can predict which keys are hot and a miss on them would be expensive.

> [!DANGER]
> Write-behind trades durability for write throughput. Never use it for data where losing the last few seconds of writes is unacceptable — payments, inventory counts, anything with a compliance requirement.

## Choosing a TTL

TTL is a bet: how long can this data be stale before it matters? A few anchors:

- **Reference data that rarely changes** (a product catalog entry, a country list) — TTL in hours or longer, or cache indefinitely with explicit invalidation on write.
- **Frequently updated, moderately tolerant data** (a user's follower count, a trending list) — TTL in seconds to minutes.
- **Data where staleness has real cost** (an inventory count near zero, a price) — very short TTL or skip caching in favor of write-through/invalidation.

## Eviction policies

When a cache is full, something has to go. The policy you pick changes what "hot" means.

| Policy | Evicts | Good for | Weakness |
|---|---|---|---|
| LRU (Least Recently Used) | The item not accessed for the longest time | General-purpose default, recency-biased workloads | A single large scan can evict genuinely hot items |
| LFU (Least Frequently Used) | The item accessed the fewest times overall | Workloads with stable "always popular" items | Slow to adapt when popularity shifts (old favorites linger) |
| FIFO | The oldest inserted item, regardless of access | Simple, predictable; streaming/log-like data | Ignores access pattern entirely — can evict hot data |
| Random | A random item | Very cheap to implement, surprisingly competitive at scale | No guarantees; unpredictable in a demo or a debugging session |

**Worth knowing: Redis does not evict by default** (`noeviction`); once you choose an LRU eviction policy such as `allkeys-lru` or `volatile-lru`, Redis implements it approximately by sampling a small set of keys rather than tracking true global recency. Exact LRU has memory and CPU overhead that is not worth it at scale.

![alt text](notes/05-HighLevelDesign/Caching/image-16.png)

## Local vs distributed cache

| | Local (in-process) | Distributed (Redis/Memcached) |
|---|---|---|
| Latency | Fastest — no network hop | Small network hop, still far faster than a DB |
| Shared across instances? | No — each instance has its own copy | Yes — one shared view across the whole fleet |
| Consistency across the fleet | Each instance can be stale differently | One place to invalidate |
| Memory cost | Multiplied by instance count | Paid once, shared |
| Failure blast radius | One instance's cache dying doesn't affect others | A shared cache outage affects the whole fleet — must degrade gracefully |

A common hybrid: a small local cache for extremely hot, rarely-changing data (feature flags, config) backed by a distributed cache for everything else, trading a little consistency lag for the lowest possible latency on the hottest keys.

## Cache sizing and hit-ratio math

Sizing follows the same recipe as any capacity estimate: size for the **working set**, not the whole dataset.

```text
Working set = daily active items x average item size
1,000,000 active users x 2 KB session data = 2 GB → single Redis instance, easily
```

Hit ratio is the number that tells you whether the cache is actually earning its keep:

```text
Hit ratio = cache hits / (cache hits + cache misses)
```

| Hit ratio | What it usually means |
|---|---|
| > 95% | Cache is well-sized and TTL/eviction policy match the access pattern |
| 80–95% | Healthy for most workloads; still worth checking if a few hot keys dominate |
| < 80% | Investigate: is the cache too small, TTL too short, or the key design fragmenting the cache? |

> [!WARNING]
> A low hit ratio does not automatically mean "add more memory." First check whether the cache key design is fragmenting identical data into many keys (the same trap as CDN cache keys), and whether the TTL is shorter than the actual request interval for most items.

## CDNs: pull vs push

A CDN is a geographically distributed network of edge servers that cache content close to users instead of serving every request from a single origin — it is the edge-cache layer, and it is worth naming because the interview question "how does content get onto the edge" has a specific two-answer shape.

| CDN model | How it populates the edge | Best for |
|---|---|---|
| Pull-based | An edge server caches content the first time it is requested, then serves subsequent requests from that cache until it expires | Long-tail content where pre-populating every edge would waste storage |
| Push-based | The origin proactively pushes content to edge servers ahead of demand | A small, known set of assets you want warm everywhere before traffic arrives (a launch, a release) |

> [!TIP]
> Say the trade explicitly: pull-based CDNs are simpler and self-managing but pay a slower "first request per edge" cost; push-based CDNs avoid that cold edge but require you to know in advance what to distribute and where.

The origin server is only involved for dynamic content or a genuine cache miss — that is the entire point of a CDN, and it is why static assets (images, video, JS/CSS bundles) belong there, while a personalized API response usually does not.

## Framing this out loud in an interview

The strongest caching answers name the layer, the pattern, and the failure mode in that order — "I'd put a distributed cache in front of the database, using cache-aside so a cache outage degrades to direct database reads instead of an outage" is a complete, scoreable sentence on its own.

![alt text](notes/05-HighLevelDesign/Caching/image-1.png)

![alt text](notes/05-HighLevelDesign/Caching/image-2.png)

## Cheat sheet

- Pick a layer by how shareable and how volatile the data is — client, CDN, gateway, app, or DB.
- Cache-aside is the default: app-managed, only caches what's requested, degrades gracefully on cache failure.
- Write-through keeps cache and DB in sync at the cost of write latency; write-behind is the inverse trade.
- Refresh-ahead proactively renews known-hot keys before they expire — no miss in the request path.
- TTL is a bet on staleness tolerance — shorter for volatile/high-cost-of-staleness data.
- LRU is the sane general default; LFU for stable popularity; FIFO/random for simplicity over precision.
- Local cache = fastest but not shared; distributed cache = shared but a network hop.
- Size for the working set, not the whole dataset.
- Hit ratio below ~80% is a signal to investigate cache key design and TTL, not just add memory.
- Pull-based CDNs populate the edge on first request; push-based CDNs pre-warm it ahead of demand.
- State it as layer → pattern → failure mode: which layer, which read/write pattern, and what happens on a miss.

## Common mistakes

| Mistake | Fix |
|---|---|
| Saying "add a cache" with no named pattern | Specify cache-aside, write-through, write-behind, etc., and why |
| Using write-behind for data that can't tolerate loss | Reserve write-behind for workloads where async durability risk is acceptable |
| Setting one TTL for everything | Vary TTL by how volatile and how costly staleness is per data type |
| Sizing the cache for the entire dataset | Size for the working set; monitor and adjust based on hit ratio |
| Assuming a distributed cache never fails | Design the read path to degrade to the DB directly if the cache is down |
| Ignoring eviction policy entirely | State a policy (usually LRU) and why it fits the access pattern |
| Treating local cache as a substitute for a distributed one | Use local cache only for small, very hot, rarely-changing data |

## Summary

Caching strategy is choosing where a cache lives, which read/write pattern governs it, how long entries live, and what gets evicted when it's full — and every one of those choices should be justified by the actual access pattern, not applied uniformly. Cache-aside is the sensible default for most reads; write-through and write-behind trade write latency against durability risk; TTL and eviction policy should track how volatile and how costly staleness is. The final gut check is always the hit ratio: it tells you whether the cache design actually matches how the data is really being accessed.

## Top Interview Questions

### Q1. What's the difference between cache-aside and read-through caching?

In cache-aside, the application itself owns the caching logic: it checks the cache, and on a miss, reads from the database and explicitly writes the result back into the cache. In read-through, that loading logic is pushed into the cache layer itself — the application just asks the cache for the value, and the cache transparently fetches from the database on a miss without the application needing to know that happened. Cache-aside is more common because it requires no special cache library support and only caches data that's actually been requested; read-through can simplify application code but requires a cache implementation that supports pluggable loaders.

### Q2. When would you choose write-through over write-behind, and what are you trading?

Write-through synchronously writes to both the cache and the database before acknowledging the write, guaranteeing the cache is never stale relative to the database — the cost is higher write latency since every write waits on two systems. Write-behind acknowledges the write as soon as it hits the cache and flushes to the database asynchronously afterward, giving much lower write latency and the ability to batch database writes efficiently, at the cost of a durability window where a cache failure before the flush completes can lose data. I'd choose write-through for anything where correctness matters more than write speed — inventory, payments — and write-behind only where the workload is write-heavy and losing a few seconds of the most recent writes on a rare cache failure is genuinely acceptable.

### Q3. What is refresh-ahead caching and how is it different from a normal TTL expiry?

With a normal TTL, a key simply expires and the next request after expiry experiences a cache miss, paying the full cost of reloading from the source. Refresh-ahead instead proactively reloads a key in the background shortly before its TTL would expire, so a request for that key never actually experiences a miss in the foreground request path. This only makes sense for keys you can identify as reliably hot in advance — applying it to every key would mean constantly refreshing data nobody is currently requesting, wasting load on the source system for no benefit.

### Q4. How does Redis implement LRU eviction when configured for it, and why doesn't it track exact recency for every key?

Redis's default policy is `noeviction`, so it returns errors when the memory limit is hit rather than evicting keys. If you configure an LRU policy (`allkeys-lru` or `volatile-lru`), Redis uses an approximated LRU: rather than maintaining a perfectly ordered list of every key by last-access time (which would require metadata updates on every read), it samples a small random set of keys, checks their recency metadata, and evicts the least recently used among that sample. This gives a result close to true LRU with far less overhead, and the sample size is tunable.

### Q5. A cache has a 60% hit ratio and the team wants to just add more memory. What would you check first?

I wouldn't add memory as the first move — I'd check whether the low hit ratio is actually a capacity problem or a design problem. First, I'd look at the cache key design: are near-identical requests being treated as different keys due to something like an unnecessary parameter being included in the key, fragmenting what should be shared entries? Second, I'd check the TTL against the actual request interval for the data — if items expire faster than they're re-requested, you'll always see high miss rates regardless of memory size. Only after ruling those out would I look at whether the working set genuinely exceeds current capacity and needs more memory or a different eviction policy.

### Q6. What's the difference between a local (in-process) cache and a distributed cache like Redis, and when would you use both together?

A local cache lives in each application instance's own memory — fastest possible access with no network hop, but not shared, so each instance can hold a different, independently-stale copy, and the total memory cost multiplies by the number of instances. A distributed cache like Redis is a separate shared service that every instance calls over the network — slightly slower than local memory but consistent across the whole fleet and paid for once. I'd use both together for a small set of extremely hot, rarely-changing values, like feature flags or config, kept in a local cache for the lowest possible latency, backed by a distributed cache (or the source of truth) as the fallback and source of updates.

### Q7. Why is cache-aside considered the "default" pattern, and what happens if the cache goes down under cache-aside versus write-through?

Cache-aside is the default because it's simple to reason about, requires no special cache library behaviour, and importantly, only caches data that's actually been requested rather than pre-populating everything. If the cache goes down under cache-aside, every read simply falls through to the database directly — the system is slower, not broken, because the application was already written to handle a cache miss as a normal code path. Under write-through, a cache outage is more dangerous on the write side specifically if the cache is in the critical path of acknowledging writes — depending on the implementation, writes might block or fail entirely if the cache can't be reached, which is why the failure mode of each pattern needs to be reasoned about explicitly, not just the happy path.

### Q8. How would you decide the TTL for user session data cached in Redis?

I'd tie the TTL to the actual session lifetime policy rather than an arbitrary number — if a session should expire after 30 minutes of inactivity, I'd set the Redis TTL to roughly that window and refresh it (extend the TTL) on each active request, so an active user's session never unexpectedly expires mid-use while an abandoned session cleans itself up automatically. This also conveniently uses Redis's TTL mechanism as the session expiry mechanism itself, rather than needing a separate cleanup job to remove old sessions — one less piece of infrastructure to maintain.

### Q9. What eviction policy would you pick for a leaderboard cache versus a product catalog cache, and why?

For a leaderboard, access patterns tend to concentrate on a small set of top entries that stay popular for a while, so LFU (least frequently used) fits well — it keeps consistently popular entries around even through brief lulls in traffic. For a general product catalog where popularity shifts more with trends, promotions, and recency (a product just went on sale and is suddenly hot), LRU tends to fit better because it adapts faster to what's recently been accessed rather than anchoring on historical frequency. Neither is a universal rule — I'd state the reasoning based on the actual access pattern rather than picking one by default.

### Q10. Your write-behind cache acknowledges a write, but the process crashes before flushing to the database. What are the implications, and how would you reduce the risk?

The write is lost from the database's perspective even though the client was told it succeeded — this is the core durability risk of write-behind, and it's why the pattern should never be used for data where that loss is unacceptable, like financial transactions. To reduce the blast radius, I'd shorten the flush interval or batch size so less data is ever "in flight" unflushed at any moment, consider persisting the write-behind queue itself somewhere durable (like a write-ahead log or a small durable queue) rather than only in cache memory, and make sure monitoring can detect and alert on a growing unflushed backlog, which would indicate the database is falling behind or unreachable well before a crash actually causes data loss.

### Q11. How would you cache a computed, expensive aggregate value — like "average rating" for a product — that updates on every new review?

I'd avoid write-through's synchronous approach here since a rating recompute might be non-trivial, and instead use cache-aside for reads combined with an explicit cache invalidation (or in-place update) triggered by the write path whenever a new review is added: recompute the aggregate, write it to the cache directly (or delete the key so the next read recomputes it), rather than waiting for a TTL to naturally expire. If recomputing the full aggregate on every single review is expensive at high review volume, I'd consider incrementally updating a cached running sum and count rather than recomputing from scratch, and only periodically reconcile against the database to correct any drift.

### Q12. When would you decide caching isn't worth adding at all for a given read path?

If the read path is already fast enough relative to the latency budget without a cache — say, an indexed database query consistently returning in a few milliseconds and well within an SLA — adding a cache introduces invalidation complexity, a new failure mode, and staleness risk for a latency win nobody actually needs. I'd also skip caching for data that changes on essentially every read (a real-time counter incremented by every request) where the hit ratio would be near zero anyway, and for highly sensitive data where the risk of a stale or leaked cached copy outweighs the performance benefit. Caching should be justified by a measured or estimated bottleneck, not added reflexively to every read path.
