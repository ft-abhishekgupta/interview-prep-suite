---
title: DNS and Connection Setup
description: The full journey from typing a URL to receiving the first byte, how DNS resolution and caching work, and why connection reuse matters so much
difficulty: Core
tags: [dns, tls, latency, networking]
---

"What happens when you type a URL into a browser and press enter" is one of the most reliable senior interview questions because it forces you to connect DNS, TCP, TLS, and HTTP into one coherent timeline. Getting the *order* and the *cost* of each step right is what separates a strong answer from a vague one.

## The full journey of a request

```mermaid
sequenceDiagram
    participant Browser
    participant Resolver as "DNS Resolver"
    participant Server
    Browser->>Resolver: "Resolve example.com"
    Resolver-->>Browser: "IP address (cached or fresh lookup)"
    Browser->>Server: "TCP SYN"
    Server-->>Browser: "SYN-ACK"
    Browser->>Server: "ACK"
    Note over Browser,Server: "TCP connected"
    Browser->>Server: "TLS ClientHello"
    Server-->>Browser: "ServerHello, certificate, key exchange"
    Browser->>Server: "Finished"
    Note over Browser,Server: "TLS established"
    Browser->>Server: "HTTP GET /"
    Server-->>Browser: "HTTP response"
```

Each step is a real, measurable cost. A cold connection to a new host pays for all of it; a warm, reused connection skips straight to the last step.

## Before DNS: joining the network and resolving local addresses

Long before a browser resolves `example.com`, the device itself needs an address and a way to find other devices on its own local segment — two jobs DNS doesn't do at all.

**DHCP (Dynamic Host Configuration Protocol)** automatically assigns a device's IP address, subnet mask, default gateway, and DNS servers when it joins a network, through a four-step exchange remembered as **DORA**: Discover (the client broadcasts asking for an address), Offer (a DHCP server proposes one), Request (the client asks to actually use it), Acknowledge (the server confirms the lease).

![alt text](notes/02-ComputerNetworks/image-19.png)

Once a device has an IP, sending anything on the local segment still requires a MAC address, not just an IP — that's what **ARP (Address Resolution Protocol)** is for: a device broadcasts "who has this IP?" on the local segment, and the owner replies with its MAC address, which gets cached briefly so the lookup isn't repeated for every packet.

If the destination isn't on the local segment at all, the packet goes to the default gateway learned via DHCP, and if that gateway is the edge of a private network, **NAT (network address translation)** takes over: it rewrites the packet's private source address and port to the router's single public IP and a chosen port, recording the mapping so the reply can be routed back to the right internal device — the mechanism that lets an entire private network (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`) share one public IP address without every device needing one of its own.

> [!TIP]
> DHCP, ARP, and NAT are three different problems that get confused because they all happen quietly before an application ever sees traffic: DHCP gets you an address, ARP finds a MAC address on your own segment, and NAT translates your address at the boundary to the internet.

## DNS resolution

DNS translates a human-readable name into an IP address through a hierarchy of servers, each responsible for one part of the namespace.

1. **Recursive resolver** (often your ISP's or a public one like `8.8.8.8`) — receives the query and does the legwork on the client's behalf, caching results for reuse by other clients.
2. **Root server** — doesn't know the answer but knows which TLD server to ask (e.g. for `.com`).
3. **TLD server** — doesn't know the answer either, but knows which authoritative server owns `example.com`.
4. **Authoritative server** — holds the actual DNS records for `example.com` and returns the answer.

The resolver caches the final answer for the record's **TTL**, so repeat lookups across the internet don't re-walk this whole chain every time — most real-world lookups hit a cache at the resolver and never reach the authoritative server at all.

> [!KEY]
> DNS resolution is itself layered caching: browser cache, OS cache, recursive resolver cache, and only on a full miss does the hierarchy get walked. Each layer trades freshness for speed.

## Record types

| Record | Maps to | Typical use |
|---|---|---|
| `A` | IPv4 address | Standard hostname → IPv4 |
| `AAAA` | IPv6 address | Standard hostname → IPv6 |
| `CNAME` | Another hostname (alias) | Point a subdomain at a service (e.g. `www` → a CDN hostname) |
| `MX` | Mail server hostname + priority | Where to deliver email for a domain |
| `TXT` | Arbitrary text | Domain verification, SPF/DKIM (email anti-spoofing) |
| `NS` | Authoritative nameserver hostnames | Delegates a zone to specific nameservers |
| `SRV` | Service location (host, port, priority, weight) | Service discovery (e.g. VoIP, some internal services) |
| `ALIAS`/`ANAME` | Another hostname, but resolved at the zone apex | CNAME-like behaviour at the root domain, where `CNAME` isn't allowed |

## TTL and propagation delay

Every DNS record has a **TTL (time to live)**, telling caches how long they may serve that answer before re-checking the authoritative server. A short TTL (e.g. 60 seconds) means changes propagate fast but every cache expiry adds a fresh lookup's latency; a long TTL (e.g. 24 hours) means excellent cache efficiency but a slow, staggered rollout of any change — some clients see the old value for up to that TTL after you update it, since you don't control every cache in between.

> [!TIP]
> Before a planned DNS change (e.g. a migration), lower the TTL well in advance — the *old* TTL still governs how long already-cached answers live, so shortening it the day of the cutover is too late for anyone who cached the record under the old, longer TTL.

## DNS-based load balancing, failover, and its limits

Returning multiple `A` records for one name lets clients round-robin across them, and some providers monitor health and stop returning records for unhealthy targets — a simple form of load balancing and failover that requires no special client behaviour. The limits are real, though: DNS has no visibility into per-request load or real-time health beyond whatever polling interval the provider uses, clients and intermediate resolvers cache answers for the TTL regardless of the server's actual current health, and a resolver might pin to one returned IP for the life of a long-running connection, so DNS-based failover reacts on the order of the TTL and cached-connection lifetime, not instantly.

## DNS caching at every layer

| Layer | Cache lifetime | Notes |
|---|---|---|
| Browser | Minutes (browser-specific policy) | Fastest, first checked |
| OS resolver cache | Governed by TTL | `ipconfig /displaydns` on Windows to inspect |
| Recursive resolver (ISP/public DNS) | Governed by TTL | Shared across many clients |
| Application-level (e.g. `HttpClient` in .NET) | Can outlive the DNS TTL entirely | The trap below |

> [!DANGER]
> A long-lived `HttpClient` in .NET keeps its underlying connection (and therefore its resolved IP) alive potentially far longer than the DNS record's TTL, because the OS/socket layer doesn't automatically re-resolve for an already-open connection. If a backend behind a load balancer or CDN changes IP, a pooled connection can keep talking to a now-stale address until it's torn down. The standard mitigation is `PooledConnectionLifetime` on `SocketsHttpHandler`, forcing periodic reconnection (and therefore re-resolution) even while the client itself lives forever.

```csharp
var handler = new SocketsHttpHandler {
    PooledConnectionLifetime = TimeSpan.FromMinutes(5) // forces periodic re-resolution
};
var client = new HttpClient(handler); // still keep this instance long-lived
```

## TCP and TLS handshake costs

| Step | Round trips | Notes |
|---|---|---|
| DNS lookup | 0 (cached) to several (full recursive walk) | Usually cached; a cold miss can cost 20-100+ ms |
| TCP handshake | 1 round trip | SYN, SYN-ACK, ACK |
| TLS 1.2 handshake | 2 round trips | Full negotiation before any app data |
| TLS 1.3 handshake | 1 round trip (0 with resumption) | Combines key exchange into the first flight |

TLS 1.3's **0-RTT** mode lets a client that has previously connected resume a session and send application data in its very first flight, eliminating the handshake round trip entirely for repeat connections — at the cost of a subtle security trade-off (0-RTT data is replayable, so it's typically restricted to idempotent requests).

## Connection reuse and why HttpClient should be long-lived

Every one of the round trips above is paid again for a brand-new connection. A pooled, reused connection pays DNS + TCP + TLS **once**, then every subsequent request on that connection skips straight to the request/response exchange. This is why creating a new `HttpClient` per request is a recurring production anti-pattern: beyond the ephemeral-port exhaustion risk from short-lived TCP connections, it also means paying the full DNS + TCP + TLS cost on every single call instead of once per connection lifetime.

## The latency budget: cold vs warm connection

| Stage | Cold connection | Warm (reused) connection |
|---|---|---|
| DNS lookup | 20-100+ ms (cache miss) | 0 ms (already resolved, connection open) |
| TCP handshake | ~1 round trip (~20-100 ms depending on distance) | 0 ms |
| TLS handshake | ~1-2 round trips (~20-200 ms) | 0 ms |
| Request/response | Actual server processing + 1 round trip | Same |
| **Total overhead before first byte of real work** | **~60-400+ ms** | **~0 ms** |

> [!WARNING]
> This overhead is why "the API is fast when I benchmark it in isolation but slow in the real app" is so common — a benchmark that opens one connection and reuses it hides exactly the cost that a real client paying for cold connections on every call actually incurs.

## Cheat sheet

- Order: DNS resolution → TCP handshake → TLS handshake → HTTP request/response.
- DNS is a hierarchy (root → TLD → authoritative) but most real lookups hit a cache before ever reaching it.
- TTL trades propagation speed against cache efficiency — lower it *before* a planned change, not on the day.
- DNS-based load balancing/failover reacts on the order of TTL and cached-connection lifetime, not instantly.
- TLS 1.3 needs one round trip (zero with 0-RTT resumption); TLS 1.2 needs two.
- A pooled/reused connection pays DNS + TCP + TLS once; a fresh connection per call pays it every time.
- `HttpClient` should be long-lived, but set `PooledConnectionLifetime` to avoid the DNS-staleness trap.
- Cold connection overhead can be hundreds of milliseconds before any real work starts; warm is near zero.
- 0-RTT data is replayable — restrict it to idempotent requests.
- Record types: `A`/`AAAA` for addresses, `CNAME` for aliases, `MX` for mail, `TXT` for verification/anti-spoofing, `SRV` for service discovery.
- DHCP's DORA (Discover, Offer, Request, Acknowledge) gets a device an IP before it can do anything else, including its first DNS lookup.
- ARP resolves an IP to a MAC address on the local segment only; DNS resolves a name to an IP globally — different scopes, different layers.
- NAT rewrites private source addresses/ports to one public IP at the network edge, keyed by a translation table so replies route back correctly.

## Common mistakes

| Mistake | Fix |
|---|---|
| Creating a new `HttpClient` per request | Reuse a long-lived instance with `PooledConnectionLifetime` set |
| Lowering DNS TTL only on the day of a migration | Lower it well in advance so old cached TTLs expire first |
| Assuming DNS failover is instant | It's bounded by TTL and by how long clients keep existing connections open |
| Benchmarking against a single warm connection and extrapolating | Include cold-connection cost in any realistic latency budget |
| Treating 0-RTT data as safe for any request | Restrict it to idempotent requests — it can be replayed by an attacker |
| Forgetting that a long-lived connection can outlive a DNS record's TTL | Set a pooled connection lifetime so the client periodically re-resolves |
| Assuming a device can reach anything before completing DHCP's DORA exchange | No IP, gateway, or DNS server exists until the lease is acknowledged — that has to happen first |

## Summary

Before any of the DNS/TCP/TLS/HTTP sequence begins, a device already had to join the network: DHCP's DORA exchange hands it an IP, gateway, and DNS servers, and ARP resolves local MAC addresses so anything can actually be delivered on that segment, with NAT translating private addresses at the edge so the whole private network can share one public IP. From there, typing a URL triggers a strict sequence: DNS resolution (usually served from a cache, occasionally a full recursive walk through root, TLD, and authoritative servers), a TCP handshake, a TLS handshake, and finally the HTTP exchange itself — each step is a real round trip with a real cost, and a cold connection can add hundreds of milliseconds before any actual work begins. TTLs govern how long every layer of DNS caching trusts an answer, which is why DNS-based failover is bounded, not instant, and why planned migrations need TTLs lowered well ahead of time. In production, the practical payoff is connection reuse — a long-lived, pooled `HttpClient` avoids paying DNS, TCP, and TLS setup on every call, while `PooledConnectionLifetime` prevents that same reuse from serving a stale, cached IP indefinitely.

## Top Interview Questions

### Q1. Walk me through everything that happens between typing a URL and the browser rendering the page.

First, the browser resolves the hostname to an IP address via DNS — checking its own cache, then the OS cache, then querying a recursive resolver, which may need to walk the root → TLD → authoritative server hierarchy on a full cache miss. Once an IP is known, the browser opens a TCP connection via a three-way handshake (SYN, SYN-ACK, ACK), then negotiates TLS (ClientHello, ServerHello with the certificate, key exchange, Finished) if it's HTTPS. Only after both handshakes complete does the browser send the actual HTTP request; the server processes it and returns a response, which the browser then parses, potentially triggering additional requests for embedded resources (CSS, JS, images) that repeat some or all of this process, ideally over already-open, reused connections rather than from scratch.

### Q2. Why is most DNS resolution fast even though the "proper" hierarchy involves four different types of servers?

Because of caching at every layer: the browser, the OS, and the recursive resolver (often shared across an ISP or a public provider like a company's DNS forwarder) all cache the answer to a query for the duration of its TTL. The full root → TLD → authoritative walk only happens on a genuine cache miss somewhere in that chain, which for a popular domain is rare — most queries are answered from a resolver's cache in a handful of milliseconds. The "chase four servers" hierarchy exists to make the system scalable and delegatable (no single server needs to know every domain on earth), but caching is what makes it fast in practice for the vast majority of real-world lookups.

### Q3. What's the trade-off in setting a DNS record's TTL very low versus very high?

A low TTL (e.g. 60 seconds) means changes propagate quickly — clients and resolvers re-check the authoritative server often — which is valuable right before a planned migration or failover event, but it also means every cache expiry triggers a fresh lookup, adding load to authoritative servers and a small amount of latency more often. A high TTL (e.g. 24 hours or more) is efficient — most lookups are served from cache with minimal load on authoritative infrastructure — but any change you make takes up to that TTL to be visible everywhere, since you can't force-expire caches you don't control. The standard practice is to lower the TTL well before a planned change, wait for the old (longer) TTL to fully expire everywhere, make the change, and optionally raise the TTL back up afterward once things are stable.

### Q4. Why can DNS-based load balancing and failover be slower to react than a real load balancer?

DNS only controls which IP address a client resolves a hostname to — it has no visibility into a server's current health or load in real time beyond whatever health-check interval the DNS provider polls at, and once a client has resolved and cached an answer, that client keeps using it for the TTL regardless of what happens to the server afterward. Worse, if a client has an existing open TCP/TLS connection to the old IP, DNS changes don't affect that connection at all — the client keeps talking to the old server until the connection itself is closed and a new one is established with a fresh lookup. A dedicated load balancer, by contrast, sits in the actual request path and can redirect traffic on a per-request basis instantly when a backend becomes unhealthy, which is why DNS failover is typically treated as a coarse, slow layer, with a real load balancer or service mesh handling fine-grained, fast failover.

### Q5. Why does TLS 1.3 typically need fewer round trips than TLS 1.2, and what is 0-RTT?

TLS 1.2's handshake negotiates the cipher suite and exchanges keys across two separate round trips before the client can send any application data. TLS 1.3 simplified and combined this: the client sends its key share guesses in the very first message, and if the server supports one of them (which is common, since TLS 1.3 narrowed the allowed cipher suites considerably), the handshake completes in a single round trip. 0-RTT goes further: if the client has connected to this server before and has a cached session ticket, it can send encrypted application data in that very first flight, with zero additional round trips for the handshake. The catch is that 0-RTT data can be replayed by an attacker who captures and resends it, since there's no fresh interactive proof of liveness yet, so it's generally restricted to idempotent operations like a GET request, not something like a payment submission.

### Q6. Why should HttpClient in .NET be a long-lived, reused instance rather than created per request?

Creating a new `HttpClient` per call means a new underlying socket, and therefore paying the full cost of DNS resolution, a TCP handshake, and (for HTTPS) a TLS handshake on every single request — each of those is a real round trip, and together they can add tens to hundreds of milliseconds of pure overhead before any actual work happens, compared to near-zero on an already-open, reused connection. It also creates a large number of short-lived sockets that pile up in `TIME_WAIT`, risking ephemeral port exhaustion under load. The recommended approach is a single, long-lived `HttpClient` (or one obtained via `IHttpClientFactory`), which pools and reuses underlying connections across many logical requests.

### Q7. If HttpClient should be long-lived, doesn't that risk it caching a stale DNS entry forever if the target server's IP changes?

Yes — that's a genuine trap. Once a connection is open, the OS doesn't automatically re-resolve DNS for it; the socket keeps talking to whatever IP it originally connected to, for as long as that connection stays open, potentially outliving the DNS record's TTL entirely if the connection is reused indefinitely. If the backend is behind a load balancer or CDN that changes IPs (a common failover or scaling event), a long-lived pooled connection can keep sending traffic to a now-decommissioned address. The mitigation in .NET is setting `PooledConnectionLifetime` on the `SocketsHttpHandler` backing the `HttpClient`, which forces the connection pool to periodically tear down and re-establish connections (and therefore re-resolve DNS), while the `HttpClient` object itself remains a single long-lived instance from the application's point of view.

### Q8. A benchmark shows an API endpoint responding in 5ms, but real users report it feeling slow. What might explain the gap?

The benchmark almost certainly opens one connection and reuses it across all measured calls, which means it's measuring only server processing time and the request/response round trip — it never pays for DNS resolution, a TCP handshake, or a TLS handshake, because those only happen once, outside the measured loop. A real client, especially one making infrequent calls or opening fresh connections (e.g. a mobile client waking from background, or a service without connection pooling configured), pays some or all of that setup cost on each call, which can easily add tens to hundreds of milliseconds on top of the "true" 5ms processing time. I'd check whether the client-side HTTP client is actually reusing connections, whether DNS lookups are hitting a cold cache, and whether TLS session resumption is in effect, since all three are invisible to a benchmark that never tears down its connection.

### Q9. What's the difference between a CNAME and an A record, and why can't you put a CNAME at the root/apex of a domain?

An `A` record maps a hostname directly to an IPv4 address; a `CNAME` maps a hostname to *another hostname* (an alias), which the resolver then has to resolve again to get the actual address — useful for pointing a subdomain like `www.example.com` at a CDN's hostname without needing to track the CDN's changing IPs yourself. A `CNAME` can't be placed at the zone apex (the bare domain, `example.com` itself) because DNS specifications require the apex to also carry other record types (like `NS` and `SOA`, which define the zone itself and its nameservers), and a `CNAME` record legally cannot coexist with any other record type for the same name — resolving it would create ambiguity about which records apply. Providers work around this with a non-standard `ALIAS`/`ANAME` record, which behaves like a `CNAME` to the outside world but is resolved to a concrete `A`/`AAAA` record by the DNS provider itself at the apex, satisfying the coexistence rule.

### Q10. How would you diagnose whether a slow request is spending its time in DNS, TCP/TLS setup, or the actual server response?

I'd use a tool that breaks down request timing into phases — the browser's network tab, `curl -w` with its timing format variables, or an APM/tracing tool — which typically reports separate timings for DNS lookup, TCP connect, TLS handshake, time-to-first-byte, and content download. A large DNS lookup time points to an uncached or slow resolver (or a very short TTL causing frequent re-lookups); a large TCP/TLS connect time on a *new* connection is expected overhead, but seeing it on every single request suggests connections aren't being reused (a client-side pooling misconfiguration); a large time-to-first-byte with fast connection setup points to actual server-side processing time, which is a separate investigation (profiling, database query time, and so on). Separating these phases turns "it's slow" into a specific, actionable bottleneck rather than a guess.

### Q11. Walk through what DHCP's DORA process actually does when a laptop joins a Wi-Fi network.

When a device joins a network without a known IP address, it broadcasts a `DHCPDISCOVER` message, since it has no address yet to send anything directly. Any DHCP server listening on that segment responds with a `DHCPOFFER`, proposing an IP address along with a subnet mask, default gateway, and DNS servers, reserved for that device for a limited lease time. The client replies with a `DHCPREQUEST`, explicitly asking to accept one specific offer — useful when multiple DHCP servers respond, since only one offer gets accepted — and the chosen server finalizes it with a `DHCPACK`, confirming the lease. Only after this four-step Discover/Offer/Request/Acknowledge exchange completes does the device have a usable IP address, gateway, and DNS server to attempt anything else, including its very first DNS lookup.

### Q12. Why does a packet need both ARP and DNS if they both seem to be "resolving an address"?

They resolve completely different things, at different layers, at different scopes. DNS resolves a human-readable hostname to an IP address, and it works globally across the internet through a hierarchy of servers, because the mapping between a domain and its IP isn't tied to any particular local network. ARP resolves an already-known IP address to a MAC address, and it only ever works on the local physical segment, because MAC addresses have no meaning or routability beyond one link — a router forwards a packet using the destination IP, but the actual last-hop delivery on any given segment, including from a device to its own default gateway, still needs the physical MAC address, which is what ARP supplies. Put simply, DNS answers "which IP is this name", and ARP answers "which physical device is this IP, right here, right now".
