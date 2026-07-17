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
import type { FsNode } from "./types.ts";

const ROOT_INO = 1n;
const encoder = new TextEncoder();

export class FsTree {
  inodes: Map<bigint, FsNode> = new Map();
  parents: Map<bigint, bigint> = new Map();
  paths: Map<string, bigint> = new Map();
  /** Reverse map: inode → path string (O(1) lookup). */
  private inoPaths: Map<bigint, string> = new Map();
  private nextIno = 2n;

  constructor() {
    // Create root directory (inode 1)
    this.inodes.set(ROOT_INO, { kind: "dir", children: new Map() });
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
  }

  private untrackPath(ino: bigint): void {
    const path = this.inoPaths.get(ino);
    if (path !== undefined) {
      if (this.paths.get(path) === ino) {
        this.paths.delete(path);
      }
      this.inoPaths.delete(ino);
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
    const node: FsNode = { kind: "dir", children: new Map(), jsonType };
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
    const node: FsNode = { kind: "file", content: data, jsonType };
    this.inodes.set(ino, node);
    parent.children.set(name, ino);
    this.parents.set(ino, parentIno);
    this.trackPath(ino, parentIno, name);

    return ino;
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
    const node: FsNode = { kind: "symlink", target };
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

  setCfcAnnotation(ino: bigint, annotation: CfcNodeAnnotation): void {
    const node = this.inodes.get(ino);
    if (!node) {
      throw new Error(`Inode ${ino} does not exist`);
    }
    node.cfc = annotation;
  }

  getCfcAnnotation(ino: bigint): CfcNodeAnnotation | undefined {
    return this.inodes.get(ino)?.cfc;
  }

  setCfcEntryAnnotation(
    parentIno: bigint,
    name: string,
    entry: CfcDirectoryEntryAnnotation,
  ): void {
    const parent = this.inodes.get(parentIno);
    if (!parent || parent.kind !== "dir" || !parent.cfc?.entries) return;
    const entries = parent.cfc.entries.entries.filter((candidate) =>
      candidate.name !== name
    );
    entries.push(entry);
    parent.cfc.entries = {
      version: 1,
      entries: entries.sort((left, right) =>
        left.nameDigest.localeCompare(right.nameDigest)
      ),
    };
  }

  private removeCfcEntryAnnotation(parentIno: bigint, name: string): void {
    const parent = this.inodes.get(parentIno);
    if (!parent || parent.kind !== "dir" || !parent.cfc?.entries) return;
    parent.cfc.entries = {
      version: 1,
      entries: parent.cfc.entries.entries.filter((entry) =>
        entry.name !== name
      ),
    };
  }

  private getCfcEntryAnnotation(
    parentIno: bigint,
    name: string,
  ): CfcDirectoryEntryAnnotation | undefined {
    const parent = this.inodes.get(parentIno);
    if (!parent || parent.kind !== "dir" || !parent.cfc?.entries) {
      return undefined;
    }
    return parent.cfc.entries.entries.find((entry) => entry.name === name);
  }

  getChildren(ino: bigint): [string, bigint][] {
    const node = this.inodes.get(ino);
    if (!node || node.kind !== "dir") return [];
    return [...node.children.entries()];
  }

  getPath(ino: bigint): string {
    return this.inoPaths.get(ino) ?? "/";
  }

  /** Update a file node's content and optionally its jsonType. */
  updateFile(
    ino: bigint,
    content: Uint8Array | string,
    jsonType?: "string" | "number" | "boolean" | "null" | "object" | "array",
  ): void {
    const node = this.inodes.get(ino);
    if (!node || node.kind !== "file") {
      throw new Error(`Inode ${ino} is not a file`);
    }
    node.content = typeof content === "string"
      ? encoder.encode(content)
      : content;
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
   * Unlink a subtree from its parent while keeping its inodes temporarily live.
   *
   * A piece-prop rebuild detaches the old subtree and builds a replacement with
   * fresh inodes. A client can still hold the old inode for as long as its
   * kernel caches allow, so the detached inodes stay resolvable until they are
   * cleared: `getNode`, `getPath` and `getNameForIno` all keep answering for
   * them, which lets a write that arrives on a detached inode resolve to the
   * same cell as the path it was opened on.
   */
  detach(ino: bigint): void {
    if (!this.inodes.has(ino)) return;
    this.unlinkFromParent(ino);
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

  /** Get the child name for an inode by scanning its parent's children map. */
  getNameForIno(ino: bigint): string | undefined {
    const parentIno = this.parents.get(ino);
    if (parentIno === undefined) return undefined;
    const parent = this.inodes.get(parentIno);
    if (!parent || parent.kind !== "dir") return undefined;
    for (const [name, childIno] of parent.children) {
      if (childIno === ino) return name;
    }
    // A detached subtree keeps its inodes and its recorded path until it is
    // cleared. The parent no longer lists it, so recover the name from the
    // recorded path.
    const path = this.inoPaths.get(ino);
    if (path === undefined) return undefined;
    const name = path.slice(path.lastIndexOf("/") + 1);
    return name === "" ? undefined : name;
  }

  /** Remove a subtree rooted at `ino`, including the node itself. */
  clear(ino: bigint): void {
    const node = this.inodes.get(ino);
    if (!node) return;

    this.unlinkFromParent(ino);
    this.clearSubtree(ino);
  }
}
