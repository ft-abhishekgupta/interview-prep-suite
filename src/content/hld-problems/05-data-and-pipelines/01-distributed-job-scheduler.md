---
title: Design a Distributed Job Scheduler
description: Design a cron-like system covering leader election, hierarchical time wheels, at-least-once execution, retries and multi-tenant fairness
difficulty: Core
tags: [scheduling, distributed-systems, reliability, queues]
---

A distributed job scheduler runs work — cron-style recurring jobs or one-off delayed tasks — reliably across a fleet of workers, without a single machine's cron table as a bottleneck or a single point of failure. The core tension is between running every job exactly once conceptually and the reality that distributed systems can only promise **at-least-once** delivery cheaply.

## Requirements

### Functional

- Users define jobs with a schedule (cron expression, fixed interval, or one-off delay) and a payload/handler.
- The scheduler triggers each job at the right time and dispatches it to a worker for execution.
- Failed jobs are retried with backoff, up to a configurable limit.
- Long-running jobs report progress via heartbeats; a stalled job is detected and retried.
- Multiple tenants (teams/services) share the scheduler with fair capacity allocation.
- Job status and history are queryable (succeeded, failed, running, pending).

### Non-functional

- No duplicate scheduling of the same job occurrence, even with multiple scheduler instances running.
- At-least-once execution guarantee, with the expectation that job handlers are idempotent.
- Scales to millions of scheduled jobs and tens of thousands of triggers per second at peak.
- Scheduling precision within a few seconds of the target time is acceptable; sub-second precision is not a goal.
- Scheduler control plane must survive individual node failure without missing triggers.

### Out of scope

- The business logic inside individual jobs.
- A general-purpose workflow/DAG engine (multi-step orchestration) — this is single-job scheduling.
- UI/dashboard for authoring jobs.

> [!KEY]
> "Exactly-once" execution is not achievable for free in a distributed system — you get **at-least-once delivery** cheaply (retry until acknowledged) and simulate "exactly-once effect" by requiring job handlers to be **idempotent**. Naming this trade-off explicitly is the single most important thing to say in this design.

## Scale estimation

| Metric | Estimate | Arithmetic |
|---|---|---|
| Scheduled job definitions | 10 million | given, large multi-tenant platform |
| Average trigger frequency | once every 10 minutes | typical mix of cron jobs |
| Triggers/day | ~1.44 billion | 10M jobs × 144 triggers/day (every 10 min) |
| Trigger QPS (avg / peak) | ~16,700/s avg, ~50,000/s peak | 1.44B ÷ 86,400 s; ×3 for bursty top-of-hour/minute clustering |
| Worker fleet | tens of thousands of workers | sized to job execution duration × concurrency needed |
| Read:write ratio (schedule store) | write-heavy relative to typical CRUD, but reads dominate at trigger-check time | every tick reads "what's due now" far more often than jobs are created/edited |
| Retry overhead | +10–20% extra triggers | assume ~10-20% of jobs fail at least once and retry |
| Job metadata storage | ~5–10 GB | 10M job defs × ~500 bytes–1 KB |

> [!TIP]
> Note the "top of the hour" clustering problem out loud: *"A huge fraction of cron jobs are scheduled for `0 * * * *` or midnight — naive systems see a spike at every hour boundary, so the scheduling data structure has to handle bursty, non-uniform trigger times, not a smooth average."*

## Core entities and data model

| Entity | Key fields |
|---|---|
| JobDefinition | id, tenant_id, schedule (cron/interval), handler_ref, payload, priority, enabled |
| JobRun | id, job_id, scheduled_time, status (pending/running/succeeded/failed/retrying), attempt_count, worker_id, heartbeat_at |
| Lease | job_id, owner_scheduler_id, expires_at | used for leader-election-scoped ownership |
| RetryPolicy | job_id, max_attempts, backoff_base, backoff_strategy |
| TenantQuota | tenant_id, max_concurrent_jobs, priority_weight |

```mermaid
erDiagram
    JOBDEFINITION ||--o{ JOBRUN : produces
    JOBDEFINITION ||--|| RETRYPOLICY : governed_by
    JOBDEFINITION }o--|| TENANTQUOTA : counted_against
    JOBRUN ||--|| LEASE : claims
```

`JobRun` is the operational record — one row per actual trigger occurrence — kept separate from `JobDefinition` (the template) so retries, history, and heartbeats don't mutate the schedule itself.

## API design

```
POST   /v1/jobs                  Body: { schedule, handlerRef, payload, retryPolicy }  -> { jobId }
PATCH  /v1/jobs/{id}              Body: { enabled: false }                              -> { jobId, enabled }
GET    /v1/jobs/{id}/runs         -> [{ runId, status, scheduledTime, attempt }]
POST   /v1/jobs/{id}/runs/{runId}/heartbeat   -> 202 Accepted   (worker -> scheduler)
POST   /v1/jobs/{id}/runs/{runId}/complete    Body: { status: succeeded|failed }        -> 200 OK
```

Job authors interact only with `JobDefinition`; workers interact only with `JobRun` heartbeat/complete endpoints — the two APIs are deliberately separate audiences.

## High level architecture

```mermaid
flowchart TD
    API["Scheduler API"] --> DEF[("Job Definition Store")]
    DEF --> SCH["Scheduler Nodes<br/>(leader-elected shards)"]
    SCH --> WHEEL["Time-Bucketed Queue /<br/>Hierarchical Time Wheel"]
    WHEEL --> DISP["Dispatcher"]
    DISP --> Q["Work Queue<br/>(per priority/tenant)"]
    Q --> WORKER["Worker Pool"]
    WORKER --> RUN[("Job Run Store")]
    WORKER --> HB["Heartbeat Monitor"]
    HB --> RUN
    HB -->|"stalled job"| DISP
    RUN --> RETRY["Retry Manager"]
    RETRY --> Q
```

Request flow:

1. A job author registers a `JobDefinition` via the API; it's persisted and its next trigger time is computed from the cron expression.
2. Scheduler nodes — each responsible for a shard of jobs via leader election/ownership leases — load upcoming jobs into a time-bucketed structure (a hierarchical time wheel) that efficiently answers "what's due in the next tick?"
3. On each tick, due jobs are handed to the Dispatcher, which creates a `JobRun` and enqueues it onto a work queue partitioned by priority and tenant.
4. A worker pulls a run, executes the job handler, and periodically sends heartbeats so the system knows it's still alive.
5. On success, the worker marks the run `succeeded`; the scheduler computes and enqueues the job's next occurrence.
6. On failure (or a missed heartbeat deadline), the Retry Manager applies backoff and re-enqueues the run as a new attempt, up to the configured max attempts.
7. Job history (`JobRun` records) is queryable independently for observability and debugging.

## Deep dive: scheduling at scale with a hierarchical time wheel

Checking "is anything due?" by scanning all 10 million job definitions every tick is O(n) per tick and doesn't scale. A time wheel turns this into O(1) amortized per tick.

```mermaid
flowchart LR
    S["Seconds wheel<br/>(60 slots)"] --> M["Minutes wheel<br/>(60 slots)"]
    M --> H["Hours wheel<br/>(24 slots)"]
    H --> D["Days wheel"]
```

- A job due in 3 seconds is placed directly into the seconds wheel's slot 3 slots ahead.
- A job due in 40 minutes is placed into the minutes wheel; as the minutes wheel advances and reaches that slot, the job cascades down into the seconds wheel for fine-grained triggering.
- A job due in 5 days sits in the days wheel until it cascades down through hours, minutes, then seconds as its time approaches.

This gives insertion and per-tick advancement roughly O(1), regardless of how many total jobs exist, because each tick only touches the (small, bounded) contents of the current slot rather than the whole job set. Compare to a **naive time-bucketed queue** (one queue per minute, say) — simpler to implement, works fine at moderate scale, but a job scheduled far in the future either needs a bucket per far-future minute (huge sparse map) or a periodic re-bucketing pass; the time wheel's cascading hierarchy solves that cleanly.

> [!TIP]
> Name the trade-off: *"A flat time-bucketed queue is simpler and fine up to moderate scale; a hierarchical time wheel adds complexity but keeps insert and tick cost O(1) regardless of how far in the future jobs are scheduled, which matters once you have millions of jobs with schedules ranging from seconds to weeks out."*

## Deep dive: leader election to avoid duplicate scheduling

If two scheduler instances both believe they own a job, both will trigger it at the same time — a correctness bug, not just an efficiency one.

```mermaid
sequenceDiagram
    participant S1 as "Scheduler A"
    participant S2 as "Scheduler B"
    participant Z as "Coordination Service<br/>(etcd/ZooKeeper)"
    S1->>Z: acquire lease on shard 7 (ttl=10s)
    Z-->>S1: granted
    S2->>Z: acquire lease on shard 7
    Z-->>S2: denied, held by S1
    Note over S1,Z: S1 renews lease periodically
    Note over S1,S2: If S1 crashes, lease expires, S2 acquires it and takes over shard 7
```

- Job definitions are partitioned into shards; each shard has exactly one owning scheduler instance at a time, established via a lease in a coordination service (etcd, ZooKeeper, or a Redis-based lock with TTL).
- The lease has a short TTL and must be renewed periodically; if the owning instance crashes or is partitioned away, the lease expires and another instance takes over that shard.
- **Bad**: no coordination at all — every instance schedules every job, causing massive duplicate triggering.
- **Good**: a single global leader schedules everything — simple, but doesn't scale past one node's throughput and is a single point of failure.
- **Great**: sharded ownership via leases — scales horizontally, and failure only affects the shards owned by the crashed instance, which fail over quickly.

## Deep dive: at-least-once execution and idempotent jobs

Because a scheduler can crash after dispatching but before recording success, or a worker can crash mid-execution, the system cannot promise a job runs exactly once — it can only promise it runs **at least once**, and possibly retries.

| Guarantee | What it means | How achieved | Cost |
|---|---|---|---|
| At-most-once | Job might not run at all after a failure | Fire-and-forget, no retry | Cheap, but silently drops work — rarely acceptable |
| At-least-once | Job is guaranteed to eventually run, but might run more than once | Retry on any uncertainty (timeout, missed heartbeat, crash) | Requires idempotent handlers |
| Exactly-once (effect) | Job's *effect* happens once even if it *runs* more than once | At-least-once delivery + idempotency key checked by the handler | The practical way to get "exactly-once" semantics |

A job handler achieves idempotency by using a deterministic idempotency key (e.g., `jobId + scheduledTime`) to detect and skip a duplicate execution — for example, a payment job checks "has a charge with this key already succeeded?" before charging again. This makes retries safe rather than trying to eliminate duplicates at the scheduling layer, which is far harder and often impossible to fully guarantee.

> [!DANGER]
> Trying to achieve true exactly-once scheduling by adding more distributed locks and coordination is a trap — it adds latency and new failure modes without actually removing the fundamental problem (a crash between "job ran" and "success recorded" is always possible). Idempotent handlers are the only durable fix.

## Deep dive: worker dispatch, retries/backoff, and multi-tenant fairness

- **Worker pool**: workers pull from priority/tenant-partitioned queues rather than a single global queue, so one noisy tenant can't starve others; a weighted fair-queuing scheme allocates queue capacity proportional to each tenant's configured share.
- **Retries and backoff**: on failure, the Retry Manager schedules the next attempt with exponential backoff plus jitter up to a max attempt count, then routes to a dead-letter state for manual inspection rather than retrying forever.
- **Long-running jobs and heartbeats**: a worker executing a long job periodically calls the heartbeat endpoint; if the Heartbeat Monitor doesn't see one within the expected interval (e.g., 2x the heartbeat period), it presumes the worker died and reschedules the run — this is why handlers must be idempotent, since the original worker might actually still be alive and finish anyway (a duplicate execution).
- **Priority and fairness**: high-priority tenants get a larger share of worker capacity via weighted queues, but even low-priority tenants get a guaranteed minimum to avoid starvation.

```java
// Exponential backoff with jitter: avoids retry storms all firing in lockstep
Duration nextRetryDelay(int attempt, Duration baseDelay, Duration max) {
    double exp = baseDelay.toMillis() * Math.pow(2, attempt); // 1,2,4,8...
    double capped = Math.min(exp, max.toMillis());
    double jitter = ThreadLocalRandom.current().nextDouble() * capped * 0.5; // +/- up to 50%
    return Duration.ofMillis((long) (capped * 0.5 + jitter));
}
```

## Bottlenecks and scaling

- **Top-of-hour/midnight clustering** — many cron jobs share common trigger times (`0 * * * *`), creating trigger spikes; mitigate by adding small random jitter to trigger times where the job's semantics allow it, and by autoscaling the worker pool ahead of known-busy boundaries.
- **Shard rebalancing during scale-out** — adding scheduler instances means re-partitioning job ownership; do this gradually (move a few shards at a time) to avoid a burst of lease churn.
- **Hot tenant** — one tenant scheduling far more jobs than others; per-tenant quotas and weighted fair queuing prevent this from degrading service for everyone else.
- **Heartbeat monitor false positives** under network partition — a worker that's alive but can't reach the monitor looks dead and gets duplicated; tune heartbeat timeout conservatively and rely on idempotency to absorb the rare duplicate.

## Failure scenarios

| Failure | Blast radius | Mitigation |
|---|---|---|
| Scheduler node holding shard leases crashes | Jobs on that shard briefly stop triggering | Lease TTL expires quickly; another node acquires ownership and resumes |
| Worker crashes mid-job | Job appears stalled | Heartbeat timeout triggers reschedule; idempotent handler makes re-execution safe |
| Coordination service (etcd/ZK) outage | New leader election blocked, but existing leases still valid until expiry | Existing owners keep operating during the outage window; alert immediately |
| Work queue backlog during a trigger spike | Job execution delayed, not lost | Autoscale worker pool on queue depth; jobs remain durably queued |
| Retry storm from a systemically broken handler | Repeated failures consume worker capacity | Max attempt cap routes to dead-letter after N tries instead of retrying forever |

## Cheat sheet

- At-least-once delivery + idempotent handlers is how you get "exactly-once effect" — say this explicitly.
- Hierarchical time wheel gives O(1) amortized scheduling regardless of how far in the future a job is due.
- Shard job ownership across scheduler instances using leases with TTL — this is what prevents duplicate triggering.
- Separate `JobDefinition` (template) from `JobRun` (one row per occurrence/attempt).
- Heartbeats detect stalled long-running jobs; timeout conservatively to avoid false-positive duplicate execution.
- Exponential backoff with jitter for retries; cap attempts and dead-letter after that.
- Multi-tenant fairness = per-tenant queues with weighted capacity, not one shared queue.
- Add jitter to popular trigger times (top of hour) to smooth out trigger spikes.

## Common mistakes

| Mistake | Fix |
|---|---|
| Claiming the system provides "exactly-once execution" | Say "at-least-once delivery, exactly-once effect via idempotent handlers" |
| Scanning all job definitions every tick to find due jobs | Use a time-bucketed queue or hierarchical time wheel |
| A single global scheduler instance | Shard ownership across instances via leader election/leases |
| One shared work queue for all tenants | Partition by tenant/priority with weighted fair queuing |
| Retrying forever on failure | Cap attempts with exponential backoff, then dead-letter |
| Treating a missed heartbeat as certain death | It's a signal, not a certainty — handlers must tolerate the resulting duplicate |

## Summary

A distributed job scheduler's core engineering problems are all about coordination without a single point of truth: use sharded leases so exactly one instance owns each job's triggering, use a hierarchical time wheel so checking "what's due" doesn't scale linearly with job count, and accept up front that only at-least-once delivery is achievable — pushing the "exactly-once effect" requirement onto idempotent job handlers. Layer retries with backoff, heartbeat-based stall detection, and per-tenant fair queuing on top, and the system holds up from a handful of jobs to tens of millions.

## Top Interview Questions

### Q1. Why can't a distributed job scheduler guarantee exactly-once execution?

Guaranteeing exactly-once would require atomically doing "mark job as executed" and "actually execute the job's side effect" as a single indivisible operation across a network, which isn't possible when a crash can occur at any point between those two steps — for example, a worker could complete a job's work and then crash before reporting success, leaving the scheduler with no way to distinguish "it succeeded and the report was lost" from "it never ran." The practical answer is to guarantee **at-least-once delivery** (retry whenever there's uncertainty) and push the responsibility for exactly-once *effect* onto the job handler via idempotency — e.g., using a deterministic idempotency key so a duplicate execution is detected and turned into a safe no-op.

### Q2. What is a hierarchical time wheel and why use it over a simple sorted list of upcoming jobs?

A hierarchical time wheel is a set of nested circular buffers at different granularities (seconds, minutes, hours, days); a job is placed into the coarsest wheel that comfortably covers its time-until-due, and as that wheel's pointer advances, jobs cascade down into finer wheels as their due time approaches, ultimately firing when they reach the seconds wheel's current slot. This gives O(1) amortized insertion and per-tick advancement regardless of total job count, because each tick only touches the small set of jobs in the current slot. A sorted list (or heap) of upcoming jobs works too and is simpler to reason about, but insertion and "pop next due" are O(log n), and at tens of millions of jobs with very different horizons (seconds to weeks out), that logarithmic factor and lock contention on a single shared structure becomes the bottleneck the time wheel avoids by spreading jobs across independent slots.

### Q3. How do you prevent two scheduler instances from both triggering the same job?

Partition job ownership into shards, and require each scheduler instance to hold an exclusive, TTL-bound lease on a shard (via a coordination service like etcd or ZooKeeper, or a Redis lock with TTL) before it's allowed to trigger any job in that shard. Only the current lease holder schedules that shard's jobs; the lease must be renewed periodically, and if the holder crashes or is network-partitioned, the lease expires and another instance acquires it and resumes scheduling. This bounds the window of "no one is scheduling this shard" to roughly the lease TTL, and guarantees at most one owner at a time, which is what actually prevents duplicate triggering — not merely reducing its likelihood.

### Q4. A job that should run every hour is running twice in a row occasionally. How do you debug this?

First check whether it's a duplicate *trigger* (the scheduler created two `JobRun`s for the same scheduled occurrence) or a duplicate *execution* of one `JobRun` (a heartbeat timeout caused a reschedule while the original worker was actually still alive and finished anyway) — the `JobRun` history with `scheduled_time` and `attempt_count` should distinguish these. If it's a duplicate trigger, suspect a shard ownership handoff race — e.g., a lease expiring and being reacquired by a new owner that doesn't correctly account for a trigger the previous owner already issued just before losing its lease; the fix is to make the trigger-and-enqueue step idempotent per `(jobId, scheduledTime)`, not just the shard-ownership handoff. If it's a duplicate execution from a heartbeat timeout, either the heartbeat interval/timeout is tuned too aggressively for that job's actual execution pattern, or the handler isn't fully idempotent yet — both are worth fixing, but the idempotency fix is the one that makes the system correct regardless of timing.

### Q5. How would you implement fair scheduling across tenants so one tenant with many jobs doesn't starve others?

Give each tenant its own logical queue (or a shared queue with tenant-tagged messages) and use weighted fair queuing at the dispatch layer, where each tenant is guaranteed a minimum share of worker capacity proportional to a configured weight, rather than pulling strictly FIFO from one global queue where a bulk of jobs from one noisy tenant could crowd out everyone else. Concretely, workers (or a dispatcher in front of them) round-robin across tenant queues weighted by their allocation, and per-tenant concurrency caps prevent any single tenant from consuming the entire worker pool even during their own burst. This is analogous to fair queuing in networking — the goal is proportional-share access to a shared resource, not strict priority order.

### Q6. How do you decide the right heartbeat interval and timeout for detecting a stalled job?

The heartbeat interval should be short relative to how quickly you want to detect a stall, but not so short that it adds meaningful overhead to normal execution — a common starting point is heartbeating every 10–30 seconds for jobs expected to run minutes to hours. The timeout (how long to wait without a heartbeat before presuming death) should be a multiple of the interval, e.g., 2–3x, to tolerate a single missed heartbeat due to transient network blips without falsely declaring the worker dead. This is inherently a trade-off: too aggressive a timeout causes frequent false-positive duplicate executions (mitigated by idempotency, but wasteful), while too lenient a timeout means genuinely stalled jobs sit undetected for longer, delaying retries and potentially violating SLAs.

### Q7. What would you do differently for jobs that must run at a very precise time (e.g., a stock market open at exactly 9:30:00) versus jobs where "sometime in this minute" is fine?

For jobs needing second-level precision, you'd want the finest wheel/bucket granularity applied directly (place them in the seconds wheel well ahead of their exact due time rather than letting them cascade down from a coarser wheel, which introduces slight processing overhead at cascade time) and prioritize their dispatch queue placement so they aren't waiting behind a burst of lower-precision jobs at the same tick. For jobs where imprecision within a minute is acceptable, you can safely add jitter (spreading their actual trigger time across the minute) specifically to smooth out the "everyone scheduled for :00" clustering problem, which you would never do for the precision-critical job. This is a good moment to mention that most schedulers expose a "precision requirement" or priority flag on the job definition so the dispatcher can treat these differently rather than applying one blanket jitter policy to everything.

### Q8. How would you support a job that legitimately needs to run for several hours, given the retry/heartbeat model described?

Long-running jobs should heartbeat throughout their execution (not just at start/end) so the Heartbeat Monitor has continuous evidence they're alive, and the retry/backoff logic should treat "no heartbeat within timeout" as the only failure signal for these jobs rather than a fixed overall execution-time limit, since the job's total duration is expected to be long. It also helps to have the job report incremental progress (e.g., "40% complete, checkpoint at record 400,000") so that if it does need to be retried, execution can resume from the last checkpoint rather than restarting from scratch — this requires the job handler itself to support checkpointing, which is a contract the scheduler can encourage but not enforce generically.

### Q9. Why separate JobDefinition from JobRun instead of just updating one row per job with its current status?

`JobDefinition` represents the recurring template (the cron schedule, the handler, retry policy) and changes rarely — mainly when a user edits the job. `JobRun` represents one specific occurrence and its execution attempts, which is created fresh on every trigger and mutates frequently (status transitions, heartbeat timestamps, attempt count) during its short lifetime. Conflating them would mean either losing history (each trigger overwrites the previous run's outcome) or awkwardly bolting an array of run history onto the definition row, which doesn't scale well for a job that fires every 10 minutes for years and makes querying "show me all failed runs across all jobs in the last hour" much harder than querying a purpose-built `JobRun` table.

### Q10. How would you handle a "thundering herd" of jobs all scheduled for midnight?

First, add small random jitter (a few seconds to a couple of minutes, depending on what the job's semantics tolerate) to trigger times for jobs where exact timing doesn't matter, which is often configurable per job rather than forced globally, since some midnight jobs genuinely need to run at midnight. Second, ensure the worker pool autoscales ahead of known trigger-time clustering rather than reactively — since the clustering is predictable (every day at midnight), you can pre-scale on a schedule rather than waiting for a scaling signal to catch up after the spike has already started. Third, make sure the time wheel/dispatcher can enqueue a burst of due jobs quickly without itself becoming a bottleneck — the enqueue operation into the work queue should be O(1) per job so a spike of thousands of simultaneously-due jobs doesn't stall the scheduler tick itself.

### Q11. How would this design change to support job dependencies (job B should only run after job A succeeds)?

This starts to move from "single-job scheduling" toward a lightweight DAG/workflow model: `JobRun` would need a `depends_on` reference to another run, and the dispatcher would hold a dependent job in a "waiting" state rather than enqueuing it to workers until its dependency's `JobRun` reaches `succeeded`. This is meaningfully more complex than the base design because you now need to track partial completion of a graph of runs, handle what happens if an upstream job fails permanently (cascade failure/skip to downstream jobs, or leave them pending indefinitely with an alert), and potentially detect cycles at job-definition time. It's worth explicitly telling the interviewer this is out of scope for a pure job scheduler and belongs to a dedicated workflow orchestration engine (like Airflow or Temporal), unless the interview specifically asks you to extend into that territory.

### Q12. What observability would you build into this system, and why does it matter more here than in a typical CRUD service?

You'd want per-job and per-tenant dashboards of trigger latency (scheduled time vs. actual dispatch time), success/failure rates, retry counts, and current backlog depth per priority queue, plus alerting on shard lease churn (frequent handoffs suggest an unstable scheduler node) and on heartbeat-timeout-triggered reschedules (a spike suggests either a systemic worker problem or a timeout tuned too aggressively). This matters more here than in typical CRUD because failures in a job scheduler are often silent by nature — a job that silently stops firing doesn't generate an obvious user-facing error the way a broken API endpoint does, so without dedicated metrics on trigger latency and backlog, a "quietly broken" scheduler for one tenant's shard could go unnoticed for a long time.
