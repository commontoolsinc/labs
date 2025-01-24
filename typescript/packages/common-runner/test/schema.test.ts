import { describe, it } from "jsr:@std/testing/bdd";
import { expect } from "jsr:@std/expect";
import { getDoc, isCell } from "../src/cell.ts";
import { JSONSchema } from "@commontools/builder";

describe("Schema Support", () => {
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
});
