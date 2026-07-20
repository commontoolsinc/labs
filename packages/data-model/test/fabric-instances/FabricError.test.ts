import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { FabricInstance, type FabricValue } from "@/interface.ts";
import {
  DEEP_FREEZE,
  IS_DEEP_FROZEN,
} from "@/fabric-instances/BaseFabricInstance.ts";
import { CODEC } from "@/codec-common/interface.ts";
import { CODEC_TYPE_TAGS } from "@/codec-common/codec-type-tags.ts";
import { EMPTY_RECONSTRUCTION_CONTEXT } from "@/codec-common/EmptyReconstructionContext.ts";
import { FabricError } from "@/fabric-instances/FabricError.ts";
import { FabricNativeWrapper } from "@/fabric-instances/FabricNativeWrapper.ts";
import {
  deepFreeze,
  isDeepFrozen,
  isDeepFrozenFabricValue,
} from "@/deep-freeze.ts";
import { dummyContext, subFreeze, subIsDeepFrozen } from "./fixtures.ts";

describe("FabricError", () => {
  // Pure type-identity / supertype checks: they don't fit a single member and
  // aren't about construction mechanics, so they live directly under the class
  // `describe()` (the rule's cross-cutting carve-out).
  it("implements `FabricInstance`", () => {
    const se = FabricError.fromNativeError(new Error("test"));
    expect(se instanceof FabricInstance).toBe(true);
  });

  it("is an instance of `FabricNativeWrapper`", () => {
    const se = FabricError.fromNativeError(new Error("test"));
    expect(se instanceof FabricNativeWrapper).toBe(true);
  });

  describe("constructor()", () => {
    it("wraps the `Error`'s `FabricValue`-shaped state", () => {
      const err = new TypeError("bad");
      const se = FabricError.fromNativeError(err);
      expect(se.type).toBe("TypeError");
      expect(se.name).toBe("TypeError");
      expect(se.message).toBe("bad");
    });

    it("has mutable fixed-schema slots while unfrozen", () => {
      const se = FabricError.fromNativeError(new Error("orig"));
      se.message = "changed";
      se.name = "Renamed";
      se.cause = { detail: 1 };
      expect(se.message).toBe("changed");
      expect(se.name).toBe("Renamed");
      expect(se.cause).toEqual({ detail: 1 });
      // The native projection reflects the mutated state (no stale cache).
      expect(se.toNativeValue(true).message).toBe("changed");
    });

    it("throws on fixed-schema slot assignment once frozen", () => {
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
  });

  describe("instance members", () => {
    describe("`[CODEC]` `encode()` state", () => {
      it("returns `type`, `name=null` (common case), `message`, `stack`", () => {
        const se = FabricError.fromNativeError(new Error("hello"));
        const state = FabricError[CODEC].encode(se) as Record<
          string,
          FabricValue
        >;
        expect(state.type).toBe("Error");
        expect(state.name).toBe(null);
        expect(state.message).toBe("hello");
        expect(typeof state.stack).toBe("string");
      });

      it("sets `name` to `null` when `type === name` (`TypeError`)", () => {
        const se = FabricError.fromNativeError(new TypeError("bad"));
        const state = FabricError[CODEC].encode(se) as Record<
          string,
          FabricValue
        >;
        expect(state.type).toBe("TypeError");
        expect(state.name).toBe(null);
      });

      it("sets `name` non-null when `type !== name`", () => {
        const err = new TypeError("bad");
        err.name = "CustomName";
        const se = FabricError.fromNativeError(err);
        const state = FabricError[CODEC].encode(se) as Record<
          string,
          FabricValue
        >;
        expect(state.type).toBe("TypeError");
        expect(state.name).toBe("CustomName");
      });

      it("includes cause when present", () => {
        const inner = FabricError.fromNativeError(new Error("inner"));
        const outer = FabricError.fromNativeError(
          new Error("outer", { cause: inner }),
        );
        const state = FabricError[CODEC].encode(outer) as Record<
          string,
          FabricValue
        >;
        expect(state.cause).toBe(inner);
      });

      it("includes custom enumerable properties", () => {
        const err = new Error("oops");
        (err as unknown as Record<string, unknown>).code = 42;
        (err as unknown as Record<string, unknown>).detail = "more info";
        const se = FabricError.fromNativeError(err);
        const state = FabricError[CODEC].encode(se) as Record<
          string,
          FabricValue
        >;
        expect(state.code).toBe(42);
        expect(state.detail).toBe("more info");
      });

      it("does not copy __proto__ or constructor keys", () => {
        const err = new Error("test");
        Object.defineProperty(err, "__proto__", {
          value: "bad",
          enumerable: true,
        });
        const se = FabricError.fromNativeError(err);
        const state = FabricError[CODEC].encode(se) as Record<
          string,
          FabricValue
        >;
        expect(Object.hasOwn(state, "__proto__")).toBe(false);
        expect(Object.hasOwn(state, "constructor")).toBe(false);
      });

      it("does not let custom props override built-in fields", () => {
        const err = new Error("original");
        // Manually set an enumerable "message" property -- should not override
        Object.defineProperty(err, "message", {
          value: "original",
          enumerable: true,
        });
        (err as unknown as Record<string, unknown>).name = "Error";
        const se = FabricError.fromNativeError(err);
        const state = FabricError[CODEC].encode(se) as Record<
          string,
          FabricValue
        >;
        expect(state.message).toBe("original");
      });

      it("omits stack when undefined", () => {
        const err = new Error("no stack");
        err.stack = undefined;
        const se = FabricError.fromNativeError(err);
        const state = FabricError[CODEC].encode(se) as Record<
          string,
          FabricValue
        >;
        expect("stack" in state).toBe(false);
      });

      it("round-trips through `[CODEC]` `encode()` and `decode()`", () => {
        const original = new Error("round trip");
        original.name = "CustomError";
        (original as unknown as Record<string, unknown>).code = 42;
        const se = FabricError.fromNativeError(original);

        const state = FabricError[CODEC].encode(se);
        const restored = FabricError[CODEC].decode(
          CODEC_TYPE_TAGS.Error,
          state,
          dummyContext,
        ) as unknown as FabricError;

        expect(restored.name).toBe("CustomError");
        expect(restored.message).toBe("round trip");
        expect(restored.getExtra("code")).toBe(42);
      });

      it("round-trips a `TypeError` with overridden `name`", () => {
        const original = new TypeError("bad value");
        original.name = "SpecialType";
        const se = FabricError.fromNativeError(original);

        const state = FabricError[CODEC].encode(se) as Record<
          string,
          FabricValue
        >;
        expect(state.type).toBe("TypeError");
        expect(state.name).toBe("SpecialType");

        const restored = FabricError[CODEC].decode(
          CODEC_TYPE_TAGS.Error,
          state,
          dummyContext,
        ) as unknown as FabricError;
        expect(restored.toNativeValue(true)).toBeInstanceOf(TypeError);
        expect(restored.name).toBe("SpecialType");
      });
    });

    describe("toNativeValue()", () => {
      it("returns a frozen `Error` projection when `frozen` is `true`", () => {
        const err = new Error("native");
        const se = FabricError.fromNativeError(err);
        const result = se.toNativeValue(true);
        expect(result).toBeInstanceOf(Error);
        expect(result.message).toBe("native");
        expect(Object.isFrozen(result)).toBe(true);
        // The originating native Error is not stored / not mutated.
        expect(Object.isFrozen(err)).toBe(false);
      });

      it("caches the projection once frozen", () => {
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

      it("returns a fresh unfrozen `Error` projection when `frozen` is `false`", () => {
        const se = FabricError.fromNativeError(new Error("native"));
        const result = se.toNativeValue(false);
        expect(result).toBeInstanceOf(Error);
        expect(result.message).toBe("native");
        expect(Object.isFrozen(result)).toBe(false);
      });

      it("returns a fresh copy each call when `frozen` is `false`", () => {
        const se = FabricError.fromNativeError(new Error("native"));
        const a = se.toNativeValue(false);
        const b = se.toNativeValue(false);
        expect(a).not.toBe(b);
        expect(a.message).toBe(b.message);
      });
    });

    describe("`[DEEP_FREEZE]` / `[IS_DEEP_FROZEN]`", () => {
      it("via dispatch: `[DEEP_FREEZE]` freezes wrapper + recurses cause", () => {
        const inner = FabricError.fromNativeError(new Error("cause"));
        const fe = FabricError.fromNativeError(
          new Error("outer", { cause: inner }),
        );
        const result = deepFreeze(fe);
        expect(result).toBe(fe); // freeze-in-place identity
        expect(Object.isFrozen(fe)).toBe(true);
        expect(isDeepFrozen(inner)).toBe(true);
      });

      it("via dispatch: `[DEEP_FREEZE]` recurses enumerable custom props (preserved via extras)", () => {
        const err = new Error("e");
        const childObj = { nested: 1 };
        (err as unknown as Record<string, unknown>).custom = childObj;
        const fe = FabricError.fromNativeError(err);
        deepFreeze(fe);
        // Non-string custom state is preserved AND deep-frozen.
        expect(fe.getExtra("custom")).toBe(childObj);
        expect(Object.isFrozen(childObj)).toBe(true);
      });

      it("via dispatch: `[IS_DEEP_FROZEN]` is `true` only when wrapper + cause are frozen", () => {
        const fe = FabricError.fromNativeError(new Error("test"));
        expect(isDeepFrozenFabricValue(fe)).toBe(false);
        Object.freeze(fe); // wrapper only; some descendants still mutable
        // (May be true since this particular FabricError has no nested
        // FabricValue descendants beyond primitive strings.)
        deepFreeze(fe);
        expect(isDeepFrozenFabricValue(fe)).toBe(true);
      });

      it("via direct member invocation: `[DEEP_FREEZE]` freezes wrapper + recurses cause", () => {
        const inner = FabricError.fromNativeError(new Error("cause"));
        const fe = FabricError.fromNativeError(
          new Error("outer", { cause: inner }),
        );
        const result = fe[DEEP_FREEZE](subFreeze);
        expect(result).toBe(fe); // freeze-in-place identity
        expect(Object.isFrozen(fe)).toBe(true);
        expect(isDeepFrozen(inner)).toBe(true);
      });

      it("via direct member invocation: `[DEEP_FREEZE]` recurses enumerable custom props (preserved via extras)", () => {
        const err = new Error("e");
        const childObj = { nested: 1 };
        (err as unknown as Record<string, unknown>).custom = childObj;
        const fe = FabricError.fromNativeError(err);
        fe[DEEP_FREEZE](subFreeze);
        // Non-string custom state is preserved AND deep-frozen.
        expect(fe.getExtra("custom")).toBe(childObj);
        expect(Object.isFrozen(childObj)).toBe(true);
      });

      it("via direct member invocation: `[IS_DEEP_FROZEN]` is `true` only when wrapper is frozen", () => {
        const fe = FabricError.fromNativeError(new Error("test"));
        expect(fe[IS_DEEP_FROZEN](subIsDeepFrozen)).toBe(false);
        fe[DEEP_FREEZE](subFreeze);
        expect(fe[IS_DEEP_FROZEN](subIsDeepFrozen)).toBe(true);
      });
    });
  });

  describe("static members", () => {
    describe("[CODEC]", () => {
      const codec = FabricError[CODEC];
      const expectedTag = CODEC_TYPE_TAGS.Error;
      const context = EMPTY_RECONSTRUCTION_CONTEXT;

      describe("recognizedTypeTag", () => {
        it("is the `Error` wire type tag", () => {
          expect(codec.recognizedTypeTag).toBe(expectedTag);
        });
      });

      describe("canEncode()", () => {
        it("claims a `FabricError`, rejecting other values", () => {
          expect(codec.canEncode(FabricError.fromNativeError(new Error("x"))))
            .toBe(true);
          expect(codec.canEncode("not an error")).toBe(false);
        });
      });

      describe("encode()", () => {
        it("encodes a basic `FabricError` to its `{ type, name, message }` state", () => {
          const se = FabricError.fromNativeError(new Error("test"));
          const state = codec.encode(se) as Record<string, unknown>;
          expect(state.type).toBe("Error");
          expect(state.name).toBe(null); // null = same as type (common case)
          expect(state.message).toBe("test");
        });

        it("encodes `name: null` when `name` matches `type` (`TypeError`)", () => {
          // TypeError: name === constructor.name === "TypeError".
          const se = FabricError.fromNativeError(new TypeError("type check"));
          const state = codec.encode(se) as Record<string, unknown>;
          expect(state.type).toBe("TypeError");
          expect(state.name).toBe(null); // null = same as type
          expect(state.message).toBe("type check");
        });

        it("encodes an explicit `name` when `name` differs from `type`", () => {
          const err = new Error("custom");
          err.name = "MyCustomError";
          const se = FabricError.fromNativeError(err);
          const state = codec.encode(se) as Record<string, unknown>;
          expect(state.type).toBe("Error");
          expect(state.name).toBe("MyCustomError");
          expect(state.message).toBe("custom");
        });
      });

      // Decoding hand-built state (not via `encode()`): exercises name/type
      // handling and back-compat that the round-trip tests don't.
      describe("decode()", () => {
        it("creates a `FabricError` from state (null `name` = same as `type`)", () => {
          const state = { type: "Error", name: null, message: "hello" };
          const result = codec.decode(
            expectedTag,
            state,
            context,
          ) as unknown as FabricError;
          expect(result).toBeInstanceOf(FabricError);
          expect(result.toNativeValue(true)).toBeInstanceOf(Error);
          expect(result.name).toBe("Error");
          expect(result.message).toBe("hello");
        });

        it("creates the correct `Error` subclass from `type` (null `name`)", () => {
          const cases: [string, ErrorConstructor][] = [
            ["TypeError", TypeError],
            ["RangeError", RangeError],
            ["SyntaxError", SyntaxError],
            ["ReferenceError", ReferenceError],
            ["URIError", URIError],
            ["EvalError", EvalError],
          ];
          for (const [type, cls] of cases) {
            const state = { type, name: null, message: "test" };
            const result = codec.decode(
              expectedTag,
              state,
              context,
            ) as unknown as FabricError;
            expect(result.toNativeValue(true)).toBeInstanceOf(cls);
            expect(result.name).toBe(type);
          }
        });

        it("handles `type != name` (e.g. `TypeError` with custom `name`)", () => {
          const state = {
            type: "TypeError",
            name: "CustomTypeName",
            message: "mismatch",
          };
          const result = codec.decode(
            expectedTag,
            state,
            context,
          ) as unknown as FabricError;
          expect(result.toNativeValue(true)).toBeInstanceOf(TypeError);
          expect(result.name).toBe("CustomTypeName");
        });

        it("falls back to `name` when `type` is absent (back-compat)", () => {
          const state = { name: "TypeError", message: "old format" };
          const result = codec.decode(
            expectedTag,
            state,
            context,
          ) as unknown as FabricError;
          expect(result.toNativeValue(true)).toBeInstanceOf(TypeError);
        });

        it("handles a custom `name`", () => {
          const state = { type: "Error", name: "MyCustomError", message: "x" };
          const result = codec.decode(
            expectedTag,
            state,
            context,
          ) as unknown as FabricError;
          expect(result.name).toBe("MyCustomError");
        });

        it("restores cause and custom properties", () => {
          const state = {
            type: "Error",
            name: null,
            message: "with extras",
            cause: "something went wrong",
            code: 404,
          };
          const result = codec.decode(
            expectedTag,
            state,
            context,
          ) as unknown as FabricError;
          expect(result.cause).toBe("something went wrong");
          expect(result.getExtra("code")).toBe(404);
        });
      });

      describe("round trip encode-decode", () => {
        it("round-trips a basic `Error`", () => {
          const se = FabricError.fromNativeError(new Error("hello"));
          const decoded = codec.decode(
            expectedTag,
            codec.encode(se),
            context,
          ) as unknown as FabricError;
          expect(decoded).toBeInstanceOf(FabricError);
          expect(decoded.toNativeValue(true)).toBeInstanceOf(Error);
          expect(decoded.name).toBe("Error");
          expect(decoded.message).toBe("hello");
        });

        it("round-trips a `TypeError`", () => {
          const se = FabricError.fromNativeError(new TypeError("bad type"));
          const decoded = codec.decode(
            expectedTag,
            codec.encode(se),
            context,
          ) as unknown as FabricError;
          expect(decoded).toBeInstanceOf(FabricError);
          expect(decoded.toNativeValue(true)).toBeInstanceOf(TypeError);
          expect(decoded.name).toBe("TypeError");
          expect(decoded.message).toBe("bad type");
        });

        it("round-trips a `RangeError`", () => {
          const se = FabricError.fromNativeError(
            new RangeError("out of range"),
          );
          const decoded = codec.decode(
            expectedTag,
            codec.encode(se),
            context,
          ) as unknown as FabricError;
          expect(decoded).toBeInstanceOf(FabricError);
          expect(decoded.toNativeValue(true)).toBeInstanceOf(RangeError);
          expect(decoded.name).toBe("RangeError");
        });

        it("round-trips an `Error` with a (pre-converted) cause", () => {
          const inner = FabricError.fromNativeError(new Error("inner"));
          const outer = FabricError.fromNativeError(
            new Error("outer", { cause: inner }),
          );
          const decoded = codec.decode(
            expectedTag,
            codec.encode(outer),
            context,
          ) as unknown as FabricError;
          expect(decoded.message).toBe("outer");
          // The cause is a FabricError (the inner wrapper) after round-trip.
          expect(decoded.cause).toBeInstanceOf(FabricError);
          expect((decoded.cause as FabricError).message).toBe("inner");
        });

        it("round-trips an `Error` whose cause is itself a `FabricError`", () => {
          // Simulates what `fabricFromNativeValue` produces: a FabricError
          // wrapping an Error whose cause is itself a FabricError (not a raw
          // Error). Encoding's recurse on `[CODEC]` `encode()` output must find
          // a FabricValue, not a raw Error.
          const innerSe = FabricError.fromNativeError(new Error("inner"));
          const outerErr = new Error("outer");
          outerErr.cause = innerSe;
          const outerSe = FabricError.fromNativeError(outerErr);
          const decoded = codec.decode(
            expectedTag,
            codec.encode(outerSe),
            context,
          ) as unknown as FabricError;
          expect(decoded.message).toBe("outer");
          expect(decoded.cause).toBeInstanceOf(FabricError);
          expect((decoded.cause as FabricError).message).toBe("inner");
        });

        it("round-trips an `Error` with custom properties", () => {
          const err = new Error("oops");
          (err as unknown as Record<string, unknown>).code = 42;
          (err as unknown as Record<string, unknown>).detail = "more info";
          const se = FabricError.fromNativeError(err);
          const decoded = codec.decode(
            expectedTag,
            codec.encode(se),
            context,
          ) as unknown as FabricError;
          expect(decoded.message).toBe("oops");
          const native = decoded.toNativeValue(true) as unknown as Record<
            string,
            unknown
          >;
          expect(native.code).toBe(42);
          expect(native.detail).toBe("more info");
        });

        it("round-trips an `Error` with a custom `name`", () => {
          const err = new Error("custom");
          err.name = "MyCustomError";
          const se = FabricError.fromNativeError(err);
          const decoded = codec.decode(
            expectedTag,
            codec.encode(se),
            context,
          ) as unknown as FabricError;
          expect(decoded.name).toBe("MyCustomError");
          expect(decoded.message).toBe("custom");
        });

        it("round-trips a `TypeError` preserving `name === type` identity", () => {
          const se = FabricError.fromNativeError(new TypeError("rt"));
          const decoded = codec.decode(
            expectedTag,
            codec.encode(se),
            context,
          ) as unknown as FabricError;
          expect(decoded.toNativeValue(true)).toBeInstanceOf(TypeError);
          expect(decoded.name).toBe("TypeError");
          expect(decoded.toNativeValue(true).constructor.name).toBe(
            "TypeError",
          );
        });

        it("round-trips an `Error` with mismatched `name` and `type`", () => {
          // Error constructor is "Error" but name is overridden.
          const err = new Error("mismatch");
          err.name = "CustomName";
          const se = FabricError.fromNativeError(err);
          const decoded = codec.decode(
            expectedTag,
            codec.encode(se),
            context,
          ) as unknown as FabricError;
          expect(decoded.toNativeValue(true)).toBeInstanceOf(Error);
          expect(decoded.name).toBe("CustomName");
          expect(decoded.toNativeValue(true).constructor.name).toBe("Error");
        });
      });
    });
  });
});
