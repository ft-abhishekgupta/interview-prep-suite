---
title: Event Driven Architecture and CQRS
description: How events, CQRS and event sourcing separate reads from writes, and when that separation is worth the extra moving parts
difficulty: Advanced
tags: [event-driven, cqrs, event-sourcing, cdc]
---

Event-driven architecture and CQRS both start from the same observation: reads and writes have wildly different shapes and scaling needs, and forcing them through the same model is often what makes a system slow or rigid. This page covers the event vocabulary, CQRS, event sourcing, and the plumbing (CDC, outbox) that keeps it all consistent without dual writes.

## Asynchronous processing: the simplest event-driven pattern

Before CQRS or event sourcing enter the picture, most systems already lean on a simpler version of the same idea: handing work to a queue and letting a separate worker process it later, instead of making the caller wait for it to finish.

![alt text](notes/05-HighLevelDesign/AsyncSystems/image-5.png){width=500}

This decouples the producer from the consumer, and the payoff is the same one that motivates event-driven architecture generally: the caller gets a fast response, a failure in the worker doesn't take the caller down with it, and workers scale independently of whatever produces the work. An image upload pipeline is the canonical example — the upload call returns immediately once the file is queued, and a pool of workers pulls from that queue to generate thumbnails, run a virus scan, and transcode formats, each at its own pace.

![alt text](notes/05-HighLevelDesign/AsyncSystems/image-4.png){width=500}

Work handed off this way comes in a few different shapes, and naming which one you're building matters because it changes how the consumer is written: **one-off** (a single task processed once, like sending a confirmation email), **recurring** (a scheduled job that runs on a timer, like a nightly report), **chained** (a sequence of dependent steps, like transcode → thumbnail → notify), and **batch** (many similar items grouped together for efficiency, like a bulk export).

This simplest case — one producer, one consumer type, no replay, no independent read model — is the floor of event-driven architecture. CQRS and event sourcing are what you reach for once those trade-offs stop being enough: once multiple independent systems need to react to the same fact, or the fact needs to be replayed as history rather than processed once and discarded.

## Events vs commands vs queries

| | Command | Query | Event |
|---|---|---|---|
| Intent | "Do this" | "Tell me this" | "This happened" |
| Direction | One recipient, targeted | One recipient, targeted | Broadcast, zero or many listeners |
| Can be rejected? | Yes — validation can fail | N/A (read-only) | No — it already happened, it's a fact |
| Example | `PlaceOrder` | `GetOrderStatus` | `OrderPlaced` |
| Naming convention | Imperative, present tense | Imperative, present tense | Past tense |

> [!KEY]
> The past-tense naming convention is not a style nicety — it enforces the right mental model. An event is an immutable historical fact; you can react to it, but you cannot reject or undo it after the fact (only compensate, as in a saga).

## Event notification vs event-carried state transfer vs event sourcing

These three patterns all use "events," but they carry very different amounts of information and create very different coupling.

| Pattern | What the event contains | Consumer must call back for more data? | Coupling |
|---|---|---|---|
| **Event notification** | Just an ID and event type ("Order 123 was updated") | Yes — consumer calls the source service's API for details | Consumer depends on the source service being available |
| **Event-carried state transfer** | The full relevant data payload ("Order 123 updated: here are all the new fields") | No — everything needed is in the event | Consumer is decoupled from the source at read time, but depends on a stable event schema |
| **Event sourcing** | The event *is* the only record — there is no separate "current state" table, state is derived by replaying events | N/A — the event log is the source of truth itself | Deepest commitment — the whole system's history is these events |

```mermaid
flowchart LR
    subgraph "Event-carried state transfer"
        P["Order Service"] -->|"OrderUpdated<br/>{full order payload}"| B[["Event Bus"]]
        B --> C1["Search Index"]
        B --> C2["Analytics"]
    end
```

> [!TIP]
> Event-carried state transfer is the most common practical choice: it avoids the "call back to the source for details" round trip of event notification (which reintroduces synchronous coupling) without committing to full event sourcing's much bigger architectural shift.

Choreographed end to end, the API server's only job is to append the order to the event store. Independent worker pools subscribe to the topics they care about and publish their own events back, so adding an email worker or a shipping worker requires no change to the write path.

![Choreographed order flow where an API server writes to an event store with order, payment, inventory and shipping topics consumed by independent worker pools](notes/05-HighLevelDesign/DistributedSystems/image-1.png)

> [!WARNING]
> Choreography like this is easy to extend and hard to debug. With no central coordinator, "where did order 123 get stuck?" can only be answered from correlation IDs and distributed traces. Add them before you need them, not after the first incident.

## CQRS: separate read and write models

CQRS (Command Query Responsibility Segregation) splits the model used to **write** data from the model used to **read** it — instead of one entity class/table serving both a normalized write path and a denormalized, query-optimized read path.

```mermaid
flowchart LR
    C["Client"] -->|"command"| W["Write model<br/>(normalized, transactional)"]
    W -->|"events"| PROJ["Projector"]
    PROJ --> R1["Read model 1<br/>(denormalized for search)"]
    PROJ --> R2["Read model 2<br/>(denormalized for dashboard)"]
    C -->|"query"| R1
    C -->|"query"| R2
```

The write side stays normalized and enforces business rules and invariants (e.g. "an order can't ship before payment clears"). The read side is one or more **projections** — denormalized, pre-joined, often duplicated tables shaped exactly for a specific query pattern (a search index, a dashboard aggregate, a per-user feed) — updated asynchronously as write-side events occur. This lets you scale reads and writes independently, and optimize each for its own access pattern instead of compromising on one shared schema.

> [!WARNING]
> CQRS does not require event sourcing, and most CQRS systems in production are not event-sourced — the write model can be a perfectly ordinary relational database; CQRS is only about **separating the model**, not about how the write side stores its state.

### Projection lag and eventual consistency in the UI

Because projections update asynchronously, there's a window — usually milliseconds, sometimes longer under load — where the read model hasn't caught up with the latest write. This is the most common CQRS gotcha in production: a user submits a change, the UI immediately re-queries the read model, and the change isn't there yet.

| Mitigation | How |
|---|---|
| **Read-your-own-writes** | After a write, route that user's subsequent reads to the write model (or a synchronously-updated cache) for a short window |
| **Optimistic UI update** | Update the UI immediately from the command's known result, don't wait for the projection to round-trip |
| **Show a "processing" state** | Explicitly tell the user the change is being applied, rather than silently showing stale data |
| **Expose projection lag as a metric** | Alert if lag exceeds a threshold — treat it like any other SLO |

> [!DANGER]
> Silently showing stale read-model data right after a user's own write — with no acknowledgement that a delay is happening — is what makes CQRS feel "buggy" to users. The fix is virtually always in the UX layer, not by trying to make projections synchronous (which defeats the purpose).

## Event sourcing: append-only log, replay, snapshots

Event sourcing takes CQRS's read/write split further: instead of storing current state directly, you store the full sequence of events that led to that state, and **derive** current state by replaying them.

```mermaid
flowchart LR
    E1["AccountOpened"] --> E2["Deposited $100"]
    E2 --> E3["Withdrew $30"]
    E3 --> E4["Deposited $50"]
    E4 --> STATE["Current balance = $120<br/>(folded from events)"]
```

- **Append-only log**: events are never updated or deleted, only appended — giving a complete, immutable audit trail for free.
- **Replay**: to get current state, fold over all events for that entity (`balance = events.stream().reduce(0, (acc, e) -> e.apply(acc), Integer::sum)`); to get state *as of* a past point, replay only up to that point — auditing and "what did this look like last Tuesday" come essentially free.
- **Snapshots**: replaying years of events on every read is slow, so periodically persist a snapshot of the folded state, and replay only the events since the last snapshot.
- **Versioning**: event schemas change over time; a common approach is upcasting — a transformation step that converts an old event version to the current shape when it's read, so old events remain replayable without a destructive migration.

```java
// A simplified fold over events to derive current state
public Account replay(List<Event> events) {
    Account account = new Account();
    for (Event e : events) {
        if (e instanceof AccountOpened ev) {
            account = account.open(ev);
        } else if (e instanceof Deposited ev) {
            account = account.deposit(ev.amount());
        } else if (e instanceof Withdrawn ev) {
            account = account.withdraw(ev.amount());
        }
    }
    return account;
}
```

### When event sourcing is overkill

> [!KEY]
> Event sourcing is a significant architectural commitment — it changes how every piece of state in that bounded context is stored and read, forever. Reach for it only when you specifically need the audit trail, the replay/what-if capability, or true temporal queries as a first-class product requirement — not because "events sound more scalable."

It's a strong fit for domains where history itself is the product: financial ledgers, inventory movement audits, anything with regulatory replay requirements. It's overkill for a typical CRUD entity where nobody will ever ask "what did this record look like on any given past date" — for those, plain CQRS (or no CQRS at all) with an ordinary current-state table is simpler, faster to build, and easier for a new engineer to reason about.

## Materialised views and change data capture

A **materialized view** is a precomputed, stored result of an expensive query (a join, an aggregation) that's refreshed as underlying data changes, instead of recomputed on every read — this is exactly what a CQRS read-side projection is, generalized beyond event-driven systems. **Change data capture (CDC)** is the mechanism that often feeds these views without dual writes: instead of the application explicitly publishing an event after every write, CDC tails the database's own transaction/write-ahead log and turns each committed row change into an event automatically (Debezium for most relational databases, native change feeds in Cosmos DB/DynamoDB).

```mermaid
flowchart LR
    APP["App writes normally"] --> DB[("Database")]
    DB -->|"tail the WAL/oplog"| CDC["CDC connector<br/>(e.g. Debezium)"]
    CDC --> BUS[["Event stream"]]
    BUS --> IDX["Search index"]
    BUS --> CACHE["Cache"]
```

CDC's advantage: the application code doesn't need to remember to publish an event on every write path — it's derived automatically from what actually committed, which also sidesteps the dual-write problem entirely, since there's only one write (to the database) and the event is a faithful downstream reflection of it.

## The dual-write problem and outbox

Whenever a service must update its own database **and** notify another system (a queue, a search index, another service) as two separate operations, there's a window where one succeeds and the other fails — this is the dual-write problem, and it applies directly to event-driven architectures: publishing an event is exactly this second write.

| Approach | How it avoids dual writes |
|---|---|
| **CDC** | There's only one write (the DB); the event is derived from the committed log afterward |
| **Outbox pattern** | Write the business row and an outbox row in the same local transaction; a relay publishes from the outbox afterward |
| **Naive "write then publish"** | Doesn't avoid it — this *is* the dual-write problem |

The outbox pattern (detailed further on the sagas page) is the standard fix when CDC isn't available or practical: commit the domain change and a record of "an event needs to be published" in one atomic local transaction, then let a separate relay process handle the actual publish, retrying until it succeeds — guaranteeing the event is eventually published if and only if the transaction committed.

## Cheat sheet

- **A background task queue is the simplest event-driven pattern** — decouple producer from consumer before reaching for CQRS or event sourcing.
- **Commands can be rejected, queries read, events are past-tense immutable facts** that already happened.
- **Event-carried state transfer** (payload in the event) is the common default; **event notification** (ID only) reintroduces a synchronous callback; **event sourcing** makes the log itself the source of truth.
- **CQRS separates the write model from one or more read projections** — it does not require event sourcing.
- **Projection lag is real** — handle it explicitly in the UX (read-your-own-writes, optimistic updates, "processing" state), don't pretend projections are synchronous.
- **Event sourcing = append-only log + replay + snapshots (for speed) + upcasting (for schema evolution).**
- **Reach for event sourcing only when audit/replay/temporal queries are a real product requirement.**
- **Materialized views are CQRS read projections, generalized** — often refreshed via CDC instead of application-level events.
- **CDC sidesteps the dual-write problem entirely**; the outbox pattern is the fix when you're publishing events explicitly from application code.

## Common mistakes

| Mistake | Fix |
|---|---|
| Naming events in the imperative ("CreateOrder") instead of past tense | Use past tense ("OrderCreated") to reinforce that it's an immutable fact |
| Assuming CQRS requires event sourcing | CQRS is just read/write model separation; the write side can be a plain relational DB |
| Silently showing stale read-model data right after a user's own write | Add read-your-own-writes routing, optimistic UI updates, or an explicit "processing" state |
| Adopting event sourcing for a plain CRUD entity nobody needs history for | Use ordinary CQRS or no CQRS at all; reserve event sourcing for real audit/replay needs |
| Publishing events by writing to the DB then separately calling the message broker | Use the outbox pattern or CDC to avoid the dual-write problem |
| Replaying the full event history on every read in an event-sourced system | Add periodic snapshots and replay only events since the last snapshot |

## Summary

Event-driven architecture and CQRS both come from recognizing that a single shared model for writing and reading data is often the wrong compromise — events (immutable, past-tense facts) let services react to changes without synchronous coupling, and CQRS lets the read side be shaped exactly for its query patterns instead of inheriting the write side's normalized structure. Event sourcing pushes this further by making the event log itself the source of truth, which is powerful for audit and replay but a real architectural commitment, not a default choice. The practical plumbing — CDC to avoid remembering to publish events, the outbox pattern when you do publish explicitly, and deliberate UX handling of projection lag — is what keeps this consistent without silently losing data or confusing users with stale reads.

## Top Interview Questions

### Q1. What is the difference between a command, a query, and an event?

A command is an instruction to do something — it targets a specific handler, and can be rejected if validation or business rules fail (e.g. `PlaceOrder` might fail if the cart is empty). A query asks for information without changing state and also targets a specific handler. An event is a statement of fact that something has already happened — it's broadcast to zero or more interested listeners, and by definition cannot be rejected, because it already occurred; you can only react to it or, in a saga, compensate for its downstream effects. The naming convention reflects this: commands and queries are imperative ("PlaceOrder," "GetOrderStatus"), events are past tense ("OrderPlaced") — a useful discipline because it's a constant reminder that events are immutable history, not requests.

### Q2. Compare event notification, event-carried state transfer, and event sourcing.

Event notification sends a minimal event (just an ID and type, like "Order 123 changed") and requires the consumer to call back to the source service's API to get the actual details — simple to implement, but it reintroduces synchronous coupling to the source service at read time. Event-carried state transfer includes the full relevant payload in the event itself, so consumers never need to call back — this decouples consumers from the source's availability, at the cost of needing a stable, versioned event schema. Event sourcing is a much deeper commitment: there's no separate "current state" table at all — the sequence of events *is* the stored truth, and current state is derived by replaying them. Most systems use event-carried state transfer as the pragmatic default; event sourcing is reserved for domains that specifically need a full audit/replay history.

### Q3. What is CQRS, and does it require event sourcing?

CQRS (Command Query Responsibility Segregation) separates the model used for writes from the model(s) used for reads — instead of one shared schema serving both a normalized, invariant-enforcing write path and a denormalized, query-optimized read path, you maintain a write model and one or more independently-shaped read projections, kept in sync asynchronously (often via events). It does not require event sourcing — the write side can be an entirely conventional relational database with normal tables and transactions; CQRS is purely about splitting the read and write *models*, not about how the write side internally represents its state. Event sourcing is a separate, optional, and much bigger decision about making the event log itself the source of truth, which pairs naturally with CQRS but is not a prerequisite for it.

### Q4. What is projection lag, and how would you handle it from a UX perspective?

Projection lag is the delay between a write committing on the write side and the corresponding read-model projection being updated to reflect it — because projections update asynchronously (often via an event bus), there's always some window, from milliseconds to longer under load, where a read immediately following a write can return stale data. The main UX mitigations: read-your-own-writes (route the writing user's subsequent reads to the write model or a synchronously updated cache for a short window so they see their own change immediately), optimistic UI updates (update the UI directly from the command's known outcome instead of waiting for a re-query), and an explicit "processing"/"saving" state so the delay is visible and expected rather than silently showing stale data. I'd also expose projection lag itself as a monitored metric with an SLO, since a growing lag is a real operational signal, not just a UX nuisance.

### Q5. Explain how event sourcing derives current state, and why snapshots are needed.

In event sourcing, nothing is stored as "current state" directly — instead, every state change is appended as an immutable event to a log (e.g. `AccountOpened`, `Deposited $100`, `Withdrew $30`), and current state is computed by replaying (folding over) all events for that entity from the beginning, applying each one's effect in order. This makes an audit trail and "what did this look like at any past point" essentially free — you just stop replaying at that point. The problem is that replaying potentially years of events on every single read becomes slow as the log grows, so systems periodically persist a **snapshot** — the folded state as of a specific point — and on a later read, only replay events that occurred after the most recent snapshot, dramatically reducing the amount of replay needed while keeping the same guarantees.

### Q6. When would event sourcing be overkill, and what would you use instead?

Event sourcing is a significant, largely irreversible architectural commitment for a bounded context — every piece of state in it is now stored as a log of events, forever, which adds real complexity (schema versioning/upcasting, snapshotting, more complex debugging since state isn't directly visible in a table). It's overkill for a typical CRUD entity where nobody actually needs a full history — a user's profile settings, a product catalog entry — where the product requirement is just "store and update the current value," not "replay what this looked like on any past date" or "provide a full regulatory audit trail." For those cases, plain CQRS with an ordinary current-state read/write model (or no CQRS at all, just a normal database) is simpler to build, easier to reason about, and faster to onboard new engineers onto.

### Q7. What is change data capture (CDC), and how does it avoid the dual-write problem?

CDC works by tailing a database's own transaction log (write-ahead log, oplog) and converting each committed row change into an event automatically — tools like Debezium do this for most relational databases, and some databases (Cosmos DB, DynamoDB) expose a native change feed for the same purpose. This sidesteps the dual-write problem entirely because there's fundamentally only **one** write happening — the application writes to its database as normal, with no code path that also has to remember to publish an event — and the event stream is a faithful, automatically-derived reflection of whatever actually committed. Compare this to an application explicitly writing to its database and then separately calling a message broker: that's two writes, and if the second one fails after the first succeeds (or vice versa), the event and the database silently disagree.

### Q8. What is the outbox pattern, and when would you use it instead of CDC?

The outbox pattern has the application write its business row and a corresponding "event to publish" row into an `outbox` table, both within the same local database transaction — guaranteeing they either both commit or neither does. A separate relay process then reads unpublished outbox rows and sends them to the message broker, marking them as sent once successful, giving at-least-once delivery without ever risking a lost or phantom event. You'd reach for outbox instead of CDC when CDC isn't available or practical for your database, when you need more control over exactly what event payload is published (rather than a raw row-change diff), or when the event needs to represent a higher-level business concept than a single row change (e.g. one event summarizing changes across several tables in one transaction).

### Q9. Scenario: after switching to CQRS, users complain that after saving a profile change, the profile page sometimes still shows the old value on refresh. What's happening and how do you fix it?

This is projection lag made visible: the write committed successfully to the write model, but the read-model projection that the profile page queries hasn't caught up yet when the page refreshes and re-queries. Since it's intermittent, it's likely happening under moderate load or when the projector has a small but real processing delay — the write and the subsequent read are racing. The fix is not to try to make the projection synchronous (that defeats the purpose of CQRS); instead, route the specific user's read immediately after their own write to the write model (or a cache updated synchronously with the write) for a short window — a "read-your-own-writes" policy — while leaving all other reads (other users viewing this profile) served from the eventually-consistent projection as before.

### Q10. How would you evolve an event schema in an event-sourced system without breaking replay of old events?

Old events in an append-only log are never rewritten, so the read/replay path must be able to interpret every version of an event's schema that has ever existed, even after the shape changes going forward. The standard technique is upcasting: when an old-version event is read for replay, a transformation step converts it into the current schema shape (filling in defaults for new fields, restructuring renamed ones) before it's folded into state, so the aggregation logic only ever has to handle the latest schema version. This means schema changes should be additive and versioned explicitly (an event carries a version number), and any genuinely breaking change needs an upcaster written and tested against real historical events — you can't just "migrate the data" the way you would with a mutable table, since the events themselves are immutable history.

### Q11. How is a materialized view related to a CQRS read projection?

They're the same underlying idea, generalized: a materialized view is a precomputed, stored result of a potentially expensive query — a join, an aggregation, a denormalization — that's refreshed as the underlying data changes, so reads don't pay the cost of recomputing it every time. A CQRS read projection is exactly this, specifically built and maintained by consuming the write side's events (or CDC stream) rather than being refreshed by a database's built-in materialized-view mechanism. The distinction is mostly about mechanism and scope: a database-native materialized view is typically refreshed within the same database engine on a schedule or trigger; a CQRS projection is usually a separate store (a search index, a different database optimized for the read pattern) updated asynchronously via an event stream, giving you more flexibility in shape and technology at the cost of eventual consistency.

### Q12. Would you use CQRS for a simple internal admin tool with low traffic? Why or why not?

No — CQRS's value comes from letting reads and writes scale and evolve independently and from optimizing read models for specific, demanding query patterns, none of which typically applies to a low-traffic internal tool. The added complexity — maintaining separate read and write models, an event pipeline or projector to keep them in sync, and handling eventual consistency/projection lag in the UI — is pure overhead when a single normalized table with straightforward CRUD queries would serve the actual load comfortably and be far simpler for the team to build, debug, and hand off. I'd only reconsider if the tool's query patterns became genuinely expensive (heavy joins/aggregations noticeably slowing the write path) or if it needed to scale reads independently of writes — neither of which is implied by "simple internal admin tool with low traffic."
