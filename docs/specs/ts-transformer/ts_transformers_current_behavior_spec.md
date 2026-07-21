# TypeScript Transformers Current Behavior Specification

**Status:** Descriptive (current behavior; on conflict, code/tests win — §21)\
**Package:** `@commonfabric/ts-transformers`\
**Last verified against:** origin/main `47ad2b898` plus this documentation branch,
2026-07-16 verification\
**Scope:** Compile-time behavior implemented in `packages/ts-transformers/src`
and exercised by current tests/fixtures. **Related:**

- `docs/specs/ts-transformer/ts_transformers_target_pattern_language_spec.md`
- `docs/specs/ts-transformer/ts_transformers_lowering_contract.md`
- `docs/specs/ts-transformer/ts_transformers_goals.md`
- `docs/specs/ts-transformer/cfc_authoring_contract.md` (implemented direct
  authoring, policy validation, and schema lowering — see §6.8)
- `docs/specs/ts-transformer/cfc_ui_helper_contract.md` (implemented contract;
  the helper rewrite and schema-hint behavior are described in §7.1 and §12)

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

Legacy stored-envelope compatibility is deliberately separate from
`transformCfDirective()` (#4574, CT-1838):

- `isLegacyInjectedEnvelope(source)` is a public package export that recognizes
  the exact helper-injected form persisted by pre-#4158 pipelines. The first
  line must be byte-exactly `HELPERS_STMT`, the document must end with
  `"\n" + HELPERS_USED_STMT` or its JavaScript form, and the prefix/trailer may
  not overlap. A stripped final newline is accepted. Interior contents are not
  otherwise inspected (`src/core/cf-helpers.ts`;
  `test/core/legacy-envelope.test.ts`).
- The detector does **not** weaken the authored-source guard above. The runner
  consults it before `transformCfDirective()` only when
  `tolerateStoredLegacyEnvelope: true` is set on storage-fetched,
  Merkle-verified cold-load/fabric-mount input; an exact match passes through
  unchanged because it already contains the injected helper envelope. Normal
  authoring paths never set that option, so authored `__cfHelpers` input still
  throws (`packages/runner/src/harness/pretransform.ts`).

Opt-out note:

- `/// <cf-disable-transform />` is the explicit opt-out. It is honored only
  at **column zero** of the first content line (leading blank lines are fine;
  leading whitespace on the directive line is not), mirroring TypeScript's
  own triple-slash directives (CT-1815, #4618;
  `src/core/runtime-contract.ts`). An indented lookalike is silently ignored
  and the file transforms normally; `sourceHasIgnoredDisableDirective` is
  exported so compile-time callers can warn the author (the runtime boot path
  never consults it).

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
4. **Diagnostic dedup channel** — `markDiagnosticReported(key)`
   (`cross-stage-state.ts:207`) backs `reportDiagnosticOnce`, so stages that
   may revisit the same node report a given diagnostic key once per run.

## 3. Pipeline Order (Normative)

The authoritative ordering lives in `CFC_TRANSFORMER_STAGE_SPECS` /
`CFC_TRANSFORMER_STAGE_NAMES` in `src/cf-pipeline.ts`. Transformers always run
in this order (23 stages):

1. `CastValidationTransformer`
2. `EmptyArrayOfValidationTransformer`
3. `OpaqueGetValidationTransformer`
4. `PatternContextValidationTransformer`
5. `MergeablePushValidationTransformer`
6. `CfcPolicyAuthoringTransformer`
7. `CfcPolicyOfValidationTransformer`
8. `JsxExpressionSiteRouterTransformer`
9. `AssertDiagnosticsTransformer`
10. `LiftLoweringTransformer`
11. `ClosureTransformer`
12. `PatternOwnedExpressionSiteLoweringTransformer`
13. `HelperOwnedExpressionSiteLoweringTransformer`
14. `WriteAuthorizedByValidationTransformer`
15. `PatternCallbackLoweringTransformer`
16. `SchemaInjectionTransformer`
17. `BuilderCallHoistingTransformer`
18. `SchemaGeneratorTransformer`
19. `ReactiveVariableForTransformer`
20. `ModuleScopeShadowingTransformer`
21. `ModuleScopeCfDataTransformer`
22. `PatternCoverageTransformer`
23. `ModuleScopeFunctionHardeningTransformer`
The order is behaviorally significant (invariant C-002). Two ordering facts
worth calling out:

- `BuilderCallHoistingTransformer` (stage 17) runs **after**
  `SchemaInjectionTransformer` (stage 16) so each builder call it relocates to
  module scope already carries its injected schemas — see CT-1644 and
  `packages/ts-transformers/docs/derive-to-lift-design.md`. This stage hoists
  `lift`, `handler`, and `pattern` builder calls. It absorbed and replaced the
  former separate `LiftHoistingTransformer` (which hoisted only `lift`); the
  even-older `BuilderCallbackHoistingTransformer` was deleted (#3864). Earlier
  spec revisions listing those two as distinct stages are obsolete.
- The final five stages (18–22) run last so they operate on fully lowered and
  schema-injected output; they are documented stage by stage in §13–§17.
- `MergeablePushValidationTransformer` (stage 5; #4450/#4505) is
  validation-only and is documented with the other validators (§6.9).
- `PatternCoverageTransformer` (stage 22) does no work unless pattern runtime
  coverage is enabled. When enabled, it runs before
  `ModuleScopeFunctionHardeningTransformer` so coverage counters are added to
  authored bodies before hardening helpers are emitted (§16).

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
  `computed`, `render`. (`byRef` and `uiVariant` are registered-but-`ignored`
  exports — recognized so the registry guard test stays exhaustive, treated as
  plain calls.)
- conditional-helper calls: `ifElse`, `when`, `unless`
- reactive array calls (`map`, `mapWithPattern`, `filter`, `filterWithPattern`,
  `flatMap`, `flatMapWithPattern`)
- cell factories (`cell`, `new Cell`, `new OpaqueCell`, `new Stream`, etc.),
  with legacy `.of(...)` still accepted
- `Cell.for`-style calls
- `wish`
- `generateObject` and `generateText`
- the `runtime-call` family — tagged-call / function runtime origins: `str`,
  `llm`, `llmDialog`, the fetch family from the #4206 split — `fetchJson`
  (which additionally gets dedicated type-argument schema injection, §10.5),
  `fetchJsonUnchecked`, `fetchText`, `fetchBinary` — `fetchProgram`,
  `streamData`,
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
- synthetic parameters injected by the pipeline (`__cf_pattern_input`,
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
  - a **terminal** `.get()` read in restricted reactive context — one whose
    value is used directly (`{ value: count.get() }`,
    `const v = count.get()`, `input.key("count").get()` at a return site)
  - since #3725 (2026-05-28), a **computation-feeding** read at a lowerable
    site (`{ value: count.get() * 2 }`) is NOT rejected: the containing
    expression is auto-wrapped into a lift-applied computation
    (`test/validation.test.ts:3179`; goldens `cell-get-binding-autowrap`,
    `with-reactive`). This is an unratified delta from the target-language
    matrix's unconditional "Unsupported" — see the design-deltas 2026-07-10
    record
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
  - optional calls in restricted reactive context **outside JSX and outside
    explicit compute callbacks** — top-level (`input?.foo()`), statement
    position, and collection callbacks (`items.map((item) =>
    item?.toUpperCase())`) all error (`test/validation.test.ts:546,567,1509`)
  - inside JSX expressions (`{maybeFn?.(1)}`, `{text?.trim()}`) and inside
    `computed(...)` bodies the same shapes are accepted and lowered intact —
    an unratified delta from the target-language matrix's unconditional
    "Unsupported" (see the design-deltas 2026-07-10 record; note the
    lowering drops function-typed captures from the lift input schema, so an
    accepted reactive optional-call is dead code at runtime)
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
- **Error** `pattern-context:assignment` / `pattern-context:early-return` /
  `pattern-context:let-declaration` / `pattern-context:loop` /
  `pattern-context:var-declaration`
  - statement-boundary imperative structure in top-level pattern-owned code —
    assignments, early returns, `let`/`var` declarations, and loops each
    report a dedicated id (`pattern-context-validation.ts:539-633`). These
    enforce the target-language matrix's "statement-boundary imperative
    constructs" Unsupported row and have been live since the boundary PR
    (#3154).

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
- individual inferred-result **fields** whose type is `unknown` emit **Error**
  `pattern-result:unknown-type`, naming the offending paths — the schema would
  carry `{ type: "unknown" }` there and a consumer reading the field back
  would materialize `undefined` (`schema-injection.ts:2621`)
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

### 6.8 CFC authoring and validation

The pipeline implements both schema aliases and direct module-authored exchange
rules. `CfcPolicyAuthoringTransformer` validates and lowers static exported
`exchangeRule(...)` / `exchangeRules([...])` declarations, stamps deterministic
rule names, and records compiler manifests in cross-stage state. The manifests
are side-channel compiler artifacts and never JavaScript module exports.

`CfcPolicyOfValidationTransformer` accepts only a direct
`PolicyOf<typeof rules>` query of an exported ruleset. Schema generation binds
that reference to the defining module identity, export symbol, exact manifest
digest, and an owning-space placeholder. Direct imports and pinned `cf:` imports
retain the dependency's identity.

`WriteAuthorizedByValidationTransformer` separately validates writer-binding
claims.

It scans `toSchema<T>()` (one type arg) and `pattern<I, R>()` (the result type
arg) for `WriteAuthorizedBy<T, typeof binding>` references, resolving through
local type aliases and type-parameter substitution
(`findWriteAuthorizedByReferences`). For each reference it emits
**`cfc-write-authorized-by`** when usage is malformed:

- the second type argument is not a `typeof` binding (`TypeQueryNode`)
- the `typeof` target is not a simple identifier
- the bound name is not a supported origin — a local `handler()` / `module()` /
  `requireEventIntegrity()` initializer, or a local function declaration

Well-formed `WriteAuthorizedBy` usage passes validation; the base schema
lowers as `T` plus the writer-identity claim (`ifc.writeAuthorizedBy` carrying
the `__ctWriterIdentityOf` binding marker, preserved through schema emission —
see the identity tests in `test/cfc-authoring.test.ts`). This stage is
exercised by `test/cfc-authoring.test.ts`,
`test/cfc-transformer-coverage.test.ts`, and pipeline regressions.

`ts-transformers` also re-exports the canonical CFC alias-name set
(`CFC_CANONICAL_ALIAS_NAMES`, from `@commonfabric/api/cfc`) via
`src/cfc-authoring.ts` — `Cfc`, `Confidential`, `Integrity`,
`AnyOf`, `PolicyOf`, `WriteAuthorizedBy`, the `TrustedAction*` family, the
projection aliases, etc.
(The former collection/opaque helpers — `OpaqueInput`, `SubsetOf`,
`FilteredFrom`, `LengthPreservedFrom`, `PermutationOf` — were removed: the
runner rejects their lowered `ifc` keys fail-closed.) The canonical aliases
are lowered into schema `ifc` metadata by the schema-generator's
common-fabric formatter during the `SchemaGeneratorTransformer` stage (the
lowering rules live in `cfc_authoring_contract.md`); `WriteAuthorizedBy`
additionally gets the transformer-side validation above.

### 6.9 Mergeable-push validation

`MergeablePushValidationTransformer` (stage 5; #4450, classification refined
in #4505) analyzes handler callbacks for reads of a mergeable collection
followed by a push to the same collection, and reports:

- **Warning** `mergeable-push:read-then-push`
  (`src/transformers/mergeable-push-validation.ts:116`)
  - findings are deduplicated per collection root+path per handler; when a
    collection classifies under more than one misuse kind, the
    read-dependent-push diagnosis wins over independent-read-modify-write as
    the stronger, more actionable one (the dedup comment states this)
  - the message text is produced per classification by `diagnosticMessage`;
    capability analysis feeds the findings via `mergeablePushMisuseSink`

### 6.10 Diagnostics emitted by lowering stages

Not every diagnostic comes from a validation transformer. The lowering stages
report these through the same collector (deduplicated via §2.2's
`markDiagnosticReported` channel):

- **Error** `pattern-context:receiver-method-call`
  (`pattern-body-reactive-root-lowering.ts:162`) — the pattern-body
  reactive-root seam could not admit a receiver-method call on a tracked
  reactive root at that site
- **Error** `pattern-context:inline-reactive-root-access`
  (`pattern-body-reactive-root-lowering.ts:1467`) — an inline tracked
  reactive-root read at a position that stage cannot lower
- **Error** `pattern-result:unknown-type` (`schema-injection.ts:2621`) — see
  §6.6
- **Error** `reactive-capture:unknown-type` (`src/ast/type-building.ts:681`) —
  a captured reactive value's inferred type is `unknown`, so its schema would
  be `{ type: "unknown" }` and the runner would read it back as `undefined`;
  the message directs authors to add an explicit type

## 7. JSX Expression Site Routing And Early Rewriting

`JsxExpressionSiteRouterTransformer` runs only when helper import is present.

### 7.1 Top-level behavior

Before expression-site routing, the visitor first rewrites recognized CFC UI
helper elements (`UiAction` / `UiPromptSlot` / `UiDisclosure`) via
`rewriteUiHelperElement` (`src/transformers/ui-helper-lowering.ts`): the
helper tag is replaced by its `as` prop or the helper's default intrinsic tag,
helper-only props are re-emitted as `data-ui-*` attributes, non-helper props
and children are preserved, and — when the required semantic props are string
literals — a `cfcUiContract` schema hint is recorded for later
`ifc.uiContract` emission (§6.8, §12).

Event-handler attribute detection (`isEventHandlerJsxAttribute`,
`src/ast/event-handlers.ts`) treats an attribute as a handler site when its
name has the `on` prefix OR its contextual type is handler-like (every call
signature takes at most one parameter).

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
  `__cfHelpers.lift(fn, false, undefined, { completeSchedulerScopeSummary: true })()`
  after closure analysis has proven that the empty input contains no captures
  (function first; `false` preserves computed's no-argument runtime semantics,
  and `undefined` keeps the options object in lift's fourth parameter)
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

Strategy rebuilds — and the callbacks `PatternBuilder` assembles for them —
carry the replaced nodes' source-map ranges (§11.5).

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
- `lift(callback, argumentSchema, resultSchema[, options])(input)`

Behavior:

- merge original input and captures into one input object
- rewrite callback parameters to explicit destructuring
- resolve name collisions (`name`, `name_1`, ...)
- preserve/reinfer callback result type
- skip explicit type args when result type is uninstantiated type parameter
- register lift-applied call type for downstream inference
- re-analyze the rewritten callback's merged input and, when needed, append one
  scheduler-options object to the inner `lift` call:
  - `materializerWriteInputPaths` is emitted when the first parameter's
    capability summary has one or more write paths. Each path is an array of
    static string segments. The write metadata remains present even when the
    overall scope is not provably complete.
  - `completeSchedulerScopeSummary: true` is emitted only when the function is
    non-recursive, has no unreadable cell arguments, and every parameter has no
    wildcard, unverified cell use, passthrough, opaque capability, or opaque
    paths. A proven-empty summary qualifies.
  - the object may contain either field or both, and is omitted when neither
    condition holds (`closures/strategies/lift-applied-strategy.ts`;
    `test/pipeline-regressions.test.ts`).
- during §10 schema injection, argument/result schemas are inserted after the
  callback and before those options, producing
  `lift(callback, argumentSchema, resultSchema, options?)(input)`. The
  zero-input/no-capture computed form is handled separately as described in §8.

The runtime meaning of `materializerWriteInputPaths` is specified in
`docs/specs/persistent-scheduler-state.md` ("Materializers").

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
`toSchema<...>()` calls (later materialized to JSON schema literals). Every
builder call it rebuilds carries the replaced call's source-map range (§11.5).

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
- `fetchJson<T>(...)` (#4206 fetch-family split):
  - the typed form lowers the `T` type argument to an injected `schema`
    property on the options object (parallel to `generateObject`)
  - an untyped `fetchJson(...)` call is a hard **Error**
    `fetch-json:missing-type-argument` (`schema-injection.ts:4015`), directing
    authors to add a type argument or use `fetchJsonUnchecked` for JSON whose
    shape is not declared as a type. `fetchText` / `fetchBinary` /
    `fetchJsonUnchecked` receive no dedicated injection.

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
  - `comparable` -> `ComparableCell<T>`
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

#### 10.7.1 Identity and comparable-only paths

Capability analysis tracks identity-only use separately from ordinary value
reads/writes so equality and navigation do not force full values into a
computation's input schema:

- Trusted Common Fabric `equals(...)` / `equalLinks(...)` calls record their
  arguments as comparable identity paths. Their cell-like receiver-method forms
  do the same; an arbitrary user object's method merely named `equals` is an
  ordinary read. `navigateTo(...)` records identity (not comparable) argument
  use. Bare helpers are accepted only when symbol resolution proves Common
  Fabric provenance; receiver methods require a cell-like receiver when a
  checker is available (`policy/capability-analysis.ts`,
  `isKnownIdentityArgumentCall`).
- A whole-root identity use records path `[]` and passthrough. `identityOnly` is
  true only when that root identity path survives normalization and the root has
  no non-identity use, ordinary reads/writes, or wildcard. Nested uses populate
  `identityPaths`; cell-like values also populate `identityCellPaths`.
  Comparable use is the corresponding subset in `comparablePaths` /
  `comparableCellPaths`. Local/interprocedural capability summaries and imported
  `ComparableCell` parameter contracts propagate these distinctions.
- Normalization drops a root identity path after non-identity root use, and
  drops any identity path with an ordinary read, full-shape read, write, or
  opaque access at or below that path. Comparable and cell-like subsets are
  pruned with the surviving identity paths. Since #4714, a wildcard records the
  unknown access's static prefix and erases identity/comparable paths that
  overlap it in either direction; disjoint paths survive. A root wildcard still
  suppresses `identityOnly`. This matters because closure captures share one
  synthetic root: blanket erasure degraded disjoint `equals()`-only captures
  into unsatisfiable full-value self-demands
  (`test/policy/capability-analysis.test.ts`).
- Shrinking retains identity paths without materializing their value shape. A
  whole unwrapped identity-only input becomes `unknown`; a wrapped one becomes
  `OpaqueCell<unknown>`, or `ComparableCell<unknown>` for comparable use.
  Identity-only cell leaves receive the same opaque/comparable wrappers, while
  mixed summaries still retain and shrink their ordinary read/write paths
  (`transformers/type-shrinking.ts`; `test/type-shrinking.test.ts`).
- Scheduler completeness is separate from path retention: identity-only roots
  are passthrough, and `hasCompleteSchedulerScopeSummary` rejects passthrough or
  wildcard summaries. Thus identity/comparable tracking can preserve a
  satisfiable input schema without asserting a complete scheduler scope.

#### 10.7.2 Imported capability contracts

Imported cell-wrapper parameter types act as a **capability contract** at call
boundaries (#4486): when a handler passes a cell to a callee whose body lives
in another file, the callee's declared Common Fabric wrapper parameter type
(`Writable<T>` → read+write, `ReadonlyCell<T>` → read, `WriteonlyCell<T>` →
write, etc.) is what capability analysis charges to that argument. Spread
arguments of fixed-length tuple type expand positionally against the callee's
parameter list before matching (#4578). Two write-tracking hardenings
(#4554): `send` is a WRITER_METHOD (`Stream.send()` delegates to `set()` at
runtime, so an event enqueue is a write to the stream cell — previously the
unknown-method fallback recorded it as a read), and an unrecognized method
call on a **cell-like** receiver (type-checked; array/string methods on
`.get()` snapshots are unaffected) marks the parameter's
`hasUnverifiedCellUse` and propagates — the summary fails closed instead of
defaulting to read. When a cell
argument reaches an imported parameter whose capability the contract cannot
classify, the capability would be silently lost, so the transformer reports
**Error** `capability:unreadable-cell-argument`
(`schema-injection.ts:269`, via `reportDiagnosticOnce`). The design narrative
lives in `docs/history/packages/ts-transformers/SCHEMA_INJECTION_NOTES.md`
(a point-in-time design record; "Imported Cell
Parameters Are a Capability Contract").

## 11. Builder Call Hoisting And `__cfReg` Registration

`BuilderCallHoistingTransformer` (stage 17, **after** SchemaInjection) hoists
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

### 11.5 Authored-position lineage at the hoisting boundary

Every builder call this stage visits — hoisted inner calls, in-place authored
builder consts, the `export default` pattern call — and every builder callback
arrives carrying a recoverable **authored** source position (CT-1868). The
carrier is the emit-node **source-map range**: the callbacks
`PatternBuilder.buildCallback`/`buildHandlerCallback` assemble, the closure
strategies' rebuilt applied calls, the expression-rewrite wrapper arrows and
applied calls, and every SchemaInjection builder-call rebuild wrap their
output in `preserveSourceMapRange(built, replaced)` (`src/ast/utils.ts`).
Full `preserveLineage` (textRange + sourceMapRange + original) is applied only
where the emit-invariance gate proved those channels inert — the lift-applied
strategy's outer applied call and the array-method `mapWithPattern` rebuild.

sourceMapRange is the one channel observable only by sourcemaps: a real
`textRange` on a synthetic node changes printer layout (arrow-head
parenthesization via `canEmitSimpleArrowHead`; JSX/ternary line-break reflow),
and a real `original` feeds the §2.2 marker family, `typeRegistry` fallbacks,
and schema derivation — all of which change emitted output. The rebuilds set
no originals, so the `schemaInjected` flag's deliberate lack of a
`getOriginalNode` fallback (§2.2) is unaffected. sourceMapRange also survives
`factory.update*` rebuilds (`setOriginalNode` merges emit-node data,
including `sourceMapRange` — verified on TS 5.9.2 and 6.0.3).

Recovery precedence is: own text range → explicit source-map range →
original-chain terminal. `test/lineage-regression.test.ts` pins it end to end:
it drives the full pipeline over a five-origin fixture and asserts every
builder call AND callback recovers to its distinctive authored snippet
(content is the ground truth, not merely `pos >= 0`). This is the read path
for transform-time source annotation (A′, CT-1870), and the same fallback
family §16.2's coverage spans use. Rationale, per-site table, and the probe
rig: `packages/ts-transformers/APRIME-LINEAGE-HANDOFF.md`.

## 12. Schema Generation

`SchemaGeneratorTransformer` replaces `toSchema<T>(options?)` calls with JSON
schema literals.

Recognized call forms:

- `toSchema<T>()`
- `__cfHelpers.toSchema<T>()`

Behavior:

1. resolve type from `typeRegistry` (preferred) or checker fallback
2. evaluate literal options object — string, boolean and `null` literals,
   object and array literals, enum constants, and numbers in any of their
   spellings (bare literal, sign-prefixed, or the `NaN` / `Infinity` globals,
   the latter only where the name is not shadowed). A property whose value is
   none of these is dropped from the options object.
3. extract `widenLiterals` generation option
4. generate schema via `createSchemaTransformerV2`
5. merge non-generation options into resulting schema object
6. emit literal as:
   - `<schemaAst> as const satisfies __cfHelpers.JSONSchema`

Special path:

- the generator uses its node-based path when the resolved type is `any` and
  the type-argument node is synthetic (`pos=-1,end=-1`), or when a
  real-position type argument contains any `any` / `unknown` keyword. The
  latter avoids letting the checker recover a wider semantic type and erase
  the authored unknown boundary.
- synthetic union handling preserves `undefined` members (for example
  `string | undefined` retains an explicit `undefined` branch in generated
  schema).
- `unknown` is emitted distinctly as `{ type: "unknown" }`; `any` remains `true`
- arrays of `unknown` emit `items: { type: "unknown" }`
- synthetic unions preserve explicit `{ type: "unknown" }` members in `anyOf`
  rather than collapsing them away
- `Reactive<T>` does not emit an opaque marker. Cell, stream, and opaque
  wrappers all contribute entries to the single `asCell` array (`"cell"`,
  `"stream"`, and `"opaque"`, respectively)
- CFC-specific lowering is implemented behavior at this stage. The canonical
  aliases lower to `ifc.*` metadata through the schema generator;
  `AnyOf<...>` becomes an IFC `anyOf` atom, and `PolicyOf<typeof policy>`
  becomes a policy-reference marker that `SchemaGeneratorTransformer`
  resolves to module identity, symbol, and digest. `WriteAuthorizedBy`
  rehydrates as `ifc.writeAuthorizedBy.__ctWriterIdentityOf = { file, path }`,
  and router-seeded `cfcUiContract` hints emit as `ifc.uiContract`. See §6.8;
  pinned by `test/cfc-authoring.test.ts`,
  `packages/schema-generator/test/schema/cfc-authoring.test.ts`, and
  `test/cfc-ui-helper.test.ts`

## 13. Reactive Variable `.for()` Naming

`ReactiveVariableForTransformer` (stage 19, first of the five trailing stages
that run on fully lowered, schema-injected output — §3) derives stable,
human-readable **causes** from authored names and attaches them to reactive
values as `.for(<cause>, true)` calls. The cause is the runtime identity seed:
`Cell.for(cause)` stores it on the cell's cause container, and link creation
derives the cell's id from it (`packages/runner/src/cell.ts`, `for()` and the
link-creation path that consumes the stored cause). This stage is what gives
reactive
values deterministic, name-derived identities without authors writing
`.for(...)` by hand: the variable or result-property name *is* the identity
seed.

Like all trailing stages it is gated only on the injected `__cfHelpers` binding
(`HelpersOnlyTransformer.filter`, `src/core/transformers.ts`; injection per
§2.1) and does not branch on `mode` (§4). It emits no diagnostics; it only
rewrites expressions.

### 13.1 The two cause roots

Cause paths originate at exactly two places
(`src/transformers/reactive-variable-for.ts`, `createReactiveVariableForVisitor`):

1. **`const` variable declarations**, anywhere in the module — pattern bodies,
   plain functions, lowered IIFEs. The declared name seeds the path. Conditions
   on the declaration itself: `const` only (`let`/`var` skipped via the
   `NodeFlags.Const` check), the name must be a plain identifier (destructuring
   skipped), it must not start with `__cf` (`isInternalSyntheticName` — this is
   what keeps hoisted `__cfLift_N` consts untagged, §13.6), and there must be an
   initializer.
2. **Pattern results.** For every `pattern(...)` call (recognition:
   `isPatternBuilderCall` in `src/ast/call-kind.ts` — a direct `pattern`
   builder call or any `.pattern` property-access callee, e.g.
   `__cfHelpers.pattern`), the callback's result expression is visited with the
   root path `["__patternResult"]` (`PATTERN_RESULT_CAUSE`). Concise arrow
   bodies and `return` statements in block bodies both count; function-likes
   *nested inside* the callback are recursed plainly, so only the pattern's own
   result gets `__patternResult` causes (consts inside them still get variable
   causes via rule 1).

Everything else is reached by a plain visitor that adds no causes — which is
why object literals built inside e.g. a dynamic `values.map((_, i) => ({...}))`
callback get none (test: "does not add shared property causes inside dynamic
array callbacks").

### 13.2 Which initializers qualify

`shouldAddReactiveFor` decides, with two profiles: variable position
(`shouldAddVariableFor`: `includeRuntimeCalls: true, useTypeFallback: true`)
and nested property/element position (`shouldAddPropertyFor`: both `false`).
After unwrapping non-semantic wrappers (parens, `as`, `satisfies`, `!`,
`<T>x`), the initializer must be a call expression — or a `new` expression
whose constructor is a cell factory (`detectNewExpressionKind`; the
`schema-injection/cell-constructors` fixture shows every `new Cell`-like form
tagged). Bare identifiers, property accesses (`wish(...).result`), literals,
etc. never get a root cause at a declaration.

A qualifying call, per `detectCallKind` (§5) — as of this writing:

- **builder** results, but only when the call is *not* a direct builder call
  (`detectDirectBuilderCall` fails ⇒ the "builder" classification came through
  the factory-result path, i.e. an applied `handler(...)({...})` /
  `__cfHandler_N({...})` site), **or** is a direct `action` / `computed` call
  (`isReactiveBuilderResult`). Direct `lift(...)` / `handler(...)` /
  `pattern(...)` calls — factories, not reactive values — get no cause.
- **cell-factory** (incl. legacy `.of(...)`), **lift-applied**, **ifElse**,
  **when**, **unless**, **wish**, **generate-text**, **generate-object**: yes
  (e.g. `const text = generateText({ prompt: "hi" }).for("text", true)` —
  `jsx-expressions/generate-text-local-ternary.expected.jsx`).
- **runtime-call**: only reactive-origin exports (§5), and only at variable
  position.
- **cell-for** and **pattern-tool**: never (they already carry explicit
  identity / are descriptors; test: "does not re-root pattern factory
  identifiers in tool descriptors").
- **array-method**: only reactive ones — a lowered `*WithPattern` call with
  reactive ownership, or a `map`/`filter`/… whose receiver has reactive
  collection provenance or is itself a qualifying call
  (`isReactiveArrayMethodCall`). Plain array methods over plain data inside
  lift/handler callbacks stay untagged (tests: "does not add causes to plain
  array methods in lift callbacks" / "…in lowered handler callbacks").
- Calls whose callee is a **pattern factory** (`Child({...})` where `Child` is
  a `pattern(...)` result; `isPatternFactoryCalleeExpression`) are excluded
  before all of the above — the sub-pattern instance is not re-caused, though
  reactive values in its argument object still get property causes (test:
  "does not add root causes to pattern factory outputs" pins the absence of
  `.for("child", true)` alongside `.for(["child", "value"], true)`).
- Variable position only, as a last resort: a call whose resolved type is
  cell-like (`isCellLikeType` via `getTypeAtLocationWithFallback`, consulting
  the cross-stage `typeRegistry`).

Suppression: if the receiver chain of the (visited) initializer already
contains a `.for(...)` call — property access `.for` or element access
`["for"]`, walked through call/member chains by `chainContainsForCall` — no
cause is added. Authored `.for("manual")` therefore always wins, at any chain
depth (test: "adds stable variable causes to fresh reactive initializers";
`cell-constructors` keeps authored `.for("name")` verbatim, without the
second argument).

### 13.3 Cause paths for nested values

Within a caused root, the visitor threads a path and tags nested reactive
values (`visitExpressionChildrenWithCausePath`):

- **Object properties** append the property name. Only stable names extend the
  path — identifiers, string/numeric literals, and computed names with literal
  operands (`getStablePropertyName`); `__cf`-prefixed property names and
  non-literal computed names are recursed plainly. Shorthand properties are
  expanded to full assignments when tagged.
- **Array elements** append the numeric index (spreads/holes skipped):
  `.for(["foo", "tuple", 0], true)`.
- **Call arguments** append the argument index — except a *sole*
  object/array-literal argument (after unwrapping, so `f(({ x }) as const)`
  counts), which keeps the parent path. That collapse is why
  `f({ param: Writable.of(1) })` under `const foo` yields
  `.for(["foo", "param"], true)`, not `["foo", 0, "param"]` (tests: "adds
  stable nested causes to constructed variable values", "does not add
  positional cause segments for wrapped single object arguments"). With
  multiple arguments the index appears:
  `__cfHelpers.unless(…schemas…, __cfLift_1({ path }).for(["p", 3], true),
  []).for("p", true)`
  (`jsx-expressions/helper-owned-jsx-iife-captures.expected.jsx`).
- **Member-access receivers** are descended with the same path but never get a
  mid-chain root cause (test: "does not add causes to receiver calls in
  property access chains" — no `.for("mentionable", true).result`).
- Once a root is tagged, its call arguments are **not** descended
  (`skipCallArguments`), and a transparent wrapper is tagged whole without
  descending: `(__cfHelpers.ifElse(...)).for("tree", true) as Entry[]`
  (`jsx-expressions/helper-owned-jsx-iife-default-input-local-chain-map-capture.expected.jsx`).
  Combined with the chain check this yields exactly one cause per value even
  under casts (test: "does not duplicate stable causes on asserted reactive
  initializers").

A pattern whose result is a single reactive call gets the bare root cause:
`return __cfLift_1({ input }).for("__patternResult", true)`
(`schema-transform/pattern-explicit-types.expected.jsx`). The canonical
object-result shape (`ast-transform/pattern-object-binary-add.expected.jsx`):

```ts
// Shown for illustration only.
// Shown inside a pattern body, after lowering + hoisting.
export default pattern((state) => ({
    next: __cfLift_1({ state: { count: state.key("count") } })
        .for(["__patternResult", "next"], true)
}), /* argument schema */, /* result schema */);
```

### 13.4 Reactive identifier re-rooting

Inside object-literal properties (only there), a *reference* to an existing
reactive value is re-caused at its result location: after visiting, a bare
identifier whose type is a branded cell or cell-like — or, absent type
information, is a reactive value expression (`isReactiveValueExpression`) —
gets `.for(<path>, true)` appended (`shouldRetargetReactiveReference`). The
cause names the property, not the referenced binding:

```ts
// Shown inside a pattern body.
// (test: "re-roots reactive identifier members in pattern results")
const foo = Writable.of(1, /* schema */).for("foo", true);
return {
    foo: foo.for(["__patternResult", "foo"], true),
    explicit: foo.for(["__patternResult", "explicit"], true),
};
```

Pattern-factory identifiers are exempt (`isPatternFactoryHelperExpression`),
and retargeting is disabled inside arguments of pattern-factory /
pattern-builder calls (`shouldPreserveStructuralCallArgumentReferences`), so
`{ pattern: searchWeb }` descriptors and `patternTool(searchWeb)` stay
untouched. Plain (non-cell) identifiers such as string handler params are
never retargeted (test: "does not retarget plain handler params inside local
object initializers").

### 13.5 Emitted cause grammar

`createForCall` / `createCauseExpression` emit `.for(<cause>, true)` where the
cause is:

- a **string literal** for variable names and single-segment paths
  (`["tree"]` collapses to `"tree"`; likewise `"__patternResult"`);
- an **array literal** of string/numeric literals for longer paths:
  `["__patternResult", "nested", "bar"]`, `["foo", "tuple", 0]`;
- a **`{ stream: <cause> }` object** when the tagged expression is a
  handler/action builder result or has a `Stream`-like type
  (`shouldUseStreamCause`; the type check matches a symbol or alias named
  `Stream` on any union/intersection part). Applied handlers and lowered
  `action`s therefore get `.for({ stream: "save" }, true)` /
  `.for({ stream: ["__patternResult", "readA"] }, true)`
  (test: "uses stream-scoped causes for handler result streams";
  `closures/action-partial.expected.jsx`), and `new Stream.perSpace<Event>(…)`
  gets `.for({ stream: "event" }, true)` (`cell-constructors`).

The second argument is always the literal `true` — the runtime's `allowIfSet`
flag: the synthetic cause is a *suggestion*, silently ignored if the cell
already has a cause or link, whereas authored one-argument `.for(cause)`
throws in that case (`packages/runner/src/cell.ts`, `for(cause, allowIfSet?)`).
Source-map ranges are
preserved from the original initializer (`preserveNodeSourceMap`).

### 13.6 Ordering and the hoisting interplay

Running at stage 18 means causes are derived from the final lowered shape:
`computed`/`action`/JSX expression sites have already become lift/handler
applications and IIFE-local consts (stages 8–13), schemas are injected and
generated (15, 17), and builder calls are hoisted (16). Two concrete
dependencies on `BuilderCallHoistingTransformer` (§11):

- Hoisted module-scope consts are named `__cfLift_N` / `__cfHandler_N` /
  `__cfPattern_N`, so the `__cf` name filter (§13.1) keeps this stage from
  tagging the hoisted declarations themselves — the *authored* name at the
  application site is what becomes the cause
  (`const isFolder = __cfLift_1({ kind: kind }).for("isFolder", true)`).
- The synthetic site `__cfLift_N(captures)` has a callee identifier the
  checker cannot resolve. Hoisting stamps the hoisted inner call as the
  identifier's original node precisely so that `detectCallKind` still
  classifies the application (lift-applied, or `builderName: "handler"`) "for
  downstream stages — notably ReactiveVariableFor's `.for(...)` /
  stream-cause attachment" (`src/ast/call-kind.ts`, hoisted-builder fallback;
  `src/transformers/builder-call-hoisting.ts` original-node stamping and
  member-chain anchoring comments).

### 13.7 Behavioral consequences

Stated plainly, because pattern authors observe them:

- **Renaming re-keys.** The cause is literally the lexical name
  (`declaration.name.text`) or result path. Renaming a `const` or a result
  property changes the emitted cause, and with it the link id the runtime
  derives from that cause — the value continues under a new identity.
- **No uniquification.** Unlike the hoisting stage's numbered `__cfLift_N`
  names (§11.3), causes carry no counters or scope qualifiers: two `const x =
  cell(...)` declarations in different scopes emit the identical cause `"x"`.
  Disambiguation is the runtime's concern (causes seed id derivation together
  with the creating context — `packages/runner/src/cell.ts`).
- **Authored identity always wins** — twice over: an authored `.for` in the
  receiver chain suppresses emission entirely (§13.2), and even an emitted
  suggestion is a no-op at runtime against any already-set cause or link
  (`allowIfSet`, §13.5).

The emitted-shape contract is pinned primarily by the "adds stable … causes"
/ "does not add …" tests in `test/transform.test.ts`; the fixture corpus
(§20) then shows the same shapes end-to-end.


## 14. Module-Scope Shadow Guards

`ModuleScopeShadowingTransformer` (stage 20,
`src/transformers/module-scope-shadowing.ts`) inserts one module-scope
`const <name> = undefined;` declaration for each name in
`SHADOWED_FACTORY_BINDINGS` — as of this writing `define`, `runtimeDeps`, and
`__cfAmdHooks` (`packages/utils/src/sandbox-contract.ts`). The names are the
bindings the legacy AMD module wrapper placed in the enclosing scope of every
compiled module factory; shadowing them to `undefined` at module scope makes
loader machinery unreachable from authored/compiled pattern code even if such a
wrapper binding is in scope. The stage landed with the SES-default sandbox
(#3168) and is shared vocabulary with the runner's sandbox verifier via
`@commonfabric/utils/sandbox-contract` (see §14.4).

On current `main` the AMD loader itself is deleted, so under the runtime's ESM
module-record loader there is no wrapper binding left to shadow (the comment in
`packages/runner/test/security.test.ts` above "does not expose loader machinery
on the module compartment globals" records the removal; that test asserts
`typeof define/require/runtimeDeps/__cfAmdHooks` are all `"undefined"` inside a
module compartment). The guards remain emitted as defense-in-depth, and they are
byte-pinned across effectively the whole fixture corpus (§14.5).

### 14.1 Trigger conditions

None — the stage is unconditional. It extends `Transformer` directly and does
not override `filter()` (the default returns `true`;
`src/core/transformers.ts`), unlike helper-gated stages such as
`ModuleScopeCfDataTransformer`, which extends `HelpersOnlyTransformer`. Every
source file the pipeline visits receives the guards, including:

- files with no Common Fabric imports or builders at all, and
- files that opted out via `/// <cf-disable-transform />` — the opt-out only
  suppresses the string-level helper injection (§2.1); the AST pipeline still
  runs, and for a **function-free** opted-out file the guards are the only
  synthetic addition; an opted-out file with top-level functions still gets
  stage-22 hardening (§17), which has no helper gate (verified by direct
  pipeline probe; no committed fixture pins the opt-out case).

The stage reads no cross-stage state and never reports diagnostics: its
`transform()` touches only `context.factory` and `context.sourceFile`.

### 14.2 Exact emission and placement

For each name in `SHADOWED_FACTORY_BINDINGS` (in array order), the stage builds
a `const` variable statement whose initializer is the *identifier* `undefined`
(`factory.createIdentifier("undefined")`, `ts.NodeFlags.Const`). The guard
block is spliced in after the file's **leading contiguous run of import
declarations**: `findFactoryGuardInsertionIndex` walks statements from index 0
while `ts.isImportDeclaration` holds and inserts at the first non-import
(index 0 for an import-free file). Imports that appear *after* the first
non-import statement stay where they are and do not move the guards.

```ts
// Shown for illustration only.
// Input (after earlier stages):
import { __cfHelpers } from "commonfabric";
import { handler, Cell } from "commonfabric";
interface CounterEvent { increment: number }
// …

// Output of this stage:
import { __cfHelpers } from "commonfabric";
import { handler, Cell } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface CounterEvent { increment: number }
// …
```

(This is the layout pinned by e.g.
`test/fixtures/handler-schema/simple-handler.expected.jsx`.)

The emitted text matches `createFactoryShadowGuardSource()`
(`packages/utils/src/sandbox-contract.ts`), which renders the same list as
`const ${name} = undefined;` strings — the canonical byte form the runner-side
verifier compares against (§14.4). The transformer performs no dedupe or
collision check: it does not look for existing declarations of the guard names
before inserting.

### 14.3 Ordering (why stage 19)

The stage sits in the trailing module-scope emission group (19
`ModuleScopeShadowing`, 20 `ModuleScopeCfData`, 22
`ModuleScopeFunctionHardening`), which runs after lowering and schema work is
complete (§3). It is purely syntactic — no checker, `typeRegistry`, or
capability state — so no output from schema generation (stage 17) feeds it;
conversely the
later module-scope stages leave the guards untouched: `ModuleScopeCfData` never
wraps them (`undefined` is not a data candidate — every guard appears verbatim
in fixture output) and `ModuleScopeFunctionHardening` *prepends* its helper
declarations at position 0, which is why final output reads
`__cfHardenFn…, imports…, guards…, body` rather than guards-first. The exact
stage position is pinned by the stage-order regression
(`test/pipeline-regressions.test.ts`, "CFC transformer stages stay in the fixed
order") and is behaviorally significant only in that coarse sense (invariant
C-002); no code comment claims a tighter adjacency constraint, and hoisted
builder consts (§11.3) land after the guards simply because their owning
statements do.

### 14.4 Cross-package sandbox contract

The guard names and byte form are one leg of the compile-time/runtime sandbox
contract, analogous to §11.4's `__cfReg` pairing:

- **Shared constants** — `SHADOWED_FACTORY_BINDINGS`,
  `RESERVED_FACTORY_BINDINGS` (currently the same list), and
  `createFactoryShadowGuardSource()` live in
  `packages/utils/src/sandbox-contract.ts` and are imported by both the
  transformer (`module-scope-shadowing.ts`) and the runner verifier
  (`packages/runner/src/sandbox/compiled-bundle-verifier.ts`).
- **Verifier mechanism** — `classifyModuleItems` (the format-agnostic SES
  module-item classifier in `compiled-bundle-verifier.ts`) takes
  `ModuleItemClassificationOptions` with `requiredGuards` (normalized guard
  statements that MUST all be present, else "Compiled AMD factory is missing
  required wrapper shadow guards") and `reservedBindings` (names authored code
  may not declare, else "Reserved wrapper binding '<name>' is not allowed in
  SES mode", `assertFactoryBindingIsNotReserved`).
- **Live path (ESM) passes empty sets** — `verifyCompiledModuleBody`
  (`packages/runner/src/sandbox/module-record-verifier.ts`) calls the
  classifier with `requiredGuards`/`reservedBindings` both empty: "ESM modules
  have no AMD wrapper to shadow." On this path the emitted guards are neither
  required nor reserved; each verifies as an ordinary primitive `const`
  (`undefined` classifies as `{ kind: "data" }` in `classifyExpressionText`).
  The requiring/reserving configuration belonged to the deleted AMD bundle
  verifier; the options mechanism outlives it.
- **Runtime invariant that replaced the AMD checks** — the loader-agnostic
  guarantee is that no loader machinery reaches the module compartment's global
  surface (`packages/runner/test/security.test.ts`, "does not expose loader
  machinery on the module compartment globals").
- **Tooling consumer** — `cf view` classifies the three names as "module
  scaffolding" for syntax colouring via its own hard-coded copy of the list
  (`packages/cli/lib/view/vocab.ts`, `SCAFFOLDING_NAMES`), which can drift from
  `SHADOWED_FACTORY_BINDINGS` since it does not import it.

Net: on current `main` the emission is a one-directional contract — the
transformer must keep emitting statements the verifier *accepts* (primitive
consts), but no runtime component fails if the guards disappear. The fixture
corpus, not the verifier, is what pins them today.

### 14.5 Edge cases pinned by tests

- **Corpus-wide emission**: as of this writing every active
  `*.input.*`/`*.expected.*` fixture pair pins the guard block byte-for-byte
  (exact counts churn and are intentionally not pinned here — see the
  test-coverage section). The only expected files without guards are inert:
  `closures/map-generic-type-parameter.*` is `.skip`-suffixed and
  `closures/map-type-assertion.expected.jsx` has no `.input.*` partner, so the
  driver never exercises it.
- **Placement after the import block**: pinned by every fixture with leading
  imports (e.g. `handler-schema/simple-handler.expected.jsx`: guards
  immediately after the two imports, before the first interface).
- **Guards precede hoisted builder consts**: fixtures with hoists show
  `imports → guards → … → __cfLift_N/__cfPattern_N consts before their owning
  statements` (§11.3 interplay).
- **Not pinned by committed tests** (verified only by direct probe as of this
  writing): guard insertion into `/// <cf-disable-transform />` files;
  insertion after only the *first* contiguous import run when imports are
  interleaved with statements; behavior when authored code already declares a
  guard name at module scope (no collision check exists in the transformer).


## 15. Module-Scope `__cf_data` Wrapping (SES Plain-Data Snapshots)

`ModuleScopeCfDataTransformer` (stage 21,
`src/transformers/module-scope-cf-data.ts`) wraps qualifying module-scope
initializers and default exports in `__cfHelpers.__cf_data(...)`. The wrap
exists for the runner's SES sandbox: the module verifier only admits top-level
values it can classify as `builder | data | function | import`, and rejects raw
mutable literals and arbitrary call results at module scope
(`classifyExpressionText`,
`packages/runner/src/sandbox/compiled-bundle-verifier.ts`; policy narrative in
`docs/specs/module-loading-verifier-and-engine-design.md` §"Security
classification"). `__cf_data(...)` is the canonical "verified module-safe
data" wrapper of that grammar: the verifier pattern-matches the wrapper
boundary without interpreting the payload, and at module load the runtime
helper — `__cf_data` is bound to `freezeVerifiedPlainData`
(`packages/runner/src/builder/factory.ts`,
`packages/runner/src/sandbox/plain-data.ts`) — validates the value that
survives load and deep-freezes it into an inert snapshot
(`docs/specs/sandboxing/SES_SANDBOXING_SPEC.md` §4.2.3, §4.2.6). At the type
level the helper is an identity function (`CfDataFunction = <T>(value: T) =>
T`, `packages/api/index.ts`), so wrapping does not perturb inference.

The stage extends `HelpersOnlyTransformer` (`src/core/transformers.ts`), so it
runs only when the injected `__cfHelpers` import is present — i.e. for every
default-transformed source (§2.1) and never under
`/// <cf-disable-transform />` (asserted by `test/transform.test.ts`, "skips
snapshot wrapping when cf-disable-transform is present"). Introduced when SES
became the default runner sandbox (#3168, originally emitting `__ct_data`;
renamed with the Common Tools compatibility-layer removal, #3252); the
default-export callable rule below was added by the SES default-export
builder-check fix (#3315).

### 15.1 Trigger conditions

Only two top-level statement kinds are inspected
(`transformTopLevelStatement`); everything else — expression statements
(including the trailing `__cfReg({...})` from §11), function/class
declarations, imports — passes through unchanged:

1. **`const` variable statements** (any declarator with an initializer;
   `let`/`var` lists are skipped via the `NodeFlags.Const` check — the verifier
   independently rejects non-`const` module state, per
   `module-loading-verifier-and-engine-design.md`). Export modifiers are
   irrelevant to the check and preserved.
2. **Export assignments** (`export default expr`) — same predicate, plus the
   default-exported data-callable rule (§15.3).

An initializer is wrapped when `shouldWrapTopLevelExpression` accepts it.
First, two negative gates: initializers asserted to `any`/`unknown` (`as any`,
`<unknown>expr`, including parenthesized forms) are never wrapped
(`isAnyLikeTypeAssertion`), and arrow functions, function expressions, and
class expressions are never wrapped (functions are stage 22's business, see
§15.4). Classification then looks through non-semantic wrappers —
parentheses, `as`, `satisfies`, `!`, angle-bracket assertions
(`unwrapExpression`, `src/utils/expression.ts`) — while the emitted wrap
encloses the original expression, wrappers included:

- **Call expressions.** Excluded first: calls whose callee names a trusted
  builder — `action`, `computed`, `derive`, `handler`, `lift`,
  `multiUserTest`, `pattern` (`isTrustedBuilder`,
  `@commonfabric/utils/sandbox-contract`). Matching is name-based
  (`hasNamedTarget`): a bare identifier or the terminal property name
  (`__cfHelpers.lift`), not §5 provenance detection. Otherwise a call is
  wrapped when any of these arms match:
  - trusted data-helper call: `schema`, `__cf_data`, `nonPrivateRandom`,
    `safeDateNow` (`isTrustedDataHelper`, same module);
  - immediately-invoked function expression (`isImmediatelyInvokedFunction`);
  - `Array.from(...)` or `Object.fromEntries(...)`
    (`isIntrinsicCtDataCall`);
  - call to a local top-level callable — a top-level function declaration or
    `const` arrow/function-expression binding
    (`collectTopLevelCallableBindings`, `isTopLevelLocalHelperCall`);
  - bare-identifier call whose checker-resolved result type is
    primitive-like — String/Number/Boolean/BigInt-like, `null`, `undefined`,
    `void`, and unions/intersections thereof (`isPrimitiveSnapshotCall`,
    `isPrimitiveLikeType`);
  - any call whose callee is a property access (`receiver.method(...)`).
- **`new` expressions.** Only `new Map(...)` and `new Set(...)`
  (`CF_DATA_CONSTRUCTOR_NAMES`). Notably `new Proxy(...)` is left unwrapped —
  "Proxy snapshots stay unsupported until Proxy is re-enabled in SES
  compartments" (`test/transform.test.ts`, "wraps top-level data candidates
  with __cfHelpers.__cf_data").
- **Literals.** Regular-expression literals, object literals, and array
  literals are always wrapped.
- Everything else — identifier references, primitive literals, template
  literals, property accesses — is not wrapped; the verifier classifies
  primitive-like initializers as data without a wrapper
  (`isPrimitiveLikeExpression`, `compiled-bundle-verifier.ts`).

If no declarator or export changed, the source file is returned unmodified.

### 15.2 Emission

`wrapWithCfData` emits a call to the `__cf_data` property of the injected
helpers binding, with the original initializer as sole argument. The authored
callee is not rewritten — only circumfixed (`test/transform.test.ts` asserts
`safeDateNow()` wraps to `__cfHelpers.__cf_data(safeDateNow())` and that
`__cfHelpers.safeDateNow` never appears):

```ts
// Shown for illustration only.
// Authored (module scope):
const model = schema({ type: "string" } as const);
const days = Array.from({ length: 3 }, (_, i) => String(i + 1));
const matcher = /^[a-z]+$/;
const tags = new Set(["a", "b"]);
const passthrough = lift((value: string) => value);

// After stage 20 (abridged from test/transform.test.ts):
const model = __cfHelpers.__cf_data(schema({ type: "string" } as const));
const days = __cfHelpers.__cf_data(Array.from({ length: 3 }, (_, i) => String(i + 1)));
const matcher = __cfHelpers.__cf_data(/^[a-z]+$/);
const tags = __cfHelpers.__cf_data(new Set(["a", "b"]));
const passthrough = lift((value: string) => value); // builder call — excluded (hoisted/registered per §11)
```

The most common wrap in fixture output is the schema literal §12 materializes:
`toSchema<T>()` becomes `{...} as const satisfies __cfHelpers.JSONSchema`,
which stage 20 then wraps whole — assertions preserved inside the call:

```ts
// Shown at module scope.
const configSchema = __cfHelpers.__cf_data({
  type: "object",
  /* … */
} as const satisfies __cfHelpers.JSONSchema);
```

(`test/fixtures/schema-transform/with-options.expected.jsx`; a
default-exported object literal wraps the same way:
`export default __cfHelpers.__cf_data({ logPiecesList, getStatus });` in
`test/fixtures/ast-transform/lift-explicit-toschema.expected.jsx`.) The wrap
appears across dozens of expected fixtures; grep `__cf_data` under
`test/fixtures/` for current coverage.

Wrapping a helper that already freezes (e.g. `schema(...)`, which the runtime
binds to the same freezer — `packages/runner/src/builder/factory.ts`) is
redundant but harmless: `freezeVerifiedPlainData` short-circuits on
already-verified values via the `verifiedPlainData` WeakSet
(`packages/runner/src/sandbox/plain-data.ts`).

### 15.3 Default-exported call-result wrappers (deliberate load failure)

`export default helper` is additionally wrapped when `helper` is a local
top-level callable whose body may return a **call applied to another call
result** — the `factory()()` shape — including when that expression is nested
inside a returned object/ternary, and stopping at nested function/class
boundaries (`collectDefaultExportedDataCallables`,
`callableMayReturnCallResult`, `isCallOnCallResultExpression`; positive and
negative cases in `test/module-scope-cf-data.test.ts`). Emission:
`export default __cfHelpers.__cf_data(helper)`.

This wrap is not a snapshot — it is a **rejection**. `freezeVerifiedPlainData`
throws `Unsupported value type 'function'` on callables
(`packages/runner/src/sandbox/plain-data.ts`), so the module fails at load.
That is asserted end-to-end: the runner engine tests compile such a module,
check the emitted `__cf_data(ChildManager)`, and expect evaluation to reject
with exactly that error (`packages/runner/test/engine-evaluate-record-graph.test.ts`, "wraps
default-exported call-result wrappers in __cf_data" and "wraps nested and
branched default-exported call-result wrappers"). Rationale (#3315): a plain
function that forwards a builder-factory instantiation (e.g.
`function ChildManager(input) { return makeWrapper(Child)(input); }`) would
otherwise classify as an allowed direct-function default export and carry
builder call results past the verifier's default-export rule; the wrap turns
that shape into a deterministic load-time failure, while default-exported
functions that only call plain local helpers stay allowed and callable
(`engine-evaluate-record-graph.test.ts`, "allows default-exported functions that call plain local
helpers"). Relatedly, nothing `__cf_data` produces can launder builder trust:
trust-requiring sites check the trusted brand, not the structural shape
(`packages/runner/src/builder/pattern-metadata.ts`,
`packages/runner/src/pattern-manager.ts`).

### 15.4 Why stage 20

- **After `SchemaGeneratorTransformer` (stage 18):** materialized schema
  literals are object literals at module scope; running after materialization
  is what gets them wrapped (§15.2 fixtures). Before it, the authored
  `toSchema<T>()` call matches no wrap arm, so the literal would reach the
  verifier raw and be rejected as mutable top-level data.
- **After `BuilderCallHoistingTransformer` (stage 17):** the hoisted
  `const __cfLift_N = __cfHelpers.lift(...)` consts exist by stage 20 and are
  excluded by the trusted-builder arm; the trailing `__cfReg({...})` call is
  an expression statement and out of scope (§15.1).
- **Before `ModuleScopeFunctionHardeningTransformer` (stage 23):** hardening
  rewrites top-level function initializers to `__cfHardenFn(...)` calls and
  declares `__cfHardenFn` as a top-level function. Had cf-data run afterwards,
  those calls would match the local-helper-call arm and function values would
  be mis-wrapped into throwing `__cf_data` snapshots. (Derived from
  `isTopLevelLocalHelperCall` plus the hardening emission; no dedicated
  regression test pins this ordering.)
- The relative order against `ModuleScopeShadowingTransformer` (stage 20) is
  not observably load-bearing: the shadow guards' `undefined` initializers
  match no wrap arm (derived; guards in
  `src/transformers/module-scope-shadowing.ts`).

The stage order itself is pinned by the §3 regression
(`test/pipeline-regressions.test.ts`, "CFC transformer stages stay in the
fixed order").

### 15.5 Verifier contract (cross-package, normative)

The emitted shape is one half of a pattern-matched contract with the runner's
SES module verifier; the shared vocabulary lives in
`@commonfabric/utils/sandbox-contract` (`TRUSTED_BUILDERS`,
`TRUSTED_DATA_HELPERS`, `isTrustedBuilder`, `isTrustedDataHelper`), which both
the transformer (`src/transformers/module-scope-cf-data.ts` imports) and the
verifier (`packages/runner/src/sandbox/policy.ts` re-exports) consume. On the
verifier side (`packages/runner/src/sandbox/compiled-bundle-verifier.ts`):

- raw mutable initializers — normalized text starting `{`, `[`, `/`, or `new`
  (`isRawMutableExpression`) — are rejected with "Mutable top-level data must
  be wrapped in __cf_data() in SES mode";
- calls to local functions or untrusted imports are rejected with "Top-level
  call results must be wrapped in __cf_data() in SES mode"
  (`TOP_LEVEL_CALL_RESULT_ERROR`, `policy.ts`); IIFEs are likewise rejected
  outside a `__cf_data` argument;
- a `__cf_data` call must have **exactly one argument**
  (`verifyTrustedDataCall`) and its callee must resolve through a trusted
  runtime binding — an import binding whose `trustedRuntimeName` is a trusted
  data helper, or a member chain off the runtime namespace import, including
  the compiled `commonfabric_1.__cfHelpers.__cf_data` two-property form
  (`resolveTrustedCallName`);
- an accepted call classifies the binding as kind `"data"`, which is an
  allowed default export ("Default exports must be trusted builders, direct
  functions, verified data, or import re-exports").

The verifier checks the wrapper boundary and call shape only — it does not
interpret the payload; load-time enforcement is the runtime freezer, which
admits the module-safe subset (plain objects, arrays, `Map`→`FrozenMap`,
`Set`→`FrozenSet`, non-global/non-sticky RegExp, primitives/bigint) and throws
`PlainDataValidationError` on everything else
(`SES_SANDBOXING_SPEC.md` §4.2.3; `packages/runner/src/sandbox/plain-data.ts`).
The same classification serves both the AMD factory body and the per-module
ESM record body (`classifyModuleItems` doc comment;
`docs/specs/module-loading-verifier-and-engine-design.md`); on the ESM path,
write-once exports neutralize side effects smuggled into an accepted wrapper
argument (`__cf_data((exports.x = evil, 1))`), and pipeline-compiled bodies are
required precisely because bare `ts.transpileModule` cannot produce the
`__cf_data` wrapping (`packages/runner/src/sandbox/module-record-compiler.ts`).

### 15.6 Alternate wiring (`__cfDataHelper`), removed — historical

Until the 2026-07 docs audit the transformer and `CFHelpers` retained a
second, data-helper-only emission path from the opt-in era (#3168), when
modules without a `/// <cts-enable />` directive received only a
`__cf_data as __cfDataHelper` import from the runner's pretransform (via a
string-pass `injectCfDataHelper` helper): with `__cfHelpers` absent,
`wrapWithCfData` fell back to that import binding or a bare `__cfDataHelper`
identifier plus a prepended import, and `shouldWrapTopLevelExpression`
narrowed to primitive-snapshot calls only. The wiring became unreachable when
transforms went default-on (#3254 removed the pretransform call site; the
`HelpersOnlyTransformer` filter guarantees `sourceHasHelpers()` at every wrap
site) and its output had drifted out of contract — `__cfDataHelper(...)` is
not in `TRUSTED_DATA_HELPERS`, so the sandbox verifier would not classify the
fallback's wraps. The audit removed the whole path: `injectCfDataHelper`, the
fallback emission arms, `createCfDataHelperImport`, and the
`getDataHelperExpr` / `sourceHasDataHelper` recognizer surface.
`wrapWithCfData` now has the single §15.2 emission form, and `getHelperExpr`
throws if the filter invariant is ever violated (pinned in
`test/module-scope-cf-data-coverage.test.ts`). `test/transform.test.ts` once
asserted `__cfDataHelper` absent from opted-out output; #4463's
structural-assertion rewrite already dropped that literal check, and after
this removal no code in the package references the identifier at all.


## 16. Pattern Runtime Coverage Instrumentation

`PatternCoverageTransformer` (stage 22) injects statement-level coverage
counters into authored runtime code. It is off by default and is the only
stage gated on a harness-supplied option rather than on source content: its
`filter` requires `TransformationOptions.patternCoverage` to be set and the
file not to be a declaration file, and a filtered-out stage returns the source
file untouched (`Transformer.toFactory`, `src/core/transformers.ts`). Nothing
inside this package ever sets the option; it exists for the runner's `cf test`
pattern-coverage mechanism described in `docs/development/COVERAGE.md`.

### 16.1 Enablement and plumbing

`TransformationOptions.patternCoverage?: PatternCoverageOptions`
(`src/core/transformers.ts`) has three members: a required
`registerSpan(span)` sink, an optional `fileName(sourceFileName)` remap, and
an optional `mapSpan(span)` that may rewrite a span or veto it by returning
`undefined` (a vetoed span is neither registered nor counted — no hit
statement is emitted for it).

The option is constructed end-to-end by the runner/CLI chain:

1. `cf test` resolves a coverage directory from the `--pattern-coverage-dir`
   flag, falling back to the `CF_PATTERN_COVERAGE_DIR` environment variable
   (`packages/cli/commands/test.ts`). Per `docs/development/COVERAGE.md`, that
   variable is read in exactly this one place — jobs running plain `deno test`
   or talking to a Toolshed server never reach this code, so setting it there
   has no effect.
2. The test runner builds one `PatternCoverageCollector` per test file and
   passes it as the `patternCoverage` harness option to
   `engine.compileAndEvaluateModules` (`packages/cli/lib/test-runner.ts`; the
   option is declared as a module augmentation of
   `TypeScriptHarnessProcessOptions` in
   `packages/runner/src/pattern-coverage.ts`). Multi-user tests instead build
   one collector per participant inside each worker and suffix the output
   filename with the participant name
   (`packages/cli/lib/multi-user-test-worker.ts`); the orchestrating runner
   disables its own local write for those tests.
3. The engine wraps the collector into the actual `PatternCoverageOptions` —
   `registerSpan` forwards to the collector, `fileName`/`mapSpan` implement
   the filename and line remapping of §16.5
   (`patternCoverageOptionsForCompile`,
   `packages/runner/src/harness/engine.ts`) — and hands it to the
   `CommonFabricTransformerPipeline({ patternCoverage })` it constructs for
   the compile.

### 16.2 What gets instrumented

Instrumentation is statement-based: one span is registered per instrumentable
statement (or body), and a *hit statement* is inserted immediately before it.
Reaching the statement marks the span's whole source range as run
(`docs/development/COVERAGE.md`).

Statement lists visited for per-statement counters (`instrumentStatements`):
source-file top level, `Block`, `ModuleBlock` (i.e. bodies of namespaces that
survive erasure), class static blocks, and `case`/`default` clause statement
lists. An empty fall-through `case`/`default` clause gets a clause-level span
so reaching the label is still recorded (`visitCaseOrDefaultClause`; test
"empty fall-through switch case is recorded").

`shouldInstrumentStatement` excludes statements with no runtime effect of
their own: `declare`-modified statements, function declarations and class
declarations (their *bodies* are still instrumented), interfaces, type
aliases, `const enum`s, namespaces that erase entirely (checked recursively
by `isErasedModuleDeclaration`, including nested and dotted forms), and
import/export declarations. Fully type-erased statements are not even
descended into (`instrumentStatements` skips `visit` for them). Directive
prologues stay first: at the source-file top level and in function-like block
bodies, `"use strict"` strings keep their position and hit statements are
inserted after the prologue (`isDirectiveStatement`,
`preserveDirectivePrologue`; a leading *non-directive* string statement is
instrumented normally — both behaviors pinned in
`test/pattern-coverage-transformer.test.ts`).

Beyond statement lists, `visit` instruments:

- **Function-like bodies** — arrow functions, function
  declarations/expressions, methods, constructors, and get/set accessors
  (`visitFunctionLike`). An expression-bodied arrow is rewritten to a block:
  `x => expr` becomes `x => { <hit>; return expr; }`
  (`instrumentConciseBody`).
- **Braceless control-flow bodies** — `if`/`else` branches
  (`visitIfStatement` / `instrumentStatementBody`) and
  `do`/`while`/`for`/`for-in`/`for-of` bodies (`wrapVisitedStatementBody`)
  are lifted into synthetic blocks carrying the hit statement, so single-line
  forms like `if (flag) doThen();` record branch execution (test
  "single-statement control-flow bodies are wrapped and recorded").

Span positions are 1-based line/column ranges resolved against the authored
source file via `sourceRangeForSpan`, which falls back from the node to
`ts.getOriginalNode(node)` and then to the node's source-map range — so
statements rebuilt as synthetic nodes by any of the 20 earlier stages still
report their authored location (test "statements rebuilt as synthetic nodes
still get coverage"). A statement whose position cannot be recovered is left
uncounted rather than mislocated. Span ids count up from 1 per source file;
`kind` is always `"runtime"`, the sole member of `PatternCoverageKind`
(`src/core/transformers.ts`).

### 16.3 Emitted shape

Each counter is a call to `hit` on the sandbox global named by
`PATTERN_COVERAGE_GLOBAL` (`"__cfPatternCoverage"`,
`src/core/transformers.ts`), passing the (possibly remapped) file name and
span id. The callee is an optional-chain property access, so the printed form
is parenthesized (asserted in `test/pattern-coverage-transformer.test.ts`):

```ts
// Shown for illustration only.
// Inserted before the instrumented statement.
(globalThis.__cfPatternCoverage?.hit)("mapped:/pattern.tsx", 1001);
```

Note the parenthesization: the `?.` guards only the property *read*; if the
global were absent, the statement would throw `TypeError`, not no-op. This
does not arise in practice because instrumented output exists only in
coverage compiles, and the runner installs the global for every evaluation of
a coverage-compiled graph (§16.7).

The registered span carries `{ fileName, id, kind: "runtime", startLine,
endLine, startColumn, endColumn }`; the transformer test "maps every
registered span" pins the exact shape, e.g. `const first = 1;` on authored
line 1 registers (after that test's +10/+100 `mapSpan`):

```ts
// Shown for illustration only.
{ fileName: "mapped:/pattern.tsx", id: 11, kind: "runtime",
  startLine: 101, endLine: 101, startColumn: 1, endColumn: 16 }
```

### 16.4 Why stage 21 (ordering)

Coverage runs second-to-last: after every lowering, schema, and module-scope
rewriting stage, so counters attach to the final shape of authored bodies
(closure-lowered callbacks included — pinned end-to-end by "pattern coverage
records callback body lines after the full pipeline" in
`packages/runner/test/pattern-coverage.test.ts`), with the original-node
fallback of §16.2 recovering authored positions for rebuilt statements. It
runs **before** `ModuleScopeFunctionHardeningTransformer` (stage 23) for the
reason stated on the stage spec itself (`src/cf-pipeline.ts`): "Coverage runs
before function hardening. That keeps coverage counters out of the hardening
helper output." — i.e. the synthetic hardening helpers emitted by stage 22
never acquire counters, so coverage reports only authored code. The stage
list itself is pinned by `test/pipeline-regressions.test.ts`.

### 16.5 Coupling: the one-line helper prelude and `lineOffset: -1`

The transformer computes span lines against the file it sees — which, for
every transformed module, is the helper-injected source of §2.1, not the
authored bytes. `injectCfHelpers` (`src/core/cf-helpers.ts`) builds
`[HELPERS_STMT, source, usedStmt].join("\n")`: exactly **one** line (the
`__cfHelpers` import) is prepended, and the forwarding `h(...)` helper is
appended after the source. The runner compensates in its `mapSpan`
(`patternCoverageOptionsForCompile`, `packages/runner/src/harness/engine.ts`):

- every span is shifted by `lineOffset: -1` — or `0` when the source disables
  the transform (`sourceDisablesCfTransform`), since the opt-out path blanks
  the directive line in place and injects nothing;
- spans falling outside `[1, authoredLineCount]` after the shift are vetoed
  (`mapSpan` returns `undefined`), which drops counters from injected helper
  code: the prepended import could never span (imports are excluded, §16.2),
  but the appended `h` function's body would — the range check removes it,
  and the veto also suppresses the hit statement itself.

This is a deliberate two-sided contract, documented at both ends: the
`HELPERS_STMT` comment in `src/core/cf-helpers.ts` ("Runner pattern coverage
line remapping treats this helper import as a one-line prelude. Changes to
its line count need a matching update in patternCoverageOptionsForCompile.")
and the mirror comment on `patternCoverageOptionsForCompile`. Changing the
prelude's line count without updating the offset shifts every reported line.
Regression tests: "pattern coverage records original runtime lines", "…keeps
authored lines for mixed default and named imports", and "…keeps authored
lines when Common Fabric transform is disabled"
(`packages/runner/test/pattern-coverage.test.ts`).

File names are remapped alongside lines: the engine's `fileName` callback
(`coverageFilenameFor`) strips the whole-program `/<id>` prefix via
`storedFilenameFor`, while fabric-mount paths keep their
`/~cf/<identity>/...` form as the module-identity key; the collector's report
later normalizes mount paths to `cf-mount/...`
(`packages/runner/src/pattern-coverage.ts`).

### 16.6 Coupling: the compile byte cache is bypassed

In `compileToRecordGraph` (`packages/runner/src/harness/engine.ts`), the
cached-body lookup is short-circuited whenever coverage is on:

```ts
// Shown for illustration only.
// Coverage compiles need fresh emitted JavaScript because cached bodies do
// not include counters.
const cached = patternCoverage !== undefined
  ? undefined
  : options.precompiledModules ?? /* lazy precompiledModulesFor(...) */;
```

Both cache channels (`precompiledModules` and the lazy
`precompiledModulesFor`) are ignored, forcing a full TypeScript compile
through the transformer pipeline even when every module would otherwise be a
cache hit — a coverage run must produce instrumented bodies. The invariant
the comment relies on ("cached bodies do not include counters") holds on the
write side too: `compileToRecordGraph` still builds cache write-back
descriptors from the (instrumented) emitted JS, but the coverage entry point
`compileAndEvaluateModules` discards them — cache write-back is a separate
`PatternManager` step not used by `cf test` — so instrumented bodies do not
enter the cache. Regression test: "ignores precompiled bodies when pattern
coverage is enabled" (`packages/runner/test/esm-engine.test.ts`), which seeds
a poisoned full-hit cache and asserts a coverage compile recompiles and
counts lines.

### 16.7 Runtime consumption and LCOV

The consumer is `PatternCoverageCollector`
(`packages/runner/src/pattern-coverage.ts`): `registerSpan` records spans at
compile time; `hit(fileName, id)` increments a per-span counter at run time.
The engine remembers the collector per compiled graph
(`patternCoverageByGraph` WeakMap) and, on evaluation, installs
`collector.sandboxGlobal()` — an object exposing only `hit` — as
`globalThis.__cfPatternCoverage` in the module compartment's globals
(`packages/runner/src/harness/engine.ts`). Because spans are registered at
compile time and counted at run time, a compiled-but-never-executed statement
reports as an explicit zero-hit line rather than being absent.

`collector.report()` groups spans by normalized path (excluding `*.test.*`
files unless `includeTestFiles` is set) and resolves per-line hits with a
narrowest-span-wins rule plus a boundary-line maximum
(`hitsByRuntimeLine`): the narrowest span covering a line decides its count —
so an outer multi-line statement span cannot mark an unexecuted nested
callback body as covered — while a span's own start/end lines count as hit
when the span is hit, so compact one-liners like `if (flag) value = 1;`
record correctly (runner tests "…does not let outer spans cover unrun
callback bodies" and "…treats compact control flow as line coverage"). Only
`kind: "runtime"` spans participate.

`writePatternCoverageLcov` / `patternCoverageReportToLcov` emit standard LCOV
(`TN:pattern-runtime`, `SF`, per-line `DA`, `LF`/`LH`), with `DA` lines in
**authored** coordinates thanks to §16.5 — from "pattern coverage records
original runtime lines" (`packages/runner/test/pattern-coverage.test.ts`),
where `main.choose(1)` skips the authored `return 0;` on line 6:

```
TN:pattern-runtime
SF:/main.tsx
DA:2,1
DA:3,1
DA:4,1
DA:5,1
DA:6,0
LF:5
LH:4
end_of_record
```

`cf test` writes one
`<url-encoded relative test path>[--<participant>].pattern-coverage.lcov`
file per test into the coverage directory (`patternCoverageOutputPath`;
`packages/cli/lib/test-runner.ts`). Per `docs/development/COVERAGE.md`, those
files feed the CI coverage-debt gate as the sole source of covered-line data
for authored pattern files (currently only the `pattern-unit-test` job), and
`DA` records exist only for lines the instrumentation could name — the
denominator caveat documented there.

Test inventory for this stage: transformer unit suite
`test/pattern-coverage-transformer.test.ts`; end-to-end line mapping and LCOV
`packages/runner/test/pattern-coverage.test.ts`; cache bypass
`packages/runner/test/esm-engine.test.ts`; flag/env-var enablement
`packages/cli/test/test-runner-pattern-coverage.test.ts`; stage order
`test/pipeline-regressions.test.ts`. The `*.input.*`/`*.expected.*` fixture
corpus (§20) never enables the option, so fixture expectations contain no
counters.


## 17. Module-Scope Function Hardening And Verified-Binding Annotation

`ModuleScopeFunctionHardeningTransformer` (stage 23, **last**) rewrites a
module's top level so that every surviving module-scope function value is
frozen at module-evaluation time, and so that CFC trusted bindings carry a
machine-readable binding identity. It emits up to two module-local helper
function declarations and wraps or annotates top-level bindings with calls to
them (`src/transformers/module-scope-function-hardening.ts`). It extends the
base `Transformer` with no `filter` override, so it runs on every source file
the pipeline processes (`src/core/transformers.ts`). Both helpers' names and
the metadata field are imported from the cross-package sandbox contract:
`FUNCTION_HARDENING_HELPER_NAME = "__cfHardenFn"`,
`BINDING_IDENTITY_HELPER_NAME = "__cfBindVerifiedBinding"`,
`VERIFIED_BINDING_METADATA_FIELD = "__cfVerifiedBindingIdentity"`
(`packages/utils/src/sandbox-contract.ts`). The stage landed with the switch
to SES as the default runner sandbox (#3168); the verified-binding annotation
is CT-1665.

This is the one stage whose output is not merely consumed by the runtime but
**pattern-matched byte-for-byte by the runtime's security verifier** — see
§17.6.

### 17.1 Purpose: SES load-time freezing

The SES sandboxing model treats module-scope bindings as the main cross-
invocation communication channel to close: each callback invocation must be
isolated from shared mutable module state except through trusted Common
Fabric abstractions, and "closure-based data leakage" is mitigated by
"direct-function-only top-level forms plus function hardening"
(`docs/specs/sandboxing/SES_SANDBOXING_SPEC.md`, Key Principles and §11.1
threat table). Direct top-level functions are the one top-level category the
verifier admits without a data wrapper, and they must be "hardened
immediately after definition" (same spec, §4.2.2).

The emitted `__cfHardenFn` helper implements exactly that freeze:

```ts
function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
```

(AST-built in `createFunctionHardeningHelper`; the transformer emits a typed
`fn: Function` parameter, which TS emit strips back to the canonical untyped
form.) Semantics: freeze the function object itself (no property adds/writes,
no `fn.foo = …` side channel) and, when the function has an object-valued
`.prototype` (function expressions/declarations do; arrow functions do not),
freeze that prototype one level deep. This is a shallow `Object.freeze`, not
SES `harden()` — no transitive freezing of reachable values.

Per the SES spec's "Compiler Assists, Runner Enforces" principle, this
emission is canonical-form normalization, not the trust boundary itself:
"compiler output is not trusted and the runner must verify the final code
boundary" (`SES_SANDBOXING_SPEC.md`, Key Principles item 6, and its Phase 1
workstream "normalize direct top-level functions into canonical forms such as
`__cfHardenFn(function ...)`"). The runner independently re-freezes with the
same semantics elsewhere: `hardenVerifiedFunction`
(`packages/runner/src/sandbox/function-hardening.ts`) is applied to builder
implementations and registered verified functions
(`packages/runner/src/builder/{module,pattern}.ts`,
`src/harness/executable-registry.ts`), and the ESM record loader additionally
SES-`harden()`s every exported value
(`packages/runner/src/sandbox/module-record-compiler.ts`,
`hardenExportedValue`).

### 17.2 What gets hardened

The transformer visits only the source file's **top-level statements**
(`transformTopLevelStatement`); nested functions, class members, and
expression-level function values elsewhere are untouched. "Direct function"
below means an arrow function or function expression after
`unwrapExpression` — i.e. seen through parentheses, `as`, angle-bracket
assertions, `satisfies`, and non-null `!` wrappers
(`isDirectFunctionExpression`; `src/utils/expression.ts`).

Four shapes are rewritten:

1. **Named function declarations** (including `export function f` and
   `export default function f`): the declaration is kept and an expression
   statement `__cfHardenFn(f);` is appended immediately after it
   (`transformFunctionDeclaration`). Bodiless declarations — overload
   signatures, ambient declares — are skipped; for an overloaded function
   only the implementation declaration gets the trailing hardening statement
   (verified by direct pipeline run). Guarded by
   `test/transform.test.ts` "hardens direct top-level functions with a
   canonical helper" (`__cfHardenFn(next);`).

2. **Anonymous `export default function` declarations**: wrapped in place,
   the same shape as item 4 — `export default __cfHardenFn(function …);` —
   retaining `async` (`retainRuntimeFunctionModifiers` keeps only the
   `AsyncKeyword`) and the generator asterisk; no synthetic binding is
   minted. (An earlier shape minted a `const` via
   `factory.createUniqueName("__cfDefaultFn")` but re-created the export
   identifier from its bare `.text` — the §11.3 trap — so the emitted pair
   diverged and the module threw a load-time `ReferenceError`; the in-place
   rewrite removed the name pair entirely.) Guarded by
   `test/module-scope-function-hardening-coverage.test.ts` "anonymous
   default-exported function declaration is hardened in place on the export
   assignment" and "anonymous default-exported async function keeps its
   async modifier through the in-place rewrite".

3. **Variable statements** whose declarations have an identifier name and a
   direct-function initializer: the initializer is wrapped in place —
   `const step = __cfHardenFn((value: number) => value + 1);`
   (`transformVariableStatement`; asserted verbatim in
   `test/transform.test.ts`). Declarations with destructuring names or
   without initializers are left alone. The declaration keyword is **not**
   checked: top-level `let f = …`/`var g = …` direct functions are wrapped
   too (verified by direct pipeline run); the runtime verifier rejects
   non-`const` top-level bindings regardless ("Top-level mutable bindings are
   not allowed in SES mode", `compiled-bundle-verifier.ts`
   `verifyVariableStatement`). When detection unwrapped a type wrapper, the
   **original** wrapped expression is what gets hardened
   (`const wrapped = __cfHardenFn(((x: number) => x + 1) as unknown);`,
   verified by direct pipeline run); TS emit erases the type wrapper before
   the verifier sees it.

4. **Export assignments** (`export default <expr>`) whose expression is a
   direct function: wrapped in place,
   `export default __cfHardenFn((x: number) => x + 1);` (verified by direct
   pipeline run).

Everything else at top level is exempt: builder-call initializers
(`const h = handler(…)` — the builder layer hardens implementations at
runtime instead, `packages/runner/src/builder/module.ts`), `__cf_data`
wrappers and other call results, literals, classes, interfaces/type aliases
(erased at emit), `export default pattern(…)` (a call, not a direct
function), and the stage-16 hoisted `const __cfLift_N = __cfHelpers.lift(…)`
consts (call initializers; see the negative assertions in
`test/closures/module-scope-helper-hoisting.test.ts`).

Helper emission is demand-driven: each helper declaration is prepended (in
order: binding-identity helper, then hardening helper) **before every other
statement of the file, including imports**, and only when at least one use
was emitted (`transform`, the `updateSourceFile` construction). In practice
the hardening helper appears in essentially every transformed module, because
the default-on pre-transform (§2.1) injects a forwarding
`function h(…) { return __cfHelpers.h.apply(null, args); }` declaration,
which shape 1 then hardens: as of this writing the trailing `__cfHardenFn(h);`
closes 358 of the 360 `*.expected.*` fixture files (the two exceptions are a
`.skip` file and the orphaned, input-less
`closures/map-type-assertion.expected.jsx`, which predates this stage).
Helper names are `createUniqueName`-minted, so they print as bare
`__cfHardenFn`/`__cfBindVerifiedBinding` unless the printer must
disambiguate — and a suffixed name would no longer verify (§17.6).

### 17.3 Verified-binding annotation (CT-1665)

The same stage stamps CFC **trusted bindings** with their authoring identity,
so a `WriteAuthorizedBy` claim embedded in a schema can later be matched to
the live handler that performs the write.

**Which bindings are trusted.** `collectWriteAuthorizedByBindingNames` scans
the stage-22 AST for type references to `WriteAuthorizedBy`,
`TrustedActionWrite`, or `TrustedActionWriteWithIntegrity` (binding position
= type argument 1 for all three, seeded in
`discoverWriteAuthorizedByBindingPositions`), plus any local type aliases
that forward a type parameter into such a position (computed to a fixed
point, so alias-of-alias works — `collectAliasBindingPositions`; exercised by
`test/cfc-authoring.test.ts` "lowers alias-referenced trusted builder
bindings"). Within each binding-position type argument, every `typeof x`
type-query identifier contributes `x` to the trusted-name set
(`collectTypeQueryIdentifiers`). Detection is purely name-based (no
symbol/import resolution), and it sees only type references **still present
after stages 14–16**: a reference that lived solely inside a
`toSchema<WriteAuthorizedBy<…>>()` type argument was already replaced by the
schema literal in stage 17 and contributes nothing (verified by direct
pipeline run — such a module gets a plain `__cfHardenFn` wrap and no
annotation), whereas references surviving in `interface`/type-alias
declarations or un-lowered type arguments do.

**What is emitted.** For a trusted binding whose initializer is a call
expression or a direct function (`isTrustedCallable`), the transformer emits
`__cfBindVerifiedBinding(value, metadata)` where metadata is

```ts
// Shown for illustration only.
{
    sourceFile: "/test.tsx",       // normalizeWriterIdentityFile(fileName)
    bindingPath: ["saveTitle"]     // single-element: the binding name
}
```

(`annotateBindingIdentifier` / `createBindingIdentityMetadata`). Placement
depends on export-ness (`transformVariableStatement`, guarded by
`test/cfc-authoring.test.ts`):

- **Exported** trusted binding — annotated **inline**, and when the
  initializer is a direct function the hardener nests outermost:
  `export const writeFn = __cfHardenFn(__cfBindVerifiedBinding((value:
  string) => value, {…}));` (verified by direct pipeline run; builder-call
  case asserted in "lowers exported trusted builder bindings inline").
- **Non-exported** trusted binding — declaration left untouched, followed by
  a statement-form annotation `__cfBindVerifiedBinding(saveTitle, {…});`,
  and, for direct-function initializers, a statement-form
  `__cfHardenFn(writeFn);` **after** the annotation. Named function
  declarations that are trusted get the same post-statement pair
  (declaration, annotation, hardening — verified by direct pipeline run).

The annotation-before-hardening order is load-bearing: the emitted binding
helper only stamps `Object.isExtensible` values
(`createExtensibleObjectOrFunctionCheck`), and hardening freezes the
function, so the reverse order would silently drop the identity.

The emitted `__cfBindVerifiedBinding` helper defines
`__cfVerifiedBindingIdentity` (`{ value: metadata, configurable: true }`) on
the annotated value itself and, when the value carries a function-valued
`.implementation` (builder factories do), on that implementation function too
(`createBindingIdentityHelper` / `createDefineBindingMetadataCall`).

**File normalization.** `normalizeWriterIdentityFile` (backslashes → slashes,
then strip the first path segment when the path has more than one) is
deliberately duplicated, character-for-character, in
`src/transformers/schema-generator.ts`, which emits the matching claim into
schemas as `ifc: { writeAuthorizedBy: { __ctWriterIdentityOf: { file, path
} } }` (`attachWriteAuthorizedByMarker` / `extractWriteAuthorizedByIdentity`).
The stripped leading segment corresponds to the engine's per-load `/${id}`
module-path prefix (see the prefix/identity-source-normalization discussion
in `docs/specs/module-loading-verifier-and-engine-design.md`), keeping both
sides load-independent and equal.

**Runtime consumption.** After a verified evaluation,
`Engine.recordModuleProvenance` reads the annotation off each exported or
`__cfReg`-registered builder artifact (`readBindingIdentity`,
`packages/runner/src/harness/verified-provenance.ts`) and records it as
`VerifiedProvenance.bindingIdentity` against the implementation function.
CFC's implementation identity surfaces it as `sourceFile`/`bindingPath`
(`packages/runner/src/cfc/implementation-identity.ts`), and at commit the
`writeAuthorizedBy` check requires the writing identity's
moduleIdentity + normalized source file + binding path to equal the claim's
(`packages/runner/src/cfc/prepare.ts`; both sides pass through
`normalizeIdentitySource`, which only guarantees a leading slash). The
non-exported case reaches provenance through the `__cfReg` registration sink
— the gap guarded by
`packages/runner/test/cfc-nonexported-binding-identity.test.ts`.

No fixture in `test/fixtures/**` exercises `__cfBindVerifiedBinding` as of
this writing; the annotation paths are covered by `test/cfc-authoring.test.ts`
and the runner tests above.

### 17.4 Before/after example

Input (the `test/transform.test.ts` hardening case):

```ts
const step = (value: number) => value + 1;

export default function next(value: number) {
  return step(value);
}
```

Output (module scope; imports, shadow guards, and the injected `h` forwarder
shown in context — this matches `handler-schema/*.expected.jsx` shape):

```ts
function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
const step = __cfHardenFn((value: number) => value + 1);
export default function next(value: number) {
    return step(value);
}
__cfHardenFn(next);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
```

And the trusted-binding statement form (non-exported handler; pinned by
`test/cfc-authoring.test.ts`, statement-form identity-annotation case):

```ts
// Shown for illustration only.
const saveTitle = handler(/* …injected schemas… */, (_event, { title, savedTitle }) => {
    savedTitle.set(title.get());
});
__cfBindVerifiedBinding(saveTitle, {
    sourceFile: "/test.tsx",
    bindingPath: ["saveTitle"]
});
```

### 17.5 Why it runs last

The stage-22 slot (after everything, and specifically after
`PatternCoverageTransformer`) is behaviorally significant (C-002):

- **After coverage (stage 21):** "Coverage runs before function hardening.
  That keeps coverage counters out of the hardening helper output"
  (`src/cf-pipeline.ts` stage-list comment). Coverage inserts
  `globalThis.__cfPatternCoverage?.hit(…)` statements into function bodies
  (`src/transformers/pattern-coverage.ts`); a counter inside `__cfHardenFn`
  or `__cfBindVerifiedBinding` would break the verifier's byte-equality
  recognition of the canonical helper bodies (§17.6) and would count helper
  executions as pattern coverage. The verifier separately allows the
  coverage-hit statements themselves at module scope
  (`isPatternCoverageHitStatement`, `compiled-bundle-verifier.ts`).
- **After hoisting (stage 16) and schema generation (stage 17):** the
  module-scope surface it freezes/annotates is final — hoisted
  `__cfLift_N`/`__cfPattern_N` consts exist (and stay unwrapped, being call
  initializers), and trusted-name discovery sees the post-lowering AST
  (§17.3).
- **Nothing downstream re-analyzes wrapped functions.** Within one pipeline
  run no stage follows it; for analysis code that may encounter hardened
  output, call-kind resolution can see through `__cfHardenFn*(…)` wrappers
  via `unwrapHardenedCallbackExpression` (`src/ast/call-kind.ts`,
  `FUNCTION_HARDENING_HELPER_PREFIX`), and `cf view` classifies the helper
  names for display (`packages/cli/lib/view/vocab.ts`).

### 17.6 The verifier contract (cross-package, normative)

The helper names **and the exact text of the helper bodies** are a published
compile-side/runtime-side contract, centralized in
`@commonfabric/utils/sandbox-contract`
(`packages/utils/src/sandbox-contract.ts`): the transformer imports the
names; the runner's module verifier imports the same names plus
`createFunctionHardeningHelperSource()` /
`createBindingIdentityHelperSource()` — string builders whose output must be
what the transformer's AST-built helpers compile to. Changing what this stage
emits is therefore a cross-package contract change — module loading breaks
until the verifier agrees (also stated in
`packages/ts-transformers/AGENTS.md`, "Local facts"). The verifier
(`packages/runner/src/sandbox/compiled-bundle-verifier.ts`) enforces:

- **Canonical-declaration recognition by byte equality.** Every top-level
  function declaration is registered with
  `hardeningHelper`/`bindingIdentityHelper` flags set only if its
  trivia-stripped statement text equals the trivia-stripped canonical source
  (`CANONICAL_HARDENING_HELPER`, `isFunctionHardeningHelperDeclaration`,
  `registerFunctionStatement`). The design doc states the rule directly:
  "canonical function-hardening (`__cfHardenFn(fn)`) and binding-identity
  statements recognized by byte-equality to `sandbox-contract.ts` sources"
  (`docs/specs/module-loading-verifier-and-engine-design.md`). A same-named
  helper with a different body is just an ordinary function — and the module
  then fails on its call sites: pinned by the adversarial case "fake
  (non-canonical) __cfHardenFn laundering a callback"
  (`packages/runner/test/esm-verifier-adversarial.test.ts`).
- **Statement grammar.** An expression statement is admitted as hardening
  only if it normalizes to `ident(ident);` where the callee binding has
  `hardeningHelper === true` and the target binding classified as a
  **function** (`isAllowedFunctionHardeningStatementNormalized`) — so
  builders can't be statement-hardened, matching what the transformer emits.
  A binding-identity statement must normalize to `ident(ident, {…});` with
  the callee either literally named `__cfBindVerifiedBinding` or classified
  as the canonical helper, and the target classified function-or-builder
  (`isAllowedBindingIdentityStatementNormalized`).
- **Expression grammar.** In initializer/argument position,
  `__cfHardenFn(x)` must have **exactly one** argument ("Function hardening
  helpers accept exactly one argument") and `x` must classify as a direct
  function ("Function hardening must target direct function values"); the
  result classifies as that function, so
  `__cfHardenFn(__cfBindVerifiedBinding(fn, {…}))` nests. The binding helper
  takes exactly two arguments ("Verified binding annotation helpers accept
  exactly two arguments") and classifies as its first argument, which must
  not be `unknown` ("Verified binding annotation must target trusted
  top-level bindings" — pinned by the adversarial "builder callback is
  non-function data via binding-identity helper" case). Any other top-level
  call is rejected: "Only trusted builder calls, schema(), canonical
  function hardening, and canonical binding annotation are allowed at module
  scope in SES mode" (asserted in
  `packages/runner/test/compiled-module-verifier.test.ts`, which also pins
  acceptance of the exact canonical compiled form in "accepts canonical
  compiled function hardening").
- **The helper is not a callback.** A trusted-builder callback referenced by
  name must resolve to a plain function binding, explicitly excluding
  `hardeningHelper` bindings (`resolveTrustedBuilderCallback`).
- **Both loaders.** The AMD path runs this classification at compile and
  again at evaluate (`CompiledBundleValidator.verify()`); the per-module ESM
  path reuses the same `classifyModuleItems` core with empty guard sets
  (`packages/runner/src/sandbox/module-record-verifier.ts`;
  `ModuleItemClassificationOptions` doc comment). The module-loading design
  doc flags as an open question whether the canonical helper sources need an
  ESM-emit variant if the two emits ever diverge.

Consequence for maintenance: the transformer's AST helper builders
(`createFunctionHardeningHelper`, `createBindingIdentityHelper`) and the
sandbox-contract string builders are maintained **by hand in two encodings**.
Any drift between them is loud — every transformed module carries at least
`__cfHardenFn(h);` (§17.2), so a non-matching helper fails verification for
every pattern load — but there is no unit test asserting the equivalence
directly (`packages/utils/test/sandbox-contract.test.ts` covers only the
trusted-name lists).

### 17.7 Edge cases (observed)

- Overloaded functions: signatures untouched, one `__cfHardenFn(f);` after
  the implementation (direct pipeline run).
- `let`/`var` direct functions: wrapped by the transformer, then rejected by
  the verifier as mutable top-level bindings (direct pipeline run;
  `verifyVariableStatement`).
- Anonymous `export default function`: a single in-place
  `export default __cfHardenFn(function …);` statement, no synthetic binding
  (§17.2 item 2). The declaration's hoisted-binding semantics are not
  preserved — initialization moves to the statement's evaluation position,
  observable only under circular imports (the pre-fix const shape lost
  hoisting identically).
- `async` is preserved on the anonymous-default rewrite; all other modifiers
  (`export`, `default`) are dropped from the synthesized function expression
  (`retainRuntimeFunctionModifiers`). Generator asterisks pass through
  unchanged; top-level generator declarations are rejected later by the
  verifier regardless (`module-loading-verifier-and-engine-design.md`,
  security-classification list).
- Trusted names referenced **only** via `toSchema<…>()` type arguments get a
  schema-side claim but no binding annotation, because stage 17 erased the
  reference before stage 22 ran (direct pipeline run; compare
  `test/cfc-authoring.test.ts` "preserves the local binding identity through
  schema emission", which asserts only `__ctWriterIdentityOf`).
- A trusted binding whose initializer is neither a call nor a direct
  function (e.g. a literal) is skipped entirely — trusted-ness alone does
  not annotate (`transformVariableStatement` gate on `isTrustedCallable ||
  isDirectFunction`). Malformed `WriteAuthorizedBy` usage was already
  diagnosed at stage 13 (§6.8).
- The hardening wrapper preserves evaluation semantics (`return fn`), so
  wrapped initializers remain direct-function-classifiable to the verifier,
  and `Function.prototype.toString`-based `fn.src` resolution (see the
  module-loading doc) still finds the authored body text inside the wrapper
  argument.


## 18. Diagnostics Message Transformation (Optional Consumer Layer)

Diagnostic message transformers are exported separately from AST transform
pipeline. Current built-in behavior:

- `ReactiveErrorTransformer` rewrites TypeScript messages matching
  `"Property 'get' does not exist on type 'OpaqueCell<...>'"` into user-facing
  guidance about unnecessary `.get()`.
- optional `verbose` mode appends original TypeScript message.
- `CompositeDiagnosticTransformer` returns the first matching transformer
  result.

## 19. Current Known Limits (Observed)

1. Generic helper functions with uninstantiated type-parameter lift-applied
   result types can degrade schema precision (type arguments may be
   intentionally omitted).
2. Action and JSX inline handler callback extraction currently unwraps arrow
   functions only.
3. Optional-call forms on opaque pattern roots report
   `pattern-context:optional-chaining` at top level, statement position, and
   inside collection callbacks — but are accepted and lowered inside JSX
   expressions and `computed(...)` bodies (see §6.5; unratified language
   delta). Optional property/element access is supported only in explicit
   lowerable expression sites; statement-position optional access still
   errors.
4. Non-static destructuring defaults, rest destructuring, and unsupported
   computed destructuring keys in pattern callbacks remain non-lowerable and
   produce pattern-context diagnostics.
5. Interprocedural capability propagation applies only when a resolved callee
   declaration is analyzable in-proc (arrow/function
   expression/declaration/method); external/unresolved calls remain
   conservative.
6. The CFC authoring contract under `docs/specs/ts-transformer/cfc_*.md` is
   implemented for the canonical alias set: the schema-generator's
   common-fabric formatter lowers `Cfc` payloads, the wrapper aliases, the
   projection helpers, and the `WriteAuthorizedBy` writer-identity marker into
   `ifc.*` schema metadata during the `SchemaGeneratorTransformer` stage. The
   former collection/opaque helpers were removed (the runner rejects their
   lowered keys fail-closed). `WriteAuthorizedBy` usage is additionally
   validated (`cfc-write-authorized-by`, §6.8). Static policy declarations and
   `PolicyOf` bindings are additionally validated by their dedicated passes;
   schema generation resolves the resulting exact manifest marker. The
   `WriteAuthorizedBy` validation remains a separate transformer rather than a
   schema-generator responsibility.

## 20. Test Coverage Snapshot

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

The unit-test harnesses and assertion helpers themselves are documented in
`packages/ts-transformers/test/README.md` (#4498).

Additional non-fixture unit suites cover:

- cast/empty-array/pattern-context/opaque-get/schema-shrink validation
- diagnostic message transformer behavior
- event-handler detection heuristics
- reactive analysis/normalization/runtime-style APIs
- pipeline regression and policy/capability-analysis behavior
- lift-applied call helper and identifier utilities

## 21. Stability Statement

This specification is a snapshot of current behavior. Any transformer code or
fixture expectation changes should be treated as spec changes and reflected in
this document.

### 21.1 Keeping This Spec Current (Sources Of Truth)

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
| Auto-`.for()` cause triggers, cause-path grammar, and the `__patternResult` root (§13) | `shouldAddReactiveFor` / `createForCall` / `PATTERN_RESULT_CAUSE` (`src/transformers/reactive-variable-for.ts`) | emitted shapes pinned by the stable-cause tests in `test/transform.test.ts` |
| Shadow-guard binding set + canonical guard text (§14) | `SHADOWED_FACTORY_BINDINGS` / `createFactoryShadowGuardSource()` (`packages/utils/src/sandbox-contract.ts`); insertion point `findFactoryGuardInsertionIndex` (`src/transformers/module-scope-shadowing.ts`) | emission byte-pinned by ~all fixture expected outputs; verifier consumes the same constants via `RESERVED_FACTORY_BINDINGS` (`packages/runner/src/sandbox/compiled-bundle-verifier.ts`); `cf view`'s `SCAFFOLDING_NAMES` (`packages/cli/lib/view/vocab.ts`) is an unimported copy — check for drift |
| Module-scope `__cf_data` wrap/exclusion name sets + verifier error strings (§15) | `TRUSTED_BUILDERS` / `TRUSTED_DATA_HELPERS` (`packages/utils/src/sandbox-contract.ts`); `CF_DATA_CONSTRUCTOR_NAMES` (`src/transformers/module-scope-cf-data.ts`); `TOP_LEVEL_CALL_RESULT_ERROR` (`packages/runner/src/sandbox/policy.ts`) | one module feeds both transformer and runner verifier — cross-package contract; runtime freezer semantics live in `packages/runner/src/sandbox/plain-data.ts` |
| Coverage instrumentation + span schema (§16) | `PatternCoverageTransformer` (`src/transformers/pattern-coverage.ts`); `PatternCoverageSpan` / `PatternCoverageOptions` / `PATTERN_COVERAGE_GLOBAL` (`src/core/transformers.ts`) | line remapping pins the one-line helper prelude: `HELPERS_STMT` (`src/core/cf-helpers.ts`) ↔ `patternCoverageOptionsForCompile` (`packages/runner/src/harness/engine.ts`) — change them together |
| Hardening/binding helper names, metadata field, canonical helper bodies (§17) | `FUNCTION_HARDENING_HELPER_NAME` / `BINDING_IDENTITY_HELPER_NAME` / `VERIFIED_BINDING_METADATA_FIELD` and `createFunctionHardeningHelperSource` / `createBindingIdentityHelperSource` (`packages/utils/src/sandbox-contract.ts`) | the runner verifier recognizes helper declarations by trivia-stripped byte equality to these sources (`CANONICAL_HARDENING_HELPER` in `packages/runner/src/sandbox/compiled-bundle-verifier.ts`); the transformer's AST-built twins (`createFunctionHardeningHelper` / `createBindingIdentityHelper` in `src/transformers/module-scope-function-hardening.ts`) must compile to exactly that text — drift fails every module load |
| Trusted-binding type names + binding positions (§17.3) | seed map in `discoverWriteAuthorizedByBindingPositions` (`src/transformers/module-scope-function-hardening.ts`) | keep in sync with `WriteAuthorizedByValidationTransformer` (§6.8) and the schema generator's `__ctWriterIdentityOf` claim emission; `normalizeWriterIdentityFile` is intentionally duplicated in `schema-generator.ts` and must stay identical |

A drift-resistant habit: when a section enumerates a set, cite the constant /
function that defines it so a reader can confirm the live set, and keep prose
lists explicitly labeled "as of this writing."
