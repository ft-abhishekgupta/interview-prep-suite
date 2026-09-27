---
title: Design a URL Shortener
description: How to design a URL shortener that generates unique short codes, redirects with low latency, and scales reads far beyond writes
difficulty: Core
tags: [system-design, url-shortener, caching, key-generation]
---

A URL shortener turns a long link into a compact, shareable code and redirects visitors back to the original destination. It looks trivial but is a great vehicle for testing key generation under concurrency, redirect semantics, and read-heavy scaling.

## Requirements

### Functional

- Shorten a long URL into a unique short code (e.g. `short.ly/abc123`).
- Redirect a short code to the original long URL.
- Let users request a custom alias instead of a generated code.
- Support an optional expiration date per link.
- Track basic click analytics (count, timestamp, referrer, rough location).

### Non-functional

- Redirect latency low, target p99 under 100ms.
- Redirects must stay available even if the write path degrades — read availability over write availability.
- Short codes must be globally unique, no collisions.
- Analytics can be eventually consistent; redirects cannot be.
- Design for billions of stored URLs with a read:write ratio of roughly 100:1.

### Out of scope

- Full user account and billing system.
- Malware/phishing URL scanning.
- A rich analytics dashboard UI (only the ingestion pipeline matters here).

> [!TIP]
> Pin down scope with the interviewer before designing: is this "URL management" only, or does it also expect account/auth and a real analytics product bolted on? A Bitly-style prompt often bundles all three, and clarifying up front stops you from over-building the wrong tier.

## Scale estimation

| Metric | Assumption | Working | Result |
|---|---|---|---|
| New URLs created | 500M/month | given | 500M/month |
| Write QPS (avg) | 500M / (30 × 86,400s) | 500,000,000 / 2,592,000 | ~193 writes/sec |
| Write QPS (peak) | 3× average burst | 193 × 3 | ~600 writes/sec |
| Read:write ratio | 100:1 (redirects dominate) | given | 100:1 |
| Redirects/month | 500M × 100 | 50,000,000,000 | 50B/month |
| Read QPS (avg) | 50B / 2.59M s | 50,000,000,000 / 2,592,000 | ~19,300 reads/sec |
| Read QPS (peak) | 3× average | 19,300 × 3 | ~58,000 reads/sec |
| Storage per record | code + URL + metadata | ~7B + ~300B + ~200B | ~500 bytes |
| Storage (5 years) | 500M/mo × 60 mo × 500B | 30B rows × 500B | ~15 TB |
| Peak bandwidth | 58,000 QPS × ~1KB response | 58,000 × 1KB | ~464 Mbps |

> [!TIP]
> Saying "reads outnumber writes 100 to 1, so I'll optimize the read path with caching and treat writes as the simpler, less latency-sensitive path" is exactly the sentence an interviewer wants to hear in the first two minutes.

## Core entities and data model

| Entity | Key fields |
|---|---|
| `Url` | `short_code` (PK), `long_url`, `owner_id` (nullable), `created_at`, `expires_at`, `is_custom`, `status` |
| `User` | `user_id`, `email`, `plan` |
| `ClickEvent` | `event_id`, `short_code`, `timestamp`, `referrer`, `ip_hash`, `device_type`, `country` |

```mermaid
erDiagram
    USER ||--o{ URL : owns
    URL ||--o{ CLICK_EVENT : generates
    USER {
        string user_id
        string email
    }
    URL {
        string short_code
        string long_url
        datetime expires_at
        bool is_custom
    }
    CLICK_EVENT {
        string event_id
        string short_code
        datetime timestamp
    }
```

## API design

```
POST /api/urls
{ "long_url": "https://example.com/very/long/path", "custom_alias": "optional", "expires_at": "optional" }
-> 201 { "short_url": "https://short.ly/abc123" }

GET /{short_code}
-> 302 Found, Location: <long_url>

GET /api/urls/{short_code}/stats
-> 200 { "clicks": 4213, "created_at": "...", "top_referrers": [...] }

DELETE /api/urls/{short_code}
-> 204 No Content

GET /api/aliases/{alias}/available
-> 200 { "available": true }
```

## High level architecture

```mermaid
flowchart LR
    C["Client"] --> LB["Load Balancer"]
    LB --> WS["Write Service"]
    LB --> RS["Read Service"]
    WS --> KG["Key Generator"]
    WS --> DB[("Primary DB<br/>sharded")]
    RS --> Cache[("Redis Cache")]
    Cache -.miss.-> DB
    RS --> Kafka["Click Event Queue"]
    Kafka --> AW["Analytics Worker"]
    AW --> ADB[("Analytics Store")]
    Cleanup["Expiry Cleanup Job"] --> DB
```

**Write flow:** (1) client submits a long URL, (2) write service validates and checks for a custom alias if requested, (3) key generator issues a unique code (or the alias is used), (4) row is written to the sharded primary DB keyed by `short_code`, (5) response returns the short URL and the entry is pushed into cache proactively. Sketched at the level an interviewer draws it on a whiteboard, that flow looks like this:

![alt text](notes/HLD/Problems/Bitly/image.png)

**Read flow:** (1) client hits `GET /{code}`, (2) read service checks Redis first, (3) on a hit it fires a `302` immediately and emits a click event asynchronously to Kafka, (4) on a miss it reads the DB, populates cache, then redirects, (5) an analytics worker consumes the Kafka stream to build click counts without slowing the redirect. The redirect path mirrors the write path's shape, just with the cache check first:

![alt text](notes/HLD/Problems/Bitly/image-1.png)

> [!NOTE]
> Expired links are never deleted inline during a redirect — the read path only checks the `expires_at` timestamp and returns a 404/410 once it's passed. A separate background job is what actually sweeps and removes expired rows later.

Putting the key generator, the sharded store, and the cache together into one topology gives the assembled system:

![alt text](notes/HLD/Problems/Bitly/image-5.png)

## Deep dive: key generation strategies

### Hash vs counter vs pre-generated pool

| Strategy | How it works | Collision handling | Trade-off |
|---|---|---|---|
| Hash truncation (MD5/SHA + base62) | Hash the long URL, take first 7 chars | Must detect duplicates and retry with a salt | Simple, but retries add latency under collision |
| Global counter + base62 | Monotonic counter, base62-encode the number | None — counter is unique by construction | Needs a highly available, contention-free counter |
| Pre-generated key pool | Background job pre-computes random unused codes into a table; writers pop one | None — uniqueness enforced ahead of time | Extra storage and a refill job, but writes never block on generation |

```mermaid
flowchart TD
    N["Numeric ID<br/>e.g. 125,363,431"] --> B62["Base62 encode<br/>0-9a-zA-Z"]
    B62 --> Code["Short code<br/>e.g. 8xF3a2"]
```

> [!KEY]
> A counter shared by one database sequence becomes a single point of contention at 600 writes/sec peak. Give each application server a **pre-allocated range** (e.g. 1M IDs at a time, tracked in a coordination store), so no two servers ever hand out the same number and no round trip is needed per request.

Both viable strategies converge on the same base62-encoding step once a unique number exists:

![alt text](notes/HLD/Problems/Bitly/image-3.png)

![alt text](notes/HLD/Problems/Bitly/image-2.png)

Custom aliases skip key generation entirely — they only need a uniqueness check (`SELECT` or a cache existence check) before insert, and a unique constraint on `short_code` as the final backstop against a race between two concurrent requests for the same alias.

## Deep dive: redirect semantics

### 301 vs 302

| Code | Meaning | Effect | When to use |
|---|---|---|---|
| `301 Moved Permanently` | Browser caches the mapping | Lower server load, faster on repeat visits | Static, permanent redirects; no analytics needed |
| `302 Found` | Temporary redirect, browser does not cache | Every click hits the server | You need click analytics, or the destination can change |

> [!WARNING]
> `301` looks like a free performance win, but it means the browser (and some CDNs) will never call your server again for that code — you silently lose analytics and the ability to change or expire the link. Most production shorteners deliberately choose `302` and pay the extra traffic cost.

## Deep dive: caching for a read-heavy workload

```mermaid
flowchart LR
    Req["Redirect request"] --> Edge["CDN edge cache<br/>short TTL"]
    Edge -.miss.-> Redis[("Redis cluster")]
    Redis -.miss.-> DB[("Primary DB")]
    DB --> Redis
    Redis --> Edge
```

Cache-aside with a short TTL (minutes, not hours) balances freshness (a link can be deleted or expired) against hit ratio. The dangerous case is a **viral link**: thousands of requests per second for one key can create a cache stampede on a miss or expiry. Mitigate with request coalescing (a mutex per key so only one request repopulates the cache) and by proactively re-writing cache on every write, not just on read miss. The other recurring risk is **cold start** — a freshly deployed cache node or one recovering from eviction has to absorb a burst of misses before it's warm again, which is exactly why write-through population on create matters as much as the read-miss path:

![alt text](notes/HLD/Problems/Bitly/image-4.png)

## Deep dive: analytics pipeline and expiry cleanup

Click tracking must never sit in the redirect's critical path — the service fires a `302` first and publishes a click event to a queue afterward (or via a non-blocking write). A stream consumer aggregates counts into an analytics store, decoupled from the transactional path. For expiry, a background job periodically scans (or uses a TTL-indexed cache/DB) for rows past `expires_at`, marks them inactive, evicts them from cache, then hard-deletes after a grace period — never deleting inline during a redirect request.

## Bottlenecks and scaling

- **Counter contention** — solved by range allocation per server, not a shared atomic counter per request.
- **Hot short codes (viral links)** — solved by cache + coalescing; consider replicating hot keys across cache nodes.
- **DB write throughput** — shard by hash of `short_code`; writes are naturally uniform since codes are random/sequential-then-encoded.
- **Read service statelessness** — scale horizontally behind the load balancer with no shared state beyond cache and DB.

## Failure scenarios

| Failure | Blast radius | Mitigation |
|---|---|---|
| Key generation service down | New URL creation fails | Pre-generated key pool buffer absorbs outage; writes degrade gracefully, reads unaffected |
| Cache cluster down | Redirect latency spikes, DB load surges | Circuit breaker + rate limiting in front of DB; serve from replicas |
| Primary DB down | Writes fail | Promote a read replica; reads continue serving from cache/replicas |
| Kafka/analytics pipeline down | Click counts lost or delayed | Redirect path is unaffected since analytics is async; buffer and replay on recovery |

## Cheat sheet

- Use a counter + base62, or a pre-generated key pool — avoid hashing when you can, it invites collisions.
- Give each writer a pre-allocated ID range to remove counter contention.
- Prefer `302` over `301` unless you are willing to give up analytics and mutability.
- Cache-aside with short TTL, write-through on create, and per-key coalescing to survive stampedes.
- Keep analytics fully asynchronous — never block a redirect on a write.
- Clean up expired links via a background job, never inline.
- Read-heavy 100:1 ratio means: over-invest in caching, under-invest in write throughput.

## Common mistakes

| Mistake | Fix |
|---|---|
| Using MD5/SHA hash of the URL directly as the code | Causes collisions and duplicate long URLs get different codes; prefer counter-based generation |
| Choosing `301` redirects by default | Kills analytics and locks in the mapping forever; use `302` |
| Synchronously writing click analytics before redirecting | Adds latency to every redirect; make it async |
| A single global counter row updated per request | Becomes a write bottleneck; hand out ID ranges instead |
| Deleting expired rows inline during a read | Adds latency and risk to the hot path; use a background sweep |

## Summary

A URL shortener is fundamentally a key generation problem wrapped in a read-heavy caching problem. Pick a collision-free generation strategy (counter + base62 or a pre-generated pool), keep the write path simple, and put almost all your engineering effort into the read path — caching, replica reads, and asynchronous analytics — since redirects outnumber creations by roughly two orders of magnitude.

## Top Interview Questions

### Q1. How would you generate short codes at scale without collisions?

Two solid approaches: a global counter (per-server pre-allocated ranges) base62-encoded into a 6–8 character code, or a background job that pre-generates random unused codes into a pool that writers pop from. Both guarantee uniqueness by construction rather than by detecting and retrying collisions. Hashing the long URL (e.g. MD5, take first 7 chars) is tempting but requires collision detection and retry logic, adding latency and complexity for no real benefit over a counter. I'd default to counter + base62 for simplicity, and mention the pre-generated pool as an alternative if the counter service becomes a bottleneck.

### Q2. Why is a single shared counter a scaling risk, and how do you fix it?

If every write hits one `AUTO_INCREMENT` column or one Redis `INCR` key, that key becomes a single serialization point — every write across every server waits on it, and it can't be sharded because global uniqueness depends on a single sequence. The fix is to hand out ranges: each application server requests a block of, say, 1,000,000 IDs from a coordination service (or a DB row updated rarely), then hands out IDs from that block locally without a round trip per request. This turns a per-request bottleneck into a per-million-requests bottleneck.

### Q3. How do you support custom aliases without breaking uniqueness guarantees?

Custom aliases bypass the generator entirely: the client supplies the desired string, the service checks for existence (cache first, then DB), and if free, inserts it. Because two clients can race for the same alias between the check and the insert, uniqueness is enforced with a unique constraint on `short_code` at the database level as the final authority — the check is only an optimization to fail fast with a friendly error, not the source of truth.

### Q4. Why choose a 302 redirect instead of a 301, given 301 is faster for the client?

`301 Moved Permanently` tells browsers and CDNs to cache the mapping and never ask the server again, which is great for load but means you lose click analytics after the first visit per client, and you can never change or expire the destination. `302 Found` is not cached, so every click reaches the server, which costs more infrastructure but preserves analytics and the ability to mutate or expire links. Since analytics and expiration are explicit requirements here, `302` is the correct default — I'd only reach for `301` for a static, permanent redirect use case with no analytics need.

### Q5. The system needs 58,000 reads/sec at peak but only 600 writes/sec. How does that ratio shape your design?

It means almost every architectural decision should favor read latency and read availability over write throughput. Concretely: a caching layer (Redis, possibly a CDN edge cache) in front of the database so the vast majority of redirects never touch the DB; read replicas so read capacity scales independently of the write path; and accepting eventual consistency for anything read-heavy, like click counts, in exchange for speed. The write path, by contrast, can afford slightly higher latency (a database round trip, a uniqueness check) since it is two orders of magnitude less frequent.

### Q6. How do you prevent a cache stampede when a link suddenly goes viral?

A stampede happens when a hot key expires or misses and thousands of concurrent requests all fall through to the database at once. Mitigations: per-key request coalescing (the first request to miss acquires a short-lived lock and repopulates the cache; concurrent requests wait briefly and then read the now-warm cache instead of all hitting the DB), proactively writing to cache on creation instead of waiting for the first read miss, and using a longer TTL with background refresh for known-hot keys rather than a hard expiry.

### Q7. How would you design the analytics pipeline so it never slows down a redirect?

The redirect response fires first, independent of analytics — the click event is published to a message queue (e.g. Kafka) either fire-and-forget or via a buffered async write, and a separate consumer aggregates click counts, referrers, and geography into an analytics store. If the queue is down, redirects still succeed; analytics data is simply delayed or, in the worst case, lost for that window. This decoupling is the key idea: the transactional path (redirect) and the analytical path (click stats) have very different consistency and latency requirements and should never share a critical path.

### Q8. How do you clean up expired URLs without impacting the read path?

A background job runs on a schedule (e.g. every few minutes), queries for rows where `expires_at` has passed and status is still active, marks them inactive, evicts them from cache, and after a grace period hard-deletes them or moves them to cold storage. This must never happen inline during a redirect request — checking and deleting expired data synchronously would add latency and a race condition risk to the hottest path in the system. If storage is indexed by `expires_at`, the sweep itself is cheap.

### Q9. How would you shard the database as the dataset grows to billions of rows?

Shard by a hash of `short_code` so that both reads and writes distribute evenly — since codes are effectively random (or base62-encoded sequential numbers, which still hash uniformly), there are no natural hotspots. Each shard is a normal relational or key-value store keyed by `short_code`. This avoids range-based sharding pitfalls, like all-recent-writes landing on one shard, that you'd get sharding by creation timestamp instead.

### Q10. What happens if two requests for the same custom alias arrive at nearly the same time?

Both pass the initial "is it available" check because neither has been committed yet, then both attempt to insert. The database's unique constraint on `short_code` guarantees exactly one insert succeeds; the other fails with a constraint violation, which the service catches and returns as "alias already taken." This is the standard check-then-act race, and the fix is always to make the database the final arbiter of uniqueness rather than trusting an earlier read.

### Q11. Would you use a relational database or a NoSQL key-value store for the URL table, and why?

Either works because access is almost entirely by primary key (`short_code`) — a classic key-value access pattern. A managed key-value store (DynamoDB, Cassandra) scales horizontally with less operational overhead at very high read/write volume and gives predictable low-latency point lookups. A relational database is equally valid at moderate scale and adds easy uniqueness constraints and ad hoc querying for the (much rarer) analytics or admin use cases. I'd lean key-value at very large scale, relational if the team already runs Postgres well and volume is in the tens of millions rather than billions of rows.
