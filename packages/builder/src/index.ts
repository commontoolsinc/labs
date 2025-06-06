// Re-export all public API from interface for backward compatibility
export * from "./interface.ts";

export {
  type BuiltInCompileAndRunParams,
  type BuiltInCompileAndRunState,
  type BuiltInLLMParams,
  type BuiltInLLMState,
  compileAndRun,
  fetchData,
  ifElse,
  llm,
  navigateTo,
  str,
  streamData,
} from "./built-in.ts";

// Internal functions and exports needed by other packages
export {
  getRecipeEnvironment,
  type RecipeEnvironment,
  setRecipeEnvironment,
} from "./env.ts";
export {
  getTopFrame,
  popFrame,
  pushFrame,
  pushFrameFromCause,
  recipeFromFrame,
} from "./recipe.ts";
export {
  type Alias,
  ID_FIELD,
  isAlias,
  isModule,
  isOpaqueRef,
  isRecipe,
  isStatic,
  isStreamAlias,
  type JSONSchemaMutable,
  markAsStatic,
  type OpaqueRefMethods,
  type StreamAlias,
  type toJSON,
  toOpaqueRef,
  unsafe_materializeFactory,
  unsafe_originalRecipe,
  unsafe_parentRecipe,
  type UnsafeBinding,
} from "./types.ts";

// This should be a separate package, but for now it's easier to keep it here.
export {
  createJsonSchema,
  deepEqual,
  getValueAtPath,
  setValueAtPath,
} from "./utils.ts";

// Export the factory function
export { createBuilder } from "./factory.ts";
export type { BuilderFunctions, BuilderRuntime } from "./interface.ts";
