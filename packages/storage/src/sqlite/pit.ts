import type { BranchId, DocId } from "../../interface.ts";
import type { Database } from "@db/sqlite";
import * as Automerge from "@automerge/automerge";

/**
 * Resolve a timestamp (ISO string) to the latest tx_id at or before it.
 * Returns 0 when no matching tx exists.
 */
export function epochForTimestamp(db: Database, at: string): number {
  const row = db.prepare(
    `SELECT tx_id FROM tx WHERE committed_at <= :at
     ORDER BY tx_id DESC LIMIT 1`,
  ).get({ at }) as { tx_id: number } | undefined;
  return row?.tx_id ?? 0;
}

/**
 * Compute the last applied seq_no for (doc_id, branch_id) at or before epoch.
 * Returns 0 if there are no changes up to that epoch.
 */
export function uptoSeqNo(
  db: Database,
  docId: DocId,
  branchId: BranchId,
  epoch: number,
): number {
  const row = db.prepare(
    `SELECT MAX(seq_no) AS upto_seq_no
     FROM am_change_index
     WHERE doc_id = :doc_id AND branch_id = :branch_id AND tx_id <= :epoch`,
  ).get({ doc_id: docId, branch_id: branchId, epoch }) as
    | { upto_seq_no: number | null }
    | undefined;
  return row?.upto_seq_no ?? 0;
}

/**
 * Return Automerge binary bytes representing the branch state at the given
 * target seq. Tries the fast path with am_snapshots + am_chunks; falls back to
 * snapshot plus applying change blobs.
 */
export function getAutomergeBytesAtSeq(
  db: Database,
  docId: DocId,
  branchId: BranchId,
  targetSeq: number,
): Uint8Array {
  // Fast path: find latest snapshot with upto_seq_no <= targetSeq
  const snap = db.prepare(
    `SELECT snapshot_id, upto_seq_no, bytes
     FROM am_snapshots
     WHERE doc_id = :doc_id AND branch_id = :branch_id
       AND upto_seq_no <= :target
     ORDER BY upto_seq_no DESC
     LIMIT 1`,
  ).get({ doc_id: docId, branch_id: branchId, target: targetSeq }) as
    | { snapshot_id: string; upto_seq_no: number; bytes: Uint8Array }
    | undefined;

  if (snap) {
    const chunks = db.prepare(
      `SELECT bytes FROM am_chunks
       WHERE doc_id = :doc_id AND branch_id = :branch_id
         AND seq_no > :from_seq AND seq_no <= :to_seq
       ORDER BY seq_no`,
    ).all({
      doc_id: docId,
      branch_id: branchId,
      from_seq: snap.upto_seq_no,
      to_seq: targetSeq,
    }) as Array<{ bytes: Uint8Array }>;

    // If chunks cover the entire remaining range (possibly zero-length),
    // return concatenated binary stream.
    const expected = Math.max(0, targetSeq - snap.upto_seq_no);
    if (chunks.length === expected) {
      const totalLen = snap.bytes.length +
        chunks.reduce((n, c) => n + c.bytes.length, 0);
      const out = new Uint8Array(totalLen);
      out.set(snap.bytes, 0);
      let offset = snap.bytes.length;
      for (const c of chunks) {
        out.set(c.bytes, offset);
        offset += c.bytes.length;
      }
      return out;
    }
  }

  // Fallback path: start from snapshot (if any) then apply changes.
  let baseDoc = snap ? Automerge.load(snap.bytes) : Automerge.init();
  const rows = db.prepare(
    `SELECT b.bytes AS bytes
     FROM am_change_index i
     JOIN am_change_blobs b ON (i.bytes_hash = b.bytes_hash)
     WHERE i.doc_id = :doc_id AND i.branch_id = :branch_id
       AND i.seq_no > :from_seq AND i.seq_no <= :to_seq
     ORDER BY i.seq_no`,
  ).all({
    doc_id: docId,
    branch_id: branchId,
    from_seq: snap?.upto_seq_no ?? 0,
    to_seq: targetSeq,
  }) as Array<{ bytes: Uint8Array }>;
  const changes = rows.map((r) => r.bytes);
  const applied = Automerge.applyChanges(baseDoc, changes);
  const doc = Array.isArray(applied) ? applied[0] : applied;
  return Automerge.save(doc);
}
