/**
 * Cross-transformer communication registries.
 *
 * The pipeline creates nine shared registries in CommonFabricTransformerPipeline
 * (cf-pipeline.ts). Each is keyed by AST node or symbol identity, which is
 * preserved when transformers are applied in sequence via ts.transform().
 *
 * NOTE (registry-unification effort, 2026-05): the ninth,
 * syntheticLiftAppliedCallRegistry, is functionally inert in the current
 * pipeline (a downstream array-shrink re-collapses the type it preserves) and
 * is slated for removal — see docs/scratch/12-registry-unification-design.md.
 * It only becomes observable if CT-1621 lands.
 *
 * TypeRegistry (WeakMap<ts.Node, ts.Type>)
 *   Preserves and recovers synthetic typing across the pipeline. Serves three
 *   distinct uses sharing one map:
 *   - (a) replacement expression nodes keep their original authored types
 *   - (b) synthetic TypeNodes keep faithful schema/codegen types
 *   - (c) synthetic call expressions keep their result types
 *
 *   WHY ONE MAP IS SAFE (and why we did NOT split it — registry-unification
 *   investigation, 2026-05, docs/scratch/12-registry-unification-design.md):
 *   the three uses are isolated by KEY NODE-KIND, not by separate maps. A
 *   use-(a) key is always a replacement Expression/Identifier, a use-(b) key
 *   is always a ts.TypeNode, a use-(c) key is always a ts.CallExpression.
 *   These node-kinds never coincide for the same ts.Node, so a reader that
 *   looks up one kind of key can never retrieve another use's value. In
 *   particular the schema-generator package reads ONLY TypeNode keys (verified
 *   exhaustively: every .get/.has there keys on member.type, elementType,
 *   innerTypeNode, etc.), so it can only ever see use-(b) entries. Splitting
 *   into three physical maps would make this isolation explicit but fixes no
 *   reachable bug, while adding churn the reads can't even exploit (the shared
 *   read helpers — getTypeAtLocationWithFallback, ensureTypeNodeRegistered —
 *   are node-kind-agnostic and would have to consult all three anyway).
 *   The one genuine cross-consumer hazard CT-1615 hit (schema generator pulling
 *   a *pre-shrink* type meant for a different consumer) is already solved by
 *   the separate narrowedWrapperTypeRegistry channel — see its entry below.
 *   Writers: closure strategies, builtins/lift-applied, expression rewrites,
 *            type-building/schema-factory/type-shrinking, schema-injection
 *   Readers: lift-lowering transformer, schema-generator, type-inference,
 *            ast/utils, schema-injection, capability/type-shrinking logic
 *
 * mapCallbackRegistry (WeakSet<ts.Node>)
 *   Marks arrow functions created by ClosureTransformer as array method callbacks.
 *   Writers: context.markAsArrayMethodCallback() (called by array-method-strategy)
 *   Readers: context.isArrayMethodCallback() (called by pattern-callback lowering,
 *            reactive-context classifier)
 *
 * syntheticComputeCallbackRegistry (WeakSet<ts.Node>)
 *   Marks callbacks introduced by synthetic compute wrappers (e.g. JSX branch
 *   wrapping) so later phases can treat reused authored nodes as compute-owned.
 *   Writers: context.markAsSyntheticComputeCallback() (called by expression-rewrite/rewrite-helpers)
 *   Readers: context.isSyntheticComputeCallback() (called by reactive-context classifier)
 *
 * syntheticComputeOwnedNodeRegistry (WeakSet<ts.Node>)
 *   Marks authored subtrees that have been moved under a synthetic compute
 *   wrapper so later phases can override stale source-context classification.
 *   Writers: context.markSyntheticComputeOwnedSubtree() (called by expression-rewrite/rewrite-helpers)
 *   Readers: context.isSyntheticComputeOwnedNode() (called by reactive-context classifier)
 *
 * syntheticReactiveCollectionRegistry (WeakSet<ts.Symbol>)
 *   Records symbols of variable declarations that hold collections synthesized
 *   by the transformer (e.g., the result of __cfHelpers.lift(...)(captures)
 *   bound to a const). Used by call-kind detection to distinguish synthetic
 *   collections from user-authored ones. Note: keys by ts.Symbol, not ts.Node.
 *   Writers: context.markSyntheticReactiveCollectionDeclaration()
 *            (called by reactive-variable-for transformer)
 *   Readers: ast/call-kind.ts, closures/strategies/array-method-policy.ts
 *
 * SchemaHints (WeakMap<ts.Node, SchemaHint>)
 *   Overrides default schema generation behavior (e.g., array items: false).
 *   Writers: capture analysis in schema-injection
 *   Readers: schema-generator
 *
 * CapabilitySummaryRegistry (WeakMap<ts.Node, FunctionCapabilitySummary>)
 *   Caches per-function capability summaries (read/write paths, capability
 *   classification) computed by PatternCallbackLoweringTransformer.
 *   Writers: pattern-callback lowering (registerCapabilitySummary)
 *   Readers: schema-injection (findCapabilitySummaryForParameter)
 *
 * narrowedWrapperTypeRegistry (WeakMap<ts.TypeNode, ts.Type>)
 *   Maps synthetic wrapper TypeNodes produced by applyShrinkAndWrap back to
 *   the *pre-shrink* semantic Type that drove the narrowing. Deliberately
 *   kept separate from typeRegistry because the schema generator consults
 *   typeRegistry for wrapper-inner property recovery — registering pre-shrink
 *   types there would un-shrink carefully-narrowed inner schemas. Added in
 *   CT-1615 to support the lift-applied form's re-narrowing pass.
 *   Writers: context.markNarrowedWrapper() (called by
 *            transformers/type-shrinking.ts applyShrinkAndWrap)
 *   Readers: context.lookupNarrowedWrapper() (called by
 *            transformers/schema-injection.ts inner-lift revisit path)
 *
 * syntheticLiftAppliedCallRegistry (WeakSet<ts.CallExpression>)  [INERT — SLATED FOR REMOVAL]
 *   Marks CallExpressions emitted by createLiftAppliedCall (the synthetic
 *   JSX compute-wrap path used by expression-rewrite). Suppresses the
 *   capability-summary shrink in schema-injection's lift-applied dispatch,
 *   to keep the input TypeNode (already built from accurate capture analysis)
 *   from being collapsed to `unknown`.
 *   HOWEVER this is functionally inert today: a downstream array-shrink in
 *   type-shrinking re-collapses the array items to `unknown[]` regardless, so
 *   the final emitted schema is identical whether or not the marker fires
 *   (verified by neutering the writer — full fixture + schema-shrink suites
 *   unchanged). Kept only as pre-positioning for CT-1621; slated for removal
 *   in the registry-unification effort. See
 *   docs/scratch/12-registry-unification-design.md.
 *   User-source derive<T,R>(...) lowered via LiftLoweringTransformer is
 *   NOT marked, so it retains the legacy shrink behavior.
 *   Writers: context.markSyntheticLiftAppliedCall() (called by
 *            transformers/builtins/lift-applied.ts → createLiftAppliedCall)
 *   Readers: context.isSyntheticLiftAppliedCall() (called by
 *            transformers/schema-injection.ts lift-applied dispatch branch)
 *
 * --- Cache invalidation contract ---
 *
 * The four context.mark* methods on TransformationContext (for
 * mapCallbackRegistry, syntheticComputeCallbackRegistry,
 * syntheticComputeOwnedNodeRegistry, syntheticReactiveCollectionRegistry)
 * each mutate their registry and then call invalidateReactiveAnalysisCaches().
 * That helper drops three things: the wrapper-level caches
 * (#reactiveContextCache, #relevantDataFlowCache) and the dataflow analyzer
 * instance itself (#dataFlowAnalyzer). Dropping the analyzer instance is
 * critical: the analyzer's internal per-expression cache
 * (createDataFlowAnalyzer's `analysisCache`) lives inside its closure and
 * would otherwise return stale pre-mutation verdicts after a registry write.
 *
 * `narrowedWrapperTypeRegistry` is accessed only through
 * `context.markNarrowedWrapper()` / `context.lookupNarrowedWrapper()` (no
 * cache-invalidation needed because no analysis cache depends on it, but
 * routing through the methods centralises the contract — Berni's review
 * §3.4 on CT-1615).
 *
 * The remaining three registries (typeRegistry, schemaHints,
 * capabilitySummaryRegistry) are mutated via direct .set() at call sites
 * and have no cache-invalidation discipline. This is fine today because no
 * analysis cache depends on their contents, but if you add a cache that
 * does, mutate the registry through a context method that invalidates it
 * (or extend invalidateReactiveAnalysisCaches).
 *
 * If you add a new context-level cache or registry, mutate it through a
 * mark* method that calls invalidateReactiveAnalysisCaches() (or extend the
 * helper to also drop your new cache). If you add a new analyzer-side cache
 * inside createDataFlowAnalyzer, no extra wiring is needed — the whole
 * analyzer instance is dropped together, so any state captured in its
 * closure is GC'd.
 *
 * --- Registry unification (in progress, 2026-05) ---
 *
 * This registry layer is being consolidated into a single CrossStageState
 * abstraction. The plan and rationale live in
 * `docs/scratch/12-registry-unification-design.md` (supersedes the earlier
 * audit in `07-registry-audit.md`). Sequence:
 *   1. (done) doc refresh: count fix + mark the inert registry.
 *   2. (done — NO-OP, by investigation) Splitting typeRegistry into three
 *      maps was on the plan, but the split fixes no reachable bug: the three
 *      uses are already isolated by key node-kind (see the TypeRegistry note
 *      above), and the one real CT-1615 cross-consumer hazard is already
 *      handled by narrowedWrapperTypeRegistry. Documented the invariant
 *      instead of splitting.
 *   3. Lift the remaining direct-.get/.set registries (schemaHints,
 *      capabilitySummaryRegistry) to record/lookup methods.
 *   4. Remove syntheticLiftAppliedCallRegistry (inert; see its entry above).
 *   5. Fold the transformer-internal channels into CrossStageState; keep
 *      typeRegistry + schemaHints as loose maps at the schema-generator
 *      package boundary (the only channels that package reads), so no
 *      CrossStageState type crosses into schema-generator.
 */
export { TransformationContext } from "./context.ts";
export type {
  CapabilityParamDefault,
  CapabilityParamSummary,
  CapabilitySummaryRegistry,
  DiagnosticInput,
  DiagnosticSeverity,
  FunctionCapabilitySummary,
  ReactiveCapability,
  SchemaHint,
  SchemaHints,
  TransformationDiagnostic,
  TransformationOptions,
  TransformMode,
  TypeRegistry,
} from "./transformers.ts";
export {
  HelpersOnlyTransformer,
  Pipeline,
  Transformer,
} from "./transformers.ts";
export * from "./common-fabric-symbols.ts";
export {
  CF_DATA_HELPER_IDENTIFIER,
  CF_HELPERS_IDENTIFIER,
  CFHelpers,
  injectCfDataHelper,
  injectCfHelpers,
  sourceDisablesCfTransform,
  transformCfDirective,
} from "./cf-helpers.ts";
