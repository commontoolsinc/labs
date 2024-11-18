import type { EntityId, Cancel } from "@commontools/common-runner";
import { log } from "./storage.js";

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
  ): Promise<void>;

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
}

abstract class BaseStorageProvider implements StorageProvider {
  protected subscribers = new Map<string, Set<(value: StorageValue) => void>>();
  protected waitingForSync = new Map<string, Promise<void>>();
  protected waitingForSyncResolvers = new Map<string, () => void>();

  abstract send<T = any>(
    batch: { entityId: EntityId; value: StorageValue<T> }[],
  ): Promise<void>;

  abstract sync(entityId: EntityId, expectedInStorage: boolean): Promise<void>;

  abstract get<T = any>(entityId: EntityId): StorageValue<T> | undefined;

  sink<T = any>(
    entityId: EntityId,
    callback: (value: StorageValue<T>) => void,
  ): Cancel {
    const key = JSON.stringify(entityId);

    if (!this.subscribers.has(key))
      this.subscribers.set(key, new Set<(value: StorageValue) => void>());
    const listeners = this.subscribers.get(key)!;
    listeners.add(callback);

    return () => {
      listeners.delete(callback);
      if (listeners.size === 0) this.subscribers.delete(key);
    };
  }

  protected notifySubscribers(key: string, value: StorageValue): void {
    log("notify subscribers", key, JSON.stringify(value));
    const listeners = this.subscribers.get(key);
    if (this.waitingForSync.has(key) && listeners && listeners.size > 0)
      throw new Error(
        "Subscribers are expected to only start after first sync.",
      );
    this.resolveWaitingForSync(key);
    if (listeners) for (const listener of listeners) listener(value);
  }

  protected waitForSync(key: string): Promise<void> {
    if (!this.waitingForSync.has(key))
      this.waitingForSync.set(
        key,
        new Promise((r) => this.waitingForSyncResolvers.set(key, r)),
      );
    log("waiting for sync", key, [...this.waitingForSync.keys()]);
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
}
/**
 * In-memory storage provider. Just for testing.
 *
 * It doesn't make much sense,  since it's just a copy of the in memory cells.
 * But for testing we can create multiple instances that share the memory.
 */
const inMemoryStorage = new Map<string, StorageValue>();
const inMemoryStorageSubscribers = new Set<
  (key: string, value: StorageValue) => void
>();
export class InMemoryStorageProvider extends BaseStorageProvider {
  private handleStorageUpdateFn: (key: string, value: any) => void;
  private lastValues = new Map<string, string | undefined>();

  constructor() {
    super();
    this.handleStorageUpdateFn = this.handleStorageUpdate.bind(this);
    inMemoryStorageSubscribers.add(this.handleStorageUpdateFn);
  }

  private handleStorageUpdate(key: string, value: StorageValue) {
    const valueString = JSON.stringify(value);
    if (this.lastValues.get(key) !== valueString) {
      this.lastValues.set(key, valueString);
      this.notifySubscribers(key, value);
    }
  }

  async send<T = any>(
    batch: { entityId: EntityId; value: StorageValue<T> }[],
  ): Promise<void> {
    for (const { entityId, value } of batch) {
      const key = JSON.stringify(entityId);
      const valueString = JSON.stringify(value);
      if (this.lastValues.get(key) !== valueString) {
        log("send in memory", key, valueString);
        this.lastValues.set(key, valueString);
        inMemoryStorage.set(key, value);
        inMemoryStorageSubscribers.forEach((listener) => listener(key, value));
      }
    }
  }

  async sync(
    entityId: EntityId,
    expectedInStorage: boolean = false,
  ): Promise<void> {
    const key = JSON.stringify(entityId);
    log("sync in memory", key, this.lastValues.get(key));
    if (inMemoryStorage.has(key))
      this.lastValues.set(key, JSON.stringify(inMemoryStorage.get(key)!));
    else if (expectedInStorage)
      return Promise.resolve(); // nothing to sync
    else this.lastValues.delete(key);
  }

  get<T>(entityId: EntityId): StorageValue<T> | undefined {
    const key = JSON.stringify(entityId);
    log("get in memory", key, this.lastValues.get(key));
    return this.lastValues.has(key)
      ? (JSON.parse(this.lastValues.get(key)!) as StorageValue)
      : undefined;
  }

  async destroy(): Promise<void> {
    inMemoryStorageSubscribers.delete(this.handleStorageUpdateFn);
    inMemoryStorage.clear();
    this.subscribers.clear();
  }
}

/**
 * Local storage provider for browser.
 */
export class LocalStorageProvider extends BaseStorageProvider {
  private prefix: string;
  private lastValues = new Map<string, string | undefined>();

  private handleStorageEventFn: (event: StorageEvent) => void;

  constructor(prefix: string = "common_storage_") {
    if (typeof window === "undefined" || !window.localStorage)
      throw new Error("LocalStorageProvider is not supported in the browser");
    super();
    this.prefix = prefix;
    this.handleStorageEventFn = this.handleStorageEvent.bind(this);
    window.addEventListener("storage", this.handleStorageEventFn);
  }

  async send<T = any>(
    batch: { entityId: EntityId; value: StorageValue<T> }[],
  ): Promise<void> {
    for (const { entityId, value } of batch) {
      const key = this.getKey(entityId);
      const storeValue = JSON.stringify(value);
      if (this.lastValues.get(key) !== storeValue) {
        if (
          (localStorage.getItem(key) ?? undefined) !== this.lastValues.get(key)
        ) {
          log(
            "localstorage changed, aborting update",
            key,
            localStorage.getItem(key),
            this.lastValues.get(key) ?? null,
            storeValue,
          );
          // Storage changed while we were processing, and we assume LWW, so
          // we'll skip the update. The storage change will trigger an event, so
          // we'll get the other state soon.
          continue;
        } else {
          localStorage.setItem(key, storeValue);
          this.lastValues.set(key, storeValue);
          log("send localstorage", key, storeValue.length, storeValue);
        }
      }
    }
  }

  async sync(
    entityId: EntityId,
    expectedInStorage: boolean = false,
  ): Promise<void> {
    const key = this.getKey(entityId);
    const value = localStorage.getItem(key);
    log("sync localstorage", key, value);
    if (value === null)
      if (expectedInStorage) {
        // Timeout of 1 second to allow for the value to be set by another tab.
        // This is more than enough, since the race condition we're looking for
        // is just that a batch is written by the other tab, and we encounter a
        // dependency in the beginning of the batch before the whole batch is
        // written.
        setTimeout(
          () => this.resolveWaitingForSync(this.entityIdStrFromKey(key)),
          1000,
        );
        return this.waitForSync(this.entityIdStrFromKey(key));
      } else this.lastValues.delete(key);
    else this.lastValues.set(key, value);
  }

  get<T>(entityId: EntityId): StorageValue<T> | undefined {
    const key = this.getKey(entityId);
    const value = this.lastValues.get(key);
    log("get localstorage", key, value);
    if (value === null || value === undefined) return undefined;
    else return JSON.parse(value) as StorageValue<T>;
  }

  async destroy(): Promise<void> {
    window.removeEventListener("storage", this.handleStorageEventFn);
    log("clear localstorage", this.prefix);
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith(this.prefix)) {
        localStorage.removeItem(key);
      }
    }
    this.subscribers.clear();
  }

  private getKey(entityId: EntityId): string {
    return this.prefix + JSON.stringify(entityId);
  }

  private entityIdStrFromKey(key: string): string {
    return key.slice(this.prefix.length);
  }

  private handleStorageEvent = (event: StorageEvent) => {
    if (event.key?.startsWith(this.prefix)) {
      // Read the latest value from store instead of using event.newValue, since
      // event might have been queued for a while and the value might have
      // changed.
      const newValue = localStorage.getItem(event.key);
      if (this.lastValues.get(event.key) !== newValue) {
        log(
          "storage event",
          event.key,
          newValue?.length,
          this.lastValues.get(event.key)?.length,
          "new:",
          newValue,
          "old:",
          this.lastValues.get(event.key),
        );
        if (newValue === null) this.lastValues.delete(event.key);
        else this.lastValues.set(event.key, newValue);
        const result = newValue !== null ? JSON.parse(newValue) : {};
        this.notifySubscribers(this.entityIdStrFromKey(event.key), result);
      }
    }
  };
}
