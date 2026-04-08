import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createSchemaTransformerV2 } from "../../src/plugin.ts";
import { asObjectSchema, getTypeFromCode } from "../utils.ts";

describe("Schema: CFC authoring aliases", () => {
  it("lowers Classified and OpaqueInput through the canonical Cfc carrier", async () => {
    const code = `
      type Cfc<T, Meta> = T & { readonly __ct_cfc__?: Meta };
      type Classified<T, X extends readonly string[]> = Cfc<T, { classification: X }>;
      type OpaqueInput<T, Spec extends true | { schema?: unknown; allowPassThrough?: boolean } = true> = Cfc<T, { opaque: Spec }>;

      interface SchemaRoot {
        secret: Classified<string, readonly ["secret"]>;
        token: OpaqueInput<string>;
      }
    `;

    const { type, checker } = await getTypeFromCode(code, "SchemaRoot");
    const schema = asObjectSchema(
      createSchemaTransformerV2().generateSchema(type, checker),
    );

    const secret = schema.properties?.secret as any;
    expect(secret.type).toBe("string");
    expect(secret.ifc?.classification).toEqual(["secret"]);

    const token = schema.properties?.token as any;
    expect(token.type).toBe("string");
    expect(token.ifc?.opaque).toBe(true);
  });
});
