---
title: CDN and Edge Delivery
description: How a content delivery network actually serves a request, push versus pull origin models, cache key and invalidation design, and when a CDN does not help
difficulty: Core
tags: [cdn, edge-computing, caching, latency]
---

A CDN is the cheapest latency win available in most designs: it moves bytes physically closer to users instead of making every request cross an ocean to your origin. Interviewers use it to test whether you understand caching at a network level, not just inside an application.

## How a CDN works

A CDN is a network of geographically distributed servers, called **Points of Presence (PoPs)**, each holding an **edge cache** of content close to end users. When a request would normally travel to your origin server, it instead hits the nearest PoP; if that PoP already has the content cached, it serves it directly (a **cache hit**) with none of the round trip to your origin. On a **cache miss**, the PoP fetches from the origin, serves the client, and stores a copy for next time.

```mermaid
flowchart LR
    U["User"] --> POP["Nearest PoP<br/>edge cache"]
    POP -->|"cache hit"| U
    POP -->|"cache miss"| SH["Origin shield<br/>regional PoP"]
    SH -->|"still miss"| OR["Origin server"]
    OR --> SH --> POP --> U
```

An **origin shield** is one designated PoP that sits between the edge PoPs and your origin. Without it, a viral piece of content can cause hundreds of edge PoPs to each independently miss and hit your origin simultaneously; the shield absorbs that fan-in, ensuring the origin only sees one request per shield, not one per PoP.

> [!KEY]
> A CDN is just another cache layer — the same rules about TTL, invalidation, and cache keys apply, just at a network hop closer to the user instead of inside your data center.

## Push vs pull origin

| | Pull (origin-pull) | Push |
|---|---|---|
| How content arrives at the edge | CDN fetches on first request (cache miss), then caches it | You proactively upload content to the CDN ahead of time |
| Freshness | Content is only as fresh as the last fetch + TTL | You control exactly when new content is available |
| Best for | Dynamic or long-tail content where you don't know in advance what will be requested | Known, static assets — a new app release's JS/CSS bundle, a pre-encoded video |
| Operational cost | Low — "just serve normally, let the CDN figure it out" | Higher — you manage the upload/publish pipeline |

Most modern setups default to pull, because it requires no extra publishing pipeline; push is reserved for cases where you already know exactly which assets need to be at the edge before the first request arrives.

## Cache-Control headers and TTL

The origin (or your application) controls caching behaviour via HTTP headers, and getting these right is most of what "CDN design" actually means in an interview.

| Header | What it does |
|---|---|
| `Cache-Control: max-age=3600` | Cache for 3600 seconds before revalidating |
| `Cache-Control: public` | Cacheable by shared caches (CDN), not just the browser |
| `Cache-Control: private` | Only the end client may cache it — CDN must not store a shared copy |
| `Cache-Control: no-store` | Never cache — sensitive data, always fetch fresh |
| `Cache-Control: s-maxage=600` | TTL specifically for shared caches (CDN), can differ from browser's `max-age` |
| `ETag` / `If-None-Match` | Conditional revalidation — server returns `304 Not Modified` if unchanged, saving bandwidth |

> [!TIP]
> Say the split explicitly: *"I'd set a long `max-age` for the browser but a shorter `s-maxage` for the CDN, so I can purge and refresh at the edge without waiting for every client's local cache to expire."*

## TTL choice and invalidation

TTL is a bet on how often content changes versus how much staleness is tolerable. Static, versioned assets (a JS bundle with a hash in the filename) can have a **near-infinite TTL** — the filename changes when the content does, so there's nothing to invalidate. Content that changes in place (a product page, a profile picture at a fixed URL) needs either a short TTL or explicit invalidation.

| Invalidation strategy | How it works | Trade-off |
|---|---|---|
| TTL expiry | Content simply expires after N seconds and refetches | Simple, but stale until expiry |
| Purge / invalidate API | Explicitly tell the CDN "drop this URL now" | Immediate, but costs an API call per change and can be rate-limited at scale |
| Versioned URLs (cache-busting) | Content URL includes a hash or version (`app.a1b2c3.js`) | No invalidation needed at all — old URL simply stops being referenced |
| Tag-based invalidation | Tag cached objects, purge by tag (e.g. "all pages mentioning product X") | Powerful for content that maps many-to-many to underlying data changes |

> [!WARNING]
> Purging is not instant globally — a purge request has to propagate to every PoP that might hold a copy, which can take seconds. For anything that must be correct immediately (a security-sensitive change), don't rely on purge alone; use a short TTL or versioned URL instead.

## Cache key design

The cache key is what the CDN uses to decide whether two requests are "the same" content. By default this is usually the full URL, but query strings, headers, and cookies can all be included or excluded from the key.

- Including a tracking query parameter (`?utm_source=...`) in the cache key by accident **fragments the cache** — the same content gets stored under dozens of near-duplicate keys, tanking your hit ratio.
- Excluding a legitimately content-affecting parameter (like `?lang=fr`) from the key causes the **wrong content to be served** — a French user gets an English page cached under the same key.
- Vary by header (`Vary: Accept-Encoding`) when the response genuinely differs by header, but avoid `Vary` on highly variable headers (like `User-Agent`) — it multiplies the number of cached variants per URL.

## Signed URLs for private content

Not everything at the edge should be public. **Signed URLs** (or signed cookies) let you serve private content — a paid video, a user's uploaded file — through a CDN while still controlling access: the URL includes an expiry timestamp and a cryptographic signature, and the edge PoP validates the signature before serving, without a round trip to your origin for every request.

```text
https://cdn.example.com/video/123.mp4?expires=1735689600&signature=abc123hmac
```

This is the standard pattern for video streaming platforms and private file downloads — cheap edge validation instead of an auth check that round-trips to origin on every chunk request.

## Dynamic content and edge compute

CDNs increasingly cache and even *execute* logic at the edge, not just static files.

- **Dynamic content acceleration** — even uncacheable, personalized responses benefit from routing over the CDN's optimized backbone network between PoP and origin, skipping congested public internet paths.
- **Edge compute** (Cloudflare Workers, Lambda@Edge, Azure Front Door rules engine) — run small pieces of logic at the PoP itself: A/B test bucketing, header rewriting, auth checks, even rendering a personalized fragment, without a round trip to origin.

> [!NOTE]
> Edge compute blurs the CDN/application boundary. The interview-safe framing: "edge compute handles cheap, stateless, latency-sensitive logic; anything needing a database or heavy state still goes to origin."

## When a CDN helps and when it doesn't

| Helps | Doesn't help |
|---|---|
| Static assets (images, JS, CSS, video) | Highly personalized, uncacheable per-user data |
| Content read far more than it's written | Write-heavy or transactional traffic (checkout, payments) |
| Geographically distributed audience | An audience entirely co-located with the origin |
| Large payloads (video, downloads) that would strain origin bandwidth | Tiny, already-fast responses where the extra hop adds negligible benefit |
| API responses that are cacheable and public | Real-time data that must always be fresh (a live stock price feed) |

## Cost model

CDN pricing is typically **bandwidth (egress) based**, often with tiered pricing by region, plus smaller per-request charges and sometimes a cost for invalidation/purge API calls at scale. The financial case for a CDN is usually straightforward: origin egress bandwidth from a cloud provider is often more expensive per GB than CDN edge bandwidth, so offloading a high cache-hit-ratio workload to a CDN both improves latency **and** reduces total bandwidth cost — a rare case where performance and cost point the same direction.

## Cheat sheet

- A CDN is a cache layer at the network edge — TTL, invalidation, and cache key rules all still apply.
- Pull origin = simplest default; push = for known assets you want pre-staged at the edge.
- Use `s-maxage` to control CDN TTL separately from browser `max-age`.
- Versioned/hashed URLs need no invalidation at all — prefer them for static assets.
- Purge is not instantly global — don't rely on it for anything security-critical.
- Design the cache key deliberately: careless query params fragment the cache; missing ones serve wrong content.
- Signed URLs let a CDN serve private content without an origin round trip per request.
- An origin shield protects your origin from a fan-in of simultaneous cache misses across many PoPs.
- CDNs help static, read-heavy, geographically distributed content; they don't help personalized or write-heavy traffic.
- CDN egress is usually cheaper than origin egress — a high hit ratio often pays for itself.

## Common mistakes

| Mistake | Fix |
|---|---|
| Treating CDN caching as "set and forget" | Design TTL, cache key, and invalidation deliberately, same as any cache |
| Including tracking query params in the cache key | Strip or normalize query params that don't affect content |
| Relying on purge for time-critical correctness | Use short TTL or versioned URLs when immediacy matters |
| Serving private content with no signed URL | Sign URLs/cookies with expiry so the edge can authorize without hitting origin |
| Assuming a CDN speeds up all traffic | It mainly helps cacheable, read-heavy, geographically distributed content |
| Forgetting an origin shield for viral content | Add a shield PoP to absorb simultaneous multi-PoP cache misses |
| Setting `Vary` on a highly variable header | Multiplies cached variants and tanks hit ratio — vary only on what truly changes the response |

## Summary

A CDN pushes cached content out to PoPs near users, trading a small amount of staleness for a large latency and bandwidth win, and an origin shield protects your servers from simultaneous cache misses across many edge locations. The real design work is in the same three levers as any cache — TTL, invalidation, and cache key — plus deciding what must never be cached (private, per-user, or transactional data) and what should be signed rather than public. Used well, a CDN is both a latency fix and a cost reduction; used carelessly, it either serves stale content or barely improves hit ratio at all.

## Top Interview Questions

### Q1. Explain how a CDN serves a request, including what happens on a cache miss.

A user's request routes to the nearest PoP rather than the origin. If that PoP already has a cached copy that hasn't expired, it serves the response directly — a cache hit, with no origin round trip. On a cache miss, the PoP (often via an intermediate origin shield PoP) fetches from the origin, serves the client, and stores the response locally so subsequent requests for the same content in that region become hits. The key design point is that this is standard cache behaviour, just running at network PoPs geographically distributed around your user base instead of inside your own data center.

### Q2. What is an origin shield and why would you use one?

An origin shield is a single designated PoP positioned between all the edge PoPs and your origin server. Without it, a piece of content going viral can cause dozens or hundreds of edge PoPs worldwide to each experience a cache miss at roughly the same time, all hitting your origin simultaneously — a thundering-herd-style spike your origin may not be provisioned for. With a shield, all those edge misses route through the one shield PoP first; the shield itself only needs to fetch from origin once, then serves all the edge PoPs from its own cache, so the origin sees a single request instead of hundreds.

### Q3. What's the difference between push and pull CDN models, and when would you choose each?

In a pull model, the CDN fetches content from the origin on the first request for it (a cache miss) and caches it from then on — this is the default because it requires no separate publishing step. In a push model, you proactively upload content to the CDN ahead of any request, giving you precise control over exactly when new content becomes available at the edge. I'd use push for known, pre-determined assets like a new application release's static bundle or a pre-encoded video file where I want it staged before launch; pull is the right default for everything else, especially long-tail or dynamic content where pre-staging every possible asset isn't practical.

### Q4. Why would you set a different `max-age` and `s-maxage` in your Cache-Control header?

`max-age` controls how long a private, per-client cache (typically the browser) holds the response, while `s-maxage` controls how long a shared cache — the CDN — holds it, and CDNs respect `s-maxage` over `max-age` when both are present. Setting them differently lets me tune each layer independently: for example, a shorter `s-maxage` lets me refresh content at the CDN relatively quickly if it changes, while a longer browser-side `max-age` still saves a round trip on repeat visits from the same user within that window without me needing to invalidate every individual client's cache directly, which isn't possible anyway.

### Q5. How would you invalidate a cached asset across a global CDN, and what are the trade-offs versus other approaches?

Most CDNs offer a purge or invalidate API that removes a specific URL (or a wildcard pattern, or a tag) from cache across all PoPs, but this isn't instantaneous — it has to propagate to every PoP that might hold a copy, which can take a few seconds to longer depending on the provider and how many PoPs are affected. For content where any staleness at all is unacceptable, I'd prefer a versioned or hashed URL instead (`app.a1b2c3.js`) so there's nothing to invalidate — the old URL simply stops being referenced once the new one deploys. Purge is more appropriate for content updated unpredictably where you can't easily version the URL, like a CMS-driven page.

### Q6. What does "cache key design" mean for a CDN, and what's a concrete mistake that hurts hit ratio?

The cache key is what the CDN uses to decide whether two incoming requests should be treated as the same cached object, and by default it's usually derived from the full URL including query string. A concrete mistake is letting a tracking parameter like `?utm_campaign=email` become part of the cache key: the actual page content is identical regardless of that parameter, but because it's included in the key, the CDN treats every unique combination as a separate object, fragmenting what should have been one highly-reused cache entry into dozens of rarely-hit ones. The fix is to explicitly configure the CDN to ignore query parameters that don't affect the response body when computing the cache key.

### Q7. How do signed URLs work, and what problem do they solve for a CDN?

A signed URL includes an expiry timestamp and a cryptographic signature (usually an HMAC generated with a secret key known only to your origin and the CDN) appended as query parameters. When a request arrives at the edge, the CDN validates the signature and checks the expiry itself, without needing to call back to your origin to check authorization on every single request. This solves the problem of serving private, access-controlled content — like a paid video stream or a user's private file — through a CDN's fast edge network while still enforcing per-user or time-limited access, which a purely public cache couldn't do safely.

### Q8. A product page's content differs by user's country due to localized pricing, but you want to still use a CDN. How would you design the caching?

The safest approach is to make the localization explicit in the cache key rather than trying to serve one cached copy for everyone: I'd either include a `country` or `locale` path segment or query parameter that's genuinely part of the cache key, or use `Vary: <a custom locale header>` if the CDN and origin can agree on that header reliably. I'd avoid inferring locale purely from IP geolocation done inconsistently between the CDN and origin, since a mismatch there causes the wrong cached price to be served. I'd cap the number of distinct locale variants to something reasonable (tens, not thousands) to avoid fragmenting the cache too much, since each variant is cached and warmed independently.

### Q9. Why doesn't a CDN help a highly personalized page, like a logged-in user's dashboard?

A CDN's benefit comes from many users sharing the same cached response, so its value is proportional to how "shareable" a given response is across requests. A personalized dashboard is, by definition, different for every user, meaning nearly every request is effectively a cache miss and the CDN adds an extra hop with no benefit — it may even add latency versus going straight to a well-placed regional origin. Where a CDN can still help in this scenario is for the static shell (JS/CSS/images) around the personalized content, while the personalized data itself is fetched via an uncacheable API call, ideally accelerated over the CDN's backbone network rather than cached by it.

### Q10. How does edge compute change the traditional CDN model, and what should still happen at the origin?

Edge compute (like Cloudflare Workers or Lambda@Edge) lets you run small pieces of application logic directly at the PoP — rewriting headers, doing A/B test bucketing, validating a signed token, or even assembling a personalized response fragment — without a round trip to origin for that logic. This blurs the traditional line between "CDN just serves cached bytes" and "application server runs business logic." The practical boundary I'd draw: edge compute is well suited to cheap, stateless, latency-sensitive logic that doesn't need a database; anything requiring persistent state, a transactional database write, or heavier computation still belongs at the origin.

### Q11. From a cost perspective, why does adding a CDN often reduce total infrastructure spend rather than just improving latency?

Bandwidth egress from a typical cloud origin is often priced higher per GB than a CDN's edge bandwidth, particularly at volume, and CDN pricing is primarily bandwidth-based. If a workload has a high cache hit ratio — say, 90% of requests are served from the edge rather than origin — then 90% of what would have been origin egress traffic is now CDN edge traffic instead, at a lower rate, while also being faster for the user because it didn't have to travel to origin at all. This is one of the few architecture decisions where the cost optimization and the performance optimization point in exactly the same direction, which is worth calling out explicitly as a justification.

### Q12. How would you decide the TTL for a piece of content that updates a few times a day but isn't perfectly predictable, like a news article?

I'd weigh how tolerable staleness is against how expensive invalidation is to trigger reliably. For a news article that might get a correction or update a few times a day, I'd set a moderate TTL — maybe a few minutes to an hour — as a safety net, combined with an explicit purge call fired from the publishing pipeline whenever an editor actually saves an update, so readers get the fresh version quickly in the common case without relying purely on a short TTL that would otherwise mean re-fetching from origin far more often than necessary. This combination — a "good enough" TTL plus event-driven purge — is a common middle ground when content changes are known events but not on a fixed schedule.
