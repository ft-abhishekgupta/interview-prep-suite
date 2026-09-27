---
title: Cache Pitfalls and Invalidation
description: The failure modes caching introduces such as stampede, hot keys, penetration and avalanche, the standard fixes for each, and how to survive a cache outage
difficulty: Advanced
tags: [caching, reliability, distributed-systems, failure-modes]
---

Every cache you add is also a new way for a system to fail. The patterns in this page are the ones interviewers reach for specifically to test whether you understand caching's failure modes, not just its happy path — and "the site goes down" is never an acceptable answer to "what happens if the cache fails?"

## Cache stampede (thundering herd)

A stampede happens when a single hot key expires or is invalidated, and a large burst of concurrent requests for that exact key all miss the cache at once, all hammering the database simultaneously to recompute the same value.

![alt text](notes/05-HighLevelDesign/Caching/image-17.png){width=500}

```mermaid
sequenceDiagram
    participant R1 as Request 1
    participant R2 as Request 2
    participant R3 as Request 3
    participant Cache
    participant DB
    Note over Cache: key expires
    R1->>Cache: get(key)
    Cache-->>R1: miss
    R2->>Cache: get(key)
    Cache-->>R2: miss
    R3->>Cache: get(key)
    Cache-->>R3: miss
    R1->>DB: recompute
    R2->>DB: recompute
    R3->>DB: recompute
    Note over DB: 3x load for 1 logical fetch
```

| Fix | How it works |
|---|---|
| Request coalescing / single-flight | The first request to miss acquires a lock and recomputes; concurrent requests for the same key wait for that result instead of each hitting the DB |
| Probabilistic early expiry | Each read has a small, increasing chance of refreshing the value **before** it actually expires, spreading recomputation out over time instead of at one instant |
| Locking (mutex per key) | A distributed lock (e.g. Redis `SET NX`) ensures only one process recomputes a given key at a time; others either wait or serve stale data briefly |
| Never let hot keys expire | For known always-hot keys, use refresh-ahead so there's no expiry moment to stampede at all |

> [!KEY]
> A stampede is fundamentally a **coordination** problem — many workers doing redundant work at the same instant. Every fix is some form of "let one worker do the work, make the rest wait or serve something slightly stale."

A related but distinct race shows up even without an expiry event: two separate worker instances independently check the cache at the same moment, both find the key absent, and both proceed to recompute and write it. This is a classic distributed read-modify-write race, not a stampede, and the fix is the same coordination primitive — an atomic `SET NX` (set-if-not-exists) or an equivalent distributed lock guarantees only one writer wins even when two processes miss at the exact same instant.

## Hot keys

A hot key is a single key that receives disproportionate traffic — a viral post, a celebrity's profile, a flash-sale product — to the point that it saturates a single cache node or shard, even though the rest of the cache is healthy.

![alt text](notes/05-HighLevelDesign/Caching/image-19.png){width=500}

> [!WARNING]
> Consistent hashing distributes *different* keys across nodes, but it does nothing for a *single* key that is simply too hot for any one node to handle alone. That's a distinct problem from uneven key distribution.

Fixes:

- **Key splitting / sharding a single key** — store the value under `key:0` through `key:9` and pick a shard on read (round robin or random); writes update all shards, or one shard with async replication to the others.
- **Local (in-process) fallback cache** for the hottest keys, so a large share of reads never even reach the distributed cache for that key.
- **Read replicas** of the specific hot node, so traffic for that key is spread across several replicas of it rather than one instance.
- **Client-side caching with a short TTL**, shaving off a share of requests before they even leave the application server.

## Cache penetration

Penetration is repeated requests for keys that **do not exist** in the database at all — every request is a guaranteed miss, so it always falls through to the database, bypassing the cache's benefit entirely. This can happen accidentally (a buggy client retrying an invalid ID) or maliciously (an attacker scanning IDs or probing for data that isn't there).

| Fix | How it works |
|---|---|
| Negative caching | Cache the "not found" result itself, with a short TTL, so repeated lookups of the same missing key don't all hit the database |
| Bloom filter | A probabilistic set that can definitively say "this key **cannot** exist" before even checking the cache or DB — filters out most nonexistent-key lookups for near-zero memory cost |
| Input validation | Reject obviously malformed or out-of-range IDs at the edge before they ever reach the cache or database layer |

**Precisely state the bloom filter trade-off:** it has false positives but never false negatives — it might occasionally say a key could exist when it doesn't, sending a small number of extra lookups through, but it will never wrongly filter out a key that's actually there.

## Cache avalanche

An avalanche is what happens when a **large number of different keys** expire at the same moment — often because they were all cached with the same fixed TTL at roughly the same time (e.g. a bulk cache warm-up) — causing a broad, simultaneous wave of cache misses across many keys at once, rather than a stampede on one key.

| Fix | How it works |
|---|---|
| TTL jitter | Add a small random offset to each key's TTL (`base_ttl + random(0, N)`) so expirations spread out over time instead of clustering |
| Staggered cache warming | Populate the cache gradually rather than all at once, so entries naturally have staggered expiry times |
| Multi-tier caching | A local cache in front of the distributed cache absorbs some of the miss traffic even if the distributed layer's keys all expire together |

> [!DANGER]
> Cache avalanche and cache stampede are frequently confused. Stampede = many requests for **one** key at once; avalanche = many **different** keys expiring at once. The fixes are different — coalescing/locking for stampede, TTL jitter for avalanche.

## Stale reads and consistency

Every cache introduces a window where the cache and the source of truth can disagree — this is unavoidable, so the real design question is how much staleness is tolerable and how it's bounded.

![alt text](notes/05-HighLevelDesign/Caching/image-18.png){width=500}

| Approach | Consistency behaviour |
|---|---|
| TTL only | Cache can be stale for up to the full TTL after any write |
| Invalidate-on-write | Cache is correct immediately after a write, assuming the invalidation itself doesn't fail or race |
| Write-through | Cache and DB are updated together — no staleness window from writes, only from the small propagation time |
| Versioned reads (ETag/version number) | The client can detect staleness itself and decide whether to accept it or force a refresh |

**Invalidate-on-write has its own race**: if a write completes and invalidates the cache, but a concurrent read had already started fetching the old value from the DB, that read can repopulate the cache with stale data right after the invalidation. This is why some systems favor a short TTL as a safety net even when they also invalidate explicitly on write.

## Invalidation strategies, compared

| Strategy | Trigger | Best for |
|---|---|---|
| TTL expiry | Time passes | Data that's fine being briefly stale, or where writes are infrequent |
| Explicit delete-on-write | Application code deletes the key after writing the DB | Data where staleness after a write is unacceptable |
| Tag-based invalidation | Purge all keys sharing a tag (e.g. "everything about product X") | Data cached under many derived keys from one underlying entity |
| Event-driven invalidation (CDC) | A change-data-capture stream triggers invalidation as a side effect of the DB write | Decouples invalidation from the write path itself; survives writes that bypass the usual code path |

"There are only two hard things in computer science: cache invalidation and naming things" is a cliché for a reason — invalidation bugs are usually subtle races, not obviously wrong code, which is why explicit, well-tested invalidation paths matter more than clever cache logic.

## What happens when the cache goes down

This is the single most important production question about caching, and "the site dies" is always the wrong answer if the system was designed correctly.

> [!KEY]
> A cache should be an optimization, never a dependency. If a cache outage takes the whole system down, the cache was actually a hidden single point of failure, not a performance layer.

The correct design:

- **Fail open to the source of truth.** Cache-aside naturally does this — a cache miss (including "cache unreachable") just means the read falls through to the database. The system gets slower, not unavailable.
- **Rate limit or shed load at the database** if a total cache outage would otherwise overwhelm it with the traffic the cache was absorbing — better to serve some requests slowly or reject some outright than to let the database itself fall over.
- **Circuit-break the cache client** so a slow or unreachable cache doesn't add its own timeout delay to every single request — fail fast to the DB path instead of hanging.
- **Have a maximum blast radius plan**: if the cache genuinely can't be avoided for correctness (e.g. it's a rate limiter's counter store), that specific feature can degrade (e.g. "fail open" and allow all requests temporarily) rather than the whole system failing.

## Cheat sheet

- Stampede = many requests for **one** key at once → coalescing, locking, probabilistic early expiry.
- Hot key = one key overwhelms one node → split the key across shards, add a local fallback cache.
- Penetration = repeated lookups for keys that don't exist → negative caching + bloom filter.
- Avalanche = many different keys expiring together → TTL jitter, staggered warming.
- Every cache has a staleness window — decide how much is tolerable, don't pretend it's zero.
- Invalidate-on-write still races with in-flight reads; a short TTL as a backstop is common even with explicit invalidation.
- A cache outage should degrade performance, never availability — always fail open to the source of truth.
- Circuit-break the cache client so an unreachable cache doesn't add latency to every request via a hanging connection.

## Common mistakes

| Mistake | Fix |
|---|---|
| No protection against concurrent recomputation of one key | Add request coalescing or a per-key lock |
| Setting the same fixed TTL for a whole batch of keys | Add jitter so expirations spread out |
| Caching only positive results | Cache negative results too, or use a bloom filter for "doesn't exist" lookups |
| Assuming consistent hashing solves hot keys | It only spreads different keys; a single overloaded key still needs splitting |
| Treating cache invalidation as instantaneous and race-free | Keep a short TTL as a backstop even with explicit invalidation |
| Designing a cache as a hard dependency | Always support fail-open to the source of truth |
| No circuit breaker on the cache client | A hanging cache connection can add latency to every request without one |

## Summary

Caching introduces its own class of failures — stampede, hot keys, penetration, and avalanche — each with a distinct cause and a distinct standard fix, and confusing them (especially stampede with avalanche) is a common interview stumble. Underneath all of them is the same principle: a cache should make a system faster, never make it more fragile, so every cache design needs an explicit answer for "what happens when this cache is unreachable or wrong," and that answer should always be graceful degradation, never total failure.

## Top Interview Questions

### Q1. What is a cache stampede and how would you prevent it?

A cache stampede happens when a single popular key expires or is invalidated, and many concurrent requests for that exact key all experience a cache miss at the same instant, all independently hitting the database to recompute the same value — turning one logical cache miss into a multiplied load spike. I'd prevent it with request coalescing (also called single-flight): the first request to miss acquires a lock, recomputes the value, and populates the cache, while concurrent requests for the same key wait for that in-flight computation rather than each triggering their own database call. An alternative or complementary fix is probabilistic early expiry, where reads have a small, rising chance of refreshing the value slightly before actual expiry, spreading the recompute load out over time instead of concentrating it at one moment.

### Q2. What's the difference between a cache stampede and a cache avalanche?

A stampede is about **one** key: many concurrent requests missing on the same expired or invalidated key at once. An avalanche is about **many different keys**: a large batch of unrelated keys all expiring around the same time — often because they were all cached with the same TTL during a bulk warm-up — causing a broad wave of misses across many keys simultaneously rather than a pile-up on one. The fixes differ accordingly: stampede is solved with per-key coordination like locking or coalescing, while avalanche is solved by adding random jitter to each key's TTL so expirations naturally spread out over time instead of clustering.

### Q3. What is a hot key, and why doesn't consistent hashing solve it?

A hot key is a single cache key — say, a viral post or a flash-sale product — that receives so much traffic it saturates the single node or shard responsible for it, even while the rest of the cache cluster is healthy and underutilized. Consistent hashing solves the problem of distributing many *different* keys evenly across nodes and minimizing reshuffling when nodes are added or removed, but it inherently maps one specific key to one specific node — it does nothing to help when that one key alone is simply too hot for any single node to serve. The fix has to operate at the key level: splitting the value across several shard keys (`key:0`...`key:9`) and picking a shard per read, or adding a small local in-process cache in front of the distributed layer specifically for the hottest few keys.

### Q4. Explain cache penetration and how a bloom filter helps.

Cache penetration is repeated lookups for keys that don't exist in the underlying data store at all, so every such lookup is guaranteed to miss the cache and fall through to the database, providing zero benefit from caching and potentially overwhelming the database if done at volume (accidentally by a buggy client, or deliberately by an attacker probing for data). A bloom filter is a compact probabilistic structure that can say with certainty "this key definitely does not exist," letting you reject the vast majority of nonexistent-key lookups before they even reach the cache or database. It has false positives (it might occasionally let through a lookup for a key that doesn't actually exist) but never false negatives, so it never incorrectly blocks a lookup for a key that genuinely is present.

### Q5. What happens to your system if the distributed cache goes down entirely, and how should it be designed to handle that?

If designed correctly with a cache-aside pattern, a cache outage means every read simply falls through to the database directly — the system gets slower because it loses the cache's latency benefit and the database now bears full read load, but it should not become entirely unavailable. The critical design work is making sure the database can actually survive that full load, at least temporarily, which might mean load shedding or rate limiting some traffic rather than letting the database itself fall over; and making sure the cache client fails fast (via a circuit breaker or aggressive timeout) rather than hanging on every request waiting for an unreachable cache, which would add latency to every single request instead of just removing the cache's benefit.

### Q6. Why might invalidate-on-write still serve a stale value shortly after a write, even though the invalidation "worked"?

There's a race between a write and a concurrent read that started slightly earlier: the read fetches the old value from the database, and before it writes that old value into the cache, the write completes and deletes the cache key — invalidation succeeds. But then the read's now-stale value gets written into the cache immediately after, re-populating it with outdated data despite the invalidation having correctly fired. This is a classic read-write race, and it's why some systems layer a short TTL on top of explicit invalidation as a safety net — even if this race occurs, the stale entry will still expire naturally within a bounded, short window rather than persisting indefinitely.

### Q7. How would you cache the result of a database lookup for a resource that frequently doesn't exist, like checking if a username is available?

I'd use negative caching: cache the "not found" result itself with a short TTL, rather than only caching found results, so a burst of repeated availability checks for the same taken-or-invalid username don't all hit the database every time. I'd keep the negative cache TTL shorter than positive entries since "doesn't exist yet" can change (someone might register that username), whereas "does exist" is comparatively more stable. For extremely high-volume scanning scenarios (like an automated username-enumeration attempt), I'd add a bloom filter of all currently registered usernames in front of this, since it can reject "definitely available" lookups even faster than a cache round trip.

### Q8. You add TTL jitter to fix a cache avalanche, but a teammate asks why you don't just use a much longer fixed TTL instead. How do you respond?

A longer fixed TTL delays the avalanche but doesn't eliminate the underlying problem — if a large batch of keys is still populated at the same moment (say, during a deploy or a scheduled cache warm-up), they'll all still expire together eventually, just less often; the system will still experience a synchronized wave of misses periodically. Jitter fixes the actual root cause by spreading expiration times out from the start, so misses trickle in gradually rather than clustering, regardless of when the keys were originally populated. A longer TTL is also a separate trade-off about staleness tolerance and isn't a substitute for addressing synchronized expiry — the two can and often should be combined.

### Q9. A specific product page's cache key experiences a 50x traffic spike during a flash sale, overwhelming its Redis shard. Walk through your diagnosis and fix.

I'd first confirm it's a genuine hot key problem rather than a general capacity issue — checking whether the traffic and CPU/network saturation is concentrated on one specific shard while others remain idle, which would confirm a single key or small set of keys is the cause. The fix is to split that specific key across multiple shard keys (e.g., replicate the product data under `product:123:0` through `product:123:9`) and have the read path pick a shard randomly or round robin, spreading the load across multiple nodes instead of one. For the duration of the sale specifically, I might also add a short-lived local in-process cache for that one product on each application instance, absorbing a large fraction of reads before they even reach Redis.

### Q10. Your negative cache is returning "not found" for a resource that was actually just created a few seconds ago. What went wrong and how do you fix it?

This is a straightforward invalidation gap: the negative cache entry for "doesn't exist" was populated before the resource was created, and nothing invalidated that negative entry when the create operation happened, so the TTL is the only thing that will eventually clear it. The fix is to make the write path explicitly delete any existing negative cache entry for that key as part of the create operation, the same way you'd invalidate a positive cache entry on an update — negative cache entries need the same invalidation discipline as positive ones, just often with a shorter default TTL so any gap is naturally bounded to a short window even if the explicit invalidation is missed.

### Q11. How would you design cache invalidation for data that's derived and cached under many different keys from one underlying database row — for example, a product that appears in a product-detail cache key, several category-listing cache keys, and a search-results cache key?

I'd use tag-based invalidation: when caching each derived value, I'd associate it with a tag representing the underlying entity (e.g., `product:123`), and on any write to that product, purge everything associated with that tag in one call rather than trying to individually track and invalidate every derived key by hand. This avoids the fragile alternative of trying to enumerate every possible cache key that might contain a reference to that product, which tends to miss cases over time as new features add new derived views. Some cache systems support this natively; where they don't, I'd maintain a lightweight reverse index (entity ID → set of cache keys) specifically to support this kind of grouped invalidation.

### Q12. Why is "the site goes down when the cache goes down" considered a design failure rather than an acceptable trade-off?

Because a cache's entire purpose is to be an optional performance optimization on top of a system that already works correctly without it — if removing the cache makes the system stop functioning rather than simply slower, then the cache has quietly become a hidden dependency and single point of failure, which defeats the reliability benefit that redundant, well-designed systems are supposed to have. The correct pattern, especially with cache-aside, is that a cache miss (for any reason, including the cache being entirely unreachable) should always be handled by falling through to the source of truth. The follow-up engineering work is making sure that fallback path can actually survive the load if it ever has to serve 100% of traffic, even if only temporarily and in a degraded, rate-limited way, rather than pretending that scenario will never happen.
