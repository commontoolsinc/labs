import type { Cell, URI } from "@commonfabric/runner";
import {
  getMetaLink,
  isSlugAddress,
  parseLink,
  slugIdForSpace,
  validateSlug,
} from "@commonfabric/runner";
import { pieceId, PieceManager } from "./manager.ts";

export class SlugResolutionError extends Error {
  constructor(
    message: string,
    readonly code?:
      | "invalid"
      | "missing"
      | "malformed"
      | "not-piece"
      | "missing-piece-id",
  ) {
    super(message);
    this.name = "SlugResolutionError";
  }
}

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

  const slugCell = manager.runtime.getCellFromEntityId(
    manager.getSpace(),
    { "/": slugIdForSpace(manager.getSpace(), validSlug) },
  );

  await manager.runtime.editWithRetry((tx) => {
    const targetWithTx = target.withTx(tx);
    const slugWithTx = slugCell.withTx(tx);
    const targetLink = targetWithTx.getAsNormalizedFullLink();
    const slugLink = slugWithTx.getAsNormalizedFullLink();

    if (
      options?.writeTargetMetadata &&
      (!targetLink.path || targetLink.path.length === 0)
    ) {
      tx.writeOrThrow({
        space: targetLink.space,
        id: targetLink.id,
        scope: targetLink.scope,
        path: ["slug"],
      }, validSlug);
    }
    tx.writeOrThrow({
      space: slugLink.space,
      id: slugLink.id,
      scope: slugLink.scope,
      path: ["slug"],
    }, validSlug);
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

  const slug = validateSlug(token);
  const slugId = slugIdForSpace(manager.getSpace(), slug);
  const slugCell = manager.runtime.getCellFromEntityId(
    manager.getSpace(),
    { "/": slugId },
  );
  await slugCell.sync();
  const raw = slugCell.getRaw();
  if (raw === undefined) {
    throw new SlugResolutionError(`Slug "${slug}" not found.`, "missing");
  }

  const targetLink = parseLink(raw, slugCell);
  if (!targetLink || targetLink.overwrite !== "redirect") {
    throw new SlugResolutionError(
      `Slug "${slug}" does not contain a valid redirect.`,
      "malformed",
    );
  }

  const target = manager.runtime.getCellFromLink({
    ...targetLink,
    id: targetLink.id as URI,
    space: targetLink.space ?? manager.getSpace(),
    scope: targetLink.scope ?? "space",
  });
  await target.sync();
  if (getMetaLink(target, "pattern") === undefined) {
    throw new SlugResolutionError(
      `Slug "${slug}" redirects to a document that is not a piece.`,
      "not-piece",
    );
  }

  const id = pieceId(target);
  if (!id) {
    throw new SlugResolutionError(
      `Slug "${slug}" redirects to a document without a piece id.`,
      "missing-piece-id",
    );
  }
  return id;
}
