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
});
