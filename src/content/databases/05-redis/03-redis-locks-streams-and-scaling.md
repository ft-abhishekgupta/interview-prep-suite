---
title: Redis Locks, Streams and Scaling
description: Distributed locking with SET NX and fencing tokens, Streams as a lightweight queue, persistence and replication, and Cluster hash slots at scale
difficulty: Advanced
tags: [redis, distributed-locks, streams, scaling, replication]
---

Beyond caching, Redis is often reached for as a distributed lock, a lightweight queue, and a horizontally-scaled cluster — each of these has sharp edges that make good interview material, because "just use Redis for that" is rarely the whole answer.

## Distributed locks with SET NX PX

A basic distributed lock is a single atomic command:

```
SET lock:order:9001 "client-a-token-123" NX PX 30000
```

`NX` (only set if absent) makes acquisition atomic; `PX 30000` gives the lock a 30-second expiry so a crashed holder doesn't lock the resource forever. The token (a random UUID, not a constant) is what makes **release safe** — you must never blindly `DEL` the key, because if your work took longer than the TTL, the lock might already belong to someone else. Release with a Lua script that checks the token first:

```lua
-- compare-and-delete: only unlock if we still own it
if redis.call("GET", KEYS[1]) == ARGV[1] then
    return redis.call("DEL", KEYS[1])
else
    return 0
end
```

> [!DANGER]
> `DEL` without checking ownership is the single most common distributed-lock bug: client A's lock expires, client B acquires it, then client A finishes late and deletes client B's lock — now two clients believe they hold it. Always compare-and-delete via Lua.

## Lock expiry vs work duration, and fencing tokens

The lock TTL is a guess about how long the protected work takes. If the actual work runs longer (a slow GC pause, a network stall), the lock can expire **while the client still thinks it holds it**, letting a second client acquire it — both now believe they have exclusive access.

**Fencing tokens** fix the consequence, not the race itself: the lock service hands out a monotonically increasing number with each acquisition, and the protected resource (e.g., a storage service) rejects any write tagged with a token lower than the highest it has already seen. Even if two clients briefly believe they hold the lock, only the one with the higher token can successfully write.

```mermaid
sequenceDiagram
    participant C1 as "Client A"
    participant C2 as "Client B"
    participant R as "Storage"
    C1->>R: write(token=1)
    R-->>C1: ok (highest seen = 1)
    C2->>R: write(token=2)
    R-->>C2: ok (highest seen = 2)
    C1->>R: write(token=1, delayed)
    R-->>C1: rejected (1 < 2)
```

> [!KEY]
> A lock without a fencing token only prevents *concurrent acquisition* — it does not prevent a delayed, stale client from still doing damage after its lock expired. Fencing tokens are what make the lock actually safe for protecting a write.

## Redlock and its criticisms

**Redlock** acquires the same lock against N independent Redis instances (typically 5) and considers it held only if a majority succeed within a time budget, aiming to survive a single instance failing. It's controversial: Martin Kleppmann's well-known critique argues Redlock still doesn't solve the fundamental problem — without fencing tokens at the resource being protected, a process pause (GC, network delay) can still let two clients believe they hold the lock, regardless of how many Redis nodes were consulted. The practical takeaway for an interview: name both sides — Redlock raises availability of the *lock service* itself, but the token-based mutual exclusion problem needs fencing at the protected resource either way.

## Redis Streams as a lightweight queue

A stream is an append-only log of entries, each with an auto-generated ID, that supports **consumer groups** — multiple independent workers sharing the work, each entry delivered to exactly one consumer per group.

```
XADD orders * orderId 9001 status "placed"
XREADGROUP GROUP workers consumer-1 COUNT 10 STREAMS orders >
XACK orders workers 1718000000000-0
XPENDING orders workers                 # see unacknowledged entries
XCLAIM orders workers consumer-2 60000 1718000000000-0  # reassign a stuck entry
```

| | Redis Streams | Kafka |
|---|---|---|
| Persistence model | In-memory (optionally RDB/AOF-backed) | Disk-backed log, designed for retention |
| Throughput ceiling | High, but bounded by single-node memory/CPU | Much higher, built for massive sustained throughput |
| Ordering | Per-stream | Per-partition |
| Operational weight | Lightweight, same infra as your cache | Heavier — dedicated cluster, ZooKeeper/KRaft |
| Best fit | Moderate-volume event/task queues already using Redis | High-volume event streaming, long retention, multiple downstream systems |

> [!TIP]
> A senior answer names Streams as "good enough" for moderate-volume, at-least-once processing when you already run Redis and don't want to stand up Kafka — not as a Kafka replacement at real streaming scale.

## Pub/sub — fire and forget

`PUBLISH channel message` / `SUBSCRIBE channel` delivers messages only to clients connected *at that instant* — there's no storage, no replay, and no acknowledgement. A subscriber that's disconnected for even a moment misses every message sent during that gap. Use pub/sub for ephemeral fan-out (cache invalidation notifications, live dashboard updates) and Streams for anything that must not be lost.

## Persistence: RDB vs AOF

| | RDB (snapshot) | AOF (append-only file) |
|---|---|---|
| What it stores | Point-in-time binary snapshot | Every write command, replayed on restart |
| Data loss window | Up to the interval between snapshots (minutes) | As low as 1 second (`everysec`) or none (`always`, at a latency cost) |
| Restart speed | Fast (load one snapshot) | Slower (replay the log, though rewriting compacts it) |
| File size | Compact | Larger, grows until rewritten/compacted |
| Typical choice | Acceptable for pure caches | Preferred when Redis holds data you can't easily lose (locks, streams, queues) |

Many production deployments enable both: AOF for durability, with periodic RDB snapshots for fast full restores.

## Replication and Sentinel

A primary asynchronously replicates writes to one or more replicas; reads can be scaled out across replicas, but writes always go to the primary. **Redis Sentinel** monitors primary/replica health and performs automatic failover — promoting a replica to primary if the current primary is unreachable — without a human in the loop. Because replication is asynchronous, a failover can lose the last few unreplicated writes; this is an explicit availability-over-consistency trade, not a bug.

## Redis Cluster: hash slots, resharding, cross-slot operations

Redis Cluster partitions the keyspace into **16,384 hash slots**, each key mapped by `CRC16(key) mod 16384`, and each node owns a subset of slots. This lets the cluster scale horizontally: adding a node means moving a portion of the slots (and their keys) to it — **resharding** — without changing which slot a key belongs to.

```mermaid
flowchart LR
    K["Key: user:42"] --> H["CRC16 hash mod 16384"]
    H --> S["Slot 5474"]
    S --> N["Node B owns slots 5461-10922"]
```

Multi-key operations (`MGET`, transactions, Lua scripts touching multiple keys) only work if every key involved maps to the **same slot** — the cluster rejects cross-slot operations outright. **Hash tags** solve this: wrapping the part of the key that should determine the slot in braces, e.g. `{user:42}:profile` and `{user:42}:orders`, forces both keys to hash only on `user:42` and land on the same slot, making them safe to use together in a transaction or a multi-key Lua script.

> [!WARNING]
> Forgetting hash tags is the most common Redis Cluster surprise: a `MULTI`/`EXEC` or Lua script that worked fine in single-node testing throws a `CROSSSLOT` error the moment it runs against a real cluster with unrelated keys.

## When Redis is the wrong tool

- **Durable, transactional, relational data** — Redis is not a system of record for anything you can't afford to lose or that needs multi-entity ACID transactions; use a relational database.
- **Very high sustained event throughput with long retention** — Kafka is built for this; Streams will hit memory and single-node ceilings first.
- **Complex ad-hoc queries** — Redis has no query planner; it answers exactly the access patterns you designed keys for.
- **Data much larger than available memory** — Redis is fundamentally an in-memory store; disk-backed persistence is for durability, not for exceeding RAM as a working set.

## Cheat sheet

- `SET key token NX PX ttl` acquires a lock atomically; always release via a Lua compare-and-delete on the token, never a blind `DEL`.
- Fencing tokens (monotonically increasing, checked at the protected resource) are what actually make a lock safe against delayed/stale clients — the lock alone isn't enough.
- Redlock raises the availability of the lock service across nodes but doesn't remove the need for fencing tokens at the resource.
- Streams give consumer groups, acknowledgement, and a pending-entries list — a lightweight queue, not a Kafka replacement at real streaming scale.
- Pub/sub is fire-and-forget: no storage, no replay, missed while disconnected.
- AOF gives much better durability than RDB at the cost of larger files and slower restarts; many setups use both.
- Sentinel automates primary/replica failover; async replication means a failover can lose the last few writes.
- Cluster splits the keyspace into 16,384 hash slots; multi-key operations need hash tags to force the same slot.

## Common mistakes

| Mistake | Fix |
|---|---|
| Releasing a lock with a blind `DEL` | Use a Lua script that checks the owning token before deleting |
| Assuming a lock alone makes a distributed write safe | Add fencing tokens checked at the protected resource |
| Treating pub/sub as reliable delivery | Use Streams (or a real queue) when messages must not be lost |
| Choosing Streams for very high-volume, long-retention event pipelines | Use Kafka; Streams is bounded by single-node memory |
| Writing a Lua script or transaction touching unrelated keys on a cluster | Use hash tags (`{tag}`) to force related keys onto the same slot |
| Relying on RDB alone for data you can't afford to lose | Enable AOF (`everysec` at minimum) |

## Summary

Redis's locking, streaming and clustering features all share the same shape: a fast, simple primitive that solves the common case cleanly, with a sharp edge that only shows up under failure or scale. Locks need fencing tokens to be truly safe, not just atomic acquisition; Streams are a capable lightweight queue but not a Kafka replacement; and Cluster's hash-slot model demands hash tags the moment a multi-key operation is needed. Knowing the primitive and its edge case together is what separates "I've used Redis" from "I can be trusted to run it in production."

## Top Interview Questions

### Q1. How do you implement a safe distributed lock in Redis?

Acquire with `SET lock:resource <random-token> NX PX <ttl-ms>` — `NX` makes the acquisition atomic (only succeeds if no one else holds it), and `PX` bounds how long the lock survives if the holder crashes. The token must be unique per acquisition (a UUID, not a constant), because release must never be a blind `DEL` — instead, run a small Lua script that first checks the stored value equals your token, and only then deletes it. This "compare-and-delete" step prevents a client from accidentally releasing a lock that expired and was subsequently acquired by someone else.

### Q2. Why is a blind `DEL` to release a lock dangerous, and what's the fix?

If client A's lock expires (because its work ran longer than the TTL) before it calls `DEL`, another client B can legitimately acquire the same lock in the meantime. If A then calls a blind `DEL` on the key, it deletes B's active lock, not its own expired one — both A and B may now believe, at different points, that they hold exclusive access, defeating the entire purpose of the lock. The fix is a Lua script that atomically checks the value stored under the key still equals the token you set when acquiring, and only deletes if it matches — otherwise it's a no-op, because the lock isn't yours anymore.

### Q3. What is a fencing token and why do locks need one for true safety?

A fencing token is a monotonically increasing number issued by the lock service each time the lock is acquired, which the client must attach to every subsequent write it makes to the resource the lock protects. The protected resource itself rejects any write carrying a token lower than the highest one it has already accepted. This matters because a lock's TTL is just a guess — a client can experience a long pause (GC, network stall, VM suspend) after acquiring the lock but before finishing its work, during which the lock can expire and a second client can acquire it. Both clients might now try to write, believing they're the sole owner; without a fencing token, whichever write arrives second at the resource wins, potentially overwriting the correct one. With fencing tokens, the resource enforces that only the write with the higher token succeeds, regardless of arrival order.

### Q4. What is Redlock, and what's the core criticism of it?

Redlock is an algorithm for acquiring a lock across N independent Redis instances (commonly 5), considering the lock held only if a majority acquire it within a bounded time, intended to survive the failure of a minority of instances. The core criticism, most notably from Martin Kleppmann, is that Redlock's majority-quorum mechanism addresses the *availability* of the lock service (surviving node failures) but doesn't address the underlying safety problem: a process pause on the client side can still let the lock expire and be reacquired elsewhere regardless of how many Redis nodes agreed to grant it. Kleppmann's position is that true safety for the *protected resource* requires fencing tokens there, independent of how many Redis nodes you consulted to get the lock. The balanced interview answer: Redlock is a reasonable availability improvement for the lock service, but it isn't a substitute for fencing tokens if correctness under process pauses genuinely matters.

### Q5. How do Redis Streams differ from a plain Redis list used as a queue?

A list gives basic FIFO push/pop (`LPUSH`/`BRPOP`) with no built-in concept of multiple independent consumers, acknowledgement, or replay — once an item is popped, it's gone, and if the consumer crashes mid-processing, the item is lost. A stream is an append-only log where each entry keeps its position, and **consumer groups** let multiple independent groups of workers each process the same stream from their own cursor, with `XREADGROUP` handing an entry to exactly one consumer within a group, `XACK` confirming successful processing, and `XPENDING`/`XCLAIM` letting you find and reassign entries a crashed consumer never acknowledged. This gives at-least-once delivery semantics a plain list can't, at the cost of slightly more complexity to use correctly.

### Q6. When would you choose Redis Streams over Kafka, and when would you not?

I'd choose Streams when the team already runs Redis, the event volume is moderate rather than massive, retention needs are short-to-medium, and the operational simplicity of not standing up a whole additional distributed system (Kafka plus ZooKeeper/KRaft) outweighs Kafka's higher ceiling. I would not choose Streams for very high sustained throughput, long-term retention (weeks/months of replay), or when multiple large downstream systems need to independently consume the same firehose — Kafka is disk-backed and built specifically for that scale, whereas Streams is fundamentally bounded by a single Redis node's memory and CPU. The interview signal is recognizing Streams as "a good lightweight queue we already have the infrastructure for," not "Kafka but simpler" in every dimension.

### Q7. Explain the difference between pub/sub and Streams, and give an example where using pub/sub would be a mistake.

Pub/sub is fire-and-forget: `PUBLISH` sends a message only to clients currently subscribed to the channel at that instant, with no storage and no way for a client that was briefly disconnected to catch up on what it missed. Streams persist every entry (subject to your persistence configuration) and support consumer groups with acknowledgement, so a consumer that restarts can resume exactly where it left off. Using pub/sub would be a mistake for something like "notify downstream services when an order is placed" if any of those services can be briefly offline or slow — they'd silently miss orders with no way to detect or recover the gap. Pub/sub is appropriate for things where a missed message has no lasting consequence, like invalidating a local cache or pushing a live dashboard update.

### Q8. Compare RDB and AOF persistence, and explain why some deployments run both.

RDB takes periodic point-in-time snapshots of the whole dataset — compact and fast to load on restart, but you can lose everything written since the last snapshot (potentially minutes of data). AOF logs every write command and replays them on restart, giving a much smaller data-loss window (as low as one second with `appendfsync everysec`, or effectively none with `always`, at a latency cost) but produces a larger file that grows until it's rewritten/compacted, and replay on restart is slower than loading a single RDB snapshot. Many production deployments enable both: AOF for durability guarantees, RDB for fast full restores and for portable backups, accepting the extra disk and CPU overhead of maintaining both.

### Q9. How does Redis Cluster distribute data, and what breaks if you don't use hash tags?

Redis Cluster divides the entire keyspace into 16,384 fixed hash slots; every key is mapped to a slot via `CRC16(key) mod 16384`, and each cluster node owns a contiguous range of slots, which can be rebalanced (resharded) as nodes are added or removed. Multi-key operations — a transaction, a Lua script touching more than one key, or commands like `MGET` across several keys — are only permitted if every key involved hashes to the same slot; otherwise the cluster returns a `CROSSSLOT` error. Hash tags fix this by wrapping the part of the key you want to hash in braces (`{user:42}:profile`, `{user:42}:orders`) so only that substring determines the slot, guaranteeing related keys land together and can be used in the same multi-key operation.

### Q10. How does Redis handle primary failure, and what's the consistency trade-off involved?

Redis Sentinel (or Cluster's built-in failure detection) monitors the primary and, on detecting it's unreachable, automatically promotes one of its replicas to primary and reconfigures the others to replicate from the new one — all without manual intervention. Because replication from primary to replicas is asynchronous by default, any writes acknowledged by the primary but not yet propagated to the replica that gets promoted are lost in the failover — this is an explicit availability-over-consistency choice, not an oversight. If losing the last few writes during a failover is unacceptable for a given use case, you'd need synchronous replication (`WAIT` command with a required replica acknowledgement count) at the cost of higher write latency, or accept that Redis isn't the right store for that specific data's durability requirements.

### Q11. Give an example of a workload where Redis is clearly the wrong tool, and explain why.

A financial ledger requiring durable, multi-entity ACID transactions (debit one account, credit another, atomically and durably) is a poor fit for Redis — even with AOF persistence and replication, Redis is fundamentally optimised for speed and simplicity, not for the kind of durable, multi-row, cross-entity transactional guarantees a relational database provides by design, and its transaction model (`MULTI`/`EXEC`) doesn't support rollback on a failed command mid-transaction the way a database does. I'd use Redis in front of such a system for caching account balances or rate-limiting transaction attempts, but the ledger itself belongs in a database built for durable, transactional correctness — reaching for Redis there trades a well-understood correctness model for speed you don't actually need on that path.
