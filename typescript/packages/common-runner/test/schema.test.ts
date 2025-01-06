import { describe, it, expect } from "vitest";
import { cell, isRendererCell } from "../src/cell.js";
import { JsonSchema } from "../src/schema.js";

describe("Schema Support", () => {
  describe("Basic Types", () => {
    it("should handle primitive types", () => {
      const c = cell({ 
        str: "hello",
        num: 42,
        bool: true
      });

      const schema: JsonSchema = {
        type: "object",
        properties: {
          str: { type: "string" },
          num: { type: "number" },
          bool: { type: "boolean" }
        }
      };

      const rendererCell = c.asRendererCell([], undefined, schema);
      const value = rendererCell.get();
      
      expect(value.str).toBe("hello");
      expect(value.num).toBe(42);
      expect(value.bool).toBe(true);
    });

    it("should handle nested objects", () => {
      const c = cell({
        user: {
          name: "John",
          settings: {
            theme: "dark"
          }
        }
      });

      const schema: JsonSchema = {
        type: "object",
        properties: {
          user: {
            type: "object",
            properties: {
              name: { type: "string" },
              settings: {
                type: "object",
                reference: true
              }
            }
          }
        }
      };

      const rendererCell = c.asRendererCell([], undefined, schema);
      const value = rendererCell.get();
      
      expect(value.user.name).toBe("John");
      expect(isRendererCell(value.user.settings)).toBe(true);
    });

    it("should handle arrays", () => {
      const c = cell({
        items: [1, 2, 3]
      });

      const schema: JsonSchema = {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: { type: "number" }
          }
        }
      };

      const rendererCell = c.asRendererCell([], undefined, schema);
      const value = rendererCell.get();
      
      expect(value.items).toEqual([1, 2, 3]);
    });
  });

  describe("Annotations", () => {
    it("should return RendererCell for reference properties", () => {
      const c = cell({
        id: 1,
        metadata: {
          createdAt: "2025-01-06",
          type: "user"
        }
      });

      const schema = {
        type: "object",
        properties: {
          id: { type: "number" },
          metadata: {
            type: "object",
            reference: true
          }
        }
      };

      const rendererCell = c.asRendererCell([], undefined, schema);
      const value = rendererCell.get();

      expect(value.id).toBe(1);
      expect(isRendererCell(value.metadata)).toBe(true);
      
      // The metadata cell should behave like a normal cell
      const metadataValue = value.metadata.get();
      expect(metadataValue.createdAt).toBe("2025-01-06");
      expect(metadataValue.type).toBe("user");
    });
  });

  describe("Schema References", () => {
    it("should handle self-references with $ref: '#'", () => {
      const c = cell({
        name: "root",
        children: [
          { name: "child1", children: [] },
          { name: "child2", children: [] }
        ]
      });

      const schema: JsonSchema = {
        type: "object",
        properties: {
          name: { type: "string" },
          children: {
            type: "array",
            items: { $ref: "#" }
          }
        }
      };

      const rendererCell = c.asRendererCell([], undefined, schema);
      const value = rendererCell.get();
      
      expect(value.name).toBe("root");
      expect(value.children[0].name).toBe("child1");
      expect(value.children[1].name).toBe("child2");
    });
  });

  describe("Key Navigation", () => {
    it("should preserve schema when using key()", () => {
      const c = cell({
        user: {
          profile: {
            name: "John",
            metadata: { id: 123 }
          }
        }
      });

      const schema: JsonSchema = {
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
                    reference: true
                  }
                }
              }
            }
          }
        }
      };

      const rendererCell = c.asRendererCell([], undefined, schema);
      const userCell = rendererCell.key("user");
      const profileCell = userCell.key("profile");
      const value = profileCell.get();
      
      expect(value.name).toBe("John");
      expect(isRendererCell(value.metadata)).toBe(true);
    });
  });
});
