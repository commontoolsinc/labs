import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { JSONSchema } from "./builder/types.ts";
import { resolveSchema } from "./schema.ts";

describe("$ref with default support", () => {
  describe("resolveSchema() with default", () => {
    it("should preserve default from ref site when target has no default", () => {
      const schema: JSONSchema = {
        $defs: {
          String: { type: "string" },
        },
        $ref: "#/$defs/String",
        default: "ref-site-default",
      };

      const resolved = resolveSchema(schema, schema, false);
      expect(resolved).toEqual({
        type: "string",
        default: "ref-site-default",
      });
    });

    it("should use ref site default over target default (precedence)", () => {
      const schema: JSONSchema = {
        $defs: {
          String: { type: "string", default: "target-default" },
        },
        $ref: "#/$defs/String",
        default: "ref-site-default",
      };

      const resolved = resolveSchema(schema, schema, false);
      expect(resolved).toEqual({
        type: "string",
        default: "ref-site-default",
      });
    });

    it("should use target default when ref site has no default", () => {
      const schema: JSONSchema = {
        $defs: {
          String: { type: "string", default: "target-default" },
        },
        $ref: "#/$defs/String",
      };

      const resolved = resolveSchema(schema, schema, false);
      expect(resolved).toEqual({
        type: "string",
        default: "target-default",
      });
    });

    it("should handle chained refs with defaults at each level (outermost wins)", () => {
      const schema: JSONSchema = {
        $defs: {
          Level3: { type: "string", default: "level3" },
          Level2: { $ref: "#/$defs/Level3", default: "level2" },
          Level1: { $ref: "#/$defs/Level2", default: "level1" },
        },
        $ref: "#/$defs/Level1",
        default: "outermost",
      };

      const resolved = resolveSchema(schema, schema, false);
      // resolveSchema only resolves one level, so we still have a $ref
      expect(resolved).toHaveProperty("default", "outermost");
      expect(resolved).toHaveProperty("$ref");
    });

    it("should preserve default even when filterAsCell is true", () => {
      const schema: JSONSchema = {
        $defs: {
          String: { type: "string", asCell: true },
        },
        $ref: "#/$defs/String",
        default: "ref-default",
        asCell: true,
      };

      const resolved = resolveSchema(schema, schema, true);
      // asCell should be filtered, but default should remain
      expect(resolved).toEqual({
        type: "string",
        default: "ref-default",
      });
    });

    it("should handle boolean schema target with ref site default", () => {
      const schema: JSONSchema = {
        $defs: {
          AlwaysTrue: true,
        },
        $ref: "#/$defs/AlwaysTrue",
        default: "foo",
      };

      const resolved = resolveSchema(schema, schema, false);
      // Should convert boolean true to object to hold default
      expect(resolved).toEqual({
        default: "foo",
      });
    });

    it("should handle boolean false schema (cannot add default)", () => {
      const schema: JSONSchema = {
        $defs: {
          AlwaysFalse: false,
        },
        $ref: "#/$defs/AlwaysFalse",
        default: "foo",
      };

      const resolved = resolveSchema(schema, schema, false);
      // false schema means nothing validates, can't add default
      expect(resolved).toBeUndefined();
    });
  });

  describe("anyOf/oneOf with default", () => {
    it("should preserve default in anyOf options with refs", () => {
      const rootSchema: JSONSchema = {
        $defs: {
          String: { type: "string" },
          Number: { type: "number" },
        },
        anyOf: [
          { $ref: "#/$defs/String", default: "string-default" },
          { $ref: "#/$defs/Number", default: 42 },
        ],
      };

      // This would be used in validateAndTransform's anyOf handling
      const option1 = resolveSchema(rootSchema.anyOf![0], rootSchema, false);
      const option2 = resolveSchema(rootSchema.anyOf![1], rootSchema, false);

      expect(option1).toEqual({ type: "string", default: "string-default" });
      expect(option2).toEqual({ type: "number", default: 42 });
    });

    it("should apply ref site default to anyOf union as a whole", () => {
      const rootSchema: JSONSchema = {
        $defs: {
          StringOrNumber: {
            anyOf: [
              { type: "string", default: "str" },
              { type: "number", default: 42 },
            ],
          },
        },
        $ref: "#/$defs/StringOrNumber",
        default: "override",
      };

      const resolved = resolveSchema(rootSchema, rootSchema, false);

      expect(resolved).toEqual({
        anyOf: [
          { type: "string", default: "str" },
          { type: "number", default: 42 },
        ],
        default: "override",
      });
    });

    it("should preserve asCell and default together in anyOf options", () => {
      const rootSchema: JSONSchema = {
        $defs: {
          StringCell: { type: "string" },
        },
        anyOf: [
          { $ref: "#/$defs/StringCell", default: "cell-default", asCell: true },
          { type: "null" },
        ],
      };

      const option1 = resolveSchema(rootSchema.anyOf![0], rootSchema, false);

      expect(option1).toEqual({
        type: "string",
        default: "cell-default",
        asCell: true,
      });
    });
  });

  describe("edge cases", () => {
    it("should handle default with value of different types (number)", () => {
      const rootSchema: JSONSchema = {
        $defs: {
          Number: { type: "number" },
        },
        $ref: "#/$defs/Number",
        default: 42,
      };

      const resolved = resolveSchema(rootSchema, rootSchema, false);
      expect(resolved).toEqual({ type: "number", default: 42 });
    });

    it("should handle default with value of null", () => {
      const rootSchema: JSONSchema = {
        $defs: {
          Nullable: { type: ["string", "null"] },
        },
        $ref: "#/$defs/Nullable",
        default: null,
      };

      const resolved = resolveSchema(rootSchema, rootSchema, false);
      expect(resolved).toEqual({ type: ["string", "null"], default: null });
    });

    it("should handle default with array value", () => {
      const rootSchema: JSONSchema = {
        $defs: {
          StringArray: { type: "array", items: { type: "string" } },
        },
        $ref: "#/$defs/StringArray",
        default: ["item1", "item2"],
      };

      const resolved = resolveSchema(rootSchema, rootSchema, false);
      expect(resolved).toEqual({
        type: "array",
        items: { type: "string" },
        default: ["item1", "item2"],
      });
    });

    it("should handle default with object value", () => {
      const rootSchema: JSONSchema = {
        $defs: {
          Person: {
            type: "object",
            properties: {
              name: { type: "string" },
              age: { type: "number" },
            },
          },
        },
        $ref: "#/$defs/Person",
        default: { name: "John", age: 30 },
      };

      const resolved = resolveSchema(rootSchema, rootSchema, false);
      expect(resolved).toEqual({
        type: "object",
        properties: {
          name: { type: "string" },
          age: { type: "number" },
        },
        default: { name: "John", age: 30 },
      });
    });

    it("should not filter default when filterAsCell is true (unlike asCell)", () => {
      const rootSchema: JSONSchema = {
        $defs: {
          CellString: {
            type: "string",
            asCell: true,
            default: "target-default",
          },
        },
        $ref: "#/$defs/CellString",
        default: "ref-default",
        asCell: true,
      };

      const resolved = resolveSchema(rootSchema, rootSchema, true);

      // asCell should be filtered out, but default should remain
      expect(resolved).not.toHaveProperty("asCell");
      expect(resolved).toHaveProperty("default", "ref-default");
    });

    it("should handle ref with both asCell, asStream, and default", () => {
      const rootSchema: JSONSchema = {
        $defs: {
          StreamCell: { type: "string" },
        },
        $ref: "#/$defs/StreamCell",
        default: "ref-default",
        asCell: true,
        asStream: true,
      };

      const resolved = resolveSchema(rootSchema, rootSchema, false);

      expect(resolved).toEqual({
        type: "string",
        default: "ref-default",
        asCell: true,
        asStream: true,
      });
    });
  });
});
