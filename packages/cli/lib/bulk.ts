/**
 * Bulk piece operations from the command line: the thin layer between the
 * survey library in `@commonfabric/piece/ops` and the `cf piece` commands.
 * Flag parsing and printing stay in the command module; this one resolves
 * addresses the way the other piece verbs do, loads the controller, and runs
 * the library, so it is testable without a command surface and the actions
 * above it stay seams.
 */

import { dirname, join, toFileUrl } from "@std/path";

import { resolvePieceAddress } from "@commonfabric/piece";
import {
  assertPlanRunsFixer,
  decodePlan,
  type Fixer,
  type PiecePin,
  type PiecesController,
  type PieceSelector,
  type PlannedRetarget,
  readPiecePin,
  repairPieces,
  type RepairReport,
  type RetargetSource,
  surveyPieces,
  type SurveyResult,
} from "@commonfabric/piece/ops";
import {
  localRetargetOp,
  programEntryIdentity,
  resolveLocalSourceProgram,
} from "@commonfabric/piece/ops/bulk-local";
import {
  retargetPieces,
  type RetargetReport,
  type RetargetRow,
  type RetargetSessions,
} from "@commonfabric/piece/ops/bulk-retarget";
import type { JSONSchema, RuntimeProgram } from "@commonfabric/runner";

import { loadPieces, type PieceConfig, type SpaceConfig } from "./piece.ts";

export interface SourcePinDependencies {
  loadPieces?: typeof loadPieces;
  resolvePieceAddress?: typeof resolvePieceAddress;
}

/**
 * Read one piece's source pin — reference, current revision when a log
 * exists, and whether the reference's source is verifiably retained — over
 * the API, without running the piece and without pulling its input, result,
 * or link graph. The address resolves the way every other piece verb
 * resolves one (slugs included), and the piece scope is honored. Returns
 * `undefined` for a piece carrying no pattern identity.
 */
export async function readSourcePin(
  config: PieceConfig,
  deps: SourcePinDependencies = {},
): Promise<PiecePin | undefined> {
  const pieces = await (deps.loadPieces ?? loadPieces)(config);
  const piece = await (deps.resolvePieceAddress ?? resolvePieceAddress)(
    pieces,
    config.piece,
  );
  return await readPiecePin(pieces, piece, new Map(), config.pieceScope);
}

/**
 * Resolve a selector's addresses the way every other piece verb resolves
 * one — slugs included — shared by the survey and the repair so the two
 * cannot drift in what an address means.
 */
async function resolveSelector(
  pieces: PiecesController,
  selector: PieceSelector,
  resolve: typeof resolvePieceAddress,
): Promise<PieceSelector> {
  if (selector.kind === "collection") {
    return { ...selector, holder: await resolve(pieces, selector.holder) };
  }
  const resolved: string[] = [];
  for (const entry of selector.pieces) {
    resolved.push(await resolve(pieces, entry));
  }
  return { kind: "list", pieces: resolved };
}

/** What one repair run is asked to do, parsed off the command line. */
export interface RepairRunRequest {
  selector: PieceSelector;
  /** The fixer module's absolute path, for the import. */
  fixerPath: string;
  /** The fixer's name as supplied, recorded in the emitted plan. */
  fixerName: string;
  /** A plan file to execute, row for row, under its preconditions. */
  planPath?: string;
  /** Write the fixer's documents; absent, the run is the dry report. */
  apply?: boolean;
}

export interface RepairRunDependencies {
  loadPieces?: typeof loadPieces;
  resolvePieceAddress?: typeof resolvePieceAddress;
  readTextFile?: (path: string) => Promise<string>;
  /**
   * Resolve the fixer's closure snapshot — the one read of the authored
   * sources that both the identity and the execution come from.
   */
  resolveFixerProgram?: (path: string) => Promise<RuntimeProgram>;
  /** The snapshot's closure identity. */
  programIdentity?: (program: RuntimeProgram) => Promise<string>;
  /** Execute the snapshot — never the path it was read from. */
  importProgram?: (program: RuntimeProgram) => Promise<unknown>;
}

/**
 * Run the repair: import the fixer module, resolve the selector's addresses
 * the way the other piece verbs do, decode the plan file when one drives
 * the run, and hand the library the pieces. Dry by default; the library
 * owns every refusal beyond the fixer module's own shape.
 */
export async function runRepair(
  config: SpaceConfig,
  request: RepairRunRequest,
  deps: RepairRunDependencies = {},
): Promise<RepairReport> {
  const pieces = await (deps.loadPieces ?? loadPieces)(config);
  const resolve = deps.resolvePieceAddress ?? resolvePieceAddress;
  const selector = await resolveSelector(pieces, request.selector, resolve);
  // One closure snapshot serves the whole run: the identity is computed
  // from it and the execution imports it, so nothing on disk can change
  // between the hash and the code — the path is read exactly once. The
  // resolution and the hash are reads, never executions.
  const program = await (deps.resolveFixerProgram ??
    ((path: string) =>
      resolveLocalSourceProgram(pieces.runtime, { main: path })))(
      request.fixerPath,
    );
  const fixerIdentity = await (deps.programIdentity ?? programEntryIdentity)(
    program,
  );
  const plan = request.planPath === undefined ? undefined : decodePlan(
    await (deps.readTextFile ?? Deno.readTextFile)(request.planPath),
  );
  if (plan !== undefined && plan.rows.length > 0) {
    // Every row is held to the run's fixer — operation, name, and pin —
    // before the module is imported: a dynamic import evaluates top-level
    // code, and a plan that cannot run this fixer must not run any of it.
    // The library applies the same gate again behind the seam.
    assertPlanRunsFixer(plan, request.fixerName, fixerIdentity);
  }
  if (plan !== undefined && plan.rows.length === 0) {
    // A zero-row plan pins nothing, so nothing must run under it — the
    // fixer is not even imported. Whether the plan fits this run is the
    // library's selection equality, which refuses it against any nonempty
    // selection; against an empty one the run is a no-op report.
    return await repairPieces(pieces, {
      selector,
      fixer: zeroRowFixer,
      fixerName: request.fixerName,
      fixerIdentity,
      plan,
      ...(request.apply === true ? { apply: true } : {}),
    });
  }
  const module = await (deps.importProgram ?? importProgramSnapshot)(program);
  const fixer = (module as { default?: unknown }).default;
  if (typeof fixer !== "function") {
    throw new Error(
      `The fixer module must default-export the fixer function: ` +
        `${request.fixerName}.`,
    );
  }
  return await repairPieces(pieces, {
    selector,
    fixer: fixer as Fixer,
    fixerName: request.fixerName,
    fixerIdentity,
    ...(plan === undefined ? {} : { plan }),
    ...(request.apply === true ? { apply: true } : {}),
  });
}

/**
 * The fixer a zero-row plan run carries: such a run evaluates no rows, so
 * nothing may call this — and it says so if something does, rather than
 * quietly transforming a document no plan accounted for.
 */
export function zeroRowFixer(): Record<string, unknown> {
  throw new Error("A zero-row plan runs no fixer.");
}

/**
 * Execute a resolved closure snapshot: its files land in a fresh temporary
 * directory — relative imports resolving among themselves exactly as they
 * did on disk — and the entry is imported from there, so the code that runs
 * is the code that was hashed, whatever happened to the original path
 * since. The directory is removed once the module is loaded.
 */
async function importProgramSnapshot(
  program: RuntimeProgram,
): Promise<unknown> {
  const dir = await Deno.makeTempDir({ prefix: "cf-fixer-snapshot" });
  try {
    for (const file of program.files) {
      const target = join(dir, file.name);
      await Deno.mkdir(dirname(target), { recursive: true });
      await Deno.writeTextFile(target, file.contents);
    }
    return await import(toFileUrl(join(dir, program.main)).href);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

/** What one retarget run is asked to do, parsed off the command line. */
export interface RetargetRunRequest {
  /**
   * The plan file this run consumes. The plan is the whole input: it names
   * the pieces, the reference each must still be on, and the source each
   * moves to, so a retarget carries no selection of its own.
   */
  planPath: string;
  /** Write each row's source; absent, the run is the classification alone. */
  apply?: boolean;
  /** Pieces one session serves before it is replaced. */
  groupSize?: number;
  /** Called as each row settles, for reporting as the run proceeds. */
  onRow?: (row: RetargetRow) => void;
}

export interface RetargetRunDependencies {
  loadPieces?: typeof loadPieces;
  readTextFile?: (path: string) => Promise<string>;
  retargetPieces?: typeof retargetPieces;
}

/**
 * Run one teardown step, handing back what it broke instead of throwing it.
 * A session boundary runs every step it has, so an early failure must not
 * take the later ones with it; what each broke is composed afterwards.
 */
async function teardownProblem(
  step: () => Promise<void>,
): Promise<string | undefined> {
  try {
    await step();
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * Run the retarget: decode the plan file and hand the library a session
 * supply that opens a real session per group and disposes its runtime when
 * the group ends, which closes that session's storage — so a group's pieces
 * stop being live at the boundary rather than accumulating across the run.
 *
 * Dry by default. Every refusal is the library's, the plan's space among
 * them: each session answers for the space this command names, and a plan
 * surveyed elsewhere is refused before a single row is read.
 */
export async function runRetarget(
  config: SpaceConfig,
  request: RetargetRunRequest,
  deps: RetargetRunDependencies = {},
): Promise<RetargetReport> {
  const plan = decodePlan(
    await (deps.readTextFile ?? Deno.readTextFile)(request.planPath),
  );
  const load = deps.loadPieces ?? loadPieces;
  const sessions: RetargetSessions = {
    open: () => load(config),
    close: async (pieces) => {
      // Settle first, dispose second. Disposal closes this session's storage
      // without draining it, so a read still in flight would come back
      // against a closed client — a failure belonging to a session already
      // being released, reported over the rows the group just produced.
      //
      // The disposal happens whether or not the settling did. A failed
      // settle is reported as a stop rather than crashing the run, so a
      // session skipped over here would stay open — with its runtime and
      // its storage — for as long as the process lives, which is the whole
      // cost the grouping exists to avoid.
      const settleProblem = await teardownProblem(() => pieces.synced());
      const disposeProblem = await teardownProblem(() => pieces.dispose());
      if (settleProblem === undefined && disposeProblem === undefined) return;
      // The settle failure leads when both fail: it is why this boundary
      // cannot be trusted, and the disposal that followed it is named after
      // it rather than instead of it — the composition the library uses for
      // a wrong-space stop whose session also would not release. Only the
      // message survives, which is all the library reads off this throw.
      throw new Error(
        settleProblem === undefined ? disposeProblem : settleProblem +
          (disposeProblem === undefined
            ? ""
            : ` Its session could not be disposed either: ${disposeProblem}.`),
      );
    },
  };
  return await (deps.retargetPieces ?? retargetPieces)(sessions, {
    plan,
    ...(request.apply === true ? { apply: true } : {}),
    ...(request.groupSize === undefined
      ? {}
      : { groupSize: request.groupSize }),
    ...(request.onRow === undefined ? {} : { onRow: request.onRow }),
  });
}

/** One `--retarget` flag, parsed: which phase, what source, what label. */
export interface PhaseRetarget {
  phase: string;
  source: RetargetSource;
  rev?: string;
}

/** What one survey run is asked to do, parsed off the command line. */
export interface SurveyRunRequest {
  selector: PieceSelector;
  retargets?: readonly PhaseRetarget[];
  /**
   * Stamped onto every retarget row as `op.allowIncompatible` — the plan
   * shows which rows would run with the compatibility gate open, and the
   * apply honors only the row field.
   */
  allowIncompatible?: boolean;
  /** Path to a JSON-schema file each piece's result is read under. */
  validatorPath?: string;
  /** The plan header's `takenAt`; defaults to now. */
  takenAt?: string;
}

export interface SurveyRunDependencies {
  loadPieces?: typeof loadPieces;
  resolvePieceAddress?: typeof resolvePieceAddress;
  readTextFile?: (path: string) => Promise<string>;
}

/**
 * Run the survey: resolve the selector's addresses the way the other piece
 * verbs do, resolve each retarget's source from disk into the reference it
 * produces — the pin the plan carries — then survey the selection and build
 * the plan. Read-only against the space. Two retargets naming one phase are
 * refused before anything loads: the second would silently win.
 */
export async function runSurvey(
  config: SpaceConfig,
  request: SurveyRunRequest,
  deps: SurveyRunDependencies = {},
): Promise<SurveyResult> {
  const phasesSeen = new Set<string>();
  for (const retarget of request.retargets ?? []) {
    if (phasesSeen.has(retarget.phase)) {
      throw new Error(
        `Two retargets name the phase ${retarget.phase}; the second would ` +
          `silently win.`,
      );
    }
    phasesSeen.add(retarget.phase);
  }

  const pieces = await (deps.loadPieces ?? loadPieces)(config);
  const resolve = deps.resolvePieceAddress ?? resolvePieceAddress;
  const selector = await resolveSelector(pieces, request.selector, resolve);

  // A null prototype, so a phase named like an `Object.prototype` member is
  // an own key rather than a write through the prototype chain.
  const operations: Record<string, PlannedRetarget> = Object.create(null);
  for (const retarget of request.retargets ?? []) {
    const { kind: _, ...planned } = await localRetargetOp(pieces.runtime, {
      source: retarget.source,
      ...(retarget.rev === undefined ? {} : { rev: retarget.rev }),
      ...(request.allowIncompatible ? { allowIncompatible: true } : {}),
    });
    operations[retarget.phase] = planned;
  }
  const validator = request.validatorPath === undefined
    ? undefined
    : JSON.parse(
      await (deps.readTextFile ?? Deno.readTextFile)(request.validatorPath),
    ) as JSONSchema;
  return await surveyPieces(pieces, {
    selector,
    ...(Object.keys(operations).length === 0 ? {} : { operations }),
    ...(validator === undefined ? {} : { validator }),
    ...(request.takenAt === undefined ? {} : { takenAt: request.takenAt }),
  });
}
