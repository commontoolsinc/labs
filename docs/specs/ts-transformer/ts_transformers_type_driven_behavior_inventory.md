# TS Transformers Type-Driven Behavior Inventory

This note is intentionally narrow.

It lists the places where checker/type information affects transformer behavior:
- lowering choices
- validation/diagnostics
- callback/context classification
- capture behavior

It does not list pure schema-generation/type-emission code unless that code exists specifically to preserve later behavioral decisions.

## Main Behavioral Type Dependencies

- `src/ast/call-kind.ts`
  - `isReactiveValueExpression(...)`
  - `hasReactiveCollectionProvenance(...)`
  - `classifyArrayMethodCallSite(...)`
  - `classifyArrayCallbackContainerCall(...)`
  - `resolveExpressionKind(...)`
  - `resolveBuilderExpressionKind(...)`
  These checker-backed paths decide whether values are reactive, whether collection methods are reactive/plain, whether callbacks are plain-array-value vs plain-array-void, and how builder/runtime calls are recognized through aliases/signatures.

- `src/policy/rewrite-policy.ts`
  - `classifyReactiveReceiverKind(...)`
  - `shouldRewriteCollectionMethod(...)`
  Uses `isOpaqueRefType(...)` and `getCellKind(...)` to distinguish:
  - plain receivers
  - opaque values that auto-unwrap in compute contexts
  - cell/stream receivers that still require rewrite

- `src/ast/dataflow.ts`
  The dataflow analyzer uses `checker.getTypeAtLocation(...)`, `isOpaqueRefType(...)`, `isReactiveValueExpression(...)`, and `symbolDeclaresCommonFabricDefault(...)` to decide:
  - `containsOpaqueRef`
  - `requiresRewrite`
  - which expressions become explicit dependencies

- `src/closures/strategies/array-method-strategy.ts`
  - `shouldTransformArrayMethod(...)`
  Uses receiver type/provenance to decide whether `map/filter/flatMap` become `mapWithPattern/filterWithPattern/flatMapWithPattern`.

- `src/transformers/opaque-get-validation.ts`
  Uses receiver type plus `getCellKind(...)` to allow `.get()` only on true cell/stream reads and reject it on opaque/reactive values.

- `src/transformers/call-root-support.ts`
  Uses receiver type plus `getCellKind(...)` to allow helper-owned `.get()` only for true cell/stream receivers.

- `src/transformers/expression-rewrite/emitters/helper-owned-expression.ts`
  Uses receiver type plus `getCellKind(...)` for the same helper-owned explicit-read distinction during rewriting.

- `src/transformers/expression-rewrite/emitters/binary-expression.ts`
  Uses `isReactiveValueExpression(...)` and `isSimpleReactiveAccessExpression(...)` to make logical-expression lowering decisions, especially for `&&` / `||`.

- `src/ast/event-handlers.ts`
  `isEventHandlerJsxAttribute(...)` uses contextual type to classify non-`on*` JSX props as event-handler sites when the expected type looks handler-like.

- `src/policy/callback-boundary.ts`
  Consumes type-backed event-handler and array-callback classification to decide callback boundary kind and whether the callback body is pattern-owned, compute-owned, or unsupported.

- `src/ast/reactive-context.ts`
  Builds effective pattern/compute/neutral context on top of the callback-boundary and call-kind decisions above.

- `src/transformers/expression-site-policy.ts`
  Consumes the type-backed callback/context/array-ownership classifications to decide whether an expression site is:
  - shared
  - owned
  - skipped
  - lowerable

- `src/transformers/expression-rewrite/rewrite-helpers.ts`
  `isOpaqueCallParameter(...)` depends on reactive array callback ownership and reactive context classification when filtering wrapper captures.

- `src/ast/scope-analysis.ts`
  `isFunctionDeclaration(...)` uses initializer type call signatures to decide whether a declaration should count as a plain function for capture/serialization policy.

- `src/closures/strategies/patternTool-strategy.ts`
  Uses type checks (`isOpaqueRefType(...)` and `checker.typeToString(...)`) to decide which module-scoped values are cell-like enough to capture in `patternTool(...)`.

## Behavior-Preserving Type Handoffs

These are not new policy decisions by themselves, but they preserve type information so later behavior-affecting checks still work on synthetic/transformed nodes.

- `src/closures/strategies/derive-strategy.ts`
  - `preRegisterCaptureTypes(...)`
  - `rewriteCaptureReferences(...)`
  Unwrap opaque captures to `T` inside derive callbacks, while preserving `Cell<T>` / `Stream<T>` as wrapped.

- `src/transformers/builtins/derive.ts`
  - `replaceOpaqueRefsWithParams(...)`
  Registers synthetic derive parameters with unwrapped types for the same reason.

- `src/transformers/pattern-body-reactive-root-lowering.ts`
  - `registerReplacementType(...)`
  Copies original types onto replacement nodes so downstream behavior checks still see the intended type.

- `src/transformers/expression-rewrite/rewrite-helpers.ts`
  - `createReactiveWrapperForExpression(...)`
  Registers synthetic computed-wrapper result types so later checker-backed logic remains coherent.

## Explicitly Excluded

These areas are type-heavy but are primarily schema/type-emission concerns, not behavioral policy:

- `src/transformers/schema-injection.ts`
- `src/transformers/schema-generator.ts`
- `src/transformers/type-shrinking.ts`
- most of `src/ast/type-inference.ts`
- `src/closures/utils/schema-factory.ts`
- `src/closures/strategies/action-strategy.ts`

## Bottom Line

The current transformer pipeline is still behaviorally type-aware.

The main live dependencies are:
- reactive value / reactive collection classification
- array-method ownership and `*WithPattern` decisions
- `.get()` legality
- event-handler / callback / reactive-context classification
- TypeRegistry handoffs that preserve those decisions across synthetic nodes
