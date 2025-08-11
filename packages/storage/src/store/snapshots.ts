import type { Database } from "@db/sqlite";
import * as Automerge from "@automerge/automerge";
import { getAutomergeBytesAtSeq } from "./pit.ts";
import { createCas } from "./cas.ts";

// Basic snapshot cadence policy: every N changes per branch
const DEFAULT_CADENCE = 5;

export interface SnapshotOptions {
  cadence?: number;
}

/**
 * Create a full snapshot via Automerge.save() when cadence threshold is hit.
 * Persists into `am_snapshots` with upto_seq_no and heads, and mirrors to CAS.
 */
export function maybeCreateSnapshot(
  db: Database,
  docId: string,
  branchId: string,
  seqNo: number,
  heads: string[],
  txId: number,
  opts?: SnapshotOptions,
): boolean {
  const cadence = opts?.cadence ?? DEFAULT_CADENCE;
  if (seqNo === 0 || (seqNo % cadence) !== 0) return false;

  // Reconstruct document bytes at upto seqNo using PIT path
  const amBytes = getAutomergeBytesAtSeq(db, docId, branchId, seqNo);
  const doc = Automerge.load(amBytes);
  const snapshotBytes = Automerge.save(doc);

  db.run(
    `INSERT OR REPLACE INTO am_snapshots(snapshot_id, doc_id, branch_id, upto_seq_no, heads_json, root_hash, bytes, tx_id, committed_at)
     VALUES(:snapshot_id, :doc_id, :branch_id, :upto_seq_no, :heads_json, :root_hash, :bytes, :tx_id, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
    {
      snapshot_id: crypto.randomUUID(),
      doc_id: docId,
      branch_id: branchId,
      upto_seq_no: seqNo,
      heads_json: JSON.stringify([...heads].sort()),
      root_hash: new Uint8Array([]), // root_hash not strictly needed here; verified via am_heads
      bytes: snapshotBytes,
      tx_id: txId,
    },
  );

  // Persist snapshot via CAS for content-addressability and future reuse
  const cas = createCas(db);
  cas.put("am_snapshot", snapshotBytes, { docId, branchId, seqNo, txId }).catch(
    () => {/* best-effort */},
  );

  return true;
}
