---
title: Distributed Locks
description: Why a single database row is not enough to coordinate work across machines, and how fencing tokens fix the lock-expiry problem that Redlock alone cannot solve
difficulty: Advanced
tags: [distributed-locks, redis, consistency, fencing-tokens, coordination]
---

A distributed lock lets multiple processes on multiple machines agree that only one of them may touch a given resource at a time. It sounds like a simple mutex, but network partitions, process pauses and clock drift mean a naive implementation is almost always subtly broken — and this is one of the favorite "make the candidate think on their feet" topics at senior level.

## Why you need one

A regular in-process lock (a `synchronized` block, a `ReentrantLock`) only coordinates threads inside one process. The moment your seat-reservation logic, your scheduled-job runner, or your cache-warming routine runs on more than one machine, you need coordination that lives **outside** any single process — in Redis, a database row, or a coordination service like ZooKeeper or etcd.

Typical use cases: "only one node should run this cron job", "hold this seat for 10 minutes while the user checks out", "only one worker should process this batch at a time".

## What a correct distributed lock needs

| Requirement | Meaning | What breaks it |
|---|---|---|
| **Mutual exclusion** | Only one holder at a time | Race between two `SET NX` calls without atomicity |
| **Deadlock freedom** | The lock is always eventually released, even if the holder crashes | No TTL / expiry on the lock |
| **Fault tolerance** | Survives the failure of the node holding the lock | Single point of failure in the lock store |
| **Safety under a paused holder** | A holder that resumes after its lock expired must not act as if it still holds it | No fencing token — the classic gap |

> [!KEY]
> A lock with a TTL solves deadlock freedom but reopens mutual exclusion: the TTL can expire while the original holder is still working, letting a second process acquire the lock while the first still believes it holds it. Fencing tokens are the fix, not a nice-to-have.

## Redis: SET NX with TTL

The simplest practical distributed lock is a single atomic command.

```java
// SET key value NX PX ttlMs — atomic acquire with auto-expiry
String result = jedis.set(
    "lock:seat:42", ownerToken, SetParams.setParams().nx().px(10_000));
boolean acquired = "OK".equals(result);

if (acquired) {
    try {
        doCriticalWork();
    } finally {
        // Release only if we still own it — compare-and-delete via Lua script
        releaseLockIfOwned("lock:seat:42", ownerToken);
    }
}
```

`SET key value NX PX 10000` atomically creates the key only if it doesn't exist, with a 10-second expiry — this single command satisfies mutual exclusion and deadlock freedom in one round trip. Releasing must be a **compare-and-delete** (a Lua script checking the owner token before deleting), never a bare `DEL`, or process A can accidentally release a lock now held by process B after A's TTL expired.

## The fencing token problem

Imagine process A acquires the lock, then experiences a long GC pause (or a network stall). Its lock's TTL expires while it is frozen. Process B now acquires the lock and starts working. Process A wakes up, still believing it holds the lock, and writes to the shared resource — **two processes now think they are the sole holder.**

```mermaid
sequenceDiagram
    participant A as "Process A"
    participant L as "Lock service"
    participant R as "Shared resource"
    participant B as "Process B"
    A->>L: "acquire lock (TTL 10s)"
    L-->>A: "granted, token=33"
    Note over A: "GC pause / network stall > 10s"
    L->>L: "TTL expires"
    B->>L: "acquire lock"
    L-->>B: "granted, token=34"
    B->>R: "write (fencing token 34)"
    Note over A: "A wakes up, still thinks it holds the lock"
    A->>R: "write (fencing token 33) — REJECTED, 33 < 34"
```

The fix: every time the lock is granted, hand out a **monotonically increasing fencing token**. The shared resource itself checks the token and **rejects any write carrying a token lower than the highest it has already seen** — even from a process that "believes" it still holds the lock. The lock service alone cannot prevent this; the resource being protected must participate.

> [!WARNING]
> "Use a distributed lock" is not, by itself, a correct answer to a concurrency question. The complete answer includes fencing tokens, because the lock only *reduces* the chance of concurrent access — the resource must enforce ordering itself to guarantee it.

## Redlock and its criticisms

**Redlock** is Redis's proposed algorithm for a lock that survives the failure of a single Redis node: acquire the same lock (with the same TTL) against a majority of N independent Redis instances (e.g. 3 of 5), and consider it held only if a majority succeeds within a time budget.

- **Argument for:** more fault-tolerant than a single Redis instance, which is a single point of failure.
- **Argument against (Martin Kleppmann's critique):** Redlock still doesn't solve the fencing-token problem — it only makes acquiring the lock more fault-tolerant, not the "paused holder still acts" scenario. It also has subtle failure modes if clocks drift or if a Redis instance restarts fast enough to still hold stale state without losing its data (e.g. AOF persistence with a bug).

> [!NOTE]
> Say this in an interview: *"Redlock improves lock availability across multiple Redis nodes, but it doesn't remove the need for fencing tokens if I need a true safety guarantee, not just 'better than one node'."* This shows you understand what the algorithm actually claims to fix.

## ZooKeeper / etcd: ephemeral nodes

Coordination services designed exactly for this problem are the "correct" answer when correctness matters more than raw speed.

- **ZooKeeper**: create an **ephemeral sequential znode**; the client holding the lowest-numbered znode holds the lock. If the client's session dies (heartbeat stops), the znode is automatically deleted, releasing the lock — no manual TTL guessing.
- **etcd**: a **lease** with a TTL, refreshed by heartbeats; a lock is a key tied to the lease, released automatically when the lease expires or the client disconnects.

Both give you a **watch/notify** mechanism so waiters are told immediately when the lock is released, instead of polling — and both run on Raft, so they tolerate node failures without a single point of failure the way one Redis node would.

| Mechanism | Lock backing | Release trigger | Notify waiters |
|---|---|---|---|
| **Redis `SET NX PX`** | Single key with TTL | TTL expiry or explicit delete | Polling, or Redis keyspace notifications |
| **Redlock** | Majority of N Redis nodes | TTL expiry on majority | Polling |
| **ZooKeeper** | Ephemeral sequential znode | Session/heartbeat death | Native watch |
| **etcd** | Key tied to a lease | Lease expiry or disconnect | Native watch |
| **DB row / advisory lock** | A row with a status + owner, or `pg_advisory_lock` | Explicit release or connection close | Polling |

## Database row locks and advisory locks

For simpler cases, the database you already have is often enough. A row with an `owner` and `expires_at` column, updated with a conditional `WHERE` clause, gives you a lock without new infrastructure. PostgreSQL also has native **advisory locks** (`pg_advisory_lock(key)`), held for the lifetime of the session/transaction — lightweight and built in, but tied to a live database connection, so a connection drop must be handled carefully.

```sql
-- Conditional acquire: only succeeds if unlocked or expired
UPDATE locks
SET owner = 'worker-7', expires_at = now() + interval '10 seconds'
WHERE lock_name = 'nightly-report'
  AND (owner IS NULL OR expires_at < now());
-- Check rows affected = 1 to know if you got it
```

## Lease renewal

Long-running work under a lock should **renew the lease** (extend the TTL) periodically rather than picking one giant TTL upfront — a heartbeat every few seconds that says "I'm still alive, still working" lets you use a short TTL (fast failure detection) without risking the lock expiring mid-task. If the heartbeat stops (the process died or paused too long), the lock expires quickly and someone else can take over.

## Alternatives to a distributed lock

Locking is often the wrong tool entirely — it adds latency, contention, and a whole new failure mode. Consider these first:

| Alternative | Idea | When it's better than a lock |
|---|---|---|
| **Idempotency** | Make the operation safe to run twice (dedupe key, conditional write) | Retries and duplicate delivery are expected anyway |
| **Partitioning by key** | Route all work for a given key to exactly one consumer/partition | Ordering per key matters more than global mutual exclusion |
| **Single writer** | Designate one owner (leader) for a class of writes | Avoids contention entirely rather than serializing it |
| **Optimistic concurrency** | Version/ETag + conditional write, retry on conflict | Conflicts are rare; avoids holding a lock at all |

> [!TIP]
> A senior answer to "how do you prevent two workers processing the same row" often isn't "add a distributed lock" — it's "partition the queue by key so the same row always routes to the same consumer" or "make the update idempotent with a conditional write", both of which avoid the lock's cost and failure modes altogether.

## Cheat sheet

- A distributed lock needs **mutual exclusion + deadlock freedom + fault tolerance**, and a TTL alone only gives you the first two.
- **`SET NX PX`** in Redis is the fast, simple default for low-stakes locks.
- **Fencing tokens** are the actual fix for "the lock holder paused and woke up believing it's still valid" — the *resource*, not the lock service, must reject stale tokens.
- **Redlock** improves availability across Redis nodes but does **not** by itself solve the fencing-token problem.
- **ZooKeeper/etcd** give you session-based automatic release and native watch/notify — reach for these when correctness matters more than raw speed.
- **Renew leases** with heartbeats instead of picking one long TTL.
- Locking is not free — consider **idempotency, partitioning by key, or a single writer** before reaching for a distributed lock.
- Always release via **compare-and-delete**, never a bare delete.

## Common mistakes

| Mistake | Fix |
|---|---|
| Lock with no TTL | Deadlock forever if the holder crashes — always set an expiry |
| Releasing with a bare `DEL` | Use compare-and-delete (check owner token) so you don't release someone else's lock |
| Assuming a lock guarantees safety without fencing tokens | Have the protected resource reject stale tokens too |
| One giant TTL for variable-length work | Renew the lease periodically with heartbeats instead |
| Reaching for a distributed lock by default | Consider idempotency or partitioning by key first |
| Treating Redlock as a complete correctness fix | It improves availability, not the paused-holder problem |

## Summary

A distributed lock must guarantee mutual exclusion, deadlock freedom and fault tolerance, but a TTL that solves deadlock freedom reopens a subtler bug: a paused holder can wake up and act as if it still owns a lock that has already expired and been reacquired. Fencing tokens close this gap by making the protected resource itself reject stale writes, which is why "add a Redis lock" is an incomplete answer without them. Redis `SET NX PX` is the fast default, Redlock trades single-node risk for a quorum without removing the fencing problem, and ZooKeeper/etcd give you session-based safety with native notifications when correctness matters most. Before reaching for any of them, ask whether idempotency, key-based partitioning, or a single writer would remove the need for a lock entirely.

## Top Interview Questions

### Q1. What are the core requirements a distributed lock must satisfy?

A correct distributed lock needs mutual exclusion (only one holder at a time), deadlock freedom (the lock is always eventually released, even if the holder crashes, typically via a TTL), and fault tolerance (it survives failure of the node holding it or the lock service itself). A subtler fourth requirement is safety under a paused holder — a process whose lock has expired must not be able to act as if it still holds it once it resumes, which is where fencing tokens come in. Interviewers listen for whether you mention this fourth point, since the first three are the "obvious" answer.

### Q2. How would you implement a simple distributed lock using Redis?

Use the atomic `SET key value NX PX ttlMs` command: it creates the key only if it doesn't already exist, with an automatic expiry, all in one round trip, giving you mutual exclusion and deadlock freedom together. The value should be a unique token identifying the current holder (a UUID), so that releasing the lock is a compare-and-delete — a small Lua script that checks the stored value matches before deleting — rather than a bare `DEL`, which could accidentally release a lock now held by a different process after your TTL expired.

### Q3. What is the fencing token problem, and how do you actually fix it?

If a lock holder pauses for longer than the lock's TTL (a long GC pause, a network stall, a slow disk write) the lock can expire and be granted to a second process while the first process is still "convinced" it holds it; when the first process resumes, both processes now believe they have exclusive access. The lock service alone cannot prevent this because it has no way to stop the paused process from acting. The fix is a monotonically increasing fencing token issued every time the lock is granted, which the *protected resource itself* checks and rejects if it's lower than the highest token it has already seen — moving the safety check from the lock to the resource.

### Q4. What is Redlock, and what's the criticism against it?

Redlock is an algorithm for acquiring the same lock against a majority of N independent Redis instances (e.g. 3 of 5) so the lock survives the failure of any single Redis node, unlike relying on one instance which would be a single point of failure. The main criticism, notably from Martin Kleppmann, is that Redlock improves *availability* of lock acquisition but does not solve the fencing-token problem — a paused process can still wake up believing it holds the lock, and Redlock's safety also depends on synchronized clocks and precise timing assumptions that are hard to guarantee in the real world. The correct framing in an interview: Redlock is "better than a single Redis node," not "a complete correctness guarantee."

### Q5. How do ZooKeeper and etcd implement distributed locks differently from Redis?

Both use ephemeral, session-bound state rather than a manually managed TTL: ZooKeeper clients create an ephemeral sequential znode, and the client holding the lowest-numbered znode owns the lock; if the client's session dies (its heartbeat stops), ZooKeeper automatically deletes the znode and releases the lock. etcd uses a lease with a TTL that the client must refresh via heartbeats, and a lock key is tied to that lease so it's released automatically when the lease expires or the connection drops. Both also provide a native watch/notify mechanism, so waiting clients are told immediately when the lock frees up instead of polling, and both run on a consensus protocol (ZAB / Raft) so they tolerate node failures without a single point of failure.

### Q6. Explain what happens if a lock holder experiences a long garbage collection pause. Walk through the failure scenario.

Process A acquires the lock with a TTL of, say, 10 seconds, then hits a GC pause lasting 15 seconds. Its lock's TTL expires while it's frozen and unaware. Process B now successfully acquires the same lock and begins doing work on the shared resource. Fifteen seconds later, Process A resumes execution, still believing it holds the lock (it hasn't been told otherwise), and proceeds to write to the shared resource — now two processes are writing concurrently, exactly what the lock was supposed to prevent. This is precisely why a TTL-based lock alone is insufficient, and why the resource must validate a fencing token rather than trusting that "only the lock holder would ever write."

### Q7. When would you use a database row as a lock instead of Redis or ZooKeeper?

When you already have a relational database in the critical path and don't want to add new infrastructure for a moderate-frequency locking need — a row with an `owner` and `expires_at` column, acquired via a conditional `UPDATE ... WHERE owner IS NULL OR expires_at < now()`, gives you an atomic compare-and-set using infrastructure you already operate and monitor. PostgreSQL's native advisory locks (`pg_advisory_lock`) are another option, held for the life of a session/transaction, lightweight and built-in — but tied to a live connection, so connection drops need careful handling. This is a reasonable choice when lock frequency is low to moderate and simplicity outweighs raw performance.

### Q8. Why should a long-running task renew its lock lease instead of setting one large TTL upfront?

If you set a single TTL long enough to cover the worst-case duration of the work, you're stuck with slow failure detection — if the process dies early, nobody else can take over until that long TTL finally expires. Instead, renew ("heartbeat") the lease every few seconds while the work is actively progressing, which lets you use a short TTL for fast failure detection while still supporting arbitrarily long work, as long as the process is alive and renewing. If the heartbeats stop — because the process crashed or paused too long — the lock expires quickly and another worker can safely take over.

### Q9. What alternatives to a distributed lock would you consider before reaching for one?

Idempotency is often simpler and cheaper: if an operation can be made safe to execute twice (via a dedupe key, or a conditional/compare-and-set write), you don't need mutual exclusion at all — duplicate execution is harmless. Partitioning by key routes all operations on a given entity to exactly one consumer or partition (e.g. a Kafka partition keyed by user ID), which gives you per-key ordering and effective exclusivity without a lock service. Designating a single writer/leader for a class of writes avoids contention entirely rather than serializing around it. A distributed lock is the right tool when none of these fit — for example, reserving a physical seat for a limited window during checkout.

### Q10. In production, workers are occasionally processing the same job twice even though you use a Redis lock. How do you debug this?

First check whether the lock's TTL is shorter than the actual processing time under load — if jobs sometimes take longer than the TTL (due to GC pauses, slow downstream calls, or CPU contention), the lock can expire mid-job and a second worker picks it up, which is the classic fencing-token gap. Verify release logic uses compare-and-delete with an owner token, not a bare `DEL`, since a worker could otherwise release a lock it no longer owns. Also check for clock drift between nodes if TTLs are compared locally rather than relying on the lock service's own clock. The fix is usually: extend TTL with heartbeat renewal for long jobs, add fencing tokens checked at the point of actual work (e.g. a version check on the DB write), and make job processing idempotent as a safety net regardless.

### Q11. Is a distributed lock the right tool for "only one instance of my scheduled job should run at a time"? What would you actually build?

Yes, this is a textbook fit — a lock acquired at the start of the scheduled run, held for its duration with lease renewal, and released (or left to expire) at the end, so a second instance triggered concurrently (e.g. during a rolling deploy where old and new instances briefly overlap) simply fails to acquire the lock and exits immediately. Prefer ZooKeeper/etcd or a database row over ad hoc Redis for this if you already have leader-election infrastructure, since job scheduling and leader election are closely related problems; if not, a Redis `SET NX PX` lock with heartbeat renewal is a perfectly reasonable, low-infrastructure answer for most systems.

### Q12. How does a distributed lock differ from consensus-based leader election, and when would you use one over the other?

A distributed lock is typically acquired and released per operation or per short-lived task — it's transient, fine-grained coordination for one piece of work. Leader election designates one node as "the leader" for an extended period (minutes to hours), responsible for an entire class of decisions (e.g. "this node runs the scheduler" or "this node handles all writes for this partition"), and is usually implemented on top of the same primitives (ZooKeeper ephemeral znodes, etcd leases) but with different intent and lifetime. Use a lock for "let one of us do this one task"; use leader election for "let one of us be responsible for this whole category of work until further notice."
