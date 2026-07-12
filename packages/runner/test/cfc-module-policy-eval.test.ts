import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { CFC_ATOM_TYPE, cfcAtom } from "@commonfabric/api/cfc";
import {
  buildCfcPolicyArtifactManifest,
  type PolicyArtifactManifestV1,
} from "../src/cfc/policy.ts";
import { evaluateExchangeRules } from "../src/cfc/exchange-eval.ts";
import {
  commitCfcFieldValue,
  transformCfcLabelForCrossSpacePersist,
} from "../src/cfc/label-representation.ts";

const MODULE = "sha256:module";
const SYMBOL = "releaseRules";
const ALICE_SPACE = "did:key:alice-space";
const BOB_SPACE = "did:key:bob-space";
const REVIEWER = "did:key:reviewer";

const artifact: PolicyArtifactManifestV1 = buildCfcPolicyArtifactManifest({
  formatVersion: 1,
  moduleIdentity: MODULE,
  symbol: SYMBOL,
  template: {
    templateVersion: 1,
    exchangeRules: [{
      id: "releaseToReviewer",
      appliesTo: { thisPolicy: true },
      preCondition: {
        integrity: [{
          type: CFC_ATOM_TYPE.HasRole,
          principal: { var: "$reviewer" },
          space: { thisPolicyField: "subject" },
          role: "reader",
        }],
      },
      post: {
        addAlternatives: [{
          type: CFC_ATOM_TYPE.User,
          subject: { var: "$reviewer" },
        }],
      },
    }],
    dependencies: { authorityOnly: [], dataBearing: [] },
    integrityRequirements: {},
  },
});

const ref = (subject: string) =>
  cfcAtom.modulePolicyRef(
    MODULE,
    SYMBOL,
    artifact.policyDigest,
    subject,
  );

const resolver = () => artifact;

describe("module-policy exchange evaluation", () => {
  it("resolves only a selected manifest and releases its home clause", () => {
    let calls = 0;
    const selected = ref(ALICE_SPACE);
    const result = evaluateExchangeRules(
      { confidentiality: [selected] },
      undefined,
      {
        modulePolicyResolver: () => {
          calls++;
          return artifact;
        },
        integrity: [cfcAtom.hasRole(REVIEWER, ALICE_SPACE, "reader")],
      },
    );
    expect(calls).toBe(1);
    expect(result.resolutionFailures).toEqual([]);
    expect(result.label.confidentiality).toEqual([{
      anyOf: [selected, cfcAtom.user(REVIEWER)],
    }]);
  });

  it("keeps wrong-subject evidence closed and sibling clauses untouched", () => {
    const aliceRef = ref(ALICE_SPACE);
    const bobRef = ref(BOB_SPACE);
    const sibling = cfcAtom.user("did:key:unrelated");
    const result = evaluateExchangeRules(
      { confidentiality: [aliceRef, bobRef, sibling] },
      undefined,
      {
        modulePolicyResolver: resolver,
        integrity: [cfcAtom.hasRole(REVIEWER, ALICE_SPACE, "reader")],
      },
    );
    expect(result.label.confidentiality).toEqual([
      { anyOf: [aliceRef, cfcAtom.user(REVIEWER)] },
      bobRef,
      sibling,
    ]);
  });

  it("matches plaintext evidence after the selected subject is committed", () => {
    const persisted = transformCfcLabelForCrossSpacePersist({
      confidentiality: [ref(ALICE_SPACE)],
    });
    const result = evaluateExchangeRules(persisted, undefined, {
      modulePolicyResolver: resolver,
      integrity: [cfcAtom.hasRole(REVIEWER, ALICE_SPACE, "reader")],
    });
    expect(result.firings).toHaveLength(1);
    expect(result.label.confidentiality?.[0]).toEqual({
      anyOf: [
        cfcAtom.user(REVIEWER),
        {
          ...ref(ALICE_SPACE),
          subject: commitCfcFieldValue(ALICE_SPACE),
        },
      ],
    });
  });

  it("fails closed on a missing resolver or missing manifest", () => {
    const label = { confidentiality: [ref(ALICE_SPACE)] };
    for (
      const context of [
        {},
        { modulePolicyResolver: () => undefined },
      ]
    ) {
      const result = evaluateExchangeRules(label, undefined, context);
      expect(result.label).toBe(label);
      expect(result.firings).toEqual([]);
      expect(result.resolutionFailures).toHaveLength(1);
    }
  });

  it("fails closed on a manifest pair or digest mismatch", () => {
    const label = { confidentiality: [ref(ALICE_SPACE)] };
    const wrongPair = {
      ...artifact,
      manifest: { ...artifact.manifest, symbol: "otherRules" },
    };
    const wrongDigest = { ...artifact, policyDigest: "sha256:wrong" };
    for (const resolved of [wrongPair, wrongDigest]) {
      const result = evaluateExchangeRules(label, undefined, {
        modulePolicyResolver: () => resolved,
      });
      expect(result.label).toBe(label);
      expect(result.resolutionFailures).toHaveLength(1);
    }
  });

  it("rejects ambiguous module references that mix named fields", () => {
    const ambiguous = {
      ...ref(ALICE_SPACE),
      name: "legacy",
      hash: "sha256:legacy",
    };
    const label = { confidentiality: [ambiguous] };
    const result = evaluateExchangeRules(label, undefined, {
      modulePolicyResolver: resolver,
    });
    expect(result.label).toBe(label);
    expect(result.resolutionFailures).toHaveLength(1);
  });
});
