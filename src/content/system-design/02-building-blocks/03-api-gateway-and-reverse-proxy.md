---
title: API Gateway and Reverse Proxy
description: What a reverse proxy actually does, the responsibilities an API gateway takes on once you have more than one service, and when it becomes a bottleneck
difficulty: Core
tags: [api-gateway, reverse-proxy, microservices, architecture]
---

The moment a design grows past a single service, something has to decide which requests go where, who is allowed in, and how much of the plumbing every service would otherwise duplicate. That something is a reverse proxy at minimum, and usually an API gateway once the plumbing gets complex enough.

## Reverse proxy: the base layer

A reverse proxy sits in front of one or more backend servers and forwards client requests to them, so clients only ever talk to the proxy's address, never to a backend directly. It hides backend topology, can terminate TLS, and can do basic routing and load balancing. Nginx and HAProxy are the classic examples, and every load balancer discussed elsewhere is, structurally, a reverse proxy that also health-checks and distributes across a pool.

> [!KEY]
> A reverse proxy answers "how do I reach *a* backend." An API gateway answers "how do I reach the *right* backend, safely, with the cross-cutting stuff already handled."

## What an API gateway adds on top

An API gateway is a reverse proxy with application awareness — it understands your API surface, not just TCP connections.

| Responsibility | What it means |
|---|---|
| Routing | Map a public path/version to a specific internal service — `/v1/orders/*` → Order Service |
| AuthN/AuthZ | Validate a JWT/API key once at the edge, so backend services trust a pre-verified identity |
| Rate limiting | Per-user/API-key/tenant throttling, before load ever reaches a service |
| Request aggregation | Fan out one client call into several backend calls and merge the response |
| Protocol translation | Public REST/JSON in, internal gRPC or a different serialization out |
| Observability | Centralised request logging, tracing headers, and metrics for every call, in one place |
| Response shaping | Strip internal fields, add caching headers, transform errors into a consistent shape |

```mermaid
flowchart TD
    C["Client"] --> GW["API Gateway"]
    GW -->|"authN + rate limit"| R{"Route"}
    R --> S1["Orders Service"]
    R --> S2["Users Service"]
    R --> S3["Inventory Service"]
    GW --> AG["Aggregation:<br/>merge 3 calls into 1 response"]
    AG --> S1
    AG --> S2
    AG --> S3
```

## Gateway vs load balancer vs service mesh

These three get conflated constantly, and untangling them out loud is a strong signal.

| | Load balancer | API gateway | Service mesh |
|---|---|---|---|
| Layer | L4/L7, in front of one service's replicas | L7, in front of the whole API surface | Sidecar proxy next to every service instance |
| Traffic direction | North-south (external into one pool) | North-south (external into the system) | East-west (service-to-service internally) |
| Aware of business API? | No (or only URL path) | Yes — routes, versions, auth per endpoint | No — operates on any service traffic uniformly |
| Typical responsibilities | Distribute + health-check | AuthN, rate limit, aggregation, translation | mTLS, retries, circuit breaking, traffic shifting, tracing |
| Examples | Azure Load Balancer, AWS NLB/ALB | Azure API Management, Kong, AWS API Gateway | Istio, Linkerd, Consul Connect |

> [!TIP]
> A production system typically has all three at once: a load balancer distributing to gateway instances, the gateway handling the public contract, and a mesh handling trust and resilience *between* internal services. Naming all three and their distinct jobs is a strong senior signal.

## The Backend-for-Frontend (BFF) pattern

A single gateway serving a mobile app, a web app, and a third-party partner often ends up bloated with client-specific logic — special fields for mobile, different pagination for web. The **BFF pattern** splits this into one lightweight gateway per client type, each shaped to that client's exact needs, sitting in front of the same shared backend services.

| | Single shared gateway | BFF per client |
|---|---|---|
| Coupling | All clients share one contract and release cadence | Each client's team owns its own gateway and can iterate independently |
| Payload shape | One-size-fits-all, often over-fetches for mobile | Tailored per client — smaller payloads for mobile, richer for web |
| Operational cost | One thing to run and scale | More services to deploy, monitor, and secure |

> [!NOTE]
> BFF is a trade-off, not a free upgrade — it multiplies the number of edge services you operate. Only introduce it once client needs have genuinely diverged, not preemptively.

## The gateway as a bottleneck

Every request crosses the gateway, which makes it both the most valuable place to enforce policy and the easiest place to create a single choke point.

| Failure mode | Cause | Fix |
|---|---|---|
| Gateway CPU-bound at peak | Expensive work (JWT verification, request transformation) on every call | Cache decoded tokens briefly, offload heavy transforms, scale horizontally |
| Gateway becomes a SPOF | Only one instance, or one region | Run a horizontally scaled, stateless fleet behind its own load balancer |
| One slow downstream service stalls the gateway | No isolation between routes | Per-route timeouts and circuit breakers so one bad service doesn't exhaust gateway threads/connections |
| Aggregation calls block on the slowest backend | Sequential fan-out calls | Call backends concurrently, apply a per-call timeout, degrade gracefully if one is missing |

> [!WARNING]
> A gateway that calls three services sequentially to build one aggregated response is only as fast as the sum of all three. Fan the calls out concurrently and cap each with its own timeout so one slow dependency doesn't sink the whole response.

Scaling the gateway itself is usually straightforward because it should be stateless: run multiple instances behind a load balancer, autoscale on CPU/connection count, and keep any shared state (rate-limit counters, cached tokens) in a fast external store like Redis rather than in gateway memory.

## When not to use a gateway

A gateway adds a network hop and an operational surface, so it isn't free. Skip it, or keep it minimal, when:

- You have a single service or a small monolith — a plain reverse proxy or load balancer already covers routing and TLS.
- Latency budgets are extremely tight and the extra hop's cost (typically sub-millisecond to a few milliseconds) genuinely matters more than the centralised policy benefits.
- All traffic is internal service-to-service — that's usually better served by a service mesh's sidecar model than a centralized gateway choke point.
- The team is small enough that centralising auth/rate-limiting in application middleware is simpler to operate than an additional infrastructure component.

## Cheat sheet

- Reverse proxy = "reach a backend." API gateway = "reach the right backend, with policy already applied."
- Gateway responsibilities: routing, authN/authZ, rate limiting, aggregation, protocol translation, observability.
- Gateway is north-south (edge to services); service mesh is east-west (service to service).
- BFF splits one gateway into several, one per client type, once client needs diverge enough to justify the operational cost.
- Keep the gateway stateless; put rate-limit counters and cached tokens in Redis, not gateway memory.
- Fan out aggregation calls concurrently with per-call timeouts — never call downstreams sequentially.
- Per-route circuit breakers stop one bad downstream from stalling the whole gateway.
- Skip a dedicated gateway for a single service or purely internal traffic — a load balancer or mesh may already cover it.

## Common mistakes

| Mistake | Fix |
|---|---|
| Calling a load balancer and an API gateway the same thing | LB distributes traffic to one pool; gateway routes/secures across the whole API surface |
| Making backend aggregation calls sequentially | Call concurrently with per-call timeouts |
| Storing rate-limit counters or sessions in gateway process memory | Externalise to Redis so any gateway instance can serve any request |
| Running a single gateway instance | Scale it horizontally behind its own load balancer, like any other service |
| Adding a gateway to a single-service system "for best practice" | Only add it when there's an actual multi-service or policy need |
| One shared gateway growing client-specific branches for years | Split into BFFs once client needs have genuinely diverged |
| No per-route timeout or circuit breaker | One slow downstream can exhaust gateway threads/connections for everyone |

## Summary

A reverse proxy hides backend topology and forwards traffic; an API gateway builds on that with routing, security, rate limiting, aggregation, and observability applied once at the edge instead of duplicated in every service. It sits alongside, not instead of, a load balancer (which distributes within a pool) and a service mesh (which governs traffic between internal services). Because every request passes through it, the gateway must be treated as a first-class service in its own right — stateless, horizontally scaled, with per-route isolation — or it becomes exactly the single point of failure it was meant to prevent.

## Top Interview Questions

### Q1. What's the difference between a reverse proxy and an API gateway?

A reverse proxy is the base capability: it sits in front of backend servers, hides their topology from clients, and forwards requests, optionally load balancing and terminating TLS. An API gateway is a reverse proxy with application-level awareness of your actual API — it understands routes, versions, and per-endpoint policy, and adds responsibilities like authentication, rate limiting, request aggregation across multiple services, and protocol translation. Every API gateway is built on reverse proxy mechanics, but not every reverse proxy is a gateway; Nginx serving static files with basic routing is a reverse proxy, while Nginx configured with auth plugins, per-route rate limits, and response transformation starts to function as a gateway.

### Q2. When would you introduce an API gateway, and when would you deliberately avoid one?

I'd introduce a gateway once I have more than one backend service and find myself duplicating authentication, rate limiting, or request logging across each of them — centralising that logic at the edge removes the duplication and gives one place to change policy. I'd avoid one for a single service or small monolith, where a plain reverse proxy or load balancer already covers routing and TLS, and the gateway would just add a hop and an operational component without a real problem to solve. I'd also avoid using a public-facing gateway pattern for purely internal service-to-service traffic — that's usually a better fit for a service mesh's sidecar model.

### Q3. How is an API gateway different from a service mesh, and would you ever use both?

An API gateway sits at the edge and handles north-south traffic — external clients coming into the system — with responsibilities like authentication and request aggregation that require understanding the public API surface. A service mesh handles east-west traffic — service-to-service calls inside the system — via a sidecar proxy next to every instance, focused on mTLS, retries, circuit breaking, and traffic shifting between internal services, largely agnostic to the business meaning of any particular call. Yes, using both is common and not redundant: the gateway governs how the outside world enters, and the mesh governs how services trust and call each other once inside.

### Q4. What is the BFF (Backend-for-Frontend) pattern and what problem does it solve?

BFF splits a single shared API gateway into multiple gateways, each tailored to one type of client — mobile, web, and a partner API, for example — all fronting the same underlying backend services. It solves the problem of a single gateway accumulating client-specific branching logic over time: mobile needs smaller payloads and different pagination than a desktop web client, and cramming both into one contract either bloats the API or forces awkward compromises. The trade-off is operational cost — you now deploy, monitor, and secure multiple edge services instead of one — so I'd only introduce it once client requirements have genuinely diverged enough to justify that cost, not preemptively.

### Q5. Your API gateway aggregates a response by calling three internal services. What could make this slow, and how would you fix it?

The most common cause is calling the three services sequentially, which makes total latency the sum of all three call times instead of the maximum. I'd fix that by issuing the calls concurrently and waiting on all of them together, capping total latency at roughly the slowest single call rather than the sum. I'd also add a per-call timeout so one consistently slow or hanging dependency doesn't stall the whole aggregated response indefinitely, and decide up front whether a missing or timed-out sub-response should fail the whole request or degrade gracefully by omitting that piece of data — the latter is usually the better user experience if the missing data is non-critical.

### Q6. How do you prevent the API gateway itself from becoming a single point of failure or a bottleneck?

I'd keep the gateway stateless — no session or rate-limit state held in a single instance's memory, all of that externalised to a fast shared store like Redis — so any instance can serve any request. That lets me run a horizontally scaled fleet of gateway instances behind its own load balancer, autoscaling on CPU or connection count the same way I would any other service. I'd also add per-route timeouts and circuit breakers so a single misbehaving downstream service can't exhaust the gateway's threads or connection pool and take down routing for every other, healthy service behind it.

### Q7. Where should rate limiting live — the gateway, a load balancer, or each individual service — and why?

The gateway is usually the right place, because it's the one component that sees every request before it fans out to any backend service, so it can enforce a limit per user, API key, or tenant consistently across all endpoints without every service reimplementing the same logic. A load balancer typically operates below the application layer needed to identify a caller's identity for per-user limits. Enforcing it in each individual service instead means duplicating the logic everywhere and, worse, means a client can still overwhelm the network path and gateway itself even if each service correctly rejects excess requests — stopping it as early as possible at the edge is more efficient.

### Q8. What does "protocol translation" at an API gateway mean, and give an example of when you'd use it?

It means the gateway accepts requests in one protocol or format from the client and translates them into whatever the internal services actually speak, and translates the response back. A common example is exposing a public REST/JSON API while internal services communicate via gRPC for performance — the gateway terminates the public REST call, translates it into a gRPC call to the appropriate internal service, and converts the protobuf response back into JSON for the client. This lets internal teams choose the most efficient protocol for service-to-service communication without forcing every external client to understand it.

### Q9. A gateway needs to validate a JWT on every request. What would make this expensive, and how would you optimize it?

Verifying a JWT signature (especially with an asymmetric algorithm like RS256) involves real cryptographic work, and doing full verification plus a network call to a token introspection endpoint on every single request adds meaningful latency and CPU cost at high volume. I'd cache the public signing key locally with a reasonable refresh interval rather than fetching it per request, verify the signature locally instead of calling an introspection endpoint synchronously, and consider a short-lived local cache keyed by the token itself (with an expiry no longer than the token's own remaining lifetime) to skip redundant verification of the same token across a burst of requests from one client.

### Q10. How would you design canary or A/B routing using an API gateway?

I'd configure the gateway to route a small, controlled percentage of traffic (or traffic matching a specific header, cookie, or user segment) to a new version of a service while the rest continues to the stable version, then gradually shift the percentage up as confidence in the new version grows. This requires the gateway to be aware of both service versions and to make the routing decision consistently for a given user across requests, usually via a sticky routing key like a hashed user ID, so a single user doesn't flip between versions mid-session in a confusing way. This is one of the concrete reasons an L7-aware gateway is preferred over a purely L4 load balancer for this kind of traffic-shifting responsibility.

### Q11. Why might request aggregation at the gateway be considered an anti-pattern by some teams, despite being a listed gateway responsibility?

Aggregation logic embeds business knowledge about which services need to be combined and how — that's arguably application logic leaking into infrastructure, which makes the gateway harder to reason about, test, and evolve independently of the services it's aggregating. Some teams prefer to push aggregation into a dedicated BFF service instead, keeping the core gateway focused purely on cross-cutting infrastructure concerns (auth, rate limiting, routing) and putting business-aware composition logic in a service owned by the team that understands that business domain. Either approach is defensible — the key point to make in an interview is naming the trade-off rather than treating aggregation-at-the-gateway as an unquestioned default.

### Q12. How would you monitor and alert on an API gateway in production?

I'd track the standard RED metrics per route — request rate, error rate, and duration (latency percentiles, especially p99) — broken down by both the public route and the downstream service it maps to, so a spike in errors can be traced to a specific backend quickly. I'd add gateway-specific signals: rate-limit rejection counts (a spike might mean a client bug or an actual attack), auth failure rates, and circuit breaker state transitions per downstream. I'd alert on symptoms that affect users — elevated error rate or p99 latency breaching an SLO — rather than on every individual metric, and make sure the monitoring system itself runs independently of the gateway so a gateway outage doesn't also blind the alerting.
