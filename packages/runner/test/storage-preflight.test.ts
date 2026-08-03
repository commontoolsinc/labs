import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { fabricFromNativeValue } from "@commonfabric/data-model/fabric-value";
import { dataUriFromValue } from "@commonfabric/data-model/data-uri-codec";

import { flattenBuilderArtifacts } from "../src/storage-preflight.ts";

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

describe("flattenBuilderArtifacts()", () => {
  describe("values carrying no artifact", () => {
    it("answers a record by identity", () => {
      const value = { a: 1, b: { c: [1, 2, 3] } };
      expect(flattenBuilderArtifacts(value)).toBe(value);
    });

    it("answers a nested array by identity", () => {
      const value = [{ a: 1 }, [2, [3]]];
      expect(flattenBuilderArtifacts(value)).toBe(value);
    });

    it("answers a value carrying a sparse hole by identity", () => {
      const value = [1, , 3];
      const result = flattenBuilderArtifacts(value);
      expect(result).toBe(value);
      expect(1 in result).toBe(false);
    });
  });

  describe("replacement", () => {
    it("replaces a top-level artifact with its serialized form", () => {
      const result = flattenBuilderArtifacts(
        artifact({ type: "javascript", implementation: "source" }),
      );
      expect(result).toEqual({ type: "javascript", implementation: "source" });
    });

    it("replaces an artifact nested under records and arrays", () => {
      const value = {
        tools: { send: { handler: artifact({ serialized: true }) } },
        list: [artifact({ second: true })],
      };
      expect(flattenBuilderArtifacts(value)).toEqual({
        tools: { send: { handler: { serialized: true } } },
        list: [{ second: true }],
      });
    });

    it("replaces a FUNCTION-shaped artifact", () => {
      // A factory is a function carrying its module's members, so an artifact
      // is reached in two shapes and both have to be covered. This is the
      // shape the live idiom produces: `tools: { x: { pattern: SomePattern } }`.
      const value = { tool: { pattern: factoryArtifact({ flat: true }) } };
      expect(flattenBuilderArtifacts(value))
        .toEqual({ tool: { pattern: { flat: true } } });
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
      const result = flattenBuilderArtifacts(value) as Record<string, unknown>;
      expect(reads).toBe(1);
      expect(result.accessor).toBe(1);
    });

    it("descends into the serialized form", () => {
      const value = artifact({ inner: artifact({ deep: true }) });
      expect(flattenBuilderArtifacts(value)).toEqual({ inner: { deep: true } });
    });

    it("shares the subtrees it did not have to rebuild", () => {
      const untouched = { c: 3 };
      const value = { a: artifact({ flat: true }), b: untouched };
      const result = flattenBuilderArtifacts(value);
      expect(result).not.toBe(value);
      expect(result.b).toBe(untouched);
    });

    it("preserves a hole in an array it rebuilds", () => {
      const value = [artifact({ flat: true }), , 3];
      const result = flattenBuilderArtifacts(value);
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
      const result = flattenBuilderArtifacts({
        first: shared,
        second: shared,
      });
      expect(calls).toBe(1);
      expect(result.first).toBe(result.second);
      expect(result.first).toEqual({ serialized: true });
    });

    it("makes the result representable as a `FabricValue`", () => {
      const value = { tools: { send: { handler: artifact({ ok: true }) } } };
      expect(fabricFromNativeValue(flattenBuilderArtifacts(value)))
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
        flattenBuilderArtifacts(value),
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
      expect(flattenBuilderArtifacts(value)).toBe(value);
    });

    it("leaves a plain object carrying an own `toJSON` alone", () => {
      // `toJSON` is not how a builder artifact spells its serializer, so an
      // object bearing one is ordinary data as far as this is concerned, and
      // what becomes of it is the conversion's to decide.
      const value = { secret: "internal", toJSON: () => ({ exposed: true }) };
      expect(flattenBuilderArtifacts({ value }).value).toBe(value);
    });

    it("leaves a class instance with a prototype serializer alone", () => {
      class Serializable {
        toEncodableForm() {
          return { serialized: true };
        }
      }
      const value = new Serializable();
      expect(flattenBuilderArtifacts({ value }).value).toBe(value);
    });

    it("leaves a class instance with an own serializer alone", () => {
      class Bare {}
      const value = Object.assign(new Bare(), {
        toEncodableForm: () => "replaced",
      });
      expect(flattenBuilderArtifacts({ value }).value).toBe(value);
    });

    it("leaves a null-prototype record alone", () => {
      const value: Record<string, unknown> = Object.assign(
        Object.create(null),
        { toEncodableForm: () => "replaced" },
      );
      expect(flattenBuilderArtifacts({ value }).value).toBe(value);
    });

    it("leaves a cycle for the conversion to reject", () => {
      const value: Record<string, unknown> = { a: 1 };
      value.self = value;
      expect(flattenBuilderArtifacts(value)).toBe(value);
      expect(() => fabricFromNativeValue(value)).toThrow(/circular/);
    });
  });
});
