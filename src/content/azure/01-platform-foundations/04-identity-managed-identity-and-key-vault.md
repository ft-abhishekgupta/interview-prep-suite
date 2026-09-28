---
title: Identity, Managed Identity and Key Vault
description: How Microsoft Entra ID, managed identities and Key Vault let a production system run with zero stored secrets, and the gotchas in that story
difficulty: Core
tags: [azure, identity, managed-identity, key-vault]
---

"How do your services authenticate to each other and to data stores, and where do the secrets live" is one of the highest-value questions in an Azure interview, because the honest answer usually reveals whether a candidate actually removed connection strings or just says they did. This page covers Entra ID, service principals versus managed identities, and Key Vault integration end to end.

## Microsoft Entra ID basics

Microsoft Entra ID (formerly Azure AD) is Azure's identity provider — the directory behind an Azure tenant, holding users, groups, and application identities and issuing OAuth 2.0/OIDC tokens that Azure services trust. An Azure subscription is associated with one tenant/directory at a time, while large organisations can operate more than one tenant. Two identity types matter for service-to-service auth:

| Identity type | What it represents | Has credentials you manage? |
|---|---|---|
| Service principal (app registration) | An application's identity, usable across tenants, often backing a CI/CD pipeline or third-party app | Yes — client secret or certificate, which you create, store, and rotate |
| Managed identity | An identity tied to the lifecycle of an Azure resource | No — Azure creates, stores and rotates the credential for you |

## Service principals vs managed identities

A managed identity is really a **service principal that Azure manages for you** — same underlying object in Entra ID, but the credential lifecycle is invisible and automatic.

| Aspect | System-assigned managed identity | User-assigned managed identity |
|---|---|---|
| Lifecycle | Tied 1:1 to the resource — created and deleted with it | Standalone Azure resource, created independently |
| Reuse across resources | No — one identity per resource | Yes — assign the same identity to many resources |
| Typical use | A single App Service or VM needing its own identity | A fleet of VMSS instances, or Functions that should share one identity for consistent RBAC |
| Naming/discoverability | Same name as the resource, easy to lose track of at scale | Named and managed independently, easier to audit |
| Cleanup risk | Deleted automatically with the resource — no orphaned identity | Must be deleted separately, or it lingers after the resource is gone |

> [!KEY]
> Choose system-assigned when the identity's life should exactly match one resource. Choose user-assigned when multiple resources need the *same* permissions (so you manage one RBAC assignment, not N), or when the identity must be provisioned before the resource exists (e.g. referenced in an ARM template that grants RBAC ahead of deployment).

## How managed identity actually works

There are no secrets to store. The Azure host (App Service, AKS node, VM) exposes a local, non-routable **Instance Metadata Service (IMDS)** endpoint (`169.254.169.254` on VMs, or the equivalent `MSI_ENDPOINT`/`IDENTITY_ENDPOINT` on App Service/Functions) that only the resource itself can reach. Your app calls that local endpoint, Azure vouches for the resource's identity, and returns a short-lived OAuth token for the target resource (e.g. Key Vault, Storage).

```mermaid
sequenceDiagram
    participant App as "App Service"
    participant IMDS as "Local Identity Endpoint"
    participant Entra as "Microsoft Entra ID"
    participant KV as "Key Vault"
    App->>IMDS: Request token for https://vault.azure.net
    IMDS->>Entra: Exchange platform-issued credential for token
    Entra-->>IMDS: Short-lived access token (~1 hour)
    IMDS-->>App: Access token
    App->>KV: GET secret, Bearer token
    KV-->>App: Secret value (if RBAC allows)
```

> [!TIP]
> Say this out loud in an interview: "There is no credential anywhere in our code or config — the app calls a local metadata endpoint only reachable from inside the resource itself, gets a token good for about an hour, and the SDK handles caching and refresh automatically." That is the sentence that proves you understand it rather than just having used `DefaultAzureCredential` and had it work.

## DefaultAzureCredential and its gotchas

`DefaultAzureCredential` (Azure SDK for .NET, and equivalents in other languages) tries a sequence of credential sources in order until one succeeds, so the same code works locally (developer sign-in) and in production (managed identity) without branching.

```csharp
// Same code path locally and in Azure — the SDK figures out which credential source applies
var credential = new DefaultAzureCredential();
var client = new SecretClient(new Uri("https://myvault.vault.azure.net/"), credential);
KeyVaultSecret secret = await client.GetSecretAsync("SqlConnectionString");
```

Its lookup order (roughly): environment variables → workload identity (AKS) → managed identity → shared token cache → Visual Studio/Azure CLI/PowerShell sign-in → interactive browser (disabled by default in most configs).

> [!WARNING]
> `DefaultAzureCredential` tries each source with its own network call and timeout before falling through to the next, which can add multiple seconds of latency to the very first token request in a cold-start environment (Functions, containers) — especially if an earlier source in the chain is present but misconfigured and has to time out. In latency-sensitive or high-scale services, prefer specifying the exact credential type (e.g. `ManagedIdentityCredential`) directly instead of the full fallback chain, and always cache the credential/token, never construct it per-request.

## RBAC vs access policies on Key Vault

Key Vault has **two separate, mutually exclusive authorization models** — a detail that catches people who set RBAC roles and then wonder why access is still denied.

| Model | How permissions are granted | Granularity | Recommended today |
|---|---|---|---|
| Vault access policies (legacy) | Assigned directly on the vault resource, per object type (keys/secrets/certificates) | Per-vault only | No — being phased out in favour of RBAC |
| Azure RBAC | Standard Azure role assignments (e.g. Key Vault Secrets User) at vault, resource group, or subscription scope | Consistent with every other Azure resource, supports management-group-level policy | Yes |

> [!DANGER]
> A vault set to the RBAC authorization model ignores access policies entirely, and vice versa — if you grant an access policy on a vault that's configured for RBAC, it silently does nothing. Check the vault's "permission model" setting first before debugging "why can't my managed identity read this secret."

## Secrets, keys, and certificates

Key Vault stores three distinct object types with different intended use: **secrets** are opaque strings (connection strings, API keys) that Key Vault stores and returns as-is; **keys** are cryptographic keys that stay inside Key Vault's HSM/software boundary — you send Key Vault data to sign or encrypt, the key material itself never leaves; **certificates** are a managed combination of a key plus an X.509 certificate, with built-in auto-renewal via integrated CAs.

## Secret rotation and reload

Key Vault supports automatic rotation policies for its own generated secrets and can trigger an Event Grid notification on secret near-expiry or rotation, which an Azure Function or Logic App can use to update downstream systems. The harder problem is **cache invalidation on the consumer side** — an app that reads a secret once at startup and holds it in memory won't see a rotated value until it restarts, unless it explicitly re-reads periodically or subscribes to the rotation event.

| Rotation approach | Consumer impact |
|---|---|
| App reads secret at startup only | Requires app restart after rotation — simplest but has a real cutover gap |
| App re-reads on a timer (e.g. every 30 min) | No restart needed; brief window of using the old secret |
| App subscribes to Key Vault rotation event via Event Grid | Near-immediate reload, more moving parts |
| Managed identity + no secret at all | Nothing to rotate — the best answer where it's an option |

## Referencing Key Vault from App Service configuration

App Service and Functions support **Key Vault references** directly in application settings, so config looks like a normal app setting but is actually resolved from Key Vault at runtime using the app's own managed identity — no SDK code required in the app at all.

```bash
# App Service application setting value:
@Microsoft.KeyVault(SecretUri=https://myvault.vault.azure.net/secrets/SqlConnectionString/)
```

App Service resolves this using its managed identity, caches it, and automatically refreshes periodically — the simplest possible integration for configuration-style secrets, though it doesn't help with secrets your code needs to actively rotate mid-request (e.g. re-signing a token).

## The "eliminate all connection strings" story

This is the narrative interviewers are fishing for: instead of a SQL connection string with an embedded username/password sitting in App Service configuration (or worse, source control), the app's managed identity is granted a SQL database role directly (`CREATE USER [app-name] FROM EXTERNAL PROVIDER`), and the connection string contains only a server/database name plus `Authentication=Active Directory Managed Identity` (the SQL client keyword still uses the legacy wording). The same pattern extends to Storage (RBAC data roles instead of account keys), Service Bus (RBAC instead of shared access signatures), and Key Vault itself (RBAC instead of a stored vault credential) — the end state is zero long-lived secrets anywhere in config or code, and every credential is a short-lived token issued to a specific resource's identity.

## Cheat sheet

- Managed identity = a service principal Azure creates and rotates for you; no secret ever touches your code.
- System-assigned = 1:1 with a resource's lifecycle; user-assigned = standalone, reusable across many resources.
- Token flow: app → local IMDS/identity endpoint → Entra ID → short-lived (~1hr) token → target resource.
- `DefaultAzureCredential` is great for portability, but pin the concrete credential type in hot paths to avoid fallback-chain latency.
- Key Vault RBAC and legacy access policies are mutually exclusive per vault — check the permission model first.
- Secrets = opaque strings, keys = crypto material that never leaves the vault, certificates = key + X.509 with auto-renewal.
- App Service Key Vault references resolve secrets into app settings automatically via managed identity, no SDK needed.
- The end goal: SQL, Storage, Service Bus and Key Vault access are all RBAC + managed identity — zero stored connection strings.

## Common mistakes

| Mistake | Fix |
|---|---|
| Assuming Owner/Contributor RBAC grants Key Vault data access | Grant a Key Vault-specific data role (e.g. Key Vault Secrets User) separately |
| Setting an access policy on a vault configured for RBAC authorization | Check and match the vault's permission model before assigning access |
| Reading a secret once at app startup and never refreshing | Poll periodically or use Event Grid rotation notifications |
| Using the full `DefaultAzureCredential` chain in a latency-sensitive hot path | Use the specific credential type (e.g. `ManagedIdentityCredential`) directly |
| Leaving a user-assigned identity orphaned after deleting the resource that used it | Delete the identity explicitly as part of resource teardown |
| Storing a Key Vault URI or secret name as a hardcoded literal scattered across the codebase | Centralise secret references in configuration, resolved once at startup |

## Summary

Managed identity removes the hardest part of secret management — the secret itself — by letting Azure vouch for a resource's identity through a locally-reachable metadata endpoint and short-lived tokens, with `DefaultAzureCredential` making the same code portable from a developer's machine to production. Key Vault then centralises what secrets do remain (third-party API keys, anything that genuinely must be a string), authorized via RBAC rather than legacy access policies, and referenced directly from App Service configuration where possible. The complete story — SQL, Storage, Service Bus and Key Vault all reached via managed identity and RBAC — is what "we eliminated all connection strings" actually means, and it's worth being able to describe the token flow, not just claim the outcome.

## Top Interview Questions

### Q1. What is a managed identity, and how is it different from a service principal with a client secret?

A managed identity is an Entra ID service principal whose credential lifecycle Azure fully manages — it's automatically created, rotated, and tied to the lifecycle of an Azure resource (or standalone for user-assigned), so no application code ever sees or stores a secret. A traditional service principal (app registration) also has an Entra ID identity, but the client secret or certificate backing it is something you generate, store securely, and are responsible for rotating before it expires — if it leaks, it's a standing credential an attacker can use from anywhere. Managed identity tokens are also scoped to only be retrievable from inside the specific Azure resource (via the local instance metadata endpoint), whereas a service principal's client secret can authenticate from anywhere on the internet, which makes managed identity meaningfully lower-risk for Azure-to-Azure authentication.

### Q2. Walk me through what happens, step by step, when your App Service reads a secret from Key Vault using managed identity.

The app calls the local identity endpoint that Azure exposes only to that specific App Service instance (not reachable from outside it), requesting a token scoped to `https://vault.azure.net`. That local endpoint exchanges a platform-issued credential — something Azure itself manages behind the scenes, never visible to the app — with Microsoft Entra ID, which returns a short-lived (typically about one hour) OAuth access token if the resource's managed identity is valid. The app (via the Key Vault SDK, e.g. `SecretClient`) then calls Key Vault's data-plane API with that token as a bearer token; Key Vault checks whether the calling identity has an RBAC role like Key Vault Secrets User (or a legacy access policy, depending on the vault's configured model) and returns the secret value if authorized. The SDK caches the token and refreshes it before expiry, so this whole exchange doesn't repeat on every call.

### Q3. When would you choose a user-assigned managed identity over system-assigned?

User-assigned makes sense when multiple resources need to share exactly the same permissions — for example, twenty Function Apps that all need read access to the same Storage account — because you create one identity, grant it the RBAC roles once, and assign that same identity to every resource, instead of managing N separate RBAC assignments that have to stay in sync. It's also useful when the identity needs to exist before the resource does, such as an infrastructure-as-code deployment that grants RBAC roles to an identity in one step and then deploys the compute resource referencing it in a later step. System-assigned is simpler and preferable by default when exactly one resource needs its own distinct identity, because it's automatically cleaned up when the resource is deleted — no orphaned identity to remember to remove.

### Q4. What's the risk of using DefaultAzureCredential's full fallback chain in a production hot path, and how would you mitigate it?

`DefaultAzureCredential` tries a sequence of credential sources (environment variables, workload identity, managed identity, shared token cache, developer tool sign-ins) in order, and if an earlier source in that chain is present in the environment but misconfigured, it has to fail (often after a network timeout) before falling through to the next one — this can add meaningful latency to the very first token acquisition, which matters in a cold-started Function or a container that just scaled out. The mitigation is to use the specific credential class you actually need in production — `ManagedIdentityCredential` directly, for instance — rather than the full chain, reserving `DefaultAzureCredential` for local development convenience, sometimes via conditional configuration (e.g. only using the full chain when an environment variable indicates local development). Regardless of which credential type is used, the token itself should be cached and reused until near expiry rather than requested per call.

### Q5. Your team enabled Azure RBAC on a Key Vault, but an existing access policy that used to grant a service access no longer works. Why, and how do you fix it?

Key Vault has two mutually exclusive authorization models — legacy vault access policies and Azure RBAC — configured by a single "permission model" setting on the vault, and a vault can only honor one at a time. Switching a vault to RBAC mode means Key Vault stops evaluating access policies entirely, even ones that were previously working, so any identity that was only granted via an access policy loses access immediately, with no warning beyond a 403 the next time it tries to read a secret. The fix is to explicitly (re)grant the equivalent Azure RBAC role — for example, Key Vault Secrets User for read access, Key Vault Secrets Officer for read/write — to every identity that previously relied on the access policy, ideally as a scripted migration step performed atomically with (or just before) flipping the vault's permission model, rather than discovering the gap in production.

### Q6. How would you design secret rotation so that a database password change doesn't require restarting every app instance?

I'd avoid the problem at the SQL layer entirely by using managed identity with Microsoft Entra authentication to SQL Database instead of a username/password connection string — there's no password to rotate because there's no password. Where a secret genuinely can't be eliminated (a third-party API key, say), I'd set up the app to either re-read the secret from Key Vault on a periodic timer (short enough that the rotation window is acceptable, e.g. every 15–30 minutes) rather than only at startup, or subscribe to Key Vault's near-expiry/rotation Event Grid notification and reload on that signal for near-immediate propagation. The key design point to state explicitly: whichever mechanism you choose, the old and new secret typically need to both be valid for an overlap window, so instances that haven't refreshed yet don't fail mid-rotation.

### Q7. What's the difference between how Key Vault handles a "secret" versus a "key", and why does that distinction matter for compliance?

A secret is an opaque value Key Vault simply stores and returns verbatim to an authorized caller — a connection string or API key, for instance — meaning the caller does, at some point, hold the raw value in memory. A key is cryptographic material that is generated inside (or imported into) Key Vault's HSM or software-protected boundary and never leaves it in usable form: instead of retrieving the key, callers send data to Key Vault's `sign`/`encrypt`/`unwrapKey` operations and get back a result, with the key material itself staying inside the vault's protection boundary at all times. This matters for compliance regimes that require cryptographic keys to never exist outside an HSM — using Key Vault's key operations (rather than storing key material as a "secret" and doing crypto operations in application code) is often a hard requirement, not a nice-to-have, for things like signing certificates or encrypting data at rest under certain standards.

### Q8. A production incident report says "the app couldn't authenticate to Key Vault for 40 minutes after a cold restart, tokens kept failing." What would you investigate?

I'd first check whether the managed identity assignment itself was recent — there's a known propagation delay (sometimes several minutes) after first enabling a managed identity or granting it a new RBAC role, before Entra ID and the target resource fully recognize it, which can look exactly like intermittent auth failures right after a deployment or restart. Next I'd check whether the app was using `DefaultAzureCredential`'s full chain and whether an earlier credential source in that chain (e.g. a stale environment variable or leftover developer configuration accidentally shipped to production) was being tried and timing out before falling through to managed identity, which could explain a prolonged but eventually-recovering failure window. I'd also check the RBAC role assignment scope was correct (right vault, right role, right identity object ID, not a similarly-named one) and review Key Vault's diagnostic logs for the exact 403/401 reason code rather than guessing, since Key Vault's error responses distinguish between "no such secret", "not authorized", and "network/firewall blocked" causes.

### Q9. How do App Service Key Vault references work, and what are their limitations compared to calling the Key Vault SDK directly in code?

A Key Vault reference is a specially formatted application setting value (`@Microsoft.KeyVault(SecretUri=...)`) that App Service itself resolves at runtime using the app's managed identity, injecting the actual secret value into the app's environment as if it were a normal setting — so the application code doesn't need any Key Vault SDK code or awareness that Key Vault is even involved. The main limitation is that it's resolved and cached by the App Service platform on a schedule (roughly every few hours, or on app restart), not on-demand per request, so it's not suitable for secrets your application logic needs to actively force-refresh mid-request, and it only covers configuration-style secrets, not certificate signing operations or anything requiring the richer Key Vault key operations. For those cases you still need the SDK directly, using the same managed identity via `DefaultAzureCredential` or `ManagedIdentityCredential`.

### Q10. Your company wants to "eliminate all connection strings" as a security initiative. What does that actually involve, service by service?

For Azure SQL Database, it means creating a contained database user from the app's managed identity (`CREATE USER [app-name] FROM EXTERNAL PROVIDER`) and granting it the needed database roles, so the connection string contains only server and database names plus `Authentication=Active Directory Managed Identity` — no username or password. For Storage, it means replacing account-key-based connection strings with RBAC data roles (Storage Blob Data Contributor, etc.) assigned to the app's managed identity, and using the SDK's `DefaultAzureCredential`/`ManagedIdentityCredential` instead of a connection string with an embedded key. For Service Bus and Event Hubs, it's the same pattern — RBAC roles like Azure Service Bus Data Sender/Receiver instead of shared access signature connection strings. Anywhere a secret genuinely can't be eliminated (third-party SaaS API keys, for instance), it moves into Key Vault, accessed via managed identity, so the end state is: every first-party Azure-to-Azure connection uses managed identity and RBAC with zero stored secrets, and the only secrets that remain are for external systems, centralized in Key Vault rather than scattered in app configuration.
