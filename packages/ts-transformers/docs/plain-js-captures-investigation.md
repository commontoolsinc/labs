# Plain-JS captures in derive callbacks — investigation

**Status:** fixed. The hoist-time diagnostic introduced in PR #3550 does NOT
detect any of the four known plain-JS-capture bugs because it runs at the wrong
pipeline stage. The fix lives in `createReactiveWrapperForExpression` (the wrap
path used by `expression-site-lowering.ts`): we now union the expression's
enclosing-scope free identifiers with the analyzer's reactive dataflows before
passing refs to `createDeriveCall`. All four known captures (`multiplier`,
`suffix`, `prefix`, `n`) are now explicit derive inputs and the probe reports 0
hits across 342 fixtures.

## The bug class

PR #3550's writeup framed it as: "builder callbacks (derive/handler/lift/
pattern/patternTool) should be hoistable to module scope as self-contained,
sandbox-safe units. When a synthesized `derive` callback closes over a plain JS
value declared in the enclosing function (e.g. `const suffix = "!"`), the value
flows through lexical closure rather than the derive's inputs argument. Works
in-process today via JS closure semantics but breaks the self-contained-callback
contract — the captured value isn't visible to schema/serialization/sandbox
machinery."

## Probe-identified population (unchanged from PR #3550)

`test/diagnostics/probe-derive-callback-captures.ts` enumerates the population.
As of `origin/main` (verified 2026-05-13): **4 hits across 3 fixtures.**

| Fixture                                            | Captured plain-JS names |
| -------------------------------------------------- | ----------------------- |
| `closures/map-multiple-captures.input.tsx`         | `multiplier`            |
| `closures/filter-flatmap-plain-captures.input.tsx` | `suffix`, `prefix`      |
| `closures/map-plain-array-no-transform.input.tsx`  | `n`                     |

## Q2: does the existing hoist diagnostic detect these?

The diagnostic at
`packages/ts-transformers/src/closures/module-scope-callback-hoisting.ts:64` is
gated behind `options.debug` and fires when a hoistable builder callback
captures an enclosing-scope name. PR #3550's writeup flagged it as noisy (~160
firings, mostly false positives from synthesized destructured bindings) and
noted that the diagnostic should be promoted from debug to default-warning once
the noise is addressed.

**Empirical finding (probe at
`test/diagnostics/probe-plain-js-captures-diagnostic.ts`):**

| Fixture                                            | Expected captures  | Diagnostic firings | Names detected        |
| -------------------------------------------------- | ------------------ | ------------------ | --------------------- |
| `closures/map-multiple-captures.input.tsx`         | `multiplier`       | 0                  | none                  |
| `closures/filter-flatmap-plain-captures.input.tsx` | `suffix`, `prefix` | 1                  | `[item]` (false pos.) |
| `closures/map-plain-array-no-transform.input.tsx`  | `n`                | 0                  | none                  |

**0 of 4 expected captures detected.** The one diagnostic firing is on a
destructured loop variable (the false-positive class PR #3550 warned about), not
on a real plain-JS capture.

## Why the diagnostic misses

`hoistModuleScopedBuilderCallbacks` runs inside `ClosureTransformer` at
`packages/ts-transformers/src/closures/transformer.ts:54`. Pipeline order (from
`packages/ts-transformers/src/cf-pipeline.ts:32`):

1. CastValidationTransformer
2. EmptyArrayOfValidationTransformer
3. OpaqueGetValidationTransformer
4. PatternContextValidationTransformer
5. JsxExpressionSiteRouterTransformer
6. ComputedTransformer
7. **ClosureTransformer** ← hoist runs here, on the output of stage 6
8. **PatternOwnedExpressionSiteLoweringTransformer** ← inner
   `__cfHelpers.derive(...)` calls get synthesized HERE
9. HelperOwnedExpressionSiteLoweringTransformer
10. (… more …)

The inner derive calls that contain the plain-JS captures **don't exist yet**
when the hoist pass runs. At hoist time, only the outermost
`pattern((state) => …)` callback is present as a builder call expression. The
probe confirms this — the hoist visitor fires exactly once per fixture, always
on the outer pattern callback, never on the inner derives.

The bug lives in code that is generated _after_ the hoist analysis runs. Adding
more conditions to `analyzeCallbackForHoisting` cannot detect it.

## Implications for the fix

PR #3550's sketched fix direction was correct in layer (the wrap path) but wrong
in framing. The framing was "the hoist diagnostic catches this, just needs the
false positives cleaned up and to be promoted to warning." Reality is "the hoist
diagnostic never sees this, and a different pass would have to catch it."

### Fix (landed): synthesis-time wrap-path change

`createReactiveWrapperForExpression` in
`packages/ts-transformers/src/transformers/expression-rewrite/rewrite-helpers.ts`
now unions the analyzer's reactive dataflows with any free identifiers in the
expression whose declarations live in an enclosing (non-module,
non-expression-local) function scope. The unioned set becomes the explicit refs
passed to `createDeriveCall`, which uses its existing
`captureTree`/`fallbackEntries` machinery to fold them into the derive's inputs
and schema.

The walker (`unionWithEnclosingScopeFreeIdentifiers`):

- Skips identifiers already covered by reactive dataflows (name-based dedup;
  symbol-based dedup is unreliable because dataflow refs are sometimes
  synthesized expressions whose root identifier doesn't carry a resolvable
  symbol on the post-transform AST).
- Skips identifiers whose declarations are at module scope (imports, top-level
  consts) — those are stable across hoist boundaries.
- Skips type parameters.
- Skips identifiers declared inside nested functions within the expression
  itself (e.g. a `.filter((x) => ...)` parameter nested in the expression body)
  — those are local, not enclosing.
- Does not descend into nested function-like nodes within the expression when
  walking — same rationale.
- Skips property names in property accesses, property keys in object literals,
  propertyName in binding patterns, and JSX tag names — these are not free
  references to bindings.

This was a one-function change with no broader pipeline restructuring. The probe
(`probe-derive-callback-captures.ts`) now reports 0 hits across 342 fixtures,
down from 4 hits across 3 fixtures.

### Defense-in-depth (future work)

A post-synthesis pass that walks every synthesized `__cfHelpers.derive(...)` and
checks the self-contained-callback invariant — equivalent to running the
existing probe inside the pipeline as a default-warning. Not required for
correctness now that the synthesis-time fix is in, but useful as a regression
detector. Tracked separately.

## Pipeline cleanup observation

The hoist-time diagnostic at `module-scope-callback-hoisting.ts:64-80` is
either:

- Useful for catching outer-callback bugs (the false positive `item` firing is
  structurally similar to a real bug class — destructured loop variables being
  non-hoistable for legitimate reasons). If so, its docstring should be updated
  to reflect that it doesn't cover the plain-JS-captures bug class.
- Or unused in practice because its true-positive rate against the real bug
  class is zero. If so, removing it is fine.

This is a downstream cleanup question; doesn't block the actual fix.
