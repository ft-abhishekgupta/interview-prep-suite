---
title: Chunking Strategies
description: Why documents must be split before embedding, how different chunking strategies trade off context against precision, and how to evaluate the choice
difficulty: Core
tags: [chunking, rag, ingestion, retrieval]
---

Chunking is the least glamorous part of a RAG system and the one most likely to quietly cap its quality. Get it wrong and no amount of prompt tuning or reranking downstream fixes it — retrieval can only return what was chunked sensibly in the first place.

## Why chunking exists

Two hard constraints force documents to be split before embedding and retrieval:

1. **Embedding models have an input limit** (often 512–8,000 tokens) — you cannot embed an entire 50-page document as one vector without losing most of its specific detail into a single averaged representation.
2. **Retrieval needs precision** — if a whole document is one chunk, a query about one paragraph pulls in the entire document's noise, wasting context window budget and diluting the signal the generator needs.

> [!KEY]
> The chunk is the unit of retrieval. Whatever granularity you chunk at is the granularity your search can ever return — chunk too coarse and you retrieve noise, chunk too fine and you lose the surrounding context a correct answer needs.

## Chunking strategies compared

| Strategy | How it splits | Strength | Weakness |
|---|---|---|---|
| Fixed-size | Every N tokens/characters, regardless of content | Simple, predictable, fast | Cuts mid-sentence or mid-idea; ignores structure entirely |
| Sentence-based | Splits on sentence boundaries, groups to a target size | Never splits mid-thought | Loses paragraph-level context; many small chunks |
| Paragraph-based | Splits on paragraph breaks | Preserves a coherent unit of thought | Paragraph length varies wildly by source, hard to size-bound |
| Semantic | Embeds sentences, splits where semantic similarity drops between neighbours | Splits align with actual topic shifts | Extra compute cost at ingestion; more complex to implement |
| Structural (markdown/heading-aware) | Splits on headings, list boundaries, code fences | Respects the document's own logical structure | Only works well on structured source formats |
| Recursive | Tries paragraph, falls back to sentence, falls back to fixed-size, in order | Robust default across mixed content | More logic to tune and reason about |

> [!TIP]
> A senior answer: "I'd start with recursive character/structural splitting as the default — it degrades gracefully across messy real-world content — and only invest in semantic chunking if the eval set shows the default strategy is cutting mid-topic in a way that measurably hurts retrieval."

## Chunk size and overlap

There's no universally correct chunk size — it's a trade-off between **precision** (small chunks pinpoint the exact relevant passage) and **context sufficiency** (large chunks carry enough surrounding information for the generator to answer without needing multiple retrievals).

| Chunk size | Typical use | Trade-off |
|---|---|---|
| 100–256 tokens | Precise fact lookup (FAQ, glossary, definitions) | High precision, may lose surrounding context |
| 300–512 tokens | General-purpose RAG default | Balanced — most teams start here |
| 800–1,500 tokens | Narrative or technical content needing more context | Better context, more noise per retrieved chunk, fewer chunks fit in the context window |

**Overlap** (typically 10–20% of chunk size, e.g. 50 tokens of overlap on a 300-token chunk) repeats the tail of one chunk at the start of the next, so a sentence or idea that straddles a chunk boundary isn't lost from either chunk entirely.

> [!WARNING]
> Overlap is not free — it multiplies storage and embedding cost roughly by `1 / (1 - overlap_ratio)`. 20% overlap means roughly 25% more chunks (and more embedding calls) than no overlap for the same corpus. Tune it, don't default to a large value out of caution.

## Preserving context: headers, summaries, parent documents

A chunk read in isolation often loses the context that made it meaningful — which document, section, or heading it came from. Two common fixes:

- **Prepend header/breadcrumb context** to each chunk before embedding: `"Section: Billing > Refunds\n\n{chunk text}"`. This costs a few extra tokens but dramatically improves both retrieval relevance (the heading itself carries signal) and the generator's ability to use the chunk correctly.
- **Parent-document retrieval**: embed and search over *small* chunks for precision, but when a small chunk is retrieved, fetch and pass its *larger parent chunk* (or the whole section) to the generator for context.

```mermaid
flowchart LR
    A["Small child chunk<br/>(200 tokens, embedded, searched)"] -->|"matches query"| B["Look up parent ID"]
    B --> C["Fetch large parent chunk<br/>(1500 tokens, not embedded)"]
    C --> D["Pass parent chunk to generator"]
```

> [!KEY]
> Parent-document retrieval solves the precision-vs-context trade-off directly instead of picking one chunk size and living with its downside: search stays precise because it's over small chunks, and generation quality stays high because the model sees the full surrounding section.

## Tables and code

Naive text splitting is actively destructive to tables and code blocks — cutting a table in half mid-row, or a function mid-body, destroys the only thing that made the chunk meaningful.

- **Tables**: keep a table as one atomic chunk where possible (or re-serialize each row with its header context, e.g. `"Row: Plan=Pro, Price=$49, Limit=10k requests"`), rather than splitting by raw character count.
- **Code**: chunk by function/class boundary (using the language's AST or simple brace/indentation matching) instead of a fixed line count, so a retrieved chunk is a complete, runnable unit.

## Metadata to attach to every chunk

| Metadata field | Why it matters |
|---|---|
| Source document ID / URL | Needed for citation and for parent-document lookup |
| Section / heading path | Improves relevance signal and lets you show provenance |
| Chunk position (index, page number) | Enables re-assembling order, adjacent-chunk lookup |
| Last updated / version timestamp | Supports freshness filtering and detecting stale content |
| Access control tags (tenant, permission level) | Required for filtering results to what the querying user is allowed to see |
| Content type (table, code, prose) | Lets downstream logic handle each type differently |

## Chunking for different document types

| Document type | Recommended approach |
|---|---|
| Markdown / docs | Structural (heading-aware), fall back to recursive within a section |
| PDFs (reports, contracts) | Extract structure first (headings, tables) if possible; otherwise paragraph-based with generous overlap |
| Chat / support transcripts | Chunk by conversation turn or thread, not fixed size — a turn is the natural unit |
| Code repositories | Function/class-level chunking with file path and imports as metadata |
| Spreadsheets / tabular data | Row-level or logical-group chunking, not raw text splitting |

## Evaluating chunking choices

Chunking decisions are testable, not aesthetic — build a small labelled eval set (queries with known correct source passages) and measure retrieval metrics (recall@k, see the retrieval-quality page) across candidate chunking strategies before committing to one. Changing chunk size or strategy requires re-embedding and re-indexing the whole corpus, so validate on a sample before running it against the full production corpus.

```mermaid
flowchart TD
    A["Raw documents"] --> B["Parse & normalise<br/>(strip boilerplate, extract structure)"]
    B --> C["Chunk<br/>(structural / recursive / semantic)"]
    C --> D["Attach metadata<br/>(source, section, timestamp, ACL)"]
    D --> E["Embed each chunk"]
    E --> F["Write to vector index"]
```

> [!NOTE]
> Ingestion is a pipeline with real failure modes of its own — a parsing bug that silently drops a table, or a chunker that runs on the wrong document version, will look exactly like a "retrieval quality" problem downstream. Log chunk counts and sample outputs per ingestion run so a broken pipeline is visible before it ships bad data.

## Cheat sheet

- Chunk size caps what retrieval can ever return — too coarse retrieves noise, too fine loses context.
- Recursive/structural splitting is a robust default; reach for semantic chunking only when the eval set justifies the extra cost.
- 300–512 tokens is a common general-purpose default; tune against your own eval set, not a rule of thumb.
- Overlap (10–20%) protects boundary-straddling ideas but multiplies embedding/storage cost — don't over-apply it.
- Prepend heading/breadcrumb context to each chunk before embedding — cheap and effective.
- Parent-document retrieval (small chunk for search, large chunk for context) directly solves the precision-vs-context trade-off.
- Never split tables or code by raw character count — chunk them as atomic, structurally-aware units.
- Attach source, section, timestamp, and access-control metadata to every chunk at ingestion time.
- Chunking strategy changes require a full re-embed and re-index — validate on a sample first.

## Common mistakes

| Mistake | Fix |
|---|---|
| Fixed-size chunking on structured docs (markdown, contracts) | Use structural/heading-aware splitting first |
| Splitting a table or code block by raw character count | Chunk as an atomic unit or re-serialize row/function-wise |
| No overlap at all on prose content | Add 10-20% overlap to protect boundary-straddling sentences |
| Embedding chunks with no source/section/timestamp metadata | Attach it at ingestion — retrofitting later requires re-processing |
| Picking one chunk size and using it for both search and context | Consider parent-document retrieval: small for search, large for context |
| Changing chunk size in production without re-validating retrieval quality | Re-embed, re-index, and re-run the eval set before shipping |

## Summary

Chunking sets a hard ceiling on retrieval quality: the chunk is the atomic unit search can ever return, so its size and boundaries determine whether retrieval is precise, noisy, or context-starved. Recursive and structural splitting are strong, low-effort defaults; semantic chunking and parent-document retrieval are the upgrades worth reaching for once an eval set shows the default strategy is the bottleneck. Because re-chunking means re-embedding the whole corpus, treat chunking strategy as a decision to validate carefully up front, not a parameter to casually tweak in production.

## Top Interview Questions

### Q1. Why can't you just embed an entire document as a single vector?

Two separate limits force chunking. First, embedding models have an input token limit, so a long document may not even fit as one input. Second, and more importantly, even where it would fit, a single vector for an entire multi-topic document averages together everything in it into one point in the embedding space — a query about one specific paragraph produces a much weaker match against that averaged whole-document vector than it would against a vector representing just that paragraph. Chunking exists to make the unit being embedded small and focused enough that similarity search can distinguish between them meaningfully — the chunk is the smallest thing retrieval can return, so its granularity directly determines retrieval precision.

### Q2. What's the difference between fixed-size and recursive chunking, and why is recursive often the safer default?

Fixed-size chunking splits every N tokens or characters regardless of content, which is simple and fast but routinely cuts sentences, paragraphs or even words in half, destroying local coherence. Recursive chunking tries a hierarchy of separators in order — split on paragraph breaks first, and only fall back to sentence-level or raw character splitting for oversized paragraphs that don't fit the target chunk size — so it respects structure where structure exists and degrades gracefully to something reasonable where it doesn't. It's a safer default across mixed, messy real-world content (scraped web pages, inconsistent document formatting) because it doesn't assume the source is cleanly structured, unlike a purely heading-aware splitter which needs actual headings to work well.

### Q3. How do you decide on a chunk size for a new RAG feature?

Start from a reasonable default (300-512 tokens is common for general-purpose text), then validate against a labelled eval set of real queries paired with the passages that should be retrieved for them, measuring recall@k across a few candidate sizes. The right size is a trade-off: too small and individual chunks lack enough context for the generator to answer correctly even if retrieval finds the right one; too large and irrelevant surrounding text dilutes the signal and wastes context window budget on noise. I'd also factor in the content type — FAQ-style short-answer content wants smaller chunks for precision, while narrative or technical explanation content often needs bigger chunks to remain self-contained.

### Q4. What problem does chunk overlap solve, and what's the cost of overusing it?

Without overlap, an idea or sentence that happens to fall exactly on a chunk boundary can be split so that neither the preceding nor following chunk contains the complete thought, and a query about that specific idea may fail to match either chunk well. Overlap (repeating the last N tokens of one chunk at the start of the next, typically 10-20% of chunk size) ensures boundary-straddling content appears intact in at least one chunk. The cost is that overlap directly multiplies the number of chunks, and therefore embedding calls, storage, and index size, roughly by `1 / (1 - overlap_ratio)` — 20% overlap adds about 25% more chunks for the same corpus, so it should be tuned against measured benefit, not applied as a large default "just in case."

### Q5. What is parent-document retrieval and what problem does it solve?

It's a pattern where you embed and search over small, precise chunks, but when a small chunk is retrieved as a match, you fetch and pass a larger "parent" chunk (or the full surrounding section) to the generator instead of just the small matched piece. This directly resolves the tension between wanting small chunks for precise search matching and wanting large chunks for the generator to have enough context to answer correctly — instead of picking one chunk size and accepting its downside, you decouple the unit of search from the unit of generation. The implementation detail that matters: each small chunk needs a stable reference (parent ID) back to its larger source section, established at ingestion time.

### Q6. Why is naive fixed-size text splitting particularly bad for tables and code?

A table's meaning depends on the relationship between a row's values and its header row — splitting a table by raw character count can put values in one chunk and their header in another, making the retrieved chunk unintelligible on its own (a row of numbers with no idea what they represent). Code has an analogous problem: splitting a function body from its signature, or splitting mid-function, produces a retrieved chunk that isn't a complete, meaningful, or even syntactically valid unit. The fix is structure-aware chunking for both: treat a table as an atomic chunk (or re-serialize each row with its header context inline), and chunk code at function or class boundaries using the language's actual structure rather than a fixed line count.

### Q7. What metadata should you attach to a chunk at ingestion time, and why do it then rather than later?

At minimum: the source document ID/URL (for citation and parent-document lookup), a section/heading path (improves relevance and shows provenance), position within the document (for reconstructing order or fetching adjacent chunks), a last-updated timestamp (for freshness filtering), and access-control tags (tenant ID, permission level) required to filter results to what the querying user is actually allowed to see. You do this at ingestion time because most of this metadata is only cheaply available right when you're processing the source document — recovering it later means re-parsing and re-processing the original source, which is exactly the expensive re-ingestion you were trying to avoid by chunking well the first time.

### Q8. Your RAG system gives noticeably worse answers for one specific document type (say, contracts) than for your general documentation. How would you investigate whether chunking is the cause?

I'd start by manually inspecting the actual chunks produced from a few sample contracts — pull the raw stored chunks and read them, checking whether they read as coherent, self-contained units or whether they're cutting mid-clause, splitting defined terms from their definitions, or breaking numbered sections apart. Contracts have a lot of internal structure (numbered clauses, defined terms, cross-references) that a generic recursive or fixed-size splitter often mishandles compared to prose documentation. If the chunks themselves look broken or incoherent, that's a strong signal to build a structure-aware splitter specific to that document type (e.g. splitting on numbered clause boundaries) rather than assuming the problem is in the embedding model, the generator, or reranking.

### Q9. How would you evaluate whether switching from fixed-size to semantic chunking is worth the added complexity and cost?

I'd build (or reuse) a labelled eval set — queries paired with the specific passages that should be retrieved for them — and measure recall@k and precision@k under both the current fixed-size chunking and a semantic-chunking candidate, on the same corpus. Semantic chunking adds real cost (an extra embedding pass over sentences during ingestion to detect topic-shift boundaries) and implementation complexity, so the decision should be evidence-based: if the eval set shows fixed-size chunking is measurably cutting across topic boundaries in a way that hurts recall, semantic chunking is justified; if the current strategy already scores well, the added cost isn't worth it. This mirrors how you'd evaluate any other retrieval change — never swap a foundational pipeline component on intuition alone.

### Q10. If you change your chunk size in production, what has to happen before you can safely ship it?

Because chunk size determines what gets embedded, changing it invalidates every existing vector in the index — you need to re-chunk the entire corpus with the new size, re-embed every resulting chunk, and rebuild (or fully replace) the vector index; you cannot mix chunks of different sizes/strategies meaningfully in the same similarity comparison space in a way that's easy to reason about. Before rolling this out to production traffic, I'd re-run it against a labelled eval set to confirm the new chunk size actually improves (or doesn't regress) retrieval quality, and plan the cutover so old and new indexes don't get queried inconsistently mid-migration — typically build the new index fully offline, validate it, then switch traffic over atomically rather than mutating the live index in place.

### Q11. How would you chunk a long customer support chat transcript differently from a technical PDF manual?

A chat transcript's natural unit of meaning is the conversational turn (or a small cluster of turns around one topic within the conversation) — chunking by a fixed token count would arbitrarily split mid-exchange and lose the question/answer pairing that makes a turn meaningful, so I'd chunk by turn or logical exchange boundary instead, keeping speaker labels as part of the chunk. A technical PDF manual usually has real structure (headings, numbered sections, procedures) worth extracting and using directly — structural/heading-aware chunking that respects the document's own section boundaries, ideally combined with prepending the heading path to each chunk, produces far more coherent and useful chunks than blind fixed-size or even generic recursive splitting on an unstructured extraction of the PDF text.

### Q12. What's the risk of prepending section headers to every chunk, and is it worth it anyway?

The main costs are a small increase in token count per chunk (a few extra tokens for the heading path) and slightly more ingestion-time logic to track and attach the correct heading context as you walk through a document. In exchange, it substantially improves two things: retrieval relevance, because the heading itself often carries strong topical signal that helps the embedding represent the chunk's context correctly (a chunk about "cancellation fees" under a "Refunds" heading is more clearly disambiguated than the same text with no heading at all), and generation quality, because the model receiving the chunk knows what section/context it came from rather than having to infer it from an isolated snippet. Given the cost is small and fixed, it's one of the higher-value, lowest-risk chunking improvements to make by default.
