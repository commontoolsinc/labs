import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { wildcardPolicyMatchesValue } from "../src/cfc/prepare.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

// Regression guard for $ref resolution inside policy value matching.
//
// The schema generator emits named types as `#/$defs/<name>` refs with the
// `$defs` on the root schema (e.g. profile-home's owner-protected `elements`
// list: `{type: "array", items: {$ref: "#/$defs/ProfileElement"}, ifc, $defs}`).
// The pre-fix matcher recursed into `properties`/`items`/compound branches
// without threading the root document, so a nested `$ref` was resolved against
// the bare ref node itself, warned "Unresolved $ref", and failed closed — the
// policy entry was treated as not applying even though the schema was valid.
// Only a ref that is genuinely unresolvable against its document may fail
// closed.
describe("CFC policy value matching resolves $refs against the schema root", () => {
  const space = "did:key:policy-schema-refs" as const;
  const target = { space, id: "of:guarded" as const, scope: "space" as const };
  const tx = {
    getWriteDetails: () => [],
    readValueOrThrow: () => undefined,
  } as unknown as IExtendedStorageTransaction;

  it("matches an array value whose items schema is a #/$defs ref", () => {
    const schema = {
      type: "array",
      items: { $ref: "#/$defs/ProfileElement" },
      ifc: { writeAuthorizedBy: ["trusted-handler"] },
      $defs: {
        ProfileElement: {
          type: "object",
          properties: { cell: true, tag: { type: "string" } },
          required: ["cell"],
        },
      },
    } as const satisfies JSONSchema;

    expect(wildcardPolicyMatchesValue(tx, target, schema, [
      { cell: { some: "link" }, tag: "profile-card" },
    ])).toBe(true);
  });

  it("value-conditions through a nested property $ref", () => {
    const schema = {
      type: "object",
      properties: { element: { $ref: "#/$defs/Element" } },
      $defs: {
        Element: { type: "string" },
      },
    } as const satisfies JSONSchema;

    expect(wildcardPolicyMatchesValue(tx, target, schema, {
      element: "ok",
    })).toBe(true);
    expect(wildcardPolicyMatchesValue(tx, target, schema, {
      element: 42,
    })).toBe(false);
  });

  it("still fails closed on a genuinely unresolvable nested $ref", () => {
    const schema = {
      type: "array",
      items: { $ref: "#/$defs/Missing" },
      $defs: {
        Present: { type: "string" },
      },
    } as const satisfies JSONSchema;

    expect(wildcardPolicyMatchesValue(tx, target, schema, [{ x: 1 }]))
      .toBe(false);
  });
});
