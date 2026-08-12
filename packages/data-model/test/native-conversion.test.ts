/**
 * Converting between native JS values and fabric values, in both directions
 * and at both depths, plus the predicate saying in advance whether a value
 * will make it across.
 *
 * Refusal is central here rather than incidental: conversion is a vetting
 * boundary, and a value that cannot be represented has to be rejected rather
 * than approximated into something that merely looks representable. A
 * function, a class instance, an array carrying non-index properties, an
 * `Array` subclass, a cycle -- each is refused, and refused at whatever depth
 * it turns up.
 *
 * One group appears three times over, once per entry point, to pin something
 * the conversion deliberately does not do: `toJSON()` is never consulted. A
 * value does not get to nominate its own fabric form, because a method is code
 * and the decision has to rest on what the value is.
 *
 * The remainder is the structure that has to survive the trip: an object
 * reached twice stays shared, sparse holes and `undefined` elements are
 * preserved rather than filled in, and an `Error` carries its cause and its
 * own properties across.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  FabricInstance,
  type FabricOrConvertibleNativeValue,
  type FabricValue,
} from "@/interface.ts";
import { CODEC } from "@/codec-common/interface.ts";
import { CODEC_TYPE_TAGS } from "@/codec-common/codec-type-tags.ts";
import { FabricError } from "@/fabric-instances/FabricError.ts";
import { FabricMap } from "@/fabric-instances/FabricMap.ts";
import { FabricSet } from "@/fabric-instances/FabricSet.ts";
import { FabricBytes } from "@/fabric-primitives/FabricBytes.ts";
import { FabricEpochNsec } from "@/fabric-primitives/FabricEpochNsec.ts";
import { FabricRegExp } from "@/fabric-primitives/FabricRegExp.ts";
import {
  fabricFromNativeValue,
  isConvertibleNativeInstance,
  isFabricCompatible,
  nativeFromFabricValue,
  shallowCleanArray,
  shallowCleanPlainObject,
  shallowFabricFromNativeValue,
} from "@/native-conversion.ts";
import { isArrayWithOnlyIndexProperties } from "@commonfabric/utils/arrays";
import { isInertPlainObject } from "@commonfabric/utils/objects";
import { FrozenMap, FrozenSet } from "@/frozen-builtins.ts";
import { UnknownValue } from "@/fabric-instances/UnknownValue.ts";
import { ProblematicValue } from "@/fabric-instances/ProblematicValue.ts";
import {
  BaseFabricInstance,
  DEEP_CLONE_CORE,
  DEEP_FREEZE,
  IS_DEEP_FROZEN,
  SHALLOW_UNFROZEN_CLONE,
} from "@/fabric-instances/BaseFabricInstance.ts";
import { deepFreeze, isDeepFrozen } from "@/deep-freeze.ts";
import { DummyReconstructionContext } from "./fabric-instances/fixtures.ts";

/**
 * Helper for the round-trip tests, which encodes a value to fabric form via
 * `fabricFromNativeValue()` and decodes it back to native form via
 * `nativeFromFabricValue()`.
 */
function roundTrip(value: FabricValue): FabricOrConvertibleNativeValue {
  return nativeFromFabricValue(fabricFromNativeValue(value));
}

describe("native-conversion", () => {
  describe("nativeFromFabricValue()", () => {
    it("round-trips primitives", () => {
      expect(roundTrip(42)).toBe(42);
      expect(roundTrip("hello")).toBe("hello");
      expect(roundTrip(null)).toBe(null);
      expect(roundTrip(true)).toBe(true);
    });

    it("round-trips `undefined`", () => {
      expect(roundTrip(undefined)).toBe(undefined);
    });

    it("round-trips `bigint`", () => {
      expect(roundTrip(42n)).toBe(42n);
    });

    it("round-trips plain objects", () => {
      const value = { a: 1, b: "two" };
      expect(roundTrip(value)).toEqual({ a: 1, b: "two" });
    });

    it("round-trips arrays", () => {
      const value = [1, "two", null];
      expect(roundTrip(value)).toEqual([1, "two", null]);
    });

    it("round-trips nested structure (including `bigint` and `undefined`)", () => {
      const value = {
        name: "test",
        count: 42n,
        missing: undefined,
      };
      const result = roundTrip(value) as Record<string, unknown>;
      expect(result.name).toBe("test");
      expect(result.count).toBe(42n);
      expect(result.missing).toBe(undefined);
    });

    it("unwraps a `FabricError` back to a native `Error`", () => {
      const error = new Error("test error");
      const stored = fabricFromNativeValue(error);
      const restored = nativeFromFabricValue(stored);
      expect(restored).toBeInstanceOf(Error);
      expect((restored as Error).message).toBe("test error");
    });

    it("unwraps `FabricError` in nested object", () => {
      const se = FabricError.fromNativeError(new Error("deep"));
      const obj = { error: se };
      const result = nativeFromFabricValue(obj) as Record<
        string,
        unknown
      >;
      expect(result.error).toBeInstanceOf(Error);
      expect((result.error as Error).message).toBe("deep");
    });

    it("unwraps `FabricMap` in nested array", () => {
      const sm = new FabricMap(
        new Map<FabricValue, FabricValue>([["k", "v"]]),
      );
      const arr = [sm];
      const result = nativeFromFabricValue(arr) as unknown[];
      expect(result[0]).toBeInstanceOf(FrozenMap);
    });

    it("unwraps `FabricMap` to mutable `Map` when `frozen=false`", () => {
      const sm = new FabricMap(
        new Map<FabricValue, FabricValue>([["k", "v"]]),
      );
      const arr = [sm];
      const result = nativeFromFabricValue(arr, false) as unknown[];
      expect(result[0]).toBeInstanceOf(Map);
      expect(result[0]).not.toBeInstanceOf(FrozenMap);
    });

    it("passes through primitives at all levels", () => {
      const obj = { a: 1, b: "two", c: null, d: true };
      const result = nativeFromFabricValue(obj) as Record<
        string,
        unknown
      >;
      expect(result).toEqual({ a: 1, b: "two", c: null, d: true });
    });

    it("recursively unwraps nested structures", () => {
      const se = FabricError.fromNativeError(new Error("nested"));
      const obj = {
        outer: {
          inner: se,
        },
      };
      const result = nativeFromFabricValue(obj) as {
        outer: { inner: Error };
      };
      expect(result.outer.inner).toBeInstanceOf(Error);
      expect(result.outer.inner.message).toBe("nested");
    });

    it("deeply unwraps `FabricError` in objects (frozen)", () => {
      const err = new Error("deep");
      const se = FabricError.fromNativeError(err);
      const obj = {
        error: se,
        code: 500,
      };
      const result = nativeFromFabricValue(obj) as Record<
        string,
        unknown
      >;
      expect(result.error).toBeInstanceOf(Error);
      expect((result.error as Error).message).toBe("deep");
      expect(Object.isFrozen(result.error)).toBe(true);
      expect(result.code).toBe(500);
      expect(Object.isFrozen(result)).toBe(true);
    });

    it("restores an overridden `name` when unwrapping a `FabricError`", () => {
      const err = new TypeError("renamed");
      err.name = "CustomName";
      const se = FabricError.fromNativeError(err);
      const result = nativeFromFabricValue(
        se,
      ) as Error;

      expect(result).toBeInstanceOf(TypeError);
      expect(result.name).toBe("CustomName");
      expect(result.message).toBe("renamed");
    });

    it("leaves the class's own `name` in place when not overridden", () => {
      const se = FabricError.fromNativeError(new TypeError("plain"));
      const result = nativeFromFabricValue(
        se,
      ) as Error;

      expect(result).toBeInstanceOf(TypeError);
      expect(result.name).toBe("TypeError");
    });

    it("deeply unwraps `FabricError` in arrays (frozen)", () => {
      const err = new Error("array");
      const se = FabricError.fromNativeError(err);
      const arr = [1, se, 3];
      const result = nativeFromFabricValue(arr) as unknown[];
      expect(result[0]).toBe(1);
      expect(result[1]).toBeInstanceOf(Error);
      expect((result[1] as Error).message).toBe("array");
      expect(Object.isFrozen(result[1])).toBe(true);
      expect(result[2]).toBe(3);
      expect(Object.isFrozen(result)).toBe(true);
    });

    it("leaves output unfrozen when `frozen=false`", () => {
      const obj = Object.freeze({
        a: 1,
        b: "two",
      });
      const result = nativeFromFabricValue(obj, false) as Record<
        string,
        unknown
      >;
      // Output should be a new, unfrozen object.
      expect(Object.isFrozen(result)).toBe(false);
      result.a = 99; // should not throw
      expect(result.a).toBe(99);
    });

    it("freezes output when `frozen=true` (default)", () => {
      const obj = { a: 1, b: "two" };
      const result = nativeFromFabricValue(obj) as Record<
        string,
        unknown
      >;
      expect(Object.isFrozen(result)).toBe(true);
    });

    it("preserves sparse holes", () => {
      const arr = new Array(3);
      arr[0] = 1;
      arr[2] = 3;
      Object.freeze(arr);
      const result = nativeFromFabricValue(
        arr,
      ) as unknown[];
      expect(result.length).toBe(3);
      expect(result[0]).toBe(1);
      expect(1 in result).toBe(false); // hole preserved
      expect(result[2]).toBe(3);
    });

    it("passes through non-native `FabricInstance`", () => {
      const us = new UnknownValue("Test@1", null);
      const obj = { thing: us };
      const result = nativeFromFabricValue(obj) as Record<
        string,
        unknown
      >;
      expect(result.thing).toBe(us);
    });

    it("deeply unwraps `FabricMap` to `FrozenMap`", () => {
      const map = new Map<FabricValue, FabricValue>([
        ["x", 10],
      ] as [FabricValue, FabricValue][]);
      const sm = new FabricMap(map);
      const obj = { data: sm };
      const result = nativeFromFabricValue(obj) as Record<
        string,
        unknown
      >;
      expect(result.data).toBeInstanceOf(FrozenMap);
      expect((result.data as Map<string, number>).get("x")).toBe(10);
    });

    it("deeply unwraps `FabricSet` to `FrozenSet`", () => {
      const set = new Set<FabricValue>([42]);
      const ss = new FabricSet(set);
      const arr = [ss];
      const result = nativeFromFabricValue(arr) as unknown[];
      expect(result[0]).toBeInstanceOf(FrozenSet);
      expect((result[0] as Set<number>).has(42)).toBe(true);
    });

    it("deeply unwraps `Error` internals (C2)", () => {
      // `Error` with a `FabricError` cause and a custom `FabricMap` property.
      const innerErr = new Error("inner");
      const innerSe = FabricError.fromNativeError(innerErr);
      const outerErr = new Error("outer");
      outerErr.cause = innerSe;
      (outerErr as unknown as Record<string, unknown>).data = new FabricMap(
        new Map([["k", 1]] as [FabricValue, FabricValue][]),
      );
      const outerSe = FabricError.fromNativeError(outerErr);

      const result = nativeFromFabricValue(
        outerSe,
      ) as Error;
      expect(result).toBeInstanceOf(Error);
      expect(result.message).toBe("outer");
      // cause should be deeply unwrapped to a native Error, not FabricError.
      expect(result.cause).toBeInstanceOf(Error);
      expect((result.cause as Error).message).toBe("inner");
      // custom property should be unwrapped to FrozenMap.
      const data = (result as unknown as Record<string, unknown>).data;
      expect(data).toBeInstanceOf(FrozenMap);
    });

    it("deeply unwraps `Error` internals unfrozen (C2)", () => {
      const innerErr = new Error("inner");
      const innerSe = FabricError.fromNativeError(innerErr);
      const outerErr = new Error("outer");
      outerErr.cause = innerSe;
      const outerSe = FabricError.fromNativeError(outerErr);

      const result = nativeFromFabricValue(
        outerSe,
        false,
      ) as Error;
      expect(result).toBeInstanceOf(Error);
      expect(Object.isFrozen(result)).toBe(false);
      expect(result.cause).toBeInstanceOf(Error);
      expect(Object.isFrozen(result.cause)).toBe(false);
    });
  });

  describe("isConvertibleNativeInstance()", () => {
    it("returns `true` for all convertible types", () => {
      expect(isConvertibleNativeInstance(new Error("e"))).toBe(true);
      expect(isConvertibleNativeInstance(new TypeError("e"))).toBe(true);
      expect(isConvertibleNativeInstance(new Map())).toBe(true);
      expect(isConvertibleNativeInstance(new Set())).toBe(true);
      expect(isConvertibleNativeInstance(new Date())).toBe(true);
      expect(isConvertibleNativeInstance(new Uint8Array())).toBe(true);
    });

    it("returns `true` for exotic `Error` subclass", () => {
      class WeirdError extends RangeError {}
      expect(isConvertibleNativeInstance(new WeirdError("weird"))).toBe(true);
    });

    it("returns `true` for `RegExp`", () => {
      expect(isConvertibleNativeInstance(/abc/)).toBe(true);
    });

    it("returns `false` for non-convertible types", () => {
      expect(isConvertibleNativeInstance({})).toBe(false);
      expect(isConvertibleNativeInstance([])).toBe(false);
      expect(isConvertibleNativeInstance(new WeakMap())).toBe(false);
    });

    it("returns `false` for objects with `toJSON()`", () => {
      expect(isConvertibleNativeInstance({ toJSON: () => "x" })).toBe(false);
    });
  });

  describe("FabricInstance instanceof checks", () => {
    it("returns `false` for `null`", () => {
      expect((null as unknown) instanceof FabricInstance).toBe(false);
    });

    it("returns `false` for `undefined`", () => {
      expect((undefined as unknown) instanceof FabricInstance).toBe(false);
    });

    it("returns `false` for primitives", () => {
      expect((42 as unknown) instanceof FabricInstance).toBe(false);
      expect(("hello" as unknown) instanceof FabricInstance).toBe(false);
      expect((true as unknown) instanceof FabricInstance).toBe(false);
    });

    it("returns `false` for plain objects", () => {
      expect(({} as unknown) instanceof FabricInstance).toBe(false);
      expect(({ a: 1 } as unknown) instanceof FabricInstance).toBe(false);
    });

    it("returns `true` for `UnknownValue`", () => {
      const us = new UnknownValue("Test@1", null);
      expect(us instanceof FabricInstance).toBe(true);
    });

    it("returns `true` for `ProblematicValue`", () => {
      const ps = new ProblematicValue("Test@1", null, "oops");
      expect(ps instanceof FabricInstance).toBe(true);
    });

    it("returns `true` for custom `FabricInstance` subclass", () => {
      class CustomFabInst extends BaseFabricInstance {
        get wireTypeTag(): string {
          return "Custom@914";
        }

        [DEEP_FREEZE](
          _subFreeze: (value: FabricValue) => FabricValue,
        ): FabricValue {
          return this;
        }
        [IS_DEEP_FROZEN](
          _subIsDeepFrozen: (value: FabricValue) => boolean,
        ): boolean {
          return Object.isFrozen(this);
        }
        protected [DEEP_CLONE_CORE](_frozen: boolean): CustomFabInst {
          return new CustomFabInst();
        }
        protected [SHALLOW_UNFROZEN_CLONE](): CustomFabInst {
          return new CustomFabInst();
        }
      }
      const instance = new CustomFabInst();
      expect(instance instanceof FabricInstance).toBe(true);
    });

    it("returns `true` for `FabricError`", () => {
      const se = FabricError.fromNativeError(new Error("test"));
      expect(se instanceof FabricInstance).toBe(true);
    });
  });

  describe("codec `decode()` honors `shouldDeepFreeze`", () => {
    const frozenCtx = new DummyReconstructionContext(true);
    const mutableCtx = new DummyReconstructionContext(false);

    it("`FabricError`: `shouldDeepFreeze` is `true` => deep-frozen, `false` => mutable", () => {
      const state = {
        type: "Error",
        name: null,
        message: "boom",
      };
      const frozen = FabricError[CODEC].decode(
        CODEC_TYPE_TAGS.Error,
        state,
        frozenCtx,
      );
      expect(isDeepFrozen(frozen)).toBe(true);
      const mutable = FabricError[CODEC].decode(
        CODEC_TYPE_TAGS.Error,
        state,
        mutableCtx,
      );
      expect(Object.isFrozen(mutable)).toBe(false);
    });

    it("`ProblematicValue`: `shouldDeepFreeze` is `true` => deep-frozen, `false` => mutable", () => {
      // Tag travels separately; the bare inner state is the codec payload.
      const state = { x: 1 };
      const frozen = ProblematicValue[CODEC].decode("Bad@1", state, frozenCtx);
      expect(isDeepFrozen(frozen)).toBe(true);
      const mutable = ProblematicValue[CODEC].decode(
        "Bad@1",
        state,
        mutableCtx,
      );
      expect(Object.isFrozen(mutable)).toBe(false);
    });

    it("`UnknownValue`: `shouldDeepFreeze` is `true` => deep-frozen, `false` => mutable", () => {
      const state = { y: 2 };
      const frozen = UnknownValue[CODEC].decode("Fancy@3", state, frozenCtx);
      expect(isDeepFrozen(frozen)).toBe(true);
      const mutable = UnknownValue[CODEC].decode("Fancy@3", state, mutableCtx);
      expect(Object.isFrozen(mutable)).toBe(false);
    });
  });

  // Cycle-capable wired impls: `FabricError` (recurses through `error.cause`
  // + custom enumerable own properties), `ProblematicValue` (recurses through
  // `state`), `UnknownValue` (recurses through `state`).
  //
  // Termination assertion: a cycle without shared-`inProgress` threading
  // would manifest as `RangeError: Maximum call stack size exceeded` (a
  // clean fast throw, not a hang); `.not.toThrow()` is the discriminating
  // assertion.
  describe("cycle behavior via `[DEEP_FREEZE]`", () => {
    it("`FabricError`: cycle through `error.cause` terminates", () => {
      // Build a cycle: a plain-object wrapper holds the FabricError, and the
      // FabricError's `error.cause` points back at the wrapper. When
      // `deepFreeze(wrapper)` runs Arm 4 it recurses into the FabricError
      // (Arm 3), which subFreezes `error.cause` = wrapper, which re-enters
      // `deepFreeze()` -> the FabricError again -> ...
      const err = new Error("cycle-cause");
      const fe = FabricError.fromNativeError(err);
      const wrapper: Record<string, unknown> = { fe };
      err.cause = wrapper;
      expect(() => deepFreeze(wrapper)).not.toThrow();
      expect(Object.isFrozen(wrapper)).toBe(true);
      expect(Object.isFrozen(fe)).toBe(true);
    });

    it("`ProblematicValue`: cycle through `state` terminates", () => {
      const cycle: Record<string, unknown> = { x: 1 };
      const pv = new ProblematicValue("Cycle@1", cycle as FabricValue, "oops");
      cycle.back = pv;
      expect(() => deepFreeze(pv)).not.toThrow();
      expect(Object.isFrozen(pv)).toBe(true);
      expect(Object.isFrozen(cycle)).toBe(true);
    });

    it("`UnknownValue`: cycle through `state` terminates", () => {
      const cycle: Record<string, unknown> = { y: 2 };
      const uv = new UnknownValue("Cycle@1", cycle as FabricValue);
      cycle.back = uv;
      expect(() => deepFreeze(uv)).not.toThrow();
      expect(Object.isFrozen(uv)).toBe(true);
      expect(Object.isFrozen(cycle)).toBe(true);
    });

    it("terminates on a cross-instance cycle (`FabricError` <-> `ProblematicValue`)", () => {
      // Two `FabricInstance` subclasses pointing into each other via their
      // recursing slots. Both must terminate, both must end deep-frozen.
      // FabricError snapshots its FabricValue state at construction, so wire
      // up the native Error's `cause` BEFORE `fromNativeError`.
      const peShared: Record<string, unknown> = { tag: "shared" };
      const pv = new ProblematicValue(
        "Cycle@1",
        peShared as FabricValue,
        "loop",
      );
      const err = new Error("cross-cycle") as Error & { cause: unknown };
      err.cause = pv;
      const fe = FabricError.fromNativeError(err);
      peShared.fe = fe;
      expect(() => deepFreeze(fe)).not.toThrow();
      expect(Object.isFrozen(fe)).toBe(true);
      expect(Object.isFrozen(pv)).toBe(true);
      expect(Object.isFrozen(peShared)).toBe(true);
    });
  });
  describe("shallowFabricFromNativeValue()", () => {
    describe("passes through primitives", () => {
      it("passes through booleans", () => {
        expect(shallowFabricFromNativeValue(true)).toBe(true);
        expect(shallowFabricFromNativeValue(false)).toBe(false);
      });

      it("passes through strings", () => {
        expect(shallowFabricFromNativeValue("hello")).toBe("hello");
        expect(shallowFabricFromNativeValue("")).toBe("");
      });

      it("passes through finite numbers", () => {
        expect(shallowFabricFromNativeValue(42)).toBe(42);
        expect(shallowFabricFromNativeValue(-3.14)).toBe(-3.14);
        expect(shallowFabricFromNativeValue(0)).toBe(0);
      });

      it("passes through `null`", () => {
        expect(shallowFabricFromNativeValue(null)).toBe(null);
      });

      it("passes through `undefined`", () => {
        expect(shallowFabricFromNativeValue(undefined)).toBe(undefined);
      });
    });

    describe("copies and freezes containers", () => {
      it("returns a frozen copy of a plain object", () => {
        const obj = { a: 1, b: "two" };
        const result = shallowFabricFromNativeValue(obj);
        expect(result).not.toBe(obj);
        expect(result).toEqual({ a: 1, b: "two" });
        expect(Object.isFrozen(result)).toBe(true);
        // The original is left untouched.
        expect(Object.isFrozen(obj)).toBe(false);
      });

      it("returns a frozen copy of a dense array", () => {
        const arr = [1, 2, 3];
        const result = shallowFabricFromNativeValue(arr);
        expect(result).not.toBe(arr);
        expect(result).toEqual([1, 2, 3]);
        expect(Object.isFrozen(result)).toBe(true);
        expect(Object.isFrozen(arr)).toBe(false);
      });

      it("preserves sparse holes in the copy", () => {
        const sparse: unknown[] = [];
        sparse[0] = 1;
        sparse[2] = 3; // hole at index 1
        const result = shallowFabricFromNativeValue(sparse) as unknown[];
        expect(result).not.toBe(sparse);
        expect(result[0]).toBe(1);
        expect(1 in result).toBe(false); // hole preserved
        expect(result[2]).toBe(3);
        expect(result.length).toBe(3);
      });

      it("preserves multiple sparse holes in the copy", () => {
        const sparse: unknown[] = [];
        sparse[0] = "a";
        sparse[3] = "b"; // holes at indices 1 and 2
        sparse[5] = "c"; // hole at index 4
        const result = shallowFabricFromNativeValue(sparse) as unknown[];
        expect(result[0]).toBe("a");
        expect(1 in result).toBe(false);
        expect(2 in result).toBe(false);
        expect(result[3]).toBe("b");
        expect(4 in result).toBe(false);
        expect(result[5]).toBe("c");
        expect(result.length).toBe(6);
      });

      it("preserves `undefined` elements", () => {
        const result = shallowFabricFromNativeValue([1, undefined, 3]);
        expect(result).toEqual([1, undefined, 3]);
        expect((result as unknown[])[1]).toBe(undefined);
      });

      it("throws for arrays with enumerable named properties", () => {
        const arr = [1, 2, 3] as unknown[] & { foo?: string };
        arr.foo = "bar";
        expect(() => shallowFabricFromNativeValue(arr)).toThrow(
          "Not representable as a `FabricValue`: array that is not an inert array",
        );
      });

      it("throws for arrays with a getter-backed index", () => {
        const arr = [1, 2, 3];
        Object.defineProperty(arr, 1, {
          get: () => 22,
          enumerable: true,
          configurable: true,
        });
        expect(() => shallowFabricFromNativeValue(arr)).toThrow(
          "Not representable as a `FabricValue`: array that is not an inert array",
        );
      });
    });

    describe("converts native instances", () => {
      it("wraps `Error` as a `FabricError`", () => {
        const error = new Error("test message");
        const result = shallowFabricFromNativeValue(error);
        expect(result).toBeInstanceOf(FabricError);
        const fe = result as FabricError;
        expect(fe.name).toBe("Error");
        expect(fe.message).toBe("test message");
        expect(typeof fe.stack).toBe("string");
      });

      it("preserves an `Error` subclass `name`", () => {
        const error = new TypeError("type error message");
        const result = shallowFabricFromNativeValue(error) as FabricError;
        expect(result.name).toBe("TypeError");
        expect(result.message).toBe("type error message");
      });

      it("preserves custom enumerable properties on an `Error`", () => {
        const error = new Error("with extras") as Error & {
          code: number;
          detail: string;
        };
        error.code = 404;
        error.detail = "Not Found";
        const result = shallowFabricFromNativeValue(error) as FabricError;
        expect(result.message).toBe("with extras");
        expect(result.getExtra("code")).toBe(404);
        expect(result.getExtra("detail")).toBe("Not Found");
      });

      it("leaves an `Error` `cause` unconverted (shallow)", () => {
        // Shallow conversion wraps the top-level `Error` but does not recurse
        // into its `cause`, which therefore stays a raw `Error`.
        const cause = new Error("root cause");
        const error = new Error("wrapper", { cause });
        const result = shallowFabricFromNativeValue(error) as FabricError;
        expect(result.message).toBe("wrapper");
        expect(result.cause).toBe(cause);
      });

      it("converts a `Date` to a `FabricEpochNsec`", () => {
        const date = new Date("2024-01-15T12:00:00.000Z");
        const result = shallowFabricFromNativeValue(date);
        expect(result).toBeInstanceOf(FabricEpochNsec);
      });

      it("converts a `RegExp` to a `FabricRegExp`", () => {
        const result = shallowFabricFromNativeValue(/abc/gi);
        expect(result).toBeInstanceOf(FabricRegExp);
      });

      it("converts a `Uint8Array` to a `FabricBytes`", () => {
        const bytes = new Uint8Array([1, 2, 3]);
        const result = shallowFabricFromNativeValue(bytes);
        expect(result).toBeInstanceOf(FabricBytes);
        expect((result as FabricBytes).slice()).toEqual(bytes);
      });
    });

    describe("passes Fabric values through", () => {
      it("passes a `FabricPrimitive` value through unchanged", () => {
        const bytes = new FabricBytes(new Uint8Array([1, 2, 3]));
        expect(shallowFabricFromNativeValue(bytes)).toBe(bytes);
      });

      it("passes a frozen `FabricInstance` value through unchanged", () => {
        const fe = Object.freeze(
          FabricError.fromNativeError(new Error("test")),
        );
        expect(shallowFabricFromNativeValue(fe)).toBe(fe);
      });
    });

    // "Death before confusion": a native type with a dedicated fabric
    // representation carries no room for extra state, so silently dropping it
    // would lose data on a round trip.
    describe("rejects extra enumerable properties", () => {
      it("throws for a `Date` carrying an extra property", () => {
        const date = new Date(0) as Date & { extra?: number };
        date.extra = 1;
        expect(() => shallowFabricFromNativeValue(date)).toThrow(
          "Not representable as a `FabricValue`: `Date` with extra enumerable properties",
        );
      });

      it("still converts a `Date` with no extra properties", () => {
        expect(() => shallowFabricFromNativeValue(new Date(0))).not.toThrow();
      });
    });

    describe("throws for non-convertible values", () => {
      it("throws for a bare function", () => {
        expect(() => shallowFabricFromNativeValue(() => {})).toThrow(
          "Not representable as a `FabricValue`: function",
        );
      });

      it("throws for a function carrying members", () => {
        const fn = Object.assign(() => {}, { label: "annotated" });
        expect(() => shallowFabricFromNativeValue(fn)).toThrow(
          "Not representable as a `FabricValue`: function",
        );
      });

      it("throws for a class instance", () => {
        class Plain {}
        expect(() => shallowFabricFromNativeValue(new Plain())).toThrow(
          "not a recognized fabric type",
        );
      });
    });

    // A value that has no fabric representation of its own does not acquire
    // one by naming the JSON protocol's method, and a record that happens to
    // carry that name is read as the record it is.
    describe("`toJSON()` is intentionally not supported", () => {
      it("throws for a function carrying `toJSON()`", () => {
        const fn = Object.assign(() => {}, {
          toJSON: () => "converted function",
        });
        expect(() => shallowFabricFromNativeValue(fn)).toThrow(
          "Not representable as a `FabricValue`: function",
        );
      });

      it("throws for a class instance carrying `toJSON()`", () => {
        class WithToJSON {
          toJSON() {
            return { converted: true };
          }
        }
        expect(() => shallowFabricFromNativeValue(new WithToJSON())).toThrow(
          "not a recognized fabric type",
        );
      });

      it("returns a plain object's `toJSON` as an ordinary member", () => {
        // Shallow conversion validates the container, not its members, so the
        // method comes through as the value it is rather than being called.
        const toJSON = () => ({ exposed: true });
        expect(shallowFabricFromNativeValue({ secret: "internal", toJSON }))
          .toEqual({ secret: "internal", toJSON });
      });

      it("throws for an array carrying `toJSON()`", () => {
        // An array is answered by the array rule whatever it carries, and that
        // rule rejects the named own property `toJSON` is.
        const arr = [1, 2, 3] as unknown[] & { toJSON?: () => unknown };
        arr.toJSON = () => "custom array";
        expect(() => shallowFabricFromNativeValue(arr)).toThrow(
          "Not representable as a `FabricValue`: array that is not an inert array",
        );
      });
    });

    // `-0`, `NaN`, `+Infinity`, and `-Infinity` are valid `FabricValue`
    // members and pass through unchanged.
    describe("property names this runtime reserves", () => {
      // A restriction of this runtime rather than of the data model: such an
      // object is perfectly inert, and its keys are strings like any other.
      // `__proto__` is refused because the assignment that rebuilds records
      // cannot create it, `constructor` because other boundaries here already
      // drop or refuse it.
      it("throws for `__proto__`, naming it as the cause", () => {
        expect(() => fabricFromNativeValue({ ["__proto__"]: 1, a: 2 })).toThrow(
          "Not representable as a `FabricValue`: object with a property name " +
            "this runtime reserves (`__proto__`)",
        );
      });

      it("throws for `constructor`, naming it as the cause", () => {
        // Type dispatch reads the constructor from the prototype, so an own
        // `constructor` property does not decide the value's type. It reaches
        // the object rule, which names it as the reserved property it is.
        expect(() => fabricFromNativeValue({ ["constructor"]: "c" })).toThrow(
          "Not representable as a `FabricValue`: object with a property name " +
            "this runtime reserves (`constructor`)",
        );
        expect(() => fabricFromNativeValue({ ["constructor"]: Error })).toThrow(
          "this runtime reserves (`constructor`)",
        );
      });

      it("throws for a reserved name nested in the graph", () => {
        expect(() => fabricFromNativeValue({ a: { ["__proto__"]: 1 } }))
          .toThrow("this runtime reserves (`__proto__`)");
        expect(() => fabricFromNativeValue([{ ["__proto__"]: 1 }])).toThrow(
          "this runtime reserves (`__proto__`)",
        );
      });
    });

    describe("special numbers", () => {
      it("passes `NaN` through", () => {
        expect(Number.isNaN(shallowFabricFromNativeValue(NaN))).toBe(true);
      });

      it("passes `+/-Infinity` through", () => {
        expect(shallowFabricFromNativeValue(Infinity)).toBe(Infinity);
        expect(shallowFabricFromNativeValue(-Infinity)).toBe(-Infinity);
      });

      it("preserves the sign of `-0`", () => {
        expect(Object.is(shallowFabricFromNativeValue(-0), -0)).toBe(true);
      });
    });

    // Registry-interned symbols (`Symbol.for(key)`) are fabric primitives and
    // pass through; unique symbols (`Symbol(desc)`) are rejected.
    describe("interned symbols", () => {
      it("passes an interned symbol through", () => {
        const sym = Symbol.for("k");
        // Interned symbols are primitives -- pass-through, no wrapping.
        expect(shallowFabricFromNativeValue(sym)).toBe(sym);
      });

      it("throws on a unique symbol", () => {
        expect(() => shallowFabricFromNativeValue(Symbol("nope"))).toThrow(
          "Not representable as a `FabricValue`: unique (uninterned) symbol",
        );
      });
    });

    describe("`freeze` parameter", () => {
      it("freezes plain objects by default", () => {
        const result = shallowFabricFromNativeValue({ a: 1 });
        expect(Object.isFrozen(result)).toBe(true);
      });

      it("freezes arrays by default", () => {
        const result = shallowFabricFromNativeValue([1, 2, 3]);
        expect(Object.isFrozen(result)).toBe(true);
      });

      it("does not freeze plain objects when `freeze=false`", () => {
        const result = shallowFabricFromNativeValue({ a: 1 }, false);
        expect(Object.isFrozen(result)).toBe(false);
      });

      it("does not freeze arrays when `freeze=false`", () => {
        const result = shallowFabricFromNativeValue([1, 2, 3], false);
        expect(Object.isFrozen(result)).toBe(false);
      });

      it("wraps `Error` even when `freeze=false`", () => {
        const error = new Error("test");
        const result = shallowFabricFromNativeValue(error, false);
        expect(result).not.toBe(error);
        expect(Object.isFrozen(result)).toBe(false);
      });

      it("leaves primitives unaffected by the `freeze` parameter", () => {
        expect(shallowFabricFromNativeValue(42, false)).toBe(42);
        expect(shallowFabricFromNativeValue("hello", false)).toBe("hello");
        expect(shallowFabricFromNativeValue(true, false)).toBe(true);
        expect(shallowFabricFromNativeValue(null, false)).toBe(null);
        expect(shallowFabricFromNativeValue(undefined, false)).toBe(
          undefined,
        );
        expect(shallowFabricFromNativeValue(BigInt(42), false)).toBe(
          BigInt(42),
        );
      });

      it("does not freeze the original array", () => {
        const arr = [1, 2, 3];
        shallowFabricFromNativeValue(arr, true);
        expect(Object.isFrozen(arr)).toBe(false);
      });

      it("does not freeze the original plain object", () => {
        const obj = { a: 1, b: 2 };
        shallowFabricFromNativeValue(obj, true);
        expect(Object.isFrozen(obj)).toBe(false);
      });

      it("returns a frozen copy for arrays when `freeze=true`", () => {
        const arr = [1, 2, 3];
        const result = shallowFabricFromNativeValue(arr, true);
        expect(Object.isFrozen(result)).toBe(true);
        expect(result).not.toBe(arr);
      });

      it("returns a frozen copy for plain objects when `freeze=true`", () => {
        const obj = { a: 1, b: 2 };
        const result = shallowFabricFromNativeValue(obj, true);
        expect(Object.isFrozen(result)).toBe(true);
        expect(result).not.toBe(obj);
      });

      it("returns mutable shallow copy of frozen plain object when `freeze=false`", () => {
        const frozen = Object.freeze({ a: 1, b: "two" });
        const result = shallowFabricFromNativeValue(frozen, false) as Record<
          string,
          unknown
        >;
        expect(Object.isFrozen(result)).toBe(false);
        expect(result).not.toBe(frozen);
        expect(result).toEqual({ a: 1, b: "two" });
        // Verify the copy is actually mutable.
        result.c = 3;
        expect(result.c).toBe(3);
      });

      it("returns mutable shallow copy of frozen array when `freeze=false`", () => {
        const frozen = Object.freeze([1, 2, 3]);
        const result = shallowFabricFromNativeValue(
          frozen,
          false,
        ) as unknown[];
        expect(Object.isFrozen(result)).toBe(false);
        expect(result).not.toBe(frozen);
        expect(Array.isArray(result)).toBe(true);
        expect(result).toEqual([1, 2, 3]);
        // Verify the copy is actually mutable.
        result.push(4);
        expect(result.length).toBe(4);
      });

      it("preserves sparse holes in frozen array copy when `freeze=false`", () => {
        const arr = [1, , 3]; // sparse array with hole at index 1
        Object.freeze(arr);
        const result = shallowFabricFromNativeValue(arr, false) as unknown[];
        expect(Object.isFrozen(result)).toBe(false);
        expect(result.length).toBe(3);
        expect(0 in result).toBe(true);
        expect(1 in result).toBe(false); // hole preserved
        expect(2 in result).toBe(true);
      });

      it("returns frozen shallow copy of mutable plain object when `freeze=true`", () => {
        const mutable = { x: 1, y: 2 };
        const result = shallowFabricFromNativeValue(mutable, true);
        expect(Object.isFrozen(result)).toBe(true);
        expect(result).not.toBe(mutable);
        // Original stays mutable.
        expect(Object.isFrozen(mutable)).toBe(false);
      });

      it("returns frozen shallow copy of mutable array when `freeze=true`", () => {
        const mutable = [10, 20, 30];
        const result = shallowFabricFromNativeValue(mutable, true);
        expect(Object.isFrozen(result)).toBe(true);
        expect(result).not.toBe(mutable);
        expect(Object.isFrozen(mutable)).toBe(false);
      });

      it("returns already-frozen object as-is when `freeze=true`", () => {
        const frozen = Object.freeze({ a: 1 });
        const result = shallowFabricFromNativeValue(frozen, true);
        expect(result).toBe(frozen); // identity -- no copy needed
      });

      it("returns already-frozen array as-is when `freeze=true`", () => {
        const frozen = Object.freeze([1, 2]);
        const result = shallowFabricFromNativeValue(frozen, true);
        expect(result).toBe(frozen); // identity -- no copy needed
      });

      it("returns mutable object as-is when `freeze=false`", () => {
        const mutable = { a: 1 };
        const result = shallowFabricFromNativeValue(mutable, false);
        expect(result).toBe(mutable); // identity -- no copy needed
      });

      it("returns mutable array as-is when `freeze=false`", () => {
        const mutable = [1, 2];
        const result = shallowFabricFromNativeValue(mutable, false);
        expect(result).toBe(mutable); // identity -- no copy needed
      });

      it("throws for a null-prototype object, frozen or not", () => {
        // A record has one shape in this system, and a prototype is not part
        // of what a value says as data -- it would not survive the first
        // encoding boundary. Rejecting says so, where accepting would mean
        // carrying a distinction that quietly stops existing.
        const obj = Object.create(null) as Record<string, unknown>;
        obj.a = 1;
        expect(() => shallowFabricFromNativeValue(obj, true)).toThrow(
          "Not representable as a `FabricValue`: object that is not an inert plain object",
        );

        Object.freeze(obj);
        expect(() => shallowFabricFromNativeValue(obj, false)).toThrow(
          "Not representable as a `FabricValue`: object that is not an inert plain object",
        );
      });

      it("converts native `Uint8Array` to `FabricBytes`", () => {
        const bytes = new Uint8Array([1, 2, 3]);
        const result = shallowFabricFromNativeValue(bytes);
        expect(result).toBeInstanceOf(FabricBytes);
        expect((result as FabricBytes).slice()).toEqual(bytes);
      });

      it("converts native `Uint8Array` to frozen `FabricBytes` by default", () => {
        const bytes = new Uint8Array([10, 20]);
        const result = shallowFabricFromNativeValue(bytes);
        expect(Object.isFrozen(result)).toBe(true);
      });

      it("always freezes `FabricBytes` (`freeze` parameter ignored)", () => {
        const bytes = new Uint8Array([10, 20]);
        const result = shallowFabricFromNativeValue(bytes, false);
        expect(result).toBeInstanceOf(FabricBytes);
        // FabricBytes extends FabricPrimitive -- always frozen.
        expect(Object.isFrozen(result)).toBe(true);
      });
    });
  });

  describe("fabricFromNativeValue()", () => {
    describe("passes through primitives", () => {
      it("passes through booleans", () => {
        expect(fabricFromNativeValue(true)).toBe(true);
        expect(fabricFromNativeValue(false)).toBe(false);
      });

      it("passes through strings", () => {
        expect(fabricFromNativeValue("hello")).toBe("hello");
      });

      it("passes through numbers", () => {
        expect(fabricFromNativeValue(42)).toBe(42);
      });

      it("passes through `null`", () => {
        expect(fabricFromNativeValue(null)).toBe(null);
      });

      it("passes through `undefined` at top level", () => {
        expect(fabricFromNativeValue(undefined)).toBe(undefined);
      });
    });

    describe("passes Fabric values through", () => {
      it("returns a `FabricPrimitive` value as-is", () => {
        const bytes = new FabricBytes(new Uint8Array([1, 2, 3]));
        expect(fabricFromNativeValue(bytes)).toBe(bytes);
      });

      it("returns an already-converted `FabricError` as-is", () => {
        // `fabricFromNativeValue(Error)` produces a deep-frozen `FabricError`;
        // feeding that back in is an identity passthrough.
        const fe = fabricFromNativeValue(new Error("test"));
        expect(fabricFromNativeValue(fe)).toBe(fe);
      });
    });

    describe("recursively processes arrays", () => {
      it("returns a new array", () => {
        const arr = [1, 2, 3];
        const result = fabricFromNativeValue(arr);
        expect(result).toEqual([1, 2, 3]);
        expect(result).not.toBe(arr);
      });

      it("converts nested instances", () => {
        const date = new Date("2024-01-15T12:00:00.000Z");
        const result = fabricFromNativeValue([date]) as unknown[];
        expect(result[0]).toBeInstanceOf(FabricEpochNsec);
      });

      it("recursively processes nested arrays", () => {
        const date = new Date("2024-01-15T12:00:00.000Z");
        const result = fabricFromNativeValue([[date]]) as unknown[][];
        expect(result[0]![0]).toBeInstanceOf(FabricEpochNsec);
      });
    });

    describe("recursively processes objects", () => {
      it("returns a new object", () => {
        const obj = { a: 1 };
        const result = fabricFromNativeValue(obj);
        expect(result).toEqual({ a: 1 });
        expect(result).not.toBe(obj);
      });

      it("converts nested instances", () => {
        const date = new Date("2024-01-15T12:00:00.000Z");
        const result = fabricFromNativeValue({ date }) as {
          date: unknown;
        };
        expect(result.date).toBeInstanceOf(FabricEpochNsec);
      });

      it("recursively processes nested objects", () => {
        const date = new Date("2024-01-15T12:00:00.000Z");
        const result = fabricFromNativeValue({ outer: { date } }) as {
          outer: { date: unknown };
        };
        expect(result.outer.date).toBeInstanceOf(FabricEpochNsec);
      });

      it("preserves `undefined` properties", () => {
        const result = fabricFromNativeValue({ a: 1, b: undefined, c: 3 });
        expect(result).toEqual({ a: 1, b: undefined, c: 3 });
        expect("b" in (result as object)).toBe(true);
      });

      it("preserves nested `undefined` properties", () => {
        const result = fabricFromNativeValue({
          outer: { keep: 1, drop: undefined },
        });
        expect(result).toEqual({ outer: { keep: 1, drop: undefined } });
      });
    });

    describe("handles shared references (same object from multiple places)", () => {
      it("duplicates a shared object reference into equal subtrees", () => {
        const shared = { value: 42 };
        const obj = { first: shared, second: shared };
        const result = fabricFromNativeValue(obj);
        expect(result).toEqual({ first: { value: 42 }, second: { value: 42 } });
      });

      it("duplicates a shared array reference into equal subtrees", () => {
        const shared = [1, 2, 3];
        const obj = { a: shared, b: shared };
        const result = fabricFromNativeValue(obj);
        expect(result).toEqual({ a: [1, 2, 3], b: [1, 2, 3] });
      });

      it("returns same result for shared sparse arrays", () => {
        const sparse: unknown[] = [];
        sparse[0] = 1;
        sparse[2] = 3;
        const obj = { a: sparse, b: sparse };
        const result = fabricFromNativeValue(obj) as {
          a: unknown[];
          b: unknown[];
        };
        expect(result.a[0]).toBe(1);
        expect(1 in result.a).toBe(false); // hole preserved
        expect(result.a[2]).toBe(3);
        expect(result.a.length).toBe(3);
        // Both should reference the same converted array.
        expect(result.a).toBe(result.b);
      });
    });

    describe("throws for circular references", () => {
      it("throws when object references itself", () => {
        const obj: any = { a: 1 };
        obj.self = obj;
        expect(() => fabricFromNativeValue(obj)).toThrow(
          "Not representable as a `FabricValue`: circular reference",
        );
      });

      it("throws when array references itself", () => {
        const arr: any[] = [1, 2];
        arr.push(arr);
        expect(() => fabricFromNativeValue(arr)).toThrow(
          "Not representable as a `FabricValue`: circular reference",
        );
      });

      it("throws for indirect circular reference", () => {
        const a: any = { name: "a" };
        const b: any = { name: "b" };
        a.b = b;
        b.a = a;
        expect(() => fabricFromNativeValue(a)).toThrow(
          "Not representable as a `FabricValue`: circular reference",
        );
      });

      it("throws when sparse array references itself", () => {
        const arr: any[] = [];
        arr[0] = 1;
        arr[2] = arr; // sparse array with circular reference at index 2
        expect(() => fabricFromNativeValue(arr)).toThrow(
          "Not representable as a `FabricValue`: circular reference",
        );
      });

      it("throws when an array holding `undefined` references itself", () => {
        const arr: any[] = [1, undefined, null];
        arr[3] = arr; // array with undefined element + circular reference
        expect(() => fabricFromNativeValue(arr)).toThrow(
          "Not representable as a `FabricValue`: circular reference",
        );
      });
    });

    describe("throws for non-fabric nested values", () => {
      it("throws for nested unique symbol", () => {
        expect(() => fabricFromNativeValue({ val: Symbol("test") })).toThrow(
          "Not representable as a `FabricValue`: unique (uninterned) symbol",
        );
      });

      it("throws for deeply nested non-fabric value", () => {
        expect(() => fabricFromNativeValue({ a: { b: { c: Symbol("deep") } } }))
          .toThrow(
            "Not representable as a `FabricValue`: unique (uninterned) symbol",
          );
      });

      it("returns a nested `bigint` unchanged", () => {
        const result = fabricFromNativeValue([1n, 2n]) as bigint[];
        expect(result).toEqual([1n, 2n]);
      });
    });

    describe("throws for nested class instances", () => {
      it("throws for instance property in object", () => {
        class Plain {}
        expect(() => fabricFromNativeValue({ a: 1, inst: new Plain() }))
          .toThrow("not a recognized fabric type");
      });

      it("throws for instance element in array", () => {
        class Plain {}
        expect(() => fabricFromNativeValue([1, new Plain(), 3]))
          .toThrow("not a recognized fabric type");
      });
    });

    describe("converts nested `Error` instances to `FabricError`", () => {
      it("converts an `Error` property in an object", () => {
        const error = new Error("nested error");
        const result = fabricFromNativeValue({ status: "failed", error }) as {
          status: string;
          error: FabricError;
        };
        expect(result.status).toBe("failed");
        expect(result.error).toBeInstanceOf(FabricError);
        expect(result.error.message).toBe("nested error");
      });

      it("converts an `Error` element in an array", () => {
        const result = fabricFromNativeValue([
          new Error("first"),
          "middle",
          new Error("last"),
        ]) as unknown[];
        expect((result[0] as FabricError).message).toBe("first");
        expect(result[1]).toBe("middle");
        expect((result[2] as FabricError).message).toBe("last");
      });

      it("converts a deeply nested `Error`", () => {
        const result = fabricFromNativeValue({
          outer: { inner: { error: new TypeError("deep error") } },
        }) as { outer: { inner: { error: FabricError } } };
        const fe = result.outer.inner.error;
        expect(fe).toBeInstanceOf(FabricError);
        expect(fe.name).toBe("TypeError");
        expect(fe.message).toBe("deep error");
      });
    });

    // Cause and custom properties must be recursively converted to
    // `FabricValue` before wrapping in `FabricError`.
    describe("converts `Error` internals (cause and custom properties)", () => {
      it("converts `Error` with raw `Error` cause into nested `FabricError`", () => {
        const inner = new Error("inner");
        const outer = new Error("outer", { cause: inner });
        const result = fabricFromNativeValue(outer);

        // Top level should be a FabricError.
        expect(result).toBeInstanceOf(FabricError);
        const se = result as FabricError;
        expect(se.message).toBe("outer");

        // cause should also be a FabricError (not a raw Error).
        expect(se.cause).toBeInstanceOf(FabricError);
        const innerSe = se.cause as FabricError;
        expect(innerSe.message).toBe("inner");
      });

      it("converts deeply nested `Error` chain (3 levels)", () => {
        const root = new Error("root");
        const mid = new Error("mid", { cause: root });
        const top = new Error("top", { cause: mid });
        const result = fabricFromNativeValue(top) as FabricError;

        expect(result.message).toBe("top");
        const midSe = result.cause as FabricError;
        expect(midSe).toBeInstanceOf(FabricError);
        expect(midSe.message).toBe("mid");
        const rootSe = midSe.cause as FabricError;
        expect(rootSe).toBeInstanceOf(FabricError);
        expect(rootSe.message).toBe("root");
      });

      it("converts custom enumerable properties on `Error`", () => {
        const error = new Error("with props") as Error & {
          statusCode: number;
          details: { nested: string };
        };
        error.statusCode = 404;
        error.details = { nested: "value" };

        const result = fabricFromNativeValue(error) as FabricError;
        expect(result.message).toBe("with props");
        // Custom properties should be preserved and converted.
        expect(result.getExtra("statusCode")).toBe(404);
        expect(result.getExtra("details")).toEqual({ nested: "value" });
      });

      it("converts `Error` with non-`Error` cause (plain object)", () => {
        const cause = { code: "ENOENT", path: "/missing" };
        const error = new Error("file error", { cause });
        const result = fabricFromNativeValue(error) as FabricError;

        // cause should be a plain object (already valid FabricValue).
        expect(result.cause).toEqual({ code: "ENOENT", path: "/missing" });
        expect(Object.isFrozen(result.cause)).toBe(true);
      });

      it("preserves `Error` subclass through internals conversion", () => {
        const inner = new RangeError("bad range");
        const outer = new TypeError("bad type", { cause: inner });
        const result = fabricFromNativeValue(outer) as FabricError;

        expect(result.toNativeValue(true)).toBeInstanceOf(TypeError);
        expect(result.name).toBe("TypeError");
        const innerSe = result.cause as FabricError;
        expect(innerSe.toNativeValue(true)).toBeInstanceOf(RangeError);
        expect(innerSe.name).toBe("RangeError");
      });

      it("does not mutate the original `Error`'s cause", () => {
        const inner = new Error("inner");
        const outer = new Error("outer", { cause: inner });
        fabricFromNativeValue(outer);

        // The original `Error`'s cause is still the raw `Error`, not a
        // `FabricError`.
        expect(outer.cause).toBe(inner);
        expect(outer.cause).not.toBeInstanceOf(FabricError);
      });

      it("leaves `.cause` as `undefined` for an `Error` that has none", () => {
        const error = new Error("simple");
        const result = fabricFromNativeValue(error) as FabricError;
        expect(result.cause).toBeUndefined();
      });

      it("freezes the `FabricError` wrapper when `freeze=true`", () => {
        const error = new Error("freeze me", { cause: new Error("nested") });
        const result = fabricFromNativeValue(error);
        expect(Object.isFrozen(result)).toBe(true);
      });

      it("does not freeze `FabricError` wrapper when `freeze=false`", () => {
        const error = new Error("no freeze", { cause: new Error("nested") });
        const result = fabricFromNativeValue(error, false);
        expect(Object.isFrozen(result)).toBe(false);
        // But internals should still be converted.
        expect(result).toBeInstanceOf(FabricError);
        const se = result as FabricError;
        expect(se.cause).toBeInstanceOf(FabricError);
      });
    });

    describe("handles nested functions", () => {
      it("throws for a function property in an object", () => {
        expect(() => fabricFromNativeValue({ a: 1, fn: () => {}, b: 2 }))
          .toThrow("Not representable as a `FabricValue`: function");
      });

      it("throws for a function element in an array", () => {
        expect(() => fabricFromNativeValue([1, () => {}, 3]))
          .toThrow("Not representable as a `FabricValue`: function");
      });

      it("throws for a function carrying members", () => {
        const fn = Object.assign(() => {}, { label: "annotated" });
        expect(() => fabricFromNativeValue({ a: 1, fn, b: 2 }))
          .toThrow("Not representable as a `FabricValue`: function");
      });
    });

    describe("throws for top-level function", () => {
      it("throws when a bare function is passed (not nested)", () => {
        expect(() => fabricFromNativeValue(() => {})).toThrow(
          "Not representable as a `FabricValue`: function",
        );
      });
    });

    describe("`toJSON()` is intentionally not supported", () => {
      it("throws for a nested function carrying `toJSON()`", () => {
        const fn = Object.assign(() => {}, {
          toJSON: () => "function with toJSON",
        });
        expect(() => fabricFromNativeValue({ a: 1, fn, b: 2 }))
          .toThrow("Not representable as a `FabricValue`: function");
      });

      it("throws for a function carrying `toJSON()` in an array", () => {
        const fn = Object.assign(() => {}, { toJSON: () => "converted fn" });
        expect(() => fabricFromNativeValue([1, fn, 3]))
          .toThrow("Not representable as a `FabricValue`: function");
      });

      it("throws for a plain object whose `toJSON` is its only member", () => {
        // The deep conversion reaches the member and refuses it for what it
        // is, rather than calling it.
        expect(() => fabricFromNativeValue({ toJSON: () => ({ x: 1 }) }))
          .toThrow("Not representable as a `FabricValue`: function");
      });

      it("throws for a nested class instance carrying `toJSON()`", () => {
        class WithToJSON {
          toJSON() {
            return { x: 1 };
          }
        }
        expect(() => fabricFromNativeValue({ inst: new WithToJSON() }))
          .toThrow("not a recognized fabric type");
      });
    });

    describe("handles sparse arrays and `undefined` elements", () => {
      it("preserves top-level sparse array holes", () => {
        const sparse: unknown[] = [];
        sparse[0] = 1;
        sparse[2] = 3; // hole at index 1
        const result = fabricFromNativeValue(sparse) as unknown[];
        expect(result[0]).toBe(1);
        expect(1 in result).toBe(false); // hole preserved
        expect(result[2]).toBe(3);
        expect(result.length).toBe(3);
      });

      it("preserves nested sparse array holes", () => {
        const sparse: unknown[] = [];
        sparse[0] = "a";
        sparse[2] = "c";
        const result = fabricFromNativeValue({ arr: sparse }) as {
          arr: unknown[];
        };
        expect(result.arr[0]).toBe("a");
        expect(1 in result.arr).toBe(false); // hole preserved
        expect(result.arr[2]).toBe("c");
      });

      it("preserves sparse arrays inside arrays", () => {
        const sparse: unknown[] = [];
        sparse[0] = 1;
        sparse[2] = 3;
        const result = fabricFromNativeValue([[sparse]]) as unknown[][][];
        const inner = result[0]![0]!;
        expect(inner[0]).toBe(1);
        expect(1 in inner).toBe(false); // hole preserved
        expect(inner[2]).toBe(3);
      });

      it("preserves `undefined` elements", () => {
        const result = fabricFromNativeValue([1, undefined, 3]);
        expect(result).toEqual([1, undefined, 3]);
        expect((result as unknown[])[1]).toBe(undefined);
      });

      it("recursively processes elements and preserves holes", () => {
        const sparse: unknown[] = [];
        sparse[0] = new Date("2024-01-15T12:00:00.000Z");
        sparse[2] = { nested: true };
        const result = fabricFromNativeValue(sparse) as unknown[];
        expect(result[0]).toBeInstanceOf(FabricEpochNsec);
        expect(1 in result).toBe(false); // hole preserved
        expect(result[2]).toEqual({ nested: true });
      });
    });

    describe("throws for arrays with non-index properties", () => {
      it("throws for a top-level array with named properties", () => {
        const arr = [1, 2, 3] as unknown[] & { foo?: string };
        arr.foo = "bar";
        expect(() => fabricFromNativeValue(arr)).toThrow(
          "Not representable as a `FabricValue`: array that is not an inert array",
        );
      });

      it("throws for a nested array with named properties", () => {
        const arr = [1, 2] as unknown[] & { extra?: number };
        arr.extra = 42;
        expect(() => fabricFromNativeValue({ data: arr })).toThrow(
          "Not representable as a `FabricValue`: array that is not an inert array",
        );
      });

      it("throws for an array with a getter-backed index", () => {
        // An accessor is live code, not a value: converting would silently
        // flatten it to its momentary answer. Reject it loudly instead.
        const arr = [1, 2, 3];
        Object.defineProperty(arr, 1, {
          get: () => 22,
          enumerable: true,
          configurable: true,
        });
        expect(() => fabricFromNativeValue(arr)).toThrow(
          "Not representable as a `FabricValue`: array that is not an inert array",
        );
      });

      it("throws for a nested array with a setter-only index", () => {
        const arr = [1, 2];
        Object.defineProperty(arr, 0, { set: () => {}, enumerable: true });
        expect(() => fabricFromNativeValue({ data: arr })).toThrow(
          "Not representable as a `FabricValue`: array that is not an inert array",
        );
      });

      it("throws for a sparse array with named properties", () => {
        const sparse = [] as unknown[] & { name?: string };
        sparse[0] = 1;
        sparse[2] = 3;
        sparse.name = "test";
        expect(() => fabricFromNativeValue(sparse)).toThrow(
          "Not representable as a `FabricValue`: array that is not an inert array",
        );
      });

      it("throws even for an already-frozen array with named properties", () => {
        // Such an array is not a valid `FabricValue`, so it must not slip
        // through the deep-frozen identity short-circuit.
        const arr = [1, 2, 3] as unknown[] & { foo?: string };
        arr.foo = "bar";
        Object.freeze(arr);
        expect(() => fabricFromNativeValue(arr)).toThrow(
          "Not representable as a `FabricValue`: array that is not an inert array",
        );
      });

      it("throws for a top-level array with a symbol-keyed property", () => {
        const arr = [1, 2, 3];
        (arr as unknown as Record<symbol, unknown>)[Symbol("foo")] = "bar";
        expect(() => fabricFromNativeValue(arr)).toThrow(
          "Not representable as a `FabricValue`: array that is not an inert array",
        );
      });

      it("throws for an object with a symbol-keyed property", () => {
        // Previously such a property was silently dropped, which is exactly the
        // confusion the array rule already refuses to allow.
        const obj = { a: 1 } as Record<string | symbol, unknown>;
        obj[Symbol("s")] = 2;
        expect(() => fabricFromNativeValue(obj)).toThrow(
          "Not representable as a `FabricValue`: object that is not an inert plain object",
        );
      });

      it("throws for an object with a non-enumerable string-keyed property", () => {
        const obj = { a: 1 };
        Object.defineProperty(obj, "hidden", { value: 2, enumerable: false });
        expect(() => fabricFromNativeValue(obj)).toThrow(
          "Not representable as a `FabricValue`: object that is not an inert plain object",
        );
      });

      it("throws for a symbol-keyed object nested inside an array", () => {
        const inner = { a: 1 } as Record<string | symbol, unknown>;
        inner[Symbol("s")] = 2;
        expect(() => fabricFromNativeValue([inner])).toThrow(
          "Not representable as a `FabricValue`: object that is not an inert plain object",
        );
      });

      it("throws for an array with a non-enumerable named property", () => {
        const arr = [1, 2, 3];
        Object.defineProperty(arr, "foo", { value: "bar", enumerable: false });
        expect(() => fabricFromNativeValue(arr)).toThrow(
          "Not representable as a `FabricValue`: array that is not an inert array",
        );
      });

      it("throws for a non-array whose prototype is `Array.prototype`", () => {
        // Such a value has `constructor === Array`, so type-tag dispatch routes
        // it to array handling even though `Array.isArray()` is `false` for it.
        // It has no fabric representation as either an array or an object, so
        // it must be rejected rather than quietly converted.
        const fake = Object.create(Array.prototype) as Record<string, unknown>;
        fake[0] = "a";
        fake.length = 1;
        expect(() => fabricFromNativeValue(fake)).toThrow(
          "Not representable as a `FabricValue`: array that is not an inert array",
        );
      });

      it("throws for a nested array with a symbol-keyed property", () => {
        const arr = [1, 2];
        (arr as unknown as Record<symbol, unknown>)[Symbol.for("extra")] = 42;
        expect(() => fabricFromNativeValue({ data: arr })).toThrow(
          "Not representable as a `FabricValue`: array that is not an inert array",
        );
      });
    });

    describe("throws for indirect `Array` instances", () => {
      it("throws for an `Array` subclass instance", () => {
        class Sub extends Array {}
        const sub = new Sub();
        sub.push(1, 2);
        expect(() => fabricFromNativeValue(sub)).toThrow(
          "Not representable as a `FabricValue`: array that is not an inert array",
        );
      });

      it("throws for a nested `Array` subclass instance", () => {
        class Sub extends Array {}
        const sub = new Sub();
        sub.push(1, 2);
        expect(() => fabricFromNativeValue({ data: sub })).toThrow(
          "Not representable as a `FabricValue`: array that is not an inert array",
        );
      });

      it("throws even for an already-frozen subclass instance", () => {
        // The case the deep-frozen identity short-circuit would otherwise wave
        // through unconverted, prototype and all: iteration answers content
        // that the indices never show, and freezing the instance does nothing
        // about the prototype that does it.
        class Smuggler extends Array {
          override *[Symbol.iterator](): Generator<unknown> {
            yield "smuggled";
          }
        }
        const smuggler = new Smuggler();
        smuggler.push("benign");
        Object.freeze(smuggler);

        expect([...smuggler]).toEqual(["smuggled"]);
        expect(smuggler[0]).toBe("benign");
        expect(() => fabricFromNativeValue(smuggler)).toThrow(
          "Not representable as a `FabricValue`: array that is not an inert array",
        );
      });

      it("throws for an array whose prototype was severed", () => {
        const severed: unknown[] = [1, 2];
        Object.setPrototypeOf(severed, null);
        expect(() => fabricFromNativeValue(severed)).toThrow(
          "Not representable as a `FabricValue`: array that is not an inert array",
        );
      });

      it("throws for a subclass instance carrying `toJSON()`", () => {
        // No property an array carries can route it away from the array rule,
        // on the prototype or as an own key.
        class ProtoJson extends Array<unknown> {
          toJSON(): unknown[] {
            return [7, 8];
          }
        }
        const protoJson = new ProtoJson();
        protoJson.push(1);
        expect(() => fabricFromNativeValue(protoJson)).toThrow(
          "Not representable as a `FabricValue`: array that is not an inert array",
        );

        const ownJson = new (class extends Array<unknown> {})();
        ownJson.push(1);
        (ownJson as unknown as Record<string, unknown>).toJSON = () => [9];
        expect(() => fabricFromNativeValue(ownJson)).toThrow(
          "Not representable as a `FabricValue`: array that is not an inert array",
        );
      });
    });

    // `-0`, `NaN`, `+Infinity`, and `-Infinity` are valid `FabricValue`
    // members and pass through unchanged.
    describe("special numbers", () => {
      it("passes special numbers through", () => {
        expect(Number.isNaN(fabricFromNativeValue(NaN))).toBe(true);
        expect(fabricFromNativeValue(Infinity)).toBe(Infinity);
        expect(fabricFromNativeValue(-Infinity)).toBe(-Infinity);
        expect(Object.is(fabricFromNativeValue(-0), -0)).toBe(true);
      });

      it("preserves special numbers nested in objects", () => {
        const result = fabricFromNativeValue({
          nz: -0,
          nan: NaN,
          pinf: Infinity,
          ninf: -Infinity,
        }) as Record<string, number>;
        expect(Object.is(result.nz, -0)).toBe(true);
        expect(Number.isNaN(result.nan)).toBe(true);
        expect(result.pinf).toBe(Infinity);
        expect(result.ninf).toBe(-Infinity);
      });

      it("preserves special numbers in arrays", () => {
        const result = fabricFromNativeValue(
          [1, -0, NaN, Infinity, -Infinity, 2],
        ) as number[];
        expect(result[0]).toBe(1);
        expect(Object.is(result[1], -0)).toBe(true);
        expect(Number.isNaN(result[2])).toBe(true);
        expect(result[3]).toBe(Infinity);
        expect(result[4]).toBe(-Infinity);
        expect(result[5]).toBe(2);
      });
    });

    // Registry-interned symbols (`Symbol.for(key)`) are fabric primitives and
    // pass through; unique symbols (`Symbol(desc)`) are rejected.
    describe("interned symbols", () => {
      it("passes an interned symbol through", () => {
        const sym = Symbol.for("top-level");
        expect(fabricFromNativeValue(sym)).toBe(sym);
      });

      it("preserves interned symbols in objects", () => {
        const result = fabricFromNativeValue({
          kind: Symbol.for("event"),
          flag: Symbol.for("ready"),
        }) as Record<string, symbol>;
        expect(result.kind).toBe(Symbol.for("event"));
        expect(result.flag).toBe(Symbol.for("ready"));
      });

      it("preserves interned symbols in arrays", () => {
        const result = fabricFromNativeValue(
          [Symbol.for("a"), 1, Symbol.for("b")],
        ) as unknown[];
        expect(result[0]).toBe(Symbol.for("a"));
        expect(result[1]).toBe(1);
        expect(result[2]).toBe(Symbol.for("b"));
      });

      it("throws on a nested unique symbol", () => {
        expect(() => fabricFromNativeValue({ k: Symbol("nope") })).toThrow(
          "Not representable as a `FabricValue`: unique (uninterned) symbol",
        );
      });

      it("round-trips interned symbols with stable identity", () => {
        // Same registry key in any realm yields the same symbol instance
        // -- so the result equals the constructed sentinel by identity.
        const out = fabricFromNativeValue(Symbol.for("identity-check"));
        expect(Object.is(out, Symbol.for("identity-check"))).toBe(true);
      });

      it("throws on a top-level unique symbol (freeze default)", () => {
        // A unique symbol is not a `FabricValue`; conversion rejects it
        // regardless of the `freeze` flag -- the deep-frozen fast-path
        // (`isDeepFrozenFabricValue`) must not admit it and short-circuit the
        // validation that `freeze=false` performs (see below).
        expect(() => fabricFromNativeValue(Symbol("bad"))).toThrow(
          "Not representable as a `FabricValue`: unique (uninterned) symbol",
        );
      });
    });

    describe("`freeze` parameter", () => {
      it("deep-freezes objects by default", () => {
        const result = fabricFromNativeValue({ a: { b: 1 } }) as Record<
          string,
          unknown
        >;
        expect(Object.isFrozen(result)).toBe(true);
        expect(Object.isFrozen(result.a)).toBe(true);
      });

      it("deep-freezes arrays by default", () => {
        const result = fabricFromNativeValue([[1, 2], [3, 4]]) as unknown[][];
        expect(Object.isFrozen(result)).toBe(true);
        expect(Object.isFrozen(result[0])).toBe(true);
      });

      it("does not freeze objects when `freeze=false`", () => {
        const result = fabricFromNativeValue(
          { a: { b: 1 } },
          false,
        ) as Record<
          string,
          unknown
        >;
        expect(Object.isFrozen(result)).toBe(false);
        expect(Object.isFrozen(result.a)).toBe(false);
      });

      it("does not freeze arrays when `freeze=false`", () => {
        const result = fabricFromNativeValue(
          [[1, 2], [3, 4]],
          false,
        ) as unknown[][];
        expect(Object.isFrozen(result)).toBe(false);
        expect(Object.isFrozen(result[0])).toBe(false);
      });

      it("returns a mutable value when `freeze=false`", () => {
        const result = fabricFromNativeValue({ a: 1 }, false) as Record<
          string,
          unknown
        >;
        expect(() => {
          result.a = 2;
        }).not.toThrow();
        expect(result.a).toBe(2);
      });

      it("still performs wrapping when `freeze=false`", () => {
        const error = new Error("test");
        const result = fabricFromNativeValue(
          { error },
          false,
        ) as Record<string, unknown>;
        // Error should be wrapped into FabricError even without freezing.
        expect(result.error).not.toBe(error);
        expect(Object.isFrozen(result)).toBe(false);
      });

      it("still validates when `freeze=false`", () => {
        expect(() => fabricFromNativeValue(Symbol("bad"), false)).toThrow();
      });

      it("leaves primitives unaffected by the `freeze` parameter", () => {
        expect(fabricFromNativeValue(42, false)).toBe(42);
        expect(fabricFromNativeValue("hello", false)).toBe("hello");
        expect(fabricFromNativeValue(null, false)).toBe(null);
      });

      it("does not freeze the original array", () => {
        const arr = [1, 2, 3];
        fabricFromNativeValue(arr, true);
        expect(Object.isFrozen(arr)).toBe(false);
      });

      it("does not freeze the original plain object", () => {
        const obj = { a: 1, b: 2 };
        fabricFromNativeValue(obj, true);
        expect(Object.isFrozen(obj)).toBe(false);
      });

      it("throws for a null-prototype object at the top level", () => {
        const obj = Object.create(null) as Record<string, unknown>;
        obj.x = 1;
        expect(() => fabricFromNativeValue(obj)).toThrow(
          "Not representable as a `FabricValue`: object that is not an inert plain object",
        );
      });

      it("throws for a null-prototype object nested in the graph", () => {
        const inner = Object.create(null) as Record<string, unknown>;
        inner.val = 42;
        expect(() => fabricFromNativeValue({ nested: inner })).toThrow(
          "Not representable as a `FabricValue`: object that is not an inert plain object",
        );
      });
    });
  });

  describe("isFabricCompatible()", () => {
    describe("primitives", () => {
      it("returns `true` for `null`", () => {
        expect(isFabricCompatible(null)).toBe(true);
      });

      it("returns `true` for booleans", () => {
        expect(isFabricCompatible(true)).toBe(true);
        expect(isFabricCompatible(false)).toBe(true);
      });

      it("returns `true` for numbers (including `-0`, `NaN`, and infinities)", () => {
        expect(isFabricCompatible(42)).toBe(true);
        expect(isFabricCompatible(0)).toBe(true);
        expect(isFabricCompatible(-0)).toBe(true);
        expect(isFabricCompatible(-3.14)).toBe(true);
        expect(isFabricCompatible(NaN)).toBe(true);
        expect(isFabricCompatible(Infinity)).toBe(true);
        expect(isFabricCompatible(-Infinity)).toBe(true);
      });

      it("returns `true` for strings", () => {
        expect(isFabricCompatible("hello")).toBe(true);
        expect(isFabricCompatible("")).toBe(true);
      });

      it("returns `true` for `undefined`", () => {
        expect(isFabricCompatible(undefined)).toBe(true);
      });

      it("returns `true` for `bigint`", () => {
        expect(isFabricCompatible(42n)).toBe(true);
        expect(isFabricCompatible(0n)).toBe(true);
      });

      it("returns `true` for interned symbols", () => {
        expect(isFabricCompatible(Symbol.for("k"))).toBe(true);
        expect(isFabricCompatible(Symbol.for(""))).toBe(true);
      });

      it("returns `false` for unique (uninterned) symbols", () => {
        expect(isFabricCompatible(Symbol("test"))).toBe(false);
      });
    });

    describe("functions", () => {
      it("returns `false` for a bare function", () => {
        expect(isFabricCompatible(() => 42)).toBe(false);
      });

      it("returns `false` for a function carrying members", () => {
        expect(isFabricCompatible(Object.assign(() => 1, { x: 1 }))).toBe(
          false,
        );
      });

      it("returns `false` for a function nested in a container", () => {
        expect(isFabricCompatible({ fn: () => 1 })).toBe(false);
        expect(isFabricCompatible([() => 1])).toBe(false);
      });
    });

    describe("native object types", () => {
      it("returns `true` for `Error` instances", () => {
        expect(isFabricCompatible(new Error("test"))).toBe(true);
        expect(isFabricCompatible(new TypeError("test"))).toBe(true);
      });

      it("returns `true` for `Map` instances", () => {
        expect(isFabricCompatible(new Map())).toBe(true);
      });

      it("returns `true` for `Set` instances", () => {
        expect(isFabricCompatible(new Set())).toBe(true);
      });

      it("returns `true` for `Date` instances", () => {
        expect(isFabricCompatible(new Date())).toBe(true);
      });

      it("returns `true` for `Uint8Array` instances", () => {
        expect(isFabricCompatible(new Uint8Array([1, 2, 3]))).toBe(true);
      });

      it("returns `false` for a class instance", () => {
        class Foo {
          x = 1;
        }
        expect(isFabricCompatible(new Foo())).toBe(false);
      });
    });

    describe("fabric values", () => {
      it("returns `true` for `FabricInstance` (e.g. `FabricError`) values", () => {
        expect(
          isFabricCompatible(FabricError.fromNativeError(new Error("test"))),
        ).toBe(true);
      });

      it("returns `true` for `FabricPrimitive` (e.g. `FabricBytes`) values", () => {
        expect(isFabricCompatible(new FabricBytes(new Uint8Array([1, 2, 3]))))
          .toBe(true);
      });
    });

    describe("containers", () => {
      it("returns `true` for plain objects with fabric values", () => {
        expect(isFabricCompatible({ a: 1, b: "hello", c: null })).toBe(true);
      });

      it("returns `true` for arrays with fabric values", () => {
        expect(isFabricCompatible([1, "hello", null, true])).toBe(true);
      });

      it("returns `true` for nested structures", () => {
        expect(isFabricCompatible({
          users: [{ name: "Alice", age: 30 }],
          meta: { version: 1 },
        })).toBe(true);
      });

      it("returns `true` for objects containing `Error` values", () => {
        expect(isFabricCompatible({ error: new Error("test"), code: 500 }))
          .toBe(true);
      });

      it("returns `true` for arrays containing `Error` values", () => {
        expect(isFabricCompatible([1, new Error("test"), "hello"])).toBe(true);
      });

      it("returns `false` for objects with non-fabric nested values", () => {
        expect(isFabricCompatible({ a: 1, b: Symbol("bad") })).toBe(false);
      });

      it("returns `false` for arrays with non-fabric elements", () => {
        expect(isFabricCompatible([1, Symbol("bad")])).toBe(false);
      });

      it("returns `false` for deeply nested non-fabric values", () => {
        expect(isFabricCompatible({
          a: { b: { c: [1, 2, { d: Symbol("bad") }] } },
        })).toBe(false);
      });

      it("returns `false` for circular references", () => {
        const obj: Record<string, unknown> = { a: 1 };
        obj.self = obj;
        expect(isFabricCompatible(obj)).toBe(false);
      });

      it("returns `false` for an array with extra named properties", () => {
        const arr = [1, 2, 3] as number[] & { extra?: string };
        arr.extra = "nope";
        expect(isFabricCompatible(arr)).toBe(false);
      });

      it("returns `false` for an object with a symbol-keyed property", () => {
        const obj = { a: 1 } as Record<string | symbol, unknown>;
        obj[Symbol("s")] = 2;
        expect(isFabricCompatible(obj)).toBe(false);
      });

      it("returns `false` for an object with a non-enumerable string-keyed property", () => {
        const obj = { a: 1 };
        Object.defineProperty(obj, "hidden", { value: 2, enumerable: false });
        expect(isFabricCompatible(obj)).toBe(false);
      });

      it("returns `false` for an array with named properties nested inside an object", () => {
        const arr = [1] as number[] & { extra?: string };
        arr.extra = "nope";
        expect(isFabricCompatible({ list: arr })).toBe(false);
      });

      it("returns `false` for a property name this runtime reserves", () => {
        expect(isFabricCompatible({ ["__proto__"]: 1 })).toBe(false);
        expect(isFabricCompatible({ ["constructor"]: 1 })).toBe(false);
        expect(isFabricCompatible({ nested: { ["__proto__"]: 1 } })).toBe(
          false,
        );
      });
    });

    describe("indirect `Array` instances", () => {
      it("returns `false` for an `Array` subclass instance", () => {
        class Sub extends Array {}
        const sub = new Sub();
        sub.push(1, 2);
        expect(isFabricCompatible(sub)).toBe(false);
        expect(isFabricCompatible({ data: sub })).toBe(false);
      });

      it("returns `false` for an array whose prototype was severed", () => {
        const severed: unknown[] = [1, 2];
        Object.setPrototypeOf(severed, null);
        expect(isFabricCompatible(severed)).toBe(false);
      });
    });

    describe("`toJSON()` is intentionally not supported", () => {
      it("returns `false` for an object whose only member is `toJSON`", () => {
        expect(isFabricCompatible({ toJSON: () => ({ x: 1 }) })).toBe(false);
      });

      it("returns `false` for a function carrying `toJSON()`", () => {
        const fn = Object.assign(() => 1, { toJSON: () => ({ x: 1 }) });
        expect(isFabricCompatible(fn)).toBe(false);
      });

      it("returns `false` for a class instance carrying `toJSON()`", () => {
        class WithToJSON {
          toJSON() {
            return { x: 1 };
          }
        }
        expect(isFabricCompatible(new WithToJSON())).toBe(false);
      });
    });
  });

  describe("shallowCleanPlainObject()", () => {
    it("drops a symbol-keyed property, enumerable or not", () => {
      const obj = { a: 1 } as Record<string | symbol, unknown>;
      obj[Symbol("enum")] = 2;
      Object.defineProperty(obj, Symbol("nonEnum"), {
        value: 3,
        enumerable: false,
      });

      const result = shallowCleanPlainObject(obj) as Record<string, unknown>;

      expect(isInertPlainObject(result)).toBe(true);
      expect(result).toEqual({ a: 1 });
    });

    it("drops a non-enumerable string-keyed property", () => {
      const obj = { a: 1 };
      Object.defineProperty(obj, "hidden", { value: 2, enumerable: false });

      const result = shallowCleanPlainObject(obj) as Record<string, unknown>;

      expect(Object.getOwnPropertyNames(result)).toEqual(["a"]);
    });

    it("preserves a stored `undefined` as a present key", () => {
      const result = shallowCleanPlainObject({ a: undefined }) as Record<
        string,
        unknown
      >;

      expect("a" in result).toBe(true);
      expect(result.a).toBe(undefined);
    });

    it("returns a frozen result by default, and a mutable one on request", () => {
      expect(Object.isFrozen(shallowCleanPlainObject({ a: 1 }) as object)).toBe(
        true,
      );
      expect(
        Object.isFrozen(shallowCleanPlainObject({ a: 1 }, false) as object),
      )
        .toBe(false);
    });

    it("does not mutate or alias its input, and copies values by reference", () => {
      const inner = { deep: 1 };
      const obj = { inner } as Record<string | symbol, unknown>;
      obj[Symbol("s")] = 2;

      const result = shallowCleanPlainObject(obj) as Record<string, unknown>;

      expect(result).not.toBe(obj);
      expect(result.inner).toBe(inner);
      expect(Object.getOwnPropertySymbols(obj)).toHaveLength(1); // input intact
    });

    it("produces a value the conversion functions accept", () => {
      const obj = { a: 1 } as Record<string | symbol, unknown>;
      obj[Symbol("s")] = 2;

      expect(() => shallowFabricFromNativeValue(obj)).toThrow();
      expect(() =>
        shallowFabricFromNativeValue(shallowCleanPlainObject(obj, false))
      )
        .not.toThrow();
    });
  });

  describe("shallowCleanArray()", () => {
    it("drops an enumerable named property", () => {
      const arr = [1, 2, 3] as unknown[] & { foo?: string };
      arr.foo = "bar";

      const result = shallowCleanArray(arr) as unknown[];

      expect(isArrayWithOnlyIndexProperties(result)).toBe(true);
      expect(result).toEqual([1, 2, 3]);
    });

    it("drops a non-enumerable named property", () => {
      const arr = [1, 2, 3];
      Object.defineProperty(arr, "foo", { value: "bar", enumerable: false });

      const result = shallowCleanArray(arr) as unknown[];

      expect(isArrayWithOnlyIndexProperties(result)).toBe(true);
      expect(Object.getOwnPropertyNames(result)).toEqual([
        "0",
        "1",
        "2",
        "length",
      ]);
    });

    it("drops a symbol-keyed property, enumerable or not", () => {
      const arr = [1, 2];
      (arr as unknown as Record<symbol, unknown>)[Symbol("enum")] = "x";
      Object.defineProperty(arr, Symbol("nonEnum"), {
        value: "y",
        enumerable: false,
      });

      const result = shallowCleanArray(arr) as unknown[];

      expect(isArrayWithOnlyIndexProperties(result)).toBe(true);
      expect(Object.getOwnPropertySymbols(result)).toEqual([]);
    });

    it("preserves interior holes as holes rather than `undefined`", () => {
      const arr: unknown[] = [];
      arr[0] = 1;
      arr[2] = 3;

      const result = shallowCleanArray(arr) as unknown[];

      expect(result.length).toBe(3);
      expect(0 in result).toBe(true);
      expect(1 in result).toBe(false); // the hole
      expect(2 in result).toBe(true);
    });

    it("preserves trailing holes, so `length` survives", () => {
      // Assigning element-by-element without setting `length` first would
      // truncate these away.
      const arr: unknown[] = [];
      arr[0] = 1;
      arr.length = 10;

      const result = shallowCleanArray(arr) as unknown[];

      expect(result.length).toBe(10);
      expect(1 in result).toBe(false);
    });

    it("does not probe every index below `length`", () => {
      // A hugely sparse array must not be walked slot by slot from JS. The
      // engine still scans the index range to find which keys exist, so this
      // is not O(present elements); what it pins is that the scan is not done
      // here, one property access at a time.
      const target: unknown[] = [];
      target.length = 1_000_000;
      target[5] = "x";

      let probes = 0;
      const counting = new Proxy(target, {
        has(t, p) {
          probes++;
          return Reflect.has(t, p);
        },
        get(t, p, r) {
          if (p !== "length") probes++;
          return Reflect.get(t, p, r);
        },
      });

      const result = shallowCleanArray(counting) as unknown[];

      expect(result.length).toBe(1_000_000);
      expect(result[5]).toBe("x");
      expect(probes).toBeLessThan(100);
    });

    it("copies every index even when a proxy reports a named key first", () => {
      // A `Proxy` chooses its own key order, so index keys need not come first
      // the way they do on an ordinary array. Stopping at the first non-index
      // key would therefore silently drop elements -- here, all of them.
      const target = [10, 20];
      const reordered = new Proxy(target, {
        ownKeys: () => ["foo", "0", "1", "length"],
        getOwnPropertyDescriptor: (t, p) => {
          if (p === "foo") {
            return { configurable: true, enumerable: true, value: "x" };
          }
          return Object.getOwnPropertyDescriptor(t, p);
        },
      });

      expect(shallowCleanArray(reordered)).toEqual([10, 20]);
    });

    it("distinguishes a stored `undefined` from a hole", () => {
      const arr: unknown[] = [undefined, 2];

      const result = shallowCleanArray(arr) as unknown[];

      expect(0 in result).toBe(true);
      expect(result[0]).toBe(undefined);
    });

    it("returns a frozen result by default, and a mutable one on request", () => {
      const arr = [1, 2, 3];

      expect(Object.isFrozen(shallowCleanArray(arr) as unknown[])).toBe(true);
      expect(Object.isFrozen(shallowCleanArray(arr, false) as unknown[]))
        .toBe(false);
    });

    it("does not mutate or alias its input", () => {
      const arr = [1, 2, 3] as unknown[] & { foo?: string };
      arr.foo = "bar";

      const result = shallowCleanArray(arr) as unknown[];

      expect(result).not.toBe(arr);
      expect(arr.foo).toBe("bar"); // input untouched
    });

    it("copies elements by reference, being a shallow operation", () => {
      const inner = { a: 1 };
      const arr = [inner] as unknown[] & { foo?: string };
      arr.foo = "bar";

      const result = shallowCleanArray(arr) as unknown[];

      expect(result[0]).toBe(inner);
    });

    it("produces a value the conversion functions accept", () => {
      const arr = [1, 2, 3] as unknown[] & { foo?: string };
      arr.foo = "bar";

      expect(() => shallowFabricFromNativeValue(arr)).toThrow();
      expect(() => shallowFabricFromNativeValue(shallowCleanArray(arr, false)))
        .not.toThrow();
    });
  });
});
