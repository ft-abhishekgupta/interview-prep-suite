# Merge Spec — folding the hand-written notes into the curriculum

The site currently has two parallel sets of pages: an authored curriculum, and the
author's own hand-written notes sitting in separate `NN-my-notes/` folders.

**Goal: one seamless notebook.** The personal notes must be folded into the curriculum
pages so a reader sees a single, coherent page per topic — no duplication, no "my notes"
appendix, no two versions of the same explanation.

---

## The two operations

### 1. MERGE — fold a note into an existing curriculum page

You are given one or more **source** note files and one **target** curriculum page.
Rewrite the target page in place so it contains the best of both, then leave the source
files alone (they are deleted centrally afterwards).

Rules:

- **The target page keeps its identity**: same file path, same frontmatter `title`,
  same overall structure (intro → `##` sections → `## Cheat sheet` → `## Common mistakes`
  → `## Summary` → `## Top Interview Questions`).
- **Deduplicate hard.** Where both sources explain the same thing, keep exactly one
  explanation — whichever is clearer and more precise. Do not keep both and do not write
  "as mentioned above".
- **Harvest what is genuinely additive** from the notes:
  - original diagrams and images (`![...](notes/...)`) — **always keep these, paths unchanged**
  - worked examples, code the author wrote, templates, mnemonics
  - personal framing, rules of thumb, and any detail the curriculum page lacks
  - extra interview questions worth adding (merge into the existing numbered list)
- **Drop what is redundant, stale or half-finished** — an outline with three bullets that
  the target already covers in a table adds nothing.
- **Do not attribute.** No "from my notes", no "originally I wrote". It reads as one voice.
- **Length**: the merged page may grow, but keep it readable — aim for **1,800–3,200 words**
  before the questions block. If the combined material genuinely exceeds that, cut the
  weakest material rather than shipping a wall of text.
- Renumber the questions `Q1..Qn` sequentially if you add any.

### 2. PLACE — promote a note to a first-class curriculum page

You are given a **source** note and a **destination path**. The note has no curriculum
counterpart, so it becomes a proper page in its own right.

Rules:

- Write the new file at the given path. Keep the author's content, structure and images.
- **Restructure it to match every other page on the site** so it does not read as an
  import: proper frontmatter, an opening paragraph, `##` sections, at least one mermaid
  diagram, at least two tables, 2–4 callouts, then `## Cheat sheet`, `## Common mistakes`,
  `## Summary` and `## Top Interview Questions` with 8–12 `### Qn.` entries.
- **Expand thin notes.** Several notes are only 200–600 words of bullet points. Treat them
  as the author's skeleton and write the full page around them, keeping their decisions,
  numbers and diagrams intact.
- **Trim bloated notes.** Where a note is a 6,000-word brain dump, keep the substance but
  impose structure and cut repetition.
- Do not add `origin: personal` — these are ordinary pages now.

---

## Frontmatter (every page)

```
---
title: Binary Search
description: One line of 15 to 30 words, no colons, no quotes, no square brackets
difficulty: Foundational
tags: [arrays, patterns]
---
```

`difficulty` is one of `Foundational`, `Core`, `Advanced`.

## Formatting rules (unchanged from the authoring spec)

- Never use a level-1 `#` heading. `##` for sections, `###` for sub-sections.
- Callouts: a blockquote whose first line is `> [!KEY]`, `> [!TIP]`, `> [!WARNING]`,
  `> [!DANGER]` or `> [!NOTE]`.
- Mermaid: fence with ` ```mermaid `, always quote node labels (`A["Load Balancer"]`),
  never use `end`/`graph`/`class`/`style` as a node id, keep to ~12 nodes.
- Code fences must declare a language (`csharp`, `sql`, `typescript`, `bash`, `yaml`, `json`).
- **Image links must be copied through byte-for-byte** — they point at `notes/...` under
  `public/` and already resolve. Never invent an image path, never drop one.
- No raw HTML, no external URLs, no emoji outside tables.

## Question block

Ends every page:

```
## Top Interview Questions

### Q1. A real, commonly-asked question for this topic

An answer long enough to say out loud and win the point (80–180 words).

### Q2. ...
```

## Before you finish each file

- [ ] Frontmatter correct, `description` free of colons and quotes
- [ ] No `#` heading, no duplicated explanations
- [ ] Every image link from the source notes preserved
- [ ] Mermaid diagrams valid, tables present, callouts present
- [ ] `## Cheat sheet`, `## Common mistakes`, `## Summary`, `## Top Interview Questions`
- [ ] Questions numbered `Q1..Qn` with no gaps
