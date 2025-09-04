import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createSchemaTransformerV2 } from "../../src/plugin.ts";
import { getTypeFromCode } from "../utils.ts";

describe("Schema: Arrays and optional properties", () => {
  it("marks optional array property as not required", async () => {
    const code = `
      interface X { ids?: number[]; }
    `;
    const { type, checker, typeNode } = await getTypeFromCode(code, "X");
    const gen = createSchemaTransformerV2();
    const result = gen(type, checker, typeNode);
    expect(result.type).toBe("object");
    const ids = result.properties?.ids as Record<string, unknown>;
    expect(ids.type).toBe("array");
    const req = result.required ?? [];
    expect(req.includes("ids")).toBe(false);
  });

  it("supports Array<T> and T[] equally", async () => {
    const code = `
      interface A { items: Array<string>; }
      interface B { items: string[]; }
    `;
    const a = await getTypeFromCode(code, "A");
    const b = await getTypeFromCode(code, "B");
    const gen = createSchemaTransformerV2();
    const sa = gen(a.type, a.checker, a.typeNode);
    const sb = gen(b.type, b.checker, b.typeNode);
    expect(sa.properties?.items?.type).toBe("array");
    expect(sa.properties?.items?.items?.type).toBe("string");
    expect(sb.properties?.items?.type).toBe("array");
    expect(sb.properties?.items?.items?.type).toBe("string");
  });
});
