---
title: Azure Fundamentals
description: The resource hierarchy, control plane, RBAC, regions and cost model you must explain confidently before any Azure architecture discussion
difficulty: Foundational
tags: [azure, architecture, governance, rbac]
---

Before an interviewer lets you talk about services, they check whether you understand the scaffolding those services live in. This page covers the hierarchy, the control plane, identity scopes and the cost model — the vocabulary every "why did you choose Azure" conversation is built on.

## The resource hierarchy

Everything in Azure sits inside a four-level tree. Getting the order right, and knowing what each level is *for*, is the first thing a senior interviewer probes.

```mermaid
flowchart TD
    T["Tenant<br/>Microsoft Entra ID"] --> MG["Management Group<br/>e.g. Production"]
    MG --> S1["Subscription<br/>billing boundary"]
    MG --> S2["Subscription<br/>Dev/Test"]
    S1 --> RG1["Resource Group<br/>rg-orders-prod"]
    S1 --> RG2["Resource Group<br/>rg-shared-network"]
    RG1 --> R1["App Service"]
    RG1 --> R2["SQL Database"]
    RG2 --> R3["VNet"]
```

| Level | Purpose | Typical boundary |
|---|---|---|
| Tenant | One Entra ID directory, one organisation | Identity boundary |
| Management group | Groups subscriptions for policy and RBAC at scale | Governance boundary |
| Subscription | Billing container, hard quota limits, deployment boundary | Billing + isolation boundary |
| Resource group | Lifecycle container — resources that deploy/delete together | Lifecycle boundary |
| Resource | The actual thing — a VM, a database, a queue | — |

> [!KEY]
> A resource group is a **lifecycle** boundary, not a network or security boundary. Resources in different resource groups can share a VNet; resources in the same resource group can be in different regions. Don't imply otherwise in an interview.

## Regions, availability zones, paired regions

A **region** is a set of datacentres with low-latency networking between them. An **availability zone (AZ)** is a physically separate datacentre (own power, cooling, network) inside a region — using 2–3 zones protects against a datacentre-level failure, not a regional one. A **paired region** is a pre-defined partner region (e.g. East US ↔ West US) used for platform-level disaster recovery and staggered platform updates — Azure never updates both halves of a pair at the same time.

| Concept | Protects against | RTO/RPO expectation | Cost/latency impact |
|---|---|---|---|
| Availability zone | Datacentre failure (power, fire, cooling) | Seconds — near-zero, often transparent | Small — sub-2ms cross-zone latency, minor cross-zone data transfer cost |
| Paired region | Full region outage | Minutes to hours, manual or geo-failover | Higher — cross-region replication + failover complexity |
| Multi-region active-active | Region outage with no downtime | Near-zero if designed correctly | Highest — double compute cost + data sync complexity |

> [!TIP]
> "We deployed zone-redundant App Service and SQL within one region, with geo-restore to a paired region for DR" is a strong, cost-aware default answer. Reserve active-active multi-region for services with a genuine 99.99%+ SLA requirement — it roughly doubles cost and adds real consistency problems.

## ARM, control plane vs data plane

Every resource has two separate APIs. The **control plane** (Azure Resource Manager, `management.azure.com`) is used to create, configure, tag, and delete the resource, and is governed uniformly by RBAC. The **data plane** is the resource's own API for actually using it — sending a message to Service Bus, reading a blob, querying SQL — and each service defines its own auth model for that plane.

```csharp
// Control plane: "does this identity have Contributor on this resource group?"
// az resource create / ARM template / Bicep deploy

// Data plane: "does this identity have Storage Blob Data Reader on this container?"
var client = new BlobContainerClient(new Uri(containerUri), new DefaultAzureCredential());
await client.GetBlobClient("orders.json").DownloadContentAsync();
```

> [!WARNING]
> Owning a storage account on the control plane (e.g. Contributor role) does **not** automatically grant data plane access to the blobs inside it unless you also have a data-plane role like Storage Blob Data Contributor. This split trips up people who assume "Owner" means "can read everything" — it doesn't for most data services.

## Tags and naming conventions

Tags are key-value metadata on resources used for cost allocation, ownership, and automation (e.g. auto-shutdown scripts querying `tag:environment=dev`). Naming conventions are not enforced by Azure but by Azure Policy — most orgs pick a scheme like `<resource-type>-<workload>-<env>-<region>-<instance>` (e.g. `app-orders-prod-eus-01`).

| Convention element | Example | Why it matters |
|---|---|---|
| Resource type prefix | `rg-`, `st`, `vnet-`, `kv-` | Instant identification in the portal/CLI |
| Workload/app name | `orders`, `checkout` | Groups related resources across types |
| Environment | `prod`, `dev`, `stg` | Prevents cross-environment mistakes |
| Region abbreviation | `eus`, `weu` | Needed once you go multi-region |
| Instance/index | `01`, `02` | Supports multiple identical deployments |

## RBAC scopes and inheritance

Azure RBAC assigns a **role** (a set of permissions) to a **principal** (user, group, service principal, managed identity) at a **scope**. Role assignments are inherited downward: a role granted at management group level applies to every subscription, resource group and resource beneath it.

```mermaid
flowchart LR
    A["Assignment: Contributor<br/>at Management Group"] --> B["Inherited by<br/>Subscription A"]
    A --> C["Inherited by<br/>Subscription B"]
    B --> D["Inherited by<br/>rg-orders-prod"]
    D --> E["Inherited by<br/>App Service"]
```

> [!DANGER]
> Assigning "Owner" at subscription scope because "it was easier" is the single most common security finding in Azure environments. Owner includes the ability to grant further RBAC roles — a compromised identity with subscription-level Owner can escalate to anything. Scope roles to the resource group or resource, and prefer built-in roles like Contributor, Reader, or service-specific data roles over Owner.

## Quotas, limits, and the cost model

Every subscription has default quotas (vCPU cores per region, number of storage accounts, ARM requests per hour) that you must know exist before a design review — a "can we just spin up 500 more instances" answer needs a quota-increase caveat.

Azure's three purchasing models trade commitment for discount:

| Model | Commitment | Discount vs pay-as-you-go | Best for |
|---|---|---|---|
| Pay-as-you-go | None | Baseline (0%) | Unpredictable, bursty, new workloads |
| Reserved Instances / Savings Plan | 1 or 3 years | Up to ~65–72% | Steady-state baseline capacity you know you'll run |
| Spot VMs | None, but can be evicted with ~30s notice | Up to ~90% | Interruptible batch jobs, CI runners, stateless workers |

The senior answer to "how did you control cost" sounds like this: *"We reserved capacity for the steady-state baseline load, used pay-as-you-go for the delta, and pushed batch/CI workloads onto spot VMs with checkpointing so eviction was cheap to recover from."* That single sentence covers all three models correctly.

## Landing zones

A **landing zone** is a pre-provisioned, policy-compliant environment (subscription + networking + identity + guardrails) that a team deploys into, rather than starting from a blank subscription. Microsoft's Cloud Adoption Framework landing zone pattern splits subscriptions into a **platform** side (connectivity, identity, management) and a **landing zone** side (per-workload subscriptions), connected via hub-and-spoke networking. In an interview, mentioning landing zones signals you've worked in an enterprise environment with actual governance, not just a personal sandbox subscription.

## Cheat sheet

- Hierarchy top-down: **tenant → management group → subscription → resource group → resource**.
- Resource group = lifecycle boundary, not security or network boundary.
- Control plane (ARM/RBAC) and data plane (service-specific auth) are separate — Owner ≠ data access.
- Availability zones protect against datacentre failure; paired regions protect against regional failure.
- RBAC is additive and inherits downward; never assign Owner where Contributor or a scoped role suffices.
- Reserved/Savings Plan for baseline load, pay-as-you-go for burst, Spot for interruptible batch work.
- Landing zones = pre-baked, policy-compliant subscriptions teams deploy into, not blank slates.

## Common mistakes

| Mistake | Fix |
|---|---|
| Assuming resource group = network/security boundary | Treat it purely as a lifecycle/deployment unit |
| Granting Owner at subscription scope "to be safe" | Scope to resource group/resource, use least-privilege built-in roles |
| Confusing availability zones with paired regions in a DR pitch | AZ = datacentre failure, paired region = whole-region failure |
| Assuming control-plane access implies data-plane access | Check both RBAC role types for the service in question |
| Ignoring subscription quotas when sizing a design | State known quota limits and the increase-request path |
| Treating tags as optional | Tags drive cost allocation and automation; enforce via Azure Policy |

## Summary

Azure fundamentals are the shared vocabulary that lets you talk credibly about any service on top. Know the hierarchy and which level owns which kind of boundary, separate the control plane from the data plane when reasoning about access, understand RBAC inheritance well enough to avoid over-granting, and be able to justify a cost model choice with reserved/pay-as-you-go/spot in one sentence. Everything else — networking, identity, compute choices — builds on this foundation.

## Top Interview Questions

### Q1. Walk me through the Azure resource hierarchy and what each level is for.

Tenant (one Microsoft Entra ID directory, the identity boundary) sits at the top. Below it, management groups group subscriptions for applying policy and RBAC at scale — useful once you have more than a handful of subscriptions. Subscriptions are the billing and quota boundary and also a hard deployment boundary for some resource types. Resource groups are lifecycle containers: everything in one typically gets created and deleted together, and they can span regions freely. Resources are the actual deployed things. The key point to emphasize: only tenant and subscription are hard boundaries enforced by the platform (billing, identity); resource group is an organisational convenience you choose to use well.

### Q2. What's the difference between the control plane and the data plane, and why does it matter for security?

The control plane (Azure Resource Manager) manages the *existence and configuration* of a resource — create, delete, tag, scale — and is uniformly governed by Azure RBAC at management-group/subscription/resource-group/resource scope. The data plane is how you *use* the resource once it exists — reading a blob, sending a Service Bus message, querying a database — and each service defines its own data-plane authorization model, often a separate set of RBAC roles (e.g. Storage Blob Data Reader) or resource-specific mechanisms (SQL logins, Cosmos DB keys). It matters because control-plane access does not imply data-plane access: someone with Contributor on a storage account can restart or delete it, but cannot necessarily read the blobs inside unless separately granted a data role. Designing least-privilege access requires granting both planes deliberately, not assuming one implies the other.

### Q3. When would you use availability zones versus a secondary paired region?

Availability zones protect against the failure of a single datacentre within a region — power, cooling, or a rack-level fire — with near-zero additional latency (sub-2ms) and modest cost, and many PaaS services support zone redundancy transparently (e.g. zone-redundant storage, zonal App Service). A paired region protects against the loss of an entire region, which is rarer but catastrophic, and requires explicit replication, a failover plan, and usually higher cost since you're running or standing up infrastructure elsewhere. My default for most workloads is zone-redundant deployment within one region for high availability, plus geo-redundant backups or geo-restore to the paired region for disaster recovery — true active-active multi-region is reserved for services with a hard 99.99%+ availability SLA, because it roughly doubles infrastructure cost and introduces real data-consistency problems across regions.

### Q4. Explain RBAC inheritance. What's the risk of assigning a role at too high a scope?

RBAC role assignments are additive and inherit downward through the hierarchy: a role assigned at management group level applies to every subscription, resource group, and resource beneath it, and there is no way to "deny" it further down without an explicit deny assignment (rare, usually reserved for Azure Blueprints/landing zones). The risk of over-scoping — say, granting Owner at subscription level when a team only needs to manage one resource group — is blast radius: a compromised credential or a scripting mistake can now affect every resource in the subscription, and Owner specifically can grant further role assignments, enabling privilege escalation. The fix is to always assign the least-privileged built-in role at the narrowest scope that satisfies the requirement, and periodically run access reviews to catch scope creep.

### Q5. Your team wants to run 200 extra VM instances for a load test tomorrow. What do you check first?

First, the subscription's vCPU quota for that VM family in that region — Azure enforces default core quotas per subscription per region, and a sudden request for 200 instances of, say, a 4-vCPU SKU could exceed it and fail mid-deployment. Second, whether the region has capacity for that SKU at all (regional VM SKU availability can be constrained). Third, cost impact and whether pay-as-you-go pricing is acceptable for a short-lived test versus provisioning as Spot VMs if the test tolerates eviction. In practice I'd request a quota increase through the portal or support ticket ahead of time — it's not instant — and consider splitting the load across two regions or availability zones both for quota headroom and to test realistic failure isolation.

### Q6. What's a landing zone, and why would an enterprise use one instead of letting teams create their own subscriptions freely?

A landing zone is a pre-provisioned, policy-compliant environment — typically a subscription with networking, identity, logging, and Azure Policy guardrails already wired up — that a workload team deploys into, following the Cloud Adoption Framework's hub-and-spoke pattern where a central "platform" subscription owns shared connectivity/identity/management and individual "landing zone" subscriptions host workloads. Enterprises use this instead of ad-hoc subscriptions because it guarantees consistency: every team automatically inherits network isolation, diagnostic logging, tagging policy, and RBAC baselines without having to reinvent them, and central platform teams can enforce compliance (e.g. "no public IPs without an exception") via policy rather than manual review. It also makes cost allocation and blast-radius containment predictable since each workload sits in its own subscription boundary.

### Q7. How would you justify choosing reserved instances, pay-as-you-go, and spot VMs for the same system?

I'd map each pricing model to a load pattern rather than pick one for everything. The steady-state baseline — traffic that's present 24/7, like the minimum number of App Service or VM instances needed at 3am — goes on Reserved Instances or a Savings Plan, since that capacity is guaranteed to be used and the 1- or 3-year commitment earns up to ~65-72% discount. The variable portion above baseline — daytime peaks, seasonal spikes — stays pay-as-you-go, since committing to capacity you might not use erases the discount's value. Anything interruption-tolerant — CI build agents, batch ETL jobs, data processing that checkpoints — runs on Spot VMs, which can be up to 90% cheaper but can be evicted with about 30 seconds' notice, so the workload must handle that gracefully. Naming all three in one answer, tied to a load shape, is what separates a cost-aware answer from a "we just picked the cheapest tier" one.

### Q8. What are Azure tags used for, and how do you stop them becoming inconsistent across a large environment?

Tags are key-value metadata attached to resources (and resource groups) used for cost allocation and chargeback, ownership/on-call routing, environment identification, and driving automation — for example, a scheduled runbook that shuts down every resource tagged `environment=dev` outside business hours. Left to individual engineers, tag keys and values drift (`Env`, `env`, `Environment` all appearing for the same concept), which breaks cost reports and automation filters. The fix is to enforce a tagging taxonomy through Azure Policy — deny or append policies that require specific tag keys at resource-group or subscription scope, sometimes inheriting tags from the resource group automatically — rather than relying on documentation and hoping engineers comply.

### Q9. A resource group contains a VNet, three VMs, and a storage account, all deployed for one project. What happens if you delete the resource group, and is that a good design?

Deleting a resource group deletes every resource inside it (subject to resource locks or soft-delete on some services), because that's precisely what a resource group is for — a lifecycle unit. Whether it's good design depends on what's shared: if the VNet is also used by other projects, putting it in a project-specific resource group means deleting that project would take down networking for everyone else. The better pattern is to separate shared, long-lived infrastructure (VNets, DNS zones, Key Vaults used cross-project) into their own resource group — often owned by a platform team — from per-project, disposable resources (VMs, app-specific storage) that genuinely share a lifecycle. I'd also apply a `CanNotDelete` resource lock on the shared resource group as a safety net regardless.

### Q10. How do control-plane throttling limits (ARM request limits) show up in production, and how do you avoid hitting them?

ARM enforces subscription-level and tenant-level request-rate limits on control-plane operations (reads, writes, deletes) — if a CI/CD pipeline or an automation script issues a burst of resource creations, updates, or `GET` calls too quickly, you get `429 Too Many Requests` with a `Retry-After` header. This typically shows up during large-scale deployments (e.g. a Bicep/Terraform apply touching hundreds of resources in parallel) or in monitoring scripts that poll resource status too aggressively. The fix is to respect `Retry-After` with exponential backoff (most SDKs and Terraform/Bicep providers do this automatically), batch or throttle deployment parallelism, and avoid polling loops that call ARM every second when an event-driven or longer-interval check would do. It's worth knowing this is a real limit, not theoretical — it's one of the more common causes of "the pipeline randomly failed" tickets in large Azure estates.
