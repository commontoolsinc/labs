import type { Cancel, EntityId } from "@commontools/runner";
import { log } from "../storage.ts";

export interface StorageValue<T = any> {
  value: T;
  source?: EntityId;
}

export interface StorageProvider {
  /**
   * Send a value to storage.
   *
   * @param batch - Batch of entity IDs & values to send.
   * @returns Promise that resolves when the value is sent.
   */
  send<T = any>(
    batch: { entityId: EntityId; value: StorageValue<T> }[],
  ): Promise<
    { ok: object; error?: undefined } | { ok?: undefined; error?: Error }
  >;

  /**
   * Sync a value from storage. Use `get()` to retrieve the value.
   *
   * @param entityId - Entity ID to sync.
   * @param expectedInStorage - Wait for the value, it's assumed to be in
   *   storage eventually.
   * @returns Promise that resolves when the value is synced.
   */
  sync(entityId: EntityId, expectedInStorage?: boolean): Promise<void>;

  /**
   * Get a value from the local cache reflecting storage. Call `sync()` first.
   *
   * @param entityId - Entity ID to get the value for.
   * @returns Value or undefined if the value is not in storage.
   */
  get<T = any>(entityId: EntityId): StorageValue<T> | undefined;

  /**
   * Subscribe to storage updates.
   *
   * @param entityId - Entity ID to subscribe to.
   * @param callback - Callback function.
   * @returns Cancel function to stop the subscription.
   */
  sink<T = any>(
    entityId: EntityId,
    callback: (value: StorageValue<T>) => void,
  ): Cancel;

  /**
   * Destroy the storage provider. Used for tests only.
   *
   * @returns Promise that resolves when the storage provider is destroyed.
   */
  destroy(): Promise<void>;

  /**
   * Get the storage provider's replica.
   *
   * @returns The storage provider's replica.
   */
  getReplica(): string | undefined;
}

export abstract class BaseStorageProvider implements StorageProvider {
  protected subscribers = new Map<string, Set<(value: StorageValue) => void>>();
  protected waitingForSync = new Map<string, Promise<void>>();
  protected waitingForSyncResolvers = new Map<string, () => void>();

  abstract send<T = any>(
    batch: { entityId: EntityId; value: StorageValue<T> }[],
  ): Promise<
    { ok: object; error?: undefined } | { ok?: undefined; error: Error }
  >;

  abstract sync(entityId: EntityId, expectedInStorage: boolean): Promise<void>;

  abstract get<T = any>(entityId: EntityId): StorageValue<T> | undefined;

  sink<T = any>(
    entityId: EntityId,
    callback: (value: StorageValue<T>) => void,
  ): Cancel {
    const key = JSON.stringify(entityId);

    if (!this.subscribers.has(key)) {
      this.subscribers.set(key, new Set<(value: StorageValue) => void>());
    }
    const listeners = this.subscribers.get(key)!;
    listeners.add(callback);

    return () => {
      listeners.delete(callback);
      if (listeners.size === 0) this.subscribers.delete(key);
    };
  }

  protected notifySubscribers(key: string, value: StorageValue): void {
    log(() => [`notify subscribers ${key} ${JSON.stringify(value)}`]);
    const listeners = this.subscribers.get(key);
    if (this.waitingForSync.has(key) && listeners && listeners.size > 0) {
      throw new Error(
        "Subscribers are expected to only start after first sync.",
      );
    }
    this.resolveWaitingForSync(key);
    if (listeners) { for (const listener of listeners) listener(value); }
  }

  protected waitForSync(key: string): Promise<void> {
    if (!this.waitingForSync.has(key)) {
      this.waitingForSync.set(
        key,
        new Promise((r) => this.waitingForSyncResolvers.set(key, r)),
      );
    }
    log(() => [`waiting for sync ${key} ${[...this.waitingForSync.keys()]}`]);
    return this.waitingForSync.get(key)!;
  }

  protected resolveWaitingForSync(key: string): void {
    const resolver = this.waitingForSyncResolvers.get(key);
    if (resolver) {
      resolver();
      this.waitingForSync.delete(key);
    }
  }

  abstract destroy(): Promise<void>;

  abstract getReplica(): string | undefined;
}
