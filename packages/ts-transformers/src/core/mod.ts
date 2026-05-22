/**
 * Cross-transformer communication registries.
 *
 * The pipeline creates eight shared registries in CommonFabricTransformerPipeline
 * (cf-pipeline.ts). Each is keyed by AST node or symbol identity, which is
 * preserved when transformers are applied in sequence via ts.transform().
 *
 * TypeRegistry (WeakMap<ts.Node, ts.Type>)
 *   Preserves and recovers synthetic typing across the pipeline. Currently
 *   overloaded with three distinct uses sharing one map:
 *   - replacement expression nodes keep their original authored types
 *   - synthetic TypeNodes keep faithful schema/codegen types
 *   - synthetic call expressions keep their result types
 *   The schema generator (packages/schema-generator) also consults this
 *   registry as authoritative for wrapper-inner property recovery — so any
 *   pre-shrink type registered here will cause carefully-narrowed inner
 *   schemas to be un-shrunk. See narrowedWrapperTypeRegistry for the
 *   separate channel that bypasses this consumer.
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
 *   Writers: transformers/type-shrinking.ts (applyShrinkAndWrap)
 *   Readers: transformers/schema-injection.ts (inner-lift revisit path)
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
 * The other four registries (typeRegistry, schemaHints,
 * capabilitySummaryRegistry, narrowedWrapperTypeRegistry) are mutated via
 * direct .set() at call sites and have no cache-invalidation discipline.
 * This is fine today because no analysis cache depends on their contents,
 * but if you add a cache that does, mutate the registry through a context
 * method that invalidates it (or extend invalidateReactiveAnalysisCaches).
 *
 * If you add a new context-level cache or registry, mutate it through a
 * mark* method that calls invalidateReactiveAnalysisCaches() (or extend the
 * helper to also drop your new cache). If you add a new analyzer-side cache
 * inside createDataFlowAnalyzer, no extra wiring is needed — the whole
 * analyzer instance is dropped together, so any state captured in its
 * closure is GC'd.
 *
 * --- Open architectural improvements ---
 *
 * See `docs/scratch/07-registry-audit.md` for a more thorough audit and
 * follow-up opportunities. In brief:
 *   - Lift the four direct-.get/.set registries to context.recordX/lookupX
 *     methods (matching the marker-set trio's pattern). Centralizes mutation,
 *     gets getOriginalNode fallback for free, eases adding invariants later.
 *   - Split typeRegistry into its three named purposes
 *     (replacementTypeRegistry, syntheticTypeNodeRegistry,
 *     syntheticCallResultRegistry). CT-1615 hit the consequences of the
 *     overload firsthand — separate channels would have prevented it.
 *   - Reconsider whether single-stage-pair registries (schemaHints,
 *     capabilitySummaryRegistry) should be threaded explicitly between just
 *     those stages rather than living in global options.
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
