import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import "@commontools/utils/equal-ignoring-symbols";
import { JSONSchema } from "../src/builder/types.ts";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { validateAndTransform } from "../src/schema.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { toURI } from "../src/uri-utils.ts";
import { createAllOf } from "../src/link-resolution.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("createAllOf unit tests", () => {
  describe("Default extraction", () => {
    it("extracts default from last schema (last wins)", () => {
      const result = createAllOf([
        { type: "number", default: 1 },
        { type: "number", default: 2 },
      ]);

      expect(result).toEqual({
        allOf: [
          { type: "number" }, // default removed
          { type: "number" }, // default removed
        ],
        default: 2, // last wins
      });
    });

    it("doesn't extract default when only first schema has it", () => {
      const result = createAllOf([
        { type: "number", default: 1 },
        { type: "number" },
      ]);

      expect(result).toEqual({
        allOf: [
          { type: "number" }, // default removed
          { type: "number" },
        ],
        default: 1, // from first (only one with default)
      });
    });

    it("handles nested property defaults", () => {
      const result = createAllOf([
        { type: "object", properties: { x: { default: 1 } } },
        { type: "object", properties: { x: { default: 2 } } },
      ]);

      expect(result).toEqual({
        allOf: [
          { type: "object", properties: { x: { default: 1 } } }, // property-level defaults not extracted
          { type: "object", properties: { x: { default: 2 } } },
        ],
      });
    });
  });

  describe("asCell/asStream extraction", () => {
    it("extracts asCell from first schema (first wins)", () => {
      const result = createAllOf([
        { type: "string" },
        { type: "string", asCell: true },
        { type: "string", asCell: true },
      ]);

      expect(result).toEqual({
        allOf: [
          { type: "string" },
          { type: "string" }, // asCell removed
          { type: "string" }, // asCell removed
        ],
        asCell: true, // from first that has it (second schema)
      });
    });

    it("extracts asStream from first schema (first wins)", () => {
      const result = createAllOf([
        { type: "string", asStream: true },
        { type: "string", asStream: true },
      ]);

      expect(result).toEqual({
        allOf: [
          { type: "string" }, // asStream removed
          { type: "string" }, // asStream removed
        ],
        asStream: true, // from first
      });
    });

    it("extracts only first flag when both asCell and asStream present", () => {
      const result = createAllOf([
        { type: "string", asCell: true },
        { type: "string", asStream: true },
      ]);

      expect(result).toEqual({
        allOf: [
          { type: "string" }, // asCell removed
          { type: "string" }, // asStream removed (overridden by asCell)
        ],
        asCell: true, // first flag extracted
      });
    });

    it("extracts asStream when it appears first", () => {
      const result = createAllOf([
        { type: "string", asStream: true },
        { type: "string", asCell: true },
      ]);

      expect(result).toEqual({
        allOf: [
          { type: "string" }, // asStream removed
          { type: "string" }, // asCell removed (overridden by asStream)
        ],
        asStream: true, // first flag extracted
      });
    });
  });

  describe("Combined extraction", () => {
    it("extracts default (last) and asCell (first) together", () => {
      const result = createAllOf([
        { type: "number", default: 1, asCell: true },
        { type: "number", default: 2 },
      ]);

      expect(result).toEqual({
        allOf: [
          { type: "number" }, // both removed
          { type: "number" }, // default removed
        ],
        default: 2, // last wins
        asCell: true, // first wins
      });
    });
  });

  describe("Edge cases", () => {
    it("returns undefined for empty array", () => {
      const result = createAllOf([]);
      expect(result).toBeUndefined();
    });

    it("returns single schema unwrapped", () => {
      const result = createAllOf([{ type: "string" }]);
      expect(result).toEqual({ type: "string" });
    });

    it("extracts asCell from trivial schema (only has asCell)", () => {
      const result = createAllOf([
        { asCell: true },
        { type: "string" },
      ]);

      expect(result).toEqual({
        type: "string",
        asCell: true, // extracted from first (trivial) schema
      });
    });

    it("returns asCell when all schemas are trivial except asCell", () => {
      const result = createAllOf([
        { asCell: true },
        true,
        undefined as any,
      ]);

      expect(result).toEqual({
        asCell: true,
      });
    });

    it("filters out undefined and true schemas", () => {
      const result = createAllOf([
        undefined as any,
        { type: "number", default: 1 },
        true as any,
        { type: "number", default: 2 },
      ]);

      expect(result).toEqual({
        allOf: [
          { type: "number" },
          { type: "number" },
        ],
        default: 2,
      });
    });
  });
});

describe("allOf schema composition", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      blobbyServerUrl: import.meta.url,
      storageManager,
    });
    tx = runtime.edit();
  });

  afterEach(async () => {
    await tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
  });

  describe("Link chain composition", () => {
    it("combines schemas from link chain into allOf", () => {
      const schema1: JSONSchema = {
        type: "object",
        properties: {
          x: { type: "number", default: 10 },
        },
      };

      const schema2: JSONSchema = {
        type: "object",
        properties: {
          y: { type: "number", default: 20 },
        },
      };

      // Create first cell with data
      const cell1 = runtime.getCell(space, "cell1", schema1, tx);
      cell1.set({ x: 1 });

      // Create second cell with link to first and additional schema
      const cell2 = runtime.getCell(space, "cell2", schema2, tx);
      cell2.setRaw({
        "/": {
          "link@1": {
            id: toURI(cell1.entityId),
            schema: schema1,
          },
        },
      });

      // Read through link chain should combine schemas
      const result = cell2.get();

      // Should have x from actual value and y from default
      expect(result).toEqualIgnoringSymbols({ x: 1, y: 20 });
    });

    it("skips undefined/trivial schemas", () => {
      const cell = runtime.getCell(space, "trivial-test", undefined, tx);
      cell.set({ value: 42 });

      const result = validateAndTransform(
        runtime,
        tx,
        {
          id: toURI(cell.entityId),
          space,
          type: "application/json",
          path: [],
          schema: undefined, // Trivial schema
        },
      );

      expect(result).toBeDefined();
    });

    it("returns single schema when only one non-trivial", () => {
      const cell = runtime.getCell(space, "single-schema-test", undefined, tx);
      cell.set({ value: 42 });

      const schema: JSONSchema = {
        properties: {
          value: { type: "number" },
        },
      };

      const result = validateAndTransform(
        runtime,
        tx,
        {
          id: toURI(cell.entityId),
          space,
          type: "application/json",
          path: [],
          schema,
        },
      );

      expect(result).toEqualIgnoringSymbols({ value: 42 });
    });
  });

  describe("Default handling in allOf", () => {
    it("uses default from parent when value is undefined", () => {
      const cell = runtime.getCell(space, "test-undefined", undefined, tx);
      // Don't set any value, so it's undefined

      // Defaults are extracted to parent level at allOf creation time
      const schema: JSONSchema = {
        allOf: [
          { properties: { x: { type: "number" } } },
          { properties: { x: { type: "number" } } },
        ],
        default: { x: 2 }, // Extracted from last branch by createAllOf
      };

      const result = validateAndTransform(
        runtime,
        tx,
        {
          id: toURI(cell.entityId),
          space,
          type: "application/json",
          path: [],
          schema,
        },
      );

      expect(result).toEqualIgnoringSymbols({ x: 2 });
    });

    it("doesn't use parent default when value is empty object", () => {
      const cell = runtime.getCell(space, "test-empty", undefined, tx);
      cell.set({}); // Explicitly set to empty object

      // Defaults are extracted to parent level at allOf creation time
      const schema: JSONSchema = {
        allOf: [
          { properties: { x: { type: "number" } } },
          { properties: { x: { type: "number" } } },
        ],
        default: { x: 2 }, // This should NOT be used because value is {}, not undefined
      };

      const result = validateAndTransform(
        runtime,
        tx,
        {
          id: toURI(cell.entityId),
          space,
          type: "application/json",
          path: [],
          schema,
        },
      );

      expect(result).toEqualIgnoringSymbols({}); // Empty object, not { x: 2 }
    });

    it("merges properties from all branches with their defaults", () => {
      const cell = runtime.getCell(space, "test-props-merge", undefined, tx);
      cell.set({});

      // This schema represents what createAllOf would produce - properties from
      // all branches merged together, each keeping their own defaults
      const schema: JSONSchema = {
        allOf: [
          { type: "object", properties: { x: { default: "early" } } },
          { type: "object", properties: { y: { default: "middle" } } },
          { type: "object", properties: { z: { default: "late" } } },
        ],
      };

      const result = validateAndTransform(
        runtime,
        tx,
        {
          id: toURI(cell.entityId),
          space,
          type: "application/json",
          path: [],
          schema,
        },
      );

      expect(result).toEqualIgnoringSymbols({
        x: "early",
        y: "middle",
        z: "late",
      });
    });

    it("handles nested property defaults correctly", () => {
      const cell = runtime.getCell(space, "test-{}", undefined, tx);
      cell.set({});

      const schema: JSONSchema = {
        allOf: [
          {
            type: "object",
            properties: {
              user: {
                type: "object",
                properties: {
                  name: { default: "Alice" },
                },
              },
            },
          },
          {
            type: "object",
            properties: {
              settings: {
                type: "object",
                properties: {
                  theme: { default: "dark" },
                },
              },
            },
          },
        ],
      };

      const result = validateAndTransform(
        runtime,
        tx,
        {
          id: toURI(cell.entityId),
          space,
          type: "application/json",
          path: [],
          schema,
        },
      );

      expect(result).toEqualIgnoringSymbols({
        user: { name: "Alice" },
        settings: { theme: "dark" },
      });
    });
  });

  describe("asCell/asStream in allOf", () => {
    it("uses asCell as sibling of allOf", () => {
      const cell = runtime.getCell(space, "test-{}", undefined, tx);
      cell.set({});

      // After extraction by createAllOf, asCell would be at parent level
      // and removed from branches
      const schema: JSONSchema = {
        allOf: [
          { type: "object" }, // asCell removed by createAllOf
          { type: "object" }, // asCell removed by createAllOf
        ],
        asCell: true, // Extracted from first branch
      };

      const result = validateAndTransform(
        runtime,
        undefined,
        {
          id: toURI(cell.entityId),
          space,
          type: "application/json",
          path: [],
          schema,
        },
      );

      expect(result).toBeDefined();
    });
  });

  describe("Property merging in allOf", () => {
    it("unions properties from all branches", () => {
      const cell = runtime.getCell(space, "test-unions", undefined, tx);
      cell.set({ a: 1, b: 2, c: 3 });

      const schema: JSONSchema = {
        allOf: [
          { type: "object", properties: { a: { type: "number" } } },
          { type: "object", properties: { b: { type: "number" } } },
          { type: "object", properties: { c: { type: "number" } } },
        ],
      };

      const result = validateAndTransform(
        runtime,
        tx,
        {
          id: toURI(cell.entityId),
          space,
          type: "application/json",
          path: [],
          schema,
        },
      );

      // TODO(seefeld): Strict JSON Schema intersection would be empty (no
      // properties allowed by all branches) Current implementation unions
      // properties from all branches
      expect(result).toEqualIgnoringSymbols({ a: 1, b: 2, c: 3 });
    });

    it("creates nested allOf for duplicate properties", () => {
      const cell = runtime.getCell(space, "test-nested-allof", undefined, tx);
      cell.set({ x: {} });

      const schema: JSONSchema = {
        allOf: [
          {
            type: "object",
            properties: {
              x: {
                type: "object",
                properties: {
                  a: { default: 1 },
                },
              },
            },
          },
          {
            type: "object",
            properties: {
              x: {
                type: "object",
                properties: {
                  b: { default: 2 },
                },
              },
            },
          },
        ],
      };

      const result = validateAndTransform(
        runtime,
        undefined,
        {
          id: toURI(cell.entityId),
          space,
          type: "application/json",
          path: [],
          schema,
        },
      );

      // Both properties should be present
      expect(result.x).toEqualIgnoringSymbols({ a: 1, b: 2 });
    });

    it("handles deep nesting", () => {
      const cell = runtime.getCell(space, "test-{}", undefined, tx);
      cell.set({});

      const schema: JSONSchema = {
        allOf: [
          {
            type: "object",
            properties: {
              level1: {
                type: "object",
                properties: {
                  level2: {
                    type: "object",
                    properties: {
                      level3: { default: "deep" },
                    },
                  },
                },
              },
            },
          },
          {
            type: "object",
            properties: {
              level1: {
                type: "object",
                properties: {
                  other: { default: "value" },
                },
              },
            },
          },
        ],
      };

      const result = validateAndTransform(
        runtime,
        undefined,
        {
          id: toURI(cell.entityId),
          space,
          type: "application/json",
          path: [],
          schema,
        },
      );

      expect(result).toEqualIgnoringSymbols({
        level1: {
          level2: { level3: "deep" },
          other: "value",
        },
      });
    });
  });

  describe("Required field merging", () => {
    it("unions non-overlapping required fields (must satisfy all)", () => {
      const cell = runtime.getCell(space, "test-required-union", undefined, tx);
      cell.set({ a: 1, b: 2, c: 3 });

      const schema: JSONSchema = {
        allOf: [
          {
            type: "object",
            required: ["a"],
            properties: { a: { type: "number" } },
          },
          {
            type: "object",
            required: ["b"],
            properties: { b: { type: "number" } },
          },
          {
            type: "object",
            required: ["c"],
            properties: { c: { type: "number" } },
          },
        ],
      };

      const result = validateAndTransform(
        runtime,
        tx,
        {
          id: toURI(cell.entityId),
          space,
          type: "application/json",
          path: [],
          schema,
        },
      );

      // TODO(seefeld): Strict JSON Schema intersection would be empty Current
      // implementation unions properties from all branches
      expect(result).toEqualIgnoringSymbols({ a: 1, b: 2, c: 3 });
    });

    it("handles overlapping required fields", () => {
      const cell = runtime.getCell(
        space,
        "test-required-overlap",
        undefined,
        tx,
      );
      cell.set({ a: 1, b: 2 });

      const schema: JSONSchema = {
        allOf: [
          {
            type: "object",
            required: ["a", "b"],
            properties: { a: { type: "number" }, b: { type: "number" } },
          },
          {
            type: "object",
            required: ["a"], // Overlaps with first
            properties: { a: { type: "number" } },
          },
        ],
      };

      const result = validateAndTransform(
        runtime,
        tx,
        {
          id: toURI(cell.entityId),
          space,
          type: "application/json",
          path: [],
          schema,
        },
      );

      // TODO(seefeld): Strict intersection would only allow 'a' (common to both
      // branches) Current implementation unions properties from all branches
      expect(result).toEqualIgnoringSymbols({ a: 1, b: 2 });
    });

    it("handles required with additionalProperties", () => {
      const cell = runtime.getCell(
        space,
        "test-required-additional",
        undefined,
        tx,
      );
      cell.set({ a: 1, extra: "value" });

      const schema: JSONSchema = {
        allOf: [
          {
            type: "object",
            required: ["a"],
            properties: { a: { type: "number" } },
            additionalProperties: true,
          },
          {
            type: "object",
            properties: {},
            additionalProperties: true,
          },
        ],
      };

      const result = validateAndTransform(
        runtime,
        tx,
        {
          id: toURI(cell.entityId),
          space,
          type: "application/json",
          path: [],
          schema,
        },
      );

      // Required field 'a' must be present, additional properties allowed
      expect(result).toEqualIgnoringSymbols({ a: 1, extra: "value" });
    });
  });

  describe("Edge cases", () => {
    // enum not yet implemented.
    it.skip("preserves type constraints with enum", () => {
      const cell = runtime.getCell(space, "test-string-enum", undefined, tx);
      cell.set("valid");

      const schema: JSONSchema = {
        allOf: [
          { type: "string" },
          { enum: ["valid", "also-valid"] },
        ],
      };

      const result = validateAndTransform(
        runtime,
        tx,
        {
          id: toURI(cell.entityId),
          space,
          type: "application/json",
          path: [],
          schema,
        },
      );

      // Should preserve type/enum constraints even without object properties
      expect(result).toBe("valid");
    });

    it("handles empty allOf", () => {
      const cell = runtime.getCell(space, "test-{ value: 42 }", undefined, tx);
      cell.set({ value: 42 });

      const schema: JSONSchema = {
        allOf: [],
      };

      const result = validateAndTransform(
        runtime,
        undefined,
        {
          id: toURI(cell.entityId),
          space,
          type: "application/json",
          path: [],
          schema,
        },
      );

      expect(result).toBeUndefined();
    });

    it("handles allOf with only trivial schemas", () => {
      const cell = runtime.getCell(space, "test-{ value: 42 }", undefined, tx);
      cell.set({ value: 42 });

      const schema: JSONSchema = {
        allOf: [true, {}, true],
      };

      const result = validateAndTransform(
        runtime,
        undefined,
        {
          id: toURI(cell.entityId),
          space,
          type: "application/json",
          path: [],
          schema,
        },
      );

      expect(result).toBeUndefined();
    });
  });
});
