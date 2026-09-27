---
title: Traffic Routing and Load Balancing
description: How Azure Load Balancer, Application Gateway, Front Door and Traffic Manager differ, when to combine them, and how to justify the choice under questioning
difficulty: Core
tags: [azure, networking, load-balancing, front-door]
---

Every Azure system-design interview eventually asks "how does traffic get to your service", and there are four different answers depending on the layer. Picking the wrong one — or not knowing why you picked the right one — is an easy way to lose credibility after a strong start.

## The four options at a glance

```mermaid
flowchart LR
    U["User"] --> TM["Traffic Manager<br/>DNS routing"]
    TM --> FD["Front Door<br/>Global L7 edge"]
    FD --> AGW1["App Gateway<br/>Region A"]
    FD --> AGW2["App Gateway<br/>Region B"]
    AGW1 --> LB1["Load Balancer<br/>internal L4"]
    LB1 --> VM1["VM/VMSS pool"]
```

| Service | Layer | Scope | Key features | Typical use |
|---|---|---|---|---|
| Azure Load Balancer | L4 (TCP/UDP) | Regional (or zonal) | Ultra-low latency, health probes, no WAF/SSL offload | Internal traffic between tiers, non-HTTP protocols, VMSS backend balancing |
| Application Gateway | L7 (HTTP/HTTPS) | Regional | Path/host-based routing, SSL offload, WAF (OWASP rules), cookie-based session affinity | Single-region web app needing routing rules and WAF |
| Azure Front Door | L7, global edge (anycast) | Global | Global HTTP routing, WAF at the edge, caching (CDN), URL rewrite, header-based routing, health-probe failover across regions | Multi-region web apps, global audiences, DDoS-resilient edge |
| Traffic Manager | DNS-level | Global | No data-plane visibility — just resolves a hostname to an endpoint IP based on policy | Non-HTTP global routing, or as a coarse failover layer above services Front Door can't front |

> [!KEY]
> The layer determines what the service can see and act on. Load Balancer sees packets, so it can't route by URL path. Traffic Manager only ever answers a DNS query, so it can't inspect headers, terminate TLS, or run a WAF — it just tells the client which IP to try next.

## Azure Load Balancer (L4)

Distributes TCP/UDP connections across a backend pool (VMs, VM Scale Sets, or containers) using a 5-tuple hash, with health probes removing unhealthy instances. Comes in **Basic** (deprecated, being retired) and **Standard** SKU — Standard is zone-redundant, supports outbound rules, and is the only one worth deploying today. Public Load Balancer exposes a public IP; Internal Load Balancer stays inside the VNet for tier-to-tier traffic (e.g. web tier → app tier).

```csharp
// Health probe config (Bicep-equivalent concept) — LB removes an instance
// from rotation after N consecutive failed probes, adds it back after M successes.
// probePath: "/healthz", intervalInSeconds: 5, numberOfProbes: 2
```

## Application Gateway (L7, regional)

Terminates HTTP/HTTPS, so it can route by path (`/api/*` → API pool, `/static/*` → CDN-backed pool) or hostname (multi-site hosting on one gateway), offload TLS from the backend, and run a managed WAF with OWASP Core Rule Set. It requires a dedicated subnet and takes several minutes to scale, which matters for capacity planning around sudden traffic spikes.

| Feature | Supported |
|---|---|
| Path-based routing | Yes |
| SSL/TLS offload | Yes |
| WAF (OWASP CRS) | Yes (WAF SKU) |
| Session affinity | Yes (cookie-based) |
| Autoscaling | Yes (v2 SKU) |
| Global scope | No — regional only |

## Azure Front Door (global edge)

Front Door is a global, anycast-routed L7 service sitting at Microsoft's edge points of presence, closer to users than any single region. It does what Application Gateway does (path routing, WAF, SSL offload) but adds cross-region failover based on health probes, response caching (CDN-like), and a single global anycast IP/hostname that never changes even if backends move. It is the entry point of choice for any application serving users across multiple geographies or requiring resilience to a full region outage.

## Traffic Manager (DNS)

Traffic Manager doesn't proxy traffic at all — it answers DNS queries with the IP of the "best" endpoint per a routing method (priority, weighted, performance/latency-based, geographic), and the client connects directly to that endpoint afterward. Because it operates purely at DNS resolution time, it has no visibility into the actual HTTP request and can't do path routing, WAF, or caching — but it's protocol-agnostic (works for non-HTTP endpoints Front Door can't front) and is sometimes layered above other services as a last-resort failover mechanism.

> [!WARNING]
> DNS-based routing is subject to **client-side and resolver caching** (TTL). Even with a low TTL, some resolvers and clients ignore it, so failover via Traffic Manager can take longer in practice than the configured TTL suggests — don't promise sub-second failover from a DNS-only mechanism.

## Why and how to combine Front Door with Application Gateway

This combination is extremely common and worth being able to draw unprompted: Front Door sits at the global edge doing WAF, caching, and cross-region routing/failover, then forwards to a **regional** Application Gateway in each region, which does finer-grained path-based routing to the actual backend services within that region.

```mermaid
flowchart TD
    User["Users worldwide"] --> FD["Front Door<br/>global WAF + routing + cache"]
    FD -->|"Nearest healthy region"| AGWa["App Gateway — Region A<br/>path routing"]
    FD -->|"Failover"| AGWb["App Gateway — Region B<br/>path routing"]
    AGWa --> SvcA1["Orders service"]
    AGWa --> SvcA2["Static content pool"]
    AGWb --> SvcB1["Orders service"]
```

> [!TIP]
> A strong justification: "Front Door gives us one global anycast entry point, edge WAF, and automatic regional failover; App Gateway inside each region gives us finer path-based routing to services within that region without needing every routing rule duplicated globally." Some teams run WAF at both layers for defense-in-depth; name that as a deliberate trade-off (cost/latency vs layered security) if you did it.

## Health probes and connection draining

All four services use health probes, but at different granularity: Load Balancer probes TCP/HTTP at the instance level; Application Gateway and Front Door probe HTTP(S) paths and can weight routing by probe latency; Traffic Manager probes each endpoint independently before including it in DNS answers. **Connection draining** (Application Gateway) / **graceful shutdown** (Load Balancer) lets in-flight requests finish before an instance is removed during a scale-in or deployment, instead of hard-cutting connections.

| Setting | Purpose | Typical value |
|---|---|---|
| Probe interval | How often health is checked | 5–30s |
| Unhealthy threshold | Consecutive failures before removal | 2–3 |
| Drain timeout | Grace period for in-flight requests during removal | 30–300s |

## Session affinity and WAF rules

Session affinity ("sticky sessions") pins a client to the same backend instance via a cookie, needed for stateful apps that keep session data in-process rather than in a distributed cache. It's supported on Application Gateway and Front Door; prefer **not** needing it at all by keeping services stateless (session state in Redis/SQL) since affinity undermines even load distribution and complicates scaling events.

WAF operates in **Detection** mode (logs only) or **Prevention** mode (blocks matching requests) against the OWASP Core Rule Set (SQL injection, XSS, etc.), plus custom rules you author (rate limiting, geo-blocking, header-based allow/deny). Always roll a new WAF policy out in Detection mode first against production traffic to find false positives before flipping to Prevention.

> [!DANGER]
> Flipping a brand-new WAF policy straight to Prevention mode is a common cause of "the site is randomly 403ing legit users" incidents — CRS rules do produce false positives (e.g. a rich-text field containing something that looks like a SQL keyword). Always burn in with Detection mode and review logs first.

## Cheat sheet

- Layer decides capability: L4 (Load Balancer) sees packets, L7 (App Gateway/Front Door) sees HTTP, DNS (Traffic Manager) sees neither.
- Load Balancer: internal/regional L4, cheapest, lowest latency, no WAF.
- Application Gateway: regional L7, path/host routing, WAF, SSL offload.
- Front Door: global L7 edge, adds caching + cross-region failover + one stable anycast entry point.
- Traffic Manager: pure DNS, protocol-agnostic, subject to TTL/caching delays — not true real-time failover.
- Front Door + regional App Gateway is the standard multi-region web pattern: edge WAF/cache/failover + in-region path routing.
- Always burn in a new WAF policy in Detection mode before switching to Prevention.
- Prefer stateless services over session affinity; use affinity only when session state genuinely can't move to a shared store.

## Common mistakes

| Mistake | Fix |
|---|---|
| Using Traffic Manager and expecting instant failover | It's DNS-based; TTL and resolver caching add real delay — use Front Door for fast HTTP failover |
| Putting a WAF policy straight into Prevention mode | Burn in with Detection mode against real traffic first |
| Expecting Load Balancer to do path-based routing | That's an L7 capability — use Application Gateway or Front Door |
| Running Front Door and App Gateway with duplicated, conflicting WAF rules and no rationale | Decide deliberately whether WAF runs at edge only or both layers, and document why |
| Relying on session affinity instead of shared session state | Move session state to Redis/SQL so any backend instance can serve any request |
| Ignoring connection draining during deployments | Configure drain timeout so in-flight requests survive scale-in/deploys |

## Summary

Routing choice in Azure is a layering decision: Load Balancer for raw L4 distribution, Application Gateway for regional L7 routing and WAF, Front Door for a global edge with caching and cross-region failover, and Traffic Manager for DNS-level, protocol-agnostic routing when nothing else fits. Most production multi-region web architectures combine Front Door at the edge with a regional Application Gateway or internal Load Balancer behind it, using health probes and connection draining to make scaling and deployments invisible to users. Knowing which layer a requirement (WAF, path routing, caching, failover speed) belongs to is what makes the choice defensible in an interview.

## Top Interview Questions

### Q1. What's the fundamental difference between Azure Load Balancer and Application Gateway?

Load Balancer operates at layer 4, distributing raw TCP/UDP connections across a backend pool using a 5-tuple hash without inspecting the payload — it's extremely low latency but has no concept of HTTP paths, headers, or TLS termination. Application Gateway operates at layer 7, terminating HTTP/HTTPS so it can route based on URL path or hostname, offload TLS from backends, run a managed WAF, and maintain cookie-based session affinity. The practical decision rule: if you need to route based on anything inside the HTTP request, or need WAF/SSL offload, you need Application Gateway; if you're balancing a non-HTTP protocol or want the lowest possible latency for internal tier-to-tier traffic, Load Balancer is the right (and cheaper) tool.

### Q2. Why would you put Front Door in front of an Application Gateway instead of using just one of them?

Front Door operates globally at Microsoft's edge, giving you a single stable anycast entry point, WAF and caching close to users, and automatic failover across regions based on health probes — none of which a regional service can provide on its own. Application Gateway operates per-region and gives finer-grained path-based routing to services within that specific region. Combining them means Front Door handles "which healthy region should this user hit, with edge WAF and caching applied," and Application Gateway handles "within this region, which backend pool serves this specific path" — each layer does the job it's actually built for, rather than trying to make one service do both global failover and fine-grained regional routing.

### Q3. Why is Traffic Manager unsuitable for fast failover, and when would you still use it?

Traffic Manager only answers DNS queries — it never sees or proxies the actual HTTP traffic — so failover depends on clients and intermediate DNS resolvers respecting the configured TTL and re-resolving promptly. In practice, some resolvers and clients cache longer than the TTL suggests, so failover can take noticeably longer than expected, sometimes minutes. I'd still use Traffic Manager when the endpoints aren't HTTP (Front Door is HTTP/HTTPS only) — for instance, routing to non-web TCP services — or as an additional outer layer of failover above services that themselves aren't globally distributed, accepting that its failover is coarse and slow compared to Front Door's active health-probe-driven routing.

### Q4. How does a Web Application Firewall work, and what's the risk of enabling it in blocking mode immediately?

A WAF inspects HTTP requests against a rule set — commonly the OWASP Core Rule Set covering SQL injection, cross-site scripting, and other known attack patterns — plus any custom rules for rate limiting or geo-blocking, and can run in Detection mode (log only) or Prevention mode (block matching requests). The risk of enabling Prevention mode immediately on a new policy is false positives: CRS rules are pattern-based and can flag legitimate content (rich text fields, certain URL-encoded characters, specific JSON payloads) as malicious, blocking real users. The safe rollout is to deploy in Detection mode against real production traffic first, review the logs for false positives, tune or exclude specific rules, and only then switch to Prevention — ideally with monitoring in place to catch any regression immediately after the switch.

### Q5. Your Application Gateway backend pool has instances scaling in during a deployment, and users report dropped connections. What's happening and how do you fix it?

When an instance is removed from the pool — during a scale-in or a deployment — any in-flight requests to that instance can be terminated abruptly if there's no grace period, which shows up to users as dropped connections or failed requests. The fix is connection draining: configuring a drain timeout that keeps a "removing" instance receiving no new connections but still allows a bounded time (commonly 30–300 seconds, depending on how long the longest reasonable request takes) for existing in-flight requests to complete before the instance is fully removed. I'd also confirm the health probe's unhealthy threshold isn't so aggressive that instances get pulled out during a normal deploy pattern (e.g. a brief GC pause misread as unhealthy), and ensure deployments follow a rolling or blue-green pattern rather than pulling too many instances out simultaneously.

### Q6. When is session affinity a red flag in an architecture review rather than a reasonable choice?

Session affinity is reasonable when it's a deliberate performance optimisation on top of an architecture that would still work correctly without it — for example, pinning for cache locality where a cache miss just costs a bit of latency, not correctness. It's a red flag when the application actually depends on it for correctness — meaning if a user's second request lands on a different instance, they lose their session or see inconsistent data — because that couples scaling and failover behaviour to a sticky cookie, undermines even load distribution, and turns any instance replacement into a mini outage for affected users. In review, I'd push for moving session state to a shared store like Redis or SQL so any instance can serve any request, and reserve affinity for genuine performance-only cases.

### Q7. How would you design global traffic routing for an application that must survive a full region outage with minimal downtime?

I'd deploy the application active-active (or active-passive with a warm standby) across at least two regions, each fronted by a regional Application Gateway or internal Load Balancer as needed, with Azure Front Door as the single global entry point running health probes against both regions' backends. Front Door's health-probe-driven failover automatically stops routing to a region that fails its probes, typically within the probe interval times the unhealthy threshold (so tune those for the acceptable failover window), without requiring DNS TTL expiry the way Traffic Manager would. I'd pair this with data-layer replication appropriate to the consistency requirements (e.g. geo-replicated SQL, multi-region Cosmos DB) since routing traffic to a healthy region is useless if that region's data isn't current enough to serve correct responses.

### Q8. What's the difference in how Azure Load Balancer, Application Gateway, and Front Door each perform health checks, and why does the difference matter?

Load Balancer's health probes are simple TCP or basic HTTP checks against a port, used purely to decide whether an instance stays in the backend pool — it has no concept of "which path is healthy," just "is this endpoint alive." Application Gateway and Front Door probe actual HTTP(S) paths (e.g. `/healthz`) and can factor probe latency into weighted routing decisions, giving a more meaningful signal about application-level health rather than just TCP-level liveness. The difference matters because an instance can accept TCP connections (passing an L4 probe) while its application layer is deadlocked or returning 500s — only an L7 health check catches that, which is one reason Application Gateway/Front Door are preferred in front of application tiers rather than relying on Load Balancer probes alone for correctness signals.

### Q9. A customer in Australia reports high latency hitting your app, which is hosted only in East US behind Application Gateway. How would you address it, and which service would you introduce?

The root cause is physical distance — a request from Australia to an East US region incurs unavoidable round-trip latency regardless of how well-tuned the application is, since Application Gateway is a regional service with no edge presence. I'd introduce Azure Front Door in front of the existing regional Application Gateway: even without adding a second application region immediately, Front Door's edge points of presence terminate the user's TCP/TLS connection close to them and use Microsoft's private backbone for the rest of the trip to East US, which typically improves latency meaningfully over the public internet path alone. If the requirement grows to needing genuinely low latency for that user base, the next step is deploying the application into a region closer to Australia and letting Front Door route each user to their nearest healthy region.

### Q10. Why doesn't Azure Load Balancer support Web Application Firewall functionality, and what would you tell a team that wants to add WAF rules to it?

Load Balancer operates at layer 4 — it forwards TCP/UDP packets based on IP and port without terminating or inspecting the HTTP payload, so it has no visibility into request bodies, headers, or URLs, which is exactly what a WAF needs to evaluate rules against. Adding WAF capability requires an L7 proxy that terminates the connection and can parse HTTP, which is precisely what Application Gateway (regional) or Front Door (global) are built for. I'd tell the team that if they need WAF, the fix isn't to extend Load Balancer but to insert an Application Gateway or Front Door in front of (or in place of) the Load Balancer for the HTTP traffic that needs inspection, while Load Balancer can continue handling any non-HTTP or internal traffic that doesn't need WAF at all.
