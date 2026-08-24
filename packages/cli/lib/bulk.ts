/**
 * Bulk piece operations from the command line: the thin layer between the
 * survey library in `@commonfabric/piece/ops` and the `cf piece` commands.
 * Flag parsing and printing stay in the command module; this one loads the
 * controller and runs the library, so it is testable without a command
 * surface and the actions above it stay seams.
 */

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
}

/**
 * Read one piece's source pin — identity, symbol, current revision when a
 * log exists, and whether the identity's source is retained — over the API,
 * without running the piece and without pulling its input, result, or link
 * graph. Returns `undefined` for a piece carrying no pattern identity.
 */
export async function readSourcePin(
  config: PieceConfig,
  deps: SourcePinDependencies = {},
): Promise<PiecePin | undefined> {
  const pieces = await (deps.loadPieces ?? loadPieces)(config);
  return await readPiecePin(pieces, config.piece);
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
  readTextFile?: (path: string) => Promise<string>;
}

/**
 * Run the survey: resolve each retarget's source from disk into the identity
 * it produces — the pin the plan carries — then survey the selection and
 * build the plan. Read-only against the space.
 */
export async function runSurvey(
  config: SpaceConfig,
  request: SurveyRunRequest,
  deps: SurveyRunDependencies = {},
): Promise<SurveyResult> {
  const pieces = await (deps.loadPieces ?? loadPieces)(config);
  const operations: Record<string, PlannedRetarget> = {};
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
    selector: request.selector,
    ...(Object.keys(operations).length === 0 ? {} : { operations }),
    ...(validator === undefined ? {} : { validator }),
    ...(request.takenAt === undefined ? {} : { takenAt: request.takenAt }),
  });
}
