/**
 * The read-only survey under every bulk piece operation: enumerate a set of
 * pieces, read what each one currently is, cross-check the selection, and
 * emit the plan the write stages consume.
 *
 * The survey answers "what does each of these pieces currently look like?"
 * with one cheap read per piece — the pattern identity, the current source
 * revision when the piece keeps a log, and whether the identity's source is
 * still retained in the space — and never runs a piece. Selection reads the
 * holder's own collection and is cross-checked against the piece registry by
 * containment: the registry is expected to be the smaller set, so the failure
 * worth stopping on is a registered in-scope piece the collection lacks. The
 * design is [docs/plans/piece-bulk-operations.md](../../../../docs/plans/piece-bulk-operations.md).
 */

import {
  type Cell,
  getPatternIdentityRef,
  type JSONSchema,
  sourceDocKey,
} from "@commonfabric/runner";
import { validateSchemaValue } from "@commonfabric/runner/cfc";

import { pieceId } from "../piece-id.ts";
import type {
  PieceExpect,
  PiecePlan,
  PiecePlanRow,
  RetargetOp,
} from "./bulk-plan.ts";
import { readPieceSourceMetadata } from "./piece-origin.ts";
import type { PiecesController } from "./pieces-controller.ts";

/**
 * Names the pieces a survey covers.
 *
 * A `collection` selector names a holder piece and the path to the collection
 * inside it, and emits the members followed by the holder as the last row —
 * children first, holder last is the selector's property, not a step the
 * operator performs. `side` picks the document holding the collection and
 * defaults to the stored input. A `list` selector names pieces outright, for
 * a hand-picked set or the one orphan a containment check found.
 */
export type PieceSelector =
  | {
    kind: "collection";
    /** The holder piece's address. */
    holder: string;
    /** The path to the collection within the chosen document. */
    path: readonly (string | number)[];
    side?: "input" | "result";
  }
  | { kind: "list"; pieces: readonly string[] };

/** One selected piece, with the phase label its plan row will carry. */
export interface SelectedPiece {
  piece: string;
  phase: string;
}

/** The phase label a collection selector puts on its holder's row. */
export const HOLDER_PHASE = "holder";

/** The phase label a list selector puts on every row. */
export const LIST_PHASE = "list";

/** A retarget to stamp onto every row of one phase, identity already computed. */
export type PlannedRetarget = Omit<RetargetOp, "kind">;

/** What {@link surveyPieces} takes beyond the controller. */
export interface SurveyOptions {
  selector: PieceSelector;
  /**
   * Retargets to stamp onto rows, keyed by phase — a collection selector
   * labels members with the collection path and the holder with
   * {@link HOLDER_PHASE}. Rows of an unlisted phase get no `op` and the plan
   * stays a pre-state record for them.
   */
  operations?: Readonly<Record<string, PlannedRetarget>>;
  /**
   * A schema to read each piece's result under — a holder's demanded schema
   * is the canonical one. Pieces whose result cannot materialize under it
   * are named in the result: the only bulk answer to "which member breaks
   * the holder's read?", since the holder's own read fails as a whole. The
   * check uses read semantics, so a field a schema default rescues passes
   * here exactly as it would for the holder.
   */
  validator?: JSONSchema;
  /** The header's `takenAt`; defaults to now. A parameter so tests can pin it. */
  takenAt?: string;
}

/** One piece the survey could not read into a plan row. */
export interface SurveyProblem {
  piece: string;
  problem: string;
}

/** A registered in-scope piece the selection does not cover. */
export interface RegisteredOutside {
  piece: string;
  patternIdentity: string;
}

/** How many selected pieces sit on one identity within one phase. */
export interface TallyEntry {
  phase: string;
  patternIdentity: string;
  count: number;
}

/** Everything a survey reports beyond the plan itself. */
export interface SurveyResult {
  plan: PiecePlan;
  /** Identity counts by phase — "do these pieces all agree?" at a glance. */
  tally: readonly TallyEntry[];
  /** Registered in-scope pieces the selection lacks. Any entry is a stop. */
  outside: readonly RegisteredOutside[];
  /** Selected pieces that could not be read into a row. Any entry is a stop. */
  problems: readonly SurveyProblem[];
  /** Pieces whose result fails the supplied validator, with the failure. */
  validatorFailures: readonly SurveyProblem[];
  /**
   * Whether the plan accounts for everything: no unreadable piece and no
   * registered in-scope piece outside the selection. A write stage must
   * refuse a plan surveyed incomplete; validator failures are a finding, not
   * an incompleteness.
   */
  complete: boolean;
}

/**
 * Resolve a selector to pieces in execution order. Collection members come
 * back in stored order with the holder last; a member slot that does not
 * hold a piece is an error naming its position, because a silently skipped
 * member is the failure the survey exists to prevent.
 */
export async function selectPieces(
  pieces: PiecesController,
  selector: PieceSelector,
): Promise<SelectedPiece[]> {
  if (selector.kind === "list") {
    return selector.pieces.map((piece) => ({ piece, phase: LIST_PHASE }));
  }
  const holder = await pieces.get(selector.holder, false);
  const io = selector.side === "result" ? holder.result : holder.input;
  const root = await io.getCell();
  const collection = root.key(...selector.path).asSchema(
    MEMBER_LIST_SCHEMA,
  ) as Cell<Cell<unknown>[]>;
  const members = await collection.pull() ?? [];
  const phase = String(selector.path.at(-1) ?? "members");
  const selected = members.map((member, index) => {
    const id = pieceId(member);
    if (id === undefined) {
      throw new Error(
        `Collection member ${index} at ${
          selector.path.join("/")
        } does not hold a piece link.`,
      );
    }
    return { piece: id, phase };
  });
  selected.push({ piece: holder.id, phase: HOLDER_PHASE });
  return selected;
}

/**
 * Survey the selected pieces and build the plan. Read-only: one identity
 * read per piece, one retained-source probe per distinct identity, and one
 * pass over the registry for the containment check. Every read is live —
 * nothing is served from a snapshot — so re-running after a change reflects
 * the change.
 */
export async function surveyPieces(
  pieces: PiecesController,
  options: SurveyOptions,
): Promise<SurveyResult> {
  const selected = await selectPieces(pieces, options.selector);
  const retainedByIdentity = new Map<string, boolean>();
  const rows: PiecePlanRow[] = [];
  const problems: SurveyProblem[] = [];
  const validatorFailures: SurveyProblem[] = [];

  for (const { piece, phase } of selected) {
    const controller = await pieces.get(piece, false);
    const state = readPieceSourceMetadata(
      pieces.runtime,
      controller.getCell(),
    );
    if (state.pattern === undefined) {
      problems.push({
        piece: controller.id,
        problem: "carries no pattern identity",
      });
      continue;
    }
    const expect: PieceExpect = {
      patternIdentity: state.pattern.identity,
      retained: await isSourceRetained(
        pieces,
        state.pattern.identity,
        retainedByIdentity,
      ),
      ...(state.currentRevisionId === undefined
        ? {}
        : { revisionId: state.currentRevisionId }),
    };
    const operation = options.operations?.[phase];
    rows.push({
      piece: controller.id,
      phase,
      expect,
      ...(operation === undefined
        ? {}
        : { op: { kind: "retarget", ...operation } }),
    });
    if (options.validator !== undefined) {
      const failure = await validateResult(controller, options.validator);
      if (failure !== undefined) {
        validatorFailures.push({ piece: controller.id, problem: failure });
      }
    }
  }

  const outside = await registeredOutsideSelection(pieces, rows);
  const memberCount = options.selector.kind === "collection"
    ? Math.max(selected.length - 1, 0)
    : selected.length;
  const plan: PiecePlan = {
    header: {
      kind: "piece-plan",
      v: 1,
      space: pieces.getSpace(),
      takenAt: options.takenAt ?? new Date().toISOString(),
      enumerated: {
        collection: memberCount,
        registry: (await pieces.getRegisteredPieces()).length,
        registeredOutside: outside.length,
      },
    },
    rows,
  };
  return {
    plan,
    tally: tallyRows(rows),
    outside,
    problems,
    validatorFailures,
    complete: problems.length === 0 && outside.length === 0,
  };
}

/** Members come back as cells, so no element's value is read. */
const MEMBER_LIST_SCHEMA = {
  type: "array",
  items: { type: "unknown", asCell: ["cell"] },
  default: [],
} as const satisfies JSONSchema;

/**
 * Whether `identity`'s source closure is retained in the space — one
 * existence probe of the `pattern:<identity>` document, cached per identity.
 * Existence is the right granularity: it answers "does a restore target
 * exist?" without verifying or materializing the closure.
 */
async function isSourceRetained(
  pieces: PiecesController,
  identity: string,
  cache: Map<string, boolean>,
): Promise<boolean> {
  const cached = cache.get(identity);
  if (cached !== undefined) return cached;
  const doc = pieces.runtime.getCell(
    pieces.getSpace(),
    sourceDocKey(identity),
  );
  await doc.sync();
  const retained = doc.getRaw() !== undefined;
  cache.set(identity, retained);
  return retained;
}

/**
 * The containment check: every registered piece on an in-scope identity must
 * be in the selection. One that is not is either a member the collection
 * read dropped or a piece of the same kind living outside the holder, and
 * either way the plan does not account for it.
 */
async function registeredOutsideSelection(
  pieces: PiecesController,
  rows: readonly PiecePlanRow[],
): Promise<RegisteredOutside[]> {
  const inScope = new Set(rows.map((row) => row.expect.patternIdentity));
  const selectedIds = new Set(rows.map((row) => row.piece));
  const outside: RegisteredOutside[] = [];
  for (const registered of await pieces.getRegisteredPieces()) {
    if (selectedIds.has(registered.id)) continue;
    const synced = await pieces.get(registered.id, false);
    const ref = getPatternIdentityRef(synced.getCell());
    if (ref !== undefined && inScope.has(ref.identity)) {
      outside.push({ piece: synced.id, patternIdentity: ref.identity });
    }
  }
  return outside;
}

/**
 * Read one piece's result under the validator schema, returning what failed
 * and `undefined` when the piece passes. A demanding read does not throw — it
 * comes back `undefined` when the schema's required values cannot resolve —
 * so failure is a value that did not materialize while stored data is
 * present and the schema rejects `undefined`. That mirrors a holder's read:
 * a field rescued by its schema default passes here exactly as it would
 * there.
 */
async function validateResult(
  controller: { result: { getCell(): Promise<Cell<unknown>> } },
  validator: JSONSchema,
): Promise<string | undefined> {
  const result = await controller.result.getCell();
  const shaped = result.asSchema(validator);
  await shaped.pull();
  if (shaped.get() !== undefined) return undefined;
  if (result.getRaw() === undefined) return "has no stored result";
  if (validateSchemaValue(validator, undefined) === undefined) {
    return undefined;
  }
  return "stored result is present, but the schema could not resolve all " +
    "required values";
}

function tallyRows(rows: readonly PiecePlanRow[]): TallyEntry[] {
  const counts = new Map<string, TallyEntry>();
  for (const row of rows) {
    const phase = row.phase ?? "";
    const key = `${phase} ${row.expect.patternIdentity}`;
    const entry = counts.get(key);
    if (entry === undefined) {
      counts.set(key, {
        phase,
        patternIdentity: row.expect.patternIdentity,
        count: 1,
      });
    } else entry.count++;
  }
  return [...counts.values()];
}
