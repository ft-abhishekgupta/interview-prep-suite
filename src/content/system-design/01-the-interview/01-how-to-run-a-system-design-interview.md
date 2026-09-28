---
title: How to Run a Design Interview
description: The 45-minute framework top candidates use to structure a system design interview, the time budget per phase, and what actually earns points
difficulty: Core
tags: [system-design, interview-strategy, framework, communication]
---

A system design interview is not a test of trivia; it is a test of whether you can turn a vague prompt into a working architecture out loud, in real time, while someone watches. The candidates who do well are not the ones who know the most acronyms — they are the ones who run a **repeatable process** so the interviewer always knows what phase they are in and why.

## Why a framework matters

Without structure, candidates either freeze on a blank whiteboard or dive straight into boxes and arrows and design something that solves the wrong problem. A framework fixes both failure modes: it forces you to scope the problem before you solve it, and it gives the interviewer natural checkpoints to redirect you if you are heading somewhere they do not care about.

> [!KEY]
> The framework is a checklist for **you**, not a script to recite. Move fluidly between phases and let the interviewer's questions pull you back to whichever one matters.

## The 45-minute time budget

Treat the clock as a resource you manage, not something that happens to you. A rough split for a 45-minute round:

| Phase | Minutes | Goal |
|---|---|---|
| Requirements (functional, non-functional, out of scope) | 5 | Agree on what you are building and what you are explicitly not |
| Scale estimation | 3 | Numbers that will justify later design decisions |
| Core entities | 2 | Name the nouns the system exchanges |
| API design | 5 | Write the contract between client and system |
| High-level architecture | 12 | A design that satisfies every functional requirement |
| Data model | 3 | Key fields and indexes on the entities that matter |
| Deep dives | 12 | Fix bottlenecks, satisfy the non-functional requirements |
| Wrap-up / trade-offs | 3 | Summarise what you'd do with more time |

> [!TIP]
> Say the plan out loud in the first minute: *"I'll spend a few minutes on requirements, sketch the API and a high-level design, then spend the back half on deep dives — stop me if you want to go somewhere sooner."* This single sentence buys you control of the room.

## Requirements: functional, non-functional, out of scope

Functional requirements are the verbs users perform — "a user can post a tweet", "a rider can request a ride". Ask targeted questions as if talking to a product owner, then pick the **top three** and explicitly park the rest as out of scope. Saying "I'm assuming direct messages are out of scope for today" is itself a scoring signal: it shows you can prioritise.

Non-functional requirements are system qualities, and they must be **quantified**. A mnemonic that covers the ground: **Scalability, Consistency, Availability, Latency, Environment, Fault tolerance, Compliance, Durability, Security**. You will not hit all nine every time — pick the two or three that actually shape this design and say why the rest are secondary.

```mermaid
flowchart TD
    A["Prompt: design X"] --> B["Functional requirements<br/>top 3 verbs"]
    B --> C["Non-functional requirements<br/>quantified"]
    C --> D["Explicitly out of scope"]
    D --> E["Scale estimate"]
    E --> F["Core entities"]
    F --> G["API contract"]
    G --> H["High-level design"]
    H --> I["Data model"]
    I --> J["Deep dives on bottlenecks"]
    J --> K["Trade-offs and wrap-up"]
```

## Scale estimation, entities, API, architecture, data model

Scale estimation is a quick pass — DAU, requests per second, storage growth — done to **justify** choices later, not as a standalone maths exam. Core entities are the nouns pulled straight from the functional requirements (`User`, `Tweet`, `Follow`); name them well and move on, refining fields later. API design turns each functional requirement into an endpoint: method, path, request body, response shape, and which fields come from auth rather than the body.

High-level architecture is where you spend the most time: start from a client hitting a single service and a database, then add exactly the components each functional requirement forces you to add — a queue when an operation is slow, a cache when a read is hot, a second service when the read and write scaling profiles diverge. Narrate the data model alongside it — the important columns and indexes on the two or three hottest tables, not a full schema.

Caching is the component candidates reach for most often, and it is worth having a fixed checklist for both when to raise it and how to walk through adding it once the interviewer bites:

![Checklist for when to bring up caching (read-heavy workload, expensive queries, high database CPU, latency requirements) and the steps to introduce it (identify the bottleneck, decide what to cache, choose a cache architecture, set an eviction policy, address the downsides)](notes/05-HighLevelDesign/Caching/image-20.png)

## Deep dives and trade-offs

This is the highest-value phase because it is where the non-functional requirements actually get satisfied and where senior candidates separate from mid-level ones. The interviewer usually steers here — a celebrity user breaking your fan-out design, a network partition, a hot key, a spike to 100x traffic. Treat every deep dive as **BAD → GOOD → GREAT**: state the naive answer, the problem with it, and the fix, naming the trade-off you are buying.

| Deep dive prompt | What a strong answer covers |
|---|---|
| "What if this component fails?" | Redundancy, replicas, health checks, no single point of failure |
| "What if traffic is 100x?" | Which layer breaks first, and the cheapest fix (cache, shard, queue) |
| "How do you keep this consistent?" | Which parts are strongly consistent and which are eventual, and why |
| "How do you avoid losing data?" | Replication, write-ahead logs, backups, RPO/RTO |

> [!WARNING]
> Do not let the interviewer's first question about a bottleneck send you into a spiral of over-engineering the rest of the design. Fix the specific thing asked, then return to the outstanding functional requirements if time remains.

## What interviewers actually score

Every major tech company scores roughly the same four dimensions, whatever they call them internally.

| Dimension | What it looks like in the transcript |
|---|---|
| Problem navigation | You scoped the problem, prioritised, and had a visible plan |
| Solution design | Components fit together and actually satisfy the stated requirements |
| Technical excellence | You know real tools, their limits, and current best practice |
| Communication | You drove the conversation, explained trade-offs, took feedback well |

**Communication is not a soft add-on — it is roughly half of most scoring rubrics.** A correct design explained badly scores worse than a good-enough design explained clearly with trade-offs named out loud.

## Phrases that signal seniority

The words you use matter almost as much as the diagram. A few patterns that consistently read as senior:

- *"I'll start simple and add complexity only when a requirement forces it."*
- *"This is a trade-off between X and Y — I'm choosing X because our non-functional requirement is Z."*
- *"Let me do the math before I call this a bottleneck."* — then actually do it.
- *"I'd lean on a managed service here rather than build this myself."*
- *"With more time I'd also address A and B, but given the time box I'm prioritising C."*

## The framework is not a substitute for depth

Running a clean process buys you control of the room, but it cannot manufacture knowledge you do not have — the interviewer's deep-dive questions will eventually probe an area, and no amount of phase-management rescues an answer if the underlying concept is missing. It helps to think of preparation as two separate tracks that the framework only sits on top of.

| Track | What it covers | Where the framework touches it |
|---|---|---|
| Fundamentals | Scalability, availability, latency vs throughput, CAP, consistency models, SLAs/SLOs | Surfaces in the non-functional requirements phase |
| Networking and APIs | HTTP, DNS, REST/gRPC/WebSockets, load balancing | Surfaces in the API design and architecture phases |
| Data and scale | SQL vs NoSQL, indexing, replication, sharding, partitioning | Surfaces in the data model phase and scale-driven deep dives |
| Caching and performance | Cache strategies, CDNs, invalidation, rate limiting | Surfaces whenever a read path turns out to be hot |
| Distributed systems | Consistency, consensus, idempotency, distributed transactions | Surfaces in deep dives about failure and correctness |
| Messaging and async | Queues, pub/sub, event-driven design, ordering, retries | Surfaces when a functional requirement forces decoupling |
| Building blocks | API gateway, load balancer, service discovery, object storage, schedulers | Surfaces as you justify each new component in the architecture |

> [!TIP]
> If you catch yourself narrating the framework fluently but going quiet the moment the interviewer asks "why does that index help here" or "what happens during a network partition," that is a content gap, not a process gap — go study that specific area rather than rehearsing the framework again.

The practical implication: rehearse the process until it is automatic, but spend the majority of your actual preparation time on the content tracks in the table, because the framework only creates the opportunities for you to demonstrate that knowledge — it does not generate the knowledge itself.

## Red flags that sink an otherwise good answer

> [!DANGER]
> Jumping straight to microservices, Kafka, and sharding before showing the design breaks at a smaller scale reads as cargo-culting, not judgement. Always earn complexity.

Other red flags: designing in silence for minutes at a time, ignoring interviewer hints, treating every non-functional requirement as equally important, giving a vague answer like "we'll just add a cache" with no explanation of what it caches or why, and silently redesigning the whiteboard without narrating what changed and why.

## Cheat sheet

- Announce your plan and time budget in the first minute — it buys you control of the round.
- Functional requirements are verbs; pick the top three, park the rest as out of scope.
- Non-functional requirements must be quantified — "highly available" is not an answer, "99.9% with degraded read-only mode acceptable" is.
- Start the architecture simple; add a component only when a requirement forces it.
- Spend the back half of the clock on deep dives — that is where the score is won or lost.
- Frame every trade-off as BAD → GOOD → GREAT and name what you are buying and giving up.
- Do the arithmetic before calling something a bottleneck.
- Communication is roughly half the score — narrate every decision.
- Never end silent — always summarise what you would do next with more time.

## Common mistakes

| Mistake | Fix |
|---|---|
| Designing before requirements are agreed | Spend the first five minutes scoping, even under pressure to "just start" |
| Treating every NFR as equally important | Pick the two or three that actually shape this specific design |
| Silent whiteboarding | Narrate every box and arrow as you draw it |
| Jumping to Kafka/microservices immediately | Show the simple design first, then justify each addition |
| Ignoring the interviewer's redirect | Their question is the deep dive that is actually being scored — follow it |
| No time management | Check the clock; explicitly move phases along if you are behind |
| Ending without trade-offs | Always close with "what I'd do differently with more time or a different NFR" |

## Summary

A system design interview rewards process as much as content: scope the problem, quantify the qualities that matter, build the simplest design that satisfies every functional requirement, then spend the remaining time hardening it against the failure modes the interviewer cares about. Manage the clock visibly, narrate every decision as a trade-off, and treat the interviewer's questions as the deep dive that is actually being scored. Candidates who do this consistently outscore candidates who happen to know more technology names.

## Top Interview Questions

### Q1. Walk me through how you'd structure a 45-minute system design interview.

I'd spend the first five minutes on functional and non-functional requirements, explicitly parking anything out of scope. Then a few minutes each on scale estimation, core entities, and the API contract. The bulk of the time — roughly the middle 12 to 15 minutes — goes to a high-level architecture that satisfies every functional requirement, starting simple and adding components only when justified. I'd narrate the data model for the two or three hottest tables alongside it. The final third goes to deep dives on whatever bottleneck or failure mode the interviewer steers toward, framed as trade-offs. I'd close with a short summary of what I'd do with more time.

### Q2. How do you decide what is "out of scope" without annoying the interviewer?

I state my assumption and ask for confirmation rather than silently deciding: *"I'll treat direct messages as out of scope for today so we can go deep on the feed — does that work?"* This does two things — it shows I can prioritise under a time box, and it gives the interviewer an explicit chance to redirect me if they actually wanted that feature covered. Silently ignoring a feature is a red flag; explicitly scoping it out with a stated reason is a scoring signal.

### Q3. An interviewer says "make this system handle 100x more traffic." What's your process?

First I do the arithmetic: at current numbers, which layer breaks first — the database's write throughput, the app server's connection count, or the cache's memory? I never guess; I say the number and compare it against known capacity figures (for example, a single Postgres instance tops out around 10-20k writes/second). Then I apply the cheapest fix for that specific layer — a cache for a hot read path, a queue to smooth a write burst, sharding only if the single-instance ceiling is genuinely exceeded. I explicitly avoid jumping to "add ten microservices and Kafka" without first showing where the current design actually breaks.

### Q4. How do you handle a prompt so vague you don't know where to start?

I treat vagueness as an invitation to ask clarifying questions, not a trap. I ask two or three targeted functional questions ("does the system need to support X?"), pick a reasonable interpretation, state it out loud, and start. Even an imperfect starting scope that I state clearly is better than freezing. If the interviewer disagrees with my scope, that disagreement itself becomes useful signal about what they actually want to see, and I adjust immediately without treating it as a setback.

### Q5. What does a bad system design answer look like, even if the diagram is technically correct?

A technically correct diagram can still score poorly if it is delivered silently, with no stated reasoning, and no acknowledgment of trade-offs. For example, adding a cache without saying what it caches, what the TTL is, or what happens on a cache miss reads as pattern-matching rather than understanding. Similarly, an answer that treats every non-functional requirement as equally weighted — trying to be maximally consistent, available, and low-latency all at once — signals the candidate does not understand that these usually trade off against each other.

### Q6. How much time should the estimation math actually take, and why do candidates get this wrong?

Two to three minutes, no more. The estimation is a tool to justify later decisions ("500 GB of data fits comfortably on one database with replicas, so I'm not sharding yet"), not a standalone exam question. Candidates get this wrong by either skipping it entirely and later making unjustified claims about scale, or by spending eight minutes on unnecessary precision — computing exact bandwidth to three significant figures when a rounded order-of-magnitude number would have made the same design point just as well.

### Q7. The interviewer keeps asking "why" after every decision. How do you respond?

I treat repeated "why" questions as the interviewer probing for depth, not as disagreement. Each answer should surface the actual trade-off: *"I chose eventual consistency here because the feed can tolerate a few seconds of staleness, and in exchange I get much higher availability and lower write latency."* If I genuinely don't have a strong reason, I say so honestly and reason through it live rather than defending a weak choice — interviewers respond far better to "let me reconsider that" than to a candidate doubling down on a decision that does not hold up.

### Q8. How do you recover if you realise ten minutes in that your architecture is wrong for the requirements?

I say it out loud immediately rather than quietly patching around the mistake: *"Actually, given the read-heavy access pattern we discussed, I think I should split this into a separate read service — let me adjust."* Interviewers consistently rate this behaviour highly because catching and correcting your own mistake mid-design is exactly what happens in real engineering work. The failure mode to avoid is either not noticing at all, or noticing but being too invested in the original diagram to change it.

### Q9. What's the difference between how you'd run a product design interview (like "design Twitter") versus an infrastructure design interview (like "design a rate limiter")?

Product design interviews follow requirements → entities → API → high-level design → deep dives, because the "product" is user-facing and the entities map to real-world nouns. Infrastructure design interviews (rate limiter, message queue, load balancer) usually swap "core entities" and "API design" for a **system interface** step — defining inputs and outputs of the component itself — and often add an explicit **data flow** step describing the pipeline stage by stage, since there is no end user, just other systems calling in.

### Q10. How do you handle it when you genuinely don't know a specific technology the interviewer asks about?

I name the generic concept I do understand and be honest about the specific product gap: *"I know I need a partitioned, durable, ordered log here — I'm less familiar with the exact API of that specific product, but the concept is the same as Kafka, which I have used."* This demonstrates the underlying systems knowledge transfers even without memorising every vendor's API, which is what the interviewer is actually assessing. Pretending to know a tool in detail and then getting caught out is far worse than an honest, confident "I know the concept, not this exact implementation."

### Q11. Should you always draw the "textbook" architecture for a well-known problem like a URL shortener?

No — start from the simplest design that satisfies the stated requirements for **this** conversation, even if it is simpler than the canonical version you have seen written up elsewhere. If the interviewer has said durability and read scale are not major concerns today, adding CDN, cache, and sharding unprompted signals you are reciting a memorised answer rather than reasoning about the specific requirements in front of you. Add each component only when a stated requirement or a deep-dive question forces it.

### Q12. How do you close out the interview in the last two minutes if you run out of time?

I summarise what is solid, name the gaps honestly, and state what I would tackle next with more time: *"This design satisfies the three functional requirements and handles the read-scaling concern we discussed. With more time I'd dig into exact consistency guarantees during a network partition and add rate limiting at the gateway."* This shows self-awareness about the design's remaining weaknesses, which is a better closing signal than silently running out of time or claiming the design is complete when it clearly is not.
