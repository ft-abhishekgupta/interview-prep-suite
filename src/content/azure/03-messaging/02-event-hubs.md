---
title: Azure Event Hubs
description: The partitioned log model, throughput units versus processing units, checkpointing with EventProcessorClient and why partition count is a decision you cannot easily undo
difficulty: Advanced
tags: [azure, event-hubs, streaming, partitions]
---

Event Hubs questions test whether you understand log-based streaming versus queue-based messaging — a distinction interviewers use to see if you'd reach for the right tool for high-throughput telemetry versus transactional work. This page covers partitioning, throughput scaling, consumer groups, checkpointing, and the partition-count decision you cannot walk back.

## The partitioned log model

Event Hubs is a distributed, append-only log, conceptually close to Kafka. Events are appended to one of N **partitions**, each partition an independently ordered, replayable sequence — Event Hubs does not delete a message once read (unlike Service Bus); instead, every event sits in its partition until it ages out of the configured **retention** window, and any number of independent consumers can read the same events at their own pace.

```mermaid
flowchart LR
    P["Producers"] --> EH["Event Hub"]
    EH --> Part0["Partition 0"]
    EH --> Part1["Partition 1"]
    EH --> Part2["Partition 2"]
    Part0 --> CG1["Consumer group: live-dashboard"]
    Part0 --> CG2["Consumer group: archival"]
    Part1 --> CG1
    Part1 --> CG2
```

> [!KEY]
> Service Bus is a broker — a message is consumed and gone. Event Hubs is a log — a message stays put and multiple independent readers replay the same stream at their own offsets. Reach for Event Hubs when you need high-throughput ingestion with replay (telemetry, clickstreams, IoT); reach for Service Bus when you need transactional guarantees per message (ordering via sessions, dead-lettering, exactly-once-feeling delivery via peek-lock).

## Partitions and partition keys

Producers can specify a **partition key**; Event Hubs hashes it to consistently route all events with the same key to the same partition, guaranteeing ordering *within that key* — the same guarantee Service Bus sessions provide, but as a routing hash rather than an exclusive lock. Without a partition key, events are spread round-robin (or by a send-time batching heuristic) across partitions for maximum throughput, at the cost of no ordering guarantee across the whole hub.

| Partitioning choice | Ordering | Throughput distribution |
|---|---|---|
| No partition key | None across the whole hub | Even, maximizes parallelism |
| Partition key (e.g. device ID) | Guaranteed per key | Even only if keys are well-distributed |
| Explicit partition ID | Guaranteed within that partition | You own the balancing — rarely worth it |

> [!WARNING]
> A poorly chosen partition key (low cardinality, or one "hot" key producing far more events than others) creates a **hot partition** — one partition absorbing disproportionate load while others sit idle, capping your effective throughput to that single partition's limit regardless of how many partitions exist. Choose keys with enough cardinality and even distribution (customer ID often works better than "region" for a small number of regions).

## Throughput units vs processing units

Event Hubs capacity is purchased in different units depending on tier — this is a common point of confusion in interviews.

| Tier | Capacity unit | What it buys (roughly) | Scaling |
|---|---|---|---|
| Standard | Throughput Unit (TU) | 1 MB/s in, 2 MB/s out, per unit | Manual or auto-inflate (auto-scales TUs up to a cap) |
| Premium | Processing Unit (PU) | Dedicated compute/memory/storage, no noisy neighbours | Manual |
| Dedicated | Capacity Unit (CU) | Entire dedicated cluster, highest throughput ceiling | Manual, for the largest workloads |

> [!TIP]
> "Auto-inflate" on Standard tier automatically increases throughput units up to a configured maximum when sustained load exceeds current capacity — mentioning this shows you understand Event Hubs won't silently throttle you into data loss if you configure it, though it will still throttle (`ServerBusyException`) up to that ceiling being raised.

## Consumer groups, offsets, and checkpoints

A **consumer group** is an independent "view" of the entire event stream — each consumer group can read the whole hub at its own pace without affecting others, which is how Event Hubs supports one stream feeding a real-time dashboard and a separate archival pipeline simultaneously without contention. Within a consumer group, an **offset** marks a specific position within a partition; a **checkpoint** is a consumer group's durably recorded offset, stored externally (typically Blob Storage), so that if a consumer restarts, it resumes from the last checkpoint rather than re-reading from the beginning or losing its place.

```mermaid
sequenceDiagram
    participant EH as "Event Hub partition"
    participant Proc as "EventProcessorClient"
    participant Blob as "Checkpoint store (Blob)"
    Proc->>EH: Read events from last checkpoint
    EH-->>Proc: Batch of events
    Proc->>Proc: Process batch
    Proc->>Blob: Write checkpoint (offset/sequence number)
    Note over Proc,Blob: On restart, resumes from this offset
```

## EventProcessorClient and the blob checkpoint store

`EventProcessorClient` (the .NET SDK's recommended consumer abstraction) coordinates multiple consumer instances within a consumer group, using a shared Blob Storage container both for checkpointing and for **ownership** — a lease-based mechanism deciding which instance currently owns which partition, so N instances automatically divide up P partitions between them without you writing coordination logic yourself.

```csharp
var storageClient = new BlobContainerClient(blobConnectionString, "eventhub-checkpoints");
var processor = new EventProcessorClient(
    storageClient, "archival-group", eventHubConnectionString, "orders-hub");

processor.ProcessEventAsync += async args =>
{
    await HandleEvent(args.Data);
    // Checkpoint periodically, not on every single event — checkpointing is itself an I/O cost
    if (args.Data.SequenceNumber % 100 == 0)
        await args.UpdateCheckpointAsync();
};
processor.ProcessErrorAsync += args => { /* log, alert */ return Task.CompletedTask; };
await processor.StartProcessingAsync();
```

Checkpointing after every single event adds a blob write per event, which throttles throughput badly at scale. Checkpoint periodically (every N events or every few seconds) — the trade-off is that on restart you reprocess the small batch of events since the last checkpoint, so handlers must be idempotent regardless of checkpoint frequency.

## Ordering guarantees per partition

Ordering is only guaranteed **within a single partition**, never across the whole hub. If your consumer needs to see all events for a given entity (a specific device, a specific customer) in order, that entity's events must consistently land on the same partition — which is exactly what a well-chosen partition key achieves. There is no hub-wide sequence number that spans partitions; each partition has its own independent, monotonically increasing sequence number.

## Retention and replay

Event Hubs retains events for a configured period (1–7 days on Standard, up to 90 days on Premium/Dedicated) regardless of whether any consumer has read them — this is the core log-vs-broker distinction again. Any consumer group can rewind to an earlier offset (or the very beginning) and reprocess the stream, which is invaluable for backfilling a new downstream system, recovering from a bug in a consumer's processing logic, or replaying into a rebuilt read model.

## Capture to blob

**Event Hubs Capture** automatically writes a copy of every event to Azure Storage or Data Lake in Avro format, on a time/size-based batching interval, with zero consumer code required — a built-in, low-effort way to get a durable, queryable archive of the raw stream for analytics or compliance, decoupled entirely from your real-time consumer groups.

## Kafka protocol compatibility

Event Hubs exposes a **Kafka-compatible endpoint**, so existing Kafka producer/consumer clients and tools (Kafka Connect, Kafka Streams apps) can point at an Event Hub with only a connection-string/endpoint change, no code rewrite. This is a common migration or hybrid-cloud story: teams already invested in the Kafka ecosystem get a managed, Azure-native backend without abandoning existing tooling.

Kafka compatibility is at the protocol level, not a perfect 1:1 feature match — some Kafka-specific administrative operations and certain broker-level configurations don't map directly, so validate specific client library behaviour rather than assuming full parity.

## Scaling consumers relative to partitions and rebalancing

The maximum useful parallelism for a single consumer group is **one active reader per partition** — adding more consumer instances than partitions within the same group leaves the extras idle. When an instance joins or leaves a consumer group (scale-out, crash, deployment), `EventProcessorClient` **rebalances** ownership of partitions among the remaining/new instances automatically via the shared checkpoint store's lease mechanism.

| Consumers vs partitions | Effect |
|---|---|
| Consumers < partitions | Some consumers own multiple partitions each |
| Consumers = partitions | One-to-one, maximum parallelism per instance |
| Consumers > partitions | Extra consumers sit idle for that consumer group |

## Choosing a partition count you cannot easily change

Partition count is fixed at creation on the Standard tier and effectively very disruptive to change afterward (it requires creating a new hub and migrating producers/consumers, since existing partition-key-to-partition hashing would change with a different count) — this is the single most consequential up-front decision in an Event Hubs design.

> [!DANGER]
> Under-provisioning partitions caps your maximum consumer parallelism permanently (you can never have more actively useful consumers per group than partitions), while over-provisioning has ongoing cost and slightly higher management overhead but is far less risky. When unsure, err toward more partitions than today's throughput strictly requires, sized for projected growth over the next 1–2 years, not just current load.

## Cheat sheet

- Event Hubs is a replayable log; Service Bus is a broker that deletes consumed messages — pick based on whether replay matters.
- Ordering is guaranteed only within a partition; use a well-distributed partition key for per-entity ordering.
- Standard tier scales in Throughput Units (1 MB/s in, 2 MB/s out each); Premium/Dedicated use dedicated Processing/Capacity Units.
- Consumer groups are independent full views of the stream; checkpoints are a consumer group's durable offset, usually in Blob Storage.
- `EventProcessorClient` handles partition ownership/rebalancing automatically via the shared checkpoint store.
- Checkpoint periodically, not per-event — and keep handlers idempotent regardless, since replay after restart is normal.
- Retention (1–90 days depending on tier) enables replay/backfill; Capture automatically archives to Blob/Data Lake in Avro.
- Kafka-compatible endpoint lets existing Kafka clients point at Event Hubs with a connection-string change.
- Partition count is essentially fixed at creation — size generously for growth, since under-provisioning permanently caps parallelism.

## Common mistakes

| Mistake | Fix |
|---|---|
| Choosing a low-cardinality or skewed partition key | Pick a key (e.g. entity ID) with enough cardinality and even distribution |
| Checkpointing on every single event | Checkpoint every N events or on a time interval; keep handlers idempotent |
| Expecting ordering across the whole hub | Ordering is per-partition only; route related events to the same partition via key |
| Running more consumer instances than partitions in one consumer group | Extra instances are idle — size the consumer group to the partition count |
| Under-sizing partition count for future growth | Over-provision moderately; changing count later means a new hub and migration |
| Treating Event Hubs like Service Bus (expecting per-message dead-lettering, sessions) | Use Service Bus for those transactional guarantees; use Event Hubs for high-throughput replayable streaming |

## Summary

Event Hubs is Azure's answer to Kafka-style log streaming: partitions provide ordering and parallelism, consumer groups let multiple independent pipelines read the same stream at their own pace, and checkpoints in a shared store let `EventProcessorClient` scale consumers elastically with automatic partition rebalancing. The two decisions worth being explicit about in an interview are partition key selection (it determines both ordering and load distribution) and partition count (it is effectively permanent and caps future parallelism), because both are much harder to fix after the fact than to get right at design time. Everything else — throughput units, retention, Capture, Kafka compatibility — is tuning around that core log model.

## Top Interview Questions

### Q1. What's the fundamental difference between Event Hubs and Service Bus, and how does that drive the choice between them?

Event Hubs is a partitioned, append-only log — events are retained for a configured window regardless of whether they've been read, and any number of independent consumer groups can replay the same stream at their own pace from any offset. Service Bus is a broker — once a message is consumed (completed), it's gone, and it offers per-message features like sessions for ordering, peek-lock for reliable processing, and dead-lettering for poison messages. The choice comes down to what the workload needs: high-throughput ingestion with replay capability (telemetry, clickstream, IoT sensor data, event sourcing) points to Event Hubs, while transactional, per-message-guarantee workloads (order processing, financial transactions, anything needing dead-letter isolation of bad messages) point to Service Bus.

### Q2. How does ordering work in Event Hubs, and what would you do if a downstream consumer needs to see all events for a given customer in order?

Event Hubs guarantees ordering only within a single partition — there's no hub-wide ordering across partitions, and each partition maintains its own independent, monotonically increasing sequence number. To guarantee all events for a given customer arrive in order, I'd have producers set the customer ID as the **partition key** when sending; Event Hubs consistently hashes a given key to the same partition, so every event for that customer lands in the same partition and is therefore delivered to that partition's reader in send order. The trade-off to name explicitly: this only works well if customer IDs are numerous and evenly distributed — a small number of extremely high-volume customers could still create a hot partition even with this scheme.

### Q3. Explain what a consumer group is and why you'd use more than one.

A consumer group represents an independent, full view of the entire event stream — each consumer group tracks its own offsets/checkpoints per partition, completely isolated from every other consumer group, so multiple consumer groups can read the same events at whatever pace suits them without any contention or interference with each other. You'd use more than one when different downstream systems need to process the same stream for different purposes at different speeds — for example, a real-time dashboard consumer group processing events as they arrive, and a separate archival/analytics consumer group batching and writing to a data warehouse on its own schedule, potentially lagging behind by hours. Because they're fully isolated, a slow or stalled consumer in one group has zero impact on the throughput or latency experienced by another group reading the same hub.

### Q4. Why is checkpointing after every single event a bad practice, and what's the trade-off if you checkpoint less frequently?

Checkpointing writes the current offset to a durable store (typically a Blob Storage container), and doing that after every processed event means every single event incurs an additional network/storage write, which quickly becomes the throughput bottleneck at any meaningful event rate — you end up limited by checkpoint-store write latency rather than actual processing capacity. The standard practice is to checkpoint periodically — every N events, or on a time interval (e.g. every few seconds) — which dramatically reduces that overhead. The trade-off is that if the consumer crashes between checkpoints, it will reprocess the small batch of events sent since the last checkpoint upon restart, so consumer logic needs to be idempotent (safe to process the same event twice) regardless of how frequently you checkpoint — you're choosing how large that "redo" window is, not whether one exists at all.

### Q5. Your Event Hub has 4 partitions, and you've scaled your consumer application out to 8 instances in the same consumer group. What happens to the extra instances?

Only one active reader per partition is meaningful within a single consumer group, so with 4 partitions and 8 consumer instances, at most 4 instances can actually own and process a partition at any given time — the other 4 sit idle for that consumer group, contributing nothing to throughput despite consuming compute resources. `EventProcessorClient`'s lease-based ownership mechanism (coordinated via the shared checkpoint store) handles this automatically, distributing the 4 partitions across whichever instances are currently active and rebalancing if instances come and go, but it can't manufacture more parallelism than partitions exist. The actual fix, if genuine additional throughput is needed, is to increase the partition count — which, on Standard tier, effectively means creating a new Event Hub with more partitions and migrating, since partition count isn't freely adjustable after creation without disruption.

### Q6. What would you check if you noticed one partition in your Event Hub consistently running far hotter (more events, more lag) than the others?

I'd first look at what partition key producers are using and its cardinality and distribution — a hot partition is almost always caused by a partition key that isn't spread evenly, either because it has low cardinality (e.g. keying by a coarse "region" field with only a few distinct values) or because one specific key value (a single very active device or customer) genuinely produces disproportionately more events than others. I'd check the actual event volume per key value to confirm this rather than guessing, then consider either choosing a higher-cardinality, better-distributed key (customer ID or device ID instead of region), or, if a small number of entities are legitimately much higher-volume, deliberately handling those as a special case (a dedicated hub or explicit partition assignment) rather than trying to force even distribution through a key that fundamentally can't achieve it. I'd also confirm this isn't actually a downstream processing bottleneck rather than an ingestion skew — checking whether the lag is on the producer side (uneven writes) or consumer side (slow processing of an otherwise evenly-distributed partition).

### Q7. Why is choosing the number of partitions considered one of the most important upfront decisions in an Event Hubs design?

Partition count directly caps the maximum useful parallelism of any single consumer group — you can never usefully run more actively-processing consumer instances per group than there are partitions, so under-provisioning permanently limits how much you can scale out consumption later, regardless of how much compute you throw at it. Increasing partition count after creation isn't a simple in-place resize on Standard tier; it effectively requires provisioning a new Event Hub with the new count and migrating producers and consumers over, since a different partition count changes how partition keys hash to partitions, silently breaking any ordering guarantees your existing consumers relied on if done incorrectly. Because of this asymmetry — over-provisioning costs a bit more and adds minor management overhead, while under-provisioning is a hard ceiling that requires a disruptive migration to fix — the standard advice is to size partition count generously for expected growth over the next year or two, not just today's throughput.

### Q8. How does Event Hubs Capture differ from just having a consumer group write events to Blob Storage yourself?

Capture is a built-in, fully managed feature that automatically writes every event in the hub to Azure Storage or Data Lake in Avro format on a configurable time/size batching interval, requiring zero consumer code, zero infrastructure to run, and no separate consumer group management. Writing to Blob Storage yourself via a custom consumer means standing up and operating your own `EventProcessorClient`-based application, handling its checkpointing, scaling, and failure recovery, and writing the batching/serialization logic yourself. The trade-off is control and format flexibility — Capture only writes Avro on its own schedule, while a custom consumer can transform, filter, or reformat events however you like before persisting them — so Capture is the right choice for "just get me a durable archive with minimal effort," while a custom consumer is right when the archival format or logic needs to differ from Capture's defaults.

### Q9. What's the practical benefit of Event Hubs' Kafka-compatible endpoint, and what would you still validate before relying on it?

The Kafka-compatible endpoint lets existing Kafka producer and consumer applications, and Kafka-ecosystem tools like Kafka Connect or Kafka Streams, point at an Event Hub by changing only connection configuration (bootstrap servers, SASL credentials), without rewriting application code against a different client library — valuable for teams migrating an existing Kafka-based system to Azure, or running a hybrid environment where some components are Kafka-native and others are Azure-native, all sharing the same underlying stream. Before relying on it in production, I'd validate that any Kafka-specific administrative operations, custom broker configurations, or client-library version-specific behaviours the application depends on are actually supported through the compatibility layer — it's protocol-level compatibility, not a guarantee of complete feature parity with a self-hosted Kafka cluster, so edge-case administrative or configuration behaviour is worth testing explicitly rather than assumed.

### Q10. A stakeholder asks why you didn't just use Service Bus topics for a high-volume telemetry pipeline expecting 50,000 events/second. How do you explain the choice of Event Hubs?

At that volume, Event Hubs' partitioned log model is purpose-built for exactly this: throughput scales by adding partitions and throughput/processing units, multiple independent consumer groups (a real-time alerting pipeline, an archival pipeline, an analytics pipeline) can all read the same stream without contention, and events remain available for replay for hours or days, letting a new downstream consumer backfill history without needing producers to resend anything. Service Bus topics, in contrast, are architecturally optimized for reliable, per-message transactional delivery — features like peek-lock, sessions, and dead-lettering all carry per-message overhead that becomes the bottleneck at tens of thousands of events per second, and once a message is consumed it's gone, so there's no replay capability for a late-arriving consumer. I'd frame the answer around the actual requirement: this pipeline needs high-throughput ingestion with multiple independent readers and replay, which is precisely Event Hubs' design point, whereas Service Bus is the right tool when the requirement is closer to "process this specific business transaction exactly once, reliably."
