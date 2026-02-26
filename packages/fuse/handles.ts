// handles.ts — File handle tracking for write support

import { O_RDWR, O_WRONLY } from "./ffi-types.ts";

export interface HandleState {
  ino: bigint;
  flags: number;
  dirty: boolean;
  buffer: Uint8Array;
}

export class HandleMap {
  private nextFh = 1n;
  private handles = new Map<bigint, HandleState>();

  /** Open a file handle. Copies current content into buffer if writable. */
  open(ino: bigint, flags: number, content?: Uint8Array): bigint {
    const fh = this.nextFh++;
    const isWritable = (flags & O_WRONLY) !== 0 || (flags & O_RDWR) !== 0;
    this.handles.set(fh, {
      ino,
      flags,
      dirty: false,
      buffer: isWritable ? new Uint8Array(content ?? []) : new Uint8Array(0),
    });
    return fh;
  }

  get(fh: bigint): HandleState | undefined {
    return this.handles.get(fh);
  }

  close(fh: bigint): HandleState | undefined {
    const state = this.handles.get(fh);
    if (state) {
      this.handles.delete(fh);
    }
    return state;
  }

  /** Write data into the handle's buffer at offset, extending if needed. */
  write(fh: bigint, data: Uint8Array, offset: number): boolean {
    const state = this.handles.get(fh);
    if (!state) return false;

    const end = offset + data.length;
    if (end > state.buffer.length) {
      // Extend buffer
      const newBuf = new Uint8Array(end);
      newBuf.set(state.buffer);
      state.buffer = newBuf;
    }
    state.buffer.set(data, offset);
    state.dirty = true;
    return true;
  }

  /** Truncate all handles for a given inode to the specified size. */
  truncateByIno(ino: bigint, size: number): void {
    for (const [, state] of this.handles) {
      if (state.ino === ino) {
        if (size < state.buffer.length) {
          state.buffer = state.buffer.slice(0, size);
        } else if (size > state.buffer.length) {
          const newBuf = new Uint8Array(size);
          newBuf.set(state.buffer);
          state.buffer = newBuf;
        }
        state.dirty = true;
      }
    }
  }

  /** Truncate the handle's buffer to the given size. */
  truncate(fh: bigint, size: number): boolean {
    const state = this.handles.get(fh);
    if (!state) return false;

    if (size < state.buffer.length) {
      state.buffer = state.buffer.slice(0, size);
    } else if (size > state.buffer.length) {
      const newBuf = new Uint8Array(size);
      newBuf.set(state.buffer);
      state.buffer = newBuf;
    }
    state.dirty = true;
    return true;
  }
}
