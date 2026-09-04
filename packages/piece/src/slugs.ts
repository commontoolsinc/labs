import type { CellScope, JSONSchema } from "@commonfabric/api";
import type { Cell } from "@commonfabric/runner";
import {
  DEFAULT_CELL_SCOPE,
  entityIdFrom,
  isSlugAddress,
  resolveSlugReference,
  resolveSlugTargetCell as resolveRuntimeSlugTargetCell,
  resolveSlugTargetInPiece,
  slugIdForSpace,
  slugIndexIdForSpace,
  SlugResolutionError,
  validateSlug,
} from "@commonfabric/runner";
import { rawMetaWriteAuthorization } from "@commonfabric/runner/meta-seam";
import { utf8Compare } from "@commonfabric/utils/utf8";
import type { PiecesController } from "./ops/pieces-controller.ts";
import { pieceId } from "./piece-id.ts";

export { SlugResolutionError };

/** The slug index's shape: names to `true`. Written one key at a time, so
 * two clients assigning different slugs merge as two keys rather than two
 * whole maps racing. The names are the whole content — where a name points
 * stays the slug cell's own answer, because a copy of the target here would
 * be a second answer able to disagree with it. */
const SLUG_INDEX_SCHEMA = {
  type: "object",
  additionalProperties: { type: "boolean" },
} as const satisfies JSONSchema;

function slugIndexCell(pieces: PiecesController) {
  return pieces.runtime.getCellFromEntityId(
    pieces.getSpace(),
    entityIdFrom(slugIndexIdForSpace(pieces.getSpace())),
  ).asSchema(SLUG_INDEX_SCHEMA);
}

/**
 * Every slug name the space's index records, in byte order (utf8Compare is
 * the repo comparator).
 *
 * A lower bound with one boundary it cannot detect: the index lists slugs
 * assigned since it existed, so a slug written by an older client still
 * resolves but is not named here. Nothing can find such a slug to report it —
 * a slug cell's id is derived from its name, and that unenumerability is the
 * reason the index exists at all.
 */
export async function listSlugs(pieces: PiecesController): Promise<string[]> {
  const index = await slugIndexCell(pieces).pull();
  if (index === undefined) return [];
  return Object.keys(index).filter((slug) => index[slug] === true)
    .sort(utf8Compare);
}

export async function assignSlug(
  pieces: PiecesController,
  piece: Cell<unknown>,
  slug: string,
): Promise<void> {
  await setSlugLink(pieces, slug, piece, { writeTargetMetadata: true });
}

export async function setSlugLink(
  pieces: PiecesController,
  slug: string,
  source: Cell<unknown>,
  options?: {
    resolveBeforeLinking?: boolean;
    writeTargetMetadata?: boolean;
  },
): Promise<void> {
  const validSlug = validateSlug(slug);
  const target = options?.resolveBeforeLinking
    ? source.resolveAsCell()
    : source;
  await target.sync();
  const metadataTarget = options?.writeTargetMetadata ||
      options?.resolveBeforeLinking
    ? target.resolveAsCell()
    : undefined;
  await metadataTarget?.sync();

  const slugCell = pieces.runtime.getCellFromEntityId(
    pieces.getSpace(),
    entityIdFrom(slugIdForSpace(pieces.getSpace(), validSlug)),
  );

  const indexCell = slugIndexCell(pieces);
  await indexCell.sync();

  const { error } = await pieces.runtime.editWithRetry((tx) => {
    const targetWithTx = target.withTx(tx);
    const slugWithTx = slugCell.withTx(tx);
    const metadataTargetWithTx = metadataTarget?.withTx(tx);

    const metadataTargetLink = metadataTargetWithTx
      ?.getAsNormalizedFullLink();
    if (
      metadataTargetWithTx !== undefined &&
      metadataTargetLink?.path.length === 0
    ) {
      metadataTargetWithTx.setMetaRaw(
        "slug",
        validSlug,
        rawMetaWriteAuthorization,
      );
    }
    slugWithTx.setMetaRaw("slug", validSlug, rawMetaWriteAuthorization);
    slugWithTx.setRawUntyped(
      targetWithTx.getAsWriteRedirectLink({ base: slugWithTx }),
    );
    // The index entry rides the slug's own transaction, so a listing can
    // never see a name without its slug or a slug without its name.
    indexCell.withTx(tx).key(validSlug).set(true);
  });
  if (error) {
    throw new Error(
      `Linking the slug "${validSlug}" failed because storage returned ${error.name}: ${error.message}`,
      { cause: error },
    );
  }

  await pieces.runtime.idle();
  await pieces.synced();
}

/**
 * A piece and a cell path inside it, as an address and the path written
 * after it resolve.
 */
export interface PieceReference {
  /** The piece's id. */
  piece: string;

  /**
   * The scope the piece was reached through, where that narrows the default.
   * Absent otherwise, which leaves whatever scope the caller was addressing
   * under standing.
   */
  scope?: CellScope;

  /** The segments left to address after the piece, a cell path inside it. */
  pathAfter: (string | number)[];
}

/**
 * Where a slug points: the piece whose document holds the target, and the
 * path from that document's root to the target, which is empty when the slug
 * names the piece itself.
 */
export interface SlugTarget {
  /** The id of the piece the target sits in. */
  piece: string;

  /** The path from the piece's root to the target. */
  pathInside: string[];
}

/**
 * Resolves an address and the path written after it to a piece and the cell
 * path inside it. A handle names its piece and the path is returned whole. A
 * slug resolves as the runtime's `resolveSlugReference` does: to the piece it
 * names, with the path returned whole, or through the collection it names to
 * the member the path's first segment selects, with the rest of the path.
 *
 * Fails as `resolveSlugReference` fails, and with `missing-piece-id` when the
 * piece reached has no id.
 */
export async function resolvePieceReference(
  pieces: PiecesController,
  token: string,
  path: readonly (string | number)[],
): Promise<PieceReference> {
  if (!isSlugAddress(token)) {
    return { piece: token, pathAfter: [...path] };
  }
  const target = await resolveSlugReference(
    pieces.runtime,
    pieces.getSpace(),
    token,
    path,
  );
  // Scope selects which instance of an id is addressed, so a member held
  // through a narrowed link is a different cell from the one the id alone
  // names. Reporting it is what keeps a read and a write on that member from
  // landing on the space-wide instance instead.
  const { scope } = target.piece.getAsNormalizedFullLink();
  return {
    piece: pieceIdOrThrow(token, target.piece),
    ...(scope !== undefined && scope !== DEFAULT_CELL_SCOPE && { scope }),
    pathAfter: target.pathAfter,
  };
}

/**
 * Resolves an address to a piece id: a handle as itself, and a slug as
 * {@link resolvePieceReference} resolves it with no path, so a slug that
 * names a collection rather than a piece is refused.
 */
export async function resolvePieceAddress(
  pieces: PiecesController,
  token: string,
): Promise<string> {
  return (await resolvePieceReference(pieces, token, [])).piece;
}

/**
 * Resolves a slug to the piece its target sits in and the path to the target
 * inside it. Fails with `not-piece` when that document is no piece, and with
 * `missing-piece-id` when it has no id.
 */
export async function resolveSlugTarget(
  pieces: PiecesController,
  token: string,
): Promise<SlugTarget> {
  const target = await resolveSlugTargetInPiece(
    pieces.runtime,
    pieces.getSpace(),
    token,
  );
  return {
    piece: pieceIdOrThrow(token, target.piece),
    pathInside: target.pathInside,
  };
}

/**
 * Helper for `resolvePieceReference()` and `resolveSlugTarget()`, which reads
 * a piece's id off its root cell and refuses a cell that has none.
 */
function pieceIdOrThrow(token: string, piece: Cell<unknown>): string {
  const id = pieceId(piece);
  if (!id) {
    throw new SlugResolutionError(
      `Slug "${token}" redirects to a document without a piece id.`,
      "missing-piece-id",
    );
  }
  return id;
}

export async function resolveSlugTargetCell(
  pieces: PiecesController,
  token: string,
): Promise<Cell<unknown>> {
  return await resolveRuntimeSlugTargetCell(
    pieces.runtime,
    pieces.getSpace(),
    token,
  );
}
