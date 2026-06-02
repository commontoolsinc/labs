import { getDataModelConfig } from "@commonfabric/data-model/fabric-value";
import { getModernCellRepConfig } from "@commonfabric/data-model/cell-rep";
import {
  jsonFromValue,
  valueFromJson,
} from "@commonfabric/data-model/json-wire";
import { internPathSelector } from "@commonfabric/data-model/schema-utils";
import type { FabricValue, SchemaPathSelector } from "./interface.ts";
import { EmptyReconstructionContext } from "@commonfabric/data-model/EmptyReconstructionContext";
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

export interface SourceLink {
  "/": string;
}

export type EntityDocumentField = FabricValue | SourceLink | undefined;

export interface EntityDocument {
  value?: FabricValue;
  source?: SourceLink;
  [key: string]: EntityDocumentField;
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

export type Operation = SetOperation | PatchOperation | DeleteOperation;

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

export interface ClientCommit {
  localSeq: number;
  reads: {
    confirmed: ConfirmedRead[];
    pending: PendingRead[];
  };
  operations: Operation[];
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
  modernDataModel: boolean;
  persistentSchedulerState: boolean;
}

/** Legacy field name accepted on the wire for backward compatibility. */
const LEGACY_MODERN_DATA_MODEL_KEY = "richStorableValues";

export type WireFlagsKey = "modernDataModel" | "richStorableValues";

/**
 * Wire-format flags object. May use the canonical `modernDataModel` key or
 * the legacy `richStorableValues` alias. Use `parseMemoryProtocolFlags()` to
 * normalize to a `MemoryProtocolFlags`.
 */
export type WireMemoryProtocolFlags =
  & { [K in WireFlagsKey]?: boolean }
  & { modernCellRep?: boolean }
  & { persistentSchedulerState?: boolean };

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
  reason: "taken-over";
}

export interface V2Error {
  name: string;
  message: string;
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

export const getMemoryProtocolFlags = (): MemoryProtocolFlags => ({
  modernCellRep: getModernCellRepConfig(),
  modernDataModel: getDataModelConfig(),
  persistentSchedulerState: getPersistentSchedulerStateConfig(),
});

export const sameMemoryProtocolFlags = (
  left: MemoryProtocolFlags,
  right: MemoryProtocolFlags,
): boolean =>
  left.modernCellRep === right.modernCellRep &&
  left.modernDataModel === right.modernDataModel &&
  left.persistentSchedulerState === right.persistentSchedulerState;

/**
 * Scheduler-state persistence is an optional capability, not a data-model wire
 * contract. Peers with different scheduler flags can still share memory data;
 * the server's flag controls whether scheduler observation rows are accepted
 * and served on that connection.
 */
export const compatibleMemoryProtocolFlags = (
  left: MemoryProtocolFlags,
  right: MemoryProtocolFlags,
): boolean =>
  (left.modernCellRep === right.modernCellRep) &&
  (left.modernDataModel === right.modernDataModel);

/**
 * Parses and normalizes incoming wire-protocol flags. Accepts either the
 * current `modernDataModel` key or the legacy `richStorableValues` key (which
 * older peers may send). Returns `null` if the input is not a recognizable
 * flags object. The `wireKey` field captures which key the peer used, so
 * responders can echo the same key for backward compatibility.
 */
export const parseMemoryProtocolFlags = (
  value: unknown,
): { flags: MemoryProtocolFlags; wireKey: WireFlagsKey } | null => {
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

  const modernCellRep = value.modernCellRep;
  if (
    modernCellRep !== undefined &&
    typeof modernCellRep !== "boolean"
  ) {
    return null;
  }

  if (typeof value.modernDataModel === "boolean") {
    return {
      flags: {
        modernCellRep: modernCellRep === true,
        modernDataModel: value.modernDataModel,
        persistentSchedulerState: persistentSchedulerState === true,
      },
      wireKey: "modernDataModel",
    };
  }

  const legacy = value[LEGACY_MODERN_DATA_MODEL_KEY];
  if (typeof legacy === "boolean") {
    return {
      flags: {
        modernCellRep: modernCellRep === true,
        modernDataModel: legacy,
        persistentSchedulerState: persistentSchedulerState === true,
      },
      wireKey: LEGACY_MODERN_DATA_MODEL_KEY,
    };
  }

  if (
    (value.modernDataModel === undefined) &&
    (value[LEGACY_MODERN_DATA_MODEL_KEY] === undefined)
  ) {
    return {
      flags: {
        modernCellRep: modernCellRep === true,
        modernDataModel: false,
        persistentSchedulerState: persistentSchedulerState === true,
      },
      wireKey: "modernDataModel",
    };
  }

  return null;
};

/**
 * Builds the wire-format flags object for a `hello`/`hello.ok` message,
 * using the given key. Defaults to the canonical `modernDataModel` key;
 * responders should pass the `wireKey` captured by
 * `parseMemoryProtocolFlags()` to echo back what the peer used.
 */
export const wireMemoryProtocolFlags = (
  flags: MemoryProtocolFlags,
  wireKey: WireFlagsKey = "modernDataModel",
): WireMemoryProtocolFlags => ({
  [wireKey]: flags.modernDataModel,
  modernCellRep: flags.modernCellRep,
  persistentSchedulerState: flags.persistentSchedulerState,
});

export const encodeMemoryBoundary = (value: unknown): string =>
  jsonFromValue(value as FabricValue);

export const decodeMemoryBoundary = <Value = FabricValue>(
  source: string,
): Value => {
  const decoded = valueFromJson(
    source,
    memoryReconstructionContext,
  ) as FabricValue;

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

export const isSourceLink = (value: unknown): value is SourceLink => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return Object.keys(candidate).length === 1 &&
    typeof candidate["/"] === "string";
};

export const isEntityDocument = (
  value: unknown,
): value is EntityDocument => isObject(value);

export const getEntityDocumentMetadata = (
  document: EntityDocument,
): Record<string, EntityDocumentField> => {
  const {
    value: _value,
    ...metadata
  } = document;
  return metadata;
};
