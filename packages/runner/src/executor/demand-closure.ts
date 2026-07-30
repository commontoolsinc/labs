/**
 * D2 (client-passivity §5h.4): a lane's demand slice covers a piece when the
 * piece IS a demanded root **or descends from one**.
 *
 * The demand wire carries ROOTS — what a client wants rendered. Everything else
 * in the executor's graph is a child sub-pattern the runtime instantiated to
 * satisfy one of those roots (`instantiatePatternNode` -> `run` ->
 * `startWithTx`), and that set is data-dependent: a `map` whose elements are
 * sub-patterns mints a piece per element. Publishing demand per child would put
 * the server's own execution graph on the client's wire and churn it with the
 * data, which is why `bc3681e42` deliberately excluded `startWithTx` from the
 * demand publication seams. The closure is the server's business, so the
 * SERVER rolls up instead.
 *
 * Without the roll-up, scoped-rank candidacy is piece-filtered against demand
 * roots alone, so an action in a child sub-pattern can never be a scoped
 * candidate (20 such pieces in the flagship group-chat probe) while space-rank
 * candidacy has no such filter and the host has none either — the asymmetry
 * that left `cf:builtin/map:v1` unable to be served at user or session rank.
 *
 * Roll-up is a WIDENING of candidacy, never of authority: the host still
 * requires a live lane grant for the claim's context key, and the engine still
 * lane-checks every summary address against the claim's own chain.
 */

/** Depth bound for the ancestry walk. Piece nesting is authored structure, not
 * data, so real chains are shallow; the bound only stops a cycle introduced by
 * a bug from hanging the router. */
export const MAX_DEMAND_CLOSURE_DEPTH = 64;

/**
 * `pieceId` followed by its piece ancestors, nearest first — the chain a lane's
 * demand slice is matched against. Stops at the first repeated id (cycle) or at
 * {@link MAX_DEMAND_CLOSURE_DEPTH}.
 *
 * @param parentOf Parent piece id of a child piece, or `undefined` for a root.
 */
export function demandClosureChain(
  pieceId: string,
  parentOf: (pieceId: string) => string | undefined,
): string[] {
  const chain = [pieceId];
  const seen = new Set([pieceId]);
  let current = pieceId;
  for (let depth = 0; depth < MAX_DEMAND_CLOSURE_DEPTH; depth++) {
    const parent = parentOf(current);
    if (parent === undefined || seen.has(parent)) break;
    seen.add(parent);
    chain.push(parent);
    current = parent;
  }
  return chain;
}

/**
 * Does this lane's demand slice cover `pieceId`, directly or through an
 * ancestor? Walks the chain lazily so the common case — the piece is itself a
 * demanded root — costs one set lookup.
 */
export function laneSliceCoversPiece(
  slice: ReadonlySet<string>,
  pieceId: string,
  parentOf: (pieceId: string) => string | undefined,
): boolean {
  if (slice.has(pieceId)) return true;
  const seen = new Set([pieceId]);
  let current = pieceId;
  for (let depth = 0; depth < MAX_DEMAND_CLOSURE_DEPTH; depth++) {
    const parent = parentOf(current);
    if (parent === undefined || seen.has(parent)) return false;
    if (slice.has(parent)) return true;
    seen.add(parent);
    current = parent;
  }
  return false;
}
