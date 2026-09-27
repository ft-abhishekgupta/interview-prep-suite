---
title: Design a Realtime Analytics Pipeline
description: Design an ad-click or event aggregation system covering stream windowing, watermarks, exactly-once upserts and lambda versus kappa architecture
difficulty: Core
tags: [streaming, aggregation, kafka, real-time]
---

A realtime analytics pipeline ingests a huge volume of discrete events — ad clicks, game events, metric samples — and produces aggregated counts and rollups that a dashboard or a billing system can query with low latency. The central tension is between processing speed and correctness: events arrive out of order, late, and sometimes duplicated, but the aggregate numbers still have to be trustworthy enough to bill an advertiser.

## Requirements

The shape of the problem — clicks in, aggregated metrics out — is simple to state and worth sketching before the correctness concerns pile on:

![alt text](notes/HLD/Problems/AdClickAggregator/image.png)

### Functional

- Ingest a high-volume stream of events (e.g., ad clicks) tagged with an entity ID (ad ID) and timestamp.
- Aggregate counts/sums over fixed time windows (per minute, per hour, per day).
- Serve near-real-time aggregate queries to a dashboard.
- Support backfill/reprocessing of historical data when logic changes.
- Handle late-arriving events correctly within a bounded lateness window.

### Non-functional

- End-to-end latency from event to visible aggregate: seconds, not minutes.
- Aggregation must be idempotent — replays or retries must not double-count.
- Must survive a burst of 10x normal traffic without losing events.
- Must tolerate uneven load across keys (a viral ad gets far more clicks than an average one) without one hot key stalling the whole pipeline.
- Cost must scale sub-linearly with volume where possible (via pre-aggregation).

### Out of scope

- Fraud/click-abuse detection logic itself (only idempotency-related prevention is covered).
- The dashboard's UI/visualization layer.
- Long-term data warehousing/BI beyond the serving layer.

> [!KEY]
> The single hardest problem here is not "how do we count fast" — it's **"how do we count correctly when events arrive late, out of order, and sometimes twice."** Every design choice (watermarks, idempotent upserts, lambda vs. kappa) exists to answer that question.

## Scale estimation

| Metric | Estimate | Arithmetic |
|---|---|---|
| Events/day | 10 billion | ad clicks or game events at large scale |
| Event QPS (avg / peak) | ~116,000/s avg, ~460,000/s peak | 10B ÷ 86,400 s; ×4 for peak traffic |
| Event size | ~200 bytes | ad_id, user_id, timestamp, metadata |
| Ingest bandwidth | ~23 MB/s avg, ~90 MB/s peak | QPS × event size |
| Distinct keys (e.g., ad IDs) | ~10 million | active campaigns at any time |
| Aggregation window | 1 minute (tumbling), rolled up to hourly/daily | balances latency vs. overhead |
| Late-arrival tolerance | up to 5 minutes | watermark lag budget |
| Storage (raw events, retained) | ~2 TB/day | 10B × 200 bytes |
| Storage (aggregates) | orders of magnitude smaller | 10M keys × 1440 minutes × small record ≈ tens of GB/day |

> [!TIP]
> Say the ratio out loud: *"Raw events are roughly 2 TB/day, but the aggregated output is orders of magnitude smaller — that gap is exactly why we pre-aggregate rather than making the dashboard scan raw events."*

## Core entities and data model

| Entity | Key fields |
|---|---|
| RawEvent | event_id, key (e.g., ad_id), event_time, ingest_time, payload |
| WindowedAggregate | key, window_start, window_end, count, sum, updated_at, version |
| RollupAggregate | key, granularity (hour/day), value, computed_at |
| Watermark | partition, current_watermark_time |
| ReprocessJob | id, key_range, time_range, status, triggered_by |

```mermaid
erDiagram
    RAWEVENT }o--|| WINDOWEDAGGREGATE : aggregates_into
    WINDOWEDAGGREGATE ||--o{ ROLLUPAGGREGATE : rolls_up_to
    RAWEVENT }o--|| WATERMARK : tracked_by
```

`WindowedAggregate` carries a `version`/`updated_at` explicitly because it is **mutated in place** as late events arrive within the lateness tolerance — it is not an append-only fact table the way `RawEvent` is.

## API design

```
POST  /v1/events                       Body: { key, eventTime, value }   -> 202 Accepted (fire-and-forget, high volume)
GET   /v1/aggregates?key={k}&window=1m&start=..&end=..  -> [{ windowStart, count, sum }]
GET   /v1/rollups?key={k}&granularity=hour&date=..      -> [{ hour, value }]
POST  /v1/reprocess                    Body: { keyRange, timeRange }     -> { jobId, status: "queued" }
```

Ingestion is intentionally fire-and-forget from the caller's perspective — acknowledging receipt into the stream, not waiting for aggregation to complete, since those two things happen on very different timescales.

## High level architecture

```mermaid
flowchart TD
    E["Event Sources<br/>(ad servers, game clients)"] --> ING["Ingestion Service"]
    ING --> K["Kafka<br/>partitioned by key"]
    K --> SP["Stream Processor<br/>(Flink/Spark Streaming)"]
    SP --> WIN["Windowed Aggregation<br/>+ watermarks"]
    WIN --> STORE[("Aggregate Store<br/>idempotent upsert")]
    STORE --> ROLLUP["Rollup Job"]
    ROLLUP --> STORE
    STORE --> SERVE["Serving Layer / Cache"]
    SERVE --> DASH["Dashboard"]
    K --> COLD[("Raw Event Archive")]
    COLD --> BATCH["Batch Reprocess Job"]
    BATCH --> STORE
```

Request flow:

1. Event sources emit events (a click, a game action) to the Ingestion Service, which validates and publishes them to Kafka, partitioned by key (e.g., `ad_id`) so all events for the same entity land on the same partition and are processed in order relative to each other. For the ad-click instantiation of this pipeline specifically, the click itself is best captured via a **server-side redirect**: the ad link points at the tracking service first, which logs the click event and only then issues the redirect to the advertiser's site, rather than firing an unreliable client-side beacon that can be blocked or dropped before it sends.

![alt text](notes/HLD/Problems/AdClickAggregator/image-1.png)

2. Kafka retains events durably and also feeds a cold archive for later reprocessing.
3. A stream processor (Flink or Spark Streaming) consumes each partition, groups events into time windows, and tracks a watermark per partition to know when a window can be considered "final enough" to emit.
4. When a window closes (or is updated by a late-but-still-tolerable event), the processor performs an idempotent upsert into the aggregate store rather than a blind increment.
5. A rollup job periodically combines fine-grained (per-minute) aggregates into coarser ones (hourly, daily) for cheap long-range queries.
6. The serving layer reads from the aggregate store (often through a cache for hot keys/recent windows) to answer dashboard queries with low latency.
7. If aggregation logic changes or a bug is found, a reprocess job replays the relevant raw events from the archive through the same (idempotent) aggregation logic to correct the stored aggregates without double-counting.

## Deep dive: windowing strategies and watermarks

Events don't arrive in a tidy, ordered stream — network delays, client buffering, and retries mean an event timestamped 14:00:03 might not arrive until 14:00:40, or even minutes later.

| Window type | Behavior | Use case |
|---|---|---|
| Tumbling | Fixed, non-overlapping windows (e.g., every 1 minute) | Simple per-minute click counts |
| Sliding | Overlapping windows (e.g., 5-minute window, advancing every 1 minute) | Smoothed trend lines, moving averages |
| Session | Window closes after a gap of inactivity for that key | Per-user session-based engagement metrics |

A **watermark** is the stream processor's estimate of "we don't expect to see events older than this timestamp anymore." It advances based on observed event times (e.g., watermark = max event time seen so far − allowed lateness), and a window is only emitted as "final" once the watermark passes its end time.

```mermaid
flowchart LR
    T1["Events arrive,<br/>mostly in order"] --> WM["Watermark tracks<br/>max(event_time) - lateness"]
    WM --> CLOSE["Window closes when<br/>watermark passes window_end"]
    CLOSE --> LATE["Late event after close?<br/>Update aggregate (within tolerance)<br/>or drop + count as late"]
```

> [!WARNING]
> Setting the allowed-lateness window too short means genuinely late (but valid) events get dropped and undercount the true total; setting it too long delays when a window's result can be considered final, hurting the "seconds not minutes" latency goal. This is a tunable trade-off, not a fixed answer — name it explicitly.

## Deep dive: exactly-once aggregation with idempotent upserts

Stream processing frameworks generally guarantee **at-least-once** delivery of events into your aggregation logic (a consumer can crash and reprocess a batch after restart). If the aggregation is a blind `count += 1`, a reprocessed batch double-counts. The fix is making the aggregate update **idempotent**.

```sql
-- Idempotent upsert keyed by (key, window_start) with a per-event dedup token
INSERT INTO windowed_aggregate (key, window_start, count, sum, last_event_id)
VALUES (@key, @windowStart, @deltaCount, @deltaSum, @eventId)
ON CONFLICT (key, window_start) DO UPDATE SET
    count = windowed_aggregate.count + EXCLUDED.count,
    sum = windowed_aggregate.sum + EXCLUDED.sum
WHERE NOT (@eventId <= windowed_aggregate.last_event_id); -- skip if already applied
```

- Many stream engines (Flink with checkpointing, Kafka Streams with exactly-once semantics) instead achieve this via **transactional writes tied to checkpoint offsets**: the framework only commits the consumer offset *and* the aggregate update together, atomically, so a crash-and-restart replays exactly the events that weren't yet durably reflected in the aggregate — no more, no less.
- The practical takeaway: "exactly-once" in stream processing almost always means **at-least-once delivery + idempotent application**, the same pattern as the job scheduler and moderation pipeline designs — not a magical network-level guarantee.

This idempotency guards against the pipeline's own retries, but a related and easily confused problem is guarding against the *user* clicking (or a bot re-clicking) the same ad more than once. Tagging each click event with the user's ID and deduplicating on `(user_id, ad_id)` is tempting but wrong on two counts: it requires the user to be logged in, and it's entirely legitimate for the same user to see and click the same ad twice in separate sessions — that's not abuse, it's just two real clicks. The fix is a **unique impression ID**: generated once per ad impression actually shown in the browser, signed, and sent back alongside the click event. The click processor verifies the signature and checks the impression ID against a dedup cache — if it's been seen before, the click is dropped as a replay; if not, it's accepted and the ID is recorded. This correctly distinguishes "the same impression's click event was resent" (duplicate, drop it) from "the user genuinely clicked twice" (two different impression IDs, both count).

## Deep dive: lambda vs. kappa architecture

Before reaching for a streaming architecture at all, it's worth being explicit about why a pure batch pipeline isn't sufficient on its own. A straightforward batch-first design writes every click into a write-optimized store (e.g. Cassandra, whose LSM-tree design is built for high-throughput appends), then runs a periodic batch job (Spark, doing a map-reduce-style pass) that aggregates the data into a read-optimized OLAP store (Redshift, BigQuery) for dashboard queries:

![alt text](notes/HLD/Problems/AdClickAggregator/image-2.png)

This works, but it is fundamentally not real-time — results are only as fresh as the last batch run, running the batch job more frequently trades freshness for overhead, and a sudden burst of clicks can create a cascading backlog across runs. Replacing the batch job with a stream processor (Flink or Spark Streaming) reading directly off Kafka/Kinesis is what actually gets end-to-end latency down to seconds, since the stream engine aggregates continuously over small windows and flushes as each window closes rather than waiting for a scheduled run:

![alt text](notes/HLD/Problems/AdClickAggregator/image-3.png)

| Architecture | Structure | Strength | Weakness |
|---|---|---|---|
| Lambda | Separate speed layer (stream, fast/approximate) and batch layer (reprocesses raw data for full correctness), merged at serving time | Batch layer is a trusted, simple-to-reason-about source of truth for correction | Two codebases (stream + batch) doing similar logic; more to maintain and keep consistent |
| Kappa | Single stream-processing codebase; "batch" reprocessing is just replaying the same stream from an earlier offset through the same logic | One codebase, one mental model; reprocessing = replay | Requires the stream platform to retain (or archive-and-replay) enough history, and stream engines must be robust enough to serve as the sole source of truth |

> [!TIP]
> The senior answer names when each wins: *"Kappa is simpler and increasingly the default now that Kafka retention and stream engines are mature enough to be trusted as the single source of truth. Lambda still earns its complexity when the batch correctness guarantees (e.g., a nightly reconciliation against a data warehouse) need to be genuinely independent of the streaming code, as a check against streaming-layer bugs."*

This pipeline can be built either way: a kappa approach replays raw events from the Kafka/cold archive through the same stream-processing job for both real-time and reprocessing; a lambda approach runs a separate nightly Spark batch job against the raw archive as an independent correctness check against the streaming aggregates, flagging discrepancies for reconciliation. This periodic-reconciliation pattern — a fast streaming layer for immediate results, a slower and more careful layer that periodically re-derives the truth from raw data and corrects any drift — is exactly what the lambda architecture formalizes:

![alt text](notes/HLD/Problems/AdClickAggregator/image-6.png)

## Deep dive: hot-key skew and pre-aggregation

A viral ad or a popular game event can receive orders of magnitude more events than a typical key, and since events are partitioned by key for ordering, all of that traffic lands on one Kafka partition and one downstream aggregation task — a hot-key bottleneck.

- **Mitigation — key salting**: append a random suffix (e.g., `ad_id#3` out of N shards) to spread a hot key's events across multiple partitions, then combine the partial aggregates for that key back together in a second, lightweight aggregation step.
- **Pre-aggregation at the source**: where possible, combine counts client-side or at the ingestion edge over a very short local window (e.g., 100 ms) before publishing, cutting the number of individual messages the stream has to handle for a hot key by orders of magnitude.
- **Serving-layer rollups**: precompute hourly/daily rollups from the minute-level aggregates so dashboard queries over long ranges don't have to scan and sum thousands of fine-grained rows at read time.

```mermaid
flowchart LR
    HOT["Hot key: ad_id=42"] --> S1["Shard 1: ad_id=42#0"]
    HOT --> S2["Shard 2: ad_id=42#1"]
    HOT --> S3["Shard 3: ad_id=42#2"]
    S1 --> COMBINE["Combine step<br/>sum partial aggregates"]
    S2 --> COMBINE
    S3 --> COMBINE
    COMBINE --> FINAL[("Final aggregate<br/>for ad_id=42")]
```

Put together — ingestion, partitioned stream, windowed stream processing, idempotent aggregate store, rollups, and the reconciliation path — the full pipeline looks like this:

![alt text](notes/HLD/Problems/AdClickAggregator/image-7.png)

## Bottlenecks and scaling

- **Hot-key skew** — solved via salting plus a combine step, as above; don't try to solve it by just adding more partitions overall, since a single key is still bound to a bounded number of them.
- **Watermark stragglers** — one slow-arriving partition can hold back windows across the board if downstream logic waits for global watermark alignment; keep per-partition watermarks independent where the query pattern allows it.
- **Serving layer read load** — dashboards querying long historical ranges should read from rollups, not raw minute-level aggregates; cache very recent/hot-key aggregates aggressively since they're queried disproportionately often.
- **Reprocessing cost** — a full backfill over billions of archived events is expensive; scope reprocess jobs to the specific key range and time range affected by the bug/change, not the entire dataset, whenever possible.

Scaling the whole pipeline to a higher target throughput (say, 10,000+ events/sec sustained) is mostly a matter of scaling each stage independently rather than any single silver bullet: the ingestion tier scales horizontally since it's stateless, the stream (Kinesis/Kafka) is sharded by key with each shard handling its own bounded throughput, the stream processor runs one parallel task per shard, and the OLAP serving store scales largely on its own but benefits from being partitioned by a dimension like advertiser ID to keep any one partition's query load bounded:

![alt text](notes/HLD/Problems/AdClickAggregator/image-4.png)

## Failure scenarios

| Failure | Blast radius | Mitigation |
|---|---|---|
| Stream processor node crash | In-flight window computation lost for its partitions | Checkpointing restores state; reprocesses only unacknowledged offsets, idempotent upsert prevents double count |
| Kafka broker/partition outage | Ingestion for affected partitions delayed | Replication across brokers; producer retries until partition recovers |
| Hot key overwhelms a single partition | Aggregation lag for that key only | Key salting spreads load; combine step reunifies the result |
| Aggregate store write failure | Window's result not durably recorded | Retried with backoff; checkpoint/offset commit withheld until write succeeds |
| Backfill job run with wrong logic | Aggregates corrupted for the reprocessed range | Reprocess jobs write to a staging aggregate table, validated, then swapped in — never overwrite live aggregates directly |

Kafka and Kinesis are themselves already built for exactly this kind of durability — Kafka replicates each partition across multiple brokers in the cluster, Kinesis replicates across availability zones — so the event log itself rarely loses data outright. The remaining lever under the pipeline's own control is retention: keeping raw events available in the stream (and archived to cold storage) for long enough that a stream-processor outage or a bug can be recovered from by simply replaying, rather than the data being gone the moment it scrolls off a short retention window:

![alt text](notes/HLD/Problems/AdClickAggregator/image-5.png)

## Cheat sheet

- Partition the event stream by key so per-key ordering is preserved without needing a global ordering guarantee.
- Watermark = "we don't expect anything older than this anymore" — it's what makes a window's result final, and it's always a tunable trade-off against latency.
- "Exactly-once" aggregation is really at-least-once delivery + idempotent upsert, keyed by `(key, window)` and a dedup token.
- Kappa (one stream codebase, reprocess = replay) is the modern default; lambda earns its complexity as an independent correctness check.
- Pre-aggregate and roll up — dashboards should read small, cheap rollups, never scan raw events.
- Hot keys need salting plus a combine step, not just more partitions.
- Scope reprocessing/backfill jobs narrowly (key range + time range) to control cost.

## Common mistakes

| Mistake | Fix |
|---|---|
| Treating "exactly-once" as a magic guarantee from the framework | It's at-least-once delivery + idempotent application — say so explicitly |
| Using a blind `count += 1` for aggregation | Use an idempotent upsert keyed by window + dedup token |
| Ignoring late-arriving events entirely | Use a bounded lateness window and watermarks, tuned as a latency/correctness trade-off |
| Serving dashboard queries directly off raw events | Pre-aggregate and roll up; serve from small, precomputed tables |
| Adding more partitions to fix one hot key | Salt the hot key specifically and combine after |
| Overwriting live aggregates during a backfill | Write to staging, validate, then swap |

## Summary

A realtime analytics pipeline is won by treating correctness under disorder as the primary design constraint, not an edge case: partition by key for per-key ordering, use watermarks to decide when a window is "final enough" while explicitly trading off latency against completeness, and make every aggregate update an idempotent upsert so at-least-once delivery never turns into double-counting. Kappa architecture keeps reprocessing and real-time processing on one code path; pre-aggregation and rollups keep the serving layer fast and cheap; and salting plus a combine step tame the hot keys that would otherwise stall a single partition.

## Top Interview Questions

### Q1. What is a watermark in stream processing, and why is it necessary?

A watermark is the stream processor's running estimate of "we don't expect to see any more events with an event-time older than this," typically computed as the maximum observed event timestamp minus an allowed lateness buffer. It's necessary because a windowed aggregation (e.g., "count of clicks in the 14:00–14:01 window") needs some rule for deciding when that window's result can be considered final and emitted downstream — without a watermark, the processor would either need to wait forever for possibly-late events, or arbitrarily emit results that could later be wrong. The watermark formalizes the trade-off: a longer allowed-lateness buffer produces more complete/accurate results but delays finality; a shorter one finalizes faster but risks dropping genuinely late events from the count.

### Q2. How would you handle an event that arrives after its window has already closed and been emitted?

This depends on the allowed-lateness policy configured for the pipeline. If the event falls within the configured lateness tolerance (e.g., up to 5 minutes late), most stream processing frameworks support updating the already-emitted aggregate — re-triggering the window's computation and issuing a corrected result downstream, which the aggregate store applies as an idempotent upsert against the same `(key, window)` row. If the event arrives after even the lateness tolerance has passed, it's typically dropped from the real-time aggregate but still retained in the raw event archive, where it can be captured correctly by a periodic reconciliation/batch correction job (the lambda-architecture pattern) or an explicit reprocess job if the discrepancy matters enough to fix.

### Q3. Why is "exactly-once" aggregation described as at-least-once delivery plus idempotent updates, rather than a true network-level guarantee?

True exactly-once delivery across a network is not achievable in general, because a producer can never be fully certain whether an acknowledgment was lost after the receiver actually processed a message, versus the message never arriving at all — from the producer's perspective these look identical, so the only safe choice on any doubt is to retry, which reintroduces the possibility of duplicate delivery. The practical solution stream processing frameworks use is to guarantee at-least-once delivery (nothing is silently lost, but duplicates can occur on retry) and pair it with idempotent application of each event — using a dedup key or transactional checkpoint-plus-state-update — so that processing the same event twice produces the same final aggregate as processing it once. The end-to-end *effect* looks like exactly-once even though the delivery mechanism underneath is at-least-once.

### Q4. What is the difference between lambda and kappa architecture, and which would you choose for this pipeline?

Lambda architecture runs two parallel systems — a fast, possibly-approximate streaming ("speed") layer for real-time results, and a slower, more rigorous batch layer that periodically reprocesses the full raw dataset for a corrected, authoritative result, with the two merged at serving time. Kappa architecture uses a single stream-processing codebase for both real-time processing and reprocessing, treating "batch" reprocessing as simply replaying historical events from the retained log through the same logic. For a well-understood aggregation workload like ad-click counting, kappa is usually preferable today because it avoids maintaining two codebases that need to produce consistent results, and modern stream engines (Flink, Kafka Streams) are mature enough to be trusted as the sole source of truth; lambda still earns its keep when you specifically want an independent batch-computed check against potential streaming-layer bugs, e.g., for billing-critical numbers where a nightly reconciliation against a completely separate code path is a valuable safety net.

### Q5. A single ad campaign goes viral and its click events are overwhelming one Kafka partition while others are idle. How do you fix this without breaking per-key ordering guarantees elsewhere?

Apply key salting specifically to that hot key: instead of partitioning purely by `ad_id`, append a bounded random or round-robin suffix (e.g., `ad_id#0` through `ad_id#7`) so that one campaign's events spread across several partitions rather than funneling into one. This does relax strict ordering *within* that specific key's events across its shards, but for a count/sum aggregation that's commutative and associative, ordering doesn't affect correctness — you then run a lightweight second aggregation step that combines the partial per-shard aggregates for that key back into one final number. Other, non-hot keys are unaffected since they aren't salted and retain single-partition ordering; this targeted approach is preferable to blanket-increasing partition count across the board, which wouldn't help a single skewed key concentrated on one partition anyway.

### Q6. How would you design a reprocessing/backfill job to fix aggregates after discovering a bug in the aggregation logic, without risking further data corruption?

Scope the reprocess job as narrowly as possible — the specific key range and time range actually affected by the bug — rather than replaying the entire historical dataset, both to control cost and to limit risk. The job reads the relevant raw events from the durable archive and replays them through the corrected aggregation logic, but writes its output to a staging aggregate table rather than the live one; only after validating the staged results (spot-checking against expected totals, comparing against the old buggy values to confirm the expected delta) does an atomic swap promote the corrected data to replace the live aggregates for that range. This avoids a partially-completed or buggy reprocess job corrupting live, currently-served data mid-run, which would be far worse than the original bug.

### Q7. Why should the serving layer read from precomputed rollups instead of summing raw minute-level aggregates (or worse, raw events) at query time?

At the estimated scale (10 billion events/day, 10 million distinct keys), a dashboard query asking for a month of daily totals for one campaign would otherwise need to sum up to 43,200 minute-level rows (30 days × 1,440 minutes) or, far worse, scan potentially millions of raw events for that key — both are wasteful, slow operations to repeat on every single dashboard page load, especially when many users query overlapping time ranges. Precomputing hourly and daily rollups from the minute-level aggregates as a background job means a dashboard query becomes a handful of cheap row lookups instead of an expensive aggregation, and the rollup computation cost is paid once per rollup period rather than once per query. This is the same "precompute once, serve cheaply many times" principle that shows up in autocomplete's cached top-K and video's pre-transcoded renditions.

### Q8. How would you monitor and alert on the health of this pipeline in production?

Key signals include consumer lag per Kafka partition (a growing lag on a specific partition points to a hot key or a stalled processing task), watermark lag (the gap between wall-clock time and the current watermark, which directly measures how "real-time" the pipeline actually is at any moment), the rate of late-arriving events being dropped versus successfully applied to already-closed windows, and end-to-end latency from event ingestion to aggregate visibility in the serving layer. You'd also monitor the discrepancy between streaming aggregates and any independent batch/reconciliation computation (if using a lambda-style safety net) as a correctness signal, since a growing discrepancy over time suggests a bug in the streaming logic that isn't yet causing outright failures but is silently producing wrong numbers.

### Q9. Why partition events by key (e.g., ad_id) rather than randomly or round-robin across partitions?

Partitioning by key guarantees that all events for the same entity are processed by the same downstream consumer task in the order they were published to that partition, which is essential for correct stateful aggregation — if a single ad's events were scattered randomly across partitions, no single aggregation task would ever see the complete picture for that ad without an expensive cross-partition shuffle/merge step for every window. Keying by the aggregation dimension means each partition's consumer can maintain local per-key state (the running count for that window) independently and correctly, which is both simpler and dramatically more efficient than reassembling scattered partial state from multiple consumers on every window close. The trade-off, as covered by the hot-key question, is that this same property is what causes one very active key to concentrate load on a single partition.

### Q10. How do watermarks interact with sliding versus tumbling windows differently?

For tumbling windows, the watermark simply needs to pass a single window's end boundary once for that window to be considered final — each window is independent and closes exactly once. For sliding windows, since windows overlap (e.g., a 5-minute window advancing every minute means any given event can belong to up to five overlapping windows), the watermark passing a point in time can finalize multiple overlapping windows simultaneously, and the stream processor needs to track and emit results for all of them, which increases both state size (each event may need to be added to multiple in-flight window accumulators) and the volume of emitted results per watermark advance. This is a factor in choosing window type: sliding windows give smoother trend visibility but at meaningfully higher state and computation cost than tumbling windows for the same underlying data.

### Q11. What would change about this design if the requirement shifted from "aggregate counts for a dashboard" to "aggregate counts that directly drive advertiser billing"?

Billing-critical numbers raise the bar on correctness substantially beyond "good enough for a dashboard trend line" — you'd want a lambda-style independent batch reconciliation layer even if the primary path is kappa-style streaming, specifically so there's a separate, simpler, more auditable code path that recomputes the authoritative numbers from raw archived events (e.g., nightly) and flags any discrepancy against the streaming numbers before invoices go out. You'd also tighten the idempotency and dedup story around the raw event ingestion itself (e.g., a signed, unique impression ID per ad shown, checked against a dedup cache) to prevent click-fraud or accidental duplicate submission from directly translating into inflated bills, and you'd likely widen the allowed-lateness window or add an explicit "finalization" delay before a day's numbers are considered billable, trading a bit more latency for materially higher confidence in correctness.

### Q12. How do you decide the right tumbling window size (1 minute vs. 5 minutes vs. 1 hour) for this pipeline?

The window size is a trade-off between granularity/latency and overhead: smaller windows (1 minute) give more granular, near-real-time visibility and let dashboards show fresher trend data, but create more distinct aggregate records and more frequent finalization events, increasing storage and processing overhead proportionally. Larger windows (1 hour) reduce that overhead and are fine for use cases that don't need minute-level granularity, but delay when any given time period's number becomes visible at all, and dilute the ability to detect a short-lived spike. A common approach is to compute at the finest granularity actually needed by any consumer (often 1 minute) and then roll those up into coarser aggregates for other consumers, rather than trying to pick one single window size that serves every use case directly.

### Q13. How do you stop a single user's repeated clicks on the same ad from inflating the count, without incorrectly blocking legitimate repeat views?

The naive fix — tag each click with the user's ID and dedupe on `(user_id, ad_id)` — is wrong on two fronts: it forces the user to be identified/logged in, which isn't always true, and it would incorrectly collapse two entirely legitimate clicks from the same user seeing the same ad on two different occasions into one. The correct mechanism operates one level up, at the impression rather than the user: every time an ad is actually rendered in a browser, the system generates a unique, signed impression ID for that specific showing, which is echoed back if the user clicks. The click processor verifies the signature and checks that exact impression ID against a dedup cache — a second click event carrying the same impression ID is a retried or replayed event and gets dropped, while a click carrying a fresh impression ID is a genuinely new click and counts, even if it's the same user clicking the same ad for the second time that day.
