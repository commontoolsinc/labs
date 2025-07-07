import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import * as Journal from "../src/storage/transaction/journal.ts";
import { assert } from "@commontools/memory/fact";

const signer = await Identity.fromPassphrase("journal test");
const signer2 = await Identity.fromPassphrase("journal test 2");
const space = signer.did();
const space2 = signer2.did();

describe("Journal", () => {
  let storage: ReturnType<typeof StorageManager.emulate>;
  let journal: ReturnType<typeof Journal.open>;

  beforeEach(() => {
    storage = StorageManager.emulate({ as: signer });
    journal = Journal.open(storage);
  });

  afterEach(async () => {
    await storage?.close();
  });

  describe("Basic Operations", () => {
    it("should start in open state", () => {
      expect(journal.status).toBe("open");
    });

    it("should track activity", () => {
      expect([...journal.activity()]).toEqual([]);
    });

    it("should provide novelty and history iterators", () => {
      expect([...journal.novelty(space)]).toEqual([]);
      expect([...journal.history(space)]).toEqual([]);
    });
  });

  describe("Reader Operations", () => {
    it("should create readers for memory spaces", () => {
      const { ok: reader, error } = journal.reader(space);
      expect(error).toBeUndefined();
      expect(reader).toBeDefined();
    });

    it("should return same reader instance for same space", () => {
      const { ok: reader1 } = journal.reader(space);
      const { ok: reader2 } = journal.reader(space);
      expect(reader1).toBe(reader2);
    });

    it("should read undefined for non-existent entity", () => {
      const { ok: reader } = journal.reader(space);
      const address = {
        id: "test:nonexistent",
        type: "application/json",
        path: [],
      } as const;

      const result = reader!.read(address);
      expect(result.ok).toBeDefined();
      expect(result.ok?.value).toBeUndefined();
    });

    it("should read existing data from replica", async () => {
      // Pre-populate replica
      const testData = { name: "Charlie", age: 25 };
      const replica = storage.open(space).replica;
      await replica.commit({
        facts: [
          assert({
            the: "application/json",
            of: "user:1",
            is: testData,
          }),
        ],
        claims: [],
      });

      // Create new journal and read
      const freshJournal = Journal.open(storage);
      const { ok: reader } = freshJournal.reader(space);
      const address = {
        id: "user:1",
        type: "application/json",
        path: [],
      } as const;

      const result = reader!.read(address);
      expect(result.ok).toBeDefined();
      expect(result.ok?.value).toEqual(testData);
    });

    it("should read nested paths from replica data", async () => {
      // Pre-populate replica
      const replica = storage.open(space).replica;
      await replica.commit({
        facts: [
          assert({
            the: "application/json",
            of: "user:2",
            is: {
              profile: {
                name: "David",
                settings: { theme: "dark" },
              },
            },
          }),
        ],
        claims: [],
      });

      const freshJournal = Journal.open(storage);
      const { ok: reader } = freshJournal.reader(space);
      const nestedAddress = {
        id: "user:2",
        type: "application/json",
        path: ["profile", "settings", "theme"],
      } as const;

      const result = reader!.read(nestedAddress);
      expect(result.ok?.value).toBe("dark");
    });
  });

  describe("Writer Operations", () => {
    it("should create writers for memory spaces", () => {
      const { ok: writer, error } = journal.writer(space);
      expect(error).toBeUndefined();
      expect(writer).toBeDefined();
    });

    it("should return same writer instance for same space", () => {
      const { ok: writer1 } = journal.writer(space);
      const { ok: writer2 } = journal.writer(space);
      expect(writer1).toBe(writer2);
    });

    it("should write and read a simple value", () => {
      const { ok: writer } = journal.writer(space);
      const address = {
        id: "test:1",
        type: "application/json",
        path: [],
      } as const;
      const value = { name: "Alice", age: 30 };

      // Write using writer instance
      const writeResult = writer!.write(address, value);
      expect(writeResult.ok).toBeDefined();
      expect(writeResult.ok?.value).toEqual(value);

      // Read using writer instance
      const readResult = writer!.read(address);
      expect(readResult.ok).toBeDefined();
      expect(readResult.ok?.value).toEqual(value);
    });

    it("should handle nested path writes and reads", () => {
      const { ok: writer } = journal.writer(space);
      const rootAddress = {
        id: "test:2",
        type: "application/json",
        path: [],
      } as const;
      const nestedAddress = {
        id: "test:2",
        type: "application/json",
        path: ["profile", "name"],
      } as const;

      // Write root
      writer!.write(rootAddress, {
        profile: { name: "Bob", bio: "Developer" },
        posts: [],
      });

      // Write to nested path
      writer!.write(nestedAddress, "Robert");

      // Read nested path
      const nestedResult = writer!.read(nestedAddress);
      expect(nestedResult.ok?.value).toBe("Robert");

      // Read root should have the updated nested value
      const rootResult = writer!.read(rootAddress);
      expect(rootResult.ok?.value).toEqual({
        profile: { name: "Robert", bio: "Developer" },
        posts: [],
      });
    });

    it("should track novelty changes", () => {
      const { ok: writer } = journal.writer(space);
      const rootAddress = {
        id: "test:3",
        type: "application/json",
        path: [],
      } as const;
      const nestedAddress = {
        id: "test:3",
        type: "application/json",
        path: ["name"],
      } as const;

      // First create the parent object
      writer!.write(rootAddress, { name: "Initial" });
      // Then write to nested path
      writer!.write(nestedAddress, "Alice");

      const noveltyEntries = [...journal.novelty(space)];
      expect(noveltyEntries).toHaveLength(1);
      expect(noveltyEntries[0].address.path).toEqual([]);
      expect(noveltyEntries[0].value).toEqual({ name: "Alice" });
    });
  });

  describe("Multi-Space Operations", () => {
    it("should handle readers and writers for multiple spaces", () => {
      const { ok: reader1 } = journal.reader(space);
      const { ok: reader2 } = journal.reader(space2);
      const { ok: writer1 } = journal.writer(space);
      const { ok: writer2 } = journal.writer(space2);

      expect(reader1).toBeDefined();
      expect(reader2).toBeDefined();
      expect(writer1).toBeDefined();
      expect(writer2).toBeDefined();
      expect(reader1).not.toBe(reader2);
      expect(writer1).not.toBe(writer2);
    });

    it("should isolate operations between spaces", () => {
      const { ok: writer1 } = journal.writer(space);
      const { ok: writer2 } = journal.writer(space2);
      const address = {
        id: "test:isolation",
        type: "application/json",
        path: [],
      } as const;

      // Write to space1
      writer1!.write(address, { space: "space1" });

      // Write to space2
      writer2!.write(address, { space: "space2" });

      // Read from space1
      const result1 = writer1!.read(address);
      expect(result1.ok?.value).toEqual({ space: "space1" });

      // Read from space2
      const result2 = writer2!.read(address);
      expect(result2.ok?.value).toEqual({ space: "space2" });

      // Check novelty is isolated
      const novelty1 = [...journal.novelty(space)];
      const novelty2 = [...journal.novelty(space2)];
      expect(novelty1).toHaveLength(1);
      expect(novelty2).toHaveLength(1);
      expect(novelty1[0].value).toEqual({ space: "space1" });
      expect(novelty2[0].value).toEqual({ space: "space2" });
    });
  });

  describe("Transaction Lifecycle", () => {
    it("should close successfully with no changes", () => {
      const { ok: archive, error } = journal.close();
      expect(error).toBeUndefined();
      expect(archive).toBeDefined();
      expect(archive!.size).toBe(0);
      expect(journal.status).toBe("closed");
    });

    it("should close successfully with changes", () => {
      const { ok: writer } = journal.writer(space);
      const address = {
        id: "test:close",
        type: "application/json",
        path: [],
      } as const;

      writer!.write(address, { test: "data" });

      const { ok: archive, error } = journal.close();
      expect(error).toBeUndefined();
      expect(archive).toBeDefined();
      expect(archive!.size).toBe(1);
      expect(archive!.has(space)).toBe(true);
      expect(journal.status).toBe("closed");
    });

    it("should abort successfully", () => {
      const { ok: writer } = journal.writer(space);
      writer!.write({
        id: "test:abort",
        type: "application/json",
        path: [],
      }, { test: "data" });

      const reason = "test abort";
      const result = journal.abort(reason);
      expect(result.ok).toBeDefined();
      expect(journal.status).toBe("closed");
    });

    it("should fail operations after closing", () => {
      journal.close();

      const readerResult = journal.reader(space);
      expect(readerResult.error).toBeDefined();
      expect(readerResult.error?.name).toBe("StorageTransactionCompleteError");

      const writerResult = journal.writer(space);
      expect(writerResult.error).toBeDefined();
      expect(writerResult.error?.name).toBe("StorageTransactionCompleteError");
    });

    it("should fail operations after aborting", () => {
      journal.abort("test reason");

      const readerResult = journal.reader(space);
      expect(readerResult.error).toBeDefined();
      expect(readerResult.error?.name).toBe("StorageTransactionAborted");

      const writerResult = journal.writer(space);
      expect(writerResult.error).toBeDefined();
      expect(writerResult.error?.name).toBe("StorageTransactionAborted");
    });

    it("should handle multiple close attempts", () => {
      const result1 = journal.close();
      expect(result1.ok).toBeDefined();

      const result2 = journal.close();
      expect(result2.error).toBeDefined();
      expect(result2.error?.name).toBe("StorageTransactionCompleteError");
    });

    it("should handle multiple abort attempts", () => {
      const result1 = journal.abort("reason1");
      expect(result1.ok).toBeDefined();

      const result2 = journal.abort("reason2");
      expect(result2.error).toBeDefined();
      expect(result2.error?.name).toBe("StorageTransactionAborted");
    });

    it("should fail reader operations after journal is closed", () => {
      const { ok: reader } = journal.reader(space);
      expect(reader).toBeDefined();

      journal.close();

      const newReaderResult = journal.reader(space);
      expect(newReaderResult.error).toBeDefined();
      expect(newReaderResult.error?.name).toBe("StorageTransactionCompleteError");

      const readResult = reader!.read({
        id: "test:closed",
        type: "application/json",
        path: [],
      });
      expect(readResult.error).toBeDefined();
      expect(readResult.error?.name).toBe("StorageTransactionCompleteError");
    });

    it("should fail reader operations after journal is aborted", () => {
      const { ok: reader } = journal.reader(space);
      expect(reader).toBeDefined();

      journal.abort("test abort");

      const newReaderResult = journal.reader(space);
      expect(newReaderResult.error).toBeDefined();
      expect(newReaderResult.error?.name).toBe("StorageTransactionAborted");

      const readResult = reader!.read({
        id: "test:aborted",
        type: "application/json",
        path: [],
      });
      expect(readResult.error).toBeDefined();
      expect(readResult.error?.name).toBe("StorageTransactionAborted");
    });

    it("should fail writer operations after journal is closed", () => {
      const { ok: writer } = journal.writer(space);
      expect(writer).toBeDefined();

      journal.close();

      const newWriterResult = journal.writer(space);
      expect(newWriterResult.error).toBeDefined();
      expect(newWriterResult.error?.name).toBe("StorageTransactionCompleteError");

      const readResult = writer!.read({
        id: "test:closed-write",
        type: "application/json",
        path: [],
      });
      expect(readResult.error).toBeDefined();
      expect(readResult.error?.name).toBe("StorageTransactionCompleteError");

      const writeResult = writer!.write({
        id: "test:closed-write",
        type: "application/json",
        path: [],
      }, { test: "data" });
      expect(writeResult.error).toBeDefined();
      expect(writeResult.error?.name).toBe("StorageTransactionCompleteError");
    });

    it("should fail writer operations after journal is aborted", () => {
      const { ok: writer } = journal.writer(space);
      expect(writer).toBeDefined();

      journal.abort("test abort");

      const newWriterResult = journal.writer(space);
      expect(newWriterResult.error).toBeDefined();
      expect(newWriterResult.error?.name).toBe("StorageTransactionAborted");

      const readResult = writer!.read({
        id: "test:aborted-write",
        type: "application/json",
        path: [],
      });
      expect(readResult.error).toBeDefined();
      expect(readResult.error?.name).toBe("StorageTransactionAborted");

      const writeResult = writer!.write({
        id: "test:aborted-write",
        type: "application/json",
        path: [],
      }, { test: "data" });
      expect(writeResult.error).toBeDefined();
      expect(writeResult.error?.name).toBe("StorageTransactionAborted");
    });
  });

  describe("Read-After-Write Consistency", () => {
    it("should maintain consistency for overlapping writes", () => {
      const { ok: writer } = journal.writer(space);
      const address = {
        id: "test:consistency",
        type: "application/json",
        path: [],
      } as const;

      // First write
      writer!.write(address, { a: 1, b: 2 });

      // Overlapping write
      writer!.write(address, { a: 10, c: 3 });

      // Should get the latest write
      const result = writer!.read(address);
      expect(result.ok?.value).toEqual({ a: 10, c: 3 });
    });

    it("should handle mixed reads from replica and writes", async () => {
      // Pre-populate replica
      const replica = storage.open(space).replica;
      await replica.commit({
        facts: [
          assert({
            the: "application/json",
            of: "user:consistency",
            is: { name: "Grace", age: 35 },
          }),
        ],
        claims: [],
      });

      const freshJournal = Journal.open(storage);
      const { ok: writer } = freshJournal.writer(space);
      const rootAddress = {
        id: "user:consistency",
        type: "application/json",
        path: [],
      } as const;
      const ageAddress = {
        ...rootAddress,
        path: ["age"],
      } as const;

      // First read from replica
      const initialRead = writer!.read(rootAddress);
      expect(initialRead.ok?.value).toEqual({ name: "Grace", age: 35 });

      // Write to nested path
      writer!.write(ageAddress, 36);

      // Read root again - should have updated age
      const finalRead = writer!.read(rootAddress);
      expect(finalRead.ok?.value).toEqual({ name: "Grace", age: 36 });
    });
  });

  describe("Error Handling", () => {
    it("should handle reading invalid nested paths", () => {
      const { ok: writer } = journal.writer(space);
      const rootAddress = {
        id: "test:error",
        type: "application/json",
        path: [],
      } as const;

      // Write a non-object value
      writer!.write(rootAddress, "not an object");

      // Try to read nested path
      const result = writer!.read({
        ...rootAddress,
        path: ["property"],
      });

      expect(result.error).toBeDefined();
      expect(result.error?.name).toBe("StorageTransactionInconsistent");
    });

    it("should handle writing to invalid nested paths", () => {
      const { ok: writer } = journal.writer(space);
      const rootAddress = {
        id: "test:write-error",
        type: "application/json",
        path: [],
      } as const;

      // Write a string
      writer!.write(rootAddress, "hello");

      // Try to write to nested path
      const result = writer!.write(
        { ...rootAddress, path: ["property"] },
        "value",
      );

      expect(result.error).toBeDefined();
      expect(result.error?.name).toBe("StorageTransactionInconsistent");
    });

    it("should handle deleting properties with undefined", () => {
      const { ok: writer } = journal.writer(space);
      const rootAddress = {
        id: "test:delete",
        type: "application/json",
        path: [],
      } as const;

      // Write object
      writer!.write(rootAddress, { name: "Henry", age: 40 });

      // Delete property
      writer!.write({ ...rootAddress, path: ["age"] }, undefined);

      // Read should not have the deleted property
      const result = writer!.read(rootAddress);
      expect(result.ok?.value).toEqual({ name: "Henry" });
    });
  });

  describe("History and Novelty Tracking", () => {
    it("should track detailed activity for reads and writes", () => {
      const { ok: writer } = journal.writer(space);
      const { ok: reader } = journal.reader(space);

      const address = {
        id: "user:activity",
        type: "application/json",
        path: [],
      } as const;

      // Initial activity should be empty
      const initialActivity = [...journal.activity()];
      expect(initialActivity).toHaveLength(0);

      // Write operation
      writer!.write(address, { name: "David" });

      // Read operation
      reader!.read(address);

      // Check activity log
      const activity = [...journal.activity()];
      expect(activity).toHaveLength(2);

      expect(activity[0]).toHaveProperty("write");
      expect(activity[0].write).toEqual({ ...address, space });

      expect(activity[1]).toHaveProperty("read");
      expect(activity[1].read).toEqual({ ...address, space });
    });

    it("should track read invariants in history", async () => {
      // Pre-populate replica
      const replica = storage.open(space).replica;
      await replica.commit({
        facts: [
          assert({
            the: "application/json",
            of: "user:history",
            is: { status: "active" },
          }),
        ],
        claims: [],
      });

      const freshJournal = Journal.open(storage);
      const { ok: reader } = freshJournal.reader(space);
      const address = {
        id: "user:history",
        type: "application/json",
        path: [],
      } as const;

      // First read should capture invariant
      const result1 = reader!.read(address);
      expect(result1.ok?.value).toEqual({ status: "active" });

      const historyEntries = [...freshJournal.history(space)];
      expect(historyEntries).toHaveLength(1);
      expect(historyEntries[0].address).toEqual(address);
      expect(historyEntries[0].value).toEqual({ status: "active" });

      // Second read should use history
      const result2 = reader!.read(address);
      expect(result2.ok?.value).toEqual({ status: "active" });
      expect([...freshJournal.history(space)]).toHaveLength(1);
    });

    it("should capture original replica read in history, not merged result", async () => {
      // Pre-populate replica
      const replica = storage.open(space).replica;
      await replica.commit({
        facts: [
          assert({
            the: "application/json",
            of: "user:validation",
            is: { name: "Original", count: 10 },
          }),
        ],
        claims: [],
      });

      const freshJournal = Journal.open(storage);
      const { ok: writer } = freshJournal.writer(space);
      const rootAddress = {
        id: "user:validation",
        type: "application/json",
        path: [],
      } as const;

      // Write some changes (creates novelty)
      writer!.write({ ...rootAddress, path: ["name"] }, "Modified");
      writer!.write({ ...rootAddress, path: ["count"] }, 20);

      // Read from replica (should return merged result but capture original in history)
      const readResult = writer!.read(rootAddress);
      expect(readResult.ok?.value).toEqual({
        name: "Modified",
        count: 20,
      });

      // History should capture the ORIGINAL replica read, not the merged result
      const historyEntries = [...freshJournal.history(space)];
      expect(historyEntries).toHaveLength(1);
      expect(historyEntries[0].value).toEqual({
        name: "Original", // Should be original value from replica
        count: 10, // Should be original value from replica
      });
    });
  });

  describe("Edge Cases", () => {
    it("should handle empty paths correctly", () => {
      const { ok: writer } = journal.writer(space);
      const address = {
        id: "test:empty-path",
        type: "application/json",
        path: [],
      } as const;

      writer!.write(address, [1, 2, 3]);
      const result = writer!.read(address);
      expect(result.ok?.value).toEqual([1, 2, 3]);
    });

    it("should handle array index paths", () => {
      const { ok: writer } = journal.writer(space);
      const rootAddress = {
        id: "test:array",
        type: "application/json",
        path: [],
      } as const;

      writer!.write(rootAddress, { items: ["a", "b", "c"] });
      writer!.write({ ...rootAddress, path: ["items", "1"] }, "B");

      const result = writer!.read(rootAddress);
      expect(result.ok?.value).toEqual({ items: ["a", "B", "c"] });
    });

    it("should handle numeric string paths", () => {
      const { ok: writer } = journal.writer(space);
      const rootAddress = {
        id: "test:numeric",
        type: "application/json",
        path: [],
      } as const;

      writer!.write(rootAddress, { "123": "numeric key" });
      const result = writer!.read({ ...rootAddress, path: ["123"] });
      expect(result.ok?.value).toBe("numeric key");
    });
  });
});
