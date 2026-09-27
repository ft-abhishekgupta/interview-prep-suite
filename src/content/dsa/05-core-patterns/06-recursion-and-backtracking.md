---
title: Recursion and Backtracking
description: The choose-explore-unchoose template for exploring all possibilities, why it works, how to prune it, and when memoisation turns it into dynamic programming
difficulty: Core
tags: [recursion, backtracking, dfs, patterns]
---

Backtracking is recursion with a discipline: try a choice, recurse as if it were correct, then undo it and try the next one. Almost every "generate all X" or "find if some arrangement of X is possible" question reduces to this one template, plus a pruning rule specific to the problem.

## Base case, recursive case, and the call stack

Every recursive function needs a **base case** (a condition that returns directly, without recursing) and a **recursive case** (a step that reduces the problem and calls itself). The call stack tracks every pending call's local variables and the point it needs to resume from — this is what makes recursion "remember" the state of the outer call while the inner one runs.

```java
// Base case + recursive case
int factorial(int n) {
    if (n <= 1) return 1;         // base case
    return n * factorial(n - 1);  // recursive case
}
```

> [!WARNING]
> Every recursive call adds a stack frame. A recursion depth of `n` costs `O(n)` stack space — a naive recursive traversal of a 10⁶-element linked list will stack overflow in most languages, Java included. If depth can be large and unbounded by tree balance, convert to iteration with an explicit stack.

## Recursion to iteration

Any recursive algorithm can be rewritten iteratively using an explicit stack that mimics what the call stack was doing — this is worth demonstrating if asked to avoid recursion (e.g. for stack-depth safety).

```java
// Recursive DFS
void dfs(Node node) { if (node == null) return; visit(node); for (Node c : node.children) dfs(c); }

// Iterative equivalent using an explicit stack (ArrayDeque rejects null, so guard)
void dfsIterative(Node root) {
    if (root == null) return;
    Deque<Node> stack = new ArrayDeque<>();
    stack.push(root);
    while (!stack.isEmpty()) {
        Node node = stack.pop();
        visit(node);
        for (Node c : node.children)
            if (c != null) stack.push(c);
    }
}
```

## The choose-explore-unchoose template

Backtracking generalises recursion for exploring a search tree of decisions: at each node, try every valid choice, recurse into it, then undo the choice before trying the next one — leaving shared state exactly as you found it.

```mermaid
flowchart TD
    A["current partial solution"] --> B["choose option 1"]
    A --> C["choose option 2"]
    B --> D["explore: recurse deeper"]
    D --> E["unchoose option 1"]
    C --> F["explore: recurse deeper"]
    F --> G["unchoose option 2"]
```

```java
// Generic backtracking skeleton
void backtrack(List<Integer> current /*, remaining choices/state */) {
    if (/* current is a complete solution */) {
        result.add(new ArrayList<>(current));   // copy — current keeps mutating
        return;
    }
    for (int choice = /* first option */; /* valid */; choice++) {
        if (/* choice invalid or already used */) continue;   // pruning
        current.add(choice);              // choose
        backtrack(current /*, ... */);    // explore
        current.remove(current.size() - 1);   // unchoose
    }
}
```

> [!KEY]
> The single most common bug is forgetting the "unchoose" step, or adding the *reference* to `current` instead of a copy to the result — both leave stale state that corrupts every subsequent branch.

## Subsets

Each element has two choices: include it, or don't. This is a binary decision tree of depth `n`.

```java
// O(n * 2^n) time (2^n subsets, O(n) to copy each), O(n) recursion depth
public List<List<Integer>> subsets(int[] nums) {
    List<List<Integer>> result = new ArrayList<>();
    backtrack(nums, 0, new ArrayList<>(), result);
    return result;
}

private void backtrack(int[] nums, int start, List<Integer> current, List<List<Integer>> result) {
    result.add(new ArrayList<>(current));
    for (int i = start; i < nums.length; i++) {
        current.add(nums[i]);
        backtrack(nums, i + 1, current, result);
        current.remove(current.size() - 1);
    }
}
```

## Permutations

Every position can hold any unused element — track "used" explicitly instead of a start index, since order matters and every element must eventually appear in every position.

```java
// O(n * n!) time, O(n) recursion depth plus O(n) for the used[] array
public List<List<Integer>> permute(int[] nums) {
    List<List<Integer>> result = new ArrayList<>();
    backtrack(nums, new boolean[nums.length], new ArrayList<>(), result);
    return result;
}

private void backtrack(int[] nums, boolean[] used, List<Integer> current, List<List<Integer>> result) {
    if (current.size() == nums.length) { result.add(new ArrayList<>(current)); return; }
    for (int i = 0; i < nums.length; i++) {
        if (used[i]) continue;
        used[i] = true;
        current.add(nums[i]);
        backtrack(nums, used, current, result);
        current.remove(current.size() - 1);
        used[i] = false;
    }
}
```

## Combination sum

Elements can be **reused**, so the recursive call doesn't advance past the current index unless you decide not to reuse it — the pruning here is on the running sum, not on a "used" flag.

```java
// O(2^target) worst case, O(target / min(candidates)) recursion depth
public List<List<Integer>> combinationSum(int[] candidates, int target) {
    List<List<Integer>> result = new ArrayList<>();
    backtrack(candidates, 0, target, new ArrayList<>(), result);
    return result;
}

private void backtrack(int[] candidates, int start, int remaining,
                       List<Integer> current, List<List<Integer>> result) {
    if (remaining == 0) { result.add(new ArrayList<>(current)); return; }
    if (remaining < 0) return;                              // prune: overshoot
    for (int i = start; i < candidates.length; i++) {
        current.add(candidates[i]);
        backtrack(candidates, i, remaining - candidates[i], current, result);  // i, not i+1 — reuse allowed
        current.remove(current.size() - 1);
    }
}
```

## N-Queens

The queens are placed row by row; the pruning check is "does this column, or either diagonal, already have a queen" — tracked with three boolean sets instead of scanning the board each time.

```java
// O(n!) worst case with pruning, O(n) recursion depth
public int totalNQueens(int n) {
    boolean[] cols = new boolean[n];
    boolean[] diag1 = new boolean[2 * n];    // row + col is constant along a "\" diagonal
    boolean[] diag2 = new boolean[2 * n];    // row - col + n is constant along a "/" diagonal
    return backtrack(0, n, cols, diag1, diag2);
}

private int backtrack(int row, int n, boolean[] cols, boolean[] diag1, boolean[] diag2) {
    if (row == n) return 1;
    int count = 0;
    for (int col = 0; col < n; col++) {
        if (cols[col] || diag1[row + col] || diag2[row - col + n]) continue;   // prune
        cols[col] = diag1[row + col] = diag2[row - col + n] = true;
        count += backtrack(row + 1, n, cols, diag1, diag2);
        cols[col] = diag1[row + col] = diag2[row - col + n] = false;
    }
    return count;
}
```

## Word search

Backtracking over a grid: at each step, try all four directions, marking the current cell visited before recursing and un-marking it on the way back out — the grid itself doubles as the "used" tracker.

```java
// O(rows * cols * 4^L) worst case, where L is the word length
public boolean exist(char[][] board, String word) {
    int rows = board.length, cols = board[0].length;
    for (int r = 0; r < rows; r++)
        for (int c = 0; c < cols; c++)
            if (dfs(board, word, r, c, 0)) return true;
    return false;
}

private boolean dfs(char[][] board, String word, int r, int c, int idx) {
    if (idx == word.length()) return true;
    if (r < 0 || r >= board.length || c < 0 || c >= board[0].length || board[r][c] != word.charAt(idx))
        return false;
    char temp = board[r][c];
    board[r][c] = '#';                          // mark visited in place
    boolean found = dfs(board, word, r + 1, c, idx + 1) || dfs(board, word, r - 1, c, idx + 1) ||
                    dfs(board, word, r, c + 1, idx + 1) || dfs(board, word, r, c - 1, idx + 1);
    board[r][c] = temp;                          // unchoose
    return found;
}
```

## Pruning strategies

| Strategy | Example |
|---|---|
| Bound checking (stop early if already invalid) | `if (remaining < 0) return;` in combination sum |
| Sort input, skip duplicates at the same recursion level | Subsets II / Combination Sum II — skip `nums[i] == nums[i-1]` unless it's the first choice at this level |
| Track "used" state with O(1) lookups | Boolean arrays for columns/diagonals in N-Queens, instead of scanning the board |
| Symmetry / early exit on first solution found | Word search returns as soon as one path succeeds |
| Constrain the branching factor itself | Only try candidates `>= ` the last chosen one, to avoid generating the same combination in different orders |

> [!TIP]
> When asked for the complexity of a backtracking solution, describe it as **(branching factor) ^ (depth)**, then explain how pruning reduces the *practical* runtime even though the worst-case bound stays the same — that is the answer a senior engineer gives.

## Complexity of backtracking

There is no single formula — it depends on the branching factor and depth of the search tree, and pruning changes the *practical* cost without necessarily changing the *worst-case* bound.

| Problem | Branching factor | Depth | Worst-case time |
|---|---|---|---|
| Subsets | 2 (include/exclude) | n | `O(2ⁿ)` |
| Permutations | shrinks from n to 1 | n | `O(n!)` |
| Combination sum (with reuse) | up to n candidates | up to `target / min` | `O(2^target)`-ish, bounded by pruning |
| N-Queens | up to n columns per row | n | `O(n!)`, heavily pruned in practice |

> [!DANGER]
> Quoting "O(2ⁿ)" for every backtracking problem without checking the actual branching factor is a common shortcut that falls apart the moment you're asked to justify it — permutations are `O(n!)`, not `O(2ⁿ)`, and combination-sum-with-reuse doesn't fit either bound cleanly.

## Memoisation: the bridge to dynamic programming

If a backtracking recursion revisits the **same subproblem** (same remaining state) multiple times through different paths, caching results turns exponential backtracking into polynomial dynamic programming. The signal is: does the recursive call depend only on a small, reusable set of parameters (like `(index, remaining sum)`), rather than the entire path taken to get there? If yes, memoise.

```java
// Naive combination-sum style recursion revisits (index, remaining) many times
// Memoising on (index, remaining) turns it from exponential into O(n * target)
Map<Long, Boolean> memo = new HashMap<>();
boolean canReach(int index, int remaining) {
    if (remaining == 0) return true;
    if (index == n || remaining < 0) return false;
    long key = ((long) index << 32) | (remaining & 0xffffffffL);   // encode (index, remaining)
    Boolean cached = memo.get(key);
    if (cached != null) return cached;
    boolean result = canReach(index + 1, remaining) || canReach(index, remaining - value[index]);
    memo.put(key, result);
    return result;
}
```

This is precisely why "recursion + memoisation" and "dynamic programming" are often described as the same idea approached from opposite directions: DP with a table is backtracking's search tree collapsed onto only the distinct states that actually matter.

## Cheat sheet

- Every recursive function needs a base case and a recursive case that provably shrinks the problem.
- Recursion depth = stack space; deep/unbalanced recursion risks a stack overflow — convert to an explicit-stack loop if needed.
- Backtracking template: choose, explore (recurse), unchoose — always undo before trying the next branch.
- Subsets: include/exclude each element once → `O(2ⁿ)`.
- Permutations: track "used" per position → `O(n!)`.
- Combination sum: allow reuse by not advancing the start index; prune on `remaining < 0`.
- N-Queens/Sudoku-style: track constraints (columns, diagonals) in O(1) lookup structures, not by rescanning.
- Complexity is branching factor ^ depth — state the actual branching factor, don't default to `O(2ⁿ)`.
- If the same `(state)` recurs via different paths, memoise it — that's dynamic programming.

## Common mistakes

| Mistake | Fix |
|---|---|
| Forgetting the "unchoose" (undo) step after recursing | Always remove/reset exactly what "choose" added, in the same scope |
| Adding a reference to the running list into the result instead of a copy | Use `new ArrayList<>(current)` (or equivalent) when appending to results |
| Advancing the start index in combination-sum-with-reuse | Recurse with the same index `i`, not `i + 1`, to allow reuse |
| Not pruning duplicate branches when input has duplicate values | Sort first, and skip `nums[i] == nums[i-1]` at the same recursion depth (not across depths) |
| Re-scanning the whole board/row for constraint checks in N-Queens | Track column/diagonal usage in boolean arrays for O(1) checks |
| Assuming every backtracking problem is `O(2ⁿ)` | Compute branching factor and depth for the specific problem |
| Recursing without a base case guard, or with a base case that never triggers | Verify the recursive case strictly shrinks toward the base case on every call |

## Summary

Backtracking is recursive search over a decision tree, disciplined by a strict choose/explore/unchoose cycle so that shared state is always restored before the next branch is tried. Subsets, permutations, combination sum, N-Queens, and word search are all the same template with a different choice set and a different pruning rule. The complexity is branching factor raised to depth, and pruning reduces practical runtime even when it doesn't change the worst-case bound. The moment the same subproblem recurs through different paths, memoising it is the one-line change that turns exponential backtracking into polynomial dynamic programming.

## Top Interview Questions

### Q1. What is the difference between plain recursion and backtracking?

Plain recursion is any function that calls itself to solve a smaller instance of the same problem, with a base case to stop. Backtracking is a specific style of recursion used for exploring a search space of choices: at each step you try a candidate choice, recurse as if it were part of the solution, and then explicitly **undo** that choice before trying the next candidate, so that sibling branches never see stale state from a previous branch. Not all recursion is backtracking — a simple factorial or Fibonacci function is recursive but has no "choices" to explore or undo — but all backtracking is built on recursion.

### Q2. Why does every recursive call cost stack space, and when should you convert recursion to iteration?

Each recursive call pushes a new stack frame holding that call's local variables and the return address to resume execution. This means recursion depth directly translates into `O(depth)` extra memory, and the JVM gives each thread a fixed stack size (tunable with `-Xss`, typically ~512KB–1MB), so sufficiently deep recursion causes a `StackOverflowError`. Java also performs no tail-call optimisation, so even tail-recursive calls consume a frame each. Convert to an explicit-stack iterative version when the recursion depth is unbounded or can scale with input size in an unbalanced way — for example, DFS on a long linked list or a heavily skewed tree — since an explicit stack lives on the heap and isn't limited by the call stack's fixed size.

### Q3. Walk through the choose-explore-unchoose template and explain why the "unchoose" step matters.

At each recursive call, you iterate over the valid choices remaining at this point. For each one: add it to the current partial solution ("choose"), recursively call yourself to continue building from this new state ("explore"), then remove it again ("unchoose") before moving on to the next candidate choice. The "unchoose" step matters because the partial solution is almost always a single shared mutable object (like a `List<Integer>`) reused across the entire search — without undoing a choice, the next sibling branch would incorrectly inherit state left over from a previous branch, producing wrong or duplicate results.

### Q4. How do subsets and permutations differ in their backtracking structure, and what does that do to their complexity?

Subsets make a binary include/exclude decision for each element exactly once, using a `start` index that only ever advances forward — this gives a search tree with branching factor 2 and depth n, for `O(2ⁿ)` total subsets. Permutations must place every element in every position, so instead of a start index you track a `used` boolean array, and the branching factor shrinks from n down to 1 as fewer unused elements remain at each depth — this gives `O(n!)` total permutations. The key structural difference is: subsets choose *whether* to include each element once; permutations choose *which* remaining element goes next, repeatedly.

### Q5. In Combination Sum, why do you recurse with the same start index instead of start + 1?

Combination Sum allows the same candidate value to be reused an unlimited number of times within one combination, as long as the running sum doesn't exceed the target. Recursing with `Backtrack(i, remaining - candidates[i])` (same index `i`) keeps `candidates[i]` eligible to be chosen again in the next recursive call. If you instead advanced to `i + 1`, you would prevent the same value from being picked twice, which is correct for problems like Combination Sum II (each candidate used at most once) but wrong here — the pruning check `if (remaining < 0) return;` is what keeps the recursion from running away indefinitely despite allowing reuse.

### Q6. How does N-Queens use pruning to avoid checking every possible board configuration?

Rather than placing all n queens and then checking the whole board for conflicts, N-Queens places one queen per row and immediately validates the column and both diagonals before recursing further — using three boolean lookup arrays (columns, and two diagonal arrays indexed by `row + col` and `row - col + n`) for O(1) conflict checks instead of rescanning the board. This means an invalid placement is rejected at the row it's introduced, pruning an entire subtree of otherwise-explored placements immediately, rather than after placing all n queens and discovering the conflict at the end — this is what keeps N-Queens tractable well beyond what the raw `O(n!)` bound would suggest.

### Q7. What's the time complexity of the Word Search backtracking solution, and why?

Starting a DFS from every one of the `rows * cols` cells, and at each step of matching the word, branching into up to 4 directions, gives a worst-case complexity of `O(rows * cols * 4^L)`, where `L` is the length of the word being searched for — the `4^L` comes from the branching factor (4 directions) raised to the search depth (word length). In practice, this is heavily pruned by the early-exit character mismatch check (`board[r][c] != word[idx]`) and by marking cells visited in place to prevent reusing the same cell twice within one path, both of which cut off the vast majority of the theoretical branches immediately.

### Q8. Debugging scenario: your backtracking function for generating subsets returns a list where every subset looks identical (all empty, or all the same). What's the bug?

This is almost always caused by adding a reference to the shared mutable `current` list directly into the results list, instead of a copy — since `current` keeps being mutated (elements added and removed) throughout the rest of the recursion, every reference stored earlier ends up reflecting whatever `current`'s *final* state happens to be, not its state at the moment it was added. The fix is to copy the list at the point of insertion, e.g. `result.add(new ArrayList<>(current))` rather than `result.add(current)`, ensuring each stored result is an independent snapshot rather than a live view into the shared working list.

### Q9. How do you avoid generating duplicate combinations when the input array contains duplicate values (e.g. Subsets II, Combination Sum II)?

Sort the input first so that equal values become adjacent. Then, within a single level of the recursion's for-loop (not across different depths), skip a candidate if it equals the previous candidate considered **at that same loop level** and the previous one was already tried and fully explored — typically written as `if (i > start && nums[i] == nums[i-1]) continue;`. This specifically prevents choosing the "second identical value" as if it were a distinct choice at the same decision point, while still correctly allowing identical values to appear together when they were both included going deeper into the recursion (which is a different code path, not the same loop level).

### Q10. When does a backtracking solution's recursion become dynamic programming, and how would you convert one to the other?

When the same subproblem — identified by a small, reusable set of parameters, like `(current index, remaining target)` — is reached repeatedly through different sequences of choices, the naive backtracking recursion recomputes the same result exponentially many times. Adding a memo (a map or array keyed on that parameter tuple) that caches and short-circuits repeated calls converts the exponential search into one that computes each distinct state only once, turning it into a top-down dynamic programming solution with complexity roughly `O(number of distinct states * work per state)`. The conversion is mechanical: identify the parameters that fully determine the subproblem's answer (ignoring the path taken to reach them), and wrap the recursive call with a cache check and cache write.

### Q11. In a production system, why might you avoid deep unbounded recursion (like naive backtracking) even if it's asymptotically correct?

Beyond the `O(depth)` stack space concern, unbounded or very deep recursion in a production service risks a hard crash (a `StackOverflowError` in Java is an `Error`, not an `Exception` — you should not try to catch or recover from it, and it typically unwinds the offending thread), unpredictable latency spikes if the recursion depth depends on user-controlled input size, and harder-to-profile call stacks in production monitoring tools compared to an explicit loop with visible state. For backtracking specifically, worst-case exponential blowup on adversarial input (e.g., a pathological N-Queens or word-search board) can also cause request timeouts; production code typically adds explicit depth/time budgets, iterative deepening, or falls back to an approximate/greedy answer past a certain input size rather than trusting the theoretical worst case never occurs.

### Q12. How would you estimate the complexity of a backtracking solution you haven't seen before, in an interview?

Identify two things: the branching factor (how many choices are available at each decision point) and the depth of the recursion (how many decisions are made before reaching a base case), then state the complexity as roughly branching-factor raised to depth, adjusted for any per-node work (like copying a solution into the results list). Then separately note what pruning is present and how it affects the *practical* — not asymptotic — running time: pruning rarely changes the textbook worst-case bound, but it can make the difference between a solution finishing in milliseconds versus timing out on real inputs. Stating both the theoretical bound and the practical pruning effect is what a strong answer sounds like.
