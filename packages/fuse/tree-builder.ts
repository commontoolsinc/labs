// tree-builder.ts — Convert JSON values to FsTree nodes

import { FsTree } from "./tree.ts";

/**
 * JSON.stringify that replaces circular references with "[Circular]".
 */
export function safeStringify(value: unknown, indent = 2): string {
  const seen = new WeakSet();
  return JSON.stringify(
    value,
    (_key, val) => {
      if (val !== null && typeof val === "object") {
        if (seen.has(val)) return "[Circular]";
        seen.add(val);
      }
      return val;
    },
    indent,
  );
}

/**
 * Detect stream marker values: { $stream: true }
 *
 * Inline implementation to avoid importing @commontools/runner.
 */
export function isStreamValue(v: unknown): boolean {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const obj = v as Record<string, unknown>;
  return "$stream" in obj && obj.$stream === true;
}

/**
 * Replace stream markers with handler sigils for JSON serialization.
 * { $stream: true } → { "/handler": "<key>" }
 *
 * Only creates a new object when stream markers are present.
 * Returns the original reference otherwise, preserving circular-ref
 * identity for safeStringify's WeakSet-based detection.
 */
export function transformStreamValues(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return value;
  }
  const obj = value as Record<string, unknown>;
  // Only allocate a new object if there are stream markers to replace
  let hasStreams = false;
  for (const val of Object.values(obj)) {
    if (isStreamValue(val)) {
      hasStreams = true;
      break;
    }
  }
  if (!hasStreams) return value;
  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(obj)) {
    if (isStreamValue(val)) {
      result[key] = { "/handler": key };
    } else {
      result[key] = val;
    }
  }
  return result;
}

/**
 * Detect sigil link values: { "/": { "link@1": { ... } } }
 *
 * Inline implementation to avoid importing @commontools/runner.
 */
export function isSigilLink(v: unknown): boolean {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const obj = v as Record<string, unknown>;
  if (!("/" in obj) || Object.keys(obj).length !== 1) return false;
  const inner = obj["/"];
  if (typeof inner !== "object" || inner === null || Array.isArray(inner)) {
    return false;
  }
  return "link@1" in (inner as Record<string, unknown>);
}

/** Options for buildJsonTree beyond the required params. */
export interface BuildJsonTreeOpts {
  seen?: WeakSet<object>;
  resolveLink?: (value: unknown, depth: number) => string | null;
  depth?: number;
}

/**
 * Build a filesystem subtree from a JSON value.
 *
 * - null → empty file (jsonType "null")
 * - boolean → file "true"/"false" (jsonType "boolean")
 * - number → file with string representation (jsonType "number")
 * - string → file with raw UTF-8 (jsonType "string")
 * - sigil link → symlink (if resolveLink provided and returns a path)
 * - object → directory, recurse for each key (jsonType "object")
 * - array → directory, recurse with numeric indices (jsonType "array")
 *
 * Circular references are replaced with "[Circular]".
 * Also synthesizes `.json` sibling files for directory nodes.
 */
export function buildJsonTree(
  tree: FsTree,
  parentIno: bigint,
  name: string,
  value: unknown,
  seen?: WeakSet<object>,
  resolveLink?: (value: unknown, depth: number) => string | null,
  depth?: number,
): bigint {
  const d = depth ?? 0;

  if (value === null || value === undefined) {
    return tree.addFile(parentIno, name, "", "null");
  }

  // Detect circular references
  if (typeof value === "object") {
    if (!seen) seen = new WeakSet();
    if (seen.has(value as object)) {
      return tree.addFile(parentIno, name, "[Circular]", "string");
    }
    seen.add(value as object);
  }

  // Sigil link → symlink
  if (isSigilLink(value) && resolveLink) {
    const target = resolveLink(value, d);
    if (target) {
      return tree.addSymlink(parentIno, name, target);
    }
    // Fall through to normal object handling if link can't be resolved
  }

  const type = typeof value;

  if (type === "boolean") {
    return tree.addFile(
      parentIno,
      name,
      String(value),
      "boolean",
    );
  }

  if (type === "number") {
    return tree.addFile(
      parentIno,
      name,
      String(value),
      "number",
    );
  }

  if (type === "string") {
    return tree.addFile(
      parentIno,
      name,
      value as string,
      "string",
    );
  }

  if (Array.isArray(value)) {
    const dirIno = tree.addDir(parentIno, name, "array");

    // Add .json sibling for the whole array
    tree.addFile(
      parentIno,
      `${name}.json`,
      safeStringify(value),
      "array",
    );

    // Recurse for each element
    for (let i = 0; i < value.length; i++) {
      buildJsonTree(
        tree,
        dirIno,
        String(i),
        value[i],
        seen,
        resolveLink,
        d + 1,
      );
    }

    return dirIno;
  }

  if (type === "object") {
    const obj = value as Record<string, unknown>;
    const dirIno = tree.addDir(parentIno, name, "object");

    // Add .json sibling, replacing stream markers with handler sigils
    tree.addFile(
      parentIno,
      `${name}.json`,
      safeStringify(transformStreamValues(value)),
      "object",
    );

    // Recurse for each key, skipping stream values (handler files created separately)
    for (const [key, val] of Object.entries(obj)) {
      if (isStreamValue(val)) continue;
      buildJsonTree(tree, dirIno, key, val, seen, resolveLink, d + 1);
    }

    return dirIno;
  }

  // Fallback: stringify anything else
  return tree.addFile(
    parentIno,
    name,
    String(value),
    "string",
  );
}
