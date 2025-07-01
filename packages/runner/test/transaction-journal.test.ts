import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { TransactionJournal } from "../src/storage/cache.ts";

const signer = await Identity.fromPassphrase("transaction journal test");
const space = signer.did();

describe("TransactionJournal", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let journal: TransactionJournal;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    journal = new TransactionJournal(storageManager);
  });

  afterEach(async () => {
    await storageManager?.close();
  });

  describe("Basic Lifecycle", () => {
    it("should start in edit state", () => {
      const state = journal.state();
      expect(state.ok).toBeDefined();
      expect(state.ok?.edit).toBe(journal);
    });

    it("should create reader for a space", () => {
      const result = journal.reader(space);
      expect(result.ok).toBeDefined();
      expect(result.ok?.did()).toBe(space);
    });

    it("should return same reader instance for same space", () => {
      const reader1 = journal.reader(space);
      const reader2 = journal.reader(space);

      expect(reader1.ok).toBe(reader2.ok);
    });

    it("should abort transaction", () => {
      const result = journal.abort();
      expect(result.ok).toBeDefined();

      const state = journal.state();
      expect(state.error).toBeDefined();
      expect(state.error?.name).toBe("StorageTransactionAborted");
    });
  });

  describe("Reader/Writer Management", () => {
    it("should create different readers for different spaces", async () => {
      const signer2 = await Identity.fromPassphrase(
        "transaction journal test 2",
      );
      const space2 = signer2.did();

      const reader1 = journal.reader(space);
      const reader2 = journal.reader(space2);

      expect(reader1.ok).toBeDefined();
      expect(reader2.ok).toBeDefined();
      expect(reader1.ok).not.toBe(reader2.ok);
      expect(reader1.ok?.did()).toBe(space);
      expect(reader2.ok?.did()).toBe(space2);
    });

    it("should create writer for a space", () => {
      const result = journal.writer(space);
      expect(result.ok).toBeDefined();
      expect(result.ok?.did()).toBe(space);
    });

    it("should return same writer instance for same space", () => {
      const writer1 = journal.writer(space);
      const writer2 = journal.writer(space);

      expect(writer1.ok).toBe(writer2.ok);
    });

    it("should allow writers for different spaces", async () => {
      const signer2 = await Identity.fromPassphrase(
        "transaction journal test 2",
      );
      const space2 = signer2.did();

      const writer1 = journal.writer(space);
      expect(writer1.ok).toBeDefined();

      const writer2 = journal.writer(space2);
      expect(writer2.ok).toBeDefined();
      expect(writer1.ok).not.toBe(writer2.ok);
    });
  });

  describe("Read/Write Operations", () => {
    it("should perform basic read operation and capture history", () => {
      const reader = journal.reader(space);
      expect(reader.ok).toBeDefined();

      const address = {
        id: "user:1",
        type: "application/json",
        path: [],
      } as const;

      const result = reader.ok!.read(address);
      expect(result.ok).toBeDefined();
      expect(result.ok?.value).toBeUndefined(); // New entity should be undefined

      // Check that read invariant was captured in history
      const history = journal.history(space);
      const captured = history.get(address);
      expect(captured).toBeDefined();
      expect(captured?.value).toBeUndefined();
    });

    it("should perform basic write operation and capture novelty", () => {
      const writer = journal.writer(space);
      expect(writer.ok).toBeDefined();

      const address = {
        id: "user:1",
        type: "application/json",
        path: [],
      } as const;
      const value = { name: "Alice", age: 25 };

      const result = writer.ok!.write(address, value);
      expect(result.ok).toBeDefined();
      expect(result.ok?.value).toEqual(value);

      // Check that write invariant was captured in novelty
      const novelty = journal.novelty(space);
      const captured = novelty.get(address);
      expect(captured).toBeDefined();
      expect(captured?.value).toEqual(value);
    });

    it("should read written value from same transaction", () => {
      const writer = journal.writer(space);
      const reader = journal.reader(space);

      const address = {
        id: "user:1",
        type: "application/json",
        path: [],
      } as const;
      const value = { name: "Bob", age: 30 };

      // Write value
      const writeResult = writer.ok!.write(address, value);
      expect(writeResult.ok?.value).toEqual(value);

      // Read same address should return written value
      const readResult = reader.ok!.read(address);
      expect(readResult.ok?.value).toEqual(value);
    });

    it("should read nested path from written object", () => {
      const writer = journal.writer(space);
      const reader = journal.reader(space);

      const rootAddress = {
        id: "user:1",
        type: "application/json",
        path: [],
      } as const;
      const nestedAddress = {
        id: "user:1",
        type: "application/json",
        path: ["name"],
      } as const;
      const value = { name: "Charlie", age: 35 };

      // Write root object
      writer.ok!.write(rootAddress, value);

      // Read nested path
      const readResult = reader.ok!.read(nestedAddress);
      expect(readResult.ok?.value).toBe("Charlie");
    });

    it("should log activity for reads and writes", () => {
      const writer = journal.writer(space);
      const reader = journal.reader(space);

      const address = {
        id: "user:1",
        type: "application/json",
        path: [],
      } as const;

      // Initial activity should be empty
      const initialActivity = [...journal.activity()];
      expect(initialActivity).toHaveLength(0);

      // Write operation
      writer.ok!.write(address, { name: "David" });

      // Read operation  
      reader.ok!.read(address);

      // Check activity log
      const activity = [...journal.activity()];
      expect(activity).toHaveLength(2);
      
      expect(activity[0]).toHaveProperty("write");
      expect(activity[0].write).toEqual({ ...address, space });
      
      expect(activity[1]).toHaveProperty("read");
      expect(activity[1].read).toEqual({ ...address, space });
    });
  });

  describe("Transaction State Management", () => {
    it("should provide access to history and novelty", () => {
      const writer = journal.writer(space);
      const reader = journal.reader(space);

      const address = {
        id: "user:1",
        type: "application/json",
        path: [],
      } as const;

      // Perform read and write operations
      reader.ok!.read(address);
      writer.ok!.write(address, { name: "Test" });

      // Check history contains read invariant
      const history = journal.history(space);
      expect([...history]).toHaveLength(1);

      // Check novelty contains write invariant
      const novelty = journal.novelty(space);
      expect([...novelty]).toHaveLength(1);
    });

    it("should close transaction and transition to pending state", () => {
      const address = {
        id: "user:1",
        type: "application/json",
        path: [],
      } as const;

      // Make some changes
      const writer = journal.writer(space);
      writer.ok!.write(address, { name: "Test" });

      // Close transaction
      const result = journal.close();
      expect(result.ok).toBeDefined();

      // State should now be pending
      const state = journal.state();
      expect(state.ok?.pending).toBe(journal);
      expect(state.ok?.edit).toBeUndefined();
    });

    it("should fail operations after transaction is closed", () => {
      // Close transaction
      journal.close();

      // Attempting to create new readers/writers should fail
      const readerResult = journal.reader(space);
      expect(readerResult.error).toBeDefined();
      expect(readerResult.error?.name).toBe("StorageTransactionCompleteError");

      const writerResult = journal.writer(space);
      expect(writerResult.error).toBeDefined();
      expect(writerResult.error?.name).toBe("StorageTransactionCompleteError");
    });

    it("should fail operations after transaction is aborted", () => {
      // Abort transaction
      journal.abort();

      // Attempting to create new readers/writers should fail
      const readerResult = journal.reader(space);
      expect(readerResult.error).toBeDefined();
      expect(readerResult.error?.name).toBe("StorageTransactionAborted");

      const writerResult = journal.writer(space);
      expect(writerResult.error).toBeDefined();
      expect(writerResult.error?.name).toBe("StorageTransactionAborted");
    });
  });

  describe("Error Handling", () => {
    it("should handle reading invalid nested paths", () => {
      const reader = journal.reader(space);

      // Write a string value
      const writer = journal.writer(space);
      const rootAddress = {
        id: "user:1",
        type: "application/json",
        path: [],
      } as const;
      writer.ok!.write(rootAddress, "not an object");

      // Try to read a property from the string
      const nestedAddress = {
        id: "user:1",
        type: "application/json",
        path: ["property"],
      } as const;

      const result = reader.ok!.read(nestedAddress);
      expect(result.error).toBeDefined();
      expect(result.error?.name).toBe("NotFoundError");
    });

    it("should handle writing to invalid nested paths", () => {
      const writer = journal.writer(space);

      // Write a string value first
      const rootAddress = {
        id: "user:1",
        type: "application/json",
        path: [],
      } as const;
      writer.ok!.write(rootAddress, "not an object");

      // Try to write a property to the string
      const nestedAddress = {
        id: "user:1",
        type: "application/json",
        path: ["property"],
      } as const;

      const result = writer.ok!.write(nestedAddress, "value");
      expect(result.error).toBeDefined();
      expect(result.error?.name).toBe("NotFoundError");
    });

    it("should handle property deletion with undefined", () => {
      const writer = journal.writer(space);
      const reader = journal.reader(space);

      const rootAddress = {
        id: "user:1",
        type: "application/json",
        path: [],
      } as const;
      const propAddress = {
        id: "user:1",
        type: "application/json",
        path: ["name"],
      } as const;

      // Write an object with a property
      writer.ok!.write(rootAddress, { name: "Alice", age: 25 });

      // Delete the property by writing undefined
      const deleteResult = writer.ok!.write(propAddress, undefined);
      expect(deleteResult.ok).toBeDefined();

      // Read the object - should not have the deleted property
      const readResult = reader.ok!.read(rootAddress);
      expect(readResult.ok?.value).toEqual({ age: 25 });
    });
  });
});
