// Unified public and internal types for the storage backend and query engine

// ----- Core storage types -----
export type DocId = string; // "doc:<ref>"
export type BranchName = string; // e.g. "main"
export type BranchId = string; // opaque, unique per (doc, name)
export type ChangeHash = string; // automerge change hash string
export type Head = ChangeHash;
export type Heads = ReadonlyArray<Head>;
export type ActorId = string;
export type Seq = number;

export interface BranchRef {
  docId: DocId;
  branch: BranchName;
}

export interface BranchState {
  branchId: BranchId;
  heads: Heads; // canonical sorted representation
  seqNo: number; // last applied seq number
  epoch: number; // monotonically increasing tx/epoch id
  rootRef?: string; // merkle-reference over sorted heads
}

export interface SubmittedChange {
  // Raw Automerge change bytes (base64 in API; Uint8Array internally)
  bytes: Uint8Array;
}

export interface DecodedChangeHeader {
  changeHash: ChangeHash;
  deps: ChangeHash[];
  actorId: ActorId;
  seq: Seq;
}

export interface WriteRequest {
  ref: BranchRef;
  baseHeads: Heads;
  changes: ReadonlyArray<SubmittedChange>;
  mergeOf?: Array<{ branch: BranchName; heads: Heads }>;
  allowServerMerge?: boolean; // optional per-write override
}

export interface ReadAssert {
  ref: BranchRef;
  heads: Heads;
}

export interface TxRequest {
  clientTxId?: string;
  reads: ReadonlyArray<ReadAssert>;
  writes: ReadonlyArray<WriteRequest>;
}

export interface TxDocResult {
  ref: BranchRef;
  status: "ok" | "conflict" | "rejected";
  newHeads?: Heads;
  applied?: number; // number of changes accepted
  reason?: string;
}

export interface TxReceipt {
  txId: number;
  committedAt: string;
  results: ReadonlyArray<TxDocResult>;
  conflicts: ReadonlyArray<TxDocResult>;
}

export interface StorageProviderInfo {
  name: string;
  version: string;
}

export interface StorageProvider {
  readonly info: StorageProviderInfo;
}

export interface SpaceStorage {
  getOrCreateDoc(docId: DocId): Promise<void>;
  getOrCreateBranch(docId: DocId, branch: BranchName): Promise<BranchState>;
  getBranchState(docId: DocId, branch: BranchName): Promise<BranchState>;
  submitTx(req: TxRequest): Promise<TxReceipt>;
  getDocBytes(
    docId: DocId,
    branch: BranchName,
    opts?: {
      accept?: "automerge" | "json";
      epoch?: number;
      at?: string;
      paths?: string[][];
    },
  ): Promise<Uint8Array>;
  /**
   * Explicitly merge `fromBranch` into `toBranch` for the given document.
   * Returns the new head hash on the target branch.
   */
  mergeBranches(
    docId: DocId,
    fromBranch: BranchName,
    toBranch: BranchName,
    opts?: { closeSource?: boolean },
  ): Promise<string>;
}

// ----- Query engine shared types -----
export type Path = string[]; // internal path representation
export type PathKey = string; // JSON.stringify(Path)
export type Version = { epoch: number; branch?: string };

// Link = (docId, path tokens)
export type Link = { doc: DocId; path: Path };

export type Verdict = "Yes" | "No" | "MaybeExceededDepth";

export type Delta = {
  doc: DocId;
  changed: Set<PathKey>; // keys created via keyPath(path)
  removed: Set<PathKey>;
  newDoc?: any;
  atVersion: Version;
};

export type EngineEvent = {
  queryId: string;
  verdictChanged: boolean;
  touchAdded: Link[];
  touchRemoved: Link[];
  changedDocs: Set<DocId>;
  atVersion: Version;
};
