/** Minimal bridge surface needed to prepare a dynamic directory. */
export interface DirectoryPreparer {
  shouldPrepareDirectory(ino: bigint): boolean;
  prepareDirectory(ino: bigint): Promise<boolean>;
}

export interface DirectorySnapshotEntry {
  readonly name: string;
  readonly ino: bigint;
  readonly mode: number;
}

interface DirectoryHandleState {
  entries?: readonly DirectorySnapshotEntry[];
  ino: bigint;
  pending?: Promise<void>;
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

  pending(fh: bigint, ino: bigint): Promise<void> | undefined {
    const state = this.#handles.get(fh);
    return state?.ino === ino ? state.pending : undefined;
  }

  trackPending(fh: bigint, ino: bigint, pending: Promise<void>): void {
    const state = this.#handles.get(fh);
    if (state?.ino === ino) state.pending = pending;
  }

  clearPending(fh: bigint, ino: bigint, pending: Promise<void>): void {
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
): Promise<void> | undefined {
  if (handles.isPrepared(fh, ino)) return undefined;

  const tracked = handles.has(fh, ino);
  const pending = handles.pending(fh, ino);
  if (pending) return pending;
  if (!preparer?.shouldPrepareDirectory(ino)) {
    if (tracked) handles.markPrepared(fh, ino);
    return undefined;
  }

  const preparation = preparer.prepareDirectory(ino).then(() => {
    if (tracked) handles.markPrepared(fh, ino);
  });
  if (!tracked) return preparation;

  const trackedPreparation = preparation.finally(() => {
    handles.clearPending(fh, ino, trackedPreparation);
  });
  handles.trackPending(fh, ino, trackedPreparation);
  return trackedPreparation;
}
