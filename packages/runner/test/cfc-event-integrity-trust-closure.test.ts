import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { assertThrows } from "@std/assert";
import {
  assertRequiredEventIntegrity,
  findMissingEventIntegrityPatterns,
} from "../src/cfc/event-integrity-guard.ts";

const trustedDirectCommandUiConcept =
  "https://commonfabric.org/cfc/concepts/trusted-direct-command-ui";

const directCommandCodeHashAtom = {
  type: "https://commonfabric.org/cfc/atom/CodeHash",
  hash: "sha256:trusted-direct-command-pattern",
} as const;

const submitActionContractAtom = {
  type: "https://commonfabric.org/cfc/atom/UiActionContract",
  action: "SubmitDirectCommand",
} as const;

const trustContext = {
  delegations: [{
    delegator: "did:key:event-integrity-user",
    verifier: "did:key:event-integrity-verifier",
    scope: {
      concepts: [trustedDirectCommandUiConcept],
    },
  }],
  statements: [{
    verifier: "did:key:event-integrity-verifier",
    concrete: directCommandCodeHashAtom,
    concept: trustedDirectCommandUiConcept,
  }],
} as const;

describe("CFC event integrity trust closure", () => {
  it("accepts concept requirements satisfied via trust closure over event integrity", () => {
    expect(() =>
      assertRequiredEventIntegrity(
        {
          integrity: [directCommandCodeHashAtom, submitActionContractAtom],
        },
        [trustedDirectCommandUiConcept, submitActionContractAtom],
        "SubmitDirectCommand",
        {
          actingPrincipal: "did:key:event-integrity-user",
          trustContext,
        },
      )
    ).not.toThrow();
  });

  it("reports concept requirements as missing without matching trust closure", () => {
    const missing = findMissingEventIntegrityPatterns(
      [directCommandCodeHashAtom, submitActionContractAtom],
      [trustedDirectCommandUiConcept, submitActionContractAtom],
      {
        actingPrincipal: "did:key:event-integrity-user",
      },
    );
    expect(missing).toEqual([trustedDirectCommandUiConcept]);

    assertThrows(
      () =>
        assertRequiredEventIntegrity(
          {
            integrity: [directCommandCodeHashAtom, submitActionContractAtom],
          },
          [trustedDirectCommandUiConcept, submitActionContractAtom],
          "SubmitDirectCommand",
          {
            actingPrincipal: "did:key:event-integrity-user",
          },
        ),
      Error,
      "Missing required event integrity",
    );
  });
});
