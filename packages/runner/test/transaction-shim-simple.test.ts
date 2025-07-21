import { afterEach, beforeEach } from "@std/testing/bdd";
import { describe, it } from "./helpers/tx-bdd.ts";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { ShimStorageManager } from "../src/storage/transaction-shim.ts";
import { type IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("Transaction Shim Simple Tests", (config) => {
  let runtime: Runtime;
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let tx: IExtendedStorageTransaction;
  let shimStorageManager: ShimStorageManager;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      blobbyServerUrl: import.meta.url,
      storageManager,
      useStorageManagerTransactions: config.useStorageManagerTransactions,
    });
    shimStorageManager = new ShimStorageManager(runtime);
    tx = runtime.edit();
  });

  afterEach(async () => {
    await tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
  });

  describe("ShimStorageManager", () => {
    it("should create a new storage transaction", () => {
      const transaction = shimStorageManager.edit();

      expect(transaction).toBeDefined();
      expect(transaction.status().status).toBe("ready");
    });

    it("should manage subscriptions", () => {
      const notifications: any[] = [];
      const subscription = {
        next(notification: any) {
          notifications.push(notification);
          return { done: false };
        },
      };

      shimStorageManager.subscribe(subscription);

      // Simulate a notification
      const testNotification = {
        type: "commit" as const,
        space,
        changes: [],
      };

      shimStorageManager.notifySubscribers(testNotification);

      expect(notifications).toHaveLength(1);
      expect(notifications[0]).toEqual(testNotification);
    });

    it("should remove subscriptions that return done: true", () => {
      let callCount = 0;
      const subscription = {
        next(notification: any) {
          callCount++;
          return { done: true }; // Stop after first call
        },
      };

      shimStorageManager.subscribe(subscription);

      // First notification should work
      shimStorageManager.notifySubscribers({
        type: "commit",
        space,
        changes: [],
      });
      expect(callCount).toBe(1);

      // Second notification should not work (subscription removed)
      shimStorageManager.notifySubscribers({
        type: "commit",
        space,
        changes: [],
      });
      expect(callCount).toBe(1); // Should not have increased
    });

    it("should remove subscriptions that throw errors", () => {
      let callCount = 0;
      const subscription = {
        next(notification: any) {
          callCount++;
          throw new Error("Test error");
        },
      };

      shimStorageManager.subscribe(subscription);

      // First notification should work but catch the error (and remove subscription)
      shimStorageManager.notifySubscribers({
        type: "commit",
        space,
        changes: [],
      });
      expect(callCount).toBe(1);

      // Second notification should not work (subscription removed)
      shimStorageManager.notifySubscribers({
        type: "commit",
        space,
        changes: [],
      });
      expect(callCount).toBe(1); // Should not have increased
    });
  });

  describe("Basic Transaction Operations", () => {
    it("should write and read values", () => {
      const transaction = shimStorageManager.edit();

      // First create the document structure
      const rootWriteResult = transaction.write({
        space,
        id: "of:test-entity",
        type: "application/json",
        path: ["value"],
      }, {});

      expect(rootWriteResult.ok).toBeDefined();

      // Then write to a nested path
      const writeResult = transaction.write({
        space,
        id: "of:test-entity",
        type: "application/json",
        path: ["value", "test"],
      }, "test value");

      expect(writeResult.ok).toBeDefined();
      expect(writeResult.ok?.value).toBe("test value");

      // Read the value
      const readResult = transaction.read({
        space,
        id: "of:test-entity",
        type: "application/json",
        path: ["value", "test"],
      });

      expect(readResult.ok).toBeDefined();
      expect(readResult.ok?.value).toBe("test value");
    });

    it("should handle nested object writes", () => {
      const transaction = shimStorageManager.edit();

      // Write a nested object
      const writeResult = transaction.write({
        space,
        id: "of:test-entity",
        type: "application/json",
        path: ["value"],
      }, { level1: { level2: "deep value" } });

      expect(writeResult.ok).toBeDefined();

      // Read nested value
      const readResult = transaction.read({
        space,
        id: "of:test-entity",
        type: "application/json",
        path: ["value", "level1", "level2"],
      });

      expect(readResult.ok).toBeDefined();
      expect(readResult.ok?.value).toBe("deep value");
    });

    it("should handle array writes", () => {
      const transaction = shimStorageManager.edit();

      // Write an array
      const writeResult = transaction.write({
        space,
        id: "of:test-entity",
        type: "application/json",
        path: ["value"],
      }, ["item1", "item2", "item3"]);

      expect(writeResult.ok).toBeDefined();

      // Read array element
      const readResult = transaction.read({
        space,
        id: "of:test-entity",
        type: "application/json",
        path: ["value", "1"],
      });

      expect(readResult.ok).toBeDefined();
      expect(readResult.ok?.value).toBe("item2");
    });
  });

  describe("Error Handling", () => {
    it("should handle unsupported media types", () => {
      const transaction = shimStorageManager.edit();

      const result = transaction.read({
        space,
        id: "of:test-entity",
        type: "text/plain",
        path: ["value"],
      });

      expect(result.error).toBeDefined();
      expect(result.error?.name).toBe("UnsupportedMediaTypeError");
    });

    it("should handle non-existent documents", () => {
      const transaction = shimStorageManager.edit();

      const result = transaction.read({
        space,
        id: "of:non-existent-entity",
        type: "application/json",
        path: ["value", "test"],
      });

      expect(result.error).toBeDefined();
      expect(result.error?.name).toBe("NotFoundError");
    });

    it("should handle invalid paths", () => {
      const transaction = shimStorageManager.edit();

      // First create a document
      transaction.write({
        space,
        id: "of:test-entity",
        type: "application/json",
        path: ["value"],
      }, { simple: "value" });

      // Try to read from invalid path
      const result = transaction.read({
        space,
        id: "of:test-entity",
        type: "application/json",
        path: ["value", "non-existent", "deep"],
      });

      expect(result.error).toBeDefined();
      expect(result.error?.name).toBe("NotFoundError");
    });
  });

  describe("Transaction Status", () => {
    it("should track transaction status correctly", () => {
      const transaction = shimStorageManager.edit();

      // Initial status should be ready
      expect(transaction.status().status).toBe("ready");

      // After commit, status should be done
      return transaction.commit().then(() => {
        expect(transaction.status().status).toBe("done");
      });
    });

    it("should handle transaction abort", () => {
      const transaction = shimStorageManager.edit();

      // Abort the transaction
      const abortResult = transaction.abort();
      expect(abortResult.error).toBeUndefined();

      // Status should be done
      expect(transaction.status().status).toBe("done");

      // Commit should fail
      return transaction.commit().then((result) => {
        expect(result.error).toBeDefined();
        expect(result.error?.name).toBe("StorageTransactionAborted");
      });
    });
  });

  describe("Write Isolation", () => {
    it("should enforce write isolation per space", () => {
      const transaction = shimStorageManager.edit();

      // Open writer for first space
      const writer1Result = transaction.writer(space);
      expect(writer1Result.ok).toBeDefined();

      // Try to open writer for different space - should fail
      const writer2Result = transaction.writer("did:test:space2");
      expect(writer2Result.error).toBeDefined();
      expect(writer2Result.error?.name).toBe(
        "StorageTransactionWriteIsolationError",
      );
    });
  });
});
