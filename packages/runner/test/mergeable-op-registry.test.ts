import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { MERGEABLE_OP_METHODS } from "@commonfabric/api";
import { patchOpDescriptors } from "@commonfabric/memory/v2/patch";
import {
  buildMergeableIntent,
  MERGEABLE_WIRE_OPS,
} from "../src/storage/mergeable-ops.ts";

// Ties the three places a mergeable patch op is registered together, so a new op
// added to one but not the others fails loudly here rather than silently
// degrading a mergeable write to a whole-value diff:
//
//   1. api MERGEABLE_OP_METHODS      — the author method + wire tag + classification
//   2. runner storage/mergeable-ops  — how the op folds intent and builds wire ops
//   3. memory v2/patch descriptors   — the wire op's shape, apply, and touched paths
describe("mergeable op registry consistency", () => {
  const catalogWireOps = MERGEABLE_OP_METHODS.map((op) => op.wireOp);

  it("every catalog method records a real wire patch op", () => {
    for (const { method, wireOp } of MERGEABLE_OP_METHODS) {
      expect(
        Object.hasOwn(patchOpDescriptors, wireOp),
        `Cell.${method} records "${wireOp}", which is not a registered PatchOp ` +
          `(add a descriptor in memory/v2/patch.ts)`,
      ).toBe(true);
    }
  });

  it("the catalog and the runner registry cover the same wire ops", () => {
    expect([...catalogWireOps].sort()).toEqual([...MERGEABLE_WIRE_OPS].sort());
  });

  it("maps each method to a distinct wire op", () => {
    const methods = MERGEABLE_OP_METHODS.map((op) => op.method);
    expect(new Set(methods).size).toBe(methods.length);
    expect(new Set(catalogWireOps).size).toBe(catalogWireOps.length);
  });
});

// A create-from-absent mergeable op adds a key to its parent container; the
// build stamps `createsKey` so the conflict matcher invalidates a shape reader
// of the parent (see docs/specs/memory-v2/08-conflict-granularity.md and the
// engine-side conflict test in packages/memory).
describe("mergeable op createsKey stamping", () => {
  it("stamps createsKey when a tail op materializes an absent array", () => {
    expect(
      buildMergeableIntent(
        { op: "append", path: ["value", "items"], count: 1 },
        { workingArray: ["a"], hadInitialArray: false, hadInitialValue: false },
      ).ops,
    ).toEqual([
      { op: "append", path: "/value/items", values: ["a"], createsKey: true },
    ]);
  });

  it("omits createsKey when the array already existed", () => {
    expect(
      buildMergeableIntent(
        { op: "append", path: ["value", "items"], count: 1 },
        {
          workingArray: ["a", "b"],
          hadInitialArray: true,
          hadInitialValue: true,
          initialArrayLength: 1,
        },
      ).ops,
    ).toEqual([{ op: "append", path: "/value/items", values: ["b"] }]);
  });

  it("stamps createsKey when an increment materializes an absent number", () => {
    expect(
      buildMergeableIntent(
        { op: "increment", path: ["value", "n"], by: 3 },
        { hadInitialArray: false, hadInitialValue: false },
      ).ops,
    ).toEqual([
      { op: "increment", path: "/value/n", by: 3, createsKey: true },
    ]);
  });

  it("omits createsKey on an increment to an existing number", () => {
    expect(
      buildMergeableIntent(
        { op: "increment", path: ["value", "n"], by: 3 },
        { hadInitialArray: false, hadInitialValue: true },
      ).ops,
    ).toEqual([{ op: "increment", path: "/value/n", by: 3 }]);
  });
});

// The tail op builder (append / add-unique) bails in three guarded cases,
// abandoning the intent so the commit carries the plain diff instead. Some are
// reachable only through sequences the poison fallback short-circuits before
// build, so they are covered directly here.
describe("mergeable tail-op build guards", () => {
  // The op path holds no array at commit — the value is absent, or was
  // overwritten with a non-array — so there is nothing to slice a tail from.
  it("a tail op with no working array abandons the intent", () => {
    for (const op of ["append", "add-unique"] as const) {
      expect(
        buildMergeableIntent(
          { op, path: ["value"], count: 1 },
          {
            workingArray: undefined,
            hadInitialArray: false,
            hadInitialValue: false,
          },
        ),
      ).toEqual({ ops: [], suppress: [], abandon: true });
    }
  });

  // The transaction changed the array's length ahead of the recorded tail, so
  // the base no longer lines up element-for-element with the working array's
  // prefix. The tail op cannot carry that reshape and its suppression would
  // discard the diff that can, so the intent is abandoned. A base LONGER than
  // the prefix is the corrupting direction (the store keeps the surplus and
  // appends the tail on top); the guard also covers the shorter direction, where
  // the diff alone is likewise the honest carrier.
  it("a tail op whose prefix no longer matches the base length abandons the intent", () => {
    for (const initialArrayLength of [3, 0]) {
      expect(
        buildMergeableIntent(
          { op: "add-unique", path: ["value"], count: 2 },
          {
            workingArray: ["x", "y", "z"],
            hadInitialArray: true,
            hadInitialValue: true,
            initialArrayLength,
          },
        ),
      ).toEqual({ ops: [], suppress: [], abandon: true });
    }
  });

  // The recorded tail slice is empty: an empty working array against an empty
  // base makes `array.slice(length - count)` empty, so the op carries nothing.
  it("a tail op whose recorded tail is empty abandons the intent", () => {
    expect(
      buildMergeableIntent(
        { op: "append", path: ["value"], count: 2 },
        {
          workingArray: [],
          hadInitialArray: true,
          hadInitialValue: true,
          initialArrayLength: 0,
        },
      ),
    ).toEqual({ ops: [], suppress: [], abandon: true });
  });
});
