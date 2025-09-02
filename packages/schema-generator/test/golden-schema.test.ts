import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createSchemaTransformerV2 } from "../src/plugin.ts";
import { getTypeFromCode, normalizeSchema } from "./utils.ts";

describe("Golden schema deep-equality", () => {
  it("recursive Node: $ref + definitions", () => {
    const code = `
      interface Node { value: number; next?: Node; }
    `;
    const { type, checker } = getTypeFromCode(code, "Node");
    const schema = createSchemaTransformerV2()(type, checker);
    const expected = {
      $ref: "#/definitions/Node",
      definitions: {
        Node: {
          type: "object",
          properties: {
            value: { type: "number" },
            next: { $ref: "#/definitions/Node" },
          },
          required: ["value"],
        },
      },
    } as const;
    expect(normalizeSchema(schema)).toEqual(normalizeSchema(expected as any));
  });

  it("complex defaults: arrays, nested arrays, objects", () => {
    const code = `
      interface Default<T,V> {}
      interface TodoItem { title: string; done: boolean; }
      interface WithArrayDefaults {
        emptyItems: Default<TodoItem[], []>;
        prefilledItems: Default<string[], ["item1", "item2"]>;
        matrix: Default<number[][], [[1,2],[3,4]]>;
      }
      interface WithObjectDefaults {
        config: Default<{ theme: string; count: number }, { theme: "dark"; count: 10 }>;
        user: Default<{ name: string; settings: { notifications: boolean; email: string } }, { name: "Anonymous"; settings: { notifications: true; email: "user@example.com" } }>;
      }
    `;
    const gen = createSchemaTransformerV2();

    const a = getTypeFromCode(code, "WithArrayDefaults");
    const arraySchema = gen(a.type, a.checker);
    const expectedArray = {
      type: "object",
      properties: {
        emptyItems: {
          type: "array",
          items: {
            type: "object",
            properties: { title: { type: "string" }, done: { type: "boolean" } },
            required: ["title", "done"],
          },
          default: [],
        },
        prefilledItems: { type: "array", items: { type: "string" }, default: [
          "item1",
          "item2",
        ] },
        matrix: { type: "array", items: { type: "array", items: { type: "number" } }, default: [[1,2],[3,4]] },
      },
      required: ["emptyItems", "prefilledItems", "matrix"],
    } as const;
    expect(normalizeSchema(arraySchema)).toEqual(normalizeSchema(expectedArray as any));

    const o = getTypeFromCode(code, "WithObjectDefaults");
    const objectSchema = gen(o.type, o.checker);
    const expectedObject = {
      type: "object",
      properties: {
        config: {
          type: "object",
          properties: { theme: { type: "string" }, count: { type: "number" } },
          required: ["theme", "count"],
          default: { theme: "dark", count: 10 },
        },
        user: {
          type: "object",
          properties: {
            name: { type: "string" },
            settings: {
              type: "object",
              properties: { notifications: { type: "boolean" }, email: { type: "string" } },
              required: ["notifications", "email"],
            },
          },
          required: ["name", "settings"],
          default: { name: "Anonymous", settings: { notifications: true, email: "user@example.com" } },
        },
      },
      required: ["config", "user"],
    } as const;
    expect(normalizeSchema(objectSchema)).toEqual(normalizeSchema(expectedObject as any));
  });

  it("nested wrappers: Cell<Default<string,'d'>> and Default<string[], ['a','b']>", () => {
    const code = `
      interface Default<T,V> {}
      interface Cell<T> { get(): T; set(v: T): void; }
      interface X { cellOfDefault: Cell<Default<string, "d" >>; defaultArray: Default<string[], ["a", "b"]>; }
    `;
    const { type, checker } = getTypeFromCode(code, "X");
    const schema = createSchemaTransformerV2()(type, checker);
    const expected = {
      type: "object",
      properties: {
        cellOfDefault: { type: "string", default: "d", asCell: true },
        defaultArray: { type: "array", items: { type: "string" }, default: ["a","b"] },
      },
      required: ["cellOfDefault", "defaultArray"],
    } as const;
    expect(normalizeSchema(schema)).toEqual(normalizeSchema(expected as any));
  });
});

