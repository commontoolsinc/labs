import { createRef } from "./create-ref.ts";
import type { URI } from "./sigil-types.ts";
import type { MemorySpace } from "./storage/interface.ts";
import { toURI } from "./uri-utils.ts";

/** The ids worked out so far, by space. */
const ids = new Map<MemorySpace, URI>();

/**
 * The id of the space cell of `space`, the cell `Runtime.getSpaceCell()`
 * returns: the one whose cause is the space's own DID. Kept per space, since a
 * write checks it and deriving it hashes.
 */
export function spaceCellId(space: MemorySpace): URI {
  let id = ids.get(space);
  if (id === undefined) {
    id = toURI(createRef({}, space));
    ids.set(space, id);
  }
  return id;
}

/**
 * A write refused because it lands beneath the `defaultPattern` slot of a
 * space cell that links no root yet. Such a write would land inline in the
 * space cell itself, where no root reads it and where the root's creation
 * finds the slot taken, so a space written that way never gets its root.
 */
export class SpaceRootMissingError extends Error {
  constructor(space: MemorySpace) {
    super(
      `${space} has no root yet, so a write beneath its \`defaultPattern\` ` +
        `slot is refused rather than landing in the space cell. A client ` +
        `runtime brings a user's Home root up ahead of a handler that writes ` +
        `under it; any other space gets its root when it is first opened.`,
    );
    this.name = "SpaceRootMissingError";
  }
}
