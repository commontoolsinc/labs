import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  buildSourceDocs,
  compiledDocKey,
  moduleIdentities,
  sourceDocKey,
  verifySourceDocs,
} from "../src/compilation-cache/cell-cache.ts";

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
