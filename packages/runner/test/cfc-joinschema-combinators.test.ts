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
