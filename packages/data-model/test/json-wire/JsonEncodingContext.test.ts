import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { JsonEncodingContext } from "../../src/json-wire/JsonEncodingContext.ts";
import type { FabricValue } from "../../src/interface.ts";
import type { JsonWireValue } from "../../src/json-wire/interface.ts";
import { UnknownValue } from "../../src/fabric-instances/UnknownValue.ts";
import { ProblematicValue } from "../../src/fabric-instances/ProblematicValue.ts";
import { FabricEpochDays } from "../../src/fabric-primitives/FabricEpochDays.ts";
import { FabricEpochNsec } from "../../src/fabric-primitives/FabricEpochNsec.ts";
import { FabricError } from "../../src/fabric-instances/FabricError.ts";
import { isDeepFrozen } from "../../src/deep-freeze.ts";
import { BaseReconstructionContext } from "../../src/BaseReconstructionContext.ts";
import { shallowFabricFromNativeValue } from "../../src/fabric-value.ts";

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
 * The encoding prefix tag emitted by `JsonEncodingContext.encode()`. Defined
 * here (rather than imported) so the production module can keep the tag
 * private; these helpers strip/add it to bridge between encoded strings and
 * the underlying wire-format tree.
 */
const ENCODING_PREFIX = "fvj1:";

/**
 * Helper: encode a value and return the wire-format tree (parsed JSON).
 * Used for assertions about the intermediate wire representation.
 */
function toWireFormat(value: FabricValue): JsonWireValue {
  const { context } = makeTestContext();
  const encoded = context.encode(value);
  return JSON.parse(encoded.slice(ENCODING_PREFIX.length)) as JsonWireValue;
}

/**
 * Helper: decode from a wire-format tree. Stringifies to JSON first (with the
 * encoding prefix prepended), then feeds through the public decode API.
 */
function fromWireFormat(data: JsonWireValue): FabricValue {
  const { context, runtime } = makeTestContext();
  return context.decode(ENCODING_PREFIX + JSON.stringify(data), runtime);
}

describe("JsonEncodingContext", () => {
  describe("`Uint8Array` public API", () => {
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

  describe("undefined", () => {
    it('serializes to `{ "/Undefined@1": null }`', () => {
      const result = toWireFormat(undefined);
      expect(result).toEqual({ "/Undefined@1": null });
    });

    it("round-trips at top level", () => {
      expect(roundTrip(undefined)).toBe(undefined);
    });

    it("round-trips in arrays", () => {
      const arr = [1, undefined, 3] as FabricValue;
      const result = roundTrip(arr) as FabricValue[];
      expect(result[0]).toBe(1);
      expect(result[1]).toBe(undefined);
      expect(1 in result).toBe(true); // not a hole
      expect(result[2]).toBe(3);
    });

    it("round-trips as object values", () => {
      const obj = { a: 1, b: undefined } as unknown as FabricValue;
      const result = roundTrip(obj) as Record<string, FabricValue>;
      expect(result.a).toBe(1);
      expect(result.b).toBe(undefined);
      expect("b" in result).toBe(true); // key preserved
    });

    it("is distinct from `null`", () => {
      const serializedNull = toWireFormat(null);
      const serializedUndef = toWireFormat(undefined);
      expect(serializedNull).not.toEqual(serializedUndef);
    });
  });

  describe("bigint", () => {
    it("serializes `42n` to base64 of two's complement bytes", () => {
      const result = toWireFormat(42n as FabricValue);
      // 42n -> [0x2a] -> base64 "Kg"
      expect(result).toEqual({ "/BigInt@1": "Kg" });
    });

    it('serializes `0n` to base64 `"AA"`', () => {
      const result = toWireFormat(0n as FabricValue);
      // 0n -> [0x00] -> base64 "AA"
      expect(result).toEqual({ "/BigInt@1": "AA" });
    });

    it('serializes `-1n` to base64url `"_w"`', () => {
      const result = toWireFormat(-1n as FabricValue);
      // -1n -> [0xFF] -> base64url "_w"
      expect(result).toEqual({ "/BigInt@1": "_w" });
    });

    it('serializes `1n` to base64 `"AQ"`', () => {
      const result = toWireFormat(1n as FabricValue);
      // 1n -> [0x01] -> base64 "AQ"
      expect(result).toEqual({ "/BigInt@1": "AQ" });
    });

    it("serializes `128n` with sign-extension byte", () => {
      const result = toWireFormat(128n as FabricValue);
      // 128n -> [0x00, 0x80] -> base64 "AIA"
      expect(result).toEqual({ "/BigInt@1": "AIA" });
    });

    it("produces unpadded base64 output (no trailing `=`)", () => {
      // 42n produces 1 byte -> 2 base64 chars (would be "Kg==" with padding)
      const result = toWireFormat(42n as FabricValue) as Record<
        string,
        string
      >;
      const b64 = result["/BigInt@1"];
      expect(b64).toBe("Kg");
      expect(b64).not.toContain("=");
    });

    it("round-trips at top level", () => {
      const result = roundTrip(42n as FabricValue);
      expect(result).toBe(42n);
    });

    it("round-trips negative bigint", () => {
      const result = roundTrip(-999n as FabricValue);
      expect(result).toBe(-999n);
    });

    it("round-trips zero bigint", () => {
      const result = roundTrip(0n as FabricValue);
      expect(result).toBe(0n);
    });

    it("round-trips `1n`", () => {
      const result = roundTrip(1n as FabricValue);
      expect(result).toBe(1n);
    });

    it("round-trips `-1n`", () => {
      const result = roundTrip(-1n as FabricValue);
      expect(result).toBe(-1n);
    });

    it("round-trips large bigint", () => {
      const big = 2n ** 64n;
      const result = roundTrip(big as FabricValue);
      expect(result).toBe(big);
    });

    it("round-trips large negative bigint", () => {
      const big = -(2n ** 64n);
      const result = roundTrip(big as FabricValue);
      expect(result).toBe(big);
    });

    it("round-trips boundary value `127n`", () => {
      expect(roundTrip(127n as FabricValue)).toBe(127n);
    });

    it("round-trips boundary value `128n`", () => {
      expect(roundTrip(128n as FabricValue)).toBe(128n);
    });

    it("round-trips boundary value `-128n`", () => {
      expect(roundTrip(-128n as FabricValue)).toBe(-128n);
    });

    it("round-trips boundary value `-129n`", () => {
      expect(roundTrip(-129n as FabricValue)).toBe(-129n);
    });

    it("round-trips in arrays", () => {
      const arr = [1, 42n, "hello"] as unknown as FabricValue;
      const result = roundTrip(arr) as FabricValue[];
      expect(result[0]).toBe(1);
      expect(result[1]).toBe(42n);
      expect(result[2]).toBe("hello");
    });

    it("round-trips as object values", () => {
      const obj = { a: 1, b: 42n } as unknown as FabricValue;
      const result = roundTrip(obj) as Record<string, FabricValue>;
      expect(result.a).toBe(1);
      expect(result.b).toBe(42n);
    });

    it("is distinct from `number`", () => {
      const serializedNum = toWireFormat(42);
      const serializedBig = toWireFormat(42n as FabricValue);
      expect(serializedNum).not.toEqual(serializedBig);
    });

    it("accepts unpadded base64url input", () => {
      // "Kg" is the standard unpadded base64url encoding of 42n.
      const data = { "/BigInt@1": "Kg" } as JsonWireValue;
      const result = fromWireFormat(data);
      expect(result).toBe(42n);
    });

    it("accepts padded base64 input", () => {
      // "Kg==" is the padded form of "Kg" (42n) -- padding is accepted by the
      // web-standard Uint8Array.fromBase64.
      const data = { "/BigInt@1": "Kg==" } as JsonWireValue;
      const result = fromWireFormat(data);
      expect(result).toBe(42n);
    });

    it("deserializes non-string state to `ProblematicValue`", () => {
      const data = { "/BigInt@1": 42 } as JsonWireValue;
      const result = fromWireFormat(data);
      expect(result).toBeInstanceOf(ProblematicValue);
      const prob = result as unknown as ProblematicValue;
      expect(prob.typeTag).toBe("BigInt@1");
      expect(prob.state).toBe(42);
    });

    it("deserializes `null` state to `ProblematicValue`", () => {
      const data = { "/BigInt@1": null } as JsonWireValue;
      const result = fromWireFormat(data);
      expect(result).toBeInstanceOf(ProblematicValue);
    });

    it("deserializes object state to `ProblematicValue`", () => {
      const data = { "/BigInt@1": { bad: true } } as JsonWireValue;
      const result = fromWireFormat(data);
      expect(result).toBeInstanceOf(ProblematicValue);
    });

    it("deserializes empty base64 string to `ProblematicValue`", () => {
      const data = { "/BigInt@1": "" } as JsonWireValue;
      const result = fromWireFormat(data);
      expect(result).toBeInstanceOf(ProblematicValue);
      const prob = result as unknown as ProblematicValue;
      expect(prob.typeTag).toBe("BigInt@1");
    });
  });

  describe("SpecialNumber", () => {
    it('serializes `-0` to `/SpecialNumber@1` with state `"-0"`', () => {
      expect(toWireFormat(-0)).toEqual({ "/SpecialNumber@1": "-0" });
    });

    it('serializes `NaN` to `/SpecialNumber@1` with state `"NaN"`', () => {
      expect(toWireFormat(NaN)).toEqual({ "/SpecialNumber@1": "NaN" });
    });

    it('serializes `+Infinity` to `/SpecialNumber@1` with state `"+Infinity"`', () => {
      expect(toWireFormat(Infinity)).toEqual({
        "/SpecialNumber@1": "+Infinity",
      });
    });

    it('serializes `-Infinity` to `/SpecialNumber@1` with state `"-Infinity"`', () => {
      expect(toWireFormat(-Infinity)).toEqual({
        "/SpecialNumber@1": "-Infinity",
      });
    });

    it("does not intercept `+0` (round-trips as a plain number)", () => {
      expect(toWireFormat(0)).toBe(0);
      expect(roundTrip(0)).toBe(0);
    });

    it("round-trips `-0` (preserves sign of zero)", () => {
      const result = roundTrip(-0);
      expect(Object.is(result, -0)).toBe(true);
    });

    it("round-trips `NaN`", () => {
      expect(Number.isNaN(roundTrip(NaN))).toBe(true);
    });

    it("round-trips `+Infinity`", () => {
      expect(roundTrip(Infinity)).toBe(Infinity);
    });

    it("round-trips `-Infinity`", () => {
      expect(roundTrip(-Infinity)).toBe(-Infinity);
    });

    it('any `NaN` bit pattern serializes as the literal `"NaN"`', () => {
      const view = new DataView(new ArrayBuffer(8));
      view.setBigUint64(0, 0x7ff8000000000001n, false);
      const nonCanonicalNaN = view.getFloat64(0, false);
      expect(Number.isNaN(nonCanonicalNaN)).toBe(true);
      expect(toWireFormat(nonCanonicalNaN)).toEqual({
        "/SpecialNumber@1": "NaN",
      });
    });

    it("round-trips inside arrays", () => {
      const arr = [1, NaN, -0, Infinity, -Infinity, 2] as FabricValue;
      const result = roundTrip(arr) as number[];
      expect(result[0]).toBe(1);
      expect(Number.isNaN(result[1])).toBe(true);
      expect(Object.is(result[2], -0)).toBe(true);
      expect(result[3]).toBe(Infinity);
      expect(result[4]).toBe(-Infinity);
      expect(result[5]).toBe(2);
    });

    it("round-trips as object values", () => {
      const obj = {
        nz: -0,
        nan: NaN,
        pinf: Infinity,
        ninf: -Infinity,
      } as unknown as FabricValue;
      const result = roundTrip(obj) as Record<string, number>;
      expect(Object.is(result.nz, -0)).toBe(true);
      expect(Number.isNaN(result.nan)).toBe(true);
      expect(result.pinf).toBe(Infinity);
      expect(result.ninf).toBe(-Infinity);
    });

    it("non-string state -> `ProblematicValue` (lenient)", () => {
      const ctx = new JsonEncodingContext({ lenient: true });
      const runtime = new TestReconstructionContext();
      const encoded = ENCODING_PREFIX +
        JSON.stringify({ "/SpecialNumber@1": 0 });
      const result = ctx.decode(encoded, runtime);
      expect(result).toBeInstanceOf(ProblematicValue);
      expect((result as unknown as ProblematicValue).typeTag).toBe(
        "SpecialNumber@1",
      );
    });

    it("unknown literal -> `ProblematicValue` (lenient)", () => {
      const ctx = new JsonEncodingContext({ lenient: true });
      const runtime = new TestReconstructionContext();
      const encoded = ENCODING_PREFIX +
        JSON.stringify({ "/SpecialNumber@1": "Infinity" }); // missing leading +
      const result = ctx.decode(encoded, runtime);
      expect(result).toBeInstanceOf(ProblematicValue);
      expect((result as unknown as ProblematicValue).typeTag).toBe(
        "SpecialNumber@1",
      );
    });
  });

  describe("Symbol", () => {
    it('serializes `Symbol.for("foo")` to `/Symbol@1` with the key as state', () => {
      expect(toWireFormat(Symbol.for("foo") as FabricValue)).toEqual({
        "/Symbol@1": "foo",
      });
    });

    it('serializes `Symbol.for("")` (empty key)', () => {
      expect(toWireFormat(Symbol.for("") as FabricValue)).toEqual({
        "/Symbol@1": "",
      });
    });

    it("round-trips an interned symbol to the same registry instance", () => {
      const result = roundTrip(Symbol.for("hello") as FabricValue);
      expect(typeof result).toBe("symbol");
      expect(result).toBe(Symbol.for("hello"));
    });

    it("round-trips a key with non-ASCII characters", () => {
      const key = "café-☕-\u{1F600}";
      const result = roundTrip(Symbol.for(key) as FabricValue);
      expect(result).toBe(Symbol.for(key));
    });

    it("round-trips inside arrays", () => {
      const arr = [
        Symbol.for("a"),
        1,
        Symbol.for("b"),
      ] as unknown as FabricValue;
      const result = roundTrip(arr) as unknown[];
      expect(result[0]).toBe(Symbol.for("a"));
      expect(result[1]).toBe(1);
      expect(result[2]).toBe(Symbol.for("b"));
    });

    it("round-trips as object values", () => {
      const obj = {
        kind: Symbol.for("event"),
        flag: Symbol.for("ready"),
      } as unknown as FabricValue;
      const result = roundTrip(obj) as Record<string, unknown>;
      expect(result.kind).toBe(Symbol.for("event"));
      expect(result.flag).toBe(Symbol.for("ready"));
    });

    it("does not intercept `Symbol(desc)` (unique / uninterned)", () => {
      // canSerialize() returns false for unique symbols. The handler does not
      // claim them, which means they fall through to the registry's default
      // unhandled-value treatment rather than being silently coerced into a
      // registry symbol.
      const uniq = Symbol("nope") as FabricValue;
      const wire = toWireFormat(uniq);
      // The result should NOT be a Symbol@1 wrapping. (It will be an
      // UnknownValue or similar; the precise shape isn't what matters here --
      // what matters is that we didn't spuriously fabricate a registry key.)
      expect(typeof wire === "object" && wire !== null && "/Symbol@1" in wire)
        .toBe(false);
    });

    it("non-string state -> `ProblematicValue` (lenient)", () => {
      const ctx = new JsonEncodingContext({ lenient: true });
      const runtime = new TestReconstructionContext();
      const encodedJson = ENCODING_PREFIX +
        JSON.stringify({ "/Symbol@1": 42 });
      const result = ctx.decode(encodedJson, runtime);
      expect(result).toBeInstanceOf(ProblematicValue);
      expect((result as unknown as ProblematicValue).typeTag).toBe(
        "Symbol@1",
      );
    });
  });

  describe("FabricEpochNsec", () => {
    it("serializes to `/EpochNsec@1` with flat base64", () => {
      const sn = new FabricEpochNsec(0n);
      const result = toWireFormat(sn as FabricValue) as Record<
        string,
        unknown
      >;
      expect(Object.keys(result)).toEqual(["/EpochNsec@1"]);
      // Flat format: base64 string directly, not nested {"/BigInt@1": ...}
      expect(result["/EpochNsec@1"]).toBe("AA");
    });

    it("round-trips at top level (epoch zero)", () => {
      const sn = new FabricEpochNsec(0n);
      const result = roundTrip(
        sn as FabricValue,
      ) as unknown as FabricEpochNsec;
      expect(result).toBeInstanceOf(FabricEpochNsec);
      expect(result.value).toBe(0n);
    });

    it("round-trips positive nanosecond timestamp", () => {
      // 2024-01-01T00:00:00Z = 1704067200 seconds = 1704067200000000000 nsec
      const nsec = 1704067200000000000n;
      const sn = new FabricEpochNsec(nsec);
      const result = roundTrip(
        sn as FabricValue,
      ) as unknown as FabricEpochNsec;
      expect(result).toBeInstanceOf(FabricEpochNsec);
      expect(result.value).toBe(nsec);
    });

    it("round-trips negative nanosecond timestamp (pre-epoch)", () => {
      const nsec = -86400000000000n; // -1 day in nanoseconds
      const sn = new FabricEpochNsec(nsec);
      const result = roundTrip(
        sn as FabricValue,
      ) as unknown as FabricEpochNsec;
      expect(result).toBeInstanceOf(FabricEpochNsec);
      expect(result.value).toBe(nsec);
    });

    it("round-trips large future date", () => {
      // Year 3000-ish
      const nsec = 32503680000000000000n;
      const sn = new FabricEpochNsec(nsec);
      const result = roundTrip(
        sn as FabricValue,
      ) as unknown as FabricEpochNsec;
      expect(result.value).toBe(nsec);
    });

    it("round-trips in nested structure", () => {
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
  });

  describe("FabricEpochDays", () => {
    it("serializes to `/EpochDays@1` with flat base64", () => {
      const sd = new FabricEpochDays(0n);
      const result = toWireFormat(sd as FabricValue) as Record<
        string,
        unknown
      >;
      expect(Object.keys(result)).toEqual(["/EpochDays@1"]);
      // Flat format: base64 string directly, not nested {"/BigInt@1": ...}
      expect(result["/EpochDays@1"]).toBe("AA");
    });

    it("round-trips at top level (epoch zero)", () => {
      const sd = new FabricEpochDays(0n);
      const result = roundTrip(
        sd as FabricValue,
      ) as unknown as FabricEpochDays;
      expect(result).toBeInstanceOf(FabricEpochDays);
      expect(result.value).toBe(0n);
    });

    it("round-trips positive day count", () => {
      const days = 19723n; // ~2024-01-01
      const sd = new FabricEpochDays(days);
      const result = roundTrip(
        sd as FabricValue,
      ) as unknown as FabricEpochDays;
      expect(result).toBeInstanceOf(FabricEpochDays);
      expect(result.value).toBe(days);
    });

    it("round-trips negative day count (pre-epoch)", () => {
      const days = -365n;
      const sd = new FabricEpochDays(days);
      const result = roundTrip(
        sd as FabricValue,
      ) as unknown as FabricEpochDays;
      expect(result).toBeInstanceOf(FabricEpochDays);
      expect(result.value).toBe(days);
    });

    it("round-trips in nested structure", () => {
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
  });

  describe("`Date` -> `FabricEpochNsec` conversion", () => {
    it("converts `Date(0)` to `FabricEpochNsec(0n)`", () => {
      const date = new Date(0);
      const result = shallowFabricFromNativeValue(
        date,
      ) as unknown as FabricEpochNsec;
      expect(result).toBeInstanceOf(FabricEpochNsec);
      expect(result.value).toBe(0n);
    });

    it("converts `Date` to nanoseconds (`msec * 1_000_000`)", () => {
      const date = new Date("2024-01-01T00:00:00.000Z");
      const result = shallowFabricFromNativeValue(
        date,
      ) as unknown as FabricEpochNsec;
      expect(result).toBeInstanceOf(FabricEpochNsec);
      const expectedNsec = BigInt(date.getTime()) * 1_000_000n;
      expect(result.value).toBe(expectedNsec);
    });

    it("converts negative `Date` to negative nanoseconds", () => {
      const date = new Date(-86400000); // -1 day
      const result = shallowFabricFromNativeValue(
        date,
      ) as unknown as FabricEpochNsec;
      expect(result).toBeInstanceOf(FabricEpochNsec);
      expect(result.value).toBe(-86400000000000n);
    });
  });

  describe("FabricError", () => {
    it("serializes basic `FabricError` to `/Error@1`", () => {
      const se = FabricError.fromNativeError(new Error("test"));
      const result = toWireFormat(
        se as FabricValue,
      ) as Record<string, unknown>;
      expect(Object.keys(result)).toEqual(["/Error@1"]);
      const state = result["/Error@1"] as Record<string, unknown>;
      expect(state.type).toBe("Error");
      expect(state.name).toBe(null); // null = same as type (common case)
      expect(state.message).toBe("test");
    });

    it("round-trips basic `Error` via `FabricError`", () => {
      const se = FabricError.fromNativeError(new Error("hello"));
      const result = roundTrip(
        se as FabricValue,
      ) as unknown as FabricError;
      expect(result).toBeInstanceOf(FabricError);
      expect(result.toNativeValue(true)).toBeInstanceOf(Error);
      expect(result.name).toBe("Error");
      expect(result.message).toBe("hello");
    });

    it("round-trips `TypeError`", () => {
      const se = FabricError.fromNativeError(new TypeError("bad type"));
      const result = roundTrip(
        se as FabricValue,
      ) as unknown as FabricError;
      expect(result).toBeInstanceOf(FabricError);
      expect(result.toNativeValue(true)).toBeInstanceOf(TypeError);
      expect(result.name).toBe("TypeError");
      expect(result.message).toBe("bad type");
    });

    it("round-trips `RangeError`", () => {
      const se = FabricError.fromNativeError(new RangeError("out of range"));
      const result = roundTrip(
        se as FabricValue,
      ) as unknown as FabricError;
      expect(result).toBeInstanceOf(FabricError);
      expect(result.toNativeValue(true)).toBeInstanceOf(RangeError);
      expect(result.name).toBe("RangeError");
    });

    it("round-trips `Error` with cause", () => {
      const inner = FabricError.fromNativeError(new Error("inner"));
      const outer = FabricError.fromNativeError(
        new Error("outer", { cause: inner }),
      );
      const result = roundTrip(
        outer as FabricValue,
      ) as unknown as FabricError;
      expect(result.message).toBe("outer");
      // The cause was serialized as a FabricError (the inner wrapper).
      // After round-trip, the cause is a FabricError.
      expect(result.cause).toBeInstanceOf(FabricError);
      expect(
        (result.cause as FabricError).message,
      ).toBe("inner");
    });

    it("round-trips `Error` with custom properties", () => {
      const err = new Error("oops");
      (err as unknown as Record<string, unknown>).code = 42;
      (err as unknown as Record<string, unknown>).detail = "more info";
      const se = FabricError.fromNativeError(err);
      const result = roundTrip(
        se as FabricValue,
      ) as unknown as FabricError;
      expect(result.message).toBe("oops");
      expect(
        (result.toNativeValue(true) as unknown as Record<string, unknown>).code,
      ).toBe(42);
      expect(
        (result.toNativeValue(true) as unknown as Record<string, unknown>)
          .detail,
      ).toBe("more info");
    });

    it("round-trips `Error` with custom `name`", () => {
      const err = new Error("custom");
      err.name = "MyCustomError";
      const se = FabricError.fromNativeError(err);
      const result = roundTrip(
        se as FabricValue,
      ) as unknown as FabricError;
      expect(result.name).toBe("MyCustomError");
      expect(result.message).toBe("custom");
    });

    it("emits `name: null` in the wire format when `name` matches `type` (`TypeError`)", () => {
      // TypeError: name === constructor.name === "TypeError"
      const se = FabricError.fromNativeError(new TypeError("type check"));
      const result = toWireFormat(
        se as FabricValue,
      ) as Record<string, unknown>;
      const state = result["/Error@1"] as Record<string, unknown>;
      expect(state.type).toBe("TypeError");
      expect(state.name).toBe(null); // null = same as type
      expect(state.message).toBe("type check");
    });

    it("emits explicit `name` in the wire format when `name` differs from `type`", () => {
      const err = new Error("custom");
      err.name = "MyCustomError";
      const se = FabricError.fromNativeError(err);
      const result = toWireFormat(
        se as FabricValue,
      ) as Record<string, unknown>;
      const state = result["/Error@1"] as Record<string, unknown>;
      expect(state.type).toBe("Error");
      expect(state.name).toBe("MyCustomError");
      expect(state.message).toBe("custom");
    });

    it("round-trips `TypeError` preserving `name === type` identity", () => {
      // After round-trip, name and type should both be "TypeError",
      // and the Error should reconstruct as a TypeError instance.
      const se = FabricError.fromNativeError(new TypeError("rt"));
      const result = roundTrip(
        se as FabricValue,
      ) as unknown as FabricError;
      expect(result.toNativeValue(true)).toBeInstanceOf(TypeError);
      expect(result.name).toBe("TypeError");
      expect(result.toNativeValue(true).constructor.name).toBe("TypeError");
    });

    it("round-trips `Error` with mismatched `name` and `type`", () => {
      // Error constructor is "Error" but name is overridden.
      const err = new Error("mismatch");
      err.name = "CustomName";
      const se = FabricError.fromNativeError(err);
      const result = roundTrip(
        se as FabricValue,
      ) as unknown as FabricError;
      expect(result.toNativeValue(true)).toBeInstanceOf(Error);
      expect(result.name).toBe("CustomName");
      expect(result.toNativeValue(true).constructor.name).toBe("Error");
    });

    it("has `.typeTag` property", () => {
      const se = FabricError.fromNativeError(new Error("test"));
      expect(se.typeTag).toBe("Error@1");
    });

    it("round-trips `FabricError` with pre-converted cause (raw `Error`)", () => {
      // Simulates what fabricFromNativeValue produces: a FabricError
      // wrapping an Error whose cause is itself a FabricError (not a
      // raw Error). The serializer's recurse on [DECONSTRUCT] output
      // must find FabricValue, not raw Error.
      const innerSe = FabricError.fromNativeError(new Error("inner"));
      const outerErr = new Error("outer");
      outerErr.cause = innerSe;
      const outerSe = FabricError.fromNativeError(outerErr);

      const result = roundTrip(
        outerSe as FabricValue,
      ) as unknown as FabricError;
      expect(result.message).toBe("outer");
      expect(result.cause).toBeInstanceOf(FabricError);
      expect(
        (result.cause as FabricError).message,
      ).toBe("inner");
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
      expect(result.outer.inner).toBe(42);
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
        expect(result["/x"]["a"]).toBe(1);
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
        expect(result["/x"]["/y"]).toBe(123);
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
        expect(result["outer"]["/inner"]).toBe(1);
      });

      it("single-key `/`-prefixed object still routes through `unwrapTag()` (no regression)", () => {
        // Single-key /Tag@N objects are handled by unwrapTag, not the plain-object
        // path — confirm they still produce UnknownValue (unrecognized tag), not
        // ProblematicValue from the new multi-key guard.
        const data = { "/Future@7": { id: "x" } } as JsonWireValue;
        const result = fromWireFormat(data);
        expect(result).toBeInstanceOf(UnknownValue);
        expect((result as unknown as UnknownValue).typeTag).toBe("Future@7");
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
        expect(result["/x"]["/quote"]).toBe("inner");
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
      expect(unknown.typeTag).toBe("FutureType@2");
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
      expect(unknown.typeTag).toBe("FutureType@2");
      expect(unknown.state).toEqual({ some: "data" });
    });

    it("converts a `/hole` outside array context to `UnknownValue`", () => {
      const data = { "/hole": 5 } as JsonWireValue;
      const result = fromWireFormat(data);
      expect(result).toBeInstanceOf(UnknownValue);
      const unknown = result as unknown as UnknownValue;
      expect(unknown.typeTag).toBe("hole");
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
      // Create an UnknownValue whose state transitively references itself.
      const us = new UnknownValue("Test@1", null);
      // Mutate state to create a cycle: us -> [us] -> us.
      (us as unknown as { state: FabricValue }).state = [
        us,
      ] as unknown as FabricValue;
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
        ENCODING_PREFIX + JSON.stringify(data),
        runtime,
      );
      expect(result).toBeInstanceOf(ProblematicValue);
      const prob = result as unknown as ProblematicValue;
      expect(prob.typeTag).toBe("BigInt@1");
    });

    it("lenient mode wraps failed class-registry reconstruction", () => {
      const context = new JsonEncodingContext({ lenient: true });
      const runtime = new TestReconstructionContext();

      // Map@1 always throws on RECONSTRUCT ("not yet implemented"),
      // triggering lenient wrapping.
      const data = {
        "/Map@1": [["key", "value"]],
      } as JsonWireValue;
      const result = context.decode(
        ENCODING_PREFIX + JSON.stringify(data),
        runtime,
      );
      expect(result).toBeInstanceOf(ProblematicValue);
      const prob = result as unknown as ProblematicValue;
      expect(prob.typeTag).toBe("Map@1");
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

  describe("`TypeHandler.deserialize()` deep-frozen contract", () => {
    // The contract is scoped to the type-handler dispatch arm only: anything
    // returned via a registered `TypeHandler` is guaranteed deep-frozen at
    // the `deserialize()` boundary, so callers do not each have to freeze.
    // The class-registry fallback arm is a separate sibling branch and is
    // intentionally NOT covered by this contract.

    it("handler-produced value is deep-frozen at the boundary", () => {
      // `/EpochNsec@1` dispatches through a registered TypeHandler (arm-1);
      // the reconstructed FabricEpochNsec must be deep-frozen on return.
      const result = fromWireFormat(
        { "/EpochNsec@1": "AA" } as JsonWireValue,
      );
      expect(result).toBeInstanceOf(FabricEpochNsec);
      expect(isDeepFrozen(result)).toBe(true);
    });

    it("lenient-mode `ProblematicValue` from a handler is deep-frozen", () => {
      // `/BigInt@1` with non-string state fails handler validation; the
      // lenient catch produces a ProblematicValue -- still an arm-1 return,
      // so the contract deep-freezes it (not a crash: it is the value
      // lenient mode produces precisely to avoid crashing).
      const ctx = new JsonEncodingContext({ lenient: true });
      const runtime = new TestReconstructionContext();
      const result = ctx.decode(
        ENCODING_PREFIX + JSON.stringify({ "/BigInt@1": 42 }),
        runtime,
      );
      expect(result).toBeInstanceOf(ProblematicValue);
      expect(isDeepFrozen(result)).toBe(true);
    });

    it("handler round-trip yields a deep-frozen result", () => {
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
      const viaString = context.decode(ENCODING_PREFIX + json, runtime);
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
        ENCODING_PREFIX + JSON.stringify(wire),
        runtime,
      ) as Record<string, Record<string, FabricValue[]>>;

      expect(isDeepFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.outer)).toBe(true);
      expect(Object.isFrozen(result.outer.inner)).toBe(true);
      expect(() => {
        (result.outer.inner as unknown as number[])[0] = 99;
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
      expect(Object.isFrozen(result.outer.inner[0])).toBe(true);
      expect(() => {
        (result.outer.inner[0] as Record<string, unknown>).deep = 2;
      }).toThrow();
    });

    it("`serialize()` output for `/quote`-routed values is itself deep-frozen (flat and nested)", () => {
      // White-box: the serialized /quote tree is transient -- encode() and
      // encodeToBytes() immediately JSON.stringify it and discard it -- so
      // its frozen-ness is not observable via the public API. Reach into the
      // private serializer to pin the guarantee directly.
      //
      // It holds because `unquote()` rebuilds + recursively freezes every
      // array/object, so each member handed to the container's shallow
      // `Object.freeze` is itself already deep-frozen. A future change to
      // `unquote()` that stopped rebuilding (or stopped freezing) would
      // silently break this; this test is the guard. NOTE: the non-/quote
      // serialize outputs (bare objects/arrays, /object-wrapped, handler
      // state) are intentionally NOT asserted here -- that throwaway tree is
      // out of scope and is not deep-frozen.
      const { context } = makeTestContext();
      const serialize = (context as unknown as {
        serialize(v: FabricValue): JsonWireValue;
      }).serialize.bind(context);

      const flat = serialize(
        { "/a": 1, "/b": { plain: [1, 2] } } as unknown as FabricValue,
      );
      const nested = serialize(
        { "/a": { "/b": { c: [1, { d: 2 }] } } } as unknown as FabricValue,
      );

      expect(flat).toEqual({
        "/quote": { "/a": 1, "/b": { plain: [1, 2] } },
      });
      expect(isDeepFrozen(flat)).toBe(true);
      expect(isDeepFrozen(nested)).toBe(true);
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
      expect(result.startsWith(ENCODING_PREFIX)).toBe(true);
      expect(JSON.parse(result.slice(ENCODING_PREFIX.length))).toBe(42);
    });

    it("`decode()` parses a prefixed JSON string back to a value", () => {
      const ctx = new JsonEncodingContext();
      const runtime = new TestReconstructionContext();
      const result = ctx.decode(ENCODING_PREFIX + "42", runtime);
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
});
