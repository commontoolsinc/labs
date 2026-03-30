import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { FabricInstance, FabricPrimitive } from "../interface.ts";
import { FabricBytes } from "../fabric-bytes.ts";

describe("FabricBytes", () => {
  it("extends FabricPrimitive (not FabricInstance)", () => {
    const fb = new FabricBytes(new Uint8Array([1, 2, 3]));
    expect(fb instanceof FabricPrimitive).toBe(true);
    expect(fb instanceof FabricInstance).toBe(false);
  });

  it("is always frozen", () => {
    const fb = new FabricBytes(new Uint8Array([1, 2, 3]));
    expect(Object.isFrozen(fb)).toBe(true);
  });

  it("length returns byte count", () => {
    expect(new FabricBytes(new Uint8Array([1, 2, 3])).length).toBe(3);
    expect(new FabricBytes(new Uint8Array()).length).toBe(0);
  });

  it("slice() returns a copy of the bytes", () => {
    const original = new Uint8Array([10, 20, 30]);
    const fb = new FabricBytes(original);
    const sliced = fb.slice();
    expect(sliced).toEqual(new Uint8Array([10, 20, 30]));
    // Must be a copy, not the same reference.
    sliced[0] = 99;
    expect(fb.slice()[0]).toBe(10);
  });

  it("slice(start, end) returns a sub-range", () => {
    const fb = new FabricBytes(new Uint8Array([1, 2, 3, 4, 5]));
    expect(fb.slice(1, 3)).toEqual(new Uint8Array([2, 3]));
    expect(fb.slice(3)).toEqual(new Uint8Array([4, 5]));
  });

  it("copyInto copies bytes into target", () => {
    const fb = new FabricBytes(new Uint8Array([10, 20, 30, 40]));
    const target = new Uint8Array(4);
    const copied = fb.copyInto(target);
    expect(copied).toBe(4);
    expect(target).toEqual(new Uint8Array([10, 20, 30, 40]));
  });

  it("copyInto respects offset and length", () => {
    const fb = new FabricBytes(new Uint8Array([10, 20, 30, 40, 50]));
    const target = new Uint8Array(2);
    const copied = fb.copyInto(target, 1, 2);
    expect(copied).toBe(2);
    expect(target).toEqual(new Uint8Array([20, 30]));
  });

  it("copyInto throws on negative offset", () => {
    const fb = new FabricBytes(new Uint8Array([1, 2, 3]));
    const target = new Uint8Array(3);
    expect(() => fb.copyInto(target, -1)).toThrow(RangeError);
  });

  it("copyInto throws on negative length", () => {
    const fb = new FabricBytes(new Uint8Array([1, 2, 3]));
    const target = new Uint8Array(3);
    expect(() => fb.copyInto(target, 0, -1)).toThrow(RangeError);
  });

  it("constructor copies input bytes", () => {
    const original = new Uint8Array([1, 2, 3]);
    const fb = new FabricBytes(original);
    original[0] = 99; // mutate original
    expect(fb.slice()[0]).toBe(1); // unaffected
  });
});
