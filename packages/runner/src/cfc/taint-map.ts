/**
 * Path-level taint tracking map.
 *
 * Tracks `{path → label}` entries so that builtins like fetchData can inspect
 * which of their input paths carry taint (needed for sink-aware declassification).
 *
 * ## Link-based taint model
 *
 * When a lift passes a cell reference through (e.g., OpaqueCell), `diffAndUpdate`
 * converts it to a link via `getAsLink()` — no `.get()` is called, so no
 * `recordTaintedRead` fires. The linked cell's label is only accumulated when
 * the link is later dereferenced (e.g., by fetchData reading the actual value).
 *
 * **Pattern for lift authors:** Use `OpaqueCell` for pass-through fields to
 * minimize taint. A lift that receives an auth object and builds a fetch request
 * should pass the token cell as an opaque reference into `headers.Authorization`,
 * rather than reading the token string. This way the lift's own taint stays clean,
 * and the token's taint is only accumulated at the known sink path when fetchData
 * dereferences it.
 */

import { emptyLabel, joinLabel, type Label } from "./labels.ts";

export type PathLabel = { path: readonly string[]; label: Label };

/** Serialize a path for use as a map key. */
function pathKey(path: readonly string[]): string {
  return path.join("\0");
}

export class TaintMap {
  private entries = new Map<string, PathLabel>();

  /** Add a path-level taint entry. Joins if path already exists. */
  add(path: readonly string[], label: Label): void {
    const key = pathKey(path);
    const existing = this.entries.get(key);
    if (existing) {
      existing.label = joinLabel(existing.label, label);
    } else {
      this.entries.set(key, { path, label });
    }
  }

  /**
   * Get taint at a specific path. Returns the join of labels at all ancestor
   * paths (taint flows down): `[]`, `["a"]`, `["a", "b"]` all contribute to
   * the label at `["a", "b"]`.
   */
  labelAt(path: readonly string[]): Label {
    let result = emptyLabel();
    for (const entry of this.entries.values()) {
      if (isAncestorOrEqual(entry.path, path)) {
        result = joinLabel(result, entry.label);
      }
    }
    return result;
  }

  /** Get the flat join of all entries (backwards compat). */
  flatLabel(): Label {
    let result = emptyLabel();
    for (const entry of this.entries.values()) {
      result = joinLabel(result, entry.label);
    }
    return result;
  }

  /** Whether the map has any non-empty entries. */
  isEmpty(): boolean {
    return this.entries.size === 0;
  }
}

/** True if `ancestor` is a prefix of (or equal to) `descendant`. */
function isAncestorOrEqual(
  ancestor: readonly string[],
  descendant: readonly string[],
): boolean {
  if (ancestor.length > descendant.length) return false;
  for (let i = 0; i < ancestor.length; i++) {
    if (ancestor[i] !== descendant[i]) return false;
  }
  return true;
}
