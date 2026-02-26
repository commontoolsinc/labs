import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { prepareCfcCommitIfNeeded } from "../src/cfc/prepare-shim.ts";
import type { JSONSchema } from "../src/builder/types.ts";

const signer = await Identity.fromPassphrase("cfc declassify guard false test");
const space = signer.did();

const sourceSchema = {
  type: "number",
  ifc: { classification: ["secret"] },
} as const satisfies JSONSchema;

const guardedDeclassifySchema = {
  type: "number",
  ifc: {
    classification: ["confidential"],
    declassify: {
      confidentialityPre: ["secret"],
      integrityPre: ["proof-token"],
      addAlternatives: ["confidential"],
      releaseCondition: true,
    },
  },
} as const satisfies JSONSchema;

const blockedDeclassifySchema = {
  type: "number",
  ifc: {
    classification: ["confidential"],
    declassify: {
      confidentialityPre: ["secret"],
      integrityPre: ["proof-token"],
      addAlternatives: ["confidential"],
      releaseCondition: false,
    },
  },
} as const satisfies JSONSchema;

describe("CFC declassify guard condition", () => {
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

  it("allows declassification rewrite when release condition is true", async () => {
    let tx = runtime.edit();
    const source = runtime.getCell<number>(space, "cfc-declassify-guard-source", undefined, tx);
    const target = runtime.getCell<number>(space, "cfc-declassify-guard-target", undefined, tx);
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
        integrity: ["proof-token"],
      },
    });
    await tx.commit();

    tx = runtime.edit();
    const value = Number(source.withTx(tx).asSchema(sourceSchema).get() ?? 0);
    target.withTx(tx).asSchema(guardedDeclassifySchema).set(value + 1);

    await prepareCfcCommitIfNeeded(tx);
    const { error } = await tx.commit();
    expect(error).toBeUndefined();
  });

  it("rejects declassification rewrite when release condition is false", async () => {
    let tx = runtime.edit();
    const source = runtime.getCell<number>(
      space,
      "cfc-declassify-guard-false-source",
      undefined,
      tx,
    );
    const target = runtime.getCell<number>(
      space,
      "cfc-declassify-guard-false-target",
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
        integrity: ["proof-token"],
      },
    });
    await tx.commit();

    tx = runtime.edit();
    const value = Number(source.withTx(tx).asSchema(sourceSchema).get() ?? 0);
    target.withTx(tx).asSchema(blockedDeclassifySchema).set(value + 1);

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
