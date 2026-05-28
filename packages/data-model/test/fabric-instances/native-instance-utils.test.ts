import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  DECONSTRUCT,
  DEEP_FREEZE,
  FabricInstance,
  type FabricValue,
  IS_DEEP_FROZEN,
  RECONSTRUCT,
} from "../../src/interface.ts";
import { FabricError } from "../../src/fabric-instances/FabricError.ts";
import { FabricMap } from "../../src/fabric-instances/FabricMap.ts";
import { FabricRegExp } from "../../src/fabric-instances/FabricRegExp.ts";
import { FabricSet } from "../../src/fabric-instances/FabricSet.ts";
import { isConvertibleNativeInstance } from "../../src/native-instance-utils.ts";
import { nativeFromFabricValueModern } from "../../src/fabric-value-modern.ts";
import { FrozenMap, FrozenSet } from "../../src/frozen-builtins.ts";
import {
  NATIVE_TAGS,
  tagFromNativeClass,
  tagFromNativeValue,
} from "../../src/native-type-tags.ts";
import { UnknownValue } from "../../src/fabric-instances/UnknownValue.ts";
import { ProblematicValue } from "../../src/fabric-instances/ProblematicValue.ts";
import { BaseFabricInstance } from "../../src/fabric-instances/BaseFabricInstance.ts";
import { deepFreeze, isDeepFrozen } from "../../src/deep-freeze.ts";
import { DummyReconstructionContext } from "./fixtures.ts";

describe("native-instance-utils", () => {
  describe("nativeFromFabricValueModern", () => {
    it("unwraps `FabricError` in nested object", () => {
      const se = FabricError.fromNativeError(new Error("deep"));
      const obj = { error: se } as FabricValue;
      const result = nativeFromFabricValueModern(obj) as Record<
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
      const arr = [sm] as FabricValue;
      const result = nativeFromFabricValueModern(arr) as unknown[];
      expect(result[0]).toBeInstanceOf(FrozenMap);
    });

    it("unwraps `FabricMap` to mutable `Map` when `frozen=false`", () => {
      const sm = new FabricMap(
        new Map<FabricValue, FabricValue>([["k", "v"]]),
      );
      const arr = [sm] as FabricValue;
      const result = nativeFromFabricValueModern(arr, false) as unknown[];
      expect(result[0]).toBeInstanceOf(Map);
      expect(result[0]).not.toBeInstanceOf(FrozenMap);
    });

    it("passes through primitives at all levels", () => {
      const obj = { a: 1, b: "two", c: null, d: true } as FabricValue;
      const result = nativeFromFabricValueModern(obj) as Record<
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
      } as FabricValue;
      const result = nativeFromFabricValueModern(obj) as {
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
      } as unknown as FabricValue;
      const result = nativeFromFabricValueModern(obj) as Record<
        string,
        unknown
      >;
      expect(result.error).toBeInstanceOf(Error);
      expect((result.error as Error).message).toBe("deep");
      expect(Object.isFrozen(result.error)).toBe(true);
      expect(result.code).toBe(500);
      expect(Object.isFrozen(result)).toBe(true);
    });

    it("deeply unwraps `FabricError` in arrays (frozen)", () => {
      const err = new Error("array");
      const se = FabricError.fromNativeError(err);
      const arr = [1, se, 3] as unknown as FabricValue;
      const result = nativeFromFabricValueModern(arr) as unknown[];
      expect(result[0]).toBe(1);
      expect(result[1]).toBeInstanceOf(Error);
      expect((result[1] as Error).message).toBe("array");
      expect(Object.isFrozen(result[1])).toBe(true);
      expect(result[2]).toBe(3);
      expect(Object.isFrozen(result)).toBe(true);
    });

    it("output is not frozen when `frozen=false`", () => {
      const obj = Object.freeze({
        a: 1,
        b: "two",
      }) as unknown as FabricValue;
      const result = nativeFromFabricValueModern(obj, false) as Record<
        string,
        unknown
      >;
      // Output should be a new, unfrozen object.
      expect(Object.isFrozen(result)).toBe(false);
      result.a = 99; // should not throw
      expect(result.a).toBe(99);
    });

    it("output is frozen when `frozen=true` (default)", () => {
      const obj = { a: 1, b: "two" } as unknown as FabricValue;
      const result = nativeFromFabricValueModern(obj) as Record<
        string,
        unknown
      >;
      expect(Object.isFrozen(result)).toBe(true);
    });

    it("preserves sparse holes", () => {
      const arr = new Array(3) as FabricValue[];
      arr[0] = 1;
      arr[2] = 3;
      Object.freeze(arr);
      const result = nativeFromFabricValueModern(
        arr as FabricValue,
      ) as unknown[];
      expect(result.length).toBe(3);
      expect(result[0]).toBe(1);
      expect(1 in result).toBe(false); // hole preserved
      expect(result[2]).toBe(3);
    });

    it("passes through non-native `FabricInstance`", () => {
      const us = new UnknownValue("Test@1", null);
      const obj = { thing: us } as unknown as FabricValue;
      const result = nativeFromFabricValueModern(obj) as Record<
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
      const obj = { data: sm } as unknown as FabricValue;
      const result = nativeFromFabricValueModern(obj) as Record<
        string,
        unknown
      >;
      expect(result.data).toBeInstanceOf(FrozenMap);
      expect((result.data as Map<string, number>).get("x")).toBe(10);
    });

    it("deeply unwraps `FabricSet` to `FrozenSet`", () => {
      const set = new Set<FabricValue>([42] as FabricValue[]);
      const ss = new FabricSet(set);
      const arr = [ss] as unknown as FabricValue;
      const result = nativeFromFabricValueModern(arr) as unknown[];
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

      const result = nativeFromFabricValueModern(
        outerSe as FabricValue,
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

      const result = nativeFromFabricValueModern(
        outerSe as FabricValue,
        false,
      ) as Error;
      expect(result).toBeInstanceOf(Error);
      expect(Object.isFrozen(result)).toBe(false);
      expect(result.cause).toBeInstanceOf(Error);
      expect(Object.isFrozen(result.cause)).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // tagFromNativeValue / tagFromNativeClass / isConvertibleNativeInstance
  // --------------------------------------------------------------------------

  describe("tagFromNativeValue", () => {
    it("returns `Error` tag for standard `Error` subclasses", () => {
      const cases: [string, Error][] = [
        ["Error", new Error("test")],
        ["TypeError", new TypeError("test")],
        ["RangeError", new RangeError("test")],
        ["SyntaxError", new SyntaxError("test")],
        ["ReferenceError", new ReferenceError("test")],
        ["URIError", new URIError("test")],
        ["EvalError", new EvalError("test")],
      ];
      for (const [_name, value] of cases) {
        expect(tagFromNativeValue(value)).toBe(NATIVE_TAGS.Error);
      }
    });

    it("returns `Error` tag for exotic `Error` subclass (custom class)", () => {
      class MyFancyError extends Error {
        constructor(msg: string) {
          super(msg);
          this.name = "MyFancyError";
        }
      }
      const exotic = new MyFancyError("exotic");
      // Constructor is MyFancyError, not in the switch -- falls back to
      // Error.isError().
      expect(tagFromNativeValue(exotic)).toBe(NATIVE_TAGS.Error);
    });

    it("returns `Map` tag for `Map` instances", () => {
      expect(tagFromNativeValue(new Map())).toBe(NATIVE_TAGS.Map);
    });

    it("returns `Set` tag for `Set` instances", () => {
      expect(tagFromNativeValue(new Set())).toBe(NATIVE_TAGS.Set);
    });

    it("returns `Date` tag for `Date` instances", () => {
      expect(tagFromNativeValue(new Date())).toBe(NATIVE_TAGS.Date);
    });

    it("returns `Uint8Array` tag for `Uint8Array` instances", () => {
      expect(tagFromNativeValue(new Uint8Array())).toBe(
        NATIVE_TAGS.Uint8Array,
      );
    });

    it("returns `Object` tag for plain objects", () => {
      expect(tagFromNativeValue({})).toBe(NATIVE_TAGS.Object);
    });

    it("returns `Array` tag for arrays", () => {
      expect(tagFromNativeValue([])).toBe(NATIVE_TAGS.Array);
    });

    it("returns `RegExp` tag for `RegExp` instances", () => {
      expect(tagFromNativeValue(/abc/)).toBe(NATIVE_TAGS.RegExp);
    });

    it("returns `Object` tag for null-prototype objects (no constructor)", () => {
      const obj = Object.create(null);
      expect(tagFromNativeValue(obj)).toBe(NATIVE_TAGS.Object);
    });

    it("returns `HasToJSON` tag for plain objects with `toJSON()`", () => {
      const obj = { toJSON: () => "converted" };
      expect(tagFromNativeValue(obj)).toBe(NATIVE_TAGS.HasToJSON);
    });

    it("returns `HasToJSON` tag for arrays with `toJSON()`", () => {
      const arr = [1, 2, 3] as unknown[] & { toJSON?: () => unknown };
      arr.toJSON = () => "custom array";
      expect(tagFromNativeValue(arr)).toBe(NATIVE_TAGS.HasToJSON);
    });

    it("returns `HasToJSON` tag for class instances with `toJSON()`", () => {
      class Custom {
        toJSON() {
          return { x: 1 };
        }
      }
      expect(tagFromNativeValue(new Custom())).toBe(NATIVE_TAGS.HasToJSON);
    });

    it("returns `Date` tag for `Date` (not `HasToJSON` despite `Date.toJSON`)", () => {
      expect(tagFromNativeValue(new Date())).toBe(NATIVE_TAGS.Date);
    });

    // Functions are non-objects and return Primitive from tagFromNativeValue.
    // In practice, functions with toJSON() are handled separately in
    // the modern conversion path, not via tagFromNativeValue.
    it("returns `Primitive` for functions (even with `toJSON`)", () => {
      const fn = () => {};
      (fn as unknown as { toJSON: () => string }).toJSON = () => "converted";
      expect(tagFromNativeValue(fn)).toBe(NATIVE_TAGS.Primitive);
    });
  });

  describe("tagFromNativeClass", () => {
    it("returns `Error` tag for standard `Error` constructors", () => {
      const constructors = [
        Error,
        TypeError,
        RangeError,
        SyntaxError,
        ReferenceError,
        URIError,
        EvalError,
      ];
      for (const ctor of constructors) {
        expect(tagFromNativeClass(ctor)).toBe(NATIVE_TAGS.Error);
      }
    });

    it("returns `Error` tag for exotic `Error` subclass constructor", () => {
      class ExoticError extends Error {}
      // Constructor is ExoticError, not in the switch -- falls back to
      // Error.isError(prototype) check.
      expect(tagFromNativeClass(ExoticError)).toBe(NATIVE_TAGS.Error);
    });

    it("returns correct tags for `Array`, `Object`, `Map`, `Set`, `Date`, `Uint8Array`", () => {
      expect(tagFromNativeClass(Array)).toBe(NATIVE_TAGS.Array);
      expect(tagFromNativeClass(Object)).toBe(NATIVE_TAGS.Object);
      expect(tagFromNativeClass(Map)).toBe(NATIVE_TAGS.Map);
      expect(tagFromNativeClass(Set)).toBe(NATIVE_TAGS.Set);
      expect(tagFromNativeClass(Date)).toBe(NATIVE_TAGS.Date);
      expect(tagFromNativeClass(Uint8Array)).toBe(NATIVE_TAGS.Uint8Array);
    });

    it("returns `RegExp` tag for `RegExp` constructor", () => {
      expect(tagFromNativeClass(RegExp)).toBe(NATIVE_TAGS.RegExp);
    });

    it("returns `null` for unrecognized constructors", () => {
      expect(tagFromNativeClass(WeakMap)).toBe(null);
      expect(tagFromNativeClass(Promise)).toBe(null);
    });

    it("returns `HasToJSON` for class with `toJSON` on prototype", () => {
      class WithToJSON {
        toJSON() {
          return { x: 1 };
        }
      }
      expect(tagFromNativeClass(WithToJSON)).toBe(NATIVE_TAGS.HasToJSON);
    });

    it("returns `HasToJSON` for subclass inheriting `toJSON`", () => {
      class Base {
        toJSON() {
          return "base";
        }
      }
      class Sub extends Base {}
      expect(tagFromNativeClass(Sub)).toBe(NATIVE_TAGS.HasToJSON);
    });

    it("returns `Date` tag for `Date` (not `HasToJSON` despite `Date.prototype.toJSON`)", () => {
      expect(tagFromNativeClass(Date)).toBe(NATIVE_TAGS.Date);
    });

    it("returns `null` for class without `toJSON`", () => {
      class Plain {}
      expect(tagFromNativeClass(Plain)).toBe(null);
    });
  });

  describe("isConvertibleNativeInstance", () => {
    it("returns true for all convertible types", () => {
      expect(isConvertibleNativeInstance(new Error("e"))).toBe(true);
      expect(isConvertibleNativeInstance(new TypeError("e"))).toBe(true);
      expect(isConvertibleNativeInstance(new Map())).toBe(true);
      expect(isConvertibleNativeInstance(new Set())).toBe(true);
      expect(isConvertibleNativeInstance(new Date())).toBe(true);
      expect(isConvertibleNativeInstance(new Uint8Array())).toBe(true);
    });

    it("returns true for exotic Error subclass", () => {
      class WeirdError extends RangeError {}
      expect(isConvertibleNativeInstance(new WeirdError("weird"))).toBe(true);
    });

    it("returns true for RegExp", () => {
      expect(isConvertibleNativeInstance(/abc/)).toBe(true);
    });

    it("returns false for non-convertible types", () => {
      expect(isConvertibleNativeInstance({})).toBe(false);
      expect(isConvertibleNativeInstance([])).toBe(false);
      expect(isConvertibleNativeInstance(new WeakMap())).toBe(false);
    });

    it("returns false for objects with `toJSON()`", () => {
      expect(isConvertibleNativeInstance({ toJSON: () => "x" })).toBe(false);
    });
  });

  describe("FabricInstance instanceof checks", () => {
    it("returns false for `null`", () => {
      expect((null as unknown) instanceof FabricInstance).toBe(false);
    });

    it("returns false for `undefined`", () => {
      expect((undefined as unknown) instanceof FabricInstance).toBe(false);
    });

    it("returns false for primitives", () => {
      expect((42 as unknown) instanceof FabricInstance).toBe(false);
      expect(("hello" as unknown) instanceof FabricInstance).toBe(false);
      expect((true as unknown) instanceof FabricInstance).toBe(false);
    });

    it("returns false for plain objects", () => {
      expect(({} as unknown) instanceof FabricInstance).toBe(false);
      expect(({ a: 1 } as unknown) instanceof FabricInstance).toBe(false);
    });

    it("returns true for `UnknownValue`", () => {
      const us = new UnknownValue("Test@1", null);
      expect(us instanceof FabricInstance).toBe(true);
    });

    it("returns true for `ProblematicValue`", () => {
      const ps = new ProblematicValue("Test@1", null, "oops");
      expect(ps instanceof FabricInstance).toBe(true);
    });

    it("returns true for custom `FabricInstance` subclass", () => {
      class CustomFabInst extends BaseFabricInstance {
        [DECONSTRUCT](): FabricValue {
          return { value: 42 };
        }
        [DEEP_FREEZE](
          _subFreeze: (value: FabricValue) => FabricValue,
        ): FabricValue {
          return this as unknown as FabricValue;
        }
        [IS_DEEP_FROZEN](
          _subIsDeepFrozen: (value: FabricValue) => boolean,
        ): boolean {
          return Object.isFrozen(this);
        }
        deepClone(_frozen: boolean): CustomFabInst {
          return new CustomFabInst();
        }
        protected shallowUnfrozenClone(): CustomFabInst {
          return new CustomFabInst();
        }
      }
      const instance = new CustomFabInst();
      expect(instance instanceof FabricInstance).toBe(true);
    });

    it("returns true for `FabricError`", () => {
      const se = FabricError.fromNativeError(new Error("test"));
      expect(se instanceof FabricInstance).toBe(true);
    });
  });

  describe("`[RECONSTRUCT]` honors `shouldDeepFreeze`", () => {
    const frozenCtx = new DummyReconstructionContext(true);
    const mutableCtx = new DummyReconstructionContext(false);

    it("`FabricError`: `shouldDeepFreeze` true => deep-frozen, false => mutable", () => {
      const state = {
        type: "Error",
        name: null,
        message: "boom",
      } as unknown as FabricValue;
      const frozen = FabricError[RECONSTRUCT](state, frozenCtx);
      expect(isDeepFrozen(frozen)).toBe(true);
      const mutable = FabricError[RECONSTRUCT](state, mutableCtx);
      expect(Object.isFrozen(mutable)).toBe(false);
    });

    it("`FabricRegExp`: `shouldDeepFreeze` true => deep-frozen, false => mutable", () => {
      const state = {
        source: "abc",
        flags: "g",
        flavor: "es2025",
      } as unknown as FabricValue;
      const frozen = FabricRegExp[RECONSTRUCT](state, frozenCtx);
      expect(isDeepFrozen(frozen)).toBe(true);
      expect(Object.isFrozen(frozen.regex)).toBe(true);
      const mutable = FabricRegExp[RECONSTRUCT](state, mutableCtx);
      expect(Object.isFrozen(mutable)).toBe(false);
    });

    it("`ProblematicValue`: `shouldDeepFreeze` true => deep-frozen, false => mutable", () => {
      const state = {
        type: "Bad@1",
        state: { x: 1 },
        error: "oops",
      } as unknown as { type: string; state: FabricValue; error: string };
      const frozen = ProblematicValue[RECONSTRUCT](state, frozenCtx);
      expect(isDeepFrozen(frozen)).toBe(true);
      const mutable = ProblematicValue[RECONSTRUCT](state, mutableCtx);
      expect(Object.isFrozen(mutable)).toBe(false);
    });

    it("`UnknownValue`: `shouldDeepFreeze` true => deep-frozen, false => mutable", () => {
      const state = { type: "Fancy@3", state: { y: 2 } } as unknown as {
        type: string;
        state: FabricValue;
      };
      const frozen = UnknownValue[RECONSTRUCT](state, frozenCtx);
      expect(isDeepFrozen(frozen)).toBe(true);
      const mutable = UnknownValue[RECONSTRUCT](state, mutableCtx);
      expect(Object.isFrozen(mutable)).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // Arm 3 cycle behavior via [DEEP_FREEZE] protocol
  //
  // Cycle-capable wired impls: `FabricError` (recurses through
  // `error.cause` + custom enumerable own properties), `ProblematicValue`
  // (recurses through `state`), `UnknownValue` (recurses through
  // `state`). `FabricRegExp.[DEEP_FREEZE]` ignores its `subFreeze`
  // parameter (only freezes `this.regex` + `this`) and so is structurally
  // cycle-free by construction at the protocol level -- omitted
  // intentionally, not a gap.
  //
  // Termination assertion: a cycle without shared-`inProgress` threading
  // would manifest as `RangeError: Maximum call stack size exceeded` (a
  // clean fast throw, not a hang); `.not.toThrow()` is the discriminating
  // assertion.
  // --------------------------------------------------------------------------

  describe("Arm 3 cycle behavior via `[DEEP_FREEZE]`", () => {
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

    it("cross-instance cycle (`FabricError` <-> `ProblematicValue`) terminates", () => {
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
});
