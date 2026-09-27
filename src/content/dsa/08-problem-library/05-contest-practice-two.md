---
title: Contest Practice Two
description: A second set of contest write ups including one problem submitted as a brute force under time pressure and the optimal fix found afterward
difficulty: Advanced
tags: [contest, problem-solving, practice]
---

Not every contest problem gets solved cleanly inside the time limit — sometimes the honest write-up is "here's the working but too-slow solution I submitted, and here's what I should have done." This page keeps that honesty: four problems, the approach taken during the round, the solution as submitted, and a lesson for each, including one where the lesson is "the constraints needed a smarter data structure than the one I reached for."

```mermaid
flowchart LR
    S0["First occurrence: record index"] --> S1["Second occurrence: record spacing start"]
    S1 --> S2["Third occurrence: spacing confirmed"]
    S2 --> C{"Next occurrence continues spacing?"}
    C -- "Yes" --> S2
    C -- "No" --> P["Poison the state: can never validate again"]
```

> [!KEY]
> "All occurrences equally spaced" for an unbounded count reduces to a fixed-size sliding window of the *last three* occurrence indices — three consecutive terms of a sequence are equally spaced if and only if every consecutive triple is, so you never need to remember more than three positions per value.

| Problem | Difficulty | Technique | Complexity |
|---|---|---|---|
| Count Values With Equally Spaced Occurrences I | Easy | Track the first three occurrence indices per value | `O(n)` |
| Count Values With Equally Spaced Occurrences II | Medium | Slide a 3-index window per value; poison it on the first violation | `O(n)` |
| Minimum Days to Score Exactly N Points | Medium | Precompute streak totals, combine two of them with a skip-day join | `O(n * sqrt(n))` |
| Count Subarrays with Distant Sums | Hard | Submitted brute force; Fenwick tree over compressed prefix sums is the optimal fix | `O(n²)` submitted, `O(n log n)` optimal |

## Count Values With Equally Spaced Occurrences I

**Problem.** An integer `x` in `nums` is special if it occurs exactly three times, at indices `i1 < i2 < i3`, with `i2 - i1 == i3 - i2`. Count how many distinct values in `nums` are special.

**Approach.** One pass with a hash map keyed by value, storing how many times it's been seen and its first, second and third occurrence index. A value with a fourth occurrence can never be special under this definition (it needs *exactly* three), so once a count passes three it's simply excluded at the final check — there's no need for a separate "too many" branch.

```java
class Solution {
    public int countSpecialIntegers(int[] nums) {
        // value -> {count, first, second, third}
        Map<Integer, int[]> seen = new HashMap<>();

        for (int i = 0; i < nums.length; i++) {
            int x = nums[i];
            int[] s = seen.get(x);
            if (s != null) {
                if (s[0] == 1) seen.put(x, new int[]{2, s[1], i, s[3]});
                else if (s[0] == 2) seen.put(x, new int[]{3, s[1], s[2], i});
                else seen.put(x, new int[]{s[0] + 1, s[1], s[2], s[3]}); // 4th+ occurrence, fails the final check anyway
            } else {
                seen.put(x, new int[]{1, i, -1, -1});
            }
        }

        int special = 0;
        for (int[] s : seen.values())
            if (s[0] == 3 && s[3] - s[2] == s[2] - s[1])
                special++;

        return special;
    }
}
```

**What I learned.** Don't add a branch for a case the final check already rejects. A value seen four or more times will never have `count == 3`, so it fails the closing condition automatically — adding an explicit "more than three, mark invalid" branch here would be dead code.

## Count Values With Equally Spaced Occurrences II

**Problem.** Same setup, but now `x` is special if it appears **at least** three times and *every* consecutive gap between its occurrence indices is equal — not just the first three.

**Approach.** Extend the same per-value map, but once three occurrences are recorded, treat them as a sliding window: on each new occurrence, check whether it continues the spacing already established by the current window (`third - second == second - first` and the new gap matches too). If it does, slide the window forward by one (drop the oldest of the three, add the new one). If it doesn't, the value can never be special again — set it to a permanent "poisoned" state that fails the final check no matter what happens afterward, rather than trying to restart the window from scratch.

```java
class Solution {
    public int countSpecialIntegers(int[] nums) {
        // value -> {count, first, second, third}
        Map<Integer, int[]> seen = new HashMap<>();

        for (int i = 0; i < nums.length; i++) {
            int x = nums[i];
            int[] s = seen.get(x);
            if (s != null) {
                if (s[0] == 1) {
                    seen.put(x, new int[]{2, s[1], i, s[3]});
                } else if (s[0] == 2) {
                    seen.put(x, new int[]{3, s[1], s[2], i});
                } else if (s[3] - s[2] == s[2] - s[1] && i - s[3] == s[3] - s[2]) {
                    seen.put(x, new int[]{3, s[2], s[3], i});      // still spaced — slide the window forward
                } else {
                    seen.put(x, new int[]{3, 1, 2, 4});            // poisoned: 4-2 != 2-1, can never pass again
                }
            } else {
                seen.put(x, new int[]{1, i, -1, -1});
            }
        }

        int special = 0;
        for (int[] s : seen.values())
            if (s[0] == 3 && s[3] - s[2] == s[2] - s[1])
                special++;

        return special;
    }
}
```

> [!TIP]
> Poisoning a state so it *permanently* fails the final check is often simpler than adding an explicit "invalid" flag everywhere else in the code. Pick sentinel values (here `(1, 2, 4)`) that structurally violate the check on their own, so every downstream read of that state — however it's reached — automatically resolves to "not special" without any extra branching.

**What I learned.** The insight that makes this an `O(n)` extension of problem I rather than an `O(n)` re-derivation: equally-spaced-forever is a *local* property. If every consecutive triple of occurrences is equally spaced, the whole sequence is an arithmetic progression, and checking that requires remembering only the last three indices at any point — not the full history.

## Minimum Days to Score Exactly N Points

**Problem.** Score starts at 0. Each day you either extend a streak (earning `1, 2, 3, ...` points on the 1st, 2nd, 3rd, ... day of the streak) or skip a day, which resets the streak back to 1 next time you earn. Find the minimum number of days, including skipped ones, to reach a score of exactly `n`.

**Approach.** A single uninterrupted streak of length `L` scores the triangular number `L(L+1)/2` in exactly `L` days — precompute every such reachable total up to `n` and how many days it costs. Any larger target is then some number of streaks glued together by mandatory skip days in between (a skip day costs one extra day and contributes zero points, purely to reset the streak). That's a knapsack-shaped recurrence: `dp[total] = min over reachable streak totals s <= total of dp[s] + dp[total - s] + 1`, where the `+1` accounts for the skip day joining the two pieces.

```java
class Solution {
    public int minDays(int n) {
        long[] dp = new long[n + 1];
        Arrays.fill(dp, Long.MAX_VALUE);
        dp[0] = 0;

        List<Integer> streakSums = new ArrayList<>();
        int sum = 0, streakLen = 1;
        while (sum <= n) {
            sum += streakLen;
            if (sum <= n) {
                streakSums.add(sum);
                dp[sum] = streakLen;              // reachable directly with one uninterrupted streak
            }
            streakLen++;
        }

        for (int total = 2; total <= n; total++) {
            for (int streak : streakSums) {
                if (streak > total) break;
                long candidate = dp[streak] + dp[total - streak] + 1;   // +1 for the joining skip day
                if (candidate < dp[total])
                    dp[total] = candidate;
            }
        }

        return (int) dp[n];
    }
}
```

**What I learned.** Precomputing the "single-piece" base cases first (here, triangular numbers) and then letting a generic combination recurrence build every composite total from them is the same shape as coin-change DP — the streak totals are just a different, quadratically-spaced "coin" set instead of the problem's literal coin denominations.

## Count Subarrays with Distant Sums

**Problem.** Given `nums`, `goal` and `k`, a subarray is "distant" if the absolute difference between its sum and `goal` is at least `k`. Count the distant subarrays.

**Approach taken in the round.** With the clock running, the safest move was the one guaranteed to be correct: compute prefix sums, then check every `(i, j)` pair directly against the condition. This is `O(n²)`, which is too slow for the stated constraint of `nums.length` up to `10^5` — it was submitted anyway to lock in partial credit on the smaller test cases, which is why this one is marked "attempted" rather than "solved."

```java
class Solution {
    public long distantSubarrays(int[] nums, int goal, int k) {
        int n = nums.length;
        long[] prefix = new long[n];
        for (int i = 0; i < n; i++)
            prefix[i] = i == 0 ? nums[i] : prefix[i - 1] + nums[i];

        long count = 0;
        for (int i = 0; i < n; i++) {
            for (int j = i; j < n; j++) {
                long sum = i == 0 ? prefix[j] : prefix[j] - prefix[i - 1];
                if (Math.abs(sum - goal) >= k)
                    count++;
            }
        }
        return count;
    }
}
```

> [!WARNING]
> An `O(n²)` solution against `n` up to `10^5` is roughly `10^10` operations — this does not finish in time on the full constraints. Submitting it anyway for partial credit on the smaller hidden tests is a reasonable contest tactic when the clock is nearly out, but it should never be mistaken for a solved problem.

**The optimal fix.** Rephrase "distant" by its complement: total subarrays minus the ones that are *not* distant, where not-distant means `goal - k < sum < goal + k`. Writing `sum = prefix[r] - prefix[l]`, that inequality becomes a range condition on `prefix[l]` relative to `prefix[r]`: `prefix[r] - goal - k < prefix[l] < prefix[r] - goal + k`. Scanning `r` left to right while maintaining a Fenwick tree of every `prefix[l]` already seen (coordinate-compressed, since prefix sums aren't bounded to a small range) turns each query into an `O(log n)` range-count instead of an `O(n)` inner loop.

```java
class Solution {
    public long distantSubarrays(int[] nums, int goal, int k) {
        int n = nums.length;
        long[] prefix = new long[n + 1];
        for (int i = 0; i < n; i++) prefix[i + 1] = prefix[i] + nums[i];

        long total = (long) (n + 1) * n / 2;   // number of (l < r) prefix-index pairs = number of subarrays

        TreeSet<Long> universe = new TreeSet<>();
        for (long p : prefix) {
            universe.add(p);
            universe.add(p - goal - k);
            universe.add(p - goal + k);
        }
        Map<Long, Integer> rank = new HashMap<>();
        int idx = 1;
        for (long v : universe) rank.put(v, idx++);

        int[] bit = new int[universe.size() + 2];

        long notDistant = 0;
        for (int r = 0; r <= n; r++) {
            if (r > 0) {
                long lo = prefix[r] - goal - k;
                long hi = prefix[r] - goal + k;
                int hiIdx = rank.get(hi) - 1;   // count of already-seen values strictly less than hi
                int loIdx = rank.get(lo);       // count of already-seen values <= lo
                if (hiIdx >= loIdx)
                    notDistant += query(bit, hiIdx) - query(bit, loIdx);
            }
            update(bit, rank.get(prefix[r]));
        }

        return total - notDistant;
    }

    private void update(int[] bit, int i) {
        for (; i < bit.length; i += i & -i) bit[i]++;
    }

    private int query(int[] bit, int i) {
        int s = 0;
        for (; i > 0; i -= i & -i) s += bit[i];
        return s;
    }
}
```

**What I learned.** This is the same shape as *Count of Smaller Numbers After Self* — "count prior values within a range relative to the current one" is always a coordinate-compressed Fenwick tree once the naive nested loop is too slow, whether the range is "smaller than," "within k of," or, as here, "within an offset window derived from `goal` and `k`." Recognizing the family under time pressure (rather than reaching for a brute force by default) is the difference between "solved" and "attempted" on a problem like this.

## Cheat sheet

- "Exactly N occurrences, equally spaced" needs only the first (or last) `N` occurrence indices per value — no full history required.
- "All occurrences equally spaced, unbounded count" reduces to a sliding 3-index window per value: check locally, and poison permanently on the first violation instead of trying to restart.
- Streak/knapsack-shaped day-counting problems: precompute the "single uninterrupted piece" costs first, then combine pairs of them with a fixed joining cost.
- "Count subarrays/pairs within a range of each other" is a coordinate-compressed Fenwick tree (or merge-sort counting) once brute force is too slow — the same family as counting smaller elements after each index.
- If you can't find the `O(n log n)` fix in time, submit the correct brute force anyway for partial credit rather than nothing.

## Common mistakes

| Mistake | Fix |
|---|---|
| Adding an explicit branch for "more than N occurrences" when the final check already excludes it | Only add a branch if the closing condition can't reject the case on its own |
| Restarting a spacing check from scratch after a violation | Poison the state permanently instead — a broken arithmetic progression never re-validates |
| Assuming "all occurrences equally spaced" needs the full occurrence history | It's a local property; a fixed-size window of the last few occurrences is sufficient |
| Treating a streak/day DP as a simple 1D table indexed only by day count | Precompute the reachable "single piece" totals first, then combine pairs with the joining cost |
| Submitting nothing because the optimal `O(n log n)` approach wasn't found in time | A correct `O(n²)` brute force still earns partial credit on smaller hidden tests |
| Using a Fenwick tree directly on raw prefix-sum values without compression | Coordinate-compress first — prefix sums are not bounded to a small dense range |

## Summary

The throughline across this set is that "equally spaced" and "within a range of" are both local, checkable properties once you find the right small state to carry forward — the last three occurrence indices for spacing, a coordinate-compressed Fenwick tree for range-membership counting. The honest inclusion here is the brute-force submission on the hardest problem: it's a legitimate contest tactic to lock in partial credit with a correct-but-slow solution when time runs out, but it's worth coming back afterward to find the fix, both to actually learn the pattern and to recognize it faster next time it appears wearing a different problem's clothes.

## Top Interview Questions

### Q1. When a problem defines "special" as needing exactly N occurrences of something, how much state do you actually need to track per candidate?

Only the first N occurrence positions (or indices, or whatever the relevant marker is), plus a count. Once the count exceeds N, the candidate is disqualified by definition, so there's no need to keep recording further occurrences or to add a special "too many" branch — whatever final check enforces "count must equal exactly N" already excludes it. This is a common place candidates over-engineer: the temptation is to track every occurrence in a list, but a fixed small number of variables (here, three index slots and a counter) is both sufficient and avoids unnecessary memory growth per key.

### Q2. How do you extend an "exactly three, equally spaced" check into "any number, all equally spaced," without redoing the whole scan differently?

Recognize that an arithmetic progression is a *local* property — a sequence is fully arithmetic if and only if every consecutive triple within it is arithmetic. That means you never need the full occurrence history; you only need a sliding window of the last three indices seen so far. On each new occurrence, check whether it continues the spacing already established by the current window; if it does, slide the window forward by dropping the oldest index and adding the new one. If it doesn't, the candidate can never become valid again for any larger count, so you can permanently mark it invalid rather than trying to find some other valid sub-sequence starting later.

### Q3. What's the benefit of "poisoning" a state to permanently fail a check, instead of tracking a separate boolean "is this still valid" flag?

It removes the need to check and propagate that flag through every subsequent code path. If you instead choose sentinel values for the tracked state that structurally fail the same final check the valid case uses — for example, three index placeholders whose gaps are provably unequal — then every future read of that state, however it's reached, automatically resolves to "invalid" using the exact same final condition you'd check anyway. This is less code and less places to introduce a bug than adding an explicit flag that has to be checked (and correctly short-circuited) everywhere the state is used afterward.

### Q4. In the "minimum days to reach a score" problem, why does the DP recurrence only need to consider combining exactly two reachable totals, rather than three or more streaks at once?

Because combining two reachable totals is enough to build up any longer chain by induction: if `dp[i - streak]` already represents the optimal way to reach that smaller total — which may itself already be a combination of several streaks and skip days — then `dp[streak] + dp[i - streak] + 1` implicitly represents peeling one streak off the front (or back) of an arbitrarily long chain and recursively relying on the already-optimal solution for the rest. Because the DP fills in totals in increasing order, `dp[i - streak]` is guaranteed to already hold the true optimum by the time `dp[i]` is computed, so a pairwise combination step is sufficient to eventually express any number of chained streaks.

### Q5. Why is coordinate compression a required step before using a Fenwick tree on prefix sums, when it's not needed for something like array indices?

A Fenwick tree is indexed by small, dense, non-negative integers, because its internal traversal (`i += i & -i` and `i -= i & -i`) relies on the index range being bounded and contiguous enough to allocate an array of that size. Prefix sums of an array with values up to `10^9` in magnitude, potentially negative, have no such bound — you can't allocate an array sized to the raw value range. Coordinate compression solves this by mapping the actual set of values that will ever be queried or inserted onto a small contiguous range of ranks (1 to however many distinct values exist), and the Fenwick tree operates on those ranks instead of the raw values, while a dictionary translates back and forth as needed.

### Q6. How do you rewrite "count subarrays whose sum is at least k away from a goal" into a form a Fenwick tree can answer?

Take the complement: instead of directly counting "distant" subarrays, count "not distant" ones (where the sum is strictly within `k` of the goal) and subtract from the total subarray count. Expressing the subarray sum as a difference of two prefix sums, `prefix[r] - prefix[l]`, turns the "within k" condition into a range constraint purely on `prefix[l]` relative to a value derived from `prefix[r]`, `goal`, and `k`. Scanning `r` from left to right while maintaining a Fenwick tree of every `prefix[l]` already seen turns each per-`r` query into a range-count lookup, which is `O(log n)` instead of the `O(n)` inner loop a brute-force nested scan needs.

### Q7. If you can't find the optimal approach to a hard contest problem before time runs out, what's the right tactical decision?

Submit the best correct solution you have, even if it's a brute force that won't pass every test case, rather than submitting nothing. Most contest scoring systems award partial credit based on how many hidden test cases a submission passes, and a correct `O(n²)` solution will typically still pass the smaller-sized hidden tests even if it times out on the largest ones. The only real risk is treating that partial submission as "solved" afterward instead of coming back to find the actual optimal approach — the score you get in the moment and the understanding you take away from the problem are two different goals, and both matter.

### Q8. What's the connecting idea between "count of smaller numbers after self" and "count subarrays with distant sums," even though the two problems sound unrelated?

Both are instances of the same underlying question: "as I scan through a sequence, how many previously seen values fall into a certain range relative to my current value?" In "count of smaller numbers after self," the range is "strictly less than the current value." In "distant sums," after rewriting via prefix sums, the range becomes "within a derived window relative to the current prefix sum." Both are solved the same way — a coordinate-compressed Fenwick tree (or, alternatively, a merge-sort-based counting pass) that supports inserting a value and querying how many previously inserted values fall in a range, in `O(log n)` per operation.

### Q9. How would you explain, to someone who hasn't seen it before, why `dp[total] = min(dp[streak] + dp[total - streak] + 1)` correctly captures every possible way to build up a score using streaks and skip days?

Think of any valid sequence of streaks and skips that reaches the target total as a sequence of "pieces": streak, skip, streak, skip, streak, and so on. The recurrence considers peeling off exactly one piece (a single uninterrupted streak of some reachable length) from the sequence, paying its cost in days plus one day for the skip that must follow it (unless it's the very last piece, but the recurrence structure handles that because `dp[0] = 0` needs no trailing skip). What remains is a shorter target total, whose optimal cost is exactly `dp[total - streak]` by the inductive hypothesis that everything smaller has already been correctly computed. Trying every possible first-peeled streak length and taking the minimum guarantees you don't miss the actual optimal decomposition.

### Q10. What general lesson from this contest write-up is worth applying to future timed rounds, beyond the specific problems?

Recognize problem *families* rather than memorizing individual solutions — "count prior values within a range of the current one" should trigger the same Fenwick-tree instinct whether the surface story is about array elements, prefix sums, or something else entirely, and "local checkable property extended to an unbounded sequence" should trigger the same fixed-window-with-poisoning instinct regardless of what's being checked. The other lesson is tactical: a correct brute force submitted under time pressure is a legitimate fallback that earns partial credit, but the write-up shouldn't stop there — coming back afterward to find and understand the optimal approach is what actually improves recognition speed for the next contest, rather than just banking the score from this one.
