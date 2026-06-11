import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import type { Engine } from "../src/harness/engine.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import {
  COMPILE_CACHE_RUNTIME_VERSION,
  loadCompiledClosure,
  writeSourceDocs,
} from "../src/compilation-cache/cell-cache.ts";

const signer = await Identity.fromPassphrase(
  "fabric imports pattern manager test",
);
const space = signer.did();

describe("PatternManager fabric imports", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
  });

  afterEach(async () => {
    await storageManager?.close();
  });

  const newRuntime = () =>
    new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });

  function dependencyProgram(value: number): RuntimeProgram {
    return {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents: [
            `import { pattern } from "commonfabric";`,
            `export const x = ${value};`,
            `export default pattern<{ value: number }>(({ value }) => ({ dep: value + x }));`,
          ].join("\n"),
        },
      ],
    };
  }

  function importerProgram(specifier: string): RuntimeProgram {
    return {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents: [
            `import { pattern } from "commonfabric";`,
            `import dep, { x } from "${specifier}";`,
            `export function y() { return x + 1; }`,
            `export default pattern<{ value: number }>(({ value }) => {`,
            `  const child = dep({ value });`,
            `  return { result: value + x + 1, child };`,
            `});`,
          ].join("\n"),
        },
      ],
    };
  }

  async function runPattern(
    runtime: Runtime,
    pattern: unknown,
    value: number,
    cause: string,
  ): Promise<unknown> {
    const tx = runtime.edit();
    const resultCell = runtime.getCell<{
      result: number;
      child: { dep: number };
    }>(space, cause, undefined, tx);
    // deno-lint-ignore no-explicit-any
    const result = runtime.run(tx, pattern as any, { value }, resultCell);
    await tx.commit();
    await result.pull();
    return result.getAsQueryResult();
  }

  it("compiles cache-backed fabric imports and warm-reloads them by identity", async () => {
    const rt1 = newRuntime();
    const rt2 = newRuntime();
    try {
      const pm1 = rt1.patternManager;
      const tx1 = rt1.edit();
      const dependency = await pm1.compilePattern(dependencyProgram(10), {
        space,
        tx: tx1,
      });
      const dependencyIdentity = pm1.getArtifactEntryRef(dependency)!.identity;
      await pm1.flushCompileCacheWrites();

      const importer = await pm1.compilePattern(
        importerProgram(`cf:pattern:${dependencyIdentity}`),
        { space, tx: tx1 },
      );
      const importerIdentity = pm1.getArtifactEntryRef(importer)!.identity;
      await pm1.flushCompileCacheWrites();
      await tx1.commit();
      await rt1.storageManager.synced();

      const loaded = await rt2.patternManager.loadPatternByIdentity(
        importerIdentity,
        "default",
        space,
      );

      expect(typeof loaded).toBe("function");
      expect(rt2.patternManager.getCompileCacheStats().byIdentityHits).toBe(1);
      const out = await runPattern(rt2, loaded, 5, "warm fabric reload") as {
        result: number;
        child: { dep: number };
      };
      expect(out.result).toBe(16);
      expect(out.child).toEqual({ dep: 15 });
      expect(
        rt2.patternManager.artifactFromIdentitySync(
          dependencyIdentity,
          "default",
        ),
      ).toBeDefined();
    } finally {
      await rt2.dispose();
      await rt1.dispose();
    }
  });

  it("cold-reloads fabric imports by identity from verified source docs", async () => {
    const runtime = newRuntime();
    try {
      const engine = runtime.harness as Engine;
      const dependency = await engine.compileToRecordGraph(
        dependencyProgram(20),
      );
      const depTx = runtime.edit();
      writeSourceDocs(
        runtime,
        space,
        dependency.modules,
        dependency.entryIdentity,
        depTx,
      );
      await depTx.commit();

      const importer = await engine.compileToRecordGraph(
        importerProgram(`cf:pattern:${dependency.entryIdentity}`),
        { fabricImports: { space } },
      );
      const importerTx = runtime.edit();
      writeSourceDocs(
        runtime,
        space,
        importer.modules,
        importer.entryIdentity,
        importerTx,
      );
      await importerTx.commit();

      const loaded = await runtime.patternManager.loadPatternByIdentity(
        importer.entryIdentity,
        "default",
        space,
      );

      expect(typeof loaded).toBe("function");
      const out = await runPattern(
        runtime,
        loaded,
        2,
        "cold fabric reload",
      ) as {
        result: number;
        child: { dep: number };
      };
      expect(out.result).toBe(23);
      expect(out.child).toEqual({ dep: 22 });
      expect(
        runtime.patternManager.artifactFromIdentitySync(
          dependency.entryIdentity,
          "default",
        ),
      ).toBeDefined();

      await runtime.patternManager.flushCompileCacheWrites();
      const readTx = runtime.edit();
      const compiled = await loadCompiledClosure(
        runtime,
        space,
        importer.entryIdentity,
        {
          runtimeVersion: COMPILE_CACHE_RUNTIME_VERSION,
          compilerDid: runtime.userIdentityDID,
        },
        readTx,
      );
      readTx.abort?.();
      expect(compiled.has(importer.entryIdentity)).toBe(true);
      expect(compiled.has(dependency.entryIdentity)).toBe(true);
    } finally {
      await runtime.dispose();
    }
  });
});
