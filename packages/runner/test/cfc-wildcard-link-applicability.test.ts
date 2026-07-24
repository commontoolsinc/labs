import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { wildcardPolicyMatchesValue } from "../src/cfc/prepare.ts";
import { LINK_V1_TAG } from "../src/sigil-types.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

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

  // A link whose embedded schema (string) deliberately mismatches the object
  // policy schema, pointing at a target the transaction cannot resolve.
  const linkValue = {
    "/": {
      [LINK_V1_TAG]: {
        id: "of:unresolvable-target",
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
    } as unknown as IExtendedStorageTransaction;

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
            id: "of:unresolvable-target",
            scope: "space",
            path: ["value"],
          },
          value: "a string, not an object",
        },
      ],
      readValueOrThrow: () => undefined,
    } as unknown as IExtendedStorageTransaction;

    expect(wildcardPolicyMatchesValue(tx, target, policySchema, linkValue))
      .toBe(false);
  });
});

// CT-1895: policySchemaMatchesValue validated arrays only against `items`,
// so a tuple-shaped (prefixItems) value condition vacuously matched ANY
// array — the policy entry applied where its condition should have excluded
// it, or vice versa.
describe("CFC policy value-conditions on tuple (prefixItems) schemas", () => {
  const space = "did:key:tuple-policy" as const;
  const target = { space, id: "of:guarded" as const, scope: "space" as const };
  const tx = {
    getWriteDetails: () => [],
    readValueOrThrow: () => undefined,
  } as unknown as IExtendedStorageTransaction;

  it("conditions each tuple slot instead of vacuously matching", () => {
    const schema = {
      type: "array",
      prefixItems: [{ const: "transfer" }, { type: "number" }],
    } as const satisfies JSONSchema;

    expect(wildcardPolicyMatchesValue(tx, target, schema, ["transfer", 5]))
      .toBe(true);
    expect(wildcardPolicyMatchesValue(tx, target, schema, ["burn", 5]))
      .toBe(false);
    expect(wildcardPolicyMatchesValue(tx, target, schema, ["transfer", "x"]))
      .toBe(false);
  });

  it("a closed tuple (items: false) rejects extra elements", () => {
    // PR #4969 review: the shared matcher skipped boolean `items`, so a
    // closed tuple vacuously accepted arrays with extra elements — the
    // policy entry applied where its condition excluded the value shape.
    const schema = {
      type: "array",
      prefixItems: [{ const: "cmd" }],
      items: false,
    } as const satisfies JSONSchema;

    expect(wildcardPolicyMatchesValue(tx, target, schema, ["cmd"]))
      .toBe(true);
    expect(wildcardPolicyMatchesValue(tx, target, schema, ["cmd", "extra"]))
      .toBe(false);
  });

  it("conditions items only past the tuple slots", () => {
    const schema = {
      type: "array",
      prefixItems: [{ const: "cmd" }],
      items: { type: "number" },
    } as const satisfies JSONSchema;

    // Slot 0 is a string the `items` schema would reject — it must only
    // condition the elements past the tuple arity.
    expect(wildcardPolicyMatchesValue(tx, target, schema, ["cmd", 1, 2]))
      .toBe(true);
    expect(wildcardPolicyMatchesValue(tx, target, schema, ["cmd", 1, "x"]))
      .toBe(false);
  });
});
