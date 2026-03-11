/**
 * Cross-transformer communication registries.
 *
 * The pipeline creates four shared registries in CommonToolsTransformerPipeline
 * (ct-pipeline.ts). Each is keyed by AST node identity, which is preserved when
 * transformers are applied in sequence via ts.transform().
 *
 * TypeRegistry (WeakMap<ts.Node, ts.Type>)
 *   Preserves original Type when schema-injection creates synthetic TypeNodes
 *   that may not survive round-tripping through checker.getTypeFromTypeNode().
 *   Writers: derive-strategy, array-method-utils, builtins/derive, opaque-ref/helpers
 *   Readers: computed transformer, schema-generator, type-inference, ast/utils
 *
 * mapCallbackRegistry (WeakSet<ts.Node>)
 *   Marks arrow functions created by ClosureTransformer as array method callbacks.
 *   Writers: context.markAsArrayMethodCallback() (called by array-method-strategy)
 *   Readers: context.isArrayMethodCallback() (called by capability-lowering,
 *            reactive-context classifier)
 *
 * reactiveContextOverrideRegistry (WeakMap<ts.Node, ReactiveContextOverride>)
 *   Marks authored subtrees that are synthetically moved under compute wrappers
 *   so later passes classify them against compute context instead of their
 *   original pattern parent chain.
 *   Writers: opaque-ref/helpers, builtins/derive
 *   Readers: reactive-context classifier
 *
 * SchemaHints (WeakMap<ts.Node, SchemaHint>)
 *   Overrides default schema generation behavior (e.g., array items: false).
 *   Writers: capture analysis in schema-injection
 *   Readers: schema-generator
 *
 * CapabilitySummaryRegistry (WeakMap<ts.Node, FunctionCapabilitySummary>)
 *   Caches per-function capability summaries (read/write paths, capability
 *   classification) computed by CapabilityLoweringTransformer.
 *   Writers: capability-lowering (registerCapabilitySummary)
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
  ReactiveContextOverride,
  ReactiveContextOverrideRegistry,
  ReactiveCapability,
  SchemaHint,
  SchemaHints,
  TransformationDiagnostic,
  TransformationOptions,
  TransformMode,
  TypeRegistry,
} from "./transformers.ts";
export { Pipeline, Transformer } from "./transformers.ts";
export * from "./common-tools-symbols.ts";
export {
  CT_HELPERS_IDENTIFIER,
  CTHelpers,
  transformCtDirective,
} from "./ct-helpers.ts";
