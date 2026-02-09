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
  IMemoryChange,
  IMergedChanges,
  ISpaceReplica,
  IStorageProviderWithReplica,
  IStorageSubscription,
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
import { SpaceV2 } from "@commontools/memory/v2/space";
import { ProviderSession } from "@commontools/memory/v2/provider";
import { connectLocal, ConsumerSession } from "@commontools/memory/v2/consumer";
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
import { BaseMemoryAddress } from "../../traverse.ts";
import { fromString, is as isV1Reference } from "@commontools/memory/reference";

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
  ): { facts: FactSet; subscriptionId: InvocationId };
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
  private subscriptionIds = new Map<string, InvocationId>();
  suppressSubscriptionUpdates = false;

  constructor(
    spaceId: MemorySpace,
    consumer: ConsumerLike,
    private subscription: IStorageSubscription,
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
    this.subscription.next({
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
   */
  setupSubscription(entityId: string): void {
    if (this.subscriptionIds.has(entityId)) return;

    const selector = { [entityId]: {} } as unknown as Selector;
    const { facts, subscriptionId } = this.consumer.subscribe(
      selector,
      (update: SubscriptionUpdate) => {
        this.handleSubscriptionUpdate(update);
      },
    );

    this.subscriptionIds.set(entityId, subscriptionId);
    this.applyFactSet(facts);
  }

  /**
   * Apply a FactSet from query/subscribe to local state.
   */
  private applyFactSet(facts: FactSet): void {
    for (const [entityId, entry] of Object.entries(facts)) {
      const state = (entry.value !== undefined
        ? {
          the: V2_MIME,
          of: entityId as URI,
          is: entry.value as StorableDatum,
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
      this.notifySubscribers(entityId, state);
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

    this.subscription.next({
      type: "integrate",
      space: this.spaceId,
      changes: asChanges(changes),
    });
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
   * Resets the replica's internal state for reconnection scenarios.
   * Preserves subscribers but clears all cached state.
   */
  reset(): void {
    // Save subscribers
    const savedSubscribers = new Map(this.subscribers);
    // Clear all state
    this.localState.clear();
    this.subscriptionIds.clear();
    // Restore subscribers
    this.subscribers = savedSubscribers;

    this.subscription.next({
      type: "reset",
      space: this.spaceId,
    });
  }

  /**
   * Clean up all subscriptions.
   */
  close(): void {
    for (const [_, subId] of this.subscriptionIds) {
      this.consumer.unsubscribe(subId);
    }
    this.subscriptionIds.clear();
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
    subscription: IStorageSubscription;
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
   */
  static open(options: {
    spaceId: MemorySpace;
    subscription: IStorageSubscription;
  }): ProviderV2 {
    const space = SpaceV2.open({ url: new URL("memory:v2") });
    const providerSession = new ProviderSession(space);
    const consumer = connectLocal(providerSession);
    return new ProviderV2({
      ...options,
      consumer,
      space,
      providerSession,
    });
  }

  /**
   * Factory: create a remote (WebSocket) v2 provider for a space.
   */
  static connectRemote(options: {
    spaceId: MemorySpace;
    wsUrl: URL;
    subscription: IStorageSubscription;
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

    // Set up a subscription for future updates
    this.replica.setupSubscription(uri);
    return { ok: {} as Unit };
  }

  /**
   * Wait for all pending syncs.
   */
  async synced(): Promise<void> {
    // v2 is synchronous for local provider — nothing to wait for
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
