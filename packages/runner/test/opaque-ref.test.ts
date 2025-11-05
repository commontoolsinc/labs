import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { type Frame, isOpaqueRef } from "../src/builder/types.ts";
import { opaqueRef } from "../src/builder/opaque-ref.ts";
import { popFrame, pushFrame } from "../src/builder/recipe.ts";

describe("opaqueRef function", () => {
  let frame: Frame;

  beforeEach(() => {
    frame = pushFrame();
  });

  afterEach(() => {
    popFrame(frame);
  });

  it("creates an opaque ref", () => {
    const c = opaqueRef<number>();
    expect(isOpaqueRef(c)).toBe(true);
  });

  it("supports set methods", () => {
    const c = opaqueRef<number>();
    c.set(5);
    const v = c.export();
    expect(v.path).toEqual([]);
    // value is stored in the legacy store
    expect(v.nodes.size).toBe(0);
  });

  it("throws on get", () => {
    const c = opaqueRef<number>();
    expect(() => c.get()).toThrow();
  });

  it("supports nested values", () => {
    const c = opaqueRef<{ a: number; b: string }>();
    c.a.set(5);
    c.b.set("test");
    const v = c.export();
    expect(v.path).toEqual([]);
    // Nested values are stored in the legacy store
  });
});
