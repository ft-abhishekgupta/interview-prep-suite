---
title: Beyond REST
description: Comparing GraphQL gRPC WebSockets and server-sent events against REST across schema streaming caching and tooling, with code and interview framing
difficulty: Core
tags: [api-design, graphql, grpc, websockets, real-time]
---

REST's request/response model quietly assumes three things: the client wants a fixed shape of data, the interaction is one request in and one response back, and a plain HTTP cache in front of it is useful. Plenty of real traffic breaks at least one of those assumptions — a mobile dashboard that needs wildly different fields per screen, an internal call where every microsecond of latency matters, or a feed that needs to keep pushing updates long after the request finished. GraphQL, gRPC, WebSockets and Server-Sent Events (SSE) each fix a different assumption; none of them replace REST wholesale, and knowing which one to reach for — and why — is exactly what separates "I've heard of GraphQL" from a defensible design decision.

## When each protocol wins

```mermaid
flowchart TD
    A["Client needs data from a service"] --> B{"Client must pick exact fields<br/>from varied, nested resources?"}
    B -->|"Yes"| C["GraphQL"]
    B -->|"No"| D{"Internal service-to-service,<br/>latency-critical, typed contract?"}
    D -->|"Yes"| E["gRPC"]
    D -->|"No"| F{"Server needs to keep<br/>pushing updates?"}
    F -->|"One-way only"| G["Server-Sent Events"]
    F -->|"Bidirectional, low latency"| H["WebSockets"]
    F -->|"No, plain request/response"| I["REST"]
```

| Dimension | REST | GraphQL | gRPC | WebSockets | SSE |
|---|---|---|---|---|---|
| Schema | Optional (OpenAPI) | Mandatory, strongly typed (SDL) | Mandatory, strongly typed (`.proto`) | None built-in — you define the message contract | None built-in — you define the event/data contract |
| Streaming | No — request/response only | Subscriptions (over WebSocket transport) | Native — unary, server, client, bidirectional | Native, full-duplex | Native, server-to-client only |
| Browser support | Native (`fetch`/`XHR`) | Native (POST over `fetch`/`XHR`) | No — needs grpc-web or Connect plus a proxy | Native (`WebSocket` API) | Native (`EventSource` API) |
| Tooling | Extremely mature — curl, Postman, gateways, CDNs | Mature — GraphiQL, Apollo/Relay, codegen | Mature but steeper — `protoc`, generated stubs | Moderate — you build your own protocol on top | Minimal — plain HTTP plus `EventSource` |
| Caching | Native HTTP caching (`ETag`, `Cache-Control`, CDNs) | Hard — single endpoint, everything is `POST` | Manual, connection-level | Not applicable — persistent connection | Not applicable — persistent connection |
| Payload size | Medium — JSON, often over-fetched | Medium — JSON, but only the requested fields | Small — binary Protobuf | Small — arbitrary framed payload | Medium — text-based, UTF-8 |
| Versioning | Mature conventions — URI or header | Additive schema evolution, deprecate fields | `.proto` field numbers, additive by convention | Custom message versioning | Custom event/data versioning |
| Best for | Public/partner CRUD APIs | Client-driven UIs with varied, nested data needs | Low-latency internal service-to-service calls | Bidirectional real-time (chat, games, collab) | One-way server push (notifications, feeds, AI streaming) |

> [!KEY]
> None of these protocols are a universal replacement for REST — each one trades away something REST gives you for free (caching, browser support, simplicity) in exchange for solving one specific problem (flexible queries, raw performance, or a persistent channel). Picking one is an admission that a specific traffic shape doesn't fit plain request/response, not a verdict that REST is outdated.

## GraphQL — one endpoint, client-chosen shape

GraphQL replaces many fixed REST endpoints with a single endpoint backed by a strongly-typed schema; the client sends a query describing exactly which fields it wants, across however many related types, and gets back exactly that shape — nothing more, nothing less.

```graphql
type User {
  id: ID!
  name: String!
  email: String!
}

type Query {
  user(id: ID!): User
}

type Mutation {
  createUser(name: String!, email: String!): User!
}
```

```graphql
query {
  user(id: "123") {
    name
    email
  }
}
```

In ASP.NET Core, HotChocolate is the standard GraphQL server: types map to plain C# classes, and queries/mutations are resolver methods.

```csharp
public class Query
{
    public Task<User?> GetUserAsync(string id, [Service] IUserService users) =>
        users.GetByIdAsync(id);
}

public class Mutation
{
    public Task<User> CreateUserAsync(string name, string email, [Service] IUserService users) =>
        users.CreateAsync(name, email);
}

// Program.cs
builder.Services
    .AddGraphQLServer()
    .AddQueryType<Query>()
    .AddMutationType<Mutation>();
```

### Error handling and partial data

A GraphQL response is almost always `200 OK` — success and failure both live in the body, which lets a client render the data it did get even when one field failed:

```json
{
  "data": { "user": null },
  "errors": [
    { "message": "User not found", "path": ["user"] }
  ]
}
```

### The N+1 problem

Resolving a list of parents and then a related field per item, one query at a time, is the GraphQL equivalent of REST's N+1 lazy-loading bug — except it's easier to trigger by accident, because a single query can traverse arbitrarily deep relationships. The fix is a batching loader that collects all the keys requested during one execution and fetches them in a single query:

```csharp
public class UserByIdDataLoader : BatchDataLoader<string, User>
{
    private readonly IUserService _users;
    public UserByIdDataLoader(IUserService users, IBatchScheduler scheduler) : base(scheduler) => _users = users;

    protected override async Task<IReadOnlyDictionary<string, User>> LoadBatchAsync(
        IReadOnlyList<string> keys, CancellationToken ct) =>
        (await _users.GetByIdsAsync(keys, ct)).ToDictionary(u => u.Id);
}
```

Field-level resolvers also mean authorization checks apply per field, not per endpoint — a `salary` field on `Employee` can require a different policy than `name`, which is more granular than REST's typical per-route `[Authorize]`, but means there's no single URL to lock down; every resolver has to defend itself.

![alt text](notes/05-HighLevelDesign/ApiDesign/Non-REST/image-1.png)

![alt text](notes/05-HighLevelDesign/ApiDesign/Non-REST/image.png)

> [!WARNING]
> An unbounded GraphQL schema lets a client write a query that nests relationships several levels deep and fans out exponentially (`user { friends { friends { friends { ... } } } }`). Enforce a query depth limit and/or a cost-analysis budget on the server — without one, a single client query can do more damage than any REST endpoint could.

## gRPC — typed, binary RPC for internal calls

gRPC is Google's RPC framework: services and messages are defined once in a `.proto` file, and the compiler generates strongly-typed client stubs and server base classes in every supported language, over HTTP/2 with Protobuf's compact binary encoding.

![alt text](notes/05-HighLevelDesign/ApiDesign/Non-REST/image-3.png)

```protobuf
syntax = "proto3";

service TicketService {
  rpc GetEvent (GetEventRequest) returns (Event);
  rpc StreamAvailability (GetEventRequest) returns (stream SeatUpdate);
}

message GetEventRequest { string event_id = 1; }
message Event { string id = 1; string name = 2; int64 date = 3; }
message SeatUpdate { string seat_id = 1; bool available = 2; }
```

![alt text](notes/05-HighLevelDesign/ApiDesign/Non-REST/image-52.png)

```csharp
public class TicketGrpcService : TicketService.TicketServiceBase
{
    public override async Task<Event> GetEvent(GetEventRequest request, ServerCallContext context)
    {
        var evt = await _repo.GetAsync(request.EventId);
        return new Event { Id = evt.Id, Name = evt.Name, Date = evt.Date };
    }

    public override async Task StreamAvailability(GetEventRequest request,
        IServerStreamWriter<SeatUpdate> responseStream, ServerCallContext context)
    {
        await foreach (var update in _repo.WatchSeatsAsync(request.EventId, context.CancellationToken))
            await responseStream.WriteAsync(update);
    }
}
// Program.cs: app.MapGrpcService<TicketGrpcService>();
```

| Streaming mode | Direction | Realistic use |
|---|---|---|
| Unary | One request, one response | `GetEvent(id)` |
| Server streaming | One request, stream of responses | Live seat availability updates |
| Client streaming | Stream of requests, one response | Uploading a batch of telemetry points |
| Bidirectional streaming | Both sides stream independently | Live chat carried over gRPC |

A frequent real architecture keeps REST facing the outside world and gRPC facing internal, high-performance calls between services:

![alt text](notes/05-HighLevelDesign/ApiDesign/Non-REST/image-2.png)

> [!DANGER]
> A browser cannot open a raw HTTP/2 gRPC connection — the browser networking stack doesn't expose the primitives gRPC needs. You either add grpc-web (a JavaScript shim plus a translating proxy) or expose a separate REST/GraphQL facade for browser clients and keep gRPC strictly server-to-server. Assuming your React app can call a gRPC service directly is a common and expensive design mistake to catch late.

## WebSockets — persistent, full-duplex

A WebSocket starts as a normal HTTP request, upgrades to a persistent TCP connection via a single handshake, and from then on either side can send a message at any time without the request/response back-and-forth REST requires.

![alt text](notes/05-HighLevelDesign/ApiDesign/Non-REST/image-27.png)

ASP.NET Core's SignalR is the standard abstraction over raw WebSockets (falling back to long polling automatically where WebSockets aren't available):

```csharp
public class ChatHub : Hub
{
    public async Task SendMessage(string user, string message) =>
        await Clients.All.SendAsync("ReceiveMessage", user, message);
}

// Program.cs
builder.Services.AddSignalR();
app.MapHub<ChatHub>("/hubs/chat");
```

## Server-Sent Events — one-way server push over plain HTTP

SSE is the simplest of the streaming options: the server keeps an ordinary HTTP response open and writes newline-delimited `data:` chunks to it; no upgrade handshake, no new protocol, and the browser's `EventSource` API handles reconnection automatically, resuming from the last event ID it saw.

```text
id: 1
data: {"id": 1, "timestamp": "2025-01-01T00:00:00Z", "description": "Event 1"}

id: 2
data: {"id": 2, "timestamp": "2025-01-01T00:00:01Z", "description": "Event 2"}
```

```csharp
app.MapGet("/events/{eventId}/seats", async (string eventId, HttpContext ctx, ISeatFeed feed) =>
{
    ctx.Response.Headers.Append("Content-Type", "text/event-stream");
    ctx.Response.Headers.Append("Cache-Control", "no-cache");

    await foreach (var update in feed.WatchAsync(eventId, ctx.RequestAborted))
    {
        await ctx.Response.WriteAsync($"id: {update.Id}\n");
        await ctx.Response.WriteAsync($"data: {JsonSerializer.Serialize(update)}\n\n");
        await ctx.Response.Body.FlushAsync();
    }
});
```

```mermaid
sequenceDiagram
    participant Client
    participant Server
    Note over Client,Server: WebSocket - full duplex
    Client->>Server: "Upgrade: websocket"
    Server-->>Client: "101 Switching Protocols"
    Client->>Server: "message"
    Server-->>Client: "message"
    Note over Client,Server: SSE - one-way only
    Client->>Server: "GET /events (Accept: text/event-stream)"
    Server-->>Client: "event, data"
    Server-->>Client: "event, data"
```

## A peer-to-peer aside — WebRTC

WebRTC is fundamentally different from the other four: after an initial signaling handshake (often carried over WebSockets), media or data flows **directly between browsers**, with no server in the data path at all, over UDP for low latency.

![alt text](notes/05-HighLevelDesign/ApiDesign/Non-REST/image-29.png)

| | WebSockets | SSE | WebRTC |
|---|---|---|---|
| Direction | Bidirectional | Server → client only | Peer-to-peer, bidirectional |
| Transport | TCP | TCP (plain HTTP) | UDP, with TCP/relay fallback |
| Reconnection | Manual | Automatic — browser resumes via `Last-Event-ID` | Manual — ICE renegotiation |
| Server in the data path | Yes, always | Yes, always | No, after signaling completes |
| Typical use | Chat, multiplayer games, live dashboards | Notifications, live feeds, AI token streaming | Video/audio calls, screen share, P2P file transfer |

> [!NOTE]
> Reach for WebRTC only when the data genuinely benefits from bypassing your server — real-time audio/video where round-tripping through a server would add unacceptable latency. For anything that also needs to be recorded, moderated or persisted server-side, a server-mediated channel (WebSockets, or media servers like an SFU) is usually the better trade-off despite the extra hop.

## Justifying the choice in an interview

The strongest answer names the traffic shape, not the technology's reputation. A useful script: *"This screen needs five different views of overlapping data with different fields per view, so I'd reach for GraphQL to avoid either N+1 REST calls or a bloated one-size-fits-all response. The pricing engine call between our order service and inventory service happens on every checkout and needs to be fast and strongly typed, so that's gRPC. The live order-tracking map needs the server to keep pushing location updates without the client polling, and it's one-way, so that's SSE rather than a full WebSocket."* Notice each sentence justifies the choice from the requirement (data shape, latency budget, direction of flow), never from "GraphQL is more modern" or "REST is legacy" — those framings signal you're pattern-matching on hype, not on the problem.

## Cheat sheet

- REST assumes fixed responses, one request/response cycle, and a cacheable GET — GraphQL, gRPC, WebSockets and SSE each break exactly one of those assumptions.
- GraphQL: one endpoint, client picks fields, mandatory schema, hard to cache, N+1 risk needs a batching DataLoader, depth/cost limits are mandatory.
- gRPC: `.proto` contract, HTTP/2 + Protobuf, four streaming modes, fastest for internal service-to-service calls, not directly callable from a browser.
- WebSockets: one handshake, then full-duplex messages either side, best for real-time bidirectional traffic (chat, games, collaborative editing).
- SSE: plain HTTP, one-way server push, automatic reconnection via `EventSource` and `Last-Event-ID`, simplest option for feeds and notifications.
- WebRTC: peer-to-peer after signaling, UDP, no server in the data path — reserve it for latency-critical audio/video, not general real-time data.
- Justify a protocol choice from the traffic shape (data variability, latency, direction), never from novelty.

## Common mistakes

| Mistake | Fix |
|---|---|
| Adopting GraphQL without a query depth or cost limit | Enforce depth limiting and query cost analysis from day one |
| Resolving related fields one at a time in GraphQL | Batch with a DataLoader so N+1 becomes a single query |
| Assuming a browser can call gRPC directly | Add grpc-web/Connect with a proxy, or expose a REST/GraphQL facade instead |
| Using WebSockets for a one-way feed | Use SSE — simpler, cacheable-adjacent infrastructure, automatic reconnection |
| Choosing a protocol because it's trendy rather than because of the traffic shape | Justify from schema needs, streaming direction and latency budget |
| Routing real-time audio/video through your own server by default | Consider WebRTC (direct peer-to-peer) before assuming a relay server is required |

## Summary

REST covers the majority of API traffic well, but four specific shapes break its assumptions: client-driven, varied data needs (GraphQL), low-latency strongly-typed internal calls (gRPC), persistent bidirectional channels (WebSockets), and one-way server push (SSE) — with WebRTC as a peer-to-peer specialization for latency-critical media. None of them are a wholesale replacement; each trades away something REST gives for free — caching, browser-nativeness, simplicity — to solve one problem precisely. The interview-winning move is naming the traffic shape that drove the choice — schema flexibility, latency budget, or push direction — rather than treating any of these as inherently superior to REST.

## Top Interview Questions

### Q1. Why doesn't a single API style fit every use case, and what specifically does REST assume that breaks down?

REST assumes the client wants a fixed response shape per endpoint, that one request always gets exactly one response, and that a plain HTTP cache in front of the API is useful. Those assumptions hold for the majority of CRUD-style traffic, but break down for a client that needs wildly different fields from the same resources on different screens (GraphQL), for a call where every microsecond and a strict typed contract matter more than human-readability (gRPC), and for anything where the server needs to keep talking after the initial response (WebSockets, SSE). Each alternative protocol exists to fix exactly one of those broken assumptions, not to replace REST everywhere.

### Q2. What is the N+1 problem in GraphQL, and how do you fix it in a .NET GraphQL server?

Resolving a list of parent objects and then independently resolving a related field for each one triggers one query per parent instead of one query for the whole batch — a list of 50 orders each independently resolving their `customer` field issues 51 queries instead of 2. It's easier to trigger in GraphQL than in REST because a single client query can traverse arbitrarily deep, arbitrary relationships that the server author didn't anticipate. The fix in HotChocolate (or any GraphQL server) is a batching data loader — implement `BatchDataLoader<TKey, TValue>` so that all the keys requested during one query execution are collected and fetched in a single batched call, then handed back per-key from an in-memory dictionary.

### Q3. Why is GraphQL often summarized as "everything is a POST that returns 200," and what does that cost you?

Nearly every GraphQL operation — queries and mutations alike — goes to a single endpoint via `POST`, and the response is almost always `200 OK` even when part of the requested data failed to resolve, with success/failure information living inside the response body's `data`/`errors` fields instead of the HTTP status line. This costs you REST's free HTTP-native caching: browsers, CDNs and reverse proxies key their caching logic off the method (`GET` being cacheable) and the URL, and a single `POST` endpoint gives them nothing to key on, so GraphQL responses typically need a bespoke, application-level caching layer instead of falling out of standard HTTP infrastructure.

### Q4. Why can't a browser call a gRPC service directly, and what are the workarounds?

Browsers don't expose the low-level HTTP/2 trailer and framing primitives gRPC's wire protocol depends on — the `fetch`/XHR APIs available to JavaScript simply don't offer that level of control. The standard workaround is grpc-web, a JavaScript client library paired with a translating proxy (like Envoy) that converts grpc-web's browser-compatible requests into real gRPC calls to your backend, or the newer Connect protocol which is designed to be both a gRPC-compatible and plain-HTTP/JSON-compatible wire format from the start. Many teams sidestep this entirely by keeping gRPC strictly internal (service-to-service) and exposing a separate REST or GraphQL facade for anything a browser needs to call.

### Q5. What are the four gRPC streaming modes, and give a realistic use case for each?

Unary is a single request and single response, the gRPC equivalent of a normal REST call (`GetEvent(id)`). Server streaming sends one request and gets back a stream of responses over time, useful for something like live seat-availability updates for an event. Client streaming is the reverse — a stream of requests and a single final response — a good fit for uploading a batch of telemetry data points that only need one acknowledgement at the end. Bidirectional streaming lets both sides send messages independently over the same long-lived call, which is how you'd implement something like live chat carried over gRPC instead of WebSockets, when the rest of your service mesh is already gRPC-native.

### Q6. Why does gRPC typically outperform REST-over-JSON for internal service-to-service calls?

gRPC runs over HTTP/2, which multiplexes many concurrent requests over a single TCP connection instead of REST's typical HTTP/1.1 pattern of one connection (or a small pool) handling requests somewhat serially, cutting connection-setup overhead when a service makes many calls to another. It also serializes payloads as binary Protobuf rather than text-based JSON, which is both smaller on the wire and faster to encode/decode since there's no string parsing or dynamic type inspection involved. Combined with a compiler-generated, strongly-typed contract that catches shape mismatches at build time rather than at runtime, gRPC's overhead per call is meaningfully lower — which matters when a single user-facing request fans out into a dozen internal service-to-service calls.

### Q7. When would you choose Server-Sent Events over WebSockets, given that WebSockets can do everything SSE can and more?

Choose SSE whenever the data only needs to flow one way, from server to client — notifications, live activity feeds, streaming LLM tokens back to a UI — because SSE needs no special upgrade handshake, works over plain HTTP (so it survives more corporate proxies and load balancers unmodified), and gives you automatic reconnection with last-event resumption for free via the browser's `EventSource` API, none of which you get with WebSockets without writing it yourself. WebSockets are the right choice specifically when the client also needs to send messages back over the same channel with low latency (chat, multiplayer games) — reaching for a WebSocket for a one-way feed adds bidirectional complexity (and a stateful connection to manage) you'll never use.

### Q8. How does a browser's EventSource recover from a dropped SSE connection, and what does the server need to do to support it correctly?

The `EventSource` API automatically attempts to reconnect after a connection drop without any client-side code, and it includes a `Last-Event-ID` header on the reconnection request carrying the `id:` field of the last event it successfully received. For this to actually prevent data loss, the server has to assign a durable, ordered ID to every event it sends and, on reconnection, use the incoming `Last-Event-ID` header to resume the stream from the event right after that ID rather than restarting from the current moment — which typically means the event source needs to be backed by something replayable (a persisted log or a queue with a cursor), not just an in-memory push with no history.

### Q9. What's the fundamental difference between WebRTC and WebSockets, and when would you actually reach for WebRTC?

A WebSocket connection always has your server in the data path — every message from one client to another is relayed through the server. WebRTC uses a signaling step (commonly over WebSockets or HTTP) purely to let two peers discover each other's network address and negotiate a connection, after which the actual media or data flows directly between the two browsers over UDP, with no server relaying the payload. Reach for WebRTC specifically when the data is latency-sensitive real-time audio or video (a call, a game with strict input latency requirements) where routing every frame through your server would add unacceptable delay — for anything that also needs to be recorded, moderated, or fanned out to many viewers, a server-mediated approach (WebSockets, or a media server acting as an SFU) is usually the more practical trade-off.

### Q10. How do you version a GraphQL schema, given there's no URL path segment the way REST has `/v1` and `/v2`?

GraphQL's convention is additive, evolutionary schema change instead of parallel versions: you add new fields and types without removing old ones, and mark fields you want to phase out with the built-in `@deprecated` directive so tooling (and IDE autocomplete) surfaces the warning to consumers without breaking them. Because clients explicitly request only the fields they use, adding fields is inherently non-breaking, and even removing a field can be done safely once usage telemetry on that field's resolver shows no client is still requesting it — there's no separate `/v2` endpoint to stand up in parallel the way a REST API would need for a genuinely breaking change.

### Q11. You're designing the API layer for a food-delivery app: a live driver-tracking map, a menu-browsing screen with wildly different detail levels per screen, and checkout calling an internal pricing service. Which protocol fits each, and why?

The menu-browsing screens are the textbook GraphQL case — a list view needs five fields per item, a detail view needs forty, and both read from the same underlying menu-item type, so a single flexible query avoids either building N tailored REST endpoints or over-fetching on the list view. The internal checkout-to-pricing-service call is gRPC territory: it's service-to-service, latency-sensitive (it's on the critical path of every checkout), and benefits from a strongly-typed contract that catches a mismatched field between the two services at compile time. The live driver-tracking map needs the server to keep pushing location updates without the client polling, and the data only flows one way (server to map), so that's Server-Sent Events rather than a full-duplex WebSocket the client doesn't need.

### Q12. How would you justify choosing gRPC over REST to a team worried about losing curl-based debuggability?

I'd acknowledge the trade-off honestly rather than dismiss it — you do lose the ability to poke an endpoint with plain curl and read a human-readable response, and that's a real cost during incident response. I'd justify gRPC anyway for calls where the volume and latency sensitivity make the performance gain (HTTP/2 multiplexing, binary Protobuf, generated typed clients) worth more than ad hoc debuggability, and mitigate the loss concretely: tools like `grpcurl` restore a curl-like command-line experience for gRPC, server reflection lets you introspect the service without needing the `.proto` file on hand, and structured logging/tracing at the application layer (not the wire protocol) is what most incident response actually depends on day to day anyway, not raw wire-level readability.
