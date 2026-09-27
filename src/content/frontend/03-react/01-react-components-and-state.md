---
title: React Components and State
description: Props versus state, why immutable updates trigger re-renders, controlled versus uncontrolled inputs, and why index keys in lists cause real bugs
difficulty: Core
tags: [react, state-management, components, jsx]
---

React's mental model rewards precision about a small number of ideas: what a component actually is, why state must be updated immutably, and why keys exist at all. Interviewers use component and state questions to see whether you understand the model or have just memorised patterns that happen to work.

## Function components and JSX

A function component is a plain JavaScript function that returns a description of UI — JSX compiles to `React.createElement(type, props, children)` calls, which produce plain objects, not real DOM nodes.

```javascript
function Greeting({ name }) {
  return <p>Hello, {name}</p>;
}
// compiles roughly to:
function Greeting({ name }) {
  return React.createElement("p", null, "Hello, ", name);
}
```

React calls this function on every re-render, diffs the returned tree against the previous one (reconciliation), and applies the minimal set of real DOM mutations needed.

> [!KEY]
> A component re-rendering does not mean the DOM changes — it means React re-runs the function and **compares** the result. Only actual differences touch the real DOM.

## Props vs state

| | Props | State |
|---|---|---|
| Owner | Passed in by the parent | Owned by the component itself |
| Mutability | Read-only from the child's perspective | Mutable, via a setter (`setState`/`useState`) |
| Who can change it | Only the parent, by re-rendering with new props | The component itself |
| Triggers re-render on change? | Yes, of the child | Yes, of the component that owns it (and its subtree) |
| Typical use | Configuration, data flowing down | Anything that changes over time and affects rendering |

```javascript
function Counter({ step }) {           // step is a prop — Counter cannot change it
  const [count, setCount] = useState(0); // count is state — Counter owns and changes it
  return <button onClick={() => setCount(c => c + step)}>{count}</button>;
}
```

## Immutability and why mutating state doesn't re-render

React decides whether to re-render by comparing the **reference** of the new state to the old one (`Object.is`), not by deep-inspecting its contents. Mutating an object or array in place keeps the same reference, so React sees "no change" and skips the re-render entirely.

```javascript
// Wrong: mutates the existing array, reference is unchanged — no re-render
function addWrong(item) {
  items.push(item);
  setItems(items); // same reference as before — React bails out
}

// Correct: creates a new array — new reference — triggers a re-render
function addRight(item) {
  setItems((prev) => [...prev, item]);
}
```

> [!DANGER]
> This is one of the most common real React bugs: state that "should have updated" silently doesn't, because the underlying object was mutated instead of replaced. There's no error — the component just stops re-rendering for that update, which makes it confusing to debug.

## Controlled vs uncontrolled inputs

| | Controlled | Uncontrolled |
|---|---|---|
| Source of truth | React state (`value` + `onChange`) | The DOM itself |
| Reading the current value | From state, always up to date | Via a `ref`, read on demand |
| Validation/formatting as you type | Easy — intercept in `onChange` | Harder — requires imperative DOM access |
| Re-renders on every keystroke | Yes | No |
| Typical use | Forms needing live validation, conditional UI | Simple forms, file inputs, performance-sensitive large forms |

```javascript
// Controlled
function ControlledInput() {
  const [value, setValue] = useState("");
  return <input value={value} onChange={(e) => setValue(e.target.value)} />;
}

// Uncontrolled
function UncontrolledInput() {
  const ref = useRef(null);
  const handleSubmit = () => console.log(ref.current.value); // read on demand
  return <input ref={ref} defaultValue="" />;
}
```

> [!TIP]
> "Controlled by default, uncontrolled for large forms where per-keystroke re-renders become a measurable performance cost" is a defensible, common answer for when to reach for each.

## Lifting state up

When two sibling components need to share state, the state moves to their nearest common ancestor, which then passes it (and a setter) down as props.

```mermaid
flowchart TD
    P["Parent, owns filter state"] --> A["SearchBox<br/>receives filter, onFilterChange"]
    P --> B["ResultsList<br/>receives filter"]
```

```javascript
function Parent() {
  const [filter, setFilter] = useState("");
  return (
    <>
      <SearchBox filter={filter} onFilterChange={setFilter} />
      <ResultsList filter={filter} />
    </>
  );
}
```

## Composition vs prop drilling

Passing a prop through several layers of components that don't use it themselves — just to reach a deeply nested consumer — is **prop drilling**. Composition (passing components as `children` or render props) or Context can avoid it.

```javascript
// Prop drilling: Layout and Sidebar don't use `user`, just forward it
<Layout user={user}><Sidebar user={user}><Profile user={user} /></Sidebar></Layout>

// Composition: Layout doesn't need to know about `user` at all
<Layout><Sidebar><Profile user={user} /></Sidebar></Layout>
```

| Approach | Best for | Downside |
|---|---|---|
| Prop drilling | Shallow trees, 1–2 levels | Becomes unreadable and brittle beyond that |
| Composition (`children`) | Passing a specific pre-built element down without every layer needing the data | Requires restructuring how components are assembled |
| Context | Global-ish data (theme, auth, locale) needed widely | Overuse causes unnecessary re-renders of every consumer |

## Keys in lists, and why index keys cause bugs

React uses `key` to match list items across renders — it decides whether an item **moved**, was **added**, or was **removed**, rather than assuming position alone tells the story.

```javascript
// Buggy with index keys if the list can reorder or items can be removed from the middle
{items.map((item, i) => <Row key={i} data={item} />)}

// Correct: a stable identity that doesn't change when order does
{items.map((item) => <Row key={item.id} data={item} />)}
```

**Worked example:** a list `[A, B, C]` with index keys `0, 1, 2`. Removing `A` gives `[B, C]`, but React still sees keys `0, 1` — it thinks item at key `0` (previously `A`) is now `B`, so it **updates that component's props in place** rather than unmounting `A`'s component and mounting a new one for `B`. Any internal state that component held (an open `<details>`, a text input's uncommitted value, a CSS transition) sticks to the wrong data, because React never realised the identity changed.

> [!WARNING]
> Index keys are only safe when the list is static — never reordered, filtered, or has items inserted/removed anywhere but the end. The moment any of that becomes possible, switch to a stable ID.

## Conditional rendering

```javascript
function Status({ state }) {
  if (state.status === "loading") return <Spinner />;
  return state.status === "error" ? <ErrorBanner message={state.message} /> : <Content data={state.data} />;
}
```

Prefer early returns for genuinely distinct states (loading/error/success) over deeply nested ternaries or `&&` chains, which get hard to read past two levels and can silently render `0` or `NaN` when the left-hand side of `&&` is falsy-but-not-boolean.

`count && <Badge count={count} />` renders the literal `0` when `count` is `0`, not nothing — a well-known gotcha. Use `count > 0 && <Badge .../>` or a ternary instead.

## Component design and when to split

| Signal it's time to split a component | What to extract |
|---|---|
| A component has multiple unrelated pieces of state | One component per concern |
| A JSX block is reused, or nearly reused, in two places | A shared presentational component |
| A component re-renders often because of state it doesn't actually display | Move that state down into a child that does use it |
| Props list is growing past 6–8 items | Group related props into an object, or split the component |

## Colocating state and the derived-state anti-pattern

State should live as close as possible to where it's used — lifting it further up "just in case" causes unrelated components to re-render unnecessarily. A related anti-pattern is storing a value in state when it can be **computed** from existing props/state instead.

```javascript
// Anti-pattern: fullName can drift out of sync with firstName/lastName
const [fullName, setFullName] = useState(`${firstName} ${lastName}`);

// Correct: derive it during render — always in sync, no extra state to manage
const fullName = `${firstName} ${lastName}`;
```

Derived state stored separately requires manually keeping it synchronized (usually via a `useEffect`, which adds a render cycle and a class of bugs where the two get out of step); computing it directly during render is simpler, always correct, and costs nothing extra unless the computation is genuinely expensive, in which case `useMemo` is the right tool — not a second piece of state.

## Cheat sheet

- Props flow down and are read-only to the receiver; state is owned and changed by the component itself.
- React compares state by reference, not by deep value — mutate in place and it silently won't re-render.
- Controlled inputs mirror the DOM value in React state (`value`+`onChange`); uncontrolled read from a `ref` on demand.
- Lift state to the nearest common ancestor when siblings need to share it.
- Prefer composition (`children`) over prop drilling more than one or two layers deep.
- Keys must be a stable identity, not array index, whenever a list can reorder, filter, or have items removed from the middle.
- `value && <Component />` renders `0`/`NaN` literally when falsy but not boolean — guard explicitly.
- If a value can be computed from existing props/state, compute it during render; don't duplicate it into its own state.

## Common mistakes

| Mistake | Fix |
|---|---|
| Mutating an array/object then calling the setter with the same reference | Always create a new array/object (spread, `map`, `filter`) |
| Using array index as `key` for a reorderable or filterable list | Use a stable unique ID from the data |
| Drilling a prop through components that don't use it | Use `children`/composition, or Context for widely-needed data |
| Storing a value in state that's fully derivable from other state/props | Compute it during render, or `useMemo` if expensive |
| `count && <Badge/>` when `count` can be `0` | Use `count > 0 && ...` or a ternary |
| Lifting all state to the top "to be safe" | Colocate state as close as possible to where it's used |

## Summary

Props are read-only inputs handed down by a parent, while state is owned and mutated by the component itself, and React decides whether to re-render by comparing state references, not deep values — which is why mutating an object in place instead of replacing it silently breaks updates. Controlled inputs keep the DOM in sync with React state at the cost of a re-render per keystroke; uncontrolled inputs read from the DOM on demand via a ref, trading convenience for performance in large forms. Keys exist so React can track an item's identity across renders independent of its position, which is exactly what index keys fail to provide the moment a list can reorder or have items removed from the middle. The broader theme across all of this is: keep state as close as possible to where it's used, derive what can be derived during render, and let React's diffing do its job by always replacing rather than mutating.

## Top Interview Questions

### Q1. What is the difference between props and state, and can a component change its own props?

Props are values passed into a component by its parent, and from the receiving component's own perspective they are read-only — a component cannot change its own props; only re-rendering with different values from the parent changes what a child receives. State is data a component owns internally and can change itself, typically via `useState`'s setter or a class component's `this.setState`, and changing it triggers a re-render of that component (and its subtree). Confusing the two often shows up as a candidate trying to reassign a prop directly inside a child, which either has no effect or is a caught error in strict mode — the correct pattern is to lift the state up and pass a callback prop down so the child can request a change rather than making it directly.

### Q2. Why does mutating an array in state and calling the setter sometimes not cause a re-render?

React's `useState`/`setState` decides whether to re-render primarily by checking whether the new value is reference-different (`Object.is`) from the current one — it does not deep-compare contents by default. If you call `items.push(x)` and then `setItems(items)`, you're passing the exact same array reference back, so React concludes "nothing changed" and can skip re-rendering, even though the array's contents did change in place. The fix is always to produce a new reference — `setItems([...items, x])` or `setItems(prev => [...prev, x])` — so React's reference check correctly detects the update and schedules a re-render.

### Q3. Compare controlled and uncontrolled inputs. When would you choose uncontrolled?

A controlled input's value lives in React state and is set via the `value` prop, with `onChange` updating that state on every keystroke — React is the single source of truth, and every keystroke causes a re-render. An uncontrolled input lets the DOM manage its own value natively; you read it on demand via a `ref` (e.g., on form submit) instead of tracking every change in state. Uncontrolled is the better choice for very large forms where a re-render per keystroke across many fields becomes a measurable performance cost, for simple "read once on submit" forms, and for input types the DOM already handles well, like file inputs, where React can't fully control the value anyway.

### Q4. Explain what "lifting state up" means and why it's necessary for sibling components to communicate.

Sibling components in React have no direct channel to communicate with each other — data can only flow down through props and back up through callback props, so if two siblings need to share or react to the same piece of state, that state has to move up to their nearest common ancestor. The ancestor then owns the state and passes both the current value and a setter function down as props to whichever children need to read or update it. This is the foundational pattern before reaching for Context or a state management library — it works for a small to moderate number of components and keeps data flow explicit and traceable, which is why it's usually the first tool to reach for, not the last.

### Q5. Why does using an array index as a `key` cause bugs in a reorderable list, specifically?

React uses `key` to match elements between renders, deciding whether a given position in the tree represents the same logical item (update it), a new item (mount it), or a removed item (unmount it). With index keys, if an item is removed from the middle of the list, every subsequent item shifts down one index — so React sees the same set of keys as before and assumes each key still refers to the same logical item, when in fact the data behind that key has shifted by one. It then updates each of those components' props in place with the shifted data instead of unmounting/remounting correctly, which means any local state a component held (an uncontrolled input's typed value, an open accordion, a CSS transition in progress) stays attached to the wrong row's data — a bug that reproduces reliably but looks confusing because there's no error, just data appearing on the "wrong" row.

### Q6. What is prop drilling, and what are two ways to avoid it?

Prop drilling is passing a prop through several intermediate components that don't use the value themselves, purely so a deeply nested descendant can receive it — every intermediate layer has to know about and forward a prop it has no actual interest in, which couples components that shouldn't need to know about each other. One fix is composition: instead of passing data down through a chain of components, pass already-constructed elements as `children` (or another prop) from a level that does have the data, so intermediate layers just render `children` without needing to know what's inside. The other is React Context, which lets a value be read directly by any descendant that subscribes to it, without every layer in between forwarding it — best reserved for genuinely widely-needed, infrequently-changing data like theme or authenticated user, since overuse causes broad re-renders of every consumer whenever the context value changes.

### Q7. What is the "derived state" anti-pattern, and how do you fix it?

It's storing a value in its own piece of state when that value could instead be computed directly from existing props or state during render — for example, storing `fullName` in `useState` when it's always just `${firstName} ${lastName}`. The problem is that stored derived state can drift out of sync with the values it was derived from, because updating `firstName` doesn't automatically update the separately-stored `fullName` — you'd need a `useEffect` to manually keep them synchronized, which adds an extra render cycle and a whole class of bugs where the effect fires late, fires with stale values, or is forgotten in one code path. The fix is to compute the value directly in the component body on every render (`const fullName = \`${firstName} ${lastName}\`;`), which is always correct and, unless the computation is genuinely expensive, costs nothing meaningful — if it is expensive, `useMemo` caches it without introducing a second, separately-managed source of truth.

### Q8. A component with a text input feels laggy as the user types, and profiling shows the entire page tree re-rendering on every keystroke. Diagnose and fix it.

If a single controlled input's state lives high up in the component tree (e.g., in a top-level `App` component), every keystroke updates that state and re-renders the entire subtree beneath it by default, including large, unrelated parts of the UI that don't depend on the input's value at all. The fix is to colocate the input's state as low in the tree as possible — ideally in the component that renders just the input and whatever immediately depends on its value — so a keystroke only re-renders that small subtree instead of the whole page. If some expensive sibling components genuinely can't be restructured that way, wrapping them in `React.memo` (so they skip re-rendering when their own props haven't changed) is the secondary tool, but colocating state correctly usually removes the need for that entirely.

### Q9. Why might `{count && <Badge count={count} />}` render an unexpected `0` on the page?

JSX renders whatever a `&&` expression evaluates to when the left side is falsy, and in JavaScript, `0 && anything` evaluates to `0`, not `false` — React renders numbers (including `0`) as text, but it renders `false`, `null`, and `undefined` as nothing. So when `count` is exactly `0`, the expression short-circuits to the number `0`, and React dutifully renders the literal digit "0" on the page, which is rarely the intended UI. The fix is to make the condition explicitly boolean — `count > 0 && <Badge .../>` — or use a ternary (`count > 0 ? <Badge .../> : null`) so the falsy branch is always a proper `false`/`null`, never a rendered zero.

### Q10. How do you decide when a component should be split into smaller components?

A few concrete signals: the component manages multiple, unrelated pieces of state that don't interact with each other (a sign each piece belongs with its own sub-component); a chunk of its JSX is duplicated or nearly duplicated elsewhere in the codebase (extract it as a shared, reusable component); it re-renders frequently because of state changes that don't actually affect most of what it renders (move that state down into a smaller component that owns just the part that depends on it); or its prop list has grown long and unwieldy, suggesting it's trying to do too much and should be split along those prop groupings. The underlying principle in all four cases is the same: components should have a single, clear reason to re-render and a single clear responsibility, which both improves readability and limits the blast radius of any one state change.

### Q11. Why is comparing objects for equality relevant to React's rendering model, and where does it show up beyond `useState`?

React's reconciliation and its built-in optimizations (`React.memo`, `useMemo`, `useCallback`, and the dependency arrays of `useEffect`) all rely on shallow reference equality checks rather than deep value comparison, for performance reasons — deep-comparing every prop on every render would itself be expensive at scale. This means a new object or array literal created inline on every render (`<Child options={{ a: 1 }} />`) is a *different reference* every time even though its contents are identical, which defeats `React.memo` on `Child` (it will always see "new" props and re-render) and can cause a `useEffect` with that object in its dependency array to re-run every render instead of only when the values actually change. The fix is the same idea as the immutable-state discussion: memoize the object/array itself with `useMemo` (or hoist it outside the component if it's truly constant) so its reference is stable across renders unless its actual inputs change.
