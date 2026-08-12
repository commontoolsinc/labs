import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { JsonCodec } from "@/codec-json/JsonCodec.ts";
import { createDefaultJsonRegistry, newDefaultJsonCodec } from "@/codecs.ts";
import { FabricInstance, type FabricValue } from "@/interface.ts";
import { JSON_FORMAT, type JsonCodecValue } from "@/codec-json/interface.ts";
import { UnknownValue } from "@/fabric-instances/UnknownValue.ts";
import { ProblematicValue } from "@/fabric-instances/ProblematicValue.ts";
import {
  BaseFabricInstance,
  DEEP_CLONE_CORE,
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
import { CodecRegistry } from "@/codec-common/CodecRegistry.ts";
import { BaseNonterminalCodec } from "@/codec-common/BaseNonterminalCodec.ts";
import { BaseTerminalCodec } from "@/codec-common/BaseTerminalCodec.ts";
import { FabricBytes } from "@/fabric-primitives/FabricBytes.ts";

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
  protected [DEEP_CLONE_CORE](_frozen: boolean): FabricInstance {
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
 * between encoded strings and codec-value trees does NOT go through this --
 * that is what `JsonCodec`'s wrap/unwrap helpers are for.
 */
const ENCODING_PREFIX = "fvj1:";

/** Creates a standard test codec (non-lenient) and a mock runtime. */
function makeTestCodec() {
  const jsonCodec = newDefaultJsonCodec();
  const runtime = new TestReconstructionContext();
  return { jsonCodec, runtime };
}

/** Helper: encode then decode (round-trip) through the public API. */
function roundTrip(value: FabricValue): FabricValue {
  const { jsonCodec, runtime } = makeTestCodec();
  const encoded = jsonCodec.encode(value);
  return jsonCodec.decode(encoded, runtime);
}

/**
 * Helper: encode a value and return the codec-value tree (parsed JSON).
 * Used for assertions about the intermediate codec value.
 */
function toWireFormat(value: FabricValue): JsonCodecValue {
  const { jsonCodec } = makeTestCodec();
  const encoded = jsonCodec.encode(value);
  return JSON.parse(
    JsonCodec.unwrapEncodedValueForTesting(encoded),
  ) as JsonCodecValue;
}

/**
 * Helper: decode from a codec-value tree. Stringifies to JSON first (tagged as
 * an encoded value), then feeds through the public decode API.
 */
function fromWireFormat(data: JsonCodecValue): FabricValue {
  const { jsonCodec, runtime } = makeTestCodec();
  return jsonCodec.decode(
    JsonCodec.wrapEncodedValueForTesting(JSON.stringify(data)),
    runtime,
  );
}

describe("JsonCodec", () => {
  describe("`registry` constructor option", () => {
    // An empty registry recognizes no class and no tag, so it differs from the
    // built-in one on any fabric class. `FabricError` is the probe: the
    // built-in registry encodes it and decodes it back, and these cases assert
    // the empty registry's behavior instead, in both directions.

    it("throws on encode for a class the supplied registry lacks", () => {
      const jsonCodec = new JsonCodec({
        registry: new CodecRegistry(JSON_FORMAT),
      });
      const value = FabricError.fromNativeError(new Error("boom"));

      expect(() => jsonCodec.encode(value)).toThrow(
        "No codec registered for fabric object class: `FabricError`",
      );
    });

    it("returns an `UnknownValue` on decode for a tag the supplied registry lacks", () => {
      const wire = newDefaultJsonCodec().encode(
        FabricError.fromNativeError(new Error("boom")),
      );
      const jsonCodec = new JsonCodec({
        registry: new CodecRegistry(JSON_FORMAT),
      });

      const result = jsonCodec.decode(wire, new TestReconstructionContext());

      expect(result).toBeInstanceOf(UnknownValue);
      expect((result as UnknownValue).wireTypeTag).toBe("Error@1");
    });
  });

  describe("terminal vs. nonterminal codecs", () => {
    // The two kinds differ in exactly one respect: whether the walker
    // processes the state a codec produces. Every codec this package registers
    // for JSON hides that difference, because each of their states is a
    // self-representing value -- one of `null`, `boolean`, `number`, `string`
    // -- and the walker is the identity on those by definition.
    //
    // Nothing in the types requires that. `JsonCodecValue` admits structure,
    // and a structured state is where the two kinds part company.
    //
    // These cases use a state that does not survive one: a plain object
    // carrying a `/`-prefixed key. The walker escapes such an object with
    // `/quote` on the way out, and decodes the tag it names on the way back,
    // so which kind of codec produced it is legible in the wire form and in
    // what `decode()` is handed.

    const PROBE_TAG = "Probe@1";
    const PROBE_STATE = Object.freeze({ "/Bytes@1": "AQID" });

    /** Stateless instance, existing only to have a class to dispatch on. */
    class ProbeInstance extends BaseFabricInstance {
      get wireTypeTag(): string {
        return PROBE_TAG;
      }

      protected [SHALLOW_UNFROZEN_CLONE](): FabricInstance {
        return new ProbeInstance();
      }

      protected [DEEP_CLONE_CORE](_frozen: boolean): FabricInstance {
        return new ProbeInstance();
      }

      [DEEP_FREEZE](
        _subFreeze: (value: FabricValue) => FabricValue,
      ): FabricValue {
        return this;
      }

      [IS_DEEP_FROZEN](
        _subIsDeepFrozen: (value: FabricValue) => boolean,
      ): boolean {
        return true;
      }
    }

    class ProbeTerminalCodec extends BaseTerminalCodec<JsonCodecValue> {
      /** State most recently handed to `decode()`. */
      received: JsonCodecValue = null;

      constructor() {
        super(PROBE_TAG, ProbeInstance);
      }

      encode(_value: FabricValue): JsonCodecValue {
        return PROBE_STATE;
      }

      decode(_typeTag: string, state: JsonCodecValue): FabricValue {
        this.received = state;
        return new ProbeInstance();
      }
    }

    class ProbeNonterminalCodec extends BaseNonterminalCodec {
      /** State most recently handed to `decode()`. */
      received: FabricValue = null;

      constructor() {
        super(PROBE_TAG, ProbeInstance);
      }

      encode(_value: FabricValue): FabricValue {
        return PROBE_STATE;
      }

      decode(_typeTag: string, state: FabricValue): FabricValue {
        this.received = state;
        return new ProbeInstance();
      }
    }

    /** Builds a codec over the default registry plus the given probe. */
    function codecWith(
      probe: ProbeTerminalCodec | ProbeNonterminalCodec,
    ): JsonCodec {
      return new JsonCodec({
        registry: createDefaultJsonRegistry().extend(probe),
      });
    }

    /** The wire tree a probe produces for a `ProbeInstance`. */
    function wireFormatFrom(
      probe: ProbeTerminalCodec | ProbeNonterminalCodec,
    ): JsonCodecValue {
      const encoded = codecWith(probe).encode(new ProbeInstance());
      return JSON.parse(
        encoded.slice(ENCODING_PREFIX.length),
      ) as JsonCodecValue;
    }

    it("writes a terminal codec's state to the wire untouched", () => {
      expect(wireFormatFrom(new ProbeTerminalCodec())).toEqual({
        [`/${PROBE_TAG}`]: { "/Bytes@1": "AQID" },
      });
    });

    it("expands a nonterminal codec's state on the way to the wire", () => {
      // The `/quote` wrapper is the walker's mark: it saw a plain object with
      // a reserved key and escaped it.
      expect(wireFormatFrom(new ProbeNonterminalCodec())).toEqual({
        [`/${PROBE_TAG}`]: { "/quote": { "/Bytes@1": "AQID" } },
      });
    });

    it("hands a terminal codec the wire state exactly as it arrived", () => {
      const probe = new ProbeTerminalCodec();

      codecWith(probe).decode(
        JsonCodec.wrapEncodedValueForTesting(
          JSON.stringify({ [`/${PROBE_TAG}`]: { "/Bytes@1": "AQID" } }),
          true,
        ),
        new TestReconstructionContext(),
      );

      expect(probe.received).toEqual({ "/Bytes@1": "AQID" });
    });

    it("lets a terminal codec judge a state that names a tag", () => {
      // A terminal codec's state is its own business, so a tag appearing
      // inside one is just data. `BigInt@1` sees a non-string and reports by
      // returning a `ProblematicValue` -- which the spec sanctions alongside
      // throwing, `3-json-encoding.md` Section 7 letting a codec do either.
      // Non-lenient, so nothing here is wrapping a throw.
      const jsonCodec = newDefaultJsonCodec();

      const result = jsonCodec.decode(
        JsonCodec.wrapEncodedValueForTesting(
          JSON.stringify({ "/BigInt@1": { "/Undefined@1": "bad" } }),
          true, // Undecodable on purpose; that is what this test is about.
        ),
        new TestReconstructionContext(),
      );

      expect(jsonCodec.lenient).toBe(false);
      expect(result).toBeInstanceOf(ProblematicValue);
      expect((result as unknown as ProblematicValue).wireTypeTag).toBe(
        "BigInt@1",
      );
    });

    it("hands a nonterminal codec state that has been expanded", () => {
      const probe = new ProbeNonterminalCodec();

      codecWith(probe).decode(
        JsonCodec.wrapEncodedValueForTesting(
          JSON.stringify({ [`/${PROBE_TAG}`]: { "/Bytes@1": "AQID" } }),
          true,
        ),
        new TestReconstructionContext(),
      );

      expect(probe.received).toBeInstanceOf(FabricBytes);
    });
  });

  describe("`encodeToBytes()` / `decodeFromBytes()` (bytes entry points)", () => {
    it("returns `Uint8Array` from `encodeToBytes()`", () => {
      const { jsonCodec } = makeTestCodec();
      const result = jsonCodec.encodeToBytes(42);
      expect(result).toBeInstanceOf(Uint8Array);
    });

    it("produces valid JSON bytes from `encodeToBytes()`", () => {
      const { jsonCodec } = makeTestCodec();
      const bytes = jsonCodec.encodeToBytes(
        { a: 1 },
      );
      const json = new TextDecoder().decode(bytes);
      expect(JSON.parse(json)).toEqual({ a: 1 });
    });

    it("decodes a `Uint8Array` through `decodeFromBytes()`", () => {
      const { jsonCodec, runtime } = makeTestCodec();
      const bytes = new TextEncoder().encode(JSON.stringify({ a: 1 }));
      const result = jsonCodec.decodeFromBytes(
        bytes,
        runtime,
      ) as Record<string, FabricValue>;
      expect(result.a).toBe(1);
    });

    it("round-trips through `Uint8Array`", () => {
      const { jsonCodec, runtime } = makeTestCodec();
      const value = {
        name: "test",
        count: 42,
      };
      const bytes = jsonCodec.encodeToBytes(value);
      const result = jsonCodec.decodeFromBytes(
        bytes,
        runtime,
      ) as Record<string, FabricValue>;
      expect(result.name).toBe("test");
      expect(result.count).toBe(42);
    });

    it("round-trips `FabricError` through `Uint8Array`", () => {
      const { jsonCodec, runtime } = makeTestCodec();
      const err = FabricError.fromNativeError(new TypeError("oops"));
      const bytes = jsonCodec.encodeToBytes(err);
      const result = jsonCodec.decodeFromBytes(
        bytes,
        runtime,
      );
      expect(result).toBeInstanceOf(FabricError);
      const se = result as unknown as FabricError;
      expect(se.toNativeValue(true)).toBeInstanceOf(TypeError);
      expect(se.message).toBe("oops");
    });

    it("round-trips `undefined` through `Uint8Array`", () => {
      const { jsonCodec, runtime } = makeTestCodec();
      const bytes = jsonCodec.encodeToBytes(undefined);
      const result = jsonCodec.decodeFromBytes(bytes, runtime);
      expect(result).toBe(undefined);
    });

    it("round-trips complex structure through `Uint8Array`", () => {
      const { jsonCodec, runtime } = makeTestCodec();
      const value = {
        users: [{ name: "Alice" }, { name: "Bob" }],
        error: FabricError.fromNativeError(new Error("fail")),
        nothing: undefined,
      };
      const bytes = jsonCodec.encodeToBytes(value);
      const result = jsonCodec.decodeFromBytes(
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
    // for the standalone-codec and primitive Fabric types, including nesting
    // in arrays and objects. Per-codec encode/decode detail lives in each
    // type's own unit test (e.g. `BigIntCodec.test.ts`,
    // `FabricEpochNsec.test.ts`).

    it("round-trips `undefined` at top level, in arrays, and as object values", () => {
      expect(roundTrip(undefined)).toBe(undefined);

      const arr = [1, undefined, 3];
      const arrResult = roundTrip(arr) as FabricValue[];
      expect(arrResult[0]).toBe(1);
      expect(arrResult[1]).toBe(undefined);
      expect(1 in arrResult).toBe(true); // not a hole
      expect(arrResult[2]).toBe(3);

      const obj = { a: 1, b: undefined };
      const objResult = roundTrip(obj) as Record<string, FabricValue>;
      expect(objResult.a).toBe(1);
      expect(objResult.b).toBe(undefined);
      expect("b" in objResult).toBe(true); // key preserved
    });

    it("round-trips `bigint` at top level, in arrays, and as object values", () => {
      expect(roundTrip(42n)).toBe(42n);

      const arr = [1, 42n, "hello"];
      const arrResult = roundTrip(arr) as FabricValue[];
      expect(arrResult[0]).toBe(1);
      expect(arrResult[1]).toBe(42n);
      expect(arrResult[2]).toBe("hello");

      const obj = { a: 1, b: 42n };
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

      const arr = [1, NaN, -0, Infinity, -Infinity, 2];
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
      };
      const objResult = roundTrip(obj) as Record<string, number>;
      expect(Object.is(objResult.nz, -0)).toBe(true);
      expect(Number.isNaN(objResult.nan)).toBe(true);
      expect(objResult.pinf).toBe(Infinity);
      expect(objResult.ninf).toBe(-Infinity);
    });

    it("round-trips interned symbols at top level, in arrays, and as object values", () => {
      const top = roundTrip(Symbol.for("hello"));
      expect(typeof top).toBe("symbol");
      expect(top).toBe(Symbol.for("hello"));

      const arr = [
        Symbol.for("a"),
        1,
        Symbol.for("b"),
      ];
      const arrResult = roundTrip(arr) as unknown[];
      expect(arrResult[0]).toBe(Symbol.for("a"));
      expect(arrResult[1]).toBe(1);
      expect(arrResult[2]).toBe(Symbol.for("b"));

      const obj = {
        kind: Symbol.for("event"),
        flag: Symbol.for("ready"),
      };
      const objResult = roundTrip(obj) as Record<string, unknown>;
      expect(objResult.kind).toBe(Symbol.for("event"));
      expect(objResult.flag).toBe(Symbol.for("ready"));
    });

    it("loudly fails to encode an unencodable value (unique / uninterned `Symbol`)", () => {
      // `SymbolCodec.canEncode()` returns false for unique symbols (no
      // registry key), so no codec claims them. A default-configured
      // `JsonCodec` must then fail loudly rather than silently flatten the
      // symbol to `{}`.
      const { jsonCodec } = makeTestCodec();
      expect(() => jsonCodec.encode(Symbol("nope"))).toThrow(
        "no applicable codec",
      );
    });

    it("round-trips `FabricEpochNsec` at top level and in nested structures", () => {
      const top = roundTrip(
        new FabricEpochNsec(1704067200000000000n),
      ) as unknown as FabricEpochNsec;
      expect(top).toBeInstanceOf(FabricEpochNsec);
      expect(top.value).toBe(1704067200000000000n);

      const obj = {
        timestamp: new FabricEpochNsec(42000000000n),
        label: "test",
      };
      const result = roundTrip(obj) as Record<string, FabricValue>;
      expect(result.label).toBe("test");
      const ts = result.timestamp as unknown as FabricEpochNsec;
      expect(ts).toBeInstanceOf(FabricEpochNsec);
      expect(ts.value).toBe(42000000000n);
    });

    it("round-trips `FabricEpochDays` at top level and in nested structures", () => {
      const top = roundTrip(
        new FabricEpochDays(19723n),
      ) as unknown as FabricEpochDays;
      expect(top).toBeInstanceOf(FabricEpochDays);
      expect(top.value).toBe(19723n);

      const obj = {
        date: new FabricEpochDays(19723n),
        label: "birthday",
      };
      const result = roundTrip(obj) as Record<string, FabricValue>;
      expect(result.label).toBe("birthday");
      const d = result.date as unknown as FabricEpochDays;
      expect(d).toBeInstanceOf(FabricEpochDays);
      expect(d.value).toBe(19723n);
    });

    it("round-trips `FabricRegExp` at top level and in nested structures", () => {
      const top = roundTrip(
        new FabricRegExp(/ab+c/gi),
      ) as unknown as FabricRegExp;
      expect(top).toBeInstanceOf(FabricRegExp);
      expect(top.source).toBe("ab+c");
      expect(top.flags).toBe("gi");
      expect(top.flavor).toBe("es2025");

      const obj = {
        pattern: new FabricRegExp(/\d+/g),
        label: "digits",
      };
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
      const { jsonCodec } = makeTestCodec();
      expect(() => jsonCodec.encode(new UnregisteredInstance()))
        .toThrow("No codec registered");
    });

    it("throws on a non-plain object with no codec (e.g. a raw `Map`)", () => {
      // A non-plain object that is neither a FabricInstance nor codec-handled
      // must fail loudly, not be mis-encoded as a plain object.
      const { jsonCodec } = makeTestCodec();
      expect(() => jsonCodec.encode(new Map() as unknown as FabricValue))
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
      const arr = [null, "str", true, 42];
      const result = roundTrip(arr) as FabricValue[];
      expect(result[0]).toBe(null);
      expect(result[1]).toBe("str");
      expect(result[2]).toBe(true);
      expect(result[3]).toBe(42);
    });

    it("round-trips nested arrays", () => {
      const arr = [[1, 2], [3, [4, 5]]];
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
      const arr = [1, , 3];
      const result = toWireFormat(arr) as JsonCodecValue[];
      expect(result.length).toBe(3);
      expect(result[0]).toBe(1);
      expect(result[1]).toEqual({ "/hole": 1 });
      expect(result[2]).toBe(3);
    });

    it("round-trips `[1,,3]` preserving holes", () => {
      // deno-lint-ignore no-sparse-arrays
      const arr = [1, , 3];
      const result = roundTrip(arr) as FabricValue[];
      expect(result.length).toBe(3);
      expect(result[0]).toBe(1);
      expect(1 in result).toBe(false); // true hole
      expect(result[2]).toBe(3);
    });

    it("serializes consecutive holes as run-length encoded", () => {
      // deno-lint-ignore no-sparse-arrays
      const arr = [1, , , , 5];
      const result = toWireFormat(arr) as JsonCodecValue[];
      expect(result.length).toBe(3); // [1, {"/hole": 3}, 5]
      expect(result[0]).toBe(1);
      expect(result[1]).toEqual({ "/hole": 3 });
      expect(result[2]).toBe(5);
    });

    it("round-trips `[1,,,,5]`", () => {
      // deno-lint-ignore no-sparse-arrays
      const arr = [1, , , , 5];
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
      const arr = [, , ,];
      const result = roundTrip(arr) as FabricValue[];
      expect(result.length).toBe(3);
      expect(0 in result).toBe(false);
      expect(1 in result).toBe(false);
      expect(2 in result).toBe(false);
    });

    it("round-trips very sparse array", () => {
      const arr = new Array(1000001) as FabricValue[];
      arr[1000000] = "x";
      const result = roundTrip(arr) as FabricValue[];
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
      const result = roundTrip(arr) as FabricValue[];
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
      const result = toWireFormat(arr) as JsonCodecValue[];
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
      const obj = { a: 1, b: "two", c: true };
      const result = roundTrip(obj) as Record<string, FabricValue>;
      expect(result.a).toBe(1);
      expect(result.b).toBe("two");
      expect(result.c).toBe(true);
    });

    it("round-trips nested objects", () => {
      const obj = { outer: { inner: 42 } };
      const result = roundTrip(obj) as Record<
        string,
        Record<string, FabricValue>
      >;
      expect(result.outer!.inner).toBe(42);
    });

    it("preserves `undefined` values in objects", () => {
      const obj = { a: 1, b: undefined };
      const result = roundTrip(obj) as Record<string, FabricValue>;
      expect(result.a).toBe(1);
      expect(result.b).toBe(undefined);
      expect("b" in result).toBe(true);
    });

    describe("key ordering (Section 10)", () => {
      it("emits keys in UTF-8 byte order for a bare plain object", () => {
        const obj = { c: 3, a: 1, b: 2 };
        const wire = toWireFormat(obj) as Record<string, JsonCodecValue>;
        expect(Object.keys(wire)).toEqual(["a", "b", "c"]);
      });

      it("emits keys in UTF-8 byte order regardless of insertion order", () => {
        const obj1 = { x: 1, y: 2, z: 3 };
        const obj2 = { z: 3, x: 1, y: 2 };
        const obj3 = { y: 2, z: 3, x: 1 };
        const jsonCodec = newDefaultJsonCodec();
        expect(jsonCodec.encode(obj1)).toBe(jsonCodec.encode(obj2));
        expect(jsonCodec.encode(obj1)).toBe(jsonCodec.encode(obj3));
      });

      it("sorts keys in nested plain objects", () => {
        const obj = {
          b: { z: 1, a: 2 },
          a: 0,
        };
        const wire = toWireFormat(obj) as Record<string, JsonCodecValue>;
        expect(Object.keys(wire)).toEqual(["a", "b"]);
        const inner = wire.b as Record<string, JsonCodecValue>;
        expect(Object.keys(inner)).toEqual(["a", "z"]);
      });

      it("sorts keys correctly for supplementary characters (UTF-8 vs UTF-16)", () => {
        // U+10000 (UTF-16: D800 DC00; UTF-8: F0 90 80 80) sorts AFTER U+E000
        // (UTF-16: E000; UTF-8: EE 80 80) in UTF-8 byte order, but BEFORE it in
        // JS native (UTF-16) order. The encoder must use UTF-8 order.
        const obj = {
          ["\u{10000}"]: 1,
          [""]: 2,
        };
        const wire = toWireFormat(obj) as Record<string, JsonCodecValue>;
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
        };
        const wire = toWireFormat(obj) as Record<string, JsonCodecValue>;
        expect(Object.keys(wire)).toEqual([...utf8SortedKeysOf(obj as object)]);
      });
    });
  });

  describe("/object escaping", () => {
    describe("/quote: literal-only /-keyed objects", () => {
      it("emits `/quote` for single-key literal `/`-prefixed object", () => {
        const obj = { "/myKey": "val" };
        expect(toWireFormat(obj)).toEqual({ "/quote": { "/myKey": "val" } });
      });

      it('round-trips `{ "/myKey": "val" }`', () => {
        const obj = { "/myKey": "val" };
        const result = roundTrip(obj) as Record<string, FabricValue>;
        expect(result["/myKey"]).toBe("val");
      });

      it('emits `/quote` for `{ "/Link@1": "fake" }` (looks like tag but is literal user data)', () => {
        const obj = { "/Link@1": "fake" };
        expect(toWireFormat(obj)).toEqual({ "/quote": { "/Link@1": "fake" } });
      });

      it('round-trips `{ "/Link@1": "fake" }`', () => {
        const obj = { "/Link@1": "fake" };
        const result = roundTrip(obj) as Record<string, FabricValue>;
        expect(result["/Link@1"]).toBe("fake");
      });

      it("emits `/quote` for multi-key literal object with one `/`-prefixed key", () => {
        const obj = { a: 1, "/b": 2 };
        expect(toWireFormat(obj)).toEqual({ "/quote": { a: 1, "/b": 2 } });
      });

      it("round-trips multi-key literal object with one `/`-prefixed key", () => {
        const obj = { a: 1, "/b": 2 };
        const result = roundTrip(obj) as Record<string, FabricValue>;
        expect(result["a"]).toBe(1);
        expect(result["/b"]).toBe(2);
      });

      it("emits `/quote` for multi-key literal object with multiple `/`-prefixed keys", () => {
        const obj = { "/a": 1, "/b": 2, c: 3 };
        expect(toWireFormat(obj)).toEqual({
          "/quote": { "/a": 1, "/b": 2, c: 3 },
        });
      });

      it("round-trips multi-key literal object with multiple `/`-prefixed keys", () => {
        const obj = { "/a": 1, "/b": 2, c: 3 };
        const result = roundTrip(obj) as Record<string, FabricValue>;
        expect(result["/a"]).toBe(1);
        expect(result["/b"]).toBe(2);
        expect(result["c"]).toBe(3);
      });

      it("emits `/quote` when value is a plain nested object (no `/`-keys inside)", () => {
        const obj = { "/x": { a: 1 } };
        expect(toWireFormat(obj)).toEqual({ "/quote": { "/x": { a: 1 } } });
      });

      it("round-trips `/`-keyed object whose value is a plain nested object", () => {
        const obj = { "/x": { a: 1 } };
        const result = roundTrip(obj) as Record<
          string,
          Record<string, FabricValue>
        >;
        expect(result["/x"]!["a"]).toBe(1);
      });

      it("collapses a `/quote` nested inside an array value into the outer one", () => {
        // The array element is itself a literal `/`-keyed object, so it encodes
        // as its own `/quote`. Wrapping the whole structure has to unquote
        // *through* the array; otherwise the inner wrapper survives into the
        // output, and decoding -- which strips exactly one `/quote` layer --
        // hands back the wrapper instead of the object the caller wrote.
        const obj = { "/outer": [{ "/inner": "val" }] };
        expect(toWireFormat(obj)).toEqual({
          "/quote": { "/outer": [{ "/inner": "val" }] },
        });

        const result = roundTrip(obj) as Record<string, FabricValue[]>;
        expect(result["/outer"]![0]).toEqual({ "/inner": "val" });
      });
    });

    describe("/object: any value requires encoding", () => {
      it("emits `/quote` for doubly-nested `/`-prefixed literal object (whole subtree is literal)", () => {
        const obj = { "/x": { "/y": 123 } };
        const wire = toWireFormat(obj);
        // Whole subtree is deep-literal, so it takes a single `/quote` wrap of
        // the original structure.
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
        const literal = { "/x": { "/y": 123 } };
        expect(toWireFormat(literal)).toEqual({
          "/quote": { "/x": { "/y": 123 } },
        });

        // Fabric type as value: `/object` with the epoch encoded as its tagged
        // form.
        const withEpoch = {
          "/x": new FabricEpochDays(42n),
        };
        expect(toWireFormat(withEpoch)).toEqual({
          "/object": { "/x": { "/EpochDays@1": expect.anything() } },
        });
      });

      it("emits `/object` for `/`-keyed object with `FabricError` value", () => {
        const err = FabricError.fromNativeError(new TypeError("eep!"));
        const obj = { "/x": err };
        const wire = toWireFormat(obj);
        expect(Object.keys(wire as object)).toEqual(["/object"]);
      });

      it("round-trips `FabricError` as value inside `/`-prefixed key object", () => {
        const err = FabricError.fromNativeError(new TypeError("eep!"));
        const obj = { "/x": err };
        const result = roundTrip(obj) as Record<string, FabricValue>;
        expect(result["/x"]).toBeInstanceOf(FabricError);
        expect((result["/x"] as unknown as FabricError).message).toBe(
          "eep!",
        );
      });

      it("round-trips `FabricEpochDays` as value inside `/`-prefixed key object", () => {
        const day = new FabricEpochDays(42n);
        const obj = { "/x": day };
        const result = roundTrip(obj) as Record<string, FabricValue>;
        expect(result["/x"]).toBeInstanceOf(FabricEpochDays);
        expect((result["/x"] as unknown as FabricEpochDays).value).toBe(42n);
      });

      it("emits `/object` for mixed: literal and encoded values", () => {
        const obj = {
          "/a": "literal",
          "/b": FabricError.fromNativeError(new Error("oops")),
        };
        const wire = toWireFormat(obj);
        expect(Object.keys(wire as object)).toEqual(["/object"]);
      });

      it("round-trips mixed literal+encoded `/`-keyed object", () => {
        const obj = {
          "/a": "literal",
          "/b": FabricError.fromNativeError(new Error("oops")),
        };
        const result = roundTrip(obj) as Record<string, FabricValue>;
        expect(result["/a"]).toBe("literal");
        expect(result["/b"]).toBeInstanceOf(FabricError);
      });
    });

    describe("general", () => {
      it("malformed wire: multi-key object with `/`-prefixed key produces `ProblematicValue`", () => {
        // Wire data without a `/quote` or `/object` wrapper: the decoder must
        // not silently round-trip it as a plain object.
        const data = { a: 1, "/b": 2 } as JsonCodecValue;
        const result = fromWireFormat(data);
        expect(result).toBeInstanceOf(ProblematicValue);
      });

      it("malformed wire: bare `/`-keyed object produces `ProblematicValue`", () => {
        // Per spec §9, a single-key object whose key is bare `/` (empty tag
        // after stripping the leading slash) is an encoding error. Decoding
        // must produce a `ProblematicValue`, not an `UnknownValue` with an
        // empty tag.
        const data = { "/": "x" } as JsonCodecValue;
        const result = fromWireFormat(data);
        expect(result).toBeInstanceOf(ProblematicValue);
      });

      it("does not wrap plain object with no `/`-prefixed keys", () => {
        const obj = { a: 1, b: 2 };
        expect(toWireFormat(obj)).toEqual({ a: 1, b: 2 });
      });

      it("deserializes an `/object`-wrapped multi-key object with `/`-prefixed key correctly", () => {
        const data = { "/object": { a: 1, "/b": 2 } } as JsonCodecValue;
        const result = fromWireFormat(data) as Record<string, FabricValue>;
        expect(result["a"]).toBe(1);
        expect(result["/b"]).toBe(2);
      });

      it("round-trips nested object containing `/`-prefixed key", () => {
        const obj = { outer: { "/inner": 1 } };
        const result = roundTrip(obj) as Record<
          string,
          Record<string, FabricValue>
        >;
        expect(result["outer"]!["/inner"]).toBe(1);
      });

      it("single-key `/`-prefixed object still routes through `unwrapTag()` (no regression)", () => {
        // Single-key `/Tag@N` objects are handled by `unwrapTag()` rather than
        // the plain-object path, so they produce an `UnknownValue` for the
        // unrecognized tag and never reach the multi-key guard's
        // `ProblematicValue`.
        const data = { "/Future@7": { id: "x" } } as JsonCodecValue;
        const result = fromWireFormat(data);
        expect(result).toBeInstanceOf(UnknownValue);
        expect((result as unknown as UnknownValue).wireTypeTag).toBe(
          "Future@7",
        );
      });

      it("decoder strips exactly one `/quote` layer — inner `/quote` is preserved literally", () => {
        // The wire form `{"/quote": {"/quote": "x"}}` is a `/quote`-wrapped
        // literal whose content happens to be `{"/quote": "x"}`. Decoding must
        // return that inner object as a frozen plain object, and must _not_
        // recurse into it and return just `x`.
        const wire = { "/quote": { "/quote": "x" } } as JsonCodecValue;
        const result = fromWireFormat(wire) as Record<string, FabricValue>;
        expect(result["/quote"]).toBe("x");
      });

      it("round-trips object whose value is a `/quote`-keyed literal", () => {
        // In `{"/x": {"/quote": "inner"}}`, the value at `/x` is user data
        // that happens to have a `/quote` key. It must survive encode and
        // decode intact.
        const obj = { "/x": { "/quote": "inner" } };
        const result = roundTrip(obj) as Record<
          string,
          Record<string, FabricValue>
        >;
        expect(result["/x"]!["/quote"]).toBe("inner");
      });
    });

    describe("property names this runtime reserves", () => {
      it("produces a `ProblematicValue` for a reserved key", () => {
        // The decoder is a boundary where external bytes enter, and the
        // assignment it rebuilds records with cannot create these names: in a
        // realm that keeps the `__proto__` accessor, the key would be lost and
        // the result's prototype repointed to whatever the bytes carried.
        // Nothing this implementation writes can contain one, so bytes that do
        // are reported rather than reconstructed.
        //
        // The keys are computed on purpose: in an object literal a bare or
        // quoted `__proto__:` sets the prototype instead of creating a
        // property, so a literal cannot express this wire shape at all.
        // `JSON.parse()`, which is how such bytes actually arrive, does create
        // the own property.
        expect(fromWireFormat({ ["__proto__"]: { hostile: true }, a: 1 }))
          .toBeInstanceOf(ProblematicValue);
        expect(fromWireFormat({ ["constructor"]: "c" }))
          .toBeInstanceOf(ProblematicValue);
      });

      it("produces a `ProblematicValue` for a reserved key nested in the graph", () => {
        const result = fromWireFormat({
          nested: { ["__proto__"]: 1 },
        }) as Record<string, unknown>;
        expect(result.nested).toBeInstanceOf(ProblematicValue);
        expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
      });

      it("produces a `ProblematicValue` for a reserved key inside `/object`", () => {
        expect(fromWireFormat({ "/object": { ["__proto__"]: 1 } }))
          .toBeInstanceOf(ProblematicValue);
      });

      it("leaves `Object.prototype` untouched where the accessor is standard", () => {
        // The refusal above is checked in Deno, which replaces
        // `Object.prototype.__proto__` with a setter that defines an own
        // property -- so a decoder that assigned the key would look correct
        // here no matter what. This installs the standard accessor, which is
        // what browsers have and what this code also runs under, and pins the
        // outcome the refusal exists to produce: nothing reconstructed, and no
        // prototype repointed.
        const saved = Object.getOwnPropertyDescriptor(
          Object.prototype,
          "__proto__",
        );
        try {
          Object.defineProperty(Object.prototype, "__proto__", {
            configurable: true,
            get(this: object) {
              return Object.getPrototypeOf(this);
            },
            set(this: object, v: unknown) {
              // Spec-faithful: a no-op unless the value is an object or `null`.
              if ((typeof v === "object") || (typeof v === "function")) {
                Object.setPrototypeOf(this, v as object | null);
              }
            },
          });

          const hostile = { hostile: true };
          expect(fromWireFormat({ ["__proto__"]: hostile, a: 1 }))
            .toBeInstanceOf(ProblematicValue);

          const nested = fromWireFormat({
            deep: { ["__proto__"]: hostile },
          }) as Record<string, unknown>;
          expect(nested.deep).toBeInstanceOf(ProblematicValue);
          expect(Object.getPrototypeOf(nested)).toBe(Object.prototype);

          // The payload reached nobody: not the decoded records, and not the
          // shared prototype every object in the process answers through.
          expect(
            (Object.prototype as Record<string, unknown>).hostile,
          ).toBe(undefined);
          expect(({} as Record<string, unknown>).hostile).toBe(undefined);
        } finally {
          if (saved === undefined) {
            delete (Object.prototype as Record<string, unknown>)["__proto__"];
          } else {
            Object.defineProperty(Object.prototype, "__proto__", saved);
          }
        }
      });
    });
  });

  describe("/quote handling", () => {
    it("deserializes `/quote` as literal (no inner deserialization)", () => {
      const data = {
        "/quote": { "/Link@1": { id: "abc" } },
      } as JsonCodecValue;
      const result = fromWireFormat(data);
      // The inner structure is returned as-is, not reconstructed.
      const obj = result as Record<string, unknown>;
      expect(obj["/Link@1"]).toEqual({ id: "abc" });
    });

    it("deep-freezes `/quote` result objects", () => {
      const data = {
        "/quote": { "/Link@1": { id: "abc" } },
      } as JsonCodecValue;
      const result = fromWireFormat(data) as Record<string, unknown>;
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result["/Link@1"])).toBe(true);
    });

    it("deep-freezes `/quote` result arrays", () => {
      const data = {
        "/quote": [1, { nested: "obj" }, [2, 3]],
      } as JsonCodecValue;
      const result = fromWireFormat(data) as unknown[];
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result[1])).toBe(true);
      expect(Object.isFrozen(result[2])).toBe(true);
    });

    it("throws on mutation of a `/quote` result", () => {
      const data = {
        "/quote": { key: "val" },
      } as JsonCodecValue;
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
      } as JsonCodecValue;
      const result = fromWireFormat(data);
      expect(result).toBeInstanceOf(UnknownValue);
      const unknown = result as unknown as UnknownValue;
      expect(unknown.wireTypeTag).toBe("FutureType@2");
      expect(unknown.state).toEqual({ some: "data" });
    });

    it("preserves the `UnknownValue` tag in wire format via `encode()`", () => {
      // Encoding an UnknownValue produces the original tagged form.
      const us = new UnknownValue("FutureType@2", { some: "data" });
      const wireFormat = toWireFormat(us);
      expect(wireFormat).toEqual({
        "/FutureType@2": { some: "data" },
      });
    });

    it("round-trips `UnknownValue` through encode/decode", () => {
      const us = new UnknownValue("FutureType@2", { some: "data" });
      const result = roundTrip(us);
      expect(result).toBeInstanceOf(UnknownValue);
      const unknown = result as unknown as UnknownValue;
      expect(unknown.wireTypeTag).toBe("FutureType@2");
      expect(unknown.state).toEqual({ some: "data" });
    });

    it("converts a `/hole` outside array context to `UnknownValue`", () => {
      const data = { "/hole": 5 } as JsonCodecValue;
      const result = fromWireFormat(data);
      expect(result).toBeInstanceOf(UnknownValue);
      const unknown = result as unknown as UnknownValue;
      expect(unknown.wireTypeTag).toBe("hole");
      expect(unknown.state).toBe(5);
    });
  });

  describe("circular reference detection", () => {
    it("throws on object referencing itself", () => {
      const { jsonCodec } = makeTestCodec();
      const obj: Record<string, unknown> = {};
      obj.self = obj;
      expect(() => jsonCodec.encode(obj as FabricValue)).toThrow(
        "Circular reference",
      );
    });

    it("throws on array referencing itself", () => {
      const { jsonCodec } = makeTestCodec();
      const arr: unknown[] = [];
      arr.push(arr);
      expect(() => jsonCodec.encode(arr as FabricValue)).toThrow(
        "Circular reference",
      );
    });

    it("throws on indirect circular reference (A -> B -> A)", () => {
      const { jsonCodec } = makeTestCodec();
      const a: Record<string, unknown> = {};
      const b: Record<string, unknown> = {};
      a.ref = b;
      b.ref = a;
      expect(() => jsonCodec.encode(a as FabricValue)).toThrow(
        "Circular reference",
      );
    });

    it("throws on `FabricInstance` whose state references itself", () => {
      const { jsonCodec } = makeTestCodec();
      // Create an instance with a circular reference in its state.
      const state = { eek: [] as FabricValue[] };
      state.eek.push(state);

      const us = new UnknownValue("Test@1", state);
      expect(() => jsonCodec.encode(us))
        .toThrow(
          "Circular reference",
        );
    });

    it("duplicates a shared reference into equal subtrees", () => {
      const shared = { val: 42 };
      const obj = { a: shared, b: shared };
      // Should not throw -- shared references are fine, and only cycles are
      // rejected.
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
      const wireFormat = toWireFormat(prob);
      expect(wireFormat).toEqual({ "/BadType@1": "original data" });
    });

    it("lenient mode wraps failed handler reconstruction", () => {
      const jsonCodec = newDefaultJsonCodec({ lenient: true });
      const runtime = new TestReconstructionContext();

      // BigInt@1 with a non-string state produces ProblematicValue
      // in lenient mode because the handler validates the state type.
      const data = { "/BigInt@1": 42 } as JsonCodecValue;
      const result = jsonCodec.decode(
        JsonCodec.wrapEncodedValueForTesting(JSON.stringify(data)),
        runtime,
      );
      expect(result).toBeInstanceOf(ProblematicValue);
      const prob = result as unknown as ProblematicValue;
      expect(prob.wireTypeTag).toBe("BigInt@1");
    });

    it("wraps a throw from a terminal codec, over the wire-form state", () => {
      // `Undefined@1` is terminal and throws outright, so it reaches the
      // lenient catch from the terminal arm. A codec that reports a bad state
      // by returning a `ProblematicValue` never reaches that catch at all.
      //
      // What the state assertion pins is what the *report* carries, which is
      // the wire form. That the *codec* is handed the wire form is a separate
      // fact, pinned separately above.
      const jsonCodec = newDefaultJsonCodec({ lenient: true });
      const data = { "/Undefined@1": { "/Bytes@1": "AQID" } } as JsonCodecValue;

      const result = jsonCodec.decode(
        JsonCodec.wrapEncodedValueForTesting(
          JSON.stringify(data),
          true, // Undecodable on purpose; that is what this test is about.
        ),
        new TestReconstructionContext(),
      );

      expect(result).toBeInstanceOf(ProblematicValue);
      const prob = result as unknown as ProblematicValue;
      expect(prob.wireTypeTag).toBe("Undefined@1");
      expect(prob.state).toEqual({ "/Bytes@1": "AQID" });
    });

    it("lenient mode wraps failed class-registry reconstruction", () => {
      const jsonCodec = newDefaultJsonCodec({ lenient: true });
      const runtime = new TestReconstructionContext();

      // Map@1's codec always throws on decode ("not yet implemented"),
      // triggering lenient wrapping.
      const data = {
        "/Map@1": [["key", "value"]],
      } as JsonCodecValue;
      const result = jsonCodec.decode(
        JsonCodec.wrapEncodedValueForTesting(
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
        [1, 2, 3] as JsonCodecValue,
      );
      expect(Object.isFrozen(result)).toBe(true);
    });

    it("deserialized objects are frozen", () => {
      const result = fromWireFormat(
        { a: 1 } as JsonCodecValue,
      ) as Record<string, FabricValue>;
      expect(Object.isFrozen(result)).toBe(true);
    });

    it("mutation of deserialized array throws", () => {
      const result = fromWireFormat(
        [1, 2, 3] as JsonCodecValue,
      );
      expect(() => {
        (result as unknown as number[])[0] = 99;
      }).toThrow();
    });

    it("mutation of deserialized object throws", () => {
      const result = fromWireFormat(
        { a: 1 } as JsonCodecValue,
      ) as Record<string, FabricValue>;
      expect(() => {
        (result as Record<string, unknown>).a = 99;
      }).toThrow();
    });

    it("nested deserialized objects are frozen", () => {
      const result = fromWireFormat(
        { inner: { val: 42 } } as JsonCodecValue,
      ) as Record<string, Record<string, FabricValue>>;
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.inner)).toBe(true);
    });

    it("deserialized `/object`-unwrapped objects are frozen", () => {
      const data = { "/object": { "/myKey": "val" } } as JsonCodecValue;
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
        { "/EpochNsec@1": "AA" } as JsonCodecValue,
      );
      expect(result).toBeInstanceOf(FabricEpochNsec);
      expect(isDeepFrozen(result)).toBe(true);
    });

    it("lenient-mode `ProblematicValue` from a codec is deep-frozen", () => {
      // `/BigInt@1` with non-string state fails codec validation; the
      // lenient catch produces a ProblematicValue -- still a codec-arm return,
      // so the contract deep-freezes it (not a crash: it is the value
      // lenient mode produces precisely to avoid crashing).
      const jsonCodec = newDefaultJsonCodec({ lenient: true });
      const runtime = new TestReconstructionContext();
      const result = jsonCodec.decode(
        JsonCodec.wrapEncodedValueForTesting(
          JSON.stringify({ "/BigInt@1": 42 }),
        ),
        runtime,
      );
      expect(result).toBeInstanceOf(ProblematicValue);
      expect(isDeepFrozen(result)).toBe(true);
    });

    it("codec round-trip yields a deep-frozen result", () => {
      const result = roundTrip(
        new FabricEpochNsec(1704067200000000000n),
      );
      expect(result).toBeInstanceOf(FabricEpochNsec);
      expect(isDeepFrozen(result)).toBe(true);
    });
  });

  describe("deep-frozen wire invariant (`decode()`/`decodeFromBytes()` symmetry)", () => {
    // Every `JsonCodecValue` handed to `deserialize()` must be deep-frozen, so
    // both `deserialize()` entry points must produce equally deep-frozen
    // results: `decode()` (string path) and `decodeFromBytes()` (bytes path
    // via `fromBytes()`).
    //
    // The `/quote` arm does `return state`, handing back a node lifted straight
    // out of the parsed codec-value tree (see `unwrapTag()`'s contract). That
    // shortcut is sound only because the parsed tree is deep-frozen at
    // construction, which both construction sites must therefore do. These
    // cases pin the symmetry, so that dropping the guarantee at either one
    // cannot pass unnoticed.

    /**
     * Decodes the same codec-value tree both ways. The string path needs the
     * encoding prefix; the bytes path does not (it does not strip one).
     */
    function decodeBothPaths(
      data: JsonCodecValue,
    ): { viaString: FabricValue; viaBytes: FabricValue } {
      const { jsonCodec, runtime } = makeTestCodec();
      const json = JSON.stringify(data);
      const viaString = jsonCodec.decode(
        JsonCodec.wrapEncodedValueForTesting(json),
        runtime,
      );
      const viaBytes = jsonCodec.decodeFromBytes(
        new TextEncoder().encode(json),
        runtime,
      );
      return { viaString, viaBytes };
    }

    const cases: Array<[string, JsonCodecValue]> = [
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
      } as JsonCodecValue;
      const { jsonCodec, runtime } = makeTestCodec();
      const result = jsonCodec.decode(
        JsonCodec.wrapEncodedValueForTesting(JSON.stringify(wire)),
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
      } as JsonCodecValue;
      const { jsonCodec, runtime } = makeTestCodec();
      const result = jsonCodec.decodeFromBytes(
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
      };
      const result = roundTrip(value);
      expect(isDeepFrozen(result)).toBe(true);
      expect(result).toEqual({ "/a": 1, "/b": { plain: [1, 2] } });
    });
  });

  describe("JsonCodec", () => {
    it("`encode()` returns a prefixed JSON string", () => {
      const jsonCodec = newDefaultJsonCodec();
      const result = jsonCodec.encode(42);
      expect(typeof result).toBe("string");
      expect(JsonCodec.seemsLikeEncoded(result)).toBe(true);
      expect(
        JSON.parse(JsonCodec.unwrapEncodedValueForTesting(result)),
      ).toBe(42);
    });

    it("`decode()` parses a prefixed JSON string back to a value", () => {
      const jsonCodec = newDefaultJsonCodec();
      const runtime = new TestReconstructionContext();
      const result = jsonCodec.decode(
        JsonCodec.wrapEncodedValueForTesting("42"),
        runtime,
      );
      expect(result).toBe(42);
    });

    it("`encode()`/`decode()` round-trip for tagged types", () => {
      const jsonCodec = newDefaultJsonCodec();
      const runtime = new TestReconstructionContext();
      const se = FabricError.fromNativeError(new Error("test"));
      const encoded = jsonCodec.encode(se);
      const decoded = jsonCodec.decode(encoded, runtime);
      expect(decoded).toBeInstanceOf(FabricError);
      expect((decoded as unknown as FabricError).message).toBe("test");
    });

    it("`encodeToBytes()`/`decodeFromBytes()` round-trip", () => {
      const jsonCodec = newDefaultJsonCodec();
      const runtime = new TestReconstructionContext();
      const data = {
        name: "test",
        error: FabricError.fromNativeError(new Error("fail")),
      };
      const bytes = jsonCodec.encodeToBytes(data);
      expect(bytes).toBeInstanceOf(Uint8Array);
      const decoded = jsonCodec.decodeFromBytes(bytes, runtime) as Record<
        string,
        FabricValue
      >;
      expect(decoded.name).toBe("test");
      expect(decoded.error).toBeInstanceOf(FabricError);
    });

    it("`.lenient` defaults to `false`", () => {
      const jsonCodec = newDefaultJsonCodec();
      expect(jsonCodec.lenient).toBe(false);
    });

    it("`.lenient` can be set to `true`", () => {
      const jsonCodec = newDefaultJsonCodec({ lenient: true });
      expect(jsonCodec.lenient).toBe(true);
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
      };

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
      const arr = [1, se, 3];
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
      };
      const result = roundTrip(obj) as Record<string, FabricValue>;
      expect(result.error).toBeInstanceOf(FabricError);
      expect(
        (result.error as unknown as FabricError).message,
      ).toBe("fail");
      expect(result.code).toBe(500);
    });

    it("encodes a `FabricError` as `/Error@1` carrying `type` and `message`", () => {
      // The `@1` in the tag makes this a versioned wire surface, so the exact
      // shape asserted below is the contract rather than an implementation
      // detail.
      const se = FabricError.fromNativeError(new TypeError("compat test"));
      const serialized = toWireFormat(
        se,
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
        const encoded = newDefaultJsonCodec().encode(42);
        expect(JsonCodec.unwrapEncodedValueForTesting(encoded))
          .toBe("42");
      });

      it("round-trips with `wrapEncodedValueForTesting()`", () => {
        const encoded = newDefaultJsonCodec().encode(
          { b: 1, a: [true, null] },
        );
        const json = JsonCodec.unwrapEncodedValueForTesting(encoded);
        expect(JsonCodec.wrapEncodedValueForTesting(json))
          .toBe(encoded);
      });

      it("preserves a value plain JSON could not carry", () => {
        // The case that motivates having a golden format at all: these survive
        // the trip only as tagged forms.
        const encoded = newDefaultJsonCodec().encode(
          { z: -0, n: NaN, i: -Infinity },
        );
        const rebuilt = newDefaultJsonCodec().decode(
          JsonCodec.wrapEncodedValueForTesting(
            JsonCodec.unwrapEncodedValueForTesting(encoded),
          ),
          new TestReconstructionContext(),
        ) as Record<string, number>;
        expect(Object.is(rebuilt.z, -0)).toBe(true);
        expect(Number.isNaN(rebuilt.n)).toBe(true);
        expect(rebuilt.i).toBe(-Infinity);
      });

      it("throws given a string carrying no tag", () => {
        // The whole point of the tag: untagged JSON is not one of ours, however
        // well-formed it happens to be.
        expect(() => JsonCodec.unwrapEncodedValueForTesting("42"))
          .toThrow();
      });

      it("throws given an empty string", () => {
        expect(() => JsonCodec.unwrapEncodedValueForTesting(""))
          .toThrow();
      });

      it("throws given a tag with nothing after it", () => {
        // `seemsLikeEncoded()` accepts this, so only the throwaway decode
        // catches it.
        expect(() => JsonCodec.unwrapEncodedValueForTesting(ENCODING_PREFIX))
          .toThrow();
      });

      it("throws given a tag followed by text that will not parse", () => {
        expect(() =>
          JsonCodec.unwrapEncodedValueForTesting(
            `${ENCODING_PREFIX}{nope`,
          )
        ).toThrow();
      });
    });

    describe("`wrapEncodedValueForTesting()`", () => {
      it("produces something the codec accepts", () => {
        const { runtime } = makeTestCodec();
        const encoded = JsonCodec.wrapEncodedValueForTesting(
          JSON.stringify({ a: 1 }),
        );
        expect(JsonCodec.seemsLikeEncoded(encoded)).toBe(true);
        expect(newDefaultJsonCodec().decode(encoded, runtime))
          .toEqual({ a: 1 });
      });

      it("returns the body unaltered beneath the tag", () => {
        const body = JSON.stringify({ b: 2, a: 1 });
        expect(JsonCodec.wrapEncodedValueForTesting(body))
          .toBe(`${ENCODING_PREFIX}${body}`);
      });

      it("decodes a pretty-printed body", () => {
        // The re-encoded form is not compared against the input, so whitespace
        // is immaterial -- which is what lets a golden file be readable.
        const pretty = JSON.stringify({ a: 1, b: [2, 3] }, null, 2);
        const encoded = JsonCodec.wrapEncodedValueForTesting(pretty);
        const { runtime } = makeTestCodec();
        expect(newDefaultJsonCodec().decode(encoded, runtime))
          .toEqual({ a: 1, b: [2, 3] });
      });

      it("throws given text that will not parse", () => {
        expect(() => JsonCodec.wrapEncodedValueForTesting("{nope"))
          .toThrow();
      });

      it("throws given an empty body", () => {
        expect(() => JsonCodec.wrapEncodedValueForTesting(""))
          .toThrow();
      });

      it("throws given an already-tagged string", () => {
        // Double-tagging is a mistake worth catching: the tag is not part of
        // the JSON, so the result would not parse.
        const encoded = newDefaultJsonCodec().encode(42);
        expect(() => JsonCodec.wrapEncodedValueForTesting(encoded))
          .toThrow();
      });
    });

    describe("`isMalformed`", () => {
      // `Map@1`'s codec always throws on decode, so it stands in for any
      // payload the codec cannot reconstruct. Reaching that codec takes a
      // registry that has it: against the format-only default, `Map@1` is
      // merely an unrecognized tag and decodes to an `UnknownValue`.
      const undecodable = JSON.stringify({ "/Map@1": [["key", "value"]] });

      it("refuses a payload undecodable by the given registry's codecs", () => {
        expect(() =>
          JsonCodec.wrapEncodedValueForTesting(
            undecodable,
            false,
            createDefaultJsonRegistry(),
          )
        ).toThrow();
      });

      it("wraps a tag no registered codec claims", () => {
        expect(JsonCodec.wrapEncodedValueForTesting(undecodable))
          .toBe(`${ENCODING_PREFIX}${undecodable}`);
      });

      it("wraps an undecodable payload when told it is deliberate", () => {
        expect(
          JsonCodec.wrapEncodedValueForTesting(undecodable, true),
        ).toBe(`${ENCODING_PREFIX}${undecodable}`);
      });

      it("unwraps an undecodable payload when told it is deliberate", () => {
        expect(
          JsonCodec.unwrapEncodedValueForTesting(
            `${ENCODING_PREFIX}${undecodable}`,
            true,
          ),
        ).toBe(undecodable);
      });

      it("wraps text that will not parse at all", () => {
        // Malformed means malformed: the flag is a caller saying the payload is
        // broken on purpose, so nothing is checked and the tag simply goes on
        // the front.
        expect(JsonCodec.wrapEncodedValueForTesting("{nope", true))
          .toBe(`${ENCODING_PREFIX}{nope`);
      });

      it("unwraps text that will not parse at all", () => {
        expect(
          JsonCodec.unwrapEncodedValueForTesting(
            `${ENCODING_PREFIX}{nope`,
            true,
          ),
        ).toBe("{nope");
      });

      it("still requires the tag on unwrap, however deliberate", () => {
        // Not a judgment about the payload: stripping a prefix that is not
        // there yields nonsense, not the body.
        expect(() => JsonCodec.unwrapEncodedValueForTesting("42", true))
          .toThrow();
      });
    });
  });
});
