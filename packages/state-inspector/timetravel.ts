// Time travel — how state got to where it is.
//
// The engine already reconstructs any entity at any seq (reconstruct.ts), so the
// autopsy can run the clock backwards and forwards. Two views:
//
//   diff      — what changed in an entity between two seqs (structural value diff)
//   timeline  — how an entity grew (per-write value summary + change count), or
//               how a space grew (commits over time, new vs touched entities)
//
// Values are normalized with `annotate` first, so links/streams compare as
// stable shapes instead of exploding into nested objects.

import type { SpaceDb } from "./db.ts";
import { annotate, summarize } from "./decode.ts";
import { getAtPath, reconstructDocument } from "./reconstruct.ts";

export type ChangeKind = "added" | "removed" | "changed";

export interface ValueChange {
  /** JSON path of the change, e.g. `value/items/0/title`. */
  path: string;
  kind: ChangeKind;
  before?: unknown;
  after?: unknown;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function canonical(v: unknown): string {
  const sort = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(sort);
    if (x && typeof x === "object") {
      const o = x as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(o).sort()) out[k] = sort(o[k]);
      return out;
    }
    return x;
  };
  return JSON.stringify(sort(v)) ?? "undefined";
}

/**
 * Structural diff of two already-annotated values. Recurses through objects and
 * arrays; leaves compare by canonical JSON. `maxDepth` bounds recursion (deeper
 * differences collapse to a single `changed` at the boundary).
 */
export function diffValues(
  before: unknown,
  after: unknown,
  basePath: string[] = [],
  maxDepth = 12,
): ValueChange[] {
  const out: ValueChange[] = [];
  const walk = (a: unknown, b: unknown, path: string[], depth: number) => {
    const here = path.join("/");
    if (canonical(a) === canonical(b)) return;
    if (a === undefined) {
      out.push({ path: here, kind: "added", after: b });
      return;
    }
    if (b === undefined) {
      out.push({ path: here, kind: "removed", before: a });
      return;
    }
    if (depth <= 0) {
      out.push({ path: here, kind: "changed", before: a, after: b });
      return;
    }
    if (isObj(a) && isObj(b)) {
      for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
        walk(a[k], b[k], [...path, k], depth - 1);
      }
      return;
    }
    if (Array.isArray(a) && Array.isArray(b)) {
      const n = Math.max(a.length, b.length);
      for (let i = 0; i < n; i++) {
        walk(a[i], b[i], [...path, String(i)], depth - 1);
      }
      return;
    }
    out.push({ path: here, kind: "changed", before: a, after: b });
  };
  walk(before, after, basePath, maxDepth);
  return out;
}

export interface EntityDiff {
  id: string;
  fromSeq: number | null;
  toSeq: number | null;
  fromExists: boolean;
  toExists: boolean;
  changes: ValueChange[];
}

/**
 * Diff an entity between two seqs. By default diffs the whole document (so
 * lineage/schema changes show too); pass a `path` to focus inside `value`.
 */
export function diffEntity(
  space: SpaceDb,
  opts: {
    id: string;
    scope?: string;
    branch?: string;
    fromSeq?: number;
    toSeq?: number;
    path?: string[];
    doc?: boolean;
  },
): EntityDiff {
  const { id } = opts;
  const scope = opts.scope ?? "space";
  const branch = opts.branch ?? "";
  const path = opts.path ?? [];
  // `from` defaults to birth (seq 0 = empty baseline), NOT latest — omitting
  // atSeq would reconstruct the head, making a no-`--from` diff always empty.
  const before = reconstructDocument(space, {
    id,
    scope,
    branch,
    atSeq: opts.fromSeq ?? 0,
  });
  const after = reconstructDocument(space, {
    id,
    scope,
    branch,
    atSeq: opts.toSeq,
  });
  const pick = (doc: typeof before) => {
    if (doc === undefined) return undefined;
    if (opts.doc) return annotate(doc);
    return annotate(getAtPath(doc.value, path));
  };
  return {
    id,
    fromSeq: opts.fromSeq ?? null,
    toSeq: opts.toSeq ?? null,
    fromExists: before !== undefined,
    toExists: after !== undefined,
    changes: diffValues(pick(before), pick(after)),
  };
}

export interface TimelineStep {
  seq: number;
  opIndex: number;
  op: string;
  commitSeq: number;
  session: string;
  createdAt: string;
  /** One-line summary of the entity's value after this write. */
  summary: string;
  /** Whether the entity exists after this write (false = delete tombstone). */
  exists: boolean;
  /** Number of value changes introduced by this write (vs the previous state). */
  changes: number;
}

/**
 * The life of one entity: every write, with the value summary after it and how
 * many paths changed. Reconstructs incrementally write-by-write.
 */
export function entityTimeline(
  space: SpaceDb,
  opts: {
    id: string;
    scope?: string;
    branch?: string;
    limit?: number;
  },
): TimelineStep[] {
  const scope = opts.scope ?? "space";
  const branch = opts.branch ?? "";
  const limit = opts.limit ?? 500;
  const rows = space.db
    .prepare(
      `SELECT r.seq, r.op_index, r.op, r.commit_seq,
              c.session_id, c.created_at
       FROM revision r JOIN "commit" c ON c.seq = r.commit_seq
       WHERE r.branch = ? AND r.id = ? AND r.scope_key = ?
       ORDER BY r.seq ASC, r.op_index ASC LIMIT ?`,
    )
    .all<{
      seq: number;
      op_index: number;
      op: string;
      commit_seq: number;
      session_id: string;
      created_at: string;
    }>(branch, opts.id, scope, limit);

  const steps: TimelineStep[] = [];
  let prevValue: unknown = undefined;
  for (const r of rows) {
    const doc = reconstructDocument(space, {
      id: opts.id,
      scope,
      branch,
      atSeq: r.seq,
    });
    const exists = doc !== undefined;
    const value = exists ? annotate(doc!.value) : undefined;
    const changes = diffValues(prevValue, value).length;
    steps.push({
      seq: r.seq,
      opIndex: r.op_index,
      op: r.op,
      commitSeq: r.commit_seq,
      session: r.session_id,
      createdAt: r.created_at,
      summary: exists ? summarize(doc!.value) : "(deleted)",
      exists,
      changes,
    });
    prevValue = value;
  }
  return steps;
}

export interface SpaceTimelineEntry {
  commitSeq: number;
  createdAt: string;
  session: string;
  /** Entities touched (revisions) in this commit. */
  touched: number;
  /** Entities seen here for the first time. */
  created: number;
  /** Cumulative distinct entities up to and including this commit. */
  cumulativeEntities: number;
}

/** How a space grew: per-commit touched/created counts and a cumulative total. */
export function spaceTimeline(
  space: SpaceDb,
  opts: { branch?: string; scope?: string; limit?: number } = {},
): SpaceTimelineEntry[] {
  const branch = opts.branch ?? "";
  const scope = opts.scope ?? "space";
  const limit = opts.limit ?? 500;

  // First-seen seq per entity → lets us count "created" per commit.
  const firstSeen = new Map<string, number>();
  for (
    const r of space.db
      .prepare(
        `SELECT id, min(commit_seq) firstCommit FROM revision
         WHERE branch = ? AND scope_key = ? GROUP BY id`,
      )
      .all<{ id: string; firstCommit: number }>(branch, scope)
  ) {
    firstSeen.set(r.id, r.firstCommit);
  }

  const commits = space.db
    .prepare(
      `SELECT c.seq, c.created_at, c.session_id,
              count(r.id) touched,
              sum(CASE WHEN r.op_index = 0 THEN 1 ELSE 0 END) AS distinctish
       FROM "commit" c
       LEFT JOIN revision r ON r.commit_seq = c.seq
         AND r.branch = ? AND r.scope_key = ?
       GROUP BY c.seq ORDER BY c.seq ASC LIMIT ?`,
    )
    .all<{
      seq: number;
      created_at: string;
      session_id: string;
      touched: number;
    }>(branch, scope, limit);

  // created-per-commit: count entities whose firstCommit == this commit.
  const createdByCommit = new Map<number, number>();
  for (const fc of firstSeen.values()) {
    createdByCommit.set(fc, (createdByCommit.get(fc) ?? 0) + 1);
  }

  let cumulative = 0;
  return commits.map((c) => {
    const created = createdByCommit.get(c.seq) ?? 0;
    cumulative += created;
    return {
      commitSeq: c.seq,
      createdAt: c.created_at,
      session: c.session_id,
      touched: c.touched,
      created,
      cumulativeEntities: cumulative,
    };
  });
}
