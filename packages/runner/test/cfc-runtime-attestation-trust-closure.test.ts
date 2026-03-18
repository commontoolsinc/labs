import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { prepareCfcCommitIfNeeded } from "../src/cfc/prepare-shim.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import type { URI } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase(
  "cfc runtime attestation trust closure test",
);
const space = signer.did();

const approvedRuntimeConcept =
  "https://commonfabric.org/cfc/concepts/approved-runtime-profile";

const runtimeProfileAtom = {
  type: "https://commonfabric.org/cfc/atom/RuntimeProfile",
  profile: "calendar-intersection-v1",
} as const;

const approvedRuntimeSchema = {
  type: "number",
  ifc: {
    requiredIntegrity: [approvedRuntimeConcept],
  },
} as const satisfies JSONSchema;

describe("CFC structured attestation trust closure", () => {
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
          verifier: "did:key:cfc-runtime-attestation-verifier",
          scope: {
            concepts: [approvedRuntimeConcept],
          },
        }],
        statements: [{
          verifier: "did:key:cfc-runtime-attestation-verifier",
          concrete: runtimeProfileAtom,
          concept: approvedRuntimeConcept,
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
    integrity: readonly unknown[],
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
        integrity,
      },
    });
    const { error } = await tx.commit();
    expect(error).toBeUndefined();
  }

  it("accepts structured runtime attestations that reach a required concept through trust closure", async () => {
    const sourceId = runtime.getCell(
      space,
      "cfc-runtime-attestation-source",
    ).getAsNormalizedFullLink().id;
    await seedInputWithIntegrity(sourceId, 1, [runtimeProfileAtom]);

    const tx = runtime.edit();
    const source = runtime.getCell<number>(
      space,
      "cfc-runtime-attestation-source",
    );
    const target = runtime.getCell<number>(
      space,
      "cfc-runtime-attestation-target",
    );

    const value = Number(
      source.withTx(tx).asSchema(approvedRuntimeSchema).get() ?? 0,
    );
    target.withTx(tx).set(value + 1);

    await prepareCfcCommitIfNeeded(tx);
    const { error } = await tx.commit();

    expect(error).toBeUndefined();
  });
});
