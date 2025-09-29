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
      // unknown returns false (reject all values)
      expect(schema).toEqual(false);
    });
  });

  describe("anonymous recursion", () => {
    it("hoists anonymous recursive types with synthetic definitions", async () => {
      const generator = new SchemaGenerator();
      const code = `
type Wrapper = {
  node: {
    value: string;
    next?: Wrapper["node"];
  };
};`;
      const { type, checker } = await getTypeFromCode(code, "Wrapper");

      const schema = generator.generateSchema(type, checker);
      const root = schema as Record<string, unknown>;
      const properties = root.properties as
        | Record<string, Record<string, unknown>>
        | undefined;
      const definitions = root.definitions as
        | Record<string, Record<string, unknown>>
        | undefined;

      expect(properties?.node).toEqual({
        $ref: "#/definitions/AnonymousType_1",
      });
      expect(definitions).toBeDefined();
      expect(Object.keys(definitions ?? {})).toContain("AnonymousType_1");
      expect(JSON.stringify(schema)).not.toContain(
        "Anonymous recursive type",
      );
    });
  });

  describe("built-in mappings", () => {
    it("formats Date as string with date-time format without hoisting", async () => {
      const generator = new SchemaGenerator();
      const code = `
interface HasDate {
  createdAt: Date;
}`;
      const { type, checker } = await getTypeFromCode(code, "HasDate");

      const schema = generator.generateSchema(type, checker);
      const objectSchema = schema as Record<string, unknown>;
      const props = objectSchema.properties as
        | Record<string, Record<string, unknown>>
        | undefined;

      expect(objectSchema.definitions).toBeUndefined();
      expect(props?.createdAt).toEqual({
        type: "string",
        format: "date-time",
      });
    });

    it("formats URL as string with uri format without hoisting", async () => {
      const generator = new SchemaGenerator();
      const code = `
interface HasUrl {
  homepage: URL;
}`;
      const { type, checker } = await getTypeFromCode(code, "HasUrl");

      const schema = generator.generateSchema(type, checker);
      const objectSchema = schema as Record<string, unknown>;
      const props = objectSchema.properties as
        | Record<string, Record<string, unknown>>
        | undefined;

      expect(objectSchema.definitions).toBeUndefined();
      expect(props?.homepage).toEqual({
        type: "string",
        format: "uri",
      });
    });

    it("formats Uint8Array as permissive true schema", async () => {
      const generator = new SchemaGenerator();
      const code = `
interface BinaryHolder {
  data: Uint8Array;
}`;
      const { type, checker } = await getTypeFromCode(code, "BinaryHolder");

      const schema = generator.generateSchema(type, checker);
      const objectSchema = schema as Record<string, unknown>;
      const props = objectSchema.properties as
        | Record<string, unknown>
        | undefined;

      expect(objectSchema.definitions).toBeUndefined();
      expect(props?.data).toBe(true);
    });

    it("formats ArrayBuffer as permissive true schema", async () => {
      const generator = new SchemaGenerator();
      const code = `
interface BufferHolder {
  buffer: ArrayBuffer;
}`;
      const { type, checker } = await getTypeFromCode(code, "BufferHolder");

      const schema = generator.generateSchema(type, checker);
      const objectSchema = schema as Record<string, unknown>;
      const props = objectSchema.properties as
        | Record<string, unknown>
        | undefined;

      expect(objectSchema.definitions).toBeUndefined();
      expect(props?.buffer).toBe(true);
    });

    it("collapses unions of native binary types", async () => {
      const generator = new SchemaGenerator();
      const code = `
interface HasImage {
  image: string | Uint8Array | ArrayBuffer | URL;
}`;
      const { type, checker } = await getTypeFromCode(code, "HasImage");

      const schema = generator.generateSchema(type, checker);
      const objectSchema = schema as Record<string, unknown>;
      const props = objectSchema.properties as
        | Record<string, Record<string, unknown> | boolean>
        | undefined;

      expect(objectSchema.definitions).toBeUndefined();
      expect(props?.image).toEqual({
        anyOf: [
          { type: "string" },
          true,
          true,
          { type: "string", format: "uri" },
        ],
      });
    });
  });
});
