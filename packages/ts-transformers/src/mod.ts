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
