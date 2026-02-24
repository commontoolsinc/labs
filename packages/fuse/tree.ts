// tree.ts — In-memory filesystem tree with inode management

import type { FsNode } from "./types.ts";

const ROOT_INO = 1n;
const encoder = new TextEncoder();

export class FsTree {
  inodes: Map<bigint, FsNode> = new Map();
  parents: Map<bigint, bigint> = new Map();
  paths: Map<string, bigint> = new Map();
  private nextIno = 2n;

  constructor() {
    // Create root directory (inode 1)
    this.inodes.set(ROOT_INO, { kind: "dir", children: new Map() });
    this.paths.set("/", ROOT_INO);
  }

  get rootIno(): bigint {
    return ROOT_INO;
  }

  allocInode(): bigint {
    return this.nextIno++;
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

    // Track path
    const parentPath = this.getPath(parentIno);
    const path = parentPath === "/" ? `/${name}` : `${parentPath}/${name}`;
    this.paths.set(path, ino);

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

    // Track path
    const parentPath = this.getPath(parentIno);
    const path = parentPath === "/" ? `/${name}` : `${parentPath}/${name}`;
    this.paths.set(path, ino);

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

    // Track path
    const parentPath = this.getPath(parentIno);
    const path = parentPath === "/" ? `/${name}` : `${parentPath}/${name}`;
    this.paths.set(path, ino);

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
    for (const [path, pathIno] of this.paths) {
      if (pathIno === ino) return path;
    }
    return "/";
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
    for (const [path, pathIno] of this.paths) {
      if (pathIno === ino) {
        this.paths.delete(path);
        break;
      }
    }
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

    // Update path tracking
    const oldPath = this.getPath(childIno);
    if (oldPath !== "/") {
      this.paths.delete(oldPath);
    }
    const newParentPath = this.getPath(newParentIno);
    const newPath = newParentPath === "/"
      ? `/${newName}`
      : `${newParentPath}/${newName}`;
    this.paths.set(newPath, childIno);
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

    // Recursively clear children
    if (node.kind === "dir") {
      for (const [, childIno] of node.children) {
        this.clear(childIno);
      }
    }

    // Remove from parent's children
    const parentIno = this.parents.get(ino);
    if (parentIno !== undefined) {
      const parent = this.inodes.get(parentIno);
      if (parent && parent.kind === "dir") {
        for (const [name, childIno] of parent.children) {
          if (childIno === ino) {
            parent.children.delete(name);
            break;
          }
        }
      }
    }

    // Remove from tracking maps
    this.inodes.delete(ino);
    this.parents.delete(ino);
    for (const [path, pathIno] of this.paths) {
      if (pathIno === ino) {
        this.paths.delete(path);
        break;
      }
    }
  }
}
