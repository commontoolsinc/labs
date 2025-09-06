import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createSchemaTransformerV2 } from "../../src/plugin.ts";
import { getTypeFromCode } from "../utils.ts";

describe("Schema: Complex defaults", () => {
  it("array defaults with items shape", async () => {
    const code = `
      interface Default<T,V> {}
      interface TodoItem { title: string; done: boolean; }
      interface WithArrayDefaults {
        emptyItems: Default<TodoItem[], []>;
        prefilledItems: Default<string[], ["item1", "item2"]>;
        matrix: Default<number[][], [[1,2],[3,4]]>;
      }
    `;
    const { type, checker } = await getTypeFromCode(code, "WithArrayDefaults");
    const s = createSchemaTransformerV2()(type, checker);
    const empty = s.properties?.emptyItems as any;
    expect(empty.type).toBe("array");
    expect(empty.items?.type).toBe("object");
    expect(Array.isArray(empty.default)).toBe(true);
    const pre = s.properties?.prefilledItems as any;
    expect(pre.type).toBe("array");
    expect(pre.items?.type).toBe("string");
    expect(pre.default).toEqual(["item1", "item2"]);
    const mat = s.properties?.matrix as any;
    expect(mat.type).toBe("array");
    expect(mat.items?.type).toBe("array");
    expect(mat.items?.items?.type).toBe("number");
    expect(mat.default).toEqual([[1, 2], [3, 4]]);
  });

  it("object defaults with nested objects", async () => {
    const code = `
      interface Default<T,V> {}
      interface WithObjectDefaults {
        config: Default<{ theme: string; count: number }, { theme: "dark"; count: 10 }>;
        user: Default<{ name: string; settings: { notifications: boolean; email: string } }, { name: "Anonymous"; settings: { notifications: true; email: "user@example.com" } }>;
      }
    `;
    const { type, checker } = await getTypeFromCode(code, "WithObjectDefaults");
    const s = createSchemaTransformerV2()(type, checker);
    const config = s.properties?.config as any;
    expect(config.type).toBe("object");
    expect(config.properties?.theme?.type).toBe("string");
    expect(config.properties?.count?.type).toBe("number");
    expect(config.default).toEqual({ theme: "dark", count: 10 });
    const user = s.properties?.user as any;
    expect(user.type).toBe("object");
    expect(user.properties?.name?.type).toBe("string");
    expect(user.properties?.settings?.type).toBe("object");
    expect(user.default).toEqual({
      name: "Anonymous",
      settings: { notifications: true, email: "user@example.com" },
    });
  });

  it("null/undefined defaults in Default<...>", async () => {
    const code = `
      interface Default<T,V> {}
      interface WithNullDefaults {
        nullable: Default<string | null, null>;
        undefinable: Default<string | undefined, undefined>;
      }
    `;
    const { type, checker } = await getTypeFromCode(code, "WithNullDefaults");
    const s = createSchemaTransformerV2()(type, checker);
    const n = s.properties?.nullable as any;
    expect(n.default).toBe(null);
    // OneOf representation may vary; ensure at least type is present
    expect(n.anyOf || n.type).toBeDefined();
    const u = s.properties?.undefinable as any;
    // Typically no default field for undefined
    expect(u.default).toBeUndefined();
    expect(u.type || u.anyOf).toBeDefined();
  });
});
