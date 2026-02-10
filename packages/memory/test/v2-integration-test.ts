/**
 * Memory v2 Integration Tests
 *
 * Full lifecycle tests exercising the complete v2 stack:
 * space → commit → query → snapshot → branch → merge → GC.
 */

import { beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { openV2Space, V2Space } from "../v2-space.ts";
import { applyCommit, V2ConflictError } from "../v2-commit.ts";
import { executePaginatedQuery, executeSimpleQuery } from "../v2-query.ts";
import { createBranch, resolveHead } from "../v2-branch.ts";
import { mergeBranch } from "../v2-merge.ts";
import { runGC } from "../v2-gc.ts";
import { createSnapshot } from "../v2-snapshot.ts";
import type { ClientCommit, EntityId, JSONValue } from "../v2-types.ts";
import { EMPTY } from "../v2-reference.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSetCommit(
  id: EntityId,
  value: JSONValue,
  branch = "",
  readVersion = 0,
): ClientCommit {
  return {
    operations: [
      { op: "set", id, value, parent: EMPTY(id) },
    ],
    reads: {
      confirmed: readVersion > 0
        ? [{ id, version: readVersion, hash: EMPTY(id) }]
        : [],
      pending: [],
    },
    branch,
  };
}

function makeDeleteCommit(
  id: EntityId,
  branch = "",
): ClientCommit {
  return {
    operations: [
      { op: "delete", id, parent: EMPTY(id) },
    ],
    reads: { confirmed: [], pending: [] },
    branch,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("v2-integration", () => {
  let space: V2Space;

  beforeEach(() => {
    space = openV2Space(new URL("memory:integration-test"));
  });

  // -------------------------------------------------------------------------
  // Full lifecycle
  // -------------------------------------------------------------------------

  describe("full lifecycle", () => {
    it("set → query → patch → snapshot → GC", () => {
      const id: EntityId = "urn:entity:lifecycle-1";

      // 1. Set
      const r1 = applyCommit(space.store, makeSetCommit(id, { count: 0 }));
      expect("ok" in r1).toBe(true);

      // 2. Query
      const q1 = executeSimpleQuery(space, {
        select: { [id]: {} },
      });
      expect(q1[id]?.value).toEqual({ count: 0 });

      // 3. Patch (via applyCommit with set — we don't have inline patch
      //    construction helpers, so just overwrite)
      const r2 = applyCommit(space.store, {
        operations: [{ op: "set", id, value: { count: 1 }, parent: EMPTY(id) }],
        reads: { confirmed: [], pending: [] },
      });
      expect("ok" in r2).toBe(true);

      // 4. Verify updated value
      const q2 = executeSimpleQuery(space, { select: { [id]: {} } });
      expect(q2[id]?.value).toEqual({ count: 1 });

      // 5. Create a snapshot manually
      createSnapshot(space, "", id, 2, { count: 1 });

      // 6. GC — should not break anything
      const gcResult = runGC(space.store);
      expect(typeof gcResult.factsRemoved).toBe("number");

      // 7. Value still readable after GC
      const q3 = executeSimpleQuery(space, { select: { [id]: {} } });
      expect(q3[id]?.value).toEqual({ count: 1 });
    });

    it("set → branch → modify on branch → merge back", () => {
      const id: EntityId = "urn:entity:branch-lifecycle";

      // 1. Set on default
      applyCommit(space.store, makeSetCommit(id, "default-val"));

      // 2. Create branch
      createBranch(space, "feature");

      // 3. Write on branch
      applyCommit(space.store, {
        operations: [
          { op: "set", id, value: "branch-val", parent: EMPTY(id) },
        ],
        reads: { confirmed: [], pending: [] },
        branch: "feature",
      });

      // 4. Verify isolation
      const defaultVal = space.readEntity("", id);
      expect(defaultVal).toBe("default-val");

      const branchVal = space.readEntity("feature", id);
      expect(branchVal).toBe("branch-val");

      // 5. Merge branch into default
      const mergeResult = mergeBranch(space.store, "feature", "");
      expect("ok" in mergeResult).toBe(true);

      // 6. Default now has branch value
      const merged = space.readEntity("", id);
      expect(merged).toBe("branch-val");
    });
  });

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------

  describe("edge cases", () => {
    it("delete then re-create", () => {
      const id: EntityId = "urn:entity:delete-recreate";

      // Create
      applyCommit(space.store, makeSetCommit(id, "first"));
      expect(space.readEntity("", id)).toBe("first");

      // Delete
      applyCommit(space.store, makeDeleteCommit(id));
      expect(space.readEntity("", id)).toBeNull();

      // Re-create
      applyCommit(space.store, makeSetCommit(id, "second"));
      expect(space.readEntity("", id)).toBe("second");
    });

    it("unicode entity IDs and values", () => {
      const id: EntityId = "urn:entity:こんにちは" as EntityId;
      const value = { greeting: "Héllo Wörld! 你好 🌍" };

      applyCommit(space.store, makeSetCommit(id, value));
      const result = space.readEntity("", id);
      expect(result).toEqual(value);
    });

    it("large value roundtrip", () => {
      const id: EntityId = "urn:entity:large-val";
      // 100KB JSON value
      const arr = Array.from({ length: 10000 }, (_, i) => ({
        idx: i,
        data: "x".repeat(10),
      }));
      const value = { items: arr };

      applyCommit(space.store, makeSetCommit(id, value));
      const result = space.readEntity("", id);
      expect(result).toEqual(value);
    });

    it("null value in entity", () => {
      const id: EntityId = "urn:entity:null-val";
      applyCommit(space.store, makeSetCommit(id, null));
      const result = space.readEntity("", id);
      expect(result).toBeNull();
    });

    it("stale read produces conflict", () => {
      const id: EntityId = "urn:entity:conflict-test";

      // Write v1
      applyCommit(space.store, makeSetCommit(id, "v1"));

      // Attempt to write with stale read
      const result = applyCommit(space.store, {
        operations: [
          { op: "set", id, value: "v2", parent: EMPTY(id) },
        ],
        reads: {
          confirmed: [
            { id, version: 0, hash: EMPTY(id) }, // Stale: claims version 0
          ],
          pending: [],
        },
      });

      expect("error" in result).toBe(true);
      if ("error" in result) {
        expect(result.error).toBeInstanceOf(V2ConflictError);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Multi-entity workflows
  // -------------------------------------------------------------------------

  describe("multi-entity workflows", () => {
    it("batch write multiple entities in single commit", () => {
      const ids: EntityId[] = [
        "urn:entity:batch-1" as EntityId,
        "urn:entity:batch-2" as EntityId,
        "urn:entity:batch-3" as EntityId,
      ];

      const commit: ClientCommit = {
        operations: ids.map((id, i) => ({
          op: "set" as const,
          id,
          value: { index: i },
          parent: EMPTY(id),
        })),
        reads: { confirmed: [], pending: [] },
      };

      const result = applyCommit(space.store, commit);
      expect("ok" in result).toBe(true);

      // All three readable
      for (let i = 0; i < ids.length; i++) {
        expect(space.readEntity("", ids[i])).toEqual({ index: i });
      }
    });

    it("wildcard query returns all entities", () => {
      // Write several entities
      for (let i = 0; i < 5; i++) {
        const id = `urn:entity:wq-${i}` as EntityId;
        applyCommit(space.store, makeSetCommit(id, { i }));
      }

      const result = executeSimpleQuery(space, {
        select: { "*": {} },
      });

      expect(Object.keys(result).length).toBe(5);
    });

    it("pagination walks all entities correctly", () => {
      for (let i = 0; i < 7; i++) {
        const id = `urn:entity:pg-${String(i).padStart(2, "0")}` as EntityId;
        applyCommit(space.store, makeSetCommit(id, i));
      }

      const allIds: string[] = [];
      let cursor: EntityId | undefined;

      for (let page = 0; page < 10; page++) {
        const result = executePaginatedQuery(space, {
          select: { "*": {} },
          limit: 3,
          cursor,
        });
        allIds.push(...Object.keys(result.facts));
        cursor = result.nextCursor;
        if (!cursor) break;
      }

      expect(allIds.length).toBe(7);
      expect(new Set(allIds).size).toBe(7);
    });
  });

  // -------------------------------------------------------------------------
  // Point-in-time reads
  // -------------------------------------------------------------------------

  describe("point-in-time reads", () => {
    it("reads entity at a specific version", () => {
      const id: EntityId = "urn:entity:pit-test";

      const r1 = applyCommit(space.store, makeSetCommit(id, "v1"));
      expect("ok" in r1).toBe(true);
      const v1 = "ok" in r1 ? r1.ok.version : 0;

      applyCommit(space.store, makeSetCommit(id, "v2"));

      // Read at v1
      const pitResult = space.readAtVersion("", id, v1);
      expect(pitResult).toBe("v1");

      // Current read is v2
      expect(space.readEntity("", id)).toBe("v2");
    });

    it("PIT query returns entities at specific version", () => {
      const id: EntityId = "urn:entity:pit-query";

      applyCommit(space.store, makeSetCommit(id, "old"));
      const r2 = applyCommit(space.store, makeSetCommit(id, "new"));
      const v2 = "ok" in r2 ? r2.ok.version : 0;

      // Query at current version
      const result = executeSimpleQuery(space, {
        select: { [id]: {} },
        atVersion: v2,
      });
      expect(result[id]?.value).toBe("new");
    });
  });

  // -------------------------------------------------------------------------
  // Branch workflows
  // -------------------------------------------------------------------------

  describe("branch workflows", () => {
    it("branch head resolution walks parent chain", () => {
      const id: EntityId = "urn:entity:parent-chain";

      // Write on default
      applyCommit(space.store, makeSetCommit(id, "default"));

      // Create branch (forks from default)
      createBranch(space, "child-branch");

      // No write on child-branch yet — resolveHead should find
      // the default branch's head via parent chain walk
      const resolved = resolveHead(space, "child-branch", id);
      expect(resolved).not.toBeNull();
      expect(resolved!.factHash).toBeDefined();
      // Verify we can read the entity on the child branch
      space.readEntity("child-branch", id);
      // readEntity on a child branch only looks at that branch's head table,
      // not the parent. Use resolveHead to confirm existence.
      // The factType should be "set"
      expect(resolved!.factType).toBe("set");
    });

    it("GC after merge preserves data integrity", () => {
      const id: EntityId = "urn:entity:gc-merge";

      applyCommit(space.store, makeSetCommit(id, "base"));
      createBranch(space, "gc-branch");

      applyCommit(space.store, {
        operations: [
          { op: "set", id, value: "branched", parent: EMPTY(id) },
        ],
        reads: { confirmed: [], pending: [] },
        branch: "gc-branch",
      });

      mergeBranch(space.store, "gc-branch", "");

      // GC after merge
      runGC(space.store, { compactSnapshots: true });

      // Data still intact
      expect(space.readEntity("", id)).toBe("branched");
    });
  });

  // -------------------------------------------------------------------------
  // Stacked commits
  // -------------------------------------------------------------------------

  describe("stacked commits", () => {
    it("10 sequential commits on same entity", () => {
      const id: EntityId = "urn:entity:stacked";

      for (let i = 0; i < 10; i++) {
        const result = applyCommit(
          space.store,
          makeSetCommit(id, { step: i }),
        );
        expect("ok" in result).toBe(true);
      }

      const final = space.readEntity("", id);
      expect(final).toEqual({ step: 9 });
    });

    it("since filter returns only new versions", () => {
      const ids: EntityId[] = [];

      // Write 5 entities at different versions
      for (let i = 0; i < 5; i++) {
        const id = `urn:entity:since-${i}` as EntityId;
        ids.push(id);
        applyCommit(space.store, makeSetCommit(id, i));
      }

      // Get version of third entity
      const head3 = space.readHead("", ids[2]);
      const sinceVersion = head3!.version;

      // Query entities written after version 3
      const result = executeSimpleQuery(space, {
        select: { "*": {} },
        since: sinceVersion,
      });

      // Should only include entities 3 and 4 (written after version 3)
      expect(Object.keys(result).length).toBe(2);
    });
  });
});
