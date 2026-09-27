---
title: Blob Storage and AI Search
description: Storage account redundancy and access tiers, SAS token scoping, and how Azure AI Search indexes, skillsets and vector search fit together
difficulty: Core
tags: [azure, blob-storage, ai-search, storage]
---

Blob Storage is the substrate almost every Azure architecture eventually touches — files, backups, static assets, data lake landing zones — and Azure AI Search is the layer that makes that unstructured content findable. Interviewers use this pairing to test whether you understand durability trade-offs, least-privilege access, and when "just query the database" stops being good enough.

## Storage account redundancy options

| Option | Copies | Durability | Failover behaviour |
|---|---|---|---|
| **LRS** (Locally redundant) | 3 copies in one datacenter | 11 nines | No protection against datacenter loss |
| **ZRS** (Zone-redundant) | 3 copies across availability zones in one region | 12 nines | Survives a datacenter/zone failure; no cross-region protection |
| **GRS** (Geo-redundant) | LRS in primary + async-replicated LRS copy in paired region | 16 nines | Secondary region data is not readable until Microsoft-initiated failover |
| **RA-GRS** (Read-access geo-redundant) | Same as GRS | 16 nines | Secondary region is readable at all times via a `-secondary` endpoint, even before failover |
| **GZRS / RA-GZRS** | ZRS in primary + geo-replicated to secondary region | Highest | Combines zone resilience in-region with geo-redundancy |

> [!KEY]
> GRS protects against a *regional* disaster but the secondary copy is not readable until Microsoft actually fails over the account — if you need to read from the secondary region proactively (e.g. for read scale-out or to validate DR readiness), you need **RA-GRS**, not plain GRS.

## Blob types

| Type | Structure | Use case |
|---|---|---|
| **Block blob** | Composed of blocks, optimised for large sequential uploads/downloads | Files, images, video, backups — the default choice |
| **Append blob** | Optimised for append-only writes | Logging, audit trails, streaming writes from many sources |
| **Page blob** | Random read/write in 512-byte pages | VHD/VM disks (Azure VM disks are page blobs under the hood) |

## Access tiers and lifecycle management

| Tier | Storage cost | Access/retrieval cost | Minimum retention |
|---|---|---|---|
| **Hot** | Highest | Lowest | None |
| **Cool** | Lower | Higher, plus per-GB retrieval fee | 30 days |
| **Cold** | Lower still | Higher again | 90 days |
| **Archive** | Lowest | Highest, plus **rehydration delay** (hours) before the blob is readable again | 180 days |

A **lifecycle management policy** automatically moves blobs between tiers (or deletes them) based on rules like "move to Cool after 30 days of no access, Archive after 90, delete after 365" — essential for cost control on large accounts, since manually tiering blobs doesn't scale.

```json
{
  "rules": [{
    "name": "archiveOldLogs",
    "type": "Lifecycle",
    "definition": {
      "filters": { "blobTypes": ["blockBlob"], "prefixMatch": ["logs/"] },
      "actions": {
        "baseBlob": {
          "tierToCool": { "daysAfterModificationGreaterThan": 30 },
          "tierToArchive": { "daysAfterModificationGreaterThan": 90 },
          "delete": { "daysAfterModificationGreaterThan": 365 }
        }
      }
    }
  }]
}
```

> [!WARNING]
> Archive-tier blobs cannot be read directly — you must issue a rehydration request and wait (standard priority: up to 15 hours; high priority: often under 1 hour) before the blob is accessible again. Reaching for Archive on data with any realistic chance of an urgent read is a production incident waiting to happen.

## SAS tokens and least privilege

| SAS type | Scope | Use when |
|---|---|---|
| **User delegation SAS** | Signed with Microsoft Entra ID credentials, scoped to a specific principal's RBAC permissions | Preferred for most scenarios — revocable via Entra ID, no shared key exposure |
| **Service SAS** | Signed with the storage account key, scoped to one container/blob | Legacy or when Entra ID auth isn't available; revoking requires rotating the account key (affects all SAS signed with it) |
| **Account SAS** | Signed with the account key, can span multiple services/containers | Broadest scope — avoid unless genuinely needed; hardest to reason about for least privilege |

```csharp
// User delegation SAS — least privilege, short-lived, revocable via Entra ID
var userDelegationKey = await blobServiceClient.GetUserDelegationKeyAsync(
    DateTimeOffset.UtcNow, DateTimeOffset.UtcNow.AddHours(1));

var sasBuilder = new BlobSasBuilder
{
    BlobContainerName = "uploads",
    BlobName = blobName,
    Resource = "b",
    ExpiresOn = DateTimeOffset.UtcNow.AddMinutes(15)
};
sasBuilder.SetPermissions(BlobSasPermissions.Write);

string sasUri = new BlobUriBuilder(blobClient.Uri)
{
    Sas = sasBuilder.ToSasQueryParameters(userDelegationKey, blobServiceClient.AccountName)
}.ToUri().ToString();
```

> [!TIP]
> Always name the three SAS scoping levers out loud: **permission** (read/write/list — never grant more than needed), **time window** (minutes, not days), and **IP/protocol restriction** (`https` only, optionally an IP range). That's what "least privilege SAS" means in practice, not just "use a SAS instead of the account key".

## Direct browser upload and static website hosting

A common pattern: the browser uploads directly to Blob Storage using a short-lived, write-only SAS issued by your API, bypassing your app servers entirely for the (often large) file payload.

```mermaid
sequenceDiagram
    participant Browser
    participant Api as "API"
    participant Blob as "Blob Storage"
    Browser->>Api: "Request upload URL"
    Api->>Blob: "Generate user delegation SAS (write, 15 min)"
    Api-->>Browser: "SAS URL"
    Browser->>Blob: "PUT file directly"
    Browser->>Api: "Notify upload complete"
```

Static website hosting (`$web` container) serves blobs directly as a website with a public endpoint — useful for SPA hosting or public documentation without standing up a web server, typically fronted by a CDN for caching and custom domains.

## Immutability and soft delete

- **Soft delete** (blob and container level) keeps deleted/overwritten data recoverable for a configured retention period — protects against accidental deletion or application bugs.
- **Immutability policies** (time-based retention or legal hold) make blobs **WORM** (write once, read many) — required for regulatory compliance (e.g. financial records) where even an account owner cannot delete or modify data until the retention period expires.

> [!DANGER]
> Immutability policies with time-based retention **cannot be shortened or removed** once locked, only extended — locking a policy with the wrong retention period is effectively permanent. Always validate the retention requirement before locking, not after.

## Azure AI Search fundamentals

Azure AI Search (formerly Cognitive Search) is a managed search-as-a-service: it builds and queries an **index** — a schema of searchable, filterable, sortable, facetable fields — decoupled from your source data.

```mermaid
flowchart LR
    Src[("Data source<br/>(Blob, SQL, Cosmos)")] --> Idxr["Indexer"]
    Idxr --> Skill["Skillset<br/>(OCR, entity extraction, embeddings)"]
    Skill --> Idx[("Search index")]
    Idx --> Query["Query<br/>(keyword + vector + semantic)"]
```

| Concept | Purpose |
|---|---|
| **Index** | The searchable schema — fields, their types, and which are searchable/filterable/facetable/sortable |
| **Indexer** | Pulls data from a source (Blob, Cosmos DB, SQL) on a schedule or on change, mapping it into index documents |
| **Skillset** | A pipeline of AI enrichment steps (OCR, key phrase extraction, entity recognition, image analysis, custom embeddings) applied during indexing |
| **Analyzer** | Controls tokenization and linguistic processing (stemming, stop words, language-specific rules) for text fields |

## Semantic ranking, vector search and hybrid search

| Mode | How it works | Best for |
|---|---|---|
| **Keyword (full-text)** | Classic inverted-index term matching with BM25 ranking | Exact terms, filters, well-structured queries |
| **Vector search** | Nearest-neighbour search over embeddings (from an embedding model) capturing semantic meaning | "Find conceptually similar" queries, no exact keyword overlap needed |
| **Hybrid** | Runs keyword and vector search together, merges results (often with Reciprocal Rank Fusion) | Best of both — most production RAG/search systems default here |
| **Semantic ranking** | An additional re-ranking pass over top results using a language model to reorder by relevance to natural-language intent | Improves ranking quality for conversational/natural-language queries, applied on top of keyword or hybrid results |

Vector search finds meaning, keyword search finds exact terms, and hybrid search combines both because real queries usually need a bit of each — a user searching "cheap laptop for students" wants both the semantic concept and to match a filter like `price < 500`.

## When to use AI Search over a database query

Reach for AI Search when the access pattern is genuinely search-shaped: free-text queries over unstructured or semi-structured content, ranking by relevance rather than exact match, faceted filtering across many dimensions, typo tolerance, or semantic/conceptual matching — none of which a relational or document database's `WHERE`/`LIKE` clause does well or efficiently at scale. Stick with a direct database query when access patterns are exact-match or range-based lookups on structured fields with known query shapes — adding a search index there is unnecessary operational overhead for no relevance benefit.

## Cheat sheet

- Redundancy ladder: **LRS** (in-datacenter) → **ZRS** (zone-redundant) → **GRS** (geo, unreadable secondary) → **RA-GRS** (geo, readable secondary) → **GZRS/RA-GZRS** (both).
- Blob types: **block** (general files), **append** (logs), **page** (VM disks).
- Tiers: **Hot → Cool → Cold → Archive** trade storage cost for retrieval cost and, at Archive, a rehydration delay.
- Lifecycle policies automate tiering/deletion — don't hand-manage tiers at scale.
- SAS: prefer **user delegation SAS** (Entra ID-backed, revocable); always scope permission, time window, and protocol/IP.
- Direct browser upload = short-lived write-only SAS issued by the API, bypassing app servers for the payload.
- **Soft delete** protects against accidental deletion; **immutability policies** are compliance-grade WORM and can only be extended, never shortened, once locked.
- AI Search building blocks: **index** (schema), **indexer** (pulls data), **skillset** (AI enrichment), **analyzer** (tokenization).
- **Hybrid search** (keyword + vector) plus **semantic ranking** is the default modern pattern for relevance-sensitive search.

## Common mistakes

| Mistake | Fix |
|---|---|
| Choosing GRS expecting to read the secondary region | Use RA-GRS if proactive secondary reads are needed |
| Archiving data with any chance of urgent access | Reserve Archive tier for genuinely cold, non-urgent data; account for rehydration delay |
| Using account SAS or the account key for browser uploads | Use a short-lived, permission-scoped user delegation SAS |
| Locking an immutability policy before validating retention length | Test with an unlocked policy first; locking is (mostly) irreversible |
| Building full-text search with `LIKE '%term%'` queries at scale | Use Azure AI Search for relevance-ranked, facilitated, or semantic search needs |
| Treating vector search as a full replacement for keyword search | Use hybrid search — exact terms and filters still matter for most real queries |

## Summary

Blob Storage's redundancy options, access tiers, and SAS model are all about matching cost and access guarantees to how data is actually read — durability increases from LRS to RA-GZRS, retrieval cost and latency increase from Hot to Archive, and least-privilege access means scoping SAS tokens by permission, time, and network restriction, preferring user delegation SAS wherever possible. Azure AI Search complements this by making unstructured and semi-structured content genuinely searchable — indexers and skillsets build the index, and hybrid search combining keyword and vector matching with semantic ranking is the modern default for relevance-sensitive queries that a plain database `WHERE` clause was never designed to serve.

## Top Interview Questions

### Q1. Explain the difference between LRS, ZRS, GRS and RA-GRS.

LRS (locally redundant storage) keeps three synchronous copies within a single datacenter — protects against disk/node failure but not a datacenter outage. ZRS (zone-redundant) spreads three copies across availability zones within the same region, protecting against a datacenter-level failure while keeping data in-region. GRS (geo-redundant) adds an asynchronously-replicated LRS copy in a paired region for disaster recovery, but that secondary copy is not accessible for reads until Microsoft actually triggers an account failover. RA-GRS (read-access geo-redundant) is the same replication as GRS but exposes the secondary region for reads at all times via a separate `-secondary` endpoint, which is what you need if you want to use the secondary region proactively (read scale-out, DR validation) rather than only after an official failover.

### Q2. What's the practical difference between block blobs, append blobs, and page blobs?

Block blobs are composed of independently uploadable blocks that get committed together, optimised for large sequential reads/writes — the default choice for files, images, videos, and backups. Append blobs are optimised specifically for append-only operations, where new data is always added to the end and existing data is never modified — ideal for logging and audit trail scenarios where many writers continuously add entries. Page blobs support random read/write access in fixed 512-byte pages and are the underlying storage format for Azure VM disks (VHDs), since a VM disk needs to support random access reads/writes anywhere in the file, not just sequential appends. Choosing the wrong type isn't just a performance detail — append blobs, for instance, don't support arbitrary overwrites at all, so trying to use one as a general file store will fail outright for many operations.

### Q3. Walk through the access tiers and why Archive tier requires special handling.

Hot, Cool, Cold, and Archive form a ladder trading storage cost against access cost: Hot has the highest storage cost but cheapest/fastest access, suited to frequently accessed data; Cool and Cold progressively lower storage cost but add per-GB retrieval fees and are intended for infrequently accessed data with minimum retention periods (30 and 90 days respectively, with early-deletion penalties if you move data out sooner); Archive has the lowest storage cost but data is **not directly readable** — accessing it requires an explicit rehydration request, which can take up to 15 hours at standard priority (often under an hour at high priority) before the blob becomes readable. This makes Archive appropriate only for data with no realistic chance of urgent access — compliance archives, old backups — never for anything that might need to be read on short notice, since the rehydration delay is a hard architectural constraint, not a minor inconvenience.

### Q4. What are the three types of SAS tokens, and which should you default to?

Account SAS is signed with the storage account key and can grant access across multiple services and containers — broadest scope, hardest to reason about for least privilege, and revoking it requires rotating the account key (which invalidates every SAS signed with that key). Service SAS is also signed with the account key but scoped to a single container or blob with specific permissions — narrower, but shares the same key-rotation revocation problem. User delegation SAS is signed using Microsoft Entra ID credentials instead of the account key, scoped to whatever RBAC permissions the requesting principal actually has, and can be revoked by removing that principal's role assignment without touching the storage account key at all. User delegation SAS should be the default wherever Entra ID authentication is available, since it avoids ever distributing or embedding the account key, and offers far more granular, auditable revocation.

### Q5. Design a direct-to-blob upload flow for large user file uploads, and explain why you wouldn't route the file through your API.

The API should never proxy the raw file bytes for large uploads — that ties up API compute and bandwidth on pure data transfer it adds no value to. Instead, the browser requests an upload authorization from the API, which generates a short-lived (minutes, not hours), write-only, blob-scoped user delegation SAS URL and returns it to the browser; the browser then uploads the file directly to Blob Storage using that SAS URL via a PUT request, and finally notifies the API that the upload completed (so the API can validate the blob exists, scan/process it, and update application state). This keeps the API layer stateless with respect to file bytes, scales upload throughput independently of API compute, and — because the SAS is scoped to write-only, one blob, and a short expiry — limits the blast radius if the URL were somehow leaked.

### Q6. What's the difference between soft delete and an immutability policy, and why would you need both?

Soft delete is a recovery safety net against accidental or buggy deletion/overwrite — deleted or overwritten blobs are retained for a configured period and can be undeleted, but an authorized user or application can still delete them permanently within that window if they choose to (or the retention period can itself be shortened). An immutability policy enforces true WORM (write once, read many) semantics — once applied (and especially once "locked"), not even the storage account owner can delete or modify the blob until the retention period expires, which is what regulatory compliance for records like financial transactions or legal holds actually requires. You'd want both in a compliance-sensitive system: soft delete as a general safety net against operational mistakes across the account, and immutability policies specifically on the subset of data that has a hard regulatory retention requirement, since immutability is far less forgiving of misconfiguration (a locked time-based retention policy can only be extended, never shortened).

### Q7. What is a skillset in Azure AI Search, and give an example of when you'd need one?

A skillset is a pipeline of AI enrichment steps applied to source documents during indexing, run by an indexer before the enriched output is written into the search index. Each skill performs one transformation — OCR to extract text from scanned images/PDFs, key phrase extraction, entity recognition (people, organizations, locations), language detection, image captioning, or generating vector embeddings for semantic search — and skills can be chained, with one skill's output feeding the next. A concrete example: indexing a document library of scanned contracts stored as PDFs in Blob Storage — a skillset would run OCR to extract text from the scanned pages, then entity recognition to pull out party names and dates, then an embedding skill to generate vectors for semantic search, all before the resulting structured, searchable fields land in the index.

### Q8. Explain hybrid search and why it usually beats pure keyword or pure vector search alone.

Hybrid search runs a keyword (full-text, BM25-ranked) query and a vector (embedding-based nearest-neighbour) query against the same request, then merges and re-ranks the combined result set, typically using an algorithm like Reciprocal Rank Fusion. Pure keyword search is precise for exact terms, codes, names, and filters, but misses semantically related content that doesn't share vocabulary (searching "affordable" won't match a document that only says "budget-friendly"). Pure vector search captures that semantic similarity well but can miss exact, specific terms that matter a lot to the user (a product SKU, an exact date, a proper noun) because embeddings compress meaning and can under-weight specific tokens. Hybrid search gets both: exact-match precision where it matters and semantic recall where vocabulary differs, which is why most production RAG and enterprise search systems default to hybrid rather than either mode alone.

### Q9. What is semantic ranking, and how is it different from vector search?

Semantic ranking is a re-ranking step applied *after* an initial retrieval (keyword, vector, or hybrid) has already produced a candidate set of top results — it uses a language model to re-score and reorder those candidates based on how well they answer the actual natural-language intent of the query, going beyond both term-frequency and raw embedding-distance signals. Vector search, by contrast, is a retrieval mechanism itself — it's how you find semantically similar candidates from a potentially huge index in the first place, using approximate nearest-neighbour search over embeddings. In practice they're complementary and often used together: vector (or hybrid) search retrieves a reasonably-sized candidate set efficiently at index scale, and semantic ranking then applies more expensive, higher-quality relevance scoring to just that smaller set to improve the final ordering shown to the user.

### Q10. When would you choose Azure AI Search over just querying your database directly?

When the access pattern is genuinely search-shaped rather than lookup-shaped: free-text queries over unstructured or semi-structured content, relevance ranking rather than exact match, typo tolerance, faceted filtering across many combined dimensions, or semantic/conceptual matching where the user's words don't literally appear in the data. A database `WHERE column LIKE '%term%'` query doesn't scale well, has no relevance ranking, no typo tolerance, and no semantic understanding — it's fine for small datasets or truly exact-match lookups, but breaks down as a genuine search experience at any real scale or content richness. Conversely, if your actual access pattern is "get this specific record by ID" or "filter by exact status and date range" on structured data, adding a search index is unnecessary operational overhead with no relevance benefit — the database index already serves that pattern efficiently.

### Q11. A team wants to enable an immutability policy on a container holding financial records — what would you ask before they lock it?

I'd confirm the exact regulatory retention requirement first, since a locked time-based retention policy can only be **extended**, never shortened — locking it with too long a retention period is effectively permanent and can only be fixed by extending further, and locking with too short a period defeats the compliance purpose entirely. I'd ask whether they need a legal hold (indefinite, manually released) versus a fixed time-based retention period, since these serve different compliance scenarios and can be combined. I'd also confirm whether they've tested behavior with an **unlocked** policy first — unlocked policies can still be modified or removed, which is the safe way to validate application behavior against the immutability constraints (e.g. confirming no code path tries to overwrite or delete these blobs before the retention period) before committing to a locked, effectively irreversible policy.

### Q12. How would you design the ingest-and-search pipeline for a document management system that needs to search across scanned PDFs, structured metadata, and needs both exact and conceptual matching?

Documents land in Blob Storage as the source of truth, with structured metadata (author, department, upload date, tags) stored either alongside as blob metadata or in a companion database/Cosmos container. An Azure AI Search indexer is configured against Blob Storage (and the metadata source, if separate) on a schedule or via change detection, running a skillset that performs OCR to extract text from scanned PDF pages, entity/key-phrase extraction for automatic tagging, and an embedding skill to generate vectors from the extracted text for semantic search. The resulting index combines searchable full text, filterable/facetable structured metadata fields, and a vector field — supporting hybrid search (keyword plus vector) for the actual query experience, with semantic ranking applied on top of the merged results to prioritize documents that best match the user's natural-language intent, while structured metadata fields support precise filtering (department, date range) alongside the free-text and semantic matching.
