---
title: Must Solve Problem List
description: A curated set of about 120 problems organised by pattern, with a 6-week study order and a 25-problem list for when you only have 3 days left
difficulty: Core
tags: [problem-list, practice-plan, patterns]
---

Solving problems at random produces the illusion of progress without the pattern recognition interviews actually test. This list groups roughly 120 problems by the technique they teach, in the order most candidates should learn them, so each new problem reinforces a pattern instead of feeling like a fresh puzzle.

## How to use this list

Work pattern by pattern, not top-to-bottom by difficulty. Solve 2–3 problems per pattern, notice what's shared, then move on — depth on every pattern beats exhaustive drilling of one.

```mermaid
flowchart LR
    A["Pick a pattern"] --> B["Solve 1 easy + 1-2 medium"]
    B --> C["Re-derive the recurrence/technique<br/>without looking at your old solution"]
    C --> D{"Solved in target time?"}
    D -- "No" --> B
    D -- "Yes" --> E["Move to next pattern"]
```

> [!KEY]
> The goal of any problem list is **pattern recognition under time pressure**, not memorising 120 individual solutions. If you can't name the pattern within 60 seconds of reading a new problem, that's the gap to close — not more volume.

## Arrays, strings and hashing

| Pattern | Problem | Difficulty | Key idea |
|---|---|---|---|
| Hash complement | Two Sum | Easy | Store seen values, check `target - x` |
| Kadane's algorithm | Maximum Subarray | Medium | Reset running sum when it goes negative |
| Prefix/suffix product | Product of Array Except Self | Medium | Two passes, no division |
| One-pass greedy | Best Time to Buy and Sell Stock | Easy | Track minimum price seen so far |
| In-place swap | Rotate Array | Medium | Reverse whole, then reverse in two parts |
| Two pointers on sorted | 3Sum | Medium | Sort, fix one, two-pointer the rest |
| Frequency map | Group Anagrams | Medium | Sorted string or char-count as map key |
| Frequency map | Valid Anagram | Easy | Character count comparison |
| Prefix sum + hash map | Subarray Sum Equals K | Medium | Store running sum counts, check `sum - k` |
| Hash set of starts | Longest Consecutive Sequence | Medium | Only start counting from a number with no left neighbour |

## Two pointers, sliding window and binary search

| Pattern | Problem | Difficulty | Key idea |
|---|---|---|---|
| Opposite-direction pointers | Container With Most Water | Medium | Move the shorter wall inward |
| Opposite-direction pointers | Trapping Rain Water | Hard | Track max-left/max-right per pointer |
| Fast/slow-style scan | Remove Duplicates from Sorted Array | Easy | Write pointer only advances on new value |
| Dutch national flag | Sort Colors | Medium | Three pointers: low, mid, high |
| Variable window | Longest Substring Without Repeating Characters | Medium | Shrink window when a duplicate enters |
| Variable window | Minimum Window Substring | Hard | Expand until valid, then shrink to minimize |
| Fixed + variable window | Longest Repeating Character Replacement | Medium | Window valid while `length - maxFreq <= k` |
| Monotonic deque | Sliding Window Maximum | Hard | Deque holds indices in decreasing value order |
| Classic binary search | Binary Search | Easy | `lo <= hi`, `mid = lo + (hi-lo)/2` |
| Binary search on rotated array | Search in Rotated Sorted Array | Medium | Identify which half is sorted, then decide |
| Binary search on answer | Koko Eating Bananas | Medium | Binary search the speed, check feasibility |
| Binary search on answer | Capacity To Ship Packages Within D Days | Medium | Binary search the capacity |
| Binary search across two arrays | Median of Two Sorted Arrays | Hard | Partition both arrays so left halves balance |

## Stacks, linked lists and design

| Pattern | Problem | Difficulty | Key idea |
|---|---|---|---|
| Matching stack | Valid Parentheses | Easy | Push opens, pop-and-check on closes |
| Auxiliary stack | Min Stack | Medium | Second stack tracks running minimum |
| Monotonic stack | Daily Temperatures | Medium | Stack of indices waiting for a warmer day |
| Monotonic stack | Largest Rectangle in Histogram | Hard | Stack of increasing bar indices, pop on decrease |
| Stack-based evaluation | Evaluate Reverse Polish Notation | Medium | Push operands, pop two on operator |
| Two-pointer reversal | Reverse Linked List | Easy | Track prev/curr/next while relinking |
| Fast/slow pointers | Linked List Cycle | Easy | Floyd's cycle detection |
| Fast/slow pointers | Remove Nth Node From End | Medium | Advance fast pointer n steps first |
| Merge technique | Merge Two Sorted Lists | Easy | Dummy head, splice smaller node each step |
| Heap + merge | Merge K Sorted Lists | Hard | Min-heap of list heads, pop/push repeatedly |
| Hash map + doubly linked list | LRU Cache | Medium | O(1) get/put via map + eviction at list tail |
| Two hash maps + buckets | LFU Cache | Hard | Frequency-bucketed doubly linked lists |
| Hash map of copies | Copy List with Random Pointer | Medium | Map original node to its clone, two passes |

## Trees, BSTs, tries and heaps

| Pattern | Problem | Difficulty | Key idea |
|---|---|---|---|
| Recursive depth | Maximum Depth of Binary Tree | Easy | `1 + max(left, right)` |
| Recursive mirroring | Invert Binary Tree | Easy | Swap left/right recursively |
| BFS level order | Binary Tree Level Order Traversal | Medium | Queue, process one level's worth at a time |
| Post-order recursion | Diameter of Binary Tree | Easy | Track max of `leftDepth + rightDepth` while computing depth |
| Bounds-passing recursion | Validate Binary Search Tree | Medium | Pass down valid `(min, max)` range |
| Recursive comparison | Lowest Common Ancestor of a BST | Medium | Branch toward the side containing both targets |
| Pre-order + hash map | Serialize and Deserialize Binary Tree | Hard | Encode nulls explicitly, rebuild with a queue/iterator |
| Post-order with global max | Binary Tree Maximum Path Sum | Hard | Track best path through each node, ignore negative branches |
| In-order traversal | Kth Smallest Element in a BST | Medium | In-order gives sorted order for free |
| Prefix tree | Implement Trie (Prefix Tree) | Medium | Node per character, `isEnd` flag |
| Trie + DFS backtracking | Word Search II | Hard | Trie prunes the DFS across the whole board |
| Heap of size k | Kth Largest Element in an Array | Medium | Min-heap of size k, or quickselect |
| Heap + frequency map | Top K Frequent Elements | Medium | Bucket sort by frequency, or heap of size k |
| Two heaps | Find Median from Data Stream | Hard | Max-heap for lower half, min-heap for upper half |
| Heap + cooldown counting | Task Scheduler | Medium | Max-heap of counts, simulate cooldown slots |

## Graphs and union-find

| Pattern | Problem | Difficulty | Key idea |
|---|---|---|---|
| Grid BFS/DFS | Number of Islands | Medium | Flood fill, count triggers |
| Grid multi-source BFS | Rotting Oranges | Medium | Start BFS from all rotten oranges simultaneously |
| Graph BFS/DFS clone | Clone Graph | Medium | Map original node to clone, DFS/BFS with visited check |
| Topological sort (Kahn's) | Course Schedule | Medium | Indegree-0 queue; cycle if not all nodes processed |
| Topological sort | Course Schedule II | Medium | Same as above, but record the order |
| Multi-source BFS | Pacific Atlantic Water Flow | Medium | BFS inward from both ocean borders, intersect reachable sets |
| BFS shortest transformation | Word Ladder | Hard | BFS over words one letter apart |
| Dijkstra | Network Delay Time | Medium | Shortest path from one source, take the max distance |
| Union-Find | Redundant Connection | Medium | First edge whose union fails is the answer |
| Union-Find | Number of Connected Components in an Undirected Graph | Medium | Count distinct roots after unioning all edges |
| Union-Find | Accounts Merge | Medium | Union accounts sharing an email, group by root |
| Union-Find or DFS | Graph Valid Tree | Medium | Exactly `n-1` edges and fully connected, no cycle |

## Backtracking and greedy

| Pattern | Problem | Difficulty | Key idea |
|---|---|---|---|
| Include/exclude backtracking | Subsets | Medium | At each index, branch on take/skip |
| Include/exclude with dedup | Subsets II | Medium | Sort first, skip duplicate siblings at the same depth |
| Swap-based backtracking | Permutations | Medium | Fix position, swap remaining elements in and out |
| Choose-with-repeat backtracking | Combination Sum | Medium | Recurse without advancing index, to allow reuse |
| Choose-once with dedup | Combination Sum II | Medium | Sort, skip duplicate siblings, advance index |
| Grid DFS backtracking | Word Search | Medium | DFS with a visited marker, unmark on backtrack |
| Constraint backtracking | N-Queens | Hard | Track occupied columns/diagonals, prune early |
| Interval backtracking | Palindrome Partitioning | Medium | Try every prefix that's a palindrome, recurse on the rest |
| Greedy max-reach | Jump Game | Medium | Track farthest index reachable so far |
| Greedy BFS-like counting | Jump Game II | Medium | Count levels of the reachable "frontier" |
| Greedy simulation | Gas Station | Medium | If total gas ≥ total cost, a valid start exists |
| Greedy sort by end | Partition Labels | Medium | Extend partition boundary to each letter's last occurrence |

## Dynamic programming

| Pattern | Problem | Difficulty | Key idea |
|---|---|---|---|
| 1-D DP | Climbing Stairs | Easy | `dp[i] = dp[i-1] + dp[i-2]` |
| 1-D DP, non-adjacent | House Robber | Medium | `dp[i] = max(dp[i-1], dp[i-2] + nums[i])` |
| 1-D DP, circular | House Robber II | Medium | Run linear version twice, excluding first or last house |
| Unbounded knapsack | Coin Change | Medium | `dp[a] = min(dp[a], dp[a-coin] + 1)` |
| LIS | Longest Increasing Subsequence | Medium | `O(n log n)` with binary search over tails |
| LCS | Longest Common Subsequence | Medium | `dp[i][j]` matches or takes the better neighbour |
| Edit distance | Edit Distance | Hard | `1 + min(insert, delete, replace)` |
| String segmentation DP | Word Break | Medium | `dp[i]` = can segment `s[0..i)` using the dictionary |
| Grid DP | Unique Paths | Medium | `dp[i][j] = dp[i-1][j] + dp[i][j-1]` |
| Subset sum | Partition Equal Subset Sum | Medium | Subset-sum with target = `total / 2` |
| 1-D DP with cases | Decode Ways | Medium | Consider 1-digit and 2-digit decodings at each step |
| Kadane variant | Maximum Product Subarray | Medium | Track running max **and** min (negatives flip them) |
| State-machine DP | Best Time to Buy and Sell Stock with Cooldown | Medium | Three states: held, sold today, resting |

## Intervals and bit manipulation

| Pattern | Problem | Difficulty | Key idea |
|---|---|---|---|
| Sort by start | Merge Intervals | Medium | Extend or start new merged interval |
| Linear scan (pre-sorted) | Insert Interval | Medium | Before / overlapping / after, three phases |
| Sort by end | Non-overlapping Intervals | Medium | Greedily keep the earliest-ending interval |
| Sweep line | Meeting Rooms II | Medium | `+1`/`-1` events, track running max |
| Sort by end | Minimum Number of Arrows to Burst Balloons | Medium | Shoot at each balloon's end, skip overlaps |
| XOR cancellation | Single Number | Easy | XOR all elements; pairs cancel |
| Bit counting DP | Counting Bits | Easy | `dp[i] = dp[i >> 1] + (i & 1)` |
| Sum trick | Missing Number | Easy | `expectedSum - actualSum`, or XOR all indices and values |
| Bit reversal | Reverse Bits | Easy | Shift result left, OR in each bit from the input |
| Bitwise addition | Sum of Two Integers | Medium | XOR for sum without carry, AND+shift for carry, loop until no carry |

## Design problems

| Pattern | Problem | Difficulty | Key idea |
|---|---|---|---|
| Map + doubly linked list | LRU Cache | Medium | O(1) get/put, move-to-front on access |
| Hash map + heap/list | Design Twitter | Medium | Merge k sorted feeds (heap of most recent tweet per followee) |
| Buckets by time | Design Hit Counter | Medium | Circular buffer or queue of timestamps within the window |
| Prefix tree | Design Add and Search Words Data Structure | Medium | Trie with wildcard DFS on `.` |
| Two heaps | Find Median from Data Stream | Hard | (also listed under heaps — a strong design/heap crossover question) |
| Multiple hash maps | Time Based Key-Value Store | Medium | Map of key to sorted list of `(timestamp, value)`, binary search |

## Suggested 6-week ordering

| Week | Focus | Patterns |
|---|---|---|
| 1 | Foundations | Arrays/strings, hashing, two pointers |
| 2 | Windows and search | Sliding window, binary search |
| 3 | Linear structures | Stacks, linked lists, design (LRU/LFU) |
| 4 | Trees and heaps | Trees, BSTs, tries, heaps |
| 5 | Graphs and search | Graphs, union-find, backtracking |
| 6 | Optimisation | Greedy, dynamic programming, intervals, bit manipulation |

> [!TIP]
> Interleave, don't block: in week 4, still revisit one array or hashing problem every couple of days. Spaced repetition beats a single deep pass followed by never touching the pattern again.

## If you only have 3 days: the essential 25

| # | Problem | Pattern |
|---|---|---|
| 1 | Two Sum | Hashing |
| 2 | Best Time to Buy and Sell Stock | Greedy scan |
| 3 | Maximum Subarray | Kadane's algorithm |
| 4 | Merge Intervals | Sort by start |
| 5 | Product of Array Except Self | Prefix/suffix product |
| 6 | 3Sum | Two pointers |
| 7 | Longest Substring Without Repeating Characters | Sliding window |
| 8 | Binary Search | Binary search |
| 9 | Search in Rotated Sorted Array | Binary search variant |
| 10 | Valid Parentheses | Stack |
| 11 | Reverse Linked List | Linked list pointers |
| 12 | Linked List Cycle | Fast/slow pointers |
| 13 | Merge Two Sorted Lists | Linked list merge |
| 14 | Maximum Depth of Binary Tree | Tree recursion |
| 15 | Validate Binary Search Tree | Bounds-passing recursion |
| 16 | Binary Tree Level Order Traversal | BFS |
| 17 | Kth Largest Element in an Array | Heap / quickselect |
| 18 | Number of Islands | Grid BFS/DFS |
| 19 | Course Schedule | Topological sort |
| 20 | Subsets | Backtracking |
| 21 | Climbing Stairs | 1-D DP |
| 22 | Coin Change | Unbounded knapsack DP |
| 23 | Longest Common Subsequence | 2-D DP |
| 24 | LRU Cache | Design |
| 25 | Single Number | XOR |

> [!WARNING]
> This 25-problem list is a triage list for a genuine time crunch, not a substitute for the full plan. It covers most patterns at a shallow depth — expect to be exposed on a harder variant of any pattern you only touched once here.

## Cheat sheet

- Study **by pattern**, not by difficulty label or random order.
- Two to three problems per pattern is usually enough to internalise the technique; more than five without variety is diminishing returns.
- Re-derive the recurrence/technique from scratch a few days later — don't just re-read your old solution.
- The 6-week order goes foundations → windows/search → linear structures → trees/heaps → graphs → optimisation, because later patterns lean on earlier ones (DP on trees needs tree recursion; graph DP needs both).
- If time is short, the 25-problem list trades breadth for a pattern touchpoint on everything likely to appear.
- Track *time to solve*, not just *correct vs incorrect* — speed under pressure is what the interview measures.
- Revisit "solved" problems after a week; if it takes noticeably longer the second time, the pattern hasn't stuck yet.

## Common mistakes

| Mistake | Fix |
|---|---|
| Solving 200 problems in random order with no pattern grouping | Group by pattern; depth per pattern matters more than raw count |
| Re-reading a memorised solution instead of re-solving | Cover the old solution and re-derive it from the problem statement |
| Never timing yourself | Simulate interview pressure — a solved-but-slow problem still needs more reps |
| Skipping "easy" problems in a pattern | Easy problems establish the pattern cleanly before medium/hard adds complexity |
| Treating the 3-day list as sufficient prep | It's triage for time pressure, not a replacement for the 6-week plan |
| Ignoring design problems until the last minute | LRU/LFU-style questions recur often and reward early, unhurried practice |

## Summary

A problem list is only useful if it drives pattern recognition, not rote memorisation of 120 individual solutions. Work through the list grouped by technique, spend just enough repetitions per pattern to solve a new instance of it confidently and within time, and follow the 6-week order so later, harder patterns build on earlier foundations. When time is short, the 25-problem list touches every major pattern at least once — treat it as triage, not a substitute for the full plan.

## Top Interview Questions

### Q1. How would you prioritize which problems to solve if you only have two weeks to prepare?

Prioritize breadth across patterns over depth in any single one, since interviewers sample from many categories and a candidate strong in five patterns but blind to a sixth is riskier than one competent across all of them. Concretely: spend the first week doing 2–3 problems from each of the highest-frequency patterns (arrays/hashing, two pointers, sliding window, binary search, trees, graphs, DP), then use the second week to shore up whichever patterns felt slowest or least natural, plus a handful of design problems (LRU cache-style) since those are common and easy to under-prepare for. Track which patterns took longer than your target time and weight the remaining days toward those.

### Q2. How do you know when you've drilled a pattern enough to move on, versus needing more repetitions?

Two per pattern, i.e. a fresh problem in that pattern, without referencing your previous solution, and check whether you can identify the pattern within about a minute and produce working code within the typical time budget for its difficulty. If you can do that comfortably and explain the recurrence or technique out loud without hesitating, you've internalised it well enough to move on; if you're still reconstructing the approach step by step or making the same mistake (like forgetting the backward iteration in 0/1 knapsack) twice, that's a signal to do one or two more before moving forward. Volume without this check just produces familiarity with specific problems, not transferable pattern recognition.

### Q3. What's the risk of solving many problems without ever timing yourself?

Correctness without speed doesn't transfer to interview performance, because a real coding round has a hard time limit and rewards fluency, not just eventual correctness. Practicing untimed can also mask a false sense of readiness — a problem that takes 40 minutes untimed, with pauses to think, feels "solved" but would fail a 25-minute interview slot. The fix is to simulate the actual constraint: set a timer matching the problem's expected difficulty (roughly 15–20 minutes for medium, 25–30 for hard) and treat going over as a signal to revisit that pattern, not just move on because you eventually got the right answer.

### Q4. A candidate says they've solved over 200 problems on a practice site but keeps failing interviews — what would you ask to diagnose the issue?

First, ask whether they solved those problems by pattern or in random order, and whether they can name, on the spot, what pattern a new problem belongs to within a minute — often high-volume solvers have memorized surface-level solutions to specific problems without generalizing the underlying technique, so a slightly rephrased or combined version of a "solved" problem still stumps them. Second, ask whether they practice narrating their approach out loud, since interview failure is frequently a communication gap, not a knowledge gap — a candidate who can code correctly in silence but never states complexity, assumptions, or trade-offs will underperform regardless of problem count. Third, ask about their handling of ambiguity and hints, since interviewers often weight collaboration and adaptability as heavily as raw correctness.

### Q5. Why does the suggested study order start with arrays/hashing and end with dynamic programming and graphs, rather than a random order?

Later patterns frequently build on earlier ones: dynamic programming on trees requires comfort with tree recursion first; graph algorithms often reuse BFS/DFS mechanics introduced via simpler grid and tree traversal problems; backtracking's include/exclude branching is easier to grasp once you've internalized recursive tree traversal. Starting with arrays, hashing, and two pointers establishes the most foundational, broadly-reused mental models (like the two-pointer technique, which reappears inside sliding window, merge intervals, and even some DP space optimizations) before layering more complex structures on top, so time isn't wasted re-explaining foundational recursion or complexity concepts every time a new pattern needs them.

### Q6. If you only have 3 days before an interview, how would you decide which 25 problems to solve, and what are you explicitly sacrificing?

Choose problems that each represent a distinct, high-frequency pattern rather than multiple problems from the same pattern, prioritizing patterns most likely to appear (hashing, two pointers, sliding window, binary search, trees, graphs, backtracking, and core DP) over rarer or highly specialized ones (segment trees, advanced string algorithms like KMP, or niche math). You're explicitly sacrificing depth — solving one problem per pattern gives exposure but not mastery, so a harder variant of any pattern touched only once is a real risk; the trade-off is deliberate: broad, shallow coverage reduces the chance of a total blind spot, at the cost of speed and confidence on any individual pattern.

### Q7. How should the problem list or prep focus change depending on whether the round is a general coding round versus a system-design-adjacent round with a coding component?

For a general coding round, prioritize breadth across algorithmic patterns — the interviewer is testing raw problem-solving and complexity reasoning across varied topics. For a round with a system-design-adjacent, "design a class/API" flavor (like LRU Cache, a rate limiter, or a parking lot), prioritize the design-problems category specifically and practice narrating trade-offs between data structures (why a doubly linked list plus hash map gives O(1) for LRU, rather than just producing working code), since these rounds weight API design clarity and extensibility discussions more heavily than raw algorithmic cleverness. Recognizing which flavor of round you're in changes which third of this list to over-index on.

### Q8. What's the value of revisiting a "solved" problem again a week or two later, rather than treating it as permanently done?

Spaced repetition surfaces whether the underlying pattern was actually internalized or just temporarily held in short-term memory — a problem re-solved quickly and confidently a week later confirms the pattern transferred, while one that takes noticeably longer or requires re-deriving the recurrence from scratch reveals it hadn't stuck the first time. This also catches superficial memorization: if you can only reproduce the exact solution you wrote before (down to variable names) but struggle with a lightly modified version of the same problem, that's a sign you memorized an answer rather than learned a technique, which is a critical distinction given interviewers rarely ask the exact problem you've seen before.

### Q9. How would you use a curated pattern-organized list like this one during a mock interview practice session, as opposed to just solo problem-solving?

Deliberately pick a problem from the list *without* telling your mock partner which pattern it's from, and practice the full round structure end-to-end — clarifying questions, brute force narration, optimisation, coding, testing — rather than just producing a correct final answer silently. Ask your mock partner to interject with a hint partway through on purpose, so you get practice gracefully incorporating hints rather than only ever solving problems independently. This transforms the list from a pure knowledge-acquisition tool into a rehearsal tool for the actual behaviors — communication, handling ambiguity, time management — that get scored in a real interview.

### Q10. Why is it a mistake to treat "easy" difficulty problems as not worth your remaining prep time?

Easy problems typically introduce a pattern in its purest, least-obscured form — Two Sum for hash complements, Climbing Stairs for basic 1-D DP — which makes them the fastest way to solidify the *core* technique before medium and hard problems layer on additional complexity (edge cases, combined patterns, tighter constraints) on top of it. Skipping them risks learning a pattern only in its most complicated presentation, which makes it harder to recognize the same pattern later when it appears in a simpler, more disguised form. They're also useful as a fast, low-stress warm-up at the start of a practice session or even before a real interview, to get into a problem-solving rhythm without spending your best mental energy on something hard right away.

### Q11. How do you balance covering all 19 categories in this list against the reality that some patterns (like DP or graphs) are inherently larger and need more time?

Weight your time allocation by both **frequency** (how often the pattern shows up across companies and rounds) and **internal size** (how many genuinely distinct sub-techniques the pattern contains) rather than giving every category equal time — dynamic programming, for instance, contains several largely independent sub-patterns (knapsack, LIS/LCS, interval DP, state-machine DP, bitmask DP) that each need their own exposure, whereas a narrower pattern like union-find has a small, consistent template that transfers quickly across problems. A practical heuristic: spend roughly proportional time to the number of distinct sub-patterns in the category, and treat categories with a single reusable template (union-find, tries) as quicker to reach competence in than sprawling ones (DP, graphs).

### Q12. What's a common failure mode when candidates use a problem list like this, and how would you coach them to avoid it?

The most common failure mode is conflating "I've seen this problem" with "I understand this pattern" — candidates recognize a problem's name or opening description and recall the shape of a memorized solution, but freeze the moment the problem is altered slightly (different constraints, an added twist, or a combination of two patterns in one problem). The coaching fix is to force active recall under altered conditions: after initially solving a problem, come back later and solve a deliberately modified version (different edge case constraints, or "now do it with O(1) space") without looking at the original solution, which tests whether the *technique* was learned rather than the *specific answer* memorized.
