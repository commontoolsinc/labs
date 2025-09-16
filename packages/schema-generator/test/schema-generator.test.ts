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
      expect(typeof schema).toBe("object");
      expect((schema as any).type).toBe("string");
    });

    it("should route object types to ObjectFormatter", async () => {
      const generator = new SchemaGenerator();
      const { type, checker } = await getTypeFromCode(
        "interface MyObject { name: string; age: number; }",
        "MyObject",
      );

      const schema = generator.generateSchema(type, checker);
      expect(typeof schema).toBe("object");
      expect((schema as any).type).toBe("object");
      expect((schema as any).properties).toBeDefined();
      expect((schema as any).properties?.name).toEqual({ type: "string" });
      expect((schema as any).properties?.age).toEqual({ type: "number" });
    });

    it("should route array types to ArrayFormatter", async () => {
      const generator = new SchemaGenerator();
      const { type, checker, typeNode } = await getTypeFromCode(
        "type MyArray = string[];",
        "MyArray",
      );

      const schema = generator.generateSchema(type, checker, typeNode);
      expect(typeof schema).toBe("object");
      expect((schema as any).type).toBe("array");
      expect((schema as any).items).toBeDefined();
    });
  });

  describe("jsdoc integration", () => {
    it("prefers the comment closest to the type declaration", async () => {
      const generator = new SchemaGenerator();
      const code = `/*** Tool ***/

/**
 * Calculate the result of a mathematical expression.
 * Supports +, -, *, /, and parentheses.
 */
type CalculatorRequest = {
  /** The mathematical expression to evaluate. */
  expression: string;
};`;
      const { type, checker, typeNode } = await getTypeFromCode(
        code,
        "CalculatorRequest",
      );

      const schema = generator.generateSchema(type, checker, typeNode);
      const typedSchema = schema as Record<string, unknown>;
      const properties = typedSchema.properties as
        | Record<string, Record<string, unknown>>
        | undefined;

      expect(typedSchema.description).toBe(
        "Calculate the result of a mathematical expression.\n" +
          "Supports +, -, *, /, and parentheses.",
      );
      expect(properties?.expression?.description).toBe(
        "The mathematical expression to evaluate.",
      );
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
      // unknown/any returns {} which matches anything (primitives and objects)
      expect(schema).toEqual({});
    });
  });
});
