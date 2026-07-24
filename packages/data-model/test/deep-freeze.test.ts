import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  deepFreeze,
  isDeepFrozen,
  isDeepFrozenFabricValue,
} from "@/deep-freeze.ts";
import type { FabricValue } from "@/interface.ts";
import { FabricError } from "@/fabric-instances/FabricError.ts";
import { FabricEpochNsec } from "@/fabric-primitives/FabricEpochNsec.ts";

describe("deep-freeze", () => {
  describe("isDeepFrozen", () => {
    describe("primitives", () => {
      it("returns `true` for `null`", () => {
        expect(isDeepFrozen(null)).toBe(true);
      });

      it("returns `true` for `undefined`", () => {
        expect(isDeepFrozen(undefined)).toBe(true);
      });

      it("returns `true` for a number", () => {
        expect(isDeepFrozen(42)).toBe(true);
      });

      it("returns `true` for a string", () => {
        expect(isDeepFrozen("hello")).toBe(true);
      });

      it("returns `true` for a boolean", () => {
        expect(isDeepFrozen(true)).toBe(true);
      });

      it("returns `true` for a `bigint`", () => {
        expect(isDeepFrozen(42n)).toBe(true);
      });

      it("returns `true` for a symbol", () => {
        expect(isDeepFrozen(Symbol("test"))).toBe(true);
      });
    });

    describe("functions", () => {
      it("returns `false` for an unfrozen function", () => {
        // A function is a mutable object, not necessarily frozen.
        expect(isDeepFrozen(() => {})).toBe(false);
        expect(isDeepFrozen(function () {})).toBe(false);
      });

      it("returns `false` for a frozen graph reaching a function", () => {
        expect(isDeepFrozen(Object.freeze({ fn: () => {} }))).toBe(false);
      });

      it("returns `true` for a frozen function with no mutable own properties", () => {
        expect(isDeepFrozen(Object.freeze(() => {}))).toBe(true);
      });

      it("freezes a function passed to `deepFreeze()` (no longer skipped)", () => {
        const fn = () => {};
        deepFreeze(fn);
        expect(Object.isFrozen(fn)).toBe(true);
        expect(isDeepFrozen(fn)).toBe(true);
      });
    });

    describe("objects", () => {
      it("returns `false` for an unfrozen empty object", () => {
        expect(isDeepFrozen({})).toBe(false);
      });

      it("returns `true` for a frozen empty object", () => {
        expect(isDeepFrozen(Object.freeze({}))).toBe(true);
      });

      it("returns `true` for a frozen object with primitive values", () => {
        const obj = Object.freeze({ a: 1, b: "hello", c: true, d: null });
        expect(isDeepFrozen(obj)).toBe(true);
      });

      it("returns `false` for a frozen object with an unfrozen child", () => {
        const obj = Object.freeze({ a: 1, child: { b: 2 } });
        expect(isDeepFrozen(obj)).toBe(false);
      });

      it("returns `true` for a deep-frozen nested object", () => {
        const obj = deepFreeze({ a: 1, child: { b: 2, inner: { c: 3 } } });
        expect(isDeepFrozen(obj)).toBe(true);
      });

      it("returns `true` for a frozen object with a frozen array child", () => {
        const obj = Object.freeze({ a: 1, items: Object.freeze([1, 2, 3]) });
        expect(isDeepFrozen(obj)).toBe(true);
      });

      it("returns `false` for a frozen object with an unfrozen array child", () => {
        const obj = Object.freeze({ a: 1, items: [1, 2, 3] });
        expect(isDeepFrozen(obj)).toBe(false);
      });
    });

    describe("arrays", () => {
      it("returns `false` for an unfrozen array", () => {
        expect(isDeepFrozen([1, 2, 3])).toBe(false);
      });

      it("returns `true` for a frozen array of primitives", () => {
        expect(isDeepFrozen(Object.freeze([1, "a", true, null]))).toBe(true);
      });

      it("returns `false` for a frozen array with an unfrozen object", () => {
        const arr = Object.freeze([1, { x: 2 }]);
        expect(isDeepFrozen(arr)).toBe(false);
      });

      it("returns `true` for a deep-frozen array", () => {
        const arr = deepFreeze([1, { x: 2 }, [3, 4]]);
        expect(isDeepFrozen(arr)).toBe(true);
      });
    });

    describe("sparse arrays", () => {
      it("returns `true` for a frozen sparse array", () => {
        const arr = new Array(5);
        arr[0] = 1;
        arr[3] = "hello";
        // Holes at indices 1, 2, 4
        Object.freeze(arr);
        expect(isDeepFrozen(arr)).toBe(true);
      });

      it("returns `false` for a frozen sparse array with an unfrozen object", () => {
        const arr = new Array(5);
        arr[0] = 1;
        arr[2] = { x: 2 }; // unfrozen object
        Object.freeze(arr);
        expect(isDeepFrozen(arr)).toBe(false);
      });
    });

    describe("circular references", () => {
      it("returns `true` for a circular frozen structure", () => {
        const a: Record<string, unknown> = { value: 1 };
        const b: Record<string, unknown> = { value: 2, ref: a };
        a.ref = b;
        Object.freeze(a);
        Object.freeze(b);
        expect(isDeepFrozen(a)).toBe(true);
      });

      it("returns `false` for a circular structure with an unfrozen node", () => {
        const a: Record<string, unknown> = { value: 1 };
        const b: Record<string, unknown> = { value: 2, ref: a };
        a.ref = b;
        Object.freeze(a);
        // b is NOT frozen
        expect(isDeepFrozen(a)).toBe(false);
      });
    });

    describe("caching behavior", () => {
      it("returns the same result on repeated calls (cache hit)", () => {
        const obj = deepFreeze({ a: 1, b: { c: 2 } });
        expect(isDeepFrozen(obj)).toBe(true);
        expect(isDeepFrozen(obj)).toBe(true); // should hit cache
        expect(isDeepFrozen(obj)).toBe(true); // should hit cache again
      });

      it("returns `true` after an object is frozen (no stale negative cache)", () => {
        // Regression test: isDeepFrozen must not cache `false` results, because
        // an object that is unfrozen now may be deep-frozen later.
        const obj = { a: 1, b: { c: 2 } };
        expect(isDeepFrozen(obj)).toBe(false); // unfrozen
        deepFreeze(obj);
        expect(isDeepFrozen(obj)).toBe(true); // now frozen -- must not return stale false
      });

      it("skips property traversal for a cached object", () => {
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

      it("skips element traversal for a cached array", () => {
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

    // Coverage for `isDeepFrozen` on `FabricInstance` and `FabricPrimitive`
    // inputs, including a `FabricInstance` participating in a circular
    // reference. `isDeepFrozen`'s recursion threads an `inProgress: Set<object>`
    // for cycle-safety and answers a `FabricInstance` via its `[IS_DEEP_FROZEN]`
    // protocol member -- inspecting its logical contents, not its enumerable
    // own-props -- so values held in non-enumerable slots (such as
    // `FabricError`'s private extras `Map`) are checked too.
    // (`isDeepFrozenFabricValue` uses the same protocol dispatch but
    // additionally type-guards the value as a `FabricValue`; it has its own
    // coverage in the sibling describe below.)
    describe("`FabricInstance` and `FabricPrimitive`", () => {
      it("returns `true` for a `FabricPrimitive` (self-frozen at construction)", () => {
        const epoch = new FabricEpochNsec(1234567890n);
        expect(isDeepFrozen(epoch)).toBe(true);
      });

      it("returns `false` for a pre-freeze `FabricInstance` (wrapper unfrozen)", () => {
        const fe = FabricError.fromNativeError(new Error("not-yet-frozen"));
        expect(isDeepFrozen(fe)).toBe(false);
      });

      it("returns `true` for a `FabricInstance` after `deepFreeze()` (wrapper + wrapped recursively frozen)", () => {
        const inner = new Error("cause");
        const outer = new Error("outer", { cause: inner });
        const fe = FabricError.fromNativeError(outer);
        deepFreeze(fe);
        expect(isDeepFrozen(fe)).toBe(true);
      });

      it("returns `false` for a partially-frozen `FabricInstance` (wrapper frozen but cause not)", () => {
        // FabricError no longer has a wrapped-native-Error slot; the only
        // recursing slot is `cause` (and any extras). Construct one whose
        // `cause` is a mutable plain object, freeze only the wrapper.
        const err = new Error("partial", { cause: { mutable: true } });
        const fe = FabricError.fromNativeError(err);
        Object.freeze(fe);
        // Cause is not frozen -> recursive walk discovers an unfrozen child.
        expect(isDeepFrozen(fe)).toBe(false);
      });

      it("returns `false` when an unfrozen value lives in a non-enumerable slot (extras bag)", () => {
        // A `FabricInstance`'s logical contents are not all enumerable
        // own-props: `FabricError` keeps its custom properties in a private
        // extras `Map`. A generic `Object.values` walk can't see them, so the
        // frozen-status must be answered via the instance's `[IS_DEEP_FROZEN]`
        // protocol member, which inspects the extras bag. Here the wrapper is
        // frozen and every enumerable slot is a frozen primitive, but the
        // extras bag holds a mutable array -> not deep-frozen.
        const fe = FabricError.fromNativeError(new Error("has-extras"));
        fe.setExtra("payload", [1, 2, 3] as unknown as FabricValue);
        Object.freeze(fe);
        expect(isDeepFrozen(fe)).toBe(false);
      });

      it("terminates and returns `true` post-`deepFreeze()` for a `FabricInstance` in a circular reference", () => {
        // Build a cycle: a plain-object wrapper holds the FabricError, and
        // the FabricError's `cause` points back at the wrapper. After
        // `deepFreeze(wrapper)` (which threads `inProgress` cycle-state
        // through arm 3 and arm 4), every reachable value is frozen and the
        // graph is cycle-safe for read-side traversal too. (FabricError
        // snapshots its FabricValue state at construction, so the `cause`
        // must be wired BEFORE `fromNativeError`.)
        const wrapper: Record<string, unknown> = {};
        const err = new Error("cycle-cause", { cause: wrapper });
        const fe = FabricError.fromNativeError(err);
        wrapper.fe = fe;
        deepFreeze(wrapper);
        // `isDeepFrozen` must terminate (its own `inProgress`-threading
        // recursion handles the cycle) and report true.
        expect(() => isDeepFrozen(wrapper)).not.toThrow();
        expect(isDeepFrozen(wrapper)).toBe(true);
        expect(isDeepFrozen(fe)).toBe(true);
      });
    });
  });

  describe("`deepFreeze()` protocol dispatch via `[DEEP_FREEZE]`", () => {
    describe("`FabricPrimitive` short-circuit", () => {
      it("returns the `FabricPrimitive` unchanged", () => {
        const epoch = new FabricEpochNsec(1234567890n);
        // `FabricPrimitive`s self-freeze at construction; `deepFreeze` must
        // return them unchanged without entering the object-walk.
        expect(deepFreeze(epoch)).toBe(epoch);
      });
    });

    describe("`[DEEP_FREEZE]` delegation", () => {
      it("delegates and freezes in place", () => {
        const inner = new Error("cause");
        const outer = new Error("outer", { cause: inner });
        const fe = FabricError.fromNativeError(outer);
        expect(Object.isFrozen(fe)).toBe(false);

        const result = deepFreeze(fe);

        // Freeze-in-place: same identity, now deep-frozen (wrapper + wrapped
        // Error + recursed cause).
        expect(result).toBe(fe);
        expect(Object.isFrozen(fe)).toBe(true);
        // (FabricError no longer has a wrapped Error slot to check directly;
        // the native projection is lazy, and any built projection is frozen.)
        expect(Object.isFrozen(inner)).toBe(true);
      });

      it("recurses into nested `FabricValue`s", () => {
        const fe = FabricError.fromNativeError(new Error("e"));
        const container = { wrapped: fe as unknown as FabricValue, n: 1 };
        deepFreeze(container);
        expect(Object.isFrozen(container)).toBe(true);
        expect(Object.isFrozen(fe)).toBe(true);
        // (FabricError no longer has a wrapped Error slot to check directly;
        // the native projection is lazy, and any built projection is frozen.)
      });
    });
  });

  describe("`isDeepFrozenFabricValue()` with `FabricInstance` (R6)", () => {
    it("no longer throws on a `FabricInstance`; classifies via protocol", () => {
      const fe = FabricError.fromNativeError(new Error("test"));
      // Pre-freeze: not deep-frozen, but must NOT throw (the #3604
      // `FabricInstance`-arm throw is retired).
      expect(() => isDeepFrozenFabricValue(fe)).not.toThrow();
      expect(isDeepFrozenFabricValue(fe)).toBe(false);
    });

    it("returns `true` for a deep-frozen `FabricInstance`", () => {
      const fe = FabricError.fromNativeError(new Error("test"));
      deepFreeze(fe);
      expect(isDeepFrozenFabricValue(fe)).toBe(true);
    });

    it("returns `true` for a deep-frozen `FabricInstance` nested in a tree", () => {
      const fe = FabricError.fromNativeError(new Error("nested"));
      const tree = deepFreeze({ a: 1, e: fe as unknown as FabricValue });
      expect(isDeepFrozenFabricValue(tree)).toBe(true);
    });

    it("returns `false` (no throw) for a non-canonical-form instance", () => {
      // Wrapper frozen but `cause` left unfrozen -> not deep-frozen.
      const err = new Error("partial", { cause: { mutable: true } });
      const fe = FabricError.fromNativeError(err);
      Object.freeze(fe);
      expect(() => isDeepFrozenFabricValue(fe)).not.toThrow();
      expect(isDeepFrozenFabricValue(fe)).toBe(false);
    });
  });

  describe("`isDeepFrozenFabricValue()` array structure validity", () => {
    it("returns `false` for a frozen array with enumerable named properties", () => {
      // An array carrying a named property has no fabric representation, so it
      // is not a valid `FabricValue` even when fully frozen.
      const arr = [1, 2, 3] as unknown[] & { foo?: string };
      arr.foo = "bar";
      Object.freeze(arr);
      expect(isDeepFrozenFabricValue(arr)).toBe(false);
    });

    it("returns `false` for a frozen array with named properties nested in a tree", () => {
      const arr = [1, 2] as unknown[] & { extra?: number };
      arr.extra = 42;
      const tree = Object.freeze({ data: Object.freeze(arr) });
      expect(isDeepFrozenFabricValue(tree)).toBe(false);
    });

    it("returns `true` for a frozen sparse array (holes are not named properties)", () => {
      const sparse: unknown[] = [];
      sparse[0] = 1;
      sparse[2] = 3; // hole at index 1
      Object.freeze(sparse);
      expect(isDeepFrozenFabricValue(sparse)).toBe(true);
    });
  });

  describe("`isDeepFrozenFabricValue()` symbols", () => {
    // Only registry-interned symbols are `FabricValue`s; unique (uninterned)
    // symbols are not portable across realms and are rejected, consistent with
    // `isFabricValue()` / `isFabricValueLayer()`.
    it("returns `true` for an interned symbol", () => {
      expect(isDeepFrozenFabricValue(Symbol.for("k"))).toBe(true);
    });

    it("returns `false` for a unique (uninterned) symbol", () => {
      expect(isDeepFrozenFabricValue(Symbol("k"))).toBe(false);
    });

    it("returns `false` for a frozen tree reaching a unique symbol", () => {
      const tree = Object.freeze({ a: 1, s: Symbol("nope") });
      expect(isDeepFrozenFabricValue(tree)).toBe(false);
    });

    it("returns `true` for a frozen tree reaching only interned symbols", () => {
      const tree = Object.freeze({ a: 1, s: Symbol.for("ok") });
      expect(isDeepFrozenFabricValue(tree)).toBe(true);
    });
  });

  describe("`isDeepFrozenFabricValue()` identity cache", () => {
    it("does not revalidate an already-proven frozen Fabric value", () => {
      let childReads = 0;
      const child = Object.freeze({ value: 1 });
      const value = new Proxy(Object.freeze({ child }), {
        get(target, property, receiver) {
          childReads++;
          return Reflect.get(target, property, receiver);
        },
      });
      Object.freeze(value);

      expect(isDeepFrozenFabricValue(value)).toBe(true);
      const readsAfterProof = childReads;
      expect(readsAfterProof).toBeGreaterThan(0);

      expect(isDeepFrozenFabricValue(value)).toBe(true);
      expect(childReads).toBe(readsAfterProof);
    });
  });

  // Cycle coverage for `deepFreeze()`'s arms (per the function's doc-comment
  // 4-arm dispatch) and for `isDeepFrozenFabricValue()`, which composes
  // `isFabricValue()` and `isDeepFrozen()` -- each threading its own
  // cycle-tracking set (`seen` / `inProgress`) through its recursion.
  //
  // Termination assertion: a cycle without such threading would manifest as
  // `RangeError: Maximum call stack size exceeded` (a clean fast throw, not a
  // hang). `.not.toThrow()` is the discriminating assertion for "this call
  // terminates."
  describe("cycle behavior", () => {
    describe("`deepFreeze()` (plain object / array)", () => {
      it("terminates on a self-referential plain object", () => {
        const a: Record<string, unknown> = { x: 1 };
        a.self = a;
        expect(() => deepFreeze(a)).not.toThrow();
        expect(Object.isFrozen(a)).toBe(true);
      });

      it("terminates on a self-referential array", () => {
        const arr: unknown[] = [1, 2];
        arr.push(arr);
        expect(() => deepFreeze(arr)).not.toThrow();
        expect(Object.isFrozen(arr)).toBe(true);
      });

      it("terminates on a two-node cycle through plain objects (a -> b -> a)", () => {
        const a: Record<string, unknown> = { tag: "a" };
        const b: Record<string, unknown> = { tag: "b" };
        a.next = b;
        b.next = a;
        expect(() => deepFreeze(a)).not.toThrow();
        expect(Object.isFrozen(a)).toBe(true);
        expect(Object.isFrozen(b)).toBe(true);
      });

      it("terminates on a cycle that mixes plain object and array layers", () => {
        const arr: unknown[] = [];
        const obj: Record<string, unknown> = { children: arr };
        arr.push(obj);
        expect(() => deepFreeze(obj)).not.toThrow();
        expect(Object.isFrozen(obj)).toBe(true);
        expect(Object.isFrozen(arr)).toBe(true);
      });
    });

    describe("`isDeepFrozenFabricValue()` (regression pin)", () => {
      // `isDeepFrozenFabricValue()` composes `isFabricValue()` and
      // `isDeepFrozen()`, each of which threads its own cycle-tracking set
      // through its recursion, so the composition is cycle-safe. These tests
      // pin that property so a future change does not regress it.
      it("terminates on a deep-frozen self-referential plain object", () => {
        const a: Record<string, unknown> = { x: 1 };
        a.self = a;
        Object.freeze(a);
        expect(() => isDeepFrozenFabricValue(a)).not.toThrow();
        // The graph is deep-frozen-shaped (every reachable object frozen).
        expect(isDeepFrozenFabricValue(a)).toBe(true);
      });

      it("terminates on a deep-frozen two-node cycle", () => {
        const a: Record<string, unknown> = { tag: "a" };
        const b: Record<string, unknown> = { tag: "b" };
        a.next = b;
        b.next = a;
        Object.freeze(a);
        Object.freeze(b);
        expect(() => isDeepFrozenFabricValue(a)).not.toThrow();
        expect(isDeepFrozenFabricValue(a)).toBe(true);
      });
    });
  });
});
