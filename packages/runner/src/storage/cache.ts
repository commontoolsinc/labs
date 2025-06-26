import { fromString, refer } from "merkle-reference";
import { isBrowser } from "@commontools/utils/env";
import { isObject } from "@commontools/utils/types";
import {
  type JSONSchema,
  type JSONValue,
  type SchemaContext,
} from "../builder/types.ts";
import { ContextualFlowControl } from "../cfc.ts";
import { deepEqual } from "../path-utils.ts";
import { MapSet } from "../traverse.ts";
import type {
  Assertion,
  AuthorizationError,
  Changes as MemoryChanges,
  Commit,
  ConflictError,
  ConnectionError,
  ConsumerCommandInvocation,
  Entity,
  Fact,
  FactAddress,
  Invariant,
  JSONValue,
  MemorySpace,
  Protocol,
  ProviderCommand,
  QueryError,
  Reference,
  Result,
  Revision,
  SchemaPathSelector,
  SchemaQueryArgs,
  Signer,
  State,
  Statement,
  The,
  TransactionError,
  UCAN,
  Unit,
  Variant,
} from "@commontools/memory/interface";
import { set, setSelector } from "@commontools/memory/selection";
import type { MemorySpaceSession } from "@commontools/memory/consumer";
import { assert, retract, unclaimed } from "@commontools/memory/fact";
import { the, toChanges, toRevision } from "@commontools/memory/commit";
import * as ChangesBuilder from "@commontools/memory/changes";
import * as Consumer from "@commontools/memory/consumer";
import * as Codec from "@commontools/memory/codec";
import { type Cancel, type EntityId } from "@commontools/runner";
import type {
  Activity,
  IMemoryAddress,
  InactiveTransactionError,
  INotFoundError,
  IStorageManagerV2,
  IStorageProvider,
  IStorageTransaction,
  IStorageTransactionAborted,
  IStorageTransactionComplete,
  IStorageTransactionError,
  IStorageTransactionFailed,
  IStorageTransactionInconsistent,
  IStorageTransactionJournal,
  IStorageTransactionProgress,
  IStorageTransactionWriteIsolationError,
  ITransactionReader,
  ITransactionWriter,
  IWriterError,
  MediaType,
  MemoryAddressPathComponent,
  Read,
  StorageValue,
  URI,
  Wrote,
} from "./interface.ts";
import { BaseStorageProvider } from "./base.ts";
import * as IDB from "./idb.ts";
export * from "@commontools/memory/interface";
import { Channel, RawCommand } from "./inspector.ts";
import { SchemaNone } from "@commontools/memory/schema";

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

  claim?: void;
}

export interface Retract {
  the: The;
  of: Entity;
  is?: void;

  claim?: void;
}

export interface Claim {
  the: The;
  of: Entity;
  is?: void;
  claim: true;
}

const toKey = ({ the, of }: FactAddress) => `${of}/${the}`;

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

  private static SUBSCRIBE_TO_ALL = "_";

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

      for (
        const subscriber of this.subscribers.get(Heap.SUBSCRIBE_TO_ALL) ?? []
      ) {
        subscriber(this.store.get(key));
      }
    }

    return { ok: {} };
  }

  subscribe(
    entry: FactAddress | null,
    subscriber: (value?: Revision<State>) => void,
  ) {
    const key = entry == null ? Heap.SUBSCRIBE_TO_ALL : toKey(entry);
    let subscribers = this.subscribers.get(key);
    if (!subscribers) {
      subscribers = new Set();
      this.subscribers.set(key, subscribers);
    }

    subscribers.add(subscriber);
  }

  unsubscribe(
    entry: FactAddress | null,
    subscriber: (value?: Revision<State>) => void,
  ) {
    const key = entry == null ? Heap.SUBSCRIBE_TO_ALL : toKey(entry);
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
    const revisions = new Map();
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
    changes: (Assert | Retract | Claim)[],
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
      const invariants: Invariant[] = [];
      for (const { the, of, is, claim } of changes) {
        const fact = this.get({ the, of });

        if (claim) {
          invariants.push({
            the,
            of,
            fact: refer(fact),
          });
        } else if (is === undefined) {
          // If `is` is `undefined` we want to retract the fact.
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
        changes: getChanges([...invariants, ...facts]),
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

  subscribe(
    entry: FactAddress | null,
    subscriber: (value?: Revision<State>) => void,
  ) {
    this.heap.subscribe(entry, subscriber);
  }
  unsubscribe(
    entry: FactAddress | null,
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
          throw new RangeError(`Unknown event type: ${event.type}`);
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
        throw new RangeError(`Socket is closing`);
      case WebSocket.CLOSED:
        throw new RangeError(`Socket is closed`);
      default:
        throw new RangeError(`Socket is in unknown state`);
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
      const replica = new Replica(space, session);
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
    const { workspace } = this;
    const address = { the, of };
    const subscriber = (revision?: Revision<State>) => {
      if (revision) {
        // ⚠️ We may not have a value because fact was retracted or
        // (less likely) deleted altogether. We still need to notify sink
        // but we do is empty object per
        // @see https://github.com/commontoolsinc/labs/pull/989#discussion_r2033651935
        // TODO(@seefeldb): Make compatible `sink` API change
        callback((revision?.is ?? {}) as unknown as StorageValue<T>);
      }
    };

    workspace.subscribe(address, subscriber);
    this.workspace.load([[address, undefined]]);

    return () => workspace.unsubscribe(address, subscriber);
  }

  sync(
    entityId: EntityId,
    expectedInStorage?: boolean,
    schemaContext?: SchemaContext,
  ) {
    const { the } = this;
    const of = BaseStorageProvider.toEntity(entityId);
    return this.workspace.load([[{ the, of }, schemaContext]]);
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

export class StorageManager implements IStorageManager, IStorageManagerV2 {
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

  /**
   * Creates a storage transaction that can be used to read / write data into
   * locally replicated memory spaces. Transaction allows reading from many
   * multiple spaces but writing only to one space.
   */
  edit(): IStorageTransaction {
    return new StorageTransaction(this);
  }
}

export const getChanges = (
  statements: Iterable<Statement>,
) => {
  const changes = {} as MemoryChanges;
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
const getSchema = (
  change: Assert | Retract | Claim,
): SchemaContext | undefined => {
  if (isObject(change?.is) && "labels" in change.is) {
    const schema = { ifc: change.is.labels } as JSONSchema;
    return { schema: schema, rootSchema: schema };
  }
  return undefined;
};

/**
 * Storage transaction implementation that maintains consistency guarantees
 * for reads and writes across memory spaces.
 */
class StorageTransaction implements IStorageTransaction {
  #manager: StorageManager;
  #journal: TransactionJournal;
  #writer?: TransactionWriter;
  #readers: Map<MemorySpace, TransactionReader>;
  #result?: Promise<
    Result<Unit, IStorageTransactionError | InactiveTransactionError>
  >;

  constructor(manager: StorageManager) {
    this.#manager = manager;
    this.#readers = new Map();

    this.#journal = new TransactionJournal();
  }

  status(): Result<IStorageTransactionProgress, IStorageTransactionError> {
    return this.#journal.state();
  }

  reader(
    space: MemorySpace,
  ): Result<TransactionReader, InactiveTransactionError> {
    // Obtait edit session for this transaction, if it fails transaction is
    // no longer editable, in which case we propagate error.

    return this.#journal.edit((journal) => {
      const readers = this.#readers;
      // Otherwise we lookup a a reader for the requested `space`, if we one
      // already exists return it otherwise create one and return it.
      const reader = readers.get(space);
      if (reader) {
        return { ok: reader };
      } else {
        // TODO(@gozala): Refactor codebase so we are able to obtain a replica
        // without having to perform type casting. Previous storage interface
        // was not designed with this new transaction system in mind so there
        // is a mismatch that we can address as a followup.
        const replica = (this.#manager.open(space) as Provider).workspace;
        const reader = new TransactionReader(
          journal,
          replica,
          space,
        );

        replica.subscribe(null, (state) => {
          if (state) {
            journal.merge({ [space]: [state] });
          }
        });

        // Store reader so that subsequent attempts calls of this method.
        readers.set(space, reader);
        return { ok: reader };
      }
    });
  }

  writer(space: MemorySpace): Result<ITransactionWriter, IWriterError> {
    // Obtait edit session for this transaction, if it fails transaction is
    // no longer editable, in which case we propagate error.
    return this.#journal.edit(
      (journal): Result<TransactionWriter, IWriterError> => {
        const writer = this.#writer;
        if (writer) {
          if (writer.did() === space) {
            return { ok: writer };
          } else {
            return {
              error: new WriteIsolationError({
                open: writer.did(),
                requested: space,
              }),
            };
          }
        } else {
          const { ok: reader, error } = this.reader(space);
          if (error) {
            return { error };
          } else {
            const writer = new TransactionWriter(journal, reader);
            this.#writer = writer;
            return { ok: writer };
          }
        }
      },
    );
  }

  read(address: IMemoryAddress) {
    const { ok: reader, error } = this.reader(address.space);
    if (error) {
      return { error };
    } else {
      return reader.read(address);
    }
  }

  write(address: IMemoryAddress, value: JSONValue | undefined) {
    const { ok: writer, error } = this.writer(address.space);
    if (error) {
      return { error };
    } else {
      return writer.write(address, value);
    }
  }

  abort(reason?: Unit): Result<Unit, InactiveTransactionError> {
    return this.#journal.abort(reason);
  }

  async commit(): Promise<
    Result<Unit, IStorageTransactionError | InactiveTransactionError>
  > {
    // Return cached promise if commit was already called
    if (this.#result) {
      return this.#result;
    }

    // Check transaction state
    const { ok: changes, error } = this.#journal.end();
    if (error) {
      this.#result = Promise.resolve({ error });
      return this.#result;
    } else if (this.#writer) {
      const { ok, error } = await this.#writer.replica.push(changes);
      if (error) {
        // TODO(@gozala): Perform rollback
        this.#result = Promise.resolve({
          error: error as IStorageTransactionFailed,
        });
        return this.#result;
      } else {
        this.#result = Promise.resolve({ ok: {} });
        return this.#result!;
      }
    } else {
      this.#result = Promise.resolve({ ok: {} });
      return this.#result;
    }
  }
}

type TransactionProgress = Variant<{
  edit: TransactionJournal;
  pending: TransactionJournal;
  done: TransactionJournal;
}>;

/**
 * Class for maintaining lifecycle of the storage transaction. It's job is to
 * have central place to manage state of the transaction and prevent readers /
 * writers from making to mutate transaction after it's being commited.
 */
class TransactionJournal implements IStorageTransactionJournal {
  #state: Result<TransactionProgress, IStorageTransactionError> = {
    ok: { edit: this },
  };

  /**
   * Complete log of read / write activity for underlaying transaction.
   */
  #activity: Activity[] = [];

  /**
   * State of the facts in the storage that has being read by this transaction.
   */
  #history: History = new History();

  /**
   * Facts that have being asserted / retracted by this transaction. Only last
   * update is captured as prior updates to the same fact are considered
   * redundunt.
   */
  #novelty: Novelty = new Novelty();

  /**
   * Set of facts that have being updated upstream during transaction lifecycle.
   * We track them to ensure that read / writes that may happen later later
   * in the lifecycle will be considered.
   */
  #stale: FactSet = new FactSet();

  /**
   * Memory space that is a write target for this transaction.
   */
  #space: MemorySpace | undefined = undefined;

  // Note that we downcast type to `IStorageTransactionProgress` as we don't
  // want outside users to non public API directly.
  state(): Result<IStorageTransactionProgress, IStorageTransactionError> {
    return this.#state;
  }

  *activity() {
    yield* this.#activity;
  }
  /**
   * Ensures that transaction is still editable, that is it has not being
   * commited yet. If so it returns `{ ok: this }` otherwise, it returns
   * `{ error: InactiveTransactionError }` indicating that transaction is
   * no longer editable.
   *
   * Transaction uses this to ensure transaction is editable before creating
   * new reader / writer. Existing reader / writer also uses it to error
   * read / write operations if transaction is no longer editable.
   */
  edit<Ok extends Unit, EditError extends Error>(
    edit: (journal: TransactionJournal) => Result<Ok, EditError>,
  ): Result<Ok, EditError | InactiveTransactionError> {
    const status = this.#state;
    if (status.error) {
      return status;
    } else if (status.ok.edit) {
      return edit(status.ok.edit);
    } else {
      return {
        error: new TransactionCompleteError(
          `Transaction was finalized by issuing commit`,
        ),
      };
    }
  }

  /**
   * Transitions transaction from editable to aborted state. If transaction is
   * not in editable state returns error.
   */
  abort<Reason extends Unit>(
    reason?: Reason,
  ) {
    return this.edit((journal): Result<Unit, never> => {
      journal.#state = {
        error: new TransactionAborted(reason),
      };

      return { ok: {} as Unit };
    });
  }

  /**
   * Transitions transaction from editable to done state. If transaction is
   * not in editable state returns error.
   */
  end(): Result<
    Array<Assert | Retract | Claim>,
    InactiveTransactionError
  > {
    return this.edit((journal) => {
      const status = { pending: this };
      journal.#state = { ok: status };
      return { ok: this.invariants() };
    });
  }

  read(
    address: IMemoryAddress,
    replica: Replica,
  ) {
    return this.edit((journal): Result<Read, INotFoundError> => {
      // log read activitiy in the journal
      journal.#activity.push({ read: address });
      const [the, of] = [address.type, address.id];

      // Obtain state of the fact from the provided replica and capture
      // it in the journals history
      const before = replica.get({ the, of }) ?? unclaimed({ the, of });
      journal.#history.claims(address.space).add(before);

      // Now read path from the fact as it's known to be at this moment
      const { ok, error } = read(journal.get(address) ?? before, address);
      if (error) {
        return { error };
      } else {
        return { ok: { address, value: ok.value } };
      }
    });
  }

  write(
    address: IMemoryAddress,
    value: JSONValue | undefined,
    replica: Replica,
  ) {
    return this.edit((journal): Result<Wrote, INotFoundError> => {
      // log write activity in the journal
      journal.#activity.push({ write: address });

      const [the, of] = [address.type, address.id];

      // Obtain state of the fact from provided replica to capture
      // what we expect it to be upstream.
      const was = replica.get({ the, of }) ?? unclaimed({ the, of });

      // Now obtais state from the journal in cas it was edited earlier
      // by this transaction.
      const { ok: state, error } = write(
        this.get(address) ?? was,
        address,
        value,
      );
      if (error) {
        return { error };
      } else {
        // Store updated state as novelty, potentially overriding prior state
        journal.#novelty.put(state);

        return { ok: { address, value } };
      }
    });
  }

  /**
   * Returns set of invariants that this transaction makes, which is set of
   * {@link Claim}s corresponding to reads transaction performed and set of
   * {@link Fact}s corresponding to the writes transaction performed.
   */
  invariants(): Array<Assert | Retract | Claim> {
    const history = this.#history;
    const novelty = this.#novelty;
    const space = this.#space;
    const invariants = new Set();

    // First capture all the changes we have made
    const output: (Assert | Retract | Claim)[] = [];
    for (const change of novelty) {
      invariants.add(toKey(change));
      output.push(change);
    }

    if (space) {
      // Then capture all the claims we have made
      for (const claim of history.claims(space)) {
        if (!invariants.has(toKey(claim))) {
          invariants.add(toKey(claim));
          output.push({
            the: claim.the,
            of: claim.of,
            claim: true,
          });
        }
      }
    }

    return output;
  }

  /**
   * Merge is called when we receive remote changes. It checks if any of the
   */
  merge(updates: { [key: MemorySpace]: Iterable<State> }) {
    return this.edit((journal): Result<Unit, IStorageTransactionError> => {
      const inconsistencies = [];
      // Otherwise we caputer every change in our stale set and verify whether
      // changed fact has being journaled by this transaction. If so we mark
      // transition transaction into an inconsistent state.
      const stale = journal.#stale;
      const history = journal.#history;
      for (const [subject, changes] of Object.entries(updates)) {
        const space = subject as MemorySpace;
        for (const { the, of, cause } of changes) {
          const address = { the, of, space };
          // If change has no `cause` it is considered unclaimed and we don't
          // really need to do anything about it.
          if (cause) {
            // First add fact into a stale set.
            stale.add(address);

            // Next check if journal captured changed address in the read
            // history, if so transaction must transaction into an inconsistent
            // state.
            if (history.claims(space).has(address)) {
              inconsistencies.push(address);
            }
          }
        }
      }

      // If we discovered inconsistencies transition journal into error state
      if (inconsistencies.length > 0) {
        journal.#state = { error: new Inconsistency(inconsistencies) };
      }

      // Propagate error if we encountered on to ensure that caller is aware
      // we no longer wish to receive updates
      return journal.state();
    });
  }

  get(address: IMemoryAddress) {
    if (address.space === this.#space) {
      return this.#novelty.get({ the: address.type, of: address.id });
    }
  }
}

/**
 * Novelty introduced by the transaction. It represents changes that have not
 * yet being applied to the memory.
 */
class Novelty {
  #model: Map<string, Assert | Retract> = new Map();

  get size() {
    return this.#model.size;
  }

  get(adddress: FactAddress) {
    return this.#model.get(toKey(adddress));
  }

  *[Symbol.iterator]() {
    yield* this.#model.values();
  }

  delete(address: FactAddress) {
    this.#model.delete(toKey(address));
  }

  put(fact: Assert | Retract) {
    this.#model.set(toKey(fact), fact);
  }
}

/**
 * History captures state of the facts as they appeared in the storage. This is
 * used by {@link TransactionJournal} to capture read invariants so the they can
 * be included in the commit changeset allowing remote to verify that all of the
 * assumptions made by trasaction are still vaild.
 */
class History {
  /**
   * State is grouped by space because we commit will only care about invariants
   * made for the space that is being modified allowing us to iterate those
   * without having to filter.
   */
  #model: Map<MemorySpace, Claims> = new Map();

  /**
   * Returns state group for the requested space. If group does not exists
   * it will be created.
   */
  claims(space: MemorySpace): Claims {
    const claims = this.#model.get(space);
    if (claims) {
      return claims;
    } else {
      const claims = new Claims();
      this.#model.set(space, claims);
      return claims;
    }
  }
}

class Claims {
  #model: Map<string, State> = new Map();

  add(state: State) {
    this.#model.set(toKey(state), state);
  }
  has(address: FactAddress) {
    return this.#model.has(toKey(address));
  }
  *[Symbol.iterator]() {
    yield* this.#model.values();
  }
}

class FactSet {
  #model: Set<string>;
  constructor(model: Set<string> = new Set()) {
    this.#model = model;
  }
  static toKey({ space, the, of }: FactAddress & { space: MemorySpace }) {
    return `${space}/${the}/${of}`;
  }
  add(address: FactAddress & { space: MemorySpace }) {
    this.#model.add(FactSet.toKey(address));
  }
  has(address: FactAddress & { space: MemorySpace }) {
    return this.#model.has(FactSet.toKey(address));
  }
}

export class TransactionCompleteError extends RangeError
  implements IStorageTransactionComplete {
  override name = "StorageTransactionCompleteError" as const;
}

export class TransactionAborted extends RangeError
  implements IStorageTransactionAborted {
  override name = "StorageTransactionAborted" as const;
  reason: unknown;

  constructor(reason?: unknown) {
    super("Transaction was aborted");
    this.reason = reason;
  }
}

export class WriteIsolationError extends RangeError
  implements IStorageTransactionWriteIsolationError {
  override name = "StorageTransactionWriteIsolationError" as const;
  open: MemorySpace;
  requested: MemorySpace;
  constructor(
    { open, requested }: { open: MemorySpace; requested: MemorySpace },
  ) {
    super(
      `Can not open transaction writer for ${requested} beacuse transaction has writer open for ${open}`,
    );
    this.open = open;
    this.requested = requested;
  }
}

export class NotFound extends RangeError implements INotFoundError {
  override name = "NotFoundError" as const;
}

function addressToKey(address: IMemoryAddress): string {
  return `${address.id}/${address.type}/${address.path.join("/")}`;
}

/**
 * Convert IMemoryAddress to FactAddress for use with existing storage system.
 */
function toFactAddress(address: IMemoryAddress): FactAddress {
  return {
    the: address.type,
    of: address.id,
  };
}

/**
 * Reads the value from the given fact at a given path and either returns
 * {@link Read} object or {@link NotFoundError} if path does not exist in
 * the provided {@link State}.
 *
 * Read fails when key is accessed in the non-existing parent, but succeeds
 * with `undefined` when last component of the path does not exists. Here are
 * couple of examples illustrating behavior.
 *
 * ```ts
 * const unclaimed = {
 *    the: "application/json",
 *    of: "test:1",
 * }
 * const fact = {
 *    the: "application/json",
 *    of: "test:1",
 *    is: { hello: "world", from: { user: { name: "Alice" } } }
 * }
 *
 * read({ path: [] }, fact)                   // { ok: { value: fact.is } }
 * read({ path: ['hello'] }, fact)            // { ok: { value: "world" } }
 * read({ path: ['hello', 'length'] }, fact)  // { ok: { value: undefined } }
 * read({ path: ['hello', 0] }, fact)         // { ok: { value: undefined } }
 * read({ path: ['hello', 0, 0] }, fact)      // { error }
 * read({ path: ['from', 'user'] }, fact)     // { ok: { value: {name: "Alice"} } }
 * read({ path: [] }, unclaimed)              // { ok: { value: undefined } }
 * read({ path: ['a'] }, unclaimed)           // { error }
 * ```
 */
const read = (
  state: Assert | Retract,
  address: IMemoryAddress,
): Result<{ value?: JSONValue }, INotFoundError> => resolve(state, address);

const resolve = (
  state: Assert | Retract,
  address: IMemoryAddress,
) => {
  const { path } = address;
  let value = state?.is as JSONValue | undefined;
  let at = -1;
  while (++at < path.length) {
    const key = path[at];
    if (typeof value === "object" && value != null) {
      // We do not support array.length as that is JS specific getter.
      value = Array.isArray(value) && key === "length"
        ? undefined
        : (value as Record<string, JSONValue>)[key];
    } else {
      return {
        error: state
          ? new NotFound(
            `Can not resolve "${address.type}" of "${address.id}" at "${
              path.slice(0, at).join(".")
            }" in "${address.space}", because target is not an object`,
          )
          : new NotFound(
            `Can not resolve "${address.type}" of "${address.id}" at "${
              path.join(".")
            }" in "${address.space}", because target fact is not found in local replica`,
          ),
      };
    }
  }

  return { ok: { value } };
};

const write = (
  state: Assert | Retract,
  address: IMemoryAddress,
  value: JSONValue | undefined,
): Result<Assert | Retract, INotFoundError> => {
  const { path, id: of, type: the, space } = address;

  // We need to handle write without any paths differently as there are various
  // nuances regarding when fact need to be asserted / retracted.
  if (path.length === 0) {
    // If desired value matches current value this is noop.
    return {
      ok: state.is === value
        ? state
        : { the, of, is: value } as Assert | Retract,
    };
  } else {
    // If do have a path we will need to patch `is` under that path. At the
    // moment we will simply copy value using JSON stringy/parse.
    const is = state.is === undefined
      ? state.is
      : JSON.parse(JSON.stringify(state.is));

    const [...at] = path;
    const key = path.pop()!;

    const { ok, error } = resolve({ the, of, is }, { ...address, path });
    if (error) {
      return { error };
    } else {
      const type = ok.value === null ? "null" : typeof ok.value;
      if (type === "object") {
        const target = ok.value as Record<string, JSONValue>;

        // If target value is same as desired value this write is a noop
        if (target[key] === value) {
          return { ok: state };
        } else if (value === undefined) {
          // If value is `undefined` we delete property from the tagret
          delete target[key];
        } else {
          // Otherwise we assign value to the target
          target[key] = value;
        }

        return { ok: { the, of, is } };
      } else {
        return {
          error: new NotFound(
            `Can not write "${the}" of "${of}" at "${
              path.join(".")
            }" in "${space}", because target is not an object`,
          ),
        };
      }
    }
  }
};

/**
 * Transaction reader implementation for reading from a specific memory space.
 * Maintains its own set of Read invariants and can consult Write changes.
 */
class TransactionReader implements ITransactionReader {
  #journal: TransactionJournal;
  #replica: Replica;
  #space: MemorySpace;

  constructor(
    journal: TransactionJournal,
    replica: Replica,
    space: MemorySpace,
  ) {
    this.#journal = journal;
    this.#replica = replica;
    this.#space = space;
  }

  get replica() {
    return this.#replica;
  }

  did() {
    return this.#space;
  }

  read(
    address: IMemoryAddress,
  ): Result<Read, INotFoundError | InactiveTransactionError> {
    return this.#journal.read(address, this.#replica);
  }
}

/**
 * Transaction writer implementation that wraps a TransactionReader
 * and maintains its own set of Write changes.
 */
class TransactionWriter implements ITransactionWriter {
  #state: TransactionJournal;
  #reader: TransactionReader;

  constructor(
    state: TransactionJournal,
    reader: TransactionReader,
  ) {
    this.#state = state;
    this.#reader = reader;
  }

  get replica() {
    return this.#reader.replica;
  }
  did() {
    return this.#reader.did();
  }

  read(
    address: IMemoryAddress,
  ): Result<Read, INotFoundError | InactiveTransactionError> {
    return this.#reader.read(address);
  }

  /**
   * Attempts to write a value at a given memory address and captures relevant
   */
  write(
    address: IMemoryAddress,
    value?: JSONValue,
  ): Result<Wrote, INotFoundError | InactiveTransactionError> {
    return this.#state.write(address, value, this.replica);
  }
}

class Inconsistency extends RangeError
  implements IStorageTransactionInconsistent {
  override name = "StorageTransactionInconsistent" as const;
  constructor(public inconsitencies: (FactAddress & { space: MemorySpace })[]) {
    const details = [`Transaction consistency guarntees have being violated:`];
    for (const address of inconsitencies) {
      details.push(
        `  - The ${address.the} of ${address.of} in ${address.space} got updated`,
      );
    }

    super(details.join("\n"));
  }
}
