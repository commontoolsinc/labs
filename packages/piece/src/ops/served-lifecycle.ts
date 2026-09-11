// The pattern-lifecycle verbs as the serving side runs them
// (docs/features/server-pattern-lifecycle.md): compile a program into a
// space and create a piece from a pattern. Each runs on a space's serving
// runtime inside a wave cycle, so every write it makes seals into that
// cycle's wave and reaches the store as one of the serving loop's own
// commits. That seat rules out the client-side shape of the same operations
// in two places: a transaction the runtime seals is accepted at the seal and
// durable only at the wave commit, so a receipt minted from the transaction
// is refused (`runSyncedWithCommit`), and the storage manager's full
// `synced()` waits on that same commit and would deadlock. The verbs here
// mint their receipts from what they wrote and leave durability to the
// `confirm` read at the bottom, which the serving loop runs once the wave
// has committed. Replacing a piece's source is not among them: a source
// update carries module-update authority the runner publishes only from a
// transaction that commits to storage itself, and refuses from a wave.

import type { PiecesController } from "./pieces-controller.ts";
import { pieceId as pieceIdOf } from "../piece-id.ts";
import { claimSlugInTx, prepareSlugClaim } from "../slugs.ts";
import { prepareSourceClosureVerification } from "../../../runner/src/compilation-cache/cell-cache.ts";
import {
  type Cell,
  compileAndSavePattern,
  entityIdFrom,
  getPatternIdentityRef,
  type MemorySpace,
  type Pattern,
  resolveSpaceRootPattern,
  type Runtime,
  type RuntimeProgram,
} from "@commonfabric/runner";
import { pieceListSchema } from "@commonfabric/runner/schemas";

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
  /** Setup refused the pattern or the argument. */
  | "setup-failed"
  /** The requested slug already names something, and `force` was not set. */
  | "slug-taken"
  /** The space has no root to register the piece with. */
  | "no-space-root";

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

  /** A name for the new piece, claimed in the creation transaction. */
  slug?: string;

  /** Take `slug` even when it already names something. */
  force?: boolean;

  /** Add the piece to the space root's registry, in the same transaction. */
  register?: boolean;

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

  /** The name the piece was created under, when one was asked for. */
  slug?: string;
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
 * Create a piece from the requested pattern in one transaction: the result
 * document with its pattern metadata and argument, the first source
 * revision, the registry entry when asked for, and the slug when asked for
 * — a name already taken refuses the whole creation unless `force` is set.
 * The piece is set up here and never started here: a graph instantiated on
 * the serving runtime before anything demands it is not live, so its first
 * run would not happen and a later demand would find it registered and
 * skip the load that runs it. The caller names the new piece's root as the
 * verb's demand instead, and the serving loop loads and derives it once
 * the creation has committed.
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
  let registry: Cell<Cell<unknown>[]> | undefined;
  if (request.register === true) {
    const root = await resolveSpaceRootPattern(runtime, space);
    if (root === undefined) {
      throw new ServedLifecycleRefusal(
        "no-space-root",
        "the space has no root pattern to register the piece with",
      );
    }
    registry = root.asSchema({
      type: "object",
      properties: { pieceRegistry: pieceListSchema },
    }).key("pieceRegistry") as Cell<Cell<unknown>[]>;
    await registry.sync();
  }
  const slugClaim = request.slug === undefined
    ? undefined
    : await prepareSlugClaim(pieces, request.slug, piece, {
      writeTargetMetadata: true,
    });
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
    registry?.withTx(tx).addUnique(piece);
    if (slugClaim !== undefined) {
      const refusal = claimSlugInTx(pieces, slugClaim, tx, {
        ...(request.force === undefined ? {} : { force: request.force }),
      });
      if (refusal !== undefined) {
        throw new ServedLifecycleRefusal(
          "slug-taken",
          `Slug "${slugClaim.validSlug}" already points at ` +
            `${refusal.held ?? "nothing"}, so assigning it would take that ` +
            "address from whoever holds it. Pass `force` to take it anyway; " +
            "nothing was created.",
        );
      }
    }
  });
  if (outcome.error !== undefined) {
    // A setup that threw is reported through the aborted transaction's
    // `reason`; a storage rejection is the error itself.
    const cause =
      "reason" in outcome.error && outcome.error.reason !== undefined
        ? outcome.error.reason
        : outcome.error;
    if (cause instanceof ServedLifecycleRefusal) throw cause;
    throw new ServedLifecycleRefusal("setup-failed", messageOf(cause), {
      cause,
    });
  }
  const pieceId = pieceIdOf(piece);
  if (pieceId === undefined) {
    throw new Error("the new piece has no entity id");
  }
  return {
    pieceId,
    pattern: ref,
    ...(slugClaim === undefined ? {} : { slug: slugClaim.validSlug }),
  };
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
