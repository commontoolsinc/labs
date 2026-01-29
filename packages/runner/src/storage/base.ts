import type {
  Result,
  SchemaPathSelector,
  StorableValue,
  Unit,
  URI,
} from "@commontools/memory/interface";
import type { Cancel } from "../cancel.ts";
import {
  IStorageProvider,
  OptStorageValue,
  StorageValue,
} from "./interface.ts";
export type { Result, Unit };

export abstract class BaseStorageProvider implements IStorageProvider {
  // Uses `any` because callbacks may expect different specific types,
  // but all receive StorableValue at runtime.
  protected subscribers = new Map<
    string,
    Set<(value: StorageValue<any>) => void>
  >();
  protected waitingForSync = new Map<string, Promise<void>>();
  protected waitingForSyncResolvers = new Map<string, () => void>();

  abstract send<T extends StorableValue = StorableValue>(
    batch: { uri: URI; value: StorageValue<T> }[],
  ): Promise<
    { ok: object; error?: undefined } | { ok?: undefined; error: Error }
  >;

  abstract sync(
    uri: URI,
    selector?: SchemaPathSelector,
  ): Promise<Result<Unit, Error>>;
  // TODO(@ubik2)
  //): Promise<Result<Selection<FactAddress, Revision<State>>, Error>>;

  abstract synced(): Promise<void>;

  abstract get<T extends StorableValue = StorableValue>(
    uri: URI,
  ): OptStorageValue<T>;

  sink<T extends StorableValue = StorableValue>(
    uri: URI,
    callback: (value: StorageValue<T>) => void,
  ): Cancel {
    if (!this.subscribers.has(uri)) {
      this.subscribers.set(
        uri,
        new Set<(value: StorageValue<any>) => void>(),
      );
    }
    const listeners = this.subscribers.get(uri)!;
    listeners.add(callback);

    return () => {
      listeners.delete(callback);
      if (listeners.size === 0) this.subscribers.delete(uri);
    };
  }

  protected notifySubscribers(key: string, value: StorageValue): void {
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
