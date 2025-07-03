import type { EntityId } from "../doc-map.ts";
import type { Cancel } from "../cancel.ts";
import type {
  Assertion,
  AuthorizationError as IAuthorizationError,
  Changes,
  Commit,
  ConflictError as IConflictError,
  ConnectionError as IConnectionError,
  Entity as URI,
  Fact,
  FactAddress,
  Invariant as IClaim,
  JSONValue,
  MemorySpace,
  QueryError as IQueryError,
  Reference,
  Result,
  Retraction,
  SchemaContext,
  Signer,
  State,
  The as MediaType,
  TransactionError,
  Unit,
  Variant,
} from "@commontools/memory/interface";

export type {
  Assertion,
  Fact,
  IAuthorizationError,
  IClaim,
  IConflictError,
  IConnectionError,
  IQueryError,
  JSONValue,
  MediaType,
  MemorySpace,
  Result,
  Retraction,
  SchemaContext,
  State,
  Unit,
  URI,
  Variant,
};

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
  open(space: MemorySpace): IStorageProviderWithReplica;
}

export interface IRemoteStorageProviderSettings {
  /**
   * Number of subscriptions remote storage provider is allowed to have per
   * space.
   */
  maxSubscriptionsPerSpace: number;

  /**
   * Amount of milliseconds we will spend waiting on WS connection before we
   * abort.
   */
  connectionTimeout: number;

  /**
   * Flag to enable or disable remote schema subscriptions
   */
  useSchemaQueries: boolean;
}

export interface LocalStorageOptions {
  as: Signer;
  id?: string;
  settings?: IRemoteStorageProviderSettings;
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

export interface IStorageProviderWithReplica extends IStorageProvider {
  replica: ISpaceReplica;
}

export interface IStorageManagerV2 {
  /**
   * Creates a storage transaction that can be used to read / write data into
   * locally replicated memory spaces. Transaction allows reading from many
   * multiple spaces but writing only to one space.
   */
  edit(): IStorageTransaction;
}

export type StorageTransactionStatus = Result<
  IStorageTransactionProgress,
  StorageTransactionFailed
>;

export type IStorageTransactionProgress =
  | { status: "ready"; journal: ITransactionJournal }
  | { status: "pending"; journal: ITransactionJournal }
  | { status: "done"; journal: ITransactionJournal };

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
  status(): StorageTransactionStatus;

  read(adddress: IMemorySpaceAddress): Result<IAttestation, ReadError>;
  write(
    address: IMemorySpaceAddress,
    value?: JSONValue,
  ): Result<IAttestation, WriterError | WriteError>;

  /**
   * Creates a memory space reader for inside this transaction. Fails if
   * transaction is no longer in progress. Requesting a reader for the same
   * memory space will return same reader instance.
   */
  reader(
    space: MemorySpace,
  ): Result<ITransactionReader, ReadError>;

  /**
   * Creates a memory space writer for this transaction. Fails if transaction is
   * no longer in progress or if writer for the different space was already open
   * on this transaction. Requesting a writer for the same memory space will
   * return same writer instance.
   */
  writer(
    space: MemorySpace,
  ): Result<ITransactionWriter, WriterError>;

  /**
   * Transaction can be cancelled which causes storage provider to stop keeping
   * it up to date with incoming changes. Aborting inactive transactions will
   * produce {@link InactiveTransactionError}. Aborted transactions will produce
   * {@link IStorageTransactionAborted} error on attempt to commit.
   */
  abort(reason?: unknown): Result<Unit, InactiveTransactionError>;

  /**
   * Commits transaction. If transaction is no longer active, this will
   * produce {@link IStorageTransactionAborted}. If transaction consistency
   * gurantees have being violated by upstream changes
   * {@link IStorageTransactionInconsistent} is returned.
   *
   * If transaction is still active and no consistency guarantees have being
   * invalidated it will be send upstream and status will be updated to
   * `pending`. Transaction may still fail with {@link IStorageTransactionRejected}
   * if state upstream affects values read from updated space have changed,
   * which can happen if another client concurrently updates them. Transaction
   * MAY also fail due to insufficient authorization level or due to various IO
   * problems.
   *
   * Commit is idempotent, meaning calling it over and over will return same
   * exact value as on first call and no execution will take place on subsequent
   * calls.
   */
  commit(): Promise<Result<Unit, CommitError>>;
}

export interface ITransactionReader {
  did(): MemorySpace;
  /**
   * Reads a value from a (local) memory address and captures corresponding
   * `Read` in the the transaction invariants. If value was written in read
   * memory address in this transaction read will return value that was written
   * as opposed to value stored.
   *
   * Read will fail with `InactiveTransactionError` if transaction is no longer
   * active.
   *
   * Read will fail with `INotFoundError` when reading inside a memory address
   * that does not exist in local replica. The `Read` invariant is still
   * captured however to ensure that assumption about non existence is upheld.
   *
   * ```ts
   *  const w = tx.write({ the, of, at: [] }, {
   *    title: "Hello world",
   *    content: [
   *       { text: "Beautiful day", format: "bold" }
   *    ]
   *  })
   *  assert(w.ok)
   *
   *  assert(tx.read({ the, of, at: ['author'] }).ok === undefined)
   *  assert(tx.read({ the, of, at: ['author', 'address'] }).error.name === 'NotFoundError')
   *  // JS specific getters are not supported
   *  assert(tx.read({ the, of, at: ['content', 'length'] }).ok.is === undefined)
   *  assert(tx.read({ the, of, at: ['title'] }).ok.is === "Hello world")
   *  // Referencing non-existing facts produces errors
   *  assert(tx.read({ the: 'bad/mime' , of, at: ['author'] }).error.name === 'NotFoundError')
   * ```
   */
  read(
    address: IMemoryAddress,
  ): Result<
    IAttestation,
    ReadError
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
  ): Result<IAttestation, WriteError>;
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

  address: IMemoryAddress;

  from(space: MemorySpace): IStorageTransactionInconsistent;
}

/**
 * Error that indicating that no change could be made to a transaction is it is
 * no longer active.
 */
export type InactiveTransactionError =
  | StorageTransactionFailed
  | IStorageTransactionComplete;

export type StorageTransactionFailed =
  | IStorageTransactionInconsistent
  | IStorageTransactionAborted
  | IStorageTransactionRejected;

export type IStorageTransactionRejected =
  | IConflictError
  | IStoreError
  | TransactionError
  | IConnectionError
  | IAuthorizationError;

export type CommitError =
  | InactiveTransactionError
  | IStorageTransactionRejected;

export type ReadError =
  | INotFoundError
  | InactiveTransactionError;

export type WriteError =
  | INotFoundError
  | InactiveTransactionError;

export type ReaderError = InactiveTransactionError;

export type WriterError =
  | InactiveTransactionError
  | IStorageTransactionWriteIsolationError;

export interface IStorageTransactionComplete extends Error {
  name: "StorageTransactionCompleteError";
}
export interface INotFoundError extends Error {
  name: "NotFoundError";

  /**
   * Source in which address could not be resolved.
   */
  source: IAttestation;

  /**
   * Address that we could not resolve.
   */
  address: IMemoryAddress;
}

/**
 * Represents adddress within the memory space which is like pointer inside the
 * fact value in the memory.
 */
export interface IMemoryAddress {
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
  path: readonly MemoryAddressPathComponent[];
}

export interface IMemorySpaceAddress extends IMemoryAddress {
  space: MemorySpace;
}

export type MemoryAddressPathComponent = string | number;

export interface Assert {
  the: MediaType;
  of: URI;
  is: JSONValue;

  claim?: void;
}

export interface Retract {
  the: MediaType;
  of: URI;
  is?: void;

  claim?: void;
}

export interface Claim {
  the: MediaType;
  of: URI;
  is?: void;
  claim: true;
}

export interface ISpace {
  did(): MemorySpace;
}

export interface ISpaceReplica extends ISpace {
  /**
   * Return a state for the requested entry or returns `undefined` if replica
   * does not have it.
   */
  get(entry: FactAddress): State | undefined;

  commit(
    transaction: ITransaction,
  ): Promise<Result<Unit, IStorageTransactionRejected>>;
}

export type PushError =
  | IQueryError
  | IStoreError
  | IConnectionError
  | IConflictError
  | TransactionError
  | IAuthorizationError;

export interface IStoreError extends Error {
  name: "StoreError";
  cause: Error;
}

/**
 * Archive of the journal keyed by memory space. Each read attestation
 * are represented as `claims` and write attestation are represented as
 * `facts`.
 */
export type JournalArchive = Map<MemorySpace, ITransaction>;

export interface ITransactionJournal {
  activity(): Iterable<Activity>;

  novelty(space: MemorySpace): Iterable<IAttestation>;
  history(space: MemorySpace): Iterable<IAttestation>;

  reader(
    space: MemorySpace,
  ): Result<ITransactionReader, InactiveTransactionError>;

  writer(
    space: MemorySpace,
  ): Result<ITransactionWriter, InactiveTransactionError>;

  /**
   * Closes underlying transaction, making it non-editable going forward. Any
   * attempts to edit it will fail.
   */
  close(): Result<Map<MemorySpace, ITransaction>, InactiveTransactionError>;

  /**
   * Aborts underlying transaction, making it non-editable going forward. Any
   * attempts to edit it will fail.
   */
  abort(reason?: unknown): Result<Unit, InactiveTransactionError>;
}

export interface EditableJournal {
  activity(): Iterable<Activity>;
  novelty: Iterable<IAttestation>;
  history(): Iterable<IAttestation>;
}

export interface ITransaction {
  claims: IClaim[];

  facts: State[];
}

export interface IStorageEdit {
  for(space: MemorySpace): ITransaction;
}

export type Activity = Variant<{
  read: IMemorySpaceAddress;
  write: IMemorySpaceAddress;
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
 * Describes either observed or desired state of the memory at a specific
 * address.
 */
export interface IAttestation {
  readonly address: IMemoryAddress;
  readonly value?: JSONValue;
}

export interface IStorageInvariant {
  readonly address: IMemorySpaceAddress;
  readonly value?: JSONValue;
}
