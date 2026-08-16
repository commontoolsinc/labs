/**
 * Tests for the realm-crossing wire format: the engine, the entry points over
 * it, and the kind each participating class declares.
 *
 * The round trips go through a real `Worker`, not `structuredClone()` in this
 * realm. Cloning runs the same serialization algorithm, so it would prove the
 * walk is invertible -- but this format exists to carry values to another
 * realm, and only the far side can show that what arrives there is a live
 * instance of the right class rather than a shape that happens to match.
 */

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
  type RealmEncodedValue,
  type RealmFormatMarker,
  type RealmTaggedValue,
} from "@/codec-realm/interface.ts";
import { RealmCodecEngine } from "@/codec-realm/RealmCodecEngine.ts";
import {
  createDefaultRealmRegistry,
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
 * A marker for hand-built wire data. `decode()` checks an envelope's marker by
 * shape and version rather than by identity, so a test's own marker works
 * exactly as the engine's does -- which is itself the property that lets a
 * peer send a well-formed payload.
 */
const WIRE_MARKER = ["fvr1"] as unknown as RealmFormatMarker;

/** Wraps hand-built wire data in an envelope under {@link WIRE_MARKER}. */
function wire(payload: unknown): RealmEncodedValue {
  return [WIRE_MARKER, payload as RealmCodecValue];
}

/** A tagged form under {@link WIRE_MARKER}, for hand-built wire data. */
function tagged(tag: unknown, state: unknown): RealmCodecValue {
  return [WIRE_MARKER, tag, state] as unknown as RealmCodecValue;
}

/** The walked tree inside an encoded value's envelope. */
function payloadOf(encoded: RealmEncodedValue): RealmCodecValue {
  return encoded[1];
}

/** The state under a tagged form, for an encoded value that is one. */
function stateOf(encoded: RealmEncodedValue): RealmCodecValue {
  return (payloadOf(encoded) as unknown as RealmTaggedValue)[2];
}

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
    it("wraps the walked tree, which is otherwise the caller's own", () => {
      const value = { a: 1 };

      // Not merely equal: the same object. An envelope would make that
      // impossible for any value at all, however little of it needed
      // encoding.
      expect(payloadOf(realmFromFabricValue(value))).toBe(value);
    });

    it("returns a payload holding no encodable value by identity", () => {
      const value = { a: 1, b: { c: "two" }, d: [3, 4] };

      // Copy-on-write: nothing here needs encoding, so nothing is rebuilt and
      // the transport does the only copying.
      expect(payloadOf(realmFromFabricValue(value))).toBe(value);
    });

    it("rebuilds only the containers on the path to an encoded value", () => {
      const untouched = { c: "two" };
      const value = { a: new FabricBytes(new Uint8Array([1])), b: untouched };
      const payload = payloadOf(realmFromFabricValue(value)) as Record<
        string,
        RealmCodecValue
      >;

      expect(payload).not.toBe(value);
      expect(payload.b).toBe(untouched);
    });

    it("leaves a `/`-prefixed key untouched, this format reserving no key", () => {
      const value = { "/quote": "not a tag here", "/Bytes@1": "nor this" };

      expect(payloadOf(realmFromFabricValue(value))).toBe(value);
    });

    it("encodes a `FabricBytes` to a transferable `ArrayBuffer`", () => {
      const payload = payloadOf(realmFromFabricValue(
        new FabricBytes(new Uint8Array([1, 2, 250])),
      ));
      const state = (payload as unknown as RealmTaggedValue)[2];

      // An `ArrayBuffer` rather than a view onto one, that being the form
      // `postMessage()` can transfer.
      expect(state).toBeInstanceOf(ArrayBuffer);
      expect([...new Uint8Array(state as ArrayBuffer)]).toEqual([1, 2, 250]);
    });

    it("encodes a `FabricBytes` to a buffer covering exactly its bytes", () => {
      // A transfer hands over the whole buffer, so a state covering more than
      // the value would cede bytes that are not part of it.
      const payload = payloadOf(realmFromFabricValue(
        new FabricBytes(new Uint8Array([1, 2, 250])),
      ));
      const state = (payload as unknown as RealmTaggedValue)[2] as ArrayBuffer;

      expect(state.byteLength).toBe(3);
    });

    it("encodes a `FabricHash` to a tag and a transferable `ArrayBuffer`", () => {
      const payload = payloadOf(realmFromFabricValue(
        new FabricHash(new Uint8Array([1, 2, 3]), "fid1"),
      ));
      const state = (payload as unknown as RealmTaggedValue)[2] as {
        tag: string;
        hash: ArrayBuffer;
      };

      // Both byte-carrying classes reach `postMessage()`'s transferable form,
      // so a transfer list can be assembled from either without reaching
      // through a view.
      expect(state.tag).toBe("fid1");
      expect(state.hash).toBeInstanceOf(ArrayBuffer);
      expect([...new Uint8Array(state.hash)]).toEqual([1, 2, 3]);
      // Covering exactly the bytes: a transfer hands over the whole buffer.
      expect(state.hash.byteLength).toBe(3);
    });

    it("does not hand out the bytes an encoded `FabricHash` holds", () => {
      const hash = new FabricHash(new Uint8Array([1, 2, 3]), "fid1");
      const state = stateOf(realmFromFabricValue(hash)) as {
        hash: ArrayBuffer;
      };

      new Uint8Array(state.hash)[0] = 99;
      // Read through `bytes`, not `toString()`: the string forms are computed
      // once in the constructor, so they cannot witness a mutation of the
      // bytes and a test resting on them passes however this codec behaves.
      expect([...hash.bytes]).toEqual([1, 2, 3]);
    });

    it("encodes a `FabricEpochNsec` to a `bigint`", () => {
      const payload = payloadOf(realmFromFabricValue(
        new FabricEpochNsec(1234567890123456789n),
      ));

      expect((payload as unknown as RealmTaggedValue)[2]).toBe(
        1234567890123456789n,
      );
    });

    it("encodes an interned symbol to its registry key", () => {
      // Cloning refuses every symbol, so this is the one JavaScript primitive
      // the format has to encode at all.
      const payload = payloadOf(
        realmFromFabricValue(Symbol.for("k") as FabricValue),
      );

      expect((payload as unknown as RealmTaggedValue)[2]).toBe("k");
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
        stateOf(realmFromFabricValue(bytes)) as ArrayBuffer,
      );

      state[0] = 99;
      expect([...bytes.slice()]).toEqual([1, 2, 3]);
    });

    it("keeps a shared subtree shared when it needs no encoding", () => {
      const shared = { s: 1 };
      const payload = payloadOf(
        realmFromFabricValue({ a: shared, b: shared }),
      ) as Record<
        string,
        RealmCodecValue
      >;

      // Copy-on-write does this rather than any memo: `shared` comes back by
      // identity from both positions, so both still hold the one object.
      expect(payload.a).toBe(shared);
      expect(payload.a).toBe(payload.b);
    });

    it("rebuilds a shared subtree separately when it needs encoding", () => {
      const shared = { bytes: new FabricBytes(new Uint8Array([1, 2])) };
      const payload = payloadOf(
        realmFromFabricValue({ a: shared, b: shared }),
      ) as Record<
        string,
        RealmCodecValue
      >;

      // The other half of the contract, and the reason it is worth stating:
      // each position rebuilds on its own, so the encoding has two equal
      // objects where the value had one.
      expect(payload.a).not.toBe(payload.b);
      expect(payload.a).toEqual(payload.b);
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
      expect(fabricFromRealmValue(wire({ a: 1 }))).toEqual({ a: 1 });
    });

    it("refuses a form this format never emits", () => {
      // Cloning carries a `Date`; this format has no codec that produces one,
      // so it can only have come from something other than an `encode()`.
      expect(() => fabricFromRealmValue(wire(new Date()))).toThrow(
        /not a form this format emits/,
      );
    });

    it("refuses a `Map`, which is no form this format emits", () => {
      // Cloning carries one faithfully, so a peer can send one; nothing here
      // makes one, so meeting one is a malformation like any other.
      expect(() => fabricFromRealmValue(wire(new Map([["a", 1]]))))
        .toThrow(/not a form this format emits/);
    });

    it("refuses an envelope that is not two elements", () => {
      // The one place this engine takes instruction from the data, so the
      // slot count is checked before slot zero is read as a marker at all.
      // Three of these carry a well-formed marker, so only the slot-count
      // clause refuses them; the rest are not arrays, which that same clause
      // catches.
      for (
        const bad of [
          [],
          [["fvr1"]],
          [["fvr1"], 1, 2],
          [["fvr1"], 1, 2, 3],
          "nope",
          42,
        ]
      ) {
        expect(() => fabricFromRealmValue(bad as never))
          .toThrow(/two-element envelope/);
      }
    });

    it("refuses to wrap a tag when there is no marker to wrap it under", () => {
      // `wrapTag()` is unreachable outside a walk through this class, so a
      // subclass is what reaches it. The guard is worth having anyway: the
      // alternative to throwing is emitting an envelope with no marker, which
      // nothing could ever recognize, and which would fail far from here.
      class Exposed extends RealmCodecEngine {
        wrapOutsideEncode(): unknown {
          return (this as unknown as {
            wrapTag(t: string, s: unknown): unknown;
          }).wrapTag("Bytes@1", 1);
        }
      }

      const engine = new Exposed({ registry: createDefaultRealmRegistry() });

      expect(() => engine.wrapOutsideEncode())
        .toThrow(/Cannot wrap a tag outside an encode/);
    });

    it("reports a bad state for every codec that validates one", () => {
      // Section 7.1 of `4-realm-encoding.md` requires a codec to reject the
      // state it is handed rather than coerce it, so each of these is a
      // requirement rather than an observation. Lenient, because the report is
      // what is under test -- strictly these raise, which the cases above
      // already cover.
      const engine = newDefaultRealmCodecEngine({ lenient: true });
      const bad = (tag: string, state: unknown) =>
        engine.decode(
          wire(tagged(tag, state)),
          EMPTY_RECONSTRUCTION_CONTEXT,
        ) as ProblematicValue;

      // Wrong primitive type where a `bigint` is required.
      expect(bad("EpochDays@1", "7").error).toMatch(/expected `bigint`/);
      expect(bad("EpochNsec@1", 7).error).toMatch(/expected `bigint`/);

      // Not a record at all, then a record with the wrong field types.
      expect(bad("Hash@1", 42).error).toMatch(/expected object state/);
      expect(bad("Hash@1", { tag: 1, hash: 2 }).error)
        .toMatch(/expected string `tag`/);
      expect(bad("RegExp@1", 42).error).toMatch(/expected object state/);
      expect(bad("RegExp@1", { source: 1, flags: 2, flavor: 3 }).error)
        .toMatch(/expected string/);

      // Bytes wants the transport's own byte carrier and takes nothing else.
      expect(bad("Bytes@1", "nope").error).toMatch(/expected `ArrayBuffer`/);

      // Well-typed fields that still do not make a value. `RegExp@1` is the
      // one codec here whose construction can fail on data that passed every
      // type check, so its refusal has to survive a throw rather than only a
      // shape test: a source and a flag set that `RegExp` itself rejects.
      expect(
        bad("RegExp@1", { source: "(", flags: "g", flavor: "es2025" })
          .error,
      ).toMatch(/Invalid regular expression/);
      expect(
        bad("RegExp@1", { source: "a", flags: "zz", flavor: "es2025" })
          .error,
      ).toMatch(/Invalid flags/);
    });

    it("refuses a symbol or a function met untagged", () => {
      // Cloning carries neither, so neither reaches this across the boundary
      // -- but `decode()` is callable in the realm that built its argument,
      // and passing them through would leave a value in the result that this
      // format cannot emit and `encode()` will not take.
      expect(() => fabricFromRealmValue(wire(Symbol("u"))))
        .toThrow(/Cannot decode symbol/);
      expect(() => fabricFromRealmValue(wire(() => 1)))
        .toThrow(/Cannot decode function/);
      // Nested, where a pass-through would hide inside a frozen container.
      expect(() => fabricFromRealmValue(wire({ a: Symbol("u") })))
        .toThrow(/Cannot decode symbol/);
    });

    it("refuses an envelope whose marker is not this format's", () => {
      // A primitive at slot zero is the case that would break recognition
      // outright: `===` on one is value equality, so any payload holding the
      // same primitive would reproduce the marker. The rest are refused
      // because a marker this build did not write is one whose encoding it
      // cannot claim to understand.
      const bad = [
        // Primitives, which cannot mark anything.
        "fvr1",
        42,
        null,
        undefined,
        7n,
        true,
        // Objects, but not the shape Section 2.4 specifies.
        {},
        { 0: "fvr1", length: 1 },
        [],
        ["fvr1", "extra"],
        // The right shape, carrying a version this build does not implement.
        ["fvr2"],
        ["FVR1"],
      ];

      for (const marker of bad) {
        expect(() => fabricFromRealmValue([marker, { a: 1 }] as never))
          .toThrow(/expected an envelope headed by a `fvr1` marker/);
      }
    });

    it("decodes an envelope headed by a peer's own equal marker", () => {
      // The control for the case above, and the property that lets a peer
      // send a well-formed payload at all: what is checked is the marker's
      // shape and version, never its identity against one this realm minted.
      expect(fabricFromRealmValue([["fvr1"], { a: 1 }] as never))
        .toEqual({ a: 1 });
    });

    it("treats a two-element array in a data position as data", () => {
      // A genuine payload cannot hold the current marker at all, but a peer
      // can send anything. Slot count is checked before identity, so this is
      // an array and not an envelope missing its state.
      const marker = realmFromFabricValue(null)[0];
      const decoded = fabricFromRealmValue(
        [marker, { a: [marker, "EpochDays@1"] }] as never,
      ) as Record<string, FabricValue>;

      expect(Array.isArray(decoded.a)).toBe(true);
      expect((decoded.a as FabricValue[])[1]).toBe("EpochDays@1");
    });

    it("refuses an envelope nested as its own payload", () => {
      // `E = [m, E]`. The walk meets `E` again beneath itself, where the guard
      // has it, so this is a cycle rather than an unbounded descent.
      const envelope: unknown[] = [["fvr1"], null];
      envelope[1] = envelope;

      expect(() => fabricFromRealmValue(envelope as never))
        .toThrow(/circular reference/);
    });

    it("treats an array the marker does not head as ordinary data", () => {
      // Three elements and a lookalike marker in slot zero, and still data:
      // recognition is identity, and this array's slot zero is some other
      // object however equal it looks.
      const lookalike = ["fvr1"];
      const decoded = fabricFromRealmValue(
        wire({ a: [lookalike, "EpochDays@1", 7n] }),
      ) as Record<string, FabricValue>;

      expect(Array.isArray(decoded.a)).toBe(true);
      expect((decoded.a as FabricValue[])[1]).toBe("EpochDays@1");
      // And slot zero is still the array the payload built, not swapped for
      // anything: an unrecognized head is data like the rest of it.
      expect((decoded.a as FabricValue[])[0]).toBe(lookalike);
    });

    it("refuses a tagged form whose tag is not a tag", () => {
      // Slot one holds whatever a peer put there, so this format can find a
      // non-string in tag position where JSON never can. The engine hands it
      // over as it found it, and the shared tag check judges it, so what is
      // refused here is refused the same way under any format.
      expect(() => fabricFromRealmValue(wire(tagged(42, "x"))))
        .toThrow(/malformed tag/);
      expect(() => fabricFromRealmValue(wire(tagged(Symbol("s"), "x"))))
        .toThrow(/malformed tag/);
      expect(() => fabricFromRealmValue(wire(tagged("hole", "x"))))
        .toThrow(/malformed tag/);
    });

    it("keeps the offending key in a lenient refusal", () => {
      const engine = newDefaultRealmCodecEngine({ lenient: true });
      const decoded = engine.decode(
        wire(tagged(42, "x")),
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
        fabricFromRealmValue(wire(tagged("Bytes@1", "nope")));
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
      // Every realm codec reports by returning one, as its JSON
      // counterpart does; `lenient` is what decides which a caller sees.
      const engine = newDefaultRealmCodecEngine({ lenient: true });
      const decoded = engine.decode(
        wire(tagged("Bytes@1", "nope")),
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
        fabricFromRealmValue(wire(tagged("Symbol@1", 42)));
        throw new Error("Should have thrown.");
      } catch (e) {
        expect(e).toBeInstanceOf(ProblematicStateError);
        expect((e as ProblematicStateError).wireTypeTag).toBe("Symbol@1");
        expect((e as ProblematicStateError).state).toBe(42);
        expect((e as Error).message).not.toMatch(/Symbol@1/);
      }
    });

    it("wraps an unclaimed tag in an `UnknownValue` rather than refusing", () => {
      // Three slots headed by the marker ARE the tagged form, so this is a
      // well-formed value carrying a tag no codec claims -- a different thing
      // from a malformation.
      const decoded = fabricFromRealmValue(wire(tagged("Nope@1", 1)));

      expect(decoded).toBeInstanceOf(UnknownValue);
      expect((decoded as UnknownValue).wireTypeTag).toBe("Nope@1");
    });

    it("refuses a circular reference", () => {
      // Cloning reproduces a cyclic graph faithfully, so unlike JSON -- whose
      // `JSON.parse()` cannot produce one -- this format can actually be sent
      // a cycle by a peer. Without a guard the walk recurses until the stack
      // gives out, which is the one refusal `lenient` could not contain.
      const object: Record<string, RealmCodecValue> = { a: 1 };
      object.self = object;
      const array: RealmCodecValue[] = [1];
      array.push(array);

      expect(() => fabricFromRealmValue(wire(object))).toThrow(
        /circular reference/,
      );
      expect(() => fabricFromRealmValue(wire(array))).toThrow(
        /circular reference/,
      );
    });

    it("refuses a circular reference closed through tagged values alone", () => {
      // The tagged form is a container too: `decodeTagged()` walks the state
      // again for a nonterminal codec, for a tag no codec claims, and for a
      // tag that is not one. So a graph of envelopes can close a cycle with no
      // plain container in it at all, and cloning carries one faithfully.
      const unknownTag = tagged("Nope@1", null) as unknown as unknown[];
      unknownTag[2] = unknownTag;

      const malformedTag = tagged(42, null) as unknown as unknown[];
      malformedTag[2] = malformedTag;

      const nonterminal = tagged("Error@1", null) as unknown as unknown[];
      nonterminal[2] = nonterminal;

      for (const one of [unknownTag, malformedTag, nonterminal]) {
        expect(() => fabricFromRealmValue(wire(one)))
          .toThrow(/circular reference/);
      }
    });

    it("refuses a circular reference closed through a mix of the two", () => {
      const object: Record<string, RealmCodecValue> = {};
      object.tagged = tagged("Nope@1", object);

      expect(() => fabricFromRealmValue(wire(object))).toThrow(
        /circular reference/,
      );
    });

    it("decodes the same tagged value at two positions, which is no cycle", () => {
      // The guard must catch a node reached while still being decoded, not one
      // merely seen twice. Sequential visits leave the set between them, so
      // this is the check that it does not over-refuse.
      //
      // One tagged node at both positions, and not two values that encode
      // alike: `wrapTag()` builds a fresh envelope per visit, so encoding a
      // value that holds one instance twice yields two nodes and revisits
      // nothing. A hand-built node is reused directly to get the sharing this
      // needs.
      const shared = tagged("EpochDays@1", 7n);
      const decoded = fabricFromRealmValue(
        wire({ x: shared, y: shared }),
      ) as Record<string, FabricValue>;

      expect(decoded.x).toBeInstanceOf(FabricEpochDays);
      expect(decoded.y).toBeInstanceOf(FabricEpochDays);
    });

    it("reports a repeated reserved-key object as reserved, not circular", () => {
      // The reserved-key arm returns early, so it has to leave the
      // in-progress set on its way out. Without that, the second position
      // holding the same object would be read as a back-edge and reported as
      // a cycle -- the right refusal for the wrong reason.
      const offender = Object.defineProperty({ a: 1 }, "constructor", {
        value: "c",
        enumerable: true,
        configurable: true,
        writable: true,
      }) as Record<string, RealmCodecValue>;
      const engine = newDefaultRealmCodecEngine({ lenient: true });
      const decoded = engine.decode(
        wire({ first: offender, second: offender }),
        EMPTY_RECONSTRUCTION_CONTEXT,
      ) as Record<string, ProblematicValue>;

      expect(decoded.first?.error).toMatch(/reserves/);
      expect(decoded.second?.error).toMatch(/reserves/);
    });

    it("reports a circular reference at the cycle when lenient", () => {
      const engine = newDefaultRealmCodecEngine({ lenient: true });
      const object: Record<string, RealmCodecValue> = { a: 1 };
      object.self = object;
      const decoded = engine.decode(
        wire(object),
        EMPTY_RECONSTRUCTION_CONTEXT,
      ) as Record<string, FabricValue>;

      // The report replaces the back-edge rather than the whole value, so
      // everything else survives.
      expect(decoded.a).toBe(1);
      expect(decoded.self).toBeInstanceOf(ProblematicValue);
    });

    it("refuses a key this runtime reserves", () => {
      // The rebuild below assigns, and on a host with the standard
      // `__proto__` accessor that would drop the key and repoint the result's
      // prototype. The key is computed on purpose: in an object literal a
      // `__proto__:` sets the prototype rather than creating a property, so a
      // literal cannot express this shape at all.
      const data = Object.defineProperty({ a: 1 }, "__proto__", {
        value: { hostile: true },
        enumerable: true,
        configurable: true,
        writable: true,
      });

      expect(() => fabricFromRealmValue(wire(data))).toThrow(/reserves/);
    });

    it("returns that refusal as a `ProblematicValue` when lenient", () => {
      const engine = newDefaultRealmCodecEngine({ lenient: true });
      const data = Object.defineProperty({ a: 1 }, "constructor", {
        value: "c",
        enumerable: true,
        configurable: true,
        writable: true,
      });
      const decoded = engine.decode(
        wire(data),
        EMPTY_RECONSTRUCTION_CONTEXT,
      ) as ProblematicValue;

      expect(decoded).toBeInstanceOf(ProblematicValue);
      expect(decoded.wireTypeTag).toBe("constructor");
    });

    it("returns an object needing no decoding by identity", () => {
      const data = { a: 1, b: { c: "two" }, d: [3, 4] };

      // Copy-on-write on the decode side, as on the encode side. Each format
      // writes its own `decodeValue()`, so this is not covered by any test of
      // the shared engine.
      expect(fabricFromRealmValue(wire(data))).toBe(data);
    });

    it("returns an array needing no decoding by identity", () => {
      const data = [1, "two", { three: 3 }];

      expect(fabricFromRealmValue(wire(data))).toBe(data);
    });

    it("rebuilds only the objects on the path to a decoded value", () => {
      const untouched = { c: "two" };
      const data = { a: tagged("EpochNsec@1", 7n), b: untouched };
      const decoded = fabricFromRealmValue(wire(data)) as Record<
        string,
        FabricValue
      >;

      expect(decoded).not.toBe(data);
      expect(decoded.b).toBe(untouched);
    });

    it("rebuilds only the arrays on the path to a decoded value", () => {
      const untouched = [1, 2];
      const data = [tagged("EpochNsec@1", 7n), untouched];
      const decoded = fabricFromRealmValue(wire(data)) as FabricValue[];

      expect(decoded).not.toBe(data);
      expect(decoded[1]).toBe(untouched);
    });

    it("freezes what it retains from the value ceded to it", () => {
      const inner = { c: "two" };
      const innerArray = [1, 2];
      const data = {
        a: tagged("EpochNsec@1", 7n),
        b: inner,
        d: innerArray,
      };

      fabricFromRealmValue(wire(data));

      // Both came back by identity rather than rebuilt, so freezing them is
      // the whole of what keeps the result immutable.
      expect(Object.isFrozen(inner)).toBe(true);
      expect(Object.isFrozen(innerArray)).toBe(true);
    });

    it("leaves an outer encode its own marker when one nests inside it", () => {
      // `#marker` is a field, so a call that starts DURING another walk has to
      // hand the outer one back rather than clear it. A getter is the shortest
      // way to reach that: it runs while the outer walk is suspended in
      // `encodePlainObject()`, and re-enters through the public entry point.
      //
      // Sequential calls would test nothing here -- the outer has returned
      // before the second starts, so restoring and clearing look identical.
      // What discriminates them is a tagged form built AFTER the nested call
      // returns: with the marker cleared, `wrapTag()` has none and throws.
      const engine = newDefaultRealmCodecEngine();
      let nestedMarker: unknown;

      const value = {
        get first(): FabricValue {
          nestedMarker = (engine.encode(7n) as unknown as unknown[])[0];
          return 1;
        },
        second: new FabricEpochDays(2n),
      };

      const encoded = engine.encode(value) as unknown as [
        unknown,
        Record<string, unknown[]>,
      ];

      expect(encoded[1].second![0]).toBe(encoded[0]);
      expect(nestedMarker).not.toBe(encoded[0]);
    });

    it("does not read an earlier encode's marker as this one's", () => {
      // The property the per-call marker exists for, and the whole of why it
      // is minted per call rather than held on the engine. A value may
      // legitimately hold a subtree of some earlier encoding -- whatever
      // assembled it is trusted and has seen one -- and copy-on-write carries
      // that subtree through, so the older marker ends up sitting in a *data*
      // position. A marker that outlived its call would be read there as an
      // envelope, and user data would decode as a tagged value. What is
      // asserted is only that: whether the walk passed the subtree through or
      // rebuilt it, the same older marker object lands in slot zero either
      // way, and the point is that it is not this call's.
      const earlier = realmFromFabricValue(new FabricEpochDays(7n));
      const value = Object.freeze({
        smuggled: payloadOf(earlier) as FabricValue,
      });

      const decoded = fabricFromRealmValue(
        realmFromFabricValue(value),
      ) as Record<string, FabricValue>;

      // Data, three slots and all, rather than a reconstructed value.
      expect(Array.isArray(decoded.smuggled)).toBe(true);
      expect((decoded.smuggled as FabricValue[])[1]).toBe("EpochDays@1");
      expect(decoded.smuggled).not.toBeInstanceOf(FabricEpochDays);
    });

    it("reads those same three slots as tagged under a matching marker", () => {
      // The control for the case above, and what makes the pair a statement
      // about identity rather than about shape: the very same slots, under the
      // marker the envelope carries, do decode as the value they name.
      const marker = realmFromFabricValue(null)[0];
      const decoded = fabricFromRealmValue(
        [marker, [marker, "EpochDays@1", 7n]] as never,
      );

      expect(decoded).toBeInstanceOf(FabricEpochDays);
    });

    it("decodes a tree carrying bytes exactly once", () => {
      // Taking the buffer over detaches it, which is what ceding buys and what
      // it costs. A control sits beside it: a tree with no byte-carrying value
      // decodes as often as it likes, so what the first case pins is the
      // buffer and not decoding in general.
      const withBytes = realmFromFabricValue(
        { blob: new FabricBytes(new Uint8Array([1, 2, 250])) },
      );

      expect(fabricFromRealmValue(withBytes)).toBeDefined();
      expect(() => fabricFromRealmValue(withBytes)).toThrow(/detached/);

      const withoutBytes = realmFromFabricValue({
        when: new FabricEpochNsec(7n),
      });

      expect(fabricFromRealmValue(withoutBytes)).toBeDefined();
      expect(fabricFromRealmValue(withoutBytes)).toBeDefined();
    });

    it("decodes a tree carrying a `FabricHash` exactly once", () => {
      // The same property, and the reason to state it of both: a `FabricHash`
      // reaches the take-over through a record rather than as a bare buffer,
      // so a change that spared one could miss the other.
      const encoded = realmFromFabricValue(
        { digest: new FabricHash(new Uint8Array(32).fill(7), "sha256") },
      );

      expect(fabricFromRealmValue(encoded)).toBeDefined();
      expect(() => fabricFromRealmValue(encoded)).toThrow(/detached/);
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
      // Content as well as class. A transposed field or a dropped value would
      // leave every `classes` entry correct, so the class check alone cannot
      // see it.
      expect(report.facts?.bytes).toEqual([1, 2, 250]);
      expect(report.facts?.nsec).toBe(1234567890123456789n);
      expect(report.facts?.days).toBe(20_000n);
      expect(report.facts?.hashTag).toBe("fid1");
      expect(report.facts?.hashBytes).toEqual([9, 8, 7]);
      expect(report.facts?.regexpParts).toEqual(["es2025", "ab+c", "gi"]);
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
