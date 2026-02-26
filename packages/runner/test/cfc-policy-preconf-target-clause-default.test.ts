import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { prepareCfcCommitIfNeeded } from "../src/cfc/prepare-shim.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import type { URI } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase(
  "cfc policy preconf target clause test",
);
const space = signer.did();

const secretSourceSchema = {
  type: "number",
  ifc: { classification: ["secret"] },
} as const satisfies JSONSchema;

const confidentialSourceSchema = {
  type: "number",
  ifc: { classification: ["confidential"] },
} as const satisfies JSONSchema;

const targetClauseScopedPolicySchema = {
  type: "number",
  ifc: {
    classification: ["confidential"],
    exchange: {
      confidentialityPre: ["secret", "confidential"],
      integrityPre: ["proof-token"],
      addAlternatives: ["confidential"],
      releaseCondition: true,
    },
  },
} as const satisfies JSONSchema;

describe("CFC policy preConf scope default", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      storageManager,
      apiUrl: new URL(import.meta.url),
    });
    runtime.scheduler.disablePullMode();
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  async function seedLabels(
    id: URI,
    value: unknown,
    classification: string,
    integrity: readonly string[],
  ): Promise<void> {
    const tx = runtime.edit();
    tx.writeOrThrow({
      space,
      id,
      type: "application/json",
      path: ["value"],
    }, value as any);
    tx.writeOrThrow({
      space,
      id,
      type: "application/json",
      path: ["cfc", "labels"],
    }, {
      "/": {
        classification: [classification],
        integrity: [...integrity],
      },
    });
    const { error } = await tx.commit();
    if (error) {
      throw new Error(`seed labels failed: ${error.name}`);
    }
  }

  it("defaults to clause-local confidentiality matching and blocks cross-clause rewrite", async () => {
    let tx = runtime.edit();
    const secretSource = runtime.getCell<number>(
      space,
      "cfc-policy-preconf-target-source-secret",
      undefined,
      tx,
    );
    const confidentialSource = runtime.getCell<number>(
      space,
      "cfc-policy-preconf-target-source-confidential",
      undefined,
      tx,
    );
    const target = runtime.getCell<number>(
      space,
      "cfc-policy-preconf-target-target",
      undefined,
      tx,
    );
    secretSource.set(7);
    confidentialSource.set(3);
    target.set(0);
    await tx.commit();

    await seedLabels(
      secretSource.getAsNormalizedFullLink().id,
      7,
      "secret",
      ["proof-token"],
    );
    await seedLabels(
      confidentialSource.getAsNormalizedFullLink().id,
      3,
      "confidential",
      ["proof-token"],
    );

    tx = runtime.edit();
    const a = Number(
      secretSource.withTx(tx).asSchema(secretSourceSchema).get() ?? 0,
    );
    const b = Number(
      confidentialSource.withTx(tx).asSchema(confidentialSourceSchema).get() ??
        0,
    );
    target.withTx(tx).asSchema(targetClauseScopedPolicySchema).set(a + b);

    let thrown: unknown;
    try {
      await prepareCfcCommitIfNeeded(tx);
    } catch (error) {
      thrown = error;
    }
    tx.abort(thrown);

    expect((thrown as { name?: string } | undefined)?.name).toBe(
      "CfcOutputTransitionViolationError",
    );
    expect(
      (thrown as { requirement?: string } | undefined)?.requirement,
    ).toBe("confidentialityMonotonicity");
  });
});
