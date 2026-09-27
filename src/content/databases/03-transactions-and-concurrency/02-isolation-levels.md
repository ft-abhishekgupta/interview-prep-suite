---
title: Isolation Levels
description: The four standard isolation levels plus snapshot mapped to concrete anomalies, how each is implemented with locks versus row versioning, and a worked lost-update scenario
difficulty: Advanced
tags: [sql, isolation-levels, concurrency, t-sql, transactions]
---

Isolation level is the single knob that trades correctness guarantees for concurrency, and it is the most reliably asked "do you actually understand concurrency" question in a database interview. This page maps every standard anomaly to the levels that prevent it, contrasts SQL Server's two flavours of snapshot isolation, and works through a lost-update scenario with two concrete sessions.

## The anomalies

| Anomaly | What happens |
|---|---|
| Dirty read | Transaction A reads a row that transaction B has modified but not yet committed; B then rolls back, so A read data that never really existed |
| Non-repeatable read | Transaction A reads a row twice; between reads, B commits an update to that row, so A's two reads return different values |
| Phantom read | Transaction A runs the same range query twice; between runs, B commits an insert/delete that changes which rows match, so A sees a different *set* of rows |
| Lost update | Transactions A and B both read the same row, then both write back a modification based on their (now stale) read; whichever commits second overwrites the first's change entirely |
| Write skew | A and B each read overlapping data and each modify a *different* row based on it, and both commits succeed even though the combination violates an invariant neither transaction alone would have broken |

## Isolation levels mapped to anomalies

| Level | Dirty read | Non-repeatable read | Phantom read | Lost update | Write skew |
|---|---|---|---|---|---|
| Read Uncommitted | Possible | Possible | Possible | Possible | Possible |
| Read Committed | Prevented | Possible | Possible | Possible | Possible |
| Repeatable Read | Prevented | Prevented | Possible | Prevented (via locking) | Possible |
| Serializable | Prevented | Prevented | Prevented | Prevented | Prevented |
| Snapshot (MVCC) | Prevented | Prevented | Prevented | Possible (needs explicit handling) | Possible |

> [!KEY]
> Higher isolation is not free — each step up the standard ladder (Read Uncommitted → Serializable) holds locks longer or more broadly, reducing concurrency. Snapshot isolation is the interesting exception: it prevents dirty/non-repeatable/phantom reads **without blocking readers against writers at all**, at the cost of tempdb space for row versions.

## How each level is implemented: locks vs MVCC

SQL Server's default `READ COMMITTED` (and `REPEATABLE READ`/`SERIALIZABLE`) are **lock-based**: readers take shared locks (released immediately after the read under Read Committed, held until commit under Repeatable Read/Serializable), writers take exclusive locks held until commit, and a reader can be blocked by a writer's exclusive lock (and vice versa).

`SNAPSHOT` and `READ COMMITTED SNAPSHOT` use **MVCC** (multi-version concurrency control): a writer's uncommitted change doesn't block a reader at all — instead, the reader is transparently given the **last committed version** of the row from a version store, while the writer's in-progress change exists as a new, not-yet-visible version. Readers never block writers and writers never block readers under MVCC; they only conflict with each other at write-write collision.

```mermaid
flowchart LR
    subgraph "Lock-based (Read Committed / Repeatable Read / Serializable)"
        R1["Reader"] -. "blocked by" .-> W1["Writer holding X lock"]
    end
    subgraph "MVCC (Snapshot / RCSI)"
        R2["Reader"] --> V["Reads last committed version"]
        W2["Writer"] --> NV["Writes new version"]
    end
```

## READ COMMITTED SNAPSHOT vs SNAPSHOT isolation

Both are MVCC-based and both are SQL Server database-level options, but they answer a different question about "as of when."

| | READ COMMITTED SNAPSHOT (RCSI) | SNAPSHOT isolation |
|---|---|---|
| Enabled by | `ALTER DATABASE ... SET READ_COMMITTED_SNAPSHOT ON` | `ALTER DATABASE ... SET ALLOW_SNAPSHOT_ISOLATION ON`, then `SET TRANSACTION ISOLATION LEVEL SNAPSHOT` per session |
| "As of when" snapshot | Each individual **statement** sees data as of that statement's start | The entire **transaction** sees data as of the transaction's start |
| Replaces default Read Committed transparently | Yes — no application code change needed | No — application must opt in explicitly per transaction |
| Non-repeatable read possible? | Yes — each statement gets a fresh snapshot | No — whole transaction is one consistent snapshot |
| Write conflict detection | None beyond normal locking on writes | Update conflict error (3960) if a row it read was changed by another committed transaction |

> [!TIP]
> A senior answer distinguishes these precisely: *"RCSI is a drop-in replacement for default Read Committed that trades tempdb space for eliminating read blocking, but each statement still sees a fresh snapshot. Full Snapshot isolation gives the whole transaction one consistent point-in-time view, but requires the application to handle 3960 update-conflict errors on commit."*

## Optimistic vs pessimistic concurrency

- **Pessimistic**: assume conflicts are likely; take locks upfront (`SELECT ... WITH (UPDLOCK)`) so no one else can interfere, at the cost of blocking other transactions.
- **Optimistic**: assume conflicts are rare; let everyone proceed, and detect a conflict only at commit/update time (a version/rowversion column check, or snapshot isolation's update-conflict error), retrying if one occurred.

Optimistic concurrency scales better under low contention (no blocking at all in the common case) but requires the application to handle and retry conflicts; pessimistic concurrency is simpler to reason about but directly limits throughput under contention.

## Row versioning cost in tempdb

Every MVCC-based level (RCSI, Snapshot, and the row-versioning used to reduce reader/writer blocking generally) stores **old versions of modified rows** in tempdb's version store, so that any transaction still needing an older snapshot can find it. A long-running transaction under snapshot isolation forces the version store to retain every version of every row modified since that transaction started — on a busy, high-churn table, this can bloat tempdb significantly and increase the CPU cost of maintaining/cleaning the version chain. This is the direct tempdb-side cost of the "readers never block writers" benefit.

## Choosing a level for a real workload

| Workload shape | Reasonable default | Why |
|---|---|---|
| Standard OLTP web app, read-heavy | RCSI | Eliminates reader/writer blocking with minimal app changes |
| Financial ledger requiring strict consistency across a transaction | Serializable, or Snapshot with conflict retry | Correctness worth the concurrency cost |
| Reporting/analytics queries against a live OLTP table | RCSI or explicit Snapshot for the report's duration | Avoids blocking live transactional writes |
| High-contention counter/inventory updates | Pessimistic locking with `UPDLOCK`/`HOLDLOCK`, short transactions | Avoid optimistic retries thrashing under heavy contention |

## SELECT FOR UPDATE / UPDLOCK patterns

T-SQL has no `SELECT ... FOR UPDATE` syntax (that's Postgres/MySQL/Oracle); the equivalent is `WITH (UPDLOCK, HOLDLOCK)` on the `SELECT`, which takes an update lock (compatible with shared reads, but blocks other update/exclusive attempts) and holds it until the transaction ends — preventing another transaction from reading-then-writing the same row in between.

```sql
BEGIN TRANSACTION;
    SELECT quantity FROM inventory WITH (UPDLOCK, HOLDLOCK)
    WHERE product_id = 42;
    -- application logic decides new quantity here
    UPDATE inventory SET quantity = @new_quantity WHERE product_id = 42;
COMMIT TRANSACTION;
```

## Worked lost-update scenario with two sessions

Two sessions both try to decrement inventory for the same product, under `READ COMMITTED` with no explicit locking hints.

| Time | Session A | Session B |
|---|---|---|
| t1 | `BEGIN TRAN; SELECT quantity` → reads 10 | |
| t2 | | `BEGIN TRAN; SELECT quantity` → reads 10 |
| t3 | App computes 10 - 1 = 9 | |
| t4 | | App computes 10 - 1 = 9 |
| t5 | `UPDATE inventory SET quantity = 9; COMMIT` | |
| t6 | | `UPDATE inventory SET quantity = 9; COMMIT` |

Final quantity is **9**, but two units were actually sold — one decrement is lost, because both sessions read the same stale value of 10 and neither knew about the other's concurrent write. Under plain `READ COMMITTED`, nothing prevents this: the `SELECT` releases its shared lock immediately, so it doesn't block session B's own read.

**Fix 1 — pessimistic**: `SELECT ... WITH (UPDLOCK, HOLDLOCK)` at t1 takes and holds an update lock, forcing session B's read at t2 to wait until session A commits at t5, at which point B reads the already-updated value of 9 and correctly computes 8.

**Fix 2 — optimistic**: do the decrement in a single atomic statement instead of read-then-write: `UPDATE inventory SET quantity = quantity - 1 WHERE product_id = 42 AND quantity >= 1` — there is no separate read step to go stale, so both sessions' updates apply correctly and sequentially regardless of isolation level.

> [!DANGER]
> The lost update anomaly is not fixed by simply raising isolation to `REPEATABLE READ` unless you also lock for update — `REPEATABLE READ` prevents the *value* from changing between two reads in the *same* transaction, but plain reads still take shared (not update) locks by default, so two transactions can still both read-then-write the same row unless `UPDLOCK` is used or the operation is expressed as a single atomic statement.

## Mermaid: phantom read sequence

```mermaid
sequenceDiagram
    participant A as "Transaction A"
    participant DB as "Database"
    participant B as "Transaction B"
    A->>DB: SELECT * FROM orders WHERE status = 'Pending'
    DB-->>A: 5 rows
    B->>DB: INSERT INTO orders (status) VALUES ('Pending')
    B->>DB: COMMIT
    A->>DB: SELECT * FROM orders WHERE status = 'Pending' (same transaction)
    DB-->>A: 6 rows - phantom row appeared
```

Under `REPEATABLE READ`, this can still happen because that level only locks the specific rows already read, not the range itself — `SERIALIZABLE` closes the gap by range-locking, preventing B's insert from committing until A's transaction finishes.

## Cheat sheet

- Anomaly ladder: dirty read < non-repeatable read < phantom read < write skew — each higher isolation level closes off more of them, at a concurrency cost.
- `READ COMMITTED` (SQL Server default) prevents dirty reads only; everything else is still possible.
- `SERIALIZABLE` prevents all four standard anomalies via range locking, at the highest concurrency cost.
- MVCC-based levels (RCSI, Snapshot) prevent dirty/non-repeatable/phantom reads **without blocking readers against writers** at all — the cost moves to tempdb version storage.
- RCSI gives each **statement** a fresh snapshot; SNAPSHOT gives the whole **transaction** one consistent snapshot and can raise a 3960 update-conflict error.
- Lost update is not fixed by isolation level alone unless you also take an update lock (`UPDLOCK`) or express the operation as a single atomic statement.
- Optimistic concurrency scales better under low contention; pessimistic is simpler to reason about under high contention.
- Long transactions under snapshot isolation bloat the tempdb version store — keep them short.
- T-SQL's equivalent of `SELECT ... FOR UPDATE` is `WITH (UPDLOCK, HOLDLOCK)`.

## Common mistakes

| Mistake | Fix |
|---|---|
| Assuming `REPEATABLE READ` alone prevents lost updates | Add `UPDLOCK`/`HOLDLOCK`, or express the update as a single atomic statement |
| Confusing RCSI with full Snapshot isolation | RCSI is per-statement; Snapshot is per-transaction and needs explicit opt-in plus conflict handling |
| Using `SERIALIZABLE` everywhere "to be safe" | Match isolation to the actual invariant at risk — Serializable maximally reduces concurrency |
| Not handling error 3960 under Snapshot isolation | Catch the update-conflict error and retry the transaction |
| Ignoring tempdb growth under Snapshot/RCSI with long transactions | Keep transactions short; monitor the version store |
| Doing read-then-write in application code without locking or an atomic statement | Prefer a single `UPDATE ... SET x = x - 1 WHERE ...` over read-compute-write |

## Summary

Isolation levels are a spectrum from "fast but anomaly-prone" (Read Uncommitted) to "fully consistent but maximally blocking" (Serializable), implemented either through locks that make transactions wait or through MVCC that gives each reader its own consistent version at the cost of tempdb space. The two facts most worth memorising cold are that lost updates need an explicit update lock or an atomic statement regardless of isolation level, and that RCSI and Snapshot isolation solve overlapping but distinct problems — per-statement versus per-transaction consistency — with different failure modes (silent staleness versus an explicit conflict error) for the application to handle.

## Top Interview Questions

### Q1. What are the four standard SQL isolation levels, and what does each one prevent?

Read Uncommitted prevents nothing — it allows dirty reads, non-repeatable reads, and phantom reads, trading all correctness for maximum concurrency. Read Committed (SQL Server's default) prevents dirty reads only, by requiring a transaction to only ever see committed data, but a row can still change between two reads in the same transaction. Repeatable Read additionally holds shared locks on rows already read until the transaction ends, preventing non-repeatable reads, but new rows matching a range predicate can still appear (phantoms) since the range itself isn't locked. Serializable adds range locking, preventing phantoms too, making transactions behave as if they ran one at a time — at the highest concurrency cost of the four.

### Q2. What is a lost update, and does raising the isolation level alone fix it?

A lost update happens when two transactions both read the same row, each computes a new value based on that (now potentially stale) read, and both write back — whichever commits second overwrites the first's change with no awareness it ever happened. Raising isolation level alone does not reliably fix this: even `REPEATABLE READ` only guarantees a value won't change *if read again* within the same transaction, but plain `SELECT`s take shared locks that don't prevent a *different* transaction from also reading and later writing the same row. The real fixes are taking an explicit update lock (`WITH (UPDLOCK, HOLDLOCK)`) at read time, or better, expressing the operation as a single atomic statement (`UPDATE t SET qty = qty - 1 WHERE ...`) so there's no separate read step to go stale.

### Q3. What's the difference between REPEATABLE READ and SERIALIZABLE?

`REPEATABLE READ` guarantees that if a transaction reads a specific row twice, it gets the same value both times, by holding a shared lock on every row it has read until the transaction ends. It does **not**, however, prevent new rows from appearing that match a range predicate re-run later in the same transaction (phantoms), because it only locks the rows it actually touched, not the "gap" a new row could be inserted into. `SERIALIZABLE` closes that gap by taking range locks (or key-range locks) covering the predicate itself, so no other transaction can insert or delete a row that would change the result of a repeated range query — at the cost of blocking more concurrent activity.

### Q4. How does MVCC (as used in Snapshot isolation) avoid blocking readers against writers, and what's the cost?

Under MVCC, when a row is modified, the engine doesn't overwrite it in place and lock out readers — it keeps the previous committed version available (in tempdb's version store, in SQL Server's implementation) and lets any transaction that needs a consistent view continue reading that older version, while the writer's new version becomes visible only to transactions started after it commits. This means readers never wait on writers and writers never wait on readers purely for read/write conflicts — they only actually conflict on true write-write collisions. The cost is that every modified row's old versions must be retained in tempdb for as long as any transaction might still need them, so a long-running transaction under snapshot isolation can cause significant tempdb growth and version-chain maintenance overhead.

### Q5. What's the difference between READ COMMITTED SNAPSHOT and SNAPSHOT isolation in SQL Server?

Both use row versioning (MVCC) instead of blocking locks for reads, but they differ in scope: RCSI gives each **individual statement** a fresh, consistent snapshot as of that statement's start time, so two statements in the same transaction can see different data if something committed in between — it's a drop-in replacement for default Read Committed with no application changes required. Full SNAPSHOT isolation gives the **entire transaction** one consistent snapshot from its start, so every statement within it sees the same point-in-time view — but it must be explicitly opted into per transaction (`SET TRANSACTION ISOLATION LEVEL SNAPSHOT`), and it introduces a new failure mode: if another transaction commits a conflicting write to a row your snapshot transaction also tries to update, your commit fails with error 3960 and must be retried.

### Q6. What is write skew, and why doesn't Snapshot isolation prevent it?

Write skew occurs when two transactions each read overlapping data to check some invariant, then each write to a *different* row based on what they read, and both commits succeed even though the combined result violates the invariant neither transaction individually broke. A classic example: two on-call doctors both check "is at least one other doctor on call" (yes, the other one is), and both then remove themselves from on-call duty, leaving nobody on call — each transaction's own write was consistent with what it read, but the combination isn't. Snapshot isolation only detects genuine write-write conflicts on the *same* row; since each transaction here wrote to a *different* row, there's no conflict for it to catch, and true `SERIALIZABLE` (or explicit application-level locking of the read set) is needed to prevent it.

### Q7. Why would you choose optimistic concurrency over pessimistic locking, and what does the application need to handle either way?

Optimistic concurrency (proceed without locking, detect conflicts at write time via a version/rowversion column or Snapshot isolation's conflict error) scales far better under low-to-moderate contention because transactions never block each other for reads, and most attempts genuinely don't conflict. Pessimistic locking (`UPDLOCK`/`HOLDLOCK` taken upfront) is simpler to reason about and avoids wasted work under high contention, where optimistic retries would otherwise thrash repeatedly against the same hot row. Either way the application must have an explicit retry strategy: optimistic concurrency requires catching a conflict (a rowversion mismatch, or SQL Server error 3960) and re-running the logic; pessimistic locking requires handling and avoiding deadlocks, since holding locks across multiple statements introduces the possibility of two transactions waiting on each other's locks.

### Q8. How would you write a query in T-SQL to safely read a row with the intent to update it later in the same transaction, avoiding a lost update?

```sql
BEGIN TRANSACTION;
    SELECT quantity FROM inventory WITH (UPDLOCK, HOLDLOCK)
    WHERE product_id = 42;
    -- application computes the new value here
    UPDATE inventory SET quantity = @new_quantity WHERE product_id = 42;
COMMIT TRANSACTION;
```

`UPDLOCK` takes an update lock — compatible with other transactions' plain shared reads, but incompatible with another transaction also trying to take an update or exclusive lock — so a concurrent session attempting the same read-with-intent-to-update is forced to wait until this transaction commits, rather than both reading the same stale value. `HOLDLOCK` (equivalent to `SERIALIZABLE` for this specific table/range) ensures the lock is held for the duration of the transaction rather than released immediately, and also protects against phantom inserts into that key range if relevant.

### Q9. A report query is timing out and diagnosis shows it's blocked behind a long-running OLTP transaction. What isolation-level-based fix would you propose, and what's the trade-off?

Enabling `READ_COMMITTED_SNAPSHOT` at the database level (or running the report explicitly under `SNAPSHOT` isolation) lets the report read the last committed version of each row via the tempdb version store instead of waiting on the OLTP transaction's locks — this is usually the cleanest fix since it requires no application code changes for RCSI, and directly targets "reads shouldn't block on writes." The trade-off is added tempdb load for maintaining row versions, which is usually a good trade for OLTP systems, but worth monitoring if the OLTP transactions are themselves long-running, since that would force the version store to retain more history than usual, increasing tempdb pressure rather than fully eliminating the underlying problem of a long-running transaction.

### Q10. What's the difference between a dirty read and a non-repeatable read, and can Read Committed produce either?

A dirty read is seeing another transaction's **uncommitted** change, which could later be rolled back, meaning you read data that never actually became real. A non-repeatable read is seeing a row's value change *between two reads within your own transaction*, because another transaction committed an update to it in between — the data you saw was real and committed both times, just different each time. SQL Server's default Read Committed prevents dirty reads (it never lets you see another transaction's uncommitted data) but does **not** prevent non-repeatable reads, since it releases its shared lock immediately after each individual read rather than holding it for the whole transaction, so a second read of the same row can see a different, newly-committed value.

### Q11. In a system using optimistic concurrency with a rowversion/timestamp column, what happens when two users update the same record concurrently, and how do you handle it?

Both users read the row along with its current `rowversion` value; when each submits their update, the `UPDATE` statement includes `WHERE id = @id AND rowversion = @original_rowversion` — whichever commits first succeeds and the row's `rowversion` changes, and the second user's `UPDATE` then matches zero rows because the `rowversion` no longer matches what they originally read. The application must detect this (checking rows-affected = 0) and treat it as a concurrency conflict rather than silent success — the standard handling is to reload the current row, show the user what changed, and let them decide whether to reapply their change, merge, or discard it, rather than blindly retrying with the old data (which would just repeat the same stale-read problem).

### Q12. Why is choosing an isolation level a business decision as much as a technical one?

Isolation level is fundamentally a trade-off between correctness guarantees and concurrency/throughput, and the "right" level depends on what an anomaly would actually cost in that specific workload — a dashboard showing slightly stale aggregate counts is usually harmless, so Read Committed or even RCSI is fine, but a financial ledger or inventory system where a lost update means double-selling the same unit of stock justifies the throughput cost of pessimistic locking or Serializable isolation. Presenting isolation level purely as a technical default misses that the actual choice should be driven by asking "what does it cost the business if this specific anomaly happens here," which is the framing that distinguishes a senior answer from reciting the anomaly table.
