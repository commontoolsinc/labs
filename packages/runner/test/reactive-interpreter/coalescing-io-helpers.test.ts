/**
 * §4.7 nested-collection coalescing — sound dispatch helpers.
 *
 * Guards the precise, sound refinements that un-trap deeply-nested
 * effect/handler-bearing element sub-patterns (07 §4.7) without the coarse
 * whole-pattern fallbacks that blocked them:
 *
 *  1. `argumentPathNeedsCellContext` — PATH-aware handle detection: a segment
 *     that reads a PLAIN argument path is sound even when a SIBLING field is a
 *     `Cell`/`Stream` handle handed to a handler boundary (the coarse
 *     `schemaNeedsCellContext` fell the whole pattern back). A read AT or ABOVE a
 *     handle node still surfaces the handle → true.
 *
 *  2. I/O-vs-handler effect-sink CLASSIFICATION — `fetchData`/`generateText`/
 *     `llm`/`sqliteQuery`/… are DATAFLOW producers (`effectSink: "io"`); a
 *     `cf.handler` / `navigateTo` / `streamData` is a `"handler"` sink. The F4
 *     write-back-cycle gate (runner) uses this to engage the post-fetch pure
 *     region while keeping a handler write-back a boundary.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  argumentPathNeedsCellContext,
  extractRog,
  schemaNeedsCellContext,
} from "../../src/reactive-interpreter/extract.ts";
import type { JSONSchema } from "../../src/builder/types.ts";

describe("§4.7 argumentPathNeedsCellContext (path-aware handle detection)", () => {
  const schema = {
    type: "object",
    properties: {
      // Plain value fields a pure segment can read soundly.
      option: {
        type: "object",
        properties: {
          title: { type: "string" },
          imageUrl: { type: "string" },
        },
      },
      rank: { type: "number" },
      // Handle fields handed to handlers — reading one surfaces a live handle.
      castVote: { asStream: ["stream"] },
      removeConfirmTarget: { asCell: ["cell"] },
    },
  } as unknown as JSONSchema;

  it("returns false for a plain nested value path", () => {
    expect(argumentPathNeedsCellContext(schema, ["option", "title"])).toBe(
      false,
    );
    expect(argumentPathNeedsCellContext(schema, ["rank"])).toBe(false);
  });

  it("returns true for a Stream / Cell handle path", () => {
    expect(argumentPathNeedsCellContext(schema, ["castVote"])).toBe(true);
    expect(argumentPathNeedsCellContext(schema, ["removeConfirmTarget"])).toBe(
      true,
    );
  });

  it("returns true for a sub-path UNDER a handle node (the handle root dominates)", () => {
    // Reading `removeConfirmTarget.someKey` still surfaces the Cell handle.
    expect(
      argumentPathNeedsCellContext(schema, ["removeConfirmTarget", "x"]),
    ).toBe(true);
  });

  it("returns false reading the whole argument root when no top handle", () => {
    // An empty path reads the root object (deep-resolves to a plain value); a
    // top-level handle would be caught by `schemaNeedsCellContext`, but the
    // root itself is a plain object here.
    expect(argumentPathNeedsCellContext(schema, [])).toBe(false);
  });

  it("agrees with the coarse gate: the schema DOES need cell context somewhere", () => {
    // Sanity: the coarse whole-schema check flags it (so the path-aware gate is
    // the strict refinement that engages the plain-path-only segments).
    expect(schemaNeedsCellContext(schema)).toBe(true);
  });
});

describe("§4.7 effect-sink classification (I/O dataflow vs handler write-back)", () => {
  // Build a minimal pattern carrying one effect node of the given module ref and
  // return the extracted effect op's sink.
  const sinkOf = (moduleRef: string): string | undefined => {
    const pattern = {
      argumentSchema: { type: "object" },
      resultSchema: { type: "object" },
      result: { $alias: { partialCause: "out", path: [] } },
      nodes: [
        {
          module: { type: "ref", implementation: moduleRef },
          inputs: {
            x: { $alias: { cell: "argument", path: ["x"] } },
          },
          outputs: { $alias: { partialCause: "out", path: [] } },
        },
      ],
    };
    // deno-lint-ignore no-explicit-any
    const r = extractRog(pattern as any);
    const effect = r.rog.ops.find((op) => op.detail.kind === "effect");
    return effect && effect.detail.kind === "effect"
      ? effect.detail.sink
      : undefined;
  };

  it("classifies fetchData / generateText / llm / sqliteQuery as I/O dataflow producers", () => {
    expect(sinkOf("fetchData")).toBe("io");
    expect(sinkOf("generateText")).toBe("io");
    expect(sinkOf("llm")).toBe("io");
    expect(sinkOf("sqliteQuery")).toBe("io");
    expect(sinkOf("wish")).toBe("io");
  });

  it("classifies navigateTo / streamData as handler (sink-only, no consumable result)", () => {
    expect(sinkOf("navigateTo")).toBe("handler");
    expect(sinkOf("streamData")).toBe("handler");
  });

  it("classifies a cf.handler javascript node as a handler sink", () => {
    const pattern = {
      argumentSchema: { type: "object" },
      resultSchema: { type: "object" },
      result: { $alias: { partialCause: "out", path: [] } },
      nodes: [
        {
          module: {
            type: "javascript",
            wrapper: "handler",
            implementation: () => {},
          },
          inputs: { x: { $alias: { cell: "argument", path: ["x"] } } },
          outputs: { $alias: { partialCause: "out", path: [] } },
        },
      ],
    };
    // deno-lint-ignore no-explicit-any
    const r = extractRog(pattern as any);
    const effect = r.rog.ops.find((op) => op.detail.kind === "effect");
    expect(effect && effect.detail.kind === "effect" && effect.detail.sink)
      .toBe("handler");
  });
});
