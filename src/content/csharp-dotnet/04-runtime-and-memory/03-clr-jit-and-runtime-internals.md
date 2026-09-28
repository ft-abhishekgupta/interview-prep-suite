---
title: CLR, JIT and Runtime Internals
description: What the CLR actually does with your compiled code, how JIT and tiered compilation work, and how NET Framework, NET Core and NET 5+ differ
difficulty: Advanced
tags: [clr, jit, runtime, dotnet]
---

Most C# developers never need to think about the CLR — until an interview asks "what happens between writing `Console.WriteLine` and it printing to the screen?" This page traces that pipeline end to end, because that trace is exactly what senior interviewers want to hear.

## What the CLR is responsible for

The Common Language Runtime (CLR) is the execution engine underneath every .NET program. It is responsible for:

- **Loading assemblies** and resolving their dependencies
- **JIT compiling** Intermediate Language (IL) into native machine code
- **Memory management** via the garbage collector
- **Type safety enforcement** — verifying IL doesn't violate the type system
- **Exception handling** — structured exception propagation across frames
- **Security and code access** (much reduced in modern .NET compared to legacy Code Access Security)
- **Interop** with unmanaged code via P/Invoke and COM

> [!KEY]
> The CLR is a *language-agnostic* runtime — C#, F#, VB.NET all compile to the same IL and run on the same CLR. This is exactly why cross-language interop within .NET (a C# library calling an F# library) requires no special glue: they share a common type system (the CTS) and a common intermediate format.

## IL and metadata

The C# compiler (Roslyn) never produces machine code directly — it produces **IL** (Intermediate Language, also called MSIL/CIL), a stack-based, CPU-independent instruction set, packaged into an **assembly** (a `.dll`/`.exe`) alongside **metadata** describing every type, method, field, and their signatures.

```csharp
public int Add(int a, int b) => a + b;
```

compiles to IL resembling:

```text
ldarg.1
ldarg.2
add
ret
```

Metadata is what makes .NET **reflective**: `typeof(MyClass).GetMethods()` works because the assembly carries a full description of its own types alongside the IL, not just raw executable bytes.

## JIT compilation and tiered compilation

IL is not directly executable by the CPU — the **Just-In-Time (JIT) compiler** translates it into native machine code the first time a method is actually called, caching the result so subsequent calls reuse the compiled version without re-translating.

Modern .NET uses **tiered compilation** by default:

| Tier | When | Optimization level | Goal |
|---|---|---|---|
| Tier 0 (quick JIT) | First call to a method | Minimal — compiles fast, runs slower | Get the app started quickly |
| Tier 1 (optimized) | After the method is called enough times (hot method) | Full optimizations (inlining, loop unrolling) | Best steady-state throughput |

```mermaid
flowchart LR
    A["C# source"] --> B["Roslyn compiler"]
    B --> C["IL + metadata<br/>in assembly"]
    C --> D["CLR loads assembly"]
    D --> E["JIT: Tier 0<br/>quick compile"]
    E --> F{"Method called<br/>frequently?"}
    F -->|Yes| G["JIT: Tier 1<br/>optimized recompile"]
    F -->|No| H["Stays at Tier 0"]
    G --> I["Native code executes"]
    H --> I
```

This trade-off — fast startup vs. peak throughput — used to be an either/or choice (the old JIT always fully optimized, which cost startup time); tiered compilation gets both by promoting only methods that turn out to matter.

> [!TIP]
> Saying "tiered compilation trades a slightly slower first call for a much faster application startup, then recompiles hot methods with full optimizations once they've proven they're worth it" is the kind of precise trade-off explanation that reads as senior.

## ReadyToRun and Native AOT

**ReadyToRun (R2R)** pre-JITs assemblies at publish time, embedding native code alongside the IL — the CLR can use the precompiled native code directly at startup and skip JIT compilation for those methods, at the cost of larger binaries and less runtime-specific optimization (R2R code targets a generic baseline CPU instruction set unless you specify more). **Native AOT** (introduced fully in .NET 7) goes further: it compiles the entire application to a single native, self-contained executable ahead of time with no JIT and no separate CLR loading step at runtime, dramatically improving cold-start time and memory footprint — at the cost of losing some dynamic features (heavy reflection, runtime code generation) that assume IL is still present.

| Approach | JIT at runtime? | Startup time | Use case |
|---|---|---|---|
| Standard JIT (tiered) | Yes | Baseline | General apps, servers with long uptimes |
| ReadyToRun | Partial (falls back to JIT for uncompiled paths) | Faster cold start | Containerized services, CLI tools |
| Native AOT | No | Fastest cold start, smallest footprint | Serverless functions, CLI tools, environments where startup latency is critical |

## Assemblies and the loading process

An assembly is the unit of deployment and versioning — it carries a manifest listing its own identity (name, version, optionally a strong name/public key) and the assemblies it references. Loading happens on demand: the CLR resolves and loads an assembly the first time a type from it is actually touched, not when the referencing assembly itself loads — this is why a reference to a rarely-used library doesn't necessarily cost startup time if that code path is never hit.

## AppDomain vs AssemblyLoadContext

| Concept | .NET Framework | .NET Core / .NET 5+ |
|---|---|---|
| Isolation unit for loading/unloading assemblies | `AppDomain` | `AssemblyLoadContext` (ALC) |
| Can unload code at runtime | Yes, by unloading the whole `AppDomain` | Yes, via a `Collectible` `AssemblyLoadContext` |
| Granularity | Whole application domain, heavier | Lighter-weight, can coexist with the default load context |
| Common use case today | Plugin isolation in legacy apps | Plugin systems, hot-reload scenarios in modern .NET |

`AssemblyLoadContext` was introduced because `AppDomain`s were a heavy, Windows-specific isolation mechanism that never fully worked cross-platform; ALCs give the specific capability people actually wanted from `AppDomain`s — loading and later unloading a set of assemblies (e.g. for a plugin) — without the rest of the `AppDomain` machinery (like separate security boundaries), which .NET Core dropped.

## .NET Framework vs .NET Core vs .NET 5+

| Aspect | .NET Framework | .NET Core (1.0–3.1) | .NET 5+ |
|---|---|---|---|
| Platform | Windows only | Cross-platform | Cross-platform |
| Open source | Partially | Fully | Fully |
| Release model | Tied to Windows updates | Independent, faster cadence | Independent, yearly major releases |
| Performance | Baseline | Significantly improved | Continues improving each release |
| Current status | Maintenance mode only | Superseded by .NET 5+ | Actively developed (unified naming from .NET 5 onward) |
| Native AOT / ReadyToRun | Not available | Introduced late (R2R only) | Full support, expanding each release |

> [!NOTE]
> ".NET Core" as a name was retired starting with .NET 5 specifically to signal there is now one unified ".NET" going forward — "Core" no longer needed to distinguish it from ".NET Framework", which is now considered legacy and receives only security/compatibility fixes.

## Reflection cost, attributes, and strong naming

Reflection (`GetType()`, `Type.GetMethod()`, `MethodInfo.Invoke()`) lets code inspect and invoke members discovered at runtime rather than compile time, but it bypasses the normal, JIT-optimized call path — `MethodInfo.Invoke` is typically an order of magnitude or more slower than a direct call, due to argument boxing, security/validation checks, and the indirect dispatch itself. Heavy reflection use (e.g. in serialization hot paths) is a classic performance smell; caching `MethodInfo`/compiled delegate access (or using source generators, which many modern serializers now do) avoids paying that cost repeatedly.

**Attributes** (`[Obsolete]`, `[Serializable]`, custom ones) are metadata attached to types/members, readable via reflection at runtime — they don't change IL execution themselves, they're just structured data other code (or the compiler, for well-known ones) can query.

**Strong naming** signs an assembly with a public/private key pair, giving it a unique identity (name + version + public key token) that prevents accidental substitution by a same-named-but-different assembly — mostly relevant for shared/GAC-deployed libraries; most modern .NET apps deploy self-contained and don't need it.

## Managed vs unmanaged code, and P/Invoke

**Managed code** runs under the CLR — it's JIT-compiled from IL, garbage collected, and type/memory safety is enforced by the runtime. **Unmanaged code** (C, C++, or any native library) runs directly on the CPU with no CLR oversight — no GC, no automatic bounds checking, manual memory management.

**P/Invoke** (Platform Invoke) is how managed code calls into unmanaged native libraries:

```csharp
[DllImport("user32.dll", CharSet = CharSet.Unicode)]
private static extern int MessageBox(IntPtr hWnd, string text, string caption, uint type);

MessageBox(IntPtr.Zero, "Hello from managed code", "P/Invoke", 0);
```

The CLR performs a **marshaling** step at the boundary — converting managed types (strings, arrays, structs) into their unmanaged equivalents and back, since the two type systems don't share a representation. This crossing has real cost (context transition, marshaling overhead) and is why tight loops calling into native code via P/Invoke are usually restructured to batch the native call rather than calling per-item.

> [!WARNING]
> Once you cross into unmanaged code via P/Invoke, the CLR's safety guarantees stop applying to whatever that native code does — a bug in the native library can corrupt memory or crash the process in ways managed code alone never could. Wrapping unmanaged handles in a `SafeHandle`-derived type is the standard way to still get deterministic, exception-safe cleanup at the managed/unmanaged boundary.

## Cheat sheet

- The CLR loads assemblies, JIT-compiles IL, runs the GC, and enforces type safety — one runtime, many source languages via a Common Type System.
- Roslyn compiles C# to IL + metadata, not machine code; the JIT compiles IL to native code at first use.
- Tiered compilation: Tier 0 is a fast, unoptimized JIT for quick startup; Tier 1 recompiles hot methods with full optimization.
- ReadyToRun pre-JITs at publish time for faster startup; Native AOT skips JIT entirely, compiling straight to a native executable.
- `AssemblyLoadContext` replaced `AppDomain` as the unit of load/unload isolation in .NET Core and later.
- .NET Framework is Windows-only and in maintenance mode; .NET 5+ is the actively developed, cross-platform, unified successor to .NET Core.
- Reflection bypasses the normal optimized call path and is meaningfully slower — cache `MethodInfo`/delegates or use source generators for hot paths.
- P/Invoke crosses into unmanaged code with a real marshaling cost, and loses all CLR safety guarantees on the native side.

## Common mistakes

| Mistake | Fix |
|---|---|
| Assuming C# compiles directly to machine code | It compiles to IL; the JIT produces machine code at runtime |
| Calling reflection-heavy code (`MethodInfo.Invoke`) in a hot loop | Cache reflection results, use compiled delegates, or use source generators |
| Assuming ReadyToRun eliminates all JIT work | R2R only pre-compiles what it can predict; some paths still JIT at runtime |
| Choosing Native AOT without checking reflection/dynamic code usage | Audit for heavy reflection, dynamic proxies, or runtime codegen first — AOT restricts these |
| Treating "Core" as still meaningful in versioning after .NET 5 | .NET 5+ dropped "Core" from the name; there's one unified .NET going forward |
| Calling into unmanaged code per-item in a tight loop | Batch the P/Invoke call to amortize the marshaling/transition cost |

## Summary

The CLR turns portable IL and metadata — produced by Roslyn from your C# — into running native code via the JIT, while also owning memory management, type safety, and exception handling. Tiered compilation balances fast startup against peak throughput by promoting only genuinely hot methods to full optimization, and ReadyToRun/Native AOT push more of that work earlier (or eliminate it) for startup-sensitive scenarios. `AssemblyLoadContext` replaced the heavier `AppDomain` for runtime code isolation, and .NET 5+ unified the platform after .NET Core proved the cross-platform, open-source model. Reflection and P/Invoke both step outside the CLR's normal fast path — one paying a dispatch cost, the other losing safety guarantees entirely — and both are worth naming explicitly when discussing performance-sensitive code.

## Top Interview Questions

### Q1. What does the CLR actually do, end to end, from source code to execution?

Roslyn compiles C# source into IL (a CPU-independent instruction set) plus metadata describing every type and member, packaged into an assembly. At runtime, the CLR loads that assembly, and the JIT compiler translates each method's IL into native machine code the first time it's actually called, caching the result so later calls skip retranslation. While the program runs, the CLR also manages the garbage-collected heap, enforces type safety by verifying IL doesn't violate the type system, and handles structured exception propagation across call frames. The key insight to state explicitly: the CLR is language-agnostic — C#, F#, and VB.NET all funnel through the same IL and the same runtime services.

### Q2. What is tiered compilation, and what problem does it solve?

Before tiered compilation, the JIT had one mode: fully optimize every method the first time it's called, which produces fast steady-state code but slows down application startup, since even rarely-called methods pay the full optimization cost upfront. Tiered compilation splits this into two tiers: Tier 0 does a fast, minimally-optimized compile on first call to get the app running quickly, and the runtime tracks call counts; methods called frequently enough are recompiled at Tier 1 with full optimizations (inlining, loop unrolling, etc.) once they've proven they're actually hot. This gets both fast startup and good steady-state throughput, instead of forcing a single trade-off across the whole application.

### Q3. What's the difference between ReadyToRun and Native AOT?

ReadyToRun pre-JITs an assembly's IL into native code at publish time and embeds both the native code and the original IL in the same file — at startup, the CLR uses the precompiled native code where available, skipping JIT for those methods, but it still loads a full CLR and can fall back to JIT for anything not covered (like generic instantiations not known ahead of time). Native AOT compiles the entire application ahead of time into a single, fully native, self-contained executable with no separate CLR loading step and no JIT at runtime at all, which gives the fastest possible startup and smallest memory footprint, but it restricts dynamic features that assume IL is still present at runtime — heavy reflection, runtime code generation, and some dynamic-proxy-based libraries need to be avoided or specifically supported.

### Q4. Why was `AssemblyLoadContext` introduced to replace `AppDomain`?

`AppDomain`s in .NET Framework provided isolation boundaries that allowed loading and later unloading a set of assemblies (useful for plugin systems) along with a separate security context — but this was a heavyweight, Windows-specific mechanism that never translated cleanly to a cross-platform runtime, and much of what it provided (like separate security boundaries) wasn't needed or used by most real applications anyway. `AssemblyLoadContext` was introduced in .NET Core to give specifically the capability people actually used `AppDomain`s for — loading a set of assemblies (e.g. a plugin) into an isolated context and later unloading it via a `Collectible` ALC — without the rest of the heavier, platform-specific `AppDomain` machinery.

### Q5. Why is reflection significantly slower than a direct method call, and how do you avoid paying that cost repeatedly?

A direct method call goes through the normal JIT-compiled, statically-dispatched (or virtually-dispatched, still fast) path that the runtime has fully optimized. `MethodInfo.Invoke()` instead goes through a generic invocation mechanism that has to validate the target and arguments at runtime, box value-type arguments into `object[]`, and dispatch indirectly — all overhead the direct call path doesn't pay, making it commonly an order of magnitude or more slower per call. The standard mitigation is to avoid repeated raw reflection in hot paths: cache the `MethodInfo` lookup itself (the lookup, not just the invoke, is expensive), compile a delegate from it once (`CreateDelegate`) and reuse that delegate, or — increasingly the modern answer — use source generators (as `System.Text.Json` does) that generate real, directly-callable code at compile time instead of using reflection at all.

### Q6. What's the practical difference between .NET Framework, .NET Core, and .NET 5+ that you'd explain to someone starting a new project today?

.NET Framework is Windows-only, closed-source-adjacent (partially open), tied to the Windows release cycle, and is now in maintenance mode — it receives only security and compatibility fixes, no new features. .NET Core (1.0 through 3.1) was the fully open-source, cross-platform rewrite with an independent, faster release cadence and significantly better baseline performance. Starting with .NET 5, Microsoft dropped "Core" from the name specifically to signal there's now one unified, actively developed ".NET" going forward, continuing .NET Core's model with yearly major releases and expanding features like Native AOT. For any new project today, .NET 5+ (the current LTS or latest release) is the answer — .NET Framework should only be a consideration for maintaining existing legacy Windows-only applications that can't yet be migrated.

### Q7. What is marshaling in the context of P/Invoke, and why does it matter for performance?

When managed code calls into an unmanaged (native) function via P/Invoke, the two sides don't share a common representation for types — a managed `string` is UTF-16 with a length prefix, while a native C string might be null-terminated ANSI or UTF-8; a managed array has GC-tracked header information a native array doesn't. Marshaling is the CLR's process of converting managed argument types into their unmanaged equivalents before the call, and converting return values (and any `ref`/`out` parameters) back afterward. This conversion has real, non-trivial cost — string encoding conversions, struct layout translation, potentially pinning memory so the GC doesn't move it mid-call — which is why calling a P/Invoke function once per item in a large loop is far more expensive than batching the data and crossing the managed/unmanaged boundary once.

### Q8. A team wants to migrate a service to Native AOT for faster cold starts in a serverless environment, but the service uses `System.Text.Json` with reflection-based serialization and some dynamic proxy generation for its ORM. What would you flag?

Native AOT fundamentally cannot support arbitrary runtime code generation or full reflection-based dynamic behavior, because there's no JIT present at runtime to compile newly-discovered code paths — anything the trimmer/AOT compiler can't statically determine ahead of time either fails at runtime or is trimmed away entirely, and dynamic proxy generation (common in some ORMs for lazy-loading or interception) typically depends on exactly that kind of runtime codegen. I'd flag that `System.Text.Json`'s reflection-based serialization needs to be replaced with its source-generator mode (`JsonSerializerContext`), which produces AOT-compatible, reflection-free serialization code at compile time, and that the ORM's dynamic proxy usage needs to be audited — some ORMs offer AOT-compatible modes (compiled models, no dynamic proxies) while others simply aren't AOT-ready yet, which could be a blocking dependency requiring either a library swap or reconsidering AOT for this specific service.

### Q9. What is the Common Type System (CTS) and why does it matter for cross-language interop in .NET?

The CTS is the specification that defines how types are declared, used, and managed at the runtime level, independent of any particular .NET language — it defines things like what a class, interface, value type, and delegate fundamentally are, and how they behave (inheritance rules, boxing/unboxing semantics, and so on). Because C#, F#, and VB.NET all compile down to IL that conforms to the same CTS, a class written in F# looks like an ordinary class to C# code referencing it, with no adapter layer or special interop marshaling needed — unlike calling between, say, Python and Java, which requires a bridge. This is exactly why a solution can freely mix projects in different .NET languages and reference each other directly, which is a distinguishing feature of the .NET platform worth naming explicitly when asked about multi-language support.

### Q10. Why does an assembly's metadata matter beyond just describing types for reflection?

Metadata is what allows the runtime and tooling to work with an assembly without needing separate header files or external type descriptions, unlike a native compiled binary, which typically carries no structured description of its own types. Reflection is the most visible consumer, but metadata also drives IntelliSense/tooling in the IDE, is what NuGet package references and version resolution rely on, backs serializers that inspect a type's shape, and underpins the CLR's own type-safety verification when loading an assembly (the CLR checks IL against the metadata's type signatures before running it). In short, metadata is what makes an assembly self-describing, which is foundational to nearly every higher-level .NET feature — reflection, serialization, dependency injection container scanning, and ORMs mapping types to database schemas all depend on it being present and accurate.
