import type { CellScope, JSONSchema } from "@commonfabric/api";
import type { Cell } from "@commonfabric/runner";
import {
  DEFAULT_CELL_SCOPE,
  entityIdFrom,
  isSlugAddress,
  parseLink,
  resolveSlugReference,
  resolveSlugTargetCell as resolveRuntimeSlugTargetCell,
  resolveSlugTargetInPiece,
  slugIdForSpace,
  slugIndexIdForSpace,
  SlugResolutionError,
  validateSlug,
} from "@commonfabric/runner";
import { rawMetaWriteAuthorization } from "@commonfabric/runner/meta-seam";
import { createLLMFriendlyLink } from "@commonfabric/runner/shared";
import { utf8Compare } from "@commonfabric/utils/utf8";
import type { PiecesController } from "./ops/pieces-controller.ts";
import { pieceId } from "./piece-id.ts";

export { SlugResolutionError };

/**
 * A name that was already bound when an assignment reached it. The target it
 * carries is a reference to what the name points at now, which is both what
 * forcing the assignment would take and what a caller writes to put the name
 * back.
 *
 * The condition is the library's and the remedy is the caller's, so a caller
 * with a word for forcing — a CLI flag, a tool parameter — supplies its own
 * and the message reads in that caller's vocabulary.
 */
export class SlugAssignedError extends Error {
  #slug: string;
  #target: string;

  constructor(slug: string, target: string, remedy?: string) {
    super(
      `Slug "${slug}" already points at ${target}, so assigning it would ` +
        `take that address from whoever holds it.` +
        (remedy === undefined ? "" : ` ${remedy}`),
    );
    this.name = "SlugAssignedError";
    this.#slug = slug;
    this.#target = target;
  }

  /** The name the assignment asked for. */
  get slug(): string {
    return this.#slug;
  }

  /** A reference to what the name points at now. */
  get target(): string {
    return this.#target;
  }
}

/**
 * A name that had moved on when an assignment reached it, and now points
 * nowhere. The sibling of {@link SlugAssignedError}, and a different outcome:
 * nobody holds the name, so the caller's answer is to read it again and try,
 * where a name someone else holds is one to leave alone.
 *
 * Only a caller naming what to take the name from can see this, since a
 * caller that names none is asking for a free name and has found one.
 */
export class SlugReleasedError extends Error {
  #slug: string;
  #expected: string;

  constructor(slug: string, expected: string, remedy?: string) {
    super(
      `Slug "${slug}" no longer points at ${expected}, and now points ` +
        `nowhere.` + (remedy === undefined ? "" : ` ${remedy}`),
    );
    this.name = "SlugReleasedError";
    this.#slug = slug;
    this.#expected = expected;
  }

  /** The name the assignment asked for. */
  get slug(): string {
    return this.#slug;
  }

  /** The reference the caller said to take the name from. */
  get expected(): string {
    return this.#expected;
  }
}

/** The slug index's shape: names to `true`. Written one key at a time, so
 * two clients assigning different slugs merge as two keys rather than two
 * whole maps racing. The names are the whole content — where a name points
 * stays the slug cell's own answer, because a copy of the target here would
 * be a second answer able to disagree with it. */
const SLUG_INDEX_SCHEMA = {
  type: "object",
  additionalProperties: { type: "boolean" },
} as const satisfies JSONSchema;

/** The document a name's redirect lives in, whose id derives from the name. */
function slugCellFor(pieces: PiecesController, validSlug: string) {
  return pieces.runtime.getCellFromEntityId(
    pieces.getSpace(),
    entityIdFrom(slugIdForSpace(pieces.getSpace(), validSlug)),
  );
}

/**
 * The reference a name's redirect reads as, or `null` for a name pointing
 * nowhere. One spelling for the whole module: what a refusal names, what
 * {@link readSlugBinding} answers, and what an assignment compares against
 * are the same string, so a caller can compare them.
 */
function bindingRefOf(
  pieces: PiecesController,
  slugCell: Cell<unknown>,
): string | null {
  const held = parseLink(slugCell.getRaw(), slugCell);
  return held === undefined
    ? null
    : createLLMFriendlyLink(held, pieces.getSpace());
}

/**
 * The document root that carries a name for `cell`, or `undefined` when
 * `cell` names a position inside a document rather than a document of its
 * own. The stored `slug` entry belongs to a root, so a name pointing into one
 * has no root of its own to stamp.
 *
 * One question for both sides of a reassignment — the stamp on the target
 * taking the name and the clear on the holder losing it — because the two
 * disagreeing is what leaves a root claiming a name that moved: a stored
 * redirect can carry a path and still resolve to a root, and asking about the
 * path before resolving answers about the redirect rather than about the
 * document the name reaches.
 */
function slugStampRoot(cell: Cell<unknown>): Cell<unknown> | undefined {
  const resolved = cell.resolveAsCell();
  return resolved.getAsNormalizedFullLink().path.length === 0
    ? resolved
    : undefined;
}

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

/**
 * What `slug` points at now, as the reference a refusal names, or `null` for
 * a name pointing nowhere.
 *
 * The value a caller hands back as `takeFrom` when it has its own rule about
 * which of those states counts as free: read it, judge it, and carry it into
 * the assignment, where the commit holds the judgment against the state the
 * write actually lands on.
 */
export async function readSlugBinding(
  pieces: PiecesController,
  slug: string,
): Promise<string | null> {
  const slugCell = slugCellFor(pieces, validateSlug(slug));
  await slugCell.sync();
  return bindingRefOf(pieces, slugCell);
}

/**
 * Points `slug` at a piece and stamps the piece with the name, refusing a
 * name that is already bound the way {@link setSlugLink} does.
 */
export async function assignSlug(
  pieces: PiecesController,
  piece: Cell<unknown>,
  slug: string,
  options?: { force?: boolean; takeFrom?: string | null },
): Promise<void> {
  await setSlugLink(pieces, slug, piece, {
    writeTargetMetadata: true,
    force: options?.force,
    takeFrom: options?.takeFrom,
  });
}

/**
 * Points `slug` at `source`, and records the name in the space's slug index.
 *
 * A name pointing somewhere other than `takeFrom` — nowhere, for a caller
 * that names none — is refused: with a {@link SlugAssignedError} naming what
 * it holds, or a {@link SlugReleasedError} when it has come to point nowhere,
 * which is a name to read again rather than one to leave alone. `force` takes
 * it whatever it holds, and ignores `takeFrom`.
 *
 * The refusal is a claim rather than a check: the name is read inside the
 * transaction the assignment commits in, so a writer that binds it between
 * that read and the commit conflicts, and `editWithRetry` re-runs the body
 * against what that writer left. Two assignments of one free name therefore
 * end with one holder, not with whichever committed last — and that holds for
 * a caller whose own rule about a free name is wider than this module's,
 * because `takeFrom` carries that rule's answer into the transaction rather
 * than leaving it in a read the write has outlived.
 *
 * Taking a name from a holder clears the `slug` entry the holder's document
 * root carries for it, in the same transaction as the new redirect, so no
 * document is left claiming a name it no longer holds.
 *
 * Throws when storage refuses the transaction, so a caller never reads a name
 * as assigned that never landed.
 */
export async function setSlugLink(
  pieces: PiecesController,
  slug: string,
  source: Cell<unknown>,
  options?: {
    resolveBeforeLinking?: boolean;
    writeTargetMetadata?: boolean;
    force?: boolean;
    takeFrom?: string | null;
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

  const slugCell = slugCellFor(pieces, validSlug);

  // Where the caller says the name points now, and so what the assignment
  // commits only while it still points at. A caller that names none is asking
  // for a free name, which is a name pointing nowhere.
  const takeFrom = options?.takeFrom ?? null;

  const indexCell = slugIndexCell(pieces);
  await indexCell.sync();
  // The name is synced so the claim below reads what the space holds rather
  // than an absence this client never checked.
  await slugCell.sync();

  const { ok: refusal, error } = await pieces.runtime.editWithRetry((tx) => {
    const targetWithTx = target.withTx(tx);
    const slugWithTx = slugCell.withTx(tx);
    const metadataTargetWithTx = metadataTarget?.withTx(tx);

    // The claim, ahead of every write so that declining stages nothing: a
    // read here joins the commit's read set, so binding the name under this
    // transaction rejects it and the body re-runs against the new holder.
    const held = parseLink(slugWithTx.getRaw(), slugWithTx);
    const heldRef = held === undefined
      ? null
      : createLLMFriendlyLink(held, pieces.getSpace());
    if (!options?.force && heldRef !== takeFrom) {
      // `null` is a refusal too: a caller that named what to take the name
      // from has not got it, whether somebody else holds the name now or
      // nobody does.
      return { held: heldRef };
    }

    // The name is being taken from a holder, so the holder stops claiming
    // it. Only its own name is cleared: another name pointing at the same
    // root is not this assignment's to drop. Ahead of the stamp below, so a
    // root that is both the old holder and the new one ends up stamped.
    const previousRoot = held === undefined ? undefined : slugStampRoot(
      pieces.runtime.getCellFromLink(held).withTx(tx),
    );
    if (previousRoot?.getMetaRaw("slug") === validSlug) {
      previousRoot.setMetaRaw("slug", undefined, rawMetaWriteAuthorization);
    }

    const stampRoot = metadataTargetWithTx === undefined
      ? undefined
      : slugStampRoot(metadataTargetWithTx);
    stampRoot?.setMetaRaw("slug", validSlug, rawMetaWriteAuthorization);
    slugWithTx.setMetaRaw("slug", validSlug, rawMetaWriteAuthorization);
    slugWithTx.setRawUntyped(
      targetWithTx.getAsWriteRedirectLink({ base: slugWithTx }),
    );
    // The index entry rides the slug's own transaction, so a listing can
    // never see a name without its slug or a slug without its name.
    indexCell.withTx(tx).key(validSlug).set(true);
    return undefined;
  });
  if (error) {
    throw new Error(
      `Linking the slug "${validSlug}" failed because storage returned ${error.name}: ${error.message}`,
      { cause: error },
    );
  }
  if (refusal !== undefined) {
    if (refusal.held !== null) {
      throw new SlugAssignedError(validSlug, refusal.held);
    }
    // A name pointing nowhere only refuses a caller that named somewhere for
    // it to point, because `takeFrom` of `null` is what a name pointing
    // nowhere matches. So there is a reference to report here.
    throw new SlugReleasedError(validSlug, takeFrom!);
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
