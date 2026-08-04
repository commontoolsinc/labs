/**
 * Key generation utilities for worker VDOM reconciliation.
 *
 * Keys are used to stably identify children across renders,
 * enabling efficient diffing and reuse of DOM nodes.
 */

import type { FabricValue } from "@commonfabric/data-model/fabric-value";
import { isNativeError } from "@commonfabric/data-model/native-type-tags";
import { hashStringOf } from "@commonfabric/data-model/value-hash";
import { isCell } from "@commonfabric/runner";

/**
 * Tags a projected container, so that what a value WAS is part of what it keys
 * as. Everything but a primitive is tagged, which also keeps the projection
 * unambiguous: a record projects to a tagged pair list rather than to a record,
 * so no member name of the caller's can collide with a tag, and no member name
 * this runtime reserves (`__proto__`, `constructor`) can appear as a key at
 * all.
 */
function tagged(kind: string, ...parts: FabricValue[]): FabricValue {
  return [`@@${kind}`, ...parts];
}

/**
 * Projects a render node onto a `FabricValue`, which is what `hashStringOf()`
 * keys.
 *
 * A render node is not one: it holds `Cell`s where reactive values go, props
 * whose values may be event handlers, and whatever else a pattern author put
 * there. Each is replaced by something that stands for it -- a cell by the link
 * it names, a function by a tag, since one render's handler and the next
 * render's are different objects carrying the same meaning.
 *
 * Every input has an answer here, and every answer is a `FabricValue`. Both
 * halves are load-bearing: a reconciler cannot survive a key that throws, and
 * a value whose state the projection does not read keys the same as every
 * other value it does not read.
 *
 * So a native type that is not a `FabricValue` -- a `Date`, a `Map`, a typed
 * array -- is projected by reading the state that holds it, which its
 * enumerable members do not.
 *
 * @param node The render node to project.
 * @param seen Ancestors of `node`, so a cycle is answered rather than followed.
 */
function keyProjection(node: unknown, seen: Set<object>): FabricValue {
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
      return Symbol.keyFor(node) === undefined ? tagged("symbol") : node;
    case "function":
      return tagged("function");
  }

  if (isCell(node)) {
    // The link a cell names, which is stable across renders where the cell
    // object need not be. A cell with no link yet has nothing to name.
    const link = node.toSigilLinkOrNull();
    return link === null ? tagged("cell") : tagged("link", link as FabricValue);
  }

  if (seen.has(node)) return tagged("cycle");
  seen.add(node);
  try {
    if (Array.isArray(node)) {
      // A hole holds nothing, and is not the `undefined` element that reading
      // one would report.
      return tagged(
        "arr",
        node.map((element, i) =>
          i in node ? keyProjection(element, seen) : tagged("hole")
        ),
      );
    }

    // Native types with state the enumeration below cannot see. Each keeps its
    // own shape, so two that differ key differently.
    if (node instanceof Date) return tagged("date", node.getTime());
    if (node instanceof RegExp) {
      return tagged("regexp", node.source, node.flags);
    }
    if (ArrayBuffer.isView(node)) {
      const bytes = new Uint8Array(
        node.buffer,
        node.byteOffset,
        node.byteLength,
      );
      return tagged("bytes", [...bytes]);
    }
    if (node instanceof Map) {
      return tagged(
        "map",
        [...node].map((
          [k, v],
        ) => [keyProjection(k, seen), keyProjection(v, seen)]),
      );
    }
    if (node instanceof Set) {
      return tagged("set", [...node].map((v) => keyProjection(v, seen)));
    }
    if (isNativeError(node)) {
      return tagged("error", node.name, node.message);
    }

    // Anything else, by its own enumerable string keys -- the set a render
    // node's members live in. A symbol-keyed member is machinery rather than
    // content. Pairs rather than a record: see `tagged`.
    return tagged(
      "rec",
      Object.entries(node).map((
        [key, value],
      ) => [key, keyProjection(value, seen)]),
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
  return hashStringOf(keyProjection(node, new Set()));
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
