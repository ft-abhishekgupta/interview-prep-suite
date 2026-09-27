---
title: Idempotency and Deduplication
description: How to make message consumers safe under at-least-once delivery using natural idempotency, dedup tables and transactional writes, with a C# example
difficulty: Advanced
tags: [messaging, idempotency, deduplication, service-bus]
---

At-least-once delivery is the practical default for messaging, which means every consumer you write will eventually receive a duplicate. Idempotency is the discipline that makes that survivable, and it's one of the most reliably-asked topics for anyone claiming production messaging experience.

## Idempotent operations vs idempotent handlers

An **idempotent operation** produces the same end state no matter how many times it's applied — `SET status = 'shipped'` is idempotent, `INCREMENT stock -1` is not. An **idempotent handler** is a consumer that produces the same end state no matter how many times the *same message* is delivered, even if the underlying operation isn't naturally idempotent — it achieves this by explicitly detecting and skipping duplicates.

| | Natural idempotency | Engineered idempotency |
|---|---|---|
| Mechanism | Operation is mathematically safe to repeat | Handler tracks "have I seen this message ID" |
| Example | `UPDATE orders SET status = 'shipped' WHERE id = @id` | Dedup table + unique constraint before charging a card |
| Cost | Free — just write operations this way | Extra storage, extra write per message |
| Works for | State-setting writes | Any side effect, including non-idempotent ones like sending email |

> [!KEY]
> Prefer natural idempotency wherever the operation allows it — `SET` instead of `INCREMENT`, upsert instead of insert, "mark as paid" instead of "add to balance." It's free and needs no supporting infrastructure. Reach for engineered deduplication only for effects that can't be expressed that way.

## SET vs INCREMENT

```mermaid
flowchart LR
    M1["Message: credit $50"] --> H1["Handler A: balance += 50"]
    M1 --> H1
    H1 --> R1["Redelivered → balance += 50 again → WRONG"]
    M2["Message: balance = 500"] --> H2["Handler B: balance = 500"]
    M2 --> H2
    H2 --> R2["Redelivered → balance = 500 again → CORRECT"]
```

`INCREMENT`-style operations are the single most common source of duplicate-processing bugs: a redelivered "add 50 to balance" message silently doubles the credit. Whenever you can express the target state instead of a delta, do it — it turns the entire duplicate-handling problem into a non-issue for that write.

## Message IDs and dedup windows

Every message needs a stable identifier that survives retries — the same logical message, retried by the producer or redelivered by the broker, must carry the *same* ID. Brokers offer this natively:

| Mechanism | Scope | Window |
|---|---|---|
| Service Bus duplicate detection | Per queue/topic, based on `MessageId` | Configurable, typically minutes to a day |
| Kafka idempotent producer | Per producer session, based on sequence number | Life of the producer session |
| Application message ID + dedup table | Application-defined | As long as you retain rows — unbounded if needed |

> [!WARNING]
> Broker-level duplicate detection only catches duplicates from the **producer retrying the same send** within its detection window. It does nothing for a consumer that processes a message, crashes before acking, and receives it again later — that's a legitimate redelivery from the broker's point of view, and it can happen well outside any dedup window. Application-level deduplication is still required for consumer-side safety.

## The processed-message table

The standard pattern: a table with a unique constraint on message ID, checked (and inserted) as part of the same transaction as the business write.

```sql
CREATE TABLE processed_messages (
    message_id      UNIQUEIDENTIFIER PRIMARY KEY,
    processed_at    DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
    handler_name    NVARCHAR(200) NOT NULL
);
```

The insert into `processed_messages` and the business write (e.g., updating an `orders` row) must be **one atomic transaction**. If they're two separate transactions, a crash between them reintroduces the exact race you were trying to close — either the dedup row exists but the business effect didn't happen, or vice versa.

```csharp
public async Task HandleAsync(OrderShippedEvent evt, Guid messageId)
{
    using var tx = await _db.Database.BeginTransactionAsync();
    try
    {
        // Unique constraint on MessageId makes the second insert throw
        _db.ProcessedMessages.Add(new ProcessedMessage { MessageId = messageId });
        await _db.SaveChangesAsync(); // throws DbUpdateException on duplicate

        var order = await _db.Orders.FindAsync(evt.OrderId);
        order.Status = "Shipped"; // idempotent SET, belt-and-braces
        await _db.SaveChangesAsync();

        await tx.CommitAsync();
    }
    catch (DbUpdateException) when (IsUniqueViolation())
    {
        await tx.RollbackAsync();
        // Already processed — treat as success, just complete the message
    }
}
```

## TTL and storage growth

A dedup table grows forever unless bounded. Two common strategies:

| Strategy | Trade-off |
|---|---|
| TTL / scheduled cleanup (delete rows older than N days) | Bounded storage; duplicates arriving after the TTL are no longer caught |
| Bound TTL to the broker's max message TTL / max delivery window | Safe — a message can't be redelivered after it's expired from the broker anyway |

> [!TIP]
> Size the dedup TTL to the broker's own message retention or max delivery count window, not longer. A message that has already expired or exceeded its max delivery count from the broker can never be redelivered again, so there is no value in keeping its dedup row past that point.

## Idempotency for non-idempotent side effects

Sending an email or charging a card can't be made "idempotent" in the SQL sense — you can't `SET` a card charge. The dedup table pattern still applies, but the check must happen **before** the external call, and the external call's success must update the dedup row's state so a subsequent redelivery can distinguish "never attempted," "in flight," and "confirmed done."

| State | Meaning | Action on redelivery |
|---|---|---|
| Not present | Never attempted | Proceed with the call |
| `InProgress` | Call may or may not have reached the provider | Check with the provider (idempotency key) before retrying, or accept the small residual risk |
| `Completed` | Confirmed success | Skip — return success without calling again |

## Outbox/inbox connection

Idempotent consumption is the mirror image of the **transactional outbox** pattern on the producer side. The outbox guarantees a message is published *at least once* whenever the business transaction that created it committed; the **inbox** (this processed-message table) guarantees the consumer applies that message's effect *exactly once* despite at-least-once delivery. Together they give end-to-end exactly-once processing without a distributed transaction spanning producer, broker and consumer.

```mermaid
sequenceDiagram
    participant C as "Consumer"
    participant DB as "Database"
    participant B as "Broker"
    B->>C: deliver(msg, messageId)
    C->>DB: BEGIN TX
    C->>DB: INSERT INTO processed_messages (unique on messageId)
    alt not a duplicate
        C->>DB: apply business write
        C->>DB: COMMIT
        C->>B: complete(msg)
    else duplicate (unique violation)
        C->>DB: ROLLBACK
        C->>B: complete(msg) — already handled
    end
```

## Cheat sheet

- Prefer natural idempotency (`SET`, upsert, "mark as X") over engineered dedup wherever the write allows it.
- `INCREMENT`/delta operations are the classic duplicate-processing bug — replace with `SET` to the target value when possible.
- The dedup insert and the business write must be in the **same transaction**, or you've just moved the race condition.
- Broker-level duplicate detection covers producer retries within a window; it does not cover consumer crash-before-ack redelivery.
- For non-idempotent external calls (payments, email, SMS), track `NotStarted → InProgress → Completed` and check state before calling.
- Bound the dedup table's TTL to the broker's own retention/redelivery window — no value in keeping it longer.
- Inbox (consumer dedup) pairs with outbox (producer at-least-once publish) for end-to-end exactly-once processing without distributed transactions.

## Common mistakes

| Mistake | Fix |
|---|---|
| Checking "have I seen this message" and doing the business write in two separate transactions | Combine them into one transaction so a crash can't split them |
| Using `INCREMENT`/`+=` for a value that could be redelivered | Rewrite as an idempotent `SET` to the target state where possible |
| Assuming Service Bus duplicate detection removes the need for an inbox table | It only catches producer-side resend duplicates within its window, not consumer redelivery |
| Letting the dedup table grow unbounded | Add a TTL/cleanup job bounded to the broker's redelivery window |
| Marking an external call "done" before confirming the provider actually succeeded | Only mark `Completed` after a confirmed success response; use `InProgress` for the ambiguous window |

## Summary

Idempotency is what makes at-least-once delivery safe to build on. Prefer operations that are naturally idempotent — state-setting writes rather than deltas — and fall back to an explicit dedup (inbox) table with a unique constraint on message ID, written atomically with the business effect, for anything that can't be expressed that way. Broker-level duplicate detection is a helpful first line of defense but never a substitute for consumer-side deduplication, because it can't see a crash that happens after delivery but before acknowledgement. Pair this inbox pattern with a transactional outbox on the producer side for genuinely exactly-once processing, end to end.

## Top Interview Questions

### Q1. What is the difference between an idempotent operation and an idempotent handler?

An idempotent operation is one whose *mathematical effect* is unchanged by repetition — applying it once or a hundred times leaves the system in the same state, like `SET balance = 500`. An idempotent handler is a piece of consumer code that guarantees the same end-to-end outcome regardless of how many times the *same message* is delivered, even when the underlying operation isn't naturally idempotent — for example, "charge $50" is not idempotent on its own, but a handler that checks a dedup table before charging makes the overall handling idempotent. The distinction matters because natural idempotency is free and should always be preferred; engineered idempotency (dedup tracking) is needed only when the operation itself can't be made safe to repeat.

### Q2. Why is `INCREMENT`/`balance += amount` dangerous under at-least-once delivery, and how do you fix it?

Under at-least-once delivery, the same "credit $50" message can be delivered twice — once processed normally, then redelivered after an ack was lost or the consumer crashed before completing. If the handler does `balance += 50`, the second delivery silently applies another +50, corrupting the balance with no error raised anywhere. The fix is to make the write idempotent: either express it as a `SET` to an absolute target value if the message carries one, or — more commonly for credits — track a dedup key (e.g., transaction ID) in a ledger table with a unique constraint, and apply the increment inside the same transaction as inserting that dedup row, so a duplicate message's insert fails and the increment is skipped.

### Q3. Walk through the "processed message" / inbox table pattern in detail.

You create a table with a unique constraint on message ID (or another stable idempotency key). When a message arrives, you begin a database transaction, attempt to insert a row for that message ID, and then perform the business write — all within that one transaction. If the message ID already exists, the insert throws a uniqueness violation, you roll back, and you know it's a duplicate — you can safely acknowledge the message to the broker without reapplying the effect. The critical detail is atomicity: the insert and the business write must commit or roll back together, because if they were separate transactions, a crash between them could leave a dedup row with no business effect applied (silently losing the update) or vice versa (a possible duplicate).

### Q4. Does Azure Service Bus's duplicate detection make consumer-side deduplication unnecessary?

No. Service Bus duplicate detection compares the `MessageId` of incoming sends against a rolling detection window (configurable, e.g., 10 minutes to a day) and silently discards a second send with the same ID *at the broker*, which protects against a producer retrying a send it wasn't sure landed. It does nothing for the far more common case: the consumer receives the message, processes it, but crashes or times out before completing (acking) it — the broker correctly redelivers that message later because, from its perspective, it was never successfully consumed. That redelivery is legitimate at-least-once behavior, not a producer-side duplicate, and can occur well outside the detection window, so you still need an inbox table or equivalent on the consumer side.

### Q5. How do you handle idempotency for a side effect that can't be made idempotent, like sending an SMS or charging a credit card?

Track the operation's lifecycle explicitly rather than trying to make the call itself idempotent: before calling the external system, check a dedup store keyed by a stable idempotency key (often the message ID); if a row already shows `Completed`, skip the call entirely. If no row exists, insert one as `InProgress`, then make the call. On success, update it to `Completed`. On redelivery while a row is `InProgress`, either query the provider for the prior request's outcome (many payment gateways support this via an idempotency key you pass through, so *they* dedupe on their side too) or accept a small residual risk window if the provider offers no such lookup — that residual risk is why passing your own idempotency key to a provider that supports one is strongly preferred over relying purely on your own state tracking.

### Q6. What is the relationship between the "inbox" pattern (this topic) and the "outbox" pattern?

They solve complementary halves of the same end-to-end problem. The outbox pattern guarantees a producer publishes a message *at least once* whenever the business transaction that generated it actually committed, by writing the message to an outbox table in the same transaction as the business change and relaying it separately — this closes the gap where a message could be lost if the DB commit succeeded but the broker publish failed, or duplicated if publish succeeded but the app crashed before recording that. The inbox pattern then guarantees the consumer applies that at-least-once-delivered message's effect *exactly once*. Together, outbox (producer) plus inbox (consumer) give end-to-end exactly-once processing without needing a distributed transaction across the database and the message broker.

### Q7. Should the dedup table keep rows forever? How do you decide a retention policy?

No — unbounded growth eventually becomes a real cost and a performance drag on the uniqueness check. The safe bound is the broker's own maximum possible redelivery window: if Service Bus's max delivery count and message TTL mean a message can never be redelivered more than, say, 14 days after first receipt, then keeping dedup rows for 14 days (plus a safety margin) is sufficient — any redelivery of that specific message is provably impossible after that. A scheduled cleanup job (or a database TTL/partition-drop strategy) removing rows older than that bound keeps the table's size proportional to throughput × retention window rather than growing forever.

### Q8. A consumer is idempotent for its own database writes but also calls a third-party webhook on every message. After a crash-and-redeliver, the webhook fired twice. What went wrong, and how do you fix it?

The bug is that idempotency was applied to the database write but not to the external call — the dedup check (or the transaction boundary) only covered the DB, so on redelivery the handler re-ran from the top and re-invoked the webhook, even though the DB write was correctly skipped as a duplicate. The fix is to bring the external call inside the idempotency boundary: check the dedup/inbox state *before* calling the webhook, not just before the DB write, and only proceed with the call if the message hasn't already reached at least the "call attempted" state. If the webhook supports an idempotency key, pass the message ID so the provider itself also dedupes, giving defense in depth against this exact failure mode.

### Q9. How would you design deduplication for a consumer that reads from a Kafka topic instead of a broker queue?

The mechanics are the same — an inbox table keyed on a stable message identifier, written atomically with the business effect — but the identifier is usually the `(topic, partition, offset)` tuple or an application-level ID in the payload, since Kafka doesn't give you a broker-native completion/redelivery model the way Service Bus does. If you're also producing downstream, Kafka's transactional producer/consumer API lets you commit the consumer's offset and the produced output atomically, which handles the "did I already process this offset" question for Kafka-to-Kafka pipelines without a separate dedup table; for anything touching an external system (DB, API) outside that transaction, you still need the same inbox pattern as with any other broker.

### Q10. Your team is deduplicating using an in-memory `HashSet<Guid>` of seen message IDs inside each consumer instance. What's wrong with this in production?

It only works for a single consumer instance's lifetime and memory — it doesn't survive a restart/crash (which is exactly when duplicates are most likely, since a crash mid-processing is the classic trigger for redelivery), and it isn't shared across multiple consumer instances processing the same queue, so a message reprocessed by a *different* instance won't be caught. It also grows unbounded in memory with no persistence or TTL. The fix is a durable, shared store — a database table or distributed cache with a unique constraint or atomic check-and-set — so the dedup state survives crashes and is visible to every instance in the consumer pool, not just the one that happened to see the message first.

### Q11. How do natural idempotency and message ordering interact — can natural idempotency break if messages arrive out of order?

Yes, and this is a common blind spot. `SET status = 'shipped'` is idempotent to *repetition* of the same message, but if a later event like `SET status = 'cancelled'` is delivered before an earlier, redelivered `SET status = 'shipped'` (due to reordering or retry timing), the final state is wrong even though each individual write was "idempotent" in isolation. The fix is to make writes idempotent *and* order-aware — include a version number, sequence number or timestamp in the message and have the write be conditional, e.g., `UPDATE orders SET status = @new WHERE id = @id AND version < @incomingVersion`, so a stale or out-of-order redelivery can't overwrite a newer state.

### Q12. In an interview, how would you justify choosing engineered deduplication (an inbox table) over just trusting Service Bus's duplicate detection window for a payment system?

I'd explain that duplicate detection only protects the producer→broker hop within a bounded time window, catching accidental resends by the producer, but the failure mode that actually matters for payments is the consumer crashing or timing out after successfully charging a card but before completing the message — that's a broker→consumer redelivery, entirely outside what duplicate detection covers, and it can happen at any time, not just within a short window. For a system where a duplicate charge is a real financial and trust cost, I'd want an explicit, durable dedup record tied atomically to the charge attempt, plus passing that same key to the payment provider's own idempotency-key support as a second layer, rather than relying on a broker feature that solves a different problem.
