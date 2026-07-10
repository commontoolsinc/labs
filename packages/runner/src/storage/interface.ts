import type { Immutable } from "@commonfabric/utils/types";
import type {
  CellScope,
  FabricValue,
  SchemaPathSelector,
} from "@commonfabric/api";
import type {
  CommitPrecondition,
  EntityDocument,
  PatchOp,
  SchedulerActionSnapshotQuery,
  SchedulerSnapshotListResult,
  SqliteDbRef,
  SqliteOperation,
  SqliteParamsWire,
  SqliteQueryResult,
  SqliteRegisterDiskSourceResult,
} from "@commonfabric/memory/v2";
import type { EntityId } from "../create-ref.ts";
import type { MergeableOpDelta } from "./mergeable-ops.ts";
import {
  type Assertion,
  type AuthorizationError as IAuthorizationError,
  type ConflictError as IConflictError,
  type ConnectionError as IConnectionError,
  type DID,
  type Fact,
  type Invariant as IClaim,
  type MemorySpace,
  type QueryError as IQueryError,
  type Result,
  type Signer,
  type State,
  type The as MediaType,
  type TransactionError,
  type Unit,
  type URI,
  type Variant,
} from "@commonfabric/memory/interface";
import { BaseMemoryAddress } from "@commonfabric/runner/traverse";
import { Cell } from "../cell.ts";
import type {
  CfcAddress,
  CfcDereferenceTrace,
  CfcEnforcementMode,
  CfcFlowLabelsMode,
  CfcGrantWriteInput,
  CfcLabelMetadataProtectionMode,
  CfcPolicyEvaluationMode,
  CfcTriggerReadGating,
  CfcTxState,
  CfcWriteFloorMode,
  ConsultedGrant,
  ImplementationIdentity,
  PostCommitSideEffect,
  TrustSnapshot,
  WritePolicyInput,
} from "../cfc/mod.ts";
import type { NormalizedFullLink } from "../link-types.ts";

export type {
  Assertion,
  DID,
  Fact,
  IClaim,
  MediaType,
  MemorySpace,
  Result,
  Signer,
  State,
  Unit,
  URI,
};
export type ChangeGroup = unknown;

/**
 * Base interface for storage errors. These are lightweight objects (not Error
 * instances) used in Result types for better performance. Error instances are
 * ~500x more expensive to create due to stack trace generation.
 *
 * When throwing these errors, wrap them in a real Error at the throw site.
 */
export interface IStorageError {
  readonly name: string;
  readonly message: string;
}

/**
 * Metadata that can be attached to read operations
 */
export interface Metadata extends Record<PropertyKey, unknown> {}

/**
 * Options for read operations
 */
export interface IReadOptions {
  meta?: Metadata;
  /**
   * When true, register the read in transaction activity but skip loading
   * from storage. Use when caller already has the value and only needs
   * dependency tracking.
   */
  trackReadWithoutLoad?: boolean;
  /**
   * When true, the read is tracked as non-recursive for scheduler invalidation:
   * parent/same-path writes invalidate, child writes invalidate only on key
   * add, since those modify the keys that were read from the object.
   * We also invalidate if we set the length of an array.
   */
  nonRecursive?: boolean;
}

/** Immutable storage value container. */
export interface StorageValue<T extends FabricValue = FabricValue> {
  readonly value: Immutable<T>;
  readonly source?: EntityId;
}

/** Optional `StorageValue<T>`. */
export type OptStorageValue<T extends FabricValue = FabricValue> =
  | StorageValue<T>
  | undefined;

export interface IStorageManager extends IStorageSubscriptionCapability {
  id: string;

  /**
   * The signer used for authenticating storage operations.
   * Can be used to derive the user's identity DID via `as.did()`.
   */
  as: Signer;

  /**
   * Open a new connection to the storage provider associated with the given
   * space.
   */
  open(space: MemorySpace): IStorageProviderWithReplica;

  /**
   * Record a runtime-learned host hint for a space (federation site
   * table). Optional: managers without remote, per-space resolution
   * (emulated/test) simply don't implement it. Returns true when the
   * hint is in effect; false when refused (seeded differently, or the
   * space's connection is already open to another host).
   */
  registerSpaceHost?(space: MemorySpace, host: string): boolean;

  /**
   * Close all storage providers
   */
  close(): Promise<void>;

  /**
   * Creates a storage transaction that can be used to read / write data into
   * locally replicated memory spaces. Transaction allows reading from many
   * multiple spaces but writing only to one space.
   */
  edit(): IStorageTransaction;

  /**
   * Wait for all pending syncs to complete.
   *
   * @returns Promise that resolves when all pending syncs are complete.
   */
  synced(): Promise<void>;

  /**
   * Register an in-flight commit so the durability barrier
   * (`hasPendingCommits` / `pendingCommitsSettled`) covers it. Called by the
   * transaction layer at `commit()` entry, synchronously with the commit
   * being issued, so there is no window where a commit is in flight but
   * invisible to the barrier. The registration must tolerate rejection and
   * drop the promise once it settles.
   */
  trackPendingCommit(promise: Promise<unknown>): void;

  /**
   * Whether any registered commit is still unconfirmed. Every write flows
   * through `edit()` transactions, so this is the authoritative "are there
   * unconfirmed local writes" signal — narrower than `synced()`, which also
   * waits for pulls and cross-space read work.
   */
  hasPendingCommits(): boolean;

  /**
   * Wait for the currently pending commits to settle (server confirmation or
   * terminal failure). One round only: commits issued after the call starts
   * are not awaited — callers that need a fixpoint re-check `hasPendingCommits`
   * after each round, as the scheduler's client-facing idle does.
   */
  pendingCommitsSettled(): Promise<void>;

  /**
   * Add a promise to the list of cross-space promises.
   */
  addCrossSpacePromise(promise: Promise<void>): void;

  /**
   * Remove a promise from the list of cross-space promises.
   */
  removeCrossSpacePromise(promise: Promise<void>): void;

  /**
   * Register a deferred async chain in the cross-space promise set so
   * `Cell.pull()` and the scheduler's `idle()` await it, then drop it from the
   * set once it settles. Until a chain is registered it is invisible to the
   * convergence waiters: a pull can return before the chain has settled and
   * observe held, not-yet-loaded state. This is the safe composition of
   * `addCrossSpacePromise` and `removeCrossSpacePromise` — prefer it over
   * wiring the self-removing `finally` by hand at each call site.
   *
   * `work` must eventually settle (resolve or reject). A chain that never
   * settles stays registered and keeps `Cell.pull()`/`idle()` from observing
   * convergence until the scheduler's convergence bound trips, so a caller that
   * wraps an external `sync()` should ensure it cannot hang unbounded.
   */
  trackUntilSettled(work: Promise<unknown>): void;

  /**
   * Number of cross-space promises currently pending (async loads of link
   * targets in other spaces, kicked during link resolution or read
   * traversal). Zero in steady state — `Cell.pull()` uses this to decide
   * whether a convergence round is needed at all (CT-1667).
   */
  pendingCrossSpacePromiseCount?(): number;

  /**
   * Wait for the currently pending cross-space promises (and any they
   * transitively kick) to settle, WITHOUT waiting for full provider sync the
   * way `synced()` does. Used by `Cell.pull()`'s convergence loop so pulls
   * that kicked no loads keep their existing timing.
   */
  crossSpaceSettled?(): Promise<void>;

  /**
   * Documents whose load (`syncCell`) is currently in flight, as
   * `(space, scope, id)` addresses. The scheduler's event preflight parks the
   * head event while an address in the handler's read closure (or upstream of
   * it) is still loading — a load that completes with the document absent
   * counts as complete (CT-1795).
   */
  pendingLoadAddresses?(): readonly Pick<
    IMemorySpaceAddress,
    "space" | "scope" | "id"
  >[];

  /**
   * Resolves when none of the given documents (keyed
   * `space/scope/id`, see the scheduler's `entityKey`) has an in-flight
   * load. Resolves immediately when none do.
   */
  loadsSettled?(keys: readonly string[]): Promise<void>;

  /**
   * Load cell from storage. Will also subscribe to new changes.
   *
   * @returns Promise that resolves when the cell sync is complete.
   */
  syncCell<T>(cell: Cell<T>): Promise<Cell<T>>;
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
}

export interface LocalStorageOptions {
  as: Signer;
  id?: string;
  settings?: IRemoteStorageProviderSettings;
}

export interface IStorageProvider {
  /**
   * Sync a value from storage. Use transactions to retrieve the value.
   *
   * @param uri - uri of the entity to sync.
   * @param selector - The SchemaPathSelector with the path and schema that determines what to sync.
   * @returns Promise that resolves when the value is synced.
   */
  sync(
    uri: URI,
    selector?: SchemaPathSelector,
    scope?: CellScope,
  ): Promise<Result<Unit, Error>>;

  /**
   * Wait for all pending syncs to complete, that is all pending document syncs
   * and all pending commits.
   *
   * @returns Promise that resolves when all pending syncs are complete.
   */
  synced(): Promise<void>;

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

  /**
   * Internal scheduler persistence query. Memory v2 providers implement this
   * so the runner can rebuild scheduler indexes from persisted observations.
   */
  listSchedulerActionSnapshots?(
    query?: SchedulerActionSnapshotQuery,
  ): Promise<SchedulerSnapshotListResult>;

  /** Run a server-side read-only SQLite query against a cell-derived db. */
  sqliteQuery?(
    db: SqliteDbRef,
    sql: string,
    params?: SqliteParamsWire,
  ): Promise<SqliteQueryResult>;

  // No `sqliteExecute`: SQLite writes go through the commit fold
  // (recordSqliteWrite -> a `sqlite` op in the commit), never a standalone RPC.

  /**
   * Whether the CONNECTED SERVER advertised commit-time row-label evaluation
   * for folded sqlite writes (CFC Phase 3.c,
   * `MemoryProtocolFlags.sqliteCommitRowLabelEval`). The runner's write gate
   * relaxes its non-attributable-shape rejects only when this is true; a
   * missing implementation, a not-yet-resolved session, or an old server all
   * read as `false` — fail closed.
   */
  sqliteServerCommitRowLabelEval?(): boolean;

  /**
   * Register an injected on-disk SQLite source (Phase 7, read-only v1). After
   * this, server-side reads for `id` resolve against the on-disk file at `path`
   * (attached read-only) instead of the cell-derived db; writes are rejected.
   */
  registerSqliteDiskSource?(
    id: string,
    path: string,
  ): Promise<SqliteRegisterDiskSourceResult>;
}

/**
 * Extension of {@link IStorageManager} which is supposed to merge into
 * {@link IStorageManager} in the future. It provides capability to subscribe
 * to the storage notifications.
 */
export interface IStorageNotificationCapability {
  /**
   * Subscribes to the storage manager's notifications.
   *
   * @example
   * ```ts
   * storage.subscribe({
   *   next(notification) {
   *     console.log(notification);
   *     return { done: true };
   *   }
   * });
   * ```
   *
   * Although note that function takes a generalized {@link Iterator} as an
   * argument so you could subscribe with a generator.
   *
   * @example
   * ```ts
   * function* log(n) {
   *   while (n-- > 0) {
   *     const notification = yield;
   *     console.log(notification);
   *   }
   * }
   * storage.subscribe(log(5));
   * ```
   */
  subscribe(subscription: IStorageNotification): void;

  /**
   * Removes a previously registered notification subscriber.
   */
  unsubscribe?(subscription: IStorageNotification): void;
}

/**
 * Subscription that can be used to receive storage notifications.
 */
export interface IStorageNotification {
  /**
   * Called with a next notification, if returns `{ done: true }` or throws an
   * exception, subscription will be cancelled and method will not be called
   * again until re-subscribed through another `subscribe` on
   * `IStorageSubscriptionCapability`. Returning any other return value implies
   * continued subscription.
   */
  next(
    notification: StorageNotification,
  ): Omit<IteratorResult<unknown, unknown>, "value"> | undefined;
}

/**
 * Backward-compatible alias retained while the v1 naming is still used
 * throughout the runner.
 */
export interface IStorageSubscriptionCapability
  extends IStorageNotificationCapability {}

/**
 * Backward-compatible alias retained while the v1 naming is still used
 * throughout the runner.
 */
export interface IStorageSubscription extends IStorageNotification {}

/**
 * Notification produced by the underlying storage. It is a variant type
 * implying that object has only one of the fields with a cerrosponding
 * value. Property name denotes type of notification.
 */
export type StorageNotification =
  | ICommitNotification
  | IRevertNotification
  | ILoadNotification
  | IPullNotification
  | IIntegrateNotification
  | IResetNotification;

/**
 * This notification is broadcasted after commit on {@link IStorageTransaction}
 * is called and underlying changes are written to the local replica. Note that
 * this represents a local optimistic update which can be denied by remote
 * storage provider in which case they will be reverted.
 */
export interface ICommitNotification {
  type: "commit";

  /**
   * The space into which changes were made.
   */
  space: MemorySpace;
  /**
   * Set of changes merged.
   */
  changes: IMergedChanges;
  /**
   * Transaction that committed changes. If legacy API is used it will not have
   * a source transaction.
   */
  source?: IStorageTransaction;
}

/**
 * This notification is broadcasted if commited changes were denied and had to
 * be reverted.
 */
export interface IRevertNotification {
  type: "revert";

  /**
   * The space into which changes were made.
   */
  space: MemorySpace;
  /**
   * Set of changes merged. Note that this is not necessary resetting every
   * change commit made to a state it had pre-commit as things may have changed
   * since and `before` values will represent state in the replica before we
   * reverted them to the state in the `after`. Also note that set of changes
   * in the commit may be larger than set of changes here because commit may
   * have being stacked on to of the other and if first commit was denied and
   * reverted changes are some state may have already being updated by previous
   * revert.
   */
  changes: IMergedChanges;

  /**
   * Reason storage had to revert changes.
   */
  reason: StorageTransactionRejected;

  /**
   * Transaction that committed changes. If legacy API is used it will not have
   * a source transaction.
   */
  source?: IStorageTransaction;
}

/**
 * This notification is broadcasted when storage loads changes from the local
 * cache into a storage.
 */
export interface ILoadNotification {
  type: "load";
  space: MemorySpace;
  changes: IMergedChanges;
}

/**
 * This notification is broadcasted when storage pulls changes from the remote
 * storage provider and merges them into the local replica.
 */
export interface IPullNotification {
  type: "pull";
  space: MemorySpace;
  changes: IMergedChanges;
}

/**
 * This notification is broadcasted after storage receives integrates changes from
 * the remote storage provider into a local replica.
 */
export interface IIntegrateNotification {
  type: "integrate";
  space: MemorySpace;
  changes: IMergedChanges;
}

/**
 * This notification is broadcasted after storage has being reset, which can happen
 * on network errors. It implies that all in memory caches have being cleared and
 * will be populated with data from persisted cache and remote storage provider.
 */
export interface IResetNotification {
  type: "reset";
  space: MemorySpace;
}

/**
 * Set of changes that were merged into the local replica.
 */
export interface IMergedChanges extends Iterable<IMemoryChange> {
}

/**
 * Options accepted by transaction write operations.
 */
export interface IWriteOptions {
  /**
   * When true, the write removes the slot at the address path — deleting an
   * object key or punching an array hole — instead of storing a value.
   * `value` must be `undefined`. Without this flag, writing `undefined`
   * stores `undefined` as a real value: present-but-undefined is distinct
   * from absent. A root-path delete retracts the document.
   */
  delete?: boolean;
}

export interface ITransactionWriteRequest {
  address: IMemorySpaceAddress;
  value: FabricValue;
  /** See {@link IWriteOptions.delete}. */
  delete?: boolean;
}

export interface IMemoryChange {
  /**
   * Memory address that was changed.
   */
  address: IMemoryAddress;
  /**
   * Value memory address had before change.
   */
  before: Immutable<FabricValue>;
  /**
   * Value memory address has after change.
   */
  after: Immutable<FabricValue>;
}

export type StorageTransactionStatus =
  | { status: "ready"; journal: ITransactionJournal }
  | { status: "pending"; journal: ITransactionJournal }
  | { status: "done"; journal: ITransactionJournal }
  | {
    status: "error";
    journal: ITransactionJournal;
    error: StorageTransactionFailed;
  };

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
   * Optional change group used to associate commits with scheduler actions.
   */
  changeGroup?: ChangeGroup;
  /**
   * When true, the transaction bypasses batch-signing debounce and flushes
   * immediately. Set for user-interactive paths (editWithRetry, events).
   */
  immediate?: boolean;
  /**
   * The scheduler action whose run opened this transaction (spec scheduler-v2
   * P5). Change records derived from this transaction must not re-trigger this
   * action. Compared by OBJECT IDENTITY — diagnostic action ids may collide
   * across instances.
   */
  sourceAction?: object;
  /**
   * Opt the transaction into writing to more than one memory space. By default
   * a transaction may write to a single space only. When enabled, commit()
   * commits each written space's changes as a separate per-space commit, in the
   * provided order (or first-write order if omitted). The per-space commits run
   * sequentially with NO cross-space atomicity, and STOP at the first per-space
   * failure: spaces committed before the failure are durable and not rolled back
   * (logged), while the failing space and every space after it are left
   * uncommitted. (Stopping preserves the requested order — e.g. a child space
   * before the parent that links to it — and avoids double-applying later writes
   * on retry.)
   *
   * `order` is a sequencing hint ONLY: it controls the order in which written
   * spaces are committed (spaces listed first commit first). It does NOT
   * restrict which spaces may be written — a written space absent from `order`
   * still commits, appended in first-write order. Authorization is unchanged:
   * each space commits through its own authenticated session exactly as a
   * single-space commit would, so this opt-in cannot grant access the caller
   * does not already hold. Calling this more than once is allowed; the last
   * non-undefined `order` wins.
   *
   * Partial-failure contract: because there is no rollback, a multi-space commit
   * error means the cross-space state is INDETERMINATE — some spaces may be
   * durably committed and others not. Callers must treat the error accordingly
   * (the first per-space error is surfaced as the overall result; all per-space
   * failures are logged).
   */
  enableMultiSpaceWrites?(order?: readonly MemorySpace[]): void;
  /**
   * Optional read-only mode hook used by runtime-generated fallback read
   * transactions.
   */
  setReadOnly?(reason?: string): void;
  clearReadOnly?(): void;
  isReadOnly?(): boolean;
  /**
   * The transaction journal containing all read and write activities.
   * Provides access to transaction operations and dependency tracking.
   */
  readonly journal: ITransactionJournal;

  /**
   * Optional lightweight dependency summary.
   *
   * V2 transactions can provide this directly instead of requiring callers to
   * reconstruct it from journal activity.
   */
  getReactivityLog?(): TransactionReactivityLog;

  /**
   * Optional scheduler observation payload to persist alongside the native
   * memory transaction. When there are no semantic writes, storage backends may
   * still commit this metadata as an internal no-op observation.
   */
  setSchedulerObservation?(observation: unknown): void;
  getSchedulerObservation?(): unknown;

  /**
   * Optional commit-time preconditions attached to this transaction's commit in
   * the given space. Storage backends that support v2 native commits read these
   * during commit construction.
   */
  addCommitPrecondition?(
    space: MemorySpace,
    precondition: CommitPrecondition,
  ): void;
  getCommitPreconditions?(
    space: MemorySpace,
  ): readonly CommitPrecondition[] | undefined;

  /**
   * Mark an entity this transaction creates as create-only: the commit fails
   * with PreconditionFailedError("receipt-exists") if the entity already has a
   * head (scheduler-v2 §7.6 receipts).
   */
  markCreateOnly?(
    link: { space: MemorySpace; id: string; scope?: unknown },
  ): void;

  /**
   * Record one mergeable-write delta against the document at `address` (see
   * {@link MergeableOpDelta}): elements appended at the array's tail or set-added
   * by identity, a numeric increment, or a value removed by identity. The commit
   * emits these as the corresponding mergeable op (which the server resolves
   * against durable state) and drops the op's path from the commit's conflict
   * read set, so concurrent and stale-base writes merge rather than clobber. The
   * op catalog and folding rules live in ./mergeable-ops.ts.
   */
  recordMergeableOp?(
    address: IMemorySpaceAddress,
    delta: MergeableOpDelta,
  ): void;

  /**
   * The document addresses for which this transaction recorded a mergeable op.
   * The commit's read-set builder uses these to drop reads of those paths from
   * conflict detection.
   */
  getMergeableOpAddresses?(): Iterable<IMemorySpaceAddress>;

  /**
   * Optional: record a folded SQLite write onto this transaction so it commits
   * ATOMICALLY with the cell ops targeting `space` (one commit = cell ops + a
   * `sqlite` op; on SQL failure the whole commit aborts). Claims `space` as a
   * write target (same write-isolation rules as a cell write) and throws if the
   * tx is not writable. See
   * docs/specs/sqlite-builtin/plans/sqlite-execute-commit-fold.md.
   */
  recordSqliteWrite?(space: MemorySpace, op: SqliteOperation): void;

  /**
   * Optional raw read observations recorded by this transaction.
   *
   * V2 transactions can provide these directly instead of requiring callers to
   * scan journal activity.
   */
  getReadActivities?(): Iterable<IReadActivity>;

  /**
   * Optional ordered log of every applied write attempt, in transaction
   * order, stamped on the same per-transaction activity clock as read
   * activities. Unlike `getWriteDetails` (per-path, last-value upserts,
   * path-sorted reconstruction) this preserves the temporal write sequence,
   * one entry per write call. The CFC write-prefix provenance gate derives
   * each protected path's last-overlapping-write bound from it
   * (docs/specs/cfc-write-prefix-provenance.md §4/§6).
   */
  getWriteAttemptLog?(): readonly IWriteAttempt[];

  /**
   * Optional write details for the given space.
   *
   * V2 transactions can provide the current and previous values directly
   * instead of materializing novelty/history attestations.
   */
  getWriteDetails?(space: MemorySpace): Iterable<TransactionWriteDetail>;

  /**
   * Optional read details for the given space: the values this transaction
   * observed for its reads (its read invariants). Available after commit or
   * abort, since the underlying per-document snapshots are pinned for the
   * transaction's lifetime.
   */
  getReadDetails?(space: MemorySpace): Iterable<TransactionReadDetail>;

  /**
   * Describes current status of the transaction. Returns a union type with
   * status field indicating the current state:
   * - `"ready"`: Transaction is being built and ready for operations
   * - `"pending"`: Commit was called but promise has not resolved yet
   * - `"done"`: Commit successfully completed
   * - `"error"`: Transaction has failed or was cancelled, includes error details

   * Each status variant includes a `journal` field with transaction operations.
   */
  status(): StorageTransactionStatus;

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
   * @param options - Optional read options including metadata
   * @returns Result containing the read value or an error.
   */
  read(
    address: IMemorySpaceAddress,
    options?: IReadOptions,
  ): Result<IAttestation, ReadError>;

  /**
   * Creates a memory space writer for this transaction. Fails if transaction is
   * no longer in progress or if writer for the different space was already open
   * on this transaction. Requesting a writer for the same memory space will
   * return same writer instance.
   */
  writer(space: MemorySpace): Result<ITransactionWriter, WriterError>;

  /**
   * Helper that is the same as `writer().write()` but more convenient, as it
   * combines error capturing in one call.
   *
   * Writes a value into a storage at a given address & captures it in the
   * transaction invariants.
   *
   * @param address - Memory address to write to.
   * @param value - Value to write.
   * @param options - Optional write options (e.g. explicit delete intent).
   * @returns Result containing the written value or an error.
   */
  write(
    address: IMemorySpaceAddress,
    value?: FabricValue,
    options?: IWriteOptions,
  ): Result<IAttestation, WriterError | WriteError>;

  /**
   * Optional batched write hook for transactions that can apply multiple path
   * writes more efficiently than one-at-a-time.
   */
  writeBatch?(
    writes: Iterable<ITransactionWriteRequest>,
  ): Result<Unit, WriterError | WriteError>;

  /**
   * Creates a memory space reader for inside this transaction. Fails if
   * transaction is no longer in progress. Requesting a reader for the same
   * memory space will return same reader instance.
   */
  reader(
    space: MemorySpace,
  ): Result<ITransactionReader, ReaderError>;

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
   * `pending`. Transaction may still fail with {@link StorageTransactionRejected}
   * if state upstream affects values read from updated space have changed,
   * which can happen if another client concurrently updates them. Transaction
   * MAY also fail due to insufficient authorization level or due to various IO
   * problems.
   *
   * Calling commit on a transaction that has already completed (committed or
   * failed) returns the prior error or a {@link IStorageTransactionComplete}
   * error. Commit is NOT idempotent — it does not replay the original result.
   *
   * When this method returns, the changes will have been committed locally,
   * but may not be visible to another runtime. When the returned promise
   * resolves, the data is fully committed and available to other processes.
   */
  commit(): Promise<Result<Unit, CommitError>>;

  /**
   * Optional native commit draft hook for storage backends that can consume a
   * more direct representation than legacy fact archives.
   */
  getNativeCommit?(space: MemorySpace): NativeStorageCommit | undefined;
}

export interface IExtendedStorageTransaction
  extends Omit<IStorageTransaction, "reader" | "writer"> {
  tx: IStorageTransaction;

  /**
   * The durable id of the event whose dispatch opened this transaction
   * (spec §7.5). Set by the scheduler's event dispatch; consumed by the
   * runner to derive the handler result cell's cause (spec §7.6).
   */
  dispatchedEventId?: string;

  /**
   * Commit-time preconditions attached to this transaction's commit in
   * the given space (scheduler-v2 §7.6). Violations surface as
   * IPreconditionFailedError (permanent — never retried).
   */
  addCommitPrecondition?(
    space: MemorySpace,
    precondition: CommitPrecondition,
  ): void;
  getCommitPreconditions?(
    space: MemorySpace,
  ): readonly CommitPrecondition[] | undefined;

  /**
   * Mark an entity this transaction creates as create-only: the commit fails
   * with PreconditionFailedError("receipt-exists") if the entity already has a
   * head (scheduler-v2 §7.6 receipts).
   */
  markCreateOnly?(
    link: { space: MemorySpace; id: string; scope?: unknown },
  ): void;

  /**
   * Record one mergeable-write delta against the document addressed by `link`
   * (see {@link MergeableOpDelta}), forwarded to the underlying transaction after
   * resolving the link to a memory address.
   */
  recordMergeableOp?(link: NormalizedFullLink, delta: MergeableOpDelta): void;

  getCfcState(): Readonly<CfcTxState>;
  setCfcEnforcementMode(mode: CfcEnforcementMode): void;
  setCfcFlowLabelsMode(mode: CfcFlowLabelsMode): void;
  /** Set the write-side `requiredIntegrity` floor dial (§8.12.4.1 / SC-18). */
  setCfcWriteFloorMode(mode: CfcWriteFloorMode): void;
  /**
   * Enable trigger-read gating on the enforcement side (§8.9.2 / SC-3).
   * Anti-downgrade pinned: once enabled, disabling throws.
   */
  setCfcTriggerReadGating(enabled: CfcTriggerReadGating): void;
  /**
   * Set the exchange-rule policy evaluation dial (Epic B5, spec §4.4.5).
   * Anti-downgrade pinned: once `enforce`, weakening throws.
   */
  setCfcPolicyEvaluationMode(mode: CfcPolicyEvaluationMode): void;
  /**
   * Set the cross-space label-metadata representation dial (inv-12 Stage 1 /
   * SC-25, spec §4.6.4.1). Anti-downgrade pinned: once `enforce`, weakening
   * throws.
   */
  setCfcLabelMetadataProtectionMode(
    mode: CfcLabelMetadataProtectionMode,
  ): void;
  /**
   * Record the addresses whose invalidating writes scheduled this run
   * (§8.9.2 trigger reads). Their labels join the flow-label derivation
   * even when the run never re-reads them.
   */
  addCfcTriggerReads(reads: readonly IMemorySpaceAddress[]): void;
  /**
   * Run `fn` with `meta` merged into every read issued within (explicit
   * per-read meta wins). Lets scheduling machinery tag its reads without
   * threading metadata through intermediate APIs.
   */
  runWithAmbientReadMeta<T>(meta: Metadata, fn: () => T): T;
  markCfcRelevant(reason?: string): void;
  invalidateCfc(reason: string): void;

  getNarrowestReadScope(): CellScope;
  resetNarrowestReadScope(scope?: CellScope): void;

  /**
   * CFC recording / ownership-transfer API.
   *
   * The methods below all hand a caller-constructed record into the CFC
   * subsystem's transaction-scoped state. Each one establishes an
   * ownership transfer at the call boundary: from the moment the call
   * returns, the supplied record is owned by the transaction. Callers
   * MUST NOT subsequently mutate it (or any object reachable from it),
   * and MUST NOT retain it for use anywhere else that depends on it
   * remaining mutable.
   *
   * The CFC subsystem treats these records as identity-stable structural
   * fingerprints — they participate in canonicalization, sorting, and
   * `hashStringOf()`-based equality. The CFC implementation is therefore
   * permitted to `deepFreeze()` the record on entry, both as a tripwire
   * for accidental mutation and to make it eligible for the
   * `hashStringOf()` WeakMap cache. The
   * `record*` methods that take a structurally-shaped record
   * (`recordCfcDereferenceTrace()` and `recordCfcWritePolicyInput()`)
   * actively do this on entry; the contract applies uniformly to every
   * method in the group.
   *
   * Callers do not need to freeze the record themselves — the CFC
   * implementation will, where it's useful. Freezing on the caller side
   * is equally welcome though, and is often a reasonable choice when
   * the same record (or sub-objects) is also handed to other consumers
   * with similar contracts; `deepFreeze()` short-circuits on input
   * that's already deeply frozen, so a redundant freeze costs almost
   * nothing.
   */

  /**
   * Records a CFC dereference trace produced by following a write
   * redirect or value reference. See ownership note above; the
   * argument is `deepFreeze()`d on entry so every CfcAddress that
   * flows into the digest input is immutable.
   */
  recordCfcDereferenceTrace(trace: CfcDereferenceTrace): void;

  /**
   * Declares a list-coordinator result container (filter/flatMap) whose
   * `structure` label must be re-derived from this transaction's flow-join J
   * (its selection criteria) — independent of whether the container value is
   * written this tx. See `CfcTxState.structureContainers`. The address is
   * `deepFreeze()`d on entry.
   */
  recordCfcStructureContainer(address: CfcAddress): void;

  /**
   * Runs CFC boundary verification for this transaction and records the
   * prepared digest. Takes no caller-supplied input: the commit-time digest
   * recheck only confirms the prepared input matches real activity, so an
   * external input override would let a caller skip verification while still
   * passing the recheck (audit S2).
   */
  prepareCfc(): string;

  /**
   * Sets (or clears) the CFC trust snapshot for this transaction. See
   * ownership note above.
   */
  setCfcTrustSnapshot(snapshot: TrustSnapshot | undefined): void;

  /**
   * Sets (or clears) the implementation identity that will be folded
   * into the CFC digest for this transaction. See ownership note above.
   */
  setCfcImplementationIdentity(
    identity: ImplementationIdentity | undefined,
  ): void;

  /**
   * Records a write-policy input that will participate in the CFC
   * commit-boundary digest. See ownership note above; the argument is
   * `deepFreeze()`d on entry, both to honor the ownership-transfer
   * contract and to enable the within-sort tiebreaker cache in
   * `compareWritePolicyInput`.
   */
  recordCfcWritePolicyInput(input: WritePolicyInput): void;

  /**
   * Records a grant document consulted by policyState-guarded boundary
   * evaluation (§8.12.7 route 2a) — address plus resolution-time content
   * digest — for the prepared-digest binding (`PreparedDigestInput.
   * consultedGrants`). Deduplicated by address; the argument is
   * `deepFreeze()`d on entry. Called by the runner-side grant resolver
   * (`createTxCfcGrantResolver`); recording is not itself an enforcement
   * decision, so exposure is harmless (like `noteCfcDiagnostic`).
   */
  recordCfcConsultedGrant(consulted: ConsultedGrant): void;

  /**
   * The trusted policy-writer path for CFC grant documents (§8.12.7 route
   * 2a; cfc/grants.ts module doc). Requires the transaction's CURRENT
   * implementation identity to be a trusted builtin (the arm
   * `writeAuthorizedBy` and the runtime-mint gate trust for runtime
   * evidence — ordinary pattern/handler code is refused); validates the
   * grant — audience entries principal-like per §3.1.8, `owner` equal to
   * this transaction's acting principal (release authority), lifecycle
   * shape — derives the content-addressed id under the reserved
   * `grant:cfc:` namespace, and writes the document inside the privileged
   * system-write scope. Throws on any violation. Any OTHER write to the
   * reserved namespace is recorded as an unprivileged system write and
   * fails closed at prepare (S18 class).
   */
  writeCfcGrant(input: CfcGrantWriteInput): { space: MemorySpace; id: string };

  /**
   * Surfaces a post-commit sink-request release rejection (the effect is fail-
   * closed and not sent) to CFC diagnostics and runtime stats, instead of only
   * logging it (audit W3.23).
   */
  noteCfcSinkReleaseReject(
    info: { sink: string; effectId: string; detail: string },
  ): void;

  /**
   * Appends a CFC diagnostic message. The sanctioned write path for the CFC
   * machinery's observe-mode notes — getCfcState() returns a read-only view.
   * Diagnostics are advisory and never feed an enforcement decision.
   */
  noteCfcDiagnostic(message: string): void;

  /**
   * Enqueues a side effect to run from the CFC outbox after a successful
   * commit. See ownership note above.
   */
  enqueuePostCommitEffect(effect: PostCommitSideEffect): void;

  /**
   * True when this transaction still carries un-flushed post-commit side
   * effects (the CFC outbox is non-empty). The scheduler uses this to decide
   * whether `commit()` does asynchronous work after the inner storage commit
   * (e.g. a sqlite query RPC + writeback) that `idle()` must wait on — a plain
   * commit with no effects keeps its existing fire-and-forget fast path.
   */
  hasPendingPostCommitEffects(): boolean;

  /**
   * Add a callback to be called when the transaction commit completes.
   * The callback receives the transaction as a parameter and is called
   * regardless of whether the commit succeeded or failed.
   *
   * Internal-only hook. Callbacks may run after failed commits and therefore
   * must not perform external side effects or release external requests. Use
   * the CFC post-commit outbox for effectful work that should happen only after
   * a successful commit.
   *
   * Note: Callbacks are called synchronously after commit completes.
   * If a callback throws, the error is logged but doesn't affect other callbacks.
   *
   * @param callback - Function to call after commit
   */
  addCommitCallback(
    callback: (
      tx: IExtendedStorageTransaction,
      result: Result<Unit, CommitError>,
    ) => void,
  ): void;

  /**
   * Reads a value from a (local) memory address and throws on error, except for
   * `NotFoundError` which is returned as undefined.
   *
   * @param address - Memory address to read from.
   * @returns The read value.
   */
  readOrThrow(
    address: IMemorySpaceAddress,
    options?: IReadOptions,
  ): FabricValue;

  /**
   * Reads a value from a (local) memory address and throws on error, except for
   * `NotFoundError` which is returned as undefined.
   *
   * Thin convenience wrapper over `readOrThrow()` that prepends `"value"` to
   * the supplied path.
   *
   * @param address - Memory address to read from.
   * @returns The read value.
   */
  readValueOrThrow(
    address: NormalizedFullLink,
    options?: IReadOptions,
  ): FabricValue;

  /**
   * Writes a value into a storage at a given address, including creating parent
   * entries in the document if a path is provided or throws an error.
   *
   * Internal runner API. Phase-1 CFC no-op attempted-target coverage is not
   * derived from blind direct `write*()` calls. Callers that need attempted
   * target coverage before same-value short-circuiting must first establish it
   * through a higher-level diff path such as `markReadAsAttemptedWrite`.
   * Runner-owned system metadata writes may also use this directly when they
   * are intentionally out of phase-1 value-surface CFC scope.
   *
   * @param address - Memory address to write to.
   * @param value - Value to write.
   * @param options - Optional write options (e.g. explicit delete intent).
   */
  writeOrThrow(
    address: IMemorySpaceAddress,
    value: FabricValue,
    options?: IWriteOptions,
  ): void;

  /**
   * Writes a value into a storage at a given address, including creating parent
   * entries in the document if a path is provided or throws an error.
   *
   * Thin convenience wrapper over `writeOrThrow()` that prepends `"value"` to
   * the supplied path.
   *
   * Internal runner API with the same phase-1 CFC caveat as `writeOrThrow()`:
   * blind same-value direct writes do not by themselves establish attempted
   * target coverage. Use higher-level diff paths when no-op attempted writes
   * need to appear in `attemptedWrites`.
   *
   * @param address - Memory address to write to.
   * @param value - Value to write.
   * @param options - Optional write options (e.g. explicit delete intent).
   */
  writeValueOrThrow(
    address: NormalizedFullLink,
    value: FabricValue,
    options?: IWriteOptions,
  ): void;

  /**
   * Optional batched write helper that preserves the extended transaction's
   * `["value", ...path]` helper semantics on top of `writeBatch`.
   */
  writeValuesOrThrow?(
    writes: Iterable<
      { address: NormalizedFullLink; value: FabricValue; delete?: boolean }
    >,
  ): void;

  /**
   * Per-transaction memoization for `Cell.get()` results.
   *
   * Within a single transaction, repeatedly reading the same cell recomputes the
   * full read pipeline (link resolution, schema merge, schema-guided traversal).
   * When no write has occurred since the last read, that work is redundant: the
   * value, the reactive reads it registers, and the CFC state it produces are all
   * identical. These two methods let `Cell.get()` cache its result keyed by the
   * stable value of the cell view; the implementation clears the entire cache
   * on any write, so a cached entry is only ever returned when no write has
   * intervened.
   *
   * Optional: transactions that must not cache (e.g. the non-reactive `sample()`
   * wrapper) leave these undefined and callers fall back to recomputing.
   * `key` must be a stable value key for the cell view (normalized link,
   * including schema, plus any CFC label view); `variant` distinguishes reads
   * that differ in options. A returned `{ value }` wrapper signals a hit, so a
   * cached `undefined` value is distinguishable from a miss.
   */
  getCachedReadResult?(
    key: string,
    variant: string,
  ): { value: unknown } | undefined;

  setCachedReadResult?(
    key: string,
    variant: string,
    value: unknown,
  ): void;

  /**
   * Optional diagnostics for the transaction-local `Cell.get()` cache.
   *
   * `entries` reports the currently retained cache entries, which drops to zero
   * after any write because writes replace the transaction-local cache map.
   * Hit/miss/set counts are cumulative for the transaction.
   */
  getReadResultCacheStats?(): {
    hits: number;
    misses: number;
    sets: number;
    entries: number;
  };
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
   *  assert(tx.read({ type, id, path: ['content', 'length'] }).ok?.value === undefined)
   *  assert(tx.read({ type, id, path: ['title'] }).ok?.value === "Hello world")
   *  // Referencing non-existing facts produces errors
   *  assert(tx.read({ type: 'bad/mime', id, path: ['author'] }).error.name === 'NotFoundError')
   * ```
   *
   * @param address - Memory address to read from
   * @param options - Optional read options including metadata
   */
  read(
    address: IMemoryAddress,
    options?: IReadOptions,
  ): Result<IAttestation, ReadError>;
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
    value?: FabricValue,
    options?: IWriteOptions,
  ): Result<IAttestation, WriteError>;
}

/**
 * Error that is produced when transaction is being updated after it was already
 * aborted.
 */
export interface IStorageTransactionAborted extends IStorageError {
  readonly name: "StorageTransactionAborted";
  /**
   * Reason provided when transaction was aborted.
   */
  readonly reason: unknown;
}

/**
 * Error indicates that transaction consistency guarantees have being
 * invalidated - some fact has changed while transaction was in progress.
 */
export interface IStorageTransactionInconsistent extends IStorageError {
  readonly name: "StorageTransactionInconsistent";

  readonly address: IMemoryAddress;

  from(space: MemorySpace): IStorageTransactionInconsistent;
}

/**
 * A commit-time precondition failed (spec scheduler-v2 §7.6). Unlike
 * optimistic conflicts, this class is PERMANENT: the client must not
 * retry. `origin-committed` — the transaction that caused this work
 * never committed. `receipt-exists` — another handling of the same
 * event already committed (lost race).
 */
export interface IPreconditionFailedError extends Error {
  name: "PreconditionFailedError";
  precondition: "origin-committed" | "receipt-exists";
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
  | StorageTransactionRejected;

export type StorageTransactionRejected =
  | IConflictError
  | IPreconditionFailedError
  | IStoreError
  | TransactionError
  | IConnectionError
  | IAuthorizationError;

export type CommitError =
  | InactiveTransactionError
  | StorageTransactionRejected;

/**
 * Error returned when a read or write operation fails because the intra-value
 * path does not exist.
 *
 * The `path` property behavior is consistent for both reads and writes:
 *
 * **Nested path not found** (document exists but path doesn't):
 * - `path` includes the missing key
 * - Example: Document `{ user: { name: "Alice" } }`, access `["user", "settings", "theme"]`
 * - → `path` is `["user", "settings"]` (path to the non-existent key)
 * - To get last existing parent: `path.slice(0, -1)` → `["user"]`
 *
 * **Document not found** (document itself doesn't exist):
 * - `path` is `[]` (empty array)
 * - Example: Document doesn't exist, access `["foo", "bar"]`
 * - → `path` is `[]`
 */
export interface INotFoundError extends IStorageError {
  readonly name: "NotFoundError";
  readonly source: IAttestation;
  readonly address: IMemoryAddress;
  /** Path to the non-existent key, or `[]` if the document doesn't exist. */
  readonly path: readonly MemoryAddressPathComponent[];
  from(space: MemorySpace): INotFoundError;
}

/**
 * Error returned when the media type is not supported by the storage transaction.
 */
export interface IUnsupportedMediaTypeError extends IStorageError {
  readonly name: "UnsupportedMediaTypeError";

  from(space: MemorySpace): IUnsupportedMediaTypeError;
}

/**
 * Error returned when a data URI is invalid or cannot be parsed.
 */
export interface IInvalidDataURIError extends IStorageError {
  readonly name: "InvalidDataURIError";
  readonly cause?: IStorageError;

  from(space: MemorySpace): IInvalidDataURIError;
}

export type ReadError =
  | INotFoundError
  | InactiveTransactionError
  | IInvalidDataURIError
  | IUnsupportedMediaTypeError
  | ITypeMismatchError;

export type WriteError =
  | INotFoundError
  | IUnsupportedMediaTypeError
  | InactiveTransactionError
  | IReadOnlyAddressError
  | ITypeMismatchError;

export type ReaderError = InactiveTransactionError;

export type WriterError =
  | InactiveTransactionError
  | IStorageTransactionWriteIsolationError
  | IReadOnlyAddressError;

export interface IStorageTransactionComplete extends IStorageError {
  readonly name: "StorageTransactionCompleteError";
}

/**
 * Represents adddress within the memory space which is like pointer inside the
 * fact value in the memory.
 */
export interface IMemoryAddress {
  /**
   * URI to an entity. It corresponds to `of` field in the memory protocol.
   */
  id: URI;
  /**
   * Protocol fact type. Document addresses omit this; storage boundaries use
   * application/json.
   */
  type?: MediaType;
  /**
   * Declared scoped cell instance. Storage defaults omitted scope to `space`.
   */
  scope?: CellScope;
  /**
   * Intra-value path to the {@link FabricValue} being referenced by this
   * address. It is a path within the `is` field of the fact in memory protocol.
   */
  path: readonly MemoryAddressPathComponent[];
}

export interface IMemorySpaceAddress extends IMemoryAddress {
  space: MemorySpace;
}

export type MemoryAddressPathComponent = string;

export interface Assert {
  the: MediaType;
  of: URI;
  is: FabricValue;

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
  get(entry: BaseMemoryAddress): State | undefined;

  getDocument(id: URI, scope?: CellScope): EntityDocument | undefined;

  commit?(
    transaction: ITransaction,
    source?: IStorageTransaction,
  ): Promise<Result<Unit, StorageTransactionRejected>>;

  commitNative?(
    transaction: NativeStorageCommit,
    source?: IStorageTransaction,
  ): Promise<Result<Unit, StorageTransactionRejected>>;
}

export type PushError =
  | IQueryError
  | IStoreError
  | IConnectionError
  | IConflictError
  | IPreconditionFailedError
  | TransactionError
  | IAuthorizationError;

export type PullError =
  | IQueryError
  | IStoreError
  | IConnectionError
  | IAuthorizationError;

export interface IStoreError extends IStorageError {
  readonly name: "StoreError";
  readonly cause: IStorageError;
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
}

export interface TransactionReactivityLog {
  reads: IMemorySpaceAddress[];
  shallowReads: IMemorySpaceAddress[];
  writes: IMemorySpaceAddress[];
  attemptedWrites?: IMemorySpaceAddress[];
}

export interface TransactionWriteDetail {
  address: IMemorySpaceAddress;
  value?: Immutable<FabricValue>;
  previousValue?: Immutable<FabricValue>;
}

export interface TransactionReadDetail {
  address: IMemorySpaceAddress;
  value?: Immutable<FabricValue>;
}

export type NativeStorageCommitOperation =
  | {
    op: "set";
    id: URI;
    type: MediaType;
    scope?: CellScope;
    value: FabricValue;
  }
  | {
    op: "delete";
    id: URI;
    type: MediaType;
    scope?: CellScope;
  }
  | {
    op: "patch";
    id: URI;
    type: MediaType;
    scope?: CellScope;
    patches: PatchOp[];
    value: FabricValue;
  };

export interface NativeStorageCommit {
  operations: readonly NativeStorageCommitOperation[];
  schedulerObservation?: unknown;
  preconditions?: readonly CommitPrecondition[];
  /**
   * Folded SQLite write ops, applied in the same wire commit as `operations`
   * (appended last). They are NOT entity revisions and stay out of the
   * doc-pending / touched / notify machinery.
   */
  sqliteOps?: readonly SqliteOperation[];
}

export interface ITransaction {
  claims: IClaim[];

  facts: Fact[];
}

export interface IStorageEdit {
  for(space: MemorySpace): ITransaction;
}

export type Activity = Variant<{
  read: IReadActivity;
  write: IMemorySpaceAddress;
}>;

export interface IReadActivity extends IMemorySpaceAddress {
  meta: Metadata;
  nonRecursive?: boolean;
  /**
   * Position of this read on the transaction's activity clock — a single
   * per-transaction monotonic counter shared with write attempts
   * ({@link IWriteAttempt}), stamped at record time by the storage
   * transaction. Gives the read|write interleaving order without a journal
   * scan (V2 journals do not support `activity()`). Consumed by the CFC
   * write-prefix provenance gate and bound into the prepared digest
   * (docs/specs/cfc-write-prefix-provenance.md §6). Optional only for
   * backends that predate the clock; absent means "order unknown" and CFC
   * treats the read as preceding every write (conservative).
   */
  journalIndex?: number;
}

/**
 * One applied write attempt, in transaction order. `path` is the RAW storage
 * path as written (`["value", ...]` for user data, `["cfc"]`/`["source"]`
 * for runtime surfaces, `[]` for whole-envelope writes) — deliberately not
 * canonicalized, so surface distinctions survive. Value-equal writes that
 * the storage layer elides entirely (no write details, no reactivity) do
 * not appear here either: the log records exactly the write set the rest of
 * the transaction inspection surface sees. `journalIndex` is the shared
 * activity clock (see {@link IReadActivity.journalIndex}).
 */
export interface IWriteAttempt extends IMemorySpaceAddress {
  journalIndex: number;
}

/**
 * Error is returned on an attempt to open writer in a transaction that already
 * has a writer for a different space.
 */
export interface IStorageTransactionWriteIsolationError extends IStorageError {
  readonly name: "StorageTransactionWriteIsolationError";

  /**
   * Memory space writer that is already open.
   */
  readonly open: MemorySpace;

  /**
   * Memory space writer could not be opened for.
   */
  readonly requested: MemorySpace;
}

/**
 * Error returned when attempting to write to a read-only address (data: URI).
 */
export interface IReadOnlyAddressError extends IStorageError {
  readonly name: "ReadOnlyAddressError";

  /**
   * The read-only address that was attempted to be written to.
   */
  readonly address: IMemoryAddress;

  from(space: MemorySpace): IReadOnlyAddressError;
}

/**
 * Error returned when attempting to access a property on a non-object value.
 * This is different from NotFound (document doesn't exist) and Inconsistency
 * (state changed). This error indicates a type mismatch that would persist
 * even if the transaction were retried.
 */
export interface ITypeMismatchError extends IStorageError {
  readonly name: "TypeMismatchError";

  /**
   * The address being accessed.
   */
  readonly address: IMemoryAddress;

  /**
   * The actual type encountered.
   */
  readonly actualType: string;

  from(space: MemorySpace): ITypeMismatchError;
}

/**
 * Describes either observed or desired state of the memory at a specific
 * address.
 */
export interface IAttestation {
  readonly address: IMemoryAddress;
  readonly value?: Immutable<FabricValue>;
}

// An IAttestation where the address is an IMemorySpaceAddress
export interface IMemorySpaceAttestation {
  readonly address: IMemorySpaceAddress;
  readonly value?: Immutable<FabricValue>;
}

// Re-export transaction wrapper utilities from implementation
export {
  createChildCellTransaction,
  createNonReactiveTransaction,
  TransactionWrapper,
} from "./extended-storage-transaction.ts";

export const createReadOnlyTransactionError = (
  method: string,
  source = "runtime.readTx()",
): Error => {
  const error = new Error(
    `Cannot call ${method} on a read-only transaction returned by ${source}; ` +
      "use runtime.edit() to create an owned writable transaction.",
  );
  error.name = "ReadOnlyTransactionError";
  return error;
};

/**
 * Converts an IStorageError to a throwable Error instance.
 * Use this when you need to actually throw a storage error.
 */
export const toThrowable = (error: IStorageError): Error => {
  const throwable = new Error(error.message);
  throwable.name = error.name;
  // Copy all enumerable properties from the storage error
  Object.assign(throwable, error);
  return throwable;
};
