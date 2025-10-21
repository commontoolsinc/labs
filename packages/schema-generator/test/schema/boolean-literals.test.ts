import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createSchemaTransformerV2 } from "../../src/plugin.ts";
import { getTypeFromCode } from "../utils.ts";

describe("Schema: Boolean literals", () => {
  it("should preserve boolean literal values in enum", async () => {
    const code = `
      interface BooleanLiterals {
        alwaysTrue: true;
        alwaysFalse: false;
        regularBoolean: boolean;
      }
    `;
    const { type, checker } = await getTypeFromCode(code, "BooleanLiterals");
    const transformer = createSchemaTransformerV2();
    const schema = transformer(type, checker);

    const alwaysTrue = schema.properties?.alwaysTrue as any;
    expect(alwaysTrue.type).toBe("boolean");
    expect(alwaysTrue.enum).toEqual([true]);

    const alwaysFalse = schema.properties?.alwaysFalse as any;
    expect(alwaysFalse.type).toBe("boolean");
    expect(alwaysFalse.enum).toEqual([false]);

    const regularBoolean = schema.properties?.regularBoolean as any;
    expect(regularBoolean.type).toBe("boolean");
    expect(regularBoolean.enum).toBeUndefined(); // No enum for regular boolean
  });

  it("should handle boolean literal types directly", async () => {
    const trueCode = `type AlwaysTrue = true;`;
    const { type: trueType, checker } = await getTypeFromCode(
      trueCode,
      "AlwaysTrue",
    );
    const transformer = createSchemaTransformerV2();
    const trueSchema = transformer(trueType, checker);

    expect(trueSchema.type).toBe("boolean");
    expect(trueSchema.enum).toEqual([true]);

    const falseCode = `type AlwaysFalse = false;`;
    const { type: falseType, checker: falseChecker } = await getTypeFromCode(
      falseCode,
      "AlwaysFalse",
    );
    const falseSchema = transformer(falseType, falseChecker);

    expect(falseSchema.type).toBe("boolean");
    expect(falseSchema.enum).toEqual([false]);
  });
});
