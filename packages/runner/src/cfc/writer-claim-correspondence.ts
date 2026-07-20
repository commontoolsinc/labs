/**
 * Spelling helpers for `writeAuthorizedBy` writer-identity claims.
 *
 * A claim's `file` and a live identity's `sourceFile` both record the module's
 * source-file SPELLING, and that spelling is resolver-dependent: the compiler
 * sees names exactly as the program resolver spelled them, and the
 * ts-transformers' historical normalization additionally stripped the first
 * path segment of absolute names (aimed at the engine's per-load `/<id>`
 * prefix, but applied blindly). The same module therefore appears as e.g.
 * `/api/patterns/system/x.tsx` (piece-deploy staging), `api/patterns/...`
 * (piece-manifest relative), or `/patterns/system/x.tsx` (HTTP-resolved,
 * stripped) — while its content-addressed `moduleIdentity` agrees everywhere
 * (labs#4772 / CT-1886).
 *
 * Authorization therefore anchors on `moduleIdentity` + `bindingPath`; the
 * file spelling is diagnostic. Where a file comparison still participates —
 * establishing which claim a writer's binding corresponds to before a stamp
 * exists — it must tolerate exactly the historical divergence: two spellings
 * correspond when they are equal or differ by one leading path segment (the
 * transformer's strip). Stored claims keep their mint-time spelling forever,
 * so this tolerance is permanent aged-store compat, deliberately no wider
 * than the divergence the toolchain actually produced.
 */

/** Leading-slash-normalize a claim/identity source-file spelling. */
export const normalizeIdentitySource = (
  source: string | undefined,
): string | undefined => {
  if (typeof source !== "string" || source.length === 0) {
    return undefined;
  }
  return source.startsWith("/") ? source : `/${source}`;
};

// The ts-transformers' historical first-segment strip, mirrored exactly: the
// only spelling divergence the toolchain has produced for one module.
const dropFirstPathSegment = (source: string): string | undefined =>
  source.match(/^\/[^/]+(\/.+)$/)?.[1] ?? undefined;

/**
 * Whether two source-file spellings plausibly name the same module: equal
 * after leading-slash normalization, or one is the other minus its first
 * path segment. Never treats an undefined side as corresponding.
 */
export const writerClaimFilesCorrespond = (
  left: string | undefined,
  right: string | undefined,
): boolean => {
  const a = normalizeIdentitySource(left);
  const b = normalizeIdentitySource(right);
  if (a === undefined || b === undefined) {
    return false;
  }
  if (a === b) {
    return true;
  }
  return dropFirstPathSegment(a) === b || dropFirstPathSegment(b) === a;
};
