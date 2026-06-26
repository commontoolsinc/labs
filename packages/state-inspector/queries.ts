// Autopsy queries over a space DB. These answer the "who/what/when" questions
// the proposal lists, using only the durable entity tables (no scheduler graph
// required, since those tables are usually absent).

import type { CommitRow, SpaceDb } from "./db.ts";
import { hasSchedulerTables } from "./db.ts";

export interface SpaceSummary {
  path: string;
  hasSchedulerTables: boolean;
  commits: number;
  commitSeqRange: [number, number] | null;
  sessions: number;
  revisions: number;
  entities: number;
  ops: Record<string, number>;
  branches: { name: string; head_seq: number; status: string }[];
  scopes: { scope_key: string; count: number }[];
}

export function summarizeSpace(space: SpaceDb): SpaceSummary {
  const db = space.db;
  const one = <T extends object>(sql: string): T => db.prepare(sql).get<T>() as T;

  const commitAgg = one<{ n: number; lo: number | null; hi: number | null; s: number }>(
    `SELECT count(*) n, min(seq) lo, max(seq) hi, count(DISTINCT session_id) s FROM "commit"`,
  );
  const revAgg = one<{ n: number; e: number }>(
    `SELECT count(*) n, count(DISTINCT id) e FROM revision`,
  );
  const ops = db
    .prepare(`SELECT op, count(*) c FROM revision GROUP BY op`)
    .all<{ op: string; c: number }>();
  const branches = db
    .prepare(`SELECT name, head_seq, status FROM branch ORDER BY name`)
    .all<{ name: string; head_seq: number; status: string }>();
  const scopes = db
    .prepare(
      `SELECT scope_key, count(*) count FROM revision GROUP BY scope_key ORDER BY count DESC`,
    )
    .all<{ scope_key: string; count: number }>();

  return {
    path: space.path,
    hasSchedulerTables: hasSchedulerTables(db),
    commits: commitAgg.n,
    commitSeqRange: commitAgg.lo === null ? null : [commitAgg.lo, commitAgg.hi!],
    sessions: commitAgg.s,
    revisions: revAgg.n,
    entities: revAgg.e,
    ops: Object.fromEntries(ops.map((r) => [r.op, r.c])),
    branches,
    scopes,
  };
}

export interface CommitInfo {
  seq: number;
  branch: string;
  session: string;
  localSeq: number;
  ops: number;
  reads: number;
  createdAt: string;
}

/** List commits, most recent first, optionally filtered by session prefix. */
export function listCommits(
  space: SpaceDb,
  opts: { session?: string; limit?: number } = {},
): CommitInfo[] {
  const limit = opts.limit ?? 50;
  const where = opts.session ? `WHERE session_id LIKE ?` : ``;
  const params: string[] = opts.session ? [`${opts.session}%`] : [];
  const rows = space.db
    .prepare(
      `SELECT seq, branch, session_id, local_seq, original, created_at
       FROM "commit" ${where} ORDER BY seq DESC LIMIT ?`,
    )
    .all<CommitRow>(...params, limit);

  return rows.map((r) => {
    let ops = 0;
    let reads = 0;
    try {
      const parsed = JSON.parse(r.original);
      ops = Array.isArray(parsed.operations) ? parsed.operations.length : 0;
      reads = (parsed.reads?.confirmed?.length ?? 0) +
        (parsed.reads?.pending?.length ?? 0);
    } catch {
      // leave zeroed if payload is unparseable
    }
    return {
      seq: r.seq,
      branch: r.branch,
      session: r.session_id,
      localSeq: r.local_seq,
      ops,
      reads,
      createdAt: r.created_at,
    };
  });
}

export interface WriteEvent {
  seq: number;
  commitSeq: number;
  opIndex: number;
  op: string;
  session: string;
  localSeq: number;
  createdAt: string;
}

/** Every write that touched an entity, in order — the "who wrote this" answer. */
export function entityHistory(
  space: SpaceDb,
  opts: { id: string; scope?: string; branch?: string; limit?: number },
): WriteEvent[] {
  const scope = opts.scope ?? "space";
  const branch = opts.branch ?? "";
  const limit = opts.limit ?? 200;
  return space.db
    .prepare(
      `SELECT r.seq, r.commit_seq, r.op_index, r.op,
              c.session_id, c.local_seq, c.created_at
       FROM revision r JOIN "commit" c ON c.seq = r.commit_seq
       WHERE r.branch = ? AND r.id = ? AND r.scope_key = ?
       ORDER BY r.seq ASC, r.op_index ASC LIMIT ?`,
    )
    .all<{
      seq: number;
      commit_seq: number;
      op_index: number;
      op: string;
      session_id: string;
      local_seq: number;
      created_at: string;
    }>(branch, opts.id, scope, limit)
    .map((r) => ({
      seq: r.seq,
      commitSeq: r.commit_seq,
      opIndex: r.op_index,
      op: r.op,
      session: r.session_id,
      localSeq: r.local_seq,
      createdAt: r.created_at,
    }));
}

export interface HotEntity {
  id: string;
  scope: string;
  writes: number;
  sessions: number;
}

/** Entities ranked by write count — a contention/hot-path proxy. */
export function hotEntities(
  space: SpaceDb,
  opts: { branch?: string; limit?: number } = {},
): HotEntity[] {
  const branch = opts.branch ?? "";
  const limit = opts.limit ?? 20;
  return space.db
    .prepare(
      `SELECT r.id, r.scope_key,
              count(*) writes, count(DISTINCT c.session_id) sessions
       FROM revision r JOIN "commit" c ON c.seq = r.commit_seq
       WHERE r.branch = ?
       GROUP BY r.id, r.scope_key
       ORDER BY writes DESC LIMIT ?`,
    )
    .all<{ id: string; scope_key: string; writes: number; sessions: number }>(
      branch,
      limit,
    )
    .map((r) => ({
      id: r.id,
      scope: r.scope_key,
      writes: r.writes,
      sessions: r.sessions,
    }));
}
