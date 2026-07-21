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
 * file spelling is diagnostic. The tolerant correspondence below is consumed
 * in exactly one place — `reconcileWriterClaimStamp` (schema-merge.ts), where
 * a stamp minted under the current compile's spelling meets a stored claim
 * carrying an aged spelling of the same binding. It deliberately does NOT
 * gate stamp MINTING (`rebindWriteAuthorizedByClaims` requires exact
 * slash-normalized equality: a claim being stamped rides a schema emitted by
 * the same compile as the writer, so exact holds wherever stamping is
 * genuine), so the tolerance never widens who can create authority — only
 * how an already-minted stamp meets an aged spelling. Residual: at the
 * reconcile-adoption edge, a hostile verified module whose forged path
 * differs from a stored unstamped claim's by one leading segment is accepted
 * where before it needed the exact spelling — a marginal widening of the
 * pre-existing path-forgeability that mint-time identity binding /
 * authenticated `piece setsrc` delegation now closes for legitimate updates.
 *
 * The correspondence is deliberately no wider than the divergence the
 * toolchain actually produced: equal after slash-normalization, or exactly
 * one leading path segment apart (the transformer's strip). Stored claims
 * keep their mint-time spelling forever, so this is permanent aged-store
 * compat.
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
