import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { combineSchema } from "../src/traverse.ts";
import type { JSONSchema } from "../src/builder/types.ts";

// combineSchema builds the pseudo-intersection of the schema a doc was
// entered with and a schema found on a link inside it. For object schemas,
// keys defined on only ONE side intersect against the other side's
// additionalProperties — where JSON Schema's "absent additionalProperties"
// means UNCONSTRAINED, not `false`. The regression pinned here: absent
// additionalProperties alongside defined properties used to be coerced to
// `false`, silently blocking the other side's keys exactly as if the
// author had written an explicitly closed object.

describe("combineSchema additionalProperties handling", () => {
  const openParent = {
    type: "object",
    properties: {
      shared: { type: "string" },
      parentOnly: { type: "number", asCell: ["cell"] },
    },
  } as const satisfies JSONSchema;

  it("treats absent additionalProperties as unconstrained, not false", () => {
    // The link defines `shared` but says nothing about other keys and has
    // NO additionalProperties: the parent-only key must not be blocked.
    const link = {
      type: "object",
      properties: { shared: { type: "string" } },
    } as const satisfies JSONSchema;

    const merged = combineSchema(openParent, link) as {
      properties: Record<string, unknown>;
    };
    expect(merged.properties.shared).toEqual({ type: "string" });
    // Regression: this used to be `false` (key blocked as if the link had
    // declared additionalProperties: false). The unconstrained side passes
    // the defining side's subschema through, flags included.
    expect(merged.properties.parentOnly).toEqual({
      type: "number",
      asCell: ["cell"],
    });
  });

  it("still blocks one-sided keys under an EXPLICIT additionalProperties: false", () => {
    const closedLink = {
      type: "object",
      properties: { shared: { type: "string" } },
      additionalProperties: false,
    } as const satisfies JSONSchema;

    const merged = combineSchema(openParent, closedLink) as {
      properties: Record<string, unknown>;
      additionalProperties?: unknown;
    };
    // An author who explicitly closed the object still closes it: the
    // absent-vs-false distinction is the entire fix.
    expect(merged.properties.parentOnly).toBe(false);
    expect(merged.additionalProperties).toBe(false);
  });

  it("keeps link-only keys when the parent has properties but no additionalProperties", () => {
    // Mirror direction: keys defined only on the LINK side intersect
    // against the parent's (absent) additionalProperties and survive.
    const link = {
      type: "object",
      properties: {
        shared: { type: "string" },
        linkOnly: { type: "number" },
      },
    } as const satisfies JSONSchema;
    const parent = {
      type: "object",
      properties: { shared: { type: "string" } },
    } as const satisfies JSONSchema;

    const merged = combineSchema(parent, link) as {
      properties: Record<string, unknown>;
    };
    expect(merged.properties.linkOnly).toEqual({ type: "number" });
  });

  it("intersects one-sided keys against a defined additionalProperties subschema", () => {
    // A real (non-boolean) additionalProperties on the other side still
    // participates in the intersection for one-sided keys.
    const link = {
      type: "object",
      properties: { shared: { type: "string" } },
      additionalProperties: { type: "number" },
    } as const satisfies JSONSchema;

    const merged = combineSchema(openParent, link) as {
      properties: Record<string, unknown>;
    };
    // parentOnly ({type:"number", asCell}) ∩ additionalProperties
    // ({type:"number"}) keeps the key rather than dropping or blocking it.
    expect(merged.properties.parentOnly).not.toBe(false);
    expect(merged.properties.parentOnly).not.toBe(undefined);
    expect((merged.properties.parentOnly as { type?: string }).type).toBe(
      "number",
    );
  });

  it("a property-less, additionalProperties-less side stays fully permissive", () => {
    // Neither properties nor additionalProperties: the true-schema branch —
    // the other side's shape passes through (with this side's flags).
    const anything = { type: "object" } as const satisfies JSONSchema;
    const merged = combineSchema(anything, openParent) as {
      properties: Record<string, unknown>;
    };
    expect(merged.properties.shared).toEqual({ type: "string" });
    expect(merged.properties.parentOnly).toEqual({
      type: "number",
      asCell: ["cell"],
    });
  });
});
