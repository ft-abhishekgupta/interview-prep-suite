---
title: Serialization and Data Formats
description: How to choose between JSON, Protobuf, Avro and friends, the schema evolution rules that keep systems compatible, and the security traps in deserialisation
difficulty: Core
tags: [serialization, json, protobuf, dotnet]
---

Serialization decisions look small in the moment — "just use JSON" — but they quietly determine how easily two services can evolve independently, how much a payload costs to move over the wire, and whether a deserialiser becomes an attack surface. Interviewers use this topic to see if you think about data contracts, not just syntax.

## Comparing the major formats

| Format | Size | Speed | Schema | Human readable | Evolution support | Tooling |
|---|---|---|---|---|---|---|
| JSON | Medium | Medium | Optional (JSON Schema) | ✅ Yes | Manual discipline (additive fields) | Universal |
| XML | Large | Slow | Optional (XSD) | ✅ Yes | Manual discipline, verbose | Universal, mature |
| Protobuf | Small (binary) | Fast | Required (`.proto`) | ❌ No | Built-in (field numbers, optional/reserved) | Strong (gRPC ecosystem) |
| Avro | Small (binary) | Fast | Required, schema travels with data or registry | ❌ No | Strong (reader/writer schema resolution) | Strong in big-data/Kafka ecosystems |
| MessagePack | Small (binary) | Fast | Optional | ❌ No | Manual discipline, like JSON | Good, less universal than JSON |
| CSV | Small (text) | Fast to parse, naive format | None | ✅ Yes | None — brittle to column changes | Universal but primitive |

> [!KEY]
> There is no universally "best" format — the right choice depends on whether you need human debuggability (JSON/XML), wire efficiency (Protobuf/Avro/MessagePack), or neither and just tabular simplicity (CSV). Naming this trade-off explicitly is the senior answer.

## Text vs binary trade-offs

Text formats (JSON, XML, CSV) are debuggable with your eyes — you can open a payload in a text editor, `curl` an endpoint and read the response, or diff two versions in source control. They pay for this with larger size (numbers as digit strings, repeated field names) and slower parsing (tokenising text vs reading fixed-width binary fields). Binary formats (Protobuf, Avro, MessagePack) are compact and fast to parse, but opaque — you need the schema and a tool to make sense of a captured payload, which slows down debugging and incident response. A common middle ground: use JSON at the edge (public APIs, browser-facing) where debuggability and universal tooling matter most, and a binary format internally between trusted services where volume and latency matter more than human readability.

## Schema evolution rules

Systems change independently — a producer service ships before a consumer upgrades, or vice versa — so the format needs rules for what changes are safe.

| Format | Safe changes | Unsafe changes |
|---|---|---|
| Protobuf | Add a new optional field with a new number; add values to an enum | Reusing a field number for a different meaning; changing a field's type |
| Avro | Add a field with a default value; remove a field that had a default | Removing a field with no default; changing a field's type incompatibly |
| JSON (by convention) | Add a new field (ignored by old consumers); make a field optional | Renaming a field; changing a field's type; removing a field consumers depend on |

> [!TIP]
> The senior framing for any format: additive changes are safe, changes that alter the *meaning* of existing data (renaming, retyping, reusing an identifier) are not. Protobuf and Avro make this a first-class, enforced concept; JSON relies entirely on team discipline and contract tests.

## System.Text.Json vs Newtonsoft.Json

.NET shipped `System.Text.Json` (STJ) as a faster, lower-allocation, built-in alternative to the long-dominant `Newtonsoft.Json` (Json.NET). Both are common in real codebases, and interviewers like asking about the migration gotchas.

| Gotcha | Newtonsoft default | System.Text.Json default |
|---|---|---|
| Property casing | Flexible name matching and configurable contract resolver | Library default is case-sensitive and writes C# casing; ASP.NET Core web defaults use camelCase and case-insensitive reads |
| Polymorphic serialization | Supported out of the box (`TypeNameHandling`) | Requires explicit `[JsonDerivedType]`/`JsonPolymorphic` (added in .NET 7+) |
| Circular references | Configurable (`ReferenceLoopHandling`) | Throws by default; needs `ReferenceHandler.Preserve` |
| `DateTime` handling | Flexible, some implicit conversions | Strict ISO 8601 by default; less forgiving of odd formats |
| Culture sensitivity | Can be culture-sensitive for numbers | Always culture-invariant |

```csharp
// System.Text.Json — explicit options are usually required to match legacy Newtonsoft behaviour
var options = new JsonSerializerOptions {
    PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    ReferenceHandler = ReferenceHandler.Preserve, // handle circular object graphs
    DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
};
var json = JsonSerializer.Serialize(order, options);
```

> [!WARNING]
> Migrating from Newtonsoft to STJ without checking polymorphism and circular-reference handling is a classic source of silent production bugs — code that compiled and passed unit tests can throw at runtime the first time it hits a real circular graph or a polymorphic payload it never exercised in tests.

## Compression and when it pays

Compressing a payload trades CPU for bandwidth. It's almost always worthwhile for large text payloads (JSON/XML responses in the tens of KB or more) where network transfer time dominates CPU time, and usually skipped for small payloads (a few hundred bytes) where compression overhead and header cost can exceed the savings, or for already-compressed binary data (images, video, already-compressed Protobuf-encoded blobs) where there's little redundancy left to remove.

## Versioning payloads

Two broad strategies: **additive/backward-compatible evolution** (never remove or repurpose a field; consumers ignore fields they don't recognise) keeps a single schema alive indefinitely and is what Protobuf/Avro are built around; **explicit versioning** (a version field or a versioned endpoint/topic, `/v2/orders`) is needed when a change is genuinely breaking (a field's meaning changes, a required field is added) and old and new consumers must be served different shapes simultaneously during a migration window.

## Big payloads: streaming vs buffering

Buffering (load the whole payload into memory, then process) is simple but doesn't scale to very large payloads — a multi-gigabyte export can exhaust memory or add unacceptable latency before the first byte is even usable. Streaming (process data as it arrives, in chunks) keeps memory bounded and lets a consumer start acting on the first records before the rest have even arrived, at the cost of more complex code (partial-record handling, backpressure).

```csharp
// Buffering — simple, but loads the entire payload into memory at once
var orders = JsonSerializer.Deserialize<List<Order>>(await response.Content.ReadAsStringAsync());

// Streaming — bounded memory, processes one order at a time as it's read
await using var stream = await response.Content.ReadAsStreamAsync();
await foreach (var order in JsonSerializer.DeserializeAsyncEnumerable<Order>(stream)) {
    Process(order);
}
```

## The claim-check pattern for large messages

Message brokers and queues typically enforce a maximum message size (Kafka defaults to 1MB, many cloud queues cap at 256KB-1MB). The **claim-check pattern** solves this: instead of putting a large payload directly on the queue, upload it to object storage (e.g. blob storage/S3) and put only a small reference (a "claim check" — a URL or object key) on the queue. Consumers read the reference and fetch the actual payload from storage, keeping the message bus fast and lightweight while still supporting arbitrarily large data.

```mermaid
flowchart LR
    P["Producer"] --> S[("Object storage")]
    P --> Q["Message queue<br/>(small reference only)"]
    Q --> C["Consumer"]
    C --> S
```

## Canonical data models

When multiple services or teams produce and consume overlapping data, a **canonical data model** — one agreed-upon shape for a concept like "Customer" or "Order" — avoids an N×N explosion of point-to-point translation logic between every pair of services. The trade-off is real: a canonical model is a shared contract that's harder to change unilaterally, and it can accumulate fields that only some consumers care about. It pays off most at integration boundaries (an enterprise service bus, a shared event schema in Kafka) where many producers and consumers need one common vocabulary.

## Security risks of deserialisation

Deserialising untrusted input is a genuine, historically exploited attack surface. Formats or libraries that support **polymorphic deserialisation based on a type name embedded in the payload** (like Newtonsoft's `TypeNameHandling.Auto` or Java's native serialization) can be tricked into instantiating arbitrary types an attacker chooses, sometimes leading to remote code execution via "gadget chains" — sequences of otherwise-harmless classes whose constructors or property setters chain into dangerous behaviour when combined.

> [!DANGER]
> Never enable `TypeNameHandling.Auto` (or equivalent "trust the type name in the payload" settings) on data that comes from outside your trust boundary. If polymorphism is genuinely required, use an explicit allow-list of known types rather than letting the payload dictate what to instantiate.

## Cheat sheet

- No format is universally best — trade off human readability against wire size and parse speed.
- Text formats (JSON/XML/CSV) are debuggable; binary formats (Protobuf/Avro/MessagePack) are compact and fast.
- Protobuf/Avro make schema evolution a first-class concept; JSON relies on team discipline.
- Additive changes are safe; renaming, retyping, or reusing a field/number is not.
- STJ vs Newtonsoft gotchas: casing defaults, polymorphism support, circular references, strict `DateTime`, culture-invariance.
- Compression pays off for large text payloads; skip it for tiny or already-compressed ones.
- Version explicitly when a change is genuinely breaking; stay additive otherwise.
- Stream large payloads instead of buffering them fully in memory.
- Claim-check pattern: put a reference on the queue, the actual blob in object storage.
- Never enable type-name-based polymorphic deserialisation on untrusted input.

## Common mistakes

| Mistake | Fix |
|---|---|
| Renaming a JSON field consumers depend on | Add the new field alongside the old one, deprecate, then remove after a migration window |
| Enabling `TypeNameHandling.Auto` on external input | Use an explicit type allow-list, or avoid polymorphic deserialisation of untrusted data entirely |
| Buffering a multi-GB payload fully in memory | Stream it — process records as they arrive |
| Assuming STJ and Newtonsoft behave identically | Explicitly configure casing, polymorphism, and reference handling when migrating |
| Putting large blobs directly on a message queue | Use the claim-check pattern — reference in the queue, payload in object storage |
| Compressing tiny payloads "for consistency" | Only compress where the payload is large enough for savings to outweigh overhead |

## Summary

Choosing a serialization format is a trade-off between human debuggability, wire size, parse speed, and how strictly the format enforces schema evolution — Protobuf and Avro bake evolution rules in, while JSON and XML rely on team discipline. In .NET, migrating between Newtonsoft and `System.Text.Json` requires explicitly checking casing, polymorphism, circular references, and `DateTime` handling, since the defaults differ in ways that only surface at runtime. For large payloads, prefer streaming over buffering and the claim-check pattern over oversized queue messages, and treat any type-name-driven polymorphic deserialisation of untrusted input as a security risk, not a convenience feature.

## Top Interview Questions

### Q1. How would you choose between JSON and Protobuf for a new service-to-service API?

I'd weigh debuggability against efficiency. JSON is human-readable, universally tooled, and easy to debug with `curl` and a text editor — a strong default for public APIs or when both producer and consumer teams need to inspect payloads quickly during development or incidents. Protobuf is a compact binary format that's typically several times smaller and faster to (de)serialise, and it enforces schema evolution rules through numbered fields, which matters a lot for high-volume internal service-to-service traffic where bandwidth and latency add up, and where a shared `.proto` schema is a genuine asset rather than friction. For a new internal, high-throughput API between trusted services, I'd lean Protobuf (typically via gRPC); for a public-facing or lower-volume API, I'd default to JSON for its debuggability and universal client support.

### Q2. What makes Protobuf's or Avro's approach to schema evolution safer than JSON's?

Protobuf assigns every field a permanent numeric tag, and the wire format encodes data by that tag rather than by field name or position — a reader can skip any tag it doesn't recognise (safe addition) and a writer can omit a field the reader expects if it has a default (safe removal), as long as tags are never reused for a different meaning. Avro takes a related but distinct approach: both the writer's and reader's schema are known at deserialisation time, and Avro's schema resolution rules define exactly which changes (adding a field with a default, removing a field that had one) are compatible. JSON has no such built-in mechanism — a consumer parsing JSON simply looks up fields by name, so nothing stops a producer from renaming or retyping a field in a way that silently breaks every consumer; JSON's safety depends entirely on team discipline, contract tests, or an external schema (JSON Schema) that isn't enforced by the format itself.

### Q3. What are the key gotchas when migrating a .NET codebase from Newtonsoft.Json to System.Text.Json?

Casing behaves differently: raw STJ library defaults are case-sensitive on read and write C# property names unless you configure options, while ASP.NET Core's web defaults use camelCase and case-insensitive reads; Newtonsoft's contract resolver settings differ enough to cause subtly different output. Polymorphic serialization (serializing a base type and getting the derived type back) worked out of the box with Newtonsoft's `TypeNameHandling`, but STJ requires explicit `[JsonDerivedType]`/`JsonPolymorphic` attributes (added in .NET 7) or custom converters. Circular object references throw by default in STJ, where Newtonsoft could be configured more leniently; and `DateTime` parsing is stricter and culture-invariant in STJ versus Newtonsoft's more forgiving, sometimes culture-sensitive behaviour. Because these only surface when the specific code path is exercised — a polymorphic payload, a circular graph, an odd date format — they're a common source of runtime bugs that unit tests miss if they don't specifically target those cases.

### Q4. Why is deserialising untrusted input with type-name-based polymorphism a security risk?

Some serializers support embedding a type name directly in the payload and instantiating that type automatically during deserialisation (Newtonsoft's `TypeNameHandling.Auto`, Java's native serialization). If the payload comes from an untrusted source, an attacker can specify an arbitrary type — potentially one whose constructor, property setters, or `Dispose`/finalizer logic has an unintended side effect, or that can be chained together with other "harmless" classes into a "gadget chain" that ultimately achieves remote code execution or other unintended behaviour, without ever needing to exploit a traditional memory-safety bug. The mitigation is to never enable type-name-driven deserialisation for data crossing a trust boundary; if polymorphism is genuinely required, use an explicit allow-list of expected types (a discriminator field mapped through your own switch/factory logic) rather than letting the payload dictate what gets instantiated.

### Q5. What is the claim-check pattern, and when would you use it?

Message queues and brokers enforce maximum message sizes (Kafka defaults to about 1MB per message; many cloud queues cap similarly), so a large payload — a generated report, a large file, a big batch of records — can't simply be placed on the queue directly. The claim-check pattern uploads the actual payload to object storage (blob storage, S3) and places only a small reference (a URL or object key, the "claim check") on the queue; the consumer reads the reference and fetches the real payload from storage when it needs it. This keeps the message bus fast, cheap, and within its size limits while still supporting arbitrarily large data, at the cost of an extra network round trip and needing to manage the lifecycle (and eventual cleanup) of the stored blobs.

### Q6. Why would you stream a large JSON payload instead of buffering the whole thing before processing it?

Buffering means fully deserialising the payload into an in-memory object graph before any processing starts — simple to write, but memory usage scales with payload size, and for a multi-gigabyte export this can exhaust available memory or add substantial latency before a single record can be acted on. Streaming (e.g. `JsonSerializer.DeserializeAsyncEnumerable` in .NET) processes records incrementally as they're read from the underlying stream, keeping memory usage roughly constant regardless of total payload size, and letting a consumer start acting on the first record before the rest has even arrived over the network. The trade-off is code complexity — partial or malformed records at the boundary need careful handling, and you lose the simplicity of "one object holds everything" — which is why buffering remains the right default for small-to-moderate payloads, with streaming reserved for genuinely large or unbounded ones.

### Q7. What's the difference between backward-compatible (additive) schema evolution and explicit versioning, and when would you use each?

Additive evolution means every change to a schema only adds new, optional information — new fields are ignored by old consumers, and existing fields are never renamed, retyped, or repurposed — which lets a single schema live indefinitely while producers and consumers upgrade independently and asynchronously; this is the default approach Protobuf and Avro are designed around. Explicit versioning — a version field, or a versioned endpoint/topic like `/v2/orders` — is needed when a change is genuinely breaking, such as a field's meaning changing or a previously optional field becoming required, and you need to serve old and new consumers different shapes simultaneously during a migration window. The practical rule: default to additive changes wherever possible, since they avoid coordination overhead; reach for explicit versioning only when a change truly can't be made backward-compatible.

### Q8. Why might a system that worked fine in testing throw a "self-referencing loop" or "maximum depth" error the first time it serialises real production data?

Test data is often small, hand-crafted, and rarely includes back-references — for example, an `Order` that references a `Customer`, which in turn references a collection of that same customer's `Order`s. `System.Text.Json` throws by default when it encounters a circular reference during serialisation, since it has no default strategy for representing a cycle in a tree-shaped output format, and unlike Newtonsoft, it doesn't silently ignore or truncate it unless explicitly configured. This only surfaces once a real object graph with an actual cycle is serialised — which test fixtures built for unrelated feature tests may never happen to construct. The fix is either to break the cycle in the DTO/view model layer (never serialise the raw domain graph directly), or explicitly configure `ReferenceHandler.Preserve` to encode the cycle using `$id`/`$ref` markers if the consumer can handle that shape.

### Q9. A team wants to compress every API response "for consistency and to save bandwidth". What would you push back on?

Compression trades CPU time for bandwidth savings, and that trade only pays off when the bandwidth saved is worth more than the CPU spent — true for larger text payloads (tens of KB or more of JSON/XML) where network transfer time dominates, but often a net loss for small payloads (a few hundred bytes), where the fixed overhead of the compression algorithm and its headers can outweigh the savings, and for already-compressed or binary content (images, video, pre-compressed archives) where there's little redundancy left to remove and you're spending CPU for near-zero benefit. I'd suggest compressing selectively based on content type and a minimum size threshold — most web servers and frameworks already support this out of the box — rather than blanket-compressing every response regardless of size or content.

### Q10. How would you design a canonical data model for "Customer" across multiple services, and what's the risk of doing so?

I'd start by identifying the fields that are genuinely shared and stable across every consumer — identity, name, contact details — and define that as the canonical shape, published as a versioned schema (e.g. a shared Avro/Protobuf schema in a registry, or a documented JSON contract) that every producer and consumer agrees to. The benefit is avoiding an N×N explosion of one-off translation logic between every pair of services that need to exchange customer data. The risk is that the canonical model becomes a point of central coordination — changing it requires buy-in from every consumer, it can accumulate fields that only a subset of consumers actually need (bloating the contract for everyone), and if governance is weak, teams start bypassing it with side-channel fields anyway, defeating its purpose. It pays off most at genuine integration boundaries with many producers/consumers, and is often overkill for two services talking directly to each other.
