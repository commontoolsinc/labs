import type { EntityId } from "../doc-map.ts";
import type { Cancel } from "../cancel.ts";
import type {
  AuthorizationError,
  Commit,
  ConflictError,
  ConnectionError,
  Entity as URI,
  JSONValue,
  MemorySpace,
  Reference,
  Result,
  SchemaContext,
  State,
  The as MediaType,
  TransactionError,
  Unit,
  Variant,
} from "@commontools/memory/interface";

export type { JSONValue, MemorySpace, Result, SchemaContext, Unit };

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

export interface IStorageManagerV2 {
  /**
   * Creates a storage transaction that can be used to read / write data into
   * locally replicated memory spaces. Transaction allows reading from many
   * multiple spaces but writing only to one space.
   */
  edit(): IStorageTransaction;
}

/**
 * Representation of a storage transaction, which can be used to query facts and
 * assert / retract while maintaining consistency guarantees. Storage ensures
 * that transactions retain consistent view of the whole storage through it's
 * lifetime by notifying pending transaction of every change that is integrated
 * into the storage, if changes affect any data read through a transaction
 * lifecycle it can not be committed because it would violate consistency. If
 * no change occurs or changes do not affect any data reading it would not
 * affect transaction consistency guarantees and therefor committing transaction
 * will send it to an upstream storage provider which will either accept, if no
 * invariants have being invalidated, or reject and fail commit.
 */
export interface IStorageTransaction {
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
   * Creates a memory space reader for inside this transaction. Fails if
   * transaction is no longer in progress. Requesting a reader for the same
   * memory space will return same reader instance.
   */
  reader(space: MemorySpace): Result<ITransactionReader, IReaderError>;

  /**
   * Helper that is the same as `reader().read()` but more convenient, as it
   * combines error capturing in one call.
   *
   * Reads a value from a (local) memory address and captures corresponding
   * `Read` in the transaction invariants. If value was written in read memory
   * address in this transaction read will return value that was written as
   * opposed to value stored.
   *
   * @param address - Memory address to read from.
   * @returns Result containing the read value or an error.
   */
  read(address: IMemoryAddress): Result<Read, IReaderError>;

  /**
   * Reads a value from a (local) memory address and throws on error, except for
   * `NotFoundError` which is returned as undefined.
   *
   * @param address - Memory address to read from.
   * @returns The read value.
   */
  readValueOrThrow(address: IMemoryAddress): JSONValue | undefined;

  /**
   * Creates a memory space writer for this transaction. Fails if transaction is
   * no longer in progress or if writer for the different space was already open
   * on this transaction. Requesting a writer for the same memory space will
   * return same writer instance.
   */
  writer(space: MemorySpace): Result<ITransactionWriter, IWriterError>;

  /**
   * Helper that is the same as `writer().write()` but more convenient, as it
   * combines error capturing in one call.
   *
   * Writes a value into a storage at a given address & captures it in the
   * transaction invariants.
   *
   * @param address - Memory address to write to.
   * @param value - Value to write.
   * @returns Result containing the written value or an error.
   */
  write(address: IMemoryAddress, value: JSONValue): Result<Write, IWriterError>;

  /**
   * Transaction can be cancelled which causes storage provider to stop keeping
   * it up to date with incoming changes. Aborting inactive transactions will
   * produce {@link InactiveTransactionError}. Aborted transactions will produce
   * {@link IStorageTransactionAborted} error on attempt to commit.
   */
  abort(reason?: Unit): Result<Unit, InactiveTransactionError>;

  /**
   * Commits transaction. If transaction is no longer active, this will
   * produce {@link IStorageTransactionAborted}. If transaction consistency
   * gurantees have being violated by upstream changes
   * {@link IStorageTransactionInconsistent} is returned.
   *
   * If transaction is still active and no consistency guarantees have being
   * invalidated it will be send upstream and status will be updated to
   * `pending`. Transaction may still fail with {@link IStorageTransactionFailed}
   * if state upstream affects values read from updated space have changed,
   * which can happen if another client concurrently updates them. Transaction
   * MAY also fail due to insufficient authorization level or due to various IO
   * problems.
   *
   * Commit is idempotent, meaning calling it over and over will return same
   * exact value as on first call and no execution will take place on subsequent
   * calls.
   */
  commit(): Promise<Result<Unit, IStorageTransactionError>>;
}

export interface ITransactionReader {
  /**
   * Reads a value from a (local) memory address and captures corresponding
   * `Read` in the transaction invariants. If value was written in read memory
   * address in this transaction read will return value that was written as
   * opposed to value stored.
   *
   * Read will fail with `InactiveTransactionError` if transaction is no longer
   * active.
   *
   * Read will fail with `INotFoundError` when reading inside a memory address
   * that does not exist in local replica. The `Read` invariant is still
   * captured however to ensure that assumption about non existence is upheld.
   *
   * ```ts
   *  const w = tx.write({ type, id, path: [] }, {
   *    title: "Hello world",
   *    content: [
   *       { text: "Beautiful day", format: "bold" }
   *    ]
   *  })
   *  assert(w.ok)
   *
   *  assert(tx.read({ type, id, path: ['author'] }).ok === undefined)
   *  assert(tx.read({ type, id, path: ['author', 'address'] }).error.name === 'NotFoundError')
   *  // JS specific getters are not supported
   *  assert(tx.read({ type, id, path: ['content', 'length'] }).ok.is === undefined)
   *  assert(tx.read({ type, id, path: ['title'] }).ok.is === "Hello world")
   *  // Referencing non-existing facts produces errors
   *  assert(tx.read({ type: 'bad/mime' , id, path: ['author'] }).error.name === 'NotFoundError')
   * ```
   */
  read(
    address: IMemoryAddress,
  ): Result<
    Read,
    | INotFoundError
    | InactiveTransactionError
    | IUnsupportedMediaTypeError
    | IInvalidDataURIError
  >;
}

export interface ITransactionWriter extends ITransactionReader {
  /**
   * Write a value into a storage at a given address & captures it in the
   * transaction invariants. Write will fail with `IStorageTransactionError`
   * if transaction has an error state. Write will fail with
   * `IStorageTransactionClosed` if transaction is done.
   */
  write(
    address: IMemoryAddress,
    value?: JSONValue,
  ): Result<
    Write,
    | INotFoundError
    | InactiveTransactionError
    | IUnsupportedMediaTypeError
    | IInvalidDataURIError
  >;
}

/**
 * This is transaction representation from the storage perpective. It will not
 * be exposed outside of the storage provider intenals and is designed to allow
 * storage provider to maintain consistency guarantees.
 */
export interface IStorageTransactionConsistencyMaintenance {
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
  name: "StorageTransactionAborted";
  /**
   * Reason provided when transaction was aborted.
   */
  reason: unknown;
}

/**
 * Error indicates that transaction consistency guarantees have being
 * invalidated - some fact has changed while transaction was in progress.
 */
export interface IStorageTransactionInconsistent extends Error {
  name: "StorageTransactionInconsistent";
}

/**
 * Error that indicating that no change could be made to a transaction is it is
 * no longer active.
 */
export type InactiveTransactionError =
  | IStorageTransactionInconsistent
  | IStorageTransactionAborted
  | IStorageTransactionFailed
  | IStorageTransactionComplete;

export type IStorageTransactionError =
  | IStorageTransactionAborted
  | IStorageTransactionInconsistent
  | IStorageTransactionFailed;

export type IStorageTransactionFailed =
  | ConflictError
  | TransactionError
  | ConnectionError
  | AuthorizationError;

export interface INotFoundError extends Error {
  name: "NotFoundError";
  path?: MemoryAddressPathComponent[];
}

/**
 * Error returned when the media type is not supported by the storage transaction.
 */
export interface IUnsupportedMediaTypeError extends Error {
  name: "UnsupportedMediaTypeError";
}

/**
 * Error returned when a data URI is invalid or cannot be parsed.
 */
export interface IInvalidDataURIError extends Error {
  name: "InvalidDataURIError";
  cause: Error;
}

export type IReaderError =
  | IStorageTransactionComplete
  | IStorageTransactionAborted
  | INotFoundError
  | IUnsupportedMediaTypeError
  | IInvalidDataURIError;

export type IWriterError =
  | IStorageTransactionComplete
  | IStorageTransactionAborted
  | IStorageTransactionInconsistent
  | IStorageTransactionWriteIsolationError
  | INotFoundError
  | IUnsupportedMediaTypeError
  | IInvalidDataURIError;

export interface IStorageTransactionComplete extends Error {
  name: "StorageTransactionCompleteError";
}

export type IStorageTransactionProgress = Variant<{
  open: IStorageTransactionLog;
  pending: IStorageTransactionLog;
  done: IStorageTransactionLog;
}>;

/**
 * Represents adddress within the memory space which is like pointer inside the
 * fact value in the memory.
 */
export interface IMemoryAddress {
  /**
   * Memory space to read from.
   */
  space: MemorySpace;
  /**
   * URI to an entitiy. It corresponds to `of` field in the memory protocol.
   */
  id: URI;
  /**
   * Media type under which data is stored. It corresponds to `the` field in the
   * memory protocol.
   */
  type: MediaType;
  /**
   * Path to the {@link JSONValue} being reference by this address. It is path
   * within the `is` field of the fact in memory protocol.
   */
  path: MemoryAddressPathComponent[];
}

export type MemoryAddressPathComponent = string | number;

export interface IStorageTransactionLog
  extends Iterable<IStorageTransactionInvariant> {
  get(address: IMemoryAddress): IStorageTransactionInvariant;
}

export type IStorageTransactionInvariant = Variant<{
  read: Read;
  write: Write;
}>;

/**
 * Error is returned on an attempt to open writer in a transaction that already
 * has a writer for a different space.
 */
export interface IStorageTransactionWriteIsolationError extends Error {
  name: "StorageTransactionWriteIsolationError";

  /**
   * Memory space writer that is already open.
   */
  open: MemorySpace;

  /**
   * Memory space writer could not be opened for.
   */
  requested: MemorySpace;
}

/**
 * Describes read invariant of the underlaying  transaction.
 */
export interface Read {
  readonly address: IMemoryAddress;
  readonly value?: JSONValue;
  readonly cause: Reference;
}

/**
 * Describes write invariant of the underlaying transaction.
 */
export interface Write {
  readonly address: IMemoryAddress;
  readonly value?: JSONValue;
  readonly cause: Reference;
}
