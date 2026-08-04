/**
 * Key generation utilities for worker VDOM reconciliation.
 *
 * Keys are used to stably identify children across renders,
 * enabling efficient diffing and reuse of DOM nodes.
 */

import { hashStringOf } from "@commonfabric/data-model/value-hash";
import { isCell } from "@commonfabric/runner";

/**
 * Stands in for a member that has no value-level identity of its own, so that
 * a node carrying one is still distinguishable from a node that does not. A
 * record cannot collide with the string, number, or boolean members a render
 * node otherwise holds.
 */
function marker(kind: string): Record<string, string> {
  return { "@@vdom-key": kind };
}

/**
 * Projects a render node onto a `FabricValue`, which is what
 * `hashStringOf()` can key.
 *
 * A render node is not one already: it holds `Cell`s where reactive values go,
 * and props whose values may be event handlers. Each is replaced by something
 * that stands for it -- a cell by the link it names, a function by a marker,
 * since one render's handler and the next render's are different objects
 * carrying the same meaning.
 *
 * The projection is what makes the key `FabricValue`-aware rather than
 * JSON-aware. `bigint`, `undefined`, `NaN`, and `-0` are all members the hash
 * keeps distinct, where a JSON encoding of the same node either throws or
 * quietly maps several of them together.
 *
 * @param node The render node to project.
 * @param seen Ancestors of `node`, so a cycle is answered rather than followed.
 */
function keyProjection(node: unknown, seen: Set<object>): unknown {
  if (node === null) return null;

  switch (typeof node) {
    case "undefined":
    case "boolean":
    case "string":
    case "number":
    case "bigint":
      return node;
    case "symbol":
      // An interned symbol is a fabric value and keys as itself; a unique one
      // has no portable identity, so every unique symbol keys alike.
      return Symbol.keyFor(node) === undefined ? marker("symbol") : node;
    case "function":
      return marker("function");
  }

  if (isCell(node)) {
    // The link a cell names, which is stable across renders where the cell
    // object need not be. A cell with no link yet has nothing to name.
    return node.toSigilLinkOrNull() ?? marker("unlinked-cell");
  }

  if (seen.has(node)) return marker("cycle");
  seen.add(node);
  try {
    if (Array.isArray(node)) {
      // Holes are not members; a hole and an `undefined` element are different
      // nodes and key differently.
      return node.map((element, i) =>
        i in node ? keyProjection(element, seen) : marker("hole")
      );
    }
    // Enumerable string keys only, which is the set a render node's members
    // live in. A symbol-keyed member is machinery rather than content.
    return Object.fromEntries(
      Object.entries(node).map(([key, value]) => [
        key,
        keyProjection(value, seen),
      ]),
    );
  } finally {
    seen.delete(node);
  }
}

/**
 * Generate a stable key for a render node.
 *
 * The key is a hash of the node's projection onto a `FabricValue` (see
 * `keyProjection`), so two nodes key alike exactly when they carry the same
 * content, and a member the hash can tell apart -- `1n` from `1`, `-0` from
 * `0`, a present `undefined` from an absent member -- keys them apart.
 *
 * @param node - The render node to generate a key for
 * @returns A stable string key
 */
export function generateKey(node: unknown): string {
  return hashStringOf(keyProjection(node, new Set()) as never);
}

/**
 * Generate unique keys for a list of children.
 *
 * Handles duplicate keys by appending an occurrence count,
 * ensuring each child has a unique key while maintaining stability
 * for identical structures.
 *
 * @param children - Array of child nodes
 * @returns Array of unique keys in the same order as children
 */
export function generateChildKeys(children: readonly unknown[]): string[] {
  const keys: string[] = [];
  const occurrence = new Map<string, number>();

  for (const child of children) {
    const rawKey = generateKey(child);
    const count = occurrence.get(rawKey) ?? 0;
    occurrence.set(rawKey, count + 1);

    // Composite key ensures uniqueness for structurally identical children
    keys.push(`${rawKey}-${count}`);
  }

  return keys;
}

/**
 * Check if two keys represent the same node identity.
 * Used for determining if a node can be reused vs recreated.
 */
export function keysMatch(oldKey: string, newKey: string): boolean {
  return oldKey === newKey;
}
