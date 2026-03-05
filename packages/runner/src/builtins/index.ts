import { raw } from "../module.ts";
import { map } from "./map.ts";
import { filter } from "./filter.ts";
import { flatMap } from "./flatmap.ts";
import { fetchData } from "./fetch-data.ts";
import { fetchProgram } from "./fetch-program.ts";
import { streamData } from "./stream-data.ts";
import { generateObject, generateText, llm } from "./llm.ts";
import { ifElse } from "./if-else.ts";
import { when } from "./when.ts";
import { unless } from "./unless.ts";
import type { Runtime } from "../runtime.ts";
import { compileAndRun } from "./compile-and-run.ts";
import { navigateTo } from "./navigate-to.ts";
import { wish } from "./wish.ts";
import type { Cell } from "../cell.ts";
import type {
  BuiltInGenerateObjectParams,
  BuiltInGenerateTextParams,
} from "@commontools/api";
import { llmDialog } from "./llm-dialog.ts";
import { markBuiltinModule } from "../cfc/implementation-identity.ts";

/**
 * Register all built-in modules with a runtime's module registry
 */
export function registerBuiltins(runtime: Runtime) {
  const moduleRegistry = runtime.moduleRegistry;

  moduleRegistry.addModuleByRef("map", markBuiltinModule(raw(map), "map"));
  moduleRegistry.addModuleByRef(
    "filter",
    markBuiltinModule(raw(filter), "filter"),
  );
  moduleRegistry.addModuleByRef(
    "flatMap",
    markBuiltinModule(raw(flatMap), "flatMap"),
  );
  moduleRegistry.addModuleByRef(
    "fetchData",
    markBuiltinModule(raw(fetchData), "fetchData"),
  );
  moduleRegistry.addModuleByRef(
    "fetchProgram",
    markBuiltinModule(raw(fetchProgram), "fetchProgram"),
  );
  moduleRegistry.addModuleByRef(
    "streamData",
    markBuiltinModule(raw(streamData), "streamData"),
  );
  moduleRegistry.addModuleByRef("llm", markBuiltinModule(raw(llm), "llm"));
  moduleRegistry.addModuleByRef(
    "llmDialog",
    markBuiltinModule(raw(llmDialog), "llmDialog"),
  );
  moduleRegistry.addModuleByRef(
    "ifElse",
    markBuiltinModule(raw(ifElse), "ifElse"),
  );
  moduleRegistry.addModuleByRef("when", markBuiltinModule(raw(when), "when"));
  moduleRegistry.addModuleByRef(
    "unless",
    markBuiltinModule(raw(unless), "unless"),
  );
  moduleRegistry.addModuleByRef(
    "compileAndRun",
    markBuiltinModule(raw(compileAndRun), "compileAndRun"),
  );
  moduleRegistry.addModuleByRef(
    "generateObject",
    markBuiltinModule(
      raw<BuiltInGenerateObjectParams, {
        pending: Cell<boolean>;
        result: Cell<Record<string, unknown> | undefined>;
        partial: Cell<string | undefined>;
        requestHash: Cell<string | undefined>;
      }>(generateObject),
      "generateObject",
    ),
  );
  moduleRegistry.addModuleByRef(
    "generateText",
    markBuiltinModule(
      raw<BuiltInGenerateTextParams, {
        pending: Cell<boolean>;
        result: Cell<string | undefined>;
        partial: Cell<string | undefined>;
        requestHash: Cell<string | undefined>;
      }>(generateText),
      "generateText",
    ),
  );
  moduleRegistry.addModuleByRef(
    "navigateTo",
    markBuiltinModule(raw(navigateTo), "navigateTo"),
  );
  moduleRegistry.addModuleByRef("wish", markBuiltinModule(raw(wish), "wish"));
}
