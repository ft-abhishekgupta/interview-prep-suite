---
title: Production Debugging Playbook
description: A structured, repeatable way to answer latency just spiked what do you do, from first questions through symptom to cause mapping to a full worked walkthrough
difficulty: Advanced
tags: [observability, debugging, incident-management, performance, production]
---

"Production latency just spiked — what do you do?" is close to guaranteed in a senior interview because it tests everything at once: systems knowledge, structured thinking under pressure, and whether you reach for evidence instead of guesses. This page is the playbook — the first questions, the change-first heuristic, a layer-by-layer narrowing process, and a symptom-to-cause map covering the twelve most common culprits.

## First questions

Before touching a dashboard, ask questions that shrink the search space. Answering these takes under a minute and determines everything that follows.

| Question | Why it matters |
|---|---|
| When did it start — exactly? | Lets you correlate against deploys, config changes, and traffic patterns at that timestamp |
| What changed around that time? | Deploys, feature flags, config, infra changes are the highest-probability cause |
| Which endpoints/services are affected — all or specific? | Narrow blast radius points at a specific code path or dependency; broad points at shared infra |
| Which regions/AZs? | One region points at infra/network there; all regions points at code, a global dependency, or traffic |
| Which customers/segments? | One customer/tier suggests a data-shape or hot-key issue, not a systemic one |
| Is it latency, errors, or both? | Pure latency often means contention/saturation; errors alongside it often mean a hard failure, not just slowness |

> [!KEY]
> The order matters: **when, what changed, how wide** — in that order — before you open a single trace. Most production incidents are explained by something that changed, and finding that correlation is faster than debugging from first principles.

## The change-first heuristic

The single highest-value habit: assume a recent change is the cause until you have specific evidence otherwise, because in practice it usually is.

```mermaid
flowchart TD
    A["Latency spike detected"] --> B{"Deploy in the last<br/>few hours?"}
    B -->|Yes| C["Correlate spike start<br/>with deploy time"]
    B -->|No| D{"Config or feature<br/>flag change?"}
    D -->|Yes| E["Correlate spike start<br/>with change time"]
    D -->|No| F{"Traffic shape changed?<br/>volume, mix, new client"}
    F -->|Yes| G["Check if traffic growth<br/>crossed a saturation point"]
    F -->|No| H{"A dependency's own<br/>status/deploy changed?"}
    H -->|Yes| I["Treat as a downstream<br/>dependency incident"]
    H -->|No| J["No recent change found —<br/>move to layer-by-layer diagnosis"]
```

> [!TIP]
> Say this out loud in an interview: *"My prior is that something changed — a deploy, a config, a flag, a dependency, or a traffic shift. I check those first because reverting a change is almost always faster than root-causing from scratch, and it's right more often than not."*

## Narrowing by layer

If nothing recent correlates, narrow systematically from the outside in rather than guessing.

```mermaid
flowchart LR
    A["Client/edge<br/>DNS, TLS, CDN"] --> B["Load balancer/gateway"]
    B --> C["Application layer<br/>threads, GC, code"]
    C --> D["Data layer<br/>DB, cache, queue"]
    D --> E["Downstream dependencies<br/>third-party APIs"]
```

At each layer, check that layer's own saturation and error signals before moving to the next — this is RED/USE thinking applied live during an incident.

## Symptom to cause

This is the map to have memorised — for each, the confirming signal and the mitigation you'd reach for first.

| Cause | Confirming signal | First mitigation | What to say in an interview |
|---|---|---|---|
| Slow dependency | One downstream call's span/latency dominates the trace; the dependency's own dashboard shows the same spike | Circuit breaker, timeout tuning, fail over, or degrade gracefully (serve cached/partial data) | "I'd check the span breakdown first — if one call dominates, this is a dependency problem, not ours" |
| Database contention (locks) | Rising query duration with flat query count; lock wait time metric climbing; blocking session reports | Kill/identify the blocking query, add an index, reduce transaction scope, shorten lock hold time | "Contention shows as query time up, query count flat — that's the signature versus a volume problem" |
| Connection pool exhaustion | Wait-for-connection time climbing; pool in-use % near 100%; timeouts on "get connection" specifically | Increase pool size (bounded by DB capacity), reduce hold time, add a pooling proxy | "Requests queue for a connection, not for the DB itself — the DB's own load can look fine" |
| Thread pool starvation | Request queue length growing; CPU not saturated; handlers blocked on synchronous I/O | Make I/O async, increase pool size, isolate slow handlers to a dedicated pool (bulkhead) | "Low CPU with a growing queue is the tell — threads are blocked waiting, not computing" |
| GC pressure | Rising GC pause frequency/duration; latency spikes correlate exactly with GC events, not steady | Reduce allocation rate, tune heap/GC settings, fix an object-retention leak | "Correlate the latency spike timestamps directly against GC pause timestamps — if they line up, it's GC" |
| Cache miss storm | Cache hit ratio drops sharply; origin/DB load spikes right after; often follows a cache flush, deploy, or TTL expiry aligned across keys | Stagger TTLs (jitter), pre-warm cache before cutover, add request coalescing/locking on miss | "A synchronized TTL expiry causes a thundering herd — jittered TTLs are the standard fix" |
| Hot partition/key | One shard/partition shows high load while others are idle; one customer/key dominates the traffic | Re-shard/re-key with better distribution, add a cache in front of the hot key, rate-limit the offending key | "Aggregate metrics look fine — you have to look per-shard to see this one" |
| Noisy neighbour | Latency/CPU steal time up with no change in your own request volume or code; shared-host/cluster metrics show another tenant's spike | Move to dedicated capacity, apply resource limits/quotas, escalate to the platform/infra team | "Nothing in our own traffic or code explains it — check for shared infrastructure contention" |
| Retry storm | Request rate at a downstream call is a multiple of the actual unique request rate; retries amplify a small initial blip | Exponential backoff with jitter, retry budget/circuit breaker, cap total retry attempts fleet-wide | "A small initial failure can cascade into an outage purely through retry amplification — check the retry-to-unique-request ratio" |
| DNS resolution cost | Latency spike specifically at connection setup, not in application logic; DNS resolver metrics show elevated lookup time | Increase client-side DNS caching/TTL, use a more reliable resolver, keep connections alive longer | "This shows up as time-to-first-byte overhead before any application code even runs" |
| TLS handshake cost | Elevated latency concentrated in new-connection setup; high connection churn (short-lived connections, no keep-alive) | Enable/extend keep-alive, connection pooling, session resumption (TLS session tickets) | "High connection churn plus a handshake-shaped latency bump — check keep-alive settings first" |
| Disk I/O saturation | Disk I/O wait time up, queue depth up, CPU relatively idle; often on the DB or log-heavy service | Move to faster storage tier, reduce write volume (batch, compress), separate log/data volumes | "CPU idle with I/O wait climbing tells you it's storage, not compute, before you even open a profiler" |

> [!WARNING]
> Several of these look identical on a single "latency went up" graph. The differentiator is always a **second, more specific signal** — query count vs query time for contention, per-shard vs aggregate for hot partitions, retry-to-unique-request ratio for retry storms. Naming the specific confirming signal, not just the plausible story, is what separates a strong interview answer from a guess.

## Worked walkthrough — a full scenario end to end

**Scenario:** p99 latency for the checkout API jumped from 400ms to 3.5s at 14:02, alert fired at 14:04.

1. **First questions.** When: 14:02 exactly, sharp step change, not a gradual climb — this shape suggests a discrete trigger, not organic growth. What changed: checking the deploy log shows a deploy to `payment-service` completed at 14:01. Which endpoints: only checkout, not the whole site. Which regions: all regions. Errors or latency: latency only, error rate unchanged.

2. **Change-first heuristic.** A deploy completing one minute before the spike, on the exact service in the affected code path, is a very strong prior. Before doing anything else: check the deploy's own health metrics and whether a rollback is safe and fast.

3. **Confirm before acting blindly.** Pull two or three slow traces from after 14:02. The flame graph shows `PaymentService.Charge` span itself is wide (900ms) with only a small, fast child span (`fraud-api.Check`, 40ms) — meaning the extra time is inside `Charge`'s own code, not a downstream dependency. This rules out "slow dependency" as the primary cause and points at the deployed code itself.

4. **Mitigate.** Given the strong deploy correlation and trace evidence pointing at the newly deployed code, roll back `payment-service` immediately rather than continuing to read code — this is the mitigate-before-diagnose rule from incident management. Rollback takes 4 minutes; latency returns to 400ms within a minute of rollback completing.

5. **Diagnose calmly, post-mitigation.** With impact stopped, review the deploy's diff: it added a new synchronous validation call that, under load, was blocking on a lock during a data migration running concurrently — a case of database contention introduced by new code, confirmed by finding rising lock wait time metrics that started at exactly 14:01 in the deploy window.

6. **Resolve.** Fix the code to avoid holding the lock during validation (move the check outside the transaction), test under load, redeploy behind a canary.

7. **Review.** Blameless postmortem: contributing factors were the missing load-test coverage for the new validation path, no alert on lock wait time specifically (only on overall latency), and the migration and deploy being scheduled without awareness of each other. Action items: add lock-wait-time alerting, require a canary stage for any deploy touching the payment path, and add a deploy/migration collision check to the release process — each with a named owner and a due date.

> [!KEY]
> Notice the order: mitigate (rollback) happened **before** the specific mechanism (lock contention from a concurrent migration) was understood. That is the correct order, and stating it explicitly is what makes this kind of walkthrough land well in an interview.

## Cheat sheet

- First questions in order: when exactly, what changed, how wide (endpoint/region/customer), latency or errors or both.
- Assume a recent change (deploy, config, flag, traffic, dependency) is the cause until proven otherwise.
- Narrow layer by layer: client/edge → LB/gateway → application → data layer → downstream dependencies.
- Contention (query time up, count flat) is not the same as volume (both up) — the distinguishing signal matters.
- Cache miss storms and retry storms are both amplification patterns — look for a synchronized trigger (TTL expiry, initial failure).
- Hot partitions and noisy neighbours are invisible in aggregate metrics — you must look per-shard/per-tenant.
- DNS and TLS handshake costs show up specifically at connection setup, not inside application logic.
- Always mitigate before you fully diagnose; understand the mechanism calmly afterward.

## Common mistakes

| Mistake | Fix |
|---|---|
| Jumping straight to code-level debugging before checking "what changed" | Ask the first questions and check recent deploys/config/flags first |
| Treating every latency spike as a code bug | Check infra-level causes too — hot partition, noisy neighbour, disk I/O |
| Confusing contention with volume increase | Compare query duration trend against query count trend separately |
| Looking only at aggregate/fleet-wide metrics | Check per-shard, per-instance, per-tenant views for hot-key/noisy-neighbour patterns |
| Diagnosing root cause before mitigating live impact | Roll back or fail over first; diagnose the mechanism afterward |
| Assuming retries help under load | Check the retry-to-unique-request ratio — retries can amplify an outage |

## Summary

A structured response to a latency spike starts with fast, cheap questions — when exactly, what changed, how wide is the impact — because most incidents correlate with a recent, revertible change. When nothing recent correlates, narrow layer by layer from the edge to downstream dependencies, using the specific confirming signal for each candidate cause rather than the first plausible story. The twelve-cause map (slow dependency, contention, pool exhaustion, thread starvation, GC pressure, cache miss storm, hot partition, noisy neighbour, retry storm, DNS, TLS, disk I/O) gives you a checklist to reason through live, and the worked walkthrough shows the right order of operations: mitigate first, understand the mechanism after.

## Top Interview Questions

### Q1. Latency just spiked in production — walk me through exactly what you do in the first five minutes.

First, I'd ask the fast, cheap questions that shrink the search space: when did it start exactly, what changed around that time (deploy, config, feature flag, traffic shape, a dependency's own status), which endpoints/regions/customers are affected, and whether it's latency alone or also errors. In parallel, I'd pull up the RED dashboard for the affected service to confirm scope and severity, and check the deploy log for anything that landed in the minutes before the spike started — a correlated deploy is the single highest-probability cause in practice. If a recent change correlates, my next move is almost always to revert it (rollback, flag off, config revert) rather than root-causing forward, because reverting is faster, safer, and right most of the time. Only if nothing recent correlates do I move to layer-by-layer diagnosis — edge, load balancer, application, data layer, downstream dependencies — checking saturation and error signals at each layer.

### Q2. How do you tell the difference between database contention and the database simply being under too much load?

The distinguishing signal is the relationship between query duration and query count. If query duration is rising while query count stays flat or only mildly elevated, that's contention — queries are queuing behind locks or waiting on each other, not because there are more of them but because they're blocking one another; you'd confirm this by checking blocking-session/lock-wait metrics directly. If both query duration and query count are rising together, that's a genuine volume/capacity problem — more work is arriving than the database can process at its normal per-query speed, and you'd confirm this via overall throughput and resource utilisation (CPU, I/O) on the database itself. The fix differs completely: contention needs the blocking query identified and the lock scope reduced; volume needs more capacity, better indexing, or shedding/caching load away from the database.

### Q3. What's the difference between connection pool exhaustion and thread pool starvation, and how would you tell them apart from a single latency graph?

Both look similar on a plain latency graph — requests getting slower under load — but the specific queuing metric differs: connection pool exhaustion shows up as rising wait-time-to-acquire-a-connection with the pool's in-use percentage near 100%, meaning requests are waiting for a database (or other resource) connection specifically, often because a downstream dependency is slow and holding connections longer, not because the pool is undersized for normal load. Thread pool starvation shows up as a growing request queue with CPU utilisation that is *not* correspondingly high, because the threads are blocked waiting on synchronous I/O rather than doing computational work — you're out of available worker threads, not out of CPU. The practical tell is checking CPU alongside the specific queue/pool metric: low CPU with a growing queue points at thread starvation from blocking I/O; connection-specific wait time metrics pointing at the pool specifically indicate pool exhaustion.

### Q4. Explain what a cache miss storm is and why the fix isn't simply "make the cache bigger."

A cache miss storm happens when a large number of cache entries expire or get invalidated at the same time — a synchronized TTL, a full cache flush, or a deploy that changes the cache key format — causing a sudden flood of requests to all miss the cache simultaneously and hit the origin/database at once, which can overload it even though the *steady-state* cache hit ratio is normally healthy. Making the cache bigger doesn't address this because the problem isn't capacity, it's synchronization: everything expiring at the same instant. The actual fixes are to jitter TTLs so expiry is spread out over time rather than aligned, pre-warm the cache before any planned cutover or flush, and add request coalescing (a lock or single-flight pattern) so that when many concurrent requests miss the same key, only one of them actually queries the origin while the rest wait for that result.

### Q5. How would you detect a hot partition or hot key, given that your fleet-wide metrics all look normal?

Fleet-wide or aggregate metrics average across all shards/partitions, which is exactly what hides a hot partition — one shard can be significantly overloaded while the rest sit idle, and the average looks unremarkable. You have to look at per-shard or per-partition metrics specifically: request rate, latency, and CPU/IO broken down by shard/partition ID rather than summed. If one shard is clearly an outlier while others are healthy, the next step is identifying what key or customer is concentrated there — often a single very active customer, a poorly chosen partition key (e.g., partitioning by a low-cardinality field), or a specific data pattern. The fix is re-keying or re-sharding for better distribution, adding a cache in front of the specific hot key, or rate-limiting/isolating the offending traffic if it's a single abusive or unusually active customer.

### Q6. What is a retry storm, and why can retries make an outage worse instead of better?

A retry storm happens when a small initial failure (a brief blip in a downstream dependency, a transient timeout) triggers retries across many callers, and those retries — especially without backoff or a cap — multiply the effective request rate against the already-struggling dependency, turning a minor, self-recoverable blip into a sustained overload. The confirming signal is comparing the request rate a downstream dependency actually receives against the rate of genuinely unique incoming requests — if the downstream rate is a multiple of the unique request rate, retries are amplifying load, not just handling failures gracefully. The fix is exponential backoff with jitter (so retries don't all land at the same instant), a retry budget or circuit breaker that stops retrying once a threshold of recent failures is hit, and capping total retry attempts fleet-wide so a struggling dependency isn't hit harder by everyone retrying simultaneously.

### Q7. How would DNS resolution or TLS handshake cost show up in a latency investigation, and how would you confirm it's really the cause?

Both show up specifically as overhead at **connection setup time**, before any application code runs — so the tell is that the extra latency is concentrated in time-to-first-byte or connection-establishment metrics rather than inside application-level spans, which is why checking the trace/span breakdown first is useful: if there's a gap before the first application span even starts, or the HTTP client library exposes DNS/TLS timing separately, that's where to look. For DNS, you'd confirm via resolver-level lookup time metrics and check whether client-side DNS caching/TTL is too short, causing frequent re-resolution. For TLS, you'd confirm via elevated new-connection handshake time correlated with high connection churn (short-lived connections without keep-alive, forcing a full handshake per request) rather than reusing existing connections. Both are frequently overlooked because they're invisible if you only look at application-level code profiling.

### Q8. How do you distinguish a noisy neighbour problem from a genuine capacity issue in your own service?

A noisy neighbour problem — another tenant on shared infrastructure (a shared host, cluster, or storage) consuming a disproportionate amount of a shared resource — shows up as your latency or CPU/steal-time rising with **no corresponding change in your own request volume or code**, which is the key differentiator from a genuine capacity issue where your own traffic or work has actually increased. Confirming it usually requires infrastructure-level metrics you may not own directly — CPU steal time, shared storage I/O contention, or a platform team's own multi-tenant utilisation dashboards — rather than anything visible purely from your service's own instrumentation. The mitigation is also different: it's not "add more of your own capacity," it's moving to dedicated/isolated capacity, applying resource limits/quotas, or escalating to the infrastructure/platform team, since scaling your own service further does nothing if the constraint is a shared resource you don't control.

### Q9. Why is "mitigate before you diagnose" specifically important in a debugging scenario, not just a general incident management rule?

In the specific context of debugging a latency spike, this means that once you have a plausible, evidence-backed candidate (a correlated deploy, a specific span dominating a trace), your first action should be to revert or route around it — rollback, flag off, failover — rather than continuing to dig for full certainty about the underlying mechanism while users are actively experiencing the slowdown. This is because confirming a plausible cause is usually enough to justify a safe, fast, reversible mitigation, whereas fully understanding the mechanism (as in the worked walkthrough, discovering a lock held during a concurrent migration) can take much longer and isn't needed to stop the pain. The full mechanism is genuinely valuable, but it belongs in the calm, post-mitigation diagnosis phase and the eventual postmortem, not in the first minutes of active user impact.

### Q10. If two candidate causes both fit the initial symptoms, how do you decide which to investigate first?

I'd rank candidates by a combination of prior probability and cost to check: a recent deploy or config change is almost always checked first because it's both a common cause and cheap to correlate against a timestamp. Beyond that, I'd look for the most specific, cheaply obtainable confirming signal for each candidate — for example, checking query-count-vs-query-duration takes one dashboard look and immediately rules contention in or out, while confirming a noisy neighbour might require pulling in another team's metrics and take longer. I'd investigate the cheapest-to-confirm, highest-prior candidate first, and explicitly avoid pursuing an expensive-to-confirm theory before ruling out the cheap ones, since that ordering minimises time to a safe mitigation.

### Q11. In the worked walkthrough, why was rolling back the deploy the right call even before the lock contention mechanism was understood?

Because the evidence available at the time — a deploy to the exact affected service completing one minute before a sharp, step-change latency spike, combined with the trace showing the extra time was inside that service's own code rather than a downstream call — was already strong enough to justify a fast, low-risk, reversible action. Waiting to fully understand *why* the new code caused contention (which required finding a concurrent migration holding a lock) would have meant leaving checkout degraded for however long that deeper investigation took, with no guarantee it would be fast. Rolling back cost a few minutes, immediately restored normal latency, and didn't foreclose understanding the mechanism afterward — which is exactly what happened in the calm, post-mitigation diagnosis step.

### Q12. What's the biggest mistake candidates make when answering a "latency spiked, what do you do" interview question, and how do you avoid it?

The most common mistake is jumping straight into a single, code-level theory — "I'd check for a memory leak" or "I'd look for an N+1 query" — without first establishing scope and recent changes, which makes the answer sound like a guess rather than a structured process, and it skips the highest-probability, cheapest-to-check cause (a recent change). The way to avoid it is to explicitly narrate the first questions before naming any specific technical cause: when did it start, what changed, how wide is the impact, latency or errors — and only then move into the layer-by-layer or symptom-to-cause reasoning, explicitly naming the confirming signal you'd look for rather than asserting a cause outright. That structure, plus stating "mitigate first, diagnose after" explicitly, is what reliably separates a strong senior answer from a plausible-sounding guess.
