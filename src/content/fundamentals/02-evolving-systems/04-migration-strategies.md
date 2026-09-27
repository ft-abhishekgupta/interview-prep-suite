---
title: Migration and Modernisation
description: How the strangler fig pattern, branch-by-abstraction, shadow traffic and phased cutover let you replace a legacy system safely, and how to tell that story well
difficulty: Advanced
tags: [migration, legacy-systems, modernisation, strangler-fig]
---

Migration questions separate people who've read about the strangler fig pattern from people who've actually lived through a multi-quarter legacy replacement — the follow-up questions target verification, rollback and the political reality that old systems rarely get decommissioned on schedule.

## The strangler fig pattern

Named after the strangler fig vine that grows around a host tree until the tree can be removed, this pattern replaces a legacy system incrementally by routing traffic through a **facade** that sends each request to either the old or new system, one capability at a time, instead of a risky big-bang rewrite.

```mermaid
flowchart TD
    C["Client"] --> F["Routing facade"]
    F -->|"Capability A<br/>(migrated)"| New["New system"]
    F -->|"Capability B, C<br/>(not yet migrated)"| Old["Legacy system"]
    New -.->|"reads shared data<br/>during transition"| DB[("Shared data store")]
    Old --> DB
```

The facade is the key piece of infrastructure — an API gateway, a reverse proxy rule, or a feature-flagged branch in the calling code — that can redirect traffic per-capability without either system knowing about the other. Each migrated capability shrinks the legacy system's surface area a little further, until what remains is small enough to retire outright. The pattern's real value is that every step is independently shippable and reversible: if capability A's new implementation misbehaves, the facade routes it back to the old system without touching anything else.

> [!KEY]
> Strangler fig succeeds or fails on the facade's routing granularity. Route by coarse module and you inherit big-bang risk anyway; route by fine-grained capability (a single endpoint, a single business rule) and each cutover becomes small enough to verify and roll back independently.

## Branch-by-abstraction

Branch-by-abstraction is strangler fig applied *inside* a single codebase rather than across systems — useful when you're replacing an internal component (a payment gateway client, an ORM, a caching layer) without a long-lived feature branch. You introduce an abstraction (interface) in front of the component being replaced, migrate all callers to use the abstraction instead of the concrete implementation, build the new implementation behind the same abstraction, switch the implementation (often behind a flag, one caller or one environment at a time), and finally delete the old implementation and, if no longer useful, the abstraction itself.

```csharp
// Step 1: introduce the abstraction in front of the old concrete class
public interface IPaymentGateway { Task<PaymentResult> Charge(Money amount); }

// Step 2: old implementation now sits behind it, callers depend on the interface
public class LegacyGateway : IPaymentGateway { /* existing code, unchanged */ }

// Step 3: new implementation built behind the same abstraction
public class StripeGateway : IPaymentGateway { /* new code */ }

// Step 4: DI container decides which one — flip via config/flag, no caller changes
services.AddScoped<IPaymentGateway>(sp =>
    flags.IsEnabled("use-stripe-gateway") ? new StripeGateway() : new LegacyGateway());
```

This avoids the classic long-lived-branch trap: instead of one giant "replace the payment gateway" branch that merge-conflicts for weeks, every step lands on trunk immediately and is individually safe.

## Parallel run and shadow traffic

Before trusting a new system with real user-facing traffic, **shadow traffic** (also called dark launch or traffic mirroring) sends a copy of production requests to the new system in parallel with the old one, discards the new system's response, and compares the two outputs offline — zero risk to users because only the old system's response is ever actually returned.

| Comparison | What it validates |
|---|---|
| Response equality (old vs new) | Functional correctness of the new implementation |
| Latency (old vs new) | Whether the new system meets performance requirements |
| Error rate (new system only) | Whether the new system crashes or throws on real-world inputs old tests didn't cover |
| Divergence rate over time | Whether confidence is increasing as edge cases get fixed, before any real cutover |

A **parallel run** is the same idea over a longer window, sometimes with both systems' outputs logged and reconciled in batch (common for financial or billing migrations, where every discrepancy needs investigating before cutover is even considered). The discipline that makes this valuable is having a low, trending-to-zero divergence rate as an explicit, measured exit criterion — not a vague "it's been running a while, let's just switch".

## Dual writes and the consistency risk

**Dual writes** (writing to both the old and new data store from application code, in the same request) look like the obvious way to keep two data stores in sync during a migration, but they carry a specific consistency risk: if the write to the second store fails after the first succeeds (network blip, timeout, crash between the two calls), the stores silently diverge, and nothing detects it until a customer notices wrong data. There is no atomic transaction across two independent stores without a distributed transaction protocol, which most systems don't have.

> [!DANGER]
> Dual writes without reconciliation are a data-integrity time bomb — they work in every demo and diverge slowly and invisibly in production. If you must dual-write, pair it with a periodic reconciliation job that diffs the two stores and alerts on drift, or prefer change data capture instead.

**Change data capture (CDC)** is the safer alternative: instead of the application writing to both stores, it writes to just one (the source of truth), and a CDC pipeline (reading the database's transaction/replication log — e.g. Debezium reading a Postgres/MySQL binlog) streams every change to the new store asynchronously. This guarantees the new store eventually reflects every committed write, in order, without the application needing to know both stores exist, and without the dual-write failure mode.

## Backfill and cutover strategies

Migrating existing data combines a one-time **backfill** (copy all historical data into the new store, throttled and batched as described in schema migrations) with CDC to catch ongoing writes made *during* the backfill — the backfill job and CDC stream together guarantee no row is missed and no write is lost, regardless of how long the backfill takes.

Once data is flowing correctly, cutover moves live traffic from old to new. The three common shapes:

| Cutover strategy | Risk profile | Best for |
|---|---|---|
| Big bang (all traffic, all at once) | Highest — no gradual signal before full exposure | Small systems, low-stakes migrations, short maintenance windows |
| Incremental by tenant/customer | Contained blast radius per tenant; easy to pick a low-risk pilot tenant first | B2B SaaS with clearly separable tenants |
| Incremental by region/feature | Contained blast radius per slice; can react before wider exposure | Large consumer systems, geographically distributed traffic |

Incremental cutover (by tenant, region, or feature flag percentage) is preferred whenever the system allows slicing traffic that way, precisely because it turns one high-stakes decision into many small, reversible ones — the same principle behind canary deployments and expand-contract schema changes.

## Rollback and verifying correctness at each stage

Every stage of a migration needs its own rollback path, not one global "abort the whole migration" plan: rolling back a shadow-traffic stage means simply stopping the mirrored calls (zero user impact, since shadow traffic was never user-facing); rolling back a partial cutover means flipping the routing facade back to the old system for the affected slice; rolling back after full cutover but before decommissioning the old system means re-pointing the facade wholesale, which is why the old system must stay running, untouched and still receiving CDC updates, for a defined safety window after cutover — not deleted the day traffic moves.

Verification during migration relies on the same signals as shadow traffic and parallel run: automated diffing of old vs new outputs on real inputs, reconciliation jobs comparing data stores, and business-metric monitoring (order volume, revenue, error rate) around each cutover step, with an explicit rollback trigger threshold agreed before cutover, not decided live under pressure.

## Decommissioning the old system

Decommissioning is the step that "never happens" because, unlike migration itself, it has no visible feature to demo and no urgent deadline — it competes for engineering time against every other roadmap item and reliably loses unless someone makes it happen deliberately. What makes it happen: tracking a measurable, visible completion percentage (traffic share, capability count, tenant count) that a stakeholder outside the migrating team can see; setting a hard target date for decommissioning at the *start* of the migration, not after cutover; adding monitoring/alerting on the old system's remaining traffic so "is it actually safe to turn off" is a data question, not a guess; and, often most effectively, attaching a cost or risk narrative to keeping it alive (licence renewal deadline, security patching burden, the one engineer who understands it leaving) that makes leadership prioritise the final step.

## Migrating many legacy systems into one platform

When the goal is consolidating N legacy systems into one platform, the hard part shifts from technical risk to **sequencing and stakeholders**: each legacy system has its own owning team, its own users, and its own reasons its migration is "not now". The practical approach is to sequence by a combination of technical risk (migrate the simplest, lowest-stakes system first to prove the platform and build team confidence) and business value (prioritise the system whose replacement unlocks the most value or removes the most risk, even if it's harder), while explicitly *not* trying to migrate everything in parallel — shared platform teams get pulled in a dozen directions and every migration slows down. Naming an executive sponsor who can resolve cross-team prioritisation conflicts, and publishing a shared roadmap so each team knows roughly when their turn is coming, addresses the stakeholder side directly rather than leaving it to informal negotiation.

## Measuring progress and telling the story in an interview

Track migration progress with concrete, falsifiable numbers, not vague confidence: percentage of traffic/tenants/capabilities on the new system, count of remaining call sites hitting the legacy system (via telemetry, the same technique used for API deprecation), and open discrepancy count from parallel-run reconciliation trending to zero.

When asked to describe a migration in an interview, structure the answer around: the **why** (what was wrong with the legacy system — cost, risk, velocity), the **approach** (strangler fig, shadow traffic, incremental cutover — name the actual pattern), a **specific hard moment** (a discrepancy shadow traffic caught before cutover, or a rollback you executed and why), and the **outcome** in measurable terms (traffic migrated, incidents avoided, decommission achieved or a realistic plan to get there). Concrete numbers and one real complication you navigated are what separate this answer from a generic "we did a strangler fig migration" that could describe any project.

## Cheat sheet

- Strangler fig: route traffic through a facade, migrate one capability at a time, each step independently reversible.
- Branch-by-abstraction is strangler fig inside a single codebase — abstraction first, new implementation behind it, then switch and delete.
- Shadow traffic compares new-system output against old, discarded, zero user risk — validate before any real cutover.
- Dual writes risk silent divergence on partial failure; prefer CDC (read the transaction log) for reliable sync.
- Backfill (historical data) + CDC (ongoing writes) together guarantee no row is missed during migration.
- Incremental cutover (by tenant/region/feature) turns one big risky decision into many small reversible ones.
- Every migration stage needs its own rollback path — don't rely on one global "abort everything" plan.
- Decommissioning fails to happen unless it has a hard date, visible progress metric, and a named owner from day one.
- Migrating many legacy systems is a sequencing and stakeholder problem as much as a technical one — sequence by risk and value, not all-at-once.
- Tell the migration story with why, pattern used, one hard moment, and measurable outcome — not just "we did a rewrite".

## Common mistakes

| Mistake | Fix |
|---|---|
| Big-bang rewrite with one cutover date | Strangler fig with incremental, per-capability cutover |
| Dual-writing to old and new stores with no reconciliation | Use CDC, or add a reconciliation job that alerts on drift |
| Treating decommissioning as automatic once cutover finishes | Set a hard decommission date and owner at migration kickoff |
| Migrating all legacy systems in parallel with one platform team | Sequence explicitly by risk and business value |
| Declaring success at "cutover complete" | Track traffic/tenant percentage and discrepancy count to zero |
| Keeping the old system as the fallback with no monitoring on its remaining traffic | Instrument the old system so "safe to turn off" is a measured fact |
| No plan for what happens if the new system misbehaves post-cutover | Keep old system live and in sync for a defined safety window with a tested rollback |

## Summary

Strangler fig and branch-by-abstraction turn a risky big-bang rewrite into a sequence of small, independently reversible steps by routing through a facade or an interface one capability at a time. Shadow traffic and parallel runs validate correctness with zero user risk before any real cutover, CDC avoids the silent-divergence trap dual writes create, and incremental cutover by tenant or region contains blast radius the same way a canary deploy does. The part most teams underestimate is that decommissioning the old system and migrating many legacy systems at once are organisational problems — they need a hard date, a visible progress metric and a named owner, or they simply never finish.

## Top Interview Questions

### Q1. Explain the strangler fig pattern and why it's usually preferred over a full rewrite.

The strangler fig pattern replaces a legacy system incrementally: a routing facade sits in front of both systems and directs each request to either the old or new implementation, migrated one capability at a time, until the legacy system's remaining surface area is small enough to retire. It's preferred over a full rewrite because a big-bang rewrite concentrates all risk into one cutover date — if anything is wrong, everything is wrong, all at once, for all users — whereas strangler fig lets each migrated capability be verified and rolled back independently, with the legacy system continuing to handle everything not yet migrated. The trade-off is time and complexity: strangler fig takes longer overall and requires maintaining a routing layer and, temporarily, two systems, which a full rewrite avoids by definition — but that cost buys a dramatically lower risk profile.

### Q2. What is branch-by-abstraction and when would you use it instead of strangler fig?

Branch-by-abstraction applies the same incremental-replacement philosophy inside a single codebase rather than across two deployed systems: introduce an interface in front of the component being replaced, move all callers to depend on the interface instead of the concrete class, build the new implementation behind that same interface, switch which implementation is wired up (often per environment or behind a flag), and delete the old implementation once the switch is verified. I'd use it instead of strangler fig when the thing being replaced is an internal component — an ORM, a caching layer, a third-party SDK client — rather than an entire externally-facing system, and specifically to avoid a long-lived feature branch that would otherwise accumulate painful merge conflicts while the replacement is built.

### Q3. What is shadow traffic (dark launch) and what does it actually prove?

Shadow traffic duplicates real production requests and sends a copy to the new system in parallel with the old one, while only ever returning the old system's response to the actual user — the new system's response is captured and compared offline, never shown to anyone. This proves functional correctness (do old and new produce the same output on real, messy production inputs, not just test cases), performance characteristics (is the new system's latency acceptable under real load), and stability (does the new system error or crash on inputs the old system handles fine) — all with zero risk to users, since nothing the new system does is ever user-visible. What it doesn't prove is behaviour under real write traffic if it's only mirroring reads, or genuine end-to-end user experience, which is why it's a precursor to, not a replacement for, a careful incremental cutover.

### Q4. Why are dual writes risky during a data migration, and what would you use instead?

Dual writes mean application code writes to both the old and new data store within the same logical operation, and the risk is that there's no atomic guarantee across two independent stores — if the second write fails after the first succeeds (a timeout, a crash, a network blip), the two stores silently diverge, and nothing detects this until a customer hits inconsistent data or a report doesn't reconcile. Instead, I'd prefer change data capture: the application writes to only the source-of-truth store, and a CDC pipeline reads that store's transaction/replication log and streams every committed change to the new store asynchronously. This guarantees eventual consistency without the application needing to coordinate two writes, and without the specific silent-divergence failure mode dual writes introduce. If dual writes are unavoidable for some reason, I'd pair them with a scheduled reconciliation job that diffs the two stores and alerts on any drift.

### Q5. How would you decide between a big-bang cutover and an incremental cutover by tenant or region?

I'd default to incremental unless the system genuinely can't be sliced that way or the stakes are low enough that a big bang's risk is acceptable. Incremental cutover — by tenant for B2B systems, by region or a traffic percentage for consumer systems — contains the blast radius of any problem to a small, known slice, gives an early, real signal before full exposure, and makes rollback for that slice cheap and fast. Big bang makes sense for genuinely small or low-stakes systems where the overhead of building a slicing mechanism and running two systems in parallel for weeks costs more than the incremental risk it would avoid, or where the system architecturally can't be partitioned (a single global batch job, for instance). The deciding question I'd ask: "if this cutover goes wrong, how many customers does it affect, and how fast can I revert?" — if the honest answer to a big bang is "everyone, and reverting takes hours," that's the case for incremental.

### Q6. A shadow traffic comparison shows a 3% divergence rate between old and new system outputs that isn't shrinking over time. What would you do?

I wouldn't proceed to cutover — a non-shrinking divergence rate means there's a real, unresolved correctness gap, not just noise that will self-resolve. I'd start by categorising the divergences: are they concentrated in a specific input pattern (a particular data shape, a specific customer segment, an edge case like empty or null fields), or spread evenly across all traffic? Categorising usually reveals whether it's a handful of bugs in the new implementation (fixable, and I'd expect the rate to drop once fixed) or a fundamental behavioural difference that needs a product decision (e.g. the new system correctly fixes a bug the old system had, and 3% of "divergence" is actually the old system being wrong). I'd treat "divergence trending to zero" as an explicit, measured exit criterion for shadow traffic, and not schedule cutover until it's met or consciously overridden with a documented reason.

### Q7. Why does decommissioning the old system after a migration so often not happen, and how do you make sure it does?

It doesn't happen because, unlike the migration itself, decommissioning has no new feature to demo, no urgent external deadline once cutover is done, and the old system quietly costs nothing extra to leave running in the short term — so it loses the prioritisation fight against literally any other roadmap item with a visible deadline. I make it happen by treating decommissioning as part of the migration's definition of done from the start, not an optional follow-up: setting a hard target date at kickoff, tracking a visible progress metric (traffic percentage still on the old system) that a stakeholder outside the team can see, and attaching a concrete cost or risk to delay — an upcoming licence renewal, an unpatched security vulnerability, or the fact that the one engineer who understands the old system is leaving. Naming a real deadline and a real cost turns "we should get to that eventually" into a prioritised task.

### Q8. Your organisation needs to migrate ten legacy systems onto one new platform. How would you sequence that, given every legacy system's owning team thinks theirs should wait?

I would sequence primarily by a mix of technical risk and business value rather than trying to run all ten in parallel, which would spread a shared platform team too thin and slow every migration down simultaneously. I'd start with the simplest, lowest-stakes system to prove the platform actually works end-to-end and build organisational confidence, then prioritise the remaining systems by where migrating unlocks the most value or removes the most risk — even if that system is harder — rather than by whichever team is loudest. On the stakeholder problem specifically, I'd get an executive sponsor named upfront who can resolve cross-team prioritisation conflicts (since no individual engineering team can force another team's timeline), and publish a shared roadmap so every owning team can see roughly when their migration is scheduled, which reduces the "why not us first" friction considerably.

### Q9. What would make you decide to roll back a migration after cutover has already happened for a slice of traffic?

I'd roll back if the automated verification signals I set up before cutover — error rate, latency, business metrics, or reconciliation discrepancy count for that specific slice — cross a pre-agreed threshold, the same discipline as a canary deployment's automated rollback criteria, rather than waiting for a human to notice and debate it. Practically, rolling back a partial cutover means flipping the routing facade back to the old system for the affected tenant/region/feature slice, which is exactly why the old system needs to stay running, untouched, and still receiving CDC updates for a defined safety window after cutover rather than being decommissioned immediately — you need somewhere to roll back to. I'd also make sure the rollback itself is tested before relying on it in production, not assumed to work because it looks simple on paper.

### Q10. How do you verify correctness during a migration, beyond just "the new system passed its unit tests"?

Unit tests validate the new system against inputs someone thought to write — they don't validate it against the actual messy shape of production data and traffic. I'd add shadow traffic or a parallel run comparing the new system's output against the old system's output on real production requests, with automated diffing rather than manual spot-checking, and track the divergence rate as an explicit number trending toward zero. For data migrations specifically, I'd run a reconciliation job that compares record counts and checksums between the old and new stores on a schedule, alerting on any drift rather than assuming a one-time backfill was sufficient. The combination — behavioural comparison on live traffic plus data reconciliation — catches the class of bugs that only show up on real-world inputs, which unit tests by construction can't cover.

### Q11. How would you describe a migration project you led in an interview, in a way that demonstrates seniority rather than just listing what was replaced?

I'd structure it around four things: why the migration was needed (concretely — rising incident rate, an unsupported vendor, a scaling ceiling, not just "it was old"), the approach and the actual pattern used (strangler fig with a routing facade, shadow traffic to validate before cutover, incremental cutover by tenant), a specific hard moment that shows judgement (a discrepancy shadow traffic surfaced that would have caused a billing error, or a rollback I executed for one tenant slice and why), and the measurable outcome (percentage of traffic migrated, incidents avoided, or if decommissioning isn't complete, a concrete, dated plan to get there rather than vague optimism). Naming the actual pattern and one real complication is what distinguishes this from a generic "we did a big migration" answer — it shows I understood the risk model, not just that I executed a checklist.

### Q12. What metrics would you put on a dashboard to track a long-running migration's progress, and who would look at it?

I'd track: percentage of traffic (or tenants, or capabilities, depending on what's being migrated) currently served by the new system, since that's the single number that answers "how far along are we"; open discrepancy count from ongoing reconciliation or shadow-traffic comparison, ideally trending to zero, since a high or flat count means correctness risk remains; count of remaining call sites or integrations still hitting the legacy system, found via telemetry the same way you'd find remaining callers of a deprecated API; and, closer to the end, remaining traffic on the old system specifically, since that's the number that determines whether decommissioning is actually safe. I'd make this dashboard visible to engineering leadership and the executive sponsor, not just the migrating team, specifically because visible, external accountability is what prevents the final decommissioning step from silently falling off the roadmap once the exciting part of the migration is done.
