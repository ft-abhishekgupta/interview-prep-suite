---
title: Intervals and Sweep Line
description: Sorting strategies for merge and insert interval problems, the sweep-line event-counting technique, and the off-by-one traps at inclusive versus exclusive endpoints
difficulty: Core
tags: [intervals, sweep-line, greedy]
---

Interval problems all reduce to one decision: sort by start or sort by end, then sweep once. Interviewers use this family to check whether you can pick the right sort key for the question actually being asked, and whether you handle touching-but-not-overlapping endpoints correctly.

## Sort by start vs sort by end

| Sort key | Used for | Why |
|---|---|---|
| Start time | Merge intervals, insert interval | You need to know, in order, when each interval *begins* to decide if it extends the current merge |
| End time | Max non-overlapping intervals, min arrows to burst balloons, activity selection | Greedily picking the interval that **frees up time soonest** leaves the most room for what follows |

```mermaid
flowchart TD
    A["Interval problem"] --> B{"Merging overlapping ranges?"}
    B -- "Yes" --> C["Sort by start<br/>sweep, extend or push new"]
    B -- "No, selecting max count<br/>of non-overlapping" --> D["Sort by end<br/>greedily keep earliest finisher"]
    A --> E{"Counting concurrent overlaps?"}
    E -- "Yes" --> F["Sweep line:<br/>+1 at start, -1 at end"]
```

> [!KEY]
> Sorting by **end** time for "maximum non-overlapping subset" is the one greedy choice in this whole topic that needs a proof: picking the interval that ends soonest always leaves at least as much room for future picks as any other choice — the classic exchange argument for interval scheduling.

## Merge intervals

Sort by start. Walk the list, keeping a "current" merged interval; if the next interval's start is `≤` current end, extend the merge; otherwise close it out and start a new one.

```java
// O(n log n) time (sort dominates), O(n) space for the result
public int[][] merge(int[][] intervals) {
    Arrays.sort(intervals, (a, b) -> Integer.compare(a[0], b[0]));
    List<int[]> result = new ArrayList<>();
    for (int[] iv : intervals) {
        if (result.isEmpty() || result.get(result.size() - 1)[1] < iv[0])
            result.add(iv);                       // no overlap, start new
        else
            result.get(result.size() - 1)[1] = Math.max(result.get(result.size() - 1)[1], iv[1]);  // extend
    }
    return result.toArray(new int[0][]);
}
```

## Insert interval

A specialised merge where the array is already sorted, so a single linear pass suffices instead of a full sort: append intervals strictly before the new one, merge everything overlapping it, then append the rest.

```java
// O(n) time, O(n) space for the result — array is already sorted
public int[][] insert(int[][] intervals, int[] newInterval) {
    List<int[]> result = new ArrayList<>();
    int i = 0, n = intervals.length;
    while (i < n && intervals[i][1] < newInterval[0])
        result.add(intervals[i++]);                // ends before new starts
    while (i < n && intervals[i][0] <= newInterval[1]) {
        newInterval[0] = Math.min(newInterval[0], intervals[i][0]);
        newInterval[1] = Math.max(newInterval[1], intervals[i][1]);
        i++;                                        // overlaps, absorb it
    }
    result.add(newInterval);
    while (i < n) result.add(intervals[i++]);       // starts after new ends
    return result.toArray(new int[0][]);
}
```

## Non-overlapping intervals: sort by end

To find the minimum number of intervals to *remove* so the rest don't overlap, sort by end time and greedily keep any interval whose start is `≥` the last kept interval's end.

```java
// O(n log n) time, O(1) extra space (beyond the sort)
public int eraseOverlapIntervals(int[][] intervals) {
    Arrays.sort(intervals, (a, b) -> Integer.compare(a[1], b[1]));
    int keptEnd = Integer.MIN_VALUE, removed = 0;
    for (int[] iv : intervals) {
        if (iv[0] >= keptEnd) keptEnd = iv[1];      // no overlap, keep it
        else removed++;                              // overlaps, drop it
    }
    return removed;
}
```

## Meeting rooms I and II

**Meeting rooms I** — can one person attend all meetings? Sort by start, check every adjacent pair for overlap.

**Meeting rooms II** — how many rooms are needed at peak? This is the canonical sweep-line/event-counting problem: treat every start as `+1` and every end as `-1`, sort all events by time, and track the running total's maximum.

```java
// O(n log n) time, O(n) space
public int minMeetingRooms(int[][] intervals) {
    int[] starts = Arrays.stream(intervals).mapToInt(iv -> iv[0]).sorted().toArray();
    int[] ends = Arrays.stream(intervals).mapToInt(iv -> iv[1]).sorted().toArray();
    int rooms = 0, maxRooms = 0, s = 0, e = 0;
    while (s < starts.length) {
        if (starts[s] < ends[e]) { rooms++; s++; }   // a meeting starts before another ends
        else { rooms--; e++; }                        // a meeting ends first, free a room
        maxRooms = Math.max(maxRooms, rooms);
    }
    return maxRooms;
}
```

> [!TIP]
> The two-pointer version above and a heap-of-end-times version are both `O(n log n)` and both valid to mention — the heap version pushes each meeting's end time and pops whenever the earliest end is `≤` the new meeting's start, with the final heap size being the answer.

## Sweep line with a heap or a difference map

Sweep line generalises "meeting rooms II" to any "how many things are active at time t" question: bookings, load on a server, overlapping ranges on a timeline.

| Technique | How | Best for |
|---|---|---|
| Sort events, `+1`/`-1` running count | Sort `(time, delta)` pairs, sweep once | Counting peak concurrency |
| Min-heap of active end times | Push on start, pop while heap top `≤` current start | When you need the *actual* set of overlapping intervals, not just the count |
| Difference array | `diff[start]++`, `diff[end]--`, then prefix sum | When times are small integers (bounded range), avoids sorting entirely |

```java
// Difference-array sweep for small integer time ranges — O(n + maxTime)
int[] diff = new int[maxTime + 2];
for (int[] booking : bookings) {       // booking = {start, end}
    diff[booking[0]]++;
    diff[booking[1]]--;                 // end is exclusive here
}
int running = 0, peak = 0;
for (int t = 0; t <= maxTime; t++) {
    running += diff[t];
    peak = Math.max(peak, running);
}
```

> [!WARNING]
> A difference array needs the interval's **exclusive** end to decrement at the right point. If your intervals are inclusive (`[start, end]` both included), decrement at `end + 1`, not `end` — otherwise you undercount the last unit of overlap.

## My calendar booking (online sweep)

"My calendar" style problems ask you to reject a new booking if it overlaps any existing one, processed one at a time rather than in a batch. A sorted structure (`TreeMap` keyed by start time) lets you binary-search neighbours in `O(log n)` per booking instead of scanning all existing bookings.

```java
// O(log n) per booking using a sorted map of start -> end
private TreeMap<Integer, Integer> bookings = new TreeMap<>();
public boolean book(int start, int end) {
    // find the booking immediately at/before "start" and the one at/after it
    Map.Entry<Integer, Integer> before = bookings.floorEntry(start);
    Map.Entry<Integer, Integer> after = bookings.ceilingEntry(start);
    if (before != null && before.getValue() > start) return false;
    if (after != null && after.getKey() < end) return false;
    bookings.put(start, end);
    return true;
}
```

## Complexity and the inclusive/exclusive endpoint trap

| Problem | Time | Space |
|---|---|---|
| Merge intervals | `O(n log n)` | `O(n)` |
| Insert interval (pre-sorted input) | `O(n)` | `O(n)` |
| Non-overlapping / max arrows | `O(n log n)` | `O(1)` extra |
| Meeting rooms II | `O(n log n)` | `O(n)` |
| Difference-array sweep | `O(n + range)` | `O(range)` |

> [!DANGER]
> The most common bug in this entire topic: using `<` when you meant `<=` (or vice versa) at the boundary where one interval ends and the next begins. "Do `[1, 5]` and `[5, 10]` overlap?" has no universal answer — it depends on whether the problem's endpoints are inclusive or exclusive, and you must ask or state your assumption before coding.

## Cheat sheet

- **Merge / insert → sort by start.** **Max non-overlapping / min removals → sort by end.**
- Sweep line = turn every interval into two events (`+1` at start, `-1` at end), sort, and track a running total.
- A min-heap of end times generalises "count concurrent" to "which intervals are concurrent".
- A difference array avoids sorting entirely when times are small bounded integers.
- **State your inclusive/exclusive assumption out loud** before writing the overlap check.
- "Online" booking-style problems want `O(log n)` per operation — reach for a sorted map, not a list scan.
- Meeting rooms II's two-pointer version and heap version are both `O(n log n)`; know both.
- The greedy "sort by end, keep earliest finisher" is provably optimal via an exchange argument — cite it if asked why greedy works here.

## Common mistakes

| Mistake | Fix |
|---|---|
| Sorting by start when the problem actually needs "max non-overlapping count" | That needs sort by end — sorting by start gives a valid but suboptimal greedy |
| Using `<` instead of `<=` (or the reverse) at a shared endpoint | Explicitly decide and state inclusive vs exclusive before coding |
| Decrementing a difference array at `end` instead of `end + 1` for inclusive intervals | Match the decrement point to whether `end` itself is occupied |
| Forgetting insert-interval's input is already sorted | Don't re-sort; use the three-phase linear scan instead |
| Scanning all existing bookings per new booking in an "online" calendar problem | Use a sorted structure for `O(log n)` neighbour lookups |
| Assuming merge intervals output is already sorted by end too | It's sorted by start; don't rely on end-order without re-checking |

## Summary

Interval problems are solved by picking the right sort key — start for merging, end for maximum non-overlapping selection — then sweeping once. The sweep-line technique generalises this into an event-counting tool: turn each interval into a `+1`/`-1` pair, sort, and track the running total, or use a heap when you need to know which intervals are concurrent rather than just how many. The single highest-value habit in this topic is stating your inclusive/exclusive endpoint assumption before writing the overlap comparison, since that single `<` vs `<=` choice is where most bugs live.

## Top Interview Questions

### Q1. Why do some interval problems sort by start time and others by end time?

Sorting by start time answers "in what order do intervals begin, so I can decide whether the next one extends my current merge" — that's what merge intervals and insert interval need. Sorting by end time answers a different question: "which interval, if I must pick a maximal non-overlapping subset, frees up the timeline soonest" — greedily picking the earliest-ending interval at each step is provably optimal for maximizing count, because it leaves at least as much room for subsequent picks as any other valid choice would (an exchange argument: swapping any other choice for the earliest-ending one never makes things worse). Using the wrong sort key for the wrong problem produces a valid-looking but suboptimal or incorrect answer.

### Q2. Prove, informally, why sorting by end time and greedily picking the earliest-ending non-overlapping interval maximizes the count.

Suppose an optimal solution doesn't start with the earliest-ending interval `e`. Take whatever interval the optimal solution picks first, call it `x`; since `e` ends no later than `x`, replacing `x` with `e` in the optimal solution cannot cause any conflict with the intervals that come after `x` (because `e`'s end is `≤ x`'s end, so anything compatible with `x` is still compatible with `e`). This swap produces another valid solution of the same size, so an optimal solution containing `e` first always exists. Repeating this argument inductively for the remaining intervals proves the greedy choice never loses to any alternative.

### Q3. How does the sweep-line technique count the maximum number of overlapping intervals at any point in time?

Convert each interval `[start, end]` into two timestamped events: `+1` at `start` and `-1` at `end` (or `end + 1` if endpoints are inclusive and you want to avoid double counting an instant). Sort all events by time, and when times tie, process ends before starts if touching intervals shouldn't count as overlapping (or starts before ends if they should) — this ordering choice is itself an interview-worthy detail. Sweep through the sorted events, maintaining a running counter that increments on `+1` and decrements on `-1`; the maximum value the counter ever reaches is the answer — this is exactly what "meeting rooms II" computes.

### Q4. What's the difference between the two-pointer and heap-based solutions to meeting rooms II, and are both equally valid?

The two-pointer solution sorts start times and end times **separately** into two arrays, then merges them like a merge-sort merge step: advance the start pointer (incrementing a room counter) whenever the next start is earlier than the next end, otherwise advance the end pointer (decrementing the counter), tracking the maximum counter value seen. The heap-based solution sorts intervals by start time, and for each interval pops end times off a min-heap while the heap's minimum is `≤` the current interval's start (a room freed up), then pushes the current interval's end; the final heap size is the peak room count. Both run in `O(n log n)` and are equally valid — the two-pointer version is marginally simpler to code, the heap version generalizes more naturally if you also need to know *which* meeting occupies which room.

### Q5. Given inclusive integer intervals like [1, 5] and [5, 10], do they overlap, and how does that change your code?

It depends entirely on the problem's definition, and a senior answer states this explicitly rather than assuming: if "5" is a shared instant both intervals include, they overlap and any merge/overlap check should use `<=` at the boundary (e.g., `if (next.start <= current.end) merge`). If intervals represent, say, meeting time slots where an event ending at 5 has fully vacated by the time another starts at 5, they should be treated as non-overlapping, and the check becomes strict `<` (`if (next.start < current.end) merge`). This single boundary decision is the most common source of off-by-one bugs in interval problems, so stating your assumption before writing the comparison operator is worth doing out loud.

### Q6. How would you design an online "calendar booking" API where each booking call must reject overlaps against all previously accepted bookings?

Maintain a sorted structure (a balanced BST-backed map like `TreeMap<Integer,Integer>` keyed by start time, or an order-statistics tree) of accepted bookings. For each new `(start, end)` request, find the booking immediately before it (largest start `≤` the new start) and the one immediately after (smallest start `≥` the new start) via the sorted structure's neighbour queries (`floorEntry`/`ceilingEntry`), which take `O(log n)`. Reject if the "before" booking's end exceeds the new start, or if the "after" booking's start is before the new end; otherwise insert and accept. This avoids the `O(n)` per-call cost of scanning a plain list, which matters if bookings accumulate into the tens of thousands.

### Q7. A colleague suggests using a plain array and linear scan for the calendar booking problem since "n will be small". When would that reasoning be wrong?

It's wrong whenever the system is expected to scale — "small n" assumptions break silently as usage grows, and a linear scan per booking becomes `O(n)` per call, `O(n²)` total for `n` bookings, which degrades badly once bookings reach the thousands (a plausible number for a single popular calendar over a year). The senior response is to ask for the expected scale and growth trajectory rather than accept "small" at face value, and to default to the `O(log n)`-per-operation sorted-structure design unless there's a concrete, stated bound that makes the simpler linear scan provably sufficient — and even then, to note the trade-off explicitly rather than silently under-engineering.

### Q8. How would you extend the sweep-line idea to answer "what is the maximum overlap, and during which exact time range does it occur"?

Instead of only tracking the maximum running count, also track the timestamp at which each new maximum is reached, and the timestamp of the *next* event after that (since the count stays constant until the next event). Concretely: after sorting events by time, whenever updating `running` causes `running > maxSoFar`, record `[currentEventTime, nextEventTime)` as a candidate peak window; if a later peak ties the maximum, you'd report multiple windows or just the first, depending on the problem statement. This is a natural extension interviewers use to check you understand the sweep isn't just counting — it's tracking state that changes exactly at event boundaries.

### Q9. Why is a difference array sometimes preferable to sorting events for a sweep-line problem?

A difference array avoids the `O(n log n)` sort entirely when the time domain is a small, bounded range of integers (say, up to 10⁵ or 10⁶): you increment `diff[start]` and decrement `diff[end]` (or `end + 1` for inclusive endpoints) for each interval in `O(1)` per interval, then take a single prefix sum pass over the array in `O(range)` to get the running count at every time unit. This is `O(n + range)` total instead of `O(n log n)`, which wins when `range` is small relative to `n log n` — but it loses badly if the time domain is huge or continuous (e.g., real-valued timestamps), where sorting events remains the only practical approach.

### Q10. In merge intervals, why is it safe to only compare the new interval against the *last* interval already in the result list, rather than all previous ones?

Because the input is sorted by start time before the sweep begins, and the result list is built incrementally maintaining that same sorted-by-start invariant with no gaps or overlaps left unresolved. Once an earlier interval has been merged and closed out (i.e., it's no longer the last one in the result), no later interval — having a start time `≥` all previously seen starts — can possibly overlap it, because if it did, it would also have overlapped the interval that's currently last (transitively, since intervals are processed in start order and merges extend the "current" interval's end monotonically). This invariant is exactly what makes the single-pass, compare-only-the-last-one approach correct instead of needing an `O(n²)` all-pairs check.

### Q11. What's the time and space complexity of the merge-intervals algorithm, and can it be done without extra space?

Time is `O(n log n)`, dominated by the initial sort; the single sweep afterward is `O(n)`. Space is `O(n)` for the result list, though if the language allows sorting in place and you're permitted to overwrite the input array, you can merge into the front of the same array and return a trimmed view, reducing auxiliary space to `O(1)` beyond the sort's own space (which itself is typically `O(log n)` for the recursion stack of an in-place sort). Whether "output space" counts against you is worth clarifying — most interviewers exclude the returned result from the space complexity discussion, but say so explicitly.

### Q12. How would you find, for each interval, the number of other intervals that overlap it, efficiently?

Build the same sweep-line events (`+1` at start, `-1` at end) and compute the running "active count" at every timestamp via a prefix sum, exactly as in meeting rooms II — but instead of just tracking the maximum, record the active count *at the moment each interval starts* (that count, minus one for itself, is how many others are concurrently overlapping it at that instant, though a fully rigorous "does A overlap B at all" count needs a per-interval check since "active at start" undercounts intervals that started after but still overlap). A more precise approach for exact per-interval overlap counts uses a sorted list of all starts and ends: for interval `i`, binary search how many other intervals have `start_j < end_i` and `end_j > start_i`, which can be computed via two binary searches per interval in `O(n log n)` total.
