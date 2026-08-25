/**
 * The plan a bulk piece operation runs from, and its on-disk form.
 *
 * A plan is a header plus one row per piece. Each row names a piece, the state
 * it must be in for the operation to apply (`expect`), and — once an operation
 * is chosen — what to do to it (`op`). A survey emits rows with `expect` alone;
 * a later pass adds the `op`. The rollback of a retarget plan is derived from
 * these rows rather than surveyed again, which is why a row records both the
 * identity the piece is on and, for a retarget, the identity its source
 * produces.
 *
 * The on-disk form is line-oriented JSON: the header on the first line, then
 * one object per row, and **line order is execution order**. That keeps the
 * ordering constraint — children before the holder — in the artifact a reviewer
 * reads, and lets a reader check it without running anything. The design is in
 * [docs/plans/piece-bulk-operations.md](../../../../docs/plans/piece-bulk-operations.md).
 */

import { FabricHash } from "@commonfabric/data-model/fabric-primitives";
import { hashStringForEntityAddress } from "@commonfabric/runner/entity-kind";

/**
 * The canonical spelling of a piece address: the bare tagged-hash form every
 * survey row carries. The `of:` URI alias names the same entity and folds to
 * it here, so two spellings of one piece cannot slip past a uniqueness check
 * or a diff key. What remains after the fold must parse as a tagged content
 * hash — an empty or arbitrary string is refused, not carried. A kinded
 * (`computed:`) address is refused by the underlying parser — the `of:` id
 * over the same hash names a different entity.
 */
export function canonicalPieceAddress(address: string): string {
  const bare = hashStringForEntityAddress(address);
  try {
    // The parsed hash's own spelling, not the input's: padded and other
    // non-canonical base64 spellings of one hash must land on one key.
    return FabricHash.fromString(bare).taggedHashString;
  } catch {
    throw new Error(`Not a piece address: ${JSON.stringify(address)}.`);
  }
}

/** One piece and what went wrong with it — unreadable, or failing a validator. */
export interface SurveyProblem {
  piece: string;
  problem: string;
}

/** A registered in-scope piece the selection does not cover. */
export interface RegisteredOutside {
  piece: string;
  patternIdentity: string;
  symbol: string;
}

/** What a plan row requires of its piece before its operation applies. */
export interface PieceExpect {
  /** The pattern identity the piece is currently on. */
  patternIdentity: string;
  /**
   * The export the identity runs. The runtime's executable pointer is the
   * `{identity, symbol}` pair — two patterns exported by one module share an
   * identity and differ only here — so every comparison a plan feeds carries
   * both halves.
   */
  symbol: string;
  /**
   * Whether the source behind `patternIdentity` is verifiably retained in
   * the space — the canonical loader can produce its closure — and so is a
   * usable restore target. A row whose prior source is not has no rollback
   * target, which a run has to know before it starts rather than during an
   * incident.
   */
  retained: boolean;
  /**
   * The revision the piece is at, when it already keeps a source-revision log.
   * A piece with no log yet — a legacy piece — has none until its first
   * transition appends a baseline revision, so a survey cannot read one for it.
   */
  revisionId?: string;
  /**
   * The hash of the piece's stored input document, recorded by a repair's
   * dry run. It is the repair row's precondition the way the reference pair
   * is a retarget row's: the apply refuses a row whose stored document no
   * longer hashes to it, because a document something else moved is a stop,
   * not an overwrite.
   */
  documentHash?: string;
}

/** Replace a piece's source with the program a local source closure produces. */
export interface RetargetOp {
  kind: "retarget";
  /** The source closure to apply, as the local-program inputs that name it. */
  source: RetargetSource;
  /**
   * A human-facing label for the source's provenance — a git rev, say. Recorded
   * for readers and for diffing two plans; never enforced. The identity is the
   * pin: the apply recomputes the resolved source's identity and refuses the
   * row if it differs from `patternIdentity`.
   */
  rev?: string;
  /** The identity the source produces, computed from the source, not compiled. */
  patternIdentity: string;
  /** The export the retarget runs: the source's `mainExport`, or the default. */
  symbol: string;
  /**
   * Whether this row may apply with the pattern and retained-link compatibility
   * checks disabled. A field on the row so a reviewer sees which rows ran with
   * the gate open; a flag at plan time is what stamps it across a run.
   */
  allowIncompatible?: boolean;
}

/** The local-source inputs that name a program to retarget onto. */
export interface RetargetSource {
  /** The entry module path. */
  main: string;
  /** The source root, when it is not the entry's own directory. */
  root?: string;
  /** Test entry paths to include in the closure. */
  testPaths?: readonly string[];
  /** Data file paths to attach and classify as data. */
  dataFilePaths?: readonly string[];
  /** The entry export to run, when it is not the default. */
  mainExport?: string;
}

/**
 * Return a piece to a retained revision — the reversal of a retarget. A
 * restore carries no compatibility override: whether returning to a
 * reference the piece already ran needs one is stage 4's question, and the
 * derivation deliberately records nothing it cannot answer.
 */
export interface RestoreOp {
  kind: "restore";
  /**
   * The identity the retained revision carries. For a legacy piece whose
   * baseline the retarget itself appended, this is the identity the survey
   * recorded in the retarget row's `expect`; the run resolves it to the
   * revision retaining that identity's source.
   */
  patternIdentity: string;
  /** The export the restored revision runs — the pair's other half. */
  symbol: string;
  /**
   * The revision to restore, when the survey read one — a piece that already
   * kept a log at survey time. Absent for a baseline the retarget appends,
   * where `patternIdentity` selects the revision instead.
   */
  revisionId?: string;
}

/**
 * Run a caller-supplied fixer over the piece's stored input document. The
 * fixer itself is a TypeScript module the run imports, so the plan records
 * only its name for readers and for diffing — the row's enforceable half is
 * `expect.documentHash`, which pins the document the fixer's answer was
 * computed from.
 */
export interface RepairOp {
  kind: "repair";
  /** The fixer's name as supplied — a module path or label; never resolved. */
  fixer: string;
}

/** What a plan row does to its piece, absent on a survey-only row. */
export type PieceOp = RetargetOp | RestoreOp | RepairOp;

/** One piece in a plan: the piece, its precondition, and its operation. */
export interface PiecePlanRow {
  /**
   * The piece's canonical bare address (`fid1:…`). The `of:` alias names the
   * same piece and folds to this form at decode.
   */
  piece: string;
  /** A grouping label for reports and for stopping between groups; not a sort key. */
  phase?: string;
  expect: PieceExpect;
  op?: PieceOp;
}

/** The counts a survey compares to catch a selection that dropped members. */
export interface PlanEnumeration {
  /** Pieces the selection names: a collection's members, or a list's entries. */
  collection: number;
  /** Pieces the space's piece registry lists. */
  registry: number;
  /**
   * Registered pieces on an in-scope identity that the collection does not
   * hold. Any above zero is a selection error: the collection read dropped a
   * member, or a piece of the same kind lives outside the holder.
   */
  registeredOutside: number;
}

/** A plan's first line: what it is, and how its selection was cross-checked. */
export interface PiecePlanHeader {
  kind: "piece-plan";
  v: 1;
  /** The space every row's piece lives in. */
  space: string;
  /** When the survey behind the plan was taken, as an ISO-8601 string. */
  takenAt: string;
  /** Which selector produced the rows: a holder's collection, or a list. */
  selector: "collection" | "list";
  enumerated: PlanEnumeration;
  /**
   * Selected pieces the survey could not read into rows. Their absence from
   * `rows` would otherwise be invisible in the artifact, so an incomplete
   * survey stays incomplete across encode and decode; a write stage refuses
   * a plan carrying any.
   */
  problems?: readonly SurveyProblem[];
  /** Registered in-scope pieces the selection lacks — the same standing. */
  outside?: readonly RegisteredOutside[];
}

/** A header and its rows, in execution order. */
export interface PiecePlan {
  header: PiecePlanHeader;
  rows: readonly PiecePlanRow[];
}

/**
 * Render a plan as line-oriented JSON: the header, then one row per line, in
 * order. The result ends in a newline so it appends cleanly and reads as a
 * complete file.
 */
export function encodePlan(plan: PiecePlan): string {
  const lines = [JSON.stringify(plan.header)];
  for (const row of plan.rows) lines.push(JSON.stringify(row));
  return lines.join("\n") + "\n";
}

/**
 * Parse a plan from the form {@link encodePlan} writes. Blank lines are
 * ignored so a hand-edited file round-trips; every other line must be an
 * object, the first of them the `piece-plan` header. Row addresses fold to
 * the canonical bare spelling, and a plan listing one piece twice is
 * refused. Throws on a missing or wrong header, or a row that is not a
 * valid row — a malformed plan is refused rather than half-read.
 */
export function decodePlan(text: string): PiecePlan {
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  if (lines.length === 0) throw new Error("Plan is empty.");
  return normalizePlan({
    header: JSON.parse(lines[0]),
    rows: lines.slice(1).map((line) => JSON.parse(line)),
  });
}

/**
 * Validate an assembled plan against every invariant the codec holds, and
 * return it with each row's piece address canonical. This is the one
 * validator the decoder and the executors share: an in-memory plan handed
 * straight to a run gets exactly the scrutiny a decoded file gets, so no
 * caller can slip a shape past execution that the codec would have refused
 * — a repair row without its document hash, a duplicate piece, an invalid
 * row.
 */
export function normalizePlan(
  plan: { header: unknown; rows: readonly unknown[] },
): PiecePlan {
  if (!isPlanHeader(plan.header)) {
    throw new Error(
      'Plan does not start with a "piece-plan" v1 header line.',
    );
  }
  const rows = plan.rows.map((row, index) => {
    if (!isPlanRow(row)) {
      throw new Error(`Plan row ${index + 1} is not a valid row object.`);
    }
    return { ...row, piece: canonicalPieceAddress(row.piece) };
  });
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.piece)) {
      throw new Error(`Plan lists ${row.piece} more than once.`);
    }
    seen.add(row.piece);
  }
  return { header: plan.header, rows };
}

/**
 * Derive the rollback of a retarget plan, row by row: the precondition
 * becomes the reference the retarget produced, and the operation restores the
 * retained revision carrying the reference the row recorded. Nothing is
 * re-surveyed or re-supplied. A plan whose header names pieces the survey
 * could not account for is refused before any row is read. Survey-only and
 * restore rows have nothing to roll back and are left out; a repair row is
 * refused by name, its reversal being an inverse fixer nothing can derive;
 * and a plan with no retarget rows at all is refused, because deriving an
 * empty rollback would read as having one.
 *
 * A retarget row whose prior source is not retained is refused by name
 * before any rollback row is produced: a restore of an unretained source is
 * an operation nothing can perform, and a plan carrying one would read as a
 * rollback while not being one.
 *
 * A derived row's `retained` is true by construction: the retarget stored the
 * source it applied, so the reference it produced is a retained one.
 */
export function deriveRollbackPlan(
  plan: PiecePlan,
  takenAt: string,
): PiecePlan {
  if (
    (plan.header.problems?.length ?? 0) > 0 ||
    (plan.header.outside?.length ?? 0) > 0
  ) {
    throw new Error(
      "No rollback can be derived from an incomplete plan: its header " +
        "names pieces the survey did not account for.",
    );
  }
  const repairs = plan.rows.filter((row) => row.op?.kind === "repair");
  if (repairs.length > 0) {
    // A repair's reversal would be the inverse fixer, which does not exist;
    // silently dropping the rows would launder a partial rollback into a
    // complete-looking one.
    throw new Error(
      "No rollback can be derived: repair rows have no derivable " +
        "reversal — " + repairs.map((row) => row.piece).join(", ") + ".",
    );
  }
  const unretained = plan.rows.filter((row) =>
    row.op?.kind === "retarget" && !row.expect.retained
  );
  if (unretained.length > 0) {
    throw new Error(
      "No rollback can be derived: the prior source is not retained for " +
        unretained.map((row) => row.piece).join(", ") + ".",
    );
  }
  const rows = plan.rows.flatMap((row): PiecePlanRow[] => {
    if (row.op?.kind !== "retarget") return [];
    return [{
      piece: row.piece,
      ...(row.phase === undefined ? {} : { phase: row.phase }),
      expect: {
        patternIdentity: row.op.patternIdentity,
        symbol: row.op.symbol,
        retained: true,
      },
      op: {
        kind: "restore",
        patternIdentity: row.expect.patternIdentity,
        symbol: row.expect.symbol,
        ...(row.expect.revisionId === undefined
          ? {}
          : { revisionId: row.expect.revisionId }),
      },
    }];
  });
  if (rows.length === 0) {
    throw new Error("Plan has no retarget rows to derive a rollback from.");
  }
  return {
    header: {
      ...plan.header,
      takenAt,
      // The derived plan's selection is its rows, not the survey's — a
      // header claiming the source plan's counts would read as a rollback
      // that dropped every op-less piece.
      enumerated: {
        collection: rows.length,
        registry: plan.header.enumerated.registry,
        registeredOutside: 0,
      },
    },
    rows,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

/**
 * An optional field that names something — absent, or a nonempty string.
 * An empty name would round-trip through the codec but resolve nothing.
 */
function isOptionalName(value: unknown): value is string | undefined {
  return value === undefined || (typeof value === "string" && value !== "");
}

/** An enumeration count: a selection size no real selection can exceed. */
function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) &&
    value >= 0;
}

function isOptionalStringArray(
  value: unknown,
): value is readonly string[] | undefined {
  return value === undefined ||
    (Array.isArray(value) &&
      value.every((entry) => typeof entry === "string"));
}

function isPlanHeader(value: unknown): value is PiecePlanHeader {
  if (!isRecord(value)) return false;
  const enumerated = value.enumerated;
  if (
    value.kind !== "piece-plan" || value.v !== 1 ||
    typeof value.space !== "string" || typeof value.takenAt !== "string" ||
    (value.selector !== "collection" && value.selector !== "list") ||
    !isRecord(enumerated) ||
    !isCount(enumerated.collection) || !isCount(enumerated.registry) ||
    !isCount(enumerated.registeredOutside) ||
    !(value.problems === undefined ||
      (Array.isArray(value.problems) && value.problems.every(isProblem))) ||
    !(value.outside === undefined ||
      (Array.isArray(value.outside) && value.outside.every(isOutside)))
  ) return false;
  // The header states the outside fact twice — a count and a list — and a
  // plan where the two disagree has been hand-edited into a lie: deleting
  // the list must not launder an incomplete plan into a complete one.
  const outside = value.outside as readonly unknown[] | undefined;
  return enumerated.registeredOutside === (outside?.length ?? 0);
}

function isProblem(value: unknown): value is SurveyProblem {
  return isRecord(value) && typeof value.piece === "string" &&
    typeof value.problem === "string";
}

function isOutside(value: unknown): value is RegisteredOutside {
  return isRecord(value) && typeof value.piece === "string" &&
    typeof value.patternIdentity === "string" &&
    value.patternIdentity !== "" &&
    typeof value.symbol === "string" && value.symbol !== "";
}

function isPlanRow(value: unknown): value is PiecePlanRow {
  if (!isRecord(value)) return false;
  if (typeof value.piece !== "string") return false;
  if (
    value.phase !== undefined &&
    (typeof value.phase !== "string" || value.phase === "")
  ) return false;
  const expect = value.expect;
  if (
    !isRecord(expect) || typeof expect.patternIdentity !== "string" ||
    expect.patternIdentity === "" ||
    typeof expect.symbol !== "string" || expect.symbol === "" ||
    typeof expect.retained !== "boolean" ||
    !isOptionalName(expect.revisionId) ||
    !isOptionalName(expect.documentHash)
  ) return false;
  if (value.op === undefined) return true;
  if (!isPieceOp(value.op)) return false;
  if (value.op.kind === "repair") {
    // A repair row's verifiable half is the document hash: without one the
    // row cannot be resumed or verified from the artifact, so the codec
    // requires it rather than carrying a row no run could check.
    return typeof expect.documentHash === "string" &&
      expect.documentHash !== "";
  }
  // A row whose operation produces the reference the row already records is
  // unverifiable: a diff could not tell "landed" from "never ran". Such a
  // row is a no-op to drop, not an operation to carry.
  return value.op.patternIdentity !== expect.patternIdentity ||
    value.op.symbol !== expect.symbol;
}

function isPieceOp(value: unknown): value is PieceOp {
  if (!isRecord(value)) return false;
  if (value.kind === "repair") {
    return typeof value.fixer === "string" && value.fixer !== "";
  }
  if (
    typeof value.patternIdentity !== "string" ||
    value.patternIdentity === "" ||
    typeof value.symbol !== "string" || value.symbol === ""
  ) return false;
  if (value.kind === "restore") return isOptionalName(value.revisionId);
  if (value.kind !== "retarget") return false;
  const source = value.source;
  if (!isRecord(source) || typeof source.main !== "string") return false;
  const mainExport = source.mainExport;
  // An empty export name is refused rather than read as the default: the
  // resolver drops a falsy export and runs the default, so a row carrying
  // one would execute something its own text does not say.
  if (!isOptionalString(mainExport) || mainExport === "") return false;
  // The symbol is what diff and rollback compare; the source's export is what
  // an apply resolves. A row where the two disagree would land one pattern
  // and verify another, so the codec refuses it.
  if (value.symbol !== (mainExport ?? "default")) return false;
  return isOptionalString(source.root) &&
    isOptionalStringArray(source.testPaths) &&
    isOptionalStringArray(source.dataFilePaths) &&
    isOptionalString(value.rev) &&
    (value.allowIncompatible === undefined ||
      typeof value.allowIncompatible === "boolean");
}
