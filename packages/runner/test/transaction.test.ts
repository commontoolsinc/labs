import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import * as Transaction from "../src/storage/transaction.ts";
import { assert } from "@commontools/memory/fact";

const signer = await Identity.fromPassphrase("transaction test");
const signer2 = await Identity.fromPassphrase("transaction test 2");
const space = signer.did();
const space2 = signer2.did();

describe("StorageTransaction", () => {
  let storage: ReturnType<typeof StorageManager.emulate>;
  let transaction: ReturnType<typeof Transaction.create>;

  beforeEach(() => {
    storage = StorageManager.emulate({ as: signer });
    transaction = Transaction.create(storage);
  });

  afterEach(async () => {
    await storage?.close();
  });

  describe("Basic Lifecycle", () => {
    it("should start with ready status", () => {
      const result = transaction.status();
      expect(result.ok).toBeDefined();
      expect(result.ok?.status).toBe("ready");
    });

    it("should create reader for a space", () => {
      const result = transaction.reader(space);
      expect(result.ok).toBeDefined();
      expect(result.ok?.did()).toBe(space);
    });

    it("should create writer for a space", () => {
      const result = transaction.writer(space);
      expect(result.ok).toBeDefined();
      expect(result.ok?.did()).toBe(space);
    });

    it("should return same reader instance for same space", () => {
      const reader1 = transaction.reader(space);
      const reader2 = transaction.reader(space);
      expect(reader1.ok).toBe(reader2.ok);
    });

    it("should return same writer instance for same space", () => {
      const writer1 = transaction.writer(space);
      const writer2 = transaction.writer(space);
      expect(writer1.ok).toBe(writer2.ok);
    });

    it("should create different readers for different spaces", () => {
      const reader1 = transaction.reader(space);
      const reader2 = transaction.reader(space2);

      expect(reader1.ok).toBeDefined();
      expect(reader2.ok).toBeDefined();
      expect(reader1.ok).not.toBe(reader2.ok);
      expect(reader1.ok?.did()).toBe(space);
      expect(reader2.ok?.did()).toBe(space2);
    });
  });

  describe("Write Isolation", () => {
    it("should enforce single writer constraint", () => {
      // First writer succeeds
      const writer1 = transaction.writer(space);
      expect(writer1.ok).toBeDefined();

      // Second writer for different space fails
      const writer2 = transaction.writer(space2);
      expect(writer2.error).toBeDefined();
      expect(writer2.error?.name).toBe("StorageTransactionWriteIsolationError");
      if (writer2.error?.name === "StorageTransactionWriteIsolationError") {
        expect(writer2.error.open).toBe(space);
        expect(writer2.error.requested).toBe(space2);
      }
    });

    it("should allow multiple readers with single writer", () => {
      const writer = transaction.writer(space);
      expect(writer.ok).toBeDefined();

      const reader1 = transaction.reader(space);
      const reader2 = transaction.reader(space2);

      expect(reader1.ok).toBeDefined();
      expect(reader2.ok).toBeDefined();
    });

    it("should allow writer after readers", () => {
      const reader1 = transaction.reader(space);
      const reader2 = transaction.reader(space2);

      expect(reader1.ok).toBeDefined();
      expect(reader2.ok).toBeDefined();

      const writer = transaction.writer(space);
      expect(writer.ok).toBeDefined();
    });
  });

  describe("Read/Write Operations", () => {
    it("should read and write through transaction interface", () => {
      const address = {
        space,
        id: "test:1",
        type: "application/json",
        path: [],
      } as const;
      const value = { name: "Alice", age: 30 };

      // Write value
      const writeResult = transaction.write(address, value);
      expect(writeResult.ok).toBeDefined();
      expect(writeResult.ok?.value).toEqual(value);

      // Read value
      const readResult = transaction.read(address);
      expect(readResult.ok).toBeDefined();
      if (readResult.ok) {
        expect(readResult.ok.value).toEqual(value);
      }
    });

    it("should read with metadata options", () => {
      const address = {
        space,
        id: "test:metadata",
        type: "application/json",
        path: [],
      } as const;
      const value = { name: "Bob", age: 25 };
      const metadata = { source: "test", version: 1, priority: "high" };

      // Write value
      transaction.write(address, value);

      // Read with metadata
      const readResult = transaction.read(address, { meta: metadata });
      expect(readResult.ok).toBeDefined();
      if (readResult.ok) {
        expect(readResult.ok.value).toEqual(value);
      }
    });

    it("should read without metadata (default behavior)", () => {
      const address = {
        space,
        id: "test:no-metadata",
        type: "application/json",
        path: [],
      } as const;
      const value = { name: "Charlie", age: 35 };

      // Write value
      transaction.write(address, value);

      // Read without metadata options (should work as before)
      const readResult = transaction.read(address);
      expect(readResult.ok).toBeDefined();
      if (readResult.ok) {
        expect(readResult.ok.value).toEqual(value);
      }
    });

    it("should handle various metadata types", () => {
      const address = {
        space,
        id: "test:metadata-types",
        type: "application/json",
        path: [],
      } as const;
      const value = { test: "data" };

      // Write value first
      transaction.write(address, value);

      // Test string metadata
      const stringMeta = { type: "string", data: "test string" };
      const stringResult = transaction.read(address, { meta: stringMeta });
      expect(stringResult.ok).toBeDefined();

      // Test number metadata
      const numberMeta = { count: 42, weight: 3.14 };
      const numberResult = transaction.read(address, { meta: numberMeta });
      expect(numberResult.ok).toBeDefined();

      // Test boolean metadata
      const booleanMeta = { enabled: true, debug: false };
      const booleanResult = transaction.read(address, { meta: booleanMeta });
      expect(booleanResult.ok).toBeDefined();

      // Test nested object metadata
      const nestedMeta = { config: { nested: { value: "deep" } }, array: [1, 2, 3] };
      const nestedResult = transaction.read(address, { meta: nestedMeta });
      expect(nestedResult.ok).toBeDefined();

      // Test empty metadata object
      const emptyMeta = {};
      const emptyResult = transaction.read(address, { meta: emptyMeta });
      expect(emptyResult.ok).toBeDefined();
    });

    it("should handle cross-space operations", () => {
      const address1 = {
        space,
        id: "test:1",
        type: "application/json",
        path: [],
      } as const;
      const address2 = {
        space: space2,
        id: "test:1",
        type: "application/json",
        path: [],
      } as const;

      // Write to first space
      const write1 = transaction.write(address1, { space: 1 });
      expect(write1.ok).toBeDefined();

      // Try to write to second space (should fail due to write isolation)
      const write2 = transaction.write(address2, { space: 2 });
      expect(write2.error).toBeDefined();
      expect(write2.error?.name).toBe("StorageTransactionWriteIsolationError");

      // But reading from second space should work
      const read2 = transaction.read(address2);
      expect(read2.ok).toBeDefined();
      if (read2.ok) {
        expect(read2.ok.value).toBeUndefined(); // No data written
      }
    });

    it("should handle cross-space operations with metadata", () => {
      const address1 = {
        space,
        id: "test:cross-space-meta",
        type: "application/json",
        path: [],
      } as const;
      const address2 = {
        space: space2,
        id: "test:cross-space-meta",
        type: "application/json",
        path: [],
      } as const;
      const metadata1 = { space: "first", operation: "test" };
      const metadata2 = { space: "second", operation: "test" };

      // Write to first space
      transaction.write(address1, { data: "space1" });

      // Read from first space with metadata
      const read1 = transaction.read(address1, { meta: metadata1 });
      expect(read1.ok).toBeDefined();
      if (read1.ok) {
        expect(read1.ok.value).toEqual({ data: "space1" });
      }

      // Read from second space with metadata (should work, but no data)
      const read2 = transaction.read(address2, { meta: metadata2 });
      expect(read2.ok).toBeDefined();
      if (read2.ok) {
        expect(read2.ok.value).toBeUndefined(); // No data written
      }
    });

    it("should support metadata in reader and writer interfaces", () => {
      const address = {
        id: "test:interface-meta",
        type: "application/json",
        path: [],
      } as const;
      const value = { name: "Interface Test" };
      const metadata = { interface: "reader", test: true };

      // Get reader and writer
      const readerResult = transaction.reader(space);
      const writerResult = transaction.writer(space);
      expect(readerResult.ok).toBeDefined();
      expect(writerResult.ok).toBeDefined();

      const reader = readerResult.ok!;
      const writer = writerResult.ok!;

      // Write using writer
      writer.write(address, value);

      // Read using reader with metadata
      const readResult = reader.read(address, { meta: metadata });
      expect(readResult.ok).toBeDefined();
      if (readResult.ok) {
        expect(readResult.ok.value).toEqual(value);
      }

      // Read using writer with metadata (writer extends reader)
      const writerReadResult = writer.read(address, { meta: metadata });
      expect(writerReadResult.ok).toBeDefined();
      if (writerReadResult.ok) {
        expect(writerReadResult.ok.value).toEqual(value);
      }
    });
  });

  describe("Transaction Abort", () => {
    it("should abort successfully", () => {
      const writer = transaction.writer(space);
      writer.ok!.write({
        id: "test:abort",
        type: "application/json",
        path: [],
      }, { test: "data" });

      const reason = "test abort";
      const result = transaction.abort(reason);
      expect(result.ok).toBeDefined();

      const status = transaction.status();
      expect(status.error).toBeDefined();
      expect(status.error?.name).toBe("StorageTransactionAborted");
      if (status.error?.name === "StorageTransactionAborted") {
        expect(status.error.reason).toBe(reason);
      }
    });

    it("should fail operations after abort", () => {
      transaction.abort("test");

      const readerResult = transaction.reader(space);
      expect(readerResult.error).toBeDefined();
      expect(readerResult.error?.name).toBe("StorageTransactionCompleteError");

      const writerResult = transaction.writer(space);
      expect(writerResult.error).toBeDefined();
      expect(writerResult.error?.name).toBe("StorageTransactionCompleteError");

      const readResult = transaction.read({
        space,
        id: "test:1",
        type: "application/json",
        path: [],
      });
      expect(readResult.error).toBeDefined();

      const writeResult = transaction.write({
        space,
        id: "test:1",
        type: "application/json",
        path: [],
      }, {});
      expect(writeResult.error).toBeDefined();
    });

    it("should not abort twice", () => {
      const result1 = transaction.abort("first");
      expect(result1.ok).toBeDefined();

      const result2 = transaction.abort("second");
      expect(result2.error).toBeDefined();
      expect(result2.error?.name).toBe("StorageTransactionCompleteError");
    });
  });

  describe("Transaction Commit", () => {
    it("should commit empty transaction", async () => {
      const result = await transaction.commit();
      expect(result.ok).toBeDefined();

      const status = transaction.status();
      expect(status.ok).toBeDefined();
      expect(status.ok?.status).toBe("done");
    });

    it("should commit transaction with changes", async () => {
      const writer = transaction.writer(space);
      const address = {
        id: "test:commit",
        type: "application/json",
        path: [],
      } as const;

      writer.ok!.write(address, { committed: true });

      const result = await transaction.commit();
      expect(result.ok).toBeDefined();

      // Verify by creating new transaction and reading
      const verifyTransaction = Transaction.create(storage);
      const verifyResult = verifyTransaction.read({
        space,
        id: "test:commit",
        type: "application/json",
        path: [],
      });
      if (verifyResult.ok) {
        expect(verifyResult.ok.value).toEqual({ committed: true });
      } else {
        expect(verifyResult.ok).toBeDefined();
      }
    });

    it("should transition through pending state", async () => {
      const writer = transaction.writer(space);
      writer.ok!.write({
        id: "test:pending",
        type: "application/json",
        path: [],
      }, { test: "data" });

      const commitPromise = transaction.commit();

      // Check status while committing
      const pendingStatus = transaction.status();
      expect(pendingStatus.ok).toBeDefined();
      expect(pendingStatus.ok?.status).toBe("pending");

      await commitPromise;

      // Check status after commit
      const doneStatus = transaction.status();
      expect(doneStatus.ok).toBeDefined();
      expect(doneStatus.ok?.status).toBe("done");
    });

    it("should fail operations after commit", async () => {
      await transaction.commit();

      const readerResult = transaction.reader(space);
      expect(readerResult.error).toBeDefined();
      expect(readerResult.error?.name).toBe("StorageTransactionCompleteError");

      const writerResult = transaction.writer(space);
      expect(writerResult.error).toBeDefined();
      expect(writerResult.error?.name).toBe("StorageTransactionCompleteError");
    });

    it("should not commit twice", async () => {
      const result1 = await transaction.commit();
      expect(result1.ok).toBeDefined();

      const result2 = await transaction.commit();
      expect(result2.error).toBeDefined();
      expect(result2.error?.name).toBe("StorageTransactionCompleteError");
    });

    it("should not commit after abort", async () => {
      transaction.abort("test");

      const result = await transaction.commit();
      expect(result.error).toBeDefined();
      expect(result.error?.name).toBe("StorageTransactionCompleteError");
    });

    it("should fail commit when replica is modified after read invariant is established", async () => {
      // Pre-populate replica with initial data
      const replica = storage.open(space).replica;
      const v1 = assert({
        the: "application/json",
        of: "user:consistency",
        is: { name: "Initial", version: 1 },
      });
      
      const initialCommit = await replica.commit({
        facts: [v1],
        claims: [],
      });
      expect(initialCommit.ok).toBeDefined();

      // Create transaction and establish a read invariant
      const freshTransaction = Transaction.create(storage);
      const address = {
        space,
        id: "user:consistency",
        type: "application/json",
        path: [],
      } as const;

      // Read to establish invariant (this locks in the expected value)
      const readResult = freshTransaction.read(address);
      if (readResult.ok) {
        expect(readResult.ok.value).toEqual({ name: "Initial", version: 1 });
      } else {
        expect(readResult.ok).toBeDefined();
      }

      // Modify the replica outside the transaction with proper causal reference
      const v2 = assert({
        the: "application/json",
        of: "user:consistency",
        is: { name: "Modified", version: 2 },
        cause: v1,
      });
      
      const modifyCommit = await replica.commit({
        facts: [v2],
        claims: [],
      });
      expect(modifyCommit.ok).toBeDefined();

      // Verify the replica state actually changed
      const updatedState = replica.get({ the: "application/json", of: "user:consistency" });
      expect(updatedState?.is).toEqual({ name: "Modified", version: 2 });

      // Now attempt to commit - should fail due to read invariant violation
      const commitResult = await freshTransaction.commit();
      expect(commitResult.error).toBeDefined();
      expect(commitResult.error?.name).toBe("StorageTransactionInconsistent");

      // Verify transaction status shows failure
      const status = freshTransaction.status();
      expect(status.error).toBeDefined();
      expect(status.error?.name).toBe("StorageTransactionInconsistent");
    });
  });

  describe("Pre-populated Replica Reads", () => {
    it("should read existing data from replica", async () => {
      // Pre-populate replica
      const replica = storage.open(space).replica;
      await replica.commit({
        facts: [
          assert({
            the: "application/json",
            of: "user:existing",
            is: { name: "Bob", status: "active" },
          }),
        ],
        claims: [],
      });

      // Create new transaction and read
      const freshTransaction = Transaction.create(storage);
      const address = {
        space,
        id: "user:existing",
        type: "application/json",
        path: [],
      } as const;

      const result = freshTransaction.read(address);
      expect(result.ok).toBeDefined();
      if (result.ok) {
        expect(result.ok.value).toEqual({ name: "Bob", status: "active" });
      }
    });

    it("should handle nested path reads from replica", async () => {
      // Pre-populate replica
      const replica = storage.open(space).replica;
      await replica.commit({
        facts: [
          assert({
            the: "application/json",
            of: "config:nested",
            is: {
              database: {
                host: "localhost",
                port: 5432,
                credentials: { user: "admin" },
              },
            },
          }),
        ],
        claims: [],
      });

      const freshTransaction = Transaction.create(storage);
      const nestedAddress = {
        space,
        id: "config:nested",
        type: "application/json",
        path: ["database", "credentials", "user"],
      } as const;

      const result = freshTransaction.read(nestedAddress);
      if (result.ok) {
        expect(result.ok.value).toBe("admin");
      } else {
        expect(result.ok).toBeDefined();
      }
    });
  });

  describe("Error Handling", () => {
    it("should handle reading invalid nested paths", () => {
      const writer = transaction.writer(space);
      const rootAddress = {
        space,
        id: "test:error",
        type: "application/json",
        path: [],
      } as const;

      // Write a non-object value
      writer.ok!.write(rootAddress, "not an object");

      // Try to read nested path
      const nestedAddress = {
        ...rootAddress,
        path: ["property"],
      } as const;

      const result = transaction.read(nestedAddress);
      expect(result.error).toBeDefined();
      expect(result.error?.name).toBe("StorageTransactionInconsistent");
    });

    it("should handle writing to invalid nested paths", () => {
      const address = {
        space,
        id: "test:write-error",
        type: "application/json",
        path: [],
      } as const;

      // Write a string
      transaction.write(address, "hello");

      // Try to write to nested path
      const nestedAddress = {
        ...address,
        path: ["property"],
      } as const;

      const result = transaction.write(nestedAddress, "value");
      expect(result.error).toBeDefined();
      expect(result.error?.name).toBe("StorageTransactionInconsistent");
    });
  });

  describe("Edge Cases", () => {
    it("should handle operations on transaction with no writer", async () => {
      // Only create readers, no writers
      const reader1 = transaction.reader(space);
      const reader2 = transaction.reader(space2);

      expect(reader1.ok).toBeDefined();
      expect(reader2.ok).toBeDefined();

      // Commit should still work
      const result = await transaction.commit();
      expect(result.ok).toBeDefined();
    });

    it("should handle undefined values for deletion", () => {
      const rootAddress = {
        space,
        id: "test:delete",
        type: "application/json",
        path: [],
      } as const;

      // Write object
      transaction.write(rootAddress, { name: "Eve", age: 28 });

      // Delete property
      const propAddress = {
        ...rootAddress,
        path: ["age"],
      } as const;
      transaction.write(propAddress, undefined);

      // Read should not have the deleted property
      const result = transaction.read(rootAddress);
      if (result.ok) {
        expect(result.ok.value).toEqual({ name: "Eve" });
      } else {
        expect(result.ok).toBeDefined();
      }
    });

    it("should handle array operations", () => {
      const address = {
        space,
        id: "test:array",
        type: "application/json",
        path: [],
      } as const;

      transaction.write(address, { items: ["a", "b", "c"] });

      const itemAddress = {
        ...address,
        path: ["items", "1"],
      } as const;

      transaction.write(itemAddress, "B");

      const result = transaction.read(address);
      if (result.ok) {
        expect(result.ok.value).toEqual({ items: ["a", "B", "c"] });
      } else {
        expect(result.ok).toBeDefined();
      }
    });
  });
});