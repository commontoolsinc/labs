import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { wildcardPolicyMatchesValue } from "../src/cfc/prepare.ts";
import { LINK_V1_TAG } from "../src/sigil-types.ts";
import type { URI } from "@commonfabric/memory/interface";
import type { JSONSchema } from "../src/builder/types.ts";

// Regression guard for wildcard policy applicability on unresolvable links
// (audit S17).
//
// When a written value is a link whose target value cannot be resolved, the
// policy's value condition cannot be evaluated against real data. The pre-fix
// code fell back to comparing the policy schema against the link's
// author-embedded schema, so an attacker could embed a mismatching schema to
// make the policy entry "not apply" and skip its writeAuthorizedBy /
// requiredIntegrity / uiContract checks. Unresolvable links must fail closed:
// the entry applies.
//
// Driving through a full write is impractical because the Cell write path
// collapses an unresolvable link before it reaches the verifier, so the link
// only reaches this matcher when verifying a pre-existing stored link whose
// target is not present in the transaction. This exercises that branch directly.
describe("CFC wildcard policy applicability on unresolvable links", () => {
  const space = "did:key:wildcard-link" as const;
  const policySchema = {
    type: "object",
    ifc: { writeAuthorizedBy: ["trusted-handler"] },
  } as const satisfies JSONSchema;
  const target = { space, id: "of:guarded" as const, scope: "space" as const };
  const linkedTargetId = "of:unresolvable-target" as URI;

  // A link whose embedded schema (string) deliberately mismatches the object
  // policy schema, pointing at a target the transaction cannot resolve.
  const linkValue = {
    "/": {
      [LINK_V1_TAG]: {
        id: linkedTargetId,
        path: [] as string[],
        space,
        scope: "space",
        schema: { type: "string" },
      },
    },
  };

  it("applies (fail-closed) when the linked target cannot be resolved", () => {
    const tx = {
      getWriteDetails: () => [],
      readValueOrThrow: () => undefined,
    };

    expect(wildcardPolicyMatchesValue(tx, target, policySchema, linkValue))
      .toBe(true);
  });

  it("still value-conditions when the linked target resolves to a non-matching value", () => {
    // The link resolves to a string; the policy schema requires an object, so
    // the entry legitimately does not apply (the value-condition is real data,
    // not an author-controlled schema).
    const tx = {
      getWriteDetails: () => [
        {
          address: {
            space,
            id: linkedTargetId,
            scope: "space" as const,
            path: ["value"],
          },
          value: "a string, not an object",
        },
      ],
      readValueOrThrow: () => undefined,
    };

    expect(wildcardPolicyMatchesValue(tx, target, policySchema, linkValue))
      .toBe(false);
  });
});
