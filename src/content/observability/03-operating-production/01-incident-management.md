---
title: Incident Management
description: The lifecycle from detection to blameless postmortem, why the incident commander does not debug, and how to talk about your worst incident in an interview
difficulty: Core
tags: [observability, incident-management, sre, on-call, postmortem]
---

Every senior interview eventually asks you to walk through an incident — how you found it, what you did first, and what changed afterward. This page covers the lifecycle, the roles that make a large incident manageable instead of chaotic, the single rule that separates good responders from bad ones, and how to structure a blameless postmortem that actually prevents a repeat.

## The incident lifecycle

```mermaid
flowchart LR
    A["Detect"] --> B["Triage"]
    B --> C["Declare"]
    C --> D["Mitigate"]
    D --> E["Resolve"]
    E --> F["Review"]
    F -.->|"action items"| A
```

| Stage | What happens | Typical duration target |
|---|---|---|
| Detect | An alert fires or a human notices impact | Seconds to minutes (this is what MTTD measures) |
| Triage | Confirm real impact, gauge scope/severity | Minutes |
| Declare | Formally open an incident, assign roles | Immediate once triage confirms real impact |
| Mitigate | Stop the bleeding — rollback, failover, flag flip | Minutes to tens of minutes |
| Resolve | Confirm the symptom is gone and stays gone | Varies |
| Review | Blameless postmortem, action items | Within days of resolution |

> [!KEY]
> Mitigate and resolve are **not the same step**. Mitigation stops user impact now (often without knowing the root cause); resolution means the underlying issue is actually fixed. Conflating them is why incidents drag on — teams wait to understand *why* before doing the thing that would stop the pain *now*.

## Severity classification

| Severity | Definition | Response expectation |
|---|---|---|
| Sev1 | Full outage or severe impact to a critical user journey (e.g., checkout, login down for all users) | Immediate, all-hands, executive visibility |
| Sev2 | Partial degradation, clear but bounded user impact (one region, one feature) | Immediate response during and outside business hours |
| Sev3 | Minor issue, workaround exists, limited user impact | Handled in normal working hours |
| Sev4 | Cosmetic, internal-only, or no user impact | Backlog, no urgency |

## Incident roles

Large incidents fail not from lack of skill but from **lack of coordination** — everyone debugging, nobody communicating, decisions made twice or not at all. Defined roles fix this.

| Role | Responsibility | Explicitly does NOT do |
|---|---|---|
| Incident Commander (IC) | Owns the incident's overall direction: coordinates responders, makes the call to mitigate, decides severity, declares resolution | Does not personally debug the code — stays one level above the details |
| Communications lead | Updates stakeholders, status pages, and leadership on a set cadence | Does not make technical mitigation decisions |
| Operations/subject-matter responders | Actually investigate and execute the technical mitigation | Does not unilaterally decide to escalate severity or notify customers |
| Scribe | Timestamps every action, decision, and finding in real time | Does not participate in the technical debugging itself |

> [!WARNING]
> The Incident Commander not debugging is the most commonly missed rule in interviews. If the IC gets pulled into staring at logs, nobody is tracking the overall state, coordinating parallel workstreams, deciding when to escalate, or protecting the team from interruptions — and a fixable technical problem turns into a mismanaged one. The IC's job is coordination and decisions, not typing commands.

## Communication cadence

Set a fixed cadence and stick to it even when there's nothing new — silence during an incident is worse than "no update yet, still investigating," because stakeholders fill silence with worse assumptions.

| Severity | Typical update cadence |
|---|---|
| Sev1 | Every 15–30 minutes, even if just "still investigating" |
| Sev2 | Every 30–60 minutes |
| Sev3/4 | On resolution, or once at the end of the day |

## Mitigate before you diagnose

This is the single most important rule in incident response, and the one that most distinguishes senior from junior responders in an interview answer.

> [!DANGER]
> Do not spend the first 20 minutes of a Sev1 trying to understand *why* before doing something that will *stop it*. Root-causing while users are actively impacted is the wrong order of operations.

The standard mitigation toolkit, roughly in order of how fast each one is to execute:

```mermaid
flowchart TD
    A["Impact confirmed"] --> B{"Recent deploy?"}
    B -->|Yes| C["Rollback"]
    B -->|No| D{"Recent config/flag change?"}
    D -->|Yes| E["Revert config / flip flag off"]
    D -->|No| F{"One dependency/region failing?"}
    F -->|Yes| G["Fail over / route around it"]
    F -->|No| H{"Overloaded, not broken?"}
    H -->|Yes| I["Shed load / rate limit / scale out"]
    H -->|No| J["Deeper investigation needed<br/>— now bring in diagnosis"]
```

| Mitigation | When it applies | Speed |
|---|---|---|
| Rollback | A recent deploy correlates with the start of impact | Fastest, highest-confidence first move |
| Feature flag off | A recent flag flip correlates with impact | Very fast if flags are already wired for this |
| Failover | One dependency, AZ, or region is unhealthy | Fast if failover is pre-built and tested |
| Shed load / rate limit | System is overloaded, not broken | Fast, buys time even if imperfect |
| Scale out | Genuinely under-provisioned for current load | Slower — bounded by autoscaling lag |

A strong interview answer names this explicitly: *"My first move in any Sev1 is to ask what changed recently — a deploy, a config change, a flag — because reverting a recent change is almost always faster and safer than root-causing live. I only move to deep diagnosis once mitigation options are exhausted or nothing recent correlates."*

## Blast radius assessment

Before and during mitigation, quickly establish **how much is actually affected** — this shapes both severity and the urgency of the response.

| Question | Why it matters |
|---|---|
| All users or a subset (region, customer tier, platform)? | Determines severity and whether a targeted mitigation (e.g., regional failover) is possible |
| One endpoint/feature or the whole service? | A narrow blast radius may allow disabling just that feature instead of a full rollback |
| Is it getting worse, stable, or already recovering? | Changes urgency — a stable, bounded issue can tolerate more careful diagnosis |
| Are other services affected, or is it contained? | A shared dependency failing can widen blast radius fast — check downstream consumers early |

## Blameless postmortems

A blameless postmortem assumes everyone involved made reasonable decisions given the information they had at the time, and focuses on **why the system and process allowed the incident**, not who to blame. This isn't a soft-skills nicety — it is what makes people report near-misses and be honest about mistakes, which is the raw material a postmortem needs to actually work.

A good postmortem structure:

1. **Summary** — what happened, user impact, duration, severity.
2. **Timeline** — every detection, decision, and action with timestamps (this is what the scribe's real-time notes become).
3. **Contributing factors** — the conditions that allowed it (not a single "root cause").
4. **What went well / what didn't** — including the response itself, not just the original trigger.
5. **Action items** — specific, owned, with a due date, tracked to completion.

> [!KEY]
> "Blameless" does not mean "no accountability." It means the accountability is for **fixing the system**, not punishing the person who happened to be the one to trigger or miss something that anyone on the team could plausibly have triggered or missed.

## Action items that actually get done

Postmortem action items famously rot in a backlog. The fix is structural: every action item gets a single named owner (not a team), a due date, and a priority tied to the incident's severity — and a lightweight recurring review (many teams check in on open action items in a weekly or biweekly meeting) so they don't silently disappear. An action item with no owner is not an action item, it's a wish.

## Contributing factors vs root cause

Modern incident practice avoids the phrase "root cause" because most real incidents have **multiple contributing factors**, and picking one as "the" cause tends to stop the investigation too early and invite blame ("the engineer who wrote that config"). Better framing: "this incident required *all* of the following to be true — a bad config value, a validation gap that didn't catch it, an alert that didn't exist for this case, and a rollback path that wasn't tested recently. Fixing any one of these would have prevented or shortened the incident."

| Contributing factor example | Category |
|---|---|
| A deploy skipped canary because of time pressure | Process |
| No alert existed for this specific failure mode | Detection gap |
| The runbook for this dependency was out of date | Documentation |
| The on-call engineer was newly onboarded and unfamiliar with the system | Training/staffing |
| A retry storm amplified a small initial blip into a full outage | Technical/architectural |

## Incident metrics

| Metric | Measures | Why it matters |
|---|---|---|
| MTTD (mean time to detect) | Time from issue starting to being noticed | Reflects monitoring/alerting quality |
| MTTA (mean time to acknowledge) | Time from alert firing to a human acknowledging | Reflects on-call responsiveness and alert fatigue |
| MTTM (mean time to mitigate) | Time from acknowledgement to user impact stopping | Reflects mitigation readiness — rollback speed, failover readiness |
| MTTR (mean time to resolve) | Time from start to full resolution (underlying issue actually fixed) | Broadest measure, includes root-cause work, not just impact stoppage |

Interviewers sometimes conflate MTTM and MTTR — a sharp answer distinguishes them: *"MTTM is how fast we stopped user pain; MTTR is how fast we actually fixed the underlying problem. We optimise hard for MTTM because that's what users feel — MTTR matters but can happen calmly after impact is already gone."*

## What to say about your worst incident

Interviewers ask this to see how you talk about failure, not to judge the failure itself. A strong structure: (1) concrete impact and scope, stated plainly, no minimizing; (2) what you did first and why — ideally showing the mitigate-before-diagnose instinct; (3) the actual contributing factors, stated as a system/process gap, not a person's mistake; (4) the specific, concrete change that came out of it, and evidence it actually stuck (not just "we added a Jira ticket"). Avoid both extremes — deflecting all responsibility, and self-flagellating as if it were purely personal failure. The senior signal is treating it as a system that needed hardening.

## Cheat sheet

- Lifecycle: detect → triage → declare → mitigate → resolve → review — mitigate and resolve are distinct steps.
- Severity drives response urgency and communication cadence — define both in advance, not during the incident.
- Incident Commander coordinates and decides; they do not personally debug.
- Mitigate before you diagnose: rollback, flag flip, failover, or shed load beats root-causing live.
- Assess blast radius early — it shapes both severity and whether a narrow, fast mitigation is possible.
- Blameless means accountability for fixing the system, not punishing the person.
- "Contributing factors" (plural) beats "root cause" (singular) — most incidents need several things to go wrong together.
- Action items need a named owner, a due date, and a recurring review, or they silently rot.
- MTTD/MTTA/MTTM/MTTR are distinct — know which one each response improvement actually targets.

## Common mistakes

| Mistake | Fix |
|---|---|
| Root-causing before mitigating during active user impact | Mitigate first (rollback/flag/failover/shed load), diagnose after |
| Incident Commander doing hands-on debugging | IC coordinates and decides; delegate debugging to responders |
| Silence during a long incident | Fixed communication cadence, even "still investigating" updates |
| Blaming an individual in the postmortem | Frame around contributing factors and system/process gaps |
| Action items with no owner or due date | Assign a single owner, a due date, and review them on a cadence |
| Treating MTTR as the only metric that matters | Track MTTD/MTTA/MTTM separately — they diagnose different weaknesses |

## Summary

Incident management works when detection, mitigation, and resolution are treated as separate steps, with mitigation prioritised first because it stops user pain fastest, independent of understanding the full cause. Defined roles — especially an Incident Commander who coordinates rather than debugs — keep a chaotic, multi-person response organised, and a fixed communication cadence prevents silence from becoming its own crisis. Blameless postmortems that identify multiple contributing factors, paired with owned and tracked action items, are what actually turn an incident into a system that's harder to break the same way twice.

## Top Interview Questions

### Q1. Walk me through the incident lifecycle.

Detection is when an alert fires or a human notices impact — this is what MTTD measures. Triage confirms the impact is real and gauges rough scope and severity. Declaring formally opens the incident and assigns roles (commander, comms, responders), which matters because it's the point coordination structure kicks in rather than several people independently investigating. Mitigation stops user-facing impact — rollback, failover, a flag flip, shedding load — ideally without yet needing the full root cause. Resolution means the underlying issue is actually fixed, not just the symptom suppressed. Review is the blameless postmortem, producing owned action items that feed back into preventing a repeat, closing the loop.

### Q2. Why shouldn't the incident commander also be the person debugging the issue?

Because coordination is a full-time job during a live incident: tracking overall state, deciding when to escalate severity, managing communication cadence, keeping parallel workstreams from colliding, and making the call on when to mitigate versus keep investigating. If the IC is heads-down in logs, none of that coordination is happening, decisions get made twice or not at all, and the team loses the one person who's supposed to have the full picture. The IC role is explicitly about staying one level above the technical details — they ask responders for status and make calls based on it, they don't personally run the debugging commands.

### Q3. What does "mitigate before you diagnose" mean, and why is it the most important incident response rule?

It means your first priority during active user impact is stopping that impact — via rollback, reverting a config or feature flag, failing over away from an unhealthy dependency or region, or shedding load — rather than spending that time trying to fully understand *why* it's happening. It's the most important rule because root-causing live, while users are actively affected, trades certain ongoing harm for the uncertain and often much slower reward of understanding the exact mechanism — when in the large majority of cases a recent change (a deploy, a config, a flag) is the actual cause and reverting it is both faster and safer than debugging forward from first principles. You still need to diagnose eventually, but that work happens comfortably after impact has already stopped.

### Q4. How would you assess blast radius during an active incident, and why does it matter?

I'd quickly establish whether it's all users or a bounded subset (one region, one customer tier, one platform), whether it's one feature/endpoint or the whole service, and whether the trend is worsening, stable, or already recovering — checking dashboards sliced by these dimensions rather than only a single aggregate view. This matters because it directly shapes both severity classification and what mitigation options are available: a blast radius contained to one region might be solvable with a regional failover in minutes, while a blast radius affecting all users of a core feature likely needs a full rollback and a higher severity, more visible response. Underestimating blast radius risks under-responding to something serious; overestimating it can cause unnecessary panic and pull in more people than the incident actually needs.

### Q5. What makes a postmortem "blameless", and why does that actually improve reliability rather than just being a soft-skills nicety?

A blameless postmortem assumes everyone involved made reasonable decisions given the information available to them at the time, and it focuses the analysis on the system and process gaps that allowed the incident, not on which individual to hold responsible. It improves reliability because the alternative — a blame-oriented postmortem — makes people defensive, incentivises hiding near-misses and honest mistakes, and produces a document optimised for avoiding personal consequences rather than genuinely finding every contributing factor. Blameless doesn't mean no accountability; it means the accountability is directed at fixing the system (adding the missing alert, hardening the validation gap, updating the stale runbook) rather than at punishing whoever happened to trigger or miss something that, given the same gaps, most people on the team could plausibly have also triggered or missed.

### Q6. Why do modern postmortems prefer "contributing factors" over a single "root cause"?

Most real incidents require several independent things to go wrong simultaneously — a bad config change, a validation gap that didn't catch it, a missing alert for that specific failure mode, and an untested rollback path, for example — and any single one of those alone often wouldn't have caused the outage or would have been caught and fixed quickly. Labelling one of these as "the" root cause tends to stop the investigation too early, invites blaming whichever factor is closest to a specific person's action (like the config change), and can lead to fixing only that one thing while leaving the other equally real gaps in place, virtually guaranteeing a different but related incident later. Naming all contributing factors as a set makes clear that fixing any one of them would have prevented or shortened the incident, and pushes the team toward multiple, independent hardening actions instead of one narrow fix.

### Q7. What's the difference between MTTD, MTTA, MTTM, and MTTR, and which would you prioritise improving first?

MTTD (mean time to detect) measures how long an issue exists before it's noticed, reflecting monitoring and alerting coverage. MTTA (mean time to acknowledge) measures how long from an alert firing to a human actually picking it up, reflecting on-call responsiveness and alert fatigue. MTTM (mean time to mitigate) measures how long from acknowledgement to user impact actually stopping, reflecting how ready your mitigation tooling (rollback, failover, flags) is. MTTR (mean time to resolve) measures the full time to genuinely fix the underlying issue, which is broader and includes calmer root-cause work that can happen after impact has stopped. I'd generally prioritise MTTD and MTTM first, since detection and mitigation speed most directly determine how much users actually suffer — MTTR matters for engineering health and repeat-incident risk, but it doesn't carry the same immediate user-facing cost once mitigation has already stopped the bleeding.

### Q8. How should communication cadence differ by incident severity, and what happens if a team goes silent during a Sev1?

For a Sev1, updates should go out roughly every 15-30 minutes to stakeholders and any status page, even when the update is just "still investigating, no new information" — the point is to establish a reliable rhythm stakeholders can rely on. Lower severities can use a longer cadence, sometimes just a single end-of-day or on-resolution update for a Sev3/4. If a team goes silent during a Sev1, stakeholders and leadership fill that silence with their own assumptions, usually worse than reality, escalate through side channels that distract responders, and lose confidence in the team's competence independent of how well the actual technical response is going — silence itself becomes a second, compounding problem on top of the original incident.

### Q9. Tell me about your worst production incident and what you'd do differently.

I'd describe the concrete scope and duration of impact honestly, without minimizing it, then walk through what I actually did first — ideally showing a mitigate-first instinct (checking for a recent deploy or config change and reverting it) rather than diving straight into root-causing while users were still affected. I'd name the real contributing factors as a system/process gap — for example, a missing alert for that specific failure mode, or a rollback path that hadn't been exercised recently and took longer than expected — rather than framing it as a personal mistake, mine or anyone else's. I'd close with the specific, concrete change that came out of it and evidence it actually stuck, such as a new alert that has since fired correctly, or a runbook that was used successfully in a later incident — showing the postmortem process worked, not just that a ticket was filed.

### Q10. What's the risk of skipping the "declare" step and just having engineers informally start fixing an incident?

Without a formal declaration, there's no single source of truth for who's involved, what's already been tried, and what the current best understanding of scope and severity is — different people can end up duplicating investigation, making conflicting changes simultaneously (one person rolling back while another is mid-deploy of a fix), or simply not realising how serious the situation actually is because there's no shared severity classification driving urgency. Declaring formally assigns roles (even informally, "you're doing comms, I'll coordinate"), starts the communication cadence, and creates the scribe's timeline that the eventual postmortem depends on — skipping it doesn't just lose process ceremony, it measurably increases the odds of wasted or conflicting effort during the exact moment that's most costly.

### Q11. How do you decide what should become a paging alert versus what should just be tracked as an incident metric?

A paging alert should fire on symptoms that are both user-visible and require timely human action — the earlier dashboards and alerting page covers this in depth — while incident metrics like MTTD, MTTA, MTTM, and MTTR are retrospective measures of how well the whole detect-to-resolve process performed, used to find systemic weaknesses (chronically slow acknowledgement suggesting alert fatigue, or slow mitigation suggesting missing rollback automation) rather than to trigger action on any single incident. In other words, alerts are the real-time trigger mechanism, and incident metrics are the aggregate feedback loop you review afterward, typically across many incidents, to decide where to invest in better tooling, training, or process.

### Q12. A recurring incident keeps happening despite a postmortem being written each time. What would you check?

First, whether the action items from the previous postmortems were actually completed — a shockingly common failure mode is a well-written postmortem whose action items were never assigned a real owner and due date, or were assigned but never reviewed again and quietly dropped from the backlog. Second, whether the postmortem correctly identified all the contributing factors rather than stopping at a convenient single "root cause" — if only the most visible factor was addressed each time, the other latent gaps remain and can resurface through a slightly different trigger. Third, whether the fixes were actually verified to work — an action item marked "done" that was never tested against a similar scenario (a fire drill or chaos test) can give false confidence that the gap was closed when it wasn't.
