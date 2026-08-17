import type { Cell, CommitError } from "@commonfabric/runner";
import {
  areLinksSame,
  entityIdFrom,
  getPatternIdentityRef,
  isSlugAddress,
  isWriteRedirectLink,
  resolveSlugTargetCell as resolveRuntimeSlugTargetCell,
  slugIdForSpace,
  SlugResolutionError,
  validateSlug,
} from "@commonfabric/runner";
import type { FabricValue } from "@commonfabric/data-model/fabric-value";
import { pieceId } from "./piece-id.ts";
import type { PiecesController } from "./ops/pieces-controller.ts";

export { SlugResolutionError };

/**
 * What one `setSlugLink()` call did to the slug document, in the terms
 * `releaseSlug()` needs to undo it.
 */
export interface SlugAssignment {
  /**
   * The value the slug document held at the instant this assignment
   * overwrote it, or `undefined` when the name held nothing. Read inside the
   * writing transaction, so it is the value the write actually replaced
   * rather than the value some earlier read saw.
   *
   * Hand it to `releaseSlug()` as `restore` and the name goes back to
   * whatever it named before — which, for a name that was free, is nothing.
   */
  readonly replaced: FabricValue | undefined;
}

export async function assignSlug(
  pieces: PiecesController,
  piece: Cell<unknown>,
  slug: string,
): Promise<SlugAssignment> {
  return await setSlugLink(pieces, slug, piece, { writeTargetMetadata: true });
}

/**
 * Puts the slug document for `slug` back the way one `assignSlug()` call
 * found it, when that call's redirect to `target` is still what the document
 * holds. `restore` is that call's `replaced` value: absent, the name goes
 * back to resolving to nothing — the state `resolveSlugTargetCell()` reports
 * as `missing`, and the state every slug is in before anything is assigned to
 * it; present, the name goes back to whoever held it, because an assignment
 * that overwrote a concurrent writer's redirect owes that writer their
 * address back rather than owing everyone a name that now points nowhere.
 *
 * A slug that redirects somewhere else, that holds nothing, or that holds a
 * link which is not a write redirect is left exactly as it is: only what
 * `setSlugLink()` writes is this caller's to withdraw.
 *
 * The `slug` metadata `assignSlug()` wrote on the target document is left in
 * place. It is a label on the piece rather than a claim on the name, and
 * nothing resolves a slug through it.
 *
 * Returns the commit's verdict. An `error` means the slug still holds the
 * assignment: the name was not released, whatever the caller does next.
 */
export async function releaseSlug(
  pieces: PiecesController,
  slug: string,
  target: Cell<unknown>,
  options?: { restore?: FabricValue },
): Promise<{ error?: CommitError }> {
  const validSlug = validateSlug(slug);
  const slugCell = pieces.runtime.getCellFromEntityId(
    pieces.getSpace(),
    entityIdFrom(slugIdForSpace(pieces.getSpace(), validSlug)),
  );
  await slugCell.sync();
  await target.sync();
  const { error } = await pieces.runtime.editWithRetry((tx) => {
    const slugWithTx = slugCell.withTx(tx);
    const raw = slugWithTx.getRawUntyped();
    if (raw === undefined) {
      return;
    }
    // `setSlugLink()` writes a WRITE REDIRECT, and `areLinksSame()` compares
    // where two links point without regard for whether either redirects. So a
    // plain link to this same target — a value some other writer put here,
    // meaning something else — passes that comparison, and the shape is
    // checked separately before it gets there.
    if (!isWriteRedirectLink(raw)) {
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
    slugWithTx.setRawUntyped(options?.restore);
  });
  await pieces.runtime.idle();
  await pieces.synced();
  return error ? { error } : {};
}

/**
 * Points `slug` at `source`, and reports what the name held before it did.
 */
export async function setSlugLink(
  pieces: PiecesController,
  slug: string,
  source: Cell<unknown>,
  options?: {
    resolveBeforeLinking?: boolean;
    writeTargetMetadata?: boolean;
  },
): Promise<SlugAssignment> {
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

  const { ok } = await pieces.runtime.editWithRetry((tx) => {
    const targetWithTx = target.withTx(tx);
    const slugWithTx = slugCell.withTx(tx);
    const metadataTargetWithTx = metadataTarget?.withTx(tx);

    // Read and overwrite in ONE transaction, so what comes back is what this
    // write replaced and nothing else. The read joins the transaction's read
    // set, which the commit turns into a value precondition on the slug
    // document: a writer landing between this read and this commit makes the
    // commit conflict, and `editWithRetry` re-runs the whole callback against
    // the state that writer left. There is no window in which the captured
    // value and the written-over value can differ.
    const replaced = slugWithTx.getRawUntyped();

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
    return { replaced };
  });

  await pieces.runtime.idle();
  await pieces.synced();
  // A rejected commit wrote nothing, so there is nothing for a caller to put
  // back: `releaseSlug()` acts only on a document holding this assignment,
  // and no document holds one.
  return ok ?? { replaced: undefined };
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
