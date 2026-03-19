import type { JSONValue, SchemaPathSelector } from "./interface.ts";

export const MEMORY_V2_PROTOCOL = "memory/v2" as const;
export const MEMORY_V2_CONTENT_TYPE = "merkle-reference/json" as const;
export const DEFAULT_BRANCH = "" as const;
export const EMPTY_VALUE_REF = "__empty__" as const;
export const ENTITY_DOCUMENT_MARKER_KEY = "$ctDocument" as const;
export const ENTITY_DOCUMENT_MARKER_VALUE = "common-tools/document@1" as const;

export type EntityId = string;
export type BranchName = string;
export type SessionId = string;
export type JobId = `job:${string}`;
export type Reference = string & {
  readonly __memoryV2Reference: unique symbol;
};
export type ReadPath = readonly string[];

export interface SourceLink {
  "/": string;
}

export type EntityDocumentField = JSONValue | SourceLink | undefined;

export interface EntityDocument {
  [ENTITY_DOCUMENT_MARKER_KEY]: typeof ENTITY_DOCUMENT_MARKER_VALUE;
  value?: JSONValue;
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
  value: JSONValue | EntityDocument;
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
  subscribe?: boolean;
  since?: number;
  branch?: BranchName;
  excludeSent?: boolean;
}

export interface EntitySnapshot {
  id: EntityId;
  seq: number;
  hash?: Reference;
  document: EntityDocument | null;
}

export interface GraphQueryResult {
  serverSeq: number;
  entities: EntitySnapshot[];
  subscriptionId?: string;
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

export interface GraphUnsubscribeRequest {
  type: "graph.unsubscribe";
  requestId: string;
  space: string;
  sessionId: SessionId;
  subscriptionId: string;
}

export interface ResponseMessage<Result> {
  type: "response";
  requestId: string;
  ok?: Result;
  error?: V2Error;
}

export interface GraphUpdateMessage {
  type: "graph.update";
  subscriptionId?: string;
  subscriptionIds?: string[];
  space: string;
  result: GraphQueryResult;
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

export interface TaskEffect<Effect> {
  the: "task/effect";
  of: JobId;
  is: Effect;
}

export type Receipt<Result, Effect> = TaskReturn<Result> | TaskEffect<Effect>;
export type LegacyClientMessage = SessionOpenCommand;
export type LegacyServerMessage = TaskReturn<V2Result<unknown>>;
export type ClientMessage =
  | HelloMessage
  | SessionOpenRequest
  | TransactRequest
  | GraphQueryRequest
  | GraphUnsubscribeRequest;
export type ServerMessage =
  | HelloOkMessage
  | ResponseMessage<unknown>
  | GraphUpdateMessage;

export const toSourceLink = (id: string): SourceLink => ({ "/": id });

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
  value: JSONValue | undefined,
  source?: SourceLink,
  metadata: Record<string, EntityDocumentField> = {},
): EntityDocument => {
  const document: Record<string, EntityDocumentField> = {
    [ENTITY_DOCUMENT_MARKER_KEY]: ENTITY_DOCUMENT_MARKER_VALUE,
    ...metadata,
    ...(source !== undefined ? { source } : {}),
  };
  if (value !== undefined) {
    document.value = value;
  }
  return document as EntityDocument;
};

export const isEntityDocument = (
  value: unknown,
): value is EntityDocument => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  return (value as Record<string, unknown>)[ENTITY_DOCUMENT_MARKER_KEY] ===
    ENTITY_DOCUMENT_MARKER_VALUE;
};

const isLegacyEntityDocument = (
  value: unknown,
): value is {
  value?: JSONValue;
  source?: SourceLink;
} => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate);
  if (
    keys.length === 0 ||
    !keys.every((key) => key === "value" || key === "source")
  ) {
    return false;
  }

  return Object.hasOwn(candidate, "value") ||
    (
      Object.hasOwn(candidate, "source") &&
      isSourceLink(candidate.source)
    );
};

export const getEntityDocumentMetadata = (
  document: EntityDocument,
): Record<string, EntityDocumentField> => {
  const {
    [ENTITY_DOCUMENT_MARKER_KEY]: _marker,
    value: _value,
    ...metadata
  } = document;
  return metadata;
};

export const normalizeEntityDocument = (
  value: JSONValue | EntityDocument,
): EntityDocument => {
  if (isEntityDocument(value)) {
    return value;
  }

  if (isLegacyEntityDocument(value)) {
    return toEntityDocument(value.value, value.source);
  }

  return toEntityDocument(value);
};

export const toDocumentPath = (path: ReadPath): string[] => ["value", ...path];
