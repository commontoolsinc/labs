import type { Cancel, EntityId } from "@commontools/runner";
import { log } from "../storage.ts";
import { type StorageProvider, type StorageValue } from "./base.ts";
import type {
  Entity,
  JSONValue,
  MemorySpace,
  Protocol,
  Query,
  SchemaContext,
  SchemaQuery,
  UCAN,
} from "@commontools/memory/interface";
import * as Memory from "@commontools/memory/consumer";
import { assert } from "@commontools/memory/fact";
import * as Changes from "@commontools/memory/changes";
export * from "@commontools/memory/interface";
import * as Codec from "@commontools/memory/codec";
import { Channel, RawCommand } from "./inspector.ts";
import { isBrowser } from "@commontools/utils/env";
import type { JSONValue as BuilderJSONValue } from "@commontools/builder";

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
  remote: Map<Entity, Subscription<Space>>;

  /**
   * Local state of the memory space. It may be ahead of the `remote` if
   * changes occur faster than transaction roundtrip.
   */
  local: Map<Entity, Memory.Fact>;

  /**
   * Queued queries that aren't yet sent.
   */
  queue: Map<Entity, Subscription<Space>>;
}

/**
 * ed25519 key derived from the sha256 of the "common knowledge".
 */
const HOME = "did:key:z6Mko2qR9b8mbdPnaEKXvcYwdK7iDnRkh8mEcEP2719aCu6P";

export interface RemoteStorageProviderSettings {
  /**
   * Number of subscriptions remote storage provider is allowed to have per
   * space.
   */
  maxSubscriptionsPerSpace: number;

  /**
   * Amount of milliseconds we will spend waiting on WS connection before we
   * abort.
   */
  connectionTimeout: number;
}

export interface RemoteStorageProviderOptions {
  /**
   * Unique identifier of the storage. Used as scoping name in `Channel`
   * in order to allow inspection of the storage.
   */
  id: string;

  address: URL;
  as: Memory.Signer;
  space?: MemorySpace;
  the?: string;
  settings?: RemoteStorageProviderSettings;

  inspector?: Channel;
}

const defaultSettings: RemoteStorageProviderSettings = {
  maxSubscriptionsPerSpace: 50_000,
  connectionTimeout: 30_000,
};

export class RemoteStorageProvider implements StorageProvider {
  connection: WebSocket | null = null;
  address: URL;
  workspace: MemorySpace;
  the: string;
  state: Map<MemorySpace, MemoryState> = new Map();
  session: Memory.MemorySession<MemorySpace>;
  settings: RemoteStorageProviderSettings;

  inspector?: Channel;

  /**
   * queue that holds commands that we read from the session, but could not
   * send because connection was down.
   */
  queue: Set<UCAN<Memory.ConsumerCommandInvocation<Memory.Protocol>>> =
    new Set();
  writer: WritableStreamDefaultWriter<Memory.ProviderCommand<Memory.Protocol>>;
  reader: ReadableStreamDefaultReader<
    UCAN<Memory.ConsumerCommandInvocation<Memory.Protocol>>
  >;

  connectionCount = 0;
  timeoutID = 0;

  constructor({
    id,
    address,
    as,
    space = HOME,
    the = "application/json",
    settings = defaultSettings,
    inspector,
  }: RemoteStorageProviderOptions) {
    this.address = address;
    this.workspace = space;
    this.the = the;
    this.settings = settings;
    // Do not use a default inspector when in Deno:
    // Requires `--unstable-broadcast-channel` flags and it is not used
    // in that environment.
    this.inspector = isBrowser() ? (inspector ?? new Channel(id)) : undefined;
    this.handleEvent = this.handleEvent.bind(this);

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
        queue: new Map(),
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
        new TypeError(
          `💣 Got entity ID that is neither merkle reference nor {'/'}`,
        ),
        {
          cause: source,
        },
      );
    }
  }

  subscribe(entityId: EntityId, schemaContext?: SchemaContext) {
    const { the, inspector } = this;
    const of = RemoteStorageProvider.toEntity(entityId);
    const local = this.mount(this.workspace);
    let subscription = local.remote.get(of);

    if (!subscription) {
      if (local.remote.size < this.settings.maxSubscriptionsPerSpace) {
        const selector = (schemaContext === undefined)
          ? { select: { [of]: { [the]: {} } } }
          : {
            selectSchema: {
              [of]: {
                [the]: { "_": { path: [], schemaContext: schemaContext } },
              },
            },
          };

        // If we do not have a subscription yet we create a query and
        // subscribe to it.
        subscription = Subscription.spawn(local.memory, selector, inspector);

        // store subscription so it can be reused.
        local.remote.set(of, subscription);

        // We also want to add any subscriptions that should follow from that query
        if (schemaContext) {
          this.subscribeToContents(subscription);
        }
      }
    }

    return subscription;
  }

  sink<T = any>(
    entityId: EntityId,
    callback: (value: StorageValue<T>) => void,
  ): Cancel {
    const subscription = this.subscribe(entityId);
    if (subscription) {
      const of = RemoteStorageProvider.toEntity(entityId);
      // ⚠️ Types are incorrect because when there is no value we still want to
      // notify the subscriber.
      return subscription.subscribe(of, callback as unknown as Subscriber);
    } else {
      console.warn(
        `⚠️ Reached maximum subscription limit on ${this.workspace}. Call to .sink is ignored`,
      );
      return () => {};
    }
  }
  async sync(
    entityId: EntityId,
    _expectedInStorage: boolean = false,
    schemaContext?: SchemaContext,
  ): Promise<void> {
    const subscription = this.subscribe(entityId, schemaContext);
    if (subscription) {
      const of = RemoteStorageProvider.toEntity(entityId);
      // We add noop subscriber just to keep subscription alive.
      subscription.subscribe(of, RemoteStorageProvider.sync);
      // Then await for the query to be resolved because that is what
      // caller will await on.
      await subscription.query;
    } else {
      console.warn(
        `⚠️ Reached maximum subscription limit on ${this.workspace}. Call to .sync is ignored`,
      );
      return new Promise(() => {});
    }
  }

  /**
   * Subscriber used by the .sync. We use the same one so we'll have at most one
   * per `.sync` per query.
   */
  static sync(_value: JSONValue | undefined) {}

  get<T = any>(entityId: EntityId): StorageValue<T> | undefined {
    const of = RemoteStorageProvider.toEntity(entityId);
    const local = this.mount(this.workspace);
    const query = local.remote.get(of);

    return query?.getValue(of) as StorageValue<T> | undefined;
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
      const cause = local.get(of) ?? remote.get(of)?.getFact(of);

      // If desired state is same as current state this is redundant and we skip
      if (cause && JSON.stringify(cause.is) === content) {
        log(() => ["RemoteStorageProvider.send: no change detected for", of]);
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

    const transaction = { changes: Changes.from(facts) };

    const result = await memory.transact(transaction);

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

  parse(source: string): Memory.ProviderCommand<Memory.Protocol> {
    return Codec.Receipt.fromString(source);
  }

  onReceive(data: string) {
    return this.writer.write(
      this.inspect({ receive: this.parse(data) }).receive,
    );
  }

  inspect(
    message: RawCommand,
  ): RawCommand {
    this.inspector?.postMessage({
      ...message,
      time: Date.now(),
    });
    return message;
  }

  handleEvent(event: MessageEvent) {
    // clear if we had timeout pending
    clearTimeout(this.timeoutID);

    switch (event.type) {
      case "message":
        return this.onReceive(event.data);
      case "open":
        return this.onOpen(event.target as WebSocket);
      case "close":
        return this.onDisconnect(event);
      case "error":
        return this.onDisconnect(event);
      case "timeout":
        return this.onTimeout(event.target as WebSocket);
    }
  }
  connect() {
    const { connection } = this;
    // If we already have a connection we remove all the listeners from it.
    if (connection) {
      clearTimeout(this.timeoutID);
      connection.removeEventListener("message", this);
      connection.removeEventListener("open", this);
      connection.removeEventListener("close", this);
      connection.removeEventListener("error", this);
    }

    const webSocketUrl = new URL(this.address.href);
    webSocketUrl.searchParams.set("space", this.workspace);
    const socket = new WebSocket(webSocketUrl.href);
    this.connection = socket;
    // Start a timer so if connection is pending longer then `connectionTimeout`
    // we should abort and retry.
    this.setTimeout();
    socket.addEventListener("message", this);
    socket.addEventListener("open", this);
    socket.addEventListener("close", this);
    socket.addEventListener("error", this);

    this.connectionCount += 1;
  }

  setTimeout() {
    this.timeoutID = setTimeout(
      this.handleEvent,
      this.settings.connectionTimeout,
      { type: "timeout", target: this.connection },
    );
  }

  onTimeout(socket: WebSocket) {
    this.inspect({
      disconnect: {
        reason: "timeout",
        message:
          `Aborting connection after failure to connect in ${this.settings.connectionTimeout}ms`,
      },
    });

    if (this.connection === socket) {
      socket.close();
    }
  }

  async onOpen(socket: WebSocket) {
    const { reader, queue } = this;

    // Report connection to inspector
    this.inspect({
      connect: { attempt: this.connectionCount },
    });

    // If we did have connection
    if (this.connectionCount > 1) {
      for (const local of this.state.values()) {
        const uniqueRemotes = new Set(local.remote.values());
        for (const query of uniqueRemotes) {
          query.reconnect();
        }
      }
    }

    while (this.connection === socket) {
      // First drain the queued commands if we have them.
      for (const command of queue) {
        this.post(command);
        queue.delete(command);
      }

      // Next read next command from the session.
      const next = await reader.read();
      // If session is closed we're done.
      if (next.done) {
        this.close();
      }

      const command = next.value!;

      // Now we make sure that our socket is still a current connection as we
      // may have lost connection while waiting to read a command.
      if (this.connection === socket) {
        this.post(command);
      } // If it is no longer our connection we simply add the command into a
      // queue so it will be send once connection is reopen.
      else {
        this.queue.add(command);
        break;
      }
    }
  }

  post(
    invocation: Memory.UCAN<Memory.ConsumerCommandInvocation<Memory.Protocol>>,
  ) {
    this.inspect({
      send: invocation,
    });
    this.connection!.send(Codec.UCAN.toString(invocation));
  }

  onDisconnect(event: Event) {
    const socket = event.target as WebSocket;
    // If connection is `null` provider was closed and we do nothing on
    // disconnect.
    if (this.connection === socket) {
      // Report disconnection to inspector
      switch (event.type) {
        case "error":
        case "timeout":
        case "close": {
          this.inspect({
            disconnect: {
              reason: event.type,
              message: `Disconnected because of the ${event.type}`,
            },
          });
          break;
        }
        default:
          throw new Error(`Unknown event type: ${event.type}`);
      }

      this.connect();
    }
  }

  close() {
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

  subscribeToContents(subscription: Subscription<MemorySpace>): void {
    const { inspector } = this;
    const local = this.mount(this.workspace);
    const initialSubscription = subscription;
    const unsubscribe = subscription.subscribe("_", (_value) => {
      // we only want this event once
      unsubscribe();
      const includedQueryView = initialSubscription.query.includedQueryView();
      if (includedQueryView !== undefined) {
        const viewSelector = includedQueryView.selector as Memory.Selector;
        const newSubscription = new Subscription(
          local.memory,
          { select: viewSelector },
          new Map<Entity, Set<Subscriber>>(),
          includedQueryView,
          inspector,
        );
        for (const [of, _rest] of Object.entries(viewSelector)) {
          if (
            of !== "_" && local.remote.get(of as Entity) === undefined
          ) {
            local.remote.set(of as Entity, newSubscription);
          }
        }
      }
    });
  }
}

export interface Subscriber {
  (value: JSONValue | undefined): void;
}

class Subscription<Space extends MemorySpace> {
  reader!: ReadableStreamDefaultReader;
  query!: Memory.QueryView<Space, Protocol<Space>>;
  subscription!: ReturnType<typeof this.query.subscribe>;

  static spawn<Space extends MemorySpace>(
    session: Memory.MemorySpaceSession<Space>,
    selector: Query["args"] | SchemaQuery["args"],
    inspector?: Channel,
  ) {
    return new Subscription(
      session,
      selector,
      new Map<Entity | "_", Set<Subscriber>>(),
      undefined,
      inspector,
    );
  }
  constructor(
    public session: Memory.MemorySpaceSession<Space>,
    public selector: Query["args"] | SchemaQuery["args"],
    public subscribers: Map<Entity | "_", Set<Subscriber>>,
    public queryView?: Memory.QueryView<Space, Protocol<Space>>,
    public inspector?: Channel,
  ) {
    this.connect(queryView);
  }

  // Run an initial query to get the data, then subscribe to get updates
  // In the case of a selector that is a SchemaSelector, we will run the
  // query with the schema selector, but subscribe to updates on the doc
  // with a standard selector.
  connect(queryView?: Memory.QueryView<Space, Protocol<Space>>) {
    const query = (queryView === undefined)
      ? this.session.query(this.selector)
      : queryView;
    const subscription = query.subscribe();
    this.query = query;
    this.subscription = subscription;
    this.reader = subscription.getReader();

    // TODO(gozala): Need to do this cleaner, but for now we just
    // broadcast when query returns so cell circuitry picks up changes.
    query.promise.then(() => this.broadcast());
    this.poll();
    return this;
  }

  getValue(of: Entity) {
    return this.getFact(of)?.is;
  }

  getFact(of: Entity) {
    return this.query.facts.find((fact) => fact.of == of);
  }

  inspect(
    message: RawCommand,
  ): RawCommand {
    this.inspector?.postMessage({
      ...message,
      time: Date.now(),
    });
    return message;
  }

  broadcast() {
    // Cast between `memory`'s JSONValue and `builder`'s JSONValue
    const fullSubscribers = this.subscribers.get("_");
    for (const fact of this.query.facts) {
      const value = fact.is as BuilderJSONValue;
      this.inspector?.postMessage({
        integrate: {
          url: this.subscription.toURL(),
          value,
        },
        time: Date.now(),
      });

      const currentSubscribers = this.subscribers.get(fact.of);
      if (currentSubscribers !== undefined) {
        for (const subscriber of currentSubscribers) {
          subscriber(fact.is);
        }
      }
      if (fullSubscribers !== undefined) {
        for (const subscriber of fullSubscribers) {
          subscriber(fact.is);
        }
      }
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
    // TODO(gozala): We could make it possible to rerun the subscription
    this.reader.cancel();
    this.connect();
  }

  subscribe(of: Entity | "_", subscriber: Subscriber): Cancel {
    const currentSubscribers = this.subscribers.get(of) ?? new Set();
    currentSubscribers.add(subscriber);
    this.subscribers.set(of, currentSubscribers);
    return () => this.unsubscribe(of, subscriber);
  }

  unsubscribe(of: Entity | "_", subscriber: Subscriber) {
    const currentSubscribers = this.subscribers.get(of);
    if (currentSubscribers !== undefined) {
      currentSubscribers.delete(subscriber);
      this.subscribers.set(of, currentSubscribers);
    }
  }
}
