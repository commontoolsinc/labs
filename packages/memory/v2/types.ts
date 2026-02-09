/**
 * Memory v2 Core Types
 *
 * Defines all data model types from the Memory v2 specification (§01).
 * This is a clean break from v1 — no backward compatibility.
 */

import type { Reference as MerkleReference } from "merkle-reference";

// ─── Primitives ──────────────────────────────────────────────────────────────

/** Entity identifier. URI format, unique within a space. */
export type EntityId = string;

/** Content-addressed reference (SHA-256, base32-lower, "bafk..." prefix). */
export type Reference = MerkleReference;

/** Branch identifier string. */
export type BranchId = string;

/** Human-readable branch name ('' for the default branch). */
export type BranchName = string;

/** A decentralized identifier for a space. */
export type SpaceId = `did:${string}`;

/** A decentralized identifier (generic). */
export type DID = `did:${string}`;

/** Any valid JSON value. */
export type JSONValue =
  | null
  | boolean
  | number
  | string
  | JSONValue[]
  | { [key: string]: JSONValue };

/** A JSON Schema definition. */
export type JSONSchema =
  | boolean
  | {
    type?: string;
    properties?: Record<string, JSONSchema>;
    items?: JSONSchema;
    [key: string]: unknown;
  };

// ─── Facts ───────────────────────────────────────────────────────────────────

/**
 * A Write that sets the entity's value by full replacement.
 */
export interface SetWrite {
  type: "set";
  id: EntityId;
  value: JSONValue;
  parent: Reference;
}

/**
 * A Write that modifies the entity's value incrementally via patches.
 */
export interface PatchWrite {
  type: "patch";
  id: EntityId;
  ops: PatchOp[];
  parent: Reference;
}

export type Write = SetWrite | PatchWrite;

/**
 * A Delete fact tombstones an entity.
 */
export interface Delete {
  type: "delete";
  id: EntityId;
  parent: Reference;
}

/** A fact records a single state transition for an entity. */
export type Fact = Write | Delete;

/** A fact's type discriminant. */
export type FactType = "set" | "patch" | "delete";

/**
 * When a fact is committed, the server assigns additional metadata.
 */
export interface StoredFact {
  hash: Reference;
  fact: Fact;
  version: number;
  commitHash: Reference;
}

// ─── Patch Operations (JSON Patch + splice extension) ────────────────────────

export type JSONPointer = string;

export interface ReplaceOp {
  op: "replace";
  path: JSONPointer;
  value: JSONValue;
}

export interface AddOp {
  op: "add";
  path: JSONPointer;
  value: JSONValue;
}

export interface RemoveOp {
  op: "remove";
  path: JSONPointer;
}

export interface MoveOp {
  op: "move";
  from: JSONPointer;
  path: JSONPointer;
}

/**
 * Extension operation: array splice.
 */
export interface SpliceOp {
  op: "splice";
  path: JSONPointer;
  index: number;
  remove: number;
  add: JSONValue[];
}

export type PatchOp = ReplaceOp | AddOp | RemoveOp | MoveOp | SpliceOp;

// ─── Operations (in transactions) ────────────────────────────────────────────

export interface SetOperation {
  op: "set";
  id: EntityId;
  value: JSONValue;
  parent?: Reference;
}

export interface PatchWriteOperation {
  op: "patch";
  id: EntityId;
  patches: PatchOp[];
  parent?: Reference;
}

export interface DeleteOperation {
  op: "delete";
  id: EntityId;
  parent?: Reference;
}

export interface ClaimOperation {
  op: "claim";
  id: EntityId;
  parent?: Reference;
}

export type Operation =
  | SetOperation
  | PatchWriteOperation
  | DeleteOperation
  | ClaimOperation;

// ─── Transactions & Commits ──────────────────────────────────────────────────

export interface Transaction {
  operations: Operation[];
  codeCID?: Reference;
  branch?: BranchId;
}

export interface ConfirmedRead {
  id: EntityId;
  hash: Reference;
  version: number;
}

export interface PendingRead {
  id: EntityId;
  hash: Reference;
  fromCommit: Reference;
}

export interface ClientCommit {
  reads: {
    confirmed: ConfirmedRead[];
    pending: PendingRead[];
  };
  operations: Operation[];
  codeCID?: Reference;
  branch?: BranchId;
}

/**
 * Server-side commit result returned after a successful transaction.
 */
export interface Commit {
  hash: Reference;
  version: number;
  branch: BranchId;
  facts: StoredFact[];
  createdAt: string;
}

/**
 * Commit log entry preserving both original submission and resolution.
 */
export interface CommitLogEntry {
  original: ClientCommit;
  resolution: {
    version: number;
    commitResolutions: Map<Reference, number>;
    hashMappings?: Map<Reference, Reference>;
  };
}

// ─── Queries & Selectors ─────────────────────────────────────────────────────

/**
 * A selector defines a pattern for matching entities.
 * Two-level: entity ID -> match specification.
 */
export type Selector = Record<EntityId | "*", EntityMatch>;

export interface EntityMatch {
  parent?: Reference | "*";
}

/**
 * Schema-driven query selector.
 */
export type SchemaSelector = Record<EntityId | "*", SchemaPathSelector>;

export interface SchemaPathSelector {
  path: readonly string[];
  schema?: JSONSchema;
}

// ─── Query Results ───────────────────────────────────────────────────────────

/**
 * Facts organized by entity id (flat, no MIME type level).
 */
export interface FactSet {
  [entityId: EntityId]: FactEntry;
}

/**
 * A single fact entry in a query result.
 */
export interface FactEntry {
  value?: JSONValue;
  version: number;
  hash: Reference;
}

// ─── Snapshots ───────────────────────────────────────────────────────────────

export interface Snapshot {
  id: EntityId;
  version: number;
  valueRef: Reference;
  branch: string;
}

export interface SnapshotPolicy {
  patchInterval: number; // Default: 10
}

// ─── Branches ────────────────────────────────────────────────────────────────

/** Default (main) branch name — empty string in the DB. */
export const DEFAULT_BRANCH = "";

export interface Branch {
  name: BranchName;
  parentBranch: BranchName | null;
  forkVersion: number | null;
  headVersion: number;
  createdAt: string;
}

export interface BranchInfo {
  name: BranchName;
  headVersion: number;
  createdAt: string;
}

// ─── Blobs ───────────────────────────────────────────────────────────────────

export interface Blob {
  hash: Reference;
  data: Uint8Array;
  contentType: string;
  size: number;
}

export interface BlobMetadata {
  blob: Reference;
  labels: string[];
}

// ─── Errors ──────────────────────────────────────────────────────────────────

export interface ConflictDetail {
  id: EntityId;
  expected: { version: number; hash: Reference };
  actual: { version: number; hash: Reference; value?: JSONValue };
}

export interface ConflictError extends Error {
  name: "ConflictError";
  commit: ClientCommit;
  conflicts: ConflictDetail[];
}

export interface TransactionError extends Error {
  name: "TransactionError";
  cause: Error;
  transaction: ClientCommit;
}

export interface QueryError extends Error {
  name: "QueryError";
  cause: Error;
  space: SpaceId;
  selector: Selector | SchemaSelector;
}

// ─── Validation ──────────────────────────────────────────────────────────────

export type ValidationResult =
  | { valid: true }
  | { valid: false; conflicts: ConflictDetail[] }
  | { valid: false; pendingDependency: Reference }
  | { valid: false; cascadedRejection: Reference };

// ─── Internal DB Row Types ───────────────────────────────────────────────────

export interface HeadRow {
  branch: string;
  id: string;
  fact_hash: string;
  version: number;
}

export interface FactRow {
  hash: string;
  id: string;
  value_ref: string;
  parent: string | null;
  branch: string;
  version: number;
  commit_ref: string;
  fact_type: string;
}

export interface ValueRow {
  hash: string;
  data: string | null;
}

export interface CommitRow {
  hash: string;
  version: number;
  branch: string;
  reads: string | null;
  created_at: string;
}

export interface SnapshotRow {
  id: string;
  version: number;
  value_ref: string;
  branch: string;
}

export interface BranchRow {
  name: string;
  parent_branch: string | null;
  fork_version: number | null;
  head_version: number;
  created_at: string;
}
