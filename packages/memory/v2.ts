import type { JSONValue } from "./interface.ts";

export const MEMORY_V2_PROTOCOL = "memory/v2" as const;
export const MEMORY_V2_CONTENT_TYPE = "merkle-reference/json" as const;
export const DEFAULT_BRANCH = "" as const;
export const EMPTY_VALUE_REF = "__empty__" as const;

export type EntityId = string;
export type BranchName = string;
export type SessionId = string;
export type Reference = string & {
  readonly __memoryV2Reference: unique symbol;
};
export type ReadPath = readonly string[];

export interface SourceLink {
  "/": string;
}

export interface EntityDocument {
  value: JSONValue;
  source?: SourceLink;
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
  value: JSONValue;
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

export interface SessionOpenResult {
  sessionId: SessionId;
  serverSeq: number;
}

export interface TaskReturn<Result> {
  the: "task/return";
  of: `job:${string}`;
  is: Result;
}

export interface TaskEffect<Effect> {
  the: "task/effect";
  of: `job:${string}`;
  is: Effect;
}

export type Receipt<Result, Effect> = TaskReturn<Result> | TaskEffect<Effect>;

export const toSourceLink = (id: string): SourceLink => ({ "/": id });

export const isSourceLink = (value: unknown): value is SourceLink => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return Object.keys(candidate).length === 1 &&
    typeof candidate["/"] === "string";
};

export const toEntityDocument = (
  value: JSONValue,
  source?: SourceLink,
): EntityDocument => {
  return source ? { value, source } : { value };
};

export const toDocumentPath = (path: ReadPath): string[] => ["value", ...path];
