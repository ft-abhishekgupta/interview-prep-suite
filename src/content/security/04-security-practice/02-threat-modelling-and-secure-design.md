---
title: Threat Modelling and Secure Design
description: A structured way to reason about what can go wrong in a design before it is built, using STRIDE, trust boundaries and secure design principles
difficulty: Advanced
tags: [threat-modelling, secure-design, stride, appsec, architecture]
---

Threat modelling is what separates "we bolted security on afterwards" from "security was a design constraint from day one" — and interviewers who ask you to threat model a design on a whiteboard are testing exactly that habit of mind. The goal is not to find every possible attack; it's to systematically ask the right questions before code is written, when a fix is a design change instead of a production incident.

## When to threat model, and who's in the room

Threat modelling pays off most **before** implementation — at design review, when a new trust boundary is introduced (a new external integration, a new data store holding sensitive data), or when an existing system changes its exposure (moving from internal-only to internet-facing). The right room includes the engineers who will build it, someone who understands the data's sensitivity (product or compliance), and ideally someone from security who isn't emotionally attached to the design and will push back.

> [!KEY]
> A threat model is a **conversation with a structure**, not a document produced in isolation. If the engineers who will actually write the code weren't in the room, the exercise rarely changes anything real.

## The four questions framework

Adam Shostack's four-question framework is the simplest structure to reach for, on a whiteboard or in an interview:

| Question | Purpose |
|---|---|
| 1. What are we building? | Draw the data flow diagram — components, data stores, trust boundaries |
| 2. What can go wrong? | Enumerate threats per component/boundary, typically via STRIDE |
| 3. What are we going to do about it? | Assign a mitigation or accept the risk explicitly, per threat |
| 4. Did we do a good job? | Retrospective — were the mitigations actually implemented and tested |

Question 4 is the one teams skip, and it's why threat models become stale documents nobody revisits.

## STRIDE

STRIDE is a mnemonic for threat categories, each mapped to the security property it violates:

| Category | Violates | Example | Typical mitigation |
|---|---|---|---|
| **S**poofing | Authentication | Attacker impersonates a legitimate user or service | Strong auth, mTLS, signed tokens |
| **T**ampering | Integrity | Data modified in transit or at rest without detection | Checksums/HMAC, TLS, write permissions |
| **R**epudiation | Non-repudiation | User denies performing an action, no proof either way | Signed audit logs, immutable logging |
| **I**nformation disclosure | Confidentiality | Data exposed to someone unauthorised to see it | Encryption, access control, least privilege |
| **D**enial of service | Availability | System made unavailable to legitimate users | Rate limiting, autoscaling, circuit breakers |
| **E**levation of privilege | Authorization | User gains capabilities beyond what they should have | Authorization checks on every request, least privilege |

> [!TIP]
> Walk each **element** of the data flow diagram (process, data store, data flow, external entity) against STRIDE — not every category applies to every element (data stores rarely "spoof", for instance), but processes are vulnerable to all six. This grid is exactly what interviewers expect you to reconstruct live.

## Data flow diagrams and trust boundaries

A trust boundary is any point where data crosses between components that don't equally trust each other — a client to a server, a server to a third-party API, one internal service to another with a different privilege level. Threats cluster at boundaries because that's where an attacker gets to inject or intercept something.

```mermaid
flowchart LR
    U["User browser"] -->|"trust boundary"| API["API Gateway"]
    API -->|"trust boundary"| SVC["Order Service"]
    SVC -->|"trust boundary"| DB[("Order Database")]
    SVC -->|"trust boundary"| MQ["Message Queue"]
    MQ --> WRK["Worker Service"]
    WRK -->|"trust boundary"| EXT["Third-party Payment API"]
```

Every arrow crossing a trust boundary in this diagram is a candidate for the full STRIDE walkthrough; arrows *within* a single trusted process are lower priority.

## Attack trees and risk prioritisation

An attack tree starts from a goal ("exfiltrate customer payment data") at the root and branches into the concrete ways an attacker could achieve it (compromise the database credential, exploit an API vulnerability, socially engineer an employee, intercept an unencrypted internal hop) — each leaf can be scored by likelihood and cost-to-attacker, helping you see which path is realistically cheapest for an adversary rather than which sounds scariest.

Once threats are enumerated, prioritise with a simple risk formula: **Risk ≈ Likelihood × Impact**. A common trap is treating every finding as equally urgent; a low-likelihood, low-impact finding (an internal debug endpoint requiring VPN access, leaking non-sensitive version info) should not consume the same remediation urgency as a high-likelihood, high-impact one (an unauthenticated endpoint returning customer PII).

## Secure design principles

| Principle | One-line example |
|---|---|
| Least privilege | A reporting service gets read-only DB access, never write |
| Fail securely | An auth check that errors should deny access, not default to allow |
| Complete mediation | Check authorization on every request, not just the first one in a session |
| Defence in depth | Network isolation *and* authentication *and* encryption, not just one |
| Minimise attack surface | Disable unused endpoints/ports rather than leaving them "just in case" |
| Secure defaults | A new S3 bucket/storage account defaults to private, not public |
| Separation of duties | The engineer who approves a deploy isn't the only one who can also merge it |
| Don't roll your own crypto | Use a vetted library (BCrypt, libsodium) instead of a custom cipher |

> [!DANGER]
> "Don't roll your own crypto" extends further than algorithms — it includes reinventing token formats, session ID generation, or password reset flows using ad-hoc logic instead of vetted, widely-reviewed libraries and standards (JWT libraries, framework-provided anti-forgery tokens). Custom security logic is where subtle, exploitable bugs hide the longest, because it's tested far less than a library used by millions of other applications.

## Security requirements as acceptance criteria

Security shouldn't live only in a separate review step — the strongest teams write it directly into a story's acceptance criteria: "given an unauthenticated request to this endpoint, then it returns 401", "given a request for another user's order ID, then it returns 403, not the data". This makes security testable in the same way functional behaviour is, and it means a missing check fails CI the same way a broken feature would, rather than surfacing only in a manual review that might get skipped under deadline pressure.

## Reviewing a design in an interview setting

When asked to threat model a design live, the strongest structure to follow out loud is: draw the data flow diagram first (don't skip this — it's the artifact everything else hangs off), narrate the trust boundaries as you draw them, then walk STRIDE against the boundaries that carry the most sensitive data or the least trust, naming a concrete mitigation for each threat you raise rather than just listing threats. Interviewers are listening for structure and prioritisation, not an exhaustive list — naming the two or three highest-risk items with a mitigation beats naming twenty items with none.

## Worked mini threat model: API + database + queue

For a public API, an order service, a database, a queue, and a worker calling a third-party payment API:

| Trust boundary | Threat (STRIDE) | Mitigation |
|---|---|---|
| User → API Gateway | Spoofing (stolen token reused) | Short-lived tokens, refresh rotation, TLS |
| API Gateway → Order Service | Elevation of privilege (bypassing gateway authz) | Service also re-validates authz, doesn't trust the gateway blindly |
| Order Service → Database | Information disclosure (broad DB credential) | Least-privilege DB user, row-level security, encryption at rest |
| Order Service → Queue | Tampering (message altered in transit/at rest) | Signed/authenticated messages, TLS to the broker, queue access control |
| Worker → Payment API | Repudiation (no record of what was submitted to a third party) | Log every outbound payment request/response, immutable audit trail |
| Queue → Worker | Denial of service (poison message loop) | Dead-letter queue, retry limits, circuit breaker |

This table is exactly what "did we do a good job" should be checked against later — each mitigation should map to an actual implemented control, not just a good intention captured once in a meeting.

## Cheat sheet

- Threat model **before** implementation, at design review, with the people who will build it.
- Four questions: what are we building, what can go wrong, what do we do about it, did we do a good job.
- STRIDE: Spoofing, Tampering, Repudiation, Information disclosure, Denial of service, Elevation of privilege.
- Threats cluster at **trust boundaries** — draw the data flow diagram first.
- Attack trees show the cheapest realistic path to a goal, not just the scariest-sounding one.
- Prioritise with Risk ≈ Likelihood × Impact, not "every finding is critical".
- Secure design principles: least privilege, fail securely, complete mediation, defence in depth, minimise attack surface, secure defaults, separation of duties, don't roll your own crypto.
- Write security requirements as testable acceptance criteria, not a separate ad-hoc review.
- In an interview, name a mitigation for every threat you raise — don't just list threats.

## Common mistakes

| Mistake | Fix |
|---|---|
| Threat modelling only after the design is built | Do it at design review, before implementation |
| Treating every finding as equally critical | Prioritise with Risk ≈ Likelihood × Impact |
| Listing threats without mitigations in a review | Pair every threat with an assigned mitigation or explicit risk acceptance |
| Producing a threat model document nobody revisits | Ask question 4 — verify mitigations were actually implemented |
| Writing custom token/session/crypto logic | Use vetted libraries and standards instead |
| Skipping the data flow diagram and going straight to threats | Draw boundaries first — threats cluster where trust changes |

## Summary

Threat modelling is a structured, repeatable conversation — not a one-off audit — built around drawing the data flow, enumerating what can go wrong at each trust boundary with STRIDE, assigning a concrete mitigation to each threat, and later verifying those mitigations actually shipped. Secure design principles like least privilege, fail securely, and secure defaults give you a checklist to apply even without a full formal exercise, and attack trees plus a simple likelihood-times-impact score keep prioritisation honest instead of treating every finding as equally urgent. In an interview, the winning move is narrating this structure live — diagram, boundaries, STRIDE, mitigations — rather than trying to recall an exhaustive list of attacks from memory.

## Top Interview Questions

### Q1. What is threat modelling and when in the development lifecycle should it happen?

Threat modelling is a structured process for identifying what could go wrong in a system's design — who might attack it, how, and what the impact would be — so that mitigations can be designed in rather than retrofitted. It pays off most at design time: when a new system is being architected, when an existing system gains a new trust boundary (a new external integration, a new sensitive data store), or when its exposure changes (an internal tool becoming internet-facing). Doing it before implementation means a finding is a design adjustment; doing it only after launch means the same finding is a production vulnerability requiring an incident response and a patch. It should also be revisited periodically, not treated as a one-time exercise, since architectures and threat landscapes both evolve.

### Q2. Explain the four-question framework for threat modelling.

The framework structures the exercise around four questions asked in order. "What are we building?" comes first and produces a data flow diagram showing components, data stores, external entities and — critically — trust boundaries between them. "What can go wrong?" is where you enumerate threats, typically walking each element of the diagram against a framework like STRIDE. "What are we going to do about it?" requires assigning a concrete mitigation to each identified threat, or explicitly documenting that a risk is accepted rather than mitigated (a valid, often correct outcome for low-impact findings). "Did we do a good job?" is the retrospective step, verifying the planned mitigations were actually implemented and are effective — this last question is the one teams most often skip, which is why threat models frequently become stale documents that don't reflect what was actually built.

### Q3. Walk through STRIDE and give a concrete example of each category.

STRIDE covers six threat categories, each violating a specific security property. Spoofing violates authentication — an attacker using a stolen session token to impersonate a legitimate user. Tampering violates integrity — an attacker modifying an order's total in transit before it reaches the payment processor. Repudiation violates non-repudiation — a user who transferred funds later denies having done so, and there's no signed log to prove otherwise. Information disclosure violates confidentiality — an API endpoint returning another customer's order details because of a missing ownership check. Denial of service violates availability — an attacker flooding a login endpoint until legitimate users can't authenticate. Elevation of privilege violates authorization — a regular user manipulating a request parameter to perform an admin-only action. Each category maps to a corresponding mitigation family: strong authentication for spoofing, integrity checks for tampering, signed audit logs for repudiation, encryption and access control for disclosure, rate limiting for denial of service, and authorization checks on every request for elevation of privilege.

### Q4. What is a trust boundary, and why do threat modelling exercises focus so heavily on them?

A trust boundary is any point in a system where data crosses between two components that do not equally trust each other — a public client talking to your API, your service calling a third-party API, or even one internal service calling another with a different privilege level or ownership team. Threats concentrate at these boundaries because that's exactly where an attacker has an opportunity to inject malicious input, intercept data, or impersonate one side of the conversation — a component talking only to itself, with no boundary crossed, has a much smaller attack surface by definition. This is why a data flow diagram, with trust boundaries explicitly drawn, is the very first artifact in threat modelling: it tells you where to spend your STRIDE analysis effort, rather than treating every internal function call with the same scrutiny as an internet-facing endpoint.

### Q5. What's the difference between an attack tree and STRIDE, and when would you use one over the other?

STRIDE is a categorisation framework applied component-by-component or boundary-by-boundary across a whole system, designed to make sure you don't forget a category of threat for any given element — it's breadth-first and systematic. An attack tree instead starts from a single, specific attacker goal (say, "exfiltrate customer payment data") at the root, and branches downward into the concrete, competing ways an attacker could realistically achieve that one goal — compromising a database credential, exploiting an API bug, phishing an employee, intercepting an unencrypted internal connection — each scored by likelihood and cost to the attacker. You'd use STRIDE when you want systematic coverage across an entire new design, and an attack tree when you already have a specific high-value asset or goal in mind and want to reason deeply about the realistic, cheapest path an adversary would actually take to reach it, which is often more useful for red-team style prioritisation.

### Q6. How do you prioritise threats once you've identified a long list of them, and what's a common mistake teams make here?

The standard approach scores each threat on likelihood and impact and prioritises roughly by their product — a highly likely, high-impact threat (an unauthenticated endpoint leaking customer PII) clearly outranks a low-likelihood, low-impact one (an internal debug endpoint, reachable only via VPN, that leaks a non-sensitive version string). The common mistake is treating every item on the threat list as equally urgent, which either overwhelms the team into paralysis or, more often, causes remediation effort to get spent on whatever was raised loudest or listed first rather than what actually matters most. A senior answer explicitly separates "we identified this threat and are mitigating it now", "we identified this threat and are explicitly accepting the risk because likelihood/impact is low", and "we need more information before we can score this" — rather than treating a threat model as a flat, undifferentiated checklist.

### Q7. Explain "fail securely" and "secure defaults" as design principles, with an example of getting each wrong.

Fail securely means that when a check errors or an unexpected condition occurs, the system should default to denying access rather than allowing it — a common real-world bug is an authorization check wrapped in a try/catch that, on an unexpected exception (a database timeout checking permissions, say), falls through to a default `return true` or simply proceeds with the request instead of rejecting it, silently converting a transient error into an authorization bypass. Secure defaults means the out-of-the-box configuration of a system should be the safe one, requiring an explicit, deliberate action to loosen it — a cloud storage bucket that defaults to public read access "for convenience" is the classic failure mode here, since it means every developer who forgets to explicitly lock it down has created a public data exposure, rather than every developer who explicitly needs public access having to opt into it consciously.

### Q8. Why is "don't roll your own crypto" broader advice than it sounds, and what else does it cover beyond encryption algorithms?

The immediate reading is "don't invent your own cipher" — which is correct, since vetted algorithms like AES have survived decades of cryptanalysis by the entire security research community, while a custom cipher has had none of that scrutiny and is very likely to have an exploitable weakness nobody has found yet simply because almost nobody has looked. But the same principle extends to anything security-critical that's easy to get subtly wrong: hand-rolled session ID generation (using a non-cryptographic random number generator, or a predictable seed like a timestamp), custom password reset token schemes, ad-hoc JWT validation logic that skips signature verification in an edge case, or a bespoke API signing scheme instead of a standard like HMAC. In every one of these cases, the failure mode is the same — a subtle logic bug that looks correct in normal testing but is exploitable by anyone who studies it closely, and the fix is the same too: use a vetted, widely-used library or standard instead of custom logic, because those have had far more adversarial scrutiny than anything built in-house.

### Q9. How would you threat model a system where a public API accepts a request, writes to a database, and publishes a message to a queue for a worker to call a third-party payment API?

Start by drawing the data flow diagram and marking every trust boundary: the public client to the API gateway, the API service to its database, the API service to the queue, and the worker to the third-party payment API — four boundaries, each getting a STRIDE pass. At the client boundary, spoofing (stolen/replayed tokens) is the primary concern, mitigated with short-lived tokens and TLS. At the database boundary, information disclosure from an over-privileged database credential is the concern, mitigated with a least-privilege DB user and row-level security. At the queue boundary, tampering (a message altered in transit or by another process with write access to the queue) is the concern, mitigated with message signing and access-controlled queue permissions. At the third-party payment boundary, repudiation is significant — if a customer disputes a charge, you need a signed record of exactly what was submitted and received — mitigated with an immutable audit log of every outbound payment call. I'd also flag denial of service at the queue-to-worker boundary specifically: a malformed message that repeatedly fails and retries indefinitely (a poison message) can exhaust worker capacity, mitigated with a dead-letter queue and bounded retry counts.

### Q10. How do you write security requirements as testable acceptance criteria rather than leaving them to a separate manual review?

Instead of a vague requirement like "the API should be secure", write specific, falsifiable given/when/then statements the same way you would for functional behaviour: "given a request without a valid auth token, when it hits any protected endpoint, then it returns 401", "given an authenticated user requesting another user's order by ID, when the request is made, then it returns 403, not the order data", "given a password shorter than 12 characters, when a user attempts to register, then registration is rejected with a specific validation error". Each of these can be turned directly into an automated test that runs in CI alongside functional tests, which means a regression that reopens the vulnerability fails the build automatically rather than depending on a human reviewer noticing it during a manual security pass that might get skipped under a deadline. This approach also forces the requirement to be concrete during design — if you can't phrase a security expectation as a testable acceptance criterion, that's often a sign the requirement wasn't actually well-defined yet.

### Q11. You're asked in an interview to threat model a simple file-upload feature on a whiteboard. What's your approach, live, in the room?

I'd start by drawing the data flow rather than jumping straight to listing attacks: a user's browser, an API endpoint accepting the upload, a storage service persisting the file, and possibly a downstream process that later reads the file (a virus scanner, a thumbnail generator, a search indexer) — marking the trust boundary between the untrusted client and everything past the API. Then I'd walk STRIDE against that boundary and the storage step specifically: spoofing (is the uploader actually authenticated as who they claim), tampering (could the file's declared content-type be spoofed to disguise an executable as an image), information disclosure (are uploaded files stored with predictable, guessable URLs that let one user access another's files), denial of service (is there a file-size limit, and rate limiting on the endpoint, to prevent storage exhaustion), and elevation of privilege (does the downstream file-processing step run with more privilege than it needs, and could a maliciously crafted file exploit a parser vulnerability in that processor). For each, I'd name a concrete mitigation — content-type validation independent of the client-supplied header, non-guessable storage keys with per-object access control, size limits and rate limiting, and running any file-processing step in a sandboxed, least-privilege context — rather than stopping at just naming the risks.

### Q12. How does defence in depth relate to threat modelling — shouldn't a good threat model just find "the" fix for each threat?

Threat modelling identifies threats and pairs each with a mitigation, but a mature model recognises that any single mitigation can itself fail or be bypassed, which is exactly why defence in depth matters as a design principle alongside it. For example, the mitigation for "elevation of privilege via a bypassed authorization check" might be "the API gateway enforces authorization" — but a defence-in-depth minded threat model doesn't stop there; it asks "what if the gateway's check is misconfigured or bypassed", and adds a second, independent authorization check inside the service itself, so a single failure at one layer doesn't equal a full compromise. In practice this means a good threat model output isn't a single mitigation per threat but often a short stack of independent, overlapping controls for the threats judged highest-risk — reflecting the reality that any one control, however well-designed, can and eventually will fail in some form.
