---
title: RAG Architecture
description: The end-to-end retrieval-augmented generation pipeline, why it beats fine-tuning for most knowledge tasks, and where the cost, latency and failure modes live
difficulty: Advanced
tags: [rag, architecture, retrieval, generation]
---

RAG (retrieval-augmented generation) is the default architecture for grounding an LLM in your own data. Interviewers use it to test whether you can reason about a multi-stage system end to end — where the latency goes, where it fails, and why you didn't just fine-tune instead.

## The full pipeline

RAG has two halves that run at very different times: an offline **ingestion** path that runs whenever content changes, and an online **query** path that runs on every user request.

```mermaid
flowchart TD
    subgraph "Ingestion (offline, on content change)"
        A["Source documents"] --> B["Chunk"]
        B --> C["Embed"]
        C --> D["Index (vector store)"]
    end
    subgraph "Query (online, per request)"
        E["User query"] --> F["Query rewrite / expand"]
        F --> G["Retrieve top-k"]
        G --> H["Rerank"]
        H --> I["Assemble context"]
        I --> J["Generate"]
        J --> K["Attach citations"]
    end
    D -.->|"searched by"| G
```

> [!KEY]
> Say the two halves explicitly in an interview: "Ingestion happens whenever content changes and is not latency-sensitive; the query path happens on every user request and is where your latency budget and failure modes actually live." Conflating the two is a common junior mistake.

Drawn end to end, the same embedding model sits on both halves — documents are chunked and vectorised into the store ahead of time, then the user's query is vectorised with that same model so the two live in a comparable space.

![RAG pipeline with an indexing path chunking and vectorising documents into a vector store and a query path retrieving contexts to augment the prompt](notes/AI/image.png)

> [!WARNING]
> Using a different embedding model on the ingestion path and the query path is the single most destructive RAG bug. Retrieval silently returns near-random neighbours, the model confidently answers from irrelevant context, and nothing errors. Pin the model version on both sides and re-index whenever it changes.

## Why RAG instead of fine-tuning

Both approaches inject knowledge the base model doesn't have, but they solve different problems.

| Factor | RAG | Fine-tuning |
|---|---|---|
| Freshness | Update the index, effective immediately | Requires retraining/re-tuning to reflect new facts |
| Cost to update | Cheap — re-embed changed documents | Expensive — a training run per update cycle |
| Attribution / citation | Natural — you know which chunk was retrieved | Not possible — knowledge is baked into weights, no source trace |
| Effort to stand up | Lower — mostly plumbing (index, retrieval, prompt) | Higher — data curation, training infra, eval |
| Best for | Knowledge that changes, needs sourcing, or is too large to memorize | Teaching a *behavior*, *style*, or *format*, not new facts |
| Hallucination risk on ungrounded questions | Lower — can say "not found" and refuse | Unchanged — fine-tuning doesn't add fact-checking |

> [!KEY]
> The clean framing: fine-tuning changes *how* a model behaves; RAG changes *what* it knows. If the requirement is "answer questions about our internal docs, and cite the source", that is a RAG problem by definition — fine-tuning cannot provide attribution because facts get compressed into weights with no traceable origin.

Fine-tuning is still the right tool when you need a consistent tone, a specific output format baked in without needing to repeat instructions every call, or domain-specific reasoning patterns — not for injecting facts that change over time.

## Context assembly and lost-in-the-middle

Once chunks are retrieved and reranked, you assemble them into the prompt. Two things matter here beyond just "paste in the top-k chunks":

- **Ordering**: models attend better to information near the start and end of the context than the middle — put the highest-confidence, most relevant chunk closest to the question, not just in retrieval-score order buried mid-context.
- **Budget discipline**: more retrieved chunks is not automatically better. Past a certain point, additional chunks add noise and cost without adding recall, and they compete for the model's attention with the chunks that actually matter.

> [!WARNING]
> "Lost in the middle" isn't a minor footnote — it's measurable in evals across model families. If your top result by relevance score is chunk #1 of 8 and you put it in the middle of the assembled context because that's insertion order, you may be actively hurting answer quality. Re-order by relevance, most-relevant closest to the question.

## Citation and grounding

A production RAG answer should be traceable back to its source — both for user trust and for debugging. Two common patterns:

1. **Inline citation**: the generation prompt instructs the model to tag claims with a source marker (`[1]`, `[2]`) mapped to the retrieved chunks, which your code renders as clickable references.
2. **Post-hoc attribution**: after generation, run a lighter check (embedding similarity or a smaller model) to verify which retrieved chunks actually support which sentences, catching cases where the model cited a source that doesn't really back the claim.

> [!DANGER]
> Asking the model to cite sources does not guarantee the citation is accurate — the model can confidently attach `[2]` to a claim that chunk 2 doesn't actually support. Citation is a UX and debugging aid, not a correctness guarantee, unless you add a verification step.

## Handling "I don't know"

The highest-value behavior a RAG system can have is **refusing gracefully** when retrieval doesn't find anything relevant, instead of falling back on the base model's ungrounded (and potentially hallucinated) knowledge.

```mermaid
flowchart LR
    A["Retrieve top-k"] --> B{"Top result above<br/>relevance threshold?"}
    B -->|"No"| C["Respond: not enough information found"]
    B -->|"Yes"| D["Generate grounded answer with citations"]
```

This requires an explicit relevance threshold (score cutoff on the retriever or reranker) and an explicit instruction in the generation prompt to answer *only* from the provided context and say so plainly when it's insufficient — left implicit, most models will still try to be "helpful" by answering from parametric knowledge, silently defeating the point of RAG.

## Query rewriting and multi-query

Raw user queries are often poor search queries — short, ambiguous, or referring back to prior conversation turns ("what about the enterprise one?"). Two common fixes:

- **Query rewriting**: use a fast, cheap model call to expand or clarify the query before embedding it — resolving pronouns from conversation history, adding likely synonyms, or converting a question into a more retrieval-friendly statement.
- **Multi-query**: generate several rephrased variants of the same question, retrieve for each, and merge/dedupe the results — this hedges against any single phrasing missing relevant chunks due to vocabulary mismatch.

Both add an extra model call (latency and cost) before retrieval even starts, so they're worth it specifically when your eval set shows retrieval recall is suffering due to poor query phrasing, not applied blindly everywhere.

## Conversation history in RAG

Multi-turn RAG has to decide what "the query" even means when context spans several turns. Common approach: before retrieval, condense the conversation history plus the latest message into a single **standalone query** (via a cheap model call) that resolves references like "it" or "that plan" into explicit terms, then retrieve using that standalone query rather than the raw last message alone.

## Caching layers

RAG pipelines have several natural caching points, each with a different hit-rate/complexity trade-off:

| Cache layer | What it caches | Why it helps |
|---|---|---|
| Embedding cache | Embeddings for repeated or common queries | Skips a model call for frequent/similar questions |
| Retrieval cache | Top-k results for a given (query, filter) pair | Skips the vector search itself for popular queries |
| Full response cache | Final generated answer for an exact or near-duplicate query | Largest latency win, only safe for content that doesn't need freshness per-request |

> [!TIP]
> Full response caching is powerful for FAQ-style traffic but dangerous if the underlying documents change frequently — a cached answer can go stale silently. Key the cache on both the query and a content-version marker, and set a TTL tied to how often your source data actually changes.

## Cost and latency budget

A rough budget for a synchronous RAG request, in order:

| Stage | Typical latency | Notes |
|---|---|---|
| Query rewrite (optional) | 100–300ms | Small/fast model |
| Embed query | 20–100ms | Usually a small dedicated embedding model |
| Vector search | 10–100ms | Depends on index size and ANN tuning |
| Rerank (optional) | 100–400ms | Cross-encoder rerank is the most expensive per-item step |
| Generation (to first token) | 300ms–2s | Depends on model size, context length |
| Generation (full answer, streamed) | 1–5s+ | Depends on output length and TPS |

> [!KEY]
> Reranking and generation dominate the latency budget, not the vector search itself — a common mistaken optimisation target is the ANN index when the real cost is a cross-encoder pass over 50 candidates or a large model's TTFT. Profile before optimising.

## Failure modes

| Failure | Symptom | Likely cause |
|---|---|---|
| Retrieval failure | Answer is wrong or vague, but doesn't mention any actually-relevant fact | Chunking, embedding, or query mismatch — the right content was never retrieved |
| Generation failure | Answer contradicts or ignores a clearly-retrieved, relevant chunk | Prompt issue, lost-in-the-middle, or model just getting it wrong |
| Stale index | Answer cites outdated information confidently | Ingestion pipeline not re-run, or cache not invalidated |
| Silent over-refusal | System says "not found" for genuinely answerable questions | Relevance threshold set too high, or query rewriting degrading the query |
| Latency spike | Slow responses under load | Reranker or generation model saturated; check queueing, not just per-request latency |

## Cheat sheet

- RAG has two halves: offline ingestion (not latency-sensitive) and online query (where your budget and failures live).
- RAG changes *what* a model knows; fine-tuning changes *how* it behaves — pick based on which problem you actually have.
- Order assembled context by relevance, most-important closest to the question, to counter lost-in-the-middle.
- Citations must be verified, not just requested — a model can cite a source that doesn't support the claim.
- "I don't know" needs an explicit relevance threshold and an explicit instruction — it won't happen by default.
- Query rewriting and multi-query cost an extra model call — use them where eval data shows retrieval recall needs it.
- Cache at the embedding, retrieval, and full-response layers, each with a different freshness/complexity trade-off.
- Reranking and generation usually dominate latency, not the vector search — profile before optimising the index.
- Diagnose failures by asking "was the right chunk retrieved at all" before blaming the generator.

## Common mistakes

| Mistake | Fix |
|---|---|
| Treating ingestion and query-path latency as the same concern | Budget and monitor them separately; only query path is user-facing latency |
| Assembling context in retrieval-score order without considering position | Put the most relevant chunk closest to the question |
| Trusting model-generated citations at face value | Add a verification step, or treat citations as a UX aid only |
| No explicit relevance threshold for "not found" | Add one, and test it against genuinely unanswerable questions |
| Applying query rewriting/multi-query everywhere by default | Apply where eval data shows recall is actually hurting from query phrasing |
| Optimising the vector index when generation/reranking dominate latency | Profile the full request first, optimise the actual bottleneck |

## Summary

RAG is a two-part pipeline — an offline ingest/index path and an online retrieve/generate path — and most of the engineering difficulty lives in the online half: assembling context that counters lost-in-the-middle, grounding and verifying citations, and deciding when to say "I don't know" instead of guessing. Compared to fine-tuning, RAG wins on freshness, cost of updates, and attribution, which is why it's the default for knowledge-grounded features, while fine-tuning remains the right tool for shaping behavior or style. When something goes wrong, the first diagnostic question is always whether the right content was retrieved at all — that single split (retrieval vs. generation failure) is the fastest path to a fix.

## Top Interview Questions

### Q1. Walk me through the full RAG pipeline, end to end.

RAG splits into an offline ingestion path and an online query path. Ingestion runs whenever source content changes: documents are parsed, chunked, embedded, and written into a vector index — this isn't latency-sensitive since it's not tied to a live user request. The query path runs on every request: the user's query is optionally rewritten or expanded, embedded, used to retrieve the top-k candidate chunks from the index, those candidates are optionally reranked for relevance, the highest-relevance chunks are assembled into a prompt (ordered to counter lost-in-the-middle), the model generates an answer grounded in that context, and citations are attached mapping claims back to source chunks. Naming both halves and where the latency/failure risk actually sits (the query path) is the key structural answer.

### Q2. When would you choose RAG over fine-tuning, and when is it the other way around?

RAG is the right choice when the requirement is about *knowledge*: the answer needs to reflect facts that change over time, needs to be traceable to a source (citation/attribution), or covers more content than would fit reasonably in a fine-tuning dataset. Fine-tuning is the right choice when the requirement is about *behavior*: a consistent tone or persona, a specific output format you don't want to keep re-specifying in every prompt, or domain-specific reasoning patterns baked in so you don't pay the token cost of examples every call. The clean mental model: RAG changes what the model knows, fine-tuning changes how it behaves — and fine-tuning cannot provide attribution, since facts get compressed into weights with no traceable origin, which rules it out entirely for anything requiring citations.

### Q3. What is "lost in the middle" and how does it change how you assemble RAG context?

It's the empirically observed effect where models are less reliable at using information placed in the middle of a long context than information near the start or end, even when everything fits within the context window. In a RAG pipeline, if you simply insert retrieved chunks in whatever order they came back from the vector search, your most relevant chunk might end up buried in the middle of the assembled context and get under-attended to relative to a less relevant chunk that happened to land at the edges. The practical fix is to explicitly order the assembled context by relevance score, placing the most relevant chunk closest to the actual question (typically at the end, right before the query, since recency is usually the stronger effect), rather than leaving it in arbitrary retrieval order.

### Q4. How do you make a RAG system say "I don't know" instead of hallucinating when retrieval finds nothing relevant?

Two pieces need to work together. First, an explicit relevance threshold on the retrieval or reranking score — if the top retrieved result is below that threshold, treat it as "nothing relevant found" rather than passing weak matches into the prompt anyway. Second, an explicit instruction in the generation prompt telling the model to answer only from the provided context and to say so plainly when the context doesn't contain the answer — without this instruction, most models will still try to be "helpful" by falling back on their own parametric knowledge, which silently defeats the grounding purpose of RAG. I'd validate this behavior with a specific eval set of genuinely unanswerable questions, not just answerable ones, since it's easy to only test the happy path.

### Q5. Why can't you fully trust citations that the model generates for its own answer?

Asking the model to tag claims with source markers is a prompting instruction, not a mechanical guarantee — the model can confidently attach a citation to a chunk that doesn't actually support the specific claim, especially when it's blending information from multiple sources or extrapolating slightly beyond what any single chunk states. Citations generated this way are useful for UX (clickable references) and for debugging, but treating them as a correctness guarantee is a mistake. For higher-stakes use cases, I'd add a verification step after generation — checking embedding similarity between each claim and its cited chunk, or using a smaller/cheaper model to specifically judge "does this chunk support this sentence" — rather than trusting the citation the generator produced on its own.

### Q6. Where does the latency actually go in a RAG request, and what's the most common mistake teams make when optimising it?

In a typical synchronous request: query embedding is fast (tens of milliseconds), vector search over a well-tuned ANN index is also usually fast (tens to low hundreds of milliseconds), but reranking (if using a cross-encoder over dozens of candidates) and generation (especially time-to-first-token for a larger model, plus total tokens generated) usually dominate the overall budget, often by an order of magnitude. The common mistake is spending optimisation effort on the vector index — tuning HNSW parameters, adding caching — when the real bottleneck is the reranker or the generation model. The fix is to actually instrument and profile each stage of the pipeline before optimising, rather than assuming the vector search is the bottleneck because it's the most "database-shaped" part of the system.

### Q7. A user says a RAG-powered answer is wrong. How do you determine whether it's a retrieval failure or a generation failure?

I'd log and inspect the actual chunks that were retrieved and passed to the generator for that specific query. If none of the retrieved chunks actually contain the correct information, that's a retrieval failure — the problem is upstream, in chunking, embedding, indexing, or query phrasing, and no prompt tuning will fix it since the model was never given the right material. If the correct information *was* present in the retrieved context but the model's answer contradicts or ignores it, that's a generation failure — worth investigating lost-in-the-middle positioning, prompt clarity about using only the provided context, or simply the model reasoning incorrectly over the material. This single diagnostic split is the highest-leverage debugging skill in RAG, because the two failure modes have completely different fixes and conflating them wastes time tuning the wrong layer.

### Q8. How would you decide whether to add a query-rewriting step to a RAG pipeline?

I'd look at real failure cases from an eval set or production logs first: if a meaningful fraction of retrieval misses are traceable to poor query phrasing — short or ambiguous queries, unresolved pronouns referring to earlier conversation turns, vocabulary mismatch between how users phrase questions and how source documents are written — that's evidence query rewriting or expansion would help. I wouldn't apply it by default everywhere, because it adds an extra model call before retrieval even starts, incurring real latency and cost on every single request regardless of whether that particular query needed it. The right framing for an interview: query rewriting is a targeted fix for a measured recall problem, not a blanket "best practice" to bolt onto every pipeline.

### Q9. How do you handle conversation history in a multi-turn RAG system?

The core problem is that "the query" isn't well-defined across multiple turns — a follow-up message like "what about the enterprise plan?" only makes sense combined with what was discussed previously. The common pattern is to use a cheap model call to condense the conversation history plus the latest message into a single standalone query that resolves references and ambiguity (turning "what about the enterprise one" into something like "what is included in the enterprise plan"), and then run retrieval against that standalone query rather than the raw last message alone. This adds one extra model call to the pipeline but meaningfully improves retrieval quality for any conversational (as opposed to single-shot Q&A) RAG experience.

### Q10. What caching strategies apply to a RAG pipeline, and what's the risk of caching full responses?

There are several natural caching layers: embedding caches for repeated or similar queries (skip re-embedding), retrieval caches for a given query-plus-filter combination (skip the vector search), and full-response caches for exact or near-duplicate queries (skip the entire pipeline, the biggest latency win). The risk with full-response caching is staleness — if the underlying source documents change and the cache isn't invalidated or versioned, users can silently receive confidently wrong, outdated answers with no visible sign anything is wrong. The mitigation is to key the cache on both the query and a content-version marker (so a document update invalidates related cache entries) and set a TTL that reflects how frequently the underlying corpus actually changes, rather than an arbitrarily long cache lifetime chosen purely for cost savings.

### Q11. Your RAG system's answers are technically well-grounded in retrieved content but users still complain the answers are unhelpful. What might be going wrong outside of retrieval and generation quality?

This is worth separating from the usual retrieval-vs-generation split, since both may be working "correctly" by their own narrow measures. Common causes: chunks are too fragmented, so even correct, well-cited answers feel disjointed and lack the narrative flow a human answer would have (a chunking/parent-document-retrieval problem); the relevance threshold for refusing to answer is miscalibrated, so the system frequently says "not found" for questions it should be able to answer (an over-refusal problem); or the assembled context includes the right facts but in a jumbled, non-narrative order that produces a technically-correct but hard-to-follow answer (a context assembly problem). This case argues for treating "helpfulness" as its own eval dimension, separate from strict factual grounding, since a technically grounded answer can still fail the user's actual need.

### Q12. How would you set up a latency and cost budget for a new RAG feature before building it?

I'd start by listing every stage that runs synchronously per request (query rewrite if used, embedding, vector search, reranking if used, generation) and get a realistic per-stage latency and cost estimate, either from vendor benchmarks or a quick prototype, then sum them against the product's actual latency requirement (e.g. a chat UI needs low TTFT more than low total time, a backend batch job cares more about total cost per request than latency). I'd specifically flag reranking and generation as the stages most likely to dominate both cost and latency, and decide upfront whether each optional stage (rewriting, reranking) earns its cost based on expected quality lift — not add every possible RAG enhancement by default and discover the latency/cost problem after launch.
