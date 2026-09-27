---
title: Saga and Compensation
description: How to run a business transaction across multiple services without a distributed lock, and how to undo work that cannot simply be rolled back
difficulty: Advanced
tags: [saga, compensation, orchestration, choreography, distributed-transactions]
---

A saga is how you get transaction-like behaviour across services that each own their own database, without a two-phase commit spanning all of them. Instead of one atomic commit, a saga is a sequence of local transactions, each with a defined **compensating action** to undo it if a later step fails. This is one of the most reliably asked distributed-systems topics in senior interviews because it forces you to reason about partial failure honestly.

## Why sagas exist

A single business operation — "place an order" — often touches inventory, payment, and shipping, each owned by a different service with its own database. A classic ACID transaction across all three isn't available (no shared database, and 2PC across services is operationally painful and blocks on the slowest participant). A saga instead runs each step as a **local transaction** in its own service, and if a later step fails, runs **compensating transactions** for every step that already succeeded, in reverse.

> [!KEY]
> A saga trades atomicity for availability: nothing is ever locked across services, but the system passes through *intermediate, real states* that must be designed for, not just assumed away.

## Choreography vs orchestration

| Aspect | Choreography | Orchestration |
|---|---|---|
| Control flow | Each service reacts to events and emits the next one; no central coordinator | A central orchestrator explicitly calls each step and decides what happens next |
| Coupling | Loose — services only know event contracts, not each other | Orchestrator knows about every participant; participants stay simpler |
| Visibility | Hard to see the "whole" saga — it's implicit in event flows across services | Saga state lives in one place — easy to inspect "where is order #123 right now" |
| Adding a step | Add a new subscriber to an existing event — often no changes to existing services | Must update the orchestrator's logic |
| Failure handling | Each service must know its own compensation and which event triggers it | Orchestrator drives compensations centrally, in a known order |
| Testing | Harder — must simulate the whole event chain across services | Easier — orchestrator logic can be tested in isolation with mocked participants |
| Good fit | Small number of steps, stable contracts, want maximum decoupling | Complex multi-step flows, need central visibility, need to change flow logic often |

> [!TIP]
> A strong interview answer names both, then picks one with a specific reason tied to the number of steps and how much the flow's logic changes over time — not "orchestration is just better".

## Compensating actions are not rollbacks

A database rollback undoes an *uncommitted* change atomically. A compensating action undoes the *effects* of an already-committed, already-visible transaction — and by the time you run it, the world may have moved on. Reserving inventory and then compensating by releasing it is straightforward. Refunding a payment that has already been captured is a *new, forward-moving transaction* (a refund), not an erasure of the original charge. Sending a "welcome" email cannot be compensated at all — you can only send a follow-up.

| Step | Compensating action | Why it isn't a true rollback |
|---|---|---|
| Reserve inventory | Release reservation | Straightforward, same-shape inverse |
| Capture payment | Issue a refund | A new transaction, may take days to settle, may have fees |
| Send confirmation email | Send a correction/cancellation email | Cannot un-send; can only follow up |
| Notify a partner API (webhook fired) | Send a cancellation webhook | The partner may have already acted on the first one |

> [!DANGER]
> Designing a compensation for a step assuming it behaves like a SQL `ROLLBACK` is the most common saga mistake. Ask "what does undoing this look like in the real world?" for every single step before writing code.

## Semantic locks and pending states

Because intermediate saga states are real and visible, you need to prevent other operations from acting on a resource that is "provisionally" committed but might still be compensated. A **semantic lock** is a business-level flag — `status = 'PendingPayment'` — that other operations check before proceeding, rather than a database row lock. It communicates "this is in flux" without blocking the whole table.

```mermaid
stateDiagram-v2
    [*] --> OrderCreated
    OrderCreated --> InventoryReserved
    InventoryReserved --> PaymentPending
    PaymentPending --> PaymentCaptured
    PaymentCaptured --> Confirmed
    PaymentCaptured --> [*]
    PaymentPending --> Compensating: payment failed
    InventoryReserved --> Compensating: reservation timed out
    Compensating --> Cancelled
    Cancelled --> [*]
```

## Persisting saga state and recovering after a crash

An orchestrator must persist its current step and accumulated data *before* invoking the next step, so that a crash mid-saga can resume rather than lose track. This is itself a small state machine stored durably (a `saga_state` table row per saga instance), typically including: saga ID, current step, payload/context, status, and timestamps for timeout detection.

```csharp
public class OrderSagaState
{
    public Guid SagaId { get; init; }
    public string CurrentStep { get; set; } = "Started";
    public string Status { get; set; } = "InProgress"; // InProgress, Compensating, Completed, Failed
    public string PayloadJson { get; set; } = "{}";
    public DateTime UpdatedAt { get; set; }
    public DateTime? TimeoutAt { get; set; }
}

// On recovery, load any saga still InProgress/Compensating past its expected step duration
// and either resume the next step, or trigger compensation if a timeout was exceeded.
var stuck = await db.SagaStates
    .Where(s => s.Status == "InProgress" && s.TimeoutAt < DateTime.UtcNow)
    .ToListAsync();
```

> [!WARNING]
> If saga state is only held in memory (a long-running in-process workflow), an orchestrator restart loses track of every in-flight saga. Persist state after every step transition, not just at the end.

## Timeouts and stuck sagas

Every step needs a timeout, because a saga waiting forever for a step that will never respond is worse than one that fails fast and compensates. Common policy: each step gets an expected max duration; a background sweep finds sagas past that duration in a non-terminal state and either retries the step (if idempotent) or triggers compensation.

## Isolation anomalies

Without cross-service locking, two sagas can interleave in ways that look like classic isolation violations even though each local transaction is itself ACID:

- **Dirty reads** — another process reads a "reserved" inventory count that later gets released.
- **Lost updates** — two sagas both read available stock as 5, both reserve 3, oversubscribing by 1.
- **Non-repeatable business reads** — a saga checks a discount is valid, but by the time it applies it, another saga has expired it.

Mitigations: semantic locks (pending status), reordering steps so the *least reversible* step happens last, and commutative updates (decrement rather than read-then-write) where possible.

## Testing sagas

Sagas need tests beyond the happy path: inject a failure at *each* step and assert the correct chain of compensations fires in the correct order; test a crash-and-restart mid-saga and assert recovery resumes correctly; test a timeout on a step that never responds; and test two sagas racing over the same resource to catch isolation anomalies.

## Worked example: order fulfilment saga

**Happy path:** Reserve inventory → Capture payment → Schedule shipment → Confirm order.

**Failure path 1 — payment fails:** Reserve inventory succeeds, payment capture fails → compensate by releasing the inventory reservation → mark order `Cancelled`.

**Failure path 2 — shipment scheduling fails after payment:** Reserve inventory and capture payment succeed, shipment scheduling fails (carrier API down, retried, still failing) → compensate by refunding the payment, then releasing inventory → mark order `Cancelled`, notify customer with a specific "shipping unavailable" reason rather than a generic failure.

```mermaid
sequenceDiagram
    participant Orchestrator
    participant Inventory
    participant Payment
    participant Shipping
    Orchestrator->>Inventory: reserve(orderId)
    Inventory-->>Orchestrator: reserved
    Orchestrator->>Payment: capture(orderId)
    Payment-->>Orchestrator: failed
    Orchestrator->>Inventory: release(orderId)
    Note over Orchestrator: compensation for the only completed step
    Orchestrator->>Orchestrator: mark order Cancelled
```

## Cheat sheet

- A saga replaces one distributed ACID transaction with a sequence of local transactions plus compensations.
- Choreography = event-driven, decoupled, hard to see the whole flow. Orchestration = central coordinator, easy to inspect, more coupling.
- Compensations are forward-moving business actions (refund, cancellation notice), not database rollbacks.
- Design each compensation by asking "what does undoing this look like in the real world?", not assuming symmetry.
- Semantic locks (a `Pending` status) protect intermediate, visible states from being acted on incorrectly.
- Persist saga state after every step — an in-memory-only orchestrator loses in-flight sagas on restart.
- Every step needs a timeout and a sweep to detect and compensate stuck sagas.
- Order steps so the least reversible action (payment capture, sending an external notification) happens as late as possible.
- Test failure injection at every step, crash-and-recover, and concurrent sagas racing over the same resource.

## Common mistakes

| Mistake | Fix |
|---|---|
| Treating compensation as a symmetric "undo" of the forward action | Design each compensation as its own forward-moving business operation |
| Capturing payment (or another hard-to-reverse step) early in the sequence | Order steps so the least reversible action happens last |
| Holding saga state only in memory | Persist state transitions to a durable store after every step |
| No timeout on saga steps | Add per-step timeouts and a sweep job for stuck/expired sagas |
| Ignoring isolation anomalies between concurrent sagas | Use semantic locks / pending statuses, and prefer commutative updates |
| Testing only the happy path | Inject failure at each step and test crash-recovery explicitly |

## Summary

A saga replaces a single cross-service ACID transaction with a chain of local transactions and compensating actions, trading strict atomicity for availability and service autonomy. Choreography and orchestration are the two coordination styles, each with real trade-offs around coupling and visibility. The hard part is never the happy path — it's designing compensations that behave correctly as real business operations, protecting intermediate states with semantic locks, persisting saga state so a crash doesn't strand an in-flight order, and handling timeouts, isolation anomalies, and concurrent sagas deliberately rather than by accident.

## Top Interview Questions

### Q1. What is a saga, and why can't you just use a distributed transaction instead?

A saga is a sequence of local transactions across multiple services, each with a defined compensating action, used to achieve transaction-like consistency without a single distributed ACID transaction. Distributed transactions (2PC/XA) require a coordinator, hold locks across every participant for the duration of the transaction, and block on the slowest or least available participant — which is unacceptable in most microservice architectures where services are meant to fail and scale independently. Most modern databases and brokers also don't support XA well. A saga accepts that intermediate states are real and visible, and handles failure by compensating already-completed steps rather than preventing any visibility at all.

### Q2. Compare choreography and orchestration as saga coordination styles.

Choreography has each service publish and react to events with no central coordinator — for example, `OrderCreated` triggers Inventory to reserve stock and emit `InventoryReserved`, which triggers Payment to capture funds. It's loosely coupled and easy to extend by adding a new subscriber, but the overall flow is implicit and hard to observe or debug as a single unit — "where is this saga right now" requires tracing events across several services' logs. Orchestration has a central coordinator explicitly invoke each step and decide what happens next, including compensations; this makes the flow's state and logic visible in one place and easier to test, at the cost of the orchestrator knowing about (and being coupled to) every participant. I'd pick orchestration for complex, multi-step flows needing central visibility, and choreography for a small number of steps with stable contracts.

### Q3. Why are compensating actions not the same as a database rollback?

A rollback undoes an *uncommitted* transaction atomically and invisibly — nobody outside the transaction ever saw the intermediate state. A compensating action undoes the effect of a transaction that has already committed and may already be visible to, or acted on by, the outside world. Refunding a captured payment is a new transaction (a refund), not an erasure of the charge — it may take days to settle and can incur fees. Sending a confirmation email can't be undone at all; you can only send a follow-up. Every compensation has to be designed as its own forward-moving business operation, asking "what does undoing this look like in reality", not assumed to be symmetric with the forward step.

### Q4. What is a semantic lock in the context of sagas, and why is it needed?

A semantic lock is a business-level status flag — like `PendingPayment` or `ReservationHeld` — that signals a resource is in an intermediate, potentially-to-be-compensated state, so other operations check it before acting, instead of relying on a database-level lock that would have to span services. Without it, another process could read "5 units in stock" while a saga has provisionally reserved 3 of them but not yet confirmed the order, leading to overselling if that other process also reserves against the same units. It's a deliberate design element — the field and the check-before-act logic have to be added explicitly everywhere the resource could be touched, unlike a row lock which is enforced automatically by the database.

### Q5. How does an orchestrator recover an in-flight saga after a crash?

The orchestrator must persist its saga state — current step, accumulated context, and status — to durable storage after every step transition, not just at the end, so that on restart it can query for sagas left `InProgress` or `Compensating` and resume from the last known step rather than restarting from scratch or losing track entirely. Recovery logic typically checks each stuck saga's elapsed time against a per-step timeout: if the step is idempotent and likely just didn't get a response, it retries; if the timeout has been clearly exceeded, it transitions the saga into compensation instead of retrying indefinitely. This is why saga state needs its own persistent, queryable store (a `saga_state` table), not just in-memory workflow state.

### Q6. Design compensations for an order saga: reserve inventory, capture payment, schedule shipment. What happens if shipment scheduling fails?

Working backward from the failure: shipment scheduling failing means inventory is reserved and payment has been captured, but nothing was actually shipped. The saga triggers compensations in reverse order of completed steps — first issue a refund for the captured payment (a new transaction, not an erasure), then release the inventory reservation back to available stock, then mark the order `Cancelled` with a specific reason surfaced to the customer rather than a generic failure. I would also design the step order deliberately so that payment capture — the hardest step to reverse cleanly — happens as late as possible, ideally right before or alongside the least reversible action, to minimize how often a downstream failure forces a refund at all.

### Q7. What isolation anomalies can occur in sagas, and how do you mitigate them?

Because there's no cross-service lock, concurrent sagas can interleave in ways that mirror classic database isolation problems even though each local transaction is individually ACID: a "dirty read" of a still-reserved-but-not-confirmed resource, a "lost update" where two sagas both read the same available stock count and both oversubscribe it, or a business precondition (like a valid discount code) becoming stale between when a saga checks it and when it applies it. Mitigations include semantic locks (pending statuses that block conflicting reads), preferring commutative operations like atomic decrements over read-then-write patterns, and ordering steps so the least reversible or most contention-prone resource is touched as late as possible in the saga.

### Q8. How would you test a saga implementation beyond the happy path?

I'd inject a failure at each individual step in turn and assert that the correct chain of compensations fires, in the correct reverse order, and that the saga ends in a consistent terminal state — not partially compensated. I'd test crash-and-restart mid-saga by killing the orchestrator process after persisting one step's completion but before starting the next, then verify recovery resumes (or correctly times out and compensates) rather than losing or duplicating the saga. I'd also run two sagas concurrently against the same shared resource (same inventory SKU, same discount code) to surface isolation anomalies, and explicitly test a step that never responds, verifying the timeout and stuck-saga sweep correctly triggers compensation instead of hanging forever.

### Q9. When would you choose choreography over orchestration, and what's the risk as the number of steps grows?

Choreography fits well when there are few steps, the event contracts between services are stable, and you want maximum decoupling — no service needs to know about the others, only about the events it consumes and produces, which makes it easy to add or swap participants. The risk as steps grow is that the "whole saga" only exists implicitly, scattered across each service's event handlers; debugging "why did order #123 get stuck" means tracing events through multiple services' logs with no single place that shows saga state, and adding conditional branching logic (skip a step under some condition) becomes awkward because no single component owns the decision. Past a handful of steps or any real branching logic, most teams migrate to orchestration specifically to regain that central visibility and testability.

### Q10. A saga is stuck: inventory was reserved twenty minutes ago but payment was never captured or timed out. What do you do?

First check whether the payment service actually received the request — the orchestrator's log or saga state table should show whether the "capture payment" step was invoked and whether the step has an associated timeout; if the timeout logic is missing or misconfigured, that's the root cause, and the immediate fix is to add or correct the per-step timeout so a sweep job can detect this state automatically going forward. For the stuck instance itself, I'd manually verify with the payment service whether a charge attempt exists (to avoid double-charging), then either resume the step (retry capture, if safely idempotent) or manually trigger the compensation to release the inventory reservation and mark the order cancelled, and add monitoring/alerting on saga age so a step stuck this long pages someone before a customer notices.

### Q11. Why should the least reversible step in a saga happen as late as possible?

Every step has a real-world compensation, but some are far cheaper and cleaner to reverse than others — releasing an inventory reservation is instantaneous and side-effect-free, whereas refunding a captured payment involves a real financial transaction, can incur processing fees, may take days to settle, and is visible to the customer as a second event ("charged, then refunded") rather than something invisible. By ordering steps so the hardest-to-reverse action happens last, you minimize the number of scenarios where that expensive compensation is ever triggered — most failures will occur on cheaper, earlier steps and be resolved with cheap compensations, and only a smaller fraction of failures require the costly one.

### Q12. How is a saga different from, and how does it relate to, the outbox pattern?

They solve different but complementary problems: the outbox pattern guarantees that a single service's local state change and its published event are atomic with each other, addressing the dual-write problem for one hop; a saga coordinates a *sequence* of such steps across multiple services into one overall business transaction with compensations for partial failure. In practice they compose — each step of a saga is typically itself implemented using the outbox pattern internally, so that "inventory reserved" as a saga step is reliably published as an event even if the reserving service crashes right after committing, and the saga orchestrator (or the next choreography participant) can reliably learn that the step completed and proceed or compensate accordingly.
