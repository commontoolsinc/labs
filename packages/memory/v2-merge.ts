/**
 * Memory v2 Branch Merge
 *
 * Three-way merge algorithm for integrating changes from a source
 * branch into a target branch. Operates at the entity level with
 * fast-forward optimization and conflict detection.
 *
 * @see spec 06-branching.md §6.7
 * @module v2-merge
 */

import type { Database } from "@db/sqlite";
import type { Commit, EntityId, JSONValue, StoredFact } from "./v2-types.ts";
import type { Reference } from "merkle-reference";
import { V2Space } from "./v2-space.ts";
import {
  BranchDeletedError,
  BranchError,
  BranchNotFoundError,
  DEFAULT_BRANCH,
  type ResolvedHead,
  resolveHead,
} from "./v2-branch.ts";
import {
  computeCommitHash,
  computeFactHash,
  computeValueHash,
} from "./v2-reference.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BranchConflict {
  entityId: EntityId;
  sourceValue: JSONValue | null;
  targetValue: JSONValue | null;
  ancestorValue: JSONValue | null;
}

export type MergeResult =
  | { ok: { commit: Commit; merged: number } }
  | { error: { conflicts: BranchConflict[] } };

// ---------------------------------------------------------------------------
// Merge algorithm
// ---------------------------------------------------------------------------

/**
 * Merge changes from a source branch into a target branch.
 *
 * The merge compares each entity's state on the source and target
 * relative to the fork point (common ancestor).
 *
 * - **Fast-forward**: only source changed → apply source's head to target.
 * - **No-op**: only target changed (or neither) → skip.
 * - **Conflict**: both changed → report conflict.
 *
 * If `resolutions` is provided, conflicting entities are resolved with the
 * given values instead of failing.
 *
 * @see spec 06-branching.md §6.7
 */
export function mergeBranch(
  store: Database,
  source: string,
  target: string,
  resolutions?: Record<EntityId, JSONValue | null>,
): MergeResult {
  const space = new V2Space("", store);

  // Validate branches
  const sourceBranch = space.getBranch(source);
  if (!sourceBranch) throw new BranchNotFoundError(source);
  if (sourceBranch.deletedAt) throw new BranchDeletedError(source);
  if (sourceBranch.forkVersion === null) {
    throw new BranchError("Cannot merge the default branch");
  }

  const targetBranch = space.getBranch(target);
  if (!targetBranch) throw new BranchNotFoundError(target);
  if (targetBranch.deletedAt) throw new BranchDeletedError(target);

  const forkVersion = sourceBranch.forkVersion;

  // Find all entities modified on source since fork
  const modified = space.findModifiedEntities(source, forkVersion);

  const fastForwards: Array<{
    entityId: EntityId;
    factHash: string;
    version: number;
    factType: string;
    value: JSONValue | null;
  }> = [];
  const conflicts: BranchConflict[] = [];

  for (const mod of modified) {
    const sourceHead = resolveHead(space, source, mod.id);
    const targetHead = resolveHead(space, target, mod.id);

    // Get ancestor head (state at fork point on the target/parent branch)
    const ancestorHead = getAncestorHead(space, target, mod.id, forkVersion);

    const targetHash = targetHead?.factHash ?? null;
    const ancestorHash = ancestorHead?.factHash ?? null;

    if (targetHash === ancestorHash) {
      // Target hasn't changed → fast-forward from source
      const sourceValue = sourceHead
        ? space.readAtVersion(source, mod.id, sourceHead.version)
        : null;
      fastForwards.push({
        entityId: mod.id,
        factHash: mod.factHash,
        version: mod.version,
        factType: sourceHead?.factType ?? "set",
        value: sourceValue,
      });
    } else {
      const sourceHash = sourceHead?.factHash ?? null;
      if (sourceHash === ancestorHash) {
        // Source hasn't actually changed (wrote then reverted) → skip
        continue;
      }
      // Both changed → conflict
      const sourceValue = sourceHead
        ? space.readAtVersion(source, mod.id, sourceHead.version)
        : null;
      const targetValue = targetHead
        ? space.readAtVersion(target, mod.id, targetHead.version)
        : null;
      const ancestorValue = ancestorHead
        ? space.readAtVersion(target, mod.id, ancestorHead.version)
        : null;

      conflicts.push({
        entityId: mod.id,
        sourceValue,
        targetValue,
        ancestorValue,
      });
    }
  }

  // Check for unresolved conflicts
  const unresolvedConflicts = conflicts.filter(
    (c) => !resolutions || !(c.entityId in resolutions),
  );
  if (unresolvedConflicts.length > 0) {
    return { error: { conflicts: unresolvedConflicts } };
  }

  // Apply resolved conflicts as fast-forwards
  for (const conflict of conflicts) {
    const resolution = resolutions![conflict.entityId];
    fastForwards.push({
      entityId: conflict.entityId,
      factHash: "", // Will be computed during commit
      version: 0,
      factType: resolution === null ? "delete" : "set",
      value: resolution,
    });
  }

  // Apply fast-forwards as a merge commit on the target branch
  const result = store.transaction(() => {
    return applyMergeCommit(space, target, source, fastForwards);
  }).immediate();

  return { ok: result };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Get the ancestor head for an entity at the fork version.
 */
function getAncestorHead(
  space: V2Space,
  branch: string,
  entityId: EntityId,
  forkVersion: number,
): ResolvedHead | null {
  // Try the head table first (if head version <= forkVersion)
  const head = space.readHeadAtVersion(branch, entityId, forkVersion);
  if (head) return head;

  // Fall back to fact scan
  const factHead = space.findLatestFactOnBranch(entityId, branch, forkVersion);
  if (factHead) return factHead;

  // Check parent chain
  const branchInfo = space.getBranch(branch);
  if (branchInfo?.parentBranch !== null && branchInfo?.forkVersion !== null) {
    return getAncestorHead(
      space,
      branchInfo!.parentBranch!,
      entityId,
      Math.min(forkVersion, branchInfo!.forkVersion!),
    );
  }

  return null;
}

/**
 * Apply fast-forwarded entities as a merge commit on the target branch.
 */
function applyMergeCommit(
  space: V2Space,
  target: string,
  source: string,
  fastForwards: Array<{
    entityId: EntityId;
    factHash: string;
    version: number;
    factType: string;
    value: JSONValue | null;
  }>,
): { commit: Commit; merged: number } {
  if (fastForwards.length === 0) {
    // Nothing to merge — create an empty merge commit marker
    const version = space.nextVersion(target);
    const clientCommit = {
      reads: { confirmed: [], pending: [] },
      operations: [],
      branch: target,
    };
    const commitHash = computeCommitHash(clientCommit);
    space.insertCommit(commitHash.toString(), version, target, null);
    space.updateBranchHeadVersion(target, version);

    return {
      commit: {
        hash: commitHash,
        version,
        branch: target,
        facts: [],
        createdAt: new Date().toISOString(),
      },
      merged: 0,
    };
  }

  const version = space.nextVersion(target);

  // Build a merge commit
  const mergeData = {
    merge: true,
    source,
    target,
    entities: fastForwards.map((ff) => ff.entityId),
  };
  const commitHash = computeCommitHash({
    reads: { confirmed: [], pending: [] },
    operations: [],
    branch: target,
    codeCID: computeValueHash(
      mergeData as unknown as import("./v2-types.ts").JSONValue,
    ),
  });
  const commitHashStr = commitHash.toString();

  space.insertCommit(commitHashStr, version, target, null);

  const facts: StoredFact[] = [];

  for (const ff of fastForwards) {
    if (ff.factType === "delete") {
      // Insert a delete fact on the target
      const fact = {
        type: "delete" as const,
        id: ff.entityId,
        parent: commitHash,
      };
      const factHash = computeFactHash(fact);
      space.insertFact({
        hash: factHash.toString(),
        id: ff.entityId,
        valueRef: "__empty__",
        parent: null,
        branch: target,
        version,
        commitRef: commitHashStr,
        factType: "delete",
      });
      space.updateHead(target, ff.entityId, factHash.toString(), version);
      facts.push({ hash: factHash, fact, version, commitHash });
    } else {
      // Insert a set fact with the value on the target
      const value = ff.value;
      const valueHash = computeValueHash(
        value as import("./v2-types.ts").JSONValue,
      );
      space.insertValue(valueHash.toString(), JSON.stringify(value));

      const fact = {
        type: "set" as const,
        id: ff.entityId,
        value: value as import("./v2-types.ts").JSONValue,
        parent: commitHash,
      };
      const factHash = computeFactHash(fact);
      space.insertFact({
        hash: factHash.toString(),
        id: ff.entityId,
        valueRef: valueHash.toString(),
        parent: null,
        branch: target,
        version,
        commitRef: commitHashStr,
        factType: "set",
      });
      space.updateHead(target, ff.entityId, factHash.toString(), version);
      facts.push({ hash: factHash, fact, version, commitHash });
    }
  }

  space.updateBranchHeadVersion(target, version);

  return {
    commit: {
      hash: commitHash,
      version,
      branch: target,
      facts,
      createdAt: new Date().toISOString(),
    },
    merged: fastForwards.length,
  };
}
