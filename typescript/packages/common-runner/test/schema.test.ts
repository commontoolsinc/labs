import { describe, it, expect } from "vitest";
import { getDoc, isCell } from "../src/cell.js";
import type { JSONSchema } from "@commontools/builder";

describe("Schema Support", () => {
  describe("Examples", () => {
    it("allows mapping of fields via interim cells", () => {
      const c = getDoc({
        id: 1,
        metadata: {
          createdAt: "2025-01-06",
          type: "user",
        },
        tags: ["a", "b"],
      });

      // This is what the system (or someone manually) would create to remap
      // data to match the desired schema
      const mappingCell = getDoc({
        // as-is
        id: { cell: c, path: ["id"] },
        // turn single value to set
        changes: [{ cell: c, path: ["metadata", "createdAt"] }],
        // rename field and uplift from nested element
        kind: { cell: c, path: ["metadata", "type"] },
        // turn set into a single value
        tag: { cell: c, path: ["tags", 0] },
      });

      // This schema is how the recipient specifies what they want
      const schema = {
        type: "object",
        properties: {
          id: { type: "number" },
          changes: { type: "array", items: { type: "string" } },
          kind: { type: "string" },
          tag: { type: "string" },
        },
      } as JSONSchema;

      expect(mappingCell.asCell([], undefined, schema).get()).toEqual({
        id: 1,
        changes: ["2025-01-06"],
        kind: "user",
        tag: "a",
      });
    });
  });

  describe("Basic Types", () => {
    it("should handle primitive types", () => {
      const c = getDoc({
        str: "hello",
        num: 42,
        bool: true,
      });

      const schema: JSONSchema = {
        type: "object",
        properties: {
          str: { type: "string" },
          num: { type: "number" },
          bool: { type: "boolean" },
        },
      };

      const cell = c.asCell([], undefined, schema);
      const value = cell.get();

      expect(value.str).toBe("hello");
      expect(value.num).toBe(42);
      expect(value.bool).toBe(true);
    });

    it("should handle nested objects", () => {
      const c = getDoc({
        user: {
          name: "John",
          settings: {
            theme: "dark",
          },
        },
      });

      const schema: JSONSchema = {
        type: "object",
        properties: {
          user: {
            type: "object",
            properties: {
              name: { type: "string" },
              settings: {
                type: "object",
                asCell: true,
              },
            },
          },
        },
      };

      const cell = c.asCell([], undefined, schema);
      const value = cell.get();

      expect(value.user.name).toBe("John");
      expect(isCell(value.user.settings)).toBe(true);
    });

    it("should handle arrays", () => {
      const c = getDoc({
        items: [1, 2, 3],
      });

      const schema: JSONSchema = {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: { type: "number" },
          },
        },
      };

      const cell = c.asCell([], undefined, schema);
      const value = cell.get();

      expect(value.items).toEqual([1, 2, 3]);
    });
  });

  describe("References", () => {
    it("should return a Cell for reference properties", () => {
      const c = getDoc({
        id: 1,
        metadata: {
          createdAt: "2025-01-06",
          type: "user",
        },
      });

      const schema = {
        type: "object",
        properties: {
          id: { type: "number" },
          metadata: {
            type: "object",
            asCell: true,
          },
        },
      } as JSONSchema;

      const cell = c.asCell([], undefined, schema);
      const value = cell.get();

      expect(value.id).toBe(1);
      expect(isCell(value.metadata)).toBe(true);

      // The metadata cell should behave like a normal cell
      const metadataValue = value.metadata.get();
      expect(metadataValue.createdAt).toBe("2025-01-06");
      expect(metadataValue.type).toBe("user");
    });

    it("Should support a reference at the root", () => {
      const c = getDoc({
        id: 1,
        nested: { id: 2 },
      });

      const schema = {
        type: "object",
        properties: {
          id: { type: "number" },
          nested: { $ref: "#", asCell: true },
        },
        asCell: true,
      } as JSONSchema;

      const cell = c.asCell([], undefined, schema);
      const value = cell.get();

      expect(isCell(value)).toBe(true);
      expect(value.get().id).toBe(1);
      expect(isCell(value.get().nested)).toBe(true);
      expect(value.get().nested.get().id).toBe(2);
    });
  });

  describe("Schema References", () => {
    it("should handle self-references with $ref: '#'", () => {
      const c = getDoc({
        name: "root",
        children: [
          { name: "child1", children: [] },
          { name: "child2", children: [] },
        ],
      });

      const schema: JSONSchema = {
        type: "object",
        properties: {
          name: { type: "string" },
          children: {
            type: "array",
            items: { $ref: "#" },
          },
        },
      };

      const cell = c.asCell([], undefined, schema);
      const value = cell.get();

      expect(value.name).toBe("root");
      expect(value.children[0].name).toBe("child1");
      expect(value.children[1].name).toBe("child2");
    });
  });

  describe("Key Navigation", () => {
    it("should preserve schema when using key()", () => {
      const c = getDoc({
        user: {
          profile: {
            name: "John",
            metadata: { id: 123 },
          },
        },
      });

      const schema: JSONSchema = {
        type: "object",
        properties: {
          user: {
            type: "object",
            properties: {
              profile: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  metadata: {
                    type: "object",
                    asCell: true,
                  },
                },
              },
            },
          },
        },
      };

      const cell = c.asCell([], undefined, schema);
      const userCell = cell.key("user");
      const profileCell = userCell.key("profile");
      const value = profileCell.get();

      expect(value.name).toBe("John");
      expect(isCell(value.metadata)).toBe(true);
    });
  });

  describe("AnyOf Support", () => {
    it("should select the correct candidate for primitive types (number)", () => {
      const c = getDoc({ value: 42 });
      const schema: JSONSchema = {
        type: "object",
        properties: {
          value: {
            anyOf: [{ type: "string" }, { type: "number" }],
          },
        },
      };

      const cell = c.asCell([], undefined, schema);
      const result = cell.get();
      expect(result.value).toBe(42);
    });

    it("should select the correct candidate for primitive types (string)", () => {
      const c = getDoc({ value: "hello" });
      const schema: JSONSchema = {
        type: "object",
        properties: {
          value: {
            anyOf: [{ type: "number" }, { type: "string" }],
          },
        },
      };

      const cell = c.asCell([], undefined, schema);
      const result = cell.get();
      expect(result.value).toBe("hello");
    });

    it("should merge object candidates in anyOf", () => {
      const c = getDoc({ item: { a: 100, b: "merged" } });
      const schema: JSONSchema = {
        type: "object",
        properties: {
          item: {
            anyOf: [
              { type: "object", properties: { a: { type: "number" } } },
              { type: "object", properties: { b: { type: "string" } } },
            ],
          },
        },
      };

      const cell = c.asCell([], undefined, schema);
      const result = cell.get();
      expect(result.item.a).toBe(100);
      expect(result.item.b).toBe("merged");
    });

    it("should return undefined if no anyOf candidate matches for primitive types", () => {
      const c = getDoc({ value: true });
      const schema: JSONSchema = {
        type: "object",
        properties: {
          value: {
            anyOf: [{ type: "number" }, { type: "string" }],
          },
        },
      };

      const cell = c.asCell([], undefined, schema);
      const result = cell.get();
      expect(result.value).toBeUndefined();
    });

    it("should return undefined when value is an object but no anyOf candidate is an object", () => {
      const c = getDoc({ value: { a: 1 } });
      const schema: JSONSchema = {
        type: "object",
        properties: {
          value: {
            anyOf: [{ type: "number" }, { type: "string" }],
          },
        },
      };

      const cell = c.asCell([], undefined, schema);
      const result = cell.get();
      expect(result.value).toBeUndefined();
    });

    it("should handle anyOf in array items", () => {
      const c = getDoc({ arr: [42, "test", true] });
      const schema: JSONSchema = {
        type: "object",
        properties: {
          arr: {
            type: "array",
            items: {
              anyOf: [{ type: "number" }, { type: "string" }],
            },
          },
        },
      };

      const cell = c.asCell([], undefined, schema);
      const result = cell.get();
      expect(result.arr[0]).toBe(42);
      expect(result.arr[1]).toBe("test");
      expect(result.arr[2]).toBeUndefined();
    });

    it("should select the correct candidate when mixing object and array candidates", () => {
      // Case 1: When the value is an object, the object candidate should be used.
      const cObject = getDoc({ mixed: { foo: "bar" } });
      const schemaObject: JSONSchema = {
        type: "object",
        properties: {
          mixed: {
            anyOf: [
              { type: "object", properties: { foo: { type: "string" } } },
              // Array candidate; this should be ignored for object inputs.
              { type: "array", items: { type: "string" } },
            ],
          },
        },
      };

      const cellObject = cObject.asCell([], undefined, schemaObject);
      const resultObject = cellObject.get();
      // Since the input is an object, the object candidate is selected.
      expect(resultObject.mixed.foo).toBe("bar");

      // Case 2: When the value is an array, the array candidate should be used.
      const cArray = getDoc({ mixed: ["bar", "baz"] });
      const schemaArray: JSONSchema = {
        type: "object",
        properties: {
          mixed: {
            anyOf: [
              // Object candidate; this should be ignored for array inputs.
              { type: "object", properties: { foo: { type: "string" } } },
              { type: "array", items: { type: "string" } },
            ],
          },
        },
      };

      const cellArray = cArray.asCell([], undefined, schemaArray);
      const resultArray = cellArray.get();
      // Verify that the array candidate is chosen and returns the intended array.
      expect(resultArray).toEqual({ mixed: ["bar", "baz"] });
      expect(Array.isArray(resultArray.mixed)).toBe(true);
      expect(resultArray.mixed).toEqual(["bar", "baz"]);
    });

    describe("Array anyOf Support", () => {
      it("should handle multiple array type options in anyOf", () => {
        const c = getDoc({
          data: [1, 2, 3],
        });
        const schema: JSONSchema = {
          type: "object",
          properties: {
            data: {
              anyOf: [
                { type: "array", items: { type: "number" } },
                { type: "array", items: { type: "string" } },
              ],
            },
          },
        };

        const cell = c.asCell([], undefined, schema);
        const result = cell.get();
        expect(result.data).toEqual([1, 2, 3]);
      });

      it("should merge item schemas when multiple array options exist", () => {
        const c = getDoc({
          data: ["hello", 42, true],
        });
        const schema: JSONSchema = {
          type: "object",
          properties: {
            data: {
              anyOf: [
                { type: "array", items: { type: "string" } },
                { type: "array", items: { type: "number" } },
              ],
            },
          },
        };

        const cell = c.asCell([], undefined, schema);
        const result = cell.get();
        // Should keep string and number values, drop boolean
        expect(result.data).toEqual(["hello", 42, undefined]);
      });

      it("should handle nested anyOf in array items", () => {
        const c = getDoc({
          data: [
            { type: "text", value: "hello" },
            { type: "number", value: 42 },
            { not: "matching", should: "be ignored" },
          ],
        });
        const schema: JSONSchema = {
          type: "object",
          properties: {
            data: {
              type: "array",
              items: {
                anyOf: [
                  {
                    type: "object",
                    properties: {
                      type: { type: "string" },
                      value: { type: "string" },
                    },
                  },
                  {
                    type: "object",
                    properties: {
                      type: { type: "string" },
                      value: { type: "number" },
                    },
                  },
                ],
              },
            },
          },
        };

        const cell = c.asCell([], undefined, schema);
        const result = cell.get();
        expect(result.data).toEqual([
          { type: "text", value: "hello" },
          { type: "number", value: 42 },
          {},
        ]);
      });

      it("should return empty array when no array options match", () => {
        const c = getDoc({
          data: { key: "value" },
        });
        const schema: JSONSchema = {
          type: "object",
          properties: {
            data: {
              anyOf: [
                { type: "array", items: { type: "string" } },
                { type: "array", items: { type: "number" } },
              ],
            },
          },
        };

        const cell = c.asCell([], undefined, schema);
        const result = cell.get();
        expect(result.data).toBeUndefined();
      });
    });
  });
});
