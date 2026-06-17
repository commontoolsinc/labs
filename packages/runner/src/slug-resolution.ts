import type { Cell } from "./cell.ts";
import type { Runtime } from "./runtime.ts";
import type { URI } from "./sigil-types.ts";
import type { MemorySpace } from "./storage/interface.ts";
import { parseLink } from "./link-utils.ts";
import { slugIdForSpace, validateSlug } from "./slugs.ts";
import { entityIdFrom } from "./create-ref.ts";

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

export async function resolveSlugTargetCell(
  runtime: Runtime,
  space: MemorySpace,
  token: string,
): Promise<Cell<unknown>> {
  const slug = validateSlug(token);
  const slugId = slugIdForSpace(space, slug);
  const slugCell = runtime.getCellFromEntityId(
    space,
    entityIdFrom(slugId),
  );
  await slugCell.sync();
  const raw = slugCell.getRaw();
  if (raw === undefined) {
    throw new SlugResolutionError(`Slug "${slug}" not found.`, "missing");
  }

  const targetLink = parseSlugRedirect(raw, slugCell);
  if (!targetLink) {
    throw new SlugResolutionError(
      `Slug "${slug}" does not contain a valid redirect.`,
      "malformed",
    );
  }

  const target = runtime.getCellFromLink({
    ...targetLink,
    id: targetLink.id as URI,
    space: targetLink.space ?? space,
    scope: targetLink.scope ?? "space",
  });
  await target.sync();
  return target;
}

/**
 * Parse a slug document's raw payload into its redirect link, or undefined
 * when the payload is not a valid redirect. parseLink throws plain TypeErrors
 * on sigil-SHAPED payloads with broken internals (e.g. a non-array path);
 * this runtime's own write path rejects such values, but a slug cell can be
 * written by foreign clients over the memory protocol, so the resolver must
 * fold a parse throw into the same typed "malformed" outcome as a
 * structurally-invalid payload. Exported for tests.
 */
export function parseSlugRedirect(raw: unknown, base: Cell<unknown>) {
  try {
    const link = parseLink(raw, base);
    return link?.overwrite === "redirect" ? link : undefined;
  } catch {
    return undefined;
  }
}
