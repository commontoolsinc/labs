// Unit tests for resolveSchema — basic resolution behavior.
// Note: Robin's #3118 removed the filterAsCell parameter from resolveSchema,
// so these tests only cover the single-argument form.

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { resolveSchema } from "../src/schema.ts";
import type { JSONSchema, JSONSchemaObj } from "../src/builder/types.ts";
import {
  isNontrivialSchema,
  toDeepFrozenSchema,
} from "@commonfabric/data-model/schema-utils";
import { internSchema } from "@commonfabric/data-model/schema-hash";

/** Narrow a JSONSchema | undefined to JSONSchemaObj or fail the test. */
function expectNontrivial(
  schema: JSONSchema | undefined,
): JSONSchemaObj {
  if (!isNontrivialSchema(schema)) {
    throw new Error("expected a nontrivial schema object");
  }
  return schema;
}

describe("resolveSchema", () => {
  describe("basic behavior", () => {
    it("returns undefined for undefined", () => {
      expect(resolveSchema(undefined)).toBe(undefined);
    });

    it("returns undefined for empty object", () => {
      expect(resolveSchema({})).toBe(undefined);
    });

    it("returns undefined for boolean schema true", () => {
      expect(resolveSchema(true)).toBe(undefined);
    });

    it("returns undefined for boolean schema false", () => {
      expect(resolveSchema(false)).toBe(undefined);
    });

    it("returns an equal-but-frozen schema for a non-trivial schema", () => {
      const schema: JSONSchema = { type: "string" };
      const got = resolveSchema(schema);
      expect(got).toEqual(schema);
      expect(Object.isFrozen(got)).toBe(true);
    });

    it("preserves asCell in returned schema", () => {
      const schema: JSONSchema = { type: "string", asCell: true };
      const result = expectNontrivial(resolveSchema(schema));
      expect(result.asCell).toBe(true);
    });

    it("preserves asStream in returned schema", () => {
      const schema: JSONSchema = { type: "string", asStream: true };
      const result = expectNontrivial(resolveSchema(schema));
      expect(result.asStream).toBe(true);
    });
  });

  describe("canonical intern contract", () => {
    // `resolveSchema` returns the canonical interned reference for its
    // input's structural content. These tests pin down what that means at
    // the edges.

    it("returns an equal result for a deep-frozen-but-not-interned input", () => {
      // Uses a unique property name so this schema is unlikely to have
      // been interned by any other test or module load. That lets us
      // assert structural equality without having to know whether the
      // caller's reference is canonical.
      const schema: JSONSchema = toDeepFrozenSchema({
        type: "string",
        description: "resolve-schema-test-unique-marker-A",
      });
      const got = resolveSchema(schema);
      expect(got).toEqual(schema);
      expect(Object.isFrozen(got)).toBe(true);
    });

    it("returns the canonical interned reference when the input is content-equal to an already-interned schema", () => {
      // Intern a schema first, establishing the canonical reference.
      const canonical = internSchema({
        type: "string",
        description: "resolve-schema-test-unique-marker-B",
      });
      // Build a *different* (but content-equal) deep-frozen reference.
      const lookalike: JSONSchema = toDeepFrozenSchema({
        type: "string",
        description: "resolve-schema-test-unique-marker-B",
      });
      // `resolveSchema` must return the canonical reference, not the
      // caller's lookalike.
      const got = resolveSchema(lookalike);
      expect(got).toBe(canonical);
      expect(got === lookalike).toBe(false);
    });

    it("preserves the caller's reference when the input is already the canonical interned instance", () => {
      // An input that is itself the canonical instance short-circuits
      // through `internSchema`'s WeakMap and comes back unchanged.
      const canonical = internSchema({
        type: "string",
        description: "resolve-schema-test-unique-marker-C",
      });
      expect(resolveSchema(canonical)).toBe(canonical);
    });

    it("canonicalizes compound schemas across calls", () => {
      // Two content-equal non-interned inputs produce the same reference
      // on their respective `resolveSchema` calls, because both are
      // canonicalized through the intern cache.
      const first = resolveSchema({
        type: "object",
        description: "resolve-schema-test-unique-marker-D",
        properties: { name: { type: "string" } },
      });
      const second = resolveSchema({
        type: "object",
        description: "resolve-schema-test-unique-marker-D",
        properties: { name: { type: "string" } },
      });
      expect(first).toBe(second);
    });
  });
});
