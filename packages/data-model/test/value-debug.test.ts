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
 * how all of this reaches a `console.log()`.
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
import { FabricPrimitive, FabricSpecialObject } from "@/interface.ts";

describe("value-debug", () => {
  describe("toCompactDebugString", () => {
    it("compactly stringifies a plain object", () => {
      expect(toCompactDebugString({ a: 1, b: "two" }))
        .toBe('{"a":1,"b":"two"}');
    });

    it("compactly stringifies an array", () => {
      expect(toCompactDebugString([1, 2, 3])).toBe("[1,2,3]");
    });

    it("stringifies JSON-native primitives", () => {
      expect(toCompactDebugString(42)).toBe("42");
      expect(toCompactDebugString("hello")).toBe('"hello"');
      expect(toCompactDebugString(true)).toBe("true");
      expect(toCompactDebugString(false)).toBe("false");
      expect(toCompactDebugString(null)).toBe("null");
    });

    it("renders top-level `undefined` as a bare token", () => {
      expect(toCompactDebugString(undefined)).toBe("undefined");
    });

    it("renders `undefined` inside an array as a bare token", () => {
      expect(toCompactDebugString([1, undefined, 2]))
        .toBe("[1,undefined,2]");
    });

    it("renders `undefined` as object value as a bare token", () => {
      expect(toCompactDebugString({ a: undefined, b: 1 }))
        .toBe('{"a":undefined,"b":1}');
    });

    it("renders top-level `bigint` as a bare token with `n` suffix", () => {
      expect(toCompactDebugString(42n)).toBe("42n");
    });

    it("renders zero, negative, and large `bigint`s", () => {
      expect(toCompactDebugString(0n)).toBe("0n");
      expect(toCompactDebugString(-42n)).toBe("-42n");
      expect(toCompactDebugString(12345678901234567890n))
        .toBe("12345678901234567890n");
    });

    it("renders `bigint` inside an array as a bare token", () => {
      expect(toCompactDebugString([42n, 7n]))
        .toBe("[42n,7n]");
    });

    it("renders `bigint` as object value as a bare token", () => {
      expect(toCompactDebugString({ n: 42n }))
        .toBe('{"n":42n}');
    });

    it("does not throw on mixed `bigint`/`undefined` values", () => {
      const v = {
        count: 100n,
        missing: undefined,
        items: [1n, 2n, undefined],
      };
      expect(() => toCompactDebugString(v)).not.toThrow();
      expect(toCompactDebugString(v))
        .toBe('{"count":100n,"missing":undefined,"items":[1n,2n,undefined]}');
    });

    it("renders a hole in an array as `<hole>` and a run of holes as `<N holes>`", () => {
      expect(toCompactDebugString([1, , 3])).toBe("[1,<hole>,3]");
      expect(toCompactDebugString([, , 3])).toBe("[<2 holes>,3]");
      expect(toCompactDebugString([1, , ,])).toBe("[1,<2 holes>]");
      expect(toCompactDebugString([, , , ,])).toBe("[<4 holes>]");
      expect(toCompactDebugString([, 2, , , 5, ,]))
        .toBe("[<hole>,2,<2 holes>,5,<hole>]");
    });

    it("renders a string that resembles a bare token as a quoted string", () => {
      expect(toCompactDebugString("undefined"))
        .toBe('"undefined"');
      expect(toCompactDebugString("42n")).toBe('"42n"');
      expect(toCompactDebugString({ a: "undefined" }))
        .toBe('{"a":"undefined"}');
    });

    it("renders a named function under the `/function` tag", () => {
      function foo() {}
      expect(toCompactDebugString(foo)).toBe('{"/function":"foo(...)"}');
    });

    it("renders a named function inside a structure", () => {
      function bar() {}
      expect(toCompactDebugString({ fn: bar }))
        .toBe('{"fn":{"/function":"bar(...)"}}');
      expect(toCompactDebugString([bar]))
        .toBe('[{"/function":"bar(...)"}]');
    });

    it("renders an anonymous arrow function as `<anonymous>`", () => {
      // An immediately-passed arrow expression has no `name`.

      expect(toCompactDebugString((() => 1) as unknown))
        .toBe('{"/function":"<anonymous>(...)"}');
    });

    it("renders an anonymous `function` expression as `<anonymous>`", () => {
      // Force an empty `name` to simulate a true anonymous function expression
      // (`(function(){}).name === ""`).

      const anon = function () {};
      Object.defineProperty(anon, "name", { value: "" });
      expect(toCompactDebugString(anon)).toBe(
        '{"/function":"<anonymous>(...)"}',
      );
    });

    it("renders a `FabricInstance` under its codec tag with its state", () => {
      // The stack in a `FabricError`'s state names this file and a line in
      // it, so the assertion stops short of the stack.

      const inst = FabricError.fromNativeError(new Error("eek!"));
      expect(toCompactDebugString(inst)).toMatch(
        /^\{"\/Error@1":\{"type":"Error","name":null,"message":"eek!","stack":/,
      );
    });

    it("renders a `FabricPrimitive` under its codec tag with its JSON encoding", () => {
      const inst = new FabricEpochNsec(123456789n);
      expect(toCompactDebugString(inst)).toBe('{"/EpochNsec@1":"B1vNFQ"}');
    });

    it("renders a non-plain non-`FabricSpecialObject` under its class name", () => {
      const inst = new Set();
      expect(toCompactDebugString(inst)).toBe('{"/Set":"/..."}');
    });

    it("renders an interned symbol whose key is an identifier as `@name`", () => {
      expect(toCompactDebugString(Symbol.for("myKey"))).toBe("@myKey");
      expect(toCompactDebugString(Symbol.for("_$x9"))).toBe("@_$x9");
    });

    it('renders an interned symbol whose key is not an identifier as `@"key"`', () => {
      expect(toCompactDebugString(Symbol.for("my-key"))).toBe('@"my-key"');
      expect(toCompactDebugString(Symbol.for("9lives"))).toBe('@"9lives"');
      expect(toCompactDebugString(Symbol.for(""))).toBe('@""');
    });

    it("renders an interned symbol inside a structure", () => {
      const s = Symbol.for("k");
      expect(toCompactDebugString({ s })).toBe('{"s":@k}');
      expect(toCompactDebugString([s])).toBe("[@k]");
    });

    it('renders an uninterned symbol as `Symbol("name")`', () => {
      expect(toCompactDebugString(Symbol("d"))).toBe('Symbol("d")');
    });

    it("renders an uninterned symbol with no description as `Symbol()`", () => {
      expect(toCompactDebugString(Symbol())).toBe("Symbol()");
    });

    it('renders an uninterned symbol with description `""` (empty string)', () => {
      expect(toCompactDebugString(Symbol(""))).toBe('Symbol("")');
    });

    it("renders an uninterned symbol inside a structure", () => {
      const s = Symbol("inner");
      expect(toCompactDebugString({ s })).toBe('{"s":Symbol("inner")}');
      expect(toCompactDebugString([s])).toBe('[Symbol("inner")]');
    });

    it("renders a key of the value that reads `/uniqueSymbol` as itself, escaped", () => {
      expect(toCompactDebugString({ "/uniqueSymbol": "d" }))
        .toBe('{"//uniqueSymbol":"d"}');
    });

    it("renders top-level `NaN` as a bare token", () => {
      expect(toCompactDebugString(NaN)).toBe("NaN");
      expect(toCompactDebugString(0 / 0)).toBe("NaN");
    });

    it("renders top-level positive `Infinity` as a bare token", () => {
      expect(toCompactDebugString(Infinity)).toBe("Infinity");
      expect(toCompactDebugString(Number.POSITIVE_INFINITY)).toBe("Infinity");
    });

    it("renders top-level negative `Infinity` as a bare token", () => {
      expect(toCompactDebugString(-Infinity)).toBe("-Infinity");
      expect(toCompactDebugString(Number.NEGATIVE_INFINITY)).toBe("-Infinity");
    });

    it("renders top-level negative zero as `-0`", () => {
      expect(toCompactDebugString(-0)).toBe("-0");
    });

    it("still renders ordinary `0` as `0` (not `-0`)", () => {
      expect(toCompactDebugString(0)).toBe("0");
    });

    it("renders non-finite numbers and -0 inside an object", () => {
      const v = { a: NaN, b: Infinity, c: -Infinity, d: -0, e: 1 };
      expect(toCompactDebugString(v))
        .toBe('{"a":NaN,"b":Infinity,"c":-Infinity,"d":-0,"e":1}');
    });

    it("renders non-finite numbers and -0 inside an array", () => {
      expect(toCompactDebugString([NaN, Infinity, -Infinity, -0, 0]))
        .toBe("[NaN,Infinity,-Infinity,-0,0]");
    });

    describe("with circular references", () => {
      it("does not throw on a self-referential object (no stack blowout)", () => {
        const a: Record<string, unknown> = { x: 1 };
        a.self = a;
        expect(() => toCompactDebugString(a)).not.toThrow();
      });

      it("renders a self-referential object with `<circle>` for the back-ref", () => {
        const a: Record<string, unknown> = { x: 1 };
        a.self = a;
        expect(toCompactDebugString(a))
          .toBe('{"x":1,"self":<circle>}');
      });

      it("renders a self-referential array with `<circle>` for the back-ref", () => {
        const arr: unknown[] = [1, 2];
        arr.push(arr);
        expect(toCompactDebugString(arr)).toBe("[1,2,<circle>]");
      });

      it("renders a two-object mutual reference cycle", () => {
        const a: Record<string, unknown> = {};
        const b: Record<string, unknown> = { a };
        a.b = b;
        expect(toCompactDebugString(a))
          .toBe('{"b":{"a":<circle>}}');
      });

      it("renders a cycle that closes through several intermediate objects", () => {
        const c: Record<string, unknown> = {};
        const a: Record<string, unknown> = { b: { c } };
        c.back = a;
        expect(toCompactDebugString(a))
          .toBe('{"b":{"c":{"back":<circle>}}}');
      });

      it("renders a cycle nested under a non-circular root", () => {
        const cyc: Record<string, unknown> = {};
        cyc.self = cyc;
        expect(toCompactDebugString({ x: 1, y: cyc }))
          .toBe('{"x":1,"y":{"self":<circle>}}');
      });

      it("renders multiple independent cycles in the same value", () => {
        const c1: Record<string, unknown> = { v: 1 };
        c1.self = c1;
        const c2: Record<string, unknown> = { v: 2 };
        c2.self = c2;
        expect(toCompactDebugString({ a: c1, b: c2 }))
          .toBe(
            '{"a":{"v":1,"self":<circle>},"b":{"v":2,"self":<circle>}}',
          );
      });

      it("renders a key of the value that reads `/circle` as itself, escaped", () => {
        expect(toCompactDebugString({ "/circle": 0 }))
          .toBe('{"//circle":0}');
      });

      it("renders shared non-cyclic refs in full at each occurrence", () => {
        // Sibling references to the same object are not a cycle, so each
        // occurrence is rendered fully rather than treated as a back-edge.

        const x = { v: 1 };
        expect(toCompactDebugString({ a: x, b: x }))
          .toBe('{"a":{"v":1},"b":{"v":1}}');
      });
    });

    describe("with values that resist rendering", () => {
      it("renders a `FabricSpecialObject` with no codec under its class name", () => {
        // A `FabricSpecialObject` with no `[CODEC]` makes `codecOf()` throw.
        // The formatter is most likely to be reached for a value that is
        // already malformed, so it renders what it can rather than adding a
        // second failure on top of the first.

        class RogueSpecial extends FabricSpecialObject {}

        expect(toCompactDebugString(new RogueSpecial())).toBe(
          '{"/RogueSpecial":"/..."}',
        );
      });

      it("renders the error message in place of a `FabricPrimitive` with no codec", () => {
        class RoguePrimitive extends FabricPrimitive {}

        expect(toCompactDebugString(new RoguePrimitive())).toBe(
          '{"/unconvertible":"Shouldn\'t happen: no `[CODEC]` for `RoguePrimitive`."}',
        );
      });

      it("renders a plain object's `toJSON` as the function it is, without calling it", () => {
        // A `toJSON()` that throws is the proof: had it been called, its
        // error would be what got rendered.

        const v = {
          toJSON: () => {
            throw new Error("nope");
          },
        };
        expect(toCompactDebugString(v))
          .toBe('{"toJSON":{"/function":"toJSON(...)"}}');
        expect(toCompactDebugString({ a: 1, b: v }))
          .toBe('{"a":1,"b":{"toJSON":{"/function":"toJSON(...)"}}}');
        expect(toCompactDebugString([1, v, 3]))
          .toBe('[1,{"toJSON":{"/function":"toJSON(...)"}},3]');
      });

      it("renders the error message in place of a value whose enumerable getter throws", () => {
        const v = {};
        Object.defineProperty(v, "x", {
          get: () => {
            throw new Error("nope");
          },
          enumerable: true,
        });
        expect(toCompactDebugString(v)).toBe('{"x":{"/unconvertible":"nope"}}');
      });

      it("renders the error message in the indented form too", () => {
        const v = {};
        Object.defineProperty(v, "x", {
          get: () => {
            throw new Error("nope");
          },
          enumerable: true,
        });
        expect(toIndentedDebugString(v)).toBe(
          '{\n  "x": {\n    "/unconvertible": "nope"\n  }\n}',
        );
      });

      it("does not throw to its caller on a throwing getter", () => {
        const v = {};
        Object.defineProperty(v, "x", {
          get: () => {
            throw new Error("nope");
          },
          enumerable: true,
        });
        expect(() => toCompactDebugString(v)).not.toThrow();
        expect(() => toIndentedDebugString(v)).not.toThrow();
      });
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
          const expected = JSON.stringify(item).slice(0, len - 3) + "...";
          expect(toCompactDebugString(item, len)).toBe(expected);
        });
      }
    });
  });

  describe("toIndentedDebugString", () => {
    it("indents object output with 2 spaces", () => {
      expect(toIndentedDebugString({ a: 1, b: "two" }))
        .toBe('{\n  "a": 1,\n  "b": "two"\n}');
    });

    it("indents array output with 2 spaces", () => {
      expect(toIndentedDebugString([1, 2, 3]))
        .toBe("[\n  1,\n  2,\n  3\n]");
    });

    it("renders top-level `undefined` as bare token", () => {
      expect(toIndentedDebugString(undefined)).toBe("undefined");
    });

    it("renders top-level `bigint` as bare token", () => {
      expect(toIndentedDebugString(42n)).toBe("42n");
    });

    it("renders nested `bigint` and `undefined` as bare tokens", () => {
      const v = { n: 42n, m: undefined };
      expect(toIndentedDebugString(v))
        .toBe('{\n  "n": 42n,\n  "m": undefined\n}');
    });

    it("renders `undefined` and `bigint` inside arrays as bare tokens", () => {
      expect(toIndentedDebugString([1n, undefined, 2n]))
        .toBe("[\n  1n,\n  undefined,\n  2n\n]");
    });

    it("renders a top-level named function under the `/function` tag", () => {
      function baz() {}
      expect(toIndentedDebugString(baz))
        .toBe('{\n  "/function": "baz(...)"\n}');
    });

    it("renders top-level interned symbol as `@name`", () => {
      expect(toIndentedDebugString(Symbol.for("ind"))).toBe("@ind");
    });

    it("renders a nested `function` and `symbol`", () => {
      function qux() {}
      const v = { fn: qux, sym: Symbol("s") };
      expect(toIndentedDebugString(v))
        .toBe(
          '{\n  "fn": {\n    "/function": "qux(...)"\n  },\n' +
            '  "sym": Symbol("s")\n}',
        );
    });

    it("renders non-finite numbers and -0 as bare tokens (top-level)", () => {
      expect(toIndentedDebugString(NaN)).toBe("NaN");
      expect(toIndentedDebugString(Infinity)).toBe("Infinity");
      expect(toIndentedDebugString(-Infinity)).toBe("-Infinity");
      expect(toIndentedDebugString(-0)).toBe("-0");
    });

    it("renders non-finite numbers and -0 inside a structure", () => {
      const v = { a: NaN, b: Infinity, c: -Infinity, d: -0 };
      expect(toIndentedDebugString(v))
        .toBe(
          '{\n  "a": NaN,\n  "b": Infinity,\n  "c": -Infinity,\n  "d": -0\n}',
        );
    });

    it("renders a self-referential object with `<circle>` for the back-ref", () => {
      const a: Record<string, unknown> = { x: 1 };
      a.self = a;
      expect(toIndentedDebugString(a))
        .toBe('{\n  "x": 1,\n  "self": <circle>\n}');
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
    // Delegating to the debug renderer is what makes the state visible.

    it("renders a FabricPrimitive as its debug string, not `{}`", () => {
      const bytes = new FabricBytes(new Uint8Array([1, 2, 3]));
      expect(Deno.inspect(bytes)).toBe('{"/Bytes@1":"AQID"}');
    });

    it("renders a FabricInstance as its debug string, not `{}`", () => {
      const err = FabricError.fromNativeError(new Error("boom"));
      expect(Deno.inspect(err)).toMatch(
        /^\{"\/Error@1":\{"type":"Error","name":null,"message":"boom","stack":/,
      );
    });

    it("renders when nested in containers", () => {
      const bytes = new FabricBytes(new Uint8Array([9]));
      expect(Deno.inspect({ blob: bytes })).toBe('{ blob: {"/Bytes@1":"CQ"} }');
      expect(Deno.inspect([bytes, bytes]))
        .toBe('[ {"/Bytes@1":"CQ"}, {"/Bytes@1":"CQ"} ]');
    });
  });
});
