import type { EntityId } from "../doc-map.ts";
import type { Cancel } from "../cancel.ts";
import type {
  Result,
  SchemaContext,
  Unit,
} from "@commontools/memory/interface";

export type { Result, SchemaContext, Unit };

// This type is used to tag a document with any important metadata.
// Currently, the only supported type is the classification.
export type Labels = {
  classification?: string[];
};

export interface StorageValue<T = any> {
  value: T;
  source?: EntityId;
  // This is used on writes to retry on conflicts.
  retry?: ((previousValue: T) => T)[];
  labels?: Labels;
}

export interface IStorageManager {
  open(space: string): IStorageProvider;
}

export interface IStorageProvider {
  /**
   * Send a value to storage.
   *
   * @param batch - Batch of entity IDs & values to send.
   * @returns Promise that resolves when the value is sent.
   */
  send<T = any>(
    batch: { entityId: EntityId; value: StorageValue<T> }[],
  ): Promise<Result<Unit, Error>>;

  /**
   * Sync a value from storage. Use `get()` to retrieve the value.
   *
   * @param entityId - Entity ID to sync.
   * @param expectedInStorage - Wait for the value, it's assumed to be in
   *   storage eventually.
   * @param schemaContext - The schemaContext that determines what to sync.
   * @returns Promise that resolves when the value is synced.
   */
  sync(
    entityId: EntityId,
    expectedInStorage?: boolean,
    schemaContext?: SchemaContext,
  ): Promise<Result<Unit, Error>>;

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
