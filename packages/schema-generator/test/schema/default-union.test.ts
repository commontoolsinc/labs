import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createSchemaTransformerV2 } from "../../src/plugin.ts";
import { asObjectSchema, getTypeFromCode, getTypeFromFiles } from "../utils.ts";

describe("Schema: Default in unions", () => {
  it("applies primitive defaults from T | Default<V>", async () => {
    const code = `
      interface Default<T, V extends T = T> {}
      interface X {
        title: string | Default<"">;
        count: number | Default<0>;
        enabled: boolean | Default<false>;
      }
    `;
    const { type, checker } = await getTypeFromCode(code, "X");
    const result = asObjectSchema(
      createSchemaTransformerV2().generateSchema(type, checker),
    );

    const title = result.properties?.title as any;
    expect(title.type).toBe("string");
    expect(title.default).toBe("");

    const count = result.properties?.count as any;
    expect(count.type).toBe("number");
    expect(count.default).toBe(0);

    const enabled = result.properties?.enabled as any;
    expect(enabled.type).toBe("boolean");
    expect(enabled.default).toBe(false);
  });

  it("applies defaults through aliased union types", async () => {
    const code = `
      interface Default<T, V extends T = T> {}
      type WithDefault = string | Default<"">;
      interface X {
        title: WithDefault;
      }
    `;
    const { type, checker } = await getTypeFromCode(code, "X");
    const result = asObjectSchema(
      createSchemaTransformerV2().generateSchema(type, checker),
    );

    const title = result.properties?.title as any;
    expect(title.$ref).toBe("#/$defs/WithDefault");
    expect((result as any).$defs?.WithDefault).toEqual({
      type: "string",
      default: "",
    });
  });

  it("applies defaults through imported aliased union types", async () => {
    const { type, checker } = await getTypeFromFiles(
      {
        "/types.ts": `
        export interface Default<T, V extends T = T> {}
        export type WithDefault = string | Default<"">;
      `,
        "/main.ts": `
        import type { WithDefault } from "./types.ts";
        export interface X {
          title: WithDefault;
        }
      `,
      },
      "/main.ts",
      "X",
    );
    const result = asObjectSchema(
      createSchemaTransformerV2().generateSchema(type, checker),
    );

    const title = result.properties?.title as any;
    expect(title.$ref).toBe("#/$defs/WithDefault");
    expect((result as any).$defs?.WithDefault).toEqual({
      type: "string",
      default: "",
    });
  });

  it("does not treat same-name imported aliases as circular", async () => {
    const { type, checker } = await getTypeFromFiles(
      {
        "/base.ts": `
        export interface Default<T, V extends T = T> {}
        export type WithDefault = string | Default<"">;
      `,
        "/wrapper.ts": `
        import type { WithDefault as ImportedWithDefault } from "./base.ts";
        export type WithDefault = ImportedWithDefault;
      `,
        "/main.ts": `
        import type { WithDefault } from "./wrapper.ts";
        export interface X {
          title: WithDefault;
        }
      `,
      },
      "/main.ts",
      "X",
    );
    const result = asObjectSchema(
      createSchemaTransformerV2().generateSchema(type, checker),
    );

    const title = result.properties?.title as any;
    expect(title.$ref).toBe("#/$defs/WithDefault");
    expect((result as any).$defs?.WithDefault).toEqual({
      type: "string",
      default: "",
    });
  });

  it("applies null defaults from T | Default<null>", async () => {
    const code = `
      interface Default<T, V extends T = T> {}
      type T = string | Default<null>;
    `;
    const { type, checker, typeNode } = await getTypeFromCode(code, "T");
    const result = asObjectSchema(
      createSchemaTransformerV2().generateSchema(type, checker, typeNode),
    );

    expect(result.anyOf).toEqual(expect.arrayContaining([
      { type: "string" },
      { type: "null" },
    ]));
    expect(result.default).toBe(null);
  });

  it("collapses an EXPANDED Default<[]> array union, preserving comparable items (CT-1639)", async () => {
    // The transformer hands schema-gen a node where Default<[]> has already been
    // EXPANDED by the checker into its raw branded form — there is no `Default<>`
    // alias node left. We model that directly: `[] & DefaultMarker<[]>` plus the
    // bare `[]` empty-array member, unioned with the real comparable array. The
    // degenerate empty members must collapse so the comparable array survives
    // (single array schema, asCell:["comparable"] kept, default: []).
    const code = `
      declare const DEFAULT_MARKER: unique symbol;
      type DefaultMarker<T> = { readonly [DEFAULT_MARKER]: T };
      interface Item { label: string }
      type T = Array<ComparableCell<Item>> | ([] & DefaultMarker<[]>) | [];
    `;
    const { type, checker, typeNode } = await getTypeFromCode(code, "T");
    const result = asObjectSchema(
      createSchemaTransformerV2().generateSchema(type, checker, typeNode),
    );

    // Comparable items must be preserved on the (sole) array schema.
    const arraySchema = result.anyOf
      ? (result.anyOf as any[]).find((s) =>
        s?.type === "array" && s?.items?.asCell
      )
      : result;
    expect((arraySchema?.items as any)?.asCell).toEqual(["comparable"]);
    // And the empty-only degenerate branch must not survive as a sibling that
    // dilutes consumers: no `{ type: "array", items: false }` branch.
    if (result.anyOf) {
      const hasEmptyOnly = (result.anyOf as any[]).some((s) =>
        s?.type === "array" && s?.items === false
      );
      expect(hasEmptyOnly).toBe(false);
    }
  });

  it("does NOT fabricate a default for an ordinary array | empty-tuple union (no Default brand) (CT-1639)", async () => {
    // A plain `string[] | []` has a bare empty-tuple member but NO Default brand.
    // The expanded-Default collapse must not fire here — it would invent a
    // `default: []` the author never asked for. (Regression for a cubic review
    // finding on the CT-1639 pt-1 PR.)
    const code = `type T = string[] | [];`;
    const { type, checker, typeNode } = await getTypeFromCode(code, "T");
    const result = asObjectSchema(
      createSchemaTransformerV2().generateSchema(type, checker, typeNode),
    );
    expect((result as any).default).toBeUndefined();
  });

  it("applies array defaults from T[] | Default<[...]>", async () => {
    const code = `
      interface Default<T, V extends T = T> {}
      type T = string[] | Default<["a", "b"]>;
    `;
    const { type, checker, typeNode } = await getTypeFromCode(code, "T");
    const result = asObjectSchema(
      createSchemaTransformerV2().generateSchema(type, checker, typeNode),
    );

    expect(result.type).toBe("array");
    expect((result.items as any)?.type).toBe("string");
    expect(result.default).toEqual(["a", "b"]);
  });

  it("applies object defaults from T | Default<V>", async () => {
    const code = `
      interface Default<T, V extends T = T> {}
      interface Config {
        theme: string;
      }
      type T = Config | Default<{ theme: "dark" }>;
    `;
    const { type, checker, typeNode } = await getTypeFromCode(code, "T");
    const result = asObjectSchema(
      createSchemaTransformerV2().generateSchema(type, checker, typeNode),
    );

    expect(result.$ref).toBe("#/$defs/Config");
    const config = (result as any).$defs?.Config;
    expect(config.type).toBe("object");
    expect(config.properties?.theme).toEqual({ type: "string" });
    expect(config.required).toEqual(["theme"]);
    expect(result.default).toEqual({ theme: "dark" });
  });

  it("applies object defaults from typeof values in T | Default<V>", async () => {
    const code = `
      interface Default<T, V extends T = T> {}
      const DEFAULT_CONFIG = { theme: "dark", retries: 3 } as const;
      interface Config {
        theme: string;
        retries: number;
      }
      type T = Config | Default<typeof DEFAULT_CONFIG>;
    `;
    const { type, checker, typeNode } = await getTypeFromCode(code, "T");
    const result = asObjectSchema(
      createSchemaTransformerV2().generateSchema(type, checker, typeNode),
    );

    expect(result.$ref).toBe("#/$defs/Config");
    expect(result.default).toEqual({ theme: "dark", retries: 3 });
  });

  it("applies object defaults from typeof values with shorthand properties", async () => {
    const code = `
      interface Default<T, V extends T = T> {}
      const theme = "dark" as const;
      const retries = 3 as const;
      const DEFAULT_CONFIG = { theme, retries } as const;
      interface Config {
        theme: string;
        retries: number;
      }
      type T = Config | Default<typeof DEFAULT_CONFIG>;
    `;
    const { type, checker, typeNode } = await getTypeFromCode(code, "T");
    const result = asObjectSchema(
      createSchemaTransformerV2().generateSchema(type, checker, typeNode),
    );

    expect(result.$ref).toBe("#/$defs/Config");
    expect(result.default).toEqual({ theme: "dark", retries: 3 });
  });

  it("rejects object defaults that would widen an existing object member", async () => {
    const code = `
      interface Default<T, V extends T = T> {}
      interface Config {
        theme: string;
        retries: number;
      }
      type T = Config | Default<{ theme: "dark" }>;
    `;
    const { type, checker, typeNode } = await getTypeFromCode(code, "T");
    const gen = createSchemaTransformerV2();

    expect(() => gen.generateSchema(type, checker, typeNode)).toThrow(
      "Default object union member is not assignable",
    );
  });

  it("rejects nested object defaults that would widen an existing object member", async () => {
    const code = `
      interface Default<T, V extends T = T> {}
      interface Config {
        profile: {
          name: string;
          email: string;
        };
      }
      type T = Config | Default<{ profile: { name: "Ada" } }>;
    `;
    const { type, checker, typeNode } = await getTypeFromCode(code, "T");
    const gen = createSchemaTransformerV2();

    expect(() => gen.generateSchema(type, checker, typeNode)).toThrow(
      "Default object union member is not assignable",
    );
  });

  it("applies recursive object defaults from T | DeepDefault<V>", async () => {
    const code = `
      interface DeepDefault<V> {}
      interface Config {
        theme: string;
        profile: {
          name: string;
          email: string;
        };
      }
      type T = Config | DeepDefault<{
        theme: "dark";
        profile: {
          name: "Ada";
        };
      }>;
    `;
    const { type, checker, typeNode } = await getTypeFromCode(code, "T");
    const result = asObjectSchema(
      createSchemaTransformerV2().generateSchema(type, checker, typeNode),
    );

    expect(result.$ref).toBe("#/$defs/Config");
    expect(result.default).toEqual({
      theme: "dark",
      profile: { name: "Ada" },
    });
    expect((result.properties?.theme as any)?.default).toBe("dark");

    const profile = result.properties?.profile as any;
    expect(profile.default).toEqual({ name: "Ada" });
    expect(profile.properties?.name?.default).toBe("Ada");
    expect(profile.properties?.email).toBeUndefined();
  });

  it("applies recursive object defaults to nullable object unions", async () => {
    const code = `
      interface DeepDefault<V> {}
      interface Config {
        theme: string;
        profile: {
          name: string;
          email: string;
        } | null;
      }
      type T = Config | null | DeepDefault<{
        theme: "dark";
        profile: {
          name: "Ada";
        };
      }>;
    `;
    const { type, checker, typeNode } = await getTypeFromCode(code, "T");
    const result = asObjectSchema(
      createSchemaTransformerV2().generateSchema(type, checker, typeNode),
    );

    expect(result.anyOf).toEqual(expect.arrayContaining([
      { "$ref": "#/$defs/Config" },
      { type: "null" },
    ]));
    expect(result.default).toEqual({
      theme: "dark",
      profile: { name: "Ada" },
    });
    expect((result.properties?.theme as any)?.default).toBe("dark");

    const profile = result.properties?.profile as any;
    expect(profile.default).toEqual({ name: "Ada" });
    expect(profile.properties?.name?.default).toBe("Ada");
    expect(profile.properties?.email).toBeUndefined();
  });

  it("rejects unknown keys in DeepDefault object defaults", async () => {
    const code = `
      interface DeepDefault<V> {}
      interface Config {
        theme: string;
      }
      type T = Config | DeepDefault<{ typo: "x" }>;
    `;
    const { type, checker, typeNode } = await getTypeFromCode(code, "T");
    const gen = createSchemaTransformerV2();

    expect(() => gen.generateSchema(type, checker, typeNode)).toThrow(
      'DeepDefault key "typo" does not exist',
    );
  });

  it("rejects unknown nested keys in DeepDefault object defaults", async () => {
    const code = `
      interface DeepDefault<V> {}
      interface Config {
        profile: {
          name: string;
        };
      }
      type T = Config | DeepDefault<{
        profile: {
          typo: "x";
        };
      }>;
    `;
    const { type, checker, typeNode } = await getTypeFromCode(code, "T");
    const gen = createSchemaTransformerV2();

    expect(() => gen.generateSchema(type, checker, typeNode)).toThrow(
      'DeepDefault key "profile.typo" does not exist',
    );
  });

  it("rejects DeepDefault without an existing object member", async () => {
    const code = `
      interface DeepDefault<V> {}
      type T = string | DeepDefault<{ theme: "dark" }>;
    `;
    const { type, checker, typeNode } = await getTypeFromCode(code, "T");
    const gen = createSchemaTransformerV2();

    expect(() => gen.generateSchema(type, checker, typeNode)).toThrow(
      "DeepDefault must be unioned with an object type",
    );
  });

  it("rejects one-argument Default with aliased undefined in unions", async () => {
    const code = `
      interface Default<T, V extends T = T> {}
      type U = undefined;
      type T = string | Default<U>;
    `;
    const { type, checker, typeNode } = await getTypeFromCode(code, "T");
    const gen = createSchemaTransformerV2();

    expect(() => gen.generateSchema(type, checker, typeNode)).toThrow(
      "Default<undefined> is unsupported",
    );
  });
});
