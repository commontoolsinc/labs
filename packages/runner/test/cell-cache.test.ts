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
  compiledDocKey,
  compiledIntegrityAtom,
  loadCompiledClosure,
  loadSourceClosure,
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
});

describe("cell-cache: compiled-set store (CFC integrity, fail-closed)", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  const spaceA = signer.did();
  const compilerDid = signer.did();
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

  const opts = () => ({ runtimeVersion: RTVER, compilerDid });

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
      compiledIntegrityAtom(compilerDid),
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
});
