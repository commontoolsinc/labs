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
import { FabricNativeWrapper } from "../../src/fabric-instances/FabricNativeWrapper.ts";
import {
  deepFreeze,
  isDeepFrozen,
  isDeepFrozenFabricValue,
} from "../../src/deep-freeze.ts";
import { dummyContext, subFreeze, subIsDeepFrozen } from "./fixtures.ts";

describe("FabricError", () => {
  it("implements FabricInstance (instanceof returns true)", () => {
    const se = FabricError.fromNativeError(new Error("test"));
    expect(se instanceof FabricInstance).toBe(true);
  });

  it("has typeTag 'Error@1'", () => {
    const se = FabricError.fromNativeError(new Error("test"));
    expect(se.typeTag).toBe("Error@1");
  });

  it("wraps the Error's FabricValue-shaped state", () => {
    const err = new TypeError("bad");
    const se = FabricError.fromNativeError(err);
    expect(se.type).toBe("TypeError");
    expect(se.name).toBe("TypeError");
    expect(se.message).toBe("bad");
  });

  it("fixed-schema slots are mutable while unfrozen", () => {
    const se = FabricError.fromNativeError(new Error("orig"));
    se.message = "changed";
    se.name = "Renamed";
    se.cause = { detail: 1 } as FabricValue;
    expect(se.message).toBe("changed");
    expect(se.name).toBe("Renamed");
    expect(se.cause).toEqual({ detail: 1 });
    // The native projection reflects the mutated state (no stale cache).
    expect(se.toNativeValue(true).message).toBe("changed");
  });

  it("fixed-schema slots throw on assignment once frozen", () => {
    const se = FabricError.fromNativeError(new Error("orig"));
    Object.freeze(se);
    expect(() => {
      se.message = "nope";
    }).toThrow();
    expect(() => {
      (se as { name: string }).name = "nope";
    }).toThrow();
    expect(se.message).toBe("orig");
  });

  it("is instanceof FabricNativeWrapper", () => {
    const se = FabricError.fromNativeError(new Error("test"));
    expect(se instanceof FabricNativeWrapper).toBe(true);
  });

  it("[DECONSTRUCT] returns type, name=null (common case), message, stack", () => {
    const se = FabricError.fromNativeError(new Error("hello"));
    const state = se[DECONSTRUCT]() as Record<string, FabricValue>;
    expect(state.type).toBe("Error");
    expect(state.name).toBe(null);
    expect(state.message).toBe("hello");
    expect(typeof state.stack).toBe("string");
  });

  it("[DECONSTRUCT] name is null when type === name (TypeError)", () => {
    const se = FabricError.fromNativeError(new TypeError("bad"));
    const state = se[DECONSTRUCT]() as Record<string, FabricValue>;
    expect(state.type).toBe("TypeError");
    expect(state.name).toBe(null);
  });

  it("[DECONSTRUCT] name is non-null when type !== name", () => {
    const err = new TypeError("bad");
    err.name = "CustomName";
    const se = FabricError.fromNativeError(err);
    const state = se[DECONSTRUCT]() as Record<string, FabricValue>;
    expect(state.type).toBe("TypeError");
    expect(state.name).toBe("CustomName");
  });

  it("[DECONSTRUCT] includes cause when present", () => {
    const inner = FabricError.fromNativeError(new Error("inner"));
    const outer = FabricError.fromNativeError(
      new Error("outer", { cause: inner }),
    );
    const state = outer[DECONSTRUCT]() as Record<string, FabricValue>;
    expect(state.cause).toBe(inner);
  });

  it("[DECONSTRUCT] includes custom enumerable properties", () => {
    const err = new Error("oops");
    (err as unknown as Record<string, unknown>).code = 42;
    (err as unknown as Record<string, unknown>).detail = "more info";
    const se = FabricError.fromNativeError(err);
    const state = se[DECONSTRUCT]() as Record<string, FabricValue>;
    expect(state.code).toBe(42);
    expect(state.detail).toBe("more info");
  });

  it("[DECONSTRUCT] does not copy __proto__ or constructor keys", () => {
    const err = new Error("test");
    Object.defineProperty(err, "__proto__", {
      value: "bad",
      enumerable: true,
    });
    const se = FabricError.fromNativeError(err);
    const state = se[DECONSTRUCT]() as Record<string, FabricValue>;
    expect("__proto__" in state).toBe(false);
  });

  it("[DECONSTRUCT] custom props do not override built-in fields", () => {
    const err = new Error("original");
    // Manually set an enumerable "message" property -- should not override
    Object.defineProperty(err, "message", {
      value: "original",
      enumerable: true,
    });
    (err as unknown as Record<string, unknown>).name = "Error";
    const se = FabricError.fromNativeError(err);
    const state = se[DECONSTRUCT]() as Record<string, FabricValue>;
    expect(state.message).toBe("original");
  });

  it("[DECONSTRUCT] omits stack when undefined", () => {
    const err = new Error("no stack");
    err.stack = undefined;
    const se = FabricError.fromNativeError(err);
    const state = se[DECONSTRUCT]() as Record<string, FabricValue>;
    expect("stack" in state).toBe(false);
  });

  it("[RECONSTRUCT] creates FabricError from state (null name = same as type)", () => {
    const state = {
      type: "Error",
      name: null,
      message: "hello",
    } as FabricValue;
    const result = FabricError[RECONSTRUCT](state, dummyContext);
    expect(result).toBeInstanceOf(FabricError);
    expect(result.toNativeValue(true)).toBeInstanceOf(Error);
    expect(result.name).toBe("Error");
    expect(result.message).toBe("hello");
  });

  it("[RECONSTRUCT] creates correct Error subclass from type (null name)", () => {
    const cases: [string, ErrorConstructor][] = [
      ["TypeError", TypeError],
      ["RangeError", RangeError],
      ["SyntaxError", SyntaxError],
      ["ReferenceError", ReferenceError],
      ["URIError", URIError],
      ["EvalError", EvalError],
    ];
    for (const [type, cls] of cases) {
      const state = { type, name: null, message: "test" } as FabricValue;
      const result = FabricError[RECONSTRUCT](state, dummyContext);
      expect(result.toNativeValue(true)).toBeInstanceOf(cls);
      expect(result.name).toBe(type);
    }
  });

  it("[RECONSTRUCT] handles type != name (e.g. TypeError with custom name)", () => {
    const state = {
      type: "TypeError",
      name: "CustomTypeName",
      message: "mismatch",
    } as FabricValue;
    const result = FabricError[RECONSTRUCT](state, dummyContext);
    expect(result.toNativeValue(true)).toBeInstanceOf(TypeError);
    expect(result.name).toBe("CustomTypeName");
  });

  it("[RECONSTRUCT] falls back to name when type is absent (back-compat)", () => {
    const state = {
      name: "TypeError",
      message: "old format",
    } as FabricValue;
    const result = FabricError[RECONSTRUCT](state, dummyContext);
    expect(result.toNativeValue(true)).toBeInstanceOf(TypeError);
  });

  it("[RECONSTRUCT] handles custom name", () => {
    const state = {
      type: "Error",
      name: "MyCustomError",
      message: "custom",
    } as FabricValue;
    const result = FabricError[RECONSTRUCT](state, dummyContext);
    expect(result.name).toBe("MyCustomError");
  });

  it("[RECONSTRUCT] restores cause and custom properties", () => {
    const state = {
      type: "Error",
      name: null,
      message: "with extras",
      cause: "something went wrong",
      code: 404,
    } as FabricValue;
    const result = FabricError[RECONSTRUCT](state, dummyContext);
    expect(result.cause).toBe("something went wrong");
    expect(result.getExtra("code")).toBe(404);
  });

  it("round-trips through DECONSTRUCT/RECONSTRUCT", () => {
    const original = new Error("round trip");
    original.name = "CustomError";
    (original as unknown as Record<string, unknown>).code = 42;
    const se = FabricError.fromNativeError(original);

    const state = se[DECONSTRUCT]();
    const restored = FabricError[RECONSTRUCT](state, dummyContext);

    expect(restored.name).toBe("CustomError");
    expect(restored.message).toBe("round trip");
    expect(restored.getExtra("code")).toBe(42);
  });

  it("round-trips TypeError with overridden name", () => {
    const original = new TypeError("bad value");
    original.name = "SpecialType";
    const se = FabricError.fromNativeError(original);

    const state = se[DECONSTRUCT]() as Record<string, FabricValue>;
    expect(state.type).toBe("TypeError");
    expect(state.name).toBe("SpecialType");

    const restored = FabricError[RECONSTRUCT](
      state as FabricValue,
      dummyContext,
    );
    expect(restored.toNativeValue(true)).toBeInstanceOf(TypeError);
    expect(restored.name).toBe("SpecialType");
  });

  it("toNativeValue(true) returns a frozen Error projection", () => {
    const err = new Error("native");
    const se = FabricError.fromNativeError(err);
    const result = se.toNativeValue(true);
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe("native");
    expect(Object.isFrozen(result)).toBe(true);
    // The originating native Error is not stored / not mutated.
    expect(Object.isFrozen(err)).toBe(false);
  });

  it("toNativeValue(true) caches the projection once frozen", () => {
    const se = FabricError.fromNativeError(new Error("native"));
    // While mutable, repeated calls rebuild (no stale cache risk).
    expect(se.toNativeValue(true)).not.toBe(se.toNativeValue(true));
    // Once frozen, the projection is cached and returned by identity.
    Object.freeze(se);
    const a = se.toNativeValue(true);
    const b = se.toNativeValue(true);
    expect(a).toBe(b);
    expect(Object.isFrozen(a)).toBe(true);
  });

  it("toNativeValue(false) returns a fresh unfrozen Error projection", () => {
    const se = FabricError.fromNativeError(new Error("native"));
    const result = se.toNativeValue(false);
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe("native");
    expect(Object.isFrozen(result)).toBe(false);
  });

  it("toNativeValue(false) returns a fresh copy each call", () => {
    const se = FabricError.fromNativeError(new Error("native"));
    const a = se.toNativeValue(false);
    const b = se.toNativeValue(false);
    expect(a).not.toBe(b);
    expect(a.message).toBe(b.message);
  });

  describe("[DEEP_FREEZE] / [IS_DEEP_FROZEN] protocol — via dispatch", () => {
    it("[DEEP_FREEZE] freezes wrapper + recurses cause", () => {
      const inner = FabricError.fromNativeError(new Error("cause"));
      const fe = FabricError.fromNativeError(
        new Error("outer", { cause: inner }),
      );
      const result = deepFreeze(fe);
      expect(result).toBe(fe); // freeze-in-place identity
      expect(Object.isFrozen(fe)).toBe(true);
      expect(isDeepFrozen(inner)).toBe(true);
    });

    it("[DEEP_FREEZE] recurses enumerable custom props (preserved via extras)", () => {
      const err = new Error("e");
      const childObj = { nested: 1 };
      (err as unknown as Record<string, unknown>).custom = childObj;
      const fe = FabricError.fromNativeError(err);
      deepFreeze(fe);
      // Non-string custom state is preserved AND deep-frozen.
      expect(fe.getExtra("custom")).toBe(childObj);
      expect(Object.isFrozen(childObj)).toBe(true);
    });

    it("[IS_DEEP_FROZEN] true only when wrapper + cause are frozen", () => {
      const fe = FabricError.fromNativeError(new Error("test"));
      expect(isDeepFrozenFabricValue(fe)).toBe(false);
      Object.freeze(fe); // wrapper only; some descendants still mutable
      // (May be true since this particular FabricError has no nested
      // FabricValue descendants beyond primitive strings.)
      deepFreeze(fe);
      expect(isDeepFrozenFabricValue(fe)).toBe(true);
    });
  });

  describe("[DEEP_FREEZE] / [IS_DEEP_FROZEN] protocol — direct member invocation", () => {
    it("[DEEP_FREEZE] freezes wrapper + recurses cause", () => {
      const inner = FabricError.fromNativeError(new Error("cause"));
      const fe = FabricError.fromNativeError(
        new Error("outer", { cause: inner }),
      );
      const result = fe[DEEP_FREEZE](subFreeze);
      expect(result).toBe(fe); // freeze-in-place identity
      expect(Object.isFrozen(fe)).toBe(true);
      expect(isDeepFrozen(inner)).toBe(true);
    });

    it("[DEEP_FREEZE] recurses enumerable custom props (preserved via extras)", () => {
      const err = new Error("e");
      const childObj = { nested: 1 };
      (err as unknown as Record<string, unknown>).custom = childObj;
      const fe = FabricError.fromNativeError(err);
      fe[DEEP_FREEZE](subFreeze);
      // Non-string custom state is preserved AND deep-frozen.
      expect(fe.getExtra("custom")).toBe(childObj);
      expect(Object.isFrozen(childObj)).toBe(true);
    });

    it("[IS_DEEP_FROZEN] true only when wrapper is frozen", () => {
      const fe = FabricError.fromNativeError(new Error("test"));
      expect(fe[IS_DEEP_FROZEN](subIsDeepFrozen)).toBe(false);
      fe[DEEP_FREEZE](subFreeze);
      expect(fe[IS_DEEP_FROZEN](subIsDeepFrozen)).toBe(true);
    });
  });
});
