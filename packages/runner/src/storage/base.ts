import { SchemaContext } from "../builder/types.ts";
import type { Entity, Result, Unit } from "@commontools/memory/interface";
import type { Cancel } from "../cancel.ts";
import type { EntityId } from "../doc-map.ts";
import { log } from "../log.ts";
import { IStorageProvider, StorageValue } from "./interface.ts";
export type { Result, Unit };

export abstract class BaseStorageProvider implements IStorageProvider {
  protected subscribers = new Map<string, Set<(value: StorageValue) => void>>();
  protected waitingForSync = new Map<string, Promise<void>>();
  protected waitingForSyncResolvers = new Map<string, () => void>();

  abstract send<T = any>(
    batch: { entityId: EntityId; value: StorageValue<T> }[],
  ): Promise<
    { ok: object; error?: undefined } | { ok?: undefined; error: Error }
  >;

  abstract sync(
    entityId: EntityId,
    expectedInStorage: boolean,
    schemaContext?: SchemaContext,
  ): Promise<Result<Unit, Error>>;

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

  static toEntity(source: EntityId): Entity {
    if (typeof source["/"] === "string") {
      return `of:${source["/"]}`;
    } else if (source.toJSON) {
      return `of:${source.toJSON()["/"]}`;
    } else {
      throw Object.assign(
        new TypeError(
          `💣 Got entity ID that is neither merkle reference nor {'/'}`,
        ),
        {
          cause: source,
        },
      );
    }
  }
}
