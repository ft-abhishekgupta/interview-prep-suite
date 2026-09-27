---
title: Passwords and Session Security
description: How to store passwords so a database breach doesn't leak them, and how to manage sessions so a stolen cookie doesn't become a takeover
difficulty: Core
tags: [passwords, authentication, sessions, cookies, cryptography]
---

Password storage and session management are two of the most consequential things a backend engineer implements, and both have a small set of well-known right answers. Interviewers use this topic to check whether you've internalised those answers or are still reasoning from first principles under pressure — which, for cryptographic primitives, is exactly how mistakes get shipped.

## Never encrypt, never plain-hash

Encrypting passwords is wrong because encryption is reversible — whoever holds the key can recover every password, and that key lives somewhere reachable from the same breach that exposes the database. Hashing with a fast general-purpose hash (`SHA-256`, `MD5`) is also wrong, because those hashes are designed to be **fast**, which is exactly the wrong property for password storage: an attacker with a stolen hash database can compute billions of `SHA-256` hashes per second on commodity GPUs and simply try every password in a breach list or dictionary until one matches.

> [!KEY]
> The property you actually want is a hash function that is deliberately **slow and memory-hard**, so that trying billions of guesses against a stolen hash is computationally expensive even though verifying one legitimate login is fast enough for a real user to not notice.

**Salts** are a random value stored alongside each hash, mixed into the hashing input, so two users with the same password get different hashes — this defeats precomputed rainbow tables and stops one cracked hash from revealing every user sharing that password. **Peppers** are a secret value shared across *all* users, stored outside the database (in a key vault or config secret, not the same store as the hashes) — even if the database is stolen, the pepper isn't, so offline cracking is blocked unless the attacker also compromises the secret store separately.

## Adaptive hashing algorithms

| Algorithm | Tunable cost | Memory-hard | Notes |
|---|---|---|---|
| PBKDF2 | Iteration count | No | NIST-approved, widely supported, but GPU/ASIC-friendly since it's CPU-only |
| bcrypt | Work factor (log₂ rounds) | Limited (~4 KB) | Battle-tested since 1999, simple to tune, capped memory hurts against modern GPU cracking |
| scrypt | Cost, block size, parallelism | Yes | Designed specifically to be expensive on GPUs/ASICs via large memory use |
| Argon2id | Time, memory, parallelism | Yes (configurable, e.g. 64 MB+) | Winner of the 2015 Password Hashing Competition; current default recommendation |

> [!TIP]
> If asked "which would you pick today", say **Argon2id** with parameters tuned so hashing takes roughly 250–500ms on your production hardware (commonly ~19 MiB–64 MiB memory, 2–4 iterations, adjusted via benchmarking) — and name bcrypt as the safe, extremely well-supported fallback if your platform lacks a solid Argon2 library.

```csharp
// Hashing with BCrypt.Net — work factor controls the cost
string hash = BCrypt.Net.BCrypt.HashPassword(password, workFactor: 12);
bool ok = BCrypt.Net.BCrypt.Verify(candidatePassword, hash);

// Comparing any other secret material (tokens, MACs) must be timing-safe:
bool valid = CryptographicOperations.FixedTimeEquals(
    Encoding.UTF8.GetBytes(expectedToken),
    Encoding.UTF8.GetBytes(suppliedToken)); // constant-time, no early exit on mismatch
```

> [!WARNING]
> A naive `==` or `string.Equals` comparison on secrets short-circuits at the first differing byte, and the tiny timing difference is measurable over enough network requests — a **timing attack** can recover a token byte-by-byte. Always use a constant-time comparison for tokens, MACs and API keys (password hash comparison is already handled safely inside bcrypt/Argon2 libraries).

## Password policy that actually helps

NIST's modern guidance (SP 800-63B) reversed decades of conventional wisdom: forced complexity rules (`must contain a symbol`) push users toward predictable substitutions (`Password1!`) and forced periodic rotation causes small, guessable increments (`Summer2023` → `Summer2024`). What actually reduces breach risk:

| Do | Instead of |
|---|---|
| Enforce a minimum length (12+ characters) | Enforcing complexity character classes |
| Check new passwords against known-breach lists (e.g. Have I Been Pwned's range API) | Forcing periodic rotation with no incident |
| Allow long passphrases and paste/password managers | Blocking paste into password fields |
| Rate-limit and lock out on repeated failures | Unlimited retry with a complex password as the only defence |

## Credential stuffing and account recovery

Credential stuffing replays username/password pairs leaked from *other* breaches against your login, betting on password reuse — it's not password guessing, so complexity rules don't help at all; only rate limiting, CAPTCHA after a threshold, and breach-list checks do. Lockout policy is a trade-off: lock too aggressively and you hand attackers a trivial denial-of-service against legitimate users (lock out a victim by deliberately failing their login); lock too loosely and brute-forcing becomes viable. A common middle ground is exponential backoff per account plus IP/device-based throttling rather than a hard permanent lock.

> [!DANGER]
> Account recovery is very often the actual weakest link, not the password hash. A "forgot password" flow that emails a predictable or long-lived token, or a security-question flow with publicly guessable answers, bypasses every bit of hashing rigor you put into login. Treat recovery tokens with the same care as session tokens: short-lived, single-use, sent only to a verified channel.

## Session management

A session is the mechanism that lets a server recognise the same authenticated user across multiple requests, typically via a random, unguessable session identifier stored in a cookie.

```mermaid
stateDiagram-v2
    [*] --> Anonymous
    Anonymous --> Authenticated: Login (new session ID issued)
    Authenticated --> Authenticated: Privilege change (session ID rotated)
    Authenticated --> Idle: No activity for idle timeout
    Idle --> Authenticated: Activity resumes before absolute timeout
    Authenticated --> [*]: Logout (server invalidates session)
    Idle --> [*]: Absolute timeout reached
```

**Session fixation** is an attack where the attacker sets a known session ID on the victim's browser *before* login (via a URL parameter or a cookie set from a subdomain they control), then waits for the victim to log in — if the server keeps using the same ID after authentication, the attacker's pre-known ID is now a valid authenticated session. The fix is simple and non-negotiable: **always issue a brand-new session ID on login**, and again on any privilege escalation (e.g. becoming admin, re-authenticating for a sensitive action), so a pre-authentication ID is never valid post-authentication.

| Timeout type | What it limits | Typical value |
|---|---|---|
| Idle timeout | Inactivity duration before forced logout | 15–30 min for sensitive apps |
| Absolute timeout | Total session lifetime regardless of activity | 8–24 hours |

## Secure cookie flags

| Flag | Effect |
|---|---|
| `HttpOnly` | JavaScript cannot read the cookie — blocks token theft via XSS |
| `Secure` | Cookie is only sent over HTTPS, never plaintext HTTP |
| `SameSite` | Controls cross-site sending — `Lax`/`Strict` mitigate CSRF |
| `Path` | Scopes the cookie to a URL prefix, limiting exposure to unrelated routes |
| `Domain` | Scopes to a host (and optionally subdomains) — narrower is safer |

```csharp
Response.Cookies.Append("session", sessionId, new CookieOptions {
    HttpOnly = true,
    Secure = true,
    SameSite = SameSiteMode.Lax,
    Expires = DateTimeOffset.UtcNow.AddMinutes(30)
});
```

Logout must invalidate the session **server-side** (removing it from the session store), not just clear the client-side cookie — otherwise a captured session ID (from logs, a proxy, or a shared machine) remains valid indefinitely. "Remember me" tokens extend convenience without weakening the primary session: issue a long-lived, single-use token stored hashed in the database, rotate it on every use, and treat it as re-authentication rather than an extension of the original session's privileges.

## Cheat sheet

- Never encrypt or fast-hash passwords — use an adaptive, memory-hard hash (Argon2id, bcrypt).
- Salts defeat rainbow tables per-user; peppers add a secret kept outside the database.
- Compare tokens/MACs with constant-time equality, never `==`.
- Favor length + breach-list checks over complexity rules and forced rotation.
- Credential stuffing needs rate limiting and breach detection, not stronger passwords.
- Account recovery is often the weakest link — protect it as rigorously as login.
- Rotate the session ID on login and on privilege change to defeat fixation.
- Use both idle and absolute timeouts; `HttpOnly` + `Secure` + `SameSite` on every session cookie.
- Logout must invalidate server-side state, not just clear the cookie.

## Common mistakes

| Mistake | Fix |
|---|---|
| Hashing passwords with SHA-256/MD5 | Use Argon2id, bcrypt or scrypt instead |
| Reusing the pre-login session ID after authentication | Issue a new session ID on login and privilege change |
| Comparing secret tokens with `==` | Use a constant-time comparison function |
| Enforcing complexity rules and 90-day rotation | Enforce length + breach-list checks |
| Only clearing the client cookie on logout | Invalidate the session server-side too |
| Treating security questions as a strong recovery factor | Use short-lived, single-use tokens to a verified channel |

## Summary

Password storage needs an adaptive, memory-hard hash with a per-user salt and, ideally, a separately-stored pepper — never encryption, never a fast general-purpose hash. Policy should favor length and breach-list checks over complexity and forced rotation, and rate limiting plus account-recovery hardening matter more than most teams assume, since recovery flows are frequently the actual weak point. Session security is about rotating identifiers at trust boundaries — login and privilege escalation — enforcing both idle and absolute timeouts, locking cookies down with `HttpOnly`/`Secure`/`SameSite`, and making logout a real server-side invalidation rather than a cosmetic cookie clear.

## Top Interview Questions

### Q1. Why is encrypting passwords the wrong approach, even though it seems more secure than hashing?

Encryption is reversible by design — anyone holding the decryption key can recover every plaintext password, and in a real breach the attacker who reaches the database has usually also compromised the application server or secrets store where that key lives, defeating the protection entirely. Hashing, by contrast, is one-way: there is no key to steal that reverses a hash back to the password, so a breach only exposes hashes, which still require expensive offline cracking to turn into plaintext. The only legitimate reason to reach for reversible encryption on a credential is when you genuinely need the plaintext back later (an API key you must present to a third party), which is a fundamentally different problem from verifying a user-supplied password.

### Q2. What's the difference between a fast hash like SHA-256 and an adaptive hash like Argon2 or bcrypt, and why does that difference matter for passwords?

SHA-256 is designed to be as fast as possible, which is exactly right for verifying file integrity but exactly wrong for passwords: an attacker with a stolen hash database can compute billions of SHA-256 hashes per second on consumer GPUs, making a full dictionary or breach-list attack against every hash feasible within hours. Adaptive hashes like Argon2 and bcrypt deliberately slow this down with a tunable cost factor — Argon2 additionally requires large amounts of memory per hash attempt, which is expensive to parallelize on GPUs and ASICs the way a pure CPU-bound algorithm isn't. The tuning trade-off is real: too slow and legitimate login latency suffers or infrastructure cost rises; too fast and offline cracking becomes cheap again, so the parameters need periodic re-benchmarking against current hardware.

### Q3. Explain the difference between a salt and a pepper.

A salt is a random value generated per-user (or per-password), stored alongside the hash in the same database row, and mixed into the hash computation — its purpose is to ensure two users with the same password get completely different hashes, defeating precomputed rainbow-table attacks and stopping one cracked hash from revealing every account sharing that password. A pepper is a single secret value shared across the entire application, deliberately stored *outside* the password database — in a key vault, environment secret, or HSM — so that a database breach alone doesn't expose it. The salt protects against cross-user precomputation; the pepper adds a second factor an attacker needs to steal from a completely different system before offline cracking becomes possible at all, even if the salted hash database leaks.

### Q4. Why should password comparisons and token comparisons be timing-safe, and what does that actually mean?

A naive equality check on byte arrays or strings typically short-circuits and returns `false` as soon as it finds the first mismatching byte, meaning a comparison against a mostly-correct guess takes marginally longer than one against a completely wrong guess. Given enough repeated network requests and statistical averaging to cancel out network jitter, an attacker can exploit that tiny timing difference to recover a secret token byte by byte, without ever seeing the value directly — this is a real, practically demonstrated class of attack. A timing-safe (constant-time) comparison, like `CryptographicOperations.FixedTimeEquals` in .NET, always compares every byte regardless of where a mismatch occurs, so the execution time carries no information about how many bytes matched. Note this is specifically for comparing raw secrets like API keys, MACs, and CSRF tokens — verifying a password hash is already safe because the adaptive hash algorithm's own verify function handles this internally.

### Q5. Why did NIST reverse its guidance on password complexity rules and forced rotation?

Studies of real-world password behavior showed that forcing complexity (a mandatory symbol, a mandatory digit) doesn't meaningfully increase entropy against modern cracking — users respond with predictable patterns like capitalizing the first letter and appending "1!" — while making passwords harder to remember, which pushes people toward reuse or writing them down. Forced periodic rotation was worse: without any indication of compromise, users tend to make small, guessable increments to their existing password (`Summer2023!` becomes `Summer2024!`), which an attacker with the previous password can often predict. NIST SP 800-63B now recommends a generous minimum length (12+ characters, allowing long passphrases), checking new passwords against known-breach corpora, and only forcing a reset when there's actual evidence of compromise — treating length and breach awareness as the levers that matter, not complexity or a rotation calendar.

### Q6. What is credential stuffing and why doesn't a strong password policy stop it?

Credential stuffing takes username/password pairs leaked from a breach at a completely different, unrelated service and replays them against your login endpoint at scale, betting purely on the fact that a meaningful fraction of users reuse passwords across sites. It's not a guessing or brute-force attack against your password policy at all — the attacker already has a valid, correctly-formatted, sufficiently complex password, just one the user happens to reuse — so complexity requirements, minimum length, and even strong hashing on your side are all irrelevant to stopping it. Effective defenses are entirely different: rate limiting and progressive delays per account/IP, CAPTCHA after repeated failures, device/behavioral fingerprinting, mandatory multi-factor authentication, and proactively checking user passwords against known-breach lists so reused credentials get flagged before an attacker even tries them.

### Q7. Walk through session fixation as a concrete attack, and explain the fix.

An attacker first obtains a valid, unauthenticated session ID from the target application — sometimes the application even accepts a session ID supplied via a URL parameter or a cookie the attacker can set from a related subdomain. The attacker plants that known session ID onto the victim's browser (via a crafted link, or a cookie-setting request) and waits for the victim to log in normally. If the server's login flow simply upgrades the *existing* session to an authenticated state rather than issuing a new identifier, the attacker's pre-known session ID is now a valid, authenticated session for the victim's account, which the attacker can use directly since they already know its value. The fix is mandatory and simple: the server must always generate and issue a brand-new session identifier at the moment of authentication (and again on privilege escalation), invalidating whatever ID existed before login, so a pre-authentication ID an attacker planted is never valid afterward.

### Q8. What's the difference between idle timeout and absolute timeout, and why do you need both?

Idle timeout ends a session after a period of *inactivity* — if a user walks away from an unlocked laptop, the session expires after, say, 15–30 minutes of no requests, limiting the window an opportunistic attacker with physical access has. Absolute timeout ends a session after a fixed duration from login *regardless of activity*, capping how long any single session — and therefore any single stolen session token — remains valid even if the legitimate user keeps the tab active and refreshing all day. Idle timeout alone doesn't help against a stolen, actively-replayed token (the attacker's own requests count as activity and keep resetting the clock), and absolute timeout alone doesn't help against someone stepping away from their desk for ten minutes; using both together bounds the risk from each scenario independently, and sensitive operations (banking, admin panels) typically set both far shorter than a general content site would.

### Q9. Your production login endpoint is being hit by a credential-stuffing campaign at 50,000 requests per minute from thousands of distinct IPs. Standard per-IP rate limiting isn't slowing it down. What do you do?

Per-IP rate limiting fails here because the attacker is distributing requests across a large botnet or proxy pool, so each individual IP stays well under any reasonable threshold — the signal you actually need is per-account and behavioral, not per-source-IP. Shift the primary rate limit to be keyed on the target username/account, since a real user rarely attempts more than a handful of logins per minute regardless of how many attacker IPs are involved. Layer in a breach-list check so previously-leaked credentials are flagged and challenged with MFA or blocked outright even on a syntactically valid attempt, add progressive friction (CAPTCHA, proof-of-work, or a short delay) that only escalates after repeated account-specific failures, and push traffic through a bot-detection/WAF layer that fingerprints request patterns (missing headers, unusual timing, known bad user agents) rather than relying on IP reputation alone. Communicate to stakeholders that the real fix is reducing password reuse exposure — nudging users towards MFA — since no amount of rate limiting stops an attacker who has the correct password.

### Q10. What secure cookie flags should a session cookie always have, and what does each protect against?

`HttpOnly` prevents any client-side JavaScript from reading the cookie's value, which is the primary defense against session theft via an XSS vulnerability — even if an attacker injects a script, `document.cookie` simply won't return the session token. `Secure` ensures the browser only ever transmits the cookie over an HTTPS connection, preventing it from being sniffed in plaintext if a user somehow ends up on an HTTP page or on an insecure network. `SameSite` (typically `Lax`) restricts when the cookie is attached to cross-site requests, mitigating CSRF by withholding the cookie from cross-site POSTs and non-navigation requests. `Path` and `Domain` scope the cookie as narrowly as reasonably possible, so a vulnerability in an unrelated subdomain or route doesn't automatically have access to the session cookie. All four should be set together; each covers a distinct threat and none substitutes for another.

### Q11. Why must logout invalidate the session server-side, and what's the risk if it only clears the cookie?

If logout only tells the browser to delete its local cookie, the session identifier itself may still be marked valid in the server's session store — so if that exact value was ever captured elsewhere (leaked in server access logs, cached by an intermediate proxy, visible over someone's shoulder on a shared/public machine, or exfiltrated via an earlier XSS before the fix was deployed), it remains usable by an attacker indefinitely, completely independent of whether the legitimate user "logged out". Proper logout must actively remove or mark the corresponding session record as invalid in the server-side store (or, for JWT-based sessions, add the token to a revocation list or rely on a very short expiry plus refresh-token revocation), so that presenting that same identifier again is rejected regardless of what the client's browser currently has cached.

### Q12. How should "remember me" functionality be implemented securely?

A naive implementation just extends the primary session's lifetime, which means a stolen long-lived cookie grants indefinite full access with no further check. The safer pattern issues a separate, long-lived "remember me" token, generated randomly, stored server-side as a hash (not plaintext, so a database leak doesn't hand out usable tokens directly), and single-use: each time it's presented, the server verifies it, immediately issues and stores a new replacement token, and invalidates the old one, so a stolen-and-reused old token is detectable (if the legitimate user's next request presents a token the server already rotated away, that's a strong signal of compromise, and the whole chain can be revoked). The remember-me token should only re-establish a fresh, normal-privilege authenticated session — not bypass MFA or grant elevated privileges — treating it as a convenience for re-authentication rather than a permanent bypass of the login flow.
