import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { ContextualFlowControl } from "../src/cfc.ts";
import type { JSONSchema } from "../src/builder/types.ts";

// Regression guard for joinSchema combinator descent (audit 1.6 / W2.16).
//
// lubSchema (confidentiality tainting) descended into properties/items/$ref but
// not anyOf/oneOf/allOf or prefixItems, so branch-local confidentiality was
// silently dropped — an under-tainting fail-open in the core algebra. The LUB
// must union the confidentiality of every branch a value could match.
describe("ContextualFlowControl.lubSchema combinator descent", () => {
  const cfc = new ContextualFlowControl();
  const atomsOf = (schema: JSONSchema) =>
    (cfc.lubSchema(schema) ?? []).map((a) => a).sort();

  it("unions confidentiality across anyOf branches", () => {
    expect(atomsOf({
      anyOf: [
        { type: "string", ifc: { confidentiality: ["a"] } },
        { type: "number", ifc: { confidentiality: ["b"] } },
      ],
    } as JSONSchema)).toEqual(["a", "b"]);
  });

  it("unions confidentiality across oneOf and allOf branches", () => {
    expect(atomsOf({
      oneOf: [{ type: "string", ifc: { confidentiality: ["x"] } }],
      allOf: [{ type: "object", ifc: { confidentiality: ["y"] } }],
    } as JSONSchema)).toEqual(["x", "y"]);
  });

  it("descends into prefixItems (tuple) branches", () => {
    expect(atomsOf({
      type: "array",
      prefixItems: [
        { type: "string", ifc: { confidentiality: ["t0"] } },
        { type: "number", ifc: { confidentiality: ["t1"] } },
      ],
    } as JSONSchema)).toEqual(["t0", "t1"]);
  });

  // joinSchema used to chain additionalProperties / items / $ref with
  // `else if`, so a schema carrying more than one of them joined only the
  // first — the same under-tainting class as the combinator gap above.
  it("unions additionalProperties and items together", () => {
    expect(atomsOf({
      type: "object",
      additionalProperties: {
        type: "string",
        ifc: { confidentiality: ["ap"] },
      },
      items: { type: "number", ifc: { confidentiality: ["it"] } },
    } as JSONSchema)).toEqual(["ap", "it"]);
  });

  it("follows $ref alongside items", () => {
    expect(atomsOf({
      type: "array",
      items: { type: "string", ifc: { confidentiality: ["el"] } },
      $ref: "#/$defs/R",
      $defs: {
        R: { type: "array", ifc: { confidentiality: ["ref"] } },
      },
    } as JSONSchema)).toEqual(["el", "ref"]);
  });

  // A plain `not` over-taints conservatively, but a nested `not` (not-of-not)
  // re-selects values that DO match the inner subschema — descending `not` is
  // needed for soundness, not just conservatism.
  it("unions confidentiality under not (conservative over-taint)", () => {
    expect(atomsOf({
      type: "string",
      not: { ifc: { confidentiality: ["n"] } },
    } as JSONSchema)).toEqual(["n"]);
  });

  it("reaches atoms under a double negation (not-of-not matches)", () => {
    expect(atomsOf({
      not: { not: { type: "string", ifc: { confidentiality: ["nn"] } } },
    } as JSONSchema)).toEqual(["nn"]);
  });

  it("does not mistake identical refs in different definition roots for a cycle", () => {
    const shared = { $ref: "#/$defs/V" } as const;
    expect(atomsOf({
      type: "object",
      properties: { entry: shared },
      $defs: {
        V: {
          type: "object",
          ifc: { confidentiality: ["a"] },
          properties: {
            nested: {
              type: "object",
              $defs: {
                V: {
                  type: "string",
                  ifc: { confidentiality: ["b"] },
                },
              },
              properties: { value: shared },
            },
          },
        },
      },
    })).toEqual(["a", "b"]);
  });
});
