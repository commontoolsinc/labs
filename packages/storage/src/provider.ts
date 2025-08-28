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
} from "../interface.ts";
import { openSqlite, type SqliteHandle } from "./sqlite/db.ts";
import {
  getBranchState as readBranchState,
  getOrCreateBranch as ensureBranch,
  getOrCreateDoc as ensureDoc,
} from "./sqlite/heads.ts";
import { decodeChangeHeader } from "./sqlite/change.ts";
import type { Database } from "@db/sqlite";
import {
  refer as referJson,
  toDigest as refToDigest,
} from "merkle-reference/json";
import { maybeCreateSnapshot } from "./sqlite/snapshots.ts";
import { maybeEmitChunks } from "./sqlite/chunks.ts";
import { isServerMergeEnabled } from "./sqlite/flags.ts";
import { epochForTimestamp, getAutomergeBytesAtSeq } from "./sqlite/pit.ts";
import * as Automerge from "@automerge/automerge";
import { closeBranch } from "./sqlite/branches.ts";

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
    const { submitTx: submitTxInternal } = await import("./sqlite/tx.ts");
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
    const results: TxDocResult[] = receipt.results.map((r) => ({
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
    const { uptoSeqNo } = await import("./sqlite/pit.ts");
    const { project } = await import("./sqlite/projection.ts");

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
    const bytesHash = changeHashToBytes(header.changeHash);
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
    const newHeads = to.heads.filter((h) => !header.deps.includes(h));
    newHeads.push(header.changeHash);
    newHeads.sort();
    updateHeads(db, to.branchId, newHeads, seqNo, 0);
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
      await closeBranch(db, docId, fromBranch, { mergedInto: toBranch });
    }

    return header.changeHash;
  }

  // Non-interface helper for tests and graceful shutdown
  async close(): Promise<void> {
    await this.handle.close();
  }
}

function updateHeads(
  db: Database,
  branchId: string,
  heads: string[],
  seqNo: number,
  epoch: number,
): void {
  const headsJson = JSON.stringify(heads);
  const rootRef = referJson({ heads: [...heads].sort() });
  const rootHashBytes = new Uint8Array(refToDigest(rootRef));
  db.run(
    `UPDATE am_heads SET heads_json = :heads_json, seq_no = :seq_no, tx_id = :tx_id, root_hash = :root_hash, committed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE branch_id = :branch_id`,
    {
      heads_json: headsJson,
      seq_no: seqNo,
      tx_id: epoch,
      branch_id: branchId,
      root_hash: rootHashBytes,
    },
  );
}

function changeHashToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

function hexToBytes(hex: string): Uint8Array {
  return changeHashToBytes(hex);
}

function randomBytes(length: number): Uint8Array {
  const arr = new Uint8Array(length);
  crypto.getRandomValues(arr);
  return arr;
}

function createStubTx(db: Database): number {
  // Find previous tx hash if any
  const prev = db.prepare(`SELECT tx_hash FROM tx ORDER BY tx_id DESC LIMIT 1`)
    .get() as
      | { tx_hash: Uint8Array }
      | undefined;
  const prevHash = prev?.tx_hash ?? new Uint8Array();
  const txBodyHash = randomBytes(32);
  const txHash = randomBytes(32);
  const stmt = db.prepare(
    `INSERT INTO tx(prev_tx_hash, tx_body_hash, tx_hash, server_sig, server_pubkey, client_sig, client_pubkey, ucan_jwt)
     VALUES(:prev_tx_hash, :tx_body_hash, :tx_hash, :server_sig, :server_pubkey, :client_sig, :client_pubkey, :ucan_jwt)`,
  );
  stmt.run({
    prev_tx_hash: prevHash,
    tx_body_hash: txBodyHash,
    tx_hash: txHash,
    server_sig: randomBytes(64),
    server_pubkey: randomBytes(32),
    client_sig: randomBytes(64),
    client_pubkey: randomBytes(32),
    ucan_jwt: "stub",
  });
  const row = db.prepare(`SELECT tx_id FROM tx ORDER BY tx_id DESC LIMIT 1`)
    .get() as { tx_id: number };
  return row.tx_id;
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
