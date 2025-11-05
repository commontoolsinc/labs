import { rawImpl } from "../module.ts";
import { map } from "./map.ts";
import { fetchData } from "./fetch-data.ts";
import { streamData } from "./stream-data.ts";
import { generateObject, generateText, llm } from "./llm.ts";
import { ifElse } from "./if-else.ts";
import type { IRuntime } from "../runtime.ts";
import { compileAndRun } from "./compile-and-run.ts";
import { navigateTo } from "./navigate-to.ts";
import { wish } from "./wish.ts";
import type { Cell } from "../cell.ts";
import type {
  BuiltInGenerateObjectParams,
  BuiltInGenerateTextParams,
} from "@commontools/api";
import { llmDialog } from "./llm-dialog.ts";

/**
 * Register all built-in modules with a runtime's module registry
 */
export function registerBuiltins(runtime: IRuntime) {
  const moduleRegistry = runtime.moduleRegistry;

  moduleRegistry.addModuleByRef("map", rawImpl(runtime, map));
  moduleRegistry.addModuleByRef("fetchData", rawImpl(runtime, fetchData));
  moduleRegistry.addModuleByRef("streamData", rawImpl(runtime, streamData));
  moduleRegistry.addModuleByRef("llm", rawImpl(runtime, llm));
  moduleRegistry.addModuleByRef("llmDialog", rawImpl(runtime, llmDialog));
  moduleRegistry.addModuleByRef("ifElse", rawImpl(runtime, ifElse));
  moduleRegistry.addModuleByRef(
    "compileAndRun",
    rawImpl(runtime, compileAndRun),
  );
  moduleRegistry.addModuleByRef(
    "generateObject",
    rawImpl<BuiltInGenerateObjectParams, {
      pending: Cell<boolean>;
      result: Cell<Record<string, unknown> | undefined>;
      partial: Cell<string | undefined>;
      requestHash: Cell<string | undefined>;
    }>(runtime, generateObject),
  );
  moduleRegistry.addModuleByRef(
    "generateText",
    rawImpl<BuiltInGenerateTextParams, {
      pending: Cell<boolean>;
      result: Cell<string | undefined>;
      partial: Cell<string | undefined>;
      requestHash: Cell<string | undefined>;
    }>(runtime, generateText),
  );
  moduleRegistry.addModuleByRef("navigateTo", rawImpl(runtime, navigateTo));
  moduleRegistry.addModuleByRef("wish", rawImpl(runtime, wish));
}
