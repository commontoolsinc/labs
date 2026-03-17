import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { prepareCfcCommitIfNeeded } from "../src/cfc/prepare-shim.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import type { CfcTrustContext } from "../src/cfc/integrity-trust.ts";

const signer = await Identity.fromPassphrase("cfc policy concept guard test");
const space = signer.did();

const conceptRequiredIntegrity =
  "https://commonfabric.org/cfc/concepts/verified-input";

const sourceSchema = {
  type: "number",
  ifc: { classification: ["secret"] },
} as const satisfies JSONSchema;

const declassifyViaConceptIntegritySchema = {
  type: "number",
  ifc: {
    classification: ["confidential"],
    declassify: {
      confidentialityPre: ["secret"],
      integrityPre: [conceptRequiredIntegrity],
      addAlternatives: ["confidential"],
      releaseCondition: true,
    },
  },
} as const satisfies JSONSchema;

function createTrustContext(delegator: string): CfcTrustContext {
  return {
    delegations: [{
      delegator,
      verifier: "did:key:cfc-policy-concept-verifier",
      scope: {
        concepts: [conceptRequiredIntegrity],
      },
    }],
    statements: [{
      verifier: "did:key:cfc-policy-concept-verifier",
      concrete: "runtime-attested-source",
      concept: conceptRequiredIntegrity,
    }],
  };
}

describe("CFC policy concept guard trust closure", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      storageManager,
      apiUrl: new URL(import.meta.url),
      cfcTrustContext: createTrustContext(signer.did()),
    });
    runtime.scheduler.disablePullMode();
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  it("allows declassify integrityPre concepts via trust closure without stored concept atoms", async () => {
    let tx = runtime.edit();
    const source = runtime.getCell<number>(
      space,
      "cfc-policy-concept-source",
      undefined,
      tx,
    );
    const target = runtime.getCell<number>(
      space,
      "cfc-policy-concept-target",
      undefined,
      tx,
    );
    source.set(10);
    target.set(0);
    tx.writeOrThrow({
      space,
      id: source.getAsNormalizedFullLink().id,
      type: "application/json",
      path: ["cfc", "labels"],
    }, {
      "/": {
        classification: ["secret"],
        integrity: ["runtime-attested-source"],
      },
    });
    await tx.commit();

    tx = runtime.edit();
    const value = Number(source.withTx(tx).asSchema(sourceSchema).get() ?? 0);
    target.withTx(tx).asSchema(declassifyViaConceptIntegritySchema).set(
      value + 1,
    );

    await prepareCfcCommitIfNeeded(tx);
    const { error } = await tx.commit();
    expect(error).toBeUndefined();
  });
});
