---
title: Frontend Testing
description: The testing trophy for front-end apps, why integration tests give the best return, testing behaviour with React Testing Library and mocking with MSW
difficulty: Core
tags: [testing, react-testing-library, playwright, msw]
---

Front-end testing interviews rarely ask "do you write tests" — they ask *what kind*, *at what level*, and *why*, because a suite full of brittle implementation-detail tests is worse than no tests at all. The testing trophy reframes where the effort should actually go.

## The testing trophy for front-end

The classic "testing pyramid" (many unit tests, few E2E) doesn't map cleanly onto front-end apps, where most bugs live in how components *integrate* — a form talking to validation logic talking to state talking to an API call — not in isolated pure functions. Kent C. Dodds' **testing trophy** reflects this:

```mermaid
flowchart TD
    E2E["E2E — few<br/>critical user journeys only"]
    INT["Integration — most tests<br/>component + its real children + mocked network"]
    UNIT["Unit — some<br/>pure functions, complex logic"]
    STATIC["Static — all the time<br/>TypeScript, ESLint"]
    STATIC --> UNIT --> INT --> E2E
```

| Layer | What it checks | Speed | Confidence per test |
|---|---|---|---|
| **Static** | Types, lint rules, obvious mistakes | Instant | Low, but catches whole bug classes for free |
| **Unit** | A single pure function or hook in isolation | Very fast | Moderate — narrow scope |
| **Integration** | A component tree rendering, interacting, and talking to a mocked network, as a user would experience it | Fast | High — closest to how the app is actually used |
| **E2E** | A real browser driving the real (or near-real) app end to end | Slow | Highest, but expensive and slower to diagnose failures |

> [!KEY]
> Integration tests give the best return on effort: they exercise real component composition and real user interaction without the cost, flakiness, and slow feedback loop of a full browser E2E run. Spend the bulk of your testing budget here.

## Testing behaviour, not implementation

React Testing Library (RTL) is built around one principle: **tests should resemble how users interact with your app**, not reach into component internals (state, instance methods, prop values). Its query methods are ranked to nudge you toward accessible, user-facing selectors.

| Query priority | Example | Why |
|---|---|---|
| `getByRole` | `getByRole("button", { name: "Submit" })` | Matches how assistive tech and sighted users both identify elements |
| `getByLabelText` | `getByLabelText("Email address")` | Forms should be navigable by label; this doubles as an a11y check |
| `getByText` | `getByText("Order confirmed")` | Fine for non-interactive content |
| `getByTestId` | `getByTestId("cart-total")` | Last resort — no semantic meaning, doesn't reflect real user experience |

```typescript
test("submits the form with entered values", async () => {
  render(<SignupForm onSubmit={handleSubmit} />);
  await userEvent.type(screen.getByLabelText("Email address"), "a@b.com");
  await userEvent.click(screen.getByRole("button", { name: "Sign up" }));
  expect(handleSubmit).toHaveBeenCalledWith({ email: "a@b.com" });
});
```

> [!WARNING]
> A test that checks `wrapper.state("isOpen")` or calls a component's internal method directly is coupled to implementation, not behaviour — it will break on a harmless refactor (switching `useState` to `useReducer`) even though the user-visible behaviour didn't change. That's a false failure, and it's exactly what RTL's design is meant to prevent.

## Mocking the network with MSW instead of mocking fetch

Mocking `fetch`/`axios` directly (`jest.mock("axios")`) couples tests to *how* the app makes requests, and misses bugs in the actual request construction (wrong URL, wrong method, missing header). **Mock Service Worker (MSW)** intercepts requests at the network level, so the app's real fetch/axios code runs unmodified, and only the actual HTTP response is faked.

```typescript
const server = setupServer(
  http.get("/api/user/:id", ({ params }) =>
    HttpResponse.json({ id: params.id, name: "Ada Lovelace" })
  )
);

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
```

| Approach | Tests the real request code? | Coupled to HTTP client library |
|---|---|---|
| Mock `fetch`/`axios` module directly | No — bypasses your actual call | Yes — breaks if you switch libraries |
| MSW (network-level interception) | Yes — your real code makes a real-shaped request | No — works regardless of HTTP client |

## Testing hooks

Custom hooks that hold meaningful logic deserve direct tests, using `renderHook` from RTL, without needing a full component around them.

```typescript
test("useCounter increments", () => {
  const { result } = renderHook(() => useCounter(0));
  act(() => result.current.increment());
  expect(result.current.count).toBe(1);
});
```

For hooks that are trivial wrappers with no independent logic (a thin `useState` alias), testing them through the components that use them is usually sufficient — a dedicated hook test only earns its keep when the hook has non-trivial behaviour worth isolating.

## Testing async UI without flaky waits

Async UI (a spinner while data loads, then content) is the single biggest source of flaky tests when handled with arbitrary `setTimeout`/`sleep` waits. RTL's `findBy*` queries and `waitFor` poll until a condition is true (or a timeout elapses), instead of waiting a fixed guessed duration.

```typescript
// Flaky: guesses how long the async work takes
await new Promise(r => setTimeout(r, 500));
expect(screen.getByText("Loaded")).toBeInTheDocument();

// Reliable: polls until the element appears, fails fast if it never does
expect(await screen.findByText("Loaded")).toBeInTheDocument();
```

> [!DANGER]
> A fixed-duration wait is a coin flip: too short and it's flaky in CI (slower machines), too long and the whole suite crawls. Always wait for a *condition*, never a *duration*.

## Snapshot tests and their pitfalls

A snapshot test serializes rendered output and compares it against a saved reference file, flagging any difference. They're cheap to write but easy to abuse: a large snapshot of a complex tree fails on almost *any* change, and developers habitually run `--updateSnapshot` without actually reviewing the diff, turning the test into a no-op that "passes" no matter what changed.

> [!TIP]
> Keep snapshots small and targeted (a single rendered value, a formatted string, a small stable component) rather than whole-page trees, and always read the diff before regenerating — a snapshot update is a code review action, not a rubber stamp.

## Component and visual regression testing

Beyond behavioural assertions, **visual regression testing** (Chromatic, Percy, Playwright's screenshot comparison) renders a component and diffs its actual *pixels* against a baseline, catching CSS/layout regressions that behavioural tests can't see — a button that still functions correctly but visually overlaps another element would pass an RTL test yet fail visual regression. These are typically run against isolated component states (often via Storybook stories) rather than full pages, keeping them fast and precisely scoped to what changed.

## End-to-end with Playwright: what belongs there

E2E tests drive a real browser through a real (or near-real, e.g., staging) deployment, verifying that the whole stack — front end, network, back end, sometimes third-party integrations — works together. Because they're slow and comparatively harder to debug on failure, **reserve E2E for a small number of critical, high-value user journeys**: sign-up, checkout, login, the core action that makes the product valuable — not every edge case or every component variant, which belong at the integration or unit level.

```typescript
test("user can complete checkout", async ({ page }) => {
  await page.goto("/cart");
  await page.getByRole("button", { name: "Checkout" }).click();
  await page.getByLabel("Card number").fill("4242424242424242");
  await page.getByRole("button", { name: "Pay" }).click();
  await expect(page.getByText("Order confirmed")).toBeVisible();
});
```

## Accessibility testing

Accessibility bugs are functional bugs for a meaningful fraction of users, and can be caught automatically at low cost: `jest-axe` or Playwright's accessibility scanning run automated audits (missing alt text, insufficient colour contrast, missing form labels, invalid ARIA) as part of the normal test run, catching regressions before manual review.

```typescript
test("signup form has no obvious a11y violations", async () => {
  const { container } = render(<SignupForm />);
  expect(await axe(container)).toHaveNoViolations();
});
```

Automated a11y checks catch a meaningful subset of issues but not everything (they can't judge whether reading order makes logical sense, or whether focus management during a modal open/close is correct) — pair them with periodic manual keyboard/screen-reader testing for anything critical.

## What to test at each level

| Level | Good candidates | Bad candidates |
|---|---|---|
| Unit | Pure functions (formatters, validators, reducers), complex hook logic | A component's entire rendered output |
| Integration | A form submitting, a list filtering, a page reacting to a mocked API response | Third-party library internals |
| E2E | Critical revenue/auth journeys (checkout, login, sign-up) | Every input validation edge case |
| Visual regression | Design-system components, layout-sensitive pages | Business logic correctness |
| Accessibility | Forms, navigation, interactive widgets | Purely decorative, non-interactive markup |

## Cheat sheet

- Testing trophy: static > unit > integration > E2E, in *effort allocation*, with integration carrying the most weight.
- Query by role/label, not test id — it doubles as an accessibility check and resists refactors.
- Never assert on internal state/instance methods — assert on what the user sees/can do.
- Mock the network (MSW), not your own fetch wrapper — it tests your real request code.
- `renderHook` for hooks with real logic; skip dedicated tests for trivial wrapper hooks.
- Wait for conditions (`findBy*`, `waitFor`), never fixed durations — fixed waits are the top cause of flaky suites.
- Keep snapshots small and targeted; always review the diff before updating.
- Reserve E2E for a handful of critical journeys — it's slow and expensive to diagnose.
- Automated a11y checks (`jest-axe`) catch a real subset of issues cheaply — pair with manual review for critical flows.

## Common mistakes

| Mistake | Fix |
|---|---|
| Asserting on component internal state/props instead of visible output | Query and assert on what the user sees/does via RTL |
| Mocking `fetch`/`axios` directly | Use MSW to intercept at the network level and exercise real request code |
| Fixed-duration `setTimeout` waits in tests | Use `findBy*`/`waitFor` to poll for a condition |
| One giant snapshot of a whole page | Snapshot small, targeted values; review diffs before updating |
| Writing E2E tests for every edge case | Push edge cases down to unit/integration; E2E covers critical journeys only |
| Using `getByTestId` as the default query | Prefer `getByRole`/`getByLabelText` — reserve test ids for genuinely non-semantic elements |

## Summary

Front-end testing effort should follow the trophy shape: lean on static typing and linting for free, cheap coverage, write integration tests as the bulk of the suite because they best mirror how users actually experience the app, use unit tests for genuinely isolated logic, and reserve slow, expensive E2E runs for a small set of critical journeys. Testing Library's behaviour-first philosophy, MSW's network-level mocking, and condition-based async waits together produce a suite that catches real regressions without becoming brittle or flaky — which is the actual goal, not a specific test count or coverage percentage.

## Top Interview Questions

### Q1. What is the testing trophy, and how does it differ from the traditional testing pyramid?

The traditional pyramid recommends mostly unit tests, fewer integration tests, and very few E2E tests, on the assumption that unit tests are cheapest and most numerous. The testing trophy, proposed by Kent C. Dodds specifically for front-end apps, argues that most real bugs in UI code live in how pieces integrate — a form's validation talking to its submit handler talking to state — rather than in isolated pure functions, so it shifts the bulk of test investment to the integration layer, while adding a "static" layer at the base (TypeScript, ESLint) that catches whole classes of bugs for free before any test even runs. The practical implication for an interview answer: don't default to "mostly unit tests" for a UI codebase — explain why integration tests give the best confidence-per-effort ratio for front-end specifically.

### Q2. Why does React Testing Library discourage querying by test id or accessing component internals?

RTL's guiding principle is "the more your tests resemble the way your software is used, the more confidence they can give you." Querying by role or label text means the test interacts with the component the same way a real user (including one using assistive technology) would — clicking a button by its accessible name, typing into a field found by its label — so the test only fails when actual user-facing behaviour breaks. Querying by test id or reaching into internal state/props couples the test to implementation details that have no bearing on what the user experiences; refactoring `useState` to `useReducer`, or renaming an internal prop, would break such a test even though nothing observable changed, producing a false failure that erodes trust in the suite and wastes time investigating a non-bug.

### Q3. Why is mocking with MSW considered better than mocking your fetch wrapper or axios module directly?

Mocking `axios`/`fetch` at the module level replaces your actual network call code with a stub, meaning the test never verifies the URL, method, headers, or body your app actually constructs — a bug where the wrong endpoint is called, or a required header is missing, would go completely undetected because the mock never inspects the real request. MSW instead intercepts requests at the network layer (using a service worker in the browser, or an interceptor in Node for tests), so your app's real request-building code executes unmodified and only the final HTTP response is faked. This means MSW-based tests catch a whole class of bugs module mocks miss, and they remain valid if you ever swap your HTTP client library, since the mock isn't coupled to a specific library's API.

### Q4. How do you avoid flaky tests when testing asynchronous UI, like a loading spinner followed by content?

The root cause of most async test flakiness is waiting for a fixed duration (`setTimeout`, `sleep`) and hoping the async work finished by then — too short and it's flaky on slower CI machines, too long and it needlessly slows the whole suite, and either way it's guessing rather than checking. The fix is to wait for an actual condition: RTL's `findBy*` queries (which are `getBy*` combined with `waitFor` under the hood) repeatedly poll the DOM until the expected element appears or a timeout is hit, and `waitFor` lets you assert an arbitrary condition the same way. This makes the test's timing match the app's actual timing rather than an assumption about it, and it fails fast with a clear "element never appeared" error instead of a mysteriously-sometimes-failing assertion.

### Q5. What are the pitfalls of relying heavily on snapshot tests?

Large, whole-component or whole-page snapshots fail on almost any change, including harmless ones like a class name shift or a minor markup restructure, which trains developers to run `--updateSnapshot` reflexively without actually reading the diff — at that point the test provides no real signal, since it "passes" regardless of whether the change was correct or a regression. Snapshots are also weak at expressing *intent* — a diff shows that output changed, not whether the new output is right, unlike an explicit assertion like `expect(screen.getByText("Total: $42")).toBeInTheDocument()` which encodes what should be true. The mitigation is to keep snapshots small and targeted (a formatted value, a small stable subtree) rather than entire pages, and to treat every snapshot update as a real code-review decision, actually reading what changed before accepting it.

### Q6. When would you write an E2E test with Playwright instead of an integration test with React Testing Library?

Integration tests with RTL render your component tree in a simulated DOM (jsdom) with a mocked network, which is fast and gives high confidence about component logic and interaction, but it doesn't verify that the real backend, real network conditions, real browser rendering, or third-party integrations (payment gateways, OAuth redirects) actually work together end to end. E2E tests with Playwright drive an actual browser against a real or near-real deployed environment, so they're the right tool for verifying a small number of genuinely critical, cross-system user journeys — completing checkout, signing up, logging in — where a failure would be catastrophic and where integration tests alone can't rule out an issue in how the pieces are wired together in a real environment. Because E2E tests are slower to run and harder to debug on failure (a failure could be the front end, the API, the test environment, or flaky infrastructure), they should stay a small, curated set, not the primary coverage mechanism.

### Q7. How would you test a custom hook that manages a debounced search query?

I'd use `renderHook` from React Testing Library to mount the hook in isolation without needing a full component, then use fake timers (`jest.useFakeTimers()`) to control the passage of time deterministically rather than relying on real delays, which would make the test slow and potentially flaky. I'd assert that calling the hook's update function immediately does *not* yet reflect the new value (since it's debounced), advance the fake timers past the debounce window (`act(() => jest.advanceTimersByTime(300))`), and then assert the debounced value has updated. I'd also test the cancellation path — calling the update function twice in quick succession before the debounce window elapses should only produce one final update, not two — since that's the actual bug debouncing is meant to prevent, and it's easy to implement incorrectly (e.g., forgetting to clear the previous timeout).

### Q8. A test asserts `component.state.isModalOpen === true` after clicking a button, and it breaks when the team migrates from a class component with `this.state` to a function component with `useState`. What does this reveal, and how should the test be rewritten?

It reveals the test was coupled to implementation details — the specific internal representation of state — rather than to observable behaviour, so a refactor that preserved all user-facing behaviour (the modal still opens on click) still broke the test purely because the internal mechanism for holding that boolean changed shape. This is exactly the failure mode React Testing Library's philosophy is designed to prevent. The test should be rewritten to assert on what a user can actually observe: after clicking the button, query for the modal by its role and accessible name (`expect(screen.getByRole("dialog", { name: "Confirm delete" })).toBeInTheDocument()`) rather than reaching into component internals at all — this version passes regardless of whether the modal's open state is implemented with `useState`, `useReducer`, or any other mechanism, because it only cares about the rendered, user-visible outcome.

### Q9. What is the value of automated accessibility testing (e.g., jest-axe), and what are its limits?

Automated a11y testing runs a rules-based audit against the rendered DOM and flags mechanically detectable issues — missing `alt` text on images, form inputs without associated labels, insufficient colour contrast ratios, invalid or missing ARIA attributes — catching a meaningful and common class of accessibility regressions cheaply, as part of the normal test run, before they ever reach a real user or a manual audit. Its limits are real, though: it cannot judge whether the *logical reading order* of content makes sense for a screen reader user, whether focus is correctly managed when a modal opens and closes (trapping focus inside, returning it on close), or whether an interaction that's technically accessible is actually usable and clear. The correct framing is that automated checks are a cheap first line of defence that catches obvious regressions continuously, not a replacement for periodic manual testing with a keyboard and a screen reader on critical flows.

### Q10. How would you structure the test suite for a checkout flow — what goes at each level, and why?

At the unit level, I'd test pure logic in isolation: price/tax calculation functions, discount code validation, form field validators — these have clear inputs and outputs and don't need any rendering. At the integration level, using RTL and MSW, I'd test the checkout form's behaviour with a mocked API: filling in valid card details and submitting shows a success message, submitting with a declined-card mock response shows the correct error, required field validation blocks submission and shows the right messages — this is where most of the suite's weight should sit, since it covers the bulk of realistic user interactions quickly and reliably. At the E2E level, I'd add exactly one or two Playwright tests covering the full happy-path checkout journey against a real staging environment (including the actual payment provider's test mode), because that's the single highest-value journey to protect against real cross-system integration failures, but I would not duplicate every validation edge case there — those already have fast, reliable coverage at the integration level, and repeating them in E2E would only slow the suite down for no additional confidence.
