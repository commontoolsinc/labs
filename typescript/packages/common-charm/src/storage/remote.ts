import type { EntityId, Cancel } from "@commontools/runner";
import { log } from "../storage.js";
import { type StorageProvider, type StorageValue } from "./base.js";
import { fromJSON, refer, type Reference } from "merkle-reference";
import z from "zod";
import type {
  State,
  In,
  ReplicaID,
  Entity,
  Unclaimed,
  Selector,
  Fact,
  ConflictError,
  TransactionError,
  Transaction,
  Result,
  Command,
  ConnectionError,
  JSONValue,
  AsyncResult,
} from "@commontools/memory";

type Revision<T extends Fact | Unclaimed = Fact | Unclaimed> = {
  at: ReplicaID;
  this: Reference<T>;
  value: T;
};

export class RemoteStorageProvider implements StorageProvider {
  static State = z.object({
    the: z.string(),
    of: z.string(),
    is: z
      .unknown({})
      .transform((value) => {
        if (value && typeof (value as Record<string, unknown>)["/"] === "string") {
          return fromJSON(value as { "/": string });
        } else {
          return value;
        }
      })
      .optional(),
    cause: z
      .object({
        "/": z.string(),
      })
      .transform((value) => {
        return fromJSON(value);
      })
      .optional(),
  });

  static Update = z.record(RemoteStorageProvider.State);
  connection: WebSocket | null = null;
  session: Promise<WebSocket>;
  address: URL;
  replica: ReplicaID;
  the: string;

  subscriptions: Map<string, In<Selector>> = new Map();
  subscribers: Map<string, Set<Subscriber>> = new Map();
  local: Map<ReplicaID, Map<Entity, Revision>> = new Map();
  constructor({
    address,
    replica = "common-knowledge",
    the = "application/json",
  }: {
    address: URL;
    replica?: ReplicaID;
    the?: string;
  }) {
    this.address = address;
    this.replica = replica;
    this.the = the;
    this.session = this.open();
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
    return;
  }

  async perform(command: Command) {
    const session = await this.session;
    if (command.unwatch) {
      session.send(JSON.stringify(command));
    } else if (command.watch) {
      session.send(JSON.stringify(command));
    }
  }

  async transact(
    transaction: In<Transaction>,
  ): AsyncResult<Fact, ConflictError | TransactionError | ConnectionError> {
    const response = await fetch(this.address.href, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(transaction),
    });

    const result = (await response.json()) as Result<
      Fact,
      ConflictError | TransactionError | ConnectionError
    >;

    if (result.error) {
      return result;
    } else {
      return { ok: RemoteStorageProvider.State.parse(result.ok) as Fact };
    }
  }

  static formatAddress(space: ReplicaID, { of, the }: Selector) {
    return `watch://${space}/${of}/${the}`;
  }
  static toEntity(source: EntityId) {
    if (typeof source["/"] === "string") {
      return source["/"];
    } else if (source.toJSON) {
      return source.toJSON()["/"];
    } else {
      throw Object.assign(
        new TypeError(`💣 Got entity ID that is neither merkle reference nor {'/'}`),
        {
          cause: source,
        },
      );
    }
  }

  unwatch(selectors: In<Selector>, subscriber: Subscriber): void {
    for (const [replica, selector] of Object.entries(selectors)) {
      const address = RemoteStorageProvider.formatAddress(replica, selector);
      const subscribers = this.subscribers.get(address);
      if (subscriber) {
        if (subscribers) {
          subscribers.delete(subscriber);
          if (subscribers.size === 0) {
            this.subscribers.delete(address);
            // this.perform({ unwatch: { [replica]: selector } });
          }
        }
      }
    }
  }

  watch(selectors: In<Selector>, subscriber: Subscriber): void {
    for (const [replica, selector] of Object.entries(selectors)) {
      const address = RemoteStorageProvider.formatAddress(replica, selector);
      if (!this.subscriptions.has(address)) {
        this.subscriptions.set(address, { [replica]: selector });
        this.perform({ watch: { [replica]: selector } });
      }

      const subscribers = this.subscribers.get(address);
      if (subscriber) {
        if (subscribers) {
          subscribers.add(subscriber);
        } else {
          this.subscribers.set(address, new Set([subscriber]));
        }
      }
    }
  }

  sink<T = any>(entityId: EntityId, callback: (value: StorageValue<T>) => void): Cancel {
    const of = RemoteStorageProvider.toEntity(entityId);

    const selector = { [this.replica]: { the: this.the, of } };
    const subscriber = new Sink(this, selector, callback as (value: StorageValue<unknown>) => void);

    this.watch(selector, subscriber);

    return subscriber.cancel;
  }
  async sync(entityId: EntityId, expectedInStorage: boolean = false): Promise<void> {
    // Just wait to have a local revision.
    const of = RemoteStorageProvider.toEntity(entityId);
    const revision = this.revision(of);
    // We need to wait if we don't have a local revision, or if if we have a
    // retracted or unclaimed state while expecting value to be in storage.
    const wait = !revision
      ? true
      : revision.value.is === undefined && expectedInStorage
        ? true
        : false;

    if (wait) {
      const selector = { [this.replica]: { the: this.the, of } };
      const subscriber = new Sync(this, selector, expectedInStorage);
      this.watch(selector, subscriber);
      await subscriber.promise;
    }
  }

  get<T = any>(entityId: EntityId): StorageValue<T> | undefined {
    // Does not exists return `undefined`, if not an object return `{}`
    const of = RemoteStorageProvider.toEntity(entityId);

    const revision = this.revision(of);

    const value = revision ? (revision.value.is as StorageValue<T> | undefined) : undefined;
    return value;
  }
  async send<T = any>(changes: { entityId: EntityId; value: StorageValue<T> }[]): Promise<void> {
    const promises = [];
    const { the } = this;
    for (const { entityId, value: newValue } of changes) {
      const of = RemoteStorageProvider.toEntity(entityId);
      const currentRevision = this.revision(of);
      // If a revision exists and its current value is identical to the new value,
      // skip sending a PATCH.
      if (
        currentRevision &&
        JSON.stringify(currentRevision.value.is) === JSON.stringify(newValue)
      ) {
        log("RemoteStorageProvider.send: no change detected for", of);
        continue;
      }

      const assertion = {
        the,
        of,
        // Convert the new value into the format expected by the remote API.
        is: newValue as unknown as JSONValue,
        cause: currentRevision?.this,
      };

      promises.push(
        this.transact({
          [this.replica]: {
            assert: {
              ...assertion,
              cause: assertion.cause as Reference<Fact> | null | undefined,
            },
          },
        }),
      );
    }

    const results = await Promise.all(promises);
    for (const result of results) {
      if (result.error) {
        console.error(`🙅‍♂️`, result.error);
      }
    }
  }

  update(remote: Revision) {
    const space = this.space(remote.at);
    const local = this.revision(remote.value.of);
    if (local?.this.toString() !== remote.this.toString()) {
      space.set(remote.value.of, remote);
      const { value } = remote;

      const address = RemoteStorageProvider.formatAddress(remote.at, value);
      const subscribers = this.subscribers.get(address);
      for (const subscriber of subscribers ?? []) {
        subscriber.integrate(value);
      }
    }
  }

  receive(data: string) {
    const update = RemoteStorageProvider.Update.parse(JSON.parse(data)) as In<State>;

    for (const [at, state] of Object.entries(update)) {
      this.update({ at, this: refer(state), value: state });
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
  open(): Promise<WebSocket> {
    const { connection } = this;
    if (connection) {
      connection.removeEventListener("message", this);
      connection.removeEventListener("open", this);
      connection.removeEventListener("close", this);
      connection.removeEventListener("error", this);
    }

    const socket = new WebSocket(this.address.href);
    this.connection = socket;
    socket.addEventListener("message", this);
    socket.addEventListener("open", this);
    socket.addEventListener("close", this);
    socket.addEventListener("error", this);

    return RemoteStorageProvider.opened(socket);
  }

  connect(_socket: WebSocket) {
    for (const selector of this.subscriptions.values()) {
      this.perform({ watch: selector });
    }
  }

  disconnect(event: Event) {
    const socket = event.target as WebSocket;
    // If connection is `null` provider was closed and we do nothing on
    // disconnect.
    if (this.connection === socket) {
      this.open();
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
  static async opened(socket: WebSocket) {
    if (socket.readyState === WebSocket.CONNECTING) {
      await new Promise((resolve) => {
        socket.addEventListener("open", resolve, { once: true });
        socket.addEventListener("error", resolve, { once: true });
      });
    }

    switch (socket.readyState) {
      case WebSocket.OPEN:
        return socket;
      case WebSocket.CLOSING:
        throw new Error(`Socket is closing`);
      case WebSocket.CLOSED:
        throw new Error(`Socket is closed`);
      default:
        throw new Error(`Socket is in unknown state`);
    }
  }

  getReplica(): string {
    return this.replica;
  }
}

abstract class Subscriber {
  constructor(
    public provider: RemoteStorageProvider,
    public selector: In<Selector>,
  ) {
    this.cancel = this.cancel.bind(this);
  }
  abstract integrate(state: State): void;
  cancel() {
    this.provider.unwatch(this.selector, this);
  }
}

class Sink extends Subscriber {
  constructor(
    provider: RemoteStorageProvider,
    selector: In<Selector>,
    public notify: (value: StorageValue<unknown>) => void,
  ) {
    super(provider, selector);
  }

  integrate(state: State) {
    // If state.is is undefined, we either have a retracted or an unclaimed
    // memory.
    if (state.is !== undefined) {
      const value =
        state.is === null || typeof state.is !== "object"
          ? ({} as StorageValue<unknown>)
          : (state.is as unknown as StorageValue<unknown>);

      this.notify(value);
    }
  }
}

class Sync extends Subscriber {
  promise: Promise<void>;
  notify?: () => void;
  constructor(
    provider: RemoteStorageProvider,
    selector: In<Selector>,
    public expectedInStorage: boolean = false,
  ) {
    super(provider, selector);
    this.promise = new Promise((notify) => (this.notify = notify));
  }
  integrate(state: State) {
    if (state.is !== undefined || !this.expectedInStorage) {
      this.notify!();
      this.cancel();
    }
  }
}
