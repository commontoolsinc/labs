import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { Identity } from "@commontools/identity";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("StorageTransaction", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      storageManager,
      blobbyServerUrl: "http://localhost:8080",
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
    expect(statusResult.ok).toBeDefined();
    expect(statusResult.ok?.open).toBeDefined();

    // First write to root path to create a record
    const rootWriteResult = transaction.write({
      space: "did:test:space",
      id: "test:entity",
      type: "application/json",
      path: [],
    }, {});

    expect(rootWriteResult.ok).toBeDefined();

    // Test writing a value to nested path
    const writeResult = transaction.write({
      space: "did:test:space",
      id: "test:entity",
      type: "application/json",
      path: ["name"],
    }, "John Doe");

    expect(writeResult.ok).toBeDefined();
    expect(writeResult.ok?.value).toBe("John Doe");

    // Test reading the value
    const readResult = transaction.read({
      space: "did:test:space",
      id: "test:entity",
      type: "application/json",
      path: ["name"],
    });

    expect(readResult.ok).toBeDefined();
    expect(readResult.ok?.value).toBe("John Doe");

    // Test reading non-existent path
    const readNonExistentResult = transaction.read({
      space: "did:test:space",
      id: "test:entity",
      type: "application/json",
      path: ["age"],
    });

    expect(readNonExistentResult.ok).toBeDefined();
    expect(readNonExistentResult.ok?.value).toBeUndefined();

    // Test commit - dummy commit always succeeds
    const commitResult = await transaction.commit();
    expect(commitResult.error).toBeUndefined(); // No error means success

    // Check final status
    const finalStatusResult = transaction.status();
    expect(finalStatusResult.ok?.done).toBeDefined();
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

  it("should enforce write isolation per space", async () => {
    const transaction = runtime.edit();

    // Open writer for first space
    const writer1Result = transaction.writer("did:test:space1");
    expect(writer1Result.ok).toBeDefined();

    // Try to open writer for different space - should fail
    const writer2Result = transaction.writer("did:test:space2");
    expect(writer2Result.error).toBeDefined();
    expect(writer2Result.error?.name).toBe(
      "StorageTransactionWriteIsolationError",
    );
  });

  describe("write validation", () => {
    it("should allow writing to root path when document is empty", async () => {
      const transaction = runtime.edit();

      const result = transaction.write({
        space: "did:test:space",
        id: "test://doc1",
        type: "test",
        path: [],
      }, { name: "test" });

      expect(result.error).toBeUndefined();
      expect(result.ok).toBeDefined();
    });

    it("should fail writing to nested path when document is not a record", async () => {
      const transaction = runtime.edit();

      // First write a non-record value to the document
      transaction.write({
        space: "did:test:space",
        id: "test://doc1",
        type: "test",
        path: [],
      }, "not a record");

      // Try to write to a nested path
      const result = transaction.write({
        space: "did:test:space",
        id: "test://doc1",
        type: "test",
        path: ["a"],
      }, "value");

      expect(result.error).toBeDefined();
      expect(result.error!.message).toContain("document is not a record");
    });

    it("should fail writing to deeply nested path when parent is not a record", async () => {
      const transaction = runtime.edit();

      // First write a record with a non-record value at "a"
      transaction.write({
        space: "did:test:space",
        id: "test://doc1",
        type: "test",
        path: [],
      }, { a: "not a record" });

      // Try to write to a deeply nested path
      const result = transaction.write({
        space: "did:test:space",
        id: "test://doc1",
        type: "test",
        path: ["a", "b"],
      }, "value");

      expect(result.error).toBeDefined();
      expect(result.error!.message).toContain(
        "parent path [a] does not exist or is not a record",
      );
    });

    it("should allow writing to nested path when parent is a record", async () => {
      const transaction = runtime.edit();

      // First write a record value to the document
      transaction.write({
        space: "did:test:space",
        id: "test://doc1",
        type: "test",
        path: [],
      }, { a: {} });

      // Write to a nested path
      const result = transaction.write({
        space: "did:test:space",
        id: "test://doc1",
        type: "test",
        path: ["a", "b"],
      }, "value");

      expect(result.error).toBeUndefined();
      expect(result.ok).toBeDefined();
    });

    it("should allow writing to deeply nested path when all parents are records", async () => {
      const transaction = runtime.edit();

      // First write a record with nested structure
      transaction.write({
        space: "did:test:space",
        id: "test://doc1",
        type: "test",
        path: [],
      }, { a: { b: { c: {} } } });

      // Write to a deeply nested path
      const result = transaction.write({
        space: "did:test:space",
        id: "test://doc1",
        type: "test",
        path: ["a", "b", "c", "d"],
      }, "deep value");

      expect(result.error).toBeUndefined();
      expect(result.ok).toBeDefined();
    });

    it("should fail writing to nested path when parent path doesn't exist", async () => {
      const transaction = runtime.edit();

      // First write a record to the document
      transaction.write({
        space: "did:test:space",
        id: "test://doc1",
        type: "test",
        path: [],
      }, { existing: "value" });

      // Try to write to a path where parent doesn't exist
      const result = transaction.write({
        space: "did:test:space",
        id: "test://doc1",
        type: "test",
        path: ["missing", "nested"],
      }, "value");

      expect(result.error).toBeDefined();
      expect(result.error!.message).toContain(
        "parent path [missing] does not exist or is not a record",
      );
    });
  });
});
