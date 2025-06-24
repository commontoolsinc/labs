import { fromString, refer } from "merkle-reference";
import { isBrowser } from "@commontools/utils/env";
import { isObject } from "@commontools/utils/types";
import type {
  AuthorizationError,
  Changes,
  Commit,
  ConflictError,
  ConnectionError,
  ConsumerCommandInvocation,
  Entity,
  Fact,
  FactAddress,
  JSONValue,
  MemorySpace,
  Protocol,
  ProviderCommand,
  QueryError,
  Result,
  Revision,
  SchemaContext,
  SchemaQueryArgs,
  Signer,
  State,
  Statement,
  The,
  TransactionError,
  UCAN,
  Unit,
} from "@commontools/memory/interface";
import { set, setSelector } from "@commontools/memory/selection";
import type { MemorySpaceSession } from "@commontools/memory/consumer";
import { assert, retract, unclaimed } from "@commontools/memory/fact";
import { the, toChanges, toRevision } from "@commontools/memory/commit";
import * as Consumer from "@commontools/memory/consumer";
import * as Codec from "@commontools/memory/codec";
import { SchemaNone } from "@commontools/memory/schema";
import { type Cancel, type EntityId } from "@commontools/runner";
import { type JSONSchema } from "../builder/types.ts";
import { ContextualFlowControl } from "../cfc.ts";
import { deepEqual } from "../path-utils.ts";
import { MapSet, type SchemaPathSelector } from "../traverse.ts";
import type { IStorageProvider, StorageValue } from "./interface.ts";
import { BaseStorageProvider } from "./base.ts";
import * as IDB from "./idb.ts";
import { Channel, RawCommand } from "./inspector.ts";

export * from "@commontools/memory/interface";
export type { Result, Unit };
export interface Selector<Key> extends Iterable<Key> {
}

export interface Selection<Key, Value> extends Iterable<[Key, Value]> {
  size: number;

  values(): Iterable<Value>;
}

export interface Merge<Model> {
  (local: Model | undefined, remote: Model | undefined): Model | undefined;
}

export interface AsyncPull<Model, Address> {
  /**
   * Loads records from the underlying store and returns a map of records keyed by keys in
   * the provided selector.
   */
  pull(
    selector: Selector<Address>,
  ): Promise<
    Result<Selection<Address, Model>, StoreError>
  >;
}

export interface AsyncPush<Model> {
  merge(
    entries: Iterable<Model>,
    merge: Merge<Model>,
  ): Promise<Result<Unit, StoreError>>;
}

export interface AsyncStore<Model, Address>
  extends AsyncPull<Model, Address>, AsyncPush<Model> {
}

export interface SyncPull<Model, Address> {
  pull(
    selector: Selector<Address>,
  ): Promise<
    Result<Selection<Address, Model>, StoreError>
  >;
}

export interface SyncPush<Model> {
  merge(
    entries: Iterable<Model>,
    merge: Merge<Model>,
  ): Result<Unit, StoreError>;
}

export interface SyncStore<Model, Address>
  extends SyncPull<Model, Address>, SyncPush<Model> {
}

interface NotFoundError extends Error {
  name: "NotFound";
  address: FactAddress;
}

interface StoreError extends Error {
  name: "StoreError";
  cause: Error;
}

export interface Assert {
  the: The;
  of: Entity;
  is: JSONValue;
}

export interface Retract {
  the: The;
  of: Entity;
  is?: void;
}

const toKey = ({ the, of }: FactAddress) => `${of}/${the}`;
const fromKey = (key: string): FactAddress => {
  const [of, the] = key.split('/');
  return { of: of as Entity, the };
};

export class NoCache<Model extends object, Address>
  implements AsyncStore<Model, Address> {
  /**
   * Pulls nothing because this store does not store anything.
   */
  async pull(
    selector: Selector<Address>,
  ): Promise<Result<Selection<Address, Model>, StoreError>> {
    return await { ok: new Map() };
  }

  /**
   * Merges nothing because this store discards everything.
   */
  async merge(entries: Iterable<Model>, merge: Merge<Model>) {
    return await { ok: {} };
  }
}

class Nursery implements SyncPush<State> {
  static put(before?: State, after?: State) {
    return after;
  }
  static delete() {
    return undefined;
  }

  constructor(public store: Map<string, State> = new Map()) {
  }
  get(entry: FactAddress) {
    return this.store.get(toKey(entry));
  }

  merge(entries: Iterable<State>, merge: Merge<State>) {
    for (const entry of entries) {
      const key = toKey(entry);
      const stored = this.store.get(key);
      const merged = merge(stored, entry);
      if (merged === undefined) {
        this.store.delete(key);
      } else if (stored !== merged) {
        this.store.set(key, merged);
      }
    }
    return { ok: {} };
  }
}

class Heap implements SyncPush<Revision<State>> {
  constructor(
    public store: Map<string, Revision<State>> = new Map(),
    public subscribers: Map<string, Set<(revision?: Revision<State>) => void>> =
      new Map(),
  ) {
  }

  get(entry: FactAddress) {
    return this.store.get(toKey(entry));
  }

  merge(entries: Iterable<Revision<State>>, merge: Merge<Revision<State>>) {
    const updated = new Set<string>();
    for (const entry of entries) {
      const key = toKey(entry);
      const stored = this.store.get(key);
      const merged = merge(stored, entry);
      if (merged === undefined) {
        this.store.delete(key);
        updated.add(key);
      } else if (stored !== merged) {
        this.store.set(key, merged);
        updated.add(key);
      }
    }

    // Notify all the subscribers
    for (const key of updated) {
      for (const subscriber of this.subscribers.get(key) ?? []) {
        subscriber(this.store.get(key));
      }
    }

    return { ok: {} };
  }

  subscribe(
    entry: FactAddress,
    subscriber: (value?: Revision<State>) => void,
  ) {
    const key = toKey(entry);
    let subscribers = this.subscribers.get(key);
    if (!subscribers) {
      subscribers = new Set();
      this.subscribers.set(key, subscribers);
    }

    subscribers.add(subscriber);
  }

  unsubscribe(
    entry: FactAddress,
    subscriber: (value?: Revision<State>) => void,
  ) {
    const key = toKey(entry);
    const subscribers = this.subscribers.get(key);
    if (subscribers) {
      subscribers.delete(subscriber);
    }
  }
}

type RevisionArchive = {
  the: The;
  of: Entity;
  is?: JSONValue;
  cause?: string;
  since: number;
};

class RevisionCodec {
  static decode(
    { the, of, is, cause, since }: RevisionArchive,
  ): Revision<State> {
    return cause == null
      ? { the, of, since }
      : is === undefined
        ? { the, of, since, cause: fromString(cause) } as Revision<Fact>
        : { the, of, is, since, cause: fromString(cause) } as Revision<Fact>;
  }

  static encode(
    { the, of, is, since, cause }: Revision<State>,
  ): RevisionArchive {
    return cause == null
      ? { the, of, since }
      : is === undefined
        ? { the, of, since, cause: cause.toString() }
        : { the, of, is, since, cause: cause.toString() };
  }
}

class RevisionAddress {
  static encode({ the, of }: FactAddress): [string, string] {
    return [of, the];
  }
}

class PullQueue {
  constructor(
    public members: Map<string, [FactAddress, SchemaContext?]> = new Map(),
  ) {
  }
  add(entries: Iterable<[FactAddress, SchemaContext?]>) {
    // TODO(@ubik2) Ensure the schema context matches
    for (const [entry, schema] of entries) {
      this.members.set(toKey(entry), [entry, schema]);
    }
  }

  consume(): [FactAddress, SchemaContext?][] {
    const entries = [...this.members.values()];
    this.members.clear();
    return entries;
  }
}

// This class helps us maintain a client model of our server side subscriptions
class SelectorTracker {
  private refTracker = new MapSet<string, string>();
  private selectors = new Map<string, SchemaPathSelector>();

  add(doc: FactAddress, selector: SchemaPathSelector | undefined) {
    if (selector === undefined) {
      return;
    }
    const selectorRef = refer(JSON.stringify(selector)).toString();
    this.refTracker.add(toKey(doc), selectorRef);
    this.selectors.set(selectorRef, selector);
  }

  has(doc: FactAddress): boolean {
    return this.refTracker.has(toKey(doc));
  }

  hasSelector(doc: FactAddress, selector: SchemaPathSelector): boolean {
    const selectorRefs = this.refTracker.get(toKey(doc));
    if (selectorRefs !== undefined) {
      const selectorRef = refer(JSON.stringify(selector)).toString();
      return selectorRefs.has(selectorRef);
    }
    return false;
  }

  get(doc: FactAddress): IteratorObject<SchemaPathSelector> {
    const selectorRefs = this.refTracker.get(toKey(doc)) ?? [];
    return selectorRefs.values().map((selectorRef) =>
      this.selectors.get(selectorRef)!
    );
  }

  /**
   * Return all tracked subscriptions as an array of {factAddress, selector} pairs
   */
  getAllSubscriptions(): Array<{ factAddress: FactAddress; selector: SchemaPathSelector }> {
    const subscriptions: Array<{ factAddress: FactAddress; selector: SchemaPathSelector }> = [];
    for (const [factKey, selectorRefs] of this.refTracker) {
      const factAddress = fromKey(factKey);
      for (const selectorRef of selectorRefs) {
        const selector = this.selectors.get(selectorRef);
        if (selector) {
          subscriptions.push({ factAddress, selector });
        }
      }
    }
    return subscriptions;
  }
}

export class Replica {
  static put(
    local: Revision<State> | undefined,
    remote: Revision<State> | undefined,
  ): Revision<State> | undefined {
    if (remote == null) {
      return local;
    } else if (local == null) {
      return remote;
    } else if (local.since < remote.since) {
      return remote;
    } else {
      return local;
    }
  }

  static update(
    local: Revision<State> | undefined,
    remote: Revision<State> | undefined,
  ): Revision<State> | undefined {
    if (local == null || remote == null) {
      return local;
    } else if (local.since < remote.since) {
      return remote;
    } else {
      return local;
    }
  }

  /** */
  static open() {
  }

  constructor(
    /**
     * DID of the memory space this is a replica of.
     */
    public space: MemorySpace,
    /**
     * Represents canonical memory state in the remote store from which state is
     * partially replicated into local cache.
     */
    public remote: MemorySpaceSession,
    /**
     * Represents persisted cache of the memory state that was fetched in one
     * of the sessions. If IDB is not available in this runtime we do not have
     * persisted cache.
     */
    public cache: AsyncStore<Revision<State>, FactAddress> = IDB.available()
      ? IDB.open({ name: space, store: "facts", version: 1 }, {
        key: RevisionAddress,
        address: RevisionAddress,
        value: RevisionCodec,
      })
      : new NoCache(),
    /**
     * Represents cache of the memory state that was loaded from the persisted
     * cache during this session.
     */
    public heap: Heap = new Heap(),
    /**
     * Represent cache of the the memory state that is in flight and has not
     * yet made it to the remote store.
     */
    public nursery: Nursery = new Nursery(),
    public queue: PullQueue = new PullQueue(),
    public pullRetryLimit: number = 100,
    public useSchemaQueries: boolean = false,
    // Track the selectors used for top level docs
    private selectorTracker: SelectorTracker = new SelectorTracker(),
    private cfc: ContextualFlowControl = new ContextualFlowControl(),
  ) {
    this.pull = this.pull.bind(this);
  }

  async poll() {
    // Poll re-fetches the commit log, then subscribes to that
    // We don't use the autosubscribing query, since we want the
    // Commit object, and the autosubscribe returns a Selection.
    // TODO(@ubik2) Investigate whether I *can* use autosub.
    const query = this.remote.query({
      // selectSchema: {
      //   [this.space]: {
      //     [the]: {
      //       SelectAllString: {
      //         path: [],
      //         schemaContext: {
      //           schema: SchemaNone,
      //           rootSchema: SchemaNone,
      //         },
      //       },
      //     },
      //   },
      // },
      select: { [this.space]: { [the]: { "_": {} } } },
    });

    const reader = query.subscribe().getReader();
    while (true) {
      const next = await reader.read();
      if (next.done) {
        break;
      }
      this.merge(next.value[this.space] as unknown as Commit);
    }
  }

  /**
   * Pulls requested entries from the remote source and updates both in memory
   * cache and local store so they will be available for future reads. If
   * entries are not provided it will pull entries that have being loaded from
   * local store in this session.
   */
  async pull(
    entries: [FactAddress, SchemaContext?][] = this.queue.consume(),
  ): Promise<
    Result<
      Selection<FactAddress, Revision<State>>,
      StoreError | QueryError | AuthorizationError | ConnectionError
    >
  > {
    // If requested entry list is empty there is nothing to fetch so we return
    // immediately.
    if (entries.length === 0) {
      return { ok: new Map() };
    }

    // Otherwise we build a query selector to fetch requested entries from the
    // remote.
    const schemaSelector = {};
    const querySelector = {};
    // We'll assert that we need all the classifications we expect to need.
    // If we don't actually have those, the server will reject our request.
    const classifications = new Set<string>();
    for (const [{ the, of }, context] of entries) {
      if (this.useSchemaQueries) {
        // If we don't have a schema, use SchemaNone, which will only fetch the specified object
        const schemaContext = context ?? SchemaNone;
        setSelector(schemaSelector, of, the, "_", {
          path: [],
          schemaContext: schemaContext,
        });
        // Since we're accessing the entire document, we should base our classification on the rootSchema
        this.cfc.joinSchema(classifications, schemaContext.rootSchema);
      } else {
        // We're using the "cached" mode, and we don't use schema queries
        setSelector(querySelector, of, the, "_", {});
      }
    }

    // We provided schema for the top level fact that we selected, but we
    // will have undefined schema for the entries included as links.
    let fetchedEntries: [Revision<State>, SchemaContext | undefined][] = [];
    // Run all our schema queries first
    if (Object.entries(schemaSelector).length > 0) {
      const queryArgs: SchemaQueryArgs = {
        selectSchema: schemaSelector,
        subscribe: true,
      };
      if (classifications.size > 0) {
        queryArgs.classification = [...classifications];
      }
      const query = this.remote.query(queryArgs);
      const { error } = await query.promise;
      // If query fails we propagate the error.
      if (error) {
        console.error("query failure", error);
        return { error };
      }
      fetchedEntries = query.schemaFacts;
      // TODO(@ubik2) verify that we're dealing with this subscription
      // I know we're sending updates over from the provider, but make sure
      // we're incorporating those in the cache.
    }
    // Now run our regular queries (this will include our commit+json)
    if (Object.entries(querySelector).length > 0) {
      const query = this.remote.query({ select: querySelector });
      const { error } = await query.promise;
      // If query fails we propagate the error.
      if (error) {
        return { error };
      }
      fetchedEntries = [...fetchedEntries, ...query.schemaFacts];
    }
    const fetched = fetchedEntries.map(([fact, _schema]) => fact);
    this.heap.merge(fetched, Replica.put);

    // Remote may not have all the requested entries. We denitrify them by
    // looking up which of the facts are not available locally and then create
    // `unclaimed` revisions for those that we store. By doing this we can avoid
    // network round trips if such are pulled again in the future.
    const notFound = [];
    const revisions = new Map<FactAddress, Revision<State>>();
    if (fetched.length < entries.length) {
      for (const [entry, _schema] of entries) {
        if (!this.get(entry)) {
          // Note we use `-1` as `since` timestamp so that any change will appear greater.
          const revision = { ...unclaimed(entry), since: -1 };
          notFound.push(revision);
          revisions.set(entry, revision);
        }
      }
    }

    for (const [revision, schema] of fetchedEntries) {
      const factAddress = { the: revision.the, of: revision.of };
      revisions.set(factAddress, revision);
      this.selectorTracker.add(factAddress, {
        path: [],
        schemaContext: schema,
      });
    }

    // Add notFound entries to the heap and also persist them in the cache.
    this.heap.merge(notFound, Replica.put);
    const result = await this.cache.merge(revisions.values(), Replica.put);

    if (result.error) {
      return result;
    } else {
      return { ok: revisions };
    }
  }

  /**
   * Loads requested entries from the local store into a heap unless entries are
   * already loaded. If some of the entries are not available locally they will
   * be fetched from the remote.
   */
  async load(
    entries: [FactAddress, SchemaContext?][],
  ): Promise<
    Result<
      Selection<FactAddress, Revision<State>>,
      StoreError | QueryError | AuthorizationError | ConnectionError
    >
  > {
    // First we identify entries that we need to load from the store.
    const need: [FactAddress, SchemaContext?][] = [];
    for (const [address, schema] of entries) {
      if (!this.get(address)) {
        need.push([address, schema]);
      } else if (schema !== undefined) {
        const selector = { path: [], schemaContext: schema };
        // Even though we have our root doc in local store, we may need
        // to re-issue our query, since our cached copy may have been run with a
        // different schema, and thus have different linked documents.
        if (!this.selectorTracker.hasSelector(address, selector)) {
          // If we already have a subscription for the query running on the
          // server for this selector, we don't need to send a new one
          // (revisit this when we allow unsubscribe)
          // Otherwise, add it to the set of things we need
          need.push([address, schema]);
        }
      }
    }

    // We also include the commit entity to keep track of the current head.
    if (!this.get({ the, of: this.space })) {
      need.unshift([{ the, of: this.space }, undefined]);
    }

    // If all the entries were already loaded we don't need to do anything
    // so we return immediately.
    if (need.length === 0) {
      return { ok: new Map() };
    }

    // Otherwise we attempt pull needed entries from the local store.
    // We only do this for entries without a schema, since we'll want the server
    // to track our subscription for the entries with a schema.
    const schemaless = need
      .filter(([_addr, schema]) => schema === undefined)
      .map(([addr, _schema]) => addr);
    const { ok: pulled, error } = await this.cache.pull(schemaless);

    if (error) {
      return { error };
    } else {
      // If number of pulled records is less than what we requested we have some
      // some records that we'll need to fetch.
      this.heap.merge(pulled.values(), Replica.put);
      // If number of items pulled from cache is less than number of needed items
      // we did not have everything we needed in cache, in which case we will
      // have to wait until fetch is complete.
      // TODO(@ubik2) still need to add since field
      if (pulled.size < need.length) {
        return await this.pull(need);
      } //
      // Otherwise we are able to complete checkout and we schedule a pull in
      // the background so we can get latest entries if there are some available.
      else {
        const simple = need.filter(([_addr, schema]) => schema === undefined);
        // schedule an update for any entries without a schema.
        this.queue.add(simple);
        this.sync();
        return { ok: pulled };
      }
    }
  }

  syncTimer: number = -1;
  syncTimeout = 60 * 1000;

  sync() {
    clearTimeout(this.syncTimer);
    this.syncTimer = setTimeout(this.pull, this.syncTimeout);
  }

  /**
   * Attempts to commit and push changes to the remote. It optimistically
   * updates local state so that subsequent commits can be made without having
   * awaiting for each commit to succeed. However if commit fails all the local
   * changes made will be reverted back to the last merged state.
   *
   * ⚠️ Please note that if commits stack up e.g by incrementing value of the
   * same entity, rejected commit will ripple through stack as the changes there
   * would assume state that is rejected.
   */
  async push(
    changes: (Assert | Retract)[],
  ): Promise<
    Result<
      Commit,
      | StoreError
      | QueryError
      | ConnectionError
      | ConflictError
      | TransactionError
      | AuthorizationError
    >
  > {
    // First we pull all the affected entries into heap so we can build a
    // transaction that is aware of latest state.
    const { error } = await this.load(
      changes.map((change) => [change, getSchema(change)]),
    );
    if (error) {
      return { error };
    } else {
      // Collect facts so that we can derive desired state and a corresponding
      // transaction
      const facts: Fact[] = [];
      for (const { the, of, is } of changes) {
        const fact = this.get({ the, of });
        // If `is` is `undefined` we want to retract the fact.
        if (is === undefined) {
          // If local `is` in the local state is also `undefined` desired state
          // matches current state in which case we omit this change from the
          // transaction, otherwise we retract fact.
          if (fact?.is !== undefined) {
            facts.push(retract(fact));
          }
        } else {
          facts.push(assert({
            the,
            of,
            is,
            // If fact has no `cause` it is unclaimed fact.
            cause: fact?.cause ? fact : null,
          }));
        }
      }

      // Store facts in a nursery so that subsequent changes will be build
      // optimistically assuming that push will succeed.
      this.nursery.merge(facts, Nursery.put);

      // These push transaction that will commit desired state to a remote.
      const result = await this.remote.transact({
        changes: getChanges(facts),
      });

      // If transaction fails we delete facts from the nursery so that new
      // changes will not build upon rejected state. If there are other inflight
      // transactions that already were built upon our facts they will also fail.
      if (result.error) {
        this.nursery.merge(facts, Nursery.delete);
        const fact = result.error.name === "ConflictError" &&
          result.error.conflict.actual;
        // We also update heap so it holds latest record
        if (fact) {
          this.heap.merge([fact], Replica.update);
        }
      } //
      // If transaction succeeded we promote facts from nursery into a heap.
      else {
        const commit = toRevision(result.ok);
        const { since } = commit.is;
        const revisions = [
          ...facts.map((fact) => ({ ...fact, since })),
          // We strip transaction info so we don't duplicate same data
          { ...commit, is: { since: commit.is.since } },
        ];
        // Turn facts into revisions corresponding with the commit.
        this.heap.merge(revisions, Replica.put);
        this.nursery.merge(facts, Nursery.delete);
      }

      return result;
    }
  }

  subscribe(entry: FactAddress, subscriber: (value?: Revision<State>) => void) {
    this.heap.subscribe(entry, subscriber);
  }
  unsubscribe(
    entry: FactAddress,
    subscriber: (value?: Revision<State>) => void,
  ) {
    this.heap.unsubscribe(entry, subscriber);
  }

  merge(commit: Commit) {
    const { the, of, cause, is, since } = toRevision(commit);
    const revisions = [
      { the, of, cause, is: { since: is.since }, since },
      ...toChanges(commit),
    ];

    // Store newer revisions into the heap,
    this.heap.merge(revisions, Replica.update);
    return this.cache.merge(revisions, Replica.update);
  }

  /**
   * Returns state corresponding to the requested entry. If there is a pending
   * state returns it otherwise returns recent state.
   */
  get(entry: FactAddress) {
    return this.nursery.get(entry) ?? this.heap.get(entry);
  }
}

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

  /**
   * Flag to enable or disable remote schema subscriptions
   */
  useSchemaQueries: boolean;
}

export interface RemoteStorageProviderOptions {
  session: Consumer.MemoryConsumer<MemorySpace>;
  space: MemorySpace;
  the?: string;
  settings?: RemoteStorageProviderSettings;
}

export const defaultSettings: RemoteStorageProviderSettings = {
  maxSubscriptionsPerSpace: 50_000,
  connectionTimeout: 30_000,
  useSchemaQueries: true,
};

export interface ConnectionOptions {
  /**
   * Unique identifier of the storage. Used as name of the `BroadcastChannel`
   * in order to allow inspection of the storage.
   */
  id: string;
  address: URL;
  inspector?: Channel;
}

export interface ProviderConnectionOptions extends ConnectionOptions {
  provider: Provider;
}

class ProviderConnection implements IStorageProvider {
  address: URL;
  connection: WebSocket | null = null;
  connectionCount = 0;
  timeoutID = 0;
  inspector?: Channel;
  provider: Provider;
  reader: ReadableStreamDefaultReader<
    UCAN<ConsumerCommandInvocation<Protocol>>
  >;
  writer: WritableStreamDefaultWriter<ProviderCommand<Protocol>>;

  /**
   * queue that holds commands that we read from the session, but could not
   * send because connection was down.
   */
  queue: Set<UCAN<ConsumerCommandInvocation<Protocol>>> = new Set();

  constructor(
    { id, address, provider, inspector }: ProviderConnectionOptions,
  ) {
    this.address = address;
    this.provider = provider;
    this.handleEvent = this.handleEvent.bind(this);
    // Do not use a default inspector when in Deno:
    // Requires `--unstable-broadcast-channel` flags and it is not used
    // in that environment.
    this.inspector = isBrowser() ? (inspector ?? new Channel(id)) : undefined;

    const session = provider.session;
    this.reader = session.readable.getReader();
    this.writer = session.writable.getWriter();

    this.connect();
  }
  get settings() {
    return this.provider.settings;
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
    webSocketUrl.searchParams.set("space", this.provider.workspace.space);
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
  post(
    invocation: UCAN<ConsumerCommandInvocation<Protocol>>,
  ) {
    this.inspect({
      send: invocation,
    });
    this.connection!.send(Codec.UCAN.toString(invocation));
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

  parse(source: string): ProviderCommand<Protocol> {
    return Codec.Receipt.fromString(source);
  }
  onReceive(data: string) {
    return this.writer.write(
      this.inspect({ receive: this.parse(data) }).receive,
    );
  }

  async onOpen(socket: WebSocket) {
    const { reader, queue } = this;

    // Report connection to inspector
    this.inspect({
      connect: { attempt: this.connectionCount },
    });

    // If we did have connection
    if (this.connectionCount > 1) {
      this.provider.poll();
      await this.provider.reestablishSubscriptions();
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

  async close() {
    const { connection } = this;
    this.connection = null;
    if (connection && connection.readyState !== WebSocket.CLOSED) {
      connection.close();
      return await ProviderConnection.closed(connection);
    } else {
      return {};
    }
  }

  async destroy(): Promise<void> {
    await this.close();
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

  /**
   * Creates a promise that succeeds when the socket is closed or fails with
   * the error event if the socket errors.
   */
  static async closed(socket: WebSocket): Promise<Unit> {
    if (socket.readyState === WebSocket.CLOSED) {
      return {};
    } else {
      return await new Promise((succeed, fail) => {
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

  sink<T = any>(
    entityId: EntityId,
    callback: (value: StorageValue<T>) => void,
  ) {
    return this.provider.sink(entityId, callback);
  }

  sync(
    entityId: EntityId,
    expectedInStorage?: boolean,
    schemaContext?: SchemaContext,
  ) {
    return this.provider.sync(entityId, expectedInStorage, schemaContext);
  }

  get<T = any>(entityId: EntityId): StorageValue<T> | undefined {
    return this.provider.get(entityId);
  }
  send<T = any>(
    batch: { entityId: EntityId; value: StorageValue<T> }[],
  ) {
    return this.provider.send(batch);
  }

  getReplica() {
    return this.provider.getReplica();
  }
}

export class Provider implements IStorageProvider {
  workspace: Replica;
  the: string;
  session: Consumer.MemoryConsumer<MemorySpace>;
  spaces: Map<string, Replica>;
  settings: RemoteStorageProviderSettings;

  subscribers: Map<string, Set<(value: StorageValue<JSONValue>) => void>> =
    new Map();
  // Tracks server-side subscriptions so we can re-establish them after reconnection
  private serverSubscriptions = new SelectorTracker();

  static open(options: RemoteStorageProviderOptions) {
    return new this(options);
  }

  static connect(options: ConnectionOptions & RemoteStorageProviderOptions) {
    return this.open(options).connect(options);
  }

  constructor({
    session,
    space,
    the = "application/json",
    settings = defaultSettings,
  }: RemoteStorageProviderOptions) {
    this.the = the;
    this.settings = settings;
    this.session = session;
    this.spaces = new Map();
    this.workspace = this.mount(space);
  }

  connect(options: ConnectionOptions) {
    return new ProviderConnection({
      id: options.id,
      provider: this,
      address: options.address,
    });
  }

  mount(space: MemorySpace): Replica {
    const replica = this.spaces.get(space);
    if (replica) {
      return replica;
    } else {
      const session = this.session.mount(space);
      // FIXME(@ubik2): Disabling the cache while I ensure things work correctly
      const replica = new Replica(space, session, new NoCache());
      replica.useSchemaQueries = this.settings.useSchemaQueries;
      replica.poll();
      this.spaces.set(space, replica);
      return replica;
    }
  }

  sink<T = any>(
    entityId: EntityId,
    callback: (value: StorageValue<T>) => void,
  ): Cancel {
    const { the } = this;
    const of = BaseStorageProvider.toEntity(entityId);
    // Capture workspace locally, so that if it changes later, our cancel
    // will unsubscribe with the same object.
    const { workspace } = this;
    const address = { the, of };
    const subscriber = (revision?: Revision<State>) => {
      // If since is -1, this is not a real revision, so don't notify subscribers
      if (revision && revision.since !== -1) {
        // ⚠️ We may not have a value because fact was retracted or
        // (less likely) deleted altogether. We still need to notify sink
        // but we do this with the empty object per
        // @see https://github.com/commontoolsinc/labs/pull/989#discussion_r2033651935
        // TODO(@seefeldb): Make compatible `sink` API change
        callback((revision?.is ?? {}) as unknown as StorageValue<T>);
      }
    };

    workspace.subscribe(address, subscriber);
    workspace.load([[address, undefined]]);

    return () => workspace.unsubscribe(address, subscriber);
  }

  sync(
    entityId: EntityId,
    expectedInStorage?: boolean,
    schemaContext?: SchemaContext,
  ) {
    const { the } = this;
    const of = BaseStorageProvider.toEntity(entityId);
    const factAddress = { the, of };

    // Track this server subscription, and don't re-issue it
    if (schemaContext) {
      const selector = { path: [], schemaContext: schemaContext };
      if (this.serverSubscriptions.hasSelector(factAddress, selector)) {
        return Promise.resolve({ ok: {} });
      }
      this.serverSubscriptions.add(factAddress, selector);
    }

    return this.workspace.load([[factAddress, schemaContext]]);
  }

  get<T = any>(entityId: EntityId): StorageValue<T> | undefined {
    const entity = this.workspace.get({
      the: this.the,
      of: BaseStorageProvider.toEntity(entityId),
    });

    return entity?.is as StorageValue<T> | undefined;
  }

  async send<T = any>(
    batch: { entityId: EntityId; value: StorageValue<T> }[],
  ): Promise<
    Result<
      Unit,
      | ConflictError
      | TransactionError
      | ConnectionError
      | AuthorizationError
      | QueryError
      | StoreError
    >
  > {
    const { the, workspace } = this;
    const TheLabel = "application/label+json" as const;

    const changes = [];
    for (const { entityId, value } of batch) {
      const of = BaseStorageProvider.toEntity(entityId);
      const content = value.value !== undefined
        ? JSON.stringify({ value: value.value, source: value.source })
        : undefined;

      const current = workspace.get({ the, of });
      if (JSON.stringify(current?.is) !== content) {
        if (content !== undefined) {
          // ⚠️ We do JSON roundtrips to strip off the undefined values that
          // cause problems with serialization.
          changes.push({ the, of, is: JSON.parse(content) as JSONValue });
        } else {
          changes.push({ the, of });
        }
      }
      if (value.labels !== undefined) {
        const currentLabel = workspace.get({ the: TheLabel, of });
        if (!deepEqual(currentLabel?.is, value.labels)) {
          if (value.labels !== undefined) {
            changes.push({ the: TheLabel, of, is: value.labels as JSONValue });
          } else {
            changes.push({ the: TheLabel, of });
          }
        }
      }
    }

    if (changes.length > 0) {
      const result = await this.workspace.push(changes);
      return result.error ? result : { ok: {} };
    } else {
      return { ok: {} };
    }
  }

  /**
   * Polls all spaces for changes.
   */
  poll() {
    for (const space of this.spaces.values()) {
      space.poll();
    }
  }

  /**
   * Re-establishes all tracked schema query subscriptions.
   * Called after WebSocket reconnection
   * See `ProviderConnection.onOpen()`
   */
  async reestablishSubscriptions(): Promise<void> {
    const subscriptions = this.serverSubscriptions.getAllSubscriptions();

    // Re-establish each subscription
    for (const { factAddress, selector } of subscriptions) {
      if (selector.schemaContext) {
        const entityId: EntityId = { "/": factAddress.of.replace('of:', '') };
        try {
          await this.sync(entityId, true, selector.schemaContext);
        } catch (error) {
          // catch error so we can continue with other subscriptions
          console.error(`Failed to re-establish subscription for ${entityId["/"]}:`, error);
        }
      }
    }
  }

  getReplica(): string {
    return this.workspace.space;
  }

  async destroy(): Promise<void> {
  }
}

export interface Options {
  /**
   * Singning authority.
   */
  as: Signer;

  /**
   * Address of the storage provider.
   */
  address: URL;

  /**
   * Unique identifier used for inspection.
   */
  id?: string;

  /**
   * Various settings to configure storage provider.
   */
  settings?: RemoteStorageProviderSettings;
}

export interface IStorageManager {
  id: string;
  open(space: string): IStorageProvider;
}

export interface LocalStorageOptions {
  as: Signer;
  id?: string;
  settings?: RemoteStorageProviderSettings;
}

export class StorageManager implements IStorageManager {
  address: URL;
  as: Signer;
  id: string;
  settings: RemoteStorageProviderSettings;
  #providers: Map<string, IStorageProvider> = new Map();

  static open(options: Options) {
    if (options.address.protocol === "memory:") {
      throw new RangeError(
        "memory: protocol is not supported in browser runtime",
      );
    } else {
      return new this(options);
    }
  }

  protected constructor(
    { address, as, id = crypto.randomUUID(), settings = defaultSettings }:
      Options,
  ) {
    this.address = address;
    this.settings = settings;
    this.as = as;
    this.id = id;
  }

  /**
   * Opens a new storage provider session for the given space. Currently this
   * creates a new web socket connection to `${this.address}?space=${space}`
   * in order to cluster connections for the space in the same group.
   */
  open(space: MemorySpace) {
    const provider = this.#providers.get(space);
    if (!provider) {
      const provider = this.connect(space);
      this.#providers.set(space, provider);
      return provider;
    }
    return provider;
  }

  protected connect(space: MemorySpace): IStorageProvider {
    const { id, address, as, settings } = this;
    return Provider.connect({
      id,
      space,
      address,
      settings,
      session: Consumer.create({ as }),
    });
  }

  async close() {
    const promises = [];
    for (const provider of this.#providers.values()) {
      promises.push(provider.destroy());
    }

    await Promise.all(promises);
  }
}

export const getChanges = <
  T extends The,
  Of extends Entity,
  Is extends JSONValue,
>(
  statements: Iterable<Statement>,
) => {
  const changes = {} as Changes<T, Of, Is>;
  for (const statement of statements) {
    if (statement.cause) {
      const cause = statement.cause.toString();
      const value = statement.is === undefined ? {} : { is: statement.is };
      set(changes, statement.of, statement.the, cause, value);
    } else {
      const cause = statement.fact.toString();
      set(changes, statement.of, statement.the, cause, true);
    }
  }
  return changes;
};

// Given an Assert statement with labels, return a SchemaContext with the ifc tags
const getSchema = (change: Assert | Retract): SchemaContext | undefined => {
  if (isObject(change?.is) && "labels" in change.is) {
    const schema = { ifc: change.is.labels } as JSONSchema;
    return { schema: schema, rootSchema: schema };
  }
  return undefined;
};
