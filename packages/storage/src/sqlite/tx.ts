import type { Database } from "@db/sqlite";
import * as Automerge from "@automerge/automerge";
import { getBranchState, getOrCreateBranch } from "./heads.ts";
import { decodeChangeHeader } from "./change.ts";
import { isServerMergeEnabled } from "./flags.ts";
import { maybeCreateSnapshot } from "./snapshots.ts";
import { maybeEmitChunks } from "./chunks.ts";
import { getAutomergeBytesAtSeq } from "./pit.ts";
import { refer as referJson, toDigest as refToDigest } from "merkle-reference/json";
import { createCas } from "./cas.ts";

// Local types for the SQLite tx pipeline (server-internal shape per §04/§06)
export type DocId = string;
export type BranchName = string;
export type ChangeHash = string;
export type Heads = ReadonlyArray<ChangeHash>;

export interface BranchRef {
  docId: DocId;
  branchId: string; // internal resolved branch id (optional in requests; resolved server-side)
  branch: BranchName;
}

export interface ReadEntry {
  docId: DocId;
  branchId?: string;
  branch: BranchName;
  heads: Heads;
}

export interface SubmittedChange {
  bytes: Uint8Array;
}

export interface WriteEntry {
  docId: DocId;
  branchId?: string;
  branch: BranchName;
  baseHeads: Heads;
  changes: ReadonlyArray<SubmittedChange>;
  allowServerMerge?: boolean;
}

export interface TxRequest {
  spaceId?: string;
  txId?: string;
  reads: ReadonlyArray<ReadEntry>;
  writes: ReadonlyArray<WriteEntry>;
  auth?: { ucan?: string };
}

export interface TxDocResult {
  docId: DocId;
  branch: BranchName;
  newHeads?: Heads;
  applied?: number;
  status: "ok" | "conflict" | "rejected";
  reason?: string;
}

export interface TxReceipt {
  txId: number;
  results: ReadonlyArray<TxDocResult>;
  conflicts: ReadonlyArray<TxDocResult>;
  digests: {
    baseHeadsRoot?: string; // hex
    changesRoot?: string; // hex
    changeCount: number;
  };
  stubCrypto: {
    prevTxHash: string; // hex
    txBodyHash: string; // hex
    txHash: string; // hex
  };
}

export interface TxProcessorOptions {
  // future hooks: invariants, notifications, etc.
}

export function createTxProcessor(db: Database, _opts?: TxProcessorOptions) {
  return { submitTx: (req: TxRequest) => submitTx(db, req) };
}

const MAX_DELIVERY_QUEUE = 1000; // bounded per-subscription buffer
function enqueueSubscriptionDeliveries(db: Database, docId: string, branchId: string, seqNo: number, txId: number) {
  // Find all subscriptions in this space DB (space is implicit by DB file)
  const subs = db.prepare(`SELECT id FROM subscriptions`).all() as { id: number }[];
  if (!subs || subs.length === 0) return;
  const payload = { kind: 'doc_update', docId, branchId, seqNo, txId, committedAt: new Date().toISOString() };
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  for (const s of subs) {
    // enforce bounded buffer: keep at most MAX_DELIVERY_QUEUE unacked rows
    const counts = db.prepare(
      `SELECT COUNT(1) AS unacked FROM subscription_deliveries WHERE subscription_id = :sid AND acked = 0`
    ).get({ sid: s.id }) as { unacked: number } | undefined;
    const unacked = counts?.unacked ?? 0;
    if (unacked >= MAX_DELIVERY_QUEUE) {
      // drop oldest unacked to make room (at-least-once semantics tolerate drops if consumer is too slow)
      const toDrop = unacked - MAX_DELIVERY_QUEUE + 1;
      db.run(
        `DELETE FROM subscription_deliveries WHERE id IN (
           SELECT id FROM subscription_deliveries WHERE subscription_id = :sid AND acked = 0 ORDER BY delivery_no ASC LIMIT :lim
         )`,
        { sid: s.id, lim: toDrop },
      );
    }
    // delivery_no = last + 1
    const last = db.prepare(`SELECT MAX(delivery_no) AS last FROM subscription_deliveries WHERE subscription_id = :sid`).get({ sid: s.id }) as { last: number } | undefined;
    const next = (last?.last ?? 0) + 1;
    db.run(
      `INSERT OR IGNORE INTO subscription_deliveries(subscription_id, delivery_no, payload, acked) VALUES(:sid, :dno, :payload, 0)`,
      { sid: s.id, dno: next, payload: bytes },
    );
  }
}

// Main entry: submit multi-doc tx with validations and invariants
export async function submitTx(db: Database, req: TxRequest): Promise<TxReceipt> {
  // BEGIN IMMEDIATE for atomicity and to lock the space DB for writes
  db.exec("BEGIN IMMEDIATE;");
  try {
    // Pre-resolve and/or create branches
    const resolvedReads = req.reads.map((r) => {
      const state = getBranchState(db, r.docId, r.branch);
      return { ...r, branchId: state.branchId } as ReadEntry;
    });
    const resolvedWrites = await Promise.all(req.writes.map(async (w) => {
      await getOrCreateBranch(db, w.docId, w.branch);
      const state = getBranchState(db, w.docId, w.branch);
      return { ...w, branchId: state.branchId } as WriteEntry;
    }));

    // Read-set validation: heads must match current exactly
    for (const r of resolvedReads) {
      const cur = getBranchState(db, r.docId, r.branch);
      if (!equalHeads(cur.heads, r.heads)) {
        // Abort entire tx on read conflict per §04
        throw new ReadConflictError(r.docId, r.branch, cur.heads);
      }
    }

    // Build digests placeholders
    const digestInfo = computeTxDigests(resolvedWrites);

    // Create provisional tx row (stub cryptographic fields per §04)
    const txId = createStubTx(db, digestInfo);

    // Per-doc processing
    const results: TxDocResult[] = [];

    for (const write of resolvedWrites) {
      const { docId, branch } = write;
      const current = getBranchState(db, docId, branch);

      // baseHeads vs current heads
      const baseOk = equalHeads(current.heads, write.baseHeads);
      if (!baseOk) {
        if (!(write.allowServerMerge && isServerMergeEnabled(db))) {
          results.push({
            docId,
            branch,
            status: "conflict",
            reason: "baseHeads mismatch",
            newHeads: current.heads,
          });
          continue;
        }
      }

      // Track state while applying changes
      let newHeads = current.heads.slice();
      let seqNo = current.seqNo;
      let applied = 0;
      let rejectedReason: string | undefined;
      const seenChangeHashes = new Set<string>();

      // If server merge allowed and baseHeads mismatch, attempt simple synthesized merge first
      if (!baseOk && write.allowServerMerge && isServerMergeEnabled(db)) {
        const mergedOk = synthesizeAndApplyMerge(db, current, docId, txId);
        if (!mergedOk) {
          results.push({ docId, branch, status: "conflict", reason: "cannot server-merge", newHeads: current.heads });
          continue;
        }
        // refresh state after merge
        const after = getBranchState(db, docId, branch);
        newHeads = after.heads.slice();
        seqNo = after.seqNo;
      }

      // Apply client changes with validations
      for (const change of write.changes) {
        const header = decodeChangeHeader(change.bytes);

        // Reject duplicate change hash in this tx's write set
        if (seenChangeHashes.has(header.changeHash)) {
          rejectedReason = `duplicate change ${header.changeHash}`;
          break;
        }
        seenChangeHashes.add(header.changeHash);

        // Ensure parents are present in current rolling heads set
        for (const dep of header.deps) {
          if (!newHeads.includes(dep)) {
            rejectedReason = `missing dep ${dep}`;
            break;
          }
        }
        if (rejectedReason) break;

        // Actor/seq monotonicity per branch/actor
        const last = db.prepare(
          `SELECT lamport FROM am_change_index WHERE branch_id = :branch_id AND actor_id = :actor_id ORDER BY seq_no DESC LIMIT 1`,
        ).get({ branch_id: (write.branchId as string), actor_id: header.actorId }) as { lamport: number } | undefined;
        const lastLamport = last?.lamport ?? 0;
        if (lastLamport >= header.seq) {
          rejectedReason = `non-monotonic seq for actor ${header.actorId}: ${header.seq} <= ${lastLamport}`;
          break;
        }

        // Reject if change already indexed for this branch (idempotency per DAG)
        const exists = db.prepare(
          `SELECT 1 FROM am_change_index WHERE branch_id = :branch_id AND change_hash = :hash LIMIT 1`,
        ).get({ branch_id: (write.branchId as string), hash: header.changeHash }) as { 1: number } | undefined;
        if (exists) {
          // Idempotent replay: treat duplicates as already-applied; update rolling heads and continue without indexing.
          newHeads = newHeads.filter((h) => !header.deps.includes(h));
          newHeads.push(header.changeHash);
          newHeads.sort();
          continue;
        }

        // CAS: store blob and index
        const cas = createCas(db);
        await cas.put('am_change', change.bytes);
        const bytesHash = changeHashToBytes(header.changeHash);

        seqNo += 1;
        db.run(
          `INSERT OR REPLACE INTO am_change_index(doc_id, branch_id, seq_no, change_hash, bytes_hash, deps_json, lamport, actor_id, tx_id, committed_at)
           VALUES(:doc_id, :branch_id, :seq_no, :change_hash, :bytes_hash, :deps_json, :lamport, :actor_id, :tx_id, strftime('%Y-%m-%dT%H:%M:%fZ','now'));`,
          {
            doc_id: docId,
            branch_id: write.branchId,
            seq_no: seqNo,
            change_hash: header.changeHash,
            bytes_hash: bytesHash,
            deps_json: JSON.stringify(header.deps),
            lamport: header.seq,
            actor_id: header.actorId,
            tx_id: txId,
          },
        );

        // Update heads: (heads - deps) ∪ {hash}
        newHeads = newHeads.filter((h) => !header.deps.includes(h));
        newHeads.push(header.changeHash);
        newHeads.sort();
        applied += 1;
      }

      if (rejectedReason) {
        results.push({ docId, branch, status: "rejected", reason: rejectedReason });
        continue;
      }

      // Persist heads
      updateHeads(db, write.branchId as string, newHeads, seqNo, txId);
      const snap = maybeCreateSnapshot(db, docId, write.branchId as string, seqNo, newHeads, txId);
      if (!snap) {
        await maybeEmitChunks(db, docId, write.branchId as string, current.seqNo, seqNo);
      }

      // End-of-tx invariants (stub): load materialized doc and allow projection
      // Placeholder for plugin system per §14; fail-closed if needed.
      // For now, we just ensure we can materialize the doc bytes without error.
      try {
        const amBytes = getAutomergeBytesAtSeq(db, null, docId, write.branchId as string, seqNo);
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const _doc = Automerge.load(amBytes);
      } catch (e) {
        results.push({ docId, branch, status: "conflict", reason: `invariant/materialize failed: ${(e as Error).message}` });
        continue;
      }

      // Emit subscription deliveries (at-least-once) for this doc change
      try {
        enqueueSubscriptionDeliveries(db, docId, write.branchId as string, seqNo, txId);
      } catch (e) {
        // Do not fail tx if notifications fail; at-least-once will catch up on next tx
        console.warn('subscription delivery enqueue failed', e);
      }

      results.push({ docId, branch, status: "ok", newHeads, applied });
    }

    // Commit
    db.exec("COMMIT;");

    const receipt: TxReceipt = {
      txId,
      results,
      conflicts: results.filter((r) => r.status !== "ok"),
      digests: digestInfo,
      stubCrypto: getLastStubCrypto(db),
    };
    return receipt;
  } catch (err) {
    db.exec("ROLLBACK;");
    if (err instanceof ReadConflictError) {
      const receipt: TxReceipt = {
        txId: 0,
        results: [],
        conflicts: [{ docId: err.docId, branch: err.branch, status: "conflict", reason: "read conflict" }],
        digests: { changeCount: 0 },
        stubCrypto: { prevTxHash: "", txBodyHash: "", txHash: "" },
      };
      return receipt;
    }
    throw err;
  }
}

class ReadConflictError extends Error {
  constructor(public readonly docId: string, public readonly branch: string, _heads: Heads) {
    super("ReadConflict");
  }
}

function equalHeads(a: Heads, b: Heads): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function updateHeads(db: Database, branchId: string, heads: string[], seqNo: number, epoch: number): void {
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
  for (let i = 0; i < hex.length; i += 2) bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  return bytes;
}

function randomBytes(length: number): Uint8Array {
  const arr = new Uint8Array(length);
  crypto.getRandomValues(arr);
  return arr;
}

function computeTxDigests(writes: ReadonlyArray<WriteEntry>): { baseHeadsRoot?: string; changesRoot?: string; changeCount: number } {
  // Per §04: baseHeadsRoot over sorted baseHeads, changesRoot over sorted change ids.
  const allBaseHeads: string[] = [];
  const allChangeHashes: string[] = [];
  for (const w of writes) {
    allBaseHeads.push(...[...w.baseHeads].sort());
    for (const ch of w.changes) {
      const header = Automerge.decodeChange(ch.bytes);
      if (!header.hash) continue;
      allChangeHashes.push(header.hash);
    }
  }
  allBaseHeads.sort();
  allChangeHashes.sort();
  const baseRef = referJson({ baseHeads: allBaseHeads });
  const changesRef = referJson({ changes: allChangeHashes });
  return {
    baseHeadsRoot: bytesToHex(new Uint8Array(refToDigest(baseRef))),
    changesRoot: bytesToHex(new Uint8Array(refToDigest(changesRef))),
    changeCount: allChangeHashes.length,
  };
}

function bytesToHex(bytes: Uint8Array): string {
  const hex: string[] = new Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) hex[i] = bytes[i]!.toString(16).padStart(2, "0");
  return hex.join("");
}

function createStubTx(db: Database, digests: { baseHeadsRoot?: string; changesRoot?: string; changeCount: number }): number {
  // Fetch prev tx
  const prev = db.prepare(`SELECT tx_hash FROM tx ORDER BY tx_id DESC LIMIT 1`).get() as { tx_hash: Uint8Array } | undefined;
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
  const row = db.prepare(`SELECT tx_id FROM tx ORDER BY tx_id DESC LIMIT 1`).get() as { tx_id: number };
  return row.tx_id;
}

function getLastStubCrypto(db: Database): { prevTxHash: string; txBodyHash: string; txHash: string } {
  const row = db.prepare(`SELECT prev_tx_hash, tx_body_hash, tx_hash FROM tx ORDER BY tx_id DESC LIMIT 1`).get() as
    | { prev_tx_hash: Uint8Array; tx_body_hash: Uint8Array; tx_hash: Uint8Array }
    | undefined;
  if (!row) return { prevTxHash: "", txBodyHash: "", txHash: "" };
  return { prevTxHash: bytesToHex(row.prev_tx_hash), txBodyHash: bytesToHex(row.tx_body_hash), txHash: bytesToHex(row.tx_hash) };
}

function synthesizeAndApplyMerge(db: Database, current: { branchId: string; heads: ReadonlyArray<string>; seqNo: number }, docId: string, txId: number): boolean {
  if (current.heads.length < 2) return false;
  const amBytes = getAutomergeBytesAtSeq(db, null, docId, current.branchId, current.seqNo);
  const baseDoc = Automerge.load(amBytes);
  const TMP_KEY = "__server_merge_marker";
  const mergedDoc = Automerge.change(baseDoc, (d: any) => {
    d[TMP_KEY] = true;
    delete d[TMP_KEY];
  });
  const mergeBytes = Automerge.getLastLocalChange(mergedDoc);
  if (!mergeBytes) return false;
  const hdr = Automerge.decodeChange(mergeBytes);
  if (!hdr.hash) return false;
  // deps check: ensure deps == current.heads (sorted compare)
  const depsSorted = [...(hdr.deps ?? [])].sort();
  const headsSorted = [...current.heads].sort();
  if (JSON.stringify(depsSorted) !== JSON.stringify(headsSorted)) return false;

  // persist blob via CAS
  const cas = createCas(db);
  cas.put('am_change', mergeBytes).catch(() => {});
  const bytesHash = changeHashToBytes(hdr.hash);

  // index
  const seqNo = current.seqNo + 1;
  db.run(
    `INSERT OR REPLACE INTO am_change_index(doc_id, branch_id, seq_no, change_hash, bytes_hash, deps_json, lamport, actor_id, tx_id, committed_at)
     VALUES(:doc_id, :branch_id, :seq_no, :change_hash, :bytes_hash, :deps_json, :lamport, :actor_id, :tx_id, strftime('%Y-%m-%dT%H:%M:%fZ','now'));`,
    {
      doc_id: docId,
      branch_id: current.branchId,
      seq_no: seqNo,
      change_hash: hdr.hash,
      bytes_hash: bytesHash,
      deps_json: JSON.stringify(hdr.deps ?? []),
      lamport: hdr.seq,
      actor_id: hdr.actor,
      tx_id: txId,
    },
  );
  let newHeads = current.heads.filter((h) => !(hdr.deps ?? []).includes(h));
  newHeads.push(hdr.hash);
  newHeads.sort();
  updateHeads(db, current.branchId, newHeads, seqNo, txId);
  // snapshots/chunks are handled by caller after continuing
  return true;
}

