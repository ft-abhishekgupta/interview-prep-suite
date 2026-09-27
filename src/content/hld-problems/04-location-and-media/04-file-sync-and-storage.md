---
title: Design File Sync and Storage
description: How to design a Dropbox-style file sync platform that handles huge files, syncs across devices, and keeps data secure and fast
difficulty: Core
tags: [storage, chunked-upload, sync, encryption]
---

A file sync and storage platform lets a user upload a file from one device, have it automatically appear on every other device they own, download it back, and share it with other users — all while treating multi-gigabyte files and unreliable networks as the normal case, not the exception.

## Requirements

![alt text](notes/HLD/Problems/Dropbox/image.png)

### Functional

- Users can upload a file from any device.
- Users can download a file from any device.
- Users can share a file with other users.
- Files automatically sync across all of a user's devices.

### Non-functional

- Uploads, downloads, and sync must stay fast even for very large files.
- The system must support large files reliably over unreliable networks (mobile, flaky Wi-Fi).
- File data must be secure: encrypted in transit and at rest, with access control on sharing.
- Sync should be near real time — a change on one device should reach other devices within seconds to a couple of minutes.

### Out of scope

- Real-time collaborative editing of the same file (like a shared document editor).
- Full version history/diffing UI.
- Payment/billing for storage tiers.

## Scale estimation

| Metric | Assumption | Working | Result |
|---|---|---|---|
| DAU | given | given | 50M |
| Uploads / user / day | 2 avg | 50M × 2 | 100M uploads/day |
| Downloads / user / day | 5 avg | 50M × 5 | 250M downloads/day |
| Write QPS (avg) | 100M / 86,400s | 100,000,000 / 86,400 | ~1,160/sec |
| Write QPS (peak) | 3× average | 1,160 × 3 | ~3,500/sec |
| Read QPS (avg) | 250M / 86,400s | 250,000,000 / 86,400 | ~2,900/sec |
| Read QPS (peak) | 3× average | 2,900 × 3 | ~8,700/sec |
| Read : write ratio | 2,900 : 1,160 | — | ~2.5 : 1 |
| Avg file size (blended) | 4MB assumption | given | 4MB |
| Daily upload storage (raw) | 100M × 4MB | 100,000,000 × 4MB | ~400TB/day |
| Daily upload storage (after ~30% compression) | 400TB × 0.7 | 400TB × 0.7 | ~280TB/day |
| Peak upload bandwidth | 3,500 × 4MB | 3,500 × 4MB | ~14GB/s |

> [!TIP]
> Unlike a feed or a chat system, this platform isn't dominated by a huge read:write skew — it's dominated by file *size*. A 2.5:1 read:write ratio is unremarkable; the hard part is that any single request, upload or download, can carry gigabytes, which changes how every endpoint has to be built.

## Core entities and data model

| Entity | Key fields |
|---|---|
| `User` | `user_id`, `email` |
| `Device` | `device_id`, `user_id`, `last_synced_at` |
| `File` | `file_id`, `owner_id`, `name`, `size`, `storage_url`, `version`, `updated_at` |
| `Share` | `file_id`, `shared_with_user_id`, `permission` |
| `ChangeEvent` | `event_id`, `user_id`, `file_id`, `action` (created/updated/deleted), `timestamp` |

![alt text](notes/HLD/Problems/Dropbox/image-1.png)

```mermaid
erDiagram
    USER ||--o{ DEVICE : owns
    USER ||--o{ FILE : owns
    FILE ||--o{ SHARE : shared_via
    USER ||--o{ SHARE : receives
    FILE ||--o{ CHANGEEVENT : generates
    FILE {
        string file_id
        string owner_id
        string name
        bigint size
        int version
    }
    CHANGEEVENT {
        string event_id
        string file_id
        string action
        datetime timestamp
    }
```

`File` stores metadata only — name, size, a pointer (`storage_url`) to the actual bytes in object storage, and a `version` used to detect conflicting concurrent edits. `Share` is deliberately its own table rather than a field on `File`, because a file can be shared with an unbounded number of users and needs its own access-control lookups independent of the owner's file list. `ChangeEvent` is the backbone of sync — every mutation appends one, and devices catch up by reading events since their last known timestamp rather than re-scanning the whole file tree.

## API design

```
POST /files
Request:
{
  File,
  FileMetadata
}

GET /files/{fileId} -> File & FileMetadata

POST /files/{fileId}/share
Request:
{
  User[] // The users to share the file with
}

GET /files/changes?since={timestamp} -> ChangeEvent[]
```

The `changes` endpoint is what every device polls (or subscribes to) to sync: rather than re-downloading a full file listing, a device asks "what changed since the last time I checked" and only pulls the deltas.

## High level architecture

```mermaid
flowchart LR
    D1["Device A"] --> GW["API Gateway"]
    D2["Device B"] --> GW
    GW --> FS["File Service"]
    FS --> META[("File Metadata DB")]
    FS --> OBJ[("Object Storage<br/>(chunked)")]
    FS --> CE[("Change Event Log")]
    D2 -.->|"poll/subscribe"| CE
```

1. **Upload:** a device sends a file (chunked for large files) to the file service, which streams chunks into object storage and, once complete, writes a `File` metadata row and appends a `ChangeEvent`.
2. **Download:** a device requests `GET /files/{fileId}`; the file service returns metadata plus a storage URL, and the device streams the bytes (in chunks, resumable) directly from storage.
3. **Sync:** every other device belonging to that user (or with share access) polls `GET /files/changes?since=...` on an interval, sees the new `ChangeEvent`, and pulls the updated file.
4. **Share:** the owner calls `POST /files/{fileId}/share` with a list of users; the file service writes rows into the `Share` table, and a `ChangeEvent` is appended so the newly-shared users' devices pick up the file on their next sync.

### Users should be able to upload a file from any device

![alt text](notes/HLD/Problems/Dropbox/image-2.png)

### Users should be able to download a file from any device

![alt text](notes/HLD/Problems/Dropbox/image-3.png)

### Users should be able to share a file with other users

Sharing is backed by a separate table dedicated to the shared-file list, rather than a field on the file itself, precisely because a file's sharing relationships are their own many-to-many structure independent of ownership.

### Users can automatically sync files across devices

![alt text](notes/HLD/Problems/Dropbox/image-4.png)

## Deep dive: supporting very large files

A multi-gigabyte file cannot be uploaded as a single request over a mobile network without an unacceptable risk of failure. The solution has several parts working together:

- **Client-side chunking** — the file is split into fixed-size chunks before upload, each sent as its own request.
- **Resumable state in the database** — the server tracks which chunks have been received for a given upload, so a client that disconnects mid-upload can query what's missing and resume rather than restarting.
- **Server-side chunk verification** — each chunk is verified (e.g. an ETag comparison) against object storage to detect corruption or a partial write before it's accepted as complete.
- **Multipart completion** — once all chunks are present and verified, the object store's own multipart-upload completion call (e.g. S3's `CompleteMultipartUpload`) stitches the chunks together into the final object.

![alt text](notes/HLD/Problems/Dropbox/image-5.png)

> [!KEY]
> The resumable-state table is what actually delivers reliability here — without it, a chunked upload is still all-or-nothing from the client's perspective on reconnect, since it has no way to know which chunks the server already has.

## Deep dive: keeping uploads, downloads, and sync fast

Beyond chunking, compressing file data before transfer reduces the bytes that actually need to move over the network on both upload and download, which matters most on constrained connections. Compression is applied client-side before chunks are sent and the file service stores the compressed form, decompressing (or letting the client decompress) on download.

## Deep dive: file security

Three layers apply together, not as alternatives: **encryption in transit** (TLS on every client-server connection, upload and download alike), **encryption at rest** (files encrypted once stored in object storage, so a storage-layer breach doesn't expose raw file contents), and **access control** (every read or share operation checks the requesting user against the file's owner and `Share` table before returning data or a storage URL).

> [!WARNING]
> Encryption at rest protects against a storage breach, but it does nothing if access control is weak — a compromised or overly permissive share grant still exposes the decrypted content to whoever holds it. Access control has to be checked on every read, not just enforced at share-creation time.

## Bottlenecks and scaling

- **Object storage throughput on popular files** — files shared with many users can see download hot-spotting; front frequently-accessed files with a CDN or cache layer.
- **Chunk upload concurrency** — allow multiple chunks of the same file to upload in parallel from the client to cut total upload time, provided the resumable-state tracking can handle out-of-order chunk arrival.
- **Change event log growth** — trim or archive old change events once all active devices have synced past them; a device that's been offline for a very long time can fall back to a full metadata re-sync instead of replaying an unbounded event history.
- **Metadata database hot rows** — a heavily shared file's metadata row gets read by every collaborator's sync poll; cache metadata reads separately from the authoritative row.

## Failure scenarios

| Failure | Blast radius | Mitigation |
|---|---|---|
| Upload interrupted mid-transfer | Partial file, no data loss | Resumable chunk state lets the client resume from the last confirmed chunk |
| Object storage region outage | Uploads/downloads fail in that region | Multi-region storage with client failover to the nearest healthy region |
| Change event log unavailable | Devices can't detect new changes | Devices fall back to a full metadata comparison against their local state until the log recovers |
| Metadata database write failure | New file or share record not persisted | Client-visible upload failure with retry; chunk data already in object storage isn't lost and can be re-attached on retry |

## Cheat sheet

- Split `File` metadata (small, queried often) from the actual bytes (large, in object storage) — same principle as any large-media system.
- Chunk large files client-side; track chunk-receipt state server-side so uploads are resumable, not all-or-nothing.
- Use the object store's own multipart-completion API to stitch verified chunks into the final object.
- Sync is a change-log problem: devices ask "what changed since X," not "give me everything."
- Compress before transfer to cut both upload and download time on constrained networks.
- Encryption in transit and at rest are both necessary but neither substitutes for access control on every read.

## Common mistakes

| Mistake | Fix |
|---|---|
| Uploading large files as a single request | Chunk client-side and track resumable state so a network blip doesn't restart the whole transfer |
| Devices re-scanning the full file tree to detect changes | Use a change event log with a `since` cursor so sync only pulls deltas |
| Storing file bytes directly in the metadata database | Keep bytes in object storage; the database only holds a pointer plus metadata |
| Treating encryption at rest as sufficient security on its own | Enforce access control on every read/share check; encryption alone doesn't stop an authorized-looking request |
| A single sharing field on the file row | Use a dedicated `Share` table for the many-to-many owner-to-shared-user relationship |

## Summary

File sync and storage is fundamentally a large-object-handling problem layered under a straightforward CRUD-and-sharing API. Chunked, resumable uploads with server-side verification make huge files reliable over unreliable networks; splitting metadata from bytes keeps the database fast while object storage does what it's good at; a change-event log turns "sync" into a cheap incremental pull instead of a full re-scan; and compression, transit/at-rest encryption, and per-read access control round out performance and security. None of these pieces is exotic on its own — the design is in making them work together for files that can be gigabytes in size.

## Final design

![alt text](notes/HLD/Problems/Dropbox/image-6.png)

## Top Interview Questions

### Q1. Why chunk large file uploads instead of sending the file as one request?

A single request carrying a multi-gigabyte file is fragile: any network interruption means the entire upload has to restart from zero, which is unacceptable on mobile or flaky connections. Chunking splits the file into independently uploadable pieces; if one chunk fails, only that chunk needs retrying. Combined with server-side tracking of which chunks have already been received, a client that disconnects mid-upload can query what's missing and resume instead of restarting, which is the actual reliability win — chunking alone doesn't give you resumability without that state.

### Q2. How does the server verify that uploaded chunks are correct before assembling the final file?

Each chunk is checked against object storage using a mechanism like an ETag comparison, confirming the chunk's content matches what the client claims to have sent, before it's marked as received. Once all chunks for a file are present and verified, the object store's own multipart-upload completion API (for example, S3's `CompleteMultipartUpload`) stitches them together into the final object. This offloads the actual byte-assembly work to the storage layer, which is built for exactly this operation.

### Q3. How does the sync mechanism let a device efficiently know what changed since it was last online?

Every mutation (create, update, delete, share) appends a row to a `ChangeEvent` log alongside a timestamp. A device that comes back online calls `GET /files/changes?since={timestamp}` with the last timestamp it successfully processed, and gets back exactly the events it missed — an incremental pull rather than re-scanning the entire file tree or metadata store. This scales with the number of actual changes rather than with the total size of a user's file collection.

### Q4. Why keep `File` metadata separate from the actual file bytes?

Metadata (name, size, version, owner) is small, frequently read and updated, and well-suited to a relational or document database. File bytes are large, effectively immutable once uploaded, and belong in object storage designed for exactly that. Keeping them separate means metadata queries (listing files, checking sync state) never have to touch large blobs, and object storage can independently scale, replicate, and serve file bytes without the metadata database becoming a bottleneck.

### Q5. Why is sharing modeled as its own `Share` table rather than a field on the `File` record?

A file can be shared with an arbitrary number of other users, which is a many-to-many relationship, not a single value that fits on the file's own row. A dedicated `Share` table (`file_id`, `shared_with_user_id`, `permission`) lets access-control checks and "files shared with me" queries run efficiently as indexed lookups, and lets sharing be revoked or modified for one user without touching the file's core metadata or affecting other collaborators.

### Q6. What does "encryption in transit" and "encryption at rest" each actually protect against, and is either sufficient alone?

Encryption in transit (TLS) protects data as it moves between the client and the servers, preventing interception on the network. Encryption at rest protects the stored file bytes in object storage, so a breach of the storage layer itself doesn't expose raw content. Neither is sufficient alone: transit encryption doesn't help if the stored data itself is unencrypted and the storage layer is compromised, and at-rest encryption doesn't help if access control is weak and an unauthorized request is simply granted a decrypted read. All three — transit encryption, at-rest encryption, and per-request access control — are required together.

### Q7. How would you support offline editing on a device and reconcile changes once it reconnects?

The device keeps working against its local copy while offline, queuing its own changes locally. On reconnect, it first pulls `GET /files/changes?since={last_synced_at}` to see what changed on the server while it was offline, then pushes its own queued changes. If both the server and the offline device modified the same file, the `version` field on `File` detects the conflict (the device's base version no longer matches the server's current version), and the client either merges or prompts for conflict resolution rather than silently overwriting the other device's change.

### Q8. Why is compression applied before chunking/upload rather than left to the transport layer?

Compressing at the application layer, before the data is chunked and sent, reduces the actual number of bytes that need to traverse the network on constrained connections, directly cutting upload and download time regardless of what the underlying transport does. Relying solely on transport-layer compression (if present at all) doesn't give the same control over trade-offs like compression ratio versus CPU cost, which the application can tune per file type (e.g., skipping compression for already-compressed formats like JPEGs or MP4s).

### Q9. A file is shared with 500 users and becomes a download hotspot — what would you change?

The metadata row for that file gets read by every collaborator's sync poll and every download request references the same object-storage location. Caching the file's metadata separately from the authoritative database row reduces read pressure there, and fronting the actual bytes with a CDN or cache layer for popular/shared files reduces load on the primary object storage path — the same pattern used for any hot, frequently-read large object, regardless of whether it's a file, an image, or a video.

### Q10. How do you keep the change event log from growing without bound, and what happens to a device that's been offline for months?

Old change events can be trimmed or archived once every currently-active device has synced past them, since nothing needs to replay history nobody will ever request again. For a device that's been offline long enough that its last-known timestamp falls outside the retained window, the system falls back to a full metadata comparison — the device fetches the current full file listing and diffs it locally against its last known state — rather than the system trying to preserve an unbounded incremental history indefinitely.
