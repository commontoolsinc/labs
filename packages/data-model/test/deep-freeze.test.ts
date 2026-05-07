import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { deepFreeze, isDeepFrozen } from "../deep-freeze.ts";

describe("isDeepFrozen", () => {
  describe("primitives", () => {
    it("null returns true", () => {
      expect(isDeepFrozen(null)).toBe(true);
    });

    it("undefined returns true", () => {
      expect(isDeepFrozen(undefined)).toBe(true);
    });

    it("number returns true", () => {
      expect(isDeepFrozen(42)).toBe(true);
    });

    it("string returns true", () => {
      expect(isDeepFrozen("hello")).toBe(true);
    });

    it("boolean returns true", () => {
      expect(isDeepFrozen(true)).toBe(true);
    });

    it("bigint returns true", () => {
      expect(isDeepFrozen(42n)).toBe(true);
    });

    it("symbol returns true", () => {
      expect(isDeepFrozen(Symbol("test"))).toBe(true);
    });
  });

  describe("objects", () => {
    it("unfrozen empty object returns false", () => {
      expect(isDeepFrozen({})).toBe(false);
    });

    it("frozen empty object returns true", () => {
      expect(isDeepFrozen(Object.freeze({}))).toBe(true);
    });

    it("frozen object with primitive values returns true", () => {
      const obj = Object.freeze({ a: 1, b: "hello", c: true, d: null });
      expect(isDeepFrozen(obj)).toBe(true);
    });

    it("frozen object with unfrozen child returns false", () => {
      const obj = Object.freeze({ a: 1, child: { b: 2 } });
      expect(isDeepFrozen(obj)).toBe(false);
    });

    it("deep-frozen nested object returns true", () => {
      const obj = deepFreeze({ a: 1, child: { b: 2, inner: { c: 3 } } });
      expect(isDeepFrozen(obj)).toBe(true);
    });

    it("frozen object with frozen array child returns true", () => {
      const obj = Object.freeze({ a: 1, items: Object.freeze([1, 2, 3]) });
      expect(isDeepFrozen(obj)).toBe(true);
    });

    it("frozen object with unfrozen array child returns false", () => {
      const obj = Object.freeze({ a: 1, items: [1, 2, 3] });
      expect(isDeepFrozen(obj)).toBe(false);
    });
  });

  describe("arrays", () => {
    it("unfrozen array returns false", () => {
      expect(isDeepFrozen([1, 2, 3])).toBe(false);
    });

    it("frozen array of primitives returns true", () => {
      expect(isDeepFrozen(Object.freeze([1, "a", true, null]))).toBe(true);
    });

    it("frozen array with unfrozen object returns false", () => {
      const arr = Object.freeze([1, { x: 2 }]);
      expect(isDeepFrozen(arr)).toBe(false);
    });

    it("deep-frozen array returns true", () => {
      const arr = deepFreeze([1, { x: 2 }, [3, 4]]);
      expect(isDeepFrozen(arr)).toBe(true);
    });
  });

  describe("sparse arrays", () => {
    it("frozen sparse array returns true", () => {
      const arr = new Array(5);
      arr[0] = 1;
      arr[3] = "hello";
      // Holes at indices 1, 2, 4
      Object.freeze(arr);
      expect(isDeepFrozen(arr)).toBe(true);
    });

    it("frozen sparse array with unfrozen object returns false", () => {
      const arr = new Array(5);
      arr[0] = 1;
      arr[2] = { x: 2 }; // unfrozen object
      Object.freeze(arr);
      expect(isDeepFrozen(arr)).toBe(false);
    });
  });

  describe("circular references", () => {
    it("circular frozen structure returns true", () => {
      const a: Record<string, unknown> = { value: 1 };
      const b: Record<string, unknown> = { value: 2, ref: a };
      a.ref = b;
      Object.freeze(a);
      Object.freeze(b);
      expect(isDeepFrozen(a)).toBe(true);
    });

    it("circular structure with unfrozen node returns false", () => {
      const a: Record<string, unknown> = { value: 1 };
      const b: Record<string, unknown> = { value: 2, ref: a };
      a.ref = b;
      Object.freeze(a);
      // b is NOT frozen
      expect(isDeepFrozen(a)).toBe(false);
    });
  });

  describe("caching behavior", () => {
    it("repeated calls return same result (cache hit)", () => {
      const obj = deepFreeze({ a: 1, b: { c: 2 } });
      expect(isDeepFrozen(obj)).toBe(true);
      expect(isDeepFrozen(obj)).toBe(true); // should hit cache
      expect(isDeepFrozen(obj)).toBe(true); // should hit cache again
    });

    it("returns true after object is frozen (no stale negative cache)", () => {
      // Regression test: isDeepFrozen must not cache `false` results, because
      // an object that is unfrozen now may be deep-frozen later.
      const obj = { a: 1, b: { c: 2 } };
      expect(isDeepFrozen(obj)).toBe(false); // unfrozen
      deepFreeze(obj);
      expect(isDeepFrozen(obj)).toBe(true); // now frozen -- must not return stale false
    });

    it("cached object skips property traversal", () => {
      // Verify caching actually works by wrapping a frozen object in a Proxy
      // that counts property accesses. First call should access properties;
      // second call should hit the cache and skip traversal.
      const inner = Object.freeze({ x: 1, y: 2 });
      let accessCount = 0;
      const proxy = new Proxy(inner, {
        get(target, prop, receiver) {
          accessCount++;
          return Reflect.get(target, prop, receiver);
        },
      });
      // Freeze the proxy itself (Proxy forwards Object.freeze to target).
      Object.freeze(proxy);

      // First call: traverses properties.
      expect(isDeepFrozen(proxy)).toBe(true);
      const firstCallAccesses = accessCount;

      // Second call: should hit cache -- no additional property accesses.
      accessCount = 0;
      expect(isDeepFrozen(proxy)).toBe(true);
      expect(accessCount).toBe(0);

      // Sanity: first call did access properties.
      expect(firstCallAccesses).toBeGreaterThan(0);
    });

    it("cached array skips element traversal", () => {
      const inner = Object.freeze([1, 2, 3]);
      let accessCount = 0;
      const proxy = new Proxy(inner, {
        get(target, prop, receiver) {
          accessCount++;
          return Reflect.get(target, prop, receiver);
        },
      });
      Object.freeze(proxy);

      expect(isDeepFrozen(proxy)).toBe(true);
      const firstCallAccesses = accessCount;

      accessCount = 0;
      expect(isDeepFrozen(proxy)).toBe(true);
      expect(accessCount).toBe(0);
      expect(firstCallAccesses).toBeGreaterThan(0);
    });
  });
});
