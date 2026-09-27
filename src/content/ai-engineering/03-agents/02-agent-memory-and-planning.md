---
title: Agent Memory and Planning
description: How agents remember across steps and sessions, manage a limited context window, and plan multi-step tasks instead of reacting blindly
difficulty: Advanced
tags: [agents, memory, planning, llm, context-window]
---

An agent without memory re-derives everything from scratch on every step and forgets what it tried five minutes ago; an agent without planning reacts one step at a time and stumbles into avoidable dead ends. Both are engineering problems with well-known solutions, not model magic.

## Memory Types in Agent Systems

"Memory" for an LLM agent is not one thing — different memory types solve different problems and are implemented completely differently.

| Memory type | What it holds | Typical implementation | Lifespan |
|---|---|---|---|
| Short-term (context window) | The current conversation and recent tool results | Messages array sent with every model call | One session, until it overflows |
| Working / scratchpad | Intermediate reasoning, partial results for the current task | A structured buffer or "notes" field written by the model mid-task | One task |
| Episodic | Specific past interactions or task runs | Logged transcripts, keyed by session or task ID | Days to indefinite |
| Semantic / vector | Facts, documents, general knowledge | Embeddings in a vector store, retrieved by similarity | Indefinite |
| Procedural | Learned skills, successful strategies, tool-use patterns | Distilled into prompts, few-shot examples, or fine-tuning | Indefinite |

```mermaid
flowchart TD
    U["User turn"] --> CW["Context window<br/>(short-term)"]
    CW --> WS["Scratchpad<br/>(working memory)"]
    WS --> LLM["Agent LLM"]
    LLM --> EP[("Episodic store<br/>past sessions")]
    LLM --> SEM[("Vector store<br/>semantic memory")]
    EP -.->|"retrieve relevant history"| CW
    SEM -.->|"retrieve relevant facts"| CW
```

> [!KEY]
> Only short-term and working memory live in the prompt you send. Episodic and semantic memory live outside the model entirely — in a database or vector store — and are pulled *into* the context window on demand. Conflating "memory" with "context window" is the most common mistake in agent design interviews.

## Managing the Context Window

Context windows are large but not infinite, and cost scales with tokens sent, so even a technically-fitting history is often the wrong choice. Four standard strategies, usually combined:

| Strategy | How it works | Best for |
|---|---|---|
| Truncation | Drop oldest messages once a token limit is hit | Simple chatbots, low-stakes history |
| Sliding window | Keep only the last N turns | Bounded, predictable cost |
| Summarisation | Periodically compress older turns into a short summary | Long conversations where early context still matters |
| Retrieval | Store full history externally, pull back only relevant pieces per turn | Long-running agents, multi-session assistants |

> [!WARNING]
> Naive truncation silently drops the *system prompt's* earlier grounding or a tool result the model still needs, and the model will not tell you it's now missing information — it will just quietly hallucinate. Always protect the system prompt and the most recent tool observation from truncation explicitly.

Summarisation trades detail for durability: an LLM call periodically rewrites the oldest chunk of conversation into two or three sentences, keeping the gist while freeing tokens. Retrieval goes further — nothing is discarded, everything is stored, and a retrieval step (often the same embedding index used for RAG) decides what is relevant *this turn* rather than assuming recency equals relevance.

## State Persistence and Checkpointing

An agent that only lives in memory dies with the process. Production agents persist state — the conversation, the scratchpad, tool call history, and current plan — to durable storage after each step, so a crash, a deploy, or a multi-day task can resume exactly where it left off instead of restarting.

```python
def run_step(agent_state: dict, step_input: str) -> dict:
    agent_state["history"].append({"role": "user", "content": step_input})
    response = llm.chat(agent_state["history"], tools=agent_state["tools"])
    agent_state["history"].append(response.to_message())
    save_checkpoint(agent_state["task_id"], agent_state)  # durable write, one per step
    return agent_state
```

Checkpointing turns a long-running or multi-turn agent into something you can pause, inspect, resume on a different machine, or roll back after a bad step — the same operational property a workflow engine gives a batch job. Store the checkpoint keyed by task/session ID, version its schema, and make resumption idempotent so replaying the last checkpoint after a crash does not double-execute a side-effecting tool call.

> [!TIP]
> Checkpoint *before* executing a tool call with side effects, not only after. If the process dies mid-call, the recovery logic needs to know whether the call was attempted, so it can check the external system's state instead of blindly retrying a payment or an email send.

## Planning Approaches

How much an agent plans before acting is a spectrum, and the right point on it depends on task complexity and error cost.

| Approach | How it works | Strength | Weakness |
|---|---|---|---|
| Single-shot plan | Model writes the full plan upfront, then executes it blindly | Cheap, fast, easy to review before execution | Cannot adapt if an early step's result changes what's needed |
| Plan-and-execute | Model writes a plan, executes one step, can revise the remaining plan based on the result | Balances foresight with adaptability | More model calls than single-shot |
| ReAct (interleaved) | No separate plan — reason and act one step at a time | Maximally adaptive, simple to implement | Can wander without a goal check; myopic on multi-step goals |
| Tree search | Explore multiple candidate next steps, score them, backtrack on dead ends | Best for tasks with a clear success signal and many false paths (code, puzzles) | Expensive — multiplies model calls by branching factor |

> [!NOTE]
> "Plan-and-execute" is the most common production pattern for non-trivial tasks: it gets most of tree search's foresight without its cost, and most of ReAct's adaptability without its short-sightedness.

## Reflection and Self-Critique

Reflection is an explicit step where the agent (or a second model call) reviews its own output or trajectory against the goal before finalising — "did this actually answer the question, did I skip a required step, is this consistent with the tool results I gathered." It catches a class of errors ReAct's forward-only loop misses: the agent can complete every step "successfully" and still have solved the wrong problem.

A simple pattern: generate an answer, then run a second pass with the original task and the answer, asking only "does this fully satisfy the task; if not, what's missing." If the critique flags a gap, loop back with that specific gap as new input rather than starting over. This costs roughly one extra model call per iteration and measurably reduces silent partial completions in agent evals.

## Decomposing Tasks and Long-Running Agents

Large tasks should be broken into subtasks with their own success criteria, rather than handed to the model as one giant instruction — this bounds the blast radius of a single wrong step and lets you checkpoint and retry at the subtask level instead of restarting the whole task. "Research three competitors and write a comparison" decomposes into three independent research subtasks plus one synthesis subtask, each separately checkable.

For agents that run for minutes, hours, or days (a research agent, a data migration agent), design for interruption from the start: checkpoint after every subtask, make subtasks idempotent so a retry after a crash does not redo completed work, emit progress events so a human can observe status without waiting for completion, and set a maximum wall-clock or cost budget per subtask so one stuck subtask cannot silently consume the whole run's budget.

## Cheat sheet

- Memory is not one thing: short-term (in the prompt), working (scratchpad), episodic, semantic, procedural — each has a different store and lifespan.
- Only short-term and working memory live inside the context window; episodic and semantic memory are retrieved into it on demand.
- Combine truncation/sliding window (cheap) with summarisation and retrieval (preserve meaning) for long conversations.
- Never let truncation silently drop the system prompt or the latest tool observation.
- Persist and checkpoint agent state after every step; checkpoint *before* side-effecting tool calls, not just after.
- Plan-and-execute is the common production middle ground between single-shot planning and pure ReAct.
- Tree search buys adaptability at a real cost multiplier — reserve it for tasks with a clear scoring signal.
- Reflection catches "completed every step but solved the wrong problem" — ReAct alone does not.
- Decompose long tasks into independently checkpointable, idempotent subtasks with their own success criteria.

## Common mistakes

| Mistake | Fix |
|---|---|
| Treating the context window as the agent's only memory | Add episodic/semantic stores outside the prompt for anything that must survive past this session |
| Truncating history blindly on overflow | Protect system prompt and latest observation; summarise or retrieve instead of dropping |
| No persistence between steps | Checkpoint state after every step, keyed by task ID |
| Checkpointing only after a tool call succeeds | Checkpoint before side-effecting calls so recovery can check real-world state |
| Using tree search for every planning problem | Reserve it for tasks with a clear success signal and real branching risk |
| Skipping reflection because "the loop already checks each step" | Add an explicit goal-check pass — per-step success does not imply task success |
| Giving a long-running agent one giant instruction | Decompose into subtasks with independent checkpoints and budgets |

## Summary

Agent memory spans a spectrum from the ephemeral context window to durable episodic and semantic stores, and conflating them is the fastest way to design a system that forgets things it should remember or drowns in context it should have retrieved instead. Manage the context window deliberately — truncation and sliding windows for cost, summarisation and retrieval for meaning — and persist state with checkpoints so agents survive crashes and long tasks. Planning ranges from cheap single-shot plans to expensive tree search; plan-and-execute is the pragmatic default, with reflection added to catch the failure mode where every step "succeeds" but the task does not. Decompose anything long-running into idempotent, independently checkpointed subtasks.

## Top Interview Questions

### Q1. What are the different types of memory in an agent system, and why does the distinction matter?

Short-term memory is whatever is literally in the context window sent to the model this turn — the conversation and recent tool results. Working memory is a scratchpad the agent writes intermediate results to during a single task. Episodic memory is a record of past interactions or task runs, stored outside the model and retrieved when relevant. Semantic memory is general facts or documents, usually in a vector store, retrieved by similarity. Procedural memory is a learned strategy or skill, captured as reusable prompts, few-shot examples, or fine-tuning. The distinction matters because each needs a different storage mechanism and retrieval strategy — treating episodic and semantic memory as if they must live permanently in the context window is what causes context overflow and unnecessary cost.

### Q2. How would you handle a conversation that grows beyond the model's context window?

I would combine strategies rather than pick one: keep a sliding window of the most recent N turns verbatim for local coherence, periodically summarise older turns into a compact rolling summary so earlier context is not fully lost, and for anything that needs to be recalled precisely regardless of age — a fact stated ten turns ago, a decision made earlier — store the full history externally and retrieve the relevant piece on demand rather than keeping it resident. I would always protect the system prompt and the most recent tool observation from being dropped, since naive truncation removing either causes the model to silently operate on missing information without any visible error.

### Q3. Why is checkpointing important for agents, and where in the loop should a checkpoint be written?

Checkpointing persists the agent's full state — conversation history, scratchpad, current plan, tool call log — to durable storage so the agent can resume after a crash, a deploy, or simply a long pause, instead of restarting the whole task. The subtle part is *when* to write it: checkpointing only after a tool call succeeds is not enough, because if the process crashes mid-call, on resume you don't know whether the call actually happened. I would checkpoint before executing any side-effecting call, recording that the call was attempted, so recovery logic can check the external system's actual state (did the payment go through, was the email sent) before deciding whether to retry, rather than blindly re-executing and risking a duplicate action.

### Q4. Compare single-shot planning, plan-and-execute, and pure ReAct as planning strategies for an agent.

Single-shot planning has the model produce the entire plan upfront and then execute it without revision — cheap and easy to review before committing, but brittle if an early step's actual result invalidates a later planned step. Pure ReAct has no separate planning phase at all; the model reasons and acts one step at a time, which is maximally adaptive to new information but can wander on multi-step goals since there's no persistent plan keeping it oriented toward the end goal. Plan-and-execute sits between them: an initial plan is produced, but after each step the model can revise the remaining plan based on what actually happened — most of ReAct's adaptability with more of single-shot's foresight, at the cost of an extra planning call. In production, plan-and-execute is the common default for non-trivial multi-step tasks.

### Q5. When would tree search be worth its extra cost for agent planning?

Tree search — exploring multiple candidate next actions, scoring them, and backtracking from dead ends — earns its cost multiplier specifically when the task has a clear, checkable success signal and a real risk of committing to a wrong path early that is expensive to recover from, such as code generation where you can run tests against candidate solutions, or puzzle-like tasks with verifiable win conditions. It is a poor fit for open-ended tasks with no cheap way to score a partial path, or for tasks where sequential steps are cheap to redo if wrong — there, plan-and-execute or ReAct gets similar quality for a fraction of the model calls. The rule of thumb: only pay for search when backtracking is genuinely useful, i.e., when going down a wrong branch is expensive to detect and undo.

### Q6. What is reflection in the context of an agent, and what failure mode does it specifically catch?

Reflection is an explicit self-critique step, usually a separate model call, where the agent compares its own output or completed trajectory against the original goal and asks whether it actually satisfies it, before returning a final answer. It specifically catches the failure mode where every individual step in the trajectory technically succeeded — every tool call returned without error — but the overall task was not actually accomplished, for example answering only two of three questions asked or using stale data that was technically retrieved correctly. A forward-only ReAct loop has no mechanism to catch this since it only checks "did the last action work," not "does the accumulated result satisfy the goal." Reflection costs roughly one extra model call but measurably reduces silent partial completions.

### Q7. How would you decompose a large, multi-hour task into something an agent can execute reliably?

I would break it into subtasks that each have an independently checkable success criterion, rather than handing the model one giant instruction — for example, splitting "research three competitors and write a comparison" into three separate research subtasks and one synthesis subtask. Each subtask gets its own checkpoint, so a failure or crash only requires retrying that subtask, not the whole multi-hour run, and each should be designed to be idempotent so a retry does not duplicate already-completed work (re-fetching a document that was already fetched should be a safe no-op check, not a blind re-fetch). I would also give each subtask its own cost and time budget, so one subtask getting stuck cannot silently consume the entire task's allowance.

### Q8. Your agent's answer is technically correct on every retrieved fact, but it missed part of a multi-part user question. Where in your architecture would you look, and how would you fix it?

This is a planning and reflection gap, not a factual-accuracy problem, so I would not look at retrieval quality first. I'd check whether the agent decomposed the multi-part question into explicit sub-goals at all, or whether it treated the query as a single undifferentiated task and stopped as soon as it had *an* answer rather than *the complete* answer. The fix is usually two-fold: have the planning step explicitly enumerate the distinct parts of the question as a checklist, and add a reflection pass that checks the draft answer against that checklist before returning it — a ReAct loop without an explicit goal decomposition step is exactly the setup where this silent partial-completion failure happens.

### Q9. How do you decide what belongs in short-term context versus what should be retrieved from long-term memory each turn?

Short-term context should hold what is needed for immediate coherence — the last few turns, the current task's scratchpad, the most recent tool result — capped by a token budget so cost stays predictable. Anything that needs to survive across sessions, or that is too large to keep resident every turn regardless of relevance (a full document corpus, a year of past interactions), belongs in an external episodic or semantic store and gets pulled in via retrieval only when it's relevant to the current turn. The practical test is: would keeping this in every prompt regardless of topic be wasteful? If yes, it belongs in long-term storage with retrieval; if it's needed for basically every response, it stays in short-term context.

### Q10. Describe how you would design a resumable long-running agent that might be interrupted by a deploy or a crash.

I would persist the full agent state — history, scratchpad, current subtask, plan — after every step to a durable store keyed by task ID, and version the state schema so a deploy that changes the agent's internals doesn't break resumption of in-flight tasks. Side-effecting tool calls get checkpointed *before* execution with a status field ("attempted"/"confirmed"), so on resume the recovery logic checks the real external system state rather than blindly retrying. Subtasks are designed to be idempotent, and each has its own budget, so resuming after an interruption picks up at the last incomplete subtask rather than restarting the whole task. I'd also emit progress events so the interruption is visible to a human monitoring the task, not just silent until either success or timeout.

### Q11. What's the risk of relying purely on conversation summarisation to manage a long-running agent's memory, and how would you mitigate it?

Summarisation is lossy by design — a model compressing ten turns into two sentences will drop details that seemed unimportant at the time but turn out to matter later, and errors can compound if you keep re-summarising an already-summarised history. The mitigation is to pair summarisation with retrieval rather than relying on it alone: keep the full, unsummarised history in durable storage even after producing a rolling summary for the prompt, so if a later turn needs a specific earlier detail, it can be retrieved on demand instead of relying on whatever survived the compression. I would also avoid re-summarising a summary more than once or twice before anchoring back to source material, to limit compounding drift.

### Q12. How would you test an agent's planning and memory behaviour, given that its exact trajectory can vary between runs?

I would test at the level of properties rather than exact trajectories: does the plan cover all required subtasks for a given input, does the agent correctly retrieve a fact it was told several turns earlier, does it recover correctly from a simulated crash mid-task using its checkpoint, does reflection catch a deliberately incomplete draft answer in a synthetic test case. For memory specifically, I'd construct test conversations that plant a fact early and query for it much later — sometimes past the point a naive sliding window would have dropped it — to verify retrieval or summarisation actually preserved it. I'd run these across multiple seeds and report a pass rate, since planning quality is a distribution of outcomes, not a single deterministic result.
