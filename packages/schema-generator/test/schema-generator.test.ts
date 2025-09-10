import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { SchemaGenerator } from "../src/schema-generator.ts";
import { getTypeFromCode } from "./utils.ts";

describe("SchemaGenerator", () => {
  describe("formatter chain", () => {
    it("should route primitive types to PrimitiveFormatter", async () => {
      const generator = new SchemaGenerator();
      const { type, checker } = await getTypeFromCode(
        "type MyString = string;",
        "MyString",
      );

      const schema = generator.generateSchema(type, checker);
      expect(schema.type).toBe("string");
    });

    it("should route object types to ObjectFormatter", async () => {
      const generator = new SchemaGenerator();
      const { type, checker } = await getTypeFromCode(
        "interface MyObject { name: string; age: number; }",
        "MyObject",
      );

      const schema = generator.generateSchema(type, checker);
      expect(schema.type).toBe("object");
      expect(schema.properties).toBeDefined();
      expect(schema.properties?.name).toEqual({ type: "string" });
      expect(schema.properties?.age).toEqual({ type: "number" });
    });

    it("should route array types to ArrayFormatter", async () => {
      const generator = new SchemaGenerator();
      const { type, checker, typeNode } = await getTypeFromCode(
        "type MyArray = string[];",
        "MyArray",
      );

      const schema = generator.generateSchema(type, checker, typeNode);
      expect(schema.type).toBe("array");
      expect(schema.items).toBeDefined();
    });
  });

  describe("error handling", () => {
    it("should handle unknown types gracefully", async () => {
      const generator = new SchemaGenerator();
      // TypeScript 'unknown' type is handled by PrimitiveFormatter
      const { type, checker, typeNode } = await getTypeFromCode(
        "type T = unknown;",
        "T",
      );
      const schema = generator.generateSchema(type, checker, typeNode);
      expect(schema.type).toBe("object");
      expect(schema.additionalProperties).toBe(true);
    });
  });
});
