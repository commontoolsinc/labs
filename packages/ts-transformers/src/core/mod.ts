/**
 * Cross-transformer communication registries.
 *
 * The pipeline creates four shared registries in CommonToolsTransformerPipeline
 * (ct-pipeline.ts). Each is keyed by AST node identity, which is preserved when
 * transformers are applied in sequence via ts.transform().
 *
 * TypeRegistry (WeakMap<ts.Node, ts.Type>)
 *   Preserves and recovers synthetic typing across the pipeline:
 *   - replacement expression nodes keep their original authored types
 *   - synthetic TypeNodes keep faithful schema/codegen types
 *   - synthetic call expressions keep their result types
 *   Writers: closure strategies, builtins/derive, expression rewrites,
 *            type-building/schema-factory/type-shrinking, schema-injection
 *   Readers: computed transformer, schema-generator, type-inference,
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
export * from "./common-tools-symbols.ts";
export {
  CT_HELPERS_IDENTIFIER,
  CTHelpers,
  transformCtDirective,
} from "./ct-helpers.ts";
