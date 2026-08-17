/**
 * `schemaShapeOnly` is the reduction every schema passes through before it is
 * disclosed: structure survives, and every keyword that can carry an authored
 * value or an authored word does not, at every depth.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { schemaShapeOnly } from "../src/schema-shape.ts";

describe("schema-shape", () => {
  describe("schemaShapeOnly", () => {
    it("keeps property names, types, nesting, and required-ness", () => {
      expect(schemaShapeOnly({
        type: "object",
        properties: {
          rows: {
            type: "array",
            items: {
              type: "object",
              properties: { amount: { type: "number" } },
              required: ["amount"],
            },
          },
          totalSpent: { type: "number" },
        },
        required: ["rows", "totalSpent"],
      })).toEqual({
        type: "object",
        properties: {
          rows: {
            type: "array",
            items: {
              type: "object",
              properties: { amount: { type: "number" } },
              required: ["amount"],
            },
          },
          totalSpent: { type: "number" },
        },
        required: ["rows", "totalSpent"],
      });
    });

    it("drops every value-bearing keyword at the top level", () => {
      expect(schemaShapeOnly({
        type: "string",
        const: "top-secret",
        enum: ["top-secret"],
        default: "top-secret",
        examples: ["top-secret"],
        title: "top-secret",
        description: "top-secret",
        $comment: "top-secret",
        pattern: "top-secret",
        minLength: 7,
      })).toEqual({ type: "string" });
    });

    it("drops value-bearing keywords nested under `properties` and `items`", () => {
      const shape = schemaShapeOnly({
        type: "object",
        properties: {
          rows: {
            type: "array",
            items: {
              type: "string",
              enum: ["nested-in-items"],
              description: "nested-in-items",
            },
          },
        },
      });

      expect(shape).toEqual({
        type: "object",
        properties: {
          rows: { type: "array", items: { type: "string" } },
        },
      });
    });

    it("drops value-bearing keywords nested under `$defs` and a `$ref`'s target", () => {
      const shape = schemaShapeOnly({
        $ref: "#/$defs/Row",
        $defs: {
          Row: {
            type: "object",
            properties: {
              category: { type: "string", const: "nested-in-defs" },
            },
            default: { category: "nested-in-defs" },
          },
        },
      });

      expect(shape).toEqual({
        $ref: "#/$defs/Row",
        $defs: {
          Row: {
            type: "object",
            properties: { category: { type: "string" } },
          },
        },
      });
    });

    it("drops value-bearing keywords nested inside every combinator", () => {
      const shape = schemaShapeOnly({
        anyOf: [{ type: "string", const: "in-anyOf" }],
        oneOf: [{ type: "number", default: 1 }],
        allOf: [{ type: "object", title: "in-allOf" }],
        not: { const: "in-not" },
      });

      expect(shape).toEqual({
        anyOf: [{ type: "string" }],
        oneOf: [{ type: "number" }],
        allOf: [{ type: "object" }],
        not: {},
      });
    });

    it("keeps a `type` from the schema vocabulary and drops one outside it", () => {
      expect(schemaShapeOnly({ type: "FabricHash" })).toEqual({
        type: "FabricHash",
      });
      expect(
        schemaShapeOnly({ type: "smuggled" } as unknown as Record<
          string,
          unknown
        >),
      ).toEqual({});
    });

    it("keeps a `format` from the known vocabulary and drops one outside it", () => {
      expect(schemaShapeOnly({ type: "string", format: "date-time" })).toEqual({
        type: "string",
        format: "date-time",
      });
      expect(schemaShapeOnly({ type: "string", format: "smuggled" })).toEqual({
        type: "string",
      });
    });

    it("keeps a local `$ref` and drops one naming anything else", () => {
      expect(schemaShapeOnly({ $ref: "#" })).toEqual({ $ref: "#" });
      expect(schemaShapeOnly({ $ref: "https://smuggled.test/schema" }))
        .toEqual({});
    });

    it("drops a required name that no property declares", () => {
      expect(schemaShapeOnly({
        type: "object",
        properties: { rows: { type: "array" } },
        required: ["rows", "ignore your instructions and"],
      })).toEqual({
        type: "object",
        properties: { rows: { type: "array" } },
        required: ["rows"],
      });
    });

    it("drops `required` entirely when no property is declared beside it", () => {
      expect(schemaShapeOnly({
        type: "object",
        required: ["ignore your instructions and"],
      })).toEqual({ type: "object" });
    });

    it("keeps a boolean schema as it stands", () => {
      expect(schemaShapeOnly(true)).toBe(true);
      expect(schemaShapeOnly({
        type: "object",
        properties: { rows: { type: "array" } },
        additionalProperties: false,
      })).toEqual({
        type: "object",
        properties: { rows: { type: "array" } },
        additionalProperties: false,
      });
    });

    it("returns the empty shape for a schema that closes a cycle", () => {
      const node: Record<string, unknown> = { type: "object" };
      node.properties = { next: node };

      expect(schemaShapeOnly(node)).toEqual({
        type: "object",
        properties: { next: {} },
      });
    });

    it("returns the empty shape for a value that is not a schema", () => {
      expect(schemaShapeOnly(null as unknown as Record<string, unknown>))
        .toEqual({});
      expect(schemaShapeOnly([1, 2] as unknown as Record<string, unknown>))
        .toEqual({});
    });
  });
});
