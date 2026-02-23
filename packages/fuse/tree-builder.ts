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
 * Build a filesystem subtree from a JSON value.
 *
 * - null → empty file (jsonType "null")
 * - boolean → file "true"/"false" (jsonType "boolean")
 * - number → file with string representation (jsonType "number")
 * - string → file with raw UTF-8 (jsonType "string")
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
): bigint {
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
      buildJsonTree(tree, dirIno, String(i), value[i], seen);
    }

    return dirIno;
  }

  if (type === "object") {
    const obj = value as Record<string, unknown>;
    const dirIno = tree.addDir(parentIno, name, "object");

    // Add .json sibling for the whole object
    tree.addFile(
      parentIno,
      `${name}.json`,
      safeStringify(value),
      "object",
    );

    // Recurse for each key
    for (const [key, val] of Object.entries(obj)) {
      buildJsonTree(tree, dirIno, key, val, seen);
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
