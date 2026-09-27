---
title: REST Principles
description: The architectural constraints behind REST, how to model resources and URIs correctly, and how REST compares to RPC, GraphQL and gRPC
difficulty: Foundational
tags: [rest, api-design, http, architecture]
---

REST is not a protocol or a library, it is a set of architectural constraints for building networked systems that Roy Fielding described in his 2000 doctoral dissertation. Interviewers rarely ask you to recite the constraints, but they will ask you to justify a design decision — a nested URI, a status code, a caching header — and the constraint behind it is the correct justification.

The name is itself a definition: **RE**presentational **S**tate **T**ransfer means a client and server exchange *representations* (JSON, XML) of a resource's current *state*, and that representation — not the resource itself — is what's transferred over the network. Business domains such as orders, customers and tickets become REST resources; the HTTP verb and status code describe what happened to that resource's state, not a remote procedure being invoked.

![alt text](notes/05-HighLevelDesign/ApiDesign/image.png)

## The six constraints

| Constraint | What it means | Interview relevance |
|---|---|---|
| Client-server | UI and storage concerns are separated | Lets clients and servers evolve independently |
| Stateless | Each request contains all the context the server needs | No server-side session; enables horizontal scaling |
| Cacheable | Responses declare whether they can be cached | Reduces load, improves latency |
| Uniform interface | Resources identified by URI, manipulated through representations, self-descriptive messages, HATEOAS | The part everyone gets wrong in practice |
| Layered system | Client cannot tell if it talked to the origin server or an intermediary | Enables gateways, load balancers, CDNs |
| Code on demand (optional) | Server can send executable code to the client | Rarely used outside browsers (JS) |

> [!KEY]
> Statelessness is the constraint that unlocks horizontal scaling. If session state lived on one server, you could not load-balance requests across a fleet without sticky sessions — REST pushes that state to the client (a token) or a shared store instead.

Every one of those constraints reduces to the same shape at runtime: a stateless request/response exchange between a client and a server, with the server free to be layered — a gateway, a cache, an application tier, a database — without the client ever needing to know.

```mermaid
flowchart LR
    C["Client<br/>(Web / Mobile / App)"]
    S["Server<br/>(API)"]
    D[("Database")]
    C -->|"Request (HTTP)"| S
    S -->|"Response (JSON)"| C
    S <-->|"CRUD"| D
```

## Resource modelling and URI design

REST models the world as **nouns** (resources), not actions. The HTTP method supplies the verb.

- Use plural nouns for collections: `/orders`, not `/order` or `/getOrders`.
- Identify a single resource with a path segment: `/orders/{orderId}`.
- Nest only for genuine ownership, and stop at two levels: `/orders/{orderId}/items` is fine; `/customers/{id}/orders/{id}/items/{id}/discounts` is not — flatten it to `/order-items/{id}/discounts` or pass the parent as a query filter.
- Use query parameters for filtering, sorting and pagination, never for identifying a resource: `/orders?status=pending`, not `/orders/pending`.
- Model actions that don't map to CRUD as a sub-resource or a verb-like POST: `POST /orders/{id}/cancel` rather than `PUT /orders/{id}?action=cancel`.

> [!TIP]
> When you're unsure how deep to nest, ask "can this resource exist without its parent?" An order item cannot exist without an order (nest it), but a review can usually be looked up on its own (give it a top-level collection and reference the order by ID in the body or a filter).

```mermaid
flowchart LR
    A["/customers/{id}"] --> B["/customers/{id}/orders"]
    B --> C["/orders/{orderId}"]
    C --> D["/orders/{orderId}/items"]
    C --> E["/orders/{orderId}/payments"]
    style C fill:#8b7bff,stroke:#6d5cc4,color:#fff
```

## HATEOAS and why almost nobody implements it

Hypermedia As The Engine Of Application State says a response should include links to the next valid actions, so the client discovers the API at runtime instead of hardcoding URLs.

```json
{
  "id": 42,
  "status": "pending",
  "_links": {
    "self": { "href": "/orders/42" },
    "cancel": { "href": "/orders/42/cancel" },
    "customer": { "href": "/customers/7" }
  }
}
```

In practice almost no public API does this fully because clients are written against fixed contracts and code generation (OpenAPI clients, typed SDKs) anyway, so the discoverability HATEOAS promises is rarely needed. It survives mostly in the payment and banking world (HAL, Siren) where long-lived workflows benefit from server-driven next steps.

## Richardson Maturity Model

A quick way to grade how "RESTful" an API really is:

| Level | Adds | Example |
|---|---|---|
| 0 | A single endpoint, everything is a POST | `POST /api` with an action field in the body (RPC over HTTP) |
| 1 | Multiple resource URIs | `/orders`, `/customers` but still one HTTP method |
| 2 | Correct HTTP methods and status codes | `GET /orders/42` returns 200, `POST /orders` returns 201 |
| 3 | HATEOAS — hypermedia controls | Responses include `_links` for valid next actions |

Most production APIs that call themselves "REST" sit at level 2. That is a perfectly fine, defensible answer to give in an interview — say it plainly rather than pretending you always build level 3.

## Statelessness and cacheability in practice

Statelessness means no client session is stored in server memory between requests — auth is proven per-request (bearer token, signed cookie validated against a stateless secret), and anything the server needs to process the request must travel with it. This is what lets you add a tenth replica of a service without any sticky-session configuration.

Cacheability is a first-class constraint, not an afterthought: every response should be explicit about whether it can be cached, by whom, and for how long, via `Cache-Control`, `ETag` and `Expires`. GET responses on largely-static resources (a product catalog entry) are excellent cache candidates; POST responses almost never are.

## REST vs RPC vs GraphQL vs gRPC

| Dimension | REST | RPC (plain) | GraphQL | gRPC |
|---|---|---|---|---|
| Model | Resources + HTTP verbs | Named procedures/actions | Single query language over a typed schema | Typed RPC over protobuf |
| Endpoints | Many (one per resource) | Many (one per action) | One | One per service, many methods |
| Payload | JSON (usually) | JSON/XML | JSON | Binary protobuf |
| Over/under-fetching | Common | N/A | Solved — client picks fields | N/A, fixed by contract |
| Browser-friendly | Yes | Yes | Yes | No (needs grpc-web/proxy) |
| Caching | Native HTTP caching | Manual | Hard (single endpoint, POST) | Manual |
| Best for | Public/partner APIs, CRUD-heavy resources | Simple internal actions | Rich, client-driven UIs with varied data needs | Low-latency internal service-to-service calls |
| Tooling maturity | Extremely high | High | High | High, but steeper learning curve |

> [!TIP]
> A senior answer names the axis, not just the winner: *"For our public partner API I'd default to REST for caching and tooling; for the mobile app's dashboard with many nested reads I'd consider GraphQL to cut round trips; for internal service-to-service calls in the same cluster I'd reach for gRPC for latency and strong typing."*

It helps to separate three independent layers when comparing these options: **paradigm** (how the API is designed — REST, GraphQL, RPC), **protocol** (how bytes move — HTTP/1.1, HTTP/2, WebSocket) and **serialization** (how the payload is encoded — JSON, Protobuf, XML). gRPC feels like a bigger departure from REST than GraphQL does precisely because it changes all three layers at once (RPC paradigm, HTTP/2 protocol, protobuf serialization), while GraphQL only changes the paradigm and keeps HTTP/JSON underneath.

![alt text](notes/05-HighLevelDesign/ApiDesign/image-1.png)

The same request looks different at every layer of that stack — fetching a user's name:

```text
REST    : GET /users/1                     → whole user object, JSON over HTTP
GraphQL : query { user(id: 1) { name } }   → only the name requested, JSON over HTTP (POST)
gRPC    : userService.GetUser({ id: 1 })   → typed call, Protobuf over HTTP/2
```

## Worked example — designing a resource model

Take a ride-hailing backend: riders request trips, drivers accept them, trips have a route and a fare.

- `/riders/{id}` and `/drivers/{id}` — top-level identity resources.
- `/trips` — a collection; `POST /trips` creates a trip request.
- `/trips/{id}` — the trip resource with `status`, `riderId`, `driverId`, `fare`.
- `/trips/{id}/accept` — `POST` action for a driver to accept (state transition, not a pure CRUD update).
- `/trips/{id}/route` — nested read-only sub-resource for the polyline/waypoints.

Notice fare and route are **not** separate top-level collections — they never exist independently of a trip, so they nest. Status transitions (`requested → accepted → in_progress → completed`) are actions via POST, not raw `PUT` on the whole trip, because a PUT would let a client illegally jump straight from `requested` to `completed`.

> [!WARNING]
> Don't model state machine transitions as a generic `PUT /trips/{id}` with a new `status` field in the body. It looks RESTful but it hides the business rule (which transitions are legal) inside client code. A dedicated action endpoint (`POST /trips/{id}/accept`) lets the server enforce the rule in one place.

## REST vs SOAP

SOAP predates REST and still shows up in banking, healthcare and enterprise integrations, so it's worth being able to place REST against it precisely rather than dismissing it as "the old one."

| | REST | SOAP |
|---|---|---|
| Nature | Architectural style | Protocol with a strict message format |
| Transport | HTTP (verbs, status codes) | HTTP, SMTP or others — transport-agnostic |
| Message format | JSON (usually), XML, others | XML only, wrapped in an envelope |
| Contract | Optional (OpenAPI) | Mandatory, machine-readable (WSDL) |
| Statefulness | Stateless by convention | Can be stateful (WS-* extensions) |
| Built-in security/transactions | No — bring your own (OAuth, mTLS) | Yes — WS-Security, WS-AtomicTransaction |
| Payload weight | Lightweight | Heavyweight, verbose envelopes |
| Typical home | Public/partner APIs, web, mobile | Enterprise integration, legacy banking/telco systems |

> [!NOTE]
> SOAP's WSDL contract and built-in transactional/security extensions are exactly why it survives in domains that need strict, auditable, multi-step distributed transactions — REST can do all of that too, but you assemble it yourself (OpenAPI for the contract, OAuth for security, sagas for transactions) rather than getting it from the protocol.

## REST decisions across the API lifecycle

The resource-modelling and versioning decisions made at design time are the ones that are hardest to undo later — a URI shape or a missing version strategy chosen in week one is still constraining you at year three.

![alt text](notes/05-HighLevelDesign/ApiDesign/image-2.png)

- **Design** — get resource nouns, nesting depth and the versioning strategy right; this is the cheapest point to fix a mistake.
- **Development** — enforce the constraints (statelessness, correct verbs/status codes) in code review, not just in docs.
- **Deployment & monitoring** — track which clients call which endpoints so a breaking change or deprecation has real usage data behind it.
- **Maintenance** — additive-only changes within a version (see the dedicated versioning page) keep this phase from generating a new major version every sprint.
- **Deprecation & retirement** — signal it with `Deprecation`/`Sunset` headers and a real runway rather than a silent cutover.

## Cheat sheet

- Six constraints: client-server, stateless, cacheable, uniform interface, layered system, code-on-demand (optional).
- Nouns for resources, HTTP verbs for actions; plural collections, singular items.
- Nest for true ownership only, stop at two levels deep.
- Model illegal-transition risk with action endpoints (`POST /x/{id}/cancel`), not a generic PUT.
- HATEOAS is level 3 of Richardson's model; most real APIs stop at level 2, and that's fine to admit.
- REST wins on caching and tooling; GraphQL wins on flexible client-driven reads; gRPC wins on internal latency and typed contracts.
- Statelessness enables horizontal scaling — no sticky sessions needed.
- Cacheability must be explicit per response, not assumed.
- Separate paradigm, protocol and serialization when comparing REST/GraphQL/gRPC — gRPC changes all three at once.
- SOAP brings a mandatory WSDL contract and built-in security/transaction extensions REST doesn't have natively — it survives where those matter more than lightweight payloads.
- Resource and versioning decisions made at design time are the most expensive to reverse later.

## Common mistakes

| Mistake | Fix |
|---|---|
| Verbs in URIs (`/getUser`, `/createOrder`) | Use nouns + HTTP method (`GET /users/{id}`, `POST /orders`) |
| Nesting 4+ levels deep | Flatten; reference the parent via ID or query filter instead |
| Using `PUT` for partial updates | Use `PATCH`, reserve `PUT` for full replacement |
| Storing session state server-side and relying on sticky load balancing | Push state to a token or shared cache; keep servers stateless |
| Treating "RESTful" as a synonym for "returns JSON" | RESTful means the constraints are honored, not just the wire format |
| Modeling state transitions as raw field updates | Use action sub-resources that enforce valid transitions server-side |
| Calling SOAP "obsolete" without knowing why it still exists | Name the reason: mandatory WSDL contracts and built-in WS-Security/transactions for regulated, multi-step workflows |

## Summary

REST is a set of constraints — statelessness, cacheability, a uniform interface, a layered system — that together buy scalability, evolvability and cacheable performance, not just "JSON over HTTP." Model your domain as nouns, keep nesting shallow, and use action endpoints for anything that isn't a plain CRUD operation. Most real systems sit at Richardson level 2 and skip full HATEOAS, which is a defensible, industry-standard choice. When comparing REST to RPC, GraphQL, gRPC or the older SOAP standard in an interview, argue from the axis that matters for the scenario — caching, client flexibility, latency, or contractual rigor — rather than declaring a single universal winner, and remember that the resource and versioning decisions you make at design time are the ones that are hardest to walk back once clients depend on them.

## Top Interview Questions

### Q1. What are the six constraints of REST, and which one is most often violated in real systems?

The six are client-server separation, statelessness, cacheability, a uniform interface, a layered system, and optional code-on-demand. The uniform interface (specifically HATEOAS) is the one most often skipped — almost no production API returns hypermedia links describing valid next actions, because clients are built against fixed, code-generated contracts instead. Statelessness is the one most valuable to defend correctly: violating it (storing session state server-side) quietly removes your ability to horizontally scale without sticky sessions, which is a much more expensive mistake than skipping HATEOAS.

### Q2. Why do we prefer nouns over verbs in URI design?

The HTTP method already expresses the verb — `GET`, `POST`, `PUT`, `PATCH`, `DELETE` — so putting a verb in the path (`/getUser`, `/deleteOrder`) duplicates that information and breaks the uniform interface, since the URI should identify *what* is being acted on, not *how*. It also blocks proper HTTP semantics: `GET /getUser` cannot be safely cached or retried the way `GET /users/{id}` can, and tooling that inspects methods (like API gateways enforcing that GETs are safe) loses its guarantees.

### Q3. How deep should you nest resource URIs, and why?

Nest only when the child cannot meaningfully exist without the parent, and stop at roughly two levels: `/orders/{id}/items` is fine, `/customers/{id}/orders/{id}/items/{id}/discounts` is not. Beyond two levels the URI becomes brittle (any parent ID change breaks every child link), harder to route, and awkward to reference from elsewhere in the API. The fix is to flatten: give deeply-nested resources their own top-level collection (`/order-items/{id}`) and reference the parent by ID in the body or as a query filter.

### Q4. What is HATEOAS, and why do so few real APIs implement it?

HATEOAS means responses include hypermedia links describing the valid next actions from the current state (e.g., a pending order response includes a `cancel` link but not a `refund` link). It is the final constraint of the "uniform interface" and defines Richardson Maturity Level 3. Few APIs implement it because clients are typically built against a fixed contract using generated SDKs or documented endpoints, so the runtime discoverability HATEOAS provides is rarely exercised — code generation solves the same problem at build time instead. It shows up mostly in long-lived stateful workflows like payments, where the valid next step genuinely depends on server-side state.

### Q5. What is the Richardson Maturity Model, and what level does most production REST sit at?

It's a four-level scale (0 to 3) for grading how RESTful an API really is: level 0 is a single RPC-style endpoint, level 1 introduces separate resource URIs, level 2 adds correct use of HTTP verbs and status codes, and level 3 adds HATEOAS. Most production APIs sit at level 2 — they have well-modeled resources and use `GET`/`POST`/`PUT`/`DELETE` and status codes correctly, but skip hypermedia links. That is an acceptable, industry-standard stopping point and worth stating plainly rather than claiming full HATEOAS compliance you don't have.

### Q6. When would you choose GraphQL over REST, and what do you give up?

Choose GraphQL when clients have highly varied data needs from the same underlying resources — a mobile app's summary screen wants five fields, the detail screen wants forty, and a nested screen wants data from three different resources in one round trip. GraphQL solves over-fetching and under-fetching by letting the client specify exactly the fields and relations it needs in one query. You give up HTTP-native caching (everything is a POST to one endpoint, so CDNs and browser caches can't help), you add resolver complexity and the N+1 query risk, and you need query cost analysis to stop expensive nested queries from overloading the server.

### Q7. When would you choose gRPC over REST for a new service?

Choose gRPC for internal, service-to-service communication where both ends are under your control, latency matters, and you want a strongly-typed contract that catches mismatches at compile time. gRPC uses HTTP/2 multiplexing and binary protobuf serialization, which beats JSON-over-HTTP/1.1 on both payload size and connection efficiency, and streaming is built in. You give up browser-native calls (you need grpc-web or a proxy), human-readable payloads for debugging, and the enormous REST tooling ecosystem (curl, browser dev tools, generic API gateways) — reasonable trade-offs for internal microservice traffic, not for a public-facing API.

### Q8. Your company still runs a SOAP-based payments integration. Why hasn't it been replaced with REST, and would you recommend rewriting it?

SOAP's mandatory WSDL contract gives every consumer a strict, machine-readable definition of every operation and message shape, and its WS-* extensions (WS-Security, WS-AtomicTransaction) provide built-in, standardized message-level security and multi-step distributed transactions — capabilities a regulated payments flow genuinely needs. REST can achieve the same outcomes, but you have to assemble them yourself from separate pieces (OpenAPI for the contract, mTLS/OAuth for security, a saga or outbox pattern for the transaction), so "just rewrite it in REST" isn't automatically a simplification. I'd only recommend migrating if the integration is being actively extended and the assembly cost is clearly cheaper than SOAP's built-in guarantees for this specific workflow — not as a blanket "REST is newer" argument.

### Q9. A teammate proposes `PUT /orders/{id}` with a `status` field to move an order through its lifecycle. What's wrong with this, and what would you do instead?

`PUT` implies a full, idempotent replacement of the resource, and letting the client set an arbitrary `status` value hides the business rule about which transitions are legal (a `requested` order should never jump straight to `completed`) inside client code, where every client has to reimplement it correctly. I'd replace it with dedicated action endpoints — `POST /orders/{id}/accept`, `POST /orders/{id}/cancel` — so the server is the single place enforcing valid transitions, and each endpoint can return a specific error (409 Conflict) when the transition isn't legal from the current state, rather than silently accepting an invalid `status` value.

### Q10. How would you decide whether a sub-resource should be nested or given its own top-level collection?

Ask whether the child can exist, be queried, or be referenced independently of its parent. An order line item has no independent identity outside its order, so nest it: `/orders/{id}/items`. A comment on a blog post, by contrast, is often looked up on its own (moderation queues, "my comments" pages), so it deserves its own top-level collection (`/comments/{id}`) with the parent post referenced by ID. If you find yourself needing to query a "nested" resource without knowing its parent's ID, that's a strong signal it should be top-level.

### Q11. Your API currently returns 200 for everything and puts error details in the body — a teammate says "that's fine, the client checks a `success` field." Why push back?

That design (Richardson level 0-ish) throws away everything HTTP gives you for free: proxies, browsers, monitoring tools, and API gateways all key off status codes to detect failures, retry safely, or alert — none of that works if failures return 200. It also breaks caching (intermediaries assume 200 responses are cacheable and reusable, which an error payload is not) and forces every client integration to remember to check the extra field instead of relying on standard HTTP semantics. The fix is to map failures to the correct 4xx/5xx status and keep the body for structured error detail (see RFC 7807 Problem Details), so both the transport layer and the application layer agree on what happened.

### Q12. How do you handle an operation that doesn't map cleanly to CRUD, like "send a password reset email"?

Model it as an action on the relevant resource using `POST`, since it has side effects and isn't idempotent or safe: `POST /users/{id}/password-reset-emails` (treating each reset request as a new resource in a sub-collection) or the simpler `POST /users/{id}/reset-password` verb-flavored endpoint — both are accepted patterns, and consistency across your API matters more than which one you pick. What you should avoid is forcing it into `PUT /users/{id}` with a `resetPassword: true` flag, which conflates an action with a resource state update and makes the endpoint's idempotency and safety guarantees ambiguous.
