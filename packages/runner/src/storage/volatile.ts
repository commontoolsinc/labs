import type { EntityId } from "../doc-map.ts";
import { log } from "../log.ts";
import { BaseStorageProvider } from "./base.ts";
import type { Result, StorageValue, Unit } from "./interface.ts";
import { SchemaContext } from "@commontools/memory/interface";

/**
 * Volatile (in-memory) storage provider. Just for testing.
 *
 * It doesn't make much sense, since it's just a copy of the volatile docs.
 * But for testing we can create multiple instances that share the memory.
 */
const spaceStorageMap = new Map<string, Map<string, StorageValue>>();
const spaceSubscribersMap = new Map<
  string,
  Set<(key: string, value: StorageValue) => void>
>();

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

export class VolatileStorageProvider extends BaseStorageProvider {
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

  send<T = any>(
    batch: { entityId: EntityId; value: StorageValue<T> }[],
    doNotNotify: boolean = false, // for testing
  ): Promise<Result<Unit, Error>> {
    const spaceStorage = getOrCreateSpaceStorage(this.spaceName);
    const spaceSubscribers = getOrCreateSpaceSubscribers(this.spaceName);

    for (const { entityId } of batch) {
      const key = JSON.stringify(entityId);
      const value = spaceStorage.get(key);
      const valueString = JSON.stringify(value);
      // Should only happen because of doNotNotify, this is used to simulate a conflict
      if (value && this.lastValues.get(key) !== valueString) {
        log(() => ["conflict", key, this.lastValues.get(key), valueString]);

        // Simulate storage catching up
        this.lastValues.set(key, valueString);
        this.notifySubscribers(key, value);

        return Promise.resolve({
          // Bare bones ConflictError from RemoteStorageProvider
          // Just what the current storage provider needs to resolve conflicts
          error: {
            name: "ConflictError",
            conflict: {
              of: BaseStorageProvider.toEntity(entityId),
              actual: { is: value },
            },
          } as unknown as Error,
        });
      }
    }

    for (const { entityId, value } of batch) {
      const key = JSON.stringify(entityId);
      const valueString = JSON.stringify(value);
      if (this.lastValues.get(key) !== valueString) {
        log(() => ["send volatile", this.spaceName, key, valueString]);
        this.lastValues.set(key, valueString);
        spaceStorage.set(key, value);
        if (!doNotNotify) {
          // For testing, this creates a conflict above
          spaceSubscribers.forEach((listener) => listener(key, value));
        }
      }
    }

    return Promise.resolve({ ok: {} });
  }

  sync(
    entityId: EntityId,
    expectedInStorage: boolean = false,
    _schemaContext?: SchemaContext,
  ): Promise<Result<Unit, Error>> {
    const spaceStorage = getOrCreateSpaceStorage(this.spaceName);
    const key = JSON.stringify(entityId);
    log(
      () => ["sync volatile", this.spaceName, key, this.lastValues.get(key)],
    );
    if (spaceStorage.has(key)) {
      this.lastValues.set(key, JSON.stringify(spaceStorage.get(key)!));
    } else if (!expectedInStorage) {
      this.lastValues.delete(key);
    }
    return Promise.resolve({ ok: {} });
  }

  get<T>(entityId: EntityId): StorageValue<T> | undefined {
    const key = JSON.stringify(entityId);
    log(() => ["get volatile", this.spaceName, key, this.lastValues.get(key)]);
    return this.lastValues.has(key)
      ? (JSON.parse(this.lastValues.get(key)!) as StorageValue)
      : undefined;
  }

  destroy(): Promise<void> {
    const spaceSubscribers = getOrCreateSpaceSubscribers(this.spaceName);
    const spaceStorage = getOrCreateSpaceStorage(this.spaceName);

    spaceSubscribers.delete(this.handleStorageUpdateFn);

    // Only clear this space's storage
    spaceStorage.clear();
    this.subscribers.clear();

    return Promise.resolve();
  }

  getReplica(): string | undefined {
    return undefined;
  }
}
