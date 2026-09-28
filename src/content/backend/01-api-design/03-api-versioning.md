---
title: API Versioning
description: Why and when to version an API, the main versioning strategies compared, deprecation policy and how to migrate clients safely
difficulty: Core
tags: [api-design, versioning, rest, backwards-compatibility]
---

An API is a contract, and once external clients depend on it you cannot change that contract for free — someone's mobile app, integration, or batch job will break. Versioning is how you evolve a contract without breaking everyone who already trusts it, and interviewers use this topic to see whether you think about API design as a long-lived product, not a one-off endpoint.

## Why version at all

If you owned every client, you could change the API and redeploy every caller simultaneously — no versioning needed. Real systems rarely have that luxury: mobile apps lag behind server deployments by weeks (app store review, staged rollout), partner integrations are maintained by other companies on their own schedule, and internal services are deployed independently. Versioning lets the server change while giving old clients a stable, working contract until they choose to migrate.

> [!KEY]
> The real goal isn't "have version numbers," it's "never break a client who didn't ask to be broken." Versioning is one tool for that; additive, backwards-compatible design is the other, and it should be your default.

## Breaking vs non-breaking changes

| Change | Breaking? | Why |
|---|---|---|
| Adding a new optional field to a response | No | Clients ignore fields they don't know about |
| Adding a new optional query parameter | No | Old requests still work unchanged |
| Adding a new endpoint | No | Doesn't affect existing callers |
| Removing a field | Yes | Clients reading it will fail or silently misbehave |
| Renaming a field | Yes | Old field name disappears |
| Changing a field's type (string → int) | Yes | Deserialization breaks |
| Making an optional field required | Yes | Old requests without it now fail validation |
| Changing the meaning of an existing field | Yes | Silent, the worst kind — no error, wrong behaviour |
| Changing the URL structure | Yes | Old clients 404 |
| Adding a new required header | Yes | Old requests are rejected |
| Tightening validation on an existing field | Usually | Previously-valid requests may now fail |

> [!WARNING]
> Changing the *meaning* of a field without changing its name or type is the most dangerous class of breaking change, because it doesn't throw an error — it just silently produces wrong results, and you won't find out until a client complains about bad data.

## Versioning strategies

| Strategy | Example | Pros | Cons |
|---|---|---|---|
| URI path | `/v1/orders`, `/v2/orders` | Explicit, visible in logs, trivial to route | Version leaks into every URL and client bookmark forever; encourages whole-resource duplication |
| Query parameter | `/orders?version=2` | Easy to test in a browser, easy to default | Weak signal — easy to omit by accident, cache keys get messy |
| Custom header | `X-Api-Version: 2` | Keeps URLs clean | Invisible in browser address bar and casual curl calls; easy to forget |
| `Accept` header media type | `Accept: application/vnd.myapi.v2+json` | "Correct" per REST content negotiation; resource identity (the URL) doesn't change | Least discoverable, hardest for consumers to test manually, more ceremony |
| No versioning, additive-only | N/A — one contract, always backwards-compatible | No version proliferation, no client migration ever needed | Requires strict discipline; can't ever make a genuinely breaking change without an escape hatch |

> [!TIP]
> The honest, senior answer is that most real APIs use **URI path versioning at the major-version level** (`/v1`, `/v2`) combined with **additive-only changes within a version**. That's not the "purest" REST answer, but it is by far the most operationally practical one — it's visible, cacheable, and trivial for consumers to route and test.

```mermaid
flowchart TD
    A["Incoming request"] --> B{"Path has /v1 or /v2?"}
    B -->|"/v1"| C["V1 controller"]
    B -->|"/v2"| D["V2 controller"]
    C --> E["Shared domain/service layer"]
    D --> E
    E --> F[("Database")]
```

## Semantic versioning for APIs

Borrowing semver (`MAJOR.MINOR.PATCH`) for APIs, but only the major version is usually exposed to clients:

| Bump | Meaning | Client impact |
|---|---|---|
| Major | Breaking change | Clients must explicitly opt in / migrate |
| Minor | Backwards-compatible addition | Existing clients unaffected, new capability available |
| Patch | Bug fix, no contract change | Transparent to all clients |

In practice you expose `/v1` and `/v2` (major only) and treat every change inside a major version as additive by policy — this is why `/v1` can live for years while gaining fields and endpoints without ever becoming `/v1.1` or `/v1.2` in the URL.

## Deprecation policy and sunset headers

Never remove a version abruptly. Announce, give a runway, and signal it programmatically:

```http
HTTP/1.1 200 OK
Deprecation: true
Sunset: Sat, 31 Dec 2026 23:59:59 GMT
Link: <https://api.example.com/docs/migrating-to-v2>; rel="deprecation"
```

- `Deprecation` tells the client this version/endpoint is on its way out.
- `Sunset` (RFC 8594) gives the exact date it will stop working.
- `Link` with `rel="deprecation"` points to a migration guide.

A typical policy: announce deprecation with at least 6–12 months' notice for public APIs, monitor which clients are still calling the old version (log the version + client ID), and reach out directly to the heaviest remaining callers before the sunset date.

## Supporting multiple versions in ASP.NET Core

```csharp
// Program.cs
builder.Services.AddApiVersioning(options =>
{
    options.DefaultApiVersion = new ApiVersion(1, 0);
    options.AssumeDefaultVersionWhenUnspecified = true;
    options.ReportApiVersions = true; // adds api-supported-versions header
    options.ApiVersionReader = new UrlSegmentApiVersionReader();
});

[ApiController]
[Route("v{version:apiVersion}/orders")]
[ApiVersion("1.0")]
public class OrdersV1Controller : ControllerBase
{
    [HttpGet("{id}")]
    public IActionResult Get(int id) => Ok(_service.GetLegacyShape(id));
}

[ApiController]
[Route("v{version:apiVersion}/orders")]
[ApiVersion("2.0")]
public class OrdersV2Controller : ControllerBase
{
    [HttpGet("{id}")]
    public IActionResult Get(int id) => Ok(_service.GetV2Shape(id));
}
```

Both controllers typically delegate to the same underlying domain/service layer, translating the shared model into each version's specific response shape — you rarely want to duplicate business logic per version, only the presentation/mapping layer.

## Migrating clients

1. **Ship v2 alongside v1** — never a hard cutover.
2. **Announce** with the `Deprecation`, `Sunset`, and `Link` headers, docs, and (for high-value partners) direct outreach.
3. **Instrument** — log which version and, if possible, which client/API key is calling each version so you know who's left before you turn v1 off.
4. **Provide a compatibility/migration guide** — a diff of exactly what changed, ideally with a small script or SDK that handles translation.
5. **Sunset gradually** — return warnings for a period, then start returning `410 Gone` after the sunset date rather than silently changing behaviour.

> [!DANGER]
> Silently changing v1's behaviour to match v2 "because it's basically the same" is worse than a hard break — clients relying on the old, documented behaviour get quietly wrong results with no error to alert them. If it's not byte-for-byte backwards compatible, it belongs in a new version, full stop.

## Cheat sheet

- Default to **additive, backwards-compatible changes** within a version; version only for genuine breaks.
- URI path versioning (`/v1`, `/v2`) is the most practical default — visible, cacheable, easy to route and test.
- Removing a field, renaming a field, changing a type, or changing a field's *meaning* are all breaking changes — the last is the most dangerous because it's silent.
- Expose only the major version to clients; treat minor/patch as internal, always non-breaking.
- Always run old and new versions in parallel — never a hard cutover.
- Signal deprecation with `Deprecation`, `Sunset`, and a `Link` to a migration guide.
- Instrument version usage so you know which clients still need the old version before you remove it.
- Share the domain/service layer across version-specific controllers; only the presentation mapping should differ.

## Common mistakes

| Mistake | Fix |
|---|---|
| Bumping the major version for every small addition | Only major-version for breaking changes; additive changes need no new version |
| Changing a field's meaning without renaming it | Treat as breaking; rename or introduce a new version |
| Removing an old version without checking who still calls it | Instrument version usage, notify heavy callers directly before sunset |
| Duplicating full business logic per version controller | Share a domain layer; version only the request/response mapping |
| No deprecation signal, API just starts returning errors one day | Use `Deprecation`/`Sunset` headers and a real notice period |
| Using query-param versioning for a public, cacheable API | Prefer URI path so caches and gateways can key on it cleanly |

## Summary

Versioning exists to protect clients you don't control from changes you need to make — the discipline that matters most is treating every change as additive by default and reserving a new version for genuine breaks (removed fields, changed types, changed meaning). URI path versioning at the major-version level is the pragmatic industry default: visible, cacheable, and easy to route, even though header/media-type versioning is "purer" REST. Whatever strategy you pick, never hard-cut a version — run old and new in parallel, signal deprecation with `Sunset` headers and real lead time, and instrument usage so you know it's safe to retire.

## Top Interview Questions

### Q1. Why do APIs need versioning at all if you control both the client and server?

If you can deploy client and server together atomically, you don't strictly need versioning — but that's rarely true in practice. Mobile apps sit in app-store review queues and roll out gradually over days or weeks, partner integrations are maintained by other companies on their own release schedule, and even internal microservices are often deployed independently by different teams. Versioning (or strict backwards compatibility) is what lets the server evolve without requiring every one of those callers to update in lockstep, avoiding a fragile "everyone deploys at the same instant" dependency.

### Q2. What makes a change to an API breaking versus non-breaking?

A change is non-breaking if every existing, correctly-written client continues to work exactly as before without modification — adding an optional field to a response, adding a new endpoint, or adding an optional query parameter are all safe because old clients simply ignore what they don't recognize. A change is breaking if it removes something clients depend on, changes its shape, or changes its meaning — removing or renaming a field, changing a type, making an optional field required, or changing what an existing field represents without changing its name. The last case (silent meaning change) is the worst because it produces no error at all, just wrong data.

### Q3. Compare URI path versioning, header versioning, and media-type versioning. Which would you pick and why?

URI path versioning (`/v1/orders`) is the most visible and operationally simplest — it's trivial to route, appears in every log line, and works with any HTTP client including a browser address bar, at the cost of "leaking" the version into every URL forever. Header versioning (`X-Api-Version: 2`) keeps URLs clean but is invisible unless you inspect headers, making manual testing and debugging harder. Media-type versioning (`Accept: application/vnd.company.v2+json`) is the most theoretically correct per REST's content-negotiation model, since the resource identity doesn't change, only its representation — but it's the least discoverable and most awkward for typical consumers. In practice I'd default to URI path versioning for its operational simplicity and combine it with an additive-only policy within each version, reserving new major versions for genuine breaking changes.

### Q4. How should semantic versioning concepts map onto an API, given that MAJOR.MINOR.PATCH doesn't translate directly?

Only the major version is usually meaningful to expose to API clients — a major bump signals a breaking change requiring explicit client migration. Minor and patch bumps (backwards-compatible additions, and bug fixes with no contract change) happen "invisibly" from the client's point of view and don't need their own version number in the URL, since by policy nothing in them should require a client change. This is why `/v1` of a well-run API can live for years, gaining new optional fields and endpoints the whole time, without ever becoming `/v1.1` in the path — the minor/patch axis is tracked internally (changelog, release notes) rather than in the routable contract.

### Q5. What headers would you use to communicate that an API version is being retired, and what should they contain?

`Deprecation: true` (or a date value in some conventions) signals the version/endpoint is on its way out. `Sunset` (RFC 8594) carries the exact date and time it will stop working, giving clients a concrete deadline to plan against. A `Link` header with `rel="deprecation"` pointing at a migration guide gives automated tooling and developers a direct path to the documentation they need. Together these let well-behaved client tooling detect and alert on deprecation programmatically, rather than relying on clients reading a changelog they may never see.

### Q6. How would you decide how long to keep an old API version running before removing it?

Base it on evidence, not a fixed calendar guess: instrument every request with its version and, ideally, a client/API-key identifier, so you can see real traffic on the old version over time. Set an initial deprecation notice with a generous runway (commonly 6–12 months for public APIs, shorter for internal services with faster release cycles), then track the trend — if traffic on the old version isn't dropping, reach out directly to the remaining heavy callers before the sunset date rather than surprising them. Only after traffic is near zero (or every remaining caller has explicitly acknowledged the cutover) should you actually remove the old version or start returning `410 Gone`.

### Q7. How do you avoid duplicating business logic across two API version controllers?

Keep versioning at the edge: version-specific controllers or handlers should only be responsible for translating between the version's wire format and a single shared internal domain/service model — they call the same underlying service layer, repository, and business rules. In ASP.NET Core this typically looks like two thin controllers (`OrdersV1Controller`, `OrdersV2Controller`) that both call `IOrderService`, each mapping its own request DTO in and response DTO out. This keeps the actual business logic in one place, so a bug fix or rule change is made once and automatically applies to every exposed version.

### Q8. A partner's integration breaks after your "non-breaking" change that added a new required header for auth. What went wrong, and how should this have been rolled out?

Adding a new *required* header is a breaking change by definition — old requests that don't send it will now fail, even though nothing about the URL or body changed, so classifying it as "non-breaking" was the mistake. It should have gone through the same process as any breaking change: introduce it as optional first with a deprecation notice that it will become required at a future date, monitor which callers are still omitting it, and only enforce it as mandatory after that runway has passed (or scope it to a new API version if the header is significant enough to be a real contract change). The fix now is to make the header optional again immediately, restore the partner's access, and redo the rollout with a proper notice period.

### Q9. You need to change a field's data type from a numeric ID to a string UUID. How would you roll this out without breaking existing clients?

Since changing a field's type is a breaking change, don't mutate the existing field in place. Add a new field alongside the old one (e.g., `id` stays numeric, add `uuid` as a new string field) so existing clients are unaffected, and start encouraging new integrations to adopt `uuid`. Once usage data shows the numeric `id` field is no longer relied on (or after the deprecation runway for a major version bump), you can remove it in a new major version (`/v2`) with its own migration guide, rather than mutating the shared field type underneath existing callers.

### Q10. What's the risk of "no versioning, additive-only" as a strategy, and when is it appropriate?

The risk is that it requires strict, ongoing discipline — every engineer touching the API must correctly recognize what counts as breaking, and there's no escape hatch for a genuinely necessary breaking change (fixing a fundamentally wrong field, restructuring a broken resource model) without introducing some kind of version anyway. It works well for APIs with a small, well-known set of internal consumers where you can coordinate a breaking change directly with every caller, or for APIs still early in their life with no external dependents yet. For a public API with unknown, unmanaged consumers, you eventually need a real versioning escape hatch for the rare unavoidable break.

### Q11. How would you detect, before shipping, that a proposed API change is actually breaking?

Automate it: keep the previous version's OpenAPI/schema contract in source control and run a contract-diff tool in CI that compares the new schema against it, flagging removed fields, changed types, newly-required fields, or removed endpoints as build failures. Complement this with consumer-driven contract tests (e.g., Pact) if you have known downstream consumers, so their actual expectations — not just the schema shape — are verified against every change. Relying on manual review alone is how "small" breaking changes slip through, especially the silent meaning-change kind that no schema diff can catch on its own.

### Q12. Should PATCH-style, additive changes ever require a version bump? Give an example where they might.

Not usually — additive changes are the entire point of avoiding unnecessary version bumps. But an addition can still be effectively breaking if it changes default behaviour clients implicitly relied on: for example, adding a new field to a list response that, once present, causes the server to also change the *default sort order* to accommodate it. The addition itself (the new field) is safe, but the side effect (changed ordering) breaks clients that assumed a stable order. The lesson is to evaluate the *net effect* of a change on existing client behaviour, not just whether it's syntactically additive.
