import { raw } from "../module.ts";
import { map } from "./map.ts";
import { filter } from "./filter.ts";
import { flatMap } from "./flatmap.ts";
import {
  fetchBinary,
  fetchJson,
  fetchJsonUnchecked,
  fetchText,
} from "./fetch.ts";
import { fetchProgram } from "./fetch-program.ts";
import { streamData } from "./stream-data.ts";
import { generateObject, generateText, llm } from "./llm.ts";
import { IF_ELSE_ARGUMENT_SCHEMA, ifElse } from "./if-else.ts";
import { when } from "./when.ts";
import { unless } from "./unless.ts";
import type { Runtime } from "../runtime.ts";
import { compileAndRun } from "./compile-and-run.ts";
import { sqliteDatabase, sqliteQuery } from "./sqlite-builtins.ts";
import { navigateTo } from "./navigate-to.ts";
import { inspectConfLabel } from "./inspect-conf-label.ts";
import { wish } from "./wish.ts";
import type { Cell } from "../cell.ts";
import type {
  BuiltInGenerateObjectParams,
  BuiltInGenerateTextParams,
} from "@commonfabric/api";
import { llmDialog } from "./llm-dialog.ts";

const WISH_DEBOUNCE_MS = 50;

/**
 * Register all built-in modules with a runtime's module registry
 *
 * NOTE: Keep `builder/builtin-replayability.ts` in sync with these
 * registrations. At pattern-build time these runtime registrations are
 * invisible — builtins are just string names — and the computed-cell
 * classifier trusts only names listed there as replayable (unknown names
 * fail strict). When adding a builtin here, record it there: in
 * `REPLAYABLE_BUILTIN_REFS` if replaying the node deterministically
 * reproduces its writes, otherwise in the documented non-replayable list.
 * (Precedent for a name-keyed builtin set: `EAGER_RESULT_BUILTIN_REFS` in
 * runner.ts — scheduler-facing, deliberately kept separate.)
 */
export function registerBuiltins(runtime: Runtime) {
  const moduleRegistry = runtime.moduleRegistry;

  moduleRegistry.addModuleByRef("map", raw(map));
  moduleRegistry.addModuleByRef("filter", raw(filter));
  moduleRegistry.addModuleByRef("flatMap", raw(flatMap));
  moduleRegistry.addModuleByRef("fetchBinary", raw(fetchBinary));
  moduleRegistry.addModuleByRef("fetchText", raw(fetchText));
  moduleRegistry.addModuleByRef("fetchJson", raw(fetchJson));
  moduleRegistry.addModuleByRef(
    "fetchJsonUnchecked",
    raw(fetchJsonUnchecked),
  );
  moduleRegistry.addModuleByRef("fetchProgram", raw(fetchProgram));
  moduleRegistry.addModuleByRef("streamData", raw(streamData));
  moduleRegistry.addModuleByRef("llm", raw(llm, { isEffect: true }));
  moduleRegistry.addModuleByRef("llmDialog", raw(llmDialog));
  moduleRegistry.addModuleByRef(
    "ifElse",
    raw(ifElse, { argumentSchema: IF_ELSE_ARGUMENT_SCHEMA }),
  );
  moduleRegistry.addModuleByRef("when", raw(when));
  moduleRegistry.addModuleByRef("unless", raw(unless));
  moduleRegistry.addModuleByRef("compileAndRun", raw(compileAndRun));
  moduleRegistry.addModuleByRef("sqliteDatabase", raw(sqliteDatabase));
  // sqliteQuery does a server round-trip and writes results back, so it is an
  // effect (like generateText/llm), and re-runs when its `reactOn` input
  // changes. (Writes are the imperative SqliteDb.exec, folded into the caller's
  // commit — not a builtin node.)
  moduleRegistry.addModuleByRef(
    "sqliteQuery",
    raw(sqliteQuery, { isEffect: true }),
  );
  moduleRegistry.addModuleByRef(
    "generateObject",
    raw<BuiltInGenerateObjectParams, {
      pending: Cell<boolean>;
      result: Cell<Record<string, unknown> | undefined>;
      error: Cell<string | undefined>;
      partial: Cell<string | undefined>;
      requestHash: Cell<string | undefined>;
    }>(generateObject, { isEffect: true }),
  );
  moduleRegistry.addModuleByRef(
    "generateText",
    raw<BuiltInGenerateTextParams, {
      pending: Cell<boolean>;
      result: Cell<string | undefined>;
      error: Cell<string | undefined>;
      partial: Cell<string | undefined>;
      requestHash: Cell<string | undefined>;
    }>(generateText, { isEffect: true }),
  );
  moduleRegistry.addModuleByRef(
    "navigateTo",
    raw(navigateTo),
  );
  // inv-12 Stage 2 (spec §4.6.4.1): the bounded label-introspection surface.
  // Pure read/derive/write — not an effect; reactivity comes from its
  // journaled input + envelope reads.
  moduleRegistry.addModuleByRef("inspectConfLabel", raw(inspectConfLabel));
  moduleRegistry.addModuleByRef(
    "wish",
    raw(wish, { debounce: WISH_DEBOUNCE_MS }),
  );
}
