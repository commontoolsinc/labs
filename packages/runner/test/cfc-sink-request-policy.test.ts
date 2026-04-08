import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createFrozenRequestSnapshot } from "../src/cfc/request-snapshot.ts";
import {
  enqueueSinkRequestPostCommitEffect,
  verifySinkRequestRelease,
} from "../src/cfc/sink-request.ts";
import { Runtime } from "../src/runtime.ts";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

const signer = await Identity.fromPassphrase("test cfc sink request policy");
const space = signer.did();

describe("CFC sink request policy", () => {
  it("accepts matching sink-request policy inputs and rejects mismatches", () => {
    const request = createFrozenRequestSnapshot({
      url: "https://example.com/api",
      options: {
        method: "POST",
        headers: {
          "x-test": "initial",
        },
      },
    });

    const tx = {
      getCfcState: () => ({
        writePolicyInputs: [{
          kind: "sink-request",
          effectId: "fetchData:abc123",
          sink: "fetchData",
          request,
        }],
      }),
    } as unknown as {
      getCfcState(): {
        writePolicyInputs: readonly [{
          kind: "sink-request";
          effectId: string;
          sink: string;
          request: typeof request;
        }];
      };
    };

    expect(
      verifySinkRequestRelease(tx, "fetchData", "fetchData:abc123", request),
    ).toBeUndefined();

    expect(
      verifySinkRequestRelease(tx, "fetchData", "fetchData:abc123", {
        ...request,
        options: {
          ...request.options,
          headers: {
            "x-test": "mutated",
          },
        },
      }),
    ).toContain("mismatch");
  });

  it("deduplicates identical sink requests by idempotency key", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      memoryVersion: "v2",
    });
    const tx = runtime.edit();

    const request = createFrozenRequestSnapshot({
      url: "https://example.com/api",
    });

    let flushCount = 0;
    enqueueSinkRequestPostCommitEffect(
      tx,
      "fetchData",
      "fetchData:dedupe",
      request,
      "fetchData-start",
      () => {
        flushCount++;
      },
    );
    enqueueSinkRequestPostCommitEffect(
      tx,
      "fetchData",
      "fetchData:dedupe",
      request,
      "fetchData-start",
      () => {
        flushCount++;
      },
    );

    const result = await tx.commit();
    expect(result.ok).toBeDefined();
    expect(flushCount).toBe(1);

    await runtime.dispose();
    await storageManager.close();
  });
});
