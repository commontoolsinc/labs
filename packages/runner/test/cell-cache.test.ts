import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import {
  computeModuleHashes,
  resolveModuleImports,
} from "../src/harness/module-identity.ts";
import type { CacheableModule } from "../src/harness/types.ts";

import {
  buildSourceDocs,
  COMPILE_CACHE_RUNTIME_VERSION,
  compiledDocKey,
  compiledIntegrityAtom,
  loadCompiledClosure,
  loadSourceClosure,
  loadVerifiedSourceClosure,
  ROOT_LINK_SPECIFIER,
  sourceDocKey,
  verifySourceDocs,
  writeCompiledDocs,
  writeSourceDocs,
} from "../src/compilation-cache/cell-cache.ts";

const signer = await Identity.fromPassphrase("cell-cache test");

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
  program: typeof PROGRAM,
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

  const opts = () => ({
    runtimeVersion: RTVER,
    compilerDid: runtime.userIdentityDID,
  });

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

  it("fail-closed: a different compiler principal is not accepted", async () => {
    const { modules, entryIdentity } = toModules(PROGRAM);
    const wtx = runtime.edit();
    writeCompiledDocs(runtime, spaceA, modules, entryIdentity, opts(), wtx);
    wtx.prepareCfc();
    await wtx.commit();

    const otherDid = "did:key:someone-else";
    expect(compiledIntegrityAtom(otherDid)).not.toBe(
      compiledIntegrityAtom(opts().compilerDid),
    );
    const rtx = runtime.edit();
    const loaded = await loadCompiledClosure(
      runtime,
      spaceA,
      entryIdentity,
      { runtimeVersion: RTVER, compilerDid: otherDid },
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
      runtimeVersion: COMPILE_CACHE_RUNTIME_VERSION,
      compilerDid: runtime.userIdentityDID,
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
});
