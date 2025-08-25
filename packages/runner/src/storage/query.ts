import type { Revision, State } from "@commontools/memory/interface";
import type { JSONValue } from "../builder/types.ts";

import {
  type BaseMemoryAddress,
  BaseObjectManager,
  IAttestation,
} from "../traverse.ts";

export abstract class ClientObjectManager
  extends BaseObjectManager<BaseMemoryAddress, JSONValue | undefined> {
  // Cache our read labels, and any docs we can't read
  public missingDocs = new Map<string, BaseMemoryAddress>();

  constructor() {
    super();
  }

  getReadDocs(): Iterable<IAttestation> {
    return this.readValues.values();
  }

  getMissingDocs(): Iterable<BaseMemoryAddress> {
    return this.missingDocs.values();
  }
}

// Object Manager backed by a store map
export class StoreObjectManager extends ClientObjectManager {
  constructor(
    private store: Map<string, Revision<State>>,
  ) {
    super();
  }

  // Returns null if there is no matching fact
  override load(address: BaseMemoryAddress): IAttestation | null {
    const key = this.toKey(address);
    if (this.readValues.has(key)) {
      return this.readValues.get(key)!;
    }
    // we should only have one match
    if (this.store.has(key)) {
      const storeValue = this.store.get(key);
      const rv = { address: { path: [], ...address }, value: storeValue?.is };
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
