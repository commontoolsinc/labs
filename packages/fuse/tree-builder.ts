// tree-builder.ts — Convert JSON values to FsTree nodes

import {
  type CallableKind,
  encodeFactoryProjection,
  isHandlerCell,
  isStreamValue,
  transformCallableValues,
} from "./callables.ts";
import type { CfcJsonAnnotationContext } from "./annotations.ts";
import { FsTree } from "./tree.ts";
import { encodeFuseComponent } from "./path-codec.ts";
import { isLinkRef, type SigilLink } from "@commonfabric/runner/shared";

type JsonPropName = "input" | "result";
type PendingJsonRootName = ".input.pending" | ".result.pending";

function pendingJsonRootName(propName: JsonPropName): PendingJsonRootName {
  return `.${propName}.pending`;
}

function encodeJsonEntryName(
  name: string,
  internalRootName?: PendingJsonRootName,
): string {
  return internalRootName !== undefined && name === internalRootName
    ? name
    : encodeFuseComponent(name, { reserveJsonSuffix: true });
}

/**
 * JSON.stringify that replaces circular references with "[Circular]".
 */
export function safeStringify(value: unknown, indent = 2): string {
  const ancestors: object[] = [];
  return JSON.stringify(
    value,
    function (this: unknown, _key, val) {
      const factoryProjection = encodeFactoryProjection(val);
      if (factoryProjection !== undefined) return factoryProjection;
      if (val !== null && typeof val === "object") {
        while (
          ancestors.length > 0 &&
          ancestors[ancestors.length - 1] !== this
        ) {
          ancestors.pop();
        }
        if (ancestors.includes(val)) return "[Circular]";
        ancestors.push(val);
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
 * identity for safeStringify's ancestry-based detection.
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
 * Routes through the data-model cell-rep chokepoint so fuse recognizes links
 * the same way the runtime does (and follows it through the eventual
 * flag-dispatched representation).
 */
export function isSigilLink(v: unknown): v is SigilLink {
  return isLinkRef(v);
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
  ancestors: readonly object[];
  depth: number;
  annotation?: CfcJsonAnnotationContext;
  internalRootName?: PendingJsonRootName;
  onBuilt?: (ino: bigint) => void;
}

type JsonScalarType = "string" | "number" | "boolean" | "null";
type JsonAggregateType = "object" | "array";

function annotateEntry(
  parentIno: bigint,
  fsName: string,
  ino: bigint,
  annotation?: CfcJsonAnnotationContext,
): void {
  annotation?.annotator.annotateEntry(parentIno, fsName, ino, {
    labelPath: annotation.path,
  });
}

function addJsonScalarEntry(
  tree: FsTree,
  parentIno: bigint,
  fsName: string,
  value: unknown,
  annotation?: CfcJsonAnnotationContext,
): bigint {
  let content: string;
  let jsonType: JsonScalarType;

  if (value === null || value === undefined) {
    content = "";
    jsonType = "null";
  } else if (typeof value === "boolean") {
    content = String(value);
    jsonType = "boolean";
  } else if (typeof value === "number") {
    content = String(value);
    jsonType = "number";
  } else if (typeof value === "string") {
    content = value;
    jsonType = "string";
  } else {
    content = String(value);
    jsonType = "string";
  }

  const ino = tree.addFile(parentIno, fsName, content, jsonType);
  annotation?.annotator.annotateJsonScalar(ino, annotation.path, value);
  annotateEntry(parentIno, fsName, ino, annotation);
  return ino;
}

function addJsonCircularEntry(
  tree: FsTree,
  parentIno: bigint,
  fsName: string,
  value: unknown,
  annotation?: CfcJsonAnnotationContext,
): bigint {
  const ino = tree.addFile(parentIno, fsName, "[Circular]", "string");
  annotation?.annotator.annotateJsonScalar(ino, annotation.path, value);
  annotateEntry(parentIno, fsName, ino, annotation);
  return ino;
}

function addJsonSymlinkEntry(
  tree: FsTree,
  parentIno: bigint,
  fsName: string,
  target: string,
  annotation?: CfcJsonAnnotationContext,
): bigint {
  const ino = tree.addSymlink(parentIno, fsName, target);
  annotation?.annotator.annotateJsonSymlink(ino, annotation.path, target);
  annotateEntry(parentIno, fsName, ino, annotation);
  return ino;
}

function addJsonDirectoryEntry(
  tree: FsTree,
  parentIno: bigint,
  fsName: string,
  value: unknown,
  jsonType: JsonAggregateType,
  annotation?: CfcJsonAnnotationContext,
): bigint {
  const ino = tree.addDir(parentIno, fsName, jsonType);
  annotation?.annotator.annotateJsonDirectory(ino, annotation.path, value);
  annotateEntry(parentIno, fsName, ino, annotation);
  return ino;
}

function addJsonAggregateSibling(
  tree: FsTree,
  parentIno: bigint,
  fsName: string,
  value: unknown,
  jsonType: JsonAggregateType,
  annotation?: CfcJsonAnnotationContext,
): bigint {
  const jsonName = `${fsName}.json`;
  const ino = tree.addFile(
    parentIno,
    jsonName,
    safeStringify(value),
    jsonType,
  );
  annotation?.annotator.annotateJsonAggregate(ino, annotation.path, value);
  annotateEntry(parentIno, jsonName, ino, annotation);
  return ino;
}

function buildJsonLeaf(
  tree: FsTree,
  parentIno: bigint,
  name: string,
  value: unknown,
  annotation?: CfcJsonAnnotationContext,
  internalRootName?: PendingJsonRootName,
): bigint {
  const fsName = encodeJsonEntryName(name, internalRootName);
  return addJsonScalarEntry(tree, parentIno, fsName, value, annotation);
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
  const initialAncestors = legacySeenContains(value, seen)
    ? [value as object]
    : [];
  return buildJsonTreeWithAncestors(
    tree,
    parentIno,
    name,
    value,
    initialAncestors,
    resolveLink,
    depth ?? 0,
    skipEntry,
    classifyCallableEntry,
    annotation,
    undefined,
  );
}

function legacySeenContains(
  value: unknown,
  seen?: WeakSet<object>,
): boolean {
  return value !== null && typeof value === "object" &&
    seen?.has(value as object) === true;
}

function aggregateJsonValue(
  value: unknown,
  depth: number,
  classifyCallableEntry?: (key: string, value: unknown) => CallableKind | null,
): unknown {
  if (depth !== 0) return value;
  return classifyCallableEntry
    ? transformCallableValues(value, classifyCallableEntry)
    : transformStreamValues(value);
}

function buildJsonTreeWithAncestors(
  tree: FsTree,
  parentIno: bigint,
  name: string,
  value: unknown,
  ancestors: readonly object[],
  resolveLink: ((value: unknown, depth: number) => string | null) | undefined,
  depth: number,
  skipEntry: ((value: unknown) => boolean) | undefined,
  classifyCallableEntry:
    | ((key: string, value: unknown) => CallableKind | null)
    | undefined,
  annotation?: CfcJsonAnnotationContext,
  internalRootName?: PendingJsonRootName,
): bigint {
  const fsName = encodeJsonEntryName(
    name,
    depth === 0 ? internalRootName : undefined,
  );

  if (value === null || value === undefined || typeof value !== "object") {
    return addJsonScalarEntry(tree, parentIno, fsName, value, annotation);
  }

  const objectValue = value as object;
  if (ancestors.includes(objectValue)) {
    return addJsonCircularEntry(tree, parentIno, fsName, value, annotation);
  }

  // Sigil link → symlink
  if (isSigilLink(value) && resolveLink) {
    const target = resolveLink(value, depth);
    if (target) {
      return addJsonSymlinkEntry(
        tree,
        parentIno,
        fsName,
        target,
        annotation,
      );
    }
    // Fall through to normal object handling if link can't be resolved.
  }

  const childAncestors = [...ancestors, objectValue];

  if (Array.isArray(value)) {
    const dirIno = addJsonDirectoryEntry(
      tree,
      parentIno,
      fsName,
      value,
      "array",
      annotation,
    );
    addJsonAggregateSibling(
      tree,
      parentIno,
      fsName,
      value,
      "array",
      annotation,
    );

    for (let i = 0; i < value.length; i++) {
      buildJsonTreeWithAncestors(
        tree,
        dirIno,
        String(i),
        value[i],
        childAncestors,
        resolveLink,
        depth + 1,
        skipEntry,
        classifyCallableEntry,
        annotation?.annotator.childContext(annotation, i),
      );
    }

    return dirIno;
  }

  const obj = value as Record<string, unknown>;
  const dirIno = addJsonDirectoryEntry(
    tree,
    parentIno,
    fsName,
    value,
    "object",
    annotation,
  );
  addJsonAggregateSibling(
    tree,
    parentIno,
    fsName,
    aggregateJsonValue(value, depth, classifyCallableEntry),
    "object",
    annotation,
  );

  for (const [key, val] of Object.entries(obj)) {
    if (isStreamValue(val) || isHandlerCell(val)) continue;
    if (skipEntry?.(val)) continue;
    buildJsonTreeWithAncestors(
      tree,
      dirIno,
      key,
      val,
      childAncestors,
      resolveLink,
      depth + 1,
      skipEntry,
      classifyCallableEntry,
      annotation?.annotator.childContext(annotation, key),
    );
  }

  return dirIno;
}

export function buildJsonTreeAsync(
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
  return buildJsonTreeAsyncImpl(
    tree,
    parentIno,
    name,
    value,
    seen,
    resolveLink,
    depth,
    skipEntry,
    classifyCallableEntry,
    annotation,
    undefined,
  );
}

/** Build a pending rebuild root with reserved internal staging names intact. */
export function buildPendingJsonTreeAsync(
  tree: FsTree,
  parentIno: bigint,
  propName: JsonPropName,
  value: unknown,
  seen?: WeakSet<object>,
  resolveLink?: (value: unknown, depth: number) => string | null,
  depth?: number,
  skipEntry?: (value: unknown) => boolean,
  classifyCallableEntry?: (key: string, value: unknown) => CallableKind | null,
  annotation?: CfcJsonAnnotationContext,
): Promise<bigint> {
  const rootName = pendingJsonRootName(propName);
  return buildJsonTreeAsyncImpl(
    tree,
    parentIno,
    rootName,
    value,
    seen,
    resolveLink,
    depth,
    skipEntry,
    classifyCallableEntry,
    annotation,
    rootName,
  );
}

async function buildJsonTreeAsyncImpl(
  tree: FsTree,
  parentIno: bigint,
  name: string,
  value: unknown,
  seen: WeakSet<object> | undefined,
  resolveLink: ((value: unknown, depth: number) => string | null) | undefined,
  depth: number | undefined,
  skipEntry: ((value: unknown) => boolean) | undefined,
  classifyCallableEntry:
    | ((key: string, value: unknown) => CallableKind | null)
    | undefined,
  annotation: CfcJsonAnnotationContext | undefined,
  internalRootName?: PendingJsonRootName,
): Promise<bigint> {
  const queue: BuildJsonTreeTask[] = [{
    parentIno,
    name,
    value,
    ancestors: legacySeenContains(value, seen) ? [value as object] : [],
    depth: depth ?? 0,
    annotation,
    internalRootName,
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
    const taskInternalRootName = task.depth === 0
      ? task.internalRootName
      : undefined;
    const fsName = encodeJsonEntryName(task.name, taskInternalRootName);

    let builtIno: bigint | undefined;

    if (candidate === null || candidate === undefined) {
      builtIno = buildJsonLeaf(
        tree,
        task.parentIno,
        task.name,
        candidate,
        task.annotation,
        taskInternalRootName,
      );
    } else if (typeof candidate === "object") {
      const objectValue = candidate as object;
      if (task.ancestors.includes(objectValue)) {
        builtIno = addJsonCircularEntry(
          tree,
          task.parentIno,
          fsName,
          candidate,
          task.annotation,
        );
      } else {
        if (isSigilLink(candidate) && resolveLink) {
          const target = resolveLink(candidate, d);
          if (target) {
            builtIno = addJsonSymlinkEntry(
              tree,
              task.parentIno,
              fsName,
              target,
              task.annotation,
            );
          }
        }

        if (builtIno === undefined) {
          const childAncestors = [...task.ancestors, objectValue];

          if (Array.isArray(candidate)) {
            builtIno = addJsonDirectoryEntry(
              tree,
              task.parentIno,
              fsName,
              candidate,
              "array",
              task.annotation,
            );
            addJsonAggregateSibling(
              tree,
              task.parentIno,
              fsName,
              candidate,
              "array",
              task.annotation,
            );

            for (let i = 0; i < candidate.length; i++) {
              queue.push({
                parentIno: builtIno,
                name: String(i),
                value: candidate[i],
                ancestors: childAncestors,
                depth: d + 1,
                annotation: task.annotation?.annotator.childContext(
                  task.annotation,
                  i,
                ),
              });
            }
          } else {
            const obj = candidate as Record<string, unknown>;
            builtIno = addJsonDirectoryEntry(
              tree,
              task.parentIno,
              fsName,
              candidate,
              "object",
              task.annotation,
            );
            addJsonAggregateSibling(
              tree,
              task.parentIno,
              fsName,
              aggregateJsonValue(candidate, d, classifyCallableEntry),
              "object",
              task.annotation,
            );

            for (const [key, val] of Object.entries(obj)) {
              if (isStreamValue(val) || isHandlerCell(val)) continue;
              if (skipEntry?.(val)) continue;
              queue.push({
                parentIno: builtIno,
                name: key,
                value: val,
                ancestors: childAncestors,
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
        taskInternalRootName,
      );
    }

    task.onBuilt?.(builtIno!);
    processed++;
    if (processed % ASYNC_BUILD_BATCH_SIZE === 0) {
      await yieldToEventLoop();
    }
  }

  return rootIno!;
}
