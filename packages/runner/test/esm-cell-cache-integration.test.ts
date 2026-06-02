import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

// Step 5: PatternManager drives the content-addressed cell cache on the ESM
// path — cold compiles write the module set back (CFC-stamped), warm compiles
// reuse it, and the cache is gated on CFC enforcement.
describe("ESM compile via content-addressed cell cache", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  const PROGRAM: RuntimeProgram = {
    main: "/main.tsx",
    files: [
      { name: "/util.ts", contents: "export const double = (x:number)=>x*2;" },
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

  const newRuntime = (esm: boolean) =>
    new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      experimental: { esmModuleLoader: esm },
    });

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = newRuntime(true);
    tx = runtime.edit();
  });

  afterEach(async () => {
    await runtime?.patternManager.flushCompileCacheWrites();
    await tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
  });

  const run = async (compiled: unknown, value: number): Promise<unknown> => {
    const resultCell = runtime.getCell<{ result: number }>(
      space,
      `cell-cache run ${value}`,
      undefined,
      tx,
    );
    // deno-lint-ignore no-explicit-any
    const result = runtime.run(tx, compiled as any, { value }, resultCell);
    await tx.commit();
    tx = runtime.edit();
    await result.pull();
    return result.getAsQueryResult();
  };

  it("cold compile writes back, warm compile is a hit, both run correctly", async () => {
    const pm = runtime.patternManager;

    // Cold compile (miss): evaluates correctly and triggers write-back.
    const cold = await pm.compilePattern(PROGRAM, { space, tx });
    expect(await run(cold, 3)).toEqual({ result: 6 });
    expect(pm.getCompileCacheStats()).toEqual({ hits: 0, misses: 1 });

    // Wait for the fire-and-forget write-back to commit.
    await pm.flushCompileCacheWrites();

    // Warm compile (hit): served from the cache, still evaluates correctly.
    const warm = await pm.compilePattern(PROGRAM, { space, tx });
    expect(pm.getCompileCacheStats()).toEqual({ hits: 1, misses: 1 });
    expect(await run(warm, 5)).toEqual({ result: 10 });
  });

  it("warm hit reuses the cached body across a fresh runtime (cross-session)", async () => {
    // Session 1: cold compile + write-back.
    const pm1 = runtime.patternManager;
    await pm1.compilePattern(PROGRAM, { space, tx });
    await pm1.flushCompileCacheWrites();
    expect(pm1.getCompileCacheStats().misses).toBe(1);
    await tx.commit();

    // Session 2: a brand-new runtime on the same storage warms from the cache.
    const runtime2 = newRuntime(true);
    const tx2 = runtime2.edit();
    try {
      const pm2 = runtime2.patternManager;
      const warm = await pm2.compilePattern(PROGRAM, { space, tx: tx2 });
      expect(pm2.getCompileCacheStats()).toEqual({ hits: 1, misses: 0 });
      // The cache-served pattern is a real, frozen pattern.
      expect(typeof warm).toBe("function");
    } finally {
      await tx2.commit();
      await runtime2.dispose();
    }
  });

  it("does not use the cache when CFC enforcement is disabled", async () => {
    const disabled = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      experimental: { esmModuleLoader: true },
      cfcEnforcementMode: "disabled",
    });
    const dtx = disabled.edit();
    try {
      const pm = disabled.patternManager;
      const compiled = await pm.compilePattern(PROGRAM, { space, tx: dtx });
      await pm.flushCompileCacheWrites();
      // Cache path is skipped entirely → no hit/miss bookkeeping.
      expect(pm.getCompileCacheStats()).toEqual({ hits: 0, misses: 0 });
      expect(typeof compiled).toBe("function");
    } finally {
      await dtx.commit();
      await disabled.dispose();
    }
  });
});
