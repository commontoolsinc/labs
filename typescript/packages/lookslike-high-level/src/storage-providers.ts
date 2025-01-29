import type { EntityId, Cancel } from "@commontools/runner";
import { log } from "./storage.js";
import { fromJSON, refer, type Reference } from "merkle-reference";
import z from "zod";
import type { State, In, ReplicaID, Entity, Fact, Unclaimed, Selector } from "@commontools/memory";

export interface StorageValue<T = any> {
  value: T;
  source?: EntityId;
}

export interface StorageProvider {
  /**
   * Send a value to storage.
   *
   * @param batch - Batch of entity IDs & values to send.
   * @returns Promise that resolves when the value is sent.
   */
  send<T = any>(batch: { entityId: EntityId; value: StorageValue<T> }[]): Promise<void>;

  /**
   * Sync a value from storage. Use `get()` to retrieve the value.
   *
   * @param entityId - Entity ID to sync.
   * @param expectedInStorage - Wait for the value, it's assumed to be in
   *   storage eventually.
   * @returns Promise that resolves when the value is synced.
   */
  sync(entityId: EntityId, expectedInStorage?: boolean): Promise<void>;

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
  sink<T = any>(entityId: EntityId, callback: (value: StorageValue<T>) => void): Cancel;

  /**
   * Destroy the storage provider. Used for tests only.
   *
   * @returns Promise that resolves when the storage provider is destroyed.
   */
  destroy(): Promise<void>;
}

abstract class BaseStorageProvider implements StorageProvider {
  protected subscribers = new Map<string, Set<(value: StorageValue) => void>>();
  protected waitingForSync = new Map<string, Promise<void>>();
  protected waitingForSyncResolvers = new Map<string, () => void>();

  abstract send<T = any>(batch: { entityId: EntityId; value: StorageValue<T> }[]): Promise<void>;

  abstract sync(entityId: EntityId, expectedInStorage: boolean): Promise<void>;

  abstract get<T = any>(entityId: EntityId): StorageValue<T> | undefined;

  sink<T = any>(entityId: EntityId, callback: (value: StorageValue<T>) => void): Cancel {
    const key = JSON.stringify(entityId);

    if (!this.subscribers.has(key))
      this.subscribers.set(key, new Set<(value: StorageValue) => void>());
    const listeners = this.subscribers.get(key)!;
    listeners.add(callback);

    return () => {
      listeners.delete(callback);
      if (listeners.size === 0) this.subscribers.delete(key);
    };
  }

  protected notifySubscribers(key: string, value: StorageValue): void {
    log("notify subscribers", key, JSON.stringify(value));
    const listeners = this.subscribers.get(key);
    if (this.waitingForSync.has(key) && listeners && listeners.size > 0)
      throw new Error("Subscribers are expected to only start after first sync.");
    this.resolveWaitingForSync(key);
    if (listeners) for (const listener of listeners) listener(value);
  }

  protected waitForSync(key: string): Promise<void> {
    if (!this.waitingForSync.has(key))
      this.waitingForSync.set(key, new Promise((r) => this.waitingForSyncResolvers.set(key, r)));
    log("waiting for sync", key, [...this.waitingForSync.keys()]);
    return this.waitingForSync.get(key)!;
  }

  protected resolveWaitingForSync(key: string): void {
    const resolver = this.waitingForSyncResolvers.get(key);
    if (resolver) {
      resolver();
      this.waitingForSync.delete(key);
    }
  }

  abstract destroy(): Promise<void>;
}
/**
 * In-memory storage provider. Just for testing.
 *
 * It doesn't make much sense,  since it's just a copy of the in memory cells.
 * But for testing we can create multiple instances that share the memory.
 */
const inMemoryStorage = new Map<string, StorageValue>();
const inMemoryStorageSubscribers = new Set<(key: string, value: StorageValue) => void>();
export class InMemoryStorageProvider extends BaseStorageProvider {
  private handleStorageUpdateFn: (key: string, value: any) => void;
  private lastValues = new Map<string, string | undefined>();

  constructor() {
    super();
    this.handleStorageUpdateFn = this.handleStorageUpdate.bind(this);
    inMemoryStorageSubscribers.add(this.handleStorageUpdateFn);
  }

  private handleStorageUpdate(key: string, value: StorageValue) {
    const valueString = JSON.stringify(value);
    if (this.lastValues.get(key) !== valueString) {
      this.lastValues.set(key, valueString);
      this.notifySubscribers(key, value);
    }
  }

  async send<T = any>(batch: { entityId: EntityId; value: StorageValue<T> }[]): Promise<void> {
    for (const { entityId, value } of batch) {
      const key = JSON.stringify(entityId);
      const valueString = JSON.stringify(value);
      if (this.lastValues.get(key) !== valueString) {
        log("send in memory", key, valueString);
        this.lastValues.set(key, valueString);
        inMemoryStorage.set(key, value);
        inMemoryStorageSubscribers.forEach((listener) => listener(key, value));
      }
    }
  }

  async sync(entityId: EntityId, expectedInStorage: boolean = false): Promise<void> {
    const key = JSON.stringify(entityId);
    log("sync in memory", key, this.lastValues.get(key));
    if (inMemoryStorage.has(key))
      this.lastValues.set(key, JSON.stringify(inMemoryStorage.get(key)!));
    else if (expectedInStorage)
      return Promise.resolve(); // nothing to sync
    else this.lastValues.delete(key);
  }

  get<T>(entityId: EntityId): StorageValue<T> | undefined {
    const key = JSON.stringify(entityId);
    log("get in memory", key, this.lastValues.get(key));
    return this.lastValues.has(key)
      ? (JSON.parse(this.lastValues.get(key)!) as StorageValue)
      : undefined;
  }

  async destroy(): Promise<void> {
    inMemoryStorageSubscribers.delete(this.handleStorageUpdateFn);
    inMemoryStorage.clear();
    this.subscribers.clear();
  }
}

/**
 * Local storage provider for browser.
 */
export class LocalStorageProvider extends BaseStorageProvider {
  private prefix: string;
  private lastValues = new Map<string, string | undefined>();

  private handleStorageEventFn: (event: StorageEvent) => void;

  constructor(prefix: string = "common_storage_") {
    if (typeof window === "undefined" || !window.localStorage)
      throw new Error("LocalStorageProvider is not supported in the browser");
    super();
    this.prefix = prefix;
    this.handleStorageEventFn = this.handleStorageEvent.bind(this);
    window.addEventListener("storage", this.handleStorageEventFn);
  }

  async send<T = any>(batch: { entityId: EntityId; value: StorageValue<T> }[]): Promise<void> {
    for (const { entityId, value } of batch) {
      const key = this.getKey(entityId);
      const storeValue = JSON.stringify(value);
      if (this.lastValues.get(key) !== storeValue) {
        if ((localStorage.getItem(key) ?? undefined) !== this.lastValues.get(key)) {
          log(
            "localstorage changed, aborting update",
            key,
            localStorage.getItem(key),
            this.lastValues.get(key) ?? null,
            storeValue,
          );
          // Storage changed while we were processing, and we assume LWW, so
          // we'll skip the update. The storage change will trigger an event, so
          // we'll get the other state soon.
          continue;
        } else {
          localStorage.setItem(key, storeValue);
          this.lastValues.set(key, storeValue);
          log("send localstorage", key, storeValue.length, storeValue);
        }
      }
    }
  }

  async sync(entityId: EntityId, expectedInStorage: boolean = false): Promise<void> {
    const key = this.getKey(entityId);
    const value = localStorage.getItem(key);
    log("sync localstorage", key, value);
    if (value === null)
      if (expectedInStorage) {
        // Timeout of 1 second to allow for the value to be set by another tab.
        // This is more than enough, since the race condition we're looking for
        // is just that a batch is written by the other tab, and we encounter a
        // dependency in the beginning of the batch before the whole batch is
        // written.
        setTimeout(() => this.resolveWaitingForSync(this.entityIdStrFromKey(key)), 1000);
        return this.waitForSync(this.entityIdStrFromKey(key));
      } else this.lastValues.delete(key);
    else this.lastValues.set(key, value);
  }

  get<T>(entityId: EntityId): StorageValue<T> | undefined {
    const key = this.getKey(entityId);
    const value = this.lastValues.get(key);
    log("get localstorage", key, value);
    if (value === null || value === undefined) return undefined;
    else return JSON.parse(value) as StorageValue<T>;
  }

  async destroy(): Promise<void> {
    window.removeEventListener("storage", this.handleStorageEventFn);
    log("clear localstorage", this.prefix);
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith(this.prefix)) {
        localStorage.removeItem(key);
      }
    }
    this.subscribers.clear();
  }

  private getKey(entityId: EntityId): string {
    return this.prefix + JSON.stringify(entityId);
  }

  private entityIdStrFromKey(key: string): string {
    return key.slice(this.prefix.length);
  }

  private handleStorageEvent = (event: StorageEvent) => {
    if (event.key?.startsWith(this.prefix)) {
      // Read the latest value from store instead of using event.newValue, since
      // event might have been queued for a while and the value might have
      // changed.
      const newValue = localStorage.getItem(event.key);
      if (this.lastValues.get(event.key) !== newValue) {
        log(
          "storage event",
          event.key,
          newValue?.length,
          this.lastValues.get(event.key)?.length,
          "new:",
          newValue,
          "old:",
          this.lastValues.get(event.key),
        );
        if (newValue === null) this.lastValues.delete(event.key);
        else this.lastValues.set(event.key, newValue);
        const result = newValue !== null ? JSON.parse(newValue) : {};
        this.notifySubscribers(this.entityIdStrFromKey(event.key), result);
      }
    }
  };
}

type Revision<T extends Fact | Unclaimed = Fact | Unclaimed> = {
  this: Reference<T>;
  value: T;
};

export class RemoteStorageProvider extends BaseStorageProvider {
  static State = z.object({
    the: z.string(),
    of: z.string(),
    is: z
      .unknown({})
      .optional()
      .refine((value) => {
        if (value && typeof (value as Record<string, unknown>)["/"] === "string") {
          return fromJSON(value as { "/": string });
        } else {
          return value;
        }
      }),
    cause: z
      .object({
        "/": z.string(),
      })
      .refine(fromJSON)
      .optional(),
  });

  static Update = z.record(RemoteStorageProvider.State);
  connection: WebSocket | null;

  constructor(
    public address: URL,
    public replica: ReplicaID = "common-knowledge",
    public the: string = "application/json",
    public subscriptions: Map<string, In<Selector>> = new Map(),
    public local: Map<ReplicaID, Map<Entity, Revision>> = new Map(),
    public consumers: Map<string, Set<() => void>> = new Map(),
  ) {
    super();
    this.connection = this.open(new WebSocket(address.href));
  }

  space(id: ReplicaID): Map<Entity, Revision> {
    const space = this.local.get(id);
    if (space) {
      return space;
    } else {
      const space = new Map();
      this.local.set(id, space);
      return space;
    }
  }

  revision(entity: Entity): Revision | undefined {
    const space = this.space(this.replica);
    const revision = space.get(entity);
    if (revision) {
      return revision;
    }
  }

  subscribe(selectors: In<Selector>): void {
    for (const [replica, selector] of Object.entries(selectors)) {
      const address = `${replica}/${selector.of}/${selector.the}`;
      this.subscriptions.set(address, { [replica]: selector });
    }

    this.connection?.send(JSON.stringify(selectors));
  }

  async sync(entityId: EntityId, expectedInStorage: boolean = false): Promise<void> {
    const entity = entityId.toString();
    const revision = this.revision(entity);
    if (!revision) {
      this.subscribe({
        [this.replica]: {
          the: this.the,
          of: entity,
        },
      });

      // TODO: Not sure I understand how behavior should be changed when
      // `expectedInStorage` is true vs false. 🤔 Should we not resume
      // if we remote tells use entity is unclaimed and `expectedInStorage`
      // is true?
      return new Promise((resume) => {
        const waiting = this.consumers.get(entity);
        if (waiting) {
          waiting.add(resume);
        } else {
          this.consumers.set(entity, new Set([resume]));
        }
      });
    }
  }

  get<T = any>(entityId: EntityId): StorageValue<T> | undefined {
    const revision = this.revision(entityId.toString());
    // TODO: Not sue what to do if the remote value does not match the
    // `StorageValue<T>`.
    return revision ? (revision.value.is as StorageValue<T> | undefined) : undefined;
  }
  async send<T = any>(changes: { entityId: EntityId; value: StorageValue<T> }[]): Promise<void> {
    const promises = [];
    for (const { entityId, value } of changes) {
      const of = entityId.toString();
      const assertion = {
        the: this.the,
        of: entityId.toString(),
        is: value,
        cause: this.revision(of),
      };

      // TODO: We may get a conflict here, and need to handle it somehow.
      promises.push(
        fetch(this.address.href, {
          method: "PATCH",
          body: JSON.stringify({ [this.replica]: assertion }),
        }),
      );
    }

    await Promise.all(promises);
  }

  receive(data: string) {
    const update = RemoteStorageProvider.Update.parse(JSON.parse(data)) as In<State>;
    for (const [at, state] of Object.entries(update)) {
      let space = this.space(at);

      const remote = Object.entries(state) as [Entity, Fact | Unclaimed][];
      for (const [entity, fact] of remote) {
        const before = this.revision(entity);
        const after = { this: refer(fact), value: fact };
        if (before?.this?.toString() !== after.this.toString()) {
          space.set(entity, after);

          const consumers = this.consumers.get(entity);
          for (const consumer of consumers ?? []) {
            consumer();
          }
        }
      }
    }
  }

  handleEvent(event: MessageEvent) {
    switch (event.type) {
      case "message":
        return this.receive(event.data);
      case "open":
        return this.connect(event.target as WebSocket);
      case "close":
        return this.disconnect(event);
      case "error":
        return this.disconnect(event);
    }
  }
  open(socket: WebSocket) {
    socket.addEventListener("message", this);
    socket.addEventListener("open", this);
    socket.addEventListener("close", this);
    socket.addEventListener("error", this);
    return socket;
  }

  connect(_socket: WebSocket) {
    for (const selector of this.subscriptions.values()) {
      this.connection?.send(JSON.stringify({ watch: selector }));
    }
  }

  disconnect(event: Event) {
    const socket = event.target as WebSocket;
    // If connection is `null` provider was closed and we do nothing on
    // disconnect.
    if (this.connection === socket) {
      this.connection = this.open(new WebSocket(this.address.href));
    }
  }

  async close(): Promise<{}> {
    const { connection } = this;
    this.connection = null;
    if (connection && connection.readyState !== WebSocket.CLOSED) {
      connection.close();
      return RemoteStorageProvider.closed(connection);
    } else {
      return {};
    }
  }
  async destroy(): Promise<void> {
    await this.close();
  }

  /**
   * Creates a promise that succeeds when the socket is closed or fails with
   * the error event if the socket errors.
   */
  static closed(socket: WebSocket) {
    if (socket.readyState === WebSocket.CLOSED) {
      return {};
    } else {
      return new Promise((succeed, fail) => {
        socket.addEventListener(
          "close",
          () => {
            succeed({});
          },
          { once: true },
        );
        socket.addEventListener(
          "error",
          (event) => {
            fail(event);
          },
          { once: true },
        );
      });
    }
  }
}
