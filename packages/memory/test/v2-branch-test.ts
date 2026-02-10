import { beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { openV2Space, V2Space } from "../v2-space.ts";
import {
  BranchDeletedError,
  BranchDepthError,
  BranchExistsError,
  BranchNotFoundError,
  createBranch,
  DEFAULT_BRANCH,
  deleteBranch,
  diffBranch,
  listBranches,
  readEntityOnBranch,
  resolveHead,
} from "../v2-branch.ts";
import type { EntityId } from "../v2-types.ts";
import { computeFactHash, computeValueHash, EMPTY } from "../v2-reference.ts";

const ENTITY: EntityId = "urn:entity:branch-test-1";
const ENTITY2: EntityId = "urn:entity:branch-test-2";

/**
 * Helper: insert a set fact on a branch and update the head.
 */
function insertSetFact(
  space: V2Space,
  branch: string,
  entityId: EntityId,
  value: unknown,
  version: number,
  commitRef: string,
): string {
  const valueHash = computeValueHash(
    value as import("../v2-types.ts").JSONValue,
  );
  space.insertValue(valueHash.toString(), JSON.stringify(value));

  const fact = {
    type: "set" as const,
    id: entityId,
    value: value as import("../v2-types.ts").JSONValue,
    parent: EMPTY(entityId),
  };
  const factHash = computeFactHash(fact);
  space.insertFact({
    hash: factHash.toString(),
    id: entityId,
    valueRef: valueHash.toString(),
    parent: null,
    branch,
    version,
    commitRef,
    factType: "set",
  });
  space.updateHead(branch, entityId, factHash.toString(), version);
  return factHash.toString();
}

describe("v2-branch", () => {
  let space: V2Space;

  beforeEach(() => {
    space = openV2Space(new URL("memory:branch-test"));
  });

  // -----------------------------------------------------------------------
  // createBranch
  // -----------------------------------------------------------------------

  describe("createBranch", () => {
    it("creates a branch from the default branch", () => {
      const branch = createBranch(space, "feature-1");
      expect(branch.name).toBe("feature-1");
      expect(branch.parentBranch).toBe(DEFAULT_BRANCH);
      expect(branch.forkVersion).toBe(0);
      expect(branch.deletedAt).toBeNull();
    });

    it("creates a branch at a specific version", () => {
      // Advance default branch version by writing a fact
      const v = space.nextVersion(DEFAULT_BRANCH);
      space.insertCommit("commit-1", v, DEFAULT_BRANCH, null);
      space.updateBranchHeadVersion(DEFAULT_BRANCH, v);

      const branch = createBranch(space, "feature-2", DEFAULT_BRANCH, v);
      expect(branch.forkVersion).toBe(v);
    });

    it("throws if branch name already exists", () => {
      createBranch(space, "dup");
      expect(() => createBranch(space, "dup")).toThrow(BranchExistsError);
    });

    it("throws if parent branch does not exist", () => {
      expect(() => createBranch(space, "orphan", "nonexistent")).toThrow(
        BranchNotFoundError,
      );
    });

    it("throws if parent branch is deleted", () => {
      createBranch(space, "parent-br");
      deleteBranch(space, "parent-br");
      expect(() => createBranch(space, "child", "parent-br")).toThrow(
        BranchDeletedError,
      );
    });

    it("throws if branch depth exceeds maximum", () => {
      // Create a chain of nested branches
      let parent = DEFAULT_BRANCH;
      for (let i = 0; i < 7; i++) {
        const name = `depth-${i}`;
        createBranch(space, name, parent);
        parent = name;
      }
      // The 8th nested branch should fail
      expect(() => createBranch(space, "too-deep", parent)).toThrow(
        BranchDepthError,
      );
    });

    it("throws if fork version exceeds parent head", () => {
      expect(() => createBranch(space, "future", DEFAULT_BRANCH, 999)).toThrow(
        /exceeds parent's head version/,
      );
    });
  });

  // -----------------------------------------------------------------------
  // deleteBranch
  // -----------------------------------------------------------------------

  describe("deleteBranch", () => {
    it("soft-deletes a branch", () => {
      createBranch(space, "to-delete");
      deleteBranch(space, "to-delete");

      const info = space.getBranch("to-delete");
      expect(info).toBeTruthy();
      expect(info!.deletedAt).toBeTruthy();
    });

    it("throws when deleting the default branch", () => {
      expect(() => deleteBranch(space, DEFAULT_BRANCH)).toThrow(
        /Cannot delete the default branch/,
      );
    });

    it("throws when deleting nonexistent branch", () => {
      expect(() => deleteBranch(space, "ghost")).toThrow(BranchNotFoundError);
    });

    it("throws when deleting already deleted branch", () => {
      createBranch(space, "already-dead");
      deleteBranch(space, "already-dead");
      expect(() => deleteBranch(space, "already-dead")).toThrow(
        BranchDeletedError,
      );
    });
  });

  // -----------------------------------------------------------------------
  // listBranches
  // -----------------------------------------------------------------------

  describe("listBranches", () => {
    it("lists active branches (excludes deleted by default)", () => {
      createBranch(space, "active-1");
      createBranch(space, "active-2");
      createBranch(space, "deleted-1");
      deleteBranch(space, "deleted-1");

      const branches = listBranches(space);
      const names = branches.map((b) => b.name);
      expect(names).toContain(DEFAULT_BRANCH);
      expect(names).toContain("active-1");
      expect(names).toContain("active-2");
      expect(names).not.toContain("deleted-1");
    });

    it("includes deleted branches when requested", () => {
      createBranch(space, "still-here");
      createBranch(space, "gone");
      deleteBranch(space, "gone");

      const all = listBranches(space, true);
      const names = all.map((b) => b.name);
      expect(names).toContain("gone");
    });
  });

  // -----------------------------------------------------------------------
  // resolveHead + readEntityOnBranch
  // -----------------------------------------------------------------------

  describe("resolveHead", () => {
    it("returns null for entity not on any branch", () => {
      const head = resolveHead(space, DEFAULT_BRANCH, ENTITY);
      expect(head).toBeNull();
    });

    it("returns head for entity on the default branch", () => {
      const v = space.nextVersion(DEFAULT_BRANCH);
      space.insertCommit("c1", v, DEFAULT_BRANCH, null);
      insertSetFact(space, DEFAULT_BRANCH, ENTITY, { x: 1 }, v, "c1");
      space.updateBranchHeadVersion(DEFAULT_BRANCH, v);

      const head = resolveHead(space, DEFAULT_BRANCH, ENTITY);
      expect(head).toBeTruthy();
      expect(head!.version).toBe(v);
      expect(head!.factType).toBe("set");
    });

    it("resolves head from parent branch when child has no explicit entry", () => {
      // Write on default branch
      const v1 = space.nextVersion(DEFAULT_BRANCH);
      space.insertCommit("c1", v1, DEFAULT_BRANCH, null);
      insertSetFact(space, DEFAULT_BRANCH, ENTITY, { x: 1 }, v1, "c1");
      space.updateBranchHeadVersion(DEFAULT_BRANCH, v1);

      // Create child branch
      createBranch(space, "child");

      // Child should see the parent's entity
      const head = resolveHead(space, "child", ENTITY);
      expect(head).toBeTruthy();
      expect(head!.version).toBe(v1);
    });

    it("returns child's own head when overridden", () => {
      // Write on default branch
      const v1 = space.nextVersion(DEFAULT_BRANCH);
      space.insertCommit("c1", v1, DEFAULT_BRANCH, null);
      insertSetFact(space, DEFAULT_BRANCH, ENTITY, { x: 1 }, v1, "c1");
      space.updateBranchHeadVersion(DEFAULT_BRANCH, v1);

      // Create child branch and write on it
      createBranch(space, "child");
      const v2 = space.nextVersion("child");
      space.insertCommit("c2", v2, "child", null);
      insertSetFact(space, "child", ENTITY, { x: 2 }, v2, "c2");
      space.updateBranchHeadVersion("child", v2);

      const head = resolveHead(space, "child", ENTITY);
      expect(head).toBeTruthy();
      expect(head!.version).toBe(v2);
    });
  });

  describe("readEntityOnBranch", () => {
    it("reads entity value through parent chain", () => {
      // Write on default
      const v1 = space.nextVersion(DEFAULT_BRANCH);
      space.insertCommit("c1", v1, DEFAULT_BRANCH, null);
      insertSetFact(space, DEFAULT_BRANCH, ENTITY, { msg: "hello" }, v1, "c1");
      space.updateBranchHeadVersion(DEFAULT_BRANCH, v1);

      // Create child
      createBranch(space, "reader");

      // Read from child
      const value = readEntityOnBranch(space, "reader", ENTITY);
      expect(value).toEqual({ msg: "hello" });
    });

    it("returns null for nonexistent entity", () => {
      const value = readEntityOnBranch(space, DEFAULT_BRANCH, ENTITY);
      expect(value).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // diffBranch
  // -----------------------------------------------------------------------

  describe("diffBranch", () => {
    it("returns modified entities on a branch since its fork", () => {
      // Write on default
      const v1 = space.nextVersion(DEFAULT_BRANCH);
      space.insertCommit("c1", v1, DEFAULT_BRANCH, null);
      insertSetFact(space, DEFAULT_BRANCH, ENTITY, { x: 1 }, v1, "c1");
      space.updateBranchHeadVersion(DEFAULT_BRANCH, v1);

      // Create branch
      createBranch(space, "diff-test");

      // Write two entities on branch
      const v2 = space.nextVersion("diff-test");
      space.insertCommit("c2", v2, "diff-test", null);
      insertSetFact(space, "diff-test", ENTITY, { x: 2 }, v2, "c2");
      space.updateBranchHeadVersion("diff-test", v2);

      const v3 = space.nextVersion("diff-test");
      space.insertCommit("c3", v3, "diff-test", null);
      insertSetFact(space, "diff-test", ENTITY2, { y: 1 }, v3, "c3");
      space.updateBranchHeadVersion("diff-test", v3);

      const diff = diffBranch(space, "diff-test");
      const ids = diff.map((d) => d.id);
      expect(ids).toContain(ENTITY);
      expect(ids).toContain(ENTITY2);
    });

    it("throws for nonexistent branch", () => {
      expect(() => diffBranch(space, "nope")).toThrow(BranchNotFoundError);
    });
  });
});
