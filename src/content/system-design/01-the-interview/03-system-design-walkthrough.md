---
title: System Design Walkthrough
description: A narrated pass through one system design interview end to end, plus the recurring escalation ladders that generalize to almost any prompt
difficulty: Core
tags: [system-design, interview-strategy, framework, worked-example]
---

Designing complex systems that are scalable, reliable, and maintainable, and that actually solve a real business problem, is the whole job — and there is no single right answer. This page walks one interview end to end, phase by phase, narrating what you'd actually say and draw at each step using a Twitter-like feed as the running example, then covers the eight recurring patterns — real-time updates, long-running tasks, contention, scaling reads and writes, large blobs, multi-step workflows, and proximity search — whose escalation ladders show up, in some combination, in almost every prompt you'll get.

> [!KEY]
> Interviews come in two shapes. **Product design** ("design Twitter/Uber/Netflix") runs Requirements → Entities → API → High-Level Design → Deep Dives. **Infrastructure design** ("design a rate limiter/message queue") swaps entities and API for a **system interface** (inputs and outputs of the component itself) and an explicit **data flow** step, because there's no end user — just other systems calling in.

![alt text](notes/05-HighLevelDesign/SystemDesign/image-2.png)

## What you're actually being graded on

```mermaid
flowchart LR
    B["Problem Navigation<br/>break down · scope · prioritize"] --> C["Solution Design<br/>apply concepts · integrate the parts"]
    C --> D["Technical Excellence<br/>current tech · best practices"]
    D --> E["Communication<br/>collaborate · explain · take feedback"]
```

| Criterion | What a strong transcript shows |
|---|---|
| **Problem navigation** | You broke the prompt down, gathered requirements, and had a visible path to a solution |
| **Solution design** | Each part solves a real requirement, and the parts integrate into one coherent design |
| **Technical excellence** | You applied current technology knowledge and named real best practices, not folklore |
| **Communication** | You collaborated with the interviewer, explained clearly, and took feedback constructively |

## The six-phase delivery framework

![alt text](notes/05-HighLevelDesign/SystemDesign/image.png)

![alt text](notes/05-HighLevelDesign/SystemDesign/image-4.png)

```mermaid
flowchart LR
    R["1. Requirements<br/>5 min"] --> E["2. Core Entities<br/>2 min"]
    E --> A["3. API Design<br/>5 min"]
    A --> DF["4. Data Flow<br/>5 min, optional"]
    DF --> H["5. High-Level Design<br/>10-15 min"]
    H --> DD["6. Deep Dives<br/>10 min"]
```

### 1. Requirements (5 minutes)

**Functional requirements** are what the client should be able to do. Ask targeted questions as if talking to a product owner — "does the system need to do X?", "what would happen if Y?" — then prioritize the top few:

```text
TWITTER
- Users should be able to post tweets
- Users should be able to follow other users
- Users should be able to see tweets from users they follow
```

**Non-functional requirements** are system qualities, quantified wherever possible. Walk the mnemonic **"SCALE For Cloud DesignS"** to make sure you've covered the ground:

```text
S - Scalability          F - Fault Tolerance
C - Consistency (CAP)    C - Compliance
A - Availability         D - Durability
L - Latency              S - Security
E - Environment Constraints
```

```text
TWITTER
- Highly available, prioritizing availability over consistency
- Scale to support 100M+ DAU
- Low latency: render the feed in under 200ms
```

Capacity estimation belongs here in theory, but in practice it's cheaper to do it later, once you know which number actually matters for the design decision in front of you.

### 2. Core entities (2 minutes)

List the small set of nouns and actors the functional requirements exchange — resources, not implementation details. Names can be refined later.

```text
TWITTER → User, Tweet, Follow
```

### 3. API / system interface design (5 minutes)

Define the contract: HTTP method, path, request body, response, one endpoint per functional requirement. Resources map straight onto the core entities, and sensitive identifiers like a user id belong in an auth header, never in the body.

```text
POST /v1/tweets          body: { "text": string }
GET  /v1/tweets/{id}  -> Tweet
POST /v1/follows          body: { "followee_id": string }
GET  /v1/feed          -> Tweet[]
```

Pick a protocol deliberately: **REST** is the default for CRUD-shaped resources, **GraphQL** earns its complexity when diverse clients need different shapes of the same data, **RPC** suits internal service-to-service calls with high performance requirements, and **WebSockets/SSE** are for genuinely real-time features.

### 4. Data flow (5 minutes, optional)

Only needed when the system does real processing — a sequence of actions converting input to output, not just serving requests:

```text
WEB CRAWLER: fetch seed URLs → parse HTML → extract URLs → store data → repeat
```

### 5. High-level design (10–15 minutes)

Represent the components and how they talk to each other. Start simple, satisfy the APIs one at a time, and narrate the data flow and the important database fields as you draw — ask which whiteboard/diagram tool you'll be using before you start.

![alt text](notes/05-HighLevelDesign/SystemDesign/image-1.png)

A few rules of thumb worth saying out loud while you draw: add an API gateway once you're routing between more than one microservice; a single database can serve multiple microservices just fine — it's simpler, and still fault tolerant via replication; and you only split a service out from another when its **read/write scaling profile genuinely differs**, because that's the point where it needs to scale independently.

### 6. Deep dives (10 minutes)

This is where you make the high-level design actually satisfy the non-functional requirements: address edge cases, name the bottlenecks, improve the design based on the interviewer's feedback, and proactively surface issues before being asked — it also gives the interviewer room to probe wherever they want to go deeper.

![alt text](notes/05-HighLevelDesign/SystemDesign/image-3.png)

For **infrastructure** prompts specifically, the framework's middle steps change shape:

![alt text](notes/05-HighLevelDesign/SystemDesign/image-13.png)

- **System interface** — identify the core entities and define the input and output of the system itself, since there's no human end user.
- **Data flow** — the steps data goes through converting input into output, which for an infra component is usually the main event rather than an optional add-on.

> [!TIP]
> A handful of rules pay for themselves in every deep dive: low latency is roughly "under 100ms"; always attach scale numbers to context rather than quoting them bare; separate read and write services only when their scaling requirements genuinely differ; minimize database hops wherever possible; and always explain *why* a choice is better, not just that you made it — for example, say explicitly that stateless nodes are what makes horizontal replication safe.

## Pattern 1 — Pushing real-time updates

Two independent decisions make up this pattern: which protocol pushes updates to the client, and how the server that has the update finds the server holding that client's connection.

![alt text](notes/05-HighLevelDesign/SystemDesign/image-5.png)

| Client transport | Behaviour | Watch out for |
|---|---|---|
| **HTTP polling** *(default)* | Simple, works for few-second latency | TCP connection overhead per poll |
| **Long polling** | Server holds the response open until there's an update | Not suited to frequent updates |
| **SSE** | Server pushes events any time; browsers auto-reconnect over existing HTTP infra | One-way only, server → client |
| **WebSockets** | Full-duplex over one TCP connection | Stateful — needs an L4 load balancer |
| **WebRTC** | Peer-to-peer | Heavy setup cost; used for video calls, multiplayer games |

![alt text](notes/05-HighLevelDesign/SystemDesign/image-14.png)

**Server-side propagation** — getting the update to the server holding the right connection — has its own ladder:

- **Server-side polling**: the server itself polls a database for changes. Latency is high and it needs a database to persist updates, so it's rarely the real answer.

  ![alt text](notes/05-HighLevelDesign/SystemDesign/image-15.png)

- **Consistent hashing**: each server owns a set of users, and a coordination service like Zookeeper tracks which user is on which server. Minimizes connection movement when scaling, at the cost of that coordination overhead.

  ![alt text](notes/05-HighLevelDesign/SystemDesign/image-16.png)

- **Pub/Sub**: clients can connect to *any* server; that server subscribes to updates for its connected users. Redis Pub/Sub is simple with no durability; Kafka is more complex but durable and replayable.

  ![alt text](notes/05-HighLevelDesign/SystemDesign/image-17.png)
  ![alt text](notes/05-HighLevelDesign/SystemDesign/image-18.png)

![alt text](notes/05-HighLevelDesign/SystemDesign/image-19.png)

In practice, a live dashboard reaches for polling or SSE+Pub/Sub, a chat application's choice depends on delivery guarantees needed, and a collaborative editor wants WebSockets plus consistent hashing.

> [!NOTE]
> **Deep dives worth rehearsing:** connection failures are handled with heartbeats plus per-message sequence numbers and a per-user message queue so a client can detect and recover from a gap. A single user with millions of followers needing the same update is solved with **batching and hierarchical distribution** rather than one-by-one fan-out.
>
> ![alt text](notes/05-HighLevelDesign/SystemDesign/image-20.png)
>
> Maintaining message ordering across distributed servers leans on vector clocks and logical timestamps, or funnelling all messages through a single stamping point first.

## Pattern 2 — Managing long-running tasks

The core move is splitting a slow request into two parts: return a job id immediately, and add the actual work to a queue for asynchronous processing — decoupling request acceptance from request processing.

![alt text](notes/05-HighLevelDesign/SystemDesign/image-6.png)

| Advantages | Trade-offs |
|---|---|
| Quick user response, better experience | Added system complexity |
| Independent scaling of the async path | Eventual consistency |
| Queue keeps jobs durable | Extra infra for job-status tracking |
| Fault isolation between request and work | Monitoring overhead |
| Better resource utilization | |

**Message queue choice:** Kafka is the default — append-only log, high throughput, ordering within a partition, replay, fan-out to many consumers. Redis with BullMQ is simple and fast but not durable across a crash. AWS SQS is managed and scalable with a 1MB message limit and delivery guarantees. RabbitMQ is enterprise-grade but needs self-hosting.

**Workers:** plain servers are the default — simple, self-managed. Serverless functions need no server management and autoscale, but pay the cost of cold starts, execution time limits, and less local storage. Containers orchestrated by Kubernetes sit in between — more flexible than serverless, more complex than a plain server fleet.

![alt text](notes/05-HighLevelDesign/SystemDesign/image-40.png)

Reach for this pattern in an interview when there's a specific slow operation, a distinct scaling or failure requirement for that operation, different hardware needs per operation, or when "just do the math" shows the naive synchronous approach doesn't work. Typical examples: video platforms, photo sharing, ride sharing, payment processing, file sync.

> [!WARNING]
> **Deep dives that come up constantly:** if a worker crashes mid-job, another worker picks it up — detected via heartbeat (SQS visibility timeout, Kafka session timeout, RabbitMQ heartbeat interval). Repeated failure routes to a **dead letter queue**. Duplicate work is prevented with **idempotency keys**.
>
> ![alt text](notes/05-HighLevelDesign/SystemDesign/image-41.png)
>
> Bursty traffic is handled with backpressure (reject new jobs once the queue is near full) plus autoscaling workers. Mixed workloads get separate queues and worker pools — fast queues with many small workers for short tasks, slow queues with few big workers for long tasks.
>
> ![alt text](notes/05-HighLevelDesign/SystemDesign/image-42.png)
>
> Job dependencies are handled by the worker enqueueing the next step for simple chains, or a workflow orchestrator (AWS Step Functions, Temporal) once the dependency graph is genuinely complex.

## Pattern 3 — Contention and race conditions

![alt text](notes/05-HighLevelDesign/SystemDesign/image-43.png)

Preventing race conditions and keeping data consistent escalates through concurrency control, atomic transactions and locking, and — only when a lock must outlive a single transaction — distributed locks, two-phase commit, or queue-based serialization.

![alt text](notes/05-HighLevelDesign/SystemDesign/image-7.png)

1. **Conditional write (start here).** A database already row-locks by default, so put the check directly in the `WHERE` clause — a compare-and-set becomes one statement instead of two round trips that something else could interleave with. If a transaction needs multiple writes, make each depend on the previous one's result. If a ticket also has a seat number, push the counter/lock down to the seat level.

   ![alt text](notes/05-HighLevelDesign/SystemDesign/image-21.png)

2. **Explicit locking for complex logic.** **Pessimistic locking** holds the row for everyone else until the transaction finishes — reach for it when collisions are frequent. **Optimistic concurrency control** assumes conflicts are rare: read the current version, write only if the version hasn't changed, retry on conflict.

   ![alt text](notes/05-HighLevelDesign/SystemDesign/image-22.png)

   > Transaction + pessimistic locking is the combination for full serialization when you need it.

3. **Write skew** happens when reads and writes depend on each other even though the same row isn't touched directly — "delete my row only if no one else is currently present" is the classic example. The textbook fix is `SERIALIZABLE` isolation, but it's expensive because the database has to check every concurrent transaction; the practical fix is collapsing the two-row problem into a single-row conditional write or lock instead.

   ![alt text](notes/05-HighLevelDesign/SystemDesign/image-23.png)

4. **Locking outside the database.** Hold the lock as data instead of inside a transaction when its lifetime needs to outlive one — a **distributed lock**. Redis with a TTL is in-memory and quick; a database column can record who's holding it; ZooKeeper/etcd give session-bound ownership but add real operational overhead. When a lock protects an external resource, pass a monotonically increasing **fencing token** so a paused old holder's write is rejected after a newer holder takes over.

   ![alt text](notes/05-HighLevelDesign/SystemDesign/image-24.png)

**Deep dives:** preventing deadlocks under pessimistic locking means always grabbing locks in a deterministic order — modern databases also detect deadlocks and retry automatically.

![alt text](notes/05-HighLevelDesign/SystemDesign/image-25.png)

The **ABA problem** in optimistic concurrency — a value read as v1, changed to v2, then changed back to v1 right as you write — is fixed by choosing a monotonic version number (a strictly increasing counter) rather than a value that can cycle back to something it used to be.

Performance when everyone wants the same row is capped by lock hold time; if strong consistency on one hot row is truly required, serialize access through a queue and accept the throughput ceiling that comes with it.

![alt text](notes/05-HighLevelDesign/SystemDesign/image-26.png)
![alt text](notes/05-HighLevelDesign/SystemDesign/image-27.png)

## Pattern 4 — Scaling reads

The order of attack, cheapest first: optimize within the database (indexing, denormalization, vertical scaling), then scale horizontally (read replicas, sharding), then add caching (application-level, CDN) — mindful of cache management, replication lag, and hot keys.

![alt text](notes/05-HighLevelDesign/SystemDesign/image-8.png)

When a query is simply slow, add the right index. When reads still need scaling, first check whether you're bound by disk (spinning disk → SSD), then whether access is skewed (add a cache) or roughly uniform (add replicas instead). A hot cache key needs request coalescing or cache key fan-out; cache invalidation on write needs the write to delete the key **and** cache versioning, because a replica can still serve an old version even after the primary's cache entry is gone.

## Pattern 5 — Scaling writes

The order of attack: vertical scaling and the right database choice first, then sharding and vertical partitioning, then queues and load shedding, then batching and aggregation.

For database choice, Cassandra-style append-only commit logs are built for write-heavy workloads (reads suffer in exchange), while Postgres rewrites a B-tree on every insert. **Sharding** splits data across nodes by a good shard key; **vertical partitioning** moves whole columns into separate, specialized stores. **Queues** absorb bursty writes by trading immediate consistency for eventual consistency. **Load shedding** drops low-value writes, letting a newer update simply overwrite an older one. **Batching/aggregation** groups writes at the application layer or in an intermediate processing layer before flushing to the database — trading latency, and needing a recovery story if a batch is lost.

![alt text](notes/05-HighLevelDesign/SystemDesign/image-12.png)

**Deep dives:** adding shard capacity without downtime means standing up a new database in parallel, dual-writing plus backfilling historical data, then switching over. A **hot key** gets split across its own shard once it becomes hot, with reads re-aggregated across the split.

## Pattern 6 — Handling large blobs

The rule underneath this whole pattern: never proxy large files through your application servers — have the client talk directly to storage.

![alt text](notes/05-HighLevelDesign/SystemDesign/image-10.png)

A **presigned URL** is a temporary, scoped upload/download URL issued directly by the storage service, restricted by time, file type, and size. Use a CDN for frequently downloaded files.

![alt text](notes/05-HighLevelDesign/SystemDesign/image-36.png)

**Resumable uploads/downloads** chunk the file client-side, track progress via a checksum/hash per uploaded chunk, and stitch the chunks together once every chunk has arrived.

![alt text](notes/05-HighLevelDesign/SystemDesign/image-37.png)

**State sync** is the recurring hard part: the actual file lives in object storage while its metadata lives in the database, and that split creates race conditions on file status, orphaned files, malicious clients, and plain network failures. The fix pairs storage-side event notifications with a periodic reconciliation job that catches whatever the events missed.

![alt text](notes/05-HighLevelDesign/SystemDesign/image-38.png)
![alt text](notes/05-HighLevelDesign/SystemDesign/image-39.png)

Reach for this pattern for video platforms, photo sharing, file sync, and chat media — and skip it for files under roughly 10MB, or anywhere compliance requires inline data inspection or an immediate synchronous response.

**Deep dives:** if an upload fails at 99%, the client should have tracked which chunks succeeded and the upload session id, so it resumes by re-sending only the failed chunks. Abuse prevention means running a content-analysis pipeline before a file becomes downloadable. Fast downloads combine direct storage access, CDN delivery, HTTP range requests for partial/resumable downloads, and parallel chunk downloads.

## Pattern 7 — Multi-step processes and workflows

A naive single-node implementation of step 1 → step 2 → step 3 has one obvious failure mode: it crashes halfway through.

![alt text](notes/05-HighLevelDesign/SystemDesign/image-11.png)
![alt text](notes/05-HighLevelDesign/SystemDesign/image-35.png)

The two structural answers are **choreography** and **orchestration**, and **sagas with compensation** is the pattern that makes either one safe to run: a saga is a sequence of steps that complete one at a time, and if any step fails, compensating actions undo the prior steps in reverse order — and those compensations need their own retry and idempotency logic, since they can fail too.

![alt text](notes/05-HighLevelDesign/SystemDesign/image-28.png)
![alt text](notes/05-HighLevelDesign/SystemDesign/image-29.png)

**Choreography** stores the stream of steps that got you here rather than a single current-step pointer — a durable log like Kafka, with workers subscribed to react to state and required to be idempotent. Workers scale independently, but the workflow itself is implicit — inserting a new step later means touching many workers, and it's hard to see the whole flow in one place.

![alt text](notes/05-HighLevelDesign/SystemDesign/image-30.png)
![alt text](notes/05-HighLevelDesign/SystemDesign/image-31.png)

**Orchestration engines** (Temporal, AWS Step Functions) split the workflow into deterministic *workflow* code holding the entire flow, and idempotent *activities* it calls. History is stored durably, so a crashed workflow can replay from history without corruption.

![alt text](notes/05-HighLevelDesign/SystemDesign/image-32.png)
![alt text](notes/05-HighLevelDesign/SystemDesign/image-33.png)

**Deep dives:** updating a live workflow safely relies on versioning and patching rather than editing history in place. Making a step run exactly once needs an idempotency key plus a check of current state before replaying anything. Managing unbounded history size means keeping activity input/output small and using "continue-as-new" to start a fresh workflow seeded with the current state.

![alt text](notes/05-HighLevelDesign/SystemDesign/image-34.png)

## Pattern 8 — Proximity-based services

Plain one-dimensional data indexes cleanly into a B-tree, but latitude/longitude is inherently two-dimensional, so a naive index over one coordinate returns a thin, useless strip across the globe rather than a genuine radius.

![alt text](notes/05-HighLevelDesign/SystemDesign/image-46.png)
![alt text](notes/05-HighLevelDesign/SystemDesign/image-47.png)

Two families solve it. **Custom tree structures** — KD-tree, BKD-tree, R-tree, R\*-tree, quadtree — are built for polygons and shapes. **Single encoded keys** — Geohash, Google's S2, Uber's H3 — collapse 2D coordinates into a single sortable key, and are what's used for points at scale (Redis, MongoDB, Uber).

- **Quadtree** — every point on the map is divided into four quadrants, subdivided further wherever points are dense, so different regions end up at different tree depths, and each node can live at a different disk location for random access.

  ![alt text](notes/05-HighLevelDesign/SystemDesign/image-49.png)

- **K-D tree** — divides data by alternating horizontal and vertical splits, one dimension at a time. A **Block K-D tree** groups multiple points per data block and is what Elasticsearch uses internally.

- **R-tree** — groups nearby points into minimum bounding rectangles, which can overlap, at a uniform depth; it's the production-grade choice and indexes lines, polygons, and points alike. The **R\*-tree** variant reduces overlap on insertion.

  ![alt text](notes/05-HighLevelDesign/SystemDesign/image-50.png)

- **Geohash** — recursively divides the world into 32 blocks per level, each represented by one character, so strings sharing a prefix are physically near each other; used inside Redis. The known edge case is a location right on a cell boundary, whose nearest neighbours can fall in a different cell entirely — solved by searching the surrounding cells too.

  ![alt text](notes/05-HighLevelDesign/SystemDesign/image-48.png)

- **Google's S2** — the earth isn't flat, so a grid gets thinner near the poles than the equator; S2 projects the earth onto a cube so every face is equal size, and is what MongoDB uses.

  ![alt text](notes/05-HighLevelDesign/SystemDesign/image-44.png)

- **Uber's H3** — uses hexagonal cells so every neighbouring cell is equidistant, with a 64-bit id per cell and a shared prefix for nearby cells.

  ![alt text](notes/05-HighLevelDesign/SystemDesign/image-45.png)

## Cheat sheet

- There is no single right answer — you're scored on problem navigation, solution design, technical excellence, and communication, not on matching a reference diagram.
- Product design runs Requirements → Entities → API → HLD → Deep Dives; infrastructure design swaps in a system interface and an explicit data flow step.
- Functional requirements are verbs, quantify every non-functional requirement, and use **SCALE For Cloud DesignS** to make sure you covered the ground.
- Start the high-level design simple, satisfy each functional requirement one at a time, and only split a service out when its read/write scaling profile genuinely diverges.
- Real-time updates are two independent decisions: client transport (polling → SSE → WebSockets → WebRTC) and server-side propagation (DB polling → consistent hashing → pub/sub).
- Long-running work always means: return a job id immediately, then process asynchronously off a durable queue.
- Contention escalates: conditional write → optimistic concurrency → pessimistic lock → distributed lock → serialize through a queue.
- Scaling reads escalates: index/denormalize → replicas/sharding → cache. Scaling writes escalates: vertical/DB choice → shard/partition → queue/shed → batch/aggregate.
- Never proxy large files through your app servers — presigned URLs plus direct-to-storage transfer, reconciled with event notifications.
- Multi-step workflows need sagas with compensation either way; choreography scales workers independently but hides the flow, orchestration keeps the flow explicit at the cost of extra infra.
- Lat/long needs a 2D-aware index — geohash/S2/H3 for points at scale, R-tree/quadtree for polygons and shapes.

## Common mistakes

| Mistake | Fix |
|---|---|
| Diving into components before requirements are agreed | Spend the first five minutes on functional and non-functional requirements, explicitly |
| Treating every non-functional requirement as equally important | Pick the two or three the SCALE mnemonic surfaces as actually shaping this design |
| Designing the "textbook" architecture regardless of what was asked | Start from the simplest design that satisfies **this** conversation's stated requirements |
| Proxying large file uploads through the application tier | Issue a presigned URL and let the client talk to storage directly |
| Defaulting to a distributed lock for any concurrency problem | Try a conditional write first; escalate only as far as the actual collision rate demands |
| Choosing choreography for a workflow with many branching steps | Switch to an orchestrator once you can no longer see the whole flow in your head |
| Indexing latitude/longitude with a plain B-tree | Use a geohash/S2/H3 encoded key or a tree built for 2D data |
| Silently redesigning mid-interview without narrating the change | Say out loud what changed and why the moment you notice a mistake |

## Summary

A system design interview rewards a repeatable process: scope the requirements, name the entities and the API contract, draw the simplest high-level design that satisfies every functional requirement, then spend the back half hardening it against whatever the interviewer probes. Underneath almost every deep dive sits one of a small number of recurring patterns — real-time delivery, asynchronous long-running work, contention over shared state, scaling reads or writes, large blob handling, multi-step workflows, and proximity search — each with its own cheap-to-expensive escalation ladder. Knowing the ladder, and stopping at the rung the stated requirements actually demand, is what separates a design that's over-engineered from one that's genuinely well-reasoned.

## Top Interview Questions

### Q1. Walk me through how you'd open a system design interview for "design Twitter."

I'd spend the first five minutes on requirements: functional requirements as the top few things a user can do — post a tweet, follow a user, see a feed of followed users' tweets — explicitly parking anything else as out of scope. Then non-functional requirements, quantified: highly available and prioritizing availability over consistency, scaling to 100M+ daily active users, and rendering the feed in under 200ms. From there, two minutes naming the core entities (User, Tweet, Follow), five minutes on the API contract for each functional requirement, and then into the high-level design, satisfying one API at a time.

### Q2. How does designing an infrastructure component like a rate limiter differ from designing a product like Twitter?

There's no end user, so "core entities" and "API design" get replaced by a **system interface** step — defining the literal inputs and outputs of the component itself — and a **data flow** step describing, stage by stage, how a request is converted into an allow/deny decision. The requirements and deep-dive phases stay conceptually the same, but the functional requirements read more like "the system should reject requests over N per window" than "a user should be able to X."

### Q3. A prompt says "handle a spike of 100x traffic on this endpoint." Which pattern do you reach for and why?

I'd first check whether the endpoint is doing synchronous work that doesn't need to be synchronous — if so, the long-running-task pattern applies: return a job id immediately and let a queue and a worker pool absorb the burst asynchronously, decoupling acceptance from processing. If the endpoint is a read path instead, I'd escalate the read-scaling ladder — check indexing first, then decide between replicas (uniform access) or a cache (skewed access) based on the actual access pattern, rather than reaching for sharding by default.

### Q4. When would you choose WebSockets over Server-Sent Events for a real-time feature?

SSE is one-way, server-to-client only, and is the simpler choice for dashboards, notifications, or live comment streams where the client never needs to push data back over the same channel. WebSockets are full-duplex and are worth the added statefulness — and the requirement for an L4-capable load balancer — specifically when the client also needs to send frequent updates back, like a chat message or a collaborative editing operation, not just receive them.

### Q5. Explain the difference between choreography and orchestration for a multi-step workflow, and how you'd choose.

Choreography publishes events to a durable log and lets each worker react independently based on state — workers scale independently, but the overall flow lives nowhere explicitly, so it's hard to visualize and inserting a new step later touches many workers. Orchestration uses an engine like Temporal or Step Functions where a deterministic workflow definition holds the entire flow and calls out to idempotent activities, keeping the flow visible and explicit at the cost of an extra piece of infrastructure. I'd default to choreography for two or three loosely coupled steps and switch to orchestration the moment the workflow has branching logic I can't hold in my head.

### Q6. How do you prevent double-charging a customer in a payment flow that might be retried?

I'd use an idempotency key generated by the client for the specific payment attempt, have the server record which keys it has already processed along with their result, and return the stored result on any repeat request carrying the same key instead of re-executing the charge. This is the same idempotency mechanism that makes retries safe generally — the operation becomes safe to execute more than once because the server, not the network, is the source of truth for whether it already happened.

### Q7. What's the escalation path for a hot database row that many users are writing to simultaneously?

Start with a conditional write — put the check in the `WHERE` clause so compare-and-set is one atomic statement. If contention is high enough that conditional writes keep failing and retrying, move to explicit locking: pessimistic if collisions are frequent, optimistic with a monotonic version number if they're rare. If the row's lock needs to outlive a single transaction, move to a distributed lock (Redis with a TTL, or Zookeeper for stronger guarantees). If strong consistency on that one row is genuinely required under very high contention, the last resort is serializing all writes to it through a queue, accepting the throughput ceiling that comes with it.

### Q8. Why can't you just put a plain B-tree index on latitude and longitude for a "find nearby" feature?

A B-tree indexes one dimension well, but a location query is inherently two-dimensional — searching a range on latitude alone returns every point in that latitude band, including ones on the opposite side of the planet at the same latitude. You need either an encoding that collapses 2D proximity into a single sortable key (geohash, Google's S2, Uber's H3), or a tree structure built for two dimensions from the ground up (quadtree, K-D tree, R-tree), so that physical nearness translates into index nearness.

### Q9. Your file upload system occasionally has files in blob storage with no matching database record. What's happening and how do you fix it?

This is the classic state-sync problem that comes with separating file storage from file metadata: the client might upload directly to storage and then fail, crash, or get disconnected before it calls back to mark the upload complete in the database, leaving an orphaned file. The standard fix pairs storage-side event notifications — the storage service tells your system the moment a blob lands — with a periodic reconciliation job that scans for blobs with no corresponding "complete" database record and either finishes registering them or cleans them up after a grace period.

### Q10. How would you design ordering guarantees for messages arriving at different servers in a distributed real-time system?

The cleanest option is funnelling all messages that need a shared order through a single stamping point before fan-out, so ordering is established once and everyone downstream agrees on it. Where that's not practical because messages genuinely originate from independent distributed sources, vector clocks or logical (Lamport) timestamps let you establish a causal order after the fact, or you can accept minor out-of-order delivery and re-sort messages client-side within a short buffering window, which is often good enough for something like a comment stream.

### Q11. What's the difference between fan-out-on-write and a hybrid approach for a social feed, and when would you use each?

Fan-out-on-write precomputes each follower's feed the moment a user posts, which makes reads extremely fast since the feed is already assembled — but it breaks down for celebrity accounts with millions of followers, where a single post would trigger millions of writes. The hybrid approach skips precomputation for high-follower accounts and merges their posts in at read time instead, combining fast reads for typical users with a bounded, on-demand cost for celebrity fan-out rather than a write storm on every celebrity post.

### Q12. How do you decide whether a design problem needs sharding, or whether a single database with replicas is enough?

I'd do the arithmetic before deciding anything: total rows times average bytes per row times replication factor, compared against what a single modern managed database instance can hold — often multiple terabytes with room to spare. A billion rows at 500 bytes each is 500GB, comfortably one database with replicas; sharding only earns its complexity once a specific measured ceiling — write throughput, connection count, or storage — is actually being approached, not because the total data size sounds impressively large.
