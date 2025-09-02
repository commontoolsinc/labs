import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createSchemaTransformerV2 } from "../../src/plugin.ts";
import { getTypeFromCode } from "../utils.ts";

describe("Schema: Recursion variants", () => {
  it("nested recursive: children?: Node[]", () => {
    const code = `
      interface Node { value: string; children?: Node[] }
    `;
    const { type, checker } = getTypeFromCode(code, "Node");
    const s = createSchemaTransformerV2()(type, checker);
    expect(s.$ref).toBe("#/definitions/Node");
    const d = s.definitions as any;
    const node = d.Node;
    expect(node.properties?.children?.type).toBe("array");
    expect(node.properties?.children?.items?.$ref).toBe("#/definitions/Node");
  });

  it("multi-hop circular A -> B -> C -> A", () => {
    const code = `
      interface A { b: B }
      interface B { c: C }
      interface C { a: A }
    `;
    const { type, checker } = getTypeFromCode(code, "A");
    const s = createSchemaTransformerV2()(type, checker);
    expect(s.$ref).toBe("#/definitions/A");
    const defs = s.definitions as any;
    expect(defs.A?.properties?.b?.$ref).toBe("#/definitions/B");
    expect(defs.B?.properties?.c?.$ref).toBe("#/definitions/C");
    expect(defs.C?.properties?.a?.$ref).toBe("#/definitions/A");
  });

  it("mutually recursive A <-> B", () => {
    const code = `
      interface A { b?: B }
      interface B { a?: A }
    `;
    const { type, checker } = getTypeFromCode(code, "A");
    const s = createSchemaTransformerV2()(type, checker);
    expect(s.$ref).toBe("#/definitions/A");
    const defs = s.definitions as any;
    expect(defs.A?.properties?.b?.$ref).toBe("#/definitions/B");
    expect(defs.B?.properties?.a?.$ref).toBe("#/definitions/A");
  });
});
