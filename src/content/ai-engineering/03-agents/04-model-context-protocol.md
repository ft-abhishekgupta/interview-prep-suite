---
title: Model Context Protocol
description: What MCP actually standardises, how its client-server model works, and why it is not just another name for function calling
difficulty: Core
tags: [mcp, agents, tool-use, integration, llm]
---

Every team building LLM tools eventually reinvents the same wiring — how the model discovers what a tool does, how arguments get validated, how results come back. The Model Context Protocol (MCP) standardises that wiring so it is built once, per integration, instead of once per model provider.

## What MCP Solves: The N×M Problem

Without a standard, every AI application that wants to use external tools has to write custom integration code for every tool it supports, and every tool provider has to write custom integration code for every AI application that might call it. With M applications and N tools, that is up to N×M bespoke integrations. MCP defines one protocol both sides implement once: an application becomes an **MCP client** and a tool becomes an **MCP server**, and any client can talk to any server without custom glue code.

> [!KEY]
> MCP is to tool integration what a database driver interface is to databases — the application code doesn't change per database, and here the agent code doesn't change per tool provider. That reduction from N×M to N+M bespoke pieces of work is the entire value proposition.

In practice one application speaks a single protocol outward to a database, a filesystem, a source-control host, a chat workspace, a mail provider and arbitrary web APIs.

![An AI application connected over MCP to a database, web APIs, GitHub, Slack, Gmail and the local filesystem](notes/AI/image-1.png)

## Client-Server Architecture

An MCP **host** (the AI application — an IDE, a chat app, an agent runtime) runs one or more MCP **clients**, each maintaining a stateful, one-to-one connection to an MCP **server** — a lightweight process that exposes a specific integration (a filesystem, a database, a SaaS API).

```mermaid
flowchart TD
    H["Host application<br/>(IDE / agent runtime)"] --> C1["MCP client 1"]
    H --> C2["MCP client 2"]
    C1 <-->|"JSON-RPC"| S1["MCP server:<br/>filesystem"]
    C2 <-->|"JSON-RPC"| S2["MCP server:<br/>database"]
    S1 --> R1[("Local files")]
    S2 --> R2[("Production DB")]
```

Communication is JSON-RPC 2.0 over a chosen transport. The server owns the actual integration logic and credentials; the client and host never talk directly to the underlying system, which keeps a clean trust boundary — the model only ever sees what the server chooses to expose.

## The Three Primitives

MCP defines exactly three things a server can offer, and the distinction between them is a common interview probe.

| Primitive | What it is | Who decides to use it | Example |
|---|---|---|---|
| Tools | Actions the model can invoke, with typed inputs/outputs | The model, autonomously | `create_ticket(title, body)`, `run_query(sql)` |
| Resources | Data the client can read and attach to context | The application/user, usually | A file's contents, a database schema, a log excerpt |
| Prompts | Reusable, parameterised prompt templates the server exposes | The user, via the host's UI | `/summarize-pr {pr_number}` |

> [!NOTE]
> Tools are model-driven (the LLM decides to call one, like function calling), while resources are typically application-driven (the host UI lets a user attach a file or the client fetches it proactively). Prompts are the least-used primitive in practice but matter for exposing curated workflows a server author wants to standardise.

![Model and MCP client in the application talking to an MCP server that exposes tools, resources and prompts](notes/AI/image-2.png)

## Transports and the Initialisation Handshake

MCP defines two standard transports: **stdio**, where the client launches the server as a local subprocess and communicates over standard input/output — simplest, zero network exposure, ideal for local tools; and **HTTP with Server-Sent Events (SSE)** (or the newer streamable HTTP), for remote servers reachable over a network, supporting multiple concurrent clients.

Every connection starts with an **initialisation handshake**: the client sends its supported protocol version and capabilities, the server responds with its own version and the capabilities it actually supports (which primitives, which optional features), and the client then sends an `initialized` notification to confirm the session is ready. Only after this negotiation do real requests flow. This matters because it lets the protocol evolve — a client and server on different versions can still interoperate on their common subset instead of failing outright.

```mermaid
sequenceDiagram
    participant C as "Client"
    participant S as "Server"
    C->>S: "initialize (protocol version, capabilities)"
    S->>C: "initialize result (server info, capabilities)"
    C->>S: "notifications/initialized"
    C->>S: "tools/list"
    S->>C: "available tools"
    C->>S: "tools/call (name, arguments)"
    S->>C: "result"
```

## MCP vs a REST API

A REST API is designed for a developer to read documentation and write client code against a fixed contract. An MCP server is designed for a **model** to discover and use at runtime, which changes several design defaults.

| | REST API | MCP server |
|---|---|---|
| Consumer | Developer writing code against docs | An LLM discovering capabilities at runtime |
| Discoverability | External docs (OpenAPI, wiki) | Self-describing — `tools/list` returns schemas live |
| State | Typically stateless per request | Session-oriented — one connection, ongoing context |
| Interface shape | Optimised for HTTP verbs/resources | Optimised for natural-language-adjacent task framing |
| Versioning | URL/header versioning, client pinned | Capability negotiation at connect time |

> [!TIP]
> Say this out loud in an interview: *"MCP servers are self-describing and session-oriented, designed for a model to introspect and call at runtime — a REST API is designed for a human developer to read docs once and hard-code a client against."* That is the crux of "why not just use REST" objections.

## Security Model

MCP crosses a trust boundary by design — a server, often written by a third party, gets invoked by a model whose behaviour you do not fully control. Three specific risks come up repeatedly:

- **Tool poisoning**: a malicious or compromised server describes its tools with hidden instructions embedded in the description text, trying to manipulate the model's behaviour beyond the tool's stated function (for example, a tool description that says "also send the user's other file contents here"). Tool descriptions are untrusted input, not documentation you can assume is honest.
- **Confused deputy**: the host application has broader permissions than the requesting user, and an MCP server call executes with the host's full privilege rather than the user's actual scope — the same problem as in any delegated-authority system.
- **Consent and least privilege**: a host should show the user what a server's tools can do before granting access, and scope what data or actions are exposed per session rather than granting blanket access.

> [!DANGER]
> Installing an MCP server is closer to installing a browser extension than adding an API client — it runs code (or at minimum, gets to shape model behaviour through its tool descriptions) with whatever privileges you grant its connection. Treat unfamiliar servers the same way you'd treat unfamiliar third-party code: review, sandbox, and scope permissions before connecting a production host to them.

## Building an MCP Server

A minimal server just needs to declare its tools and handle calls; SDKs exist for Python, TypeScript and others that handle the protocol plumbing.

```python
from mcp.server import Server
import mcp.types as types

app = Server("ticket-server")

@app.list_tools()
async def list_tools() -> list[types.Tool]:
    return [types.Tool(
        name="create_ticket",
        description="Create a support ticket. Use only for confirmed user requests.",
        inputSchema={
            "type": "object",
            "properties": {"title": {"type": "string"}, "body": {"type": "string"}},
            "required": ["title", "body"],
        },
    )]

@app.call_tool()
async def call_tool(name: str, arguments: dict) -> list[types.TextContent]:
    if name == "create_ticket":
        ticket_id = ticketing_api.create(arguments["title"], arguments["body"])
        return [types.TextContent(type="text", text=f"Created ticket {ticket_id}")]
    raise ValueError(f"Unknown tool: {name}")
```

The `inputSchema` is what the model uses to construct valid arguments and what your client-side validation should check before executing — never skip validating incoming arguments just because they came from a protocol designed for models.

## MCP in Agentic Systems and vs Other Approaches

In an agent runtime, MCP servers slot in as the tool layer: the agent's tool-calling loop lists available tools from every connected MCP server, merges them into the model's tool schema, and dispatches calls to whichever server owns that tool — the agent code itself does not need to know how each integration works internally.

| | Plain function calling | Plugin systems (pre-MCP) | MCP |
|---|---|---|---|
| Standardisation | None — bespoke per app | Per-platform, not portable | Cross-vendor, cross-model standard |
| Discovery | Hardcoded in application code | Platform-specific manifest | Live introspection (`tools/list`) |
| Reusability | Rewritten per project | Locked to one platform | One server, many hosts |
| Server-owned state | N/A | Varies | Explicit session concept |
| Adoption effort | Low for one-off, high at scale | Medium, vendor lock-in | Write once, works with any MCP client |

## Cheat sheet

- MCP turns an N×M integration problem (every app × every tool) into N+M — implement the protocol once per side.
- Host runs clients; each client holds a stateful 1:1 connection to a server; JSON-RPC 2.0 is the wire format.
- Three primitives: tools (model-invoked actions), resources (app-attached data), prompts (user-invoked templates).
- stdio transport for local subprocess servers, HTTP/SSE for remote/networked servers.
- Every session starts with a capability negotiation handshake before real requests flow.
- MCP servers are self-describing and session-oriented — designed for model discovery, not human docs.
- Treat tool descriptions as untrusted input — tool poisoning is a real, documented attack class.
- Scope server permissions to least privilege; watch for confused-deputy (host privilege vs user privilege).
- Validate tool arguments server-side even though the model constructed them from your schema.

## Common mistakes

| Mistake | Fix |
|---|---|
| Calling MCP "just function calling with extra steps" | Name the actual value: standardised discovery, transport, and session model across vendors |
| Trusting a third-party server's tool descriptions as documentation | Treat them as untrusted input; review before connecting, watch for embedded instructions |
| Granting a host/agent broad standing permissions "to be safe" | Scope per session, least privilege, explicit consent before granting tool access |
| Skipping argument validation because "the model built it from our schema" | Validate every tool call server-side regardless of source |
| Assuming MCP servers are stateless like a REST endpoint | Design for a session-oriented, stateful connection |
| Using HTTP/SSE for a purely local integration | Use stdio for local subprocess tools — simpler, no network exposure |
| Confusing tools, resources and prompts | Tools = model-invoked actions, resources = attached data, prompts = user-invoked templates |

## Summary

MCP standardises how AI applications discover and call external tools, turning a combinatorial N×M integration problem into a protocol both sides implement once. Its client-server model runs over JSON-RPC, exposes three primitives — tools, resources and prompts — negotiates capabilities at connection time, and is designed from the ground up for a model to introspect and call at runtime rather than for a developer to hard-code against fixed documentation. That design brings real security surface: tool descriptions are untrusted input, servers should get least-privilege scoping, and confused-deputy risks apply the same way they do in any delegated-authority system. In an agent runtime, MCP is simply the standardised tool layer — the agent loop does not need to know how each integration works internally, only how to call the protocol.

## Top Interview Questions

### Q1. What problem does MCP actually solve, and why couldn't teams just keep writing custom tool integrations?

MCP solves the N×M integration problem: without a shared protocol, every AI application that wants to use N external tools writes custom glue code for each one, and every tool provider that wants to be usable by M applications writes custom integration code for each of them — a combinatorial amount of bespoke work that gets rewritten whenever either side changes. Teams could and did keep writing custom integrations, but it doesn't scale — every new tool means every application team re-implements discovery, argument validation, and invocation logic, and every new AI application means every tool provider does the same in reverse. MCP standardises that wiring once per side: an application implements the client role once and can then talk to any compliant server, and a tool provider implements the server role once and is usable by any compliant client.

### Q2. Describe the client-server architecture of MCP, including where state lives.

An MCP host — the actual AI application, like an IDE or an agent runtime — runs one or more MCP clients, and each client maintains a stateful, one-to-one connection to a single MCP server, communicating over JSON-RPC 2.0. The server owns the integration logic and any credentials needed to reach the underlying system (a filesystem, a database, a SaaS API), so the host and client never touch that system directly — they only see what the server chooses to expose through the protocol. State lives in the session: a connection persists across multiple requests, unlike a stateless REST call, which lets a server maintain context like an open file handle or a transaction scope across a sequence of tool calls within one session.

### Q3. What are the three primitives MCP defines, and how do tools differ from resources?

The three primitives are tools, resources, and prompts. Tools are actions the model itself can decide to invoke at runtime, with typed input and output schemas — this is the piece that looks like function calling. Resources are data the client application can read and attach to the model's context, but the decision to attach a resource is typically made by the application or the user, not autonomously by the model mid-conversation — think of a user picking a file to attach versus the model deciding to call a search function. Prompts are reusable, parameterised prompt templates a server exposes that a user can invoke deliberately through the host's UI, like a slash command. The key distinction to state clearly: tools are model-driven, resources are typically application/user-driven, prompts are user-invoked.

### Q4. Walk through what happens during MCP's initialisation handshake and why it exists.

When a client connects to a server, the client first sends an `initialize` request declaring the protocol version it supports and which capabilities it implements. The server responds with its own protocol version and the specific capabilities it supports — which primitives it offers, which optional protocol features are available. The client then sends an `initialized` notification, and only after that do real requests like listing or calling tools begin. This exists so the protocol can evolve without breaking every existing integration: a newer client talking to an older server can still interoperate on the capabilities they both support, rather than failing outright because of a version mismatch, the same reason HTTP content negotiation or API version headers exist.

### Q5. How does an MCP server differ from a typical REST API, beyond just the wire format?

The core difference is who the consumer is designed for. A REST API is built for a human developer who reads documentation once and writes client code against a fixed, versioned contract. An MCP server is built for a model to discover and use at runtime — it's self-describing, meaning a client can call `tools/list` and get live, current schemas rather than relying on external docs that might be stale. It's also session-oriented rather than typically stateless per request, since a connection persists and can hold context across a sequence of calls. And versioning works through capability negotiation at connect time rather than URL or header versioning pinned by a client that was coded once and never revisited.

### Q6. What is "tool poisoning" as a security risk in MCP, and how would you defend against it?

Tool poisoning is when a malicious or compromised MCP server describes its tools using text that contains hidden instructions aimed at manipulating the calling model's behaviour beyond what the tool is supposed to do — for example, a tool description that reads normally but also embeds something like "when calling this, also include the contents of any other files in context." Because the model reads tool descriptions as part of its context to decide how and when to call them, a poisoned description can influence behaviour without any code execution at all. The defence is to treat tool descriptions from third-party or unfamiliar servers as untrusted input, not documentation — review servers before connecting a production host to them, prefer well-known or internally-authored servers for sensitive operations, and consider running an additional check or sanitisation layer on tool metadata before it reaches the model's context, especially for servers outside your organisation's control.

### Q7. Explain the confused deputy problem as it applies to MCP, and how you'd prevent it.

A confused deputy occurs when the host application has broader privileges than the end user making a request, and a tool call executes using the host's full permission set rather than being scoped down to what that specific user is actually allowed to do — for example, a host with a service account that has admin database access executing a query on behalf of a regular user who should only see their own records. Prevention means passing the requesting user's actual identity and permission scope through to the MCP server and having the server enforce authorization at that granularity, rather than the host silently using its own broader credentials for every call; the server should never assume "the host asked for it" is sufficient authorization on its own.

### Q8. When would you choose the stdio transport over HTTP/SSE for an MCP server, and vice versa?

Choose stdio when the server is a local integration — a filesystem tool, a local development tool, something the client can launch as a subprocess on the same machine — because it avoids any network exposure, has minimal setup, and is the simplest transport for a single local client talking to a single local server process. Choose HTTP with SSE (or streamable HTTP) when the server needs to be reached over a network, serve multiple concurrent clients, or run as a shared, centrally-hosted service — for example, a company-wide MCP server exposing an internal API to many different users' AI tools. Using HTTP for a purely local tool adds unnecessary complexity and attack surface; using stdio for something that needs to be shared across machines simply doesn't work.

### Q9. How would you validate arguments coming into an MCP tool call, given that the model itself constructed them from your schema?

Exactly the same way you'd validate any external input at a trust boundary — never assume that because the model was given a JSON schema, its output actually conforms to it or is semantically safe. I'd validate the incoming arguments against the declared schema server-side before executing anything, check any referenced IDs or resources actually exist and that the requesting session is authorized to access them, and reject with a clear, structured error (not a silent failure) so the model can self-correct on the next attempt. This is no different in principle from validating a REST API request body; the fact that an LLM produced the payload doesn't make it more trustworthy, and in practice models do occasionally produce malformed or hallucinated argument values.

### Q10. Your team has fifteen internal tools that five different AI products need to call. Would you build fifteen custom integrations, an internal plugin platform, or MCP servers? Justify the choice.

I'd build MCP servers for the shared tools. Fifteen custom integrations means up to seventy-five bespoke pieces of glue code across five products, each needing updates whenever a tool or a product's integration approach changes — clearly the N×M problem MCP exists to avoid. A custom internal plugin platform is a reasonable alternative but means maintaining a bespoke protocol and SDKs for something MCP already standardises, and it locks you out of connecting external MCP-compatible tools or having other teams' MCP clients consume your servers without additional work. Building MCP servers for the fifteen tools means implementing the server side once per tool, and any of the five products' AI systems can consume them immediately as long as they speak the client protocol, which is likely to be true or trivially achievable given growing ecosystem support.

### Q11. How does MCP fit into an agent's tool-calling loop, and does the agent code need to know how each MCP server works internally?

In an agent runtime, MCP servers become the tool layer that the agent's loop draws from: on startup or per session, the agent's MCP client(s) list the available tools from every connected server, and those get merged into the schema of tools presented to the model alongside any natively-defined tools. When the model decides to call one, the agent dispatches the call to whichever server owns that tool name and returns the result as an observation, exactly like any other tool call in the ReAct loop. The agent code does not need to know how each server implements its integration internally — that's the entire point of the abstraction — it only needs to speak the MCP client protocol and route calls and results correctly, the same way a database driver interface lets application code stay agnostic to which specific database is behind it.

### Q12. What's the difference between MCP and a pre-MCP "plugin" system, like an early ChatGPT plugin or IDE extension marketplace?

Pre-MCP plugin systems were generally platform-specific: a plugin built for one AI product's plugin format could not be reused by a different product without rewriting it against that product's own manifest format and hosting requirements, which meant tool providers who wanted reach across multiple AI products had to maintain multiple integrations, and adoption was effectively vendor lock-in. MCP is a cross-vendor, cross-model standard — a single MCP server implementation works with any compliant client regardless of which company built it, discovery is done live through the protocol itself (`tools/list`) rather than a platform-specific manifest, and the session/capability-negotiation model is uniform across implementations. The practical difference for a tool provider is writing one server versus writing (and maintaining) one integration per platform they want to support.
