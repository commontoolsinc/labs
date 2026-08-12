import { isSlugAddress } from "./slugs.ts";

/**
 * What a URL names, when it names a cell.
 *
 * `space` is whatever the URL carried — a DID, or a name that still has to be
 * resolved into one. Exactly one of `id` and `slug` is set: a last segment
 * carrying a scheme is an id, and anything else is a slug, which addresses a
 * redirect document rather than the piece itself.
 */
export interface FabricUrlTarget {
  space?: string;
  id?: string;
  slug?: string;
  path: string[];
}

export interface FabricUrlOptions {
  /**
   * Hosts whose page URLs name cells. A page URL from anywhere else is just a
   * link to a web page, and saying which hosts are ours is the only way to
   * tell the two apart — until an unknown host can be probed.
   */
  hosts?: readonly string[];
}

/** `fid1:<payload>`, with the colon percent-encoded or not. */
const TAGGED_HASH = /^fid1(?::|%3a)([A-Za-z0-9_-]{20,})$/i;

/**
 * Whether a segment names an entity rather than a slug. Bare and `of:`-schemed
 * forms both count; the scheme is part of the identity, so it is preserved
 * rather than assumed.
 */
function asEntityId(segment: string): string | undefined {
  const decoded = decodeURIComponent(segment);
  const schemeAt = decoded.indexOf(":");
  if (schemeAt === -1) return undefined;

  // `of:fid1:…` — a scheme in front of the tagged hash.
  const head = decoded.slice(0, schemeAt);
  const rest = decoded.slice(schemeAt + 1);
  if (TAGGED_HASH.test(rest)) return `${head}:${rest}`;

  // `fid1:…` on its own. A piece reached through a URL path is a root, and
  // roots are `of:`, which is what the shell's own id normalization assumes.
  if (TAGGED_HASH.test(decoded)) return `of:${decoded}`;

  return undefined;
}

/** A `@did:key:…` segment, as the LLM-friendly link form writes a space. */
function asSpaceSegment(segment: string): string | undefined {
  const decoded = decodeURIComponent(segment);
  return decoded.startsWith("@") ? decoded.slice(1) : undefined;
}

function splitPath(pathname: string): string[] {
  return pathname.split("/").filter((segment) => segment.length > 0);
}

/**
 * Read the cell a URL names, or `undefined` when it names none.
 *
 * Four shapes reach this, and they are the shapes people actually have in
 * hand: a bare or schemed tagged hash copied out of a tool, the
 * `/of:…`-rooted link this repository renders into markdown, that same form
 * carrying an `@space`, and a page URL off one of our own hosts.
 *
 * This is deliberately pure and synchronous. Deciding whether an unknown host
 * is ours, and turning a space name into a DID, are the parts that become
 * asynchronous later; neither belongs to reading a string apart.
 */
export function parseFabricUrl(
  url: string,
  options: FabricUrlOptions = {},
): FabricUrlTarget | undefined {
  const trimmed = (url ?? "").trim();
  if (trimmed.length === 0) return undefined;

  // A bare or schemed tagged hash, with no path around it.
  if (!trimmed.startsWith("/") && !trimmed.includes("://")) {
    const id = asEntityId(trimmed);
    return id ? { id, path: [] } : undefined;
  }

  let segments: string[];
  let space: string | undefined;

  if (trimmed.startsWith("/")) {
    segments = splitPath(trimmed);
    const asSpace = segments.length > 0
      ? asSpaceSegment(segments[0])
      : undefined;
    if (asSpace !== undefined) {
      space = asSpace;
      segments = segments.slice(1);
    }
    // A rooted path names a cell only by carrying an id; `/notes/mine` is a
    // path on some website, not an address here.
    if (segments.length === 0) return undefined;
    const id = asEntityId(segments[0]);
    if (id === undefined) return undefined;
    return { space, id, path: segments.slice(1) };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return undefined;
  }

  const hosts = options.hosts ?? [];
  if (!hosts.includes(parsed.host)) return undefined;

  segments = splitPath(parsed.pathname);
  // `/<space>/<piece>` is the page URL shape. A host of ours with anything
  // shorter is one of its own pages rather than a piece.
  if (segments.length < 2) return undefined;

  space = decodeURIComponent(segments[0]);
  const target = segments[1];
  const path = segments.slice(2);

  const id = asEntityId(target);
  if (id !== undefined) return { space, id, path };

  const decoded = decodeURIComponent(target);
  return isSlugAddress(decoded) ? { space, slug: decoded, path } : undefined;
}
