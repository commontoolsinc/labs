import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import type { Engine } from "../src/harness/engine.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import type {
  CommitError,
  IExtendedStorageTransaction,
} from "../src/storage/interface.ts";
import {
  COMPILE_CACHE_RUNTIME_VERSION,
  loadCompiledClosure,
  loadVerifiedSourceClosure,
  writeSourceDocs,
} from "../src/compilation-cache/cell-cache.ts";

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

  const newRuntime = () =>
    new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = newRuntime();
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

    // Cold compile (miss): evaluates correctly and durably writes back before
    // returning.
    const cold = await pm.compilePattern(PROGRAM, { space, tx });
    expect(await run(cold, 3)).toEqual({ result: 6 });
    expect(pm.getCompileCacheStats()).toEqual({
      hits: 0,
      misses: 1,
      byIdentityHits: 0,
    });

    // The write-back is awaited by compilePattern; flushing remains harmless and
    // keeps the test aligned with other cache paths.
    await pm.flushCompileCacheWrites();

    // Warm compile (hit): served from the cache, still evaluates correctly.
    const warm = await pm.compilePattern(PROGRAM, { space, tx });
    expect(pm.getCompileCacheStats()).toEqual({
      hits: 1,
      misses: 1,
      byIdentityHits: 0,
    });
    expect(await run(warm, 5)).toEqual({ result: 10 });
  });

  it("warm load BY IDENTITY skips resolve+compile entirely", async () => {
    const pm = runtime.patternManager;
    // Cold compile to populate the cache + learn the entry identity.
    await pm.compilePattern(PROGRAM, { space, tx });
    await pm.flushCompileCacheWrites();
    const { entryIdentity } = await (runtime.harness as Engine)
      .compileToRecordGraph(PROGRAM);

    // Load again WITH the known entry identity → resolve-free fast path.
    const warm = await pm.compilePattern(PROGRAM, {
      space,
      tx,
      knownEntryIdentity: entryIdentity,
    });
    const stats = pm.getCompileCacheStats();
    expect(stats.byIdentityHits).toBe(1);
    expect(stats.misses).toBe(1); // only the initial cold compile
    expect(await run(warm, 6)).toEqual({ result: 12 });
  });

  it("surfaces cold writeback failure instead of returning an unloadable pattern", async () => {
    const originalEditWithRetry = runtime.editWithRetry.bind(runtime);
    const failure = {
      name: "StorageTransactionAborted" as const,
      message: "forced compile cache writeback failure",
      reason: "synthetic writeback failure",
    } satisfies CommitError;

    runtime.editWithRetry =
      (() =>
        Promise.resolve({ error: failure })) as typeof runtime.editWithRetry;

    try {
      let thrown: unknown;
      try {
        await runtime.patternManager.compilePattern(PROGRAM, { space, tx });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toContain(
        "forced compile cache writeback failure",
      );
      expect((thrown as Error & { cause?: unknown }).cause).toBe(failure);
    } finally {
      runtime.editWithRetry = originalEditWithRetry;
    }
  });

  it("keeps source-free identity recovery best-effort when writeback fails", async () => {
    const compiled = await (runtime.harness as Engine).compileToRecordGraph(
      PROGRAM,
    );
    const sourceTx = runtime.edit();
    writeSourceDocs(
      runtime,
      space,
      compiled.modules,
      compiled.entryIdentity,
      sourceTx,
    );
    runtime.prepareTxForCommit(sourceTx);
    expect((await sourceTx.commit()).error).toBeUndefined();

    const runtime2 = newRuntime();
    const originalEditWithRetry = runtime2.editWithRetry.bind(runtime2);
    const failure = {
      name: "StorageTransactionAborted" as const,
      message: "forced identity recovery writeback failure",
      reason: "synthetic background writeback failure",
    } satisfies CommitError;
    runtime2.editWithRetry =
      (() =>
        Promise.resolve({ error: failure })) as typeof runtime2.editWithRetry;

    try {
      const loaded = await runtime2.patternManager.loadPatternByIdentity(
        compiled.entryIdentity,
        "default",
        space,
      );
      expect(typeof loaded).toBe("function");
      await runtime2.patternManager.flushCompileCacheWrites();
    } finally {
      runtime2.editWithRetry = originalEditWithRetry;
      await runtime2.dispose();
    }
  });

  it("warm hit reuses the cached body across a fresh runtime (cross-session)", async () => {
    // Session 1: cold compile + write-back.
    const pm1 = runtime.patternManager;
    await pm1.compilePattern(PROGRAM, { space, tx });
    await pm1.flushCompileCacheWrites();
    expect(pm1.getCompileCacheStats().misses).toBe(1);
    await tx.commit();

    // Session 2: a brand-new runtime on the same storage warms from the cache.
    const runtime2 = newRuntime();
    const tx2 = runtime2.edit();
    try {
      const pm2 = runtime2.patternManager;
      const warm = await pm2.compilePattern(PROGRAM, { space, tx: tx2 });
      expect(pm2.getCompileCacheStats()).toEqual({
        hits: 1,
        misses: 0,
        byIdentityHits: 0,
      });
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
      cfcEnforcementMode: "disabled",
    });
    const dtx = disabled.edit();
    try {
      const pm = disabled.patternManager;
      const compiled = await pm.compilePattern(PROGRAM, { space, tx: dtx });
      await pm.flushCompileCacheWrites();
      // Cache path is skipped entirely → no hit/miss bookkeeping.
      expect(pm.getCompileCacheStats()).toEqual({
        hits: 0,
        misses: 0,
        byIdentityHits: 0,
      });
      expect(typeof compiled).toBe("function");
    } finally {
      await dtx.commit();
      await disabled.dispose();
    }
  });
});

// Step 4.4 (required): a pattern compiled bound to space B writes its source +
// compiled docs into B (not the ambient space A), the link closure resolves in
// B, and the compiled docs carry the required integrity. This is exactly the
// per-space routing `PatternFactory.inSpace(B)` relies on: instantiating a child
// in space B loads it via `loadPattern(id, rootCell.space === B)`, whose core is
// `compilePattern(source, { space: B })`.
describe("ESM compile cache — Pattern.inSpace A → B routing", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  const spaceA = signer.did();

  const PROGRAM: RuntimeProgram = {
    main: "/main.tsx",
    files: [
      { name: "/util.ts", contents: "export const triple = (x:number)=>x*3;" },
      {
        name: "/main.tsx",
        contents: [
          "import { pattern, lift } from 'commonfabric';",
          "import { triple } from './util.ts';",
          "const t = lift((x:number)=>triple(x));",
          "export default pattern<{ value: number }>(({ value }) => {",
          "  return { result: t(value) };",
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

  it("writes source + compiled docs into the target space B, not A", async () => {
    const spaceB = (await Identity.fromPassphrase("inSpace target B")).did();
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    const tx = runtime.edit();
    const cacheOpts = {
      runtimeVersion: COMPILE_CACHE_RUNTIME_VERSION,
    };
    try {
      // The entry identity is loader-internal; recover it via a no-cache compile.
      const { entryIdentity } = await (runtime.harness as Engine)
        .compileToRecordGraph(PROGRAM);

      const pm = runtime.patternManager;
      await pm.compilePattern(PROGRAM, { space: spaceB, tx });
      await pm.flushCompileCacheWrites();

      const readTx = runtime.edit();
      // Compiled docs landed in B: full, integrity-valid closure.
      const inB = await loadCompiledClosure(
        runtime,
        spaceB,
        entryIdentity,
        cacheOpts,
        readTx,
      );
      expect(inB.size).toBeGreaterThanOrEqual(2);
      expect(inB.has(entryIdentity)).toBe(true);

      // Source closure resolves + graph-wiring-verifies in B.
      const srcB = await loadVerifiedSourceClosure(
        runtime,
        spaceB,
        entryIdentity,
        readTx,
      );
      expect(srcB?.has(entryIdentity)).toBe(true);

      // Nothing leaked into the ambient space A.
      const inA = await loadCompiledClosure(
        runtime,
        spaceA,
        entryIdentity,
        cacheOpts,
        readTx,
      );
      expect(inA.size).toBe(0);
      readTx.abort?.();
    } finally {
      await tx.commit();
      await runtime.dispose();
    }
  });

  it("a fresh runtime warm-hits from space B (cross-session, per space)", async () => {
    const spaceB = (await Identity.fromPassphrase("inSpace target B2")).did();
    // Session 1: compile bound to B, write back, flush to storage.
    const rt1 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    const tx1 = rt1.edit();
    let rt2: Runtime | undefined;
    try {
      await rt1.patternManager.compilePattern(PROGRAM, {
        space: spaceB,
        tx: tx1,
      });
      await rt1.patternManager.flushCompileCacheWrites();
      await tx1.commit();
      await rt1.storageManager.synced();

      // Session 2: fresh runtime, same storage → warm hit when loading into B.
      rt2 = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
      });
      const tx2 = rt2.edit();
      await rt2.patternManager.compilePattern(PROGRAM, {
        space: spaceB,
        tx: tx2,
      });
      expect(rt2.patternManager.getCompileCacheStats()).toEqual({
        hits: 1,
        misses: 0,
        byIdentityHits: 0,
      });
      await tx2.commit();
    } finally {
      await rt2?.dispose();
      await rt1.dispose();
    }
  });
});
