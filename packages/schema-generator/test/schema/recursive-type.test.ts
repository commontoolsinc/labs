import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createSchemaTransformerV2 } from "../../src/plugin.ts";
import { getTypeFromCode } from "../utils.ts";

describe("Schema: Recursive and cyclic types", () => {
  it("produces $ref + definitions for a recursive interface", () => {
    const code = `
      interface Node { value: number; next?: Node; }
    `;
    const { type, checker } = getTypeFromCode(code, "Node");
    const gen = createSchemaTransformerV2();
    const result = gen(type, checker);
    expect(result.$ref).toBe("#/definitions/Node");
    const defs = result.definitions as Record<string, any>;
    expect(defs).toBeDefined();
    expect(defs.Node?.type).toBe("object");
    expect(defs.Node?.properties?.value?.type).toBe("number");
    // next should reference Node
    const next = defs.Node?.properties?.next;
    expect(next?.$ref).toBe("#/definitions/Node");
  });
});
