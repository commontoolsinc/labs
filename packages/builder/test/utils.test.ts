import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  isAlias,
  isModule,
  isRecipe,
  type JSONSchema,
  type Opaque,
} from "../src/types.ts";
import {
  createJsonSchema,
  getValueAtPath,
  hasValueAtPath,
  setValueAtPath,
} from "../src/utils.ts";
import { Runtime } from "@commontools/runner";

describe("value type", () => {
  it("can destructure a value without TS errors", () => {
    const { foo, bar }: { foo: Opaque<string>; bar: Opaque<string> } = {
      foo: "foo",
      bar: "bar",
    } as Opaque<{
      foo: string;
      bar: string;
    }>;
    expect(foo).toBe("foo");
    expect(bar).toBe("bar");
  });

  /* TODO: This used to work, i.e. it didn't throw any Typescript errors, and
   * stopped when we moved this into its own package. Nothing else seems to
   * break, so let's skip this for now.
   */
  /*
  it.skip("works for arrays as well without TS errors", () => {
    const [foo, bar]: [Value<string>, Value<number>] = ["foo", 1] as Value<
      [string, number]
    >;
    expect(foo).toBe("foo");
    expect(bar).toBe("bar");
  });*/
});

describe("utility functions", () => {
  it("isAlias correctly identifies aliases", () => {
    expect(isAlias({ $alias: { path: ["path", "to", "value"] } })).toBe(true);
    expect(isAlias({ notAlias: "something" })).toBe(false);
  });

  it("isModule correctly identifies modules", () => {
    expect(isModule({ type: "javascript", implementation: () => {} })).toBe(
      true,
    );
    expect(isModule({ notModule: "something" })).toBe(false);
  });

  it("isRecipe correctly identifies recipes", () => {
    expect(
      isRecipe({
        argumentSchema: {},
        resultSchema: {},
        initial: {},
        nodes: [],
      }),
    ).toBe(true);
    expect(isRecipe({ notRecipe: "something" })).toBe(false);
  });
});

describe("Path operations", () => {
  describe("setValueAtPath", () => {
    it("should set a value at the specified path", () => {
      const obj = {};
      setValueAtPath(obj, ["a", "b", "c"], 42);
      expect(obj).toEqual({ a: { b: { c: 42 } } });
    });

    it("should create arrays when encountering numeric keys", () => {
      const obj = {};
      setValueAtPath(obj, ["a", 0, "b"], "test");
      expect(obj).toEqual({ a: [{ b: "test" }] });
    });

    it("should overwrite existing values", () => {
      const obj = { x: { y: 1 } };
      setValueAtPath(obj, ["x", "y"], 2);
      expect(obj).toEqual({ x: { y: 2 } });
    });
  });

  describe("getValueAtPath", () => {
    const obj = { a: { b: { c: 42 } }, x: [{ y: "test" }] };

    it("should retrieve a value at the specified path", () => {
      expect(getValueAtPath(obj, ["a", "b", "c"])).toBe(42);
    });

    it("should work with array indices", () => {
      expect(getValueAtPath(obj, ["x", 0, "y"])).toBe("test");
    });

    it("should return undefined for non-existent paths", () => {
      expect(getValueAtPath(obj, ["a", "b", "d"])).toBeUndefined();
    });
  });

  describe("hasValueAtPath", () => {
    const obj = { a: { b: { c: 42 } }, x: [{ y: "test" }] };

    it("should return true for existing paths", () => {
      expect(hasValueAtPath(obj, ["a", "b", "c"])).toBe(true);
    });

    it("should work with array indices", () => {
      expect(hasValueAtPath(obj, ["x", 0, "y"])).toBe(true);
    });

    it("should return false for non-existent paths", () => {
      expect(hasValueAtPath(obj, ["a", "b", "d"])).toBe(false);
    });

    it("should return false for partially existing paths", () => {
      expect(hasValueAtPath(obj, ["a", "b", "c", "d"])).toBe(false);
    });
  });

  describe("hasValueAtPath for default values", () => {
    const store = {
      defaultValue: undefined,
    };

    it("should return false if the default value is undefined", () => {
      expect(hasValueAtPath(store, ["defaultValue"])).toBe(false);
    });
  });
});

describe("createJsonSchema", () => {
  let runtime: Runtime;

  beforeEach(() => {
    runtime = new Runtime({
      storageUrl: "volatile://",
    });
  });

  afterEach(async () => {
    await runtime?.dispose();
  });
  it("should create schema for primitive types", () => {
    expect(createJsonSchema("test")).toEqual({ type: "string" });
    expect(createJsonSchema(42)).toEqual({ type: "integer" });
    expect(createJsonSchema(3.14)).toEqual({ type: "number" });
    expect(createJsonSchema(true)).toEqual({ type: "boolean" });
    expect(createJsonSchema(null)).toEqual({ type: "null" });
    expect(createJsonSchema(undefined)).toEqual({});
  });

  it("should create schema for arrays", () => {
    const arraySchema = createJsonSchema(["a", "b", "c"]);
    expect(arraySchema).toEqual({
      type: "array",
      items: {
        type: "string",
      },
    });

    const mixedArraySchema = createJsonSchema([{ name: "item1" }, {
      name: "item2",
      value: 42,
    }]);
    expect(mixedArraySchema).toEqual({
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          value: { type: "integer" },
        },
      },
    });
  });

  it("should create schema for objects", () => {
    const objectSchema = createJsonSchema({
      string: "text",
      number: 123,
      boolean: true,
      nested: {
        array: [1, 2, 3],
        value: null,
      },
    });

    expect(objectSchema).toEqual({
      type: "object",
      properties: {
        string: { type: "string" },
        number: { type: "integer" },
        boolean: { type: "boolean" },
        nested: {
          type: "object",
          properties: {
            array: {
              type: "array",
              items: {
                type: "integer",
              },
            },
            value: { type: "null" },
          },
        },
      },
    });
  });

  it("should handle empty objects and arrays", () => {
    expect(createJsonSchema({})).toEqual({
      type: "object",
      properties: {},
    });

    expect(createJsonSchema([])).toEqual({
      type: "array",
      items: {},
    });
  });

  it("should handle complex nested structures", () => {
    const complexData = {
      users: [
        { id: 1, name: "Alice", active: true },
        { id: 2, name: "Bob", active: false },
      ],
      settings: {
        theme: "dark",
        notifications: {
          email: true,
          push: false,
        },
      },
    };

    const schema = createJsonSchema(complexData);

    expect(schema).toEqual({
      type: "object",
      properties: {
        users: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "integer" },
              name: { type: "string" },
              active: { type: "boolean" },
            },
          },
        },
        settings: {
          type: "object",
          properties: {
            theme: { type: "string" },
            notifications: {
              type: "object",
              properties: {
                email: { type: "boolean" },
                push: { type: "boolean" },
              },
            },
          },
        },
      },
    });
  });

  it("should use cell schema when available", () => {
    const cellWithSchema = runtime.getImmutableCell(
      "test-space",
      "cell@value.com",
      { type: "string", format: "email" },
    );

    const schema = createJsonSchema(cellWithSchema);
    expect(schema).toEqual({ type: "string", format: "email" });
  });

  it("should analyze cell value when no schema is provided", () => {
    const cellWithoutSchema = runtime.getImmutableCell(
      "test-space",
      {
        name: "John",
        age: 30,
        isActive: true,
      },
    );

    const schema = createJsonSchema(cellWithoutSchema);
    expect(schema).toEqual({
      type: "object",
      properties: {
        name: { type: "string" },
        age: { type: "integer" },
        isActive: { type: "boolean" },
      },
    });
  });

  it("should handle array cell without schema", () => {
    const arrayCell = runtime.getImmutableCell(
      "test-space",
      [1, 2, 3, 4],
    );

    const schema = createJsonSchema(arrayCell);

    expect(schema).toEqual({
      type: "array",
      items: {
        type: "integer",
      },
    });
  });

  it("should handle nested cells with and without schema", () => {
    const userCell = runtime.getImmutableCell(
      "test-space",
      { id: 1, name: "Alice" },
    );

    const prefsSchema = {
      type: "object",
      properties: {
        darkMode: { type: "boolean" },
        fontSize: { type: "integer" },
      },
    } as const satisfies JSONSchema;

    const prefsCell = runtime.getImmutableCell(
      "test-space",
      { darkMode: true, fontSize: 14 },
      prefsSchema,
    );

    const nestedObject = {
      user: userCell,
      preferences: prefsCell,
    };

    const schema = createJsonSchema(nestedObject);
    expect(schema).toEqual({
      type: "object",
      properties: {
        user: {
          type: "object",
          properties: {
            id: { type: "integer" },
            name: { type: "string" },
          },
        },
        preferences: {
          type: "object",
          properties: {
            darkMode: { type: "boolean" },
            fontSize: { type: "integer" },
          },
        },
      },
    });
  });

  it("should handle multidimensional array of numbers", () => {
    const data = [[1, 2, 3], [4, 5, 6], [7, 8, 9]];
    expect(createJsonSchema(data)).toEqual({
      type: "array",
      items: {
        type: "array",
        items: {
          type: "integer",
        },
      },
    });
  });

  it("should handle nested array of strings", () => {
    const data = {
      "recipes": [{
        "name": "Pasta Carbonara",
        "ingredients": [
          "200g spaghetti",
          "100g pancetta",
          "2 eggs",
          "50g pecorino cheese",
          "50g parmesan",
          "black pepper",
        ],
        "instructions":
          "Cook pasta. Fry pancetta. Mix eggs and cheese. Combine all ingredients while pasta is hot.",
      }],
    };
    expect(createJsonSchema(data)).toEqual({
      "type": "object",
      "properties": {
        "recipes": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "name": {
                "type": "string",
              },
              "ingredients": {
                "type": "array",
                "items": {
                  "type": "string",
                },
              },
              "instructions": {
                "type": "string",
              },
            },
          },
        },
      },
    });
  });
});
