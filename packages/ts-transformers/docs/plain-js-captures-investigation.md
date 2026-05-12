# Plain-JS captures in derive callbacks — investigation

**Status:** investigation complete; fix in progress. The hoist-time diagnostic
introduced in PR #3550 does NOT detect any of the four known plain-JS-capture
bugs because it runs at the wrong pipeline stage — before the expression-site
lowering transformers synthesize the inner `__cfHelpers.derive(...)` calls that
are the actual locus of the bug.

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

Two possible directions:

### Direction A — Fix at synthesis time (recommended)

The expression-site lowering transformers
(`PatternOwnedExpressionSiteLoweringTransformer`,
`HelperOwnedExpressionSiteLoweringTransformer`) call something like
`createReactiveWrapperForExpression` (or a sibling) when they synthesize an
inner `__cfHelpers.derive(...)` call. That helper is responsible for choosing
which identifiers to wire into the derive's `inputs` argument. Today it only
wires the _reactive_ free variables (identified by the dataflow analyzer); it
silently leaves plain-JS free variables to flow through lexical closure.

Fix: at this synthesis site, union the plain-JS free variables of the expression
with the reactive dataflows so they become explicit refs in the synthesized
`createDeriveCall(...)`. Same wrap-path fix PR #3550 sketched.

### Direction B — Add a post-synthesis hoist-style check

Run a second pass after lowering that walks every synthesized
`__cfHelpers.derive(...)` and checks the same `canHoist` invariant on its
callback. This is what `test/diagnostics/probe-derive-callback-captures.ts` does
today (offline, on the printed output). It could be promoted into the pipeline
as a default-warning transformer.

A is the actual fix; B is the defense-in-depth detector. They aren't mutually
exclusive; B is useful regardless of A's implementation.

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
