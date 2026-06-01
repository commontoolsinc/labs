/**
 * Cross-transformer communication registries.
 *
 * The pipeline creates eight shared registries in CommonFabricTransformerPipeline
 * (cf-pipeline.ts). Each is keyed by AST node or symbol identity, which is
 * preserved when transformers are applied in sequence via ts.transform().
 *
 * (Two former members no longer exist: `syntheticLiftAppliedCallRegistry`, removed
 * in the registry-unification effort after being verified functionally inert (see
 * docs/scratch/12-registry-unification-design.md); and `narrowedWrapperTypeRegistry`,
 * removed in PR #3788 by detecting and short-circuiting the synthetic
 * capability-wrapper re-entry in schema-injection that was its sole consumer —
 * see the `schemaInjectedRegistry` entry below for the current idempotency model.
 * The current eighth member is `schemaInjectedRegistry`, added in CT-1621.)
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
 * schemaInjectedRegistry (WeakSet<ts.Node>)
 *   Marks builder call/new nodes that SchemaInjection has already finalized.
 *   The single top-of-visit guard in SchemaInjectionTransformer skips
 *   re-processing a marked node (descending only into its children to reach
 *   callback bodies). Replaces the scattered per-builder arg-count idempotency
 *   guards (`args.length >= 5`, the implicit "drop the type args so
 *   re-detection fails" trick, etc.) with one explicit signal, and plugs the
 *   lift `isToSchemaCall` branch's missing idempotency guard — eliminating the
 *   redundant self-re-entry re-narrowing that CT-1621 targeted. NOTE: this
 *   marks SYNTHETIC nodes we produce; unlike the other marker sets it uses a
 *   plain `.has` (no getOriginalNode fallback) because a marked node's original
 *   is the *pre-injection* user call, which must NOT read as injected.
 *   Some arg-count guards remain DELIBERATELY: the cell-factory/wish `>= 2`
 *   checks also protect USER-supplied schemas (which this marker can't cover),
 *   and the `!== 2`/`!== 3` checks are dispatch (input-shape) guards, not
 *   idempotency.
 *   Writers: context.markSchemaInjected() (SchemaInjection producer sites)
 *   Readers: context.isSchemaInjected() (SchemaInjection top-of-visit guard)
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
 * schemaHints and capabilitySummaryRegistry are accessed through context
 * record/lookup methods (recordSchemaHint/lookupSchemaHint,
 * recordCapabilitySummary/lookupCapabilitySummary) but do not invalidate
 * caches (no analysis cache depends on them). typeRegistry is still mutated via direct .set() at call
 * sites; same caveat applies. If you add a cache that depends on any of these,
 * route the mutation through a method that invalidates it (or extend
 * invalidateReactiveAnalysisCaches).
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
 *      above). The one real CT-1615 cross-consumer hazard (schema generator vs.
 *      schema injection needing different types for a synthetic wrapper node)
 *      was retired in CT-1621: PR #3716 added the `schemaInjectedRegistry`
 *      marker that catches re-entries on nodes whose mark survived. PR #3788
 *      then closed the residual case — synthetic capability-wrapper re-entries
 *      whose mark did not survive — by detecting them structurally
 *      (`argumentType.pos < 0 && isCellLikeTypeNode(argumentType)`) and
 *      short-circuiting the re-shrink, which left the channel without a
 *      consumer and let `narrowedWrapperTypeRegistry` be deleted entirely.
 *   3. (done) Lifted schemaHints + capabilitySummaryRegistry to context
 *      record/lookup methods. typeRegistry stays on direct .set (its split
 *      was dropped in step 2, so there's no per-use method to route through).
 *   4. (done) Removed syntheticLiftAppliedCallRegistry (verified inert).
 *   5. (pending) Fold the transformer-internal channels into CrossStageState;
 *      keep typeRegistry + schemaHints as loose maps at the schema-generator
 *      package boundary (the only channels that package reads), so no
 *      CrossStageState type crosses into schema-generator.
 */
export { TransformationContext } from "./context.ts";
export { CrossStageState } from "./cross-stage-state.ts";
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
