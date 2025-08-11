import type { Database } from "@db/sqlite";
import { NOW_SQL } from "./sql.ts";

type Statements = {
  selectActorLamport: any;
  selectChangeExists: any;
  insertChangeIndex: any;
  selectJsonCache: any;
  upsertJsonCache: any;
  // PIT
  selectLatestSnapshot: any;
  selectChunksRange: any;
  selectChangeBytesRange: any;
  // Heads
  selectHeadsByDocName: any;
  updateHeads: any;
};

const dbToStatements = new WeakMap<Database, Statements>();

export function getPrepared(db: Database): Statements {
  let stmts = dbToStatements.get(db);
  if (stmts) return stmts;
  stmts = {
    selectActorLamport: db.prepare(
      `SELECT lamport FROM am_change_index
       WHERE branch_id = :branch_id AND actor_id = :actor_id
       ORDER BY seq_no DESC LIMIT 1`,
    ),
    selectChangeExists: db.prepare(
      `SELECT 1 FROM am_change_index
       WHERE branch_id = :branch_id AND change_hash = :hash LIMIT 1`,
    ),
    insertChangeIndex: db.prepare(
      `INSERT OR REPLACE INTO am_change_index
       (doc_id, branch_id, seq_no, change_hash, bytes_hash, deps_json, lamport, actor_id, tx_id, committed_at)
       VALUES(:doc_id, :branch_id, :seq_no, :change_hash, :bytes_hash, :deps_json, :lamport, :actor_id, :tx_id, ${NOW_SQL})`,
    ),
    selectJsonCache: db.prepare(
      `SELECT json, seq_no FROM json_cache WHERE doc_id = :doc_id AND branch_id = :branch_id`,
    ),
    upsertJsonCache: db.prepare(
      `INSERT INTO json_cache(doc_id, branch_id, seq_no, json, updated_at)
       VALUES(:doc_id, :branch_id, :seq_no, :json, ${NOW_SQL})
       ON CONFLICT(doc_id, branch_id) DO UPDATE SET
         seq_no = MAX(json_cache.seq_no, excluded.seq_no),
         json = CASE WHEN excluded.seq_no >= json_cache.seq_no THEN excluded.json ELSE json_cache.json END,
         updated_at = excluded.updated_at
       WHERE excluded.seq_no >= json_cache.seq_no;`,
    ),
    // PIT
    selectLatestSnapshot: db.prepare(
      `SELECT snapshot_id, upto_seq_no, bytes
       FROM am_snapshots
       WHERE doc_id = :doc_id AND branch_id = :branch_id AND upto_seq_no <= :target
       ORDER BY upto_seq_no DESC LIMIT 1`,
    ),
    selectChunksRange: db.prepare(
      `SELECT bytes FROM am_chunks
       WHERE doc_id = :doc_id AND branch_id = :branch_id
         AND seq_no > :from_seq AND seq_no <= :to_seq
       ORDER BY seq_no`,
    ),
    selectChangeBytesRange: db.prepare(
      `SELECT b.bytes AS bytes
       FROM am_change_index i
       JOIN am_change_blobs b ON (i.bytes_hash = b.bytes_hash)
       WHERE i.doc_id = :doc_id AND i.branch_id = :branch_id
         AND i.seq_no > :from_seq AND i.seq_no <= :to_seq
       ORDER BY i.seq_no`,
    ),
    // Heads
    selectHeadsByDocName: db.prepare(
      `SELECT h.branch_id as branch_id, h.heads_json as heads_json, h.seq_no as seq_no, h.tx_id as tx_id, h.root_hash as root_hash
       FROM am_heads h JOIN branches b ON (h.branch_id = b.branch_id)
       WHERE b.doc_id = :doc_id AND b.name = :name`,
    ),
    updateHeads: db.prepare(
      `UPDATE am_heads SET heads_json = :heads_json, seq_no = :seq_no, tx_id = :tx_id, root_hash = :root_hash, committed_at = ${NOW_SQL}
       WHERE branch_id = :branch_id`,
    ),
  } as const as Statements;
  dbToStatements.set(db, stmts);
  return stmts;
}
