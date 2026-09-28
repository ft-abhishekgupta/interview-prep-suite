---
title: Topological Sort
description: Ordering the nodes of a directed acyclic graph so every edge points forward, using Kahn's BFS approach or DFS post-order, and detecting cycles along the way
difficulty: Core
tags: [graphs, topological-sort, dag, cycle-detection]
---

Topological sort answers one question: given a set of tasks with "must happen before" dependencies, in what order can you actually run them? It only exists for a **directed acyclic graph (DAG)** — the moment a cycle appears, no valid ordering exists, and detecting that is half of what this topic tests.

## The DAG prerequisite

A topological order is a linear ordering of vertices such that for every directed edge `u -> v`, `u` appears before `v` in the ordering. This is only possible when the graph has no directed cycle — a cycle would force some node to come before itself.

```mermaid
flowchart LR
    A["Compile utils"] --> B["Compile core"]
    B --> C["Compile api"]
    B --> D["Compile worker"]
    C --> E["Run tests"]
    D --> E
```

A valid order here is `utils, core, api, worker, tests` (or `utils, core, worker, api, tests` — multiple valid orders can exist whenever two nodes have no dependency relationship between them).

> [!KEY]
> A topological order is generally **not unique**. If the interviewer asks for "a" topological order, any valid one is acceptable; if they ask for "the lexicographically smallest" one, use Kahn's algorithm with a min-heap so the smallest currently available node is chosen at each step.

## Kahn's algorithm (BFS on in-degrees)

Compute each node's in-degree (number of incoming edges). Start a queue with every node that has in-degree 0 — nothing blocks them. Repeatedly pop a node, add it to the order, and decrement the in-degree of its neighbours; whenever a neighbour's in-degree hits 0, it becomes unblocked and joins the queue.

```java
// O(V + E) time, O(V) space
public int[] topoSortKahn(int n, int[][] edges) {
    List<List<Integer>> adj = new ArrayList<>();
    int[] indeg = new int[n];
    for (int i = 0; i < n; i++) adj.add(new ArrayList<>());
    for (int[] e : edges) { adj.get(e[0]).add(e[1]); indeg[e[1]]++; }

    Deque<Integer> queue = new ArrayDeque<>();
    for (int i = 0; i < n; i++) if (indeg[i] == 0) queue.offer(i);

    List<Integer> order = new ArrayList<>();
    while (!queue.isEmpty()) {
        int node = queue.poll();
        order.add(node);
        for (int next : adj.get(node))
            if (--indeg[next] == 0) queue.offer(next);
    }
    return order.size() == n
        ? order.stream().mapToInt(Integer::intValue).toArray()
        : new int[0];   // empty = cycle exists
}
```

`order.size() < n` at the end is the cycle signal: some nodes never reached in-degree 0 because they were stuck waiting on each other in a cycle.

## DFS-based ordering with post-order reversal

Alternative approach: run DFS from every unvisited node, and record each node **after** all of its descendants have been fully explored (post-order). Reversing that post-order list gives a valid topological order.

This assumes the graph is already known to be acyclic. If cycles are possible, combine DFS ordering with the three-colour cycle check before trusting the reversed post-order result.

```java
// O(V + E) time, O(V) space (recursion stack + visited/order arrays)
public int[] topoSortDfs(int n, List<List<Integer>> adj) {
    boolean[] visited = new boolean[n];
    List<Integer> order = new ArrayList<>();

    for (int i = 0; i < n; i++)
        if (!visited[i]) dfs(i, adj, visited, order);

    Collections.reverse(order);
    return order.stream().mapToInt(Integer::intValue).toArray();
}

private void dfs(int node, List<List<Integer>> adj, boolean[] visited, List<Integer> order) {
    visited[node] = true;
    for (int next : adj.get(node))
        if (!visited[next]) dfs(next, adj, visited, order);
    order.add(node);          // post-order: only after all descendants are done
}
```

> [!TIP]
> The intuition for why reversing post-order works: a node is only appended to `order` once every path leading forward from it has already been fully processed and appended earlier in the list. That means it always ends up *after* everything it points to in the raw post-order list — so reversing puts it back in front, exactly where a dependency must sit relative to its dependents.

## Cycle detection

| Approach | How it detects a cycle |
|---|---|
| Kahn's (BFS) | If the final order has fewer than `n` nodes, some nodes never reached in-degree 0 — a cycle exists among them |
| 3-colour DFS | If DFS reaches a node currently marked "in progress" (on the current recursion stack), that back-edge is a cycle |

```java
// 3-colour DFS cycle detection: O(V + E) time, O(V) space
// 0 = unvisited, 1 = in progress (on current DFS path), 2 = fully done
public boolean hasCycle(int n, List<List<Integer>> adj) {
    int[] state = new int[n];
    for (int i = 0; i < n; i++)
        if (state[i] == 0 && dfsHasCycle(i, adj, state)) return true;
    return false;
}

private boolean dfsHasCycle(int node, List<List<Integer>> adj, int[] state) {
    state[node] = 1;
    for (int next : adj.get(node)) {
        if (state[next] == 1) return true;              // back-edge -> cycle
        if (state[next] == 0 && dfsHasCycle(next, adj, state)) return true;
    }
    state[node] = 2;
    return false;
}
```

> [!WARNING]
> A plain `visited` boolean array is not enough for directed-cycle detection — a node can be fully visited via one path and encountered again via another without that implying a cycle, as long as it isn't currently **on the active recursion stack**. The 3-colour scheme (unvisited / in-progress / done) is what correctly distinguishes "already finished elsewhere" from "currently an ancestor of itself".

## Course Schedule, worked

"Course Schedule" (can you finish all courses given prerequisite pairs) and "Course Schedule II" (return a valid order, or empty if impossible) are Kahn's algorithm or DFS-cycle-detection applied directly: the first is "does a topological order exist" (equivalent to "is the graph acyclic"), the second additionally requires you to actually produce the order, not just a yes/no.

| Variant | What's needed | Right tool |
|---|---|---|
| Course Schedule I | Yes/no — can all courses be completed | Kahn's (did all nodes get processed?) or 3-colour DFS |
| Course Schedule II | The actual valid order, or empty if impossible | Kahn's (the order falls out naturally) or DFS with post-order reversal |

## Lexicographically smallest topological order

Kahn's algorithm naturally supports this: instead of a plain FIFO queue (`ArrayDeque`), use a **min-heap (`PriorityQueue`)** over the set of currently-available (in-degree 0) nodes. Popping the smallest available node at each step, rather than any arbitrary one, guarantees the lexicographically smallest valid order.

```java
// O((V + E) log V) time due to the heap, O(V) space
public int[] topoSortLexSmallest(int n, int[][] edges) {
    List<List<Integer>> adj = new ArrayList<>();
    int[] indeg = new int[n];
    for (int i = 0; i < n; i++) adj.add(new ArrayList<>());
    for (int[] e : edges) { adj.get(e[0]).add(e[1]); indeg[e[1]]++; }

    PriorityQueue<Integer> available = new PriorityQueue<>();   // min-heap picks the smallest available node
    for (int i = 0; i < n; i++) if (indeg[i] == 0) available.offer(i);

    List<Integer> order = new ArrayList<>();
    while (!available.isEmpty()) {
        int node = available.poll();
        order.add(node);
        for (int next : adj.get(node))
            if (--indeg[next] == 0) available.offer(next);
    }
    return order.size() == n
        ? order.stream().mapToInt(Integer::intValue).toArray()
        : new int[0];
}
```

> [!DANGER]
> Plain DFS-based topological sort does **not** give you an easy handle on lexicographic ordering — the post-order-reversal trick controls final position indirectly through recursion order, not through a simple comparison at each step. If "smallest lexicographic order" is asked, reach for Kahn's with a min-heap, not DFS.

## Applications

| Domain | What the DAG models | What the topological order gives you |
|---|---|---|
| Build systems (Make, Bazel, MSBuild) | Targets and their dependencies | The order to compile/link so every dependency is ready first |
| Task/job schedulers | Tasks and "must run after" constraints | A valid execution order respecting all constraints |
| Package managers | Packages and version dependencies | Install order so dependencies land before dependents |
| Spreadsheet formula evaluation | Cells and the cells they reference | Recalculation order so no formula reads a stale value |
| Deadlock detection (resource allocation graphs) | Processes waiting on resources held by other processes | Absence of a topological order (i.e. a cycle) signals a deadlock |
| Course/curriculum planning | Courses and prerequisites | A valid enrolment sequence |

## Complexity

Both Kahn's and DFS-based topological sort run in `O(V + E)` time and `O(V)` space — each vertex and edge is processed a constant number of times. Adding a min-heap for lexicographically-smallest ordering raises this to `O((V + E) log V)`, since each queue operation costs `O(log V)` instead of `O(1)`.

## Cheat sheet

- Topological order only exists for a DAG — if a cycle exists, no valid order does.
- Kahn's algorithm: BFS on in-degrees, queue starts with in-degree-0 nodes, `O(V + E)`.
- DFS-based order: post-order traversal, then **reverse** the result.
- Cycle detection via Kahn's: final order length `< n` means a cycle exists.
- Cycle detection via DFS: needs 3 states (unvisited/in-progress/done), not just a boolean — a back-edge to an "in-progress" node is the cycle signal.
- Course Schedule I = "is this graph acyclic"; Course Schedule II = "produce the actual order".
- Lexicographically smallest order = Kahn's with a **min-heap** instead of a plain queue, `O((V + E) log V)`.
- Applications: build systems, package managers, spreadsheet recalculation, deadlock detection, course planning.
- A topological order is generally not unique unless the DAG happens to form a single chain.

## Common mistakes

| Mistake | Fix |
|---|---|
| Using a plain `visited` boolean for directed-cycle detection | Use 3 states (unvisited / in-progress / done) — a boolean can't distinguish "done elsewhere" from "currently an ancestor" |
| Forgetting to reverse the DFS post-order list | The raw post-order list is backwards; reverse it to get a valid topological order |
| Assuming a topological order is unique | It generally isn't — multiple valid orders exist whenever nodes have no dependency relationship |
| Using a plain queue when "lexicographically smallest order" is required | Use a min-heap/priority queue instead so the smallest available node is always chosen |
| Checking `order.size() == n` incorrectly (e.g. off-by-one, or checking before the BFS finishes) | Check strictly after the BFS/queue loop completes; a shortfall means a cycle exists |
| Applying Union-Find to detect a cycle in a directed graph | Union-Find only handles undirected connectivity — use DFS colouring or Kahn's instead |

## Summary

Topological sort orders the nodes of a DAG so every edge points forward, and it comes in two equally valid flavours: Kahn's BFS-on-in-degrees, which naturally exposes cycle detection (order too short) and extends cleanly to lexicographically-smallest ordering with a min-heap, and DFS with post-order reversal, which is often more natural when you're already doing a DFS-based cycle check with 3-colour marking. Both run in `O(V + E)`. The pattern shows up constantly outside of interviews too — build systems, package managers, spreadsheet engines, and deadlock detectors are all, under the hood, computing or checking for a topological order.

## Top Interview Questions

### Q1. What is a topological sort, and what property must the graph have for one to exist?

A topological sort is a linear ordering of a directed graph's vertices such that for every directed edge `u -> v`, `u` appears before `v` in the ordering. It exists if and only if the graph is a **DAG** (directed acyclic graph) — if there's a directed cycle, some node in that cycle would need to appear before itself, which is impossible, so no valid ordering exists. Detecting the absence of a topological order is therefore equivalent to detecting a cycle, which is why the two topics are always taught together.

### Q2. Explain Kahn's algorithm step by step.

Compute the in-degree (number of incoming edges) of every vertex. Initialise a queue with all vertices that currently have in-degree 0 — they have no unresolved prerequisites. Repeatedly dequeue a vertex, append it to the result order, and for each of its outgoing edges, decrement the target vertex's in-degree; whenever a target's in-degree drops to 0, it becomes newly unblocked and is enqueued. Continue until the queue is empty. If the resulting order contains all `n` vertices, it's a valid topological order; if it contains fewer, the remaining vertices are stuck in a cycle (their in-degree could never reach 0 because they depend on each other). This runs in `O(V + E)` time and `O(V)` space.

### Q3. How does the DFS-based topological sort work, and why do you reverse the post-order?

Run a standard DFS from every unvisited vertex, and each time you finish fully exploring a vertex (i.e. all of its neighbours have been recursively visited), append it to a list — this is the post-order. Because a vertex is only appended after everything reachable from it has already been appended, every vertex ends up positioned *after* all of its "descendants" (things it points to) in that raw list. Reversing the list therefore puts every vertex *before* everything it points to, which is exactly the topological ordering requirement. This also runs in `O(V + E)` time and `O(V)` space for the recursion stack and visited tracking.

### Q4. How do you detect a cycle in a directed graph using DFS, and why isn't a simple visited boolean array enough?

Use three states per node: unvisited, in-progress (currently on the active DFS recursion stack), and done (fully explored, safely finished). During DFS, if you encounter a neighbour marked in-progress, that's a back-edge to an ancestor on the current path — a genuine cycle. A plain boolean `visited` array can't make this distinction: a node visited and fully finished via one branch can legitimately be encountered again from a different, unrelated branch without any cycle existing, and a boolean array would either falsely report a cycle (if you treat "visited" as "in a cycle") or miss detecting real cycles depending on how it's used. The three-state scheme correctly separates "finished, safe to revisit" from "currently an ancestor of the node we're at".

### Q5. What is the difference between Course Schedule I and Course Schedule II, and how does topological sort solve both?

Course Schedule I asks a yes/no question — can all courses be completed given the prerequisite pairs — which is equivalent to asking whether the prerequisite graph is acyclic; either Kahn's algorithm (check if all nodes were processed) or 3-colour DFS cycle detection answers this directly. Course Schedule II asks for an actual valid completion order, or an empty result if impossible; Kahn's algorithm naturally produces this order as a side effect of processing nodes in dependency-respecting sequence, or you can use DFS with post-order reversal, first checking for a cycle before trusting the resulting order.

### Q6. How would you find the lexicographically smallest valid topological order?

Use Kahn's algorithm, but replace the plain FIFO queue with a min-heap (priority queue) over the currently available (in-degree 0) nodes. At each step, always pop the smallest-valued available node rather than just the next one in arbitrary queue order; after processing it and decrementing its neighbours' in-degrees, push any newly-available nodes into the heap as well. This greedily ensures the smallest legal choice is always made first, which produces the lexicographically smallest overall ordering. This adds a `log V` factor to each queue operation, giving `O((V + E) log V)` total instead of Kahn's plain `O(V + E)`.

### Q7. Why doesn't the DFS-with-post-order-reversal approach easily give you the lexicographically smallest topological order?

DFS's post-order is determined by the order recursive calls happen to explore neighbours and by which starting vertex the outer loop happens to pick first, and reversing it at the end only fixes overall direction, not the fine-grained choice of "which available node goes next" at each position. Attempting to force lexicographic order by, say, visiting neighbours in sorted order doesn't actually guarantee a lexicographically smallest *result*, because DFS commits deeply into one branch before considering siblings, unlike Kahn's, which explicitly chooses among **all currently eligible** nodes at each step via the heap. This is why Kahn's with a min-heap is the standard tool whenever "lexicographically smallest" is specifically required.

### Q8. Debugging scenario: your Kahn's-algorithm implementation returns an order with fewer nodes than the graph has, even though you believe the input has no cycle. What would you check?

First, verify the in-degree array was built correctly — a common bug is incrementing the in-degree of the wrong endpoint (`edges[i][0]` vs `edges[i][1]`), which silently produces wrong in-degrees for every node and can make legitimate acyclic graphs appear to have unresolved dependencies. Second, check that every edge in the input was actually added to the adjacency list — a missed edge means a downstream node's in-degree is never decremented, so it never reaches 0 and never gets enqueued, even though no real cycle exists. Third, confirm the queue is seeded with **every** node that starts at in-degree 0, not just node 0 — disconnected components each need their own zero-in-degree seed to be included in the final order.

### Q9. How is topological sort used in build systems and package managers?

A build system or package manager models targets/packages as nodes and "depends on" relationships as directed edges (dependency points to what it needs). A valid topological order of this DAG gives a build/install sequence where every dependency is fully built or installed before anything that needs it is processed — this is exactly why circular dependencies ("A depends on B, B depends on A") are rejected outright by tools like npm, Maven, or Bazel: the underlying dependency graph has no topological order, so there is no valid build sequence, and the tool must report the cycle rather than attempt to build anything. Parallel build systems additionally use the same graph to determine which independent targets (no path between them) can be built concurrently.

### Q10. How does topological sort relate to deadlock detection in an operating system or distributed system?

Model a "wait-for" graph where a directed edge from process A to process B means "A is waiting on a resource currently held by B". A deadlock exists precisely when this graph contains a cycle — a set of processes each waiting on the next, with no process able to proceed — which is exactly the condition under which no topological order exists. Detecting a deadlock is therefore the same algorithmic problem as detecting whether a directed graph is acyclic: 3-colour DFS or Kahn's algorithm (checking whether all nodes get processed) both work directly, and this is a standard technique in database engines and distributed lock managers for detecting transaction deadlocks.

### Q11. Your dependency graph is disconnected — some nodes have no relationship to others at all. Does Kahn's algorithm still work, and does the resulting order mean anything special?

Yes, Kahn's algorithm works unchanged on a disconnected DAG (or a graph with multiple disconnected DAG components): the initial queue is seeded with every node across all components that has in-degree 0, and the algorithm processes all components together, interleaving them in whatever order the queue happens to dequeue. The resulting order is still a valid topological order — every edge still points forward — but the *relative* order between nodes in entirely separate components is arbitrary and carries no dependency meaning, since there's no constraint between them to satisfy in the first place. This is expected behaviour, not a bug.

### Q12. In a spreadsheet application, how would you use topological sort to recalculate formulas correctly and detect a bad reference?

Model each cell as a node and add a directed edge from cell A to cell B if B's formula references A (A must be computed first). Running Kahn's algorithm gives a safe recalculation order — process cells in the order they're dequeued, so no formula is ever evaluated before all the cells it depends on. If the algorithm terminates with fewer processed cells than the total number of formula cells, that shortfall identifies a circular reference (e.g., cell A's formula transitively depends on itself), which the application should report as an error rather than attempt to evaluate — exactly the scenario spreadsheet programs flag as a "circular reference" warning.
