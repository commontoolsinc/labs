import {
  type EntityRef,
  getModernCellRepConfig,
} from "@commonfabric/data-model/cell-rep";
import {
  jsonFromValue,
  valueFromJson,
} from "@commonfabric/data-model/codec-json";
import { internPathSelector } from "@commonfabric/data-model/schema-utils";
import type { FabricValue, SchemaPathSelector } from "@commonfabric/api";
import { EmptyReconstructionContext } from "@commonfabric/data-model/codec-common";
import { isObject, isRecord } from "@commonfabric/utils/types";

export const MEMORY_PROTOCOL = "memory" as const;
export const DEFAULT_BRANCH = "" as const;

export type EntityId = string;
export type BranchName = string;
export type SessionId = string;
export type SessionToken = string;
export type CellScope = "space" | "user" | "session";
export type JobId = `job:${string}`;
export type Reference = string & {
  readonly __memoryV2Reference: unique symbol;
};
export type DocumentPath = readonly string[] & {
  readonly __memoryV2DocumentPath: unique symbol;
};
export type ValuePath = readonly string[] & {
  readonly __memoryV2ValuePath: unique symbol;
};
export type ReadPath = DocumentPath;
export type DocumentSchemaPathSelector =
  & Omit<SchemaPathSelector, "path">
  & { path: DocumentPath };
export type ValueSchemaPathSelector =
  & Omit<SchemaPathSelector, "path">
  & { path: ValuePath };

/**
 * A logical stored document. Today the system only produces and consumes the
 * `value` field; `source` and any additional metadata fields are reserved for
 * future use and carried as opaque payload (a document is validated merely as
 * "an object" — see {@link isEntityDocument}).
 */
export interface EntityDocument {
  value?: FabricValue;
  source?: EntityRef;
  [key: string]: FabricValue;
}

export interface Blob {
  hash: Reference;
  value: Uint8Array;
  contentType: string;
  size: number;
}

export type PatchOp =
  | { op: "replace"; path: string; value: FabricValue }
  | { op: "add"; path: string; value: FabricValue }
  | { op: "remove"; path: string }
  | { op: "move"; from: string; path: string }
  | {
    op: "splice";
    path: string;
    index: number;
    remove: number;
    add: FabricValue[];
  };

export interface SetOperation {
  op: "set";
  id: EntityId;
  scope?: CellScope;
  value: EntityDocument;
}

export interface PatchOperation {
  op: "patch";
  id: EntityId;
  scope?: CellScope;
  patches: PatchOp[];
}

export interface DeleteOperation {
  op: "delete";
  id: EntityId;
  scope?: CellScope;
}

/**
 * A SQLite write folded into the commit, applied inside the same transaction as
 * the cell ops (atomic). It is NOT an entity revision — it has no `id` and never
 * enters the revision/head/snapshot/dirty machinery (see SqliteDbRef below /
 * docs/specs/sqlite-builtin/plans/atomic-writes.md).
 */
export interface SqliteOperation {
  op: "sqlite";
  db: SqliteDbRef;
  sql: string;
  params?: SqliteParamsWire;
}

export type Operation =
  | SetOperation
  | PatchOperation
  | DeleteOperation
  | SqliteOperation;

export interface ConfirmedRead {
  id: EntityId;
  scope?: CellScope;
  branch?: BranchName;
  path: ReadPath;
  seq: number;
}

export interface PendingRead {
  id: EntityId;
  scope?: CellScope;
  path: ReadPath;
  localSeq: number;
}

export interface SchedulerObservationCommit {
  localSeq: number;
  reads: {
    confirmed: ConfirmedRead[];
    pending: PendingRead[];
  };
  schedulerObservation: unknown;
}

export type CommitPrecondition =
  | {
    kind: "origin-committed";
    /** localSeq of a commit from the SAME session in this space. */
    originLocalSeq: number;
  }
  | {
    kind: "entity-absent";
    id: EntityId;
    scope?: CellScope;
  };

export interface ClientCommit {
  localSeq: number;
  reads: {
    confirmed: ConfirmedRead[];
    pending: PendingRead[];
  };
  operations: Operation[];
  preconditions?: CommitPrecondition[];
  schedulerObservation?: unknown;
  schedulerObservationBatch?: SchedulerObservationCommit[];
  codeCID?: Reference;
  branch?: BranchName;
  merge?: {
    sourceBranch: BranchName;
    sourceSeq: number;
    baseBranch: BranchName;
    baseSeq: number;
  };
}

export interface SessionOpenArgs {
  sessionId?: SessionId;
  seenSeq?: number;
  sessionToken?: SessionToken;
}

export interface SessionOpenCommand {
  cmd: "session.open";
  id: JobId;
  protocol: typeof MEMORY_PROTOCOL;
  args: SessionOpenArgs;
}

export interface SessionOpenResult {
  sessionId: SessionId;
  sessionToken: SessionToken;
  serverSeq: number;
  resumed?: boolean;
  sync?: SessionSync;
}

export interface MemoryProtocolFlags {
  modernCellRep: boolean;
  persistentSchedulerState: boolean;
  commitPreconditions: boolean;
}

/**
 * Wire-format flags object.
 */
export type WireMemoryProtocolFlags = {
  modernCellRep?: boolean;
  persistentSchedulerState?: boolean;
  commitPreconditions?: boolean;
};

export interface HelloMessage {
  type: "hello";
  protocol: typeof MEMORY_PROTOCOL;
  flags: WireMemoryProtocolFlags;
}

export interface HelloOkMessage {
  type: "hello.ok";
  protocol: typeof MEMORY_PROTOCOL;
  flags: WireMemoryProtocolFlags;
}

export interface SessionDescriptor {
  sessionId?: SessionId;
  seenSeq?: number;
  sessionToken?: SessionToken;
}

export interface SessionOpenRequest {
  type: "session.open";
  requestId: string;
  space: string;
  session: SessionDescriptor;
  invocation?: Record<string, unknown>;
  authorization?: FabricValue;
}

export interface GraphQueryRoot {
  id: EntityId;
  scope?: CellScope;
  selector: SchemaPathSelector;
}

export interface GraphQuery {
  roots: GraphQueryRoot[];
  atSeq?: number;
  branch?: BranchName;
  excludeSent?: boolean;
}

export interface EntitySnapshot {
  branch: BranchName;
  id: EntityId;
  scope?: CellScope;
  seq: number;
  document: EntityDocument | null;
}

export interface GraphQueryResult {
  serverSeq: number;
  entities: EntitySnapshot[];
}

export interface QueryWatchSpec {
  id: string;
  kind: "query";
  query: GraphQuery;
}

export interface GraphWatchSpec {
  id: string;
  kind: "graph";
  query: GraphQuery;
}

export type WatchSpec = QueryWatchSpec | GraphWatchSpec;

export interface SessionSyncUpsert {
  branch: BranchName;
  id: EntityId;
  scope?: CellScope;
  seq: number;
  doc?: EntityDocument;
  deleted?: true;
}

export interface SessionSyncRemove {
  branch: BranchName;
  id: EntityId;
  scope?: CellScope;
}

export interface SessionSync {
  type: "sync";
  fromSeq: number;
  toSeq: number;
  upserts: SessionSyncUpsert[];
  removes: SessionSyncRemove[];
}

export interface WatchSetResult {
  serverSeq: number;
  sync: SessionSync;
}

export interface WatchAddResult {
  serverSeq: number;
  sync: SessionSync;
}

export interface SessionAckResult {
  serverSeq: number;
}

export interface TransactRequest {
  type: "transact";
  requestId: string;
  space: string;
  sessionId: SessionId;
  commit: ClientCommit;
}

export interface GraphQueryRequest {
  type: "graph.query";
  requestId: string;
  space: string;
  sessionId: SessionId;
  query: GraphQuery;
}

// --- SQLite builtins (docs/specs/sqlite-builtin) ---

/** Wire form of SQLite bind parameters. */
export type SqliteParamsWire = ReadonlyArray<unknown> | Record<string, unknown>;

/** Reference to a cell-derived SQLite database: an opaque id (the handle cell's
 *  entity id) plus the declared table schemas (for additive create/migrate).
 *
 *  `scope` is the SqliteDb cell's declared scope (space/user/session). The
 *  server folds it (with the request's principal / session id) into the on-disk
 *  filename so a `user`/`session`-scoped db gets a per-user / per-session file;
 *  `space` (or absent) keeps the original unqualified name. */
export interface SqliteDbRef {
  id: string;
  tables?: Record<string, unknown>;
  scope?: CellScope;
  /** The db's owner — the principal that created the SqliteDb cell. Resolves
   *  the per-row label rule's `dbOwner()` term (CFC Phase 3); a FIXED db
   *  property, captured once at handle creation, never the acting reader. */
  owner?: string;
}

export interface SqliteQueryRequest {
  type: "sqlite.query";
  requestId: string;
  space: string;
  sessionId: SessionId;
  db: SqliteDbRef;
  sql: string;
  params?: SqliteParamsWire;
}

/** A result column's output name plus its TRUE source `(table, column)` origin
 *  (null for an expression/computed/compound column). */
export interface SqliteResultColumn {
  output: string;
  table: string | null;
  column: string | null;
}

/** Whether a column's `ifc` annotation is present and non-empty — the single
 *  predicate for "this column participates in CFC labeling". Shared by the
 *  server's declares-ifc gate (which decides whether to capture column origins)
 *  and the runner's per-column label schema, so the two can't drift. */
export function columnDeclaresIfc(ifc: unknown): boolean {
  return !!ifc && typeof ifc === "object" && Object.keys(ifc).length > 0;
}

/** Whether a table schema carries a per-row label rule (CFC Phase 3). */
export function tableDeclaresRowLabel(table: unknown): boolean {
  if (!table || typeof table !== "object") return false;
  const spec = (table as { rowLabel?: unknown }).rowLabel;
  return !!spec && typeof spec === "object";
}

/** Whether a read of this db needs sound per-result-column provenance for CFC
 *  labeling: any column declares `ifc` (Phase 2) OR any table declares a
 *  per-row label rule (Phase 3 — the rule's input columns are located by TRUE
 *  origin, never output name). The single gate shared by the server (capture
 *  origins) and the runner (expect them), so the two can't drift. Unlabeled
 *  dbs — the common case — return false and pay nothing. */
export function dbNeedsColumnProvenance(
  tables: Record<string, unknown> | undefined,
): boolean {
  if (tables === undefined) return false;
  for (const table of Object.values(tables)) {
    if (tableDeclaresRowLabel(table)) return true;
    const props = (table as { properties?: Record<string, unknown> })
      ?.properties;
    if (!props) continue;
    for (const col of Object.values(props)) {
      if (columnDeclaresIfc((col as { ifc?: unknown })?.ifc)) return true;
    }
  }
  return false;
}

export interface SqliteQueryResult {
  rows: unknown[];
  /** Per-result-column origin, present ONLY when the db needs provenance for
   *  CFC labeling — any column declares `ifc` (Phase 2) or any table declares
   *  a per-row label rule (Phase 3); see `dbNeedsColumnProvenance`. An aliased
   *  or joined column maps back to its declared `(table, column)`. Undefined
   *  otherwise, so unlabeled queries pay nothing. */
  columns?: SqliteResultColumn[];
}

// NOTE: there is no `sqlite.execute` write verb. Writes go through the commit
// fold (a `sqlite` op inside `transact`, applied atomically with cell ops by the
// engine) — never a standalone, non-atomic write RPC. See db.exec in the runner.

/**
 * Register an injected on-disk SQLite source (Phase 7, read-only v1). `cf piece
 * link <piece> <field> sqlite:<absPath>` issues this so the server attaches the
 * given file (read-only) for the handle id instead of the cell-derived path. The
 * descriptor is server-side state — it is NOT written into the handle cell value.
 */
export interface SqliteRegisterDiskSourceRequest {
  type: "sqlite.register-disk-source";
  requestId: string;
  space: string;
  sessionId: SessionId;
  /** Handle cell id (content-derived from (serviceSpace, absPath); see cf). */
  id: string;
  /** Absolute path to the on-disk SQLite file. */
  path: string;
}

export interface SqliteRegisterDiskSourceResult {
  registered: true;
}

export interface WatchSetRequest {
  type: "session.watch.set";
  requestId: string;
  space: string;
  sessionId: SessionId;
  watches: WatchSpec[];
}

export interface WatchAddRequest {
  type: "session.watch.add";
  requestId: string;
  space: string;
  sessionId: SessionId;
  watches: WatchSpec[];
}

export interface SessionAckRequest {
  type: "session.ack";
  requestId: string;
  space: string;
  sessionId: SessionId;
  seenSeq: number;
}

export interface SchedulerActionSnapshotQuery {
  branch?: BranchName;
  ownerSpace?: string;
  pieceId?: string;
  processGeneration?: number;
  actionId?: string;
  limit?: number;
  cursor?: SchedulerActionSnapshotCursor;
}

export interface SchedulerActionSnapshotCursor {
  ownerSpace?: string;
  pieceId: string;
  processGeneration: number;
  actionId: string;
}

export interface SchedulerActionSnapshotResult {
  observationId: number;
  commitSeq: number | null;
  observedAtSeq: number;
  observation: unknown;
  directDirtySeq?: number;
  staleSeq?: number;
  unknownReason?: string;
}

export interface SchedulerSnapshotListResult {
  serverSeq: number;
  snapshots: SchedulerActionSnapshotResult[];
  nextCursor?: SchedulerActionSnapshotCursor;
}

export interface SchedulerSnapshotListRequest {
  type: "scheduler.snapshot.list";
  requestId: string;
  space: string;
  sessionId: SessionId;
  query: SchedulerActionSnapshotQuery;
}

export interface ResponseMessage<Result> {
  type: "response";
  requestId: string;
  ok?: Result;
  error?: V2Error;
}

export interface SessionEffectMessage {
  type: "session/effect";
  space: string;
  sessionId: SessionId;
  effect: SessionSync;
}

export interface SessionRevokedMessage {
  type: "session/revoked";
  space: string;
  sessionId: SessionId;
  reason: "taken-over" | "unauthorized";
}

export interface V2Error {
  name: string;
  message: string;
  precondition?: string;
}

export type V2Result<Value> = { ok: Value } | { error: V2Error };

export interface TaskReturn<Result> {
  the: "task/return";
  of: JobId;
  is: Result;
}

export type Receipt<Result> = TaskReturn<Result>;
export type LegacyClientMessage = SessionOpenCommand;
export type LegacyServerMessage = TaskReturn<V2Result<unknown>>;
export type ClientMessage =
  | HelloMessage
  | SessionOpenRequest
  | TransactRequest
  | GraphQueryRequest
  | SqliteQueryRequest
  | SqliteRegisterDiskSourceRequest
  | WatchSetRequest
  | WatchAddRequest
  | SchedulerSnapshotListRequest
  | SessionAckRequest;
export type ServerMessage =
  | HelloOkMessage
  | ResponseMessage<unknown>
  | SessionEffectMessage
  | SessionRevokedMessage;

const memoryReconstructionContext = new EmptyReconstructionContext(
  true,
  "no cell reconstruction at the memory boundary",
);

let persistentSchedulerStateEnabled = false;
let commitPreconditionsEnabled = false;

/**
 * Ambient runtime flag for persistent scheduler observations and rehydration.
 * The runner owns the feature, but the memory protocol needs the value during
 * client/server handshakes, so it lives beside the memory protocol flags.
 */
export function setPersistentSchedulerStateConfig(enabled?: boolean): void {
  persistentSchedulerStateEnabled = enabled ?? false;
}

export function getPersistentSchedulerStateConfig(): boolean {
  return persistentSchedulerStateEnabled;
}

export function resetPersistentSchedulerStateConfig(): void {
  persistentSchedulerStateEnabled = false;
}

/**
 * Ambient runtime flag for commit preconditions. The runner owns the feature,
 * but the memory protocol needs the value during client/server handshakes.
 */
export function setCommitPreconditionsConfig(enabled?: boolean): void {
  commitPreconditionsEnabled = enabled ?? false;
}

export function getCommitPreconditionsConfig(): boolean {
  return commitPreconditionsEnabled;
}

export function resetCommitPreconditionsConfig(): void {
  commitPreconditionsEnabled = false;
}

export const getMemoryProtocolFlags = (): MemoryProtocolFlags => ({
  modernCellRep: getModernCellRepConfig(),
  persistentSchedulerState: getPersistentSchedulerStateConfig(),
  commitPreconditions: getCommitPreconditionsConfig(),
});

/**
 * Scheduler-state persistence and commit preconditions are optional
 * capabilities, not data-model wire contracts. Peers with different scheduler
 * flags can still share memory data; the server's flags control whether
 * scheduler rows and precondition checks are accepted on that connection.
 */
export const compatibleMemoryProtocolFlags = (
  left: MemoryProtocolFlags,
  right: MemoryProtocolFlags,
): boolean => left.modernCellRep === right.modernCellRep;

/**
 * Parses and normalizes incoming wire-protocol flags. Returns `null` if the
 * input is not a recognizable flags object.
 */
export const parseMemoryProtocolFlags = (
  value: unknown,
): MemoryProtocolFlags | null => {
  if (!isRecord(value) || Array.isArray(value)) {
    return null;
  }

  const persistentSchedulerState = value.persistentSchedulerState;
  if (
    persistentSchedulerState !== undefined &&
    typeof persistentSchedulerState !== "boolean"
  ) {
    return null;
  }

  const commitPreconditions = value.commitPreconditions;
  if (
    commitPreconditions !== undefined &&
    typeof commitPreconditions !== "boolean"
  ) {
    return null;
  }

  const modernCellRep = value.modernCellRep;
  if (
    modernCellRep !== undefined &&
    typeof modernCellRep !== "boolean"
  ) {
    return null;
  }

  return {
    modernCellRep: modernCellRep === true,
    persistentSchedulerState: persistentSchedulerState === true,
    commitPreconditions: commitPreconditions === true,
  };
};

/**
 * Builds the wire-format flags object for a `hello`/`hello.ok` message.
 */
export const wireMemoryProtocolFlags = (
  flags: MemoryProtocolFlags,
): WireMemoryProtocolFlags => ({
  modernCellRep: flags.modernCellRep,
  persistentSchedulerState: flags.persistentSchedulerState,
  commitPreconditions: flags.commitPreconditions,
});

export const encodeMemoryBoundary = (value: FabricValue): string =>
  jsonFromValue(value);

export const decodeMemoryBoundary = <Value extends FabricValue = FabricValue>(
  source: string,
): Value & FabricValue => {
  const decoded = valueFromJson(
    source,
    memoryReconstructionContext,
  );

  return decoded as Value;
};

export const toDocumentPath = (path: readonly string[]): DocumentPath =>
  path as DocumentPath;

export const toValuePath = (path: readonly string[]): ValuePath =>
  path as ValuePath;

/**
 * Builds a document-level selector (path rooted under `"value"`) from a schema
 * path selector. The result is interned-and-frozen via `internPathSelector()`,
 * to get the benefits of hash caching.
 */
export const toDocumentSelector = (
  selector: Pick<SchemaPathSelector, "path" | "schema">,
): DocumentSchemaPathSelector =>
  internPathSelector({
    ...selector,
    path: toDocumentPath(["value", ...selector.path]),
  }) as DocumentSchemaPathSelector;

export const isEntityDocument = (
  value: unknown,
): value is EntityDocument => isObject(value);

export const getEntityDocumentMetadata = (
  document: EntityDocument,
): Record<string, FabricValue> => {
  const {
    value: _value,
    ...metadata
  } = document;
  return metadata;
};
