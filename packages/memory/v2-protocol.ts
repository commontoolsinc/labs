/**
 * Memory v2 Wire Protocol Types
 *
 * Defines the message types for client-server communication over
 * WebSocket and HTTP transports. All commands are UCAN invocations.
 *
 * @see spec 04-protocol.md
 * @module v2-protocol
 */

import type {
  BranchName,
  Commit,
  ConflictDetail,
  DID,
  EntityId,
  FactSet,
  JSONSchema,
  JSONValue,
  Reference,
  SpaceId,
  StoredFact,
} from "./v2-types.ts";

// ---------------------------------------------------------------------------
// Invocation envelope
// ---------------------------------------------------------------------------

export type InvocationId = `job:${string}`;

export interface Command<
  Ability extends string = string,
  Args extends Record<string, unknown> = Record<string, unknown>,
> {
  cmd: Ability;
  sub: SpaceId;
  args: Args;
  iss: DID;
  prf: unknown[];
  iat?: number;
  exp?: number;
  nonce?: Uint8Array;
  meta?: Record<string, string>;
}

export interface Authorization {
  signature: unknown;
  access: unknown;
}

export interface ClientMessage<Cmd extends Command = Command> {
  invocation: Cmd;
  authorization: Authorization;
}

// ---------------------------------------------------------------------------
// Server responses
// ---------------------------------------------------------------------------

export interface TaskReturn<Result> {
  the: "task/return";
  of: InvocationId;
  is: Result;
}

export interface TaskEffect<Effect> {
  the: "task/effect";
  of: InvocationId;
  is: Effect;
}

export type Receipt<Result, Effect = never> =
  | TaskReturn<Result>
  | TaskEffect<Effect>;

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

export type Selector = { [key: string]: EntityMatch };

export interface EntityMatch {
  parent?: Reference | "*";
}

export interface SchemaPathSelector {
  path: readonly string[];
  schema?: JSONSchema | boolean;
}

export type SchemaSelector = { [key: string]: SchemaPathSelector };

// ---------------------------------------------------------------------------
// User operations (wire format, parent-free)
// ---------------------------------------------------------------------------

export interface UserSetOperation {
  op: "set";
  id: EntityId;
  value: JSONValue;
}

export interface UserPatchOperation {
  op: "patch";
  id: EntityId;
  patches: unknown[];
}

export interface UserDeleteOperation {
  op: "delete";
  id: EntityId;
}

export interface UserClaimOperation {
  op: "claim";
  id: EntityId;
}

export type UserOperation =
  | UserSetOperation
  | UserPatchOperation
  | UserDeleteOperation
  | UserClaimOperation;

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

// --- transact ---

export interface TransactCommand extends Command<"/memory/transact"> {
  cmd: "/memory/transact";
  args: {
    reads: {
      confirmed: Array<{ id: EntityId; hash: string; version: number }>;
      pending: Array<{ id: EntityId; hash: string; fromCommit: string }>;
    };
    operations: UserOperation[];
    codeCID?: string;
    branch?: string;
  };
}

export interface TransactSuccess {
  ok: Commit;
}

export interface TransactConflictError {
  error: {
    name: "ConflictError";
    conflicts: ConflictDetail[];
  };
}

export interface TransactTransactionError {
  error: {
    name: "TransactionError";
    cause: { code: number; message?: string };
  };
}

export type TransactResult =
  | TransactSuccess
  | TransactConflictError
  | TransactTransactionError;

// --- query ---

export interface QueryCommand extends Command<"/memory/query"> {
  cmd: "/memory/query";
  args: {
    select: Selector;
    since?: number;
    branch?: string;
  };
}

export interface QuerySuccess {
  ok: FactSet;
}

export type QueryResult =
  | QuerySuccess
  | { error: { name: "QueryError"; message: string } };

// --- subscribe ---

export interface SubscribeCommand extends Command<"/memory/query/subscribe"> {
  cmd: "/memory/query/subscribe";
  args: {
    select: Selector;
    since?: number;
    branch?: string;
  };
}

export interface SubscribeSuccess {
  ok: FactSet;
}

export interface SubscriptionUpdate {
  commit: Commit;
  revisions: StoredFact[];
}

// --- unsubscribe ---

export interface UnsubscribeCommand
  extends Command<"/memory/query/unsubscribe"> {
  cmd: "/memory/query/unsubscribe";
  args: {
    source: InvocationId;
  };
}

export interface UnsubscribeSuccess {
  ok: Record<string, never>;
}

// --- graph query ---

export interface GraphQueryCommand extends Command<"/memory/graph/query"> {
  cmd: "/memory/graph/query";
  args: {
    selectSchema: SchemaSelector;
    since?: number;
    subscribe?: boolean;
    excludeSent?: boolean;
    branch?: string;
  };
}

export interface GraphQuerySuccess {
  ok: FactSet;
}

// --- branch lifecycle ---

export interface CreateBranchCommand extends Command<"/memory/branch/create"> {
  cmd: "/memory/branch/create";
  args: {
    name: BranchName;
    fromBranch?: BranchName;
    atVersion?: number;
  };
}

export interface CreateBranchResult {
  ok: {
    name: BranchName;
    forkedFrom: BranchName;
    atVersion: number;
  };
}

export interface MergeBranchCommand extends Command<"/memory/branch/merge"> {
  cmd: "/memory/branch/merge";
  args: {
    source: BranchName;
    target: BranchName;
    resolutions?: Record<EntityId, JSONValue | null>;
  };
}

export interface MergeBranchResult {
  ok: {
    commit: Commit;
    merged: number;
  };
}

export interface DeleteBranchCommand extends Command<"/memory/branch/delete"> {
  cmd: "/memory/branch/delete";
  args: {
    name: BranchName;
  };
}

export interface ListBranchesCommand extends Command<"/memory/branch/list"> {
  cmd: "/memory/branch/list";
  args: {
    includeDeleted?: boolean;
  };
}

export interface BranchInfo {
  name: BranchName;
  headVersion: number;
  createdAt: string;
  deletedAt?: string;
}

export interface ListBranchesResult {
  ok: {
    branches: BranchInfo[];
  };
}

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export interface AuthorizationError {
  name: "AuthorizationError";
  message?: string;
}

export interface ConnectionError {
  name: "ConnectionError";
  cause: { code: number; message?: string };
  address: string;
}

export interface RateLimitError {
  name: "RateLimitError";
  retryAfter: number;
}

// ---------------------------------------------------------------------------
// Union of all commands
// ---------------------------------------------------------------------------

export type V2Command =
  | TransactCommand
  | QueryCommand
  | SubscribeCommand
  | UnsubscribeCommand
  | GraphQueryCommand
  | CreateBranchCommand
  | MergeBranchCommand
  | DeleteBranchCommand
  | ListBranchesCommand;
