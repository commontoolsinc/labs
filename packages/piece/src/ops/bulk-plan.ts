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
   * Whether the source behind `patternIdentity` is still retained in the
   * space, and so is a restore target. A row whose prior source is not
   * retained has no rollback target, which a run has to know before it starts
   * rather than during an incident.
   */
  retained: boolean;
  /**
   * The revision the piece is at, when it already keeps a source-revision log.
   * A piece with no log yet — a legacy piece — has none until its first
   * transition appends a baseline revision, so a survey cannot read one for it.
   */
  revisionId?: string;
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

/** Return a piece to a retained revision — the reversal of a retarget. */
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

/** What a plan row does to its piece, absent on a survey-only row. */
export type PieceOp = RetargetOp | RestoreOp;

/** One piece in a plan: the piece, its precondition, and its operation. */
export interface PiecePlanRow {
  /** The piece's address, in the `of:fid1:…` form `PiecesController.get` takes. */
  piece: string;
  /** A grouping label for reports and for stopping between groups; not a sort key. */
  phase?: string;
  expect: PieceExpect;
  op?: PieceOp;
}

/** The counts a survey compares to catch a selection that dropped members. */
export interface PlanEnumeration {
  /** Members read from the holder's collection — the authoritative set. */
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
  enumerated: PlanEnumeration;
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
 * object, the first of them the `piece-plan` header. Throws on a missing or
 * wrong header, or a row that is not an object — a malformed plan is refused
 * rather than half-read.
 */
export function decodePlan(text: string): PiecePlan {
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  if (lines.length === 0) throw new Error("Plan is empty.");
  const header = JSON.parse(lines[0]) as unknown;
  if (!isPlanHeader(header)) {
    throw new Error(
      'Plan does not start with a "piece-plan" v1 header line.',
    );
  }
  const rows = lines.slice(1).map((line, index) => {
    const row = JSON.parse(line) as unknown;
    if (!isPlanRow(row)) {
      throw new Error(`Plan row ${index + 1} is not a valid row object.`);
    }
    return row;
  });
  return { header, rows };
}

/**
 * Derive the rollback of a retarget plan, row by row: the precondition
 * becomes the reference the retarget produced, and the operation restores the
 * retained revision carrying the reference the row recorded. Nothing is
 * re-surveyed or re-supplied. Rows without a retarget op have nothing to roll
 * back and are left out; a plan with no retarget rows at all is refused,
 * because deriving an empty rollback would read as having one.
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
  return { header: { ...plan.header, takenAt }, rows };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
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
  return value.kind === "piece-plan" && value.v === 1 &&
    typeof value.space === "string" && typeof value.takenAt === "string" &&
    isRecord(enumerated) &&
    typeof enumerated.collection === "number" &&
    typeof enumerated.registry === "number" &&
    typeof enumerated.registeredOutside === "number";
}

function isPlanRow(value: unknown): value is PiecePlanRow {
  if (!isRecord(value)) return false;
  if (typeof value.piece !== "string") return false;
  if (!isOptionalString(value.phase)) return false;
  const expect = value.expect;
  if (
    !isRecord(expect) || typeof expect.patternIdentity !== "string" ||
    typeof expect.symbol !== "string" ||
    typeof expect.retained !== "boolean" ||
    !isOptionalString(expect.revisionId)
  ) return false;
  return value.op === undefined || isPieceOp(value.op);
}

function isPieceOp(value: unknown): value is PieceOp {
  if (!isRecord(value)) return false;
  if (
    typeof value.patternIdentity !== "string" ||
    typeof value.symbol !== "string"
  ) return false;
  if (value.kind === "restore") return isOptionalString(value.revisionId);
  if (value.kind !== "retarget") return false;
  const source = value.source;
  return isRecord(source) && typeof source.main === "string" &&
    isOptionalString(source.root) &&
    isOptionalStringArray(source.testPaths) &&
    isOptionalStringArray(source.dataFilePaths) &&
    isOptionalString(source.mainExport) &&
    isOptionalString(value.rev) &&
    (value.allowIncompatible === undefined ||
      typeof value.allowIncompatible === "boolean");
}
