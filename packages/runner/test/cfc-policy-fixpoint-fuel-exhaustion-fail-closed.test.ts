import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { prepareCfcCommitIfNeeded } from "../src/cfc/prepare-shim.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import type { URI } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("cfc policy fixpoint fuel test");
const space = signer.did();

const sourceSchema = {
  type: "number",
  ifc: { classification: ["secret"] },
} as const satisfies JSONSchema;

const fuelExhaustionPolicySchema = {
  type: "number",
  ifc: {
    classification: ["confidential"],
    exchange: {
      fuel: 0,
      rules: [
        {
          confidentialityPre: ["secret"],
          integrityPre: ["proof-token"],
          addAlternatives: ["confidential"],
          releaseCondition: true,
        },
      ],
    },
  },
} as const satisfies JSONSchema;

describe("CFC policy fixpoint fuel exhaustion", () => {
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

  async function seedSourceLabels(
    id: URI,
    value: unknown,
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
        classification: ["secret"],
        integrity: [...integrity],
      },
    });
    const { error } = await tx.commit();
    if (error) {
      throw new Error(`seed labels failed: ${error.name}`);
    }
  }

  it("fails closed when policy fixpoint fuel is exhausted", async () => {
    let tx = runtime.edit();
    const source = runtime.getCell<number>(
      space,
      "cfc-policy-fuel-source",
      undefined,
      tx,
    );
    const target = runtime.getCell<number>(
      space,
      "cfc-policy-fuel-target",
      undefined,
      tx,
    );
    source.set(10);
    target.set(0);
    await tx.commit();

    await seedSourceLabels(
      source.getAsNormalizedFullLink().id,
      10,
      ["proof-token"],
    );

    tx = runtime.edit();
    const value = Number(source.withTx(tx).asSchema(sourceSchema).get() ?? 0);
    target.withTx(tx).asSchema(fuelExhaustionPolicySchema).set(value + 1);

    let thrown: unknown;
    try {
      await prepareCfcCommitIfNeeded(tx);
    } catch (error) {
      thrown = error;
    }
    tx.abort(thrown);

    expect((thrown as { name?: string } | undefined)?.name).toBe(
      "CfcPolicyNonConvergenceError",
    );
  });
});
