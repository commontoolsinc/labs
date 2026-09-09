/** Checks default extraction from aliased records through both formatters. */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { SchemaGenerator } from "../../src/schema-generator.ts";
import { asObjectSchema, getTypeFromCode } from "../utils.ts";

describe("default-empty-record", () => {
  for (const form of ["union member", "two arguments"]) {
    describe(form, () => {
      for (
        const value of [
          "Record<string, never>",
          "Record<number, never>",
          "Record<symbol, never>",
          "Record<PropertyKey, never>",
          "{ [K in PropertyKey]: never }",
          "{ [key: string]: never }",
        ]
      ) {
        it(`emits an empty object default for an alias of \`${value}\``, async () => {
          const wrapped = form === "union member"
            ? "Record<string, unknown> | Default<Value>"
            : "Default<Record<string, unknown>, Value>";
          const { type, checker, typeNode } = await getTypeFromCode(
            `
            interface Default<T, V extends T = T> {}
            type Value = ${value};
            type SchemaRoot = ${wrapped};
            `,
            "SchemaRoot",
          );
          const schema = asObjectSchema(
            new SchemaGenerator().generateSchema(type, checker, typeNode),
          );

          expect(schema.default).toEqual({});
        });
      }

      for (
        const value of [
          "Record<string, string>",
          "Record<string, unknown>",
          'Record<"required", never>',
          "Record<string, never[]>",
          "{ [K in PropertyKey]: K extends string ? never : string }",
        ]
      ) {
        it(`omits the default for an alias of \`${value}\``, async () => {
          const wrapped = form === "union member"
            ? "Record<string, unknown> | Default<Value>"
            : "Default<Record<string, unknown>, Value>";
          const { type, checker, typeNode } = await getTypeFromCode(
            `
            interface Default<T, V extends T = T> {}
            type Value = ${value};
            type SchemaRoot = ${wrapped};
            `,
            "SchemaRoot",
          );
          const schema = asObjectSchema(
            new SchemaGenerator().generateSchema(type, checker, typeNode),
          );

          expect(schema).not.toHaveProperty("default");
        });
      }
    });
  }
});
