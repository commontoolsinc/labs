import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";

import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { compileAndSavePattern } from "../src/piece-helpers.ts";
import {
  COMPILE_CACHE_RUNTIME_VERSION,
  loadCompiledClosure,
} from "../src/compilation-cache/cell-cache.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";

const signer = await Identity.fromPassphrase("compile-and-save-identity");
const space = signer.did();

// Regression (CT-1623): the piece save path (compileAndSavePattern, used by
// `cf piece new/setsrc`) must associate the pattern's content-addressed
// {identity, symbol} ref — with the REAL export symbol — and write the compiled
// cache into the target space. Previously it compiled with no cacheCtx, so the
// save side never learned an entryIdentity while the (cache-backed) load side
// did; with a non-default mainExport the reload used the wrong symbol and the
// pattern-change watcher never converged (cf piece setsrc hung under the ESM
// loader once flipped on by default).
describe("compileAndSavePattern associates the content-addressed identity", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      experimental: { esmModuleLoader: true },
    });
  });
  afterEach(async () => {
    await runtime?.patternManager.flushCompileCacheWrites();
    await runtime?.dispose();
    await storageManager?.close();
  });

  // A pattern exported under a NON-default name — the case that broke.
  const NAMED: RuntimeProgram = {
    main: "/main.tsx",
    mainExport: "customPatternExport",
    files: [
      {
        name: "/main.tsx",
        contents: [
          "import { pattern, lift } from 'commonfabric';",
          "const dbl = lift((x:number)=>x*2);",
          "export const customPatternExport = pattern<{ value: number }>(",
          "  ({ value }) => ({ result: dbl(value) }),",
          ");",
        ].join("\n"),
      },
    ],
  };

  it("records {identity, symbol} with the real export name (not 'default')", async () => {
    const pattern = await compileAndSavePattern(runtime, NAMED, { space });

    const ref = runtime.patternManager.getPatternEntryRef(pattern);
    expect(ref).toBeDefined();
    expect(ref!.symbol).toBe("customPatternExport");
    expect(typeof ref!.identity).toBe("string");
    expect(ref!.identity.length).toBeGreaterThan(0);
  });

  it("writes the compiled cache into the target space (cache-backed save)", async () => {
    const pattern = await compileAndSavePattern(runtime, NAMED, { space });
    const ref = runtime.patternManager.getPatternEntryRef(pattern)!;
    await runtime.patternManager.flushCompileCacheWrites();

    const readTx = runtime.edit();
    const closure = await loadCompiledClosure(
      runtime,
      space,
      ref.identity,
      {
        runtimeVersion: COMPILE_CACHE_RUNTIME_VERSION,
        compilerDid: runtime.userIdentityDID,
      },
      readTx,
    );
    readTx.abort?.("read complete");
    // The save path populated the compiled closure, so the daemon's reload can
    // hit the by-identity fast path instead of churning.
    expect(closure.has(ref.identity)).toBe(true);
  });
});
