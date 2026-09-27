---
title: Evaluating LLM Systems
description: Why shipping an LLM feature without evals is gambling with production, and how to build offline and online evaluation that catches regressions
difficulty: Core
tags: [llm, evaluation, rag, testing, observability]
---

Unit tests do not catch a model that got 3% worse at extracting dates after a prompt tweak. Evals are the discipline that replaces "it feels better" with a number you can put in a pull request, and they are the single biggest predictor of whether an LLM feature survives contact with production.

## Why You Cannot Ship Without Evals

LLM output is non-deterministic, sensitive to prompt wording, and silently degrades when the underlying model, retrieval index, or a single system prompt line changes. Without evals you have no signal until a customer complains. With evals, a prompt change or model upgrade becomes a diffable, reviewable artifact: "context recall dropped from 0.91 to 0.78, do not merge."

> [!KEY]
> An eval suite is a regression test suite for behaviour that cannot be asserted with `==`. Treat it with the same seriousness as unit tests — run it in CI, block merges on it, and version it alongside the prompt.

## Offline vs Online Evaluation

Offline evals run against a fixed dataset before deploy; online evals watch real traffic after deploy. You need both — offline is fast and safe but cannot see distribution shift in real user queries, online is realistic but only tells you something is wrong after users hit it.

| | Offline eval | Online eval |
|---|---|---|
| Data | Golden/curated dataset | Live production traffic |
| When | Pre-merge, CI, nightly | Post-deploy, continuous |
| Signal | Precise, repeatable | Noisy, real-world |
| Catches | Known regressions | Unknown unknowns, drift |
| Feedback loop | Minutes | Hours to days |
| Examples | Assertion suite, judge scoring | Thumbs up/down, A/B, alerts |

```mermaid
flowchart LR
    D["Golden dataset"] --> R["Run pipeline"]
    R --> M["Score metrics"]
    M --> G{"Meets threshold?"}
    G -->|"No"| F["Fail CI / block deploy"]
    G -->|"Yes"| P["Deploy"]
    P --> O["Online monitors"]
    O --> A["Alert on drift"]
    A --> D
```

## Building a Golden Dataset

A golden dataset is a curated set of representative inputs with expected outputs or expected properties. It should include real historical queries, hand-written edge cases, adversarial inputs, and known-hard examples that previously broke the system. Aim for 50–200 examples to start — enough to be statistically meaningful, small enough that a human can review every failure.

- **Source it from production logs**, not imagination — real user queries surface real failure modes.
- **Label with the smallest useful signal**: exact match where possible, a rubric where not.
- **Version it like code.** A dataset change is as risky as a prompt change.
- **Stratify by difficulty and category** so one easy bucket cannot hide regressions in a hard one.

> [!TIP]
> Keep a standing "regression bucket" of past production incidents. Every bug that reaches a user gets converted into a golden example so it can never silently reappear.

## Deterministic Assertions vs LLM-as-Judge

Prefer deterministic checks wherever the property is checkable in code: JSON schema validity, regex match, exact string match, numeric tolerance, latency threshold. They are cheap, fast, and have zero variance. Reach for an LLM judge only for properties that are inherently subjective — tone, helpfulness, faithfulness to a source document.

```python
def eval_case(output: dict, expected: dict) -> dict:
    # deterministic checks first — cheap, zero variance
    checks = {
        "valid_json": isinstance(output, dict),
        "has_required_fields": all(k in output for k in expected["required"]),
        "within_latency_ms": output["latency_ms"] < 2000,
    }
    if all(checks.values()):
        return {"pass": True, "checks": checks}
    return {"pass": False, "checks": checks}
```

LLM-as-judge asks a (usually stronger) model to score an output against a rubric. It scales to subjective criteria but has real limitations: **position bias** (judges favour the first option shown), **verbosity bias** (longer answers score higher regardless of quality), self-preference (a model judging its own family's output more favourably), and inconsistency across runs.

> [!WARNING]
> An LLM judge is itself an unvalidated component. Correlate a sample of judge scores against human ratings before trusting it — if agreement is below roughly 80%, the judge's rubric or prompt needs work, not the system under test.

## RAG-Specific Metrics

Retrieval-augmented generation fails in more places than a plain chat completion — retrieval, grounding, and answer quality can each break independently, so measure them independently.

| Metric | What it measures | How to compute |
|---|---|---|
| Context precision | Fraction of retrieved chunks that are actually relevant | Judge or human labels relevance per chunk; precision = relevant / retrieved |
| Context recall | Whether all information needed to answer was retrieved | Compare retrieved chunks against a labelled "must include" set for the question |
| Faithfulness / groundedness | Whether the answer only states what the context supports | Extract claims from the answer, check each is entailed by the context (judge or NLI model) |
| Answer relevance | Whether the answer actually addresses the question asked | Judge scores relevance, or generate a reverse question from the answer and compare embedding similarity to the original |

> [!DANGER]
> A high faithfulness score with low context recall means the model is being honest about an incomplete context — and confidently giving a wrong answer anyway. Always read these two metrics together, never in isolation.

## Regression Testing, A/B Testing and Human Feedback

Run the golden dataset in CI on every prompt, model, or retrieval change, and fail the build if any metric drops below its threshold — the same gate as a unit test suite. Offline evals cannot prove a change is *better*, only that it did not regress known cases, so pair CI gating with online A/B testing: route a percentage of real traffic to the new variant and compare business metrics (task completion, thumbs-up rate, escalation-to-human rate) alongside the eval metrics.

Human feedback closes the loop that automated metrics cannot: thumbs up/down widgets, support-ticket correlation, and periodic manual review of a sample of production transcripts. Feed disagreements between the judge and human raters back into the golden dataset and the judge rubric.

## Cost, Latency and Tracing

Cost and latency are product metrics, not infrastructure footnotes — a 30% quality gain that triples latency or 10x's spend can still be a bad ship decision. Track cost per request, tokens in/out, p50/p95/p99 latency, and cache hit rate on every eval run, not just accuracy.

| Failure symptom | Metric that catches it |
|---|---|
| Answers cite facts not in the source | Faithfulness / groundedness |
| Correct facts, but misses part of the question | Context recall or answer relevance |
| Retrieval returns off-topic chunks | Context precision |
| Response time complaints from users | p95/p99 latency |
| Unexplained cloud bill spike | Cost per request, token count |
| Quality looks fine offline, users complain | Online feedback, A/B delta |
| Intermittent garbage output | Trace-level replay of the failing request |

Trace every request end to end — prompt, retrieved context, tool calls, raw model output, token counts, latency — and store it with the eval run. When an eval fails or a user reports a bad answer, the trace is what lets you find the exact broken step instead of re-running the whole pipeline blind. Tracing is the difference between "the RAG answer was wrong" and "the retriever returned the 2022 pricing doc because the index was not filtered by document date" — only one of those is actionable.

## Cheat sheet

- No evals, no ship — treat the golden dataset like a test suite and gate CI on it.
- Offline evals catch known regressions fast; online evals catch unknown drift slowly.
- Prefer deterministic assertions; use LLM-as-judge only for subjective criteria, and validate the judge against humans.
- RAG needs four separate metrics: context precision, context recall, faithfulness, answer relevance.
- Faithfulness without recall can hide a confidently wrong answer.
- A/B test in production; automated metrics alone cannot prove "better", only "not worse".
- Cost and latency are first-class metrics, scored on every eval run.
- Trace every request; traces are what make a failing eval actionable.
- Convert every production incident into a permanent golden example.

## Common mistakes

| Mistake | Fix |
|---|---|
| Shipping on vibes after manual spot-checks | Build a golden dataset and automate scoring in CI |
| Using only one RAG metric (usually "looks right") | Score precision, recall, faithfulness and relevance separately |
| Trusting an LLM judge with no validation | Sample-check judge scores against human labels regularly |
| Treating cost/latency as ops-only concerns | Put them on the same dashboard and gate as quality metrics |
| Testing prompts by hand in a playground before merge | Run the full golden dataset automatically on every change |
| No trace storage | Log prompt, context, tool calls and output for every request |
| Golden dataset never updated | Add every production failure as a new permanent case |

## Summary

Evaluation is what turns an LLM feature from a demo into a product. Offline evals against a curated golden dataset catch known regressions before merge; online evals, A/B tests and human feedback catch what offline data cannot predict. Use deterministic checks wherever possible and reserve LLM-as-judge for genuinely subjective criteria, validating it against humans. For RAG systems, measure retrieval and generation separately — precision, recall, faithfulness and relevance each fail independently. Treat cost, latency and full request tracing as first-class metrics alongside quality, because a system that is accurate but slow, expensive, or undebuggable is not actually shippable.

## Top Interview Questions

### Q1. Why can't you rely on manual spot-checking to ship an LLM feature?

Manual spot-checking is slow, inconsistent between reviewers, and does not scale past a handful of examples, so it systematically misses regressions in the long tail of inputs. LLM output also shifts with any prompt edit, model version bump, or retrieval index change, and a human cannot re-review every past example on every change. An automated golden dataset with scored metrics gives a repeatable, diffable signal — "faithfulness dropped from 0.93 to 0.81" — that can gate a pull request the same way a failing unit test does, and it scales to hundreds of cases run in seconds.

### Q2. What is the difference between offline and online evaluation, and why do you need both?

Offline evaluation runs a fixed pipeline against a curated golden dataset before deploy; it is fast, repeatable, and safe to run on every commit, but it can only catch regressions on cases you already thought to write down. Online evaluation observes real production traffic after deploy — thumbs up/down, A/B experiment metrics, escalation rates — and catches distribution shift and unknown failure modes that no offline dataset anticipated. Offline is your CI gate; online is your early-warning system. Relying on only one leaves a gap: offline-only misses novel real-world failures, online-only means you find out from users instead of from a test.

### Q3. How would you build a golden dataset for a new LLM feature with no production traffic yet?

Start with hand-written examples covering the core use cases, plus deliberately adversarial and edge cases (empty input, ambiguous phrasing, out-of-scope questions, conflicting context). Pull any existing support tickets or requirements docs for realistic phrasing. Keep it small at first — 30 to 50 cases — but stratify it by category and difficulty so a regression in a hard bucket is not diluted by easy passes. As soon as real traffic exists, mine it continuously: sample production queries, especially ones users rephrased or abandoned, and fold every reported failure into the dataset permanently so it becomes a regression test.

### Q4. When would you use a deterministic assertion versus an LLM-as-judge?

Use a deterministic assertion whenever the property is mechanically checkable: does the output parse as valid JSON, does it match a schema, is a required field present, is a number within tolerance, did the call finish under a latency budget. These are free, instant, and have zero variance, so use them for everything they can cover. Reach for an LLM judge only for properties that require semantic judgement a script cannot express — tone, faithfulness to a source document, whether an answer actually addresses the question. The judge is slower, costs tokens, and has its own biases, so it should be the fallback, not the default.

### Q5. What are the known limitations of using an LLM as a judge?

LLM judges exhibit position bias (favouring whichever option is listed first), verbosity bias (scoring longer answers higher independent of correctness), and self-preference (rating outputs from the same model family more favourably). They are also inconsistent — the same input can score differently across runs, especially at higher temperature. Because of this, a judge should never be trusted blindly: sample its scores against human ratings periodically and track agreement, use a low or zero temperature for the judge call itself, randomise answer order when comparing two outputs, and keep the rubric explicit and narrow rather than asking for a vague "quality" score.

### Q6. Explain context precision and context recall in RAG evaluation, and how they can fail independently.

Context precision measures how much of what was retrieved is actually relevant — low precision means the retriever is pulling noise alongside signal, which wastes context budget and can distract the model. Context recall measures whether everything needed to answer the question was retrieved at all — low recall means the answer is being generated from an incomplete context no matter how good the generation step is. They fail independently: a retriever can return exactly one relevant chunk out of one (perfect precision) while missing three other chunks the question needed (poor recall), or return the right chunk buried in nine irrelevant ones (poor precision, perfect recall). Debugging retrieval requires looking at both.

### Q7. What does "faithfulness" or "groundedness" mean, and why is a high faithfulness score not enough on its own?

Faithfulness measures whether every claim in the generated answer is actually supported by the retrieved context — it is a check against hallucination, computed by extracting claims from the answer and verifying each is entailed by the context, either with an NLI model or an LLM judge. It says nothing about whether the context itself was sufficient: a model can be perfectly faithful to an incomplete context and still produce a confidently wrong answer, because it correctly reported what a bad retrieval gave it. That is why faithfulness must always be read alongside context recall — high faithfulness plus low recall is a specific, diagnosable failure mode: "the model is honest, the retriever is broken."

### Q8. How would you regression-test prompts in CI for a production LLM service?

Store the prompt (or prompt template) as a versioned artifact alongside the code, and wire a CI job that runs the full golden dataset through the current pipeline on every pull request that touches the prompt, model configuration, or retrieval logic. Score with the same metrics used in production monitoring — deterministic checks plus faithfulness/relevance where relevant — and fail the build if any metric drops below a set threshold or regresses versus the baseline on main. Cache model calls for unchanged inputs to keep CI fast and cheap, and store the full trace of any failing case as a build artifact so a reviewer can see exactly what changed without re-running anything.

### Q9. A prompt change improves your offline eval scores by 5% but users start complaining after deploy. What happened and how do you investigate?

This is the classic gap between offline and online evaluation: the golden dataset does not represent the full distribution of real traffic, so an improvement on curated cases can regress on a category the dataset under-samples. Start by pulling traces of the complaints and checking which metric would have caught them — often it is a category absent from the golden dataset (a new phrasing style, a longer input, a different language). Add those failing cases to the golden dataset permanently, re-run the eval to confirm it now catches the regression, and consider rolling the change out via a staged A/B rollout next time rather than a full deploy, so online signal arrives before all users are affected.

### Q10. How do cost and latency fit into an LLM evaluation strategy?

They are scored on every eval run alongside quality, not tracked separately as an infrastructure concern, because a quality improvement that triples cost or latency can be a net-negative ship decision. Track tokens in/out and dollar cost per request, and p50/p95/p99 latency, as columns next to accuracy and faithfulness in the same report. This lets you make an explicit trade-off call — for example, accepting a small faithfulness drop from a cheaper model if it cuts cost 4x and a cascade only escalates the hard cases to the expensive model. Without this, teams optimise quality in a vacuum and get an accurate feature nobody can afford to run at scale.

### Q11. Why is request tracing important for an LLM system, and what should a trace contain?

An LLM pipeline has many steps that can each fail independently — retrieval, prompt assembly, tool calls, the model call itself — and a bad final answer does not tell you which step broke. A trace should capture the exact prompt sent, the retrieved context and its source documents, any tool calls and their arguments and results, the raw model response, token counts, latency per step, and the model/version used. Without this, debugging a reported failure means guessing and re-running the whole pipeline hoping to reproduce it; with it, you can see immediately that, for example, the retriever returned a stale document because a date filter was missing.

### Q12. How would you design human feedback collection so it actually improves the system over time?

Make feedback cheap to give (a single thumbs up/down, not a survey) and route it somewhere actionable, not just a dashboard nobody reads. Pair coarse binary feedback with a periodic manual review of a random sample of transcripts, including ones with no explicit feedback, since most users do not bother rating a merely-okay answer. Route negative feedback into the golden dataset after a human confirms it is a real failure (not user confusion), and use disagreements between the LLM judge and human raters to fix the judge's rubric rather than assuming the judge is right. The loop only works if feedback changes something — the dataset, the prompt, or the judge — within a short cycle, otherwise the collection becomes theatre.
