// Read-only access to a memory v2 space SQLite file.
//
// Everything here is offline and side-effect free: we open the durable store
// the server already wrote and never mutate it. See the proposal in
// docs/plans/2026-06-26-runtime-trace-inspector.md for why the durable store is
// treated as the flight recorder.

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
  return {
    db,
    path,
    close: () => db.close(),
  };
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
