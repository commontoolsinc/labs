import { describe, it, expect } from "vitest";
import { Schema } from "../src/schema-to-ts.js";
import { Cell, getImmutableCell } from "../src/cell.js";
import { getDoc } from "../src/doc.js";

// Helper function to check type compatibility at compile time
// This doesn't run any actual tests, but ensures types are correct
function expectType<T, _U extends T>() {}

describe("Schema-to-TS Type Conversion", () => {
  // These tests verify the type conversion at compile time
  // They don't have runtime assertions but help ensure the Schema type works correctly

  it("should convert primitive types", () => {
    type StringSchema = Schema<{ type: "string" }>;
    type NumberSchema = Schema<{ type: "number" }>;
    type BooleanSchema = Schema<{ type: "boolean" }>;
    type NullSchema = Schema<{ type: "null" }>;

    // Verify type compatibility
    expectType<string, StringSchema>();
    expectType<number, NumberSchema>();
    expectType<boolean, BooleanSchema>();
    expectType<null, NullSchema>();
  });

  it("should convert object types", () => {
    type ObjectSchema = Schema<{
      type: "object";
      properties: {
        name: { type: "string" };
        age: { type: "number" };
        isActive: { type: "boolean" };
      };
      required: ["name", "age"];
    }>;

    // Expected type: { name: string; age: number; isActive?: boolean }
    type ExpectedType = {
      name: string;
      age: number;
      isActive?: boolean;
    };

    expectType<ExpectedType, ObjectSchema>();
  });

  it("should convert array types", () => {
    type StringArraySchema = Schema<{
      type: "array";
      items: { type: "string" };
    }>;

    type ObjectArraySchema = Schema<{
      type: "array";
      items: {
        type: "object";
        properties: {
          id: { type: "number" };
          name: { type: "string" };
        };
        required: ["id"];
      };
    }>;

    // Expected types
    type ExpectedStringArray = string[];
    type ExpectedObjectArray = Array<{ id: number; name?: string }>;

    expectType<ExpectedStringArray, StringArraySchema>();
    expectType<ExpectedObjectArray, ObjectArraySchema>();
  });

  /*  it("should handle enum values", () => {
    type ColorSchema = Schema<{
      enum: ["red", "green", "blue"];
    }>;

    type NumberEnumSchema = Schema<{
      enum: [1, 2, 3];
    }>;

    // Expected types
    type ExpectedColorEnum = "red" | "green" | "blue";
    type ExpectedNumberEnum = 1 | 2 | 3;

    expectType<ExpectedColorEnum, ColorSchema>();
    expectType<ExpectedNumberEnum, NumberEnumSchema>();
  });*/

  it("should handle oneOf and anyOf", () => {
    type AnyOfSchema1 = Schema<{
      anyOf: [{ type: "string" }, { type: "number" }];
    }>;

    type AnyOfSchema2 = Schema<{
      anyOf: [
        { type: "object"; properties: { name: { type: "string" } } },
        { type: "object"; properties: { id: { type: "number" } } },
      ];
    }>;

    type AnyOfSchema3 = Schema<{
      anyOf: [
        { type: "object"; properties: { name: { type: "string" } } },
        { type: "object"; properties: { id: { type: "number" } } },
        { type: "string" },
        { type: "number" },
      ];
    }>;

    // Expected types
    type ExpectedAnyOf1 = string | number;
    type ExpectedAnyOf2 = { name?: string } | { id?: number };
    type ExpectedAnyOf3 = { name?: string } | { id?: number } | string | number;

    expectType<ExpectedAnyOf1, AnyOfSchema1>();
    expectType<ExpectedAnyOf2, AnyOfSchema2>();
    expectType<ExpectedAnyOf3, AnyOfSchema3>();
  });

  /*  it("should handle allOf (type intersection)", () => {
    type AllOfSchema = Schema<{
      allOf: [
        { type: "object"; properties: { name: { type: "string" } } },
        { type: "object"; properties: { age: { type: "number" } } },
      ];
    }>;

    // Expected type: { name?: string; age?: number }
    type ExpectedAllOf = { name?: string } & { age?: number };

    expectType<ExpectedAllOf, AllOfSchema>();
  });*/

  it("should handle asCell attribute", () => {
    type CellSchema = Schema<{
      type: "object";
      properties: {
        value: { type: "number" };
      };
      asCell: true;
    }>;

    // Expected type: Cell<{ value?: number }>
    type ExpectedCell = Cell<{ value?: number }>;

    expectType<ExpectedCell, CellSchema>();
  });

  it("should handle nested asCell attributes", () => {
    type NestedCellSchema = Schema<{
      type: "object";
      properties: {
        user: {
          type: "object";
          properties: {
            name: { type: "string" };
            settings: {
              type: "object";
              properties: {
                theme: { type: "string" };
              };
              asCell: true;
            };
          };
        };
      };
    }>;

    // Expected type: { user?: { name?: string; settings: Cell<{ theme?: string }> } }
    type ExpectedNestedCell = {
      user?: {
        name?: string;
        settings: Cell<{ theme?: string }>;
      };
    };

    expectType<ExpectedNestedCell, NestedCellSchema>();
  });

  it("should handle $ref to root", () => {
    type RecursiveSchema = Schema<{
      type: "object";
      properties: {
        name: { type: "string" };
        children: {
          type: "array";
          items: { $ref: "#" };
        };
      };
    }>;

    // This is a recursive type, so we can't easily define the expected type
    // But we can verify it has the expected structure
    type ExpectedRecursive = {
      name?: string;
      children?: ExpectedRecursive[];
    };

    expectType<ExpectedRecursive, RecursiveSchema>();
  });

  it("should handle additionalProperties", () => {
    type StrictObjectSchema = Schema<{
      type: "object";
      properties: {
        id: { type: "number" };
      };
      additionalProperties: false;
    }>;

    type DynamicObjectSchema = Schema<{
      type: "object";
      properties: {
        id: { type: "number" };
      };
      additionalProperties: { type: "string" };
    }>;

    // Expected types
    type ExpectedStrictObject = { id?: number };
    type ExpectedDynamicObject = { id?: number; [key: string]: string | number | undefined };

    expectType<ExpectedStrictObject, StrictObjectSchema>();
    expectType<ExpectedDynamicObject, DynamicObjectSchema>();
  });

  // Runtime tests to verify the Schema type works with actual data
  it("should work with real data at runtime", () => {
    // Define a schema that uses various features
    const schema = {
      type: "object",
      properties: {
        name: { type: "string" },
        age: { type: "number" },
        tags: {
          type: "array",
          items: { type: "string" },
        },
        settings: {
          type: "object",
          properties: {
            theme: { type: "string" },
            notifications: { type: "boolean" },
          },
          asCell: true,
        },
      },
      required: ["name", "settings"],
    } as const;

    // Create a type from the schema
    type User = Schema<typeof schema>;

    // Create a cell with data matching the schema
    const settingsCell = getDoc({ theme: "dark", notifications: true });

    // This is just to verify the type works at runtime
    // We're not actually testing the Schema type itself, just that it's compatible
    const userData: User = {
      name: "John",
      age: 30,
      tags: ["developer", "typescript"],
      settings: settingsCell.asCell(),
    };

    const userCell = getImmutableCell(userData, schema);
    const user = userCell.get();

    expect(user.name).toBe("John");
    expect(user.age).toBe(30);
    expect(user.tags).toEqual(["developer", "typescript"]);
    expect(user.settings.get()).toEqual({ theme: "dark", notifications: true });
  });
});
