/**
 * Memory v2 Type Definitions
 *
 * Core data types for the Memory v2 system. These are NEW types that coexist
 * with v1 types in interface.ts. They implement the data model defined in
 * the v2 specification (docs/specs/memory-v2/).
 *
 * @module v2-types
 */

import type { Reference } from "merkle-reference";
import type { JSONSchema, JSONValue } from "@commontools/api";

export type { JSONSchema, JSONValue, Reference };

// ---------------------------------------------------------------------------
// 1. Identifiers (spec 01 §1, §10)
// ---------------------------------------------------------------------------

/**
 * Entity identifier. URI format, e.g. "urn:entity:abc123".
 * Unique within a space.
 *
 * @see spec 01-data-model.md §1
 */
export type EntityId = `${string}:${string}`;

/**
 * Branch identifier string. Used in commit targeting and head resolution.
 *
 * @see spec 01-data-model.md §10
 */
export type BranchId = string;

/**
 * Human-readable branch name (empty string for the default branch).
 *
 * @see spec 01-data-model.md §10
 */
export type BranchName = string;

/**
 * A decentralized identifier for a space.
 *
 * @see spec 01-data-model.md §10
 */
export type SpaceId = `did:${string}`;

/**
 * A decentralized identifier (generic).
 *
 * @see spec 01-data-model.md §10
 */
export type DID = `did:${string}`;

// ---------------------------------------------------------------------------
// 2. JSON Pointer (spec 01 §6.2)
// ---------------------------------------------------------------------------

/**
 * A JSON Pointer path, e.g. "/foo/bar/0".
 * Used in patch operations per RFC 6902.
 *
 * @see spec 01-data-model.md §6.2
 */
export type JSONPointer = string;

// ---------------------------------------------------------------------------
// 3. Patch Operations (spec 01 §6.2)
// ---------------------------------------------------------------------------

/**
 * Standard JSON Patch "replace" operation (RFC 6902).
 *
 * @see spec 01-data-model.md §6.2
 */
export interface ReplaceOp {
  op: "replace";
  path: JSONPointer;
  value: JSONValue;
}

/**
 * Standard JSON Patch "add" operation (RFC 6902).
 *
 * @see spec 01-data-model.md §6.2
 */
export interface AddOp {
  op: "add";
  path: JSONPointer;
  value: JSONValue;
}

/**
 * Standard JSON Patch "remove" operation (RFC 6902).
 *
 * @see spec 01-data-model.md §6.2
 */
export interface RemoveOp {
  op: "remove";
  path: JSONPointer;
}

/**
 * Standard JSON Patch "move" operation (RFC 6902).
 *
 * @see spec 01-data-model.md §6.2
 */
export interface MoveOp {
  op: "move";
  from: JSONPointer;
  path: JSONPointer;
}

/**
 * Extension operation: array splice.
 * More efficient than expressing insert/delete as individual add/remove ops.
 *
 * @see spec 01-data-model.md §6.2
 */
export interface SpliceOp {
  op: "splice";
  path: JSONPointer;
  index: number;
  remove: number;
  add: JSONValue[];
}

/**
 * Union of all supported patch operations.
 *
 * @see spec 01-data-model.md §6.2
 */
export type PatchOp = ReplaceOp | AddOp | RemoveOp | MoveOp | SpliceOp;

// ---------------------------------------------------------------------------
// 4. Facts (spec 01 §2)
// ---------------------------------------------------------------------------

/**
 * A Write that sets the entity's value by full replacement.
 *
 * @see spec 01-data-model.md §2.1
 */
export interface SetWrite {
  type: "set";
  id: EntityId;
  value: JSONValue;
  parent: Reference;
}

/**
 * A Write that modifies the entity's value incrementally via patches.
 *
 * @see spec 01-data-model.md §2.1
 */
export interface PatchWrite {
  type: "patch";
  id: EntityId;
  ops: PatchOp[];
  parent: Reference;
}

/**
 * A Write fact asserts a new value for an entity, either by full
 * replacement (SetWrite) or incremental patches (PatchWrite).
 *
 * @see spec 01-data-model.md §2.1
 */
export type Write = SetWrite | PatchWrite;

/**
 * A Delete fact tombstones an entity, removing its value.
 * The entity can be written to again after deletion.
 *
 * @see spec 01-data-model.md §2.2
 */
export interface Delete {
  type: "delete";
  id: EntityId;
  parent: Reference;
}

/**
 * Union of all fact types. A fact records a single state transition
 * for an entity and is immutable once created.
 *
 * @see spec 01-data-model.md §2.3
 */
export type Fact = Write | Delete;

/**
 * A fact with server-assigned metadata, as stored in the fact table.
 *
 * @see spec 01-data-model.md §2.4
 */
export interface StoredFact {
  /** Content hash of this fact's logical content (type, id, value/ops, parent). */
  hash: Reference;

  /** The fact itself. */
  fact: Fact;

  /** Monotonic version number (Lamport clock), assigned at commit time. Per-space. */
  version: number;

  /** Hash of the commit that included this fact. */
  commitHash: Reference;
}

// ---------------------------------------------------------------------------
// 5. Entity Document (spec 01 §1.1)
// ---------------------------------------------------------------------------

/**
 * A CID link object, used for references in entity documents.
 *
 * @see spec 01-data-model.md §1.1
 */
export interface EntityLink {
  "/": Reference;
}

/**
 * Entity values are stored in an envelope with well-known top-level keys.
 * The `value` property holds the cell's actual data. Omitting `value`
 * signals that the entity's value is undefined (deleted).
 *
 * @see spec 01-data-model.md §1.1
 */
export interface EntityDocument {
  value?: JSONValue;
  source?: EntityLink;
}

// ---------------------------------------------------------------------------
// 6. Operations (spec 03 §3.1)
// ---------------------------------------------------------------------------

/**
 * Full replacement operation -- set the entity to a new value.
 *
 * @see spec 03-commit-model.md §3.1
 */
export interface SetOperation {
  op: "set";
  id: EntityId;
  value: JSONValue;
  parent: Reference;
}

/**
 * Incremental change operation -- apply patch operations to the current value.
 *
 * @see spec 03-commit-model.md §3.1
 */
export interface PatchWriteOperation {
  op: "patch";
  id: EntityId;
  patches: PatchOp[];
  parent: Reference;
}

/**
 * Tombstone operation -- mark the entity as deleted.
 *
 * @see spec 03-commit-model.md §3.1
 */
export interface DeleteOperation {
  op: "delete";
  id: EntityId;
  parent: Reference;
}

/**
 * Read assertion operation -- declare a read dependency without mutating.
 * If the entity has changed since the claimed parent, the transaction
 * is rejected.
 *
 * @see spec 03-commit-model.md §3.1
 */
export interface ClaimOperation {
  op: "claim";
  id: EntityId;
  parent: Reference;
}

/**
 * Union of all operation types within a transaction.
 *
 * @see spec 03-commit-model.md §3.1
 */
export type Operation =
  | SetOperation
  | PatchWriteOperation
  | DeleteOperation
  | ClaimOperation;

// ---------------------------------------------------------------------------
// 7. Transaction and Commit (spec 03 §3.2, §3.4)
// ---------------------------------------------------------------------------

/**
 * A Transaction groups one or more operations into an atomic unit.
 * All operations succeed or all fail.
 *
 * @see spec 03-commit-model.md §3.2
 */
export interface Transaction {
  /** The operations to apply, in order. */
  operations: Operation[];

  /** Optional: content-addressed code bundle that produced this transaction. */
  codeCID?: Reference;

  /** Optional: branch to target. Defaults to the default branch if omitted. */
  branch?: BranchId;
}

/**
 * A read from confirmed (server-acknowledged) state.
 *
 * @see spec 03-commit-model.md §3.4
 */
export interface ConfirmedRead {
  /** Entity that was read. */
  id: EntityId;

  /** Hash of the fact that was read. */
  hash: Reference;

  /** Version number of that fact. */
  version: number;
}

/**
 * A read from another pending (unconfirmed) commit's writes.
 *
 * @see spec 03-commit-model.md §3.4
 */
export interface PendingRead {
  /** Entity that was read. */
  id: EntityId;

  /** Provisional hash from the pending commit. */
  hash: Reference;

  /** Hash of the pending commit that produced this write. */
  fromCommit: Reference;
}

/**
 * A ClientCommit is the client-submitted record of a transaction.
 * It explicitly separates read dependencies into confirmed and pending
 * tiers for server-side validation.
 *
 * @see spec 03-commit-model.md §3.4
 */
export interface ClientCommit {
  /** Read dependencies, split by tier. */
  reads: {
    confirmed: ConfirmedRead[];
    pending: PendingRead[];
  };

  /** The operations to apply. */
  operations: Operation[];

  /** Optional provenance. */
  codeCID?: Reference;

  /** Target branch (defaults to default branch). */
  branch?: BranchId;
}

// ---------------------------------------------------------------------------
// 8. Result Types (spec 03 §3.6.3, §3.7)
// ---------------------------------------------------------------------------

/**
 * A mapping from entity ID to its current fact entry.
 *
 * @see spec 01-data-model.md
 */
export type FactSet = Record<EntityId, FactEntry>;

/**
 * An entry in a FactSet representing the current state of an entity.
 */
export interface FactEntry {
  value?: JSONValue;
  version: number;
  hash: Reference;
}

/**
 * A committed set of facts with server-assigned metadata.
 *
 * @see spec 03-commit-model.md §3.7
 */
export interface Commit {
  hash: Reference;
  version: number;
  branch: BranchId;
  facts: StoredFact[];
  createdAt: string;
}

/**
 * Detail about a single conflicting entity during commit validation.
 *
 * @see spec 03-commit-model.md §3.6.3
 */
export interface ConflictDetail {
  /** Entity where the conflict occurred. */
  id: EntityId;

  /** What the client thought the current version was. */
  expected: {
    version: number;
    hash: Reference;
  };

  /** What the server's actual current version is. */
  actual: {
    version: number;
    hash: Reference;
    value?: JSONValue;
  };
}

// ---------------------------------------------------------------------------
// 9. Commit Log (spec 03 §3.7.2)
// ---------------------------------------------------------------------------

/**
 * The commit log preserves both the original client submission and the
 * server's resolution metadata.
 *
 * @see spec 03-commit-model.md §3.7.2
 */
export interface CommitLogEntry {
  /** The original commit as submitted by the client. */
  original: ClientCommit;

  /** Server-assigned resolution metadata. */
  resolution: {
    /** Version number assigned to this commit. */
    version: number;

    /**
     * Mapping from provisional commit hashes to their resolved versions.
     * When a pending commit is confirmed, its provisional hash maps to
     * the assigned version number.
     */
    commitResolutions: Map<Reference, number>;

    /**
     * Mapping from provisional fact hashes to final fact hashes.
     * Provisional hashes can differ from final hashes because the hash
     * of a fact includes its parent. If the parent was provisional
     * (from a pending commit), the final hash changes once the parent
     * is resolved.
     */
    hashMappings?: Map<Reference, Reference>;
  };
}

// ---------------------------------------------------------------------------
// 10. Blobs (spec 01 §4, §5)
// ---------------------------------------------------------------------------

/**
 * An immutable, write-once binary blob identified by its content hash.
 *
 * @see spec 01-data-model.md §4
 */
export interface Blob {
  /** Content hash = identity. SHA-256 of the raw bytes. */
  hash: Reference;

  /** Raw binary content. */
  data: Uint8Array;

  /** MIME type, e.g. "image/png", "application/wasm". */
  contentType: string;

  /** Size in bytes (redundant with data.length, stored for indexing). */
  size: number;
}

/**
 * Mutable metadata about a blob, stored as a regular entity.
 *
 * @see spec 01-data-model.md §5
 */
export interface BlobMetadata {
  /** The blob this metadata describes. */
  blob: Reference;

  /** IFC classification labels for information flow control. */
  labels: string[];
}

// ---------------------------------------------------------------------------
// 11. Snapshots (spec 01 §7)
// ---------------------------------------------------------------------------

/**
 * A materialized full value of an entity at a specific version.
 * Snapshots accelerate reads by avoiding full replay of the entity's
 * entire patch history.
 *
 * @see spec 01-data-model.md §7
 */
export interface Snapshot {
  /** The entity this snapshot is for. */
  id: EntityId;

  /** The version (Lamport clock) at which this snapshot was taken. */
  version: number;

  /** Reference to the full value in the value table. */
  valueRef: Reference;

  /** Branch this snapshot belongs to. */
  branch: string;
}

/**
 * Configurable policy for when to create snapshots.
 *
 * @see spec 01-data-model.md §7.1
 */
export interface SnapshotPolicy {
  /** Create a snapshot after this many patches since the last snapshot. Default: 10. */
  patchInterval: number;
}

// ---------------------------------------------------------------------------
// 12. Branches (spec 06 §6.2)
// ---------------------------------------------------------------------------

/**
 * A branch is a lightweight pointer into the shared fact history.
 * Branches share the same fact log and entity history.
 *
 * @see spec 06-branching.md §6.2
 */
export interface Branch {
  /** Unique name within the space. */
  name: BranchName;

  /** Branch this was forked from. */
  parentBranch: BranchName;

  /** Version at which the fork occurred. */
  forkVersion: number;

  /** Latest version committed on this branch. */
  headVersion: number;

  /** Timestamp of branch creation. */
  createdAt: number;

  /** Soft-delete flag. */
  status: "active" | "deleted";
}

/**
 * Conflict detail when merging two branches that both modified the same entity.
 *
 * @see spec 06-branching.md §6.8.1
 */
export interface BranchConflict {
  entityId: EntityId;
  sourceValue: JSONValue | null;
  targetValue: JSONValue | null;
  ancestorValue: JSONValue | null;
  sourceVersion: number;
  targetVersion: number;
}

/**
 * Result of a branch merge operation.
 *
 * @see spec 06-branching.md §6.7.1
 */
export interface MergeResult {
  status: "success" | "conflict";
  mergeCommit?: Reference;
  conflicts?: BranchConflict[];
}
