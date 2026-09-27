---
title: Object Storage and Blobs
description: How buckets, keys and metadata work under the hood, why large files bypass your API entirely, and how durability differs from availability
difficulty: Core
tags: [object-storage, blob-storage, cdn, file-upload, durability]
---

Every system with images, videos, documents, backups or logs needs an answer to "where do the bytes live", and the answer is almost never "in the database". Object storage (S3, Azure Blob, GCS) is the default, and interviewers expect you to reach for it instantly whenever a file crosses 1 MB.

## Object vs block vs file storage

These three are genuinely different technologies, not marketing names for the same thing.

| Model | Unit | Access pattern | Example | Use for |
|---|---|---|---|---|
| **Block storage** | Fixed-size blocks | Raw disk, mounted, OS manages the filesystem | EBS, Azure Disk | Databases, VM boot disks |
| **File storage** | Files in a directory tree | POSIX paths, shared mounts | NFS, EFS, Azure Files | Shared config, legacy apps expecting a filesystem |
| **Object storage** | Whole immutable objects | HTTP API, flat key space | S3, Azure Blob, GCS | Images, video, backups, logs, static sites |

> [!KEY]
> Object storage trades filesystem semantics (partial writes, directory locking, POSIX permissions) for **massive horizontal scale and simplicity**. You cannot open a byte range and rewrite it in place — you replace the whole object.

## Buckets, keys and metadata

An object store has almost no structure: a **bucket** (top-level namespace, globally or account-unique), a **key** (a string that looks like a path but is not one), and the **object** itself plus **metadata** (content-type, custom headers, tags).

```mermaid
flowchart LR
    B["Bucket<br/>my-app-uploads"] --> K1["Key<br/>users/42/avatar.png"]
    B --> K2["Key<br/>invoices/2024/inv-991.pdf"]
    K1 --> O1["Object bytes +<br/>content-type, ETag, tags"]
    K2 --> O2["Object bytes +<br/>content-type, ETag, tags"]
```

`users/42/avatar.png` **looks** like a folder path, but the store has no directories — it is one flat string key, and consoles fake a folder view by splitting on `/`. This matters for interviews: listing "a folder" is really a **prefix scan**, and a bucket with billions of keys under one prefix can make listing slow unless you design keys for how you will query them (e.g. reverse date, or a hash prefix, to avoid hot partitions on sequential keys).

> [!TIP]
> Say this out loud: *"I'll key objects as `tenantId/date/uuid` so listing and lifecycle rules can operate per-tenant, and I'll avoid a purely sequential prefix so writes don't all land on the same internal partition."*

## Durability vs availability — these are not the same number

Candidates conflate these constantly. Durability is about **not losing bytes ever**; availability is about **being able to reach them right now**.

| Guarantee | What it measures | Typical number | What breaks it |
|---|---|---|---|
| **Durability** | Probability an object survives over a year | **99.999999999%** (11 nines) | Simultaneous loss of every replica across facilities — vanishingly rare |
| **Availability** | Probability a request succeeds right now | **99.9%–99.99%** | Network partition, regional outage, throttling |

Durability is achieved by **replicating** every object across multiple disks and often multiple availability zones (or regions, for geo-redundant tiers) at write time — you get 11 nines because losing all copies simultaneously is astronomically unlikely, even though any single request can still fail transiently.

> [!WARNING]
> "Durable" does not mean "always reachable". An 11-nines-durable object can still return a `503` during a regional blip. Design your upload/download path to retry, not to assume durability implies availability.

## Storage tiers and lifecycle policies

Object stores let you trade retrieval latency and cost against storage cost, and automate the trade with **lifecycle rules**.

| Tier | Cost to store | Retrieval | Retrieval latency | Use for |
|---|---|---|---|---|
| Hot / Standard | Highest | Cheap/free | Milliseconds | Actively served content |
| Cool / Infrequent Access | Lower | Small fee per GB read | Milliseconds | Backups accessed monthly |
| Cold | Lower still | Higher fee | Milliseconds–minutes | Compliance data, rare reads |
| Archive (Glacier / Archive tier) | Lowest | Highest fee | **Minutes to hours** (rehydration) | Long-term retention, legal hold |

A lifecycle policy is a rule engine attached to the bucket: *"move to Cool after 30 days, Archive after 180 days, delete after 7 years."* This is pure cost engineering with zero application code — always mention it when a design has logs, backups or media that age out of relevance.

## Never proxy large files through your API

The single most important rule in this topic: **your API servers should never be in the data path for large files.** If every upload streams through your app tier, you pay for bandwidth and compute twice, you tie up request threads/connections for the duration of a slow client upload, and you cap throughput at your fleet size instead of the object store's near-infinite ingest capacity.

The fix is a **presigned URL** (S3) or **SAS token** (Azure Blob) — a temporary, scoped credential that lets the client talk to the object store directly.

```mermaid
sequenceDiagram
    participant C as "Client"
    participant A as "API"
    participant O as "Object Store"
    participant D as "Database"
    C->>A: "request upload (filename, size, type)"
    A->>A: "validate, authorize, build scoped URL"
    A-->>C: "presigned URL / SAS token (TTL, max size, content-type)"
    C->>O: "PUT bytes directly"
    O-->>C: "200 OK + ETag"
    C->>A: "notify upload complete"
    A->>D: "mark file record COMPLETE"
    O-->>A: "storage event (BlobCreated / S3 event) as backup signal"
```

Two things travel through your API: the **small metadata request** to get the URL, and a **small confirmation**. The actual bytes never touch your servers. Restrict the presigned URL tightly: TTL of minutes, an exact key, a max content-length, and an allowed content-type, otherwise you have handed out an open write hole.

> [!DANGER]
> Trusting only the client's "upload complete" callback is a trap: a malicious or crashed client can leave your database thinking a file exists when it does not, or vice versa. Always reconcile with a **storage event notification** (S3 Event Notifications, Azure Event Grid `BlobCreated`) or a periodic sweep job that compares the bucket to the database.

## Multipart upload and resumable uploads

Above roughly 100 MB (and mandatory above 5 GB on S3), you split the file into **parts**, upload them independently — in parallel, and out of order — and then stitch them together server-side.

```java
// Each part is uploaded independently; the store verifies the checksum per part.
String uploadId = s3.createMultipartUpload(
    CreateMultipartUploadRequest.builder().bucket(bucket).key(key).build()).uploadId();
List<CompletedPart> parts = new ArrayList<>();

for (int i = 0; i < chunks.size(); i++) {
    int partNumber = i + 1;
    UploadPartResponse response = s3.uploadPart(
        UploadPartRequest.builder()
            .bucket(bucket).key(key).uploadId(uploadId).partNumber(partNumber)
            .build(),
        RequestBody.fromByteBuffer(chunks.get(i)));
    parts.add(CompletedPart.builder()
        .partNumber(partNumber).eTag(response.eTag()).build()); // track for completion
}

s3.completeMultipartUpload(CompleteMultipartUploadRequest.builder()
    .bucket(bucket).key(key).uploadId(uploadId)
    .multipartUpload(CompletedMultipartUpload.builder().parts(parts).build())
    .build());
```

This buys you three things: **parallelism** (multiple parts in flight), **resumability** (a dropped connection only costs you the failed part, not the whole file), and **checksums per part** so corruption is caught early. A resumable client keeps a local record of which part indices have succeeded and only re-sends the gaps after a crash or network drop.

## CDN in front of a bucket

For anything read far more often than it is written — avatars, video segments, static assets — put a **CDN** between the client and the bucket.

| Mode | How it works | Trade-off |
|---|---|---|
| **Pull-through (default)** | CDN fetches from the bucket on first miss, then caches at the edge | Simple, no push step, first request per edge node is slow |
| **Push** | Origin actively publishes to edge nodes ahead of demand | Lower first-byte latency, more moving parts |

The bucket becomes the **origin**; the CDN handles TLS termination, edge caching, range requests for video seeking, and absorbs the bulk of read traffic so the origin only serves cache misses. Cache invalidation on overwrite is the sharp edge here — versioned or content-hashed keys (`avatar-a1b2c3.png`) avoid the invalidation problem entirely because a changed file is simply a new key.

## Cheat sheet

- Object storage is **flat and immutable** — no partial in-place writes, no true directories.
- **Durability ≠ availability.** 11 nines durability still allows transient request failures.
- **Never proxy large files through your API** — use presigned URLs / SAS tokens for direct client-to-store transfer.
- Reconcile presigned uploads with a **storage event notification**, never trust the client callback alone.
- **Multipart upload** above ~100 MB: parallelism, resumability, per-part checksums.
- **Lifecycle policies** move cold data to cheaper tiers automatically — mention them for logs/backups.
- Put a **CDN** in front of read-heavy buckets; use content-hashed keys to sidestep invalidation.
- Design keys for your access pattern — avoid sequential prefixes that create hot partitions.

## Common mistakes

| Mistake | Fix |
|---|---|
| Storing files as blobs in a relational database | Store bytes in object storage, keep only the key + metadata in the DB |
| Streaming uploads/downloads through the API tier | Presigned URL / SAS token for direct client-to-store transfer |
| Treating "durable" as "always available" | Design retries; they are different guarantees |
| Trusting client-reported upload completion | Reconcile via storage event notifications or a sweep job |
| Sequential timestamp-prefixed keys at high write volume | Randomize/hash the prefix to spread load |
| No lifecycle policy on logs/backups | Auto-tier and expire with lifecycle rules |

## Summary

Object storage is the default home for anything that is not a row of structured data: it is cheap, nearly infinitely durable, and scales writes and reads far beyond what your API tier ever could. The interview signal is knowing to get out of the data path entirely — presigned URLs for upload and download, multipart for large or flaky-network transfers, storage events to keep metadata honest, lifecycle rules to control cost, and a CDN in front for read-heavy traffic. Get these five ideas right and the "handle large files" part of any design becomes a five-minute conversation instead of a design flaw.

## Top Interview Questions

### Q1. Why shouldn't you store uploaded files directly in your relational database?

Databases are optimized for structured, transactional, relatively small rows; storing multi-megabyte blobs bloats table size, slows backups and replication (every replica now copies the bytes too), and wastes an expensive, hard-to-scale resource on something object storage does far more cheaply. Object stores are purpose-built for this: they scale horizontally, offer 11-nines durability, tiered pricing, and native CDN integration. The correct pattern is to store the file in object storage and keep only the key, content-type, size and a status flag in the database — the database stays small and fast, and the object store handles the bytes.

### Q2. Walk me through a direct-to-storage upload flow and explain why you'd design it that way.

The client asks the API for permission to upload; the API validates the request (auth, file type, size limits) and returns a short-lived presigned URL or SAS token scoped to an exact key. The client then `PUT`s bytes straight to the object store — the API is never in the data path. Once done, the client notifies the API, which marks the record complete, but the API also subscribes to storage event notifications (S3 events, Event Grid `BlobCreated`) as a backup signal, because a crashed or malicious client cannot be trusted to always call back. This design keeps API compute and bandwidth costs flat regardless of file size and avoids tying up server threads for the duration of a slow upload.

### Q3. What is the difference between durability and availability, and why does it matter here?

Durability is the probability that data, once written, is never lost — object stores typically quote 99.999999999% (11 nines) because they replicate every object across multiple disks and zones. Availability is the probability that a request succeeds right now — typically 99.9%–99.99%, because it is affected by transient issues like network partitions, throttling, or a regional incident. An object can be perfectly durable (all copies intact) while momentarily unavailable (a `503` during an outage). This distinction matters for SLAs: don't promise "always accessible" based on a durability number, and design retries because a failed read does not mean lost data.

### Q4. How does multipart upload work, and when would you use it?

The file is split into parts (commonly tens of MB each), each uploaded independently with its own checksum via `UploadPart`, then stitched together with a `CompleteMultipartUpload` call that supplies the ordered list of part ETags. This is used above roughly 100 MB (S3 mandates it above 5 GB) because it enables parallel upload of parts for speed, resumability (a dropped connection only costs the failed part, not the whole file), and early corruption detection per part rather than one giant checksum at the end. A resumable client persists which part indices succeeded so it can retry only the gaps after a crash.

### Q5. Your metadata database says a file is uploaded, but it's not actually in the bucket. How did that happen, and how do you prevent it?

This is a **dual-write consistency** problem: the client called the "mark complete" API without the upload actually succeeding, the upload failed after the confirmation was sent, or a race let two systems disagree. Prevent it by never trusting the client's completion callback alone — subscribe to the object store's own event notifications (which fire only when the object genuinely exists) and use those to flip the status, or run a periodic reconciliation job that lists the bucket (or queries a change feed) and compares it against the database, flagging or cleaning up orphans in either direction.

### Q6. What's the difference between object, block, and file storage, and when would you pick each?

Block storage exposes raw, fixed-size blocks to an OS which lays a filesystem on top — used for VM disks and databases that need low-latency random read/write. File storage exposes a POSIX directory tree over a network protocol (NFS, Azure Files) — used when multiple machines need a shared, mutable filesystem view, often for legacy apps. Object storage exposes whole immutable objects over an HTTP API in a flat key space — used for anything write-once-read-many like images, video, backups and logs. The senior framing: pick block when you need a disk, file when you need a shared filesystem, object when you need to store and serve files at scale cheaply.

### Q7. How would you serve millions of avatar images cheaply and with low latency worldwide?

Store the images in object storage and put a CDN in front of the bucket as the public-facing origin, so the vast majority of reads are served from an edge cache close to the user and never touch the origin at all. Use content-hashed or versioned keys (`avatar-<hash>.png`) so that updating a user's avatar is just uploading a new key rather than overwriting one — this sidesteps cache invalidation entirely, since old edge-cached copies simply become unreferenced. Set long `Cache-Control` max-age headers since the keys are immutable, and let the CDN handle TLS termination and range requests.

### Q8. What is a lifecycle policy and why would an interviewer expect you to mention it?

A lifecycle policy is a rule engine on the bucket that automatically transitions or deletes objects based on age or last-access time, with zero application code — for example "move to Cool after 30 days, Archive after 180 days, delete after 7 years." It matters because any design with logs, backups, or old media accumulates data that is rarely read but still billed at hot-tier prices if left alone; mentioning lifecycle policies signals you think about cost at scale, not just correctness. It's a five-second addition to a design that shows operational maturity.

### Q9. Why is listing "all files in a folder" potentially a scalability problem in object storage?

Object stores have no real directories — a key like `users/42/avatar.png` is one flat string, and "listing a folder" is actually a **prefix scan** over sorted keys. If millions of objects share a common prefix (e.g. all keys start with today's date), listing becomes slow and can also create a **hot partition** internally if the store shards by key prefix, since sequential writes all land in the same range at the same time. The fix is to design keys around your access pattern — reverse or hash part of the key to spread writes, and avoid relying on listing as a query mechanism; keep an index (in a database or search engine) instead.

### Q10. A client uploads a 2 GB file over an unreliable mobile connection and it keeps failing partway through. What do you change?

Switch to multipart/chunked upload with client-side tracking of which chunks have been acknowledged. On a dropped connection, the client only needs to resend chunks that were not confirmed, not restart the whole 2 GB transfer. Use smaller part sizes on flaky networks to reduce the retry cost per failure, verify each part's checksum before acknowledging it, and keep the upload session id and progress persisted locally (or server-side) so the upload can resume even after the app is killed and restarted, not just after a transient network blip.

### Q11. What are presigned URLs and SAS tokens actually protecting against, and what could go wrong if misconfigured?

They grant a bearer of the URL temporary, scoped permission to perform one operation (usually PUT or GET) on one exact key, without exposing your long-lived storage credentials to the client. If misconfigured — too long a TTL, a wildcard key pattern, no max-content-length, or no content-type restriction — you've effectively handed out an open, anonymous write endpoint into your bucket that anyone who intercepts the URL can reuse repeatedly within the TTL window. The safe defaults are: minutes-long TTL, an exact key (not a prefix), an explicit size cap, and a restricted content-type, generated only after the API has authorized the specific request.

### Q12. How does a CDN in front of an object store change your caching and invalidation strategy?

Reads are served from edge locations close to the user on cache hit, and only cache misses fall through to the origin bucket, which drastically cuts origin bandwidth and latency for popular content. The catch is invalidation: if you overwrite an object at the same key, stale edge copies may still be served until TTL expiry or an explicit purge, which is slow and error-prone at scale. The standard fix is to make objects effectively immutable by using content-hashed or versioned keys for anything that changes, so an "update" is really a new key with a new URL, and old cached copies simply age out naturally rather than needing active invalidation.
