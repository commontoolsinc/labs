import { raw } from "../module.ts";
import { map } from "./map.ts";
import { fetchData } from "./fetch-data.ts";
import { streamData } from "./stream-data.ts";
import { llm, generateObject } from "./llm.ts";
import { ifElse } from "./if-else.ts";
import type { IRuntime } from "../runtime.ts";
import { compileAndRun } from "./compile-and-run.ts";

/**
 * Register all built-in modules with a runtime's module registry
 */
export function registerBuiltins(runtime: IRuntime) {
  const moduleRegistry = runtime.moduleRegistry;

  moduleRegistry.addModuleByRef("map", raw(map));
  moduleRegistry.addModuleByRef("fetchData", raw(fetchData));
  moduleRegistry.addModuleByRef("streamData", raw(streamData));
  moduleRegistry.addModuleByRef("llm", raw(llm));
  moduleRegistry.addModuleByRef("ifElse", raw(ifElse));
  moduleRegistry.addModuleByRef("compileAndRun", raw(compileAndRun));
  moduleRegistry.addModuleByRef("generateObject", raw(generateObject));
}
