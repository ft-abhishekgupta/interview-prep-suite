---
title: Message Queues and Pub Sub
description: Point to point queues versus publish subscribe versus log based streaming, why a queue is added at all, and the guarantees each topology actually gives you
difficulty: Core
tags: [message-queues, pub-sub, kafka, event-driven]
---

Adding a queue is one of the most common "deep dive" moves in a system design interview, and also one of the most commonly justified with a vague wave — "we'll add a queue for scale." The strong answer names exactly which problem the queue solves and which topology fits it.

## Why you add a queue at all

A queue sits between a producer and a consumer so they don't have to interact synchronously. That decoupling buys four concrete things:

| Benefit | What it actually means |
|---|---|
| Decoupling | Producer and consumer can be deployed, scaled, and fail independently — the producer doesn't need to know who, or how many, consumers exist |
| Load levelling | A burst of 100,000 requests can be written to a queue instantly and drained by consumers at a sustainable rate, instead of overwhelming downstream services |
| Retries | A failed message can be redelivered rather than silently lost, without the original caller needing to retry manually |
| Buffering | If a downstream consumer is temporarily slow or down, work queues up rather than being dropped or blocking the producer |

> [!KEY]
> A queue turns a **synchronous** dependency into an **asynchronous** one. That's the whole value proposition — everything else (ordering, fan-out, retries) is a detail of how a specific queue implements that core trade.

## Point-to-point queue vs publish/subscribe vs log-based streaming

| | Point-to-point queue | Publish/subscribe | Log-based streaming |
|---|---|---|---|
| Model | One message, consumed by exactly one consumer | One message, delivered to every subscriber | An append-only, partitioned, ordered log; consumers read at their own offset |
| Consumption | Competing consumers pull from a shared queue | Each subscription gets its own copy | Consumers pull and track their own position (offset) |
| After consumption | Message is removed/acked, gone | Delivered once per subscription, then typically gone | Message stays in the log for a retention window — can be **replayed** |
| Ordering | FIFO within the queue (or per session/group key) | No cross-subscriber ordering guarantee generally | Strict ordering **within a partition** |
| Replay | ❌ | ❌ | ✅ — re-read from any earlier offset |
| Typical use | A command: "process this order," done once | A notification: "this happened," fan out to many interested services | A high-volume stream: clicks, telemetry, logs, ingest for analytics |
| Examples | SQS, Service Bus queue, RabbitMQ queue | SNS, Service Bus topic/subscription, Event Grid | Kafka, Event Hubs, Kinesis, Pulsar |

> [!TIP]
> Say the distinction as: *"A queue delivers a message once, to one consumer. Pub/sub delivers it once per subscriber. A log lets many consumers each read the same events independently, at their own pace, and even rewind."*

## Point-to-point: competing consumers

```mermaid
flowchart LR
    P["Producer"] --> Q[["Queue"]]
    Q --> C1["Consumer 1"]
    Q --> C2["Consumer 2"]
    Q --> C3["Consumer 3"]
```

Multiple consumer instances pull from the same queue and **compete** for messages — each message goes to exactly one of them. This is the standard pattern for scaling out background work: add more consumer instances and throughput increases roughly linearly, with the queue naturally load-balancing across whichever consumers are currently available. It's the right model when a message represents a unit of work that should happen exactly once, like "send this email" or "process this payment."

## Publish/subscribe: fan-out

```mermaid
flowchart LR
    P["Producer"] --> T(("Topic"))
    T --> S1["Subscription A<br/>→ Email service"]
    T --> S2["Subscription B<br/>→ Analytics"]
    T --> S3["Subscription C<br/>→ Search indexer"]
    S1 --> C1["Consumer group A"]
    S2 --> C2["Consumer group B"]
    S3 --> C3["Consumer group C"]
```

A single published event is delivered to **every** subscription independently — each subscription behaves like its own queue with its own competing consumers underneath it. This is the right model when one event needs to trigger several unrelated pieces of downstream work: "an order was placed" should notify the email service, update analytics, and trigger fraud detection, all independently, without the order service knowing any of those consumers exist.

## Log-based streaming: partitions and consumer groups

A log-based system like Kafka or Event Hubs is structurally different: messages are appended to a durable, ordered log split into **partitions**, and consumers don't "take" a message off a queue — they read at an **offset** they track themselves, which means the same message can be read by many independent consumer groups, and a consumer can rewind and replay history.

| Concept | What it means |
|---|---|
| Partition | A shard of the log; ordering is guaranteed **within** a partition only, not across the whole topic |
| Partition key | Determines which partition a message lands in — messages with the same key always go to the same partition, preserving their relative order |
| Consumer group | A set of consumers sharing the work of one topic; each partition is read by exactly one consumer within a given group |
| Offset | A consumer's bookmark in the log; committing an offset marks "I've processed up to here" |
| Retention | How long messages stay in the log regardless of consumption — hours to days, sometimes indefinite |

**A partition count is usually fixed at topic creation** and caps your maximum parallelism within one consumer group — you cannot have more active consumers in a group than partitions, so partition count is itself a capacity-planning decision, not just an implementation detail.

## Ordering guarantees

Ordering is one of the most commonly mis-stated guarantees. Get specific rather than saying "the queue preserves order":

- **Point-to-point queues** typically guarantee FIFO delivery only within a single queue or a session/group key, not globally across all consumers if multiple are competing on unrelated messages.
- **Pub/sub** generally makes **no** ordering guarantee across subscribers, and often none across messages published in quick succession either, unless the specific product explicitly supports it.
- **Log-based streaming** guarantees order **within a partition** only. Two messages with different keys landing in different partitions have no relative order guarantee — if strict ordering matters for a given entity, its messages must share a partition key (e.g., always partition by `userId` or `orderId`).

## Visibility timeout and redelivery

When a consumer pulls a message off a point-to-point queue, most implementations don't delete it immediately — they make it **invisible** to other consumers for a **visibility timeout**, during which the consumer is expected to finish processing and explicitly acknowledge (delete) it. If the consumer crashes or takes too long, the message becomes visible again and another consumer picks it up.

> [!WARNING]
> A visibility timeout set shorter than your actual processing time causes the **same message to be processed twice** — once by the original (still-working) consumer and again by whoever picks it up after it reappears. This is the most common source of accidental duplicate processing, and the fix is either extending the timeout or having the consumer periodically renew ("heartbeat") the lock while still working.

This is also why **idempotent consumers** are a non-negotiable part of any real queue design: because at-least-once delivery (redelivery on timeout, retry, or crash) is the default guarantee almost everywhere, and exactly-once delivery is either unavailable or expensive enough that most systems design around idempotency instead of relying on it.

## When a queue makes things worse

> [!DANGER]
> A queue is not a free reliability upgrade. It adds a component, a new failure mode, and — critically — turns a request the caller could get an immediate answer to into one they cannot.

Skip or reconsider a queue when:

- The caller genuinely needs a synchronous response before it can proceed (a login check, a payment authorization the user is waiting on) — queueing it just adds latency and complexity for no benefit.
- The workload is low volume and consistently fast enough that a direct call is simpler to operate, monitor, and debug.
- Ordering and exactly-once semantics are hard requirements and the team isn't prepared to build idempotency and dedupe logic — a queue without that discipline introduces subtle correctness bugs.
- You need a response value back from the operation synchronously — queues are naturally fire-and-forget; a request/response pattern over a queue (a reply queue, correlation IDs) is possible but adds real complexity.

## Cheat sheet

- A queue's core value is turning a synchronous dependency into an asynchronous one — decoupling, load levelling, retries, buffering.
- Point-to-point queue: one message, one consumer, competing consumers scale throughput.
- Pub/sub: one event, delivered to every subscription independently — the fan-out pattern.
- Log-based streaming (Kafka/Event Hubs): durable, partitioned, replayable; many consumer groups can read the same data independently.
- Ordering is only ever guaranteed within a scope — a queue's FIFO session, or a log's partition — never globally by default.
- Visibility timeout too short = duplicate processing; always design consumers to be idempotent regardless.
- Partition count caps parallelism per consumer group — it's a capacity decision, not an implementation detail.
- Don't add a queue when the caller needs a synchronous answer, or when volume/complexity doesn't justify the extra moving part.

## Common mistakes

| Mistake | Fix |
|---|---|
| Saying "add a queue" without naming point-to-point, pub/sub, or streaming | Pick the topology that matches the actual fan-out and replay needs |
| Assuming a queue guarantees global ordering | State the actual scope: per-session/group for queues, per-partition for logs |
| Building consumers that assume exactly-once delivery | Design for at-least-once and make processing idempotent |
| Setting a visibility timeout shorter than real processing time | Extend it, or have the consumer heartbeat/renew the lock |
| Using a queue for a call that needs a synchronous response | Keep that path synchronous; only queue genuinely async work |
| Ignoring partition key design in a log-based system | Choose a key that preserves ordering for the entities that need it and spreads load evenly |
| Treating a dead-letter queue as optional | Configure one — failed messages should land somewhere inspectable, not vanish |

## Summary

A queue's entire value is converting a synchronous dependency into an asynchronous one, buying decoupling, load levelling, retries, and buffering — but which topology to use depends on whether a message should go to exactly one consumer (point-to-point), to every interested subscriber (pub/sub), or to many independent consumer groups that can each replay history (log-based streaming). Ordering and delivery guarantees are always scoped — to a session, a partition, never the whole system by default — which is why idempotent consumers are standard practice rather than a nice-to-have. And a queue is not automatically the right answer: when a caller needs a synchronous result, or the volume doesn't justify the operational cost, a direct call is still the better design.

## Top Interview Questions

### Q1. What problem does adding a message queue actually solve, and when would you propose one in a design?

A queue decouples a producer from a consumer so they don't have to be available or fast at the same time — the producer writes a message and moves on, and the consumer processes it whenever it's able to. I'd propose one specifically when I see one of four situations: the producer and consumer need to scale or deploy independently, there's a traffic burst that would overwhelm a downstream service if handled synchronously, work needs to survive a transient consumer failure via retry, or a slow consumer shouldn't block a fast producer. I wouldn't propose a queue reflexively for every async-sounding operation — only when one of those specific problems is actually present in the design.

### Q2. What's the difference between a point-to-point queue and publish/subscribe, and how would you decide between them?

In a point-to-point queue, each message is delivered to exactly one consumer, even if multiple consumer instances are competing to read from the same queue — this fits a "do this unit of work once" scenario, like processing a single order. In publish/subscribe, a single published event is delivered independently to every subscription, each of which behaves like its own queue underneath — this fits a "notify everyone who cares that this happened" scenario, like an order being placed triggering email, analytics, and fraud-detection services simultaneously, none of which know about each other. I'd choose point-to-point when there's one logical piece of work to be done once, and pub/sub when one event needs to fan out to multiple independent downstream consumers.

### Q3. How does a log-based system like Kafka differ fundamentally from a traditional message queue?

A traditional queue removes or hides a message once it's been consumed and acknowledged — it's essentially a transient work list. A log-based system like Kafka retains messages in an ordered, append-only log for a configured retention period regardless of whether they've been read, and consumers track their own position (an offset) in that log rather than the broker deciding when a message is "gone." This means multiple independent consumer groups can each read the same stream of events at their own pace, and any consumer can rewind and replay historical events — capabilities a traditional queue, which deletes messages after consumption, simply doesn't offer.

### Q4. Explain competing consumers and how it helps you scale a background job system.

Competing consumers means multiple instances of a consumer application all read from the same queue, and the queue ensures each individual message only goes to one of them, effectively load-balancing work across however many consumer instances are currently running. This lets you scale processing throughput horizontally just by adding more consumer instances — the queue handles distributing messages, so you don't need custom logic to divide work between them. It's the standard mechanism behind background job processing systems: as the backlog grows, you scale out consumers, and as it shrinks, you scale them back in, all without changing how producers publish work.

### Q5. What does "ordering is guaranteed within a partition, not across the topic" mean, and why does the partition key matter?

A log-based system like Kafka splits a topic into multiple partitions to allow parallel reads and writes, but strict message ordering is only guaranteed for messages that land in the same partition — there's no guarantee about the relative order of messages that end up in different partitions. The partition key is what determines which partition a message goes to, and messages sharing the same key always land in the same partition, in the order they were produced. So if you need all events for a given order or user to be processed in the order they occurred, you must partition by that order or user ID — partitioning by something unrelated, or not thinking about it at all, can silently break the ordering guarantee your consumers assume.

### Q6. What is a visibility timeout, and what happens if it's misconfigured?

When a consumer pulls a message from a point-to-point queue, the message typically isn't deleted immediately — it becomes invisible to other consumers for a visibility timeout window, during which the original consumer is expected to finish processing and explicitly delete (acknowledge) it. If the consumer is still legitimately processing when the timeout expires, the message becomes visible again and a different consumer can pick it up and process it too — resulting in the same message being handled twice. The fix is either setting the timeout comfortably longer than the worst-case realistic processing time, or having long-running consumers periodically extend ("heartbeat") the timeout while they're still actively working on it.

### Q7. Why do queue-based systems typically only guarantee "at-least-once" delivery, and how should consumers be designed as a result?

Guaranteeing exactly-once delivery in a distributed system is genuinely hard — it requires coordinating the message broker, the network, and the consumer's own processing and acknowledgment in a way that survives any single failure without either losing or duplicating a message, and most systems accept the operational cost of that isn't worth it compared to the alternative. Instead, most queues guarantee at-least-once delivery (a message might be redelivered after a timeout, a retry, or a crash, but won't be silently dropped) and push the responsibility for correctness onto the consumer. This means consumers should be designed to be idempotent — processing the same message twice should produce the same end result as processing it once, typically by checking a unique message ID against records of what's already been processed before acting on it again.

### Q8. A background worker is falling behind on a queue and the backlog keeps growing. What would you investigate and how would you fix it?

First I'd check whether this is a throughput problem (not enough consumer capacity for the incoming rate) or a stuck-consumer problem (consumers are failing and messages are cycling through retries without ever completing) — the fix is very different depending on which. If it's throughput, I'd scale out more consumer instances, since competing consumers should let throughput scale roughly linearly with instance count, assuming the downstream dependency the consumers call can also handle the increased load. If it's a stuck consumer, I'd check the dead-letter queue for a pattern of failures, check whether a specific message shape is consistently causing an exception or a timeout, and check whether the visibility timeout is too short relative to actual processing time, causing messages to be reprocessed repeatedly instead of completing.

### Q9. Why would you choose a log-based streaming platform like Kafka over a traditional pub/sub system for an analytics pipeline?

An analytics pipeline typically needs to process the same stream of events through multiple independent systems over time — real-time dashboards today, a batch reprocessing job next month after a bug fix, a new analytics feature added later that needs to backfill from historical events. A traditional pub/sub system delivers each event once per subscription and then it's gone, so any new consumer added later only sees events from that point forward. A log-based system retains events for a configurable retention window (hours to days, sometimes longer), so a new consumer group can be added at any time and either start fresh or replay from an earlier offset — this replayability is usually the deciding factor for analytics and event-sourcing-style workloads specifically.

### Q10. When would adding a message queue actually make a system design worse?

When the caller genuinely needs an immediate, synchronous answer to proceed — like a login check or payment authorization the user is actively waiting on — queueing that call just adds latency and complexity without giving the caller anything to do while it waits, unless you also build a full request/response pattern over the queue (a reply channel and correlation IDs), which is significant extra complexity for something a direct synchronous call already does simply and correctly. It also makes things worse when the team isn't prepared to handle at-least-once delivery correctly — adding a queue without designing for idempotent, duplicate-tolerant consumers introduces subtle correctness bugs that are often harder to debug than the synchronous version would have been.

### Q11. How would you design fan-out so that one event, like "user signed up," triggers a welcome email, an analytics event, and a fraud check, without those three consumers depending on each other?

I'd publish a single "user signed up" event to a pub/sub topic, and have each interested system — the email service, analytics, fraud detection — maintain its own independent subscription to that topic. Each subscription behaves like its own queue underneath, with its own competing consumers if it needs to scale independently, and none of the three services need to know about each other or about how many other subscribers exist. This also means a new consumer (say, a future loyalty-points service) can be added later just by creating a new subscription to the same topic, with zero changes required to the producer or to any of the existing consumers.

### Q12. A partition in your Kafka-based system is consistently processed slower than the others, causing lag specifically for one group of users. What's likely happening and how would you address it?

This is most likely a hot-partition problem: if the partition key used doesn't distribute load evenly — for example, partitioning by a value where one particular key (a very active user or a popular product) generates disproportionately more messages than others — that one partition can receive far more traffic than its peers while a single consumer within the group is still limited to processing one partition at a time. Since partition count is fixed at topic creation and caps parallelism per consumer group, simply adding more consumers won't help beyond one consumer per partition. The fix usually involves choosing a partition key with better cardinality and distribution, or, if a specific known entity is disproportionately hot, applying a hot-key-style mitigation like suffixing that key to spread its messages across multiple partitions and recombining downstream.
