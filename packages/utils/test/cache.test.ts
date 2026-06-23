import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { LRUCache, TwoLevelWeakCache } from "@commonfabric/utils/cache";

describe("LRUCache", () => {
  describe("basic operations", () => {
    it("stores and retrieves values", () => {
      const cache = new LRUCache<string, number>();
      cache.put("a", 1);
      cache.put("b", 2);
      expect(cache.get("a")).toBe(1);
      expect(cache.get("b")).toBe(2);
    });

    it("returns undefined for missing keys", () => {
      const cache = new LRUCache<string, number>();
      expect(cache.get("missing")).toBe(undefined);
    });

    it("tracks size correctly", () => {
      const cache = new LRUCache<string, number>();
      expect(cache.size).toBe(0);
      cache.put("a", 1);
      expect(cache.size).toBe(1);
      cache.put("b", 2);
      expect(cache.size).toBe(2);
    });

    it("has() returns correct membership", () => {
      const cache = new LRUCache<string, number>();
      cache.put("a", 1);
      expect(cache.has("a")).toBe(true);
      expect(cache.has("b")).toBe(false);
    });

    it("updates existing keys", () => {
      const cache = new LRUCache<string, number>();
      cache.put("a", 1);
      cache.put("a", 2);
      expect(cache.get("a")).toBe(2);
      expect(cache.size).toBe(1);
    });

    it("deletes keys", () => {
      const cache = new LRUCache<string, number>();
      cache.put("a", 1);
      expect(cache.delete("a")).toBe(true);
      expect(cache.has("a")).toBe(false);
      expect(cache.size).toBe(0);
    });

    it("delete returns false for missing keys", () => {
      const cache = new LRUCache<string, number>();
      expect(cache.delete("missing")).toBe(false);
    });

    it("clears all entries", () => {
      const cache = new LRUCache<string, number>();
      cache.put("a", 1);
      cache.put("b", 2);
      cache.clear();
      expect(cache.size).toBe(0);
      expect(cache.has("a")).toBe(false);
      expect(cache.has("b")).toBe(false);
    });
  });

  describe("eviction", () => {
    it("evicts least recently used on capacity overflow", () => {
      const cache = new LRUCache<string, number>({ capacity: 3 });
      cache.put("a", 1);
      cache.put("b", 2);
      cache.put("c", 3);
      cache.put("d", 4);
      expect(cache.has("a")).toBe(false);
      expect(cache.has("b")).toBe(true);
      expect(cache.has("c")).toBe(true);
      expect(cache.has("d")).toBe(true);
      expect(cache.size).toBe(3);
    });

    it("get() promotes item to most recently used", () => {
      const cache = new LRUCache<string, number>({ capacity: 3 });
      cache.put("a", 1);
      cache.put("b", 2);
      cache.put("c", 3);
      cache.get("a");
      cache.put("d", 4);
      expect(cache.has("a")).toBe(true);
      expect(cache.has("b")).toBe(false);
      expect(cache.has("c")).toBe(true);
      expect(cache.has("d")).toBe(true);
    });

    it("put() on existing key promotes to most recently used", () => {
      const cache = new LRUCache<string, number>({ capacity: 3 });
      cache.put("a", 1);
      cache.put("b", 2);
      cache.put("c", 3);
      cache.put("a", 10);
      cache.put("d", 4);
      expect(cache.has("a")).toBe(true);
      expect(cache.get("a")).toBe(10);
      expect(cache.has("b")).toBe(false);
    });

    it("handles capacity of 1", () => {
      const cache = new LRUCache<string, number>({ capacity: 1 });
      cache.put("a", 1);
      cache.put("b", 2);
      expect(cache.size).toBe(1);
      expect(cache.has("a")).toBe(false);
      expect(cache.get("b")).toBe(2);
    });
  });

  describe("edge cases", () => {
    it("works with various key types", () => {
      const cache = new LRUCache<number, string>();
      cache.put(1, "one");
      cache.put(2, "two");
      expect(cache.get(1)).toBe("one");
      expect(cache.get(2)).toBe("two");
    });

    it("handles delete of head node", () => {
      const cache = new LRUCache<string, number>({ capacity: 3 });
      cache.put("a", 1);
      cache.put("b", 2);
      cache.put("c", 3);
      cache.delete("a");
      cache.put("d", 4);
      cache.put("e", 5);
      expect(cache.size).toBe(3);
      expect(cache.has("b")).toBe(false);
    });

    it("handles delete of tail node", () => {
      const cache = new LRUCache<string, number>({ capacity: 3 });
      cache.put("a", 1);
      cache.put("b", 2);
      cache.put("c", 3);
      cache.delete("c");
      expect(cache.size).toBe(2);
      cache.put("d", 4);
      cache.put("e", 5);
      expect(cache.has("a")).toBe(false);
    });

    it("handles delete of middle node", () => {
      const cache = new LRUCache<string, number>({ capacity: 3 });
      cache.put("a", 1);
      cache.put("b", 2);
      cache.put("c", 3);
      cache.delete("b");
      expect(cache.size).toBe(2);
      expect(cache.get("a")).toBe(1);
      expect(cache.get("c")).toBe(3);
    });

    it("get on tail node does not break list", () => {
      const cache = new LRUCache<string, number>({ capacity: 3 });
      cache.put("a", 1);
      cache.put("b", 2);
      cache.put("c", 3);
      cache.get("c");
      cache.put("d", 4);
      expect(cache.has("a")).toBe(false);
      expect(cache.has("b")).toBe(true);
      expect(cache.has("c")).toBe(true);
      expect(cache.has("d")).toBe(true);
    });
  });
});

describe("TwoLevelWeakCache", () => {
  describe("getOrCompute", () => {
    it("computes once per (outer, inner) and reuses the result", () => {
      const cache = new TwoLevelWeakCache<object, object, number>();
      const outer = {};
      const inner = {};
      let calls = 0;
      const compute = () => {
        calls++;
        return 42;
      };

      expect(cache.getOrCompute(outer, inner, compute)).toBe(42);
      expect(cache.getOrCompute(outer, inner, compute)).toBe(42);
      expect(calls).toBe(1);
    });

    it("caches an undefined result without recomputing", () => {
      const cache = new TwoLevelWeakCache<object, object, number | undefined>();
      const outer = {};
      const inner = {};
      let calls = 0;
      const compute = () => {
        calls++;
        return undefined;
      };

      expect(cache.getOrCompute(outer, inner, compute)).toBe(undefined);
      expect(cache.getOrCompute(outer, inner, compute)).toBe(undefined);
      expect(calls).toBe(1);
    });

    it("keys independently on the inner key under one outer", () => {
      const cache = new TwoLevelWeakCache<object, object, string>();
      const outer = {};
      const a = {};
      const b = {};

      expect(cache.getOrCompute(outer, a, () => "a")).toBe("a");
      expect(cache.getOrCompute(outer, b, () => "b")).toBe("b");
      // Re-reading does not collapse to a shared entry.
      expect(cache.getOrCompute(outer, a, () => "recompute")).toBe("a");
    });

    it("isolates entries across outer keys for the same inner key", () => {
      const cache = new TwoLevelWeakCache<object, object, string>();
      const outerA = {};
      const outerB = {};
      const inner = {};

      expect(cache.getOrCompute(outerA, inner, () => "from-a")).toBe("from-a");
      // Same inner object, different outer: a separate compute, no bleed.
      expect(cache.getOrCompute(outerB, inner, () => "from-b")).toBe("from-b");
      expect(cache.getOrCompute(outerA, inner, () => "ignored")).toBe("from-a");
    });
  });

  describe("innerFor", () => {
    it("returns a stable inner map per outer key", () => {
      const cache = new TwoLevelWeakCache<object, object, number>();
      const outer = {};
      expect(cache.innerFor(outer)).toBe(cache.innerFor(outer));
    });

    it("returns distinct inner maps for distinct outer keys", () => {
      const cache = new TwoLevelWeakCache<object, object, number>();
      expect(cache.innerFor({})).not.toBe(cache.innerFor({}));
    });

    it("shares state with getOrCompute under the same outer key", () => {
      const cache = new TwoLevelWeakCache<object, object, number>();
      const outer = {};
      const inner = {};
      cache.innerFor(outer).set(inner, 7);
      expect(cache.getOrCompute(outer, inner, () => 99)).toBe(7);
    });
  });
});
