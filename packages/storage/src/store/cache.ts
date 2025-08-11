import type { Database } from "@db/sqlite";

export function upsertJsonCache(
  db: Database,
  params: { docId: string; branchId: string; seqNo: number; json: string },
): void {
  const { docId, branchId, seqNo, json } = params;
  db.run(
    `INSERT INTO json_cache(doc_id, branch_id, seq_no, json, updated_at)
     VALUES(:doc_id, :branch_id, :seq_no, :json, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
     ON CONFLICT(doc_id, branch_id) DO UPDATE SET
       seq_no = excluded.seq_no,
       json = excluded.json,
       updated_at = excluded.updated_at
     WHERE excluded.seq_no >= json_cache.seq_no;`,
    {
      doc_id: docId,
      branch_id: branchId,
      seq_no: seqNo,
      json,
    },
  );
}


