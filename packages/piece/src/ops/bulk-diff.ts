/**
 * The survey-diff: one survey compared against the plan it was taken for, or
 * against an earlier survey. This is the verification every write stage uses
 * — an apply that exits zero is not a verdict, and the report of what a run
 * actually did is the before-survey held against the after-survey.
 *
 * Three verdicts matter for a row that carries a retarget: `landed` (on the
 * identity the op produces), `outstanding` (still on the recorded identity),
 * and `moved-elsewhere` (on neither — nothing in the plan accounts for where
 * it is, which is what a half-converged upgrade looks like). Rows without an
 * op are a pre-state record and diff to `unchanged`/`changed`.
 */

import type { PiecePlan } from "./bulk-plan.ts";

/** Where one piece stands, measured against its plan row. */
export type PieceDiffStatus =
  | "landed"
  | "outstanding"
  | "moved-elsewhere"
  | "unchanged"
  | "changed"
  | "missing";

/** One piece's verdict, with the identities behind it. */
export interface PieceDiffRow {
  piece: string;
  phase?: string;
  status: PieceDiffStatus;
  /** The identity the plan recorded. */
  before: string;
  /** The identity the after-survey read; absent when the piece is `missing`. */
  after?: string;
  /** The identity the row's retarget produces, when the row carries one. */
  target?: string;
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
    const before = row.expect.patternIdentity;
    const target = row.op?.kind === "retarget"
      ? row.op.patternIdentity
      : undefined;
    const seen = afterById.get(row.piece);
    afterById.delete(row.piece);
    let status: PieceDiffStatus;
    if (seen === undefined) status = "missing";
    else {
      const now = seen.expect.patternIdentity;
      if (target !== undefined) {
        status = now === target
          ? "landed"
          : now === before
          ? "outstanding"
          : "moved-elsewhere";
      } else status = now === before ? "unchanged" : "changed";
    }
    counts[status]++;
    return {
      piece: row.piece,
      ...(row.phase === undefined ? {} : { phase: row.phase }),
      status,
      before,
      ...(seen === undefined ? {} : { after: seen.expect.patternIdentity }),
      ...(target === undefined ? {} : { target }),
    };
  });
  return { rows, unplanned: [...afterById.keys()], counts };
}
