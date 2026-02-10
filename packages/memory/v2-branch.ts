/**
 * Memory v2 Branch Operations
 *
 * Higher-level branch management: creation, deletion, parent chain
 * head resolution, and branch listing. Builds on V2Space's low-level
 * SQL operations.
 *
 * @see spec 06-branching.md
 * @module v2-branch
 */

import type { EntityId, JSONValue } from "./v2-types.ts";
import type { V2Space } from "./v2-space.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum branch nesting depth to prevent unbounded recursion. */
const MAX_BRANCH_DEPTH = 8;

/** Default branch name (empty string). */
export const DEFAULT_BRANCH = "";

// ---------------------------------------------------------------------------
// Branch info type
// ---------------------------------------------------------------------------

export interface BranchInfo {
  name: string;
  parentBranch: string | null;
  forkVersion: number | null;
  headVersion: number;
  createdAt: string;
  deletedAt: string | null;
}

// ---------------------------------------------------------------------------
// Head resolution result
// ---------------------------------------------------------------------------

export interface ResolvedHead {
  factHash: string;
  version: number;
  factType: string;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class BranchError extends Error {
  override name = "BranchError" as const;
}

export class BranchNotFoundError extends BranchError {
  constructor(name: string) {
    super(`Branch "${name}" not found`);
  }
}

export class BranchExistsError extends BranchError {
  constructor(name: string) {
    super(`Branch "${name}" already exists`);
  }
}

export class BranchDeletedError extends BranchError {
  constructor(name: string) {
    super(`Branch "${name}" is deleted`);
  }
}

export class BranchDepthError extends BranchError {
  constructor(depth: number) {
    super(`Branch depth ${depth} exceeds maximum ${MAX_BRANCH_DEPTH}`);
  }
}

// ---------------------------------------------------------------------------
// Head resolution (parent chain walk)
// ---------------------------------------------------------------------------

/**
 * Resolve the head of an entity on a branch, walking the parent chain
 * if the branch doesn't have an explicit head entry.
 *
 * @see spec 06-branching.md §6.5.1
 */
export function resolveHead(
  space: V2Space,
  branch: string,
  entityId: EntityId,
  depth = 0,
): ResolvedHead | null {
  if (depth > MAX_BRANCH_DEPTH) {
    throw new BranchDepthError(depth);
  }

  // Check this branch's own head table
  const head = space.readHead(branch, entityId);
  if (head) return head;

  // Get branch metadata to find parent
  const branchInfo = space.getBranch(branch);
  if (!branchInfo || branchInfo.parentBranch === null) {
    return null; // Reached root branch, entity doesn't exist
  }

  // Check parent branch's head, constrained to fork version
  // First try the head table (faster, works if parent hasn't been updated)
  const parentHead = space.readHeadAtVersion(
    branchInfo.parentBranch,
    entityId,
    branchInfo.forkVersion!,
  );
  if (parentHead) return parentHead;

  // If the parent branch's head table has been updated past the fork,
  // fall back to scanning the fact table
  const factHead = space.findLatestFactOnBranch(
    entityId,
    branchInfo.parentBranch,
    branchInfo.forkVersion!,
  );
  if (factHead) return factHead;

  // Recurse up the parent chain
  return resolveHead(space, branchInfo.parentBranch, entityId, depth + 1);
}

/**
 * Read an entity's value on a branch using parent chain resolution.
 * Falls back to the parent branch if the entity has no explicit head
 * on this branch.
 */
export function readEntityOnBranch(
  space: V2Space,
  branch: string,
  entityId: EntityId,
): JSONValue | null {
  const head = resolveHead(space, branch, entityId);
  if (!head) return null;
  if (head.factType === "delete") return null;

  // Use readAtVersion to reconstruct the value at the resolved head's version
  return space.readAtVersion(branch, entityId, head.version);
}

// ---------------------------------------------------------------------------
// Branch CRUD
// ---------------------------------------------------------------------------

/**
 * Create a new branch forked from an existing branch.
 *
 * @see spec 06-branching.md §6.3
 */
export function createBranch(
  space: V2Space,
  name: string,
  fromBranch: string = DEFAULT_BRANCH,
  atVersion?: number,
): BranchInfo {
  // Validate name doesn't already exist (including deleted)
  const existing = space.getBranch(name);
  if (existing) {
    throw new BranchExistsError(name);
  }

  // Validate parent branch exists and is active
  const parent = space.getBranch(fromBranch);
  if (!parent) {
    throw new BranchNotFoundError(fromBranch);
  }
  if (parent.deletedAt) {
    throw new BranchDeletedError(fromBranch);
  }

  // Check branch depth
  let depth = 1;
  let current = parent;
  while (current.parentBranch !== null) {
    depth++;
    if (depth >= MAX_BRANCH_DEPTH) {
      throw new BranchDepthError(depth);
    }
    const next = space.getBranch(current.parentBranch);
    if (!next) break;
    current = next;
  }

  // Resolve fork version
  const forkVersion = atVersion ?? parent.headVersion;
  if (forkVersion > parent.headVersion) {
    throw new BranchError(
      `Fork version ${forkVersion} exceeds parent's head version ${parent.headVersion}`,
    );
  }

  // Create the branch record
  space.createBranchRecord(name, fromBranch, forkVersion, forkVersion);

  return space.getBranch(name)!;
}

/**
 * Soft-delete a branch. The default branch cannot be deleted.
 *
 * @see spec 06-branching.md §6.8
 */
export function deleteBranch(space: V2Space, name: string): void {
  if (name === DEFAULT_BRANCH) {
    throw new BranchError("Cannot delete the default branch");
  }

  const branch = space.getBranch(name);
  if (!branch) {
    throw new BranchNotFoundError(name);
  }
  if (branch.deletedAt) {
    throw new BranchDeletedError(name);
  }

  space.softDeleteBranch(name);
}

/**
 * List branches in the space.
 *
 * @see spec 06-branching.md §6.9
 */
export function listBranches(
  space: V2Space,
  includeDeleted = false,
): BranchInfo[] {
  return space.listBranches(includeDeleted);
}

/**
 * Find all entities modified on a branch since its fork point.
 * Used by the merge algorithm.
 */
export function diffBranch(
  space: V2Space,
  branchName: string,
): Array<{ id: EntityId; factHash: string; version: number }> {
  const branch = space.getBranch(branchName);
  if (!branch) throw new BranchNotFoundError(branchName);
  if (branch.forkVersion === null) {
    // Default branch — return all entities
    return space.findModifiedEntities(branchName, 0);
  }
  return space.findModifiedEntities(branchName, branch.forkVersion);
}
