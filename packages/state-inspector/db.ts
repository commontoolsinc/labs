// Read-only access to a memory v2 space SQLite file.
//
// Everything here is offline and side-effect free: we open the durable store
// the server already wrote and never mutate it — the durable store is the
// flight recorder (see README.md).

import { Database } from "@db/sqlite";

export interface CommitRow {
  seq: number;
  branch: string;
  session_id: string;
  local_seq: number;
  invocation_ref: string | null;
  authorization_ref: string | null;
  original: string;
  resolution: string;
  created_at: string;
}

export interface RevisionRow {
  branch: string;
  id: string;
  scope_key: string;
  seq: number;
  op_index: number;
  op: string;
  data: string | null;
  commit_seq: number;
}

export interface BranchRow {
  name: string;
  parent_branch: string | null;
  fork_seq: number | null;
  created_seq: number;
  head_seq: number;
  status: string;
}

export interface SpaceDb {
  readonly db: Database;
  readonly path: string;
  close(): void;
}

/** Open a space DB read-only. Safe against stale (and, best-effort, live) files. */
export function openSpace(path: string): SpaceDb {
  const db = new Database(path, { readonly: true });
  shimScopeKey(db);
  return {
    db,
    path,
    close: () => db.close(),
  };
}

/**
 * Older space DBs predate the per-scope `scope_key` column (added with
 * PerUser/PerSession scopes) on `revision` AND `snapshot`. Every scope-aware
 * query filters `scope_key = …`, so on those DBs we shim the column with a TEMP
 * VIEW that shadows the table and supplies a constant `'space'` scope. Temp
 * objects are writable even on a READONLY main DB and take name-resolution
 * precedence over the real table, so all existing queries work unchanged.
 */
function shimScopeKey(db: Database): void {
  const lacksScopeKey = (table: string): boolean =>
    !db
      .prepare(
        `SELECT 1 FROM pragma_table_info(?) WHERE name = 'scope_key'`,
      )
      .get<{ 1: number }>(table);
  const tableExists = (table: string): boolean =>
    !!db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?",
      )
      .get<{ 1: number }>(table);

  if (lacksScopeKey("revision")) {
    db.exec(
      `CREATE TEMP VIEW revision AS
         SELECT branch, id, 'space' AS scope_key, seq, op_index, op, data, commit_seq
         FROM main.revision`,
    );
  }
  // The snapshot table is optional and, on the same legacy DBs, also lacks
  // scope_key — shim it too so the snapshot-base read doesn't hit a missing
  // column (it would otherwise throw on a pre-scope_key DB that has snapshots).
  if (tableExists("snapshot") && lacksScopeKey("snapshot")) {
    db.exec(
      `CREATE TEMP VIEW snapshot AS
         SELECT branch, id, 'space' AS scope_key, seq, value FROM main.snapshot`,
    );
  }
}

export function tableNames(db: Database): string[] {
  return db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    )
    .all<{ name: string }>()
    .map((r) => r.name);
}

/**
 * Scheduler persistence tables only exist when `persistentSchedulerState` was
 * enabled on the server. In practice they are usually absent, so the autopsy
 * core must degrade gracefully rather than assume the dependency graph is here.
 */
export function hasSchedulerTables(db: Database): boolean {
  return tableNames(db).includes("scheduler_observation");
}
