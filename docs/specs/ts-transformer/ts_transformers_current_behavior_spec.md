# TypeScript Transformers Current Behavior Specification

**Status:** Implemented (current behavior)\
**Package:** `@commonfabric/ts-transformers`\
**Effective date:** March 17, 2026\
**Scope:** Compile-time behavior implemented in `packages/ts-transformers/src`
and exercised by current tests/fixtures. **Related:**

- `docs/specs/ts-transformer/ts_transformers_target_pattern_language_spec.md`
- `docs/specs/ts-transformer/ts_transformers_lowering_contract.md`
- `docs/specs/ts-transformer/ts_transformers_goals.md`

## 1. Scope And Source Of Truth

This document specifies what the transformer system currently does, not what it
is intended to do in future design docs.

Authoritative implementation sources:

- `packages/ts-transformers/src/**`
- `packages/ts-transformers/test/**`
- fixture corpus under `packages/ts-transformers/test/fixtures/**`

If this document conflicts with code or passing tests, code/tests win.

## 2. Activation And Entry Conditions

### 2.1 Default-on pre-transform

Before AST transforms, `transformCfDirective()`:

1. Scans the first non-empty source line for transform directives.
2. Unless that line is `/// <cf-disable-transform />`, injects:
   - `import * as __cfHelpers from "commonfabric";`
   - helper `h(...)` forwarding to `__cfHelpers.h`.
3. Rejects sources that contain identifier `__cfHelpers` anywhere in the AST.
4. Strips opt-out `/// <cf-disable-transform />` from the source before later
   stages.

Opt-out note:

- `/// <cf-disable-transform />` is the explicit opt-out.

### 2.2 Pipeline object

`CommonFabricTransformerPipeline` constructs one ordered pipeline with shared
mutable registries:

- `typeRegistry: WeakMap<ts.Node, ts.Type>`
- `mapCallbackRegistry: WeakSet<ts.Node>`
- `schemaHints: WeakMap<ts.Node, SchemaHint>`
- `capabilitySummaryRegistry: WeakMap<ts.Node, FunctionCapabilitySummary>`
- `diagnosticsCollector: TransformationDiagnostic[]`

## 3. Pipeline Order (Normative)

Transformers always run in this order:

1. `CastValidationTransformer`
2. `EmptyArrayOfValidationTransformer`
3. `OpaqueGetValidationTransformer`
4. `PatternContextValidationTransformer`
5. `JsxExpressionSiteRouterTransformer`
6. `ComputedTransformer`
7. `ClosureTransformer`
8. `PatternOwnedExpressionSiteLoweringTransformer`
9. `HelperOwnedExpressionSiteLoweringTransformer`
10. `PatternCallbackLoweringTransformer`
11. `SchemaInjectionTransformer`
12. `SchemaGeneratorTransformer`

The order is behaviorally significant.

## 4. Global Modes

`TransformationOptions.mode` supports:

- `transform` (default)
- `error`

Current mode-sensitive behavior:

- `JsxExpressionSiteRouterTransformer` in `error` mode reports diagnostics
  instead of rewriting JSX expressions that would require opaque-ref rewrites in
  non-compute contexts.
- Other transformers currently do not branch on mode.

## 5. Call Kind Detection Contract

`detectCallKind()` drives multiple transformers. It recognizes:

- builders: `pattern`, `handler`, `action`, `lift`, `computed`, `render`
- `derive`
- `ifElse`, `when`, `unless`
- reactive array calls (`map`, `mapWithPattern`, `filter`, `filterWithPattern`,
  `flatMap`, `flatMapWithPattern`)
- cell factories (`cell`, `Cell.of`, `OpaqueCell.of`, `Stream.of`, etc.)
- `Cell.for`-style calls
- `wish`
- `generateObject`
- `patternTool`

Detection is provenance-first:

1. symbol resolution against Common Fabric declarations/imports
2. stable alias/signature following (`const alias = computed`,
   `declare const alias: typeof ifElse`)
3. synthetic helper support for `__cfHelpers.*` nodes introduced by earlier
   passes

Remaining fallback behavior is intentionally narrow:

- unresolved bare builder identifiers can still match builders
- ambient builder declarations and ambient call-signature aliases can still
  classify as builders in type-only environments
- shadowed local helpers and object methods with Common Fabric-like names are not
  classified

Builder-placement validation uses `detectDirectBuilderCall()`, so calls to
functions returned by builders are not reclassified as direct `lift()` or
`handler()` invocations.

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
  - casts to cell-like types: `Cell`, `OpaqueCell`, `Stream`, `ComparableCell`,
    `ReadonlyCell`, `WriteonlyCell`, `Writable`, `CellTypeConstructor`

### 6.2 Empty Array Cell-Factory Validation

On cell-factory calls with an empty array literal and no explicit type argument:

- `Cell.of([])`, `Writable.of([])`, `OpaqueCell.of([])`, `Stream.of([])`,
  deprecated `cell([])`, and other recognized cell factories
- **Error** `cell-factory:empty-array`
  - explains that `[]` infers to `never[]` and suggests
    `Cell.of<MyType[]>([])`-style explicit type arguments.

No error when:

- explicit type arguments are provided
- array literal is non-empty
- first argument is not an array literal
- `.of()` has no first argument

### 6.3 Opaque `.get()` validation

On call `receiver.get()` (no args):

- if receiver cell kind resolves to `"cell"` or `"stream"`:
  - no diagnostic
- otherwise if receiver either:
  - resolves to opaque cell kind via `getCellKind()`, or
  - structurally traces back to a reactive-origin call result/alias/binding
    initialized from one of:
    - builders (`pattern`, `computed`, `lift`, `handler`, `action`, `render`)
    - `derive`
    - `ifElse`, `when`, `unless`
    - cell factories / `Cell.for`
    - `wish`
    - `generateObject`
  - **Error** `opaque-get:invalid-call`
  - message instructs direct access, clarifies only `Writable<T>`/`Cell<T>`
    reads require `.get()`.

Same-named local helpers are not treated as reactive origins unless the call
itself resolves through the Common Fabric provenance rules in §5.

### 6.4 Schema shrink validation

Validates that property paths detected by capability analysis can actually
resolve against the declared parameter type during schema shrinking.

Detection occurs in `applyShrinkAndWrap` (schema-injection.ts) and in the
`defaults_only` branch of `applyCapabilitySummaryToArgument`. After shrinking
completes, `validateShrinkCoverage` compares requested top-level path heads
against what was materialized in the shrunk result.

Path extraction (`extractAccessPath` in capability-analysis.ts) sees through
type assertions (`as any`, `as T`, angle-bracket casts) at every level of
property/element access chains. For example `(state as any).foo` resolves to a
read of `state.foo` because `unwrapExpression` is applied after each step up the
access chain. This means `as any` single casts do not hide property accesses
from capability analysis.

When interprocedural analysis is enabled (compute-context builders like `lift`,
`derive`, `handler`), read paths discovered in helper function bodies propagate
back to the caller's parameter summary, but the current MVP intentionally only
does this for resolved helper bodies in the same source file. Cross-file or
otherwise unsupported helper calls fall back to the conservative wildcard path
instead of taking partial transitive precision. This means a `lift` callback
that delegates to a local helper which reads `(x as any).foo` will trigger
shrink validation on the caller's parameter type, while the same helper body in
another file will conservatively disable shrinking for that parameter.

When a wildcard parameter (one passed to an opaque/unanalyzable function like
`console.log`) is typed `unknown`, validation emits `schema:unknown-type-access`
because the generated schema cannot express what data to fetch. This does not
apply to `any`-typed parameters (which fetch everything at runtime) or to
concrete types (which already describe the expected shape).

Declared members typed as `unknown` also trigger `schema:unknown-type-access`
when accessed, even if the property name exists in the declared interface/type
literal. This catches cases like `{ data?: unknown }` where the schema would
otherwise degrade to `{ type: "unknown" }` for that property and the runtime
could not express the required fetch shape.

Guards that skip validation:

- wildcard parameters with a non-`unknown` base type (full-shape access,
  shrinking is disabled)
- parameters with no read/write paths and no wildcard flag
- synthetic parameters injected by the pipeline (`__ct_pattern_input`,
  `__param0`, etc. — names starting with `__`)
- `never`-typed parameters (bottom type, vacuously valid)
- paths whose head is `"key"` (reactive proxy accessor injected by
  `PatternCallbackLoweringTransformer`)

Diagnostics:

- **Error** `schema:unknown-type-access`
  - parameter is typed as `unknown` and the code accesses properties, OR one or
    more accessed property heads resolve to `unknown`-typed members on an
    otherwise concrete type
  - message lists the accessed property heads and instructs the author to
    replace `unknown` with a concrete type
- **Error** `schema:path-not-in-type`
  - parameter has a concrete type but one or more accessed properties are not
    present in that type
  - message lists missing properties and the declared type text, instructs the
    author to add them

When `shrunk` is `undefined` (as in `defaults_only` mode where full shrinking is
skipped), validation falls back to inspecting the base type node directly.

Union and array type support: validation uses `typeHasProperty()` which checks
whether a specific property head resolves against the type through three layers:
the shrunk TypeNode, the base TypeNode, and the resolved `ts.Type`. For union
types (e.g. `{ amount?: number } | undefined`), non-nullish constituents are
checked individually — a head is valid if ANY non-nullish member has it. For
array types (e.g. `number[]`), numeric heads like `"0"` are valid when the type
has a numeric index signature. TypeReferences within unions are resolved to
their declaration members. This eliminates false `schema:path-not-in-type`
errors on nullable/optional union patterns and array index accesses.

### 6.5 Pattern-context validation

Enforces restricted reactive context rules.

Restricted contexts are callbacks of:

- `pattern`
- `render`
- transformed array-method callbacks (`.map(...)`, `.filter(...)`,
  `.flatMap(...)` and their `...WithPattern(...)` forms)

Compute wrappers override restrictions:

- `computed`, `action`, `derive`, `lift`, `handler` callbacks
- inline JSX `on*` handlers
- standalone function definitions
- JSX expressions (handled by opaque-ref JSX transformer)

Diagnostics emitted in all modes:

- **Error** `pattern-context:get-call`
  - `.get()` call in restricted reactive context
- **Error** `pattern-context:function-creation`
  - function creation in pattern context unless inside compute
    wrappers/JSX/allowed callbacks
- **Error** `pattern-context:builder-placement`
  - direct `lift()` or `handler()` inside restricted context
  - special message for immediate `lift(fn)(args)` suggesting `computed()`
- **Error** `standalone-function:reactive-operation`
  - in standalone functions (except inline first arg to `patternTool`):
    `computed(...)`, `derive(...)`, or reactive collection methods on reactive
    receivers
  - collection-method diagnostics currently use `.map(...)`-style guidance and
    suggest eager `<cell>.get().map(...)` when explicit eager mapping is
    acceptable
- **Error** `compute-context:local-reactive-use`
  - inside a `computed(...)`/`derive(...)` callback, a reactive value created in
    that same callback is consumed as a plain value in control-flow or another
    non-lowered computation site
  - typical culprits are local `computed(...)`, `derive(...)`, `lift(...)`,
    `wish(...)`, or reactive collection aliases and their property accesses
  - message instructs the author to move the use into a nested
    `computed(() => ...)` or `derive(() => ...)`
- **Error** `pattern-context:optional-chaining`
  - optional calls in restricted reactive context (outside JSX)
  - optional property / element access that appears outside a supported
    lowerable expression site
- **Error** `pattern-context:computation`
  - binary/unary/conditional computations using opaque dependencies outside
    wrappers
  - validation first checks the shared lowerable-expression-site policy; only
    non-lowerable computation sites still report this error
- **Error** `pattern-context:map-on-fallback`
  - `(opaqueExpr ?? fallback).map(...)` or `(opaqueExpr || fallback).map(...)`
    where left is reactive and right is not

### 6.6 Pattern Result Schema Inference

When `pattern()` is called with zero or one type parameters and the result
schema must be inferred, CTS requires the inferred top-level result shape to be
structurally representable.

- structurally recoverable object-literal returns still emit concrete object
  schemas even when some individual property values come from `any`-typed
  expressions
- direct top-level `any` / `unknown` result inference emits
  `pattern:any-result-schema`
- authors who intentionally want a permissive/opaque output boundary must make
  it explicit with `pattern<Input, Output>(...)`

This inference runs through `collectFunctionSchemaTypeNodes` via
`inferReturnType`, object-literal recovery, and direct projection recovery.

## 7. JSX Expression Site Routing And Early Rewriting

`JsxExpressionSiteRouterTransformer` runs only when helper import is present.

### 7.1 Top-level behavior

For each `JsxExpression`:

- skip empty JSX expressions and event-handler attributes
- run data-flow analysis (`createDataFlowAnalyzer`)
- if no rewrite required and no logical binary operators (`&&`, `||`), skip
- in compute context:
  - only semantic logical rewrites (`&&`/`||`) are considered
  - derive/computed wrapping is skipped
- compute-context JSX does not lower `&&` / `||`
- pattern-context JSX lowers `&&` / `||` deterministically
- in `mode: "error"`:
  - report `opaque-ref:jsx-expression` for non-compute contexts requiring
    rewrite
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

- `a && b`: lowers to `when(condition, value)` only in pattern context
- `a || b`: lowers to `unless(condition, fallback)` only in pattern context
- ternary `cond ? x : y`:
  - becomes `ifElse(cond, x, y)` with branch/predicate processing
- non-compute contexts:
  - complex reactive expressions are wrapped via `computed(() => expr)` (later
    lowered to `derive`)
- compute contexts:
  - no derive/computed wrappers; only child rewrites and logical conversions

Helper-owned compute branches introduced by ternary / conditional-helper
rewriting are re-analyzed with synthetic compute ownership. This preserves
plain-array semantics inside fully compute-wrapped branches while still letting
later stages recover reactive collection rewrites for locally rewrapped aliases
created inside compute code.

Synthetic calls generated by this pass register result types in `typeRegistry`
for later schema injection.

## 8. Computed Lowering

`ComputedTransformer` rewrites Common Fabric `computed(...)` calls:

- `computed(arg)` -> `__cfHelpers.derive({}, arg)` (exactly one argument)
- preserves call type arguments
- does not additionally validate callback shape in this pass
- preserves type information through `typeRegistry`

It runs only when source text contains `computed` or AST scan finds computed
calls.

## 9. Closure Transformation

`ClosureTransformer` runs only when helper import is present. Strategy order:

1. handler JSX attribute strategy
2. action strategy
3. array-method strategy
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

### 9.4 Array-method strategy

Transforms eligible reactive collection operators to explicit `...WithPattern`
forms with explicit capture params.

Transform eligibility:

- decision is context/receiver-policy driven:
  - pattern context + reactive receiver origin -> transform
  - compute context + `celllike_requires_rewrite` receiver kind -> transform
  - compute context + `opaque_autounwrapped` receiver kind -> do not transform
  - compute context + local alias in the same callback whose initializer
    re-wraps a reactive collection (`computed`, `derive`, `lift`, `action`,
    `handler`, `wish`, already-rewritten collection calls, or other reactive
    cell-like receivers) -> transform
- plain array `.map()` is not transformed
- transformed callbacks are marked in `mapCallbackRegistry` and become
  pattern-callback contexts for downstream classification
- synthetic compute-owned array-method nodes assert that stale pattern ownership
  is not retained after earlier rewrites

Result shape:

- `receiver.<method>(fn[, thisArg])` ->
  `receiver.<method>WithPattern(pattern(callbackSchema, resultSchema, newCallback), paramsObj[, thisArg])`
- currently supported methods are `map`, `filter`, and `flatMap`
- callback schema includes `{ element, index?, array? }` and adds `params` only
  when captures exist
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
- extends callback object binding/type literal with capture properties (added
  types default to `unknown` when synthesized)

If no qualifying captures exist, call is unchanged.

### 9.7 Pattern callback lowering

`PatternCallbackLoweringTransformer` runs after closure transformation.

Primary behaviors:

- rewrites pattern-style callback parameter destructuring to explicit input
  bindings with `input.key(...)`-based prologues
- lowers property/optional-navigation reads on opaque roots to `.key(...)`
  access in pattern contexts
- preserves terminal path methods (`get`, `set`, `update`, etc.) and rewrites
  only the receiver path portion when needed
- treats dynamic key access, spread, and optional-call forms as non-lowerable in
  pattern context with diagnostics
- treats wildcard traversals (`Object.keys/values/entries`, `JSON.stringify`) as
  broad/full-shape access for capability analysis, but allows whole-call
  lowering when they appear in supported expression-root positions
- classifies map captures as reactive vs non-reactive and avoids `.key(...)`
  rewrites for non-reactive captures
- recursively rewrites derive callback bodies so locally-declared
  opaque/reactive aliases created inside compute callbacks (including inside
  nested blocks) also receive `.key(...)` lowering
- local opaque-root discovery is symbol-scoped and block-aware to avoid
  same-name false rewrites across scopes
- extracts static destructuring defaults into capability summaries for schema
  default application
- registers capability summaries for transformed callbacks/builders for
  downstream schema shrinking/wrapping

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

When inferring the result schema (0 or 1 type args), CTS requires a
structurally representable top-level result:

- structurally recoverable object-literal returns still emit concrete object
  schemas when CTS can recover their shape (see §6.6)
- direct top-level `any` / `unknown` result inference emits
  `pattern:any-result-schema`
- permissive/opaque result semantics are still allowed when made explicit via a
  result type parameter

### 10.3 `handler(...)`

- with type args `<Event, State>`:
  - prepends event/state schemas
  - unresolved generic helper-definition-site type parameters degrade to
    `{ type: "unknown" }`
- with single function arg:
  - infers event/state schemas from parameters
  - event absent -> `never`; untyped params -> `unknown`

### 10.4 `derive(...)` and `lift(...)`

If schemas are not already present via type args:

- infer input/result schema types from arguments and callbacks
- special-case `derive({}, cb)` to treat input as exact empty object type
- literal-based input inference widens literals (`"x"` -> `string`, `1` ->
  `number`, etc.)
- when inferred result type is missing or degrades to `any`/`unknown`, recovery
  first attempts object-literal return reconstruction and then direct projection
  recovery (`x => x.foo`, `x => x["foo"]`)
- direct projection recovery can reuse result types recovered from local
  `lift(...)` / `derive(...)` initializer aliases registered in `typeRegistry`
- unresolved generic helper-definition-site type parameters degrade to
  `{ type: "unknown" }` when schemas are injected from explicit builder type
  arguments

### 10.5 Cell factories and related APIs

Injected behaviors:

- `cell(...)`, `Cell.of(...)`, `OpaqueCell.of(...)`, `Stream.of(...)`, etc.:
  - inject schema as second argument if missing
  - if no value arg, inject `undefined` then schema
  - value inference first uses registry/initializer recovery for transformed
    expressions before falling back to the direct value type
  - direct semantic `any` values emit `true`
  - direct semantic `unknown` values emit `{ type: "unknown" }`
  - if the value type at a generic helper definition site is an uninstantiated
    type parameter, CTS degrades the emitted schema to `{ type: "unknown" }`
    instead of leaking `{}` or omitting the schema
- `Cell.for(...)`-style calls:
  - wrap with `.asSchema(schema)` unless already wrapped
- `wish(...)`:
  - append schema as second argument if missing
  - explicit or contextual unresolved generic type parameters degrade to
    `{ type: "unknown" }`
- `generateObject(...)`:
  - ensure options object has `schema` property (merge/spread as needed)
  - explicit or contextual unresolved generic result types degrade to
    `{ type: "unknown" }`

### 10.6 Conditional helpers

Injects schemas for helper calls when absent:

- `when(condition, value)` -> prepend 3 schemas: condition/value/result
- `unless(condition, fallback)` -> prepend 3 schemas
- `ifElse(condition, ifTrue, ifFalse)` -> prepend 4 schemas

These use widened literal inference and register inferred types.

### 10.7 Capability summary application

When capability summaries are available, schema injection applies wrapper/path
adjustments:

- wrapper selection based on observed capability:
  - `readonly` -> `ReadonlyCell<T>`
  - `writeonly` -> `WriteonlyCell<T>`
  - `writable` -> `Writable<T>`
  - `opaque` -> `OpaqueCell<T>`
- compute-oriented boundaries apply full path shrink + wrapper selection
- type aliases and interfaces (TypeReferenceNodes) are resolved to their
  declaration members and shrunk in-place, preserving source-level type
  annotations (Date formats, enum literals, `$ref`/`$defs`). When all members
  are retained the original TypeReference is kept for schema fidelity.
- pattern boundaries apply defaults-only mode to preserve broad shape continuity
  while still applying extracted static defaults
- wildcard roots disable path shrinking for affected parameters/arguments
- capability analysis resolves member access through `.get()` when the member
  access itself is observed (`notes.get().length` records `["length"]` rather
  than a blanket root read) and suppresses the redundant blanket `.get()` read
- array-like roots whose observed paths only touch non-item properties
  (`length`, `get`, `set`, `key`, `update`) keep array shape but shrink their
  item type to `unknown`
- node-driven shrinking can still shrink the inner type of cell-like wrappers
  when `.get()` contributes an empty path but coexists with more specific
  non-empty paths
- tuple types and numeric-indexed object types are not rewritten to
  array-with-unknown-items during this optimization
- after shrinking, `validateShrinkCoverage` checks that all requested property
  paths were materialized (see §6.4); unresolvable paths produce hard errors

## 11. Schema Generation

`SchemaGeneratorTransformer` replaces `toSchema<T>(options?)` calls with JSON
schema literals.

Recognized call forms:

- `toSchema<T>()`
- `__cfHelpers.toSchema<T>()`

Behavior:

1. resolve type from `typeRegistry` (preferred) or checker fallback
2. evaluate literal options object
3. extract `widenLiterals` generation option
4. generate schema via `createSchemaTransformerV2`
5. merge non-generation options into resulting schema object
6. emit literal as:
   - `<schemaAst> as const satisfies __cfHelpers.JSONSchema`

Special path:

- if resolved type is `any` and type arg node is synthetic (`pos=-1,end=-1`),
  generator uses synthetic-node generation path to recover schema fidelity.
- synthetic union handling preserves `undefined` members (for example
  `string | undefined` retains an explicit `undefined` branch in generated
  schema).
- `unknown` is emitted distinctly as `{ type: "unknown" }`; `any` remains `true`
- arrays of `unknown` emit `items: { type: "unknown" }`
- synthetic unions preserve explicit `{ type: "unknown" }` members in `anyOf`
  rather than collapsing them away
- `OpaqueRef<T>` does not emit `asOpaque`; only cell/stream wrappers add wrapper
  markers such as `asCell` / `asStream`

## 12. Diagnostics Message Transformation (Optional Consumer Layer)

Diagnostic message transformers are exported separately from AST transform
pipeline. Current built-in behavior:

- `OpaqueRefErrorTransformer` rewrites TypeScript messages matching
  `"Property 'get' does not exist on type 'OpaqueCell<...>'"` into user-facing
  guidance about unnecessary `.get()`.
- optional `verbose` mode appends original TypeScript message.
- `CompositeDiagnosticTransformer` returns the first matching transformer
  result.

## 13. Current Known Limits (Observed)

1. Generic helper functions with uninstantiated type-parameter derive result
   types can degrade schema precision (type arguments may be intentionally
   omitted).
2. Action and JSX inline handler callback extraction currently unwraps arrow
   functions only.
3. Optional-call forms on opaque pattern roots are non-lowerable and report
   `pattern-context:optional-chaining` diagnostics. Optional property/element
   access is supported only in explicit lowerable expression sites; statement-
   position optional access still errors.
4. Non-static destructuring defaults, rest destructuring, and unsupported
   computed destructuring keys in pattern callbacks remain non-lowerable and
   produce pattern-context diagnostics.
5. Interprocedural capability propagation applies only when a resolved callee
   declaration is analyzable in-proc (arrow/function
   expression/declaration/method); external/unresolved calls remain
   conservative.

## 14. Test Coverage Snapshot

Primary fixture suites executed by `fixture-based.test.ts`:

- `ast-transform`: 28 fixtures
- `handler-schema`: 8 fixtures
- `jsx-expressions`: 39 fixtures
- `schema-transform`: 8 fixtures
- `closures`: 141 fixtures
- `schema-injection`: 19 fixtures

Total active fixture inputs in these suites: **237**.

Additional non-fixture unit suites cover:

- cast/empty-array/pattern-context/opaque-get/schema-shrink validation
- diagnostic message transformer behavior
- event-handler detection heuristics
- opaque-ref analysis/normalization/runtime-style APIs
- pipeline regression and policy/capability-analysis behavior
- derive call helper and identifier utilities

## 15. Stability Statement

This specification is a snapshot of current behavior. Any transformer code or
fixture expectation changes should be treated as spec changes and reflected in
this document.
