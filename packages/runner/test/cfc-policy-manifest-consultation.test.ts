import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { cfcAtom } from "@commonfabric/api/cfc";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import {
  createTxCfcModulePolicyResolver,
  preparedDigestFor,
  type PreparedDigestInput,
} from "../src/cfc/mod.ts";

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

      const absent = createTxCfcModulePolicyResolver(tx, () => undefined);
      expect(absent(reference)).toBeUndefined();
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
});
