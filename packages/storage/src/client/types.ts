import type * as AM from "@automerge/automerge";
// Align select IDs with server-side canonical types
import type { BranchName, DocId } from "../types.ts";

export type DID = `did:${string}:${string}`;

/** Options for StorageClient. */
export interface StorageClientOptions {
  /** Base HTTP origin for the storage service (e.g., http://localhost:8002). */
  baseUrl?: string;
  /**
   * Reserved for future WS authentication. Not currently used because browser
   * WebSocket constructors do not support custom headers.
   */
  token?: string | (() => Promise<string>);
  /** Optional client logging level. */
  logLevel?: "off" | "error" | "warn" | "info" | "debug";
}

export type SpaceDID = `did:${string}`;
export type DocID = DocId;
export type Branch = BranchName;
export type TxID = string;
export type Path = string[]; // [] = root

export type SpaceDocKey = `${SpaceDID}#${DocID}#${Branch}`;
export type DocSet = Set<SpaceDocKey>;

export type PathKey = `${SpaceDID}#${DocID}#${Branch}#${string}`;
export type PathSet = Set<PathKey>;

export interface QuerySpec {
  id: string;
  spaceDocHints?: { space?: SpaceDID; docIds?: DocID[] };
  // Convention: query should read using store.queryReadDoc(...) or queryReadPath(...)
  evaluate: () => unknown;
}

export interface QueryHandle {
  id: string;
  spaceDocHints?: { space?: SpaceDID; docIds?: DocID[] };
  result: unknown;
  readDocs: DocSet;
  headsByDoc: Map<SpaceDocKey, string[]>;
}

export type Cause =
  | { kind: "server-commit"; space: SpaceDID; docId: DocID; branch: Branch }
  | { kind: "tx-accepted"; txId: TxID }
  | { kind: "tx-retracted"; txId: TxID; reason: string }
  | { kind: "overlay-changed" };

export type SchedulerChange = {
  space: SpaceDID;
  docId: DocID;
  branch: Branch;
  before: any;
  after: any;
};

export interface SchedulerHooks {
  mayCareAbout?(docs: DocSet): boolean;
  onChanges(cause: Cause, changes: SchedulerChange[]): void;
}

export interface Tx {
  id: TxID;
  writeSpace?: SpaceDID;
  baseHeadsByDoc: Map<SpaceDocKey, string[]>;
  readPaths: PathSet;
  writePaths: PathSet;
  readDocs: DocSet;
  writeDocs: DocSet;
  drafts: Map<SpaceDocKey, AM.Doc<any>>;
  status: "pending" | "committing" | "accepted" | "retracted";
}

// Internal augmentation for implementation details (not part of public API)
export interface TxInternal extends Tx {
  // Capture base overlay doc snapshot for each touched doc
  baseDocByKey: Map<SpaceDocKey, AM.Doc<any>>;
  // Cached changes for commit & overlay rebuild
  changesByKey: Map<SpaceDocKey, AM.Change[]>;
}

export interface TxHandle {
  id: TxID;
  readPath<T = unknown>(
    space: SpaceDID,
    docId: DocID,
    branch: Branch,
    path: Path,
  ): T;
  writePath(
    space: SpaceDID,
    docId: DocID,
    branch: Branch,
    path: Path,
    value: unknown,
  ): void;
  deletePath(space: SpaceDID, docId: DocID, branch: Branch, path: Path): void;
  commit(): Promise<void>;
  abort(reason?: string): void;
  getReads(): Array<
    { space: SpaceDID; docId: DocID; branch: Branch; path: Path }
  >;
  getWrites(): Array<
    { space: SpaceDID; docId: DocID; branch: Branch; path: Path }
  >;
}

export interface INotifier {
  subscribe(qs: QuerySpec[]): QueryHandle[];
  unsubscribe(id: string): void;
  onChange(cb: (ev: NotifierEvent) => void): () => void;
  invalidateByDocs(delta: DocSet, cause: Cause): void;
}

export interface NotifierEvent {
  cause: Cause;
  changedQueries: string[];
  changedDocs: DocSet;
}
