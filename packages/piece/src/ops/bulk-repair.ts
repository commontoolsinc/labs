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
 * rewritten as a value or dropped is corruption either way. The apply is
 * transactional: the fixer is re-evaluated against the document the commit
 * actually sees, so a concurrent edit conflicts and re-runs rather than
 * being overwritten. A stored document is a `FabricValue` — references as
 * sigil links, and special values such as bytes as class instances — so
 * every copy, comparison, and hash below goes through the data-model's own
 * primitives, and the walkers treat anything that is not a plain record or
 * a direct array as one atomic value.
 *
 * The run's record is the plan artifact: each evaluated row carries the
 * hash of the document its answer was computed from, which is the repair
 * row's precondition the way the reference pair is a retarget row's.
 */

import type { FabricValue } from "@commonfabric/api";
import { valueEqual } from "@commonfabric/data-model/fabric-value";
import { cloneIfNecessary } from "@commonfabric/data-model/value-clone";
import { hashStringOf } from "@commonfabric/data-model/value-hash";
import { isLink } from "@commonfabric/runner";
import { isPlainObject } from "@commonfabric/utils/types";

import {
  canonicalPieceAddress,
  type PiecePlan,
  type PiecePlanRow,
} from "./bulk-plan.ts";
import {
  HOLDER_PHASE,
  type PieceSelector,
  surveyPieces,
} from "./bulk-survey.ts";
import type { PiecesController } from "./pieces-controller.ts";

/**
 * A fixer: a pure transform from a piece's stored input document to the
 * document it should hold. It receives the raw stored document — sigil
 * links and Fabric special values included — and returns the complete
 * document, never a fragment. Purity is part of the contract, not a style
 * preference: the run answers selection, resume, and verification by
 * re-asking the fixer, the transactional apply re-runs it against the
 * document the commit sees, and a fixer that reads a clock or a random
 * source makes every one of those answers wrong.
 */
export type Fixer = (
  document: Readonly<Record<string, unknown>>,
) => Record<string, unknown>;

/**
 * One difference between a stored document and a fixer's answer. `changed`
 * carries both sides; `added` is a position the answer holds and the stored
 * document does not, `removed` the reverse — presence is its own fact, not
 * an `undefined` standing in for one.
 */
export interface DocumentChange {
  /**
   * The position: segments joined with `/`, a segment's own `/` escaped
   * `~1` and `~` escaped `~0` — the JSON Pointer spelling, so a key
   * containing the separator stays unambiguous. `""` is the root.
   */
  path: string;
  kind: "changed" | "added" | "removed";
  before?: unknown;
  after?: unknown;
}

/**
 * One piece's outcome. `conforms` and `would-change` are the dry verdicts;
 * an apply turns `would-change` into `repaired` — or `failed`, when the
 * stored document does not satisfy the fixer after the write, or when an
 * operational error interrupted the row. `refused` is the fixer breaking
 * its contract on this piece's document; `moved` is a supplied plan's
 * document-hash precondition no longer holding, which is a stop rather
 * than an overwrite; `unattempted` names the rows after an apply stopped.
 */
export type RepairVerdict =
  | "conforms"
  | "would-change"
  | "repaired"
  | "refused"
  | "moved"
  | "failed"
  | "unattempted";

/** One piece's row in a repair report. */
export interface RepairRow {
  piece: string;
  /** The plan row's phase label, carried as the survey stamped it. */
  phase?: string;
  verdict: RepairVerdict;
  /** What a refused, moved, or failed row broke; absent otherwise. */
  problem?: string;
  /** The exact changes the fixer would make (or made); absent when none. */
  changes?: readonly DocumentChange[];
  /**
   * The hash of the stored document this row's verdict was computed from —
   * the precondition a plan row carries. Absent where no document was read.
   */
  documentHash?: string;
}

/** What one repair run found, and — under `apply` — did. */
export interface RepairReport {
  rows: readonly RepairRow[];
  /**
   * The run as a plan artifact: the survey's header, and one row per
   * evaluated piece carrying its document-hash precondition — with the
   * repair operation stamped when the run was given a fixer name to record.
   */
  plan: PiecePlan;
  /** Documents written. Zero on a dry run and on a conforming re-run. */
  applied: number;
  /**
   * True when every row is `conforms` or `repaired`: nothing refused,
   * nothing moved, nothing failed, nothing unattempted. A dry run is
   * complete when nothing refused or failed — `would-change` is its
   * answer, not a defect.
   */
  complete: boolean;
}

export interface RepairOptions {
  selector: PieceSelector;
  fixer: Fixer;
  /**
   * The fixer's name as the plan should record it — a module path or a
   * label. With one, the emitted plan's evaluated rows carry the repair
   * operation; without, they carry only the pre-state record.
   */
  fixerName?: string;
  /**
   * A previously emitted plan whose document hashes are this run's
   * preconditions: a row whose stored document no longer hashes to what
   * the plan recorded is `moved` — something other than this plan changed
   * it — and an apply stops on it rather than overwriting.
   */
  plan?: PiecePlan;
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

/**
 * The plain-record arm of a stored document: an `Object.prototype`-rooted
 * (or null-prototype) record. A Fabric special value — bytes, a hash, an
 * epoch — is a class instance, holds its state privately, and answers
 * `Object.keys` with nothing, so a walker that descended into one would
 * read every one as empty: they are atomic values here, never containers.
 */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return isPlainObject(value);
}

/** Structural equality over stored values, Fabric specials included. */
function storedEqual(a: unknown, b: unknown): boolean {
  return valueEqual(a as FabricValue, b as FabricValue);
}

/** One path segment, display-escaped in the JSON Pointer spelling. */
function escapeSegment(segment: string): string {
  return segment.replaceAll("~", "~0").replaceAll("/", "~1");
}

/** Segments joined for display; `""` is the root. */
function displayPath(segments: readonly string[]): string {
  return segments.map(escapeSegment).join("/");
}

/**
 * Every path in `node` that holds a sigil link, in traversal order. Paths
 * are segment arrays rather than joined strings, so a key containing the
 * display separator addresses its own slot and nobody else's.
 */
export function collectLinkPaths(
  node: unknown,
  path: readonly string[] = [],
  found: (readonly string[])[] = [],
): readonly (readonly string[])[] {
  if (isLink(node)) {
    found.push(path);
    return found;
  }
  if (!isPlainRecord(node) && !Array.isArray(node)) return found;
  for (const [key, value] of Object.entries(node)) {
    collectLinkPaths(value, [...path, key], found);
  }
  return found;
}

/** The value at a segment path, or `undefined` where the path breaks. */
function valueAtPath(node: unknown, path: readonly string[]): unknown {
  let current: unknown = node;
  for (const segment of path) {
    if (!isPlainRecord(current) && !Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/**
 * Paths the fixer's answer lost, recursively: an input record's own key
 * absent from the answer — or present as `undefined`, which the write
 * treats the same — wherever both sides keep a plain record, or an equally
 * long array, at the same position. Recursion stops where the shapes part:
 * replacing a container outright is an act the diff reports as a change,
 * while omitting fields from one that survives is the fragment accident
 * this check exists to refuse. Link nodes are the links-intact check's to
 * judge, and a Fabric special value is one value, so neither is descended.
 */
function lostFields(
  before: unknown,
  after: unknown,
  path: readonly string[] = [],
  out: string[] = [],
): readonly string[] {
  if (isLink(before)) return out;
  const bothRecords = isPlainRecord(before) && isPlainRecord(after);
  const bothArrays = Array.isArray(before) && Array.isArray(after) &&
    before.length === after.length;
  if (!bothRecords && !bothArrays) return out;
  for (const key of Object.keys(before as object)) {
    const beforeValue = (before as Record<string, unknown>)[key];
    if (
      bothRecords &&
      (!Object.hasOwn(after as object, key) ||
        ((after as Record<string, unknown>)[key] === undefined &&
          beforeValue !== undefined))
    ) {
      out.push(displayPath([...path, key]));
      continue;
    }
    lostFields(
      beforeValue,
      (after as Record<string, unknown>)[key],
      [...path, key],
      out,
    );
  }
  return out;
}

/**
 * The differences between two documents, as change rows with presence its
 * own fact. A position whose two sides are both plain records, or both
 * direct arrays, recurses; anything else that differs — a Fabric special
 * value included — is one change at that position, so a replaced container
 * reads as one change rather than as its every leaf.
 */
export function documentChanges(
  before: unknown,
  after: unknown,
  path: readonly string[] = [],
  out: DocumentChange[] = [],
): readonly DocumentChange[] {
  if (storedEqual(before, after)) return out;
  const bothRecords = isPlainRecord(before) && isPlainRecord(after);
  const bothArrays = Array.isArray(before) && Array.isArray(after);
  if (!bothRecords && !bothArrays) {
    out.push({ path: displayPath(path), kind: "changed", before, after });
    return out;
  }
  const keys = new Set([
    ...Object.keys(before as object),
    ...Object.keys(after as object),
  ]);
  for (const key of keys) {
    const hasBefore = Object.hasOwn(before as object, key);
    const hasAfter = Object.hasOwn(after as object, key);
    const at = [...path, key];
    if (hasBefore && !hasAfter) {
      out.push({
        path: displayPath(at),
        kind: "removed",
        before: (before as Record<string, unknown>)[key],
      });
      continue;
    }
    if (!hasBefore && hasAfter) {
      out.push({
        path: displayPath(at),
        kind: "added",
        after: (after as Record<string, unknown>)[key],
      });
      continue;
    }
    documentChanges(
      (before as Record<string, unknown>)[key],
      (after as Record<string, unknown>)[key],
      at,
      out,
    );
  }
  return out;
}

/**
 * Run the fixer over one stored document and classify the answer. Pure —
 * no controller, no space — which is what lets a fixer's refusals be unit
 * tests. The document handed to each fixer call is a fresh unfrozen deep
 * copy through the data-model's own clone, so a fixer that mutates its
 * argument corrupts neither the purity probe nor the diff baseline, and a
 * Fabric special value arrives as itself rather than as an empty shell.
 */
export function evaluateFixer(
  document: Readonly<Record<string, unknown>>,
  fixer: Fixer,
): FixerOutcome {
  const copy = () =>
    cloneIfNecessary(document as FabricValue, {
      frozen: false,
    }) as Record<string, unknown>;
  let first: unknown;
  let second: unknown;
  try {
    first = fixer(copy());
    second = fixer(copy());
  } catch (error) {
    return {
      kind: "refused",
      problem: `The fixer threw: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  if (!isPlainRecord(first)) {
    return {
      kind: "refused",
      problem: "The fixer returned a value that is not a document.",
    };
  }
  if (!storedEqual(first, second)) {
    return {
      kind: "refused",
      problem: "The fixer is not a pure function of the document: two runs " +
        "over one document answered differently.",
    };
  }
  // The write replaces the whole document, so a field the fixer's answer
  // lacks would be zeroed by it — a defect, never an intent — and a nested
  // field is as gone as a top-level one.
  const lost = lostFields(document, first);
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
    if (!storedEqual(valueAtPath(document, linkPath), kept)) {
      return {
        kind: "refused",
        problem: `The fixer rewrote or dropped the link at ` +
          `${linkPath.length === 0 ? "<root>" : displayPath(linkPath)}.`,
      };
    }
  }
  if (storedEqual(document, first)) return { kind: "conforms" };
  return {
    kind: "change",
    document: first,
    changes: documentChanges(document, first),
  };
}

/** What one pass over a piece's stored document decided. */
type RowDecision =
  | { kind: "not-document" }
  | { kind: "moved"; documentHash: string }
  | { kind: "conforms"; documentHash: string }
  | {
    kind: "change";
    documentHash: string;
    changes: readonly DocumentChange[];
  }
  | { kind: "refused"; documentHash: string; problem: string };

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
 * Under `apply`, each row is evaluated and written in one transaction: the
 * fixer answers for the document the commit sees, so a concurrent edit
 * re-runs the evaluation rather than being overwritten. A supplied plan's
 * document hash is checked in the same transaction, and a mismatch is
 * `moved` — a stop, not an overwrite. The written document is then read
 * back and the fixer asked again — a repair succeeded when re-running the
 * fixer over the stored result is a no-op — and a refusal, a moved row, or
 * a failure stops the run with every remaining row named `unattempted`. An
 * operational error — an unreachable piece, a write the schema refuses —
 * becomes that row's `failed` verdict rather than escaping with the report:
 * the rows that landed stay reported, and the row's state is re-checked
 * after the failure so the problem says where the piece was left.
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
  const expectedHashes = new Map<string, string>();
  for (const row of options.plan?.rows ?? []) {
    if (row.expect.documentHash !== undefined) {
      expectedHashes.set(
        canonicalPieceAddress(row.piece),
        row.expect.documentHash,
      );
    }
  }
  const rows: RepairRow[] = [];
  const planRows: PiecePlanRow[] = [];
  let applied = 0;
  let stopped = false;
  for (const surveyRow of survey.plan.rows) {
    if (surveyRow.phase === HOLDER_PHASE) continue;
    const phase = surveyRow.phase === undefined
      ? {}
      : { phase: surveyRow.phase };
    const preStateRow = {
      piece: surveyRow.piece,
      ...phase,
      expect: surveyRow.expect,
    };
    if (stopped) {
      rows.push({ piece: surveyRow.piece, ...phase, verdict: "unattempted" });
      planRows.push(preStateRow);
      continue;
    }
    const expected = expectedHashes.get(surveyRow.piece);
    const decide = (stored: unknown): RowDecision => {
      if (!isPlainRecord(stored)) return { kind: "not-document" };
      const documentHash = hashStringOf(stored);
      if (expected !== undefined && documentHash !== expected) {
        return { kind: "moved", documentHash };
      }
      const outcome = evaluateFixer(stored, options.fixer);
      if (outcome.kind === "refused") {
        return { kind: "refused", documentHash, problem: outcome.problem };
      }
      if (outcome.kind === "conforms") {
        return { kind: "conforms", documentHash };
      }
      return { kind: "change", documentHash, changes: outcome.changes };
    };
    try {
      const controller = await pieces.get(surveyRow.piece, false);
      const cell = await controller.input.getCell();
      await cell.pull();
      // Initialized only to satisfy definite assignment: a committed edit
      // has run its closure at least once, so the committed pass always
      // overwrites this before it is read.
      let decision: RowDecision = { kind: "not-document" };
      if (options.apply === true) {
        // Evaluate-and-write in one transaction: on a commit conflict the
        // closure re-runs against fresh state, so `decision` is whatever
        // the committed pass decided, later passes overwriting earlier.
        await controller.input.edit((stored) => {
          decision = decide(stored);
          if (decision.kind !== "change") return undefined;
          const outcome = evaluateFixer(
            stored as Record<string, unknown>,
            options.fixer,
          );
          return outcome.kind === "change"
            ? { value: outcome.document }
            : undefined;
        });
      } else {
        decision = decide(cell.getRaw({ lastNode: "value" }));
      }
      if (decision.kind === "not-document" || decision.kind === "moved") {
        planRows.push(preStateRow);
      } else {
        // The evaluated row, as the artifact records it: the survey's
        // expectation plus the document hash the verdict was computed
        // from, and the repair operation when the run has a name for it.
        planRows.push({
          piece: surveyRow.piece,
          ...phase,
          expect: {
            ...surveyRow.expect,
            documentHash: decision.documentHash,
          },
          ...(options.fixerName === undefined ? {} : {
            op: { kind: "repair", fixer: options.fixerName },
          }),
        });
      }
      if (decision.kind === "not-document") {
        rows.push({
          piece: surveyRow.piece,
          ...phase,
          verdict: "refused",
          problem: "The stored input is not a document.",
        });
        stopped = options.apply === true;
        continue;
      }
      if (decision.kind === "moved") {
        rows.push({
          piece: surveyRow.piece,
          ...phase,
          verdict: "moved",
          documentHash: decision.documentHash,
          problem: "The stored document no longer hashes to what the plan " +
            "recorded: something other than this plan changed it.",
        });
        stopped = options.apply === true;
        continue;
      }
      if (decision.kind === "refused") {
        rows.push({
          piece: surveyRow.piece,
          ...phase,
          verdict: "refused",
          documentHash: decision.documentHash,
          problem: decision.problem,
        });
        stopped = options.apply === true;
        continue;
      }
      if (decision.kind === "conforms") {
        rows.push({
          piece: surveyRow.piece,
          ...phase,
          verdict: "conforms",
          documentHash: decision.documentHash,
        });
        continue;
      }
      if (options.apply !== true) {
        rows.push({
          piece: surveyRow.piece,
          ...phase,
          verdict: "would-change",
          documentHash: decision.documentHash,
          changes: decision.changes,
        });
        continue;
      }
      applied += 1;
      await pieces.synced();
      await cell.pull();
      const written = cell.getRaw({ lastNode: "value" });
      const verification = isPlainRecord(written)
        ? evaluateFixer(written, options.fixer)
        : undefined;
      if (verification?.kind === "conforms") {
        rows.push({
          piece: surveyRow.piece,
          ...phase,
          verdict: "repaired",
          documentHash: decision.documentHash,
          changes: decision.changes,
        });
        continue;
      }
      rows.push({
        piece: surveyRow.piece,
        ...phase,
        verdict: "failed",
        documentHash: decision.documentHash,
        problem: "The stored document does not satisfy the fixer after the " +
          "write: the write path dropped something, or a concurrent change " +
          "landed between the write and this read. Writing again is not " +
          "the answer either way.",
        changes: decision.changes,
      });
      stopped = true;
    } catch (error) {
      // An operational failure — an unreachable piece, a write the schema
      // refuses — is this row's outcome, not the report's: the rows that
      // landed stay reported. The state check runs after the failure, so
      // the problem says where the piece was left rather than guessing.
      const problem = error instanceof Error ? error.message : String(error);
      let state = "; the piece could not be re-read, so its state is unknown";
      try {
        const controller = await pieces.get(surveyRow.piece, false);
        const cell = await controller.input.getCell();
        await cell.pull();
        const stored = cell.getRaw({ lastNode: "value" });
        if (isPlainRecord(stored)) {
          state = evaluateFixer(stored, options.fixer).kind === "conforms"
            ? "; the stored document satisfies the fixer, so the row landed"
            : "; the stored document still needs the repair";
        }
      } catch {
        // The re-read failing changes nothing: `state` already says so.
      }
      rows.push({
        piece: surveyRow.piece,
        ...phase,
        verdict: "failed",
        problem: problem + state,
      });
      planRows.push(preStateRow);
      stopped = options.apply === true;
    }
  }
  const complete = rows.every((row) =>
    row.verdict === "conforms" || row.verdict === "repaired" ||
    (options.apply !== true && row.verdict === "would-change")
  );
  return {
    rows,
    plan: { header: survey.plan.header, rows: planRows },
    applied,
    complete,
  };
}
