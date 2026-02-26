import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { prepareCfcCommitIfNeeded } from "../src/cfc/prepare-shim.ts";
import type { JSONSchema } from "../src/builder/types.ts";

const signer = await Identity.fromPassphrase(
  "cfc policy preconf anywhere test",
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

const anywherePolicySchema = {
  type: "number",
  ifc: {
    classification: ["confidential"],
    exchange: {
      confidentialityPre: ["secret", "confidential"],
      integrityPre: ["proof-token"],
      preConfScope: "anywhere",
      addAlternatives: ["confidential"],
      releaseCondition: true,
    },
  },
} as const satisfies JSONSchema;

describe("CFC policy preConf anywhere opt-in", () => {
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

  it("allows cross-clause policy matching only with explicit anywhere scope", async () => {
    let tx = runtime.edit();
    const secretSource = runtime.getCell<number>(
      space,
      "cfc-policy-preconf-anywhere-source-secret",
      undefined,
      tx,
    );
    const confidentialSource = runtime.getCell<number>(
      space,
      "cfc-policy-preconf-anywhere-source-confidential",
      undefined,
      tx,
    );
    const target = runtime.getCell<number>(
      space,
      "cfc-policy-preconf-anywhere-target",
      undefined,
      tx,
    );
    secretSource.set(7);
    confidentialSource.set(3);
    target.set(0);
    tx.writeOrThrow({
      space,
      id: secretSource.getAsNormalizedFullLink().id,
      type: "application/json",
      path: ["cfc", "labels"],
    }, {
      "/": {
        classification: ["secret"],
        integrity: ["proof-token"],
      },
    });
    tx.writeOrThrow({
      space,
      id: confidentialSource.getAsNormalizedFullLink().id,
      type: "application/json",
      path: ["cfc", "labels"],
    }, {
      "/": {
        classification: ["confidential"],
        integrity: ["proof-token"],
      },
    });
    await tx.commit();

    tx = runtime.edit();
    const a = Number(
      secretSource.withTx(tx).asSchema(secretSourceSchema).get() ?? 0,
    );
    const b = Number(
      confidentialSource.withTx(tx).asSchema(confidentialSourceSchema).get() ??
        0,
    );
    target.withTx(tx).asSchema(anywherePolicySchema).set(a + b);

    await prepareCfcCommitIfNeeded(tx);
    const { error } = await tx.commit();
    expect(error).toBeUndefined();
  });
});
