# TypeScript Transformers Current Behavior Specification

**Status:** Implemented (current behavior)  
**Package:** `@commontools/ts-transformers`  
**Effective date:** February 24, 2026  
**Scope:** Compile-time behavior implemented in `packages/ts-transformers/src` and exercised by current tests/fixtures.

## 1. Scope And Source Of Truth

This document specifies what the transformer system currently does, not what it
is intended to do in future design docs.

Authoritative implementation sources:

- `packages/ts-transformers/src/**`
- `packages/ts-transformers/test/**`
- fixture corpus under `packages/ts-transformers/test/fixtures/**`

If this document conflicts with code or passing tests, code/tests win.

## 2. Activation And Entry Conditions

### 2.1 `/// <cts-enable />` pre-transform

Before AST transforms, `transformCtDirective()`:

1. Requires the first source line to match `/// <cts-enable />`.
2. Rewrites source by injecting:
   - `import * as __ctHelpers from "commontools";`
   - helper `h(...)` forwarding to `__ctHelpers.h`.
3. Rejects sources that contain identifier `__ctHelpers` anywhere in the AST.

If `/// <cts-enable />` is absent, no helper import is injected and most
transformers effectively no-op.

### 2.2 Pipeline object

`CommonToolsTransformerPipeline` constructs one ordered pipeline with shared
mutable registries:

- `typeRegistry: WeakMap<ts.Node, ts.Type>`
- `mapCallbackRegistry: WeakSet<ts.Node>`
- `schemaHints: WeakMap<ts.Node, SchemaHint>`
- `diagnosticsCollector: TransformationDiagnostic[]`

## 3. Pipeline Order (Normative)

Transformers always run in this order:

1. `CastValidationTransformer`
2. `OpaqueGetValidationTransformer`
3. `PatternContextValidationTransformer`
4. `OpaqueRefJSXTransformer`
5. `ComputedTransformer`
6. `ClosureTransformer`
7. `SchemaInjectionTransformer`
8. `SchemaGeneratorTransformer`

The order is behaviorally significant.

## 4. Global Modes

`TransformationOptions.mode` supports:

- `transform` (default)
- `error`

Current mode-sensitive behavior:

- `OpaqueRefJSXTransformer` in `error` mode reports diagnostics instead of
  rewriting JSX expressions that would require opaque-ref rewrites in non-safe
  contexts.
- Other transformers currently do not branch on mode.

## 5. Call Kind Detection Contract

`detectCallKind()` drives multiple transformers. It recognizes:

- builders: `pattern`, `handler`, `action`, `lift`, `computed`, `render`
- `derive`
- `ifElse`, `when`, `unless`
- reactive array calls (`map`, `mapWithPattern`)
- cell factories (`cell`, `Cell.of`, `OpaqueCell.of`, `Stream.of`, etc.)
- `Cell.for`-style calls
- `wish`
- `generateObject`
- `patternTool`

Detection strategy is layered:

1. direct identifier name fast-path
2. symbol/alias resolution
3. name-based fallback

Consequence: name-based fallback can intentionally match non-CommonTools symbols
with the same names.

## 6. Validation Transformers

### 6.1 Cast validation

Validates `as` and angle-bracket assertions:

- **Error** `cast-validation:double-unknown`
  - `expr as unknown as X`
  - `<X><unknown>expr`
  - parenthesized/mixed equivalents
- **Error** `cast-validation:forbidden-cast`
  - casts to `OpaqueRef<...>`
- **Warning** `cast-validation:cell-cast`
  - casts to cell-like types:
    `Cell`, `OpaqueCell`, `Stream`, `ComparableCell`, `ReadonlyCell`,
    `WriteonlyCell`, `Writable`, `CellTypeConstructor`

### 6.2 Opaque `.get()` validation

On call `receiver.get()` (no args):

- if receiver cell kind resolves to `"opaque"`:
  - **Error** `opaque-get:invalid-call`
  - message instructs direct access, clarifies only `Writable<T>`/`Cell<T>`
    reads require `.get()`.

No error for non-opaque kinds (e.g., writable/cell/stream).

### 6.3 Pattern-context validation

Enforces restricted reactive context rules.

Restricted contexts are callbacks of:

- `pattern`
- `render`
- `.map(...)`/`.mapWithPattern(...)` callbacks detected as array-map calls

Safe wrappers override restrictions:

- `computed`, `action`, `derive`, `lift`, `handler` callbacks
- inline JSX `on*` handlers
- standalone function definitions
- JSX expressions (handled by opaque-ref JSX transformer)

Diagnostics:

- **Error** `pattern-context:optional-chaining`
  - optional property access `?.` in restricted reactive context (outside JSX)
- **Error** `pattern-context:get-call`
  - `.get()` call in restricted reactive context
- **Error** `pattern-context:computation`
  - binary/unary/conditional computations using opaque dependencies outside
    wrappers
- **Error** `pattern-context:function-creation`
  - function creation in pattern context unless inside safe wrappers/JSX/safe
    callbacks
- **Error** `pattern-context:builder-placement`
  - direct `lift()` or `handler()` inside restricted context
  - special message for immediate `lift(fn)(args)` suggesting `computed()`
- **Error** `pattern-context:map-on-fallback`
  - `(opaqueExpr ?? fallback).map(...)` or `(opaqueExpr || fallback).map(...)`
    where left is reactive and right is not
- **Error** `standalone-function:reactive-operation`
  - in standalone functions (except inline first arg to `patternTool`):
    `computed(...)`, `derive(...)`, or `.map(...)` on reactive receivers

## 7. OpaqueRef JSX Rewriting

`OpaqueRefJSXTransformer` runs only when helper import is present.

### 7.1 Top-level behavior

For each `JsxExpression`:

- skip empty JSX expressions and event-handler attributes
- run data-flow analysis (`createDataFlowAnalyzer`)
- if no rewrite required and no logical binary operators (`&&`, `||`), skip
- in safe context:
  - only semantic logical rewrites (`&&`/`||`) are considered
  - derive/computed wrapping is skipped
- in `mode: "error"`:
  - report `opaque-ref:jsx-expression` for non-safe contexts requiring rewrite
  - no rewrite

### 7.2 Emitter behaviors

The rewriter uses normalized data-flow dependencies and ordered emitters:

1. property access
2. binary expression
3. call expression
4. template expression
5. conditional expression
6. element access
7. prefix unary
8. container expression

Key rewrite rules:

- `a && b`:
  - may become `when(condition, value)` if right side is expensive (JSX or
    reactive) or left side is opaque-typed
- `a || b`:
  - may become `unless(condition, fallback)` under same criteria
- ternary `cond ? x : y`:
  - becomes `ifElse(cond, x, y)` with branch/predicate processing
- non-safe contexts:
  - complex reactive expressions are wrapped via `computed(() => expr)` (later
    lowered to `derive`)
- safe contexts:
  - no derive/computed wrappers; only child rewrites and logical conversions

Synthetic calls generated by this pass register result types in `typeRegistry`
for later schema injection.

## 8. Computed Lowering

`ComputedTransformer` rewrites CommonTools `computed(...)` calls:

- `computed(arg)` -> `__ctHelpers.derive({}, arg)` (exactly one argument)
- preserves call type arguments
- does not additionally validate callback shape in this pass
- preserves type information through `typeRegistry`

It runs only when source text contains `computed` or AST scan finds computed
calls.

## 9. Closure Transformation

`ClosureTransformer` runs only when helper import is present. Strategy order:

1. handler JSX attribute strategy
2. action strategy
3. map strategy
4. patternTool strategy
5. derive strategy

### 9.1 Capture model

Capture analysis:

- captures identifiers/property chains declared outside callback scope
- excludes imports, module-scoped declarations, function declarations, type
  parameters, JSX tag names, property keys
- captures nested callback closures with filtering for outer locals/params
- builds hierarchical capture trees by root path

### 9.2 Handler strategy

Transforms inline JSX event handlers:

- `<el onClick={() => ...} />` ->
  `onClick={handler<Event,State>((event, params) => ...)(captures)}`
- currently unwraps arrow functions only (not function expressions)
- preserves body after recursive child transforms

### 9.3 Action strategy

Transforms `action(...)` to handler factory invocation:

- `action(cb)` -> `handler<EventSchema,StateSchema>(rewrittenCb)(capturesObj)`
- event schema:
  - no event param -> `never`
  - event param present -> inferred/explicit type
- callback extraction currently supports arrow callbacks only

### 9.4 Map strategy

Transforms reactive `.map(...)` to `.mapWithPattern(...)` with explicit capture
params.

Transform eligibility:

- call must be reactive array map (`OpaqueRef<T[]>` or cell-like array) or
  syntactic derive result
- inside safe wrappers, only cell/stream maps transform; opaque maps are treated
  as auto-unwrapped and skipped
- plain array `.map()` is not transformed

Result shape:

- `receiver.map(fn[, thisArg])` ->
  `receiver.mapWithPattern(pattern(callbackSchema, resultSchema, newCallback), paramsObj[, thisArg])`
- callback receives `{ element, index?, array?, params }` (with aliasing to
  original names)
- computed destructuring keys are stabilized with generated key constants and
  derive wrappers where needed

### 9.5 Derive strategy

Transforms derive closures only when captures exist.

Supported input forms:

- 2-arg `derive(input, callback)`
- 4-arg `derive(inputSchema, resultSchema, input, callback)`

Behavior:

- merge original input and captures into one input object
- rewrite callback parameters to explicit destructuring
- resolve name collisions (`name`, `name_1`, ...)
- preserve/reinfer callback result type
- skip explicit type args when result type is uninstantiated type parameter
- register derive call type for downstream inference

If no captures are found, derive call is left unchanged.

### 9.6 patternTool strategy

Transforms `patternTool(fn[, extraParams])` to capture module-scoped reactive
values:

- collects module-scoped cell-like captures (including nested callback usage)
- merges captures into `extraParams` (captures win on key conflicts)
- extends callback object binding/type literal with capture properties
  (added types default to `unknown` when synthesized)

If no qualifying captures exist, call is unchanged.

## 10. Schema Injection

`SchemaInjectionTransformer` runs only when helper import is present. It injects
`toSchema<...>()` calls (later materialized to JSON schema literals).

### 10.1 General typing rules

- uses explicit type annotations when present
- otherwise infers from signatures/contextual types
- `_param` convention implies `never` schema for that parameter
- failed inference falls back to `unknown`
- `typeRegistry` is consulted first for synthetic nodes/types

### 10.2 `pattern(...)`

Builder schema injection supports function-first signatures and preserves that
ordering in output.

Cases:

- 2+ type args: input and result from type args
- 1 type arg: input from type arg, result inferred
- no type args:
  - if 2 schema args already present: unchanged
  - if 1 schema arg present: treated as input schema, infer result schema
  - if none: infer both

### 10.3 `handler(...)`

- with type args `<Event, State>`:
  - prepends event/state schemas
- with single function arg:
  - infers event/state schemas from parameters
  - event absent -> `never`; untyped params -> `unknown`

### 10.4 `derive(...)` and `lift(...)`

If schemas are not already present via type args:

- infer input/result schema types from arguments and callbacks
- special-case `derive({}, cb)` to treat input as exact empty object type
- literal-based input inference widens literals (`"x"` -> `string`, `1` ->
  `number`, etc.)

### 10.5 Cell factories and related APIs

Injected behaviors:

- `cell(...)`, `Cell.of(...)`, `OpaqueCell.of(...)`, `Stream.of(...)`, etc.:
  - inject schema as second argument if missing
  - if no value arg, inject `undefined` then schema
- `Cell.for(...)`-style calls:
  - wrap with `.asSchema(schema)` unless already wrapped
- `wish(...)`:
  - append schema as second argument if missing
- `generateObject(...)`:
  - ensure options object has `schema` property (merge/spread as needed)

### 10.6 Conditional helpers

Injects schemas for helper calls when absent:

- `when(condition, value)` -> prepend 3 schemas: condition/value/result
- `unless(condition, fallback)` -> prepend 3 schemas
- `ifElse(condition, ifTrue, ifFalse)` -> prepend 4 schemas

These use widened literal inference and register inferred types.

## 11. Schema Generation

`SchemaGeneratorTransformer` replaces `toSchema<T>(options?)` calls with JSON
schema literals.

Recognized call forms:

- `toSchema<T>()`
- `__ctHelpers.toSchema<T>()`

Behavior:

1. resolve type from `typeRegistry` (preferred) or checker fallback
2. evaluate literal options object
3. extract `widenLiterals` generation option
4. generate schema via `createSchemaTransformerV2`
5. merge non-generation options into resulting schema object
6. emit literal as:
   - `<schemaAst> as const satisfies __ctHelpers.JSONSchema`

Special path:

- if resolved type is `any` and type arg node is synthetic (`pos=-1,end=-1`),
  generator uses synthetic-node generation path to recover schema fidelity.

## 12. Diagnostics Message Transformation (Optional Consumer Layer)

Diagnostic message transformers are exported separately from AST transform
pipeline. Current built-in behavior:

- `OpaqueRefErrorTransformer` rewrites TypeScript messages matching
  `"Property 'get' does not exist on type 'OpaqueCell<...>'"` into
  user-facing guidance about unnecessary `.get()`.
- optional `verbose` mode appends original TypeScript message.
- `CompositeDiagnosticTransformer` returns the first matching transformer result.

## 13. Current Known Limits (Observed)

1. `.map()` on fallback expressions mixing reactive/non-reactive values is
   rejected by validation (`pattern-context:map-on-fallback`) instead of being
   transformed.
2. Generic helper functions with uninstantiated type-parameter derive result
   types can degrade schema precision (type arguments may be intentionally
   omitted).
3. Action and JSX inline handler callback extraction currently unwraps arrow
   functions only.
4. One closure fixture is explicitly skipped:
   `map-generic-type-parameter.*.skip`.

## 14. Test Coverage Snapshot

Primary fixture suites executed by `fixture-based.test.ts`:

- `ast-transform`: 29 fixtures
- `handler-schema`: 8 fixtures
- `jsx-expressions`: 39 fixtures
- `schema-transform`: 7 fixtures
- `closures`: 115 active fixtures (+1 skipped fixture pair)
- `schema-injection`: 17 fixtures

Total active fixture inputs in these suites: **215**.

Additional non-fixture unit suites cover:

- cast/pattern-context/opaque-get validation
- diagnostic message transformer behavior
- event-handler detection heuristics
- opaque-ref analysis/normalization/runtime-style APIs
- derive call helper and identifier utilities

## 15. Stability Statement

This specification is a snapshot of current behavior. Any transformer code or
fixture expectation changes should be treated as spec changes and reflected in
this document.
