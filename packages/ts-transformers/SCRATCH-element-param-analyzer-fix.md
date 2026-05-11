# Scratch: array-method element-param analyzer fix

> Transient working doc. Not for main. Capturing the plan as of the start of
> Phase 2 so future-us has the full thread.

## What we're fixing

In a reactive `arr.map((elem) => …)` callback, the dataflow analyzer
(`packages/ts-transformers/src/ast/dataflow.ts`) does not recognize `elem.foo`
as a reactive dependency. This causes JSX-non-text reads of element fields
(comparisons, ternary predicates, helper-call arguments) to either skip reactive
wrapping or wrap with too-coarse dependencies (whole element instead of
`element.key("foo")`).

PRs #3539 and #3541 patch this locally inside
`expression-site-lowering.ts:rewriteArrayMethodCallbackExpressionSites`:

- #3539 added `appendElementParamMemberDataFlows` (manually inject element
  member reads into the dataflow set) and `isElementParamMemberComputation`
  (force a derive wrap when element members are referenced).
- #3541 added an exclusion list (`pattern` builders, opaque-returning factories,
  pattern-factory callees) so the force-wrap doesn't break structural calls like
  `EntryRow({ piece: entry.piece, ... })`.

Both are workarounds. The principled fix is one layer up: teach the analyzer
that the synthesized `element` parameter is implicitly opaque.

## Why analyzer-level (not closure-transform, not schema-factory)

- The bug's root premise — "the analyzer can decide reactivity from the TS type
  alone" — fails for synthesized callback params whose type is deliberately the
  plain user type (`Message`, not `OpaqueRef<Message>`), because schema-factory
  and type-shrinking rely on the plain type.
- Fixing in the schema-factory means lying to the analyzer with a synthetic
  opaque-wrapped type, which then conflicts with the real consumers of the type.
  Pushes complexity outward.
- Fixing in the closure transform means synthesizing per-field derive aliases
  for every `elem.foo` read — which is what `appendElementParamMemberDataFlows`
  is, just promoted to a real pre-pass. Bypasses the analyzer rather than fixing
  it.
- Fixing in the analyzer adds one piece of input ("this identifier is the first
  parameter of an array-method callback") and removes three pieces of folklore
  from `expression-site-lowering.ts`. Net simplification.

## Pipeline order (already correct — common misconception)

`cf-pipeline.ts:32-103` runs lowering passes in this order:

```
5. JsxExpressionSiteRouter
6. ComputedTransformer
7. ClosureTransformer (← creates pattern() shell + immediately calls
                        rewriteArrayMethodCallbackExpressionSites)
8. PatternOwnedExpressionSiteLowering
9. HelperOwnedExpressionSiteLowering
10. WriteAuthorizedByValidation
11. PatternCallbackLowering (← __cf_pattern_input.key(...) destructuring,
                              ONLY for destructured first params)
```

Berni's follow-up prompt described "lower expression sites _before_ turning
params into key() accesses" as the goal. That's _already_ what happens —
expression-site lowering runs at stage 7 inside Closure, while `key()` lowering
at stage 11 only fires for destructured params. The bug isn't ordering. It's the
analyzer's blind spot.

## Two surface forms, two treatments (the asymmetry)

| Source form            | Stage 7 (Closure)                                                                              | Stage 11 (PatternCallback)                                                                                          |
| ---------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `({piece, name}) => …` | `analyzeElementBinding` synthesizes derive aliases for each destructured field; body uses them | Sees destructured `({element, params})`, generates `key()` prologue (irrelevant — derives already cover the fields) |
| `(elem) => …elem.foo…` | `analyzeElementBinding` keeps `elem` as identifier; body untouched                             | Sees identifier param; does nothing. `elem.foo` survives unchanged.                                                 |

Identifier-form is ~118 of the ~129 fixture maps (10:1 majority). It's the
"missing" case.

## Probe results (Phase 1)

`test/probe-element-param-analyzer.ts` — walks all fixtures, asks the analyzer
about every element-param access. Numbers from baseline (pre-fix) run:

```
total element-param accesses probed:                    319
analyzer reported nothing (no opaque, no rewrite):       72  (22%)
  ...non-JSX positions:                                  54
  ...in fixtures whose .expected.* uses mapWithPattern:  55
  ...non-JSX, non-method-receiver, in reactive map:      30  ← real candidates
```

Of the 30 candidates:

- **Class A — true bugs (16):** property accesses on object-typed elements
  (`entry.name`, `message.author`, `p.rank`, `i.active`, `item.type`, `s.name`,
  `u.age`, `p.preference`, `p.ingredient`, `item.contentType`). PR #3539 covers
  exactly 1 of these (the `message.author` case). The other 15 are latent.
- **Class B — correct silence (14):** bare-identifier reads of primitive
  elements (`x: number`, `n: number`, `edge: string`, `label: string`).
  Pattern-callback identity tracking already provides the right granularity.

The fix must promote Class A reads to opaque while leaving Class B silent (or
silent-equivalent — the wrap path shouldn't fire on bare primitive identifier
reads even if the analyzer reports them as opaque).

## The fix shape (Phase 2)

Two changes:

1. **`closures/strategies/array-method-transform.ts`**: when synthesizing the
   pattern callback's first parameter, register the `element` identifier (not
   the param node — the actual identifier the body references) into a new
   context registry, e.g. `markAsArrayMethodElementBinding(symbol)`.

   Hook point: `array-method-transform.ts:312-348`
   (`transformArrayMethodCallback`) → after `analyzeElementBinding` returns, we
   have `elementAnalysis.elementIdentifier`. Either:
   - mark the _symbol_ of that identifier (preferred — survives renames), or
   - mark the _parameter node_ and have the analyzer walk parent chain to find a
     parameter whose declaring function is registered.

   Going with symbol if checker can resolve it at registration time; fall back
   to param-node identity otherwise.

2. **`ast/dataflow.ts`**: in the `Identifier` branch (lines ~688-777), check the
   registry. If the identifier resolves to a marked symbol/param, treat it as
   opaque the same way line 711 treats synthetic local parameters:
   ```
   recordDataFlow(expression, scope, null, true);
   return { containsOpaqueRef: true, requiresRewrite: false, dataFlows: [expression] };
   ```

   Plumbing: `createDataFlowAnalyzer(checker)` needs to accept the registry.
   Wire through `context.getDataFlowAnalyzer()` in `core/context.ts:222`.

3. **Cleanup (after fix verified):** remove from
   `expression-site-lowering.ts:rewriteArrayMethodCallbackExpressionSites`:
   - `collectElementParamMemberAccesses`
   - `appendElementParamMemberDataFlows`
   - `isElementParamMemberComputation`
   - the `isElementParamMemberComputation(expression)` branch in
     `wrapArrayMethodCallbackLocalExpression`
   - the `appendElementParamMemberDataFlows` calls in
     `rewriteArrayMethodOwnedReceiverMethodExpressionSite`

4. **Cleanup of PR #3541's carveout (after fix verified):** in
   `expression-site-lowering.ts:710-722`, the early-out for pattern
   factory/builder/opaque-returning calls becomes unreachable code (the
   surrounding `isElementParamMemberComputation` branch is gone). Remove.

5. **Stretch cleanup:** `structural-reactive-factory.ts` is only used by PR
   #3541's carveout. After cleanup, check whether anything else imports
   `isPatternFactoryCalleeExpression` / `returnsOpaqueRefResult`. If not, the
   file can go.

## Risks and watch list

- **Class B over-fire (14 cases):** if the analyzer fix causes any
  primitive-element bare-id case to suddenly produce a derive wrap, that's
  over-firing. Re-run the probe; if it now reports `requires_rewrite=y` for any
  of the 14 listed cases, investigate whether the wrap path needs an extra "skip
  if expression is just a bare element identifier" gate.
- **Schema-shrinking:** comes from a _separate_ analyzer
  (`analyzeFunctionCapabilities` in `policy/`), called from
  `pattern-callback-transform.ts:86`. Runs against the rewritten body where
  reads have already become `__cf_pattern_input.key(...)` calls. The analyzer
  fix shouldn't touch this path. If shrink fixtures change, that's a surprise —
  investigate before accepting.
- **Ternary/derive absorption:** lots of places in `expression-site-lowering.ts`
  and `expression-rewrite/` decide whether to fold a ternary into a surrounding
  derive based on `analysis.containsOpaqueRef`. Flipping more expressions to
  opaque could change absorption decisions for Class A cases. This is desired
  behavior (fold in the same way they fold for any opaque expression today) but
  may cause golden churn that needs per-fixture interpretation.
- **ifElse predicate hints:** `dataflow.ts:47-50` defines `RewriteHint`. Make
  sure the analyzer's hint emission for ifElse predicates is unchanged for the
  now-opaque element-param cases — same as if the user had written
  `myCell.foo === "x"` for a top-level opaque `myCell`.

## Validation plan

1. Apply the fix to `array-method-transform.ts` and `dataflow.ts`.
2. Re-run probe: confirm Class A → 0 silent (16 → 0); confirm Class B → still 14
   silent.
3. `deno task check` — type-check.
4. `deno task test` — full fixture suite. Expected red goldens:
   - The 9 Class A fixtures listed in the Phase 1 report.
   - PR #3539's existing fixture
     (`map-callback-element-property-helper-comparison.expected.jsx`) should
     stay green or change shape to be cleaner (no
     `appendElementParamMemberDataFlows` artifacts).
5. For each red golden: read the diff. Confirm change is "scalar/predicate
   expression now wrapped in derive with `element.key("foo")` schema entry" or
   equivalent improvement. Reject any diff that loses information, widens
   schemas, or introduces `derive`-wrapping of pattern factory calls (the PR
   #3541 regression).
6. Apply cleanup #3 and #4. Re-run check + test. Goldens should be stable
   relative to step 5 (no new diffs from removal of dead code paths).
7. Apply stretch cleanup #5 if appropriate.
8. Re-run probe one final time. Confirm summary matches expectation.
9. Discard probe + this scratch doc; write the actual PR description.

## Where we are right now

- Phase 0 done (terrain map produced).
- Phase 1 done (probe written, baseline numbers captured, 30 candidates
  classified into 16 + 14).
- Phase 2 starting now. Order of operations:
  - Plumb analyzer/context (steps from "The fix shape" #1, #2).
  - Re-run probe to confirm Class A → 0 silent (no other code changes yet).
  - Run `deno task check` — should pass.
  - Run `deno task test` — collect golden diffs, audit each one.
  - Apply cleanup #3, #4 (and probably #5).
  - Final test + probe sweep.

## Useful pointers

- Pipeline order: `src/cf-pipeline.ts:32-103`
- Closure array-method strategy entry:
  `src/closures/strategies/array-method-strategy.ts:29-50`
- Element binding analysis (where to register):
  `src/closures/strategies/array-method-utils.ts:173-252`
- Pattern callback synth (the `element` param's typed shape):
  `src/closures/utils/schema-factory.ts:23-118`
- Dataflow analyzer identifier branch (where to consult registry):
  `src/ast/dataflow.ts:688-777`
- Context registry pattern to mirror: `src/core/context.ts:128-153`
  (`markAsArrayMethodCallback` / `isArrayMethodCallback`)
- The current workaround code:
  `src/transformers/expression-site-lowering.ts:616-803`
- Probe: `test/probe-element-param-analyzer.ts`
- Probe baseline numbers and Class A/B tables: see "Probe results" above.
