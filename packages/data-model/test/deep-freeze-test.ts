import { describe, it } from "@std/testing/bdd";
import { assertEquals } from "@std/assert";
import { deepFreeze, isDeepFrozen } from "../deep-freeze.ts";

describe("isDeepFrozen", () => {
  describe("primitives", () => {
    it("null returns true", () => {
      assertEquals(isDeepFrozen(null), true);
    });

    it("undefined returns true", () => {
      assertEquals(isDeepFrozen(undefined), true);
    });

    it("number returns true", () => {
      assertEquals(isDeepFrozen(42), true);
    });

    it("string returns true", () => {
      assertEquals(isDeepFrozen("hello"), true);
    });

    it("boolean returns true", () => {
      assertEquals(isDeepFrozen(true), true);
    });

    it("bigint returns true", () => {
      assertEquals(isDeepFrozen(42n), true);
    });

    it("symbol returns true", () => {
      assertEquals(isDeepFrozen(Symbol("test")), true);
    });
  });

  describe("objects", () => {
    it("unfrozen empty object returns false", () => {
      assertEquals(isDeepFrozen({}), false);
    });

    it("frozen empty object returns true", () => {
      assertEquals(isDeepFrozen(Object.freeze({})), true);
    });

    it("frozen object with primitive values returns true", () => {
      const obj = Object.freeze({ a: 1, b: "hello", c: true, d: null });
      assertEquals(isDeepFrozen(obj), true);
    });

    it("frozen object with unfrozen child returns false", () => {
      const obj = Object.freeze({ a: 1, child: { b: 2 } });
      assertEquals(isDeepFrozen(obj), false);
    });

    it("deep-frozen nested object returns true", () => {
      const obj = deepFreeze({ a: 1, child: { b: 2, inner: { c: 3 } } });
      assertEquals(isDeepFrozen(obj), true);
    });

    it("frozen object with frozen array child returns true", () => {
      const obj = Object.freeze({ a: 1, items: Object.freeze([1, 2, 3]) });
      assertEquals(isDeepFrozen(obj), true);
    });

    it("frozen object with unfrozen array child returns false", () => {
      const obj = Object.freeze({ a: 1, items: [1, 2, 3] });
      assertEquals(isDeepFrozen(obj), false);
    });
  });

  describe("arrays", () => {
    it("unfrozen array returns false", () => {
      assertEquals(isDeepFrozen([1, 2, 3]), false);
    });

    it("frozen array of primitives returns true", () => {
      assertEquals(isDeepFrozen(Object.freeze([1, "a", true, null])), true);
    });

    it("frozen array with unfrozen object returns false", () => {
      const arr = Object.freeze([1, { x: 2 }]);
      assertEquals(isDeepFrozen(arr), false);
    });

    it("deep-frozen array returns true", () => {
      const arr = deepFreeze([1, { x: 2 }, [3, 4]]);
      assertEquals(isDeepFrozen(arr), true);
    });
  });

  describe("sparse arrays", () => {
    it("frozen sparse array returns true", () => {
      const arr = new Array(5);
      arr[0] = 1;
      arr[3] = "hello";
      // Holes at indices 1, 2, 4
      Object.freeze(arr);
      assertEquals(isDeepFrozen(arr), true);
    });

    it("frozen sparse array with unfrozen object returns false", () => {
      const arr = new Array(5);
      arr[0] = 1;
      arr[2] = { x: 2 }; // unfrozen object
      Object.freeze(arr);
      assertEquals(isDeepFrozen(arr), false);
    });
  });

  describe("circular references", () => {
    it("circular frozen structure returns true", () => {
      const a: Record<string, unknown> = { value: 1 };
      const b: Record<string, unknown> = { value: 2, ref: a };
      a.ref = b;
      Object.freeze(a);
      Object.freeze(b);
      assertEquals(isDeepFrozen(a), true);
    });

    it("circular structure with unfrozen node returns false", () => {
      const a: Record<string, unknown> = { value: 1 };
      const b: Record<string, unknown> = { value: 2, ref: a };
      a.ref = b;
      Object.freeze(a);
      // b is NOT frozen
      assertEquals(isDeepFrozen(a), false);
    });
  });

  describe("caching behavior", () => {
    it("repeated calls return same result (cache hit)", () => {
      const obj = deepFreeze({ a: 1, b: { c: 2 } });
      assertEquals(isDeepFrozen(obj), true);
      assertEquals(isDeepFrozen(obj), true); // should hit cache
      assertEquals(isDeepFrozen(obj), true); // should hit cache again
    });

    it("returns true after object is frozen (no stale negative cache)", () => {
      // Regression test: isDeepFrozen must not cache `false` results, because
      // an object that is unfrozen now may be deep-frozen later.
      const obj = { a: 1, b: { c: 2 } };
      assertEquals(isDeepFrozen(obj), false); // unfrozen
      deepFreeze(obj);
      assertEquals(isDeepFrozen(obj), true); // now frozen -- must not return stale false
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
      assertEquals(isDeepFrozen(proxy), true);
      const firstCallAccesses = accessCount;

      // Second call: should hit cache -- no additional property accesses.
      accessCount = 0;
      assertEquals(isDeepFrozen(proxy), true);
      assertEquals(
        accessCount,
        0,
        "cached check should not access any properties",
      );

      // Sanity: first call did access properties.
      assertEquals(firstCallAccesses > 0, true, "first call should traverse");
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

      assertEquals(isDeepFrozen(proxy), true);
      const firstCallAccesses = accessCount;

      accessCount = 0;
      assertEquals(isDeepFrozen(proxy), true);
      assertEquals(
        accessCount,
        0,
        "cached check should not access any properties",
      );
      assertEquals(firstCallAccesses > 0, true, "first call should traverse");
    });
  });
});
