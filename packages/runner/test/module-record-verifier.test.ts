import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { VirtualModuleRecord } from "../src/sandbox/esm-module-loader.ts";
import { verifyModuleGraph } from "../src/sandbox/module-record-verifier.ts";

function rec(over: Partial<VirtualModuleRecord> = {}): VirtualModuleRecord {
  return {
    imports: [],
    exports: [],
    execute: () => {},
    ...over,
  };
}

function graph(
  entries: [string, VirtualModuleRecord][],
): Map<string, VirtualModuleRecord> {
  return new Map(entries);
}

describe("verifyModuleGraph", () => {
  it("accepts a well-formed graph", () => {
    const g = graph([
      [
        "cf:module/main",
        rec({
          imports: ["./util.ts"],
          exports: ["run"],
          resolutions: { "./util.ts": "cf:module/util" },
        }),
      ],
      ["cf:module/util", rec({ exports: ["double"] })],
    ]);
    expect(() => verifyModuleGraph(g, "cf:module/main")).not.toThrow();
  });

  it("rejects a missing entry specifier", () => {
    const g = graph([["cf:module/util", rec()]]);
    expect(() => verifyModuleGraph(g, "cf:module/main")).toThrow(
      /entry/i,
    );
  });

  it("rejects a dangling resolution target", () => {
    const g = graph([
      [
        "cf:module/main",
        rec({
          imports: ["./missing.ts"],
          resolutions: { "./missing.ts": "cf:module/missing" },
        }),
      ],
    ]);
    expect(() => verifyModuleGraph(g, "cf:module/main")).toThrow(
      /unresolved|missing/i,
    );
  });

  it("rejects a non-content-addressed specifier", () => {
    const g = graph([["/raw/path.ts", rec()]]);
    expect(() => verifyModuleGraph(g, "/raw/path.ts")).toThrow(
      /specifier/i,
    );
  });

  it("rejects a record with a non-function execute", () => {
    const g = graph([[
      "cf:module/main",
      { imports: [], exports: [], execute: undefined as unknown as () => void },
    ]]);
    expect(() => verifyModuleGraph(g, "cf:module/main")).toThrow(/execute/i);
  });
});
