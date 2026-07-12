import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { CFC_ATOM_TYPE } from "@commonfabric/api/cfc";
import { hashStringOf } from "@commonfabric/data-model/value-hash";
import {
  buildCfcPolicyArtifactManifest,
  validateCfcPolicyArtifactManifest,
} from "../src/cfc/policy.ts";

const manifestBody = () => ({
  formatVersion: 1 as const,
  moduleIdentity: "sha256:module",
  symbol: "releaseRules",
  template: {
    templateVersion: 1 as const,
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

describe("CFC module policy templates", () => {
  it("computes the normative manifest digest and deep-freezes the artifact", () => {
    const body = manifestBody();
    const artifact = buildCfcPolicyArtifactManifest(body);
    expect(artifact.policyDigest).toBe(hashStringOf({
      domain: "cfc/policy-manifest/v1",
      manifest: body,
    }));
    expect(artifact.manifest).toEqual(body);
    expect(Object.isFrozen(artifact)).toBe(true);
    expect(Object.isFrozen(artifact.manifest)).toBe(true);
    expect(Object.isFrozen(artifact.manifest.template)).toBe(true);
    expect(Object.isFrozen(artifact.manifest.template.exchangeRules[0])).toBe(
      true,
    );
  });

  it("is insensitive to authored object-key order", () => {
    const a = buildCfcPolicyArtifactManifest(manifestBody());
    const source = manifestBody();
    const b = buildCfcPolicyArtifactManifest({
      symbol: source.symbol,
      template: {
        integrityRequirements: source.template.integrityRequirements,
        dependencies: source.template.dependencies,
        exchangeRules: source.template.exchangeRules,
        templateVersion: source.template.templateVersion,
      },
      moduleIdentity: source.moduleIdentity,
      formatVersion: source.formatVersion,
    });
    expect(b.policyDigest).toBe(a.policyDigest);
  });

  it("validates a transported envelope and rejects digest tampering", () => {
    const artifact = buildCfcPolicyArtifactManifest(manifestBody());
    expect(validateCfcPolicyArtifactManifest(artifact)).toEqual(artifact);
    expect(() =>
      validateCfcPolicyArtifactManifest({
        ...artifact,
        policyDigest: "sha256:wrong",
      })
    ).toThrow(/policyDigest mismatch/);
  });

  it("rejects unsupported versions, unknown keys, and duplicate rule ids", () => {
    expect(() =>
      buildCfcPolicyArtifactManifest({
        ...manifestBody(),
        formatVersion: 2,
      } as never)
    ).toThrow(/formatVersion must be 1/);
    expect(() =>
      buildCfcPolicyArtifactManifest({
        ...manifestBody(),
        extra: true,
      } as never)
    ).toThrow(/unknown key "extra"/);
    const duplicate = manifestBody();
    duplicate.template.exchangeRules.push(
      duplicate.template.exchangeRules[0],
    );
    expect(() => buildCfcPolicyArtifactManifest(duplicate)).toThrow(
      /duplicate rule id/,
    );
  });

  it("rejects general rules without integrity or policy-state evidence", () => {
    const body = manifestBody();
    body.template.exchangeRules[0] = {
      ...body.template.exchangeRules[0],
      preCondition: { boundary: [{ sink: "display" }] },
    } as never;
    expect(() => buildCfcPolicyArtifactManifest(body)).toThrow(
      /integrity or policyState guard/,
    );
  });

  it("rejects postcondition variables unbound by the target or guards", () => {
    const body = manifestBody();
    body.template.exchangeRules[0] = {
      ...body.template.exchangeRules[0],
      post: {
        addAlternatives: [{
          type: CFC_ATOM_TYPE.User,
          subject: { var: "$unbound" },
        }],
      },
    };
    expect(() => buildCfcPolicyArtifactManifest(body)).toThrow(
      /unbound postcondition variable "\$unbound"/,
    );
  });

  it("keeps legacy deployment-record digest bytes unchanged", async () => {
    const { buildCfcPolicySnapshot } = await import("../src/cfc/policy.ts");
    const input = [{
      id: "legacy",
      selection: "referenced" as const,
      rules: [{
        id: "release",
        appliesTo: { type: CFC_ATOM_TYPE.Space, id: "space:a" },
        preCondition: {
          integrity: [{
            type: CFC_ATOM_TYPE.HasRole,
            principal: "did:key:alice",
            space: "space:a",
            role: "reader",
          }],
        },
        post: {
          addAlternatives: [{
            type: CFC_ATOM_TYPE.User,
            subject: "did:key:alice",
          }],
        },
      }],
    }];
    const before = buildCfcPolicySnapshot(input)!.records[0].digest;
    buildCfcPolicyArtifactManifest(manifestBody());
    expect(buildCfcPolicySnapshot(input)!.records[0].digest).toBe(before);
  });
});
