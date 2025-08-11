import type { Database } from "@db/sqlite";

type Statements = {
  selectActorLamport: any;
  selectChangeExists: any;
  insertChangeIndex: any;
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
       VALUES(:doc_id, :branch_id, :seq_no, :change_hash, :bytes_hash, :deps_json, :lamport, :actor_id, :tx_id, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
    ),
  } as const as Statements;
  dbToStatements.set(db, stmts);
  return stmts;
}


