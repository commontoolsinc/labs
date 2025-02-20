import type { EntityId, Cancel } from "@commontools/runner";
import { log } from "../storage.js";
import { type StorageProvider, type StorageValue } from "./base.js";
import type { Entity, JSONValue, MemorySpace } from "@commontools/memory/interface";
import * as Memory from "@commontools/memory/consumer";
import { assert } from "@commontools/memory/fact";
import * as Changes from "@commontools/memory/changes";
export * from "@commontools/memory/interface";

interface Local<Space extends MemorySpace = MemorySpace> {
  memory: Memory.MemorySpaceSession<Space>;
  queries: Map<Entity, Query<Space>>;
}

/**
 * ed25519 key derived from the sha256 of the "common knowledge".
 */
const HOME = "did:key:z6Mko2qR9b8mbdPnaEKXvcYwdK7iDnRkh8mEcEP2719aCu6P";
/**
 * ed25519 key derived from the sha256 of the "common operator".
 */
const AS = "did:key:z6Mkge3xkXc4ksLsf8CtRxunUxcX6dByT4QdWCVEHbUJ8YVn";
export class RemoteStorageProvider implements StorageProvider {
  connection: WebSocket | null = null;
  address: URL;
  workspace: MemorySpace;
  the: string;
  local: Map<MemorySpace, Local> = new Map();
  session: Memory.MemorySession;

  /**
   * queue that holds commands that we read from the session, but could not
   * send because connection was down.
   */
  queue: Set<Memory.ConsumerCommand<Memory.Protocol>> = new Set();
  writer: WritableStreamDefaultWriter<Memory.ProviderCommand<Memory.Protocol>>;
  reader: ReadableStreamDefaultReader<Memory.ConsumerCommand<Memory.Protocol>>;

  connectionCount = 0;

  constructor({
    address,
    as = AS,
    space = HOME,
    the = "application/json",
  }: {
    address: URL;
    as?: Memory.Principal;
    space?: MemorySpace;
    the?: string;
  }) {
    this.address = address;
    this.workspace = space;
    this.the = the;

    const session = Memory.create({ as });
    this.reader = session.readable.getReader();
    this.writer = session.writable.getWriter();
    this.session = session;

    this.connect();
  }

  mount(space: MemorySpace): Local {
    const local = this.local.get(space);
    if (local) {
      return local;
    } else {
      const local = {
        memory: this.session.mount(space),
        queries: new Map(),
      };

      this.local.set(space, local);
      return local;
    }
  }

  static toEntity(source: EntityId): Entity {
    if (typeof source["/"] === "string") {
      return `of:${source["/"]}`;
    } else if (source.toJSON) {
      return `of:${source.toJSON()["/"]}`;
    } else {
      throw Object.assign(
        new TypeError(`💣 Got entity ID that is neither merkle reference nor {'/'}`),
        {
          cause: source,
        },
      );
    }
  }

  sink<T = any>(entityId: EntityId, callback: (value: StorageValue<T>) => void): Cancel {
    const { the } = this;
    const of = RemoteStorageProvider.toEntity(entityId);
    const local = this.mount(this.workspace);
    // ⚠️ Types are incorrect because when there is no value we still want to
    // notify the subscriber.
    const subscriber = callback as unknown as Subscriber;
    let query = local.queries.get(of);
    if (!query) {
      query = new Query(local.memory.query({ select: { [of]: { [the]: {} } } }));
      local.queries.set(of, query);
    }

    return query.subscribe(subscriber);
  }
  async sync(entityId: EntityId): Promise<void> {
    const { the } = this;
    // Just wait to have a local revision.
    const of = RemoteStorageProvider.toEntity(entityId);
    const local = this.mount(this.workspace);
    let query = local.queries.get(of);
    if (query) {
      query.subscribe(RemoteStorageProvider.sync);
    } else {
      const query = local.memory.query({ select: { [of]: { [the]: {} } } });
      local.queries.set(of, new Query(query, new Set([RemoteStorageProvider.sync])));

      await query.promise;
    }
  }

  /**
   * Subscriber used by the .sync. We use the same one so we'll have at most one
   * per `.sync` per query.
   */
  static sync(value: JSONValue | undefined) {}

  get<T = any>(entityId: EntityId): StorageValue<T> | undefined {
    const of = RemoteStorageProvider.toEntity(entityId);
    const local = this.mount(this.workspace);
    const query = local.queries.get(of);

    return query?.value as StorageValue<T> | undefined;
  }
  async send<T = any>(changes: { entityId: EntityId; value: StorageValue<T> }[]): Promise<void> {
    const { the } = this;
    const local = this.mount(this.workspace);
    const facts = [];

    for (const { entityId, value } of changes) {
      const of = RemoteStorageProvider.toEntity(entityId);
      const query = local.queries.get(of);
      const content = JSON.stringify(value);

      // If a revision exists and its current value is identical to the new value,
      // skip sending a PATCH.
      if (query && JSON.stringify(query.value) === content) {
        log("RemoteStorageProvider.send: no change detected for", of);
        continue;
      }

      facts.push(
        assert({
          the,
          of,
          // Convert the new value into the format expected by the remote API.
          is: JSON.parse(content) as unknown as JSONValue,
          cause: query?.fact,
        }),
      );
    }

    const result = await local.memory.transact({ changes: Changes.from(facts) });
    if (result.error) {
      console.error(`🙅‍♂️`, result.error);
    }
  }

  receive(data: string) {
    return this.writer.write(JSON.parse(data));
  }

  handleEvent(event: MessageEvent) {
    switch (event.type) {
      case "message":
        return this.receive(event.data);
      case "open":
        return this.open(event.target as WebSocket);
      case "close":
        return this.disconnect(event);
      case "error":
        return this.disconnect(event);
    }
  }
  connect() {
    const { connection } = this;
    // If we already have a connection we remove all the listeners from it.
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

    this.connectionCount += 1;
  }

  async open(socket: WebSocket) {
    const { reader, queue } = this;

    // If we did have connection
    if (this.connectionCount > 1) {
      for (const local of this.local.values()) {
        for (const query of local.queries.values()) {
          query.reconnect();
        }
      }
    }

    while (this.connection === socket) {
      // First drain the queued commands if we have them.
      for (const command of queue) {
        socket.send(JSON.stringify(command));
        queue.delete(command);
      }

      // Next read next command from the session.
      const next = await reader.read();
      // If session is closed we're done.
      if (next.done) {
        this.close();
      }

      const command = next.value!;

      // Now we make that our socket is still a current connection as we may
      // have lost connection while waiting to read a command.
      if (this.connection === socket) {
        socket.send(JSON.stringify(command));
      }
      // If it is no longer our connection we simply add the command into a
      // queue so it will be send once connection is reopen.
      else {
        this.queue.add(command);
        break;
      }
    }
  }

  disconnect(event: Event) {
    const socket = event.target as WebSocket;
    // If connection is `null` provider was closed and we do nothing on
    // disconnect.
    if (this.connection === socket) {
      this.connect();
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
    return this.workspace;
  }
}

export interface Subscriber {
  (value: JSONValue | undefined): void;
}

class Query<Space extends MemorySpace> {
  reader: ReadableStreamDefaultReader;
  constructor(
    public query: Memory.QueryView<Space>,
    public subscribers: Set<Subscriber> = new Set(),
  ) {
    this.reader = query.subscribe().getReader();
    this.poll();
  }
  get value(): JSONValue | undefined {
    return this.query.facts?.[0]?.is;
  }
  get fact() {
    return this.query.facts[0];
  }

  broadcast() {
    const { value } = this;
    for (const subscriber of this.subscribers) {
      subscriber(value);
    }
  }
  async poll() {
    const { reader } = this;
    while (true) {
      const next = await reader.read();
      if (next.done) {
        break;
      } else {
        this.broadcast();
      }
    }
  }

  reconnect() {
    // TODO: We could make it possible to rerun the subscription
    this.reader.cancel();
    this.reader = this.query.subscribe().getReader();
    this.poll();
  }

  subscribe(subscriber: Subscriber): Cancel {
    this.subscribers.add(subscriber);
    return () => this.unsubscribe.bind(this, subscriber);
  }
  unsubscribe(subscriber: Subscriber) {
    this.subscribers.delete(subscriber);
  }
}
