---
title: Access Pattern Driven Modeling
description: The NoSQL mindset shift from modeling entities to modeling the exact queries your application will run, with single-table design and worked examples
difficulty: Advanced
tags: [nosql, data-modeling, dynamodb, single-table-design]
---

Relational modeling starts with entities and normalises; NoSQL modeling at scale starts with **queries** and works backwards. This is the single biggest mental shift interviewers probe for when discussing DynamoDB, Cassandra, or any partition-oriented store — get it wrong and every other answer in the conversation will sound like relational thinking bolted onto the wrong tool.

## Schema design starts before the keys

Even before choosing between a relational table and a single-table NoSQL item collection, schema design is a process with a fixed set of inputs and a fixed set of outputs — worth doing explicitly rather than discovering ad hoc while writing the first query.

![alt text](notes/05-HighLevelDesign/DatabaseModeling/image-1.png)

Three inputs drive everything that follows:

| Input | What it decides |
|---|---|
| Data volume | Whether the data lives on a single machine or needs to be distributed from day one |
| Access patterns | Whether the workload is read-heavy or write-heavy, and therefore how normalized or denormalized the schema should be |
| Consistency requirements | Whether you need strong consistency (most relational workloads) or can tolerate eventual consistency (most access-pattern-driven NoSQL workloads) |

And every schema design session should produce the same four outputs, in order: the tables or items and their relationships, the keys and constraints that enforce integrity, an explicit normalized-or-denormalized decision, and an indexing and sharding plan.

![alt text](notes/05-HighLevelDesign/DatabaseModeling/image-4.png)

Applied to a real schema, that process turns into a concrete sequence of decisions — pick the database, outline the columns, add primary and foreign keys, decide on indexes, decide whether to denormalize, and only then decide whether and how to shard:

![A six-step schema design checklist applied to a worked Postgres schema for Posts, Comments and Users, annotated with primary keys, foreign keys, indexes and the shard key](notes/05-HighLevelDesign/DatabaseModeling/image-2.png)

> [!TIP]
> A useful rule of thumb: data at rest in the database is usually normalized, while data at rest in a cache is usually denormalized. The database is optimized for write integrity; the cache is optimized for read speed — the same distinction that motivates access-pattern-driven modeling in the first place.

## Choosing the underlying data model

The access-pattern-driven mindset in this page applies most directly to key-value and document stores, but the decision of *which* family to reach for at all comes first, and a short, opinionated checklist earns its keep in an interview:

| Family | Default choice when | Skip it when |
|---|---|---|
| Relational (PostgreSQL, MySQL) | Data is structured and ACID guarantees matter — the default absent a specific reason to leave it | Access patterns are dominated by single-partition lookups at extreme scale |
| Document (MongoDB, Cosmos DB) | Data is unstructured or deeply nested, the schema is still evolving | Multi-entity transactions or ad-hoc joins across the collection are common |
| Key-value (Redis, DynamoDB) | Caching, session storage, feature flags — simple queries, flat data, high performance | Records need rich queries on fields other than the key |
| Wide-column (Cassandra, HBase) | Massive write-heavy or time-series workloads — telemetry, logging, IoT | Reads need flexibility beyond the partition/clustering key you designed for |
| Graph (Neo4j) | Traversal-heavy relationship queries are the actual bottleneck | Almost every other case — rarely the right first answer in an interview |

## The core mindset shift

In SQL, you design tables to represent things (customers, orders, products), and the query planner figures out how to join them at read time. In access-pattern-driven modeling, a join at read time across partitions is expensive or impossible, so you **enumerate every access pattern before writing a single table definition**, and shape keys and duplication so each pattern is answered by one request to one partition.

> [!KEY]
> The rule of thumb for DynamoDB-style modeling: "list your access patterns first, design your keys second, and only then think about entities." Doing it in the opposite order is the most common mistake candidates make in this discussion.

## Listing access patterns first

For an e-commerce order system, you'd write down, concretely:

1. Get a customer's profile by customer ID.
2. Get all orders for a customer, most recent first.
3. Get an order and all its line items by order ID.
4. Get all orders in a given status (e.g., "pending fulfilment") across all customers.
5. Get a product's details by product ID.

Only after this list exists do you design tables — each pattern becomes a specific key design, and patterns that need different sort orders or different partition scopes often become separate **secondary indexes** rather than separate tables.

## Single-table design and composite keys

Single-table design puts multiple entity types in one physical table, distinguished by the shape of their keys, so related items that are fetched together live in the same partition and can be retrieved in one query.

| PK | SK | Attributes |
|---|---|---|
| `CUSTOMER#123` | `PROFILE` | name, email |
| `CUSTOMER#123` | `ORDER#2024-01-15#001` | status, total |
| `CUSTOMER#123` | `ORDER#2024-02-02#002` | status, total |
| `ORDER#001` | `ITEM#sku-42` | quantity, price |
| `ORDER#001` | `ITEM#sku-77` | quantity, price |

A **composite key** — partition key (PK) plus sort key (SK) — lets one partition hold a customer's profile and all their orders, sorted so "most recent orders first" is a single range query (`begins_with(SK, "ORDER#")` ordered descending), with no join.

```mermaid
flowchart LR
    Q1["Get customer profile"] --> K1["PK=CUSTOMER#123, SK=PROFILE"]
    Q2["Get customer's orders, newest first"] --> K2["PK=CUSTOMER#123, SK begins_with ORDER#"]
    Q3["Get order + line items"] --> K3["PK=ORDER#001, SK begins_with ITEM#"]
```

> [!TIP]
> Encode the sort key so range queries answer real questions: `ORDER#2024-01-15#001` sorts chronologically *and* lets you filter by date prefix — this single design decision answers two access patterns at once.

## Secondary indexes and their cost

When a new access pattern needs a different partition or sort order than your base table provides (e.g., pattern 4 above — orders by status, not by customer), you add a **Global Secondary Index (GSI)**: a projection of the base table with a different key, maintained asynchronously by the engine.

| Aspect | Base table key | Secondary index |
|---|---|---|
| Write cost | Every write | Every write triggering the index gets a second (async) write |
| Consistency | Strongly consistent reads available | Usually eventually consistent |
| Storage | Once | Duplicated (whole item or a projection) |
| Purpose | Your primary, highest-volume access pattern | Every other access pattern |

> [!WARNING]
> Every secondary index is another copy of (part of) your data that must be paid for in storage and write throughput. Don't add one per possible future query — add one per access pattern you actually have.

## The adjacency list pattern for relationships

Graph-like relationships (many-to-many) are modeled with an **adjacency list**: both directions of a relationship are stored as items in the same table, keyed so either side can be queried directly.

| PK | SK | Meaning |
|---|---|---|
| `USER#1` | `FOLLOWS#USER#2` | User 1 follows user 2 |
| `USER#2` | `FOLLOWEDBY#USER#1` | User 2 is followed by user 1 |

This duplicates the relationship in both directions but makes "who does user 1 follow" and "who follows user 2" both single-partition queries instead of a graph traversal.

## Fan-out on write vs fan-out on read

| | Fan-out on write | Fan-out on read |
|---|---|---|
| When work happens | At write time — push the new item to every follower's feed | At read time — pull and merge from every followed user |
| Write cost | High (one write per follower) | Low (one write, period) |
| Read cost | Very low (feed is pre-built) | High (fan-in from many partitions) |
| Best for | Read-heavy, bounded follower counts | Write-heavy or celebrity accounts with huge follower counts |
| Real-world example | Twitter's normal timeline | Twitter's handling of celebrity accounts (hybrid) |

Most large-scale feed systems use a **hybrid**: fan-out on write for normal users, fan-out on read for accounts with millions of followers, because writing one post to 50 million feed partitions synchronously isn't viable.

## Handling many-to-many and pagination

Many-to-many relationships (students/courses, users/roles) use the same adjacency-list idea: a row per pair, keyed both ways if both query directions are needed. Pagination in NoSQL is **cursor-based, not offset-based** — queries return an opaque `LastEvaluatedKey`/continuation token pointing at the last item read, because computing "skip 10,000 rows" requires scanning them in a partitioned store, whereas resuming from a key is O(1).

> [!DANGER]
> `OFFSET`-style pagination doesn't translate to most NoSQL stores — it silently becomes a full scan of everything before the offset. Always design pagination around a sort key and a continuation token from the start.

## Worked example: a social feed

| Access pattern | Key design |
|---|---|
| Get a user's profile | PK=`USER#{id}`, SK=`PROFILE` |
| Get a user's own posts, newest first | PK=`USER#{id}`, SK=`POST#{timestamp}#{postId}` |
| Get a single post with its comments | PK=`POST#{postId}`, SK=`COMMENT#{timestamp}#{commentId}` |
| Get a user's home feed (pre-built) | PK=`FEED#{userId}`, SK=`POST#{timestamp}#{postId}` — populated by fan-out on write |
| Get who a user follows | PK=`USER#{id}`, SK=`FOLLOWS#{targetId}` |
| Paginate a feed 20 at a time | Query with `Limit=20` and the previous response's continuation token as `ExclusiveStartKey` |

Every row in this table answers a specific, named query — there is no "Users" table and "Posts" table designed independently and joined later.

## Keys, shards and indexes are downstream of the same decision

Once the access patterns are listed and the keys are designed, two more decisions follow directly from them: how the data is split across machines, and how it's indexed for the queries the primary key alone doesn't satisfy. Both are large enough to deserve their own deep dives, but the full menu is worth seeing in one place — they're really just more elaborate answers to the same question this whole page asks: which query am I optimizing for?

![alt text](notes/05-HighLevelDesign/DatabaseModeling/image.png)

| Sharding technique | In one line | Diagram |
|---|---|---|
| Sharding overview | Splits one logical dataset into independent, smaller databases, each holding a subset of rows | ![alt text](notes/05-HighLevelDesign/DatabaseModeling/image-21.png){width=300px} |
| Choosing a shard key | High-cardinality, evenly distributed, and aligned with the dominant query — a user ID beats a timestamp | ![alt text](notes/05-HighLevelDesign/DatabaseModeling/image-22.png){width=400px} |
| Range sharding | Contiguous key ranges per shard; simple, but skewed access creates hot shards | ![alt text](notes/05-HighLevelDesign/DatabaseModeling/image-23.png){width=400px} |
| Hash sharding | `hash(key) % N` spreads load evenly, but changing `N` remaps nearly everything | ![alt text](notes/05-HighLevelDesign/DatabaseModeling/image-24.png){width=400px} |
| Directory-based sharding | A lookup service maps keys to shards, trading an extra hop for rebalancing flexibility | ![alt text](notes/05-HighLevelDesign/DatabaseModeling/image-25.png){width=400px} |
| Hot spots | One shard absorbs disproportionate traffic because the key or access pattern is skewed | ![alt text](notes/05-HighLevelDesign/DatabaseModeling/image-26.png) |
| Cross-shard queries | A query spans shards because the data wasn't partitioned along its own access pattern | ![alt text](notes/05-HighLevelDesign/DatabaseModeling/image-27.png) |
| Maintaining consistency across shards | Two-phase commit for atomicity, or a saga for coordinated eventual consistency | ![alt text](notes/05-HighLevelDesign/DatabaseModeling/image-28.png) |
| Sharding in practice | Shard only once a single database genuinely can't handle the load — not before | ![alt text](notes/05-HighLevelDesign/DatabaseModeling/image-29.png) |
| Consistent hashing | Shards and keys both hashed onto a ring; adding or removing a shard only remaps its immediate neighbours | ![alt text](notes/05-HighLevelDesign/DatabaseModeling/image-59.png) |
| Virtual nodes | Each physical shard maps to many ring positions, smoothing out uneven load from one unlucky placement | ![alt text](notes/05-HighLevelDesign/DatabaseModeling/image-60.png) |

Indexing follows the same "match the query" logic, just at the level of a single node rather than across a cluster:

| Index structure | In one line | Diagram |
|---|---|---|
| B-Tree | The default: balanced, sorted, excellent for range queries and equality lookups alike | ![alt text](notes/05-HighLevelDesign/DatabaseModeling/image-3.png) |
| LSM tree | Buffers writes in memory and flushes sequentially, trading read speed for very high write throughput | ![alt text](notes/05-HighLevelDesign/DatabaseModeling/image-5.png) |
| Hash index | Excellent for exact-match lookups, useless for range queries or sorting | ![alt text](notes/05-HighLevelDesign/DatabaseModeling/image-6.png) |
| Geohash | Encodes 2D location into a 1D string so nearby places share a prefix, then indexes it with a B-Tree | ![alt text](notes/05-HighLevelDesign/DatabaseModeling/image-7.png) |
| Quadtree | Recursively subdivides space into four quadrants; mostly superseded by R-Trees today | ![alt text](notes/05-HighLevelDesign/DatabaseModeling/image-8.png) |
| R-Tree | Modern default for spatial indexing, using overlapping bounding rectangles for point and range search | ![alt text](notes/05-HighLevelDesign/DatabaseModeling/image-9.png) |
| Inverted index | Maps a word to every document containing it — the structure behind full-text search | ![alt text](notes/05-HighLevelDesign/DatabaseModeling/image-10.png) |
| Composite index | A single B-Tree over multiple columns, ordered to match a specific filter-then-sort query | ![alt text](notes/05-HighLevelDesign/DatabaseModeling/image-11.png) |

> [!WARNING]
> None of these techniques are free — every shard adds cross-shard query risk, and every index adds write overhead and storage. Add one per access pattern you actually have, exactly the same discipline this page argues for with secondary indexes.

## Cheat sheet

- Schema design has three inputs (data volume, access patterns, consistency requirements) and four outputs (schema, keys/constraints, a normalize-or-denormalize call, an indexing/sharding plan) whether the store is relational or NoSQL.
- Model for queries, not entities: list access patterns before designing a single key.
- Composite keys (PK + SK) let one partition answer "get parent and its children" in one request.
- Single-table design colocates related item types by key shape, trading normalisation for fewer round trips.
- Secondary indexes cost extra writes and storage — add one per real access pattern, not per hypothetical one.
- Adjacency lists model relationships by storing both directions as items, keyed for direct lookup either way.
- Fan-out on write optimises reads at write cost; fan-out on read optimises writes at read cost — hybrid for celebrity/hot keys.
- Pagination must be cursor-based (continuation tokens), not offset-based, in partitioned stores.
- Duplication is the price of avoiding joins — plan how each duplicate gets updated before you introduce it.

## Common mistakes

| Mistake | Fix |
|---|---|
| Designing tables first, then figuring out how to query them | Enumerate access patterns first; keys follow from the patterns |
| Adding a secondary index for every field "just in case" | Only add indexes for confirmed, named access patterns |
| Using `OFFSET`-style pagination against a partitioned store | Use a sort key + continuation token (`ExclusiveStartKey`) |
| Modeling many-to-many with a join table and expecting a join at query time | Use an adjacency list with both directions stored as items |
| Fanning out every post to every follower synchronously, regardless of follower count | Use fan-out on read (or async/batched fan-out) for very large follower counts |
| Picking a shard key or index type without tying it back to the dominant access pattern | Choose based on cardinality, distribution, and the query that matters most — same discipline as key design |
| Treating single-table design as mandatory dogma | It's a technique for reducing round trips, not a rule — separate tables are fine when access patterns don't overlap |

## Summary

Access-pattern-driven modeling flips the relational order of operations: list the exact queries your application needs, then design partition and sort keys — and where necessary, secondary indexes and duplicated adjacency-list rows — so each pattern resolves in one request to one partition. The cost is upfront modeling discipline and write-side duplication; the payoff is predictable, low-latency reads at massive scale without cross-partition joins. Fan-out strategy and cursor-based pagination follow the same logic: decide at design time where the expensive work happens, write time or read time, rather than discovering it under load.

## Top Interview Questions

### Q1. What is the fundamental modeling difference between relational and NoSQL (access-pattern-driven) design?

Relational modeling starts from the entities and their relationships, normalises to remove duplication, and relies on the query planner to join at read time — the schema is designed once and queries adapt to it. Access-pattern-driven modeling inverts this: you enumerate every query your application needs up front, then design partition/sort keys, and often duplicate data, so each query resolves within a single partition without a join. The trade is upfront modeling rigidity (a new, unanticipated access pattern can require a data migration) in exchange for predictable, low-latency performance at horizontal scale, since cross-partition joins are expensive or unsupported in most of these stores.

### Q2. Explain single-table design and why someone would deliberately put unrelated entity types in one table.

Single-table design stores multiple entity types (customers, orders, line items) in one physical table, distinguished by the shape of their partition and sort keys, so that items which are usually fetched together — a customer and their recent orders, an order and its line items — live in the same partition and can be retrieved in a single request. This isn't about the entities being "the same kind of thing"; it's purely about optimising for co-access. The trade-off is that the table becomes harder to reason about by looking at its schema alone (you need the access-pattern documentation alongside it), so it's worth it specifically when minimising round trips matters, not as a default for every design.

### Q3. What's the role of a composite (partition key + sort key) design, and how does it help with one-to-many relationships?

A composite key uses the partition key to group related items together and the sort key to order and range-filter within that group. For a one-to-many relationship like "a customer has many orders," you set the partition key to the customer ID for both the profile item and every order item, and the sort key to something like `ORDER#<timestamp>#<orderId>` — this makes "get the customer and their 10 most recent orders" a single range query on one partition (`begins_with` or a `between` on the sort key), sorted for free, instead of a join across two tables.

### Q4. What is a secondary index, and what does it cost you that a base table key doesn't?

A secondary index is a second, differently-keyed projection of your table's data, maintained by the engine to serve an access pattern the base table's key doesn't support directly — for example, "find orders by status" when your base table is keyed by customer. It costs an additional (usually asynchronous, so eventually consistent) write on every base-table write that touches an indexed attribute, plus storage for the duplicated or projected data. The interview point to make explicitly: secondary indexes aren't free denormalisation — you should only add one per access pattern you actually have, because each one is an ongoing write-amplification and consistency cost.

### Q5. How would you model a many-to-many relationship, like users following other users, in a partition-oriented NoSQL store?

Using the adjacency list pattern: store the relationship as items in both directions, each keyed so it's directly queryable from either side — e.g., `PK=USER#1, SK=FOLLOWS#USER#2` to answer "who does user 1 follow," and `PK=USER#2, SK=FOLLOWEDBY#USER#1` to answer "who follows user 2." This duplicates the relationship (two items for one logical follow), but it means both query directions are single-partition, sort-key-range queries instead of a graph traversal or a join through an intermediate table — the classic trade of write-side duplication for read-side simplicity.

### Q6. Explain fan-out on write versus fan-out on read, and when you'd choose each for a social feed.

Fan-out on write pushes a new post into every follower's pre-built feed partition at write time, so reading a feed is a single cheap query — great when reads vastly outnumber writes and follower counts are bounded. Fan-out on read instead stores only the author's own posts, and building a feed means querying and merging posts from every account a user follows at read time — cheaper to write, far more expensive to read, especially as the number of followed accounts grows. For accounts with millions of followers ("celebrity" accounts), synchronous fan-out on write would mean tens of millions of writes per post, so large systems use a hybrid: fan-out on write for normal accounts, fan-out on read (merged at request time) for celebrity accounts.

### Q7. Why doesn't traditional offset-based pagination (`LIMIT`/`OFFSET`) work well in most NoSQL stores?

Offset-based pagination requires the engine to count and skip past every row before the offset, which in a relational index scan is at least somewhat efficient but in a partitioned, key-value-oriented store typically means scanning and discarding every preceding item — turning "page 500" into an O(n) operation that gets slower the deeper you paginate. NoSQL stores instead expose cursor-based pagination: each query returns a continuation token (e.g., DynamoDB's `LastEvaluatedKey`) pointing exactly at the last item read, so the next page resumes directly from that key in O(1) relative to page depth, at the cost of not being able to jump to an arbitrary page number directly.

### Q8. Walk through modeling an order-management system: what access patterns would you list, and how would that shape your keys?

I'd start by listing the patterns: get a customer's profile; get a customer's orders, most recent first; get a single order with all its line items; get all orders in a given fulfilment status regardless of customer; get a product's catalog details. The first three map naturally to one table: `PK=CUSTOMER#<id>` for profile and orders (`SK=PROFILE` or `SK=ORDER#<timestamp>#<id>`), and `PK=ORDER#<id>, SK=ITEM#<sku>` for line items. The fourth pattern — orders by status, not by customer — doesn't fit that key at all, so it becomes a secondary index keyed by status and timestamp. The fifth is independent of the others and can live in its own item type keyed by product ID. The point I'd make out loud: the table design is a direct, traceable consequence of the pattern list, not the other way round.

### Q9. What's the danger of adding a secondary index "just in case we need it later"?

Every secondary index is a live, ongoing cost: it duplicates (or projects) data on every write that touches it, adds write latency and throughput consumption, and in most engines is only eventually consistent, which is a consistency model you now have to reason about even if nobody queries it yet. If the access pattern never materialises, you've paid that cost indefinitely for nothing; if it does materialise but with a shape slightly different from what you guessed (a different sort key, a different filter), you'll likely need to add another index anyway. The disciplined approach is to add indexes only for confirmed, named access patterns, and treat "we might need this" as a signal to revisit the design later, not to pre-pay for it now.

### Q10. How would duplicated data (from denormalisation or an adjacency list) stay consistent when the source changes?

It depends on how the duplicate was created. If it's within the same table and update, a single conditional write or transactional write (many stores support limited multi-item transactions) can update both copies atomically. If it's across a secondary index, the engine maintains it for you asynchronously — you accept a brief eventual-consistency window. If it's application-managed duplication (e.g., a denormalised display name copied onto many items), you need an explicit strategy: update it synchronously in the same request if the item count is small and bounded, or use a background/async process (a stream trigger, e.g., DynamoDB Streams) to propagate the change if the fan-out is large, accepting a short staleness window in exchange for not blocking the write path on thousands of updates.

### Q11. A colleague says "let's just add a GSI for every column so we're covered for future queries." How do you respond?

I'd push back with the cost side of the trade-off: each GSI is a permanent tax on every write that touches its key attributes — extra write capacity, extra storage, and an eventual-consistency window for reads against it — paid whether or not the query ever happens. Instead, I'd ask for the actual list of access patterns the product needs now and in the near-term roadmap, design indexes for those, and treat "we might need this later" as something to revisit when a real requirement shows up, at which point adding an index (or, if the shape has changed enough, restructuring keys) is a known, bounded piece of work rather than an unbounded standing cost paid speculatively today.
