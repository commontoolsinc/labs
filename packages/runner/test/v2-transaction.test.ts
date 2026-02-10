import { beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { V2Transaction } from "../src/storage/v2-transaction.ts";
import { V2Replica } from "../src/storage/v2-replica.ts";
import type { EntityId, SpaceId } from "@commontools/memory/v2-types";
import { refer } from "@commontools/memory/reference";

const SPACE: SpaceId = "did:key:z6MkTest";
const ENTITY_A: EntityId = "urn:entity:a";
const ENTITY_B: EntityId = "urn:entity:b";

/** Create a valid merkle reference string for test data. */
function refStr(data: unknown): string {
  return refer(data).toString();
}

describe("V2Transaction", () => {
  let replica: V2Replica;

  beforeEach(() => {
    replica = new V2Replica(SPACE);
  });

  describe("read", () => {
    it("returns undefined for unknown entities", () => {
      const tx = new V2Transaction(replica);
      expect(tx.read(ENTITY_A)).toBeUndefined();
    });

    it("reads from confirmed state", () => {
      replica.state.confirmed.set(ENTITY_A, {
        version: 1,
        hash: refStr({ id: ENTITY_A, v: 1 }),
        value: { name: "Alice" },
      });

      const tx = new V2Transaction(replica);
      expect(tx.read(ENTITY_A)).toEqual({ name: "Alice" });
    });

    it("provides read-your-writes within the transaction", () => {
      const tx = new V2Transaction(replica);
      tx.set(ENTITY_A, { name: "Bob" });
      expect(tx.read(ENTITY_A)).toEqual({ name: "Bob" });
    });

    it("returns undefined after delete within the transaction", () => {
      replica.state.confirmed.set(ENTITY_A, {
        version: 1,
        hash: refStr({ id: ENTITY_A, v: 1 }),
        value: { name: "Alice" },
      });

      const tx = new V2Transaction(replica);
      tx.delete(ENTITY_A);
      expect(tx.read(ENTITY_A)).toBeUndefined();
    });
  });

  describe("set", () => {
    it("queues a set operation", () => {
      const tx = new V2Transaction(replica);
      tx.set(ENTITY_A, { x: 42 });
      expect(tx.operations.length).toBe(1);
      expect(tx.operations[0].op).toBe("set");
      if (tx.operations[0].op === "set") {
        expect(tx.operations[0].value).toEqual({ x: 42 });
      }
    });

    it("uses EMPTY parent for new entities", () => {
      const tx = new V2Transaction(replica);
      tx.set(ENTITY_A, "hello");
      expect(tx.operations[0].parent).toBeDefined();
    });

    it("resolves parent from confirmed state", () => {
      const hash = refStr({ id: ENTITY_A, v: 1 });
      replica.state.confirmed.set(ENTITY_A, {
        version: 1,
        hash,
        value: "old",
      });

      const tx = new V2Transaction(replica);
      tx.set(ENTITY_A, "new");
      // Parent should be resolved from confirmed state
      expect(tx.operations[0].parent).toBeDefined();
      expect(tx.operations[0].parent.toString()).toBe(hash);
    });
  });

  describe("patch", () => {
    it("queues a patch operation", () => {
      const tx = new V2Transaction(replica);
      tx.patch(ENTITY_A, [{ op: "replace", path: "/name", value: "Bob" }]);
      expect(tx.operations.length).toBe(1);
      expect(tx.operations[0].op).toBe("patch");
    });
  });

  describe("delete", () => {
    it("queues a delete operation", () => {
      const tx = new V2Transaction(replica);
      tx.delete(ENTITY_A);
      expect(tx.operations.length).toBe(1);
      expect(tx.operations[0].op).toBe("delete");
    });
  });

  describe("commit", () => {
    it("commits operations through the replica", () => {
      const tx = new V2Transaction(replica);
      tx.set(ENTITY_A, { x: 1 });
      tx.set(ENTITY_B, { y: 2 });

      const result = tx.commit();
      expect(result.commitHash).toBeTruthy();
      expect(result.changes.changes.length).toBe(2);
    });

    it("tracks confirmed read dependencies", () => {
      // Set up confirmed state with valid hash
      replica.state.confirmed.set(ENTITY_A, {
        version: 1,
        hash: refStr({ id: ENTITY_A, v: 1 }),
        value: { name: "Alice" },
      });

      const tx = new V2Transaction(replica);
      // Read the entity first (tracks as dependency)
      tx.read(ENTITY_A);
      // Then write to a different entity
      tx.set(ENTITY_B, { data: "test" });

      const result = tx.commit();
      expect(result.commitHash).toBeTruthy();
      // The replica should now have pending state
      expect(replica.state.pending.length).toBe(1);
    });

    it("prevents double commit", () => {
      const tx = new V2Transaction(replica);
      tx.set(ENTITY_A, "value");
      tx.commit();

      expect(() => tx.commit()).toThrow("committed");
    });

    it("reports version 0 for pending commits", () => {
      const tx = new V2Transaction(replica);
      tx.set(ENTITY_A, "value");
      const result = tx.commit();
      expect(result.changes.version).toBe(0);
    });
  });

  describe("abort", () => {
    it("aborts the transaction", () => {
      const tx = new V2Transaction(replica);
      tx.set(ENTITY_A, "value");
      tx.abort();
      expect(tx.status).toBe("aborted");
    });

    it("prevents operations after abort", () => {
      const tx = new V2Transaction(replica);
      tx.abort();
      expect(() => tx.set(ENTITY_A, "value")).toThrow("aborted");
    });

    it("prevents commit after abort", () => {
      const tx = new V2Transaction(replica);
      tx.abort();
      expect(() => tx.commit()).toThrow("aborted");
    });
  });

  describe("multiple operations", () => {
    it("preserves operation order", () => {
      const tx = new V2Transaction(replica);
      tx.set(ENTITY_A, "first");
      tx.set(ENTITY_B, "second");
      tx.delete(ENTITY_A);

      expect(tx.operations.length).toBe(3);
      expect(tx.operations[0].op).toBe("set");
      expect(tx.operations[0].id).toBe(ENTITY_A);
      expect(tx.operations[1].op).toBe("set");
      expect(tx.operations[1].id).toBe(ENTITY_B);
      expect(tx.operations[2].op).toBe("delete");
      expect(tx.operations[2].id).toBe(ENTITY_A);
    });
  });
});
