import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import type { Options } from "../src/storage/v2.ts";
import { Runtime } from "../src/runtime.ts";
import {
  computeModuleHashes,
  resolveModuleImports,
} from "../src/harness/module-identity.ts";
import type { CacheableModule, RuntimeProgram } from "../src/harness/types.ts";

import {
  buildSourceDocs,
  COMPILED_INTEGRITY_ATOM,
  compiledDocKey,
  compiledDocWriteSchema,
  getCompileCacheRuntimeVersion,
  loadCompiledClosure,
  loadSourceClosure,
  loadVerifiedSourceClosure,
  ROOT_LINK_SPECIFIER,
  sourceDocKey,
  verifySourceDocs,
  writeCompiledDocs,
  writeSourceDocs,
} from "../src/compilation-cache/cell-cache.ts";
import { TEST_MEMORY_SERVER_AUTH } from "./memory-v2-test-utils.ts";

// ---------------------------------------------------------------------------
// Shared-server helper: two managers with DIFFERENT signers over ONE in-process
// memory server. Modelled after cross-space-value-read.test.ts. The shared
// server is closed once by the test's afterEach — each manager's override()
// returns the same instance without the base class closing it twice.
// ---------------------------------------------------------------------------
class SharedServerStorageManager extends EmulatedStorageManager {
  static connectTo(
    server: MemoryV2Server.Server,
    options: Omit<Options, "memoryHost" | "spaceHostMap">,
  ): SharedServerStorageManager {
    const manager = new SharedServerStorageManager(
      { ...options, memoryHost: new URL("memory://") },
      () => server,
    );
    manager._sharedServer = server;
    return manager;
  }

  private _sharedServer!: MemoryV2Server.Server;

  protected override server(): MemoryV2Server.Server {
    return this._sharedServer;
  }
  // NOTE: super.close() checks its private `#server` field (never set by this
  // override), so closing a SharedServerStorageManager only tears down the
  // per-space client sessions — the shared server is closed once by the test.
}

const newSharedServer = () =>
  new MemoryV2Server.Server({
    authorizeSessionOpen(message) {
      const principal = (message.authorization as { principal?: unknown })
        ?.principal;
      return typeof principal === "string" ? principal : undefined;
    },
    sessionOpenAuth: TEST_MEMORY_SERVER_AUTH.sessionOpenAuth,
  });

const signer = await Identity.fromPassphrase("cell-cache test");
const resolvedRuntimeVersion = await getCompileCacheRuntimeVersion();
if (resolvedRuntimeVersion === undefined) {
  throw new Error("compile-cache runtime version unavailable in Deno test");
}
const runtimeVersion = resolvedRuntimeVersion;

// Step 4.3.1–4.3.3 — content-addressed cache document model. The cache operates
// in identity space on the engine's `CacheableModule[]`; these tests synthesize
// an equivalent module set from a small program (computing the same per-module
// identities + import edges the engine would).

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

const identityOf = (program: typeof PROGRAM, path: string) =>
  computeModuleHashes(program).get(path)!;

function fabricLinkedModules(): {
  modules: CacheableModule[];
  importerIdentity: string;
  depIdentity: string;
  fabricSpecifier: string;
} {
  const depProgram = {
    main: "/dep.ts",
    files: [
      { name: "/dep.ts", contents: "export const x = 1;" },
    ],
  };
  const depIdentity = computeModuleHashes(depProgram).get("/dep.ts")!;
  const fabricSpecifier = `cf:pattern:${depIdentity}`;
  const importerProgram = {
    main: "/main.tsx",
    files: [
      {
        name: "/main.tsx",
        contents:
          `import { x } from "${fabricSpecifier}";\nexport function y() { return x + 1; }`,
      },
    ],
  };
  const importerIdentity = computeModuleHashes(importerProgram).get(
    "/main.tsx",
  )!;
  return {
    importerIdentity,
    depIdentity,
    fabricSpecifier,
    modules: [
      {
        identity: importerIdentity,
        filename: "/main.tsx",
        source: importerProgram.files[0].contents,
        js: "/* compiled importer */",
        imports: [{ specifier: fabricSpecifier, targetIdentity: depIdentity }],
      },
      {
        identity: depIdentity,
        filename: "/dep.ts",
        source: depProgram.files[0].contents,
        js: "/* compiled dependency */",
        imports: [],
      },
    ],
  };
}

describe("cell-cache: keys", () => {
  it("formats source and compiled document keys", () => {
    expect(sourceDocKey("abc")).toBe("pattern:abc");
    expect(compiledDocKey("rt1", "abc")).toBe("compileCache:rt1/abc");
  });
});

describe("cell-cache: buildSourceDocs", () => {
  it("keys each module by its identity and records resolved import links", () => {
    const { modules, entryIdentity } = toModules(PROGRAM);
    const docs = buildSourceDocs(modules, entryIdentity);

    // One document per module, keyed by identity.
    expect(docs.size).toBe(3);

    const entry = docs.get(identityOf(PROGRAM, "/main.tsx"))!;
    expect(entry.kind).toBe("source");
    expect(entry.filename).toBe("/main.tsx");
    // Both the value import (util) and the type import (types) are linked.
    const linked = entry.imports
      .map((i) => `${i.specifier}->${i.identity}`)
      .sort();
    expect(linked).toEqual([
      `./types.ts->${identityOf(PROGRAM, "/types.ts")}`,
      `./util.ts->${identityOf(PROGRAM, "/util.ts")}`,
    ]);
  });

  it("links otherwise-unreachable modules from the entry document", () => {
    const { modules, entryIdentity } = toModules(PROGRAM);
    // Append an isolated module (like the injected cfc.ts helper): part of the
    // emitted set, but with no incoming import edge.
    const isolated: CacheableModule = {
      identity: "iso-identity",
      filename: "cfc.ts",
      source: "export {};",
      js: "/* iso */",
      imports: [],
    };
    const docs = buildSourceDocs([...modules, isolated], entryIdentity);
    const entry = docs.get(entryIdentity)!;
    // The entry now carries a synthetic root link to the isolated module.
    const rootLink = entry.imports.find((i) =>
      i.specifier === `${ROOT_LINK_SPECIFIER}iso-identity`
    );
    expect(rootLink?.identity).toBe("iso-identity");
  });
});

describe("cell-cache: verifySourceDocs (Merkle self-verification)", () => {
  it("accepts a faithfully-built closure", () => {
    const { modules, entryIdentity } = toModules(PROGRAM);
    const docs = buildSourceDocs(modules, entryIdentity);
    const v = verifySourceDocs(entryIdentity, docs);
    expect(v.ok).toBe(true);
    expect(v.entryFilename).toBe("/main.tsx");
    expect(v.mismatches).toEqual([]);
    expect(v.missing).toEqual([]);
  });

  it("flags a missing entry document", () => {
    const v = verifySourceDocs("missing-entry", new Map());
    expect(v.ok).toBe(false);
    expect(v.mismatches).toEqual([]);
    expect(v.missing).toEqual(["missing-entry"]);
  });

  it("rejects a tampered document (recomputed identity != key)", () => {
    const { modules, entryIdentity } = toModules(PROGRAM);
    const docs = new Map(buildSourceDocs(modules, entryIdentity));
    const utilIdentity = identityOf(PROGRAM, "/util.ts");
    const util = docs.get(utilIdentity)!;
    // Keep the key, change the body — content no longer hashes to its key.
    docs.set(utilIdentity, {
      ...util,
      code: `export const helper = (n) => n + 999;`,
    });

    const v = verifySourceDocs(entryIdentity, docs);
    expect(v.ok).toBe(false);
    expect(v.mismatches).toContain(utilIdentity);
  });

  it("flags a missing import-link target", () => {
    const { modules, entryIdentity } = toModules(PROGRAM);
    const docs = new Map(buildSourceDocs(modules, entryIdentity));
    docs.delete(identityOf(PROGRAM, "/util.ts"));
    const v = verifySourceDocs(entryIdentity, docs);
    expect(v.ok).toBe(false);
    expect(v.missing).toContain(identityOf(PROGRAM, "/util.ts"));
  });

  it("is entry-point independent (util identity is stable across entries)", () => {
    const viaMain = identityOf(PROGRAM, "/util.ts");
    const utilEntry = { ...PROGRAM, main: "/util.ts" };
    const viaUtil = computeModuleHashes(utilEntry).get("/util.ts")!;
    expect(viaUtil).toBe(viaMain);
  });

  it("ignores non-normative annotations (W4): annotated and unannotated docs verify identically", () => {
    const { modules, entryIdentity } = toModules(PROGRAM);
    const plain = buildSourceDocs(modules, entryIdentity);
    const plainResult = verifySourceDocs(entryIdentity, plain);
    expect(plainResult.ok).toBe(true);

    // Attach product annotations to the entry doc only — verification must hash
    // ONLY code/filename/imports, so the result is byte-for-byte identical.
    const annotated = new Map(plain);
    const entry = annotated.get(entryIdentity)!;
    annotated.set(entryIdentity, {
      ...entry,
      annotations: {
        name: { "/": "name-doc-link" },
        spec: { "/": "spec-doc-link" },
      },
    });
    const annotatedResult = verifySourceDocs(entryIdentity, annotated);

    expect(annotatedResult).toEqual(plainResult);
    expect(annotatedResult.ok).toBe(true);
    // The annotated entry's recomputed identity still equals its key.
    expect(annotatedResult.mismatches).toEqual([]);
  });
});

describe("cell-cache: source-set store (per space, link-following)", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  const spaceA = signer.did();

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({ apiUrl: new URL(import.meta.url), storageManager });
  });
  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("writes the closure and loads it back via import links", async () => {
    const { modules, entryIdentity } = toModules(PROGRAM);
    const tx = runtime.edit();
    writeSourceDocs(runtime, spaceA, modules, entryIdentity, tx);

    const loaded = (await loadSourceClosure(
      runtime,
      spaceA,
      entryIdentity,
      tx,
    ))!;

    // All three modules reached by following links from the entry.
    expect(loaded.size).toBe(3);
    expect(new Set([...loaded.values()].map((d) => d.filename))).toEqual(
      new Set(["/main.tsx", "/util.ts", "/types.ts"]),
    );
    // Loaded closure self-verifies (recomputed identities match the keys).
    expect(verifySourceDocs(entryIdentity, loaded).ok).toBe(true);
  });

  it("loads duplicate source import links once", async () => {
    const entryIdentity = "source-entry-with-duplicate-imports";
    const childIdentity = "source-duplicate-child";
    const modules: CacheableModule[] = [
      {
        identity: entryIdentity,
        filename: "/entry.ts",
        source: `import "./child.ts";\nimport "./again.ts";`,
        js: "/* compiled entry */",
        imports: [
          { specifier: "./child.ts", targetIdentity: childIdentity },
          { specifier: "./again.ts", targetIdentity: childIdentity },
        ],
      },
      {
        identity: childIdentity,
        filename: "/child.ts",
        source: `export const value = 1;`,
        js: "/* compiled child */",
        imports: [],
      },
    ];
    const tx = runtime.edit();
    writeSourceDocs(runtime, spaceA, modules, entryIdentity, tx);

    const loaded = await loadSourceClosure(
      runtime,
      spaceA,
      entryIdentity,
      tx,
    );

    expect(loaded?.size).toBe(2);
    expect(loaded?.get(entryIdentity)?.imports).toEqual([
      { specifier: "./child.ts", identity: childIdentity },
      { specifier: "./again.ts", identity: childIdentity },
    ]);
  });

  it("skips source imports that do not point to source documents", async () => {
    const entryIdentity = "source-entry-with-broken-imports";
    const missingIdentity = "source-missing-child";
    const tx = runtime.edit();
    const missingLink = runtime.getCell(
      spaceA,
      sourceDocKey(missingIdentity),
      undefined,
      tx,
    ).getAsLink();
    runtime.getCell(spaceA, sourceDocKey(entryIdentity), undefined, tx).set({
      kind: "source",
      identity: entryIdentity,
      code: `export const value = 1;`,
      filename: "/entry.ts",
      imports: [
        { specifier: "./plain.ts" },
        { specifier: "./missing.ts", link: missingLink },
      ],
    });

    const loaded = await loadSourceClosure(
      runtime,
      spaceA,
      entryIdentity,
      tx,
    );

    expect(loaded?.size).toBe(1);
    expect(loaded?.get(entryIdentity)?.imports).toEqual([]);
  });

  it("annotatePattern is non-normative (W4): the closure still verifies and the identity is unchanged", async () => {
    const { modules, entryIdentity } = toModules(PROGRAM);
    let tx = runtime.edit();
    writeSourceDocs(runtime, spaceA, modules, entryIdentity, tx);
    runtime.prepareTxForCommit(tx);
    await tx.commit();

    // Attach a product annotation to the entry source doc.
    await runtime.patternManager.annotatePattern(
      entryIdentity,
      spaceA,
      "name",
      { "/": "name-doc-link" },
    );

    tx = runtime.edit();
    // The verified closure is unaffected — annotations are excluded from the
    // content hash, so the entry's recomputed identity still equals its key.
    const verified = await loadVerifiedSourceClosure(
      runtime,
      spaceA,
      entryIdentity,
      tx,
    );
    expect(verified?.size).toBe(3);
    expect(verifySourceDocs(entryIdentity, verified!).ok).toBe(true);
    // The annotation rode along on the entry doc.
    expect(verified?.get(entryIdentity)?.annotations).toEqual({
      name: { "/": "name-doc-link" },
    });

    // A re-write of the identical source (idempotent recompile) preserves the
    // annotation rather than clobbering it.
    const rewriteTx = runtime.edit();
    writeSourceDocs(runtime, spaceA, modules, entryIdentity, rewriteTx);
    runtime.prepareTxForCommit(rewriteTx);
    await rewriteTx.commit();
    const afterRewriteTx = runtime.edit();
    const afterRewrite = await loadVerifiedSourceClosure(
      runtime,
      spaceA,
      entryIdentity,
      afterRewriteTx,
    );
    expect(afterRewrite?.get(entryIdentity)?.annotations).toEqual({
      name: { "/": "name-doc-link" },
    });
  });

  it("is empty for an entry that was never written", async () => {
    const tx = runtime.edit();
    const loaded = await loadSourceClosure(
      runtime,
      spaceA,
      "no-such-identity",
      tx,
    );
    expect(loaded).toBe(undefined);
  });

  it("loadVerifiedSourceClosure returns a faithful closure but rejects a tampered one", async () => {
    const { modules, entryIdentity } = toModules(PROGRAM);
    const tx = runtime.edit();
    writeSourceDocs(runtime, spaceA, modules, entryIdentity, tx);

    // Happy path: the written closure graph-wiring-verifies.
    const ok = await loadVerifiedSourceClosure(
      runtime,
      spaceA,
      entryIdentity,
      tx,
    );
    expect(ok?.size).toBe(3);

    // Tamper util's stored source (keep its key) → recomputed identity diverges.
    const utilIdentity = identityOf(PROGRAM, "/util.ts");
    runtime.getCell(spaceA, sourceDocKey(utilIdentity), undefined, tx).set({
      kind: "source",
      identity: utilIdentity,
      code: "export const helper = (n) => n + 999;",
      filename: "/util.ts",
      imports: [],
    });
    const tampered = await loadVerifiedSourceClosure(
      runtime,
      spaceA,
      entryIdentity,
      tx,
    );
    expect(tampered).toBe(undefined);
  });

  it("does not store fabric imports as source links", async () => {
    const { modules, importerIdentity, fabricSpecifier } =
      fabricLinkedModules();
    const tx = runtime.edit();
    writeSourceDocs(runtime, spaceA, modules, importerIdentity, tx);

    const loaded = await loadVerifiedSourceClosure(
      runtime,
      spaceA,
      importerIdentity,
      tx,
    );

    expect(loaded?.size).toBe(1);
    const importer = loaded?.get(importerIdentity);
    expect(importer?.imports.map((imp) => imp.specifier)).not.toContain(
      fabricSpecifier,
    );
  });
});

describe("cell-cache: compiled-set store (CFC integrity, fail-closed)", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  const spaceA = signer.did();
  const RTVER = "rt-test-1";

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      cfcEnforcementMode: "enforce-explicit",
      trustSnapshotProvider: () => ({
        id: "cell-cache-test",
        actingPrincipal: signer.did(),
      }),
    });
  });
  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  const opts = () => ({ runtimeVersion: RTVER });

  it("writes compiled docs with integrity and loads them back (warm hit)", async () => {
    const { modules, entryIdentity } = toModules(PROGRAM);
    const wtx = runtime.edit();
    writeCompiledDocs(runtime, spaceA, modules, entryIdentity, opts(), wtx);
    wtx.prepareCfc();
    await wtx.commit();

    const rtx = runtime.edit();
    const loaded = await loadCompiledClosure(
      runtime,
      spaceA,
      entryIdentity,
      opts(),
      rtx,
    );
    rtx.abort?.();

    expect(loaded.size).toBe(3);
    const main = loaded.get(entryIdentity)!;
    expect(main.code).toBe("/* compiled */ /main.tsx");
    expect(new Set([...loaded.values()].map((d) => d.filename))).toEqual(
      new Set(["/main.tsx", "/util.ts", "/types.ts"]),
    );
  });

  it("loads duplicate compiled import links once", async () => {
    const entryIdentity = "compiled-entry-with-duplicate-imports";
    const childIdentity = "compiled-duplicate-child";
    const modules: CacheableModule[] = [
      {
        identity: entryIdentity,
        filename: "/entry.ts",
        source: `import "./child.ts";\nimport "./again.ts";`,
        js: "/* compiled entry */",
        imports: [
          { specifier: "./child.ts", targetIdentity: childIdentity },
          { specifier: "./again.ts", targetIdentity: childIdentity },
        ],
      },
      {
        identity: childIdentity,
        filename: "/child.ts",
        source: `export const value = 1;`,
        js: "/* compiled child */",
        imports: [],
      },
    ];
    const wtx = runtime.edit();
    writeCompiledDocs(runtime, spaceA, modules, entryIdentity, opts(), wtx);
    wtx.prepareCfc();
    await wtx.commit();

    const rtx = runtime.edit();
    const loaded = await loadCompiledClosure(
      runtime,
      spaceA,
      entryIdentity,
      opts(),
      rtx,
    );
    rtx.abort?.();

    expect(loaded.size).toBe(2);
    expect(loaded.get(entryIdentity)?.imports).toEqual([
      { specifier: "./child.ts", identity: childIdentity },
      { specifier: "./again.ts", identity: childIdentity },
    ]);
  });

  it("skips compiled import links without integrity", async () => {
    const entryIdentity = "compiled-entry-with-unstamped-import";
    const missingIdentity = "compiled-unstamped-child";
    const modules: CacheableModule[] = [
      {
        identity: entryIdentity,
        filename: "/entry.ts",
        source: `import "./missing.ts";`,
        js: "/* compiled entry */",
        imports: [
          { specifier: "./missing.ts", targetIdentity: missingIdentity },
        ],
      },
    ];
    const wtx = runtime.edit();
    writeCompiledDocs(runtime, spaceA, modules, entryIdentity, opts(), wtx);
    wtx.prepareCfc();
    await wtx.commit();

    const rtx = runtime.edit();
    const loaded = await loadCompiledClosure(
      runtime,
      spaceA,
      entryIdentity,
      opts(),
      rtx,
    );
    rtx.abort?.();

    expect(loaded.size).toBe(1);
    expect(loaded.get(entryIdentity)?.imports).toEqual([]);
  });

  it("skips compiled imports that do not carry links", async () => {
    const entryIdentity = "compiled-entry-with-missing-link";
    const wtx = runtime.edit();
    const previousIdentity = wtx.getCfcState().implementationIdentity;
    wtx.setCfcImplementationIdentity({
      kind: "builtin",
      builtinId: "compile-cache",
    });
    try {
      runtime.getCell(
        spaceA,
        compiledDocKey(RTVER, entryIdentity),
        compiledDocWriteSchema(),
        wtx,
      ).set({
        kind: "compiled",
        identity: entryIdentity,
        code: "/* compiled entry */",
        filename: "/entry.ts",
        imports: [
          { specifier: "./plain.ts" },
        ],
      });
    } finally {
      wtx.setCfcImplementationIdentity(previousIdentity);
    }
    wtx.prepareCfc();
    await wtx.commit();

    const rtx = runtime.edit();
    const loaded = await loadCompiledClosure(
      runtime,
      spaceA,
      entryIdentity,
      opts(),
      rtx,
    );
    rtx.abort?.();

    expect(loaded.size).toBe(1);
    expect(loaded.get(entryIdentity)?.imports).toEqual([]);
  });

  it("reaches an otherwise-unreachable module via the entry root link", async () => {
    const { modules, entryIdentity } = toModules(PROGRAM);
    const isolated: CacheableModule = {
      identity: "iso-compiled-identity",
      filename: "cfc.ts",
      source: "export {};",
      js: "/* iso compiled */",
      imports: [],
    };
    const wtx = runtime.edit();
    writeCompiledDocs(
      runtime,
      spaceA,
      [...modules, isolated],
      entryIdentity,
      opts(),
      wtx,
    );
    wtx.prepareCfc();
    await wtx.commit();

    const rtx = runtime.edit();
    const loaded = await loadCompiledClosure(
      runtime,
      spaceA,
      entryIdentity,
      opts(),
      rtx,
    );
    rtx.abort?.();
    // The isolated module is reached only because the entry links it.
    expect(loaded.has("iso-compiled-identity")).toBe(true);
    expect(loaded.size).toBe(4);
  });

  it("fail-closed: an unstamped compiled cell is not accepted", async () => {
    const utilIdentity = identityOf(PROGRAM, "/util.ts");
    // Write util's compiled cell PLAINLY (no addIntegrity schema → no label).
    const wtx = runtime.edit();
    runtime.getCell(spaceA, compiledDocKey(RTVER, utilIdentity), undefined, wtx)
      .set({
        kind: "compiled",
        identity: utilIdentity,
        code: "/* unstamped */",
        filename: "/util.ts",
        imports: [],
      });
    wtx.prepareCfc();
    await wtx.commit();

    // Loading util directly as the entry: present but unstamped → dropped.
    const rtx = runtime.edit();
    const loaded = await loadCompiledClosure(
      runtime,
      spaceA,
      utilIdentity,
      opts(),
      rtx,
    );
    rtx.abort?.();
    expect(loaded.size).toBe(0);
  });

  it("fail-closed: a forged cf-compiled-by stamp from a non-builtin write is stripped", async () => {
    // A write that self-attaches the compiler attestation through an authored
    // schema, WITHOUT the compile-cache builtin authoring the write (audit S4:
    // unattributed writes may not mint evidence). The atom must be stripped
    // from the persisted label, so the loader treats the doc as unstamped.
    const utilIdentity = identityOf(PROGRAM, "/util.ts");
    const forgedSchema = {
      type: "object",
      ifc: { addIntegrity: [COMPILED_INTEGRITY_ATOM] },
    } as const;
    const wtx = runtime.edit();
    runtime.getCell(
      spaceA,
      compiledDocKey(RTVER, utilIdentity),
      forgedSchema,
      wtx,
    )
      .set({
        kind: "compiled",
        identity: utilIdentity,
        code: "/* forged */",
        filename: "/util.ts",
        imports: [],
      });
    wtx.prepareCfc();
    const { error } = await wtx.commit();
    expect(error).toBe(undefined);

    const rtx = runtime.edit();
    const loaded = await loadCompiledClosure(
      runtime,
      spaceA,
      utilIdentity,
      opts(),
      rtx,
    );
    rtx.abort?.();
    expect(loaded.size).toBe(0);
  });

  it("keeps fabric imports as compiled links", async () => {
    const { modules, importerIdentity, depIdentity, fabricSpecifier } =
      fabricLinkedModules();
    const wtx = runtime.edit();
    writeCompiledDocs(runtime, spaceA, modules, importerIdentity, opts(), wtx);
    wtx.prepareCfc();
    await wtx.commit();

    const rtx = runtime.edit();
    const loaded = await loadCompiledClosure(
      runtime,
      spaceA,
      importerIdentity,
      opts(),
      rtx,
    );
    rtx.abort?.();

    expect(loaded.has(importerIdentity)).toBe(true);
    expect(loaded.has(depIdentity)).toBe(true);
    expect(loaded.get(importerIdentity)?.imports).toContainEqual({
      specifier: fabricSpecifier,
      identity: depIdentity,
    });
  });

  it("refuses to persist modules carrying unpinned fabric edges", () => {
    // An unpinned specifier folds into the module identity AS TEXT, so the
    // resolution result (the edge's target) can vary under a fixed identity —
    // persisting such a module would make cache content key-unstable.
    const { modules, importerIdentity, depIdentity } = fabricLinkedModules();
    const unpinned: CacheableModule = {
      ...modules[0],
      source:
        `import { x } from "cf:dep";\nexport function y() { return x + 1; }`,
      imports: [{ specifier: "cf:dep", targetIdentity: depIdentity }],
    };
    const wtx = runtime.edit();
    try {
      expect(() =>
        writeSourceDocs(
          runtime,
          spaceA,
          [unpinned, modules[1]],
          importerIdentity,
          wtx,
        )
      ).toThrow("unpinned fabric import 'cf:dep'");
      expect(() =>
        writeCompiledDocs(
          runtime,
          spaceA,
          [unpinned, modules[1]],
          importerIdentity,
          opts(),
          wtx,
        )
      ).toThrow("unpinned fabric import 'cf:dep'");
    } finally {
      wtx.abort?.();
    }
  });

  it("replicates fabric dependencies even though source closures exclude them", async () => {
    const spaceB = "did:key:z6MkCellCacheFabricReplicationTarget";
    const { modules, importerIdentity, depIdentity } = fabricLinkedModules();
    const replicationOpts = {
      runtimeVersion,
    };
    const wtx = runtime.edit();
    writeSourceDocs(runtime, spaceA, modules, importerIdentity, wtx);
    writeCompiledDocs(
      runtime,
      spaceA,
      modules,
      importerIdentity,
      replicationOpts,
      wtx,
    );
    wtx.prepareCfc();
    await wtx.commit();

    const manager = runtime.patternManager as unknown as {
      replicateClosures(
        entryIdentity: string,
        fromSpace: string,
        toSpace: string,
      ): Promise<void>;
    };
    await manager.replicateClosures(importerIdentity, spaceA, spaceB);

    const rtx = runtime.edit();
    const importerSource = await loadVerifiedSourceClosure(
      runtime,
      spaceB,
      importerIdentity,
      rtx,
    );
    const depSource = await loadVerifiedSourceClosure(
      runtime,
      spaceB,
      depIdentity,
      rtx,
    );
    const compiled = await loadCompiledClosure(
      runtime,
      spaceB,
      importerIdentity,
      replicationOpts,
      rtx,
    );
    rtx.abort?.();

    expect(importerSource?.has(importerIdentity)).toBe(true);
    expect(depSource?.has(depIdentity)).toBe(true);
    expect(compiled.has(importerIdentity)).toBe(true);
    expect(compiled.has(depIdentity)).toBe(true);
  });
  // Regression: before bd98e01a4, compiled docs were stamped with a per-user
  // `cf-compiled-by:<did>` atom. A second user's cold-compile writeback of the
  // SAME content into the same space was rejected by the CFC label merge
  // ("addIntegrity cannot be weakened at /") because the deployer's per-DID
  // atom was already present and could not be merged with a different user's
  // atom. The constant system-compiler atom (COMPILED_INTEGRITY_ATOM) makes
  // the cache shared: a re-write of the same content by any user merges
  // cleanly because both sides carry the identical atom.
  it("second user's writeback of the same content commits cleanly (per-user DID collision regression)", async () => {
    const { modules, entryIdentity } = toModules(PROGRAM);

    // First writer (the deployer) populates the cache.
    const wtxA = runtime.edit();
    writeCompiledDocs(
      runtime,
      spaceA,
      modules,
      entryIdentity,
      opts(),
      wtxA,
    );
    wtxA.prepareCfc();
    const a = await wtxA.commit();
    expect(a.error).toBe(undefined);

    // Second writer (another user's runtime cold-compiling the same content)
    // writes the same docs back. Same content identity, same constant atom —
    // the label merge must accept it without "addIntegrity cannot be weakened".
    const wtxB = runtime.edit();
    writeCompiledDocs(
      runtime,
      spaceA,
      modules,
      entryIdentity,
      opts(),
      wtxB,
    );
    wtxB.prepareCfc();
    const b = await wtxB.commit();
    expect(b.error?.message).toBe(undefined);

    // Any member can then warm-hit the cache.
    const rtx = runtime.edit();
    const loaded = await loadCompiledClosure(
      runtime,
      spaceA,
      entryIdentity,
      opts(),
      rtx,
    );
    rtx.abort?.();
    expect(loaded.size).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// End-to-end: two runtimes with DISTINCT user identities over shared storage
// ---------------------------------------------------------------------------

// Two distinct signers for the two "users" in the e2e describe.
// Declared at module level so top-level await applies.
const e2eSignerA = await Identity.fromPassphrase("cell-cache-e2e user A");
const e2eSignerB = await Identity.fromPassphrase("cell-cache-e2e user B");

describe("cell-cache: two-identity shared-space compile cache (e2e)", () => {
  // The shared compile-cache space — owned by signerA (its DID is the address).
  const sharedSpace = e2eSignerA.did();
  const RTVER = runtimeVersion;

  // Minimal two-file program for the e2e compile cycle.
  const E2E_PROGRAM: RuntimeProgram = {
    main: "/main.tsx",
    files: [
      { name: "/util.ts", contents: "export const triple = (x:number)=>x*3;" },
      {
        name: "/main.tsx",
        contents: [
          "import { pattern, lift } from 'commonfabric';",
          "import { triple } from './util.ts';",
          "const t = lift((x:number)=>triple(x));",
          "export default pattern<{ value: number }>(({ value }) => ({ result: t(value) }));",
        ].join("\n"),
      },
    ],
  };

  let server: MemoryV2Server.Server;
  let smA: SharedServerStorageManager;
  let smB: SharedServerStorageManager;
  let rtA: Runtime;
  let rtB: Runtime;

  beforeEach(() => {
    server = newSharedServer();
    smA = SharedServerStorageManager.connectTo(server, { as: e2eSignerA });
    smB = SharedServerStorageManager.connectTo(server, { as: e2eSignerB });
    rtA = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: smA,
      cfcEnforcementMode: "enforce-explicit",
      trustSnapshotProvider: () => ({
        id: "e2e-user-a",
        actingPrincipal: e2eSignerA.did(),
      }),
    });
    rtB = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: smB,
      cfcEnforcementMode: "enforce-explicit",
      trustSnapshotProvider: () => ({
        id: "e2e-user-b",
        actingPrincipal: e2eSignerB.did(),
      }),
    });
  });

  afterEach(async () => {
    await rtA?.dispose();
    await rtB?.dispose();
    await smA?.close();
    await smB?.close();
    await server?.close();
  });

  it("runtime B warms from A's cache write and B's cold-compile writeback commits without error", async () => {
    // --- Session A: cold compile + write-back ---
    const pmA = rtA.patternManager;
    const txA = rtA.edit();
    await pmA.compilePattern(E2E_PROGRAM, { space: sharedSpace, tx: txA });
    await pmA.flushCompileCacheWrites();
    await txA.commit();
    // Ensure the docs have propagated through the in-process server.
    await smA.synced();

    expect(pmA.getCompileCacheStats()).toEqual({
      hits: 0,
      misses: 1,
      byIdentityHits: 0,
    });

    // --- Session B: should warm-hit A's committed cache ---
    // smB has its own per-space client replicas, so it must fetch from the
    // shared server. compilePattern drives the storage read-through internally.
    const pmB = rtB.patternManager;
    const txB = rtB.edit();
    const compiled = await pmB.compilePattern(E2E_PROGRAM, {
      space: sharedSpace,
      tx: txB,
    });
    await txB.commit();

    // (a) Warm hit: B found A's compiled docs without recompiling.
    expect(pmB.getCompileCacheStats()).toEqual({
      hits: 1,
      misses: 0,
      byIdentityHits: 0,
    });
    // The pattern is a runnable function.
    expect(typeof compiled).toBe("function");

    // (b) B's own cold-compile writeback (if it had been a miss) also
    // commits cleanly — the constant atom merges without "addIntegrity cannot
    // be weakened". Exercise this directly via writeCompiledDocs + commit.
    const { modules, entryIdentity } = toModules({
      main: E2E_PROGRAM.main,
      files: E2E_PROGRAM.files,
    });
    const wtxB2 = rtB.edit();
    writeCompiledDocs(
      rtB,
      sharedSpace,
      modules,
      entryIdentity,
      { runtimeVersion: RTVER },
      wtxB2,
    );
    wtxB2.prepareCfc();
    const result = await wtxB2.commit();
    expect(result.error).toBe(undefined);
  });

  it("cold writeback recovers from a partial source cache already committed by another replica", async () => {
    const { modules, entryIdentity } = toModules(E2E_PROGRAM);
    const utilModule = modules.find((module) => module.filename === "/util.ts");
    expect(utilModule).toBeDefined();

    // A partially committed cache graph: only an imported source doc is present
    // in the shared space. Runtime B has not pulled it yet, so its local replica
    // would otherwise build the writeback transaction from a stale seq-0 view.
    const partialTx = rtA.edit();
    writeSourceDocs(
      rtA,
      sharedSpace,
      [utilModule!],
      utilModule!.identity,
      partialTx,
    );
    rtA.prepareTxForCommit(partialTx);
    const partialResult = await partialTx.commit();
    expect(partialResult.error).toBe(undefined);
    await smA.synced();

    const txB = rtB.edit();
    const compiled = await rtB.patternManager.compilePattern(E2E_PROGRAM, {
      space: sharedSpace,
      tx: txB,
    });
    await txB.commit();
    expect(typeof compiled).toBe("function");
    expect(rtB.patternManager.getCompileCacheStats()).toEqual({
      hits: 0,
      misses: 1,
      byIdentityHits: 0,
    });

    const readTx = rtB.edit();
    const source = await loadVerifiedSourceClosure(
      rtB,
      sharedSpace,
      entryIdentity,
      readTx,
    );
    const compiledClosure = await loadCompiledClosure(
      rtB,
      sharedSpace,
      entryIdentity,
      { runtimeVersion: RTVER },
      readTx,
    );
    readTx.abort?.();

    expect(source?.has(entryIdentity)).toBe(true);
    expect(source?.has(utilModule!.identity)).toBe(true);
    expect(compiledClosure.has(entryIdentity)).toBe(true);
    expect(compiledClosure.has(utilModule!.identity)).toBe(true);
  });
});
