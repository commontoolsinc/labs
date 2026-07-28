import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import {
  computeModuleHashes,
  resolveModuleImports,
} from "../src/harness/module-identity.ts";
import type { CacheableModule, RuntimeProgram } from "../src/harness/types.ts";
import {
  loadCompiledClosure,
  loadSourceClosure,
  loadVerifiedSourceClosure,
  planCompileCacheWriteChunks,
  verifySourceDocs,
  writeSourceAndCompiledDocs,
} from "../src/compilation-cache/cell-cache.ts";
import { ensureCompilerStack } from "../src/harness/deferred-compiler-stack.ts";

// These tests drive the sync parse internals directly (below the async flow
// boundaries that normally load the deferred compiler stack), so load it here.
await ensureCompilerStack();

const signer = await Identity.fromPassphrase("incremental writeback test");

// A small multi-module program (same synthesis idiom as cell-cache.test.ts):
// /main.tsx -> /util.ts -> (none), /main.tsx -> /types.ts.
const PROGRAM = {
  main: "/main.tsx",
  files: [
    {
      name: "/main.tsx",
      contents: [
        `import { helper } from "./util.ts";`,
        `import type { Thing } from "./types.ts";`,
        `export const run = (t: Thing) => helper(t.n);`,
      ].join("\n"),
    },
    {
      name: "/util.ts",
      contents: `export const helper = (n: number) => n + 1;`,
    },
    { name: "/types.ts", contents: `export interface Thing { n: number; }` },
  ],
};

/** Synthesize the engine's `CacheableModule[]` from an authored program. */
function toModules(
  program: RuntimeProgram,
): { modules: CacheableModule[]; entryIdentity: string } {
  const ids = computeModuleHashes(program);
  const edges = resolveModuleImports(program);
  const modules = program.files.map((f) => ({
    identity: ids.get(f.name)!,
    filename: f.name,
    source: f.contents,
    js: `/* compiled */ ${f.name}`,
    imports: (edges.get(f.name)?.internalDeps ?? []).map((d) => ({
      specifier: d.specifier,
      targetIdentity: ids.get(d.target)!,
    })),
  }));
  return { modules, entryIdentity: ids.get(program.main)! };
}

/** A module no import edge reaches (the injected-helper shape). */
function isolatedModule(): CacheableModule {
  return {
    identity: computeModuleHashes({
      main: "/iso.ts",
      files: [{ name: "/iso.ts", contents: "export const iso = 1;" }],
    }).get("/iso.ts")!,
    filename: "/iso.ts",
    source: "export const iso = 1;",
    js: "/* compiled */ /iso.ts",
    imports: [],
  };
}

describe("planCompileCacheWriteChunks", () => {
  it("covers every module exactly once, bounded chunks, entry last", () => {
    const { modules, entryIdentity } = toModules(PROGRAM);
    const { chunks, extraRoots } = planCompileCacheWriteChunks(
      modules,
      entryIdentity,
      1,
    );
    expect(extraRoots).toEqual([]);
    expect(chunks.length).toBe(3);
    for (const chunk of chunks) expect(chunk.length).toBe(1);
    const flat = chunks.flat();
    expect(new Set(flat.map((m) => m.identity)).size).toBe(modules.length);
    // Dependencies first, the entry module in the final chunk.
    const last = chunks[chunks.length - 1]!;
    expect(last[last.length - 1]!.identity).toBe(entryIdentity);
  });

  it("keeps a small closure in a single chunk (pre-chunking behavior)", () => {
    const { modules, entryIdentity } = toModules(PROGRAM);
    const { chunks } = planCompileCacheWriteChunks(modules, entryIdentity, 8);
    expect(chunks.length).toBe(1);
    expect(chunks[0]!.length).toBe(modules.length);
  });

  it("computes extraRoots over the full set and orders them before the entry", () => {
    const { modules, entryIdentity } = toModules(PROGRAM);
    const iso = isolatedModule();
    const { chunks, extraRoots } = planCompileCacheWriteChunks(
      [...modules, iso],
      entryIdentity,
      1,
    );
    expect(extraRoots).toEqual([iso.identity]);
    const order = chunks.flat().map((m) => m.identity);
    expect(order.length).toBe(modules.length + 1);
    // The unreachable root is durable before the entry doc that links it.
    expect(order.indexOf(iso.identity)).toBeLessThan(
      order.indexOf(entryIdentity),
    );
    expect(order[order.length - 1]).toBe(entryIdentity);
  });

  it("rejects a non-positive chunk size", () => {
    const { modules, entryIdentity } = toModules(PROGRAM);
    expect(() => planCompileCacheWriteChunks(modules, entryIdentity, 0))
      .toThrow();
  });
});

describe("chunked compile-cache write-back (interruption survivability)", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  const space = signer.did();
  const RTVER = "rt-incremental-test-1";
  const opts = () => ({ runtimeVersion: RTVER });

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      cfcEnforcementMode: "enforce-explicit",
      trustSnapshotProvider: () => ({
        id: "incremental-writeback-test",
        actingPrincipal: signer.did(),
      }),
    });
  });
  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  /** Commit one chunk in its own transaction (the write-back's unit). */
  async function commitChunk(
    chunk: CacheableModule[],
    entryIdentity: string,
    extraRoots: readonly string[],
  ): Promise<void> {
    const tx = runtime.edit();
    writeSourceAndCompiledDocs(
      runtime,
      space,
      chunk,
      entryIdentity,
      { ...opts(), extraRoots },
      tx,
    );
    tx.prepareCfc();
    const { error } = await tx.commit();
    expect(error).toBeUndefined();
  }

  it("a committed chunk prefix is a cache miss, never a corrupt closure; a rerun converges", async () => {
    const { modules, entryIdentity } = toModules(PROGRAM);
    const { chunks, extraRoots } = planCompileCacheWriteChunks(
      modules,
      entryIdentity,
      1,
    );
    expect(chunks.length).toBeGreaterThan(1);

    // Session 1 dies after its first chunk committed: dependencies only,
    // no entry doc.
    await commitChunk(chunks[0]!, entryIdentity, extraRoots);

    // Fail-closed on the partial prefix: both closure loaders treat it as a
    // plain cache miss (no entry doc), not as a readable-but-wrong closure.
    const missTx = runtime.edit();
    const compiledMiss = await loadCompiledClosure(
      runtime,
      space,
      entryIdentity,
      opts(),
      missTx,
    );
    expect(compiledMiss.size).toBe(0);
    const sourceMiss = await loadVerifiedSourceClosure(
      runtime,
      space,
      entryIdentity,
      missTx,
    );
    expect(sourceMiss).toBeUndefined();
    missTx.abort?.();

    // Session 2 re-runs the full chunked write-back over the durable prefix
    // (the already-written docs re-diff to their existing values).
    for (const chunk of chunks) {
      await commitChunk(chunk, entryIdentity, extraRoots);
    }

    // The closure is now complete, link-reachable, and self-verifying.
    const tx = runtime.edit();
    const compiled = await loadCompiledClosure(
      runtime,
      space,
      entryIdentity,
      opts(),
      tx,
    );
    expect(compiled.size).toBe(modules.length);
    for (const module of modules) {
      expect(compiled.get(module.identity)?.code).toBe(module.js);
    }
    const source = (await loadSourceClosure(
      runtime,
      space,
      entryIdentity,
      tx,
    ))!;
    expect(source.size).toBe(modules.length);
    expect(verifySourceDocs(entryIdentity, source).ok).toBe(true);
    tx.abort?.();
  });

  it("chunked writes preserve the entry's synthetic root links to unreachable modules", async () => {
    const { modules, entryIdentity } = toModules(PROGRAM);
    const iso = isolatedModule();
    const all = [...modules, iso];
    const { chunks, extraRoots } = planCompileCacheWriteChunks(
      all,
      entryIdentity,
      1,
    );
    for (const chunk of chunks) {
      await commitChunk(chunk, entryIdentity, extraRoots);
    }

    // The link-following loaders reach the isolated module through the entry
    // doc's root link even though it was written in a different transaction
    // than the entry.
    const tx = runtime.edit();
    const compiled = await loadCompiledClosure(
      runtime,
      space,
      entryIdentity,
      opts(),
      tx,
    );
    expect(compiled.size).toBe(all.length);
    expect(compiled.get(iso.identity)?.code).toBe(iso.js);
    const source = (await loadSourceClosure(
      runtime,
      space,
      entryIdentity,
      tx,
    ))!;
    expect(source.has(iso.identity)).toBe(true);
    tx.abort?.();
  });
});
