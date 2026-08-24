/**
 * The survey-diff: one survey compared against the plan it was taken for, or
 * against an earlier survey. This is the verification every write stage uses
 * — an apply that exits zero is not a verdict, and the report of what a run
 * actually did is the before-survey held against the after-survey.
 *
 * Three verdicts matter for a row that carries an operation — a retarget or
 * a restore, both of which name the reference they produce: `landed` (on the
 * reference the op produces), `outstanding` (still on the recorded
 * reference), and `moved-elsewhere` (on neither — nothing in the plan
 * accounts for where it is, which is what a half-converged upgrade looks
 * like). Rows without an op are a pre-state record and diff to
 * `unchanged`/`changed`. Every comparison is on the full executable pointer,
 * `{identity, symbol}` — an identity alone conflates two patterns one module
 * exports.
 */

import type { PiecePlan } from "./bulk-plan.ts";

/** One half-qualified executable pointer a diff verdict was decided from. */
export interface PatternRef {
  patternIdentity: string;
  symbol: string;
}

/** Where one piece stands, measured against its plan row. */
export type PieceDiffStatus =
  | "landed"
  | "outstanding"
  | "moved-elsewhere"
  | "unchanged"
  | "changed"
  | "missing";

/** One piece's verdict, with the references behind it. */
export interface PieceDiffRow {
  piece: string;
  phase?: string;
  status: PieceDiffStatus;
  /** The reference the plan recorded. */
  before: PatternRef;
  /** The reference the after-survey read; absent when the piece is `missing`. */
  after?: PatternRef;
  /** The reference the row's operation produces, when the row carries one. */
  target?: PatternRef;
}

/** A diff over every plan row, plus what the after-survey saw beyond them. */
export interface PlanDiff {
  rows: readonly PieceDiffRow[];
  /** Pieces the after-survey holds that the plan does not. */
  unplanned: readonly string[];
  counts: Readonly<Record<PieceDiffStatus, number>>;
}

/**
 * Compare an after-survey against the plan it verifies. Every plan row gets
 * a verdict; pieces only the after-survey knows are listed as `unplanned`
 * rather than dropped, so a selection that grew mid-run stays visible.
 */
export function diffPlan(plan: PiecePlan, after: PiecePlan): PlanDiff {
  const afterById = new Map(after.rows.map((row) => [row.piece, row]));
  const counts: Record<PieceDiffStatus, number> = {
    landed: 0,
    outstanding: 0,
    "moved-elsewhere": 0,
    unchanged: 0,
    changed: 0,
    missing: 0,
  };
  const rows = plan.rows.map((row) => {
    const before: PatternRef = {
      patternIdentity: row.expect.patternIdentity,
      symbol: row.expect.symbol,
    };
    const target: PatternRef | undefined = row.op === undefined
      ? undefined
      : { patternIdentity: row.op.patternIdentity, symbol: row.op.symbol };
    const seen = afterById.get(row.piece);
    afterById.delete(row.piece);
    let status: PieceDiffStatus;
    let now: PatternRef | undefined;
    if (seen === undefined) status = "missing";
    else {
      now = {
        patternIdentity: seen.expect.patternIdentity,
        symbol: seen.expect.symbol,
      };
      if (target !== undefined) {
        status = sameRef(now, target)
          ? "landed"
          : sameRef(now, before)
          ? "outstanding"
          : "moved-elsewhere";
      } else status = sameRef(now, before) ? "unchanged" : "changed";
    }
    counts[status]++;
    return {
      piece: row.piece,
      ...(row.phase === undefined ? {} : { phase: row.phase }),
      status,
      before,
      ...(now === undefined ? {} : { after: now }),
      ...(target === undefined ? {} : { target }),
    };
  });
  return { rows, unplanned: [...afterById.keys()], counts };
}

function sameRef(left: PatternRef, right: PatternRef): boolean {
  return left.patternIdentity === right.patternIdentity &&
    left.symbol === right.symbol;
}
