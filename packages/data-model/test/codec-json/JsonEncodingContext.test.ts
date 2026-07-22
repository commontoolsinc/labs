import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { JsonEncodingContext } from "@/codec-json/JsonEncodingContext.ts";
import { FabricInstance, type FabricValue } from "@/interface.ts";
import type { JsonWireValue } from "@/codec-json/interface.ts";
import { UnknownValue } from "@/fabric-instances/UnknownValue.ts";
import { ProblematicValue } from "@/fabric-instances/ProblematicValue.ts";
import {
  BaseFabricInstance,
  DEEP_FREEZE,
  IS_DEEP_FROZEN,
  SHALLOW_UNFROZEN_CLONE,
} from "@/fabric-instances/BaseFabricInstance.ts";
import { FabricEpochDays } from "@/fabric-primitives/FabricEpochDays.ts";
import { FabricEpochNsec } from "@/fabric-primitives/FabricEpochNsec.ts";
import { FabricRegExp } from "@/fabric-primitives/FabricRegExp.ts";
import { FabricError } from "@/fabric-instances/FabricError.ts";
import { isDeepFrozen } from "@/deep-freeze.ts";
import { BaseReconstructionContext } from "@/codec-common/BaseReconstructionContext.ts";

/**
 * Shared test `ReconstructionContext`: `getCell()` always throws (no test
 * here reaches it); `shouldDeepFreeze` is inherited from
 * `BaseReconstructionContext` (defaults to `true`).
 */
class TestReconstructionContext extends BaseReconstructionContext {
  constructor() {
    super(true);
  }

  override getCell(): never {
    throw new Error("getCell not implemented in test runtime");
  }
}

/**
 * A `FabricInstance` with no registered codec, for exercising the encode-side
 * mandate guard (every wire form must be explicitly represented).
 */
class UnregisteredInstance extends BaseFabricInstance {
  get wireTypeTag(): string {
    return "Unregistered@1";
  }

  protected [SHALLOW_UNFROZEN_CLONE](): FabricInstance {
    return new UnregisteredInstance();
  }

  // The encode-side mandate guard fires before any of these are reached, so
  // they are throwing stubs.
  deepClone(_frozen: boolean): FabricInstance {
    throw new Error("not implemented");
  }

  [DEEP_FREEZE](_subFreeze: (value: FabricValue) => FabricValue): FabricValue {
    throw new Error("not implemented");
  }

  [IS_DEEP_FROZEN](
    _subIsDeepFrozen: (value: FabricValue) => boolean,
  ): boolean {
    throw new Error("not implemented");
  }
}

/**
 * The encoding prefix tag, named once for the assertions below that pin the
 * wire form or that feed the decoder deliberately broken input. Bridging
 * between encoded strings and wire-format trees does NOT go through this --
 * that is what `JsonEncodingContext`'s wrap/unwrap helpers are for.
 */
const ENCODING_PREFIX = "fvj1:";

/** Creates a standard test context (non-lenient) and a mock runtime. */
function makeTestContext() {
  const context = new JsonEncodingContext();
  const runtime = new TestReconstructionContext();
  return { context, runtime };
}

/** Helper: encode then decode (round-trip) through the public API. */
function roundTrip(value: FabricValue): FabricValue {
  const { context, runtime } = makeTestContext();
  const encoded = context.encode(value);
  return context.decode(encoded, runtime);
}

/**
 * Helper: encode a value and return the wire-format tree (parsed JSON).
 * Used for assertions about the intermediate wire representation.
 */
function toWireFormat(value: FabricValue): JsonWireValue {
  const { context } = makeTestContext();
  const encoded = context.encode(value);
  return JSON.parse(
    JsonEncodingContext.unwrapEncodedValueForTesting(encoded),
  ) as JsonWireValue;
}

/**
 * Helper: decode from a wire-format tree. Stringifies to JSON first (tagged as
 * an encoded value), then feeds through the public decode API.
 */
function fromWireFormat(data: JsonWireValue): FabricValue {
  const { context, runtime } = makeTestContext();
  return context.decode(
    JsonEncodingContext.wrapEncodedValueForTesting(JSON.stringify(data)),
    runtime,
  );
}

describe("JsonEncodingContext", () => {
  describe("`encodeToBytes()` / `decodeFromBytes()` (bytes entry points)", () => {
    it("returns `Uint8Array` from `encodeToBytes()`", () => {
      const { context } = makeTestContext();
      const result = context.encodeToBytes(42);
      expect(result).toBeInstanceOf(Uint8Array);
    });

    it("produces valid JSON bytes from `encodeToBytes()`", () => {
      const { context } = makeTestContext();
      const bytes = context.encodeToBytes(
        { a: 1 } as unknown as FabricValue,
      );
      const json = new TextDecoder().decode(bytes);
      expect(JSON.parse(json)).toEqual({ a: 1 });
    });

    it("accepts `Uint8Array` in `decodeFromBytes()`", () => {
      const { context, runtime } = makeTestContext();
      const bytes = new TextEncoder().encode(JSON.stringify({ a: 1 }));
      const result = context.decodeFromBytes(
        bytes,
        runtime,
      ) as Record<string, FabricValue>;
      expect(result.a).toBe(1);
    });

    it("round-trips through `Uint8Array`", () => {
      const { context, runtime } = makeTestContext();
      const value = {
        name: "test",
        count: 42,
      } as unknown as FabricValue;
      const bytes = context.encodeToBytes(value);
      const result = context.decodeFromBytes(
        bytes,
        runtime,
      ) as Record<string, FabricValue>;
      expect(result.name).toBe("test");
      expect(result.count).toBe(42);
    });

    it("round-trips `FabricError` through `Uint8Array`", () => {
      const { context, runtime } = makeTestContext();
      const err = FabricError.fromNativeError(new TypeError("oops"));
      const bytes = context.encodeToBytes(err as FabricValue);
      const result = context.decodeFromBytes(
        bytes,
        runtime,
      );
      expect(result).toBeInstanceOf(FabricError);
      const se = result as unknown as FabricError;
      expect(se.toNativeValue(true)).toBeInstanceOf(TypeError);
      expect(se.message).toBe("oops");
    });

    it("round-trips `undefined` through `Uint8Array`", () => {
      const { context, runtime } = makeTestContext();
      const bytes = context.encodeToBytes(undefined);
      const result = context.decodeFromBytes(bytes, runtime);
      expect(result).toBe(undefined);
    });

    it("round-trips complex structure through `Uint8Array`", () => {
      const { context, runtime } = makeTestContext();
      const value = {
        users: [{ name: "Alice" }, { name: "Bob" }],
        error: FabricError.fromNativeError(new Error("fail")),
        nothing: undefined,
      } as unknown as FabricValue;
      const bytes = context.encodeToBytes(value);
      const result = context.decodeFromBytes(
        bytes,
        runtime,
      ) as Record<string, FabricValue>;
      const users = result.users as FabricValue[];
      expect((users[0] as Record<string, FabricValue>).name).toBe("Alice");
      expect(result.error).toBeInstanceOf(FabricError);
      expect(result.nothing).toBe(undefined);
    });
  });

  describe("primitives round-trip", () => {
    it("passes through `null`", () => {
      expect(roundTrip(null)).toBe(null);
    });

    it("passes through `true`", () => {
      expect(roundTrip(true)).toBe(true);
    });

    it("passes through `false`", () => {
      expect(roundTrip(false)).toBe(false);
    });

    it("passes through `0`", () => {
      expect(roundTrip(0)).toBe(0);
    });

    it("passes through `42`", () => {
      expect(roundTrip(42)).toBe(42);
    });

    it("passes through `3.14`", () => {
      expect(roundTrip(3.14)).toBe(3.14);
    });

    it("passes through empty string", () => {
      expect(roundTrip("")).toBe("");
    });

    it("passes through `hello`", () => {
      expect(roundTrip("hello")).toBe("hello");
    });

    it("passes through strings with special characters", () => {
      expect(roundTrip("with\nnewlines")).toBe("with\nnewlines");
      expect(roundTrip("with\ttabs")).toBe("with\ttabs");
      expect(roundTrip('with"quotes')).toBe('with"quotes');
    });

    it("passes through `Number.MAX_SAFE_INTEGER`", () => {
      expect(roundTrip(Number.MAX_SAFE_INTEGER)).toBe(
        Number.MAX_SAFE_INTEGER,
      );
    });

    it("passes through negative numbers", () => {
      expect(roundTrip(-1)).toBe(-1);
      expect(roundTrip(-3.14)).toBe(-3.14);
    });
  });

  describe("tagged-type round-trips through the full stack", () => {
    // Representative coverage that the encode→tag-wrap→decode mechanism works
    // for the standalone-codec and primitive Fabric types, including nesting in
    // arrays and objects. Per-codec encode/decode detail lives in each type's
    // own unit test (e.g. `BigIntCodec.test.ts`, `FabricEpochNsec.test.ts`).

    it("round-trips `undefined` at top level, in arrays, and as object values", () => {
      expect(roundTrip(undefined)).toBe(undefined);

      const arr = [1, undefined, 3] as FabricValue;
      const arrResult = roundTrip(arr) as FabricValue[];
      expect(arrResult[0]).toBe(1);
      expect(arrResult[1]).toBe(undefined);
      expect(1 in arrResult).toBe(true); // not a hole
      expect(arrResult[2]).toBe(3);

      const obj = { a: 1, b: undefined } as unknown as FabricValue;
      const objResult = roundTrip(obj) as Record<string, FabricValue>;
      expect(objResult.a).toBe(1);
      expect(objResult.b).toBe(undefined);
      expect("b" in objResult).toBe(true); // key preserved
    });

    it("round-trips `bigint` at top level, in arrays, and as object values", () => {
      expect(roundTrip(42n as FabricValue)).toBe(42n);

      const arr = [1, 42n, "hello"] as unknown as FabricValue;
      const arrResult = roundTrip(arr) as FabricValue[];
      expect(arrResult[0]).toBe(1);
      expect(arrResult[1]).toBe(42n);
      expect(arrResult[2]).toBe("hello");

      const obj = { a: 1, b: 42n } as unknown as FabricValue;
      const objResult = roundTrip(obj) as Record<string, FabricValue>;
      expect(objResult.a).toBe(1);
      expect(objResult.b).toBe(42n);
    });

    it("round-trips special numbers (`-0`/`NaN`/`±Infinity`) at top level, in arrays, and as object values", () => {
      // `+0` is not a special number; it round-trips as a plain JSON number.
      expect(roundTrip(0)).toBe(0);
      expect(Object.is(roundTrip(-0), -0)).toBe(true);
      expect(Number.isNaN(roundTrip(NaN))).toBe(true);
      expect(roundTrip(Infinity)).toBe(Infinity);
      expect(roundTrip(-Infinity)).toBe(-Infinity);

      const arr = [1, NaN, -0, Infinity, -Infinity, 2] as FabricValue;
      const arrResult = roundTrip(arr) as number[];
      expect(arrResult[0]).toBe(1);
      expect(Number.isNaN(arrResult[1])).toBe(true);
      expect(Object.is(arrResult[2], -0)).toBe(true);
      expect(arrResult[3]).toBe(Infinity);
      expect(arrResult[4]).toBe(-Infinity);
      expect(arrResult[5]).toBe(2);

      const obj = {
        nz: -0,
        nan: NaN,
        pinf: Infinity,
        ninf: -Infinity,
      } as unknown as FabricValue;
      const objResult = roundTrip(obj) as Record<string, number>;
      expect(Object.is(objResult.nz, -0)).toBe(true);
      expect(Number.isNaN(objResult.nan)).toBe(true);
      expect(objResult.pinf).toBe(Infinity);
      expect(objResult.ninf).toBe(-Infinity);
    });

    it("round-trips interned symbols at top level, in arrays, and as object values", () => {
      const top = roundTrip(Symbol.for("hello") as FabricValue);
      expect(typeof top).toBe("symbol");
      expect(top).toBe(Symbol.for("hello"));

      const arr = [
        Symbol.for("a"),
        1,
        Symbol.for("b"),
      ] as unknown as FabricValue;
      const arrResult = roundTrip(arr) as unknown[];
      expect(arrResult[0]).toBe(Symbol.for("a"));
      expect(arrResult[1]).toBe(1);
      expect(arrResult[2]).toBe(Symbol.for("b"));

      const obj = {
        kind: Symbol.for("event"),
        flag: Symbol.for("ready"),
      } as unknown as FabricValue;
      const objResult = roundTrip(obj) as Record<string, unknown>;
      expect(objResult.kind).toBe(Symbol.for("event"));
      expect(objResult.flag).toBe(Symbol.for("ready"));
    });

    it("loudly fails to encode an unencodable value (unique / uninterned `Symbol`)", () => {
      // `SymbolCodec.canEncode()` returns false for unique symbols (no
      // registry key), so no codec claims them. A default-configured context
      // must then fail loudly rather than silently flatten the symbol to `{}`.
      const { context } = makeTestContext();
      expect(() => context.encode(Symbol("nope") as FabricValue)).toThrow(
        "no applicable codec",
      );
    });

    it("round-trips `FabricEpochNsec` at top level and in nested structures", () => {
      const top = roundTrip(
        new FabricEpochNsec(1704067200000000000n) as FabricValue,
      ) as unknown as FabricEpochNsec;
      expect(top).toBeInstanceOf(FabricEpochNsec);
      expect(top.value).toBe(1704067200000000000n);

      const obj = {
        timestamp: new FabricEpochNsec(42000000000n),
        label: "test",
      } as unknown as FabricValue;
      const result = roundTrip(obj) as Record<string, FabricValue>;
      expect(result.label).toBe("test");
      const ts = result.timestamp as unknown as FabricEpochNsec;
      expect(ts).toBeInstanceOf(FabricEpochNsec);
      expect(ts.value).toBe(42000000000n);
    });

    it("round-trips `FabricEpochDays` at top level and in nested structures", () => {
      const top = roundTrip(
        new FabricEpochDays(19723n) as FabricValue,
      ) as unknown as FabricEpochDays;
      expect(top).toBeInstanceOf(FabricEpochDays);
      expect(top.value).toBe(19723n);

      const obj = {
        date: new FabricEpochDays(19723n),
        label: "birthday",
      } as unknown as FabricValue;
      const result = roundTrip(obj) as Record<string, FabricValue>;
      expect(result.label).toBe("birthday");
      const d = result.date as unknown as FabricEpochDays;
      expect(d).toBeInstanceOf(FabricEpochDays);
      expect(d.value).toBe(19723n);
    });

    it("round-trips `FabricRegExp` at top level and in nested structures", () => {
      const top = roundTrip(
        new FabricRegExp(/ab+c/gi) as FabricValue,
      ) as unknown as FabricRegExp;
      expect(top).toBeInstanceOf(FabricRegExp);
      expect(top.source).toBe("ab+c");
      expect(top.flags).toBe("gi");
      expect(top.flavor).toBe("es2025");

      const obj = {
        pattern: new FabricRegExp(/\d+/g),
        label: "digits",
      } as unknown as FabricValue;
      const result = roundTrip(obj) as Record<string, FabricValue>;
      expect(result.label).toBe("digits");
      const re = result.pattern as unknown as FabricRegExp;
      expect(re).toBeInstanceOf(FabricRegExp);
      expect(re.source).toBe("\\d+");
      expect(re.flags).toBe("g");
    });
  });

  describe("un-registered instance types", () => {
    it("throws when encoding a `FabricInstance` with no registered codec", () => {
      const { context } = makeTestContext();
      expect(() => context.encode(new UnregisteredInstance() as FabricValue))
        .toThrow("No codec registered");
    });

    it("throws on a non-plain object with no codec (e.g. a raw `Map`)", () => {
      // A non-plain object that is neither a FabricInstance nor codec-handled
      // must fail loudly, not be mis-encoded as a plain object.
      const { context } = makeTestContext();
      expect(() => context.encode(new Map() as unknown as FabricValue))
        .toThrow("no applicable codec");
    });
  });

  describe("dense arrays", () => {
    it("round-trips empty array", () => {
      const result = roundTrip([]) as FabricValue[];
      expect(result).toEqual([]);
    });

    it("round-trips single-element array", () => {
      const result = roundTrip([42]) as FabricValue[];
      expect(result.length).toBe(1);
      expect(result[0]).toBe(42);
    });

    it("round-trips mixed-type array", () => {
      const arr = [null, "str", true, 42] as FabricValue;
      const result = roundTrip(arr) as FabricValue[];
      expect(result[0]).toBe(null);
      expect(result[1]).toBe("str");
      expect(result[2]).toBe(true);
      expect(result[3]).toBe(42);
    });

    it("round-trips nested arrays", () => {
      const arr = [[1, 2], [3, [4, 5]]] as FabricValue;
      const result = roundTrip(arr) as FabricValue[];
      expect((result[0] as FabricValue[])[0]).toBe(1);
      expect((result[0] as FabricValue[])[1]).toBe(2);
      expect(
        ((result[1] as FabricValue[])[1] as FabricValue[])[0],
      ).toBe(4);
    });
  });

  describe("sparse arrays", () => {
    it("serializes `[1,,3]` with `/hole`", () => {
      // deno-lint-ignore no-sparse-arrays
      const arr = [1, , 3] as FabricValue;
      const result = toWireFormat(arr) as JsonWireValue[];
      expect(result.length).toBe(3);
      expect(result[0]).toBe(1);
      expect(result[1]).toEqual({ "/hole": 1 });
      expect(result[2]).toBe(3);
    });

    it("round-trips `[1,,3]` preserving holes", () => {
      // deno-lint-ignore no-sparse-arrays
      const arr = [1, , 3] as FabricValue;
      const result = roundTrip(arr) as FabricValue[];
      expect(result.length).toBe(3);
      expect(result[0]).toBe(1);
      expect(1 in result).toBe(false); // true hole
      expect(result[2]).toBe(3);
    });

    it("serializes consecutive holes as run-length encoded", () => {
      // deno-lint-ignore no-sparse-arrays
      const arr = [1, , , , 5] as FabricValue;
      const result = toWireFormat(arr) as JsonWireValue[];
      expect(result.length).toBe(3); // [1, {"/hole": 3}, 5]
      expect(result[0]).toBe(1);
      expect(result[1]).toEqual({ "/hole": 3 });
      expect(result[2]).toBe(5);
    });

    it("round-trips `[1,,,,5]`", () => {
      // deno-lint-ignore no-sparse-arrays
      const arr = [1, , , , 5] as FabricValue;
      const result = roundTrip(arr) as FabricValue[];
      expect(result.length).toBe(5);
      expect(result[0]).toBe(1);
      expect(1 in result).toBe(false);
      expect(2 in result).toBe(false);
      expect(3 in result).toBe(false);
      expect(result[4]).toBe(5);
    });

    it("round-trips all-holes array `[,,,]`", () => {
      // deno-lint-ignore no-sparse-arrays
      const arr = [, , ,] as FabricValue;
      const result = roundTrip(arr) as FabricValue[];
      expect(result.length).toBe(3);
      expect(0 in result).toBe(false);
      expect(1 in result).toBe(false);
      expect(2 in result).toBe(false);
    });

    it("round-trips very sparse array", () => {
      const arr = new Array(1000001) as FabricValue[];
      arr[1000000] = "x";
      const result = roundTrip(arr as FabricValue) as FabricValue[];
      expect(result.length).toBe(1000001);
      expect(0 in result).toBe(false);
      expect(999999 in result).toBe(false);
      expect(result[1000000]).toBe("x");
    });

    it("round-trips interleaved holes and `undefined`", () => {
      // [1, <hole>, undefined, <hole>, 3]
      const arr = new Array(5) as FabricValue[];
      arr[0] = 1;
      // index 1 is a hole
      arr[2] = undefined;
      // index 3 is a hole
      arr[4] = 3;
      const result = roundTrip(arr as FabricValue) as FabricValue[];
      expect(result.length).toBe(5);
      expect(result[0]).toBe(1);
      expect(1 in result).toBe(false); // hole
      expect(result[2]).toBe(undefined);
      expect(2 in result).toBe(true); // not a hole
      expect(3 in result).toBe(false); // hole
      expect(result[4]).toBe(3);
    });

    it("serializes interleaved holes/`undefined` correctly", () => {
      const arr = new Array(5) as FabricValue[];
      arr[0] = 1;
      arr[2] = undefined;
      arr[4] = 3;
      const result = toWireFormat(arr as FabricValue) as JsonWireValue[];
      expect(result).toEqual([
        1,
        { "/hole": 1 },
        { "/Undefined@1": null },
        { "/hole": 1 },
        3,
      ]);
    });
  });

  describe("plain objects", () => {
    it("round-trips empty object", () => {
      const result = roundTrip({}) as Record<string, FabricValue>;
      expect(Object.keys(result)).toEqual([]);
    });

    it("round-trips simple object", () => {
      const obj = { a: 1, b: "two", c: true } as unknown as FabricValue;
      const result = roundTrip(obj) as Record<string, FabricValue>;
      expect(result.a).toBe(1);
      expect(result.b).toBe("two");
      expect(result.c).toBe(true);
    });

    it("round-trips nested objects", () => {
      const obj = { outer: { inner: 42 } } as unknown as FabricValue;
      const result = roundTrip(obj) as Record<
        string,
        Record<string, FabricValue>
      >;
      expect(result.outer!.inner).toBe(42);
    });

    it("preserves `undefined` values in objects", () => {
      const obj = { a: 1, b: undefined } as unknown as FabricValue;
      const result = roundTrip(obj) as Record<string, FabricValue>;
      expect(result.a).toBe(1);
      expect(result.b).toBe(undefined);
      expect("b" in result).toBe(true);
    });

    describe("key ordering (Section 10)", () => {
      it("emits keys in UTF-8 byte order for a bare plain object", () => {
        const obj = { c: 3, a: 1, b: 2 } as unknown as FabricValue;
        const wire = toWireFormat(obj) as Record<string, JsonWireValue>;
        expect(Object.keys(wire)).toEqual(["a", "b", "c"]);
      });

      it("emits keys in UTF-8 byte order regardless of insertion order", () => {
        const obj1 = { x: 1, y: 2, z: 3 } as unknown as FabricValue;
        const obj2 = { z: 3, x: 1, y: 2 } as unknown as FabricValue;
        const obj3 = { y: 2, z: 3, x: 1 } as unknown as FabricValue;
        const ctx = new JsonEncodingContext();
        expect(ctx.encode(obj1)).toBe(ctx.encode(obj2));
        expect(ctx.encode(obj1)).toBe(ctx.encode(obj3));
      });

      it("sorts keys in nested plain objects", () => {
        const obj = {
          b: { z: 1, a: 2 },
          a: 0,
        } as unknown as FabricValue;
        const wire = toWireFormat(obj) as Record<string, JsonWireValue>;
        expect(Object.keys(wire)).toEqual(["a", "b"]);
        const inner = wire.b as Record<string, JsonWireValue>;
        expect(Object.keys(inner)).toEqual(["a", "z"]);
      });

      it("sorts keys correctly for supplementary characters (UTF-8 vs UTF-16)", () => {
        // U+10000 (UTF-16: D800 DC00; UTF-8: F0 90 80 80) sorts AFTER U+E000
        // (UTF-16: E000; UTF-8: EE 80 80) in UTF-8 byte order, but BEFORE it in
        // JS native (UTF-16) order. The encoder must use UTF-8 order.
        const obj = {
          ["\u{10000}"]: 1,
          [""]: 2,
        } as unknown as FabricValue;
        const wire = toWireFormat(obj) as Record<string, JsonWireValue>;
        expect(Object.keys(wire)).toEqual(["", "\u{10000}"]);
      });

      it("matches the key order used by `value-hash.ts`", async () => {
        // Both subsystems must agree on the canonical sort order. Cross-check
        // via `utf8SortedKeysOf`, which is the function value-hash.ts uses.
        const { utf8SortedKeysOf } = await import(
          "@commonfabric/utils/utf8"
        );
        const obj = {
          ["\u{1F600}"]: 1,
          b: 2,
          ["﻿"]: 3,
          a: 4,
        } as unknown as FabricValue;
        const wire = toWireFormat(obj) as Record<string, JsonWireValue>;
        expect(Object.keys(wire)).toEqual([...utf8SortedKeysOf(obj as object)]);
      });
    });
  });

  describe("/object escaping", () => {
    describe("/quote: literal-only /-keyed objects", () => {
      it("emits `/quote` for single-key literal `/`-prefixed object", () => {
        const obj = { "/myKey": "val" } as unknown as FabricValue;
        expect(toWireFormat(obj)).toEqual({ "/quote": { "/myKey": "val" } });
      });

      it('round-trips `{ "/myKey": "val" }`', () => {
        const obj = { "/myKey": "val" } as unknown as FabricValue;
        const result = roundTrip(obj) as Record<string, FabricValue>;
        expect(result["/myKey"]).toBe("val");
      });

      it('emits `/quote` for `{ "/Link@1": "fake" }` (looks like tag but is literal user data)', () => {
        const obj = { "/Link@1": "fake" } as unknown as FabricValue;
        expect(toWireFormat(obj)).toEqual({ "/quote": { "/Link@1": "fake" } });
      });

      it('round-trips `{ "/Link@1": "fake" }`', () => {
        const obj = { "/Link@1": "fake" } as unknown as FabricValue;
        const result = roundTrip(obj) as Record<string, FabricValue>;
        expect(result["/Link@1"]).toBe("fake");
      });

      it("emits `/quote` for multi-key literal object with one `/`-prefixed key", () => {
        const obj = { a: 1, "/b": 2 } as unknown as FabricValue;
        expect(toWireFormat(obj)).toEqual({ "/quote": { a: 1, "/b": 2 } });
      });

      it("round-trips multi-key literal object with one `/`-prefixed key", () => {
        const obj = { a: 1, "/b": 2 } as unknown as FabricValue;
        const result = roundTrip(obj) as Record<string, FabricValue>;
        expect(result["a"]).toBe(1);
        expect(result["/b"]).toBe(2);
      });

      it("emits `/quote` for multi-key literal object with multiple `/`-prefixed keys", () => {
        const obj = { "/a": 1, "/b": 2, c: 3 } as unknown as FabricValue;
        expect(toWireFormat(obj)).toEqual({
          "/quote": { "/a": 1, "/b": 2, c: 3 },
        });
      });

      it("round-trips multi-key literal object with multiple `/`-prefixed keys", () => {
        const obj = { "/a": 1, "/b": 2, c: 3 } as unknown as FabricValue;
        const result = roundTrip(obj) as Record<string, FabricValue>;
        expect(result["/a"]).toBe(1);
        expect(result["/b"]).toBe(2);
        expect(result["c"]).toBe(3);
      });

      it("emits `/quote` when value is a plain nested object (no `/`-keys inside)", () => {
        const obj = { "/x": { a: 1 } } as unknown as FabricValue;
        expect(toWireFormat(obj)).toEqual({ "/quote": { "/x": { a: 1 } } });
      });

      it("round-trips `/`-keyed object whose value is a plain nested object", () => {
        const obj = { "/x": { a: 1 } } as unknown as FabricValue;
        const result = roundTrip(obj) as Record<
          string,
          Record<string, FabricValue>
        >;
        expect(result["/x"]!["a"]).toBe(1);
      });
    });

    describe("/object: any value requires encoding", () => {
      it("emits `/quote` for doubly-nested `/`-prefixed literal object (whole subtree is literal)", () => {
        const obj = { "/x": { "/y": 123 } } as unknown as FabricValue;
        const wire = toWireFormat(obj);
        // Whole subtree is deep-literal → single /quote wrap of original structure.
        expect(wire).toEqual({
          "/quote": { "/x": { "/y": 123 } },
        });
        const result = roundTrip(obj) as Record<
          string,
          Record<string, FabricValue>
        >;
        expect(result["/x"]!["/y"]).toBe(123);
      });

      it("boundary contrast: literal subtree uses `/quote`, Fabric type uses `/object`", () => {
        // All-literal: single /quote wraps the whole structure.
        const literal = { "/x": { "/y": 123 } } as unknown as FabricValue;
        expect(toWireFormat(literal)).toEqual({
          "/quote": { "/x": { "/y": 123 } },
        });

        // Fabric type as value: /object with the epoch encoded as its tagged form.
        const withEpoch = {
          "/x": new FabricEpochDays(42n),
        } as unknown as FabricValue;
        expect(toWireFormat(withEpoch)).toEqual({
          "/object": { "/x": { "/EpochDays@1": expect.anything() } },
        });
      });

      it("emits `/object` for `/`-keyed object with `FabricError` value", () => {
        const err = FabricError.fromNativeError(new TypeError("eep!"));
        const obj = { "/x": err } as unknown as FabricValue;
        const wire = toWireFormat(obj);
        expect(Object.keys(wire as object)).toEqual(["/object"]);
      });

      it("round-trips `FabricError` as value inside `/`-prefixed key object", () => {
        const err = FabricError.fromNativeError(new TypeError("eep!"));
        const obj = { "/x": err } as unknown as FabricValue;
        const result = roundTrip(obj) as Record<string, FabricValue>;
        expect(result["/x"]).toBeInstanceOf(FabricError);
        expect((result["/x"] as unknown as FabricError).message).toBe(
          "eep!",
        );
      });

      it("round-trips `FabricEpochDays` as value inside `/`-prefixed key object", () => {
        const day = new FabricEpochDays(42n);
        const obj = { "/x": day } as unknown as FabricValue;
        const result = roundTrip(obj) as Record<string, FabricValue>;
        expect(result["/x"]).toBeInstanceOf(FabricEpochDays);
        expect((result["/x"] as unknown as FabricEpochDays).value).toBe(42n);
      });

      it("emits `/object` for mixed: literal and encoded values", () => {
        const obj = {
          "/a": "literal",
          "/b": FabricError.fromNativeError(new Error("oops")),
        } as unknown as FabricValue;
        const wire = toWireFormat(obj);
        expect(Object.keys(wire as object)).toEqual(["/object"]);
      });

      it("round-trips mixed literal+encoded `/`-keyed object", () => {
        const obj = {
          "/a": "literal",
          "/b": FabricError.fromNativeError(new Error("oops")),
        } as unknown as FabricValue;
        const result = roundTrip(obj) as Record<string, FabricValue>;
        expect(result["/a"]).toBe("literal");
        expect(result["/b"]).toBeInstanceOf(FabricError);
      });
    });

    describe("general", () => {
      it("malformed wire: multi-key object with `/`-prefixed key produces `ProblematicValue`", () => {
        // Wire data without /quote or /object wrapper — decoder must not silently
        // round-trip it as a plain object.
        const data = { a: 1, "/b": 2 } as JsonWireValue;
        const result = fromWireFormat(data);
        expect(result).toBeInstanceOf(ProblematicValue);
      });

      it("malformed wire: bare `/`-keyed object produces `ProblematicValue`", () => {
        // Per spec §9, a single-key object whose key is bare "/" (empty tag
        // after stripping the leading slash) is an encoding error. Decoding must
        // produce a ProblematicValue, not an UnknownValue with an empty tag.
        const data = { "/": "x" } as JsonWireValue;
        const result = fromWireFormat(data);
        expect(result).toBeInstanceOf(ProblematicValue);
      });

      it("does not wrap plain object with no `/`-prefixed keys", () => {
        const obj = { a: 1, b: 2 } as unknown as FabricValue;
        expect(toWireFormat(obj)).toEqual({ a: 1, b: 2 });
      });

      it("deserializes an `/object`-wrapped multi-key object with `/`-prefixed key correctly", () => {
        const data = { "/object": { a: 1, "/b": 2 } } as JsonWireValue;
        const result = fromWireFormat(data) as Record<string, FabricValue>;
        expect(result["a"]).toBe(1);
        expect(result["/b"]).toBe(2);
      });

      it("round-trips nested object containing `/`-prefixed key", () => {
        const obj = { outer: { "/inner": 1 } } as unknown as FabricValue;
        const result = roundTrip(obj) as Record<
          string,
          Record<string, FabricValue>
        >;
        expect(result["outer"]!["/inner"]).toBe(1);
      });

      it("single-key `/`-prefixed object still routes through `unwrapTag()` (no regression)", () => {
        // Single-key /Tag@N objects are handled by unwrapTag, not the plain-object
        // path — confirm they still produce UnknownValue (unrecognized tag), not
        // ProblematicValue from the new multi-key guard.
        const data = { "/Future@7": { id: "x" } } as JsonWireValue;
        const result = fromWireFormat(data);
        expect(result).toBeInstanceOf(UnknownValue);
        expect((result as unknown as UnknownValue).wireTypeTag).toBe(
          "Future@7",
        );
      });

      it("decoder strips exactly one `/quote` layer — inner `/quote` is preserved literally", () => {
        // Wire form { "/quote": { "/quote": "x" } } is a /quote-wrapped literal
        // whose content happens to be { "/quote": "x" }. Decoding must return
        // { "/quote": "x" } as a frozen plain object — NOT recurse into it and
        // return just "x".
        const wire = { "/quote": { "/quote": "x" } } as JsonWireValue;
        const result = fromWireFormat(wire) as Record<string, FabricValue>;
        expect(result["/quote"]).toBe("x");
      });

      it("round-trips object whose value is a `/quote`-keyed literal", () => {
        // { "/x": { "/quote": "inner" } } — the value at "/x" is user data that
        // happens to have a /quote key. Must survive encode→decode intact.
        const obj = { "/x": { "/quote": "inner" } } as unknown as FabricValue;
        const result = roundTrip(obj) as Record<
          string,
          Record<string, FabricValue>
        >;
        expect(result["/x"]!["/quote"]).toBe("inner");
      });
    });
  });

  describe("/quote handling", () => {
    it("deserializes `/quote` as literal (no inner deserialization)", () => {
      const data = {
        "/quote": { "/Link@1": { id: "abc" } },
      } as JsonWireValue;
      const result = fromWireFormat(data);
      // The inner structure is returned as-is, not reconstructed.
      const obj = result as Record<string, unknown>;
      expect(obj["/Link@1"]).toEqual({ id: "abc" });
    });

    it("deep-freezes `/quote` result objects", () => {
      const data = {
        "/quote": { "/Link@1": { id: "abc" } },
      } as JsonWireValue;
      const result = fromWireFormat(data) as Record<string, unknown>;
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result["/Link@1"])).toBe(true);
    });

    it("deep-freezes `/quote` result arrays", () => {
      const data = {
        "/quote": [1, { nested: "obj" }, [2, 3]],
      } as JsonWireValue;
      const result = fromWireFormat(data) as unknown[];
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result[1])).toBe(true);
      expect(Object.isFrozen(result[2])).toBe(true);
    });

    it("throws on mutation of a `/quote` result", () => {
      const data = {
        "/quote": { key: "val" },
      } as JsonWireValue;
      const result = fromWireFormat(data) as Record<string, unknown>;
      expect(() => {
        result.key = "changed";
      }).toThrow();
    });
  });

  describe("unknown type tags", () => {
    it("produces `UnknownValue` for unrecognized tags via `decode()`", () => {
      const data = {
        "/FutureType@2": { some: "data" },
      } as JsonWireValue;
      const result = fromWireFormat(data);
      expect(result).toBeInstanceOf(UnknownValue);
      const unknown = result as unknown as UnknownValue;
      expect(unknown.wireTypeTag).toBe("FutureType@2");
      expect(unknown.state).toEqual({ some: "data" });
    });

    it("preserves the `UnknownValue` tag in wire format via `encode()`", () => {
      // Encoding an UnknownValue produces the original tagged form.
      const us = new UnknownValue("FutureType@2", { some: "data" });
      const wireFormat = toWireFormat(us as FabricValue);
      expect(wireFormat).toEqual({
        "/FutureType@2": { some: "data" },
      });
    });

    it("round-trips `UnknownValue` through encode/decode", () => {
      const us = new UnknownValue("FutureType@2", { some: "data" });
      const result = roundTrip(us as FabricValue);
      expect(result).toBeInstanceOf(UnknownValue);
      const unknown = result as unknown as UnknownValue;
      expect(unknown.wireTypeTag).toBe("FutureType@2");
      expect(unknown.state).toEqual({ some: "data" });
    });

    it("converts a `/hole` outside array context to `UnknownValue`", () => {
      const data = { "/hole": 5 } as JsonWireValue;
      const result = fromWireFormat(data);
      expect(result).toBeInstanceOf(UnknownValue);
      const unknown = result as unknown as UnknownValue;
      expect(unknown.wireTypeTag).toBe("hole");
      expect(unknown.state).toBe(5);
    });
  });

  describe("circular reference detection", () => {
    it("throws on object referencing itself", () => {
      const { context } = makeTestContext();
      const obj: Record<string, unknown> = {};
      obj.self = obj;
      expect(() => context.encode(obj as FabricValue)).toThrow(
        "Circular reference",
      );
    });

    it("throws on array referencing itself", () => {
      const { context } = makeTestContext();
      const arr: unknown[] = [];
      arr.push(arr);
      expect(() => context.encode(arr as FabricValue)).toThrow(
        "Circular reference",
      );
    });

    it("throws on indirect circular reference (A -> B -> A)", () => {
      const { context } = makeTestContext();
      const a: Record<string, unknown> = {};
      const b: Record<string, unknown> = {};
      a.ref = b;
      b.ref = a;
      expect(() => context.encode(a as FabricValue)).toThrow(
        "Circular reference",
      );
    });

    it("throws on `FabricInstance` whose state references itself", () => {
      const { context } = makeTestContext();
      // Create an instance with a circular reference in its state.
      const state = { eek: [] as unknown[] };
      state.eek.push(state);

      const us = new UnknownValue("Test@1", state);
      expect(() => context.encode(us as FabricValue))
        .toThrow(
          "Circular reference",
        );
    });

    it("allows shared references (same object at multiple positions)", () => {
      const shared = { val: 42 } as unknown as FabricValue;
      const obj = { a: shared, b: shared } as unknown as FabricValue;
      // Should not throw -- shared references are fine, only cycles are rejected.
      const result = toWireFormat(obj);
      expect(result).toEqual({ a: { val: 42 }, b: { val: 42 } });
    });
  });

  describe("`ProblematicValue` (lenient mode)", () => {
    it("preserves `ProblematicValue`'s original tag and state via `encode()`", () => {
      const prob = new ProblematicValue(
        "BadType@1",
        "original data",
        "something went wrong",
      );
      const wireFormat = toWireFormat(prob as FabricValue);
      expect(wireFormat).toEqual({ "/BadType@1": "original data" });
    });

    it("lenient mode wraps failed handler reconstruction", () => {
      const context = new JsonEncodingContext({ lenient: true });
      const runtime = new TestReconstructionContext();

      // BigInt@1 with a non-string state produces ProblematicValue
      // in lenient mode because the handler validates the state type.
      const data = { "/BigInt@1": 42 } as JsonWireValue;
      const result = context.decode(
        JsonEncodingContext.wrapEncodedValueForTesting(JSON.stringify(data)),
        runtime,
      );
      expect(result).toBeInstanceOf(ProblematicValue);
      const prob = result as unknown as ProblematicValue;
      expect(prob.wireTypeTag).toBe("BigInt@1");
    });

    it("lenient mode wraps failed class-registry reconstruction", () => {
      const context = new JsonEncodingContext({ lenient: true });
      const runtime = new TestReconstructionContext();

      // Map@1's codec always throws on decode ("not yet implemented"),
      // triggering lenient wrapping.
      const data = {
        "/Map@1": [["key", "value"]],
      } as JsonWireValue;
      const result = context.decode(
        JsonEncodingContext.wrapEncodedValueForTesting(
          JSON.stringify(data),
          true, // Undecodable on purpose; that is what this test is about.
        ),
        runtime,
      );
      expect(result).toBeInstanceOf(ProblematicValue);
      const prob = result as unknown as ProblematicValue;
      expect(prob.wireTypeTag).toBe("Map@1");
    });
  });

  describe("freeze guarantees", () => {
    it("deserialized arrays are frozen", () => {
      const result = fromWireFormat(
        [1, 2, 3] as JsonWireValue,
      ) as FabricValue[];
      expect(Object.isFrozen(result)).toBe(true);
    });

    it("deserialized objects are frozen", () => {
      const result = fromWireFormat(
        { a: 1 } as JsonWireValue,
      ) as Record<string, FabricValue>;
      expect(Object.isFrozen(result)).toBe(true);
    });

    it("mutation of deserialized array throws", () => {
      const result = fromWireFormat(
        [1, 2, 3] as JsonWireValue,
      ) as FabricValue[];
      expect(() => {
        (result as unknown as number[])[0] = 99;
      }).toThrow();
    });

    it("mutation of deserialized object throws", () => {
      const result = fromWireFormat(
        { a: 1 } as JsonWireValue,
      ) as Record<string, FabricValue>;
      expect(() => {
        (result as Record<string, unknown>).a = 99;
      }).toThrow();
    });

    it("nested deserialized objects are frozen", () => {
      const result = fromWireFormat(
        { inner: { val: 42 } } as JsonWireValue,
      ) as Record<string, Record<string, FabricValue>>;
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.inner)).toBe(true);
    });

    it("deserialized `/object`-unwrapped objects are frozen", () => {
      const data = { "/object": { "/myKey": "val" } } as JsonWireValue;
      const result = fromWireFormat(data) as Record<
        string,
        FabricValue
      >;
      expect(Object.isFrozen(result)).toBe(true);
    });
  });

  describe("`FabricCodec.decode()` deep-frozen contract", () => {
    // The contract is scoped to the codec dispatch arm: anything returned via
    // a registered `FabricCodec` is guaranteed deep-frozen at the `decode()`
    // boundary, so callers do not each have to freeze. The unknown-tag
    // fallback (`UnknownValue`) is a separate arm and is intentionally NOT
    // covered by this contract.

    it("codec-produced value is deep-frozen at the boundary", () => {
      // `/EpochNsec@1` dispatches through a registered codec; the
      // reconstructed FabricEpochNsec must be deep-frozen on return.
      const result = fromWireFormat(
        { "/EpochNsec@1": "AA" } as JsonWireValue,
      );
      expect(result).toBeInstanceOf(FabricEpochNsec);
      expect(isDeepFrozen(result)).toBe(true);
    });

    it("lenient-mode `ProblematicValue` from a codec is deep-frozen", () => {
      // `/BigInt@1` with non-string state fails codec validation; the
      // lenient catch produces a ProblematicValue -- still a codec-arm return,
      // so the contract deep-freezes it (not a crash: it is the value
      // lenient mode produces precisely to avoid crashing).
      const ctx = new JsonEncodingContext({ lenient: true });
      const runtime = new TestReconstructionContext();
      const result = ctx.decode(
        JsonEncodingContext.wrapEncodedValueForTesting(
          JSON.stringify({ "/BigInt@1": 42 }),
        ),
        runtime,
      );
      expect(result).toBeInstanceOf(ProblematicValue);
      expect(isDeepFrozen(result)).toBe(true);
    });

    it("codec round-trip yields a deep-frozen result", () => {
      const result = roundTrip(
        new FabricEpochNsec(1704067200000000000n) as FabricValue,
      );
      expect(result).toBeInstanceOf(FabricEpochNsec);
      expect(isDeepFrozen(result)).toBe(true);
    });
  });

  describe("deep-frozen wire invariant (`decode()`/`decodeFromBytes()` symmetry)", () => {
    // Every `JsonWireValue` handed to `deserialize()` must be deep-frozen, so
    // both `deserialize()` entry points must produce equally deep-frozen
    // results: `decode()` (string path) and `decodeFromBytes()` (bytes path
    // via `fromBytes()`).
    //
    // Regression guard: the `/quote` arm does `return state`, handing back a
    // node lifted straight out of the parsed wire tree (see `unwrapTag`'s
    // contract). That shortcut is only sound because the parsed tree is
    // deep-frozen at construction. `fromBytes()` has always done this;
    // `decode()` once did NOT (it parsed inline without `deepFreeze()`), so a
    // tweak that removed the `/quote` arm's own `deepFreeze()` made
    // string-path `/quote` results come back mutable. These tests pin the
    // symmetry so neither construction site can silently drop the guarantee.

    /**
     * Decodes the same wire tree both ways. The string path needs the
     * encoding prefix; the bytes path does not (it does not strip one).
     */
    function decodeBothPaths(
      data: JsonWireValue,
    ): { viaString: FabricValue; viaBytes: FabricValue } {
      const { context, runtime } = makeTestContext();
      const json = JSON.stringify(data);
      const viaString = context.decode(
        JsonEncodingContext.wrapEncodedValueForTesting(json),
        runtime,
      );
      const viaBytes = context.decodeFromBytes(
        new TextEncoder().encode(json),
        runtime,
      );
      return { viaString, viaBytes };
    }

    const cases: Array<[string, JsonWireValue]> = [
      ["plain nested object + array", { a: { b: [1, 2, { c: 3 }] } }],
      ["/quote literal with nested object and array", {
        "/quote": { x: [1, { y: 2 }], z: { w: [3, 4] } },
      }],
      ["/quote literal whose top value is an array", {
        "/quote": [[1, 2], { a: 1 }, [{ b: 2 }]],
      }],
      ["/object-wrapped object with a /-prefixed key", {
        "/object": { "/k": { nested: [1, 2] } },
      }],
      ["tagged handler value (EpochNsec, arm-1 contract)", {
        "/EpochNsec@1": "AA",
      }],
      ["mixed: a /quote value beside a normal array", {
        meta: [1, 2],
        lit: { "/quote": { deep: { deeper: [9] } } },
      }],
    ];

    for (const [name, wire] of cases) {
      it(`both paths yield a deep-frozen, equal result: ${name}`, () => {
        const { viaString, viaBytes } = decodeBothPaths(wire);
        expect(isDeepFrozen(viaString)).toBe(true);
        expect(isDeepFrozen(viaBytes)).toBe(true);
        expect(viaString).toEqual(viaBytes);
      });
    }

    it("string path deep-freezes `/quote` content at every depth (regression for `decode()` vs `fromBytes()`)", () => {
      const wire = {
        "/quote": { outer: { inner: [1, 2] } },
      } as JsonWireValue;
      const { context, runtime } = makeTestContext();
      const result = context.decode(
        JsonEncodingContext.wrapEncodedValueForTesting(JSON.stringify(wire)),
        runtime,
      ) as Record<string, Record<string, FabricValue[]>>;

      expect(isDeepFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.outer)).toBe(true);
      expect(Object.isFrozen(result.outer!.inner)).toBe(true);
      expect(() => {
        (result.outer!.inner as unknown as number[])[0] = 99;
      }).toThrow();
      expect(() => {
        (result.outer as Record<string, unknown>).added = true;
      }).toThrow();
    });

    it("bytes path deep-freezes `/quote` content at every depth", () => {
      const wire = {
        "/quote": { outer: { inner: [{ deep: 1 }] } },
      } as JsonWireValue;
      const { context, runtime } = makeTestContext();
      const result = context.decodeFromBytes(
        new TextEncoder().encode(JSON.stringify(wire)),
        runtime,
      ) as Record<string, Record<string, Array<Record<string, FabricValue>>>>;

      expect(isDeepFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.outer!.inner![0])).toBe(true);
      expect(() => {
        (result.outer!.inner![0] as Record<string, unknown>).deep = 2;
      }).toThrow();
    });

    it("`serialize()`→`/quote`→`decode()` round-trip is deep-frozen end-to-end", () => {
      // An object whose keys are all /-prefixed but whose values are all
      // quote-safe routes through the serialize-side /quote path, then back
      // through the deserialize /quote `return state` arm.
      const value = {
        "/a": 1,
        "/b": { plain: [1, 2] },
      } as unknown as FabricValue;
      const result = roundTrip(value);
      expect(isDeepFrozen(result)).toBe(true);
      expect(result).toEqual({ "/a": 1, "/b": { plain: [1, 2] } });
    });
  });

  describe("JsonEncodingContext", () => {
    it("`encode()` returns a prefixed JSON string", () => {
      const ctx = new JsonEncodingContext();
      const result = ctx.encode(42);
      expect(typeof result).toBe("string");
      expect(JsonEncodingContext.seemsLikeEncoded(result)).toBe(true);
      expect(
        JSON.parse(JsonEncodingContext.unwrapEncodedValueForTesting(result)),
      ).toBe(42);
    });

    it("`decode()` parses a prefixed JSON string back to a value", () => {
      const ctx = new JsonEncodingContext();
      const runtime = new TestReconstructionContext();
      const result = ctx.decode(
        JsonEncodingContext.wrapEncodedValueForTesting("42"),
        runtime,
      );
      expect(result).toBe(42);
    });

    it("`encode()`/`decode()` round-trip for tagged types", () => {
      const ctx = new JsonEncodingContext();
      const runtime = new TestReconstructionContext();
      const se = FabricError.fromNativeError(new Error("test"));
      const encoded = ctx.encode(se as FabricValue);
      const decoded = ctx.decode(encoded, runtime);
      expect(decoded).toBeInstanceOf(FabricError);
      expect((decoded as unknown as FabricError).message).toBe("test");
    });

    it("`encodeToBytes()`/`decodeFromBytes()` round-trip", () => {
      const ctx = new JsonEncodingContext();
      const runtime = new TestReconstructionContext();
      const data = {
        name: "test",
        error: FabricError.fromNativeError(new Error("fail")),
      } as unknown as FabricValue;
      const bytes = ctx.encodeToBytes(data);
      expect(bytes).toBeInstanceOf(Uint8Array);
      const decoded = ctx.decodeFromBytes(bytes, runtime) as Record<
        string,
        FabricValue
      >;
      expect(decoded.name).toBe("test");
      expect(decoded.error).toBeInstanceOf(FabricError);
    });

    it("`.lenient` defaults to `false`", () => {
      const ctx = new JsonEncodingContext();
      expect(ctx.lenient).toBe(false);
    });

    it("`.lenient` can be set to `true`", () => {
      const ctx = new JsonEncodingContext({ lenient: true });
      expect(ctx.lenient).toBe(true);
    });
  });

  describe("complex round-trips", () => {
    it("round-trips deeply nested structure", () => {
      const value = {
        users: [
          { name: "Alice", scores: [100, undefined, 95] },
          { name: "Bob", scores: [] },
        ],
        meta: { version: 1, debug: undefined },
      } as unknown as FabricValue;

      const result = roundTrip(value) as Record<string, FabricValue>;
      const users = result.users as FabricValue[];
      const alice = users[0] as Record<string, FabricValue>;
      expect(alice.name).toBe("Alice");
      const scores = alice.scores as FabricValue[];
      expect(scores[0]).toBe(100);
      expect(scores[1]).toBe(undefined);
      expect(1 in scores).toBe(true);
      expect(scores[2]).toBe(95);

      const meta = result.meta as Record<string, FabricValue>;
      expect(meta.version).toBe(1);
      expect(meta.debug).toBe(undefined);
      expect("debug" in meta).toBe(true);
    });

    it("round-trips `FabricError` in array", () => {
      const se = FabricError.fromNativeError(new Error("oops"));
      const arr = [1, se, 3] as unknown as FabricValue;
      const result = roundTrip(arr) as FabricValue[];
      expect(result[0]).toBe(1);
      expect(result[1]).toBeInstanceOf(FabricError);
      expect(
        (result[1] as unknown as FabricError).message,
      ).toBe("oops");
      expect(result[2]).toBe(3);
    });

    it("round-trips `FabricError` as object value", () => {
      const obj = {
        error: FabricError.fromNativeError(new Error("fail")),
        code: 500,
      } as unknown as FabricValue;
      const result = roundTrip(obj) as Record<string, FabricValue>;
      expect(result.error).toBeInstanceOf(FabricError);
      expect(
        (result.error as unknown as FabricError).message,
      ).toBe("fail");
      expect(result.code).toBe(500);
    });

    it("wire format is unchanged (backward compatible)", () => {
      // FabricError should produce the same wire format as the old ErrorHandler.
      const se = FabricError.fromNativeError(new TypeError("compat test"));
      const serialized = toWireFormat(
        se as FabricValue,
      ) as Record<string, unknown>;
      expect(Object.keys(serialized)).toEqual(["/Error@1"]);
      const state = serialized["/Error@1"] as Record<string, unknown>;
      expect(state.type).toBe("TypeError");
      expect(state.name).toBe(null); // null = same as type (common case)
      expect(state.message).toBe("compat test");
    });
  });

  describe("test-only prefix helpers", () => {
    describe("`unwrapEncodedValueForTesting()`", () => {
      it("yields the JSON text under the tag", () => {
        const encoded = new JsonEncodingContext().encode(42);
        expect(JsonEncodingContext.unwrapEncodedValueForTesting(encoded))
          .toBe("42");
      });

      it("round-trips with `wrapEncodedValueForTesting()`", () => {
        const encoded = new JsonEncodingContext().encode(
          { b: 1, a: [true, null] } as unknown as FabricValue,
        );
        const json = JsonEncodingContext.unwrapEncodedValueForTesting(encoded);
        expect(JsonEncodingContext.wrapEncodedValueForTesting(json))
          .toBe(encoded);
      });

      it("preserves a value plain JSON could not carry", () => {
        // The case that motivates having a golden format at all: these survive
        // the trip only as tagged forms.
        const encoded = new JsonEncodingContext().encode(
          { z: -0, n: NaN, i: -Infinity } as unknown as FabricValue,
        );
        const rebuilt = new JsonEncodingContext().decode(
          JsonEncodingContext.wrapEncodedValueForTesting(
            JsonEncodingContext.unwrapEncodedValueForTesting(encoded),
          ),
          new TestReconstructionContext(),
        ) as Record<string, number>;
        expect(Object.is(rebuilt.z, -0)).toBe(true);
        expect(Number.isNaN(rebuilt.n)).toBe(true);
        expect(rebuilt.i).toBe(-Infinity);
      });

      it("rejects a string carrying no tag", () => {
        // The whole point of the tag: untagged JSON is not one of ours, however
        // well-formed it happens to be.
        expect(() => JsonEncodingContext.unwrapEncodedValueForTesting("42"))
          .toThrow();
      });

      it("rejects an empty string", () => {
        expect(() => JsonEncodingContext.unwrapEncodedValueForTesting(""))
          .toThrow();
      });

      it("rejects a tag with nothing after it", () => {
        // `seemsLikeEncoded()` accepts this, so only the throwaway decode
        // catches it.
        expect(() =>
          JsonEncodingContext.unwrapEncodedValueForTesting(ENCODING_PREFIX)
        )
          .toThrow();
      });

      it("rejects a tag followed by text that will not parse", () => {
        expect(() =>
          JsonEncodingContext.unwrapEncodedValueForTesting(
            `${ENCODING_PREFIX}{nope`,
          )
        ).toThrow();
      });
    });

    describe("`wrapEncodedValueForTesting()`", () => {
      it("produces something the codec accepts", () => {
        const { runtime } = makeTestContext();
        const encoded = JsonEncodingContext.wrapEncodedValueForTesting(
          JSON.stringify({ a: 1 }),
        );
        expect(JsonEncodingContext.seemsLikeEncoded(encoded)).toBe(true);
        expect(new JsonEncodingContext().decode(encoded, runtime))
          .toEqual({ a: 1 });
      });

      it("returns the body unaltered beneath the tag", () => {
        const body = JSON.stringify({ b: 2, a: 1 });
        expect(JsonEncodingContext.wrapEncodedValueForTesting(body))
          .toBe(`${ENCODING_PREFIX}${body}`);
      });

      it("accepts a pretty-printed body", () => {
        // The re-encoded form is not compared against the input, so whitespace
        // is immaterial -- which is what lets a golden file be readable.
        const pretty = JSON.stringify({ a: 1, b: [2, 3] }, null, 2);
        const encoded = JsonEncodingContext.wrapEncodedValueForTesting(pretty);
        const { runtime } = makeTestContext();
        expect(new JsonEncodingContext().decode(encoded, runtime))
          .toEqual({ a: 1, b: [2, 3] });
      });

      it("rejects text that will not parse", () => {
        expect(() => JsonEncodingContext.wrapEncodedValueForTesting("{nope"))
          .toThrow();
      });

      it("rejects an empty body", () => {
        expect(() => JsonEncodingContext.wrapEncodedValueForTesting(""))
          .toThrow();
      });

      it("rejects an already-tagged string", () => {
        // Double-tagging is a mistake worth catching: the tag is not part of
        // the JSON, so the result would not parse.
        const encoded = new JsonEncodingContext().encode(42);
        expect(() => JsonEncodingContext.wrapEncodedValueForTesting(encoded))
          .toThrow();
      });
    });

    describe("`isMalformed`", () => {
      // `Map@1`'s codec always throws on decode, so it stands in for any
      // payload the codec cannot reconstruct.
      const undecodable = JSON.stringify({ "/Map@1": [["key", "value"]] });

      it("refuses an undecodable payload by default", () => {
        expect(() =>
          JsonEncodingContext.wrapEncodedValueForTesting(undecodable)
        )
          .toThrow();
      });

      it("accepts an undecodable payload when told it is deliberate", () => {
        expect(
          JsonEncodingContext.wrapEncodedValueForTesting(undecodable, true),
        ).toBe(`${ENCODING_PREFIX}${undecodable}`);
      });

      it("unwraps an undecodable payload when told it is deliberate", () => {
        expect(
          JsonEncodingContext.unwrapEncodedValueForTesting(
            `${ENCODING_PREFIX}${undecodable}`,
            true,
          ),
        ).toBe(undecodable);
      });

      it("still refuses text that will not parse, however deliberate", () => {
        // The flag excuses a payload the codec cannot rebuild -- not one it
        // cannot even read. Otherwise it would be an escape hatch out of every
        // check.
        expect(() =>
          JsonEncodingContext.wrapEncodedValueForTesting("{nope", true)
        ).toThrow();
        expect(() =>
          JsonEncodingContext.unwrapEncodedValueForTesting(
            `${ENCODING_PREFIX}{nope`,
            true,
          )
        ).toThrow();
      });

      it("still requires the tag on unwrap, however deliberate", () => {
        expect(() =>
          JsonEncodingContext.unwrapEncodedValueForTesting("42", true)
        )
          .toThrow();
      });
    });
  });
});
