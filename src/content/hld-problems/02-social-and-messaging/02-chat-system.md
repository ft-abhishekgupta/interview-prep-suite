---
title: Design a Chat System
description: How to design a chat system that manages millions of live WebSocket connections, delivers messages reliably, and orders them per conversation
difficulty: Advanced
tags: [system-design, websockets, messaging, real-time]
---

A chat system delivers messages between users in real time, whether they're online now or come back hours later. The hard parts are not the database — they're routing a message to whichever server holds a recipient's live connection, and doing it reliably at the scale of billions of messages a day.

## Requirements

The functional shape maps directly onto a diagram worth sketching early — who talks to whom, and what has to survive a disconnect:

![alt text](notes/HLD/Problems/Whatsapp/image.png)

![alt text](notes/HLD/Problems/Whatsapp/image-1.png)

### Functional

- One-to-one and group chat (groups up to ~100 members).
- Real-time delivery to online recipients; store-and-forward delivery to offline ones, including a push notification.
- Delivery status per message: sent, delivered, read.
- Presence ("online" / "last seen at ...").
- Media messages (images, video, files).

### Non-functional

- Low latency delivery to online users, target under 100ms within a region.
- No message loss — durability matters even if a server or connection drops mid-send.
- Scale to billions of messages/day and hundreds of millions of concurrent connections.
- Strict global ordering is not required; per-chat ordering must follow the server-assigned sequence numbers so all devices render a conversation consistently.

### Out of scope

- Voice/video calling.
- Chat backup/export.
- Spam and abuse detection pipelines.

## Scale estimation

| Metric | Assumption | Working | Result |
|---|---|---|---|
| DAU | given | given | 500M |
| Messages sent per user/day | 40 avg | 500M × 40 | 20B messages/day |
| Write QPS (avg) | 20B / 86,400s | 20,000,000,000 / 86,400 | ~230,000 msgs/sec |
| Write QPS (peak) | 3× average | 230,000 × 3 | ~700,000 msgs/sec |
| Concurrent WebSocket connections | ~20% of DAU online at once | 500M × 0.2 | ~100M concurrent |
| Connections per WS server | typical event-loop server | ~50,000/server | ~2,000 servers needed |
| Message storage/day | 100 bytes/message avg | 20B × 100B | ~2 TB/day |
| Offline inbox retention | 30 days, same rate | 2TB × 30 | ~60 TB |
| Peak bandwidth (text only) | 700,000 msgs/sec × 100B | 700,000 × 100B | ~560 Mbps |

> [!TIP]
> Say the number that matters most out loud: **100M concurrent connections is a connection-management problem, not a database problem.** That framing correctly points the conversation at the WebSocket tier and connection registry rather than at schema design.

## Core entities and data model

| Entity | Key fields |
|---|---|
| `User` | `user_id`, `last_seen_at` |
| `Device` | `device_id`, `user_id`, `push_token` (a user may have multiple devices) |
| `Chat` | `chat_id`, `type` (1:1/group), `participant_ids` |
| `Message` | `message_id`, `chat_id`, `sender_id`, `content`, `seq_no`, `created_at`, `status` |

```mermaid
erDiagram
    USER ||--o{ DEVICE : owns
    USER ||--o{ CHAT : participates_in
    CHAT ||--o{ MESSAGE : contains
    MESSAGE {
        string message_id
        string chat_id
        string sender_id
        int seq_no
        string status
    }
    CHAT {
        string chat_id
        string type
    }
```

## API design

The REST setup calls and the persistent WebSocket frames end up looking like this side by side:

![alt text](notes/HLD/Problems/Whatsapp/image-2.png)

```http
// REST for setup
POST /chats { "type": "group", "participant_ids": [...] } -> { "chatId": "c_1" }
GET  /chats/{chatId}/messages?before={cursor}&limit=50 -> Message[]

// WebSocket frames (persistent connection, not REST)
-> { "type": "send", "chatId": "c_1", "tempId": "local_1", "content": "hi" }
<- { "type": "ack", "tempId": "local_1", "messageId": "m_982", "status": "sent" }
<- { "type": "deliver", "messageId": "m_982", "chatId": "c_1", "content": "hi", "seqNo": 44 }
-> { "type": "read_receipt", "messageId": "m_982" }
```

## High level architecture

```mermaid
flowchart LR
    A["Client A"] -- ws --> G1["WS Gateway 1"]
    B["Client B"] -- ws --> G2["WS Gateway 2"]
    G1 --> MS["Message Service"]
    MS --> DB[("Chat/Message Store")]
    MS --> Reg[("Connection Registry<br/>user to gateway")]
    MS --> PubSub["Pub/Sub"]
    PubSub --> G2
    MS --> Push["Push Notification Service"]
    Push --> APNs["APNs / FCM"]
```

**Send flow:** (1) client A sends a message over its open WebSocket to whichever gateway it's connected to, (2) the message service persists it durably and assigns a per-chat sequence number, (3) it looks up the connection registry to find which gateway (if any) holds each recipient's live connection, (4) it publishes the message on that gateway's channel via pub/sub, (5) the recipient's gateway pushes it down their socket and the sender gets a `sent` ack immediately, a `delivered` ack once the recipient's client confirms receipt.

**Offline flow:** if the registry shows no live connection for a recipient, the message is written to their durable inbox and a push notification is dispatched via APNs/FCM; when the recipient later connects, their client syncs any pending inbox messages.

## Deep dive: connection registry and WebSocket tier scaling

A WebSocket is a stateful, long-lived TCP connection pinned to one server process — unlike a stateless HTTP request, you can't load-balance a *send* the same way you load-balance a request, because the message must reach the exact server holding the recipient's socket. At the scale of hundreds of millions of concurrent connections, that routing problem is the whole game:

![alt text](notes/HLD/Problems/Whatsapp/image-7.png)

```mermaid
flowchart TD
    Msg["New message for user X"] --> Lookup["Look up user X<br/>in connection registry"]
    Lookup -->|found: gateway 7| Route["Publish to gateway 7's channel"]
    Lookup -->|not found| Offline["Write to inbox + push notification"]
```

The registry (typically Redis, `user_id -> gateway_id`) is updated on connect/disconnect. Fan-out from the message service to the correct gateway happens over a pub/sub layer (Redis Pub/Sub, or a partitioned system like Kafka/NATS), commonly partitioned by user ID for 1:1-heavy traffic or by chat ID when group chat volume dominates — since most users have far more 1:1 chats than group chats, but a busy group needs its own partition so it doesn't spill fan-out load onto unrelated 1:1 traffic:

![alt text](notes/HLD/Problems/Whatsapp/image-6.png)

> [!KEY]
> Scaling the WebSocket tier is about horizontal scaling of stateful connections plus a fast lookup layer — not about the message database. Each gateway node is stateless *about which users exist*, but stateful *about which sockets it currently holds*; the registry is what makes routing between those two facts fast.

Two narrower failure edges are worth naming explicitly, since they're easy to hand-wave past. If a client doesn't receive an ack within a timeout, it retries the send — safely, via the same idempotency key covered below — while an application-level heartbeat (a periodic ping/pong frame) lets the server detect a dead connection and close it quickly, rather than waiting on a much slower OS-level TCP timeout. If the pub/sub layer itself silently fails to deliver a message even though the registry still shows the recipient as connected, a per-user monotonic sequence number carried in each heartbeat lets the client notice a gap between the last sequence it saw and the current one, and request a resync from the durable store instead of silently missing a message.

## Deep dive: delivery states, offline delivery, and push

| Status | Meaning | Set by |
|---|---|---|
| `sent` | Server has durably persisted the message | Message service, immediately on write |
| `delivered` | Recipient's client has received it over the socket (or synced it after reconnecting) | Recipient's client, via an ack frame |
| `read` | Recipient has viewed the message | Recipient's client, via a read-receipt frame |

For an offline recipient, the message is written to a per-user durable inbox (retained for a bounded window, e.g. 30 days) and a push notification is sent via APNs/FCM so the OS wakes the app. On reconnect, the client requests any inbox entries newer than its last-synced sequence number — this makes reconnection itself the recovery mechanism, rather than relying on the transient pub/sub layer to have "remembered" anything:

![alt text](notes/HLD/Problems/Whatsapp/image-4.png)

> [!WARNING]
> A `delivered` ack must come from the recipient's client, not just from the gateway accepting the socket write — a socket write can succeed at the TCP layer even if the client crashes before processing it. Treat `sent` and `delivered` as genuinely different guarantees.

## Deep dive: message ordering, IDs, and deduplication

Each message gets a globally unique `message_id` (for identity/dedup) and a **per-chat monotonic sequence number** (for ordering within that conversation). Global ordering across all chats in the system is neither required nor useful; what users actually perceive is "did message order look right in *this* conversation," which only needs a per-chat counter.

```mermaid
sequenceDiagram
    participant Client
    participant Gateway
    participant MsgSvc as "Message Service"
    Client->>Gateway: send(tempId=local_1)
    Gateway->>MsgSvc: persist + assign seqNo
    MsgSvc-->>Gateway: message_id, seqNo
    Gateway-->>Client: ack(tempId=local_1, status=sent)
```

Clients tag outgoing messages with a temporary local ID (`tempId`) so the server's ack can be matched back to the optimistically-rendered message in the UI without waiting for a round trip. Deduplication (e.g. a client retries a send after a flaky connection) is handled by having the client reuse the same `tempId`/idempotency key on retry, so the server recognizes and ignores a duplicate rather than creating a second message. Ordering is scoped to a chat: the server assigns the next `seq_no` when the message is durably persisted, clients render by `seq_no`, and `created_at` is display metadata rather than the ordering authority. Two concurrent sends are therefore ordered by the server's accepted sequence, not by unsynchronized client clocks.

## Deep dive: group fan-out, storage model, and presence

Group chats are created the same way a 1:1 chat is, just with more participants attached at creation time, capped at roughly 100 members so fan-out cost stays bounded:

![alt text](notes/HLD/Problems/Whatsapp/image-3.png)

| Aspect | 1:1 chat | Group chat |
|---|---|---|
| Fan-out on send | 1 recipient lookup | Up to ~100 recipient lookups |
| Storage | Message row references 2 participants | Message row references 1 chat with N participants; per-recipient read state tracked separately |
| Delivery status | Single delivered/read state | Delivered/read tracked per member (or summarized as "seen by N") |

Group messages are fanned out the same way as 1:1 — looked up in the connection registry per online member, pushed via pub/sub, and written to the inbox with a push notification for offline members — just repeated per participant, bounded by the ~100-member cap so fan-out cost stays small compared to a social feed's celebrity problem.

A second, orthogonal kind of fan-out happens per user rather than per chat: a single account can be signed in on a phone, a desktop app, and a web client simultaneously, and every one of them expects to receive the same message. The connection registry maps `user_id` to a *set* of gateway connections (one per active device) rather than a single one, and delivery iterates that set the same way it would iterate group members:

![alt text](notes/HLD/Problems/Whatsapp/image-8.png)

Media messages (images, video, files) are handled outside the normal message path: the client uploads the file directly to object storage, and the message row carries only a reference URL plus metadata (size, mime type, thumbnail), so the WebSocket and message store never carry large binaries:

![alt text](notes/HLD/Problems/Whatsapp/image-5.png)

**Presence** ("online"/"last seen") is derived from connection state rather than written to a database on every heartbeat: a user is "online" while their socket is registered in the connection registry, and "last seen" is recorded once, on disconnect — this avoids a write storm from periodic heartbeats across 100M connections.

> [!NOTE]
> End-to-end encryption (e.g. the Signal protocol) is usually mentioned rather than designed in depth in an interview: each device holds key pairs, messages are encrypted client-side before they ever reach the server, and the server only ever routes ciphertext. It's worth a sentence to show awareness, but the architecture above is unchanged — the server still routes and stores opaque payloads the same way.

## Bottlenecks and scaling

- **Connection registry lookups at 700K msgs/sec** — keep it in-memory (Redis), sharded, with the write path (connect/disconnect) far less frequent than the read path (lookup per message).
- **Pub/sub fan-out for group chats** — partition by chat ID so a busy group doesn't create a hot shard affecting unrelated chats.
- **WebSocket server memory per connection** — use an efficient event-loop runtime (each idle connection should cost only a few KB); this bounds how many connections fit per host.
- **Reconnection storms** (e.g. after a regional network blip) — stagger client reconnect with jittered backoff so thousands of clients don't all reconnect in the same second.

## Failure scenarios

| Failure | Blast radius | Mitigation |
|---|---|---|
| WebSocket gateway crashes | All connections on that node drop | Clients auto-reconnect (with backoff) to a healthy gateway; registry updates on reconnect; undelivered messages remain safely in the durable store |
| Connection registry (Redis) unavailable | New message routing fails; can't tell who's online | Fail toward offline delivery (push notification) — never lose the message, just delay live delivery |
| Message store write fails | Message not durably saved | Client hasn't received a `sent` ack, so it retries with the same `tempId`; no duplicate created |
| Push notification provider (APNs/FCM) down | Offline users don't get notified promptly | Message still waits in the durable inbox; delivered on next app open/poll; retry provider calls with backoff |

## Cheat sheet

- WebSockets are stateful — you need a connection registry (`user_id -> gateway_id`) because you can't route a send the way you route an HTTP request.
- `sent` = persisted by server, `delivered` = client acked, `read` = user viewed — three distinct guarantees, don't conflate them.
- Offline delivery = durable inbox + push notification; reconnect syncs from last-known sequence number.
- Order messages per chat with a monotonic sequence number; don't try to guarantee a single global order.
- Dedupe sends with a client-generated idempotency key (`tempId`), not by trusting the network layer.
- Derive presence from connection state on connect/disconnect; don't write a heartbeat to a DB per connection.
- Group chat fan-out is the same mechanism as 1:1, just repeated per member, bounded by group size.

## Common mistakes

| Mistake | Fix |
|---|---|
| Trying to load balance WebSocket sends like stateless HTTP | Maintain a connection registry that maps user to the specific gateway holding their socket |
| Treating a successful socket write as "delivered" | Only the recipient client's ack means delivered; a TCP write can succeed even if the client crashed |
| Assigning a single global sequence number across all chats | Use a per-chat counter; global ordering isn't perceivable or necessary |
| Writing presence to a database on every heartbeat | Derive online/offline from registry membership; write "last seen" once, on disconnect |
| Losing messages sent to an offline user | Always persist to a durable inbox before attempting live delivery, so store-and-forward is guaranteed |

## Summary

A chat system's core challenge is routing, not storage: getting a message from sender to a specific recipient's live connection across thousands of stateful WebSocket servers, backed by a registry that maps users to gateways. Layer on distinct delivery-state semantics (sent/delivered/read), a durable offline inbox with push notification fallback, and per-chat sequence numbers for ordering, and the rest — group fan-out, presence, media — follows the same patterns at a slightly larger fan-out factor.

## Top Interview Questions

### Q1. Why can't you load-balance WebSocket messages the same way you load-balance HTTP requests?

An HTTP request is stateless — any backend instance behind a load balancer can handle it because nothing is pinned to a specific server. A WebSocket is a long-lived, stateful TCP connection that terminates on one specific server process; if you need to push a message to user B, you must find the exact gateway instance holding B's open socket, not just any healthy instance. This requires a connection registry — a fast lookup (`user_id -> gateway_id`), typically in Redis — updated whenever a user connects or disconnects, so the message service knows where to route each outgoing message.

### Q2. Walk through the difference between sent, delivered, and read states, and how each is set.

`Sent` means the server has durably persisted the message — it's set by the server the moment the write succeeds, independent of whether the recipient is even online. `Delivered` means the recipient's client has actually received and acknowledged the message over its connection (or synced it from the offline inbox after reconnecting) — this must come from the client, not just from the gateway successfully writing to the socket, since a TCP write can succeed even if the client app crashed immediately after. `Read` means the user has viewed the message in the UI, which is again a client-originated signal, usually sent when the message enters the visible viewport. Each is a strictly stronger guarantee than the last, and a sender's UI ticks through them in order.

### Q3. How do you deliver a message to a user who is currently offline?

The message is first durably persisted (same as for an online recipient), independent of delivery. If the connection registry shows no live gateway for that user, the system writes the message into a per-user durable inbox and dispatches a push notification via APNs/FCM to wake the client. When the user's device reconnects, the client requests any messages newer than the last sequence number it has locally, syncing the gap. This makes reconnection the actual recovery mechanism — the transient pub/sub layer used for live delivery doesn't need to "remember" anything past the moment of disconnect.

### Q4. How do you handle message ordering, and do you need a single global sequence across the whole system?

No — global ordering across every chat in the system is neither perceivable by users nor useful; what matters is that messages within a single conversation appear in the order they were sent. The fix is a per-chat monotonic sequence number assigned when the message is persisted, so each chat has its own independent, gap-detectable ordering. This avoids needing a globally coordinated counter (a bottleneck) and matches what users actually experience.

### Q5. A user sends a message, their connection drops before receiving the ack, and their client retries. How do you avoid creating a duplicate message?

The client should generate a unique idempotency key (often called a `tempId` or client-generated message ID) when it first composes the message, and reuse the exact same key on any retry of that same logical send. The server checks whether it has already persisted a message with that key; if so, it returns the existing message's server-assigned ID and status instead of creating a new row. This makes retries safe without needing the network layer itself to guarantee exactly-once delivery, which it fundamentally can't.

### Q6. How would you implement "last seen" / presence without overwhelming the database?

Avoid writing presence state on every heartbeat across potentially 100M concurrent connections — that's a write storm with no real benefit, since "online" is fully derivable from whether the user currently has an entry in the in-memory connection registry. Only write to a persistent store once: at disconnect time, record the timestamp as "last seen." A heartbeat mechanism (periodic ping/pong over the socket) is still useful to detect dead connections and trigger that disconnect-time write, but it doesn't need to hit a database on every tick.

### Q7. How does group chat fan-out differ from 1:1 messaging, and how do you bound its cost?

Mechanically it's the same operation — look up each recipient in the connection registry, route via pub/sub if online, or write to their inbox and push-notify if not — just repeated once per group member instead of once. The cost is naturally bounded by capping group size (e.g. ~100 members), which keeps per-message fan-out small and predictable, unlike a social feed where a single account can have millions of followers. Delivery and read status also become per-member rather than a single flag, often summarized in the UI as "seen by N of M."

### Q8. The connection registry (Redis) goes down. What happens to the system, and how do you make that failure survivable?

Without the registry, the message service can't determine which gateway (if any) holds a recipient's live connection, so it can't route for live delivery. The safe default is to fail toward the durable path: persist the message (this should already be independent of the registry) and treat every recipient as if they were offline, sending a push notification. Users experience a temporary loss of "instant" delivery but no message loss — messages simply queue in the durable inbox and get delivered once the recipient's client next syncs or the registry recovers.

### Q9. How would you scale the WebSocket tier to support 100 million concurrent connections?

Each gateway server holds a bounded number of connections limited mostly by memory and file descriptor limits — with an efficient event-loop-based server, tens of thousands of idle connections per host is realistic, putting the total server count in the low thousands for 100M connections. Scale horizontally by adding gateway instances behind a connection-aware router (clients connect once and stick to that instance until disconnect), keep the connection registry as the shared source of truth for routing between gateways, and partition pub/sub channels (by user or chat ID) so fan-out load spreads rather than concentrating on one broker instance.

### Q10. How would you handle a mass-reconnection event, for example after a regional network outage affecting a large fraction of clients simultaneously?

If every disconnected client attempts to reconnect at the exact same moment, the WebSocket tier and the connection registry both see a synchronized spike that can look like an overload event even though total steady-state connection count hasn't actually grown. The standard mitigation is jittered exponential backoff on the client's reconnect logic, so reconnection attempts spread out over seconds rather than arriving in the same instant, combined with gateway-side connection-rate limiting so a burst degrades gracefully (slower reconnects) rather than causing cascading failures.

### Q11. What would change in this design if end-to-end encryption were a hard requirement?

The server-side architecture barely changes: the server still needs to route and store payloads, look up connections, fan out to group members, and handle offline delivery — it simply never has the plaintext to inspect. Encryption keys are managed client-side (each device has its own key pair, exchanged via a key-distribution protocol like Signal's), and the payload the server sees is ciphertext end to end. The main practical implications for the backend are that server-side features requiring content inspection (search over message text, spam scanning) become impossible without client-side cooperation, and per-device key management adds complexity for multi-device sync.
