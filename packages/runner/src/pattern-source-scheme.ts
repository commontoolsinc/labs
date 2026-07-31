/**
 * The `patternSource` grammar: a piece's provenance string, dispatched by its
 * scheme.
 *
 * - `cf:…` — a published fabric ref, resolved by the fabric chase
 *   (`fabric-ref-resolution.ts`).
 * - `system:<path>` — a pattern this deployment's toolshed serves from its
 *   patterns directory, addressed RELATIVE to that route:
 *   `system:system/default-app.tsx` → `/api/patterns/system/default-app.tsx`.
 *
 * Why a scheme rather than the bare route path it expands to. The updater's
 * rule has to be a whitelist, because the alternative — "any same-origin path
 * may be fetched" — cannot distinguish a route from an author-controlled module
 * filename that merely looks like one. A pattern deployed from a local file
 * tree names its modules by their path under the compile root (`/main.tsx`,
 * `/participant-identity-card.tsx`); treating such a name as a URL fetched the
 * shell's SPA fallback, which answers 200 with HTML for any unrouted path, and
 * then compiled that HTML as TSX. Requiring an explicit scheme means provenance
 * has to be *claimed* at deploy time, and everything else is skipped.
 *
 * The ref is also deliberately host-relative. A space that moves hosts keeps
 * working, and the host stays out of the identity — the same reason `cf:` refs
 * are stored in their canonical host-less form.
 */

/** The scheme naming a pattern served by this deployment's patterns route. */
export const SYSTEM_PATTERN_SOURCE_SCHEME = "system:";

/**
 * The URL prefix the toolshed serves its patterns directory under. A pattern's
 * content identity folds in each module's authored path, and the worker names
 * modules by their URL pathname, so this prefix is part of the identity
 * contract — not merely a routing detail.
 */
export const PATTERNS_ROUTE_PREFIX = "/api/patterns/";

// Resolution only needs a syntactic base: the caller re-resolves the returned
// path against the host that actually serves the space.
const RESOLUTION_BASE = "https://pattern-source.invalid/";

/** The `system:` ref addressing `path` under the patterns route. */
export function systemPatternSource(path: string): string {
  return SYSTEM_PATTERN_SOURCE_SCHEME + path;
}

/**
 * The route path a `system:` ref addresses, or `undefined` for anything that is
 * not a well-formed one — a `cf:` ref, a bare path, an absolute URL, a module
 * filename. Callers resolve the result against the space's host.
 *
 * A ref may not climb out of the patterns route: `..` segments are normalized
 * before the prefix is re-checked, and a query or fragment is refused outright
 * (`?identity` is the updater's to add, not the ref's to carry).
 */
export function resolveSystemPatternSource(
  source: string,
): string | undefined {
  if (!source.startsWith(SYSTEM_PATTERN_SOURCE_SCHEME)) return undefined;
  const path = source.slice(SYSTEM_PATTERN_SOURCE_SCHEME.length);
  if (path.length === 0 || path.startsWith("/")) return undefined;
  if (path.includes("?") || path.includes("#")) return undefined;
  // Resolving a `/`-rooted path against a fixed base neither throws nor can
  // reach another origin, whatever the ref holds — the prefix is prepended, so
  // even `//evil.example/x` is just a path. What it CAN do is climb: `..`
  // segments are normalized here, and the prefix is re-checked afterwards.
  const resolved = new URL(PATTERNS_ROUTE_PREFIX + path, RESOLUTION_BASE);
  if (!resolved.pathname.startsWith(PATTERNS_ROUTE_PREFIX)) return undefined;
  return resolved.pathname;
}

/**
 * The `system:` ref a compiled module name spells, or `undefined` when the name
 * says nothing about a route.
 *
 * A module's name is a URL pathname only for a program the worker compiled over
 * HTTP, where `HttpProgramResolver` names every module by its pathname. A
 * program compiled from a file tree names each module by its path under the
 * compile root instead — `/main.tsx`, `/participant-identity-card.tsx` — and
 * such a name is not a claim about anything the host serves. Admitting only
 * patterns-route names keeps recovered provenance to the one representation
 * where a name and a route are the same string.
 */
export function systemPatternSourceForModuleName(
  name: string,
): string | undefined {
  if (!name.startsWith(PATTERNS_ROUTE_PREFIX)) return undefined;
  const source = systemPatternSource(name.slice(PATTERNS_ROUTE_PREFIX.length));
  return resolveSystemPatternSource(source) === undefined ? undefined : source;
}

/**
 * Rewrite a pre-scheme provenance string into its `system:` ref, leaving
 * everything else untouched.
 *
 * Two legacy spellings are in the wild. Roots stamped by PiecesController
 * carry the rooted route path (`/api/patterns/system/home.tsx`), and any piece
 * whose source transition has been recorded since carries the absolute href
 * that `normalizePieceSourceOrigin` rewrote that path into against the space's
 * host. The absolute form is only rewritten when it names the space's own host,
 * so a ref pointing somewhere else — which the pre-scheme updater refused to
 * follow as cross-origin — is not silently repointed at the local host.
 *
 * The updater re-stamps a piece it finds in a legacy spelling, so a piece
 * migrates on its next successful check.
 *
 * TODO(seefeldb) 2026-08-31: once a round of updates has re-stamped the
 * deployed pieces, delete this and require the scheme at the read sites.
 */
export function normalizePatternSource(
  source: string,
  host?: string | URL,
): string {
  const path = legacyPatternsRoutePath(source, host);
  return path === undefined ? source : systemPatternSource(path);
}

function legacyPatternsRoutePath(
  source: string,
  host: string | URL | undefined,
): string | undefined {
  if (source.startsWith(PATTERNS_ROUTE_PREFIX)) {
    return source.slice(PATTERNS_ROUTE_PREFIX.length);
  }
  if (host === undefined) return undefined;
  let url: URL;
  let hostUrl: URL;
  try {
    url = new URL(source);
    hostUrl = new URL(host);
  } catch {
    return undefined;
  }
  if (url.origin !== hostUrl.origin) return undefined;
  if (!url.pathname.startsWith(PATTERNS_ROUTE_PREFIX)) return undefined;
  if (url.search.length > 0 || url.hash.length > 0) return undefined;
  return url.pathname.slice(PATTERNS_ROUTE_PREFIX.length);
}
