---
title: Redis Caching Patterns
description: Cache-aside versus write-through, TTL and eviction strategy, stampede and hot-key mitigation, and what to do when Redis itself goes down
difficulty: Core
tags: [redis, caching, performance, distributed-systems]
---

Caching is simple to describe and easy to get subtly wrong — the ordering of two operations, a missing jitter on a TTL, or an unprotected cache-miss stampede are the kind of production incidents that come up directly in interviews. This page covers the patterns and the failure modes together.

## Cache-aside (lazy loading)

The application owns the cache; Redis never talks to the database itself. The ordering on writes matters more than it looks.

```mermaid
sequenceDiagram
    participant App
    participant Cache
    participant DB
    App->>Cache: GET key
    Cache-->>App: miss
    App->>DB: SELECT ...
    DB-->>App: row
    App->>Cache: SET key value EX ttl
    App-->>App: return row
```

```csharp
// Read path: cache-aside
async Task<Product> GetProductAsync(int id) {
    var cached = await _cache.StringGetAsync($"product:{id}");
    if (cached.HasValue) return JsonSerializer.Deserialize<Product>(cached!);

    var product = await _db.Products.FindAsync(id);
    if (product is not null) {
        await _cache.StringSetAsync($"product:{id}",
            JsonSerializer.Serialize(product), TimeSpan.FromMinutes(10));
    }
    return product;
}

// Write path: update DB, then invalidate (don't try to update the cache in place)
async Task UpdateProductAsync(Product p) {
    await _db.SaveChangesAsync();          // 1. DB is the source of truth, write it first
    await _cache.KeyDeleteAsync($"product:{p.Id}"); // 2. then invalidate — next read repopulates
}
```

> [!KEY]
> On writes, **update the database first, then delete the cache key** — never update the cache in place. If the delete fails or races with a concurrent read, the worst case is a stale cache that self-heals on the next TTL expiry, not permanently wrong data serving from an update that silently didn't apply.

## Write-through and write-behind

| Pattern | How it works | Read latency | Write latency | Risk |
|---|---|---|---|---|
| Cache-aside | App checks cache, falls back to DB, populates cache on miss | Fast after warm-up | Normal (DB only) | Cache and DB can briefly disagree after a write |
| Write-through | Every write goes to cache and DB together, synchronously | Always fast (cache always warm) | Slower (two writes, one blocking) | Simpler consistency, but write latency includes cache round trip |
| Write-behind (write-back) | Write goes to cache immediately; DB write is queued/async | Fast | Fastest (DB write deferred) | Data loss risk if the process crashes before the queued write flushes |

Write-through suits read-heavy data where writes can tolerate a little extra latency; write-behind suits extremely write-heavy paths (metrics, activity logs) where eventual durability is acceptable.

## TTL strategy and jitter

A fixed TTL across millions of keys set at the same time (e.g., a bulk cache-warm) causes them to **expire together**, producing a thundering herd of cache misses hitting the database simultaneously. Add random jitter to spread expiry:

```csharp
var ttl = TimeSpan.FromMinutes(10) + TimeSpan.FromSeconds(Random.Shared.Next(0, 60));
await _cache.StringSetAsync(key, value, ttl);
```

Jitter is a five-minute fix that prevents an entire class of "why did the database fall over at exactly :00 every hour" incidents — it costs nothing and is worth adding to every bulk cache population path by default.

## Eviction policies

When Redis hits `maxmemory`, it needs a policy for what to evict:

| Policy | Behaviour | Use when |
|---|---|---|
| `noeviction` | Reject writes with an error once full | You use Redis as a primary store, not a cache — data loss is unacceptable |
| `allkeys-lru` | Evict least-recently-used key, any key | General-purpose cache, no TTLs set |
| `volatile-lru` | Evict least-recently-used key, only among keys with a TTL | Mixed cache + persistent data in one instance |
| `allkeys-lfu` | Evict least-frequently-used key, any key | Access frequency matters more than recency (e.g., popular vs one-off lookups) |
| `volatile-ttl` | Evict the key with the nearest expiry first, among keys with a TTL | You want expiry-driven eviction rather than usage-driven |
| `allkeys-random` / `volatile-random` | Evict a random key | Cheap, rarely the right choice outside benchmarking |

> [!TIP]
> `allkeys-lru` is the safe default for a pure cache. Only reach for `allkeys-lfu` if you've actually measured a skewed access pattern (a small set of keys read far more than the rest) — LFU costs a bit more bookkeeping per access.

## Measuring hit ratio

`hit ratio = cache hits / (cache hits + cache misses)`, available directly via `INFO stats` (`keyspace_hits`, `keyspace_misses`). A ratio below ~80–90% for a hot path usually means TTLs are too short, the working set doesn't fit in memory (check `evicted_keys`), or the cache key design is too granular (fragmenting what should be one cacheable object into many rarely-reused ones).

## Cache stampede

A stampede happens when a hot key expires and hundreds of concurrent requests all miss at once, all hammering the database to recompute the same value simultaneously.

| Mitigation | How |
|---|---|
| Locking (mutex) | First request to miss takes a short-lived `SET lock:key token NX PX 5000`; others wait/retry or serve stale data briefly |
| Early recompute | Recompute the value slightly *before* expiry (e.g., at 90% of TTL) so it never actually goes cold |
| Request coalescing | In-process, deduplicate concurrent identical DB calls into one (a single in-flight `Task` shared by all callers) |

> [!DANGER]
> Without stampede protection, a single hot cache key expiring under load can turn into a self-inflicted denial-of-service against your own database — this is one of the most common real-world Redis incidents.

## Hot keys and negative caching

A **hot key** — one key read far more than any other (a viral post, a celebrity profile) — can saturate a single Redis shard even though overall cluster load looks fine, because one key always lives on one node. Mitigate with a short-lived **local (in-process) cache** in front of Redis for the hottest handful of keys, or by replicating the hot value under several key suffixes and randomly picking one client-side.

**Negative caching** — caching the fact that a lookup found nothing (`null`, with a short TTL) — protects against **cache penetration**: repeated requests for a key that will never exist (a scraped/invalid ID, a deliberate attack) that would otherwise always miss the cache and always hit the database.

## Invalidation and the consistency window

Deleting a cache key on write, rather than updating it in place, is deliberate: it avoids a race where two concurrent writers could leave the cache holding the *older* write's value. The trade-off is a small window between the DB commit and the next read where the cache is cold and the read falls through to the database — usually milliseconds, and acceptable for the vast majority of use cases. If even that window is unacceptable (e.g., a balance shown immediately after a user's own write), read-your-writes can be handled by bypassing the cache for that specific request.

## When Redis is down

Cache-aside degrades gracefully by design: if Redis is unreachable, catch the exception and fall through to the database, optionally logging or emitting a metric, rather than failing the request.

```csharp
async Task<Product> GetProductAsync(int id) {
    try {
        var cached = await _cache.StringGetAsync($"product:{id}");
        if (cached.HasValue) return JsonSerializer.Deserialize<Product>(cached!);
    } catch (RedisConnectionException) {
        _metrics.Increment("cache.unavailable"); // degrade, don't fail the request
    }
    return await _db.Products.FindAsync(id);
}
```

> [!WARNING]
> If Redis being down means the database instantly receives 100% of traffic it normally doesn't see, "degrade gracefully" can still cause an outage by overload. Pair graceful degradation with a circuit breaker or request shedding if the DB can't absorb full load.

## Cheat sheet

- Cache-aside: on write, update the DB then delete the cache key — never update the cache in place.
- Write-through trades write latency for always-warm reads; write-behind trades durability for the fastest writes.
- Add jitter to TTLs to prevent synchronized mass expiry (thundering herd).
- Default eviction policy for a pure cache: `allkeys-lru`. Use `volatile-*` variants when persistent and cacheable data share one instance.
- Hit ratio = hits / (hits + misses), from `INFO stats` — investigate below ~80–90% on hot paths.
- Prevent stampedes with a short lock on recompute, or refresh before expiry, not after.
- Cache negative results (with a short TTL) to stop penetration attacks/scraping from hammering the DB.
- Design for Redis being unavailable: fall through to the DB, but protect the DB with a circuit breaker.

## Common mistakes

| Mistake | Fix |
|---|---|
| Updating the cache in place on write instead of invalidating | Update DB, then delete the cache key |
| Setting the same TTL on every key in a bulk warm-up | Add random jitter to spread expiry |
| No protection against concurrent cache-miss recompute | Add a short recompute lock or refresh-ahead of expiry |
| Treating a cache miss on a non-existent ID the same as a hit-worthy miss | Cache negative results with a short TTL |
| Assuming Redis is always up | Catch connection errors and fall through to the DB, with a circuit breaker to protect it |
| Picking `allkeys-lfu` without measuring access skew | Default to `allkeys-lru`; switch only with evidence |

## Summary

Redis caching patterns are less about the Redis commands themselves and more about the surrounding discipline: invalidate rather than update in place, jitter your TTLs, protect hot keys and stampedes, cache negative results, and always have a defined behaviour for when Redis is unavailable. Getting the write-path ordering right (DB then cache-delete) and having an explicit stampede-mitigation strategy are the two details that separate a working cache from one that causes its own outages under load.

## Top Interview Questions

### Q1. Walk through cache-aside and explain why the write path deletes the cache key instead of updating it.

On read, the application checks the cache first; on a miss it reads the database and populates the cache with a TTL. On write, the correct order is: commit the change to the database (the source of truth), then delete the corresponding cache key — never write the new value directly into the cache. Deleting avoids a race where two concurrent writers could interleave such that the cache ends up holding the *older* value indefinitely (writer A updates DB, writer B updates DB and cache, writer A then overwrites the cache with its now-stale value). Deleting means the next read simply repopulates from the database, which is always correct by construction.

### Q2. Compare write-through and write-behind caching. What's the failure mode of write-behind?

Write-through writes to the cache and the database synchronously as part of the same operation, so reads are always served from a warm cache but writes pay the latency of both stores. Write-behind (write-back) writes to the cache immediately and returns, queuing the database write to happen asynchronously — this gives the lowest possible write latency but introduces a durability gap: if the process or cache crashes before the queued write flushes to the database, that data is lost. Write-behind is only appropriate where some data loss is tolerable (metrics, activity logs, analytics counters), never for anything that must be durable the instant a write is acknowledged.

### Q3. What is a cache stampede, and how would you prevent one?

A stampede happens when a popular ("hot") cache key expires and a large number of concurrent requests all miss simultaneously, each independently recomputing the same expensive value and hitting the database at once — turning one expiry event into a burst of duplicate load. I'd prevent it with either a short-lived lock (`SET lock:key token NX PX 5000`) so only the first request recomputes while others wait briefly or serve slightly stale data, or with early/proactive recompute, refreshing the value at, say, 90% of its TTL so it's never actually allowed to go cold under load. In-process request coalescing (deduplicating concurrent identical calls into a single shared task) helps further within one server instance.

### Q4. How do you decide which eviction policy to use for a Redis cache?

I'd default to `allkeys-lru` for a pure cache — it evicts the least-recently-used key regardless of whether a TTL is set, which is the safest general-purpose choice. If the same Redis instance holds both cacheable data and data that must never be evicted (session data with no TTL, for instance), I'd use `volatile-lru` so eviction only ever touches keys that explicitly have a TTL. I'd only move to `allkeys-lfu` if I had actual evidence of a skewed access pattern — a small number of keys read disproportionately more than the rest — since LFU's frequency tracking has a small overhead that isn't worth paying without a measured reason. `noeviction` is for when Redis is a primary data store, not a cache, where losing data on eviction would be unacceptable.

### Q5. How do you measure whether a cache is actually effective, and what would a low hit ratio tell you to investigate?

Hit ratio, computed as `hits / (hits + misses)`, is directly available from `INFO stats` (`keyspace_hits` and `keyspace_misses`). A ratio below roughly 80–90% on a path expected to be cache-friendly points to one of three causes: TTLs set too short relative to how often the data is actually re-read, the working set exceeding available memory (check `evicted_keys` — if it's climbing, you're evicting things before they're reused), or a cache key design that's too fragmented, splitting what should be one reusable cached object into many narrowly-scoped keys that rarely get hit twice. I'd check `evicted_keys` first since it's the cheapest signal to distinguish "too small" from "too short" or "badly keyed."

### Q6. What is cache penetration, and how does negative caching solve it?

Cache penetration is repeated lookups for a key that doesn't exist and never will — a scraped or guessed invalid ID, or a deliberate attack — which always misses the cache (since there's nothing to cache) and always falls through to hit the database, defeating the entire purpose of the cache for that traffic. Negative caching solves this by explicitly caching the "not found" result itself, with a short TTL, so repeated lookups for the same non-existent key are absorbed by the cache instead of the database. The TTL should be short relative to positive-result TTLs, since a negative result becoming stale (the item is created shortly after) has a real cost — a short window is a fair trade against protecting the database from a sustained attack pattern.

### Q7. What happens to your application if Redis becomes unavailable, and how should you design for it?

If the caching code doesn't explicitly handle connection failures, an unavailable Redis instance will throw exceptions on every cache call and can take down the whole request path even though the actual source of truth (the database) is fine. The fix is to catch cache-specific exceptions around both the read and write paths and fall through to the database, logging or emitting a metric so the degradation is visible rather than silent. The follow-up danger to name explicitly: if Redis absorbs a large fraction of read traffic normally, "fall through to the DB" can itself overload the database the instant Redis disappears — so graceful degradation should be paired with a circuit breaker or request-shedding so the database isn't handed 100% of traffic it was never sized for.

### Q8. A specific key — say, a viral post's like count — is causing latency spikes even though overall Redis CPU and memory look healthy. What's going on and what would you do?

This is a hot key problem: because a single key always lives on one node/shard (even in a clustered deployment), extreme read (or write) concentration on that one key can saturate that shard's single-threaded command processing even while the cluster's aggregate metrics look fine. I'd mitigate by adding a short-lived local (in-process) cache in front of Redis specifically for the hottest handful of keys — even a few hundred milliseconds of local caching removes the vast majority of the load — or by sharding the hot key itself into several suffixed copies (`likes:post123:0` through `likes:post123:9`) that clients pick between randomly and sum periodically, spreading the load across nodes at the cost of slightly stale aggregation.

### Q9. Why is jitter important when setting TTLs, and what real incident does it prevent?

If a large batch of keys is cached at the same time with an identical, fixed TTL — a nightly cache warm-up, or a burst of first-requests after a deploy — they will all expire at exactly the same moment, causing every one of those keys to miss simultaneously and hammer the database with the same burst of recompute load, effectively a self-inflicted thundering herd. Adding a small random jitter to the TTL (e.g., base 10 minutes plus 0–60 random seconds) spreads those expirations out over a window instead of a single instant, turning a spike into a smooth trickle of cache-repopulation traffic. It's a nearly free change that prevents a very real and recurring class of "why did the database spike at the top of every hour" incidents.

### Q10. Should a write-through cache ever also need a stampede-prevention strategy?

Less often, but yes in one specific case: if a write-through cache entry is evicted under memory pressure (not expired via TTL, but pushed out by an eviction policy) and then re-read by many concurrent readers before the write path repopulates it, that's functionally the same stampede as a TTL expiry — many concurrent misses recomputing the same value. Since write-through keeps the cache warm on the write path but doesn't protect against eviction-driven cold reads, the same short-lived-lock or request-coalescing mitigation applies. In practice this is rarer than TTL-driven stampedes because write-through caches are usually sized to avoid eviction, but it's worth naming to show you understand the mechanism, not just the TTL case.

### Q11. How would you implement cache-aside with StackExchange.Redis so that a failure to write to the cache never breaks the request?

The cache write is an optimisation, not a correctness requirement, so it should never be allowed to fail the caller's request — wrap it in a try/catch that logs and continues rather than propagating:

```csharp
async Task<Product> GetProductAsync(int id) {
    var db = _db.Products;
    var cacheKey = $"product:{id}";
    try {
        var cached = await _cache.StringGetAsync(cacheKey);
        if (cached.HasValue) return JsonSerializer.Deserialize<Product>(cached!);
    } catch (RedisException) { /* log, degrade */ }

    var product = await db.FindAsync(id);
    try {
        if (product is not null)
            await _cache.StringSetAsync(cacheKey, JsonSerializer.Serialize(product), TimeSpan.FromMinutes(10));
    } catch (RedisException) { /* log, degrade — the read still succeeds */ }
    return product;
}
```

The key design point: both the read-from-cache and write-to-cache calls are wrapped independently, so a Redis outage degrades the request to "always hits the database," never to "the request fails." In a real service I would also emit a metric on both catch blocks and put a circuit breaker around cache calls after repeated failures; otherwise every request can spend time timing out against Redis before falling back, which protects correctness but still damages latency and can overload the database.
