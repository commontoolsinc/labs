/**
 * Unit tests for schema-utils-pure.ts
 *
 * Tests the pure schema discovery and building functions.
 * These functions only use stored schema (no registry fallback),
 * so they can run without the full commontools runtime.
 */
import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  buildExtractionSchemaFromCellPure,
  buildExtractionSchemaPure,
  getFieldToTypeMappingPure,
  getResultSchema,
  type JSONSchema,
} from "./schema-utils-pure.ts";
import type { SubPieceEntry } from "../types.ts";

describe("getResultSchema", () => {
  it("should extract resultSchema from a pattern-like object", () => {
    const mockPiece = {
      resultSchema: {
        type: "object",
        properties: {
          email: { type: "string" },
          phone: { type: "string" },
        },
      },
    };

    const schema = getResultSchema(mockPiece);
    expect(schema).toBeDefined();
    expect(schema?.properties).toHaveProperty("email");
    expect(schema?.properties).toHaveProperty("phone");
  });

  it("should return undefined for null/undefined", () => {
    expect(getResultSchema(null)).toBeUndefined();
    expect(getResultSchema(undefined)).toBeUndefined();
  });

  it("should return undefined for objects without resultSchema", () => {
    expect(getResultSchema({})).toBeUndefined();
    expect(getResultSchema({ foo: "bar" })).toBeUndefined();
  });

  it("should return undefined for non-object resultSchema", () => {
    expect(getResultSchema({ resultSchema: "not an object" })).toBeUndefined();
    expect(getResultSchema({ resultSchema: null })).toBeUndefined();
  });

  it("should handle primitive values", () => {
    expect(getResultSchema(42)).toBeUndefined();
    expect(getResultSchema("string")).toBeUndefined();
    expect(getResultSchema(true)).toBeUndefined();
  });
});

describe("buildExtractionSchemaPure", () => {
  it("should build combined schema from stored schemas", () => {
    const entries: SubPieceEntry[] = [
      {
        type: "contact",
        pinned: false,
        piece: {},
        schema: {
          type: "object",
          properties: {
            email: { type: "string" },
            phone: { type: "string" },
          },
        },
      },
      {
        type: "birthday",
        pinned: false,
        piece: {},
        schema: {
          type: "object",
          properties: {
            birthDate: { type: "string" },
          },
        },
      },
    ];

    const schema = buildExtractionSchemaPure(entries);
    expect(schema.type).toBe("object");
    expect(schema.properties).toHaveProperty("email");
    expect(schema.properties).toHaveProperty("phone");
    expect(schema.properties).toHaveProperty("birthDate");
  });

  it("should skip internal modules (type-picker, extract)", () => {
    const entries: SubPieceEntry[] = [
      {
        type: "contact",
        pinned: false,
        piece: {},
        schema: {
          type: "object",
          properties: { email: { type: "string" } },
        },
      },
      {
        type: "type-picker",
        pinned: false,
        piece: {},
        schema: {
          type: "object",
          properties: { internalField: { type: "string" } },
        },
      },
      {
        type: "extractor",
        pinned: false,
        piece: {},
        schema: {
          type: "object",
          properties: { rawText: { type: "string" } },
        },
      },
    ];

    const schema = buildExtractionSchemaPure(entries);
    expect(schema.properties).toHaveProperty("email");
    expect(schema.properties).not.toHaveProperty("internalField");
    expect(schema.properties).not.toHaveProperty("rawText");
  });

  it("should handle empty entries array", () => {
    const schema = buildExtractionSchemaPure([]);
    expect(schema.type).toBe("object");
    expect(Object.keys(schema.properties || {})).toHaveLength(0);
  });

  it("should handle entries without stored schema", () => {
    const entries: SubPieceEntry[] = [
      {
        type: "unknown-type",
        pinned: false,
        piece: {},
        // No schema stored
      },
    ];

    // Pure version just skips entries without schema
    const schema = buildExtractionSchemaPure(entries);
    expect(schema.type).toBe("object");
    expect(Object.keys(schema.properties || {})).toHaveLength(0);
  });

  it("should merge properties from multiple schemas", () => {
    const entries: SubPieceEntry[] = [
      {
        type: "a",
        pinned: false,
        piece: {},
        schema: { type: "object", properties: { fieldA: { type: "string" } } },
      },
      {
        type: "b",
        pinned: false,
        piece: {},
        schema: { type: "object", properties: { fieldB: { type: "number" } } },
      },
      {
        type: "c",
        pinned: false,
        piece: {},
        schema: { type: "object", properties: { fieldC: { type: "boolean" } } },
      },
    ];

    const schema = buildExtractionSchemaPure(entries);
    expect(Object.keys(schema.properties || {})).toHaveLength(3);
    expect((schema.properties?.fieldA as JSONSchema)?.type).toBe("string");
    expect((schema.properties?.fieldB as JSONSchema)?.type).toBe("number");
    expect((schema.properties?.fieldC as JSONSchema)?.type).toBe("boolean");
  });
});

describe("buildExtractionSchemaFromCellPure", () => {
  it("should work with Cell-like objects that have get()", () => {
    const mockCell = {
      get: () => [
        {
          type: "contact",
          pinned: false,
          piece: {},
          schema: {
            type: "object",
            properties: {
              email: { type: "string" },
            },
          },
        },
      ],
    };

    const schema = buildExtractionSchemaFromCellPure(mockCell);
    expect(schema.properties).toHaveProperty("email");
  });

  it("should handle null get() result", () => {
    const mockCell = { get: () => null };
    const schema = buildExtractionSchemaFromCellPure(mockCell);
    expect(schema.type).toBe("object");
    expect(Object.keys(schema.properties || {})).toHaveLength(0);
  });

  it("should handle undefined get() result", () => {
    const mockCell = { get: () => undefined };
    const schema = buildExtractionSchemaFromCellPure(mockCell);
    expect(schema.type).toBe("object");
    expect(Object.keys(schema.properties || {})).toHaveLength(0);
  });

  it("should handle missing get() method", () => {
    const mockCell = {};
    const schema = buildExtractionSchemaFromCellPure(mockCell);
    expect(schema.type).toBe("object");
  });
});

describe("getFieldToTypeMappingPure", () => {
  it("should create reverse mapping from fields to types", () => {
    const entries: SubPieceEntry[] = [
      {
        type: "contact",
        pinned: false,
        piece: {},
        schema: {
          type: "object",
          properties: {
            email: { type: "string" },
            phone: { type: "string" },
          },
        },
      },
      {
        type: "birthday",
        pinned: false,
        piece: {},
        schema: {
          type: "object",
          properties: {
            birthDate: { type: "string" },
          },
        },
      },
    ];

    const mapping = getFieldToTypeMappingPure(entries);
    expect(mapping.email).toBe("contact");
    expect(mapping.phone).toBe("contact");
    expect(mapping.birthDate).toBe("birthday");
  });

  it("should skip internal modules", () => {
    const entries: SubPieceEntry[] = [
      {
        type: "type-picker",
        pinned: false,
        piece: {},
        schema: {
          type: "object",
          properties: { internalField: { type: "string" } },
        },
      },
      {
        type: "extractor",
        pinned: false,
        piece: {},
        schema: {
          type: "object",
          properties: { rawText: { type: "string" } },
        },
      },
    ];

    const mapping = getFieldToTypeMappingPure(entries);
    expect(mapping).not.toHaveProperty("internalField");
    expect(mapping).not.toHaveProperty("rawText");
  });

  it("should handle empty entries", () => {
    const mapping = getFieldToTypeMappingPure([]);
    expect(Object.keys(mapping)).toHaveLength(0);
  });

  it("should handle entries without schema", () => {
    const entries: SubPieceEntry[] = [
      {
        type: "unknown",
        pinned: false,
        piece: {},
        // No schema
      },
    ];

    const mapping = getFieldToTypeMappingPure(entries);
    expect(Object.keys(mapping)).toHaveLength(0);
  });
});
