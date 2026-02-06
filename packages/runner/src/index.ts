export { Runtime } from "./runtime.ts";
export type {
  ConsoleHandler,
  ErrorHandler,
  ErrorWithContext as RuntimeErrorWithContext,
  RuntimeOptions,
  SpaceCellContents,
} from "./runtime.ts";
export * from "./interface.ts";
export { raw } from "./module.ts";
export type { Cell, Stream } from "./cell.ts";
export type { NormalizedLink } from "./link-types.ts";
export type { SigilLink, URI } from "./sigil-types.ts";
export { createRef, type EntityId, getEntityId } from "./create-ref.ts";
export type { CellResult as QueryResult } from "./query-result-proxy.ts";
export type { Action, ErrorWithContext, ReactivityLog } from "./scheduler.ts";
export * as StorageInspector from "./storage/inspector.ts";
export { StorageTelemetry } from "./storage/telemetry.ts";
export type {
  ChangeGroup,
  IExtendedStorageTransaction,
  MemorySpace,
} from "./storage/interface.ts";
export {
  debugTransactionWrites,
  formatTransactionSummary,
  summarizeTransaction,
  type TransactionSummary,
} from "./storage/transaction-summary.ts";
export { convertCellsToLinks, isCell, isStream } from "./cell.ts";
export {
  getCellOrThrow,
  isCellResult,
  isCellResultForDereferencing,
} from "./query-result-proxy.ts";
export { effect } from "./reactivity.ts";
export { type AddCancel, type Cancel, noOp, useCancelGroup } from "./cancel.ts";
export {
  Console,
  type ConsoleEvent,
  ConsoleMethod,
  Engine,
  type RuntimeProgram,
  type TypeScriptHarnessProcessOptions,
} from "./harness/index.ts";
export { addCommonIDfromObjectID } from "./data-updating.ts";
export { resolveLink } from "./link-resolution.ts";
export {
  areLinksSame,
  createLLMFriendlyLink,
  isCellLink as isLink,
  isWriteRedirectLink,
  parseLink,
  parseLinkOrThrow,
  parseLLMFriendlyLink,
} from "./link-utils.ts";
export {
  type DiscoveredLink,
  discoverLinksFrom,
  discoverLinksFromValue,
  traverseCellLinks,
} from "./link-discovery.ts";
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
  AuthSchema,
  type Cell as BuilderCell,
  type Frame,
  type HandlerFactory,
  ID,
  ID_FIELD,
  isModule,
  isOpaqueRef as isOpaqueRef,
  isRecipe,
  isStreamValue,
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
  type Props,
  type Recipe,
  type RecipeFactory,
  type RenderNode,
  type Schema,
  schema,
  type SchemaWithoutCell,
  type StreamValue,
  type toJSON,
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
export {
  RuntimeTelemetry,
  RuntimeTelemetryEvent,
  type RuntimeTelemetryMarker,
  type RuntimeTelemetryMarkerResult,
  type SchedulerGraphEdge,
  type SchedulerGraphNode,
  type SchedulerGraphSnapshot,
} from "./telemetry.ts";

// Utility functions (split from utils.ts)
export { createJsonSchema } from "./builder/json-utils.ts";
export { deepEqual } from "@commontools/utils/deep-equal";
export { getValueAtPath, setValueAtPath } from "./path-utils.ts";
