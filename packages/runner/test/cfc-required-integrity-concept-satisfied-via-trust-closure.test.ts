import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { prepareCfcCommitIfNeeded } from "../src/cfc/prepare-shim.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import type { URI } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase(
  "cfc required integrity trust closure test",
);
const space = signer.did();

const requiredConcept =
  "https://commonfabric.org/cfc/concepts/verified-input";
const intermediateConcept =
  "https://commonfabric.org/cfc/concepts/runtime-attested";

const conceptRequiredIntegritySchema = {
  type: "number",
  ifc: {
    requiredIntegrity: [requiredConcept],
  },
} as const satisfies JSONSchema;

describe("CFC requiredIntegrity trust closure", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      storageManager,
      apiUrl: new URL(import.meta.url),
      cfcTrustContext: {
        delegations: [{
          delegator: signer.did(),
          verifier: "did:key:cfc-required-integrity-verifier",
          scope: {
            concepts: [intermediateConcept],
          },
        }],
        statements: [{
          verifier: "did:key:cfc-required-integrity-verifier",
          concrete: "runtime-attested-source",
          concept: intermediateConcept,
        }],
        conceptEdges: [{
          from: intermediateConcept,
          to: requiredConcept,
        }],
      },
    });
    runtime.scheduler.disablePullMode();
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  async function seedInputWithIntegrity(
    id: URI,
    value: number,
    integrity: readonly string[],
  ): Promise<void> {
    const tx = runtime.edit();
    tx.writeOrThrow({
      space,
      id,
      type: "application/json",
      path: ["value"],
    }, value);
    tx.writeOrThrow({
      space,
      id,
      type: "application/json",
      path: ["cfc", "labels"],
    }, {
      "/": {
        classification: ["confidential"],
        integrity,
      },
    });
    const { error } = await tx.commit();
    expect(error).toBeUndefined();
  }

  it("accepts concrete integrity that reaches the required concept through trust closure", async () => {
    const sourceId = runtime.getCell(
      space,
      "cfc-required-integrity-trust-closure-source",
    ).getAsNormalizedFullLink().id;
    await seedInputWithIntegrity(sourceId, 1, ["runtime-attested-source"]);

    const tx = runtime.edit();
    const source = runtime.getCell<number>(
      space,
      "cfc-required-integrity-trust-closure-source",
    );
    const target = runtime.getCell<number>(
      space,
      "cfc-required-integrity-trust-closure-target",
    );

    const value = Number(
      source.withTx(tx).asSchema(conceptRequiredIntegritySchema).get() ?? 0,
    );
    target.withTx(tx).set(value + 1);

    await prepareCfcCommitIfNeeded(tx);
    const { error } = await tx.commit();

    expect(error).toBeUndefined();
  });
});
