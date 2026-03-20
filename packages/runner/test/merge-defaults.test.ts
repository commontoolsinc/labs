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

  describe("schema properties preserved", () => {
    it("should carry forward type, properties, and other schema fields", () => {
      const schema: JSONSchema = {
        type: "object",
        properties: { a: { type: "number" }, b: { type: "string" } },
        required: ["a"],
        default: { a: 1 },
      };
      const result = mergeDefaults(schema, { a: 2, b: "hi" });
      expect((result as any).type).toBe("object");
      expect((result as any).properties).toEqual({
        a: { type: "number" },
        b: { type: "string" },
      });
      expect((result as any).required).toEqual(["a"]);
      expect((result as any).default).toEqual({ a: 2, b: "hi" });
    });

    it("should carry forward $defs through cloning", () => {
      const schema: JSONSchema = {
        type: "object",
        $defs: { Foo: { type: "string" } },
        default: { x: 1 },
      };
      const result = mergeDefaults(schema, { x: 2 });
      expect((result as any).$defs).toEqual({ Foo: { type: "string" } });
    });
  });

  describe("object schema without existing default", () => {
    it("should assign defaultValue directly when schema.default is missing", () => {
      const schema: JSONSchema = {
        type: "object",
        properties: { a: { type: "number" } },
      };
      const result = mergeDefaults(schema, { a: 42 });
      // No existing default to merge with, so isRecord(result.default) is
      // false on the first pass — falls through to simple assignment.
      expect((result as any).default).toEqual({ a: 42 });
    });

    it("should assign defaultValue directly when schema.default is undefined", () => {
      const schema: JSONSchema = {
        type: "object",
        default: undefined,
      };
      const result = mergeDefaults(schema, { key: "val" });
      expect((result as any).default).toEqual({ key: "val" });
    });
  });

  describe("empty objects", () => {
    it("should handle empty defaultValue merged into non-empty default", () => {
      const schema: JSONSchema = {
        type: "object",
        default: { a: 1 },
      };
      const result = mergeDefaults(schema, {});
      expect((result as any).default).toEqual({ a: 1 });
    });

    it("should handle non-empty defaultValue merged into empty default", () => {
      const schema: JSONSchema = {
        type: "object",
        default: {},
      };
      const result = mergeDefaults(schema, { a: 1 });
      expect((result as any).default).toEqual({ a: 1 });
    });

    it("should handle both empty", () => {
      const schema: JSONSchema = {
        type: "object",
        default: {},
      };
      const result = mergeDefaults(schema, {});
      expect((result as any).default).toEqual({});
    });
  });

  describe("primitive defaultValues", () => {
    it("should handle numeric defaultValue", () => {
      const schema: JSONSchema = { type: "number" };
      const result = mergeDefaults(schema, 42);
      expect((result as any).default).toBe(42);
    });

    it("should handle boolean defaultValue", () => {
      const schema: JSONSchema = { type: "boolean" };
      const result = mergeDefaults(schema, true);
      expect((result as any).default).toBe(true);
    });

    it("should handle zero and empty string", () => {
      expect((mergeDefaults({ type: "number" }, 0) as any).default).toBe(0);
      expect((mergeDefaults({ type: "string" }, "") as any).default).toBe("");
    });
  });

  describe("edge cases", () => {
    it("should handle undefined schema", () => {
      const result = mergeDefaults(undefined, { a: 1 });
      expect((result as any).default).toEqual({ a: 1 });
    });

    it("should handle boolean true schema (pass-through)", () => {
      const result = mergeDefaults(true, "value");
      expect((result as any).default).toBe("value");
    });

    it("should handle boolean false schema (pass-through)", () => {
      const result = mergeDefaults(false, "value");
      expect((result as any).default).toBe("value");
    });

    it("should handle deeply nested defaultValue on object schema", () => {
      const schema: JSONSchema = {
        type: "object",
        default: { nested: { deep: 1 } },
      };
      const result = mergeDefaults(schema, { nested: { deep: 2, extra: 3 } });
      // Spread is shallow — nested object is replaced, not deep-merged.
      expect((result as any).default).toEqual({
        nested: { deep: 2, extra: 3 },
      });
    });
  });
});
