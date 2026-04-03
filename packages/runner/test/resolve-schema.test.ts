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
} from "@commontools/data-model/schema-utils";

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

  describe("frozen input handling", () => {
    it("returns the same schema for a non-trivial deep-frozen schema", () => {
      const schema: JSONSchema = toDeepFrozenSchema({ type: "string" });
      expect(resolveSchema(schema)).toBe(schema);
    });

    it("returns somewhat less trivial frozen input as-is", () => {
      const schema: JSONSchema = toDeepFrozenSchema({
        type: "object",
        properties: { name: { type: "string" } },
      }, true);
      expect(resolveSchema(schema)).toBe(schema);
    });
  });
});
