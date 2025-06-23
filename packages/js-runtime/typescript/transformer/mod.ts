// Main exports
export {
  createOpaqueRefTransformer,
  type OpaqueRefTransformerOptions,
  type TransformationError,
} from "./opaque-ref.ts";

// Type checking utilities
export {
  collectOpaqueRefs,
  containsOpaqueRef,
  isOpaqueRefType,
  isSimpleOpaqueRefAccess,
} from "./types.ts";

// Import management utilities
export {
  addCommonToolsImport,
  getCommonToolsModuleAlias,
  hasCommonToolsImport,
} from "./imports.ts";

// Transformation utilities
export {
  checkTransformation,
  createIfElseCall,
  replaceOpaqueRefWithParam,
  type TransformationResult,
  transformExpressionWithOpaqueRef,
} from "./transforms.ts";
