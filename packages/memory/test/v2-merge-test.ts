import { beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { Database } from "@db/sqlite";
import { openV2Space, V2Space } from "../v2-space.ts";
import { createBranch, DEFAULT_BRANCH } from "../v2-branch.ts";
import { mergeBranch } from "../v2-merge.ts";
import type { EntityId, JSONValue } from "../v2-types.ts";
import { computeFactHash, computeValueHash, EMPTY } from "../v2-reference.ts";
import { BranchDeletedError, BranchNotFoundError } from "../v2-branch.ts";

const ENTITY_A: EntityId = "urn:entity:merge-a";
const ENTITY_B: EntityId = "urn:entity:merge-b";

/**
 * Helper: write a set fact on a branch, advance version, and update head.
 */
function writeEntity(
  space: V2Space,
  _db: Database,
  branch: string,
  entityId: EntityId,
  value: JSONValue,
): number {
  const version = space.nextVersion(branch);
  const commitRef = `merge-commit-${branch}-${version}`;
  space.insertCommit(commitRef, version, branch, null);

  const valueHash = computeValueHash(value);
  space.insertValue(valueHash.toString(), JSON.stringify(value));

  const fact = {
    type: "set" as const,
    id: entityId,
    value,
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
  space.updateBranchHeadVersion(branch, version);
  return version;
}

describe("v2-merge", () => {
  let db: Database;
  let space: V2Space;

  beforeEach(() => {
    space = openV2Space(new URL("memory:merge-test"));
    db = space.store;
  });

  // -----------------------------------------------------------------------
  // Fast-forward merge
  // -----------------------------------------------------------------------

  describe("fast-forward merge", () => {
    it("merges source changes into target when target is unchanged", () => {
      // Setup: write entity A on default
      writeEntity(space, db, DEFAULT_BRANCH, ENTITY_A, { x: 1 });

      // Fork a branch
      createBranch(space, "feature");

      // Modify entity A on the feature branch
      writeEntity(space, db, "feature", ENTITY_A, { x: 2 });

      // Merge feature → default
      const result = mergeBranch(db, "feature", DEFAULT_BRANCH);
      expect("ok" in result).toBe(true);
      if ("ok" in result) {
        expect(result.ok.merged).toBe(1);
        expect(result.ok.commit.branch).toBe(DEFAULT_BRANCH);
      }
    });

    it("merges multiple entities", () => {
      writeEntity(space, db, DEFAULT_BRANCH, ENTITY_A, "init-a");
      writeEntity(space, db, DEFAULT_BRANCH, ENTITY_B, "init-b");

      createBranch(space, "multi");

      writeEntity(space, db, "multi", ENTITY_A, "changed-a");
      writeEntity(space, db, "multi", ENTITY_B, "changed-b");

      const result = mergeBranch(db, "multi", DEFAULT_BRANCH);
      expect("ok" in result).toBe(true);
      if ("ok" in result) {
        expect(result.ok.merged).toBe(2);
      }
    });

    it("produces empty merge commit when nothing changed", () => {
      createBranch(space, "empty");

      const result = mergeBranch(db, "empty", DEFAULT_BRANCH);
      expect("ok" in result).toBe(true);
      if ("ok" in result) {
        expect(result.ok.merged).toBe(0);
      }
    });
  });

  // -----------------------------------------------------------------------
  // Conflict detection
  // -----------------------------------------------------------------------

  describe("conflict detection", () => {
    it("detects conflicts when both branches modify the same entity", () => {
      writeEntity(space, db, DEFAULT_BRANCH, ENTITY_A, "base");

      createBranch(space, "conflict-src");

      // Modify on source
      writeEntity(space, db, "conflict-src", ENTITY_A, "source-value");

      // Modify on target (default)
      writeEntity(space, db, DEFAULT_BRANCH, ENTITY_A, "target-value");

      const result = mergeBranch(db, "conflict-src", DEFAULT_BRANCH);
      expect("error" in result).toBe(true);
      if ("error" in result) {
        expect(result.error.conflicts.length).toBe(1);
        expect(result.error.conflicts[0].entityId).toBe(ENTITY_A);
        expect(result.error.conflicts[0].sourceValue).toBe("source-value");
        expect(result.error.conflicts[0].targetValue).toBe("target-value");
      }
    });

    it("allows non-conflicting changes alongside conflicts", () => {
      writeEntity(space, db, DEFAULT_BRANCH, ENTITY_A, "a-base");
      writeEntity(space, db, DEFAULT_BRANCH, ENTITY_B, "b-base");

      createBranch(space, "mixed");

      // Source modifies both A and B
      writeEntity(space, db, "mixed", ENTITY_A, "a-src");
      writeEntity(space, db, "mixed", ENTITY_B, "b-src");

      // Target modifies only A
      writeEntity(space, db, DEFAULT_BRANCH, ENTITY_A, "a-tgt");

      const result = mergeBranch(db, "mixed", DEFAULT_BRANCH);
      // Should conflict on A, but B would fast-forward
      // However, since there's an unresolved conflict, the whole merge fails
      expect("error" in result).toBe(true);
      if ("error" in result) {
        expect(result.error.conflicts.length).toBe(1);
        expect(result.error.conflicts[0].entityId).toBe(ENTITY_A);
      }
    });
  });

  // -----------------------------------------------------------------------
  // Conflict resolution
  // -----------------------------------------------------------------------

  describe("conflict resolution", () => {
    it("resolves conflicts with provided resolutions", () => {
      writeEntity(space, db, DEFAULT_BRANCH, ENTITY_A, "base");

      createBranch(space, "resolve-src");

      writeEntity(space, db, "resolve-src", ENTITY_A, "src-val");
      writeEntity(space, db, DEFAULT_BRANCH, ENTITY_A, "tgt-val");

      // Provide resolution
      const result = mergeBranch(
        db,
        "resolve-src",
        DEFAULT_BRANCH,
        { [ENTITY_A]: "resolved-value" },
      );
      expect("ok" in result).toBe(true);
      if ("ok" in result) {
        expect(result.ok.merged).toBeGreaterThan(0);
      }
    });

    it("resolves conflicts with null (delete)", () => {
      writeEntity(space, db, DEFAULT_BRANCH, ENTITY_A, "exists");

      createBranch(space, "delete-resolve");

      writeEntity(space, db, "delete-resolve", ENTITY_A, "changed");
      writeEntity(space, db, DEFAULT_BRANCH, ENTITY_A, "also-changed");

      const result = mergeBranch(
        db,
        "delete-resolve",
        DEFAULT_BRANCH,
        { [ENTITY_A]: null },
      );
      expect("ok" in result).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Error cases
  // -----------------------------------------------------------------------

  describe("error cases", () => {
    it("throws when source branch does not exist", () => {
      expect(() => mergeBranch(db, "ghost", DEFAULT_BRANCH)).toThrow(
        BranchNotFoundError,
      );
    });

    it("throws when target branch does not exist", () => {
      createBranch(space, "orphan-src");
      expect(() => mergeBranch(db, "orphan-src", "ghost-target")).toThrow(
        BranchNotFoundError,
      );
    });

    it("throws when merging the default branch (no fork)", () => {
      expect(() => mergeBranch(db, DEFAULT_BRANCH, "anywhere")).toThrow(
        /Cannot merge the default branch/,
      );
    });

    it("throws when source branch is deleted", () => {
      createBranch(space, "dead-src");
      space.softDeleteBranch("dead-src");
      expect(() => mergeBranch(db, "dead-src", DEFAULT_BRANCH)).toThrow(
        BranchDeletedError,
      );
    });
  });
});
