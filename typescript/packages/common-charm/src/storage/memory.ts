import type { EntityId } from "@commontools/runner";
import { log } from "../storage.js";
import { BaseStorageProvider, type StorageValue } from "./base.js";

/**
 * In-memory storage provider. Just for testing.
 *
 * It doesn't make much sense,  since it's just a copy of the in memory cells.
 * But for testing we can create multiple instances that share the memory.
 */
const inMemoryStorage = new Map<string, StorageValue>();
const inMemoryStorageSubscribers = new Set<(key: string, value: StorageValue) => void>();
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

  async send<T = any>(batch: { entityId: EntityId; value: StorageValue<T> }[]) {
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

    return { ok: {} };
  }

  async sync(entityId: EntityId, expectedInStorage: boolean = false): Promise<void> {
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

  getReplica(): string | undefined {
    return undefined;
  }
}
