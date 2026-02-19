import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { FrozenDate, FrozenMap, FrozenSet } from "../frozen-builtins.ts";

// ============================================================================
// Tests
// ============================================================================

describe("frozen-builtins", () => {
  // --------------------------------------------------------------------------
  // FrozenMap
  // --------------------------------------------------------------------------

  describe("FrozenMap", () => {
    it("is instanceof Map", () => {
      const fm = new FrozenMap([["a", 1]]);
      expect(fm).toBeInstanceOf(Map);
      expect(fm instanceof Map).toBe(true);
    });

    it("is Object.isFrozen", () => {
      const fm = new FrozenMap([["a", 1]]);
      expect(Object.isFrozen(fm)).toBe(true);
    });

    it("supports read operations", () => {
      const fm = new FrozenMap<string, number>([["a", 1], ["b", 2]]);
      expect(fm.size).toBe(2);
      expect(fm.get("a")).toBe(1);
      expect(fm.get("b")).toBe(2);
      expect(fm.has("a")).toBe(true);
      expect(fm.has("b")).toBe(true);
      expect(fm.has("c")).toBe(false);
      expect([...fm.keys()]).toEqual(["a", "b"]);
      expect([...fm.values()]).toEqual([1, 2]);
      expect([...fm.entries()]).toEqual([["a", 1], ["b", 2]]);
    });

    it("throws on set()", () => {
      const fm = new FrozenMap<string, number>([["a", 1]]);
      expect(() => fm.set("b", 2)).toThrow("Cannot mutate a FrozenMap");
    });

    it("throws on delete()", () => {
      const fm = new FrozenMap<string, number>([["a", 1]]);
      expect(() => fm.delete("a")).toThrow("Cannot mutate a FrozenMap");
    });

    it("throws on clear()", () => {
      const fm = new FrozenMap<string, number>([["a", 1]]);
      expect(() => fm.clear()).toThrow("Cannot mutate a FrozenMap");
    });

    it("supports forEach iteration", () => {
      const fm = new FrozenMap([["x", 10], ["y", 20]]);
      const entries: [string, number][] = [];
      fm.forEach((v, k) => entries.push([k, v]));
      expect(entries).toEqual([["x", 10], ["y", 20]]);
    });

    it("supports empty construction", () => {
      const fm = new FrozenMap();
      expect(fm.size).toBe(0);
    });

    it("supports null entries argument", () => {
      const fm = new FrozenMap(null);
      expect(fm.size).toBe(0);
    });
  });

  // --------------------------------------------------------------------------
  // FrozenSet
  // --------------------------------------------------------------------------

  describe("FrozenSet", () => {
    it("is instanceof Set", () => {
      const fs = new FrozenSet([1, 2, 3]);
      expect(fs).toBeInstanceOf(Set);
      expect(fs instanceof Set).toBe(true);
    });

    it("is Object.isFrozen", () => {
      const fs = new FrozenSet([1, 2, 3]);
      expect(Object.isFrozen(fs)).toBe(true);
    });

    it("supports read operations", () => {
      const fs = new FrozenSet<number>([1, 2, 3]);
      expect(fs.size).toBe(3);
      expect(fs.has(1)).toBe(true);
      expect(fs.has(4)).toBe(false);
      expect([...fs.values()]).toEqual([1, 2, 3]);
    });

    it("throws on add()", () => {
      const fs = new FrozenSet<number>([1]);
      expect(() => fs.add(2)).toThrow("Cannot mutate a FrozenSet");
    });

    it("throws on delete()", () => {
      const fs = new FrozenSet<number>([1]);
      expect(() => fs.delete(1)).toThrow("Cannot mutate a FrozenSet");
    });

    it("throws on clear()", () => {
      const fs = new FrozenSet<number>([1]);
      expect(() => fs.clear()).toThrow("Cannot mutate a FrozenSet");
    });

    it("supports forEach iteration", () => {
      const fs = new FrozenSet([10, 20, 30]);
      const values: number[] = [];
      fs.forEach((v) => values.push(v));
      expect(values).toEqual([10, 20, 30]);
    });

    it("supports empty construction", () => {
      const fs = new FrozenSet();
      expect(fs.size).toBe(0);
    });

    it("supports null values argument", () => {
      const fs = new FrozenSet(null);
      expect(fs.size).toBe(0);
    });
  });

  // --------------------------------------------------------------------------
  // FrozenDate
  // --------------------------------------------------------------------------

  describe("FrozenDate", () => {
    it("is instanceof Date", () => {
      const fd = new FrozenDate("2024-01-01");
      expect(fd instanceof Date).toBe(true);
    });

    it("is Object.isFrozen", () => {
      const fd = new FrozenDate("2024-01-01");
      expect(Object.isFrozen(fd)).toBe(true);
    });

    it("preserves the time value", () => {
      const original = new Date("2024-06-15T12:30:00Z");
      const fd = new FrozenDate(original);
      expect(fd.getTime()).toBe(original.getTime());
      expect(fd.toISOString()).toBe(original.toISOString());
    });

    it("supports construction from number", () => {
      const ts = Date.now();
      const fd = new FrozenDate(ts);
      expect(fd.getTime()).toBe(ts);
    });

    it("supports construction from string", () => {
      const fd = new FrozenDate("2024-01-01T00:00:00Z");
      expect(fd.toISOString()).toBe("2024-01-01T00:00:00.000Z");
    });

    it("supports read operations", () => {
      const fd = new FrozenDate("2024-06-15T12:30:45.123Z");
      expect(fd.getFullYear()).toBe(2024);
      expect(fd.getUTCMonth()).toBe(5); // June = 5
      expect(fd.getUTCDate()).toBe(15);
      expect(fd.getUTCHours()).toBe(12);
      expect(fd.getUTCMinutes()).toBe(30);
      expect(fd.getUTCSeconds()).toBe(45);
      expect(fd.getUTCMilliseconds()).toBe(123);
    });

    it("throws on setTime()", () => {
      const fd = new FrozenDate("2024-01-01");
      expect(() => fd.setTime(0)).toThrow("Cannot mutate a FrozenDate");
    });

    it("throws on setMilliseconds()", () => {
      const fd = new FrozenDate("2024-01-01");
      expect(() => fd.setMilliseconds(500)).toThrow(
        "Cannot mutate a FrozenDate",
      );
    });

    it("throws on setUTCMilliseconds()", () => {
      const fd = new FrozenDate("2024-01-01");
      expect(() => fd.setUTCMilliseconds(500)).toThrow(
        "Cannot mutate a FrozenDate",
      );
    });

    it("throws on setSeconds()", () => {
      const fd = new FrozenDate("2024-01-01");
      expect(() => fd.setSeconds(30)).toThrow("Cannot mutate a FrozenDate");
    });

    it("throws on setUTCSeconds()", () => {
      const fd = new FrozenDate("2024-01-01");
      expect(() => fd.setUTCSeconds(30)).toThrow(
        "Cannot mutate a FrozenDate",
      );
    });

    it("throws on setMinutes()", () => {
      const fd = new FrozenDate("2024-01-01");
      expect(() => fd.setMinutes(15)).toThrow("Cannot mutate a FrozenDate");
    });

    it("throws on setUTCMinutes()", () => {
      const fd = new FrozenDate("2024-01-01");
      expect(() => fd.setUTCMinutes(15)).toThrow(
        "Cannot mutate a FrozenDate",
      );
    });

    it("throws on setHours()", () => {
      const fd = new FrozenDate("2024-01-01");
      expect(() => fd.setHours(6)).toThrow("Cannot mutate a FrozenDate");
    });

    it("throws on setUTCHours()", () => {
      const fd = new FrozenDate("2024-01-01");
      expect(() => fd.setUTCHours(6)).toThrow("Cannot mutate a FrozenDate");
    });

    it("throws on setDate()", () => {
      const fd = new FrozenDate("2024-01-01");
      expect(() => fd.setDate(15)).toThrow("Cannot mutate a FrozenDate");
    });

    it("throws on setUTCDate()", () => {
      const fd = new FrozenDate("2024-01-01");
      expect(() => fd.setUTCDate(15)).toThrow("Cannot mutate a FrozenDate");
    });

    it("throws on setMonth()", () => {
      const fd = new FrozenDate("2024-01-01");
      expect(() => fd.setMonth(6)).toThrow("Cannot mutate a FrozenDate");
    });

    it("throws on setUTCMonth()", () => {
      const fd = new FrozenDate("2024-01-01");
      expect(() => fd.setUTCMonth(6)).toThrow("Cannot mutate a FrozenDate");
    });

    it("throws on setFullYear()", () => {
      const fd = new FrozenDate("2024-01-01");
      expect(() => fd.setFullYear(2025)).toThrow(
        "Cannot mutate a FrozenDate",
      );
    });

    it("throws on setUTCFullYear()", () => {
      const fd = new FrozenDate("2024-01-01");
      expect(() => fd.setUTCFullYear(2025)).toThrow(
        "Cannot mutate a FrozenDate",
      );
    });
  });
});
