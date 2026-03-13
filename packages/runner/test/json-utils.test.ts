import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";

import {
  createJsonSchema,
  toJSONWithLegacyAliases,
} from "../src/builder/json-utils.ts";
import { type JSONSchema } from "../src/builder/types.ts";
import { Runtime } from "../src/runtime.ts";
import { createCell } from "../src/cell.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("createJsonSchema", () => {
  let runtime: Runtime;
  let storageManager: ReturnType<typeof StorageManager.emulate>;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });

    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
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
    expect(mixedArraySchema).toEqual(
      {
        type: "array",
        items: {
          anyOf: [
            {
              type: "object",
              properties: {
                name: { type: "string" },
              },
            },
            {
              type: "object",
              properties: {
                name: { type: "string" },
                value: { type: "integer" },
              },
            },
          ],
        },
      } satisfies JSONSchema,
    );
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
      space,
      "cell@value.com",
      { type: "string", format: "email" },
    );

    const schema = createJsonSchema(cellWithSchema, false, runtime);
    expect(schema).toEqual({ type: "string", format: "email" });
  });

  it("should analyze cell value when no schema is provided", () => {
    const cellWithoutSchema = runtime.getImmutableCell(
      space,
      {
        name: "John",
        age: 30,
        isActive: true,
      },
    );

    const schema = createJsonSchema(cellWithoutSchema, false, runtime);
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
      space,
      [1, 2, 3, 4],
    );

    const schema = createJsonSchema(arrayCell, false, runtime);

    expect(schema).toEqual({
      type: "array",
      items: {
        type: "integer",
      },
    });
  });

  it("should handle nested cells with and without schema", () => {
    const userCell = runtime.getImmutableCell(
      space,
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
      space,
      { darkMode: true, fontSize: 14 },
      prefsSchema,
    );

    const nestedObject = {
      user: userCell,
      preferences: prefsCell,
    };

    const schema = createJsonSchema(nestedObject, false, runtime);
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
  it("should serialize shared object references correctly", () => {
    // Regression test: shared style objects used across siblings in .map()
    // should all serialize with full data, not {} for the 3rd+ occurrence.
    const sharedStyle = {
      background: "white",
      borderRadius: "8px",
      padding: "16px",
    };

    // Simulate a VNode-like tree where multiple siblings share the same style
    const tree = {
      type: "vnode",
      children: [
        { type: "vnode", props: { style: sharedStyle }, children: ["A"] },
        { type: "vnode", props: { style: sharedStyle }, children: ["B"] },
        { type: "vnode", props: { style: sharedStyle }, children: ["C"] },
        { type: "vnode", props: { style: sharedStyle }, children: ["D"] },
        { type: "vnode", props: { style: sharedStyle }, children: ["E"] },
      ],
    };

    const result = toJSONWithLegacyAliases(
      tree as any,
      new Map(),
    ) as any;

    // All 5 children should have the full style object
    for (let i = 0; i < 5; i++) {
      expect(result.children[i].props.style).toEqual({
        background: "white",
        borderRadius: "8px",
        padding: "16px",
      });
    }
  });

  it("should still guard against circular references", () => {
    const circular: any = { name: "root", child: {} };
    circular.child.parent = circular; // true circular reference

    const result = toJSONWithLegacyAliases(
      circular as any,
      new Map(),
    ) as any;

    // The root should serialize, but the circular back-reference should be {}
    expect(result.name).toEqual("root");
    expect(result.child.parent).toEqual({});
  });

  it("should handle shared nested objects at different depths", () => {
    const sharedMeta = { author: "test", version: 1 };
    const tree = {
      items: [
        { data: "a", meta: sharedMeta },
        { data: "b", meta: sharedMeta },
        { data: "c", nested: { deep: { meta: sharedMeta } } },
      ],
    };

    const result = toJSONWithLegacyAliases(
      tree as any,
      new Map(),
    ) as any;

    expect(result.items[0].meta).toEqual({ author: "test", version: 1 });
    expect(result.items[1].meta).toEqual({ author: "test", version: 1 });
    expect(result.items[2].nested.deep.meta).toEqual({
      author: "test",
      version: 1,
    });
  });

  it("should preserve false schema in toJSONWithLegacyAliases", () => {
    const cellWithFalseSchema = createCell(runtime, {
      space,
      schema: false,
      path: [],
    });

    const paths = new Map();
    // Cast to any to bypass strict type checks for test purposes
    paths.set(cellWithFalseSchema as any, ["path", "to", "cell"]);

    const result = toJSONWithLegacyAliases(
      cellWithFalseSchema as any,
      paths,
    );

    expect(result).toEqual({
      "$alias": {
        path: [
          "path",
          "to",
          "cell",
        ],
        schema: false,
      },
    });
  });
});
