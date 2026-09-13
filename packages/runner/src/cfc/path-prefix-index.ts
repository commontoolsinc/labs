/**
 * An index over a set of paths answering the one question `isPrefix` is asked
 * in bulk: is ANY path in the set a prefix of this one?
 *
 * A linear scan costs the set's size per query, and the set is a document's
 * dereference-trace sources — measured at 249 for one pane, consulted once per
 * read activity at commit preparation. A trie costs the query path's length
 * instead, which is small and does not grow with the set.
 *
 * `isPrefix` in `prepare.ts` treats `"*"` as matching any segment, on EITHER
 * side, and this reproduces that: the walk carries a frontier rather than a
 * single node, so a literal segment follows both its own child and the `"*"`
 * child, and a `"*"` segment follows every child. The two are held together by
 * a test that compares them across a generated corpus.
 *
 * A `"*"` in the QUERY would follow every child at that depth, making the
 * frontier as wide as the set and costing far more than the scan it replaces —
 * measured at 730x on a 256-source set whose queries are all wildcard at the
 * branching segment. So a query carrying one takes the scan instead, which is
 * also what keeps the walk's own frontier at two nodes: the literal child and
 * the `"*"` child of a SOURCE. Both shapes are benched.
 */

/**
 * Whether `prefix` prefixes `path`, with `"*"` matching any segment on EITHER
 * side.
 *
 * This is the predicate `PathPrefixIndex` indexes, and the one its wildcard
 * fallback runs directly, so the two cannot be separate definitions: a change
 * to the wildcard rule in one would silently disagree with the other. It lives
 * here rather than in `prepare.ts`, which consumes it in both forms.
 */
export const isPrefix = (
  prefix: readonly string[],
  path: readonly string[],
): boolean =>
  prefix.length <= path.length &&
  prefix.every((segment, index) =>
    segment === path[index] || segment === "*" || path[index] === "*"
  );

type PathPrefixNode = {
  children: Map<string, PathPrefixNode>;
  terminal: boolean;
};

/** A set of paths, queried for whether any of them prefixes a given path. */
export class PathPrefixIndex {
  #root: PathPrefixNode = { children: new Map(), terminal: false };

  /** The same paths, for the wildcard queries the trie is bad at. */
  #paths: (readonly string[])[] = [];

  /**
   * Add a path to the set. Adding the same path twice is a no-op, for the
   * scanned copy as much as for the trie — a duplicate there would be rescanned
   * on every wildcard query for no gain. The path is copied rather than
   * retained, so a caller that reuses a mutable array cannot make the two
   * representations disagree.
   */
  add(path: readonly string[]): void {
    let node = this.#root;
    for (const segment of path) {
      let next = node.children.get(segment);
      if (next === undefined) {
        next = { children: new Map(), terminal: false };
        node.children.set(segment, next);
      }
      node = next;
    }
    if (node.terminal) return;
    node.terminal = true;
    this.#paths.push([...path]);
  }

  /** What the wildcard fallback scans, for a test that pins its contents. */
  get accessForTestingOnly(): { scannedPaths: readonly (readonly string[])[] } {
    return { scannedPaths: this.#paths };
  }

  /** Whether any added path is a prefix of `path`, by `isPrefix`'s rules. */
  hasPrefixOf(path: readonly string[]): boolean {
    if (this.#root.terminal) return true;
    if (path.includes("*")) {
      return this.#paths.some((source) => isPrefix(source, path));
    }
    let frontier: Iterable<PathPrefixNode> = [this.#root];
    for (const segment of path) {
      const next = new Set<PathPrefixNode>();
      for (const node of frontier) {
        // Only a SOURCE wildcard is followed here. A query wildcard took the
        // scan above, so `segment` is always a literal by this point, and the
        // frontier is at most two nodes wide.
        const literal = node.children.get(segment);
        if (literal !== undefined) next.add(literal);
        const wildcard = node.children.get("*");
        if (wildcard !== undefined) next.add(wildcard);
      }
      if (next.size === 0) return false;
      for (const node of next) if (node.terminal) return true;
      frontier = next;
    }
    return false;
  }
}
