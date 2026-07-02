import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { ContextualFlowControl } from "../src/cfc.ts";
import { isPromptInjectionMaterialRiskAtom } from "../src/cfc/schema-sanitization.ts";
import { isOrClause } from "../src/cfc/clause.ts";
import type { JSONSchema } from "../src/builder/types.ts";

// Epic A5 (docs/plans/cfc-future-work-implementation.md): the flat-assumption
// consumer sweep. Every remaining site that iterates `.confidentiality` as a
// bare atom list must treat an OR-clause opaquely and stay CORRECT or
// fail-safe (over-restrict) — never under-restrict. These tests pin that
// posture per consumer so a future edit that flattens a clause is caught.

const A = {
  type: "https://commonfabric.org/cfc/atom/Resource",
  class: "did",
  subject: "did:key:alice",
};
const B = {
  type: "https://commonfabric.org/cfc/atom/Resource",
  class: "did",
  subject: "did:key:bob",
};

describe("A5 flat-assumption consumer sweep", () => {
  describe("schema-sanitization material-risk scan", () => {
    it("treats an OR-clause as opaque (never a material-risk caveat)", () => {
      // A clause object has no `type: Caveat`, so it is never mistaken for a
      // material-risk caveat — it is PRESERVED by filterMaterialRiskAtoms
      // (the more-restrictive direction). Combined with A4 forbidding Caveat
      // as an OR alternative, a material-risk caveat can never hide in a
      // clause and slip past the strip.
      expect(isPromptInjectionMaterialRiskAtom({ anyOf: [A, B] })).toBe(false);
      // Sanity: a bare material-risk caveat is still detected.
      expect(
        isPromptInjectionMaterialRiskAtom({
          type: "https://commonfabric.org/cfc/atom/Caveat",
          kind: "https://commonfabric.org/cfc/concepts/prompt-injection-risk",
        }),
      ).toBe(true);
    });
  });

  describe("legacy classification walker (cfc.ts lubSchema)", () => {
    const cfc = new ContextualFlowControl();

    it("carries an OR-clause through the coarse join opaquely (no crash, no drop)", () => {
      const schema = {
        type: "string",
        ifc: { confidentiality: [{ anyOf: [A, B] }] },
      } as const satisfies JSONSchema;
      const atoms = cfc.lubSchema(schema);
      expect(atoms).toBeDefined();
      // The clause survives as one opaque member — not flattened into its
      // alternatives (which would under-represent the AND-of-the-clause).
      expect(atoms!.some(isOrClause)).toBe(true);
      expect(atoms!.some((a) => a === A || a === B)).toBe(false);
    });

    it("unions a clause with sibling flat atoms without merging them", () => {
      const schema = {
        type: "object",
        ifc: { confidentiality: [A] },
        properties: {
          child: {
            type: "string",
            ifc: { confidentiality: [{ anyOf: [A, B] }] },
          },
        },
      } as const satisfies JSONSchema;
      const atoms = cfc.lubSchema(schema) ?? [];
      // Both the flat A and the {A∨B} clause are present as distinct members.
      expect(atoms).toContainEqual(A);
      expect(atoms.some(isOrClause)).toBe(true);
    });
  });
});
