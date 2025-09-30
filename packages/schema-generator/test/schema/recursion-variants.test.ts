import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createSchemaTransformerV2 } from "../../src/plugin.ts";
import { getTypeFromCode } from "../utils.ts";

describe("Schema: Recursion variants", () => {
  it("simple recursive: next?: Node", async () => {
    const code = `
      interface Node { value: number; next?: Node; }
    `;
    const { type, checker } = await getTypeFromCode(code, "Node");
    const gen = createSchemaTransformerV2();
    const result = gen(type, checker);
    expect(result.$ref).toBe("#/$defs/Node");
    const defs = result.$defs as Record<string, any>;
    expect(defs).toBeDefined();
    expect(defs.Node?.type).toBe("object");
    expect(defs.Node?.properties?.value?.type).toBe("number");
    const next = defs.Node?.properties?.next;
    expect(next?.$ref).toBe("#/$defs/Node");
  });

  it("nested recursive: children?: Node[]", async () => {
    const code = `
      interface Node { value: string; children?: Node[] }
    `;
    const { type, checker } = await getTypeFromCode(code, "Node");
    const s = createSchemaTransformerV2()(type, checker);
    expect(s.$ref).toBe("#/$defs/Node");
    const d = s.$defs as any;
    const node = d.Node;
    expect(node.properties?.children?.type).toBe("array");
    expect(node.properties?.children?.items?.$ref).toBe("#/$defs/Node");
  });

  it("multi-hop circular A -> B -> C -> A", async () => {
    const code = `
      interface A { b: B }
      interface B { c: C }
      interface C { a: A }
    `;
    const { type, checker } = await getTypeFromCode(code, "A");
    const s = createSchemaTransformerV2()(type, checker);
    expect(s.$ref).toBe("#/$defs/A");
    const defs = s.$defs as any;
    expect(defs.A?.properties?.b?.$ref).toBe("#/$defs/B");
    expect(defs.B?.properties?.c?.$ref).toBe("#/$defs/C");
    expect(defs.C?.properties?.a?.$ref).toBe("#/$defs/A");
  });

  it("mutually recursive A <-> B", async () => {
    const code = `
      interface A { b?: B }
      interface B { a?: A }
    `;
    const { type, checker } = await getTypeFromCode(code, "A");
    const s = createSchemaTransformerV2()(type, checker);
    expect(s.$ref).toBe("#/$defs/A");
    const defs = s.$defs as any;
    expect(defs.A?.properties?.b?.$ref).toBe("#/$defs/B");
    expect(defs.B?.properties?.a?.$ref).toBe("#/$defs/A");
  });
});
