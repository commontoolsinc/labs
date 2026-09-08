import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { Runtime } from "../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("editWithRetry teardown test");
const space = signer.did();

const valueSchema = {
  type: "object",
  properties: { value: { type: "number" } },
} as const;

describe("Runtime.editWithRetry teardown", () => {
  it("aborts an edit when disposal begins inside its action", async () => {
    const server = newSharedServer();
    const storageManager = EmulatedStorageManager.connectTo(server, {
      as: signer,
    });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    let disposing: Promise<void> | undefined;
    try {
      const result = await runtime.editWithRetry((tx) => {
        runtime.getCell(
          space,
          "dispose-before-edit-commit",
          valueSchema,
          tx,
        ).set({ value: 1 });
        // The closing path sets the write gate synchronously before its first
        // awaited teardown barrier. editWithRetry must abort this prepared
        // transaction instead of committing behind disposal.
        disposing = runtime.dispose();
      });

      expect(result.error?.name).toBe("StorageTransactionAborted");
      expect(result.error?.message).toContain("runtime is disposing");
      await disposing;
    } finally {
      await disposing?.catch(() => undefined);
      await storageManager.close();
      await server.close();
    }
  });

  it("returns a transaction error when commit rejects its promise", async () => {
    const server = newSharedServer();
    const storageManager = EmulatedStorageManager.connectTo(server, {
      as: signer,
    });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    const failure = new Error("synthetic commit rejection");
    let attempted: IExtendedStorageTransaction | undefined;
    try {
      const result = await runtime.editWithRetry((tx) => {
        attempted = tx;
        tx.commit = (() => Promise.reject(failure)) as typeof tx.commit;
        return "uncommitted";
      }, 0);

      expect(result.error?.name).toBe("StorageTransactionAborted");
      expect(result.error?.message).toContain("synthetic commit rejection");
      expect((result.error as { reason?: unknown } | undefined)?.reason).toBe(
        failure,
      );
    } finally {
      attempted?.abort("synthetic commit completed");
      await runtime.dispose();
      await storageManager.close();
      await server.close();
    }
  });

  it("cancels retry readiness when kept-storage disposal begins", async () => {
    const server = newSharedServer();
    const storageManager = EmulatedStorageManager.connectTo(server, {
      as: signer,
    });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    const readiness = Promise.withResolvers<void>();
    const waiting = Promise.withResolvers<void>();
    let editing: ReturnType<Runtime["editWithRetry"]> | undefined;
    let disposed = false;
    try {
      editing = runtime.editWithRetry((tx) => {
        tx.commit = (() =>
          Promise.resolve({
            error: {
              name: "ConflictError",
              message: "synthetic conflict with a stuck catch-up gate",
              readyToRetry: () => {
                waiting.resolve();
                return readiness.promise;
              },
            },
          })) as typeof tx.commit;
      });
      await waiting.promise;

      await runtime.dispose({ closeStorage: false });
      disposed = true;

      const outcome = await editing;
      expect(outcome.error?.name).toBe("StorageTransactionAborted");
      expect(outcome.error?.message).toContain("runtime is disposing");
    } finally {
      readiness.resolve();
      await editing?.catch(() => undefined);
      if (!disposed) await runtime.dispose({ closeStorage: false });
      await storageManager.close();
      await server.close();
    }
  });

  it("stops retry readiness between waits when teardown is signaled", async () => {
    const server = newSharedServer();
    const storageManager = EmulatedStorageManager.connectTo(server, {
      as: signer,
    });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    try {
      const alreadyAborted = new AbortController();
      alreadyAborted.abort();
      let firstGateConsulted = false;
      await runtime.awaitCommitRetryReadiness({
        readyToRetry: () => {
          firstGateConsulted = true;
          return Promise.resolve();
        },
      }, alreadyAborted.signal);
      expect(firstGateConsulted).toBe(true);

      // Model teardown landing after the catch-up gate has settled but before
      // the conflict-document pull begins. The helper removes its listener as
      // it leaves the first wait; making that removal observe the teardown
      // deterministically exercises the same inter-phase race without timing.
      let abortedBetweenWaits = false;
      const interveningSignal = {
        get aborted() {
          return abortedBetweenWaits;
        },
        addEventListener() {},
        removeEventListener() {
          abortedBetweenWaits = true;
        },
      } as unknown as AbortSignal;
      await runtime.awaitCommitRetryReadiness({
        readyToRetry: () => Promise.resolve(),
        conflict: { space, of: "of:must-not-be-pulled" },
      }, interveningSignal);
      expect(abortedBetweenWaits).toBe(true);
    } finally {
      await runtime.dispose();
      await storageManager.close();
      await server.close();
    }
  });
});
