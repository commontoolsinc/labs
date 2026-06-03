import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";

import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import { Engine } from "../src/harness/engine.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import {
  buildRecordsFromCompiled,
  type CachedCompiledModule,
  extractCompiledExports,
} from "../src/sandbox/module-record-compiler.ts";

const signer = await Identity.fromPassphrase("build-from-compiled");

// The warm load path builds records directly from cached compiled bodies — no
// TS source, no resolve, no recompile. The export NAMES are recovered from the
// compiled JS (export * unioned transitively). These tests prove that the
// resolve-free build produces records equivalent to the source-derived ones.

describe("extractCompiledExports", () => {
  it("recovers exports.X assignments and Object.defineProperty re-exports", () => {
    const compiled = [
      `Object.defineProperty(exports, "__esModule", { value: true });`,
      `exports.b = exports.a = void 0;`,
      `exports.a = 1;`,
      `exports.b = 2;`,
      `Object.defineProperty(exports, "c", { enumerable: true, get: function () { return x.c; } });`,
    ].join("\n");
    const { names, starTargetSpecs } = extractCompiledExports(compiled);
    expect(new Set(names)).toEqual(new Set(["a", "b", "c"]));
    expect(names.has("__esModule")).toBe(false);
    expect(starTargetSpecs).toEqual([]);
  });

  it("recovers export-star require specifiers", () => {
    const compiled = [
      `var tslib_1 = require("tslib");`,
      `__exportStar(require("./util.ts"), exports);`,
      `exports.z = 9;`,
    ].join("\n");
    const { names, starTargetSpecs } = extractCompiledExports(compiled);
    expect(new Set(names)).toEqual(new Set(["z"]));
    expect(starTargetSpecs).toEqual(["./util.ts"]);
  });
});

describe("buildRecordsFromCompiled (resolve-free, source-free)", () => {
  let runtime: Runtime;
  let engine: Engine;
  let storageManager: ReturnType<typeof StorageManager.emulate>;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({ apiUrl: new URL(import.meta.url), storageManager });
    engine = runtime.harness as Engine;
  });
  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  const PROGRAM: RuntimeProgram = {
    main: "/main.tsx",
    files: [
      {
        name: "/util.ts",
        contents: "export const a = 1;\nexport const b = 2;",
      },
      {
        name: "/reexport.ts",
        contents: `export * from "./util.ts";\nexport const c = 3;`,
      },
      {
        name: "/main.tsx",
        contents: [
          `import { pattern } from 'commonfabric';`,
          `export * from "./reexport.ts";`,
          `export const z = 9;`,
          `export default pattern<{ v: number }>(({ v }) => ({ out: v }));`,
        ].join("\n"),
      },
    ],
  };

  it("builds records whose exports + resolutions match the source-compiled graph", async () => {
    const { graph, modules } = await engine.compileToRecordGraph(PROGRAM);

    const cached: CachedCompiledModule[] = modules.map((m) => ({
      identity: m.identity,
      filename: m.filename,
      code: m.js,
      imports: m.imports,
      ...(m.sourceMap !== undefined ? { sourceMap: m.sourceMap as never } : {}),
    }));
    const built = buildRecordsFromCompiled(cached, {
      // Runtime export names so an `export *` from a runtime module (none here)
      // would resolve; harmless to pass for parity with the engine.
      runtimeModules: { commonfabric: [] },
    });

    // Map specifier → engine's normalized filename so we can identify authored
    // modules (path starts with "/") vs the injected `cfc.ts` ambient helper.
    const filenameBySpec = new Map(
      modules.map((m) => [`cf:module/${m.identity}`, m.filename]),
    );

    // Every cf:module record is reproduced from cached bodies alone.
    for (const [specifier, srcRecord] of graph.records) {
      if (!specifier.startsWith("cf:module/")) continue; // skip cf:runtime/*
      const builtRecord = built.records.get(specifier);
      expect(builtRecord, `missing built record for ${specifier}`)
        .toBeDefined();

      const filename = filenameBySpec.get(specifier);
      // Authored modules: JS-derived export names match source-derived exactly.
      // The injected `cfc.ts` helper is the one exception — its source declares
      // ambient exports (`export declare const …`) that the compiler ERASES, so
      // source-analysis over-declares names with no runtime value while the
      // compiled body assigns none. That module's namespace is unused (real
      // values come from cf:runtime/commonfabric), so the difference is benign.
      if (filename?.startsWith("/")) {
        expect(new Set(builtRecord!.exports)).toEqual(
          new Set(srcRecord.exports),
        );
      }

      // Internal (cf:module/*) resolutions must match exactly for every module.
      const internalRes = (r: Record<string, string> | undefined) =>
        Object.fromEntries(
          Object.entries(r ?? {}).filter(([, v]) => v.startsWith("cf:module/")),
        );
      expect(internalRes(builtRecord!.resolutions)).toEqual(
        internalRes(srcRecord.resolutions),
      );
    }

    // The entry's derived exports include the transitive export-* names.
    const entrySpec = built.specifierByPath.get("/main.tsx")!;
    expect(new Set(built.records.get(entrySpec)!.exports)).toEqual(
      new Set(["z", "default", "a", "b", "c", "__esModule"]),
    );
  });
});
