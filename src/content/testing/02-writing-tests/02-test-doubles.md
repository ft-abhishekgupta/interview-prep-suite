---
title: Test Doubles
description: Dummies, stubs, spies, mocks and fakes precisely distinguished with Moq examples, and when to reach for each without over-mocking
difficulty: Core
tags: [test-doubles, mocking, moq, xunit]
---

"Mock" is used loosely to mean any stand-in object, but interviewers listen for whether you know there are five distinct kinds of test double, each with a different purpose. Confusing them is how test suites end up asserting on things that don't matter and breaking on refactors that shouldn't matter.

## The five types

| Type | Purpose | Returns/verifies | Fails the test if... |
|---|---|---|---|
| Dummy | Fills a required parameter, never actually used | Nothing — often `null` or `default` | Never — it's just there to satisfy a signature |
| Stub | Supplies canned answers to calls made during the test | Pre-programmed return values | You assert on the *state* it helped produce |
| Spy | Records how it was called, for later inspection | Call history you inspect yourself | You manually assert on the recorded calls |
| Mock | Pre-programmed with expectations; verifies interactions | Nothing meaningful returned — its job is verification | The expected call didn't happen (`Verify` fails) |
| Fake | A working, lighter-weight implementation | Real (simplified) behaviour | State ends up wrong, same as testing the real thing |

```mermaid
flowchart LR
    A["Dummy<br/>just fills a slot"] --> B["Stub<br/>returns canned data"]
    B --> C["Spy<br/>records calls"]
    C --> D["Mock<br/>asserts expectations"]
    D --> E["Fake<br/>working lightweight impl"]
    style A fill:#999,color:#fff
    style E fill:#2e8b57,color:#fff
```

### One example of each, in C#

```csharp
// Dummy — the logger is required by the constructor but this test never checks logging
var service = new OrderService(repository: fakeRepo, logger: null!);

// Stub — Moq configured to just return canned data, no verification of calls
var stubRepo = new Mock<IOrderRepository>();
stubRepo.Setup(r => r.GetById(1)).Returns(new Order(1, total: 100m));

// Spy — hand-rolled, records what was called for the test to inspect later
public class SpyEmailSender : IEmailSender
{
    public List<string> SentTo { get; } = new();
    public Task SendAsync(string to, string body) { SentTo.Add(to); return Task.CompletedTask; }
}
// ...
Assert.Contains("alice@example.com", spySender.SentTo);

// Mock — Moq configured with an expectation, verified explicitly
var mockEmail = new Mock<IEmailSender>();
service.PlaceOrder(order); // exercise the code
mockEmail.Verify(e => e.SendAsync("alice@example.com", It.IsAny<string>()), Times.Once);

// Fake — a real, working, simplified implementation — no framework needed
public class InMemoryOrderRepository : IOrderRepository
{
    private readonly Dictionary<int, Order> _orders = new();
    public void Add(Order o) => _orders[o.Id] = o;
    public Order? GetById(int id) => _orders.GetValueOrDefault(id);
}
```

> [!KEY]
> Moq's `Mock<T>` class can technically produce a stub, a spy or a mock depending on whether you call `.Setup()` only, inspect `.Invocations`, or call `.Verify()`. The *library* doesn't distinguish them — your usage does.

## State verification versus behaviour verification

**State verification** asks: "after the action, is the world in the right shape?" You inspect the result or the final state of an object — this is what stubs and fakes support.

**Behaviour verification** asks: "did the code under test call its collaborators correctly?" You verify a specific interaction happened — this is what mocks are for.

```csharp
// State verification — check the outcome, don't care how it got there
[Fact]
public void PlaceOrder_MarksOrderAsPlaced()
{
    var repo = new InMemoryOrderRepository(); // fake
    var service = new OrderService(repo);

    service.PlaceOrder(new Order(1, total: 50m));

    Assert.Equal(OrderStatus.Placed, repo.GetById(1)!.Status); // state
}

// Behaviour verification — the outcome has no observable state, so verify the interaction
[Fact]
public void PlaceOrder_SendsConfirmationEmail()
{
    var mockEmail = new Mock<IEmailSender>();
    var service = new OrderService(new InMemoryOrderRepository(), mockEmail.Object);

    service.PlaceOrder(new Order(1, total: 50m, customerEmail: "a@b.com"));

    mockEmail.Verify(e => e.SendAsync("a@b.com", It.IsAny<string>()), Times.Once); // behaviour
}
```

> [!TIP]
> Prefer state verification when possible — it survives refactors to *how* the result is produced. Reach for behaviour verification only when the point of the test genuinely is the interaction (e.g., "an email must be sent"), because there's no resulting state to check.

## Moq syntax: setup, verification, matchers

```csharp
var repo = new Mock<IOrderRepository>(MockBehavior.Strict); // Strict throws on any unconfigured call

// Setup — return values, including different results per argument
repo.Setup(r => r.GetById(1)).Returns(new Order(1, 100m));
repo.Setup(r => r.GetById(It.Is<int>(id => id > 100))).Returns((Order?)null);

// Setup a sequence of return values across successive calls
repo.SetupSequence(r => r.GetById(1))
    .Returns(new Order(1, 100m))
    .Throws<TimeoutException>();

// Argument matchers
repo.Setup(r => r.Save(It.IsAny<Order>()));
repo.Setup(r => r.Save(It.Is<Order>(o => o.Total > 0)));
repo.Setup(r => r.FindByStatus(It.IsIn(OrderStatus.Placed, OrderStatus.Shipped)));

// Verification — did the call happen, and how many times?
repo.Verify(r => r.Save(It.IsAny<Order>()), Times.Once);
repo.Verify(r => r.GetById(999), Times.Never);
repo.VerifyNoOtherCalls(); // fails if any unexpected call was made

// Capturing an argument for later inspection
Order? saved = null;
repo.Setup(r => r.Save(It.IsAny<Order>())).Callback<Order>(o => saved = o);
```

`MockBehavior.Loose` (the default) returns defaults for unconfigured calls; `Strict` throws, which is useful for catching accidental extra calls but adds friction — use it sparingly.

## Over-mocking: the leading cause of brittle tests

The most common way to make a test suite fragile is mocking too much of the system under test, so the test ends up asserting on the *implementation's call sequence* rather than the *behaviour*.

```csharp
// Over-mocked: this test knows and pins down the exact internal call order,
// so any harmless refactor (e.g., checking stock before applying discount) breaks it
mockInventory.Setup(i => i.Reserve(It.IsAny<int>())).Returns(true);
mockPricing.Setup(p => p.Calculate(It.IsAny<Order>())).Returns(90m);
mockLedger.Setup(l => l.Record(It.IsAny<Transaction>()));

service.Checkout(order);

mockInventory.Verify(i => i.Reserve(order.ProductId), Times.Once);
mockPricing.Verify(p => p.Calculate(order), Times.Once);
mockLedger.Verify(l => l.Record(It.IsAny<Transaction>()), Times.Once);
// Three mocks verified for one behaviour — the test is now a change detector, not a spec
```

> [!DANGER]
> A rule of thumb: if a test needs more than two or three mocks to set up, the class under test probably has too many collaborators (a single-responsibility violation), or the test is verifying wiring instead of behaviour. Either split the class or switch that assertion to state verification on the observable outcome.

## Mocking types you don't own — wrap them instead

Mocking a third-party interface directly (an HTTP client, a cloud SDK client, an ORM's `DbContext`) couples your tests to that library's exact shape. When the library changes its API (even in a minor version), every test using it can break, and the mock might not even reflect real behaviour correctly (e.g., `HttpClient` is notoriously awkward to mock because the extension methods aren't virtual).

```csharp
// Don't mock HttpClient directly — wrap it in your own abstraction first
public interface IWeatherApiClient
{
    Task<WeatherResult> GetForecastAsync(string city);
}

public class WeatherApiClient : IWeatherApiClient
{
    private readonly HttpClient _http;
    public WeatherApiClient(HttpClient http) => _http = http;
    public async Task<WeatherResult> GetForecastAsync(string city) =>
        await _http.GetFromJsonAsync<WeatherResult>($"/forecast?city={city}")!;
}

// Now your business logic depends on IWeatherApiClient, which is trivial and safe to mock
var mockClient = new Mock<IWeatherApiClient>();
mockClient.Setup(c => c.GetForecastAsync("London")).ReturnsAsync(new WeatherResult(Temp: 15));
```

The wrapper is thin, gets its own (integration) test against the real API or a recorded fixture, and everything else in the codebase mocks the wrapper's clean interface instead of the SDK's.

## In-memory fake versus the real thing for repositories

| Aspect | In-memory fake (`Dictionary`-backed) | Real database (Testcontainers) |
|---|---|---|
| Speed | Microseconds | Milliseconds–seconds (container startup once, then fast) |
| Fidelity | Low — no SQL, no constraints, no transactions | High — actual engine, actual query behaviour |
| Catches | Business logic bugs in the code that *uses* the repository | SQL/ORM mapping bugs, constraint violations, query performance |
| Best used in | Unit tests | Integration tests |
| EF Core InMemory provider | Looks real, but silently allows things (no FK enforcement, different LINQ translation) that would fail on the real provider | N/A |

> [!WARNING]
> EF Core's `UseInMemoryDatabase` is not a real relational database — it doesn't enforce constraints, doesn't translate LINQ the same way as SQL Server/PostgreSQL, and can pass tests for queries that would throw or behave differently for real. Prefer a genuine fake repository behind your own interface for unit tests, and a real containerised database for integration tests — treat the EF InMemory provider as a smell.

## Mocking time and HTTP

```csharp
// Time: inject TimeProvider (built-in from .NET 8), fake it directly, no library needed
var fakeTime = new FakeTimeProvider(new DateTimeOffset(2024, 6, 1, 0, 0, 0, TimeSpan.Zero));
var service = new SubscriptionService(fakeTime);

// HTTP: use HttpMessageHandler mocking (via a testing library) or wrap in your own client interface
var handlerMock = new Mock<HttpMessageHandler>();
handlerMock.Protected()
    .Setup<Task<HttpResponseMessage>>("SendAsync", ItExpr.IsAny<HttpRequestMessage>(), ItExpr.IsAny<CancellationToken>())
    .ReturnsAsync(new HttpResponseMessage { StatusCode = HttpStatusCode.OK, Content = new StringContent("{}") });
var httpClient = new HttpClient(handlerMock.Object);
```

Mocking `HttpMessageHandler` (via Moq's `Protected()` extension) is the standard way to control `HttpClient` responses without hitting the network — but it's exactly the kind of low-level mocking to hide behind your own `IWeatherApiClient`-style wrapper rather than scattering through business-logic tests.

## What should never be mocked

- **Value objects / DTOs with no behaviour** — just construct a real instance.
- **The class under test itself** — you'd be testing the mock, not the code.
- **Simple pure functions or math** — call the real thing, it's deterministic and fast.
- **Types you don't own, directly** — wrap them first (see above).
- **Everything, "to be safe"** — if every collaborator is mocked, the test only proves the mocks were configured correctly.

## Decision table: which double do I need?

| Situation | Use |
|---|---|
| Constructor needs a parameter the test doesn't care about | Dummy |
| Need a collaborator to return specific data for the scenario | Stub |
| Need to check "was this called with roughly the right data" without failing the build on setup mismatch | Spy |
| Need to strictly assert an interaction happened (e.g., "payment was charged exactly once") | Mock |
| Collaborator is a repository/cache and you want real-ish behaviour cheaply | Fake |
| Testing SQL, constraints, or actual third-party behaviour | Neither — use the real dependency (integration test) |

## Cheat sheet

- Dummy = unused filler. Stub = canned answers. Spy = records calls you inspect. Mock = pre-set expectations, verified. Fake = working lightweight implementation.
- Moq's `Mock<T>` can be any of stub/spy/mock depending on whether you `Setup`, inspect `Invocations`, or `Verify`.
- Prefer state verification (assert the outcome) over behaviour verification (assert the interaction) when both are possible.
- More than 2–3 mocks in one test is a smell — split the class or switch to state verification.
- Never mock a type you don't own directly — wrap it in your own interface first.
- EF Core `InMemoryDatabase` is not a substitute for a real database in tests — it hides real SQL bugs.
- Never mock the class under test, pure functions, or plain data objects.

## Common mistakes

| Mistake | Fix |
|---|---|
| Calling every test double a "mock" regardless of purpose | Use the precise term — it signals you understand verification style |
| Mocking `HttpClient`/SDK clients directly everywhere | Wrap in your own thin interface, mock that instead |
| `Verify`-ing every single call in a test | Verify only the interactions that are the actual point of the test |
| Using EF Core InMemory provider for "integration" tests | Use Testcontainers with the real engine; keep InMemory (if at all) for quick unit scaffolding only |
| MockBehavior.Strict everywhere "for safety" | Use Loose by default; reach for Strict only when unexpected calls are the specific risk |
| Asserting internal call order that isn't actually a requirement | Only verify order (`MockSequence`) when order is a genuine business rule |

## Summary

Test doubles fall into five distinct categories — dummy, stub, spy, mock, fake — separated by what they do (supply data vs. record vs. verify vs. behave) and how a test using them fails. State verification is generally more refactor-safe than behaviour verification, so prefer asserting on outcomes and reserve interaction verification for cases where the interaction *is* the requirement. Over-mocking, especially of types you don't own, is the most common cause of brittle test suites; wrapping third-party dependencies in your own interfaces and using real dependencies in integration tests keeps unit tests both fast and honest.

## Top Interview Questions

### Q1. What are the five types of test double and how do they differ?

Dummy, stub, spy, mock, and fake. A dummy is passed in only to satisfy a method signature and is never actually used by the code path under test. A stub returns pre-programmed canned answers when called, used to control the scenario. A spy records how it was called (arguments, call count) so the test can inspect that history afterward. A mock is pre-configured with expectations and is verified explicitly — the test fails if the expected interaction didn't happen. A fake is a real, working, simplified implementation of the dependency, like an in-memory repository backed by a dictionary. The distinguishing question for each is: does it just supply data (stub), record for later inspection (spy), assert an interaction directly (mock), or behave like a lightweight real thing (fake)?

### Q2. What's the difference between state verification and behaviour verification, and which should you prefer?

State verification checks the outcome after the action — the returned value, or the resulting state of an object or fake repository — without caring how that outcome was produced. Behaviour verification checks that specific interactions with collaborators happened, typically via a mock's `Verify()` call. State verification is generally preferable because it's more resilient to refactors: if you change *how* a result is computed but the result is the same, a state-based test still passes, while a behaviour-based test pinned to the old call sequence would break. Behaviour verification is still necessary when there's no observable state to check — e.g., confirming an email was sent, since "was an email sent" isn't state you can query afterward.

### Q3. When would you reach for a fake instead of a mock?

When you need something that behaves consistently like the real dependency across many tests, rather than being reconfigured per test. A good example is an in-memory repository: instead of setting up a `Mock<IOrderRepository>` differently in every test (which gets verbose and brittle if the tested code calls the repository in slightly different ways), you write one small class backed by a `Dictionary` that actually stores and retrieves data. Tests then just use its real `Add`/`GetById` methods and assert on state, which reads more naturally and survives changes to exactly how many times the repository is called internally. Fakes cost more to write upfront but pay off across many tests; mocks are cheaper for a single, specific interaction check.

### Q4. Why is over-mocking considered a leading cause of brittle test suites?

When a test mocks every collaborator and verifies the exact sequence and arguments of every call, it stops testing the class's actual behaviour and starts testing its internal implementation — literally, the order in which it happens to call its dependencies today. Any safe, behaviour-preserving refactor (reordering two independent calls, extracting a helper, combining two calls into one) then breaks tests that should not have cared. A practical heuristic: if setting up a test requires configuring and verifying more than two or three mocks, either the class under test has too many responsibilities/collaborators, or the test should be checking the resulting state instead of the call sequence.

### Q5. Why shouldn't you mock a type you don't own, like `HttpClient` or a cloud SDK client, directly in business logic tests?

Mocking a third-party type directly couples every test to that library's exact interface shape, which can change between versions and break many unrelated tests at once. It's also often technically awkward — `HttpClient`'s send methods aren't virtual, so you end up mocking the underlying `HttpMessageHandler`, which is verbose and easy to get subtly wrong in a way that doesn't reflect real HTTP behaviour. The fix is to write a small wrapper interface (e.g., `IWeatherApiClient`) around the third-party dependency, give the wrapper its own focused integration test against the real thing or a recorded fixture, and have all business logic depend on and mock the clean wrapper interface instead.

### Q6. Why is EF Core's `UseInMemoryDatabase` provider considered risky for testing repository code?

Because it isn't actually a relational database — it doesn't enforce foreign key constraints, unique indexes, or check constraints the way SQL Server or PostgreSQL would, and it translates LINQ queries differently, sometimes evaluating client-side what the real provider would need to (or fail to) translate to SQL. A test can pass against the InMemory provider and then fail in production against the real database, or vice versa — for example, a query using a SQL function not supported by InMemory. The safer options are a genuine fake (dictionary-backed) behind your own repository interface for fast unit tests, and Testcontainers running the real database engine for integration tests that need to prove the SQL/ORM mapping actually works.

### Q7. How do you decide between `MockBehavior.Strict` and `MockBehavior.Loose` in Moq?

`Loose` (the default) returns default values for any method call that wasn't explicitly set up, which keeps tests concise since you only configure what the test actually cares about. `Strict` throws an exception on any unconfigured call, which is useful when you specifically want to catch the code under test making calls you didn't expect — for example, verifying that a caching layer really does skip the expensive call on a cache hit. In practice, `Strict` should be the exception, not the default, because it makes tests brittle to any additional (even harmless) call the implementation makes, forcing you to update many test setups for unrelated changes.

### Q8. A test verifies `mock.Verify(x => x.Save(order), Times.Once)` and starts failing after a harmless refactor that combined two internal method calls into one. What does that tell you, and what would you change?

It tells you the test was verifying an implementation detail (the exact call to `Save`) rather than an observable outcome, so a behaviour-preserving refactor broke a test that shouldn't have cared. If `Save` ultimately persists data that can be checked afterward, switch the assertion to state verification — use a fake repository and assert the saved order's fields match expectations — so the test only fails when the actual output is wrong, not when the internal call pattern changes. If `Save` genuinely has no observable state (e.g., it's a fire-and-forget notification), keep the behaviour verification, but reconsider how tightly the assertion is written — for example, verifying it was called with a `Times.AtLeastOnce()` or matching on key fields via `It.Is<>()` rather than an exact object reference.

### Q9. What's the risk of using argument matchers like `It.IsAny<T>()` everywhere in Moq setups?

Overusing `It.IsAny<T>()` makes a mock's setup accept any input, which means the test isn't actually verifying that the code under test passes the *correct* data to its collaborator — only that it calls the method at all. A bug that passes the wrong customer ID or a stale total to `Save()` would slip past a test using `It.IsAny<Order>()` in both the setup and the verification. Where the specific argument matters to correctness, use a targeted matcher (`It.Is<Order>(o => o.Total == 100m)`) or capture the argument with `.Callback<T>()` and assert on it directly, reserving `It.IsAny<T>()` for arguments that genuinely don't matter to the scenario being tested.

### Q10. How would you unit test a class that depends on `TimeProvider` and an `IEmailSender`, where placing an order after 5pm should schedule the confirmation email for the next morning?

Inject a `FakeTimeProvider` set to a fixed timestamp just after 5pm, and a mock (or spy) `IEmailSender`. Call the order-placement method, then verify — via the mock — that the scheduling call was made with a target time corresponding to the next morning, computed relative to the fake clock's fixed time, not the real wall clock. This is a case where behaviour verification is appropriate, since "an email was scheduled for time X" is an interaction, not directly observable state, but the fake clock is what makes the whole test deterministic and repeatable regardless of when it actually runs — without it, the test would need to compute "tomorrow" relative to the real current time and could break at certain times of day or across time zones.

### Q11. What's the practical difference between a spy and a mock if both can tell you "this method was called"?

The mechanical difference is in *when* the failure surfaces and how explicit the expectation is. With a mock, you set up the expectation, sometimes before the action even runs, and call `Verify()` afterward, which throws a specific, well-described failure if the expectation wasn't met — this is built into mocking frameworks like Moq. With a spy, you don't declare an expectation upfront; you simply record every call as it happens (arguments, count) in a list or similar structure, and the test itself writes a normal assertion against that recorded history afterward, using whatever assertion style it likes. Spies are more flexible for ad-hoc inspection (e.g., "check the 3rd call had different arguments than the 1st"), while mocks are more concise for the common case of "verify this exact interaction happened N times."

### Q12. Your code under test creates a `new HttpClient()` internally to call an external API. How would you make this testable, and what design change does that imply?

Direct instantiation of `HttpClient` inside the class makes it impossible to substitute a test double, so the first fix is dependency injection — accept an `HttpClient` (or better, your own thin wrapper interface like `IPaymentGatewayClient`) through the constructor rather than `new`-ing it up internally. With the wrapper approach, unit tests mock the simple wrapper interface directly; with raw `HttpClient` injection, tests instead mock the underlying `HttpMessageHandler` and construct an `HttpClient` around it. The wrapper is the better long-term design because it also gives you one place to add resilience policies (retries, timeouts, circuit breakers) and a natural boundary for an integration test that hits a real sandbox endpoint or a recorded fixture, rather than scattering low-level HTTP mocking across the whole codebase.
