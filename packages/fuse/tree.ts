// tree.ts — In-memory filesystem tree with inode management
//
// Reference documentation:
// - docs/specs/fuse-filesystem/README.md — index of the filesystem spec
// - docs/specs/fuse-filesystem/4-read-write.md — stat, read and write
//   semantics, inode assignment, and the cell-error-to-errno mapping
// - docs/specs/fuse-filesystem/6-reactivity.md — how a cell change rebuilds a
//   subtree and invalidates kernel caches, and the kernel cache timeouts that
//   bound how long a client can hold a stale entry
// - docs/specs/fuse-filesystem/10-cfc-filesystem-api-semantics.md — the errno
//   decision table
// - RELIABILITY_DESIGN.md — which module owns which state
// - README.md — mount options and client-side cache tuning

import type { CallableKind } from "./callables.ts";
import {
  type CfcDirectoryEntryAnnotation,
  cfcDirectoryEntryKind,
  cfcDirectoryEntryNameDigest,
  type CfcNodeAnnotation,
} from "./annotations.ts";
import type { FsNode, JsonType } from "./types.ts";

const ROOT_INO = 1n;
const encoder = new TextEncoder();

/**
 * The kernel caches that a transplant invalidated.
 *
 * `changedInodes` lists inodes that survived the transplant but whose file
 * data, symlink target or callable script changed, so their cached data and
 * attributes are stale. `entryChanges` maps a directory inode to the child
 * names whose directory entry changed — a name that appeared, disappeared, or
 * now points at a different inode — so the directory's cached listing for
 * exactly those names is stale. Names that kept their inode are absent from
 * both, which is what lets the caller leave unchanged entries cached.
 */
export interface TransplantChanges {
  changedInodes: Set<bigint>;
  entryChanges: Map<bigint, Set<string>>;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Run a generated file's renderer and return bytes the tree owns. A string is
 * encoded, which already yields a fresh array; a `Uint8Array` is copied, so a
 * renderer reusing its buffer cannot mutate the published content.
 */
function ownedRender(render: () => Uint8Array | string): Uint8Array {
  const rendered = render();
  return typeof rendered === "string"
    ? encoder.encode(rendered)
    : new Uint8Array(rendered);
}

export class FsTree {
  inodes: Map<bigint, FsNode> = new Map();
  parents: Map<bigint, bigint> = new Map();
  paths: Map<string, bigint> = new Map();
  /** Reverse map: inode → path string (O(1) lookup). */
  private inoPaths: Map<bigint, string> = new Map();
  /**
   * Reverse map from inode to registered child name for constant-time lookup.
   */
  private inoNames: Map<bigint, string> = new Map();
  /** Renderers for inodes added by `addGeneratedFile`. */
  private generated: Map<bigint, () => Uint8Array | string> = new Map();
  private cfcEntryIndexes = new Map<bigint, Map<string, number>>();
  private unsortedCfcEntryDirectories = new Set<bigint>();
  private nextIno = 2n;
  private now: () => number;

  constructor(now: () => number = () => Date.now()) {
    this.now = now;
    // Create root directory (inode 1)
    this.inodes.set(ROOT_INO, {
      kind: "dir",
      children: new Map(),
      mtime: this.now(),
    });
    this.paths.set("/", ROOT_INO);
    this.inoPaths.set(ROOT_INO, "/");
  }

  get rootIno(): bigint {
    return ROOT_INO;
  }

  allocInode(): bigint {
    return this.nextIno++;
  }

  private trackPath(ino: bigint, parentIno: bigint, name: string): void {
    const parentPath = this.getPath(parentIno);
    const path = parentPath === "/" ? `/${name}` : `${parentPath}/${name}`;
    this.paths.set(path, ino);
    this.inoPaths.set(ino, path);
    this.inoNames.set(ino, name);
  }

  private untrackPath(ino: bigint): void {
    const path = this.inoPaths.get(ino);
    if (path !== undefined) {
      if (this.paths.get(path) === ino) {
        this.paths.delete(path);
      }
      this.inoPaths.delete(ino);
      this.inoNames.delete(ino);
    }
  }

  private unlinkFromParent(ino: bigint): void {
    const parentIno = this.parents.get(ino);
    if (parentIno === undefined) return;
    const parent = this.inodes.get(parentIno);
    if (!parent || parent.kind !== "dir") return;
    for (const [name, childIno] of parent.children) {
      if (childIno === ino) {
        parent.children.delete(name);
        this.removeCfcEntryAnnotation(parentIno, name);
        break;
      }
    }
  }

  addDir(
    parentIno: bigint,
    name: string,
    jsonType?: "object" | "array",
  ): bigint {
    const parent = this.inodes.get(parentIno);
    if (!parent || parent.kind !== "dir") {
      throw new Error(`Parent inode ${parentIno} is not a directory`);
    }

    const ino = this.allocInode();
    const node: FsNode = {
      kind: "dir",
      children: new Map(),
      jsonType,
      mtime: this.now(),
    };
    this.inodes.set(ino, node);
    parent.children.set(name, ino);
    this.parents.set(ino, parentIno);
    this.trackPath(ino, parentIno, name);

    return ino;
  }

  addFile(
    parentIno: bigint,
    name: string,
    content: Uint8Array | string,
    jsonType: "string" | "number" | "boolean" | "null" | "object" | "array",
  ): bigint {
    const parent = this.inodes.get(parentIno);
    if (!parent || parent.kind !== "dir") {
      throw new Error(`Parent inode ${parentIno} is not a directory`);
    }

    const ino = this.allocInode();
    const data = typeof content === "string"
      ? encoder.encode(content)
      : content;
    const node: FsNode = {
      kind: "file",
      content: data,
      jsonType,
      mtime: this.now(),
    };
    this.inodes.set(ino, node);
    parent.children.set(name, ino);
    this.parents.set(ino, parentIno);
    this.trackPath(ino, parentIno, name);

    return ino;
  }

  /**
   * Add a file whose bytes are produced by `render` rather than written.
   *
   * The node's content is whatever `refreshGenerated` last published, and reads
   * serve that. A client stops a read at the size it last learned, so the size
   * a caller reports and the bytes it later serves have to come from one
   * render: publish where the size is reported. A render returning a
   * `Uint8Array` is copied, so a renderer reusing its buffer cannot change the
   * published content out from under a reader.
   */
  addGeneratedFile(
    parentIno: bigint,
    name: string,
    render: () => Uint8Array | string,
    jsonType: JsonType,
  ): bigint {
    const ino = this.addFile(parentIno, name, ownedRender(render), jsonType);
    this.generated.set(ino, render);
    return ino;
  }

  /**
   * Re-render a generated file and publish the result as its content.
   *
   * Returns the published bytes, or undefined when `ino` is not a generated
   * file. Call this where the file's size is about to be reported, so that the
   * size a client caches and the bytes a following read serves are one render.
   *
   * A render equal to the published one leaves the content and the node's mtime
   * alone, so the mtime moves only when the bytes do, and then always forward.
   */
  refreshGenerated(ino: bigint): Uint8Array | undefined {
    const render = this.generated.get(ino);
    if (render === undefined) return undefined;
    const node = this.inodes.get(ino);
    if (!node || node.kind !== "file") return undefined;
    const bytes = ownedRender(render);
    if (bytesEqual(node.content, bytes)) return node.content;
    this.bumpMtime(node);
    node.content = bytes;
    return node.content;
  }

  /** True when `ino` was added by `addGeneratedFile`. */
  isGenerated(ino: bigint): boolean {
    return this.generated.has(ino);
  }

  addCallable(
    parentIno: bigint,
    name: string,
    callableKind: CallableKind,
    cellKey: string,
    cellProp: "input" | "result",
    script: Uint8Array,
  ): bigint {
    const parent = this.inodes.get(parentIno);
    if (!parent || parent.kind !== "dir") {
      throw new Error(`Parent inode ${parentIno} is not a directory`);
    }

    const ino = this.allocInode();
    const node: FsNode = {
      kind: "callable",
      callableKind,
      cellKey,
      cellProp,
      script,
      mtime: this.now(),
    };
    this.inodes.set(ino, node);
    parent.children.set(name, ino);
    this.parents.set(ino, parentIno);
    this.trackPath(ino, parentIno, name);

    return ino;
  }

  addSymlink(parentIno: bigint, name: string, target: string): bigint {
    const parent = this.inodes.get(parentIno);
    if (!parent || parent.kind !== "dir") {
      throw new Error(`Parent inode ${parentIno} is not a directory`);
    }

    const ino = this.allocInode();
    const node: FsNode = { kind: "symlink", target, mtime: this.now() };
    this.inodes.set(ino, node);
    parent.children.set(name, ino);
    this.parents.set(ino, parentIno);
    this.trackPath(ino, parentIno, name);

    return ino;
  }

  lookup(parentIno: bigint, name: string): bigint | undefined {
    const parent = this.inodes.get(parentIno);
    if (!parent || parent.kind !== "dir") return undefined;
    return parent.children.get(name);
  }

  getNode(ino: bigint): FsNode | undefined {
    return this.inodes.get(ino);
  }

  /**
   * Advance a node's mtime because its directory entries changed through a path
   * other than a transplant — a piece appearing under a space, or a piece
   * directory gaining or losing a top-level entry. Content changes and
   * transplant-reconciled entry changes advance mtime on their own.
   */
  touch(ino: bigint): void {
    const node = this.inodes.get(ino);
    if (node) this.bumpMtime(node);
  }

  setCfcAnnotation(ino: bigint, annotation: CfcNodeAnnotation): void {
    const node = this.inodes.get(ino);
    if (!node) {
      throw new Error(`Inode ${ino} does not exist`);
    }
    node.cfc = annotation;
    this.rebuildCfcEntryIndex(ino, annotation);
  }

  getCfcAnnotation(ino: bigint): CfcNodeAnnotation | undefined {
    this.sortCfcEntries(ino);
    return this.inodes.get(ino)?.cfc;
  }

  private rebuildCfcEntryIndex(
    ino: bigint,
    annotation: CfcNodeAnnotation | undefined,
  ): void {
    this.unsortedCfcEntryDirectories.delete(ino);
    const entries = annotation?.entries?.entries;
    if (!entries) {
      this.cfcEntryIndexes.delete(ino);
      return;
    }
    this.cfcEntryIndexes.set(
      ino,
      new Map(entries.map((entry, index) => [entry.name, index])),
    );
  }

  private cfcEntryIndex(
    ino: bigint,
    entries: readonly CfcDirectoryEntryAnnotation[],
  ): Map<string, number> {
    let index = this.cfcEntryIndexes.get(ino);
    if (!index) {
      index = new Map(entries.map((entry, offset) => [entry.name, offset]));
      this.cfcEntryIndexes.set(ino, index);
    }
    return index;
  }

  private sortCfcEntries(ino: bigint): void {
    if (!this.unsortedCfcEntryDirectories.delete(ino)) return;
    const node = this.inodes.get(ino);
    if (!node || node.kind !== "dir" || !node.cfc?.entries) return;
    node.cfc.entries.entries.sort((left, right) =>
      left.nameDigest.localeCompare(right.nameDigest)
    );
    this.rebuildCfcEntryIndex(ino, node.cfc);
  }

  setCfcEntryAnnotation(
    parentIno: bigint,
    name: string,
    entry: CfcDirectoryEntryAnnotation,
  ): void {
    const parent = this.inodes.get(parentIno);
    if (!parent || parent.kind !== "dir" || !parent.cfc?.entries) return;
    const entries = parent.cfc.entries.entries;
    const index = this.cfcEntryIndex(parentIno, entries);
    const existing = index.get(name);
    if (existing === undefined) {
      index.set(name, entries.length);
      entries.push(entry);
    } else {
      entries[existing] = entry;
    }
    this.unsortedCfcEntryDirectories.add(parentIno);
  }

  private removeCfcEntryAnnotation(parentIno: bigint, name: string): void {
    const parent = this.inodes.get(parentIno);
    if (!parent || parent.kind !== "dir" || !parent.cfc?.entries) return;
    const entries = parent.cfc.entries.entries;
    const index = this.cfcEntryIndex(parentIno, entries);
    const removedIndex = index.get(name);
    if (removedIndex === undefined) return;
    const lastIndex = entries.length - 1;
    const last = entries[lastIndex];
    entries.pop();
    index.delete(name);
    if (removedIndex !== lastIndex) {
      entries[removedIndex] = last;
      index.set(last.name, removedIndex);
    }
    this.unsortedCfcEntryDirectories.add(parentIno);
  }

  private getCfcEntryAnnotation(
    parentIno: bigint,
    name: string,
  ): CfcDirectoryEntryAnnotation | undefined {
    const parent = this.inodes.get(parentIno);
    if (!parent || parent.kind !== "dir" || !parent.cfc?.entries) {
      return undefined;
    }
    const entries = parent.cfc.entries.entries;
    const index = this.cfcEntryIndex(parentIno, entries).get(name);
    return index === undefined ? undefined : entries[index];
  }

  getChildren(ino: bigint): [string, bigint][] {
    const node = this.inodes.get(ino);
    if (!node || node.kind !== "dir") return [];
    return [...node.children.entries()];
  }

  getPath(ino: bigint): string {
    return this.inoPaths.get(ino) ?? "/";
  }

  /**
   * Update a file node's content and optionally its jsonType.
   *
   * Throws if `ino` is not a file, or is a generated file — a generated file's
   * content comes from its renderer through `refreshGenerated`, so writing it
   * directly would be overwritten and is rejected.
   */
  updateFile(
    ino: bigint,
    content: Uint8Array | string,
    jsonType?: "string" | "number" | "boolean" | "null" | "object" | "array",
  ): void {
    const node = this.inodes.get(ino);
    if (!node || node.kind !== "file") {
      throw new Error(`Inode ${ino} is not a file`);
    }
    if (this.generated.has(ino)) {
      throw new Error(`Inode ${ino} is a generated file`);
    }
    const data = typeof content === "string"
      ? encoder.encode(content)
      : content;
    if (!bytesEqual(node.content, data)) {
      this.bumpMtime(node);
    }
    node.content = data;
    if (jsonType !== undefined) {
      node.jsonType = jsonType;
    }
  }

  /** Remove a child entry from parent's children map and clear the subtree. */
  removeChild(parentIno: bigint, name: string): bigint | undefined {
    const parent = this.inodes.get(parentIno);
    if (!parent || parent.kind !== "dir") return undefined;
    const childIno = parent.children.get(name);
    if (childIno === undefined) return undefined;
    // Don't use clear() since it also removes from parent — do it manually
    this.clearSubtree(childIno);
    parent.children.delete(name);
    this.removeCfcEntryAnnotation(parentIno, name);
    return childIno;
  }

  /**
   * Remove a directory entry while retaining its inode subtree.
   *
   * FUSE can keep an inode alive after its final directory entry disappears.
   * The caller clears the detached subtree after the kernel releases its
   * lookup and open references.
   */
  detachChild(parentIno: bigint, name: string): bigint | undefined {
    const parent = this.inodes.get(parentIno);
    if (!parent || parent.kind !== "dir") return undefined;
    const childIno = parent.children.get(name);
    if (childIno === undefined) return undefined;
    parent.children.delete(name);
    this.removeCfcEntryAnnotation(parentIno, name);
    return childIno;
  }

  /** Recursively remove an inode and all its descendants from tracking maps. */
  private clearSubtree(ino: bigint): void {
    const node = this.inodes.get(ino);
    if (!node) return;
    if (node.kind === "dir") {
      for (const [, childIno] of node.children) {
        this.clearSubtree(childIno);
      }
    }
    this.inodes.delete(ino);
    this.parents.delete(ino);
    this.generated.delete(ino);
    this.cfcEntryIndexes.delete(ino);
    this.unsortedCfcEntryDirectories.delete(ino);
    this.untrackPath(ino);
  }

  /** Move a node between parents (or rename within same parent). */
  rename(
    oldParentIno: bigint,
    oldName: string,
    newParentIno: bigint,
    newName: string,
  ): void {
    const oldParent = this.inodes.get(oldParentIno);
    if (!oldParent || oldParent.kind !== "dir") {
      throw new Error(`Old parent ${oldParentIno} is not a directory`);
    }
    const childIno = oldParent.children.get(oldName);
    if (childIno === undefined) {
      throw new Error(`Child "${oldName}" not found in parent ${oldParentIno}`);
    }

    const newParent = this.inodes.get(newParentIno);
    if (!newParent || newParent.kind !== "dir") {
      throw new Error(`New parent ${newParentIno} is not a directory`);
    }
    const movedCfcEntry = this.getCfcEntryAnnotation(oldParentIno, oldName);

    // If target exists, remove it first
    const existingIno = newParent.children.get(newName);
    if (existingIno !== undefined) {
      this.clearSubtree(existingIno);
      this.removeCfcEntryAnnotation(newParentIno, newName);
    }

    // Move the child
    oldParent.children.delete(oldName);
    this.removeCfcEntryAnnotation(oldParentIno, oldName);
    newParent.children.set(newName, childIno);
    this.parents.set(childIno, newParentIno);
    const child = this.inodes.get(childIno);
    const childAnnotation = this.getCfcAnnotation(childIno);
    if (movedCfcEntry && child) {
      this.setCfcEntryAnnotation(newParentIno, newName, {
        ...movedCfcEntry,
        name: newName,
        nameDigest: cfcDirectoryEntryNameDigest(newName),
        childRef: childAnnotation?.ref ?? movedCfcEntry.childRef,
        kind: cfcDirectoryEntryKind(child),
        metadataLabels: childAnnotation?.metadataLabels ??
          movedCfcEntry.metadataLabels,
      });
    }

    // Update path tracking for moved node and all descendants
    this.retrackSubtree(childIno, newParentIno, newName);
  }

  /** Recursively update path tracking for an inode and all its descendants. */
  private retrackSubtree(
    ino: bigint,
    parentIno: bigint,
    name: string,
  ): void {
    this.untrackPath(ino);
    this.trackPath(ino, parentIno, name);
    const node = this.inodes.get(ino);
    if (node?.kind === "dir") {
      for (const [childName, childIno] of node.children) {
        this.retrackSubtree(childIno, ino, childName);
      }
    }
  }

  /** Get the registered child name for an inode. */
  getNameForIno(ino: bigint): string | undefined {
    return this.inoNames.get(ino);
  }

  /**
   * Adopt an existing subtree's inodes into a freshly built replacement.
   *
   * `oldIno` roots the live subtree; `newIno` roots a replacement built with
   * fresh inodes under a staging name. The two roots must have the same node
   * kind. For every path present in both trees with the same node kind, the
   * existing inode survives: the replacement's content is copied onto it and
   * its inode number is preserved, so a client that cached the path keeps
   * resolving it. Paths only in the replacement move across keeping their
   * freshly allocated inodes; paths only in the old tree are removed. The
   * replacement's nodes are discarded as their content is adopted, leaving
   * `oldIno` in place at its original path carrying the new content.
   *
   * The whole operation is synchronous, so no filesystem request can observe a
   * half-adopted tree: callers build the replacement asynchronously under a
   * staging name, then call this to swap it in atomically.
   *
   * Returns the kernel caches that went stale; see {@link TransplantChanges}.
   */
  transplantSubtree(oldIno: bigint, newIno: bigint): TransplantChanges {
    const oldNode = this.inodes.get(oldIno);
    const newNode = this.inodes.get(newIno);
    if (!oldNode || !newNode) {
      throw new Error(`Transplant root ${oldIno} or ${newIno} does not exist`);
    }
    if (oldNode.kind !== newNode.kind) {
      throw new Error(
        `Transplant roots differ in kind: ${oldNode.kind} vs ${newNode.kind}`,
      );
    }
    const changes: TransplantChanges = {
      changedInodes: new Set(),
      entryChanges: new Map(),
    };
    this.transplantNode(oldIno, newIno, changes);
    this.discardNodeShallow(newIno);
    return changes;
  }

  /**
   * Reconcile one replacement node onto its live counterpart, recursing into
   * directory children. Assumes the two nodes share a kind. Leaves `newIno`'s
   * node in place for the caller to discard once its content has been adopted.
   */
  private transplantNode(
    oldIno: bigint,
    newIno: bigint,
    changes: TransplantChanges,
  ): void {
    const oldNode = this.inodes.get(oldIno)!;
    const newNode = this.inodes.get(newIno)!;

    // Move the replacement's annotation onto the surviving node and clear it
    // from the replacement so discarding the replacement's children can't
    // mutate the now-shared entries list out from under the survivor.
    this.sortCfcEntries(newIno);
    oldNode.cfc = newNode.cfc;
    newNode.cfc = undefined;
    this.rebuildCfcEntryIndex(oldIno, oldNode.cfc);
    this.cfcEntryIndexes.delete(newIno);
    this.unsortedCfcEntryDirectories.delete(newIno);

    if (this.adoptContent(oldNode, newNode)) {
      this.bumpMtime(oldNode);
      changes.changedInodes.add(oldIno);
    }

    if (oldNode.kind !== "dir" || newNode.kind !== "dir") return;

    const oldChildren = [...oldNode.children];
    const newChildren = [...newNode.children];
    const oldByName = new Map(oldChildren);
    const newByName = new Map(newChildren);
    let entriesChanged = false;

    for (const [name, newChildIno] of newChildren) {
      const oldChildIno = oldByName.get(name);
      const newChildNode = this.inodes.get(newChildIno)!;
      if (
        oldChildIno !== undefined &&
        this.inodes.get(oldChildIno)!.kind === newChildNode.kind
      ) {
        // Same path, same kind: the existing inode survives.
        this.transplantNode(oldChildIno, newChildIno, changes);
        this.discardNodeShallow(newChildIno);
      } else {
        // New path, or a kind change that forces a new inode. Drop any old
        // node at this name, then splice the replacement's subtree in with
        // its freshly allocated inodes.
        if (oldChildIno !== undefined) {
          this.clearSubtree(oldChildIno);
        }
        oldNode.children.set(name, newChildIno);
        this.parents.set(newChildIno, oldIno);
        this.retrackSubtree(newChildIno, oldIno, name);
        this.recordEntryChange(changes, oldIno, name);
        entriesChanged = true;
      }
    }

    for (const [name, oldChildIno] of oldChildren) {
      if (newByName.has(name)) continue;
      // Present in the old tree, gone from the replacement: remove it.
      this.clearSubtree(oldChildIno);
      oldNode.children.delete(name);
      this.recordEntryChange(changes, oldIno, name);
      entriesChanged = true;
    }

    // A directory whose entry set changed has been modified; advance its mtime
    // so a client that revalidates by attribute sees the change.
    if (entriesChanged) {
      this.bumpMtime(oldNode);
    }
  }

  /**
   * Advance a node's mtime on a content change. Clamps to strictly greater than
   * the node's previous mtime so two changes that land in the same wall-clock
   * millisecond still produce distinct times — a client revalidating by
   * attribute always sees a newer mtime after a content change, even on a
   * backend that ignores the inode-invalidation notifications.
   */
  private bumpMtime(node: FsNode): void {
    node.mtime = Math.max(this.now(), node.mtime + 1);
  }

  /**
   * Copy a replacement node's content onto its surviving counterpart. Returns
   * true if the file data, symlink target or callable script changed, so the
   * caller can invalidate the inode's cached data. A directory returns false —
   * its listing changes are reported through `entryChanges` instead.
   */
  private adoptContent(oldNode: FsNode, newNode: FsNode): boolean {
    if (oldNode.kind === "dir" && newNode.kind === "dir") {
      oldNode.jsonType = newNode.jsonType;
      return false;
    }
    if (oldNode.kind === "file" && newNode.kind === "file") {
      const changed = oldNode.jsonType !== newNode.jsonType ||
        !bytesEqual(oldNode.content, newNode.content);
      oldNode.content = newNode.content;
      oldNode.jsonType = newNode.jsonType;
      return changed;
    }
    if (oldNode.kind === "symlink" && newNode.kind === "symlink") {
      const changed = oldNode.target !== newNode.target;
      oldNode.target = newNode.target;
      return changed;
    }
    if (oldNode.kind === "callable" && newNode.kind === "callable") {
      const changed = oldNode.callableKind !== newNode.callableKind ||
        oldNode.cellKey !== newNode.cellKey ||
        oldNode.cellProp !== newNode.cellProp ||
        !bytesEqual(oldNode.script, newNode.script);
      oldNode.callableKind = newNode.callableKind;
      oldNode.cellKey = newNode.cellKey;
      oldNode.cellProp = newNode.cellProp;
      oldNode.script = newNode.script;
      return changed;
    }
    return false;
  }

  private recordEntryChange(
    changes: TransplantChanges,
    parentIno: bigint,
    name: string,
  ): void {
    let names = changes.entryChanges.get(parentIno);
    if (!names) {
      names = new Set();
      changes.entryChanges.set(parentIno, names);
    }
    names.add(name);
  }

  /**
   * Remove a single node from tracking without touching its children. Used to
   * drop a replacement node once its content has been adopted; its children
   * have already been adopted or moved, so recursing would wrongly clear them.
   */
  private discardNodeShallow(ino: bigint): void {
    this.unlinkFromParent(ino);
    this.inodes.delete(ino);
    this.parents.delete(ino);
    this.generated.delete(ino);
    this.cfcEntryIndexes.delete(ino);
    this.unsortedCfcEntryDirectories.delete(ino);
    this.untrackPath(ino);
  }

  /** Remove a subtree rooted at `ino`, including the node itself. */
  clear(ino: bigint): void {
    const node = this.inodes.get(ino);
    if (!node) return;

    this.unlinkFromParent(ino);
    this.clearSubtree(ino);
  }
}
