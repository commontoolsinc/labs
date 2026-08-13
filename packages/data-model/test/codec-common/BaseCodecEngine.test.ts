// Tests for the whole-value codec engine base class, exercised through a
// minimal format of its own (see `probe-engine.ts`) rather than through
// `JsonCodecEngine`. What is under test is the part no wire format decides for
// itself, and a format whose containers do the least a container can do is
// what makes those decisions observable.

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { FabricValue } from "@/interface.ts";
import { EMPTY_RECONSTRUCTION_CONTEXT } from "@/codec-interface/index.ts";
import { isDeepFrozen } from "@/deep-freeze.ts";
import { ProblematicValue } from "@/codec-common/ProblematicValue.ts";
import { UnknownValue } from "@/codec-common/UnknownValue.ts";
import { FabricBytes } from "@/fabric-primitives/FabricBytes.ts";
import {
  Marker,
  NESTED,
  newProbeEngine,
  NONTERMINAL_HOST,
  type ProbeValue,
  Tagged,
  TERMINAL_HOST,
} from "./probe-engine.ts";

const CONTEXT = EMPTY_RECONSTRUCTION_CONTEXT;

describe("BaseCodecEngine", () => {
  describe("terminal vs. nonterminal codecs", () => {
    // The two host codecs return the identical state, `{ inner: "X" }`, and
    // differ only in which base class they extend. Everything below is
    // therefore the engine's doing rather than theirs.

    it("leaves a terminal codec's state alone", () => {
      const { engine } = newProbeEngine();
      const encoded = engine.encode(TERMINAL_HOST) as Tagged;

      expect(encoded.tag).toBe("T@1");
      // `"X"` has a codec of its own, and it was not consulted: a terminal
      // state is already in the format's domain, so the walk stops here.
      expect(encoded.state).toEqual({ inner: NESTED });
    });

    it("walks a nonterminal codec's state", () => {
      const { engine } = newProbeEngine();
      const encoded = engine.encode(NONTERMINAL_HOST) as Tagged;

      expect(encoded.tag).toBe("N@1");
      // The same state, expanded: `"X"` is a fabric value, so the walk went on
      // and `XCodec` encoded it under its own tag.
      const inner = (encoded.state as { inner: ProbeValue }).inner as Tagged;
      expect(inner).toBeInstanceOf(Tagged);
      expect(inner.tag).toBe("X@1");
      expect(inner.state).toBe("encoded-X");
    });

    it("hands a terminal codec the state exactly as it arrived", () => {
      const { engine, record } = newProbeEngine();
      // Hand-built so that both hosts are given the identical wire state.
      const wire = new Tagged("T@1", { inner: new Tagged("X@1", "encoded-X") });

      engine.decode(wire, CONTEXT);

      const seen = record.decoded[0] as { inner: unknown };
      // Undecoded: the inner tag is still a tag, not the value it stands for.
      expect(seen.inner).toBeInstanceOf(Tagged);
    });

    it("hands a nonterminal codec state that has been decoded", () => {
      const { engine, record } = newProbeEngine();
      const wire = new Tagged("N@1", { inner: new Tagged("X@1", "encoded-X") });

      engine.decode(wire, CONTEXT);

      const seen = record.decoded[0] as { inner: unknown };
      // Decoded: the walk reached the inner tag before this codec was called.
      expect(seen.inner).toBe("decoded-X");
    });

    it("reads the kind from the codec's base class, not from its state", () => {
      // The clinching case: identical states in, different wire forms out.
      const { engine } = newProbeEngine();

      expect((engine.encode(TERMINAL_HOST) as Tagged).state)
        .toEqual({ inner: NESTED });
      expect(
        ((engine.encode(NONTERMINAL_HOST) as Tagged).state as {
          inner: ProbeValue;
        }).inner,
      ).toBeInstanceOf(Tagged);
    });
  });

  describe("encodeValue()", () => {
    it("emits a self-representing value as it stands", () => {
      const { engine } = newProbeEngine();

      expect(engine.encode(42)).toBe(42);
      expect(engine.encode("plain")).toBe("plain");
    });

    it("takes the tag from `tagForValue()` rather than from the value", () => {
      const { engine } = newProbeEngine();

      expect((engine.encode(TERMINAL_HOST) as Tagged).tag).toBe("T@1");
    });

    it("throws given a `FabricSpecialObject` no codec claims", () => {
      const { engine } = newProbeEngine();

      expect(() => engine.encode(new FabricBytes(new Uint8Array([1]))))
        .toThrow(/No codec registered for `FabricSpecialObject` subclass/);
    });

    it("throws given a value that is no `FabricValue` at all", () => {
      const { engine } = newProbeEngine();

      expect(() => engine.encode(new Date() as unknown as FabricValue))
        .toThrow(/no applicable codec/);
    });

    it("throws given a circular reference", () => {
      const { engine } = newProbeEngine();
      const value: Record<string, FabricValue> = { a: 1 };
      value.self = value;

      expect(() => engine.encode(value)).toThrow(/Circular reference/);
    });

    it("does not mistake a repeated value for a circular one", () => {
      // The same object twice over is not a cycle, so `seen` has to be unwound
      // as the walk leaves each value rather than only grown. A `Marker`
      // rather than a plain object, because that bookkeeping lives on the
      // codec-matched path and a container never reaches it.
      const { engine } = newProbeEngine();
      const shared = new Marker() as unknown as FabricValue;

      expect(() => engine.encode({ x: shared, y: shared })).not.toThrow();
    });
  });

  describe("decodeTagged()", () => {
    it("wraps an unrecognized tag in an `UnknownValue`, decoded state kept", () => {
      const { engine } = newProbeEngine();
      const result = engine.decode(
        new Tagged("Nope@1", new Tagged("X@1", "encoded-X")),
        CONTEXT,
      );

      expect(result).toBeInstanceOf(UnknownValue);
      // Not a rejection: the state is walked so that what is inside a tag
      // nobody claims still round-trips.
      expect((result as UnknownValue).state).toBe("decoded-X");
    });

    it("rejects an empty tag rather than naming an `UnknownValue` with one", () => {
      const { engine } = newProbeEngine();

      expect(() => engine.decode(new Tagged("", "x"), CONTEXT))
        .toThrow(/empty tag/);
    });

    it("deep-freezes what a codec returns", () => {
      // `MarkerCodec.decode()` returns a mutable nested object. Every other
      // codec here returns a primitive, which is deep-frozen however the
      // engine behaves, and so could not witness this.
      const { engine } = newProbeEngine();
      const result = engine.decode(new Tagged("M@1", "m"), CONTEXT);

      expect(result).toEqual({ deep: { n: 1 } });
      expect(isDeepFrozen(result)).toBe(true);
    });
  });

  describe("`lenient`", () => {
    // A codec rejects a state in one of two ways, and which it picks is the
    // codec author's business rather than a caller's. `lenient` is what
    // decides what a caller sees, so it has to settle BOTH ways -- which is
    // why each group below covers both. `ThrowingCodec` and `RejectingCodec`
    // differ in nothing but that choice.

    /** A wire form whose codec rejects by throwing. */
    const THROWN = new Tagged("Throws@1", "x");

    /** A wire form whose codec rejects by returning a report. */
    const RETURNED = new Tagged("Rejects@1", "x");

    /** A wire form the walk itself finds malformed, no codec involved. */
    const MALFORMED = new Tagged("", "x");

    /** A wire form under a tag no codec claims, which is not a rejection. */
    const UNCLAIMED = new Tagged("Nope@1", "x");

    it("is `false` by default", () => {
      expect(newProbeEngine().engine.lenient).toBe(false);
    });

    describe("when `lenient === false`", () => {
      it("raises a codec's throw", () => {
        const { engine } = newProbeEngine();

        expect(() => engine.decode(THROWN, CONTEXT))
          .toThrow(/rejected by throwing/);
      });

      it("turns a `ProblematicValue` a codec returned into a throw", () => {
        // The half that used to do nothing: this rejection stood either way
        // before, so the setting governed only the codecs that threw.
        const { engine } = newProbeEngine();

        expect(() => engine.decode(RETURNED, CONTEXT))
          .toThrow(/rejected by returning/);
      });

      it("raises a malformation the walk itself found", () => {
        const { engine } = newProbeEngine();

        expect(() => engine.decode(MALFORMED, CONTEXT)).toThrow(/empty tag/);
      });

      it("wraps an unclaimed tag in an `UnknownValue` regardless", () => {
        // Not a rejection, so the setting has no say in it.
        const { engine } = newProbeEngine();

        expect(engine.decode(UNCLAIMED, CONTEXT)).toBeInstanceOf(UnknownValue);
      });
    });

    describe("when `lenient === true`", () => {
      it("turns a codec's throw into a `ProblematicValue`", () => {
        const { engine } = newProbeEngine({ lenient: true });
        const result = engine.decode(THROWN, CONTEXT);

        expect(result).toBeInstanceOf(ProblematicValue);
        // Carrying the codec's own message, so what went wrong survives the
        // conversion.
        expect((result as ProblematicValue).error)
          .toMatch(/rejected by throwing/);
        expect((result as ProblematicValue).wireTypeTag).toBe("Throws@1");
      });

      it("lets a `ProblematicValue` a codec returned stand", () => {
        const { engine } = newProbeEngine({ lenient: true });
        const result = engine.decode(RETURNED, CONTEXT);

        expect(result).toBeInstanceOf(ProblematicValue);
        expect((result as ProblematicValue).error)
          .toMatch(/rejected by returning/);
      });

      it("keeps a malformation the walk itself found", () => {
        const { engine } = newProbeEngine({ lenient: true });
        const result = engine.decode(MALFORMED, CONTEXT);

        expect(result).toBeInstanceOf(ProblematicValue);
        expect((result as ProblematicValue).error).toMatch(/empty tag/);
      });

      it("deep-freezes a `ProblematicValue` a codec returned", () => {
        // The codec arm's freeze: this report is the codec's own product.
        const { engine } = newProbeEngine({ lenient: true });

        expect(isDeepFrozen(engine.decode(RETURNED, CONTEXT))).toBe(true);
      });

      it("deep-freezes a `ProblematicValue` it built itself", () => {
        // The other arm, and a separate line of code: one is the engine
        // wrapping a throw, the other the walk reporting a malformation.
        // Neither stands in for the other.
        const { engine } = newProbeEngine({ lenient: true });

        expect(isDeepFrozen(engine.decode(THROWN, CONTEXT))).toBe(true);
        expect(isDeepFrozen(engine.decode(MALFORMED, CONTEXT))).toBe(true);
      });

      it("wraps an unclaimed tag in an `UnknownValue` regardless", () => {
        const { engine } = newProbeEngine({ lenient: true });

        expect(engine.decode(UNCLAIMED, CONTEXT)).toBeInstanceOf(UnknownValue);
      });
    });
  });
});
