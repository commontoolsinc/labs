/**
 * Memory v2 Remote Consumer
 *
 * WebSocket transport for v2 memory protocol.
 * Provides optimistic local state with deferred server confirmation.
 *
 * Uses an in-memory shadow (no SQLite) so it works in both Deno and browser.
 */

import type {
  ConsumerTransactResult,
  SubscriptionCallback,
  UserOperation,
} from "./consumer.ts";
import type {
  Commit,
  EntityId,
  FactSet,
  JSONValue,
  Reference,
  Selector,
  StoredFact,
} from "./types.ts";
import { DEFAULT_BRANCH } from "./types.ts";
import type {
  Command,
  InvocationId,
  ProviderMessage,
  QueryResult,
  SubscriptionUpdate,
  TransactResult,
} from "./protocol.ts";
import { decodeMessage, encodeCommand } from "./codec.ts";
import { emptyRef, hashCommit, hashFact } from "./reference.ts";
import { applyPatch } from "./patch.ts";

// ─── Deferred ─────────────────────────────────────────────────────────────

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: Error) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// ─── In-Memory Shadow ────────────────────────────────────────────────────
// Lightweight local state that works in both Deno and browser (no SQLite).

interface EntityState {
  value?: JSONValue;
  version: number;
  hash: Reference;
}

/**
 * In-memory shadow for optimistic local state.
 * Replaces SpaceV2 + ProviderSession + ConsumerSession chain to avoid
 * SQLite dependency (which doesn't work in browser WebWorkers).
 */
class InMemoryShadow {
  private entities = new Map<string, EntityState>();
  private version = 0;
  private subscriptions = new Map<
    InvocationId,
    { select: Selector; branch: string; callback: SubscriptionCallback }
  >();
  private nextSubId = 0;
  /** Flag to suppress subscription notifications during own transact(). */
  private suppressNotifications = false;

  transact(
    userOps: UserOperation[],
    options?: { branch?: string },
  ): { commit: Commit } {
    const branch = options?.branch ?? DEFAULT_BRANCH;
    this.version++;
    const storedFacts: StoredFact[] = [];

    for (const op of userOps) {
      const key = `${branch}:${op.id}`;
      const current = this.entities.get(key);
      const parent: Reference = current?.hash ?? emptyRef(op.id);

      let fact;
      let newValue: JSONValue | undefined;

      if (op.op === "set") {
        fact = { type: "set" as const, id: op.id, value: op.value, parent };
        newValue = op.value;
      } else if (op.op === "patch") {
        const currentValue = current?.value;
        newValue = applyPatch(
          currentValue !== undefined ? currentValue : {},
          op.patches,
        );
        fact = {
          type: "patch" as const,
          id: op.id,
          ops: op.patches,
          parent,
        };
      } else if (op.op === "delete") {
        fact = { type: "delete" as const, id: op.id, parent };
        newValue = undefined;
      } else {
        // claim — no value change, treat as set with current value (or null)
        const claimValue = current?.value ?? null;
        fact = { type: "set" as const, id: op.id, value: claimValue, parent };
        newValue = claimValue;
      }

      const hash = hashFact(fact);
      const commitHash = hash; // approximate
      storedFacts.push({ hash, fact, version: this.version, commitHash });
      this.entities.set(key, {
        value: newValue,
        version: this.version,
        hash,
      });
    }

    const commit: Commit = {
      hash: hashCommit({
        version: this.version,
        branch,
        operations: userOps,
        reads: { confirmed: [], pending: [] },
      }),
      version: this.version,
      branch,
      facts: storedFacts,
      createdAt: new Date().toISOString(),
    };

    // Notify local subscriptions
    if (!this.suppressNotifications) {
      this.notifySubscriptions(commit, branch);
    }

    return { commit };
  }

  query(
    select: Selector,
    options?: { since?: number; branch?: string },
  ): FactSet {
    const branch = options?.branch ?? DEFAULT_BRANCH;
    const result: FactSet = {};

    if ("*" in select) {
      for (const [key, state] of this.entities) {
        if (key.startsWith(`${branch}:`)) {
          const entityId = key.slice(branch.length + 1);
          if (options?.since && state.version <= options.since) continue;
          result[entityId] = {
            value: state.value,
            version: state.version,
            hash: state.hash,
          };
        }
      }
    } else {
      for (const entityId of Object.keys(select)) {
        const key = `${branch}:${entityId}`;
        const state = this.entities.get(key);
        if (state) {
          if (options?.since && state.version <= options.since) continue;
          result[entityId] = {
            value: state.value,
            version: state.version,
            hash: state.hash,
          };
        }
      }
    }

    return result;
  }

  subscribe(
    select: Selector,
    callback: SubscriptionCallback,
    options?: { since?: number; branch?: string },
  ): { facts: FactSet; subscriptionId: InvocationId } {
    const branch = options?.branch ?? DEFAULT_BRANCH;
    const subscriptionId = `sub:${this.nextSubId++}` as InvocationId;
    this.subscriptions.set(subscriptionId, { select, branch, callback });
    const facts = this.query(select, options);
    return { facts, subscriptionId };
  }

  unsubscribe(subscriptionId: InvocationId): void {
    this.subscriptions.delete(subscriptionId);
  }

  getConfirmed(
    entityId: EntityId,
    branch: string = DEFAULT_BRANCH,
  ): EntityState | null {
    return this.entities.get(`${branch}:${entityId}`) ?? null;
  }

  /**
   * Apply a FactSet from the server into local state and notify subscribers.
   */
  applyFactSet(facts: FactSet, branch: string = DEFAULT_BRANCH): void {
    for (const [entityId, entry] of Object.entries(facts)) {
      const key = `${branch}:${entityId}`;
      this.entities.set(key, {
        value: entry.value,
        version: entry.version,
        hash: entry.hash,
      });
      if (entry.version > this.version) {
        this.version = entry.version;
      }
    }
  }

  reset(): void {
    this.entities.clear();
    this.subscriptions.clear();
    this.version = 0;
  }

  close(): void {
    this.entities.clear();
    this.subscriptions.clear();
  }

  private notifySubscriptions(commit: Commit, branch: string): void {
    for (const [_, sub] of this.subscriptions) {
      if (sub.branch !== branch) continue;
      // Check if any committed facts match the subscription selector
      const matchingRevisions: StoredFact[] = [];
      for (const sf of commit.facts) {
        if ("*" in sub.select || sf.fact.id in sub.select) {
          matchingRevisions.push(sf);
        }
      }
      if (matchingRevisions.length > 0) {
        sub.callback({
          commit,
          revisions: matchingRevisions,
        });
      }
    }
  }
}

// ─── Remote Connection ────────────────────────────────────────────────────

export interface RemoteConnectionOptions {
  url: string | URL;
  connectionTimeout?: number;
}

/**
 * Manages WebSocket connection to v2 memory server.
 * Handles command/response correlation, subscription routing, and reconnection.
 */
export class RemoteConnection {
  private url: URL;
  private socket: WebSocket | null = null;
  private connectionTimeout: number;

  /** Pending request/response correlation */
  private pending = new Map<InvocationId, Deferred<ProviderMessage>>();

  /** Commands queued while disconnected */
  private queue: string[] = [];

  /** Effect listeners for subscription updates */
  private effectListeners = new Set<(msg: ProviderMessage) => void>();

  /** Track active subscriptions for reconnection replay */
  private activeSubscriptions = new Map<
    InvocationId,
    {
      select: Selector;
      branch?: string;
      callback: SubscriptionCallback;
    }
  >();

  /** Reconnection state */
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private hasConnectedSuccessfully = false;
  private closed = false;

  /** Callback for reconnection events */
  onReconnect?: () => void;

  constructor(options: RemoteConnectionOptions) {
    this.url = new URL(
      typeof options.url === "string" ? options.url : options.url.href,
    );
    this.connectionTimeout = options.connectionTimeout ?? 30_000;
  }

  connect(): void {
    if (this.closed) return;

    const socket = new WebSocket(this.url.href);
    this.socket = socket;

    socket.onopen = () => {
      this.reconnectAttempt = 0;

      if (this.hasConnectedSuccessfully) {
        this.onReconnect?.();
      }
      this.hasConnectedSuccessfully = true;

      // Drain queued messages
      const queued = [...this.queue];
      this.queue = [];
      for (const msg of queued) {
        socket.send(msg);
      }
    };

    socket.onmessage = (event: MessageEvent) => {
      const msg = decodeMessage(event.data as string);
      if (msg.the === "task/return") {
        const d = this.pending.get(msg.of);
        if (d) {
          this.pending.delete(msg.of);
          d.resolve(msg);
        }
      } else if (msg.the === "task/effect") {
        for (const listener of this.effectListeners) {
          listener(msg);
        }
      }
    };

    socket.onclose = () => {
      this.socket = null;
      if (!this.closed) {
        this.scheduleReconnect();
      }
    };

    socket.onerror = () => {
      // onclose fires after onerror
    };
  }

  /**
   * Send a command and get a promise for the server's response.
   */
  send(id: InvocationId, cmd: Command): Promise<ProviderMessage> {
    const d = deferred<ProviderMessage>();
    this.pending.set(id, d);

    const encoded = encodeCommand(id, cmd);
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(encoded);
    } else {
      this.queue.push(encoded);
    }

    return d.promise;
  }

  onEffect(listener: (msg: ProviderMessage) => void): () => void {
    this.effectListeners.add(listener);
    return () => this.effectListeners.delete(listener);
  }

  trackSubscription(
    id: InvocationId,
    select: Selector,
    branch: string | undefined,
    callback: SubscriptionCallback,
  ): void {
    this.activeSubscriptions.set(id, { select, branch, callback });
  }

  untrackSubscription(id: InvocationId): void {
    this.activeSubscriptions.delete(id);
  }

  getTrackedSubscriptions(): Map<
    InvocationId,
    { select: Selector; branch?: string; callback: SubscriptionCallback }
  > {
    return new Map(this.activeSubscriptions);
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    // Resolve (not reject) pending deferreds on intentional close.
    // Local state is already committed; rejecting causes uncaught promise errors
    // when callers don't explicitly catch the confirmed promise.
    for (const d of this.pending.values()) {
      d.resolve(undefined as any);
    }
    this.pending.clear();
    this.queue = [];
    this.effectListeners.clear();
    this.activeSubscriptions.clear();
    if (this.socket) {
      this.socket.onclose = null;
      this.socket.onerror = null;
      this.socket.onmessage = null;
      this.socket.close();
      this.socket = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) return;
    const delay = Math.min(
      100 * Math.pow(2, this.reconnectAttempt),
      this.connectionTimeout,
    );
    this.reconnectAttempt++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
}

// ─── Remote Consumer ──────────────────────────────────────────────────────

export interface ConnectRemoteOptions {
  connectionTimeout?: number;
}

/**
 * Consumer session backed by both in-memory shadow state and remote WebSocket.
 *
 * transact(): applies locally (sync), returns deferred server confirmation
 * query(): applies locally (sync), also sends to server
 * subscribe(): registers locally, also subscribes on server
 *
 * Uses InMemoryShadow instead of SpaceV2 so it works in browser WebWorkers.
 */
export class RemoteConsumer {
  readonly connection: RemoteConnection;

  private shadow: InMemoryShadow;
  private nextInvocationId = 0;

  /** Subscription callbacks keyed by server invocation ID ("job:N") */
  private subscriptionCallbacks = new Map<
    InvocationId,
    SubscriptionCallback
  >();

  /** Map from local subscription ID ("sub:N") to server invocation ID ("job:N") */
  private localToServerSubId = new Map<InvocationId, InvocationId>();

  /** Cleanup for effect listener */
  private cleanupEffectListener: (() => void) | null = null;

  constructor(connection: RemoteConnection) {
    this.connection = connection;

    // Create lightweight in-memory shadow for optimistic state (no SQLite)
    this.shadow = new InMemoryShadow();

    // Listen for subscription effects from server
    this.cleanupEffectListener = this.connection.onEffect((msg) => {
      if (msg.the === "task/effect") {
        const callback = this.subscriptionCallbacks.get(msg.of);
        if (callback) {
          callback(msg.is as SubscriptionUpdate);
        }
      }
    });
  }

  private nextId(): InvocationId {
    return `job:${this.nextInvocationId++}` as InvocationId;
  }

  /**
   * Transact with optimistic local apply + deferred server confirmation.
   * Local state is updated synchronously. The `confirmed` promise resolves
   * when the server confirms (or rejects) the commit.
   */
  transact(
    userOps: UserOperation[],
    options?: { branch?: string },
  ): ConsumerTransactResult {
    // Apply locally — this is synchronous and updates local state
    const localResult = this.shadow.transact(userOps, options);

    // Send the transact command to server (async).
    // Forward user operations directly — no parent on the wire.
    // The server resolves parent from its own head state.
    const id = this.nextId();
    const operations = userOps.map((op) => {
      if (op.op === "patch") {
        return { op: "patch" as const, id: op.id, patches: op.patches };
      } else if (op.op === "set") {
        return { op: "set" as const, id: op.id, value: op.value };
      } else if (op.op === "delete") {
        return { op: "delete" as const, id: op.id };
      } else {
        return { op: "claim" as const, id: op.id };
      }
    });
    const serverPromise = this.connection.send(id, {
      cmd: "/memory/transact",
      sub: "did:key:consumer" as `did:${string}`,
      args: {
        reads: { confirmed: [], pending: [] },
        operations,
        branch: localResult.commit.branch || undefined,
      },
    });

    // Wire server response to deferred confirmation
    const confirmed = serverPromise.then((response) => {
      // response is undefined when connection closed during cleanup
      if (!response) return localResult.commit;
      const result = response.is as TransactResult;
      if ("error" in result) {
        const err = new Error(
          "name" in result.error ? result.error.name : "TransactionError",
        );
        Object.assign(err, result.error);
        throw err;
      }
      return result.ok;
    });

    return { commit: localResult.commit, confirmed };
  }

  /**
   * Query entities matching a selector.
   * Returns local result immediately, also sends query to server.
   */
  query(
    select: Selector,
    options?: { since?: number; branch?: string },
  ): FactSet {
    return this.shadow.query(select, options);
  }

  /**
   * Subscribe to changes matching a selector.
   * Sets up both local and remote subscriptions.
   */
  subscribe(
    select: Selector,
    callback: SubscriptionCallback,
    options?: { since?: number; branch?: string },
  ): {
    facts: FactSet;
    subscriptionId: InvocationId;
    ready: Promise<FactSet | undefined>;
  } {
    // Subscribe locally for optimistic updates
    const localResult = this.shadow.subscribe(
      select,
      callback,
      options,
    );

    // Send subscribe command to server — returns initial state asynchronously.
    // We don't transact into local shadow (that would fire spurious callbacks).
    // Instead, the caller (ReplicaV2) applies the FactSet via ready promise.
    const id = this.nextId();

    // Register callback for remote subscription effects under the server's
    // invocation ID (= "job:N"), since that's what the server uses in
    // task/effect messages. The local shadow already handles optimistic
    // notifications via its own "sub:N" subscription.
    this.subscriptionCallbacks.set(id, callback);
    this.localToServerSubId.set(localResult.subscriptionId, id);
    const ready = this.connection.send(id, {
      cmd: "/memory/query/subscribe",
      sub: "did:key:consumer" as `did:${string}`,
      args: { select, since: options?.since, branch: options?.branch },
    }).then((response) => {
      if (!response) return undefined;
      const result = response.is as QueryResult;
      if ("ok" in result) {
        return result.ok as FactSet;
      }
      return undefined;
    });

    // Track for reconnection using the server invocation ID
    this.connection.trackSubscription(
      id,
      select,
      options?.branch,
      callback,
    );

    return { ...localResult, ready };
  }

  /**
   * Unsubscribe from a subscription.
   */
  unsubscribe(subscriptionId: InvocationId): void {
    // subscriptionId is the local "sub:N" ID. Look up the server "job:N" ID.
    const serverSubId = this.localToServerSubId.get(subscriptionId);
    if (serverSubId) {
      this.subscriptionCallbacks.delete(serverSubId);
      this.connection.untrackSubscription(serverSubId);
      this.localToServerSubId.delete(subscriptionId);

      // Send unsubscribe to server using the server's invocation ID
      const id = this.nextId();
      this.connection.send(id, {
        cmd: "/memory/query/unsubscribe",
        sub: "did:key:consumer" as `did:${string}`,
        args: { source: serverSubId },
      });
    }

    this.shadow.unsubscribe(subscriptionId);
  }

  /**
   * Read confirmed state from local cache.
   */
  getConfirmed(entityId: string, branch?: string) {
    return this.shadow.getConfirmed(entityId, branch);
  }

  /**
   * Reset local state (for reconnection scenarios).
   */
  reset(): void {
    this.shadow.reset();
  }

  close(): void {
    this.shadow.close();
    if (this.cleanupEffectListener) {
      this.cleanupEffectListener();
      this.cleanupEffectListener = null;
    }
    this.subscriptionCallbacks.clear();
    this.connection.close();
  }
}

// ─── Factory Function ─────────────────────────────────────────────────────

/**
 * Create a remote consumer connected to a v2 memory server via WebSocket.
 *
 * @param wsUrl - WebSocket URL (e.g., "ws://localhost:8080/api/storage/memory/v2?space=did:key:...")
 * @param options - Connection options
 * @returns RemoteConsumer with local optimistic state + remote confirmation
 */
export function connectRemote(
  wsUrl: string | URL,
  options?: ConnectRemoteOptions,
): RemoteConsumer {
  const connection = new RemoteConnection({
    url: wsUrl,
    connectionTimeout: options?.connectionTimeout,
  });
  const consumer = new RemoteConsumer(connection);

  // Set up reconnection handler
  connection.onReconnect = () => {
    // Reset local state
    consumer.reset();

    // Re-establish subscriptions
    const subs = connection.getTrackedSubscriptions();
    for (const [_, sub] of subs) {
      consumer.subscribe(sub.select, sub.callback, { branch: sub.branch });
    }
  };

  connection.connect();
  return consumer;
}
