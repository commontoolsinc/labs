import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createSchemaTransformerV2 } from "../../src/plugin.ts";
import { asObjectSchema, getTypeFromCode } from "../utils.ts";

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
});
