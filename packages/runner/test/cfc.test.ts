import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { ContextualFlowControl } from "../src/cfc.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import type { JSONSchemaObj } from "@commontools/api";

describe("ContextualFlowControl.schemaAtPath array index validation", () => {
  it("rejects leading-zero array index like '01'", () => {
    const cfc = new ContextualFlowControl();

    const schema: JSONSchema = {
      type: "array",
      items: { type: "string" },
    };

    // "01" is not a valid array index (leading zero), should return false
    const result01 = cfc.schemaAtPath(schema, ["01"]);
    // "1" is a valid array index, should return the items schema
    const result1 = cfc.schemaAtPath(schema, ["1"]);

    expect(result01).toBe(false);
    expect(result1).toEqual({ type: "string" });
  });

  it("considers a schema with only $defs true'", () => {
    const schema: JSONSchema = {
      $defs: { Test: { type: "array", items: { type: "string" } } },
    };
    expect(ContextualFlowControl.isTrueSchema(schema)).toBe(true);
  });
});

describe("ContextualFlowControl.resolveSchemaRefsOrThrow", () => {
  it("resolves a local $ref successfully", () => {
    const schema: JSONSchemaObj = {
      $defs: { Foo: { type: "string" } as JSONSchema },
      $ref: "#/$defs/Foo",
    };
    const resolved = ContextualFlowControl.resolveSchemaRefsOrThrow(schema);
    expect(resolved).toMatchObject({ type: "string" });
  });

  it("resolves embedded external $ref (vnode.json)", () => {
    const schema: JSONSchemaObj = {
      $ref: "https://commonfabric.org/schemas/vnode.json",
    };
    // Should not throw — vnode.json is registered in embeddedSchemas
    const resolved = ContextualFlowControl.resolveSchemaRefsOrThrow(schema);
    expect(resolved).toBeDefined();
  });

  it("throws with actionable message for unknown external $ref", () => {
    const schema: JSONSchemaObj = {
      $ref: "https://commonfabric.org/schemas/unknown.json",
    };
    expect(() => ContextualFlowControl.resolveSchemaRefsOrThrow(schema))
      .toThrow(/embeddedSchemas/);
  });

  it("throws with schema details for unresolvable local $ref", () => {
    const schema: JSONSchemaObj = {
      $defs: {},
      $ref: "#/$defs/Missing",
    };
    expect(() => ContextualFlowControl.resolveSchemaRefsOrThrow(schema))
      .toThrow(/Failed to resolve \$ref/);
  });
});
