---
title: Authentication vs Authorization
description: How identity is proven versus how access is granted, the vocabulary interviewers expect, and where each check belongs in a real system
difficulty: Foundational
tags: [authentication, authorization, identity, sso, sessions]
---

Authentication and authorization are the two questions every request answers before anything else happens: *who are you*, and *what are you allowed to do*. Interviewers use this topic to check that you have precise vocabulary, not just a vague sense that "auth" is a solved problem.

## The precise definitions, and the order they happen

Authentication (AuthN) always happens **before** authorization (AuthZ). You cannot decide what someone can do until you know who they are — even an "anonymous" role is still a resolved identity.

| | Authentication | Authorization |
|---|---|---|
| Question answered | Who are you? | What are you allowed to do? |
| Input | Credentials (password, token, certificate) | An established identity + a resource + an action |
| Output | An identity (and usually a token/session) | Allow or deny |
| Happens | First, once per session or token | Second, on every protected request |
| Failure status | `401 Unauthorized` | `403 Forbidden` |
| Typical mechanisms | Passwords, MFA, OAuth/OIDC login, mTLS | RBAC, ABAC, ACLs, policy engines |

> [!KEY]
> Authentication proves identity once; authorization is re-evaluated on every single request, because permissions can change between requests even when identity does not.

## Identity, credentials, and claims

These three words get used loosely in casual conversation but mean distinct things in a design discussion:

- **Identity** — the durable "who" a system tracks: a user ID, a service principal, a device. It exists whether or not anyone is currently logged in.
- **Credentials** — the secret or proof used to *assert* an identity at a point in time: a password, a private key, a client certificate, a one-time code. Credentials are exchanged once, during authentication.
- **Claims** — statements *about* an identity, carried in a token or session after authentication succeeds: `sub` (subject), `email`, `role`, `tenant_id`. Claims are what authorization logic actually reads — it almost never looks at the original credential again.

> [!TIP]
> A senior answer distinguishes these explicitly: "the password authenticates the user once; everything downstream — including authorization — operates on claims in the resulting token, not on the password."

## Authentication factors and MFA

Authentication factors fall into three independent categories. Multi-factor authentication (MFA) means combining factors **from different categories** — two passwords is not MFA.

| Factor category | Example | Weakness |
|---|---|---|
| Something you know | Password, PIN, security question | Phishable, reusable if leaked |
| Something you have | OTP app, hardware key (FIDO2/YubiKey), SMS code | Device can be lost or SIM-swapped |
| Something you are | Fingerprint, face recognition | Cannot be rotated if compromised |

Adaptive/risk-based authentication adds a fourth, softer signal — behavior and context (IP reputation, device fingerprint, impossible-travel detection) — to decide whether to *demand* a second factor rather than always requiring one.

> [!WARNING]
> SMS-based one-time codes are "something you have" only loosely — SIM swapping lets an attacker take over the factor without touching the victim's phone. Hardware keys (FIDO2/WebAuthn) are phishing-resistant because the browser binds the credential to the origin; SMS and TOTP codes are not.

## Session-based vs token-based authentication

Both answer "who is this request from", but they place state in different places.

| | Session-based | Token-based (e.g. JWT) |
|---|---|---|
| Where state lives | Server-side store (Redis, DB) + a session ID cookie | Self-contained token held by the client |
| Revocation | Instant — delete the server-side record | Hard — token is valid until it expires unless you track it |
| Scalability | Needs a shared session store across instances | Any instance can validate the token independently |
| Payload | Just an opaque ID | Carries claims (roles, tenant, expiry) — readable without a DB hit |
| CSRF exposure | Cookies sent automatically — needs CSRF tokens | If sent via `Authorization` header, not auto-attached, lower CSRF risk |
| Best fit | Traditional server-rendered web apps, first-party apps | APIs, mobile apps, microservices, third-party integrations |

Neither is universally "better" — session cookies with `HttpOnly`, `Secure`, `SameSite=Strict` are still a very strong default for a first-party web app; tokens shine when multiple independent services need to validate a caller without calling back to a central session store. The end-to-end token-based version of this looks like a simple round trip: sign in once, get a token back, then attach it to every request that follows.

![A client app logging a user in and receiving a JWT, then sending it on every subsequent request](notes/05-HighLevelDesign/ApiDesign/Auth/image.png)

## SSO and federation

**Single sign-on (SSO)** lets one login work across multiple applications. **Federation** is the underlying trust relationship that makes that possible across *organizational or domain boundaries* — it is the protocol layer (SAML, OIDC), not the user experience.

- **Identity provider (IdP)** — authenticates the user and issues signed assertions or tokens (Okta, Azure AD/Entra ID, Google Workspace).
- **Service provider (SP) / relying party (RP)** — the application that trusts the IdP's assertion instead of authenticating the user itself.

```mermaid
flowchart LR
    U["User"] --> SP["Service Provider<br/>(your app)"]
    SP -->|"redirect to authenticate"| IDP["Identity Provider"]
    IDP -->|"signed assertion / token"| SP
    SP -->|"trusts assertion, creates local session"| U
```

> [!NOTE]
> A single company can be both roles at once: it is the SP for its own employee login against Azure AD, and the IdP when it exposes "Sign in with Acme" to partner applications.

In practice, one login against a shared identity provider is what lets a single session cover an entire suite of otherwise-unrelated applications:

![A user logging in once against an identity provider and getting into Gmail, Google Drive and YouTube without re-authenticating](notes/05-HighLevelDesign/ApiDesign/Auth/image-43.png)

SAML and OIDC are the two protocols that actually carry the federated identity assertion, and a real deployment often runs both side by side — an older enterprise app wired up to SAML, a newer one using OIDC — against different identity providers:

![SAML-based SSO into Salesforce compared with OIDC-based SSO into Gmail, side by side](notes/05-HighLevelDesign/ApiDesign/Auth/image-44.png)

## Delegated authorization and machine-to-machine auth

**Delegated authorization** is when a user grants a third-party application limited access to their resources on another service, without sharing their password — the OAuth 2.0 model ("let App X read my Google Calendar"). The user authenticates to the resource owner's IdP; the third-party app never sees the credential, only a scoped access token.

**Machine-to-machine (M2M)** authentication has no user in the loop at all — a backend service authenticates as *itself* to call another service (a nightly batch job calling an internal API). This typically uses `client_credentials`, mutual TLS, or a cloud-native workload identity, and the resulting token's claims describe the *service*, not a person.

> [!DANGER]
> Do not reuse a long-lived user-session token for service-to-service calls "because it already has the right permissions." It couples service uptime to user session lifetime and makes audit logs show a human doing things a batch job did. Give machines their own identity.

## Where each check belongs in an architecture

```mermaid
flowchart TD
    C["Client"] --> GW["API Gateway<br/>validates token signature + expiry (AuthN)"]
    GW --> S1["Order Service<br/>checks role/scope for this action (AuthZ)"]
    GW --> S2["Billing Service<br/>checks tenant ownership (AuthZ)"]
    S1 --> DB[("Orders DB")]
    S2 --> DB2[("Billing DB")]
```

Authentication is usually centralized at the edge (gateway, BFF, or middleware) because it is the same check everywhere: is this token genuine and unexpired? Authorization is pushed **down to each service**, because only that service knows the business rule — "can this role cancel an order", "does this tenant own this resource" — and centralizing it fully tends to create a brittle god-service that every team must touch.

## Login plus an authorized API call

```mermaid
sequenceDiagram
    participant U as "User"
    participant C as "Client App"
    participant A as "Auth Server"
    participant R as "Resource API"

    U->>C: Enter credentials
    C->>A: POST /login (credentials)
    A->>A: Verify password + MFA
    A-->>C: Access token (claims: sub, role, exp)
    C->>R: GET /orders (Authorization: Bearer token)
    R->>R: Validate signature + expiry (AuthN)
    R->>R: Check role/scope for /orders (AuthZ)
    R-->>C: 200 OK with data
```

## 401 vs 403

- **401 Unauthorized** — really means "unauthenticated": no valid credentials were presented, or the token is missing/expired/malformed. The correct client action is to (re-)authenticate.
- **403 Forbidden** — identity is known and valid, but the action is not permitted for that identity. Re-authenticating will not help; the client needs different permissions.

> [!WARNING]
> The HTTP spec's naming is famously confusing — "401 Unauthorized" is about *authentication*, not authorization. Say this out loud in an interview; it shows you've actually implemented the distinction, not just memorized it.

## Cheat sheet

- AuthN answers "who", AuthZ answers "what can they do" — AuthN always runs first.
- Identity is durable, credentials are the one-time proof, claims are what authorization actually reads.
- MFA requires factors from **different** categories: knowledge, possession, inherence.
- Session auth: easy revocation, needs shared state. Token auth: no shared state, hard revocation.
- SSO is the user experience; federation (SAML/OIDC) is the trust protocol behind it.
- IdP issues identity assertions; SP/relying party trusts and consumes them.
- Delegated authorization = acting on a user's behalf with their consent; M2M = a service acting as itself.
- Centralize authentication at the edge; push authorization down to the owning service.
- 401 = not authenticated (re-login helps); 403 = authenticated but denied (re-login will not help).

## Common mistakes

| Mistake | Fix |
|---|---|
| Returning 403 when a token is simply missing or expired | Return 401; reserve 403 for a valid identity lacking permission |
| Treating SSO and federation as the same thing | SSO is the UX; federation (SAML/OIDC) is the underlying trust mechanism |
| Calling two passwords or two questions "MFA" | Require factors from different categories (know/have/are) |
| Letting authorization logic read raw credentials instead of claims | Authorization should only ever consult validated claims/tokens |
| Sharing a user's session token for backend batch jobs | Give machine callers their own client-credentials identity |
| Assuming token-based auth is always "more secure" than sessions | It trades easy revocation for statelessness — pick based on the threat model |

## Summary

Authentication establishes a trusted identity; authorization decides what that identity may do, and it is re-checked on every request while authentication typically happens once per session or token lifetime. Precise vocabulary — identity vs credential vs claim, IdP vs SP, delegated vs machine-to-machine — is what separates a senior answer from a vague one. In a real architecture, centralize authentication at the edge and push authorization decisions down to the service that owns the resource, and always map failures to the correct status code: 401 for "prove who you are", 403 for "I know who you are, and the answer is no".

## Top Interview Questions

### Q1. What is the difference between authentication and authorization?

Authentication verifies *who* is making a request — checking credentials like a password, certificate, or token against a known identity. Authorization decides *what* that verified identity is allowed to do — whether it can read a resource, write to it, or invoke an action. Authentication happens first and typically once per session or token lifetime; authorization is evaluated on every protected request because permissions (roles, resource ownership, tenant membership) can change independently of identity. A useful shorthand: authentication answers "who", authorization answers "what can they do", and you cannot answer the second question without first answering the first.

### Q2. Why does a 401 sometimes get returned for a permissions problem, and is that correct?

It is technically incorrect, and interviewers like to probe this. `401 Unauthorized` should mean "I don't know who you are" — missing, expired, or invalid credentials — and should prompt the client to (re-)authenticate. `403 Forbidden` means "I know exactly who you are, and you are not allowed to do this" — re-authenticating will not change the outcome. Many APIs sloppily return 401 for permission failures (sometimes deliberately, to avoid confirming a resource exists to an unauthorized caller), but the clean design is to return 401 only for authentication failures and 403 for authorization failures, and to document any deliberate exception.

### Q3. What are claims, and how do they differ from credentials?

Credentials are the one-time proof used *during* authentication — a password, a client certificate, a biometric scan. Claims are statements *about* an already-authenticated identity, carried inside the resulting token or session: subject ID, email, roles, tenant, token expiry. After login, the system never looks at the password again; every subsequent authorization decision is made by reading claims from the token or session, not by re-checking the original credential. This distinction matters in system design because it explains why a compromised token is dangerous even without the original password — the claims inside it are enough to impersonate the user until the token expires or is revoked.

### Q4. Compare session-based and token-based authentication. When would you choose each?

Session-based auth stores an opaque session ID in a cookie, with real state (user, roles, expiry) kept server-side in a store like Redis. It supports instant revocation — delete the record — but requires a shared store reachable by every server instance. Token-based auth (e.g. JWT) packs the claims into a self-contained, signed token that any service can validate independently, with no shared store, but revoking a single token before its natural expiry is hard, since validation typically only checks the signature. Choose sessions for a first-party server-rendered web app where you control both client and server and want easy logout/revocation. Choose tokens for APIs consumed by mobile apps, SPAs, and third-party or multi-service backends where a central session lookup on every call would be a bottleneck or a single point of failure.

### Q5. What's the difference between SSO and federation?

SSO is the user-facing outcome: log in once, access many applications without re-entering credentials. Federation is the trust protocol that makes SSO possible *across organizational or domain boundaries* — standards like SAML 2.0 and OpenID Connect define how an identity provider issues a signed assertion or token that a separate service provider can verify and trust without ever seeing the user's password. You can have SSO without federation (a single company's own apps sharing one session cookie under one domain), but cross-company or cross-vendor SSO (e.g. "Sign in with your work Google account" on a third-party SaaS tool) requires federation.

### Q6. What is delegated authorization, and how is it different from a service simply reusing a user's password?

Delegated authorization lets a third-party application act on a user's behalf against another service, with the user's explicit, scoped consent, and without the third party ever seeing the user's password. The user authenticates directly with the resource owner's identity provider, which then issues a limited-scope access token to the third party — for example, a photo-printing app getting read-only access to a user's Google Photos. This is safer than the old anti-pattern of asking users to type their Google password directly into a third-party app: that approach hands over full account control, cannot be scoped, and cannot be revoked without changing the password everywhere it was shared. OAuth 2.0 was designed specifically to eliminate this "password anti-pattern".

### Q7. How would you authenticate a background service that has no user session, such as a nightly batch job calling an internal API?

Use a machine-to-machine flow rather than borrowing a user's credentials or session. The most common pattern is OAuth's `client_credentials` grant: the service authenticates with its own client ID and a secret or certificate, and receives an access token whose claims identify the *service*, not a person. In cloud environments, an even stronger option is a managed/workload identity, which eliminates the stored secret entirely — the cloud platform vouches for the service's identity and issues short-lived tokens automatically. The key design point to state out loud: giving the batch job its own identity keeps audit logs accurate (you can see "OrderSyncService did this", not "Alice did this at 3 a.m."), and decouples the job's lifetime from any human's session.

### Q8. Design where you would place authentication and authorization checks in a microservices architecture, and justify it.

Authenticate at the edge — an API gateway or a shared middleware layer — because the check is identical everywhere: verify the token's signature, issuer, audience, and expiry once, and attach the resulting claims to the request context. Pushing that logic into every service duplicates crypto code and creates inconsistency risk. Authorization, by contrast, should be evaluated as close to the resource as possible, inside the owning service, because only that service knows the business rule — whether this role can cancel this specific order, or whether this tenant owns this record. A central "authorization service" queried by everyone can work for coarse role checks, but fine-grained, resource-specific rules (ownership, state-dependent permissions) belong with the data they protect, otherwise you end up with a bottleneck service that must understand every other service's domain model.

### Q9. A user reports they can still access the app 20 minutes after you disabled their account. What would you check, and how would you fix it going forward?

First check which authentication model is in use. If it's token-based (JWT) with a 30–60 minute expiry and no revocation list, this is expected behavior: the token remains valid until it naturally expires, because signature validation alone does not consult a live user-status check. To fix it: either shorten access-token lifetime and rely on refresh-token revocation (kill the refresh token, and the access token dies out within minutes), maintain a lightweight denylist/kill-switch checked on sensitive operations, or use token versioning where a per-user version number is bumped on disable and compared on each request. If it's session-based, this is a bug — the session store should be checked (or the session record deleted) synchronously when an account is disabled, so the fix is to ensure the disable operation invalidates the server-side session immediately rather than only flipping a flag the login page checks.

### Q10. Why is SMS one-time-passcode considered weaker MFA than an authenticator app or hardware key, even though it's still "something you have"?

The weakness isn't the factor category, it's how easily the *possession* can be transferred without the victim's phone ever being touched. SIM-swapping — social-engineering or bribing a carrier to port a phone number to an attacker's SIM — hands over the "possession" factor entirely, and SMS also traverses the carrier network in a way that's interceptable via SS7 exploits in some regions. A TOTP authenticator app is stronger because the secret never leaves the original device. A FIDO2/WebAuthn hardware key is stronger still because it's also phishing-resistant: the cryptographic challenge-response is bound to the origin (domain) at the browser level, so even a perfect fake login page cannot relay the proof to the real site. The senior framing: not all "something you have" factors carry equal risk, and the strongest MFA binds proof of possession to the actual channel being protected.

### Q11. Explain identity provider vs service provider, and give a real example of both roles held by the same company.

The identity provider (IdP) authenticates the user and issues a signed assertion or token attesting to who they are (and often their group memberships). The service provider (SP), sometimes called the relying party, is the application that trusts that assertion instead of collecting and verifying credentials itself. A concrete example: a company using Azure AD/Entra ID for employee login is the *service provider* relative to Microsoft's IdP for its internal tools, but the same company can also be the *identity provider* if it exposes "Sign in with Acme" to a partner's application, in which case the partner's app is now the service provider trusting Acme's assertions. Recognizing that a single organization can hold both roles simultaneously, for different relationships, is a sign of real hands-on federation experience.

### Q12. Why is authorization re-checked on every request instead of being cached with the authentication result?

Because permissions can change independently of, and faster than, a token or session's lifetime. A user's role can be downgraded, a resource can change owner, a subscription can lapse, or an admin can revoke a specific permission — none of which necessarily invalidates the existing authenticated session or token. If authorization were decided once at login and cached for the session's duration, these changes would not take effect until the user logged out and back in, which is both a security risk (a demoted admin keeps admin access) and a correctness bug (a canceled subscription keeps premium features). Authentication is comparatively stable — identity rarely changes mid-session — so it is reasonable to check it once per token and re-validate only its expiry; authorization must be evaluated fresh against current state on every sensitive action.
