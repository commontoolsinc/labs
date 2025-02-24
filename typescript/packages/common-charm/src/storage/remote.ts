import type { EntityId, Cancel } from "@commontools/runner";
import { log } from "../storage.js";
import { type StorageProvider, type StorageValue } from "./base.js";
import type { Entity, JSONValue, MemorySpace } from "@commontools/memory/interface";
import * as Memory from "@commontools/memory/consumer";
import { assert } from "@commontools/memory/fact";
import * as Changes from "@commontools/memory/changes";
export * from "@commontools/memory/interface";

/**
 * Represents a state of the memory space.
 */
interface MemoryState<Space extends MemorySpace = MemorySpace> {
  /**
   * Session to a remote memory space.
   */
  memory: Memory.MemorySpaceSession<Space>;
  /**
   * Local representation of the remote state. It holds set of active query
   * subscriptions that update state as we receive changes in our subscription.
   */
  remote: Map<Entity, Query<Space>>;

  /**
   * Local state of the memory space. It may be ahead of the `remote` if
   * changes occur faster than transaction roundtrip.
   */
  local: Map<Entity, Memory.Fact>;
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
  state: Map<MemorySpace, MemoryState> = new Map();
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
    as?: Memory.DID;
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

  mount(space: MemorySpace): MemoryState {
    const state = this.state.get(space);
    if (state) {
      return state;
    } else {
      const state = {
        memory: this.session.mount(space),
        remote: new Map(),
        local: new Map(),
      };

      this.state.set(space, state);
      return state;
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
    let query = local.remote.get(of);
    if (!query) {
      query = new Query(local.memory.query({ select: { [of]: { [the]: {} } } }));
      local.remote.set(of, query);
    }

    return query.subscribe(subscriber);
  }
  async sync(entityId: EntityId): Promise<void> {
    const { the } = this;
    // Just wait to have a local revision.
    const of = RemoteStorageProvider.toEntity(entityId);
    const local = this.mount(this.workspace);
    let query = local.remote.get(of);
    if (query) {
      query.subscribe(RemoteStorageProvider.sync);
    } else {
      const query = local.memory.query({ select: { [of]: { [the]: {} } } });
      local.remote.set(of, new Query(query, new Set([RemoteStorageProvider.sync])));

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
    const query = local.remote.get(of);

    return query?.value as StorageValue<T> | undefined;
  }
  async send<T = any>(
    changes: { entityId: EntityId; value: StorageValue<T> }[],
  ): Promise<Awaited<Memory.TransactionResult>> {
    const { the } = this;
    const { local, remote, memory } = this.mount(this.workspace);
    const facts = [];

    for (const { entityId, value } of changes) {
      const of = RemoteStorageProvider.toEntity(entityId);
      const content = JSON.stringify(value);
      // Cause is last fact for the the given `{ the, of }` pair. If we have a
      // a local fact we use that as it may be ahead, otherwise we use a remote
      // fact.
      const cause = local.get(of) ?? remote.get(of)?.fact;

      // If desired state is same as current state this is redundant and we skip
      if (cause && JSON.stringify(cause.is) === content) {
        log("RemoteStorageProvider.send: no change detected for", of);
        continue;
      }

      const fact = assert({
        the,
        of,
        // ⚠️ We do JSON roundtrips to strip of the undefined values that
        // cause problems with serialization.
        is: JSON.parse(content) as unknown as JSONValue,
        cause,
      });

      local.set(of, fact);
      facts.push(fact);
    }

    const result = await memory.transact({ changes: Changes.from(facts) });

    // Once we have a result of the transaction we clear out local facts we
    // created, we need to do this otherwise subsequent transactions will
    // continue assuming local state even though we may get some remote changes
    // since.
    for (const fact of facts) {
      // If transaction was rejected we simply discard the local fact for the
      // underlying entity even if current local fact has changed. That is
      // because new fact would have been based on the one that got rejected
      // and therefore will also be rejected later. If transaction succeeds we
      // still remove a local fact as long as it has not changed from the one
      // in our transaction. If it has changed we have another stacked change
      // and we need to keep it until transactions results catch up.
      // ⚠️ Please note that there may have being other transactions based on
      // this one that change other entities, but that those will also will get
      // rejected and when they will deal with clearing up contingent entities.
      //
      // ⚠️ It is worth calling out that in theory our `remote` may not have
      // caught up yet and removing local fact could cause a backslide until
      // remote catches up. In practice however memory provider sends subscribed
      // query updates ahead of transaction result on the same socket connection
      // so by this time `remote` should be up to date, which is why we choose
      // to avoid added complexity that would require handling described scenario.
      if (result.error || local.get(fact.of) === fact) {
        local.delete(fact.of);
      }
    }

    return result;
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
      for (const local of this.state.values()) {
        for (const query of local.remote.values()) {
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
