import { log } from "../storage.js";
import type { EntityId } from "@commontools/runner";
import { BaseStorageProvider, type StorageValue } from "./base.js";

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

  async send<T = any>(batch: { entityId: EntityId; value: StorageValue<T> }[]) {
    // Track metrics
    this.metrics.sendCount++;
    const startTime = performance.now();
    
    try {
      for (const { entityId, value } of batch) {
        const key = this.getKey(entityId);
        const storeValue = JSON.stringify(value);
        if (this.lastValues.get(key) !== storeValue) {
          if ((localStorage.getItem(key) ?? undefined) !== this.lastValues.get(key)) {
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

      // Update metrics
      this.updateTimedMetric('avgSendTime', performance.now() - startTime);
      return { ok: {} };
    } catch (error) {
      // Track error in metrics
      this.metrics.lastError = error instanceof Error ? error.message : String(error);
      return { error: error instanceof Error ? error : new Error(String(error)) };
    }
  }

  async sync(entityId: EntityId, expectedInStorage: boolean = false): Promise<void> {
    // Track metrics
    this.metrics.syncCount++;
    const startTime = performance.now();
    
    try {
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
          setTimeout(() => this.resolveWaitingForSync(this.entityIdStrFromKey(key)), 1000);
          return this.waitForSync(this.entityIdStrFromKey(key));
        } else this.lastValues.delete(key);
      else this.lastValues.set(key, value);
      
      // Update metrics
      this.updateTimedMetric('avgSyncTime', performance.now() - startTime);
    } catch (error) {
      // Track error in metrics
      this.metrics.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  get<T>(entityId: EntityId): StorageValue<T> | undefined {
    // Track metrics
    this.metrics.getCount++;
    
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
    if (event.key && event.key.startsWith("cell:")) {
      const key = event.key;
      const value = event.newValue;
      log("storage event", key, value);
      if (value === null) {
        this.lastValues.delete(key);
      } else {
        this.lastValues.set(key, value);
        this.notifySubscribers(this.entityIdStrFromKey(key), JSON.parse(value));
      }
    }
  };

  getReplica(): string | undefined {
    return undefined;
  }
}
