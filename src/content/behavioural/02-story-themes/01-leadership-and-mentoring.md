---
title: Leadership and Mentoring
description: How to demonstrate technical leadership, influence without authority, and mentoring depth in senior and tech lead interviews
difficulty: Core
tags: [leadership, mentoring, influence, tech-lead]
---

Leadership questions in a senior or tech lead loop are rarely about a job title. Interviewers want evidence that you can set direction, get people to follow it without formal power, and grow the people around you — three distinct skills that candidates routinely blur together into one vague story about "leading a project".

## What leadership means for an IC versus a tech lead

An individual contributor demonstrates leadership through **influence on a specific decision or person** — proposing a design, unblocking a teammate, driving a fix nobody owned. A tech lead is expected to show leadership as a **sustained pattern across a team or set of teams** — setting technical direction, owning a roadmap trade-off, being the person others escalate ambiguity to.

| Signal | IC-level story | Tech lead-level story |
|---|---|---|
| Scope | One project, one decision | Multiple projects, a team's technical direction |
| Timeframe | Days to weeks | A quarter or more |
| Mechanism | Proposed and convinced | Set expectations, delegated, followed up |
| People affected | Peers | Peers, juniors, other teams, sometimes management |

> [!KEY]
> If your leadership stories are all about *doing* the hard technical work yourself, you are reading as a strong senior IC, not a tech lead. Tech lead stories need at least one where your main contribution was making *someone else* successful.

## Influence without authority

This is the single most-tested leadership competency, because most engineers do not have formal power over the people they need to move. A concrete approach that works and is easy to narrate:

1. **Lead with the shared goal**, not your preferred solution — "we both want fewer production incidents" lands better than "you should use my design".
2. **Bring data, not opinion** — a benchmark, an incident count, a latency graph. Data de-personalises the disagreement.
3. **Make the ask small and reversible first** — a pilot, a two-week trial, a single service — so the cost of saying yes is low.
4. **Give credit generously once it works** — this is what makes people willing to be influenced by you again.

> [!TIP]
> A sentence that signals seniority: *"I didn't have authority over that team, so I framed it as a shared problem, ran a two-week pilot on one low-risk service to get real data, and let the result make the case instead of my opinion."*

## Setting technical direction and getting buy-in

A tech lead story about direction-setting should show a decision that was genuinely contested, not one where everyone already agreed. Strong structure: state the options fairly, show how you gathered input without letting the loudest voice win by default, name the trade-off you picked and why, and describe how you got the team — not just your manager — actually bought in, not just compliant.

```mermaid
flowchart LR
    A["Frame the problem<br/>and constraints"] --> B["Gather options<br/>from the team"]
    B --> C["Evaluate trade-offs<br/>with data"]
    C --> D["Make and communicate<br/>the decision"]
    D --> E["Get buy-in via<br/>reasoning, not mandate"]
    E --> F["Revisit if new<br/>evidence appears"]
```

> [!WARNING]
> A design decision you made unilaterally and announced is not a buy-in story. Interviewers will ask "how did the team react" and "did anyone disagree" — have a real answer, including a case where someone pushed back and you either adjusted or explained why not.

## Delegating ownership, not tasks

Junior leaders delegate *tasks* ("can you implement this endpoint"). Strong leads delegate *ownership* ("this service's reliability is yours — come to me with the plan"). The difference is whether the other person is accountable for the outcome or just the output.

| Delegating a task | Delegating ownership |
|---|---|
| You specify the how | They propose the how |
| You check the output | You check in on progress and unblock |
| Failure is your design's fault | Failure is a shared learning moment, growth continues |
| Builds execution capacity | Builds judgement and confidence |

## Mentoring versus coaching versus sponsoring

These three get used interchangeably but interviewers listening closely can tell which one your story actually demonstrates.

| Mode | What you do | Best story example |
|---|---|---|
| Mentoring | Share knowledge and experience directly | Pairing with a junior engineer on system design |
| Coaching | Ask questions that help them find their own answer | Letting someone debug a production issue with prompts, not answers |
| Sponsoring | Use your credibility to open a door for them | Nominating a junior for a stretch project or a promotion case |

A worked structure for a "growing a junior engineer" story: identify the specific skill gap you noticed (not "they were junior", something concrete like "they avoided ambiguous problems"), describe the deliberate intervention (a stretch task, paired debugging, a design review you invited them into), name the friction or setback along the way, and close with a measurable change — promoted, running their own project, leading a design review themselves.

## Running a design review

Design reviews are a common leadership micro-story because they compress a lot of signal into one scene: how you handle disagreement in the room, how you make a decision under time pressure, and whether you let junior voices speak. A strong answer names a specific structural choice you made — for example, asking the most junior person in the room to raise concerns first, before more senior opinions anchor the discussion — and the trade-off you ultimately chose and why.

## Handling an underperformer without formal authority

This is a common trap question for senior ICs and tech leads without direct reports. The honest answer acknowledges you cannot performance-manage someone, then shows what you *can* do: set clear, specific expectations for the work you jointly own, give direct and specific feedback early rather than letting it fester, document what "good" looks like so it's not just your opinion, and loop in their manager collaboratively rather than going around them.

> [!DANGER]
> A red flag answer is "I went to their manager and got them managed out." Even if true, framing it as your first move signals you skip the harder, more respectful step of direct feedback. Interviewers want to see you try direct conversation first.

## Cross-team collaboration

Cross-team stories test whether you can get outcomes when you have zero authority and the other team has different incentives. The strongest versions name the actual incentive misalignment ("their team was measured on their own roadmap, not on unblocking us") and show how you found a framing where helping you also helped them, rather than simply asking nicely or escalating immediately.

## What the interviewer is really testing

| Question asked | What's really being tested |
|---|---|
| "Tell me about a time you led a project" | Can you set direction and hold a team to it |
| "Tell me about influencing without authority" | Can you get outcomes without formal power |
| "Tell me about mentoring someone" | Do you grow people, or just extract their output |
| "Tell me about a disagreement with your team" | Do you listen, or do you steamroll |
| "Tell me about delegating something important" | Can you let go of control and still get quality |
| "Tell me about handling an underperformer" | Do you have the courage for direct, respectful feedback |

## Sample answer outline: influence without authority

Situation: a partner team's API design would have forced expensive client-side workarounds across three consuming teams. Task: get them to change direction without any authority over their roadmap. Action: gathered latency and error data from the three consumers, proposed a small backward-compatible change as a two-week spike rather than a big redesign, presented it as solving their long-term support burden too, and pair-programmed the first integration with their engineer to lower the activation cost. Result: they adopted the change within the sprint, and it became their team's default pattern for new endpoints.

## Cheat sheet

- Tech lead stories need at least one where your main contribution was making someone else successful, not doing the hard work yourself.
- Influence without authority: shared goal framing, data over opinion, small reversible ask, generous credit afterward.
- A direction-setting story must include disagreement and how you resolved it, not a decision everyone already agreed with.
- Delegating ownership means the other person owns the "how," not just the "what."
- Know the difference between mentoring (sharing), coaching (questioning), and sponsoring (advocating) — and use the right word.
- Underperformer stories: direct feedback first, manager collaboration second, never "I got them managed out" as the opening move.
- Cross-team stories are strongest when you name the actual incentive misalignment and how you resolved it.

## Common mistakes

| Mistake | Fix |
|---|---|
| Every leadership story is about your own technical work | Include at least one where you made someone else successful |
| Direction-setting story has no disagreement in it | Pick a story with real, stated pushback and how you handled it |
| Delegation story is really a task-assignment story | Show the other person owning the plan, not just the execution |
| Using "mentor," "coach," and "sponsor" interchangeably | Match the word to what you actually did in the story |
| Leading with "I escalated to their manager" for an underperformer | Lead with direct, specific feedback first |
| Cross-team story blames the other team | Name the incentive mismatch neutrally and show how you bridged it |

## Summary

Leadership interviews are testing whether you can set direction, move people without formal power, and grow others — not whether you can single-handedly solve hard technical problems. The strongest stories name a real disagreement or gap, show a deliberate mechanism (data-driven influence, delegated ownership, targeted mentoring), and end with evidence that someone else's capability or the team's trajectory genuinely changed. Prepare at least one story where you were not the hero doing the work, but the person who made someone else's success possible.

## Top Interview Questions

### Q1. Tell me about a time you led a project without having formal authority over the people involved.

I was the most senior engineer on a migration that touched three teams I had no reporting line into. I started by framing the migration as solving a shared pain point — each team was independently working around the same legacy API — rather than as my initiative. I proposed a small, low-risk pilot on one team's service to generate real data instead of asking for buy-in on faith, then used that data to get the other two teams to opt in. I made sure to credit each team's engineers publicly once their piece landed, which made the next ask easier. The migration completed across all three teams within a quarter, and the pattern became the team's default for new integrations.

### Q2. Describe a time you set a technical direction that the team initially disagreed with.

We were debating a caching strategy, and I favoured a write-through cache while two senior engineers preferred cache-aside for simplicity. Rather than mandate a choice, I asked each side to state the failure mode they were most worried about, then we prototyped both against our actual traffic pattern for a week. The data showed cache-aside had acceptable staleness for our use case and was significantly less code to maintain, so I went with the option I hadn't originally favoured. I made sure to explain my reasoning for changing my mind in the same detail I'd have used to defend my original position, which mattered for the team trusting future decisions I made.

### Q3. How do you mentor a junior engineer, and how do you know it's working?

I look for a specific gap rather than treating "junior" as one thing — with one engineer, I noticed they always escalated ambiguous problems to me instead of proposing a direction themselves. I started deliberately withholding my own answer and instead asking "what would you try first, and what's the risk," which pushed them to reason through trade-offs rather than wait for instructions. I paired with them on a design review as a stretch assignment about two months in, and by the end of the quarter they were running design reviews independently and had shipped a service with minimal oversight from me. The real signal it worked was that they stopped needing me for that class of problem.

### Q4. Tell me about a time you delegated something important and it didn't go the way you expected.

I handed ownership of a reliability initiative to a mid-level engineer, deliberately giving them the "what" (reduce a specific class of incidents) but not the "how." They chose an approach I wouldn't have picked — investing in better alerting before root-causing the underlying bug — and initial progress looked slow. Instead of taking it back, I checked in weekly on their reasoning rather than their output, and it turned out the alerting work surfaced a second, more serious issue we hadn't known about. The incident class dropped by more than we'd targeted, and I learned that my instinct to redirect them early would have missed that discovery.

### Q5. How do you handle an underperforming teammate when you have no formal authority over them?

I focus on what I can actually influence: clear, specific expectations on shared work and direct feedback given early rather than left to fester. In one case, a peer was consistently missing agreed-upon deadlines on a shared deliverable. I had a direct one-on-one conversation naming the specific pattern and its impact on the team, rather than going straight to their manager. When the pattern continued, I looped their manager in collaboratively — sharing what I'd already raised directly and asking how I could help — rather than escalating behind their back. The direct conversation alone resolved about half the issue; the collaborative escalation handled the rest without damaging the working relationship.

### Q6. What's the difference between mentoring, coaching, and sponsoring, and can you give an example of each?

Mentoring is sharing my own experience directly — I did this by walking a junior engineer through how I'd approach a system design problem, including my mistakes. Coaching is asking questions that help someone reach their own answer rather than giving mine — I did this during an incident where I let an engineer debug a production issue with prompting questions instead of taking over. Sponsoring is using my own credibility on someone else's behalf when they're not in the room — I nominated a strong but under-visible engineer for a cross-team project that became the centrepiece of their next promotion case. All three matter, but they're not interchangeable, and using the wrong one for the situation can undercut someone's growth.

### Q7. Tell me about running a design review where there was significant disagreement.

I was reviewing a proposal to introduce a new message queue, and two senior engineers disagreed sharply on whether we needed exactly-once delivery semantics. I asked the most junior engineer in the room to state their understanding of the trade-off first, before the senior voices could anchor the discussion, which surfaced a simpler framing everyone had missed. I then had each side state the cost of being wrong in their direction, which made it clear the risk was asymmetric — at-least-once with idempotent consumers was cheaper to get wrong than exactly-once was to build. We went with at-least-once, and I made sure the decision and its reasoning were written down so the team could revisit it if assumptions changed.

### Q8. Describe a cross-team collaboration where the other team had little incentive to help you.

A partner team owned an API my team depended on, but they were measured entirely on their own roadmap, not on our integration's success. Rather than escalating through management immediately, I looked for where our needs overlapped with theirs and found that a change we wanted would also reduce their own support burden from other consumers. I proposed it as a small, well-scoped change and offered to write most of the implementation myself, lowering their cost to say yes. They merged it within two weeks, and it became their default pattern for future consumers, which meant the next ask from any team was easier too.

### Q9. What does leadership mean for you as a tech lead versus as an individual contributor?

As an IC, my leadership showed up as influence on a specific decision or person — proposing a design, unblocking a teammate on a hard bug. As a tech lead, I've had to demonstrate it as a sustained pattern: setting a team's technical direction over a quarter, being the person others bring ambiguous problems to, and being deliberately less hands-on so others can grow into ownership. The clearest personal shift was realising that my best weeks as a tech lead were sometimes the ones where I wrote the least code myself, because my job was making the team more capable, not being the fastest individual contributor in the room.

### Q10. Tell me about a time you had to influence a decision using data rather than authority or opinion.

Two teams disagreed about whether a shared service needed a rewrite or incremental fixes, and as a non-decision-maker on either team I couldn't just assert an answer. I instrumented the current service for a week to get real numbers on the specific failure modes people were citing from memory, and it turned out the perceived "constant instability" was actually two recurring bugs, not systemic architecture debt. Bringing that data to the room reframed the conversation from a multi-month rewrite to a two-week fix, which both teams accepted quickly because the evidence, not my opinion, made the case.

### Q11. How do you get genuine buy-in for a decision, rather than just compliance?

I involve people in evaluating the trade-off before I state a preference, rather than announcing a decision and asking for reactions. For a service ownership boundary change, I laid out the constraints and asked engineers who'd actually be affected to name their biggest concern before I proposed anything. One engineer raised an operational concern I hadn't fully weighed, which changed the final design. Because people could see their input actually shaped the outcome, the rollout had far less passive resistance than an earlier, similar change I'd pushed through by mandate, which technically succeeded but generated ongoing grumbling for months.

### Q12. Tell me about a time you had to give a struggling teammate honest feedback.

An engineer on an adjacent team I collaborated closely with was producing code that consistently needed heavy rework in review, and it was starting to slow down a shared deliverable. I asked for a direct, private conversation rather than raising it in a group setting, and I focused on specific, observable patterns — for example, three recent PRs missing error handling for the same class of failure — rather than a general assessment of their skill. I also asked what support would help, which surfaced that they hadn't had a proper walkthrough of our service's failure modes. Pairing them with a short onboarding session on that specific gap fixed the pattern within a few weeks, and the relationship stayed strong because the feedback was specific and paired with an offer to help.
