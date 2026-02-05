import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { SchemaGenerator } from "../src/schema-generator.ts";
import { asObjectSchema, getTypeFromCode } from "./utils.ts";

describe("Native type parameters", () => {
  it("unwraps Uint8Array with defaulted typed buffer", async () => {
    const code = `
interface Wrapper {
  value: Uint8Array;
  pointer: Uint8Array<ArrayBufferLike & { foo?: number }>;
}
`;
    const { type, checker } = await getTypeFromCode(code, "Wrapper");
    const generator = new SchemaGenerator();
    const schema = asObjectSchema(generator.generateSchema(type, checker));
    const props = schema.properties as Record<string, unknown> | undefined;
    expect(props?.value).toBe(true);
    expect(props?.pointer).toBe(true);
    expect((schema as Record<string, unknown>).$defs).toBeUndefined();
  });

  it("treats ArrayBufferView as native type", async () => {
    const code = `
interface DataContainer {
  buffer: ArrayBufferView;
  metadata: string;
  optional?: ArrayBufferView;
}
`;
    const { type, checker } = await getTypeFromCode(code, "DataContainer");
    const generator = new SchemaGenerator();
    const schema = asObjectSchema(generator.generateSchema(type, checker));
    const props = schema.properties as Record<string, unknown> | undefined;

    // ArrayBufferView should resolve to true (opaque native type)
    expect(props?.buffer).toBe(true);
    expect(props?.optional).toBe(true);

    // Regular types should still work normally
    expect(props?.metadata).toEqual({ type: "string" });

    // Native types should not generate $defs
    expect((schema as Record<string, unknown>).$defs).toBeUndefined();
  });

  it("treats JSONSchema as native type", async () => {
    const code = `
interface Recipe {
  argumentSchema: JSONSchema;
}
`;
    const { type, checker } = await getTypeFromCode(code, "Recipe");
    const generator = new SchemaGenerator();
    const schema = asObjectSchema(generator.generateSchema(type, checker));
    const props = schema.properties as Record<string, unknown> | undefined;

    // ArrayBufferView should resolve to true (opaque native type)
    expect(props?.argumentSchema).toBe(true);

    // Native types should not generate $defs
    expect((schema as Record<string, unknown>).$defs).toBeUndefined();
  });
});
