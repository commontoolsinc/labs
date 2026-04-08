import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { FrozenMap, FrozenSet } from "../frozen-builtins.ts";

type MutableMapExtensions<K, V> = {
  getOrInsert(key: K, defaultValue: V): V;
  getOrInsertComputed(key: K, callback: (key: K) => V): V;
};

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

    it("rejects intrinsic Map mutators", () => {
      const fm = new FrozenMap<string, number>([["a", 1]]);
      expect(() => Map.prototype.set.call(fm, "b", 2)).toThrow();
      expect(fm.has("b")).toBe(false);
    });

    it("throws on getOrInsert()", () => {
      const fm = new FrozenMap<string, number>([["a", 1]]) as
        & FrozenMap<
          string,
          number
        >
        & MutableMapExtensions<string, number>;
      expect(() => fm.getOrInsert("b", 2)).toThrow("Cannot mutate a FrozenMap");
      expect(fm.has("b")).toBe(false);
    });

    it("throws on getOrInsertComputed() without invoking the callback", () => {
      const fm = new FrozenMap<string, number>([["a", 1]]) as
        & FrozenMap<
          string,
          number
        >
        & MutableMapExtensions<string, number>;
      let invoked = false;
      expect(() =>
        fm.getOrInsertComputed("b", () => {
          invoked = true;
          return 2;
        })
      ).toThrow("Cannot mutate a FrozenMap");
      expect(invoked).toBe(false);
      expect(fm.has("b")).toBe(false);
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

    it("builder rejects writes after finish()", () => {
      const builder = FrozenMap.createBuilder<string, number>();
      builder.set("a", 1);

      const fm = builder.finish();

      expect(() => builder.set("b", 2)).toThrow(
        "Cannot mutate a finalized FrozenMap builder",
      );
      expect([...fm.entries()]).toEqual([["a", 1]]);
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

    it("rejects intrinsic Set mutators", () => {
      const fs = new FrozenSet<number>([1]);
      expect(() => Set.prototype.add.call(fs, 2)).toThrow();
      expect(fs.has(2)).toBe(false);
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

    it("builder rejects writes after finish()", () => {
      const builder = FrozenSet.createBuilder<number>();
      builder.add(1);

      const fs = builder.finish();

      expect(() => builder.add(2)).toThrow(
        "Cannot mutate a finalized FrozenSet builder",
      );
      expect([...fs.values()]).toEqual([1]);
    });
  });
});
