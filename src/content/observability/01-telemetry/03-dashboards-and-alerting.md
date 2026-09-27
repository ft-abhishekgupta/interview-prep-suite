---
title: Dashboards and Alerting
description: How to design dashboards that answer a question and alerts that page a human only when action is needed, from RED and USE to burn-rate alerting
difficulty: Core
tags: [observability, alerting, dashboards, sre, on-call]
---

A dashboard nobody reads and an alert nobody trusts are the two most common failures in observability practice. This page covers the frameworks for deciding what to show (RED, USE, golden signals) and what to alert on (symptoms, burn rate, multi-window), so both are built for the person who gets paged at 3am.

## RED for services, USE for resources

Two complementary checklists cover almost every dashboard you will ever build.

| RED (request-driven services) | Meaning | Example query shape |
|---|---|---|
| **R**ate | Requests per second | `sum(rate(http_requests_total[5m]))` |
| **E**rrors | Failed requests per second (or ratio) | `sum(rate(http_requests_total{status=~"5.."}[5m]))` |
| **D**uration | Latency distribution (not just average) | `histogram_quantile(0.99, rate(http_request_duration_seconds_bucket[5m]))` |

| USE (resources — CPU, disk, pool) | Meaning | Example |
|---|---|---|
| **U**tilisation | % time the resource was busy | CPU busy %, connection pool in-use % |
| **S**aturation | Work queued waiting for the resource | Run queue length, thread pool queue depth |
| **E**rrors | Count of resource-level errors | Disk I/O errors, dropped packets |

RED is what you put on a service dashboard; USE is what you put on an infrastructure dashboard. A service dashboard with no USE-style view of its dependencies is blind to "my CPU is fine but my connection pool is saturated."

## The four golden signals

Google's SRE book generalises RED/USE into four golden signals for any user-facing system: **latency, traffic, errors, saturation**. It's the same idea from a different angle — latency and errors are RED's duration and errors, traffic is RED's rate, and saturation borrows directly from USE. If you're asked for "the four golden signals" in an interview, this is the expected answer, and pointing out the overlap with RED/USE shows you understand it's one underlying idea, not three competing ones.

## Designing a dashboard that answers a question

The most common dashboard mistake is building one that shows everything instead of one that answers something. A good top-level service dashboard should let you answer, at a glance: **is this service healthy right now, and if not, where do I look next?**

```mermaid
flowchart TD
    A["Top row: RED for this service<br/>rate, error %, p50/p95/p99"] --> B{"Healthy?"}
    B -->|No, errors up| C["Row 2: error breakdown<br/>by endpoint, status code, dependency"]
    B -->|No, latency up| D["Row 2: latency breakdown<br/>by endpoint, downstream call"]
    B -->|Yes| E["Nothing to do — dashboard did its job"]
    C --> F["Row 3: recent deploys/config changes<br/>overlaid as annotations"]
    D --> F
```

> [!KEY]
> A dashboard's first row should let you triage in under 10 seconds. Everything below that is there to answer "why", not "whether."

## Alert on symptoms, not causes

An alert should fire when a **user-visible symptom** is present (error rate up, latency up, availability down), not on every internal cause that *might* lead to one. "CPU is at 85%" is a cause that may or may not matter; "p99 latency exceeds 2s for 5 minutes" is a symptom that always matters.

> [!WARNING]
> Cause-based alerts (disk 80% full, CPU 90%, one pod restarted) are useful as **diagnostic signals on a dashboard**, but paging on them directly trains on-call engineers to ignore pages, because most of them resolve on their own or don't affect users. Reserve pages for symptoms; keep causes as context you check once paged.

## Actionable alerts and the runbook link

Every alert that pages a human should be **actionable** — there must be something a human can do about it right now. If the answer to "what do you do when this fires" is "wait and see," it shouldn't page. Every paging alert should link directly to a runbook: what the alert means, likely causes ranked by probability, the first three commands/dashboards to check, and known mitigations.

> [!TIP]
> A senior answer to "how do you decide if an alert is worth keeping" is: *"I look at its page history — if it's fired 20 times and none required action, I either fix the underlying flakiness, raise the threshold, or delete it. An alert without a corrective action is noise."*

## Alert fatigue and how to measure it

Alert fatigue is the desensitisation that happens when on-call engineers receive too many low-value pages, causing them to (consciously or not) respond slower or dismiss real incidents. It's measurable:

| Metric | What it tells you |
|---|---|
| Pages per on-call shift | Rising trend = fatigue risk |
| % of pages with no action taken | High % = alert is miscalibrated or symptom-adjacent, not a real symptom |
| Time-to-acknowledge trend | Rising = engineers are deprioritising pages |
| % of pages outside business hours that could wait | Overly sensitive thresholds pushing non-urgent work into on-call hours |

A healthy target many SRE teams use: **fewer than 2 actionable pages per on-call shift** on average, with close to 100% of pages requiring genuine action.

## Thresholds vs anomaly detection vs burn-rate alerts

| Approach | How it works | Good for | Weakness |
|---|---|---|---|
| Static threshold | Fire if metric crosses a fixed value | Simple, well-understood signals (disk % full) | Doesn't adapt to daily/seasonal traffic patterns |
| Anomaly detection | Fire if metric deviates from a learned baseline | Traffic with strong daily/weekly seasonality | Harder to explain, can be noisy, needs history to train |
| Burn-rate alert | Fire based on how fast an error budget (from an SLO) is being consumed | User-impact-focused alerting tied directly to what you promised | Requires an SLO to already exist |

## Multi-window, multi-burn-rate alerting

This is the Google SRE-recommended pattern for SLO-based alerting: instead of one threshold, you alert on **burn rate over multiple time windows simultaneously**, so you catch both a sharp severe outage and a slow, sustained degradation, without a single fast blip causing a false page.

| Window pair | Burn rate threshold | Fires for | Typical severity |
|---|---|---|---|
| 5 min & 1 hour | 14.4x | A severe, fast-onset outage | Page immediately |
| 30 min & 6 hours | 6x | A significant sustained problem | Page immediately |
| 6 hours & 3 days | 1x | A slow burn that will exhaust the budget by month end | Ticket, not a page |

Requiring **both** a short and a long window to agree (e.g., "5 min AND 1 hour both show 14.4x burn") filters out momentary blips that resolve before they matter, while still catching genuine fast-onset incidents quickly. This is covered in depth with the underlying maths in the SLO page.

## Severity levels and routing

| Severity | Meaning | Routing | Example |
|---|---|---|---|
| Sev1 / P1 | Full outage or major user-facing impact | Page immediately, wake people up | Checkout down for all users |
| Sev2 / P2 | Partial degradation, clear user impact | Page during business hours, notify off-hours | Elevated errors for one region |
| Sev3 / P3 | Minor issue, no immediate user impact | Ticket, handled next business day | One non-critical batch job failed |
| Sev4 / P4 | Cosmetic / informational | Backlog | Log noise, a deprecated warning |

## On-call rotation, escalation, and maintenance windows

- **Rotation** — a schedule (weekly or shift-based) defining who is primary vs secondary on-call, so responsibility is never ambiguous.
- **Escalation policy** — if the primary doesn't acknowledge within N minutes, escalate to secondary, then to a manager or wider team; this protects against a single missed page becoming a prolonged outage.
- **Silencing / maintenance windows** — planned deploys or known-risky operations should suppress expected alerts for a bounded time window, otherwise real maintenance noise trains people to ignore pages exactly like alert fatigue does.

```mermaid
flowchart LR
    A["Raw metric<br/>crosses condition"] --> B{"Is it a symptom<br/>a user would notice?"}
    B -->|No| C["Log/dashboard only<br/>no page"]
    B -->|Yes| D{"Actionable right now?"}
    D -->|No| E["Ticket, review next day"]
    D -->|Yes| F{"In a maintenance window?"}
    F -->|Yes| G["Silenced"]
    F -->|No| H["Page primary on-call<br/>with runbook link"]
    H --> I{"Acked in N minutes?"}
    I -->|No| J["Escalate to secondary/manager"]
    I -->|Yes| K["Engineer investigates"]
```

## Cheat sheet

- RED (rate, errors, duration) for services; USE (utilisation, saturation, errors) for resources.
- Golden signals = latency, traffic, errors, saturation — the same idea, framed generically.
- Top row of a dashboard should answer "healthy or not" in under 10 seconds.
- Alert on symptoms (user-visible) not causes (CPU%, disk%) — causes are diagnostic context, not page triggers.
- Every paging alert needs a runbook link and a genuine action a human can take.
- Measure alert fatigue: pages/shift, % with no action taken, time-to-acknowledge trend.
- Multi-window multi-burn-rate alerting catches both fast outages and slow burns while filtering noise.
- Silence expected noise during maintenance windows or it trains people to ignore real pages.

## Common mistakes

| Mistake | Fix |
|---|---|
| Paging on CPU/disk thresholds directly | Page on user-visible symptoms; use resource metrics as diagnostic context |
| One giant dashboard with 40 panels | Top row answers "healthy?", deeper rows answer "why?" |
| Alerts with no runbook | Attach a runbook link with likely causes and first steps to every page |
| Never reviewing alert history | Periodically prune alerts with a high no-action rate |
| Single-window threshold alerts on SLO burn | Use multi-window multi-burn-rate to catch both fast and slow burns |
| No maintenance window during planned deploys | Silence expected alerts for the deploy's blast radius and duration |

## Summary

Good dashboards answer a specific question fast — "is this healthy, and if not, where do I look" — using RED for services and USE for resources, rather than displaying every metric available. Good alerting pages a human only for actionable, user-visible symptoms, links a runbook, and uses multi-window burn-rate techniques to catch both sudden outages and slow degradations without drowning on-call in noise. Alert fatigue is measurable and should be tracked and acted on just like any other reliability metric, because an ignored page is functionally the same as no alert at all.

## Top Interview Questions

### Q1. What is the RED method and when would you use it over USE?

RED stands for Rate, Errors, and Duration — the three things you want on a dashboard for any request-driven service: how many requests per second, what fraction are failing, and how long they take (as a distribution, not an average). It's the right lens for services because it's directly about the requests users are making. USE (Utilisation, Saturation, Errors) is the equivalent for resources like CPU, disk, or a connection pool — it answers "is this specific resource the bottleneck." You use RED at the service layer to know *if* something is wrong, and USE at the resource layer, often as the next step, to find out *what* underlying resource is causing it.

### Q2. Why should you alert on symptoms rather than causes?

A symptom (elevated error rate, high p99 latency, availability below target) is by definition something a user is experiencing right now, so acting on it is always justified. A cause (CPU at 85%, one pod restarted, disk at 80%) may or may not translate into user impact — plenty of systems run fine at 85% CPU, and a single pod restart behind a load balancer with healthy replicas is often invisible to users. If you page on causes, a large fraction of pages turn out to require no action, which trains on-call engineers to respond slower or ignore pages entirely — the well-documented alert fatigue problem. Causes still belong on dashboards as diagnostic context once you're already investigating a symptom-triggered page.

### Q3. What makes an alert "actionable", and what do you do with one that isn't?

An alert is actionable if, when it fires, there is a concrete, known step a human can take right now to mitigate or resolve it — rollback, restart, fail over, scale up, flip a flag. If the honest answer to "what do you do when this fires" is "wait and see if it resolves itself," it should not page a human; at most it belongs on a dashboard or as a low-priority ticket. For an alert that turns out not to be actionable in practice — reviewed by looking at its page history and finding a high percentage of pages with no corrective action taken — the fix is to either raise its threshold, convert it to a non-paging signal, or delete it outright. Keeping it as-is just erodes trust in every other alert.

### Q4. Explain multi-window, multi-burn-rate alerting and why a single threshold isn't enough.

A single fixed threshold on an SLO's error rate has an inherent tension: a short window (5 minutes) reacts fast but false-pages on brief blips that self-resolve, while a long window (6 hours) is stable but reacts too slowly to a genuine fast outage, burning a large chunk of the error budget before anyone is paged. Multi-window multi-burn-rate alerting requires **both** a short and a long window to simultaneously show a high burn rate before paging — for example, requiring 14.4x burn rate sustained across both a 5-minute and a 1-hour window. This filters out short blips (they won't sustain across the longer window) while still catching real fast-onset outages quickly (both windows agree almost immediately once the outage is severe enough). A slower, smaller burn rate over multi-hour/multi-day windows is routed as a ticket rather than a page, since there's time to address it without waking someone up.

### Q5. Your team's dashboard has 40 panels and nobody looks at it during an incident. What would you change?

I'd redesign it around the question it needs to answer in the first 10 seconds: is the service healthy right now, and if not, roughly where. That means a top row with only RED metrics for this service — request rate, error rate, and p50/p95/p99 latency — so anyone can triage at a glance. Everything else moves to lower rows organized by the likely next question: a breakdown of errors/latency by endpoint or downstream dependency for "why", and deploy/config-change annotations overlaid on the graphs for "did something change." I'd also split out anything that's really about a different audience (capacity/cost dashboards, business metrics) into separate dashboards, since mixing audiences is usually why dashboards balloon to 40 panels in the first place.

### Q6. What's the difference between static thresholds and anomaly detection for alerting, and when would you prefer each?

A static threshold fires when a metric crosses a fixed value regardless of context — simple to reason about and appropriate for signals with a clear absolute meaning, like "disk is 90% full" or "error rate above 5%." Anomaly detection instead learns a baseline (often accounting for daily/weekly seasonality) and fires on deviation from what's "normal" for that time — useful for traffic-shaped signals where "normal" genuinely varies a lot by hour and day, such as request volume for a consumer app with a strong evening peak. I'd prefer static thresholds for anything safety-critical and easy to reason about, since they're auditable and easy to explain during an incident review, and reserve anomaly detection for signals where a fixed threshold would either constantly false-page during normal peaks or stay silent during an off-peak-hours anomaly.

### Q7. How do you measure and address alert fatigue on a team?

I'd track pages per on-call shift, the percentage of pages that required no corrective action, and the trend in time-to-acknowledge — a rising ack time or a high no-action percentage are the clearest signals that engineers have started deprioritising or ignoring pages. To address it, I'd run a periodic alert review: for each alert, look at its firing history over the last month, and for any alert with a high false-positive/no-action rate, either raise its threshold, convert it from paging to a ticket, add a missing condition (like requiring sustained duration, not an instant spike), or delete it. The target most SRE teams aim for is under roughly two truly actionable pages per on-call shift on average — a number well above that is a strong signal the alerting needs pruning, not that the on-call engineer needs to try harder.

### Q8. Walk through what a good runbook attached to a paging alert should contain.

It should start with what the alert means in one sentence and what user impact it implies, so a half-asleep engineer can orient immediately. Next, a ranked list of the most likely causes based on history — "usually this is a downstream dependency timing out, less often a bad deploy, rarely a resource exhaustion issue" — because ranking by probability saves time versus a flat checklist. Then the first three concrete things to check (specific dashboard links, specific log queries, specific trace filters) and known mitigations for each likely cause (rollback command, feature flag to flip, scaling command). Finally, an escalation path — who to page next and after how long — if the on-call engineer can't resolve or diagnose it within an expected time.

### Q9. Why do the four golden signals overlap so much with RED and USE, and does it matter which one you cite in an interview?

The four golden signals (latency, traffic, errors, saturation) are essentially a generalisation that covers both RED and USE in one list: latency and errors map directly to RED's duration and errors, traffic maps to RED's rate, and saturation is borrowed straight from USE. It doesn't matter much which framing you lead with, as long as you can show you understand they're the same underlying idea from different angles — RED is the request-centric framing for services, USE is the resource-centric framing for infrastructure, and golden signals is Google's attempt to unify both into one vocabulary. What does matter in an interview is applying whichever one you cite concretely to the system being discussed, rather than reciting the acronym.

### Q10. How would you design alerting for a new microservice from scratch?

I'd start from the SLOs already defined for the service's key user journeys and build multi-window burn-rate alerts off those first, since they're directly tied to what was promised to users and inherently prioritise the right severity. Alongside that, I'd add a small set of RED-based sanity alerts (error rate spike, latency spike) as a backstop for cases where an SLO hasn't been defined yet for a given endpoint. I'd deliberately avoid adding cause-based alerts (CPU, memory, pod restarts) as pages initially — those go on the dashboard as diagnostic aids — and only add a cause-based page later if we find, from real incidents, that a specific resource signal reliably precedes user impact by enough time to be worth waking someone up early.

### Q11. What's the purpose of a maintenance window, and what happens if teams skip using them?

A maintenance window suppresses alerts for a known, planned, time-bounded operation — a deploy, a database migration, a planned failover test — so the expected transient noise (a brief error spike during a rolling restart, temporarily degraded latency during a migration) doesn't page anyone unnecessarily. If teams skip this, two bad things happen: on-call engineers get paged for something already known and being actively handled, wasting their attention, and — worse — repeated "known noisy deploy" pages train people to assume any page around deploy time is expected and safe to dismiss, which is exactly how a real regression introduced by that deploy gets missed. The window should be scoped tightly (only the alerts and time range actually affected) so it doesn't also mask an unrelated, genuine incident happening at the same time.

### Q12. Give an example of a dashboard panel that looks reassuring but is actually hiding a problem, and how you'd fix the panel.

An average latency panel showing a flat, low line is the classic case — averages are dominated by the high-volume fast requests and can completely hide a tail of requests at 3+ seconds that only affects, say, 1% of users but represents real, severe pain for them. The fix is to replace or supplement the average with p95/p99 latency lines (computed from a histogram, so they can be correctly aggregated across instances), since those specifically surface tail behaviour that an average mathematically cannot show. The same trap applies to error rate shown as a raw count instead of a rate/percentage — a count can look flat while traffic (and therefore the true error percentage) has dropped, silently masking a much higher error ratio.
