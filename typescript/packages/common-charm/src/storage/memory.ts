import type { EntityId } from "@commontools/runner";
import { log } from "../storage.ts";
import { BaseStorageProvider, type StorageValue } from "./base.ts";

/**
 * In-memory storage provider. Just for testing.
 *
 * It doesn't make much sense,  since it's just a copy of the in memory cells.
 * But for testing we can create multiple instances that share the memory.
 */
const spaceStorageMap = new Map<string, Map<string, StorageValue>>();
const spaceSubscribersMap = new Map<string, Set<(key: string, value: StorageValue) => void>>();

// Helper to get or create storage for a space
function getOrCreateSpaceStorage(spaceName: string): Map<string, StorageValue> {
  if (!spaceStorageMap.has(spaceName)) {
    spaceStorageMap.set(spaceName, new Map<string, StorageValue>());
  }
  return spaceStorageMap.get(spaceName)!;
}

// Helper to get or create subscribers for a space
function getOrCreateSpaceSubscribers(
  spaceName: string,
): Set<(key: string, value: StorageValue) => void> {
  if (!spaceSubscribersMap.has(spaceName)) {
    spaceSubscribersMap.set(spaceName, new Set());
  }
  return spaceSubscribersMap.get(spaceName)!;
}

export class InMemoryStorageProvider extends BaseStorageProvider {
  private handleStorageUpdateFn: (key: string, value: any) => void;
  private lastValues = new Map<string, string | undefined>();
  private spaceName: string;

  constructor(spaceName: string = "default") {
    super();
    this.spaceName = spaceName;
    this.handleStorageUpdateFn = this.handleStorageUpdate.bind(this);
    getOrCreateSpaceSubscribers(this.spaceName).add(this.handleStorageUpdateFn);
  }

  private handleStorageUpdate(key: string, value: StorageValue) {
    const valueString = JSON.stringify(value);
    if (this.lastValues.get(key) !== valueString) {
      this.lastValues.set(key, valueString);
      this.notifySubscribers(key, value);
    }
  }

  async send<T = any>(batch: { entityId: EntityId; value: StorageValue<T> }[]) {
    const spaceStorage = getOrCreateSpaceStorage(this.spaceName);
    const spaceSubscribers = getOrCreateSpaceSubscribers(this.spaceName);

    for (const { entityId, value } of batch) {
      const key = JSON.stringify(entityId);
      const valueString = JSON.stringify(value);
      if (this.lastValues.get(key) !== valueString) {
        log(() => ["send in memory", this.spaceName, key, valueString]);
        this.lastValues.set(key, valueString);
        spaceStorage.set(key, value);
        spaceSubscribers.forEach((listener) => listener(key, value));
      }
    }

    return { ok: {} };
  }

  async sync(entityId: EntityId, expectedInStorage: boolean = false): Promise<void> {
    const spaceStorage = getOrCreateSpaceStorage(this.spaceName);
    const key = JSON.stringify(entityId);
    log(() => ["sync in memory", this.spaceName, key, this.lastValues.get(key)]);
    if (spaceStorage.has(key)) this.lastValues.set(key, JSON.stringify(spaceStorage.get(key)!));
    else if (expectedInStorage)
      return Promise.resolve(); // nothing to sync
    else this.lastValues.delete(key);
  }

  get<T>(entityId: EntityId): StorageValue<T> | undefined {
    const key = JSON.stringify(entityId);
    log(() => ["get in memory", this.spaceName, key, this.lastValues.get(key)]);
    return this.lastValues.has(key)
      ? (JSON.parse(this.lastValues.get(key)!) as StorageValue)
      : undefined;
  }

  async destroy(): Promise<void> {
    const spaceSubscribers = getOrCreateSpaceSubscribers(this.spaceName);
    const spaceStorage = getOrCreateSpaceStorage(this.spaceName);

    spaceSubscribers.delete(this.handleStorageUpdateFn);

    // Only clear this space's storage
    spaceStorage.clear();
    this.subscribers.clear();
  }

  getReplica(): string | undefined {
    return undefined;
  }
}
