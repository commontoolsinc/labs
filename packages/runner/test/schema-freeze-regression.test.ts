import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  combineSchema,
  mergeAnyOfBranchSchemas,
  mergeSchemaFlags,
} from "../src/traverse.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import type { JSONSchemaObj } from "@commontools/api";

describe("schema merge/combine must not freeze input schemas", () => {
  it("mergeSchemaFlags does not freeze input when no flags to merge", () => {
    const flagSchema: JSONSchema = { type: "object" };
    const schema: JSONSchema = { type: "string" };
    mergeSchemaFlags(flagSchema, schema);
    expect(Object.isFrozen(flagSchema)).toBe(false);
    expect(Object.isFrozen(schema)).toBe(false);
    (schema as Record<string, unknown>).description = "still mutable";
    expect((schema as Record<string, unknown>).description).toBe(
      "still mutable",
    );
  });

  it("mergeSchemaFlags does not freeze input when flags are merged", () => {
    const flagSchema: JSONSchema = { type: "object", asCell: true };
    const schema: JSONSchema = { type: "string" };
    const result = mergeSchemaFlags(flagSchema, schema);
    expect(Object.isFrozen(flagSchema)).toBe(false);
    expect(Object.isFrozen(schema)).toBe(false);
    // Result IS frozen (it's cached).
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("combineSchema does not freeze input on array pass-through", () => {
    const parentSchema: JSONSchema = {
      type: "array",
      items: { type: "string" },
    };
    const linkSchema: JSONSchema = { type: "array" }; // no items -> pass-through
    combineSchema(parentSchema, linkSchema);
    expect(Object.isFrozen(parentSchema)).toBe(false);
    expect(Object.isFrozen(linkSchema)).toBe(false);
    (parentSchema as Record<string, unknown>).description = "still mutable";
    expect((parentSchema as Record<string, unknown>).description).toBe(
      "still mutable",
    );
  });

  it("combineSchema does not freeze input on fallback path", () => {
    // Both non-boolean, non-object-type, non-array-type -> fallback returns linkSchema copy
    const parentSchema: JSONSchema = { type: "string" };
    const linkSchema: JSONSchema = { type: "number" };
    combineSchema(parentSchema, linkSchema);
    expect(Object.isFrozen(parentSchema)).toBe(false);
    expect(Object.isFrozen(linkSchema)).toBe(false);
  });

  it("mergeAnyOfBranchSchemas does not freeze inputs", () => {
    const outerSchema: JSONSchemaObj = {
      type: "object",
      properties: { name: { type: "string" } },
    };
    const branches: JSONSchema[] = [
      { properties: { name: { type: "string" }, age: { type: "number" } } },
      { properties: { name: { type: "string" }, email: { type: "string" } } },
    ];
    mergeAnyOfBranchSchemas(branches, outerSchema);
    expect(Object.isFrozen(outerSchema)).toBe(false);
    expect(Object.isFrozen(branches[0])).toBe(false);
    expect(Object.isFrozen(branches[1])).toBe(false);
  });

  it("merge results ARE frozen", () => {
    const flagSchema: JSONSchema = { type: "object", asCell: true };
    const schema: JSONSchema = { type: "string" };
    const result = mergeSchemaFlags(flagSchema, schema);
    expect(Object.isFrozen(result)).toBe(true);

    const parentSchema: JSONSchema = { type: "string" };
    const linkSchema: JSONSchema = { type: "number" };
    const combined = combineSchema(parentSchema, linkSchema);
    expect(Object.isFrozen(combined)).toBe(true);
  });
});
