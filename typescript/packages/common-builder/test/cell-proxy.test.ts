import { describe, it, expect } from "vitest";
import { isCellProxy } from "../src/types.js";
import { cell } from "../src/cell-proxy.js";

describe("cell function", () => {
  it("creates a cell proxy", () => {
    const c = cell<number>();
    expect(isCellProxy(c)).toBe(true);
  });

  it("supports set methods", () => {
    const c = cell<number>();
    c.set(5);
    const v = c.export();
    expect(v.path).toEqual([]);
    expect(v.value).toBe(5);
  });

  it("supports default value methods", () => {
    const c = cell<number>();
    c.setDefault(5);
    const v = c.export();
    expect(v.path).toEqual([]);
    expect(v.value).toBe(undefined);
    expect(v.defaultValue).toBe(5);
    expect(v.nodes.size).toBe(0);
  });

  it("returns itself on get", () => {
    const c = cell<number>();
    expect(c.get() === c).toBe(true);
  });

  it("supports nested values", () => {
    const c = cell<{ a: number; b: string }>();
    c.a.set(5);
    c.b.set("test");
    const v = c.export();
    expect(v.path).toEqual([]);
    expect(v.value).toEqual({ a: 5, b: "test" });
  });

  it("supports nested default values", () => {
    const c = cell<{ a: number; b: string }>();
    c.a.setDefault(5);
    c.b.setDefault("test");
    const v = c.export();
    expect(v.path).toEqual([]);
    expect(v.defaultValue).toEqual({ a: 5, b: "test" });
  });
});
