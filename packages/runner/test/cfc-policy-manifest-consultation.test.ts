import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { CFC_ATOM_TYPE, cfcAtom } from "@commonfabric/api/cfc";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import {
  buildCfcPolicyArtifactManifest,
  cfcPolicyManifestDocId,
} from "../src/cfc/policy.ts";
import {
  createTxCfcModulePolicyResolver,
  preparedDigestFor,
  type PreparedDigestInput,
} from "../src/cfc/mod.ts";
import { TransactionWrapper } from "../src/storage/extended-storage-transaction.ts";
import { snapshotQueryResult } from "../src/query-result-proxy.ts";

const signer = await Identity.fromPassphrase("manifest-consultation");
const reference = cfcAtom.modulePolicyRef(
  "sha256:module",
  "releaseRules",
  "sha256:manifest",
  "did:key:subject",
);

const base: PreparedDigestInput = {
  consumedReads: [],
  attemptedWrites: [],
  writes: [],
  writeAttemptLog: [],
  dereferenceTraces: [],
  triggerReads: [],
  writePolicyInputs: [],
};

describe("module-policy manifest consultation", () => {
  it("binds present/absent state into the prepared digest", () => {
    const present = { reference, state: "present" as const };
    const absent = { reference, state: "absent" as const };
    expect(preparedDigestFor({
      ...base,
      consultedPolicyManifests: [present],
    })).not.toBe(preparedDigestFor({
      ...base,
      consultedPolicyManifests: [absent],
    }));
    expect(preparedDigestFor({
      ...base,
      consultedPolicyManifests: [],
    })).toBe(preparedDigestFor(base));
  });

  it("canonicalizes consultation order", () => {
    const other = {
      reference: cfcAtom.modulePolicyRef(
        reference.moduleIdentity,
        reference.symbol,
        reference.policyDigest,
        "did:key:other",
      ),
      state: "present" as const,
    };
    const first = { reference, state: "present" as const };
    expect(preparedDigestFor({
      ...base,
      consultedPolicyManifests: [first, other],
    })).toBe(preparedDigestFor({
      ...base,
      consultedPolicyManifests: [other, first],
    }));

    const absent = { reference, state: "absent" as const };
    expect(preparedDigestFor({
      ...base,
      consultedPolicyManifests: [first, absent],
    })).toBe(preparedDigestFor({
      ...base,
      consultedPolicyManifests: [absent, first],
    }));
  });

  it("records durable-loader results on the transaction", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
    });
    try {
      const tx = runtime.edit();
      const present = createTxCfcModulePolicyResolver(tx, () => ({
        policyDigest: reference.policyDigest,
      }));
      expect(present(reference)).toEqual({
        policyDigest: reference.policyDigest,
      });
      expect(tx.getCfcState().consultedPolicyManifests).toEqual([{
        reference,
        state: "present",
      }]);
      tx.markCfcRelevant("manifest-consultation-test");
      tx.prepareCfc();
      expect(present(reference)).toEqual({
        policyDigest: reference.policyDigest,
      });

      const absent = createTxCfcModulePolicyResolver(tx, () => undefined);
      expect(absent(reference)).toBeUndefined();
      expect(tx.getCfcState().consultedPolicyManifests).toEqual([{
        reference,
        state: "absent",
      }]);

      const failing = createTxCfcModulePolicyResolver(tx, () => {
        throw new Error("loader failed");
      });
      expect(() => failing(reference)).toThrow("loader failed");
      expect(tx.getCfcState().consultedPolicyManifests).toEqual([{
        reference,
        state: "absent",
      }]);
      tx.abort();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("registers, installs, resolves, and wraps durable manifests", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
    });
    const artifact = buildCfcPolicyArtifactManifest({
      formatVersion: 1,
      moduleIdentity: "sha256:durable-module",
      symbol: "rules",
      template: {
        templateVersion: 1,
        exchangeRules: [],
        dependencies: { authorityOnly: [], dataBearing: [] },
        integrityRequirements: {},
      },
    });
    const durableReference = cfcAtom.modulePolicyRef(
      artifact.manifest.moduleIdentity,
      artifact.manifest.symbol,
      artifact.policyDigest,
      signer.did(),
    );
    try {
      expect(runtime.resolveCfcPolicyManifest(null)).toBeUndefined();
      expect(runtime.resolveCfcPolicyManifest([])).toBeUndefined();
      expect(runtime.installCfcPolicyManifest(signer.did(), {})).toBe(false);

      runtime.registerCfcPolicyManifests(undefined, [artifact]);
      expect(runtime.resolveCfcPolicyManifest(durableReference)).toEqual(
        artifact,
      );
      const install = runtime.edit();
      const schema = {
        type: "string",
        ifc: {
          confidentiality: [{
            type: CFC_ATOM_TYPE.Policy,
            policyRefKind: "module",
            moduleIdentity: artifact.manifest.moduleIdentity,
            symbol: artifact.manifest.symbol,
            policyDigest: artifact.policyDigest,
            subject: { __ctOwningSpace: true },
          }],
        },
      } as const;
      runtime.getCell(
        signer.did(),
        "manifest-install-source",
        schema,
        install,
      ).set("secret");
      install.prepareCfc();
      install.recordCfcConsultedPolicyManifest({
        reference: cfcAtom.modulePolicyRef(
          artifact.manifest.moduleIdentity,
          artifact.manifest.symbol,
          artifact.policyDigest,
          "did:key:additional-subject",
        ),
        state: "absent",
      });
      install.prepareCfc();
      expect((await install.commit()).ok).toBeDefined();

      const scan = runtime.edit();
      runtime.getCell(signer.did(), "manifest-scan-probe", undefined, scan)
        .get();
      expect(
        runtime.resolveCfcPolicyManifest(durableReference, scan),
      ).toEqual(artifact);
      const wrapper = new TransactionWrapper(scan);
      wrapper.recordCfcConsultedPolicyManifest({
        reference: durableReference,
        state: "present",
      });
      expect(
        wrapper.resolveCfcPolicyManifest(durableReference, signer.did()),
      ).toEqual(artifact);
      expect(wrapper.hasCfcPolicyManifest(signer.did(), durableReference)).toBe(
        true,
      );
      expect(
        wrapper.installCfcPolicyManifest(signer.did(), durableReference),
      ).toBe(true);
      scan.abort();

      const coldRuntime = new Runtime({
        apiUrl: new URL("https://example.com"),
        storageManager,
      });
      const coldRead = coldRuntime.edit();
      expect(
        coldRuntime.resolveCfcPolicyManifest(
          durableReference,
          coldRead,
          signer.did(),
        ),
      ).toEqual(artifact);
      expect(
        coldRuntime.hasCfcPolicyManifest(
          signer.did(),
          durableReference,
          coldRead,
        ),
      ).toBe(true);
      expect(
        coldRuntime.installCfcPolicyManifest(
          signer.did(),
          durableReference,
          coldRead,
        ),
      ).toBe(true);
      coldRead.abort();

      const tamper = storageManager.edit();
      expect(
        tamper.write({
          space: signer.did(),
          id: cfcPolicyManifestDocId(artifact.policyDigest),
          type: "application/json",
          path: ["value"],
        }, { forged: true }).ok,
      ).toBeDefined();
      expect((await tamper.commit()).ok).toBeDefined();
      const invalid = coldRuntime.edit();
      expect(
        coldRuntime.resolveCfcPolicyManifest(
          durableReference,
          invalid,
          signer.did(),
        ),
      ).toBeUndefined();
      invalid.abort();
      await coldRuntime.dispose();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("fails closed on malformed and colliding durable artifacts", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
    });
    const artifact = buildCfcPolicyArtifactManifest({
      formatVersion: 1,
      moduleIdentity: "sha256:destination-errors",
      symbol: "rules",
      template: {
        templateVersion: 1,
        exchangeRules: [],
        dependencies: { authorityOnly: [], dataBearing: [] },
        integrityRequirements: {},
      },
    });
    const otherArtifact = buildCfcPolicyArtifactManifest({
      ...artifact.manifest,
      symbol: "otherRules",
    });
    const reference = cfcAtom.modulePolicyRef(
      artifact.manifest.moduleIdentity,
      artifact.manifest.symbol,
      artifact.policyDigest,
      signer.did(),
    );
    const writeRawManifest = async (
      space: ReturnType<typeof signer.did>,
      value: unknown,
    ) => {
      const raw = storageManager.edit();
      raw.write({
        space,
        id: cfcPolicyManifestDocId(artifact.policyDigest),
        type: "application/json",
        path: ["value"],
      }, value as never);
      expect((await raw.commit()).ok).toBeDefined();
    };

    try {
      runtime.registerCfcPolicyManifests(undefined, [artifact]);

      const malformedSpace = (await Identity.fromPassphrase(
        "malformed manifest destination",
      )).did();
      await writeRawManifest(malformedSpace, { forged: true });
      const malformed = runtime.edit();
      expect(() =>
        runtime.installCfcPolicyManifest(
          malformedSpace,
          reference,
          malformed,
        )
      ).toThrow("invalid destination artifact");
      malformed.abort();

      const collisionSpace = (await Identity.fromPassphrase(
        "colliding manifest destination",
      )).did();
      await writeRawManifest(collisionSpace, otherArtifact);
      const collision = runtime.edit();
      expect(() =>
        runtime.installCfcPolicyManifest(
          collisionSpace,
          reference,
          collision,
        )
      ).toThrow("immutable destination collision");
      collision.abort();

      const validSpace = (await Identity.fromPassphrase(
        "valid manifest destination",
      )).did();
      await writeRawManifest(validSpace, artifact);
      const malformedReference = runtime.edit();
      expect(
        runtime.resolveCfcPolicyManifest(null, malformedReference, validSpace),
      ).toBeUndefined();
      expect(
        runtime.resolveCfcPolicyManifest({}, malformedReference, validSpace),
      ).toBeUndefined();
      expect(
        runtime.resolveCfcPolicyManifest(
          { ...reference, moduleIdentity: "sha256:wrong" },
          malformedReference,
          validSpace,
        ),
      ).toBeUndefined();
      malformedReference.abort();

      const binding = runtime.edit();
      const noPrecondition = new Proxy(binding, {
        get(target, property, receiver) {
          if (property === "addCommitPrecondition") return undefined;
          const value = Reflect.get(target, property, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      expect(() =>
        runtime.resolveCfcPolicyManifest(
          reference,
          noPrecondition,
          validSpace,
        )
      ).toThrow("storage cannot bind manifest consultation");
      binding.abort();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("snapshots circular values without recursing forever", () => {
    const circular: { self?: unknown } = {};
    circular.self = circular;
    const snapshot = snapshotQueryResult(circular);
    expect(snapshot).not.toBe(circular);
    expect(snapshot.self).toBe(snapshot);
  });
});
