---
title: Designing a Production Pipeline
description: A senior-level design walkthrough of a producer to queue to consumer to database pipeline covering retries, idempotency, observability and scale
difficulty: Advanced
tags: [system-design, observability, reliability, capacity-planning, messaging]
---

This page pulls together everything from queueing to backpressure to schema evolution into one worked design: a producer publishes to a queue, a consumer processes and writes to a database. It sounds simple until you're asked what happens when the broker goes down at 3am, a message poisons your consumer, or traffic spikes 10x during a sale — which is exactly what a design review interview is testing.

## The full request path

```mermaid
flowchart TD
    C["Client / Upstream Service"] --> API["API Layer"]
    API -->|"write + outbox row, one tx"| DB1[("Producer DB")]
    REL["Outbox Relay"] --> DB1
    REL -->|"publish"| Q["Queue / Topic"]
    Q --> W1["Consumer Instance 1"]
    Q --> W2["Consumer Instance 2"]
    W1 -->|"process"| DB2[("Target DB")]
    W2 -->|"process"| DB2
    W1 -->|"fail after retries"| DLQ["Dead-Letter Queue"]
    W2 -->|"fail after retries"| DLQ
    DLQ --> OPS["On-call / Redrive Tool"]
    W1 --> MET["Metrics + Tracing"]
    W2 --> MET
    Q --> MET
```

Every arrow here is a place something can go wrong, and a senior design answer walks the interviewer through each one deliberately rather than describing only the happy path.

## What to instrument

| Metric | What it tells you | Why it matters |
|---|---|---|
| Throughput (msgs/sec, in and out) | Whether the pipeline is keeping pace with demand | A sustained gap between in-rate and out-rate predicts a growing backlog before it's visible elsewhere |
| Consumer lag / queue depth | How much unprocessed work is backed up | Early warning of a slow or stalled consumer |
| Age of oldest unprocessed message | How stale the backlog actually is, in time | More honest than depth alone — ties directly to freshness SLAs |
| Processing duration (p50/p95/p99) | Per-message handling cost and tail latency | A rising p99 often precedes a lag spike by minutes |
| Failure rate (per consumer, per error type) | Whether errors are transient noise or a real regression | Distinguishes "retry and move on" from "stop and page someone" |
| DLQ depth | Volume of messages that exhausted retries | A non-zero, growing DLQ means real work is silently not happening |

> [!KEY]
> Throughput tells you the system is busy. Lag, age-of-oldest, and DLQ depth tell you whether it's actually keeping up. Design your dashboard around the second group — they're the ones that predict an incident.

## Alerting thresholds

| Signal | Warning | Critical |
|---|---|---|
| Age of oldest message | > 2x normal processing SLA | > 5x SLA or a fixed ceiling tied to business freshness needs |
| DLQ depth | Any sustained growth over a short window | Growth rate accelerating, or absolute count crossing a capacity-planned ceiling |
| Consumer failure rate | > 1% of processed messages over 5 minutes | > 5% over 5 minutes, or any spike coinciding with a deploy |
| Processing duration p99 | > 2x baseline | Approaching the broker's visibility-timeout / redelivery window |

> [!TIP]
> Tie the "processing duration p99 critical" threshold to your broker's visibility timeout or lock duration explicitly — if p99 latency approaches that value, messages start getting redelivered mid-processing, which looks like duplicate processing but is actually a latency problem wearing a different mask.

## The failure matrix

This is the core of a design review: for each way a piece can fail, what actually happens and what should happen.

| Failure | What happens without design | What you build in |
|---|---|---|
| Broker down | Producer calls fail; if synchronous and unguarded, upstream requests fail too | Outbox pattern decouples the business write from publish; relay retries with backoff once broker recovers |
| DB down (consumer's target) | Consumer errors on every message, retries immediately, hammers a DB trying to recover | Circuit breaker: after N consecutive failures, stop attempting for a cooldown window, then retry with backoff |
| Consumer crashes mid-processing | Message may be lost (if acked early) or redelivered (if not yet acked) | Ack only after the DB write commits; design for at-least-once and make the write idempotent |
| Duplicate message delivered | Business effect (e.g. charge, insert) applied twice | Inbox pattern — dedup by message ID in the same transaction as the effect |
| Poison message (always fails) | Blocks the partition/queue behind it if retried forever in place | Bounded retry count, then route to DLQ so the rest of the queue keeps flowing |
| 10x traffic spike | Queue grows unbounded, consumer falls further behind, latency and memory blow up | Bounded queue + backpressure, autoscaled consumer pool, load shedding/priority for lower-value messages |
| Downstream (target DB) slow | Consumer threads pile up waiting, in-flight count grows unbounded | Bound consumer concurrency (semaphore/connection pool cap), apply backpressure upstream, monitor DB saturation directly |

> [!DANGER]
> "Retry immediately, forever" is the failure mode inside almost every other failure mode above. Every retry needs a bound, a backoff, and a terminal path (DLQ) — an infinite retry loop against a genuinely down dependency just converts one outage into a self-inflicted denial-of-service against your own consumer fleet.

## Retries, backoff, and the DLQ

Retry policy needs three explicit decisions: how many attempts, what backoff shape, and what happens after the last attempt.

```csharp
var retryPolicy = Policy
    .Handle<TransientDbException>()
    .WaitAndRetryAsync(
        retryCount: 5,
        sleepDurationProvider: attempt => TimeSpan.FromSeconds(Math.Pow(2, attempt)) // exponential backoff
                                            + TimeSpan.FromMilliseconds(Random.Shared.Next(0, 500))); // jitter

try
{
    await retryPolicy.ExecuteAsync(() => ProcessAndPersistAsync(message));
    await AckAsync(message);
}
catch (TransientDbException)
{
    await _dlq.SendAsync(message, reason: "exhausted retries against target DB");
    await AckAsync(message); // ack original so it doesn't block the queue behind it
}
```

Jitter matters as much as the exponential curve: without it, a batch of messages that failed together retries together, producing synchronized load spikes against the exact dependency that's already struggling.

## Idempotency, end to end

Idempotency isn't one mechanism — it's a property that must hold at every hop: the outbox ensures the event is published exactly once *logically* (even if the relay retries physically), the inbox ensures the consumer's business effect applies exactly once *logically* (even under at-least-once delivery), and the database write itself should use a natural or surrogate key with an upsert/conditional-insert rather than a blind insert, as a last line of defense.

```sql
-- Last line of defense: idempotent write even if the inbox check somehow gets bypassed
INSERT INTO processed_orders (order_id, amount, status)
VALUES (@OrderId, @Amount, 'Processed')
ON CONFLICT (order_id) DO NOTHING;
```

## Capacity planning

| Question | How to answer it |
|---|---|
| Peak sustained throughput? | Measure historical peak, add headroom (commonly 30–50%) for growth, not just today's peak |
| Burst factor? | What's the ratio of your worst realistic spike (flash sale, retry storm) to steady state — size buffers and autoscaling for this, not just sustained peak |
| Per-message processing cost? | p95 processing time × desired throughput = minimum concurrent consumer capacity needed |
| Partition/shard count | Enough to parallelize to your target throughput, but each partition only as ordered as it needs to be — more partitions than consumers wastes nothing, fewer than consumers wastes consumers |
| DB connection budget | Total consumer concurrency × connections per worker must stay under the target DB's safe connection ceiling |

> [!WARNING]
> Sizing a consumer pool purely for steady-state throughput and ignoring burst factor is the single most common capacity-planning mistake — the pipeline works fine for months until the first real spike, which is exactly the worst time to discover the gap.

## Deployment and draining

Rolling a new consumer version needs a **drain** step: stop pulling new messages, finish in-flight ones, then shut down — not a hard kill that abandons partially processed, unacknowledged messages mid-flight (which is safe under at-least-once, but noisy and wasteful). For ordered/partitioned consumption (Kafka-style), a rebalance during deploy briefly pauses affected partitions; keep deploy batch sizes small (rolling, not all-at-once) to bound how much of the pipeline is mid-rebalance at once.

```mermaid
sequenceDiagram
    participant Orchestrator
    participant OldPod as "Old Consumer Pod"
    participant NewPod as "New Consumer Pod"
    participant Queue
    Orchestrator->>OldPod: SIGTERM (start drain)
    OldPod->>Queue: stop polling for new messages
    OldPod->>OldPod: finish in-flight messages, ack
    OldPod->>Orchestrator: ready to terminate
    Orchestrator->>NewPod: start
    NewPod->>Queue: begin polling
```

## Testing strategy

| Layer | What to test |
|---|---|
| Unit | Idempotent-write logic, retry/backoff policy behaviour, DLQ routing decisions |
| Integration | Real broker + real DB in a test environment: crash the consumer mid-batch, verify no data loss/duplication |
| Contract | Schema compatibility checks against every known consumer before publishing a producer change |
| Load | Sustained throughput at target rate, plus a burst test at your defined burst factor, watching lag and DB saturation |
| Chaos | Kill the broker connection, kill the DB connection, and a consumer pod mid-processing — verify recovery matches the failure matrix, not just "it eventually came back" |

## Cheat sheet

- Instrument the pipeline for lag and freshness, not just throughput: queue depth, age of oldest message, p99 processing duration, failure rate, DLQ depth.
- Tie alert thresholds to real SLAs and to broker mechanics (e.g. p99 near the visibility timeout is a real warning sign, not noise).
- Build the failure matrix explicitly: broker down, DB down, crash mid-processing, duplicates, poison messages, spikes, slow downstream — each needs a designed answer, not a hope.
- Every retry needs a bound, exponential backoff with jitter, and a terminal path (DLQ) — unbounded retries turn one outage into a self-inflicted second one.
- Idempotency must hold end-to-end: outbox (publish), inbox (consume), and an upsert/conditional-write at the database as the last line of defense.
- Capacity-plan for burst factor, not just steady-state peak — the burst is when the design gets tested for real.
- Deploys need a drain step; hard kills under at-least-once are safe but wasteful and noisy.
- Test with chaos, not just unit tests: kill the broker, the DB, and a consumer mid-batch, and confirm recovery matches the design.

## Common mistakes

| Mistake | Fix |
|---|---|
| Dashboards showing only throughput | Add lag, age of oldest message, DLQ depth, and p99 processing duration |
| Retrying a permanently failing message forever in place | Bound retries, then route to a DLQ so the queue keeps flowing |
| Retrying without jitter | Add jitter to backoff to avoid synchronized retry storms against a struggling dependency |
| Sizing consumer capacity for steady-state only | Plan explicitly for a defined burst factor, not just historical average peak |
| Hard-killing consumers on deploy | Add a drain step: stop pulling new work, finish in-flight, then exit |
| Assuming idempotency at only one layer (e.g. only the inbox) | Enforce it end-to-end: outbox, inbox, and an idempotent DB write |
| Testing only the happy path before shipping | Add chaos tests: broker down, DB down, consumer crash mid-message |

## Summary

A production-grade pipeline is defined less by its happy path and more by how deliberately it answers each failure in the matrix: what happens when the broker is down, when the database is down, when a message is duplicated or poisoned, when traffic spikes 10x, and when a consumer crashes mid-write. Observability that surfaces lag and staleness — not just throughput — combined with bounded, jittered retries, a DLQ as a real escape valve, end-to-end idempotency, burst-aware capacity planning, and a proper drain on deploy is what separates a pipeline that survives its first real incident from one that becomes the incident. This is the level of detail a senior design review expects, and the level worth rehearsing out loud before the interview.

## Top Interview Questions

### Q1. Walk me through the end-to-end design of a producer-to-queue-to-consumer-to-database pipeline.

A producer writes its business state change and an event to an outbox table in one local transaction, so publishing is decoupled from the immediate request path and never lost even if the broker is briefly unavailable. A relay reads unpublished outbox rows and publishes them to a queue or topic; one or more consumer instances pull from it, process each message, and write to a target database, acking only after that write commits so a crash mid-processing results in redelivery rather than silent loss. Failures that exhaust a bounded retry policy route to a dead-letter queue rather than blocking the rest of the traffic, and the whole path — producer, relay, queue depth, consumer lag, DB writes — is instrumented so a slowdown at any hop is visible before it becomes an incident. I'd also note idempotency is required end-to-end, since at-least-once delivery guarantees duplicates will eventually happen.

### Q2. What would you put on a dashboard for this pipeline, and why not just throughput?

Throughput alone tells you the system is busy, not whether it's keeping up — a consumer processing 1,000 msgs/sec looks identical on a throughput graph whether the inbound rate is 900/sec (healthy) or 5,000/sec (falling badly behind). I'd add consumer lag or queue depth, and specifically age of oldest unprocessed message, which converts backlog into a directly meaningful unit — time against your freshness SLA. I'd also track p50/p95/p99 processing duration per message, since a rising p99 often predicts a lag spike before lag itself visibly moves, failure rate broken down by error type to distinguish transient noise from a real regression, and DLQ depth, since a growing DLQ means real messages are silently not being processed at all.

### Q3. The broker goes down for ten minutes at 3am. Walk through what happens in your design, hop by hop.

Because publishing goes through an outbox pattern, the producer's business writes continue succeeding — they only depend on the local database, not the broker — so upstream requests are unaffected. The outbox relay's publish attempts start failing; it retries with backoff and simply accumulates a growing backlog of unpublished outbox rows, which is safe and bounded by the outbox table itself, not memory. Consumers see no new messages and their lag briefly reads as “no lag” even though a real backlog is queuing up outside their view — which is why I'd also monitor outbox backlog age specifically, not just consumer-side lag. Once the broker recovers, the relay drains the backlog; I'd expect a short burst of catch-up traffic and want consumer autoscaling or throttling ready so that burst doesn't itself cause a secondary slowdown.

### Q4. How do you handle a poison message — one that will never succeed no matter how many times you retry it?

I'd bound the retry count per message with exponential backoff and jitter, and once that bound is exhausted, route the message to a dead-letter queue along with metadata about why it failed and how many attempts were made, then ack the original so it stops blocking whatever is behind it in the same partition or queue. Without this bound, a single bad message retried indefinitely in place can stall an entire ordered partition, effectively taking down all traffic behind it even though only one message is actually broken. The DLQ then becomes a queue on-call can inspect, understand the failure reason for, potentially fix (a bug, a bad schema) and redrive, or discard if it's genuinely unprocessable — deliberately, not by accident.

### Q5. A consumer processes a message, writes to the database, but crashes before acknowledging it. What happens, and is that a problem?

Because the message wasn't acknowledged before the crash, the broker will redeliver it once the consumer restarts (or another instance picks it up), which means the same message could be processed — and its database write attempted — twice. This is expected, correct behaviour for an at-least-once system, not a bug, provided the database write itself is idempotent: an upsert or conditional insert keyed on a natural or message ID, or an inbox-table check before applying the effect. The actual failure mode to design against isn't the crash itself, it's a consumer that acks *before* the write commits (risking silent data loss) or one whose writes aren't idempotent (risking duplicate financial or business effects) — the crash-and-redeliver behavior on its own is exactly what the system is supposed to do.

### Q6. How would you design for a duplicate message being delivered — is this something you prevent or something you tolerate?

You tolerate it, because eliminating duplicates entirely would require exactly-once delivery semantics across a network, which no realistic broker-and-consumer combination guarantees end-to-end. The design answer is an idempotent receiver: an inbox table that records the message ID as part of the same transaction that applies the business effect, so a duplicate delivery is detected and safely skipped rather than reapplied. As a defense-in-depth measure, the database write itself should also be idempotent (upsert on a natural key) so that even if the inbox check is somehow bypassed — a bug, a race, a manual redrive — the final write still can't apply the effect twice. Treating duplicates as "prevent" rather than "tolerate and dedupe" is a common design mistake that leads to fragile, exactly-once-emulating machinery instead of robust idempotency.

### Q7. Traffic spikes 10x during a flash sale. What breaks first, and how do you design against it?

Without design, the consumer pool sized for steady-state throughput falls behind immediately, queue depth and age of oldest message climb, and if the queue itself is unbounded, memory pressure or storage costs grow with it — the effects cascade to whatever the consumer writes to next, often the database, whose connection pool and query load also spike far past its steady-state provisioning. I'd design for this with autoscaling triggered on lag/age rather than only CPU, a bounded queue with an explicit load-shedding or priority policy for lower-value message types under sustained pressure, and capacity planning that explicitly accounts for a defined burst factor (not just historical average peak) when sizing both the consumer pool and the downstream database's connection budget. The key senior point: this should be a rehearsed, load-tested scenario, not the first time the system experiences 10x traffic being an actual incident.

### Q8. The target database becomes slow (not down, just degraded) — high latency on every write. How does your pipeline behave, and what would you want it to do instead?

Without design, each consumer worker's write takes much longer, in-flight/concurrent writes pile up against the DB's connection pool, consumer throughput craters, lag grows, and if consumers keep pulling new messages while old ones are still stuck writing, memory and connection usage can spiral, worsening the exact DB slowness that started the problem. What I'd want instead: bound consumer concurrency (a semaphore or a capped connection pool per worker) so a slow DB throttles how much new work is pulled rather than piling up unboundedly, apply backpressure upstream of the consumer so the queue absorbs the slowdown in a bounded way, and alert on DB-side saturation metrics (connection pool utilization, query latency) directly rather than waiting to infer it from consumer lag alone, since that's a faster and more direct signal of the actual root cause.

### Q9. How do you deploy a new version of the consumer without losing or duplicating in-flight messages?

The consumer process needs to handle a graceful shutdown signal by draining: stop pulling new messages from the queue immediately, finish processing and acknowledging whatever messages it already has in flight, and only then exit — rather than being hard-killed, which (while safe under at-least-once, since unacked messages just get redelivered) is noisier and wastes the work already done on those in-flight messages. For partitioned/ordered consumption specifically, I'd also deploy in small rolling batches rather than all instances at once, since each instance stopping triggers a partition rebalance that briefly pauses affected partitions — a full simultaneous redeploy would pause the entire pipeline at once instead of a small rolling fraction of it.

### Q10. How would you capacity-plan the number of consumer instances and database connections for this pipeline?

Start from the target sustained throughput and multiply by the p95 (not average) per-message processing time to get the minimum concurrent processing capacity needed, then add headroom — commonly 30–50% — for growth and for the burst factor specific to this workload (a flash sale's peak-to-steady-state ratio, for instance), since sizing for average historical peak alone is the most common capacity-planning mistake I'd flag. From there, total database connections needed is consumer instance count times per-worker connection pool size, which must stay under the target database's safe connection ceiling — if that math doesn't fit, either reduce per-worker connections (batch writes, connection pooling/multiplexing) or scale the database's connection capacity, rather than silently letting consumers contend for a connection pool that's too small.

### Q11. How would you test this pipeline before trusting it in production?

Beyond unit tests for the idempotent-write logic, retry/backoff behaviour, and DLQ routing decisions, I'd run integration tests against a real broker and real database that explicitly crash the consumer mid-batch and verify no message is lost or double-processed incorrectly. I'd add contract tests validating schema compatibility against every known consumer before a producer schema change ships, load tests at both the target sustained throughput and the defined burst factor while watching lag and database saturation, and chaos tests that kill the broker connection, kill the database connection, and kill a consumer pod mid-processing independently, verifying each recovers according to the failure matrix rather than just eventually "coming back" with no verification of correctness during the outage.

### Q12. If you had to remove one piece of this design due to budget or timeline pressure, which would you fight hardest to keep, and why?

I'd fight hardest for end-to-end idempotency (the inbox pattern plus an idempotent database write) over almost anything else, because every other piece of this design — retries, redelivery on crash, replay, even normal at-least-once broker semantics — silently assumes duplicates are safe to process, and without idempotency every one of those mechanisms becomes a source of double-charged customers or corrupted state instead of a resilience feature. Observability and the DLQ are close seconds since they determine whether you find out about a problem in minutes versus from a customer complaint days later, but idempotency is the one property that, if missing, turns every other correctly-designed resilience mechanism into an active liability instead of a safety net.
