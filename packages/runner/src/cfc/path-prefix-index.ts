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
 * A `"*"` in the QUERY follows every child at that depth, which makes the
 * frontier as wide as the set and costs far more than the scan it replaces —
 * measured at 730x on a 256-source set whose queries are all wildcard at the
 * branching segment. So a query carrying one takes the scan instead, and the
 * trie serves the concrete queries it is good at, where the frontier is at most
 * two nodes: the literal child and the `"*"` child. Both shapes are benched.
 */

/** `isPrefix` from `prepare.ts`, for the queries that take the scan. */
const isPrefixOf = (
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

  /** Add a path to the set. Adding the same path twice is a no-op. */
  add(path: readonly string[]): void {
    this.#paths.push(path);
    let node = this.#root;
    for (const segment of path) {
      let next = node.children.get(segment);
      if (next === undefined) {
        next = { children: new Map(), terminal: false };
        node.children.set(segment, next);
      }
      node = next;
    }
    node.terminal = true;
  }

  /** Whether any added path is a prefix of `path`, by `isPrefix`'s rules. */
  hasPrefixOf(path: readonly string[]): boolean {
    if (this.#root.terminal) return true;
    if (path.includes("*")) {
      return this.#paths.some((source) => isPrefixOf(source, path));
    }
    let frontier: Iterable<PathPrefixNode> = [this.#root];
    for (const segment of path) {
      const next = new Set<PathPrefixNode>();
      for (const node of frontier) {
        if (segment === "*") {
          for (const child of node.children.values()) next.add(child);
          continue;
        }
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
