import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";

import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import { Engine } from "../src/harness/engine.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";

const signer = await Identity.fromPassphrase("test operator");

// Phase D3.2: the Engine ESM compile path (compileToRecordGraph) runs the real
// CF transformer pipeline, emits per-module CommonJS, assembles content-
// addressed records + runtime records, and security-verifies every body.
describe("Engine.compileToRecordGraph", () => {
  let runtime: Runtime;
  let engine: Engine;
  let storageManager: ReturnType<typeof StorageManager.emulate>;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({ apiUrl: new URL(import.meta.url), storageManager });
    engine = runtime.harness as Engine;
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("compiles a simple program into a verified record graph", async () => {
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: "export default 42;" }],
    };
    const { graph, mainSpecifier } = await engine.compileToRecordGraph(program);

    expect(mainSpecifier.startsWith("cf:module/")).toBe(true);
    expect(graph.records.has(mainSpecifier)).toBe(true);
    // Every authored module has a compiled body and a record.
    expect(graph.compiledBodies.size).toBeGreaterThan(0);
    // Runtime-module records are registered for cf:runtime/commonfabric.
    expect(graph.records.has("cf:runtime/commonfabric")).toBe(true);
    // (compileToRecordGraph throws if any body fails verification — reaching
    // here means all authored bodies passed the ESM security verifier.)
  });

  it("compiles + evaluates a program through the ESM path", async () => {
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [{
        name: "/main.tsx",
        contents:
          "export const answer = 42;\nexport const make = () => answer;\nexport default make;",
      }],
    };
    const { main, loadId } = await engine.compileAndEvaluateModules(program);
    expect(loadId).toBeTruthy();
    expect(main).toBeDefined();
    expect((main as { answer: number }).answer).toBe(42);
    expect((main as { make(): number }).make()).toBe(42);
    // default export resolves to the same function.
    expect((main as { default(): number }).default()).toBe(42);
  });

  it("evaluates a multi-module program across an internal import", async () => {
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [
        { name: "/dep.ts", contents: "export const base = (): number => 20;" },
        {
          name: "/main.tsx",
          contents:
            `import { base } from "./dep.ts";\nexport const total = () => base() + 22;\nexport default total;`,
        },
      ],
    };
    const { main } = await engine.compileAndEvaluateModules(program);
    expect((main as { total(): number }).total()).toBe(42);
  });

  it("rejects a program whose module contains disallowed top-level code", async () => {
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [{
        name: "/main.tsx",
        // Unwrapped top-level mutable export — the verifier must reject it.
        contents: "export const leaked = globalThis;\nexport default leaked;",
      }],
    };
    await expect(engine.compileToRecordGraph(program)).rejects.toThrow();
  });
});
