/**
 * Virtual Filesystem (VFS) for CFC Shell
 *
 * Provides an in-memory filesystem where every file carries a CFC label.
 * Implements label monotonicity: a file's label can only become more restrictive,
 * never less restrictive.
 */

import { Label, Labeled, labels } from "./labels.ts";

// ============================================================================
// Types
// ============================================================================

export interface Metadata {
  mode: number; // POSIX-style permissions (e.g., 0o644)
  uid: string; // owner identifier
  gid: string; // group identifier
  mtime: number; // last modified timestamp (ms)
  ctime: number; // created timestamp (ms)
  size: number; // bytes
}

export type VFSNode =
  | FileNode
  | DirectoryNode
  | SymlinkNode;

export interface FileNode {
  kind: "file";
  content: Uint8Array;
  label: Label;
  metadata: Metadata;
}

export interface DirectoryNode {
  kind: "directory";
  children: Map<string, VFSNode>;
  label: Label;
  metadata: Metadata;
}

export interface SymlinkNode {
  kind: "symlink";
  target: string;
  label: Label;
  metadata: Metadata;
}

// ============================================================================
// VFS Class
// ============================================================================

export class VFS {
  private root: DirectoryNode;
  public cwd: string;
  private textEncoder = new TextEncoder();
  private textDecoder = new TextDecoder();

  constructor(rootLabel?: Label) {
    const now = Date.now();
    this.root = {
      kind: "directory",
      children: new Map(),
      label: rootLabel || labels.bottom(),
      metadata: {
        mode: 0o755,
        uid: "root",
        gid: "root",
        mtime: now,
        ctime: now,
        size: 0,
      },
    };
    this.cwd = "/";
  }

  /**
   * Normalize a path (resolve `.`, `..`, double slashes)
   */
  resolvePath(path: string): string {
    // Resolve relative to cwd if not absolute
    const absolutePath = this.resolveCwd(path);

    // Split into parts and process
    const parts = absolutePath.split("/").filter(p => p !== "");
    const normalized: string[] = [];

    for (const part of parts) {
      if (part === ".") {
        // Skip current directory
        continue;
      } else if (part === "..") {
        // Go up one directory
        if (normalized.length > 0) {
          normalized.pop();
        }
      } else {
        normalized.push(part);
      }
    }

    return "/" + normalized.join("/");
  }

  /**
   * Resolve path relative to cwd
   */
  resolveCwd(path: string): string {
    if (path.startsWith("/")) {
      return path;
    }

    // Handle empty path
    if (path === "") {
      return this.cwd;
    }

    // Join with cwd
    const joined = this.cwd === "/"
      ? "/" + path
      : this.cwd + "/" + path;

    // Normalize the joined path (but don't recurse)
    const parts = joined.split("/").filter(p => p !== "");
    const normalized: string[] = [];

    for (const part of parts) {
      if (part === ".") {
        continue;
      } else if (part === "..") {
        if (normalized.length > 0) {
          normalized.pop();
        }
      } else {
        normalized.push(part);
      }
    }

    return "/" + normalized.join("/");
  }

  /**
   * Change working directory
   */
  cd(path: string): void {
    const resolved = this.resolvePath(path);
    const node = this.resolve(resolved, true);

    if (!node) {
      throw new Error(`cd: ${path}: No such file or directory`);
    }

    if (node.kind !== "directory") {
      throw new Error(`cd: ${path}: Not a directory`);
    }

    this.cwd = resolved;
  }

  /**
   * Resolve a path to a VFSNode, optionally following symlinks
   */
  resolve(path: string, followSymlinks = true): VFSNode | null {
    return this.resolveWithDepth(path, followSymlinks, 0);
  }

  private resolveWithDepth(
    path: string,
    followSymlinks: boolean,
    depth: number
  ): VFSNode | null {
    // Cycle detection via depth limit
    if (depth > 40) {
      throw new Error("Too many levels of symbolic links");
    }

    const normalized = this.resolvePath(path);

    if (normalized === "/") {
      return this.root;
    }

    const parts = normalized.split("/").filter(p => p !== "");
    return this.resolveFrom(this.root, parts, followSymlinks, depth);
  }

  private resolveFrom(
    current: VFSNode,
    parts: string[],
    followSymlinks: boolean,
    depth: number
  ): VFSNode | null {
    // Cycle detection via depth limit
    if (depth > 40) {
      throw new Error("Too many levels of symbolic links");
    }

    if (parts.length === 0) {
      return current;
    }

    if (current.kind !== "directory") {
      return null;
    }

    const [first, ...rest] = parts;
    const child = current.children.get(first);

    if (!child) {
      return null;
    }

    // Handle symlinks
    if (child.kind === "symlink" && followSymlinks) {
      const target = this.resolveWithDepth(child.target, true, depth + 1);
      if (!target) {
        return null;
      }
      return this.resolveFrom(target, rest, followSymlinks, depth + 1);
    }

    return this.resolveFrom(child, rest, followSymlinks, depth + 1);
  }

  /**
   * Resolve parent directory and get basename
   */
  private resolveParent(path: string): { parent: DirectoryNode; name: string } {
    const normalized = this.resolvePath(path);

    if (normalized === "/") {
      throw new Error("Cannot get parent of root");
    }

    const lastSlash = normalized.lastIndexOf("/");
    const parentPath = lastSlash === 0 ? "/" : normalized.substring(0, lastSlash);
    const name = normalized.substring(lastSlash + 1);

    const parent = this.resolve(parentPath, true);

    if (!parent) {
      throw new Error(`No such file or directory: ${parentPath}`);
    }

    if (parent.kind !== "directory") {
      throw new Error(`Not a directory: ${parentPath}`);
    }

    return { parent, name };
  }

  /**
   * Read file contents with label
   */
  readFile(path: string): Labeled<Uint8Array> {
    const node = this.resolve(path, true);

    if (!node) {
      throw new Error(`No such file: ${path}`);
    }

    if (node.kind !== "file") {
      throw new Error(`Not a file: ${path}`);
    }

    return {
      value: node.content,
      label: node.label,
    };
  }

  /**
   * Read file as text with label
   */
  readFileText(path: string): Labeled<string> {
    const { value, label } = this.readFile(path);
    return {
      value: this.textDecoder.decode(value),
      label,
    };
  }

  /**
   * Write file content with label (enforces monotonicity)
   */
  writeFile(path: string, content: Uint8Array | string, label: Label): void {
    const normalized = this.resolvePath(path);
    const existing = this.resolve(normalized, true);

    // Convert string to Uint8Array if needed
    const bytes = typeof content === "string"
      ? this.textEncoder.encode(content)
      : content;

    // If file exists, check label monotonicity
    if (existing) {
      if (existing.kind !== "file") {
        throw new Error(`Not a file: ${path}`);
      }

      // Check monotonicity: new label must flow from existing label
      // (new label must be >= existing label, meaning more restrictive)
      if (!labels.flowsTo(existing.label, label)) {
        throw new Error(
          `Label monotonicity violation: cannot write less restrictive label to ${path}`
        );
      }

      // Update existing file
      existing.content = bytes;
      existing.label = label;
      existing.metadata.mtime = Date.now();
      existing.metadata.size = bytes.length;
    } else {
      // Create new file, auto-creating parent directories
      const lastSlash = normalized.lastIndexOf("/");
      const parentPath = lastSlash === 0 ? "/" : normalized.substring(0, lastSlash);
      const name = normalized.substring(lastSlash + 1);

      // Ensure parent exists
      this.mkdir(parentPath, true);

      const parent = this.resolve(parentPath, true);
      if (!parent || parent.kind !== "directory") {
        throw new Error(`Parent is not a directory: ${parentPath}`);
      }

      const now = Date.now();
      parent.children.set(name, {
        kind: "file",
        content: bytes,
        label,
        metadata: {
          mode: 0o644,
          uid: "user",
          gid: "user",
          mtime: now,
          ctime: now,
          size: bytes.length,
        },
      });

      parent.metadata.mtime = now;
    }
  }

  /**
   * Read directory listing with label
   */
  readdir(path: string): Labeled<string[]> {
    const node = this.resolve(path, true);

    if (!node) {
      throw new Error(`No such directory: ${path}`);
    }

    if (node.kind !== "directory") {
      throw new Error(`Not a directory: ${path}`);
    }

    return {
      value: Array.from(node.children.keys()),
      label: node.label,
    };
  }

  /**
   * Create directory
   */
  mkdir(path: string, recursive = false): void {
    const normalized = this.resolvePath(path);

    if (normalized === "/") {
      return; // Root already exists
    }

    const existing = this.resolve(normalized, true);
    if (existing) {
      if (existing.kind === "directory") {
        return; // Already exists
      }
      throw new Error(`File exists: ${path}`);
    }

    const lastSlash = normalized.lastIndexOf("/");
    const parentPath = lastSlash === 0 ? "/" : normalized.substring(0, lastSlash);
    const name = normalized.substring(lastSlash + 1);

    // Ensure parent exists
    const parent = this.resolve(parentPath, true);

    if (!parent) {
      if (recursive) {
        this.mkdir(parentPath, true);
      } else {
        throw new Error(`No such file or directory: ${parentPath}`);
      }
    }

    const resolvedParent = this.resolve(parentPath, true);
    if (!resolvedParent || resolvedParent.kind !== "directory") {
      throw new Error(`Not a directory: ${parentPath}`);
    }

    const now = Date.now();
    resolvedParent.children.set(name, {
      kind: "directory",
      children: new Map(),
      label: labels.bottom(),
      metadata: {
        mode: 0o755,
        uid: "user",
        gid: "user",
        mtime: now,
        ctime: now,
        size: 0,
      },
    });

    resolvedParent.metadata.mtime = now;
  }

  /**
   * Remove file or directory
   */
  rm(path: string, recursive = false): void {
    const normalized = this.resolvePath(path);

    if (normalized === "/") {
      throw new Error("Cannot remove root directory");
    }

    const node = this.resolve(normalized, true);
    if (!node) {
      throw new Error(`No such file or directory: ${path}`);
    }

    if (node.kind === "directory" && !recursive) {
      if (node.children.size > 0) {
        throw new Error(`Directory not empty: ${path}`);
      }
    }

    const { parent, name } = this.resolveParent(normalized);
    parent.children.delete(name);
    parent.metadata.mtime = Date.now();
  }

  /**
   * Copy file preserving label
   */
  cp(src: string, dst: string): void {
    const srcNode = this.resolve(src, true);

    if (!srcNode) {
      throw new Error(`No such file: ${src}`);
    }

    if (srcNode.kind !== "file") {
      throw new Error(`Not a file: ${src}`);
    }

    this.writeFile(dst, srcNode.content, srcNode.label);
  }

  /**
   * Move/rename file
   */
  mv(src: string, dst: string): void {
    const srcNormalized = this.resolvePath(src);
    const dstNormalized = this.resolvePath(dst);

    if (srcNormalized === "/") {
      throw new Error("Cannot move root directory");
    }

    const srcNode = this.resolve(srcNormalized, true);
    if (!srcNode) {
      throw new Error(`No such file or directory: ${src}`);
    }

    // Remove from source
    const { parent: srcParent, name: srcName } = this.resolveParent(srcNormalized);
    srcParent.children.delete(srcName);

    // Add to destination
    const lastSlash = dstNormalized.lastIndexOf("/");
    const dstParentPath = lastSlash === 0 ? "/" : dstNormalized.substring(0, lastSlash);
    const dstName = dstNormalized.substring(lastSlash + 1);

    this.mkdir(dstParentPath, true);

    const dstParent = this.resolve(dstParentPath, true);
    if (!dstParent || dstParent.kind !== "directory") {
      throw new Error(`Not a directory: ${dstParentPath}`);
    }

    dstParent.children.set(dstName, srcNode);

    const now = Date.now();
    srcParent.metadata.mtime = now;
    dstParent.metadata.mtime = now;
  }

  /**
   * Get file metadata with label
   */
  stat(path: string): Labeled<Metadata> {
    const node = this.resolve(path, true);

    if (!node) {
      throw new Error(`No such file or directory: ${path}`);
    }

    return {
      value: { ...node.metadata },
      label: node.label,
    };
  }

  /**
   * Change file mode
   */
  chmod(path: string, mode: number): void {
    const node = this.resolve(path, true);

    if (!node) {
      throw new Error(`No such file or directory: ${path}`);
    }

    node.metadata.mode = mode;
    node.metadata.mtime = Date.now();
  }

  /**
   * Create symbolic link
   */
  symlink(target: string, linkPath: string): void {
    const normalized = this.resolvePath(linkPath);
    const existing = this.resolve(normalized, false);

    if (existing) {
      throw new Error(`File exists: ${linkPath}`);
    }

    const { parent, name } = this.resolveParent(normalized);

    const now = Date.now();
    parent.children.set(name, {
      kind: "symlink",
      target,
      label: labels.bottom(),
      metadata: {
        mode: 0o777,
        uid: "user",
        gid: "user",
        mtime: now,
        ctime: now,
        size: 0,
      },
    });

    parent.metadata.mtime = now;
  }

  /**
   * Check if path exists
   */
  exists(path: string): boolean {
    return this.resolve(path, true) !== null;
  }
}
