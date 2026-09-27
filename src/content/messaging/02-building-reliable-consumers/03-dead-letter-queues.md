---
title: Dead Letter Queues
description: What lands in a dead letter queue, why depth is a primary SLO signal, safe triage and replay workflow, and how to design the DLQ in from day one
difficulty: Core
tags: [messaging, dead-letter-queue, monitoring, service-bus]
---

A dead letter queue (DLQ) is where messages go when the system has given up on normal processing — and how a team treats that queue says more about their operational maturity than almost any other messaging metric. This section covers what lands there, how to triage it safely, and why replay is more dangerous than it looks.

The shape is simple even when the failure modes behind it aren't: a producer sends and forgets, a consumer pulls and processes, and only after the Nth retry does a message get diverted into the DLQ instead of back onto the main queue.

![A message queue routing a message into the dead letter queue after the Nth failed retry, instead of back to the consumer](notes/05-HighLevelDesign/AsyncSystems/image-7.png)

## What lands in a DLQ, and why

| Reason | Trigger |
|---|---|
| Max delivery count exceeded | Message abandoned/failed N times (Service Bus default 10) |
| TTL expiry | Message sat in the queue longer than its time-to-live without being consumed |
| Header/message size exceeded | Message or its properties exceed the broker's size limit |
| Explicit dead-letter | Consumer code calls `DeadLetterAsync` deliberately (e.g., detected a permanent/business failure) |
| Subscription filter evaluation error | A SQL filter on a topic subscription throws while evaluating a message |
| Session lock lost repeatedly (sessions) | A session-enabled queue can't maintain a lock long enough to process |

> [!KEY]
> A DLQ message always carries a **dead-letter reason** and **description** (Service Bus sets `DeadLetterReason` and `DeadLetterErrorDescription` as system properties). Never dead-letter without setting these explicitly in your own code — an unexplained DLQ message is nearly untriageable months later.

## Monitoring DLQ depth as a primary SLO signal

DLQ depth (and its rate of growth) should be a first-class alert, not an afterthought — it directly measures messages that failed to complete their intended business effect.

| Metric | Why it matters | Suggested alert |
|---|---|---|
| DLQ depth (absolute) | Backlog of unprocessed failures | Alert above a small absolute threshold (e.g., > 10) for business-critical queues |
| DLQ growth rate | Detects an active incident vs a slow trickle | Alert on rate of change, not just level |
| Time since oldest DLQ message | Detects triage neglect | Alert if oldest message > 24h with no action |
| Dead-letter reason breakdown | Distinguishes a new bug from known noise | Group/tag by reason for dashboards |

> [!WARNING]
> Treating DLQ depth as a "check it during business hours" metric instead of a paged alert is the single most common DLQ mistake. Every message in the DLQ represents a business event that did not complete — an order not shipped, a payment not reconciled, a notification not sent — and it will not fix itself.

## Triage workflow

```mermaid
flowchart TD
    A["Message in DLQ"] --> B["Read DeadLetterReason + description"]
    B --> C{"Known, safe-to-replay bug already fixed?"}
    C -->|Yes| D["Replay via controlled tool"]
    C -->|No| E{"Bad data / permanent business failure?"}
    E -->|Yes| F["Quarantine — manual resolution, do not replay as-is"]
    E -->|No, unclear| G["Investigate root cause before touching the message"]
    G --> C
    D --> H["Monitor for repeat dead-letter"]
    F --> I["Fix data or escalate to business owner"]
```

The first rule of triage: **read the reason before doing anything else.** A message dead-lettered for "max delivery count exceeded" against a downstream outage that's since recovered is often safe to replay as-is. A message dead-lettered because it failed schema validation will fail identically on replay until the payload or the code is fixed.

## Replay tooling and the danger of blind replay

> [!DANGER]
> "Just move everything from the DLQ back to the main queue" is the classic DLQ incident. If the root cause wasn't actually fixed, you get an instant re-flood of the same failures, likely compounded by however much backlog built up while triage was happening — sometimes described as a "DLQ replay storm."

A safe replay tool should:

- Replay **one message, or a small batch, at a time**, not the whole queue at once.
- Let you filter by dead-letter reason, so you don't replay unrelated failures together.
- Re-verify the root cause is actually fixed (e.g., check the downstream dependency's health, or that a code fix has actually deployed) before replaying.
- Preserve or clearly annotate that this is a **replay**, not an original delivery, for audit/idempotency purposes — the consumer should treat it like any other at-least-once redelivery.

```csharp
public async Task ReplayBatchAsync(string deadLetterPath, string mainQueuePath, int batchSize)
{
    var dlqReceiver = _client.CreateReceiver(deadLetterPath);
    var sender = _client.CreateSender(mainQueuePath);

    var messages = await dlqReceiver.ReceiveMessagesAsync(batchSize);
    foreach (var msg in messages)
    {
        // Clone rather than resend the original — avoids broker-level id confusion
        var clone = new ServiceBusMessage(msg.Body) { MessageId = msg.MessageId };
        clone.ApplicationProperties["ReplayedFrom"] = "dlq";
        await sender.SendMessageAsync(clone);
        await dlqReceiver.CompleteMessageAsync(msg); // remove from DLQ only after resend succeeds
    }
}
```

## Ordering after replay

Replayed messages almost never preserve their original position relative to the rest of the stream — by the time you replay, newer messages for the same entity may already have been processed. If ordering matters for that entity, treat the replay as an out-of-order, versioned write (see idempotency and ordering pages) rather than assuming the system will "catch up" correctly; a naive replay can silently overwrite newer state with stale data.

## Poison-message quarantine

Some DLQ messages should never be replayed as-is — a permanently malformed payload, a message referencing data that was deliberately deleted, or one that reveals a data corruption bug upstream. These need a **quarantine** state distinct from "pending replay": tagged, excluded from any bulk replay tooling, and routed to a human or a data-fix workflow instead.

## DLQ runbook

| Situation | Action | Who |
|---|---|---|
| DLQ depth spikes suddenly | Check dead-letter reason breakdown; correlate with recent deploys/downstream incidents | On-call engineer |
| Single reason dominates (e.g., one downstream outage) | Confirm downstream recovered, replay in small batches, monitor for repeat failures | On-call engineer |
| Mixed/unclear reasons | Sample a handful of messages, read full description and payload, do not bulk-replay | Owning team |
| Message references deleted/invalid data | Quarantine — do not replay; needs a data fix or manual reconciliation | Owning team + data owner |
| Oldest message > SLA age | Escalate — this indicates DLQ triage has stalled | Team lead |
| Dead-letter reason is a schema/serialization mismatch | Fix producer or consumer contract before any replay | Owning team, coordinated across services |

## Designing the DLQ in from day one

| Design decision | Why it matters |
|---|---|
| Alerting on DLQ depth wired up before go-live | Otherwise the first DLQ incident is discovered by a customer complaint |
| Every explicit dead-letter call sets a reason + description | Makes triage possible without reading application logs |
| A replay tool exists before it's needed under pressure | Building replay tooling *during* an incident is slow and error-prone |
| Dashboards group DLQ by reason, not just total count | Distinguishes "one new bug" from "background noise" instantly |
| DLQ retention/TTL is set deliberately, not left at defaults | Some brokers expire DLQ messages too — losing them silently is worse than the original failure |

```mermaid
flowchart LR
    P["Producer"] --> Q["Main Queue"]
    Q --> C["Consumer"]
    C -->|"success"| Done["Completed"]
    C -->|"max delivery / TTL / explicit / filter error"| DLQ["Dead Letter Queue"]
    DLQ --> T["Triage: read reason"]
    T -->|"root cause fixed"| Replay["Replay tool → back to Main Queue"]
    T -->|"bad data / permanent"| Quarantine["Quarantine for manual fix"]
```

## Cheat sheet

- DLQ depth and growth rate should be a paged alert, not a dashboard you check occasionally.
- Always set `DeadLetterReason` and description explicitly on every deliberate dead-letter call.
- Read the reason before touching a DLQ message — that decides whether replay is safe or the message needs quarantine.
- Never bulk-replay an entire DLQ blindly — replay small batches, filtered by reason, after confirming the root cause is fixed.
- Replayed messages are redeliveries — consumers must treat them idempotently, same as any other at-least-once delivery.
- Ordering guarantees do not survive a replay — treat replayed writes as versioned/out-of-order safe, not assume in-order catch-up.
- Build the replay tool and DLQ dashboards before go-live, not during the first incident.

## Common mistakes

| Mistake | Fix |
|---|---|
| Dead-lettering without setting a reason/description | Always set both explicitly — untraceable DLQ messages are unusable months later |
| Checking the DLQ manually/periodically instead of alerting on it | Wire DLQ depth and growth rate into paging alerts before launch |
| Replaying the entire DLQ in one bulk operation | Replay small batches, filtered by reason, after confirming root cause is fixed |
| Assuming replayed messages will restore correct order | Design replayed writes to be version-aware/idempotent, not order-dependent |
| Leaving DLQ retention at broker defaults without reviewing it | Explicitly decide DLQ TTL — losing a DLQ message silently is worse than the original failure |

## Summary

The DLQ is not a graveyard, it's an operational queue that needs the same rigor as the main path — alerting, a documented triage workflow, and safe, reason-aware replay tooling. Treat DLQ depth and growth rate as a primary SLO signal because every message there represents an incomplete business effect, always record why a message was dead-lettered, and never bulk-replay without confirming the underlying cause is actually fixed. Some messages should never be replayed as-is — quarantine those explicitly — and remember that ordering guarantees do not survive a replay, so replayed writes need to be idempotent and version-aware.

## Top Interview Questions

### Q1. What are the main reasons a message ends up in a dead letter queue?

The most common is exceeding the max delivery count — the message was abandoned or failed to complete N times and the broker automatically moves it to the DLQ. Others include TTL expiry (it sat unconsumed past its time-to-live), exceeding a header or message size limit, a subscription filter (like a Service Bus SQL filter) throwing an exception while evaluating the message, and explicit dead-lettering, where the consumer code deliberately calls something like `DeadLetterAsync` after detecting a permanent failure — a malformed payload or a business rule violation that will never succeed on retry. Each of these should set a clear reason so the message is triageable later without re-deriving the cause from logs.

### Q2. Why should DLQ depth be treated as a primary SLO signal rather than a background metric?

Because every message sitting in a DLQ represents a business event that did not complete its intended effect — an order that wasn't shipped, a payment that wasn't reconciled, a notification that was never sent — and unlike a queue backlog that's actively draining, a DLQ backlog will not resolve itself; it requires a human or automated action. If DLQ depth is only checked occasionally, an active incident (a downstream dependency failing, a bad deploy) can silently accumulate hundreds of failed business events before anyone notices, well after the original alerting (which usually watches queue depth or error rates, not DLQ specifically) has gone quiet. Alerting on DLQ depth and its growth rate closes that blind spot.

### Q3. Why is "just replay the whole DLQ" a dangerous instinct?

Because it assumes the root cause has already been fixed, which is often not verified before someone reaches for a bulk replay. If the underlying issue — a downstream outage, a bug in the consumer, bad upstream data — is still present, replaying every message reproduces the exact same failures immediately, likely compounded by any backlog that built up during triage, sometimes called a "DLQ replay storm" that can overload the very system you're trying to recover. The safer approach is replaying small batches filtered by dead-letter reason, confirming the fix actually addresses that reason first, and monitoring closely for repeat dead-lettering after each batch rather than assuming success.

### Q4. How do you decide whether a dead-lettered message is safe to replay or needs to be quarantined?

I start by reading the dead-letter reason and description, then correlate it with known state: if the reason is "max delivery count exceeded" and it correlates with a downstream outage that has since recovered, replay is usually safe once I confirm the dependency is healthy again. If the reason points to a permanent issue — a schema validation failure, a reference to data that no longer exists, a business rule that will always be violated for this payload — replaying as-is will just fail again identically, so it needs quarantine: excluded from bulk replay tooling and routed to a human or a data-fix workflow instead. The dividing line is whether the *cause* was transient (safe to retry once resolved) or intrinsic to the message itself (never safe to retry unmodified).

### Q5. Does replaying a dead-lettered message preserve its original position in the stream's ordering?

No, and this is a common oversight. By the time a message is triaged and replayed — often minutes, hours or days later — newer messages for the same entity have likely already been processed, so re-injecting the old message can apply stale data out of order, potentially overwriting a more recent, correct state. If ordering matters for that entity, the replayed write needs to be treated the same as any other out-of-order or redelivered message: guarded by a version number or timestamp check so a stale replay is a safe no-op rather than a silent regression, rather than assuming the consumer will naturally "catch up" to the right final state.

### Q6. What should a consumer set when it explicitly dead-letters a message, and why does it matter?

It should set a clear, specific dead-letter reason and a human-readable description — in Service Bus terms, `DeadLetterReason` and `DeadLetterErrorDescription` — describing exactly what failed and ideally including enough context (which validation rule failed, which downstream call errored and with what status) to triage without needing to cross-reference application logs from the time of failure. This matters because DLQ messages are often triaged well after the fact, sometimes by a different engineer than the one who wrote the original handler, and an unexplained dead-lettered message with only a generic "processing failed" reason can be nearly impossible to safely act on months later — you can't tell if it's safe to replay or needs a data fix.

### Q7. How would you design DLQ monitoring and alerting for a business-critical order-processing queue?

I'd alert on three things: absolute DLQ depth crossing a low threshold (even single-digit counts matter for a business-critical queue), the *rate of growth* to catch an active incident quickly rather than waiting for a slow trickle to cross the absolute threshold, and the age of the oldest DLQ message to catch triage neglect if depth alerts get acknowledged but not acted on. I'd also build a dashboard that breaks DLQ contents down by dead-letter reason, since a spike dominated by one reason (say, a specific downstream timeout) is a very different, more actionable signal than a diffuse mix of unrelated failures, and page differently depending on which pattern is observed.

### Q8. A DLQ has been silently growing for two weeks with nobody noticing. What does this tell you about the system's design, and what would you fix?

It tells me DLQ depth wasn't wired into active alerting — it was likely being checked manually or not at all, which is a design gap regardless of what caused the individual failures. I'd fix it in two layers: immediately, triage the backlog (group by reason, confirm which are safe to replay vs need quarantine, replay in controlled batches) to resolve the actual business impact; and structurally, add DLQ depth, growth rate and oldest-message-age alerts wired to on-call paging, plus a dashboard broken down by reason, so a two-week silent backlog like this becomes operationally impossible going forward — the next similar issue should be caught within minutes, not weeks.

### Q9. What's the difference between a message dead-lettering due to max delivery count versus TTL expiry, and does the response differ?

Max delivery count means the consumer actively attempted and failed to process the message repeatedly — the failure is almost certainly in the processing logic or a downstream dependency, so triage focuses on the exception details from those attempts. TTL expiry means the message was never even successfully picked up and completed within its allowed lifetime — this points more towards a consumer availability or throughput problem (consumers were down, or the queue was backlogged beyond the TTL window) rather than a processing logic bug. The triage differs accordingly: max-delivery-count DLQ entries need you to look at *why processing failed*, while TTL entries need you to look at *why the message wasn't consumed in time* — often a scaling, outage, or backlog problem rather than a bug in the handler itself.

### Q10. How do you build replay tooling so it doesn't become the next incident?

I'd make it operate on small, explicit batches rather than the whole DLQ at once, support filtering by dead-letter reason so unrelated failures aren't replayed together, and require an explicit confirmation step that the root cause has actually been addressed (e.g., checking the downstream dependency's current health or confirming a fix has deployed) before replaying — not just a "click to replay everything" button. It should clone messages back to the main queue (preserving or annotating the original message ID) rather than assuming resend semantics are automatic, only remove them from the DLQ after the resend is confirmed successful, and log every replay action for audit purposes. Critically, I'd build and test this tool *before* it's needed, since building replay tooling for the first time in the middle of a live incident is when mistakes like accidental bulk replay are most likely to happen.
