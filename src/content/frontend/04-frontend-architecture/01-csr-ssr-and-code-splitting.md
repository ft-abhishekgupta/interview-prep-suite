---
title: CSR, SSR and Rendering Strategies
description: How CSR, SSR, SSG, ISR and streaming SSR trade off TTFB, SEO and freshness, plus hydration cost, React Server Components and code splitting
difficulty: Advanced
tags: [rendering, ssr, ssg, hydration, performance]
---

Where a page's HTML gets generated — client, server at request time, server at build time, or some hybrid — is one of the most consequential architecture decisions a front-end team makes, and interviewers use it to check whether you can reason about trade-offs instead of naming buzzwords.

## CSR vs SSR vs SSG vs ISR vs streaming SSR

| Strategy | When HTML is built | TTFB | FCP | SEO | Server cost | Data freshness | Complexity |
|---|---|---|---|---|---|---|---|
| **CSR** (Client-Side Rendering) | In the browser, after JS downloads and runs | Fast (static shell) | Slow (waits for JS + data fetch) | Poor without extra work | Low (static hosting/CDN) | Always fresh (fetched on load) | Low |
| **SSR** (Server-Side Rendering) | On the server, per request | Slower (server does work first) | Fast (HTML has content) | Good | High (compute per request) | Always fresh | Medium |
| **SSG** (Static Site Generation) | At build time, once | Fastest (pure static file) | Fastest | Good | Lowest (served from CDN) | Stale until next build | Low |
| **ISR** (Incremental Static Regeneration) | At build time, then regenerated on a schedule/on-demand | Fast (serves stale, revalidates in background) | Fast | Good | Low-medium | Eventually fresh (configurable) | Medium |
| **Streaming SSR** | On the server, sent in chunks as they're ready | Fast (first chunk arrives quickly) | Fast (progressive) | Good | Medium-high | Always fresh | High |

> [!KEY]
> There is no universally "best" strategy — the right choice depends on how often the data changes, how much SEO matters, and how much server cost/complexity the team can afford. State the trade-off, not a single winner.

```mermaid
flowchart LR
    subgraph "CSR"
    A1["Request"] --> A2["Blank HTML + JS"] --> A3["JS runs, fetches data"] --> A4["Content appears"]
    end
    subgraph "SSR"
    B1["Request"] --> B2["Server renders HTML"] --> B3["HTML with content sent"] --> B4["JS hydrates"]
    end
    subgraph "SSG"
    C1["Request"] --> C2["Pre-built HTML served from CDN"] --> C3["JS hydrates"]
    end
```

## Hydration and the hydration cost/mismatch problem

**Hydration** is the process of React attaching event listeners and internal state to server-rendered HTML that's already visible, so it becomes interactive — without re-creating the DOM from scratch. Until hydration finishes, the page looks ready but clicks/inputs don't work yet, which is why **TTI (Time to Interactive)** can lag well behind **FCP** on SSR pages with a large JS bundle.

> [!WARNING]
> A **hydration mismatch** happens when the server-rendered HTML doesn't match what the client would render on first pass — e.g., using `Date.now()` or `Math.random()` directly in render, or reading `window`/`localStorage` during initial render. React detects the mismatch, discards the DOM, and re-renders from scratch on the client, throwing away the SSR benefit entirely and logging a console warning.

```typescript
// Mismatch risk: server and client compute different values
function Banner() {
  return <div>{new Date().toLocaleTimeString()}</div>; // server time vs client time differ
}

// Fix: compute client-only values after mount
function Banner() {
  const [time, setTime] = useState<string | null>(null);
  useEffect(() => setTime(new Date().toLocaleTimeString()), []);
  return <div>{time ?? "--:--"}</div>; // stable on server, fills in after hydration
}
```

## React Server Components (React 18 and 19 context)

**React Server Components (RSC)** require framework/bundler support; they became practical in React 18-era frameworks such as the Next.js App Router and are part of the React 19 model. They run *only* on the server and never ship their code to the client bundle at all — they can read from a database or filesystem directly, and their output (a serialized description of UI, not HTML) is streamed to the client to be merged with client components. This is a different axis from SSR: SSR is about *where the initial HTML render happens*; RSC is about *which component code ever reaches the browser in the first place*.

| | Server Component | Client Component (`"use client"`) |
|---|---|---|
| Runs on | Server only | Server (for SSR) then client (hydrates) |
| Can use hooks (`useState`, `useEffect`) | No | Yes |
| Ships JS to the browser | No | Yes |
| Can access DB/filesystem directly | Yes | No |
| Good for | Data-heavy, static-per-request UI (a product detail page) | Interactive UI (a like button, a form) |

> [!TIP]
> The senior framing: RSC shrinks the client bundle by keeping non-interactive, data-fetching components entirely server-side, while interactive leaf components still ship as client components — the two compose in the same tree.

## Route-based and component-based code splitting

Splitting the JS bundle reduces how much code must download and parse before a page is interactive.

- **Route-based**: each page gets its own chunk, loaded on navigation — the biggest win for the least effort, since a user rarely needs every route's code upfront.
- **Component-based**: a specific heavy component (rich text editor, chart library, a rarely-opened modal) is split into its own chunk and lazy-loaded only when rendered.

```typescript
const Editor = lazy(() => import("./RichTextEditor")); // separate chunk, loaded on demand
```

## Bundle analysis and tree shaking

A **bundle analyzer** (e.g., `webpack-bundle-analyzer`, Vite's `rollup-plugin-visualizer`) visualises what's actually inside the shipped JS, surfacing unexpectedly large dependencies before they hit production. **Tree shaking** removes exports that are never imported anywhere, but only works reliably with ES modules (`import`/`export`) and side-effect-free code — a library that mutates globals on import, or a `default export` of one large object, often can't be shaken at all.

> [!DANGER]
> Importing an entire library for one function (`import _ from "lodash"` then using `_.debounce`) defeats tree shaking — the whole library ships. Import the specific function (`import debounce from "lodash/debounce"`) or use a modular alternative.

## Preloading, prefetching, and caching layers

| Hint | Meaning | Use for |
|---|---|---|
| `<link rel="preload">` | Fetch this now, it's needed for the current page | Critical fonts, hero image, the current route's script |
| `<link rel="prefetch">` | Fetch this at low priority, likely needed soon | The next route the user will probably navigate to |
| `<link rel="dns-prefetch">` / `preconnect` | Resolve DNS/handshake early | Third-party domains (analytics, CDN, API host) |

**Caching layers** stack, from closest to the user to furthest: browser cache (per-user, respects `Cache-Control`), service worker (programmable, works offline), CDN (shared across users, edge-located), origin server. Each layer trades freshness for speed — a CDN cache with a long TTL is fast but can serve stale content until invalidated or revalidated.

## Choosing a strategy for a given product

| Product need | Likely fit |
|---|---|
| Marketing site, blog, docs — content rarely changes | SSG (fastest, cheapest) |
| E-commerce product pages — thousands of pages, semi-frequent price/stock changes | ISR (static speed, periodic freshness) |
| Personalised dashboard, per-user data | CSR or SSR depending on SEO need (dashboards usually don't need SEO → CSR is fine) |
| Search-engine-critical content that changes per request (news, listings) | SSR, or streaming SSR if the page has slow and fast parts |
| App with heavy but not fully interactive views + a slow backend for some data | RSC to keep those parts off the client bundle, streamed alongside client components for interactivity |

> [!NOTE]
> A senior answer names the *actual constraint* driving the choice — "this needs to be crawlable and the data changes hourly, so ISR with a 1-hour revalidation window is the sweet spot" — rather than picking a strategy because it's the newest one.

## Cheat sheet

- CSR: cheap to host, poor initial FCP/SEO unless mitigated. SSR: fresh + SEO-good, costs server compute per request. SSG: fastest and cheapest, stale until rebuilt. ISR: static speed with periodic freshness. Streaming SSR: fast first byte, sends content progressively.
- Hydration attaches interactivity to existing SSR/SSG HTML — don't confuse TTI with FCP, they can differ a lot.
- Hydration mismatches (client/server render different output) discard the SSR benefit — avoid `Date.now()`, `Math.random()`, or `window` access during initial render.
- RSC is orthogonal to SSR — it's about which component code ever ships to the client, not when HTML is generated.
- Route-based code splitting first; component-based for specific heavy, rarely-used pieces.
- Tree shaking needs ES modules and side-effect-free imports — import specific functions, not whole libraries.
- Preload what's needed now, prefetch what's needed next, preconnect to third-party origins early.
- Pick a strategy from the actual constraint: how often data changes, whether SEO matters, and acceptable server cost.

## Common mistakes

| Mistake | Fix |
|---|---|
| Using CSR for SEO-critical, rarely-changing marketing pages | Use SSG — cheaper and faster than any client-rendered approach |
| Reading `window`/`localStorage` directly in render on an SSR page | Read it in `useEffect`, guard with a client-only render pass |
| Importing a whole utility library for one function | Import the specific submodule/function to preserve tree shaking |
| Treating SSR as "automatically better" than CSR | SSR adds server cost and TTFB; justify it with an actual SEO or freshness need |
| Confusing "hydrated" with "interactive fast" | A large JS bundle can delay TTI well past FCP even with SSR |
| Prefetching everything indiscriminately | Only prefetch likely next routes; indiscriminate prefetching wastes bandwidth and can compete with critical requests |

## Summary

CSR, SSR, SSG, ISR and streaming SSR are points on a spectrum trading off TTFB, FCP, SEO, server cost, data freshness and complexity — none is universally correct. Hydration is the mechanism that makes server-rendered HTML interactive, and mismatches between server and client output silently throw that benefit away. React Server Components add an orthogonal axis — shrinking what ships to the client at all — while code splitting, tree shaking, and a layered caching strategy (CDN, browser, service worker) round out how a real product actually gets fast and stays fast in production.

## Top Interview Questions

### Q1. Compare CSR and SSR across time to first byte, first contentful paint, and SEO.

CSR serves a mostly empty HTML shell quickly, so TTFB is fast, but the browser must then download, parse and execute JavaScript, fetch data, and render before anything meaningful appears, making FCP slow — and search engine crawlers that don't fully execute JS may see an empty page, hurting SEO unless mitigated with prerendering. SSR does the rendering work on the server per request, so TTFB is slower (the server has to fetch data and render HTML before responding), but the response already contains visible content, giving a fast FCP, and crawlers see fully-formed HTML immediately, which is good for SEO. The trade-off in one sentence: CSR pushes cost to the client and to time (slower FCP); SSR pushes cost to the server and to every request (slower TTFB, higher compute cost), buying faster FCP and better SEO in return.

### Q2. What is ISR and what problem does it solve that plain SSG doesn't?

Incremental Static Regeneration serves pre-built static pages (fast, cheap, like SSG) but allows a page to be regenerated in the background after a configured revalidation window or an on-demand trigger, without requiring a full site rebuild. Plain SSG's weakness is that content is frozen at build time — a price change or a new product requires rebuilding the entire site, which doesn't scale to sites with thousands of pages or frequently-changing data. ISR solves this by letting each page revalidate independently: a request for a stale page can be served the existing static version immediately while a fresh version regenerates in the background (stale-while-revalidate), or regenerate on-demand when the underlying data changes, giving most of SSG's speed and cost profile with periodic or event-driven freshness instead of "frozen until the next full deploy".

### Q3. What is hydration, and what causes a hydration mismatch?

Hydration is the process where a client-side framework like React takes server-rendered (or statically generated) HTML that's already visible in the browser and attaches event listeners and internal component state to it, making it interactive, without discarding and re-building the DOM from scratch. A hydration mismatch occurs when the HTML the client would produce on its first render doesn't match what the server actually sent — common causes are code that reads `Date.now()`, `Math.random()`, `window`, or `localStorage` directly during the initial render, or conditionally rendering based on something only available on one side (like a user-agent sniff). When React detects a mismatch, it discards the mismatched DOM subtree and re-renders it from scratch on the client, which is slower than a clean hydration and also logs a warning — effectively negating the SSR benefit for that portion of the page. The fix is to defer any client-only computation to an effect and render a stable placeholder on the initial pass.

### Q4. Explain React Server Components and how they differ from SSR.

SSR is about *when* HTML is generated — on the server, per request, versus in the browser. React Server Components are about *which component code ever ships to the browser's JavaScript bundle at all* — a Server Component runs exclusively on the server, can directly access a database or filesystem, never includes hooks like `useState`/`useEffect` (since it has no client lifecycle), and its rendered output is streamed to the client as a serialized description to be merged into the tree, without its own source code ever being part of the client bundle. Client Components (marked `"use client"`) are what actually ship JS and hydrate for interactivity. The two are orthogonal and composable: an app can use SSR to render the initial HTML of a page built partly from Server Components (for data-heavy, non-interactive sections) and partly from Client Components (for interactive leaf elements like a button or form), getting both a smaller client bundle and a fast initial paint.

### Q5. Why can time to interactive lag significantly behind first contentful paint on an SSR page?

FCP is determined by when the browser paints the first pixels of real content, which SSR achieves quickly because the HTML already contains that content. TTI, however, requires the JavaScript bundle to have downloaded, parsed, executed, and hydration to have completed so event handlers are actually attached — none of which is instant, especially with a large bundle or a slow device. This creates a window where the page *looks* ready (content is visible) but doesn't yet *respond* to clicks or input, which is a common source of user frustration ("why isn't this button working") and a metric gap that pure FCP numbers hide. The mitigations are reducing bundle size (code splitting, RSC to avoid shipping non-interactive component code), and prioritising hydration of visible/interactive elements first (progressive or selective hydration) rather than hydrating the entire page tree in one pass.

### Q6. When would you choose streaming SSR over standard SSR?

Standard SSR must finish rendering the *entire* page on the server before sending any response, so if one part of the page depends on a slow data source (a report that takes 2 seconds to compute), the whole response is delayed by that slowest part even though other sections were ready instantly. Streaming SSR sends the HTML shell and any already-ready sections immediately, then streams in additional chunks (often paired with `Suspense` boundaries) as slower data resolves, so the user sees and can interact with the fast parts of the page while the slow part fills in progressively. You'd choose it when a page has a clear mix of fast and slow data dependencies and you want to avoid the slowest dependency gating the entire response — the cost is added complexity (managing loading boundaries, ensuring graceful fallbacks) and it requires both server and client support for streaming.

### Q7. A marketing site's SEO ranking dropped after migrating from SSG to a client-rendered SPA. What would you check, and how would you fix it?

I'd first verify whether the search engine crawler actually executes JavaScript for this site's traffic sources — some crawlers do partial or delayed JS rendering, and even when they do, client-rendered content can be indexed later or less reliably than server-delivered HTML, especially if the JS bundle is large or errors during the crawl's execution pass. I'd check server logs/search console for crawl errors or "page couldn't be rendered" reports, and compare the rendered HTML a crawler sees (via a rendering test tool) against what a real browser shows, to confirm content is genuinely missing at crawl time. The fix, given this is a mostly-static marketing site, is almost certainly to move back to SSG (or add SSR/prerendering) so crawlers receive fully-formed HTML immediately rather than depending on JS execution — CSR is rarely the right choice for SEO-critical, infrequently-changing content, and this migration likely traded that requirement away for simplicity without accounting for it.

### Q8. What's the difference between preload and prefetch, and when would misusing them hurt performance?

`preload` tells the browser "fetch this resource now, at high priority, because the current page needs it" — appropriate for critical fonts, the hero image, or a script the current route can't render without. `prefetch` tells the browser "fetch this at low priority when idle, because it will probably be needed soon" — appropriate for the JS chunk of a route the user is likely to navigate to next. Misusing `preload` for something not actually needed immediately competes for bandwidth and priority with resources that genuinely block rendering, delaying FCP/LCP; over-prefetching many unlikely-to-be-visited routes wastes bandwidth (a real cost on mobile/metered connections) and can still contend with more important requests if the browser's prioritisation heuristics don't fully protect against it. The rule of thumb: preload only what's provably needed for the current render, prefetch only what's confidently the next likely navigation.

### Q9. How does tree shaking work, and why does importing an entire library sometimes defeat it?

Tree shaking is a build-time optimisation where the bundler statically analyses `import`/`export` statements (ES module syntax) to determine which exported bindings are actually used anywhere in the app, and removes the rest from the final bundle — it relies on this analysis being possible *statically*, without running the code. If a library is imported as a whole (`import _ from "lodash"`) and only one function is used (`_.debounce`), many bundlers still cannot safely remove the rest of the library, either because the library is written in CommonJS (whose dynamic `require`/`module.exports` pattern defeats static analysis) or because the library's module has side effects on import that the bundler can't prove are unused. The fix is importing the specific submodule/function directly (`import debounce from "lodash/debounce"`), or choosing libraries that ship proper ES modules and mark themselves side-effect-free (`"sideEffects": false` in `package.json`) so bundlers can safely tree-shake them.

### Q10. How would you decide between SSR, SSG and ISR for an e-commerce product catalog with 50,000 products where prices change a few times a day?

Pure SSG is attractive for cost and speed but would require a full rebuild (or per-product rebuild) every time any price changes, which doesn't scale well at 50,000 pages and would mean either very infrequent rebuilds (stale prices shown) or an expensive, slow full rebuild pipeline running constantly. Pure SSR would guarantee fresh prices on every request but means paying server compute for every single page view, including for products nobody is currently buying, which is wasteful at this scale and adds latency to every request. ISR is the natural fit here: pre-render pages statically for fast, cheap serving, set a revalidation window (e.g., every 10–15 minutes, or on-demand triggered by the price-update system itself) so pages regenerate in the background without blocking users, and combine it with on-demand revalidation for high-priority changes (a flash sale price) where waiting for the next scheduled window isn't acceptable — giving SSG-level speed and cost with freshness that matches how often the underlying data actually changes.
