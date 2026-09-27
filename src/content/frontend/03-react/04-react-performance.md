---
title: React Performance
description: A diagnose-first approach to React performance covering memoisation, referential equality, context re-renders, virtualisation and code splitting
difficulty: Advanced
tags: [react, performance, memoisation, optimization]
---

Most React performance problems are self-inflicted by premature optimisation or a misunderstanding of referential equality — not by React being slow. The senior move is to measure before touching a single `useMemo`, and to know the handful of patterns that actually cause wasted work.

## Diagnose first: the profiler, not guessing

React DevTools' **Profiler** tab records a render and shows which components rendered, how long each took, and — critically — *why* each one rendered (props changed, state changed, parent re-rendered, hooks changed). Guessing which component is "slow" and wrapping it in `React.memo` blind is a common wasted effort; the profiler tells you definitively.

```mermaid
flowchart TD
    A["Suspect: UI feels janky"] --> B["Record with React DevTools Profiler"]
    B --> C{"Which commits are<br/>long or frequent?"}
    C -->|Frequent commits, cheap each| D["Wasted re-renders → memoisation / structural fix"]
    C -->|Few commits, one is long| E["Expensive render work → useMemo / move off main thread"]
    D --> F["Verify with profiler again"]
    E --> F
```

> [!KEY]
> "It feels slow" is not a diagnosis. Record it, identify whether the problem is *too many renders* or *one render doing too much work*, and fix that specific thing. Chrome's Performance tab complements this for actual paint/layout cost.

## Referential equality: the root cause of most wasted renders

`React.memo`, `useMemo`, `useCallback`, and dependency arrays all compare values with `Object.is` (or a shallow prop comparison for `memo`) — reference equality for objects/arrays/functions. A new literal created every render is "different" even if its contents are identical, defeating any memoisation downstream.

```typescript
// Every render creates a NEW object and a NEW function — memo on Child is pointless
function Parent() {
  const [count, setCount] = useState(0);
  return <Child style={{ color: "red" }} onClick={() => setCount(c => c + 1)} />;
}

// Fix: stabilise references so Child's memo comparison can actually succeed
function Parent() {
  const [count, setCount] = useState(0);
  const style = useMemo(() => ({ color: "red" }), []);
  const handleClick = useCallback(() => setCount(c => c + 1), []);
  return <Child style={style} onClick={handleClick} />;
}
```

> [!WARNING]
> `React.memo` alone does nothing if the props you pass are new references every render. Memoising the child without stabilising what the parent passes down is the single most common wasted-effort pattern in interviews and in real codebases.

## memo, useMemo, useCallback — used correctly

| Tool | Wraps | Prevents |
|---|---|---|
| `React.memo(Component)` | A component | Re-render when props are shallowly equal to last time |
| `useMemo(fn, deps)` | A computed **value** | Recomputation when dependencies haven't changed |
| `useCallback(fn, deps)` | A **function reference** | Recreation of the function when dependencies haven't changed |

The cost of memoisation is real: extra memory to hold the cached value/deps, and a comparison on every render. For cheap computations or components with no memoised children, this cost can exceed the savings — **memoisation is a trade, not a free win**.

## The context re-render problem, and three fixes

Every consumer of a `Context.Provider` re-renders whenever the provided value changes by reference — even if the consumer only reads one field that didn't change. This is the classic "the whole app re-renders on every keystroke" bug when unrelated fast-changing state shares a context with slow-changing global state.

| Fix | How it works |
|---|---|
| **Split contexts** | Put frequently-changing state (e.g., a search query) in its own context, separate from rarely-changing state (theme, auth) — consumers of the stable context are unaffected |
| **Memoise the provided value** | Wrap the `value` prop in `useMemo` so it's only a new reference when its actual contents change, not on every parent render |
| **Selector libraries** | Libraries like `use-context-selector` or state managers with built-in selectors (Zustand, Redux) let a component subscribe to a *slice* of state and only re-render when that slice changes, sidestepping context's all-or-nothing model entirely |

```typescript
// Without memoisation, a new object every render defeats every consumer's shallow check
<AuthContext.Provider value={{ user, login, logout }}>

// Memoised — consumers only re-render when user/login/logout actually change
const value = useMemo(() => ({ user, login, logout }), [user, login, logout]);
<AuthContext.Provider value={value}>
```

## List virtualisation

Rendering thousands of DOM nodes for a long list is expensive regardless of React — the browser has to build layout and paint for all of them. **Virtualisation** (windowing) renders only the rows currently visible in the viewport (plus a small buffer), swapping content as the user scrolls, keeping the DOM node count roughly constant regardless of list length.

```typescript
import { FixedSizeList } from "react-window";

<FixedSizeList height={600} itemCount={items.length} itemSize={48} width="100%">
  {({ index, style }) => <div style={style}>{items[index].label}</div>}
</FixedSizeList>
```

> [!TIP]
> Virtualisation is the correct fix for "rendering 10,000 rows is slow" — memoisation only helps if rows are re-rendering unnecessarily; it does nothing about the sheer cost of having 10,000 DOM nodes mounted at once.

## Code splitting and lazy loading

Shipping the entire app as one JS bundle delays first paint on everything the user doesn't need yet. `React.lazy` + `Suspense` split a route or heavy component into a separate chunk, fetched only when needed.

```typescript
const SettingsPage = lazy(() => import("./SettingsPage"));

<Suspense fallback={<Spinner />}>
  <SettingsPage />
</Suspense>
```

Route-based splitting (one chunk per page) gives the biggest win for the least effort; component-based splitting (a heavy modal, a chart library) is worth it for expensive dependencies used rarely.

## Other levers: images, expensive render work, debouncing

| Problem | Fix |
|---|---|
| Large unoptimised images blocking paint | Serve responsive sizes (`srcset`), modern formats (WebP/AVIF), lazy-load off-screen images (`loading="lazy"`) |
| Expensive computation directly in render body | `useMemo` it, or move it off the main thread (Web Worker) if it's heavy enough to block input |
| Every keystroke triggering an expensive search/filter/API call | Debounce or throttle the state update that drives the expensive work, or use `useDeferredValue`/`useTransition` |
| Large third-party dependency imported eagerly | Dynamic `import()`, tree-shake unused exports, check bundle impact before adding |

```typescript
// Debounce: only fire the expensive filter 300ms after typing stops
const debouncedQuery = useDebouncedValue(query, 300);
const results = useMemo(() => expensiveFilter(items, debouncedQuery), [items, debouncedQuery]);
```

## Measuring with Core Web Vitals

Perceived performance is ultimately judged by field metrics, not developer intuition:

| Metric | Measures | Good threshold |
|---|---|---|
| **LCP** (Largest Contentful Paint) | Time until the main content is visible | ≤ 2.5s |
| **INP** (Interaction to Next Paint) | Responsiveness to user interaction | ≤ 200ms |
| **CLS** (Cumulative Layout Shift) | Visual stability (unexpected layout jumps) | ≤ 0.1 |

> [!NOTE]
> React-specific optimisation (memoisation, virtualisation) mostly improves INP and interaction smoothness. LCP and CLS are usually more about asset loading strategy, server response time, and reserving space for images — a broader front-end performance concern, not a React-only one.

## Symptom to fix

| Symptom | Likely cause | Fix |
|---|---|---|
| Typing in one field re-renders unrelated components | Shared context or lifted state re-rendering all children | Split context, memoise value, or `React.memo` children |
| Long list scroll is janky | Too many mounted DOM nodes | Virtualise with `react-window`/`react-virtualized` |
| Initial load is slow, TTI is high | Everything bundled into one chunk | Route/component-based code splitting with `lazy`+`Suspense` |
| A specific interaction (e.g., filter, sort) freezes the UI | Expensive synchronous computation on the main thread | `useMemo`, debounce, `useTransition`, or a Web Worker |
| `React.memo` child still re-renders every time | New object/array/function prop each render | Memoise the prop with `useMemo`/`useCallback` |
| Layout jumps as images load | No reserved space for async content | Set explicit width/height or aspect-ratio, use CLS-safe placeholders |

## Cheat sheet

- Profile first — the DevTools Profiler shows *why* a component rendered, not just that it did.
- Memoisation only helps when paired with stable references passed down; `memo` alone is not enough.
- `useMemo`/`useCallback` have a real cost — skip them for cheap computations or unmemoised children.
- Context re-renders every consumer on any value change — split contexts, memoise the value, or use a selector-based store.
- Virtualise long lists; memoisation doesn't reduce DOM node count.
- Code-split by route first, then by heavy, rarely-used components.
- Debounce or defer expensive derived work driven by fast input (typing, scrolling).
- LCP/CLS are mostly asset/loading concerns; INP is where React-level optimisation pays off most.

## Common mistakes

| Mistake | Fix |
|---|---|
| Wrapping everything in `useMemo`/`useCallback` "defensively" | Only where a measured cost exists or a memoised consumer benefits |
| Memoising a child without stabilising the props the parent passes | Memoise the prop values too, or the `memo` check always fails |
| Treating context re-renders as a React bug | It's by design — split contexts or use a selector-based store |
| Assuming virtualisation is only for "huge" lists | Even a few hundred complex rows can benefit; measure |
| Adding `React.memo` to a component that always receives new props anyway | No benefit — fix the parent's referential stability instead, or don't bother |
| Optimising based on intuition instead of the profiler | Record first; fix the specific bottleneck it shows |

## Summary

React performance work starts with measurement, not memoisation reflexes. Most wasted renders trace back to referential equality — new objects, arrays, or functions defeating `memo`/`useMemo`/`useCallback`/context comparisons — and the fix is to stabilise references at the source, not to sprinkle memoisation everywhere. Beyond render-level tuning, virtualisation, code splitting, and debouncing expensive derived work address the bigger structural costs, and Core Web Vitals keep the whole effort anchored to what users actually perceive.

## Top Interview Questions

### Q1. Why would you use the React DevTools Profiler before adding any memoisation?

Because "this component feels slow" is a hypothesis, not a diagnosis, and blind memoisation both adds code complexity and can make things worse (extra comparisons, retained memory) if applied to the wrong component. The Profiler records an actual render and shows exactly which components rendered in that commit, how long each took, and — via the "why did this render" information — whether it was because of changed props, changed state, changed hooks, or simply because its parent rendered. That tells you whether the real problem is *too many renders* (a memoisation/structural fix) or *one render doing too much work* (an algorithmic or `useMemo` fix), which are different problems with different solutions. Optimising without this data risks fixing a component that wasn't actually the bottleneck.

### Q2. Why doesn't wrapping a component in React.memo always prevent unnecessary re-renders?

`React.memo` does a shallow comparison of the new props against the previous props and skips re-rendering only if every prop is reference-equal (or primitive-equal). If the parent passes an inline object, array, or function literal — `style={{ color: "red" }}`, `onClick={() => ...}` — a brand-new reference is created on every parent render regardless of whether the "content" is the same, so the shallow comparison always reports a difference and `memo` re-renders anyway. The fix has to happen at the source: the parent must stabilise those props with `useMemo`/`useCallback` (or hoist static values outside the component) so that unchanged content actually produces an unchanged reference. `memo` is necessary but not sufficient — it only pays off when combined with referential stability upstream.

### Q3. Explain the context re-render problem and name at least two ways to fix it.

Every component that consumes a context via `useContext` re-renders whenever the `Provider`'s `value` prop changes by reference, regardless of which specific field inside that value the consumer actually reads — the comparison is all-or-nothing, unlike prop diffing. A common real-world trigger is putting fast-changing state (like a live search query) in the same context/provider as slow-changing state (like the current theme or authenticated user), so every keystroke re-renders every consumer of that context, including ones that only care about the theme. Fixes: split the context so frequently-changing and rarely-changing state have separate providers; wrap the provided value in `useMemo` so it's a stable reference unless its actual contents change; or bypass context's all-or-nothing model with a selector-based state library (Zustand, Redux with `useSelector`, or `use-context-selector`) that lets components subscribe to just the slice of state they need.

### Q4. When does useMemo or useCallback make performance worse rather than better?

Both hooks store the previous dependency array and the cached value/function, and on every render they still run a comparison across dependencies to decide whether to recompute — that comparison and the retained memory are not free. If the wrapped computation is cheap (basic arithmetic, a short string operation) or the memoised function/value isn't consumed by anything that benefits from referential stability (no `React.memo` child, not used in another hook's dependency array), the overhead of the memoisation machinery can exceed whatever it saves, and the code becomes harder to read for no measurable gain. The correct approach is to reserve `useMemo`/`useCallback` for computations with a real, ideally measured, cost, or for values/functions that are genuinely consumed downstream in a way where identity matters.

### Q5. A list of 5,000 rows is slow to scroll even though nothing about the data changes during scrolling. What's the fix, and why doesn't memoisation help here?

The problem isn't wasted re-renders — it's that 5,000 DOM nodes are mounted simultaneously, so the browser has to maintain layout, styles, and paint information for all of them, which is expensive regardless of whether React itself re-renders any of those components. Memoisation (`React.memo`, `useMemo`) only prevents *unnecessary re-computation of React's virtual tree* — it does nothing about the sheer cost the browser incurs from having that many real DOM nodes alive at once. The correct fix is **virtualisation** (windowing): render only the rows currently visible in the viewport plus a small buffer, using a library like `react-window`, so the mounted DOM node count stays roughly constant (e.g., ~20 nodes) no matter how large the underlying list is, and swap content in as the user scrolls.

### Q6. How would you decide between route-based and component-based code splitting?

Route-based splitting — giving each page/route its own JS chunk loaded via `React.lazy` — is almost always the first and highest-value step, since users typically only need the code for the page they're currently on, and it requires minimal restructuring (usually just wrapping route definitions). Component-based splitting is worth adding on top for specific heavy, rarely-used pieces within an already-loaded page — a rich text editor, a charting library, a modal that's opened infrequently — where the dependency's size would otherwise inflate every visitor's initial bundle even though most won't use that feature on a given visit. The decision criterion: check actual bundle composition (via a bundle analyzer) to find the biggest contributors, and split around whichever chunks are large *and* not needed immediately for the first meaningful paint.

### Q7. Users report that typing in a search box that filters a large list feels laggy. Walk through your diagnosis and fix.

I'd first profile to confirm whether the filter itself is expensive (one long render) or whether unrelated components are also re-rendering on each keystroke (many wasted renders) — these need different fixes. If the filtering computation itself is the bottleneck, I'd wrap it in `useMemo` keyed on the query and data so it only recomputes when either actually changes, and consider debouncing the state that drives the filter so it only runs once typing pauses rather than on every keystroke. If the input needs to feel instantly responsive while the filtered list can lag slightly, `useDeferredValue` on the query (or `useTransition` around the setter that updates the filtered results) lets React prioritise keeping the input responsive over rendering the potentially large filtered output. I'd verify the fix by re-profiling and confirming the input's own re-render is now fast and isolated from the expensive list re-render.

### Q8. What's the difference between optimising for LCP/CLS versus optimising component re-renders — do they require the same fixes?

No — they largely address different layers of performance. LCP (Largest Contentful Paint) and CLS (Cumulative Layout Shift) are mostly about asset loading strategy, server response time, image/font optimisation, and reserving layout space before content arrives — they're affected by things like bundle size, CDN caching, and image formats, largely independent of how many times a React component function runs. INP (Interaction to Next Paint), by contrast, measures how responsive the app feels to actual interactions, and this is exactly where React-level work — reducing wasted re-renders, memoising expensive computations, debouncing, virtualising, using concurrent features — pays off. A senior answer distinguishes these explicitly: fixing memoisation issues won't move LCP much, and optimising image loading won't fix janky typing.

### Q9. Why can adding React.memo to a component sometimes have no effect at all, and when is that expected?

If the component's props are, by nature, different on every parent render — for example, a prop is derived from state that genuinely changes every time the parent re-renders, or the parent always passes a freshly computed value with no way to memoise it usefully — then `memo`'s shallow comparison will always find a difference and the component will re-render regardless of the wrapper. This is expected, not a bug: `memo` is a bet that props are *often* unchanged; if that's never true for a given component, `memo` just adds a small, wasted comparison cost every render. The correct response isn't to add `memo` reflexively to every component, but to first check via the profiler whether that specific component actually receives unchanged props across renders where a skip would be valuable — if not, look upstream at whether the parent's own render frequency or the shape of the data passed down is the actual problem.

### Q10. What would you check in production if Core Web Vitals (say, INP) degrade after a release, but nothing "obviously" changed in the code?

I'd start by checking whether a recent dependency update pulled in a heavier library, whether a previously debounced or memoised computation got refactored and lost that optimisation, or whether new state was added to a context that's consumed broadly across the tree (a subtle way to introduce widespread re-renders without touching render logic directly). Field data (real-user monitoring) segmented by device/route helps localise which interaction or page regressed rather than treating it as an app-wide problem. I'd reproduce locally with the DevTools Profiler and Performance tab to see whether it's a rendering issue (many components re-rendering unnecessarily) or a main-thread blocking issue (one expensive synchronous computation), since those point to different fixes — memoisation/context restructuring for the former, moving work off the main thread or `useTransition` for the latter — and I'd add a regression test or a bundle-size/perf budget check in CI to catch the next occurrence earlier.
