---
title: Classes, Structs and Records
description: A practical decision framework for choosing between class, struct, record and record struct, with the syntax each one adds
difficulty: Core
tags: [csharp, records, structs, immutability]
---

Modern C# gives you four ways to define a type — `class`, `struct`, `record`, `record struct` — and interviewers expect you to pick the right one for a given scenario, not just recite definitions. This page is a comparison and decision guide, not just a syntax tour.

## The four options at a glance

| | `class` | `struct` | `record` (class) | `record struct` |
|---|---|---|---|---|
| Storage | Reference (heap) | Value (inline) | Reference (heap) | Value (inline) |
| Default equality | Reference identity | Field-by-field (reflection, slow) | Value equality (generated) | Value equality (generated) |
| Mutability | Mutable by default | Mutable by default | Immutable by convention (`init` setters) | Mutable by default; `readonly record struct` for immutable |
| Inheritance | Full class hierarchy | None (implicitly sealed) | Can inherit other records | None (implicitly sealed) |
| Copy behavior | Assignment copies reference | Assignment copies all fields | `with` expression for non-destructive copy | `with` expression for non-destructive copy |
| `ToString()` | Default prints type name | Default prints type name | Auto-generated, prints all properties | Auto-generated, prints all properties |
| Typical use | Entities, services, behavior-heavy types | Small immutable values (`Point`, `Money`) | DTOs, value objects, messages | Small immutable value objects needing structural equality |

> [!KEY]
> `record` is not a fifth kind of storage — it's a set of compiler-generated members (`Equals`, `GetHashCode`, `ToString`, `with`, deconstruction) layered on top of either a `class` (default) or a `struct` (`record struct`). The storage question (value vs reference) is orthogonal to the equality question (identity vs value).

## Positional records, with-expressions, deconstruction

```csharp
// Positional syntax generates a primary constructor, init-only properties, Equals, GetHashCode, ToString
public record Point(int X, int Y);

var p1 = new Point(1, 2);
var p2 = p1 with { Y = 5 };     // non-destructive copy — p1 untouched, p2.X == 1, p2.Y == 5

Console.WriteLine(p1);          // Point { X = 1, Y = 2 } — auto ToString
Console.WriteLine(p1 == p2);    // false — value equality

var (x, y) = p1;                // deconstruction — generated automatically for positional records
Console.WriteLine($"{x},{y}");  // 1,2
```

```csharp
// record struct — same generated members, but value-type storage
public record struct Vector2(double X, double Y);

var v1 = new Vector2(1, 2);
var v2 = v1;              // full copy, independent (struct semantics)
v2.X = 99;
Console.WriteLine(v1.X);  // 1 — v1 unaffected

// readonly record struct — enforces immutability, enables compiler optimisations (skips defensive copies)
public readonly record struct Money(decimal Amount, string Currency);
```

## Readonly struct and init-only setters

`readonly struct` tells the compiler every field is immutable after construction, which lets it skip defensive copies when the struct is passed with `in` — a real (if usually small) performance win, and a correctness signal for readers.

```csharp
public readonly struct Temperature
{
    public double Celsius { get; }
    public Temperature(double celsius) => Celsius = celsius;
    public Temperature ToFahrenheit() => new(Celsius * 9 / 5 + 32);
}
```

`init` accessors (C# 9+) let a property be set during object initialization but not afterward — giving you immutability with familiar object-initializer syntax, without requiring a big constructor.

```csharp
public class Order
{
    public int Id { get; init; }
    public string Customer { get; init; } = "";
}

var order = new Order { Id = 1, Customer = "Alice" };
// order.Id = 2;   // compile error — init-only, cannot assign after construction
```

## Required members

`required` (C# 11+) forces callers to set a property during object initialization, catching "forgot to set a mandatory field" bugs at compile time instead of at runtime.

```csharp
public class UserDto
{
    public required string Email { get; init; }
    public string? DisplayName { get; init; }
}

var u = new UserDto { Email = "a@b.com" };   // compiles
// var bad = new UserDto();                  // compile error — Email is required
```

> [!TIP]
> Before C# 11, teams simulated "required" with constructor parameters. `required` + `init` gives you mandatory-but-still-object-initializer-friendly construction — useful for DTOs deserialized by JSON, where a big constructor is awkward.

## Immutability patterns

```mermaid
flowchart LR
    A["Constructor / positional record"] --> B["init-only properties"]
    B --> C["Object fully constructed, immutable"]
    C --> D["with expression"]
    D --> E["New object, changed fields, original untouched"]
```

Immutability buys you thread-safety without locks (an immutable object can be freely shared across threads), simpler reasoning (no "who mutated this and when"), and safe use as dictionary keys or in sets (a mutable key can corrupt a hash-based collection if mutated after insertion). The trade-off is an allocation per "change" (`with` creates a new object), which is usually a fine trade for correctness in DTOs and messages, but is not a good fit for hot-path, mutate-in-place data structures.

> [!WARNING]
> `record`'s generated equality is only as deep as its properties. If a record holds a mutable reference type (say, a `List<int>`), two records can be "equal" by reference to the same list even after one side's list contents are mutated — the record's generated equality does not deep-clone or deep-compare collections by value unless you write that yourself.

## Decision table: which one do I reach for?

| Scenario | Choose | Why |
|---|---|---|
| Small immutable value (coordinate, money, RGB color) | `readonly record struct` | Value semantics, value equality, no heap allocation |
| DTO / API request-response payload | `record` (class) | Value equality for easy testing, `with` for variations, cheap to reason about |
| Entity tracked by an ORM, has identity across mutations | `class` | Needs mutable state and identity-based equality, not structural |
| Domain service, repository, controller | `class` | Behavior-heavy, no value semantics needed, often has dependencies injected |
| Message/event passed between systems | `record` | Immutable by convention, easy to log via generated `ToString` |
| Large aggregate root with child collections | `class` | Records' cheap `with`-copy doesn't deep-copy nested mutable collections — misleading for aggregates |
| Hot-path numeric type processed millions of times per second | `struct` or `readonly struct` | Avoids per-instance heap allocation and GC pressure |

## Cheat sheet

- `record` = generated `Equals`/`GetHashCode`/`ToString`/`with`/deconstruction on top of a class (or struct with `record struct`).
- `readonly struct` promises no mutation, letting the compiler skip defensive copies with `in`.
- `init` allows set-once-at-construction properties; `required` forces the caller to set them.
- `with` always makes a **shallow** copy — nested mutable reference members are shared, not cloned.
- Positional records auto-generate a deconstruct method; you can add your own `Deconstruct` to plain classes too.
- Use structs/record structs for small, frequently-copied, immutable values.
- Use classes/records for entities and DTOs respectively — identity vs. value is the deciding question.
- `record class` and `record` are the same thing; `class` is implied when omitted.

## Common mistakes

| Mistake | Fix |
|---|---|
| Using `record` for a large mutable aggregate with child lists | Use a `class`; `with` won't deep-copy the children the way you'd expect |
| Assuming `with` deep-copies everything | It's a shallow member-wise copy — clone nested mutable objects yourself if needed |
| Making a `record struct` large and passing it by value everywhere | Mark it `readonly` and pass with `in`, or reconsider as a class |
| Forgetting `record` still allows `null` since it's a class by default | Use `record struct` if a non-nullable value type is required |
| Adding a mutable public property to an otherwise "immutable" record | Use `init` (or a private setter) consistently, or immutability is just a convention that will get broken |
| Expecting `required` to work in older C#/.NET versions | It needs C# 11 / .NET 7+ — check the project's language version |

## Summary

`class`, `struct`, `record`, and `record struct` differ along two independent axes — storage (reference vs. value) and generated equality/copy semantics (identity vs. value) — and picking the right combination is a matter of matching the type's *role*: entity, value object, DTO, or hot-path numeric type. Records give you value equality and non-destructive `with`-copies for free, `init`/`required` give you controlled, mandatory construction, and `readonly struct` gives the compiler enough information to optimize away defensive copies. The decision table is the fast way to reason about it in an interview: ask "does this have identity, and is it mutated in place?" before reaching for a keyword.

## Top Interview Questions

### Q1. What does the `record` keyword actually generate for you?

For a positional record like `public record Point(int X, int Y);`, the compiler generates: `init`-only properties `X` and `Y`; a primary constructor accepting both; an overridden `Equals(object)` and a strongly-typed `Equals(Point)` that compare every property value; a `GetHashCode()` combining the hash codes of all properties; an overridden `ToString()` that prints the type name and every property; `==`/`!=` operators wired to the value-based `Equals`; a `Deconstruct` method enabling `var (x, y) = point;`; and support for the `with` expression to produce a modified copy. None of this is magic beyond normal C# — you can see it by decompiling — it's simply boilerplate the compiler writes so you don't have to, and it's why records are the default recommendation for small immutable data-carrying types.

### Q2. What's the difference between `record` and `record struct`?

Both get the same generated members (`Equals`, `GetHashCode`, `ToString`, `with`, deconstruction), but `record` (equivalently `record class`) is a reference type stored on the heap with reference-type assignment semantics (aliasing), while `record struct` is a value type stored inline with copy-on-assignment semantics, just like an ordinary `struct`. This means two `record` variables can alias the same object, while two `record struct` variables are always independent copies after assignment. Choose `record struct` when the type is small and copied often (a 2D point, a money amount) and you want to avoid heap allocation; choose `record` for anything larger or where reference semantics for identity within a single logical "owner" don't matter, since value equality already gives you meaningful comparison.

### Q3. Does the `with` expression perform a deep copy?

No — `with` performs a **shallow, member-wise copy**: it creates a new instance and copies each property's current value across, then applies your specified changes. If a property holds a reference to a mutable object (say, a `List<string>` or another mutable class), the new instance's property points to the *same* list instance as the original — mutating that shared list through either the original or the `with`-copy is visible from both. This is a common interview trap: people assume records are "fully immutable" and are surprised when a nested mutable collection breaks that assumption. The fix, if true deep immutability is required, is to use immutable collection types (`ImmutableList<T>`) as the property type, or to explicitly clone nested mutable state in a custom copy constructor.

### Q4. When would you choose a `class` over a `record` for what looks like a simple data-holding type?

When the type has **identity** that must be tracked independently of its current field values — the clearest example is an entity managed by an ORM like Entity Framework, where an `Order` with a database-generated `Id` needs to remain "the same order" even as its `Status` field changes over its lifetime, and where two different orders that happen to currently have identical field values must **not** compare as equal. A `record`'s generated value equality would make `order1 == order2` true whenever their properties matched, which is semantically wrong for entities and can also cause confusing bugs in hash-based collections or change-tracking logic that relies on reference identity. The rule of thumb: value objects and DTOs (no independent identity, defined entirely by their values) → `record`; entities (identity persists across changes) → `class`, often with an explicit identity-based `Equals` comparing just the key.

### Q5. What problem do `init` accessors solve that a normal setter or a constructor doesn't?

A normal `set` accessor allows mutation at any point in the object's lifetime, which is often more permissive than intended for value objects and DTOs that should be fixed once built. A large constructor forces every property to be supplied positionally (or via named arguments), which becomes unwieldy as the number of optional properties grows and loses the readability of object-initializer syntax. `init` accessors let you use the familiar `new Foo { A = 1, B = 2 }` object-initializer syntax while still guaranteeing that no code anywhere else in the program can later mutate `A` or `B` — you get the ergonomics of a mutable-looking initializer with the safety of true immutability after construction, which is exactly why `record`'s generated properties default to `init` rather than `set`.

### Q6. What does `required` add, and how did people work around its absence before C# 11?

`required` (C# 11 / .NET 7+) marks a property as mandatory: the compiler produces an error if an object initializer creating an instance of that type doesn't set every required property. Before this existed, teams either used a constructor with mandatory parameters (losing object-initializer ergonomics and awkward with many optional properties), used nullable reference type warnings as a soft signal (easy to ignore, not enforced), or simply relied on documentation and code review, which routinely missed forgotten mandatory fields — especially painful for DTOs deserialized from JSON via `System.Text.Json`, which historically preferred parameterless construction plus property setters. `required` closes that gap directly: you keep the initializer syntax deserializers and callers expect, but the compiler now guarantees the mandatory properties are always set.

### Q7. Why would you mark a struct `readonly`, and what does it actually change at the IL/performance level?

Marking a `struct` (or `record struct`) `readonly` is a compile-time promise that none of its instance methods mutate any field — the compiler enforces this by rejecting any member that would need to assign to a field outside the constructor. The concrete benefit shows up when the struct is passed with the `in` modifier: without the `readonly` guarantee, the compiler cannot prove that calling a method on the `in`-parameter won't mutate it, so it silently creates a defensive local copy before every such call to protect the caller's data — an allocation-free but still real copy cost that can add up in tight loops. With `readonly struct`, the compiler knows no method can mutate state, so it can call methods directly against the reference with no defensive copy, which is a genuine, measurable performance improvement in hot numeric or geometry code that passes structs by `in` repeatedly.

### Q8. You're designing a payment `Money` type used across a large codebase. Would you make it a class, struct, record, or record struct? Justify it.

I'd make it a `readonly record struct Money(decimal Amount, string CurrencyCode)`. It's small (a decimal plus a short string reference, comfortably under the "keep structs small" guideline), it's conceptually a *value* — two `Money` instances with the same amount and currency should be considered equal, not merely "the same reference" — and it will be created and compared extremely often (every calculation, every comparison in tests), so avoiding heap allocation per instance matters at scale. `record struct` gives generated value equality and `ToString` for logging/debugging for free, and `readonly` lets me pass it with `in` in performance-sensitive aggregation code without defensive-copy overhead. I would explicitly avoid a plain `class` here since reference equality would be actively wrong (two $10 amounts should be equal), and I would avoid a non-record struct since I'd otherwise have to hand-write `Equals`/`GetHashCode`/`ToString` myself.

### Q9. What happens if you inherit from a record?

Records support inheritance (unlike structs, which cannot inherit from anything but implicitly derive from `ValueType`): `public record Employee(string Name) : Person(Name)` is valid if `Person` is itself a record. The generated `Equals` for a derived record checks that the runtime type matches exactly (using a generated `EqualityContract` property) in addition to comparing all properties — so a `Person` and an `Employee` with identical `Name` values are **not** equal, even though `Employee` is-a `Person`, because their `EqualityContract`s differ. This is intentional and different from typical class equality overrides, which sometimes just check `GetType()` manually; records bake that runtime-type check in automatically so you don't accidentally implement equality that violates the Liskov substitution principle by comparing across unrelated derived types.

### Q10. Can two different record types with identical property values ever compare equal with `==`?

No — this is guarded by the `EqualityContract` mechanism mentioned above. Even if `record A(int X);` and `record B(int X);` are structurally identical, `new A(1) == new B(1)` does not compile at all (there's no implicit conversion and no shared base making `==` applicable), and even where a common base record exists, the generated equality checks that both sides report the same concrete runtime type before comparing properties. This differs from some other languages' "structural typing" where identical shapes are considered interchangeable — C# records are still nominally typed; only two instances of the *same* record type (or type hierarchy through inheritance) can ever be value-equal.

### Q11. In production, you found a `Dictionary<CacheKey, T>` sporadically failing to find entries it should contain, where `CacheKey` is a mutable class. What's the likely cause, and how would records help?

The likely cause is that a `CacheKey` instance was mutated *after* being used as a dictionary key — hash-based collections bucket entries by the key's hash code computed at insertion time, so if a field contributing to `GetHashCode()` changes afterward, the entry is now stored in the wrong bucket and `TryGetValue` with an equal-but-freshly-hashed key will look in the wrong bucket and report a miss, even though the entry is technically still present. The fix is to make key types immutable so this class of bug is structurally impossible — a `record` or `record struct` with `init`-only properties (the default for records) guarantees the key's hash code cannot change after construction, since there is no way to mutate its properties post-creation. This is a strong, concrete argument for "always use immutable types as dictionary/hash-set keys," and records make that the path of least resistance.

### Q12. Is a `record`'s auto-generated `ToString()` safe to use in production logs?

Usually yes for DTOs, but it's worth a caveat: the generated `ToString()` prints every public property's value, including nested objects (recursively, if they also override `ToString()` sensibly) — which is convenient for debugging and structured logs but can leak sensitive data (passwords, tokens, PII) straight into log output if such fields exist on the record. The practical guidance is to avoid putting secrets in a record used for logging, or to override `ToString()` explicitly to redact sensitive properties, and to be aware that adding a new property to a widely-logged record silently changes what appears in every log line that calls `ToString()` on it — a subtle but real production/compliance concern that plain classes don't have by default, since they don't print their fields unless you write that code yourself.
