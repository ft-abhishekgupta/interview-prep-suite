---
title: Coding Interview Playbook
description: The minute-by-minute structure of a 45-minute coding round, from clarifying questions through brute force, optimisation, dry run and complexity narration
difficulty: Core
tags: [interview-process, communication, problem-solving]
---

The coding round tests more than whether your solution compiles — it tests whether you can be trusted to work through an ambiguous problem methodically, under time pressure, while explaining your thinking. This page is a rehearsable script for that 45 minutes, not another algorithm to learn.

## The shape of a 45-minute round

```mermaid
flowchart LR
    A["0-5 min<br/>Clarify + examples"] --> B["5-10 min<br/>Brute force + complexity"]
    B --> C["10-15 min<br/>Optimise, name the trade-off"]
    C --> D["15-35 min<br/>Write code"]
    D --> E["35-42 min<br/>Dry run + edge cases"]
    E --> F["42-45 min<br/>Complexity + questions"]
```

| Phase | Time budget | Goal |
|---|---|---|
| Clarify | 3–5 min | Pin down input shape, constraints, edge cases, ambiguous wording |
| Brute force | 3–5 min | State a correct, even if slow, approach and its complexity |
| Optimise | 5–8 min | Narrate the bottleneck and the trick that removes it |
| Code | 18–22 min | Write clean, working code, narrating non-obvious lines |
| Test | 5–7 min | Dry run on a small example, then check edge cases |
| Wrap up | 2–3 min | State final complexity, ask your own question if time remains |

> [!KEY]
> The single biggest signal in the round is **narration** — an interviewer who has to guess what you're thinking cannot score you on it. Say the plan before you type it.

## Clarifying questions to always ask

- What are the constraints on input size (`n`)? This tells you the target complexity before you start.
- Can the input be empty, contain duplicates, negative numbers, or be unsorted?
- Is there a canonical tie-breaking rule if multiple valid answers exist?
- Can I modify the input in place, or must it be preserved?
- What's the expected return value on "not found" — `-1`, `null`, throw, empty list?

> [!TIP]
> Ask 2–3 targeted questions, not ten generic ones. *"Can nums contain negatives, and should I treat an empty array as an error or return 0?"* signals you're thinking about edge cases already — a stronger signal than a checklist recited by rote.

## Stating and testing assumptions

If the interviewer doesn't specify something, state your assumption out loud and proceed — do not silently guess. *"I'll assume the array is unsorted since it wasn't stated, and that there's exactly one valid answer, per typical convention for this kind of problem."* This does two things: it protects you if the assumption turns out wrong (the interviewer will correct you immediately rather than let you fail silently), and it demonstrates you noticed the ambiguity at all.

## Brute force, then optimise — the narration

Always state a working brute force before optimising, even if you're confident of the optimal approach immediately. This proves the problem is understood and gives the interviewer a complexity baseline to compare your optimisation against.

| Step | What to say |
|---|---|
| State brute force | "The simplest approach checks every pair — O(n²) time, O(1) space." |
| Name the bottleneck | "The bottleneck is re-scanning for each element to find its complement." |
| Name the trick | "I can trade space for time with a hash set, dropping to O(n)." |
| Confirm before coding | "Does O(n) time, O(n) space sound right to go with, or is memory constrained?" |

> [!TIP]
> This narration structure works for almost every problem: *brute force → identify the repeated/wasted work → name the data structure or technique that removes it → state the new complexity*.

## Writing production-quality code

Even under time pressure, code quality is being scored. The bar is lower than a PR review, but not absent.

| Practice | Example |
|---|---|
| Meaningful names | `leftPointer`/`rightPointer`, not `l`/`r` if space allows; `target`, not `t` |
| Guard clauses over deep nesting | `if (nums == null \|\| nums.length == 0) return new int[0];` at the top |
| No magic numbers | `static final int NOT_FOUND = -1;` instead of a bare `-1` littered through the code |
| Extract a helper for repeated logic | A `swap(arr, i, j)` used three times, not copy-pasted |
| Consistent style | Match brace style and casing conventions of the language you're in |

```java
// Weak: unclear names, magic number, no guard
int f(int[] a, int t) {
    for (int i = 0; i < a.length; i++)
        if (a[i] == t) return i;
    return -1;
}

// Stronger: guard clause, clear names, still concise
int indexOf(int[] nums, int target) {
    if (nums == null || nums.length == 0) return NOT_FOUND;
    for (int i = 0; i < nums.length; i++)
        if (nums[i] == target) return i;
    return NOT_FOUND;
}
static final int NOT_FOUND = -1;
```

## Dry-running with a small example

Before declaring done, trace your code by hand on a small, concrete example — ideally one with 3–5 elements, chosen to exercise a normal case (not an edge case, which comes next). Point at each line, state the variable values, and update them as you would on paper.

> [!WARNING]
> Skipping the dry run is the single most common reason correct-looking code fails silently on an off-by-one — interviewers consistently rate candidates who dry-run unprompted higher than those who only do it when asked.

## Edge case checklist

| Category | Examples |
|---|---|
| Empty / null input | Empty array, empty string, null reference |
| Single element | Array of size 1, single-node linked list |
| Duplicates | All elements identical, target appears multiple times |
| Extremes | Already sorted, reverse sorted, all same value |
| Boundary values | `Integer.MIN_VALUE`/`Integer.MAX_VALUE`, integer overflow on sum |
| Negative numbers | If not explicitly excluded, assume they're possible |

## What to do when stuck

1. **Re-read the problem** — restate it in your own words; miscomprehension is the most common cause of getting stuck.
2. **Simplify** — solve a smaller or restricted version first (e.g. assume no duplicates), then generalise.
3. **Think out loud** — verbalising often surfaces the missing piece; silence gives the interviewer nothing to redirect.
4. **Ask for a hint explicitly** — *"I'm stuck on how to avoid the O(n²) re-scan — is there a data structure angle I'm missing?"* is far better than freezing.

> [!NOTE]
> Asking for a hint is not a failure signal on its own — how you incorporate it is. Silently changing direction without acknowledging the hint reads worse than saying "that's a good point, let me rework this with a hash map."

## How to handle hints gracefully

Acknowledge it, then apply it visibly: *"Right — if I sort first, I can use two pointers instead of nested loops."* Do not pretend you already knew it, and do not get flustered. Interviewers expect to give at least one hint in a well-calibrated problem; how you use it is more informative than whether you needed it.

## Testing your solution

Walk through your edge case checklist explicitly against your own code, out loud, even without being asked: *"Empty array — my guard clause returns early, good. Single element — the loop runs once and falls through to the not-found case, correct."* If you find a bug during this, fix it calmly; catching your own bug is a stronger signal than never having one.

## Complexity narration

Always state time **and** space, and the *why*, unprompted, as soon as the code is done: *"This is O(n log n) time because of the sort, and O(1) extra space since I'm sorting in place and using two pointers."* If asked "can you do better", answer honestly — sometimes the answer is genuinely no, and saying so with a brief justification (a comparison-sort lower bound, or "this must touch every element") is a stronger answer than inventing a fake optimisation.

## Cheat sheet

- **Clarify → brute force → optimise → code → test → complexity.** In that order, every time.
- Ask 2–3 targeted clarifying questions; state assumptions you don't get answers to.
- Always give a brute force first, even a bad one — it proves understanding and sets a baseline.
- Narrate: bottleneck → technique → new complexity, before writing the optimised code.
- Use guard clauses, named constants, and clear variable names — code quality is scored.
- Dry-run on a small example unprompted; then walk the edge case checklist unprompted.
- When stuck: restate the problem, simplify, think aloud, then ask for a hint explicitly.
- State final time and space complexity with a "because" — the reason matters more than the letters.

## Common mistakes

| Mistake | Fix |
|---|---|
| Jumping straight to the optimal solution silently | State the brute force and its complexity first, even briefly |
| Coding in silence | Narrate the plan before typing; silence gives the interviewer nothing to correct |
| Ignoring a hint or pretending you already knew it | Acknowledge it explicitly and visibly apply it |
| Declaring "done" without testing | Dry-run a normal case, then walk the edge case checklist |
| Over-engineering with unnecessary abstraction under time pressure | Favor simple, readable code over premature generalisation |
| Not asking about constraints before choosing an approach | Constraints on `n` tell you the target complexity immediately |

## Summary

A strong coding-round performance is a process, repeated the same way every time: clarify the problem and its constraints, state a brute force with its complexity, narrate the bottleneck and the trick that removes it, write clean code with guard clauses and clear names, dry-run it on a small example, walk an edge case checklist, and close with a complexity statement and its justification. None of this requires knowing more algorithms — it requires making your reasoning visible at every step, which is what the interviewer is actually scoring.

## Top Interview Questions

### Q1. How would you structure your time in a 45-minute coding interview?

Roughly: 3–5 minutes clarifying the problem and constraints, 3–5 minutes stating a brute-force approach and its complexity, 5–8 minutes narrating the optimisation and its trade-off, 18–22 minutes writing the actual code, 5–7 minutes dry-running it against a normal example and then an edge-case checklist, and the last 2–3 minutes stating final complexity and asking your own question if time allows. The exact split flexes with problem difficulty, but the order — clarify, brute force, optimise, code, test, wrap up — should stay fixed, because skipping a phase (especially testing) is what most commonly turns a correct-looking solution into a failed round.

### Q2. What clarifying questions should you almost always ask before writing code?

Ask about the size and shape of the input (which tells you the target complexity), whether edge cases like empty input, duplicates, or negative numbers are possible, whether there's a defined tie-breaking rule if multiple valid answers exist, whether you're allowed to modify the input in place, and what the expected behaviour is on a "not found" case. Two or three well-chosen questions specific to the problem read as stronger signal than a long generic checklist recited from memory — the goal is to show you're already thinking about the problem's actual edge cases, not to perform a ritual.

### Q3. Why is it important to state a brute-force solution before jumping to the optimal one, even if you already see the optimal approach?

It establishes a correctness and complexity baseline the interviewer can measure your optimisation against, and it proves you actually understand the problem rather than pattern-matching a memorised solution to superficially similar wording. It also gives you a fallback: if you get stuck partway through implementing the optimal approach, you have a known-correct (if slower) solution to fall back on and still pass on correctness, even if you lose some points on efficiency. Skipping straight to the optimal solution silently also removes an opportunity to narrate the "why" of the optimisation, which is a significant part of what's being scored.

### Q4. Describe the narration you'd use when moving from a brute-force to an optimised solution.

State the brute force and its complexity explicitly, then identify precisely what's being wasted — for example, "the bottleneck is that for each element, I rescan the rest of the array to find its complement, which is where the O(n²) comes from." Then name the specific technique that removes that waste and the trade-off it introduces — "I can precompute a hash set of seen values, trading O(n) extra space for dropping the time to O(n)." Finally, confirm the new complexity target makes sense given the constraints before writing code, which both double-checks your reasoning and keeps the interviewer engaged as a collaborator rather than a silent grader.

### Q5. What does "production-quality code" mean in the context of a timed coding interview, given you can't write a full production system in 20 minutes?

It means using guard clauses instead of deep nested conditionals, meaningful variable and method names instead of single letters (beyond loop counters), named constants instead of magic numbers, and extracting small helper functions for logic that's repeated more than once — without over-engineering with unnecessary abstraction layers that a 20-minute problem doesn't warrant. The bar isn't the same as a real PR review; it's "would a teammate understand this in 30 seconds, and does it handle the input it's given without surprising behaviour." Concretely, that's things like validating null/empty input at the top of a function and giving a clearly-named constant instead of a bare `-1` for a "not found" sentinel.

### Q6. Walk me through how you'd dry-run a solution you just wrote, and why does this matter even when you're confident it's correct?

Pick a small, concrete example — typically 3 to 5 elements — that exercises the normal, non-edge-case path, then trace through your code line by line, tracking variable values on paper or out loud exactly as the interpreter would, comparing the final output to what you expect. This matters because off-by-one errors, incorrect loop bounds, and subtly wrong conditionals are the most common bugs in interview code, and they are frequently invisible from just reading the code — they only surface when you actually simulate execution. Interviewers consistently rate candidates who dry-run unprompted more favourably, because it demonstrates a testing habit rather than an assumption of correctness.

### Q7. You're 30 minutes in and realize your current approach has a bug you can't immediately fix — what do you do?

State clearly what you've noticed: "I'm seeing this fails when the array has duplicates, because my two-pointer logic assumes distinct values" — naming the specific failure mode rather than vaguely saying "something's wrong." Then reason out loud about the smallest possible fix, considering whether it's a small patch (an extra condition) or whether the underlying approach needs to change. If time is short, explicitly prioritize: "given the time left, I'll patch this specific case rather than redesign, and I'll flag that a more general fix might handle X differently." Staying calm and narrating the debugging process is scored far more favourably than silently panicking or restarting from scratch without explanation.

### Q8. How should you respond when the interviewer gives you a hint?

Acknowledge it explicitly and incorporate it visibly into your next step, rather than silently changing direction or pretending you'd already thought of it — something like "that's a good point, if I sort the array first I can replace the nested loop with two pointers" shows you're actively integrating feedback. Do not treat a hint as a failure; well-calibrated problems are often designed with an expected hint partway through, and how gracefully and quickly you incorporate it is itself a signal of collaboration skills, which matters directly for how you'd behave on a real team receiving code review feedback.

### Q9. What should you say when asked "can you do better than this?" and you genuinely believe your solution is already optimal?

Say so directly, with a justification, rather than inventing a fake optimisation or awkwardly guessing: "I believe this is optimal — the problem requires touching every element at least once to produce a correct answer, so O(n) is a hard lower bound here." If the optimality claim rests on a known result — like a comparison-sort's Ω(n log n) lower bound — cite it. If you're not fully sure, it's fine to say "I don't see an obvious further optimisation, but let me think about whether there's a way to avoid the second pass" and actually think for a moment, rather than freezing or bluffing.

### Q10. How do you decide what to prioritize if you're running low on time and haven't finished coding?

Prioritize a correct, even if unoptimized, solution over an incomplete optimized one — a working brute force that you can explain fully is safer than a half-written optimal approach with bugs, since interviewers generally score correctness and completeness heavily. State this trade-off explicitly: "given the time left, I'll finish the O(n²) version cleanly rather than risk not finishing the O(n) one" — this shows time-management judgement, which is itself part of what's being evaluated, rather than silently rushing and producing broken code in either approach.

### Q11. Why does narrating your thought process matter as much as writing correct code?

Because the interviewer cannot score reasoning they cannot observe — two candidates who arrive at the identical correct solution can be rated very differently if one explained their approach, trade-offs, and complexity along the way, and the other worked in silence and only spoke when asked a direct question. Narration also functions as a safety net: an interviewer who hears you say "I'm assuming duplicates aren't allowed" can correct a wrong assumption before it costs you 15 minutes of misdirected work, whereas a silent wrong assumption discovered at the end is often too late to fully recover from within the time limit.

### Q12. After finishing a solution with time to spare, what would a strong candidate do next?

Proactively re-verify complexity and correctness rather than just stopping: restate the time/space complexity with justification, walk through the edge-case checklist explicitly against the actual code (not just in the abstract), and consider whether there's a meaningfully better approach worth mentioning even if not implementing it ("there's also an O(n) approach using a different data structure, but given the constraints, I think this O(n log n) solution is simpler and sufficient"). If genuinely finished early, asking a thoughtful question about the team, the codebase, or how this kind of problem shows up in their actual work is a good use of remaining time and reads as genuine engagement rather than just clock-watching.
