---
title: Retrieval Quality and Reranking
description: Why vector search alone often underperforms, how hybrid search and reranking fix it, and how to debug whether a bad answer is a retrieval or generation failure
difficulty: Advanced
tags: [retrieval, reranking, hybrid-search, evaluation]
---

Retrieval quality is the ceiling on everything a RAG system can do — a perfect generator fed the wrong chunks still produces a wrong answer. This page covers why pure vector search isn't enough, the standard fixes, and the single debugging skill that separates people who've actually run a RAG system in production from people who've only read about it.

## Why vector search alone underperforms

Semantic (vector) search excels at matching *meaning* but is often weaker on exact terms — product codes, acronyms, error messages, proper nouns, or numbers — because embeddings compress specific tokens into a general semantic representation, and two strings differing only in an exact identifier can end up very close in embedding space even though only one is actually correct.

> [!WARNING]
> A query for error code `ERR_4092` can retrieve chunks about error handling in general far more readily than the one chunk that specifically documents `ERR_4092`, because the embedding model represents the query's overall semantic gist ("an error code lookup") rather than treating the exact string as a hard constraint. Pure vector search structurally struggles with this class of query.

## Keyword vs vector vs hybrid

| Approach | Strength | Weakness |
|---|---|---|
| Keyword / BM25 | Exact term matches (codes, names, acronyms, rare terms) score highly and predictably | Misses semantically related content with no shared vocabulary |
| Vector / semantic | Finds conceptually related content regardless of exact wording | Weaker on exact identifiers, numbers, rare or out-of-distribution terms |
| Hybrid | Combines both signals, covering each approach's blind spot | More moving parts — needs a fusion strategy |

The standard fusion technique is **Reciprocal Rank Fusion (RRF)**: run both a keyword search and a vector search independently, then combine their ranked lists by scoring each document as `sum(1 / (k + rank))` across the lists it appears in (k is a small constant, often 60), rather than trying to normalise and average two very differently-scaled relevance scores directly.

```mermaid
flowchart TD
    Q["Query"] --> KW["BM25 keyword search"]
    Q --> VEC["Vector similarity search"]
    KW --> RRF["Reciprocal Rank Fusion"]
    VEC --> RRF
    RRF --> RR["Cross-encoder rerank"]
    RR --> TOPK["Final top-k for generation"]
```

> [!KEY]
> RRF is popular precisely because it sidesteps score normalisation — BM25 scores and cosine similarities live on incomparable scales, but *rank position* is always comparable. This is the practical reason hybrid search is usually implemented via rank fusion, not weighted score averaging.

## Cross-encoder reranking

A **bi-encoder** (what standard embedding-based vector search uses) encodes the query and each document independently into vectors, then compares them — fast, because document vectors are precomputed once at index time. A **cross-encoder** feeds the query and a candidate document *together* into one model pass, letting it directly attend to the interaction between them — much more accurate at judging true relevance, but it cannot be precomputed, since it needs the specific query at inference time.

| | Bi-encoder (vector search) | Cross-encoder (reranker) |
|---|---|---|
| Input | Query and document encoded separately | Query and document encoded together |
| Speed | Fast — precomputed document vectors, single query encode per search | Slow — one full model pass per (query, candidate) pair |
| Scale | Works over millions of documents via ANN index | Only practical over a small candidate set (tens to ~100) |
| Accuracy | Good | Better — sees direct query-document interaction |

The standard pattern: use vector (or hybrid) search to cheaply narrow millions of documents down to a top-50-100 candidate set, then run a cross-encoder reranker over just that small set to reorder for final precision — getting the accuracy benefit of cross-encoding without paying its cost across the whole corpus.

> [!WARNING]
> Reranking is one of the more expensive stages in a RAG pipeline's latency budget — a cross-encoder pass over 50-100 candidates can add 100-400ms. It's worth it when the eval set shows reranking meaningfully improves top-k precision, but it's not "always free accuracy" — measure the latency cost against the quality gain for your specific use case.

## Query expansion and HyDE

**Query expansion** generates additional related terms or phrasings for the original query before searching, hedging against vocabulary mismatch between how the user phrased their question and how the source documents are written.

**HyDE (Hypothetical Document Embeddings)** flips the usual direction: instead of embedding the user's question directly, you ask an LLM to generate a *hypothetical answer* to the question, then embed *that* and search with it. The intuition: a plausible answer is often closer in embedding space to the real matching document than the bare question is, because both the hypothetical answer and the real document are answer-shaped text, while the question is phrased very differently from an answer.

## Metadata filtering

Combining semantic/hybrid search with structured filters (date range, category, tenant, permission level) narrows the candidate pool to what's actually eligible before or after ranking. See the embeddings page for the pre-filter vs post-filter trade-off — the same consideration applies here: a narrow filter applied after ranking risks starving the result set.

## Recall@k vs precision@k

| Metric | Definition | What it tells you |
|---|---|---|
| Recall@k | Of all truly relevant documents, what fraction appear in the top k results? | Whether the system can find relevant content at all within your retrieval budget |
| Precision@k | Of the k documents returned, what fraction are actually relevant? | Whether the results you show are mostly signal or mostly noise |

**Worked example**: suppose there are 4 truly relevant documents in the corpus for a query, and your system's top-5 results contain 2 of them (plus 3 irrelevant ones).

- Recall@5 = 2 / 4 = **50%** (you found half of what exists)
- Precision@5 = 2 / 5 = **40%** (less than half of what you showed was relevant)

> [!TIP]
> Say this distinction explicitly: "Recall@k tells you whether retrieval is capable of finding the right content at all — it's the ceiling. Precision@k tells you how much noise the generator has to wade through. Low recall is a retrieval/chunking/embedding problem; low precision with good recall is often a ranking or reranking problem, not a retrieval-coverage problem."

## Retrieval failure vs generation failure

This is the single most useful debugging skill in RAG work: when an answer is wrong, the very first question is **"was the correct information even retrieved?"** — not "is the prompt good enough" or "is the model smart enough."

```mermaid
flowchart TD
    A["Answer is wrong"] --> B{"Was the correct chunk<br/>in the retrieved context?"}
    B -->|"No"| C["Retrieval failure<br/>fix: chunking, embeddings, query, filters"]
    B -->|"Yes"| D["Generation failure<br/>fix: prompt, context ordering, model choice"]
```

- **Retrieval failure**: the correct chunk was never fetched. No prompt engineering fixes this — the model was never given the right material to work with. Fix upstream: chunking strategy, embedding model, query rewriting, index/filter configuration.
- **Generation failure**: the correct chunk *was* retrieved and present in the assembled context, but the model still answered incorrectly — ignoring it, misreading it, or contradicting it. Fix downstream: prompt clarity, context ordering (lost-in-the-middle), or occasionally model choice.

> [!DANGER]
> Tuning the prompt to fix what is actually a retrieval failure is a classic wasted-effort trap — no amount of prompt engineering makes a model answer correctly from information it was never given. Always check what was actually retrieved before touching the generation prompt.

## Chunk-level vs document-level scoring

Retrieval typically scores and ranks at the chunk level (since that's the embedded unit), but sometimes the *document* a chunk came from matters too — several weakly-relevant chunks from one highly authoritative or on-topic document can collectively outweigh one strongly-matching chunk from an unrelated document. Some systems add a document-level aggregation step (e.g. boosting chunks whose sibling chunks also scored well) on top of raw chunk scores to capture this.

## Tuning k

| k too small | k too large |
|---|---|
| Misses relevant content that scored just outside the cutoff (low recall) | Dilutes context with marginal or irrelevant chunks (low precision, wasted context budget) |
| Cheaper and faster | More expensive; can trigger lost-in-the-middle if not reranked/ordered |

There's no universal correct k — retrieve a larger candidate set (e.g. top-50) cheaply, rerank, then pass only a smaller final k (e.g. top-5) to the generator. This decouples "cast a wide net for recall" from "keep the generator's context tight for precision."

## Symptom-to-fix table

| Symptom | Likely cause | Fix |
|---|---|---|
| Exact codes/IDs never retrieved correctly | Vector search weak on exact-match terms | Add keyword/BM25 search, fuse with RRF |
| Right chunk retrieved but answer still wrong | Generation failure | Fix prompt, context ordering, or check lost-in-the-middle |
| Right chunk never in top-k at all | Retrieval failure | Revisit chunking, embedding model, or query phrasing |
| Good recall, noisy/irrelevant top results | Ranking problem, not coverage | Add or tune a reranker |
| Multi-tenant search returns too few results | Post-filtering starving the candidate set | Over-fetch before filtering, or use native pre-filtering |
| Answers miss content phrased differently than the query | Vocabulary mismatch | Query expansion or HyDE |
| Latency budget blown by reranking | Cross-encoder over too many candidates | Shrink the candidate set before reranking, or use a lighter reranker |

## Cheat sheet

- Vector search is weak on exact terms (codes, IDs, acronyms) — pair with keyword/BM25 via hybrid search.
- Reciprocal Rank Fusion combines ranked lists without needing to normalise incomparable relevance scores.
- Cross-encoders are more accurate than bi-encoders but too slow to run over a full corpus — rerank only a narrowed candidate set.
- Recall@k is your ceiling (can you find it at all); precision@k is your noise level (how much of what you show is relevant).
- The first debugging question for any wrong answer: was the correct chunk actually retrieved?
- Retrieval failures need upstream fixes (chunking, embeddings, query); generation failures need downstream fixes (prompt, ordering).
- Retrieve a wide candidate set cheaply, rerank, then pass a smaller final k to the generator.
- HyDE embeds a hypothetical answer instead of the raw question to close the question-vs-answer phrasing gap.
- Query expansion and reranking both cost latency — apply them where eval data shows they're needed, not everywhere.

## Common mistakes

| Mistake | Fix |
|---|---|
| Relying on vector search alone for a corpus with codes/IDs/acronyms | Add hybrid keyword search, fuse with RRF |
| Averaging raw BM25 and cosine scores directly | Use rank-based fusion (RRF) instead of score normalisation |
| Reranking the entire corpus with a cross-encoder | Narrow to a candidate set first (e.g. top-50), then rerank |
| Tuning the prompt when the real problem is missing retrieval | Check what was actually retrieved before touching generation |
| Treating high recall as "retrieval is done" | Also measure precision — noisy top-k still hurts generation quality |
| Fixing k once and never revisiting it | Retrieve wide, rerank, then trim to a smaller final k |

## Summary

Vector search alone reliably underperforms on exact-match content, which is why hybrid search (fused via reciprocal rank fusion) and cross-encoder reranking are standard, not optional, upgrades in a serious retrieval pipeline. Recall@k and precision@k measure two different failure modes — can you find it at all, versus how much noise comes with it — and both matter. The highest-leverage skill in this whole area is diagnosing, for any wrong answer, whether the correct chunk was retrieved at all before touching a single word of the generation prompt; that one question routes you to the right fix every time.

## Top Interview Questions

### Q1. Why does pure vector/semantic search often underperform on queries involving exact identifiers like error codes or product IDs?

Embedding models compress text into a representation optimised for semantic similarity, which means they capture the general topic or intent of a query well but are weaker at treating a specific exact string as a hard, non-negotiable constraint. A query for a specific error code can end up embedding close to many chunks broadly about error handling, with the one chunk that actually documents that exact code scoring no higher (sometimes lower) than several irrelevant ones, because "this is an error-code-shaped question" dominates the embedding over the exact digits. Keyword-based search (BM25) doesn't have this weakness — an exact token match scores strongly and predictably — which is exactly why production systems pair vector search with keyword search rather than relying on embeddings alone.

### Q2. What is Reciprocal Rank Fusion and why is it used to combine keyword and vector search results?

RRF combines two or more independently ranked result lists by scoring each document as the sum of `1 / (k + rank)` across every list it appears in, where rank is its position in that list and k is a small constant (commonly 60) that dampens the impact of very high ranks. It's used because BM25 relevance scores and cosine similarity scores live on completely different, non-comparable numeric scales, so naively averaging or weighting raw scores from both systems produces meaningless combined numbers. Rank position, by contrast, is always comparable regardless of the underlying scoring system, which is why fusing by rank rather than by raw score is the standard, robust way to merge results from fundamentally different retrieval methods.

### Q3. What's the difference between a bi-encoder and a cross-encoder, and why can't you just use a cross-encoder for everything?

A bi-encoder (standard embedding-based search) encodes the query and each document independently, so all document vectors can be precomputed once at index time and a search is just a fast nearest-neighbour lookup against a precomputed set. A cross-encoder feeds the query and a specific candidate document together into one model pass, letting it directly model the interaction between them, which produces meaningfully more accurate relevance judgments — but it can't be precomputed, since the model needs the actual query at inference time, and running it is much slower per comparison. You can't apply a cross-encoder to an entire multi-million-document corpus per query for latency reasons alone, which is why the standard pattern is: cheap bi-encoder (or hybrid) search narrows to a small candidate set, and the cross-encoder reranks only that narrowed set.

### Q4. Define recall@k and precision@k, and give a worked example showing they can diverge.

Recall@k is the fraction of all truly relevant documents in the corpus that appear somewhere in your top-k results — it measures whether your system is capable of finding relevant content at all within that budget. Precision@k is the fraction of the k documents you actually returned that are truly relevant — it measures how much noise is mixed in with your results. Worked example: if there are 4 genuinely relevant documents for a query anywhere in the corpus, and your top-5 results contain 2 of them, recall@5 is 2/4 = 50% and precision@5 is 2/5 = 40%. These can diverge in either direction — you could have high recall (you found most of what exists) but low precision (you also returned a lot of irrelevant filler), or the reverse (everything you returned is relevant, but you missed most of what actually exists).

### Q5. A RAG answer is factually wrong. What's the first thing you check, and why does it matter more than tuning the prompt?

The first thing to check is whether the chunk containing the correct information was actually present in the context that was sent to the generator — log and inspect the retrieved chunks for that specific request, not just the final answer. This matters more than immediately tuning the prompt because if the correct information was never retrieved, no amount of prompt engineering can fix the answer — the model literally never saw the right material, so any prompt change is addressing the wrong layer of the system and will fail to actually fix the problem, wasting engineering time. If the correct chunk *was* present and the model still got it wrong, that confirms a genuine generation failure, and only then does it make sense to look at prompt wording, context ordering, or model choice.

### Q6. Once you've confirmed a bad answer is specifically a generation failure (the right chunk was retrieved), what would you look at?

I'd first check where the correct chunk was positioned in the assembled context — if it was buried in the middle of several other chunks rather than placed near the start or end (closest to the actual question), that's a lost-in-the-middle problem, fixable by re-ordering context by relevance. I'd also check the prompt's explicit instructions about how to use the provided context — does it clearly tell the model to answer only from the given material and prioritize it over its own general knowledge? Finally I'd consider whether the model itself is simply not capable enough for the reasoning required (e.g. synthesizing across multiple chunks) and whether a larger model or an explicit reasoning step in the prompt (asking it to first identify the relevant fact, then answer) would help.

### Q7. Why would you retrieve, say, the top 50 candidates but only pass the top 5 to the generator?

Retrieving a wider candidate set (e.g. top-50) cheaply via vector or hybrid search casts a wide enough net to protect recall — the correct chunk is more likely to be somewhere in 50 candidates than in a much smaller initial set. Reranking that candidate set with a more accurate but expensive method (a cross-encoder) then reorders it by true relevance, and only the top handful (e.g. 5) actually need to go to the generator, since the generator's context window and attention are a limited resource — passing all 50 would dilute the context with lower-relevance material and waste token budget and latency for no accuracy gain. This two-stage "retrieve wide, rerank, trim narrow" pattern decouples the recall concern (don't miss the right answer) from the precision concern (don't dilute what the generator actually sees).

### Q8. What is HyDE and what specific problem does it solve?

HyDE (Hypothetical Document Embeddings) addresses the mismatch between how questions are phrased and how the actual answering content is written — a user's question ("how do I reset my password") and the document that answers it (a procedural paragraph with no question marks at all) can be further apart in embedding space than you'd expect, purely because one is question-shaped text and the other is answer-shaped text. HyDE works around this by first asking an LLM to generate a plausible hypothetical answer to the question, then embedding and searching with *that* generated answer instead of the raw question — since the hypothetical answer and the real matching document are both answer-shaped, they tend to be closer in embedding space, improving retrieval for exactly this kind of question/answer phrasing gap.

### Q9. Your team adds a cross-encoder reranker and answer quality improves, but p95 latency goes up noticeably. How do you think about that trade-off?

I'd first quantify both sides precisely: how much did precision/recall or downstream answer-quality metrics actually improve on the eval set, and exactly how much latency did the reranking stage add (it's usually the single most expensive per-item stage in the pipeline, easily 100-400ms depending on candidate count and model size). Then I'd look at levers to reduce the cost without giving up the quality gain: shrinking the number of candidates fed into the reranker (fewer candidates to score), using a smaller/faster cross-encoder model, or reranking only when the initial retrieval scores are ambiguous (skip reranking when the top result is already a clear, high-confidence match). The decision itself depends on the product's latency SLA — a customer-facing chat feature has a much tighter tolerance than an internal or batch/offline use case.

### Q10. How would you diagnose why a multi-tenant RAG system returns very few results for one specific tenant, when you know they have relevant documents indexed?

I'd first determine whether this is a filtering artifact rather than a genuine retrieval quality problem: if the tenant filter is applied as a post-filter over a shared index, and this tenant's documents are a small fraction of a much larger multi-tenant index, the initial top-k candidates (before filtering) may contain very few or zero of this tenant's documents even though relevant ones exist further down the unfiltered ranking. I'd verify by re-running the same query without the tenant filter and checking whether the tenant's relevant documents appear in a wider unfiltered result set — if they do, but much lower ranked, the fix is to either over-fetch a larger candidate pool before filtering or switch to native pre-filtering rather than assuming this is a chunking or embedding-quality issue.

### Q11. When would document-level scoring matter more than pure chunk-level scoring?

Chunk-level scoring treats each chunk as fully independent, which works well when relevance genuinely is localized to a single passage. But sometimes the right answer requires synthesizing across several chunks from the same authoritative or clearly on-topic document, where each individual chunk might score only moderately on its own, while a single strongly-worded but off-topic chunk from an unrelated document scores higher in isolation. In these cases, boosting a chunk's score based on how well its sibling chunks (from the same source document) also scored can surface the more genuinely relevant document as a whole, rather than letting one lucky high-scoring but contextually isolated chunk win purely on chunk-level score. This matters most for longer, structured source documents (reports, manuals) where meaning is distributed across sections rather than confined entirely within any one chunk.

### Q12. How do you decide whether your retrieval pipeline actually needs hybrid search and reranking, versus keeping it simple with vector search alone?

I'd look at the actual query patterns and failure cases in the domain: if users frequently search by exact identifiers, codes, names, or rare technical terms, that's a strong signal pure vector search will underperform and hybrid search is worth the added complexity. I'd build a labelled eval set reflecting real query patterns and measure recall@k and precision@k with vector search alone versus hybrid plus reranking, quantifying the actual quality lift rather than assuming it's needed. If the corpus is small, the query patterns are consistently conceptual/semantic rather than exact-match-heavy, and the simple vector-only setup already scores well on the eval set, adding hybrid search and a reranker is unnecessary complexity and latency cost — the decision should be evidence-driven, not "best practice" by default.
