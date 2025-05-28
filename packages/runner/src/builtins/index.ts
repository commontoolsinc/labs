import { raw } from "../module.ts";
import { map } from "./map.ts";
import { fetchData } from "./fetch-data.ts";
import { streamData } from "./stream-data.ts";
import { llm } from "./llm.ts";
import { ifElse } from "./if-else.ts";
import type { IModuleRegistry, IRuntime } from "../runtime.ts";

/**
 * Register all built-in modules with a runtime's module registry
 */
export function registerBuiltins(runtime: IRuntime) {
  const moduleRegistry = runtime.moduleRegistry;
  
  // Register runtime-aware builtins
  moduleRegistry.addModuleByRef("map", raw(createMapBuiltin(runtime)));
  moduleRegistry.addModuleByRef("fetchData", raw(createFetchDataBuiltin(runtime)));
  moduleRegistry.addModuleByRef("streamData", raw(createStreamDataBuiltin(runtime)));
  moduleRegistry.addModuleByRef("llm", raw(createLlmBuiltin(runtime)));
  moduleRegistry.addModuleByRef("ifElse", raw(createIfElseBuiltin(runtime)));
}

/**
 * Create runtime-aware builtin factories
 */
function createMapBuiltin(runtime: IRuntime) {
  return (inputsCell: any, sendResult: any, addCancel: any, cause: any, parentDoc: any) => {
    return map(inputsCell, sendResult, addCancel, cause, parentDoc, runtime);
  };
}

function createFetchDataBuiltin(runtime: IRuntime) {
  return (inputsCell: any, sendResult: any, addCancel: any, cause: any, parentDoc: any) => {
    return fetchData(inputsCell, sendResult, addCancel, cause, parentDoc, runtime);
  };
}

function createStreamDataBuiltin(runtime: IRuntime) {
  return (inputsCell: any, sendResult: any, addCancel: any, cause: any, parentDoc: any) => {
    return streamData(inputsCell, sendResult, addCancel, cause, parentDoc, runtime);
  };
}

function createLlmBuiltin(runtime: IRuntime) {
  return (inputsCell: any, sendResult: any, addCancel: any, cause: any, parentDoc: any) => {
    return llm(inputsCell, sendResult, addCancel, cause, parentDoc, runtime);
  };
}

function createIfElseBuiltin(runtime: IRuntime) {
  return (inputsCell: any, sendResult: any, addCancel: any, cause: any, parentDoc: any) => {
    return ifElse(inputsCell, sendResult, addCancel, cause, parentDoc, runtime);
  };
}
