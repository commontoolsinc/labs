import {
  cloneIfNecessary,
  getDataModelConfig,
} from "@commonfabric/data-model/fabric-value";
import {
  getJsonEncodingConfig,
  jsonFromValue,
  valueFromJson,
} from "@commonfabric/data-model/json-encoding";
import { getSchemaHashConfig } from "@commonfabric/data-model/schema-hash";
import { getModernHashConfig } from "@commonfabric/data-model/value-hash";
import type { FabricValue, SchemaPathSelector } from "./interface.ts";
import type { ReconstructionContext } from "@commonfabric/data-model/interface";
import { isObject, isRecord } from "@commonfabric/utils/types";

export const MEMORY_V2_PROTOCOL = "memory/v2" as const;
export const MEMORY_V2_CONTENT_TYPE = "merkle-reference/json" as const;
export const DEFAULT_BRANCH = "" as const;

export type EntityId = string;
export type BranchName = string;
export type SessionId = string;
export type SessionToken = string;
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
  value: EntityDocument;
}

export interface PatchOperation {
  op: "patch";
  id: EntityId;
  patches: PatchOp[];
}

export interface DeleteOperation {
  op: "delete";
  id: EntityId;
}

export type Operation = SetOperation | PatchOperation | DeleteOperation;

export interface ConfirmedRead {
  id: EntityId;
  branch?: BranchName;
  path: ReadPath;
  seq: number;
}

export interface PendingRead {
  id: EntityId;
  path: ReadPath;
  localSeq: number;
}

export interface ClientCommit {
  localSeq: number;
  reads: {
    confirmed: ConfirmedRead[];
    pending: PendingRead[];
  };
  operations: Operation[];
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
  protocol: typeof MEMORY_V2_PROTOCOL;
  args: SessionOpenArgs;
}

export interface SessionOpenResult {
  sessionId: SessionId;
  sessionToken: SessionToken;
  serverSeq: number;
  resumed?: boolean;
  sync?: SessionSync;
}

export interface MemoryV2Flags {
  richStorableValues: boolean;
  unifiedJsonEncoding: boolean;
  canonicalHashing: boolean;
  modernSchemaHash: boolean;
}

export interface HelloMessage {
  type: "hello";
  protocol: typeof MEMORY_V2_PROTOCOL;
  flags: MemoryV2Flags;
}

export interface HelloOkMessage {
  type: "hello.ok";
  protocol: typeof MEMORY_V2_PROTOCOL;
  flags: MemoryV2Flags;
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
  seq: number;
  doc?: EntityDocument;
  deleted?: true;
}

export interface SessionSyncRemove {
  branch: BranchName;
  id: EntityId;
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
  | SessionAckRequest;
export type ServerMessage =
  | HelloOkMessage
  | ResponseMessage<unknown>
  | SessionEffectMessage
  | SessionRevokedMessage;

const memoryV2ReconstructionContext: ReconstructionContext = {
  getCell() {
    throw new Error(
      "getCell is not available at the memory/v2 boundary",
    );
  },
};

export const getMemoryV2Flags = (): MemoryV2Flags => ({
  richStorableValues: getDataModelConfig(),
  unifiedJsonEncoding: getJsonEncodingConfig(),
  canonicalHashing: getModernHashConfig(),
  modernSchemaHash: getSchemaHashConfig(),
});

export const sameMemoryV2Flags = (
  left: MemoryV2Flags,
  right: MemoryV2Flags,
): boolean =>
  left.richStorableValues === right.richStorableValues &&
  left.unifiedJsonEncoding === right.unifiedJsonEncoding &&
  left.canonicalHashing === right.canonicalHashing &&
  left.modernSchemaHash === right.modernSchemaHash;

export const isMemoryV2Flags = (value: unknown): value is MemoryV2Flags => {
  if (!isRecord(value) || Array.isArray(value)) {
    return false;
  }

  return typeof value.richStorableValues === "boolean" &&
    typeof value.unifiedJsonEncoding === "boolean" &&
    typeof value.canonicalHashing === "boolean" &&
    typeof value.modernSchemaHash === "boolean";
};

export const encodeMemoryV2Boundary = (value: unknown): string =>
  jsonFromValue(value as FabricValue);

export const decodeMemoryV2Boundary = <Value = FabricValue>(
  source: string,
): Value =>
  cloneIfNecessary(
    valueFromJson(source, memoryV2ReconstructionContext) as FabricValue,
    { frozen: false, deep: true, force: true },
  ) as Value;

export const toDocumentPath = (path: readonly string[]): DocumentPath =>
  path as DocumentPath;

export const toValuePath = (path: readonly string[]): ValuePath =>
  path as ValuePath;

export const toDocumentSelector = (
  selector: Pick<SchemaPathSelector, "path" | "schema">,
): DocumentSchemaPathSelector => ({
  ...selector,
  path: toDocumentPath(["value", ...selector.path]),
});

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
