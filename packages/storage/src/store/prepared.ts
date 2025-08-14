import type { Database } from "@db/sqlite";
import { NOW_SQL } from "./sql.ts";

type SelectActorLamportParams = { branch_id: string; actor_id: string };
type SelectActorLamportRow = { lamport: number };
type SelectChangeExistsParams = { branch_id: string; hash: string };
type SelectChangeExistsRow = { 1: number };
type InsertChangeIndexParams = {
  doc_id: string;
  branch_id: string;
  seq_no: number;
  change_hash: string;
  bytes_hash: Uint8Array;
  deps_json: string;
  lamport: number;
  actor_id: string;
  tx_id: number;
};
type SelectJsonCacheParams = { doc_id: string; branch_id: string };
type SelectJsonCacheRow = { json: string; seq_no: number };
type UpsertJsonCacheParams = {
  doc_id: string;
  branch_id: string;
  seq_no: number;
  json: string;
};
type SelectLatestSnapshotParams = {
  doc_id: string;
  branch_id: string;
  target: number;
};
type SelectLatestSnapshotRow = {
  snapshot_id: string;
  upto_seq_no: number;
  bytes: Uint8Array;
};
type SelectChunksRangeParams = {
  doc_id: string;
  branch_id: string;
  from_seq: number;
  to_seq: number;
};
type SelectChunksRangeRow = { bytes: Uint8Array };
type SelectChangeBytesRangeParams = SelectChunksRangeParams;
type SelectChangeBytesRangeRow = { bytes: Uint8Array };
type SelectHeadsByDocNameParams = { doc_id: string; name: string };
type SelectHeadsByDocNameRow = {
  branch_id: string;
  heads_json: string;
  seq_no: number;
  tx_id: number;
  root_hash: Uint8Array | null;
};
type UpdateHeadsParams = {
  heads_json: string;
  seq_no: number;
  tx_id: number;
  branch_id: string;
  root_hash: Uint8Array;
};

type Prepared<Params, Row> = {
  get(params: Params): Row | undefined;
  all(params: Params): Array<Row>;
  run(params: Params): void;
};

type Statements = {
  selectActorLamport: Prepared<SelectActorLamportParams, SelectActorLamportRow>;
  selectChangeExists: Prepared<SelectChangeExistsParams, SelectChangeExistsRow>;
  insertChangeIndex: Prepared<InsertChangeIndexParams, never>;
  selectJsonCache: Prepared<SelectJsonCacheParams, SelectJsonCacheRow>;
  upsertJsonCache: Prepared<UpsertJsonCacheParams, never>;
  // PIT
  selectLatestSnapshot: Prepared<SelectLatestSnapshotParams, SelectLatestSnapshotRow>;
  selectChunksRange: Prepared<SelectChunksRangeParams, SelectChunksRangeRow>;
  selectChangeBytesRange: Prepared<SelectChangeBytesRangeParams, SelectChangeBytesRangeRow>;
  // Heads
  selectHeadsByDocName: Prepared<SelectHeadsByDocNameParams, SelectHeadsByDocNameRow>;
  updateHeads: Prepared<UpdateHeadsParams, never>;
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
    ) as Prepared<SelectActorLamportParams, SelectActorLamportRow>,
    selectChangeExists: db.prepare(
      `SELECT 1 FROM am_change_index
       WHERE branch_id = :branch_id AND change_hash = :hash LIMIT 1`,
    ) as Prepared<SelectChangeExistsParams, SelectChangeExistsRow>,
    insertChangeIndex: (db.prepare(
      `INSERT OR REPLACE INTO am_change_index
       (doc_id, branch_id, seq_no, change_hash, bytes_hash, deps_json, lamport, actor_id, tx_id, committed_at)
       VALUES(:doc_id, :branch_id, :seq_no, :change_hash, :bytes_hash, :deps_json, :lamport, :actor_id, :tx_id, ${NOW_SQL})`,
    ) as unknown) as Prepared<InsertChangeIndexParams, never>,
    selectJsonCache: db.prepare(
      `SELECT json, seq_no FROM json_cache WHERE doc_id = :doc_id AND branch_id = :branch_id`,
    ) as Prepared<SelectJsonCacheParams, SelectJsonCacheRow>,
    upsertJsonCache: (db.prepare(
      `INSERT INTO json_cache(doc_id, branch_id, seq_no, json, updated_at)
       VALUES(:doc_id, :branch_id, :seq_no, :json, ${NOW_SQL})
       ON CONFLICT(doc_id, branch_id) DO UPDATE SET
         seq_no = MAX(json_cache.seq_no, excluded.seq_no),
         json = CASE WHEN excluded.seq_no >= json_cache.seq_no THEN excluded.json ELSE json_cache.json END,
         updated_at = excluded.updated_at
       WHERE excluded.seq_no >= json_cache.seq_no;`,
    ) as unknown) as Prepared<UpsertJsonCacheParams, never>,
    // PIT
    selectLatestSnapshot: db.prepare(
      `SELECT snapshot_id, upto_seq_no, bytes
       FROM am_snapshots
       WHERE doc_id = :doc_id AND branch_id = :branch_id AND upto_seq_no <= :target
       ORDER BY upto_seq_no DESC LIMIT 1`,
    ) as Prepared<SelectLatestSnapshotParams, SelectLatestSnapshotRow>,
    selectChunksRange: db.prepare(
      `SELECT bytes FROM am_chunks
       WHERE doc_id = :doc_id AND branch_id = :branch_id
         AND seq_no > :from_seq AND seq_no <= :to_seq
       ORDER BY seq_no`,
    ) as Prepared<SelectChunksRangeParams, SelectChunksRangeRow>,
    selectChangeBytesRange: db.prepare(
      `SELECT b.bytes AS bytes
       FROM am_change_index i
       JOIN am_change_blobs b ON (i.bytes_hash = b.bytes_hash)
       WHERE i.doc_id = :doc_id AND i.branch_id = :branch_id
         AND i.seq_no > :from_seq AND i.seq_no <= :to_seq
       ORDER BY i.seq_no`,
    ) as Prepared<SelectChangeBytesRangeParams, SelectChangeBytesRangeRow>,
    // Heads
    selectHeadsByDocName: db.prepare(
      `SELECT h.branch_id as branch_id, h.heads_json as heads_json, h.seq_no as seq_no, h.tx_id as tx_id, h.root_hash as root_hash
       FROM am_heads h JOIN branches b ON (h.branch_id = b.branch_id)
       WHERE b.doc_id = :doc_id AND b.name = :name`,
    ) as Prepared<SelectHeadsByDocNameParams, SelectHeadsByDocNameRow>,
    updateHeads: (db.prepare(
      `UPDATE am_heads SET heads_json = :heads_json, seq_no = :seq_no, tx_id = :tx_id, root_hash = :root_hash, committed_at = ${NOW_SQL}
       WHERE branch_id = :branch_id`,
    ) as unknown) as Prepared<UpdateHeadsParams, never>,
  } as const as Statements;
  dbToStatements.set(db, stmts);
  return stmts;
}
