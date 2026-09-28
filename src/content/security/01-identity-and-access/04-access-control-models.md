---
title: Access Control Models
description: RBAC, ABAC, ReBAC and ACLs compared, why roles explode at scale, and how to design and audit authorization decisions in a real system
difficulty: Core
tags: [access-control, rbac, abac, authorization, least-privilege]
---

Once you know *who* someone is, access control decides *what* they can do — and the model you pick determines whether that decision stays maintainable at scale or turns into an unauditable mess of one-off roles. Interviewers use this topic to see whether you can match a model to a real permission shape, not just recite acronyms.

## RBAC, ABAC, ReBAC, and ACLs compared

| Model | How decisions are made | Flexibility | Auditability | Scale | Typical use |
|---|---|---|---|---|---|
| RBAC (role-based) | User → role → fixed set of permissions | Low — permissions are coarse and static per role | High — "who has role X" is a simple query | Good for a modest number of distinct roles | Internal admin tools, most SaaS apps |
| ABAC (attribute-based) | Policy evaluates attributes of user, resource, environment at request time | High — arbitrary conditions (department = resource.department, time-of-day, clearance level) | Harder — decision depends on runtime context, not a static table | Scales to many fine-grained rules without new roles | Regulated industries, complex multi-dimensional rules |
| ReBAC (relationship-based) | Access follows a graph of relationships (owner, member-of, shared-with) | High for hierarchical/social data | Moderate — traceable via the relationship graph | Scales well for deeply nested sharing (folders, docs, orgs) | Google Drive-style sharing, social graphs, nested orgs |
| ACL (access control list) | Explicit per-resource list of (subject, permission) pairs | High per-resource, but no reuse across resources | Easy per-resource, hard in aggregate ("what can Alice access everywhere?") | Poor — list grows with users × resources | Filesystems, small numbers of shared resources |

> [!KEY]
> There is no universally "best" model — RBAC is simple until roles multiply, ABAC is flexible until policies become hard to reason about, ReBAC fits naturally nested sharing, ACLs are fine until you need a cross-resource view of one user's access. Most real systems combine two.

## Role explosion, and how ABAC fixes it

Pure RBAC breaks down when permissions genuinely depend on more than "which role" — e.g. "managers can approve expenses **under $500**, but only **for their own department**, and only **during business hours**." Modeling every combination as a distinct role (`manager-finance-under500-business-hours`) causes **role explosion**: the number of roles grows combinatorially with the number of independent conditions, and most of them are used by a handful of people.

ABAC replaces the combinatorial role list with a single policy that evaluates attributes at request time:

```text
allow if user.role == "manager"
   and user.department == resource.department
   and resource.amount < 500
   and time.hour between 9 and 17
```

One policy, evaluated dynamically, replaces what could be dozens of static roles. The cost is that "list everyone who can approve this" now requires *evaluating* the policy against every candidate rather than reading a table — a real auditability trade-off.

> [!TIP]
> A strong interview answer names the trigger for switching: "when a permission depends on more than one independent dimension — role *and* resource attribute *and* context — that's the signal RBAC alone won't scale, and it's time to introduce ABAC rules or a policy engine, at least for that subset of decisions."

## Permissions vs roles vs scopes

These three are often conflated:

- **Permission** — the smallest unit of "can do X to Y" (`orders.cancel`, `invoices.read`).
- **Role** — a named bundle of permissions assigned to a user (`support-agent` = `orders.read` + `orders.refund`).
- **Scope** — a permission boundary carried in a *token* (typically OAuth), limiting what an already-authenticated client is allowed to request, independent of the user's full role (`orders.read` scope on a token issued to a read-only reporting integration).

> [!NOTE]
> A user's role can grant `orders.refund`, but if their access token was only issued with the `orders.read` scope, the request should still be denied — scope is a *ceiling* on top of role-based permissions, not a replacement for them.

## Resource-based authorization

Role and scope checks answer "can this kind of user do this kind of action" — they don't know *which specific record*. Resource-based authorization adds the object into the decision: "can **this** user cancel **this specific** order" typically requires checking ownership or tenancy (`order.customerId == currentUser.id`) in addition to the role check. Skipping this step, and checking only the role, is exactly how IDOR (insecure direct object reference) bugs happen — a valid, authenticated user with the right role accesses someone *else's* resource simply by changing an ID in the URL.

## Policy decision point vs policy enforcement point

Separating **where a decision is made** from **where it's enforced** is the architecture behind any non-trivial authorization system:

- **PDP (policy decision point)** — evaluates the policy/rules and returns allow/deny, given the request context.
- **PEP (policy enforcement point)** — sits in the request path (gateway, middleware, or the service itself) and actually blocks or allows the call based on the PDP's answer.

```mermaid
flowchart LR
    C["Client Request"] --> PEP["Policy Enforcement Point<br/>(API middleware)"]
    PEP -->|"context: user, resource, action"| PDP["Policy Decision Point<br/>(policy engine)"]
    PDP -->|"allow / deny"| PEP
    PEP -->|"allow"| S["Service Logic"]
    PEP -->|"deny"| D["403 Forbidden"]
```

Splitting these lets you change policy (PDP) — adding a new rule, updating a role's permissions — without redeploying every service that enforces it (PEP), and lets multiple services share one consistent decision engine instead of each re-implementing authorization logic slightly differently.

## Multi-tenancy isolation

In a multi-tenant system, every authorization check needs an implicit extra clause: **and the resource belongs to this tenant.** This is the check most commonly forgotten, because a naive role check ("is this user an admin") can pass while the resource being touched belongs to a completely different customer.

| Isolation approach | How it works | Failure mode if skipped |
|---|---|---|
| Row-level tenant filter | Every query includes `WHERE tenant_id = @current` | Cross-tenant data leak via a missing `WHERE` clause |
| Separate schema/database per tenant | Physical isolation, no shared table to forget a filter on | Higher operational cost, harder cross-tenant reporting |
| Claim-based tenant scoping | Token carries `tenant_id`; middleware injects it into every query automatically | Relies on every code path going through that middleware — one manual query bypasses it |

> [!DANGER]
> "The user is an admin" is not the same statement as "the user is an admin **of this tenant**." Every resource-based check in a multi-tenant system must include tenant ownership, not just role.

## Least privilege and just-in-time elevation

**Least privilege** means granting the minimum permission needed for the task, for the minimum time needed — not provisioning broad, always-on access "in case it's needed later." **Just-in-time (JIT) access elevation** operationalizes this: a user requests a higher privilege (e.g. production database write access) for a bounded window, an approver signs off, the elevation is granted with an expiry, and it's automatically revoked afterward — with the whole request/approval/expiry trail logged for audit.

## Separation of duties

Separation of duties (SoD) prevents any single person from controlling an entire sensitive workflow end-to-end — the classic example is that the person who *creates* a vendor payment should not also be the person who *approves* it. Access control models express this as a conflict rule: a policy that flags or blocks a user from holding two roles that together would let them self-approve, and it's frequently a compliance requirement (SOX, PCI-DSS) rather than just a good idea.

## Auditing access decisions

Every deny (and, for sensitive resources, every allow) should be logged with enough context to answer "who tried to do what, to which resource, under which policy, and why it was allowed or denied" after the fact — not just a boolean in a log line. This is what makes access control reviewable months later, and what turns "we think we're secure" into "we can prove which roles could have accessed this record on this date."

## Implementing resource-based authorization in ASP.NET Core

```csharp
public class OrderOwnerRequirement : IAuthorizationRequirement { }

public class OrderOwnerHandler : AuthorizationHandler<OrderOwnerRequirement, Order>
{
    protected override Task HandleRequirementAsync(
        AuthorizationHandlerContext context,
        OrderOwnerRequirement requirement,
        Order resource)
    {
        var userId = context.User.FindFirst("sub")?.Value;
        var tenantId = context.User.FindFirst("tenant_id")?.Value;

        // Resource-based check: ownership AND tenant isolation, not just role
        if (resource.CustomerId == userId && resource.TenantId == tenantId)
            context.Succeed(requirement);

        return Task.CompletedTask;
    }
}

// In the controller/endpoint:
var order = await _orders.GetAsync(orderId);
var result = await _authorizationService.AuthorizeAsync(User, order, "OrderOwner");
if (!result.Succeeded) return Forbid();
```

> [!TIP]
> `AuthorizeAsync(User, resource, policy)` — passing the actual resource object — is the pattern that catches IDOR bugs. A plain `[Authorize(Roles = "Customer")]` attribute only checks the role; it never looks at *which* order is being requested.

## Cheat sheet

- RBAC: simple, auditable, breaks down as roles multiply (role explosion).
- ABAC: one policy replaces many roles when permissions depend on multiple independent attributes.
- ReBAC: models nested sharing/ownership graphs naturally (folders, docs, orgs).
- ACL: fine per-resource, painful for "what can this user access everywhere."
- Permission = smallest unit; role = bundle of permissions; scope = token-level ceiling on top of both.
- Resource-based authorization checks the *specific object*, not just the role — this is what prevents IDOR.
- PDP decides, PEP enforces — separating them lets policy change without redeploying every service.
- Multi-tenant checks always need "and belongs to this tenant", not just role.
- Least privilege + JIT elevation: grant the minimum, for the minimum time, with an approval trail.
- Separation of duties blocks one person from controlling an entire sensitive workflow alone.

## Common mistakes

| Mistake | Fix |
|---|---|
| Checking only role, never the specific resource | Add resource-based / ownership checks to prevent IDOR |
| Creating a new role for every attribute combination | Switch to ABAC for permissions with multiple independent conditions |
| Forgetting tenant ownership in a multi-tenant check | Always AND role checks with tenant/ownership checks |
| Granting standing admin access "in case it's needed" | Use just-in-time elevation with expiry and approval |
| Letting one person create and approve the same transaction | Enforce separation of duties as an explicit policy rule |
| Logging only "allowed/denied" with no context | Log user, resource, action, and the policy/role that decided it |

## Summary

RBAC, ABAC, ReBAC, and ACLs each model authorization differently, and picking the right one — or combining them — depends on how many independent dimensions your permissions actually vary along and how important auditability is. Role explosion is the concrete signal that RBAC alone has run out of road; resource-based checks and tenant-aware queries are what stop a syntactically valid role check from becoming an IDOR or cross-tenant leak. Separating the policy decision (PDP) from its enforcement (PEP), applying least privilege with just-in-time elevation, and logging every decision with enough context to reconstruct it later are what turn "we have an authorization system" into "we can prove our authorization system worked."

## Top Interview Questions

### Q1. Compare RBAC and ABAC, and describe a concrete scenario where you'd switch from one to the other.

RBAC assigns permissions to roles and roles to users — simple to reason about and easy to audit ("who has the `admin` role"), but the set of permissions per role is static. ABAC evaluates a policy against attributes of the user, the resource, and the environment at request time, which lets you express conditional rules ("managers can approve expenses under $500, only for their own department, only during business hours") without creating a role for every combination. The concrete trigger to switch: once a permission genuinely depends on more than one independent variable — role *and* a resource attribute *and* context like time or amount — trying to model that as roles causes role explosion, where you end up with dozens of narrow, single-use roles. At that point, introducing an ABAC policy (even just for that subset of decisions) keeps the system maintainable.

### Q2. What is role explosion, and how would you detect that it's happening in a real system?

Role explosion is when the number of distinct roles grows combinatorially because each new permission dimension (department, resource type, amount threshold, time window) gets baked into more and more narrowly-scoped roles instead of being expressed as a general rule. You can detect it by looking at role usage data: if you have hundreds of roles and most are assigned to one or two users, or role names encode multiple concerns (`manager-finance-under500`), that's the signature. The fix isn't to eliminate RBAC entirely — keep RBAC for the coarse, stable permission tiers (admin, member, viewer) and introduce ABAC policies layered on top for the fine-grained, multi-dimensional conditions, rather than trying to force everything into one model.

### Q3. What's the difference between a permission, a role, and an OAuth scope?

A permission is the atomic unit — "can do X to Y" (`orders.cancel`). A role is a named collection of permissions assigned to a user (`support-agent` bundles several read/refund permissions). A scope is a boundary carried in a token, typically issued through OAuth, that limits what an already-authenticated client is allowed to request regardless of the underlying user's full role set — for example, a reporting integration might be issued a token with only the `orders.read` scope even though the user who authorized it has a role that includes `orders.refund`. In a correct implementation, an action is only allowed if it passes both checks: the user's role must include the permission, *and* the token's scope must not exclude it — scope is a ceiling on top of role, not a substitute for it.

### Q4. What is IDOR, and how does resource-based authorization prevent it?

Insecure Direct Object Reference (IDOR) happens when an application checks that a user is authenticated and has the right general role, but never checks whether the *specific resource* being requested actually belongs to or is shared with that user — so changing `/orders/1001` to `/orders/1002` in the URL returns someone else's order, because the role check ("is a logged-in customer") passes regardless of which order ID is requested. Resource-based authorization fixes this by loading the actual resource and checking a relationship — ownership, tenancy, or an explicit share — as part of the authorization decision, not just checking the role in isolation. Concretely, in ASP.NET Core this means calling `AuthorizeAsync(user, resource, policy)` with the loaded entity, so the handler can compare `resource.CustomerId` against the current user's ID, rather than relying solely on a `[Authorize(Roles = ...)]` attribute that never sees which record is being accessed.

### Q5. Explain the difference between a policy decision point (PDP) and a policy enforcement point (PEP), and why you'd want to separate them.

The PDP is the component that evaluates the actual authorization logic — given a user, a resource, and an action, it returns allow or deny, based on roles, attributes, or relationships. The PEP is the component sitting in the request path — API gateway middleware, or a check inside the service itself — that actually calls the PDP and enforces its answer by letting the request through or rejecting it. Separating them means you can change or update policy centrally (add a new rule, adjust a role's permissions, plug in a policy engine) without redeploying every service that enforces access, and multiple services can share one consistent decision engine instead of each re-implementing slightly different authorization logic. The trade-off is an extra network hop or library call per request if the PDP is a separate service, which is why PDP decisions are often cached briefly at the PEP.

### Q6. In a multi-tenant SaaS application, what's wrong with checking only "is this user an admin" before allowing an action?

It's missing the tenant-isolation dimension. "Is this user an admin" can be true while the resource they're trying to act on belongs to a completely different tenant — an admin at Company A should never be able to touch Company B's data, but a role-only check has no concept of "admin of which tenant." Every authorization check in a multi-tenant system needs an implicit additional clause: the resource's tenant ID must match the current user's tenant ID (typically carried as a claim in their token), applied consistently across every query and every service, not just at the UI layer. The failure mode to call out explicitly: a single query that forgets the `WHERE tenant_id = @current` filter is a cross-tenant data leak, even if every role check upstream was correct.

### Q7. What is just-in-time (JIT) access elevation, and how does it support the principle of least privilege?

Least privilege means granting only the access needed for a task, for only as long as it's needed — not provisioning broad standing permissions "in case they're useful later." JIT elevation operationalizes this for occasional high-privilege needs: instead of a user holding permanent production-database write access, they request elevation for a specific, time-boxed window, an approver reviews and grants it, the system enforces automatic expiry, and the whole request/approval/expiry sequence is logged. This shrinks the attack surface dramatically — a compromised account only has the elevated access an attacker could exploit during the (rare, short, logged) windows it was actually granted, rather than permanently — and it produces a clean audit trail showing exactly who approved which elevated access and why, which standing permissions never provide.

### Q8. What is separation of duties, and how would you enforce it in an access control system?

Separation of duties (SoD) is the principle that no single person should be able to control an entire sensitive process end-to-end — for example, the person who creates a vendor payment request should not be the same person who approves it, because that combination lets one compromised or malicious account complete fraud alone. You enforce it by defining conflicting-role or conflicting-permission rules directly in the access control model: either block a user from being assigned two roles that together would violate SoD, or add a runtime check that a payment's creator and approver claims cannot be the same user ID, regardless of what roles either holds. This is often a compliance requirement (SOX for financial controls, PCI-DSS for payment systems) as well as a security best practice, and audits typically ask for evidence that the rule is actively enforced, not just documented.

### Q9. You're auditing an access control system after a security incident and find that authorization decisions were logged only as `{"allowed": true}` or `{"allowed": false}`. What's missing, and why does it matter?

Missing context: who made the request, what resource and action were involved, what role/attribute/relationship the decision was based on, and which policy or rule produced the allow/deny. A bare boolean tells you a decision happened but not *why* — you can't reconstruct whether a specific user should have had access to a specific record on a specific date, which is exactly the question an incident investigation or compliance audit needs answered. The fix is to log a structured record per decision: subject (user/service), resource ID, action, decision, and the specific rule/role/policy that determined it, ideally centralized wherever the PDP runs so decisions across services are queryable consistently rather than scattered in inconsistent per-service log formats.

### Q10. When would you choose ReBAC over RBAC or ABAC?

ReBAC (relationship-based access control) fits naturally when access genuinely follows a graph of relationships rather than a flat role or a fixed attribute rule — the canonical example is a file-sharing product like Google Drive, where a document can be owned by one user, shared directly with several others, and inherited-shared through being inside a shared folder, several levels deep. Modeling that in RBAC would require a role per unique sharing combination (unworkable), and ABAC policies get awkward expressing "shared transitively through a folder hierarchy" as attribute conditions. ReBAC instead models "user is a member of group", "group has access to folder", "folder contains document" as edges in a graph and answers access queries by traversing relationships — Google's Zanzibar system (which inspired several open-source implementations) is the reference architecture here. The trade-off: it requires a purpose-built relationship-graph store and query engine, more operational complexity than a roles table, so it's worth it specifically when nested/inherited sharing is a first-class product feature, not a rare edge case.

### Q11. How would you design authorization for an API endpoint that lets a support agent refund an order, considering role, resource ownership, and scope?

Layer the checks rather than relying on one: first, authenticate the caller and extract their role and the token's scopes; second, check the role grants the general permission (`orders.refund` is part of the `support-agent` role); third, check the token's scope doesn't exclude it (if this is a machine token with only `orders.read` scope, deny regardless of the human's role); fourth, load the specific order and apply a resource-based check — does this support agent's assigned queue/region/tenant actually include this order, and is the order in a refundable state (not already refunded, not older than the policy window). Each layer answers a different question — role answers "can support agents refund in general", scope answers "is this specific token allowed to", resource-based answers "is this the right specific order" — and skipping any one of them is how either a scope-restricted integration or an out-of-scope order slips through.

### Q12. What are the trade-offs of ACLs compared to RBAC for a document-sharing feature with a few thousand users?

ACLs let you grant access per-resource with complete flexibility — share this exact document with these exact five people — which RBAC can't express without creating a role per document, an obvious non-starter. But ACLs don't scale in the other direction: answering "what can this user access across the entire system" means scanning every resource's list rather than reading one row from a roles table, and the total storage grows with users × shared resources rather than users × roles. RBAC, conversely, is efficient for coarse, stable permission tiers (owner, editor, viewer as roles) but can't express arbitrary one-off sharing without exploding into per-document roles. In practice, most sharing features use a hybrid: RBAC (or ReBAC) for the general permission tier a share grants, and an ACL-like table of individual (user, resource) grants to record *who specifically* has access to *which specific* resource — getting the flexibility of ACLs for the sharing itself while keeping "what tier of access" expressed as a small, reusable set of roles.
