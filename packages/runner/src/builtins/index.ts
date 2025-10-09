import { raw } from "../module.ts";
import { map } from "./map.ts";
import { fetchData } from "./fetch-data.ts";
import { streamData } from "./stream-data.ts";
import { generateObject, llm } from "./llm.ts";
import { ifElse } from "./if-else.ts";
import type { IRuntime } from "../runtime.ts";
import { compileAndRun } from "./compile-and-run.ts";
import { navigateTo } from "./navigate-to.ts";
import type { Cell } from "../cell.ts";
import type { BuiltInGenerateObjectParams } from "@commontools/api";
import { llmDialog } from "./llm-dialog.ts";

/**
 * Register all built-in modules with a runtime's module registry
 */
export function registerBuiltins(runtime: IRuntime) {
  const moduleRegistry = runtime.moduleRegistry;

  moduleRegistry.addModuleByRef("map", raw(map));
  moduleRegistry.addModuleByRef("fetchData", raw(fetchData));
  moduleRegistry.addModuleByRef("streamData", raw(streamData));
  moduleRegistry.addModuleByRef("llm", raw(llm));
  moduleRegistry.addModuleByRef("llmDialog", raw(llmDialog));
  moduleRegistry.addModuleByRef("ifElse", raw(ifElse));
  moduleRegistry.addModuleByRef("compileAndRun", raw(compileAndRun));
  moduleRegistry.addModuleByRef(
    "generateObject",
    raw<BuiltInGenerateObjectParams, {
      pending: Cell<boolean>;
      result: Cell<Record<string, unknown> | undefined>;
      partial: Cell<string | undefined>;
      requestHash: Cell<string | undefined>;
    }>(generateObject),
  );
  moduleRegistry.addModuleByRef("navigateTo", raw(navigateTo));
}
