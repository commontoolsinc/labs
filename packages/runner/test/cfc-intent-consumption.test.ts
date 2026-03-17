import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import {
  claimCfcIntentAttempt,
  claimCfcIntentConsumed,
  deriveCfcIntentAttemptId,
  deriveCfcIntentConsumedId,
} from "../src/cfc/intent-consumption.ts";

const signer = await Identity.fromPassphrase("cfc intent consumption test");
const space = signer.did();

describe("CFC intent consumption helpers", () => {
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

  it("derives stable consumed and attempt ids", () => {
    const consumedA = deriveCfcIntentConsumedId({
      intentOnceId: "cfc:intent-once:abc",
    });
    const consumedB = deriveCfcIntentConsumedId({
      intentOnceId: "cfc:intent-once:abc",
    });
    const consumedC = deriveCfcIntentConsumedId({
      intentOnceId: "cfc:intent-once:def",
    });

    const attemptA = deriveCfcIntentAttemptId({
      intentOnceId: "cfc:intent-once:abc",
      attemptNumber: 1,
    });
    const attemptB = deriveCfcIntentAttemptId({
      intentOnceId: "cfc:intent-once:abc",
      attemptNumber: 1,
    });
    const attemptC = deriveCfcIntentAttemptId({
      intentOnceId: "cfc:intent-once:abc",
      attemptNumber: 2,
    });

    expect(consumedA).toBe(consumedB);
    expect(consumedC).not.toBe(consumedA);
    expect(attemptA).toBe(attemptB);
    expect(attemptC).not.toBe(attemptA);
  });

  it("claims attempt cells through the normal transaction path", async () => {
    const tx = runtime.edit();
    const first = claimCfcIntentAttempt(
      runtime,
      tx,
      space,
      "cfc:intent-once:abc",
      1,
    );

    expect(first.alreadyClaimed).toBe(false);
    await tx.commit();

    const retryTx = runtime.edit();
    const retry = claimCfcIntentAttempt(
      runtime,
      retryTx,
      space,
      "cfc:intent-once:abc",
      1,
    );

    expect(retry.alreadyClaimed).toBe(true);
    expect(retry.marker.id).toBe(first.marker.id);
    await retryTx.abort();
  });

  it("allows separate attempt numbers and deduplicates consumed claims", async () => {
    const attemptOneTx = runtime.edit();
    const attemptOne = claimCfcIntentAttempt(
      runtime,
      attemptOneTx,
      space,
      "cfc:intent-once:abc",
      1,
    );
    await attemptOneTx.commit();

    const attemptTwoTx = runtime.edit();
    const attemptTwo = claimCfcIntentAttempt(
      runtime,
      attemptTwoTx,
      space,
      "cfc:intent-once:abc",
      2,
    );
    expect(attemptTwo.alreadyClaimed).toBe(false);
    expect(attemptTwo.marker.id).not.toBe(attemptOne.marker.id);
    await attemptTwoTx.commit();

    const consumeTx = runtime.edit();
    const firstConsume = claimCfcIntentConsumed(
      runtime,
      consumeTx,
      space,
      "cfc:intent-once:abc",
    );
    expect(firstConsume.alreadyClaimed).toBe(false);
    await consumeTx.commit();

    const retryConsumeTx = runtime.edit();
    const retryConsume = claimCfcIntentConsumed(
      runtime,
      retryConsumeTx,
      space,
      "cfc:intent-once:abc",
    );
    expect(retryConsume.alreadyClaimed).toBe(true);
    expect(retryConsume.marker.id).toBe(firstConsume.marker.id);
    await retryConsumeTx.abort();
  });
});
