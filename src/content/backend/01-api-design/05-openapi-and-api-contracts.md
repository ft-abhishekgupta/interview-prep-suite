---
title: OpenAPI and API Contracts
description: What OpenAPI gives you, contract-first versus code-first workflows, breaking-change detection, consumer-driven contracts and alternatives like gRPC and GraphQL
difficulty: Core
tags: [openapi, api-design, contracts, tooling]
---

An API contract is a promise about shape and behaviour that exists independently of any single implementation, and OpenAPI is the dominant way to write that promise down for HTTP APIs so humans and tooling can both rely on it. Interviewers ask about this to see whether you treat an API as a product with a stable interface, or as "whatever the code currently happens to return."

## What OpenAPI/Swagger gives you

OpenAPI is a machine-readable specification (YAML or JSON) describing every endpoint, its parameters, request/response schemas, authentication requirements, and possible error responses. From that one document you get, largely for free:

- **Interactive documentation** (Swagger UI, Redoc) that's always in sync with the spec.
- **Generated client SDKs** in many languages, removing hand-written HTTP client boilerplate.
- **Generated server stubs** for contract-first workflows.
- **Request/response validation** middleware that rejects payloads not matching the schema.
- **Mock servers** generated straight from the spec, so frontend teams can start against a fake backend before the real one exists.
- **A single source of truth** other tools (contract-diff, linters, test generators) can consume.

> [!KEY]
> The value of OpenAPI isn't the YAML file itself, it's that a single artifact becomes the input to five different tools — docs, codegen, validation, mocking, diffing — instead of five teams maintaining five separately-drifting descriptions of the same API.

## Contract-first vs code-first

| | Contract-first | Code-first |
|---|---|---|
| Source of truth | The OpenAPI spec, written/reviewed first | The code (controllers, attributes); spec generated from it |
| Workflow | Design the API, review it, generate server stubs and client SDKs, then implement | Write controllers, annotate with attributes, spec is a by-product |
| Consistency | Naturally forces API design review before code exists | Spec quality depends on how well the code is annotated |
| Parallel work | Frontend/consumer teams can start against generated mocks immediately | Consumers wait until code (and its generated spec) exists |
| Risk | Design can drift from implementation if not enforced with tests | Implementation quirks leak into the public contract (e.g., internal enum values) |
| Common tools | Spec written by hand or via a designer (Stoplight), server stubs generated (NSwag, OpenAPI Generator) | `Swashbuckle`/`Microsoft.AspNetCore.OpenApi` reflect over controllers and attributes |

> [!TIP]
> The honest trade-off to name in an interview: contract-first forces a design conversation before any code is written, which catches bad API shapes early, but it's more process overhead for small internal APIs. Code-first is faster to get started but risks the public contract accidentally mirroring internal implementation details. Many teams do code-first but treat the *generated* spec as a reviewed artifact, running contract-diff in CI to catch drift.

## Generating clients

```bash
# From a hosted or local OpenAPI document
openapi-generator generate -i https://api.example.com/swagger.json \
  -g csharp -o ./generated/ExampleApiClient
```

Generated clients give you typed request/response models and method signatures matching the spec, removing an entire class of bugs (typos in URLs, wrong header names, mismatched field names) that hand-written HTTP clients are prone to. The trade-off is generated code can be verbose and sometimes needs light wrapping to feel idiomatic in the target codebase.

## Documenting errors and examples

A schema that only documents the happy path is an incomplete contract. Document every meaningful response code with an example:

```yaml
paths:
  /orders/{id}:
    get:
      responses:
        '200':
          description: Order found
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Order'
              example:
                id: 1029
                status: shipped
        '404':
          description: Order not found
          content:
            application/problem+json:
              schema:
                $ref: '#/components/schemas/ProblemDetails'
              example:
                type: https://example.com/probs/not-found
                title: Order not found
                status: 404
```

Concrete examples matter more than the schema alone for developer experience — most engineers integrating against your API read the example first and the schema second.

## Schema design and reuse

Extract shared shapes into `components/schemas` and reference them (`$ref`) instead of duplicating field lists across endpoints — a `ProblemDetails` schema, a `PagedResponse<T>` wrapper, and core domain objects like `Order` should each be defined once and reused everywhere they appear. This keeps the spec maintainable and, more importantly, keeps client-generated types from silently drifting into subtly different-but-identical shapes across endpoints.

```yaml
components:
  schemas:
    Order:
      type: object
      properties:
        id: { type: integer }
        status: { type: string, enum: [pending, shipped, delivered, cancelled] }
    PagedOrders:
      type: object
      properties:
        data:
          type: array
          items: { $ref: '#/components/schemas/Order' }
        nextCursor: { type: string, nullable: true }
```

## Breaking-change detection in CI

```mermaid
flowchart LR
    A["PR changes API code"] --> B["Generate updated OpenAPI spec"]
    B --> C["Diff against main branch's spec"]
    C --> D{"Breaking change<br/>detected?"}
    D -->|"Yes"| E["Fail build,<br/>require major version bump"]
    D -->|"No"| F["Merge allowed"]
```

Tools like `oasdiff` or `openapi-diff` compare two versions of a spec and classify differences as breaking (removed field, changed type, newly-required parameter) or non-breaking (added optional field, new endpoint). Wiring this into CI turns "did we just break a consumer" from a manual review judgment call into an automated gate — exactly the kind of check that prevents the versioning mistakes covered elsewhere in API design.

## Consumer-driven contract testing

Schema validation alone confirms your API *matches its own documented shape* — it doesn't confirm real consumers actually work against it. Consumer-driven contract testing (the Pact pattern) flips the direction: each consumer team writes an expectation of what they need from the API ("when I call `GET /orders/1`, I expect a `status` field of type string"), publishes it as a contract, and the API's CI pipeline runs those consumer-authored expectations against the real API before deploying.

| | Schema validation (OpenAPI) | Consumer-driven contracts (Pact) |
|---|---|---|
| Source of expectations | API provider's own spec | Each consumer's actual usage |
| Catches | Spec drift from implementation | Provider changes that break a *specific real consumer*, even if technically spec-compliant |
| Best for | Documenting and generating clients | Microservices with several known internal consumers |

> [!WARNING]
> A change can be perfectly valid against your OpenAPI schema (e.g., a field's value set grows from 3 enum values to 4) and still break a consumer that has an exhaustive `switch` statement over the old 3 values with no default case. Schema validation won't catch this; a consumer-driven contract test that exercises the actual consumer's expectations can.

## API style guides and linting

Consistency across an API surface (naming, pluralization, error shape, pagination conventions) degrades quickly without enforcement. Linters like Spectral run rules against an OpenAPI spec in CI — "every `2xx` GET must define a response schema," "path parameters must be camelCase," "every operation must have a `summary`" — catching style drift the same way ESLint or a C# analyzer catches code style drift.

## gRPC and GraphQL as alternative contract mechanisms

| | OpenAPI (REST) | gRPC (protobuf) | GraphQL (SDL schema) |
|---|---|---|---|
| Contract format | YAML/JSON spec | `.proto` files | Schema Definition Language |
| Type safety | Depends on tooling/codegen | Strong, compile-time, cross-language | Strong, validated at query time |
| Evolution model | Additive fields, versioned paths | Field numbers reserved, never reused | Deprecate fields with `@deprecated`, additive only |
| Codegen | Common via generators | Built-in, first-class | Common via generators (e.g., GraphQL Code Generator) |

Protobuf's field-numbering discipline (`reserved 4;` when a field is removed, never reusing that number) is arguably a stricter, more foolproof compatibility mechanism than OpenAPI's convention-based approach — it's enforced by the wire format itself, not just a linter. GraphQL's schema similarly supports additive evolution natively (`@deprecated` fields stay queryable until clients migrate), making its contract evolution story conceptually similar to REST's additive-only philosophy but enforced by the type system.

## Versioning the contract

Keep the OpenAPI spec itself under version control alongside the code, tagged or branched per major API version, so `oasdiff`-style tooling always has an accurate "before" to diff against. Treat the spec as reviewable code: a pull request that changes a response shape should show that diff in the spec review, not just in a serializer class three files away — this is what actually gives a team early warning that a change is contract-breaking, before it reaches a client in production.

## Cheat sheet

- OpenAPI turns one spec into docs, generated clients, generated server stubs, request validation, and mock servers.
- Contract-first forces design review before code exists; code-first is faster to start but risks leaking implementation details into the contract.
- Document error responses and give every schema a concrete example — examples are read before schemas.
- Extract shared shapes into `components/schemas` and reuse via `$ref`; never duplicate the same object shape across endpoints.
- Wire breaking-change detection (`oasdiff`/`openapi-diff`) into CI so incompatible changes fail the build automatically.
- Consumer-driven contracts (Pact) catch real breakages schema validation alone misses, especially around enum growth and optional-field assumptions.
- Lint your spec (Spectral) for naming and structural consistency the same way you lint code.
- gRPC's field-numbering and GraphQL's `@deprecated` fields are alternative, often stricter, contract-evolution mechanisms.

## Common mistakes

| Mistake | Fix |
|---|---|
| Treating the generated OpenAPI spec as an afterthought, never reviewed | Review spec diffs in PRs like you review code diffs |
| No examples in the spec, only bare schemas | Add a concrete example to every response, not just the type shape |
| Duplicating the same object shape across multiple endpoint schemas | Extract to `components/schemas` and reference via `$ref` |
| Relying only on schema validation to catch breaking changes | Add consumer-driven contract tests for known critical consumers |
| No CI gate for breaking API changes | Run a spec-diff tool in CI and fail the build on breaking changes |
| Inconsistent naming/pagination shape across endpoints | Lint the spec (Spectral) against a written API style guide |

## Summary

OpenAPI turns an API's shape into a single, machine-readable artifact that powers documentation, generated clients, request validation and mock servers, replacing a pile of hand-maintained, drifting descriptions of the same interface. Contract-first design forces a review conversation before code exists and lets consumer teams start against generated mocks immediately, while code-first is faster to bootstrap but risks the contract quietly mirroring internal implementation quirks — many teams land on code-first with the generated spec treated as a reviewed, diffed artifact. Automated breaking-change detection in CI and consumer-driven contract tests catch different classes of problems (spec drift vs. real-consumer breakage) and are complementary, not redundant. gRPC and GraphQL solve the same "stable, evolvable contract" problem with their own mechanisms — protobuf field numbering and GraphQL's `@deprecated` — worth naming as alternatives when the conversation moves beyond REST.

## Top Interview Questions

### Q1. What concrete value does an OpenAPI specification provide beyond documentation?

Beyond generating always-up-to-date interactive docs (Swagger UI/Redoc), the same spec drives generated client SDKs in multiple languages (removing hand-written, typo-prone HTTP client code), generated server stubs for contract-first workflows, runtime request/response validation middleware, mock servers that let frontend teams build against a fake backend before the real implementation exists, and input to automated tooling like breaking-change diffing and style linting. The core value is that it's a single artifact multiple independent tools consume, rather than five different teams maintaining five separately drifting descriptions of the same API's shape.

### Q2. Compare contract-first and code-first API development. Which would you choose for a new public API and why?

Contract-first means the OpenAPI spec is designed and reviewed before implementation begins, forcing a design conversation about resource shape, naming and error handling up front, and letting consumer teams start building against generated mocks immediately — the risk is the implementation can drift from the agreed spec if nothing enforces it. Code-first means the spec is generated from annotated controllers, which is faster to get started with since there's no separate design artifact to maintain by hand, but the contract can end up accidentally reflecting internal implementation details (like an internal enum's exact casing) that never went through a deliberate design review. For a public API with external consumers and a real compatibility burden, I'd lean contract-first (or code-first with mandatory spec review and CI diffing) — the up-front design discipline pays for itself the first time you'd otherwise have shipped an awkward, hard-to-change public shape.

### Q3. Why should error responses and examples be part of an OpenAPI spec, not just the happy-path schema?

An API contract that only documents the 200 response leaves consumers to discover error shapes by trial and error in production, which is exactly the kind of gap that causes brittle client code (catching generic exceptions instead of handling specific documented error codes). Documenting every meaningful status code (400, 404, 409, 422, etc.) with its own schema and example lets consumers write correct error-handling logic before they've ever hit the real failure case, and concrete examples specifically matter because most engineers read the example first to understand real payload shape, only consulting the formal schema for edge cases like exact types or optionality.

### Q4. Why extract shared shapes into `components/schemas` instead of repeating them in each endpoint's definition?

Repeating the same object shape (say, the `Order` object) across ten different endpoint definitions means any change to that shape — adding a field, renaming one — has to be applied consistently in ten places, and it's easy for definitions to silently diverge over time as different people edit different endpoints. Extracting to `components/schemas` and referencing via `$ref` makes the shape a single source of truth: change it once, every endpoint that references it updates automatically, and generated clients produce a single reusable type instead of ten subtly different structurally-identical classes.

### Q5. How would you automatically detect that a proposed API change is breaking, before it merges?

Keep the previous version's OpenAPI spec under version control, and add a CI step that generates the new spec from the changed code (or the updated hand-written spec, in a contract-first workflow) and runs a diff tool like `oasdiff` or `openapi-diff` against the prior version — these tools classify differences into breaking (removed fields, changed types, newly-required parameters, removed endpoints) and non-breaking (added optional fields, new endpoints) categories automatically. Wiring this to fail the build on any breaking change turns "did we just break a consumer" from a manual, easy-to-miss review judgment call into an automated, enforced gate.

### Q6. What is consumer-driven contract testing, and what does it catch that OpenAPI schema validation doesn't?

Consumer-driven contract testing (the Pact pattern) inverts who writes the expectations: instead of only validating that the API matches its own documented spec, each real consumer team publishes a contract describing exactly what fields and behaviours *they* depend on, and the provider's CI pipeline runs those consumer-authored expectations against the real API before deploying. This catches a class of breakage that schema validation misses entirely: a change can be perfectly valid against the schema (e.g., an enum growing from three values to four) while still breaking a specific consumer that has an exhaustive switch statement with no default case over the old three values — schema compliance and "doesn't break anyone" are not the same guarantee.

### Q7. Why might protobuf's field-numbering scheme be considered a stricter contract-evolution mechanism than OpenAPI's conventions?

In protobuf, every field has an explicit integer tag number that's part of the wire format itself, and the compatibility rules (never reuse a removed field's number, mark it `reserved` instead, only add new fields with new numbers) are enforced structurally by the binary encoding — an old client and new server (or vice versa) can literally decode messages correctly because the numbering discipline is baked into the protocol, not just a style guideline. OpenAPI's compatibility rules (don't remove fields, don't change types) are conventions checked by external tooling (linters, diff tools) layered on top of a schema that itself doesn't enforce them at the protocol level — nothing stops you from technically publishing a breaking OpenAPI spec change, whereas protobuf's field numbers make certain classes of accidental incompatibility structurally awkward to introduce by accident.

### Q8. Your team does code-first API development with Swashbuckle. How would you prevent the generated public contract from leaking internal implementation details?

Explicitly separate the internal domain/EF entity model from the public DTOs returned by controllers — never return an EF entity directly from an action, since its exact property names, internal-only fields, and lazy-loading navigation properties would otherwise leak straight into the generated spec. Use dedicated request/response DTOs annotated with the API-facing names and validation attributes you actually want documented, and review the generated spec diff in code review the same way you'd review a code diff, catching accidental exposure (like an internal status enum with implementation-specific values) before it reaches consumers.

### Q9. What role does an API style guide and a linter like Spectral play in a team maintaining many microservice APIs?

Without enforcement, consistency across many independently-owned APIs degrades quickly — one team pluralizes collections, another doesn't; one team's error shape has a `code` field, another calls it `errorCode`; pagination conventions diverge. A written API style guide captures the agreed conventions (naming case, pagination shape, error envelope, required documentation fields), and a linter like Spectral encodes those rules as automated checks that run against every service's OpenAPI spec in CI, catching drift the same way ESLint or a Roslyn analyzer catches code style drift — turning "please follow the style guide" from a hopeful code-review comment into an enforced gate.

### Q10. When would you choose GraphQL's schema or gRPC's protobuf contract over a plain OpenAPI/REST contract, purely from a contract-management perspective?

GraphQL's schema natively supports additive, non-breaking evolution as a first-class concept — fields are marked `@deprecated` and remain queryable until every consumer has migrated off them, with the type system itself validating every query against the current schema at request time, which is a stronger, built-in guarantee than OpenAPI's convention-based additive-only discipline. gRPC's protobuf contract offers compile-time, cross-language type safety and a field-numbering scheme that makes certain incompatible changes structurally difficult to introduce by accident, which is valuable for internal service-to-service contracts where you control both ends and want the strongest possible guarantee the wire format stays compatible. I'd reach for GraphQL's schema when client-driven, evolving data needs are the priority, and gRPC's protobuf contract when strict internal type safety and performance matter more than broad public/browser accessibility.

### Q11. A frontend team wants to start building against your API before the backend implementation is finished. How does a contract-first workflow help here?

With a contract-first workflow, the OpenAPI spec is written and reviewed first, and a mock server can be generated directly from that spec (tools like Prism do this) before a single line of the real backend implementation exists — the frontend team codes against realistic, schema-validated mock responses that match the exact agreed contract, and switches to the real API once it's ready with no code changes needed on their end, assuming the implementation honors the reviewed spec. This decouples the two teams' timelines entirely, which is one of the strongest practical arguments for contract-first over code-first, especially when frontend and backend work happens in parallel sprints.

### Q12. How would you handle a situation where the OpenAPI spec and the actual deployed API have drifted out of sync?

First, establish which one is authoritative going forward — in most real setups this should be the code (via code-first generation) unless the team has strict contract-first discipline with enforcement, since a spec nobody regenerates from the real code will drift again immediately. Add a CI check that regenerates the spec from the live code (or runs the deployed API against its own published spec using a validation tool) and fails the build if they disagree, then do a one-time reconciliation pass to bring them back in sync — documenting genuinely breaking differences as a new major version rather than silently changing either side. Going forward, treat the spec as a build artifact regenerated and diffed on every change, not a document maintained by hand and updated "when someone remembers."
