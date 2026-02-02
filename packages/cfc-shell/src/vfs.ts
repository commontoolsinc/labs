/**
 * Virtual Filesystem (VFS) for CFC Shell
 *
 * Provides an in-memory filesystem where every file carries a CFC label.
 * Implements label monotonicity: a file's label can only become more restrictive,
 * never less restrictive.
 */

import { Atom, Label, Labeled, labels } from "./labels.ts";

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
// Mount Types
// ============================================================================

export interface MountOptions {
  /** Real filesystem path to mount */
  hostPath: string;
  /** VFS path to mount at */
  mountPoint: string;
  /** Default label for files without a stored label */
  defaultLabel: Label;
  /** If true, mount is read-only (writes throw) */
  readOnly?: boolean;
}

interface MountEntry {
  hostPath: string;
  mountPoint: string;
  defaultLabel: Label;
  readOnly: boolean;
  /** Cached label store — loaded lazily from .cfc-labels.json */
  labelStore: Map<string, SerializedLabel> | null;
}

/** JSON-serializable label for the sidecar file */
interface SerializedLabel {
  confidentiality: Atom[][];
  integrity: Atom[];
}

const LABEL_SIDECAR = ".cfc-labels.json";

// ============================================================================
// VFS Class
// ============================================================================

export class VFS {
  private root: DirectoryNode;
  public cwd: string;
  private textEncoder = new TextEncoder();
  private textDecoder = new TextDecoder();
  private mounts: MountEntry[] = [];

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
    // Check mounts first
    const mounted = this.readMountedFile(path);
    if (mounted) return mounted;

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
    // Check mounts first
    if (this.writeMountedFile(path, content, label)) return;

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
    // Check mounts first
    const mounted = this.readMountedDir(path);
    if (mounted) return mounted;

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
    // Check mounts first
    const mounted = this.statMounted(path);
    if (mounted) return mounted;

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
    const mounted = this.existsMounted(path);
    if (mounted !== null) return mounted;
    return this.resolve(path, true) !== null;
  }

  // ==========================================================================
  // Mount Support
  // ==========================================================================

  /**
   * Mount a real filesystem directory at a VFS path.
   * Files are read/written through to the host filesystem.
   * Labels are stored in a `.cfc-labels.json` sidecar at the host path root.
   */
  mount(options: MountOptions): void {
    const mountPoint = this.resolvePath(options.mountPoint);

    // Check for overlapping mounts
    for (const m of this.mounts) {
      if (mountPoint === m.mountPoint) {
        throw new Error(`Already mounted at ${mountPoint}`);
      }
      if (mountPoint.startsWith(m.mountPoint + "/") || m.mountPoint.startsWith(mountPoint + "/")) {
        throw new Error(`Overlapping mount: ${mountPoint} conflicts with ${m.mountPoint}`);
      }
    }

    this.mounts.push({
      hostPath: options.hostPath,
      mountPoint,
      defaultLabel: options.defaultLabel,
      readOnly: options.readOnly ?? false,
      labelStore: null,
    });

    // Sort longest-first so inner mounts are checked first
    this.mounts.sort((a, b) => b.mountPoint.length - a.mountPoint.length);
  }

  /**
   * Unmount a previously mounted path.
   * Flushes any pending label changes before unmounting.
   */
  unmount(mountPoint: string): void {
    const normalized = this.resolvePath(mountPoint);
    const idx = this.mounts.findIndex(m => m.mountPoint === normalized);
    if (idx === -1) {
      throw new Error(`Not mounted: ${mountPoint}`);
    }
    this.mounts.splice(idx, 1);
  }

  /** Get all current mounts */
  getMounts(): ReadonlyArray<{ mountPoint: string; hostPath: string; readOnly: boolean }> {
    return this.mounts.map(m => ({
      mountPoint: m.mountPoint,
      hostPath: m.hostPath,
      readOnly: m.readOnly,
    }));
  }

  /**
   * Find a mount that covers the given normalized VFS path.
   * Returns the mount entry and the relative path within the mount.
   */
  private findMount(normalizedPath: string): { mount: MountEntry; relPath: string } | null {
    for (const m of this.mounts) {
      if (normalizedPath === m.mountPoint) {
        return { mount: m, relPath: "" };
      }
      if (normalizedPath.startsWith(m.mountPoint + "/")) {
        return { mount: m, relPath: normalizedPath.slice(m.mountPoint.length) };
      }
    }
    return null;
  }

  /**
   * Resolve the real host path for a mounted VFS path.
   */
  private hostPathFor(mount: MountEntry, relPath: string): string {
    if (relPath === "" || relPath === "/") return mount.hostPath;
    return mount.hostPath + relPath;
  }

  /**
   * Load the label store for a mount (lazy, cached).
   */
  private loadLabelStore(mount: MountEntry): Map<string, SerializedLabel> {
    if (mount.labelStore !== null) return mount.labelStore;

    mount.labelStore = new Map();
    const sidecarPath = mount.hostPath + "/" + LABEL_SIDECAR;
    try {
      const data = Deno.readTextFileSync(sidecarPath);
      const parsed = JSON.parse(data) as Record<string, SerializedLabel>;
      for (const [key, val] of Object.entries(parsed)) {
        mount.labelStore.set(key, val);
      }
    } catch {
      // No sidecar yet — that's fine
    }
    return mount.labelStore;
  }

  /**
   * Persist the label store to the sidecar file.
   */
  private saveLabelStore(mount: MountEntry): void {
    const store = this.loadLabelStore(mount);
    const obj: Record<string, SerializedLabel> = {};
    for (const [key, val] of store) {
      obj[key] = val;
    }
    const sidecarPath = mount.hostPath + "/" + LABEL_SIDECAR;
    Deno.writeTextFileSync(sidecarPath, JSON.stringify(obj, null, 2) + "\n");
  }

  /**
   * Get the label for a file in a mount, falling back to the default label.
   */
  private getMountLabel(mount: MountEntry, relPath: string): Label {
    const store = this.loadLabelStore(mount);
    const stored = store.get(relPath);
    if (stored) {
      return {
        confidentiality: stored.confidentiality,
        integrity: stored.integrity,
      };
    }
    return mount.defaultLabel;
  }

  /**
   * Store a label for a file in a mount.
   */
  private setMountLabel(mount: MountEntry, relPath: string, label: Label): void {
    const store = this.loadLabelStore(mount);
    store.set(relPath, {
      confidentiality: label.confidentiality,
      integrity: label.integrity,
    });
    this.saveLabelStore(mount);
  }

  // ==========================================================================
  // Mount-aware overrides for public methods
  // ==========================================================================

  /**
   * Read a file, checking mounts first.
   */
  readMountedFile(path: string): Labeled<Uint8Array> | null {
    const normalized = this.resolvePath(path);
    const found = this.findMount(normalized);
    if (!found) return null;

    const hostPath = this.hostPathFor(found.mount, found.relPath);
    const content = Deno.readFileSync(hostPath);
    const label = this.getMountLabel(found.mount, found.relPath);
    return { value: content, label };
  }

  /**
   * Write a file through a mount.
   */
  writeMountedFile(path: string, content: Uint8Array | string, label: Label): boolean {
    const normalized = this.resolvePath(path);
    const found = this.findMount(normalized);
    if (!found) return false;

    if (found.mount.readOnly) {
      throw new Error(`Read-only mount: ${found.mount.mountPoint}`);
    }

    const hostPath = this.hostPathFor(found.mount, found.relPath);
    const bytes = typeof content === "string"
      ? this.textEncoder.encode(content)
      : content;

    // Ensure parent directory exists on host
    const lastSlash = hostPath.lastIndexOf("/");
    if (lastSlash > 0) {
      Deno.mkdirSync(hostPath.substring(0, lastSlash), { recursive: true });
    }

    Deno.writeFileSync(hostPath, bytes);
    this.setMountLabel(found.mount, found.relPath, label);
    return true;
  }

  /**
   * List directory entries from a mount.
   */
  readMountedDir(path: string): Labeled<string[]> | null {
    const normalized = this.resolvePath(path);
    const found = this.findMount(normalized);
    if (!found) return null;

    const hostPath = this.hostPathFor(found.mount, found.relPath);
    const entries: string[] = [];
    for (const entry of Deno.readDirSync(hostPath)) {
      if (entry.name === LABEL_SIDECAR) continue; // hide sidecar
      entries.push(entry.name);
    }
    return { value: entries, label: found.mount.defaultLabel };
  }

  /**
   * Stat a mounted path.
   */
  statMounted(path: string): Labeled<Metadata> | null {
    const normalized = this.resolvePath(path);
    const found = this.findMount(normalized);
    if (!found) return null;

    const hostPath = this.hostPathFor(found.mount, found.relPath);
    const info = Deno.statSync(hostPath);
    const label = this.getMountLabel(found.mount, found.relPath);

    return {
      value: {
        mode: info.mode ?? 0o644,
        uid: "user",
        gid: "user",
        mtime: info.mtime?.getTime() ?? Date.now(),
        ctime: info.birthtime?.getTime() ?? Date.now(),
        size: info.size,
      },
      label,
    };
  }

  /**
   * Check if a mounted path exists.
   */
  existsMounted(path: string): boolean | null {
    const normalized = this.resolvePath(path);
    const found = this.findMount(normalized);
    if (!found) return null;

    const hostPath = this.hostPathFor(found.mount, found.relPath);
    try {
      Deno.statSync(hostPath);
      return true;
    } catch {
      return false;
    }
  }
}
