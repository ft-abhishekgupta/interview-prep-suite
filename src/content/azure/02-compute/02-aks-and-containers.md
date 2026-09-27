---
title: AKS and Containers
description: AKS architecture, when Kubernetes beats simpler container platforms, autoscaling options, node pool design and workload identity for pod-level Azure auth
difficulty: Advanced
tags: [azure, aks, kubernetes, containers]
---

AKS questions test whether you understand the operational cost you're taking on, not just the YAML. This page covers AKS architecture, the decision against App Service/Container Apps, autoscaling layers, node pool design, and how pods authenticate to Azure without stored credentials.

## AKS architecture

Azure manages the **control plane** (API server, etcd, scheduler, controller manager) for free — you don't see or patch those VMs. You manage the **node pools** — the actual VMs that run your pods. A cluster always has a **system node pool** (runs core cluster components like CoreDNS, metrics-server, and tunnel/proxy agents) and typically one or more **user node pools** for your application workloads.

```mermaid
flowchart TD
    subgraph "Azure-managed control plane"
        API["API Server"]
        ETCD["etcd"]
        Sched["Scheduler"]
    end
    subgraph "Your subscription — node pools"
        Sys["System node pool<br/>CoreDNS, metrics-server"]
        User1["User node pool<br/>app workloads"]
        User2["User node pool<br/>GPU / spot workloads"]
    end
    API --> Sys
    API --> User1
    API --> User2
```

| Component | Who manages it | Notes |
|---|---|---|
| Control plane (API server, etcd) | Azure | Free on the Standard/Free tier tiers, paid uptime SLA on the Standard tier |
| System node pool | You (VMs), Azure (scheduling core components) | Should be isolated from app workloads via taints |
| User node pool(s) | You | Where your workloads actually run; can scale to zero |

> [!KEY]
> Isolate the system node pool with a taint (`CriticalAddonsOnly=true:NoSchedule`) so application pods can't land there and starve cluster-critical components — a very common finding in AKS reviews.

## When AKS over App Service or Container Apps

AKS is the most powerful and most operationally expensive option. The decision table below is what interviewers want you to reason through out loud, not just state a conclusion.

| Requirement | App Service (containers) | Container Apps | AKS |
|---|---|---|---|
| Ops overhead | Lowest | Low | Highest — you own upgrades, networking, node health |
| Kubernetes API / CRDs needed | No | No | Yes |
| Fine-grained autoscaling triggers (KEDA) | No | Yes (built on KEDA) | Yes |
| Service mesh / sidecar control | No | Limited | Full |
| Multi-tenant cluster isolation (namespaces, network policy) | N/A | Limited | Full |
| Scale to zero | No | Yes | Yes (with KEDA/cluster autoscaler tuning) |
| Team already has strong Kubernetes expertise | Not required | Not required | Effectively required |

> [!TIP]
> The strongest interview answer is need-driven, not preference-driven: "We chose Container Apps first because it gave us KEDA-based scaling and a simpler ops model; we only moved specific workloads to AKS once we needed custom scheduling/affinity rules and namespace-level multi-tenancy that Container Apps couldn't express." Choosing AKS "because it's more powerful" without a concrete requirement is a yellow flag to an interviewer who has run Kubernetes in production.

## Ingress controllers

AKS has no built-in HTTP ingress — you deploy one, most commonly **NGINX Ingress Controller**, the **Application Gateway Ingress Controller (AGIC)** (which drives an actual Azure Application Gateway from Kubernetes Ingress resources, getting you WAF and Azure-native integration), or **Istio/other service mesh ingress** if you need mesh features.

| Ingress option | WAF | Azure-native | Typical fit |
|---|---|---|---|
| NGINX Ingress | No (add a separate WAF) | No | Simple, portable, most common default |
| AGIC (Application Gateway) | Yes | Yes | Want WAF + Azure billing/monitoring integration |
| Istio ingress gateway | Via external WAF | No | Already running a service mesh for mTLS/traffic shaping |

## Workload identity for pod-level Azure auth

**Azure AD Workload Identity** lets individual Kubernetes pods authenticate to Azure services using a federated identity credential — no node-level managed identity shared by every pod, no secrets mounted into the pod. A pod's service account is federated with a specific Entra ID app registration/managed identity via OIDC, so only pods using that service account can get tokens for that identity.

```csharp
// Application code is unchanged — same DefaultAzureCredential pattern as anywhere else.
// Workload identity injects federated token env vars/volume automatically via the
// azure-workload-identity webhook, based on the pod's Kubernetes service account.
var credential = new DefaultAzureCredential();
var client = new SecretClient(new Uri(vaultUri), credential);
```

> [!WARNING]
> The predecessor pattern, **AAD Pod Identity**, is deprecated — it relied on intercepting IMDS traffic per-node, which was fragile and had known security gaps (any pod on a node could sometimes reach another pod's identity token). Workload Identity uses Kubernetes' own federated OIDC trust instead and is the only pattern to reach for today; naming this evolution correctly is a strong signal in an interview.

## Cluster autoscaler vs HPA vs KEDA

These operate at different layers and are commonly combined, not alternatives.

| Mechanism | Scales what | Trigger |
|---|---|---|
| Horizontal Pod Autoscaler (HPA) | Number of pod replicas | CPU/memory (or custom metrics) |
| Cluster Autoscaler | Number of **nodes** in a pool | Unschedulable pods (not enough node capacity) |
| KEDA (Kubernetes Event-Driven Autoscaling) | Number of pod replicas, including scale-to-zero | External event sources — queue length, Event Hub lag, Service Bus, Cosmos DB change feed |

```mermaid
flowchart LR
    Q["Service Bus queue depth rises"] --> KEDA["KEDA scaler"]
    KEDA --> HPA["Adjusts pod replica count"]
    HPA --> CA["Not enough node capacity?"]
    CA --> Auto["Cluster Autoscaler adds nodes"]
```

HPA and KEDA scale pods; Cluster Autoscaler scales nodes in response to pods that can't be scheduled due to insufficient capacity. If HPA/KEDA add pods but the nodes are full, those pods sit `Pending` until Cluster Autoscaler provisions more nodes — a common source of "why isn't my scale-out working" confusion.

## Node pool sizing and spot nodes

Separate node pools by workload shape — a pool with more memory-heavy VMs for one workload, GPU-enabled VMs for ML inference, spot VMs for interruptible batch jobs — rather than one generic pool for everything. **Spot node pools** run at steep discounts (up to ~90% off) but can be evicted with about 30 seconds' notice when Azure needs the capacity back; only schedule stateless, checkpoint-tolerant, or batch workloads there, using taints/tolerations so critical workloads never land on spot nodes.

| Node pool type | Typical workload |
|---|---|
| System pool | Cluster components only (tainted against app pods) |
| Standard user pool | Stateful/critical app workloads |
| Spot user pool | Batch jobs, CI runners, best-effort background processing |
| GPU pool | ML inference/training workloads |

## Upgrades and surge

AKS upgrades Kubernetes version and node OS images by cordoning and draining nodes one at a time (or in surge batches), replacing them with new nodes on the target version. **Max surge** controls how many extra nodes are provisioned during an upgrade before old ones are drained — a higher surge value speeds up upgrades but costs more temporarily and increases the blast radius of a bad new-node image; the default is conservative (surge of 1) for a reason.

> [!DANGER]
> Upgrading node images without a properly configured **PodDisruptionBudget** on critical workloads can cause an upgrade to drain more replicas than your service can tolerate at once, causing a real outage during what should be a routine maintenance operation. Always set PDBs before doing production upgrades.

## Azure Container Registry and image pull auth

ACR stores container images; AKS pulls from it using either an attached managed identity (`az aks update --attach-acr`, the modern recommended approach — no credentials stored anywhere) or an image pull secret (older pattern, requires managing and rotating a credential). ACR also supports geo-replication (pull images from the nearest region) and content trust/vulnerability scanning via Microsoft Defender for Containers.

## Networking modes: kubenet vs Azure CNI

| Mode | Pod IP allocation | VNet integration | Typical fit |
|---|---|---|---|
| Kubenet | Pods get IPs from a separate, NAT'd address space, not the VNet | Limited — pods aren't directly VNet-routable | Smaller clusters, IP-address-constrained VNets |
| Azure CNI | Every pod gets a real IP from the VNet's address space | Full — pods are directly reachable/routable within the VNet | Needing direct pod-to-VNet-resource connectivity, larger scale |
| Azure CNI Overlay | Pods get IPs from an overlay space, not consuming VNet IPs | Partial — no per-pod VNet IP but avoids IP exhaustion | Large clusters where CNI's IP consumption would exhaust the VNet |

Classic Azure CNI consumes one VNet IP address **per pod**, not per node — at scale this exhausts a VNet's address space surprisingly fast (a 250-node cluster running 30 pods/node could need thousands of IPs). CNI Overlay or kubenet avoid this; size the subnet deliberately if using classic CNI.

## Secrets via CSI driver

The **Secrets Store CSI Driver** for Key Vault mounts secrets directly into pods as files (and can sync them to Kubernetes Secrets), pulling from Key Vault at pod startup using workload identity — so secrets never need to be manually copied into Kubernetes Secret objects or `kubectl create secret` commands that leave plaintext in shell history/CI logs.

## Cheat sheet

- Control plane is Azure-managed and free (on Free/Standard tier); node pools are yours to size, patch, and pay for.
- Taint the system node pool so app workloads can't starve cluster-critical components.
- Choose AKS only when you need Kubernetes-specific capability (CRDs, mesh, namespace multi-tenancy) — not "because it's more powerful."
- HPA/KEDA scale pods; Cluster Autoscaler scales nodes when pods can't be scheduled — they work together, not instead of each other.
- Workload Identity (federated OIDC) replaces the deprecated AAD Pod Identity for pod-level Azure auth.
- Spot node pools for interruptible workloads only, isolated via taints/tolerations.
- Attach ACR to AKS via managed identity — no image pull secrets to rotate.
- Classic Azure CNI consumes one VNet IP per pod; use CNI Overlay or kubenet to avoid exhausting address space at scale.
- Set PodDisruptionBudgets before node/cluster upgrades or drains can cause real outages.

## Common mistakes

| Mistake | Fix |
|---|---|
| Letting app pods schedule onto the system node pool | Taint the system pool with `CriticalAddonsOnly=true:NoSchedule` |
| Choosing AKS without a concrete Kubernetes-specific requirement | Default to Container Apps/App Service unless you need CRDs, mesh, or cluster-level multi-tenancy |
| Using deprecated AAD Pod Identity for pod auth | Migrate to Azure AD Workload Identity (federated OIDC) |
| Running stateful, critical workloads on spot node pools | Reserve spot for stateless/interruptible/batch workloads only |
| Upgrading nodes without PodDisruptionBudgets set | Define PDBs on critical deployments before any upgrade/drain |
| Using classic Azure CNI at scale without sizing the subnet | Use CNI Overlay, or size the VNet for one IP per pod |
| Storing ACR credentials as Kubernetes image pull secrets | Attach ACR to the cluster via managed identity instead |

## Summary

AKS gives you the full power of Kubernetes at the cost of owning node pool management, upgrades, and networking decisions Azure abstracts away in App Service or Container Apps — the right answer to "why AKS" is always a specific capability requirement (CRDs, service mesh, namespace-level multi-tenancy, KEDA-driven scale-to-zero with fine control), not a default preference. Inside the cluster, separate autoscaling into its two real layers — HPA/KEDA for pods, Cluster Autoscaler for nodes — and authenticate pods to Azure via Workload Identity rather than shared node identities or mounted secrets. Node pool design (tainted system pool, spot pools for interruptible work, CNI mode chosen for your scale) and disciplined upgrade practices (surge, PodDisruptionBudgets) are what separate a cluster that survives a bad Tuesday from one that doesn't.

## Top Interview Questions

### Q1. What does Azure manage for you in AKS, and what are you still responsible for?

Azure fully manages the control plane — the API server, etcd, the scheduler, and controller manager — including its patching, availability, and (on the Standard tier) an uptime SLA; you never see or administer those VMs directly. You remain responsible for the node pools: the actual VMs that run your pods, including their OS patching cadence (though AKS automates a lot of this), node pool sizing, upgrade scheduling, and the workloads and networking configuration running on top. In short, Azure removes the hardest and most failure-prone part of running Kubernetes — the control plane — but running a healthy cluster still requires you to own capacity planning, node image upgrades, ingress, autoscaling configuration, and workload-level resilience (PodDisruptionBudgets, resource requests/limits).

### Q2. When would you choose AKS over Azure Container Apps, given both run containers?

Container Apps is built on Kubernetes under the hood but abstracts it away — you get KEDA-based event-driven autoscaling, a simpler ops model, and scale-to-zero without ever writing YAML or managing nodes, which is the right choice for the majority of containerized workloads that just need "run my container, scale it well." AKS is the right choice when you need something Container Apps deliberately doesn't expose: custom Kubernetes CRDs and operators, a service mesh with fine-grained traffic policy, namespace-level multi-tenant isolation with custom RBAC and network policies, or scheduling requirements (node affinity, taints/tolerations, GPU pools) too specific for a managed abstraction. The interview-safe framing is to start with the simplest option that meets requirements and justify AKS only against a concrete capability gap, since AKS brings real, ongoing operational cost (upgrades, node management, security patching cadence) that the simpler platforms absorb for you.

### Q3. Explain the difference between the Horizontal Pod Autoscaler, KEDA, and the Cluster Autoscaler, and how they interact.

HPA scales the number of pod replicas for a deployment based on metrics like CPU or memory utilization (or custom metrics via an adapter). KEDA extends that same idea to scale based on external event sources — Service Bus queue depth, Event Hub consumer lag, Cosmos DB change feed — and uniquely supports scaling all the way down to zero replicas when there's no work, which plain HPA can't do. Cluster Autoscaler operates one layer below both of them: it watches for pods that are `Pending` because no node has enough free capacity to schedule them, and adds nodes to the relevant node pool to accommodate them (and removes nodes when they're underutilized and pods can be safely rescheduled elsewhere). They interact in sequence: KEDA/HPA decide how many pods should exist based on load or events, and if the current nodes can't fit that many pods, Cluster Autoscaler provisions more node capacity to let the scheduler actually place them.

### Q4. What is Azure AD Workload Identity, and why did it replace AAD Pod Identity?

Workload Identity lets a Kubernetes pod authenticate to Azure services by federating its Kubernetes service account with an Entra ID app registration or managed identity via OIDC — when a pod using that specific service account requests a token, Entra ID validates the federated trust and issues a token scoped to that identity, with no node-level shared credential and no secret ever stored in the cluster. It replaced AAD Pod Identity because that older approach worked by intercepting traffic to the node's Instance Metadata Service (IMDS) and rewriting responses per-pod, which was operationally fragile (required a specific network setup per node) and had known security weaknesses — under certain conditions a pod could potentially retrieve another pod's identity token from the same node, defeating the isolation the feature was meant to provide. Workload Identity avoids all of this by using Kubernetes' native, standards-based OIDC federation instead of intercepting node-level traffic.

### Q5. A batch processing workload keeps getting evicted unexpectedly and losing progress. What would you check about its node pool configuration?

I'd first check whether the workload is scheduled on a **spot node pool** — spot VMs offer steep discounts specifically because Azure can reclaim that capacity with about 30 seconds' notice when it's needed elsewhere, so eviction is expected behavior, not a bug, for anything running there. If the workload genuinely needs to tolerate that, I'd check whether it's designed to checkpoint progress frequently enough to resume cheaply after eviction, and whether it's using the eviction notification (via the Node's `spotVM` termination handler or Kubernetes' native drain signal) to save state gracefully rather than being killed mid-work with no warning handling at all. If the workload can't tolerate interruption at all, the fix is simpler: it shouldn't be on a spot node pool in the first place — move it to a standard (on-demand) user node pool, using taints/tolerations to make sure it's never accidentally scheduled onto spot capacity again.

### Q6. Why does classic Azure CNI networking sometimes run out of IP addresses at scale, and what would you do about it?

Classic Azure CNI assigns every pod a real, routable IP address from the VNet's subnet — not just every node, every individual pod — which means the number of IP addresses consumed scales with pod count, not node count. A cluster with 250 nodes running an average of 30 pods each could consume several thousand VNet IP addresses just for pods, on top of node and service IPs, which can exhaust a subnet that was sized assuming "a few IPs per node." The fixes are either to size the subnet generously up front accounting for maximum pods-per-node × max nodes, or to use **Azure CNI Overlay**, which gives pods IPs from a separate overlay address space that doesn't consume VNet IPs at all while still supporting most of CNI's networking features — or fall back to kubenet for smaller clusters where full per-pod VNet routability isn't required.

### Q7. How do you prevent application workloads from starving cluster-critical components like CoreDNS during a load spike?

By isolating the **system node pool** — the pool that AKS designates to run cluster-critical add-ons like CoreDNS, metrics-server, and the tunnel/proxy agents — with a taint such as `CriticalAddonsOnly=true:NoSchedule`, so the Kubernetes scheduler will not place ordinary application pods there regardless of how much capacity looks free. Application workloads run exclusively on separate user node pools, sized and autoscaled independently, so a runaway load spike or a misbehaving app pod consuming excessive CPU/memory can't starve the components the entire cluster's networking and observability depend on. This is a standard AKS hardening step and one of the first things I'd check in an architecture or security review of an existing cluster.

### Q8. Your team wants to do a Kubernetes minor version upgrade on a production AKS cluster during business hours. What would you set up first?

Before the upgrade, I'd make sure every critical Deployment/StatefulSet has a **PodDisruptionBudget** defined, specifying the minimum number of healthy replicas that must remain available during any voluntary disruption — without it, the upgrade process (which cordons and drains nodes to replace them with new-version nodes) can drain more replicas of a service simultaneously than the service can tolerate, causing a real availability dip during what's supposed to be routine maintenance. I'd also review the cluster's **max surge** setting, which controls how many extra nodes get provisioned ahead of draining old ones — a low surge (the default is conservative) minimizes blast radius if something's wrong with the new node image, at the cost of a slower upgrade; I'd validate the target version in a non-production cluster first, and schedule the actual upgrade with monitoring dashboards open specifically watching for failed pod scheduling or a spike in the readiness-probe failure rate during the drain sequence.

### Q9. How would you set up secrets for a pod that needs to read a database connection string from Key Vault, without storing anything in a Kubernetes Secret manually?

I'd use the **Secrets Store CSI Driver for Key Vault**, combined with Workload Identity: the pod is associated with a Kubernetes service account federated to an Entra ID identity that's been granted the appropriate Key Vault RBAC role (e.g. Key Vault Secrets User), and a `SecretProviderClass` resource declares which Key Vault secret(s) the pod needs. At pod startup, the CSI driver uses the pod's federated identity to fetch the secret directly from Key Vault and mounts it as a file inside the pod's filesystem — optionally also syncing it into a native Kubernetes Secret object if some component genuinely requires that form, but the source of truth stays in Key Vault. This avoids ever running `kubectl create secret` with a plaintext value (which tends to leak into shell history or CI logs) and means secret rotation in Key Vault can be picked up by re-mounting rather than someone manually updating a Kubernetes Secret.

### Q10. How does AKS authenticate to Azure Container Registry to pull images, and why is attaching the registry via managed identity preferred over an image pull secret?

The older approach creates a Kubernetes image pull secret containing ACR credentials (either an admin account or a service principal), which the kubelet uses to authenticate when pulling images — this works, but it's a standing credential that lives in the cluster, needs manual rotation before it expires, and has to be recreated/updated on every credential rotation across potentially many namespaces. The preferred modern approach attaches the ACR directly to the AKS cluster (`az aks update --attach-acr`), which grants the cluster's kubelet identity (a managed identity) the AcrPull role on the registry — no credential is stored in the cluster at all, and pulling an image relies on the same managed identity token flow used everywhere else in Azure, with no manual rotation ever required. I'd recommend attaching the registry via managed identity as the default, reserving image pull secrets only for scenarios like pulling from a registry outside the Azure tenant where managed identity federation isn't an option.
