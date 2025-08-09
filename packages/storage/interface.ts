// Public types for the new storage backend live here.
// Implements the design from `docs/specs/storage/*`.

export type DocId = string; // "doc:<ref>"
export type BranchName = string; // e.g. "main"
export type BranchId = string; // opaque, unique per (doc, name)
export type ChangeHash = string; // automerge change hash string
export type Head = ChangeHash;
export type Heads = ReadonlyArray<Head>;
export type ActorId = string;
export type Seq = number;

export interface SpaceId {
  did: string; // space DID, e.g. did:key:...
}

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
