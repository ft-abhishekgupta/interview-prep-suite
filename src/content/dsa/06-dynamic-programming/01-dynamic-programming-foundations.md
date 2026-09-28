---
title: Dynamic Programming Foundations
description: The five-step method for turning a brute-force recursive solution into a DP one, plus how to explain your reasoning out loud in an interview
difficulty: Foundational
tags: [dynamic-programming, recursion, memoization]
---

Dynamic programming is not a separate universe of algorithms — it is brute-force recursion with a cache, applied to problems that recompute the same subproblem many times. Interviewers use DP to test whether you can decompose a problem into states and transitions methodically, rather than pattern-matching a memorised solution.

## Overlapping subproblems and optimal substructure

DP applies when a problem has both of these properties. Miss either one and DP either doesn't help or gives a wrong answer.

| Property | Meaning | Test |
|---|---|---|
| Overlapping subproblems | The same smaller input recurs many times during naive recursion | Draw the recursion tree — do nodes repeat? |
| Optimal substructure | The optimal answer to the whole problem is built from optimal answers to subproblems | Can you write `answer(n) = f(answer(smaller inputs))`? |

```mermaid
graph TD
    F5["fib(5)"] --> F4["fib(4)"]
    F5 --> F3a["fib(3)"]
    F4 --> F3b["fib(3)"]
    F4 --> F2a["fib(2)"]
    F3a --> F2b["fib(2)"]
    F3b --> F2c["fib(2)"]
```

`fib(3)` and `fib(2)` are each recomputed from scratch multiple times — that duplication is *overlapping subproblems*. Caching each distinct `(n)` collapses `O(2ⁿ)` calls to `O(n)`.

> [!KEY]
> If a problem has optimal substructure but **no** overlapping subproblems (e.g. binary search, quicksort's partitioning), memoisation buys you nothing — that's plain divide-and-conquer, not DP.

## How to spot a DP problem

Certain phrasings are strong signals: "count the number of ways", "find the minimum/maximum cost to reach", "can you partition/reach a target", "longest/shortest subsequence satisfying a property". A brute-force recursive or backtracking solution that clearly re-explores the same `(index, remaining budget)` pair is the tell.

> [!TIP]
> Say out loud: *"I'll first write the brute-force recursion, identify what repeats, then memoise it."* This narrates a defensible path to the optimal solution instead of jumping straight to a DP table the interviewer has to reverse-engineer.

## The five-step method

1. **Define the state** — what parameters uniquely describe a subproblem? (e.g. `index`, `remaining capacity`, `tight/loose`.)
2. **Write the recurrence** — how does `state` relate to smaller states? This is the recursive case.
3. **Base case(s)** — the smallest states you can answer directly without recursing further.
4. **Decide the order of computation** — top-down (recursion + memo) needs no explicit order; bottom-up (tabulation) must fill states before they're needed.
5. **Read off the answer** — usually `dp[n]` or `dp[n][full-capacity]`, occasionally a max/min over the whole table.

```java
// Example: climbing stairs, 1 or 2 steps at a time — five steps applied
// 1. State: dp[i] = number of ways to reach step i
// 2. Recurrence: dp[i] = dp[i-1] + dp[i-2]
// 3. Base case: dp[0] = 1, dp[1] = 1
// 4. Order: bottom-up, i = 2 .. n
// 5. Answer: dp[n]
public int climbStairs(int n) {
    if (n <= 1) return 1;
    int prev2 = 1, prev1 = 1, curr = 0;
    for (int i = 2; i <= n; i++) {
        curr = prev1 + prev2;
        prev2 = prev1;
        prev1 = curr;
    }
    return curr;
}
```

## Memoisation vs tabulation

| Aspect | Memoisation (top-down) | Tabulation (bottom-up) |
|---|---|---|
| Direction | Recursive, computes on demand | Iterative, fills a table in order |
| Code shape | Recursion + cache (map or array) | Loop(s) filling `dp[]` |
| Only computes needed states | Yes — can be faster if not all states are reachable | No — fills the whole table, even unused states |
| Stack depth risk | Yes, can stack-overflow on deep recursion | No recursion stack |
| Easier to derive from brute force | Yes — add a cache to existing recursion | Requires figuring out a valid fill order first |
| Easier to space-optimise | Harder — recursion needs the full cache | Easier — often only needs the last row/few variables |

> [!TIP]
> In an interview, write the **memoised** version first — it is a mechanical transformation of the brute force you already have. Only convert to tabulation if asked to remove recursion or optimise space; state that trade-off explicitly. In Java, prefer a primitive `int[]`/`long[]` memo (initialised to a sentinel like `-1`) over a boxed `HashMap<Integer, Integer>` whenever the state is a bounded integer range — boxing and hashing make the map materially slower, and `==` on cached `Integer` values above 127 is a bug waiting to happen.

```java
// Memoisation
private Map<Integer, Long> memo = new HashMap<>();
public long fib(int n) {
    if (n <= 1) return n;
    Long cached = memo.get(n);
    if (cached != null) return cached;
    long v = fib(n - 1) + fib(n - 2);
    memo.put(n, v);
    return v;
}

// Tabulation
public long fibTab(int n) {
    if (n <= 1) return n;
    long[] dp = new long[n + 1];
    dp[0] = 0; dp[1] = 1;
    for (int i = 2; i <= n; i++) dp[i] = dp[i - 1] + dp[i - 2];
    return dp[n];
}
```

## Space optimisation: from O(n) to O(1)

If `dp[i]` only depends on a fixed number of previous entries (not the whole history), you don't need the array at all — just keep those few variables, as in a climbing-stairs recurrence. For 2-D DP where `dp[i][j]` only depends on row `i - 1`, you can drop an `O(n·m)` table to `O(m)` by keeping just the previous row (and updating it in place, carefully, if the transition allows).

| DP shape | Naive space | Optimised space | Condition |
|---|---|---|---|
| 1-D, depends on last 2 states | `O(n)` | `O(1)` | Fixed lookback window |
| 2-D grid, depends on row above | `O(n·m)` | `O(m)` | Row-by-row dependency only |
| Knapsack, depends on previous item's row | `O(n·W)` | `O(W)` | Iterate capacity in the correct direction |

> [!WARNING]
> Space-optimising 0/1 knapsack requires iterating the capacity dimension **backwards** (`W` down to `weight`) so each item is only used once per row. Iterating forwards silently turns it into the *unbounded* knapsack — a subtle, hard-to-spot bug.

## State minimality

A DP state should contain everything that affects future choices, but nothing irrelevant. Leaving out a parameter gives wrong cache hits; adding unnecessary parameters explodes the table. For example, in knapsack the future depends on which item index you are considering and how much capacity remains, not on the exact list of items already chosen. In a path-counting grid, the future depends on the current cell, not on the full path used to reach it unless the problem has a visited-cell constraint. When a memoised solution is still too slow, revisit the state definition before blaming the language or the cache implementation.

## Worked examples

**House robber** — can't rob two adjacent houses; maximise total loot.

```java
// State: dp[i] = max loot considering houses 0..i
// Recurrence: dp[i] = max(dp[i-1], dp[i-2] + nums[i])
// O(n) time, O(1) space
public int rob(int[] nums) {
    int prev2 = 0, prev1 = 0;
    for (int x : nums) {
        int curr = Math.max(prev1, prev2 + x);
        prev2 = prev1;
        prev1 = curr;
    }
    return prev1;
}
```

**Coin change** — fewest coins to make an amount.

```java
// State: dp[a] = min coins to make amount a
// Recurrence: dp[a] = min(dp[a], dp[a - coin] + 1) for each coin
// O(amount * coins) time, O(amount) space
public int coinChange(int[] coins, int amount) {
    int[] dp = new int[amount + 1];
    Arrays.fill(dp, amount + 1);
    dp[0] = 0;
    for (int a = 1; a <= amount; a++)
        for (int c : coins)
            if (c <= a) dp[a] = Math.min(dp[a], dp[a - c] + 1);
    return dp[amount] > amount ? -1 : dp[amount];
}
```

## How to explain a DP solution out loud

A strong narration follows this order, every time: *"The brute force tries every choice at each index, recursing on the rest — that's O(2ⁿ). The state I need to remember is (index, remaining budget), because the answer only depends on those. The recurrence is: either skip this item, or take it and recurse on the reduced budget. The base case is index == n, returning 0. I'll memoise on (index, budget), giving O(n · budget) time and space, then optimise space to O(budget) since each row only needs the previous one."*

## Cheat sheet

- DP needs **both** overlapping subproblems and optimal substructure — check both before reaching for it.
- Five steps, every time: **state → recurrence → base case → order → answer**.
- Start from the brute-force recursion; DP is that recursion **plus a cache**.
- Memoisation is easier to derive; tabulation is easier to space-optimise.
- If `dp[i]` only needs the last `k` rows, keep only `k` rows (or `k` variables).
- **Iteration direction matters** — reversed loops distinguish 0/1 knapsack from unbounded knapsack.
- Count **distinct states** to get the time complexity; multiply by work per state.
- Narrate the recurrence in one sentence before writing code — it catches state-definition mistakes early.

## Common mistakes

| Mistake | Fix |
|---|---|
| Jumping straight to a DP table without stating the state | Always say "dp[i] represents …" before writing the recurrence |
| Missing a base case, causing index-out-of-range or wrong answers | Enumerate the smallest inputs explicitly and hand-verify |
| Filling a bottom-up table in the wrong order | A state must be computed only after everything it depends on |
| Iterating capacity forward in 0/1 knapsack | Iterate backward to avoid reusing an item twice |
| Confusing "optimal substructure" with "greedy works" | Optimal substructure only says the answer *can* be built from subproblem answers, not that a greedy local choice reaches it |
| Not memoising a top-down solution and calling it "done" | Verify duplicate calls actually vanish; add prints or count calls if unsure |

## Summary

Dynamic programming is a disciplined way of turning brute-force recursion into an efficient algorithm by caching answers to subproblems that recur. The five-step method — state, recurrence, base case, order, answer — turns "I don't know where to start" into a mechanical process. Start with memoisation because it mirrors the brute force directly, then convert to tabulation and space-optimise once the recurrence is proven correct. Narrating this process out loud, rather than presenting a finished table, is what makes the answer land as understanding rather than memorisation.

## Top Interview Questions

### Q1. What are the two conditions a problem must satisfy for dynamic programming to apply?

Overlapping subproblems and optimal substructure. Overlapping subproblems means a naive recursive solution recomputes identical smaller inputs many times — you can visualize this as repeated nodes in a recursion tree, like `fib(3)` appearing twice when computing `fib(5)`. Optimal substructure means the optimal solution to the full problem can be constructed from optimal solutions to its subproblems — for example, the shortest path from A to C through B is the shortest A-to-B path plus the shortest B-to-C path. If a problem lacks overlapping subproblems (like binary search), memoisation just adds overhead with zero benefit; if it lacks optimal substructure, caching subproblem answers doesn't even give you a correct final answer.

### Q2. Walk me through your five-step process for approaching a new DP problem.

First, define the **state** — the minimal set of parameters that fully describes a subproblem, such as `(index, remaining capacity)`. Second, write the **recurrence** — how the current state's answer is built from smaller states', usually by enumerating the choices available at this step (take/skip, which coin to use, etc.). Third, identify the **base case(s)** — the smallest states answerable without further recursion. Fourth, decide the **order of computation** — for bottom-up, states must be filled in an order where dependencies are already computed; top-down avoids this by using recursion plus a cache. Fifth, identify what the **final answer** actually reads from the table — often the last cell, sometimes a max/min over a row or the whole table.

### Q3. What's the difference between memoisation and tabulation, and when would you prefer one over the other?

Memoisation (top-down) keeps the original recursive structure and adds a cache — you write the brute force, then store results in a map or array so repeated calls return instantly. Tabulation (bottom-up) is iterative, filling a table in a carefully chosen order with no recursion. Memoisation is faster to derive because it's a minimal edit to code you already wrote, and it only computes states that are actually reached. Tabulation avoids recursion-stack overhead and stack-overflow risk on deep recursion, and it is usually easier to then apply space optimisation, since you control the exact iteration order and can discard old rows.

### Q4. How would you reduce a 2-D DP solution's space from O(n*m) to O(m)?

If `dp[i][j]` only ever depends on values from row `i - 1` (never row `i - 2` or earlier), you don't need to store the whole 2-D table — just keep the "previous row" and compute the "current row" into a second array of size `m`, then swap references (or overwrite in place if the update order allows it safely). A concrete example is the edit-distance or LCS table, where `dp[i][j]` depends only on `dp[i-1][j]`, `dp[i][j-1]`, and `dp[i-1][j-1]` — all reachable from at most the previous row plus the current row being built left to right.

### Q5. In the 0/1 knapsack problem, why must you iterate the capacity dimension backwards when optimising to 1-D?

The 1-D array `dp[w]` represents "best value using items processed so far, with capacity `w`". If you iterate `w` from low to high while processing an item, an earlier (smaller) `w` update using this item can be read again by a later (larger) `w` in the same pass — effectively allowing the same item to be used twice, since you'd be reading a value that already includes taking the current item. Iterating from high capacity down to the item's weight guarantees that when you compute `dp[w]`, `dp[w - weight]` still reflects only *previous* items, preserving the 0/1 (use-at-most-once) constraint. This backward-iteration trick is exactly what distinguishes a space-optimised 0/1 knapsack from an unbounded knapsack, which iterates forward on purpose.

### Q6. How do you compute the time complexity of a DP solution?

Multiply the number of **distinct states** by the **work done per state** (the cost of the recurrence's transition, ignoring the recursive calls themselves). For example, in a 2-D `dp[i][j]` over `n` items and `W` capacity, there are `O(n * W)` states, and if each transition is O(1) (comparing two or three previous cells), the total is `O(n * W)`. If a state's transition instead loops over `k` choices (like coin change looping over all coin denominations), multiply by `k` as well: `O(amount * coins)`. This is the same "count nodes times work per node" logic used for plain recursion, just applied to the memoised state space instead of the raw call tree.

### Q7. You wrote a memoised recursive solution but it's still timing out — what would you check first?

First, verify the cache key actually captures the *full* state — if two calls with genuinely different sub-results are colliding on the same key (or, more commonly, the key is missing a parameter that affects the answer), you get wrong answers, not necessarily slowness, but an incomplete key can also cause redundant recomputation. Second, check whether the state space itself is simply too large — e.g., a state involving a bitmask over 30 items is `2^30` states, which is too many regardless of caching. Third, confirm you're actually using the cache (a common bug is checking the cache but forgetting to *populate* it before returning, so every call recomputes from scratch).

### Q8. What's the difference between "optimal substructure" and greedy problems being solvable optimally?

Optimal substructure means the optimal answer to a problem can be *constructed from* optimal answers to subproblems — but that doesn't mean picking one option greedily at each step, without considering all subproblem answers, will reach that optimum. DP explicitly considers all valid ways to combine subproblem solutions (via the recurrence, often a max/min over multiple choices) and picks the best; greedy commits to one choice per step without that comparison, based on some property proven to be safe (like the exchange argument or cut property in MST). Coin change with arbitrary denominations is the classic counterexample: it has optimal substructure, but a greedy "always take the largest coin" strategy fails for denominations like `{1, 3, 4}` targeting `6` (greedy gives 4+1+1=three coins, optimal is 3+3=two coins).

### Q9. How would you explain, out loud in an interview, how you arrived at a DP solution for an unfamiliar problem?

Narrate the five steps as you go: start with the brute-force recursive solution and its complexity, point out where the recursion tree repeats identical subproblems, define the state that captures "what varies between calls", write the recurrence as a sentence before code ("the answer at index i is the best of taking or skipping"), state the base case, and only then write the memoised code. Finish by stating the resulting time and space complexity and whether it can be space-optimised. This shows the interviewer a repeatable process rather than a memorized answer, which matters most when the problem is a variant they haven't seen phrased exactly this way before.

### Q10. Two different states in your DP table happen to produce the same numeric value — does that mean you can merge them?

Not necessarily — merging states is only safe if they are truly *equivalent* for all future transitions, not just coincidentally equal in one specific input. For example, in a knapsack-style problem, `dp[i][5]` and `dp[j][5]` might both equal `10`, but if `i` and `j` represent different *remaining item sets* available for future choices, treating them as the same state would corrupt subsequent transitions. The state definition must capture everything that affects *future* recurrence steps, not just the current value — conflating "same value" with "same state" is a common source of subtle DP bugs.

### Q11. When would you choose an iterative (tabulation) DP solution over recursion even without an explicit space-optimisation requirement?

When recursion depth could exceed the language/runtime's stack limit — a memoised solution over `n = 10^6` states with a linear dependency chain (like Fibonacci) risks a stack overflow in Java (which performs no tail-call optimisation, so every call keeps its frame) well before it risks a time limit issue, since each recursive call adds a stack frame. Tabulation avoids this entirely since it's a plain loop. It's also preferable when you already know you'll need every state (no early-exit benefit from memoisation's on-demand computation), since the iterative version usually has lower constant-factor overhead than recursive calls plus map lookups.

### Q12. How does DP relate to graph shortest-path algorithms like Bellman-Ford?

Bellman-Ford is a DP algorithm in disguise: the state is `(number of edges used, vertex)`, the recurrence is "the shortest path using at most `k` edges to reach `v` is the minimum over all incoming edges `(u, v)` of the shortest path using at most `k-1` edges to `u`, plus the edge weight", and the base case is `dist[source] = 0` with `k = 0`. This framing explains directly why `V - 1` rounds suffice — it mirrors exactly why a DP recurrence only needs states up to the maximum meaningful "index" (here, path length in edges). Recognizing DP inside other named algorithms (edit distance is also structurally identical to certain alignment/matching DPs) is a strong signal of deep understanding rather than pattern memorisation.
