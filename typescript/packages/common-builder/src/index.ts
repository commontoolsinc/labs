export { opaqueRef as cell, stream } from "./opaque-ref.js";
export { Spell, doc, select, $, event } from "./spell.js";
export {
  createNodeFactory,
  derive,
  lift,
  byRef,
  handler,
  isolated,
  compute,
  render,
  // event,
} from "./module.js";
export {
  recipe,
  recipeFromFrame,
  pushFrame,
  pushFrameFromCause,
  popFrame,
  getTopFrame,
} from "./recipe.js";
export {
  streamData,
  fetchData,
  llm,
  navigateTo,
  ifElse,
  str,
} from "./built-in.js";
export {
  TYPE,
  NAME,
  UI,
  type Opaque,
  type OpaqueRef,
  type OpaqueRefMethods,
  type Module,
  type Recipe,
  type Node,
  type Alias,
  type StreamAlias,
  type RecipeFactory,
  type NodeFactory,
  type ModuleFactory,
  isOpaqueRef,
  toOpaqueRef,
  isModule,
  isRecipe,
  isAlias,
  isStreamAlias,
  isStatic,
  markAsStatic,
  type toJSON,
  type JSONValue,
  type JSONSchema,
  type Frame,
  Static,
  type UnsafeBinding,
  unsafe_originalRecipe,
  unsafe_parentRecipe,
  unsafe_materializeFactory,
} from "./types.js";

// This should be a separate package, but for now it's easier to keep it here.
export {
  getValueAtPath,
  setValueAtPath,
  deepEqual,
  createJsonSchema,
} from "./utils.js";
