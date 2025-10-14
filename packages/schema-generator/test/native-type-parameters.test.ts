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
});
