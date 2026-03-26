import {
  jsonFromValue,
  valueFromJson,
} from "@commontools/data-model/json-encoding";
import type {
  JSONValue,
  SchemaPathSelector,
  StorableDatum,
} from "./interface.ts";
import type { ReconstructionContext } from "@commontools/data-model/interface";

export const MEMORY_V2_PROTOCOL = "memory/v2" as const;
export const MEMORY_V2_CONTENT_TYPE = "merkle-reference/json" as const;
export const DEFAULT_BRANCH = "" as const;

export type EntityId = string;
export type BranchName = string;
export type SessionId = string;
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

export type EntityDocumentField = StorableDatum | SourceLink | undefined;
export type WireEntityDocumentField = JSONValue | SourceLink | undefined;

export interface EntityDocument {
  value?: StorableDatum;
  source?: SourceLink;
  [key: string]: EntityDocumentField;
}

export interface WireEntityDocument {
  value?: JSONValue;
  source?: SourceLink;
  [key: string]: WireEntityDocumentField;
}

export interface Blob {
  hash: Reference;
  value: Uint8Array;
  contentType: string;
  size: number;
}

export type PatchOp =
  | { op: "replace"; path: string; value: JSONValue }
  | { op: "add"; path: string; value: JSONValue }
  | { op: "remove"; path: string }
  | { op: "move"; from: string; path: string }
  | {
    op: "splice";
    path: string;
    index: number;
    remove: number;
    add: JSONValue[];
  };

export interface SetOperation {
  op: "set";
  id: EntityId;
  value: WireEntityDocument;
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
}

export interface SessionOpenCommand {
  cmd: "session.open";
  id: JobId;
  protocol: typeof MEMORY_V2_PROTOCOL;
  args: SessionOpenArgs;
}

export interface SessionOpenResult {
  sessionId: SessionId;
  serverSeq: number;
  resumed?: boolean;
  sync?: SessionSync;
}

export interface HelloMessage {
  type: "hello";
  protocol: typeof MEMORY_V2_PROTOCOL;
}

export interface HelloOkMessage {
  type: "hello.ok";
  protocol: typeof MEMORY_V2_PROTOCOL;
}

export interface SessionDescriptor {
  sessionId?: SessionId;
  seenSeq?: number;
}

export interface SessionOpenRequest {
  type: "session.open";
  requestId: string;
  space: string;
  session: SessionDescriptor;
}

export interface GraphQueryRoot {
  id: EntityId;
  selector: SchemaPathSelector;
}

export interface GraphQuery {
  roots: GraphQueryRoot[];
  since?: number;
  atSeq?: number;
  branch?: BranchName;
  excludeSent?: boolean;
}

export interface EntitySnapshot {
  branch: BranchName;
  id: EntityId;
  seq: number;
  document: WireEntityDocument | null;
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
  doc?: WireEntityDocument;
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
  invocation?: Record<string, unknown>;
  authorization?: JSONValue;
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
  | SessionEffectMessage;

const memoryV2ReconstructionContext: ReconstructionContext = {
  getCell() {
    throw new Error(
      "getCell is not available at the memory/v2 boundary",
    );
  },
};

const isDocumentRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export const toSourceLink = (id: string): SourceLink => ({ "/": id });

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

export const toBlobMetadataId = (hash: Reference): EntityId =>
  `urn:blob-meta:${hash}`;

export const isSourceLink = (value: unknown): value is SourceLink => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return Object.keys(candidate).length === 1 &&
    typeof candidate["/"] === "string";
};

export const toEntityDocument = (
  value: StorableDatum | undefined,
  source?: SourceLink,
  metadata: Record<string, EntityDocumentField> = {},
): EntityDocument => {
  const document: Record<string, EntityDocumentField> = {
    ...metadata,
    ...(source !== undefined ? { source } : {}),
  };
  if (value !== undefined) {
    document.value = value;
  }
  return document as EntityDocument;
};

export const toWireEntityDocument = (
  value: JSONValue | undefined,
  source?: SourceLink,
  metadata: Record<string, WireEntityDocumentField> = {},
): WireEntityDocument => {
  const document: Record<string, WireEntityDocumentField> = {
    ...metadata,
    ...(source !== undefined ? { source } : {}),
  };
  if (value !== undefined) {
    document.value = value;
  }
  return document as WireEntityDocument;
};

export const isWireEntityDocument = (
  value: unknown,
): value is WireEntityDocument => isDocumentRecord(value);

export const isEntityDocument = (
  value: unknown,
): value is EntityDocument => isDocumentRecord(value);

export const getEntityDocumentMetadata = (
  document: EntityDocument,
): Record<string, EntityDocumentField> => {
  const {
    value: _value,
    ...metadata
  } = document;
  return metadata;
};

export const getWireEntityDocumentMetadata = (
  document: WireEntityDocument,
): Record<string, WireEntityDocumentField> => {
  const {
    value: _value,
    ...metadata
  } = document;
  return metadata;
};

export const encodeWireEntityDocument = (
  document: EntityDocument,
): WireEntityDocument => {
  const encoded = JSON.parse(
    jsonFromValue(document as unknown as StorableDatum),
  ) as JSONValue;
  if (!isDocumentRecord(encoded)) {
    throw new Error("memory v2 documents must encode to plain object roots");
  }
  return encoded as WireEntityDocument;
};

export const decodeWireEntityDocument = (
  document: WireEntityDocument,
): EntityDocument => {
  const decoded = valueFromJson(
    JSON.stringify(document),
    memoryV2ReconstructionContext,
  );
  if (!isDocumentRecord(decoded)) {
    throw new Error("memory v2 documents must decode to plain object roots");
  }
  return decoded as EntityDocument;
};
