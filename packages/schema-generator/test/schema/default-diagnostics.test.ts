/** Checks warnings for unresolved defaults and successful fallback extraction. */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  type SchemaGenerationDiagnostic,
  SchemaGenerator,
} from "../../src/index.ts";
import { asObjectSchema, getTypeFromCode, getTypeFromFiles } from "../utils.ts";

describe("default diagnostics", () => {
  for (
    const declaration of [
      "Default<string>",
      "Default<string, string>",
      "string | Default<string>",
      "Default<object, Record<string, string>>",
    ]
  ) {
    it(`warns when ${declaration} cannot supply a value`, async () => {
      const { type, checker, typeNode } = await getTypeFromCode(
        `interface Default<T, V extends T = T> {}
         type Root = ${declaration};`,
        "Root",
      );
      const diagnostics: SchemaGenerationDiagnostic[] = [];
      const schema = asObjectSchema(
        new SchemaGenerator().generateSchema(type, checker, typeNode, {
          onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
        }),
      );

      expect(schema).not.toHaveProperty("default");
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).toMatchObject({
        type: "schema-default:unresolved",
        severity: "warning",
      });
      expect(diagnostics[0]?.message).toContain("supplies no schema default");
      expect(diagnostics[0]?.node).toBeDefined();
    });
  }

  for (
    const [valueType, payload] of [
      ["string", "string"],
      ["string", '"first" | "second"'],
      ["object", "Record<string, string>"],
    ]
  ) {
    it(`warns for an expanded default with payload ${payload}`, async () => {
      const { type, checker, typeNode } = await getTypeFromCode(
        `declare const DEFAULT_MARKER: unique symbol;
         type Marker<V> = { readonly [DEFAULT_MARKER]: V };
         type Root = ${valueType} | (${valueType} & Marker<${payload}>);`,
        "Root",
      );
      const diagnostics: SchemaGenerationDiagnostic[] = [];
      const schema = asObjectSchema(
        new SchemaGenerator().generateSchema(type, checker, typeNode, {
          onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
        }),
      );

      expect(schema).not.toHaveProperty("default");
      expect(diagnostics).toHaveLength(1);
    });
  }

  it("preserves imported empty-object aliases without warning", async () => {
    const { type, checker } = await getTypeFromFiles(
      {
        "/types.ts": "export type Empty = {}; export type Alias = Empty;",
        "/main.ts": `
        import type { Alias } from "./types.ts";
        interface Default<T, V extends T = T> {}
        interface Root {
          direct: Default<Alias>;
          union: Record<string, unknown> | Default<Alias>;
          two: Default<Record<string, unknown>, Alias>;
        }
      `,
      },
      "/main.ts",
      "Root",
    );
    const diagnostics: SchemaGenerationDiagnostic[] = [];
    const schema = asObjectSchema(
      new SchemaGenerator().generateSchema(type, checker, undefined, {
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      }),
    );

    for (const name of ["direct", "union", "two"]) {
      expect(schema.properties?.[name]).toHaveProperty("default", {});
    }
    expect(diagnostics).toEqual([]);
  });

  it("does not warn for ordinary unions or falsy defaults", async () => {
    const { type, checker } = await getTypeFromCode(
      `interface Default<T, V extends T = T> {}
       interface Root {
         object: {} | string;
         array: string[] | [];
         text: Default<"">;
         number: Default<0>;
         flag: Default<false>;
         missing: Default<null>;
       }`,
      "Root",
    );
    const diagnostics: SchemaGenerationDiagnostic[] = [];
    const schema = asObjectSchema(
      new SchemaGenerator().generateSchema(type, checker, undefined, {
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      }),
    );

    expect(schema.properties?.text).toHaveProperty("default", "");
    expect(schema.properties?.number).toHaveProperty("default", 0);
    expect(schema.properties?.flag).toHaveProperty("default", false);
    expect(schema.properties?.missing).toHaveProperty("default", null);
    expect(diagnostics).toEqual([]);
  });
});
