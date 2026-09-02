import type { JSONSchema } from "@commonfabric/api";
import type { Cell } from "@commonfabric/runner";
import { utf8Compare } from "@commonfabric/utils/utf8";
import {
  entityIdFrom,
  getPatternIdentityRef,
  isSlugAddress,
  resolveSlugTargetCell as resolveRuntimeSlugTargetCell,
  slugIdForSpace,
  slugIndexIdForSpace,
  SlugResolutionError,
  validateSlug,
} from "@commonfabric/runner";
import { pieceId } from "./piece-id.ts";
import type { PiecesController } from "./ops/pieces-controller.ts";
import { rawMetaWriteAuthorization } from "@commonfabric/runner/meta-seam";

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

export async function resolvePieceAddress(
  pieces: PiecesController,
  token: string,
): Promise<string> {
  if (!isSlugAddress(token)) {
    return token;
  }

  const target = await resolveSlugTargetCell(pieces, token);
  // A KEYLESS piece carries no durable pointer (the never-durable
  // contract; L3(a), RULED 2026-08-27): in the session that set it up the
  // runner's session pointer vouches for it. A fresh session cannot vouch
  // for a keyless target — which matches the contract: nothing keyless is
  // loadable there anyway.
  if (
    getPatternIdentityRef(target) === undefined &&
    pieces.runtime.runner.sessionPatternPointerFor(target) === undefined
  ) {
    throw new SlugResolutionError(
      `Slug "${token}" redirects to a document that is not a piece.`,
      "not-piece",
    );
  }

  const id = pieceId(target);
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
