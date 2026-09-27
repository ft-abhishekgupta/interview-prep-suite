---
title: Load Balancing
description: How traffic gets spread across servers, which algorithm to name for which scenario, and why load balancers themselves need redundancy
difficulty: Core
tags: [load-balancing, networking, high-availability, scalability]
---

A load balancer is the first thing that decides whether your beautifully designed fleet of stateless servers actually gets used evenly. Interviewers ask about it constantly because the "right" algorithm changes with the traffic shape, and picking one without saying why is a missed signal.

## What a load balancer actually does

At its core, a load balancer is a reverse proxy that distributes incoming requests across a pool of backend servers, continuously checks whether each backend is healthy, and removes unhealthy ones from rotation without the client noticing. It exists to turn "one server that can fall over" into "a fleet that can lose members and keep serving."

> [!KEY]
> A load balancer only helps if the backends behind it are interchangeable. The moment one server holds state another doesn't have, you've built a system that *looks* load balanced but isn't.

## Layer 4 vs Layer 7

The first real design decision is which OSI layer the balancer operates at.

| | Layer 4 (transport) | Layer 7 (application) |
|---|---|---|
| Operates on | IP address and TCP/UDP port | HTTP method, path, headers, cookies, body |
| Can inspect content | ❌ | ✅ |
| Routing decisions | By connection only | By URL, header, cookie, content type |
| Speed | Very fast, minimal overhead | Slower — must parse the request |
| SSL termination | Usually passthrough | Can terminate and inspect decrypted traffic |
| Typical use | Raw TCP/UDP, WebSockets, database proxies | HTTP/HTTPS APIs, content-based routing, A/B routing |
| Examples | Azure Load Balancer, AWS NLB, IPVS | Azure Application Gateway/Front Door, AWS ALB, Nginx, HAProxy, Envoy |

> [!TIP]
> Say it as a rule of thumb: *"L4 when I need raw speed or a non-HTTP protocol like WebSockets; L7 when I need to route on URL path, do a canary rollout by header, or terminate TLS at the edge."*

## Load balancing algorithms

| Algorithm | How it works | Use when |
|---|---|---|
| Round robin | Requests go to servers in rotation, one at a time | Backends are identical in capacity |
| Weighted round robin | Rotation biased by a per-server weight | Backends have different capacity (e.g. mixed instance sizes) |
| Least connections | Send to the server with the fewest active connections | Requests vary a lot in duration |
| Weighted least connections | Least-connections, adjusted by server weight | Mixed capacity **and** variable request duration |
| IP hash | Hash of client IP picks the server | You need session affinity without a shared session store |
| Consistent hashing | Hash ring maps both requests and servers; only `1/N` of keys move when a server is added/removed | Sharded caches, sticky routing that must survive scaling events |

```mermaid
flowchart TD
    C1["Client A"] --> LB["Load Balancer"]
    C2["Client B"] --> LB
    C3["Client C"] --> LB
    LB -->|"round robin / least conn"| S1["Server 1"]
    LB --> S2["Server 2"]
    LB --> S3["Server 3"]
    S1 --> HC["Health check<br/>every N seconds"]
    S2 --> HC
    S3 --> HC
    HC -->|"unhealthy"| LB
```

Consistent hashing deserves its own callout because it solves a specific pain: with plain modulo hashing (`hash(key) % N`), adding or removing one server reshuffles almost every key's target server. Consistent hashing places servers and keys on a ring so only the keys between the changed server and its neighbour move — critical for sharded caches like Redis and for keeping cache hit ratios stable during scaling events.

## Health checks

A load balancer is only as good as its view of backend health. Two kinds matter:

- **Liveness check** — "is the process running at all?" A crashed process should be removed immediately.
- **Readiness check** — "can this instance serve traffic right now?" A server still warming up, draining connections, or overloaded downstream should be marked not-ready even though the process is alive.

Health checks run on an interval (commonly every 5–30 seconds) with a failure threshold (e.g. 3 consecutive failures) before removal, and a separate success threshold before re-adding — this avoids flapping a server in and out of rotation on a single blip.

## Sticky sessions: a smell, not a feature

Sticky sessions (a.k.a. session affinity) pin a client to the same backend, usually via a cookie or IP hash, so that server-local session state keeps working.

> [!DANGER]
> Sticky sessions are almost always a sign that a server is holding state it shouldn't. The fix is not a smarter load balancer — it's moving session state to a shared store (Redis, a database) so **any** backend can serve **any** request. Sticky sessions also break your even-distribution guarantee: one heavy user can overload one backend while others sit idle.

The one legitimate case for real stickiness is a long-lived connection itself — a WebSocket or a streaming upload — where the "session" *is* the TCP connection, not application state that could have lived elsewhere.

## SSL/TLS termination

Terminating TLS at the load balancer (decrypting HTTPS into plain HTTP before it reaches backends) is the common default: it centralises certificate management, offloads CPU-heavy handshake work from application servers, and lets an L7 balancer inspect the request to route on path or header. The trade-off is that traffic between the load balancer and backend travels unencrypted unless you re-encrypt it (**TLS re-encryption** or "SSL bridging") — worth doing inside a regulated environment or a zero-trust network, even inside your own data center.

## Global vs regional load balancing

| | Regional load balancer | Global load balancer |
|---|---|---|
| Scope | One data center / region | Routes across multiple regions |
| Mechanism | L4/L7 proxy in front of a server pool | Anycast IP or DNS-based routing to the nearest healthy region |
| Solves | Distributing load within a region | Latency (send users to the nearest region) and regional failover |
| Examples | Azure Application Gateway, AWS ALB | Azure Front Door / Traffic Manager, AWS Global Accelerator, Route 53 |

A typical production setup layers both: a global balancer picks the nearest healthy **region**, and a regional load balancer inside that region picks the nearest healthy **server**.

```mermaid
flowchart TD
    U["User"] --> GDNS["Global load balancer<br/>anycast / GeoDNS"]
    GDNS -->|"nearest healthy region"| R1["Regional LB<br/>US-East"]
    GDNS --> R2["Regional LB<br/>EU-West"]
    R1 --> A1["App server 1"]
    R1 --> A2["App server 2"]
    R2 --> A3["App server 3"]
    R2 --> A4["App server 4"]
```

## DNS-based routing

DNS can itself act as a coarse load balancer: **GeoDNS** returns different IPs based on the resolver's location, and a round-robin DNS record can spread traffic across multiple IPs. The catch is **DNS caching and TTLs** — clients and intermediate resolvers cache the answer, so failover through DNS alone can take minutes to propagate even with a low TTL, and some clients ignore TTL entirely. This is why global load balancers increasingly use **anycast** (the same IP address advertised from multiple locations, with the network routing to the nearest one) instead of relying purely on DNS for failover speed.

## The load balancer is a single point of failure — until you fix that

> [!WARNING]
> A load balancer that removes single points of failure from your server fleet can quietly become the new single point of failure itself if you only run one.

The standard fixes:

1. **Redundant load balancers** in an active-passive or active-active pair, with a floating/virtual IP that moves to the standby on failure.
2. **Health checks between the load balancers themselves**, not just from balancer to backend.
3. **DNS or anycast failover** at the layer above, so a whole region's load balancer pair can be bypassed.
4. Cloud-managed load balancers (Azure Front Door, AWS ELB) push this redundancy problem onto the provider — worth naming explicitly as a reason to prefer a managed service over rolling your own.

## Cheat sheet

- L4 = fast, protocol-agnostic, no content inspection. L7 = content-aware routing, but slower.
- Round robin for equal backends; least connections for variable request duration; weighted variants for mixed capacity.
- Consistent hashing minimises key movement when servers are added/removed — use it for sharded caches.
- Liveness vs readiness are different checks; use separate thresholds to avoid flapping.
- Sticky sessions are a smell — fix it by moving session state to a shared store, not a smarter balancer.
- Terminate TLS at the edge for centralised certs and CPU offload; re-encrypt internally if you need end-to-end encryption.
- Global LB picks the region (DNS/anycast); regional LB picks the server (L4/L7).
- DNS-based failover is slow because of caching and TTLs; anycast is faster.
- Never run a single load balancer instance — always pair it, actively health-checked.

## Common mistakes

| Mistake | Fix |
|---|---|
| Naming "load balancer" as the answer without picking an algorithm | Always state which algorithm and why |
| Defending sticky sessions as a solution | Move state to a shared store; treat stickiness as a symptom |
| Forgetting the load balancer itself is a SPOF | Deploy an active-passive or active-active pair with a floating IP |
| Assuming DNS failover is instant | It is TTL-bound and often takes minutes; use anycast for speed |
| Using L7 everywhere by default | L4 is faster when you don't need content-based routing |
| One health check threshold for everything | Separate liveness and readiness, with hysteresis to avoid flapping |
| Ignoring TLS between LB and backend | Decide explicitly whether to terminate or re-encrypt, and say why |

## Summary

Load balancing is the mechanism that turns a fleet of interchangeable servers into a system that survives individual failures and scales horizontally, but only if the algorithm matches the traffic shape and the backends are genuinely stateless. Layer 4 buys speed, Layer 7 buys content-aware routing; health checks keep the pool honest; and a global-plus-regional layering handles both latency and failover across data centers. The load balancer itself must be treated as a component that needs redundancy, not an assumed constant.

## Top Interview Questions

### Q1. What's the difference between Layer 4 and Layer 7 load balancing, and when would you pick each?

Layer 4 operates on IP and TCP/UDP port information only — it cannot see HTTP headers, cookies, or the URL path — which makes it very fast and protocol-agnostic, so it's the right choice for raw TCP/UDP traffic, WebSocket connections, or anywhere the extra parsing cost of L7 isn't worth it. Layer 7 parses the actual HTTP request, so it can route based on URL path, headers, or cookies, terminate TLS, and make content-aware decisions like sending `/api/*` to one service and `/static/*` to another. I'd default to L7 for HTTP APIs where routing flexibility matters, and drop to L4 when raw throughput or non-HTTP protocols are the priority.

### Q2. Why is round robin sometimes a bad choice, and what would you use instead?

Round robin assumes every backend has equal capacity and every request costs roughly the same to serve — neither is always true. If backends differ in size, weighted round robin fixes the capacity mismatch by sending proportionally more traffic to bigger instances. If request durations vary wildly (some requests are a fast cache hit, others trigger a slow database query), round robin can pile several slow requests onto one server while another sits idle; least connections fixes this by routing to whichever backend currently has the fewest active connections, which better reflects real-time load than a fixed rotation.

### Q3. Explain consistent hashing and why it matters for a sharded cache.

Consistent hashing places both servers and keys onto a conceptual ring using a hash function, and each key is served by the next server clockwise from its position on the ring. The benefit over plain `hash(key) % N` is that adding or removing one server only remaps the keys between that server and its neighbour — roughly `1/N` of all keys — instead of reshuffling almost everything. For a sharded Redis cache, that difference is the gap between "we added a node and lost 90% of our cache hit ratio for a few minutes" and "we added a node and barely noticed." Virtual nodes (multiple ring positions per physical server) further smooth the distribution.

### Q4. Why are sticky sessions considered an anti-pattern in a well-designed system?

Sticky sessions pin a client to one backend so that server-local state — usually an in-memory session — keeps working, but that requirement itself is the problem: it means the backend isn't actually stateless, which breaks the core assumption load balancing depends on. It also creates uneven load, since one client sending many requests, or many clients hashed to the same server, can overload a single instance while others idle. It complicates deployments too, since draining a server for a rolling update now has to gracefully migrate or wait out active sticky sessions. The fix is to move session state into a shared store like Redis, so any backend can serve any request and stickiness becomes unnecessary.

### Q5. Where should TLS be terminated, and what are the trade-offs?

The common default is to terminate TLS at the load balancer or edge — this centralises certificate rotation, offloads the CPU cost of the handshake from every application server, and lets an L7 balancer inspect decrypted traffic to route intelligently. The trade-off is that traffic between the load balancer and the backend is then plaintext unless you explicitly re-encrypt it (SSL bridging) for the internal hop. In a regulated environment, a zero-trust internal network, or anywhere compliance requires encryption end-to-end, I'd re-encrypt for the internal leg even though it costs some CPU and adds a second certificate to manage.

### Q6. How do you prevent the load balancer itself from being a single point of failure?

Never run one instance. The standard pattern is an active-passive (or active-active) pair sharing a floating/virtual IP, where the standby takes over the IP if health checks detect the active one has failed. Layer above that with DNS-based or anycast routing so an entire region's pair can be bypassed if the region itself has an issue. In practice, most teams avoid building this themselves and instead use a managed load balancer (a cloud provider's L4/L7 or global load balancing service), which already runs redundantly across multiple physical failure domains — worth naming explicitly as a reason to prefer the managed option over a self-hosted HAProxy/Nginx box.

### Q7. What's the difference between a liveness check and a readiness check?

A liveness check answers "is this process still running and responsive at all?" — failing it usually means the process should be restarted or removed entirely. A readiness check answers "can this specific instance serve traffic right now?" — an instance can be alive but not ready, for example while it's still warming a local cache on startup, draining connections during a graceful shutdown, or reporting that a downstream dependency it needs is currently unavailable. Using only a liveness check risks routing live traffic to an instance that technically responds but can't actually serve requests correctly yet.

### Q8. A service behind your load balancer starts throwing 5xx errors intermittently, but health checks show it as healthy. What's happening and what would you check?

The most likely cause is that the health check endpoint is too shallow — it might just return 200 from a lightweight route without exercising the actual dependency (database, downstream service) that's failing. I'd first check whether the health check hits a real code path versus a hardcoded "OK" response, then tighten the failure threshold and check interval so a genuinely degraded instance gets flagged faster. I'd also check whether the failures correlate with a specific instance (pointing to a bad host) versus being spread evenly (pointing to a shared downstream dependency, in which case removing individual instances from rotation won't help — the fix is elsewhere, likely a circuit breaker on that dependency).

### Q9. How would you design load balancing for a system that needs to serve users with low latency across multiple continents?

I'd use a two-tier approach: a global load balancer using anycast or GeoDNS routes each user to their nearest healthy region, and within that region a regional L7 load balancer distributes traffic across the local server pool. I'd replicate the application and a read path of the data close to each region to actually benefit from the routing — a global load balancer only helps latency if the region it sends you to can serve the request locally, otherwise you've just moved the cross-region round trip from the client to the backend. I'd also make sure each region can operate independently during a network partition, since global routing to a region that then calls home to a single central database defeats the purpose.

### Q10. Why is DNS-based failover considered slow, and what's the faster alternative?

DNS records are cached by resolvers and clients according to their TTL, and in practice many resolvers and some client libraries ignore or extend the TTL beyond what's configured. Even with an aggressively low TTL of, say, 30 seconds, propagation to all clients globally can realistically take minutes, during which some fraction of traffic still tries the failed target. Anycast avoids this because the same IP address is advertised from multiple physical locations and the network's routing layer (BGP) directs traffic to the nearest advertising location — failover becomes a routing table change rather than something every client has to individually re-resolve and pick up.

### Q11. When would you choose client-side load balancing over a dedicated load balancer?

Client-side load balancing, where the caller itself holds a list of healthy backends and picks one (common in internal microservice-to-microservice calls via gRPC's built-in load balancing, or a client library backed by service discovery), removes an extra network hop and the cost of running a dedicated proxy tier. It works well when you control both sides of the call, have a small to moderate number of clients, and have a reliable service discovery mechanism (DNS, Consul, a service mesh control plane) feeding the client its list of healthy targets. I'd avoid it for a large number of external or third-party clients, where you can't guarantee they're implementing balancing logic correctly or updating their backend list promptly — that's exactly the scenario a dedicated load balancer or DNS-based approach handles better.

### Q12. Your metrics show one backend server consistently receiving twice the traffic of its identical peers under round robin. What would you investigate?

First I'd check whether the load balancer's health checks are flapping on the other instances, temporarily removing them from rotation and causing the "healthy" one to absorb a larger share over time even though the algorithm itself is fair when all instances are in rotation. Second, I'd check for sticky sessions or IP-hash routing that might be unintentionally enabled, since a skewed client IP distribution (for example, many users behind a corporate NAT sharing one IP) can concentrate traffic on one backend under IP hash even though round robin was the intended algorithm. Third, I'd verify the load balancer's own configuration actually lists all instances with equal weight, since a stale or misconfigured weight value is a common, easy-to-miss cause of persistent imbalance.
