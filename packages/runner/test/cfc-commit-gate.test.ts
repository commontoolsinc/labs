import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { computeCfcActivityDigest } from "../src/cfc/activity-digest.ts";
import type { Activity, Metadata } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("cfc commit gate test");
const space = signer.did();

describe("CFC commit gate", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      storageManager,
      apiUrl: new URL(import.meta.url),
    });
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  it("commits successfully when transaction is not CFC-relevant", async () => {
    const tx = runtime.edit();
    const writeResult = tx.write({
      space,
      id: "of:cfc-non-relevant",
      type: "application/json",
      path: [],
    }, { value: { ok: true } });
    expect(writeResult.error).toBeUndefined();

    const { error } = await tx.commit();
    expect(error).toBeUndefined();
  });

  it("allows read-only CFC-relevant transaction without prepare", async () => {
    const tx = runtime.edit();
    tx.markCfcRelevant("unit-test");

    const { error } = await tx.commit();
    expect(error).toBeUndefined();
  });

  it("rejects CFC-relevant write transaction when not prepared", async () => {
    const tx = runtime.edit();
    const writeResult = tx.write({
      space,
      id: "of:cfc-relevant-unprepared-write",
      type: "application/json",
      path: [],
    }, { value: { required: true } });
    expect(writeResult.error).toBeUndefined();
    tx.markCfcRelevant("unit-test-write");

    const { error } = await tx.commit();
    expect(error?.name).toBe("CfcPrepareRequiredError");
  });

  it("commits when CFC-relevant transaction is prepared and unchanged", async () => {
    const tx = runtime.edit();
    const writeResult = tx.write({
      space,
      id: "of:cfc-prepared-unchanged",
      type: "application/json",
      path: [],
    }, { value: { before: true } });
    expect(writeResult.error).toBeUndefined();

    tx.markCfcRelevant("prepared-unchanged");
    const digest = await computeCfcActivityDigest(tx.journal.activity());
    tx.markCfcPrepared(digest);

    const { error } = await tx.commit();
    expect(error).toBeUndefined();
  });

  it("rejects when activity changes after prepare", async () => {
    const tx = runtime.edit();
    const initialWrite = tx.write({
      space,
      id: "of:cfc-prepared-mismatch",
      type: "application/json",
      path: [],
    }, { value: { before: true } });
    expect(initialWrite.error).toBeUndefined();

    tx.markCfcRelevant("prepared-mismatch");
    const preparedDigest = await computeCfcActivityDigest(tx.journal.activity());
    tx.markCfcPrepared(preparedDigest);

    const postPrepareWrite = tx.write({
      space,
      id: "of:cfc-prepared-mismatch",
      type: "application/json",
      path: ["value", "afterPrepare"],
    }, true);
    expect(postPrepareWrite.error).toBeUndefined();

    const { error } = await tx.commit();
    expect(error?.name).toBe("CfcPreparedDigestMismatchError");
    if (!error || error.name !== "CfcPreparedDigestMismatchError") {
      throw new Error("Expected CfcPreparedDigestMismatchError");
    }
    expect(error.expectedDigest).toBe(preparedDigest);
    expect(error.actualDigest).not.toBe(preparedDigest);
  });

  it("fires commit callbacks on gate failure and exposes error status", async () => {
    const tx = runtime.edit();
    const writeResult = tx.write({
      space,
      id: "of:cfc-callback-status",
      type: "application/json",
      path: [],
    }, { value: { x: 1 } });
    expect(writeResult.error).toBeUndefined();
    tx.markCfcRelevant("callback-status");

    let callbackCalled = false;
    let callbackStatus: string | undefined;
    tx.addCommitCallback((callbackTx) => {
      callbackCalled = true;
      callbackStatus = callbackTx.status().status;
    });

    const { error } = await tx.commit();
    expect(error?.name).toBe("CfcPrepareRequiredError");
    expect(callbackCalled).toBe(true);
    expect(callbackStatus).toBe("error");
  });
});

describe("computeCfcActivityDigest", () => {
  it("is stable for identical activity and metadata with reordered keys", async () => {
    const symbolKey = Symbol("internal");
    const meta1: Metadata = {
      b: 2,
      a: 1,
      nested: { z: true, y: [2, 1] },
      [symbolKey]: { beta: "b", alpha: "a" },
    };
    const meta2: Metadata = {
      a: 1,
      b: 2,
      nested: { y: [2, 1], z: true },
      [symbolKey]: { alpha: "a", beta: "b" },
    };

    const activity1: Activity[] = [
      {
        read: {
          space: "did:key:test-space",
          id: "of:test-doc",
          type: "application/json",
          path: ["value", "field"],
          meta: meta1,
        },
      },
      {
        write: {
          space: "did:key:test-space",
          id: "of:test-doc",
          type: "application/json",
          path: ["value", "field"],
        },
      },
    ];

    const activity2: Activity[] = [
      {
        read: {
          space: "did:key:test-space",
          id: "of:test-doc",
          type: "application/json",
          path: ["value", "field"],
          meta: meta2,
        },
      },
      {
        write: {
          space: "did:key:test-space",
          id: "of:test-doc",
          type: "application/json",
          path: ["value", "field"],
        },
      },
    ];

    const digest1 = await computeCfcActivityDigest(activity1);
    const digest2 = await computeCfcActivityDigest(activity2);
    expect(digest1).toBe(digest2);
  });

  it("is order-sensitive", async () => {
    const readActivity: Activity = {
      read: {
        space: "did:key:test-space",
        id: "of:test-doc",
        type: "application/json",
        path: ["value", "field"],
        meta: {},
      },
    };
    const writeActivity: Activity = {
      write: {
        space: "did:key:test-space",
        id: "of:test-doc",
        type: "application/json",
        path: ["value", "field"],
      },
    };

    const digestA = await computeCfcActivityDigest([readActivity, writeActivity]);
    const digestB = await computeCfcActivityDigest([writeActivity, readActivity]);
    expect(digestA).not.toBe(digestB);
  });
});
