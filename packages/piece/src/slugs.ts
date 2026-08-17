import type { Cell } from "@commonfabric/runner";
import {
  areLinksSame,
  entityIdFrom,
  getPatternIdentityRef,
  isSlugAddress,
  resolveSlugTargetCell as resolveRuntimeSlugTargetCell,
  slugIdForSpace,
  SlugResolutionError,
  validateSlug,
} from "@commonfabric/runner";
import { pieceId } from "./piece-id.ts";
import type { PiecesController } from "./ops/pieces-controller.ts";

export { SlugResolutionError };

export async function assignSlug(
  pieces: PiecesController,
  piece: Cell<unknown>,
  slug: string,
): Promise<void> {
  await setSlugLink(pieces, slug, piece, { writeTargetMetadata: true });
}

/**
 * Clears the slug document for `slug` when it still redirects to `target`,
 * so the name resolves to nothing again — the state `resolveSlugTargetCell()`
 * reports as `missing`, and the state every slug is in before anything is
 * assigned to it. This is the undo of one `assignSlug()` call, so a slug that
 * now redirects somewhere else, or that holds nothing, is left exactly as it
 * is: a later writer's assignment is not this caller's to withdraw.
 *
 * The `slug` metadata `assignSlug()` wrote on the target document is left in
 * place. It is a label on the piece rather than a claim on the name, and
 * nothing resolves a slug through it.
 */
export async function releaseSlug(
  pieces: PiecesController,
  slug: string,
  target: Cell<unknown>,
): Promise<void> {
  const validSlug = validateSlug(slug);
  const slugCell = pieces.runtime.getCellFromEntityId(
    pieces.getSpace(),
    entityIdFrom(slugIdForSpace(pieces.getSpace(), validSlug)),
  );
  await slugCell.sync();
  await target.sync();
  await pieces.runtime.editWithRetry((tx) => {
    const slugWithTx = slugCell.withTx(tx);
    const raw = slugWithTx.getRawUntyped();
    if (raw === undefined) {
      return;
    }
    // The very value `setSlugLink()` writes for this target, compared against
    // what the document holds: same shape, same base, so the comparison is of
    // the assignment this call undoes rather than of two spellings of a link.
    const assigned = target.withTx(tx).getAsWriteRedirectLink({
      base: slugWithTx,
    });
    if (!areLinksSame(raw, assigned, slugWithTx)) {
      return;
    }
    slugWithTx.setRawUntyped(undefined);
  });
  await pieces.runtime.idle();
  await pieces.synced();
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

  await pieces.runtime.editWithRetry((tx) => {
    const targetWithTx = target.withTx(tx);
    const slugWithTx = slugCell.withTx(tx);
    const metadataTargetWithTx = metadataTarget?.withTx(tx);

    const metadataTargetLink = metadataTargetWithTx
      ?.getAsNormalizedFullLink();
    if (
      metadataTargetWithTx !== undefined &&
      metadataTargetLink?.path.length === 0
    ) {
      metadataTargetWithTx.setMetaRaw("slug", validSlug);
    }
    slugWithTx.setMetaRaw("slug", validSlug);
    slugWithTx.setRawUntyped(
      targetWithTx.getAsWriteRedirectLink({ base: slugWithTx }),
    );
  });

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
  if (getPatternIdentityRef(target) === undefined) {
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
