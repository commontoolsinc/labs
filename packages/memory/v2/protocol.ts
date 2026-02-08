/**
 * Memory v2 Protocol Types
 *
 * Defines the wire format for client-server communication.
 * Commands use UCAN invocations; responses use task/return and task/effect.
 * From spec §04.
 */

import type {
  BranchInfo,
  BranchName,
  ClientCommit,
  Commit,
  ConflictDetail,
  FactSet,
  SchemaSelector,
  Selector,
  SpaceId,
  StoredFact,
} from "./types.ts";

// ─── Invocation IDs ──────────────────────────────────────────────────────────

/** Invocation ID format: job:<content-hash> */
export type InvocationId = `job:${string}`;

// ─── Commands (Client → Server) ──────────────────────────────────────────────

/** Transact: submit operations as a ClientCommit. */
export interface TransactCommand {
  cmd: "/memory/transact";
  sub: SpaceId;
  args: ClientCommit;
}

/** Query: read entities matching a selector. */
export interface QueryCommand {
  cmd: "/memory/query";
  sub: SpaceId;
  args: {
    select: Selector;
    since?: number;
    branch?: string;
  };
}

/** Subscribe: persistent query with incremental updates. */
export interface SubscribeCommand {
  cmd: "/memory/query/subscribe";
  sub: SpaceId;
  args: {
    select: Selector;
    since?: number;
    branch?: string;
  };
}

/** Unsubscribe: cancel an active subscription. */
export interface UnsubscribeCommand {
  cmd: "/memory/query/unsubscribe";
  sub: SpaceId;
  args: {
    source: InvocationId;
  };
}

/** Graph query: schema-driven traversal with optional subscription. */
export interface GraphQueryCommand {
  cmd: "/memory/graph/query";
  sub: SpaceId;
  args: {
    selectSchema: SchemaSelector;
    since?: number;
    subscribe?: boolean;
    excludeSent?: boolean;
    branch?: string;
  };
}

/** Create branch. */
export interface CreateBranchCommand {
  cmd: "/memory/branch/create";
  sub: SpaceId;
  args: {
    name: BranchName;
    fromBranch?: BranchName;
    atVersion?: number;
  };
}

/** Delete branch. */
export interface DeleteBranchCommand {
  cmd: "/memory/branch/delete";
  sub: SpaceId;
  args: {
    name: BranchName;
  };
}

/** List branches. */
export interface ListBranchesCommand {
  cmd: "/memory/branch/list";
  sub: SpaceId;
  args: {
    includeDeleted?: boolean;
  };
}

/** Union of all commands. */
export type Command =
  | TransactCommand
  | QueryCommand
  | SubscribeCommand
  | UnsubscribeCommand
  | GraphQueryCommand
  | CreateBranchCommand
  | DeleteBranchCommand
  | ListBranchesCommand;

// ─── Responses (Server → Client) ─────────────────────────────────────────────

/** Final result for a command. */
export interface TaskReturn<Result> {
  the: "task/return";
  of: InvocationId;
  is: Result;
}

/** Subscription update pushed by server. */
export interface TaskEffect<Effect> {
  the: "task/effect";
  of: InvocationId;
  is: Effect;
}

export type Receipt<Result, Effect> =
  | TaskReturn<Result>
  | TaskEffect<Effect>;

// ─── Result Types ────────────────────────────────────────────────────────────

export interface TransactSuccess {
  ok: Commit;
}

export interface TransactError {
  error: {
    name: "ConflictError";
    commit: ClientCommit;
    conflicts: ConflictDetail[];
  } | {
    name: "TransactionError";
    message: string;
  };
}

export type TransactResult = TransactSuccess | TransactError;

export interface QuerySuccess {
  ok: FactSet;
}

export interface QueryError {
  error: {
    name: "QueryError";
    message: string;
  };
}

export type QueryResult = QuerySuccess | QueryError;

export interface SubscriptionUpdate {
  commit: Commit;
  revisions: StoredFact[];
}

export interface CreateBranchSuccess {
  ok: {
    name: BranchName;
    forkedFrom: BranchName;
    atVersion: number;
  };
}

export interface ListBranchesSuccess {
  ok: {
    branches: BranchInfo[];
  };
}

// ─── Provider Command (any server→client message) ────────────────────────────

export type ProviderMessage =
  | TaskReturn<TransactResult>
  | TaskReturn<QueryResult>
  | TaskReturn<CreateBranchSuccess>
  | TaskReturn<ListBranchesSuccess>
  | TaskReturn<{ ok: Record<string, never> }>
  | TaskEffect<SubscriptionUpdate>;
