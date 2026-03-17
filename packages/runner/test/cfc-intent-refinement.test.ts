import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { createCfcIntentEventEnvelope } from "../src/cfc/intent-event.ts";
import {
  claimCfcIntentRefinement,
  createCfcIntentOnce,
  deriveCfcIntentOnceId,
  deriveCfcIntentRefinementClaimId,
} from "../src/cfc/intent-refinement.ts";

const signer = await Identity.fromPassphrase("cfc intent refinement test");
const space = signer.did();

describe("CFC intent refinement", () => {
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

  function createSourceIntent() {
    return createCfcIntentEventEnvelope({
      action: "ForwardEmail",
      sourceGestureId: "gesture-forward-claim-1",
      conditionHash: "Cond.ForwardClicked",
      parameters: {
        emailId: "m-22",
        recipientSet: ["a@example.com"],
      },
      evidence: {
        renderRef: {
          seq: 22,
          rootRef: { space: "ui", id: "render-22" },
        },
        snapshotDigest: "snap-22",
        targetPath: "/children/1",
      },
      integrity: [
        { type: "https://commonfabric.org/cfc/atom/UIRuntime", hash: "ui-22" },
        {
          type: "https://commonfabric.org/cfc/atom/GestureProvenance",
          renderRef: { seq: 22, rootRef: { space: "ui", id: "render-22" } },
          snapshot: "snap-22",
          targetPath: "/children/1",
        },
      ],
    });
  }

  it("derives stable refinement claim and once ids", () => {
    const sourceIntent = createSourceIntent();

    const claimA = deriveCfcIntentRefinementClaimId({
      sourceIntentId: sourceIntent.id,
      refinerHash: "sha256:refiner-a",
    });
    const claimB = deriveCfcIntentRefinementClaimId({
      sourceIntentId: sourceIntent.id,
      refinerHash: "sha256:refiner-a",
    });
    const claimC = deriveCfcIntentRefinementClaimId({
      sourceIntentId: sourceIntent.id,
      refinerHash: "sha256:refiner-b",
    });

    const onceA = deriveCfcIntentOnceId({
      sourceIntentId: sourceIntent.id,
      refinerHash: "sha256:refiner-a",
    });
    const onceB = deriveCfcIntentOnceId({
      sourceIntentId: sourceIntent.id,
      refinerHash: "sha256:refiner-a",
    });
    const onceC = deriveCfcIntentOnceId({
      sourceIntentId: sourceIntent.id,
      refinerHash: "sha256:refiner-b",
    });

    expect(claimA).toBe(claimB);
    expect(claimC).not.toBe(claimA);
    expect(onceA).toBe(onceB);
    expect(onceC).not.toBe(onceA);
  });

  it("creates refined intent-once values with accumulated integrity", () => {
    const sourceIntent = createSourceIntent();
    const intentOnce = createCfcIntentOnce(sourceIntent, {
      refinerHash: "sha256:gmail-forward-refiner",
      operation: "Gmail.Forward",
      parameters: {
        audience: "https://gmail.googleapis.com",
        endpoint: "gmail.messages.send",
        emailId: "m-22",
        recipientSet: ["a@example.com"],
      },
    });

    expect(intentOnce.id).toBe(
      deriveCfcIntentOnceId({
        sourceIntentId: sourceIntent.id,
        refinerHash: "sha256:gmail-forward-refiner",
      }),
    );
    expect(intentOnce.sourceIntentId).toBe(sourceIntent.id);
    expect(intentOnce.refinerHash).toBe("sha256:gmail-forward-refiner");
    expect(intentOnce.operation).toBe("Gmail.Forward");
    expect(intentOnce.integrity).toEqual([
      ...sourceIntent.integrity,
      {
        type: "https://commonfabric.org/cfc/atom/RefinedBy",
        refiner: "sha256:gmail-forward-refiner",
        source: sourceIntent.id,
      },
    ]);
  });

  it("claims refinement once through the normal transaction path", async () => {
    const sourceIntent = createSourceIntent();

    const tx = runtime.edit();
    const firstClaim = claimCfcIntentRefinement(
      runtime,
      tx,
      space,
      sourceIntent.id,
      "sha256:gmail-forward-refiner",
    );

    expect(firstClaim.alreadyRefined).toBe(false);
    await tx.commit();

    const retryTx = runtime.edit();
    const retryClaim = claimCfcIntentRefinement(
      runtime,
      retryTx,
      space,
      sourceIntent.id,
      "sha256:gmail-forward-refiner",
    );

    expect(retryClaim.alreadyRefined).toBe(true);
    expect(retryClaim.marker.id).toBe(firstClaim.marker.id);
    expect(retryClaim.intentOnceId).toBe(firstClaim.intentOnceId);
    await retryTx.abort();
  });
});
