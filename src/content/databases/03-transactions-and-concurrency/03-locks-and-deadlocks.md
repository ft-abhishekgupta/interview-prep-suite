---
title: Locks and Deadlocks
description: How relational databases use locks to isolate concurrent transactions, why deadlocks occur, and how to detect, prevent and recover from them in production
difficulty: Advanced
tags: [locks, deadlocks, concurrency, transactions, sql]
---

Any database that guarantees isolation between concurrent transactions has to make some transactions wait for others. Locks are the mechanism that enforces that waiting, and any system built on waiting can deadlock — which is exactly why this is a favourite whiteboard topic for senior backend interviews.

## Why transactions need locks

A lock is a claim a transaction takes on a piece of data so that conflicting transactions cannot touch it until the claim is released (usually at commit or rollback). This is **pessimistic concurrency control**: assume conflicts will happen and block them up front. The alternative, **optimistic concurrency control**, lets transactions proceed and checks for conflicts at commit time using row versions (a `rowversion`/`xmin` column) or MVCC snapshots — Postgres and Oracle read committed data this way without taking read locks at all.

> [!KEY]
> Locks exist to protect **isolation**, the "I" in ACID. Every lock you see in a database is ultimately there to stop one transaction from observing or corrupting another's uncommitted work.

## Lock modes and the compatibility matrix

| Mode | Short | Taken for | Blocks |
|---|---|---|---|
| Shared | S | Reads (`SELECT`) | Writers, not other readers |
| Update | U | Rows a statement might update (`UPDATE ... WHERE`) | Prevents two readers both upgrading to X and deadlocking each other |
| Exclusive | X | Writes (`INSERT`/`UPDATE`/`DELETE`) | Everyone |
| Intent (IS/IX/SIX) | I* | Signals "I hold a lock somewhere below this level" | Nothing directly — lets the engine skip scanning every row to check for conflicts |

Compatibility of the core modes when two transactions want the **same row**:

| Held ↓ / Requested → | S | U | X |
|---|---|---|---|
| **S** | ✅ | ✅ | ❌ |
| **U** | ✅ | ❌ | ❌ |
| **X** | ❌ | ❌ | ❌ |

Update locks exist specifically to prevent a subtle deadlock: if two transactions both took shared locks while scanning for rows to update, both would later try to upgrade to exclusive and block each other forever. Taking a single update lock up front serializes the upgrade.

## Lock granularity and escalation

Engines lock at multiple granularities — row, page, and table — and use **intent locks** at coarser levels so a table-level scanner doesn't have to inspect every row lock individually.

```mermaid
flowchart TD
    T["Table lock (IX)"] --> P["Page lock (IX)"]
    P --> R1["Row lock (X)"]
    P --> R2["Row lock (X)"]
```

Row locks give the best concurrency but cost memory (roughly 96–128 bytes each in SQL Server). When a single statement acquires too many row locks — SQL Server's default threshold is around 5,000 — the engine **escalates** to a table lock to cap memory use. Escalation is great for memory, terrible for concurrency: a large batch update can suddenly block every other reader and writer on the table.

> [!WARNING]
> Lock escalation is a common cause of "this batch job randomly blocks the whole app" incidents. Batch updates in smaller chunks (e.g., 1,000–5,000 rows per transaction) to stay under the escalation threshold.

## Blocking vs deadlocking

| | Blocking | Deadlock |
|---|---|---|
| Cause | One transaction waits for a lock held by another | Two or more transactions wait on each other in a cycle |
| Resolves itself? | Yes, once the holder commits/rolls back | No — it never resolves without intervention |
| Database's response | Nothing; the waiter just waits (subject to lock timeout) | Detector kills one transaction (the "victim") |
| Symptom | Latency spike, timeouts if excessive | Error 1205 (SQL Server) / `deadlock detected` (Postgres) |

Blocking is normal and expected — it's how isolation works. A deadlock is a special, unrecoverable case of blocking that the database must actively break.

## Anatomy of a deadlock

A deadlock requires all four **Coffman conditions**: mutual exclusion (a resource can only be held by one transaction), hold-and-wait (a transaction holds one lock while waiting for another), no preemption (locks can't be forcibly taken away), and circular wait (a cycle of transactions each waiting on the next). Databases can't remove mutual exclusion or preemption without breaking correctness, so prevention focuses on breaking hold-and-wait or circular wait.

**Worked scenario**, two sessions updating the same two rows in opposite order:

```sql
-- Session A                          -- Session B
BEGIN TRAN;                           BEGIN TRAN;
UPDATE accounts SET bal -= 100        UPDATE accounts SET bal += 50
  WHERE id = 1;   -- A holds X on 1     WHERE id = 2;   -- B holds X on 2
-- (pause)                            -- (pause)
UPDATE accounts SET bal += 100        UPDATE accounts SET bal -= 50
  WHERE id = 2;   -- A waits for B      WHERE id = 1;   -- B waits for A
```

```mermaid
flowchart LR
    A["Session A<br/>holds lock on row 1"] -->|"waits for row 2"| B["Session B<br/>holds lock on row 2"]
    B -->|"waits for row 1"| A
```

Neither session can proceed. The database has to step in.

## Detection and victim selection

Databases periodically build a **wait-for graph** — a node per transaction, an edge from A to B if A waits on a lock B holds — and check for cycles (SQL Server does this roughly every 5 seconds by default, more often under contention; Postgres checks on every lock wait after `deadlock_timeout`, default 1 second). When a cycle is found, the engine picks a **victim** — usually the transaction that is cheapest to roll back — and kills it with an error, letting the other proceed. You can bias this with `SET DEADLOCK_PRIORITY` in SQL Server if one transaction must never be the victim.

> [!TIP]
> A senior answer names the trade-off: detection isn't instant, so a deadlock adds latency equal to the detection interval before either session gets unblocked. That's why prevention matters more than detection tuning.

## Preventing and diagnosing deadlocks

- **Consistent access order** — always touch tables/rows in the same order (e.g., always debit the lower account ID first) to break circular wait.
- **Shorter transactions** — commit as soon as possible; don't hold locks across a network call or user think-time.
- **Appropriate isolation level** — Read Committed Snapshot Isolation (RCSI) in SQL Server or Postgres's default MVCC means readers don't block writers at all, eliminating a huge class of reader/writer deadlocks.
- **Covering indexes** — a query that can be satisfied entirely from an index touches far fewer rows/pages than one that falls back to key lookups, shrinking the lock footprint and the chance of overlap.
- **Retry logic** — deadlocks are expected in a busy system; the losing transaction should retry, not surface an error to the user.

Diagnosing after the fact: SQL Server's system_health extended event session (or trace flag 1222) captures a **deadlock graph** showing exactly which statements and resources were involved; Postgres logs the two conflicting queries and lock types when `log_lock_waits` is on. For *blocking* (not deadlocks), query `sys.dm_exec_requests` joined to `sys.dm_tran_locks` (SQL Server) or `pg_locks` joined to `pg_stat_activity` (Postgres) to see who is blocking whom right now.

```csharp
// Application-level retry for deadlock victims
async Task<int> ExecuteWithRetryAsync(Func<Task<int>> work, int maxAttempts = 3) {
    for (int attempt = 1; ; attempt++) {
        try {
            return await work();
        } catch (SqlException ex) when (ex.Number == 1205 && attempt < maxAttempts) {
            await Task.Delay(TimeSpan.FromMilliseconds(50 * attempt)); // simple backoff
        }
    }
}
```

> [!DANGER]
> Never retry blindly on *every* exception — only on the specific deadlock/timeout error codes. Retrying a constraint violation or a business-logic error just repeats a guaranteed failure and wastes a connection.

## Cheat sheet

- Locks enforce isolation; the four flavours are shared, exclusive, update and intent.
- Update locks exist to stop two readers from deadlocking on upgrade to exclusive.
- Row → page → table is the granularity ladder; escalation trades concurrency for memory.
- Blocking resolves itself; a deadlock never does — the engine must kill a victim.
- Deadlocks need all four Coffman conditions; breaking any one prevents them.
- Consistent lock ordering is the single most effective deadlock prevention technique.
- RCSI/MVCC removes most reader-vs-writer deadlocks by not taking read locks at all.
- Always retry deadlock victims (error 1205 / SQLSTATE 40P01) with backoff — never surface them to users.
- Diagnose with the deadlock graph for what happened, and lock DMVs/`pg_locks` for what is happening right now.

## Common mistakes

| Mistake | Fix |
|---|---|
| Treating every blocking query as a "deadlock" | Blocking resolves itself; only a cycle is a deadlock |
| Updating rows/tables in inconsistent order across code paths | Standardise an access order (e.g., always by ascending primary key) |
| Retrying on every `SqlException` | Filter to error 1205/40P01 specifically |
| Running huge batch updates in one transaction | Chunk into smaller transactions to avoid lock escalation |
| Assuming reads never cause deadlocks | Update locks and lock escalation can deadlock reader-heavy workloads too |
| Ignoring isolation level as a lever | Read Committed Snapshot/MVCC removes a whole class of contention |

## Summary

Locks make concurrent transactions safe by making them wait for each other; deadlocks are the pathological case where waiting forms a cycle that never breaks on its own. The database can only detect and kill a victim — your job is prevention: consistent lock ordering, short transactions, the right isolation level, lean indexes, and retry logic that treats a deadlock as an expected, recoverable event rather than a bug.

## Top Interview Questions

### Q1. What is the difference between a shared lock and an exclusive lock?

A shared (S) lock is taken for reads and is compatible with other shared locks — many transactions can read the same row simultaneously. An exclusive (X) lock is taken for writes and is incompatible with every other lock, including other exclusive locks and shared locks, so a writer blocks all readers and writers until it commits or rolls back. Most engines also have an update (U) lock, taken when a statement might later write a row it's currently reading, specifically to prevent two concurrent readers from both trying to upgrade to exclusive and deadlocking each other.

### Q2. What are intent locks and why do they exist?

Intent locks (IS, IX, SIX) are taken at a coarser granularity (table or page) to announce "a lock of this type exists somewhere below me." Without them, a transaction wanting a table-level exclusive lock would have to scan every row to check for conflicts. With intent locks, it just checks the table-level intent lock list — an O(1) check instead of an O(n) scan. They never conflict with locks on different rows; they exist purely to make higher-granularity lock checks fast.

### Q3. Explain the four conditions required for a deadlock.

Mutual exclusion (a resource can be held by only one transaction at a time), hold-and-wait (a transaction holds at least one resource while waiting for another), no preemption (a held resource cannot be forcibly taken away), and circular wait (a cycle of transactions each waiting on a resource held by the next). All four must hold simultaneously; databases can't safely remove mutual exclusion or preemption, so real prevention strategies target hold-and-wait (shorter transactions, fewer locks) or circular wait (consistent access ordering).

### Q4. How does a database detect a deadlock, and what happens next?

The engine periodically builds a wait-for graph — one node per transaction, an edge from A to B when A is waiting on a lock B holds — and searches for cycles. SQL Server does this roughly every 5 seconds by default (faster under contention); Postgres checks after `deadlock_timeout` (default 1 second) whenever a transaction starts waiting. On finding a cycle, the engine picks a victim, typically the transaction that is cheapest to roll back or has been running for less time, kills it with an error (1205 in SQL Server, `deadlock detected`/40P01 in Postgres), and lets the surviving transaction continue.

### Q5. Two transactions each update two rows in a different order and deadlock. Walk through what happened and how you'd fix it.

Session A updates row 1 (taking an exclusive lock) then tries to update row 2; Session B updates row 2 first, then tries to update row 1. Each now waits for a lock the other holds — a two-node cycle, so all four Coffman conditions are met and the database kills one of them. The fix is to make both code paths acquire locks in the same order, e.g. always update the lower primary key first, or always go through a single stored procedure/repository method that enforces that order. This eliminates circular wait entirely without touching isolation levels or transaction length.

### Q6. Your application is throwing intermittent deadlock exceptions in production. How do you diagnose and fix it?

First, capture the deadlock graph — SQL Server's `system_health` extended event session or trace flag 1222, or Postgres logs with `log_lock_waits = on` — to see the exact two statements and resources involved, not just "a deadlock happened somewhere." Look for inconsistent access order between the two code paths, or a covering-index gap that's forcing a wider row scan than necessary. Short term, add retry logic around the specific deadlock error code with exponential backoff so the losing transaction just replays. Longer term, fix the access order or shrink the transaction so the lock is held for a shorter window. I'd also check whether lock escalation is involved — a batch job escalating to a table lock is a common trigger that a graph will reveal immediately.

### Q7. What's the difference between blocking and a deadlock, and why does that distinction matter operationally?

Blocking is a transaction waiting for a lock held by another; it resolves itself the moment the holder commits or rolls back, and is a normal, expected cost of isolation. A deadlock is a *circular* wait that will never resolve on its own — the database must actively detect it and kill a participant. Operationally this matters because you monitor and alert on them differently: excessive blocking shows up as rising query latency and lock-wait time (fixable by shorter transactions or better indexes), while deadlocks show up as explicit error codes that need application-level retry handling. Conflating them leads to chasing the wrong fix.

### Q8. How does isolation level choice affect deadlock frequency?

Under Read Committed with locking reads (the traditional default), readers take shared locks that can conflict with writers and with each other's upgrade attempts, increasing deadlock surface. Read Committed Snapshot Isolation (SQL Server) or Postgres's MVCC-based Read Committed give readers a consistent snapshot instead of taking locks at all, so readers never block writers or deadlock with them — only writer-vs-writer conflicts remain. Higher isolation levels like Serializable go the other way: they take range locks (or use predicate locking) to prevent phantoms, which increases both blocking and deadlock risk. The trade-off is correctness guarantees versus concurrency, and it's worth naming explicitly in an interview.

### Q9. What is lock escalation and why can it hurt an otherwise healthy system?

Lock escalation is when the engine converts many fine-grained row or page locks held by a single statement into one coarser table lock, to cap the memory overhead of tracking thousands of individual locks (SQL Server's default threshold is around 5,000 locks). The downside is that a table lock blocks every other reader and writer on that table, so a large batch update that would otherwise only contend on a handful of rows suddenly blocks the entire application. The fix is to run large updates/deletes in smaller batches (e.g., 1,000–5,000 rows per transaction) so the statement never crosses the escalation threshold.

### Q10. Why should covering indexes be part of a deadlock-prevention strategy?

A query that can be satisfied entirely from an index (a "covering" index containing every column the query needs) touches only the index pages relevant to the predicate. Without one, the engine has to do key/RID lookups back to the base table for every matching row, taking locks on more pages and rows than the logical result set requires, and holding them for longer. That wider, longer-lived footprint increases the chance of overlapping with another transaction's lock set — so a covering index is both a performance optimization and a way to shrink the surface area available for deadlocks and blocking.

### Q11. Should an application ever just retry on any exception to "fix" deadlocks?

No — retries should be scoped to the specific error that indicates the transaction was chosen as a deadlock victim (error 1205 in SQL Server, SQLSTATE 40P01 in Postgres/MySQL), with a small randomized backoff to avoid immediately re-colliding with the same competitor. Retrying on arbitrary exceptions is dangerous: a constraint violation, a business-rule failure, or a genuine bug will simply fail again identically, waste connections/threads, and mask the real problem from monitoring. The retry wrapper should also cap attempts (e.g., 3) and log every retry so persistent deadlocking on a hot code path gets noticed rather than silently absorbed forever.

### Q12. Can a deadlock happen between a single transaction and itself, or only between two or more sessions?

Practically, a deadlock always involves two or more separate sessions/transactions forming a cycle — a single session executing statements sequentially can't wait on a lock it already holds under normal locking rules (most engines allow lock re-entrancy within the same transaction). What looks like "self-deadlock" is usually two different connections from the same application (e.g., a request opening a second connection mid-transaction, or a nested `TransactionScope` on a different connection) that are logically the same "user" action but are, to the database, two independent transactions competing for the same resources in opposite order.
