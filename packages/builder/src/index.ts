// Export the factory function
export { createBuilder } from "./factory.ts";
export type { BuilderFunctions, BuilderRuntime } from "./types.ts";

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
  AuthSchema,
  type Frame,
  type HandlerFactory,
  ID,
  ID_FIELD,
  isAlias,
  isModule,
  isOpaqueRef,
  isRecipe,
  isStatic,
  isStreamAlias,
  type JSONObject,
  type JSONSchema,
  type JSONSchemaMutable,
  type JSONValue,
  markAsStatic,
  type Module,
  type ModuleFactory,
  NAME,
  type NodeFactory,
  type Opaque,
  type OpaqueRef,
  type OpaqueRefMethods,
  type Recipe,
  type RecipeFactory,
  type StreamAlias,
  type toJSON,
  toOpaqueRef,
  TYPE,
  UI,
  unsafe_materializeFactory,
  unsafe_originalRecipe,
  unsafe_parentRecipe,
  type UnsafeBinding,
} from "./types.ts";
export { createNodeFactory } from "./module.ts";
export { opaqueRef as cell } from "./opaque-ref.ts";
export { type Schema, schema } from "./schema-to-ts.ts";
export type { Mutable } from "@commontools/utils/types";

// This should be a separate package, but for now it's easier to keep it here.
export {
  createJsonSchema,
  deepEqual,
  getValueAtPath,
  setValueAtPath,
} from "./utils.ts";
