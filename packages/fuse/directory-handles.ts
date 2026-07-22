import { DIR_MODE } from "./platform.ts";
import { nodeMode } from "./stat.ts";
import { FsTree } from "./tree.ts";

/** Minimal bridge surface needed to prepare a dynamic directory. */
export interface DirectoryPreparer {
  shouldPrepareDirectory(ino: bigint): boolean;
  prepareDirectory(ino: bigint): Promise<boolean>;
  prepareDirectorySnapshot?(
    ino: bigint,
  ): Promise<readonly DirectorySnapshotEntry[] | undefined>;
}

export interface DirectorySnapshotEntry {
  readonly name: string;
  readonly ino: bigint;
  readonly mode: number;
}

/** Capture the current directory entries and modes in iteration order. */
export function collectDirectorySnapshot(
  tree: FsTree,
  ino: bigint,
  isWritable: (childIno: bigint) => boolean = () => false,
): DirectorySnapshotEntry[] {
  const entries: DirectorySnapshotEntry[] = [
    { name: ".", ino, mode: DIR_MODE },
    {
      name: "..",
      ino: tree.parents.get(ino) ?? tree.rootIno,
      mode: DIR_MODE,
    },
  ];
  for (const [name, childIno] of tree.getChildren(ino)) {
    const child = tree.getNode(childIno);
    if (!child) continue;
    entries.push({
      name,
      ino: childIno,
      mode: nodeMode(child, isWritable(childIno)),
    });
  }
  return entries;
}

/** Capture virtual directory names without adding them to the inode tree. */
export function collectVirtualDirectorySnapshot(
  tree: FsTree,
  ino: bigint,
  names: readonly string[],
): DirectorySnapshotEntry[] {
  return [
    { name: ".", ino, mode: DIR_MODE },
    {
      name: "..",
      ino: tree.parents.get(ino) ?? tree.rootIno,
      mode: DIR_MODE,
    },
    ...names.map((name) => ({
      name,
      ino: tree.lookup(ino, name) ?? 0n,
      mode: DIR_MODE,
    })),
  ];
}

interface DirectoryHandleState {
  entries?: readonly DirectorySnapshotEntry[];
  ino: bigint;
  pending?: Promise<readonly DirectorySnapshotEntry[] | undefined>;
  prepared: boolean;
}

/** Tracks whether a directory has been prepared for an open FUSE handle. */
export class DirectoryHandleMap {
  #nextFh = 1n;
  #handles = new Map<bigint, DirectoryHandleState>();

  open(ino: bigint): bigint {
    const fh = this.#nextFh++;
    this.#handles.set(fh, { ino, prepared: false });
    return fh;
  }

  isPrepared(fh: bigint, ino: bigint): boolean {
    const state = this.#handles.get(fh);
    return state?.ino === ino && state.prepared;
  }

  markPrepared(fh: bigint, ino: bigint): void {
    const state = this.#handles.get(fh);
    if (state?.ino === ino) {
      state.pending = undefined;
      state.prepared = true;
    }
  }

  pending(
    fh: bigint,
    ino: bigint,
  ): Promise<readonly DirectorySnapshotEntry[] | undefined> | undefined {
    const state = this.#handles.get(fh);
    return state?.ino === ino ? state.pending : undefined;
  }

  trackPending(
    fh: bigint,
    ino: bigint,
    pending: Promise<readonly DirectorySnapshotEntry[] | undefined>,
  ): void {
    const state = this.#handles.get(fh);
    if (state?.ino === ino) state.pending = pending;
  }

  clearPending(
    fh: bigint,
    ino: bigint,
    pending: Promise<readonly DirectorySnapshotEntry[] | undefined>,
  ): void {
    const state = this.#handles.get(fh);
    if (state?.ino === ino && state.pending === pending) {
      state.pending = undefined;
    }
  }

  close(fh: bigint): void {
    this.#handles.delete(fh);
  }

  has(fh: bigint, ino: bigint): boolean {
    return this.#handles.get(fh)?.ino === ino;
  }

  snapshot(
    fh: bigint,
    ino: bigint,
    create: () => DirectorySnapshotEntry[],
  ): readonly DirectorySnapshotEntry[] {
    const state = this.#handles.get(fh);
    if (state?.ino !== ino) return create();
    state.entries ??= create();
    return state.entries;
  }

  setSnapshot(
    fh: bigint,
    ino: bigint,
    entries: readonly DirectorySnapshotEntry[],
  ): void {
    const state = this.#handles.get(fh);
    if (state?.ino === ino) state.entries = entries;
  }
}

/**
 * Prepare a dynamic directory unless this open handle already owns a prepared
 * snapshot. Calls without a tracked handle preserve the legacy behavior and
 * prepare on every read.
 */
export function prepareDirectoryForHandle(
  handles: DirectoryHandleMap,
  fh: bigint,
  ino: bigint,
  preparer: DirectoryPreparer | null | undefined,
): Promise<readonly DirectorySnapshotEntry[] | undefined> | undefined {
  if (handles.isPrepared(fh, ino)) return undefined;

  const tracked = handles.has(fh, ino);
  const pending = handles.pending(fh, ino);
  if (pending) return pending;
  if (!preparer?.shouldPrepareDirectory(ino)) {
    if (tracked) handles.markPrepared(fh, ino);
    return undefined;
  }

  const preparation = (
    preparer.prepareDirectorySnapshot
      ? preparer.prepareDirectorySnapshot(ino)
      : preparer.prepareDirectory(ino).then(() => undefined)
  ).then((entries) => {
    if (tracked) {
      if (entries) handles.setSnapshot(fh, ino, entries);
      handles.markPrepared(fh, ino);
    }
    return entries;
  });
  if (!tracked) return preparation;

  const trackedPreparation = preparation.finally(() => {
    handles.clearPending(fh, ino, trackedPreparation);
  });
  handles.trackPending(fh, ino, trackedPreparation);
  return trackedPreparation;
}
