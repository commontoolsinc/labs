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

  it("CFC<T, C> works with arbitrary string literal classification", async () => {
    const code = `
      type CFC<T, C extends string = string> = T;
      type T = CFC<string, "pii">;
    `;
    const { type, checker, typeNode } = await getTypeFromCode(code, "T");
    const gen = createSchemaTransformerV2();
    const result = asObjectSchema(gen.generateSchema(type, checker, typeNode));
    expect(result.type).toBe("string");
    expect((result as any).ifc).toEqual({ classification: ["pii"] });
  });

  it("user-defined alias type PII<T> = CFC<T, 'pii'> extracts correct classification", async () => {
    const code = `
      type CFC<T, C extends string = string> = T;
      type PII<T> = CFC<T, "pii">;
      type T = PII<string>;
    `;
    const { type, checker, typeNode } = await getTypeFromCode(code, "T");
    const gen = createSchemaTransformerV2();
    const result = asObjectSchema(gen.generateSchema(type, checker, typeNode));
    expect(result.type).toBe("string");
    expect((result as any).ifc).toEqual({ classification: ["pii"] });
  });

  it("user-defined alias with custom label inside object property", async () => {
    const code = `
      type CFC<T, C extends string = string> = T;
      type PII<T> = CFC<T, "pii">;
      type T = { ssn: PII<string>; name: string };
    `;
    const { type, checker, typeNode } = await getTypeFromCode(code, "T");
    const gen = createSchemaTransformerV2();
    const result = asObjectSchema(gen.generateSchema(type, checker, typeNode));
    expect(result.type).toBe("object");
    const props = result.properties as any;
    expect(props.ssn.type).toBe("string");
    expect(props.ssn.ifc).toEqual({ classification: ["pii"] });
    expect(props.name.type).toBe("string");
    expect(props.name.ifc).toBeUndefined();
  });

  it("chained user alias (MyPII -> PII -> CFC) resolves classification", async () => {
    const code = `
      type CFC<T, C extends string = string> = T;
      type PII<T> = CFC<T, "pii">;
      type MyPII<T> = PII<T>;
      type T = MyPII<string>;
    `;
    const { type, checker, typeNode } = await getTypeFromCode(code, "T");
    const gen = createSchemaTransformerV2();
    const result = asObjectSchema(gen.generateSchema(type, checker, typeNode));
    expect(result.type).toBe("string");
    expect((result as any).ifc).toEqual({ classification: ["pii"] });
  });

  it("non-generic user alias type MyField = CFC<string, 'custom-label'>", async () => {
    const code = `
      type CFC<T, C extends string = string> = T;
      type MyField = CFC<string, "custom-label">;
      type T = { field: MyField };
    `;
    const { type, checker, typeNode } = await getTypeFromCode(code, "T");
    const gen = createSchemaTransformerV2();
    const result = asObjectSchema(gen.generateSchema(type, checker, typeNode));
    expect(result.type).toBe("object");
    const props = result.properties as any;
    expect(props.field.type).toBe("string");
    expect(props.field.ifc).toEqual({ classification: ["custom-label"] });
  });
});
