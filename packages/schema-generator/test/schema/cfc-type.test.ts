import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createSchemaTransformerV2 } from "../../src/plugin.ts";
import { asObjectSchema, getTypeFromCode } from "../utils.ts";

describe("Schema: CFC<T,C> / Secret<T> / Confidential<T>", () => {
  it("CFC<string, 'secret'> adds ifc annotation", async () => {
    const code = `
      type CFC<T, C extends string = string> = T;
      type T = CFC<string, "secret">;
    `;
    const { type, checker, typeNode } = await getTypeFromCode(code, "T");
    const gen = createSchemaTransformerV2();
    const result = asObjectSchema(gen.generateSchema(type, checker, typeNode));
    expect(result.type).toBe("string");
    expect((result as any).ifc).toEqual({ classification: ["secret"] });
  });

  it("Secret<T> alias adds secret ifc annotation", async () => {
    const code = `
      type CFC<T, C extends string = string> = T;
      type Secret<T> = CFC<T, "secret">;
      type T = Secret<string>;
    `;
    const { type, checker, typeNode } = await getTypeFromCode(code, "T");
    const gen = createSchemaTransformerV2();
    const result = asObjectSchema(gen.generateSchema(type, checker, typeNode));
    expect(result.type).toBe("string");
    expect((result as any).ifc).toEqual({ classification: ["secret"] });
  });

  it("Confidential<T> alias adds confidential ifc annotation", async () => {
    const code = `
      type CFC<T, C extends string = string> = T;
      type Confidential<T> = CFC<T, "confidential">;
      type T = Confidential<number>;
    `;
    const { type, checker, typeNode } = await getTypeFromCode(code, "T");
    const gen = createSchemaTransformerV2();
    const result = asObjectSchema(gen.generateSchema(type, checker, typeNode));
    expect(result.type).toBe("number");
    expect((result as any).ifc).toEqual({ classification: ["confidential"] });
  });

  it("Secret<T> inside object property gets ifc annotation", async () => {
    const code = `
      type CFC<T, C extends string = string> = T;
      type Secret<T> = CFC<T, "secret">;
      type T = { accessToken: Secret<string>; name: string };
    `;
    const { type, checker, typeNode } = await getTypeFromCode(code, "T");
    const gen = createSchemaTransformerV2();
    const result = asObjectSchema(gen.generateSchema(type, checker, typeNode));
    expect(result.type).toBe("object");
    const props = result.properties as any;
    expect(props.accessToken.type).toBe("string");
    expect(props.accessToken.ifc).toEqual({ classification: ["secret"] });
    expect(props.name.type).toBe("string");
    expect(props.name.ifc).toBeUndefined();
  });

  it("Default<Secret<string>, ''> composes correctly", async () => {
    const code = `
      interface Default<T, V> {}
      type CFC<T, C extends string = string> = T;
      type Secret<T> = CFC<T, "secret">;
      type T = Default<Secret<string>, "">;
    `;
    const { type, checker, typeNode } = await getTypeFromCode(code, "T");
    const gen = createSchemaTransformerV2();
    const result = asObjectSchema(gen.generateSchema(type, checker, typeNode));
    expect(result.type).toBe("string");
    expect(result.default).toBe("");
    expect((result as any).ifc).toEqual({ classification: ["secret"] });
  });
});
