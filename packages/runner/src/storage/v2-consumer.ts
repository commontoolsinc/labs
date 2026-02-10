/**
 * V2 Consumer - Client-side command encoding for the v2 protocol.
 *
 * Encodes v2 commands (transact, query, subscribe, graphQuery) into the
 * wire format and parses server responses. This is the runner-side client
 * for communicating with a v2 memory provider.
 *
 * @see spec 04-protocol.md
 * @module v2-consumer
 */

import type {
  ClientCommit,
  Commit,
  ConflictDetail,
  EntityId,
  FactSet,
  JSONSchema,
  JSONValue,
  SpaceId,
  StoredFact,
} from "@commontools/memory/v2-types";

// ---------------------------------------------------------------------------
// Wire format types (matching v2-protocol.ts)
// ---------------------------------------------------------------------------

/** Invocation ID for correlating responses. */
export type InvocationId = `job:${string}`;

/** Wire-format user operation (no parent field). */
export type UserOperation =
  | { op: "set"; id: EntityId; value: JSONValue }
  | { op: "patch"; id: EntityId; patches: unknown[] }
  | { op: "delete"; id: EntityId }
  | { op: "claim"; id: EntityId };

/** Schema path selector for graph queries. */
export interface SchemaPathSelector {
  path: readonly string[];
  schema?: JSONSchema | boolean;
}

/** Schema selector maps entity IDs to schema path selectors. */
export type SchemaSelector = { [key: string]: SchemaPathSelector };

/** Selector for simple queries. */
export type Selector = { [key: string]: Record<string, unknown> };

// ---------------------------------------------------------------------------
// Command builders
// ---------------------------------------------------------------------------

export interface TransactCommandArgs {
  reads: ClientCommit["reads"];
  operations: UserOperation[];
  codeCID?: string;
  branch?: string;
}

export interface QueryCommandArgs {
  select: Selector;
  since?: number;
  branch?: string;
}

export interface SubscribeCommandArgs {
  select: Selector;
  since?: number;
  branch?: string;
}

export interface GraphQueryCommandArgs {
  selectSchema: SchemaSelector;
  since?: number;
  subscribe?: boolean;
  excludeSent?: boolean;
  branch?: string;
}

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

export interface TransactSuccess {
  ok: Commit;
}

export interface TransactConflictError {
  error: {
    name: "ConflictError";
    conflicts: ConflictDetail[];
  };
}

export type TransactResult =
  | TransactSuccess
  | TransactConflictError
  | { error: unknown };

export interface QuerySuccess {
  ok: FactSet;
}

export type QueryResult = QuerySuccess | { error: unknown };

export interface SubscriptionUpdate {
  commit: Commit;
  revisions: StoredFact[];
}

// ---------------------------------------------------------------------------
// Command encoding
// ---------------------------------------------------------------------------

/**
 * Build a transact command for the wire protocol.
 */
export function buildTransactCommand(
  spaceId: SpaceId,
  args: TransactCommandArgs,
): { cmd: "/memory/transact"; sub: SpaceId; args: TransactCommandArgs } {
  return {
    cmd: "/memory/transact",
    sub: spaceId,
    args,
  };
}

/**
 * Build a query command for the wire protocol.
 */
export function buildQueryCommand(
  spaceId: SpaceId,
  args: QueryCommandArgs,
): { cmd: "/memory/query"; sub: SpaceId; args: QueryCommandArgs } {
  return {
    cmd: "/memory/query",
    sub: spaceId,
    args,
  };
}

/**
 * Build a subscribe command for the wire protocol.
 */
export function buildSubscribeCommand(
  spaceId: SpaceId,
  args: SubscribeCommandArgs,
): {
  cmd: "/memory/query/subscribe";
  sub: SpaceId;
  args: SubscribeCommandArgs;
} {
  return {
    cmd: "/memory/query/subscribe",
    sub: spaceId,
    args,
  };
}

/**
 * Build an unsubscribe command for the wire protocol.
 */
export function buildUnsubscribeCommand(
  spaceId: SpaceId,
  source: InvocationId,
): {
  cmd: "/memory/query/unsubscribe";
  sub: SpaceId;
  args: { source: InvocationId };
} {
  return {
    cmd: "/memory/query/unsubscribe",
    sub: spaceId,
    args: { source },
  };
}

/**
 * Build a graph query command for the wire protocol.
 */
export function buildGraphQueryCommand(
  spaceId: SpaceId,
  args: GraphQueryCommandArgs,
): { cmd: "/memory/graph/query"; sub: SpaceId; args: GraphQueryCommandArgs } {
  return {
    cmd: "/memory/graph/query",
    sub: spaceId,
    args,
  };
}

// ---------------------------------------------------------------------------
// Branch command builders
// ---------------------------------------------------------------------------

export interface CreateBranchCommandArgs {
  name: string;
  fromBranch?: string;
  atVersion?: number;
}

export interface MergeBranchCommandArgs {
  source: string;
  target: string;
  resolutions?: Record<EntityId, JSONValue | null>;
}

export interface DeleteBranchCommandArgs {
  name: string;
}

export interface ListBranchesCommandArgs {
  includeDeleted?: boolean;
}

/**
 * Build a create-branch command for the wire protocol.
 */
export function buildCreateBranchCommand(
  spaceId: SpaceId,
  args: CreateBranchCommandArgs,
): {
  cmd: "/memory/branch/create";
  sub: SpaceId;
  args: CreateBranchCommandArgs;
} {
  return {
    cmd: "/memory/branch/create",
    sub: spaceId,
    args,
  };
}

/**
 * Build a merge-branch command for the wire protocol.
 */
export function buildMergeBranchCommand(
  spaceId: SpaceId,
  args: MergeBranchCommandArgs,
): {
  cmd: "/memory/branch/merge";
  sub: SpaceId;
  args: MergeBranchCommandArgs;
} {
  return {
    cmd: "/memory/branch/merge",
    sub: spaceId,
    args,
  };
}

/**
 * Build a delete-branch command for the wire protocol.
 */
export function buildDeleteBranchCommand(
  spaceId: SpaceId,
  args: DeleteBranchCommandArgs,
): {
  cmd: "/memory/branch/delete";
  sub: SpaceId;
  args: DeleteBranchCommandArgs;
} {
  return {
    cmd: "/memory/branch/delete",
    sub: spaceId,
    args,
  };
}

/**
 * Build a list-branches command for the wire protocol.
 */
export function buildListBranchesCommand(
  spaceId: SpaceId,
  args: ListBranchesCommandArgs = {},
): {
  cmd: "/memory/branch/list";
  sub: SpaceId;
  args: ListBranchesCommandArgs;
} {
  return {
    cmd: "/memory/branch/list",
    sub: spaceId,
    args,
  };
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

/**
 * Parse a transact response from the server.
 */
export function parseTransactResult(response: unknown): TransactResult {
  const res = response as Record<string, unknown>;
  if ("ok" in res) {
    return { ok: res.ok as Commit };
  }
  if ("error" in res) {
    const err = res.error as Record<string, unknown>;
    if (err.name === "ConflictError") {
      return {
        error: {
          name: "ConflictError",
          conflicts: (err.conflicts ?? []) as ConflictDetail[],
        },
      };
    }
    return { error: err };
  }
  return { error: { name: "UnknownError", message: "Invalid response" } };
}

/**
 * Parse a query response from the server.
 */
export function parseQueryResult(response: unknown): QueryResult {
  const res = response as Record<string, unknown>;
  if ("ok" in res) {
    return { ok: res.ok as FactSet };
  }
  return { error: res.error ?? { name: "UnknownError" } };
}

// ---------------------------------------------------------------------------
// Branch response types
// ---------------------------------------------------------------------------

export interface CreateBranchResult {
  ok: {
    name: string;
    forkedFrom: string;
    atVersion: number;
  };
}

export interface MergeBranchResult {
  ok: {
    commit: Commit;
    merged: number;
  };
}

export interface BranchInfoResult {
  name: string;
  headVersion: number;
  createdAt: string;
  deletedAt?: string;
}

export interface ListBranchesResult {
  ok: {
    branches: BranchInfoResult[];
  };
}

/**
 * Parse a create-branch response from the server.
 */
export function parseCreateBranchResult(
  response: unknown,
): CreateBranchResult | { error: unknown } {
  const res = response as Record<string, unknown>;
  if ("ok" in res) {
    return { ok: res.ok as CreateBranchResult["ok"] };
  }
  return { error: res.error ?? { name: "UnknownError" } };
}

/**
 * Parse a merge-branch response from the server.
 */
export function parseMergeBranchResult(
  response: unknown,
): MergeBranchResult | { error: unknown } {
  const res = response as Record<string, unknown>;
  if ("ok" in res) {
    return { ok: res.ok as MergeBranchResult["ok"] };
  }
  return { error: res.error ?? { name: "UnknownError" } };
}

/**
 * Parse a list-branches response from the server.
 */
export function parseListBranchesResult(
  response: unknown,
): ListBranchesResult | { error: unknown } {
  const res = response as Record<string, unknown>;
  if ("ok" in res) {
    return { ok: res.ok as ListBranchesResult["ok"] };
  }
  return { error: res.error ?? { name: "UnknownError" } };
}
