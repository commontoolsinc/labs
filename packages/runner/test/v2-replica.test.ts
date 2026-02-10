import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { V2Replica } from "../src/storage/v2-replica.ts";
import type {
  EntityId,
  JSONValue,
  Operation,
  SpaceId,
} from "@commontools/memory/v2-types";
import { EMPTY } from "@commontools/memory/v2-reference";

const SPACE: SpaceId = "did:key:z6MkTest";
const ENTITY1: EntityId = "urn:entity:1";
const ENTITY2: EntityId = "urn:entity:2";

// ---------------------------------------------------------------------------
// Basic lifecycle
// ---------------------------------------------------------------------------

describe("V2Replica", () => {
  describe("basic lifecycle", () => {
    it("starts empty", () => {
      const replica = new V2Replica(SPACE);
      expect(replica.spaceId).toBe(SPACE);
      expect(replica.get(ENTITY1)).toBeUndefined();
    });

    it("commit adds to pending", () => {
      const replica = new V2Replica(SPACE);
      const ops: Operation[] = [
        {
          op: "set",
          id: ENTITY1,
          value: { x: 1 },
          parent: EMPTY(ENTITY1),
        },
      ];

      const { commitHash, changes } = replica.commit(ops, []);
      expect(typeof commitHash).toBe("string");
      expect(commitHash.length).toBeGreaterThan(0);
      expect(changes.changes.length).toBe(1);
      expect(changes.changes[0].id).toBe(ENTITY1);
      expect(changes.changes[0].before).toBeUndefined();
      expect(changes.changes[0].after).toEqual({ x: 1 });
      expect(changes.version).toBe(0);

      const read = replica.get(ENTITY1);
      expect(read).toBeDefined();
      expect(read!.source).toBe("pending");
      expect(read!.value).toEqual({ x: 1 });
    });

    it("confirm promotes to confirmed", () => {
      const replica = new V2Replica(SPACE);
      const ops: Operation[] = [
        {
          op: "set",
          id: ENTITY1,
          value: { x: 1 },
          parent: EMPTY(ENTITY1),
        },
      ];

      const { commitHash } = replica.commit(ops, []);
      const confirmChanges = replica.confirm(commitHash, 1);
      expect(confirmChanges).toBeDefined();
      expect(confirmChanges!.version).toBe(1);
      expect(confirmChanges!.changes.length).toBe(1);

      const read = replica.get(ENTITY1);
      expect(read).toBeDefined();
      expect(read!.source).toBe("confirmed");
      expect(read!.value).toEqual({ x: 1 });
    });

    it("confirm returns undefined for unknown hash", () => {
      const replica = new V2Replica(SPACE);
      expect(replica.confirm("nonexistent", 1)).toBeUndefined();
    });

    it("commit with delete operation", () => {
      const replica = new V2Replica(SPACE);

      // First set a value
      const setOps: Operation[] = [
        {
          op: "set",
          id: ENTITY1,
          value: { x: 1 },
          parent: EMPTY(ENTITY1),
        },
      ];
      const { commitHash } = replica.commit(setOps, []);
      replica.confirm(commitHash, 1);

      // Then delete it
      const deleteOps: Operation[] = [
        {
          op: "delete",
          id: ENTITY1,
          parent: EMPTY(ENTITY1),
        },
      ];
      const { changes } = replica.commit(deleteOps, []);
      expect(changes.changes.length).toBe(1);
      expect(changes.changes[0].before).toEqual({ x: 1 });
      expect(changes.changes[0].after).toBeUndefined();
    });

    it("commit with claim operation produces no writes", () => {
      const replica = new V2Replica(SPACE);
      const ops: Operation[] = [
        {
          op: "claim",
          id: ENTITY1,
          parent: EMPTY(ENTITY1),
        },
      ];

      const { changes } = replica.commit(ops, []);
      expect(changes.changes.length).toBe(0);
      expect(replica.get(ENTITY1)).toBeUndefined();
    });

    it("multiple entities in one commit", () => {
      const replica = new V2Replica(SPACE);
      const ops: Operation[] = [
        {
          op: "set",
          id: ENTITY1,
          value: "hello",
          parent: EMPTY(ENTITY1),
        },
        {
          op: "set",
          id: ENTITY2,
          value: "world",
          parent: EMPTY(ENTITY2),
        },
      ];

      const { changes } = replica.commit(ops, []);
      expect(changes.changes.length).toBe(2);

      expect(replica.get(ENTITY1)!.value).toBe("hello");
      expect(replica.get(ENTITY2)!.value).toBe("world");
    });
  });

  // ---------------------------------------------------------------------------
  // Rejection
  // ---------------------------------------------------------------------------

  describe("rejection", () => {
    it("reject reverts to confirmed state", () => {
      const replica = new V2Replica(SPACE);

      // Set up confirmed state
      const ops1: Operation[] = [
        {
          op: "set",
          id: ENTITY1,
          value: { x: 1 },
          parent: EMPTY(ENTITY1),
        },
      ];
      const { commitHash: hash1 } = replica.commit(ops1, []);
      replica.confirm(hash1, 1);

      // Now create a pending commit
      const ops2: Operation[] = [
        {
          op: "set",
          id: ENTITY1,
          value: { x: 2 },
          parent: EMPTY(ENTITY1),
        },
      ];
      const { commitHash: hash2 } = replica.commit(ops2, []);

      // Pending should win
      expect(replica.get(ENTITY1)!.value).toEqual({ x: 2 });

      // Reject
      const rejectChanges = replica.reject(hash2);
      expect(rejectChanges.changes.length).toBe(1);
      expect(rejectChanges.version).toBe(0);

      // Should revert to confirmed value
      expect(replica.get(ENTITY1)!.value).toEqual({ x: 1 });
      expect(replica.get(ENTITY1)!.source).toBe("confirmed");
    });

    it("reject with no confirmed state results in undefined", () => {
      const replica = new V2Replica(SPACE);

      const ops: Operation[] = [
        {
          op: "set",
          id: ENTITY1,
          value: { x: 1 },
          parent: EMPTY(ENTITY1),
        },
      ];
      const { commitHash } = replica.commit(ops, []);

      const rejectChanges = replica.reject(commitHash);
      expect(rejectChanges.changes.length).toBe(1);
      expect(rejectChanges.changes[0].after).toBeUndefined();

      expect(replica.get(ENTITY1)).toBeUndefined();
    });

    it("reject unknown hash returns empty changes", () => {
      const replica = new V2Replica(SPACE);
      const changes = replica.reject("nonexistent");
      expect(changes.changes.length).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Integration
  // ---------------------------------------------------------------------------

  describe("integration", () => {
    it("integrate updates confirmed state", () => {
      const replica = new V2Replica(SPACE);

      const entityValues = new Map<EntityId, JSONValue | undefined>();
      entityValues.set(ENTITY1, { x: 42 });

      const commit = {
        hash: "abc" as any,
        version: 5,
        branch: "",
        facts: [],
        createdAt: new Date().toISOString(),
      };

      const changes = replica.integrate(commit, entityValues);
      expect(changes.version).toBe(5);
      expect(changes.changes.length).toBe(1);
      expect(changes.changes[0].before).toBeUndefined();
      expect(changes.changes[0].after).toEqual({ x: 42 });

      const read = replica.get(ENTITY1);
      expect(read).toBeDefined();
      expect(read!.source).toBe("confirmed");
      expect(read!.value).toEqual({ x: 42 });
    });

    it("integrate overwrites previous confirmed state", () => {
      const replica = new V2Replica(SPACE);

      // First integration
      const values1 = new Map<EntityId, JSONValue | undefined>();
      values1.set(ENTITY1, "old");
      replica.integrate(
        { hash: "a" as any, version: 1, branch: "", facts: [], createdAt: "" },
        values1,
      );

      // Second integration
      const values2 = new Map<EntityId, JSONValue | undefined>();
      values2.set(ENTITY1, "new");
      const changes = replica.integrate(
        { hash: "b" as any, version: 2, branch: "", facts: [], createdAt: "" },
        values2,
      );

      expect(changes.changes[0].before).toBe("old");
      expect(changes.changes[0].after).toBe("new");
      expect(replica.get(ENTITY1)!.value).toBe("new");
    });

    it("integrate with multiple entities", () => {
      const replica = new V2Replica(SPACE);

      const entityValues = new Map<EntityId, JSONValue | undefined>();
      entityValues.set(ENTITY1, "val1");
      entityValues.set(ENTITY2, "val2");

      const changes = replica.integrate(
        { hash: "c" as any, version: 3, branch: "", facts: [], createdAt: "" },
        entityValues,
      );

      expect(changes.changes.length).toBe(2);
      expect(replica.get(ENTITY1)!.value).toBe("val1");
      expect(replica.get(ENTITY2)!.value).toBe("val2");
    });
  });

  // ---------------------------------------------------------------------------
  // Clear
  // ---------------------------------------------------------------------------

  describe("clear", () => {
    it("clears all state", () => {
      const replica = new V2Replica(SPACE);

      // Add confirmed state via integrate
      const values = new Map<EntityId, JSONValue | undefined>();
      values.set(ENTITY1, "confirmed");
      replica.integrate(
        { hash: "a" as any, version: 1, branch: "", facts: [], createdAt: "" },
        values,
      );

      // Add pending state via commit
      const ops: Operation[] = [
        {
          op: "set",
          id: ENTITY2,
          value: "pending",
          parent: EMPTY(ENTITY2),
        },
      ];
      replica.commit(ops, []);

      // Both should be readable
      expect(replica.get(ENTITY1)).toBeDefined();
      expect(replica.get(ENTITY2)).toBeDefined();

      // Clear
      replica.clear();
      expect(replica.get(ENTITY1)).toBeUndefined();
      expect(replica.get(ENTITY2)).toBeUndefined();
    });
  });
});
