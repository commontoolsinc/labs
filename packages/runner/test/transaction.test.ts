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
      expect(result.status).toBe("ready");
    });

    it("should have branches and activity in status", () => {
      const status = transaction.status();
      expect(status.branches).toBeDefined();
      expect(status.activity).toBeDefined();
      expect(status.branches instanceof Map).toBe(true);
      expect(Array.isArray(status.activity)).toBe(true);
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
      expect(readResult.error).toBeUndefined();
      expect((readResult as { ok: { value: unknown } }).ok.value).toEqual(
        value,
      );
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
      expect(readResult.error).toBeUndefined();
      expect((readResult as { ok: { value: unknown } }).ok.value).toEqual(
        value,
      );
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
      expect(readResult.error).toBeUndefined();
      expect((readResult as { ok: { value: unknown } }).ok.value).toEqual(
        value,
      );
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
      expect(stringResult.error).toBeUndefined();

      // Test number metadata
      const numberMeta = { count: 42, weight: 3.14 };
      const numberResult = transaction.read(address, { meta: numberMeta });
      expect(numberResult.error).toBeUndefined();

      // Test boolean metadata
      const booleanMeta = { enabled: true, debug: false };
      const booleanResult = transaction.read(address, { meta: booleanMeta });
      expect(booleanResult.error).toBeUndefined();

      // Test nested object metadata
      const nestedMeta = {
        config: { nested: { value: "deep" } },
        array: [1, 2, 3],
      };
      const nestedResult = transaction.read(address, { meta: nestedMeta });
      expect(nestedResult.error).toBeUndefined();

      // Test empty metadata object
      const emptyMeta = {};
      const emptyResult = transaction.read(address, { meta: emptyMeta });
      expect(emptyResult.error).toBeUndefined();
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
      expect(write1.error).toBeUndefined();

      // Write to second space (no longer has write isolation)
      const write2 = transaction.write(address2, { space: 2 });
      expect(write2.error).toBeUndefined();

      // Both spaces should have their data
      const read1 = transaction.read(address1);
      expect(read1.error).toBeUndefined();
      expect((read1 as { ok: { value: unknown } }).ok.value).toEqual({
        space: 1,
      });

      const read2 = transaction.read(address2);
      expect(read2.error).toBeUndefined();
      expect((read2 as { ok: { value: unknown } }).ok.value).toEqual({
        space: 2,
      });
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
      expect(read1.error).toBeUndefined();
      expect((read1 as { ok: { value: unknown } }).ok.value).toEqual({
        data: "space1",
      });

      // Read from second space with metadata (should work, but no data)
      const read2 = transaction.read(address2, { meta: metadata2 });
      expect(read2.error).toBeUndefined();
      expect((read2 as { ok: { value: unknown } }).ok.value).toBeUndefined(); // No data written
    });

    it("should support metadata in read operations", () => {
      const address = {
        space,
        id: "test:interface-meta",
        type: "application/json",
        path: [],
      } as const;
      const value = { name: "Interface Test" };
      const metadata = { interface: "reader", test: true };

      // Write using transaction
      transaction.write(address, value);

      // Read with metadata
      const readResult = transaction.read(address, { meta: metadata });
      expect(readResult.error).toBeUndefined();
      expect((readResult as { ok: { value: unknown } }).ok.value).toEqual(
        value,
      );
    });
  });

  describe("Transaction Abort", () => {
    it("should abort successfully", () => {
      transaction.write({
        space,
        id: "test:abort",
        type: "application/json",
        path: [],
      }, { test: "data" });

      const reason = "test abort";
      const result = transaction.abort(reason);
      expect(result.ok).toBeDefined();

      const status = transaction.status();
      expect(status.status).toBe("error");
      if (status.status === "error") {
        expect(status.error.name).toBe("StorageTransactionAborted");
        if (status.error.name === "StorageTransactionAborted") {
          expect(status.error.reason).toBe(reason);
        }
      }
    });

    it("should fail operations after abort", () => {
      transaction.abort("test");

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
      expect(status.status).toBe("done");
    });

    it("should commit transaction with changes", async () => {
      const address = {
        space,
        id: "test:commit",
        type: "application/json",
        path: [],
      } as const;

      transaction.write(address, { committed: true });

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
      expect(verifyResult.error).toBeUndefined();
      expect((verifyResult as { ok: { value: unknown } }).ok.value).toEqual({
        committed: true,
      });
    });

    it("should transition through pending state", async () => {
      transaction.write({
        space,
        id: "test:pending",
        type: "application/json",
        path: [],
      }, { test: "data" });

      const commitPromise = transaction.commit();

      // Check status while committing
      const pendingStatus = transaction.status();
      expect(pendingStatus.status).toBe("pending");

      await commitPromise;

      // Check status after commit
      const doneStatus = transaction.status();
      expect(doneStatus.status).toBe("done");
    });

    it("should fail operations after commit", async () => {
      await transaction.commit();

      const readResult = transaction.read({
        space,
        id: "test:1",
        type: "application/json",
        path: [],
      });
      expect(readResult.error).toBeDefined();
      expect(readResult.error?.name).toBe("StorageTransactionCompleteError");

      const writeResult = transaction.write({
        space,
        id: "test:1",
        type: "application/json",
        path: [],
      }, {});
      expect(writeResult.error).toBeDefined();
      expect(writeResult.error?.name).toBe("StorageTransactionCompleteError");
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
      expect(readResult.error).toBeUndefined();
      expect((readResult as { ok: { value: unknown } }).ok.value).toEqual({
        name: "Initial",
        version: 1,
      });

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
      const updatedState = replica.get({
        id: "user:consistency",
        type: "application/json",
      });
      expect(updatedState?.is).toEqual({ name: "Modified", version: 2 });

      // Now attempt to commit - should fail due to read invariant violation
      const commitResult = await freshTransaction.commit();
      expect(commitResult.error).toBeDefined();
      expect(commitResult.error?.name).toBe("StorageTransactionInconsistent");

      // Verify transaction status shows failure
      const status = freshTransaction.status();
      expect(status.status).toBe("error");
      if (status.status === "error") {
        expect(status.error.name).toBe("StorageTransactionInconsistent");
      }
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
      expect(result.error).toBeUndefined();
      expect((result as { ok: { value: unknown } }).ok.value).toEqual({
        name: "Bob",
        status: "active",
      });
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
      expect(result.error).toBeUndefined();
      expect((result as { ok: { value: unknown } }).ok.value).toBe("admin");
    });
  });

  describe("Error Handling", () => {
    it("should handle reading invalid nested paths", () => {
      const rootAddress = {
        space,
        id: "test:error",
        type: "application/json",
        path: [],
      } as const;

      // Write a non-object value
      transaction.write(rootAddress, "not an object");

      // Try to read nested path
      const nestedAddress = {
        ...rootAddress,
        path: ["property"],
      } as const;

      const result = transaction.read(nestedAddress);
      expect(result.error).toBeDefined();
      expect(result.error?.name).toBe("TypeMismatchError");
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
      expect(result.error?.name).toBe("TypeMismatchError");
    });
  });

  describe("Edge Cases", () => {
    it("should handle read-only transactions", async () => {
      // Only perform reads, no writes
      const read1 = transaction.read({
        space,
        id: "test:readonly",
        type: "application/json",
        path: [],
      });
      const read2 = transaction.read({
        space: space2,
        id: "test:readonly",
        type: "application/json",
        path: [],
      });

      // Reads return NotFoundError for non-existent data (which is fine)
      expect(read1.error?.name === "NotFoundError" || !read1.error)
        .toBeTruthy();
      expect(read2.error?.name === "NotFoundError" || !read2.error)
        .toBeTruthy();

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
      expect(result.error).toBeUndefined();
      expect((result as { ok: { value: unknown } }).ok.value).toEqual({
        name: "Eve",
      });
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
      expect(result.error).toBeUndefined();
      expect((result as { ok: { value: unknown } }).ok.value).toEqual({
        items: ["a", "B", "c"],
      });
    });
  });
});
