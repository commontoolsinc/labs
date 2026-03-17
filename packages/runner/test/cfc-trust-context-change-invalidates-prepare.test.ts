import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { prepareCfcCommitIfNeeded } from "../src/cfc/prepare-shim.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import type { CfcTrustContext } from "../src/cfc/integrity-trust.ts";

const signer = await Identity.fromPassphrase(
  "cfc trust-context prepare invalidation test",
);
const space = signer.did();

const conceptRequiredIntegrity =
  "https://commonfabric.org/cfc/concepts/verified-input";

const conceptRequiredIntegritySchema = {
  type: "number",
  ifc: {
    requiredIntegrity: [conceptRequiredIntegrity],
  },
} as const satisfies JSONSchema;

function createTrustContext(delegator: string): CfcTrustContext {
  return {
    delegations: [{
      delegator,
      verifier: "did:key:cfc-trust-context-verifier",
      scope: {
        concepts: [conceptRequiredIntegrity],
      },
    }],
    statements: [{
      verifier: "did:key:cfc-trust-context-verifier",
      concrete: "runtime-attested-source",
      concept: conceptRequiredIntegrity,
    }],
  };
}

describe("CFC trust-context prepare invalidation", () => {
  it("rejects commit when the trust-context snapshot changes after prepare", async () => {
    let trustContext: CfcTrustContext | undefined = createTrustContext(
      signer.did(),
    );
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      storageManager,
      apiUrl: new URL(import.meta.url),
      cfcTrustContext: () => trustContext,
    });
    runtime.scheduler.disablePullMode();

    try {
      let tx = runtime.edit();
      const sourceCell = runtime.getCell<number>(
        space,
        "cfc-trust-context-source",
        undefined,
        tx,
      );
      const targetCell = runtime.getCell<number>(
        space,
        "cfc-trust-context-target",
        undefined,
        tx,
      );
      sourceCell.set(1);
      targetCell.set(0);
      let result = await tx.commit();
      expect(result.error).toBeUndefined();

      tx = runtime.edit();
      tx.writeOrThrow({
        space,
        id: sourceCell.getAsNormalizedFullLink().id,
        type: "application/json",
        path: ["cfc", "labels"],
      }, {
        "/": {
          integrity: ["runtime-attested-source"],
        },
      });
      result = await tx.commit();
      expect(result.error).toBeUndefined();

      await sourceCell.pull();
      await targetCell.pull();

      const attemptTx = runtime.edit();
      const value = Number(
        sourceCell.withTx(attemptTx).asSchema(conceptRequiredIntegritySchema)
          .get() ?? 0,
      );
      targetCell.withTx(attemptTx).set(value + 1);

      await prepareCfcCommitIfNeeded(attemptTx);

      trustContext = undefined;

      const { error } = await attemptTx.commit();
      expect(error?.name).toBe("CfcPreparedDigestMismatchError");
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });
});
