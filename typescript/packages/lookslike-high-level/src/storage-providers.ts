import type { EntityId, Cancel } from "@commontools/common-runner";

export interface StorageValue<T> {
  value: T;
  source?: EntityId;
}

export interface StorageProvider {
  /**
   * Send a value to storage.
   *
   * @param entityId - Entity ID to send the value to.
   * @param value - Value to send.
   * @param source - Optional source entity ID.
   * @returns Promise that resolves when the value is sent.
   */
  send<T = any>(entityId: EntityId, value: StorageValue<T>): Promise<void>;

  /**
   * Sync a value from storage. Use `get()` to retrieve the value.
   *
   * @param entityId - Entity ID to sync.
   * @returns Promise that resolves when the value is synced.
   */
  sync(entityId: EntityId): Promise<void>;

  /**
   * Get a value from the local cache reflecting storage. Call `sync()` first.
   *
   * @param entityId - Entity ID to get the value for.
   * @returns Value and source, or undefined if the value is not in storage.
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
    callback: (value: StorageValue<T>) => void
  ): Cancel;

  /**
   * Destroy the storage provider. Used for tests only.
   *
   * @returns Promise that resolves when the storage provider is destroyed.
   */
  destroy(): Promise<void>;
}

abstract class BaseStorageProvider implements StorageProvider {
  protected subscribers = new Map<
    string,
    Set<(value: any, source?: EntityId) => void>
  >();

  abstract send(entityId: EntityId, value: StorageValue<any>): Promise<void>;

  abstract sync(entityId: EntityId): Promise<void>;

  abstract get(entityId: EntityId): StorageValue<any> | undefined;

  sink<T = any>(
    entityId: EntityId,
    callback: (value: StorageValue<T>) => void
  ): Cancel {
    const key = JSON.stringify(entityId);

    if (!this.subscribers.has(key)) this.subscribers.set(key, new Set());
    const listeners = this.subscribers.get(key)!;
    listeners.add(callback);

    return () => {
      listeners.delete(callback);
      if (listeners.size === 0) this.subscribers.delete(key);
    };
  }

  protected notifySubscribers(key: string, value: StorageValue<any>): void {
    console.log("notify subscribers", key, JSON.stringify(value));
    const listeners = this.subscribers.get(key);
    if (listeners) for (const listener of listeners) listener(value);
  }

  abstract destroy(): Promise<void>;
}
/**
 * In-memory storage provider. Just for testing.
 *
 * It doesn't make much sense,  since it's just a copy of the in memory cells.
 * But for testing we can create multiple instances that share the memory.
 */
const inMemoryStorage = new Map<string, StorageValue<any>>();
const inMemoryStorageSubscribers = new Set<
  (key: string, value: StorageValue<any>) => void
>();
export class InMemoryStorageProvider extends BaseStorageProvider {
  private handleStorageUpdateFn: (key: string, value: any) => void;
  private lastValues = new Map<string, string | undefined>();

  constructor() {
    super();
    this.handleStorageUpdateFn = this.handleStorageUpdate.bind(this);
    inMemoryStorageSubscribers.add(this.handleStorageUpdateFn);
  }

  private handleStorageUpdate(key: string, value: StorageValue<any>) {
    const valueString = JSON.stringify(value);
    if (this.lastValues.get(key) !== valueString) {
      this.lastValues.set(key, valueString);
      this.notifySubscribers(key, value);
    }
  }

  async send(entityId: EntityId, value: StorageValue<any>): Promise<void> {
    const key = JSON.stringify(entityId);
    const valueString = JSON.stringify(value);
    if (this.lastValues.get(key) !== valueString) {
      console.log("send in memory", key, valueString);
      this.lastValues.set(key, valueString);
      inMemoryStorage.set(key, value);
      inMemoryStorageSubscribers.forEach((listener) => listener(key, value));
    }
  }

  sync(entityId: EntityId): Promise<void> {
    const key = JSON.stringify(entityId);
    if (inMemoryStorage.has(key))
      this.lastValues.set(key, JSON.stringify(inMemoryStorage.get(key)!));
    else this.lastValues.delete(key);
    console.log("sync in memory", key, this.lastValues.get(key));
    return Promise.resolve();
  }

  get(entityId: EntityId): StorageValue<any> | undefined {
    const key = JSON.stringify(entityId);
    console.log("get in memory", key, this.lastValues.get(key));
    return this.lastValues.has(key)
      ? (JSON.parse(this.lastValues.get(key)!) as StorageValue<any>)
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

  async send(entityId: EntityId, value: StorageValue<any>): Promise<void> {
    const key = this.getKey(entityId);
    const storeValue = JSON.stringify(value);
    if (this.lastValues.get(key) !== storeValue) {
      localStorage.setItem(key, storeValue);
      this.lastValues.set(key, storeValue);
      console.log("send localstorage", key, storeValue, this.lastValues);
    }
  }

  async sync(entityId: EntityId): Promise<void> {
    const key = this.getKey(entityId);
    const value = localStorage.getItem(key);
    console.log("sync localstorage", key, value);
    if (value === null) this.lastValues.delete(key);
    else this.lastValues.set(key, value);
  }

  get<T>(entityId: EntityId): StorageValue<T> | undefined {
    const key = this.getKey(entityId);
    const value = this.lastValues.get(key);
    console.log("get localstorage", key, value);
    if (value === null || value === undefined) return undefined;
    else return JSON.parse(value) as StorageValue<T>;
  }

  async destroy(): Promise<void> {
    window.removeEventListener("storage", this.handleStorageEventFn);
    console.log("clear localstorage", this.prefix);
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

  private handleStorageEvent = (event: StorageEvent) => {
    if (event.key && event.key.startsWith(this.prefix)) {
      if (this.lastValues.get(event.key) !== event.newValue) {
        console.log(
          "storage event",
          event.key,
          event.newValue,
          this.lastValues.get(event.key),
          this.lastValues
        );
        if (event.newValue === null) this.lastValues.delete(event.key);
        else this.lastValues.set(event.key, event.newValue);
        const result =
          event.newValue !== null ? JSON.parse(event.newValue) : {};
        this.notifySubscribers(event.key, result);
      }
    }
  };
}
