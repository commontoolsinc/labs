/**
 * Bulk repair: a caller-supplied fixer — a pure transform from a piece's
 * stored input document to the document it should hold — iterated over a
 * selection by the same spine the survey walks. The tooling owns selection,
 * ordering, the write, the stop, and resume; the fixer owns only what the
 * change is (docs/plans/piece-bulk-operations.md, stage 2).
 *
 * The fixer is its own predicate. A piece the fixer would not change needs
 * nothing, so selection ("keep what it would change"), resume ("already
 * repaired reads as unchanged"), and verification ("re-running over the
 * stored result is a no-op") are one mechanism, and none of them can drift
 * from what the fixer does because they are what the fixer does. That is
 * why a fixer must be a pure function of the document, and why this module
 * probes the purity it cannot prove: every evaluation runs the fixer twice
 * and refuses an answer that differs.
 *
 * The write is the wide one — the whole input document replaced — made safe
 * by refusals rather than by narrowing: a document that lost a field the
 * fixer never mentioned is a defect, not an intent, and a reference
 * rewritten as a value or dropped is corruption either way. Raw documents
 * carry references as sigil links, which are plain data on this side of the
 * runtime, so a fixer that round-trips them untouched preserves them through
 * the write — measured, and held by the links-intact refusal rather than
 * trusted.
 */

import { isLink } from "@commonfabric/runner";
import { deepEqual } from "@commonfabric/utils/deep-equal";

import {
  HOLDER_PHASE,
  type PieceSelector,
  surveyPieces,
} from "./bulk-survey.ts";
import type { PiecesController } from "./pieces-controller.ts";

/**
 * A fixer: a pure transform from a piece's stored input document to the
 * document it should hold. It receives the raw stored document — sigil
 * links included, as plain data — and returns the complete document, never
 * a fragment. Purity is part of the contract, not a style preference: the
 * run answers selection, resume, and verification by re-asking the fixer,
 * and a fixer that reads a clock or a random source makes every one of
 * those answers wrong.
 */
export type Fixer = (
  document: Readonly<Record<string, unknown>>,
) => Record<string, unknown>;

/** One leaf-level difference between a stored document and a fixer's. */
export interface DocumentChange {
  /** The changed position, segments joined with `/`; `""` is the root. */
  path: string;
  before: unknown;
  after: unknown;
}

/**
 * One piece's outcome. `conforms` and `would-change` are the dry verdicts;
 * an apply turns `would-change` into `repaired` — or `failed`, when the
 * written document still does not satisfy the fixer, which is the write
 * path lying and never a reason to write again. `refused` is the fixer
 * breaking its contract on this piece's document, and `unattempted` names
 * the rows after an apply stopped.
 */
export type RepairVerdict =
  | "conforms"
  | "would-change"
  | "repaired"
  | "refused"
  | "failed"
  | "unattempted";

/** One piece's row in a repair report. */
export interface RepairRow {
  piece: string;
  /** The plan row's phase label, carried as the survey stamped it. */
  phase?: string;
  verdict: RepairVerdict;
  /** What a refused or failed row broke; absent otherwise. */
  problem?: string;
  /** The exact changes the fixer would make (or made); absent when none. */
  changes?: readonly DocumentChange[];
}

/** What one repair run found, and — under `apply` — did. */
export interface RepairReport {
  rows: readonly RepairRow[];
  /** Documents written. Zero on a dry run and on a conforming re-run. */
  applied: number;
  /**
   * True when every row is `conforms` or `repaired`: nothing refused,
   * nothing failed, nothing unattempted. A dry run is complete when
   * nothing refused — `would-change` is its answer, not a defect.
   */
  complete: boolean;
}

export interface RepairOptions {
  selector: PieceSelector;
  fixer: Fixer;
  /**
   * Write the documents the fixer produces. Absent, the run is the
   * dry-run report — the exact per-piece diff, and no write at all.
   */
  apply?: boolean;
}

/** How one evaluation of the fixer over one document came out. */
export type FixerOutcome =
  | { kind: "conforms" }
  | {
    kind: "change";
    document: Record<string, unknown>;
    changes: readonly DocumentChange[];
  }
  | { kind: "refused"; problem: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Every path in `node` that holds a sigil link, in traversal order. */
export function collectLinkPaths(
  node: unknown,
  path = "",
  found: string[] = [],
): readonly string[] {
  if (node === null || typeof node !== "object") return found;
  if (isLink(node)) {
    found.push(path);
    return found;
  }
  for (const [key, value] of Object.entries(node)) {
    collectLinkPaths(value, path === "" ? key : `${path}/${key}`, found);
  }
  return found;
}

/** The value at a `/`-joined path, or `undefined` where the path breaks. */
function valueAtPath(node: unknown, path: string): unknown {
  if (path === "") return node;
  let current: unknown = node;
  for (const segment of path.split("/")) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/**
 * The leaf-level differences between two documents, as change rows. A
 * position whose two sides are both containers of the same kind recurses;
 * anything else that differs is one change at that position, so a replaced
 * array or object reads as one change rather than as its every leaf.
 */
export function documentChanges(
  before: unknown,
  after: unknown,
  path = "",
  out: DocumentChange[] = [],
): readonly DocumentChange[] {
  if (deepEqual(before, after)) return out;
  const bothRecords = isRecord(before) && isRecord(after);
  const bothArrays = Array.isArray(before) && Array.isArray(after);
  if (!bothRecords && !bothArrays) {
    out.push({ path, before, after });
    return out;
  }
  const keys = new Set([
    ...Object.keys(before as object),
    ...Object.keys(after as object),
  ]);
  for (const key of keys) {
    documentChanges(
      (before as Record<string, unknown>)[key],
      (after as Record<string, unknown>)[key],
      path === "" ? key : `${path}/${key}`,
      out,
    );
  }
  return out;
}

/**
 * Run the fixer over one stored document and classify the answer. Pure —
 * no controller, no space — which is what lets a fixer's refusals be unit
 * tests and lets the Topics restore import these checks instead of
 * hand-rolling them.
 *
 * The document handed to each fixer call is a fresh deep copy, so a fixer
 * that mutates its argument corrupts neither the purity probe nor the diff
 * baseline. Raw stored documents are plain data — sigil links included —
 * which is what makes the copy, the comparisons, and the walk below sound.
 */
export function evaluateFixer(
  document: Readonly<Record<string, unknown>>,
  fixer: Fixer,
): FixerOutcome {
  let first: unknown;
  let second: unknown;
  try {
    first = fixer(structuredClone(document) as Record<string, unknown>);
    second = fixer(structuredClone(document) as Record<string, unknown>);
  } catch (error) {
    return {
      kind: "refused",
      problem: `The fixer threw: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  if (!isRecord(first)) {
    return {
      kind: "refused",
      problem: "The fixer returned a value that is not a document.",
    };
  }
  if (!deepEqual(first, second)) {
    return {
      kind: "refused",
      problem: "The fixer is not a pure function of the document: two runs " +
        "over one document answered differently.",
    };
  }
  // The write replaces the whole document, so a field the fixer's answer
  // lacks would be zeroed by it — a defect, never an intent.
  const lost = Object.keys(document).filter((key) =>
    document[key] !== undefined && first[key] === undefined
  );
  if (lost.length > 0) {
    return {
      kind: "refused",
      problem: `The fixer returned an incomplete document: ` +
        `${lost.join(", ")} would be lost by the write.`,
    };
  }
  // A reference either round-trips untouched or the document is refused: a
  // link rewritten as a value is corrupted and a dropped one is destroyed,
  // and neither is visible in the result until much later.
  for (const linkPath of collectLinkPaths(document)) {
    const kept = valueAtPath(first, linkPath);
    if (!deepEqual(valueAtPath(document, linkPath), kept)) {
      return {
        kind: "refused",
        problem: `The fixer rewrote or dropped the link at ` +
          `${linkPath === "" ? "<root>" : linkPath}.`,
      };
    }
  }
  if (deepEqual(document, first)) return { kind: "conforms" };
  return {
    kind: "change",
    document: first,
    changes: documentChanges(document, first),
  };
}

/**
 * Iterate the fixer over a selection, serially, in survey order — dry by
 * default, writing under `apply`.
 *
 * Selection is the survey's: the same enumeration, and the same containment
 * gate, so a registered in-scope piece the collection lacks stops a repair
 * exactly the way it stops a survey — a run over a silent subset is the
 * failure this whole design exists to prevent. On a collection selector the
 * holder's own row is not repaired: the fixer is typed against the members'
 * document shape, and a holder wanting repair is a one-piece list selection
 * of its own.
 *
 * Under `apply`, each written document is read back and the fixer asked
 * again — a repair succeeded when re-running the fixer over the stored
 * result is a no-op — and a refusal or a failed verification stops the run
 * with every remaining row named `unattempted`, not counted.
 */
export async function repairPieces(
  pieces: PiecesController,
  options: RepairOptions,
): Promise<RepairReport> {
  const survey = await surveyPieces(pieces, { selector: options.selector });
  if (!survey.complete) {
    const named = [
      ...survey.problems.map((problem) =>
        `unreadable: ${problem.piece} ${problem.problem}`
      ),
      ...survey.outside.map((outside) =>
        `registered outside the selection: ${outside.piece}`
      ),
    ];
    throw new Error(
      `The selection is incomplete, and a repair over a silent subset is ` +
        `the failure this refusal prevents:\n${named.join("\n")}`,
    );
  }
  const rows: RepairRow[] = [];
  let applied = 0;
  let stopped = false;
  for (const planRow of survey.plan.rows) {
    if (planRow.phase === HOLDER_PHASE) continue;
    if (stopped) {
      rows.push({
        piece: planRow.piece,
        phase: planRow.phase,
        verdict: "unattempted",
      });
      continue;
    }
    const controller = await pieces.get(planRow.piece, false);
    const cell = await controller.input.getCell();
    await cell.pull();
    const document = cell.getRaw({ lastNode: "value" });
    if (!isRecord(document)) {
      rows.push({
        piece: planRow.piece,
        phase: planRow.phase,
        verdict: "refused",
        problem: "The stored input is not a document.",
      });
      stopped = options.apply === true;
      continue;
    }
    const outcome = evaluateFixer(document, options.fixer);
    if (outcome.kind === "refused") {
      rows.push({
        piece: planRow.piece,
        phase: planRow.phase,
        verdict: "refused",
        problem: outcome.problem,
      });
      stopped = options.apply === true;
      continue;
    }
    if (outcome.kind === "conforms") {
      rows.push({
        piece: planRow.piece,
        phase: planRow.phase,
        verdict: "conforms",
      });
      continue;
    }
    if (options.apply !== true) {
      rows.push({
        piece: planRow.piece,
        phase: planRow.phase,
        verdict: "would-change",
        changes: outcome.changes,
      });
      continue;
    }
    await controller.input.set(outcome.document, []);
    applied += 1;
    await pieces.synced();
    await cell.pull();
    const written = cell.getRaw({ lastNode: "value" });
    const verification = isRecord(written)
      ? evaluateFixer(written, options.fixer)
      : undefined;
    if (verification?.kind === "conforms") {
      rows.push({
        piece: planRow.piece,
        phase: planRow.phase,
        verdict: "repaired",
        changes: outcome.changes,
      });
      continue;
    }
    rows.push({
      piece: planRow.piece,
      phase: planRow.phase,
      verdict: "failed",
      problem: "The written document does not satisfy the fixer, so the " +
        "write path and the fixer disagree; writing again would not " +
        "converge.",
      changes: outcome.changes,
    });
    stopped = true;
  }
  const complete = rows.every((row) =>
    row.verdict === "conforms" || row.verdict === "repaired" ||
    (options.apply !== true && row.verdict === "would-change")
  );
  return { rows, applied, complete };
}
