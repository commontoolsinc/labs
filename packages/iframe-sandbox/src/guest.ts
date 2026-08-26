/**
 * Connects sandboxed guest code to the capabilities granted by its host.
 * Calls may begin before port handoff and settle once the host is ready.
 */

import {
  fabricFromRealmValue,
  realmFromFabricValue,
} from "@commonfabric/data-model/codecs";
import {
  type FabricValue,
  valueEqual,
} from "@commonfabric/data-model/fabric-value";

import {
  BRIDGE_PROTOCOL,
  BRIDGE_VERSION,
  type BridgeError,
  type BridgeHostMessage,
  type BridgeManifest,
  type BridgeOperation,
  type BridgeRequest,
  GUEST_PORT_HANDOFF,
  type GuestError,
  isBridgeHostMessage,
} from "./ipc.ts";

/** Structured failure returned by a bridge operation. */
export class FabricBridgeError extends Error {
  readonly code: string;
  readonly resource?: string;

  constructor(error: BridgeError) {
    super(error.message);
    this.name = "FabricBridgeError";
    this.code = error.code;
    this.resource = error.resource;
  }
}

/** Current state of a remote resource watched by guest code. */
export type ResourceSnapshot<T> =
  | { status: "loading" }
  | { status: "ready"; value: T }
  | { status: "error"; error: FabricBridgeError };

type SnapshotListener<T> = (snapshot: ResourceSnapshot<T>) => void;

/** Reactive guest-side handle for one named cell resource. */
export class RemoteCell<T = FabricValue> {
  readonly #client: FabricClient;
  readonly #name: string;
  readonly #listeners = new Set<SnapshotListener<T>>();
  #snapshot: ResourceSnapshot<T> = { status: "loading" };
  #unsubscribeRemote: (() => void) | undefined;

  constructor(client: FabricClient, name: string) {
    this.#client = client;
    this.#name = name;
  }

  getSnapshot = (): ResourceSnapshot<T> => this.#snapshot;

  subscribe = (listener: SnapshotListener<T>): () => void => {
    this.#listeners.add(listener);
    listener(this.#snapshot);
    if (this.#listeners.size === 1) {
      this.#unsubscribeRemote = this.#client.subscribeResource(
        this.#name,
        (value) => this.#setReady(value as T),
        (error) => this.#setError(error),
      );
    }
    return () => {
      this.#listeners.delete(listener);
      if (this.#listeners.size === 0) {
        this.#unsubscribeRemote?.();
        this.#unsubscribeRemote = undefined;
      }
    };
  };

  async read(): Promise<T> {
    try {
      const value = await this.#client.request("read", {
        resource: this.#name,
      }) as T;
      this.#setReady(value);
      return value;
    } catch (error) {
      this.#setError(error);
      throw error;
    }
  }

  async write(value: T): Promise<void> {
    try {
      const before = this.#snapshot;
      await this.#client.request("write", {
        resource: this.#name,
        value: value as FabricValue,
      });
      if (this.#snapshot === before) this.#setReady(value);
    } catch (error) {
      this.#setError(error);
      throw error;
    }
  }

  #setReady(value: T): void {
    if (
      this.#snapshot.status === "ready" &&
      valueEqual(
        this.#snapshot.value as FabricValue,
        value as FabricValue,
      )
    ) {
      return;
    }
    this.#snapshot = { status: "ready", value };
    for (const listener of this.#listeners) listener(this.#snapshot);
  }

  #setError(error: unknown): void {
    const bridgeError = error instanceof FabricBridgeError
      ? error
      : new FabricBridgeError({
        code: "operation-failed",
        message: error instanceof Error ? error.message : String(error),
        resource: this.#name,
      });
    this.#snapshot = { status: "error", error: bridgeError };
    for (const listener of this.#listeners) listener(this.#snapshot);
  }
}

/** SQL text and bind values accepted by a remote SQLite resource. */
export type SqliteQueryInput = {
  sql: string;
  params?: ReadonlyArray<FabricValue> | Record<string, FabricValue>;
};

/** Guest-side query and mutation interface for one SQLite resource. */
export class RemoteSqlite {
  readonly #client: FabricClient;
  readonly #name: string;

  constructor(client: FabricClient, name: string) {
    this.#client = client;
    this.#name = name;
  }

  query<Row = Record<string, unknown>>(
    sql: string,
    params?: SqliteQueryInput["params"],
  ): Promise<{ rows: Row[] }> {
    return this.#client.call(this.#name, "query", {
      sql,
      ...(params !== undefined && { params }),
    }) as Promise<{ rows: Row[] }>;
  }

  async exec(
    sql: string,
    params?: SqliteQueryInput["params"],
  ): Promise<void> {
    await this.#client.call(this.#name, "exec", {
      sql,
      ...(params !== undefined && { params }),
    });
  }

  subscribeInvalidation(listener: () => void): () => void {
    return this.#client.subscribeResource(this.#name, () => listener());
  }
}

type PendingRequest = {
  resolve: (value: FabricValue | undefined) => void;
  reject: (error: unknown) => void;
};

type Subscription = {
  update: (value: FabricValue | undefined) => void;
  error?: (error: unknown) => void;
};

/** Guest connection to the resources granted by the embedding host. */
export class FabricClient {
  #port: MessagePort | undefined;
  #nextRequestId = 0;
  #nextSubscriptionId = 0;
  #pending = new Map<number, PendingRequest>();
  #queued: BridgeRequest[] = [];
  #subscriptions = new Map<string, Subscription>();
  #cells = new Map<string, RemoteCell>();
  #disconnected = false;

  constructor() {
    globalThis.addEventListener("message", this.#onHandoff);
  }

  describe(): Promise<BridgeManifest> {
    return this.request("describe") as Promise<BridgeManifest>;
  }

  cell<T = FabricValue>(name: string): RemoteCell<T> {
    let cell = this.#cells.get(name);
    if (!cell) {
      cell = new RemoteCell(this, name);
      this.#cells.set(name, cell);
    }
    return cell as unknown as RemoteCell<T>;
  }

  sqlite(name: string): RemoteSqlite {
    return new RemoteSqlite(this, name);
  }

  call(
    resource: string,
    method: string,
    value?: FabricValue,
  ): Promise<FabricValue | undefined> {
    return this.request("call", { resource, method, value });
  }

  request(
    operation: BridgeOperation,
    fields: Partial<
      Omit<
        BridgeRequest,
        "protocol" | "version" | "type" | "id" | "operation"
      >
    > = {},
  ): Promise<FabricValue | undefined> {
    if (this.#disconnected) {
      return Promise.reject(
        new FabricBridgeError({
          code: "disconnected",
          message: "The Fabric bridge is disconnected.",
        }),
      );
    }
    const id = this.#nextRequestId++;
    const request: BridgeRequest = {
      protocol: BRIDGE_PROTOCOL,
      version: BRIDGE_VERSION,
      type: "request",
      id,
      operation,
      ...fields,
    };
    const result = new Promise<FabricValue | undefined>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
    });
    if (this.#port) this.#send(request);
    else this.#queued.push(request);
    return result;
  }

  subscribeResource(
    resource: string,
    update: (value: FabricValue | undefined) => void,
    error?: (error: unknown) => void,
  ): () => void {
    const subscription = `subscription-${this.#nextSubscriptionId++}`;
    this.#subscriptions.set(subscription, { update, error });
    void this.request("subscribe", { resource, subscription }).catch(
      (cause) => {
        this.#subscriptions.delete(subscription);
        error?.(cause);
      },
    );
    return () => {
      this.#subscriptions.delete(subscription);
      void this.request("unsubscribe", { resource, subscription }).catch(
        () => {},
      );
    };
  }

  disconnect(): void {
    if (this.#disconnected) return;
    this.#disconnected = true;
    globalThis.removeEventListener("message", this.#onHandoff);
    if (this.#port) {
      this.#send({
        protocol: BRIDGE_PROTOCOL,
        version: BRIDGE_VERSION,
        type: "request",
        id: this.#nextRequestId++,
        operation: "disconnect",
      });
    }
    this.#port?.close();
    this.#port = undefined;
    const error = new FabricBridgeError({
      code: "disconnected",
      message: "The Fabric bridge disconnected before the operation completed.",
    });
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    this.#subscriptions.clear();
    this.#queued = [];
  }

  #send(request: BridgeRequest): void {
    this.#port?.postMessage(realmFromFabricValue(request));
  }

  #onHandoff = (event: MessageEvent): void => {
    // The host owns the outer frame and posts directly to this inner guest, so
    // it is two parent hops away. The guest has an opaque origin and cannot
    // origin-check that post, but it can still refuse a port offered by any
    // other window.
    const expectedHost = globalThis.parent?.parent;
    if (
      this.#port || event.data !== GUEST_PORT_HANDOFF || !event.ports[0] ||
      (expectedHost && event.source !== expectedHost)
    ) return;
    this.#port = event.ports[0];
    this.#port.onmessage = this.#onPortMessage;
    this.#port.start();
    for (const request of this.#queued) this.#send(request);
    this.#queued = [];
  };

  #onPortMessage = (event: MessageEvent): void => {
    let decoded: FabricValue;
    try {
      decoded = fabricFromRealmValue(event.data);
    } catch {
      return;
    }
    if (!isBridgeHostMessage(decoded)) return;
    this.#accept(decoded);
  };

  #accept(message: BridgeHostMessage): void {
    if (message.type === "event") {
      this.#subscriptions.get(message.subscription)?.update(message.value);
      return;
    }
    const pending = this.#pending.get(message.id);
    if (!pending) return;
    this.#pending.delete(message.id);
    if (message.ok) pending.resolve(message.value);
    else pending.reject(new FabricBridgeError(message.error));
  }
}

/** Connects to the capability port supplied by the embedding iframe host. */
export function connectFabric(): FabricClient {
  return new FabricClient();
}

/** Raises an alarm without relying on the bridge port. */
export function reportGuestError(error: GuestError): void {
  globalThis.parent.postMessage({ type: "error", data: error }, "*");
}
