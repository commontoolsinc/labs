export type {
  DiagnosticSeverity,
  PatternCoverageKind,
  PatternCoverageOptions,
  PatternCoverageSpan,
  TransformationContext,
  TransformationDiagnostic,
  TransformationOptions,
  TransformMode,
} from "./core/mod.ts";
export {
  CrossStageState,
  injectCfDataHelper,
  injectCfHelpers,
  PATTERN_COVERAGE_GLOBAL,
  Pipeline,
  sourceDisablesCfTransform,
  transformCfDirective,
  Transformer,
} from "./core/mod.ts";
export {
  CFC_CANONICAL_ALIAS_NAMES,
  type CfcCanonicalAliasName,
} from "./cfc-authoring.ts";

export {
  CastValidationTransformer,
  JsxExpressionSiteRouterTransformer,
  PatternCallbackLoweringTransformer,
  PatternContextValidationTransformer,
  SchemaGeneratorTransformer,
  SchemaInjectionTransformer,
} from "./transformers/mod.ts";
export { ClosureTransformer } from "./closures/transformer.ts";
export { CommonFabricTransformerPipeline } from "./cf-pipeline.ts";
export {
  CompositeDiagnosticTransformer,
  type DiagnosticMessageTransformer,
  ReactiveErrorTransformer,
  type ReactiveErrorTransformerOptions,
} from "./diagnostics/mod.ts";
