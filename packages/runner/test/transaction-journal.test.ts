import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import {
  StorageManager,
  TransactionJournal,
} from "@commontools/runner/storage/cache.deno";
import { assert } from "@commontools/memory/fact";

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

  describe("Read After Write Bug Investigation", () => {
    it("should read written value from same transaction - simple case", () => {
      const writer = journal.writer(space);
      const reader = journal.reader(space);

      const address = {
        id: "test:1",
        type: "application/json",
        path: [],
      } as const;

      // Write a value
      const writeResult = writer.ok!.write(address, { name: "Alice" });
      expect(writeResult.ok?.value).toEqual({ name: "Alice" });

      // Read same address should return written value  
      const readResult = reader.ok!.read(address);
      expect(readResult.ok?.value).toEqual({ name: "Alice" });
    });

    it("should read modified nested value after partial write", () => {
      const writer = journal.writer(space);
      const reader = journal.reader(space);

      const rootAddress = {
        id: "test:2", 
        type: "application/json",
        path: [],
      } as const;

      const nameAddress = {
        id: "test:2",
        type: "application/json", 
        path: ["name"],
      } as const;

      // First write a complete object
      writer.ok!.write(rootAddress, { name: "Bob", age: 30 });

      // Then write to a nested path
      writer.ok!.write(nameAddress, "Alice");

      // Read root should return updated object
      const readResult = reader.ok!.read(rootAddress);
      expect(readResult.ok?.value).toEqual({ name: "Alice", age: 30 });
    });
  });

  describe("Reading from Pre-populated Replicas", () => {
    it("should read existing data from replica and capture invariants", async () => {
      // First, populate the replica with some data using the storage provider

      const rootAddress = {
        id: "user:1",
        type: "application/json",
        path: [],
      } as const;

      const replica = journal.reader(space).ok!.replica;

      // Write some initial data to the replica
      const initialData = {
        name: "Alice",
        age: 30,
        profile: { bio: "Developer" },
      };

      await replica.commit({
        facts: [
          assert({
            the: "application/json",
            of: "user:1",
            is: initialData,
          }),
        ],
        claims: [],
      });

      // Now create a new journal and read from the populated replica
      const reader = journal.reader(space);
      const result = reader.ok!.read(rootAddress);

      // Should read the existing data
      expect(result.ok).toBeDefined();
      expect(result.ok?.value).toEqual(initialData);

      // Check that read invariant was captured in history
      const history = journal.history(space);
      const captured = history.get(rootAddress);
      expect(captured).toBeDefined();
      expect(captured?.value).toEqual(initialData);
    });

    it("should read nested paths from existing replica data", async () => {
      // Populate replica with nested data
      const replica = journal.reader(space).ok!.replica;
      const userData = {
        profile: {
          name: "Bob",
          settings: { theme: "dark", notifications: true },
        },
        posts: [{ id: 1, title: "Hello World" }],
      };

      await replica.commit({
        facts: [
          assert({
            the: "application/json",
            of: "user:2",
            is: userData,
          }),
        ],
        claims: [],
      });

      // Read nested paths
      const reader = journal.reader(space);

      const nameAddress = {
        id: "user:2",
        type: "application/json",
        path: ["profile", "name"],
      } as const;

      const themeAddress = {
        id: "user:2",
        type: "application/json",
        path: ["profile", "settings", "theme"],
      } as const;

      const firstPostAddress = {
        id: "user:2",
        type: "application/json",
        path: ["posts", "0"],
      } as const;

      // Read each nested path
      const nameResult = reader.ok!.read(nameAddress);
      const themeResult = reader.ok!.read(themeAddress);
      const postResult = reader.ok!.read(firstPostAddress);

      expect(nameResult.ok?.value).toBe("Bob");
      expect(themeResult.ok?.value).toBe("dark");
      expect(postResult.ok?.value).toEqual({ id: 1, title: "Hello World" });

      // Check that all reads were captured as invariants
      const history = journal.history(space);
      expect([...history]).toHaveLength(3);
    });

    it("should handle mixed reads from replica and writes in same transaction", async () => {
      // Populate replica with initial data
      const replica = journal.reader(space).ok!.replica;
      const initialData = { name: "Charlie", age: 25 };

      await replica.commit({
        facts: [
          assert({
            the: "application/json",
            of: "user:3",
            is: initialData,
          }),
        ],
        claims: [],
      });

      // Create a fresh journal for this test to read from the populated replica
      const freshJournal = new TransactionJournal(storageManager);
      const reader = freshJournal.reader(space);
      const writer = freshJournal.writer(space);

      const rootAddress = {
        id: "user:3",
        type: "application/json",
        path: [],
      } as const;

      const ageAddress = {
        id: "user:3",
        type: "application/json",
        path: ["age"],
      } as const;

      // First read existing data (should capture invariant)
      const readResult = reader.ok!.read(rootAddress);
      expect(readResult.ok?.value).toEqual(initialData);

      // Then write to a nested path
      const writeResult = writer.ok!.write(ageAddress, 26);
      expect(writeResult.ok).toBeDefined();

      // Read the root again - should now return the modified data
      // This tests that reads after writes return the written value
      const readAfterWriteResult = reader.ok!.read(rootAddress);
      expect(readAfterWriteResult.ok?.value).toEqual({
        name: "Charlie",
        age: 26,
      });

      // Check that we have both history (from initial read) and novelty (from write)
      const history = freshJournal.history(space);
      const novelty = freshJournal.novelty(space);

      expect([...history]).toHaveLength(1);
      expect([...novelty]).toHaveLength(1);
    });

    it("should capture parent invariant when reading nested path from replica", async () => {
      // Populate replica
      const replica = journal.reader(space).ok!.replica;
      const userData = {
        settings: { theme: "light", language: "en" },
        preferences: { notifications: false },
      };

      await replica.commit({
        facts: [
          assert({
            the: "application/json",
            of: "user:4",
            is: userData,
          }),
        ],
        claims: [],
      });

      // Create a fresh journal to read from the populated replica
      const freshJournal = new TransactionJournal(storageManager);
      const reader = freshJournal.reader(space);
      const themeAddress = {
        id: "user:4",
        type: "application/json",
        path: ["settings", "theme"],
      } as const;

      const result = reader.ok!.read(themeAddress);
      expect(result.ok?.value).toBe("light");

      // The invariant should be captured at the exact path that was read
      const history = freshJournal.history(space);
      const captured = history.get(themeAddress);

      expect(captured).toBeDefined();
      // The captured invariant should correspond to the exact path read
      expect(captured?.value).toBe("light");
      expect(captured?.address.path).toEqual(["settings", "theme"]);
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
