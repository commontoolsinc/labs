import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createSchemaTransformerV2 } from "../../src/plugin.ts";
import { asObjectSchema, getTypeFromCode } from "../utils.ts";

describe("Schema: Default<T,V>", () => {
  it("applies default for primitive value", async () => {
    const code = `
      interface Default<T, V> {}
      type T = Default<number, 5>;
    `;
    const { type, checker, typeNode } = await getTypeFromCode(code, "T");
    const gen = createSchemaTransformerV2();
    const result = asObjectSchema(gen.generateSchema(type, checker, typeNode));
    expect(result.type).toBe("number");
    expect(result.default).toBe(5);
  });

  it("applies default for array values and keeps items shape", async () => {
    const code = `
      interface Default<T, V> {}
      type T = Default<string[], ["a", "b"]>;
    `;
    const { type, checker, typeNode } = await getTypeFromCode(code, "T");
    const gen = createSchemaTransformerV2();
    const result = asObjectSchema(gen.generateSchema(type, checker, typeNode));
    expect(result.type).toBe("array");
    const items = result.items as any;
    expect(items?.type).toBe("string");
    expect(Array.isArray(result.default)).toBe(true);
    expect(result.default).toEqual(["a", "b"]);
  });
});
