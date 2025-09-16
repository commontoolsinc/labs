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

export {
  collectOpaqueRefs,
  containsOpaqueRef,
  isOpaqueRefType,
  isSimpleOpaqueRefAccess,
} from "./opaque-ref/types.ts";

export {
  createIfElseCall,
  replaceOpaqueRefWithParam,
  replaceOpaqueRefsWithParams,
  transformExpressionWithOpaqueRef,
} from "./opaque-ref/transforms.ts";

export { createJsxExpressionRule } from "./opaque-ref/rules/jsx-expression.ts";
