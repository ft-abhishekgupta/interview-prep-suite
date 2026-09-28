---
title: CI/CD Pipeline Design
description: How to structure a pipeline for fast feedback, why you build an artefact once and promote it everywhere, and how OIDC federation replaces long-lived deployment credentials
difficulty: Core
tags: [ci-cd, pipelines, devops, release-engineering]
---

A CI/CD pipeline is a risk-reduction machine, not a formality — every stage exists to catch a specific class of problem as cheaply and early as possible. The core topics are pipeline shape, the "build once, promote everywhere" principle that most junior pipelines get wrong, secrets and identity in automation, and the practices (trunk-based development, flaky test quarantine, DORA metrics) that come up constantly in senior interviews.

## Stages of a good pipeline

```mermaid
flowchart LR
    C["Commit"] --> B["Build"]
    B --> U["Unit Tests"]
    U --> SA["Static Analysis"]
    SA --> SS["Security Scan"]
    SS --> P["Package Artefact"]
    P --> DN["Deploy to Non-Prod"]
    DN --> IT["Integration Tests"]
    IT --> AP["Approval Gate"]
    AP --> DP["Deploy to Prod"]
    DP --> SM["Smoke Test"]
```

Each stage answers one question: build (does it compile?), unit tests (does the logic work in isolation?), static analysis (is it maintainable, does it violate known rules?), security scan (does it ship a known vulnerability or secret?), package (is the deployable artefact reproducible?), integration tests (does it work with real dependencies?), approval (should a human or policy sign off?), smoke test (did the deploy actually work?).

> [!KEY]
> Order stages cheapest-and-most-likely-to-fail first. A typo should fail at "build" in 30 seconds, not at "integration tests" in 20 minutes.

## Fast feedback and the ten-minute rule

The ten-minute rule: the feedback loop from commit to a pass/fail signal on the core checks (build, unit tests, static analysis) should stay under ten minutes, because beyond that developers context-switch away and stop treating the pipeline as immediate feedback. Slower stages (integration tests against real infra, security scans, load tests) are pushed later in the pipeline or run asynchronously/in parallel, so they don't block the fast signal.

| Feedback loop | Target latency | What lives here |
|---|---|---|
| Local (pre-commit) | Seconds | Lint, formatter, fast unit tests |
| CI fast path | < 10 minutes | Build, unit tests, static analysis |
| CI full path | 10–30 minutes | Integration tests, security scan |
| Post-deploy | Minutes | Smoke tests, synthetic checks |

> [!TIP]
> If your pipeline is slow, the senior move isn't "buy bigger runners" first — it's re-order and parallelise stages so the fast, high-signal checks gate the merge, and slow checks run alongside or after.

## Build once, promote the same artefact everywhere

The single highest-leverage rule in pipeline design: **build the deployable artefact exactly once, then promote that identical artefact through dev → staging → prod.** Never rebuild per environment.

Rebuilding per environment means each environment can end up running *different bytes* — a different compiler flag, a different dependency resolved at a different moment, a transient network blip pulling a slightly different transitive version — even though the source commit is identical. That breaks the entire premise of testing in staging: you tested one artefact and shipped a different one.

```bash
# Build once, tag immutably, push to a registry
docker build -t registry.example.com/app:sha-$(git rev-parse --short HEAD) .
docker push registry.example.com/app:sha-$(git rev-parse --short HEAD)

# Every environment deploys the *same* tag — never `docker build` again
kubectl set image deployment/app app=registry.example.com/app:sha-a1b2c3d -n staging
kubectl set image deployment/app app=registry.example.com/app:sha-a1b2c3d -n prod
```

> [!DANGER]
> "It worked in staging" is only a meaningful statement if staging ran the *same binary* as production. Rebuilding per environment silently invalidates every test you ran.

## Artefact versioning and immutability

Every artefact gets an immutable identifier — a commit SHA, a content hash, or a strictly increasing build number — never a mutable tag like `latest` or `stable` that can point to different bytes over time. Immutability means you can always answer "what exact code is running in prod right now" and reproduce a past incident's exact artefact for debugging.

| Practice | Why |
|---|---|
| Tag with commit SHA or content digest | Guarantees the tag always resolves to the same bytes |
| Never overwrite a published artefact | An overwritten `v1.2.0` breaks anyone who already deployed it |
| Store artefacts in a registry with retention policy | Enables rollback to any prior version on demand |
| Record the artefact ID in your deployment/audit log | Answers "what's running where" during an incident |

## Environment configuration separation

Because the same artefact runs everywhere, environment-specific values (database URLs, feature flag defaults, resource limits) cannot be baked into the artefact — they're injected at deploy time via environment variables, mounted config, or a config service, keeping the binary itself environment-agnostic. This is the Twelve-Factor App "config in the environment" principle, and it's what makes build-once-promote-everywhere possible in the first place.

## Secrets in pipelines and OIDC federation

Long-lived cloud credentials stored as CI secrets (an AWS access key, an Azure service principal password) are a standing liability — if the CI system is compromised, the attacker has standing access until someone notices and rotates. **OIDC federation** replaces this: the CI job presents a short-lived, cryptographically signed identity token issued by the CI provider (GitHub Actions, GitLab), the cloud provider validates it against a trust policy, and issues a short-lived credential scoped to that one job run — nothing durable is stored anywhere.

```yaml
# GitHub Actions requesting a short-lived AWS credential via OIDC — no stored access keys
permissions:
  id-token: write
  contents: read
steps:
  - uses: aws-actions/configure-aws-credentials@v4
    with:
      role-to-assume: arn:aws:iam::123456789012:role/ci-deploy
      aws-region: us-east-1
```

> [!WARNING]
> If a pipeline still uses a static cloud secret and you're asked "how would you improve this," OIDC federation is the expected senior answer — it removes an entire class of long-lived-credential-leak risk.

## Parallelism, caching, and flaky tests

Split independent test suites across parallel runners (by package, by historical duration) to cut wall-clock time, and cache dependencies (package manager caches, compiled layers) keyed on a lockfile hash so unrelated commits don't repay the same download/build cost.

Flaky tests — tests that fail intermittently with no code change — are worse than no test at all, because they train engineers to re-run and ignore CI failures generally. The standard response is **quarantine**: automatically detect a test that fails inconsistently across recent runs, move it out of the blocking suite into a tracked, non-blocking one, and require it to be fixed or deleted within an agreed window, rather than letting it erode trust in every red build.

## Trunk-based development vs long-lived branches

| | Trunk-based | Long-lived feature branches |
|---|---|---|
| Merge frequency | Multiple times a day, small diffs | Days to weeks, large diffs |
| Merge conflict risk | Low (small, frequent diffs) | High (large divergence) |
| Requires | Feature flags for incomplete work | Careful branch/PR management |
| CI signal | Always tests near-current main | Tests a branch that may be stale |
| Release model | Branch cut from main at release time, or continuous deploy | Merge branch, then stabilise |

Trunk-based development pairs naturally with feature flags: incomplete work merges to trunk continuously behind a flag, so CI is always validating something close to what's actually deployed, instead of a branch that will need a large, risky merge later.

## Deployment approvals and change management

Not every deploy needs a human gate, but regulated or high-blast-radius changes usually keep one — an approval step that records who authorised a specific artefact to move to production, satisfying audit and change-management requirements without slowing down the fast path for everything else. The senior framing: approvals should be proportional to risk and should approve a *specific, already-tested artefact*, never trigger a new build.

## DORA metrics

| Metric | What it measures | Elite performer benchmark |
|---|---|---|
| Deployment frequency | How often you ship to prod | Multiple times per day |
| Lead time for changes | Commit to production | Under one hour |
| Change failure rate | % of deploys causing a production issue | 0–15% |
| Time to restore service | How fast you recover from a failure | Under one hour |

These four metrics (from Google's DevOps Research and Assessment program) correlate with organisational performance and are the standard framework for arguing "our pipeline is good" with numbers instead of opinions.

```yaml
# Minimal illustrative pipeline shape (provider-agnostic)
stages:
  - build
  - test
  - scan
  - package
  - deploy-staging
  - integration-test
  - approve
  - deploy-prod
  - smoke-test
```

## Cheat sheet

- Order stages cheapest-and-fastest-first; slow stages run later or in parallel, never gate the fast path.
- Ten-minute rule: build + unit tests + static analysis should give a signal in under ten minutes.
- Build the artefact once. Promote the identical bytes through every environment — never rebuild per environment.
- Tag artefacts immutably (commit SHA or digest), never with a mutable tag like `latest`.
- Environment differences live in injected config, not in the artefact.
- Prefer OIDC federation (short-lived, scoped tokens) over long-lived stored cloud credentials.
- Quarantine flaky tests immediately — they're worse than no test, because they erode trust in every red build.
- Trunk-based development + feature flags beats long-lived branches for merge risk and CI signal freshness.
- Track DORA's four metrics to argue pipeline quality with data: deploy frequency, lead time, change failure rate, MTTR.

## Common mistakes

| Mistake | Fix |
|---|---|
| Rebuilding the artefact separately for staging and prod | Build once, promote the same artefact/tag everywhere |
| Storing a long-lived cloud access key as a CI secret | Use OIDC federation for short-lived, scoped credentials |
| Slow, monolithic pipeline gating every merge | Reorder fast/cheap checks first; parallelise; move slow checks later |
| Tagging images with `latest` | Tag with commit SHA or content digest; never mutate a published tag |
| Letting a flaky test stay in the blocking suite | Auto-detect and quarantine it, with a deadline to fix or delete |
| Long-lived feature branches merged rarely | Move toward trunk-based development with feature flags |
| No human gate on any production deploy | Add a lightweight, risk-proportional approval for high-blast-radius changes |

## Summary

A well-designed pipeline orders its stages so the cheapest, most likely-to-fail checks run first, keeps the core feedback loop under ten minutes, and builds a single immutable artefact that is promoted — never rebuilt — through every environment so what you tested in staging is provably what ships to prod. Secrets should be short-lived and identity-federated rather than long-lived and stored, flaky tests should be quarantined immediately rather than tolerated, and trunk-based development with feature flags keeps CI signal fresh instead of testing a stale branch. DORA's four metrics — deployment frequency, lead time, change failure rate, and time to restore — give you a data-driven way to say whether any of this is actually working.

## Top Interview Questions

### Q1. What are the typical stages of a CI/CD pipeline, and why does the order matter?

A typical pipeline runs build, unit tests, static analysis, security scanning, packaging, deploy to non-prod, integration tests, an approval gate, deploy to prod, then a smoke test. The order matters because each stage should be ordered by a combination of speed and likelihood of catching a problem — you want a trivial compile error or a broken unit test to fail in seconds or minutes, not after twenty minutes of integration tests against real infrastructure. Getting the order backwards (say, running slow integration tests before fast unit tests) wastes compute and developer time on failures that cheaper checks would have caught first.

### Q2. What is the "build once, promote the same artefact" principle, and why is rebuilding per environment dangerous?

It means you build the deployable artefact exactly once from a given commit, then move that identical, immutable artefact through dev, staging and production without ever rebuilding it. Rebuilding per environment risks producing subtly different bytes each time — a dependency resolved at a slightly different moment, a different base image layer, a compiler or package manager picking up a patch release — even from identical source. That silently invalidates the entire point of testing in staging: you validated one set of bytes and are now shipping a different one to production, so "it worked in staging" no longer guarantees anything about what's actually deployed.

### Q3. Explain the ten-minute rule and how you'd apply it to a pipeline that currently takes 40 minutes.

The ten-minute rule says the core fast-feedback loop — build, unit tests, static analysis — should complete in under ten minutes, because beyond that developers stop waiting and context-switch, turning CI from immediate feedback into an ignored background process. For a 40-minute pipeline, I'd first identify what's actually gating the merge versus what's just bundled in sequentially — integration tests, security scans and load tests often don't need to block the fast signal. I'd parallelise independent test suites across runners, cache dependencies keyed on a lockfile hash, and move the slow stages to run either in parallel with the fast path or after merge, so the blocking signal developers see is fast even if the full pipeline still takes 40 minutes end-to-end.

### Q4. Why is OIDC federation preferred over storing cloud credentials as CI secrets?

A stored cloud credential (an access key, a service principal secret) is long-lived and durable — if the CI system or a log is ever compromised, that credential grants standing access until someone notices and manually rotates it. OIDC federation replaces this: the CI job presents a short-lived, signed identity token from the CI provider, the cloud provider validates it against a trust policy scoped to that specific repo/branch/job, and issues a credential that's valid only for the duration of that job run. There's nothing durable to steal, nothing to rotate, and the trust relationship is auditable and revocable at the policy level instead of depending on secret hygiene.

### Q5. What's the difference between trunk-based development and long-lived feature branches, and how does it affect CI?

Trunk-based development merges small changes to the main branch multiple times a day, using feature flags to hide incomplete work, so CI is almost always testing code close to what's actually deployed. Long-lived feature branches accumulate large diffs over days or weeks before merging, so CI on the branch is testing against an increasingly stale version of main, and the eventual merge carries much higher conflict and integration risk. I'd choose trunk-based development for most teams because it keeps CI signal meaningful and merge risk low, but it requires discipline around feature flags and small, safe-to-merge increments — teams that adopt it without that discipline end up merging half-finished, unflagged work.

### Q6. How would you handle a flaky test that fails about one time in twenty?

I wouldn't leave it in the blocking suite where engineers learn to just re-run CI on red — that erodes trust in every failure, including real ones. I'd want automatic detection (tracking pass/fail history per test to flag ones with inconsistent results across otherwise-identical runs), then quarantine it into a separate, non-blocking suite so it's still visible and tracked but no longer gates merges. I'd set a deadline to either fix the root cause (usually a timing assumption, shared test state, or an external dependency) or delete the test if it's not worth the investment — an untracked, indefinitely-ignored flaky test is functionally the same as no test.

### Q7. A production incident traces back to a config value that was correct in staging but wrong in production. What pipeline change would you make?

I'd check first whether the artefact deployed to production was actually the same one tested in staging, or whether it was rebuilt — if rebuilt, that's the first fix, since build-once-promote-everywhere is the real safeguard for "what we tested is what we shipped." Assuming the artefact was identical, the issue is in how environment configuration is injected — I'd move toward strict separation where config is validated (schema-checked, required-keys-present) as part of the deploy step for every environment, and where staging and production configs are generated from the same template with only intentional, reviewed differences, rather than being hand-maintained separately and prone to drift.

### Q8. What are the DORA metrics, and how would you use them to argue for investment in CI/CD improvements?

The four DORA metrics are deployment frequency, lead time for changes (commit to production), change failure rate, and time to restore service after a failure — research-backed as correlating with organisational performance. I'd use them to make an evidence-based case rather than an opinion-based one: if lead time is measured in days because of a slow, serial pipeline, or change failure rate is high because there's no automated rollback, that's a concrete, trackable number to point at before and after a proposed investment (parallelising tests, adding progressive delivery, adding OIDC-based deploy automation), rather than arguing "the pipeline feels slow."

### Q9. Why would you quarantine a flaky test instead of just deleting it immediately?

Immediate deletion risks losing real coverage if the test is actually catching a genuine intermittent bug — timing issues, race conditions, or a real production flakiness that the test happens to be surfacing. Quarantining first (moving it to a non-blocking suite, keeping it running and tracked, but not gating merges on it) buys time to actually investigate the root cause without letting it erode trust in the rest of the suite in the meantime. If investigation shows it's a genuinely flaky test-infrastructure problem (shared state, network timing) rather than a real bug, then deleting or rewriting it is the right call — but that should be a decision made after triage, not a reflex.

### Q10. How would you design approval gates so they don't become a bottleneck, while still satisfying change-management requirements?

I'd make gates proportional to risk rather than uniform: low-risk services or changes (internal tools, well-covered by automated tests and canary analysis) can promote automatically, while high-blast-radius changes (payments, auth, schema changes) keep a lightweight human or policy approval. Critically, the approval should apply to a specific, already-built, already-tested artefact — approving "please deploy artefact sha-a1b2c3d, which passed these checks" rather than triggering a fresh build — so the approval step itself never becomes a place where untested code sneaks in. I'd also track how often gates actually block something versus just add latency, and remove gates that consistently rubber-stamp without catching real issues.

### Q11. What's the risk of tagging container images with `latest`, and what should you do instead?

`latest` is a mutable pointer — it can silently resolve to different bytes today than it did yesterday, which breaks reproducibility (you can no longer answer "what exact code is running" or reliably reproduce an incident) and makes rollback ambiguous, since "roll back to the previous `latest`" isn't a well-defined operation once the tag has moved again. Instead, tag every build with an immutable identifier — the commit SHA or a content digest — push that specific tag, and have every environment reference that exact tag. `latest` can still exist as a convenience alias for local development, but it should never be what production deployments actually pin to.

### Q12. How do you keep integration tests fast enough that they don't blow past the ten-minute feedback target, without cutting real coverage?

I'd run integration tests in parallel against ephemeral, disposable environments (spun up per test run rather than a shared, contended staging environment), and split them across runners by historical duration so the slowest suite doesn't serialize behind faster ones. I'd also separate "must block the merge" integration tests (core critical paths) from a broader regression suite that runs asynchronously after merge or on a schedule, rather than trying to fit every integration test into the pre-merge gate. The goal is that the blocking signal a developer waits on stays fast, while the full depth of testing still happens — just not synchronously in the critical path of every commit.
