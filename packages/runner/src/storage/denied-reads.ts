/**
 * Reads that reached a space the memory server has refused this runtime. A
 * transaction records the first such read it makes, and the scheduler parks a
 * reactive run that made one instead of committing it, so that nothing a
 * principal computed from a space it cannot see reaches shared state. The
 * verdict is the storage manager's per-space one: a document that is merely
 * absent from a space the principal may read is not recorded here.
 */

import type { IMemorySpaceAddress } from "./interface.ts";

/** Signals that a run read a document of a space its principal may not read. */
export class DeniedReadUnavailable extends Error {
  #address: IMemorySpaceAddress;

  /** Constructs an instance naming the denied read. */
  constructor(address: IMemorySpaceAddress) {
    super(`The space ${address.space} is not readable by this principal`);
    this.name = "DeniedReadUnavailable";
    this.#address = { ...address, path: [...address.path] };
  }

  /** The read that reached the refused space. */
  get address(): IMemorySpaceAddress {
    return this.#address;
  }
}

const deniedReads = new WeakMap<object, IMemorySpaceAddress>();

/**
 * Records that `tx` read `address`, whose space the memory server has refused
 * this runtime. The first such read is kept and later ones are not: one
 * suffices to decide the run's fate, and the first names the space a wake
 * waits on.
 */
export function noteDeniedRead(tx: object, address: IMemorySpaceAddress): void {
  if (!deniedReads.has(tx)) {
    deniedReads.set(tx, { ...address, path: [...address.path] });
  }
}

/** The first denied read `tx` made, or `undefined` when it made none. */
export function deniedReadOf(tx: object): IMemorySpaceAddress | undefined {
  return deniedReads.get(tx);
}
