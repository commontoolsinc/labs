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
import type { UserOperation } from "@commontools/memory/v2/consumer";
import type {
  FactSet,
  JSONValue,
  Selector,
} from "@commontools/memory/v2/types";
import type {
  InvocationId,
  SubscriptionUpdate,
} from "@commontools/memory/v2/protocol";
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
 * v2 Replica implementing ISpaceReplica.
 *
 * Wraps a v2 ConsumerSession to provide get/commit for the runner.
 * The `the` dimension is always "application/json".
 */
class ReplicaV2 implements ISpaceReplica {
  private spaceId: MemorySpace;
  private consumer: ConsumerSession;
  private subscribers = new Map<
    string,
    Set<(revision?: Revision<State>) => void>
  >();
  private localState = new Map<string, Revision<State>>();
  private subscriptionIds = new Map<string, InvocationId>();

  constructor(
    spaceId: MemorySpace,
    consumer: ConsumerSession,
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

    try {
      const commit = this.consumer.transact(operations);

      // Update local state with committed values
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

        this.localState.set(entityId, state);
        this.notifySubscribers(entityId, state);
      }

      // Notify the storage subscription
      this.subscription.next({
        type: "commit",
        space: this.spaceId,
        changes: [],
        source: _source,
      });

      return Promise.resolve({ ok: {} as Unit });
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
    for (const revision of update.revisions) {
      const entityId = revision.fact.id;
      const value = revision.fact.type === "set"
        ? (revision.fact as { value?: JSONValue }).value
        : undefined;

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
      this.notifySubscribers(entityId, state);
    }

    this.subscription.next({
      type: "integrate",
      space: this.spaceId,
      changes: [],
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
 * Wraps a v2 SpaceV2 + ProviderSession + ConsumerSession to present
 * the v1 IStorageProvider interface used by the runner.
 */
export class ProviderV2 implements IStorageProviderWithReplica {
  readonly replica: ReplicaV2;
  private space: SpaceV2;
  private providerSession: ProviderSession;
  private consumer: ConsumerSession;
  private subscribers = new Map<
    string,
    Set<(value: StorageValue<StorableDatum>) => void>
  >();

  constructor(options: {
    spaceId: MemorySpace;
    space: SpaceV2;
    subscription: IStorageSubscription;
  }) {
    this.space = options.space;
    this.providerSession = new ProviderSession(this.space);
    this.consumer = connectLocal(this.providerSession);
    this.replica = new ReplicaV2(
      options.spaceId,
      this.consumer,
      options.subscription,
    );
  }

  /**
   * Factory: create a v2 provider for a space.
   */
  static open(options: {
    spaceId: MemorySpace;
    subscription: IStorageSubscription;
  }): ProviderV2 {
    const space = SpaceV2.open({ url: new URL("memory:v2") });
    return new ProviderV2({
      ...options,
      space,
    });
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
        operations.push({
          op: "set",
          id: uri,
          value: {
            value: value.value,
            source: value.source,
          } as unknown as JSONValue,
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

    try {
      const commit = this.consumer.transact(operations);

      // Update replica local state with committed values so get() works
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

      return Promise.resolve({ ok: {} as Unit });
    } catch (err) {
      return Promise.resolve({ error: err as Error });
    }
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
    this.consumer.close();
    this.providerSession.close();
    this.space.close();
    return Promise.resolve();
  }

  /**
   * Get the replica identifier.
   */
  getReplica(): string {
    return this.replica.did();
  }
}
