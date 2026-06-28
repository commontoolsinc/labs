// Conflicts & async — the contested/concurrent dimension of multiplayer state.
//
// The durable store records enough to reconstruct who fought over what:
//   - `revision` — every write, joinable to `commit.session_id` (the writer).
//   - `commit.original.reads.confirmed[]` — `{ id, path, scope, seq }`: what each
//     commit READ and at which seq. So a commit declares "I read X@N".
//
// Two grounded views:
//   1. CONTENTION (write-write): entities written by ≥2 distinct sessions, with
//      the interleaved writer timeline — the back-and-forth of concurrent edits.
//   2. STALE READS (read-write / lost-update): a commit that wrote X having read
//      X@N, when a DIFFERENT session wrote X at W with N < W < the writer's commit
//      — i.e. it never saw W's write. The retroactive "conflict loser" signal.
//
// HONESTY: the server serializes the durable log, so what's here is the COMMITTED
// order. Rejected/retried client commits aren't persisted; we infer contention
// and stale reads from the successful log, not from rejection records.

import type { SpaceDb } from "./db.ts";
import { decodeStored } from "./decode.ts";
import { parseScope } from "./scopes.ts";

export interface Writer {
  seq: number;
  commitSeq: number;
  session: string;
  /** The writer's identity (principal DID parsed from the session). */
  principal?: string;
  op: string;
  createdAt: string;
}

export interface ContendedEntity {
  id: string;
  /** Distinct writer sessions. */
  sessions: number;
  /** Distinct writer IDENTITIES — `>=2` is real cross-user contention vs the
   * same user editing from multiple tabs/devices. */
  principals: number;
  /** True when ≥2 distinct identities wrote it (multi-user, not multi-session). */
  multiUser: boolean;
  writes: number;
  /** Writer timeline, seq-ordered. */
  writers: Writer[];
  /** Sessions alternate (A→B→A) — concurrent back-and-forth, not a handoff. */
  interleaved: boolean;
}

/** Distinct writer identities (principals) across a writer list. */
function principalCount(writers: Writer[]): number {
  return new Set(writers.map((w) => w.principal).filter(Boolean)).size;
}

/** Number of times the writing session changes across the seq-ordered list. */
function sessionSwitches(writers: Writer[]): number {
  let switches = 0;
  for (let i = 1; i < writers.length; i++) {
    if (writers[i].session !== writers[i - 1].session) switches++;
  }
  return switches;
}

/**
 * Entities written by ≥2 distinct sessions — contested cells. Cheap: one join,
 * then per-contested-entity the writer timeline. `interleaved` flags real
 * back-and-forth (≥2 session switches) vs a one-time handoff.
 */
export function contendedEntities(
  space: SpaceDb,
  opts: { branch?: string; scope?: string; limit?: number } = {},
): ContendedEntity[] {
  const branch = opts.branch ?? "";
  const scope = opts.scope ?? "space";
  const limit = opts.limit ?? 100;

  const ids = space.db
    .prepare(
      `SELECT r.id, count(DISTINCT c.session_id) sessions, count(*) writes
       FROM revision r JOIN "commit" c ON c.seq = r.commit_seq
       WHERE r.branch = ? AND r.scope_key = ?
       GROUP BY r.id HAVING sessions >= 2
       ORDER BY sessions DESC, writes DESC LIMIT ?`,
    )
    .all<{ id: string; sessions: number; writes: number }>(
      branch,
      scope,
      limit,
    );

  const writersStmt = space.db.prepare(
    `SELECT r.seq, r.commit_seq, r.op, c.session_id, c.created_at
     FROM revision r JOIN "commit" c ON c.seq = r.commit_seq
     WHERE r.branch = ? AND r.id = ? AND r.scope_key = ?
     ORDER BY r.seq ASC, r.op_index ASC`,
  );

  return ids.map((e) => {
    const writers: Writer[] = writersStmt
      .all<{
        seq: number;
        commit_seq: number;
        op: string;
        session_id: string;
        created_at: string;
      }>(branch, e.id, scope)
      .map((w) => ({
        seq: w.seq,
        commitSeq: w.commit_seq,
        session: w.session_id,
        principal: parseScope(w.session_id).principal,
        op: w.op,
        createdAt: w.created_at,
      }));
    const principals = principalCount(writers);
    return {
      id: e.id,
      sessions: e.sessions,
      principals,
      multiUser: principals >= 2,
      writes: e.writes,
      writers,
      interleaved: sessionSwitches(writers) >= 2,
    };
  }).sort((a, b) =>
    (b.multiUser ? 1 : 0) - (a.multiUser ? 1 : 0) ||
    b.principals - a.principals || b.sessions - a.sessions
  );
}

export interface StaleRead {
  /** The commit that read the entity. */
  readerCommitSeq: number;
  readerSession: string;
  /** The seq the reader saw the entity at. */
  readAtSeq: number;
  /** A write by a DIFFERENT session the reader never saw (readAtSeq < seq < readerCommitSeq). */
  missedWriteSeq: number;
  missedWriteSession: string;
  /** True when the reader ALSO wrote the entity (a real lost-update risk). */
  readerAlsoWrote: boolean;
}

export interface EntityConflicts {
  id: string;
  writers: Writer[];
  writerSessions: number;
  /** Distinct writer identities — `>=2` is real cross-user contention. */
  writerPrincipals: number;
  multiUser: boolean;
  interleaved: boolean;
  /** Stale reads: the reader committed without seeing a prior concurrent write. */
  staleReads: StaleRead[];
}

interface ReadRef {
  id: string;
  seq: number;
}

/**
 * Deep per-entity conflict analysis: the writer timeline plus stale-read /
 * lost-update detection. For each commit that READ this entity at seq N, if a
 * DIFFERENT session wrote it at W (N < W < the reader's own commit seq), the
 * reader never saw W — a concurrent-write it missed. Flagged stronger when the
 * reader also wrote the entity (write-write lost update).
 */
export function entityConflicts(
  space: SpaceDb,
  id: string,
  opts: { branch?: string; scope?: string } = {},
): EntityConflicts {
  const branch = opts.branch ?? "";
  const scope = opts.scope ?? "space";

  const writers: Writer[] = space.db
    .prepare(
      `SELECT r.seq, r.commit_seq, r.op, c.session_id, c.created_at
       FROM revision r JOIN "commit" c ON c.seq = r.commit_seq
       WHERE r.branch = ? AND r.id = ? AND r.scope_key = ?
       ORDER BY r.seq ASC, r.op_index ASC`,
    )
    .all<{
      seq: number;
      commit_seq: number;
      op: string;
      session_id: string;
      created_at: string;
    }>(branch, id, scope)
    .map((w) => ({
      seq: w.seq,
      commitSeq: w.commit_seq,
      session: w.session_id,
      principal: parseScope(w.session_id).principal,
      op: w.op,
      createdAt: w.created_at,
    }));

  // Commits that wrote this entity (to flag reader-also-wrote).
  const wroteByCommit = new Map<number, string>();
  for (const w of writers) wroteByCommit.set(w.commitSeq, w.session);

  // Candidate reader commits: those whose stored ClientCommit mentions this id.
  // (Pre-filter by LIKE to avoid decoding every commit in the space.)
  const candidates = space.db
    .prepare(
      `SELECT seq, session_id, original FROM "commit"
       WHERE original LIKE '%' || ? || '%' ORDER BY seq ASC`,
    )
    .all<{ seq: number; session_id: string; original: string }>(id);

  const staleReads: StaleRead[] = [];
  for (const c of candidates) {
    let reads: ReadRef[] = [];
    try {
      const o = decodeStored(c.original) as {
        reads?: { confirmed?: ReadRef[] };
      };
      reads = (o.reads?.confirmed ?? []).filter((r) => r.id === id);
    } catch {
      continue;
    }
    for (const rd of reads) {
      // A write to this entity by ANOTHER session, after what the reader saw but
      // before the reader committed → the reader missed it.
      for (const w of writers) {
        if (
          w.seq > rd.seq && w.commitSeq < c.seq &&
          w.session !== c.session_id
        ) {
          staleReads.push({
            readerCommitSeq: c.seq,
            readerSession: c.session_id,
            readAtSeq: rd.seq,
            missedWriteSeq: w.seq,
            missedWriteSession: w.session,
            readerAlsoWrote: wroteByCommit.has(c.seq),
          });
          break; // one missed write per read is enough to flag it
        }
      }
    }
  }

  const writerPrincipals = principalCount(writers);
  return {
    id,
    writers,
    writerSessions: new Set(writers.map((w) => w.session)).size,
    writerPrincipals,
    multiUser: writerPrincipals >= 2,
    interleaved: sessionSwitches(writers) >= 2,
    staleReads,
  };
}
