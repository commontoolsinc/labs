import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { type Frame, isOpaqueRef, isShadowRef } from "../src/types.ts";
import { createShadowRef, opaqueRef } from "../src/opaque-ref.ts";
import { popFrame, pushFrame } from "../src/recipe.ts";

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
    expect(v.value).toBe(5);
  });

  it("supports default value methods", () => {
    const c = opaqueRef<number>();
    c.setDefault(5);
    const v = c.export();
    expect(v.path).toEqual([]);
    expect(v.value).toBe(undefined);
    expect(v.defaultValue).toBe(5);
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
    expect(v.value).toEqual({ a: 5, b: "test" });
  });

  it("supports nested default values", () => {
    const c = opaqueRef<{ a: number; b: string }>();
    c.a.setDefault(5);
    c.b.setDefault("test");
    const v = c.export();
    expect(v.path).toEqual([]);
    expect(v.defaultValue).toEqual({ a: 5, b: "test" });
  });
});

describe("shadowRef function", () => {
  let frame: Frame;

  beforeEach(() => {
    frame = pushFrame();
  });

  afterEach(() => {
    popFrame(frame);
  });

  it("creates a shadow ref", () => {
    const ref = opaqueRef();
    const frame = pushFrame();
    const shadow = createShadowRef(ref);
    popFrame(frame);
    expect(isShadowRef(shadow)).toBe(true);
    expect(shadow.shadowOf).toBe(ref);
  });

  it("creates a shadow ref two levels deep", () => {
    const ref = opaqueRef();
    const frame1 = pushFrame();
    const frame2 = pushFrame();
    const shadow = createShadowRef(ref);
    popFrame(frame2);
    popFrame(frame1);
    expect(isShadowRef(shadow)).toBe(true);
    expect(shadow.shadowOf).toBe(ref);
  });
});
