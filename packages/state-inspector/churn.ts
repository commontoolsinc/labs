// Commit-rate churn over time — the retrospective, offline view of "is this
// space writing more than it should be?".
//
// Why this exists as its own query (see docs/plans/space-clone-rehearsal.md):
// `hotEntities` ranks entities by all-time write count, which cannot show a
// storm STARTING or a settle COMPLETING — both are shapes in time, not totals.
// The July 2026 Topics write storm (20 compiler-generated cells producing 96%
// of all commits, peaking at ~1,598 commits/minute) is invisible to a total and
// obvious in a rate curve.
//
// Two neighbours exist and neither fills this slot: the OTel commit telemetry
// reports live rates, but only where a collector was attached when it mattered;
// the workload diagnostics (labs#4950) instrument an orchestrated run of a live
// runtime. This reads the durable store after the fact — any space, any window,
// no instrumentation required at incident time.
//
// Deliberately threshold-free: it reports, it does not judge. What counts as
// "settled" differs per space, and a wrong default would give false confidence
// at exactly the moment a migration checklist is trusted most.

import type { SpaceDb } from "./db.ts";

/** One time bucket of write activity. */
export interface ChurnBucket {
  /** Bucket start, UTC, `YYYY-MM-DD HH:MM:SS` (the store's own clock format). */
  start: string;
  /** Unix seconds for the bucket start — for plotting without re-parsing. */
  startEpoch: number;
  commits: number;
  revisions: number;
}

/** An entity ranked by writes within a single bucket. */
export interface ChurnEntity {
  id: string;
  scope: string;
  writes: number;
  sessions: number;
}

export interface ChurnReport {
  bucketSeconds: number;
  branch: string;
  /** First and last bucket start actually observed (null on an empty window). */
  from: string | null;
  to: string | null;
  totals: { commits: number; revisions: number };
  /** Contiguous, zero-filled from `from` to `to` so gaps read as quiet. */
  buckets: ChurnBucket[];
  /** The busiest bucket by commits, or null when the window is empty. */
  peak: ChurnBucket | null;
  /** Top writers inside `peak` — what to blame for the busiest minute. */
  peakEntities: ChurnEntity[];
  /**
   * Commits whose `created_at` SQLite could not parse as a time, and which are
   * therefore absent from every bucket. Nonzero means the curve is incomplete —
   * surfaced rather than silently dropped.
   */
  untimedCommits: number;
}

export interface ChurnOptions {
  branch?: string;
  /** Bucket width in seconds. Default 60. */
  bucketSeconds?: number;
  /** Lower bound on `commit.created_at`, inclusive. `YYYY-MM-DD HH:MM:SS` or ISO. */
  since?: string;
  /** Upper bound on `commit.created_at`, exclusive. */
  until?: string;
  /** How many entities to attribute the peak bucket to. Default 10. */
  top?: number;
}

/**
 * Zero-filling is what makes a curve readable, but a year-long store bucketed
 * by the second would materialize ~31M rows. Rather than silently truncate (and
 * report a curve with holes as if it were complete), refuse and say what to do.
 */
const MAX_BUCKETS = 20_000;

export function commitChurn(
  space: SpaceDb,
  options: ChurnOptions = {},
): ChurnReport {
  const branch = options.branch ?? "";
  const bucketSeconds = options.bucketSeconds ?? 60;
  const top = options.top ?? 10;
  if (!Number.isInteger(bucketSeconds) || bucketSeconds <= 0) {
    throw new Error("bucketSeconds must be a positive whole number of seconds");
  }

  const db = space.db;
  // `strftime('%s', …)` yields NULL for a value it cannot parse as a time, which
  // is how untimed rows are separated from real zero-activity buckets. It also
  // yields TEXT, and SQLite sorts every INTEGER before every TEXT — so each
  // comparison casts, or the bounds silently match everything (or nothing).
  const window: string[] = [`c.branch = :branch`];
  const params: Record<string, string | number> = { branch, b: bucketSeconds };
  if (options.since !== undefined) {
    window.push(
      `CAST(strftime('%s', c.created_at) AS INTEGER) >= ` +
        `CAST(strftime('%s', :since) AS INTEGER)`,
    );
    params.since = options.since;
  }
  if (options.until !== undefined) {
    window.push(
      `CAST(strftime('%s', c.created_at) AS INTEGER) < ` +
        `CAST(strftime('%s', :until) AS INTEGER)`,
    );
    params.until = options.until;
  }
  const where = window.join(" AND ");

  const untimed = db
    .prepare(
      `SELECT count(*) n FROM "commit" c
       WHERE c.branch = :branch AND strftime('%s', c.created_at) IS NULL`,
    )
    .get<{ n: number }>({ branch })!.n;

  // One row per bucket. LEFT JOIN so a commit that wrote no revisions still
  // counts as a commit; count(DISTINCT c.seq) so the join fan-out cannot
  // inflate the commit count.
  const rows = db
    .prepare(
      `SELECT CAST(strftime('%s', c.created_at) / :b AS INTEGER) * :b AS bucket,
              count(DISTINCT c.seq) commits,
              count(r.commit_seq) revisions
       FROM "commit" c
       LEFT JOIN revision r ON r.commit_seq = c.seq
       WHERE ${where} AND strftime('%s', c.created_at) IS NOT NULL
       GROUP BY bucket
       ORDER BY bucket`,
    )
    .all<{ bucket: number; commits: number; revisions: number }>(params);

  if (rows.length === 0) {
    return {
      bucketSeconds,
      branch,
      from: null,
      to: null,
      totals: { commits: 0, revisions: 0 },
      buckets: [],
      peak: null,
      peakEntities: [],
      untimedCommits: untimed,
    };
  }

  const first = rows[0].bucket;
  const last = rows[rows.length - 1].bucket;
  const span = (last - first) / bucketSeconds + 1;
  if (span > MAX_BUCKETS) {
    throw new Error(
      `window spans ${Math.round(span)} buckets at ${bucketSeconds}s ` +
        `(limit ${MAX_BUCKETS}); widen --bucket or narrow --since/--until.`,
    );
  }

  const observed = new Map(rows.map((r) => [r.bucket, r]));
  const buckets: ChurnBucket[] = [];
  for (let t = first; t <= last; t += bucketSeconds) {
    const hit = observed.get(t);
    buckets.push({
      start: epochToStoreTime(db, t),
      startEpoch: t,
      commits: hit?.commits ?? 0,
      revisions: hit?.revisions ?? 0,
    });
  }

  const totals = rows.reduce(
    (acc, r) => ({
      commits: acc.commits + r.commits,
      revisions: acc.revisions + r.revisions,
    }),
    { commits: 0, revisions: 0 },
  );

  // Peak by commits; revisions break the tie, so a burst of fat commits ranks
  // above the same number of trivial ones.
  const peak = buckets.reduce((best, b) =>
    b.commits > best.commits ||
      (b.commits === best.commits && b.revisions > best.revisions)
      ? b
      : best
  );

  return {
    bucketSeconds,
    branch,
    from: buckets[0].start,
    to: buckets[buckets.length - 1].start,
    totals,
    buckets,
    peak,
    peakEntities: entitiesInWindow(space, {
      branch,
      fromEpoch: peak.startEpoch,
      toEpoch: peak.startEpoch + bucketSeconds,
      limit: top,
    }),
    untimedCommits: untimed,
  };
}

/** Top entities by write count within a half-open epoch-second window. */
function entitiesInWindow(
  space: SpaceDb,
  opts: {
    branch: string;
    fromEpoch: number;
    toEpoch: number;
    limit: number;
  },
): ChurnEntity[] {
  return space.db
    .prepare(
      `SELECT r.id, r.scope_key, count(*) writes,
              count(DISTINCT c.session_id) sessions
       FROM revision r JOIN "commit" c ON c.seq = r.commit_seq
       WHERE c.branch = :branch
         AND CAST(strftime('%s', c.created_at) AS INTEGER) >= :from
         AND CAST(strftime('%s', c.created_at) AS INTEGER) < :to
       GROUP BY r.id, r.scope_key
       ORDER BY writes DESC, r.id
       LIMIT :limit`,
    )
    .all<
      { id: string; scope_key: string; writes: number; sessions: number }
    >({
      branch: opts.branch,
      from: opts.fromEpoch,
      to: opts.toEpoch,
      limit: opts.limit,
    })
    .map((r) => ({
      id: r.id,
      scope: r.scope_key,
      writes: r.writes,
      sessions: r.sessions,
    }));
}

/** Render an epoch second back into the store's own UTC text format. */
function epochToStoreTime(db: SpaceDb["db"], epoch: number): string {
  return db
    .prepare(`SELECT datetime(:e, 'unixepoch') t`)
    .get<{ t: string }>({ e: epoch })!.t;
}

/** Commits per minute for a bucket — the unit the incident record speaks in. */
export function commitsPerMinute(bucket: ChurnBucket, seconds: number): number {
  return (bucket.commits * 60) / seconds;
}
