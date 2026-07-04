// Covers the Fabric-aware equality of `mapsEqual` (CT-1770). The helper
// compares stored read-value maps; a `FabricPrimitive` keeps its state in
// private `#fields` with zero enumerable own-props, so a naive `deepEqual`
// conflates every distinct same-class instance and reports maps that differ
// only in a `FabricBytes` value as equal -- masking a real change.

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";
import type { FabricValue } from "@commonfabric/data-model/fabric-value";
import { mapsEqual } from "../src/scheduler/topology.ts";

describe("mapsEqual", () => {
  it("treats maps equal when values are structurally equal", () => {
    const a = new Map<string, FabricValue>([["k", 1]]);
    const b = new Map<string, FabricValue>([["k", 1]]);
    expect(mapsEqual(a, b)).toBe(true);
  });

  it("treats maps unequal when a plain value differs", () => {
    const a = new Map<string, FabricValue>([["k", 1]]);
    const b = new Map<string, FabricValue>([["k", 2]]);
    expect(mapsEqual(a, b)).toBe(false);
  });

  it("is Fabric-aware: equal FabricBytes values keep the maps equal", () => {
    const a = new Map<string, FabricValue>([
      ["k", new FabricBytes(new Uint8Array([1, 2, 3]))],
    ]);
    const b = new Map<string, FabricValue>([
      ["k", new FabricBytes(new Uint8Array([1, 2, 3]))],
    ]);
    expect(mapsEqual(a, b)).toBe(true);
  });

  it("is Fabric-aware: a differing FabricBytes value makes the maps unequal (CT-1770)", () => {
    // The two maps differ only in the byte content of a `FabricBytes` value.
    // `deepEqual` sees two zero-own-prop instances of the same class and calls
    // them equal, so `mapsEqual` wrongly returns `true`; `valueEqual` compares
    // by content hash and sees the difference.
    const a = new Map<string, FabricValue>([
      ["k", new FabricBytes(new Uint8Array([1, 2, 3]))],
    ]);
    const b = new Map<string, FabricValue>([
      ["k", new FabricBytes(new Uint8Array([4, 5, 6]))],
    ]);
    expect(mapsEqual(a, b)).toBe(false);
  });
});
