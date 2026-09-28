---
title: Zero Downtime Deployments
description: The preconditions, sequence and rollback plan behind a deploy that users never notice, covering health checks, canaries, feature flags and mixed-version traffic
difficulty: Advanced
tags: [deployment, devops, reliability, feature-flags]
---

Zero downtime deployment questions test whether you understand that "no downtime" is an emergent property of several disciplines working together — statelessness, compatibility, health checks, and draining — not a feature you turn on. Interviewers usually push on what happens *during* the window when two versions run at once.

## Preconditions

Zero downtime is impossible without these already in place; skipping any one of them means the deploy sequence below can't actually protect users.

| Precondition | Why it's required |
|---|---|
| Stateless services | Any instance can be killed or added without losing session state |
| Backward-compatible changes | Old and new code (and schema) must coexist during rollout |
| Health checks (readiness + liveness) | The load balancer must know when an instance is actually ready for traffic |
| Graceful shutdown | An instance must finish in-flight work before it stops accepting new work and exits |

> [!KEY]
> Zero downtime deployment is really "zero downtime *given* backward compatibility and statelessness" — most of the hard work happens in change design, not in the deploy tool itself.

## Connection draining and graceful shutdown

When an instance is marked for removal, it must stop receiving *new* requests immediately (removed from load balancer rotation) while being given time to finish requests already in flight. This is **connection draining**: the load balancer stops routing new traffic to the instance, and the instance itself, on receiving `SIGTERM`, stops accepting new connections but lets active ones complete before exiting.

```csharp
// ASP.NET Core: hook shutdown to finish in-flight work before exiting
public void ConfigureServices(IServiceCollection services) {
    services.Configure<HostOptions>(opts => {
        opts.ShutdownTimeout = TimeSpan.FromSeconds(30); // grace period for in-flight requests
    });
}
```

> [!WARNING]
> A `SIGKILL` (hard kill, no grace period) instead of `SIGTERM` mid-deploy will drop in-flight requests regardless of how well the rest of the pipeline is designed. Orchestrators (Kubernetes, ECS) send `SIGTERM` first and only `SIGKILL` after a configurable grace period — make sure that grace period exceeds your longest realistic request duration.

## The deploy sequence

```mermaid
flowchart TD
    A["New instances start"] --> B["Readiness probe passes"]
    B --> C["Load balancer adds<br/>instance to rotation"]
    C --> D["Traffic split:<br/>old + new both serving"]
    D --> E["Old instance marked<br/>for removal"]
    E --> F["Load balancer stops<br/>routing new traffic to it"]
    F --> G["In-flight requests<br/>finish (drain)"]
    G --> H["Old instance<br/>terminates"]
    H --> I{"More old<br/>instances?"}
    I -->|"Yes"| E
    I -->|"No"| J["Rollout complete"]
```

This rolling sequence means old and new code serve traffic **simultaneously** for the whole rollout window — the reason every other section in this topic keeps returning to backward/forward compatibility.

## Database changes and the two-phase approach

Database changes can't be "rolled out gradually" the way application instances can — there's one schema, shared by every instance regardless of version. The two-phase approach is expand-contract applied to a deploy: phase one ships only additive, backward-compatible schema changes (new nullable column, new table) *before* the code that depends on them; phase two, after the rollout completes and the old code is confirmed gone, ships the cleanup (drop old column) as its own separate, later deploy. Never ship a destructive schema change in the same deploy as the code that assumes it.

## Feature flags: separating deploy from release

A **deploy** ships code to production; a **release** turns behaviour on for users. Feature flags let these happen independently: new code merges and deploys dark (flag off), gets validated in production with zero user-facing risk, then is released by flipping the flag — no redeploy required, and instantly reversible by flipping it back.

| Flag type | Typical lifespan | Cleanup discipline |
|---|---|---|
| Release flag | Days to weeks | Remove once fully rolled out to 100% |
| Experiment flag (A/B) | Weeks | Remove once the experiment concludes and a winner is picked |
| Ops/kill-switch flag | Indefinite | Keep, but document and monitor it |
| Permission/entitlement flag | Indefinite | Keep as part of the product's access model |

> [!DANGER]
> Flags that outlive their purpose become invisible technical debt — dead code paths nobody dares delete because nobody's sure which flag combinations are still reachable. Track flags with an owner and a planned removal date at creation time, not as an afterthought.

## Canary releases and automated rollback

A canary release routes a small percentage of real traffic (often 1–5%) to the new version while the rest continues on the old version, comparing error rate, latency and business metrics between the two before proceeding.

| Rollback trigger | Typical threshold |
|---|---|
| Error rate | > baseline + fixed delta (e.g. +2% absolute) for N minutes |
| p99 latency | > baseline × 1.5 for N minutes |
| Health check failures | Any instance failing readiness repeatedly |
| Business metric (e.g. checkout success rate) | Drop below an agreed floor |

Automating the rollback decision (rather than paging a human to eyeball a dashboard) is what makes canary analysis actually fast — a human noticing a graph and deciding to roll back can take 15–30 minutes; an automated policy comparing metrics against a baseline can decide in under a minute.

## Session, cache and background-job compatibility

Sessions stored in-process die with the instance that created them — a stateless service pattern requires session state to live externally (Redis, a database, or a signed client-side token) so any instance can serve any request. Caches need version-tolerant keys or values: if the new version changes what a cached object looks like, either version the cache key (`user:v2:123`) or ensure both versions can deserialise both shapes, otherwise the old version crashes reading a cache entry the new version wrote.

Long-running background jobs are a common blind spot: a job started under the old version, mid-execution when the deploy happens, either needs to survive being killed and resumed (checkpointing, idempotent steps) or the deploy needs to wait for the job queue to drain before terminating that instance. Message consumers face the same mixed-version problem as APIs — a consumer group with both old and new instances will have messages processed by either version during rollout, so message schemas need the same backward/forward compatibility as APIs.

## The rollback plan

Write the rollback plan **before** deploying, not after something breaks — under pressure, people forget steps or take shortcuts. A good rollback plan states: the exact previous version/tag to redeploy, whether any schema change needs a compensating action (and confirms it's non-destructive so far), what to check to confirm rollback succeeded, and who is paged if the rollback itself fails.

## Pre-deploy checklist

| Check | Why |
|---|---|
| Change is backward and forward compatible | Old and new code will coexist during rollout |
| Schema changes are additive-only (expand phase) | Destructive changes wait for a later, separate deploy |
| Health checks (readiness/liveness) configured and tested | Load balancer must detect real readiness, not just process start |
| Graceful shutdown handling with adequate timeout | In-flight requests must finish before termination |
| New behaviour is behind a feature flag if risky | Deploy and release are decoupled |
| Rollback plan documented with exact previous version | No improvising under pressure |
| Canary/monitoring dashboards ready with rollback thresholds | Detect regressions automatically, not by user complaints |
| Session/cache compatibility verified across versions | No crashes reading state written by the other version |

## Cheat sheet

- Zero downtime requires statelessness + backward compatibility + health checks + graceful shutdown — all four, not one tool.
- Draining = stop new traffic to an instance, let in-flight requests finish, then terminate.
- Old and new code run simultaneously for the whole rollout window — design every change for that.
- Database changes are always additive-first; destructive cleanup is a separate, later deploy.
- Feature flags decouple deploy (code ships) from release (behaviour turns on) — and are instantly reversible.
- Canary + automated rollback criteria catches regressions in under a minute instead of after a human notices.
- Sessions and caches must not depend on a specific instance or a specific version's data shape.
- Background jobs need checkpointing/idempotency or must be drained before their instance terminates.
- Message consumers face the same mixed-version problem as APIs — schemas need the same compatibility discipline.
- Write the rollback plan before deploying, including the exact version to roll back to and how to verify success.

## Common mistakes

| Mistake | Fix |
|---|---|
| Storing session state in-process | Move to Redis/database/signed token so any instance can serve any request |
| Shipping a destructive migration with the code that needs it | Split into additive-first, cleanup-later deploys |
| Using `SIGKILL`/short grace period for shutdown | Use `SIGTERM` with a grace period exceeding the longest request |
| Watching dashboards manually to decide on rollback | Automate rollback thresholds on error rate, latency, health checks |
| Leaving feature flags in code indefinitely after full rollout | Assign an owner and removal date to every flag at creation |
| Deploying with no rollback plan written down | Write exact rollback steps and verification before deploying |
| Killing an instance mid-background-job | Drain the job queue or make jobs checkpointed/idempotent first |

## Summary

Zero downtime deployment is what you get when statelessness, backward/forward-compatible changes, real health checks and graceful shutdown are all true at once — the deploy tooling just orchestrates around those properties. Because old and new versions run side by side for the entire rollout, every change (schema, cache format, message schema) has to tolerate both, which is why expand-contract, feature flags and tolerant readers keep reappearing as the same underlying idea applied to different layers. Canaries with automated rollback thresholds and a rollback plan written in advance are what turn "we hope this works" into a controlled, reversible process.

## Top Interview Questions

### Q1. What has to be true about a service before you can deploy it with zero downtime?

Four preconditions have to hold simultaneously. The service must be stateless, so any instance can be added or removed without losing user session data. Changes must be backward and forward compatible, since old and new instances run side by side for the whole rollout window. The service needs real health checks — a readiness probe that only passes once the instance can genuinely serve traffic, not just once the process has started, and a liveness probe to detect and restart a hung instance. And it needs graceful shutdown — on receiving a termination signal, it stops accepting new work but finishes in-flight requests before exiting. Skip any one of these and the deploy pipeline can't actually guarantee zero downtime, no matter how sophisticated the rollout mechanics are.

### Q2. What is connection draining and why does it matter during a rolling deploy?

Connection draining is the process of removing an instance from load balancer rotation — so it stops receiving new requests — while letting requests already in progress on that instance finish normally before it's terminated. Without draining, an instance killed mid-deploy would drop any in-flight request the moment it's stopped, which users experience as random failed requests correlated with deploy times. In practice this is implemented as: the load balancer's health check starts failing (or the instance is explicitly deregistered), a grace period elapses during which existing connections are allowed to complete, and only after that grace period (or all connections finishing, whichever comes first) does the orchestrator send a hard kill signal. The grace period needs to be tuned to comfortably exceed the service's longest realistic request duration.

### Q3. Why must database schema changes be handled differently from application code during a zero-downtime deploy?

Application instances can be replaced gradually, one at a time, because each instance is independent — but there's only one database schema, shared by every instance regardless of which code version it's running. That means a schema change can't be "rolled out gradually" the way code can; the instant it's applied, it affects every instance, including old ones still running because the rollout isn't complete. The two-phase approach solves this: ship only additive, backward-compatible schema changes (new nullable column, new table) in a deploy *before* the code that depends on them, and only ship destructive cleanup (dropping an old column) in a separate, later deploy once you've confirmed no running code — old or new — still depends on the old shape.

### Q4. How do feature flags help with zero-downtime deployment, and what's the operational cost of using them?

Feature flags decouple "deploy" (code physically ships to production) from "release" (the new behaviour becomes visible to users). This means new, potentially risky code can be merged and deployed dark — flag off — validated in production for real (checking logs, metrics, maybe internal-only traffic), and then released by flipping the flag, with no redeploy needed and instant reversibility if something's wrong. The operational cost is flag lifecycle management: every flag adds a conditional code path, and flags left in after a feature is fully and permanently rolled out become dead weight — nobody's sure if it's still safe to delete the "off" branch. The discipline that avoids this is assigning an owner and an expected removal date to every flag when it's created, and treating flag removal as a normal, expected follow-up task, not an optional cleanup.

### Q5. What automated criteria would you use to decide whether a canary deployment should be rolled back?

I'd compare the canary's real-time metrics against the stable baseline on at least: error rate (rolled back if it exceeds baseline by a fixed absolute delta, e.g. +2%, sustained for a few minutes to avoid reacting to noise), p99 latency (rolled back if it exceeds baseline by a multiplier, e.g. 1.5x, sustained similarly), and readiness/health check failures on the canary instances themselves. Where possible I'd also include a business metric relevant to the service, like checkout success rate for a payments path, since infrastructure metrics can look fine while a subtle logic bug quietly breaks a business flow. The key design point is automating the decision rather than relying on a human watching a dashboard — a human might take 15–30 minutes to notice and act, while an automated policy comparing against a baseline can trigger a rollback in under a minute, which matters a lot at the percentage of traffic a canary is exposed to.

### Q6. What happens to a long-running background job if the instance running it is terminated mid-deploy?

If the job isn't checkpointed or idempotent, the job is either lost entirely or, worse, partially applied and then retried from the start, potentially double-processing part of its work — for example, a job that charges a customer for each of 10,000 line items could charge some of them twice if restarted naively. The two ways to handle this: design jobs to be checkpointed (persist progress so a restart resumes from the last checkpoint rather than from zero) and idempotent (safe to retry a step without duplicating its effect, e.g. using an idempotency key), or alternatively, have the deploy process wait for an instance's in-flight jobs to complete (drain the job queue for that instance) before terminating it, similar to how HTTP connection draining works. Long jobs and rolling deploys are a common blind spot precisely because HTTP draining is well understood but job queues are often overlooked.

### Q7. How do you handle sessions and caches so that a rolling deploy with two live versions doesn't cause errors?

Sessions must not be stored in-process, because a request can land on either an old or new instance during rollout, and in-process session data dies with the instance that created it — session state needs to live in something external and shared, like Redis, a database, or a signed client-side token (e.g. a JWT), so any instance can serve any request regardless of which one originally started the session. Caches need similar care: if the new version changes the shape of what's cached, either the old version will fail to deserialise a new-shaped cache entry, or vice versa. The fix is to version the cache key itself (`user:v2:123` rather than `user:123`) so each version reads and writes its own shape without colliding, or to ensure both versions can tolerate both shapes (a tolerant reader), similar to the approach used for API and event schemas.

### Q8. What should a rollback plan contain, and why write it before deploying rather than after something breaks?

A rollback plan should state the exact previous version or artifact tag to redeploy (not "whatever was there before" — an explicit, verified reference), whether the deploy included any schema change and confirmation that it was purely additive so far (meaning rollback doesn't require a compensating destructive action), the specific checks that confirm the rollback actually succeeded (not just "the deploy tool said done"), and who is paged if the rollback itself fails. Writing it before deploying matters because under the stress of an active incident, people skip steps, forget the actual previous version, or assume a schema change is reversible when it isn't — deciding all of this calmly in advance turns a stressful incident into executing a checklist, which is measurably faster and less error-prone than improvising.

### Q9. Why do message consumers face the same mixed-version problem as HTTP APIs during a rolling deploy, and how do you handle it?

During a rolling deploy of a consumer group, some consumer instances are still running the old code while others have already been replaced with the new code — messages arriving during that window can be picked up and processed by either version, essentially at random, depending on which instance happens to be free. This means a message schema change has exactly the same constraint an API does: it must be readable by both the old and new consumer code simultaneously, which is why message/event schemas need explicit backward/forward compatibility (often enforced by a schema registry) rather than being changed freely. In practice this means treating message schema changes with the same additive-only discipline as expand-contract — add new fields as optional, never repurpose or remove a field consumers might still expect, and version the message type itself if a genuinely incompatible change is unavoidable.

### Q10. Your canary deployment shows a small increase in error rate, but a teammate says "it's probably just noise, let's give it more time." How do you decide?

I'd look at whether the increase is a statistically meaningful deviation from baseline given the traffic volume the canary is receiving, not just eyeballing the graph — a canary at 2% of traffic naturally has a noisier error rate than the full fleet, so a rollback policy should account for canary sample size, for example requiring the elevated rate to persist for a minimum window (a few minutes) rather than reacting to a single data point. If the automated policy's threshold and duration conditions are met, I'd roll back regardless of how confident anyone feels it's "probably noise" — the entire point of pre-agreed, automated criteria is to remove that judgment call under pressure, where the instinct to wait and see is exactly how canaries turn into full incidents. If the policy hasn't triggered and the anomaly genuinely looks like noise on inspection (e.g. it's within normal variance for that traffic volume), continuing to watch for a bounded, pre-agreed period is reasonable — but that boundary should be pre-agreed, not decided in the moment.

### Q11. What's the difference between "deploy" and "release", and why does the distinction matter operationally?

A deploy is the act of getting new code running in production infrastructure; a release is the act of making new behaviour visible or active for users. Conflating the two means every deploy is inherently risky to users, because the moment the code is live, so is the behaviour — there's no way to validate the new code in production without exposing users to it. Separating them, typically via feature flags, means you can deploy far more often and with far less ceremony (since a dark deploy carries little user-facing risk), and control exactly when, how gradually, and to whom a feature is released independently of the deploy schedule. Operationally, this also makes rollback of a bad *release* nearly instant (flip the flag off) without needing a full redeploy, which is much faster than redeploying a previous artifact.

### Q12. A deploy just finished, and five minutes later, a customer reports "my session logged me out" but only intermittently. What would you investigate?

This pattern — intermittent, and correlated with a recent deploy — strongly suggests session state that isn't fully externalised, or a cache/session format mismatch between the old and new version, since a request landing on one version's instance would find a session it can't read correctly. I'd first confirm whether session data is stored in-process (in which case any request landing on a newly-started instance simply won't have that customer's session, since it never existed there) versus externally in Redis or a database. If it's external, I'd check whether the new version changed the session's serialisation format in a way the old version (still partially running during rollout) can't read, or vice versa — the fix in that case is to version the session/cache key or make both versions tolerant of both formats, exactly as you'd handle an API or event schema change.
