export { ImportRequirements as ImportManager } from "./core/imports.ts";
export type { ImportRequest } from "./core/imports.ts";

export type {
  TransformationContext,
  TransformationDiagnostic,
  TransformationOptions,
  TransformMode,
} from "./core/context.ts";

export {
  createSchemaTransformer,
  type SchemaTransformerOptions,
} from "./schema/schema-transformer.ts";

export { hasCtsEnableDirective } from "./cts-directive.ts";

export { collectOpaqueRefs } from "./opaque-ref/dataflow.ts";

export {
  containsOpaqueRef,
  isOpaqueRefType,
  isSimpleOpaqueRefAccess,
} from "./opaque-ref/types.ts";

export {
  createIfElseCall,
  replaceOpaqueRefsWithParams,
  replaceOpaqueRefWithParam,
  transformExpressionWithOpaqueRef,
} from "./opaque-ref/transforms.ts";

export {
  createJsxExpressionRule,
  type OpaqueRefRule,
} from "./opaque-ref/rules/jsx-expression.ts";

export {
  createModularOpaqueRefTransformer,
  type ModularOpaqueRefTransformerOptions,
} from "./opaque-ref/transformer.ts";

export { commonTypeScriptTransformer } from "./transform.ts";
