// New Runtime class and interfaces
export { Runtime } from "./runtime.ts";
export type { 
  RuntimeOptions, 
  ConsoleHandler, 
  ErrorHandler,
  CharmMetadata,
  ErrorWithContext as RuntimeErrorWithContext
} from "./runtime.ts";

// Legacy singleton exports removed - use Runtime instance methods instead
export { raw } from "./module.ts"; // addModuleByRef removed - use runtime.moduleRegistry instead
// Removed all singleton scheduler exports - use runtime.scheduler instead
// export { isErrorWithContext } - function doesn't exist
export { getRecipeEnvironment, setRecipeEnvironment } from "./env.ts";
export type { DocImpl } from "./doc.ts";
export type { Cell, CellLink, Stream } from "./cell.ts";
export type { EntityId } from "./doc-map.ts";
export { createRef, getEntityId } from "./doc-map.ts";
export type { QueryResult } from "./query-result-proxy.ts";
export type { Action, ErrorWithContext, ReactivityLog } from "./scheduler.ts";
export * as StorageInspector from "./storage/inspector.ts";
export { VolatileStorageProvider } from "./storage/volatile.ts";
export { isDoc } from "./doc.ts"; // getDoc removed - use runtime.documentMap.getDoc instead

// Minimal compatibility exports for external packages only - DO NOT USE IN NEW CODE
// External packages should migrate to using Runtime instances
import { Runtime } from "./runtime.ts";
import { VolatileStorageProvider } from "./storage/volatile.ts";

let _compatRuntime: Runtime | undefined;
function getCompatRuntime() {
  if (!_compatRuntime) {
    _compatRuntime = new Runtime({ 
      storageProvider: new VolatileStorageProvider("external-compat") 
    });
  }
  return _compatRuntime;
}

export function getCell<T = any>(space: string, cause: any, schema?: any, log?: any) {
  return getCompatRuntime().getCell<T>(space, cause, schema, log);
}

export function getImmutableCell<T = any>(space: string, value: T, schema?: any) {
  return getCompatRuntime().getImmutableCell<T>(space, value, schema);
}

// getEntityId and createRef are now standalone functions exported from doc-map.ts above

export function getDoc<T = any>(value: any, cause: any, space: string) {
  return getCompatRuntime().documentMap.getDoc<T>(value, cause, space);
}
export {
  // Temporarily re-export for external package compatibility - TODO: update external packages to use Runtime
  createCell,
  isCell,
  isCellLink,
  isStream,
} from "./cell.ts";
export {
  getCellLinkOrThrow,
  getCellLinkOrValue,
  isQueryResult,
  isQueryResultForDereferencing,
} from "./query-result-proxy.ts";
export { effect } from "./reactivity.ts";
export {
  // Removed singleton functions: createRef, getDocByEntityId, getEntityId - use runtime.documentMap methods instead
  // EntityId is now exported above
} from "./doc-map.ts";
export { type AddCancel, type Cancel, noOp, useCancelGroup } from "./cancel.ts";
export { Storage } from "./storage.ts";
export { getBlobbyServerUrl, setBlobbyServerUrl } from "./blobby-storage.ts";
export { ConsoleMethod } from "./harness/console.ts";
export { runtime as harnessRuntime } from "./harness/index.ts";

// Removed old backward compatibility singletons - use Runtime instances instead
export {
  addCommonIDfromObjectID,
  followAliases,
  maybeGetCellLink,
} from "./utils.ts";
export { Classification, ContextualFlowControl } from "./cfc.ts";
export * from "./recipe-manager.ts";
