# SES Sandboxing Specification for Pattern Execution

## Status: Implementation Baseline

## Authors
- AI-assisted specification

## Last Updated
2026-03-16

This document is the sole authoritative SES sandboxing specification for the
current reimplementation effort. It supersedes prior divergence notes and
branch-specific planning summaries.

---

## 1. Executive Summary

This specification describes a security architecture for sandboxing untrusted
JavaScript execution in the Common Fabric pattern runtime using
**SES (Secure ECMAScript)**. The primary goal is not to trust an authored
pattern as a unit, but to ensure that each invocation of pattern-authored
callbacks is isolated from shared mutable module state except through trusted
Common Fabric abstractions. SES Compartments reduce ambient authority and limit
blast radius, but the primary enforcement mechanism is runtime verification and
hardening of module-scope definitions at load time.

### Key Principles

1. **Invocation Isolation**: Each callback invocation must be isolated from
   any other invocation except through trusted runtime abstractions such as
   `Cell`, `lift`, `handler`, `pattern`, and `recipe`.
2. **Verified Module Load**: Every top-level module item must be classified and
   verified before it may execute or become observable.
3. **Direct Callback Builders**: `pattern`, `recipe`, `lift`, `handler`, and
   similar trusted builders must receive direct callbacks, not IIFE-produced or
   otherwise computed callables.
4. **Safe Top-Level Functions**: Standalone top-level functions are allowed
   only when they are direct functions and their captured module environment is
   reduced to immutable verified values and trusted hardened capabilities.
5. **Verified Plain Data**: Any other top-level value must be proven to be
   recursively plain data and then hardened by a custom checker/freezer.
   Computing that value via an IIFE is allowed only if the final result passes
   this verifier.
6. **Compiler Assists, Runner Enforces**: Transformers may annotate or rewrite
   code to reduce runtime parsing cost, but compiler output is not trusted and
   the runner must verify the final code boundary.
7. **Per-Pattern Compartments Provide Containment**: The runtime uses one
   Compartment per loaded pattern to limit blast radius, while verification and
   hardening remain the primary enforcement mechanisms.

---

## 2. Background

### 2.1 Current Architecture

The current execution pipeline:

```
Pattern Source (.tsx)
    ↓ ts-transformers (compile-time)
    ↓ js-compiler (TypeScript → AMD bundle)
    ↓ UnsafeEvalIsolate (direct eval())
    ↓ instantiateJavaScriptNode() → fn(argument)
```

**Security Gap**: Pattern code currently runs with full access to the JavaScript environment via `eval()`. There are no restrictions on:
- Global access
- Closure creation
- Module imports
- Side effects

### 2.2 Why SES?

SES (Secure ECMAScript) provides:
- **Frozen Intrinsics**: Built-in objects (Array, Object, etc.) are frozen
- **Compartments**: Isolated module graphs with controlled globals
- **Hardened APIs**: `harden()` to deeply freeze object graphs
- **Import Hooks**: Control over module resolution and loading

`harden()` is necessary but not sufficient for this threat model. It preserves
behavioral objects as-is, including functions and objects with hidden
mutability. This spec therefore requires an additional runtime plain-data
checker/freezer for top-level non-function values.

Alternative considered: QuickJS (via `js-sandbox` package). SES is preferred because:
- Runs in the same V8/SpiderMonkey engine (no serialization overhead)
- Same JavaScript semantics (no edge cases)
- Can share frozen objects between Compartments without copying
- Better debugging experience (same DevTools)

### 2.3 Trust Model

Patterns are treated as untrusted code and may attempt to collude with
themselves across callbacks or invocations to route around the intended data
flow controls provided by trusted runtime abstractions.

The primary trust boundary is therefore:

- the verified set of module-scope bindings that survive module load
- the trusted builder/runtime capabilities injected by the platform
- the individual invocation of a verified callback

The following are **not** trusted:

- pattern source code
- compiled JavaScript output
- transformer or compiler rewrites
- arbitrary top-level closures or objects, even if later frozen

Compartments are still valuable, but as containment and ambient-authority
reduction rather than as the sole or primary trust boundary.

---

## 3. Architecture Overview

### 3.1 High-Level Flow

```
Pattern Source (.tsx)
    ↓
[1] ts-transformers (enhanced)
    - Hoist lift/handler to module scope (when external references exist)
    - Rewrite inline derive → lift call
    - Emit optional verification hints for top-level items
    ↓
[2] js-compiler (existing)
    - TypeScript → AMD bundle with per-module AMD factories intact
    ↓
[3] Runtime Verifier (TCB)
    - Inspect each AMD module factory before execution
    - Require direct callbacks for trusted builders
    - Permit direct top-level functions only
    - Route all other top-level values through plain-data verification
    - Reject anything else
    ↓
[4] SES Execution
    - Execute verified module factories in one Compartment per loaded pattern
    - Freeze verified top-level functions and exports
    - Expose only approved callable/data exports
    ↓
[5] Runner (modified)
    - Call frozen .implementation directly
    - No eval() per invocation
```

### 3.2 Compartment Lifecycle

```
┌─────────────────────────────────────────────────────────────┐
│ Root Compartment (lockdown applied)                         │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ Pattern Compartment (one per loaded pattern)          │  │
│  │                                                       │  │
│  │  Globals: trusted runtime capabilities + SES          │  │
│  │  intrinsics                                            │  │
│  │                                                       │  │
│  │  Module Exports (frozen):                            │  │
│  │  - MyPattern: { implementation: fn, patternId: ... } │  │
│  │  - myLift: { implementation: fn, ... }               │  │
│  │  - myHandler: { implementation: fn, ... }            │  │
│  │                                                       │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ String Eval Compartment (per-string, fresh each time) │  │
│  │                                                       │  │
│  │  Used for: inline strings that couldn't be hoisted   │  │
│  │  Created fresh each invocation to prevent closures   │  │
│  │                                                       │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ Dynamic Import Compartment (per-import, fresh)        │  │
│  │  TODO: not yet wired up — see Section 6              │  │
│  │                                                       │  │
│  │  Used for: await import("https://esm.sh/lodash")     │  │
│  │  Fresh instance each time to prevent state leakage   │  │
│  │                                                       │  │
│  └──────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

The primary enforcement mechanism is still verified module load plus hardened
exports, not the Compartment itself. The runtime nevertheless SHOULD use one
Compartment per loaded pattern as the default containment boundary, because that
reduces blast radius if verification misses something. Fresh Compartments remain
appropriate for rare string-eval fallbacks and future dynamic-import isolation.

---

## 4. Transformer Enhancements

### 4.1 Overview of Changes

The `ts-transformers` package requires the following enhancements:

| Transformation | Current Behavior | New Behavior |
|----------------|------------------|--------------|
| `computed(() => ...)` | → `derive({}, () => ...)` | → call to module-scope `lift` (when external refs exist) |
| `action(() => ...)` | → `handler((_, {}) => ...)({})` | → call to module-scope `handler` (when external refs exist) |
| inline `derive(input, fn)` | kept inline | → call to module-scope `lift` (when external refs exist) |
| `lift(...)` | allowed inline | **ERROR** if not at module scope |
| `handler(...)` | allowed inline | **ERROR** if not at module scope |
| module-scope calls | minimal validation | strict allowlist enforcement |

### 4.2 Module-Scope Verification Rules

At module scope, every surviving binding must fall into exactly one of the
following categories:

1. Trusted builder definitions with a **direct callback**
2. Direct top-level function definitions
3. Verified plain data that is hardened before exposure
4. Type-only and import/export declarations

All surviving top-level bindings should be normalized into a small canonical
wrapper language before trusted verification. The wrappers are not trusted on
their own; they exist so the verifier can recognize a tiny emitted grammar
instead of parsing arbitrary JavaScript.

#### 4.2.1 Trusted Builder Definitions

Trusted builders may only appear at module scope when their callback is direct.
A callback is "direct" when it is:

- an inline `function` expression
- an inline arrow function that the transformer normalizes to a `function`
  expression before verification
- an identifier that resolves to a direct top-level function definition that is
  itself normalized into the canonical function wrapper form

The following are allowed:

```typescript
import { pattern, recipe, lift, handler } from "@commonfabric/common-builder";

export const MyPattern = pattern<Input, Output>((props) => {
  return { value: props.value };
});

export const MyRecipe = recipe<Input, Output>("name", (props) => {
  return { value: props.value };
});

export const myLift = lift<Input, Output>((input) => {
  return transform(input);
});

export const myHandler = handler<Event, State>((event, state) => {
  return newState;
});
```

The following are rejected:

```typescript
const makeCallback = () => (input) => transform(input);

// ❌ Callback is computed, not direct
export const badLift = lift(makeCallback());

// ❌ Callback produced by an IIFE
export const badHandler = handler((() => (event, state) => state)());
```

In canonical emitted form, trusted builder bindings should be normalized to a
single shape such as:

```javascript
const myLift = __ct_builder("lift", function (input) {
  return transform(input);
});
```

The trusted verifier must confirm both:

- the outer wrapper is the expected canonical wrapper
- the wrapped callback is syntactically a direct `function` expression, not an
  arbitrary expression that merely evaluates to a function

#### 4.2.2 Direct Top-Level Functions

Standalone top-level functions are allowed, including functions that close over
other module-level symbols, provided those captured symbols are themselves
verified immutable values or trusted hardened capabilities.

```typescript
function helperFunction(x: number): number {
  return x * 2;
}

const helper2 = (x: number): number => {
  return x * 2;
};
```

These function objects are hardened immediately after definition, but that
hardening is only safe because the verifier has already constrained the module
environment they may close over.

The transformer should normalize top-level functions to a canonical wrapped
assignment before verification, for example:

```javascript
const helperFunction = __ct_fn(function (x) {
  return x * 2;
});
```

This lets the verifier accept one function shape rather than many syntactic
variants. The verifier must still inspect the wrapped expression and confirm it
is a direct `function` expression.

#### 4.2.3 Verified Plain Data

Any top-level value that is not a trusted builder definition or direct function
must be plain data and pass a custom checker/freezer before it survives module
load. This is the only category where an IIFE is acceptable.

```typescript
const CONFIG = freezeVerifiedPlainData({
  maxItems: 100,
  labels: ["a", "b"],
});

const LOOKUP = freezeVerifiedPlainData((() => {
  return {
    open: "Open",
    closed: "Closed",
  };
})());
```

Canonical emitted form:

```javascript
const LOOKUP = __ct_data((() => {
  return {
    open: "Open",
    closed: "Closed",
  };
})());
```

The default allowed domain is:

- primitives
- arrays of allowed values
- plain object records with allowed values

The default rejected domain includes:

- functions
- `Promise`
- `Error`
- `Map` / `Set`
- `Date`
- class instances
- proxies
- platform capability objects

Module-load side effects are disallowed except for sandboxed `console` output,
which is separately controlled and treated as a debugging/observability channel
rather than a surviving state channel.

`__ct_data(...)` validates the result that survives module load, not the full
semantics of the computation that produced it. This is acceptable under the
current threat model because module-load code may only observe already-verified
module bindings and the only tolerated side effect in this context is sandboxed
console output.

#### 4.2.4 Type-Only Syntax

Type-only declarations remain allowed:

```typescript
type MyType = { name: string };
```

Import/export policy:

- static imports are allowed only from trusted runtime modules and from other
  modules in the same transformed-and-verified bundle
- external third-party static imports are rejected in v1
- exports should be normalized to simple local bindings plus explicit export
  wiring so the verifier does not need to accept the full surface of ESM export
  syntax
- non-trusted external module access is deferred to dynamic imports in v2

#### 4.2.5 Disallowed Module-Scope Forms

The following are rejected unless transformed into `freezeVerifiedPlainData(...)`
and the final result passes validation:

```typescript
// ❌ Arbitrary call result at module scope
const result = someFunction();

// ❌ Callable produced by an IIFE
const helper = (() => (x: number) => x * 2)();

// ❌ Non-builder side effect at module scope
const data = fetchData();

// ❌ Await expressions (implies side effects)
const response = await fetch(url);

// ❌ Hidden mutability survives even behind const
const state = { count: 0 };
```

#### 4.2.6 Compiler Assistance and Trusted Verification

The compiler/transformer is not in the TCB. It may assist by:

- inserting stable sentinel comments before each top-level item
- rewriting trusted builders, top-level functions, and data initializers into a
  small canonical wrapper language such as `__ct_builder(...)`, `__ct_fn(...)`,
  and `__ct_data(...)`
- rewriting candidate plain-data initializers into
  `freezeVerifiedPlainData(...)`
- hoisting inline callbacks to make direct-callback verification easier
- emitting those wrappers during compilation so source maps and stack traces
  continue to point back to authored source, rather than introducing wrappers at
  runtime

However, the runner must still verify the code that is about to execute. The
trusted verification boundary is the AMD module factory emitted by the bundler,
because it preserves per-module top-level structure better than the fully
wrapped bundle entrypoint.

The trusted verifier should be a recognizer for the canonical emitted grammar,
not a general JavaScript parser. It only needs to:

- locate top-level item boundaries using sentinel comments and balanced
  delimiter scanning
- handle strings, comments, and template literals correctly so delimiters line
  up
- confirm that each surviving top-level item matches one of the canonical
  wrapper forms or allowed import/export/type forms
- reject anything outside that mini-language

The trusted verifier does **not** need to understand arbitrary JavaScript AST
structure if the emitted grammar is kept small and canonical.

### 4.3 Hoisting Inline Transformations

Hoisting to module scope only occurs when the inline function body references
external symbols (variables from the enclosing scope). Self-contained callbacks
(where all identifiers are parameters or locally defined) remain inline — this
is the default behavior, not merely an optimization.

**Detection criteria for leaving inline (no hoisting needed):**
- No free variables (all identifiers are parameters or locally defined)
- No `this` references
- No `arguments` references
- No `eval` or `Function` calls

```typescript
// This stays inline (self-contained — no external references)
const doubled = derive(props.value, x => x * 2);

// This MUST be hoisted (references outer scope variable `multiplier`)
const doubled = derive(props.value, x => x * multiplier);
```

#### 4.3.1 Computed → Lifted Call (when external references exist)

**Before (current):**
```typescript
export const MyPattern = pattern<Input, Output>((props) => {
  const doubled = computed(() => props.value * 2);
  return { doubled };
});
```

**After transformation (current):**
```typescript
export const MyPattern = pattern<Input, Output>((props) => {
  const doubled = derive({}, () => props.value * 2);
  return { doubled };
});
```

**After transformation (new, only when external references exist):**
```typescript
// Hoisted to module scope
const __computed_1 = lift<{ value: number }, number>(
  ({ value }) => value * 2
);

export const MyPattern = pattern<Input, Output>((props) => {
  const doubled = __computed_1({ value: props.value });
  return { doubled };
});
```

#### 4.3.2 Action → Handler Call (when external references exist)

**Before (current):**
```typescript
export const MyPattern = pattern<Input, Output>((props) => {
  const doSomething = action(() => {
    props.count = props.count + 1;
  });
  return { doSomething };
});
```

**After transformation (new):**
```typescript
// Hoisted to module scope
const __action_1 = handler<void, { count: Cell<number> }>(
  (_, { count }) => {
    count.set(count.get() + 1);
  }
);

export const MyPattern = pattern<Input, Output>((props) => {
  const doSomething = __action_1({ count: props.count });
  return { doSomething };
});
```

#### 4.3.3 Inline Derive → Lifted Call (when external references exist)

**Before:**
```typescript
export const MyPattern = pattern<Input, Output>((props) => {
  const total = derive(props.items, items => items.reduce((a, b) => a + b, 0));
  return { total };
});
```

**After transformation:**
```typescript
const __derive_1 = lift<number[], number>(
  items => items.reduce((a, b) => a + b, 0)
);

export const MyPattern = pattern<Input, Output>((props) => {
  const total = __derive_1(props.items);
  return { total };
});
```

---

## 5. SES Execution Details

The runtime uses one authoritative SES execution path for compiled pattern
modules:

- verify each AMD module factory before it can execute
- execute verified modules inside one Compartment per loaded pattern
- expose only verified exported builder objects to the runner

Fresh Compartment evaluation remains available only for the rare string-based
fallback path described in Section 5.4. It is not the normal invocation path.

### 5.1 Lockdown Configuration

The runtime uses a small `SandboxConfig` surface:

```typescript
export interface SandboxConfig {
  enabled: boolean;
  debug: boolean;
  console?: Console;
}
```

Default config:

```typescript
function getDefaultSandboxConfig(): SandboxConfig {
  return {
    enabled: true,
    debug: false,
  };
}
```

Lockdown options are derived from `debug`:

```typescript
lockdown({
  errorTaming: debug ? "unsafe" : "safe",
  stackFiltering: debug ? "verbose" : "concise",
  overrideTaming: "severe",
  consoleTaming: "unsafe",
});
```

Notes:

- `overrideTaming: "severe"` remains the compatibility default.
- `mathTaming` and `dateTaming` should not be relied on as policy knobs in the
  reimplementation. In newer SES releases those options are gone; time and
  randomness should instead be controlled through explicit runtime helpers such
  as `Temporal`, `secureRandom`, and `randomUUID`.

### 5.2 Compiled Bundle Evaluation

The AMD bundler emits a bundle whose evaluation result is a function expecting
runtime dependencies:

```typescript
type CompiledBundleEntrypoint = (
  runtimeDeps?: Record<string, unknown>,
) => {
  main: Record<string, unknown>;
  exportMap: Record<string, Record<string, unknown>>;
};
```

The verified runtime path evaluates that bundle inside the pattern's
Compartment:

```typescript
const entrypoint = patternCompartment.evaluate(compiledBundle);
const result = entrypoint(runtimeGlobals);
```

Important details:

- the bundle itself stays in AMD form until execution
- runtime capability injection happens explicitly through `runtimeGlobals`
- the verifier runs at the AMD module factory boundary before any factory may be
  required or executed
- the harness uses the resulting `exportMap` to associate exported runtime
  values with their source `RuntimeProgram`
- the runtime preserves the existing bundle ABI unless there is a deliberate
  compiler change
- only verified exported builder objects are cached for later invocation

For any cached export-based execution path, the minimal runtime-facing metadata
shape can stay small:

```typescript
interface FrozenExport {
  readonly name: string;
  readonly implementation: unknown;
  readonly patternId: string;
}

interface PatternCompartment {
  readonly patternId: string;
  readonly exports: Map<string, FrozenExport>;
  getExport(name: string): FrozenExport | undefined;
}
```

Source maps, source files, and display metadata belong in the error-mapping
layer rather than on every `PatternCompartment`.

### 5.3 Runtime Globals Provider

Globals are built from `createBuilder()` plus a sandboxed console, and hardened
before injection where appropriate.

The categories are:

- builder entrypoints: `recipe`, `pattern`, `patternTool`, `lift`, `handler`,
  `action`, `derive`, `computed`
- cell constructors and helpers: `Cell`, `Writable`, `OpaqueCell`, `Stream`,
  `ComparableCell`, `ReadonlyCell`, `WriteonlyCell`, `cell`, `equals`
- built-ins: `str`, `ifElse`, `when`, `unless`, `llm`, `llmDialog`,
  `generateObject`, `generateText`, `fetchData`, `fetchProgram`, `streamData`,
  `compileAndRun`, `navigateTo`, `wish`
- utilities: `byRef`, `getRecipeEnvironment`, `getEntityId`
- constants: `ID`, `ID_FIELD`, `SELF`, `TYPE`, `NAME`, `UI`
- schema/render helpers: `schema`, `toSchema`, `AuthSchema`, `h`
- console and SES helpers: sandboxed `console`, `harden`
- explicit runtime replacements: `Temporal`, `secureRandom`, `randomUUID`
- network escape hatch: `fetch` with a deprecation warning

Representative shape:

```typescript
export interface RuntimeGlobals {
  readonly recipe: unknown;
  readonly pattern: unknown;
  readonly patternTool: unknown;
  readonly lift: unknown;
  readonly handler: unknown;
  readonly action: unknown;
  readonly derive: unknown;
  readonly computed: unknown;
  readonly Cell: unknown;
  readonly Writable: unknown;
  readonly OpaqueCell: unknown;
  readonly Stream: unknown;
  readonly ComparableCell: unknown;
  readonly ReadonlyCell: unknown;
  readonly WriteonlyCell: unknown;
  readonly cell: unknown;
  readonly equals: unknown;
  readonly str: unknown;
  readonly ifElse: unknown;
  readonly when: unknown;
  readonly unless: unknown;
  readonly llm: unknown;
  readonly llmDialog: unknown;
  readonly generateObject: unknown;
  readonly generateText: unknown;
  readonly fetchData: unknown;
  readonly fetchProgram: unknown;
  readonly streamData: unknown;
  readonly compileAndRun: unknown;
  readonly navigateTo: unknown;
  readonly wish: unknown;
  readonly byRef: unknown;
  readonly getRecipeEnvironment: unknown;
  readonly getEntityId: unknown;
  readonly ID: unknown;
  readonly ID_FIELD: unknown;
  readonly SELF: unknown;
  readonly TYPE: unknown;
  readonly NAME: unknown;
  readonly UI: unknown;
  readonly schema: unknown;
  readonly toSchema: unknown;
  readonly AuthSchema: unknown;
  readonly h: unknown;
  readonly console: Console;
  readonly Temporal: typeof Temporal;
  readonly secureRandom: () => number;
  readonly randomUUID: () => string;
  readonly fetch: typeof fetch;
  readonly harden: <T>(obj: T) => T;
}
```

Implementation notes worth preserving:

- almost all injected Common Tools capabilities are explicitly hardened
- `fetch` should warn and steer authors toward `fetchData()`
- `secureRandom()` returns a `Math.random()`-like number using
  `crypto.getRandomValues`
- `randomUUID()` provides a stable replacement for direct crypto access
- `createMinimalGlobals()` is useful for narrow evaluation cases that only need
  `console` and `harden`

### 5.4 String Evaluation

For ad hoc string evaluation, the runtime uses a fresh Compartment after
lockdown and evaluates code directly:

```typescript
function evaluateStringSync(code: string, globals: Record<string, unknown>): unknown {
  const compartment = new Compartment(harden(globals), {}, {
    name: "<eval>",
    __noNamespaceBox__: true,
  });
  return compartment.evaluate(code);
}
```

Two details matter:

- the string-eval path should use a fresh Compartment
- `evaluateStringSync()` evaluates the provided code directly; the IIFE wrapper
  pattern is for wrapped module/bundle sources, not a requirement of the
  string-eval helper itself
- this helper is a legacy escape hatch for cases that cannot be represented as
  verified cached exports; it must not become the default execution path

---

## 6. Dynamic Import Support (esm.sh)

> **TODO**: Import hooks exist in `packages/runner/src/sandbox/import-hooks.ts`
> with full implementation (including `ESMCache`, `createResolveHook`, and
> `createImportHook`) but are not yet wired into the Compartment creation path.
> This section describes the intended design for future work.

### 6.1 Requirements

Patterns may use dynamic imports from esm.sh:

```typescript
export const MyPattern = pattern<Input, Output>(async (props) => {
  const lodash = await import("https://esm.sh/lodash@4.17.21");
  return { result: lodash.capitalize(props.text) };
});
```

**Security requirements:**
1. Each import gets a fresh module instance (no state leakage between invocations)
2. Downloaded code is cached (network efficiency)
3. Module graph is isolated per invocation

### 6.2 Import Hooks

SES Compartments support import hooks for dynamic imports:

```typescript
interface ImportHooks {
  resolveHook: (specifier: string, referrer: string) => string;
  importHook: (moduleSpecifier: string) => Promise<StaticModuleRecord>;
}

const esmCache = new Map<string, string>();  // URL → source code

async function createDynamicImportCompartment(): Promise<Compartment> {
  let invocationId = 0;

  const compartment = new Compartment({
    // ... globals ...
  }, {}, {
    resolveHook(specifier: string, referrer: string): string {
      // Return a unique specifier each time to force fresh instantiation
      if (specifier.startsWith('https://esm.sh/')) {
        invocationId++;
        return `${specifier}#__invocation_${invocationId}`;
      }
      // Standard resolution for internal modules
      return new URL(specifier, referrer).href;
    },

    async importHook(moduleSpecifier: string): Promise<StaticModuleRecord> {
      // Strip invocation suffix for caching
      const url = moduleSpecifier.split('#')[0];

      // Check cache
      let source = esmCache.get(url);
      if (!source) {
        // Fetch and cache
        const response = await fetch(url);
        source = await response.text();
        esmCache.set(url, source);
      }

      // Return as StaticModuleRecord (SES will create fresh instance)
      return new StaticModuleRecord(source, moduleSpecifier);
    },
  });

  return compartment;
}
```

### 6.3 Pre-fetching Optimization (Future)

The transformer can analyze dynamic imports and emit prefetch hints:

```typescript
// Transformer output (metadata)
{
  dynamicImports: [
    "https://esm.sh/lodash@4.17.21",
    "https://esm.sh/date-fns@2.30.0"
  ]
}

// Runner pre-fetch before first invocation
async function prefetchDynamicImports(imports: string[]): Promise<void> {
  await Promise.all(imports.map(async (url) => {
    if (!esmCache.has(url)) {
      const response = await fetch(url);
      esmCache.set(url, await response.text());
    }
  }));
}
```

---

## 7. Closure Prevention Strategy

### 7.1 The Closure Problem

Closures can capture references to user data, leaking it between invocations:

```typescript
// DANGEROUS: Closure captures `userData`
let userData: any;

export const BadPattern = pattern((props) => {
  userData = props.secretData;  // Captured!

  return {
    leak: () => userData  // Later invocation can access previous user's data!
  };
});
```

### 7.2 Prevention Mechanisms

#### 7.2.1 No Module-Scope Mutations

The verifier enforces that surviving module-scope bindings:
- Are only assigned at declaration time
- Are never reassigned
- Are const (not let/var)
- Are either trusted direct functions or verified plain data

```typescript
// ❌ REJECTED: let at module scope
let counter = 0;

// ❌ REJECTED: Hidden mutability behind const
const config = {};
config.key = "value";

// ✅ ALLOWED: verified plain data
const CONFIG = freezeVerifiedPlainData({ key: "value" });
```

#### 7.2.2 Pattern/Recipe Inner Functions Run at Load Time

When `pattern()` or `recipe()` is called, the inner function executes immediately:

```typescript
export const MyPattern = pattern((props) => {
  // This code runs at LOAD TIME, not invocation time
  // At load time, `props` is a schema placeholder, not user data
  return { ui: <div>{props.name}</div> };
});
```

At load time:
- `props` is a reactive schema placeholder
- No actual user data is available
- The return value defines the reactive graph

At invocation time:
- The reactive graph is already frozen
- User data flows through the frozen graph
- No new closures are created

#### 7.2.3 Function Hardening Is Necessary but Not Sufficient

All approved top-level functions and builder implementations are frozen after
load, but freezing the function object alone is not enough:

```typescript
const fn = (() => {
  let counter = 0;
  return () => ++counter;
})();
harden(fn);
```

The function object above is frozen, but its closed-over lexical state is still
mutable shared state. Therefore, this spec requires both:

- function hardening after definition
- verification that any captured module-level bindings are themselves safe
  immutable values or trusted hardened capabilities

Safe example:

```typescript
const TABLE = freezeVerifiedPlainData({ a: 1, b: [2, 3] });

function helper(x: number) {
  return TABLE.a + x;
}
harden(helper);
```

#### 7.2.4 Custom Plain-Data Checker/Freezer

This spec introduces a runtime helper dedicated to non-function top-level
values:

```typescript
type PlainData =
  | null
  | undefined
  | boolean
  | number
  | string
  | PlainData[]
  | { [key: string]: PlainData };

function assertPlainData(value: unknown, path = "<root>"): asserts value is PlainData;

function freezeVerifiedPlainData<T>(value: T): T {
  assertPlainData(value);
  return harden(value);
}
```

The verifier may allow a top-level expression to compute data in any way it
likes, including via an IIFE, but only if the value that escapes module load
passes `assertPlainData()` and is then hardened.

#### 7.2.5 Fresh Compartments for Strings

For any code evaluated at runtime (string implementations), a fresh Compartment ensures no closure state persists:

```typescript
// Each invocation gets a fresh Compartment
invocation1: Compartment1 evaluates code → result1
invocation2: Compartment2 evaluates code → result2
// Compartment1 is garbage collected, no state shared
```

---

## 8. Error Handling and Source Map Integration

Debugging sandboxed code presents unique challenges. This section details how to maintain a good developer experience while running code in SES Compartments.

### 8.1 SES Error Taming Options

SES provides configurable "taming" for error objects that controls the security/debuggability trade-off:

#### Safe Mode (`errorTaming: 'safe'`)

```javascript
// Stack traces are sanitized
Error: Something went wrong
    at <anonymous>
    at <anonymous>
    at <anonymous>
```

- File paths, line numbers, and column numbers are hidden
- Prevents attackers from probing system structure via errors
- Error messages may be genericized
- **Use case**: Production with untrusted third-party patterns

#### Unsafe Mode (`errorTaming: 'unsafe'`)

```javascript
// Full stack traces preserved
TypeError: Cannot read property 'map' of undefined
    at myLift (/patterns/MyPattern.tsx:42:15)
    at invokePattern (runner.ts:1254:12)
    at SandboxedRunner.invoke (ses-runtime.ts:89:5)
```

- Real file names and line numbers
- Original error messages intact
- Better debugging experience
- **Use case**: Development, or production with trusted patterns

### 8.2 The Source Map Challenge

Even with `errorTaming: 'unsafe'`, stack traces point to **compiled/transformed code**, not original source:

```
Original TypeScript (MyPattern.tsx)
        ↓
    [ts-transformers]  ← Hoisting changes line numbers
        ↓
    [js-compiler]      ← TypeScript → JavaScript
        ↓
    [AMD bundling]     ← Wraps in AMD loader
        ↓
Executed in Compartment
```

#### Example: Line Number Mismatch

**Original source (MyPattern.tsx:23):**
```typescript
export const MyPattern = pattern((props) => {
  const doubled = computed(() => props.value.map(x => x * 2));  // Line 23
  return { doubled };
});
```

**After transformation (compiled.js:5, 47):**
```javascript
// Hoisted to line 5
const __computed_1 = lift(({ value }) => value.map(x => x * 2));

// Original location now at line 47
export const MyPattern = pattern((props) => {
  const doubled = __computed_1({ value: props.value });
  return { doubled };
});
```

**Error without source mapping:**
```
TypeError: Cannot read property 'map' of undefined
    at __computed_1 (eval:5:45)  // Points to compiled code!
```

**Error with source mapping:**
```
TypeError: Cannot read property 'map' of undefined
    at computed callback (MyPattern.tsx:23:42)  // Points to original!
    └─ (hoisted to __computed_1)
```

### 8.3 Source Map Preservation Strategy

#### 8.3.1 Compilation Pipeline Source Maps

Each stage produces and consumes source maps:

```
┌─────────────────────────────────────────────────────────────┐
│ Original Source                                              │
│ MyPattern.tsx                                                │
└─────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│ ts-transformers                                              │
│ Input:  MyPattern.tsx                                        │
│ Output: MyPattern.transformed.tsx + sourceMap1               │
│                                                              │
│ sourceMap1: transformed line 5 → original line 23           │
└─────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│ js-compiler (TypeScript)                                     │
│ Input:  MyPattern.transformed.tsx + sourceMap1               │
│ Output: MyPattern.js + sourceMap2                            │
│                                                              │
│ sourceMap2: JS line N → transformed line M                   │
│ (TypeScript compiler can chain source maps)                  │
└─────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│ AMD Bundler                                                  │
│ Input:  MyPattern.js + sourceMap2                            │
│ Output: bundle.js + sourceMap3 (merged)                      │
│                                                              │
│ sourceMap3: bundle line P → original line Q                  │
│ (Merged/chained through all stages)                          │
└─────────────────────────────────────────────────────────────┘
```

#### 8.3.2 Transformer Source Map Generation

The hoisting transformer must generate accurate source maps:

```typescript
// packages/ts-transformers/src/hoisting.ts

class HoistingTransformer {
  private sourceMapGenerator: SourceMapGenerator;

  visitComputedCall(node: ts.CallExpression): ts.Expression {
    const originalPos = this.sourceFile.getLineAndCharacterOfPosition(
      node.getStart()
    );

    const hoistedName = `__computed_${this.counter++}`;

    // Record mapping: hoisted location → original location
    this.sourceMapGenerator.addMapping({
      generated: { line: this.hoistedLineNumber, column: 0 },
      original: { line: originalPos.line + 1, column: originalPos.character },
      source: this.sourceFile.fileName,
      name: hoistedName,
    });

    // ... create hoisted node ...
  }
}
```

#### 8.3.3 js-compiler Source Map Chaining

The existing js-compiler already supports source maps. Ensure chaining:

```typescript
// packages/js-compiler/typescript/compiler.ts

const compilerOptions: ts.CompilerOptions = {
  // ... existing options ...
  sourceMap: true,
  inlineSources: true,  // Include original source in map
  inlineSourceMap: false,  // Keep separate for chaining
};

// When transformer provides input source map, chain them
if (inputSourceMap) {
  // Use source-map library to merge
  const merged = await mergeSourceMaps(inputSourceMap, outputSourceMap);
  return { js, sourceMap: merged };
}
```

### 8.4 Error Mapping Implementation

#### 8.4.1 ErrorMapper Lifecycle

Error mapping is synchronous and centered on
`@commontools/js-compiler`'s `SourceMapParser`:

```typescript
class ErrorMapper {
  private readonly sourceMapParser = new SourceMapParser();
  private readonly debug: boolean;

  constructor(debug = false) {
    this.debug = debug;
  }

  loadSourceMap(filename: string, sourceMap: SourceMap): void { ... }
  mapError(error: Error, options: ErrorMappingOptions = {}): MappedError { ... }
  mapPosition(filename: string, line: number, column: number): MappedPosition | null { ... }
  parseStack(stack: string): string { ... }
  clear(): void { ... }
}
```

- mapping is synchronous
- source maps are loaded by filename into the mapper, not required to live on
  every `PatternCompartment`
- the same mapper also supports direct `parseStack()` and `mapPosition()` calls

#### 8.4.2 ErrorMappingOptions and MappedError

```typescript
interface ErrorMappingOptions {
  readonly debug?: boolean;
  readonly patternId?: string;
  readonly sourceMap?: SourceMap;
  readonly filename?: string;
}

interface MappedError {
  readonly originalError: Error;
  readonly mappedStack: string;
  readonly frames: readonly ClassifiedFrame[];
  readonly patternLocation?: SourceLocation;
  readonly userMessage: string;
}
```

Required behavior:

- if `filename` and `sourceMap` are present, the mapper loads that map before
  parsing the stack
- `mappedStack` is the formatted post-classification stack shown to users or
  logs
- `patternLocation` comes from the first `pattern` frame after classification
- `userMessage` is preformatted so callers do not need to rebuild a concise
  display string

The convenience entrypoint remains synchronous:

```typescript
function mapError(
  error: Error,
  options: ErrorMappingOptions = {},
): MappedError {
  return new ErrorMapper(options.debug).mapError(error, options);
}
```

#### 8.4.3 Execution Wrappers

Execution wrappers are required for both sync and async pattern callbacks:

```typescript
interface ExecutionWrapperOptions {
  readonly patternId: string;
  readonly functionName?: string;
  readonly includeStack?: boolean;
  readonly debug?: boolean;
}

class PatternExecutionError extends Error {
  readonly patternId: string;
  readonly functionName?: string;
  readonly originalError: Error;
  readonly sourceLocation?: SourceLocation;

  toUserMessage(): string { ... }
}

function wrapExecution<T extends (...args: any[]) => any>(
  fn: T,
  options: ExecutionWrapperOptions,
): WrappedFunction<T> { ... }

function wrapAsyncExecution<T extends (...args: any[]) => Promise<any>>(
  fn: T,
  options: ExecutionWrapperOptions,
): WrappedFunction<T> { ... }
```

Required behavior:

- preserve `SandboxSecurityError` unchanged
- wrap all other thrown values in `PatternExecutionError`
- attach `patternId`, optional `functionName`, and best-effort `sourceLocation`
- include the original stack in debug mode
- expose `isPatternExecutionError()` and `getErrorMessage()` helpers for
  downstream callers

### 8.5 Debugging Experience

#### 8.5.1 Console Output

With proper error mapping, developers see:

```
TypeError: Cannot read property 'map' of undefined

    at computed callback (MyPattern.tsx:23:42)
       └─ (originally: computed callback)
    at MyPattern (MyPattern.tsx:22:3)
    at SandboxedRunner.invoke (ses-runtime.ts:89:5)

Pattern: my-pattern-id
Export: MyPattern

Original source (MyPattern.tsx:23):
  22 │ export const MyPattern = pattern((props) => {
> 23 │   const doubled = computed(() => props.value.map(x => x * 2));
     │                                          ^^^
  24 │   return { doubled };
```

#### 8.5.2 Enhanced Error Display

```typescript
// packages/runner/src/sandbox/error-display.ts

interface ErrorDisplayOptions {
  readonly verbose?: boolean;
  readonly colors?: boolean;
  readonly maxFrames?: number;
  readonly showFrameTypes?: boolean;
}

function formatError(
  mappedError: MappedError,
  options: ErrorDisplayOptions = {},
): string { ... }

function formatErrorForConsole(mappedError: MappedError): string { ... }
function formatErrorForLog(mappedError: MappedError): string { ... }
function formatUserMessage(mappedError: MappedError): string { ... }

interface ErrorReport {
  readonly message: string;
  readonly name: string;
  readonly patternId?: string;
  readonly location?: {
    readonly file: string;
    readonly line: number;
    readonly column: number;
  };
  readonly stack: string;
  readonly frameSummary: {
    readonly total: number;
    readonly pattern: number;
    readonly runtime: number;
    readonly external: number;
    readonly ses: number;
  };
}

function createErrorReport(
  mappedError: MappedError,
  patternId?: string,
): ErrorReport { ... }
```

### 8.6 Layered Stack Trace Filtering

The key insight is that **pattern authors and runtime developers have different needs**:

- **Pattern authors** need to see their code, but runtime internals are noise
- **Runtime developers** need to see everything when debugging the runtime itself

#### 8.6.1 Frame Classification

```typescript
// packages/runner/src/sandbox/frame-classifier.ts

type FrameType = "pattern" | "runtime" | "external" | "ses";

interface ClassifiedFrame {
  readonly original: string;
  readonly type: FrameType;
  readonly functionName?: string;
  readonly file?: string;
  readonly line?: number;
  readonly column?: number;
  readonly isMapped: boolean;
}

const RUNTIME_PATTERNS = [
  /\/runner\/src\//,
  /\/harness\//,
  /\/scheduler\//,
  /AMDLoader/,
  /<CT_INTERNAL>/,
  /\beval\b/,
];

const SES_PATTERNS = [
  /\/ses\//,
  /Compartment/,
  /lockdown/,
  /harden/,
  /@endo\//,
];

const EXTERNAL_PATTERNS = [
  /node_modules/,
  /npm:/,
  /esm\.sh/,
  /deno\.land/,
  /jsr\.io/,
];
```

In non-debug mode, filtering behavior should match the implementation:

- include all `pattern` frames
- include `external` frames
- include `runtime` frames only until the first `pattern` frame, to preserve
  call-site context
- exclude `ses` frames and later runtime-internal noise

#### 8.6.2 Filtered Stack Trace Output

**For Pattern Authors (default):**

```
TypeError: Cannot read property 'map' of undefined

    at computed callback (MyPattern.tsx:23:42)
       └─ props.value is undefined
    at MyPattern (MyPattern.tsx:22:3)
    ... 3 runtime frames hidden (use --debug for full trace)

Pattern: my-pattern-id

Original source (MyPattern.tsx:23):
  22 │ export const MyPattern = pattern((props) => {
> 23 │   const doubled = computed(() => props.value.map(x => x * 2));
     │                                          ^^^
  24 │   return { doubled };
```

**For Runtime Developers (debug mode):**

```
TypeError: Cannot read property 'map' of undefined

    at computed callback (MyPattern.tsx:23:42)
       └─ props.value is undefined
    at MyPattern (MyPattern.tsx:22:3)
    ─── runtime frames ───
    at FrozenExport.implementation (ses-runtime.ts:89:5)
    at SandboxedRunner.invoke (runner.ts:1254:12)
    at executeWithErrorMapping (execution-wrapper.ts:15:12)
    at instantiateJavaScriptNode (runner.ts:1174:8)
    ─── end runtime frames ───

Pattern: my-pattern-id
```

#### 8.6.3 Implementation

```typescript
// packages/runner/src/sandbox/stack-filter.ts

interface StackFilterOptions {
  showRuntimeFrames: boolean;  // false for pattern authors, true for runtime devs
  showExternalFrames: boolean; // usually true
  showSESFrames: boolean;      // usually false
  maxPatternFrames: number;    // limit depth, default unlimited
}

const DEFAULT_OPTIONS: StackFilterOptions = {
  showRuntimeFrames: false,
  showExternalFrames: true,
  showSESFrames: false,
  maxPatternFrames: Infinity,
};

export function filterStack(
  frames: ClassifiedFrame[],
  options: StackFilterOptions = DEFAULT_OPTIONS
): { visibleFrames: ClassifiedFrame[]; hiddenCount: number } {
  const visibleFrames: ClassifiedFrame[] = [];
  let hiddenCount = 0;
  let patternFrameCount = 0;

  for (const frame of frames) {
    switch (frame.frameType) {
      case 'pattern':
        if (patternFrameCount < options.maxPatternFrames) {
          visibleFrames.push(frame);
          patternFrameCount++;
        } else {
          hiddenCount++;
        }
        break;

      case 'runtime':
        if (options.showRuntimeFrames) {
          visibleFrames.push(frame);
        } else {
          hiddenCount++;
        }
        break;

      case 'ses':
        if (options.showSESFrames) {
          visibleFrames.push(frame);
        } else {
          hiddenCount++;
        }
        break;

      case 'external':
        if (options.showExternalFrames) {
          visibleFrames.push(frame);
        } else {
          hiddenCount++;
        }
        break;
    }
  }

  return { visibleFrames, hiddenCount };
}

export function formatFilteredStack(
  frames: ClassifiedFrame[],
  options: StackFilterOptions
): string {
  const { visibleFrames, hiddenCount } = filterStack(frames, options);

  const lines: string[] = [];
  let inRuntimeSection = false;

  for (const frame of visibleFrames) {
    // Add section markers for runtime frames in debug mode
    if (options.showRuntimeFrames) {
      if (frame.type === 'runtime' && !inRuntimeSection) {
        lines.push('    ─── runtime frames ───');
        inRuntimeSection = true;
      } else if (frame.type !== 'runtime' && inRuntimeSection) {
        lines.push('    ─── end runtime frames ───');
        inRuntimeSection = false;
      }
    }

    lines.push(formatFrame(frame));
  }

  if (inRuntimeSection) {
    lines.push('    ─── end runtime frames ───');
  }

  if (hiddenCount > 0 && !options.showRuntimeFrames) {
    lines.push(`    ... ${hiddenCount} runtime frames hidden (use --debug for full trace)`);
  }

  return lines.join('\n');
}
```

#### 8.6.4 Sandbox Configuration

```typescript
// packages/runner/src/sandbox/types.ts

export interface SandboxConfig {
  enabled: boolean;
  debug: boolean;
  console?: Console;
}
```

The `debug` field controls both lockdown configuration (see Section 5.1) and
stack trace verbosity. When `debug` is true, full stack traces including runtime
and SES frames are shown.

### 8.7 Configuration Summary

| Audience | `debug` | Runtime Frames | Source Context |
|----------|---------|----------------|----------------|
| Pattern Author | `false` | Hidden | Pattern source shown |
| Runtime Developer | `true` | Visible (marked) | All source shown |
| Production (logging) | `false` | Hidden | Included in logs |

### 8.8 Implementation Checklist

| Task | Priority | Files |
|------|----------|-------|
| Transformer source map generation | High | `ts-transformers/src/hoisting.ts` |
| Source map chaining in js-compiler | High | `js-compiler/typescript/compiler.ts` |
| ErrorMapper source-map lifecycle | High | `runner/src/sandbox/error-mapping.ts` |
| Error mapping utility | High | `runner/src/sandbox/error-mapping.ts` |
| Execution wrapper with mapping | High | `runner/src/sandbox/execution-wrapper.ts` |
| Frame classification and filtering | High | `runner/src/sandbox/frame-classifier.ts` |
| Enhanced error display | Medium | `runner/src/sandbox/error-display.ts` |
| Structured error report formatting | Medium | `runner/src/sandbox/error-display.ts` |
| Configuration options | Low | `runner/src/sandbox/types.ts` |

---

## 9. Implementation Workstreams

### Phase 1: Non-TCB Compiler Assistance

#### 1.1 Emit top-level classification hints (Priority: High)

The transformer should help the runtime verifier without becoming trusted.
Examples:

- insert stable sentinel comments before each top-level item
- normalize trusted builders into canonical forms such as
  `__ct_builder("lift", function ...)`
- normalize top-level functions into canonical forms such as
  `__ct_fn(function ...)`
- normalize data bindings into canonical forms such as
  `__ct_data(expr)`
- rewrite plain-data candidates into `freezeVerifiedPlainData(...)` within the
  canonical data wrapper
- normalize export syntax to simple local bindings plus explicit export wiring

These hints are performance aids only. The runner must be able to reject the
module even if the hints are wrong or missing.

**Files to modify:**
- `packages/ts-transformers/src/transformers/module-scope-validation.ts`
- `packages/ts-transformers/src/hoisting/*`
- compiler pipeline entrypoints that preserve the hints into emitted JS

#### 1.2 Hoist computed/action/derive when useful (Priority: High)

Continue to hoist inline callbacks when external references exist, because that
reduces the complexity of runtime direct-callback verification.

### Phase 2: Trusted Runtime Verification at the AMD Module Boundary

#### 2.1 Verify module factories before execution (Priority: High)

The trusted verifier should operate on each AMD module factory, not only on the
fully wrapped bundle entrypoint. This preserves per-module top-level structure
and avoids trusting compiler rewrites.

The verifier must check:

- trusted builders receive direct callbacks only
- top-level functions are direct functions only
- all other surviving top-level values are plain data and hardened
- no unclassified top-level side effects survive

The verifier should be implemented as a minimal recognizer for the canonical
emitted wrapper grammar, not as a full JavaScript parser. The TCB scanner only
needs to:

- follow balanced `()`, `{}`, and `[]`
- correctly skip over strings, comments, and template literals
- split the factory body into top-level items
- match those items against the small set of canonical wrapper forms

If the output deviates from the canonical wrapper language, the verifier should
fail closed.

**Likely files:**
- `packages/js-compiler/typescript/bundler/amd-loader.ts`
- `packages/runner/src/harness/engine.ts`
- new `packages/runner/src/sandbox/module-verifier.ts`

#### 2.2 Add custom plain-data checker/freezer (Priority: High)

Implement a runtime helper that proves a value is recursively plain data and
then hardens it. This helper is stricter than `harden()` alone and stricter
than Endo pass-style checks.

**Likely files:**
- new `packages/runner/src/sandbox/plain-data.ts`
- `packages/runner/src/sandbox/mod.ts`
- tests under `packages/runner/test/sandbox/`

#### 2.3 Harden approved functions immediately after load (Priority: High)

Direct top-level functions and trusted builder implementations must be hardened
as soon as they are created, but only after the verifier has constrained the
environment they may close over.

#### 2.4 Enforce import policy at verification time (Priority: High)

The verifier should explicitly distinguish:

- trusted static imports from runtime modules
- static imports from other transformed-and-verified local modules
- all other static imports, which are rejected in v1

External imports beyond the trusted runtime set should remain a v2 dynamic
import concern rather than a v1 load-time feature.

### Phase 3: SES Execution Path

#### 3.1 Implement one live runtime path (Priority: High)

Eliminate the split between parallel SES implementations. The runtime must have
one authoritative verified SES execution path.

#### 3.2 Use one Compartment per pattern while keeping verification primary (Priority: High)

The runtime should execute each loaded pattern in its own Compartment. That
Compartment is a containment boundary, not the primary mechanism that prevents
callback collusion. Fresh Compartments are still appropriate for string-eval
fallbacks and future dynamic-import isolation.

#### 3.3 Runtime globals and lockdown policy (Priority: Medium)

Keep the runtime globals surface explicit and hardened. Temporary relaxations
(`fetch`, `Date`, `Math.random`) remain separate migration decisions.

#### 3.4 Runtime Globals Provider

The runtime provides a comprehensive set of globals to pattern Compartments.
These are injected directly as Compartment globals (not via module maps):

```typescript
// packages/runner/src/sandbox/runtime-globals.ts

export function createRuntimeGlobals(
  patternId: string,
  customConsole?: Console,
): RuntimeGlobals {
  const { commontools } = createBuilder();
  const sandboxedConsole = customConsole ?? createSandboxedConsole({ patternId });

  return {
    recipe: harden(commontools.recipe),
    pattern: harden(commontools.pattern),
    patternTool: harden(commontools.patternTool),
    lift: harden(commontools.lift),
    handler: harden(commontools.handler),
    action: harden(commontools.action),
    derive: harden(commontools.derive),
    computed: harden(commontools.computed),
    Cell: harden(commontools.Cell),
    Writable: harden(commontools.Writable),
    OpaqueCell: harden(commontools.OpaqueCell),
    Stream: harden(commontools.Stream),
    ComparableCell: harden(commontools.ComparableCell),
    ReadonlyCell: harden(commontools.ReadonlyCell),
    WriteonlyCell: harden(commontools.WriteonlyCell),
    cell: harden(commontools.cell),
    equals: harden(commontools.equals),
    str: harden(commontools.str),
    ifElse: harden(commontools.ifElse),
    when: harden(commontools.when),
    unless: harden(commontools.unless),
    llm: harden(commontools.llm),
    llmDialog: harden(commontools.llmDialog),
    generateObject: harden(commontools.generateObject),
    generateText: harden(commontools.generateText),
    fetchData: harden(commontools.fetchData),
    fetchProgram: harden(commontools.fetchProgram),
    streamData: harden(commontools.streamData),
    compileAndRun: harden(commontools.compileAndRun),
    navigateTo: harden(commontools.navigateTo),
    wish: harden(commontools.wish),
    byRef: harden(commontools.byRef),
    getRecipeEnvironment: harden(commontools.getRecipeEnvironment),
    getEntityId: harden(commontools.getEntityId),
    ID: commontools.ID,
    ID_FIELD: commontools.ID_FIELD,
    SELF: commontools.SELF,
    TYPE: commontools.TYPE,
    NAME: commontools.NAME,
    UI: commontools.UI,
    schema: harden(commontools.schema),
    toSchema: harden(commontools.toSchema),
    AuthSchema: harden(commontools.AuthSchema),
    h: harden(commontools.h),
    console: sandboxedConsole,
    fetch: ((...args) => {
      sandboxedConsole.warn(
        "Direct fetch() is deprecated. Rewrite as several steps in a pattern using fetchData() instead.",
      );
      return fetch(...args);
    }) as typeof fetch,
    Temporal: harden(Temporal),
    secureRandom: () =>
      crypto.getRandomValues(new Uint32Array(1))[0] / 0x100000000,
    randomUUID: () => crypto.randomUUID(),
    harden: typeof harden === "function" ? harden : Object.freeze,
  };
}
```

**Files:**
- `packages/runner/src/sandbox/runtime-globals.ts` (exists)

### Phase 4: Runner Integration

#### 4.1 Modify instantiateJavaScriptNode

Replace direct eval with the authoritative verified SES execution path:

```typescript
// packages/runner/src/runner.ts

private instantiateJavaScriptNode(
  tx: IExtendedStorageTransaction,
  module: JavaScriptModuleDefinition,
  ...
): void {
  let fn: Function;

  if (typeof module.implementation === "string") {
    // Preferred path: retrieve a previously verified frozen export.
    // Secondary path: evaluate in a fresh verified Compartment if this string
    // is not yet represented as a cached export record.
    fn = getVerifiedFunction(module);
  } else {
    fn = module.implementation;
  }

  // ... rest of existing logic ...
}
```

**Files to modify:**
- `packages/runner/src/runner.ts`

#### 4.2 Remove UnsafeEvalIsolate Usage

Remove the legacy fallback to `harness.getInvocation()` / `UnsafeEvalIsolate`.
The runtime may keep a harness abstraction, but it must no longer route pattern
execution through raw eval once SES verification is enabled.

```typescript
// Before
fn = this.runtime.harness.getInvocation(module.implementation);

// After
fn = getVerifiedFunction(module);
```

**Files to modify:**
- `packages/runner/src/harness/engine.ts` (deprecate or remove)
- `packages/runner/src/harness/eval-runtime.ts` (deprecate or remove)

### Phase 5: Dynamic Import Support (TODO / Future Work)

> **Status**: `import-hooks.ts` exists with full implementation (`ESMCache`,
> `createResolveHook`, `createImportHook`) but is not yet wired into the
> Compartment creation path. This phase depends on connecting import hooks to
> the SESRuntime Compartment creation.

#### 5.1 Wire Up Import Hooks

Connect the existing import hook implementations to Compartment creation:

```typescript
// packages/runner/src/sandbox/import-hooks.ts (exists, needs wiring)

export function createImportHooks(
  esmCache: Map<string, string>
): ImportHooks {
  let invocationCounter = 0;

  return {
    resolveHook(specifier: string, referrer: string): string {
      if (isEsmShUrl(specifier)) {
        return `${specifier}#__inv_${invocationCounter++}`;
      }
      return resolveStandard(specifier, referrer);
    },

    async importHook(specifier: string): Promise<StaticModuleRecord> {
      const url = stripInvocationSuffix(specifier);

      let source = esmCache.get(url);
      if (!source) {
        source = await fetchAndCache(url, esmCache);
      }

      return new StaticModuleRecord(source, specifier);
    },
  };
}
```

#### 5.2 Dynamic Import Compartment (TODO)

Create isolated Compartments for dynamic imports, providing per-invocation
module instances. This depends on Phase 5.1 (wiring up import hooks).

**Files:**
- `packages/runner/src/sandbox/import-hooks.ts` (exists, not wired)
- `packages/runner/src/sandbox/dynamic-import-compartment.ts` (to be created)

### Phase 6: Testing & Hardening

#### 6.1 Security Tests

```typescript
// packages/runner/test/sandbox/security.test.ts

describe('SES Sandbox Security', () => {
  it('prevents closure state leakage between invocations', async () => {
    const pattern = `
      let leaked;
      export const TestPattern = pattern((props) => {
        leaked = props.secret;
        return { getter: () => leaked };
      });
    `;

    // This should fail at load time (module-scope mutation)
    await expect(loadPattern(pattern)).rejects.toThrow();
  });

  it('prevents access to global objects', async () => {
    const pattern = `
      export const TestPattern = pattern(() => {
        return { hasProcess: typeof process !== 'undefined' };
      });
    `;

    const result = await invokePattern(pattern, {});
    expect(result.hasProcess).toBe(false);
  });

  it('isolates dynamic imports between invocations', async () => {
    const pattern = `
      export const TestPattern = pattern(async () => {
        const mod = await import('https://esm.sh/stateful-module');
        mod.increment();
        return { count: mod.getCount() };
      });
    `;

    const result1 = await invokePattern(pattern, {});
    const result2 = await invokePattern(pattern, {});

    // Each should start fresh
    expect(result1.count).toBe(1);
    expect(result2.count).toBe(1);  // NOT 2!
  });

  it('freezes all pattern exports', async () => {
    const pattern = `
      export const myLift = lift((x) => x * 2);
    `;

    const compartment = await loadPattern(pattern);
    const exp = compartment.exports.get('myLift');

    expect(Object.isFrozen(exp)).toBe(true);
    expect(Object.isFrozen(exp.implementation)).toBe(true);
  });
});
```

**Files to create:**
- `packages/runner/test/sandbox/security.test.ts`
- `packages/runner/test/sandbox/compartment.test.ts`
- `packages/runner/test/sandbox/import-hooks.test.ts`

#### 6.2 Performance Tests

```typescript
// packages/runner/test/sandbox/performance.test.ts

describe('SES Sandbox Performance', () => {
  it('reuses Compartment for multiple invocations', async () => {
    const pattern = loadPattern(source);

    const start = performance.now();
    for (let i = 0; i < 1000; i++) {
      await invokePattern(pattern, { value: i });
    }
    const elapsed = performance.now() - start;

    // Should be fast since no Compartment creation per invocation
    expect(elapsed).toBeLessThan(1000);  // < 1ms per invocation
  });
});
```

---

## 10. Migration Guide

### 10.1 Pattern Author Changes

Most patterns will work without changes. The following patterns require updates:

#### Patterns with module-scope side effects

**Before (breaks):**
```typescript
const startTime = Date.now();  // Side effect at module scope
```

**After:**
```typescript
// Move to a lift if needed
const getStartTime = lift(() => Date.now());
```

#### Patterns with mutable module-scope state

**Before (breaks):**
```typescript
let counter = 0;
export const MyPattern = pattern(() => {
  counter++;
  return { count: counter };
});
```

**After:**
```typescript
// Use Cell for state
export const MyPattern = pattern(() => {
  const counter = cell(0);
  const increment = handler(() => counter.set(counter.get() + 1));
  return { count: counter, increment };
});
```

### 10.2 Runtime API Changes

```typescript
// Before
const runner = new Runner(runtime);
runner.start(recipe, inputs);

// After (if explicit lockdown control needed)
SESRuntime.applyLockdown({ enabled: true, debug: false });
const runner = new Runner(runtime);
runner.start(recipe, inputs);
```

---

## 11. Security Considerations

### 11.1 Threat Model

| Threat | Mitigation |
|--------|------------|
| Arbitrary code execution | SES Compartments plus controlled runtime capability injection |
| Collusion between callbacks in the same pattern | Runtime module verifier, direct-callback enforcement, verified plain-data freezing |
| Compiler/transformer compromise | Runner-side verification at the AMD module boundary |
| Global pollution | Frozen intrinsics, controlled globals |
| Prototype pollution | Frozen prototypes (SES default) |
| Closure-based data leakage | No surviving mutable module bindings; function hardening plus verified environments |
| State leakage via modules | Verified immutable top-level bindings; fresh Compartments for dynamic imports when needed |
| Resource exhaustion | Future: Add CPU/memory limits (not in this spec) |
| Network access | Future: Control fetch in globals (not in this spec) |

### 11.2 Known Limitations

1. **No CPU limits**: Infinite loops will still hang. Future work: Integrate with QuickJS for CPU limits or use Web Workers with timeouts.

2. **No memory limits**: Memory exhaustion possible. Future work: Monitor heap usage.

3. **No network restrictions**: `fetch` is not blocked. Future work: Proxy `fetch` with allowlist.

4. **Compartments are secondary containment only**: If the verifier is wrong,
   a shared Compartment increases blast radius. Per-pattern Compartments reduce
   that blast radius but do not replace verification.

### 11.3 Temporary Relaxations

The following unsafe capabilities are temporarily allowed while existing
patterns are migrated. Each will be tightened in a future release.

1. **Time and randomness migration**: Do not rely on
   `mathTaming` / `dateTaming` knobs as the long-term policy surface. The
   runtime should instead provide explicit helpers such as `Temporal`,
   `secureRandom()`, and `randomUUID()`, and continue migrating patterns away
   from ambient time/randomness APIs.

2. **`fetch()`** (provided as a global with deprecation warning): Patterns
   should use `fetchData()` instead, which is managed by the runtime.
   Direct `fetch()` logs a console warning and will be removed once all
   patterns are migrated.

### 11.4 Escape Hatch Analysis

Potential escape routes and their status:

| Vector | Status | Notes |
|--------|--------|-------|
| `eval()` | Blocked | SES removes `eval` from Compartment globals |
| `Function()` | Blocked | SES removes `Function` constructor |
| `import()` | Controlled | Via import hooks (TODO: not yet wired) |
| Prototype access | Blocked | Frozen prototypes |
| `globalThis` | Controlled | Custom Compartment globals |
| `__proto__` | Blocked | Frozen Object.prototype |
| `constructor` | Blocked | Frozen constructors |

---

## 12. Appendix

### A. SES Package Selection

**Recommended**: `ses` npm package (official from Agoric)

**Alternatives considered**:
- `@aspect-labs/ses` - Fork with minor fixes
- `lavamoat` - Higher-level, more opinionated
- QuickJS - Different approach (separate runtime)

### B. AMD Loader Compatibility

The existing AMD loader in `js-compiler` is compatible with SES Compartments. The loader is already:
- Self-contained (no global access)
- Pure (no side effects beyond module registration)
- Configurable (accepts runtime dependencies)

### C. Glossary

- **Compartment**: SES isolation boundary with its own global object
- **Harden**: Deep freeze an object graph
- **Lockdown**: Initialize SES, freeze all intrinsics
- **StaticModuleRecord**: SES's representation of an ES module
- **Import hooks**: Callbacks for resolving and loading modules
- **SESIsolate**: Runtime component that creates and manages Compartments with globals injection
- **SESRuntime**: Runtime harness that integrates SESIsolate into the pattern execution pipeline

---

## 13. References

1. [SES (Secure ECMAScript)](https://github.com/endojs/endo/tree/master/packages/ses)
2. [Hardened JavaScript](https://hardenedjs.org/)
3. [Compartment API](https://github.com/tc39/proposal-compartments)
4. [Common Fabric Pattern Documentation](../common/INTRODUCTION.md)
5. [ts-transformers Package](../../packages/ts-transformers/)
6. [js-compiler Package](../../packages/js-compiler/)
