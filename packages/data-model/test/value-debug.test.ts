/**
 * Rendering a value for a human to read, including the values that resist
 * being rendered.
 *
 * A debug renderer is called on whatever is at hand, usually while something
 * is already wrong, so it has to survive input that would defeat an ordinary
 * serializer: a cycle, a value that refuses to be rendered, a structure too
 * large to print whole. Producing something useful and bounded matters more
 * than producing something complete, which is what the length limit is for.
 *
 * The compact and indented forms differ only in spacing, while the kind string
 * names what a value is without rendering it at all. The custom inspector is
 * how all of this reaches a `console.log()`. The renderings themselves are
 * recorded as case files under `value-debug-cases/`, which
 * `value-debug-cases.test.ts` checks; what is tested here is what a case
 * file cannot express.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  toCompactDebugString,
  toDebugKindString,
  toIndentedDebugString,
} from "@/value-debug.ts";
import { FabricBytes } from "@/fabric-primitives/FabricBytes.ts";
import { FabricEpochNsec } from "@/fabric-primitives/FabricEpochNsec.ts";
import { FabricError } from "@/fabric-instances/FabricError.ts";
import { FabricMap } from "@/fabric-instances/FabricMap.ts";
import { FabricRegExp } from "@/fabric-primitives/FabricRegExp.ts";
import {
  REALM_CODEC,
  type TerminalCodec,
} from "@/codec-interface/interface.ts";
import type { RealmCodecValue } from "@/codec-realm/interface.ts";
import { FabricPrimitive, FabricSpecialObject } from "@/interface.ts";

describe("value-debug", () => {
  describe("toCompactDebugString", () => {
    // The renderings themselves are recorded as case files in
    // `value-debug-cases/`. What is here is what a case file cannot express:
    // a value at the top level, a class the case scope does not include, and
    // the `maxLength` behavior at more than one length.

    it("renders a top-level value the same as it renders that value in an array", () => {
      function foo() {}
      const values = [
        undefined,
        null,
        true,
        42,
        -0,
        NaN,
        42n,
        "str",
        Symbol.for("k"),
        Symbol("d"),
        foo,
        new Set(),
        new FabricEpochNsec(123n),
      ];
      for (const value of values) {
        const nested = toCompactDebugString([value]);
        expect(toCompactDebugString(value)).toBe(nested.slice(1, -1));
      }
    });

    it("renders a `FabricSpecialObject` with no codec under its class name", () => {
      // A `FabricSpecialObject` with no `[CODEC]` makes `codecOf()` throw.
      // The formatter is most likely to be reached for a value that is
      // already malformed, so it renders what it can rather than adding a
      // second failure on top of the first.

      class RogueSpecial extends FabricSpecialObject {}

      expect(toCompactDebugString(new RogueSpecial()))
        .toBe("/RogueSpecial(...)");
    });

    it("renders a `FabricPrimitive` with no codec under its class name", () => {
      class RoguePrimitive extends FabricPrimitive {}

      expect(toCompactDebugString(new RoguePrimitive()))
        .toBe("/RoguePrimitive(...)");
    });

    it("renders a `FabricPrimitive` whose realm state nests arrays and objects", () => {
      // No shipped primitive's realm encoding nests, so a synthetic one
      // stands in: its state holds an array with a buffer inside it, and an
      // object with another object inside that.

      class NestedPrimitive extends FabricPrimitive {
        static get [REALM_CODEC](): TerminalCodec<RealmCodecValue> {
          return {
            tagForValue: () => "Nested@1",
            encode: () => ({
              list: [1, new Uint8Array([1, 2]).buffer, [true]],
              inner: { b: new ArrayBuffer(0), deeper: { n: 3n } },
            }),
          } as unknown as TerminalCodec<RealmCodecValue>;
        }
      }

      expect(toCompactDebugString(new NestedPrimitive())).toBe(
        "/Nested(list:[1,buf [0102],[true]],inner:{b:buf [],deeper:{n:3n}})",
      );
      expect(toIndentedDebugString(new NestedPrimitive())).toBe(
        "/Nested(\n  list: [\n    1,\n    buf [0102],\n    [\n      true\n    ]\n  ],\n" +
          "  inner: {\n    b: buf [],\n    deeper: {\n      n: 3n\n    }\n  }\n)",
      );
    });

    describe("with `maxLength`", () => {
      for (const len of [10, 25, 100]) {
        it("renders the full text when `maxLength` fits the whole thing", () => {
          const item = ["xy", NaN];
          const expected = '["xy",NaN]'; // Note: Length 10.
          expect(toCompactDebugString(item, len)).toBe(expected);
        });

        it("truncates to `maxLength` when it is smaller than the whole rendered length", () => {
          const largeString = "This is a very large string! ".repeat(40);
          const item = { a: 123, b: 456, c: 789, d: largeString };
          const whole = toCompactDebugString(item);
          const expected = whole.slice(0, len - 3) + "...";
          expect(whole.length).toBeGreaterThan(len);
          expect(toCompactDebugString(item, len)).toBe(expected);
          expect(toCompactDebugString(item, len).length).toBe(len);
        });
      }
    });
  });

  describe("toIndentedDebugString", () => {
    it("renders a top-level scalar the same as the compact form does", () => {
      function foo() {}
      const values = [
        undefined,
        null,
        true,
        42,
        -0,
        NaN,
        42n,
        "str",
        Symbol.for("k"),
        Symbol("d"),
        foo,
        new FabricEpochNsec(123n),
      ];
      for (const value of values) {
        expect(toIndentedDebugString(value)).toBe(toCompactDebugString(value));
      }
    });
  });

  describe("toDebugKindString", () => {
    it("renders `null` and `undefined` literally", () => {
      expect(toDebugKindString(null)).toBe("null");
      expect(toDebugKindString(undefined)).toBe("undefined");
    });

    it("renders plain objects as 'object'", () => {
      expect(toDebugKindString({})).toBe("object");
      expect(toDebugKindString({ a: 1 })).toBe("object");
      expect(toDebugKindString(Object.create(null))).toBe("object");
    });

    it("renders arrays as 'array'", () => {
      expect(toDebugKindString([])).toBe("array");
      expect(toDebugKindString([1, 2, 3])).toBe("array");
    });

    it("renders JS primitives as their typeof", () => {
      expect(toDebugKindString(42)).toBe("number");
      expect(toDebugKindString(42n)).toBe("bigint");
      expect(toDebugKindString("hi")).toBe("string");
      expect(toDebugKindString(true)).toBe("boolean");
      expect(toDebugKindString(Symbol("s"))).toBe("symbol");
      expect(toDebugKindString(() => {})).toBe("function");
    });

    it("renders FabricInstance subclasses with their constructor name", () => {
      expect(toDebugKindString(FabricError.fromNativeError(new Error("x"))))
        .toBe("FabricInstance (FabricError)");
      expect(toDebugKindString(new FabricMap(new Map())))
        .toBe("FabricInstance (FabricMap)");
    });

    it("renders FabricPrimitive subclasses with their constructor name", () => {
      expect(toDebugKindString(new FabricEpochNsec(123n)))
        .toBe("FabricPrimitive (FabricEpochNsec)");
      expect(toDebugKindString(new FabricBytes(new Uint8Array([1, 2, 3]))))
        .toBe("FabricPrimitive (FabricBytes)");
      expect(toDebugKindString(new FabricRegExp(/abc/g)))
        .toBe("FabricPrimitive (FabricRegExp)");
    });

    it("renders a non-`FabricSpecialObject` instance with its constructor name", () => {
      expect(toDebugKindString(new Date())).toBe("Date");
      expect(toDebugKindString(new Map())).toBe("Map");
      expect(toDebugKindString(new Set())).toBe("Set");
      expect(toDebugKindString(new Error("oops"))).toBe("Error");
      expect(toDebugKindString(/abc/)).toBe("RegExp");

      class Foo {}
      expect(toDebugKindString(new Foo())).toBe("Foo");
    });

    it("falls back to 'object' when constructor name is unavailable", () => {
      // An object whose prototype was sliced out has no usable
      // `constructor` chain; the predicate returns "object" as a final
      // fallback.

      const weird = Object.create({ constructor: undefined as unknown });
      expect(toDebugKindString(weird)).toBe("object");
    });
  });

  describe("custom inspector", () => {
    // Without the inspector these all render as `{}`: state lives in private
    // fields, which have no enumerable own properties for an inspector to find.

    it("renders a FabricPrimitive as its debug string, not `{}`", () => {
      const bytes = new FabricBytes(new Uint8Array([1, 2, 3]));
      expect(Deno.inspect(bytes)).toBe("/Bytes(buf [010203])");
    });

    it("renders a FabricInstance as its debug string, not `{}`", () => {
      const err = FabricError.fromNativeError(new Error("boom"));
      expect(Deno.inspect(err)).toBe("/Error(...)");
    });

    it("renders when nested in containers", () => {
      const bytes = new FabricBytes(new Uint8Array([9]));
      expect(Deno.inspect({ blob: bytes })).toBe("{ blob: /Bytes(buf [09]) }");
      expect(Deno.inspect([bytes, bytes]))
        .toBe("[ /Bytes(buf [09]), /Bytes(buf [09]) ]");
    });
  });
});
