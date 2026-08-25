/**
 * Bulk piece operations from the command line: the thin layer between the
 * survey library in `@commonfabric/piece/ops` and the `cf piece` commands.
 * Flag parsing and printing stay in the command module; this one resolves
 * addresses the way the other piece verbs do, loads the controller, and runs
 * the library, so it is testable without a command surface and the actions
 * above it stay seams.
 */

import { toFileUrl } from "@std/path";

import { resolvePieceAddress } from "@commonfabric/piece";
import {
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
import type { JSONSchema } from "@commonfabric/runner";

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
  /** The module import, injectable so tests supply a fixer without disk. */
  importModule?: (path: string) => Promise<unknown>;
  /** The closure-identity computation, injectable the same way. */
  computeFixerIdentity?: (path: string) => Promise<string>;
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
  const importModule = deps.importModule ??
    ((path: string) => import(toFileUrl(path).href));
  const module = await importModule(request.fixerPath);
  const fixer = (module as { default?: unknown }).default;
  if (typeof fixer !== "function") {
    throw new Error(
      `The fixer module must default-export the fixer function: ` +
        `${request.fixerName}.`,
    );
  }
  const pieces = await (deps.loadPieces ?? loadPieces)(config);
  const resolve = deps.resolvePieceAddress ?? resolvePieceAddress;
  const selector = await resolveSelector(pieces, request.selector, resolve);
  // The identity of the fixer module's authored closure, computed the way a
  // retarget's source identity is — without compiling — so the plan pins
  // the implementation reviewed rather than a path whose file can change.
  const computeIdentity = deps.computeFixerIdentity ??
    (async (path: string) =>
      await programEntryIdentity(
        await resolveLocalSourceProgram(pieces.runtime, { main: path }),
      ));
  const fixerIdentity = await computeIdentity(request.fixerPath);
  const plan = request.planPath === undefined ? undefined : decodePlan(
    await (deps.readTextFile ?? Deno.readTextFile)(request.planPath),
  );
  return await repairPieces(pieces, {
    selector,
    fixer: fixer as Fixer,
    fixerName: request.fixerName,
    fixerIdentity,
    ...(plan === undefined ? {} : { plan }),
    ...(request.apply === true ? { apply: true } : {}),
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
