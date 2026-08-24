/**
 * Bulk piece operations from the command line: the thin layer between the
 * survey library in `@commonfabric/piece/ops` and the `cf piece` commands.
 * Flag parsing and printing stay in the command module; this one resolves
 * addresses the way the other piece verbs do, loads the controller, and runs
 * the library, so it is testable without a command surface and the actions
 * above it stay seams.
 */

import { resolvePieceAddress } from "@commonfabric/piece";
import {
  type PiecePin,
  type PieceSelector,
  type PlannedRetarget,
  readPiecePin,
  type RetargetSource,
  surveyPieces,
  type SurveyResult,
} from "@commonfabric/piece/ops";
import { localRetargetOp } from "@commonfabric/piece/ops/bulk-local";
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
  let selector = request.selector;
  if (selector.kind === "collection") {
    selector = { ...selector, holder: await resolve(pieces, selector.holder) };
  } else {
    const resolved: string[] = [];
    for (const entry of selector.pieces) {
      resolved.push(await resolve(pieces, entry));
    }
    selector = { kind: "list", pieces: resolved };
  }

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
  if (
    validator !== undefined && typeof validator !== "boolean" &&
    (typeof validator !== "object" || validator === null ||
      Array.isArray(validator))
  ) {
    // `null` is not `undefined`, and shaping by it validates nothing — a
    // validator that cannot fail would report a clean board it never read.
    throw new Error(
      "The validator file must hold a JSON schema: an object or a boolean.",
    );
  }
  return await surveyPieces(pieces, {
    selector,
    ...(Object.keys(operations).length === 0 ? {} : { operations }),
    ...(validator === undefined ? {} : { validator }),
    ...(request.takenAt === undefined ? {} : { takenAt: request.takenAt }),
  });
}
