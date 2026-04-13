import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createSchemaTransformerV2 } from "../../src/plugin.ts";
import { asObjectSchema, getTypeFromCode } from "../utils.ts";

describe("Schema: Capability wrapper types", () => {
  it("handles ReadonlyCell, WriteonlyCell, and OpaqueCell", async () => {
    const code = `
      interface X {
        ro: ReadonlyCell<{ foo: string }>;
        wo: WriteonlyCell<{ bar: number }>;
        op: OpaqueCell<{ baz: boolean }>;
      }
    `;
    const { type, checker } = await getTypeFromCode(code, "X");
    const gen = createSchemaTransformerV2();
    const result = asObjectSchema(gen.generateSchema(type, checker));

    const ro = result.properties?.ro as Record<string, any>;
    const wo = result.properties?.wo as Record<string, any>;
    const op = result.properties?.op as Record<string, any>;

    expect(ro).toBeDefined();
    expect(ro.properties?.foo?.type).toBe("string");
    expect(ro.asCell).toEqual(["readonly"]);

    expect(wo).toBeDefined();
    expect(wo.properties?.bar?.type).toBe("number");
    expect(wo.asCell).toEqual(["writeonly"]);

    expect(op).toBeDefined();
    expect(op.properties?.baz?.type).toBe("boolean");
    expect(op.asCell).toEqual(["opaque"]);
    expect(op).not.toHaveProperty("asOpaque");
  });

  it("resolves alias chains for capability wrappers", async () => {
    const code = `
      type RO<T> = ReadonlyCell<T>;
      type WO<T> = WriteonlyCell<T>;
      type OP<T> = OpaqueCell<T>;

      interface X {
        ro: RO<{ id: string }>;
        wo: WO<{ count: number }>;
        op: OP<{ enabled: boolean }>;
      }
    `;
    const { type, checker } = await getTypeFromCode(code, "X");
    const gen = createSchemaTransformerV2();
    const result = asObjectSchema(gen.generateSchema(type, checker));

    const ro = result.properties?.ro as Record<string, any>;
    const wo = result.properties?.wo as Record<string, any>;
    const op = result.properties?.op as Record<string, any>;

    expect(ro.properties?.id?.type).toBe("string");
    expect(ro.asCell).toEqual(["readonly"]);

    expect(wo.properties?.count?.type).toBe("number");
    expect(wo.asCell).toEqual(["writeonly"]);

    expect(op.properties?.enabled?.type).toBe("boolean");
    expect(op.asCell).toEqual(["opaque"]);
    expect(op).not.toHaveProperty("asOpaque");
  });

  it("Writable<unknown> produces { type: 'unknown', asCell: ['cell'] }", async () => {
    const code = `
      interface X {
        value: Writable<unknown>;
      }
    `;
    const { type, checker } = await getTypeFromCode(code, "X");
    const gen = createSchemaTransformerV2();
    const result = asObjectSchema(gen.generateSchema(type, checker));
    const value = result.properties?.value as Record<string, any>;
    expect(value).toEqual({ type: "unknown", asCell: ["cell"] });
  });

  it("OpaqueRef<T> erases to T without wrapper metadata", async () => {
    const code = `
      interface X {
        value: OpaqueRef<{ foo: string }>;
      }
    `;
    const { type, checker } = await getTypeFromCode(code, "X");
    const gen = createSchemaTransformerV2();
    const result = asObjectSchema(gen.generateSchema(type, checker));
    const value = result.properties?.value as Record<string, any>;

    expect(value.properties?.foo?.type).toBe("string");
    expect(value).not.toHaveProperty("asCell");
    expect(value).not.toHaveProperty("asOpaque");
  });

  it("Array<Writable<unknown>> produces { type: 'array', items: { type: 'unknown', asCell: ['cell'] } }", async () => {
    const code = `
      interface X {
        items: Array<Writable<unknown>>;
      }
    `;
    const { type, checker } = await getTypeFromCode(code, "X");
    const gen = createSchemaTransformerV2();
    const result = asObjectSchema(gen.generateSchema(type, checker));
    const items = result.properties?.items as Record<string, any>;
    expect(items.type).toBe("array");
    expect(items.items).toEqual({ type: "unknown", asCell: ["cell"] });
  });
});
