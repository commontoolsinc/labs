/**
 * The address a person opens a named piece at.
 *
 * It is the fabric's URL, then the space, then the slug: what `cf piece new`
 * prints under "Open in browser", and what the shell reads back. The space
 * goes in as it was configured. A name addresses the legacy space that name
 * derives; a space created with a random key has no name, and goes in as its
 * DID. The shell's own writer spells the path, so a DID reaches the shell as
 * the DID it reads rather than escaped into a segment it would take for a
 * name, which derives a different space.
 */

import { appViewToUrlPath, spaceViewRef } from "@commonfabric/navigation";

/**
 * The URL of the piece `slug` names in `space` on the fabric at `base`, or
 * `undefined` when no URL can be composed from them: `base` is not a URL, or
 * `space` is empty. A path on `base` is kept, so a host that renders pieces
 * under a path of its own gets addresses under it.
 */
export const pieceUrl = (
  base: string | URL,
  space: string,
  slug: string,
): string | undefined => {
  const view = spaceViewRef(space, undefined);
  if (view === undefined) {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    return undefined;
  }
  const prefix = url.pathname.endsWith("/")
    ? url.pathname.slice(0, -1)
    : url.pathname;
  url.pathname = `${prefix}${appViewToUrlPath({ ...view, pieceSlug: slug })}`;
  return url.toString();
};
