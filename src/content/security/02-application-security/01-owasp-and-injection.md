---
title: OWASP Risks and Injection
description: The OWASP Top 10 risk categories explained briefly, then a deep dive into the injection and access-control bugs that come up most in interviews
difficulty: Core
tags: [owasp, injection, sql-injection, ssrf, application-security]
---

The OWASP Top 10 is the industry's reference list of the most impactful web application risk categories, and interviewers use it as a checklist to see how many you can explain from first principles rather than just name. This page covers the full list briefly, then goes deep on the handful — injection, SSRF, access control, deserialization — that show up as actual code-review and debugging questions.

## The OWASP Top 10 (2021 edition)

| Risk | What it is | One-line defence |
|---|---|---|
| Broken access control | Users can act outside their intended permissions | Enforce authorization server-side on every request, never trust the client |
| Cryptographic failures | Sensitive data exposed due to weak or missing encryption | Encrypt in transit and at rest; use vetted algorithms, never roll your own |
| Injection | Untrusted input is interpreted as code/commands (SQL, OS, LDAP) | Parameterize queries and commands; never concatenate untrusted input |
| Insecure design | Security flaws baked into the architecture itself, not just the code | Threat-model before building; design in controls, don't bolt them on |
| Security misconfiguration | Default credentials, verbose errors, unnecessary features left enabled | Harden defaults, disable what you don't use, automate config checks |
| Vulnerable and outdated components | Using libraries/frameworks with known CVEs | Track dependencies, patch on a schedule, scan CI for known vulnerabilities |
| Identification and authentication failures | Weak login, session, or credential handling | MFA, strong session management, rate-limit login attempts |
| Software and data integrity failures | Trusting unsigned code/updates or insecure deserialization | Verify signatures on updates/dependencies; avoid deserializing untrusted data |
| Security logging and monitoring failures | Attacks go undetected because nothing is logged or alerted | Log security-relevant events centrally and alert on anomalies |
| Server-side request forgery (SSRF) | Server is tricked into making requests to unintended destinations | Allowlist destinations, block internal IP ranges, disable redirects |

> [!KEY]
> Interviewers rarely expect all ten memorized verbatim — they expect you to *explain the mechanism* behind two or three, especially injection, broken access control, and SSRF, since those map directly to code you've likely written.

## SQL injection

SQL injection happens when untrusted input is concatenated directly into a query string, letting an attacker change the query's *structure*, not just its data.

```csharp
// VULNERABLE — user input becomes part of the SQL text
var query = $"SELECT * FROM Users WHERE Username = '{username}' AND Password = '{password}'";
var result = command.ExecuteReader(query);

// Attacker sends username: admin' -- 
// Resulting query: SELECT * FROM Users WHERE Username = 'admin' -- ' AND Password = '...'
// Everything after -- is a SQL comment: password check is bypassed entirely
```

```csharp
// FIXED — parameterized query; input is always treated as data, never as SQL syntax
var query = "SELECT * FROM Users WHERE Username = @Username AND Password = @PasswordHash";
command.Parameters.AddWithValue("@Username", username);
command.Parameters.AddWithValue("@PasswordHash", passwordHash);
var result = command.ExecuteReader(query);
```

Parameterization works because the database driver sends the query plan and the data **separately** — the input is never re-parsed as SQL syntax, so no amount of quotes or comment markers in the input can change the query's meaning.

> [!WARNING]
> Escaping quotes (`'` → `''`) is not equivalent to parameterization — it's easy to miss an encoding edge case (e.g. multi-byte character sets, or a second injection point you forgot to escape), and it does nothing for injection contexts other than string literals, like numeric fields or `ORDER BY` column names built from user input. Parameterize; don't escape.

> [!DANGER]
> An ORM does not automatically make you safe. `context.Database.ExecuteSqlRaw($"SELECT * FROM Users WHERE Name = '{name}'")` is just as injectable as raw ADO.NET — the vulnerability is string concatenation, not the data-access layer. Use the ORM's parameterized APIs (`ExecuteSqlInterpolated`, LINQ expressions) instead of building raw SQL strings.

**Second-order injection** is the same root cause with a delay: input is safely stored (perhaps even validated on the way in), but later read back and concatenated unsafely into a *different* query — for example, a username stored safely at signup is later used, unparameterized, to build a report query. The lesson: safety has to hold at every point data is used in a query, not just the first one.

## Command and LDAP injection

| Injection type | Mechanism | Fix |
|---|---|---|
| OS command injection | Untrusted input concatenated into a shell command (`Process.Start("cmd", "/c ping " + host)`) | Avoid shelling out to build commands from input; use library APIs, or an argument array (never a single concatenated string) and an allowlist for any input that must reach a shell |
| LDAP injection | Untrusted input concatenated into an LDAP filter string (`(&(uid=" + user + ")(pwd=" + pass + "))`) | Use the LDAP library's parameterized filter/escaping API, and validate input against an expected character set |

Both follow the exact same pattern as SQL injection: an interpreter (shell, LDAP directory) treats attacker-controlled special characters as *syntax* instead of *data* because the input was concatenated into a command/filter string rather than passed through an API that keeps the two separate.

## NoSQL injection

Document databases are not immune just because they don't use SQL syntax. MongoDB-style queries built from raw JSON are vulnerable when an attacker can inject **operators** instead of values:

```javascript
// If username/password come straight from request body without validation:
db.users.find({ username: username, password: password });

// Attacker sends: { "username": "admin", "password": { "$ne": null } }
// Query becomes "password not equal to null" — matches any password, auth bypassed
```

The fix is the same principle as SQL: validate and constrain input types strictly (reject objects where a string is expected), and use the driver's parameter-binding or schema validation features rather than trusting that JSON input can't contain operators.

## Server-side request forgery (SSRF)

SSRF tricks a server into making a request to a destination the attacker chose — often an internal-only address the attacker couldn't reach directly. The classic target is a **cloud metadata endpoint** (`http://169.254.169.254/...`), which many cloud platforms expose only to instances themselves and which can return credentials or tokens for the instance's identity.

```mermaid
flowchart LR
    A["Attacker"] -->|"Submits URL: http://169.254.169.254/metadata/..."| S["Vulnerable Server<br/>(e.g. image-fetch or webhook feature)"]
    S -->|"Server-side request<br/>fetches attacker-chosen URL"| M["Cloud Metadata Endpoint<br/>(internal-only)"]
    M -->|"Instance credentials/token"| S
    S -->|"Response reflected back"| A
```

A feature like "fetch this image URL to generate a thumbnail" or "call this webhook URL" is a classic SSRF vector: the *server*, not the attacker's browser, makes the outbound call, so any network restriction that only blocks the attacker's own IP is irrelevant — the request legitimately originates from inside the trusted network.

| Defence | How it helps |
|---|---|
| Allowlist destinations | Only permit requests to a known, explicit set of hosts/domains, rejecting everything else by default |
| Block internal IP ranges | Deny requests to `169.254.169.254`, `127.0.0.1`, `10.0.0.0/8`, and other private ranges at the network or application layer |
| Disable redirects (or re-validate after each hop) | An allowlisted URL can still redirect to an internal address — validate the destination again after following any redirect, or disable following redirects entirely |
| Network egress control | Restrict what the server's network segment can reach at all, so even a bypassed application check has a network-layer backstop |

> [!DANGER]
> Validating the URL's hostname once, then following redirects blindly, is a common SSRF bypass: `https://allowed-domain.com/redirect?to=http://169.254.169.254/...` passes the initial check but the actual request ends up at the metadata endpoint after the redirect.

## Insecure deserialization

Deserializing untrusted data with a format that can reconstruct arbitrary types (like .NET's `BinaryFormatter`, or unrestricted polymorphic JSON deserialization) can let an attacker craft a payload that instantiates unexpected classes, sets unexpected fields, or in the worst case triggers remote code execution through "gadget chains" — sequences of legitimate class behaviors during deserialization that combine into an exploit. The fix: never deserialize untrusted data with a format that allows arbitrary type instantiation; prefer plain-data formats (JSON with a fixed, known schema and no type-name handling enabled) and, where legacy binary formats are unavoidable, treat every deserialization boundary as parsing hostile input, not just as loading trusted data.

## Broken access control, including IDOR

Broken access control covers any case where server-side enforcement doesn't match the intended permission model — missing checks, checks that trust client-supplied data, or checks that only verify role and not the specific resource.

**Worked IDOR example:** an invoice download endpoint, `GET /invoices/{id}/pdf`, checks only that the caller is authenticated, not that the invoice belongs to them:

```csharp
// VULNERABLE — any logged-in user can view any invoice by guessing/incrementing the ID
[Authorize]
[HttpGet("invoices/{id}/pdf")]
public IActionResult GetInvoice(int id)
{
    var invoice = _db.Invoices.Find(id);
    return File(invoice.Pdf, "application/pdf");
}

// FIXED — resource-based check: does this invoice belong to the caller?
[Authorize]
[HttpGet("invoices/{id}/pdf")]
public IActionResult GetInvoice(int id)
{
    var invoice = _db.Invoices.Find(id);
    if (invoice == null || invoice.CustomerId != CurrentUserId)
        return Forbid();
    return File(invoice.Pdf, "application/pdf");
}
```

This is exactly the resource-based authorization gap described in access control models: authentication passed, the role check (if any) passed, but nothing verified *ownership* of the specific resource being requested, letting sequential IDs (or leaked/shared ones) expose every user's data to every other user.

## Security misconfiguration

This is the catch-all for "the feature works correctly, but was deployed insecurely": default admin credentials never changed, verbose stack traces exposed in production error pages, directory listing left enabled on a web server, an unnecessary debug endpoint reachable in production, or overly permissive CORS (`Access-Control-Allow-Origin: *` combined with credentialed requests). None of these are bugs in application logic — they're gaps in hardening — which is why they're best caught by automated configuration baselines and checklists rather than code review alone.

## Cheat sheet

- Injection's root cause is always the same: untrusted input treated as *syntax* instead of *data* — SQL, shell, LDAP, NoSQL operators, it's one pattern repeated.
- Parameterize, don't escape — escaping is context-specific and easy to get wrong; parameterization removes the ambiguity entirely.
- ORMs and ODMs are only safe if you use their parameterized APIs — raw string concatenation defeats them just as easily.
- Second-order injection: safe-looking stored input can still be unsafely used later — check every use, not just the first.
- SSRF exploits the *server's* network position — allowlist destinations, block internal ranges, and re-validate after redirects.
- Never deserialize untrusted data with a format that allows arbitrary type instantiation.
- IDOR is a missing resource-based (ownership) check, not a missing authentication check — the user is legitimately logged in.
- Security misconfiguration is a hardening/checklist problem, not a coding bug — automate the checks.

## Common mistakes

| Mistake | Fix |
|---|---|
| Building SQL/shell/LDAP strings via concatenation | Use parameterized queries / argument arrays / library escaping APIs |
| Assuming an ORM makes raw SQL calls automatically safe | Use the ORM's parameterized query methods, never raw string interpolation |
| Validating a URL once and then following redirects blindly | Re-validate the destination after every redirect, or disable redirects |
| Checking only role/authentication for a resource endpoint | Add an explicit ownership/tenant check on the loaded resource |
| Deserializing untrusted data with a fully polymorphic format | Restrict to plain-data formats with a fixed schema and no type-name handling |
| Leaving default credentials or debug endpoints enabled in production | Automate a hardening checklist as part of the deployment pipeline |

## Summary

Most of the OWASP Top 10 that actually gets tested in interviews reduces to a handful of mechanisms: injection is untrusted input being interpreted as code instead of data, SSRF is the server being tricked into using its own trusted network position on the attacker's behalf, broken access control is a missing check on the *specific resource* rather than just the user's identity, and insecure deserialization is trusting a data format that can reconstruct arbitrary objects. In every case the fix is structural — parameterize, allowlist, check ownership, restrict formats — not a patch applied after the fact. Being able to write both the vulnerable and the fixed version of a SQL query, and explain exactly why the fix works at the protocol level, is what separates a memorized list from real understanding.

## Top Interview Questions

### Q1. Explain SQL injection and why parameterized queries fix it, not just escaping quotes.

SQL injection occurs when untrusted input is concatenated directly into a query string, letting the attacker's input change the query's *structure* — for example, closing a string literal early and appending `OR 1=1 --` to bypass a WHERE clause entirely. Parameterized queries fix this at the protocol level: the query text (with placeholders) and the parameter values are sent to the database *separately*, so the database never re-parses the input as SQL syntax — it's bound as a literal value regardless of what characters it contains. Escaping quotes only closes one specific hole (breaking out of a string literal) and is easy to get wrong across encodings or in non-string contexts like numeric fields or dynamically built column/table names; parameterization removes the entire class of ambiguity rather than patching one symptom.

### Q2. Does using an ORM like Entity Framework automatically protect against SQL injection?

Not automatically — it depends entirely on how you call it. LINQ queries and EF's parameterized APIs (`ExecuteSqlInterpolated`, standard LINQ expressions) are safe because EF translates them into parameterized SQL under the hood. But EF also exposes raw-SQL escape hatches like `ExecuteSqlRaw`, and if you build that raw SQL string via concatenation or string interpolation with untrusted input, you've reintroduced the exact same vulnerability as raw ADO.NET — the ORM doesn't magically sanitize a string you built yourself before handing it a full SQL command. The rule to state plainly: safety comes from *how the input reaches the database* (as a bound parameter vs. as part of the query text), not from which library sits in front of it.

### Q3. What is second-order SQL injection, and why is it more dangerous to catch in code review than the classic form?

Second-order injection happens when untrusted input is safely stored — perhaps even validated or sanitized on the way in — but later retrieved and unsafely concatenated into a *different* query, at a point in the codebase that looks completely disconnected from user input, since it's reading from your own database rather than directly from a request. For example, a username containing a crafted string is stored correctly via a parameterized insert at signup, but a reporting feature later builds a raw SQL string using that stored username without parameterizing it, triggering the injection at that second point. It's harder to catch in review because the "obviously untrusted" data source (the HTTP request) isn't in the same function, or even the same codebase area, as the vulnerable query — the fix is to treat *every* use of stored data in a query as needing the same parameterization discipline as directly user-supplied input, since "it came from our own database" doesn't mean it was ever safe as a literal.

### Q4. What is SSRF, and why is the cloud metadata endpoint such a common target?

Server-side request forgery is when an attacker gets a server to make an HTTP request to a destination of the attacker's choosing, exploiting the fact that the request originates from inside the server's trusted network position rather than from the attacker's own machine — common in features like "fetch this URL to generate a preview" or "call this webhook". The cloud metadata endpoint (`169.254.169.254` on AWS/Azure/GCP) is a prime target because it's reachable only from within the instance's own network by design, and it can return the instance's temporary credentials or identity tokens without any authentication — so an SSRF bug on a server with, say, an IAM role attached can be escalated into full credential theft for that role, turning a "the server fetched a URL it shouldn't have" bug into a cloud account compromise.

### Q5. Your application allowlists which hostnames it's allowed to fetch on behalf of users, but a security researcher still reports an SSRF vulnerability. How is that possible, and how do you fix it?

The most common bypass is that the allowlisted domain is checked once, but the actual outbound request follows an HTTP redirect afterward — the researcher submits an allowlisted URL that returns a 302 redirect to an internal or metadata address, and if the HTTP client follows redirects transparently, the final request goes somewhere never validated. Another common bypass is DNS rebinding: the allowlisted hostname resolves to a legitimate IP at validation time but is repointed to an internal IP by the time the actual request executes. The fix is to either disable automatic redirect following and re-validate any redirect target explicitly before following it, and/or resolve the hostname once, validate the resulting IP is not in a private/reserved range, and pin the connection to that specific validated IP rather than re-resolving DNS at request time.

### Q6. What is IDOR, and how is it different from a missing authentication check?

Insecure Direct Object Reference is when an endpoint correctly verifies the caller is authenticated (and sometimes even that they hold the right role), but never checks whether the *specific resource* being requested — identified by an ID in the URL or request body — actually belongs to or is authorized for that caller. It's different from a missing authentication check because the attacker doesn't need to bypass login at all; they log in legitimately as themselves and simply change an ID (`/invoices/1001` to `/invoices/1002`) to access someone else's data, with every authentication and role check passing along the way. The fix is a resource-based (ownership) check: after loading the requested resource, explicitly verify a relationship — `resource.OwnerId == currentUser.Id`, or the equivalent tenant check — before returning it, rather than assuming that "authenticated and has the right role" is sufficient.

### Q7. Explain insecure deserialization and why formats like .NET's BinaryFormatter are considered dangerous with untrusted input.

Insecure deserialization happens when a deserializer can reconstruct arbitrary object types and set their fields based purely on what's encoded in the input data, rather than a fixed, expected schema. If an attacker controls the serialized payload, they can specify types the application never intended to instantiate at that point, and if any of those types have side effects in their constructors, property setters, or `IDeserializationCallback`-style hooks, an attacker can chain several such "gadgets" together to achieve unintended behavior — in the worst documented cases, arbitrary remote code execution — without needing any other vulnerability. `BinaryFormatter` is specifically dangerous because it supports fully polymorphic deserialization of arbitrary .NET types by default with no schema restriction, which is why Microsoft deprecated and eventually removed it; the safe alternative is a plain-data format (like JSON) with a fixed, known target type and no type-name handling enabled, so the deserializer can never be told to construct a class the developer didn't explicitly expect.

### Q8. What's the difference between security misconfiguration and a code-level vulnerability like injection, and how would you catch each?

Injection and similar issues are logic bugs — the application code itself does something unsafe with untrusted input, and you catch them through code review, static analysis (SAST), and targeted testing that tries malicious payloads against specific endpoints. Security misconfiguration is a deployment/hardening gap where the code may be entirely correct but the running environment exposes more than it should — default credentials never rotated, verbose error pages leaking stack traces in production, an admin or debug endpoint left reachable, overly permissive CORS. You catch these with automated configuration baselines, hardening checklists enforced in the deployment pipeline, and periodic scans of the live environment (not just the source code) — because the same code deployed with a hardened configuration is safe, and deployed carelessly is not, so code review alone will never find a misconfiguration issue.

### Q9. A teammate says NoSQL databases are immune to injection since they don't use SQL syntax. How would you respond, with an example?

That's a common misconception — NoSQL injection is a different mechanism but the same root cause: untrusted input being interpreted as *query structure* rather than *data*. A typical MongoDB example: if a login handler passes the raw request body directly into a query like `db.users.find({ username: username, password: password })`, and the client sends `password` as a JSON object like `{"$ne": null}` instead of a string, the query becomes "find a user where password is not equal to null" — matching essentially any account, completely bypassing the password check, without a single SQL keyword involved. The fix mirrors SQL injection's fix conceptually even though the mechanism differs: strictly validate and constrain input types (reject anything that isn't the expected primitive type before it reaches the query), and use the driver's schema validation or parameter-binding features rather than trusting that arbitrary JSON from a request body is safe to pass straight into a query filter.

### Q10. You're doing a code review and see a webhook feature where the application fetches a user-supplied URL to validate it's reachable before saving it. What would you check for, and what controls would you require before approving it?

This is a textbook SSRF-prone feature, since the server itself makes an outbound request to a URL the user fully controls. I'd check whether the destination is validated against an allowlist of expected schemes/hosts (or at minimum blocks private/reserved IP ranges and the cloud metadata address), whether the HTTP client used for the fetch follows redirects automatically (and if so, whether it re-validates the destination after each hop), and whether there's any protection against DNS rebinding (resolving the hostname once and pinning to that IP for the actual request, rather than re-resolving at request time). I would not approve the feature without at least: blocking `169.254.169.254` and RFC 1918 private ranges explicitly, disabling automatic redirect following (or re-validating on redirect), and ideally routing the outbound fetch through a network egress path that itself can't reach internal infrastructure, so even a bypassed application-level check has a network-layer backstop.

### Q11. How would you explain "broken access control" as a category, and why does OWASP rank it as the top risk?

Broken access control is the umbrella category for any situation where the server fails to correctly enforce what an authenticated user is actually allowed to do — it includes IDOR (missing ownership checks), privilege escalation (a regular user reaching an admin-only function because the check was missing or client-side only), and forced browsing (accessing an unlinked but unprotected URL directly). OWASP ranks it highest because it's both extremely common — it shows up any time a developer forgets a single check on a single endpoint — and extremely high-impact, since a successful bypass typically grants direct access to other users' data or administrative functionality, with no need to chain it with another vulnerability first. The recurring theme across all its forms: authorization must be enforced server-side, on every request, checking the specific resource and action — never inferred from what the UI shows or hides, and never trusted from a client-supplied role or ID field.

### Q12. Give an example of command injection and explain a defence beyond "don't use string concatenation."

If a service shells out to `ping` using user input for the host — `Process.Start("cmd.exe", "/c ping " + userInput)` — an attacker supplying `8.8.8.8 & del important-file` (or the shell-appropriate equivalent) can chain an arbitrary second command onto the intended one, because the shell interprets `&`/`;`/`|` as command separators regardless of what the developer intended the string to mean. Beyond avoiding string concatenation, the stronger defence is to avoid invoking a shell at all where possible: call the underlying functionality via a library API instead of shelling out (e.g., use a networking library to check host reachability instead of spawning `ping`), or if a subprocess truly is necessary, pass arguments as a proper argument array (so the OS process API doesn't invoke a shell to parse the string) rather than a single concatenated command line, and apply a strict allowlist to any input that must reach that subprocess (e.g., validate it's a well-formed hostname/IP with no special characters) as defense-in-depth even after removing the shell-parsing step.
