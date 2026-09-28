---
title: Distributed Transactions and Saga
description: How to keep multi-step business operations consistent across services without a single database transaction to rely on
difficulty: Advanced
tags: [saga, transactions, consistency, microservices]
---

A single-service `BEGIN ... COMMIT` gives you atomicity for free. The moment "place order" touches an orders service, a payments service and an inventory service, that guarantee disappears — each service has its own database, and there is no shared transaction log across them. This page covers the tools for getting consistency back without pretending you still have ACID.

## Why ACID across services is hard

Each microservice owns its own database; otherwise the services are coupled at the data layer and are not independently deployable. A single business operation that spans three services means three separate local transactions, each of which can succeed or fail independently, with network calls in between that can also fail or time out. You cannot lock rows in another team's database, and holding a distributed lock across a multi-second workflow kills throughput.

> [!KEY]
> There is no free lunch: you either pay with **coordinator blocking** (2PC), or with **application-level compensation logic** (saga). Almost everyone at scale chooses the second.

## Two-phase commit and why it doesn't scale

Two-phase commit (2PC) is the classic distributed-transaction protocol: a coordinator asks every participant to **prepare** (lock resources, vote yes/no), then tells everyone to **commit** or **abort** based on the votes.

```mermaid
sequenceDiagram
    participant Coord as "Coordinator"
    participant Ord as "Order Service"
    participant Pay as "Payment Service"
    Coord->>Ord: prepare
    Coord->>Pay: prepare
    Ord-->>Coord: vote yes (locked)
    Pay-->>Coord: vote yes (locked)
    Coord->>Ord: commit
    Coord->>Pay: commit
```

The blocking problem: once a participant votes "yes", it holds its locks until it hears back from the coordinator. If the coordinator crashes after collecting votes but before sending the decision, every participant sits **blocked, holding locks, indefinitely** — nobody else can act unilaterally because they don't know if the others committed. This is the textbook reason 2PC is avoided at internet scale: it turns a network partition into a full outage of the resources involved, and the coordinator itself is a single point of failure.

Three-phase commit (3PC) adds a "pre-commit" phase so participants can time out and safely abort without blocking forever, under the assumption of no network partitions — but that assumption is exactly what distributed systems can't make, so 3PC sees little real-world use.

> [!WARNING]
> "Just use 2PC" is the wrong answer for anything with real traffic or cross-team databases. It is still fine **within** a single database engine (e.g. a distributed SQL engine doing internal 2PC across shards) — the problem is 2PC **across independently-operated services**.

## The saga pattern

A saga replaces one distributed transaction with a **sequence of local transactions**, each committing immediately, plus a **compensating transaction** for each step that can undo its effect if a later step fails.

| | Choreography | Orchestration |
|---|---|---|
| How it works | Each service publishes an event; the next service reacts | A central orchestrator calls each step and tracks state |
| Coupling | Low — services only know event names | Higher — orchestrator knows the whole flow |
| Visibility | Hard to see the end-to-end flow | Explicit, easy to visualize and audit |
| Adding a step | Touches every service that cares about the new event | Change the orchestrator only |
| Failure handling | Each service must know its own compensation trigger | Orchestrator drives compensations centrally |
| Good fit | 2–3 steps, simple flows | Long, complex, or frequently-changing workflows |
| Tooling | Kafka / Event Hubs + event handlers | Temporal, AWS Step Functions, Azure Durable Functions |

```mermaid
sequenceDiagram
    participant O as "Orchestrator"
    participant Ord as "Order"
    participant Pay as "Payment"
    participant Inv as "Inventory"
    O->>Ord: create order
    Ord-->>O: ok
    O->>Pay: charge card
    Pay-->>O: failed
    O->>Ord: compensate: cancel order
    Ord-->>O: cancelled
```

> [!TIP]
> A senior answer names the trade-off directly: *"Choreography keeps services decoupled but the overall flow lives nowhere — I'd only use it for 2–3 step sagas. Past that, I want an orchestrator like Temporal so retries, timeouts and state are explicit and I can see the whole workflow in one place."*

### Compensating transactions

A compensation is a **semantic undo**, not a rollback — you cannot un-send an email, so you send a follow-up. Compensations must be **idempotent** (the orchestrator may retry them) and ideally **commutative** with the forward action so ordering quirks don't corrupt state.

| Forward action | Compensation |
|---|---|
| Reserve inventory | Release reservation |
| Charge card | Refund |
| Send confirmation email | Send cancellation email |
| Book a seat | Release the seat |

### Semantic locks and isolation anomalies

Because each local transaction commits immediately, other requests can observe **intermediate, not-yet-confirmed state** — an order sitting in "PENDING_PAYMENT" that a different query might read as a real order. This is the saga's version of the isolation anomalies ACID normally hides from you:

- **Lost update** — two sagas modify the same entity concurrently and one overwrites the other's change.
- **Dirty read** — a step reads data written by a saga that later aborts and compensates.
- **Fuzzy/non-repeatable read** — a step re-reads an entity mid-saga and sees it change.

The common fix is a **semantic lock**: mark the entity itself as "being processed" (a status column, not a database lock) so other transactions know to wait, retry, or route around it. An order in `PENDING` status is invisible to "my orders" listings until it reaches `CONFIRMED`.

> [!DANGER]
> Forgetting that saga steps are individually visible is the most common saga bug in interviews and in production: someone queries "confirmed orders" and gets one that is mid-compensation. Always give in-flight sagas an explicit status the rest of the system can filter on.

## The outbox pattern: atomicity between DB and message

Sagas are driven by events, which raises the classic **dual-write problem**: you cannot atomically commit a database row *and* publish a message to a broker — one can succeed while the other fails.

```mermaid
flowchart LR
    API["Order Service"] -->|"single DB txn"| DB[("orders + outbox table")]
    DB -->|"CDC / polling relay"| REL["Relay"]
    REL --> BUS[["Message Broker"]]
    BUS --> NEXT["Payment Service"]
```

The fix: write the business row and an `outbox` row **in the same local transaction**. A separate relay process (polling the outbox table, or a change-data-capture stream) reads unsent rows and publishes them, marking them sent. Because the outbox row and the business change commit together or not at all, the message is guaranteed to eventually be published if the transaction committed — at-least-once, so consumers must still be idempotent.

## TCC — Try-Confirm/Cancel

TCC is saga's stricter cousin, used when you need to **hold resources before confirming**. Each participant exposes three operations instead of one:

- **Try** — tentatively reserve the resource (hold funds, hold inventory) without committing the business effect.
- **Confirm** — make the reservation permanent, called once every participant's Try succeeded.
- **Cancel** — release the reservation, called if any Try failed.

This avoids the "already spent the money before we know the order will succeed" problem that a plain saga has, at the cost of every participant implementing three coordinated APIs instead of one. It's common in payments and travel booking (hold a seat, then confirm or release).

## When to just keep it in one database

The saga pattern is a tool for when service boundaries force it — it is not free complexity to add for its own sake.

> [!KEY]
> If the data belongs to one bounded context and there's no organizational reason to split it, **keep it in one database and use a real ACID transaction**. Sagas exist to solve a problem created by splitting services; don't create that problem prematurely.

Signs you should reach for a saga: the steps genuinely span independently-deployed services owned by different teams, or a step is inherently long-running (waiting on a third-party payment gateway, a human approval). Signs you shouldn't: you're about to split a single well-understood domain into services just to "be microservices" — merge them and keep the transaction.

## Cheat sheet

- **2PC blocks on coordinator failure** — locks held indefinitely; avoid across independently-operated services.
- **Saga = sequence of local transactions + compensations**, no distributed lock.
- **Choreography** for 2–3 steps and loose coupling; **orchestration** (Temporal/Step Functions/Durable Functions) once the flow is non-trivial or changes often.
- **Compensations are semantic undos** — must be idempotent, ideally commutative.
- **Sagas expose intermediate state** — use a status field as a semantic lock so readers don't see half-finished work as final.
- **Outbox pattern** solves the DB-plus-message dual-write problem — write both in one local transaction.
- **TCC** when you must reserve before confirming (payments, seat holds).
- **Don't saga what you don't have to** — one database, one transaction, is simpler and correct when the data has one true owner.

## Common mistakes

| Mistake | Fix |
|---|---|
| Reaching for 2PC across services "for strong consistency" | Use a saga; 2PC's blocking failure mode is worse than eventual consistency |
| Treating compensations as a database rollback | Write them as real business operations (refund, cancel, release) |
| Making compensations non-idempotent | The orchestrator will retry them on ambiguous failures — dedupe/guard against double-compensation |
| Letting other services read mid-saga state as final | Add a status column and filter on it |
| Publishing an event after commit as a second, unguarded write | Use the outbox pattern instead |
| Choosing choreography for a 6-step workflow with branching | Switch to orchestration once you can't see the whole flow in your head |

## Summary

Distributed transactions across services trade the clean guarantees of ACID for explicit engineering: 2PC keeps atomicity but blocks on failure, so most systems use sagas instead — chains of local transactions with compensating actions, coordinated by choreography or a central orchestrator. The outbox pattern closes the gap between committing to a database and publishing an event, and TCC adds a reservation phase where a saga's "already happened" side effects are too costly to compensate. The most senior move is often the simplest: don't split the transaction across services unless the service boundary already forces it.

## Top Interview Questions

### Q1. What problem does the saga pattern solve, and how is it different from a database transaction?

A database transaction gives you atomicity, consistency, isolation and durability for changes within one database. A saga solves the same *business* problem — "all these steps should happen, or none should" — when the steps span multiple services, each with its own database, so no shared transaction is possible. Instead of one atomic commit, a saga runs a sequence of local transactions, each committing immediately, and defines a compensating transaction for every step so that if a later step fails, earlier steps can be semantically undone. Crucially, a saga gives you eventual consistency, not isolation — other parts of the system can observe intermediate states while the saga is in flight.

### Q2. Explain two-phase commit and why it's rarely used across microservices.

2PC has a coordinator ask every participant to **prepare** (lock the resource and vote yes/no), then, once all votes are in, tell everyone to **commit** or **abort**. The failure mode that kills it in practice: if the coordinator crashes after participants have voted yes but before it sends the final decision, every participant is stuck holding its locks — it cannot safely commit or abort on its own because it doesn't know what the others will do. That blocking window can be arbitrarily long, and during it the locked resources are unusable. Across independently-deployed, independently-owned services, that blast radius is unacceptable, so almost everyone chooses sagas (compensation) over 2PC (blocking) at that scale.

### Q3. Compare choreography and orchestration. Which would you pick for a checkout flow with 6 steps?

Choreography has each service publish events and react to others' events, with no central coordinator — it keeps services decoupled but means the overall flow is implicit, scattered across handlers, and hard to change or audit. Orchestration has a central component (Temporal, Step Functions, Durable Functions) explicitly calling each step, tracking state, and driving compensations. For a 6-step checkout flow — reserve inventory, charge payment, allocate shipping, apply loyalty points, send confirmation, update recommendations — I'd choose orchestration. Once you have more than 2-3 steps or need visibility into "where is this order stuck," an explicit orchestrator that persists state and retries is much easier to operate and debug than events scattered across six services.

### Q4. What is a compensating transaction, and what properties must it have?

A compensating transaction is the semantic inverse of a forward step in a saga — not a database rollback, but a new operation that undoes the business effect (refund a charge, release a reservation, send a cancellation email). It must be **idempotent**, because the orchestrator may call it more than once after a timeout or crash-retry, and ideally **commutative** with other operations so that out-of-order execution doesn't corrupt state. It should also be designed assuming it can itself fail and need its own retry — a common production pattern is to log the compensation attempt and alert a human if it fails repeatedly (e.g. a refund that the payment gateway rejects).

### Q5. How do you handle the fact that other services can see a saga's intermediate state?

This is the isolation anomaly unique to sagas: because each step commits locally and immediately, an order can be visible in "PENDING_PAYMENT" status to a concurrent read before the saga finishes or compensates. The standard fix is a **semantic lock** — an explicit status field on the entity (`PENDING`, `CONFIRMED`, `CANCELLED`) that the rest of the system is required to filter on. Read paths that shouldn't see in-flight orders query `WHERE status = 'CONFIRMED'`. For stricter needs, you can also version the entity and expose only the last-confirmed version to readers, hiding the saga's working state entirely.

### Q6. What is the outbox pattern and what specific problem does it solve?

It solves the dual-write problem: you cannot atomically write a row to your database and publish a message to a broker as one operation, because they are two different systems with two different failure modes — the DB write can succeed while the publish fails (message lost) or vice versa (message published for data that never committed). The outbox pattern writes the business row **and** a row in an `outbox` table in the same local database transaction. A separate relay (polling the table or tailing a change-data-capture stream) reads unpublished outbox rows and sends them to the broker, marking them sent. Because the outbox row shares the transaction boundary with the business write, publishing becomes at-least-once but never "the DB committed and the event vanished."

### Q7. What is TCC and when would you use it instead of a plain saga?

Try-Confirm/Cancel splits each participant's operation into three phases: **Try** tentatively reserves a resource (hold funds on a card, hold a seat) without making the business effect final; **Confirm** commits it once every participant's Try succeeded; **Cancel** releases the reservation if any Try failed. Use it when a plain saga's compensation would be awkward or costly — e.g. you don't want to actually charge a card and then refund it if a later step fails; you'd rather place an authorization hold and only capture it once everything else has succeeded. The cost is that every participant must implement three coordinated endpoints instead of one, which is more work than a simple compensating-action saga.

### Q8. What isolation anomalies are specific to sagas, and how do they differ from classic ACID anomalies?

Because saga steps commit locally and immediately instead of behind one lock, other transactions can observe work that later gets undone. The three to name: **dirty reads**, where a step reads data written by a saga that later aborts and compensates; **lost updates**, where two sagas concurrently modify the same entity and one silently overwrites the other's change; and **non-repeatable/fuzzy reads**, where re-reading an entity mid-saga returns different values as the saga progresses. Classic ACID anomalies are prevented by the database's isolation level automatically; saga anomalies must be prevented explicitly, usually with a semantic lock (a status field marking the entity "in flight") plus careful ordering of steps so the riskiest, hardest-to-compensate actions happen last.

### Q9. Debugging scenario: a saga's compensation for "release inventory" ran twice and oversold the same SKU. What happened and how do you fix it?

Two likely causes: the orchestrator retried the compensation after a timeout (thinking it failed when it actually succeeded but the ack was lost), or two independent triggers (a timeout compensation and a manual retry) both fired. The fix is to make "release inventory" idempotent — key it by the saga/step instance ID, and have the inventory service check "has this reservation already been released?" before incrementing stock back. In general, every saga step and compensation should be tagged with an idempotency key derived from the saga instance, and the receiving service should store processed keys (or check current state) rather than blindly applying the operation.

### Q10. When would you avoid the saga pattern entirely and just use one database transaction?

When the data genuinely belongs to a single bounded context — no other team or service has a legitimate reason to own part of it — splitting it across services just to "do microservices" creates the distributed-transaction problem needlessly. In that case, one database and a real ACID transaction is simpler, faster, and easier to reason about than any saga. I'd also avoid a saga for anything requiring hard, immediate consistency across the whole operation with no acceptable intermediate state — e.g. a single ledger posting that must be atomic — and instead keep those entities co-located, even if it means a service boundary is slightly less "pure."

### Q11. How would you monitor and operate sagas in production?

Persist saga state explicitly (current step, status, retry count, timestamps) so you can query "which sagas are stuck in step 3 for more than 10 minutes" — this is the single most useful production view. Alert on sagas stuck beyond an expected duration, on compensation failures (these need a human, since automatic retries have already been exhausted), and on a rising rate of saga aborts versus completions as a leading indicator of a downstream problem. Tools like Temporal give you this via built-in workflow history and visibility APIs; if choreographing your own events, you'd build an equivalent saga-log table and a dashboard on top of it.

### Q12. Why doesn't three-phase commit see much real-world use despite solving 2PC's blocking problem?

3PC adds a "pre-commit" phase so participants know the coordinator's intended decision before it's finalized, letting them safely time out and proceed independently — but only under the assumption that the network never partitions during that window. Distributed systems exist precisely because that assumption fails in practice; a network partition during 3PC's extra phase can still leave participants in an inconsistent state, or worse, some assume commit while others assume abort. Given it adds an extra network round trip and latency but only removes blocking under an assumption you can't rely on, most systems skip straight to sagas, which sidestep synchronous coordination entirely.
