import { fromString, refer } from "merkle-reference";
import { isBrowser } from "@commontools/utils/env";
import { isObject } from "@commontools/utils/types";
import { type JSONSchema } from "../builder/types.ts";
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
  ProviderSession,
  QueryError,
  Reference,
  Result,
  Revision,
  SchemaContext,
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
import { assert, claim, retract, unclaimed } from "@commontools/memory/fact";
import { the, toChanges, toRevision } from "@commontools/memory/commit";
import * as Consumer from "@commontools/memory/consumer";
import * as Codec from "@commontools/memory/codec";
import { type Cancel, type EntityId } from "@commontools/runner";
import type {
  Activity,
  Assert,
  Claim,
  CommitError,
  IClaim,
  IMemoryAddress,
  IMemorySpaceAddress,
  InactiveTransactionError,
  INotFoundError,
  IRemoteStorageProviderSettings,
  ISpace,
  ISpaceReplica,
  IStorageEdit,
  IStorageInvariant,
  IStorageManager,
  IStorageManagerV2,
  IStorageProvider,
  IStorageTransaction,
  IStorageTransactionAborted,
  IStorageTransactionComplete,
  IStorageTransactionInconsistent,
  IStorageTransactionProgress,
  IStorageTransactionRejected,
  IStorageTransactionWriteIsolationError,
  IStoreError,
  ITransaction,
  ITransactionInvariant,
  ITransactionJournal,
  ITransactionReader,
  ITransactionWriter,
  MediaType,
  MemoryAddressPathComponent,
  PushError,
  ReaderError,
  ReadError,
  Retract,
  StorageTransactionFailed,
  StorageValue,
  URI,
  WriteError,
  WriterError,
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
    Result<Selection<Address, Model>, IStoreError>
  >;
}

export interface AsyncPush<Model> {
  merge(
    entries: Iterable<Model>,
    merge: Merge<Model>,
  ): Promise<Result<Unit, IStoreError>>;
}

export interface AsyncStore<Model, Address>
  extends AsyncPull<Model, Address>, AsyncPush<Model> {
}

export interface SyncPull<Model, Address> {
  pull(
    selector: Selector<Address>,
  ): Promise<
    Result<Selection<Address, Model>, IStoreError>
  >;
}

export interface SyncPush<Model> {
  merge(
    entries: Iterable<Model>,
    merge: Merge<Model>,
  ): Result<Unit, IStoreError>;
}

export interface SyncStore<Model, Address>
  extends SyncPull<Model, Address>, SyncPush<Model> {
}

interface NotFoundError extends Error {
  name: "NotFound";
  address: FactAddress;
}

const toKey = ({ the, of }: FactAddress) => `${of}/${the}`;

export class NoCache<Model extends object, Address>
  implements AsyncStore<Model, Address> {
  /**
   * Pulls nothing because this store does not store anything.
   */
  async pull(
    selector: Selector<Address>,
  ): Promise<Result<Selection<Address, Model>, IStoreError>> {
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

  /**
   * If state `before` and `after` are the same that implies that remote has
   * caught up with `nursery` so we evict record from nursery allowing reads
   * to fall through to `heap`. If `after` is `undefined` that is very unusual,
   * yet we keep value from `before` as nursery is more likely ahead. If
   * `before` is `undefined` keep it as is because reads would fall through
   * to `heap` anyway.
   */
  static evict(before?: State, after?: State) {
    return before == undefined
      ? undefined
      : after === undefined
      ? before
      : JSON.stringify(before) === JSON.stringify(after)
      ? undefined
      : before;
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

  did(): MemorySpace {
    return this.space;
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
      this.integrate(next.value[this.space] as unknown as Commit);
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
      IStoreError | QueryError | AuthorizationError | ConnectionError
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
      IStoreError | QueryError | AuthorizationError | ConnectionError
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
      PushError
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
      const claims: Invariant[] = [];
      for (const { the, of, is, claim } of changes) {
        const fact = this.get({ the, of });

        if (claim) {
          claims.push({
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

      // These push transaction that will commit desired state to a remote.
      return this.commit({ facts, claims });
    }
  }

  async commit({ facts, claims }: ITransaction) {
    // Store facts in a nursery so that subsequent changes will be build
    // optimistically assuming that push will succeed.
    this.nursery.merge(facts, Nursery.put);

    // These push transaction that will commit desired state to a remote.
    const result = await this.remote.transact({
      changes: getChanges([...claims, ...facts] as Statement[]),
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
      // Evict redundant facts which we just merged into `heap` so that reads
      // will occur from `heap`. This way future changes upstream we not get
      // shadowed by prior local changes.
      this.nursery.merge(facts, Nursery.evict);
    }

    return result;
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

  integrate(commit: Commit) {
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
  get(entry: FactAddress): State | undefined {
    return this.nursery.get(entry) ?? this.heap.get(entry);
  }
}

export interface RemoteStorageProviderOptions {
  session: Consumer.MemoryConsumer<MemorySpace>;
  space: MemorySpace;
  the?: string;
  settings?: IRemoteStorageProviderSettings;
}

export const defaultSettings: IRemoteStorageProviderSettings = {
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
  settings: IRemoteStorageProviderSettings;

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
      | IStoreError
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
  settings?: IRemoteStorageProviderSettings;
}

interface Differential<T>
  extends Iterable<[undefined, T] | [T, undefined] | [T, T]> {
}

export class StorageManager implements IStorageManager, IStorageManagerV2 {
  address: URL;
  as: Signer;
  id: string;
  settings: IRemoteStorageProviderSettings;
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
  #journal: TransactionJournal;
  #writer?: MemorySpace;
  #result?: Promise<
    Result<Unit, StorageTransactionFailed>
  >;

  constructor(manager: StorageManager) {
    this.#journal = new TransactionJournal(manager);
  }

  status(): Result<IStorageTransactionProgress, StorageTransactionFailed> {
    return this.#journal.state();
  }

  reader(
    space: MemorySpace,
  ): Result<ITransactionReader, ReaderError> {
    return this.#journal.reader(space);
  }

  writer(
    space: MemorySpace,
  ): Result<TransactionWriter, WriterError> {
    const writer = this.#writer;
    if (writer && writer !== space) {
      return {
        error: new WriteIsolationError({
          open: writer,
          requested: space,
        }),
      };
    } else {
      const { ok: writer, error } = this.#journal.writer(space);
      if (error) {
        return { error };
      } else {
        this.#writer = space;
        return { ok: writer };
      }
    }
  }

  read(address: IMemorySpaceAddress) {
    const { ok: reader, error } = this.reader(address.space);
    if (error) {
      return { error };
    } else {
      return reader.read(address);
    }
  }

  write(
    address: IMemorySpaceAddress,
    value: JSONValue | undefined,
  ) {
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

  commit(): Promise<
    Result<Unit, CommitError>
  > {
    // Return cached promise if commit was already called
    if (this.#result) {
      return this.#result;
    }

    // Check transaction state
    const { ok: edit, error } = this.#journal.close();
    if (error) {
      this.status();
      this.#result = Promise.resolve(
        // End can fail if we are in non-edit mode however if we are in non-edit
        // mode we would have result already.
        { error } as { error: StorageTransactionFailed },
      );
    } else if (this.#writer) {
      const { ok: writer, error } = this.#journal.writer(this.#writer);
      if (error) {
        this.#result = Promise.resolve({
          error: error as IStorageTransactionRejected,
        });
      } else {
        this.#result = writer.replica.commit(edit.for(this.#writer));
      }
    } else {
      this.#result = Promise.resolve({ ok: {} });
    }

    return this.#result;
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
export class TransactionJournal implements ITransactionJournal {
  #manager: StorageManager;
  #readers: Map<MemorySpace, TransactionReader> = new Map();
  #writers: Map<MemorySpace, TransactionWriter> = new Map();

  #state: Result<TransactionProgress, StorageTransactionFailed> = {
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

  constructor(manager: StorageManager) {
    this.#manager = manager;
  }

  // Note that we downcast type to `IStorageTransactionProgress` as we don't
  // want outside users to non public API directly.
  state(): Result<IStorageTransactionProgress, StorageTransactionFailed> {
    return this.#state;
  }

  *activity() {
    yield* this.#activity;
  }

  novelty(space: MemorySpace) {
    return this.#novelty.for(space);
  }

  history(space: MemorySpace) {
    return this.#history.for(space);
  }

  reader(space: MemorySpace) {
    // Obtait edit session for this transaction, if it fails transaction is
    // no longer editable, in which case we propagate error.

    return this.edit((journal): Result<TransactionReader, never> => {
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

        // Store reader so that subsequent attempts calls of this method.
        readers.set(space, reader);
        return { ok: reader };
      }
    });
  }

  writer(
    space: MemorySpace,
  ): Result<TransactionWriter, WriterError> {
    // Obtait edit session for this transaction, if it fails transaction is
    // no longer editable, in which case we propagate error.
    return this.edit(
      (journal): Result<TransactionWriter, WriterError> => {
        const writer = this.#writers.get(space);
        if (writer) {
          return { ok: writer };
        } else {
          const { ok: reader, error } = this.reader(space);
          if (error) {
            return { error };
          } else {
            const writer = new TransactionWriter(journal, reader);
            this.#writers.set(space, writer);
            return { ok: writer };
          }
        }
      },
    );
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
  ): Result<Unit, InactiveTransactionError> {
    return this.edit((journal): Result<Unit, never> => {
      journal.#state = {
        error: new TransactionAborted(reason),
      };

      return { ok: {} as Unit };
    });
  }

  /** */
  close() {
    return this.edit((journal) => {
      const status = { pending: this };
      journal.#state = { ok: status };

      const edit = new StorageEdit();

      for (const [space, invariants] of journal.#history) {
        for (const invariant of invariants) {
          const replica = this.#readers.get(space)?.replica;
          const address = { ...invariant.address, space };
          const state = replica?.get({ the: address.type, of: address.id }) ??
            unclaimed({ the: address.type, of: address.id });
          const actual = {
            address: { ...address, path: [] },
            value: state.is,
          };
          const value = TransactionInvariant.read(actual, address)?.ok?.value;

          if (JSON.stringify(invariant.value) !== JSON.stringify(value)) {
            journal.#state = { error: new Inconsistency([actual, invariant]) };
            return journal.#state;
          } else {
            edit.for(space).claim(state);
          }
        }
      }

      for (const [space, invariants] of journal.#novelty) {
        for (const invariant of invariants) {
          const replica = this.#readers.get(space)?.replica;
          const address = { ...invariant.address, space };
          const state = replica?.get({ the: address.type, of: address.id }) ??
            unclaimed({ the: address.type, of: address.id });
          const actual = {
            address: { ...address, path: [] },
            value: state.is,
          };

          const { error, ok: change } = TransactionInvariant.write(
            actual,
            address,
            invariant.value,
          );

          if (error) {
            journal.#state = {
              error: new Inconsistency([actual, invariant]),
            };
            return journal.#state;
          } else {
            // If change removes the fact we either retract it or if it was
            // already retracted we just claim current state.
            if (change.value === undefined) {
              if (state.is === undefined) {
                edit.for(space).claim(state);
              } else {
                edit.for(space).retract(state);
              }
            } else {
              edit.for(space).assert({
                the: state.the,
                of: state.of,
                is: change.value,
                cause: refer(state),
              });
            }
          }
        }
      }

      return { ok: edit };
    });
  }

  read(
    at: IMemoryAddress,
    replica: ISpaceReplica,
  ): Result<ITransactionInvariant, ReadError> {
    const address = { ...at, space: replica.did() };
    return this.edit(
      (journal): Result<ITransactionInvariant, INotFoundError> => {
        // log read activitiy in the journal
        journal.#activity.push({ read: address });
        const [the, of] = [address.type, address.id];

        // We may have written into an addressed or it's parent memory loaction,
        // if so MUST read from it as it will contain current state. If we have
        // not written, we should also consider read we made made from the
        // addressed or it's parent memory location. If we find either write or
        // read invariant we read from it and return the value.
        const prior = this.get(address);
        if (prior) {
          return TransactionInvariant.read(prior, address);
        }

        // If we have not wrote or read from the relevant memory location we'll
        // have to read from the local replica and if it does not contain a
        // corresponding fact we assume fact to be new ethier way we use it
        const state = replica.get({ the, of }) ??
          unclaimed({ the, of });

        const { ok, error } = TransactionInvariant.read({
          address: { ...address, path: [] },
          value: state.is,
        }, address);

        // If we we could not read desired path from the invariant we fail the
        // read without capturing new invariant. We expect reader to ascend the
        // address path until it finds existing value.
        if (error) {
          return { error };
        } else {
          // If read succeeds we attempt to claim read invariant, however it may
          // be in violation with previously claimed invariant e.g. previously
          // we claimed `user.name = "Alice"` and now we are claiming that
          // `user = { name: "John" }`. This indicates that state between last
          // read from the replica and current read form the replica has changed.
          const result = this.#history.for(address.space).claim(ok);
          // If so we switch current state to an inconsistent state as this
          // transaction can no longer succeed.
          if (result.error) {
            this.#state = result;
          }
          return result;
        }
      },
    );
  }

  write(
    at: IMemoryAddress,
    value: JSONValue | undefined,
    replica: ISpace,
  ): Result<ITransactionInvariant, WriteError> {
    return this.edit(
      (journal): Result<ITransactionInvariant, INotFoundError> => {
        const address = { ...at, space: replica.did() };
        journal.#activity.push({ write: address });
        // We may have written path this will be overwritting.
        return this.#novelty.for(address.space).claim({
          address,
          value,
        });
      },
    );
  }

  get(address: IMemorySpaceAddress) {
    return this.#novelty.for(address.space)?.get(address) ??
      this.#history.for(address.space).get(address);
  }
}

class TransactionInvariant {
  #model: Map<string, ITransactionInvariant> = new Map();

  protected get model() {
    return this.#model;
  }

  static toKey(address: IMemoryAddress) {
    return `/${address.id}/${address.type}/${address.path.join("/")}`;
  }

  static resolve(
    source: ITransactionInvariant,
    address: IMemorySpaceAddress,
  ): Result<ITransactionInvariant, INotFoundError> {
    const { path } = address;
    let at = source.address.path.length - 1;
    let value = source.value;
    while (++at < path.length) {
      const key = path[at];
      if (typeof value === "object" && value != null) {
        // We do not support array.length as that is JS specific getter.
        value = Array.isArray(value) && key === "length"
          ? undefined
          : (value as Record<string, JSONValue>)[key];
      } else {
        return {
          error: new NotFound(
            `Can not resolve "${address.type}" of "${address.id}" at "${
              path.slice(0, at).join(".")
            }" in "${address.space}", because target is not an object`,
          ),
        };
      }
    }

    return { ok: { value, address } };
  }

  static read(source: ITransactionInvariant, address: IMemorySpaceAddress) {
    return this.resolve(source, address);
  }

  static write(
    source: ITransactionInvariant,
    address: IMemorySpaceAddress,
    value: JSONValue | undefined,
  ): Result<ITransactionInvariant, INotFoundError> {
    const path = address.path.slice(source.address.path.length);
    if (path.length === 0) {
      return { ok: { ...source, value } };
    } else {
      const key = path.pop()!;
      const patch = {
        ...source,
        value: source.value === undefined
          ? source.value
          : JSON.parse(JSON.stringify(source.value)),
      };

      const { ok, error } = this.resolve(patch, { ...address, path });

      if (error) {
        return { error };
      } else {
        const type = ok.value === null ? "null" : typeof ok.value;
        if (type === "object") {
          const target = ok.value as Record<string, JSONValue>;

          // If target value is same as desired value this write is a noop
          if (target[key] === value) {
            return { ok: source };
          } else if (value === undefined) {
            // If value is `undefined` we delete property from the tagret
            delete target[key];
          } else {
            // Otherwise we assign value to the target
            target[key] = value;
          }

          return { ok: patch };
        } else {
          return {
            error: new NotFound(
              `Can not write "${address.type}" of "${address.id}" at "${
                path.join(".")
              }" in "${address.space}", because target is not an object`,
            ),
          };
        }
      }
    }
  }

  *[Symbol.iterator]() {
    yield* this.#model.values();
  }
}

/**
 * Novelty introduced by the transaction. It represents changes that have not
 * yet being applied to the memory.
 */
export class Novelty {
  /**
   * State is grouped by space because we commit will only care about invariants
   * made for the space that is being modified allowing us to iterate those
   * without having to filter.
   */
  #model: Map<MemorySpace, WriteInvariants> = new Map();

  /**
   * Returns state group for the requested space. If group does not exists
   * it will be created.
   */
  for(space: MemorySpace): WriteInvariants {
    const invariants = this.#model.get(space);
    if (invariants) {
      return invariants;
    } else {
      const invariants = new WriteInvariants(space);
      this.#model.set(space, invariants);
      return invariants;
    }
  }

  *[Symbol.iterator]() {
    yield* this.#model.entries();
  }
}

class StorageEdit implements IStorageEdit {
  #transactions: Map<MemorySpace, SpaceTransaction> = new Map();

  for(space: MemorySpace) {
    const transaction = this.#transactions.get(space);
    if (transaction) {
      return transaction;
    } else {
      const transaction = new SpaceTransaction();
      this.#transactions.set(space, transaction);
      return transaction;
    }
  }
}

class SpaceTransaction implements ITransaction {
  #claims: IClaim[] = [];
  #facts: Fact[] = [];

  claim(state: State) {
    this.#claims.push({
      the: state.the,
      of: state.of,
      fact: refer(state),
    });
  }
  retract(fact: Assertion) {
    this.#facts.push(retract(fact));
  }

  assert(fact: Assertion) {
    this.#facts.push(fact);
  }

  get claims() {
    return this.#claims;
  }
  get facts() {
    return this.#facts;
  }
}

class WriteInvariants {
  #model: Map<string, ITransactionInvariant> = new Map();
  #space: MemorySpace;
  constructor(space: MemorySpace) {
    this.#space = space;
  }

  get space() {
    return this.#space;
  }
  get(address: IMemoryAddress) {
    const at = TransactionInvariant.toKey(address);
    let candidate: undefined | ITransactionInvariant = undefined;
    for (const [key, entry] of this.#model) {
      // If key contains the address we should be able to read from here.
      if (at.startsWith(key)) {
        if (
          candidate?.address?.path?.length ?? -1 < entry.address.path.length
        ) {
          candidate = entry;
        }
      }
    }
    return candidate;
  }

  /**
   * Claims a new write invariant, merging it with existing parent invariants
   * when possible instead of keeping both parent and child separately.
   */
  claim(
    invariant: ITransactionInvariant,
  ): Result<ITransactionInvariant, INotFoundError> {
    const at = TransactionInvariant.toKey(invariant.address);
    const address = { ...invariant.address, space: this.#space };

    for (const candidate of this.#model.values()) {
      const key = TransactionInvariant.toKey(candidate.address);
      // If the new invariant is a parent of the existing invariant we
      // merge provided child invariant with existing parent inveraint.
      if (at.startsWith(key)) {
        const { error, ok: merged } = TransactionInvariant.write(
          candidate,
          address,
          invariant.value,
        );

        if (error) {
          return { error };
        } else {
          this.#model.set(key, merged);
          return { ok: merged };
        }
      }
    }

    // If we did not found any parents we may have some children
    // that will be replaced by this invariant
    for (const key of this.#model.keys()) {
      // If address constains address of the entry it is being
      // overwritten so we can remove it.
      if (key.startsWith(at)) {
        this.#model.delete(key);
      }
    }
    // Store this invariant
    this.#model.set(at, invariant);

    return { ok: invariant };
  }

  *[Symbol.iterator]() {
    yield* this.#model.values();
  }
}

/**
 * History captures state of the facts as they appeared in the storage. This is
 * used by {@link TransactionJournal} to capture read invariants so the they can
 * be included in the commit changeset allowing remote to verify that all of the
 * assumptions made by trasaction are still vaild.
 */
export class History {
  /**
   * State is grouped by space because we commit will only care about invariants
   * made for the space that is being modified allowing us to iterate those
   * without having to filter.
   */
  #model: Map<MemorySpace, ReadInvariants> = new Map();

  /**
   * Returns state group for the requested space. If group does not exists
   * it will be created.
   */
  for(space: MemorySpace): ReadInvariants {
    const invariantns = this.#model.get(space);
    if (invariantns) {
      return invariantns;
    } else {
      const invariantns = new ReadInvariants(space);
      this.#model.set(space, invariantns);
      return invariantns;
    }
  }

  *[Symbol.iterator]() {
    yield* this.#model.entries();
  }
}
class ReadInvariants {
  #model: Map<string, ITransactionInvariant> = new Map();
  #space: MemorySpace;
  constructor(space: MemorySpace) {
    this.#space = space;
  }

  get space() {
    return this.#space;
  }
  *[Symbol.iterator]() {
    yield* this.#model.values();
  }

  /**
   * Gets {@link TransactionInvariant} for the given `address` from which we
   * could read out the value. Note that returned invariant may not have exact
   * same `path` as the provided by the address, but if one is returned it will
   * have either exact same path or a parent path.
   *
   * @example
   * ```ts
   * const alice = {
   *    address: { id: 'user:1', type: 'application/json', path: ['profile'] }
   *    value: { name: "Alice", email: "alice@web.mail" }
   * }
   * const history = new MemorySpaceHistory()
   * history.put(alice)
   *
   * history.get(alice.address) === alice
   * // Lookup nested path still returns `alice`
   * history.get({
   *  id: 'user:1',
   *  type: 'application/json',
   *  path: ['profile', 'name']
   * }) === alice
   * ```
   */
  get(address: IMemoryAddress) {
    const at = TransactionInvariant.toKey(address);
    let candidate: undefined | ITransactionInvariant = undefined;
    for (const invariant of this) {
      const key = TransactionInvariant.toKey(invariant.address);
      // If `address` is contained in inside an invariant address it is a
      // candidate invariant. If this candidate has longer path than previous
      // candidate this is a better match so we pick this one.
      if (at.startsWith(key)) {
        if (!candidate) {
          candidate = invariant;
        } else if (
          candidate.address.path.length < invariant.address.path.length
        ) {
          candidate = invariant;
        }
      }
    }

    return candidate;
  }

  /**
   * Claims an new read invariant while ensuring consistency with all the
   * privous invariants.
   */
  claim(
    invariant: ITransactionInvariant,
  ): Result<ITransactionInvariant, IStorageTransactionInconsistent> {
    const at = TransactionInvariant.toKey(invariant.address);

    // Track which invariants to delete after consistency check
    const obsolete = new Set<string>();

    for (const candidate of this) {
      const key = TransactionInvariant.toKey(candidate.address);
      // If we have an existing invariant that is either child or a parent of
      // the new one two must be consistent with one another otherwise we are in
      // an inconsistent state.
      if (at.startsWith(key) || key.startsWith(at)) {
        // Always read at the more specific (longer) path for consistency check
        const address = at.length > key.length
          ? { ...invariant.address, space: this.space }
          : { ...candidate.address, space: this.space };

        const expect = TransactionInvariant.read(candidate, address).ok?.value;
        const actual = TransactionInvariant.read(invariant, address).ok?.value;

        if (JSON.stringify(expect) !== JSON.stringify(actual)) {
          return { error: new Inconsistency([candidate, invariant]) };
        }

        // If consistent, determine which invariant(s) to keep
        if (at === key) {
          // Same exact address - replace the existing invariant
          // No need to mark as obsolete, just overwrite
          continue;
        } else if (at.startsWith(key)) {
          // New invariant is a child of existing candidate (candidate is parent)
          // Drop the child invariant as it's redundant with the parent
          obsolete.add(at);
        } else if (key.startsWith(at)) {
          // New invariant is a parent of existing candidate (candidate is child)
          // Delete the child candidate as it's redundant with the new parent
          obsolete.add(key);
        }
      }
    }

    if (!obsolete.has(at)) {
      this.#model.set(at, invariant);
    }

    // Delete redundant child invariants
    for (const key of obsolete) {
      this.#model.delete(key);
    }

    return { ok: invariant };
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
 * {@link ITransactionInvariant} object or {@link NotFoundError} if path does not exist in
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
  address: IMemorySpaceAddress,
): Result<ITransactionInvariant, INotFoundError> => resolve(state, address);

const resolve = (
  state: Assert | Retract,
  address: IMemorySpaceAddress,
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

  return { ok: { value, address } };
};

const write = (
  state: Assert | Retract,
  address: IMemorySpaceAddress,
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
    const key = at.pop()!;

    const { ok, error } = resolve({ the, of, is }, { ...address, path: at });
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
  #journal: ITransactionJournal;
  #replica: ISpaceReplica;
  #space: MemorySpace;

  constructor(
    journal: ITransactionJournal,
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
  ): Result<ITransactionInvariant, ReadError> {
    return this.#journal.read(address, this.#replica);
  }
}

/**
 * Transaction writer implementation that wraps a TransactionReader
 * and maintains its own set of Write changes.
 */
class TransactionWriter implements ITransactionWriter {
  #journal: TransactionJournal;
  #reader: TransactionReader;

  constructor(
    state: TransactionJournal,
    reader: TransactionReader,
  ) {
    this.#journal = state;
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
  ): Result<ITransactionInvariant, ReadError> {
    return this.#reader.read(address);
  }

  /**
   * Attempts to write a value at a given memory address and captures relevant
   */
  write(
    address: IMemoryAddress,
    value?: JSONValue,
  ): Result<ITransactionInvariant, WriteError> {
    return this.#journal.write(address, value, this.replica);
  }
}

class Inconsistency extends RangeError
  implements IStorageTransactionInconsistent {
  override name = "StorageTransactionInconsistent" as const;
  constructor(public inconsitencies: ITransactionInvariant[]) {
    const details = [`Transaction consistency guarntees have being violated:`];
    for (const { address, value } of inconsitencies) {
      details.push(
        `  - The ${address.type} of ${address.id} at ${
          address.path.join(".")
        } has value ${JSON.stringify(value)}`,
      );
    }

    super(details.join("\n"));
  }
}
