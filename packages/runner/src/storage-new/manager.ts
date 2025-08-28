import type {
  IStorageManager,
  IStorageProviderWithReplica,
} from "../storage/interface.ts";
import type { MemorySpace } from "../storage.ts";

/**
 * Placeholder NewStorageManager adapter that will wrap the new storage client.
 * This scaffolding returns the existing cache-based manager to avoid behavior
 * changes until the adapter is implemented.
 */
export class NewStorageManager implements IStorageManager {
  id = "new-storage-adapter";

  constructor(private readonly delegate: IStorageManager) {}

  open(space: MemorySpace): IStorageProviderWithReplica {
    return this.delegate.open(space);
  }

  edit() {
    return this.delegate.edit();
  }

  subscribe(subscription: import("../storage/interface.ts").IStorageSubscription): void {
    this.delegate.subscribe(subscription);
  }

  async synced(): Promise<void> {
    await this.delegate.synced();
  }
}


