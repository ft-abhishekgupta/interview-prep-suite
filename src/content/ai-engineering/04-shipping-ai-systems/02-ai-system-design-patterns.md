---
title: AI System Design Patterns
description: A practical catalogue of the recurring patterns used to build production LLM applications, with the trade-off each one is actually making
difficulty: Advanced
tags: [system-design, llm, patterns, architecture, cost]
---

Most LLM system design questions are really asking you to recognise which of a small set of recurring patterns fits the problem, and to name the trade-off it makes. This page is a catalogue you can pull from directly in a design interview.

## Control-Flow Patterns

**Router / classifier front door**: a cheap, fast classification step (often a small model or even a non-LLM classifier) decides which specialised prompt, model, or downstream system handles a request, instead of one generic prompt trying to handle everything.

**Prompt chaining**: break one complex task into an explicit sequence of smaller LLM calls, each with a focused prompt, where step N's output feeds step N+1 — trades latency and cost for reliability, since each step is easier to get right and easier to validate in isolation.

**Parallelisation with voting**: run the same task through multiple calls (different prompts, temperatures, or models) and combine results by majority vote or an aggregator — improves reliability on tasks with a single correct answer by averaging out individual-call variance, at N times the cost.

```mermaid
flowchart LR
    Req["Request"] --> Cls["Classifier"]
    Cls -->|"simple"| M1["Small/cheap model"]
    Cls -->|"complex"| M2["Large model"]
    Cls -->|"needs data"| M3["RAG pipeline"]
```

**Evaluator-optimiser loop**: one call generates a candidate, a second call (or a deterministic check) evaluates it against criteria, and generation is retried with the critique fed back in until it passes or a retry budget is hit — trades latency for measurably higher quality on tasks where "good" is checkable.

```mermaid
flowchart LR
    G["Generator"] --> E{"Evaluator:<br/>passes?"}
    E -->|"no, with feedback"| G
    E -->|"yes"| Out["Final output"]
```

> [!KEY]
> Every control-flow pattern trades cost/latency for reliability in a specific, nameable way. The interview answer that scores well says which axis you're trading and why the task justifies it — not just "we added an evaluator step."

## Knowledge and Action Patterns

**Retrieval augmentation (RAG)**: fetch relevant external documents at query time and place them in context, so the model answers from current, specific data instead of only its training knowledge — trades an extra retrieval hop (latency, infra) for grounding and freshness.

**Tool use / function calling**: let the model invoke external functions (a calculator, a database query, a live API) rather than trying to compute or recall the answer itself — trades a round trip per tool call for correctness on anything the model cannot reliably do purely by generating text (arithmetic, live data, side effects).

**Human-in-the-loop**: insert an approval or correction step before a high-stakes action executes, or route low-confidence outputs to a human reviewer — trades throughput and full automation for a safety net on the cases most likely to be wrong or costly.

**Cascade (cheap model first, escalate)**: try a cheap, fast model first; only call a more expensive model when the cheap one's confidence is low or a check fails — trades a small latency tax on the escalated fraction for a large average cost reduction across the whole traffic mix.

> [!TIP]
> Cascades are one of the highest-leverage cost patterns in production because typical traffic is skewed easy: if 80% of requests are solvable by a model costing 10x less, a cascade with reliable escalation can cut blended cost by roughly 70% with almost no quality loss, since only the hard 20% ever reach the expensive model.

## Performance and Cost Patterns

**Semantic caching**: cache responses keyed by embedding similarity rather than exact string match, so paraphrased-but-equivalent requests hit the cache — trades a small risk of returning a stale or slightly-off-topic cached answer for large latency and cost savings on repetitive query patterns.

**Batch / async processing**: for non-interactive work (bulk classification, report generation, embedding a corpus), queue requests and process them off the request path, often via a provider's batch API at a discount — trades immediacy for cost and throughput.

**Streaming**: return tokens as they are generated instead of waiting for the full response — does not reduce total latency, but reduces *perceived* latency to first-token time, which is what users actually notice.

**Fallback to a smaller/older model**: when the primary model is unavailable, over capacity, or too slow, degrade gracefully to a weaker but available model rather than failing the request outright — trades some quality for availability.

**Circuit breaking on a provider**: stop sending traffic to a failing or degraded provider after an error-rate threshold trips, instead of letting every request time out individually — trades a window of reduced capability (routed elsewhere or to a fallback) for protecting overall system latency and avoiding cascading failure.

## Operational Patterns

Production LLM systems need the same operational discipline as any other distributed system, applied to token-metered, provider-dependent calls specifically:

- **Rate-limit and quota management**: track usage against provider-imposed and self-imposed limits per key/tenant, queue or shed load gracefully rather than returning raw 429s to end users.
- **Cost controls and token budgets**: cap tokens per request and per user/session, alert on spend anomalies, and treat "max tokens" as a product decision, not just a technical ceiling.
- **PII handling**: redact or tokenise sensitive fields before they reach a third-party model provider, and again before they hit logs or traces — two separate redaction points, often missed.
- **Observability for LLM calls**: log prompt, model/version, token counts, latency, and cost for every call, correlated by request ID, so a quality regression or cost spike is traceable to a specific change.

> [!WARNING]
> PII redaction before the *model call* and redaction before *logging* are different controls that are easy to conflate. A team that redacts prompts before sending to a provider but still logs the raw, unredacted request for debugging has only solved half the problem — the data still ends up in an internal store it may not be authorized to sit in.

## The Pattern Catalogue

| Pattern | Problem it solves | Trade-off |
|---|---|---|
| Router / classifier front door | One generic prompt can't handle a heterogeneous request mix well | Extra classification hop; misclassification routes to the wrong handler |
| Prompt chaining | A complex task is unreliable as one big prompt | More latency and cost; errors can still compound across steps |
| Parallelisation with voting | Single-call variance causes inconsistent answers | N times the cost for a reliability gain |
| Evaluator-optimiser loop | No mechanism to catch and fix a bad generation before it ships | Extra latency per retry; needs a reliable evaluator |
| Retrieval augmentation | Model lacks current or private knowledge | Retrieval quality becomes a new failure surface |
| Tool use | Model can't reliably compute, fetch live data, or act | Tool-call failures and argument correctness become new risks |
| Human-in-the-loop | Some outputs are too high-stakes to fully automate | Slower, needs reviewer capacity, doesn't scale to all traffic |
| Cascade | Most traffic is easy but a flat expensive model is used for all of it | Escalation logic must be reliable or errors slip through cheaply |
| Semantic caching | Repeated/paraphrased queries pay full cost every time | Risk of a stale or near-miss cached answer |
| Batch / async processing | Interactive-priced compute wasted on non-interactive work | Not usable where a user is waiting synchronously |
| Streaming | Full-response wait feels slow even if total time is fine | Doesn't reduce total cost or total latency, only perceived latency |
| Fallback to smaller/older model | Primary model outage or overload breaks the whole feature | Degraded quality during fallback |
| Circuit breaking on a provider | Cascading failure when one provider degrades | Temporary capability loss while the breaker is open |
| Rate-limit / quota management | Noisy tenants or bursts exhaust shared capacity | Requires careful UX for queuing/shedding, not just hard rejection |
| Cost controls / token budgets | Unbounded spend from long prompts, loops, or verbose output | Overly tight budgets truncate legitimate long-context tasks |
| PII handling | Sensitive data reaching a third party or an internal log | Redaction can degrade context the model needed |
| Observability for LLM calls | Quality or cost regressions are undiagnosable without call-level data | Storage cost and privacy handling for full trace logs |

## Cheat sheet

- Every pattern trades one thing (cost, latency, complexity) for another (reliability, freshness, safety) — name the trade explicitly.
- Router → cheap dispatch; chaining → reliability via smaller steps; voting → reliability via redundancy; evaluator-optimiser → reliability via a checked retry.
- RAG for freshness/private data; tool use for anything the model can't compute or fetch itself; human-in-the-loop for high-stakes cases.
- Cascades are the single highest-leverage cost pattern when traffic skews easy.
- Streaming improves perceived latency only — it does not reduce total cost or total compute time.
- Circuit breakers and fallbacks are what keep one provider's bad day from becoming your outage.
- Redact PII twice: once before the model call, once before logging — they are separate controls.
- Observability (prompt, tokens, latency, cost, per request ID) is what makes every other pattern debuggable in production.

## Common mistakes

| Mistake | Fix |
|---|---|
| Using one large model/prompt for every request regardless of difficulty | Add a router or cascade to match cost to actual task difficulty |
| Treating streaming as a cost or latency optimisation | It only improves perceived latency; budget and total time unchanged |
| Caching only on exact string match | Use semantic/embedding-based caching for paraphrase hits |
| No fallback when the primary model or provider is down | Add a circuit breaker and a smaller/older-model fallback path |
| Redacting PII only before the model call | Redact again before logging/tracing — separate control, separate risk |
| No token or cost budget per request | Cap tokens per request/session and alert on spend anomalies |
| Human review on every output "to be safe" | Route only low-confidence or high-stakes cases to a human |
| No per-call logging of prompt, tokens, latency, cost | Add call-level observability correlated by request ID before shipping |

## Summary

These patterns are the standard vocabulary for LLM system design: control-flow patterns (router, chaining, voting, evaluator-optimiser) trade cost and latency for reliability; knowledge and action patterns (RAG, tool use, human-in-the-loop, cascades) extend what a model can know or do safely; performance patterns (caching, batching, streaming, fallback, circuit breaking) protect latency, cost and availability; and operational patterns (rate limits, budgets, PII handling, observability) are what make the whole system safe to run at scale. A strong design answer picks the smallest set of patterns that solves the actual problem, and states the specific trade-off each one makes rather than listing them as unconditional wins.

## Top Interview Questions

### Q1. When would you use a router/classifier pattern instead of one general-purpose prompt?

Use a router when requests are genuinely heterogeneous and a single prompt would have to be so general it performs worse on all categories than a specialised prompt would on each — for example, a support system fielding billing questions, technical troubleshooting, and account changes benefits from routing each to a purpose-built prompt or even a different model sized to the task's difficulty. The router itself should be cheap and fast, often a small model or even a lightweight classifier, since it runs on every request and its cost is pure overhead if the downstream handling is uniform anyway. The trade-off to name explicitly: you've added a classification hop and a new failure mode (misrouting), in exchange for each downstream handler being simpler, cheaper, and more accurate at its specific job.

### Q2. Explain the cascade pattern and quantify why it saves cost.

A cascade tries a cheap, fast model first and only escalates to a more expensive model when the cheap model's output fails a confidence check or an explicit validation — the insight is that most production traffic is disproportionately easy, so paying premium-model cost for every request wastes money on requests that didn't need it. If 80% of traffic is solvable by a model costing a tenth as much, and only the remaining 20% escalates, blended cost is roughly 0.8×(0.1×base) + 0.2×(1×base) ≈ 0.28×base — about a 70% reduction versus routing everything to the expensive model, at the cost of slightly higher latency on the escalated fraction. The design risk is entirely in the escalation check: if it under-escalates, low-quality answers ship silently at the cheap model's error rate; the check needs to be validated against real failure cases, not assumed reliable.

### Q3. What is the difference between prompt chaining and an evaluator-optimiser loop, and when would you pick one over the other?

Prompt chaining is a fixed, one-directional sequence — step 2 always runs after step 1, regardless of how good step 1's output was — used when a task naturally decomposes into ordered subtasks, like "extract entities, then summarise, then format." An evaluator-optimiser loop is conditional and can repeat: a generator produces a candidate, an evaluator checks it against explicit criteria, and if it fails, the generator retries with the evaluator's feedback, continuing until it passes or a retry budget is exhausted. Use chaining when each step is independently reliable and doesn't need a check before the next step proceeds; use an evaluator-optimiser loop when a step's output quality is variable and checkable, and getting it right matters enough to justify the extra latency of possible retries.

### Q4. Why does streaming not actually reduce cost or total latency, and why do teams add it anyway?

Streaming returns generated tokens incrementally as they're produced instead of waiting for the full response to complete before sending anything back — the total time to generate all tokens and the total compute cost are unchanged, since the same number of tokens still has to be generated either way. What streaming changes is perceived latency: the user sees the first token in a few hundred milliseconds instead of waiting the full multi-second generation time, which is what users actually judge responsiveness by, especially for longer responses. Teams add it because perceived responsiveness measurably affects user satisfaction and task abandonment rates even when the underlying system is doing exactly the same amount of work in exactly the same amount of time.

### Q5. Describe a scenario where you'd add human-in-the-loop, and how you'd decide which fraction of traffic needs it.

I'd add a human-in-the-loop step for actions that are both high-stakes and hard to reverse, or for outputs the system itself flags as low-confidence — for example, an agent approving refunds above a dollar threshold, or a content system whose classifier score falls in an ambiguous middle band rather than confidently safe or confidently violating. The fraction routed to a human should be small and specifically the highest-risk or highest-uncertainty slice, decided by a measurable threshold (confidence score, dollar amount, policy category) rather than "when it feels risky" — routing everything to a human defeats the purpose of automating the system at all, and routing nothing removes the safety net the pattern exists to provide. I'd also monitor the human-reviewed fraction's actual error/override rate to check the threshold is calibrated correctly over time.

### Q6. Your system uses semantic caching and a user reports getting an answer to a slightly different question than they asked. What went wrong and how would you fix it?

Semantic caching keys on embedding similarity rather than exact match, so it will occasionally return a cached answer for a query that's similar but not equivalent — the similarity threshold was likely set too loose, treating "what's my refund policy" and "what's my return policy" as close enough when the underlying answers actually differ. I'd tighten the similarity threshold, add a secondary check (keyword overlap or an entity match) before serving a cache hit rather than relying on embedding distance alone, and importantly, only cache for query classes where a near-miss is low-stakes — factual FAQ-style answers are safer to cache than anything involving specific account state or recent data, since caching there risks returning stale or subtly wrong information regardless of similarity threshold tuning.

### Q7. Why do you need both a fallback model and a circuit breaker, rather than just one of the two?

A circuit breaker detects that a provider is failing or degraded (elevated error rate, elevated latency) and stops sending it traffic, which protects your system from cascading failure — every request timing out individually against a dead provider is worse than failing fast — but on its own, tripping the breaker doesn't decide what happens to the requests that would have gone there. The fallback model is what those requests actually get routed to instead, so the feature degrades gracefully (a weaker but available model) rather than failing outright. Without the breaker, you keep sending requests to a failing provider and eating full timeout latency on every one; without the fallback, tripping the breaker just converts provider failures into outright request failures instead of degraded-but-working responses.

### Q8. How would you design cost controls and token budgets for a customer-facing LLM feature at scale?

I'd cap max tokens per request at the smallest value that still covers legitimate use cases, since verbose responses cost proportionally more and rarely add value beyond a point, and separately cap total tokens per user session to prevent runaway conversation growth in a multi-turn feature. I'd track spend per tenant/customer against a budget and alert (or throttle) on anomalies rather than discovering a cost spike at the end of the billing cycle, and if the feature includes any agentic loop, cap steps and total tokens per task explicitly rather than trusting the model to stop on its own. I'd also treat "max tokens" as a product conversation, not purely an engineering one — a support-summary feature and a long-form document generation feature have very different legitimate token needs, and a one-size cap will either waste money or truncate real use cases.

### Q9. Where in an LLM pipeline should PII redaction happen, and why is "redact before sending to the model" not sufficient on its own?

PII redaction needs to happen at two separate points: before the prompt is sent to a model provider (especially a third-party one, where the data leaves your infrastructure's trust boundary), and again before anything — the prompt, the retrieved context, the model's response — is written to logs, traces, or an eval dataset. These are separate controls because a team can correctly redact the outbound model call but still write the raw, unredacted request into an internal logging or observability system for debugging purposes, which means the sensitive data still ends up somewhere it may not be authorized to sit, just one hop later than the original risk. A complete design redacts consistently at both boundaries and treats trace/log storage with the same sensitivity classification as the original data source.

### Q10. What would you log for every LLM call in production, and why does this matter more than for a typical stateless API call?

For every call I'd log the exact prompt sent (or a reference to its template plus the variable inputs), the model and version used, input and output token counts, latency, cost, and a request ID that correlates it to the broader trace of retrieval steps or tool calls in the same task. This matters more than for a typical API call because LLM behaviour is non-deterministic and highly sensitive to prompt wording and model version — a quality regression reported by a user cannot be root-caused without seeing exactly what was sent and what came back, and a cost spike cannot be diagnosed without per-call token and cost data broken down by endpoint or feature. Without this, "the model got worse" or "cost went up" are unfalsifiable claims instead of things you can actually investigate.

### Q11. How would you combine multiple patterns from this catalogue to design a cost-efficient, reliable customer support chat feature?

I'd start with a router to classify incoming messages (simple FAQ, account-specific question, escalation-worthy complaint) and send each to the right handler rather than one generic prompt. FAQ-style questions get a cascade — a small model first, escalating only on low confidence — combined with semantic caching, since FAQ phrasing repeats heavily and is low-stakes if a near-miss occurs. Account-specific questions go through retrieval augmentation against the user's actual account data, with tool use for anything requiring a live lookup (order status, balance). Anything the router flags as a complaint or the confidence checks flag as uncertain routes to human-in-the-loop. Underneath all of it: token budgets per conversation, a circuit breaker and fallback model for provider outages, PII redaction on both the outbound calls and the logs, and full call-level observability so any of these layers can be debugged independently.

### Q12. A stakeholder asks "why don't we just always use the best, largest model for everything to guarantee quality?" How do you respond?

I'd frame it as a cost-and-latency-versus-marginal-quality trade-off, not a binary quality question: for the large fraction of requests that are easy, a much cheaper model produces effectively the same answer, so paying premium-model cost on all traffic buys no measurable quality improvement on that fraction while multiplying cost, and often latency, across the whole system. I'd propose validating this with data — run a golden eval set through both the cheap and expensive model and measure the actual quality delta per request category — and if the delta is concentrated in a specific hard subset, that's exactly the shape of problem a cascade solves: default to the cheap model, escalate only the subset that measurably needs it, and get close to "always best model" quality at a fraction of "always best model" cost.
