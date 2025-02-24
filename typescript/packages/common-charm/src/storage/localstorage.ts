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

    return { ok: {} };
  }

  async sync(entityId: EntityId, expectedInStorage: boolean = false): Promise<void> {
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

  getReplica(): string | undefined {
    return undefined;
  }
}
