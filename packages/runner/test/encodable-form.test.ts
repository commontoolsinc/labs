import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { fabricFromNativeValue } from "@commonfabric/data-model/fabric-value";
import { dataUriFromValue } from "@commonfabric/data-model/data-uri-codec";

import {
  encodableFormOf,
  hasEncodableForm,
  replaceArtifacts,
} from "../src/encodable-form.ts";

/**
 * The walk under test, with the copy callback ignored -- what a caller that
 * only wants the replacement passes. The callback has its own cases below.
 */
function flatten<T>(value: T): T {
  return replaceArtifacts(value, () => {});
}

/** Builds an artifact of the shape `builder/module.ts` produces. */
function artifact(serialized: unknown): Record<string, unknown> {
  return {
    type: "javascript",
    implementation: () => "not representable",
    toEncodableForm: () => serialized,
  };
}

/** A factory: a function carrying its module's members. */
function factoryArtifact(serialized: unknown): () => void {
  return Object.assign(() => {}, artifact(serialized));
}

describe("encodable-form", () => {
  describe("replaceArtifacts()", () => {
    describe("values carrying no artifact", () => {
      it("answers a record by identity", () => {
        const value = { a: 1, b: { c: [1, 2, 3] } };
        expect(flatten(value)).toBe(value);
      });

      it("answers a nested array by identity", () => {
        const value = [{ a: 1 }, [2, [3]]];
        expect(flatten(value)).toBe(value);
      });

      it("answers a value carrying a sparse hole by identity", () => {
        const value = [1, , 3];
        const result = flatten(value);
        expect(result).toBe(value);
        expect(1 in result).toBe(false);
      });
    });

    describe("replacement", () => {
      it("replaces a top-level artifact with its serialized form", () => {
        const result = flatten(
          artifact({ type: "javascript", implementation: "source" }),
        );
        expect(result).toEqual({
          type: "javascript",
          implementation: "source",
        });
      });

      it("replaces an artifact nested under records and arrays", () => {
        const value = {
          tools: { send: { handler: artifact({ serialized: true }) } },
          list: [artifact({ second: true })],
        };
        expect(flatten(value)).toEqual({
          tools: { send: { handler: { serialized: true } } },
          list: [{ second: true }],
        });
      });

      it("replaces a FUNCTION-shaped artifact", () => {
        // A factory is a function carrying its module's members, so an artifact
        // is reached in two shapes and both have to be covered. This is the
        // shape the live idiom produces: `tools: { x: { pattern: SomePattern } }`.
        const value = { tool: { pattern: factoryArtifact({ flat: true }) } };
        expect(flatten(value))
          .toEqual({ tool: { pattern: { flat: true } } });
      });

      it("reads each element once", () => {
        // The array sibling of the record case below, and the same hazard: a
        // copy built by re-reading runs an accessor-backed element a second
        // time and keeps that second answer, storing a value the array never
        // held at any single moment and which the walk never inspected.
        //
        // Order matters. The accessor sits BEFORE the artifact, so it has
        // already been read by the time the artifact forces a copy -- which is
        // exactly the window a copy-by-re-reading reads it in again.
        let reads = 0;
        const value: unknown[] = [];
        Object.defineProperty(value, 0, {
          enumerable: true,
          configurable: true,
          get() {
            reads++;
            return reads;
          },
        });
        value[1] = artifact({ flat: true });

        const result = flatten(value) as unknown[];
        expect(reads).toBe(1);
        expect(result[0]).toBe(1);
        expect(result[1]).toEqual({ flat: true });
      });

      it("reads each member once", () => {
        // A copy built by re-reading would run an accessor twice and keep the
        // second answer, recording a value the object never held at any single
        // moment.
        let reads = 0;
        const value = {
          artifact: artifact({ flat: true }),
          get accessor() {
            reads++;
            return reads;
          },
        };
        const result = flatten(value) as Record<string, unknown>;
        expect(reads).toBe(1);
        expect(result.accessor).toBe(1);
      });

      it("descends into the serialized form", () => {
        const value = artifact({ inner: artifact({ deep: true }) });
        expect(flatten(value)).toEqual({ inner: { deep: true } });
      });

      it("shares the subtrees it did not have to rebuild", () => {
        const untouched = { c: 3 };
        const value = { a: artifact({ flat: true }), b: untouched };
        const result = flatten(value);
        expect(result).not.toBe(value);
        expect(result.b).toBe(untouched);
      });

      it("preserves a hole in an array it rebuilds", () => {
        const value = [artifact({ flat: true }), , 3];
        const result = flatten(value);
        expect(result[0]).toEqual({ flat: true });
        expect(1 in result).toBe(false);
        expect(result[2]).toBe(3);
      });

      it("serializes a shared artifact once and keeps it shared", () => {
        let calls = 0;
        const shared = {
          toEncodableForm: () => {
            calls++;
            return { serialized: true };
          },
        };
        const result = flatten({
          first: shared,
          second: shared,
        });
        expect(calls).toBe(1);
        expect(result.first).toBe(result.second);
        expect(result.first).toEqual({ serialized: true });
      });

      it("makes the result representable as a `FabricValue`", () => {
        const value = { tools: { send: { handler: artifact({ ok: true }) } } };
        expect(fabricFromNativeValue(flatten(value)))
          .toEqual({ tools: { send: { handler: { ok: true } } } });
      });

      it("encodes to the same bytes as the serialized form written inline", () => {
        // The encoded form is what a content-derived id is minted from, so a
        // difference here is a difference in every id derived from a value
        // carrying an artifact. Flattening must arrive at exactly the encoding
        // of the form the artifact serializes to, key order included.
        const value = { tools: { send: { handler: artifact({ ok: true }) } } };
        const inline = { tools: { send: { handler: { ok: true } } } };
        expect(dataUriFromValue(fabricFromNativeValue(
          flatten(value),
        )))
          .toBe(dataUriFromValue(fabricFromNativeValue(inline)));
      });

      it("is the only route by which an artifact becomes representable", () => {
        // The conversion has no route of its own to an artifact's serializer:
        // an artifact names it `toEncodableForm`, which the conversion knows
        // nothing about. So flattening is load-bearing rather than an
        // optimization, and skipping it is a loud rejection.
        const value = { tools: { send: { handler: artifact({ ok: true }) } } };
        expect(() => fabricFromNativeValue(value))
          .toThrow(/function per se/);
      });
    });

    describe("values the conversion decides for itself", () => {
      it("leaves an array carrying an own serializer alone", () => {
        // An array is answered by the array rule whatever it carries.
        const value = Object.assign([1, 2], {
          toEncodableForm: () => "replaced",
        });
        expect(flatten(value)).toBe(value);
      });

      it("leaves a plain object carrying an own `toJSON` alone", () => {
        // `toJSON` is not how a builder artifact spells its serializer, so an
        // object bearing one is ordinary data as far as this is concerned, and
        // what becomes of it is the conversion's to decide.
        const value = { secret: "internal", toJSON: () => ({ exposed: true }) };
        expect(flatten({ value }).value).toBe(value);
      });

      it("leaves a class instance with a prototype serializer alone", () => {
        class Serializable {
          toEncodableForm() {
            return { serialized: true };
          }
        }
        const value = new Serializable();
        expect(flatten({ value }).value).toBe(value);
      });

      it("leaves a class instance with an own serializer alone", () => {
        class Bare {}
        const value = Object.assign(new Bare(), {
          toEncodableForm: () => "replaced",
        });
        expect(flatten({ value }).value).toBe(value);
      });

      it("leaves a null-prototype record alone", () => {
        const value: Record<string, unknown> = Object.assign(
          Object.create(null),
          { toEncodableForm: () => "replaced" },
        );
        expect(flatten({ value }).value).toBe(value);
      });

      it("leaves a cycle for the conversion to reject", () => {
        const value: Record<string, unknown> = { a: 1 };
        value.self = value;
        expect(flatten(value)).toBe(value);
        expect(() => fabricFromNativeValue(value)).toThrow(/circular/);
      });
    });

    describe("the copy callback", () => {
      // Identity-keyed facts -- trust, the content-addressed entry ref -- do not
      // travel with the bytes, so a caller is told about each copy in order to
      // carry them across. A copy nobody is told about is a dead end that no
      // comparison of the resulting value can detect.
      const copies = (value: unknown) => {
        const seen: { copy: unknown; original: unknown }[] = [];
        const result = replaceArtifacts(
          value,
          (copy, original) => seen.push({ copy, original }),
        );
        return { result, seen };
      };

      it("is told about a replaced artifact, naming the original", () => {
        const original = artifact({ flat: true });
        const { seen } = copies({ held: original });
        expect(seen.some((c) => c.original === original)).toBe(true);
      });

      it("is told about every container rebuilt around a replacement", () => {
        // The record holding the artifact is itself a new object, so it is a
        // copy too and has to be announced as one.
        const value = { outer: { inner: artifact({ flat: true }) } };
        const { result, seen } = copies(value);
        const originals = seen.map((c) => c.original);
        expect(originals).toContain(value);
        expect(originals).toContain(value.outer);
        const announced = seen.find((c) => c.original === value);
        expect(announced!.copy).toBe(result);
      });

      it("is NOT told about a value that came back unchanged", () => {
        // Answered by identity, so there is no copy and nothing to carry.
        const { seen } = copies({ a: 1, b: { c: [1, 2, 3] } });
        expect(seen).toEqual([]);
      });

      it("is told once about an artifact reached twice", () => {
        const shared = artifact({ flat: true });
        const { seen } = copies({ first: shared, second: shared });
        expect(seen.filter((c) => c.original === shared).length).toBe(1);
      });
    });
  });

  describe("hasEncodableForm()", () => {
    it("returns true for a value carrying `toEncodableForm`", () => {
      expect(hasEncodableForm({ toEncodableForm: () => ({}) })).toBe(true);
    });

    it("returns true for a value carrying only `toJSON`", () => {
      // A `Cell` answers only this name -- it is how a cell becomes a link --
      // and a cell is not a builder artifact. Dropping the fallback would stop
      // every such value producing a form at all.
      expect(hasEncodableForm({ toJSON: () => ({}) })).toBe(true);
    });

    it("returns true for an INHERITED member", () => {
      // Deliberately broader than the walk's own test: callers here ask about
      // a specific value they hold, not about every object in a graph.
      class Serializable {
        toEncodableForm() {
          return {};
        }
      }
      expect(hasEncodableForm(new Serializable())).toBe(true);
    });

    it("returns true for a FUNCTION carrying the member", () => {
      expect(hasEncodableForm(Object.assign(() => {}, {
        toEncodableForm: () => ({}),
      }))).toBe(true);
    });

    it("returns false for a value carrying neither name", () => {
      expect(hasEncodableForm({ a: 1 })).toBe(false);
    });

    it("returns false for a non-callable member of either name", () => {
      expect(hasEncodableForm({ toEncodableForm: 1, toJSON: 2 })).toBe(false);
    });

    it("returns false for `null` and for a primitive", () => {
      expect(hasEncodableForm(null)).toBe(false);
      expect(hasEncodableForm(7)).toBe(false);
      expect(hasEncodableForm("x")).toBe(false);
      expect(hasEncodableForm(undefined)).toBe(false);
    });
  });

  describe("encodableFormOf()", () => {
    it("answers what `toEncodableForm` returns", () => {
      expect(encodableFormOf({ toEncodableForm: () => ({ a: 1 }) }))
        .toEqual({ a: 1 });
    });

    it("falls back to `toJSON` when that is the only name", () => {
      expect(encodableFormOf({ toJSON: () => ({ b: 2 }) })).toEqual({ b: 2 });
    });

    it("prefers `toEncodableForm` when a value carries both", () => {
      // A builder artifact carries both, and `toJSON` merely delegates. The
      // order is what makes the runtime ask by the name that means it.
      const value = {
        toEncodableForm: () => ({ preferred: true }),
        toJSON: () => ({ preferred: false }),
      };
      expect(encodableFormOf(value)).toEqual({ preferred: true });
    });

    it("calls the member ON the value, so `this` is the receiver", () => {
      const value = {
        marker: "self",
        toEncodableForm(this: { marker: string }) {
          return { saw: this.marker };
        },
      };
      expect(encodableFormOf(value)).toEqual({ saw: "self" });
    });

    it("answers `undefined` for a value carrying neither name", () => {
      expect(encodableFormOf({ a: 1 })).toBe(undefined);
    });
  });
});
