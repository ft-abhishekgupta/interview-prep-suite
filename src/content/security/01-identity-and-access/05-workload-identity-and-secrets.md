---
title: Workload Identity and Secrets
description: Why long-lived credentials are a liability, how managed identity removes secrets entirely, and how to rotate, scan for, and respond to leaked secrets
difficulty: Advanced
tags: [workload-identity, secrets-management, managed-identity, mtls, azure]
---

Every service needs to prove who it is to every other service and database it talks to — and for decades the default answer was a connection string or API key sitting in a config file. Interviewers use this topic to check whether you understand what replaced that pattern and why, because "we rotate our secrets quarterly" is a much weaker answer than "we don't have secrets to rotate for this call."

## The problem with connection strings and long-lived credentials

A connection string or API key embedded in configuration is a **long-lived, static, bearer credential**: whoever has the string has full access, indefinitely, until someone manually rotates it. Concretely, this creates four recurring problems:

- **It has to live somewhere** — config files, environment variables, CI/CD variables — and every one of those is a place it can be accidentally committed, logged, or copied.
- **Rotation is manual and risky** — changing it means coordinating an update across every place it's deployed, often causing an outage if done carelessly.
- **It doesn't expire on its own** — a leaked key from two years ago might still work today.
- **It grants the same access to anyone holding it** — there's no way to tell "this call came from Service A vs a leaked copy of Service A's key."

> [!KEY]
> The strongest fix isn't better secret storage — it's removing the secret entirely. If a service's *identity* can be proven by the platform it runs on, there is no credential left to leak, rotate, or scan for.

## Service-to-service authentication options

| Approach | How it proves identity | Secret to manage? | Notes |
|---|---|---|---|
| Shared secret / API key | Both sides know the same static string | Yes — long-lived | Simplest, worst for rotation and blast radius |
| Client credentials + certificate | Client signs a token request with a private key | Yes, but a cert (rotatable, not sent over the wire) | Better than a shared secret — the private key never travels |
| Mutual TLS (mTLS) | Both sides present and validate X.509 certificates during the TLS handshake | Yes — certs, but short-lived certs are common | Strong, but needs a certificate authority and cert lifecycle management |
| Managed identity / workload identity federation | Cloud platform vouches for the service's identity based on where it's running | **No** | Requires the workload to run on a supporting platform (Azure, AWS, GCP, Kubernetes) |

> [!TIP]
> Rank these out loud when asked: shared secrets are worst (static, transferable, no rotation story by default), certificates and mTLS are meaningfully better (rotatable, not transmitted, revocable via CA), and managed/workload identity is best when available because it removes the credential from the equation entirely.

## How managed identity removes secrets entirely

With managed identity (Azure) or workload identity federation (AWS IAM roles for service accounts, GCP workload identity, Kubernetes service account tokens), the **platform itself** attests to the workload's identity — based on which VM, container, or Kubernetes service account is making the request — and issues a short-lived token on demand. The application code never stores or even sees a long-lived secret; it asks a local platform endpoint for a token and receives one valid for a short window (typically under an hour).

```mermaid
sequenceDiagram
    participant App as "App (VM/Container)"
    participant Platform as "Cloud Identity Platform"
    participant AAD as "Azure AD / Entra ID"
    participant DB as "Target Resource (e.g. SQL, Key Vault)"

    App->>Platform: Request token (local metadata endpoint, no secret)
    Platform->>AAD: Attest workload identity
    AAD-->>Platform: Short-lived access token
    Platform-->>App: Access token (cached until near expiry)
    App->>DB: Call with Authorization: Bearer token
    DB->>DB: Validate token, check RBAC role assignment
    DB-->>App: Response
```

## Token caching and expiry handling

Managed-identity tokens are short-lived by design (often 60–90 minutes), so the client SDK is responsible for **caching and refreshing** them rather than requesting a new one per call — hammering the metadata endpoint on every request adds latency and can hit rate limits. The standard pattern: cache the token in memory, check its expiry before each use, and only request a new one when it's within a safety margin (e.g. 5 minutes) of expiring. `Azure.Identity`'s `DefaultAzureCredential` and equivalent SDKs in other clouds do this automatically — a senior answer mentions that you should rely on the SDK's caching rather than hand-rolling it.

## Secret management systems

For the secrets that genuinely can't be eliminated (third-party API keys, database passwords for non-cloud-native systems), a dedicated secret manager (Azure Key Vault, HashiCorp Vault, AWS Secrets Manager) replaces scattered config values with a single, access-controlled, auditable store.

| Concern | What a vault provides |
|---|---|
| Access control | Fine-grained policies (who/what can read *this specific* secret) or platform RBAC role assignments |
| Versioning | Every update creates a new version; old versions remain retrievable during a rotation window |
| Auditability | Every read/write is logged — who accessed which secret, when |
| Distribution | Applications fetch secrets at startup/runtime via SDK or sidecar, instead of secrets living in config files |

> [!NOTE]
> Vault "access policies" (an older, per-secret ACL model in some products) and platform RBAC (role assignments scoped to a vault or resource group) solve the same problem differently — RBAC is generally preferred today because it's consistent with how the rest of the platform's permissions work, and it's centrally auditable alongside every other role assignment.

## Rotation without downtime: the dual-credential pattern

Rotating a secret naively — generate new, update everywhere, delete old — causes an outage the moment any consumer is still using the old value during the update window. The safe pattern is **dual credentials**: generate a new secret *version* while the old one remains active, roll out the new version to all consumers, verify they've all picked it up, and only then disable/delete the old version. Most secret managers support exactly this via versioning: both versions are simultaneously valid for a transition window, so there's no instant where every consumer must have already switched.

> [!WARNING]
> "Rotate the secret" is not a single atomic action across a distributed system — treat it as a two-phase rollout (introduce new, confirm adoption, retire old), the same way you'd think about any breaking API change across multiple deployed consumers.

## Secret scanning and what to do when a secret leaks

Secret scanning (GitHub secret scanning, `gitleaks`, `trufflehog`, and equivalents built into CI) inspects commits, pull requests, and sometimes container images for patterns matching known credential formats (AWS keys, connection strings, private keys) and flags or blocks them before merge. When a secret is confirmed leaked — committed to a repo, pasted into a log, exposed in a public error message — the response is not "rotate it eventually":

1. **Revoke/rotate immediately**, even before root-causing how it leaked — assume it's already been harvested.
2. **Purge it from history** if committed to git (rewriting history, not just a follow-up commit deleting it — the old commit is still reachable).
3. **Audit for misuse** — check access logs for the credential's activity during the exposure window.
4. **Fix the leak path** — remove it from CI logs, add it to scanning rules, add a pre-commit hook.

> [!DANGER]
> Deleting a secret from the latest commit does **not** remove it from git history — anyone who clones the repository can still find it in an earlier commit. Treat any committed secret as compromised and rotate it; do not treat "I deleted the line" as remediation.

## Secrets in CI/CD and containers

CI/CD pipelines and containers are common leak points because secrets need to reach a running process without ever appearing in source or build logs:

- **CI/CD**: use the platform's encrypted secret store (GitHub Actions secrets, Azure DevOps variable groups marked secret) — never plain repo variables — and be aware that secrets are still visible to anything the pipeline `echo`s or logs; mask them explicitly.
- **Containers**: avoid baking secrets into image layers (`ENV SECRET=...` in a Dockerfile is permanently in the image history, even if a later layer overwrites it) — inject secrets at runtime via environment variables from an orchestrator's secret store, or better, mount them from a vault via a sidecar/CSI driver, and prefer workload identity so the container never holds a static secret at all.

## Managed identity token acquisition in C#

```csharp
// No connection string, no client secret in config at all
var credential = new DefaultAzureCredential();

var client = new SecretClient(
    new Uri("https://myvault.vault.azure.net/"),
    credential);

// SDK handles token acquisition, caching, and refresh internally
KeyVaultSecret secret = await client.GetSecretAsync("ThirdPartyApiKey");

// Same credential works for SQL, Storage, Service Bus, etc.
var sqlConnection = new SqlConnection(
    "Server=myserver.database.windows.net;Database=mydb;Authentication=Active Directory Managed Identity;");
```

> [!TIP]
> The line to say out loud: "this code has no secret in it at all — the platform attests to the VM/container's identity, and `DefaultAzureCredential` handles token acquisition, caching, and refresh transparently."

## Cheat sheet

- The best secret is the one that doesn't exist — prefer managed/workload identity over any credential.
- Rank service-to-service auth: shared secret (worst) < client cert / client credentials < mTLS < managed identity (best, when available).
- Managed identity tokens are short-lived — cache and refresh them, don't fetch on every call.
- Use a vault for secrets that truly can't be eliminated: access control, versioning, and audit logging in one place.
- Prefer platform RBAC role assignments over legacy per-secret access policies where both exist.
- Rotate with the dual-credential pattern: introduce new, confirm adoption, then retire old — never a single atomic swap.
- A committed secret is compromised the moment it's pushed — rotate immediately, purging history is not sufficient remediation on its own.
- Never bake secrets into Docker image layers — they persist in image history even after being overwritten.
- Mask secrets explicitly in CI/CD logs — anything a pipeline step echoes can leak even from an "encrypted" secret store.

## Common mistakes

| Mistake | Fix |
|---|---|
| Storing a database connection string with a password in app config | Use managed identity to authenticate directly, no password at all |
| Requesting a fresh managed-identity token on every single call | Cache the token and refresh only near expiry, or rely on the SDK's built-in cache |
| Rotating a secret by deleting the old one immediately | Use dual-credential rotation: add new, confirm adoption, then remove old |
| Assuming a deleted commit removes a leaked secret from git | Treat any committed secret as compromised; rotate immediately regardless of history cleanup |
| Baking a secret into a Dockerfile `ENV` instruction | Inject secrets at runtime from a vault or orchestrator secret store |
| Logging request/response bodies that include auth headers | Explicitly redact known secret/token fields before logging |

## Summary

Long-lived, static credentials are a liability precisely because they never expire on their own, must be manually rotated, and grant identical access to anyone who holds a copy — managed identity and workload identity federation solve this by having the platform itself vouch for a workload's identity and issue short-lived tokens on demand, removing the secret entirely. For the credentials that can't be eliminated, a dedicated secret manager provides access control, versioning, and audit logging, and rotation should always be a two-phase dual-credential rollout rather than an atomic swap. When a secret does leak — and secret scanning exists precisely because it eventually will — the only correct response is immediate revocation and rotation, not just deleting the line where it was found.

## Top Interview Questions

### Q1. Why is a long-lived connection string or API key considered a security liability even if it's never committed to source control?

Because it's a static, bearer credential with no built-in expiry and no way to distinguish the legitimate service from anyone else holding a copy. It has to be stored somewhere — config files, environment variables, a secrets manager — and every one of those is a surface that can leak through misconfigured access, an overly verbose log line, or a compromised host. Rotating it is a manual, coordinated operation across every consumer, which teams tend to defer specifically because it's risky and disruptive, meaning in practice such credentials often live far longer than intended. And critically, once issued, it grants full access indefinitely — there's no automatic revocation the way a short-lived token has when it expires — so the "blast radius" of a single leak is unbounded in time.

### Q2. Rank shared secrets, client certificates, mTLS, and managed identity for service-to-service authentication, and justify the order.

Shared secrets (API keys, static passwords) are weakest: both sides hold an identical static value, it must be transmitted and stored somewhere, and possessing a copy is indistinguishable from being the legitimate service. Client credentials with a certificate are better — the private key never travels over the wire, only a signed proof does, and certificates can be issued with shorter validity and revoked via a CA. Mutual TLS raises the bar further by authenticating both sides during the TLS handshake itself, tying identity to the transport layer rather than an application-level token. Managed identity or workload identity federation is best when the platform supports it, because the workload never holds a credential at all — the cloud platform attests to identity based on what's actually running (this specific VM, container, or service account), and issues short-lived tokens on demand, eliminating the "credential to leak" problem entirely rather than just making it harder to exploit.

### Q3. How does managed identity actually work — what is the platform attesting to, and what happens if the underlying VM or container is compromised?

The platform (e.g., Azure) associates an identity with a specific compute resource — a VM, an App Service instance, an AKS pod via workload identity federation — at the infrastructure level, outside the application's control. When the application calls a local metadata endpoint for a token, the platform verifies the request is genuinely coming from that specific resource (not just anyone who can reach the endpoint's IP — it typically requires being on the resource itself, and often an additional local secret header), then mints a short-lived Azure AD token for that identity and returns it. If the underlying VM or container is fully compromised, an attacker running code on it can indeed request tokens the same way the legitimate app would — managed identity removes the "stolen static secret" attack vector, but it doesn't defend against full compute compromise; that's a different, deeper problem requiring host-level hardening, and it's worth naming this limitation explicitly rather than implying managed identity is a silver bullet.

### Q4. What is the dual-credential (or "two-phase") pattern for secret rotation, and why is a naive rotate-and-delete approach risky?

Naive rotation — generate a new secret, update it everywhere, delete the old one — creates a real risk of outage: any consumer that hasn't yet picked up the new value (a stale deployment, a cached config, a service that was down during the rollout) will suddenly fail once the old value is deleted, and in a distributed system you can rarely guarantee every consumer switches atomically. The dual-credential pattern avoids this by keeping both the old and new secret simultaneously valid during a transition window: introduce the new version, roll it out to all consumers, actively verify (via logs or metrics) that nothing is still using the old version, and only then disable or delete it. Most secret managers support this natively through secret versioning — both versions are independently retrievable and valid until you explicitly revoke the old one — so rotation becomes a monitored rollout rather than a single risky cutover.

### Q5. A secret was accidentally committed to a public GitHub repository and caught by secret scanning three hours after the push. Walk through your incident response.

First, treat the secret as compromised the instant it was pushed, not from when it was caught — assume it may already have been scraped by an automated bot, since public repos are scanned within minutes by opportunistic attackers. Immediately revoke or rotate the credential at its source (rotate the database password, regenerate the API key) before doing anything else, because remediation speed matters more than root-causing at this stage. Next, audit the compromised credential's access logs for the exposure window to check for any unauthorized use. Then remove the secret from git history — a follow-up commit that deletes the line is not sufficient, since the original commit remains reachable in history and via forks/clones already made — using history-rewriting tools, understanding that if the repo was already cloned or forked, the secret may persist elsewhere regardless. Finally, close the actual leak path: add the pattern to secret-scanning rules, add a pre-commit hook, and review why the secret was in source instead of a vault or environment-injected value in the first place.

### Q6. What's the difference between access policies and RBAC role assignments in a secret vault, and which would you recommend today?

Access policies are a vault-specific, per-secret (or per-vault) access control list model — you grant a specific identity specific permissions (get, list, set) directly on the vault, managed independently of the platform's broader role system. RBAC role assignments use the cloud platform's general-purpose role-based access control — the same mechanism used to grant access to other resources like storage accounts or databases — scoped to the vault or even to individual secrets in newer implementations. RBAC is generally the better recommendation today: it's centrally auditable alongside every other permission in the platform (one place to review "who can access what," not a separate access-policy list per vault), integrates with the platform's built-in and custom role definitions, and avoids the access-policy model's tendency to accumulate stale, hard-to-review grants over time as team membership changes.

### Q7. How would you handle secrets in a Kubernetes-based CI/CD pipeline without ever writing them into a Docker image?

Avoid `ENV` or `ARG` instructions carrying secret values in the Dockerfile entirely — even if a later layer overwrites the value, the original layer is still present in the image history and can be extracted. Instead, inject secrets at runtime: use Kubernetes Secrets mounted as files or environment variables at container start (better yet, a CSI secrets store driver pulling directly from a vault so the secret never sits in etcd unencrypted), or — the strongest option — use workload identity federation so the pod's service account is trusted directly by the cloud identity platform and the application requests short-lived tokens with no static secret involved at any point. In the CI pipeline itself, use the CI platform's encrypted secret store (not plain repository variables) for any credentials needed to build or deploy, and explicitly mask them in logs, since a `RUN echo $SECRET` style debug line in a build script is a surprisingly common leak path even when the underlying storage is secure.

### Q8. Why do managed-identity tokens need to be cached client-side, and what's the risk of not doing so?

Managed-identity tokens are deliberately short-lived (commonly under 90 minutes) so that a leaked token has a small window of usefulness, but requesting a brand-new token on every single outbound call adds unnecessary latency (an extra network round trip to the metadata endpoint before every real request) and can hit rate limits on the identity platform's token endpoint under high request volume, causing throttling failures that look like outages. The standard fix is for the client (ideally via the platform SDK, like `DefaultAzureCredential`) to cache the token in memory, check its remaining validity before use, and only fetch a new one when it's within a safety margin of expiring. Not doing this — treating the token endpoint like a stateless lookup on every call — is a common performance bug that shows up under load testing, not in development, which is exactly why interviewers ask about it.

### Q9. What's the difference between mTLS and a bearer token like an access token, from a security-properties standpoint?

A bearer token proves nothing about *how* it's being presented — whoever holds a valid, unexpired bearer token can use it, which is why bearer tokens must be protected in transit (TLS) and kept out of logs; possession alone is authorization. Mutual TLS authenticates both parties as part of establishing the transport connection itself, using certificates and private keys that are never transmitted (only used to sign a challenge during the handshake) — so an attacker who intercepts network traffic, or steals a log containing a bearer token, gains nothing from mTLS the way they might from a leaked bearer token. The trade-off: mTLS requires a certificate authority and lifecycle management (issuance, rotation, revocation) on both client and server sides, which is more operational overhead than issuing bearer tokens from a central authorization server, so it's typically reserved for high-trust internal service meshes rather than public-facing APIs.

### Q10. A teammate proposes storing a third-party API key as a plain environment variable in the container spec, arguing "it's not in source control, so it's fine." How do you respond?

Not being in source control removes one leak path but leaves several others open: environment variables are visible to anyone who can `kubectl describe` or exec into the pod, they often get dumped verbatim into crash reports or diagnostic logs, and they're visible in the orchestrator's own configuration store (etcd, unless separately encrypted) to anyone with sufficiently broad platform access. The better approach is to store the key in a proper secret manager (Key Vault, Secrets Manager, Vault) with its own access control and audit logging, and either inject it at runtime through a secrets CSI driver / init-container pattern, or — if the third party supports it — see whether a workload-identity-based integration exists so no static key is needed at all. The core point to make clearly: "not in git" is necessary but nowhere near sufficient for calling something securely managed; the bar is access control, audit logging, and rotation capability, not just where the string happens to sit at rest.

### Q11. How does token audience matter when a managed identity is used to call multiple different resources (e.g. Key Vault and a SQL database)?

A managed identity's token is scoped, at request time, to a specific resource audience — the application explicitly asks for a token *for* Key Vault, or *for* the SQL resource's endpoint, and receives a token whose `aud` claim reflects that specific target; it does not receive one universal token usable everywhere. This means each downstream resource independently validates that the token was actually issued for it, following the same audience-validation principle as any OAuth/OIDC-issued token, and a token minted for Key Vault access would be rejected if presented to the SQL database. Practically, this means application code using `DefaultAzureCredential` (or equivalent) typically requests a token per resource type/scope it needs, and the SDK handles caching each one separately — it's not one token reused everywhere, even though it's the same underlying identity behind all of them.

### Q12. Design the authentication approach for a new microservice that needs to read from Key Vault, write to a Storage account, and call one third-party SaaS API that only supports API keys.

For Key Vault and Storage, use managed identity end to end: assign the microservice's compute resource (App Service, container, VM) a managed identity, grant it the minimum RBAC roles needed on each resource (`Key Vault Secrets User`, `Storage Blob Data Contributor`), and use the platform SDK's default credential so no secret is stored anywhere for either integration. For the third-party SaaS API that only supports a static API key, there's no way to avoid a secret entirely, so store that one key in Key Vault (which the service can already read via its managed identity), fetch it at startup or on a cached refresh interval rather than hardcoding it in config, and make sure it's included in secret-scanning rules and rotation tracking even though it can't be eliminated the way the cloud-native credentials were. The design principle to state explicitly: eliminate secrets wherever the platform allows it, and for the ones you're stuck with, manage them through the same vault-and-rotation discipline rather than treating them as a special case.
