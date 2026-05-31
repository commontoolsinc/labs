import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { Program } from "@commonfabric/js-compiler";
import { computeModuleHashes } from "../src/harness/module-identity.ts";

function program(main: string, files: Record<string, string>): Program {
  return {
    main,
    files: Object.entries(files).map(([name, contents]) => ({
      name,
      contents,
    })),
  };
}

const RFP = "runner:scheduler:pull";

describe("computeModuleHashes", () => {
  it("is entry-point independent: a shared module hashes the same regardless of the entry point", () => {
    // a -> b -> c. Compile once from `a`, once from `b`.
    const a = `import { b } from "./b.ts"; export const a = () => b();`;
    const b = `import { c } from "./c.ts"; export const b = () => c();`;
    const c = `export const c = () => 1;`;

    const fromA = computeModuleHashes(
      program("/a.ts", { "/a.ts": a, "/b.ts": b, "/c.ts": c }),
      { runtimeFingerprint: RFP },
    );
    const fromB = computeModuleHashes(
      program("/b.ts", { "/b.ts": b, "/c.ts": c }),
      { runtimeFingerprint: RFP },
    );

    expect(fromA.get("/b.ts")).toBe(fromB.get("/b.ts"));
    expect(fromA.get("/c.ts")).toBe(fromB.get("/c.ts"));
  });

  it("is unaffected by unrelated sibling files in the program", () => {
    const a = `import { b } from "./b.ts"; export const a = () => b();`;
    const b = `export const b = () => 1;`;
    const unrelated = `export const z = 99;`;

    const without = computeModuleHashes(
      program("/a.ts", { "/a.ts": a, "/b.ts": b }),
      { runtimeFingerprint: RFP },
    );
    const withSibling = computeModuleHashes(
      program("/a.ts", { "/a.ts": a, "/b.ts": b, "/z.ts": unrelated }),
      { runtimeFingerprint: RFP },
    );

    expect(withSibling.get("/a.ts")).toBe(without.get("/a.ts"));
    expect(withSibling.get("/b.ts")).toBe(without.get("/b.ts"));
  });

  it("is transitively sensitive: changing a deep dependency changes every importer", () => {
    const a = `import { b } from "./b.ts"; export const a = () => b();`;
    const b = `import { c } from "./c.ts"; export const b = () => c();`;
    const c1 = `export const c = () => 1;`;
    const c2 = `export const c = () => 2;`;

    const before = computeModuleHashes(
      program("/a.ts", { "/a.ts": a, "/b.ts": b, "/c.ts": c1 }),
      { runtimeFingerprint: RFP },
    );
    const after = computeModuleHashes(
      program("/a.ts", { "/a.ts": a, "/b.ts": b, "/c.ts": c2 }),
      { runtimeFingerprint: RFP },
    );

    expect(after.get("/c.ts")).not.toBe(before.get("/c.ts"));
    expect(after.get("/b.ts")).not.toBe(before.get("/b.ts"));
    expect(after.get("/a.ts")).not.toBe(before.get("/a.ts"));
  });

  it("counts type-only import edges (types are load-bearing)", () => {
    const a = `import type { T } from "./t.ts"; export const a = (x: T) => x;`;
    const t1 = `export interface T { n: number }`;
    const t2 = `export interface T { n: string }`;

    const before = computeModuleHashes(
      program("/a.ts", { "/a.ts": a, "/t.ts": t1 }),
      { runtimeFingerprint: RFP },
    );
    const after = computeModuleHashes(
      program("/a.ts", { "/a.ts": a, "/t.ts": t2 }),
      { runtimeFingerprint: RFP },
    );

    expect(after.get("/t.ts")).not.toBe(before.get("/t.ts"));
    expect(after.get("/a.ts")).not.toBe(before.get("/a.ts"));
  });

  it("is deterministic and stable for import cycles", () => {
    const a = `import { b } from "./b.ts"; export const a = () => b();`;
    const b = `import { a } from "./a.ts"; export const b = () => a();`;

    const p = program("/a.ts", { "/a.ts": a, "/b.ts": b });
    const first = computeModuleHashes(p, { runtimeFingerprint: RFP });
    const second = computeModuleHashes(p, { runtimeFingerprint: RFP });

    expect(first.get("/a.ts")).toBe(second.get("/a.ts"));
    expect(first.get("/b.ts")).toBe(second.get("/b.ts"));
    expect(first.get("/a.ts")).toBeTruthy();
    // members of a cycle still get distinct identities
    expect(first.get("/a.ts")).not.toBe(first.get("/b.ts"));
  });

  it("folds the runtime fingerprint into modules that import runtime modules", () => {
    const usesRuntime =
      `import { h } from "commonfabric"; export const a = () => h();`;
    const pure = `export const z = () => 1;`;

    const p = program("/a.ts", { "/a.ts": usesRuntime, "/z.ts": pure });
    const fp1 = computeModuleHashes(p, { runtimeFingerprint: "rt:v1" });
    const fp2 = computeModuleHashes(p, { runtimeFingerprint: "rt:v2" });

    // a imports the external runtime module, so it tracks the runtime fingerprint
    expect(fp2.get("/a.ts")).not.toBe(fp1.get("/a.ts"));
    // z imports nothing external, so it is independent of the runtime fingerprint
    expect(fp2.get("/z.ts")).toBe(fp1.get("/z.ts"));
  });
});
