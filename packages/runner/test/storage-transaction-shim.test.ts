import { afterEach, beforeEach, describe, it } from "./helpers/tx-bdd.ts";
import { expect } from "@std/expect";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { Identity } from "@commontools/identity";
import { getJSONFromDataURI } from "../src/uri-utils.ts";
import type {
  IExtendedStorageTransaction,
  IMemorySpaceAddress,
  INotFoundError,
} from "../src/storage/interface.ts";
import { createDoc } from "../src/doc.ts";
import { ShimStorageManager } from "../src/storage/transaction-shim.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("StorageTransaction", (config) => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      storageManager,
      blobbyServerUrl: "http://localhost:8080",
      useStorageManagerTransactions: config.useStorageManagerTransactions,
    });
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("should create a transaction and read/write values", async () => {
    const transaction = runtime.edit();

    // Check initial status
    const statusResult = transaction.status();
    expect(statusResult.status).toBe("ready");

    // First write to root path to create a record
    const rootWriteResult = transaction.write({
      space,
      id: "of:test-entity",
      type: "application/json",
      path: ["value"],
    }, {});

    expect(rootWriteResult.ok).toBeDefined();

    // Test writing a value to nested path
    const writeResult = transaction.write({
      space,
      id: "of:test-entity",
      type: "application/json",
      path: ["value", "name"],
    }, "John Doe");

    expect(writeResult.ok).toBeDefined();
    expect(writeResult.ok?.value).toBe("John Doe");

    // Test reading the value
    const readResult = transaction.read({
      space,
      id: "of:test-entity",
      type: "application/json",
      path: ["value", "name"],
    });

    expect(readResult.ok).toBeDefined();
    expect(readResult.ok?.value).toBe("John Doe");

    // Test reading non-existent path
    const readNonExistentResult = transaction.read({
      space,
      id: "of:test-entity",
      type: "application/json",
      path: ["value", "address", "city"],
    });

    expect(readNonExistentResult.error).toBeDefined();
    expect(readNonExistentResult.error?.name).toBe("NotFoundError");
    expect((readNonExistentResult.error as INotFoundError).path).toEqual([]);

    // Test writing a value to nested path
    const writeResult2 = transaction.write({
      space,
      id: "of:test-entity",
      type: "application/json",
      path: ["value", "address"],
    }, { street: "123 Main St" });

    expect(writeResult2.ok).toBeDefined();
    expect(writeResult2.ok?.value).toEqual({ street: "123 Main St" });

    // Test reading non-existent path in a parent that does exist
    const readNonExistentResult2 = transaction.read({
      space,
      id: "of:test-entity",
      type: "application/json",
      path: ["value", "address", "country", "countryCode"],
    });

    expect(readNonExistentResult2.error).toBeDefined();
    expect(readNonExistentResult2.error?.name).toBe("NotFoundError");
    expect((readNonExistentResult2.error as INotFoundError).path).toEqual([
      "address",
    ]);

    // Test commit - dummy commit always succeeds
    const commitResult = await transaction.commit();
    expect(commitResult.error).toBeUndefined(); // No error means success

    // Check final status
    const finalStatusResult = transaction.status();
    expect(finalStatusResult.status).toBe("done");
  });

  it("should handle transaction abort", async () => {
    const transaction = runtime.edit();

    // Abort the transaction
    const abortResult = transaction.abort();
    expect(abortResult.error).toBeUndefined(); // No error means success

    // Try to commit aborted transaction
    const commitResult = await transaction.commit();
    expect(commitResult.error).toBeDefined();
    expect(commitResult.error?.name).toBe("StorageTransactionAborted");
  });

  it("should enforce write isolation per space", () => {
    const transaction = runtime.edit();

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

  describe("write validation", () => {
    it("should allow writing to root path when document is empty", () => {
      const transaction = runtime.edit();

      const result = transaction.write({
        space,
        id: "of:test-entity",
        type: "application/json",
        path: ["value"],
      }, { name: "test" });

      expect(result.error).toBeUndefined();
      expect(result.ok).toBeDefined();
    });

    it("should fail writing to nested path when document is not a record", () => {
      const transaction = runtime.edit();

      // First write a non-record value to the document
      transaction.write({
        space,
        id: "of:test-entity",
        type: "application/json",
        path: ["value"],
      }, "not a record");

      // Try to write to a nested path
      const result = transaction.write({
        space,
        id: "of:test-entity",
        type: "application/json",
        path: ["value", "a"],
      }, "value");

      expect(result.error).toBeDefined();
      expect(result.error!.message).toContain(
        "not a record",
      );
    });

    it("should fail writing to deeply nested path when parent is not a record", () => {
      const transaction = runtime.edit();

      // First write a record with a non-record value at "a"
      transaction.write({
        space,
        id: "of:test-entity",
        type: "application/json",
        path: ["value"],
      }, { a: "not a record" });

      // Try to write to a deeply nested path
      const result = transaction.write({
        space,
        id: "of:test-entity",
        type: "application/json",
        path: ["value", "a", "b"],
      }, "value");

      expect(result.error).toBeDefined();
      expect(result.error!.message).toContain(
        "parent path [a] does not exist or is not a record",
      );
    });

    it("should allow writing to nested path when parent is a record", () => {
      const transaction = runtime.edit();

      // First write a record value to the document
      transaction.write({
        space,
        id: "of:test-entity",
        type: "application/json",
        path: ["value"],
      }, { a: {} });

      // Write to a nested path
      const result = transaction.write({
        space,
        id: "of:test-entity",
        type: "application/json",
        path: ["value", "a", "b"],
      }, "value");

      expect(result.error).toBeUndefined();
      expect(result.ok).toBeDefined();
    });

    it("should allow writing to deeply nested path when all parents are records", () => {
      const transaction = runtime.edit();

      // First write a record with nested structure
      transaction.write({
        space,
        id: "of:test-entity",
        type: "application/json",
        path: ["value"],
      }, { a: { b: { c: {} } } });

      // Write to a deeply nested path
      const result = transaction.write({
        space,
        id: "of:test-entity",
        type: "application/json",
        path: ["value", "a", "b", "c", "d"],
      }, "deep value");

      expect(result.error).toBeUndefined();
      expect(result.ok).toBeDefined();
    });

    it("should fail writing to nested path when parent path doesn't exist", () => {
      const transaction = runtime.edit();

      // First write a record to the document
      const writeResult = transaction.write({
        space,
        id: "of:test-entity",
        type: "application/json",
        path: ["value"],
      }, { existing: "value" });
      expect(writeResult.ok).toBeDefined();

      // Try to write to a path where parent doesn't exist
      const result = transaction.write({
        space,
        id: "of:test-entity",
        type: "application/json",
        path: ["value", "missing", "nested"],
      }, "value");

      expect(result.error).toBeDefined();
      expect(result.error!.message).toContain(
        "parent path [missing] does not exist or is not a record",
      );
    });

    it("should set NotFoundError.path to last valid parent for deeply nested writes", () => {
      const transaction = runtime.edit();

      // First write a record with a nested structure
      transaction.write({
        space,
        id: "of:test-entity",
        type: "application/json",
        path: ["value"],
      }, { a: { b: { c: "not a record" } } });

      // Try to write to a deeply nested path where parent is not a record
      const result = transaction.write({
        space,
        id: "of:test-entity",
        type: "application/json",
        path: ["value", "a", "b", "c", "d"],
      }, "deep value");

      expect(result.error).toBeDefined();
      expect(result.error!.name).toBe("NotFoundError");
      // Should set path to ["a", "b"] (the last valid parent path)
      expect((result.error as INotFoundError).path).toEqual(["a", "b"]);
    });
  });

  describe("source path behavior", () => {
    it("should write and read the sourceCell via the 'source' path", () => {
      const transaction = runtime.edit();
      // Create two docs
      const doc1Id = "of:doc1";
      const doc2Id = "of:doc2";
      // Write to root of both docs
      expect(
        transaction.write({
          space,
          id: doc1Id,
          type: "application/json",
          path: ["value"],
        }, { foo: 1 }).ok,
      ).toBeDefined();
      expect(
        transaction.write({
          space,
          id: doc2Id,
          type: "application/json",
          path: ["value"],
        }, { bar: 2 }).ok,
      ).toBeDefined();
      // Set doc1's sourceCell to doc2
      const setSource = transaction.write({
        space,
        id: doc1Id,
        type: "application/json",
        path: ["source"],
      }, doc2Id);
      expect(setSource.ok).toBeDefined();
      // Read back the sourceCell
      const readSource = transaction.read({
        space,
        id: doc1Id,
        type: "application/json",
        path: ["source"],
      });
      expect(readSource.ok).toBeDefined();
      expect(readSource.ok?.value).toBe(doc2Id);
    });

    it("should error if path beyond 'source' is used", () => {
      const transaction = runtime.edit();
      const doc1Id = "of:doc1";
      expect(
        transaction.write({
          space,
          id: doc1Id,
          type: "application/json",
          path: ["value"],
        }, {}).ok,
      ).toBeDefined();
      const result = transaction.write({
        space,
        id: doc1Id,
        type: "application/json",
        path: ["source", "extra"],
      }, "of:doc2");
      expect(result.error).toBeDefined();
      expect(result.error?.name).toBe("NotFoundError");
      const readResult = transaction.read({
        space,
        id: doc1Id,
        type: "application/json",
        path: ["source", "extra"],
      });
      expect(readResult.error).toBeDefined();
      expect(readResult.error?.name).toBe("NotFoundError");
    });

    it("should error if source doc does not exist", () => {
      const transaction = runtime.edit();
      const doc1Id = "of:doc1";
      expect(
        transaction.write({
          space,
          id: doc1Id,
          type: "application/json",
          path: ["value"],
        }, {}).ok,
      ).toBeDefined();
      const result = transaction.write({
        space,
        id: doc1Id,
        type: "application/json",
        path: ["source"],
      }, "of:nonexistent");
      expect(result.error).toBeDefined();
      expect(result.error?.name).toBe("NotFoundError");
    });

    it("should error if value for 'source' is not a URI string", () => {
      const transaction = runtime.edit();
      const doc1Id = "of:doc1";
      expect(
        transaction.write({
          space,
          id: doc1Id,
          type: "application/json",
          path: ["value"],
        }, {}).ok,
      ).toBeDefined();
      const result = transaction.write({
        space,
        id: doc1Id,
        type: "application/json",
        path: ["source"],
      }, 12345);
      expect(result.error).toBeDefined();
      expect(result.error?.name).toBe("NotFoundError");
    });
  });

  describe("readValueOrThrow and writeValueOrThrow", () => {
    it("should support readValueOrThrow for value, not found, and error cases", () => {
      const transaction = runtime.edit();

      // Write a value
      const writeResult = transaction.write({
        space,
        id: "of:test-entity",
        type: "application/json",
        path: ["value"],
      }, { foo: 123 });
      expect(writeResult.ok).toBeDefined();
      expect(writeResult.error).toBeUndefined();

      // Should return the value for an existing path
      const result = transaction.read({
        space,
        id: "of:test-entity",
        type: "application/json",
        path: ["value", "foo"],
      });
      expect(result.ok?.value).toBe(123);

      // Should return the value for an existing path
      const value = transaction.readOrThrow({
        space,
        id: "of:test-entity",
        type: "application/json",
        path: ["value", "foo"],
      });
      expect(value).toBe(123);

      // Should return undefined for a non-existent path (NotFoundError)
      const notFound = transaction.readOrThrow({
        space,
        id: "of:test-entity",
        type: "application/json",
        path: ["value", "bar"],
      });
      expect(notFound).toBeUndefined();

      // Should throw for other errors (e.g., unsupported media type)
      expect(() =>
        transaction.readOrThrow({
          space,
          id: "of:test-entity",
          type: "unsupported/type",
          path: ["value"],
        })
      ).toThrow("Unsupported media type");
    });
  });

  it("should support writeValueOrThrow into a new document", async () => {
    const transaction = runtime.edit();
    transaction.writeValueOrThrow({
      space,
      id: "of:test-entity-new",
      type: "application/json",
      path: ["value"],
    }, { foo: 123 });
    const result = await transaction.commit();
    expect(result.ok).toBeDefined();
  });
});

describe("DocImpl shim notifications", (config) => {
  let runtime: Runtime;
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      blobbyServerUrl: import.meta.url,
      storageManager,
      useStorageManagerTransactions: config.useStorageManagerTransactions,
    });
    tx = runtime.edit();
  });

  afterEach(async () => {
    await tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
  });

  describe("setAtPath with transaction parameter", () => {
    it("should accept transaction parameter and work correctly", () => {
      const entityId = { "/": "transaction-test-entity" };
      const value = { initial: "value" };

      const doc = createDoc(value, entityId, space, runtime);

      // Test that setAtPath works with transaction parameter
      const result = doc.setAtPath(["new"], "value", undefined, tx);
      expect(result).toBe(true);
      expect(doc.getAtPath(["new"])).toBe("value");
    });

    it("should handle nested paths with transaction parameter", () => {
      const entityId = { "/": "nested-transaction-test-entity" };
      const value = { initial: "value" };

      const doc = createDoc(value, entityId, space, runtime);

      // Test nested path setting with transaction
      const result = doc.setAtPath(
        ["nested", "deep", "path"],
        "deep value",
        undefined,
        tx,
      );
      expect(result).toBe(true);
      expect(doc.getAtPath(["nested", "deep", "path"])).toBe("deep value");
    });

    it("should handle array paths with transaction parameter", () => {
      const entityId = { "/": "array-transaction-test-entity" };
      const value = { items: [] };

      const doc = createDoc(value, entityId, space, runtime);

      // Test array path setting with transaction
      const result = doc.setAtPath(["items", 0], "first item", undefined, tx);
      expect(result).toBe(true);
      expect(doc.getAtPath(["items", 0])).toBe("first item");
    });

    it("should handle schema validation with transaction parameter", () => {
      const entityId = { "/": "schema-transaction-test-entity" };
      const value = { name: "test" };

      const doc = createDoc(value, entityId, space, runtime);

      const schema = {
        type: "string" as const,
        minLength: 3,
      };

      // Test with valid schema
      const result = doc.setAtPath(["name"], "valid name", schema, tx);
      expect(result).toBe(true);
      expect(doc.getAtPath(["name"])).toBe("valid name");
    });

    it("should handle root path setting with transaction parameter", () => {
      const entityId = { "/": "root-transaction-test-entity" };
      const value = { initial: "value" };

      const doc = createDoc(value, entityId, space, runtime);

      const newValue = { completely: "new value" };
      const result = doc.setAtPath([], newValue, undefined, tx);
      expect(result).toBe(true);
      expect(doc.get()).toEqual(newValue);
    });
  });

  describe("storage notifications with shim storage manager", () => {
    it("should send notifications when shim storage manager is available", () => {
      const entityId = { "/": "notification-test-entity" };
      const value = { initial: "value" };

      const doc = createDoc(value, entityId, space, runtime);

      const notifications: any[] = [];
      runtime.storage.subscribe({
        next(notification: any) {
          notifications.push(notification);
          return { done: false };
        },
      });

      const previousValue = doc.getAtPath(["initial"]);
      doc.setAtPath(["initial"], "updated", undefined, tx.tx);

      expect(notifications).toHaveLength(1);
      expect(notifications[0].type).toBe("commit");
      expect(notifications[0].space).toBe(space);
      expect(notifications[0].source).toBe(tx.tx);
      expect(notifications[0].changes).toHaveLength(1);
      expect(notifications[0].changes[0].address.id).toBe(
        "of:notification-test-entity",
      );
      expect(notifications[0].changes[0].address.path).toEqual([
        "value",
        "initial",
      ]);
      expect(notifications[0].changes[0].before).toBe("value");
      expect(notifications[0].changes[0].after).toBe("updated");
    });

    it("should send notifications for nested path changes", () => {
      const entityId = { "/": "nested-notification-test-entity" };
      const value = { user: { name: "John" } };

      const doc = createDoc(value, entityId, space, runtime);

      const notifications: any[] = [];
      runtime.storage.subscribe({
        next(notification: any) {
          notifications.push(notification);
          return { done: false };
        },
      });

      doc.setAtPath(["user", "name"], "Jane", undefined, tx.tx);

      expect(notifications).toHaveLength(1);
      expect(notifications[0].changes[0].address.path).toEqual([
        "value",
        "user",
        "name",
      ]);
      expect(notifications[0].changes[0].before).toBe("John");
      expect(notifications[0].changes[0].after).toBe("Jane");
    });

    it("should send notifications for root value changes", () => {
      const entityId = { "/": "root-notification-test-entity" };
      const value = { initial: "value" };

      const doc = createDoc(value, entityId, space, runtime);

      const notifications: any[] = [];
      runtime.storage.subscribe({
        next(notification: any) {
          notifications.push(notification);
          return { done: false };
        },
      });

      const newValue = { completely: "new value" };
      doc.setAtPath([], newValue, undefined, tx.tx);

      expect(notifications).toHaveLength(1);
      expect(notifications[0].changes[0].address.path).toEqual(["value"]);
      expect(notifications[0].changes[0].before).toEqual({ initial: "value" });
      expect(notifications[0].changes[0].after).toEqual(newValue);
    });

    it("should not send notifications when value doesn't change", () => {
      const entityId = { "/": "no-change-notification-test-entity" };
      const value = { name: "test" };

      const doc = createDoc(value, entityId, space, runtime);

      const notifications: any[] = [];
      runtime.storage.subscribe({
        next(notification: any) {
          notifications.push(notification);
          return { done: false };
        },
      });

      // Set the same value
      doc.setAtPath(["name"], "test", undefined, tx.tx);

      expect(notifications).toHaveLength(0);
    });

    it("should handle multiple notifications in sequence", () => {
      const entityId = { "/": "multiple-notification-test-entity" };
      const value = { counter: 0 };

      const doc = createDoc(value, entityId, space, runtime);

      const notifications: any[] = [];
      runtime.storage.subscribe({
        next(notification: any) {
          notifications.push(notification);
          return { done: false };
        },
      });

      doc.setAtPath(["counter"], 1, undefined, tx.tx);
      doc.setAtPath(["counter"], 2, undefined, tx.tx);
      doc.setAtPath(["counter"], 3, undefined, tx.tx);

      expect(notifications).toHaveLength(3);
      expect(notifications[0].changes[0].after).toBe(1);
      expect(notifications[1].changes[0].after).toBe(2);
      expect(notifications[2].changes[0].after).toBe(3);
    });
  });

  describe("integration with existing functionality", () => {
    it("should work with updates callbacks and storage notifications", () => {
      const entityId = { "/": "integration-test-entity" };
      const value = { status: "initial" };

      const doc = createDoc(value, entityId, space, runtime);

      const updates: Array<{ value: any; path: PropertyKey[] }> = [];
      const notifications: any[] = [];

      // Set up updates callback
      const cancelUpdates = doc.updates((value, path) => {
        updates.push({ value, path });
      });

      // Set up storage notifications
      runtime.storage.subscribe({
        next(notification: any) {
          notifications.push(notification);
          return { done: false };
        },
      });

      // Make a change
      doc.setAtPath(["status"], "updated", undefined, tx.tx);

      // Both should be triggered
      expect(updates).toHaveLength(1);
      expect(notifications).toHaveLength(1);
      expect(updates[0].path).toEqual(["status"]);
      expect(notifications[0].changes[0].address.path).toEqual([
        "value",
        "status",
      ]);

      cancelUpdates();
    });

    it("should handle frozen documents with transaction parameter", () => {
      const entityId = { "/": "frozen-transaction-test-entity" };
      const value = { data: "initial" };

      const doc = createDoc(value, entityId, space, runtime);
      doc.freeze("test freeze");

      expect(() => {
        doc.setAtPath(["data"], "new value", undefined, tx.tx);
      }).toThrow("Cell is read-only: test freeze");
    });

    it("should work with ephemeral documents", () => {
      const entityId = { "/": "ephemeral-transaction-test-entity" };
      const value = { data: "initial" };

      const doc = createDoc(value, entityId, space, runtime);
      doc.ephemeral = true;

      // Should work normally even when ephemeral
      const result = doc.setAtPath(["data"], "new value", undefined, tx.tx);
      expect(result).toBe(true);
      expect(doc.getAtPath(["data"])).toBe("new value");
    });
  });
});

describe("Subscription Shim", (config) => {
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

describe("URI Utils", (config) => {
  describe("getJSONFromDataURI", () => {
    it("should parse URI-encoded JSON data URI", () => {
      const testData = { name: "John Doe", age: 30, city: "New York" };
      const encodedData = encodeURIComponent(JSON.stringify(testData));
      const dataURI = `data:application/json,${encodedData}`;

      const result = getJSONFromDataURI(dataURI);

      expect(result).toEqual(testData);
    });

    it("should parse base64-encoded JSON data URI", () => {
      const testData = { name: "Jane Smith", age: 25, city: "Los Angeles" };
      const jsonString = JSON.stringify(testData);
      const base64Data = btoa(jsonString);
      const dataURI = `data:application/json;base64,${base64Data}`;

      const result = getJSONFromDataURI(dataURI);

      expect(result).toEqual(testData);
    });

    it("should parse data URI with UTF-8 charset", () => {
      const testData = { message: "Hello, 世界!", emoji: "🚀" };
      const encodedData = encodeURIComponent(JSON.stringify(testData));
      const dataURI = `data:application/json;charset=utf-8,${encodedData}`;

      const result = getJSONFromDataURI(dataURI);

      expect(result).toEqual(testData);
    });

    it("should parse data URI with utf8 charset variant", () => {
      const testData = { message: "Hello, 世界!", emoji: "🚀" };
      const encodedData = encodeURIComponent(JSON.stringify(testData));
      const dataURI = `data:application/json;charset=utf8,${encodedData}`;

      const result = getJSONFromDataURI(dataURI);

      expect(result).toEqual(testData);
    });

    it("should throw error for unsupported charset", () => {
      const dataURI =
        `data:application/json;charset=iso-8859-1,{"test":"data"}`;

      expect(() => getJSONFromDataURI(dataURI)).toThrow(
        "Unsupported charset: iso-8859-1. Only UTF-8 is supported.",
      );
    });

    it("should throw error for invalid data URI format", () => {
      const invalidURI = "data:application/json";

      expect(() => getJSONFromDataURI(invalidURI)).toThrow(
        "Invalid data URI format: data:application/json",
      );
    });

    it("should throw error for non-JSON data URI", () => {
      const nonJsonURI = "data:text/plain,Hello World";

      expect(() => getJSONFromDataURI(nonJsonURI)).toThrow(
        "Invalid URI: data:text/plain,Hello World",
      );
    });

    it("should throw error for invalid base64 data", () => {
      const invalidBase64URI = "data:application/json;base64,invalid-base64!@#";

      expect(() => getJSONFromDataURI(invalidBase64URI)).toThrow();
    });

    it("should throw error for invalid JSON in URI-encoded data", () => {
      const invalidJson = encodeURIComponent("{ invalid json }");
      const dataURI = `data:application/json,${invalidJson}`;

      expect(() => getJSONFromDataURI(dataURI)).toThrow();
    });

    it("should throw error for invalid JSON in base64 data", () => {
      const invalidJson = btoa("{ invalid json }");
      const dataURI = `data:application/json;base64,${invalidJson}`;

      expect(() => getJSONFromDataURI(dataURI)).toThrow();
    });
  });
});

describe("root value rewriting", (config) => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      storageManager,
      blobbyServerUrl: "http://localhost:8080",
      useStorageManagerTransactions: config.useStorageManagerTransactions,
    });
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("should rewrite root writes with value property", () => {
    const transaction = runtime.edit();

    // Write to empty path with object containing "value" property
    const writeResult = transaction.write({
      space,
      id: "of:test-root",
      type: "application/json",
      path: [],
    }, { value: { foo: "bar" } });

    expect(writeResult.ok).toBeDefined();

    // Should be able to read the value at path ["value"]
    const readResult = transaction.readOrThrow({
      space,
      id: "of:test-root",
      type: "application/json",
      path: ["value"],
    });

    expect(readResult).toEqual({ foo: "bar" });
  });

  it("should not rewrite non-empty paths", () => {
    const transaction = runtime.edit();

    // First create a document
    transaction.write({
      space,
      id: "of:test-nested",
      type: "application/json",
      path: ["value"],
    }, {});

    // Write to non-empty path with object containing "value" property
    transaction.write({
      space,
      id: "of:test-nested",
      type: "application/json",
      path: ["value", "nested"],
    }, { value: "should not be rewritten" });

    // Should store the object as-is
    const readResult = transaction.readOrThrow({
      space,
      id: "of:test-nested",
      type: "application/json",
      path: ["value", "nested"],
    });

    expect(readResult).toEqual({ value: "should not be rewritten" });
  });

  it("should not rewrite non-objects", () => {
    const transaction = runtime.edit();

    // Write non-object to empty path
    const writeResult = transaction.write({
      space,
      id: "of:test-string",
      type: "application/json",
      path: [],
    }, "plain string");

    // Should get an error since path is empty and value is not rewritten
    expect(writeResult.error).toBeDefined();
    expect(writeResult.error?.name).toBe("NotFoundError");
  });
});

describe("data: URI behaviors", (config) => {
  let runtime: Runtime;
  let storageManager: ReturnType<typeof StorageManager.emulate>;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      storageManager,
      blobbyServerUrl: "http://localhost:8080",
      useStorageManagerTransactions: config.useStorageManagerTransactions,
    });
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("should read from a valid data URI", () => {
    const transaction = runtime.edit();
    const testData = { foo: { bar: 42 } };
    const encoded = encodeURIComponent(JSON.stringify(testData));
    const address = {
      space,
      id: `data:application/json,${encoded}`,
      type: "application/json",
      path: ["foo", "bar"],
    } as IMemorySpaceAddress;
    const result = transaction.read(address);
    expect(result.ok).toBeDefined();
    expect(result.ok?.value).toBe(42);
  });

  it("should error on invalid data URI format", () => {
    const transaction = runtime.edit();
    const address = {
      space,
      id: "data:application/json", // missing data
      type: "application/json",
      path: [],
    } as IMemorySpaceAddress;
    const result = transaction.read(address);
    expect(result.error).toBeDefined();
    expect(result.error?.name).toBe("InvalidDataURIError");
    expect(result.error?.message).toMatch(
      /Invalid data URI|Invalid data URI format/,
    );
  });

  it("should error on invalid JSON in data URI", () => {
    const transaction = runtime.edit();
    const invalidJson = encodeURIComponent("{ invalid json }");
    const address = {
      space,
      id: `data:application/json,${invalidJson}`,
      type: "application/json",
      path: [],
    } as IMemorySpaceAddress;
    const result = transaction.read(address);
    expect(result.error).toBeDefined();
    expect(result.error?.name).toBe("InvalidDataURIError");
    // Should have a cause property with the original error
    expect(result.error && "cause" in result.error).toBe(true);
    expect(result.error?.cause).toBeInstanceOf(Error);
  });

  it("should error on write to data URI", () => {
    const transaction = runtime.edit();
    const address = {
      space,
      id: "data:application/json,%7B%7D",
      type: "application/json",
      path: [],
    } as IMemorySpaceAddress;
    const result = transaction.write(address, {});
    expect(result.error).toBeDefined();
    expect(result.error?.name).toBe("UnsupportedMediaTypeError");
  });
});
