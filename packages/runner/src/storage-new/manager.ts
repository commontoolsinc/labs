import type {
  IStorageManager,
  IStorageProviderWithReplica,
  IStorageSubscription,
} from "../storage/interface.ts";
import type { MemorySpace } from "../storage.ts";
import * as SubscriptionManager from "../storage/subscription.ts";
import { StorageClient } from "../../../storage/src/client/index.ts";
import { NewStorageProvider } from "./provider.ts";
import { uriFromDocId } from "./address.ts";
import { NewStorageTransaction } from "./transaction.ts";

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
  #apiUrl?: URL;
  #subscription = SubscriptionManager.create();

  constructor(
    delegate: IStorageManager,
    opts?: {
      apiUrl?: URL;
      logLevel?: "off" | "error" | "warn" | "info" | "debug";
      client?: StorageClient;
    },
  ) {
    this.#delegate = delegate;
    this.#apiUrl = opts?.apiUrl;
    this.#client = opts?.client ?? new StorageClient({
      baseUrl: opts?.apiUrl?.toString(),
      logLevel: opts?.logLevel,
    });
    // Forward notifications from legacy delegate to our hub (commit/revert/load/etc.)
    this.#delegate.subscribe({
      next: (n) => this.#subscription.next(n),
    });
    // Bridge storage client change events to runner notifications
    this.#client.onChange((e) => {
      // Coarse integrate notification on any doc change
      const uri = uriFromDocId(e.docId) ?? (`doc:${e.docId}` as any);
      this.#subscription.next({
        type: "integrate",
        space: e.space as MemorySpace,
        changes: {
          // Implement Iterable<IMemoryChange> minimal stub
          [Symbol.iterator](): Iterator<
            import("../storage/interface.ts").IMemoryChange
          > {
            let i = 0;
            const changes: Array<
              import("../storage/interface.ts").IMemoryChange
            > = [
              {
                address: {
                  id: uri,
                  type: "application/json",
                  path: [],
                },
                before: e.before as any,
                after: e.after as any,
              },
            ];
            return {
              next: () => {
                if (i >= changes.length) {
                  return { done: true, value: undefined } as IteratorResult<
                    any
                  >;
                }
                const value = changes[i++]!;
                return { done: false, value } as IteratorResult<any>;
              },
            } as Iterator<any>;
          },
        },
      });
    });
  }

  open(space: MemorySpace): IStorageProviderWithReplica {
    const key = String(space);
    let p = this.#providers.get(key);
    if (!p) {
      // Temporary: wrap legacy provider; will switch to true adapter
      p = new NewStorageProvider(
        this.#client,
        space,
        this.#delegate.open(space),
      );
      this.#providers.set(key, p);
    }
    // Non-null after construction above
    return p!;
  }

  edit() {
    // Wrap legacy transaction to allow incremental migration to client-backed
    // adapter without changing behavior yet.
    return new NewStorageTransaction(this.#delegate.edit(), this.#client);
  }

  subscribe(subscription: IStorageSubscription): void {
    this.#subscription.subscribe(subscription);
  }

  async synced(): Promise<void> {
    // Wait for both legacy delegate and new client to settle
    await this.#delegate.synced();
    await this.#client.synced();
  }
}
