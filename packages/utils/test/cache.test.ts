import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { LRUCache, WeightedLRUCache } from "@commonfabric/utils/cache";

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

describe("WeightedLRUCache", () => {
  it("stores and retrieves values, tracking total weight", () => {
    const cache = new WeightedLRUCache<string, number>({ maxWeight: 100 });
    cache.put("a", 1, 10);
    cache.put("b", 2, 20);
    expect(cache.get("a")).toBe(1);
    expect(cache.get("b")).toBe(2);
    expect(cache.size).toBe(2);
    expect(cache.totalWeight).toBe(30);
  });

  it("evicts least-recently-used entries when over the weight budget", () => {
    const cache = new WeightedLRUCache<string, number>({ maxWeight: 100 });
    cache.put("a", 1, 40);
    cache.put("b", 2, 40);
    cache.put("c", 3, 40); // exceeds 100: evicts "a"
    expect(cache.has("a")).toBe(false);
    expect(cache.get("b")).toBe(2);
    expect(cache.get("c")).toBe(3);
    expect(cache.totalWeight).toBe(80);
  });

  it("a heavy entry evicts as many light entries as needed", () => {
    const cache = new WeightedLRUCache<string, number>({ maxWeight: 100 });
    cache.put("a", 1, 30);
    cache.put("b", 2, 30);
    cache.put("c", 3, 30);
    cache.put("big", 4, 90); // evicts a, b, c
    expect(cache.has("a")).toBe(false);
    expect(cache.has("b")).toBe(false);
    expect(cache.has("c")).toBe(false);
    expect(cache.get("big")).toBe(4);
    expect(cache.totalWeight).toBe(90);
  });

  it("get refreshes recency so hot entries survive eviction", () => {
    const cache = new WeightedLRUCache<string, number>({ maxWeight: 100 });
    cache.put("a", 1, 40);
    cache.put("b", 2, 40);
    cache.get("a"); // "a" now most recent
    cache.put("c", 3, 40); // evicts "b", not "a"
    expect(cache.get("a")).toBe(1);
    expect(cache.has("b")).toBe(false);
    expect(cache.get("c")).toBe(3);
  });

  it("does not store entries heavier than the whole budget", () => {
    const cache = new WeightedLRUCache<string, number>({ maxWeight: 100 });
    cache.put("a", 1, 40);
    cache.put("huge", 2, 101);
    expect(cache.has("huge")).toBe(false);
    // Existing entries survive the refused insert.
    expect(cache.get("a")).toBe(1);
    expect(cache.totalWeight).toBe(40);
  });

  it("an oversize re-put removes the existing entry under that key", () => {
    const cache = new WeightedLRUCache<string, number>({ maxWeight: 100 });
    cache.put("a", 1, 40);
    cache.put("a", 2, 101);
    expect(cache.has("a")).toBe(false);
    expect(cache.totalWeight).toBe(0);
  });

  it("re-put under the same key replaces value and weight", () => {
    const cache = new WeightedLRUCache<string, number>({ maxWeight: 100 });
    cache.put("a", 1, 40);
    cache.put("a", 2, 60);
    expect(cache.get("a")).toBe(2);
    expect(cache.size).toBe(1);
    expect(cache.totalWeight).toBe(60);
  });

  it("delete removes an entry and its weight", () => {
    const cache = new WeightedLRUCache<string, number>({ maxWeight: 100 });
    cache.put("a", 1, 40);
    cache.put("b", 2, 40);
    expect(cache.delete("a")).toBe(true);
    expect(cache.delete("a")).toBe(false);
    expect(cache.has("a")).toBe(false);
    expect(cache.totalWeight).toBe(40);
  });

  it("clear empties the cache", () => {
    const cache = new WeightedLRUCache<string, number>({ maxWeight: 100 });
    cache.put("a", 1, 40);
    cache.put("b", 2, 40);
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.totalWeight).toBe(0);
    expect(cache.has("a")).toBe(false);
  });

  it("zero-weight entries are admitted and never trigger eviction", () => {
    const cache = new WeightedLRUCache<string, number>({ maxWeight: 10 });
    for (let i = 0; i < 100; i++) {
      cache.put(`k${i}`, i, 0);
    }
    expect(cache.size).toBe(100);
    expect(cache.totalWeight).toBe(0);
  });

  it("rejects invalid weights", () => {
    const cache = new WeightedLRUCache<string, number>({ maxWeight: 10 });
    expect(() => cache.put("a", 1, -1)).toThrow();
    expect(() => cache.put("a", 1, Number.NaN)).toThrow();
    expect(() => cache.put("a", 1, Infinity)).toThrow();
  });
});
