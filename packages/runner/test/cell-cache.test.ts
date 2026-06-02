import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";

import {
  buildSourceDocs,
  type CompiledArtifacts,
  compiledDocKey,
  compiledIntegrityAtom,
  loadCompiledClosure,
  loadSourceClosure,
  moduleIdentities,
  sourceDocKey,
  verifySourceDocs,
  writeCompiledDocs,
  writeSourceDocs,
} from "../src/compilation-cache/cell-cache.ts";

const signer = await Identity.fromPassphrase("cell-cache test");

// Step 4.3.1 — content-addressed cache document model: key scheme, per-module
// identity, source-document construction, and the Merkle self-verification of a
// loaded source closure.

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

const identityOf = (program: typeof PROGRAM, path: string) =>
  moduleIdentities(program).get(path)!;

describe("cell-cache: keys", () => {
  it("formats source and compiled document keys", () => {
    expect(sourceDocKey("abc")).toBe("pattern:abc");
    expect(compiledDocKey("rt1", "abc")).toBe("compileCache:rt1/abc");
  });
});

describe("cell-cache: buildSourceDocs", () => {
  it("keys each module by its identity and records resolved import links", () => {
    const ids = moduleIdentities(PROGRAM);
    const docs = buildSourceDocs(PROGRAM);

    // One document per program file, keyed by identity.
    expect(docs.size).toBe(3);
    for (const [identity, doc] of docs) {
      expect(ids.get(doc.filename)).toBe(identity);
    }

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
});

describe("cell-cache: verifySourceDocs (Merkle self-verification)", () => {
  it("accepts a faithfully-built closure", () => {
    const docs = buildSourceDocs(PROGRAM);
    const v = verifySourceDocs(identityOf(PROGRAM, "/main.tsx"), docs);
    expect(v.ok).toBe(true);
    expect(v.entryFilename).toBe("/main.tsx");
    expect(v.mismatches).toEqual([]);
    expect(v.missing).toEqual([]);
  });

  it("rejects a tampered document (recomputed identity != key)", () => {
    const docs = new Map(buildSourceDocs(PROGRAM));
    const utilIdentity = identityOf(PROGRAM, "/util.ts");
    const util = docs.get(utilIdentity)!;
    // Keep the key, change the body — content no longer hashes to its key.
    docs.set(utilIdentity, {
      ...util,
      code: `export const helper = (n) => n + 999;`,
    });

    const v = verifySourceDocs(identityOf(PROGRAM, "/main.tsx"), docs);
    expect(v.ok).toBe(false);
    expect(v.mismatches).toContain(utilIdentity);
  });

  it("flags a missing import-link target", () => {
    const docs = new Map(buildSourceDocs(PROGRAM));
    docs.delete(identityOf(PROGRAM, "/util.ts"));
    const v = verifySourceDocs(identityOf(PROGRAM, "/main.tsx"), docs);
    expect(v.ok).toBe(false);
    expect(v.missing).toContain(identityOf(PROGRAM, "/util.ts"));
  });

  it("is entry-point independent (util identity is stable across entries)", () => {
    const viaMain = identityOf(PROGRAM, "/util.ts");
    // Compile the same files with util as the entry point.
    const utilEntry = { ...PROGRAM, main: "/util.ts" };
    const viaUtil = moduleIdentities(utilEntry).get("/util.ts")!;
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

  it("writes the closure and loads it back via import links", () => {
    const tx = runtime.edit();
    writeSourceDocs(runtime, spaceA, PROGRAM, tx);

    const entryIdentity = identityOf(PROGRAM, "/main.tsx");
    const loaded = loadSourceClosure(runtime, spaceA, entryIdentity, tx)!;

    // All three modules reached by following links from the entry.
    expect(loaded.size).toBe(3);
    expect(new Set([...loaded.values()].map((d) => d.filename))).toEqual(
      new Set(["/main.tsx", "/util.ts", "/types.ts"]),
    );
    // Loaded closure self-verifies (recomputed identities match the keys).
    expect(verifySourceDocs(entryIdentity, loaded).ok).toBe(true);
  });

  it("is empty for an entry that was never written", () => {
    const tx = runtime.edit();
    const loaded = loadSourceClosure(runtime, spaceA, "no-such-identity", tx);
    expect(loaded).toBe(undefined);
  });
});

describe("cell-cache: compiled-set store (CFC integrity, fail-closed)", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  const spaceA = signer.did();
  const compilerDid = signer.did();
  const RTVER = "rt-test-1";

  const artifactsFor = (program: typeof PROGRAM): CompiledArtifacts => {
    const m = new Map();
    for (const f of program.files) {
      m.set(f.name, { js: `/* compiled */ ${f.name}` });
    }
    return m;
  };

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
    const wtx = runtime.edit();
    writeCompiledDocs(
      runtime,
      spaceA,
      PROGRAM,
      artifactsFor(PROGRAM),
      opts(),
      wtx,
    );
    wtx.prepareCfc();
    await wtx.commit();

    const rtx = runtime.edit();
    const loaded = loadCompiledClosure(
      runtime,
      spaceA,
      identityOf(PROGRAM, "/main.tsx"),
      opts(),
      rtx,
    );
    rtx.abort?.();

    expect(loaded.size).toBe(3);
    const main = loaded.get(identityOf(PROGRAM, "/main.tsx"))!;
    expect(main.code).toBe("/* compiled */ /main.tsx");
    expect(new Set([...loaded.values()].map((d) => d.filename))).toEqual(
      new Set(["/main.tsx", "/util.ts", "/types.ts"]),
    );
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
    const loaded = loadCompiledClosure(
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
    const wtx = runtime.edit();
    writeCompiledDocs(
      runtime,
      spaceA,
      PROGRAM,
      artifactsFor(PROGRAM),
      opts(),
      wtx,
    );
    wtx.prepareCfc();
    await wtx.commit();

    // A loader expecting a different compiler DID requires a different atom.
    const otherDid = "did:key:someone-else";
    expect(compiledIntegrityAtom(otherDid)).not.toBe(
      compiledIntegrityAtom(compilerDid),
    );
    const rtx = runtime.edit();
    const loaded = loadCompiledClosure(
      runtime,
      spaceA,
      identityOf(PROGRAM, "/main.tsx"),
      { runtimeVersion: RTVER, compilerDid: otherDid },
      rtx,
    );
    rtx.abort?.();
    expect(loaded.size).toBe(0);
  });
});
