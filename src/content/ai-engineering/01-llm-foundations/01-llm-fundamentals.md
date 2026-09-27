---
title: LLM Fundamentals
description: How tokens, context windows and sampling actually work under the hood, and why that explains cost, latency and hallucination in production
difficulty: Foundational
tags: [llm, tokens, sampling, latency]
---

Before you can design an LLM feature you need a working mental model of what happens between "send prompt" and "receive text". This page covers the mechanics interviewers expect a backend engineer to know cold: tokens, context windows, sampling and the latency shape of a request.

## Tokens, not words

Models don't see words or characters — they see **tokens**, sub-word units produced by a tokeniser (BPE-style for most GPT-family models). A token is roughly 4 characters or ¾ of an English word on average, but this varies wildly by language and content.

| Text | Approx. tokens | Note |
|---|---|---|
| `"hello"` | 1 | Common word, single token |
| `"unbelievable"` | 3–4 | Split into sub-words |
| `"东京"` (Tokyo, Japanese) | 2–4 | Non-English is far less token-efficient |
| A UUID or hash | 10–20 | High-entropy strings tokenise poorly |
| 1,000 English words | ~1,300 tokens | Rule of thumb: words × 1.3 |

> [!KEY]
> Billing, rate limits and context limits are all measured in **tokens**, not characters or words. A prompt that "looks small" in a code editor can be expensive if it's full of JSON, code or non-English text — all of which tokenise less efficiently than prose.

This directly drives cost: if input tokens cost $3/million and output tokens cost $15/million, a request with a 4,000-token retrieved context and a 200-token answer costs mostly on the input side. Trimming unnecessary context (boilerplate, repeated system prompts) is a real cost lever, not a micro-optimisation.

## The context window

The context window is the maximum number of tokens the model can attend to in one call — input **and** output combined. Everything the model "knows" for this request must fit inside it:

- The system prompt (instructions, persona, tool schemas)
- Conversation history (previous turns)
- Retrieved documents (in a RAG system)
- The current user message
- Room left over for the output

```mermaid
flowchart TD
    A["Context window budget<br/>e.g. 128k tokens"] --> B["System prompt + tool schemas"]
    A --> C["Conversation history"]
    A --> D["Retrieved documents"]
    A --> E["Current user message"]
    A --> F["Reserved for output tokens"]
```

> [!WARNING]
> A bigger context window is not free performance. Models exhibit "lost in the middle" behavior — information placed in the middle of a long context is recalled less reliably than information at the start or end. Don't treat a 200k window as a reason to skip retrieval quality work.

## Next-token prediction and hallucination

An LLM is trained to predict the single most probable next token given everything before it, one token at a time. There is no separate "fact-checking" step — the model is a probability distribution over its vocabulary conditioned on context, sampled repeatedly.

This is why hallucination is not a bug to be patched away: the model will fluently continue a pattern even when it has no grounding for the specific fact, because fluency and factual correctness are optimized by different (and only loosely correlated) signals during training. It fills gaps with the *statistically plausible* continuation, not the *true* one.

> [!KEY]
> Say this in an interview: "Hallucination isn't a glitch — it's the expected behavior of a next-token predictor with no built-in fact-check. The mitigation is architectural: grounding via retrieval, citations, and constrained output — not hoping the model 'knows better'."

## Sampling: temperature, top-p, top-k

The model produces a probability distribution over the next token; a decoding strategy decides which token to actually pick.

| Parameter | What it does | Typical value | Use when |
|---|---|---|---|
| Temperature | Scales the distribution before sampling — low flattens it towards the top choice, high flattens it towards uniform | 0.0–0.3 | Deterministic tasks: extraction, classification, code generation, tool-call arguments |
| Temperature | Higher values increase randomness | 0.7–1.0 | Creative writing, brainstorming, varied chat responses |
| Top-p (nucleus) | Sample only from the smallest set of tokens whose cumulative probability ≥ p | 0.9–0.95 | General default; adapts vocabulary size to confidence |
| Top-k | Sample only from the k most probable tokens | 40–100 | Blunter cutoff, less common in modern APIs |
| Temperature = 0 | Effectively greedy decoding (always pick the top token) | — | Structured output, tool calling, reproducible tests |

> [!TIP]
> For anything with a "correct" answer — JSON extraction, SQL generation, classification — set temperature near 0. Save higher temperature for genuinely open-ended generation. Mixing these up is a common junior mistake that shows up as flaky structured output.

## Roles: system, user, assistant

Chat models are trained on a three-role conversation format:

- **System** — instructions, persona, constraints, tool definitions. Set once, highest priority.
- **User** — the human's input for this turn.
- **Assistant** — the model's own prior responses, fed back in for multi-turn context.

> [!DANGER]
> The system prompt is a strong prior, not a hard security boundary. A user can still write text in their message that competes with or contradicts system instructions ("prompt injection"). Never rely on the system role alone to enforce a security-critical rule — validate untrusted output server-side too.

## Stop sequences, max tokens, determinism

- **`max_tokens`** caps the length of the generated output — a hard budget control and a safety net against runaway generations.
- **Stop sequences** tell the API to halt generation the instant a given string appears (e.g. `"\n\n"`, `"</answer>"`) — cheaper than generating extra tokens and parsing them out.
- **Seeds**: some APIs accept a `seed` parameter for reproducibility. Combined with `temperature=0`, this gets you close to deterministic output — but not guaranteed identical across model versions or under load, because floating-point non-determinism and backend batching can still cause tiny variations.

## Streaming and latency shape

Two latency numbers matter, and they are not the same thing:

| Metric | What it measures | Why it matters |
|---|---|---|
| Time to first token (TTFT) | Delay before the first token arrives | Determines perceived responsiveness — this is what "feels slow" |
| Tokens per second (TPS) | Generation throughput once streaming starts | Determines how long a long answer takes to fully render |

Streaming (server-sent events / chunked responses) sends tokens as they're generated instead of waiting for the full response, which improves perceived latency even though total generation time is unchanged. For a chat UI, always stream. For a backend job that needs the full structured output before doing anything with it, streaming adds complexity for no benefit — buffer the whole response instead.

```mermaid
sequenceDiagram
    participant Client
    participant API as "LLM API"
    Client->>API: "POST /chat/completions (stream=true)"
    API-->>Client: "token 1 (TTFT)"
    API-->>Client: "token 2"
    API-->>Client: "token 3 ..."
    API-->>Client: "[DONE]"
```

## Model size, capability and cost trade-off

| Tier | Example use | Latency | Cost | When to pick it |
|---|---|---|---|---|
| Small / fast | Classification, extraction, routing | Low (TTFT < 300ms) | Low | High volume, latency-sensitive, well-defined task |
| Mid-size | General chat, summarisation, RAG answers | Medium | Medium | Default choice for most product features |
| Large / frontier | Complex reasoning, agents, code generation | Higher | High | Task genuinely needs the extra capability — validate with an eval, don't assume |

> [!TIP]
> A senior answer names the trade-off explicitly: "I'd start with the smallest model that passes our eval set, because cost and latency scale roughly linearly with model size and most product features don't need frontier-level reasoning." Interviewers want to hear that you don't default to the biggest model out of caution.

## Cheat sheet

- Tokens ≈ ¾ word for English; billing and limits are always token-based, not word-based.
- Context window = system + history + retrieved context + user message + output budget — it's shared, not per-field.
- Hallucination is architecturally expected from next-token prediction — mitigate with grounding, not hope.
- Temperature near 0 for deterministic/structured tasks; higher for open-ended generation.
- `max_tokens` and stop sequences are cost and safety controls, not just formatting tools.
- TTFT (responsiveness) and TPS (throughput) are different metrics — measure both.
- Stream for interactive UIs; buffer for backend jobs needing the full structured output.
- Pick the smallest model that passes your eval set, not the largest available.

## Common mistakes

| Mistake | Fix |
|---|---|
| Estimating cost/limits in words or characters | Always estimate and test in tokens |
| Using high temperature for extraction/classification tasks | Set temperature to 0 for anything with a "correct" answer |
| Assuming seed + temperature=0 gives byte-identical output every time | Treat it as "close to deterministic", not guaranteed |
| Stuffing the context window because "it's big enough" | Curate context — lost-in-the-middle degrades quality regardless of window size |
| Treating the system prompt as a security boundary | Add server-side validation for anything security-critical |
| Not streaming a chat UI | Stream for perceived latency; users tolerate slower TPS if TTFT is fast |

## Summary

An LLM call is bounded by tokens, not words, and everything — cost, limits, latency — is measured in that unit. The model is a next-token predictor operating inside a fixed context window, which explains both why it hallucinates and why "just add more context" isn't a free win. Sampling parameters (temperature, top-p) trade determinism for creativity, and the two latency metrics (TTFT, TPS) map to different product concerns. Knowing these mechanics lets you reason about cost and reliability instead of treating the model as an opaque black box.

## Top Interview Questions

### Q1. Why do token counts differ from word counts, and why does that matter for cost?

Tokenisers split text into sub-word units (commonly Byte-Pair Encoding), not whole words. Common English words are usually one token, but rarer words split into 2–4 sub-word pieces, and non-English text, code, JSON and high-entropy strings (UUIDs, hashes) tokenise far less efficiently — sometimes 1 token per character. Since API pricing and context limits are denominated in tokens, a request that "looks short" in characters can be expensive if it's dense with structured data or a non-English language. In production, you should measure actual token counts with the vendor's tokenizer library during testing rather than estimating from word counts, especially before setting hard budget or context-limit alerts.

### Q2. What fills the context window in a real production LLM call?

Five things share the same budget: the system prompt (instructions, persona, tool/function schemas), conversation history from prior turns, any retrieved documents (in a RAG system), the current user message, and reserved headroom for the output tokens. If you don't explicitly budget these, retrieved context or long history can silently crowd out room for the answer, causing truncated or refused output. A senior answer mentions actively managing this budget: truncating or summarising history, trimming retrieved chunks to only the most relevant, and reserving a fixed `max_tokens` for output rather than discovering the overflow at runtime.

### Q3. Why do LLMs hallucinate, and how do you mitigate it in an engineering sense?

LLMs are trained to predict the statistically most likely next token given prior context — there's no built-in fact-checking step, so when the model lacks grounding for a specific fact it fluently generates the most plausible-sounding continuation rather than admitting uncertainty. This is architectural, not a bug you can prompt your way out of entirely. Practical mitigations: ground answers in retrieved source documents (RAG) and require citations, constrain output format so falsifiable claims are easier to verify, lower temperature for factual tasks, and explicitly instruct (and test) that the model should say "I don't know" when retrieval returns nothing relevant.

### Q4. When would you use temperature 0 versus a higher temperature?

Use temperature 0 (or very close to it) whenever there's a single correct or preferred answer: structured data extraction, classification, tool-call argument generation, code generation, SQL generation — anywhere consistency and reproducibility matter more than variety. Use a higher temperature (0.7–1.0) for genuinely open-ended generation: brainstorming, creative writing, varied conversational tone. Mixing these up is a common bug source — teams sometimes leave a default 0.7 temperature on a classification endpoint and then see flaky, inconsistent labels for what should be a deterministic decision.

### Q5. What is the difference between top-p and top-k sampling?

Both restrict the pool of tokens the model can sample from after temperature scaling, but they use different criteria. Top-k keeps only the k highest-probability tokens regardless of how confident the model is — a fixed-size cutoff. Top-p (nucleus sampling) instead keeps the smallest set of tokens whose cumulative probability reaches a threshold p, so the pool size adapts: when the model is very confident, the nucleus might be just 2–3 tokens; when it's uncertain, it might be dozens. Top-p is generally preferred in modern APIs because it self-adjusts to model confidence rather than using an arbitrary fixed count.

### Q6. What's the difference between time to first token and tokens per second, and why track both?

TTFT measures the delay before the first output token arrives — dominated by prompt processing (which scales with input length) and queueing/network overhead. TPS measures the steady-state generation rate once streaming has started — dominated by model size and decoding hardware. A feature can have excellent TTFT but slow TPS (feels responsive but takes forever to finish a long answer), or the reverse (fast overall but a noticeable initial pause). For a chat UI you optimise for low TTFT since users perceive that as "responsiveness"; for batch summarisation of long documents you care more about TPS since total completion time dominates the experience.

### Q7. Your team wants fully reproducible LLM output for automated tests. How close can you actually get?

Set temperature to 0 (or as close as the API allows) and pass a fixed `seed` if the API supports one — this removes most sampling randomness by always picking the highest-probability token. However, you generally cannot guarantee byte-identical output across calls: floating-point non-associativity in batched GPU inference, backend load-balancing across slightly different hardware, and model version updates can all introduce small variations. In practice, for automated tests you should assert on structural properties (valid JSON, expected fields present, key facts correct) rather than exact string equality, and pin the model version explicitly rather than using a "latest" alias.

### Q8. A user reports the chat feature "freezes" for 8 seconds before responding, even though total response time is normal. What would you investigate?

This points to a TTFT problem, not a TPS problem — the model is generating fine once it starts, but something delays the first token. I'd check: is the response being streamed at all, or is the backend buffering the full completion before forwarding it to the client (very common bug — proxies and API gateways sometimes buffer SSE by default)? Is the prompt unusually large (long context takes longer to process before generation starts)? Is there a queueing delay upstream (rate limiting, cold start, retries)? I'd add explicit TTFT instrumentation separate from total latency to confirm where the 8 seconds actually goes before guessing.

### Q9. How do you decide between a small/fast model and a large/frontier model for a given feature?

Start from an eval set representative of the real task, then test the smallest/cheapest model that clears your quality bar — don't default to the largest model out of caution, since cost and latency scale with model size and most product features (classification, extraction, routing, simple summarisation) don't need frontier-level reasoning. Reserve larger models for tasks that genuinely require multi-step reasoning, ambiguous instructions, or high-stakes accuracy. It's also common to mix tiers in one product: a small model for high-volume routing/classification and a large model only for the subset of requests that need deep reasoning.

### Q10. Why can increasing the context window size still hurt quality even though the model can technically fit more information?

This is the "lost in the middle" effect: models are empirically more reliable at using information near the start or end of the context than information buried in the middle, even when everything technically fits within the window. So dumping in more retrieved documents "because there's room" can dilute the model's attention and reduce answer quality, as well as increasing cost and latency. The fix is architectural, not just "use a bigger window": rank and filter retrieved context aggressively, put the most relevant material closest to the question, and treat window size as a ceiling, not a target to fill.

### Q11. What's the practical difference between max_tokens and a stop sequence?

`max_tokens` is a hard length cap on the output — the API truncates generation once that many tokens are produced, regardless of whether the response is complete; it's your safety net against runaway cost and unbounded responses. A stop sequence is a specific string that, once generated, causes the API to halt immediately — useful when you know the exact boundary of what you want (e.g. stopping at `"\n\nUser:"` in a completion-style chat loop, or `</answer>` in a structured template). You typically use both together: stop sequences for precise, cheap early termination on expected boundaries, and `max_tokens` as the backstop for cases where the model runs on longer than expected.

### Q12. Why might the same prompt produce different answers on two separate calls even at temperature 0?

Temperature 0 makes sampling deterministic in theory (always pick the highest-probability token), but in practice most inference backends batch multiple requests together on the same GPU for efficiency, and floating-point arithmetic is not strictly associative — the exact numerical result for one request can vary slightly depending on what other requests are batched alongside it. This can occasionally flip which token has the (very marginally) higher probability. It's also possible the provider silently updated the underlying model weights or serving stack between calls. The practical takeaway: treat temperature 0 as "highly consistent", not "cryptographically deterministic", and design tests/evals that tolerate small variation rather than assuming exact reproducibility.
