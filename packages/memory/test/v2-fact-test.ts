import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { claimOp, deleteOp, patchOp, setOp } from "../v2-fact.ts";
import { EMPTY } from "../v2-reference.ts";
import type { EntityId, PatchOp } from "../v2-types.ts";
import type { Reference } from "merkle-reference";
import { refer } from "../reference.ts";

const ENTITY: EntityId = "urn:entity:test1";

describe("v2-fact factory functions", () => {
  describe("setOp", () => {
    it("creates a set operation with EMPTY parent by default", () => {
      const op = setOp(ENTITY, { name: "Alice" });
      expect(op.op).toBe("set");
      expect(op.id).toBe(ENTITY);
      expect(op.value).toEqual({ name: "Alice" });
      expect(op.parent.toString()).toBe(EMPTY(ENTITY).toString());
    });

    it("creates a set operation with explicit parent", () => {
      const parent = refer({ some: "fact" }) as unknown as Reference;
      const op = setOp(ENTITY, 42, parent);
      expect(op.op).toBe("set");
      expect(op.parent.toString()).toBe(parent.toString());
    });

    it("handles null and array values", () => {
      const op1 = setOp(ENTITY, null);
      expect(op1.value).toBe(null);

      const op2 = setOp(ENTITY, [1, 2, 3]);
      expect(op2.value).toEqual([1, 2, 3]);
    });
  });

  describe("patchOp", () => {
    const patches: PatchOp[] = [
      { op: "replace", path: "/name", value: "Bob" },
    ];

    it("creates a patch operation with EMPTY parent by default", () => {
      const op = patchOp(ENTITY, patches);
      expect(op.op).toBe("patch");
      expect(op.id).toBe(ENTITY);
      expect(op.patches).toEqual(patches);
      expect(op.parent.toString()).toBe(EMPTY(ENTITY).toString());
    });

    it("creates a patch operation with explicit parent", () => {
      const parent = refer({ some: "fact" }) as unknown as Reference;
      const op = patchOp(ENTITY, patches, parent);
      expect(op.parent.toString()).toBe(parent.toString());
    });
  });

  describe("deleteOp", () => {
    it("creates a delete operation with EMPTY parent by default", () => {
      const op = deleteOp(ENTITY);
      expect(op.op).toBe("delete");
      expect(op.id).toBe(ENTITY);
      expect(op.parent.toString()).toBe(EMPTY(ENTITY).toString());
    });

    it("creates a delete operation with explicit parent", () => {
      const parent = refer({ some: "fact" }) as unknown as Reference;
      const op = deleteOp(ENTITY, parent);
      expect(op.parent.toString()).toBe(parent.toString());
    });
  });

  describe("claimOp", () => {
    it("creates a claim operation with required parent", () => {
      const parent = refer({ some: "state" }) as unknown as Reference;
      const op = claimOp(ENTITY, parent);
      expect(op.op).toBe("claim");
      expect(op.id).toBe(ENTITY);
      expect(op.parent.toString()).toBe(parent.toString());
    });
  });

  describe("different entity IDs", () => {
    it("produces different EMPTY parents for different entities", () => {
      const e1: EntityId = "urn:entity:a";
      const e2: EntityId = "urn:entity:b";
      const op1 = setOp(e1, "hello");
      const op2 = setOp(e2, "hello");
      expect(op1.parent.toString()).not.toBe(op2.parent.toString());
    });
  });
});
