# TypeScript Transformers Current Behavior Specification

**Status:** Implemented (current behavior)\
**Package:** `@commonfabric/ts-transformers`\
**Effective date:** April 6, 2026\
**Scope:** Compile-time behavior implemented in `packages/ts-transformers/src`
and exercised by current tests/fixtures. **Related:**

- `docs/specs/ts-transformer/ts_transformers_target_pattern_language_spec.md`
- `docs/specs/ts-transformer/ts_transformers_lowering_contract.md`
- `docs/specs/ts-transformer/ts_transformers_goals.md`
- `docs/specs/ts-transformer/cfc_authoring_contract.md` (draft, not current
  implemented behavior)
- `docs/specs/ts-transformer/cfc_ui_helper_contract.md` (draft, not current
  implemented behavior)

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
   - `import { __cfHelpers } from "commonfabric";` (a named import of the
     internal helper binding, not a namespace import)
   - a forwarding `h(...)` helper delegating to `__cfHelpers.h` (so authors
     need not import the JSX factory manually, and so the helper module is not
     tree-shaken before binding).
3. Rejects sources that contain identifier `__cfHelpers` anywhere in the AST.
4. Strips opt-out `/// <cf-disable-transform />` from the source before later
   stages.

These string-level steps run in `transformCfDirective()`
(`src/core/cf-helpers.ts`) before any AST transformer, because symbol binding
happens before the transformer pipeline runs.

Opt-out note:

- `/// <cf-disable-transform />` is the explicit opt-out.

### 2.2 Pipeline object and cross-stage state

`CommonFabricTransformerPipeline` (`src/cf-pipeline.ts`) constructs one ordered
pipeline from `CFC_TRANSFORMER_STAGE_SPECS`. Every stage shares:

- a single `diagnosticsCollector: TransformationDiagnostic[]`
- a single `CrossStageState` instance (`src/core/cross-stage-state.ts`), which
  is the sole owner of cross-transformer communication. It replaced the
  formerly-separate registry fields on `TransformationOptions`.

`CrossStageState` organizes its registries into three deliberate families
(mirroring the TypeScript compiler's `NodeLinks` pattern):

1. **Bare cross-package maps** — the published boundary contract, read directly
   as plain `WeakMap`s by the separate schema-generator package, which must not
   depend on `CrossStageState`:
   - `typeRegistry: WeakMap<ts.Node, ts.Type>`
   - `schemaHints: WeakMap<ts.Node, SchemaHint>`
2. **`nodeLinks` side table** — a `WeakMap<ts.Node, NodeTypeLinks>` for
   transformer-internal, non-cache-invalidating per-node channels, reached only
   through record/lookup/mark/is accessors:
   - `capabilitySummary` (formerly the separate `capabilitySummaryRegistry`)
   - `schemaInjected` — a presence flag marking builder call/`new` nodes that
     SchemaInjection has finalized, replacing the scattered arg-count
     idempotency guards. It uses a plain presence check with **no**
     `getOriginalNode` fallback (it tags synthetic nodes whose original is the
     pre-injection user call).
3. **Marker family** — node/symbol-keyed `WeakSet`s whose membership checks fall
   back through `getOriginalNode`, and whose mutators are coupled to the
   context's reactive-analysis cache invalidation (invalidation is a
   `TransformationContext` concern; `CrossStageState` stays a pure data holder):
   - `mapCallbackRegistry` (transformed array-method callbacks)
   - `syntheticComputeCallbackRegistry`
   - `syntheticComputeOwnedNodeRegistry`
   - `syntheticReactiveCollectionRegistry` (keyed by `ts.Symbol`)

## 3. Pipeline Order (Normative)

The authoritative ordering lives in `CFC_TRANSFORMER_STAGE_SPECS` /
`CFC_TRANSFORMER_STAGE_NAMES` in `src/cf-pipeline.ts`. Transformers always run
in this order (19 stages):

1. `CastValidationTransformer`
2. `EmptyArrayOfValidationTransformer`
3. `OpaqueGetValidationTransformer`
4. `PatternContextValidationTransformer`
5. `JsxExpressionSiteRouterTransformer`
6. `LiftLoweringTransformer`
7. `ClosureTransformer`
8. `PatternOwnedExpressionSiteLoweringTransformer`
9. `HelperOwnedExpressionSiteLoweringTransformer`
10. `WriteAuthorizedByValidationTransformer`
11. `PatternCallbackLoweringTransformer`
12. `SchemaInjectionTransformer`
13. `BuilderCallHoistingTransformer`
14. `SchemaGeneratorTransformer`
15. `ReactiveVariableForTransformer`
16. `ModuleScopeShadowingTransformer`
17. `ModuleScopeCfDataTransformer`
18. `PatternCoverageTransformer`
19. `ModuleScopeFunctionHardeningTransformer`

The order is behaviorally significant (invariant C-002). Two ordering facts
worth calling out:

- `BuilderCallHoistingTransformer` (stage 13) runs **after**
  `SchemaInjectionTransformer` (stage 12) so each builder call it relocates to
  module scope already carries its injected schemas — see CT-1644 and
  `packages/ts-transformers/docs/derive-to-lift-design.md`. This stage hoists
  `lift`, `handler`, and `pattern` builder calls. It absorbed and replaced the
  former separate `LiftHoistingTransformer` (which hoisted only `lift`); the
  even-older `BuilderCallbackHoistingTransformer` was deleted (#3864). Earlier
  spec revisions listing those two as distinct stages are obsolete.
- The final five stages (15–19) run last so they operate on fully lowered and
  schema-injected output.
- `PatternCoverageTransformer` (stage 18) does no work unless pattern runtime
  coverage is enabled. When enabled, it runs before
  `ModuleScopeFunctionHardeningTransformer` so coverage counters are added to
  authored bodies before hardening helpers are emitted.

## 4. Global Modes

`TransformationOptions.mode` supports:

- `transform` (default)
- `error`

Current mode-sensitive behavior:

- `JsxExpressionSiteRouterTransformer` in `error` mode reports diagnostics
  instead of rewriting JSX expressions that would require reactive rewrites in
  non-compute contexts.
- Other transformers currently do not branch on mode.

## 5. Call Kind Detection Contract

`detectCallKind()` drives multiple transformers. The set of recognized Common
Fabric runtime exports — and, for each, its call category and whether it is a
**reactive origin** — is defined in one place:
`COMMONFABRIC_RUNTIME_EXPORT_REGISTRY`
(`src/core/commonfabric-runtime-registry.ts`). A guard test
(`test/core/commonfabric-runtime-registry.test.ts`) asserts the registry covers
every callable the runner's builder factory injects, so the registry — not this
list — is the authoritative source. As of this writing it recognizes:

- builders (all reactive-origin): `pattern`, `handler`, `action`, `lift`,
  `computed`, `render`. (`byRef` is a registered-but-`ignored` export.)
- conditional-helper calls: `ifElse`, `when`, `unless`
- reactive array calls (`map`, `mapWithPattern`, `filter`, `filterWithPattern`,
  `flatMap`, `flatMapWithPattern`)
- cell factories (`cell`, `new Cell`, `new OpaqueCell`, `new Stream`, etc.),
  with legacy `.of(...)` still accepted
- `Cell.for`-style calls
- `wish`
- `generateObject` and `generateText`
- the `runtime-call` family — tagged-call / function runtime origins: `str`,
  `llm`, `llmDialog`, `fetchJson`, `fetchProgram`, `streamData`,
  `compileAndRun`, `navigateTo`, and the SQLite builtins `sqliteDatabase` /
  `sqliteQuery` (`sqliteQuery<Row>` additionally gets dedicated type-argument
  schema injection)
- `patternTool` — recognized, but explicitly **not** a reactive origin
  (`reactiveOrigin: false`)

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
  - casts to `Reactive<...>`
- **Error** `cast-validation:cell-cast`
  - casts to cell-like types: `Cell`, `OpaqueCell`, `Stream`, `ComparableCell`,
    `ReadonlyCell`, `WriteonlyCell`, `Writable`, `CellTypeConstructor`

### 6.2 Empty Array Cell-Factory Validation

On cell-factory calls with an empty array literal and no explicit type argument:

- `new Cell([])`, `new Writable([])`, `new OpaqueCell([])`, `new Stream([])`,
  deprecated `cell([])`, and other recognized cell factories
- **Error** `cell-factory:empty-array`
  - explains that `[]` infers to `never[]` and suggests
    `new Cell<MyType[]>([])`-style explicit type arguments.

No error when:

- explicit type arguments are provided
- array literal is non-empty
- first argument is not an array literal
- `.of()` has no first argument

### 6.3 Opaque `.get()` validation

On call `receiver.get()` (no args):

- if receiver cell kind resolves to `"cell"` or `"stream"`:
  - no diagnostic (these types legitimately have `.get()`)
- otherwise if receiver either:
  - resolves to opaque cell kind (`"opaque"`) via `getCellKind()`, or
  - is structurally reactive — `isReactiveExpression` walks the receiver and
    treats it as reactive when it is (or its property/element-access root is):
    - a **`pattern` / `render` callback parameter** (including via destructured
      binding elements), or
    - a local variable whose initializer is a **reactive-origin call** (after
      stripping non-null/parenthesized/cast wrappers and property/element-access
      tails), as defined by `isReactiveOriginCall` / the runtime registry (§5):
      reactive-origin builders (`pattern`, `computed`, `lift`, `handler`,
      `action`, `render`), the lift-applied shape, `ifElse` / `when` / `unless`,
      cell factories / `Cell.for`, `wish`, `generateObject`, `generateText`, and
      the `runtime-call` family (`str`, `llm`, …)
  - **Error** `opaque-get:invalid-call`
  - message instructs direct access, clarifies only `Writable<T>`/`Cell<T>`
    reads require `.get()`.

Deliberate non-coverage of the structural fallback: `lift` / `handler` /
`action` callback **parameters** are not inferred as opaque from structure
alone — they keep their declared cell semantics. The structural inference exists
only for the `Reactive<T> = T` identity-alias case where the cell brand is
gone.

Same-named local helpers are not treated as reactive origins unless the call
itself resolves through the Common Fabric provenance rules in §5.

### 6.4 Schema shrink validation

Validates that property paths detected by capability analysis can actually
resolve against the declared parameter type during schema shrinking.

Detection occurs in `applyShrinkAndWrap` and `validateShrinkCoverage` (both in
`type-shrinking.ts`; `schema-injection.ts` and `lift-applied-strategy.ts` call
into them), including the `defaults_only` branch of
`applyCapabilitySummaryToArgument`. After shrinking completes,
`validateShrinkCoverage` compares requested top-level path heads against what
was materialized in the shrunk result.

Path extraction (`extractAccessPath` in capability-analysis.ts) sees through the
non-semantic wrappers `unwrapExpression` strips — parenthesization, `as`
assertions, angle-bracket type assertions, `satisfies`, and non-null (`!`) — at
every level of property/element access chains. `unwrapExpression` is applied to
the receiver after each property/element step, so for example `(state as any)
.foo` resolves to a read of `state.foo`. This means single casts (or
`satisfies`/`!` wrappers) do not hide property accesses from capability
analysis.

When interprocedural analysis is enabled (compute-context builders like `lift`,
`handler`), read paths discovered in helper function bodies propagate
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
- `any`-typed parameters (top type; the runtime fetches everything, so every key
  is reachable — this is what distinguishes `any` from `unknown`)
- paths whose head is `"key"` (reactive proxy accessor injected by
  `PatternCallbackLoweringTransformer`)

Diagnostics:

- **Error** `schema:unknown-type-access`
  - fires in any of these cases:
    - parameter base type is `unknown` and the code accesses properties
    - parameter base type is an **uninstantiated generic type parameter** and
      the code accesses properties (the `isUnknownBase` check treats
      `TypeFlags.TypeParameter` like `Unknown` — an unresolved `<T>` base cannot
      express a fetch shape any more than `unknown` can)
    - one or more accessed property heads resolve to `unknown`-typed **members**
      on an otherwise concrete type (e.g. `{ data?: unknown }`)
    - a **wildcard** parameter (passed to an opaque/unanalyzable function) whose
      base type is `unknown` (see the wildcard note above)
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

- `computed`, `action`, `lift`, `handler` callbacks
- inline JSX `on*` handlers
- standalone function definitions
- JSX expressions (handled by reactive JSX transformer)
- the SQLite `table(columns, (row) => ({...}))` row-label rule callback —
  classified as the supported `sqlite-row-label-rule` compute boundary
  (`callback-boundary.ts`). `table()` is recognized by name **plus** the
  `SqliteTableFunction` type alias from Common Fabric's own typings (so an
  unrelated user function named `table` does not match). The rule callback is
  evaluated eagerly at pattern build into a serialized JSON AST, so it is
  compute-owned and is deliberately exempt from SES self-containment validation
  (see the `ses-callback:callable-capture` exclusion below).

Diagnostics emitted in all modes:

- **Error** `pattern-context:get-call`
  - `.get()` call in restricted reactive context
- **Error** `pattern-context:function-creation`
  - function creation in pattern context unless inside compute
    wrappers/JSX/allowed callbacks
  - class expression or declaration in pattern context unless inside compute
    wrappers; the whole class is flagged once with a class-specific message
- **Error** `pattern-context:object-member`
  - a function-valued member of an object literal in pattern or render
    context: a method, getter, setter, or a property whose value is an
    arrow/function expression (including inside JSX data positions, and when
    the function is wrapped in transparent expressions — parentheses, `as`,
    `satisfies`, `!`, `<T>`)
  - rejected regardless of the body, because the reactive-read lowering pass
    does not descend into function bodies; the sole exception is a `toJSON`
    member, which is reported only when its body reads a reactive value
  - the message names the mechanism per kind: a getter or `toJSON()` member
    runs once when the result is stored and freezes its return to a snapshot; a
    method, setter, or function-valued property is a function value the
    reactive data model cannot store (it throws `Cannot store function per se`)
  - exempt: members inside compute wrappers (computed/lift/handler/action),
    object literals outside pattern/render context, JSX event handlers,
    array-method/render callbacks, and a `toJSON` member that reads no reactive
    value (a toJSON-bearing object is storable — the data model converts it via
    `toJSON()`); class members are covered separately by
    `pattern-context:function-creation`
- **Error** `pattern-context:builder-placement`
  - direct `lift()` or `handler()` inside restricted context
  - special message for immediate `lift(fn)(args)` suggesting `computed()`
- **Error** `standalone-function:reactive-operation`
  - in standalone functions (except inline first arg to `patternTool`):
    `computed(...)`, `lift(...)`, or reactive collection methods on reactive
    receivers
  - collection-method diagnostics currently use `.map(...)`-style guidance and
    suggest eager `<cell>.get().map(...)` when explicit eager mapping is
    acceptable
- **Error** `compute-context:local-reactive-use`
  - inside a `computed(...)`/`lift(...)` callback, a reactive value created in
    that same callback is consumed as a plain value in control-flow or another
    non-lowered computation site
  - typical culprits are local `computed(...)`, `lift(...)`,
    `wish(...)`, or reactive collection aliases and their property accesses
  - message instructs the author to move the use into a nested
    `computed(() => ...)` or module-scope `lift()`
- **Error** `pattern-context:optional-chaining`
  - optional calls in restricted reactive context (outside JSX)
  - optional property / element access that appears outside a supported
    lowerable expression site
- **Error** `pattern-context:computation`
  - binary/unary/conditional computations using opaque dependencies outside
    wrappers
  - also the catch-all for other non-lowerable reactive reads at a top-level
    pattern site — notably **bare dynamic key (element) access** like
    `scopes[key]` directly in a pattern-body value position (the target-language
    spec's "bare dynamic key access in top-level pattern-facing code" =
    Unsupported). The same access is fine inside JSX, a computation callback, a
    collection callback, or a structural binding form.
  - validation first checks the shared lowerable-expression-site policy; only
    non-lowerable computation sites still report this error (so `items[0].name`,
    `name.toUpperCase()` at lowerable top-level sites, and dynamic keys inside
    supported contexts validate clean)
- **Error** `pattern-context:callback-container`
  - a callback passed to an **unsupported container** in pattern-facing JSX
    (the callback-boundary decision is `unsupported` with
    `boundaryDiagnostic === "callback-container"`) — e.g. a foreign imperative
    container root like `[0, 1].forEach(() => list.map(...))`. This is the
    diagnostic counterpart of the target-language spec's "foreign callback /
    imperative container roots" unsupported bucket. Guidance: use a supported
    array-method/value call, an event handler, or move the work into
    `computed(() => ...)`, module-scope `lift()`, or a helper.
- **Error** `pattern-context:patterntool-requires-pattern`
  - `patternTool(fn, ...)` where the first argument is a bare callback (arrow /
    function expression) rather than a `pattern(...)`. The runtime/transformer
    auto-wrapping (`pattern(fn)`) and auto-capture were removed in CT-1655;
    authors now wrap explicitly: `patternTool(pattern(fn), extraParams?)`. The
    diagnostic is reported on the bare-callback argument.
- **Error** `ses-callback:callable-capture`
  - a callback at an SES-self-contained boundary captures a **callable**
    declared in an enclosing function scope. The boundary kinds that require
    self-containment are `SES_SELF_CONTAINED_CALLBACK_BOUNDARIES`:
    `event-handler`, `reactive-array-method`, `pattern-tool`, `pattern-builder`,
    `render-builder`, `lift-applied`, `computed-builder`, `action-builder`,
    `lift-builder`, `handler-builder`. (`sqlite-row-label-rule` is deliberately
    excluded — `table()` evaluates its rule callback eagerly at pattern build
    into a serialized AST, so capture is harmless there.) SES callback
    implementations must be self-contained. Guidance: move callable helpers to
    module scope, or pass serializable data through explicit inputs/state.
    Capturing non-callable reactive data is still allowed.

Removed diagnostic (behavior change, PR #3154 pattern-language-boundary): the
former `pattern-context:map-on-fallback` error no longer exists.
Fallback-guarded reactive collection forms such as `(items ?? []).map(...)`,
`(items || []).filter(...)`, and `(items ?? []).flatMap(...)` — including
cast-/`satisfies`-wrapped reactive left sides — are now **supported** and emit no
fallback-specific diagnostic. `test/validation.test.ts` retains these as
regression guards asserting the forms validate clean.

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

### 6.7 Lowerable Expression-Site Categories

The shared expression-site policy recognizes seven authored container kinds via
`getExpressionContainerKind` (the `ExpressionContainerKind` union in
`expression-site-types.ts`):

- `jsx-expression`
- `template-span` (an interpolated `${…}` span inside a tagged template, e.g.
  a `str`-tagged template)
- `return-expression`
- `variable-initializer`
- `call-argument`
- `object-property`
- `array-element`

Those container kinds are the raw building blocks for the author-facing buckets
described in the target-language spec:

- JSX expressions
- top-level pattern-body value-expression sites
- callback-local value-expression sites inside supported reactive collection
  callbacks

`findLowerableExpressionSite` walks outward through enclosing pattern-context
containers until it finds the nearest lowerable site admitted by
`classifyExpressionSiteHandling`.

`findPreferredNestedLowerableExpressionSite` is narrower: it only picks nested
structural sites with container kinds `call-argument`, `object-property`, or
`array-element`.

These categories do not mean "rewrite every descendant expression." Explicit
computation callbacks still create their own ownership boundary, and every site
must separately satisfy the shared handling policy.

In particular, explicit compute callbacks remain an ownership boundary for
recursive lowering. That boundary does not disappear just because the callback
returns JSX: ternaries and logical control flow inside the compute callback
body stay authored JavaScript rather than recursively lowered helper control
flow.

### 6.8 WriteAuthorizedBy validation (CFC, validation-only)

`WriteAuthorizedByValidationTransformer` (pipeline stage 10) is the one piece of
the CFC authoring contract that has landed on `main`, and it is **validation
only** — there is no CFC schema lowering yet (no `ifc.integrity` / `ifc.opaque` /
`ifc.collection` emission anywhere in `src/`; the draft lowering rules in
`cfc_authoring_contract.md` remain unimplemented — see §14).

It scans `toSchema<T>()` (one type arg) and `pattern<I, R>()` (the result type
arg) for `WriteAuthorizedBy<T, typeof binding>` references, resolving through
local type aliases and type-parameter substitution
(`findWriteAuthorizedByReferences`). For each reference it emits
**`cfc-write-authorized-by`** when usage is malformed:

- the second type argument is not a `typeof` binding (`TypeQueryNode`)
- the `typeof` target is not a simple identifier
- the bound name is not a supported origin — a local `handler()` / `module()` /
  `requireEventIntegrity()` initializer, or a local function declaration

Well-formed `WriteAuthorizedBy` usage passes validation; the base schema still
lowers as `T` (the `WriteAuthorizedBy` wrapper contributes no schema metadata on
current `main`). This stage is exercised by `test/cfc-authoring.test.ts`,
`test/cfc-transformer-coverage.test.ts`, and pipeline regressions.

`ts-transformers` also re-exports the canonical CFC alias-name set
(`CFC_CANONICAL_ALIAS_NAMES`, from `@commonfabric/api/cfc`) via
`src/cfc-authoring.ts` — `Cfc`, `Confidential`, `Integrity`,
`WriteAuthorizedBy`, the `TrustedAction*` family, the projection aliases, etc.
(The former collection/opaque helpers — `OpaqueInput`, `SubsetOf`,
`FilteredFrom`, `LengthPreservedFrom`, `PermutationOf` — were removed: the
runner rejects their lowered `ifc` keys fail-closed.) These names are
recognized as CFC vocabulary but, apart from `WriteAuthorizedBy` validation
above, are not yet lowered.

## 7. JSX Expression Site Routing And Early Rewriting

`JsxExpressionSiteRouterTransformer` runs only when helper import is present.

### 7.1 Top-level behavior

For each `JsxExpression`:

- skip empty JSX expressions and event-handler attributes
- run data-flow analysis (`createDataFlowAnalyzer`)
- if no rewrite required and no logical binary operators (`&&`, `||`), skip
- in compute context:
  - only semantic logical rewrites (`&&`/`||`) are considered
  - computed wrapping is skipped
- compute-context JSX does not lower `&&` / `||`
- pattern-context JSX lowers `&&` / `||` deterministically
- in `mode: "error"`:
  - report `reactive:jsx-expression` for non-compute contexts requiring
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
    lowered to the lift-applied form)
- compute contexts:
  - no computed wrappers; only child rewrites and logical conversions

Helper-owned compute branches introduced by ternary / conditional-helper
rewriting are re-analyzed with synthetic compute ownership. This preserves
plain-array semantics inside fully compute-wrapped branches while still letting
later stages recover reactive collection rewrites for locally rewrapped aliases
created inside compute code.

Synthetic calls generated by this pass register result types in `typeRegistry`
for later schema injection.

## 8. Lift-Applied Lowering

`LiftLoweringTransformer` rewrites Common Fabric `computed(...)` calls into the
canonical lift-applied form:

- `computed(fn)` -> `__cfHelpers.lift(fn)({})` before schema injection
- no-input computed-origin calls are schema-injected as
  `__cfHelpers.lift(false, fn)()`
- **does not** forward `computed`'s type argument to `lift`: `computed<R>` has a
  single result type param, while `lift<T, R>` takes input `T` first, so
  forwarding `[R]` would place `R` in `lift`'s input slot. Type args are
  recomputed downstream (LiftAppliedStrategy / SchemaInjection) from the
  callback's parameter and return types.
- does not additionally validate callback shape in this pass
- preserves type information through `typeRegistry` (the original call's type is
  re-registered on the lowered lift-applied node)

It runs only when source text contains `computed` or AST scan finds computed
calls.

## 9. Closure Transformation

`ClosureTransformer` runs only when helper import is present. It applies the
first matching strategy (the strategies array in `closures/transformer.ts`), in
order:

1. handler JSX attribute strategy
2. action strategy
3. array-method strategy
4. lift-applied strategy

There is no longer a separate patternTool closure strategy (CT-1655, #3862):
`patternTool` now requires an explicit `pattern(...)` first argument (see
§6.5 `pattern-context:patterntool-requires-pattern`), so the captures live on
that authored pattern and the call is hoisted by `BuilderCallHoisting` (§11)
rather than capture-rewritten here.

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
    re-wraps a reactive collection (`computed`, `lift`, `action`, `handler`,
    `wish`, already-rewritten collection calls, or other reactive cell-like
    receivers) -> transform
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
  lift-applied wrappers where needed

### 9.5 Lift-applied strategy

Transforms lift-applied closures only when captures exist.

Supported input forms:

- `lift(callback)(input)`
- `lift(inputSchema, resultSchema, callback)(input)`

Behavior:

- merge original input and captures into one input object
- rewrite callback parameters to explicit destructuring
- resolve name collisions (`name`, `name_1`, ...)
- preserve/reinfer callback result type
- skip explicit type args when result type is uninstantiated type parameter
- register lift-applied call type for downstream inference

If no captures are found, the lift-applied call is left unchanged.

### 9.6 patternTool (no closure strategy)

There is no patternTool closure strategy in the current pipeline. The former
strategy auto-wrapped a bare callback as `pattern(fn)` and auto-captured
module-scoped reactive values into the call; both were removed in CT-1655
(#3862) in favor of an explicit, addressable pattern.

Current behavior:

- `patternTool(...)`'s first argument **must** be an explicit `pattern(...)`; a
  bare callback reports `pattern-context:patterntool-requires-pattern` (§6.5).
- the captures live on the authored `pattern(...)` (module-scoped reads are
  absorbed by the pattern; per-instance values go in `extraParams`).
- the bare `pattern(...)` inside `patternTool(...)` is hoisted to module scope
  by `BuilderCallHoisting` (§11, argument-position pattern case).

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
- recursively rewrites lift-applied callback bodies so locally-declared
  opaque/reactive aliases created inside compute callbacks (including inside
  nested blocks) also receive `.key(...)` lowering
- local opaque-root discovery is symbol-scoped and block-aware to avoid
  same-name false rewrites across scopes
- extracts static destructuring defaults into capability summaries for schema
  default application
- registers capability summaries for transformed callbacks/builders for
  downstream schema shrinking/wrapping

#### 9.7.1 Current non-JSX expression-site split

Current-main behavior distinguishes three buckets for non-JSX authored sites:

1. **top-level pattern-owned ordinary call roots**
   - when the authored site root is an ordinary call (for example
     `identity(state.done ? "Done" : "Pending")`), the shared expression-site
     path whole-wraps that call in a lift-applied computation
   - this applies across non-JSX container kinds such as
     `variable-initializer`, `object-property`, `array-element`, and
     `return-expression`
2. **explicit compute callbacks**
   - `computed` / `action` / `lift` / `handler` callbacks remain the
     explicit reactive boundary
   - inside those callbacks, authored conditionals stay authored JS inside the
     callback body rather than being rewritten to helper control flow
3. **supported collection-callback locals**
   - callback-local **ordinary call roots** now join the shared ordinary-call
     slice across `variable-initializer`, `object-property`, `array-element`,
     and direct `return-expression` sites, so the whole call lowers as a
     callback-local lift-applied computation
   - callback-local **plain structural control-flow sites** that are not under
     an owning ordinary call root still lower directly (for example bare
     conditional `object-property` / `array-element` / `variable-initializer`
     expressions lowering to `ifElse(...)`)

In other words, the split is now explicitly **call-root vs nested structural
site ownership** rather than a special-case callback return-expression rule.

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

### 10.4 `lift(...)`

If schemas are not already present via type args:

- infer input/result schema types from arguments and callbacks
- literal-based input inference widens literals (`"x"` -> `string`, `1` ->
  `number`, etc.)
- when inferred result type is missing or degrades to `any`/`unknown`, recovery
  first attempts object-literal return reconstruction and then direct projection
  recovery (`x => x.foo`, `x => x["foo"]`)
- direct projection recovery can reuse result types recovered from local
  `lift(...)` initializer aliases registered in `typeRegistry`
- unresolved generic helper-definition-site type parameters degrade to
  `{ type: "unknown" }` when schemas are injected from explicit builder type
  arguments

### 10.5 Cell factories and related APIs

Injected behaviors:

- `cell(...)`, `new Cell(...)`, `new OpaqueCell(...)`, `new Stream(...)`, etc.:
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
- `sqliteQuery<Row>(...)`:
  - the **typed** form lowers the `Row` type argument to an injected `rowSchema`
    property on the options object (parallel to `generateObject`'s `schema`);
    the runtime builtin composes `result.items = rowSchema`. Two call shapes
    inject it: the free function `sqliteQuery<Row>({ db, sql, ... })` (options at
    arg 0) and a method form. Idempotent (skips when `rowSchema` already
    present).
  - untyped `sqliteQuery(...)` is not injected. Other SQLite builtins
    (`sqliteDatabase`, etc.) are recognized reactive-origin `runtime-call`s (§5)
    but receive no dedicated schema injection.

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

## 11. Builder Call Hoisting And `__cfReg` Registration

`BuilderCallHoistingTransformer` (stage 13, **after** SchemaInjection) hoists
every reactive *builder call* to module scope and emits a single trailing
content-addressing registration. It is the sole module-scope hoisting phase; it
absorbed the former `LiftHoistingTransformer` (lift-only) and replaced the
deleted `BuilderCallbackHoistingTransformer` (which hoisted builder callbacks
and caused TDZ double-hoist bugs — #3864). Tickets: CT-1644 (lift), CT-1655
(handler, pattern, patternTool), CT-1623 (`__cfReg` content addressing).

### 11.1 What gets hoisted

After SchemaInjection, each reactive builder computation appears in a schema-
injected applied or argument-position shape. This stage relocates the inner
builder call to a named module-scope `const` and rewrites the original site to
reference that name. Three builder shapes are registered in
`HOISTABLE_BUILDERS`:

- **Applied builders** (`lift`, `handler`): the site is `builder(...)(captures)`
  — the callee is itself the inner `builder(...)` call. Hoist the inner call,
  leave `__cfLift_N(captures)` / `__cfHandler_N(captures)` at the site (any
  trailing `.for(...)` member chain stays anchored on the outer call):

  ```ts
  // Shown inside a pattern body.
  // module scope:
  const __cfLift_1 = __cfHelpers.lift(argSchema, resSchema, callback);
  // original site:
  __cfLift_1(captures).for("result", true)
  ```

- **Argument-position builder** (`pattern`): the bare `pattern(...)` call sits
  in argument 0 of an enclosing `*WithPattern` call (`mapWithPattern`, etc.) or
  `patternTool(...)`. Hoist argument 0 to `__cfPattern_N` and rewrite only that
  argument, keeping the enclosing callee and remaining arguments intact. The
  top-level `export default pattern(...)` is a direct call, not an argument, so
  it is naturally excluded.

Detection is provenance-driven via `detectCallKind` / `isHandlerAppliedCall` /
`getWithPatternHoistablePatternCall` / `getPatternToolHoistablePatternCall`.

### 11.2 Why this runs after SchemaInjection

SchemaInjection derives a lift's argument schema from the adjacent applied
captures object. Hoisting the call to a bare `const = lift(callback)` *before*
injection would separate the captures object and silently drop capture
properties in nested/multi-capture callbacks. Running after injection means the
schema is already baked into the inner call before relocation, so the hoist is
schema-transparent (C-002; verified regression).

### 11.3 Hoist placement and TDZ ordering

Hoisted consts are flushed immediately **before** their owning top-level
statement, not pooled into a single after-imports block. This keeps each hoisted
const after every module binding declared in an earlier statement. The ordering
is behaviorally load-bearing for `pattern`: unlike `lift`/`handler` (callbacks
stored and run lazily), `pattern(...)` invokes its callback **eagerly at
construction**, so a hoisted `const __cfPattern_N = pattern(cb)` whose `cb`
reads a later module-scoped binding would throw a module-load TDZ
`ReferenceError` under after-imports placement.

Hoisted identifiers use explicit per-prefix counters with literal numeric
suffixes (`__cfLift_1`, `__cfPattern_1`, …), **not** `factory.createUniqueName`
— whose `.text` carries only the bare prefix and defers suffixing to emit, which
would make every hoisted identifier share the same `.text` and break the
identity-by-text lookups later stages rely on.

### 11.4 `__cfReg` content-addressed registration

After visiting the whole file, the stage appends **one** trailing call:

```ts
// Shown at module scope.
__cfReg({ __cfLift_1, __cfPattern_1, __cfHandler_1, /* … */ });
```

using shorthand properties so each value is the module-level `const` binding
itself. It is emitted only when there is something to register (hoist-free
modules are unchanged). The registered set includes both:

1. the synthetic hoists produced above, and
2. **authored** non-exported top-level builder artifacts — `const foo =
   lift(...)` / `pattern(...)` / `handler(...)` etc. — detected on the original
   statement so an import/alias (`const x = imported`) is never mis-attributed
   to this module's identity.

`__cfReg` is a free identifier supplied by the module wrapper (the 4th factory
parameter under the runtime's ESM loader; a no-op global on the legacy/AMD
path). The runtime registrar pairs each `{ symbol -> live value }` entry with
the module's content identity, populating the content-addressed reverse index
that backs builder-artifact identity resolution. A single trailing call (rather
than per-artifact export/registration) keeps the runtime verifier's obligation
to "exactly one top-level `__cfReg` call," with a run-once trap rejecting
injected duplicates. Runtime side:
`packages/runner/src/sandbox/module-record-compiler.ts` and
`packages/runner/src/pattern-manager.ts`.

This registration is current, shipped behavior: `__cfReg({...})` appears in the
expected output of the large majority of builder-bearing fixtures.

Note: the design comments frame this stage as Phase 2 of a
"derive→lift→selfcontained" arc. Phase 3 (`selfcontained(...)` wrapping of the
hoisted consts) is **not** implemented on `main` — see the design-deltas doc.

## 12. Schema Generation

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
- `Reactive<T>` does not emit `asOpaque`; only cell/stream wrappers add wrapper
  markers such as `asCell` / `asStream`
- CFC-specific wrapper lowering such as `WriteAuthorizedBy`, projection aliases,
  and trusted-UI helper schema metadata is not part of current implemented
  behavior on `main`; those contracts are described separately in the draft CFC
  docs listed above

## 13. Diagnostics Message Transformation (Optional Consumer Layer)

Diagnostic message transformers are exported separately from AST transform
pipeline. Current built-in behavior:

- `ReactiveErrorTransformer` rewrites TypeScript messages matching
  `"Property 'get' does not exist on type 'OpaqueCell<...>'"` into user-facing
  guidance about unnecessary `.get()`.
- optional `verbose` mode appends original TypeScript message.
- `CompositeDiagnosticTransformer` returns the first matching transformer
  result.

## 14. Current Known Limits (Observed)

1. Generic helper functions with uninstantiated type-parameter lift-applied
   result types can degrade schema precision (type arguments may be
   intentionally omitted).
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
6. The CFC authoring and trusted-UI helper contracts under
   `docs/specs/ts-transformer/cfc_*.md` are draft **lowering** contracts: the
   current pipeline on `main` does not lower those forms (no `ifc.*` schema
   metadata emission). The one landed exception is **`WriteAuthorizedBy`
   validation** (§6.8) — usage is validated (`cfc-write-authorized-by`) even
   though the wrapper is not yet lowered. The canonical CFC alias names are
   re-exported but otherwise inert. Note: the authoring draft says the schema
   generator validates `WriteAuthorizedBy`; on `main` that validation is a
   separate stage-10 `WriteAuthorizedByValidationTransformer`, not the schema
   generator.

## 15. Test Coverage Snapshot

The fixture suites driven by `fixture-based.test.ts` live under
`test/fixtures/<suite>/` as `*.input.*` / `*.expected.*` pairs. The driver
currently runs these suites:

- `ast-transform`
- `handler-schema`
- `jsx-expressions`
- `schema-transform`
- `closures` (the largest suite by a wide margin)
- `kitchensink`
- `schema-injection`

(The `bug-repro` directory exists but is not an input/expected fixture suite.)

Exact counts are intentionally not pinned here — they churn with every fixture
addition. The fixture corpus is in the high hundreds of input files overall, of
which `closures` is the largest single suite. To get current numbers:

```bash
# per suite
for d in test/fixtures/*/; do
  printf '%s: %s\n' "$(basename "$d")" "$(ls "$d"*.input.* 2>/dev/null | wc -l)"
done
# total input fixtures
find test/fixtures -name '*.input.*' | wc -l
```

Additional non-fixture unit suites cover:

- cast/empty-array/pattern-context/opaque-get/schema-shrink validation
- diagnostic message transformer behavior
- event-handler detection heuristics
- reactive analysis/normalization/runtime-style APIs
- pipeline regression and policy/capability-analysis behavior
- lift-applied call helper and identifier utilities

## 16. Stability Statement

This specification is a snapshot of current behavior. Any transformer code or
fixture expectation changes should be treated as spec changes and reflected in
this document.

### 16.1 Keeping This Spec Current (Sources Of Truth)

Several facts in this document are enumerations the implementation already
centralizes. When they change, update the spec from the canonical source rather
than hand-maintaining a parallel list — and prefer pointing at the source over
re-listing it. The enforced sources of truth:

| Spec content | Canonical source | Guard / note |
| --- | --- | --- |
| Pipeline stage set + order (§3) | `CFC_TRANSFORMER_STAGE_SPECS` / `CFC_TRANSFORMER_STAGE_NAMES` (`src/cf-pipeline.ts`) | the array literal is the order |
| Cross-stage registries (§2.2) | `CrossStageState` (`src/core/cross-stage-state.ts`) | NodeLinks-shaped families |
| Recognized runtime exports + which are reactive origins (§5, §6.3) | `COMMONFABRIC_RUNTIME_EXPORT_REGISTRY` (`src/core/commonfabric-runtime-registry.ts`) | `test/core/commonfabric-runtime-registry.test.ts` asserts coverage of the runner builder factory |
| SES self-contained callback boundaries (§6.5) | `SES_SELF_CONTAINED_CALLBACK_BOUNDARIES` (`src/transformers/pattern-context-validation.ts`) | excludes `sqlite-row-label-rule` by design |
| Lowerable expression-site container kinds (§6.7) | `getExpressionContainerKind` (`expression-site-policy.ts`) | — |
| Diagnostic `type:` strings | the emitting transformer's `reportDiagnostic` calls | grep `type: "…"` per validator |

A drift-resistant habit: when a section enumerates a set, cite the constant /
function that defines it so a reader can confirm the live set, and keep prose
lists explicitly labeled "as of this writing."
