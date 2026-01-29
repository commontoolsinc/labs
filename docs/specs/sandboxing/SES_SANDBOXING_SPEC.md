# SES Sandboxing Specification for Pattern Execution

## Status: Draft

## Authors
- AI-assisted specification

## Last Updated
2026-01-27

---

## 1. Executive Summary

This specification describes a security architecture for sandboxing untrusted JavaScript execution in the Common Tools pattern runtime using **SES (Secure ECMAScript)** Compartments. The goal is to prevent malicious or buggy pattern code from escaping its sandbox while maintaining high performance by reusing Compartments rather than creating new ones for each invocation.

### Key Principles

1. **Compartment Reuse**: Load compiled pattern modules into a single Compartment per pattern; freeze all exports
2. **No Surviving Closures**: Pattern code must not create closures that persist user data beyond a single invocation
3. **Allowlisted Module-Scope Calls**: Only `pattern`, `recipe`, `lift`, `handler`, and top-level function definitions are permitted at module scope
4. **Frozen Implementations**: All exported `lift` and `handler` implementations are frozen and callable directly
5. **Dynamic Import Isolation**: External ESM imports (esm.sh) get fresh module instances per invocation

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

Alternative considered: QuickJS (via `js-sandbox` package). SES is preferred because:
- Runs in the same V8/SpiderMonkey engine (no serialization overhead)
- Same JavaScript semantics (no edge cases)
- Can share frozen objects between Compartments without copying
- Better debugging experience (same DevTools)

---

## 3. Architecture Overview

### 3.1 High-Level Flow

```
Pattern Source (.tsx)
    ↓
[1] ts-transformers (enhanced)
    - Hoist lift/handler to module scope
    - Rewrite inline derive → lift call
    - Add __exportName annotations
    - Validate allowlisted module-scope calls
    ↓
[2] js-compiler (existing)
    - TypeScript → AMD bundle
    ↓
[3] SES Compartment Loader (new)
    - Create Compartment with frozen globals
    - Execute AMD bundle once
    - Freeze all exports
    - Return callable implementations
    ↓
[4] Runner (modified)
    - Call frozen .implementation directly
    - No eval() per invocation
```

### 3.2 Compartment Lifecycle

```
┌─────────────────────────────────────────────────────────────┐
│ Root Compartment (lockdown applied)                         │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ Pattern Compartment (per-pattern, created once)       │  │
│  │                                                       │  │
│  │  Globals: { pattern, recipe, lift, handler, ... }    │  │
│  │                                                       │  │
│  │  Module Exports (frozen):                            │  │
│  │  - MyPattern: { implementation: fn, schema: {...} }  │  │
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
│  │                                                       │  │
│  │  Used for: await import("https://esm.sh/lodash")     │  │
│  │  Fresh instance each time to prevent state leakage   │  │
│  │                                                       │  │
│  └──────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

---

## 4. Transformer Enhancements

### 4.1 Overview of Changes

The `ts-transformers` package requires the following enhancements:

| Transformation | Current Behavior | New Behavior |
|----------------|------------------|--------------|
| `computed(() => ...)` | → `derive({}, () => ...)` | → call to module-scope `lift` |
| `action(() => ...)` | → `handler((_, {}) => ...)({})` | → call to module-scope `handler` |
| inline `derive(input, fn)` | kept inline | → call to module-scope `lift` (or inline if self-contained) |
| `lift(...)` | allowed inline | **ERROR** if not at module scope |
| `handler(...)` | allowed inline | **ERROR** if not at module scope |
| module-scope calls | minimal validation | strict allowlist enforcement |

### 4.2 Module-Scope Allowlist

Only these calls are permitted at module scope:

```typescript
// ALLOWED at module scope
import { pattern, recipe, lift, handler } from "@commontools/common-builder";

// Pattern/Recipe definitions - these call their inner functions at load time
// but user data is not available yet, so this is safe
export const MyPattern = pattern<Input, Output>((props) => {
  // ...inner function runs at load time...
});

export const MyRecipe = recipe<Input, Output>("name", (props) => {
  // ...inner function runs at load time...
});

// Lift definitions - pure functions, will be frozen
export const myLift = lift<Input, Output>((input) => {
  return transform(input);
});

// Handler definitions - event handlers, will be frozen
export const myHandler = handler<Event, State>((event, state) => {
  return newState;
});

// Top-level function definitions (allowed, but NOT immediately called)
function helperFunction(x: number): number {
  return x * 2;
}

// Variable declarations with literals
const CONFIG = { maxItems: 100 };

// Type definitions
type MyType = { name: string };
```

**DISALLOWED** at module scope:

```typescript
// ❌ Immediately calling a function at module scope (creates closures)
const result = someFunction();

// ❌ IIFE (Immediately Invoked Function Expression)
const value = (() => computeSomething())();

// ❌ Any function call except allowlisted builders
const data = fetchData();

// ❌ Await expressions (implies side effects)
const response = await fetch(url);
```

### 4.3 Hoisting Inline Transformations

#### 4.3.1 Computed → Lifted Call

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

**After transformation (new):**
```typescript
// Hoisted to module scope
const __computed_1 = lift<{ value: number }, number>(
  ({ value }) => value * 2
);
__computed_1.__exportName = "__computed_1";  // Annotation for verification

export const MyPattern = pattern<Input, Output>((props) => {
  const doubled = __computed_1({ value: props.value });
  return { doubled };
});
```

#### 4.3.2 Action → Handler Call

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
__action_1.__exportName = "__action_1";

export const MyPattern = pattern<Input, Output>((props) => {
  const doSomething = __action_1({ count: props.count });
  return { doSomething };
});
```

#### 4.3.3 Inline Derive → Lifted Call

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
__derive_1.__exportName = "__derive_1";

export const MyPattern = pattern<Input, Output>((props) => {
  const total = __derive_1(props.items);
  return { total };
});
```

#### 4.3.4 Optimization: Self-Contained Inline

If the inline function body is entirely self-contained (no references to outer scope), it MAY remain inline for simplicity. The Compartment can evaluate it safely.

**Detection criteria:**
- No free variables (all identifiers are parameters or locally defined)
- No `this` references
- No `arguments` references
- No `eval` or `Function` calls

```typescript
// This can stay inline (self-contained)
const doubled = derive(props.value, x => x * 2);

// This MUST be hoisted (references outer scope)
const doubled = derive(props.value, x => x * multiplier);
```

### 4.4 Export Name Annotation

Every module-scope `pattern`, `recipe`, `lift`, and `handler` must be annotated with its export name. This allows runtime verification that the implementation was indeed defined at module scope and thus frozen.

```typescript
// Before annotation
export const MyLift = lift<In, Out>(fn);

// After annotation (transformer adds this)
export const MyLift = lift<In, Out>(fn);
MyLift.__exportName = "MyLift";
```

For generated/hoisted definitions:
```typescript
const __computed_1 = lift<In, Out>(fn);
__computed_1.__exportName = "__computed_1";
```

**Runtime verification:**
```typescript
function verifyFrozen(impl: any, name: string): void {
  if (impl.__exportName !== name) {
    throw new Error(`Implementation ${name} was not defined at module scope`);
  }
  if (!Object.isFrozen(impl.implementation)) {
    throw new Error(`Implementation ${name}.implementation is not frozen`);
  }
}
```

---

## 5. SES Compartment Integration

### 5.1 Lockdown Configuration

At application startup, apply SES lockdown:

```typescript
import 'ses';

lockdown({
  // Error taming: show full stack traces
  errorTaming: 'unsafe',

  // Stack traces: show real file names
  stackFiltering: 'verbose',

  // Overrides: allow some taming for compatibility
  overrideTaming: 'moderate',

  // Console: allow console.log for debugging (configurable)
  consoleTaming: 'unsafe',  // or 'safe' in production

  // Locale: standard behavior
  localeTaming: 'unsafe',

  // Eval: controlled via Compartments
  evalTaming: 'safeEval',
});
```

### 5.2 Pattern Compartment Creation

```typescript
interface PatternCompartment {
  compartment: Compartment;
  exports: Map<string, FrozenExport>;
}

interface FrozenExport {
  __exportName: string;
  implementation: Function;  // frozen
  inputSchema: JSONSchema;
  resultSchema: JSONSchema;
}

function createPatternCompartment(
  compiledAMD: string,
  runtimeGlobals: Record<string, unknown>
): PatternCompartment {

  // Create Compartment with controlled globals
  const compartment = new Compartment({
    // Frozen intrinsics (automatic with SES)

    // Runtime-provided globals (frozen)
    ...harden(runtimeGlobals),

    // Builder functions
    pattern: harden(createPatternBuilder()),
    recipe: harden(createRecipeBuilder()),
    lift: harden(createLiftBuilder()),
    handler: harden(createHandlerBuilder()),
    derive: harden(createDeriveBuilder()),

    // Cell/reactive primitives
    Cell: harden(Cell),
    cell: harden(cell),

    // UI helpers (frozen)
    h: harden(h),

    // Allowlisted globals
    console: harden(console),  // or filtered console
    JSON: harden(JSON),
    Math: harden(Math),
  });

  // Execute the AMD bundle in the Compartment
  const moduleExports = compartment.evaluate(compiledAMD)({
    // Runtime dependencies injection
    "@commontools/common-builder": harden(builderExports),
    "@commontools/common-html": harden(htmlExports),
    // ... other runtime modules
  });

  // Freeze all exports deeply
  const frozenExports = new Map<string, FrozenExport>();

  for (const [name, exp] of Object.entries(moduleExports)) {
    if (isBuilderExport(exp)) {
      // Verify it was defined at module scope
      if (exp.__exportName !== name) {
        throw new Error(
          `Export ${name} was not defined at module scope ` +
          `(found __exportName: ${exp.__exportName})`
        );
      }

      // Deep freeze the implementation
      harden(exp);

      frozenExports.set(name, exp as FrozenExport);
    }
  }

  return { compartment, exports: frozenExports };
}
```

### 5.3 Invoking Frozen Implementations

Once a pattern is loaded and frozen, invocations simply call the frozen functions:

```typescript
class SandboxedRunner {
  private patternCompartments = new Map<string, PatternCompartment>();

  async loadPattern(patternId: string, source: string): Promise<void> {
    // Compile (existing pipeline)
    const compiled = await this.compiler.compile(source);

    // Create sandboxed compartment
    const patternCompartment = createPatternCompartment(
      compiled.js,
      this.getRuntimeGlobals()
    );

    this.patternCompartments.set(patternId, patternCompartment);
  }

  invoke(patternId: string, exportName: string, input: unknown): unknown {
    const pattern = this.patternCompartments.get(patternId);
    if (!pattern) {
      throw new Error(`Pattern ${patternId} not loaded`);
    }

    const exp = pattern.exports.get(exportName);
    if (!exp) {
      throw new Error(`Export ${exportName} not found in ${patternId}`);
    }

    // Direct call to frozen implementation - no new Compartment needed!
    return exp.implementation(input);
  }
}
```

### 5.4 String Evaluation Compartment

For strings that couldn't be hoisted (rare case), create a fresh Compartment each time:

```typescript
function evaluateStringInCompartment(
  code: string,
  globals: Record<string, unknown>
): Function {
  // Wrap in a function to prevent closure creation
  const wrappedCode = `(function(__input__) { return (${code})(__input__); })`;

  // Fresh Compartment each time
  const compartment = new Compartment({
    ...harden(globals),
  });

  // Evaluate and return the wrapper function
  return harden(compartment.evaluate(wrappedCode));
}

// Usage
const fn = evaluateStringInCompartment(
  '(x) => x * 2',
  { Math: harden(Math) }
);
const result = fn(21);  // 42
```

---

## 6. Dynamic Import Support (esm.sh)

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

The transformer enforces that module-scope variables:
- Are only assigned at declaration time
- Are never reassigned
- Are const (not let/var)

```typescript
// ❌ REJECTED: let at module scope
let counter = 0;

// ❌ REJECTED: Assignment to module-scope variable
const config = {};
config.key = "value";  // Rejected (mutation)

// ✅ ALLOWED: const with literal/frozen value
const CONFIG = Object.freeze({ key: "value" });
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

#### 7.2.3 Frozen Implementations

All `lift` and `handler` implementations are frozen after load:

```typescript
const myLift = lift((input) => input * 2);
// After load: Object.isFrozen(myLift.implementation) === true

// Any attempt to replace the implementation throws
myLift.implementation = evilFn;  // TypeError: Cannot assign to read only property
```

#### 7.2.4 Fresh Compartments for Strings

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
    at SandboxedRunner.invoke (compartment-manager.ts:89:5)
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

#### 8.4.1 Store Source Maps with Compartments

```typescript
// packages/runner/src/sandbox/compartment-manager.ts

interface PatternCompartment {
  compartment: Compartment;
  exports: Map<string, FrozenExport>;
  sourceMap: SourceMap;  // Add source map storage
  sourceFiles: Map<string, string>;  // Original source for display
}

function createPatternCompartment(
  compiled: JsScript,
  runtimeGlobals: Record<string, unknown>
): PatternCompartment {
  // ... existing compartment creation ...

  return {
    compartment,
    exports: frozenExports,
    sourceMap: compiled.sourceMap,
    sourceFiles: compiled.sourceFiles,  // From compilation
  };
}
```

#### 8.4.2 Error Mapping Utility

```typescript
// packages/runner/src/sandbox/error-mapping.ts

import { SourceMapConsumer } from 'source-map';

interface MappedFrame {
  functionName: string;
  fileName: string;
  lineNumber: number;
  columnNumber: number;
  originalFunctionName?: string;  // e.g., "computed callback"
  isHoisted: boolean;
}

interface MappedError extends Error {
  originalStack: string;
  mappedStack: string;
  mappedFrames: MappedFrame[];
  patternId?: string;
}

export async function mapError(
  error: Error,
  sourceMap: SourceMap,
  patternId: string
): Promise<MappedError> {
  const consumer = await new SourceMapConsumer(sourceMap);

  try {
    const frames = parseStackTrace(error.stack);
    const mappedFrames: MappedFrame[] = [];

    for (const frame of frames) {
      if (isPatternFrame(frame, patternId)) {
        const original = consumer.originalPositionFor({
          line: frame.lineNumber,
          column: frame.columnNumber,
        });

        if (original.source) {
          mappedFrames.push({
            functionName: original.name || frame.functionName,
            fileName: original.source,
            lineNumber: original.line,
            columnNumber: original.column,
            originalFunctionName: getOriginalName(frame.functionName),
            isHoisted: frame.functionName.startsWith('__'),
          });
        } else {
          mappedFrames.push({ ...frame, isHoisted: false });
        }
      } else {
        // Non-pattern frame, keep as-is
        mappedFrames.push({ ...frame, isHoisted: false });
      }
    }

    const mappedError = error as MappedError;
    mappedError.originalStack = error.stack;
    mappedError.mappedStack = formatMappedStack(mappedFrames);
    mappedError.mappedFrames = mappedFrames;
    mappedError.patternId = patternId;
    mappedError.stack = mappedError.mappedStack;

    return mappedError;
  } finally {
    consumer.destroy();
  }
}

function getOriginalName(hoistedName: string): string | undefined {
  // __computed_1 → "computed callback"
  // __action_2 → "action callback"
  // __derive_3 → "derive callback"
  if (hoistedName.startsWith('__computed_')) return 'computed callback';
  if (hoistedName.startsWith('__action_')) return 'action callback';
  if (hoistedName.startsWith('__derive_')) return 'derive callback';
  return undefined;
}

function formatMappedStack(frames: MappedFrame[]): string {
  return frames.map(frame => {
    let line = `    at ${frame.functionName} (${frame.fileName}:${frame.lineNumber}:${frame.columnNumber})`;
    if (frame.isHoisted && frame.originalFunctionName) {
      line += `\n       └─ (originally: ${frame.originalFunctionName})`;
    }
    return line;
  }).join('\n');
}
```

#### 8.4.3 Wrap Execution with Error Mapping

```typescript
// packages/runner/src/sandbox/execution-wrapper.ts

export async function executeWithErrorMapping<T>(
  fn: () => T,
  patternCompartment: PatternCompartment,
  patternId: string
): Promise<T> {
  try {
    return fn();
  } catch (error) {
    if (error instanceof Error && patternCompartment.sourceMap) {
      const mappedError = await mapError(
        error,
        patternCompartment.sourceMap,
        patternId
      );
      throw mappedError;
    }
    throw error;
  }
}

// Usage in runner
invoke(patternId: string, exportName: string, input: unknown): unknown {
  const pattern = this.patternCompartments.get(patternId);
  const exp = pattern.exports.get(exportName);

  return executeWithErrorMapping(
    () => exp.implementation(input),
    pattern,
    patternId
  );
}
```

### 8.5 Debugging Experience

#### 8.5.1 Console Output

With proper error mapping, developers see:

```
TypeError: Cannot read property 'map' of undefined

    at computed callback (MyPattern.tsx:23:42)
       └─ (originally: computed callback)
    at MyPattern (MyPattern.tsx:22:3)
    at SandboxedRunner.invoke (compartment-manager.ts:89:5)

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

export function formatErrorForDisplay(
  error: MappedError,
  sourceFiles: Map<string, string>
): string {
  const lines: string[] = [
    `${error.name}: ${error.message}`,
    '',
    error.mappedStack,
  ];

  // Add pattern context
  if (error.patternId) {
    lines.push('', `Pattern: ${error.patternId}`);
  }

  // Add source context if available
  const topFrame = error.mappedFrames[0];
  if (topFrame && sourceFiles.has(topFrame.fileName)) {
    const source = sourceFiles.get(topFrame.fileName);
    const context = extractSourceContext(
      source,
      topFrame.lineNumber,
      topFrame.columnNumber
    );
    lines.push('', `Original source (${topFrame.fileName}:${topFrame.lineNumber}):`);
    lines.push(context);
  }

  return lines.join('\n');
}

function extractSourceContext(
  source: string,
  line: number,
  column: number,
  contextLines: number = 1
): string {
  const lines = source.split('\n');
  const start = Math.max(0, line - 1 - contextLines);
  const end = Math.min(lines.length, line + contextLines);

  const result: string[] = [];
  for (let i = start; i < end; i++) {
    const lineNum = i + 1;
    const prefix = lineNum === line ? '> ' : '  ';
    const numStr = String(lineNum).padStart(3);
    result.push(`${prefix}${numStr} │ ${lines[i]}`);

    // Add column pointer for error line
    if (lineNum === line) {
      const pointer = ' '.repeat(column + 7) + '^^^';
      result.push(`     │ ${pointer}`);
    }
  }

  return result.join('\n');
}
```

### 8.6 Layered Stack Trace Filtering

The key insight is that **pattern authors and runtime developers have different needs**:

- **Pattern authors** need to see their code, but runtime internals are noise
- **Runtime developers** need to see everything when debugging the runtime itself

#### 8.6.1 Frame Classification

```typescript
// packages/runner/src/sandbox/frame-classifier.ts

type FrameType = 'pattern' | 'runtime' | 'external';

interface ClassifiedFrame extends MappedFrame {
  frameType: FrameType;
}

function classifyFrame(frame: MappedFrame, patternId: string): FrameType {
  // Pattern code - always from the pattern's source files
  if (isPatternSource(frame.fileName, patternId)) {
    return 'pattern';
  }

  // Runtime code - our internal packages
  if (isRuntimeSource(frame.fileName)) {
    return 'runtime';
  }

  // External - third-party libraries, esm.sh imports
  return 'external';
}

function isPatternSource(fileName: string, patternId: string): boolean {
  // Pattern sources are in the virtual filesystem or have pattern markers
  return fileName.includes(patternId) ||
         fileName.endsWith('.tsx') ||
         fileName.startsWith('/patterns/');
}

function isRuntimeSource(fileName: string): boolean {
  return fileName.includes('packages/runner/') ||
         fileName.includes('packages/common-builder/') ||
         fileName.includes('packages/common-html/') ||
         fileName.includes('compartment-manager') ||
         fileName.includes('sandbox/');
}
```

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
    at FrozenExport.implementation (compartment-manager.ts:89:5)
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
  maxPatternFrames: number;    // limit depth, default unlimited
}

const DEFAULT_OPTIONS: StackFilterOptions = {
  showRuntimeFrames: false,
  showExternalFrames: true,
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
      if (frame.frameType === 'runtime' && !inRuntimeSection) {
        lines.push('    ─── runtime frames ───');
        inRuntimeSection = true;
      } else if (frame.frameType !== 'runtime' && inRuntimeSection) {
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

#### 8.6.4 Debug Mode Activation

```typescript
// packages/runner/src/sandbox/config.ts

export interface SandboxConfig {
  // For pattern authors (default)
  errorDisplay: 'pattern-only' | 'full';

  // Environment detection
  isRuntimeDeveloper: boolean;
}

// Auto-detect based on environment
export function detectConfig(): SandboxConfig {
  return {
    errorDisplay: process.env.COMMON_TOOLS_DEBUG === 'true'
      ? 'full'
      : 'pattern-only',

    isRuntimeDeveloper:
      process.env.COMMON_TOOLS_DEBUG === 'true' ||
      process.env.NODE_ENV === 'development' &&
      isRunningFromSource(),  // e.g., not from node_modules
  };
}

function isRunningFromSource(): boolean {
  // Check if we're running from the monorepo vs installed package
  return __dirname.includes('/packages/runner/src/');
}
```

### 8.7 Configuration Summary

| Audience | `errorDisplay` | Runtime Frames | Source Context |
|----------|----------------|----------------|----------------|
| Pattern Author | `'pattern-only'` | Hidden | Pattern source shown |
| Runtime Developer | `'full'` | Visible (marked) | All source shown |
| Production (logging) | `'pattern-only'` | Hidden | Included in logs |

```typescript
// Pattern author sees clean errors focused on their code
CompartmentManager.configure({
  errorDisplay: 'pattern-only',
});

// Runtime developer sees everything
CompartmentManager.configure({
  errorDisplay: 'full',
});
// Or via environment:
// COMMON_TOOLS_DEBUG=true
```

### 8.8 Implementation Checklist

| Task | Priority | Files |
|------|----------|-------|
| Transformer source map generation | High | `ts-transformers/src/hoisting.ts` |
| Source map chaining in js-compiler | High | `js-compiler/typescript/compiler.ts` |
| Store source maps in PatternCompartment | High | `runner/src/sandbox/compartment-manager.ts` |
| Error mapping utility | High | `runner/src/sandbox/error-mapping.ts` |
| Execution wrapper with mapping | High | `runner/src/sandbox/execution-wrapper.ts` |
| Enhanced error display | Medium | `runner/src/sandbox/error-display.ts` |
| Source context extraction | Medium | `runner/src/sandbox/error-display.ts` |
| Configuration options | Low | `runner/src/sandbox/config.ts` |

---

## 9. Implementation Plan

### Phase 1: Transformer Enhancements

#### 1.1 Module-Scope Validation (Priority: High)

Add `ModuleScopeValidationTransformer`:

```typescript
class ModuleScopeValidationTransformer {
  // Allowlist of permitted module-scope calls
  private allowedCalls = new Set([
    'pattern', 'recipe', 'lift', 'handler',
    'Object.freeze', 'harden'
  ]);

  visitCallExpression(node: ts.CallExpression): void {
    if (this.isModuleScope(node)) {
      const callee = this.getCalleeName(node);
      if (!this.allowedCalls.has(callee)) {
        this.reportError(node, `Call to ${callee} not allowed at module scope`);
      }
    }
  }

  visitVariableDeclaration(node: ts.VariableDeclaration): void {
    if (this.isModuleScope(node) && node.kind !== ts.SyntaxKind.ConstKeyword) {
      this.reportError(node, 'Only const declarations allowed at module scope');
    }
  }
}
```

**Files to modify:**
- `packages/ts-transformers/src/index.ts` - Add new transformer to pipeline
- New file: `packages/ts-transformers/src/module-scope-validation.ts`

#### 1.2 Hoist Computed/Action/Derive (Priority: High)

Modify `ComputedTransformer` and `ClosureTransformer`:

```typescript
class HoistingTransformer {
  private hoistedDeclarations: ts.Statement[] = [];
  private counter = 0;

  visitComputedCall(node: ts.CallExpression): ts.Expression {
    const fn = node.arguments[0];
    const name = `__computed_${this.counter++}`;

    // Create hoisted lift
    const hoisted = ts.factory.createVariableStatement(
      undefined,
      ts.factory.createVariableDeclarationList([
        ts.factory.createVariableDeclaration(
          name,
          undefined,
          undefined,
          ts.factory.createCallExpression(
            ts.factory.createIdentifier('lift'),
            [...typeArgs],
            [fn]
          )
        )
      ], ts.NodeFlags.Const)
    );

    this.hoistedDeclarations.push(hoisted);

    // Return call to hoisted lift
    return ts.factory.createCallExpression(
      ts.factory.createIdentifier(name),
      undefined,
      [capturedInputs]
    );
  }
}
```

**Files to modify:**
- `packages/ts-transformers/src/computed.ts`
- `packages/ts-transformers/src/closure.ts`
- New file: `packages/ts-transformers/src/hoisting.ts`

#### 1.3 Export Name Annotation (Priority: Medium)

Add annotation to all builder calls:

```typescript
class ExportNameAnnotationTransformer {
  visitExportDeclaration(node: ts.ExportDeclaration): ts.Node {
    // For: export const MyPattern = pattern(...);
    // Add: MyPattern.__exportName = "MyPattern";

    const name = this.getExportName(node);
    const annotation = ts.factory.createExpressionStatement(
      ts.factory.createAssignment(
        ts.factory.createPropertyAccessExpression(
          ts.factory.createIdentifier(name),
          '__exportName'
        ),
        ts.factory.createStringLiteral(name)
      )
    );

    return [node, annotation];
  }
}
```

**Files to modify:**
- New file: `packages/ts-transformers/src/export-annotation.ts`

### Phase 2: SES Integration

#### 2.1 Add SES Dependency

```bash
npm install ses
```

**Files to modify:**
- `packages/runner/package.json`

#### 2.2 Create Compartment Manager

New module for managing pattern Compartments:

```typescript
// packages/runner/src/sandbox/compartment-manager.ts

import 'ses';

export class CompartmentManager {
  private static lockdownApplied = false;
  private patternCompartments = new Map<string, PatternCompartment>();

  static applyLockdown(): void {
    if (this.lockdownApplied) return;
    lockdown({
      errorTaming: 'unsafe',
      stackFiltering: 'verbose',
      overrideTaming: 'moderate',
      consoleTaming: 'unsafe',
    });
    this.lockdownApplied = true;
  }

  loadPattern(id: string, compiledJS: string): PatternCompartment { ... }
  getExport(patternId: string, name: string): FrozenExport { ... }
  evaluateString(code: string): Function { ... }
}
```

**Files to create:**
- `packages/runner/src/sandbox/compartment-manager.ts`
- `packages/runner/src/sandbox/pattern-compartment.ts`
- `packages/runner/src/sandbox/types.ts`

#### 2.3 Create Runtime Globals Provider

Define the frozen globals available in pattern Compartments:

```typescript
// packages/runner/src/sandbox/runtime-globals.ts

export function createRuntimeGlobals(): Record<string, unknown> {
  return harden({
    // Builder functions
    pattern: createPatternBuilder(),
    recipe: createRecipeBuilder(),
    lift: createLiftBuilder(),
    handler: createHandlerBuilder(),
    derive: createDeriveBuilder(),

    // Cell/reactive
    Cell,
    cell,

    // UI
    h,

    // Standard globals (frozen)
    console: createSandboxedConsole(),
    JSON,
    Math,
    Object: {
      keys: Object.keys,
      values: Object.values,
      entries: Object.entries,
      freeze: Object.freeze,
      // ... allowlisted methods only
    },
    Array: {
      isArray: Array.isArray,
      from: Array.from,
      // ... allowlisted methods only
    },
  });
}
```

**Files to create:**
- `packages/runner/src/sandbox/runtime-globals.ts`
- `packages/runner/src/sandbox/sandboxed-console.ts`

### Phase 3: Runner Integration

#### 3.1 Modify instantiateJavaScriptNode

Replace direct eval with Compartment invocation:

```typescript
// packages/runner/src/runner.ts

private instantiateJavaScriptNode(
  tx: IExtendedStorageTransaction,
  module: JavaScriptModuleDefinition,
  ...
): void {
  let fn: Function;

  if (typeof module.implementation === "string") {
    // Check if this is a frozen export from a loaded pattern
    if (module.patternId && module.exportName) {
      const exp = this.compartmentManager.getExport(
        module.patternId,
        module.exportName
      );

      // Verify it's frozen and module-scope defined
      verifyFrozen(exp, module.exportName);

      fn = exp.implementation;
    } else {
      // Fallback: evaluate in fresh Compartment
      fn = this.compartmentManager.evaluateString(module.implementation);
    }
  } else {
    fn = module.implementation;
  }

  // ... rest of existing logic ...
}
```

**Files to modify:**
- `packages/runner/src/runner.ts`

#### 3.2 Remove UnsafeEvalIsolate Usage

Replace `harness.getInvocation()` with Compartment-based evaluation:

```typescript
// Before
fn = this.runtime.harness.getInvocation(module.implementation);

// After
fn = this.compartmentManager.evaluateString(module.implementation);
```

**Files to modify:**
- `packages/runner/src/harness/engine.ts` (deprecate or remove)
- `packages/runner/src/harness/eval-runtime.ts` (deprecate or remove)

### Phase 4: Dynamic Import Support

#### 4.1 Implement Import Hooks

```typescript
// packages/runner/src/sandbox/import-hooks.ts

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

**Files to create:**
- `packages/runner/src/sandbox/import-hooks.ts`
- `packages/runner/src/sandbox/esm-cache.ts`

#### 4.2 Integrate with Compartment

```typescript
// packages/runner/src/sandbox/dynamic-import-compartment.ts

export async function createDynamicImportCompartment(
  base: Compartment,
  esmCache: Map<string, string>
): Promise<Compartment> {
  const hooks = createImportHooks(esmCache);

  return new Compartment(
    base.globalThis,
    {},
    {
      resolveHook: hooks.resolveHook,
      importHook: hooks.importHook,
    }
  );
}
```

**Files to create:**
- `packages/runner/src/sandbox/dynamic-import-compartment.ts`

### Phase 5: Testing & Hardening

#### 5.1 Security Tests

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

#### 5.2 Performance Tests

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
CompartmentManager.applyLockdown();  // Call once at startup
const runner = new Runner(runtime);
runner.start(recipe, inputs);
```

---

## 11. Security Considerations

### 11.1 Threat Model

| Threat | Mitigation |
|--------|------------|
| Arbitrary code execution | SES Compartment isolation |
| Global pollution | Frozen intrinsics, controlled globals |
| Prototype pollution | Frozen prototypes (SES default) |
| Closure-based data leakage | No surviving closures, hoisted frozen implementations |
| State leakage via modules | Fresh Compartments for dynamic imports |
| Resource exhaustion | Future: Add CPU/memory limits (not in this spec) |
| Network access | Future: Control fetch in globals (not in this spec) |

### 11.2 Known Limitations

1. **No CPU limits**: Infinite loops will still hang. Future work: Integrate with QuickJS for CPU limits or use Web Workers with timeouts.

2. **No memory limits**: Memory exhaustion possible. Future work: Monitor heap usage.

3. **No network restrictions**: `fetch` is not blocked. Future work: Proxy `fetch` with allowlist.

### 11.3 Temporary Relaxations

The following unsafe capabilities are temporarily allowed while existing
patterns are migrated. Each will be tightened in a future release.

1. **`Math.random()`** (`mathTaming: "unsafe"`): SES normally makes
   `Math.random()` return `NaN` to prevent covert channels. Currently
   allowed because many patterns use it for ID generation and shuffling.
   Migrate to a deterministic PRNG seeded by the runtime.

2. **`Date.now()` / `new Date()`** (`dateTaming: "unsafe"`): SES normally
   makes `Date.now()` return `NaN` to prevent timing side-channels.
   Currently allowed because patterns use timestamps for display and
   logging. Migrate to a runtime-provided clock.

3. **`fetch()`** (provided as a global with deprecation warning): Patterns
   should use `fetchData()` instead, which is managed by the runtime.
   Direct `fetch()` logs a console warning and will be removed once all
   patterns are migrated.

### 11.4 Escape Hatch Analysis

Potential escape routes and their status:

| Vector | Status | Notes |
|--------|--------|-------|
| `eval()` | Blocked | SES removes `eval` from Compartment globals |
| `Function()` | Blocked | SES removes `Function` constructor |
| `import()` | Controlled | Via import hooks |
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

---

## 13. References

1. [SES (Secure ECMAScript)](https://github.com/endojs/endo/tree/master/packages/ses)
2. [Hardened JavaScript](https://hardenedjs.org/)
3. [Compartment API](https://github.com/tc39/proposal-compartments)
4. [Common Tools Pattern Documentation](../common/INTRODUCTION.md)
5. [ts-transformers Package](../../packages/ts-transformers/)
6. [js-compiler Package](../../packages/js-compiler/)
