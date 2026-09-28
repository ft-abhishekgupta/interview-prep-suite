---
title: Design a Content Moderation Pipeline
description: Design a multi-stage asynchronous moderation system covering ML classification, rule engines, human review, DLQs and audit trails
difficulty: Advanced
tags: [pipelines, message-queues, ml-systems, reliability]
---

A content moderation pipeline decides whether user-generated content (posts, images, comments) is safe to publish, using a mix of automated checks, machine-learning classifiers, and human reviewers. It's a good showcase for asynchronous, multi-stage pipeline design, because no single stage can be allowed to block or lose content, and the stages have wildly different latencies and failure modes.

## Requirements

### Functional

- Every piece of submitted content passes through automated checks before publishing.
- Content flagged as likely-violating is routed to a human review queue.
- Reviewers can approve, reject, or escalate content, and their decision is recorded.
- Rejected content can be appealed, and appeals are tracked.
- Moderation rules can be updated without a code deployment.

### Non-functional

- No content is silently lost between stages, even under partial outages.
- Each stage can scale and fail independently — a slow ML model shouldn't block ingestion.
- Automated-only content gets a decision within seconds; human-reviewed content within a defined SLA (e.g., hours).
- Every decision is auditable — who/what made it, when, and why.
- The pipeline must be resumable: a stage restart shouldn't reprocess already-completed work or drop in-flight work.

### Out of scope

- The training/labeling pipeline for the ML models themselves.
- Legal/policy definition of what counts as violating content.
- Payment/billing implications of moderation decisions.

> [!KEY]
> This is fundamentally a **pipeline of independently scalable, independently failing stages connected by a durable message broker** — not a single service that "checks content." Every design decision (idempotency, DLQs, stage isolation) exists because any one stage can be slow, wrong, or down without taking the rest of the system with it.

## Scale estimation

| Metric | Estimate | Arithmetic |
|---|---|---|
| Content submissions/day | 200 million | posts, comments, images combined |
| Submission QPS (avg / peak) | ~2,300/s avg, ~9,000/s peak | 200M ÷ 86,400 s; ×4 for peak hours |
| Auto-approved (no human needed) | ~90% | typical for a mature classifier |
| Routed to human review | ~10% | 20M/day → ~230/s avg needing review |
| Reviewer throughput | ~150 items/hour/reviewer | assumption based on manual review pace |
| Reviewers needed | ~5,600 concurrent reviewers | 20M/day ÷ 24h ÷ 150 items/hour, before shift coverage and utilization buffers |
| Appeal rate | ~2% of rejections | assume 5% overall rejection rate × 2% appeal |
| Storage (audit trail) | ~200M records/day, ~1 KB each ≈ 200 GB/day | every decision logged with reasoning |

> [!TIP]
> If asked how you'd reduce reviewer headcount, the senior answer is about the classifier's precision/recall trade-off: *"Every percentage point improvement in the model's ability to auto-resolve clear-cut cases directly reduces the human review queue — this is a case where ML quality is literally an infrastructure cost lever, not just a product quality one."*

## Core entities and data model

| Entity | Key fields |
|---|---|
| ContentItem | id, author_id, type (post/comment/image), payload_ref, submitted_at |
| ModerationDecision | id, content_id, stage, verdict (approve/reject/escalate), reason, confidence, decided_by (model_version or reviewer_id), decided_at |
| Rule | id, condition, action, version, enabled, updated_at |
| ReviewTask | id, content_id, assigned_to, status (queued/in_review/done), sla_deadline |
| Appeal | id, content_id, original_decision_id, status, resolved_by, resolved_at |

```mermaid
erDiagram
    CONTENTITEM ||--o{ MODERATIONDECISION : accumulates
    CONTENTITEM ||--o| REVIEWTASK : may_need
    CONTENTITEM ||--o| APPEAL : may_trigger
    MODERATIONDECISION }o--|| RULE : may_reference
```

Every stage appends a `ModerationDecision` rather than overwriting a single "status" field — this is what makes the audit trail complete and lets you reconstruct exactly how a piece of content moved through the pipeline.

## API design

```http
POST   /v1/content                    Body: { type, payload }              -> { contentId, status: "pending" }
GET    /v1/content/{id}/status        -> { status, decisions: [...] }
POST   /v1/review-tasks/{id}/decision Body: { verdict, reason }             -> { taskId, status: "done" }
POST   /v1/rules                      Body: { condition, action }           -> { ruleId, version }
POST   /v1/appeals                    Body: { contentId, reason }           -> { appealId, status: "pending" }
```

Submission is asynchronous by design — `POST /v1/content` returns immediately with `pending`, and the caller polls or subscribes to a webhook/event for the eventual decision, rather than blocking on the full pipeline.

## High level architecture

```mermaid
flowchart TD
    U["User submits content"] --> ING["Ingest Service"]
    ING --> B1["Broker: raw.content"]
    B1 --> AUTO["Automated Checks<br/>(size, format, blocklist)"]
    AUTO --> B2["Broker: checked.content"]
    B2 --> ML["ML Classification"]
    ML --> B3["Broker: classified.content"]
    B3 --> RULE["Rule Engine"]
    RULE -->|"clear verdict"| PUB["Publish Service"]
    RULE -->|"needs judgment"| HUMAN["Human Review Queue"]
    HUMAN --> REV["Reviewer Decision"]
    REV --> PUB
    REV --> AUDIT[("Audit Trail Store")]
    AUTO --> AUDIT
    ML --> AUDIT
    RULE --> AUDIT
    AUTO -.->|"failure"| DLQ1[("DLQ: auto-checks")]
    ML -.->|"failure"| DLQ2[("DLQ: ml-classify")]
```

Request flow:

1. A user submits content; the Ingest Service validates the request shape, stores the raw payload, and publishes a message onto the broker rather than processing synchronously.
2. The Automated Checks stage consumes the message, applies cheap deterministic checks (file type/size, known-bad-hash blocklist, banned keyword list), and publishes its result — pass, fail, or "needs deeper check" — onto the next topic.
3. Content that isn't auto-rejected flows to the ML Classification stage, which scores it against one or more models (text toxicity, image classifiers, etc.) and attaches confidence scores.
4. The Rule Engine consumes classified content and evaluates configurable rules (e.g., "toxicity score > 0.9 → auto-reject," "score between 0.4 and 0.9 → send to human review") to reach a verdict or route to a human queue.
5. Clear-cut verdicts go straight to the Publish Service (approve → goes live, reject → hidden with a reason).
6. Ambiguous content lands in the Human Review Queue; a reviewer's decision is recorded and also flows to Publish.
7. Every stage writes its decision to the Audit Trail Store, independent of the primary flow, so the full history is reconstructable even if a later stage fails.
8. Any stage that fails processing a message after retries routes that message to a stage-specific dead-letter queue (DLQ) rather than blocking the topic or silently dropping it.

## Deep dive: stage isolation, idempotency, and per-stage DLQs

Each stage is a separate consumer group reading from its own topic, which means a slow or crashed ML service doesn't block automated checks from continuing to process new submissions — they simply queue up on the topic between stages, and the queue's durability is what protects against loss.

```mermaid
sequenceDiagram
    participant A as "Automated Checks"
    participant B as "Broker"
    participant M as "ML Classification"
    A->>B: publish(checked.content, msg, key=contentId)
    B->>M: deliver(msg)
    M->>M: process (may crash here)
    alt success
        M->>B: publish(classified.content, result)
        M->>B: ack(msg)
    else failure after N retries
        M->>B: publish(DLQ: ml-classify, msg + error)
        M->>B: ack(msg)
    end
```

- **Idempotency**: each message carries the `contentId` as a natural idempotency key; every stage's write (a `ModerationDecision` row) uses an upsert keyed on `(content_id, stage)` so an at-least-once redelivery (common with message brokers) never produces duplicate or conflicting decisions.
- **Retries**: transient failures (a model endpoint timeout, a brief DB blip) are retried a bounded number of times with backoff before giving up.
- **DLQ per stage**: rather than one shared dead-letter queue, each stage has its own — a spike of ML classification failures (e.g., a bad model deploy) is isolated from automated-check failures, so on-call can be routed to the right owning team immediately based on which DLQ is filling up.

> [!WARNING]
> A single shared DLQ across all stages might seem simpler, but it makes triage much harder — you lose the "which stage, which failure mode" signal that a per-stage DLQ gives for free, and you risk one noisy stage's failures burying another's.

## Deep dive: partial failure, resumability, and end-to-end SLA

Because the pipeline is asynchronous and multi-stage, a piece of content can be "stuck" at any point, and the system needs to answer "where is this, and is it stuck?" without a human digging through logs.

| Failure point | What resumability looks like |
|---|---|
| Ingest succeeds, broker publish fails | Ingest retries publish with the same idempotency key before acknowledging the original request as accepted |
| Automated Checks crashes mid-batch | Broker redelivers unacknowledged messages to another consumer instance; idempotent writes make redelivery safe |
| ML model call times out | Stage retries with backoff, falls back to a DLQ after max attempts; content is marked `stuck` visibly rather than lost |
| Reviewer starts but abandons a task | Task has a visibility timeout / lease; if not completed in time, it's returned to the queue for another reviewer |
| Rule Engine deployed with a broken rule | Rule versioning lets you roll back to the last known-good rule set without reprocessing already-decided content |

- **Per-stage SLA**: automated checks and ML classification are budgeted in the low seconds; the rule engine evaluation in milliseconds; human review has a longer SLA (e.g., 4–24 hours depending on severity) tracked via `sla_deadline` on `ReviewTask`, with escalation if a task is close to breaching it.
- **End-to-end latency** is reported as a distribution, not a single number, since fully-automated content resolves in seconds while human-reviewed content takes much longer — conflating the two into one average would hide both realities.

## Deep dive: rule engine design and hot-reloading rules

Rules need to change frequently (new abuse pattern discovered, a threshold needs tuning) without a code deployment and without downtime.

- Rules are stored as versioned, structured data (not code), evaluated by a generic interpreter rather than compiled per rule.
- A new rule version is published to a config store (or a dedicated topic); the Rule Engine's instances watch for updates and hot-swap their active rule set atomically, without a restart.
- Every decision records which rule *version* was in effect, so the audit trail can answer "was this decision correct given the rules active at the time," even after the rule has since changed.

```json
{
  "ruleId": "toxicity-auto-reject",
  "version": 42,
  "condition": "toxicity_score > 0.85",
  "action": "reject",
  "enabled": true
}
```

```mermaid
flowchart LR
    ADMIN["Policy Admin"] --> RSTORE[("Rule Store<br/>versioned")]
    RSTORE --> WATCH["Config Watcher"]
    WATCH --> RE1["Rule Engine Instance 1"]
    WATCH --> RE2["Rule Engine Instance 2"]
```

> [!TIP]
> The senior framing: *"Rules are data, not code — this lets policy/trust-and-safety teams tune thresholds in near real time without engineering involvement, and versioning them means every past decision remains explainable."*

## Deep dive: model versioning and shadow evaluation

Deploying a new ML model version directly into the decision path is risky — a regression could mass-reject good content or mass-approve bad content at scale before anyone notices.

- **Shadow evaluation**: run the new model version in parallel with the current production model on live traffic, logging its outputs without acting on them, and compare agreement rates and score distributions before promoting it.
- **Canary rollout**: once shadow results look healthy, route a small percentage of real decisions through the new model, monitor human-review overturn rates and appeal rates for that slice, and ramp up gradually.
- **Model version tagged on every decision**: `ModerationDecision.decided_by` records the exact model version, so if a regression is later discovered, every affected decision can be identified and reprocessed, rather than guessing which content was affected.

| Deployment strategy | Risk | Use when |
|---|---|---|
| Direct replace | High — no visibility before impact | Never, for a moderation model |
| Shadow evaluation | Low — no user impact, but adds compute cost | Always, before any promotion |
| Canary (% rollout) | Medium — limited blast radius | After shadow looks healthy |

## Deep dive: audit trail, appeals, and embeddings-based similarity

- **Audit trail**: every stage's decision, including automated ones, is appended (not overwritten) to the `ModerationDecision` log with the reasoning (rule fired, model score, reviewer notes) — this is what makes an appeal or a regulatory inquiry answerable.
- **Appeals**: an appeal creates a new review task referencing the original decision; a different reviewer (or a senior reviewer) re-evaluates, and the outcome is itself logged as a new decision rather than mutating the original one.
- **Embeddings/AI-assisted similarity**: for content that's a near-duplicate of something already actioned (a meme reposted with minor edits, a spam message copy-pasted), compute an embedding and check a vector index for near-neighbors to a known-bad (or known-good) item; a strong match can short-circuit the pipeline (fast auto-reject or fast auto-approve) without waiting on the full classifier, which both speeds up resolution and reduces duplicate reviewer effort on content that's already been judged.

## Bottlenecks and scaling

- **ML classification stage** is typically the most compute-expensive; scale it independently (its own consumer group, its own autoscaling policy) rather than coupling its capacity to the cheaper automated-checks stage.
- **Human review queue depth** during a spike (e.g., a coordinated abuse campaign) — prioritize by severity/confidence so the worst content is reviewed first, and have an on-call surge process for reviewer capacity.
- **Rule engine evaluation** should stay in-memory and fast (milliseconds) — it must not become a bottleneck between the (already latency-tolerant) ML stage and the (latency-sensitive) auto-publish path.
- **Audit trail write volume** at 200M decisions/day needs a write-optimized, append-only store rather than a general relational table with heavy indexing.

## Failure scenarios

| Failure | Blast radius | Mitigation |
|---|---|---|
| ML classification service down | Content queues up on its topic, not lost | Automated checks continue running; broker retains messages until consumer recovers |
| Bad rule deployed (over-aggressive reject) | Spike in false rejections | Rule versioning allows instant rollback; canary rollout for rules limits initial blast radius |
| Reviewer queue overwhelmed by abuse campaign | SLA breach for legitimate content | Severity-based prioritization; temporary reviewer surge; auto-throttle low-priority submissions |
| Broker partition/outage | Pipeline stalls at that stage boundary | Multi-broker replication; producers buffer and retry until broker recovers |
| Audit store write failure | Decisions made but not recorded | Decisions are not considered final until the audit write is acknowledged; retry with backoff before advancing |

## Cheat sheet

- Treat this as a **broker-connected pipeline of independently scaling stages**, not one monolithic checker.
- Idempotency key = `contentId` (+ stage); every write is an upsert, not an insert, to survive at-least-once redelivery.
- One DLQ **per stage**, not one shared DLQ — it's the difference between fast triage and a mess.
- Rules are versioned data, hot-reloaded — never require a deploy to change a threshold.
- Never promote a new model directly; shadow-evaluate, then canary, always tagging decisions with the model version.
- Audit trail is append-only, one row per decision per stage — never overwrite.
- Embeddings/similarity search short-circuits duplicates without waiting on the full pipeline.
- Report end-to-end latency as a distribution — automated and human-reviewed content have very different SLAs.

## Common mistakes

| Mistake | Fix |
|---|---|
| One shared DLQ for the whole pipeline | Per-stage DLQ for fast, targeted triage |
| Overwriting a single "status" field per content item | Append immutable decisions per stage for a full audit trail |
| Deploying a new ML model directly into production decisions | Shadow-evaluate, then canary roll out gradually |
| Hardcoding moderation thresholds in code | Store rules as versioned, hot-reloadable data |
| Treating "review pending" as stuck forever with no SLA | Track SLA deadlines per review task and escalate near breach |
| Assuming message delivery is exactly-once | Design every stage write as an idempotent upsert |

## Summary

A content moderation pipeline is an exercise in designing safe, resumable, multi-stage asynchronous processing: a durable broker decouples stages so a slow or broken one never takes down the rest, idempotent per-stage writes absorb at-least-once redelivery, and per-stage DLQs make failures triageable instead of mysterious. Rules-as-data and shadow/canary model rollout let the system evolve continuously without downtime or code deploys, and an append-only audit trail makes every decision — automated or human — explainable after the fact, which is what appeals and compliance both depend on.

## Top Interview Questions

### Q1. Why use a message broker between stages instead of one service that calls the next stage directly (synchronous chaining)?

Synchronous chaining means the slowest stage (typically ML classification) directly determines the latency and availability of the entire pipeline — if the ML service is down or slow, ingestion itself would back up or fail. A broker decouples stages: each one reads from its own topic at its own pace, so a slow or crashed downstream stage causes messages to queue durably rather than causing upstream failures or blocking. It also makes independent scaling possible — automated checks (cheap, fast) and ML classification (expensive, slower) can each scale to match their own load rather than being forced to scale together, and it gives you natural retry and dead-letter semantics for free rather than needing to build that into every direct service-to-service call.

### Q2. How do you ensure a piece of content isn't processed twice by the same stage, given that most message brokers offer at-least-once delivery?

Every stage's write is made idempotent by using a natural key — typically `(content_id, stage)` — and performing an upsert rather than an insert: if a `ModerationDecision` for that content and stage already exists, a redelivered message either overwrites it with the same result or is detected as already-processed and skipped, rather than creating a duplicate or conflicting row. This means redelivery (which the broker will do whenever an acknowledgment is lost or delayed, even if the original processing actually succeeded) is safe — the end state is the same whether the message was processed once or three times. The same idempotency-key pattern extends to any side effect the stage has (like calling an external moderation API) where possible.

### Q3. Why maintain a separate DLQ per stage instead of one shared dead-letter queue for the whole pipeline?

A shared DLQ mixes failure signals from unrelated causes — an ML model timeout looks the same in the queue as a malformed-payload failure in automated checks — which makes on-call triage slower because you have to inspect each message to figure out which team and which root cause it belongs to. A per-stage DLQ means the on-call engineer for the ML team can watch just their queue's depth and error patterns, and a spike there immediately and unambiguously points at their stage, without needing to filter out noise from other stages' unrelated failures. It also lets you apply different reprocessing logic per stage — replaying a batch of automated-check failures after a bug fix is a different operation than replaying ML classification failures after a model rollback, and separate queues make that operationally clean.

### Q4. How would you safely roll out a new ML classification model without risking a mass mis-moderation incident?

Deploy the new model in shadow mode first: it runs on the same live traffic as the current production model, and its scores are logged and compared against the production model's actual decisions, but it doesn't influence any real outcome. Once you've validated agreement rates and checked for concerning divergences (e.g., the new model scoring a known-safe content category as highly toxic), promote it via a canary — routing a small percentage of real traffic through it — and closely monitor downstream signals like human-reviewer overturn rate and appeal volume for that slice before ramping to 100%. Every decision is tagged with the model version that made it, so if a problem is discovered after full rollout, you can identify exactly which decisions are suspect and reprocess just those, rather than needing to reprocess everything or guess at the blast radius.

### Q5. Content gets stuck showing "pending" for hours with no decision. How do you debug where it's stuck in the pipeline?

Because every stage writes a `ModerationDecision` row (or, absent one, the content simply hasn't reached that stage yet), you can query the audit trail for that `content_id` and see the last stage that produced a decision — the gap between that and the next expected stage tells you where it's stuck. If the last recorded stage is "automated checks passed" with nothing from ML classification, check that stage's consumer lag and its DLQ — a spike in the DLQ for that stage strongly suggests processing failures rather than mere backlog. If the content reached the human review queue and has a `ReviewTask` with a `sla_deadline` that's already passed, that's a queue-capacity or prioritization issue rather than a technical failure, and the fix is either reviewer capacity or reprioritization, not a pipeline bug.

### Q6. Why store rules as versioned data rather than hardcoding thresholds in the rule engine's code?

Moderation policy changes far more frequently than the engineering team can realistically deploy code — trust-and-safety teams need to react to new abuse patterns or tune a threshold within minutes to hours, not wait for a release cycle. Storing rules as structured, versioned data that the Rule Engine loads and hot-swaps at runtime means policy changes don't require a deployment, don't risk unrelated code regressions, and can be rolled back instantly by reverting to the previous rule version if a change causes problems. Versioning also matters for auditability — you need to be able to say "this content was rejected under rule version 42, which required a toxicity score above 0.85," even after rule version 43 has since changed that threshold.

### Q7. How would you prioritize the human review queue during a coordinated spam or abuse campaign that floods it with thousands of items at once?

Rather than treating the review queue as a strict FIFO, prioritize by a combination of the ML classifier's confidence (higher-confidence-of-violation content reviewed first, since it's more likely to need urgent action) and estimated severity/reach (content already getting high engagement or from an account with prior violations jumps the queue). You'd also want a temporary auto-throttle on very-low-confidence borderline content — deferring it slightly rather than adding it to an already-overwhelmed queue at the same priority as clear violations — and potentially a surge staffing process to bring in more reviewers or shift lower-priority queues temporarily. It's important that this prioritization logic itself is monitored, since misconfigured priority weights can accidentally starve a legitimate but lower-scored category of content indefinitely.

### Q8. Why not just have the Automated Checks stage call the ML Classification stage's API directly and skip the rule engine as a separate stage?

Separating the Rule Engine out lets moderation policy (thresholds, which categories require human review, regional/legal variations) change independently of the ML model's scoring logic — the model's job is purely to produce a score/classification, while the rule engine's job is to decide what action that score implies, and those two concerns evolve at very different rates and are often owned by different teams (ML engineers vs. trust-and-safety policy owners). If they were fused into one stage, changing a threshold would require touching the same code/deploy path as changing the model, increasing risk and coupling two things that should be independently versioned, independently rolled back, and independently audited.

### Q9. How do embeddings-based similarity checks help, and what's the risk of relying on them too heavily?

An embeddings-based similarity check computes a vector representation of new content and searches a vector index for near-neighbors among already-actioned content; a strong match to a known-violating item lets you fast-track a decision (auto-reject) without waiting on the full, more expensive classification pipeline, which is especially valuable against copy-paste spam or lightly-modified repeated content. The risk is over-reliance: near-duplicate detection can misfire on legitimate content that happens to be similar in embedding space to something previously actioned for unrelated reasons (a false positive), and it can be evaded by adversarial actors who deliberately perturb content enough to shift its embedding away from known-bad examples while keeping the same intent. It should be treated as a fast-path optimization and confidence signal feeding into the rule engine, not a sole and final decision-maker on its own.

### Q10. What's the difference between at-least-once, at-most-once, and exactly-once delivery in this pipeline, and which does it actually use?

At-most-once means a message might be lost and never processed (acceptable for something like non-critical logging, never acceptable here — losing a piece of content mid-moderation could mean it publishes unreviewed or never gets a decision). At-least-once means the message is guaranteed to be delivered and processed, but possibly more than once (e.g., due to a redelivery after an ack was lost) — this is what the pipeline actually uses, because it's the achievable, practical guarantee for a distributed broker-based system. True exactly-once delivery isn't achievable end-to-end across independent services and a network, so the pipeline instead achieves an equivalent *effect* by combining at-least-once delivery with idempotent, upsert-based writes at every stage — a duplicate delivery produces the same final state as a single delivery, which is functionally what matters.

### Q11. How would you handle an appeal, and why is it modeled as a new decision rather than editing the original one?

An appeal creates a new `Appeal` record referencing the original `ModerationDecision`, and routes to a (often more senior or specialized) reviewer who evaluates the case, potentially with additional context the original automated pipeline didn't have. The outcome of the appeal is recorded as its own new `ModerationDecision` entry — reversing the original recorded verdict, not by deleting or mutating history, because the audit trail needs to preserve "what was decided, by what, and when" at every point in time, including the fact that it was later appealed and overturned. This matters both for internal quality review (measuring how often a given model version or rule leads to successful appeals, which is a strong signal that it needs tuning) and for any external transparency or regulatory reporting requirement that content decisions be explainable and their full history traceable.

### Q12. How would you extend this pipeline to support multiple content types (text, images, video) with very different processing costs and models?

Keep the broker topology generic — the same "ingest → automated checks → classification → rule engine → publish/review" shape applies regardless of content type — but branch the classification stage by content type, since a text toxicity model, an image classifier (often GPU-bound and far more expensive per item), and a video pipeline (which itself may need frame sampling or its own sub-pipeline) have very different cost and latency profiles. This is naturally handled by routing content to type-specific classification consumer groups (e.g., separate topics or partition keys for `image` vs. `text` vs. `video`) so each can be scaled and resourced independently — GPU-backed autoscaling for images/video, cheaper CPU-backed autoscaling for text — without a slow video-processing surge starving text moderation capacity, or vice versa.
