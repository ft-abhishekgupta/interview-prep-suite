---
title: Consumer Groups and Scaling
description: How partitions cap consumer parallelism, tuning prefetch, concurrency and lock duration together, autoscaling on lag, and the maths of backlog recovery
difficulty: Advanced
tags: [messaging, scaling, kafka, autoscaling]
---

Scaling a messaging consumer is not "add more instances and it goes faster" — beyond a hard ceiling set by partitions or sessions, extra consumers just idle, and settings like prefetch, concurrency and lock duration interact in ways that silently cause duplicate concurrent processing if tuned in isolation.

## Competing consumers vs consumer groups

A **competing consumer** pool (a plain queue with multiple readers) has no partition concept — any consumer can pick up any message, and adding consumers scales throughput smoothly up to the point where the queue itself or a downstream resource becomes the bottleneck. A **consumer group** (Kafka, Event Hubs) is a named set of consumers that jointly own a topic's partitions, with each partition assigned to exactly one consumer in the group at a time — parallelism is capped at the partition count, not open-ended.

| | Competing consumers (queue) | Consumer group (log) |
|---|---|---|
| Parallelism ceiling | Prefetch/concurrency settings, downstream capacity | Number of partitions |
| Adding an instance beyond the ceiling | Marginal gains shrink, but no instance is fully idle | Extra instance gets zero partitions — fully idle |
| Message ownership | Any consumer can get any message | Exactly one consumer per partition, per group |
| Rebalancing | Not a concept — no fixed assignment | Explicit protocol reassigns partitions when membership changes |

> [!KEY]
> The single most commonly missed fact in this space: **a Kafka/Event Hubs consumer group can never have more effective parallelism than partitions.** Scaling a deployment from 10 to 20 pods against a 10-partition topic does not double throughput — it just leaves 10 pods with no partitions assigned, doing nothing.

Two queues each split into partitions, with exactly as many consumers as partitions per queue, is what that ceiling looks like in practice — every consumer stays busy, but a fifth one added to either queue would sit idle:

![Two message queues each split across partitions, with one consumer matched to each partition](notes/05-HighLevelDesign/AsyncSystems/image-6.png)

## Scaling rules of thumb

| Rule | Reasoning |
|---|---|
| Consumers ≤ partitions (log-based) | Extra consumers beyond partition count are provably idle |
| Size partitions for 12-24 months of expected peak parallelism | Repartitioning later reshuffles key→partition mapping and can break ordering |
| For a plain queue, scale consumers to downstream capacity, not an arbitrary number | The queue itself rarely bottlenecks first — the database/API behind it usually does |
| Prefer fewer, higher-concurrency consumers over many low-concurrency ones for ordered work | Reduces rebalancing churn and connection overhead |

## Prefetch, concurrency and lock duration

These three settings interact, and tuning one without the others is a classic cause of message loss or duplicate processing.

```mermaid
flowchart TD
    PF["Prefetch count"] -->|"messages buffered locally"| CC["Concurrency (max parallel handlers)"]
    CC -->|"determines how long messages sit before processing starts"| LD["Lock duration"]
    LD -->|"if too short vs actual processing time"| L["Lock expires mid-processing → redelivered to another consumer → duplicate work"]
```

| Setting | What it controls | Risk if too high | Risk if too low |
|---|---|---|---|
| Prefetch count | Messages pulled and locked locally ahead of processing | Messages sit locked but unprocessed, risk of lock expiry before their turn; wasted memory | Consumer idles waiting for the next fetch round-trip, hurting throughput |
| Concurrency (max parallel calls) | How many messages are processed at once per instance | Downstream/database overload; resource contention | Under-utilizes available consumer capacity |
| Lock duration | How long a message is reserved before becoming visible again | Slow failure detection — a crashed consumer's message takes longer to become available again | Message becomes visible to another consumer while still being processed — duplicate work |

> [!WARNING]
> A high prefetch count combined with a short lock duration is the classic misconfiguration: messages sit in the local prefetch buffer waiting their turn, their lock clock is already running, and by the time the consumer actually starts processing them the lock may have only seconds left — or already expired, so another consumer picks up the "same" message concurrently.

## Lock renewal for long processing

If a handler's processing time is close to or exceeds the lock duration, renew the lock explicitly rather than raising lock duration indefinitely (a very long fixed lock duration slows down failure recovery for every message, not just the slow ones).

```csharp
var options = new ServiceBusProcessorOptions
{
    MaxConcurrentCalls = 8,
    PrefetchCount = 16,               // roughly 2x concurrency, not 100x
    AutoCompleteMessages = false
};

processor.ProcessMessageAsync += async args =>
{
    using var cts = new CancellationTokenSource();
    // Renew the lock in the background while the long-running handler executes
    var renewalTask = RenewLockPeriodicallyAsync(args, cts.Token);

    try
    {
        await ProcessLongRunningWorkAsync(args.Message);
        await args.CompleteMessageAsync(args.Message);
    }
    finally
    {
        cts.Cancel();
        await renewalTask;
    }
};
```

## Autoscaling on queue depth or lag

Scaling on CPU utilization alone is misleading for messaging consumers, since a backlogged-but-idle-CPU consumer (waiting on a slow downstream call) shows low CPU while desperately needing more instances. Scale on **queue depth** (broker queues) or **consumer lag** (log-based systems) instead — KEDA is the standard tool for this in Kubernetes, scaling pod count based on a queue-length or Kafka-consumer-group-lag metric.

| Metric | Meaning | Good scale-out trigger |
|---|---|---|
| Queue depth | Messages waiting, unconsumed | Depth growing faster than it's draining |
| Consumer lag (log) | Difference between latest offset and consumer's committed offset | Lag growing over a sustained window, not a single spike |
| Active message count | Messages currently locked/in-flight | High active count with low completion rate suggests stuck consumers, not a capacity problem |

> [!TIP]
> Consumer lag is the single most important metric for a log-based consumer — not CPU, not memory. A consumer group with flat CPU but climbing lag is either under-provisioned relative to partition count or is stuck on a slow downstream call; the fix is different in each case, but lag is what tells you to look.

## Backlog recovery maths

If a queue is being produced to at rate `P` messages/sec and consumed at rate `C` messages/sec, the backlog only shrinks when `C > P`. Time to clear an existing backlog `B` is `B / (C - P)`.

| Production rate | Consumption rate | Existing backlog | Time to clear |
|---|---|---|---|
| 100/sec | 90/sec | 10,000 | Never — backlog grows forever, `C < P` |
| 100/sec | 150/sec | 10,000 | 200 seconds |
| 100/sec | 120/sec | 50,000 | 2,500 seconds (~42 min) |

> [!DANGER]
> A consumer that's "keeping up" (C ≈ P) will never clear a pre-existing backlog — you need meaningfully more consumption capacity than production rate, temporarily, to actually drain it. This is the number-one thing to say out loud when asked "how would you recover from a backlog": scale out until `C` comfortably exceeds `P`, don't just restore the steady-state consumer count.

## Idle consumers, cost, and rebalancing storms

Over-provisioning consumers has real costs beyond idle compute: in a Kafka consumer group, an idle consumer still participates in the group protocol, meaning every scale-up or scale-down event, every consumer restart, and every missed heartbeat triggers a rebalance affecting the *entire group* — more group members generally means more frequent and more disruptive rebalances, since a rebalance pauses consumption for the partitions being reassigned. A "rebalancing storm" happens when consumers are churning (crashlooping, being killed by autoscaling scale-down too aggressively, or missing heartbeats due to slow processing) faster than the group can stabilize, keeping throughput near zero even though healthy consumers exist.

## Tuning table

| Setting | Effect | Risk of misconfiguration |
|---|---|---|
| Prefetch count | Reduces round-trip latency for the next message | Too high → messages expire in the local buffer before being processed |
| Max concurrent calls | Increases parallel processing per instance | Too high → overloads downstream dependency shared across instances |
| Lock duration | Time before an unfinished message becomes visible again | Too short → duplicate processing; too long → slow failure recovery |
| Partition/session count | Hard ceiling on consumer parallelism | Too low → under-scaled no matter how many consumers you add |
| Consumer group session/heartbeat timeout | How tolerant the group is of a slow/busy consumer before evicting it | Too short → spurious rebalances under normal load spikes; too long → slow detection of a truly dead consumer |
| Autoscaler trigger metric | Determines what "under load" means | CPU-based triggers miss I/O-bound backlog growth; use queue depth/lag instead |

## Cheat sheet

- Consumer group parallelism is hard-capped at partition/session count — extra consumers beyond that are provably idle.
- Prefetch, concurrency and lock duration must be tuned together: prefetch too high + lock duration too short is the classic duplicate-processing bug.
- Renew locks explicitly for long-running handlers instead of just raising lock duration globally.
- Scale on queue depth or consumer lag, not CPU — CPU is a poor proxy for I/O-bound backlog growth.
- Clearing a backlog requires consumption rate to *exceed* production rate, not just match it — "keeping up" never drains an existing backlog.
- Over-provisioned idle consumers in a log-based group increase rebalance frequency and disruption, not just cost.
- Size partitions generously up front — repartitioning later is disruptive and risks breaking per-key ordering.

## Common mistakes

| Mistake | Fix |
|---|---|
| Scaling a Kafka consumer group beyond its partition count expecting more throughput | Increase partition count (with care for ordering) instead, or accept the parallelism ceiling |
| Setting prefetch very high "for efficiency" without checking lock duration | Size prefetch relative to concurrency and confirm messages won't sit past lock expiry |
| Autoscaling on CPU for an I/O-bound consumer | Scale on queue depth or consumer lag instead |
| Restoring only the steady-state consumer count to "fix" a backlog | Temporarily over-scale so consumption rate exceeds production rate until the backlog clears |
| Ignoring rebalancing storms caused by aggressive scale-down or crashlooping consumers | Tune heartbeat/session timeouts and avoid over-aggressive autoscaler scale-in thresholds |

## Summary

Consumer parallelism has a hard ceiling — partitions for log-based systems, downstream/prefetch capacity for plain queues — and adding consumers past that ceiling buys nothing. Prefetch, concurrency and lock duration must be tuned as one system, not independently, or you get duplicate processing from expired locks. Autoscale on queue depth or consumer lag rather than CPU, and remember that clearing an existing backlog needs consumption to meaningfully exceed production, not just match it. Over-provisioning has a cost beyond compute — in consumer groups it means more frequent, more disruptive rebalances — so right-size deliberately rather than defaulting to "more instances is safer."

## Top Interview Questions

### Q1. Why can't you scale a Kafka consumer group's throughput indefinitely by adding more consumer instances?

Because Kafka assigns each partition to exactly one consumer within a group at a time — this is what preserves per-partition ordering — so the maximum useful number of consumers in a group equals the number of partitions. Adding an 11th consumer to a group reading a 10-partition topic gets that consumer zero partition assignments; it sits fully idle, consuming no messages at all, regardless of how much spare capacity it has. To genuinely increase parallelism you need more partitions, which is a topic-level change that reshuffles the key-to-partition hash and can break per-key ordering guarantees for any key that moves to a different partition, so it's usually planned for well in advance rather than done reactively.

### Q2. How do prefetch count, concurrency, and lock duration interact, and what goes wrong if they're misaligned?

Prefetch count determines how many messages are pulled and locked locally ahead of actual processing; concurrency determines how many of those are processed in parallel; lock duration determines how long a message stays reserved before becoming visible to other consumers again. If prefetch is set much higher than concurrency, messages queue up in the local buffer waiting their turn while their lock clock is already ticking, so by the time processing actually starts on a given message, its lock may be close to or past expiry — causing it to become visible to another consumer while the first is still working on it, resulting in duplicate concurrent processing. The fix is sizing prefetch conservatively relative to concurrency (often roughly 1-2x) and lock duration relative to realistic P99 processing time, or using explicit lock renewal for handlers whose duration is unpredictable.

### Q3. What's the correct way to autoscale a set of queue consumers, and why is CPU a poor metric?

Scale based on queue depth (for broker-based queues) or consumer lag (for log-based systems like Kafka/Event Hubs), typically via a tool like KEDA in Kubernetes that reads these metrics directly from the broker and adjusts replica count. CPU utilization is a poor proxy because most consumer workloads are I/O-bound — waiting on a downstream database or API call — so a severely backlogged consumer that's mostly blocked on network I/O can show low CPU usage the entire time its backlog is growing unboundedly, meaning a CPU-based autoscaler never triggers scale-out precisely when it's needed most. Lag/depth directly measures the thing you actually care about: is work piling up faster than it's being drained.

### Q4. Explain the maths of recovering from a message backlog. Why doesn't "restoring normal capacity" fix it?

If messages arrive at rate `P` per second and are consumed at rate `C` per second, the backlog only shrinks when `C > P`; if `C` merely equals `P` (the system is "keeping up" in steady state), any pre-existing backlog `B` never clears — it stays constant forever. The time to clear a backlog is `B / (C − P)`, which requires `C` to meaningfully exceed `P`, not just match it. This is why the correct incident response to a backlog is to temporarily over-scale consumers well beyond normal steady-state capacity — enough that `C` clearly exceeds `P` — until the backlog is drained, then scale back down, rather than just restoring the consumer count that was "normal" before the incident, which would leave the backlog permanently stuck at its current size.

### Q5. What is a rebalancing storm and what causes it?

A rebalancing storm is a state where a Kafka (or similar) consumer group repeatedly triggers the partition-reassignment protocol because group membership keeps changing — consumers crashlooping, being aggressively killed and restarted by an overly sensitive autoscaler, or missing heartbeats because a slow handler exceeds the session timeout — faster than the group can stabilize into a working assignment. Since a rebalance pauses consumption for affected partitions until reassignment completes, a group stuck rebalancing repeatedly can have near-zero effective throughput even though individual consumer instances are healthy. The fix is tuning session/heartbeat timeouts to tolerate normal processing latency, using incremental/cooperative rebalancing protocols that avoid a full stop-the-world reassignment, and configuring autoscaler scale-down thresholds conservatively so healthy consumers aren't killed and restarted unnecessarily.

### Q6. When would you choose to renew a message lock explicitly instead of just increasing the lock duration setting?

I'd renew explicitly whenever processing time is variable or occasionally long-tailed — most messages process quickly, but a subset take much longer due to payload size or downstream latency. Raising the global lock duration to accommodate the worst case slows down failure recovery for *every* message, including the fast, common-case ones: if a consumer crashes mid-processing, its messages won't become visible to another consumer until the (now much longer) lock expires. Explicit lock renewal — extending the lock periodically in a background task while the handler runs — lets you keep a short default lock duration for fast failure detection on the common path, while still safely accommodating the occasional slow message without it being redelivered mid-flight.

### Q7. Your Kafka consumer group has 8 consumers and a 4-partition topic. What's the actual problem here, and how would you explain it to someone who wants to "just add more consumers" to fix slow processing?

The actual problem is a partition-count ceiling, not a consumer-count problem — with only 4 partitions, at most 4 consumers in the group can ever be assigned work; the other 4 are structurally idle no matter how the workload is distributed. Adding a 9th, 10th consumer changes nothing, since Kafka never assigns more than one consumer per partition within a group. I'd explain that the fix here is increasing the partition count (accepting the operational cost of reshuffling the key-to-partition mapping, and checking whether any downstream ordering guarantees depend on the current mapping), not adding more consumer replicas — and that partition count should be planned generously up front specifically to avoid hitting this ceiling reactively under load.

### Q8. How would you decide the right level of concurrency (max parallel calls) per consumer instance?

I'd size it against the capacity of the shared downstream dependency, not just the consumer's own CPU/memory — if 10 consumer instances each run 20 concurrent calls, the downstream database or API sees up to 200 concurrent calls from this consumer alone, which may exceed its connection pool or rate limit regardless of how much headroom each individual consumer has. I'd start conservatively, load test to find the point where downstream latency/error rate starts degrading, and set concurrency (multiplied across all instances) comfortably below that ceiling, then use autoscaling on queue depth/lag to add more instances — each within the same safe per-instance concurrency — rather than pushing concurrency higher per instance as the primary scaling lever.

### Q9. What's the risk of leaving a large pool of idle consumers around "just in case" in a Kafka consumer group?

Beyond the direct compute cost of running idle instances, every consumer in a group is a group protocol participant — it sends heartbeats and is subject to reassignment during a rebalance. A larger group generally means rebalances (triggered by any single member joining, leaving, or being evicted for a missed heartbeat) affect more partitions' worth of reassignment bookkeeping and can take longer to stabilize, and if any of those idle consumers are unstable (crashlooping, being killed by an aggressive autoscaler), they can trigger a disproportionate number of rebalances relative to the actual work they contribute — since they were never assigned partitions in the first place, they're pure overhead with real reliability downside, not just wasted spend.

### Q10. In production, a consumer group's lag is steadily climbing even though CPU usage across consumers looks fine. Walk through your diagnosis.

Since CPU looks healthy but lag is climbing, I'd suspect an I/O-bound bottleneck rather than a compute-bound one — most likely the consumers are waiting on a slow downstream dependency (a database, an external API) per message, so they're mostly idle-on-I/O rather than idle-on-lack-of-work, which explains normal CPU with growing lag. I'd check per-message processing latency and downstream call latency/error rate first. If the downstream is genuinely the bottleneck, adding more consumer instances won't help beyond the partition-count ceiling and may make the downstream problem worse; the fix is addressing the downstream capacity or the per-call latency, or explicitly checking whether partition count is the limiting factor if the group is already at max useful consumers and downstream capacity has headroom to spare.
