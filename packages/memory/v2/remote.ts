/**
 * Memory v2 Remote Consumer
 *
 * WebSocket transport for v2 memory protocol.
 * Provides optimistic local state with deferred server confirmation.
 */

import { SpaceV2 } from "./space.ts";
import { ProviderSession } from "./provider.ts";
import { connectLocal, ConsumerSession } from "./consumer.ts";
import type {
  ConsumerTransactResult,
  SubscriptionCallback,
  UserOperation,
} from "./consumer.ts";
import type { FactSet, Selector } from "./types.ts";
import type {
  Command,
  InvocationId,
  ProviderMessage,
  SubscriptionUpdate,
  TransactResult,
} from "./protocol.ts";
import { decodeMessage, encodeCommand } from "./codec.ts";

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
    for (const d of this.pending.values()) {
      d.reject(new Error("Connection closed"));
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
 * Consumer session backed by both local shadow state and remote WebSocket.
 *
 * transact(): applies locally (sync), returns deferred server confirmation
 * query(): applies locally (sync), also sends to server
 * subscribe(): registers locally, also subscribes on server
 */
export class RemoteConsumer {
  readonly connection: RemoteConnection;

  private localSpace: SpaceV2;
  private localProvider: ProviderSession;
  private localConsumer: ConsumerSession;
  private nextInvocationId = 0;

  /** Subscription callbacks registered by the user */
  private subscriptionCallbacks = new Map<
    InvocationId,
    SubscriptionCallback
  >();

  /** Cleanup for effect listener */
  private cleanupEffectListener: (() => void) | null = null;

  constructor(connection: RemoteConnection) {
    this.connection = connection;

    // Create local shadow for optimistic state
    this.localSpace = SpaceV2.open({ url: new URL("memory:remote-shadow") });
    this.localProvider = new ProviderSession(this.localSpace);
    this.localConsumer = connectLocal(this.localProvider);

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
    const localResult = this.localConsumer.transact(userOps, options);

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
    return this.localConsumer.query(select, options);
  }

  /**
   * Subscribe to changes matching a selector.
   * Sets up both local and remote subscriptions.
   */
  subscribe(
    select: Selector,
    callback: SubscriptionCallback,
    options?: { since?: number; branch?: string },
  ): { facts: FactSet; subscriptionId: InvocationId } {
    // Subscribe locally for optimistic updates
    const localResult = this.localConsumer.subscribe(
      select,
      callback,
      options,
    );

    // Also register callback for remote subscription effects
    this.subscriptionCallbacks.set(localResult.subscriptionId, callback);

    // Send subscribe command to server
    const id = this.nextId();
    this.connection.send(id, {
      cmd: "/memory/query/subscribe",
      sub: "did:key:consumer" as `did:${string}`,
      args: { select, since: options?.since, branch: options?.branch },
    });

    // Track for reconnection
    this.connection.trackSubscription(
      localResult.subscriptionId,
      select,
      options?.branch,
      callback,
    );

    return localResult;
  }

  /**
   * Unsubscribe from a subscription.
   */
  unsubscribe(subscriptionId: InvocationId): void {
    this.subscriptionCallbacks.delete(subscriptionId);
    this.localConsumer.unsubscribe(subscriptionId);
    this.connection.untrackSubscription(subscriptionId);

    // Send unsubscribe to server
    const id = this.nextId();
    this.connection.send(id, {
      cmd: "/memory/query/unsubscribe",
      sub: "did:key:consumer" as `did:${string}`,
      args: { source: subscriptionId },
    });
  }

  /**
   * Read confirmed state from local cache.
   */
  getConfirmed(entityId: string, branch?: string) {
    return this.localConsumer.getConfirmed(entityId, branch);
  }

  /**
   * Reset local state (for reconnection scenarios).
   */
  reset(): void {
    this.localConsumer.close();
    this.localProvider.close();
    this.localSpace.close();
    this.localSpace = SpaceV2.open({ url: new URL("memory:remote-shadow") });
    this.localProvider = new ProviderSession(this.localSpace);
    this.localConsumer = connectLocal(this.localProvider);
  }

  close(): void {
    this.localConsumer.close();
    this.localProvider.close();
    this.localSpace.close();
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
