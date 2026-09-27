---
title: Design a Payment System
description: How to design a payment processing system that never double-charges or loses money, using idempotency keys, a double-entry ledger, and reconciliation
difficulty: Advanced
tags: [system-design, payments, ledger, idempotency]
---

A payment system lets merchants accept money from customers without building their own connection to card networks and banks. The entire design exists to answer one question with certainty: for every dollar that moves, can you prove exactly where it went, exactly once?

## Requirements

The functional scope is small on paper — create an intent, charge it, refund it, notify the merchant — which is exactly why it's worth sketching explicitly, since almost all the real complexity lives in the non-functional column next to it:

![alt text](notes/HLD/Problems/PaymentSystem/image.png)

### Functional

- Merchants create a payment intent and charge a customer's payment method.
- Support refunds against a prior charge.
- Notify merchants of payment events via webhooks.
- Expose transaction status and history for lookup.

### Non-functional

- No transaction is ever lost, even across process crashes or network failures — durability and auditability are non-negotiable.
- Effectively-once money movement: never double-charge, never silently drop a charge.
- High throughput, target 10,000+ TPS at peak.
- Security: minimize the scope of raw card data ever touching your own servers (PCI DSS).

### Out of scope

- Fraud detection ML models.
- Currency conversion/FX rate logic.
- Tax calculation.

## Scale estimation

| Metric | Assumption | Working | Result |
|---|---|---|---|
| Average TPS | steady-state | given | ~2,000 TPS |
| Peak TPS | requirement | given | 10,000 TPS |
| Transactions/day | 2,000 TPS × 86,400s | 2,000 × 86,400 | ~173M/day |
| Ledger entries/day | double-entry, 2 entries/txn | 173M × 2 | ~346M entries/day |
| Ledger storage/day | 200 bytes/entry | 346M × 200B | ~69 GB/day |
| Ledger storage (7yr audit retention) | 69GB × 365 × 7 | 69GB × 2,555 | ~176 TB |
| Webhook events/day | ~2 events/txn (created, succeeded) | 173M × 2 | ~346M/day |
| Webhook delivery QPS (avg) | 346M / 86,400s | 346,000,000 / 86,400 | ~4,000/sec |

> [!TIP]
> Interviewers listen for this framing: "the hard constraint here isn't throughput, it's correctness under failure — a lost or duplicated payment is a much worse outcome than a slow one." That reorients the whole conversation toward idempotency and the ledger before scaling.

## Core entities and data model

The four entities and how they reference each other:

![alt text](notes/HLD/Problems/PaymentSystem/image-1.png)

| Entity | Key fields |
|---|---|
| `PaymentIntent` | `intent_id`, `merchant_id`, `amount`, `currency`, `status` |
| `Transaction` | `txn_id`, `intent_id`, `type` (charge/refund), `status`, `idempotency_key`, `psp_reference` |
| `LedgerEntry` | `entry_id`, `account_id`, `direction` (debit/credit), `amount`, `txn_id` |
| `WebhookEvent` | `event_id`, `merchant_id`, `type`, `payload`, `delivery_status` |

```mermaid
erDiagram
    PAYMENT_INTENT ||--o{ TRANSACTION : has
    TRANSACTION ||--o{ LEDGER_ENTRY : posts
    TRANSACTION ||--o{ WEBHOOK_EVENT : triggers
    PAYMENT_INTENT {
        string intent_id
        decimal amount
        string status
    }
    TRANSACTION {
        string txn_id
        string idempotency_key
        string psp_reference
    }
    LEDGER_ENTRY {
        string account_id
        string direction
        decimal amount
    }
```

## API design

```
POST /payment-intents
{ "amountInCents": 2499, "currency": "usd", "description": "Order #1234" }
-> 201 { "paymentIntentId": "pi_1" }

POST /payment-intents/{id}/transactions
Idempotency-Key: charge_pi_1_attempt_1
{ "type": "charge", "card": { "number": "...", "exp_month": 12, "exp_year": 2027, "cvc": "123" } }
-> 200 { "status": "succeeded", "transactionId": "txn_1" }

GET /payment-intents/{id} -> PaymentIntent + Transaction[]

// Delivered TO the merchant's webhook URL
POST {merchant_webhook_url}
{ "type": "payment.succeeded", "data": { "paymentId": "pay_123", "amountInCents": 2499 } }
```

## High level architecture

```mermaid
flowchart LR
    M["Merchant"] --> API["Payment API"]
    API --> TxnSvc["Transaction Service"]
    TxnSvc --> PSP["Payment Network / PSP"]
    TxnSvc --> DB[("Transaction + Ledger DB")]
    DB --> Stream["Event Stream (CDC)"]
    Stream --> Webhook["Webhook Service"]
    Webhook --> M
    Stream --> Recon["Reconciliation Worker"]
    Recon --> Report[("PSP Settlement Report")]
```

**Charge flow:** (1) merchant creates a payment intent, (2) merchant submits a transaction (charge) with a client-supplied idempotency key, (3) the transaction service calls out to the PSP over a secured channel, (4) on response, it durably writes the transaction result **and** the corresponding double-entry ledger rows in the same local transaction, (5) that database write is captured via change-data-capture and streamed out, driving both webhook delivery to the merchant and downstream reconciliation — decoupled from the synchronous charge path so a slow webhook never blocks the charge response. Split into its two constituent legs, the flow looks like this: the merchant-facing initiation —

![alt text](notes/HLD/Problems/PaymentSystem/image-2.png)

— and the customer-facing card charge, which crosses into the external payment network over a highly secured line using dedicated protocols, VPNs, and certificates rather than the public internet:

![alt text](notes/HLD/Problems/PaymentSystem/image-3.png)

## Deep dive: idempotency and exactly-once money movement

You cannot achieve true exactly-once delivery over an unreliable network — a request to the PSP can time out with the charge having actually succeeded on their end. The practical target is **effectively-once**: idempotency keys plus a reconciliation safety net.

```mermaid
sequenceDiagram
    participant Client
    participant API as "Payment API"
    participant PSP
    Client->>API: charge(idempotency_key=k1)
    API->>PSP: charge request
    PSP--xAPI: timeout (ambiguous!)
    Client->>API: retry charge(idempotency_key=k1)
    API->>PSP: check status by k1
    PSP-->>API: already succeeded
    API-->>Client: return original result, no second charge
```

| Scenario | Naive handling | Correct handling |
|---|---|---|
| Client retries after a timeout | Call PSP again | Look up `idempotency_key` first; if already resolved, return cached result without re-calling PSP |
| PSP call actually succeeded but response was lost | Assume failure, retry blindly | Query PSP by reference/idempotency key before retrying to check the true outcome |
| Two concurrent requests with the same key | Both process independently | A unique constraint on `idempotency_key` ensures only one transaction is created; the second gets the first's result |

> [!DANGER]
> The classic double-charge bug: a request to the PSP times out on the client side, but the PSP actually processed it. If the service blindly retries without first checking the PSP's own record of that idempotency key, the customer is charged twice. Always **query before you retry** against an external, non-idempotent-by-default system.

## Deep dive: authenticating the merchant and protecting card data

Idempotency protects against double-charging once a request is trusted; a separate question is whether the request is genuinely from the merchant at all. Basic API-key auth (a static secret in a header) is simple but vulnerable to replay if the key or a captured request is ever intercepted. A stronger scheme signs each request: the merchant signs the request body with a private key, the server validates that signature and separately checks a nonce against a short-lived store to reject any request whose nonce has already been used, even if the signature itself is valid.

```json
{
  "method": "POST",
  "path": "/payment-intents/{paymentIntentId}/transactions",
  "headers": {
    "Authorization": "******",
    "X-Request-Timestamp": "2023-10-15T14:22:31Z",
    "X-Request-Nonce": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "X-Signature": "sha256=7f83b1657ff1fc53b92dc18148a1d65dfc2d4b1fa3d677284addd200126d906"
  }
}
```

The customer's own card data gets a matching level of care: fields are collected inside an iframe served from the payment provider's own domain, not the merchant's, and encrypted client-side (e.g. with RSA) before it ever leaves the browser, so neither the merchant's frontend nor its servers are ever in a position to see or leak a raw card number:

![alt text](notes/HLD/Problems/PaymentSystem/image-4.png)

## Deep dive: double-entry ledger and audit trail

Every transaction posts at least two ledger entries that must sum to zero — a debit and a matching credit — which makes the ledger self-verifying: if entries don't balance, something is provably wrong, independent of any application logic bug elsewhere.

```
-- A $24.99 charge, simplified
INSERT INTO ledger_entries (account_id, direction, amount, txn_id) VALUES
  ('customer_clearing', 'debit',  2499, 'txn_1'),
  ('merchant_payable',  'credit', 2499, 'txn_1');
-- sum(debits) == sum(credits) for this txn_id, always
```

> [!KEY]
> The ledger, not the `Transaction` table's `status` column, is the source of truth for "where is the money." Application status fields can have bugs; a balanced double-entry ledger is a mathematical invariant you can continuously verify with a simple aggregate query, which is exactly what makes it auditable to accountants and regulators, not just to engineers.

Combined with an append-only, immutable write pattern (never `UPDATE` a ledger entry — post a new reversing entry instead), this gives a complete, tamper-evident audit trail of every cent moved, which is what "durability and auditability with no transaction ever lost" actually means in practice. A naive way to get there is a separate write-ahead audit table written on every state change, but that duplicates writes and adds overhead to the critical path; the better version is to let the transaction/ledger database itself be the single write, and derive the audit trail from its own change-data-capture stream instead of a second bookkeeping write:

![alt text](notes/HLD/Problems/PaymentSystem/image-5.png)

## Deep dive: webhooks and reconciliation

Webhooks are inherently unreliable: a merchant's endpoint can be down, slow, or the delivery itself can be duplicated or arrive out of order relative to when events actually happened.

| Problem | Mitigation |
|---|---|
| Merchant endpoint down | Retry with exponential backoff over hours, not just seconds; give up after a bounded window and expose events via a pollable API as a fallback |
| Duplicate delivery | Merchant-side and sender-side dedupe by `event_id`; webhook handlers should be idempotent by design |
| Out-of-order delivery | Include a monotonic sequence number or timestamp so merchants can detect and reorder if it matters to them |
| Webhook fully lost, merchant never notified | Reconciliation catches this independent of webhooks — see below |

Reconciliation is the safety net that catches everything idempotency keys and webhooks miss: a scheduled job pulls the PSP's own settlement report (their record of what actually cleared) and compares it line-by-line against the internal ledger. Mismatches — a charge the PSP recorded that you have no ledger entry for, or vice versa — are flagged for automatic correction where safe, or manual review where not. A pure cron job that periodically scans for stuck "pending" transactions is a reasonable first pass but leaves customers waiting through an uncertain state; the better version has a worker watching the transaction event stream itself and proactively verifying anything that's been pending past a timeout, closing the gap between "the payment network is asynchronous" and "the customer sees a fast answer":

![alt text](notes/HLD/Problems/PaymentSystem/image-6.png)

Webhook delivery itself is a straightforward consumer of the same event stream: a dedicated service reads the transaction event stream, checks each merchant's subscription config for which event types they actually care about, and calls their registered endpoint with the matching payload:

![alt text](notes/HLD/Problems/PaymentSystem/image-7.png)

> [!WARNING]
> Never treat "the webhook was delivered" as proof a payment succeeded, and never treat "no webhook arrived" as proof it failed. Both are asynchronous, best-effort signals; reconciliation against the PSP's authoritative settlement data is what actually guarantees correctness over time.

## Deep dive: PCI scope, tokenization, refunds, and chargebacks

Raw card numbers should never touch your own servers if avoidable — collecting card details in an iframe hosted by the PSP (not your domain) and receiving back only a token drastically reduces PCI DSS compliance scope (from a full audit to a much lighter self-assessment), since your infrastructure never stores or transmits raw card data.

Refunds are modeled as a new `Transaction` of type `refund`, linked to the original charge, posting reversing ledger entries — never mutating the original charge's records. Chargebacks originate from the card issuer, not the merchant, and are handled as a separate dispute workflow: funds are provisionally held/reversed, the merchant can submit evidence, and the ledger reflects each state transition (`disputed` → `won`/`lost`) as its own entries rather than editing history. Assembled end to end — API, ledger, event stream, webhooks, and reconciliation — the full system looks like this:

![alt text](notes/HLD/Problems/PaymentSystem/image-8.png)

## Bottlenecks and scaling

- **PSP call latency** — this is the slowest step in the charge path; keep it synchronous only for the parts that must be (authorization), and push everything else (webhooks, ledger propagation to other systems) asynchronous.
- **Ledger write contention** — partition by account or merchant so hot accounts don't serialize all writes through one row/table.
- **Event stream throughput at 10K TPS** — a partitioned log (e.g. Kafka, partitioned by `payment_intent_id` for per-intent ordering, each partition handling roughly 5,000–10,000 messages/sec) comfortably handles this with 3x replication for durability.
- **Reconciliation job runtime** — as transaction volume grows, reconcile incrementally (only new settlement data since last run) rather than full-table comparisons each time.

## Failure scenarios

| Failure | Blast radius | Mitigation |
|---|---|---|
| PSP call times out, true outcome unknown | Risk of double charge on retry | Query PSP by idempotency key/reference before any retry, never retry blindly |
| Ledger write fails after PSP confirmed success | Money moved externally with no internal record | Write transaction + ledger entries in one local transaction; use an outbox pattern so the write and the "notify downstream" step can't diverge |
| Webhook delivery fails or merchant endpoint is down | Merchant not notified promptly | Retry with backoff; expose a pollable status API; reconciliation independently catches any missed state |
| Ledger and PSP settlement report disagree | Financial discrepancy | Reconciliation job flags the mismatch for automatic or manual resolution before it compounds |

## Cheat sheet

- Idempotency keys, enforced with a unique constraint, are the mechanism for effectively-once charges — true exactly-once over a network doesn't exist.
- Always query the PSP's own record before retrying an ambiguous (timed-out) request — never retry blind.
- The double-entry ledger, not a status field, is the source of truth; debits must always equal credits per transaction.
- Ledger entries are append-only — reverse with a new entry, never edit history.
- Reconciliation against the PSP's settlement report is the safety net that catches what idempotency and webhooks miss.
- Webhooks are best-effort and can duplicate/reorder/fail — design handlers to be idempotent and never treat delivery as proof of success.
- Minimize PCI scope with tokenization/hosted iframes; never let raw card data touch your own servers if you can avoid it.

## Common mistakes

| Mistake | Fix |
|---|---|
| Retrying a timed-out PSP call without checking its actual outcome first | Query by idempotency key/reference before retrying — this is the #1 cause of double charges |
| Treating the `Transaction.status` column as the source of truth for money movement | Treat the balanced double-entry ledger as the source of truth; status is a convenience field |
| `UPDATE`-ing a ledger entry to "fix" a mistake | Post a new reversing entry; ledgers must be append-only and auditable |
| Assuming a webhook firing means the payment definitely succeeded | Webhooks are best-effort signals; rely on reconciliation against the PSP for guarantees |
| Storing raw card numbers on your own servers | Use PSP-hosted tokenization/iframes to keep raw card data out of your PCI scope entirely |

## Summary

A payment system's real challenge is correctness under an unreliable network, not throughput. Idempotency keys turn "retry" from a double-charge risk into a safe no-op; a double-entry ledger makes "where did the money go" a provable, self-verifying fact rather than a status flag; and reconciliation against the PSP's own settlement data is the safety net that catches everything else — including every failure mode webhooks can't reliably signal. Tokenization keeps sensitive card data out of your infrastructure entirely, shrinking both risk and compliance scope.

## Top Interview Questions

### Q1. How do you guarantee a customer is never charged twice for the same logical payment?

The client (or the calling service) supplies an idempotency key unique to that specific charge attempt, sent with every request including retries. The server enforces uniqueness on that key at the database level; if a request with a previously-seen key arrives, the server returns the original result instead of processing a new charge. Critically, this must also apply to the outbound call to the PSP itself — before retrying a call that appears to have failed (e.g. timed out), the service should query the PSP's own record by that same reference to check whether it actually succeeded, rather than assuming failure and charging again.

### Q2. Why is a double-entry ledger better than a simple `status` column on a transaction table for tracking money movement?

A `status` column is just an application-level assertion — it can be wrong due to a bug, a missed update, or a race condition, with nothing to cross-check it against. A double-entry ledger posts a debit and a matching credit for every movement of money, which must always sum to zero per transaction; this makes the ledger self-verifying — a simple aggregate query can detect an imbalance, which is provably impossible in a correctly-functioning system, so any imbalance immediately signals a real bug or a bad actor. It's also the format finance and auditors expect, since it mirrors how real accounting systems work.

### Q3. A request to the payment provider times out — you don't know if the charge succeeded or failed. What do you do?

Never assume either outcome and never blindly retry. Query the PSP using the same idempotency key or reference you sent originally — most PSPs support looking up a transaction by the idempotency key precisely for this scenario — to get the true outcome. If it succeeded, record that result locally and return it to the client; if it genuinely never reached the PSP (rare, but possible on some failure modes), a fresh retry with the same idempotency key is safe by construction, since the PSP itself will treat that key as already-seen if it had actually processed it.

### Q4. Why can't webhooks alone be trusted as the source of truth that a payment succeeded?

Webhooks are a best-effort, asynchronous delivery mechanism: the merchant's endpoint might be down, the delivery might be delayed by minutes or hours during retries, events can arrive out of order, or in rare cases be lost entirely despite retries. Treating "webhook received" as proof of success (or "no webhook yet" as proof of failure) conflates a delivery signal with a financial fact. The actual source of truth is the ledger, cross-checked against the PSP's settlement report during reconciliation — webhooks are a convenience for prompt notification, not a correctness guarantee.

### Q5. What is reconciliation, and why is it necessary even with idempotency keys and a solid ledger?

Reconciliation is a periodic (or continuous) process that pulls the PSP's own authoritative settlement report — their record of what actually cleared and when — and compares it line-by-line against your internal ledger. It's necessary because idempotency keys prevent duplicate requests from *your* side, but can't catch every possible failure mode: a bug in your ledger-writing code, a partial write during a crash, or a discrepancy introduced by the PSP itself. Reconciliation is the independent, external check that catches whatever internal mechanisms miss, closing the loop on "did the money actually move the way our records say it did."

### Q6. How would you minimize your PCI DSS compliance burden while still accepting card payments?

Never let raw card data (the card number, CVC) touch your own servers. Instead, use the payment provider's hosted iframe or client-side tokenization SDK: the customer's browser submits card details directly to the PSP's domain, and your server only ever receives back an opaque token representing that payment method. This reduces your compliance scope from a full PCI DSS audit (if you handle raw card data) down to a much lighter self-assessment questionnaire, since sensitive cardholder data never enters your infrastructure at all.

### Q7. How do refunds and chargebacks differ, and how does each affect the ledger?

A refund is merchant-initiated: the merchant decides to return money to the customer, which is modeled as a new `refund` transaction linked to the original charge, posting reversing ledger entries (debit and credit flipped relative to the original) — the original charge's records are never edited. A chargeback is issuer-initiated: the customer's bank forcibly reverses the charge, often before the merchant is even notified, triggering a dispute workflow where funds are provisionally held, the merchant can submit evidence, and the outcome (`won`/`lost`) posts its own ledger entries reflecting the final resolution. Both extend the ledger forward rather than rewriting history.

### Q8. How would you scale this system to handle 10,000+ transactions per second?

The synchronous critical path — creating the payment intent, calling the PSP, writing the transaction and ledger entries — should be kept as lean as possible, with everything else (webhook delivery, reconciliation, analytics) pushed onto an asynchronous event stream fed by change-data-capture from the transaction database. That stream (e.g. Kafka) can be partitioned, commonly by `payment_intent_id` to preserve per-intent ordering, with each partition handling several thousand messages per second and replication for durability. The database layer scales via read replicas for lookups and by moving older, settled transactions to cold storage, keeping the hot table small.

### Q9. What would you do if the ledger and the PSP's settlement report disagree for a specific transaction?

First, treat it as a flagged discrepancy, not an automatic "trust one side" resolution — both systems can have bugs. The reconciliation job surfaces the mismatch with enough detail (transaction ID, amounts, timestamps, both records) for either automated resolution rules (e.g. "if the PSP shows succeeded and we show pending, and it's been over N minutes, mark it succeeded and post the missing ledger entry") or manual investigation for anything the automated rules don't confidently cover. The key operational point is that discrepancies must never be silently ignored — they represent either a lost payment, a double charge, or a systemic bug, all of which compound if left unresolved.

### Q10. How do you keep the payment API's response fast when the ledger write and webhook delivery both need to happen?

Only the parts that must be synchronous for the client to get a correct response — calling the PSP for authorization and durably persisting the transaction plus its ledger entries in one local transaction — are on the critical path. Everything downstream of that (notifying the merchant via webhook, feeding reconciliation, updating analytics) is decoupled via an event stream fed by change-data-capture on that same database write, so the client gets a fast response the moment the authoritative write succeeds, without waiting on a merchant's webhook endpoint to respond.

### Q11. Why is "exactly-once" money movement not actually achievable, and what's the practical substitute?

Exactly-once delivery is a well-known impossibility over an unreliable network when the sender can't be certain whether its message was received and processed before a failure (a request can succeed at the receiver but the confirmation is lost, making the sender's retry decision inherently ambiguous). Payment systems substitute "effectively-once": idempotency keys make retries safe (each key can only ever result in one committed outcome), and reconciliation against the PSP's own record acts as an independent, out-of-band correction mechanism for the rare cases where ambiguity slips through. Together they produce a system that behaves as exactly-once in practice, even though no single mechanism guarantees it in isolation.

### Q12. Beyond idempotency, how do you authenticate that a request genuinely came from the merchant and hasn't been tampered with or replayed?

A static API key in a header proves possession of a secret but nothing about the request's integrity or freshness — if it's ever intercepted, it can be replayed indefinitely. A stronger scheme has the merchant sign each request with a private key over the body, timestamp, and a unique nonce; the server independently recomputes the signature to verify integrity, checks the timestamp is recent, and checks the nonce against a short-lived store to reject any request whose nonce it has already seen, even if the signature is technically valid. This closes the replay window that a bare API key leaves open, and it composes cleanly with idempotency keys — the nonce/signature check answers "is this request authentic and fresh," while the idempotency key separately answers "have I already committed the financial effect of this logical operation."
