import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import type { ModuleByteCache } from "../src/runtime.ts";
import type {
  CompiledModuleArtifact,
  RuntimeProgram,
} from "../src/harness/types.ts";
import {
  getCompileCacheRuntimeVersion,
  loadCompiledClosure,
  setCompileCacheRuntimeVersionForTesting,
} from "../src/compilation-cache/cell-cache.ts";

const signer = await Identity.fromPassphrase("module byte cache test");
const resolvedRuntimeVersion = await getCompileCacheRuntimeVersion();
if (resolvedRuntimeVersion === undefined) {
  throw new Error("compile-cache runtime version unavailable in Deno test");
}
const runtimeVersion = resolvedRuntimeVersion;

// Minimal in-memory cache implementing the injection interface — enough to
// exercise the runtime's consult/populate behavior. The real implementation
// (eviction, disk persistence) lives in test code outside the runtime and is
// tested there.
class FakeByteCache implements ModuleByteCache {
  gets = 0;
  puts = 0;
  private readonly m = new Map<string, CompiledModuleArtifact>();
  getCompleteSet(
    rt: string,
    ids: readonly string[],
  ): Map<string, CompiledModuleArtifact> | undefined {
    this.gets++;
    const out = new Map<string, CompiledModuleArtifact>();
    for (const id of ids) {
      const a = this.m.get(`${rt}\0${id}`);
      if (a === undefined) return undefined;
      out.set(id, a);
    }
    return out;
  }
  putAll(
    rt: string,
    mods: readonly { identity: string; js: string; sourceMap?: unknown }[],
  ): void {
    this.puts++;
    for (const x of mods) {
      this.m.set(
        `${rt}\0${x.identity}`,
        x.sourceMap === undefined
          ? { js: x.js }
          : { js: x.js, sourceMap: x.sourceMap },
      );
    }
  }
}

// A shared module-byte cache lets a fresh runtime compiling into a fresh space
// reuse another runtime's compiled module bytes (cross-runtime, cross-space).
describe("ModuleByteCache cross-runtime reuse", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;

  const PROGRAM: RuntimeProgram = {
    main: "/main.tsx",
    files: [
      { name: "/util.ts", contents: "export const square=(x:number)=>x*x;" },
      {
        name: "/main.tsx",
        contents: [
          "import { pattern, lift } from 'commonfabric';",
          "import { square } from './util.ts';",
          "const sq = lift((x:number)=>square(x));",
          "export default pattern<{ value: number }>(({ value }) => {",
          "  return { result: sq(value) };",
          "});",
        ].join("\n"),
      },
    ],
  };

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
  });
  afterEach(async () => {
    await storageManager?.close();
  });

  const runtimeIn = (byteCache?: ModuleByteCache) =>
    new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      moduleByteCache: byteCache,
    });

  it("skips the injected byte cache when the runtime version is unavailable", async () => {
    const restoreRuntimeVersion = setCompileCacheRuntimeVersionForTesting(
      undefined,
    );
    const byteCache = new FakeByteCache();
    const rt = runtimeIn(byteCache);

    try {
      const result = await rt.patternManager.compileAndRegisterModules({
        main: "/main.tsx",
        files: [{
          name: "/main.tsx",
          contents: "export const answer = 42;\nexport default answer;",
        }],
      });

      expect((result.main as { answer: number }).answer).toBe(42);
      expect(byteCache.gets).toBe(0);
      expect(byteCache.puts).toBe(0);
    } finally {
      restoreRuntimeVersion();
      await rt.dispose();
    }
  });

  it("a fresh runtime + fresh space process-hits and persists the closure", async () => {
    const byteCache = new FakeByteCache();
    const spaceA = (await Identity.fromPassphrase("byte-cache space A")).did();
    const spaceB = (await Identity.fromPassphrase("byte-cache space B")).did();

    // Runtime A compiles into space A: cold miss, populates the byte cache.
    const rtA = runtimeIn(byteCache);
    const txA = rtA.edit();
    let entryIdentity: string;
    try {
      const cold = await rtA.patternManager.compilePattern(PROGRAM, {
        space: spaceA,
        tx: txA,
      });
      await rtA.patternManager.flushCompileCacheWrites();
      expect(rtA.patternManager.getCompileCacheStats()).toEqual({
        hits: 0,
        misses: 1,
        byIdentityHits: 0,
      });
      entryIdentity = rtA.patternManager.getArtifactEntryRef(cold)!.identity;
      await txA.commit();
    } finally {
      await rtA.dispose();
    }

    // Runtime B (fresh runtime) compiles the SAME program into space B (fresh,
    // empty space). The per-space cache in B is empty, but the shared byte cache
    // serves every module → a hit, no TS recompile.
    const rtB = runtimeIn(byteCache);
    let txB = rtB.edit();
    try {
      const warm = await rtB.patternManager.compilePattern(PROGRAM, {
        space: spaceB,
        tx: txB,
      });
      await rtB.patternManager.flushCompileCacheWrites();
      expect(rtB.patternManager.getCompileCacheStats()).toEqual({
        hits: 1,
        misses: 0,
        byIdentityHits: 0,
      });
      await txB.commit();

      // The closure was written back into space B, so a by-identity reload from
      // B works (the byte-cache hit did not skip per-space persistence).
      const readTx = rtB.edit();
      const inB = await loadCompiledClosure(
        rtB,
        spaceB,
        entryIdentity,
        { runtimeVersion },
        readTx,
      );
      readTx.abort?.();
      expect(inB.has(entryIdentity)).toBe(true);

      // The byte-cache hit took the trusted-bytes path (SES re-verification
      // skipped), so prove it yields a WORKING pattern, not just a durable
      // closure: run the warm-compiled pattern and check it computes.
      // PROGRAM returns `{ result: square(value) }`, so value 7 → 49.
      txB = rtB.edit();
      const resultCell = rtB.getCell<{ result: number }>(
        spaceB,
        "warm-run",
        undefined,
        txB,
      );
      const result = rtB.run(txB, warm, { value: 7 }, resultCell);
      await txB.commit();
      await result.pull();
      expect(result.getAsQueryResult()).toEqual({ result: 49 });
    } finally {
      await rtB.dispose();
    }
  });

  it("without a shared byte cache the fresh-space compile is a cold miss", async () => {
    const spaceA = (await Identity.fromPassphrase("no-cache space A")).did();
    const spaceB = (await Identity.fromPassphrase("no-cache space B")).did();

    const rtA = runtimeIn(undefined);
    const txA = rtA.edit();
    try {
      await rtA.patternManager.compilePattern(PROGRAM, {
        space: spaceA,
        tx: txA,
      });
      await rtA.patternManager.flushCompileCacheWrites();
      await txA.commit();
    } finally {
      await rtA.dispose();
    }

    const rtB = runtimeIn(undefined);
    const txB = rtB.edit();
    try {
      await rtB.patternManager.compilePattern(PROGRAM, {
        space: spaceB,
        tx: txB,
      });
      // Fresh runtime, fresh empty space, no shared bytes → cold compile.
      expect(rtB.patternManager.getCompileCacheStats()).toEqual({
        hits: 0,
        misses: 1,
        byIdentityHits: 0,
      });
      await txB.commit();
    } finally {
      await rtB.dispose();
    }
  });
});
