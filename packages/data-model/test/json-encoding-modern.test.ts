import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { JsonEncodingContext } from "../json-encoding-modern.ts";
import {
  DECONSTRUCT,
  FabricInstance,
  type FabricValue,
  type ReconstructionContext,
} from "../interface.ts";
import type { JsonWireValue } from "../json-type-handlers.ts";
import { UnknownValue } from "../unknown-value.ts";
import { ProblematicValue } from "../problematic-value.ts";
import { ExplicitTagValue } from "../explicit-tag-value.ts";
import { FabricEpochDays, FabricEpochNsec } from "../fabric-epoch.ts";
import {
  FabricError,
  FabricMap,
  FabricSet,
} from "../fabric-native-instances.ts";
import { nativeFromFabricValueModern } from "../fabric-value-modern.ts";
import { FrozenMap, FrozenSet } from "../frozen-builtins.ts";
import {
  canBeStored,
  resetDataModelConfig,
  setDataModelConfig,
  shallowFabricFromNativeValue,
} from "../fabric-value.ts";

/** Creates a standard test context (non-lenient) and a mock runtime. */
function makeTestContext() {
  const context = new JsonEncodingContext();
  const runtime: ReconstructionContext = {
    getCell(_ref) {
      throw new Error("getCell not implemented in test runtime");
    },
  };
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
  return JSON.parse(context.encode(value)) as JsonWireValue;
}

/**
 * Helper: decode from a wire-format tree. Stringifies to JSON first,
 * then feeds through the public decode API.
 */
function fromWireFormat(data: JsonWireValue): FabricValue {
  const { context, runtime } = makeTestContext();
  return context.decode(JSON.stringify(data), runtime);
}

// ============================================================================
// Tests
// ============================================================================

describe("json encoding", () => {
  // --------------------------------------------------------------------------
  // Public API: Uint8Array boundary
  // --------------------------------------------------------------------------

  describe("Uint8Array public API", () => {
    it("encodeToBytes returns Uint8Array", () => {
      const { context } = makeTestContext();
      const result = context.encodeToBytes(42);
      expect(result).toBeInstanceOf(Uint8Array);
    });

    it("encodeToBytes produces valid JSON bytes", () => {
      const { context } = makeTestContext();
      const bytes = context.encodeToBytes(
        { a: 1 } as unknown as FabricValue,
      );
      const json = new TextDecoder().decode(bytes);
      expect(JSON.parse(json)).toEqual({ a: 1 });
    });

    it("decodeFromBytes accepts Uint8Array", () => {
      const { context, runtime } = makeTestContext();
      const bytes = new TextEncoder().encode(JSON.stringify({ a: 1 }));
      const result = context.decodeFromBytes(
        bytes,
        runtime,
      ) as Record<string, FabricValue>;
      expect(result.a).toBe(1);
    });

    it("round-trips through Uint8Array", () => {
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

    it("round-trips FabricError through Uint8Array", () => {
      const { context, runtime } = makeTestContext();
      const err = new FabricError(new TypeError("oops"));
      const bytes = context.encodeToBytes(err as FabricValue);
      const result = context.decodeFromBytes(
        bytes,
        runtime,
      );
      expect(result).toBeInstanceOf(FabricError);
      const se = result as unknown as FabricError;
      expect(se.error).toBeInstanceOf(TypeError);
      expect(se.error.message).toBe("oops");
    });

    it("round-trips undefined through Uint8Array", () => {
      const { context, runtime } = makeTestContext();
      const bytes = context.encodeToBytes(undefined);
      const result = context.decodeFromBytes(bytes, runtime);
      expect(result).toBe(undefined);
    });

    it("round-trips complex structure through Uint8Array", () => {
      const { context, runtime } = makeTestContext();
      const value = {
        users: [{ name: "Alice" }, { name: "Bob" }],
        error: new FabricError(new Error("fail")),
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

  // --------------------------------------------------------------------------
  // Round-trip tests for primitives
  // --------------------------------------------------------------------------

  describe("primitives round-trip", () => {
    it("passes through null", () => {
      expect(roundTrip(null)).toBe(null);
    });

    it("passes through true", () => {
      expect(roundTrip(true)).toBe(true);
    });

    it("passes through false", () => {
      expect(roundTrip(false)).toBe(false);
    });

    it("passes through 0", () => {
      expect(roundTrip(0)).toBe(0);
    });

    it("passes through 42", () => {
      expect(roundTrip(42)).toBe(42);
    });

    it("passes through 3.14", () => {
      expect(roundTrip(3.14)).toBe(3.14);
    });

    it("passes through empty string", () => {
      expect(roundTrip("")).toBe("");
    });

    it("passes through 'hello'", () => {
      expect(roundTrip("hello")).toBe("hello");
    });

    it("passes through strings with special characters", () => {
      expect(roundTrip("with\nnewlines")).toBe("with\nnewlines");
      expect(roundTrip("with\ttabs")).toBe("with\ttabs");
      expect(roundTrip('with"quotes')).toBe('with"quotes');
    });

    it("passes through Number.MAX_SAFE_INTEGER", () => {
      expect(roundTrip(Number.MAX_SAFE_INTEGER)).toBe(
        Number.MAX_SAFE_INTEGER,
      );
    });

    it("passes through negative numbers", () => {
      expect(roundTrip(-1)).toBe(-1);
      expect(roundTrip(-3.14)).toBe(-3.14);
    });
  });

  // --------------------------------------------------------------------------
  // undefined
  // --------------------------------------------------------------------------

  describe("undefined", () => {
    it("serializes to { '/Undefined@1': null }", () => {
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

    it("is distinct from null", () => {
      const serializedNull = toWireFormat(null);
      const serializedUndef = toWireFormat(undefined);
      expect(serializedNull).not.toEqual(serializedUndef);
    });
  });

  // --------------------------------------------------------------------------
  // bigint (primitive, handled by BigIntHandler)
  // --------------------------------------------------------------------------

  describe("bigint", () => {
    it("serializes 42n to base64 of two's complement bytes", () => {
      const result = toWireFormat(42n as FabricValue);
      // 42n -> [0x2a] -> base64 "Kg"
      expect(result).toEqual({ "/BigInt@1": "Kg" });
    });

    it("serializes 0n to base64 'AA'", () => {
      const result = toWireFormat(0n as FabricValue);
      // 0n -> [0x00] -> base64 "AA"
      expect(result).toEqual({ "/BigInt@1": "AA" });
    });

    it("serializes -1n to base64url '_w'", () => {
      const result = toWireFormat(-1n as FabricValue);
      // -1n -> [0xFF] -> base64url "_w"
      expect(result).toEqual({ "/BigInt@1": "_w" });
    });

    it("serializes 1n to base64 'AQ'", () => {
      const result = toWireFormat(1n as FabricValue);
      // 1n -> [0x01] -> base64 "AQ"
      expect(result).toEqual({ "/BigInt@1": "AQ" });
    });

    it("serializes 128n with sign-extension byte", () => {
      const result = toWireFormat(128n as FabricValue);
      // 128n -> [0x00, 0x80] -> base64 "AIA"
      expect(result).toEqual({ "/BigInt@1": "AIA" });
    });

    it("base64 output is unpadded (no trailing =)", () => {
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

    it("round-trips 1n", () => {
      const result = roundTrip(1n as FabricValue);
      expect(result).toBe(1n);
    });

    it("round-trips -1n", () => {
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

    it("round-trips boundary value 127n", () => {
      expect(roundTrip(127n as FabricValue)).toBe(127n);
    });

    it("round-trips boundary value 128n", () => {
      expect(roundTrip(128n as FabricValue)).toBe(128n);
    });

    it("round-trips boundary value -128n", () => {
      expect(roundTrip(-128n as FabricValue)).toBe(-128n);
    });

    it("round-trips boundary value -129n", () => {
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

    it("is distinct from number", () => {
      const serializedNum = toWireFormat(42);
      const serializedBig = toWireFormat(42n as FabricValue);
      expect(serializedNum).not.toEqual(serializedBig);
    });

    it("rejects padded base64 input (ProblematicValue)", () => {
      // "Kg==" is the padded form of "Kg" (42n) -- padding is now rejected.
      const data = { "/BigInt@1": "Kg==" } as JsonWireValue;
      const result = fromWireFormat(data);
      expect(result).toBeInstanceOf(ProblematicValue);
      const prob = result as unknown as ProblematicValue;
      expect(prob.typeTag).toBe("BigInt@1");
    });

    it("deserializes non-string state to ProblematicValue", () => {
      const data = { "/BigInt@1": 42 } as JsonWireValue;
      const result = fromWireFormat(data);
      expect(result).toBeInstanceOf(ProblematicValue);
      const prob = result as unknown as ProblematicValue;
      expect(prob.typeTag).toBe("BigInt@1");
      expect(prob.state).toBe(42);
    });

    it("deserializes null state to ProblematicValue", () => {
      const data = { "/BigInt@1": null } as JsonWireValue;
      const result = fromWireFormat(data);
      expect(result).toBeInstanceOf(ProblematicValue);
    });

    it("deserializes object state to ProblematicValue", () => {
      const data = { "/BigInt@1": { bad: true } } as JsonWireValue;
      const result = fromWireFormat(data);
      expect(result).toBeInstanceOf(ProblematicValue);
    });

    it("deserializes empty base64 string to ProblematicValue", () => {
      const data = { "/BigInt@1": "" } as JsonWireValue;
      const result = fromWireFormat(data);
      expect(result).toBeInstanceOf(ProblematicValue);
      const prob = result as unknown as ProblematicValue;
      expect(prob.typeTag).toBe("BigInt@1");
    });
  });

  // --------------------------------------------------------------------------
  // FabricEpochNsec
  // --------------------------------------------------------------------------

  describe("FabricEpochNsec", () => {
    it("serializes to /EpochNsec@1 with flat base64", () => {
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

  // --------------------------------------------------------------------------
  // FabricEpochDays
  // --------------------------------------------------------------------------

  describe("FabricEpochDays", () => {
    it("serializes to /EpochDays@1 with flat base64", () => {
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

  // --------------------------------------------------------------------------
  // Date -> FabricEpochNsec conversion
  // --------------------------------------------------------------------------

  describe("Date -> FabricEpochNsec conversion", () => {
    it("converts Date(0) to FabricEpochNsec(0n)", () => {
      setDataModelConfig(true);
      try {
        const date = new Date(0);
        const result = shallowFabricFromNativeValue(
          date,
        ) as unknown as FabricEpochNsec;
        expect(result).toBeInstanceOf(FabricEpochNsec);
        expect(result.value).toBe(0n);
      } finally {
        resetDataModelConfig();
      }
    });

    it("converts Date to nanoseconds (msec * 1_000_000)", () => {
      setDataModelConfig(true);
      try {
        const date = new Date("2024-01-01T00:00:00.000Z");
        const result = shallowFabricFromNativeValue(
          date,
        ) as unknown as FabricEpochNsec;
        expect(result).toBeInstanceOf(FabricEpochNsec);
        const expectedNsec = BigInt(date.getTime()) * 1_000_000n;
        expect(result.value).toBe(expectedNsec);
      } finally {
        resetDataModelConfig();
      }
    });

    it("converts negative Date to negative nanoseconds", () => {
      setDataModelConfig(true);
      try {
        const date = new Date(-86400000); // -1 day
        const result = shallowFabricFromNativeValue(
          date,
        ) as unknown as FabricEpochNsec;
        expect(result).toBeInstanceOf(FabricEpochNsec);
        expect(result.value).toBe(-86400000000000n);
      } finally {
        resetDataModelConfig();
      }
    });
  });

  // --------------------------------------------------------------------------
  // FabricError (Error wrapper)
  // --------------------------------------------------------------------------

  describe("FabricError", () => {
    it("serializes basic FabricError to /Error@1", () => {
      const se = new FabricError(new Error("test"));
      const result = toWireFormat(
        se as FabricValue,
      ) as Record<string, unknown>;
      expect(Object.keys(result)).toEqual(["/Error@1"]);
      const state = result["/Error@1"] as Record<string, unknown>;
      expect(state.type).toBe("Error");
      expect(state.name).toBe(null); // null = same as type (common case)
      expect(state.message).toBe("test");
    });

    it("round-trips basic Error via FabricError", () => {
      const se = new FabricError(new Error("hello"));
      const result = roundTrip(
        se as FabricValue,
      ) as unknown as FabricError;
      expect(result).toBeInstanceOf(FabricError);
      expect(result.error).toBeInstanceOf(Error);
      expect(result.error.name).toBe("Error");
      expect(result.error.message).toBe("hello");
    });

    it("round-trips TypeError", () => {
      const se = new FabricError(new TypeError("bad type"));
      const result = roundTrip(
        se as FabricValue,
      ) as unknown as FabricError;
      expect(result).toBeInstanceOf(FabricError);
      expect(result.error).toBeInstanceOf(TypeError);
      expect(result.error.name).toBe("TypeError");
      expect(result.error.message).toBe("bad type");
    });

    it("round-trips RangeError", () => {
      const se = new FabricError(new RangeError("out of range"));
      const result = roundTrip(
        se as FabricValue,
      ) as unknown as FabricError;
      expect(result).toBeInstanceOf(FabricError);
      expect(result.error).toBeInstanceOf(RangeError);
      expect(result.error.name).toBe("RangeError");
    });

    it("round-trips Error with cause", () => {
      const inner = new FabricError(new Error("inner"));
      const outer = new FabricError(
        new Error("outer", { cause: inner }),
      );
      const result = roundTrip(
        outer as FabricValue,
      ) as unknown as FabricError;
      expect(result.error.message).toBe("outer");
      // The cause was serialized as a FabricError (the inner wrapper).
      // After round-trip, the cause is a FabricError.
      expect(result.error.cause).toBeInstanceOf(FabricError);
      expect(
        (result.error.cause as FabricError).error.message,
      ).toBe("inner");
    });

    it("round-trips Error with custom properties", () => {
      const err = new Error("oops");
      (err as unknown as Record<string, unknown>).code = 42;
      (err as unknown as Record<string, unknown>).detail = "more info";
      const se = new FabricError(err);
      const result = roundTrip(
        se as FabricValue,
      ) as unknown as FabricError;
      expect(result.error.message).toBe("oops");
      expect(
        (result.error as unknown as Record<string, unknown>).code,
      ).toBe(42);
      expect(
        (result.error as unknown as Record<string, unknown>).detail,
      ).toBe("more info");
    });

    it("round-trips Error with custom name", () => {
      const err = new Error("custom");
      err.name = "MyCustomError";
      const se = new FabricError(err);
      const result = roundTrip(
        se as FabricValue,
      ) as unknown as FabricError;
      expect(result.error.name).toBe("MyCustomError");
      expect(result.error.message).toBe("custom");
    });

    it("wire format has name: null when name matches type (TypeError)", () => {
      // TypeError: name === constructor.name === "TypeError"
      const se = new FabricError(new TypeError("type check"));
      const result = toWireFormat(
        se as FabricValue,
      ) as Record<string, unknown>;
      const state = result["/Error@1"] as Record<string, unknown>;
      expect(state.type).toBe("TypeError");
      expect(state.name).toBe(null); // null = same as type
      expect(state.message).toBe("type check");
    });

    it("wire format has explicit name when name differs from type", () => {
      const err = new Error("custom");
      err.name = "MyCustomError";
      const se = new FabricError(err);
      const result = toWireFormat(
        se as FabricValue,
      ) as Record<string, unknown>;
      const state = result["/Error@1"] as Record<string, unknown>;
      expect(state.type).toBe("Error");
      expect(state.name).toBe("MyCustomError");
      expect(state.message).toBe("custom");
    });

    it("round-trips TypeError preserving name === type identity", () => {
      // After round-trip, name and type should both be "TypeError",
      // and the Error should reconstruct as a TypeError instance.
      const se = new FabricError(new TypeError("rt"));
      const result = roundTrip(
        se as FabricValue,
      ) as unknown as FabricError;
      expect(result.error).toBeInstanceOf(TypeError);
      expect(result.error.name).toBe("TypeError");
      expect(result.error.constructor.name).toBe("TypeError");
    });

    it("round-trips Error with mismatched name and type", () => {
      // Error constructor is "Error" but name is overridden.
      const err = new Error("mismatch");
      err.name = "CustomName";
      const se = new FabricError(err);
      const result = roundTrip(
        se as FabricValue,
      ) as unknown as FabricError;
      expect(result.error).toBeInstanceOf(Error);
      expect(result.error.name).toBe("CustomName");
      expect(result.error.constructor.name).toBe("Error");
    });

    it("has typeTag property", () => {
      const se = new FabricError(new Error("test"));
      expect(se.typeTag).toBe("Error@1");
    });

    it("round-trips FabricError with pre-converted cause (raw Error)", () => {
      // Simulates what fabricFromNativeValue produces: a FabricError
      // wrapping an Error whose cause is itself a FabricError (not a
      // raw Error). The serializer's recurse on [DECONSTRUCT] output
      // must find FabricValue, not raw Error.
      const innerSe = new FabricError(new Error("inner"));
      const outerErr = new Error("outer");
      outerErr.cause = innerSe;
      const outerSe = new FabricError(outerErr);

      const result = roundTrip(
        outerSe as FabricValue,
      ) as unknown as FabricError;
      expect(result.error.message).toBe("outer");
      expect(result.error.cause).toBeInstanceOf(FabricError);
      expect(
        (result.error.cause as FabricError).error.message,
      ).toBe("inner");
    });
  });

  // --------------------------------------------------------------------------
  // Dense arrays
  // --------------------------------------------------------------------------

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

  // --------------------------------------------------------------------------
  // Sparse arrays
  // --------------------------------------------------------------------------

  describe("sparse arrays", () => {
    it("serializes [1,,3] with /hole", () => {
      // deno-lint-ignore no-sparse-arrays
      const arr = [1, , 3] as FabricValue;
      const result = toWireFormat(arr) as JsonWireValue[];
      expect(result.length).toBe(3);
      expect(result[0]).toBe(1);
      expect(result[1]).toEqual({ "/hole": 1 });
      expect(result[2]).toBe(3);
    });

    it("round-trips [1,,3] preserving holes", () => {
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

    it("round-trips [1,,,,5]", () => {
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

    it("round-trips all-holes array [,,,]", () => {
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

    it("round-trips interleaved holes and undefined", () => {
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

    it("serializes interleaved holes/undefined correctly", () => {
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

  // --------------------------------------------------------------------------
  // Plain objects
  // --------------------------------------------------------------------------

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

    it("preserves undefined values in objects", () => {
      const obj = { a: 1, b: undefined } as unknown as FabricValue;
      const result = roundTrip(obj) as Record<string, FabricValue>;
      expect(result.a).toBe(1);
      expect(result.b).toBe(undefined);
      expect("b" in result).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // /object escaping (Section 5.6)
  // --------------------------------------------------------------------------

  describe("/object escaping", () => {
    it("wraps single-key object with /-prefixed key", () => {
      const obj = { "/myKey": "val" } as unknown as FabricValue;
      const result = toWireFormat(obj);
      expect(result).toEqual({
        "/object": { "/myKey": "val" },
      });
    });

    it("round-trips {'/myKey': 'val'}", () => {
      const obj = { "/myKey": "val" } as unknown as FabricValue;
      const result = roundTrip(obj) as Record<string, FabricValue>;
      expect(result["/myKey"]).toBe("val");
    });

    it("wraps {'/Link@1': 'fake'} (looks like tag but is user data)", () => {
      const obj = { "/Link@1": "fake" } as unknown as FabricValue;
      const result = toWireFormat(obj);
      expect(result).toEqual({
        "/object": { "/Link@1": "fake" },
      });
    });

    it("round-trips {'/Link@1': 'fake'}", () => {
      const obj = { "/Link@1": "fake" } as unknown as FabricValue;
      const result = roundTrip(obj) as Record<string, FabricValue>;
      expect(result["/Link@1"]).toBe("fake");
    });

    it("does not wrap multi-key objects with / keys", () => {
      const obj = { a: 1, "/b": 2 } as unknown as FabricValue;
      const result = toWireFormat(obj);
      expect(result).toEqual({ a: 1, "/b": 2 });
    });

    it("round-trips multi-key object with / key", () => {
      const obj = { a: 1, "/b": 2 } as unknown as FabricValue;
      const result = roundTrip(obj) as Record<string, FabricValue>;
      expect(result.a).toBe(1);
      expect(result["/b"]).toBe(2);
    });
  });

  // --------------------------------------------------------------------------
  // /quote handling (Section 5.6)
  // --------------------------------------------------------------------------

  describe("/quote handling", () => {
    it("deserializes /quote as literal (no inner deserialization)", () => {
      const data = {
        "/quote": { "/Link@1": { id: "abc" } },
      } as JsonWireValue;
      const result = fromWireFormat(data);
      // The inner structure is returned as-is, not reconstructed.
      const obj = result as Record<string, unknown>;
      expect(obj["/Link@1"]).toEqual({ id: "abc" });
    });

    it("deep-freezes /quote result objects", () => {
      const data = {
        "/quote": { "/Link@1": { id: "abc" } },
      } as JsonWireValue;
      const result = fromWireFormat(data) as Record<string, unknown>;
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result["/Link@1"])).toBe(true);
    });

    it("deep-freezes /quote result arrays", () => {
      const data = {
        "/quote": [1, { nested: "obj" }, [2, 3]],
      } as JsonWireValue;
      const result = fromWireFormat(data) as unknown[];
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result[1])).toBe(true);
      expect(Object.isFrozen(result[2])).toBe(true);
    });

    it("mutation of /quote result throws", () => {
      const data = {
        "/quote": { key: "val" },
      } as JsonWireValue;
      const result = fromWireFormat(data) as Record<string, unknown>;
      expect(() => {
        result.key = "changed";
      }).toThrow();
    });
  });

  // --------------------------------------------------------------------------
  // Unknown type tags -> UnknownValue
  // --------------------------------------------------------------------------

  describe("unknown type tags", () => {
    it("decode() produces UnknownValue for unrecognized tags", () => {
      const data = {
        "/FutureType@2": { some: "data" },
      } as JsonWireValue;
      const result = fromWireFormat(data);
      expect(result).toBeInstanceOf(UnknownValue);
      const unknown = result as unknown as UnknownValue;
      expect(unknown.typeTag).toBe("FutureType@2");
      expect(unknown.state).toEqual({ some: "data" });
    });

    it("encode preserves UnknownValue tag in wire format", () => {
      // Encoding an UnknownValue produces the original tagged form.
      const us = new UnknownValue("FutureType@2", { some: "data" });
      const wireFormat = toWireFormat(us as FabricValue);
      expect(wireFormat).toEqual({
        "/FutureType@2": { some: "data" },
      });
    });

    it("UnknownValue round-trips through encode/decode", () => {
      const us = new UnknownValue("FutureType@2", { some: "data" });
      const result = roundTrip(us as FabricValue);
      expect(result).toBeInstanceOf(UnknownValue);
      const unknown = result as unknown as UnknownValue;
      expect(unknown.typeTag).toBe("FutureType@2");
      expect(unknown.state).toEqual({ some: "data" });
    });

    it("/hole outside array context becomes UnknownValue", () => {
      const data = { "/hole": 5 } as JsonWireValue;
      const result = fromWireFormat(data);
      expect(result).toBeInstanceOf(UnknownValue);
      const unknown = result as unknown as UnknownValue;
      expect(unknown.typeTag).toBe("hole");
      expect(unknown.state).toBe(5);
    });
  });

  // --------------------------------------------------------------------------
  // Circular reference detection
  // --------------------------------------------------------------------------

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

    it("throws on FabricInstance whose state references itself", () => {
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

  // --------------------------------------------------------------------------
  // ProblematicValue (lenient mode)
  // --------------------------------------------------------------------------

  describe("ProblematicValue (lenient mode)", () => {
    it("encode preserves ProblematicValue's original tag and state", () => {
      const prob = new ProblematicValue(
        "BadType@1",
        "original data",
        "something went wrong",
      );
      const { context } = makeTestContext();
      const wireFormat = JSON.parse(
        context.encode(prob as FabricValue),
      );
      expect(wireFormat).toEqual({ "/BadType@1": "original data" });
    });

    it("lenient mode wraps failed handler reconstruction", () => {
      const context = new JsonEncodingContext({ lenient: true });
      const runtime: ReconstructionContext = {
        getCell(_ref) {
          throw new Error("not available");
        },
      };

      // BigInt@1 with a non-string state produces ProblematicValue
      // in lenient mode because the handler validates the state type.
      const data = { "/BigInt@1": 42 } as JsonWireValue;
      const result = context.decode(JSON.stringify(data), runtime);
      expect(result).toBeInstanceOf(ProblematicValue);
      const prob = result as unknown as ProblematicValue;
      expect(prob.typeTag).toBe("BigInt@1");
    });

    it("lenient mode wraps failed class-registry reconstruction", () => {
      const context = new JsonEncodingContext({ lenient: true });
      const runtime: ReconstructionContext = {
        getCell(_ref) {
          throw new Error("not available");
        },
      };

      // Map@1 always throws on RECONSTRUCT ("not yet implemented"),
      // triggering lenient wrapping.
      const data = {
        "/Map@1": [["key", "value"]],
      } as JsonWireValue;
      const result = context.decode(JSON.stringify(data), runtime);
      expect(result).toBeInstanceOf(ProblematicValue);
      const prob = result as unknown as ProblematicValue;
      expect(prob.typeTag).toBe("Map@1");
    });
  });

  // --------------------------------------------------------------------------
  // Object.freeze() guarantees
  // --------------------------------------------------------------------------

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

    it("deserialized /object-unwrapped objects are frozen", () => {
      const data = { "/object": { "/myKey": "val" } } as JsonWireValue;
      const result = fromWireFormat(data) as Record<
        string,
        FabricValue
      >;
      expect(Object.isFrozen(result)).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // data-model-protocol: FabricInstance instanceof checks
  // --------------------------------------------------------------------------

  describe("FabricInstance instanceof checks", () => {
    it("returns false for null", () => {
      expect((null as unknown) instanceof FabricInstance).toBe(false);
    });

    it("returns false for undefined", () => {
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

    it("returns true for UnknownValue", () => {
      const us = new UnknownValue("Test@1", null);
      expect(us instanceof FabricInstance).toBe(true);
    });

    it("returns true for ProblematicValue", () => {
      const ps = new ProblematicValue("Test@1", null, "oops");
      expect(ps instanceof FabricInstance).toBe(true);
    });

    it("returns true for custom FabricInstance subclass", () => {
      class CustomStorable extends FabricInstance {
        [DECONSTRUCT](): FabricValue {
          return { value: 42 };
        }
        protected shallowUnfrozenClone(): CustomStorable {
          return new CustomStorable();
        }
      }
      const instance = new CustomStorable();
      expect(instance instanceof FabricInstance).toBe(true);
    });

    it("returns true for FabricError", () => {
      const se = new FabricError(new Error("test"));
      expect(se instanceof FabricInstance).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // UnknownValue
  // --------------------------------------------------------------------------

  describe("UnknownValue", () => {
    it("preserves typeTag and state", () => {
      const us = new UnknownValue("FancyType@3", { data: [1, 2, 3] });
      expect(us.typeTag).toBe("FancyType@3");
      expect(us.state).toEqual({ data: [1, 2, 3] });
    });

    it("has DECONSTRUCT method", () => {
      const us = new UnknownValue("Test@1", "state");
      expect(us[DECONSTRUCT]()).toEqual({
        type: "Test@1",
        state: "state",
      });
    });
  });

  // --------------------------------------------------------------------------
  // ProblematicValue
  // --------------------------------------------------------------------------

  describe("ProblematicValue", () => {
    it("preserves typeTag, state, and error", () => {
      const ps = new ProblematicValue("BadType@1", { x: 1 }, "boom");
      expect(ps.typeTag).toBe("BadType@1");
      expect(ps.state).toEqual({ x: 1 });
      expect(ps.error).toBe("boom");
    });

    it("has DECONSTRUCT method", () => {
      const ps = new ProblematicValue("T@1", "s", "e");
      expect(ps[DECONSTRUCT]()).toEqual({
        type: "T@1",
        state: "s",
        error: "e",
      });
    });
  });

  // --------------------------------------------------------------------------
  // ExplicitTagValue base class
  // --------------------------------------------------------------------------

  describe("ExplicitTagValue", () => {
    it("UnknownValue is an instance of ExplicitTagValue", () => {
      const us = new UnknownValue("Test@1", "state");
      expect(us instanceof ExplicitTagValue).toBe(true);
    });

    it("ProblematicValue is an instance of ExplicitTagValue", () => {
      const ps = new ProblematicValue("Test@1", "state", "oops");
      expect(ps instanceof ExplicitTagValue).toBe(true);
    });

    it("ExplicitTagValue provides access to typeTag and state", () => {
      const us: ExplicitTagValue = new UnknownValue("Tag@2", 42);
      expect(us.typeTag).toBe("Tag@2");
      expect(us.state).toBe(42);

      const ps: ExplicitTagValue = new ProblematicValue(
        "Bad@1",
        "data",
        "err",
      );
      expect(ps.typeTag).toBe("Bad@1");
      expect(ps.state).toBe("data");
    });
  });

  // --------------------------------------------------------------------------
  // JsonEncodingContext public API
  // --------------------------------------------------------------------------

  describe("JsonEncodingContext", () => {
    it("encode returns a JSON string", () => {
      const ctx = new JsonEncodingContext();
      const result = ctx.encode(42);
      expect(typeof result).toBe("string");
      expect(JSON.parse(result)).toBe(42);
    });

    it("decode parses a JSON string back to a value", () => {
      const ctx = new JsonEncodingContext();
      const runtime: ReconstructionContext = {
        getCell(_ref) {
          throw new Error("not implemented");
        },
      };
      const result = ctx.decode("42", runtime);
      expect(result).toBe(42);
    });

    it("encode/decode round-trip for tagged types", () => {
      const ctx = new JsonEncodingContext();
      const runtime: ReconstructionContext = {
        getCell(_ref) {
          throw new Error("not implemented");
        },
      };
      const se = new FabricError(new Error("test"));
      const encoded = ctx.encode(se as FabricValue);
      const decoded = ctx.decode(encoded, runtime);
      expect(decoded).toBeInstanceOf(FabricError);
      expect((decoded as unknown as FabricError).error.message).toBe("test");
    });

    it("encodeToBytes/decodeFromBytes round-trip", () => {
      const ctx = new JsonEncodingContext();
      const runtime: ReconstructionContext = {
        getCell(_ref) {
          throw new Error("not implemented");
        },
      };
      const data = {
        name: "test",
        error: new FabricError(new Error("fail")),
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

    it("lenient defaults to false", () => {
      const ctx = new JsonEncodingContext();
      expect(ctx.lenient).toBe(false);
    });

    it("lenient can be set to true", () => {
      const ctx = new JsonEncodingContext({ lenient: true });
      expect(ctx.lenient).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // nativeFromFabricValueModern
  // --------------------------------------------------------------------------

  describe("nativeFromFabricValueModern", () => {
    it("deeply unwraps FabricError in objects (frozen)", () => {
      const err = new Error("deep");
      const se = new FabricError(err);
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

    it("deeply unwraps FabricError in arrays (frozen)", () => {
      const err = new Error("array");
      const se = new FabricError(err);
      const arr = [1, se, 3] as unknown as FabricValue;
      const result = nativeFromFabricValueModern(arr) as unknown[];
      expect(result[0]).toBe(1);
      expect(result[1]).toBeInstanceOf(Error);
      expect((result[1] as Error).message).toBe("array");
      expect(Object.isFrozen(result[1])).toBe(true);
      expect(result[2]).toBe(3);
      expect(Object.isFrozen(result)).toBe(true);
    });

    it("output is not frozen when frozen=false", () => {
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

    it("output is frozen when frozen=true (default)", () => {
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

    it("passes through non-native FabricInstance", () => {
      const us = new UnknownValue("Test@1", null);
      const obj = { thing: us } as unknown as FabricValue;
      const result = nativeFromFabricValueModern(obj) as Record<
        string,
        unknown
      >;
      expect(result.thing).toBe(us);
    });

    it("deeply unwraps FabricMap to FrozenMap", () => {
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

    it("deeply unwraps FabricSet to FrozenSet", () => {
      const set = new Set<FabricValue>([42] as FabricValue[]);
      const ss = new FabricSet(set);
      const arr = [ss] as unknown as FabricValue;
      const result = nativeFromFabricValueModern(arr) as unknown[];
      expect(result[0]).toBeInstanceOf(FrozenSet);
      expect((result[0] as Set<number>).has(42)).toBe(true);
    });

    it("deeply unwraps Error internals (C2)", () => {
      // Error with a FabricError cause and a custom FabricMap property.
      const innerErr = new Error("inner");
      const innerSe = new FabricError(innerErr);
      const outerErr = new Error("outer");
      outerErr.cause = innerSe;
      (outerErr as unknown as Record<string, unknown>).data = new FabricMap(
        new Map([["k", 1]] as [FabricValue, FabricValue][]),
      );
      const outerSe = new FabricError(outerErr);

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

    it("deeply unwraps Error internals unfrozen (C2)", () => {
      const innerErr = new Error("inner");
      const innerSe = new FabricError(innerErr);
      const outerErr = new Error("outer");
      outerErr.cause = innerSe;
      const outerSe = new FabricError(outerErr);

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
  // Complex round-trip scenarios
  // --------------------------------------------------------------------------

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

    it("round-trips FabricError in array", () => {
      const se = new FabricError(new Error("oops"));
      const arr = [1, se, 3] as unknown as FabricValue;
      const result = roundTrip(arr) as FabricValue[];
      expect(result[0]).toBe(1);
      expect(result[1]).toBeInstanceOf(FabricError);
      expect(
        (result[1] as unknown as FabricError).error.message,
      ).toBe("oops");
      expect(result[2]).toBe(3);
    });

    it("round-trips FabricError as object value", () => {
      const obj = {
        error: new FabricError(new Error("fail")),
        code: 500,
      } as unknown as FabricValue;
      const result = roundTrip(obj) as Record<string, FabricValue>;
      expect(result.error).toBeInstanceOf(FabricError);
      expect(
        (result.error as unknown as FabricError).error.message,
      ).toBe("fail");
      expect(result.code).toBe(500);
    });

    it("wire format is unchanged (backward compatible)", () => {
      // FabricError should produce the same wire format as the old ErrorHandler.
      const se = new FabricError(new TypeError("compat test"));
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

  // --------------------------------------------------------------------------
  // canBeStored: deep storability check
  // --------------------------------------------------------------------------

  describe("canBeStored", () => {
    beforeEach(() => {
      setDataModelConfig(true);
    });
    afterEach(() => {
      resetDataModelConfig();
    });

    // -- Primitives that ARE fabric-compatible --
    it("accepts null", () => {
      expect(canBeStored(null)).toBe(true);
    });

    it("accepts boolean", () => {
      expect(canBeStored(true)).toBe(true);
      expect(canBeStored(false)).toBe(true);
    });

    it("accepts finite numbers", () => {
      expect(canBeStored(42)).toBe(true);
      expect(canBeStored(0)).toBe(true);
      expect(canBeStored(-3.14)).toBe(true);
    });

    it("accepts strings", () => {
      expect(canBeStored("hello")).toBe(true);
      expect(canBeStored("")).toBe(true);
    });

    it("accepts undefined", () => {
      expect(canBeStored(undefined)).toBe(true);
    });

    it("accepts bigint", () => {
      expect(canBeStored(42n)).toBe(true);
      expect(canBeStored(0n)).toBe(true);
    });

    // -- Primitives that are NOT fabric-compatible --
    it("rejects NaN", () => {
      expect(canBeStored(NaN)).toBe(false);
    });

    it("rejects Infinity", () => {
      expect(canBeStored(Infinity)).toBe(false);
      expect(canBeStored(-Infinity)).toBe(false);
    });

    it("rejects symbols", () => {
      expect(canBeStored(Symbol("test"))).toBe(false);
    });

    it("rejects functions without toJSON", () => {
      expect(canBeStored(() => 42)).toBe(false);
    });

    // -- FabricNativeObject types (would be wrapped) --
    it("accepts Error instances", () => {
      expect(canBeStored(new Error("test"))).toBe(true);
      expect(canBeStored(new TypeError("test"))).toBe(true);
    });

    it("accepts Map instances", () => {
      expect(canBeStored(new Map())).toBe(true);
    });

    it("accepts Set instances", () => {
      expect(canBeStored(new Set())).toBe(true);
    });

    it("accepts Date instances", () => {
      expect(canBeStored(new Date())).toBe(true);
    });

    it("accepts Uint8Array instances", () => {
      expect(canBeStored(new Uint8Array([1, 2, 3]))).toBe(true);
    });

    // -- FabricInstance values --
    it("accepts FabricError wrappers", () => {
      expect(canBeStored(new FabricError(new Error("test")))).toBe(true);
    });

    // -- Containers --
    it("accepts plain objects with fabric values", () => {
      expect(canBeStored({ a: 1, b: "hello", c: null })).toBe(true);
    });

    it("accepts arrays with fabric values", () => {
      expect(canBeStored([1, "hello", null, true])).toBe(true);
    });

    it("accepts nested structures", () => {
      expect(canBeStored({
        users: [{ name: "Alice", age: 30 }],
        meta: { version: 1 },
      })).toBe(true);
    });

    // -- Deep checks with FabricNativeObject --
    it("accepts objects containing Error values", () => {
      expect(canBeStored({ error: new Error("test"), code: 500 })).toBe(true);
    });

    it("accepts arrays containing Error values", () => {
      expect(canBeStored([1, new Error("test"), "hello"])).toBe(true);
    });

    // -- Rejections --
    it("rejects class instances without toJSON", () => {
      class Foo {
        x = 1;
      }
      expect(canBeStored(new Foo())).toBe(false);
    });

    it("rejects objects with non-fabric nested values", () => {
      expect(canBeStored({ a: 1, b: Symbol("bad") })).toBe(false);
    });

    it("rejects arrays with non-fabric elements", () => {
      expect(canBeStored([1, Symbol("bad")])).toBe(false);
    });

    it("rejects deeply nested non-fabric values", () => {
      expect(canBeStored({
        a: { b: { c: [1, 2, { d: Symbol("bad") }] } },
      })).toBe(false);
    });

    // -- Circular references --
    it("returns false for circular references", () => {
      const obj: Record<string, unknown> = { a: 1 };
      obj.self = obj;
      expect(canBeStored(obj)).toBe(false);
    });

    // -- toJSON support --
    it("accepts objects with toJSON returning fabric values", () => {
      const obj = { toJSON: () => ({ x: 1 }) };
      expect(canBeStored(obj)).toBe(true);
    });

    it("rejects objects with toJSON returning non-fabric values", () => {
      const obj = { toJSON: () => Symbol("bad") };
      expect(canBeStored(obj)).toBe(false);
    });
  });
});
