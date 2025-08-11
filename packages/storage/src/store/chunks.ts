import type { Database } from "@db/sqlite";
import * as Automerge from "@automerge/automerge";
import { sha256Hex } from "./crypto.ts";

export function isChunkingEnabled(db: Database): boolean {
  try {
    const row = db.prepare(
      `SELECT value_json FROM space_settings WHERE key = 'settings'`,
    ).get() as { value_json: string } | undefined;
    if (!row) return true;
    const settings = JSON.parse(row.value_json) as { enableChunks?: boolean };
    if (typeof settings.enableChunks === "boolean") {
      return settings.enableChunks;
    }
    return true;
  } catch {
    return true;
  }
}

/**
 * If we did not just create a snapshot at seqNo, emit incremental chunks for
 * all changes since the last snapshot upto seqNo. Each row is stored with the
 * specific seq_no of the change it represents.
 */
export async function maybeEmitChunks(
  db: Database,
  docId: string,
  branchId: string,
  prevSeqNo: number,
  seqNo: number,
): Promise<void> {
  if (!isChunkingEnabled(db)) return;
  if (seqNo <= prevSeqNo) return;

  // Find the latest snapshot for this branch
  const snap = db.prepare(
    `SELECT upto_seq_no, bytes FROM am_snapshots
     WHERE doc_id = :doc_id AND branch_id = :branch_id
       ORDER BY upto_seq_no DESC LIMIT 1`,
  ).get({ doc_id: docId, branch_id: branchId }) as
    | { upto_seq_no: number; bytes: Uint8Array }
    | undefined;

  if (!snap) return; // no base snapshot yet → skip chunking

  // Load base doc from snapshot
  let doc = Automerge.load(snap.bytes);
  // Collect changes after snapshot upto target seqNo
  const rows = db.prepare(
    `SELECT i.seq_no AS seq_no, b.bytes AS bytes
     FROM am_change_index i
     JOIN am_change_blobs b ON (i.bytes_hash = b.bytes_hash)
     WHERE i.doc_id = :doc_id AND i.branch_id = :branch_id
       AND i.seq_no > :from_seq AND i.seq_no <= :to_seq
     ORDER BY i.seq_no`,
  ).all({
    doc_id: docId,
    branch_id: branchId,
    from_seq: snap.upto_seq_no,
    to_seq: seqNo,
  }) as Array<{ seq_no: number; bytes: Uint8Array }>;

  // Apply changes one by one and emit saveIncremental as a chunk for each change
  for (const row of rows) {
    const applied = Automerge.applyChanges(doc, [row.bytes]);
    doc = Array.isArray(applied) ? applied[0] : applied;
    const chunk = Automerge.saveIncremental(doc);
    // Persist chunk row
    const digest = await sha256Hex(chunk);
    db.run(
      `INSERT OR IGNORE INTO am_chunks(space_id, doc_id, branch_id, seq_no, from_snapshot_seq, base_snapshot_digest, chunk_kind, bytes, digest)
       VALUES(:space_id, :doc_id, :branch_id, :seq_no, :from_snapshot_seq, :base_snapshot_digest, 'automerge_incremental', :bytes, :digest)`,
      {
        space_id: null,
        doc_id: docId,
        branch_id: branchId,
        seq_no: row.seq_no,
        from_snapshot_seq: snap.upto_seq_no,
        base_snapshot_digest: null,
        bytes: chunk,
        digest,
      },
    );
  }
}
