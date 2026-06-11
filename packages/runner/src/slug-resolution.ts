import type { Cell } from "./cell.ts";
import type { Runtime } from "./runtime.ts";
import type { URI } from "./sigil-types.ts";
import type { MemorySpace } from "./storage/interface.ts";
import { parseLink } from "./link-utils.ts";
import { slugIdForSpace, validateSlug } from "./slugs.ts";

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

  const target = runtime.getCellFromLink({
    ...targetLink,
    id: targetLink.id as URI,
    space: targetLink.space ?? space,
    scope: targetLink.scope ?? "space",
  });
  await target.sync();
  return target;
}
