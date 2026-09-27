---
title: Azure Service Bus
description: Queues versus topics, sessions for ordered processing, peek-lock delivery, dead-lettering and the tuning knobs that show up in production incidents
difficulty: Core
tags: [azure, service-bus, messaging, queues]
---

Service Bus is the enterprise messaging broker interviewers expect you to know cold if your resume mentions distributed systems on Azure. This page covers queues versus topics, sessions, delivery semantics, dead-lettering, and the tuning parameters that actually show up in incident reviews.

## Queues vs topics/subscriptions

A **queue** is point-to-point — one message, consumed by exactly one competing consumer. A **topic** is publish/subscribe — one message is published once, and delivered to every **subscription** attached to that topic, each subscription acting like its own independent queue with its own competing consumers.

```mermaid
flowchart LR
    P["Publisher"] --> T["Topic: orders"]
    T --> S1["Subscription: billing"]
    T --> S2["Subscription: fulfilment"]
    T --> S3["Subscription: analytics"]
    S1 --> C1["Billing consumers"]
    S2 --> C2["Fulfilment consumers"]
    S3 --> C3["Analytics consumers"]
```

| | Queue | Topic + Subscriptions |
|---|---|---|
| Delivery pattern | One consumer group gets each message once | Every subscription gets its own copy of each message |
| Use case | Work distribution across competing workers | Fan-out to multiple independent consumers |
| Filtering | N/A | Each subscription can filter which messages it receives |

## Subscription filters

Subscriptions can filter which messages of a topic they actually receive, avoiding the need for consumers to filter after receiving (and paying for) every message.

| Filter type | How it matches | Example |
|---|---|---|
| SQL filter | SQL-like boolean expression against message properties | `Region = 'EU' AND Priority > 3` |
| Correlation filter | Cheaper, exact-match against specific properties (correlation ID, label, etc.) | `CorrelationId = 'order-123'` |
| True/False filter | Matches everything or nothing (default is match-all) | Used to disable a subscription temporarily |

Prefer correlation filters over SQL filters when you only need exact-match logic — they're evaluated more cheaply by the service and scale better with high subscription counts. Reach for SQL filters only when you need actual boolean/comparison logic.

## Sessions for ordered processing

By default, Service Bus makes **no ordering guarantee** across a queue/subscription under concurrent consumers. **Sessions** fix this for a specific scenario: messages tagged with the same `SessionId` are guaranteed to be delivered in the order they were sent, and locked to one consumer at a time — giving FIFO processing per session key (e.g. per customer, per order) while still allowing many different sessions to be processed concurrently by different consumers.

```csharp
// Sender tags messages with a session ID
var message = new ServiceBusMessage(body) { SessionId = orderId };
await sender.SendMessageAsync(message);

// Receiver must use a session-aware receiver — locks one session at a time
ServiceBusSessionReceiver receiver = await client.AcceptNextSessionAsync("orders-queue");
ServiceBusReceivedMessage msg = await receiver.ReceiveMessageAsync();
```

> [!KEY]
> Enabling sessions on a queue/subscription is a **creation-time setting** you cannot toggle later — decide up front whether you need per-key ordering. It also means every message sent to that entity *must* carry a `SessionId`, even if ordering doesn't matter for some of them.

## Peek-lock vs receive-and-delete

| Mode | Behaviour | Failure handling |
|---|---|---|
| Peek-lock (default, recommended) | Message is locked and hidden from other consumers, but stays in the queue until explicitly completed | If the consumer crashes before completing, the lock expires and the message becomes visible again — at-least-once delivery |
| Receive-and-delete | Message is deleted from the queue the instant it's handed to the consumer | If the consumer crashes after receiving but before finishing processing, the message is gone forever — at-most-once delivery |

> [!DANGER]
> Receive-and-delete trades reliability for a small throughput/latency win. Use it only for workloads where losing a message occasionally is acceptable (some telemetry pipelines); anything with a business or financial consequence should use peek-lock so a crashed consumer doesn't silently drop work.

## Lock duration and lock renewal

Peek-lock messages have a **lock duration** (default 30–60 seconds, configurable up to 5 minutes) during which the consumer must either complete, abandon, or dead-letter the message, or renew the lock. Processing that can take longer than the lock duration must call `RenewMessageLockAsync` periodically (most SDKs' message-processor abstractions do this automatically) — otherwise the lock silently expires mid-processing, the message becomes available to another consumer, and you can end up processing the same message twice concurrently.

## Max delivery count and the dead-letter queue

Every queue/subscription has a **max delivery count** (default 10): if a message is delivered and abandoned/expires that many times without being completed, Service Bus automatically moves it to the entity's built-in **dead-letter queue (DLQ)** instead of retrying forever. The DLQ is a sub-queue of the same entity, inspectable and reprocessable independently — a message stuck in a poison-message loop stops blocking the head of the main queue once it's dead-lettered.

```mermaid
sequenceDiagram
    participant S as "Sender"
    participant Q as "Queue"
    participant C as "Consumer"
    participant DLQ as "Dead-letter queue"
    S->>Q: Send message
    Q->>C: Deliver (peek-lock)
    C--xQ: Abandon/crash (attempt 1)
    Q->>C: Redeliver (attempt 2..N)
    C--xQ: Still failing (attempt = maxDeliveryCount)
    Q->>DLQ: Auto dead-letter
```

> [!WARNING]
> A message can also be dead-lettered *explicitly* by the consumer (`DeadLetterMessageAsync`) for business-logic reasons — e.g. "this payload failed schema validation" — distinct from exhausting delivery count. Always tag the dead-letter reason/description so someone triaging the DLQ later knows why without re-deriving it.

## Scheduled and deferred messages

**Scheduled messages** are enqueued now but not visible to receivers until a specified future time — useful for "remind this customer in 24 hours" workflows without an external scheduler. **Deferred messages** are explicitly set aside by the receiver (`DeferMessageAsync`) after being seen but not ready to process yet, retrievable later only by their specific sequence number — useful for out-of-order workflow steps where you've seen a message but are waiting on a prerequisite.

## Duplicate detection window

Service Bus can detect and silently discard duplicate sends within a configurable **duplicate detection window** (up to 7 days), keyed by the message's `MessageId` — critical for safe retries: if a sender times out waiting for a send acknowledgment and retries, without duplicate detection you'd get two copies of the same logical message in the queue.

Duplicate detection is a send-side safety net for network-level retries, not a substitute for idempotent message processing on the consumer side — a consumer should still be able to safely process the same message twice if it somehow gets through (e.g. after a lock-expiry redelivery), which duplicate detection doesn't prevent.

## Transactions and send-via

Service Bus supports local transactions across multiple operations on **the same entity** (e.g. complete this message and send a new one atomically) and cross-entity transactions using **send-via**, which routes a send through a specific queue/topic so it participates in the same transaction as a receive on a different entity — the classic pattern for "receive from queue A, do work, send to queue B" with all-or-nothing semantics.

## Tiers and limits

| Tier | Max entity size | Sessions/partitioning | SLA | Typical use |
|---|---|---|---|---|
| Basic | 256 KB message, 5 GB queue | No topics, no sessions | No SLA | Simple queuing only |
| Standard | 256 KB message, 5 GB queue | Topics, sessions, scheduled/deferred | 99.9% | Most production workloads |
| Premium | 1 MB (up to 100 MB with large messages) | Dedicated resources (predictable latency), VNet integration, higher throughput | 99.9% (financially backed) | High-throughput, low-jitter, VNet-isolated production |

> [!TIP]
> Premium tier's biggest practical benefit interviewers want named isn't the message size limit — it's **dedicated compute/messaging units**, which removes noisy-neighbour latency jitter that Standard's shared multi-tenant infrastructure can introduce under load.

## Prefetch and concurrency tuning

**Prefetch count** lets the client pull a batch of messages into local memory ahead of processing, reducing round trips and improving throughput — but too high a prefetch count risks messages sitting in the client's local buffer long enough for their lock to expire before actually being processed. **Max concurrent calls** on the message processor controls how many messages are handled in parallel per client instance; tune both alongside lock duration so prefetched-but-not-yet-processed messages don't outlive their lock.

```csharp
var options = new ServiceBusProcessorOptions
{
    PrefetchCount = 20,
    MaxConcurrentCalls = 10,
    AutoCompleteMessages = false // explicit complete/abandon for control
};
var processor = client.CreateProcessor("orders-queue", options);
processor.ProcessMessageAsync += async args =>
{
    await HandleOrder(args.Message);
    await args.CompleteMessageAsync(args.Message);
};
processor.ProcessErrorAsync += args => { /* log, alert */ return Task.CompletedTask; };
await processor.StartProcessingAsync();
```

## Cheat sheet

- Queue = point-to-point competing consumers; topic + subscriptions = fan-out, each subscription is its own queue.
- Correlation filters are cheaper than SQL filters — use exact-match filters when logic allows it.
- Sessions give FIFO-per-key ordering; it's a creation-time setting and every message needs a `SessionId` once enabled.
- Peek-lock = at-least-once (default, safe); receive-and-delete = at-most-once (faster, lossy on crash).
- Lock duration is per-message; renew it explicitly (or via the processor) for long-running work.
- Max delivery count auto-dead-letters poison messages so they stop blocking the queue head.
- Duplicate detection window protects against sender-side retry duplicates, not against consumer redelivery — processing must still be idempotent.
- Send-via enables cross-entity atomic transactions (receive from A, send to B, all-or-nothing).
- Premium tier's real value is dedicated capacity (no noisy-neighbour jitter), not just bigger message size.
- Tune prefetch count and lock duration together — over-prefetching risks lock expiry before processing.

## Common mistakes

| Mistake | Fix |
|---|---|
| Assuming Service Bus guarantees global ordering | Ordering is only guaranteed within a session; design with `SessionId` if order matters |
| Using receive-and-delete for anything business-critical | Use peek-lock; accept receive-and-delete only where occasional loss is fine |
| Not renewing locks on long-running message processing | Call `RenewMessageLockAsync` or use a processor abstraction that auto-renews |
| Treating duplicate detection as consumer-side idempotency | Design consumers to safely process the same message twice regardless |
| Setting prefetch count too high relative to lock duration | Lower prefetch or raise lock duration so messages don't expire while buffered |
| Ignoring the dead-letter queue until it's full | Monitor DLQ depth and alert; triage messages with a recorded dead-letter reason |
| Trying to enable sessions on an existing queue | Sessions must be set at creation time — recreate the entity if needed |

## Summary

Service Bus's core trade-offs are all about delivery guarantees: peek-lock versus receive-and-delete for at-least-once versus at-most-once, sessions for ordered processing at the cost of a creation-time commitment, and max delivery count plus the dead-letter queue for isolating poison messages without blocking healthy ones. Topics and subscriptions extend the same reliability model to fan-out scenarios, with filters keeping each subscription's traffic relevant. The operational knobs — lock duration, prefetch, duplicate detection window, and tier choice — are what an interviewer probes to see if you've actually run Service Bus under load rather than just read the docs.

## Top Interview Questions

### Q1. What's the difference between a Service Bus queue and a topic, and when would you use each?

A queue is point-to-point: each message is consumed exactly once by whichever competing consumer picks it up first, making it ideal for distributing work across a pool of workers where each unit of work should be handled once. A topic is publish/subscribe: a single published message is delivered to every subscription attached to that topic, and each subscription behaves like its own independent queue with its own competing consumers — ideal when multiple independent systems need to react to the same event (e.g. an "order placed" event needing to trigger billing, fulfilment, and analytics independently). The decision is really about fan-out: if exactly one consumer group should ever see a given message, use a queue; if multiple, logically separate consumer groups each need their own copy, use a topic with one subscription per consumer group.

### Q2. How do sessions provide ordering guarantees, and what's the catch?

Sessions group related messages under a shared `SessionId`, and Service Bus guarantees that messages within the same session are delivered in send order and locked to a single consumer at a time, so a consumer processing session "customer-123" won't have another consumer concurrently processing a different message from that same session out of order. The catch is it's a creation-time configuration on the queue or subscription — you can't retroactively enable it on an existing entity — and once enabled, every message sent to that entity must carry a `SessionId`, even ones where ordering doesn't actually matter. It also changes the receive pattern: instead of just receiving the next available message, a session-aware receiver must first accept a specific session (`AcceptNextSessionAsync`), which affects how you design consumer scaling since concurrency is naturally bounded by the number of distinct active sessions.

### Q3. Explain peek-lock versus receive-and-delete and why peek-lock is the default recommendation.

In peek-lock mode, a received message is hidden from other consumers for a lock duration but remains in the queue until the consumer explicitly completes, abandons, or dead-letters it — if the consumer crashes mid-processing, the lock simply expires and the message becomes available again, guaranteeing at-least-once delivery. In receive-and-delete mode, the message is removed from the queue the instant it's handed to the consumer, so if the consumer crashes after receiving but before finishing its work, that message is gone permanently — at-most-once delivery. Peek-lock is the default recommendation because most business workloads care more about not silently losing work than about the small overhead of the lock/complete round trip; receive-and-delete is reserved for scenarios (some telemetry, best-effort logging) where occasional message loss is an acceptable trade for slightly lower latency and simpler code.

### Q4. What happens to a message that keeps failing to process, and how do you handle it operationally?

Every queue or subscription has a max delivery count (default 10); each time a message is delivered and then abandoned, expires via lock timeout, or otherwise fails to complete, its delivery count increments, and once it hits the max, Service Bus automatically moves it into that entity's built-in dead-letter queue rather than retrying indefinitely. This prevents a single "poison message" — one that always throws an exception in the consumer, say due to a malformed payload — from blocking the head of the queue and starving every message behind it. Operationally, I'd monitor dead-letter queue depth as an alerting signal, have consumers explicitly dead-letter messages with a reason code for business-logic failures (not just letting them exhaust delivery count blindly), and build a triage process — sometimes an admin tool or scheduled job — to inspect, fix, and resubmit or discard dead-lettered messages rather than letting the DLQ grow unmonitored.

### Q5. A consumer is processing messages that sometimes take 3 minutes, but you're seeing duplicate processing of the same message. What's the likely cause and fix?

The likely cause is lock expiry: peek-lock messages have a lock duration (commonly 30–60 seconds by default) during which the consumer must complete the message or renew the lock, and if processing genuinely takes 3 minutes without the lock being renewed, Service Bus assumes the consumer died, releases the lock, and redelivers the message to another consumer — meanwhile the original consumer is still working on it, unaware its lock has expired, so you end up with two consumers processing the same logical message concurrently. The fix is to either increase the lock duration to comfortably exceed the expected processing time (up to the 5-minute maximum), or — better for variable processing times — use a message-processing abstraction (like `ServiceBusProcessor`) that automatically renews the lock in the background for as long as the handler is still running, so long-tail processing times don't require guessing a single fixed lock duration upfront.

### Q6. How would you design cross-queue transactional processing — receiving from queue A and sending to queue B atomically?

I'd use Service Bus's transaction support with **send-via**: instead of sending directly to queue B, the send is routed via queue A (the entity being transacted against), which lets the receive-from-A and send-to-B operations participate in the same local transaction and commit or roll back together. This guarantees that if the transaction fails partway — say the send to B throws — the receive from A also rolls back (the message becomes available again), so you never end up in a state where a message was consumed from A but the corresponding message never made it to B. It's important to note this transactional guarantee is scoped within Service Bus itself; if the workflow also needs to atomically update an external database in the same transaction, that requires an outbox pattern or a saga rather than relying on Service Bus transactions to span both systems.

### Q7. Why would you choose the Premium tier over Standard, beyond just larger message size limits?

The headline feature people remember is the larger max message size (up to 100 MB with large message support versus 256 KB on Standard), but the more operationally significant benefit is that Premium runs on dedicated messaging units rather than shared multi-tenant infrastructure, which removes the "noisy neighbour" latency jitter that can occur on Standard tier under load from other tenants sharing the same underlying resources. Premium also supports VNet integration and private endpoints for network isolation, which Standard doesn't, and comes with a financially backed 99.9% SLA. I'd choose Premium for latency-sensitive production workloads where predictable p99 latency matters, or where network isolation is a hard compliance requirement — and accept Standard for most workloads where the cost difference isn't justified by those specific needs.

### Q8. How does duplicate detection work, and why doesn't it eliminate the need for idempotent consumers?

Duplicate detection is configured with a time window (up to 7 days) during which Service Bus tracks the `MessageId` of every message sent to an entity, and silently discards any subsequent send with a `MessageId` it's already seen within that window — this protects against the case where a sender's network call times out waiting for an acknowledgment, retries the send, and would otherwise produce two copies of the same logical message. It doesn't eliminate the need for idempotent consumers because duplicate detection only guards against duplicate *sends*; a message can still be delivered to a consumer more than once through entirely legitimate mechanisms — a lock expiring before completion and the message being redelivered, for instance — which duplicate detection has no visibility into at all. A correct system therefore needs both: duplicate detection to avoid inflating the queue with sender-retry duplicates, and idempotent processing logic (e.g. keying business operations off the message's business ID, not just trusting "I only saw this once") to handle legitimate redelivery safely.

### Q9. Your team is fanning out one event to five downstream systems using topics and subscriptions, but one subscription's consumer has been down for two days. What's the impact on the other four?

None — each subscription in a topic is an entirely independent queue with its own message store, so a stalled or offline consumer on one subscription has zero impact on the delivery or processing of messages in the other subscriptions; they continue being delivered and processed normally. The only consequence is scoped to that one subscription: messages accumulate there until the consumer comes back online (subject to the entity's message TTL, after which they'd expire or dead-letter if that's configured), and depending on the message time-to-live configured on the topic/subscription, sufficiently old undelivered messages could expire before that consumer recovers. This isolation is precisely why topics/subscriptions are the right pattern for fan-out to independent systems — a single downstream outage doesn't create backpressure on the other four, unlike a design where one shared queue is being drained by multiple different logical consumer types.

### Q10. How would you tune prefetch count and concurrency for a processor handling a high-throughput queue, and what could go wrong if you set them too aggressively?

I'd set `MaxConcurrentCalls` based on how many messages the consumer can genuinely process in parallel without contention (bounded by downstream dependency capacity, like a database connection pool), and set `PrefetchCount` to a modest multiple of that (e.g. 2-3x) so the client always has a small buffer of messages ready to hand to a free processing slot without waiting on a network round trip, improving throughput. The risk of setting prefetch too high relative to processing speed is that messages sit in the client's local in-memory buffer, still "locked" from the service's perspective, for potentially a long time before actually being picked up for processing — if that wait plus actual processing time exceeds the lock duration, the lock expires before the message is even handled, causing unnecessary redelivery and duplicate-processing risk. The fix is to keep prefetch proportional to actual processing throughput and lock duration, not just maximize it for raw throughput, and to monitor for unexpected redelivery counts as a signal the balance is off.
