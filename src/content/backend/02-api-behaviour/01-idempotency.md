---
title: Idempotency
description: Why idempotency matters for safe retries, how idempotency keys work end to end, and handling concurrent duplicate requests correctly
difficulty: Advanced
tags: [idempotency, api-design, reliability, distributed-systems]
---

Networks fail in the worst possible place — after the server processed a request but before the client received the response. When that happens the client cannot tell success from failure, and its only reasonable option is to retry. Idempotency is what makes that retry safe instead of dangerous, and it's a favourite interview topic because it forces you to reason about state, concurrency and failure together.

## Definition and why it matters

An operation is idempotent if performing it multiple times has the same effect as performing it once. For naturally idempotent operations (`GET`, `PUT`, `DELETE`), retries are free — call them as many times as you like. For inherently non-idempotent operations (`POST /payments`, "charge this card", "send this email"), a naive retry after a timeout can duplicate the side effect: charge twice, send the email twice, create two orders from one click.

> [!KEY]
> The failure mode isn't "the request failed" — it's "the client doesn't know whether it succeeded." A client that assumes failure and retries a non-idempotent `POST` is the single most common cause of duplicate side effects in distributed systems.

## Which HTTP methods are naturally idempotent

| Method | Idempotent | Why |
|---|---|---|
| `GET`, `HEAD`, `OPTIONS` | Yes | Safe — no state change at all |
| `PUT` | Yes | Replaces the resource with the same representation each time |
| `DELETE` | Yes | Deleting an already-deleted resource is a no-op end state |
| `POST` | No | Creates a new resource or triggers an action each call, by default |
| `PATCH` | Depends | Idempotent if it sets absolute values; not if it applies a relative delta |

`POST` is the method that needs deliberate idempotency engineering — it is the one used for "create a resource" and "trigger an action," both of which are dangerous to duplicate.

## Idempotency keys

The client generates a unique key **per logical operation** (not per HTTP attempt) and sends it with the request. The server stores the key alongside the outcome of the first execution, and returns that stored outcome on any retry with the same key, instead of re-executing the operation.

```http
POST /payments HTTP/1.1
Idempotency-Key: 6f2a9e39-9d1a-4e2a-9c3b-9a1e6c9f0a11
Content-Type: application/json

{ "amount": 4999, "currency": "USD", "orderId": "ORD-2201" }
```

- **Client-generated**: a UUID created once when the user clicks "Pay," reused on every retry of *that* click — never regenerated on retry.
- **Stored with the response**: the server persists `(key, requestHash, statusCode, responseBody, createdAt)` so a retry returns the exact original response.
- **TTL**: keys expire after a bounded window (commonly 24 hours) — long enough to cover realistic retry storms, short enough to bound storage growth.

> [!TIP]
> Store a hash of the request body alongside the key. If the same key arrives with a *different* body, that's a client bug (reusing a key for a different logical operation) — reject it with `422` rather than silently returning the first response for a different request.

## The double-charge scenario, end to end

```mermaid
sequenceDiagram
    participant Client
    participant Server
    participant PaymentGateway
    Client->>Server: POST /payments<br/>Idempotency-Key: K1
    Server->>PaymentGateway: Charge card
    PaymentGateway-->>Server: Success
    Server-->>Client: 200 OK (connection drops before this arrives)
    Note over Client: Times out, assumes failure
    Client->>Server: POST /payments<br/>Idempotency-Key: K1 (retry)
    Server->>Server: Look up K1 → already completed
    Server-->>Client: 200 OK (stored response, no re-charge)
```

Without the key, the retry would call the payment gateway a second time, charging the customer twice. With the key, the server recognizes the retry before it ever reaches the gateway and replays the stored result.

## Concurrent duplicate requests

A subtler case: two requests with the *same* idempotency key arrive **at the same time** (double-click, or a client retrying just as the first attempt is still processing). If both read "no existing record" before either writes one, both could proceed and both could charge the card.

Two reliable fixes:

| Approach | How it works |
|---|---|
| Unique constraint | `UNIQUE (idempotency_key)` on the storage table; insert a "processing" row first, and let the database reject the second concurrent insert with a constraint violation, which the server maps to "wait and return the first result" |
| Distributed lock | Acquire a lock keyed on the idempotency key (Redis `SET NX` with a TTL) before executing; the second request blocks or fails fast, then reads the completed result once the first finishes |

> [!WARNING]
> A plain "check if key exists, then insert" without a unique constraint or lock has a race condition — two concurrent requests can both pass the check before either inserts. The uniqueness must be enforced atomically at the storage layer, not in application code with a read-then-write sequence.

## At-least-once delivery and idempotent consumers

The same problem appears without HTTP at all: message queues (SQS, Service Bus, Kafka) commonly guarantee **at-least-once delivery** — a consumer can receive the same message twice if it crashes after processing but before acknowledging. The fix is identical in spirit: track a unique message ID (or a business-level dedup key) and make the consumer's handler a no-op on a message it has already processed.

```mermaid
flowchart LR
    Q["Queue<br/>(at-least-once)"] --> C["Consumer"]
    C --> D{"Message ID<br/>seen before?"}
    D -->|"Yes"| S["Skip, ack"]
    D -->|"No"| P["Process + record ID"]
    P --> S
```

## Idempotency vs deduplication

These are related but distinct: **idempotency** is a property of the *operation* (calling it twice is safe by design, e.g., `PUT`, or via an idempotency key). **Deduplication** is a mechanism that *detects and discards* repeated inputs (a message ID already seen, a request hash already processed) before they reach non-idempotent logic. In practice, idempotency keys are a form of deduplication applied specifically to API requests — the terms often get used interchangeably, but "dedup" is the broader concept and also applies to event streams, file ingestion, and batch jobs.

## Storage design for an idempotency table

| Column | Purpose |
|---|---|
| `idempotency_key` (PK, unique) | The client-supplied key |
| `request_hash` | Detects a key reused for a different request body |
| `status` | `processing` / `completed` / `failed` |
| `response_status_code`, `response_body` | Replayed verbatim on retry |
| `created_at`, `expires_at` | TTL-based cleanup |
| `locked_until` (optional) | Lease for in-flight requests, to avoid a stuck "processing" row blocking retries forever |

## C# middleware sample

```csharp
public class IdempotencyMiddleware
{
    private readonly RequestDelegate _next;
    private readonly IIdempotencyStore _store;

    public IdempotencyMiddleware(RequestDelegate next, IIdempotencyStore store)
    {
        _next = next;
        _store = store;
    }

    public async Task InvokeAsync(HttpContext context)
    {
        if (context.Request.Method != HttpMethods.Post ||
            !context.Request.Headers.TryGetValue("Idempotency-Key", out var key))
        {
            await _next(context);
            return;
        }

        var bodyHash = await HashBodyAsync(context.Request);
        var existing = await _store.TryGetAsync(key!, bodyHash); // atomic get-or-reserve
        if (existing is { Status: "completed" })
        {
            context.Response.StatusCode = existing.ResponseStatusCode;
            await context.Response.WriteAsync(existing.ResponseBody);
            return;
        }
        if (existing is { Status: "processing" })
        {
            context.Response.StatusCode = 409; // still in flight, tell the client to wait
            return;
        }

        var buffer = new MemoryStream();
        var originalBody = context.Response.Body;
        context.Response.Body = buffer;

        await _next(context); // run the real handler

        buffer.Seek(0, SeekOrigin.Begin);
        var responseText = await new StreamReader(buffer).ReadToEndAsync();
        await _store.SaveResultAsync(key!, bodyHash, context.Response.StatusCode, responseText);

        buffer.Seek(0, SeekOrigin.Begin);
        await buffer.CopyToAsync(originalBody);
    }
}
```

The `TryGetAsync` call must atomically insert a "processing" placeholder row (relying on the unique constraint on `idempotency_key`) so a concurrent duplicate fails fast with 409 instead of racing through to the handler.
`HashBodyAsync` must enable request buffering and rewind `context.Request.Body` before `_next(context)` runs; otherwise the middleware would consume the body and leave the real endpoint with an empty stream.

## Cheat sheet

- Idempotent = calling it N times has the same effect as calling it once; naturally true for `GET`, `PUT`, `DELETE`, not for `POST`.
- Idempotency keys are client-generated, reused across retries of the *same* logical operation, and stored with the original response for replay.
- Give idempotency records a bounded TTL (hours, not forever) to control storage growth.
- Hash the request body alongside the key to catch key reuse for a *different* request.
- Prevent concurrent duplicates with a database unique constraint or a distributed lock — never a plain read-then-write check.
- At-least-once message delivery needs the same idea: an idempotent consumer keyed on message ID.
- Idempotency is a property of an operation; deduplication is the broader mechanism that enforces it.
- 409 is a reasonable response for "this idempotency key is still being processed, try again shortly."

## Common mistakes

| Mistake | Fix |
|---|---|
| Generating a new idempotency key on every retry | Generate once per logical user action, reuse it across retries |
| Checking "does this key exist" then inserting, with no atomicity | Use a unique DB constraint or distributed lock to make the check-and-reserve atomic |
| No TTL on idempotency records | Expire them (e.g., 24h) to bound storage growth |
| Treating idempotency keys as a substitute for authentication/authorization | They only dedupe; auth checks still run every time |
| Assuming `PATCH` is always idempotent | Only true if it sets absolute values, not for relative deltas |
| Ignoring idempotency in message consumers because "HTTP isn't involved" | At-least-once queues have the exact same duplicate-delivery problem |

## Summary

Idempotency exists because clients cannot always tell whether a request they sent actually succeeded, and the only safe response to that uncertainty is a retry that is guaranteed not to duplicate the effect. Idempotency keys solve this for non-idempotent operations like payments by having the client generate a stable key per logical action, and having the server store and replay the first outcome on any retry. The subtle failure mode to defend against is concurrent duplicates racing each other before either has recorded an outcome — solved with a database unique constraint or distributed lock, never a plain check-then-write. The same pattern, generalized, is what makes message consumers safe under at-least-once delivery.

## Top Interview Questions

### Q1. What does it mean for an operation to be idempotent, and why does it matter for API design?

An operation is idempotent if executing it multiple times produces the same end state as executing it exactly once — repeating it causes no additional effect beyond the first successful application. It matters because networks are unreliable: a client can send a request, the server can fully process it, and the response can be lost before the client sees it, leaving the client unable to distinguish "it failed" from "it succeeded but I never heard back." If the operation is idempotent, the client's only reasonable recovery — retry — is always safe; if it isn't, a retry risks duplicating a side effect like a payment charge or an order creation.

### Q2. Which HTTP methods are idempotent by definition, and why isn't POST one of them?

`GET`, `HEAD`, `PUT`, `DELETE` and `OPTIONS` are idempotent by the HTTP specification's contract — `GET` doesn't change state at all, `PUT` replaces a resource with the same representation regardless of how many times it's sent, and `DELETE` leaves the same end state (resource gone) whether called once or five times. `POST` is defined as "create a new resource or process according to the resource's own semantics," which inherently means each call is meant to potentially produce a new effect — calling `POST /orders` twice is supposed to create two orders, so idempotency for POST-driven operations has to be engineered deliberately, typically via an idempotency key.

### Q3. Walk me through how an idempotency key prevents a double charge on a flaky network.

The client generates a unique key when the user initiates the payment (say, a UUID created on button click) and sends it in an `Idempotency-Key` header alongside the payment request. The server, before charging anything, checks if that key already has a stored result; if not, it charges the card and stores the outcome (status code and body) keyed by that value. If the client's connection drops before it receives the response, it retries with the *same* key rather than generating a new one — the server sees the key already has a completed result and returns that stored response directly, without calling the payment gateway again, so the card is only ever charged once regardless of how many times the client retries.

### Q4. What request-level detail should be stored alongside an idempotency key, and why?

Beyond the key itself, store a hash of the request body, the resulting status code, the full response body, and timestamps for creation and expiry. The request-body hash guards against a subtle client bug: reusing the same idempotency key for what is actually a *different* logical request (e.g., a different amount) — if the incoming hash doesn't match the stored one for that key, the server should reject the request (422) rather than silently replaying an unrelated stored response. The stored response itself is what makes replay possible: the retry gets back the exact original status code and body, so it's indistinguishable from having received the first response directly.

### Q5. Two identical requests with the same idempotency key arrive at nearly the same instant, before either has completed. What goes wrong with a naive implementation, and how do you fix it?

A naive implementation checks "does a record exist for this key" and, finding none, proceeds to execute the operation and insert a record afterward — but if two requests both perform that check before either has inserted anything, both see "no record" and both proceed, defeating the whole point of the key and potentially double-charging. The fix is to make the check-and-reserve step atomic: insert a "processing" placeholder row protected by a unique database constraint on the key, so the second concurrent request's insert fails immediately with a constraint violation that the server maps to "already in flight, return 409 or wait," or use a distributed lock (e.g., Redis `SET key value NX PX <ttl>`) acquired before the operation begins.

### Q6. Should idempotency keys have an expiry? What happens if they don't?

Yes — without a TTL, the idempotency store grows without bound forever, since every unique key from every client action accumulates indefinitely, eventually becoming a storage and query-performance problem. A bounded TTL (commonly on the order of 24 hours) is long enough to cover realistic retry windows — network partitions, client crashes and restarts, mobile app backgrounding — while keeping the table's size proportional to recent traffic rather than all-time traffic. After expiry, a key can be safely reused or a new request with that same value would simply be treated as a fresh operation.

### Q7. What's the difference between idempotency and deduplication?

Idempotency is a property of an *operation*: it's safe to call it more than once because doing so has no additional effect beyond the first call — this can be inherent (like `PUT`) or engineered (an idempotency key on `POST`). Deduplication is the broader mechanism of *detecting and discarding repeated inputs* before they reach processing logic — it's the technique, not the guarantee. An idempotency key is really deduplication applied specifically at the API layer; the same underlying idea (track an ID, skip if already seen) shows up in message consumers, batch ETL jobs, and file ingestion pipelines that have nothing to do with HTTP.

### Q8. How does at-least-once message delivery relate to idempotency, and how do you build an idempotent consumer?

Most message queues (SQS, Azure Service Bus, Kafka with default settings) guarantee at-least-once delivery: if a consumer crashes or times out after processing a message but before acknowledging it, the broker will redeliver that same message. Without protection, the consumer processes it twice — the exact same class of problem as a retried `POST`. An idempotent consumer records a unique identifier for each message it has successfully processed (the message ID, or a business-level key like an order ID) before or atomically with the side effect, and checks that record on every delivery — if the ID has already been processed, it acknowledges and skips rather than reprocessing.

### Q9. A teammate suggests making the idempotency key optional, defaulting to "generate one on the server if the client doesn't send it." What's wrong with this?

If the server generates the key, it can't detect a retry at all — a fresh server-generated key on every request means every retry looks like a brand-new operation, defeating the entire purpose. The key's value comes specifically from being *client-generated and stable across retries of the same logical action*; only the client knows "this is the third attempt at the same button click" versus "this is a genuinely new request." Making it optional is reasonable for less risky operations, but for anything with a real side effect (payments, order creation, sending irreversible communications) the key should be required, and the client SDK should be responsible for generating and persisting it across retry attempts.

### Q10. How would you decide which endpoints in your API need idempotency key support?

Any non-idempotent operation (effectively, most `POST` endpoints) with a side effect that's expensive, irreversible, or user-facing to duplicate is a candidate: payments, order creation, sending emails/SMS, provisioning resources. Endpoints that are naturally idempotent (`PUT`, `DELETE`) or where accidental duplication is cheap and harmless (e.g., a `POST` that just logs an analytics event) usually don't need the added complexity. A good heuristic in an interview: ask "if this executed twice by accident, would anyone notice or care, and how expensive would it be to fix afterward?" — the more expensive the answer, the stronger the case for an idempotency key.

### Q11. In production, you notice the idempotency store's unique-constraint violations are spiking. What would you investigate?

A spike in constraint violations means many requests are arriving with a key that's already in progress or completed, which could be benign (client-side retry logic firing more often, e.g., because of increased network flakiness or an increase in client-side timeouts triggering more retries) or a symptom of a real problem (a client bug generating the same key across genuinely different user actions, a load balancer or proxy duplicating requests, or an upstream timeout that's set too aggressively relative to the operation's actual latency, so clients retry before the first attempt could plausibly have finished). I'd check request latency against the client's configured timeout first, since a timeout shorter than typical processing time is the most common root cause of "the client thinks it failed but it didn't."

### Q12. How would you extend idempotency key support to work correctly across multiple service replicas behind a load balancer?

The idempotency store (and any lock used to guard concurrent duplicates) must be a shared, external resource visible to every replica — typically the same database or a shared Redis instance the whole fleet talks to — never in-memory state local to one instance, since the retry could easily land on a different replica than the original request. The unique-constraint-or-lock approach described earlier already generalizes to this: as long as all replicas check and reserve keys against the same shared store, it doesn't matter which instance handles the retry, because the coordination happens at the data layer, not the application instance.
