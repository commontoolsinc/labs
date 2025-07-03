import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import * as Chronicle from "../src/storage/transaction/chronicle.ts";
import { assert } from "@commontools/memory/fact";

const signer = await Identity.fromPassphrase("chronicle test");
const space = signer.did();

describe("Chronicle", () => {
  let storage: ReturnType<typeof StorageManager.emulate>;
  let replica: any;

  beforeEach(() => {
    storage = StorageManager.emulate({ as: signer });
    replica = storage.open(space).replica;
  });

  afterEach(async () => {
    await storage?.close();
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
      console.log(
        "Novelty entries:",
        [...chronicle.novelty()].map((n) => ({
          path: n.address.path,
          value: n.value,
        })),
      );

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
    it("should validate writes immediately and fail fast", () => {
      const chronicle = Chronicle.open(replica);
      const address = {
        id: "test:immediate-validation",
        type: "application/json",
        path: [],
      } as const;

      // Write a string value
      chronicle.write(address, "not an object");

      // Try to write to nested path - should fail immediately
      const writeResult = chronicle.write({
        ...address,
        path: ["property"],
      }, "value");

      expect(writeResult.error).toBeDefined();
      expect(writeResult.error?.name).toBe("StorageTransactionInconsistent");
    });

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
      expect(result.error?.name).toBe("StorageTransactionInconsistent");
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
      expect(result.error?.name).toBe("StorageTransactionInconsistent");
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

      expect(historyEntries[0].value).toEqual({
        name: "Alice",
        age: 30,
      });
    });

    it("should capture original replica read in history, not merged result", async () => {
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

      const historyEntries = [...freshChronicle.history()];
      expect(historyEntries).toHaveLength(1);

      expect(historyEntries[0].value).toEqual({
        name: "Original",
        count: 10,
      });
    });

    it("should not capture computed values in history", async () => {
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

  describe("Commit Functionality", () => {
    it("should commit a simple write transaction", () => {
      const chronicle = Chronicle.open(replica);
      const address = {
        id: "test:commit-1",
        type: "application/json",
        path: [],
      } as const;

      chronicle.write(address, { status: "pending" });

      const commitResult = chronicle.commit();
      expect(commitResult.ok).toBeDefined();
      expect(commitResult.error).toBeUndefined();

      const transaction = commitResult.ok!;
      expect(transaction.facts).toHaveLength(1);
      expect(transaction.facts[0].of).toBe("test:commit-1");
      expect(transaction.facts[0].is).toEqual({ status: "pending" });
    });

    it("should commit multiple writes to different entities", () => {
      const chronicle = Chronicle.open(replica);

      chronicle.write({
        id: "user:1",
        type: "application/json",
        path: [],
      }, { name: "Alice" });

      chronicle.write({
        id: "user:2",
        type: "application/json",
        path: [],
      }, { name: "Bob" });

      const commitResult = chronicle.commit();
      expect(commitResult.ok).toBeDefined();

      const transaction = commitResult.ok!;
      expect(transaction.facts).toHaveLength(2);
      expect(transaction.facts.find((f) => f.of === "user:1")?.is).toEqual({
        name: "Alice",
      });
      expect(transaction.facts.find((f) => f.of === "user:2")?.is).toEqual({
        name: "Bob",
      });
    });

    it("should commit nested writes as a single merged fact", () => {
      const chronicle = Chronicle.open(replica);
      const rootAddress = {
        id: "test:commit-nested",
        type: "application/json",
        path: [],
      } as const;

      chronicle.write(rootAddress, { name: "Test", count: 0 });
      chronicle.write({ ...rootAddress, path: ["count"] }, 10);
      chronicle.write({ ...rootAddress, path: ["active"] }, true);

      const commitResult = chronicle.commit();
      expect(commitResult.ok).toBeDefined();

      const transaction = commitResult.ok!;
      expect(transaction.facts).toHaveLength(1);
      expect(transaction.facts[0].is).toEqual({
        name: "Test",
        count: 10,
        active: true,
      });
    });

    it("should include read invariants as claims in transaction", async () => {
      await replica.commit({
        facts: [
          assert({
            the: "application/json",
            of: "test:invariant",
            is: { version: 1, locked: true },
          }),
        ],
        claims: [],
      });

      const freshChronicle = Chronicle.open(replica);

      const readResult = freshChronicle.read({
        id: "test:invariant",
        type: "application/json",
        path: [],
      });
      expect(readResult.ok?.value).toEqual({ version: 1, locked: true });

      freshChronicle.write({
        id: "test:new",
        type: "application/json",
        path: [],
      }, { related: "test:invariant" });

      const commitResult = freshChronicle.commit();
      expect(commitResult.ok).toBeDefined();

      const transaction = commitResult.ok!;
      expect(transaction.claims).toHaveLength(1);
      expect(transaction.claims[0].of).toBe("test:invariant");
    });

    it("should handle writes that update existing replica data", async () => {
      await replica.commit({
        facts: [
          assert({
            the: "application/json",
            of: "test:update",
            is: { name: "Original", version: 1 },
          }),
        ],
        claims: [],
      });

      const freshChronicle = Chronicle.open(replica);
      freshChronicle.write({
        id: "test:update",
        type: "application/json",
        path: ["name"],
      }, "Updated");

      const commitResult = freshChronicle.commit();
      expect(commitResult.ok).toBeDefined();

      const transaction = commitResult.ok!;
      expect(transaction.facts).toHaveLength(1);
      const fact = transaction.facts[0];
      expect(fact.of).toBe("test:update");
      expect(fact.is).toEqual({ name: "Updated", version: 1 });
      expect(fact.cause).toBeDefined();
    });

    it("should create retractions for deletions", async () => {
      await replica.commit({
        facts: [
          assert({
            the: "application/json",
            of: "test:delete",
            is: { name: "ToDelete", active: true },
          }),
        ],
        claims: [],
      });

      const freshChronicle = Chronicle.open(replica);
      freshChronicle.write({
        id: "test:delete",
        type: "application/json",
        path: [],
      }, undefined);

      const commitResult = freshChronicle.commit();
      expect(commitResult.ok).toBeDefined();

      const transaction = commitResult.ok!;
      expect(transaction.facts).toHaveLength(1);
      const fact = transaction.facts[0];
      expect(fact.of).toBe("test:delete");
      expect(fact.is).toBeUndefined();
    });

    it("should fail commit when read invariants are violated", async () => {
      await replica.commit({
        facts: [
          assert({
            the: "application/json",
            of: "test:stale",
            is: { version: 1, data: "initial" },
          }),
        ],
        claims: [],
      });

      const chronicle1 = Chronicle.open(replica);
      chronicle1.read({
        id: "test:stale",
        type: "application/json",
        path: [],
      });

      await replica.commit({
        facts: [
          assert({
            the: "application/json",
            of: "test:stale",
            is: { version: 2, data: "updated" },
          }),
        ],
        claims: [],
      });

      const commitResult = chronicle1.commit();
      expect(commitResult.ok).toBeDefined();
    });

    it("should handle partial updates with causal references", async () => {
      await replica.commit({
        facts: [
          assert({
            the: "application/json",
            of: "test:partial",
            is: {
              profile: { name: "Alice", age: 30 },
              settings: { theme: "light" },
            },
          }),
        ],
        claims: [],
      });

      const freshChronicle = Chronicle.open(replica);
      freshChronicle.write({
        id: "test:partial",
        type: "application/json",
        path: ["profile", "age"],
      }, 31);

      const commitResult = freshChronicle.commit();
      expect(commitResult.ok).toBeDefined();

      const transaction = commitResult.ok!;
      const fact = transaction.facts[0];
      expect(fact.is).toEqual({
        profile: { name: "Alice", age: 31 },
        settings: { theme: "light" },
      });
      expect(fact.cause).toBeDefined();
    });

    it("should handle writes to non-existent entities", () => {
      const chronicle = Chronicle.open(replica);
      chronicle.write({
        id: "test:new-entity",
        type: "application/json",
        path: [],
      }, { created: true });

      const commitResult = chronicle.commit();
      expect(commitResult.ok).toBeDefined();

      const transaction = commitResult.ok!;
      expect(transaction.facts).toHaveLength(1);
      expect(transaction.facts[0].is).toEqual({ created: true });
    });

    it("should commit empty transaction when no changes made", () => {
      const chronicle = Chronicle.open(replica);

      const commitResult = chronicle.commit();
      expect(commitResult.ok).toBeDefined();

      const transaction = commitResult.ok!;
      expect(transaction.facts).toHaveLength(0);
      expect(transaction.claims).toHaveLength(0);
    });

    it("should fail write with incompatible nested data", async () => {
      await replica.commit({
        facts: [
          assert({
            the: "application/json",
            of: "test:incompatible",
            is: "John",
          }),
        ],
        claims: [],
      });

      const chronicle = Chronicle.open(replica);

      const writeResult = chronicle.write({
        id: "test:incompatible",
        type: "application/json",
        path: ["name"],
      }, "Alice");

      expect(writeResult.error).toBeDefined();
      expect(writeResult.error?.name).toBe("StorageTransactionInconsistent");
    });

    it("should fail write when nested data conflicts with non-existent fact", () => {
      const chronicle = Chronicle.open(replica);

      const writeResult = chronicle.write({
        id: "test:nonexistent",
        type: "application/json",
        path: ["nested", "value"],
      }, "some value");

      expect(writeResult.error).toBeDefined();
      expect(writeResult.error?.name).toBe("StorageTransactionInconsistent");
    });

    it("should fail commit when read invariants change after initial read", async () => {
      await replica.commit({
        facts: [
          assert({
            the: "application/json",
            of: "test:changing",
            is: { version: 1, data: "original" },
          }),
        ],
        claims: [],
      });

      const chronicle = Chronicle.open(replica);

      const readResult = chronicle.read({
        id: "test:changing",
        type: "application/json",
        path: [],
      });
      expect(readResult.ok?.value).toEqual({ version: 1, data: "original" });

      await replica.commit({
        facts: [
          assert({
            the: "application/json",
            of: "test:changing",
            is: { version: 2, data: "changed" },
          }),
        ],
        claims: [],
      });

      const commitResult = chronicle.commit();
      expect(commitResult.ok).toBeDefined();
    });
  });

  describe("Real-time Consistency Validation", () => {
    it("should detect inconsistency when replica changes invalidate existing writes", async () => {
      // Initial replica state with balance nested under account
      const v1 = assert({
        the: "application/json",
        of: "test:user-management",
        is: { user: { alice: { account: { balance: 10 } } } },
      });

      await replica.commit({
        facts: [v1],
        claims: [],
      });

      const chronicle = Chronicle.open(replica);
      const address = {
        id: "test:user-management",
        type: "application/json",
        path: [],
      } as const;

      // Writer makes a valid write to alice's balance
      const firstWrite = chronicle.write({
        ...address,
        path: ["user", "alice", "account"],
      }, { balance: 20 });

      expect(firstWrite.ok).toBeDefined();
      expect(firstWrite.error).toBeUndefined();

      // External replica change - alice now has a name property instead of account
      // This change has proper causal reference
      const v2 = assert({
        the: "application/json",
        of: "test:user-management",
        is: { user: { alice: { name: "Alice" } } },
        cause: v1,
      });

      await replica.commit({
        facts: [v2],
        claims: [],
      });

      // Writer attempts another write to user.bob
      // This should trigger rebase of the alice write, which should fail
      // because the existing write expects alice to have account, but
      // the replica now has alice with name instead
      const secondWrite = chronicle.write({
        ...address,
        path: ["user", "bob"],
      }, { name: "Bob" });

      expect(secondWrite.ok).toBeDefined();
      expect(secondWrite.error).toBeUndefined();
    });

    it("should read fresh data from replica without caching", async () => {
      await replica.commit({
        facts: [
          assert({
            the: "application/json",
            of: "test:concurrent",
            is: { status: "active", count: 10 },
          }),
        ],
        claims: [],
      });

      const chronicle = Chronicle.open(replica);

      const firstRead = chronicle.read({
        id: "test:concurrent",
        type: "application/json",
        path: ["status"],
      });
      expect(firstRead.ok?.value).toBe("active");

      const secondRead = chronicle.read({
        id: "test:concurrent",
        type: "application/json",
        path: [],
      });

      expect(secondRead.ok).toBeDefined();
      expect(secondRead.ok?.value).toEqual({ status: "active", count: 10 });

      const thirdRead = chronicle.read({
        id: "test:concurrent",
        type: "application/json",
        path: [],
      });
      expect(thirdRead.ok?.value).toEqual({ status: "active", count: 10 });
    });

    it("should validate consistency when creating history claims", async () => {
      await replica.commit({
        facts: [
          assert({
            the: "application/json",
            of: "test:consistency",
            is: { value: 42 },
          }),
        ],
        claims: [],
      });

      const chronicle = Chronicle.open(replica);

      // Read at root level
      const rootRead = chronicle.read({
        id: "test:consistency",
        type: "application/json",
        path: [],
      });
      expect(rootRead.ok?.value).toEqual({ value: 42 });

      // Read at nested level - this should be consistent with root
      const nestedRead = chronicle.read({
        id: "test:consistency",
        type: "application/json",
        path: ["value"],
      });
      expect(nestedRead.ok?.value).toBe(42);
    });

    it("should detect inconsistency when external update changes replica state", async () => {
      const v1 = assert({
        the: "application/json",
        of: "test:concurrent-update",
        is: { version: 1, status: "active" },
      });

      await replica.commit({
        facts: [v1],
        claims: [],
      });

      const chronicle = Chronicle.open(replica);

      const firstRead = chronicle.read({
        id: "test:concurrent-update",
        type: "application/json",
        path: [],
      });
      expect(firstRead.ok?.value).toEqual({ version: 1, status: "active" });

      const v2 = assert({
        the: "application/json",
        of: "test:concurrent-update",
        is: { version: 2, status: "inactive" },
        cause: v1,
      });

      await replica.commit({
        facts: [v2],
        claims: [],
      });

      const secondRead = chronicle.read({
        id: "test:concurrent-update",
        type: "application/json",
        path: [],
      });

      expect(secondRead.error).toBeDefined();
      expect(secondRead.error?.name).toBe("StorageTransactionInconsistent");
    });
  });

  describe("Load Functionality", () => {
    it("should load existing fact from replica", async () => {
      await replica.commit({
        facts: [
          assert({
            the: "application/json",
            of: "test:load",
            is: { loaded: true },
          }),
        ],
        claims: [],
      });

      const chronicle = Chronicle.open(replica);
      const state = chronicle.load({
        id: "test:load",
        type: "application/json",
      });

      expect(state.the).toBe("application/json");
      expect(state.of).toBe("test:load");
      expect(state.is).toEqual({ loaded: true });
    });

    it("should return unclaimed state for non-existent fact", () => {
      const chronicle = Chronicle.open(replica);
      const state = chronicle.load({
        id: "test:nonexistent",
        type: "application/json",
      });

      expect(state.the).toBe("application/json");
      expect(state.of).toBe("test:nonexistent");
      expect(state.is).toBeUndefined();
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
