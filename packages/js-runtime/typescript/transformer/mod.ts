// Main exports
export { 
  createOpaqueRefTransformer,
  type OpaqueRefTransformerOptions,
  type TransformationError,
} from "./opaque-ref.ts";

// Type checking utilities
export {
  isOpaqueRefType,
  containsOpaqueRef,
  collectOpaqueRefs,
  isSimpleOpaqueRefAccess,
} from "./types.ts";

// Import management utilities
export {
  getCommonToolsModuleAlias,
  hasCommonToolsImport,
  addCommonToolsImport,
  hasDeriveImport,
  hasIfElseImport,
  addDeriveImport,
  addIfElseImport,
} from "./imports.ts";

// Transformation utilities
export {
  replaceOpaqueRefWithParam,
  createIfElseCall,
  transformExpressionWithOpaqueRef,
  checkTransformation,
  type TransformationResult,
} from "./transforms.ts";

// Test utilities
export {
  transformSource,
  checkWouldTransform,
} from "./test-utils.ts";