/**
 * Memory v2 Consumer Session
 *
 * Client-side session for communicating with a v2 memory provider.
 * Manages pending state, confirmed state, and subscription lifecycle.
 * From spec §04.
 */

import { emptyRef } from "./reference.ts";
import type {
  ClientCommit,
  Commit,
  ConfirmedRead,
  EntityId,
  FactSet,
  JSONValue,
  Operation,
  Reference,
  Selector,
} from "./types.ts";
import { DEFAULT_BRANCH } from "./types.ts";

/**
 * User-facing operation types that don't require explicit `parent`.
 * The consumer fills in `parent` from its confirmed state.
 */
export type UserOperation =
  | { op: "set"; id: EntityId; value: JSONValue }
  | { op: "patch"; id: EntityId; patches: import("./types.ts").PatchOp[] }
  | { op: "delete"; id: EntityId }
  | { op: "claim"; id: EntityId };
import type {
  Command,
  InvocationId,
  ProviderMessage,
  QueryResult,
  SubscriptionUpdate,
  TransactResult,
} from "./protocol.ts";

/**
 * Result of a consumer transact() call.
 * Contains the synchronously-applied local commit and a promise
 * that resolves when the server confirms (or rejects) the commit.
 * For local providers, the promise is already resolved.
 */
export interface ConsumerTransactResult {
  /** The locally-applied commit (available synchronously). */
  commit: Commit;
  /** Resolves when the server confirms, rejects on conflict.
   *  For local providers this is already resolved. */
  confirmed: Promise<Commit>;
}

/**
 * Pending commit entry tracking optimistic local state.
 */
export interface PendingEntry {
  commit: ClientCommit;
  provisionalHash: string;
}

/**
 * Callback for receiving subscription updates.
 */
export type SubscriptionCallback = (update: SubscriptionUpdate) => void;

/**
 * A consumer session provides the client-side API for interacting
 * with a v2 memory provider (either local or remote).
 */
export class ConsumerSession {
  private invokeProvider: (
    id: InvocationId,
    cmd: Command,
  ) => ProviderMessage;
  private effectHandler:
    | ((listener: (msg: ProviderMessage) => void) => () => void)
    | null;

  /** Confirmed state: server-acknowledged entity versions. */
  private confirmed = new Map<
    string,
    { version: number; hash: Reference; value?: JSONValue }
  >();

  /** Active subscription callbacks. */
  private subscriptionCallbacks = new Map<
    InvocationId,
    SubscriptionCallback
  >();

  /** Cleanup function for effect listener. */
  private cleanupEffectListener: (() => void) | null = null;

  private nextInvocationId = 0;

  constructor(
    invokeProvider: (id: InvocationId, cmd: Command) => ProviderMessage,
    onEffect?: (listener: (msg: ProviderMessage) => void) => () => void,
  ) {
    this.invokeProvider = invokeProvider;
    this.effectHandler = onEffect ?? null;

    // Register effect listener if provider supports it
    if (this.effectHandler) {
      this.cleanupEffectListener = this.effectHandler((msg) => {
        if (msg.the === "task/effect") {
          const callback = this.subscriptionCallbacks.get(msg.of);
          if (callback) {
            callback(msg.is as SubscriptionUpdate);
          }
        }
      });
    }
  }

  /**
   * Generate a unique invocation ID.
   */
  private nextId(): InvocationId {
    return `job:${this.nextInvocationId++}` as InvocationId;
  }

  /**
   * Submit a transaction.
   * Returns the locally-applied commit and a confirmation promise.
   * The confirmation promise resolves when the server acknowledges the commit.
   * For local providers, the promise is already resolved.
   *
   * NOT async — local state is updated synchronously.
   */
  transact(
    userOps: UserOperation[],
    options: { branch?: string } = {},
  ): ConsumerTransactResult {
    const branch = options.branch ?? DEFAULT_BRANCH;

    // Build confirmed reads and resolve parent references
    const confirmedReads: ConfirmedRead[] = [];
    const readEntities = new Set<string>();

    for (const op of userOps) {
      readEntities.add(op.id);
    }

    for (const entityId of readEntities) {
      const state = this.confirmed.get(`${branch}:${entityId}`);
      if (state) {
        confirmedReads.push({
          id: entityId,
          hash: state.hash,
          version: state.version,
        });
      }
    }

    // Resolve parent references from confirmed state
    const operations: Operation[] = userOps.map((op) => {
      const state = this.confirmed.get(`${branch}:${op.id}`);
      const parent: Reference = state?.hash ?? emptyRef(op.id);
      return { ...op, parent } as Operation;
    });

    const clientCommit: ClientCommit = {
      reads: {
        confirmed: confirmedReads,
        pending: [],
      },
      operations,
      branch: branch || undefined,
    };

    const id = this.nextId();
    const response = this.invokeProvider(id, {
      cmd: "/memory/transact",
      sub: "did:key:consumer" as `did:${string}`,
      args: clientCommit,
    });

    const result = response.is as TransactResult;
    if ("error" in result) {
      const err = new Error(
        "name" in result.error ? result.error.name : "TransactionError",
      );
      Object.assign(err, result.error);
      throw err;
    }

    const commit = result.ok;

    // Update confirmed state with committed facts
    for (const storedFact of commit.facts) {
      const key = `${commit.branch}:${storedFact.fact.id}`;
      this.confirmed.set(key, {
        version: commit.version,
        hash: storedFact.hash,
      });
    }

    // For local provider, confirmation is immediate
    return { commit, confirmed: Promise.resolve(commit) };
  }

  /**
   * Query entities matching a selector.
   */
  query(
    select: Selector,
    options: { since?: number; branch?: string } = {},
  ): FactSet {
    const id = this.nextId();
    const response = this.invokeProvider(id, {
      cmd: "/memory/query",
      sub: "did:key:consumer" as `did:${string}`,
      args: {
        select,
        since: options.since,
        branch: options.branch,
      },
    });

    const result = response.is as QueryResult;
    if ("error" in result) {
      throw new Error(
        "name" in result.error ? result.error.name : "QueryError",
      );
    }

    // Update confirmed state with query results
    for (const [entityId, entry] of Object.entries(result.ok)) {
      const branch = options.branch ?? DEFAULT_BRANCH;
      this.confirmed.set(`${branch}:${entityId}`, {
        version: entry.version,
        hash: entry.hash,
        value: entry.value,
      });
    }

    return result.ok;
  }

  /**
   * Subscribe to changes matching a selector.
   * Returns the initial result and a subscription ID for unsubscribing.
   */
  subscribe(
    select: Selector,
    callback: SubscriptionCallback,
    options: { since?: number; branch?: string } = {},
  ): { facts: FactSet; subscriptionId: InvocationId } {
    const id = this.nextId();
    const response = this.invokeProvider(id, {
      cmd: "/memory/query/subscribe",
      sub: "did:key:consumer" as `did:${string}`,
      args: {
        select,
        since: options.since,
        branch: options.branch,
      },
    });

    const result = response.is as QueryResult;
    if ("error" in result) {
      throw new Error(
        "name" in result.error ? result.error.name : "QueryError",
      );
    }

    // Register the callback
    this.subscriptionCallbacks.set(id, callback);

    return { facts: result.ok, subscriptionId: id };
  }

  /**
   * Unsubscribe from a subscription.
   */
  unsubscribe(subscriptionId: InvocationId): void {
    this.subscriptionCallbacks.delete(subscriptionId);
    const id = this.nextId();
    this.invokeProvider(id, {
      cmd: "/memory/query/unsubscribe",
      sub: "did:key:consumer" as `did:${string}`,
      args: { source: subscriptionId },
    });
  }

  /**
   * Read an entity's confirmed value from the local cache.
   */
  getConfirmed(
    entityId: EntityId,
    branch: string = DEFAULT_BRANCH,
  ): { version: number; hash: Reference; value?: JSONValue } | null {
    return this.confirmed.get(`${branch}:${entityId}`) ?? null;
  }

  /**
   * Close the session and clean up.
   */
  close(): void {
    this.subscriptionCallbacks.clear();
    if (this.cleanupEffectListener) {
      this.cleanupEffectListener();
      this.cleanupEffectListener = null;
    }
  }
}

/**
 * Create a consumer session connected to a local provider session.
 * Useful for testing and in-process usage.
 */
export function connectLocal(
  provider: {
    invoke: (id: InvocationId, cmd: Command) => ProviderMessage;
    onEffect: (listener: (msg: ProviderMessage) => void) => () => void;
  },
): ConsumerSession {
  return new ConsumerSession(
    (id, cmd) => provider.invoke(id, cmd),
    (listener) => provider.onEffect(listener),
  );
}
