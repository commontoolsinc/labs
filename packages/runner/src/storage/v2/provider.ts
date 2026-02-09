/**
 * Memory v2 Storage Provider for Runner
 *
 * Wraps a v2 ConsumerSession to present the v1 IStorageProvider interface.
 * This is the feature-flag boundary: when memoryVersion === "v2",
 * StorageManager.connect() creates one of these instead of a v1 Provider.
 *
 * Key adaptation: v1 uses `{id, type}` (entity + MIME) as the address key.
 * v2 drops the MIME dimension — we fix it to "application/json".
 */

import type {
  Fact,
  MemorySpace,
  Revision,
  SchemaPathSelector,
  State,
} from "@commontools/memory/interface";
import type { Cancel } from "@commontools/runner";
import type {
  ChangeGroup,
  IMemoryChange,
  IMergedChanges,
  ISpaceReplica,
  IStorageNotificationSink,
  IStorageProviderWithReplica,
  IStorageTransaction,
  ITransaction,
  OptStorageValue,
  StorageValue,
  URI,
} from "../interface.ts";
import type {
  StorableDatum,
  StorableValue,
} from "@commontools/memory/interface";
import type { Result, Unit } from "@commontools/memory/interface";
// SpaceV2, ProviderSession, and connectLocal are only needed for the
// in-process emulation path (ProviderV2.open). They import @db/sqlite
// which is Deno-only. Use dynamic import to avoid pulling them into
// browser bundles (worker-runtime.js).
// Type-only imports are safe — they're erased at compile time.
import type { SpaceV2 } from "@commontools/memory/v2/space";
import type { ProviderSession } from "@commontools/memory/v2/provider";
import type { ConsumerSession } from "@commontools/memory/v2/consumer";
import type {
  ConsumerTransactResult,
  SubscriptionCallback,
  UserOperation,
} from "@commontools/memory/v2/consumer";
import type {
  FactSet,
  JSONValue,
  Selector,
} from "@commontools/memory/v2/types";
import type {
  InvocationId,
  SubscriptionUpdate,
} from "@commontools/memory/v2/protocol";
import { connectRemote, RemoteConsumer } from "@commontools/memory/v2/remote";
import {
  BaseMemoryAddress,
  ManagedStorageTransaction,
  MapSet,
  type ObjectStorageManager,
  SchemaObjectTraverser,
} from "../../traverse.ts";
import type {
  IAttestation,
  IExtendedStorageTransaction,
  IMemorySpaceAddress,
  IReadOptions,
  StorageTransactionStatus,
} from "../interface.ts";
import { deepEqual } from "@commontools/utils/deep-equal";
import {
  fromJSON,
  fromString,
  is as isV1Reference,
} from "@commontools/memory/reference";

/**
 * The fixed MIME type used for v2 provider.
 * v2 drops the `the` dimension; we use a constant for v1 compatibility.
 */
const V2_MIME = "application/json" as const;

/**
 * Ensure a v2 hash (which may be a string from SQLite or a View from
 * hashFact) is a proper v1 Reference object (merkle-reference View).
 * The v1 transaction layer uses `"/" in cause` which requires an object.
 */
function toV1Cause(hash: unknown): State["cause"] {
  if (hash == null) return undefined;
  if (isV1Reference(hash)) return hash as State["cause"];
  // Handle JSON-deserialized reference objects ({"/": "baedrei..."})
  // that lost their branded View type during wire transport.
  if (typeof hash === "object" && hash !== null && "/" in hash) {
    return fromJSON(
      hash as { "/": string },
    ) as unknown as State["cause"];
  }
  return fromString(String(hash)) as unknown as State["cause"];
}

/**
 * Build an IMemoryChange for an entity, comparing before and after values.
 */
function makeChange(
  entityId: string,
  before: StorableDatum | undefined,
  after: StorableDatum | undefined,
): IMemoryChange {
  return {
    address: { id: entityId as URI, type: V2_MIME, path: [] },
    before,
    after,
  };
}

/**
 * Wrap an array of IMemoryChange as IMergedChanges (iterable).
 */
function asChanges(items: IMemoryChange[]): IMergedChanges {
  return {
    [Symbol.iterator]() {
      return items[Symbol.iterator]();
    },
  };
}

/**
 * Read-only ObjectStorageManager backed by v2 localState.
 * Provides the `load()` method that SchemaObjectTraverser needs
 * to resolve entity references during traversal.
 */
class V2ObjectStorageManager implements ObjectStorageManager {
  constructor(
    private spaceId: MemorySpace,
    private localState: Map<string, Revision<State>>,
  ) {}

  load(address: BaseMemoryAddress): IAttestation | null {
    const state = this.localState.get(address.id);
    if (!state || state.is === undefined) return null;
    return {
      address: {
        space: this.spaceId,
        id: address.id,
        type: address.type,
        path: [],
      } as IMemorySpaceAddress,
      value: { value: state.is },
    };
  }
}

/**
 * Read-only IExtendedStorageTransaction adapter for v2 localState.
 * Used by SchemaObjectTraverser to read entity data during traversal.
 */
class V2ReadOnlyTransaction implements IExtendedStorageTransaction {
  tx: IStorageTransaction;
  private managed: ManagedStorageTransaction;

  constructor(manager: V2ObjectStorageManager) {
    this.managed = new ManagedStorageTransaction(manager);
    this.tx = this.managed;
  }

  get changeGroup() {
    return undefined;
  }
  set changeGroup(_: ChangeGroup | undefined) {
    // Read-only — ignore
  }
  get journal() {
    return this.managed.journal;
  }

  read(address: IMemorySpaceAddress, options?: IReadOptions) {
    return this.managed.read(address, options);
  }
  status(): StorageTransactionStatus {
    return this.managed.status();
  }

  readOrThrow(
    address: IMemorySpaceAddress,
    _options?: IReadOptions,
  ): StorableValue {
    const result = this.managed.read(address);
    if ("error" in result && result.error) {
      if (result.error.name === "NotFoundError") return undefined;
      throw new Error(result.error.message);
    }
    return result.ok.value;
  }

  readValueOrThrow(
    address: IMemorySpaceAddress,
    options?: IReadOptions,
  ): StorableValue {
    return this.readOrThrow(
      { ...address, path: ["value", ...address.path] },
      options,
    );
  }

  addCommitCallback() {}
  writer(_space: MemorySpace): never {
    throw new Error("Read-only");
  }
  write(
    _address: IMemorySpaceAddress,
    _value?: StorableDatum,
  ): never {
    throw new Error("Read-only");
  }
  writeOrThrow(_address: IMemorySpaceAddress, _value: StorableValue): never {
    throw new Error("Read-only");
  }
  writeValueOrThrow(
    _address: IMemorySpaceAddress,
    _value: StorableValue,
  ): never {
    throw new Error("Read-only");
  }
  reader(
    _space: MemorySpace,
  ): never {
    throw new Error("Read-only");
  }
  abort(_reason?: unknown): never {
    throw new Error("Read-only");
  }
  commit(): never {
    throw new Error("Read-only");
  }
}

/**
 * Shared consumer interface used by ReplicaV2.
 * Both ConsumerSession (local) and RemoteConsumer (WebSocket) implement this.
 */
interface ConsumerLike {
  transact(
    userOps: UserOperation[],
    options?: { branch?: string },
  ): ConsumerTransactResult;
  query(
    select: Selector,
    options?: { since?: number; branch?: string },
  ): FactSet;
  subscribe(
    select: Selector,
    callback: SubscriptionCallback,
    options?: { since?: number; branch?: string },
  ): {
    facts: FactSet;
    subscriptionId: InvocationId;
    ready?: Promise<FactSet | undefined>;
  };
  unsubscribe(subscriptionId: InvocationId): void;
  getConfirmed(
    entityId: string,
    branch?: string,
  ): ReturnType<ConsumerSession["getConfirmed"]>;
  close(): void;
}

/**
 * v2 Replica implementing ISpaceReplica.
 *
 * Wraps a v2 ConsumerSession (or RemoteConsumer) to provide get/commit for the runner.
 * The `the` dimension is always "application/json".
 */
class ReplicaV2 implements ISpaceReplica {
  private spaceId: MemorySpace;
  private consumer: ConsumerLike;
  private subscribers = new Map<
    string,
    Set<(revision?: Revision<State>) => void>
  >();
  private localState = new Map<string, Revision<State>>();
  private subscriptionIds = new Set<string>();
  private rootSelectors = new Map<string, SchemaPathSelector>();
  private activeSubscriptionId: InvocationId | null = null;
  private pendingNewEntityIds = new Set<string>();
  private flushScheduled = false;
  private pendingReady: Promise<void>[] = [];
  suppressSubscriptionUpdates = false;

  constructor(
    spaceId: MemorySpace,
    consumer: ConsumerLike,
    private notifications: IStorageNotificationSink,
  ) {
    this.spaceId = spaceId;
    this.consumer = consumer;
  }

  did(): MemorySpace {
    return this.spaceId;
  }

  /**
   * Read state for an entity from the local cache.
   * v1 addresses have {id, type} — we ignore type (it's always application/json in v2).
   */
  get(entry: BaseMemoryAddress): State | undefined {
    const state = this.localState.get(entry.id);
    if (state) {
      const { since: _since, ...rest } = state;
      return rest as State;
    }
    return undefined;
  }

  /**
   * Commit a transaction.
   * Converts v1 ITransaction (with claims/facts using `the`/`of`/`is`) to
   * v2 operations (set/delete with `id`/`value`).
   */
  commit(
    transaction: ITransaction,
    _source?: IStorageTransaction,
  ): Promise<
    Result<Unit, import("../interface.ts").StorageTransactionRejected>
  > {
    const operations: UserOperation[] = [];

    for (const fact of transaction.facts) {
      const entityId = fact.of as string;
      if (fact.is !== undefined) {
        // Assertion → set operation
        operations.push({
          op: "set",
          id: entityId,
          value: fact.is as JSONValue,
        });
      } else if (fact.cause !== undefined) {
        // Retraction → delete operation
        operations.push({
          op: "delete",
          id: entityId,
        });
      }
    }

    // Also handle claims (read-only locks)
    for (const claim of transaction.claims) {
      operations.push({
        op: "claim",
        id: claim.of as string,
      });
    }

    if (operations.length === 0) {
      return Promise.resolve({ ok: {} as Unit });
    }

    let result: ConsumerTransactResult;
    try {
      // Suppress subscription updates during our own commit to prevent
      // double-notification. The v2 subscription system fires updates
      // synchronously during transact(), but we handle state updates
      // ourselves and fire the commit notification with proper source/changeGroup.
      this.suppressSubscriptionUpdates = true;
      try {
        result = this.consumer.transact(operations);
      } finally {
        this.suppressSubscriptionUpdates = false;
      }
    } catch (err) {
      const error = err as Error;
      if (error.name === "ConflictError") {
        return Promise.resolve({
          error: {
            name: "ConflictError" as const,
            message: error.message,
          } as import("../interface.ts").StorageTransactionRejected,
        });
      }
      return Promise.resolve({
        error: {
          name: "TransactionError" as const,
          message: error.message,
        } as import("../interface.ts").StorageTransactionRejected,
      });
    }

    // Synchronously compute changes and update local state
    const { commit } = result;
    const changes: IMemoryChange[] = [];
    for (const storedFact of commit.facts) {
      const entityId = storedFact.fact.id;
      const before = this.localState.get(entityId)?.is as
        | StorableDatum
        | undefined;
      const after = storedFact.fact.type === "delete"
        ? undefined
        : (storedFact.fact as { value?: JSONValue }).value as StorableDatum;

      const state = (storedFact.fact.type === "delete"
        ? {
          the: V2_MIME,
          of: entityId as URI,
          cause: toV1Cause(storedFact.hash),
          since: commit.version,
        }
        : {
          the: V2_MIME,
          of: entityId as URI,
          is: after,
          cause: toV1Cause(storedFact.hash),
          since: commit.version,
        }) as Revision<Fact>;

      this.localState.set(entityId, state);
      changes.push(makeChange(entityId, before, after));
      this.notifySubscribers(entityId, state);
    }

    // Notify the storage subscription with actual changes
    this.notifications.next({
      type: "commit",
      space: this.spaceId,
      changes: asChanges(changes),
      source: _source,
    });

    // Return the confirmation promise (not the local commit).
    // For local: resolves immediately. For remote: resolves on server ack.
    return result.confirmed.then(() => ({ ok: {} as Unit }));
  }

  /**
   * Subscribe to changes for an entity address.
   */
  subscribe(
    entry: BaseMemoryAddress,
    subscriber: (revision?: Revision<State>) => void,
  ): void {
    const key = entry.id;
    if (!this.subscribers.has(key)) {
      this.subscribers.set(key, new Set());
    }
    this.subscribers.get(key)!.add(subscriber);
  }

  /**
   * Unsubscribe from changes for an entity address.
   */
  unsubscribe(
    entry: BaseMemoryAddress,
    subscriber: (revision?: Revision<State>) => void,
  ): void {
    const key = entry.id;
    const subs = this.subscribers.get(key);
    if (subs) {
      subs.delete(subscriber);
      if (subs.size === 0) {
        this.subscribers.delete(key);
      }
    }
  }

  /**
   * Load entities from the v2 store.
   * Queries the consumer and populates local state.
   */
  load(
    entries: [BaseMemoryAddress, SchemaPathSelector?][],
  ): Promise<Result<Unit, Error>> {
    const selector: Record<string, Record<string, never>> = {};
    for (const [entry] of entries) {
      selector[entry.id] = {};
    }

    try {
      const facts = this.consumer.query(selector as unknown as Selector);
      this.applyFactSet(facts);
      return Promise.resolve({ ok: {} as Unit });
    } catch (err) {
      return Promise.resolve({ error: err as Error });
    }
  }

  /**
   * Set up a v2 subscription for an entity and start receiving updates.
   *
   * Uses schema-based traversal to discover linked entities (like v1's
   * SchemaObjectTraverser), then subscribes to all discovered entities
   * using a single consolidated subscription. New entities discovered
   * after data arrives trigger subscription expansion.
   */
  setupSubscription(entityId: string, selector?: SchemaPathSelector): void {
    // Store root selector if this is a root entity from sync()
    if (selector) {
      this.rootSelectors.set(entityId, selector);
    }

    if (this.subscriptionIds.has(entityId)) return;

    this.pendingNewEntityIds.add(entityId);
    this.scheduleFlush();
  }

  /**
   * Schedule a microtask to batch subscription creation.
   * Multiple setupSubscription() calls in the same tick get consolidated.
   */
  private scheduleFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    queueMicrotask(() => {
      this.flushScheduled = false;
      this.flushSubscription();
    });
  }

  /**
   * Create/recreate the consolidated subscription with all tracked entity IDs.
   * After initial data arrives, runs traversal to discover linked entities
   * and expands the subscription if new ones are found.
   */
  private flushSubscription(): void {
    // Collect all entity IDs to subscribe to
    const newIds = [...this.pendingNewEntityIds];
    this.pendingNewEntityIds.clear();
    if (newIds.length === 0) return;

    // Mark them all as subscribed
    for (const id of newIds) {
      this.subscriptionIds.add(id);
    }

    // Unsubscribe old consolidated subscription
    if (this.activeSubscriptionId) {
      this.consumer.unsubscribe(this.activeSubscriptionId);
      this.activeSubscriptionId = null;
    }

    // Build selector for all tracked entities
    const selector: Record<string, Record<string, never>> = {};
    for (const id of this.subscriptionIds) {
      selector[id] = {};
    }

    const { facts, subscriptionId, ready } = this.consumer.subscribe(
      selector as unknown as Selector,
      (update: SubscriptionUpdate) => {
        this.handleSubscriptionUpdate(update);
      },
    );

    this.activeSubscriptionId = subscriptionId;
    this.applyFactSet(facts);

    // After initial data, run traversal to discover linked entities
    this.expandViaTraversal();

    // For remote consumers: apply server initial state when it arrives
    if (ready) {
      this.pendingReady.push(
        ready.then((serverFacts) => {
          if (serverFacts) {
            this.applyFactSet(serverFacts);
            // Re-run traversal after server data arrives
            this.expandViaTraversal();
          }
        }),
      );
    }
  }

  /**
   * Run SchemaObjectTraverser over localState for all root selectors.
   * If new entities are discovered, add them to pending and schedule a flush.
   */
  private expandViaTraversal(): void {
    const discovered = this.discoverLinkedEntities();
    if (discovered.size > 0) {
      for (const id of discovered) {
        this.pendingNewEntityIds.add(id);
      }
      this.scheduleFlush();
    }
  }

  /**
   * Run SchemaObjectTraverser over localState for all root selectors.
   * Returns entity IDs discovered that are not yet subscribed.
   */
  private discoverLinkedEntities(): Set<string> {
    const manager = new V2ObjectStorageManager(this.spaceId, this.localState);
    const tx = new V2ReadOnlyTransaction(manager);
    const discovered = new Set<string>();

    const prefix = `${this.spaceId}/`;
    const suffix = `/${V2_MIME}`;

    for (const [rootEntityId, selector] of this.rootSelectors) {
      const schemaTracker = new MapSet<string, SchemaPathSelector>(deepEqual);

      // Re-root selector to include "value" prefix, matching v1 convention
      // where data is stored as { value: actualData }. The selector from
      // sync() uses cell.path which may be [] or ["value", ...] depending
      // on the cell. SchemaObjectTraverser expects paths starting with "value".
      const selectorPath = selector.path.length > 0 &&
          selector.path[0] === "value"
        ? selector.path
        : ["value", ...selector.path];
      const rerooted = { ...selector, path: selectorPath };

      const traverser = new SchemaObjectTraverser(
        tx,
        rerooted,
        undefined,
        schemaTracker,
      );

      // Build attestation for root entity from localState.
      // Use path: [] and wrap value as { value: actualData } to match v1
      // storage envelope. The traverser navigates from path [] through
      // the selector path (starting with "value") into the actual data.
      const rootState = this.localState.get(rootEntityId);
      if (!rootState || rootState.is === undefined) continue;
      const rootDoc = {
        address: {
          space: this.spaceId,
          id: rootEntityId,
          type: V2_MIME,
          path: [] as string[],
        } as IMemorySpaceAddress,
        value: { value: rootState.is },
      };

      // Traverse — this populates schemaTracker with all linked entities
      try {
        traverser.traverse(rootDoc);
      } catch {
        // Traversal can fail if schemas/data don't align (e.g. stale data).
        // Fall back gracefully — don't let traversal errors block the system.
        continue;
      }

      // Extract entity IDs from schemaTracker keys
      // getTrackerKey format: "${space}/${id}/${type}"
      for (const [key] of schemaTracker) {
        if (key.startsWith(prefix) && key.endsWith(suffix)) {
          const entityId = key.slice(prefix.length, key.length - suffix.length);
          if (entityId && !this.subscriptionIds.has(entityId)) {
            discovered.add(entityId);
          }
        }
      }
    }
    return discovered;
  }

  /**
   * Apply a FactSet from query/subscribe to local state.
   * When called with actual data (e.g. from server initial state),
   * fires notifications.next() so the scheduler re-runs affected computations.
   */
  private applyFactSet(facts: FactSet): void {
    const changes: IMemoryChange[] = [];

    for (const [entityId, entry] of Object.entries(facts)) {
      const before = this.localState.get(entityId)?.is as
        | StorableDatum
        | undefined;
      const value = entry.value;
      const after = value as StorableDatum | undefined;

      const state = (value !== undefined
        ? {
          the: V2_MIME,
          of: entityId as URI,
          is: value as StorableDatum,
          cause: toV1Cause(entry.hash),
          since: entry.version,
        }
        : {
          the: V2_MIME,
          of: entityId as URI,
          cause: toV1Cause(entry.hash),
          since: entry.version,
        }) as Revision<Fact>;

      this.localState.set(entityId, state);
      changes.push(makeChange(entityId, before, after));
      this.notifySubscribers(entityId, state);
    }

    // Notify the scheduler so it re-runs affected computations.
    // Without this, data arriving from the server after a non-awaited
    // cell.sync() would silently update localState but never trigger
    // re-rendering.
    if (changes.length > 0) {
      this.notifications.next({
        type: "integrate",
        space: this.spaceId,
        changes: asChanges(changes),
      });
    }
  }

  /**
   * Handle incremental subscription updates.
   */
  private handleSubscriptionUpdate(update: SubscriptionUpdate): void {
    // Skip if we're processing our own commit — we handle state updates
    // and notifications in commit() itself with proper source/changeGroup.
    if (this.suppressSubscriptionUpdates) return;

    const changes: IMemoryChange[] = [];

    for (const revision of update.revisions) {
      const entityId = revision.fact.id;
      const before = this.localState.get(entityId)?.is as
        | StorableDatum
        | undefined;
      const value = revision.fact.type === "set"
        ? (revision.fact as { value?: JSONValue }).value
        : undefined;
      const after = value as StorableDatum | undefined;

      const state = (value !== undefined
        ? {
          the: V2_MIME,
          of: entityId as URI,
          is: value as StorableDatum,
          cause: toV1Cause(revision.hash),
          since: update.commit.version,
        }
        : {
          the: V2_MIME,
          of: entityId as URI,
          cause: toV1Cause(revision.hash),
          since: update.commit.version,
        }) as Revision<Fact>;

      this.localState.set(entityId, state);
      changes.push(makeChange(entityId, before, after));
      this.notifySubscribers(entityId, state);
    }

    this.notifications.next({
      type: "integrate",
      space: this.spaceId,
      changes: asChanges(changes),
    });

    // After integrating external changes, check if new entities need subscribing
    this.expandViaTraversal();
  }

  /**
   * Notify subscribers of state changes.
   */
  private notifySubscribers(entityId: string, state: Revision<State>): void {
    const subs = this.subscribers.get(entityId);
    if (subs) {
      for (const sub of subs) {
        sub(state);
      }
    }
  }

  /**
   * Update local state for an entity. Used by ProviderV2.send() to keep
   * the replica in sync after direct transact calls.
   */
  updateLocalState(entityId: string, state: Revision<State>): void {
    this.localState.set(entityId, state);
    this.notifySubscribers(entityId, state);
  }

  /**
   * Wait for all pending server state loads to complete.
   * Loops to handle cascading subscriptions from traversal expansion.
   */
  async synced(): Promise<void> {
    while (this.pendingReady.length > 0) {
      const batch = [...this.pendingReady];
      this.pendingReady = [];
      await Promise.all(batch);
    }
  }

  /**
   * Resets the replica's internal state for reconnection scenarios.
   * Preserves subscribers but clears all cached state.
   */
  reset(): void {
    // Save subscribers
    const savedSubscribers = new Map(this.subscribers);
    // Clear all state
    this.localState.clear();
    this.subscriptionIds.clear();
    this.rootSelectors.clear();
    this.activeSubscriptionId = null;
    this.pendingNewEntityIds.clear();
    this.flushScheduled = false;
    // Restore subscribers
    this.subscribers = savedSubscribers;

    this.notifications.next({
      type: "reset",
      space: this.spaceId,
    });
  }

  /**
   * Clean up all subscriptions.
   */
  close(): void {
    if (this.activeSubscriptionId) {
      this.consumer.unsubscribe(this.activeSubscriptionId);
      this.activeSubscriptionId = null;
    }
    this.subscriptionIds.clear();
    this.rootSelectors.clear();
    this.pendingNewEntityIds.clear();
    this.subscribers.clear();
    this.localState.clear();
  }
}

/**
 * v2 Storage Provider implementing IStorageProviderWithReplica.
 *
 * Wraps a v2 consumer (local or remote) to present the v1
 * IStorageProvider interface used by the runner.
 */
export class ProviderV2 implements IStorageProviderWithReplica {
  readonly replica: ReplicaV2;
  private consumer: ConsumerLike;
  /** Local-only resources (null for remote mode) */
  private space: SpaceV2 | null;
  private providerSession: ProviderSession | null;
  /** Remote consumer (null for local mode), kept for destroy() */
  private remoteConsumer: RemoteConsumer | null;
  private subscribers = new Map<
    string,
    Set<(value: StorageValue<StorableDatum>) => void>
  >();

  constructor(options: {
    spaceId: MemorySpace;
    consumer: ConsumerLike;
    subscription: IStorageNotificationSink;
    space?: SpaceV2 | null;
    providerSession?: ProviderSession | null;
    remoteConsumer?: RemoteConsumer | null;
  }) {
    this.consumer = options.consumer;
    this.space = options.space ?? null;
    this.providerSession = options.providerSession ?? null;
    this.remoteConsumer = options.remoteConsumer ?? null;
    this.replica = new ReplicaV2(
      options.spaceId,
      this.consumer,
      options.subscription,
    );
  }

  /**
   * Factory: create a local (in-process) v2 provider for a space.
   *
   * Only callable from Deno (requires SQLite). Browser code should
   * use ProviderV2.connectRemote() instead.
   *
   * Takes pre-created consumer + space to avoid importing @db/sqlite
   * at the module level (which would break browser bundles).
   */
  static open(options: {
    spaceId: MemorySpace;
    consumer: ConsumerLike;
    subscription: IStorageNotificationSink;
    space?: SpaceV2 | null;
    providerSession?: ProviderSession | null;
  }): ProviderV2 {
    return new ProviderV2(options);
  }

  /**
   * Factory: create a remote (WebSocket) v2 provider for a space.
   */
  static connectRemote(options: {
    spaceId: MemorySpace;
    wsUrl: URL;
    subscription: IStorageNotificationSink;
    connectionTimeout?: number;
  }): ProviderV2 {
    const remoteConsumer = connectRemote(options.wsUrl, {
      connectionTimeout: options.connectionTimeout,
    });

    const provider = new ProviderV2({
      spaceId: options.spaceId,
      consumer: remoteConsumer,
      subscription: options.subscription,
      remoteConsumer,
    });

    // Wire reconnection: reset replica state and re-subscribe
    remoteConsumer.connection.onReconnect = () => {
      provider.replica.reset();
    };

    return provider;
  }

  /**
   * Send values to storage.
   * Converts v1 batch format to v2 operations.
   */
  send<T extends StorableValue = StorableValue>(
    batch: { uri: URI; value: StorageValue<T> }[],
  ): Promise<Result<Unit, Error>> {
    const operations: UserOperation[] = [];

    for (const { uri, value } of batch) {
      if (value.value !== undefined) {
        // JSON roundtrip to strip undefined values (same as v1 Provider.send).
        // merkle-reference's refer() cannot handle undefined.
        const content = JSON.parse(
          JSON.stringify({ value: value.value, source: value.source }),
        ) as JSONValue;
        operations.push({
          op: "set",
          id: uri,
          value: content,
        });
      } else {
        operations.push({
          op: "delete",
          id: uri,
        });
      }
    }

    if (operations.length === 0) {
      return Promise.resolve({ ok: {} as Unit });
    }

    let result: ConsumerTransactResult;
    try {
      result = this.consumer.transact(operations);
    } catch (err) {
      return Promise.resolve({ error: err as Error });
    }

    // Synchronously update replica local state so get() works
    const { commit } = result;
    for (const storedFact of commit.facts) {
      const entityId = storedFact.fact.id;
      const state = (storedFact.fact.type === "delete"
        ? {
          the: V2_MIME,
          of: entityId as URI,
          cause: toV1Cause(storedFact.hash),
          since: commit.version,
        }
        : {
          the: V2_MIME,
          of: entityId as URI,
          is: (storedFact.fact as { value?: JSONValue })
            .value as StorableDatum,
          cause: toV1Cause(storedFact.hash),
          since: commit.version,
        }) as Revision<Fact>;

      this.replica.updateLocalState(entityId, state);
    }

    // Return the confirmation promise.
    // For local: resolves immediately. For remote: resolves on server ack.
    return result.confirmed.then(() => ({ ok: {} as Unit }));
  }

  /**
   * Sync an entity from storage.
   * For remote mode, waits for the server's initial state to arrive.
   */
  async sync(
    uri: URI,
    selector?: SchemaPathSelector,
  ): Promise<Result<Unit, Error>> {
    const address = { id: uri, type: V2_MIME } as BaseMemoryAddress;
    const result = await this.replica.load([[address, selector]]);
    if ("error" in result) {
      return result;
    }

    // Set up a subscription for future updates (pass selector for traversal)
    this.replica.setupSubscription(uri, selector);

    // Wait for server initial state (no-op for local mode)
    await this.replica.synced();

    return { ok: {} as Unit };
  }

  /**
   * Wait for all pending syncs (server state loads for remote mode).
   */
  async synced(): Promise<void> {
    await this.replica.synced();
  }

  /**
   * Get a value from the local cache.
   */
  get<T extends StorableValue = StorableValue>(
    uri: URI,
  ): OptStorageValue<T> {
    const entity = this.replica.get({
      id: uri,
      type: V2_MIME,
    } as BaseMemoryAddress);
    return entity?.is as OptStorageValue<T>;
  }

  /**
   * Subscribe to storage updates for an entity.
   */
  sink<T extends StorableValue = StorableValue>(
    uri: URI,
    callback: (value: StorageValue<T>) => void,
  ): Cancel {
    const address = { id: uri, type: V2_MIME } as BaseMemoryAddress;
    const subscriber = (revision?: Revision<State>) => {
      if (revision && revision.since !== -1) {
        callback((revision?.is ?? {}) as unknown as StorageValue<T>);
      }
    };

    this.replica.subscribe(address, subscriber);
    this.replica.setupSubscription(uri);

    return () => this.replica.unsubscribe(address, subscriber);
  }

  /**
   * Destroy the provider.
   */
  destroy(): Promise<void> {
    this.replica.close();
    if (this.remoteConsumer) {
      // Remote mode: RemoteConsumer.close() tears down connection, local shadow, etc.
      this.remoteConsumer.close();
    } else {
      // Local mode: close consumer, provider session, and space
      this.consumer.close();
      this.providerSession?.close();
      this.space?.close();
    }
    return Promise.resolve();
  }

  /**
   * Get the replica identifier.
   */
  getReplica(): string {
    return this.replica.did();
  }
}
