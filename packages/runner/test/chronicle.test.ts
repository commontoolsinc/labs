import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import {
  StorageManager,
  TransactionJournal,
} from "@commontools/runner/storage/cache.deno";
import * as Chronicle from "../src/storage/transaction/chronicle.ts";
import { assert } from "@commontools/memory/fact";

const signer = await Identity.fromPassphrase("chronicle test");
const space = signer.did();

describe("Chronicle", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let journal: TransactionJournal;
  let replica: any;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    journal = new TransactionJournal(storageManager);
    // Get replica through journal reader
    replica = journal.reader(space).ok!.replica;
  });

  afterEach(async () => {
    await storageManager?.close();
  });

  describe("Basic Operations", () => {
    it("should return the replica's DID", () => {
      const chronicle = Chronicle.open(replica);
      expect(chronicle.did()).toBe(space);
    });

    it("should debug nested write and read", () => {
      const chronicle = Chronicle.open(replica);
      const rootAddress = {
        id: "debug:2",
        type: "application/json",
        path: [],
      } as const;
      const nestedAddress = {
        id: "debug:2",
        type: "application/json",
        path: ["profile", "name"],
      } as const;
      
      // Write root
      const rootWrite = chronicle.write(rootAddress, {
        profile: { name: "Bob", bio: "Developer" },
        posts: [],
      });
      console.log("Root write result:", rootWrite);
      
      // Write nested
      const nestedWrite = chronicle.write(nestedAddress, "Robert");
      console.log("Nested write result:", nestedWrite);
      
      // Debug novelty state
      console.log("Novelty entries:", [...chronicle.novelty()].map(n => ({
        path: n.address.path,
        value: n.value
      })));
      
      // Read root
      const rootRead = chronicle.read(rootAddress);
      console.log("Root read result:", rootRead);
      console.log("Root read value:", rootRead.ok?.value);
      
      expect(rootRead.ok?.value).toBeDefined();
    });

    it("should write and read a simple value", () => {
      const chronicle = Chronicle.open(replica);
      const address = {
        id: "test:1",
        type: "application/json",
        path: [],
      } as const;
      const value = { name: "Alice", age: 30 };

      // Write
      const writeResult = chronicle.write(address, value);
      expect(writeResult.ok).toBeDefined();
      expect(writeResult.ok?.value).toEqual(value);

      // Read
      const readResult = chronicle.read(address);
      expect(readResult.ok).toBeDefined();
      expect(readResult.ok?.value).toEqual(value);
    });

    it("should read undefined for non-existent entity", () => {
      const chronicle = Chronicle.open(replica);
      const address = {
        id: "test:nonexistent",
        type: "application/json",
        path: [],
      } as const;

      const result = chronicle.read(address);
      expect(result.ok).toBeDefined();
      expect(result.ok?.value).toBeUndefined();
    });

    it("should handle nested path writes and reads", () => {
      const chronicle = Chronicle.open(replica);
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
      chronicle.write(rootAddress, {
        profile: { name: "Bob", bio: "Developer" },
        posts: [],
      });

      // Write to nested path
      chronicle.write(nestedAddress, "Robert");

      // Read nested path
      const nestedResult = chronicle.read(nestedAddress);
      expect(nestedResult.ok?.value).toBe("Robert");

      // Read root should have the updated nested value
      const rootResult = chronicle.read(rootAddress);
      expect(rootResult.ok?.value).toEqual({
        profile: { name: "Robert", bio: "Developer" },
        posts: [],
      });
    });
  });

  describe("Reading from Pre-populated Replica", () => {
    it("should read existing data from replica", async () => {
      // Pre-populate replica
      const testData = { name: "Charlie", age: 25 };
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

      // Create new chronicle and read
      const freshChronicle = Chronicle.open(replica);
      const address = {
        id: "user:1",
        type: "application/json",
        path: [],
      } as const;

      const result = freshChronicle.read(address);
      expect(result.ok).toBeDefined();
      expect(result.ok?.value).toEqual(testData);
    });

    it("should read nested paths from replica data", async () => {
      // Pre-populate replica
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

      const freshChronicle = Chronicle.open(replica);
      const nestedAddress = {
        id: "user:2",
        type: "application/json",
        path: ["profile", "settings", "theme"],
      } as const;

      const result = freshChronicle.read(nestedAddress);
      expect(result.ok?.value).toBe("dark");
    });
  });

  describe("Rebase Functionality", () => {
    it("should rebase child writes onto parent invariant", () => {
      const chronicle = Chronicle.open(replica);
      const rootAddress = {
        id: "test:3",
        type: "application/json",
        path: [],
      } as const;

      // Write root
      chronicle.write(rootAddress, { name: "Eve", age: 28 });

      // Write nested paths
      chronicle.write(
        { ...rootAddress, path: ["age"] },
        29,
      );
      chronicle.write(
        { ...rootAddress, path: ["location"] },
        "NYC",
      );

      // Read root should merge all writes
      const result = chronicle.read(rootAddress);
      expect(result.ok?.value).toEqual({
        name: "Eve",
        age: 29,
        location: "NYC",
      });
    });

    it("should accumulate multiple child writes in rebase", async () => {
      const chronicle = Chronicle.open(replica);
      // Pre-populate replica with initial data
      await replica.commit({
        facts: [
          assert({
            the: "application/json",
            of: "test:rebase-bug",
            is: {
              a: 1,
              b: { x: 10, y: 20 },
              c: 3,
            },
          }),
        ],
        claims: [],
      });

      const freshChronicle = Chronicle.open(replica);
      const rootAddress = {
        id: "test:rebase-bug",
        type: "application/json",
        path: [],
      } as const;

      // First read to create history entry
      const initialRead = freshChronicle.read(rootAddress);
      expect(initialRead.ok?.value).toEqual({
        a: 1,
        b: { x: 10, y: 20 },
        c: 3,
      });

      // Write multiple nested paths that should all be accumulated
      freshChronicle.write({ ...rootAddress, path: ["a"] }, 100);
      freshChronicle.write({ ...rootAddress, path: ["b", "x"] }, 200);
      freshChronicle.write({ ...rootAddress, path: ["b", "z"] }, 300);
      freshChronicle.write({ ...rootAddress, path: ["d"] }, 400);

      // Read root again - this should trigger rebase and accumulate all changes
      const result = freshChronicle.read(rootAddress);
      expect(result.ok?.value).toEqual({
        a: 100,
        b: { x: 200, y: 20, z: 300 },
        c: 3,
        d: 400,
      });
    });

    it("should handle deep nested rebasing", () => {
      const chronicle = Chronicle.open(replica);
      const rootAddress = {
        id: "test:4",
        type: "application/json",
        path: [],
      } as const;

      // Write root structure
      chronicle.write(rootAddress, {
        user: {
          profile: {
            name: "Frank",
            settings: { theme: "light", notifications: true },
          },
        },
      });

      // Write deeply nested value
      chronicle.write(
        { ...rootAddress, path: ["user", "profile", "settings", "theme"] },
        "dark",
      );

      // Read intermediate path
      const profileResult = chronicle.read({
        ...rootAddress,
        path: ["user", "profile"],
      });
      expect(profileResult.ok?.value).toEqual({
        name: "Frank",
        settings: { theme: "dark", notifications: true },
      });
    });
  });

  describe("Read-After-Write Consistency", () => {
    it("should maintain consistency for overlapping writes", () => {
      const chronicle = Chronicle.open(replica);
      const address = {
        id: "test:5",
        type: "application/json",
        path: [],
      } as const;

      // First write
      chronicle.write(address, { a: 1, b: 2 });

      // Overlapping write
      chronicle.write(address, { a: 10, c: 3 });

      // Should get the latest write
      const result = chronicle.read(address);
      expect(result.ok?.value).toEqual({ a: 10, c: 3 });
    });

    it("should handle mixed reads from replica and writes", async () => {
      // Pre-populate replica
      await replica.commit({
        facts: [
          assert({
            the: "application/json",
            of: "user:3",
            is: { name: "Grace", age: 35 },
          }),
        ],
        claims: [],
      });

      const freshChronicle = Chronicle.open(replica);
      const rootAddress = {
        id: "user:3",
        type: "application/json",
        path: [],
      } as const;
      const ageAddress = {
        ...rootAddress,
        path: ["age"],
      } as const;

      // First read from replica
      const initialRead = freshChronicle.read(rootAddress);
      expect(initialRead.ok?.value).toEqual({ name: "Grace", age: 35 });

      // Write to nested path
      freshChronicle.write(ageAddress, 36);

      // Read root again - should have updated age
      const finalRead = freshChronicle.read(rootAddress);
      expect(finalRead.ok?.value).toEqual({ name: "Grace", age: 36 });
    });

    it("should rebase novelty writes when reading from replica", async () => {
      // Pre-populate replica
      await replica.commit({
        facts: [
          assert({
            the: "application/json",
            of: "test:replica-rebase",
            is: {
              name: "Original",
              settings: { theme: "light", lang: "en" },
              count: 0,
            },
          }),
        ],
        claims: [],
      });

      const freshChronicle = Chronicle.open(replica);
      const rootAddress = {
        id: "test:replica-rebase",
        type: "application/json",
        path: [],
      } as const;

      // Write multiple nested paths (creates novelty)
      freshChronicle.write({ ...rootAddress, path: ["name"] }, "Updated");
      freshChronicle.write(
        { ...rootAddress, path: ["settings", "theme"] },
        "dark",
      );
      freshChronicle.write({
        ...rootAddress,
        path: ["settings", "notifications"],
      }, true);
      freshChronicle.write({ ...rootAddress, path: ["count"] }, 42);

      // Read root from replica - should apply all novelty writes
      const result = freshChronicle.read(rootAddress);
      expect(result.ok?.value).toEqual({
        name: "Updated",
        settings: { theme: "dark", lang: "en", notifications: true },
        count: 42,
      });
    });
  });

  describe("Error Handling", () => {
    it("should handle reading invalid nested paths", () => {
      const chronicle = Chronicle.open(replica);
      const rootAddress = {
        id: "test:6",
        type: "application/json",
        path: [],
      } as const;

      // Write a non-object value
      chronicle.write(rootAddress, "not an object");

      // Try to read nested path
      const result = chronicle.read({
        ...rootAddress,
        path: ["property"],
      });

      expect(result.error).toBeDefined();
      expect(result.error?.name).toBe("NotFoundError");
    });

    it("should handle writing to invalid nested paths", () => {
      const chronicle = Chronicle.open(replica);
      const rootAddress = {
        id: "test:7",
        type: "application/json",
        path: [],
      } as const;

      // Write a string
      chronicle.write(rootAddress, "hello");

      // Try to write to nested path
      const result = chronicle.write(
        { ...rootAddress, path: ["property"] },
        "value",
      );

      expect(result.error).toBeDefined();
      expect(result.error?.name).toBe("NotFoundError");
    });

    it("should handle deleting properties with undefined", () => {
      const chronicle = Chronicle.open(replica);
      const rootAddress = {
        id: "test:8",
        type: "application/json",
        path: [],
      } as const;

      // Write object
      chronicle.write(rootAddress, { name: "Henry", age: 40 });

      // Delete property
      chronicle.write({ ...rootAddress, path: ["age"] }, undefined);

      // Read should not have the deleted property
      const result = chronicle.read(rootAddress);
      expect(result.ok?.value).toEqual({ name: "Henry" });
    });
  });

  describe("History and Novelty Tracking", () => {
    it("should track read invariants in history", async () => {
      // Pre-populate replica
      await replica.commit({
        facts: [
          assert({
            the: "application/json",
            of: "user:4",
            is: { status: "active" },
          }),
        ],
        claims: [],
      });

      const freshChronicle = Chronicle.open(replica);
      const address = {
        id: "user:4",
        type: "application/json",
        path: [],
      } as const;

      const expected = {
        address,
        value: { status: "active" },
      };

      // First read should capture invariant
      const result1 = freshChronicle.read(address);
      expect(result1.ok?.value).toEqual({ status: "active" });
      expect([...freshChronicle.history()]).toEqual([expected]);

      // Second read should use history
      const result2 = freshChronicle.read(address);
      expect(result2.ok?.value).toEqual({ status: "active" });
      expect([...freshChronicle.history()]).toEqual([expected]);
    });

    it("should expose novelty and history through iterators", async () => {
      // Pre-populate replica
      await replica.commit({
        facts: [
          assert({
            the: "application/json",
            of: "user:iterators",
            is: { name: "Alice", age: 30 },
          }),
        ],
        claims: [],
      });

      const freshChronicle = Chronicle.open(replica);
      const rootAddress = {
        id: "user:iterators",
        type: "application/json",
        path: [],
      } as const;

      // Initially, both should be empty
      expect([...freshChronicle.novelty()]).toEqual([]);
      expect([...freshChronicle.history()]).toEqual([]);

      // Write some data (creates novelty)
      freshChronicle.write({ ...rootAddress, path: ["name"] }, "Bob");
      freshChronicle.write({ ...rootAddress, path: ["age"] }, 35);
      freshChronicle.write({ ...rootAddress, path: ["city"] }, "NYC");

      // Check novelty contains our writes
      const noveltyEntries = [...freshChronicle.novelty()];
      expect(noveltyEntries).toHaveLength(3);
      expect(noveltyEntries.map((n) => n.address.path)).toEqual([
        ["name"],
        ["age"],
        ["city"],
      ]);
      expect(noveltyEntries.map((n) => n.value)).toEqual(["Bob", 35, "NYC"]);

      // History should still be empty (no reads yet)
      expect([...freshChronicle.history()]).toEqual([]);

      // Read from replica (creates history)
      const readResult = freshChronicle.read(rootAddress);
      expect(readResult.ok?.value).toEqual({
        name: "Bob",
        age: 35,
        city: "NYC",
      });

      // Now history should contain the read invariant
      const historyEntries = [...freshChronicle.history()];
      expect(historyEntries).toHaveLength(1);
      expect(historyEntries[0].address).toEqual(rootAddress);

      // The history should capture what was actually read from replica (original values)
      expect(historyEntries[0].value).toEqual({
        name: "Alice", // Original value from replica
        age: 30, // Original value from replica
      });
    });

    it("should capture original replica read in history, not merged result", async () => {
      // Pre-populate replica
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

      const freshChronicle = Chronicle.open(replica);
      const rootAddress = {
        id: "user:validation",
        type: "application/json",
        path: [],
      } as const;

      // Write some changes (creates novelty)
      freshChronicle.write({ ...rootAddress, path: ["name"] }, "Modified");
      freshChronicle.write({ ...rootAddress, path: ["count"] }, 20);

      // Read from replica (should return merged result but capture original in history)
      const readResult = freshChronicle.read(rootAddress);
      expect(readResult.ok?.value).toEqual({
        name: "Modified",
        count: 20,
      });

      // History should capture the ORIGINAL replica read, not the merged result
      // This is critical for validation - we need to track what was actually read from storage
      const historyEntries = [...freshChronicle.history()];
      expect(historyEntries).toHaveLength(1);

      // BUG: Currently this captures the merged result instead of original
      // The history invariant should reflect what was read from replica (before rebasing)
      expect(historyEntries[0].value).toEqual({
        name: "Original", // Should be original value from replica
        count: 10, // Should be original value from replica
      });
    });

    it("should not capture computed values in history", async () => {
      // Pre-populate replica
      await replica.commit({
        facts: [
          assert({
            the: "application/json",
            of: "user:5",
            is: { name: "Ivy", level: 1 },
          }),
        ],
        claims: [],
      });

      const freshChronicle = Chronicle.open(replica);
      const rootAddress = {
        id: "user:5",
        type: "application/json",
        path: [],
      } as const;

      // Read from replica
      freshChronicle.read(rootAddress);

      // Write to nested path
      freshChronicle.write({ ...rootAddress, path: ["level"] }, 2);

      // Read root (will compute merged value)
      const result = freshChronicle.read(rootAddress);
      expect(result.ok?.value).toEqual({ name: "Ivy", level: 2 });

      // Write another nested value
      freshChronicle.write({ ...rootAddress, path: ["level"] }, 3);

      // Read again should compute new merged value
      const result2 = freshChronicle.read(rootAddress);
      expect(result2.ok?.value).toEqual({ name: "Ivy", level: 3 });
    });
  });

  describe("Edge Cases", () => {
    it("should handle empty paths correctly", () => {
      const chronicle = Chronicle.open(replica);
      const address = {
        id: "test:9",
        type: "application/json",
        path: [],
      } as const;

      chronicle.write(address, [1, 2, 3]);
      const result = chronicle.read(address);
      expect(result.ok?.value).toEqual([1, 2, 3]);
    });

    it("should handle array index paths", () => {
      const chronicle = Chronicle.open(replica);
      const rootAddress = {
        id: "test:10",
        type: "application/json",
        path: [],
      } as const;

      chronicle.write(rootAddress, { items: ["a", "b", "c"] });
      chronicle.write({ ...rootAddress, path: ["items", "1"] }, "B");

      const result = chronicle.read(rootAddress);
      expect(result.ok?.value).toEqual({ items: ["a", "B", "c"] });
    });

    it("should handle numeric string paths", () => {
      const chronicle = Chronicle.open(replica);
      const rootAddress = {
        id: "test:11",
        type: "application/json",
        path: [],
      } as const;

      chronicle.write(rootAddress, { "123": "numeric key" });
      const result = chronicle.read({ ...rootAddress, path: ["123"] });
      expect(result.ok?.value).toBe("numeric key");
    });
  });
});
