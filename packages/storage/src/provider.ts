import type {
  BranchName,
  BranchState,
  DecodedChangeHeader,
  DocId,
  SpaceStorage,
  StorageProvider,
  TxDocResult,
  TxReceipt,
  TxRequest,
} from "./interface.ts";
import { openSqlite, type SqliteHandle } from "./store/db.ts";
import {
  getBranchState as readBranchState,
  getOrCreateBranch as ensureBranch,
  getOrCreateDoc as ensureDoc,
} from "./store/heads.ts";
import { decodeChangeHeader } from "./store/change.ts";
import type { Database } from "@db/sqlite";
import {
  refer as referJson,
  toDigest as refToDigest,
} from "merkle-reference/json";
import { maybeCreateSnapshot } from "./store/snapshots.ts";
import { maybeEmitChunks } from "./store/chunks.ts";
import { isServerMergeEnabled } from "./store/flags.ts";
import { epochForTimestamp, getAutomergeBytesAtSeq } from "./store/pit.ts";
import * as Automerge from "@automerge/automerge";
import { closeBranch } from "./store/branches.ts";
import { updateHeads as updateHeadsShared } from "./store/heads.ts";
import { hexToBytes } from "./store/bytes.ts";
import { createStubTx } from "./store/tx_chain.ts";

export interface SQLiteSpaceOptions {
  spacesDir: URL; // directory where per-space sqlite files live
}

class SQLiteSpace implements SpaceStorage {
  constructor(private readonly handle: SqliteHandle) {}

  async getOrCreateDoc(docId: DocId): Promise<void> {
    await ensureDoc(this.handle.db, docId);
  }

  async getOrCreateBranch(
    docId: DocId,
    branch: BranchName,
  ): Promise<BranchState> {
    return await ensureBranch(this.handle.db, docId, branch);
  }

  getBranchState(docId: DocId, branch: BranchName): Promise<BranchState> {
    return Promise.resolve(readBranchState(this.handle.db, docId, branch));
  }

  async submitTx(req: TxRequest): Promise<TxReceipt> {
    // Delegate to sqlite/tx pipeline to preserve single-writer and BEGIN IMMEDIATE boundaries
    const { submitTx: submitTxInternal } = await import("./store/tx.ts");
    const db = this.handle.db;

    // Translate public TxRequest → internal sqlite/tx TxRequest
    const reads = (req.reads ?? []).map((r) => ({
      docId: r.ref.docId,
      branch: r.ref.branch,
      heads: r.heads,
    }));
    const writes = req.writes.map((w) => ({
      docId: w.ref.docId,
      branch: w.ref.branch,
      baseHeads: w.baseHeads,
      changes: w.changes.map((c) => ({ bytes: c.bytes })),
      allowServerMerge: w.allowServerMerge ?? isServerMergeEnabled(db),
    }));

    const receipt = await submitTxInternal(db, {
      reads,
      writes,
      txId: req.clientTxId,
    });

    // Map internal receipt → public receipt shape
    const results: TxDocResult[] = receipt.results.map((r: any) => ({
      ref: { docId: r.docId, branch: r.branch },
      status: r.status,
      newHeads: r.newHeads,
      applied: r.applied,
      reason: r.reason,
    }));

    return {
      txId: receipt.txId,
      committedAt: new Date().toISOString(),
      results,
      conflicts: results.filter((r) => r.status === "conflict"),
    };
  }

  async getDocBytes(
    docId: DocId,
    branch: BranchName,
    opts?: {
      accept?: "automerge" | "json";
      epoch?: number;
      at?: string;
      paths?: string[][];
    },
  ): Promise<Uint8Array> {
    const db = this.handle.db;
    const state = readBranchState(db, docId, branch);
    const { uptoSeqNo } = await import("./store/pit.ts");
    const { project } = await import("./store/projection.ts");

    let targetEpoch: number | undefined = opts?.epoch;
    if (targetEpoch == null && opts?.at) {
      targetEpoch = epochForTimestamp(db, opts.at);
    }
    const targetSeq = targetEpoch == null
      ? state.seqNo
      : uptoSeqNo(db, docId, state.branchId, targetEpoch);

    const amBytes = getAutomergeBytesAtSeq(
      db,
      null,
      docId,
      state.branchId,
      targetSeq,
    );

    const accept = opts?.accept ?? "automerge";
    if (accept === "json") {
      return project(amBytes, opts?.paths);
    }
    return amBytes;
  }

  async mergeBranches(
    docId: DocId,
    fromBranch: BranchName,
    toBranch: BranchName,
    opts?: { closeSource?: boolean },
  ): Promise<string> {
    const db = this.handle.db;
    if (!isServerMergeEnabled(db)) {
      throw new Error("server merge disabled");
    }
    const from = readBranchState(db, docId, fromBranch);
    const to = readBranchState(db, docId, toBranch);

    // Load PIT docs for both branches at their current seq
    const fromBytes = getAutomergeBytesAtSeq(
      db,
      null,
      docId,
      from.branchId,
      from.seqNo,
    );
    const toBytes = getAutomergeBytesAtSeq(
      db,
      null,
      docId,
      to.branchId,
      to.seqNo,
    );

    const a = Automerge.load(toBytes);
    const b = Automerge.load(fromBytes);
    const mergedState = Automerge.merge(a, b);

    // Create explicit merge change on target branch with parents = to.heads ∪ from.heads
    const TMP_KEY = "__server_merge_marker";
    const mergedWithMarker = Automerge.change(mergedState, (d: any) => {
      d[TMP_KEY] = true;
      delete d[TMP_KEY];
    });
    const mergeBytes = Automerge.getLastLocalChange(mergedWithMarker);
    if (!mergeBytes) throw new Error("failed to synthesize merge change");
    const header: DecodedChangeHeader = decodeChangeHeader(mergeBytes);

    // Validate deps contain both branches' heads
    const wantDeps = [...to.heads, ...from.heads].sort();
    const gotDeps = [...header.deps].sort();
    if (JSON.stringify(wantDeps) !== JSON.stringify(gotDeps)) {
      throw new Error(
        "synthesized merge deps do not match source+target heads",
      );
    }

    // Persist change blob
    const bytesHash = hexToBytes(header.changeHash);
    db.run(
      `INSERT OR IGNORE INTO am_change_blobs(bytes_hash, bytes) VALUES(:bytes_hash, :bytes);`,
      { bytes_hash: bytesHash, bytes: mergeBytes },
    );

    // Index on target branch and update heads
    const seqNo = to.seqNo + 1;
    db.run(
      `INSERT OR REPLACE INTO am_change_index(doc_id, branch_id, seq_no, change_hash, bytes_hash, deps_json, lamport, actor_id, tx_id, committed_at)
       VALUES(:doc_id, :branch_id, :seq_no, :change_hash, :bytes_hash, :deps_json, :lamport, :actor_id, :tx_id, strftime('%Y-%m-%dT%H:%M:%fZ','now'));`,
      {
        doc_id: docId,
        branch_id: to.branchId,
        seq_no: seqNo,
        change_hash: header.changeHash,
        bytes_hash: bytesHash,
        deps_json: JSON.stringify(header.deps),
        lamport: header.seq,
        actor_id: header.actorId,
        tx_id: createStubTx(db),
      },
    );
    const newHeads = to.heads.filter((h: string) => !header.deps.includes(h));
    newHeads.push(header.changeHash);
    newHeads.sort();
    updateHeadsShared(db, to.branchId, newHeads, seqNo, 0);
    const snap = maybeCreateSnapshot(
      db,
      docId,
      to.branchId,
      seqNo,
      newHeads,
      0,
    );
    if (!snap) {
      await maybeEmitChunks(db, docId, to.branchId, to.seqNo, seqNo);
    }

    // After successful merge collapse, close source branch if requested
    if (opts?.closeSource ?? true) {
      closeBranch(db, docId, fromBranch, { mergedInto: toBranch });
    }

    return header.changeHash;
  }

  // Non-interface helper for tests and graceful shutdown
  async close(): Promise<void> {
    await this.handle.close();
  }
}


export function createStorageProvider(): StorageProvider {
  return {
    info: { name: "@commontools/storage", version: "0.0.0" },
  };
}

export async function openSpaceStorage(
  spaceDid: string,
  opts: SQLiteSpaceOptions,
): Promise<SpaceStorage> {
  const file = new URL(`./${spaceDid}.sqlite`, opts.spacesDir);
  await Deno.mkdir(opts.spacesDir, { recursive: true });
  const handle = await openSqlite({ url: file });
  return new SQLiteSpace(handle);
}

// JSON projection helpers moved to ./sqlite/projection.ts
