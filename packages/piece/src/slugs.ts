import type { Cell } from "@commonfabric/runner";
import {
  getPatternIdentityRef,
  isSlugAddress,
  resolveSlugTargetCell as resolveRuntimeSlugTargetCell,
  slugIdForSpace,
  SlugResolutionError,
  validateSlug,
} from "@commonfabric/runner";
import { pieceId, PieceManager } from "./manager.ts";

export { SlugResolutionError };

export async function assignSlug(
  manager: PieceManager,
  piece: Cell<unknown>,
  slug: string,
): Promise<void> {
  await setSlugLink(manager, slug, piece, { writeTargetMetadata: true });
}

export async function setSlugLink(
  manager: PieceManager,
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

  const slugCell = manager.runtime.getCellFromEntityId(
    manager.getSpace(),
    { "/": slugIdForSpace(manager.getSpace(), validSlug) },
  );

  await manager.runtime.editWithRetry((tx) => {
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

  await manager.runtime.idle();
  await manager.synced();
}

export async function resolvePieceAddress(
  manager: PieceManager,
  token: string,
): Promise<string> {
  if (!isSlugAddress(token)) {
    return token;
  }

  const target = await resolveSlugTargetCell(manager, token);
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
  manager: PieceManager,
  token: string,
): Promise<Cell<unknown>> {
  return await resolveRuntimeSlugTargetCell(
    manager.runtime,
    manager.getSpace(),
    token,
  );
}
