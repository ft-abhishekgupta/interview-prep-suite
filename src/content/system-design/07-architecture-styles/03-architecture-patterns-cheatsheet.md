---
title: Architecture Patterns Cheatsheet
description: A dense one-page reference of the architecture patterns that come up repeatedly in system design interviews, with when to use and avoid each
difficulty: Core
tags: [patterns, reference, architecture, cheatsheet]
---

This is a reference page, not a tutorial — every pattern below has its own body of theory elsewhere on this site (saga, CQRS, event sourcing, circuit breakers all have dedicated pages), but interviews often move fast enough that you need the one-line "problem it solves / when to use / when not to" recall without re-deriving it. Use this to jog your memory mid-interview, and to sanity-check that you're reaching for the right tool rather than the first one that comes to mind.

## The pattern reference table

| Pattern | Problem it solves | When to use | When not to | Real example |
|---|---|---|---|---|
| **API Gateway** | Clients calling N services directly means N client integrations, N auth checks, N places to rate-limit | Many clients, many backend services, need a single entry point for auth/routing/rate-limiting | A single monolith with one client — there's nothing to gateway | Netflix Zuul, Azure API Management, Kong |
| **Backend for Frontend (BFF)** | One API gateway serving mobile, web, and partner clients ends up with a bloated, compromise-shaped contract | Genuinely different clients need different data shapes/aggregations from the same backend services | Only one client type exists, or clients' needs are nearly identical | A mobile BFF returning trimmed payloads vs a web BFF returning full detail |
| **Sidecar** | Cross-cutting concerns (mTLS, logging, retries) duplicated in every service's code, per language | Polyglot services need consistent infra behavior without per-language libraries | A single-language shop where a shared library achieves the same thing more simply | Envoy proxy sidecar in a service mesh |
| **Ambassador** | A service needs to talk to an external dependency through a consistent proxy (retries, circuit breaking, auth) without embedding that logic in app code | Calling third-party or legacy services that don't speak your internal conventions | The dependency is trivial/internal and doesn't need proxying | A sidecar proxy handling retries/TLS to a legacy SOAP backend |
| **Strangler Fig** | Rewriting a monolith in one shot is high-risk | Migrating a legacy system incrementally, capability by capability | A small system that's simpler to rewrite outright in one release | Routing `/checkout/*` to a new service while the rest stays on the monolith |
| **Cache-Aside** | Repeated expensive reads hit the database every time | Read-heavy workloads tolerant of brief staleness | Data changes on every read, or staleness is unacceptable | App checks Redis first, falls back to DB and populates cache on miss |
| **Write-Through** | Cache-aside's first read after a write is always a cache miss | Need the cache to always be warm and consistent with the DB | Write-heavy workload where writing to two places on every write is too costly | Write updates both cache and DB synchronously before returning |
| **CQRS** | One shared model can't serve both a normalized write path and a denormalized, fast read path well | Read and write patterns/scale differ significantly | Simple CRUD with no meaningfully different read shape | Write to normalized orders table, project to a search-optimized read table |
| **Event Sourcing** | Current-state storage loses history; "what did this look like last week" is unanswerable | Audit trail, replay, or temporal queries are a real product requirement | Typical CRUD entity with no audit/replay need | Bank ledger stored as an append-only sequence of debits/credits |
| **Saga** | A business transaction spans services, each with its own database — no shared ACID transaction | Multi-step operations across services/teams | Data belongs to one bounded context — just use one DB transaction | Order → payment → inventory, with compensations on failure |
| **Outbox** | Can't atomically write to a DB and publish to a queue as one operation | Any place you write to a DB and must reliably notify another system | You're using CDC, which sidesteps the problem architecturally | Business row + outbox row in one txn; a relay publishes afterward |
| **Inbox / dedupe** | Consumers may receive the same message more than once (at-least-once delivery) | Any consumer of an at-least-once queue that isn't naturally idempotent | The operation is naturally idempotent already (e.g. a pure `SET`) | Record processed message IDs; skip if already seen |
| **Idempotent Receiver** | Retried requests (client timeout + retry) risk double-charging, double-shipping, etc. | Any operation triggered by a client that might retry | Pure read operations — nothing to duplicate | Client sends an idempotency key; server returns the cached result on retry |
| **Competing Consumers** | A single consumer can't keep up with message volume | Need to parallelize processing of a queue/topic | Strict global ordering is required across all messages | Multiple workers in a consumer group pulling from partitions |
| **Claim Check** | Large payloads don't fit in (or shouldn't bloat) a message queue | Passing large blobs (images, files) through an event-driven pipeline | Payload is already small (well under the broker's message size limit) | Put the file in blob storage, send only the storage pointer in the message |
| **Priority Queue** | All requests treated equally means low-priority bulk work can starve urgent work | Mixed-priority workloads sharing infrastructure | All work is genuinely equal priority | Checkout emails jump ahead of newsletter bulk sends |
| **Queue-Based Load Levelling** | Sudden traffic bursts overwhelm downstream processing capacity | Bursty producers, steadier-capacity consumers | The workload must be handled synchronously (user is waiting for the result) | Image upload burst buffered in a queue, workers drain it steadily |
| **Throttling** | An unbounded client/tenant can consume all shared capacity | Protecting shared infrastructure from noisy neighbors or abuse | Internal, trusted, low-volume call paths | Rate limit per API key: 100 req/min |
| **Retry with Backoff** | Transient failures (network blip, brief overload) shouldn't be treated as permanent | Calling any dependency that can fail transiently | The failure is deterministic (4xx validation error) — retrying won't help | Exponential backoff with jitter on a flaky downstream call |
| **Circuit Breaker** | Repeatedly calling an already-failing dependency wastes resources and delays recovery | Any outbound call to a dependency that can become unhealthy | Truly critical calls where failing fast is worse than waiting (rare) | Open the circuit after 5 consecutive failures, fail fast for 30s |
| **Bulkhead** | One overloaded/failing dependency exhausts shared thread/connection pools, starving unrelated calls | Multiple dependencies sharing infrastructure with different risk profiles | Single-dependency systems with nothing to isolate from | Separate connection pools per downstream service |
| **Health Endpoint** | Orchestrators/load balancers can't tell if an instance is actually able to serve traffic | Any service behind a load balancer or orchestrator | N/A — essentially always applicable | `/healthz` (liveness) and `/ready` (readiness) endpoints |
| **Leader Election** | Some work must be done by exactly one node at a time (a scheduler, a coordinator) | Coordinating exclusive work across a fleet of otherwise-identical nodes | Work is naturally parallelizable/idempotent with no need for a single owner | ZooKeeper/etcd-based leader election for a cron-like job runner |
| **Sharding** | A single database/node can't hold or serve all the data/traffic | Data or traffic volume exceeds one node's capacity | Data comfortably fits on one well-provisioned node | Hash-partition users across 16 database shards by user ID |
| **Materialised View** | Expensive joins/aggregations recomputed on every read | Read-heavy, aggregation-heavy queries | Data changes so fast the view is stale before it's useful | Precomputed leaderboard table refreshed from raw events |
| **Static Content Hosting** | Serving static assets from application servers wastes compute on trivial file serving | Images, JS/CSS bundles, videos — content that doesn't change per-request | Content is dynamic/personalized per user | S3/Blob Storage + CDN serving all static assets |
| **Valet Key** | Proxying large file uploads/downloads through the app server wastes bandwidth and compute | Direct client-to-storage transfer is safe and desired | The file needs synchronous server-side validation before acceptance | Presigned URL / SAS token for direct-to-blob upload |
| **Anti-Corruption Layer** | A legacy or external system's model would otherwise leak into and corrupt your clean domain model | Integrating with a legacy system or third party whose model doesn't match yours | Both sides already share a clean, compatible model | A translation layer converting a legacy XML SOAP model into your domain's clean objects |

> [!KEY]
> In an interview, naming the pattern is worth little without the trade-off. The strongest version of any answer above is: *"I'd use [pattern] because [problem it solves] — the cost is [when not to / what it doesn't solve], so I'd avoid it if [condition]."*

## Which pattern for which symptom

A faster lookup when you're mid-interview and the symptom is the thing you can name, not yet the pattern.

| Symptom | Reach for |
|---|---|
| "Reads are slow and repeated" | Cache-aside, materialised view |
| "Write path and read path want different shapes" | CQRS |
| "We need to know history / what changed and when" | Event sourcing |
| "A business operation spans multiple services" | Saga (+ outbox for the DB/queue boundary) |
| "Messages get processed twice" | Idempotent receiver, inbox/dedupe |
| "One slow dependency is taking down everything" | Circuit breaker + bulkhead |
| "Traffic bursts overwhelm our workers" | Queue-based load levelling, competing consumers |
| "One noisy client/tenant hogs shared capacity" | Throttling |
| "Our monolith needs to become services safely" | Strangler fig |
| "A legacy system's model is bleeding into our clean code" | Anti-corruption layer |
| "Large files clog our message queue" | Claim check |
| "We need exactly one node doing this job" | Leader election |
| "One database node can't hold/serve all this data" | Sharding |
| "Clients need very different response shapes from the same backend" | Backend for Frontend |
| "Uploads/downloads are bottlenecked through our app servers" | Valet key, static content hosting |

## How the patterns group together

```mermaid
flowchart TD
    subgraph "Edge and Composition"
        GW["API Gateway"]
        BFF["BFF"]
        SC["Sidecar"]
        AMB["Ambassador"]
        SF["Strangler Fig"]
        ACL["Anti-Corruption Layer"]
        VK["Valet Key"]
        STAT["Static Hosting"]
    end
    subgraph "Data and Consistency"
        CA["Cache-Aside"]
        WT["Write-Through"]
        CQRS["CQRS"]
        ES["Event Sourcing"]
        MV["Materialised View"]
        SH["Sharding"]
    end
    subgraph "Messaging and Reliability"
        SAGA["Saga"]
        OUT["Outbox"]
        INB["Inbox"]
        IDR["Idempotent Receiver"]
        CC["Competing Consumers"]
        CLAIM["Claim Check"]
        PQ["Priority Queue"]
        QLL["Queue Load Levelling"]
    end
    subgraph "Resilience and Ops"
        THR["Throttling"]
        RB["Retry + Backoff"]
        CB["Circuit Breaker"]
        BLK["Bulkhead"]
        HE["Health Endpoint"]
        LE["Leader Election"]
    end
```

> [!TIP]
> Notice most patterns cluster into "how do requests enter and get composed," "how does data get shaped for reads vs writes," "how do services communicate reliably over messages," and "how does the system survive partial failure." When you're stuck mid-interview, ask which of these four buckets your symptom belongs to — it narrows the pattern search fast.

## A worked example: threading several patterns together

A checkout flow that (1) accepts uploads of a receipt image, (2) processes payment across services, and (3) needs a fast order-status read, plausibly combines: **valet key** (client uploads the receipt directly to blob storage), **claim check** (the processing pipeline passes only the blob pointer through the queue), **saga + outbox** (payment → inventory → shipping, each step's DB write paired with an outbox event), **idempotent receiver** (the payment charge call is safe to retry), **circuit breaker + bulkhead** (calls to the third-party payment gateway are isolated and fail fast if it's unhealthy), and **CQRS** (the order-status page reads from a fast projection instead of the normalized write-side tables).

> [!WARNING]
> Don't reach for every applicable pattern just because it's applicable — each one adds a moving part, a failure mode, and an on-call burden. The senior move is picking the smallest set that solves the *actual* stated requirement, and saying out loud which ones you deliberately left out and why.

## Cheat sheet

- **Edge/composition patterns** (gateway, BFF, sidecar, ambassador, strangler fig, ACL, valet key, static hosting) manage how requests enter and get composed.
- **Data patterns** (cache-aside, write-through, CQRS, event sourcing, materialised view, sharding) manage how data is shaped and scaled for reads vs writes.
- **Messaging patterns** (saga, outbox, inbox, idempotent receiver, competing consumers, claim check, priority queue, queue-based load levelling) manage reliable async communication.
- **Resilience patterns** (throttling, retry+backoff, circuit breaker, bulkhead, health endpoint, leader election) manage surviving partial failure and protecting shared capacity.
- **Every pattern has a "when not to"** — state it unprompted, it's the actual signal of seniority.
- **Patterns compose** — most real systems combine several from different buckets for one flow.
- **Don't over-apply** — each added pattern is an added operational cost; justify it against a real requirement.

## Common mistakes

| Mistake | Fix |
|---|---|
| Naming a pattern without its trade-off | Always pair "when to use" with "when not to" |
| Reaching for event sourcing/CQRS/saga reflexively because they sound sophisticated | Match the pattern to a stated, concrete requirement first |
| Treating outbox and CDC as the same thing | Outbox is for explicit application-level publishing; CDC derives events from the DB log automatically — pick one, don't do both redundantly |
| Confusing cache-aside and write-through | Cache-aside populates on read-miss; write-through populates on every write, keeping the cache always warm |
| Using a circuit breaker without a bulkhead | Without isolated pools, one dependency's exhaustion still starves others even if its circuit is open |
| Forgetting idempotency when adding retries | A retry without an idempotent receiver on the other end can double-charge or double-process |

## Summary

This page is a lookup table, not a syllabus: the patterns cluster into four buckets — how requests enter and compose, how data is shaped for reads versus writes, how services communicate reliably over messages, and how the system survives partial failure — and most real architectures combine a handful from each bucket for any one meaningful flow. The interview signal isn't recalling the name of a pattern; it's pairing it with the specific problem it solves, the condition under which you'd deliberately avoid it, and which patterns you chose *not* to use and why.

## Top Interview Questions

### Q1. What's the difference between cache-aside and write-through caching, and when would you pick one over the other?

Cache-aside has the application check the cache first on a read; on a miss, it reads from the database and populates the cache for next time — the cache is only ever warmed by reads, so the very first read after a write (or after a cache eviction) is always a miss. Write-through has the application write to the cache and the database together on every write, so the cache is always warm and consistent immediately after a write, at the cost of adding latency to every write path (two writes instead of one) even for data that might never be read again. I'd pick cache-aside for read-heavy, unpredictable access patterns where most data isn't read again soon after being written; write-through for data that's reliably read again shortly after being written, where paying the extra write cost buys a guaranteed cache hit.

### Q2. Explain the difference between the outbox pattern and change data capture, and when you'd use each.

Both solve the dual-write problem (can't atomically write to a DB and publish an event as one operation), but differently. The outbox pattern has the application explicitly write a row to an `outbox` table in the same local transaction as its business write, then a separate relay reads and publishes unsent outbox rows — this requires application code to construct and write outbox entries deliberately. CDC instead taps the database's own transaction log (write-ahead log) and derives events automatically from whatever committed, with no explicit second write from the application at all. I'd use CDC when the database supports it well and I want events to require zero extra application code; I'd use outbox when I need more control over the event's shape/semantics (a higher-level business event rather than a raw row diff) or the database/infra doesn't support reliable CDC.

### Q3. What problem does a service mesh's sidecar pattern solve, and what's the operational cost?

The sidecar pattern deploys a proxy alongside every service instance to handle cross-cutting concerns — mTLS, retries, timeouts, load balancing, tracing — at the infrastructure layer instead of duplicating that logic inside every service's application code, which is especially valuable in a polyglot environment where a shared library per language isn't practical. The operational cost is real: you now run and operate an additional process per service instance, debugging a request means understanding both the application and the proxy's behavior, and the mesh's control plane itself becomes a new piece of critical infrastructure to run reliably. I'd adopt it once the number of services and languages makes duplicating this logic per-service genuinely painful, not by default for a small, single-language fleet.

### Q4. Why would you use both a circuit breaker and a bulkhead together, rather than just one?

A circuit breaker protects a single call path to a specific dependency — it detects that dependency is failing and stops calling it, failing fast instead. But if that dependency's calls share a thread pool or connection pool with calls to other, healthy dependencies, the pool can already be exhausted by the failing dependency's slow calls *before* the circuit breaker even trips (since it usually trips on a failure-rate threshold measured over some window, not instantly). A bulkhead prevents that by giving each dependency its own isolated pool, so a struggling dependency can only exhaust its own resources, never the resources needed to serve calls to unrelated, healthy dependencies. Used together: the bulkhead contains the blast radius immediately and structurally, while the circuit breaker actively stops the wasted, doomed-to-fail calls once it detects the pattern.

### Q5. When is the claim check pattern useful, and what's the alternative if you don't use it?

Claim check is useful when a workflow driven by a message queue needs to pass a payload too large for the broker's message size limit (or just wasteful to duplicate through the broker) — an uploaded image, a video, a large document. Instead of putting the payload in the message, you store it in blob/object storage and put only a reference (a "claim check," like a coat check ticket) in the message; consumers fetch the actual payload from storage using that reference when they need it. The alternative without this pattern is either hitting the broker's message size limits directly, or bloating every consumer and every hop in the pipeline with a large payload it may not even need to inspect — claim check keeps the message bus lightweight and lets only the consumers that actually need the data fetch it.

### Q6. What's the difference between the inbox pattern and an idempotent receiver, since both seem to solve duplicate message handling?

They solve overlapping but distinct problems. Idempotent receiver is about the *operation itself* being safe to execute more than once with the same effect as executing it once — typically implemented by the client attaching a unique idempotency key to a request, and the server checking/storing that key so a retried request returns the previously computed result instead of re-executing the side effect (e.g. re-charging a card). The inbox pattern is specifically for message consumers on an at-least-once queue: it records the IDs of messages already processed in a durable "inbox" table, so if the same message is redelivered (broker retry, consumer crash before ack), the consumer can detect "I've already processed this exact message" and skip it, distinct from a client explicitly retrying a logically identical request with a fresh message. In practice they're often used together: idempotency keys guard against client-initiated retries, inbox/dedupe guards against broker-initiated redelivery of the same message.

### Q7. Why is an anti-corruption layer worth the extra code when integrating with a legacy or third-party system?

Without one, the legacy or third-party system's data model, quirks, and terminology tend to leak directly into your own domain model — your clean "Customer" object ends up growing fields that only make sense in terms of the legacy SOAP system's XML schema, and every future change to your domain has to account for that foreign shape. An anti-corruption layer is a dedicated translation boundary: it converts the external system's model into your clean domain model (and back) at the integration point, so the rest of your codebase never has to know the external system's conventions exist. The extra cost is writing and maintaining that translation code, but it pays for itself the moment the external system's model changes, is replaced, or turns out to have inconsistencies you don't want propagating through your entire domain.

### Q8. What's the practical difference between a priority queue and queue-based load levelling, since both involve a queue absorbing traffic?

Queue-based load levelling is about smoothing out *rate* — a burst of incoming work is buffered in a queue so that downstream consumers can process it at a steady, sustainable pace rather than being overwhelmed by the burst's peak rate; it doesn't care about the relative importance of the items, just the timing mismatch between producer bursts and consumer capacity. A priority queue is about *ordering by importance* — when there's a mix of urgent and low-priority work sharing the same processing capacity, it ensures the urgent work (a checkout confirmation email) is processed ahead of low-priority work (a bulk newsletter send) regardless of arrival order. They're often combined: a load-levelling queue absorbs bursts, and within it, priority ordering ensures the most important items in that buffered backlog are drained first.

### Q9. Scenario: you're asked to design file uploads for a photo-sharing app expected to handle bursty traffic. Which patterns would you combine?

I'd use the valet key pattern so clients upload directly to blob storage via a presigned URL/SAS token, avoiding proxying large files through application servers entirely. Once the upload completes, storage emits an event (or the client notifies the API), which I'd pass through the pipeline using claim check — only the blob's pointer travels through the processing queue, not the file itself. To absorb bursty upload traffic without overwhelming the image-processing workers (thumbnailing, moderation scanning), I'd add queue-based load levelling, buffering processing jobs and letting a pool of workers drain them at a sustainable rate, scaling the worker pool with competing consumers as volume grows. Finally, static content hosting (the processed images served via CDN from blob storage) keeps the read path fast and off the application servers entirely.

### Q10. How would you decide whether a design needs a saga, or whether one database transaction is enough?

I'd check whether the operation's steps genuinely span services owned by different teams with their own databases — if reserving inventory, charging payment, and creating an order all currently live in tables owned by the same service/team with no organizational reason to split them, a single ACID transaction is simpler, faster, and avoids all the complexity of compensations and semantic locks that a saga requires. I'd reach for a saga specifically when the steps are already forced apart by service boundaries that exist for real reasons (independent team ownership, wildly different scaling needs, a third-party dependency like a payment gateway that's inherently a separate system) — not as a default "microservices need sagas" assumption. The general principle: don't let an architecture pattern justify a service split; let a real organizational or scaling need drive the split, and only then does the corresponding data-consistency pattern (saga, outbox) become necessary.

### Q11. What's the risk of applying too many resilience patterns (retries, circuit breakers, bulkheads, timeouts) to every single call in a system?

Each pattern adds its own configuration surface (thresholds, timeouts, pool sizes) that needs tuning and can itself be misconfigured into causing harm — a retry without jitter can cause a synchronized retry storm, an overly aggressive circuit breaker can trip on a brief, harmless blip and cause unnecessary failures, and too many isolated bulkhead pools can fragment your capacity so finely that no individual pool has enough headroom to absorb its own normal traffic variance. There's also a real cognitive cost: an on-call engineer debugging a production incident has to reason about the interaction of all these layers (is this failing because the dependency is actually down, or because our own circuit breaker is open, or because our bulkhead pool is exhausted?) which can slow down incident response if the system's resilience layers aren't well understood or well-observed. The fix is applying these deliberately to calls that actually carry real failure risk and consequence, with good observability into each layer's state, rather than wrapping every single call in the full stack by default.

### Q12. If you had to cut this list down to the five patterns most worth knowing cold for a senior interview, which would you pick and why?

Circuit breaker and bulkhead, because "how do you prevent a failing dependency from cascading" is asked in almost every system design interview regardless of the specific problem. Cache-aside, because reasoning about read scaling almost always leads there first. Saga (with outbox), because any design that involves more than one service doing a multi-step business operation will need it, and it's the pattern candidates most often either skip entirely or misapply as 2PC. And idempotent receiver, because it underlies correct behavior for retries, at-least-once delivery, and general fault tolerance — without it, nearly every other resilience pattern (retries, hedged requests) becomes dangerous rather than helpful. These five show up, directly or as a prerequisite, in the large majority of system design interview questions.
