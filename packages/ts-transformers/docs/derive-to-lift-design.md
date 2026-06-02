# `derive` → `lift` → sandboxable: design

_Status: Phase 1 complete in CT-1615 (lift-applied form
`__cfHelpers.lift(cb)(input)`). Registry-architecture follow-up landed in PR
#3707 (registries consolidated into `CrossStageState`). No-input form switch
landed in PR #3709 (`computed`-origin lifts now emit `lift(false, fn)()` instead
of the `lift(...)({})` stopgap). **Phase 2 complete in CT-1644**
(`LiftHoistingTransformer` hoists every lift call to a module-scope
`const __cfLift_N = __cfHelpers.lift(...)`, after SchemaInjection; subsumes lift
from the CT-1585 callback hoister). Still outstanding: removing the runtime
`derive` export (deferred — not dead; see follow-ups below). Phase 3 designed at
high level; details deferred._

## Motivation

After CT-1585 landed module-scope hoisting for builder callbacks, several
follow-up improvements emerged from review (especially from Berni). The shared
thread: we want every reactive computation in lowered output to be
**addressable** (you can point to its concrete source location) and, when
possible, **sandboxable** (the computation can be stringified and executed in a
transient sandbox without breaking).

The plan is three sequential phases. Each lands as its own PR after the prior
one is merged.

| Phase | What changes                                                                                                                                                                | Who benefits                                                                                                                                  |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | Rewrite every `derive` call (user-authored + transformer-synthesized) into a `lift` call, in place.                                                                         | Establishes a single canonical builder for reactive lifted-function computations. Tooling no longer needs to special-case `derive` vs `lift`. |
| 2     | Hoist every `lift` call (the whole call, not just its callback) to module scope. The body becomes `__cfLift_N(closureInputObject)`.                                         | Every reactive computation is named and addressable. Sandboxing/serialization decisions can be made per-lift.                                 |
| 3     | Inject a `__cfHelpers.sandboxable(...)` wrapper _only on lifts that don't close over any user-authored module-scoped variables_ (and meet a few other gates — see Phase 3). | Runtime can safely move sandboxable lifts across sandbox boundaries.                                                                          |

After all three phases land for `lift`, the same pattern extends to `handler`
(which `action` lowers into) and to `pattern` (including transformer-synthesized
pattern callbacks for `mapWithPattern` and friends). Those are out of scope for
this doc but the architecture should make them tractable as follow-ups.

## Relationship to prior work

- **CT-1585** added module-scope hoisting for builder callbacks whose body
  closes only over module-level symbols. The hoister currently:
  - Lives in
    `packages/ts-transformers/src/closures/module-scope-callback-hoisting.ts`.
  - Runs as `BuilderCallbackHoistingTransformer`, scheduled immediately after
    `PatternCallbackLoweringTransformer` in `cf-pipeline.ts`.
  - Hoists the **callback** (the function-like argument), not the call.
  - Is conditional on the callback's body genuinely closing over user-authored
    module-level references (post the over-trigger/under-trigger precision fixes
    in commits 4 and 5).
- Phase 2 will **generalize** this: every `lift` gets hoisted, the call site
  reads `__cfLift_N(inputs)`, and the predicate that gates hoisting goes away.
  The mechanics from CT-1585 (counter-based naming,
  transformer-injected-identifier exclusion list, synthetic-compute-callback
  handling) carry forward.

## Phase 1: `derive` → `lift` in-place rewrite

### Goal

After Phase 1, **no `derive(...)` call exists anywhere in lowered output.**
Every reactive lift-style computation is a `lift(...)` call. This includes:

- User-authored `derive(input, callback)` and `derive<T, R>(input, callback)`
  calls.
- Transformer-synthesized `derive(input, callback)` calls produced by:
  - `createDeriveCall` in
    `packages/ts-transformers/src/transformers/builtins/derive.ts:186` (used to
    wrap JSX expressions whose return value involves opaque captures, and the
    `computed(...)` → `derive(...)` rewrite). (Post-Phase-1: renamed to
    `createLiftAppliedCall` in `src/transformers/builtins/lift-applied.ts`;
    emits the lift-applied form directly.)
  - Any other call site in the transformer that synthesizes
    `__cfHelpers.derive(...)` — these should be discoverable via grep for
    `createHelperCall(..., "derive", ...)` or similar.
- The Phase 1 implementer should also audit the `computed` builder. It is
  currently rewritten to `derive`; after Phase 1 it should rewrite to `lift`
  directly (or `computed` → `derive` → `lift` is fine as long as no `derive`
  survives).

### Constraints to verify

These are **assumed correct based on conversations with Berni** but the Phase 1
implementer must verify each empirically before relying on them:

1. **`lift` is a semantic synonym for `derive` at runtime.** Both should accept
   `(input, callback)` and produce a reactive value. Check the runtime to
   confirm — relevant entry points likely live in `packages/runner/src/`. If
   `lift` has _different_ semantics (e.g. different recomputation triggers,
   different argument shapes), the rewrite is not a simple rename and Phase 1
   must compensate (e.g. by wrapping or unwrapping the input).

2. **Captures already flow through the input-object argument.** The CT-1585 era
   closure transformer was supposed to rewrite user-authored derives so all
   captured values pass through the input object, not via lexical closure. If a
   user writes `derive(input, ({x}) => useOuterY(x))` where `Y` is
   enclosing-scope, the closure transformer should already have lifted `Y` into
   the input object. Verify this on representative fixtures. If there are
   residual cases where user-authored `derive` callbacks lexically capture
   without going through inputs, those cases need to be either (a) covered by
   Phase 1's rewrite to ensure they still work after `derive` → `lift`, or (b)
   flagged as a pre-existing bug and addressed separately.

### Implementation strategy

A new `DeriveToLiftRewriteTransformer` stage. The body of the change is small
(mostly a node visitor that rewrites builder names), but the placement in the
pipeline matters and should be determined empirically:

- **Likely placement: after `ClosureTransformer`, before
  `PatternOwnedExpressionSiteLoweringTransformer`.** The closure transformer is
  where most synthetic derives get introduced. Rewriting `derive` → `lift`
  immediately after closure means subsequent stages dispatch on `"lift"`
  uniformly.
- **But: many downstream stages still dispatch on `callKind?.kind === "derive"`
  (see `schema-injection.ts:2905`, `pattern-context-validation.ts:801`,
  `expression-rewrite/rewrite-helpers.ts:93`, `expression-site-policy.ts:404`,
  etc.).** Phase 1 must either:
  - **(a)** Place the rewrite _after_ every stage that dispatches on `derive`
    (in which case those stages all keep working unchanged). This is
    conservative but late in the pipeline.
  - **(b)** Place the rewrite earlier and update every stage to dispatch on
    `lift` (or accept both). This is more invasive but cleaner.

  The implementer should map all the derive-dispatching sites (grep
  `kind === "derive"` and `builderName === "derive"` in
  `packages/ts-transformers/src/`), then decide. Option (a) is the recommended
  starting point — get the rewrite working without churning all the dispatchers,
  then evaluate whether option (b) becomes clean later. **A single grep over the
  source after Phase 1 should find zero remaining `derive` references outside of
  CommonFabric runtime registry entries and Phase 1's own rewrite logic.**

### `callKind` infrastructure

`packages/ts-transformers/src/ast/call-kind.ts` is where `detectCallKind` lives
— the single source of truth for "what kind of call is this." After Phase 1, the
`callKind === "derive"` branch should probably be deleted (no more derives exist
post-Phase-1) and any helper functions named after `derive` should be renamed or
removed. The implementer should be careful: some helpers in this file may still
want to recognize _pre-Phase-1_ derive shapes (for backward compatibility with
external callers or for the transformer's own infrastructure). Audit each before
deleting.

### Tests

- **New fixture pair** that exercises a transformer-synthesized derive (e.g. a
  JSX expression in a map callback that captures an opaque value, so the closure
  transformer wraps the return in `derive(...)`). The `.expected.jsx` should
  contain `__cfHelpers.lift(...)` and zero `__cfHelpers.derive(...)` references.
- **Existing fixture goldens will largely change** — every fixture that
  currently shows `__cfHelpers.derive(...)` in its expected output will need its
  golden regenerated. Use `UPDATE_GOLDENS=1 deno task test` once the rewrite is
  wired up. Audit a sample of the regenerated goldens to confirm they look
  right.
- **Runtime tests must still pass.** Run
  `deno task cf test --root packages/patterns` against the failing-pattern
  repros from CT-1585 (`notes/note.test.tsx`, `notes/notebook.test.tsx`,
  `factory-outputs/parking-coordinator/main.test.tsx`) and a representative
  sample of others. If `lift` and `derive` are runtime synonyms, all should pass
  without modification.
- **Pipeline stage-order regression test** at
  `test/pipeline-regressions.test.ts:96` must be updated to include the new
  stage.

### Risks

- **`computed` rewriting**: there's an existing `ComputedTransformer` stage that
  rewrites `computed` to `derive`. After Phase 1, either that stage's output is
  rewritten to `lift` by Phase 1's pass, or `ComputedTransformer` itself starts
  emitting `lift` directly. The implementer should decide based on which keeps
  the diff small. (Post-Phase-1: the stage is renamed to
  `LiftLoweringTransformer` in `src/lift/transformer.ts` and lowers both
  `computed(...)` and user-source `derive(...)` directly to the lift-applied
  form.)
- **`derive` callbacks with explicit `<T, R>` type parameters**: user-authored
  `derive<T, R>(input, cb)` calls in source. The transformer probably reads
  those type params for schema inference at the `derive` call site. After
  rename, the type params come from the `lift<T, R>` runtime declaration — which
  should be identical, but verify.
- **Pipeline regression tests** that pin specific surface forms
  (`assertStringIncludes(output, "__cfHelpers.derive(...)`) will need to update.
  Search `test/pipeline-regressions.test.ts` and similar for hardcoded `derive`
  strings before starting.

### Out of scope for Phase 1

- Hoisting (that's Phase 2).
- Sandboxable marker (that's Phase 3).
- `handler`/`pattern` rewrites (mentioned in motivation; addressed by follow-up
  work after Phase 3).

## Phase 2: hoist every `lift` call to module scope (sketch)

After Phase 1: every reactive lift-style computation in lowered output is a
`lift(...)` call. Phase 2 hoists each one to module scope.

### Mechanic

For a call site like:

```ts
__cfHelpers.lift(
  { inputSchema },
  { outputSchema },
  captures,
  ({ x, y }) => x + y,
);
```

Phase 2 rewrites it to:

```ts
// At module scope:
const __cfLift_N = __cfHelpers.lift(
  { inputSchema },
  { outputSchema },
  ({ x, y }) => x + y,
);

// At call site:
__cfLift_N(captures);
```

Note three changes from the existing CT-1585 hoist:

1. **The entire `lift(...)` call** (schemas + callback) gets hoisted, not just
   the callback. The runtime treats the result of `__cfHelpers.lift(...)` as a
   _callable_ that takes the captures-object and returns the reactive cell. The
   call site applies the captures.
2. **No predicate.** Every lift gets hoisted, regardless of what its body closes
   over. The predicate logic from CT-1585 (`analyzeCallbackForHoisting`,
   `isTransformerInjectedIdentifier`, the ambient-globals exclusion) becomes
   Phase 3's input — it informs the _sandboxable_ decision, not the hoist
   decision.
3. **New naming prefix**: `__cfLift_N` instead of `__cfModuleCallback_N`. The
   CT-1585 prefix was generic because it covered derive/handler/lift/pattern
   callbacks; now we have a builder-specific hoist and can use a
   builder-specific prefix.

### Open questions for Phase 2 — RESOLVED (CT-1644)

- **Where in the pipeline?** **After `SchemaInjectionTransformer`, before
  SchemaGenerator. Verified empirically 2026-06-02.** A spike initially suggested
  hoisting _before_ injection was viable (injection reached the relocated const),
  but a fixture audit found it silently truncated the argSchema in nested /
  multi-capture lifts: SchemaInjection derives the argument schema from the
  _applied captures object_ (`call.arguments[0]` of the outer application), which
  hoisting-before severs from the lift — the callback's parameter type alone does
  not recover all captures. Hoisting _after_ injection bakes the complete schema
  into the still-applied `lift(argSchema, resSchema, cb)(captures)` first, so the
  relocation is schema-transparent. (Map-element `$ref` schemas regressed the same
  way under hoist-before and are likewise fixed by hoist-after.) See
  `session_outputs/2026-06-02_lift-hoist-phase2/02-ordering-correction.md`.
- **Interaction with the existing CT-1585 hoist.** **Subsume, verified.** Phase 2
  owns lift hoisting: `lift` is removed from CT-1585's `HOISTABLE_BUILDER_NAMES`
  and the lift-applied branch in `resolveHoistTarget` is disabled. Coexistence
  produced a double-hoist that TDZ-crashed at module load (`Cannot access
  '__cfModuleCallback_1' before initialization` — Phase 2's lift const hoisted
  above CT-1585's callback const). CT-1585 still owns `pattern`/`handler`/
  `patternTool`; both coexist correctly in one file (e.g. `patternTool` callback
  stays `__cfModuleCallback_N` while sibling lifts become `__cfLift_N`). When
  `pattern`/`handler` get whole-call hoisting they fold into `LiftHoistingTransformer`.
- **Naming collision.** Per-file counter + `factory.createIdentifier(\`__cfLift_${n}\`)`.
  `__cfLift` added to `isTransformerInjectedIdentifier` so a `__cfLift_N` reference
  inside another hoisted callback isn't miscounted as a user module-scope use.
  Call-site recognition (the synthetic `__cfLift_N(captures)` identifier the
  checker can't resolve) is carried via `ts.setOriginalNode(name, innerCall)` plus
  a `getOriginalNode` fallback in `resolveBuilderExpressionKind` — so
  ReactiveVariableFor still attaches the `.for(...)` tail.
- **`createUniqueName` trap.** Avoided — explicit counter + `createIdentifier`, per
  CT-1585 commit 3.

### Inputs to Phase 3 (sandboxable / selfcontained)

After CT-1644, every reactive lift is a module-scope `const __cfLift_N =
__cfHelpers.lift(argSchema, resSchema, cb)` with the callback inline — the exact
substrate Phase 3 wraps as `__cfHelpers.lift(__cfHelpers.selfcontained(...))`.
The sandboxability predicate is CT-1585's `analyzeCallbackForHoisting` machinery
(the `localNames` pre-pass, `isTransformerInjectedIdentifier`, the ambient-globals
exclusion), now repurposed from a _hoist gate_ to a _sandboxable gate_ applied to
each `__cfLift_N`'s inline callback body.

## Phase 3: sandboxable marker (sketch)

After Phase 2: every reactive lift-style computation is a module-scope
`const __cfLift_N = __cfHelpers.lift(...)`. Phase 3 inspects each `__cfLift_N`'s
callback body and, for the ones that meet the sandboxable conditions, wraps the
`__cfHelpers.lift(...)` call in `__cfHelpers.sandboxable(...)`:

```ts
const __cfLift_N = __cfHelpers.lift(
  __cfHelpers.sandboxable({ inputSchema }, { outputSchema }, ({ x }) => x + 1),
);
```

Note: the wrapper is _inside_ the `lift(...)` call's argument list —
`__cfHelpers.lift(__cfHelpers.sandboxable(args))` — not wrapping the lift
itself. (Berni's preference.)

### Sandboxable conditions (initial proposal, subject to confirmation with Berni)

A `__cfLift_N` is sandboxable if its callback body:

1. Closes over **zero** user-authored module-scope variables. References to
   user-authored module-level functions, constants, classes, etc. disqualify it.
   (Even though those references are statically resolvable at sandbox boot, they
   require sandbox infrastructure to load the surrounding module, which defeats
   the "transient sandbox" goal.)
2. Closes over **zero** enclosing-function-scope variables that _aren't_
   threaded through the input-object argument. Post-Phase-1, the closure
   transformer should already have ensured all captures flow through inputs —
   but verify per body.
3. Uses only:
   - Its own parameters (the destructured input-object).
   - Transformer-injected helpers (`__cfHelpers.*`, `__cfHardenFn*`) — these are
     part of the sandbox bootstrapping by definition.
   - Ambient globals (`console`, `Math`, `JSON`, `Object`, `Array`, etc. —
     declarations in `lib.*.d.ts`). Open question: are non-deterministic globals
     (`Date.now()`, `Math.random()`, `console.log()`) OK for sandboxable? Berni
     to confirm.

The detection logic should reuse the building blocks from CT-1585's hoister:

- `analyzeCallbackForHoisting`'s structural pre-pass (the `localNames` set)
  generalizes cleanly.
- `isTransformerInjectedIdentifier` already exists.
- The ambient-global check (every declaration in a `.d.ts` source file) already
  exists.

### Open questions for Phase 3

- **Naming.** `sandboxable` is the placeholder. Final name TBD with TL.
- **What does the runtime do with `sandboxable`?** This doc focuses on the
  transformer; runtime semantics are out of scope. But knowing the runtime
  contract matters for choosing which conditions to gate on.
- **The "addressable" goal.** Berni mentioned the goal of being able to point to
  the concrete source of any computation. The Phase 2 hoist gives us the
  module-scope const as a named addressable site. Is that enough, or do we also
  need stable cross-version identity (e.g., a content hash, a stable path)?
  Berni to clarify.

## Glossary of the building blocks in the existing code

For the Phase 1 implementer's quick reference. All paths relative to
`packages/ts-transformers/`.

| Concept                                        | Where it lives                                                                                                                                     | Notes                                                                                                                                 |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Pipeline stage order                           | `src/cf-pipeline.ts:33-108`                                                                                                                        | `CFC_TRANSFORMER_STAGE_SPECS` — central registry.                                                                                     |
| `ClosureTransformer`                           | `src/closures/transformer.ts`                                                                                                                      | Stage 5 (after JsxExpressionSiteRouter, ComputedTransformer). The main reactive lowering.                                             |
| `ComputedTransformer`                          | `src/computed/transformer.ts` (pre-Phase-1); `LiftLoweringTransformer` at `src/lift/transformer.ts` (post-Phase-1)                                 | Lowers `computed(...)` calls. Pre-Phase-1: emitted `derive`. Post-Phase-1: also lowers user-source `derive(...)`, emits lift-applied. |
| `createDeriveCall`                             | `src/transformers/builtins/derive.ts:186` (pre-Phase-1); `createLiftAppliedCall` at `src/transformers/builtins/lift-applied.ts` (post-Phase-1)     | The factory for synthesized lift-style helper calls. Post-Phase-1: emits the lift-applied form (`lift(cb)(input)`).                   |
| `BuilderCallbackHoistingTransformer` (CT-1585) | `src/transformers/builder-callback-hoisting.ts` + `src/closures/module-scope-callback-hoisting.ts`                                                 | The current hoister. Phase 2 will likely supersede part of this for `lift`.                                                           |
| `detectCallKind` / `callKind === "derive"`     | `src/ast/call-kind.ts`                                                                                                                             | Centralized call classifier. Phase 1 will reduce its surface.                                                                         |
| `SchemaInjectionTransformer`                   | `src/transformers/schema-injection.ts`                                                                                                             | Injects input/output schemas. Has separate code paths for `derive` and `lift` today (lines ~2905 and ~3036).                          |
| `getSyntheticModuleCallbackInitializer`        | `src/transformers/schema-injection.ts:2335`                                                                                                        | Resolves `__cfModuleCallback_N` identifier references to their source initializers. Phase 2 needs to handle `__cfLift_N` similarly.   |
| Pattern-test runtime                           | `tasks/integration.ts:191 runPatternTests`                                                                                                         | How CI runs `deno task cf test --root packages/patterns ...`. Useful for validating runtime behavior post-Phase-1.                    |
| Existing CT-1585 regression test               | `test/closures/module-scope-helper-hoisting.test.ts` + `test/fixtures/closures/hoisted-handler-preserves-capture-schemas.{input.tsx,expected.jsx}` | Reference shape for new test fixtures.                                                                                                |

## Past lessons worth carrying forward

From CT-1585's investigation, captured here so the Phase 1 implementer doesn't
have to rediscover:

- **`ts.factory.createUniqueName(prefix)` returns identifiers whose `.text` is
  the bare prefix.** Numeric suffixes are added only by the printer at emit
  time. Anywhere in the pipeline that matches identifiers by `.text` will treat
  all calls with the same prefix as the same identifier. Use an explicit
  per-file counter + `factory.createIdentifier(` ${prefix}_${n}`)` instead. See
  CT-1585 commit 3 for context.
- **`node.getText()` crashes on synthetic nodes (`pos === -1`).** Use
  `getExpressionText` from `src/ast/utils.ts` for safe printing.
- **`isDeclaredWithinFunction` (in `ast/scope-analysis.ts`) has a documented
  synthetic-node hazard** — symbol-resolved declarations from the source AST
  don't match position-based comparisons against synthesized callbacks. CT-1585
  commit 1 worked around this with a `localNames` structural pre-pass; the same
  hazard applies to any new transformer that asks "is this binding declared
  inside this synthesized scope?"
- **Trace-driven investigation pays off.** When something downstream of a
  transform produces unexpected output, instrument the relevant code paths with
  `console.error` filtering on a specific body-text substring. Always revert
  traces before committing.
- **Verify hypotheses with failing tests before fixing.** CT-1585's most
  expensive mistake was committing to a fix shape (the "early gate" hypothesis)
  before tracing actual behavior. The fix turned out to be in a completely
  different code path.

## Filing tickets

- File a Linear ticket for Phase 1 with this design doc linked. Title
  suggestion: "Phase 1: rewrite `derive` calls to `lift` in-place".
- Phase 2 and Phase 3 tickets can be filed once Phase 1 lands and any updates to
  this doc are made.
- Track the open clarifications (Berni questions) in the ticket so they don't
  get lost.

## Open questions tracker

These are explicitly open and should be resolved (or explicitly punted) before
the relevant phase lands.

- **[Phase 1]** Verify `lift` and `derive` are runtime synonyms. **Verified
  2026-05-21**: `derive(input, f)` is literally `lift(f)(input)` at runtime
  (`packages/runner/src/builder/module.ts:441-476`).
- **[Phase 1]** Verify the closure transformer already routes all derive
  captures through the input-object argument. Find any residual lexical-capture
  cases and decide their disposition. **Implicitly verified 2026-05-22**: Phase
  1 landed with all 288 ts-transformers fixture tests passing AND the three
  runtime repros from CT-1585 passing (`packages/patterns/notes/note.test.tsx`,
  `notebook.test.tsx`, `factory-outputs/parking-coordinator/main.test.tsx`). The
  lift-applied form is structurally `lift(cb)(input)`; if any callback had a
  residual lexical-capture-without-input case, the runtime's connect-time check
  (`packages/runner/src/builder/node-utils.ts:15-18`) would throw "Reactive
  reference from outer scope cannot be accessed via closure" — that error is
  absent in all test runs.
- **[Follow-up after Phase 1]** Investigate the redundant schema re-narrowing in
  `schema-injection.ts` line 3285 (the
  `kind === "builder" && builderName === "lift"` branch with
  `isToSchemaCall(firstArgument)`). When `ts.visitEachChild` re-enters our own
  injected lift-applied output, this branch fires a _second_ narrowing pass on
  synthetic schema TypeNodes we just produced. CT-1615 worked around this by
  registering synthetic wrapper TypeNodes against their semantic types in
  `applyShrinkAndWrap` (so the second pass becomes idempotent rather than
  degraded). The underlying smell: re-narrowing on freshly-injected output is
  structurally redundant. Likely cleaner shape: detect that the call came from
  our own injection (via `ts.getOriginalNode` plus an injection tag) and skip
  the re-narrowing entirely. Defer to a separate investigation post-Phase 1 —
  needs to confirm the branch isn't load-bearing for truly user-authored
  `lift(toSchema(...), toSchema(...), cb)` calls (rare but possible). **Tracked
  as
  [CT-1621](https://linear.app/common-tools/issue/CT-1621/remove-redundant-schema-re-narrowing-in-schema-injections-inner-lift)**
  after Berni's review on PR #3676 (section 7.3).
- **[Phase 3]** Final name for `sandboxable` (TL). **Berni 2026-05-21**: prefers
  `selfcontained`.
- **[Phase 3]** Are non-deterministic globals (`Date.now()`, `Math.random()`) OK
  in sandboxable bodies? (Berni.) **Berni 2026-05-21**: yes — `console.log`,
  `safeDateNow`, `unsecureRandom` all fine; they're injected.
- **[Phase 3]** Is the module-scope const enough for the "addressable" goal, or
  do we need stable cross-version identity (content hash)? (Berni.) **Berni
  2026-05-21**: `<bundlehash>/<filename>/<symbol>` (or hash of the selfcontained
  function / inline).
- **[Phase 3]** Sandboxable conditions: confirm with Berni that "zero
  user-authored module-scope variables + zero enclosing-scope captures outside
  the input object + only globals + transformer scaffolding + own params" is the
  right gate.
- **[DONE — PR #3709]** Move transformer output from `lift(...)({})` to the
  no-input form. Shipped as `lift(false, fn)()` (not a bare `lift(fn)()`: the
  runner skips a no-arg lift unless `argumentSchema === false`, so the explicit
  `false` is required — it mirrors `computed`'s runtime semantics). Added a
  2-arg `lift(argumentSchema, implementation)` overload (runtime +
  `LiftFunction` type). The rewrite is gated in schema-injection's
  `prependSchemaArguments`, AFTER ClosureTransformer, so it fires only for
  genuinely zero-capture computeds (empty outer input); captured computeds keep
  `lift(fn)({...refs})`.
- **[Follow-up post-Phase 1 — STILL OPEN]** Remove `derive` from runtime exports
  (Berni 2026-05-21: agreed in principle). NOTE: not actually dead — the
  transformer still _lowers_ user-source `derive()`, and runner tests call
  `derive()` directly. Needs a who-still-uses-derive analysis + a decision on
  whether `derive` stays a user-facing API before removal. Not a quick deletion.
- **[Follow-up]** Collapse the `lift` type-surface duplication: the overloads
  are declared in BOTH `module.ts` and the `LiftFunction` interface
  (`packages/api`), mirrored by hand (PR #3709 had to add the new overload to
  both). Consider typing the runtime builders _as_ their facade interfaces for a
  single source of truth.
- **[DONE — PR #3707, registry architecture]** Consolidated the cross-stage
  registries into a single `CrossStageState` object (audit:
  `docs/scratch/07-registry-audit.md`, design:
  `12-registry-unification-design.md`). Outcome differed from the original
  tiered plan in two evidence-driven ways: (1) the `typeRegistry` three-way
  split was investigated and **dropped** — the three uses are isolated by key
  node-kind (replacement-Expr / TypeNode / CallExpression never coincide), so
  the split fixed no reachable bug; the invariant is documented instead. (2)
  `syntheticLiftAppliedCallRegistry` was **removed** as verified-inert. The
  remaining channels (which at the time of #3707 still included
  `narrowedWrapperTypeRegistry` — see postscript) now live in `CrossStageState`,
  accessed via record/lookup/mark methods; cache-invalidation stays on the
  context. `typeRegistry` + `schemaHints` remain plain maps at the
  schema-generator package boundary.

  _Postscript (post-#3788):_ `narrowedWrapperTypeRegistry` was subsequently
  retired by CT-1621. PR #3716 added the `schemaInjectedRegistry` marker that
  catches schema-injection re-entries on nodes whose mark survived. PR #3788
  then closed the residual case (synthetic capability-wrapper re-entries whose
  mark didn't survive, e.g. authored `lift(cb)(value)` whose toSchema arg
  arrives at the `isToSchemaCall` branch as `__cfHelpers.ComparableCell<…>` with
  `pos < 0`) by detecting it structurally and short-circuiting the redundant
  re-shrink — which left the channel without a consumer and let it be deleted.
  The current CrossStageState inventory is the eight registries listed in
  `core/mod.ts`. Note: the earlier session-prep doc framed the registry as
  "derive-bound, dies with derive removal"; that was wrong — the consumer was
  schema-injection's own re-entry on user-authored `lift`, not a derive-specific
  shape.
