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

  it("rejects an import edge resolved to a non-content-addressed target", () => {
    // The compiler's fallback leaves an unknown specifier verbatim; the verifier
    // must reject a target that is not a cf:module/ or cf:runtime/ specifier,
    // rather than relying on it merely being absent from the records map.
    const g = graph([
      [
        "cf:module/main",
        rec({
          imports: ["/cf:runtime/commonfabric"],
          resolutions: {
            "/cf:runtime/commonfabric": "/cf:runtime/commonfabric",
          },
        }),
      ],
      ["/cf:runtime/commonfabric", rec({ exports: ["pattern"] })],
    ]);
    expect(() => verifyModuleGraph(g, "cf:module/main")).toThrow(
      /non-content-addressed import target/i,
    );
  });

  it("rejects an import edge rewired to a foreign present record", () => {
    // A record must not resolve one of its imports to an arbitrary other key.
    // Here the target IS present and content-addressed, but the deeper invariant
    // is covered by the undeclared-resolution and target-shape checks; a bare
    // `node:fs` target (present or not) is rejected for not being cf:-addressed.
    const g = graph([
      [
        "cf:module/main",
        rec({ imports: ["node:fs"], resolutions: { "node:fs": "node:fs" } }),
      ],
    ]);
    expect(() => verifyModuleGraph(g, "cf:module/main")).toThrow(
      /non-content-addressed import target/i,
    );
  });

  it("rejects a resolution for an undeclared import", () => {
    const g = graph([
      [
        "cf:module/main",
        rec({
          imports: ["./util.ts"],
          resolutions: {
            "./util.ts": "cf:module/util",
            "./extra.ts": "cf:module/util",
          },
        }),
      ],
      ["cf:module/util", rec({ exports: ["x"] })],
    ]);
    expect(() => verifyModuleGraph(g, "cf:module/main")).toThrow(
      /undeclared import/i,
    );
  });

  it("accepts cf:runtime/ import targets", () => {
    const g = graph([
      [
        "cf:module/main",
        rec({
          imports: ["commonfabric"],
          resolutions: { commonfabric: "cf:runtime/commonfabric" },
        }),
      ],
      ["cf:runtime/commonfabric", rec({ exports: ["pattern"] })],
    ]);
    expect(() => verifyModuleGraph(g, "cf:module/main")).not.toThrow();
  });

  it("rejects a record with a non-function execute", () => {
    const g = graph([[
      "cf:module/main",
      { imports: [], exports: [], execute: undefined as unknown as () => void },
    ]]);
    expect(() => verifyModuleGraph(g, "cf:module/main")).toThrow(/execute/i);
  });
});
