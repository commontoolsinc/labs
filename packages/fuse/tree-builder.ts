// tree-builder.ts — Convert JSON values to FsTree nodes

import {
  type CallableKind,
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
 *
 * TODO(danfuzz): this is an unsafe use of `stringify()` for fabric values:
 * the piece prop values this file renders are live in-process cell reads,
 * and a `FabricSpecialObject` among them (a `FabricBytes`, a `FabricError`)
 * serializes as `{}` in the mounted `.json` file contents, silently. Wants a
 * `FabricSpecialObject` arm in the replacer — its codec's encoded form, or
 * `toCompactDebugString()` from `@commonfabric/data-model/value-debug`.
 */
export function safeStringify(value: unknown, indent = 2): string {
  const ancestors: object[] = [];
  return JSON.stringify(
    value,
    function (this: unknown, _key, val) {
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

const BUILD_BATCH_SIZE = 200;

interface BuildJsonTreeTask {
  parentIno: bigint;
  name: string;
  value: unknown;
  ancestors: readonly object[];
  depth: number;
  annotation?: CfcJsonAnnotationContext;
  internalRootName?: PendingJsonRootName;
}

/**
 * State of one JSON-to-filesystem projection in progress: the settings that
 * apply to every node, the nodes still waiting to be projected, and the inode
 * of the node the caller asked for.
 */
interface JsonTreeBuild {
  readonly tree: FsTree;
  readonly resolveLink?: (value: unknown, depth: number) => string | null;
  readonly skipEntry?: (value: unknown) => boolean;
  readonly classifyCallableEntry?: (
    key: string,
    value: unknown,
  ) => CallableKind | null;
  /**
   * Nodes to project, in the order their entries will be created. A slot is
   * emptied as its node is taken, so a build holds only the nodes still
   * waiting rather than every node it has passed.
   */
  readonly queue: (BuildJsonTreeTask | undefined)[];
  nextIndex: number;
  rootIno?: bigint;
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

async function yieldToEventLoop(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
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

function startJsonTreeBuild(
  tree: FsTree,
  parentIno: bigint,
  name: string,
  value: unknown,
  resolveLink: ((value: unknown, depth: number) => string | null) | undefined,
  depth: number | undefined,
  skipEntry: ((value: unknown) => boolean) | undefined,
  classifyCallableEntry:
    | ((key: string, value: unknown) => CallableKind | null)
    | undefined,
  annotation: CfcJsonAnnotationContext | undefined,
  internalRootName: PendingJsonRootName | undefined,
): JsonTreeBuild {
  return {
    tree,
    resolveLink,
    skipEntry,
    classifyCallableEntry,
    queue: [{
      parentIno,
      name,
      value,
      ancestors: [],
      depth: depth ?? 0,
      annotation,
      internalRootName,
    }],
    nextIndex: 0,
  };
}

/**
 * Create the entry for one queued node, queueing its children behind every
 * node already waiting. Returns the inode of the entry that was created.
 */
function buildJsonTreeNode(
  build: JsonTreeBuild,
  task: BuildJsonTreeTask,
): bigint {
  const { tree } = build;
  const { parentIno, value, depth, annotation } = task;
  const fsName = encodeJsonEntryName(
    task.name,
    depth === 0 ? task.internalRootName : undefined,
  );

  // TODO(danfuzz): the `typeof` gate treats a `FabricSpecialObject` as a
  // container, so a fabric prop value projects as an empty DIRECTORY (its
  // `Object.entries` are empty) with a `{}` aggregate sibling — a
  // `FabricBytes` in a piece result mounts as an empty folder. The async
  // twin `buildJsonTreeAsync` below shares the shape. Wants a
  // `FabricSpecialObject` test taking the scalar-entry arm with a rendered
  // form of the value.
  if (value === null || value === undefined || typeof value !== "object") {
    return addJsonScalarEntry(tree, parentIno, fsName, value, annotation);
  }

  const objectValue = value as object;
  if (task.ancestors.includes(objectValue)) {
    return addJsonCircularEntry(tree, parentIno, fsName, value, annotation);
  }

  // Sigil link → symlink
  if (isSigilLink(value) && build.resolveLink) {
    const target = build.resolveLink(value, depth);
    if (target) {
      return addJsonSymlinkEntry(tree, parentIno, fsName, target, annotation);
    }
    // Fall through to normal object handling if link can't be resolved.
  }

  const childAncestors = [...task.ancestors, objectValue];

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
      build.queue.push({
        parentIno: dirIno,
        name: String(i),
        value: value[i],
        ancestors: childAncestors,
        depth: depth + 1,
        annotation: annotation?.annotator.childContext(annotation, i),
      });
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
    aggregateJsonValue(value, depth, build.classifyCallableEntry),
    "object",
    annotation,
  );

  for (const [key, val] of Object.entries(obj)) {
    if (isStreamValue(val) || isHandlerCell(val)) continue;
    if (build.skipEntry?.(val)) continue;
    build.queue.push({
      parentIno: dirIno,
      name: key,
      value: val,
      ancestors: childAncestors,
      depth: depth + 1,
      annotation: annotation?.annotator.childContext(annotation, key),
    });
  }

  return dirIno;
}

/**
 * Project one batch of queued nodes. Returns true when nodes remain, which is
 * the point at which an asynchronous build hands the event loop back.
 */
function runJsonTreeBatch(build: JsonTreeBuild): boolean {
  for (let projected = 0; projected < BUILD_BATCH_SIZE; projected++) {
    const task = build.queue[build.nextIndex];
    if (task === undefined) return false;
    build.queue[build.nextIndex++] = undefined;
    const ino = buildJsonTreeNode(build, task);
    // The node the caller asked for is the first one off the queue.
    if (build.rootIno === undefined) build.rootIno = ino;
  }
  return build.nextIndex < build.queue.length;
}

function drainJsonTreeBuild(build: JsonTreeBuild): bigint {
  while (runJsonTreeBatch(build)) {
    // A synchronous build runs the batches back to back.
  }
  return build.rootIno!;
}

async function drainJsonTreeBuildAsync(
  build: JsonTreeBuild,
): Promise<bigint> {
  while (runJsonTreeBatch(build)) {
    await yieldToEventLoop();
  }
  return build.rootIno!;
}

/**
 * Build a filesystem subtree from a JSON value.
 *
 * - null → empty file (jsonType "null")
 * - boolean → file "true"/"false" (jsonType "boolean")
 * - number → file with string representation (jsonType "number")
 * - string → file with raw UTF-8 (jsonType "string")
 * - sigil link → symlink (if resolveLink provided and returns a path)
 * - object → directory with an entry per key (jsonType "object")
 * - array → directory with an entry per index (jsonType "array")
 *
 * Circular references are replaced with "[Circular]".
 * Also synthesizes `.json` sibling files for directory nodes.
 *
 * Entries are created level by level, and the whole value is projected before
 * this returns. Callers that must not block the event loop for a large value
 * use `buildJsonTreeAsync` instead.
 */
export function buildJsonTree(
  tree: FsTree,
  parentIno: bigint,
  name: string,
  value: unknown,
  resolveLink?: (value: unknown, depth: number) => string | null,
  depth?: number,
  skipEntry?: (value: unknown) => boolean,
  classifyCallableEntry?: (key: string, value: unknown) => CallableKind | null,
  annotation?: CfcJsonAnnotationContext,
): bigint {
  return drainJsonTreeBuild(startJsonTreeBuild(
    tree,
    parentIno,
    name,
    value,
    resolveLink,
    depth,
    skipEntry,
    classifyCallableEntry,
    annotation,
    undefined,
  ));
}

/**
 * The same projection as `buildJsonTree`, handing the event loop back between
 * batches of entries so that a large value does not stall the filesystem.
 */
export function buildJsonTreeAsync(
  tree: FsTree,
  parentIno: bigint,
  name: string,
  value: unknown,
  resolveLink?: (value: unknown, depth: number) => string | null,
  depth?: number,
  skipEntry?: (value: unknown) => boolean,
  classifyCallableEntry?: (key: string, value: unknown) => CallableKind | null,
  annotation?: CfcJsonAnnotationContext,
): Promise<bigint> {
  return drainJsonTreeBuildAsync(startJsonTreeBuild(
    tree,
    parentIno,
    name,
    value,
    resolveLink,
    depth,
    skipEntry,
    classifyCallableEntry,
    annotation,
    undefined,
  ));
}

/** Build a pending rebuild root with reserved internal staging names intact. */
export function buildPendingJsonTreeAsync(
  tree: FsTree,
  parentIno: bigint,
  propName: JsonPropName,
  value: unknown,
  resolveLink?: (value: unknown, depth: number) => string | null,
  depth?: number,
  skipEntry?: (value: unknown) => boolean,
  classifyCallableEntry?: (key: string, value: unknown) => CallableKind | null,
  annotation?: CfcJsonAnnotationContext,
): Promise<bigint> {
  const rootName = pendingJsonRootName(propName);
  return drainJsonTreeBuildAsync(startJsonTreeBuild(
    tree,
    parentIno,
    rootName,
    value,
    resolveLink,
    depth,
    skipEntry,
    classifyCallableEntry,
    annotation,
    rootName,
  ));
}
