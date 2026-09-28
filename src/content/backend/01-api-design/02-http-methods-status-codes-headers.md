---
title: HTTP Methods, Status Codes and Headers
description: The HTTP verbs, status code families and headers that actually get used in production APIs, with conditional requests and CORS
difficulty: Foundational
tags: [http, status-codes, headers, api-design]
---

HTTP is the substrate almost every backend interview question sits on top of. Interviewers use it to check that you know the difference between "the request failed" (4xx/5xx) and "the request succeeded but here's what happened" (2xx/3xx), and whether you can reason about safety, idempotency and caching from first principles rather than memorised trivia.

## HTTP methods

| Method | Purpose | Safe | Idempotent | Cacheable | Request body |
|---|---|---|---|---|---|
| `GET` | Retrieve a resource | ✅ | ✅ | ✅ | No |
| `HEAD` | Like GET, headers only | ✅ | ✅ | ✅ | No |
| `POST` | Create a resource / trigger an action | ❌ | ❌ | Only if explicitly marked cacheable | Yes |
| `PUT` | Replace a resource entirely | ❌ | ✅ | ❌ | Yes |
| `PATCH` | Partially modify a resource | ❌ | ❌* | ❌ | Yes |
| `DELETE` | Remove a resource | ❌ | ✅ | ❌ | Usually no |
| `OPTIONS` | Discover allowed methods/headers | ✅ | ✅ | ❌ | No |

*`PATCH` *can* be made idempotent (e.g., JSON Merge Patch that sets absolute values), but a delta-style patch like "increment count by 1" is not — calling it twice doubles the effect.

**Safe** means the request doesn't change server state (so it's fine to prefetch or retry blindly). **Idempotent** means calling it N times has the same effect as calling it once — critical for retry logic on flaky networks. Every safe method is idempotent, but not every idempotent method is safe (`DELETE` changes state yet is idempotent: deleting twice leaves the same end state as deleting once).

> [!KEY]
> Idempotency is what makes retries safe. If your client can't tell whether a `POST /payments` succeeded before the connection dropped, retrying it blindly can double-charge a customer — this is exactly why idempotency keys exist (see the dedicated idempotency page).

### PUT vs PATCH vs POST

| | PUT | PATCH | POST |
|---|---|---|---|
| Semantics | Replace the whole resource | Apply a partial change | Create, or trigger a non-idempotent action |
| Body | Full representation | Partial representation or patch document | Varies |
| Idempotent | Yes | Depends on implementation | No |
| Typical use | `PUT /users/42` with the complete user object | `PATCH /users/42` with `{ "email": "..." }` | `POST /users` to create, `POST /orders/42/cancel` for an action |

> [!WARNING]
> A common bug: a client sends a `PUT` with only the fields it wants to change, and the server (correctly, per PUT semantics) treats missing fields as "set to null/default" — silently wiping data the client didn't intend to touch. If partial updates are the common case, expose `PATCH`, don't abuse `PUT`.

## Status code families

| Family | Meaning | Codes that matter |
|---|---|---|
| 2xx | Success | 200, 201, 202, 204 |
| 3xx | Redirection / caching | 301, 302, 304 |
| 4xx | Client error | 400, 401, 403, 404, 405, 409, 410, 412, 415, 422, 428, 429 |
| 5xx | Server error | 500, 502, 503, 504 |

| Code | Name | When to use it |
|---|---|---|
| 200 | OK | Successful GET/PUT/PATCH with a body |
| 201 | Created | Successful POST that created a resource — include `Location` header |
| 202 | Accepted | Request accepted for async processing, not yet complete |
| 204 | No Content | Success with nothing to return (DELETE, or PUT with no body) |
| 301 | Moved Permanently | Resource's canonical URI has changed for good |
| 302 | Found | Temporary redirect |
| 304 | Not Modified | Conditional GET, client's cached copy is still valid |
| 400 | Bad Request | Malformed syntax — invalid JSON, wrong types |
| 401 | Unauthorized | Missing or invalid credentials (really means "unauthenticated") |
| 403 | Forbidden | Authenticated, but not allowed to do this |
| 404 | Not Found | Resource doesn't exist (or you don't want to reveal it does) |
| 405 | Method Not Allowed | Valid resource, wrong verb (e.g., DELETE on a read-only resource) |
| 409 | Conflict | Request conflicts with current state (duplicate create, version clash) |
| 410 | Gone | Used to exist, deliberately removed — stronger signal than 404 |
| 412 | Precondition Failed | `If-Match`/`If-Unmodified-Since` check failed — optimistic concurrency |
| 415 | Unsupported Media Type | `Content-Type` isn't something the server accepts |
| 422 | Unprocessable Entity | Syntactically valid, semantically invalid (failed business validation) |
| 428 | Precondition Required | Server requires a conditional header such as `If-Match` to prevent lost updates |
| 429 | Too Many Requests | Rate limit exceeded — include `Retry-After` |
| 500 | Internal Server Error | Unhandled exception, server's fault |
| 502 | Bad Gateway | Upstream service returned an invalid response |
| 503 | Service Unavailable | Server overloaded or in maintenance, try later |
| 504 | Gateway Timeout | Upstream didn't respond in time |

> [!TIP]
> 400 vs 422 is a favourite trick question. 400 means the request itself is malformed (bad JSON, wrong type for a field). 422 means the request is well-formed JSON but violates a business rule (e.g., `endDate` before `startDate`). Getting this distinction right signals you separate parsing from domain validation.

## Important headers

| Header | Direction | Purpose |
|---|---|---|
| `Content-Type` | Both | Media type of the body (`application/json`) |
| `Accept` | Request | Media types the client can handle |
| `Authorization` | Request | Credentials — `Bearer <token>`, `Basic <base64>` |
| `Location` | Response | URI of a newly created resource (with 201) or redirect target |
| `Cache-Control` | Response | Caching policy — `max-age`, `no-store`, `private` |
| `ETag` | Response | Opaque version identifier for a resource |
| `If-None-Match` | Request | Conditional GET — "only send the body if the ETag changed" |
| `If-Match` | Request | Conditional write — "only apply if the ETag still matches" |
| `Retry-After` | Response | Seconds (or date) to wait before retrying — used with 429/503 |
| `X-Request-Id` / `traceparent` | Both | Correlation ID for distributed tracing |

## Content negotiation

A client tells the server what it can accept, and the server picks the best match:

```http
GET /orders/42 HTTP/1.1
Accept: application/json, application/xml;q=0.8
Accept-Language: en-US, fr;q=0.5
```

The server responds with the format it chose, stated explicitly:

```http
HTTP/1.1 200 OK
Content-Type: application/json
Content-Language: en-US
```

`q` values (0 to 1) express preference weighting when multiple types are acceptable. If the server can't satisfy any requested type, it returns `406 Not Acceptable`.

## Conditional requests with ETag

An `ETag` is a hash or version token for a resource's current representation. Clients cache it and send it back on the next request so the server can skip re-sending unchanged data.

```mermaid
sequenceDiagram
    participant Client
    participant Server
    Client->>Server: GET /orders/42
    Server-->>Client: 200 OK, ETag "v3", body
    Client->>Server: GET /orders/42<br/>If-None-Match "v3"
    Server-->>Client: 304 Not Modified (no body)
    Note over Client: Reuses cached copy
```

The same mechanism protects writes: send `If-Match "v3"` on a `PUT`/`PATCH`, and the server returns `412 Precondition Failed` if the resource has moved on to a different version — a cheap way to implement optimistic concurrency without locks.

```csharp
[HttpPut("orders/{id}")]
public IActionResult UpdateOrder(int id, [FromBody] OrderDto dto, [FromHeader(Name = "If-Match")] string? ifMatch)
{
    var order = _repo.Get(id);
    var currentEtag = $"\"{order.Version}\"";
    if (ifMatch != null && ifMatch != currentEtag)
        return StatusCode(412); // someone else updated it first

    order.Apply(dto);
    order.Version++;
    _repo.Save(order);
    Response.Headers.ETag = $"\"{order.Version}\"";
    return Ok(order);
}
```

## CORS preflight

Browsers block cross-origin requests unless the server opts in. For "non-simple" requests (custom headers, `PATCH`/`DELETE`, `Content-Type: application/json`), the browser sends an `OPTIONS` preflight first:

```http
OPTIONS /orders HTTP/1.1
Origin: https://app.example.com
Access-Control-Request-Method: POST
Access-Control-Request-Headers: content-type, authorization
```

The server must respond with what it allows:

```http
HTTP/1.1 204 No Content
Access-Control-Allow-Origin: https://app.example.com
Access-Control-Allow-Methods: GET, POST, PATCH, DELETE
Access-Control-Allow-Headers: content-type, authorization
Access-Control-Max-Age: 600
```

> [!DANGER]
> `Access-Control-Allow-Origin: *` combined with `Access-Control-Allow-Credentials: true` is invalid and browsers will reject it — you cannot wildcard the origin while also allowing cookies/credentials. Echo back the specific allowed origin instead.

## Cheat sheet

- Safe = doesn't change state. Idempotent = repeating it has the same effect as doing it once. Every safe method is idempotent; not every idempotent method is safe.
- `PUT` replaces the whole resource; `PATCH` changes part of it; `POST` creates or triggers an action.
- 201 needs a `Location` header. 204 has no body. 202 means "accepted, not finished yet."
- 400 = malformed request. 422 = well-formed but fails business validation. Don't conflate them.
- 401 = not authenticated. 403 = authenticated but not permitted. This is the other classic mix-up.
- 409 = conflicts with current state. 412 = a conditional header check failed; 428 = the required conditional header was missing.
- `ETag` + `If-None-Match` powers conditional GET (304, no body). `ETag` + `If-Match` powers conditional writes (412 on conflict).
- 429 and 503 should both carry `Retry-After` so well-behaved clients back off correctly.
- CORS preflight is triggered by non-simple requests and must be answered with explicit allow headers, not just a 200.

## Common mistakes

| Mistake | Fix |
|---|---|
| Returning 200 for every response and putting errors in the body | Use the correct 4xx/5xx status; keep structured detail in the body |
| Using 401 when the user is authenticated but lacks permission | Use 403 for "you are who you say you are, but you can't do this" |
| Returning 500 for validation failures | Use 400/422; reserve 5xx for genuine server-side faults |
| Making `PATCH` semantics accidentally non-idempotent when clients assume it is safe to retry | Design patch bodies as absolute sets of fields, or document the delta behaviour clearly |
| Forgetting `Location` on a 201 response | Always include the URI of the newly created resource |
| Wildcarding CORS origin while allowing credentials | Echo the specific origin back instead of `*` |

## Summary

HTTP methods carry meaning beyond "which function to call" — safety and idempotency determine what a client can safely retry, and status codes let intermediaries (caches, gateways, monitoring) understand outcomes without parsing the body. Learn the families (2xx success, 3xx redirection, 4xx client fault, 5xx server fault) and the dozen codes that come up constantly, then layer in conditional requests via `ETag` for both efficient reads (304) and safe concurrent writes (412). Content negotiation and CORS round out the picture: they are the mechanics that let one API serve multiple formats and multiple origins safely.

## Top Interview Questions

### Q1. What is the difference between a safe and an idempotent HTTP method?

Safe means the method has no side effects on server state — a client, proxy, or crawler can call it any number of times without consequence, which is why `GET` requests can be prefetched and cached freely. Idempotent means that calling the method N times produces the same end state as calling it once, even if it does change something — `DELETE /orders/42` is not safe (it removes data) but is idempotent (calling it again just returns 404 or a no-op, the order stays deleted). Every safe method is automatically idempotent, but idempotent methods aren't necessarily safe; this distinction is exactly why retry logic can blindly retry a `GET` or `DELETE` after a timeout but must be more careful with `POST`.

### Q2. When should an endpoint use PUT versus PATCH?

`PUT` replaces the entire resource with the representation in the request body — any field omitted is expected to be cleared or reset to default, and calling it twice with the same body leaves the resource in the same state (idempotent). `PATCH` applies a partial modification, sending only the fields that change, and is the right choice whenever clients commonly update a subset of a resource's fields, since forcing them to `PUT` the whole object risks accidentally wiping fields they didn't intend to touch. A common real-world pattern is to support both: `PUT` for "replace this resource entirely" API clients (e.g., config sync tools) and `PATCH` for UI-driven partial edits.

### Q3. What's the difference between 401 and 403, and why do people mix them up?

401 Unauthorized actually means "unauthenticated" — the request lacks valid credentials, or the credentials provided are invalid/expired, and the correct client response is to re-authenticate. 403 Forbidden means the credentials are valid and the caller is known, but they don't have permission to perform this action on this resource. People mix them up because the HTTP spec's naming is confusing (401's name literally says "Unauthorized" but its meaning is "Unauthenticated"). The practical rule: if re-logging in could fix it, use 401; if the user is already correctly logged in and simply lacks the permission, use 403.

### Q4. Explain the difference between 400 and 422, with an example of each.

400 Bad Request means the request itself is malformed at the syntax level — invalid JSON, a string where a number was expected, a missing required field the deserializer can't even construct without. 422 Unprocessable Entity means the request parsed successfully into valid objects, but violates a business or domain rule — for example, an order's `endDate` is before its `startDate`, or a discount code has already expired. The distinction matters because it separates the concern of "can I even understand this request" (parsing/binding, 400) from "is this request allowed given the current state of the world" (domain validation, 422), and keeping them separate in your codebase keeps your validation layers clean.

### Q5. Why does a POST that creates a resource return 201 instead of 200, and what should accompany it?

201 Created explicitly signals "a new resource was created as a result of this request," which is more informative than the generic 200 OK and lets clients and tooling distinguish "created" from "read/updated an existing thing" without inspecting the body. It should be accompanied by a `Location` header pointing at the URI of the newly created resource (e.g., `Location: /orders/1029`), so the client can immediately `GET` it without guessing the ID, and typically a response body containing the created representation, including server-assigned fields like the ID and timestamps.

### Q6. How does a conditional GET with ETag reduce bandwidth, and how would you implement it?

The server computes an `ETag` (an opaque hash or version token) for a resource and sends it with the response. On the next request, the client sends that value back in `If-None-Match`. If the resource hasn't changed, the server responds `304 Not Modified` with no body at all, and the client reuses its cached copy — saving the full payload transfer. To implement it in ASP.NET Core, compute a hash (or use a `RowVersion`/`ConcurrencyToken` from the database) as the ETag, set it via `Response.Headers.ETag`, and on each request compare the incoming `If-None-Match` against the current value before deciding whether to serialize and return the full body.

### Q7. How can ETag also protect against lost updates on a PUT or PATCH?

The same token used for reads (`If-None-Match`) has a write-side counterpart: the client sends `If-Match: "<etag>"` on a `PUT`/`PATCH`, and the server only applies the update if the resource's current ETag still matches — if another request has modified it in between, the ETags won't match and the server responds `412 Precondition Failed` instead of silently overwriting the other change. This implements optimistic concurrency control without taking a database lock: two clients can read the same version, but only the first writer to submit wins, and the second gets a clear conflict signal to re-fetch and retry.

### Q8. What's the difference between 502, 503 and 504, and how would you triage them in production?

502 Bad Gateway means an intermediary (load balancer, reverse proxy, API gateway) received an invalid or malformed response from the upstream server — the upstream is reachable but returned garbage. 503 Service Unavailable means the server itself is deliberately not handling requests right now, typically overloaded or in maintenance, and should usually carry a `Retry-After` header. 504 Gateway Timeout means the intermediary gave up waiting for the upstream to respond at all. In triage: 502 points you at "what did the upstream actually return, check its logs for a crash or malformed output," 503 points at "check load/capacity or a maintenance flag," and 504 points at "check latency, is the upstream just slow or hung."

### Q9. A client reports that retrying a failed POST /payments request sometimes creates two charges. What's happening and how do you fix it?

`POST` is neither safe nor idempotent by default, so if the client's connection drops after the server processed the charge but before the response arrived, the client can't tell whether it succeeded, and a naive retry creates a second charge. The fix is an idempotency key: the client generates a unique key per logical operation (not per HTTP attempt) and sends it in a header like `Idempotency-Key`; the server stores the key alongside the result of the first successful processing, and on any retry with the same key it returns the stored result instead of re-executing the charge. This effectively makes an inherently non-idempotent operation safe to retry.

### Q10. Why do browsers send a preflight OPTIONS request before some cross-origin calls, and what must the server return?

Browsers enforce the same-origin policy and use CORS to safely relax it. For "non-simple" requests — custom headers, methods other than GET/POST/HEAD, or a `Content-Type` other than a few whitelisted simple ones — the browser first sends an `OPTIONS` request asking the server what it permits (`Access-Control-Request-Method`, `Access-Control-Request-Headers`), before sending the real request. The server must answer with `Access-Control-Allow-Origin` (the specific caller origin, not `*` if credentials are involved), `Access-Control-Allow-Methods`, and `Access-Control-Allow-Headers` for the browser to proceed; otherwise the browser blocks the actual request client-side, even if the server would have accepted it.

### Q11. Your team wants to add a `PATCH` endpoint that increments a counter field by a delta in the request body. Is this safe to expose as PATCH, and what should you document?

It's a defensible `PATCH` in terms of HTTP semantics (it's a partial update), but you must be explicit that it is **not idempotent** — calling `PATCH /counters/1 {"delta": 5}` twice increases the counter by 10, not 5, unlike a typical idempotent PATCH that sets absolute field values. This matters because HTTP clients, proxies, and retry middleware often assume `PATCH` is safe to retry on timeout; if yours isn't, you must document that explicitly and consider pairing it with an idempotency key for safe retries, or offering an alternative absolute-set endpoint for callers that need idempotency.

### Q12. How would you design status codes for an endpoint that starts a long-running export job?

Return `202 Accepted` immediately once the job is queued, since the work isn't done yet but the request was validly accepted — include a `Location` header pointing at a status resource (`/exports/{jobId}`) the client can poll. That status resource returns `200 OK` with a `status: "processing"` body while running, and once finished either `200 OK` with a `status: "complete"` body plus a link to the result, or redirects/serves the completed artifact directly. This avoids blocking the original HTTP connection for a long-running operation and gives the client a clear, pollable resource to track progress against.
