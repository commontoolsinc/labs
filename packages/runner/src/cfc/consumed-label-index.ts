/**
 * Indexes the label paths a consumed read can overlap, in label-map order.
 * Concrete paths follow one trie branch; a wildcard on either side uses the
 * same prefix predicate as a scan. Callers still apply origin and read-depth
 * rules to the candidates, which include both ancestors and descendants.
 */

import { canonicalizeLogicalPath } from "./canonical.ts";
import { isPrefix } from "./path-prefix-index.ts";
import type { LabelMapEntry } from "./types.ts";

/** A label entry with its canonical path and original label-map position. */
type IndexedEntry = {
  /** The validated entry supplied by the label map. */
  entry: LabelMapEntry;

  /** The logical path after removing the storage root segment. */
  path: readonly string[];

  /** Position in the label map, used to restore encounter order. */
  ordinal: number;
};

/** Exact entries and the inclusive subtree, each retained in label-map order. */
type Node = {
  /** The next concrete segment of each indexed path. */
  children: Map<string, Node>;

  /** Entries ending at this node. */
  exact: IndexedEntry[];

  /** Entries at this node and below it, in original map order. */
  descendants: IndexedEntry[];
};

/** An empty path node. */
const createNode = (): Node => ({
  children: new Map(),
  exact: [],
  descendants: [],
});

/** A collection-local snapshot of one validated label map. */
export class ConsumedLabelIndex {
  #root = createNode();
  #wildcard = false;

  /** Constructs an instance over validated entries, canonicalizing each path once. */
  constructor(entries: readonly LabelMapEntry[]) {
    for (const [ordinal, entry] of entries.entries()) {
      const path = canonicalizeLogicalPath(entry.path);
      const indexed = { entry, path, ordinal };
      if (path.includes("*")) this.#wildcard = true;
      let current = this.#root;
      current.descendants.push(indexed);
      for (const segment of path) {
        let child = current.children.get(segment);
        if (child === undefined) {
          child = createNode();
          current.children.set(segment, child);
        }
        current = child;
        current.descendants.push(indexed);
      }
      current.exact.push(indexed);
    }
  }

  /**
   * Ancestor, equal, and descendant entries in their original map order.
   * `path` must already be canonical: a payload field named `value` must not
   * lose another segment when querying the index.
   */
  overlapping(path: readonly string[]): readonly IndexedEntry[] {
    if (path.length === 0) return this.#root.descendants;
    if (this.#wildcard || path.includes("*")) {
      return this.#root.descendants.filter((source) =>
        isPrefix(source.path, path) || isPrefix(path, source.path)
      );
    }
    const candidates: IndexedEntry[] = [];
    let current = this.#root;
    for (const segment of path) {
      for (const entry of current.exact) candidates.push(entry);
      const child = current.children.get(segment);
      if (child === undefined) {
        return candidates.sort((a, b) => a.ordinal - b.ordinal);
      }
      current = child;
    }
    for (const entry of current.descendants) candidates.push(entry);
    return candidates.sort((a, b) => a.ordinal - b.ordinal);
  }
}
