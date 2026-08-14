// Tests for the realm-crossing wire format: the engine, the entry points over
// it, and the kind each participating class declares.
//
// The round trips go through a real `Worker`, not `structuredClone()` in this
// realm. Cloning runs the same serialization algorithm, so it would prove the
// walk is invertible -- but this format exists to carry values to another
// realm, and only the far side can show that what arrives there is a live
// instance of the right class rather than a shape that happens to match.

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { defer } from "@commonfabric/utils/defer";

import type { FabricValue } from "@/interface.ts";
import { REALM_CODEC } from "@/codec-interface/interface.ts";
import { BaseTerminalCodec } from "@/codec-interface/index.ts";
import { UnknownValue } from "@/codec-common/UnknownValue.ts";
import { ProblematicValue } from "@/codec-common/ProblematicValue.ts";
import { ProblematicStateError } from "@/codec-common/ProblematicStateError.ts";
import { EMPTY_RECONSTRUCTION_CONTEXT } from "@/codec-interface/EmptyReconstructionContext.ts";
import {
  type RealmCodecValue,
  type RealmTaggedValue,
} from "@/codec-realm/interface.ts";
import {
  fabricFromRealmValue,
  newDefaultRealmCodecEngine,
  realmFromFabricValue,
} from "@/codecs.ts";
import { FabricBytes } from "@/fabric-primitives/FabricBytes.ts";
import { FabricEpochDays } from "@/fabric-primitives/FabricEpochDays.ts";
import { FabricEpochNsec } from "@/fabric-primitives/FabricEpochNsec.ts";
import { FabricHash } from "@/fabric-primitives/FabricHash.ts";
import { FabricRegExp } from "@/fabric-primitives/FabricRegExp.ts";
import { FabricError } from "@/fabric-instances/FabricError.ts";
import type { EchoReport } from "./realm-echo-worker.ts";

/**
 * Encodes `value`, sends it to a real `Worker`, and returns what that worker
 * made of it. Waits on the worker's own message rather than polling, and
 * terminates it however the wait ends.
 */
async function crossRealm(value: FabricValue): Promise<EchoReport> {
  const worker = new Worker(
    new URL("./realm-echo-worker.ts", import.meta.url).href,
    { type: "module" },
  );
  const report = defer<EchoReport>();

  worker.onmessage = (ev) => report.resolve(ev.data as EchoReport);
  worker.onerror = (ev) => report.reject(new Error(ev.message));

  try {
    worker.postMessage(realmFromFabricValue(value));
    return await report.promise;
  } finally {
    worker.terminate();
  }
}

describe("RealmCodecEngine", () => {
  describe("encode()", () => {
    it("emits the walked tree itself, with no envelope around it", () => {
      const value = { a: 1 };

      // Not merely equal: the same object. An envelope would make that
      // impossible for any value at all, however little of it needed
      // encoding.
      expect(realmFromFabricValue(value)).toBe(value);
    });

    it("returns a payload holding no encodable value by identity", () => {
      const value = { a: 1, b: { c: "two" }, d: [3, 4] };

      // Copy-on-write: nothing here needs encoding, so nothing is rebuilt and
      // the transport does the only copying.
      expect(realmFromFabricValue(value)).toBe(value);
    });

    it("rebuilds only the containers on the path to an encoded value", () => {
      const untouched = { c: "two" };
      const value = { a: new FabricBytes(new Uint8Array([1])), b: untouched };
      const payload = (realmFromFabricValue(value)) as Record<
        string,
        RealmCodecValue
      >;

      expect(payload).not.toBe(value);
      expect(payload.b).toBe(untouched);
    });

    it("leaves a `/`-prefixed key untouched, this format reserving no key", () => {
      const value = { "/quote": "not a tag here", "/Bytes@1": "nor this" };

      expect(realmFromFabricValue(value)).toBe(value);
    });

    it("encodes a `FabricBytes` to a transferable `ArrayBuffer`", () => {
      const payload = realmFromFabricValue(
        new FabricBytes(new Uint8Array([1, 2, 250])),
      );
      const state = (payload as RealmTaggedValue).get("Bytes@1");

      // An `ArrayBuffer` rather than a view onto one, that being the form
      // `postMessage()` can transfer.
      expect(state).toBeInstanceOf(ArrayBuffer);
      expect([...new Uint8Array(state as ArrayBuffer)]).toEqual([1, 2, 250]);
    });

    it("encodes a `FabricBytes` to a buffer covering exactly its bytes", () => {
      // A transfer hands over the whole buffer, so a state covering more than
      // the value would cede bytes that are not part of it.
      const payload = realmFromFabricValue(
        new FabricBytes(new Uint8Array([1, 2, 250])),
      );
      const state = (payload as RealmTaggedValue)
        .get("Bytes@1") as ArrayBuffer;

      expect(state.byteLength).toBe(3);
    });

    it("encodes a `FabricEpochNsec` to a `bigint`", () => {
      const payload = realmFromFabricValue(
        new FabricEpochNsec(1234567890123456789n),
      );

      expect((payload as RealmTaggedValue).get("EpochNsec@1")).toBe(
        1234567890123456789n,
      );
    });

    it("encodes an interned symbol to its registry key", () => {
      // Cloning refuses every symbol, so this is the one JavaScript primitive
      // the format has to spell out at all.
      const payload = realmFromFabricValue(Symbol.for("k") as FabricValue);

      expect((payload as RealmTaggedValue).get("Symbol@1")).toBe("k");
    });

    it("refuses a unique symbol rather than interning one", () => {
      // A unique symbol has no key to carry, so there is nothing to encode
      // that would decode back to it. Coercing one to a registry symbol would
      // hand the far side a different symbol wearing its description.
      expect(() => realmFromFabricValue(Symbol("d") as FabricValue))
        .toThrow(/no applicable codec/);
      expect(() => realmFromFabricValue(Symbol() as FabricValue))
        .toThrow(/no applicable codec/);
    });

    it("does not hand out the bytes an encoded `FabricBytes` holds", () => {
      const bytes = new FabricBytes(new Uint8Array([1, 2, 3]));
      const state = new Uint8Array(
        ((realmFromFabricValue(bytes)) as RealmTaggedValue)
          .get("Bytes@1") as ArrayBuffer,
      );

      state[0] = 99;
      expect([...bytes.slice()]).toEqual([1, 2, 3]);
    });

    it("throws given a circular reference", () => {
      const value: Record<string, FabricValue> = { a: 1 };
      value.self = value;

      expect(() => realmFromFabricValue(value)).toThrow(/Circular reference/);
    });

    it("throws given an object with a key this runtime reserves", () => {
      const value = Object.defineProperty({}, "__proto__", {
        value: 1,
        enumerable: true,
        configurable: true,
        writable: true,
      });

      expect(() => realmFromFabricValue(value)).toThrow(/reserves/);
    });
  });

  describe("decode()", () => {
    it("returns a plain payload as it stands", () => {
      // With no envelope to strip, an ordinary value decodes to itself.
      expect(fabricFromRealmValue({ a: 1 })).toEqual({ a: 1 });
    });

    it("refuses a form this format never emits", () => {
      // Cloning carries a `Date`; this format has no codec that produces one,
      // so it can only have come from something other than an `encode()`.
      expect(() => fabricFromRealmValue(new Date() as never)).toThrow(
        /not a form this format emits/,
      );
    });

    it("refuses a multi-entry `Map`, the tagged form being single-entry", () => {
      expect(() => fabricFromRealmValue(new Map([["a", 1], ["b", 2]]) as never))
        .toThrow(/not a form this format emits/);
    });

    it("refuses a single-entry `Map` whose key is not a tag", () => {
      // Cloning carries a `Map` keyed by anything at all, so this format can
      // find a non-string in tag position where JSON never can. The engine
      // hands the key over as it found it, and the shared tag check judges
      // it, so what is refused here is refused the same way under any format.
      expect(() => fabricFromRealmValue(new Map([[42, "x"]]) as never))
        .toThrow(/malformed tag/);
      expect(() => fabricFromRealmValue(new Map([[Symbol("s"), "x"]]) as never))
        .toThrow(/malformed tag/);
      expect(() => fabricFromRealmValue(new Map([["hole", "x"]]) as never))
        .toThrow(/malformed tag/);
    });

    it("keeps the offending key in a lenient refusal", () => {
      const engine = newDefaultRealmCodecEngine({ lenient: true });
      const decoded = engine.decode(
        new Map([[42, "x"]]) as never,
        EMPTY_RECONSTRUCTION_CONTEXT,
      ) as ProblematicValue;

      expect(decoded).toBeInstanceOf(ProblematicValue);
      expect(decoded.error).toMatch(/malformed tag/);
      // The key itself, rendered: a report of a bad tag that did not say
      // which tag would be most of the way to useless.
      expect(decoded.wireTypeTag).toBe("42");
    });

    it("raises a codec's rejection as a `ProblematicStateError`", () => {
      // A codec's own rejection rather than the walk's: the tag is claimed,
      // and `FabricBytes` wants an `ArrayBuffer` where this carries a string.
      // The default engine is strict, so this throws.
      try {
        fabricFromRealmValue(new Map([["Bytes@1", "nope"]]));
        throw new Error("Should have thrown.");
      } catch (e) {
        expect(e).toBeInstanceOf(ProblematicStateError);
        expect((e as ProblematicStateError).wireTypeTag).toBe("Bytes@1");
        expect((e as ProblematicStateError).state).toBe("nope");

        // The tag rides on the error, so a codec that also named it in its
        // message would say it twice. These do not.
        expect((e as Error).message).not.toMatch(/Bytes@1/);
      }
    });

    it("returns that same rejection as a `ProblematicValue` when lenient", () => {
      // Every realm codec now reports by returning one, as its JSON
      // counterpart does; `lenient` is what decides which a caller sees.
      const engine = newDefaultRealmCodecEngine({ lenient: true });
      const decoded = engine.decode(
        new Map([["Bytes@1", "nope"]]),
        EMPTY_RECONSTRUCTION_CONTEXT,
      );

      expect(decoded).toBeInstanceOf(ProblematicValue);
      expect((decoded as ProblematicValue).wireTypeTag).toBe("Bytes@1");
      expect((decoded as ProblematicValue).error).toMatch(/ArrayBuffer/);
    });

    it("raises a symbol's bad state without naming the tag twice", () => {
      // `SymbolCodec` reports by returning a `ProblematicValue`, as the rest
      // of this format's codecs do. The tag rides on the error whichever way a
      // codec reports, so one throwing an `Error` of its own that named the
      // tag would have the message say it a second time.
      try {
        fabricFromRealmValue(new Map([["Symbol@1", 42]]));
        throw new Error("Should have thrown.");
      } catch (e) {
        expect(e).toBeInstanceOf(ProblematicStateError);
        expect((e as ProblematicStateError).wireTypeTag).toBe("Symbol@1");
        expect((e as ProblematicStateError).state).toBe(42);
        expect((e as Error).message).not.toMatch(/Symbol@1/);
      }
    });

    it("wraps an unclaimed tag in an `UnknownValue` rather than refusing", () => {
      // A single-entry `Map` IS the tagged form, so this is a well-formed
      // value carrying a tag no codec claims -- a different thing from a
      // malformation.
      const decoded = fabricFromRealmValue(new Map([["nope@1", 1]]));

      expect(decoded).toBeInstanceOf(UnknownValue);
      expect((decoded as UnknownValue).wireTypeTag).toBe("nope@1");
    });

    it("returns an object needing no decoding by identity", () => {
      const data = { a: 1, b: { c: "two" }, d: [3, 4] };

      // Copy-on-write on the decode side, as on the encode side. Each format
      // writes its own `decodeValue()`, so this is not covered by any test of
      // the shared engine.
      expect(fabricFromRealmValue(data)).toBe(data);
    });

    it("returns an array needing no decoding by identity", () => {
      const data = [1, "two", { three: 3 }];

      expect(fabricFromRealmValue(data)).toBe(data);
    });

    it("rebuilds only the objects on the path to a decoded value", () => {
      const untouched = { c: "two" };
      const data = { a: new Map([["EpochNsec@1", 7n]]), b: untouched };
      const decoded = fabricFromRealmValue(data as never) as Record<
        string,
        FabricValue
      >;

      expect(decoded).not.toBe(data);
      expect(decoded.b).toBe(untouched);
    });

    it("rebuilds only the arrays on the path to a decoded value", () => {
      const untouched = [1, 2];
      const data = [new Map([["EpochNsec@1", 7n]]), untouched];
      const decoded = fabricFromRealmValue(data as never) as FabricValue[];

      expect(decoded).not.toBe(data);
      expect(decoded[1]).toBe(untouched);
    });

    it("freezes what it retains from the value ceded to it", () => {
      const inner = { c: "two" };
      const innerArray = [1, 2];
      const data = {
        a: new Map([["EpochNsec@1", 7n]]),
        b: inner,
        d: innerArray,
      };

      fabricFromRealmValue(data as never);

      // Both came back by identity rather than rebuilt, so freezing them is
      // the whole of what keeps the result immutable.
      expect(Object.isFrozen(inner)).toBe(true);
      expect(Object.isFrozen(innerArray)).toBe(true);
    });
  });

  describe("across a real realm boundary", () => {
    it("reconstructs each class on the far side", async () => {
      const report = await crossRealm({
        bytes: new FabricBytes(new Uint8Array([1, 2, 250])),
        nsec: new FabricEpochNsec(1234567890123456789n),
        days: new FabricEpochDays(20_000n),
        hash: new FabricHash(new Uint8Array([9, 8, 7]), "fid1"),
        regexp: new FabricRegExp(/ab+c/gi),
      });

      expect(report.ok).toBe(true);
      // Class identity, judged in the realm that received the value. A
      // structured clone alone flattens every one of these to a bare object.
      expect(report.classes).toEqual({
        bytes: "FabricBytes",
        nsec: "FabricEpochNsec",
        days: "FabricEpochDays",
        hash: "FabricHash",
        regexp: "FabricRegExp",
      });
      expect(report.facts?.bytes).toEqual([1, 2, 250]);
      expect(report.facts?.nsec).toBe(1234567890123456789n);
    });

    it("carries what a plain `postMessage()` would lose or mangle", async () => {
      // Three things have to be true of this array for the assertion below to
      // mean anything. The `FabricBytes` forces the walk to REBUILD it, since
      // an all-plain array is returned by identity under copy-on-write and the
      // transport alone would then preserve the holes. One hole sits BEFORE
      // that element, which the rebuild's copy-the-prefix path must carry; and
      // one sits AFTER it, which the main loop must skip. Either alone leaves
      // the other path unexercised.
      const sparse: FabricValue[] = [
        1,
        2,
        new FabricBytes(new Uint8Array([3])),
        4,
        5,
      ];
      delete sparse[1];
      delete sparse[3];

      const report = await crossRealm({
        plain: { "/slashy": "no escaping needed" },
        sparse,
        big: 42n,
        negZero: -0,
        nothing: undefined,
        sym: Symbol.for("interned"),
      });

      expect(report.ok).toBe(true);
      // A `/`-prefixed key is ordinary data here, where JSON must escape it.
      expect(report.facts?.slashy).toBe("no escaping needed");
      // Holes survive as holes, so `/hole` needs no counterpart.
      expect(report.facts?.holeKeys).toEqual(["0", "2", "4"]);
      expect(report.classes?.sparse).toBe("Array");
      expect(report.facts?.sparseLength).toBe(5);
      expect(report.facts?.big).toBe(42n);
      expect(report.facts?.negZeroIsNegative).toBe(true);
      expect(report.facts?.nothingPresent).toBe(true);
      // A symbol is the one primitive cloning refuses outright, so this one
      // crossed through `SymbolCodec`. Internedness under the same key is the
      // whole of what the format promises, and so the whole of what is
      // checked: identity across a realm boundary is not a question it
      // answers, there being no realm in which both symbols exist to compare.
      expect(report.facts?.symbolIsInterned).toBe(true);
    });

    it("expands a nonterminal codec's state, terminating what is inside it", async () => {
      const report = await crossRealm({
        err: new FabricError({
          type: "RangeError",
          message: "boom",
          stack: undefined,
          cause: undefined,
          extras: { detail: new FabricBytes(new Uint8Array([7])) },
        }),
      });

      expect(report.ok).toBe(true);
      // `FabricError` binds one format-neutral `[CODEC]`, so the walk expands
      // its state; the `FabricBytes` inside then terminates as this format's
      // bytes rather than as JSON's base64url text.
      expect(report.classes).toEqual({ err: "FabricError" });
    });
  });

  describe("the kind each class declares for this format", () => {
    // The wire form cannot witness this for every class -- where a state is a
    // record of strings, a walk that descends into it and one that passes it
    // through emit the same thing -- so the declaration is asserted directly,
    // which is also how `CodecRegistry` reads it.
    for (
      const [name, cls] of [
        ["FabricBytes", FabricBytes],
        ["FabricEpochNsec", FabricEpochNsec],
        ["FabricEpochDays", FabricEpochDays],
        ["FabricHash", FabricHash],
        ["FabricRegExp", FabricRegExp],
      ] as const
    ) {
      it(`declares \`${name}\` terminal`, () => {
        expect(cls[REALM_CODEC] instanceof BaseTerminalCodec).toBe(true);
      });
    }

    it("declares `FabricError` nonterminal, one codec serving every format", () => {
      const registered = FabricError as unknown as Record<symbol, unknown>;

      expect(registered[REALM_CODEC]).toBe(undefined);
    });
  });
});
