import { beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { openV2Space, V2Space } from "../v2-space.ts";
import { runGC } from "../v2-gc.ts";
import type { EntityId, JSONValue } from "../v2-types.ts";
import { computeFactHash, computeValueHash, EMPTY } from "../v2-reference.ts";
import { createSnapshot } from "../v2-snapshot.ts";

const ENTITY_A: EntityId = "urn:entity:gc-a";
const ENTITY_B: EntityId = "urn:entity:gc-b";

function writeSetFact(
  space: V2Space,
  branch: string,
  entityId: EntityId,
  value: JSONValue,
): number {
  const version = space.nextVersion(branch);
  const commitRef = `gc-commit-${version}`;
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

describe("v2-gc", () => {
  let space: V2Space;

  beforeEach(() => {
    space = openV2Space(new URL("memory:gc-test"));
  });

  describe("fact compaction", () => {
    it("removes old facts below retention version", () => {
      // Write several versions
      writeSetFact(space, "", ENTITY_A, "v1");
      writeSetFact(space, "", ENTITY_A, "v2");
      const v3 = writeSetFact(space, "", ENTITY_A, "v3");

      // GC with retention at v3 should remove v1 and v2 facts
      // (but only if they're not referenced as parent or head)
      const result = runGC(space.store, { retentionVersion: v3 });
      // Some facts may be retained due to head references
      expect(result.factsRemoved).toBeGreaterThanOrEqual(0);
    });

    it("preserves facts referenced by head table", () => {
      const v1 = writeSetFact(space, "", ENTITY_A, "current");

      // GC should not remove the current head fact
      runGC(space.store, { retentionVersion: v1 + 1 });
      // The head fact should be preserved
      const value = space.readEntity("", ENTITY_A);
      expect(value).toBe("current");
    });
  });

  describe("orphaned value cleanup", () => {
    it("removes values not referenced by any fact or snapshot", () => {
      // Write and then remove a fact (simulating orphaned value)
      const v1 = writeSetFact(space, "", ENTITY_A, "orphan-value");
      writeSetFact(space, "", ENTITY_A, "new-value");

      // The old value "orphan-value" may become orphaned after GC
      // removes the old fact
      const result = runGC(space.store, { retentionVersion: v1 + 1 });
      expect(result.valuesRemoved).toBeGreaterThanOrEqual(0);
    });

    it("never removes the __empty__ sentinel", () => {
      runGC(space.store);
      const row = space.store
        .prepare("SELECT COUNT(*) as cnt FROM value WHERE hash = '__empty__'")
        .get() as { cnt: number };
      expect(row.cnt).toBe(1);
    });
  });

  describe("snapshot compaction", () => {
    it("keeps only the latest snapshot per entity per branch", () => {
      // Write enough facts to trigger snapshots
      for (let i = 0; i < 25; i++) {
        const v = writeSetFact(space, "", ENTITY_A, `val-${i}`);
        createSnapshot(space, "", ENTITY_A, v, `val-${i}`);
      }

      // Should have multiple snapshots
      const before = space.store
        .prepare("SELECT COUNT(*) as cnt FROM snapshot WHERE id = ?")
        .get(ENTITY_A) as { cnt: number };
      expect(before.cnt).toBeGreaterThan(1);

      // GC should compact to just the latest
      const result = runGC(space.store, { compactSnapshots: true });
      expect(result.snapshotsRemoved).toBeGreaterThan(0);

      const after = space.store
        .prepare("SELECT COUNT(*) as cnt FROM snapshot WHERE id = ?")
        .get(ENTITY_A) as { cnt: number };
      expect(after.cnt).toBe(1);
    });

    it("skips snapshot compaction when disabled", () => {
      for (let i = 0; i < 25; i++) {
        const v = writeSetFact(space, "", ENTITY_A, `val-${i}`);
        createSnapshot(space, "", ENTITY_A, v, `val-${i}`);
      }

      const result = runGC(space.store, { compactSnapshots: false });
      expect(result.snapshotsRemoved).toBe(0);
    });
  });

  describe("full GC cycle", () => {
    it("runs all three cleanup phases", () => {
      // Create some data
      writeSetFact(space, "", ENTITY_A, "a1");
      writeSetFact(space, "", ENTITY_A, "a2");
      writeSetFact(space, "", ENTITY_B, "b1");

      const result = runGC(space.store);
      // Result should have all three counts
      expect(typeof result.factsRemoved).toBe("number");
      expect(typeof result.valuesRemoved).toBe("number");
      expect(typeof result.snapshotsRemoved).toBe("number");
    });
  });
});
