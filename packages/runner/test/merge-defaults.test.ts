// Unit tests for mergeDefaults — the internal helper that builds a schema with
// a merged `.default` property for use by processDefaultValue/createCell.

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { deepFreeze } from "@commontools/data-model/deep-freeze";
import { mergeDefaults } from "../src/schema.ts";
import type { JSONSchema } from "../src/builder/types.ts";

describe("mergeDefaults", () => {
  describe("object-merge path", () => {
    it("should merge defaultValue keys into schema.default for object schemas", () => {
      const schema: JSONSchema = {
        type: "object",
        default: { a: 1, b: 2 },
      };
      const result = mergeDefaults(schema, { b: 99, c: 3 });
      expect(typeof result).toBe("object");
      expect((result as any).default).toEqual({ a: 1, b: 99, c: 3 });
    });

    it("should let defaultValue keys override schema.default keys", () => {
      const schema: JSONSchema = {
        type: "object",
        default: { name: "old", count: 0 },
      };
      const result = mergeDefaults(schema, { name: "new" });
      expect((result as any).default).toEqual({ name: "new", count: 0 });
    });
  });

  describe("simple-assignment path", () => {
    it("should replace entirely for array-type schemas", () => {
      const schema: JSONSchema = {
        type: "array",
        default: [1, 2, 3],
      };
      const result = mergeDefaults(schema, [4, 5]);
      expect((result as any).default).toEqual([4, 5]);
    });

    it("should replace entirely for string-type schemas", () => {
      const schema: JSONSchema = {
        type: "string",
        default: "old",
      };
      const result = mergeDefaults(schema, "new");
      expect((result as any).default).toBe("new");
    });

    it("should replace entirely when schema has no type", () => {
      const schema: JSONSchema = { default: "old" };
      const result = mergeDefaults(schema, "replacement");
      expect((result as any).default).toBe("replacement");
    });
  });

  describe("non-record defaultValue on object schema", () => {
    it("should replace (not merge) when defaultValue is null", () => {
      const schema: JSONSchema = {
        type: "object",
        default: { a: 1 },
      };
      const result = mergeDefaults(schema, null);
      expect((result as any).default).toBe(null);
    });

    it("should spread-merge when defaultValue is an array (arrays pass isRecord)", () => {
      // Arrays are records in JS, so they hit the merge path.
      // This is a known quirk — see the TODO in mergeDefaults.
      const schema: JSONSchema = {
        type: "object",
        default: { a: 1 },
      };
      const result = mergeDefaults(schema, [1, 2, 3]);
      expect((result as any).default).toEqual({
        "0": 1,
        "1": 2,
        "2": 3,
        a: 1,
      });
    });

    it("should replace (not merge) when defaultValue is a string", () => {
      const schema: JSONSchema = {
        type: "object",
        default: { a: 1 },
      };
      const result = mergeDefaults(schema, "not an object");
      expect((result as any).default).toBe("not an object");
    });
  });

  describe("frozen input schema", () => {
    it("should work correctly with a deep-frozen input schema", () => {
      const schema = deepFreeze({
        type: "object",
        properties: { x: { type: "number" } },
        default: { x: 10 },
      }) as JSONSchema;
      expect(Object.isFrozen(schema)).toBe(true);

      const result = mergeDefaults(schema, { x: 42, y: 7 });
      expect((result as any).type).toBe("object");
      expect((result as any).default).toEqual({ x: 42, y: 7 });
    });

    it("should work correctly with a deep-frozen non-object schema", () => {
      const schema = deepFreeze({
        type: "string",
        default: "frozen",
      }) as JSONSchema;

      const result = mergeDefaults(schema, "thawed");
      expect((result as any).default).toBe("thawed");
    });
  });

  describe("isolation (structuredClone)", () => {
    it("should not modify the original schema object", () => {
      const original: JSONSchema = {
        type: "object",
        default: { a: 1, b: 2 },
        properties: { a: { type: "number" } },
      };
      const originalDefault = (original as any).default;

      mergeDefaults(original, { b: 99 });

      expect((original as any).default).toBe(originalDefault);
      expect((original as any).default).toEqual({ a: 1, b: 2 });
    });

    it("should return a new object (not the same reference)", () => {
      const schema: JSONSchema = { type: "object", default: { a: 1 } };
      const result = mergeDefaults(schema, { b: 2 });
      expect(result).not.toBe(schema);
    });
  });

  describe("edge cases", () => {
    it("should handle undefined schema", () => {
      const result = mergeDefaults(undefined, { a: 1 });
      expect((result as any).default).toEqual({ a: 1 });
    });

    it("should handle boolean schema (pass-through)", () => {
      const result = mergeDefaults(true, "value");
      expect((result as any).default).toBe("value");
    });
  });
});
