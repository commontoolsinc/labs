import type { Database } from "@db/sqlite";
import * as Automerge from "@automerge/automerge";
import { getBranchState, getOrCreateBranch } from "./heads.ts";
import { decodeChangeHeader } from "./change.ts";
import { isServerMergeEnabled } from "./flags.ts";
import { maybeCreateSnapshot } from "./snapshots.ts";
import { maybeEmitChunks } from "./chunks.ts";
import { getAutomergeBytesAtSeq } from "./pit.ts";
import {
  refer as referJson,
  toDigest as refToDigest,
} from "merkle-reference/json";
import { createCas } from "./cas.ts";
import { upsertJsonCache } from "./cache.ts";
import { getLogger } from "@commontools/utils/logger";
import { bytesToHex, hexToBytes } from "./bytes.ts";
import { createStubTx, getLastStubCrypto } from "./tx_chain.ts";
import { updateHeads as updateHeadsShared } from "./heads.ts";
import { synthesizeAndApplyMergeOnBranch } from "./merge.ts";

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
  // Intentionally left with placeholder for forward compatibility
  invariantHooks?: never;
}

export function createTxProcessor(db: Database, _opts?: TxProcessorOptions) {
  return { submitTx: (req: TxRequest) => submitTx(db, req) };
}

const log = getLogger("storage:tx", { level: "info", enabled: true });
const MAX_DELIVERY_QUEUE = 1000; // bounded per-subscription buffer
function enqueueSubscriptionDeliveries(
  db: Database,
  docId: string,
  branchId: string,
  seqNo: number,
  txId: number,
) {
  // Find all subscriptions in this space DB (space is implicit by DB file)
  const subs = db.prepare(`SELECT id FROM subscriptions`).all() as {
    id: number;
  }[];
  if (!subs || subs.length === 0) return;
  log.debug(() => [
    "enqueue",
    { docId, branchId, seqNo, txId, subs: subs.length },
  ]);
  const payload = {
    kind: "doc_update",
    docId,
    branchId,
    seqNo,
    txId,
    committedAt: new Date().toISOString(),
  };
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  for (const s of subs) {
    // enforce bounded buffer: keep at most MAX_DELIVERY_QUEUE unacked rows
    const counts = db.prepare(
      `SELECT COUNT(1) AS unacked FROM subscription_deliveries WHERE subscription_id = :sid AND acked = 0`,
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
    const last = db.prepare(
      `SELECT MAX(delivery_no) AS last FROM subscription_deliveries WHERE subscription_id = :sid`,
    ).get({ sid: s.id }) as { last: number } | undefined;
    const next = (last?.last ?? 0) + 1;
    log.debug(() => ["enqueue", { sid: s.id, last: last?.last ?? 0, next }]);
    db.run(
      `INSERT OR IGNORE INTO subscription_deliveries(subscription_id, delivery_no, payload, acked) VALUES(:sid, :dno, :payload, 0)`,
      { sid: s.id, dno: next, payload: bytes },
    );
    try {
      const cnt = db.prepare(
        `SELECT COUNT(1) AS c FROM subscription_deliveries WHERE subscription_id = :sid`,
      ).get({ sid: s.id }) as { c: number };
      log.debug(() => ["enqueue", { sid: s.id, total: cnt.c }]);
    } catch {
      // ignore logging failures (non-fatal)
    }
  }
}

// Main entry: submit multi-doc tx with validations and invariants
export async function submitTx(
  db: Database,
  req: TxRequest,
): Promise<TxReceipt> {
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
        const merged = synthesizeAndApplyMergeOnBranch(db, {
          docId,
          branchId: current.branchId,
          currentHeads: current.heads,
          currentSeqNo: current.seqNo,
          txId,
        });
        if (!merged.ok) {
          results.push({
            docId,
            branch,
            status: "conflict",
            reason: "cannot server-merge",
            newHeads: current.heads,
          });
          continue;
        }
        // refresh state after merge
        newHeads = merged.newHeads.slice();
        seqNo = merged.seqNo;
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
        ).get({
          branch_id: (write.branchId as string),
          actor_id: header.actorId,
        }) as { lamport: number } | undefined;
        const lastLamport = last?.lamport ?? 0;
        if (lastLamport >= header.seq) {
          rejectedReason =
            `non-monotonic seq for actor ${header.actorId}: ${header.seq} <= ${lastLamport}`;
          break;
        }

        // Reject if change already indexed for this branch (idempotency per DAG)
        const exists = db.prepare(
          `SELECT 1 FROM am_change_index WHERE branch_id = :branch_id AND change_hash = :hash LIMIT 1`,
        ).get({
          branch_id: (write.branchId as string),
          hash: header.changeHash,
        }) as { 1: number } | undefined;
        if (exists) {
          // Idempotent replay: treat duplicates as already-applied; update rolling heads and continue without indexing.
          newHeads = newHeads.filter((h) => !header.deps.includes(h));
          newHeads.push(header.changeHash);
          newHeads.sort();
          continue;
        }

        // CAS: store blob and index
        const cas = createCas(db);
        await cas.put("am_change", change.bytes);
        const bytesHash = hexToBytes(header.changeHash);

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
        try {
          console.warn(
            `[tx] rejected doc=${docId} branch=${branch} reason=${rejectedReason}`,
          );
        } catch {
          // ignore logging failures (non-fatal)
        }
        results.push({
          docId,
          branch,
          status: "rejected",
          reason: rejectedReason,
        });
        continue;
      }

      // Persist heads
      updateHeadsShared(db, write.branchId as string, newHeads, seqNo, txId);
      const snap = maybeCreateSnapshot(
        db,
        docId,
        write.branchId as string,
        seqNo,
        newHeads,
        txId,
      );
      if (!snap) {
        await maybeEmitChunks(
          db,
          docId,
          write.branchId as string,
          current.seqNo,
          seqNo,
        );
      }

      // End-of-tx invariants (stub): load materialized doc and allow projection
      // Placeholder for plugin system per §14; fail-closed if needed.
      // For now, we just ensure we can materialize the doc bytes without error.
      // Additionally, populate/update the latest JSON cache for (doc, branch).
      try {
        const amBytes = getAutomergeBytesAtSeq(
          db,
          docId,
          write.branchId as string,
          seqNo,
        );
        const materialized = Automerge.load(amBytes);
        const json = Automerge.toJS(materialized);
        const jsonStr = JSON.stringify(json);
        upsertJsonCache(db, {
          docId,
          branchId: write.branchId as string,
          seqNo,
          json: jsonStr,
        });
      } catch (e) {
        results.push({
          docId,
          branch,
          status: "conflict",
          reason: `invariant/materialize failed: ${(e as Error).message}`,
        });
        continue;
      }

      // Emit subscription deliveries (at-least-once) for this doc change
      try {
        enqueueSubscriptionDeliveries(
          db,
          docId,
          write.branchId as string,
          seqNo,
          txId,
        );
      } catch (e) {
        // Do not fail tx if notifications fail; at-least-once will catch up on next tx
        log.warn(() => ["subscription delivery enqueue failed", e]);
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
        conflicts: [{
          docId: err.docId,
          branch: err.branch,
          status: "conflict",
          reason: "read conflict",
        }],
        digests: { changeCount: 0 },
        stubCrypto: { prevTxHash: "", txBodyHash: "", txHash: "" },
      };
      return receipt;
    }
    throw err;
  }
}

class ReadConflictError extends Error {
  constructor(
    public readonly docId: string,
    public readonly branch: string,
    _heads: Heads,
  ) {
    super("ReadConflict");
  }
}

function equalHeads(a: Heads, b: Heads): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// changeHashToBytes now provided by shared hexToBytes

function computeTxDigests(
  writes: ReadonlyArray<WriteEntry>,
): { baseHeadsRoot?: string; changesRoot?: string; changeCount: number } {
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

// getLastStubCrypto and createStubTx moved to tx_chain.ts
// merge helper now in merge.ts
