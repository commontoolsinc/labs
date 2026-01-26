import type { Revision, State } from "@commontools/memory/interface";

import type {
  BaseMemoryAddress,
  IAttestation,
  ObjectStorageManager,
} from "../traverse.ts";

// Object Manager backed by a store map
export class StoreObjectManager implements ObjectStorageManager {
  private readValues = new Map<string, IAttestation>();
  private missingDocs = new Map<string, BaseMemoryAddress>();

  constructor(private store = new Map<string, Revision<State>>()) {
  }

  getReadDocs(): Iterable<IAttestation> {
    return this.readValues.values();
  }

  getMissingDocs(): Iterable<BaseMemoryAddress> {
    return this.missingDocs.values();
  }

  // Returns null if there is no matching fact
  load(address: BaseMemoryAddress): IAttestation | null {
    const key = `${address.id}/${address.type}`;
    if (this.readValues.has(key)) {
      return this.readValues.get(key)!;
    }
    // we should only have one match
    if (this.store.has(key)) {
      const storeValue = this.store.get(key);
      const rv = { address: { ...address, path: [] }, value: storeValue?.is };
      this.readValues.set(key, rv);
      return rv;
    } else {
      if (!this.missingDocs.has(key)) {
        this.missingDocs.set(key, address);
      }
    }
    return null;
  }
}
