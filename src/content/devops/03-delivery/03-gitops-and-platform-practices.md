---
title: GitOps and Platform Practices
description: The four GitOps principles, why pull-based reconciliation beats push-based deployment, how ArgoCD and Flux converge cluster state to Git, and when the extra ceremony isn't worth it
difficulty: Advanced
tags: [gitops, kubernetes, platform-engineering, argocd]
---

GitOps takes the idea of "infrastructure as code" one step further: instead of a pipeline pushing changes *to* your cluster, an agent inside the cluster continuously pulls the desired state *from* Git and reconciles reality to match it. This page covers the principles, the push-vs-pull trade-off, repository structure, secrets, and the platform-engineering practices that build on top of GitOps — plus the honest case for when it's more process than a team actually needs.

## The four GitOps principles

1. **Declarative** — the entire system's desired state is expressed declaratively (Kubernetes manifests, Helm values, Kustomize overlays), not as a sequence of imperative commands.
2. **Versioned and immutable** — that desired state lives in Git, giving you a full audit trail, diffable history, and the ability to check out any prior state exactly.
3. **Pulled automatically** — an in-cluster agent pulls changes from Git; nothing outside the cluster needs standing write access to push into it.
4. **Continuously reconciled** — the agent doesn't just apply once; it continuously compares live state to Git and corrects any divergence, on a loop, forever.

> [!KEY]
> The principle people forget is #4. GitOps isn't "we deploy via a Git-triggered pipeline" — that's still push-based CD with extra steps. GitOps means the cluster is *continuously* pulled back toward whatever Git says, even hours after a manual change, with no new commit needed to trigger the correction.

## Push vs pull deployment

| | Push-based (traditional CD) | Pull-based (GitOps) |
|---|---|---|
| Who initiates | CI pipeline, from outside the cluster | An in-cluster agent (ArgoCD/Flux) |
| Cluster credentials needed outside cluster | Yes — CI needs a kubeconfig/token with write access | No — the agent has access, CI only needs Git write access |
| Corrects manual `kubectl` drift | No — drift persists until the next pipeline run | Yes — reconciliation loop reverts it automatically |
| Blast radius of a compromised CI system | Can push directly to any connected cluster | Can only modify Git; cluster access is a separate boundary |
| Source of truth for "what's running" | The last pipeline run's logs | The Git repository, always |

> [!TIP]
> The security argument is the one that lands best in interviews: pull-based GitOps means your CI system — often the most externally-exposed, highest-blast-radius system you have — never holds a credential capable of directly mutating production. That's a meaningfully smaller attack surface than push-based CD.

## The reconciliation model (ArgoCD / Flux)

Both tools run a controller inside (or alongside) the cluster that watches a Git repository, renders the manifests (plain YAML, Helm, or Kustomize), and diffs the rendered output against the live cluster state on a loop — typically every few minutes, or immediately on a Git webhook.

```mermaid
flowchart LR
    Dev["Developer"] -->|"git push"| Repo["Config Repo"]
    Repo -->|"pull"| Ctrl["ArgoCD / Flux Controller"]
    Ctrl -->|"render manifests"| Render["Rendered YAML"]
    Render -->|"diff vs live"| Cluster["Live Cluster State"]
    Ctrl -->|"apply diff"| Cluster
    Cluster -->|"report drift/health"| Ctrl
```

If the live state matches Git, nothing happens. If it diverges — a new commit, or someone manually edited a resource — the controller applies whatever is needed to bring the cluster back in line with Git, and surfaces the result as a sync status (`Synced`/`OutOfSync`) and a health status per application.

## Repository structure — app repo vs config repo

A common mistake is putting application source code and Kubernetes manifests in the same repository with the same lifecycle. Separating them gives each repo a purpose-fit workflow:

| | App repo | Config repo |
|---|---|---|
| Contains | Source code, Dockerfile, unit tests | Kubernetes manifests / Helm charts / Kustomize overlays, per environment |
| Changes on | Every code commit | Only on a deliberate promotion (new image tag, config change) |
| Who commits | Application developers | CI (image tag bump), platform team (config changes) |
| Triggers | CI build/test/package | GitOps controller sync |

CI in the app repo builds and pushes an immutable artefact, then writes the new tag into the config repo (a commit, often automated) — the config repo is what the GitOps controller actually watches. This separation means a Git history of the config repo *is* the deployment history: every production change, whether an image bump or a resource limit tweak, is one commit, by one author, reviewable in a pull request.

## Promotion between environments

Promotion is a Git operation, not a pipeline re-run: to promote a build from staging to production, you change the image tag or config in the production overlay of the config repo — typically a pull request that copies the already-tested tag from the staging path — and the GitOps controller for the production cluster picks it up. This makes environment promotion auditable (a diffable PR) and enforces "the same artefact that passed staging is what production gets," directly reinforcing the build-once-promote-everywhere principle.

```
config-repo/
  apps/checkout/
    base/
    overlays/
      staging/kustomization.yaml     # image: checkout:sha-a1b2c3d
      production/kustomization.yaml  # image: checkout:sha-a1b2c3d  (bumped via PR after staging soak)
```

## Secrets in GitOps

Git is not a safe place for plaintext secrets, but GitOps needs *something* representing secret state to be in Git for the "everything is in Git" principle to hold. Two common answers:

- **Sealed Secrets** — a controller-side keypair encrypts secrets client-side into a `SealedSecret` custom resource that's safe to commit; only the controller in the target cluster can decrypt it back into a normal `Secret`.
- **External Secrets Operator** — the Git repo stores only a *reference* (a path/key in Vault, AWS Secrets Manager, Azure Key Vault), and an in-cluster operator fetches the real value at sync time and materialises it as a native `Secret` — the actual value never touches Git at all.

> [!WARNING]
> "We'll just base64-encode the secret and commit it" is not encryption — Kubernetes `Secret` objects are base64, not encrypted, and this is a common junior mistake that ships plaintext credentials straight into Git history.

## Drift correction and the danger of manual changes

Because reconciliation is continuous, any manual `kubectl edit` or `kubectl apply` against a GitOps-managed resource is temporary — the next reconciliation loop reverts it back to whatever Git says, often within minutes. This is a feature during an incident caused by unauthorised drift, but it's a trap for an on-call engineer who manually "fixes" something live under pressure and doesn't also fix it in Git — the fix quietly disappears, and the same incident recurs.

> [!DANGER]
> The rule to state out loud: in a GitOps cluster, **if it isn't in Git, it isn't real** — a manual hotfix during an incident must be followed immediately by the equivalent commit, or the reconciliation loop will erase it.

## Rollback by reverting a commit

Because Git *is* the desired state, rollback is `git revert` on the config repo — no separate deployment tooling, no re-running a pipeline against an old artefact. The revert commit changes the desired state back to the previous image tag/config, the GitOps controller notices the diff on its next reconciliation pass, and reconciles the cluster back to it — using exactly the same mechanism as every other change, which means rollback is tested by the same process as every forward deploy, not a rarely-exercised special path.

## Multi-cluster management

GitOps scales naturally to many clusters because the pattern is the same repeatable primitive per cluster: each cluster runs its own controller pointed at its own path/branch in the config repo (or a dedicated repo). A common structure is one overlay directory per cluster/environment combination, with a shared base — so a fleet of ten regional clusters is ten small overlay diffs against one common base, not ten independently-maintained full configurations.

## Platform engineering and golden paths

Platform engineering builds on GitOps by packaging these patterns into a **golden path** — a paved, opinionated, self-service way for application teams to get a new service into production (a template config repo, a standard set of manifests, sane defaults for autoscaling and resource limits) without needing deep Kubernetes or GitOps expertise themselves. The platform team owns the golden path's quality and evolution; application teams consume it and deviate only when they have a genuine reason to.

## When GitOps adds more ceremony than value

GitOps is not free — it requires a config repo, a controller, secret tooling, and team discipline about never bypassing Git. For a single small team running one or two simple services, a straightforward CD pipeline that applies manifests directly may reach production just as reliably with far less infrastructure to operate. The honest signal for "GitOps is worth it": multiple clusters, multiple teams needing an audit trail, a compliance requirement for who-changed-what, or enough manual-change incidents that continuous reconciliation's self-healing property earns its keep. Below that scale, it's reasonable to say so in an interview rather than treating GitOps as universally correct.

## Cheat sheet

- Four principles: declarative, versioned, pulled automatically, continuously reconciled. The "continuous" part is what most people miss.
- Pull-based GitOps means CI never holds cluster-write credentials — a real, statable security improvement over push-based CD.
- Separate app repo (code, builds) from config repo (manifests) — config repo history *is* your deployment history.
- Promotion between environments = a PR bumping a tag/config in the config repo, not a pipeline re-run.
- Never commit plaintext secrets — use Sealed Secrets (encrypted-in-Git) or External Secrets Operator (reference-in-Git, value fetched at sync).
- In a GitOps cluster, if it isn't in Git, it isn't real — manual fixes get silently reverted by the next reconciliation loop.
- Rollback is `git revert` — the same mechanism as every other change, not a special path.
- GitOps scales to multi-cluster via shared base + per-cluster overlays.
- It's fine to say GitOps is overkill for a single small team on one or two services — name the trade-off honestly.

## Common mistakes

| Mistake | Fix |
|---|---|
| Calling any Git-triggered pipeline "GitOps" | Real GitOps requires continuous, pull-based reconciliation, not just a Git-triggered push |
| Base64-encoding a secret and committing it | Base64 is not encryption; use Sealed Secrets or an External Secrets Operator |
| Mixing app code and manifests in one repo with one lifecycle | Separate app repo (builds) from config repo (desired state) |
| Manually patching a resource during an incident and stopping there | Also commit the equivalent fix to Git, or reconciliation reverts it |
| Giving CI a standing cluster-admin kubeconfig | Let the in-cluster GitOps controller hold cluster access; CI only needs Git write access |
| Adopting ArgoCD/Flux for a single small service "because it's best practice" | Weigh the operational cost honestly against team size and actual audit/compliance need |

## Summary

GitOps means Git is the single, versioned source of truth for desired state, and an in-cluster controller continuously pulls and reconciles the cluster to match it — not just a pipeline that pushes on commit. That pull-based model removes the need for CI to ever hold cluster-write credentials, makes rollback a plain `git revert`, and turns any manual drift into something the reconciliation loop actively corrects rather than silently tolerates. Separating the app repo from the config repo, handling secrets via sealed values or external references rather than plaintext, and building golden paths on top for platform teams are the practices that make this scale across many services and clusters — but it's a legitimate senior answer to say GitOps is more ceremony than a single small team needs.

## Top Interview Questions

### Q1. What are the four core principles of GitOps?

Declarative — the whole system's desired state is expressed as configuration, not imperative steps. Versioned and immutable — that configuration lives in Git, giving a full audit trail and the ability to check out any historical state exactly. Pulled automatically — an agent inside the target environment pulls changes from Git, rather than an external system pushing into it. Continuously reconciled — the agent doesn't apply once and stop; it repeatedly compares live state to Git and corrects any divergence, indefinitely. The principle people most often miss is the last one: a pipeline that deploys on every commit but never re-checks afterward is still push-based CD, not GitOps.

### Q2. How does pull-based GitOps differ from push-based CI/CD, and why does it matter for security?

In push-based CD, the CI pipeline itself holds credentials capable of directly mutating the target cluster — it runs `kubectl apply` or equivalent from outside, against a cluster it has write access to. In pull-based GitOps, an agent running inside the cluster (ArgoCD, Flux) is the only thing with cluster-write access; it pulls the desired state from Git on its own schedule, and CI's job stops at writing to Git. This matters because CI systems are typically the most externally exposed, plugin-heavy, third-party-integrated system in a company's toolchain — if compromised under a push model, an attacker can directly touch production; under a pull model, a compromised CI system can only alter Git, which is a smaller, more auditable blast radius.

### Q3. Why would you separate the application source repository from the deployment configuration repository?

Because they have fundamentally different change cadences and different owners. The app repo changes on every code commit and is owned by application developers; a GitOps controller shouldn't be reconciling on every one of those commits, most of which aren't ready to deploy anywhere. The config repo changes only on a deliberate decision — CI writing a new immutable image tag after a build passes, or a platform engineer adjusting resource limits — and its Git history *is* the deployment history: every production change is one reviewable, diffable commit. Mixing them means the GitOps controller either reconciles too eagerly on irrelevant commits, or you lose the clean "config repo = deployment log" property entirely.

### Q4. How do ArgoCD or Flux actually keep a cluster in sync with Git?

A controller running in (or connected to) the cluster watches a Git repository for changes, renders the manifests it finds there — plain YAML, Helm charts, or Kustomize overlays — and continuously diffs that rendered output against the live state of the cluster, typically on a polling interval or via a webhook trigger. If the diff is empty, nothing happens. If Git has changed, or if live state has drifted for any other reason (including a manual `kubectl edit`), the controller applies whatever operations are needed to bring the cluster back in line with what Git declares, and reports a sync status and per-resource health back to the operator, usually visible in a dashboard.

### Q5. An on-call engineer manually patches a Deployment's replica count during an incident to fix it immediately. What happens next in a GitOps-managed cluster, and what should they actually do?

Because GitOps continuously reconciles live state back to whatever Git declares, the manual patch is only temporary — on the controller's next sync pass (often within minutes), it will see the live replica count no longer matches the Git-declared value and revert it back, silently undoing the on-call engineer's fix and potentially causing the same incident to recur. The correct action is to make the same change in Git — commit the updated replica count to the config repo — either before or immediately after the manual patch, so the two are consistent and the reconciliation loop reinforces the fix instead of erasing it. The rule to internalise: in a GitOps cluster, if a change isn't in Git, it isn't durable.

### Q6. How do you handle secrets in a GitOps workflow, given that Git shouldn't contain plaintext credentials?

Two common patterns. Sealed Secrets uses a controller-held asymmetric keypair: you encrypt a secret client-side into a `SealedSecret` custom resource that's safe to commit to Git, because only the controller running in the specific target cluster holds the private key needed to decrypt it back into a normal Kubernetes `Secret`. The External Secrets Operator takes a different approach: Git stores only a reference — a path or key name in an external store like Vault, AWS Secrets Manager, or Azure Key Vault — and an in-cluster operator fetches the actual value at sync time, so the real secret value never exists in Git at all. Both satisfy "everything the cluster needs is derivable from Git" without putting plaintext secrets in version control.

### Q7. How does rollback work in a GitOps model compared to a traditional deployment pipeline?

Rollback is a `git revert` on the config repository — you revert the commit that introduced the problematic change (an image tag bump, a config change), and the GitOps controller detects that the desired state in Git has changed back, then reconciles the cluster to match on its next pass. This is meaningfully different from a traditional pipeline where rollback might mean re-running a deployment job against an old artefact through a separate, less-exercised code path. In GitOps, rollback uses the exact same mechanism as every other change — a Git commit triggering reconciliation — so it's implicitly tested every time any normal deploy happens, rather than being a rollback-specific path that only gets exercised during an actual incident.

### Q8. How would you structure environment promotion (staging to production) in a GitOps setup?

I'd keep a shared base configuration with per-environment overlays (Kustomize) or per-environment values files (Helm), each pointed at by its own path in the config repo, watched by that environment's own GitOps controller instance. Promotion is then a pull request that copies the already-validated image tag or config change from the staging overlay into the production overlay — nothing is rebuilt, and the diff is small and reviewable, reinforcing that the same artefact that soaked in staging is exactly what reaches production. This makes promotion auditable by default: the PR history on the config repo is a complete, reviewable record of every environment promotion that's ever happened.

### Q9. How does GitOps scale to managing many clusters, for example ten regional production clusters?

Each cluster runs its own GitOps controller instance, pointed at its own path or branch within a shared config repository (or a dedicated repo per cluster, depending on team scale), typically structured as one shared base configuration plus a small overlay per cluster capturing only what's genuinely different — region-specific config, replica counts, feature flags. This means adding an eleventh cluster is adding one more small overlay against an already-proven base, not maintaining an eleventh fully independent configuration from scratch, and a change that should apply everywhere (a security patch, a shared resource limit change) can be made once in the base and automatically reconciled across every cluster's controller.

### Q10. What's the difference between "we deploy via a Git-triggered pipeline" and actual GitOps?

A Git-triggered pipeline applies changes to the cluster when a commit lands, but it's still push-based and one-shot — it runs once, applies, and stops; if something later drifts (a manual change, an external actor modifying a resource), nothing corrects it until the next commit happens to trigger another run. True GitOps adds continuous reconciliation: an in-cluster agent keeps comparing live state to Git indefinitely, correcting drift even when no new commit has occurred. The practical test: if someone manually edits a live resource in a GitOps-managed cluster, does it get silently reverted within minutes without any new Git activity? If yes, that's GitOps; if the drift just sits there until the next deploy, it's push-based CD with a Git trigger.

### Q11. When would you advise a team not to adopt GitOps tooling like ArgoCD or Flux?

For a single small team running one or two straightforward services, the operational cost of standing up a config repo, a controller, secret-management tooling, and the team discipline of never bypassing Git for a quick fix can outweigh the benefit — a well-built conventional CD pipeline can reach production just as reliably with meaningfully less infrastructure to learn and operate. I'd look for concrete signals that GitOps earns its cost: multiple clusters that need consistent configuration, multiple teams needing a reliable audit trail of who-changed-what, a compliance requirement for change history, or a track record of manual-drift incidents that continuous reconciliation would have actively prevented. Below that scale, recommending GitOps because it's "best practice" without naming the actual problem it solves is a weaker answer than acknowledging the trade-off honestly.

### Q12. How does GitOps support platform engineering's idea of a "golden path"?

Because GitOps already establishes a repeatable pattern — a config repo structure, a controller reconciling it, a known way to handle secrets and promotion — a platform team can package that pattern into a template: a standard config repo layout, pre-wired autoscaling and resource-limit defaults, a documented promotion flow, so a new application team can onboard a service into production by following one paved, opinionated path instead of designing their own Kubernetes and GitOps setup from scratch. The platform team owns evolving and hardening that golden path centrally (better defaults, security fixes, updated base images propagate to every consumer), while application teams get a fast, safe default and only deviate from it when they have a genuine, specific reason to.
