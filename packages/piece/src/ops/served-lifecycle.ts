// The pattern-lifecycle verbs as the serving side runs them
// (docs/features/server-pattern-lifecycle.md): compile a program into a
// space, create a piece from a pattern, and replace a piece's source. Each
// runs on a space's serving runtime inside a wave cycle, so every write it
// makes seals into that cycle's wave and reaches the store as one of the
// serving loop's own commits. That seat rules out the client-side shape of
// the same operations in two places: a transaction the runtime seals is
// accepted at the seal and durable only at the wave commit, so a receipt
// minted from the transaction is refused (`runSyncedWithCommit`), and the
// storage manager's full `synced()` waits on that same commit and would
// deadlock. The verbs here mint their receipts from the transition they
// applied and leave durability to the `confirm` reads at the bottom, which
// the serving loop runs once the wave has committed.

import {
  assertSuppliedLinkSchemasCompatible,
  hasPieceSourceCompatibilityIssues,
  type PatternCompatibilityReport,
  type PatternUpdateReceipt,
  pieceSourceCompatibilityMessage,
  pieceSourceCompatibilityReview,
  pieceSourceTransition,
  suppliedLinks,
} from "./piece-controller.ts";
import type { PiecesController } from "./pieces-controller.ts";
import { pieceId as pieceIdOf } from "../piece-id.ts";
import { assertPatternSchemasBackwardCompatible } from "../schema-compatibility.ts";
import { prepareSourceClosureVerification } from "../../../runner/src/compilation-cache/cell-cache.ts";
import {
  type Cell,
  compileAndSavePattern,
  entityIdFrom,
  getPatternIdentityRef,
  getPieceSourceRevisions,
  getPieceSourceSnapshot,
  type MemorySpace,
  type Pattern,
  PIECE_SOURCE_MOVED,
  type PieceSourceSnapshot,
  type PieceSourceTransitionBaseline,
  preparePieceSourceTransitionBaseline,
  type Runtime,
  type RuntimeProgram,
} from "@commonfabric/runner";

/** A content-addressed pattern pointer: the closure and the export run. */
export type ServedPatternRef = { identity: string; symbol: string };

/**
 * Where a served verb takes its pattern from: a program the serving side
 * compiles, or a pattern the space already holds by identity — the result
 * of an earlier upload.
 */
export type ServedPatternSource =
  | { program: RuntimeProgram; pattern?: undefined }
  | { pattern: ServedPatternRef; program?: undefined };

/**
 * Why a served verb refused. Each code names one condition a caller can
 * act on; anything else the verbs throw is a failure of the serving side.
 */
export type ServedLifecycleRefusalCode =
  /** The program did not compile. */
  | "compile-failed"
  /** The named pattern is not held by the space, or cannot load. */
  | "pattern-not-found"
  /** The named piece has no pattern, so is not a piece. */
  | "piece-not-found"
  /** The candidate cannot replace the piece's source. */
  | "incompatible"
  /** The piece's source moved between the verb's read and its write. */
  | "source-moved"
  /** Setup refused the pattern or the argument. */
  | "setup-failed";

/** A served verb's refusal, carrying the code the wire reports. */
export class ServedLifecycleRefusal extends Error {
  readonly #code: ServedLifecycleRefusalCode;

  constructor(
    code: ServedLifecycleRefusalCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "ServedLifecycleRefusal";
    this.#code = code;
  }

  get code(): ServedLifecycleRefusalCode {
    return this.#code;
  }
}

/** What `instantiate` asks for. */
export interface ServedInstantiateRequest {
  source: ServedPatternSource;

  /** The new piece's argument; absent means the pattern's defaults. */
  argument?: object;

  /** Repository locator stored with the piece's source. */
  repository?: string;

  /**
   * The principal the verb acts for. The creation transaction carries this
   * principal's trust snapshot, so a label the setup mints attributes to
   * the requester rather than to the serving identity.
   */
  actingUser: string;
}

/** What `instantiate` hands back. */
export interface ServedInstantiateReceipt {
  pieceId: string;
  pattern: ServedPatternRef;
}

/** What `setsrc` asks for. */
export interface ServedSourceRequest {
  source: ServedPatternSource;
  repository?: string;

  /** Replace the source without the schema and retained-link proofs. */
  dangerouslyAllowIncompatibleSchema?: boolean;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (
    typeof error === "object" && error !== null && "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }
  return String(error);
}

/**
 * Compile `program` into the space and persist its closure, so a later
 * verb — here or on another runtime — can take the pattern by identity.
 */
export async function servedUploadPattern(
  pieces: PiecesController,
  program: RuntimeProgram,
  options: { previousEntryIdentity?: string } = {},
): Promise<{ pattern: Pattern; ref: ServedPatternRef }> {
  const runtime = pieces.runtime;
  let pattern: Pattern;
  try {
    pattern = await compileAndSavePattern(runtime, program, {
      space: pieces.getSpace(),
      ...(options.previousEntryIdentity === undefined
        ? {}
        : { previousEntryIdentity: options.previousEntryIdentity }),
    });
  } catch (error) {
    throw new ServedLifecycleRefusal("compile-failed", messageOf(error), {
      cause: error,
    });
  }
  const ref = runtime.patternManager.getArtifactEntryRef(pattern);
  if (ref === undefined) {
    throw new Error("the compiled source has no pattern identity");
  }
  return { pattern, ref };
}

async function resolveServedPattern(
  pieces: PiecesController,
  source: ServedPatternSource,
  options: { previousEntryIdentity?: string } = {},
): Promise<{ pattern: Pattern; ref: ServedPatternRef }> {
  if (source.program !== undefined) {
    return await servedUploadPattern(pieces, source.program, options);
  }
  const ref = source.pattern;
  const pattern = await pieces.runtime.patternManager.loadPatternByIdentity(
    ref.identity,
    ref.symbol,
    pieces.getSpace(),
  );
  if (!pattern) {
    throw new ServedLifecycleRefusal(
      "pattern-not-found",
      `pattern ${ref.identity}#${ref.symbol} is not held by the space`,
    );
  }
  return { pattern, ref };
}

/**
 * Create a piece from the requested pattern: the result document with its
 * pattern metadata and argument, and the first source revision. The piece
 * is set up here and never started here: a graph instantiated on the
 * serving runtime before anything demands it is not live, so its first run
 * would not happen and a later demand would find it registered and skip
 * the load that runs it. The caller names the new piece's root as the
 * verb's demand instead, and the serving loop loads and derives it once
 * the creation has committed, before the verb's receipt returns.
 */
export async function servedInstantiatePiece(
  pieces: PiecesController,
  request: ServedInstantiateRequest,
): Promise<ServedInstantiateReceipt> {
  const runtime = pieces.runtime;
  const space = pieces.getSpace();
  const { pattern, ref } = await resolveServedPattern(pieces, request.source);
  await runtime.idle();
  const piece = runtime.getCell(
    space,
    { space, random: crypto.randomUUID() },
    pattern.resultSchema,
  );
  // Setup verifies the source closure behind a content-addressed entry
  // ref synchronously, so the parser it needs is loaded ahead of it.
  await prepareSourceClosureVerification();
  const address = piece.getAsNormalizedFullLink().id;
  const outcome = await runtime.editWithRetry((tx) => {
    // Per attempt: the trust snapshot governs the reads that follow it,
    // and a retry runs on a fresh transaction.
    runtime.stampServerRun(tx, {
      actionId: `pattern-lifecycle/instantiate/${address}`,
      kind: "bookkeeping",
    });
    tx.setCfcTrustSnapshot(
      runtime.trustSnapshotForPrincipal(request.actingUser),
    );
    // With a transaction supplied, setup runs to completion before it
    // returns and leaves the commit to this transaction.
    void runtime.setup(tx, pattern, request.argument ?? {}, piece, {
      ...(request.repository === undefined
        ? {}
        : { patternRepository: request.repository }),
      initializePieceSourceHistory: true,
    });
  });
  if (outcome.error !== undefined) {
    // A setup that threw is reported through the aborted transaction's
    // `reason`; a storage rejection is the error itself.
    const cause =
      "reason" in outcome.error && outcome.error.reason !== undefined
        ? outcome.error.reason
        : outcome.error;
    throw new ServedLifecycleRefusal("setup-failed", messageOf(cause), {
      cause,
    });
  }
  const pieceId = pieceIdOf(piece);
  if (pieceId === undefined) {
    throw new Error("the new piece has no entity id");
  }
  return { pieceId, pattern: ref };
}

/**
 * The durability read behind {@link servedInstantiatePiece}: the piece
 * document holds the pattern pointer the verb wrote.
 */
export async function confirmServedInstantiate(
  runtime: Runtime,
  space: MemorySpace,
  receipt: ServedInstantiateReceipt,
): Promise<void> {
  const piece = runtime.getCellFromEntityId(
    space,
    entityIdFrom(receipt.pieceId),
  );
  await piece.sync();
  const stored = getPatternIdentityRef(piece);
  if (
    stored === undefined ||
    stored.identity !== receipt.pattern.identity ||
    stored.symbol !== receipt.pattern.symbol
  ) {
    throw new Error(
      `piece ${receipt.pieceId} does not hold pattern ` +
        `${receipt.pattern.identity}#${receipt.pattern.symbol}: the ` +
        "creation did not commit",
    );
  }
}

/** The entity id a piece id names; a malformed id is a piece not held. */
function pieceEntityId(pieceId: string): ReturnType<typeof entityIdFrom> {
  try {
    return entityIdFrom(pieceId);
  } catch (error) {
    throw new ServedLifecycleRefusal(
      "piece-not-found",
      `piece ${pieceId} is not a piece id: ${messageOf(error)}`,
      { cause: error },
    );
  }
}

type PreparedServedSourceChange = {
  cell: Cell<unknown>;
  previousPattern: Pattern | undefined;
  previousRef: ServedPatternRef;
  expected: PieceSourceSnapshot;
  baseline: PieceSourceTransitionBaseline;
  candidate: Pattern;
  candidateRef: ServedPatternRef;
};

/**
 * Everything both source verbs need before they diverge: the piece's
 * current pattern and source snapshot, the transition's baseline, and the
 * compiled candidate.
 *
 * `loadCurrentLeniently` degrades a current pattern that fails to load to
 * its stored identity, which is what the apply does under
 * `dangerouslyAllowIncompatibleSchema`: the loaded pattern feeds only the
 * checks that flag waives, and a piece whose current pattern cannot load
 * is exactly the piece a source replacement rescues.
 */
async function prepareServedSourceChange(
  pieces: PiecesController,
  pieceId: string,
  source: ServedPatternSource,
  loadCurrentLeniently: boolean,
): Promise<PreparedServedSourceChange> {
  const runtime = pieces.runtime;
  const space = pieces.getSpace();
  const cell = runtime.getCellFromEntityId(space, pieceEntityId(pieceId));
  await cell.sync();
  const previousRef = getPatternIdentityRef(cell);
  if (previousRef === undefined) {
    throw new ServedLifecycleRefusal(
      "piece-not-found",
      `piece ${pieceId} has no pattern identity`,
    );
  }
  let previousPattern: Pattern | undefined;
  try {
    previousPattern = await runtime.patternManager.loadPatternByIdentity(
      previousRef.identity,
      previousRef.symbol,
      space,
    );
    if (!previousPattern) {
      throw new Error(
        `could not load pattern ${previousRef.identity}#${previousRef.symbol}`,
      );
    }
  } catch (error) {
    if (!loadCurrentLeniently) {
      throw new ServedLifecycleRefusal(
        "pattern-not-found",
        messageOf(error),
        { cause: error },
      );
    }
    previousPattern = undefined;
  }
  const expected = getPieceSourceSnapshot(
    cell,
    runtime.runner.sessionPatternPointerFor(cell),
  );
  if (expected === undefined) {
    throw new ServedLifecycleRefusal(
      "piece-not-found",
      `piece ${pieceId} is missing its source state`,
    );
  }
  const baseline = await preparePieceSourceTransitionBaseline(
    runtime,
    cell,
    expected,
    expected.revisionId === null && expected.origin === null
      ? { allowUnavailable: true }
      : {},
  );
  const { pattern: candidate, ref: candidateRef } = await resolveServedPattern(
    pieces,
    source,
    baseline.kind === "retain"
      ? { previousEntryIdentity: previousRef.identity }
      : {},
  );
  return {
    cell,
    previousPattern,
    previousRef,
    expected,
    baseline,
    candidate,
    candidateRef,
  };
}

/**
 * Report whether the requested source could replace the piece's current
 * one, without touching the piece. The candidate is compiled and persisted
 * into the space, which is the same idempotent write the apply makes.
 */
export async function servedCheckPieceSource(
  pieces: PiecesController,
  pieceId: string,
  source: ServedPatternSource,
): Promise<PatternCompatibilityReport> {
  const prepared = await prepareServedSourceChange(
    pieces,
    pieceId,
    source,
    false,
  );
  const review = await pieceSourceCompatibilityReview(
    prepared.previousPattern!,
    prepared.candidate,
    prepared.cell,
    pieces,
  );
  const compatible = !hasPieceSourceCompatibilityIssues(review.issues);
  return {
    compatible,
    issues: review.issues,
    candidate: prepared.candidateRef,
    ...(compatible
      ? {}
      : { message: pieceSourceCompatibilityMessage(review.issues) }),
  };
}

function sourceApplyRefusal(error: unknown): ServedLifecycleRefusal {
  const message = messageOf(error);
  if (
    message.includes(PIECE_SOURCE_MOVED) ||
    message.includes("piece pattern changed while the source update")
  ) {
    return new ServedLifecycleRefusal("source-moved", message, {
      cause: error,
    });
  }
  return new ServedLifecycleRefusal("setup-failed", message, { cause: error });
}

/**
 * Replace the piece's source with the requested pattern, detaching the
 * piece from any origin it followed, and append the source revision.
 *
 * The receipt names what the setup transaction wrote. A failure after the
 * setup sealed — in the dependency sync or the start that follows it —
 * is reported on the receipt's `refresh`, since it does not undo the
 * source update; a failure before it is a refusal.
 */
export async function servedSetPieceSource(
  pieces: PiecesController,
  pieceId: string,
  request: ServedSourceRequest,
): Promise<PatternUpdateReceipt> {
  const runtime = pieces.runtime;
  const lenient = request.dangerouslyAllowIncompatibleSchema === true;
  const prepared = await prepareServedSourceChange(
    pieces,
    pieceId,
    request.source,
    lenient,
  );
  const { cell, previousPattern, previousRef, expected, baseline } = prepared;
  const { candidate, candidateRef } = prepared;
  if (!lenient) {
    try {
      // Reached with the current pattern loaded: a load failure without
      // the flag refused above.
      assertPatternSchemasBackwardCompatible(previousPattern!, candidate);
    } catch (error) {
      throw new ServedLifecycleRefusal("incompatible", messageOf(error), {
        cause: error,
      });
    }
  }
  // A null origin: the piece detaches. The requester chose what it runs,
  // and an origin left in place could later repoint it elsewhere.
  const transition = pieceSourceTransition(expected, "edit", null, baseline);
  const receipt = (
    refresh: PatternUpdateReceipt["refresh"],
  ): PatternUpdateReceipt => ({
    status: "committed",
    ref: candidateRef,
    revisionId: transition.revisionId,
    detachedOrigin: expected.origin,
    refresh,
  });
  try {
    await runtime.runSynced(cell, candidate, undefined, {
      expectedPatternIdentity: previousRef,
      ...(request.repository === undefined
        ? {}
        : { patternRepository: request.repository }),
      pieceSourceTransition: transition,
      validateArgumentLinks: lenient
        ? undefined
        : (argumentCell, argumentSchema) =>
          assertSuppliedLinkSchemasCompatible(
            suppliedLinks(argumentCell.getRaw()),
            argumentSchema,
            argumentCell,
            pieces,
            {
              priorArgumentSchema: previousPattern!.argumentSchema,
              // `applySetupState` rewrites the argument from `getRaw()`, so
              // every retained link's envelope is written back unchanged.
              linksPreservedVerbatim: true,
            },
          ),
    });
  } catch (error) {
    // The setup sealed when the piece already names the candidate; what
    // failed then is the refresh, which the receipt reports.
    const stored = getPatternIdentityRef(cell);
    if (
      stored !== undefined && stored.identity === candidateRef.identity &&
      stored.symbol === candidateRef.symbol
    ) {
      return receipt({ status: "failed", warning: messageOf(error) });
    }
    throw sourceApplyRefusal(error);
  }
  return receipt({ status: "completed" });
}

/**
 * The durability read behind {@link servedSetPieceSource}: the piece
 * names the candidate and its history holds the revision.
 */
export async function confirmServedSourceUpdate(
  runtime: Runtime,
  space: MemorySpace,
  pieceId: string,
  receipt: PatternUpdateReceipt,
): Promise<void> {
  const cell = runtime.getCellFromEntityId(space, entityIdFrom(pieceId));
  await cell.sync();
  const stored = getPatternIdentityRef(cell);
  const revisionHeld = getPieceSourceRevisions(cell).some((revision) =>
    revision.revisionId === receipt.revisionId
  );
  if (
    stored === undefined || stored.identity !== receipt.ref.identity ||
    stored.symbol !== receipt.ref.symbol || !revisionHeld
  ) {
    throw new Error(
      `piece ${pieceId} does not hold source revision ` +
        `${receipt.revisionId} of ${receipt.ref.identity}#` +
        `${receipt.ref.symbol}: the source update did not commit`,
    );
  }
}
