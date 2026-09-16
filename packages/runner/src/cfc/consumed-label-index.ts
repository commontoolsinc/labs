/**
 * Indexes the label paths a consumed read can overlap, in label-map order.
 * Concrete queries follow one trie branch and check wildcard sources bucketed
 * by their concrete prefix. Wildcard queries scan using the same prefix
 * predicate. Callers still apply origin and read-depth rules to the candidates,
 * which include both ancestors and descendants.
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

  /** Entries whose first wildcard immediately follows this node. */
  wildcard: IndexedEntry[];

  /** Entries at this node and below it, in original map order. */
  descendants: IndexedEntry[];
};

/** An empty path node. */
const createNode = (): Node => ({
  children: new Map(),
  exact: [],
  wildcard: [],
  descendants: [],
});

/** A collection-local snapshot of one validated label map. */
export class ConsumedLabelIndex {
  #root = createNode();

  /** Constructs an instance over validated entries, canonicalizing each path once. */
  constructor(entries: readonly LabelMapEntry[]) {
    for (const [ordinal, entry] of entries.entries()) {
      const path = canonicalizeLogicalPath(entry.path);
      const indexed = { entry, path, ordinal };
      let current = this.#root;
      current.descendants.push(indexed);
      for (const segment of path) {
        if (segment === "*") break;
        let child = current.children.get(segment);
        if (child === undefined) {
          child = createNode();
          current.children.set(segment, child);
        }
        current = child;
        current.descendants.push(indexed);
      }
      if (path.includes("*")) current.wildcard.push(indexed);
      else current.exact.push(indexed);
    }
  }

  /**
   * Ancestor, equal, and descendant entries in their original map order.
   * `path` must already be canonical: a payload field named `value` must not
   * lose another segment when querying the index.
   */
  overlapping(path: readonly string[]): readonly IndexedEntry[] {
    if (path.length === 0) return this.#root.descendants;
    if (path.includes("*")) {
      return this.#root.descendants.filter((source) =>
        isPrefix(source.path, path) || isPrefix(path, source.path)
      );
    }
    const candidates: IndexedEntry[] = [];
    let current = this.#root;
    for (const segment of path) {
      for (const entry of current.exact) candidates.push(entry);
      for (const source of current.wildcard) {
        if (isPrefix(source.path, path) || isPrefix(path, source.path)) {
          candidates.push(source);
        }
      }
      const child = current.children.get(segment);
      if (child === undefined) {
        return candidates.sort((a, b) => a.ordinal - b.ordinal);
      }
      current = child;
    }
    // The query ends at a concrete prefix. Every entry below it overlaps,
    // including wildcard tails bucketed here or at a deeper concrete node.
    for (const entry of current.descendants) candidates.push(entry);
    return candidates.sort((a, b) => a.ordinal - b.ordinal);
  }
}
