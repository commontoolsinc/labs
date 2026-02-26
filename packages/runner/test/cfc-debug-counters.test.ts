import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { prepareCfcCommitIfNeeded } from "../src/cfc/prepare-shim.ts";
import {
  getCfcDebugCounters,
  resetCfcDebugCounters,
} from "../src/cfc/debug-counters.ts";
import type { JSONSchema } from "../src/builder/types.ts";

const signer = await Identity.fromPassphrase("cfc debug counters test");
const space = signer.did();

const ifcNumberSchema = {
  type: "number",
  ifc: { classification: ["secret"] },
} as const satisfies JSONSchema;

describe("CFC debug counters", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    resetCfcDebugCounters();
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

  it("tracks relevant transactions and gate rejections", async () => {
    const tx = runtime.edit();
    const targetCell = runtime.getCell<number>(
      space,
      "cfc-debug-counter-gate-reject",
      undefined,
      tx,
    );
    targetCell.withTx(tx).asSchema(ifcNumberSchema).set(1);

    const { error } = await tx.commit();
    expect(error?.name).toBe("CfcPrepareRequiredError");

    expect(getCfcDebugCounters()).toEqual({
      cfcRelevantTx: 1,
      cfcPreparedTx: 0,
      cfcGateRejects: 1,
      cfcOutboxFlushes: 0,
    });
  });

  it("tracks successful prepared transactions", async () => {
    const tx = runtime.edit();
    const targetCell = runtime.getCell<number>(
      space,
      "cfc-debug-counter-prepared",
      undefined,
      tx,
    );
    targetCell.withTx(tx).asSchema(ifcNumberSchema).set(2);

    await prepareCfcCommitIfNeeded(tx);
    const { error } = await tx.commit();
    expect(error).toBeUndefined();

    expect(getCfcDebugCounters()).toEqual({
      cfcRelevantTx: 1,
      cfcPreparedTx: 1,
      cfcGateRejects: 0,
      cfcOutboxFlushes: 0,
    });
  });

  it("tracks outbox flushes after successful commit", async () => {
    const tx = runtime.edit();
    tx.enqueueCfcSideEffect(() => {});

    const { error } = await tx.commit();
    expect(error).toBeUndefined();

    expect(getCfcDebugCounters()).toEqual({
      cfcRelevantTx: 0,
      cfcPreparedTx: 0,
      cfcGateRejects: 0,
      cfcOutboxFlushes: 1,
    });
  });
});
