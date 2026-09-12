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
 */

type PathPrefixNode = {
  children: Map<string, PathPrefixNode>;
  terminal: boolean;
};

/** A set of paths, queried for whether any of them prefixes a given path. */
export class PathPrefixIndex {
  #root: PathPrefixNode = { children: new Map(), terminal: false };

  /** Add a path to the set. Adding the same path twice is a no-op. */
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
    node.terminal = true;
  }

  /** Whether any added path is a prefix of `path`, by `isPrefix`'s rules. */
  hasPrefixOf(path: readonly string[]): boolean {
    if (this.#root.terminal) return true;
    let frontier = [this.#root];
    for (const segment of path) {
      const next: PathPrefixNode[] = [];
      for (const node of frontier) {
        if (segment === "*") {
          for (const child of node.children.values()) next.push(child);
          continue;
        }
        const literal = node.children.get(segment);
        if (literal !== undefined) next.push(literal);
        const wildcard = node.children.get("*");
        if (wildcard !== undefined && segment !== "*") next.push(wildcard);
      }
      if (next.length === 0) return false;
      for (const node of next) if (node.terminal) return true;
      frontier = next;
    }
    return false;
  }
}
