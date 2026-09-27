---
title: How Indexes Work
description: The B+ tree structure behind every index, why clustered and non-clustered indexes behave so differently, and the exact conditions that make the optimizer ignore an index
difficulty: Core
tags: [sql, indexes, performance, t-sql, internals]
---

An index is the single biggest lever you have over query performance, and interviewers use it to test whether you understand storage internals or only syntax. This page covers the B+ tree structure, the clustered/non-clustered distinction that trips up most candidates, and the concrete reasons an index gets ignored.

## The B+ tree

Almost every relational database index (SQL Server, MySQL/InnoDB, Postgres's default) is a **B+ tree**: a balanced, sorted, multi-way tree where all actual data lives in leaf nodes, and internal nodes only hold routing keys.

```mermaid
flowchart TD
    R["Root:<br/>keys 1, 50"] --> B1["Branch:<br/>keys 1, 20"]
    R --> B2["Branch:<br/>keys 50, 80"]
    B1 --> L1["Leaf:<br/>1-19"]
    B1 --> L2["Leaf:<br/>20-49"]
    B2 --> L3["Leaf:<br/>50-79"]
    B2 --> L4["Leaf:<br/>80-99"]
    L1 --> L2
    L2 --> L3
    L3 --> L4
```

Leaf pages are linked to their neighbours, so once you find the starting leaf, a range scan just walks the chain — no re-traversal from the root. Because the tree is balanced and each node holds many keys (typically hundreds, since a page is 8KB and keys are small), the height stays tiny even for huge tables: a tree of fan-out 200 needs only 4 levels to index over 1.6 billion rows.

> [!KEY]
> Lookup cost is `O(log n)` because each level of the tree eliminates most of the remaining rows — with a fan-out of a few hundred, 3–4 page reads can locate a row among billions, versus a full scan reading every page.

## Clustered vs non-clustered

| | Clustered index | Non-clustered index |
|---|---|---|
| Data storage | Table's actual rows, physically sorted by the key | Separate structure; leaf holds key + a pointer back to the row |
| Per table | Exactly one (or zero — a heap) | Up to 999 in SQL Server |
| Leaf contains | The full row | Indexed columns + row locator |
| Lookup for a non-indexed column | Direct — row is right there | Extra "key/bookmark lookup" step needed |
| Typical choice of key | Primary key, often an increasing `IDENTITY` | Any frequently filtered/sorted/joined column |

A clustered index **is** the table, reorganised as a B+ tree on the key you choose — there is no separate storage. A non-clustered index is an auxiliary structure: its leaf level stores the indexed column(s) plus a **row locator** back to the actual data (the clustering key if the table has a clustered index, or a physical row ID if it's a heap).

```sql
-- Clustered index, usually created implicitly by the PRIMARY KEY constraint
CREATE CLUSTERED INDEX PK_employees ON employees(employee_id);

-- Non-clustered index on a frequently filtered column
CREATE NONCLUSTERED INDEX IX_employees_department ON employees(department_id);
```

### Heap tables

A table with **no** clustered index is a **heap** — rows are stored in no particular order, addressed by a physical row identifier (RID). Inserts are fast (append-friendly), but range scans and lookups by any column require either a full scan or a non-clustered index whose leaf then points back via RID, which can fragment badly as rows move. Most production tables should have a clustered index; heaps are the exception, not the default.

## Key lookups (bookmark lookups)

When a query filters on a non-clustered index's column but also needs a column **not** in that index, the engine performs a **key lookup**: for every matching row found in the index, it does a second, separate seek into the clustered index (or heap) to fetch the rest of the columns.

```mermaid
flowchart LR
    Q["Query:<br/>WHERE department_id = 1<br/>SELECT salary"] --> IX["Seek IX_department"]
    IX --> KL["Key lookup<br/>per matching row"]
    KL --> C["Clustered index<br/>fetch full row"]
```

This is cheap for a handful of rows but becomes the dominant cost once the index seek returns thousands of rows — at that point the optimizer often abandons the index entirely and does a full clustered index scan instead, because one sequential scan beats thousands of random-access lookups.

> [!WARNING]
> Seeing many "Key Lookup" operators in a plan, each feeding into a "Nested Loops", is the textbook symptom of a **missing covering index**. It is one of the most common real production performance bugs and a very likely interview scenario question.

## Composite indexes and the leftmost-prefix rule

A **composite** (multi-column) index sorts its B+ tree by its first column, then by its second column *within* each value of the first, and so on — exactly like a phone book sorted by last name then first name. This ordering means a composite index only helps a query that filters on a **left-to-right prefix** of its columns.

```sql
CREATE NONCLUSTERED INDEX IX_employees_dept_salary
ON employees(department_id, salary);
```

| Query filters on | Can this index seek? | Why |
|---|---|---|
| `department_id = 1` | Yes | Uses the leading column alone |
| `department_id = 1 AND salary > 50000` | Yes | Uses both columns, in order |
| `department_id = 1 ORDER BY salary` | Yes | Rows for one department are already sorted by salary |
| `salary > 50000` (no `department_id`) | No | `salary` is not the leading column — the tree isn't sorted by it independently |

> [!WARNING]
> Column **order in the index definition matters as much as which columns are included**. `(department_id, salary)` and `(salary, department_id)` are different indexes with different use cases — the second one seeks efficiently on `salary` alone but not on `department_id` alone. Put the column with equality filters (or the highest selectivity, when several columns are equality-filtered together) first, and the column used for range filtering or sorting last.

A single-column index is just the special case of a composite index with one column; a unique index and a clustered index are the same B+ tree structure with an added uniqueness guarantee or physical row ordering respectively — the leftmost-prefix rule applies to all of them identically.

## Covering indexes and INCLUDE

A **covering index** contains every column the query needs — either in the key or via `INCLUDE` — so the engine never needs a key lookup.

```sql
CREATE NONCLUSTERED INDEX IX_employees_dept_covering
ON employees(department_id)
INCLUDE (employee_name, salary);
```

`INCLUDE` columns live only at the leaf level (not in the tree's branch nodes), so they don't bloat the tree's navigational structure, but they do let the index satisfy the whole query without touching the base table. Use `INCLUDE` for columns that only appear in `SELECT`, and put columns used for filtering/joining/sorting in the key itself.

## Selectivity and cardinality

**Selectivity** is the fraction of rows a predicate is expected to match; **cardinality** is the number of distinct values in a column. A highly selective predicate (few matching rows, e.g. `email = '...'`) benefits enormously from an index — a seek touches a handful of pages. A low-selectivity predicate (`status = 'Active'` when 95% of rows are active) gains little, because the engine would still need to visit most of the table, and a scan can be cheaper than that many key lookups.

| Column | Distinct values (of 1M rows) | Selectivity | Good index candidate? |
|---|---|---|---|
| `employee_id` (PK) | 1,000,000 | Very high | Yes — ideal |
| `email` | 1,000,000 | Very high | Yes |
| `department_id` | 20 | Low | Only combined with other columns, or if queries return small slices |
| `status` (Active/Inactive) | 2 | Very low | Rarely — consider a filtered index instead |

## When the optimizer ignores an index

- **Function on the indexed column**: `WHERE YEAR(hire_date) = 2023` cannot seek — the engine must evaluate the function per row. Rewrite as a sargable range: `WHERE hire_date >= '2023-01-01' AND hire_date < '2024-01-01'`.
- **Implicit conversion**: comparing a `VARCHAR` column to an `NVARCHAR` literal (or vice versa) can force a conversion on the column side, silently disabling the seek. Match parameter types exactly to column types.
- **Leading wildcard `LIKE`**: `LIKE '%smith'` cannot use a standard B+ tree index (no fixed prefix to seek to); `LIKE 'smith%'` can. Full-text search or trigram indexes solve the leading-wildcard case.
- **Low selectivity**: as above, the optimizer's cost-based estimate may correctly conclude a scan is cheaper than a seek plus many key lookups.
- **Stale or missing statistics**: the optimizer estimates row counts from statistics; badly out-of-date statistics can lead it to choose a scan over a seek (or vice versa) incorrectly.

> [!DANGER]
> "Sargable" (Search ARGument ABLE) is the term for a predicate the engine can directly use with an index seek. Wrapping a column in a function, concatenating it, or applying arithmetic to it (`WHERE salary * 1.1 > 50000`) makes the predicate non-sargable — rewrite the arithmetic onto the constant side instead (`WHERE salary > 50000 / 1.1`).

## Write cost, fill factor and fragmentation

Every index is extra work on `INSERT`/`UPDATE`/`DELETE` — each write must also update every affected index, not just the table. A table with ten non-clustered indexes pays that cost ten times over on every insert.

**Fill factor** controls how full each leaf page is left at index build time (default 100%). A lower fill factor (e.g. 80%) leaves room for future inserts without immediately forcing a **page split** (a full page splits into two, causing fragmentation and extra I/O) — useful for indexes with frequent inserts in the middle of the key range (e.g. a non-sequential GUID key), less useful for an ever-increasing key where new rows always append at the end.

| Fragmentation source | Cause | Mitigation |
|---|---|---|
| Page splits | Inserts landing on already-full pages | Lower fill factor, or use a sequential key |
| Frequent deletes | Leaves sparse, partially-empty pages | Periodic `ALTER INDEX ... REORGANIZE`/`REBUILD` |
| Random-order key (e.g. GUID) | Inserts scattered across the whole key range | Prefer `NEWSEQUENTIALID()` or a surrogate `IDENTITY` key |

## Unique, filtered, and columnstore indexes

- **Unique index**: enforces no duplicate key values in addition to speeding lookups — every `PRIMARY KEY`/`UNIQUE` constraint is backed by one.
- **Filtered index**: indexes only a subset of rows via a `WHERE` clause, e.g. `CREATE INDEX IX_active ON employees(department_id) WHERE status = 'Active'` — much smaller and more selective than indexing the whole low-selectivity `status` column.
- **Columnstore index**: stores data column-by-column instead of row-by-row, with heavy compression — built for analytical/aggregate queries scanning millions of rows (data warehousing), not point lookups; a rowstore B+ tree is still correct for OLTP-style single-row access.

## Cheat sheet

- Index = B+ tree; balanced, sorted, `O(log n)` lookups because fan-out is high and tree height stays small.
- Clustered index = the table's rows, physically ordered by the key; at most one per table (a heap has none).
- Non-clustered index = separate structure; leaf holds key + pointer back to the row, requiring a key lookup for non-indexed columns.
- A composite index is sorted by its leading column first — it only seeks on a left-to-right prefix of its columns; column order in the definition is a design decision, not an afterthought.
- A covering index (key columns + `INCLUDE`) avoids key lookups entirely for a specific query shape.
- High selectivity (few matching rows) → index helps a lot; low selectivity → scan often wins.
- Functions/implicit conversion/leading-wildcard `LIKE` on the indexed column all defeat a seek — keep predicates sargable.
- Every index adds write cost — don't index what you don't query.
- Fill factor trades some wasted space now for fewer page splits later; matters most with non-sequential keys.
- Filtered indexes shrink a low-selectivity index to just the rows you actually query.
- Columnstore is for analytics/scans over millions of rows; rowstore B+ tree is for OLTP point lookups.

## Common mistakes

| Mistake | Fix |
|---|---|
| Wrapping the indexed column in a function in `WHERE` | Rewrite as a sargable range/comparison on the raw column |
| Indexing a low-cardinality column alone (e.g. a boolean `status`) | Use a filtered index, or combine with a higher-selectivity column |
| Assuming more indexes are always better | Every index adds write cost; drop unused ones (check usage DMVs) |
| Not using `INCLUDE` for SELECT-only columns | Add them to `INCLUDE` to make the index covering and avoid key lookups |
| Expecting a composite index on `(a, b)` to help a query that only filters on `b` | Only a leading-column prefix seeks; add a separate index on `b`, or reorder if `b` is the more common single-column filter |
| Comparing mismatched types (e.g. `VARCHAR` column to `NVARCHAR` parameter) | Match parameter/column types to avoid implicit conversion disabling the seek |
| Ignoring fragmentation on high-churn tables | Schedule `REORGANIZE`/`REBUILD`, and reconsider a random-order key |

## Summary

An index is a balanced, sorted B+ tree that trades write cost and storage for `O(log n)` reads. The clustered index physically orders the table itself; every non-clustered index is a smaller side structure that must "phone home" via a key lookup unless it's made covering with `INCLUDE`. A composite index only accelerates a query that filters on a leftmost prefix of its columns, so column order is a deliberate design choice, not a detail. Whether the optimizer actually uses an index comes down to selectivity, sargability of the predicate, and up-to-date statistics — knowing the concrete list of things that silently defeat a seek (functions, implicit conversion, leading wildcards, low selectivity) is what separates "I added an index" from "I know why it worked."

## Top Interview Questions

### Q1. What is the difference between a clustered and a non-clustered index?

A clustered index physically reorders the table's rows on disk according to the index key — the leaf level of its B+ tree **is** the actual row data, so a table can have at most one (or none, making it a heap). A non-clustered index is a separate structure whose leaf level stores only the indexed columns plus a pointer back to the row — either the clustering key if one exists, or a physical row ID on a heap. Reading a column not covered by a non-clustered index therefore requires an extra "key lookup" step back into the clustered index/heap, which a clustered index never needs because the full row is already there.

### Q2. Why is index lookup O(log n) rather than O(n)?

Indexes are stored as B+ trees: balanced, sorted, multi-way trees where each node holds many keys (often hundreds, since an 8KB page holds many small key entries). High fan-out keeps the tree extremely shallow — a fan-out of 200 needs only about 4 levels to index over a billion rows — and each level of traversal eliminates most of the remaining search space, the same way binary search halves it. So a lookup costs roughly (tree height) page reads, which grows logarithmically with row count, not linearly.

### Q3. What is a key lookup (bookmark lookup) and when does it become a problem?

When a query filters using a non-clustered index but also selects columns not present in that index, the engine must perform a separate seek into the clustered index (or heap) for every matching row to retrieve the remaining columns — this is a key lookup. It's cheap for a handful of rows, but its cost scales linearly with the number of matches, so once an index seek returns thousands of rows, thousands of random-access lookups can be slower than one sequential scan of the whole table — at which point the optimizer typically switches the plan to a clustered index scan instead. The fix is a covering index (adding the needed columns via `INCLUDE`) so the lookup is never needed.

### Q4. What makes a predicate non-sargable, and how do you fix one?

A predicate is non-sargable when the indexed column is wrapped in a function, arithmetic expression, or implicit type conversion, forcing the engine to evaluate every row rather than seek directly using the index's sort order. Common examples: `WHERE YEAR(hire_date) = 2023` (function on the column), `WHERE salary * 1.1 > 50000` (arithmetic on the column), and comparing a `VARCHAR` column to an `NVARCHAR` parameter (implicit conversion). The fix is always to move the transformation onto the constant/parameter side and leave the column bare: `WHERE hire_date >= '2023-01-01' AND hire_date < '2024-01-01'`, or `WHERE salary > 50000 / 1.1`.

### Q5. What's the difference between selectivity and cardinality, and why does low selectivity make an index less useful?

Cardinality is the number of distinct values in a column; selectivity is the fraction of rows a specific predicate is expected to match, closely tied to cardinality — a column with high cardinality (like an email address) tends to produce highly selective predicates. A low-selectivity predicate, like `status = 'Active'` when 95% of rows are active, would still require visiting most of the table even via an index, and each match via a non-clustered index may cost a separate key lookup — at that point the optimizer's cost model correctly favours a plain scan over thousands of random-access lookups. Indexes earn their cost on high-selectivity predicates; for very low-selectivity ones, consider a filtered index or accept a scan.

### Q6. What is a covering index and how do INCLUDE columns differ from key columns?

A covering index contains every column a specific query needs, so the engine can answer the query entirely from the index without a key lookup back to the base table. Key columns are part of the B+ tree's sort order and appear at every level of the tree (usable for seeking, filtering, joining, and ordering); `INCLUDE` columns are stored only at the leaf level, adding no sort-order benefit but letting the index satisfy `SELECT` columns without bloating the tree's branch nodes. The design rule: put columns used in equality/range/join/order-by predicates in the key, and put columns only ever selected (never filtered/sorted on) in `INCLUDE`.

### Q7. A query filtering on `WHERE UPPER(email) = 'X@Y.COM'` isn't using the index on `email` — why, and how would you fix it?

`UPPER(email)` wraps the indexed column in a function, so the optimizer cannot seek using the index's stored (unmodified) values — it would have to evaluate `UPPER()` against every row, which is a scan, not a seek. The fix is either to normalise the stored data (store email already lowercased/uppercased and index that) and compare against a matching-case literal, or to create a computed, persisted column with `UPPER(email)` and index that computed column directly, or — if the collation supports it — use a case-insensitive collation so the comparison doesn't need the function at all. The general principle is always the same: never transform the indexed column itself in the predicate.

### Q8. Why would adding an index make write performance worse, and how would you decide whether an index is worth keeping?

Every `INSERT`/`UPDATE`/`DELETE` must maintain every index defined on the affected columns — not just the clustered index/table — so more indexes directly means more write amplification and more lock/log overhead per write. To decide whether an index is worth its cost, check its usage against reads it actually serves: SQL Server's `sys.dm_db_index_usage_stats` DMV shows seeks/scans/lookups versus updates for each index, so an index with near-zero seeks/scans but heavy updates is a strong candidate to drop. The senior framing: indexes are a trade of write cost and storage for read speed, and that trade should be justified by measured query patterns, not added speculatively.

### Q9. What is a filtered index and when would you use one over a normal index?

A filtered index includes only the rows matching a `WHERE` predicate specified at index-creation time, e.g. `CREATE INDEX IX_active_employees ON employees(department_id) WHERE status = 'Active'`. It's smaller, cheaper to maintain, and more selective than indexing the whole table when queries consistently filter to a small, well-defined subset — a classic case is a `status` column with 95% one value: rather than a low-selectivity index over the whole table, a filtered index over just the 5% "Inactive" (or "Active") rows is both small and highly useful for queries that specifically target that subset.

### Q10. What's the practical difference between a rowstore (B+ tree) index and a columnstore index, and when would you use each?

A rowstore B+ tree index stores all of a row's columns together at the leaf, optimised for finding and returning a small number of specific rows quickly — the standard choice for OLTP workloads: order lookups, single-customer queries, transactional updates. A columnstore index stores each column's values contiguously and heavily compressed, optimised for scanning and aggregating millions of rows across few columns — the standard choice for analytical/reporting workloads, like summing sales across a year. Using a columnstore for point lookups (`WHERE order_id = 12345`) is usually much slower than a rowstore seek; using a rowstore for `SUM(amount) GROUP BY month` across a huge fact table is usually much slower and more I/O-heavy than a columnstore scan.

### Q11. A table has a GUID primary key generated with NEWID() and its clustered index is heavily fragmented — why, and how would you fix it?

`NEWID()` generates fully random GUIDs, so consecutive inserts land at essentially random points across the entire key range of the clustered index rather than appending at the end — nearly every insert lands on an already-full page, forcing a page split, which fragments the index and bloats it with partially-empty pages. The standard fixes are to switch to `NEWSEQUENTIALID()` (still a GUID, but generated in increasing order so inserts append rather than scatter), to use a smaller sequential surrogate key (`IDENTITY`/`BIGINT`) as the clustering key while keeping the GUID as a separate unique non-clustered column if it must be exposed externally, or to lower the fill factor and schedule regular index maintenance if the random key can't be changed.

### Q12. How would you identify which indexes are actually being used versus which ones are dead weight in a production database?

I'd query `sys.dm_db_index_usage_stats` joined to `sys.indexes`/`sys.objects`, comparing `user_seeks`/`user_scans`/`user_lookups` (reads that benefited from the index) against `user_updates` (write cost the index imposes) — an index with high updates and near-zero seeks/scans is a strong drop candidate, while one with high seeks and low updates is clearly earning its keep. I'd be careful about the stats resetting on service restart or index rebuild, so I'd look at a representative window of normal production traffic, not immediately after a maintenance window, before recommending removing anything.

### Q13. Why doesn't a composite index on `(department_id, salary)` help a query that filters only on `salary`?

A composite index's B+ tree is physically sorted by its leading column first, then by the next column only *within* rows sharing the same leading value — the same way a phone book sorted by last name isn't useful for finding everyone with a given first name. `(department_id, salary)` groups and sorts rows by `department_id`, and within each department group, by `salary` — so the index can seek efficiently on `department_id` alone, or on `department_id` plus `salary`, but `salary` on its own has no independent sort order to exploit; the engine would have to scan the whole index. The fix, if filtering on `salary` alone is a real access pattern, is a separate index with `salary` as its leading column, not reordering the existing one and losing the `department_id`-only lookups it currently serves.
