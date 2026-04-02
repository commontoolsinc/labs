// tree-builder.ts — Convert JSON values to FsTree nodes

import {
  type CallableKind,
  isHandlerCell,
  isStreamValue,
  transformCallableValues,
} from "./callables.ts";
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
 * Replace stream markers and handler sigil links with handler sigils for JSON.
 * { $stream: true } → { "/handler": "<key>" }
 * { "/": { "link@1": { path: ["internal", ...] } } } → { "/handler": "<key>" }
 *
 * Only creates a new object when replacements are present.
 * Returns the original reference otherwise, preserving circular-ref
 * identity for safeStringify's WeakSet-based detection.
 */
export function transformStreamValues(value: unknown): unknown {
  return transformCallableValues(
    value,
    (_key, candidate) =>
      isStreamValue(candidate) || isHandlerCell(candidate) ? "handler" : null,
  );
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

export { isHandlerCell, isStreamValue } from "./callables.ts";

/** Returns true if the value is a VNode (virtual DOM element). */
export function isVNode(value: unknown): boolean {
  return typeof value === "object" && value !== null &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).type === "vnode";
}

/**
 * Resolved shape of a [FS] projection value, after reading from cells.
 * Mirrors the FsProjection API type but with the plain-object case
 * normalized into the explicit application/json form.
 */
export type FsValue =
  | {
    type: "text/markdown";
    content: string;
    frontmatter?: Record<string, unknown>;
  }
  | {
    type: "application/json";
    content: Record<string, unknown>;
  };

function isFrontmatterPrimitive(val: unknown): boolean {
  return val === null || val === undefined || typeof val === "string" ||
    typeof val === "number" || typeof val === "boolean";
}

/**
 * Build a single-file filesystem projection from a [FS] value.
 *
 * - text/markdown  → index.md  (YAML frontmatter + body)
 *   Primitive frontmatter fields go into YAML.
 *   Complex fields (objects, arrays of entities) become subdirectories
 *   alongside index.md via `buildSubtree`.
 * - application/json → index.json (flat JSON object)
 *
 * `entityId` is always injected first (read-only field).
 * Returns the inode of the created file.
 */
export function buildFsProjection(
  tree: FsTree,
  parentIno: bigint,
  fsValue: FsValue,
  entityId: string,
  buildSubtree?: (parentIno: bigint, name: string, value: unknown) => void,
): bigint {
  if (fsValue.type === "text/markdown") {
    const fmLines: string[] = [`entityId: ${entityId}`];
    if (fsValue.frontmatter) {
      for (const [key, val] of Object.entries(fsValue.frontmatter)) {
        // Skip entityId if pattern accidentally includes it
        if (key === "entityId") continue;
        if (isFrontmatterPrimitive(val)) {
          fmLines.push(`${key}: ${String(val ?? "")}`);
        } else if (buildSubtree) {
          // Arrays of entities or nested objects can't be expressed in YAML
          // frontmatter — render as a sibling directory instead.
          buildSubtree(parentIno, key, val);
        }
      }
    }
    const body = String(fsValue.content ?? "");
    const fileContent = `---\n${fmLines.join("\n")}\n---\n\n${body}`;
    return tree.addFile(parentIno, "index.md", fileContent, "string");
  }

  if (fsValue.type === "application/json") {
    const { entityId: _skipEntityId, ...safeContent } = fsValue.content ?? {};
    const obj = { entityId, ...safeContent };
    return tree.addFile(parentIno, "index.json", safeStringify(obj), "object");
  }

  // Fallback: unknown type
  return tree.addFile(
    parentIno,
    "index.txt",
    safeStringify(fsValue),
    "object",
  );
}

/** Options for buildJsonTree beyond the required params. */
export interface BuildJsonTreeOpts {
  seen?: WeakSet<object>;
  resolveLink?: (value: unknown, depth: number) => string | null;
  depth?: number;
}

const ASYNC_BUILD_BATCH_SIZE = 200;

interface BuildJsonTreeTask {
  parentIno: bigint;
  name: string;
  value: unknown;
  seen?: WeakSet<object>;
  depth: number;
  onBuilt?: (ino: bigint) => void;
}

function buildJsonLeaf(
  tree: FsTree,
  parentIno: bigint,
  name: string,
  value: unknown,
): bigint {
  if (value === null || value === undefined) {
    return tree.addFile(parentIno, name, "", "null");
  }

  if (typeof value === "boolean") {
    return tree.addFile(parentIno, name, String(value), "boolean");
  }

  if (typeof value === "number") {
    return tree.addFile(parentIno, name, String(value), "number");
  }

  if (typeof value === "string") {
    return tree.addFile(parentIno, name, value, "string");
  }

  return tree.addFile(parentIno, name, String(value), "string");
}

async function yieldToEventLoop(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
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
  skipEntry?: (value: unknown) => boolean,
  classifyCallableEntry?: (key: string, value: unknown) => CallableKind | null,
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
        skipEntry,
        classifyCallableEntry,
      );
    }

    return dirIno;
  }

  if (type === "object") {
    const obj = value as Record<string, unknown>;
    const dirIno = tree.addDir(parentIno, name, "object");

    // Add .json sibling, replacing stream/handler values with handler sigils
    const jsonValue = d === 0
      ? classifyCallableEntry
        ? transformCallableValues(
          value,
          classifyCallableEntry,
        )
        : transformStreamValues(value)
      : value;
    tree.addFile(
      parentIno,
      `${name}.json`,
      safeStringify(jsonValue),
      "object",
    );

    // Recurse for each key, skipping stream/handler values (handler files created separately)
    for (const [key, val] of Object.entries(obj)) {
      if (isStreamValue(val) || isHandlerCell(val)) continue;
      if (skipEntry?.(val)) continue;
      buildJsonTree(
        tree,
        dirIno,
        key,
        val,
        seen,
        resolveLink,
        d + 1,
        skipEntry,
        classifyCallableEntry,
      );
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

export async function buildJsonTreeAsync(
  tree: FsTree,
  parentIno: bigint,
  name: string,
  value: unknown,
  seen?: WeakSet<object>,
  resolveLink?: (value: unknown, depth: number) => string | null,
  depth?: number,
  skipEntry?: (value: unknown) => boolean,
  classifyCallableEntry?: (key: string, value: unknown) => CallableKind | null,
): Promise<bigint> {
  const queue: BuildJsonTreeTask[] = [{
    parentIno,
    name,
    value,
    seen,
    depth: depth ?? 0,
  }];
  let nextIndex = 0;
  let processed = 0;
  let rootIno: bigint | undefined;

  queue[0].onBuilt = (ino) => {
    rootIno = ino;
  };

  while (nextIndex < queue.length) {
    const task = queue[nextIndex++];
    const d = task.depth;
    const candidate = task.value;

    let builtIno: bigint | undefined;

    if (candidate === null || candidate === undefined) {
      builtIno = buildJsonLeaf(tree, task.parentIno, task.name, candidate);
    } else if (typeof candidate === "object") {
      const objectValue = candidate as object;
      const taskSeen = task.seen ?? new WeakSet<object>();
      if (taskSeen.has(objectValue)) {
        builtIno = tree.addFile(
          task.parentIno,
          task.name,
          "[Circular]",
          "string",
        );
      } else {
        taskSeen.add(objectValue);

        if (isSigilLink(candidate) && resolveLink) {
          const target = resolveLink(candidate, d);
          if (target) {
            builtIno = tree.addSymlink(task.parentIno, task.name, target);
          }
        }

        if (builtIno === undefined) {
          if (Array.isArray(candidate)) {
            builtIno = tree.addDir(task.parentIno, task.name, "array");
            tree.addFile(
              task.parentIno,
              `${task.name}.json`,
              safeStringify(candidate),
              "array",
            );

            for (let i = 0; i < candidate.length; i++) {
              queue.push({
                parentIno: builtIno,
                name: String(i),
                value: candidate[i],
                seen: taskSeen,
                depth: d + 1,
              });
            }
          } else {
            const obj = candidate as Record<string, unknown>;
            builtIno = tree.addDir(task.parentIno, task.name, "object");
            const jsonValue = d === 0
              ? classifyCallableEntry
                ? transformCallableValues(candidate, classifyCallableEntry)
                : transformStreamValues(candidate)
              : candidate;
            tree.addFile(
              task.parentIno,
              `${task.name}.json`,
              safeStringify(jsonValue),
              "object",
            );

            for (const [key, val] of Object.entries(obj)) {
              if (isStreamValue(val) || isHandlerCell(val)) continue;
              if (skipEntry?.(val)) continue;
              queue.push({
                parentIno: builtIno,
                name: key,
                value: val,
                seen: taskSeen,
                depth: d + 1,
              });
            }
          }
        }
      }
    } else {
      builtIno = buildJsonLeaf(tree, task.parentIno, task.name, candidate);
    }

    task.onBuilt?.(builtIno!);
    processed++;
    if (processed % ASYNC_BUILD_BATCH_SIZE === 0) {
      await yieldToEventLoop();
    }
  }

  return rootIno!;
}
