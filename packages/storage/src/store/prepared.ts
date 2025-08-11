import type { Database } from "@db/sqlite";
import { NOW_SQL } from "./sql.ts";

type Statements = {
  selectActorLamport: any;
  selectChangeExists: any;
  insertChangeIndex: any;
  selectJsonCache: any;
  upsertJsonCache: any;
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
  } as const as Statements;
  dbToStatements.set(db, stmts);
  return stmts;
}
