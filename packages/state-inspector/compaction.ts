// Verification of a compacted space store against the backup it was compacted
// from (docs/plans/compact-space.md, §3 "Verification, in order"). Read-only
// on both files, and deliberately a second implementation of what the run
// claims: the heads are compared as rows, the documents through this
// package's replay rather than the engine's, and the structural statements
// of I4 and I6 are checked against the store rather than against the run's
// own report, so that a run that misreported itself is caught by the
// store it left behind.

import { hashStringOf } from "@commonfabric/data-model";
import type { FabricValue } from "@commonfabric/api";
import { encodeMemoryBoundary } from "@commonfabric/memory/v2";
import {
  type CompactionMarker,
  type CompactionReport,
  decodeHollowedPayload,
  HOLLOWED_MARKER_PREFIX,
} from "@commonfabric/memory/v2/compact";
import { COMPACTION_SESSION_PREFIX } from "@commonfabric/memory/v2/engine";

import { openSpace, type SpaceDb } from "./db.ts";
import { decodeStored } from "./decode.ts";
import { contentFingerprint } from "./fingerprint.ts";
import { reconstructOutcome } from "./reconstruct.ts";

export type CompactionCheck = {
  name: string;
  passed: boolean;
  detail: string;
};

export type CompactionCommitRecord = {
  seq: number;
  sessionId: string;
  createdAt: string;
  /** The plan the run stored as its payload, when it decodes as one. */
  report?: CompactionReport;
};

export type CompactionVerification = {
  ok: boolean;
  result: string;
  against: string;
  compactionCommits: CompactionCommitRecord[];
  checks: CompactionCheck[];
  elapsedMs: number;
};

export type VerifyCompactionOptions = {
  /** The compacted store. */
  result: string;
  /** The store it was compacted from: the post-stop backup. */
  against: string;
  /** Check every n-th document only, and skip the fingerprint: a quick pass
   * during rehearsal. Absent, every head is reconstructed on both files. */
  sample?: number;
};

const ACL_ID_PATTERN = "of:did:%";
/** Hollowed payloads whose hash is checked against the backup when no
 * sample is asked for: enough to catch a marker written over the wrong
 * commit, bounded so the pass stays a hash per row rather than per byte of
 * the archive. */
const HOLLOWED_HASH_CHECKS = 1000;

const n = (value: number): string => value.toLocaleString("en-US");

const count = (space: SpaceDb, sql: string, ...params: (string | number)[]) =>
  space.get<{ n: number }>(sql, ...params)!.n;

/** Two decoded values compared by their canonical encoding: the one the
 * store writes, with members in key order. */
const sameValue = (left: unknown, right: unknown): boolean =>
  encodeMemoryBoundary(left as FabricValue) ===
    encodeMemoryBoundary(right as FabricValue);

/**
 * Verifies `result` against `against`: steps 1 to 6 of the plan's §3, each
 * a named check that passes or fails on its own, so a failing verification
 * says which property the result lost. Throws only when a file cannot be
 * opened; everything else is a check.
 */
export function verifyCompaction(
  options: VerifyCompactionOptions,
): CompactionVerification {
  const started = performance.now();
  const checks: CompactionCheck[] = [];
  let records: CompactionCommitRecord[] = [];
  const check = (name: string, passed: boolean, detail: string) => {
    checks.push({ name, passed, detail });
  };

  const main = openSpace(options.result);
  const backup = openSpace(options.against);
  try {
    // The backup is attached to the result's connection, so that every
    // row-level comparison is one SQL statement over both files. The
    // connection is read-only, and so is what it attaches.
    main.db.prepare(`ATTACH DATABASE ? AS against`).run(options.against);

    // 1. The file itself.
    const integrity = main.all<{ integrity_check: string }>(
      `PRAGMA integrity_check`,
    );
    check(
      "integrity_check",
      integrity.length === 1 && integrity[0].integrity_check === "ok",
      integrity.map((row) => row.integrity_check).join("; "),
    );
    const violations = main.all(`PRAGMA main.foreign_key_check`).length;
    check(
      "foreign_key_check",
      violations === 0,
      violations === 0 ? "no violations" : `${n(violations)} violation(s)`,
    );

    // The compaction commits: what the run inserted, and what it planned.
    const commits = main.all<{
      seq: number;
      session_id: string;
      created_at: string;
      original: string;
      class: string;
    }>(
      `SELECT seq, session_id, created_at, original, class FROM main."commit"
       WHERE session_id LIKE ? ORDER BY seq`,
      `${COMPACTION_SESSION_PREFIX}%`,
    );
    records = commits.map((row) => {
      let report: CompactionReport | undefined;
      try {
        const payload = decodeStored(row.original) as {
          compaction?: { report?: CompactionReport };
        };
        report = payload.compaction?.report;
      } catch {
        // A payload that is not the run's record is reported below.
      }
      return {
        seq: row.seq,
        sessionId: row.session_id,
        createdAt: row.created_at,
        ...(report === undefined ? {} : { report }),
      };
    });
    check(
      "compaction commit recorded",
      commits.length > 0 && commits.every((row) => row.class === "system") &&
        records.every((record) => record.report !== undefined),
      commits.length === 0
        ? "no compaction commit in the result"
        : `${commits.length} run(s): ${
          commits.map((row) => `seq ${row.seq} (${row.session_id})`).join(", ")
        }${
          commits.every((row) => row.class === "system")
            ? ""
            : "; a run's commit is not system-class"
        }${
          records.every((record) => record.report !== undefined)
            ? ""
            : "; a run's payload is not its plan"
        }`,
    );
    if (commits.length === 0) {
      return finish(false);
    }
    const seqs = commits.map((row) => row.seq);
    const inCompaction = `IN (${seqs.join(", ")})`;
    const last = seqs[seqs.length - 1];
    const headSeq = main.get<{ head_seq: number }>(
      `SELECT head_seq FROM main.branch WHERE name = ''`,
    )?.head_seq;
    check(
      "branch head at the compaction commit",
      headSeq === last,
      `branch.head_seq ${headSeq}, compaction commit ${last}`,
    );
    const newer = count(
      main,
      `SELECT count(*) AS n FROM main."commit" WHERE seq > ?`,
      last,
    );
    check(
      "no commit after the compaction commit",
      newer === 0,
      newer === 0
        ? "the compaction commit is the newest"
        : `${n(newer)} commit(s) after it: the result was written to`,
    );

    // 2. Heads unchanged, one excepted.
    const headColumns = "branch, id, scope_key, seq, op_index";
    const missingHeads = count(
      main,
      `SELECT count(*) AS n FROM (
         SELECT ${headColumns} FROM against.head WHERE id NOT LIKE ?
         EXCEPT SELECT ${headColumns} FROM main.head WHERE id NOT LIKE ?)`,
      ACL_ID_PATTERN,
      ACL_ID_PATTERN,
    );
    const extraHeads = count(
      main,
      `SELECT count(*) AS n FROM (
         SELECT ${headColumns} FROM main.head WHERE id NOT LIKE ?
         EXCEPT SELECT ${headColumns} FROM against.head WHERE id NOT LIKE ?)`,
      ACL_ID_PATTERN,
      ACL_ID_PATTERN,
    );
    const heads = count(
      main,
      `SELECT count(*) AS n FROM main.head WHERE id NOT LIKE ?`,
      ACL_ID_PATTERN,
    );
    check(
      "heads keep their addresses",
      missingHeads === 0 && extraHeads === 0,
      `${n(heads)} heads; ${n(missingHeads)} moved or lost, ${
        n(extraHeads)
      } unexpected`,
    );
    const unjoined = count(
      main,
      `SELECT count(*) AS n FROM main.head h
       LEFT JOIN main.revision r ON r.branch = h.branch AND r.id = h.id
         AND r.scope_key = h.scope_key AND r.seq = h.seq AND r.op_index = h.op_index
       WHERE r.seq IS NULL`,
    );
    check(
      "every head has its revision row",
      unjoined === 0,
      unjoined === 0 ? "all join" : `${n(unjoined)} head(s) join to no row`,
    );
    const opChanges = main.all<{ before: string; after: string; n: number }>(
      `SELECT a.op AS before, m.op AS after, count(*) AS n
       FROM main.head m JOIN against.head a
         ON a.branch = m.branch AND a.id = m.id AND a.scope_key = m.scope_key
       WHERE m.op <> a.op AND m.id NOT LIKE ?
       GROUP BY a.op, m.op`,
      ACL_ID_PATTERN,
    );
    const materializedHeads = opChanges.find((row) =>
      row.before === "patch" && row.after === "set"
    )?.n ?? 0;
    const otherOpChanges = opChanges.filter((row) =>
      !(row.before === "patch" && row.after === "set")
    );
    check(
      "head ops change only from patch to set",
      otherOpChanges.length === 0,
      `${n(materializedHeads)} head(s) materialized` +
        (otherOpChanges.length === 0
          ? ""
          : `; ${
            otherOpChanges.map((row) =>
              `${n(row.n)} ${row.before}→${row.after}`
            )
              .join(", ")
          }`),
    );

    // The rows pointing at a compaction commit, and what they may be: an
    // instance's oldest row (its boundary), or an ACL audit revision at the
    // commit's own seq.
    const boundaries = count(
      main,
      `SELECT count(*) AS n FROM main.revision r
       WHERE r.commit_seq ${inCompaction} AND NOT (r.id LIKE ? AND r.seq = r.commit_seq AND r.op_index = 0)`,
      ACL_ID_PATTERN,
    );
    const aclRevisions = count(
      main,
      `SELECT count(*) AS n FROM main.revision r
       WHERE r.commit_seq ${inCompaction} AND r.id LIKE ? AND r.seq = r.commit_seq AND r.op_index = 0 AND r.op = 'set'`,
      ACL_ID_PATTERN,
    );
    const boundariesWithRowsBelow = count(
      main,
      `SELECT count(*) AS n FROM main.revision r
       WHERE r.commit_seq ${inCompaction} AND NOT (r.id LIKE ? AND r.seq = r.commit_seq)
         AND EXISTS (SELECT 1 FROM main.revision b
           WHERE b.branch = r.branch AND b.id = r.id AND b.scope_key = r.scope_key
             AND (b.seq < r.seq OR (b.seq = r.seq AND b.op_index < r.op_index)))`,
      ACL_ID_PATTERN,
    );
    const boundariesNotBases = count(
      main,
      `SELECT count(*) AS n FROM main.revision r
       WHERE r.commit_seq ${inCompaction} AND r.op NOT IN ('set', 'delete')`,
    );
    check(
      "rows attributed to a compaction commit are boundaries",
      boundariesWithRowsBelow === 0 && boundariesNotBases === 0,
      `${n(boundaries)} boundary row(s), ${n(aclRevisions)} ACL revision(s)` +
        (boundariesWithRowsBelow === 0
          ? ""
          : `; ${n(boundariesWithRowsBelow)} with rows still below them`) +
        (boundariesNotBases === 0
          ? ""
          : `; ${n(boundariesNotBases)} that are not a set or delete`),
    );

    // Every row not attributed to a compaction commit is the backup's, byte
    // for byte, attribution included; every boundary row sits where a backup
    // row sat; every backup row the result lacks is below a surviving row of
    // its instance and above none.
    const rowColumns =
      "branch, id, scope_key, seq, op_index, op, data, commit_seq";
    const changedRows = count(
      main,
      `SELECT count(*) AS n FROM (
         SELECT ${rowColumns} FROM main.revision WHERE commit_seq NOT ${inCompaction}
         EXCEPT SELECT ${rowColumns} FROM against.revision)`,
    );
    check(
      "rows above the boundaries are byte-identical",
      changedRows === 0,
      changedRows === 0
        ? "every untouched row matches the backup"
        : `${n(changedRows)} row(s) differ from the backup or were added`,
    );
    const boundaryColumns = "branch, id, scope_key, seq, op_index";
    const boundariesMoved = count(
      main,
      `SELECT count(*) AS n FROM (
         SELECT ${boundaryColumns} FROM main.revision r
         WHERE r.commit_seq ${inCompaction} AND NOT (r.id LIKE ? AND r.seq = r.commit_seq)
         EXCEPT SELECT ${boundaryColumns} FROM against.revision)`,
      ACL_ID_PATTERN,
    );
    const boundariesRewrittenWrong = count(
      main,
      `SELECT count(*) AS n FROM main.revision r JOIN against.revision a
         ON a.branch = r.branch AND a.id = r.id AND a.scope_key = r.scope_key
         AND a.seq = r.seq AND a.op_index = r.op_index
       WHERE r.commit_seq ${inCompaction} AND NOT (r.id LIKE ? AND r.seq = r.commit_seq)
         AND NOT ((a.op = 'patch' AND r.op = 'set')
               OR (a.op = r.op AND a.data IS r.data))`,
      ACL_ID_PATTERN,
    );
    check(
      "boundaries keep their addresses and change only as the plan states",
      boundariesMoved === 0 && boundariesRewrittenWrong === 0,
      (boundariesMoved === 0
        ? "every boundary sits where a backup row sat"
        : `${
          n(boundariesMoved)
        } boundary row(s) at addresses the backup lacks`) +
        (boundariesRewrittenWrong === 0
          ? ""
          : `; ${
            n(boundariesRewrittenWrong)
          } boundary row(s) whose op or data changed other than patch to set`),
    );
    const deletedRows = count(
      main,
      `SELECT count(*) AS n FROM against.revision a
       WHERE NOT EXISTS (SELECT 1 FROM main.revision m
         WHERE m.branch = a.branch AND m.id = a.id AND m.scope_key = a.scope_key
           AND m.seq = a.seq AND m.op_index = a.op_index)`,
    );
    const holes = count(
      main,
      `SELECT count(*) AS n FROM against.revision a
       WHERE NOT EXISTS (SELECT 1 FROM main.revision m
         WHERE m.branch = a.branch AND m.id = a.id AND m.scope_key = a.scope_key
           AND m.seq = a.seq AND m.op_index = a.op_index)
         AND (
           EXISTS (SELECT 1 FROM main.revision b
             WHERE b.branch = a.branch AND b.id = a.id AND b.scope_key = a.scope_key
               AND (b.seq < a.seq OR (b.seq = a.seq AND b.op_index < a.op_index)))
           OR NOT EXISTS (SELECT 1 FROM main.revision u
             WHERE u.branch = a.branch AND u.id = a.id AND u.scope_key = a.scope_key
               AND (u.seq > a.seq OR (u.seq = a.seq AND u.op_index > a.op_index))
               AND u.commit_seq ${inCompaction}))`,
    );
    check(
      "deleted rows lie below a boundary and above no surviving row",
      holes === 0,
      `${n(deletedRows)} row(s) deleted` +
        (holes === 0 ? "" : `; ${n(holes)} left a hole or lost an instance`),
    );
    const snapshotsChanged = count(
      main,
      `SELECT count(*) AS n FROM (
         SELECT branch, id, scope_key, seq, value FROM main.snapshot
         EXCEPT SELECT branch, id, scope_key, seq, value FROM against.snapshot)`,
    );
    const snapshotsBelowBoundary = count(
      main,
      `SELECT count(*) AS n FROM main.snapshot s
       WHERE EXISTS (SELECT 1 FROM main.revision r
         WHERE r.branch = s.branch AND r.id = s.id AND r.scope_key = s.scope_key
           AND r.commit_seq ${inCompaction} AND NOT (r.id LIKE ? AND r.seq = r.commit_seq)
           AND s.seq <= r.seq)`,
      ACL_ID_PATTERN,
    );
    check(
      "snapshots are the backup's, none at or below a boundary",
      snapshotsChanged === 0 && snapshotsBelowBoundary === 0,
      (snapshotsChanged === 0
        ? "no snapshot differs"
        : `${n(snapshotsChanged)} differ`) +
        (snapshotsBelowBoundary === 0
          ? ""
          : `; ${n(snapshotsBelowBoundary)} at or below a boundary`),
    );

    // 3. Every document reads back identical, one excepted.
    const instances = main.all<{ id: string; scope_key: string }>(
      `SELECT id, scope_key FROM main.head WHERE branch = '' AND id NOT LIKE ?
       ORDER BY id, scope_key`,
      ACL_ID_PATTERN,
    );
    const stride = options.sample === undefined || options.sample <= 0
      ? 1
      : Math.max(1, Math.ceil(instances.length / options.sample));
    let compared = 0;
    const mismatches: string[] = [];
    for (let index = 0; index < instances.length; index += stride) {
      const { id, scope_key } = instances[index];
      compared++;
      const left = reconstructOutcome(main, { id, scope: scope_key });
      const right = reconstructOutcome(backup, { id, scope: scope_key });
      const same = left.status === right.status &&
        (left.status !== "present" || right.status !== "present" ||
          sameValue(left.document, right.document));
      if (!same && mismatches.length < 5) {
        mismatches.push(`${id} (${scope_key})`);
      }
      if (!same && mismatches.length >= 5) break;
    }
    check(
      "every document reads back identical",
      mismatches.length === 0,
      `${n(compared)} of ${n(instances.length)} instance(s) compared` +
        (stride > 1 ? ` (every ${stride}th)` : "") +
        (mismatches.length === 0 ? "" : `; differ: ${mismatches.join(", ")}`),
    );

    // The ACL document: `value` unchanged, `compaction` the only member that
    // differs, naming the newest compaction commit; its head at that commit.
    const aclHeads = main.all<
      { id: string; seq: number; op_index: number; op: string }
    >(
      `SELECT id, seq, op_index, op FROM main.head WHERE branch = '' AND scope_key = 'space' AND id LIKE ?`,
      ACL_ID_PATTERN,
    );
    const aclHeadsBefore = main.all<{ id: string }>(
      `SELECT id FROM against.head WHERE branch = '' AND scope_key = 'space' AND id LIKE ?`,
      ACL_ID_PATTERN,
    );
    if (aclHeadsBefore.length === 0) {
      check(
        "ACL document",
        aclHeads.length === 0 && aclRevisions === 0,
        aclHeads.length === 0
          ? "the space has no ACL document; none was written"
          : "the backup has no ACL document but the result does",
      );
    } else {
      const id = aclHeadsBefore[0].id;
      const head = aclHeads.find((row) => row.id === id);
      const left = reconstructOutcome(main, { id, scope: "space" });
      const right = reconstructOutcome(backup, { id, scope: "space" });
      let detail: string;
      let passed = false;
      if (left.status !== "present" || right.status !== "present") {
        passed = left.status === right.status && aclRevisions === 0;
        detail =
          `the ACL document is ${left.status} in the result and ${right.status} in the backup`;
      } else {
        const after = left.document as Record<string, FabricValue>;
        const before = right.document as Record<string, FabricValue>;
        const keys = new Set([...Object.keys(after), ...Object.keys(before)]);
        const differing = [...keys].filter((key) =>
          !sameValue(after[key] ?? null, before[key] ?? null)
        );
        const marker = after.compaction as CompactionMarker | undefined;
        const namesLast = marker !== undefined && Array.isArray(marker.runs) &&
          marker.runs.length > 0 &&
          marker.runs[marker.runs.length - 1].commitSeq === last;
        const headAtCommit = head !== undefined && head.seq === last &&
          head.op_index === 0 && head.op === "set";
        passed = differing.every((key) => key === "compaction") && namesLast &&
          headAtCommit;
        detail = `value ${
          differing.includes("value") ? "CHANGED" : "unchanged"
        }; differing members: ${differing.join(", ") || "none"}; marker ${
          namesLast ? `names seq ${last}` : "missing or stale"
        }; head ${
          head === undefined
            ? "missing"
            : `${head.seq}/${head.op_index} ${head.op}`
        }`;
      }
      check("ACL document", passed, detail);
    }

    // 4. The fingerprint, which excludes generated cells: necessary, cheap
    //    relative to the replay above, skipped on a sampled pass.
    if (stride === 1) {
      try {
        const leftPrint = contentFingerprint(main);
        const rightPrint = contentFingerprint(backup);
        check(
          "fingerprint",
          leftPrint.hash === rightPrint.hash,
          leftPrint.hash === rightPrint.hash
            ? `${leftPrint.hash} on both`
            : `${leftPrint.hash} ≠ ${rightPrint.hash}`,
        );
      } catch (error) {
        // A store whose rows no longer replay is a failed check, not a
        // crashed verification.
        check(
          "fingerprint",
          false,
          `could not be computed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    // 5. Hollowed payloads: markers only where the rules allow, hashes that
    //    match the backup's bytes.
    const hollowedRows = main.all<{ seq: number; original: string }>(
      `SELECT seq, original FROM main."commit" WHERE substr(original, 1, ?) = ? ORDER BY seq`,
      HOLLOWED_MARKER_PREFIX.length,
      HOLLOWED_MARKER_PREFIX,
    );
    const hollowedGenesis = hollowedRows.some((row) => row.seq === 1);
    const hollowedCompaction = hollowedRows.filter((row) =>
      seqs.includes(row.seq)
    ).length;
    const opTables = [
      "op_field_epoch",
      "op_submission",
      "op_integrated",
      "op_checkpoint",
    ]
      .filter((table) =>
        main.get(
          `SELECT 1 FROM main.sqlite_master WHERE type = 'table' AND name = ?`,
          table,
        ) !==
          undefined
      );
    const hollowedOpReferenced = opTables.length === 0 ? 0 : count(
      main,
      `SELECT count(*) AS n FROM main."commit" c
       WHERE substr(c.original, 1, ?) = ? AND c.seq IN (${
        opTables.map((table) => `SELECT commit_seq FROM main."${table}"`).join(
          " UNION ",
        )
      })`,
      HOLLOWED_MARKER_PREFIX.length,
      HOLLOWED_MARKER_PREFIX,
    );
    const hashStride = options.sample === undefined
      ? Math.max(1, Math.ceil(hollowedRows.length / HOLLOWED_HASH_CHECKS))
      : Math.max(1, Math.ceil(hollowedRows.length / options.sample));
    let hashed = 0;
    let hashMismatches = 0;
    for (let index = 0; index < hollowedRows.length; index += hashStride) {
      const row = hollowedRows[index];
      const marker = decodeHollowedPayload(row.original);
      const before = backup.get<{ original: string }>(
        `SELECT original FROM "commit" WHERE seq = ?`,
        row.seq,
      );
      hashed++;
      if (
        marker === undefined || before === undefined ||
        marker.hash !== hashStringOf(before.original)
      ) hashMismatches++;
    }
    check(
      "hollowed payloads",
      !hollowedGenesis && hollowedCompaction === 0 &&
        hollowedOpReferenced === 0 &&
        hashMismatches === 0,
      `${n(hollowedRows.length)} hollowed; ${
        n(hashed)
      } hash(es) checked against the backup` +
        (hashMismatches === 0 ? "" : `, ${n(hashMismatches)} mismatch`) +
        (hollowedGenesis ? "; commit 1 hollowed" : "") +
        (hollowedCompaction === 0
          ? ""
          : `; ${n(hollowedCompaction)} compaction commit(s) hollowed`) +
        (hollowedOpReferenced === 0
          ? ""
          : `; ${n(hollowedOpReferenced)} op_*-referenced commit(s) hollowed`),
    );
    const commitsChanged = count(
      main,
      `SELECT count(*) AS n FROM (
         SELECT seq, branch, session_id, local_seq, resolution, class FROM main."commit"
         WHERE seq NOT ${inCompaction}
         EXCEPT SELECT seq, branch, session_id, local_seq, resolution, class FROM against."commit")`,
    );
    const commitsLost = count(
      main,
      `SELECT count(*) AS n FROM against."commit" a
       WHERE NOT EXISTS (SELECT 1 FROM main."commit" m WHERE m.seq = a.seq)`,
    );
    const payloadsChanged = count(
      main,
      `SELECT count(*) AS n FROM main."commit" m JOIN against."commit" a ON a.seq = m.seq
       WHERE m.original <> a.original AND substr(m.original, 1, ?) <> ?`,
      HOLLOWED_MARKER_PREFIX.length,
      HOLLOWED_MARKER_PREFIX,
    );
    check(
      "every commit row survives; only payloads go",
      commitsChanged === 0 && commitsLost === 0 && payloadsChanged === 0,
      (commitsLost === 0
        ? "no commit row lost"
        : `${n(commitsLost)} commit row(s) lost`) +
        (commitsChanged === 0
          ? ""
          : `; ${n(commitsChanged)} commit row(s) changed`) +
        (payloadsChanged === 0
          ? ""
          : `; ${n(payloadsChanged)} payload(s) changed without a marker`),
    );

    // The single-run cross-check against the plan the run stored.
    if (records.length === 1 && records[0].report !== undefined) {
      const plan = records[0].report;
      const plannedHollowed = plan.payloads.hollowed.owningHead.commits +
        plan.payloads.hollowed.headless.commits;
      const agrees = plan.instances.truncated === boundaries &&
        plan.instances.headOpChanges === materializedHeads &&
        plannedHollowed === hollowedRows.length;
      check(
        "the run did what it planned",
        agrees,
        `planned ${n(plan.instances.truncated)} truncated / ${
          n(plan.instances.headOpChanges)
        } head ops / ${n(plannedHollowed)} hollowed; found ${n(boundaries)} / ${
          n(materializedHeads)
        } / ${n(hollowedRows.length)}`,
      );
    }

    // 6. Live metadata: the genesis receipt is byte-identical.
    const genesisSame = main.get<{ same: number }>(
      `SELECT (SELECT original FROM main."commit" WHERE seq = 1) =
              (SELECT original FROM against."commit" WHERE seq = 1) AS same`,
    )?.same === 1;
    check(
      "genesis receipt byte-identical",
      genesisSame,
      genesisSame ? "commit 1's payload matches" : "commit 1's payload differs",
    );

    return finish(checks.every((c) => c.passed));
  } finally {
    backup.close();
    main.close();
  }

  function finish(ok: boolean): CompactionVerification {
    return {
      ok,
      result: options.result,
      against: options.against,
      compactionCommits: records,
      checks,
      elapsedMs: performance.now() - started,
    };
  }
}

/** The verification as an operator reads it. */
export function formatCompactionVerification(
  verification: CompactionVerification,
): string {
  const lines = verification.checks.map((check) =>
    `${check.passed ? "ok  " : "FAIL"} ${check.name.padEnd(56)} ${check.detail}`
  );
  lines.push(
    verification.ok
      ? `OK — ${verification.checks.length} checks passed in ${
        (verification.elapsedMs / 1000).toFixed(1)
      } s`
      : `FAILED — ${
        verification.checks.filter((c) => !c.passed).length
      } of ${verification.checks.length} checks failed`,
  );
  return lines.join("\n");
}
