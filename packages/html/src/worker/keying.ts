/**
 * Key generation utilities for worker VDOM reconciliation.
 *
 * Keys are used to stably identify children across renders,
 * enabling efficient diffing and reuse of DOM nodes.
 */

import { isCell } from "@commontools/runner";

/**
 * Generate a stable key for a render node.
 *
 * This uses JSON.stringify with a custom replacer that converts
 * Cell references to their normalized link format, ensuring the
 * same key is generated regardless of whether we're in the worker
 * or main thread.
 *
 * @param node - The render node to generate a key for
 * @returns A stable string key
 */
export function generateKey(node: unknown): string {
  try {
    // Cell.toJSON() is called by JSON.stringify, producing a stable ID
    // based on the cell's link (space/id/path), not its current data.
    // The cellReplacer handles nested Cells that aren't top-level.
    return JSON.stringify(node, cellReplacer);
  } catch {
    // Circular structure or other JSON error - use fallback
    return generateFallbackKey(node);
  }
}

/**
 * JSON replacer function that converts Cells to their link representation.
 * This ensures keys match between worker and main thread.
 */
function cellReplacer(_key: string, value: unknown): unknown {
  if (isCell(value)) {
    // Use getAsNormalizedFullLink
    return value.getAsNormalizedFullLink();
  }
  return value;
}

/**
 * Generate a fallback key for nodes that can't be JSON stringified.
 * Uses a simple type-based key that may result in more DOM recreation
 * but ensures the reconciler doesn't fail.
 */
function generateFallbackKey(node: unknown): string {
  if (node === null || node === undefined) {
    return "__null__";
  }

  if (typeof node === "string") {
    return `__text__${node.slice(0, 100)}`;
  }

  if (typeof node === "number") {
    return `__num__${node}`;
  }

  if (typeof node === "boolean") {
    return `__bool__${node}`;
  }

  if (Array.isArray(node)) {
    return `__array__${node.length}`;
  }

  if (isCell(node)) {
    try {
      const link = node.getAsNormalizedFullLink();
      return `__cell__${link.space}:${link.id}:${link.path.join("/")}`;
    } catch {
      return "__cell__unknown";
    }
  }

  if (typeof node === "object" && node !== null && "type" in node) {
    const vnode = node as { type: string; name?: string };
    if (vnode.type === "vnode" && vnode.name) {
      return `__vnode__${vnode.name}`;
    }
  }

  return "__unknown__";
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
