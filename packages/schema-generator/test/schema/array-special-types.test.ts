import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createSchemaTransformerV2 } from "../../src/plugin.ts";
import { getTypeFromCode } from "../utils.ts";

describe("Schema: Array special types", () => {
  const transformer = createSchemaTransformerV2();

  it("should use items: true for any[] arrays", async () => {
    const { type, checker, typeNode } = await getTypeFromCode(
      "type AnyArray = any[];",
      "AnyArray",
    );
    const schema = transformer(type, checker, typeNode);
    expect(schema.type).toBe("array");
    expect(schema.items).toBe(true);
  });

  it("should use items: true for Array<any>", async () => {
    const { type, checker, typeNode } = await getTypeFromCode(
      "type AnyArray = Array<any>;",
      "AnyArray",
    );
    const schema = transformer(type, checker, typeNode);
    expect(schema.type).toBe("array");
    expect(schema.items).toBe(true);
  });

  it("should use items: false for never[] arrays", async () => {
    const { type, checker, typeNode } = await getTypeFromCode(
      "type NeverArray = never[];",
      "NeverArray",
    );
    const schema = transformer(type, checker, typeNode);
    expect(schema.type).toBe("array");
    expect(schema.items).toBe(false);
  });

  it("should use items: false for Array<never>", async () => {
    const { type, checker, typeNode } = await getTypeFromCode(
      "type NeverArray = Array<never>;",
      "NeverArray",
    );
    const schema = transformer(type, checker, typeNode);
    expect(schema.type).toBe("array");
    expect(schema.items).toBe(false);
  });

  it("should use items: true for unknown[] arrays", async () => {
    const { type, checker, typeNode } = await getTypeFromCode(
      "type UnknownArray = unknown[];",
      "UnknownArray",
    );
    const schema = transformer(type, checker, typeNode);
    expect(schema.type).toBe("array");
    expect(schema.items).toBe(true);
  });

  it("should use items: true for Array<unknown>", async () => {
    const { type, checker, typeNode } = await getTypeFromCode(
      "type UnknownArray = Array<unknown>;",
      "UnknownArray",
    );
    const schema = transformer(type, checker, typeNode);
    expect(schema.type).toBe("array");
    expect(schema.items).toBe(true);
  });

  it("should generate normal schemas for regular array types", async () => {
    const { type, checker, typeNode } = await getTypeFromCode(
      "type StringArray = string[];",
      "StringArray",
    );
    const schema = transformer(type, checker, typeNode);
    expect(schema.type).toBe("array");
    expect(schema.items).toEqual({ type: "string" });
  });
});