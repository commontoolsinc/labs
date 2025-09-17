export { applyPendingImports, createImportManager } from "./core/imports.ts";
export type {
  ImportManager,
  ImportRequest,
  ImportSpec,
} from "./core/imports.ts";

export { createTransformationContext, withFlag } from "./core/context.ts";
export type {
  TransformationContext,
  TransformationDiagnostic,
  TransformationFlags,
  TransformationOptions,
  TransformMode,
} from "./core/context.ts";

export {
  createOpaqueRefTransformer,
  type OpaqueRefTransformerOptions,
  type TransformationError,
} from "./legacy.ts";

export {
  createSchemaTransformer,
  type SchemaTransformerOptions,
} from "./schema/schema-transformer.ts";

export { collectOpaqueRefs } from "./opaque-ref/dependency.ts";

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
