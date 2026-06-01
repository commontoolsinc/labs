import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { Source } from "@commonfabric/js-compiler";
import {
  type CompiledModuleArtifact,
  compileSourcesToRecords,
  type ModuleRecordCache,
} from "../src/sandbox/module-record-compiler.ts";
import {
  importModuleGraphNow,
  runtimeModuleRecords,
} from "../src/sandbox/esm-module-loader.ts";

class MapRecordCache implements ModuleRecordCache {
  store = new Map<string, CompiledModuleArtifact>();
  hits = 0;
  misses = 0;
  get(hash: string): CompiledModuleArtifact | undefined {
    const v = this.store.get(hash);
    if (v) this.hits++;
    else this.misses++;
    return v;
  }
  set(hash: string, artifact: CompiledModuleArtifact): void {
    this.store.set(hash, artifact);
  }
}

function files(map: Record<string, string>): Source[] {
  return Object.entries(map).map(([name, contents]) => ({ name, contents }));
}

describe("compileSourcesToRecords + importModuleGraphNow (end to end)", () => {
  it("loads a multi-module compiled program through the SES module graph", () => {
    const sources = files({
      "/util.ts": `export const double = (n: number): number => n * 2;`,
      "/main.ts":
        `import { double } from "./util.ts";\nexport const run = (): number => double(21);\nexport default run;`,
    });

    const { records, specifierByPath } = compileSourcesToRecords(sources);
    const entry = specifierByPath.get("/main.ts")!;
    const ns = importModuleGraphNow(entry, { records }) as {
      run(): number;
      default(): number;
    };

    expect(ns.run()).toBe(42);
    expect(ns.default()).toBe(42);
  });

  it("resolves runtime-module imports via runtimeModuleRecords", () => {
    const sources = files({
      "/main.ts":
        `import { dbl } from "commonfabric";\nexport const run = (): number => dbl(21);`,
    });
    const { records, specifierByPath } = compileSourcesToRecords(sources, {
      runtimeModules: { commonfabric: ["dbl"] },
    });
    // Merge the runtime-module record built from the host's runtime exports.
    for (
      const [spec, rec] of runtimeModuleRecords({
        commonfabric: { dbl: (x: number) => x * 2 },
      })
    ) {
      records.set(spec, rec);
    }
    const ns = importModuleGraphNow(specifierByPath.get("/main.ts")!, {
      records,
    }) as { run(): number };
    expect(ns.run()).toBe(42);
  });

  it("resolves a default import across modules (esModuleInterop)", () => {
    const sources = files({
      "/dep.ts": `const value = 7;\nexport default value;`,
      "/main.ts":
        `import dep from "./dep.ts";\nexport const run = (): number => dep + 1;`,
    });
    const { records, specifierByPath } = compileSourcesToRecords(sources);
    const ns = importModuleGraphNow(specifierByPath.get("/main.ts")!, {
      records,
    }) as { run(): number };
    expect(ns.run()).toBe(8);
  });

  it("supports a runtime-module record injected into the graph", () => {
    const sources = files({
      "/main.ts":
        `import { greet } from "host";\nexport const value = greet("world");`,
    });

    const { records, specifierByPath } = compileSourcesToRecords(sources, {
      runtimeModules: { host: ["greet"] },
    });
    // Provide the runtime module's implementation as a record.
    records.set("cf:runtime/host", {
      imports: [],
      exports: ["greet"],
      execute: (exports) => {
        exports.greet = (n: string) => `hi ${n}`;
      },
    });

    const entry = specifierByPath.get("/main.ts")!;
    const ns = importModuleGraphNow(entry, { records }) as { value: string };
    expect(ns.value).toBe("hi world");
  });

  it("populates the per-module cache on a miss and reuses it on a hit", () => {
    const sources = files({ "/main.ts": `export const x = () => 1;` });
    const cache = new MapRecordCache();

    compileSourcesToRecords(sources, { recordCache: cache });
    expect(cache.misses).toBe(1);
    expect(cache.store.size).toBe(1);

    // Second compile of identical sources hits the cache (no recompile).
    compileSourcesToRecords(sources, { recordCache: cache });
    expect(cache.hits).toBe(1);
  });

  it("uses the cached compiled artifact (cache is authoritative on hit)", () => {
    const sources = files({
      "/main.ts": `export const run = (): number => 1;`,
    });
    // Pre-seed the cache with a sentinel artifact so we can prove it is used.
    const cache = new MapRecordCache();
    const { specifierByPath: probe } = compileSourcesToRecords(sources);
    const hash = probe.get("/main.ts")!.replace("cf:module/", "");
    cache.store.set(hash, {
      exports: ["run"],
      compiled: `exports.run = function () { return 99; };`,
    });

    const { records, specifierByPath } = compileSourcesToRecords(sources, {
      recordCache: cache,
    });
    const ns = importModuleGraphNow(specifierByPath.get("/main.ts")!, {
      records,
    }) as { run(): number };
    expect(ns.run()).toBe(99);
  });

  it("wires a named re-export from another module (export { x } from)", () => {
    const sources = files({
      "/inner.ts": `export const x = (): number => 5;`,
      "/main.ts": `export { x } from "./inner.ts";`,
    });
    const { records, specifierByPath } = compileSourcesToRecords(sources);
    const ns = importModuleGraphNow(specifierByPath.get("/main.ts")!, {
      records,
    }) as { x(): number };
    expect(ns.x()).toBe(5);
  });

  it("collects destructured variable exports", () => {
    const sources = files({
      "/main.ts": `const o = { a: 1, b: 2 };\nexport const { a, b } = o;`,
    });
    const { records, specifierByPath } = compileSourcesToRecords(sources);
    const ns = importModuleGraphNow(specifierByPath.get("/main.ts")!, {
      records,
    }) as { a: number; b: number };
    expect(ns.a).toBe(1);
    expect(ns.b).toBe(2);
  });

  it("does not turn a type-only import into a runtime record edge", () => {
    // `import type` from a module that is NOT in the graph must not create a
    // dangling resolution / runtime import.
    const sources = files({
      "/main.ts":
        `import type { Foo } from "external-types";\nexport const run = (x: Foo): number => 1;`,
    });
    const { records, specifierByPath } = compileSourcesToRecords(sources);
    const record = records.get(specifierByPath.get("/main.ts")!)!;
    expect(record.imports).not.toContain("external-types");
    // Loads cleanly (verifier sees no dangling edge).
    const ns = importModuleGraphNow(specifierByPath.get("/main.ts")!, {
      records,
    }) as { run(x: unknown): number };
    expect(ns.run(undefined)).toBe(1);
  });

  it("does not create edges for require(...) text in strings or comments", () => {
    // `./ghost.ts` is a real sibling — a regex over the compiled text would
    // wrongly pull it in as an eagerly-executed dependency.
    const sources = files({
      "/ghost.ts": `export const boom = 1;`,
      "/main.ts": [
        `// require("./ghost.ts") in a comment must be ignored`,
        `export const s = 'see require("./ghost.ts") for details';`,
        `export const run = (): number => 1;`,
      ].join("\n"),
    });
    const { records, specifierByPath } = compileSourcesToRecords(sources);
    const record = records.get(specifierByPath.get("/main.ts")!)!;
    expect(record.imports).not.toContain("./ghost.ts");
    const ns = importModuleGraphNow(specifierByPath.get("/main.ts")!, {
      records,
    }) as { run(): number };
    expect(ns.run()).toBe(1);
  });

  it("collects enum exports", () => {
    const sources = files({
      "/main.ts": `export enum Color { Red = 1, Blue = 2 }`,
    });
    const { records, specifierByPath } = compileSourcesToRecords(sources);
    const ns = importModuleGraphNow(specifierByPath.get("/main.ts")!, {
      records,
    }) as { Color: Record<string, unknown> };
    expect(ns.Color.Red).toBe(1);
  });

  it("ignores type-only re-exports instead of throwing", () => {
    const sources = files({
      "/types.ts": `export interface Foo { n: number }`,
      "/main.ts":
        `export type * from "./types.ts";\nexport const run = (): number => 1;`,
    });
    const { records, specifierByPath } = compileSourcesToRecords(sources);
    const ns = importModuleGraphNow(specifierByPath.get("/main.ts")!, {
      records,
    }) as { run(): number };
    expect(ns.run()).toBe(1);
  });

  it("throws loudly on unsupported `export * from`", () => {
    const sources = files({
      "/inner.ts": `export const x = 1;`,
      "/main.ts": `export * from "./inner.ts";`,
    });
    expect(() => compileSourcesToRecords(sources)).toThrow(/export \* from/);
  });

  it("assigns content-addressed specifiers (cf:module/<hash>)", () => {
    const { specifierByPath } = compileSourcesToRecords(
      files({ "/main.ts": `export const x = 1;` }),
    );
    expect(specifierByPath.get("/main.ts")!.startsWith("cf:module/")).toBe(
      true,
    );
  });
});
