/**
 * Bulk retarget: the upgrade apply. One source package moves across the
 * pieces a plan names — serial, in plan order, each row's precondition
 * proved before its write, stopping at the first failure with the remainder
 * named, and recomputing what is outstanding on every invocation
 * (docs/plans/piece-bulk-operations.md, stage 3).
 *
 * The plan is the whole input: each retarget row carries the reference pair
 * the piece must still be on (`expect`) and the pair its resolved source
 * produces (`op`), and classification compares both halves of a pair, never
 * an identity alone. A piece on its row's `expect` pair is outstanding; on
 * the `op` pair it landed and is not rewritten, which is what makes a
 * re-invocation a resume; on neither, something this plan does not account
 * for moved it, and the run stops — or never starts, when preflight finds
 * it first.
 *
 * Sessions are grouped: a fresh session serves a bounded number of pieces
 * and is then released, so the expensive warm-up is paid once per group
 * while the pieces live at once stay bounded by the group size — a knob,
 * not a constant. A group boundary is thereby a resume point: a run that
 * dies inside a group loses at most that group's warm-up, because every
 * landed row reads as landed on the next invocation.
 *
 * Applying implies no verdict. The verification is the survey-diff — a
 * survey taken afterwards, compared against this plan — and it stays a
 * separate invocation by design; this module only applies and reports.
 *
 * Deno-only, like the local resolution it builds on: each row's source is
 * resolved from disk and its identity recomputed — without compiling —
 * immediately before the write, and a source that no longer produces the
 * reference its row recorded is refused rather than applied.
 */

import type { RuntimeProgram } from "@commonfabric/runner";

import {
  programEntryIdentity,
  resolveLocalSourceProgram,
} from "./bulk-local.deno.ts";
import { normalizePlan, type PiecePlan, type RetargetOp } from "./bulk-plan.ts";
import { readPiecePin } from "./bulk-survey.ts";
import type { PiecesController } from "./pieces-controller.ts";

/**
 * The session supply a run draws on. `open` yields a fresh session over the
 * target space; `close` releases one, ending the group whose pieces it kept
 * live. Production closes by disposing the session's runtime; a test
 * harness may defer disposal while still observing every boundary.
 */
export interface RetargetSessions {
  open(): Promise<PiecesController>;
  close(pieces: PiecesController): Promise<void>;
}

/**
 * One piece's outcome. `landed` and `outstanding` are the preflight's
 * verdicts — already on the op's pair, or still on the expected one — and
 * an apply turns `outstanding` into `applied`. `moved-elsewhere` is a piece
 * on neither of its row's pairs: nothing in the plan accounts for where it
 * is, so the run stops (or never starts). `refused` is a row this run must
 * not apply — a source resolving to a different reference than the row
 * recorded. `failed` is an operational failure, state-checked; and
 * `unattempted` names the rows after a stop.
 */
export type RetargetVerdict =
  | "landed"
  | "outstanding"
  | "applied"
  | "moved-elsewhere"
  | "refused"
  | "failed"
  | "unattempted";

/** One piece's row in a retarget report. */
export interface RetargetRow {
  piece: string;
  /** The plan row's phase label, carried as the plan stamped it. */
  phase?: string;
  verdict: RetargetVerdict;
  /** What a moved, refused, or failed row broke; absent otherwise. */
  problem?: string;
  /**
   * The row's wall-clock cost in milliseconds, present on attempted apply
   * rows. The number the plan wants reported as the run proceeds: a run
   * whose cost per piece is unknown cannot be improved.
   */
  elapsedMs?: number;
}

/** What one retarget run found, and — under `apply` — did. */
export interface RetargetReport {
  rows: readonly RetargetRow[];
  /** Sources applied. Zero on a dry run and on a fully landed re-run. */
  applied: number;
  /**
   * True when every row is `landed` (or, on a dry run, `outstanding` —
   * that is the dry run's answer, not a defect): nothing moved, nothing
   * refused, nothing failed, nothing unattempted.
   */
  complete: boolean;
}

export interface RetargetOptions {
  plan: PiecePlan;
  /**
   * Write the sources the rows resolve. Absent, the run is the preflight
   * classification alone — where every piece stands, and no write at all.
   */
  apply?: boolean;
  /**
   * Pieces served by one session before it is replaced. The knob the
   * design requires: warm-up amortizes across a group while the pieces
   * live at once stay bounded by it.
   */
  groupSize?: number;
  /** Called as each row settles, for reporting as the run proceeds. */
  onRow?: (row: RetargetRow) => void;
  /** The clock behind `elapsedMs`, injectable for deterministic tests. */
  now?: () => number;
}

/** A plan row narrowed to the retarget work this run performs. */
interface WorkRow {
  piece: string;
  phase?: string;
  expect: { patternIdentity: string; symbol: string };
  op: RetargetOp;
}

const DEFAULT_GROUP_SIZE = 25;

/**
 * Classify one pin against its row: both halves of a pair, never the
 * identity alone — two patterns one module exports share an identity and
 * differ only in symbol.
 */
function classify(
  pin: { patternIdentity: string; symbol: string } | undefined,
  row: WorkRow,
): "landed" | "outstanding" | "moved-elsewhere" {
  if (
    pin !== undefined && pin.patternIdentity === row.op.patternIdentity &&
    pin.symbol === row.op.symbol
  ) return "landed";
  if (
    pin !== undefined && pin.patternIdentity === row.expect.patternIdentity &&
    pin.symbol === row.expect.symbol
  ) return "outstanding";
  return "moved-elsewhere";
}

/**
 * Apply a retarget plan, or — without `apply` — report where every piece
 * stands. Serial in plan order; preflight proves every row's precondition
 * before the first write; grouped sessions bound what stays live; a stop
 * names every unattempted piece. Op-less rows — the pre-state record, a
 * collection's holder among them — carry no work and are left out of the
 * report; a restore or repair row is refused outright, this run applying
 * retargets alone.
 */
export async function retargetPieces(
  sessions: RetargetSessions,
  options: RetargetOptions,
): Promise<RetargetReport> {
  const plan = normalizePlan(options.plan);
  if (
    (plan.header.problems?.length ?? 0) > 0 ||
    (plan.header.outside?.length ?? 0) > 0
  ) {
    throw new Error(
      "No retarget can run from an incomplete plan: its header names " +
        "pieces the survey did not account for.",
    );
  }
  const foreign = plan.rows.filter((row) =>
    row.op !== undefined && row.op.kind !== "retarget"
  );
  if (foreign.length > 0) {
    throw new Error(
      "This run applies retargets alone; the plan carries other " +
        "operations on: " + foreign.map((row) => row.piece).join(", ") + ".",
    );
  }
  const work: WorkRow[] = plan.rows.flatMap((row) =>
    row.op?.kind === "retarget"
      ? [{
        piece: row.piece,
        ...(row.phase === undefined ? {} : { phase: row.phase }),
        expect: {
          patternIdentity: row.expect.patternIdentity,
          symbol: row.expect.symbol,
        },
        op: row.op,
      }]
      : []
  );
  if (work.length === 0) {
    throw new Error(
      "The plan has no retarget rows, so there is nothing to apply.",
    );
  }
  const now = options.now ?? Date.now;
  const groupSize = options.groupSize ?? DEFAULT_GROUP_SIZE;
  if (!Number.isSafeInteger(groupSize) || groupSize < 1) {
    throw new Error("groupSize must be a positive integer.");
  }
  const rows: RetargetRow[] = [];
  const report = (row: RetargetRow) => {
    rows.push(row);
    options.onRow?.(row);
  };

  // Preflight: every row classified from one read, before the first write.
  // A piece on neither of its row's references — or one that cannot be
  // read — keeps the run from starting at all, with every row reporting
  // where it stands and nothing applied.
  const preflight = new Map<
    string,
    "landed" | "outstanding" | { blocked: RetargetRow }
  >();
  let startBlocked = false;
  {
    const pieces = await sessions.open();
    try {
      for (const row of work) {
        const phase = row.phase === undefined ? {} : { phase: row.phase };
        try {
          const pin = await readPiecePin(pieces, row.piece);
          const standing = classify(pin, row);
          if (standing === "moved-elsewhere") {
            preflight.set(row.piece, {
              blocked: {
                piece: row.piece,
                ...phase,
                verdict: "moved-elsewhere",
                problem: pin === undefined
                  ? "The piece carries no pattern identity to compare."
                  : `The piece is on ${pin.patternIdentity}#${pin.symbol}, ` +
                    `which is neither the reference this row recorded nor ` +
                    `the one it produces.`,
              },
            });
            startBlocked = true;
            continue;
          }
          preflight.set(row.piece, standing);
        } catch (error) {
          preflight.set(row.piece, {
            blocked: {
              piece: row.piece,
              ...phase,
              verdict: "failed",
              problem:
                (error instanceof Error ? error.message : String(error)) +
                "; the run did not start, so nothing was written.",
            },
          });
          startBlocked = true;
        }
      }
    } finally {
      await sessions.close(pieces);
    }
  }
  if (startBlocked || options.apply !== true) {
    for (const row of work) {
      const phase = row.phase === undefined ? {} : { phase: row.phase };
      // Every work row was classified above — the loop writes one of the
      // three outcomes for each, and duplicates cannot collapse two rows
      // onto one key, the codec having refused them.
      const standing = preflight.get(row.piece)!;
      if (standing === "landed" || standing === "outstanding") {
        report({ piece: row.piece, ...phase, verdict: standing });
      } else {
        report(standing.blocked);
      }
    }
    const complete = rows.every((row) =>
      row.verdict === "landed" ||
      (options.apply !== true && row.verdict === "outstanding")
    );
    return { rows, applied: 0, complete };
  }

  // The serial apply, in plan order, over bounded session groups. Rows the
  // preflight saw landed are reported without a write — a resume must not
  // rewrite them — and each remaining row's precondition is re-proved in
  // the group's own session immediately before its write.
  let applied = 0;
  let stopped = false;
  for (let start = 0; start < work.length; start += groupSize) {
    const group = work.slice(start, start + groupSize);
    if (stopped) {
      for (const row of group) {
        const phase = row.phase === undefined ? {} : { phase: row.phase };
        report({ piece: row.piece, ...phase, verdict: "unattempted" });
      }
      continue;
    }
    const pieces = await sessions.open();
    try {
      for (const row of group) {
        const phase = row.phase === undefined ? {} : { phase: row.phase };
        if (stopped) {
          report({ piece: row.piece, ...phase, verdict: "unattempted" });
          continue;
        }
        if (preflight.get(row.piece) === "landed") {
          report({ piece: row.piece, ...phase, verdict: "landed" });
          continue;
        }
        const startedAt = now();
        try {
          // The precondition again, in this session, immediately before
          // the write: preflight's read has aged by up to a group's worth
          // of work.
          const pin = await readPiecePin(pieces, row.piece);
          const standing = classify(pin, row);
          if (standing === "landed") {
            report({ piece: row.piece, ...phase, verdict: "landed" });
            continue;
          }
          if (standing === "moved-elsewhere") {
            report({
              piece: row.piece,
              ...phase,
              verdict: "moved-elsewhere",
              problem: "The piece left its recorded reference after " +
                "preflight; something other than this plan moved it.",
            });
            stopped = true;
            continue;
          }
          const program: RuntimeProgram = await resolveLocalSourceProgram(
            pieces.runtime,
            row.op.source,
          );
          // The identity the source produces NOW, not the one it produced
          // at plan time: a source edited since no longer lands the row's
          // recorded reference, and applying it would land something the
          // plan's reviewer never saw.
          const identity = await programEntryIdentity(program);
          if (identity !== row.op.patternIdentity) {
            report({
              piece: row.piece,
              ...phase,
              verdict: "refused",
              problem: `The source resolves to ${identity}, not the ` +
                `${row.op.patternIdentity} this row recorded.`,
            });
            stopped = true;
            continue;
          }
          // No separate export check: the codec refuses a row whose symbol
          // disagrees with its source's requested export, and the resolver
          // echoes that request — so a decoded row's `op.symbol` is the
          // export this program runs, by construction. A source that lost
          // the export outright fails resolution above, named.
          const controller = await pieces.get(row.piece, false);
          // The override comes from the row and nowhere else, so the plan
          // shows exactly which rows ran with the gate open.
          await controller.setPattern(program, {
            ...(row.op.allowIncompatible === true
              ? { dangerouslyAllowIncompatibleSchema: true }
              : {}),
          });
          applied += 1;
          report({
            piece: row.piece,
            ...phase,
            verdict: "applied",
            elapsedMs: now() - startedAt,
          });
        } catch (error) {
          // The failure is classified by a state check made after it, the
          // way the design requires — never a probe before.
          const problem = error instanceof Error
            ? error.message
            : String(error);
          let state =
            "; the piece could not be re-read, so its state is unknown";
          try {
            const pin = await readPiecePin(pieces, row.piece);
            const standing = classify(pin, row);
            state = standing === "landed"
              ? "; the piece is on the row's target reference, so the " +
                "write landed"
              : standing === "outstanding"
              ? "; the piece is still on its recorded reference"
              : "; the piece is on neither of the row's references";
          } catch {
            // The re-read failing changes nothing: `state` already says so.
          }
          report({
            piece: row.piece,
            ...phase,
            verdict: "failed",
            problem: problem + state,
            elapsedMs: now() - startedAt,
          });
          stopped = true;
        }
      }
    } finally {
      await sessions.close(pieces);
    }
  }
  const complete = rows.every((row) =>
    row.verdict === "landed" || row.verdict === "applied"
  );
  return { rows, applied, complete };
}
