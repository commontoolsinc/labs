import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createSchemaTransformerV2 } from "../src/plugin.ts";
import { getTypeFromCode } from "./utils.ts";

describe("Plugin Interface", () => {
  it("should create a transformer function with the correct signature", () => {
    const transformer = createSchemaTransformerV2();

    // Verify it's a function
    expect(typeof transformer).toBe("function");

    // Verify it has the right number of parameters
    expect(transformer.length).toBe(3);
  });

  it("transforms a simple object via plugin", async () => {
    const transformer = createSchemaTransformerV2();
    const { type, checker } = await getTypeFromCode(
      "interface MyObject { name: string; age: number; }",
      "MyObject",
    );
    const schema = transformer(type, checker);
    expect(schema.type).toBe("object");
    expect(schema.properties?.name).toEqual({ type: "string" });
    expect(schema.properties?.age).toEqual({ type: "number" });
  });
});
