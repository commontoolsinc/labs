# Legacy vs Capability Fixture Audit

Generated from direct transform diffing of fixture inputs with:
- `useLegacyOpaqueRefSemantics: true`
- `useLegacyOpaqueRefSemantics: false`

- Total fixtures compared: 221
- Changed outputs: 121
- Unchanged outputs: 100

## Directory Breakdown
- ast-transform: 14/29 changed
- closures: 74/120 changed
- handler-schema: 0/8 changed
- jsx-expressions: 28/39 changed
- schema-injection: 0/17 changed
- schema-transform: 5/8 changed

## Summary By Concern
- Map rewrite deltas: 4 fixtures
  - Net delta: mapWithPattern +4, raw map -4
- Logical lowering deltas: 5 fixtures
  - Net delta: when +0, unless +6, ifElse +0
- Type/schema deltas: 27 fixtures
  - Net delta: asCell -2, asOpaque -28, type:"object" +3, required arrays +2
- Key-only canonicalization deltas: 90 fixtures

## Follow-up Tasks
- Standalone function policy: allow `.map()` rewrite on reactive/cell-like receivers in module-scope standalone functions (while still disallowing `computed`/`derive`/`action`/etc.), or explicitly keep rejecting it with a dedicated conservative diagnostic. Add fixture coverage for both allowed and rejected paths.

## Map Rewrite Deltas
- packages/ts-transformers/test/fixtures/closures/map-capture-cell-param-no-name.input.tsx (mapWithPattern +1, map -1)
- packages/ts-transformers/test/fixtures/closures/map-handler-reference-no-name.input.tsx (mapWithPattern +1, map -1)
- packages/ts-transformers/test/fixtures/closures/map-jsx-map-filter-chain.input.tsx (mapWithPattern +1, map -1)
- packages/ts-transformers/test/fixtures/closures/map-single-capture-no-name.input.tsx (mapWithPattern +1, map -1)

## Logical Lowering Deltas
- packages/ts-transformers/test/fixtures/jsx-expressions/logical-mixed-and-or.input.tsx (when +0, unless +2, ifElse +0)
- packages/ts-transformers/test/fixtures/jsx-expressions/logical-nullish-coalescing.input.tsx (when +1, unless +2, ifElse +0)
- packages/ts-transformers/test/fixtures/jsx-expressions/logical-triple-or-chain.input.tsx (when +0, unless +2, ifElse +0)
- packages/ts-transformers/test/fixtures/jsx-expressions/opaque-ref-cell-map.input.tsx (when +0, unless +1, ifElse +0)
- packages/ts-transformers/test/fixtures/jsx-expressions/safe-context-and-jsx.input.tsx (when -1, unless -1, ifElse +0)

## Type/Schema Deltas
- packages/ts-transformers/test/fixtures/ast-transform/counter-pattern-no-name.input.tsx (asCell +0, asOpaque -1, type:"object" +0, required +0)
- packages/ts-transformers/test/fixtures/ast-transform/counter-pattern.input.tsx (asCell +0, asOpaque -1, type:"object" +0, required +0)
- packages/ts-transformers/test/fixtures/ast-transform/derive-object-literal-input.input.tsx (asCell +0, asOpaque -4, type:"object" +0, required +0)
- packages/ts-transformers/test/fixtures/closures/cell-map-with-captures.input.tsx (asCell +0, asOpaque -1, type:"object" +0, required +0)
- packages/ts-transformers/test/fixtures/closures/derive-filter-map-chain.input.tsx (asCell +0, asOpaque -2, type:"object" -1, required -1)
- packages/ts-transformers/test/fixtures/closures/handler-event-param.input.tsx (asCell +0, asOpaque +0, type:"object" -1, required -1)
- packages/ts-transformers/test/fixtures/closures/inline-action-in-ternary-branch.input.tsx (asCell -1, asOpaque +0, type:"object" +0, required +0)
- packages/ts-transformers/test/fixtures/closures/map-capture-cell-param-no-name.input.tsx (asCell +0, asOpaque +1, type:"object" +3, required +2)
- packages/ts-transformers/test/fixtures/closures/map-capture-cell-param.input.tsx (asCell +0, asOpaque +1, type:"object" +2, required +3)
- packages/ts-transformers/test/fixtures/closures/map-computed-fallback-alias.input.tsx (asCell +0, asOpaque +0, type:"object" +1, required +0)
- packages/ts-transformers/test/fixtures/closures/map-conditional-expression.input.tsx (asCell +0, asOpaque -1, type:"object" +0, required +0)
- packages/ts-transformers/test/fixtures/closures/map-handler-reference-no-name.input.tsx (asCell +1, asOpaque +1, type:"object" +6, required +5)
- packages/ts-transformers/test/fixtures/closures/map-inside-ifelse-with-handler.input.tsx (asCell +0, asOpaque +1, type:"object" +1, required +1)
- packages/ts-transformers/test/fixtures/closures/map-jsx-map-filter-chain.input.tsx (asCell +0, asOpaque +2, type:"object" +3, required +3)
- packages/ts-transformers/test/fixtures/closures/map-single-capture-no-name.input.tsx (asCell +0, asOpaque +1, type:"object" +6, required +5)
- packages/ts-transformers/test/fixtures/closures/map-ternary-inside-nested-map.input.tsx (asCell +0, asOpaque -3, type:"object" +0, required +0)
- packages/ts-transformers/test/fixtures/closures/pattern-nested-jsx-map.input.tsx (asCell +0, asOpaque +0, type:"object" +1, required +0)
- packages/ts-transformers/test/fixtures/jsx-expressions/derived-property-access-with-derived-key.input.tsx (asCell -2, asOpaque -3, type:"object" -3, required -3)
- packages/ts-transformers/test/fixtures/jsx-expressions/jsx-conditional-rendering-no-name.input.tsx (asCell +0, asOpaque -4, type:"object" +0, required +0)
- packages/ts-transformers/test/fixtures/jsx-expressions/jsx-conditional-rendering.input.tsx (asCell +0, asOpaque -4, type:"object" +0, required +0)
- packages/ts-transformers/test/fixtures/jsx-expressions/jsx-property-access.input.tsx (asCell +0, asOpaque -3, type:"object" +0, required +0)
- packages/ts-transformers/test/fixtures/jsx-expressions/map-nested-conditional-no-name.input.tsx (asCell +0, asOpaque -1, type:"object" +0, required +0)
- packages/ts-transformers/test/fixtures/jsx-expressions/map-nested-conditional.input.tsx (asCell +0, asOpaque -1, type:"object" +0, required +0)
- packages/ts-transformers/test/fixtures/jsx-expressions/method-chains.input.tsx (asCell +0, asOpaque -1, type:"object" +0, required +0)
- packages/ts-transformers/test/fixtures/jsx-expressions/no-double-derive.input.tsx (asCell +0, asOpaque +0, type:"object" +0, required -1)
- packages/ts-transformers/test/fixtures/jsx-expressions/parent-suppression-edge.input.tsx (asCell +0, asOpaque -5, type:"object" -11, required -11)
- packages/ts-transformers/test/fixtures/jsx-expressions/safe-context-and-jsx.input.tsx (asCell +0, asOpaque +0, type:"object" -4, required +0)

## Key-Only Canonicalization Deltas
These changed output text but did not move map rewrite, logical lowering, or type/schema counters.
- packages/ts-transformers/test/fixtures/ast-transform/builder-conditional.input.tsx (keyCalls +1)
- packages/ts-transformers/test/fixtures/ast-transform/event-handler-no-derive.input.tsx (keyCalls +1)
- packages/ts-transformers/test/fixtures/ast-transform/handler-object-literal.input.tsx (keyCalls +4)
- packages/ts-transformers/test/fixtures/ast-transform/pattern-array-map.input.tsx (keyCalls +4)
- packages/ts-transformers/test/fixtures/ast-transform/pattern-two-schemas.input.tsx (keyCalls +1)
- packages/ts-transformers/test/fixtures/ast-transform/pattern-with-name-and-type.input.tsx (keyCalls +1)
- packages/ts-transformers/test/fixtures/ast-transform/pattern-with-type.input.tsx (keyCalls +1)
- packages/ts-transformers/test/fixtures/ast-transform/schema-generation-builders.input.tsx (keyCalls +3)
- packages/ts-transformers/test/fixtures/ast-transform/schema-injection-unless.input.tsx (keyCalls +2)
- packages/ts-transformers/test/fixtures/ast-transform/schema-injection-when.input.tsx (keyCalls +2)
- packages/ts-transformers/test/fixtures/ast-transform/ternary_derive.input.tsx (keyCalls +2)
- packages/ts-transformers/test/fixtures/closures/action-basic.input.tsx (keyCalls +1)
- packages/ts-transformers/test/fixtures/closures/action-generic-event.input.tsx (keyCalls +1)
- packages/ts-transformers/test/fixtures/closures/action-in-ternary-branch.input.tsx (keyCalls +4)
- packages/ts-transformers/test/fixtures/closures/action-in-ternary-with-explicit-computed.input.tsx (keyCalls +3)
- packages/ts-transformers/test/fixtures/closures/action-partial.input.tsx (keyCalls +2)
- packages/ts-transformers/test/fixtures/closures/action-required-partial.input.tsx (keyCalls +2)
- packages/ts-transformers/test/fixtures/closures/action-with-event.input.tsx (keyCalls +1)
- packages/ts-transformers/test/fixtures/closures/computed-array-length.input.tsx (keyCalls +2)
- packages/ts-transformers/test/fixtures/closures/computed-destructured-map.input.tsx (keyCalls +1)
- packages/ts-transformers/test/fixtures/closures/computed-jsx-local-function.input.tsx (keyCalls +1)
- packages/ts-transformers/test/fixtures/closures/computed-local-var-map.input.tsx (keyCalls +1)
- packages/ts-transformers/test/fixtures/closures/computed-pattern-param-mixed.input.tsx (keyCalls +2)
- packages/ts-transformers/test/fixtures/closures/computed-pattern-param.input.tsx (keyCalls +1)
- packages/ts-transformers/test/fixtures/closures/computed-pattern-typed.input.tsx (keyCalls +1)
- packages/ts-transformers/test/fixtures/closures/computed-property-access-map.input.tsx (keyCalls +1)
- packages/ts-transformers/test/fixtures/closures/computed-with-closed-over-cell-map.input.tsx (keyCalls +2)
- packages/ts-transformers/test/fixtures/closures/derive-inside-map-with-method-chain.input.tsx (keyCalls +3)
- packages/ts-transformers/test/fixtures/closures/derive-map-input-no-captures.input.tsx (keyCalls +3)
- packages/ts-transformers/test/fixtures/closures/derive-map-union-return.input.tsx (keyCalls +1)
- packages/ts-transformers/test/fixtures/closures/derive-nested-callback.input.tsx (keyCalls +2)
- packages/ts-transformers/test/fixtures/closures/filter-map-chain.input.tsx (keyCalls +6)
- packages/ts-transformers/test/fixtures/closures/handler-basic.input.tsx (keyCalls +1)
- packages/ts-transformers/test/fixtures/closures/handler-computed-key.input.tsx (keyCalls +1)
- packages/ts-transformers/test/fixtures/closures/handler-destructured-params.input.tsx (keyCalls +3)
- packages/ts-transformers/test/fixtures/closures/handler-nested-map.input.tsx (keyCalls +2)
- packages/ts-transformers/test/fixtures/closures/handler-reserved-capture.input.tsx (keyCalls +1)
- packages/ts-transformers/test/fixtures/closures/handler-unused-event.input.tsx (keyCalls +1)
- packages/ts-transformers/test/fixtures/closures/map-and-handler.input.tsx (keyCalls +14)
- packages/ts-transformers/test/fixtures/closures/map-array-destructure-shorthand.input.tsx (keyCalls +1)
- packages/ts-transformers/test/fixtures/closures/map-array-destructured.input.tsx (keyCalls +1)
- packages/ts-transformers/test/fixtures/closures/map-computed-alias-side-effect.input.tsx (keyCalls +1)
- packages/ts-transformers/test/fixtures/closures/map-computed-alias-with-plain-binding.input.tsx (keyCalls +1)
- packages/ts-transformers/test/fixtures/closures/map-destructured-alias.input.tsx (keyCalls +4)
- packages/ts-transformers/test/fixtures/closures/map-destructured-computed-alias.input.tsx (keyCalls +1)
- packages/ts-transformers/test/fixtures/closures/map-destructured-numeric-alias.input.tsx (keyCalls +1)
- packages/ts-transformers/test/fixtures/closures/map-destructured-param.input.tsx (keyCalls +6)
- packages/ts-transformers/test/fixtures/closures/map-destructured-string-alias.input.tsx (keyCalls +1)
- packages/ts-transformers/test/fixtures/closures/map-element-access-opaque.input.tsx (keyCalls +4)
- packages/ts-transformers/test/fixtures/closures/map-element-computed.input.tsx (keyCalls +3)
- packages/ts-transformers/test/fixtures/closures/map-handler-reference-with-type-arg-no-name.input.tsx (keyCalls +5)
- packages/ts-transformers/test/fixtures/closures/map-handler-reference.input.tsx (keyCalls +5)
- packages/ts-transformers/test/fixtures/closures/map-import-reference.input.tsx (keyCalls +2)
- packages/ts-transformers/test/fixtures/closures/map-index-param-used.input.tsx (keyCalls +6)
- packages/ts-transformers/test/fixtures/closures/map-index-shorthand.input.tsx (keyCalls +6)
- packages/ts-transformers/test/fixtures/closures/map-jsx-compute-wrapper-local-function.input.tsx (keyCalls +1)
- packages/ts-transformers/test/fixtures/closures/map-jsx-compute-wrapper-no-rewrite.input.tsx (keyCalls +1)
- packages/ts-transformers/test/fixtures/closures/map-multiple-captures.input.tsx (keyCalls +9)
- packages/ts-transformers/test/fixtures/closures/map-multiple-similar-captures.input.tsx (keyCalls +7)
- packages/ts-transformers/test/fixtures/closures/map-nested-callback.input.tsx (keyCalls +10)
- packages/ts-transformers/test/fixtures/closures/map-nested-property.input.tsx (keyCalls +7)
- packages/ts-transformers/test/fixtures/closures/map-no-captures.input.tsx (keyCalls +3)
- packages/ts-transformers/test/fixtures/closures/map-outer-element.input.tsx (keyCalls +4)
- packages/ts-transformers/test/fixtures/closures/map-single-capture-with-type-arg-no-name.input.tsx (keyCalls +5)
- packages/ts-transformers/test/fixtures/closures/map-single-capture.input.tsx (keyCalls +5)
- packages/ts-transformers/test/fixtures/closures/map-template-literal.input.tsx (keyCalls +7)
- packages/ts-transformers/test/fixtures/closures/map-type-assertion.input.tsx (keyCalls +6)
- packages/ts-transformers/test/fixtures/closures/map-with-array-param-no-name.input.tsx (keyCalls +4)
- packages/ts-transformers/test/fixtures/closures/map-with-array-param.input.tsx (keyCalls +4)
- packages/ts-transformers/test/fixtures/closures/unless-with-map.input.tsx (keyCalls +4)
- packages/ts-transformers/test/fixtures/closures/when-with-map.input.tsx (keyCalls +4)
- packages/ts-transformers/test/fixtures/jsx-expressions/cell-get-in-ifelse-predicate.input.tsx (keyCalls +3)
- packages/ts-transformers/test/fixtures/jsx-expressions/complex-expressions.input.tsx (keyCalls +3)
- packages/ts-transformers/test/fixtures/jsx-expressions/element-access-complex.input.tsx (keyCalls +40)
- packages/ts-transformers/test/fixtures/jsx-expressions/element-access-simple.input.tsx (keyCalls +6)
- packages/ts-transformers/test/fixtures/jsx-expressions/jsx-arithmetic-operations.input.tsx (keyCalls +18)
- packages/ts-transformers/test/fixtures/jsx-expressions/jsx-complex-mixed.input.tsx (keyCalls +25)
- packages/ts-transformers/test/fixtures/jsx-expressions/jsx-function-calls.input.tsx (keyCalls +27)
- packages/ts-transformers/test/fixtures/jsx-expressions/jsx-string-operations.input.tsx (keyCalls +21)
- packages/ts-transformers/test/fixtures/jsx-expressions/map-array-length-conditional.input.tsx (keyCalls +1)
- packages/ts-transformers/test/fixtures/jsx-expressions/map-single-capture-no-name.input.tsx (keyCalls +3)
- packages/ts-transformers/test/fixtures/jsx-expressions/map-single-capture.input.tsx (keyCalls +3)
- packages/ts-transformers/test/fixtures/jsx-expressions/optional-chain-captures.input.tsx (keyCalls +3)
- packages/ts-transformers/test/fixtures/jsx-expressions/pattern-statements-vs-jsx.input.tsx (keyCalls +13)
- packages/ts-transformers/test/fixtures/jsx-expressions/pattern-with-cells.input.tsx (keyCalls +4)
- packages/ts-transformers/test/fixtures/schema-transform/nested-default-optional.input.tsx (keyCalls +1)
- packages/ts-transformers/test/fixtures/schema-transform/opaque-ref-map.input.tsx (keyCalls +7)
- packages/ts-transformers/test/fixtures/schema-transform/pattern-any-result-override.input.tsx (keyCalls +2)
- packages/ts-transformers/test/fixtures/schema-transform/pattern-with-types.input.tsx (keyCalls +6)
- packages/ts-transformers/test/fixtures/schema-transform/with-opaque-ref.input.tsx (keyCalls +3)
