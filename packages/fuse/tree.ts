// tree.ts — In-memory filesystem tree with inode management

import type { CallableKind } from "./callables.ts";
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
    return childIno;
  }

  /** Unlink a subtree from its parent while keeping its inodes temporarily live. */
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

    // If target exists, remove it first
    const existingIno = newParent.children.get(newName);
    if (existingIno !== undefined) {
      this.clearSubtree(existingIno);
    }

    // Move the child
    oldParent.children.delete(oldName);
    newParent.children.set(newName, childIno);
    this.parents.set(childIno, newParentIno);

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
    return undefined;
  }

  /** Remove a subtree rooted at `ino`, including the node itself. */
  clear(ino: bigint): void {
    const node = this.inodes.get(ino);
    if (!node) return;

    this.unlinkFromParent(ino);
    this.clearSubtree(ino);
  }
}
