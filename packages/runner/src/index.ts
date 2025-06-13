export { Runtime } from "./runtime.ts";
export type {
  CharmMetadata,
  ConsoleHandler,
  ErrorHandler,
  ErrorWithContext as RuntimeErrorWithContext,
  RuntimeOptions,
} from "./runtime.ts";
export { raw } from "./module.ts";
export type { DocImpl } from "./doc.ts";
export type { Cell, CellLink, Stream } from "./cell.ts";
export type { EntityId } from "./doc-map.ts";
export { createRef, getEntityId } from "./doc-map.ts";
export type { QueryResult } from "./query-result-proxy.ts";
export type { Action, ErrorWithContext, ReactivityLog } from "./scheduler.ts";
export * as StorageInspector from "./storage/inspector.ts";
export { isDoc } from "./doc.ts";
export { isCell, isCellLink, isStream } from "./cell.ts";
export {
  getCellLinkOrThrow,
  getCellLinkOrValue,
  isQueryResult,
  isQueryResultForDereferencing,
} from "./query-result-proxy.ts";
export { effect } from "./reactivity.ts";
export { type AddCancel, type Cancel, noOp, useCancelGroup } from "./cancel.ts";
export { type MemorySpace, Storage } from "./storage.ts";
export {
  Console,
  type ConsoleEvent,
  ConsoleMethod,
  Engine,
  type EngineProcessOptions,
  EngineProgramResolver,
} from "./harness/index.ts";
export { addCommonIDfromObjectID } from "./data-updating.ts";
export { followAliases, maybeGetCellLink } from "./link-resolution.ts";
export * from "./recipe-manager.ts";

// Builder functionality (migrated from @commontools/builder package)
export { createBuilder } from "./builder/factory.ts";
export type {
  BuilderFunctionsAndConstants as BuilderFunctions,
  BuilderRuntime,
} from "./builder/types.ts";

// Internal functions and exports needed by other packages
export {
  getRecipeEnvironment,
  getRecipeEnvironment as builderGetRecipeEnvironment,
  type RecipeEnvironment,
  setRecipeEnvironment,
  setRecipeEnvironment as builderSetRecipeEnvironment,
} from "./builder/env.ts";
export {
  getTopFrame,
  popFrame,
  pushFrame,
  pushFrameFromCause,
  recipeFromFrame,
} from "./builder/recipe.ts";
export {
  type Alias,
  AuthSchema,
  type Cell as BuilderCell,
  type Child,
  type Frame,
  h,
  type HandlerFactory,
  ID,
  ID_FIELD,
  isAlias,
  isModule,
  isOpaqueRef,
  isRecipe,
  isStreamAlias,
  type JSONObject,
  type JSONSchema,
  type JSONSchemaMutable,
  type JSONValue,
  type Module,
  type ModuleFactory,
  NAME,
  type NodeFactory,
  type Opaque,
  type OpaqueRef,
  type OpaqueRefMethods,
  type Props,
  type Recipe,
  type RecipeFactory,
  type Schema,
  schema,
  type SchemaContext,
  type SchemaWithoutCell,
  type Stream as BuilderStream,
  type StreamAlias,
  type toJSON,
  toOpaqueRef,
  TYPE,
  UI,
  unsafe_materializeFactory,
  unsafe_originalRecipe,
  unsafe_parentRecipe,
  type UnsafeBinding,
  type VNode,
} from "./builder/types.ts";
export { createNodeFactory } from "./builder/module.ts";
export { opaqueRef as cell } from "./builder/opaque-ref.ts";
export { Classification, ContextualFlowControl } from "./cfc.ts";
export type { Mutable } from "@commontools/utils/types";

// Utility functions (split from utils.ts)
export {
  createJsonSchema,
} from "./builder/json-utils.ts";
export {
  deepEqual,
} from "./builder/traverse-utils.ts";
export {
  getValueAtPath,
  setValueAtPath,
} from "./builder/path-utils.ts";
