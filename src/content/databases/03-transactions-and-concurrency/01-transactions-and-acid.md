---
title: Transactions and ACID
description: Each ACID property explained through a concrete failure it prevents, what durability really means at the storage layer, and why distributed transactions are avoided
difficulty: Core
tags: [sql, transactions, acid, t-sql, csharp]
---

ACID is usually recited as a definition; interviewers actually want to know you can explain what breaks **without** each property. This page walks through each guarantee with a concrete failure scenario, then covers transaction scope, nested transactions, and why distributed transactions across services are a design smell. Examples use T-SQL and C#.

A database transaction is a sequence of operations executed as a single logical unit of work — everything inside it succeeds together, or the database behaves as if none of it happened.

![alt text](notes/03-Databases/image-3.png)

## Atomicity

A transaction is all-or-nothing: every statement inside it commits together, or none of them do.

**Failure it prevents**: transferring money between two accounts as two separate `UPDATE` statements — if the process crashes after debiting account A but before crediting account B, the money vanishes. Wrapping both in one transaction guarantees that a crash mid-way rolls back the debit too.

```sql
BEGIN TRANSACTION;
    UPDATE accounts SET balance = balance - 100 WHERE account_id = 1;
    UPDATE accounts SET balance = balance + 100 WHERE account_id = 2;
COMMIT TRANSACTION;
```

## Consistency

A transaction moves the database from one **valid** state to another, never violating constraints, triggers, or cascading rules — even mid-transaction, the final committed state must satisfy every constraint.

**Failure it prevents**: a `CHECK (age >= 18)` constraint or a foreign key referencing a non-existent department would reject a commit that violates it. Consistency in ACID is really "the sum of atomicity, isolation, and the schema's own integrity rules" — it's the *outcome* the other three properties combine to guarantee, which is why it's the property people find hardest to explain crisply.

## Isolation

Concurrent transactions should not see each other's uncommitted, in-progress changes — covered in full depth on the isolation levels page. **Failure it prevents**: two transactions reading and updating the same row concurrently, each overwriting the other's change (a lost update) because neither saw the other's in-flight write.

## Durability

Once a transaction **commits**, its effects survive — even a power loss or crash immediately after.

**Failure it prevents**: an order confirmation shown to a customer, followed by a server crash, followed by the order having silently never happened because it was only ever in memory.

> [!KEY]
> Durability is implemented via the **write-ahead log (WAL)** — called the transaction log in SQL Server. Before a data page is modified in the data file, the *change record* is written to the log and flushed (`fsync`) to durable storage first. On commit, the engine guarantees the log records for that transaction are on disk before acknowledging success; the actual data file pages can be written later (lazily) because the log alone is enough to redo the change after a crash. **Group commit** batches multiple transactions' log flushes into a single disk write to amortise the fsync cost across them.

```mermaid
sequenceDiagram
    participant App
    participant Engine
    participant Log as "Transaction Log"
    participant Data as "Data File"
    App->>Engine: COMMIT
    Engine->>Log: Write log records
    Log-->>Engine: fsync confirmed on disk
    Engine-->>App: Commit acknowledged
    Engine->>Data: Data pages flushed later (lazy)
```

## ACID anomaly-to-failure quick reference

![alt text](notes/03-Databases/image-4.png)

| Property | Guarantees | Failure without it |
|---|---|---|
| Atomicity | All statements in a transaction commit, or none do | Partial transfer: debited but not credited |
| Consistency | Committed state always satisfies constraints/rules | Orphaned foreign key, negative balance despite a CHECK |
| Isolation | Concurrent transactions don't see each other's uncommitted state | Dirty read, lost update, non-repeatable read |
| Durability | Committed data survives a crash immediately after | "Successful" order that vanishes on restart |

## Transaction boundaries and scope

| Mode | How it's declared | Behaviour |
|---|---|---|
| Autocommit (implicit, default) | No explicit `BEGIN TRAN` | Every single statement is its own transaction, committed immediately |
| Explicit transaction | `BEGIN TRANSACTION ... COMMIT/ROLLBACK` | Groups multiple statements into one atomic unit |
| Implicit transaction mode | `SET IMPLICIT_TRANSACTIONS ON` | A transaction auto-starts on the next DML statement but still needs an explicit `COMMIT` |

```sql
BEGIN TRANSACTION;
    UPDATE inventory SET quantity = quantity - 1 WHERE product_id = 42;
    IF (SELECT quantity FROM inventory WHERE product_id = 42) < 0
        ROLLBACK TRANSACTION;
    ELSE
        COMMIT TRANSACTION;
```

## Savepoints

A savepoint (`SAVE TRANSACTION name` in T-SQL) marks a point within a larger transaction that you can roll back to **without** discarding the entire transaction — useful for "try this step, and if it fails, undo just that step but keep everything before it."

```sql
BEGIN TRANSACTION;
    UPDATE accounts SET balance = balance - 100 WHERE account_id = 1;
    SAVE TRANSACTION AfterDebit;
    UPDATE accounts SET balance = balance + 100 WHERE account_id = 2;
    IF @@ERROR <> 0
        ROLLBACK TRANSACTION AfterDebit; -- undoes only the credit, keeps the debit
COMMIT TRANSACTION;
```

> [!WARNING]
> `ROLLBACK TRANSACTION` with no name rolls back the **entire** transaction to the start, discarding any savepoints. Only naming the savepoint in the `ROLLBACK` rolls back partially.

## Long transactions and their cost

A transaction held open for a long time (a slow report inside a transaction, a UI waiting on user input mid-transaction) holds its locks for that entire duration under pessimistic isolation levels, blocking other writers and sometimes readers. It also prevents the transaction log from truncating past that point (the log must retain everything since the oldest active transaction began), which can grow the log file unexpectedly large. Under optimistic/snapshot isolation, long transactions instead bloat the **version store in tempdb**, since old row versions must be retained as long as any transaction might still need to read them.

> [!DANGER]
> Never hold a database transaction open across a network call, a user interaction, or any I/O you don't control the timing of. A transaction that "just" waits on an external API for 30 seconds holds its locks (or forces version retention) for that entire window — a classic cause of a production incident that looks like "everything suddenly froze."

## Transactions across service boundaries

Wrapping a database transaction around a call to a separate microservice — "commit the local transaction only if the remote HTTP call also succeeds" — does not actually work, because the remote service has its own separate transaction (if any) with its own commit point; there is no single atomic unit spanning both. The two failure modes are: the local commit succeeds but the remote call fails (data now inconsistent), or the remote call succeeds but the local commit then fails or times out (the remote side did something the local side doesn't know about). The standard fix is **not** a distributed transaction but an explicit pattern: outbox pattern (write the "to-be-sent" event in the same local transaction, then a separate process delivers it with retries), sagas (a sequence of local transactions with compensating actions), or idempotent retries with reconciliation.

## Nested transactions in SQL Server

SQL Server allows syntactically nested `BEGIN TRANSACTION` calls, but they are **not** truly independent — `@@TRANCOUNT` just increments, and only the **outermost** `COMMIT` actually commits anything; a `ROLLBACK` at any nesting level rolls back the **entire** transaction, not just the inner one. This surprises people expecting savepoint-like partial rollback from nesting — that behaviour requires actual savepoints, not nested `BEGIN TRANSACTION`.

## Distributed transactions and MSDTC

A true distributed transaction spans multiple resource managers (e.g. two separate SQL Server instances, or a SQL Server and an MSMQ) and is coordinated via the **two-phase commit protocol**: a prepare phase where every participant confirms it *can* commit, followed by a commit phase where all participants actually commit, coordinated by MSDTC (Microsoft Distributed Transaction Coordinator) on Windows. This guarantees atomicity across systems but at real cost: participants hold locks throughout both phases, the coordinator itself is a point of failure/bottleneck, and it doesn't work at all across typical service/HTTP boundaries — only across transactional resource managers that support the protocol. Modern architectural guidance is to avoid MSDTC/distributed transactions in favour of sagas or the outbox pattern wherever possible.

## Code sample: TransactionScope and EF Core

```csharp
// TransactionScope — ambient transaction, can span multiple connections
using (var scope = new TransactionScope(TransactionScopeAsyncFlowOption.Enabled))
{
    using var conn1 = new SqlConnection(connStringA);
    await conn1.OpenAsync();
    await conn1.ExecuteAsync("UPDATE accounts SET balance = balance - 100 WHERE account_id = 1");

    using var conn2 = new SqlConnection(connStringB);
    await conn2.OpenAsync();
    await conn2.ExecuteAsync("UPDATE accounts SET balance = balance + 100 WHERE account_id = 2");

    scope.Complete(); // without this call, everything rolls back on dispose
}
```

```csharp
// EF Core — explicit transaction around multiple SaveChanges calls
using var context = new AppDbContext();
using var transaction = await context.Database.BeginTransactionAsync();
try
{
    context.Accounts.First(a => a.Id == 1).Balance -= 100;
    await context.SaveChangesAsync();

    context.Accounts.First(a => a.Id == 2).Balance += 100;
    await context.SaveChangesAsync();

    await transaction.CommitAsync();
}
catch
{
    await transaction.RollbackAsync();
    throw;
}
```

> [!TIP]
> `TransactionScope` silently escalates to a distributed (MSDTC) transaction the moment a **second** distinct connection/resource is enlisted — a common surprise. Say this out loud if asked: *"If both operations hit the same database over the same connection, EF Core's own transaction is enough and cheaper; TransactionScope across two different connections/databases will escalate to MSDTC, which I'd try to avoid architecturally."*

## Cheat sheet

- **Atomicity**: all-or-nothing. **Consistency**: constraints always hold on commit. **Isolation**: concurrent transactions don't see each other's uncommitted state. **Durability**: committed data survives a crash.
- Durability is implemented via the write-ahead log — the log is fsynced before commit is acknowledged; data pages can be written later.
- Group commit batches multiple transactions' log flushes to amortise fsync cost.
- A savepoint allows partial rollback within a transaction; a plain `ROLLBACK` undoes everything, including past savepoints.
- Nested `BEGIN TRANSACTION` in SQL Server is not truly nested — only the outermost `COMMIT` matters, and any `ROLLBACK` undoes the whole thing.
- Never hold a transaction open across a network call or user interaction — locks and version-store retention persist for the entire duration.
- Distributed transactions across services don't really work — prefer sagas or the outbox pattern.
- `TransactionScope` can silently escalate to MSDTC (two-phase commit) once a second resource is enlisted.

## Common mistakes

| Mistake | Fix |
|---|---|
| Treating nested `BEGIN TRANSACTION` as independently rollback-able | Use named savepoints for partial rollback instead |
| Holding a transaction open across an external API call | Do the external call outside the transaction; use the outbox pattern to keep them consistent |
| Assuming ACID applies across a call to another microservice | Design an explicit saga/outbox instead of relying on a spanning transaction |
| Forgetting `scope.Complete()` in `TransactionScope` | Without it, the transaction rolls back on dispose even if all operations "succeeded" |
| Confusing durability with "the data file was updated" | Durability is about the log being fsynced on commit, not the data file timing |
| Letting `TransactionScope` silently escalate to MSDTC without realising | Keep operations on one connection/database where possible, or plan for MSDTC explicitly |

## Summary

Each ACID letter maps to a specific, nameable failure: atomicity stops partial writes, consistency stops constraint violations from being committed, isolation stops concurrent transactions from seeing half-finished work, and durability stops committed data from disappearing on crash — implemented concretely via the write-ahead log being fsynced before commit is acknowledged. The practical judgment calls are keeping transactions short, using savepoints instead of assuming nested transactions behave independently, and never trying to stretch a transaction across a service boundary — that's what sagas and the outbox pattern are for.

## Top Interview Questions

### Q1. Explain ACID with a concrete failure example for each property.

Atomicity: without it, a funds transfer implemented as two separate updates could crash after debiting and before crediting, losing money — atomicity guarantees both happen or neither does. Consistency: without it, a commit could leave a `CHECK`/foreign-key constraint violated, e.g. a negative balance or an order referencing a deleted customer. Isolation: without it, two concurrent transactions reading and writing the same row could each overwrite the other's change, silently losing an update (a lost update). Durability: without it, a transaction could report success to the caller and then vanish entirely on a crash immediately afterward, because it was never actually persisted past volatile memory.

### Q2. What does "durability" actually mean at the storage engine level?

Durability means that once a transaction is acknowledged as committed, its effects survive a subsequent crash or power loss. It's implemented via a write-ahead log (the transaction log in SQL Server): before any data page is modified, the change is first written as a log record and that log record is flushed (fsynced) to durable storage. The engine only reports "commit successful" back to the caller once the relevant log records are confirmed on disk — the actual data file pages can be updated later, because after a crash the engine can replay (redo) the log to reconstruct any committed changes that hadn't yet been written to the data file. Group commit batches multiple transactions' log flushes into a single physical write to reduce the fsync overhead per transaction.

### Q3. Why is consistency in ACID often described as "the result of the other three," and how would you explain it precisely?

Consistency means the database only ever moves between valid states — every constraint, trigger, cascade rule, and invariant holds after a commit. But that guarantee is delivered *by* the other three properties working together: atomicity ensures a transaction can't commit half-finished (which could easily leave things inconsistent), isolation ensures concurrent transactions don't interact in ways that violate an invariant neither one alone would have broken, and durability ensures the consistent state, once achieved, isn't lost. So consistency is less an independent mechanism and more the outcome the schema's constraints plus the other three ACID properties jointly guarantee — which is exactly why it's the hardest of the four to explain with its own standalone mechanism.

### Q4. What is a savepoint, and how does it differ from a nested transaction in SQL Server?

A savepoint (`SAVE TRANSACTION name`) marks a point inside an active transaction that you can selectively roll back to with `ROLLBACK TRANSACTION name`, undoing only the work since that point while preserving everything committed-so-far within the still-open outer transaction. A syntactically "nested" `BEGIN TRANSACTION` in SQL Server, by contrast, is not truly independent — it only increments an internal counter (`@@TRANCOUNT`); only the outermost `COMMIT` actually commits anything, and a `ROLLBACK` at any level undoes the entire transaction back to its start, discarding any savepoints along with it. If you need genuine partial-rollback behaviour, you need savepoints, not nested BEGIN/COMMIT pairs.

### Q5. Why shouldn't you hold a database transaction open across a network call or user interaction?

A transaction holds locks (under pessimistic isolation) or forces retention of old row versions in the tempdb version store (under snapshot/optimistic isolation) for its entire duration, and neither of those durations should ever depend on something outside the database's control — a slow external API call, a UI waiting on a user to click a button, or a long-running batch step. If that external step takes 30 seconds or hangs entirely, every other transaction needing those same rows/pages is blocked (or the version store bloats) for that whole time, which is a classic cause of a sudden, hard-to-diagnose production incident that looks like "the whole database froze." The fix is to keep transactions as short as possible and perform any I/O you don't control the timing of outside the transaction boundary.

### Q6. Why can't you just wrap a call to another microservice inside your local database transaction to keep both consistent?

A database transaction can only coordinate resources that participate in its own commit protocol — a plain HTTP/RPC call to another service has no such participation; it has already returned (succeeded or failed) with its own independent effects before your local transaction even reaches its commit point. This creates two failure windows with no way to make them atomic: the local commit could fail after the remote call already succeeded (leaving the remote side changed with nothing local to match), or the remote call could time out after actually succeeding server-side, leaving you uncertain whether to retry. The standard resolution isn't to force atomicity across the boundary at all, but to design for eventual consistency explicitly — the outbox pattern (write an event to your local transaction, deliver it asynchronously with retries) or a saga (a sequence of local transactions each with a compensating action if a later step fails).

### Q7. What is MSDTC and when would a distributed transaction actually be used?

MSDTC (Microsoft Distributed Transaction Coordinator) coordinates a true distributed transaction across multiple resource managers using two-phase commit: a prepare phase where every participant confirms readiness to commit, then a commit phase where all participants commit together, guaranteeing all-or-nothing atomicity across genuinely separate transactional resources (e.g. two different SQL Server instances, or SQL Server plus MSMQ). It's appropriate when you truly need atomic guarantees across multiple transactional resource managers that support the protocol and the operations are relatively short-lived — but it comes with real costs: locks are held across both phases (increasing contention), the coordinator is a potential bottleneck/single point of failure, and it simply doesn't apply to typical HTTP/service-to-service boundaries at all, which is why modern architectures generally avoid it in favor of sagas or the outbox pattern.

### Q8. What happens if you call BEGIN TRANSACTION twice in a row without an intervening COMMIT, then ROLLBACK once — does anything remain committed?

No — `@@TRANCOUNT` simply increments to 2 on the second `BEGIN TRANSACTION`, since SQL Server's nested transactions aren't independent; a single `ROLLBACK TRANSACTION` (with no name) rolls back everything all the way to the very start of the outermost transaction, regardless of how many `BEGIN TRANSACTION`s occurred, and resets `@@TRANCOUNT` to 0. To achieve a true partial rollback that only undoes the inner portion while keeping the outer portion's work, you must use a named savepoint (`SAVE TRANSACTION`) and roll back to that specific name instead of relying on nested `BEGIN TRANSACTION` calls.

### Q9. Your application uses TransactionScope wrapping calls to two different databases. What's happening under the hood, and what should you be aware of?

`TransactionScope` creates an ambient transaction that any enlisted resource (each `SqlConnection.Open()` within its scope) automatically joins. As long as only one distinct connection/resource is enlisted, SQL Server can handle it as a normal lightweight local transaction. The moment a **second** distinct connection or resource manager is enlisted within the same scope, .NET automatically escalates the transaction to a full distributed transaction coordinated by MSDTC, using two-phase commit — this happens silently, with real cost implications (locks held longer, MSDTC must be enabled and configured, cross-machine firewall/DTC configuration needed). Being aware of this escalation point matters for both performance and deployment (MSDTC isn't always available/enabled, especially in containerized or cloud environments), so many teams deliberately avoid spanning connections within one `TransactionScope`.

### Q10. Why does EF Core's own transaction handling differ from wrapping SaveChanges calls in an explicit BeginTransaction/Commit?

By default, each call to `SaveChangesAsync()` runs inside its own implicit transaction, so multiple `SaveChangesAsync()` calls are each atomic **individually** but not atomic **together** — if the second call fails, the first one's changes remain committed. Wrapping multiple `SaveChangesAsync()` calls in an explicit `context.Database.BeginTransactionAsync()` / `CommitAsync()` makes the whole sequence atomic as one unit — if any step fails, `RollbackAsync()` (or an exception before `CommitAsync()` combined with disposal) undoes all of them together. The explicit approach is needed whenever business logic requires several related writes, possibly across multiple `SaveChanges` calls or even multiple `DbContext` instances against the same connection, to succeed or fail as a single unit.

### Q11. What's the relationship between long-running transactions and the transaction log growing unexpectedly large?

SQL Server's transaction log can only truncate (reclaim space for reuse) up to the point where the **oldest still-active transaction** began, because it must be able to fully undo or redo anything from that point forward in case of a crash or rollback. A single long-running transaction — even one that's mostly idle, waiting on something external — pins that truncation point at its start time, so every subsequent transaction's log records (from potentially many other unrelated sessions) accumulate without being reclaimable, and the log file can grow dramatically even though data volume changes are small. This is a very common real-world cause of log files ballooning, and the fix is almost always finding and shortening (or eliminating) the long-running transaction, not just growing the log file to absorb it.

### Q12. In production, how would you detect and diagnose a transaction that's been left open too long?

I'd query `sys.dm_tran_active_transactions` joined with `sys.dm_tran_session_transactions` and `sys.dm_exec_sessions`/`sys.dm_exec_requests` to find sessions with an open transaction and a long `transaction_begin_time`, cross-referencing with `sys.dm_tran_locks` to see what it's holding and `sys.dm_os_waiting_tasks` to see who's blocked behind it. Once identified, I'd check what that session's application code is doing — the usual culprit is a transaction wrapping something it shouldn't (a network call, a report generation step, or a forgotten `COMMIT` on an error path) — and fix the code to keep the transaction boundary tight around only the actual database writes, rather than simply killing the session as a one-off fix that will recur.
