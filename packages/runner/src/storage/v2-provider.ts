/**
 * V2 Provider - Client-side storage provider for the v2 memory protocol.
 *
 * Implements `IStorageProviderWithReplica` using V2Replica for state,
 * V2Consumer command builders for the wire format, and
 * V2ProviderConnection for WebSocket transport.
 *
 * This is a simplified counterpart to the v1 Provider: no IDB caching,
 * no UCAN wrapping, and entity-level (not fact-level) state management.
 *
 * @module v2-provider
 */

import { getLogger } from "@commontools/utils/logger";
import { unclaimed } from "@commontools/memory/fact";
import type {
  StorableDatum,
  StorableValue,
} from "@commontools/memory/interface";
import type {
  EntityId,
  JSONValue,
  SpaceId,
} from "@commontools/memory/v2-types";
import type { Cancel } from "../cancel.ts";
import type {
  IMemoryAddress,
  IMemoryChange,
  IMergedChanges,
  IRemoteStorageProviderSettings,
  ISpaceReplica,
  IStorageProviderWithReplica,
  IStorageSubscription,
  IStorageTransaction,
  ITransaction,
  MemorySpace,
  OptStorageValue,
  Result,
  SchemaPathSelector,
  State,
  StorageTransactionRejected,
  StorageValue,
  Unit,
  URI,
} from "./interface.ts";
import type { BaseMemoryAddress } from "../traverse.ts";
import {
  buildSubscribeCommand,
  buildTransactCommand,
  parseQueryResult,
  parseTransactResult,
  type UserOperation,
} from "./v2-consumer.ts";
import { type EntityChange, V2Replica } from "./v2-replica.ts";
import { V2ProviderConnection } from "./v2-provider-connection.ts";

const logger = getLogger("storage.v2-provider", {
  enabled: true,
  level: "error",
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default media type for v2 entities. */
const JSON_MIME = "application/json" as const;

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface V2ProviderOptions {
  /** Unique storage manager id (used for inspection). */
  id: string;

  /** Memory space DID. */
  space: MemorySpace;

  /** Base URL of the memory service. */
  address: URL;

  /** Remote storage settings (timeout, etc.). */
  settings: IRemoteStorageProviderSettings;

  /** Subscription manager that broadcasts notifications to the scheduler. */
  subscription: IStorageSubscription;
}

// ---------------------------------------------------------------------------
// V2SpaceReplica (adapter: V2Replica -> ISpaceReplica)
// ---------------------------------------------------------------------------

/**
 * Adapts a V2Replica to the ISpaceReplica interface expected by the
 * transaction layer. This enables the v1 Transaction to read from and
 * commit to v2 state.
 */
class V2SpaceReplica implements ISpaceReplica {
  readonly #replica: V2Replica;
  readonly #provider: V2Provider;

  constructor(replica: V2Replica, provider: V2Provider) {
    this.#replica = replica;
    this.#provider = provider;
  }

  did(): MemorySpace {
    return this.#replica.spaceId as MemorySpace;
  }

  /**
   * Read a value from the replica for a given base memory address.
   * Returns a v1 State compatible object, or undefined if not found.
   */
  get(entry: BaseMemoryAddress): State | undefined {
    // In v2 the entity is keyed by its id; the type is always JSON_MIME.
    const entityId = entry.id as EntityId;
    const result = this.#replica.get(entityId);

    if (!result) {
      return undefined;
    }

    if (result.value === undefined) {
      // Entity exists but has no value (deleted) -- return unclaimed.
      return unclaimed({ the: entry.type ?? JSON_MIME, of: entry.id });
    }

    // Build a v1 State (Assertion) from the v2 value.
    // The `cause` and `is` fields let the v1 transaction layer work.
    const confirmed = this.#replica.state.confirmed.get(entityId);
    if (confirmed?.value !== undefined) {
      // Build a mock v1 fact from confirmed state.
      return {
        the: entry.type ?? JSON_MIME,
        of: entry.id,
        is: confirmed.value as StorableDatum,
        cause: { toString: () => confirmed.hash } as any,
      } as unknown as State;
    }

    // Pending or unknown tier -- return with the value we have.
    return {
      the: entry.type ?? JSON_MIME,
      of: entry.id,
      is: result.value as StorableDatum,
      cause: { toString: () => "pending" } as any,
    } as unknown as State;
  }

  /**
   * Commit a v1 transaction to the v2 replica and push to the server.
   */
  commit(
    transaction: ITransaction,
    source?: IStorageTransaction,
  ): Promise<Result<Unit, StorageTransactionRejected>> {
    return this.#provider.commitTransaction(transaction, source);
  }
}

// ---------------------------------------------------------------------------
// V2MergedChanges (adapter: EntityChange[] -> IMergedChanges)
// ---------------------------------------------------------------------------

class V2MergedChanges implements IMergedChanges {
  #changes: IMemoryChange[];

  constructor(entityChanges: EntityChange[]) {
    this.#changes = entityChanges.map((ec) => ({
      address: {
        id: ec.id as URI,
        type: JSON_MIME,
        path: [],
      } as IMemoryAddress,
      before: ec.before as StorableDatum,
      after: ec.after as StorableDatum,
    }));
  }

  *[Symbol.iterator](): IterableIterator<IMemoryChange> {
    yield* this.#changes;
  }
}

// ---------------------------------------------------------------------------
// V2Provider
// ---------------------------------------------------------------------------

export class V2Provider implements IStorageProviderWithReplica {
  readonly #v2Replica: V2Replica;
  readonly #spaceReplica: V2SpaceReplica;
  readonly #subscription: IStorageSubscription;
  readonly #connection: V2ProviderConnection;
  readonly #space: MemorySpace;
  readonly #settings: IRemoteStorageProviderSettings;

  /** Per-entity subscriber callbacks. */
  readonly #subscribers = new Map<
    string,
    Set<(value: StorageValue<StorableDatum>) => void>
  >();

  /** Deferred resolvers for pending sync() calls. */
  #syncPromises: Set<Promise<unknown>> = new Set();

  /** Outstanding transact promise so synced() can wait for it. */
  #commitPromises: Set<Promise<unknown>> = new Set();

  /** Whether the initial subscription has been sent. */
  #subscribed = false;

  // -------------------------------------------------------------------------
  // Construction
  // -------------------------------------------------------------------------

  private constructor(options: V2ProviderOptions) {
    this.#space = options.space;
    this.#settings = options.settings;
    this.#subscription = options.subscription;
    this.#v2Replica = new V2Replica(options.space as SpaceId);
    this.#spaceReplica = new V2SpaceReplica(this.#v2Replica, this);

    this.#connection = new V2ProviderConnection({
      address: options.address,
      spaceId: options.space as SpaceId,
      connectionTimeout: options.settings.connectionTimeout,
      onMessage: (msg) => this.onMessage(msg),
      onOpen: () => this.onConnectionOpen(),
    });
  }

  /**
   * Create and connect a V2Provider.
   */
  static connect(
    options: V2ProviderOptions,
  ): V2Provider & IStorageProviderWithReplica {
    return new V2Provider(options);
  }

  // -------------------------------------------------------------------------
  // IStorageProviderWithReplica
  // -------------------------------------------------------------------------

  get replica(): ISpaceReplica {
    return this.#spaceReplica;
  }

  // -------------------------------------------------------------------------
  // IStorageProvider.sink
  // -------------------------------------------------------------------------

  sink<T extends StorableValue = StorableValue>(
    uri: URI,
    callback: (value: StorageValue<T>) => void,
  ): Cancel {
    const key = uri;
    let subs = this.#subscribers.get(key);
    if (!subs) {
      subs = new Set();
      this.#subscribers.set(key, subs);
    }
    subs.add(callback as (value: StorageValue<StorableDatum>) => void);

    // Deliver current value immediately if available.
    const entityId = uri as EntityId;
    const current = this.#v2Replica.get(entityId);
    if (current) {
      const sv = this.entityValueToStorageValue(current.value);
      callback(sv as StorageValue<T>);
    }

    return () => {
      const set = this.#subscribers.get(key);
      if (set) {
        set.delete(callback as (value: StorageValue<StorableDatum>) => void);
        if (set.size === 0) {
          this.#subscribers.delete(key);
        }
      }
    };
  }

  // -------------------------------------------------------------------------
  // IStorageProvider.sync
  // -------------------------------------------------------------------------

  sync(
    _uri: URI,
    _selector?: SchemaPathSelector,
  ): Promise<Result<Unit, Error>> {
    // In v2, initial sync happens via the wildcard subscription. Individual
    // entity syncs are no-ops once connected -- the subscription delivers
    // all data. We return a promise that resolves once the subscription
    // response has been integrated.
    if (!this.#subscribed) {
      // Not yet subscribed; queue a deferred promise.
      const { promise, resolve } = Promise.withResolvers<Result<Unit, Error>>();
      const wrapped = promise as Promise<unknown>;
      this.#syncPromises.add(wrapped);
      promise.finally(() => this.#syncPromises.delete(wrapped));

      // Store the resolver so onInitialData can resolve it.
      (this as any).__syncResolvers = (this as any).__syncResolvers || [];
      (this as any).__syncResolvers.push(resolve);
      return promise;
    }

    return Promise.resolve({ ok: {} });
  }

  // -------------------------------------------------------------------------
  // IStorageProvider.synced
  // -------------------------------------------------------------------------

  async synced(): Promise<void> {
    await Promise.all([
      ...this.#syncPromises,
      ...this.#commitPromises,
    ]);
  }

  // -------------------------------------------------------------------------
  // IStorageProvider.get
  // -------------------------------------------------------------------------

  get<T extends StorableValue = StorableValue>(
    uri: URI,
  ): OptStorageValue<T> {
    const entityId = uri as EntityId;
    const result = this.#v2Replica.get(entityId);

    if (!result) return undefined;

    return this.entityValueToStorageValue(result.value) as OptStorageValue<T>;
  }

  // -------------------------------------------------------------------------
  // IStorageProvider.send
  // -------------------------------------------------------------------------

  send<T extends StorableValue = StorableValue>(
    batch: { uri: URI; value: StorageValue<T> }[],
  ): Promise<Result<Unit, Error>> {
    if (batch.length === 0) return Promise.resolve({ ok: {} });

    // Convert the v1 batch to v2 operations.
    const operations: UserOperation[] = [];
    const reads = { confirmed: [] as any[], pending: [] as any[] };

    for (const { uri, value } of batch) {
      const entityId = uri as EntityId;

      if (value.value !== undefined) {
        // Build the entity document value: { value, source? }
        const entityDoc: Record<string, unknown> = {
          value: (value.value as any)?.value ?? value.value,
        };
        if ((value.value as any)?.source !== undefined) {
          entityDoc.source = (value.value as any).source;
        }

        operations.push({
          op: "set",
          id: entityId,
          value: entityDoc as JSONValue,
        });
      } else {
        operations.push({ op: "delete", id: entityId });
      }

      // Track read dependency if we have confirmed state.
      const confirmed = this.#v2Replica.state.confirmed.get(entityId);
      if (confirmed) {
        reads.confirmed.push({
          id: entityId,
          hash: confirmed.hash,
          version: confirmed.version,
        });
      }
    }

    const spaceId = this.#space as SpaceId;
    const cmd = buildTransactCommand(spaceId, { reads, operations });

    const { promise, resolve } = Promise.withResolvers<Result<Unit, Error>>();
    const wrapped = promise as Promise<unknown>;
    this.#commitPromises.add(wrapped);
    promise.finally(() => this.#commitPromises.delete(wrapped));

    // Store the resolver keyed by a request id.
    const requestId = `job:${crypto.randomUUID()}`;
    const envelope = { id: requestId, ...cmd };
    (this as any).__pendingTransacts = (this as any).__pendingTransacts ||
      new Map();
    (this as any).__pendingTransacts.set(requestId, resolve);

    this.#connection.send(envelope);

    return promise;
  }

  // -------------------------------------------------------------------------
  // IStorageProvider.destroy
  // -------------------------------------------------------------------------

  async destroy(): Promise<void> {
    await this.#connection.close();
  }

  // -------------------------------------------------------------------------
  // IStorageProvider.getReplica
  // -------------------------------------------------------------------------

  getReplica(): string | undefined {
    return this.#space;
  }

  // -------------------------------------------------------------------------
  // Internal: commit a v1 ITransaction via v2 wire protocol
  // -------------------------------------------------------------------------

  commitTransaction(
    transaction: ITransaction,
    source?: IStorageTransaction,
  ): Promise<Result<Unit, StorageTransactionRejected>> {
    const { facts, claims } = transaction;

    // Convert v1 facts to v2 operations.
    const operations: UserOperation[] = [];
    const reads = { confirmed: [] as any[], pending: [] as any[] };

    for (const fact of facts) {
      const entityId = fact.of as EntityId;

      if (fact.is !== undefined) {
        operations.push({
          op: "set",
          id: entityId,
          value: fact.is as JSONValue,
        });
      } else {
        operations.push({ op: "delete", id: entityId });
      }
    }

    // Convert v1 claims to v2 read dependencies.
    for (const claim of claims) {
      const entityId = claim.of as EntityId;
      const confirmed = this.#v2Replica.state.confirmed.get(entityId);
      if (confirmed) {
        reads.confirmed.push({
          id: entityId,
          hash: confirmed.hash,
          version: confirmed.version,
        });
      }
    }

    if (operations.length === 0) {
      return Promise.resolve({ ok: {} });
    }

    // Optimistically apply to the local replica and notify.
    const v2Ops = operations.map((op) => {
      if (op.op === "set") {
        return { op: "set" as const, id: op.id, value: op.value };
      } else {
        return { op: "delete" as const, id: op.id };
      }
    });

    const { changes: localChanges } = this.#v2Replica.commit(
      v2Ops.map((op) => ({
        ...op,
        parent: { toString: () => "pending" } as any,
      })),
      reads.confirmed,
    );

    // Notify scheduler about the optimistic commit.
    if (localChanges.changes.length > 0) {
      this.#subscription.next({
        type: "commit",
        space: this.#space,
        changes: new V2MergedChanges(localChanges.changes),
        source,
      });
    }

    // Send to server.
    const spaceId = this.#space as SpaceId;
    const cmd = buildTransactCommand(spaceId, { reads, operations });

    const { promise, resolve } = Promise.withResolvers<
      Result<Unit, StorageTransactionRejected>
    >();
    const wrapped = promise as Promise<unknown>;
    this.#commitPromises.add(wrapped);
    promise.finally(() => this.#commitPromises.delete(wrapped));

    const requestId = `job:${crypto.randomUUID()}`;
    const envelope = { id: requestId, ...cmd };
    (this as any).__pendingTransacts = (this as any).__pendingTransacts ||
      new Map();
    (this as any).__pendingTransacts.set(requestId, resolve);

    this.#connection.send(envelope);

    return promise;
  }

  // -------------------------------------------------------------------------
  // Internal: WebSocket message dispatch
  // -------------------------------------------------------------------------

  private onMessage(msg: unknown): void {
    const message = msg as Record<string, unknown>;

    // Route by presence of known fields.
    if ("id" in message && "ok" in message) {
      // Response to a command (transact or query).
      this.onCommandResponse(message);
    } else if ("id" in message && "error" in message) {
      this.onCommandResponse(message);
    } else if ("commit" in message && "revisions" in message) {
      // Subscription update.
      this.onSubscriptionUpdate(message);
    } else if ("ok" in message) {
      // Initial query/subscribe response (may carry a FactSet).
      this.onQueryResponse(message);
    } else {
      logger.debug("v2-unknown-message", () => [
        `Unhandled v2 message: ${JSON.stringify(message).slice(0, 200)}`,
      ]);
    }
  }

  private onCommandResponse(msg: Record<string, unknown>): void {
    const id = msg.id as string;
    const pendingTransacts = (this as any).__pendingTransacts as
      | Map<string, (result: Result<Unit, any>) => void>
      | undefined;

    if (pendingTransacts?.has(id)) {
      const resolve = pendingTransacts.get(id)!;
      pendingTransacts.delete(id);

      const result = parseTransactResult(msg);
      if ("ok" in result) {
        // Confirm the commit in the replica.
        const commit = result.ok;
        this.#v2Replica.confirm(
          commit.hash?.toString() ?? "",
          commit.version,
        );
        resolve({ ok: {} });
      } else {
        // Reject in the replica.
        const errorObj = result.error as Record<string, unknown>;
        if (errorObj?.name === "ConflictError") {
          resolve({
            error: {
              name: "ConflictError",
              message: "Transaction conflict",
              conflict: errorObj,
            } as any,
          });
        } else {
          resolve({
            error: {
              name: "ConnectionError",
              message: String(errorObj),
            } as any,
          });
        }
      }
      return;
    }
  }

  private onQueryResponse(msg: Record<string, unknown>): void {
    const result = parseQueryResult(msg);
    if ("ok" in result) {
      const factSet = result.ok;
      // Integrate each entity from the fact set into confirmed state.
      const entityChanges: EntityChange[] = [];
      for (const [entityId, entry] of Object.entries(factSet)) {
        const eid = entityId as EntityId;
        const before = this.#v2Replica.state.confirmed.get(eid)?.value;
        this.#v2Replica.state.confirmed.set(eid, {
          version: entry.version,
          hash: entry.hash?.toString() ?? "",
          value: entry.value,
        });
        entityChanges.push({ id: eid, before, after: entry.value });
      }

      // Notify subscribers.
      if (entityChanges.length > 0) {
        this.notifyEntityChanges(entityChanges, "pull");
      }
    }

    // Resolve any pending sync promises.
    this.resolveAllSyncPromises();
  }

  private onSubscriptionUpdate(msg: Record<string, unknown>): void {
    const revisions = msg.revisions as Array<{
      fact: { type: string; id: string; value?: JSONValue };
      version: number;
      hash: unknown;
      commitHash: unknown;
    }>;

    if (!revisions) return;

    const entityValues = new Map<EntityId, JSONValue | undefined>();
    for (const rev of revisions) {
      const eid = rev.fact.id as EntityId;
      if (rev.fact.type === "set") {
        entityValues.set(eid, (rev.fact as any).value);
      } else if (rev.fact.type === "delete") {
        entityValues.set(eid, undefined);
      }
    }

    const commit = msg.commit as {
      hash: unknown;
      version: number;
      branch: string;
      facts: unknown[];
      createdAt: string;
    } | undefined;
    if (commit && entityValues.size > 0) {
      const changes = this.#v2Replica.integrate(
        {
          hash: commit.hash as any,
          version: commit.version,
          branch: commit.branch ?? "",
          facts: commit.facts as any[],
          createdAt: commit.createdAt ?? new Date().toISOString(),
        },
        entityValues,
      );

      if (changes.changes.length > 0) {
        this.notifyEntityChanges(changes.changes, "integrate");
      }
    }
  }

  // -------------------------------------------------------------------------
  // Internal: connection open handler
  // -------------------------------------------------------------------------

  private onConnectionOpen(): void {
    // (Re)establish the wildcard subscription.
    this.establishSubscription();
  }

  private establishSubscription(): void {
    const spaceId = this.#space as SpaceId;
    const cmd = buildSubscribeCommand(spaceId, {
      select: { "*": {} },
    });

    const requestId = `job:${crypto.randomUUID()}`;
    const envelope = { id: requestId, ...cmd };
    this.#connection.send(envelope);
    this.#subscribed = true;
  }

  // -------------------------------------------------------------------------
  // Internal: notification helpers
  // -------------------------------------------------------------------------

  private notifyEntityChanges(
    changes: EntityChange[],
    type: "commit" | "pull" | "integrate",
  ): void {
    // Notify scheduler via storage subscription.
    this.#subscription.next({
      type,
      space: this.#space,
      changes: new V2MergedChanges(changes),
    } as any);

    // Notify per-entity sink subscribers.
    for (const change of changes) {
      const subs = this.#subscribers.get(change.id);
      if (subs) {
        const sv = this.entityValueToStorageValue(change.after);
        for (const cb of subs) {
          try {
            cb(sv);
          } catch (err) {
            logger.error("v2-sink-error", () => [
              `Error in v2 sink callback: ${err}`,
            ]);
          }
        }
      }
    }
  }

  private resolveAllSyncPromises(): void {
    const resolvers = (this as any).__syncResolvers as
      | Array<(r: Result<Unit, Error>) => void>
      | undefined;
    if (resolvers) {
      for (const resolve of resolvers) {
        resolve({ ok: {} });
      }
      (this as any).__syncResolvers = [];
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private entityValueToStorageValue(
    value: JSONValue | undefined,
  ): StorageValue<StorableDatum> {
    if (value === undefined) {
      return {} as StorageValue<StorableDatum>;
    }
    return value as unknown as StorageValue<StorableDatum>;
  }
}
