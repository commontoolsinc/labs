import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { Source } from "@commonfabric/js-compiler";
import { compileSourcesToRecords } from "../src/sandbox/module-record-compiler.ts";
import { importModuleGraphNow } from "../src/sandbox/esm-module-loader.ts";

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

  it("assigns content-addressed specifiers (cf:module/<hash>)", () => {
    const { specifierByPath } = compileSourcesToRecords(
      files({ "/main.ts": `export const x = 1;` }),
    );
    expect(specifierByPath.get("/main.ts")!.startsWith("cf:module/")).toBe(
      true,
    );
  });
});
