import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { Engine } from "../src/harness/engine.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import {
  CachedCompiler,
  MemoryCompilationCache,
} from "../src/compilation-cache/mod.ts";
import { popFrame, pushFrame } from "../src/builder/pattern.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("PatternManager program persistence", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();
  });

  afterEach(async () => {
    await tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("compiles multi-file program, attaches program, saves and reloads by id", async () => {
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [
        {
          name: "/util.ts",
          contents: "export const double = (x:number)=>x*2;",
        },
        {
          name: "/main.tsx",
          contents: [
            "import { pattern, lift } from 'commonfabric';",
            "import { double } from './util.ts';",
            "const dbl = lift((x:number)=>double(x));",
            "export default pattern<{ value: number }>(({ value }) => {",
            "  return { result: dbl(value) };",
            "});",
          ].join("\n"),
        },
      ],
    };

    const compiled = await runtime.patternManager.compilePattern(program);
    expect(compiled.program).toBeDefined();
    expect(compiled.program?.main).toEqual("/main.tsx");
    // Ensure original file names are preserved (no injected prefix leaked here)
    const fileNames = (compiled.program?.files ?? []).map((f) => f.name).sort();
    expect(fileNames).toEqual(["/main.tsx", "/util.ts"].sort());

    const patternId = runtime.patternManager.registerPattern(compiled, program);
    await runtime.patternManager.saveAndSyncPattern({ patternId, space });

    const meta = runtime.patternManager.getPatternMeta({ patternId });
    expect(meta.id).toEqual(patternId);
    expect(meta.program).toBeDefined();
    expect(meta.program?.main).toEqual("/main.tsx");
    const metaFileNames = (meta.program?.files ?? []).map((f) => f.name).sort();
    expect(metaFileNames).toEqual(["/main.tsx", "/util.ts"].sort());

    // Verify we can re-load and run the saved pattern
    const loaded = await runtime.patternManager.loadPattern(
      patternId,
      space,
      tx,
    );
    const resultCell = runtime.getCell<{ result: number }>(
      space,
      "pattern-manager: run loaded",
      undefined,
      tx,
    );
    const result = runtime.run(tx, loaded, { value: 3 }, resultCell);
    await tx.commit();
    tx = runtime.edit();
    await result.pull();
    expect(result.getAsQueryResult()).toEqual({ result: 6 });
  });

  it("register/save idempotency: saving same pattern id twice is harmless", async () => {
    const program: RuntimeProgram = {
      main: "/main.ts",
      files: [
        {
          name: "/main.ts",
          contents: [
            "import { pattern } from 'commonfabric';",
            "export default pattern<{ x: number }>(({ x }) => ({ x }));",
          ].join("\n"),
        },
      ],
    };

    const compiled = await runtime.patternManager.compilePattern(program);
    const patternId = runtime.patternManager.registerPattern(compiled, program);
    const first = runtime.patternManager.savePattern({ patternId, space });
    const second = runtime.patternManager.savePattern({ patternId, space });
    expect(first).toBe(true);
    expect(second).toBe(true);

    const meta = runtime.patternManager.getPatternMeta({ patternId });
    expect(meta.program?.main).toEqual("/main.ts");
  });
});

describe("PatternManager.loadPattern error handling", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("throws descriptive error for missing pattern, not TypeError", async () => {
    const bogusId = "nonexistent-pattern-id";
    try {
      await runtime.patternManager.loadPattern(bogusId, space);
      throw new Error("should have thrown");
    } catch (err) {
      // Should throw the descriptive "has no stored source" error,
      // NOT a TypeError about reading properties of undefined
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).not.toMatch(/Cannot read properties/);
      expect((err as Error).message).toContain("has no stored source");
    }
  });
});

describe("PatternManager.compileOrGetPattern", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  const simpleProgram: RuntimeProgram = {
    main: "/main.ts",
    files: [
      {
        name: "/main.ts",
        contents: [
          "import { pattern } from 'commonfabric';",
          "export default pattern<{ x: number }>(({ x }) => ({ doubled: x }));",
        ].join("\n"),
      },
    ],
  };

  const differentProgram: RuntimeProgram = {
    main: "/main.ts",
    files: [
      {
        name: "/main.ts",
        contents: [
          "import { pattern } from 'commonfabric';",
          "export default pattern<{ y: number }>(({ y }) => ({ tripled: y }));",
        ].join("\n"),
      },
    ],
  };

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();
  });

  afterEach(async () => {
    await tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("compiles and returns a pattern on first call", async () => {
    const pattern = await runtime.patternManager.compileOrGetPattern(
      simpleProgram,
    );
    expect(pattern).toBeDefined();
    expect(pattern.program).toBeDefined();
    expect(pattern.program?.main).toEqual("/main.ts");
  });

  it("returns cached pattern on second call (same instance)", async () => {
    const first = await runtime.patternManager.compileOrGetPattern(
      simpleProgram,
    );
    const second = await runtime.patternManager.compileOrGetPattern(
      simpleProgram,
    );

    // Should be the exact same object instance (cache hit)
    expect(second).toBe(first);
  });

  it("does not overwrite a cached pattern's verified load id on re-registration", async () => {
    const compiled = await runtime.patternManager.compilePattern(simpleProgram);
    const patternId = runtime.patternManager.registerPattern(
      compiled,
      simpleProgram,
    );

    const initialLoadId = runtime.harness.getVerifiedLoadId?.(
      "__missing__",
      patternId,
    );
    expect(initialLoadId).toBeDefined();

    const frame = pushFrame({ verifiedLoadId: "wrong-load-id" });
    try {
      expect(runtime.patternManager.registerPattern(compiled)).toEqual(
        patternId,
      );
    } finally {
      popFrame(frame);
    }

    expect(runtime.harness.getVerifiedLoadId?.("__missing__", patternId))
      .toEqual(initialLoadId);
  });

  it("propagates verified load ids to nested compiled subpatterns", async () => {
    const nestedProgram: RuntimeProgram = {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents: [
            "import { Default, pattern } from 'commonfabric';",
            "export default pattern<{ values: Default<number[], []> }>(({ values }) => ({",
            "  doubled: values.map((value) => ({ next: value })),",
            "}));",
          ].join("\n"),
        },
      ],
    };

    const externalEngine = new Engine(runtime);
    const { jsScript, id } = await externalEngine.compile(nestedProgram);
    const { main } = await externalEngine.evaluate(
      id,
      jsScript,
      nestedProgram.files,
    );
    const compiled = main?.default as any;
    const patternId = runtime.patternManager.registerPattern(
      compiled,
      nestedProgram,
    );
    const initialLoadId = runtime.harness.getVerifiedLoadId?.(
      "__missing__",
      patternId,
    );
    expect(initialLoadId).toBeDefined();

    const nestedPattern = (compiled.nodes.find((node: any) => node.inputs?.op)
      ?.inputs as { op?: unknown }).op;
    expect(nestedPattern).toBeDefined();

    const nestedPatternId = runtime.patternManager.registerPattern(
      nestedPattern as any,
    );

    expect(runtime.harness.getVerifiedLoadId?.("__missing__", nestedPatternId))
      .toEqual(initialLoadId);
  });

  it("compiles different patterns for different programs", async () => {
    const first = await runtime.patternManager.compileOrGetPattern(
      simpleProgram,
    );
    const second = await runtime.patternManager.compileOrGetPattern(
      differentProgram,
    );

    // Should be different pattern instances
    expect(second).not.toBe(first);
    expect(first.program?.files[0].contents).toContain("doubled");
    expect(second.program?.files[0].contents).toContain("tripled");
  });

  it("single-flight: concurrent calls share one compilation", async () => {
    // Start multiple compilations concurrently
    const [first, second, third] = await Promise.all([
      runtime.patternManager.compileOrGetPattern(simpleProgram),
      runtime.patternManager.compileOrGetPattern(simpleProgram),
      runtime.patternManager.compileOrGetPattern(simpleProgram),
    ]);

    // All should return the same instance
    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  it("works with string input (single file)", async () => {
    const source = [
      "import { pattern } from 'commonfabric';",
      "export default pattern<{ n: number }>(({ n }) => ({ result: n }));",
    ].join("\n");

    const pattern = await runtime.patternManager.compileOrGetPattern(source);
    expect(pattern).toBeDefined();
    expect(pattern.program?.main).toEqual("/main.tsx");
  });

  it("pattern is cached and returns same instance on subsequent calls", async () => {
    const pattern = await runtime.patternManager.compileOrGetPattern(
      simpleProgram,
    );

    // The pattern should be cached - calling again returns same instance
    const pattern2 = await runtime.patternManager.compileOrGetPattern(
      simpleProgram,
    );
    expect(pattern2).toBe(pattern);

    // And the pattern should have its program attached
    expect(pattern.program).toBeDefined();
    expect(pattern.program?.main).toEqual("/main.ts");
  });
});

describe("PatternManager compilation cache integration", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let cacheStorage: MemoryCompilationCache;
  let cachedCompiler: CachedCompiler;
  let runtime: Runtime;

  const simpleProgram: RuntimeProgram = {
    main: "/main.ts",
    files: [
      {
        name: "/main.ts",
        contents: [
          "import { pattern } from 'commonfabric';",
          "export default pattern<{ x: number }>(({ x }) => ({ doubled: x }));",
        ].join("\n"),
      },
    ],
  };

  beforeEach(() => {
    cacheStorage = new MemoryCompilationCache();
    cachedCompiler = new CachedCompiler(cacheStorage, "test-fingerprint");
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      cachedCompiler,
    });
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("writes to cache on first compile, hits cache on second", async () => {
    expect(await cacheStorage.count()).toBe(0);

    // First compile — cache miss, should write an entry
    const first = await runtime.patternManager.compilePattern(simpleProgram);
    expect(first).toBeDefined();
    expect(first.program?.main).toEqual("/main.ts");
    expect(await cacheStorage.count()).toBe(1);
    expect(cachedCompiler.getStats().misses).toBe(1);
    expect(cachedCompiler.getStats().writes).toBe(1);

    // Second compile — cache hit, no new writes
    const second = await runtime.patternManager.compilePattern(simpleProgram);
    expect(second).toBeDefined();
    expect(second.program?.main).toEqual("/main.ts");
    expect(await cacheStorage.count()).toBe(1);
    expect(cachedCompiler.getStats().hits).toBe(1);
    expect(cachedCompiler.getStats().writes).toBe(1);
  });

  it("cache miss with wrong fingerprint triggers recompile", async () => {
    // Seed the cache with a known key and fingerprint, then use a
    // CachedCompiler with a different fingerprint to observe the mismatch.
    // We test CachedCompiler directly (not via Runtime) because Runtime's
    // constructor fires evictStale() which removes old-fingerprint entries
    // before compilePattern() can observe them.
    const programHash = "test-program-hash";
    await cacheStorage.set(programHash, {
      id: "stale-id",
      jsScript: { js: "// stale" },
      fingerprint: "old-fingerprint",
      cachedAt: Date.now(),
    });
    expect(await cacheStorage.count()).toBe(1);

    const compiler2 = new CachedCompiler(
      cacheStorage,
      "new-fingerprint",
    );

    const miss = await compiler2.get(programHash);
    expect(miss).toBeUndefined();
    expect(compiler2.getStats().misses).toBe(1);
    expect(compiler2.getStats().missReasons.fingerprintMismatch).toBe(1);
  });
});
