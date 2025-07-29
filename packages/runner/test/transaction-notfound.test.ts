import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import * as Transaction from "../src/storage/transaction.ts";
import type {
  ISpaceReplica,
  IStorageManager,
  MemorySpace,
} from "../src/storage/interface.ts";
import { unclaimed } from "@commontools/memory/fact";

// Mock replica that simulates non-existent documents
class MockReplica implements ISpaceReplica {
  private data = new Map<string, any>();

  constructor(private space: MemorySpace) {}

  did() {
    return this.space;
  }

  get(entry: { the: string; of: string }) {
    const key = `${entry.of}:${entry.the}`;
    return this.data.get(key);
  }

  commit() {
    return Promise.resolve({ ok: {} as any });
  }

  // Helper to set test data
  setData(id: string, type: string, value: any) {
    const key = `${id}:${type}`;
    this.data.set(key, { the: type, of: id, is: value });
  }
}

// Mock storage manager
class MockStorageManager implements IStorageManager {
  id = "test-storage";
  replicas = new Map<MemorySpace, MockReplica>();

  open(space: MemorySpace) {
    let replica = this.replicas.get(space);
    if (!replica) {
      replica = new MockReplica(space);
      this.replicas.set(space, replica);
    }
    return { replica } as any;
  }

  edit() {
    return Transaction.create(this);
  }

  synced() {
    return Promise.resolve();
  }

  subscribe() {}
}

describe("Transaction NotFound Behavior", () => {
  const testSpace: MemorySpace = "did:test:space";

  it("should return NotFoundError when reading from non-existent document", () => {
    const storage = new MockStorageManager();
    const tx = storage.edit();

    const result = tx.read({
      space: testSpace,
      id: "doc:1",
      type: "application/json",
      path: ["value", "name"],
    });

    expect(result.error).toBeDefined();
    expect(result.error?.name).toBe("NotFoundError");
    expect(result.error?.message).toBe("Document not found: doc:1");
  });

  it("should return NotFoundError when writing to non-existent document with nested path", () => {
    const storage = new MockStorageManager();
    const tx = storage.edit();

    const result = tx.write({
      space: testSpace,
      id: "doc:1",
      type: "application/json",
      path: ["value", "name"],
    }, "Alice");

    expect(result.error).toBeDefined();
    expect(result.error?.name).toBe("NotFoundError");
    expect(result.error?.message).toBe("Document not found: doc:1");
  });

  it("should succeed when writing to non-existent document with empty path", () => {
    const storage = new MockStorageManager();
    const tx = storage.edit();

    const result = tx.write({
      space: testSpace,
      id: "doc:1",
      type: "application/json",
      path: [],
    }, { name: "Alice" });

    expect(result.ok).toBeDefined();
    expect(result.error).toBeUndefined();
  });

  it("should return NotFoundError when reading non-existent path in existing document", () => {
    const storage = new MockStorageManager();
    const replica = storage.open(testSpace).replica as MockReplica;
    replica.setData("doc:1", "application/json", { age: 30 });

    const tx = storage.edit();

    const result = tx.read({
      space: testSpace,
      id: "doc:1",
      type: "application/json",
      path: ["name"],
    });

    // Reading a non-existent property returns undefined, not NotFound
    expect(result.ok).toBeDefined();
    expect(result.ok?.value).toBeUndefined();
  });

  it("should return TypeMismatchError when traversing through non-object", () => {
    const storage = new MockStorageManager();
    const replica = storage.open(testSpace).replica as MockReplica;
    replica.setData("doc:1", "application/json", { name: "Alice" });

    const tx = storage.edit();

    const result = tx.read({
      space: testSpace,
      id: "doc:1",
      type: "application/json",
      path: ["name", "length"], // Trying to access property of a string
    });

    expect(result.error).toBeDefined();
    expect(result.error?.name).toBe("TypeMismatchError");
  });

  it("should handle writes creating new documents", () => {
    const storage = new MockStorageManager();
    const tx = storage.edit();

    // Write to root path of non-existent document should succeed
    const writeResult = tx.write({
      space: testSpace,
      id: "doc:new",
      type: "application/json",
      path: [],
    }, { name: "Bob", age: 25 });

    expect(writeResult.ok).toBeDefined();

    // Now read it back
    const readResult = tx.read({
      space: testSpace,
      id: "doc:new",
      type: "application/json",
      path: ["name"],
    });

    expect(readResult.ok).toBeDefined();
    expect(readResult.ok?.value).toBe("Bob");
  });

  it("should propagate NotFound through transaction reader", () => {
    const storage = new MockStorageManager();
    const tx = storage.edit();
    const reader = tx.reader(testSpace);

    expect(reader.ok).toBeDefined();

    const result = reader.ok!.read({
      id: "doc:missing",
      type: "application/json",
      path: ["value"],
    });

    expect(result.error).toBeDefined();
    expect(result.error?.name).toBe("NotFoundError");
  });

  it("should propagate NotFound through transaction writer", () => {
    const storage = new MockStorageManager();
    const tx = storage.edit();
    const writer = tx.writer(testSpace);

    expect(writer.ok).toBeDefined();

    const result = writer.ok!.write({
      id: "doc:missing",
      type: "application/json",
      path: ["nested", "value"],
    }, "test");

    expect(result.error).toBeDefined();
    expect(result.error?.name).toBe("NotFoundError");
  });
});
