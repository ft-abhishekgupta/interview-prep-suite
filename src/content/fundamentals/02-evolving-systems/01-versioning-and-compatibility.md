---
title: Versioning and Compatibility
description: Semantic versioning rules, what actually counts as a breaking change across APIs and databases, deprecation timelines, and how to support multiple versions safely
difficulty: Core
tags: [versioning, api-design, compatibility, semver]
---

Versioning questions test whether you can distinguish a change that's safe to ship silently from one that requires a major version bump, a deprecation notice, and months of lead time. Getting this wrong in production means broken integrations and angry consumers; getting it right in an interview signals real operational experience.

## Semantic versioning

Semantic versioning (semver) encodes intent in a version number: `MAJOR.MINOR.PATCH`.

| Segment | Bumped when | Consumer expectation |
|---|---|---|
| MAJOR | A breaking change | May require consumer code changes to upgrade |
| MINOR | A backward-compatible addition | Safe to upgrade, new features available |
| PATCH | A backward-compatible bug fix | Always safe to upgrade |

The entire value of semver is that a consumer can pin `^2.3.0` and trust that any `2.x.y` release won't break them — which only works if the maintainer is disciplined about what counts as breaking. Pre-1.0.0 (`0.y.z`) is explicitly exempt from these guarantees under the semver spec — anything can break at any point, which is why libraries should reach 1.0.0 quickly once there's a real consumer depending on stability.

> [!KEY]
> Semver is a **promise to consumers**, not a description of effort. A one-line change that removes a field from a response is a major bump even if the code diff is tiny — the size of the change to the *contract* is what matters, not the size of the diff.

## What actually counts as breaking

This is the question that separates people who've memorised the rule from people who've been burned by getting it wrong.

| Change | APIs | Libraries | Events | Databases |
|---|---|---|---|---|
| Add optional field/parameter | ✅ Safe | ✅ Safe | ✅ Safe (consumer ignores unknown) | ✅ Safe (nullable/default column) |
| Add required field/parameter | ❌ Breaking | ❌ Breaking | ❌ Breaking for strict schemas | ❌ Breaking (existing rows fail NOT NULL) |
| Remove any field/parameter | ❌ Breaking | ❌ Breaking | ❌ Breaking | ❌ Breaking |
| Rename a field | ❌ Breaking | ❌ Breaking | ❌ Breaking | ❌ Breaking |
| Change a field's type | ❌ Breaking | ❌ Breaking | ❌ Breaking | ❌ Breaking (usually) |
| Change validation to be stricter | ❌ Breaking | ❌ Breaking | ❌ Breaking | ❌ Breaking |
| Change validation to be looser | ✅ Safe | ✅ Safe | ✅ Safe | ✅ Safe |
| Add a new endpoint/method/event type | ✅ Safe | ✅ Safe | ✅ Safe | ✅ Safe (new table) |
| Change error message text | ✅ Usually safe | ⚠️ Breaking if consumers match on message | ✅ Safe | N/A |
| Reorder fields in a response/payload | ✅ Safe if consumers use field names | ❌ Breaking if positional (tuples) | ⚠️ Depends on serialisation | N/A |

> [!WARNING]
> "Adding a required field" feels additive but isn't — every existing caller that doesn't send it now fails. The safe version is: add it optional/nullable first, backfill or default it, and only make it required in a later major version once every caller has migrated.

## Backward vs forward compatibility

**Backward compatible**: new code can read data/messages produced by old code. **Forward compatible**: old code can read data/messages produced by new code (typically by ignoring fields it doesn't understand). You want both simultaneously during any rolling deploy, because old and new instances run side by side for the duration of the rollout.

The **Robustness Principle** ("be conservative in what you send, be liberal in what you accept") is the design philosophy behind forward compatibility: a **tolerant reader** ignores unknown fields instead of rejecting the whole payload, and doesn't assume a field's absence means an error — it might just mean an older sender. A consumer that deserialises JSON with `JsonSerializerOptions { UnmappedMemberHandling = Skip }` rather than strict schema validation is a tolerant reader; one that throws on any unrecognised field is not, and it will break the moment the producer adds a harmless new field.

```mermaid
flowchart LR
    OldP["Old producer"] --> Msg1["Message v1"]
    NewP["New producer"] --> Msg2["Message v2<br/>+ new optional field"]
    Msg1 --> OldC["Old consumer"]
    Msg1 --> NewC["New consumer<br/>(backward compatible)"]
    Msg2 --> NewC
    Msg2 --> OldC2["Old consumer<br/>(forward compatible:<br/>ignores new field)"]
```

## Deprecation policy

A deprecation without a timeline is just a suggestion nobody follows. A real policy has: an announcement (changelog, response header, email to registered consumers), a **sunset date** far enough out to be realistic (commonly 6–12 months for public APIs, shorter for internal ones), telemetry to find who's still calling the deprecated path, and a hard cutoff.

| Phase | Action |
|---|---|
| Announce | Mark deprecated in docs; add a `Deprecation`/`Sunset` HTTP header; log a warning server-side |
| Measure | Track call volume and caller identity (API key, user agent) on the deprecated path |
| Notify | Directly contact remaining callers identified by telemetry, not just a changelog entry |
| Enforce | Return errors on the old path only after telemetry shows near-zero traffic, or the sunset date passes |
| Remove | Delete the code path once traffic has been at zero for a safety window |

> [!TIP]
> "How would you know it's safe to remove a deprecated field?" — the senior answer is never "the docs said it was deprecated for 6 months", it's "telemetry showed zero calls using it for N consecutive days, cross-checked against low-traffic clients like batch jobs that only call monthly."

## Supporting multiple versions and version negotiation

Supporting `v1` and `v2` of an API simultaneously has a real, ongoing cost: every schema change has to be applied to both code paths (or a shared core with per-version adapters), tests double, and bugs can exist in one version but not the other. Version negotiation is how a client and server agree which version to speak — via a URL segment (`/v2/orders`), a header (`Accept: application/vnd.api+json;version=2`), or a query parameter. URL versioning is the most common because it's cacheable and debuggable at a glance; header versioning is more "correct" REST but harder to explore in a browser.

```csharp
[ApiController]
[Route("v{version:apiVersion}/orders")]
[ApiVersion("1.0")]
[ApiVersion("2.0")]
public class OrdersController : ControllerBase {
    [HttpGet("{id}"), MapToApiVersion("2.0")]
    public OrderDtoV2 GetV2(int id) => _service.GetV2(id);

    [HttpGet("{id}"), MapToApiVersion("1.0")]
    public OrderDtoV1 GetV1(int id) => _service.GetV1(id);
}
```

## Library versioning and diamond dependencies

Library versioning has a failure mode APIs don't: the **diamond dependency conflict**. If your app depends on `LibA` (needs `Json 1.x`) and `LibB` (needs `Json 2.x`), and the runtime can only load one version of `Json`, the build fails or one library silently gets a version it wasn't tested against. This is why libraries should bump major versions conservatively and keep breaking changes rare — every major bump ripples through the entire dependency graph of everyone depending on you, not just your direct consumers.

| Strategy | How it avoids the diamond problem |
|---|---|
| Semantic versioning + narrow ranges | Consumers can express "any 2.x" and tooling resolves a mutually compatible version |
| Assembly/package side-by-side loading | .NET and some ecosystems can load multiple major versions in isolation |
| Minimising a library's own dependencies | Fewer transitive constraints to conflict with |
| Deprecating slowly | Gives the whole ecosystem time to move together |

## Calendar versioning and changelogs

**CalVer** (e.g. `2024.10.1`) is an alternative to semver used when the version number should communicate *when* something shipped rather than *compatibility* — Ubuntu, some SaaS platforms and tools with frequent, low-risk releases use it. It doesn't encode breaking-change information the way semver does, so it works best when breaking changes are rare or communicated separately. Either scheme needs a **changelog** — a human-readable record grouped by version and change type (added/changed/deprecated/removed/fixed) — because a version number alone tells a consumer *that* something changed, not *what* to check before upgrading.

## Cheat sheet

- Semver: MAJOR = breaking, MINOR = additive, PATCH = fix. Pre-1.0.0 has no stability guarantee.
- The size of the contract change matters, not the size of the code diff.
- Adding a *required* field is always breaking; adding an *optional* one is always safe.
- Backward compatible = new code reads old data. Forward compatible = old code reads new data (usually by ignoring unknown fields).
- Be a tolerant reader: ignore unknown fields, don't fail hard on missing optional ones.
- A deprecation policy needs a sunset date and telemetry — not just a doc footnote.
- Supporting N versions costs roughly N× the testing and maintenance surface.
- URL versioning is simplest and most debuggable; header versioning is more "correct" REST.
- Diamond dependency conflicts are why libraries should bump major versions rarely.
- CalVer communicates *when*, semver communicates *compatibility* — pick based on what consumers need to know.

## Common mistakes

| Mistake | Fix |
|---|---|
| Adding a required field and calling it a minor/patch release | Add it optional first; require it only in the next major |
| Assuming reordering JSON fields is always safe | Safe for name-based consumers, breaking for positional/tuple consumers |
| Deprecating with only a changelog entry | Add telemetry and directly notify remaining callers before removal |
| Treating stricter validation as non-breaking | Any input that used to succeed and now fails is a breaking change |
| Writing a consumer that throws on unknown fields | Build a tolerant reader that ignores what it doesn't recognise |
| Bumping a library's major version for a trivial breaking change | Weigh the ecosystem-wide ripple cost, batch breaking changes when possible |
| Removing a deprecated path on the sunset date regardless of telemetry | Confirm near-zero traffic first; slip the date if long-tail callers remain |

## Summary

Versioning is a communication contract: semver's major/minor/patch tells consumers exactly what kind of change to expect, but only if "breaking" is judged by the contract's shape, not the size of the diff. Backward and forward compatibility both matter during any rollout because old and new code run side by side, and the Robustness Principle's tolerant reader is what makes forward compatibility achievable in practice. Deprecation is a process with telemetry and a sunset date, not an announcement — and knowing the real cost of supporting multiple versions (testing surface, diamond dependencies) is what separates a textbook answer from an operational one.

## Top Interview Questions

### Q1. Explain semantic versioning and what each segment promises to a consumer.

Semantic versioning is `MAJOR.MINOR.PATCH`. A PATCH bump is a backward-compatible bug fix — always safe to take. A MINOR bump adds backward-compatible functionality, like a new optional field or endpoint — safe to take, may expose new features. A MAJOR bump contains at least one breaking change — consumers may need code changes before upgrading. The whole point is that a consumer can pin a dependency range like `^2.3.0` (any 2.x.y) and trust the maintainer not to break them without a major bump. Versions before `1.0.0` are explicitly exempt from these guarantees under the spec, which is why libraries should reach 1.0.0 as soon as there's a real consumer depending on stability, not stay at `0.x` indefinitely.

### Q2. Is adding a new required field to an API response a breaking change? Why or why not?

Adding a new field to a *response* is generally safe for name-based consumers, since they simply ignore fields they don't look for — that's additive, a MINOR bump. But adding a new *required* field to a *request* (something the client must now send) is breaking: every existing caller that doesn't send it will start failing validation. The safe rollout pattern is to add the field as optional first, default or infer it server-side for callers who omit it, monitor adoption, and only make it required in a later major version once telemetry shows all real callers are sending it. The distinction to state out loud is request vs response, and required vs optional — those two axes determine whether a field addition is safe.

### Q3. What's the difference between backward compatibility and forward compatibility?

Backward compatible means new code can correctly read or process data produced by old code — this is the more commonly discussed direction, and is what "non-breaking change" usually refers to. Forward compatible means old code can still function when given data produced by newer code, typically by ignoring fields or message types it doesn't recognise rather than crashing. Both matter simultaneously during a rolling deploy or in a system with independently-deployed producers and consumers, because for some period both old and new versions run side by side. A consumer built to be forward compatible — a "tolerant reader" that skips unknown fields instead of validating strictly against a fixed schema — is what makes a producer's future, harmless additions safe without requiring every consumer to redeploy first.

### Q4. What is the Robustness Principle and how does it apply to API design?

The Robustness Principle, often stated as "be conservative in what you send, be liberal in what you accept," says a system should produce strictly well-formed output but tolerate variation and unexpected-but-harmless input from others. In API design this means: your server should send predictable, well-documented responses, but your client-side deserialisation should ignore unrecognised fields rather than throwing, and shouldn't assume every optional field will always be present. This is what actually enables the "add an optional field is safe" rule — it's only safe because well-built consumers are tolerant readers. Applied too loosely it becomes a footgun: being liberal about accepting malformed or unvalidated input from untrusted sources is a security anti-pattern, so the tolerance is specifically about *unrecognised but well-formed* additions, not about relaxing validation of untrusted data.

### Q5. How would you design and execute a deprecation of a public API field?

I'd start by marking it deprecated in documentation and, if the protocol supports it, in the response itself (a `Deprecation` HTTP header or a `deprecated: true` flag), while it continues to function normally. In parallel, I'd add telemetry specifically on calls that use the deprecated field or path, tagged by caller identity, so I have real data instead of guessing who's still using it. I'd set and publish a sunset date — long enough for realistic migration, commonly 6–12 months for external consumers — and directly contact the highest-volume remaining callers identified by telemetry rather than relying solely on a changelog entry. Only once telemetry shows sustained near-zero traffic (accounting for infrequent callers like monthly batch jobs) would I actually remove the field, ideally behind a short window of returning a clear error before full removal.

### Q6. What is a diamond dependency conflict, and how does semantic versioning help avoid it?

A diamond dependency conflict occurs when your application depends on two libraries that each depend on different, incompatible major versions of a shared third library — if the runtime can only load one version, either the build fails to resolve a compatible version, or one of the libraries silently runs against a version of its dependency it was never tested against. Disciplined semantic versioning helps because a well-maintained library expresses its own dependency needs as a range (e.g. "compatible with Json 2.x"), so package managers can often find a version that satisfies both constraints, and it discourages libraries from bumping majors casually, since each major bump ripples through everyone downstream. Some ecosystems mitigate this further with side-by-side loading of multiple major versions, but the first line of defence is still maintainers being conservative about what actually requires a breaking change.

### Q7. Your team wants to support both v1 and v2 of an API simultaneously during a migration. What's the real cost, and how would you structure the code?

The real cost is roughly proportional to the number of versions: every business logic change potentially needs applying to both versions' code paths (or a shared core with thin per-version adapters), every version needs its own test suite run, and bugs can exist in one version's mapping layer without the other, meaning double the surface area for something to go wrong quietly. I'd structure it as one shared internal service/domain layer with thin, version-specific controllers or adapters that map to v1 and v2 DTOs — so the bulk of the logic isn't duplicated, only the shape of the request/response contract is. I'd also set an explicit end date for v1 support up front (tied to a deprecation and telemetry plan) rather than letting "temporary" dual support become permanent, since the maintenance cost doesn't go away on its own.

### Q8. What's the difference between URL-based and header-based API versioning, and which would you choose?

URL versioning puts the version in the path (`/v2/orders`) — it's simple, cacheable at the CDN/proxy level since the URL itself changes, and easy to explore or debug in a browser or curl command, but purists argue it means the same logical resource has multiple URLs. Header versioning (e.g. an `Accept` header with a version parameter, or a custom `X-API-Version` header) keeps one canonical URL per resource, which is arguably more RESTfully correct, but is harder to test casually, less cache-friendly by default, and easy for consumers to forget to set, silently hitting a default version. In practice I'd choose URL versioning for public APIs where discoverability and simplicity for external consumers matters more than REST purity, and reserve header-based negotiation for internal service-to-service APIs where clients are controlled and consistently configured.

### Q9. Why does changing validation to be stricter count as a breaking change, even though you didn't change the shape of the data?

A breaking change is defined by what happens to existing valid callers, not by whether the schema shape changed. If a field previously accepted any string and you add a regex constraint, any caller whose values don't match the new pattern — even if their calls have worked correctly for years — will start failing where they previously succeeded. That's the definition of breaking: behaviour that used to succeed now fails. The safe direction is the opposite: loosening validation (accepting a wider range of previously-rejected input) is backward compatible, because anything that worked before still works. This is a common trap because tightening validation often feels like a bug fix or a quality improvement internally, but from the consumer's perspective it's indistinguishable from any other breaking contract change.

### Q10. How would you decide between semantic versioning and calendar versioning (CalVer) for a project?

Semantic versioning is the right choice when the version number needs to communicate compatibility — consumers reading `2.4.1` should be able to infer whether it's safe to upgrade without reading the changelog first, which matters most for libraries and APIs with many independent consumers making their own upgrade decisions. Calendar versioning (e.g. `2024.10.1`) is a better fit when the version primarily needs to communicate *when* a release shipped — common for platforms, operating systems, or SaaS tools with frequent releases and few or no breaking-change concerns, since users of a hosted service usually don't choose which version to run. The trade-off to name: CalVer doesn't encode compatibility information at all, so a project using it needs a strong separate deprecation and changelog process to communicate breaking changes, since the version number itself won't warn anyone.

### Q11. How would you safely remove a feature or endpoint that some consumers might still be using, in a production system you don't have full visibility into?

I would never remove it based on assumption alone — I'd first add logging or metrics specifically on that code path to measure real call volume and, if possible, identify the calling service or client. I'd run that telemetry for long enough to catch infrequent callers (weekly or monthly batch jobs, not just daily traffic), then set and communicate a sunset date once the data shows minimal usage. Where possible, I'd return a clear deprecation warning (a response header, or a non-fatal warning field) for a period before full removal, so any caller I missed in telemetry gets an early, non-breaking signal rather than a sudden failure. Only after that grace period, with telemetry confirming zero or near-zero traffic, would I actually delete the code path — and I'd keep the ability to quickly revert for at least one release cycle after removal.

### Q12. What's the difference between a breaking change in an event schema versus in a synchronous API, and why might the impact be worse for events?

In a synchronous API, a breaking change is discovered quickly — the caller gets an error on their next request and can react in near real time. In an event-driven system, producers and consumers are decoupled and consumers may process events asynchronously, sometimes hours or days later, or replay a historical event log — so a breaking change to an event schema can silently corrupt or fail processing for messages that were already published and are sitting in a queue, or for consumers that haven't run yet. This is why event schemas usually need explicit compatibility modes (backward, forward, or full, as enforced by a schema registry) and why removing or renaming an event field is treated even more conservatively than an API field — you often can't know every consumer of a topic the way you can enumerate callers of a REST endpoint, and old messages already on the wire can't be un-published.
