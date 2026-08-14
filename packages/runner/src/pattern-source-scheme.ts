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
 * A ref may not climb out of the patterns route, and a query or fragment is
 * refused outright (`?identity` is the updater's to add, not the ref's to
 * carry).
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
  // even `//evil.example/x` is just a path. What it CAN do is climb, so `..`
  // segments are normalized here and the prefix is re-checked afterwards.
  const resolved = new URL(PATTERNS_ROUTE_PREFIX + path, RESOLUTION_BASE);
  if (!staysInPatternsRoute(resolved.pathname)) return undefined;
  return resolved.pathname;
}

/**
 * Whether a resolved pathname still addresses a file under the patterns route.
 *
 * The URL parser normalizes `..` but never decodes `%2f`, so `..%2f..%2fx`
 * survives normalization as a single opaque segment and passes a bare prefix
 * check. The server rejects that before it reads a file, but the layer belongs
 * here too: `systemPatternSourceForModuleName` is fed author-controlled strings.
 * Decoding is checked separately because a malformed escape throws.
 */
function staysInPatternsRoute(pathname: string): boolean {
  if (!pathname.startsWith(PATTERNS_ROUTE_PREFIX)) return false;
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return false;
  }
  // The prefix itself survives decoding — it was matched literally above — so
  // only what follows it can climb.
  return !decoded.split("/").includes("..");
}

/**
 * The `system:` ref a compiled module name denotes, or `undefined` when the
 * name says nothing about a route.
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
 * Two legacy spellings are in the wild: the rooted route path
 * (`/api/patterns/system/home.tsx`), and the absolute href that
 * `normalizePieceSourceOrigin` rewrites that path into against the space's
 * host once a source transition records it. The absolute form is rewritten only
 * when it names the space's own host, so a locator pointing somewhere else is
 * not silently re-pointed at the local toolshed — that would be a change of
 * source, not of spelling.
 *
 * A query or fragment on a legacy locator is dropped: it selects nothing on the
 * patterns route, which serves a file by path, and revalidation is the
 * `?identity` ETag's job. Keeping it would leave the piece with a locator no
 * ref can name, and therefore one nothing would ever follow again.
 *
 * The result either resolves as a ref or is the input unchanged; nothing here
 * can mint a ref the resolver rejects.
 *
 * TODO(seefeldb) 2026-08-31: revisit — do NOT delete on sight. Removal needs
 * two things this change does not do. Durable pre-existing provenance has to be
 * migrated, which only happens on a successful check and therefore never on a
 * deployment running with `systemPatternAutoUpdate` off. And
 * `isLegacyPieceRegistryRoot` reads this to recognize a root that tracks the
 * official default app, on a path with no flag gate at all.
 */
export function normalizePatternSource(
  source: string,
  host?: string | URL,
): string {
  const path = legacyPatternsRoutePath(source, host);
  if (path === undefined) return source;
  const ref = systemPatternSource(path);
  return resolveSystemPatternSource(ref) === undefined ? source : ref;
}

function legacyPatternsRoutePath(
  source: string,
  host: string | URL | undefined,
): string | undefined {
  // Both spellings are read as URLs so they get one set of checks: a rooted
  // path against a syntactic base, an absolute locator against the space's own
  // host. Reading only the rooted form as a string let `..`, a query, and a
  // fragment through, each of which denotes a ref that cannot resolve.
  let url: URL;
  if (source.startsWith("/")) {
    url = new URL(source, RESOLUTION_BASE);
    // A leading `/` is not proof of a path: `//host/x` and `/\host/x` both
    // introduce an authority, and their pathname alone looks like a local
    // route. Re-pointing such a locator at this toolshed would change which
    // host a piece follows, which is a change of source, not of spelling.
    if (url.origin !== new URL(RESOLUTION_BASE).origin) return undefined;
  } else {
    if (host === undefined) return undefined;
    try {
      url = new URL(source);
      if (url.origin !== new URL(host).origin) return undefined;
    } catch {
      return undefined;
    }
  }
  if (!staysInPatternsRoute(url.pathname)) return undefined;
  const path = url.pathname.slice(PATTERNS_ROUTE_PREFIX.length);
  return path.length === 0 ? undefined : path;
}
