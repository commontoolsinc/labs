// tree-builder.ts — Convert JSON values to FsTree nodes

import {
  type CallableKind,
  isHandlerCell,
  isStreamValue,
  transformCallableValues,
} from "./callables.ts";
import type { CfcJsonAnnotationContext } from "./annotations.ts";
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
 * Inline implementation to avoid importing @commonfabric/runner.
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
  annotation?: CfcJsonAnnotationContext;
}

const ASYNC_BUILD_BATCH_SIZE = 200;

interface BuildJsonTreeTask {
  parentIno: bigint;
  name: string;
  value: unknown;
  seen?: WeakSet<object>;
  depth: number;
  annotation?: CfcJsonAnnotationContext;
  onBuilt?: (ino: bigint) => void;
}

function buildJsonLeaf(
  tree: FsTree,
  parentIno: bigint,
  name: string,
  value: unknown,
  annotation?: CfcJsonAnnotationContext,
): bigint {
  let ino: bigint;
  if (value === null || value === undefined) {
    ino = tree.addFile(parentIno, name, "", "null");
    annotation?.annotator.annotateJsonScalar(ino, annotation.path, value);
    return ino;
  }

  if (typeof value === "boolean") {
    ino = tree.addFile(parentIno, name, String(value), "boolean");
    annotation?.annotator.annotateJsonScalar(ino, annotation.path, value);
    return ino;
  }

  if (typeof value === "number") {
    ino = tree.addFile(parentIno, name, String(value), "number");
    annotation?.annotator.annotateJsonScalar(ino, annotation.path, value);
    return ino;
  }

  if (typeof value === "string") {
    ino = tree.addFile(parentIno, name, value, "string");
    annotation?.annotator.annotateJsonScalar(ino, annotation.path, value);
    return ino;
  }

  ino = tree.addFile(parentIno, name, String(value), "string");
  annotation?.annotator.annotateJsonScalar(ino, annotation.path, value);
  return ino;
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
  annotation?: CfcJsonAnnotationContext,
): bigint {
  const d = depth ?? 0;

  if (value === null || value === undefined) {
    const ino = tree.addFile(parentIno, name, "", "null");
    annotation?.annotator.annotateJsonScalar(ino, annotation.path, value);
    annotation?.annotator.annotateEntry(parentIno, name, ino, {
      labelPath: annotation.path,
    });
    return ino;
  }

  // Detect circular references
  if (typeof value === "object") {
    if (!seen) seen = new WeakSet();
    if (seen.has(value as object)) {
      const ino = tree.addFile(parentIno, name, "[Circular]", "string");
      annotation?.annotator.annotateJsonScalar(ino, annotation.path, value);
      annotation?.annotator.annotateEntry(parentIno, name, ino, {
        labelPath: annotation.path,
      });
      return ino;
    }
    seen.add(value as object);
  }

  // Sigil link → symlink
  if (isSigilLink(value) && resolveLink) {
    const target = resolveLink(value, d);
    if (target) {
      const ino = tree.addSymlink(parentIno, name, target);
      annotation?.annotator.annotateJsonSymlink(ino, annotation.path, target);
      annotation?.annotator.annotateEntry(parentIno, name, ino, {
        labelPath: annotation.path,
      });
      return ino;
    }
    // Fall through to normal object handling if link can't be resolved
  }

  const type = typeof value;

  if (type === "boolean") {
    const ino = tree.addFile(
      parentIno,
      name,
      String(value),
      "boolean",
    );
    annotation?.annotator.annotateJsonScalar(ino, annotation.path, value);
    annotation?.annotator.annotateEntry(parentIno, name, ino, {
      labelPath: annotation.path,
    });
    return ino;
  }

  if (type === "number") {
    const ino = tree.addFile(
      parentIno,
      name,
      String(value),
      "number",
    );
    annotation?.annotator.annotateJsonScalar(ino, annotation.path, value);
    annotation?.annotator.annotateEntry(parentIno, name, ino, {
      labelPath: annotation.path,
    });
    return ino;
  }

  if (type === "string") {
    const ino = tree.addFile(
      parentIno,
      name,
      value as string,
      "string",
    );
    annotation?.annotator.annotateJsonScalar(ino, annotation.path, value);
    annotation?.annotator.annotateEntry(parentIno, name, ino, {
      labelPath: annotation.path,
    });
    return ino;
  }

  if (Array.isArray(value)) {
    const dirIno = tree.addDir(parentIno, name, "array");
    annotation?.annotator.annotateJsonDirectory(dirIno, annotation.path, value);
    annotation?.annotator.annotateEntry(parentIno, name, dirIno, {
      labelPath: annotation.path,
    });

    // Add .json sibling for the whole array
    const jsonIno = tree.addFile(
      parentIno,
      `${name}.json`,
      safeStringify(value),
      "array",
    );
    annotation?.annotator.annotateJsonAggregate(
      jsonIno,
      annotation.path,
      value,
    );
    annotation?.annotator.annotateEntry(parentIno, `${name}.json`, jsonIno, {
      labelPath: annotation.path,
    });

    // Recurse for each element
    for (let i = 0; i < value.length; i++) {
      const childAnnotation = annotation?.annotator.childContext(
        annotation,
        i,
      );
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
        childAnnotation,
      );
    }

    return dirIno;
  }

  if (type === "object") {
    const obj = value as Record<string, unknown>;
    const dirIno = tree.addDir(parentIno, name, "object");
    annotation?.annotator.annotateJsonDirectory(dirIno, annotation.path, value);
    annotation?.annotator.annotateEntry(parentIno, name, dirIno, {
      labelPath: annotation.path,
    });

    // Add .json sibling, replacing stream/handler values with handler sigils
    const jsonValue = d === 0
      ? classifyCallableEntry
        ? transformCallableValues(
          value,
          classifyCallableEntry,
        )
        : transformStreamValues(value)
      : value;
    const jsonIno = tree.addFile(
      parentIno,
      `${name}.json`,
      safeStringify(jsonValue),
      "object",
    );
    annotation?.annotator.annotateJsonAggregate(
      jsonIno,
      annotation.path,
      jsonValue,
    );
    annotation?.annotator.annotateEntry(parentIno, `${name}.json`, jsonIno, {
      labelPath: annotation.path,
    });

    // Recurse for each key, skipping stream/handler values (handler files created separately)
    for (const [key, val] of Object.entries(obj)) {
      if (isStreamValue(val) || isHandlerCell(val)) continue;
      if (skipEntry?.(val)) continue;
      const childAnnotation = annotation?.annotator.childContext(
        annotation,
        key,
      );
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
        childAnnotation,
      );
    }

    return dirIno;
  }

  // Fallback: stringify anything else
  const ino = tree.addFile(
    parentIno,
    name,
    String(value),
    "string",
  );
  annotation?.annotator.annotateJsonScalar(ino, annotation.path, value);
  annotation?.annotator.annotateEntry(parentIno, name, ino, {
    labelPath: annotation.path,
  });
  return ino;
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
  annotation?: CfcJsonAnnotationContext,
): Promise<bigint> {
  const queue: BuildJsonTreeTask[] = [{
    parentIno,
    name,
    value,
    seen,
    depth: depth ?? 0,
    annotation,
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
      builtIno = buildJsonLeaf(
        tree,
        task.parentIno,
        task.name,
        candidate,
        task.annotation,
      );
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
        task.annotation?.annotator.annotateJsonScalar(
          builtIno,
          task.annotation.path,
          candidate,
        );
      } else {
        taskSeen.add(objectValue);

        if (isSigilLink(candidate) && resolveLink) {
          const target = resolveLink(candidate, d);
          if (target) {
            builtIno = tree.addSymlink(task.parentIno, task.name, target);
            task.annotation?.annotator.annotateJsonSymlink(
              builtIno,
              task.annotation.path,
              target,
            );
          }
        }

        if (builtIno === undefined) {
          if (Array.isArray(candidate)) {
            builtIno = tree.addDir(task.parentIno, task.name, "array");
            task.annotation?.annotator.annotateJsonDirectory(
              builtIno,
              task.annotation.path,
              candidate,
            );
            const jsonIno = tree.addFile(
              task.parentIno,
              `${task.name}.json`,
              safeStringify(candidate),
              "array",
            );
            task.annotation?.annotator.annotateJsonAggregate(
              jsonIno,
              task.annotation.path,
              candidate,
            );
            task.annotation?.annotator.annotateEntry(
              task.parentIno,
              `${task.name}.json`,
              jsonIno,
              { labelPath: task.annotation.path },
            );

            for (let i = 0; i < candidate.length; i++) {
              queue.push({
                parentIno: builtIno,
                name: String(i),
                value: candidate[i],
                seen: taskSeen,
                depth: d + 1,
                annotation: task.annotation?.annotator.childContext(
                  task.annotation,
                  i,
                ),
              });
            }
          } else {
            const obj = candidate as Record<string, unknown>;
            builtIno = tree.addDir(task.parentIno, task.name, "object");
            task.annotation?.annotator.annotateJsonDirectory(
              builtIno,
              task.annotation.path,
              candidate,
            );
            const jsonValue = d === 0
              ? classifyCallableEntry
                ? transformCallableValues(candidate, classifyCallableEntry)
                : transformStreamValues(candidate)
              : candidate;
            const jsonIno = tree.addFile(
              task.parentIno,
              `${task.name}.json`,
              safeStringify(jsonValue),
              "object",
            );
            task.annotation?.annotator.annotateJsonAggregate(
              jsonIno,
              task.annotation.path,
              jsonValue,
            );
            task.annotation?.annotator.annotateEntry(
              task.parentIno,
              `${task.name}.json`,
              jsonIno,
              { labelPath: task.annotation.path },
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
                annotation: task.annotation?.annotator.childContext(
                  task.annotation,
                  key,
                ),
              });
            }
          }
        }
      }
    } else {
      builtIno = buildJsonLeaf(
        tree,
        task.parentIno,
        task.name,
        candidate,
        task.annotation,
      );
    }

    task.annotation?.annotator.annotateEntry(
      task.parentIno,
      task.name,
      builtIno!,
      { labelPath: task.annotation.path },
    );
    task.onBuilt?.(builtIno!);
    processed++;
    if (processed % ASYNC_BUILD_BATCH_SIZE === 0) {
      await yieldToEventLoop();
    }
  }

  return rootIno!;
}
