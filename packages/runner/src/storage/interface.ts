import type { EntityId } from "../doc-map.ts";
import type { Cancel } from "../cancel.ts";
import type {
  AuthorizationError,
  Commit,
  ConflictError,
  ConnectionError,
  Entity,
  JSONValue,
  MemorySpace,
  Reference,
  Result,
  SchemaContext,
  State,
  The,
  TransactionError,
  Unit,
  Variant,
} from "@commontools/memory/interface";

export type { MemorySpace, Result, SchemaContext, Unit };

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
  id: string;
  open(space: MemorySpace): IStorageProvider;
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

/**
 * This is successor to the current `IStorageProvider` which provides a
 * transactional interface.
 */
export interface IStorageProviderV2 {
  /**
   * Creates a new transaction that can be used to build up a change set that
   * can be committed transactionally. It ensures that all reads are consistent
   * and no affecting changes takes place until the transaction is committed. If
   * upstream changes are made since transaction is created that updates any of
   * the read values transaction will fail on commit.
   */
  fork(): IStorageTransaction;
}

/**
 * Representation of a storage transaction, which can be used to query facts and
 * assert / retract while maintaining consistency guarantees. Storage ensures
 * that transactions retain consistent view of the whole storage through it's
 * lifetime by notifying pending transaction of every change that is integrated
 * into the storage, if changes affect any data read through a transaction
 * lifecycle it can not be committed because it would violate consistency. If
 * no change occurs or changes do not affect any data read it would not affect
 * transaction consistency guarantees and therefor committing transaction will
 * be send to the upstream storage provider which will either accept if no
 * invariants have being invalidated in the meantime or rejected and fail commit.
 */
export interface IStorageTransaction {
  /**
   * Transaction can be cancelled which causes storage provider to stop keeping
   * it up to date with incoming changes. Cancelled transactions will produce
   * {@link IStorageTransactionAbortedIStorageTransactionAborted} on commit. Cancelling transaction
   * may produce an error if transaction has already being committed. If reason
   * is omitted `Unit` will be used.
   */
  abort(reason?: Unit): Result<Unit, IStorageTransactionClosed>;

  /**
   * Commit the transaction. If the transaction has been aborted, this will
   * produce `IStorageTransactionAborted`. If transaction has being
   * invalidated while it was in progress, this will produce `IStorageConsistencyError`.
   * If state has changed upstream `ConflictError` will be produced. If signing
   * authority has no necessary permissions `UnauthorizedError` will be produced.
   * If connection with remote can not be reastablished `ConnectionError` is
   * produced. If remote can not perform transaction for any other reason like
   * underlying DB problem `TransactionError` will be produced.
   *
   * Commiting failed transaction will have no effect and same return will be
   * produced. This is not an ideal especially in the case of `ConnectionError`
   * or `TransactionError`, however it is pragmatic choice allowing storage to
   * drop transactions as opposed to keeping them around indefinitely.
   */
  commit(): Promise<Result<Unit, IStorageTransactionError>>;

  /**
   * Describes current status of the transaction. If transaction has failed
   * or was cancelled result will be an error with a corresponding error variant.
   * If transaction is being built it will have `open` status, if commit was
   * called but promise has not resolved yet it will be `pending`. If commit
   * successfully completed it will be `done`.
   *
   * Please note that if storage was updated since transaction was created such
   * that any of the invariants have changed status will be change to
   * `IStorageConsistencyError` even though transaction has not being commited.
   * This allows transactor to cancel and recreate transaction with a current
   * state without having to build up a whole transaction and commiting it.
   */
  status(): Result<
    IStorageTransactionProgress,
    IStorageTransactionError
  >;

  /**
   * Reads a value from the the storage and captures it in the transaction
   * invariants. Read will fail with `IStorageTransactionError` if transaction
   * has an error state. Read will fail with `IStorageTransactionClosed` if
   * transaction is done.
   */
  read(
    address: IStorageAddress,
  ): Result<
    Read,
    IStorageTransactionError | IStorageTransactionClosed
  >;

  /**
   * Write a value into a storage at a given address & captures it in the
   * transaction invariants. Write will fail with `IStorageTransactionError`
   * if transaction has an error state. Write will fail with
   * `IStorageTransactionClosed` if transaction is done.
   */
  write(
    address: IStorageAddress,
    value?: JSONValue,
  ): Result<Write, IStorageTransactionError | IStorageTransactionClosed>;
}

/**
 * This is transaction representation from the storage perpective. It will not
 * be exposed outside of the storage provider intenals and is designed to allow
 * storage provider to maintain consistency guarantees.
 */
export interface IStorageOpenTransaction {
  /**
   * This is an internal method called by a storage provider that lets
   * transaction know about potential invariant changes. Transaction can track
   * of all the changes internally and if any of the changes affect any of it's
   * invariants it can transition transaction state from `Open` to failed with
   * `IStorageConsistencyError`.
   */
  merge(changes: Iterable<State>): void;
}

/**
 * Error that is produced when transaction is being updated after it was already
 * aborted.
 */
export interface IStorageTransactionAborted extends Error {
  /**
   * Reason provided when transaction was aborted.
   */
  reason: unknown;
}

/**
 * Error indicates that transaction consistency guarantees have being
 * invalidated - some fact has changed while transaction was in progress.
 */
export interface IStorageConsistencyError extends Error {}

export type IStorageTransactionError =
  | IStorageTransactionAborted
  | ConflictError
  | TransactionError
  | ConnectionError
  | AuthorizationError;

export interface IStorageTransactionClosed extends Error {}

export type IStorageTransactionProgress = Variant<{
  open: IStorageTransactionLog;
  pending: IStorageTransactionLog;
  done: IStorageTransactionLog;
}>;

export interface IStorageAddress {
  the: The;
  of: Entity;
  at: string[];
}

export interface IStorageTransactionLog
  extends Iterable<IStorageTransactionInvariant> {
  get(address: IStorageAddress): IStorageTransactionInvariant;
}

export type IStorageTransactionInvariant = Variant<{
  read: Read;
  write: Write;
}>;

export interface Read {
  readonly the: The;
  readonly of: Entity;
  readonly at: string[];
  readonly is?: JSONValue;
  readonly cause: Reference;
}

export interface Write {
  readonly the: The;
  readonly of: Entity;
  readonly at: string[];
  readonly is?: JSONValue;
  readonly cause: Reference;
}
