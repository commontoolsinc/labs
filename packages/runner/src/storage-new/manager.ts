import type {
  IStorageManager,
  IStorageProviderWithReplica,
  IStorageSubscription,
} from "../storage/interface.ts";
import type { MemorySpace } from "../storage.ts";
import { StorageClient } from "../../../storage/src/client/index.ts";
import { NewStorageProvider } from "./provider.ts";

/**
 * Placeholder NewStorageManager adapter that will wrap the new storage client.
 * This scaffolding returns the existing cache-based manager to avoid behavior
 * changes until the adapter is implemented.
 */
export class NewStorageManager implements IStorageManager {
  id = "new-storage-adapter";

  #client: StorageClient;
  #delegate: IStorageManager;
  #providers = new Map<string, IStorageProviderWithReplica>();

  constructor(delegate: IStorageManager, opts?: { apiUrl?: URL }) {
    this.#delegate = delegate;
    this.#client = new StorageClient({ baseUrl: opts?.apiUrl?.toString() });
  }

  open(space: MemorySpace): IStorageProviderWithReplica {
    const key = String(space);
    let p = this.#providers.get(key);
    if (!p) {
      // Temporary: wrap legacy provider; will switch to true adapter
      p = new NewStorageProvider(this.#delegate.open(space));
      this.#providers.set(key, p);
    }
    return p;
  }

  edit() {
    // Temporary: delegate transaction until new adapter is implemented
    return this.#delegate.edit();
  }

  subscribe(subscription: IStorageSubscription): void {
    this.#delegate.subscribe(subscription);
  }

  async synced(): Promise<void> {
    await this.#delegate.synced();
  }
}
