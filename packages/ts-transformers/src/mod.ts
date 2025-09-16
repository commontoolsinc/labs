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
  createSchemaTransformer,
} from "./legacy.ts";
export type {
  OpaqueRefTransformerOptions,
  SchemaTransformerOptions,
  TransformationError,
} from "./legacy.ts";
