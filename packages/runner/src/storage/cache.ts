import { fromString, refer } from "merkle-reference";
import type {
  Changes as MemoryChanges,
  Commit,
  ConsumerCommandInvocation,
  Entity,
  Fact,
  FactAddress,
  Invariant,
  JSONValue,
  MemorySpace,
  Protocol,
  ProviderCommand,
  Result,
  Revision,
  SchemaPathSelector,
  SchemaQueryArgs,
  Signer,
  State,
  Statement,
  The,
  UCAN,
  Unit,
} from "@commontools/memory/interface";
import { set, setSelector } from "@commontools/memory/selection";
import type { MemorySpaceSession } from "@commontools/memory/consumer";
import {
  assert,
  claimState,
  retract,
  unclaimed,
} from "@commontools/memory/fact";
import { COMMIT_LOG_TYPE, toRevision } from "@commontools/memory/commit";
import * as Consumer from "@commontools/memory/consumer";
import * as Codec from "@commontools/memory/codec";
import type { Cancel } from "@commontools/runner";
import { getLogger } from "@commontools/utils/logger";
import { isBrowser } from "@commontools/utils/env";
import { SchemaNone } from "@commontools/memory/schema";
import { Immutable, isObject, isRecord } from "@commontools/utils/types";
import type { JSONSchema } from "../builder/types.ts";
import { ContextualFlowControl } from "../cfc.ts";
import { deepEqual } from "../path-utils.ts";
import { BaseMemoryAddress, MapSet } from "../traverse.ts";
import type {
  Assert,
  Claim,
  IRemoteStorageProviderSettings,
  IStorageManager,
  IStorageProvider,
  IStorageProviderWithReplica,
  IStorageSubscription,
  IStorageTransaction,
  IStoreError,
  ITransaction,
  PullError,
  PushError,
  Retract,
  StorageValue,
  URI,
} from "./interface.ts";
import { type Cell, isCell } from "../cell.ts";
import * as IDB from "./idb.ts";
export * from "@commontools/memory/interface";
import { Channel, RawCommand } from "./inspector.ts";
import * as Transaction from "./transaction.ts";
import * as SubscriptionManager from "./subscription.ts";
import * as Differential from "./differential.ts";
import * as Address from "./transaction/address.ts";

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

const logger = getLogger("storage.cache");

interface NotFoundError extends Error {
  name: "NotFound";
  address: FactAddress;
}

const toKey = ({ id, type }: BaseMemoryAddress) => `${id}/${type}`;
const fromKey = (key: string): BaseMemoryAddress => {
  const separatorIndex = key.indexOf("/");
  if (separatorIndex === -1) {
    throw new Error(`Invalid key format: ${key}`);
  }
  const id = key.substring(0, separatorIndex);
  const type = key.substring(separatorIndex + 1);
  return { id: id as URI, type };
};

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
  get(entry: BaseMemoryAddress) {
    return this.store.get(toKey(entry));
  }

  merge(entries: Iterable<State>, merge: Merge<State>) {
    for (const entry of entries) {
      const address = { id: entry.of, type: entry.the };
      const key = toKey(address);
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

  get(entry: BaseMemoryAddress) {
    return this.store.get(toKey(entry));
  }

  merge(
    entries: Iterable<Revision<State>>,
    merge: Merge<Revision<State>>,
    notifyFilter?: (state: Revision<State> | undefined) => boolean,
  ) {
    const updated = new Set<string>();
    for (const entry of entries) {
      const address = { id: entry.of, type: entry.the };
      const key = toKey(address);
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
      if (notifyFilter === undefined || notifyFilter(this.store.get(key))) {
        for (const subscriber of this.subscribers.get(key) ?? []) {
          subscriber(this.store.get(key));
        }
      }
    }

    return { ok: {} };
  }

  subscribe(
    entry: BaseMemoryAddress,
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
    entry: BaseMemoryAddress,
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
    public members: Map<string, [BaseMemoryAddress, SchemaPathSelector?]> =
      new Map(),
  ) {
  }
  add(entries: Iterable<[BaseMemoryAddress, SchemaPathSelector?]>) {
    // TODO(@ubik2) Ensure the schema context matches
    for (const [entry, selector] of entries) {
      this.members.set(toKey(entry), [entry, selector]);
    }
  }

  consume(): [BaseMemoryAddress, SchemaPathSelector?][] {
    const entries = [...this.members.values()];
    this.members.clear();
    return entries;
  }
}

// This class helps us maintain a client model of our server side subscriptions
export class SelectorTracker<T = Result<Unit, Error>> {
  // Map from BaseMemoryAddress key string to set of selectorRef strings
  private refTracker = new MapSet<string, string>();
  // Map from selectorRef string to selector
  private selectors = new Map<string, SchemaPathSelector>();
  private standardizedSelector = new Map<string, SchemaPathSelector>();
  // Map from string combination of BaseMemoryAddress and selectorRef to
  // promise that contains the result of querying that selector.
  private selectorPromises = new Map<string, Promise<T>>();

  add(
    address: BaseMemoryAddress,
    selector: SchemaPathSelector,
    promise: Promise<T>,
  ) {
    if (selector === undefined || selector.schemaContext === undefined) {
      return;
    }
    const selectorRef = refer(JSON.stringify(selector)).toString();
    this.refTracker.add(toKey(address), selectorRef);
    this.selectors.set(selectorRef, selector);
    this.standardizedSelector.set(selectorRef, {
      path: selector.path,
      schemaContext: {
        schema: SelectorTracker.getStandardSchema(
          selector.schemaContext.schema,
        ),
        rootSchema: SelectorTracker.getStandardSchema(
          selector.schemaContext.rootSchema,
        ),
      },
    });
    const promiseKey = `${toKey(address)}?${selectorRef}`;
    this.selectorPromises.set(promiseKey, promise);
  }

  has(address: BaseMemoryAddress): boolean {
    return this.refTracker.has(toKey(address));
  }

  hasSelector(
    address: BaseMemoryAddress,
    selector: SchemaPathSelector,
  ): boolean {
    const selectorRefs = this.refTracker.get(toKey(address));
    if (selectorRefs !== undefined) {
      const selectorRef = refer(JSON.stringify(selector)).toString();
      return selectorRefs.has(selectorRef);
    }
    return false;
  }

  getSupersetSelector(
    address: BaseMemoryAddress,
    selector: SchemaPathSelector,
    cfc: ContextualFlowControl,
  ): [SchemaPathSelector?, Promise<T>?] {
    const selectorRefs = this.refTracker.get(toKey(address));
    const noMatch: [SchemaPathSelector?, Promise<T>?] = [undefined, undefined];
    if (selectorRefs === undefined) {
      return noMatch;
    }
    const newSelectorRef = refer(JSON.stringify(selector)).toString();
    // A selector is its own superset
    if (selectorRefs.has(newSelectorRef)) {
      const promiseKey = `${toKey(address)}?${newSelectorRef}`;
      return [
        this.standardizedSelector.get(newSelectorRef)!,
        this.selectorPromises.get(promiseKey)!,
      ];
    }
    const newAddress = { ...address, path: selector.path };
    const newRootSchemaString = JSON.stringify(
      selector.schemaContext?.rootSchema
        ? SelectorTracker.getStandardSchema(selector.schemaContext.rootSchema)
        : undefined,
    );
    const newSchema = selector.schemaContext?.schema
      ? SelectorTracker.getStandardSchema(selector.schemaContext.schema)
      : false;
    const newSchemaString = JSON.stringify(newSchema);
    const hasRefs = SelectorTracker.hasRefs(newSchema);
    for (const selectorRef of selectorRefs) {
      const existingSelector = this.standardizedSelector.get(selectorRef)!;
      const existingAddress = { ...address, path: existingSelector.path };
      if (Address.includes(existingAddress, newAddress)) {
        const existingSchema = existingSelector.schemaContext?.schema;
        const existingRootSchema = existingSelector.schemaContext?.rootSchema;
        if (existingSchema === undefined) {
          continue;
        }
        if (hasRefs) {
          // If we have refs, we may need to resolve them in the rootSchema,
          // so check that those match
          const existingRootSchemaString = JSON.stringify(existingRootSchema);
          // If the root schema doesn't match, the selectors aren't similar enough
          if (existingRootSchemaString !== newRootSchemaString) {
            continue;
          }
        }
        const subPath = newAddress.path.slice(existingAddress.path.length);
        const subSchema = cfc.schemaAtPath(
          existingSchema,
          subPath,
          existingRootSchema,
        );
        // Basic matching -- we may not recognize some supersets
        // If the subSchema has ifc flags, but the new schema does not, the
        // existing selector can still be a superset.
        // The logic here around anyOf is a bit problematic. These require the
        // real data to narrow, and without data, all we can do is generate
        // a union of all possible anyOf. In this case, the narrowed schema
        // is not a subset of the original query, but we treat it as such.
        if (
          ContextualFlowControl.isTrueSchema(subSchema) ||
          JSON.stringify(subSchema) === newSchemaString ||
          SelectorTracker.checkAnyOf(
            subSchema,
            existingRootSchema,
            newSchemaString,
          ) || newSchema === false
        ) {
          const promiseKey = `${toKey(address)}?${selectorRef}`;
          return [existingSelector, this.selectorPromises.get(promiseKey)!];
        }
      }
    }
    return noMatch;
  }

  get(address: BaseMemoryAddress): IteratorObject<SchemaPathSelector> {
    const selectorRefs = this.refTracker.get(toKey(address)) ?? [];
    return selectorRefs.values().map((selectorRef) =>
      this.selectors.get(selectorRef)!
    );
  }

  getPromise(
    address: BaseMemoryAddress,
    selector: SchemaPathSelector,
  ): Promise<T> | undefined {
    const selectorRef = refer(JSON.stringify(selector)).toString();
    const promiseKey = `${toKey(address)}?${selectorRef}`;
    return this.selectorPromises.get(promiseKey);
  }

  getAllPromises(): Iterable<Promise<T>> {
    return this.selectorPromises.values();
  }

  /**
   * Return all tracked subscriptions as an array of {factAddress, selector} pairs
   */
  getAllSubscriptions(): {
    address: BaseMemoryAddress;
    selector: SchemaPathSelector;
  }[] {
    const subscriptions: {
      address: BaseMemoryAddress;
      selector: SchemaPathSelector;
    }[] = [];
    for (const [factKey, selectorRefs] of this.refTracker) {
      const address = fromKey(factKey);
      for (const selectorRef of selectorRefs) {
        const selector = this.selectors.get(selectorRef);
        if (selector) {
          subscriptions.push({ address, selector });
        }
      }
    }
    return subscriptions;
  }

  // Check whether the schema is an anyOf with an item that matches our
  // schemaString.
  // If the anyOf items are `$ref` items, resolve them, then check.
  static checkAnyOf(
    schema: JSONSchema,
    rootSchema: JSONSchema | undefined,
    schemaString: string,
  ): boolean {
    return isRecord(schema) && Array.isArray(schema.anyOf) &&
      (schema.anyOf.some((item) => {
        // We might match before resolving the `$ref`
        if (JSON.stringify(item) === schemaString) {
          return true;
        }
        if (item.$ref !== undefined && isObject(rootSchema)) {
          item = ContextualFlowControl.resolveSchemaRef(
            rootSchema,
            item.$ref,
          );
          // We might match after resolving the `$ref`
          return JSON.stringify(item) === schemaString;
        }
        return false;
      }));
  }

  // Despite the name, we will still include any "ifc" properties
  static getStandardSchema(schema: JSONSchema): JSONSchema {
    if (typeof schema === "boolean") {
      return schema;
    }
    const traverse = (
      value: Readonly<any>,
    ): JSONValue => {
      if (isRecord(value)) {
        if (Array.isArray(value)) {
          return value.map((val) => traverse(val));
        } else {
          return Object.fromEntries(
            Object.entries(value).filter(([key, _val]) =>
              key !== "asCell" && key !== "asStream"
            ).map(([key, val]: [PropertyKey, any]) => [
              key.toString(),
              traverse(val),
            ]),
          );
        }
      } else return value;
    };
    return traverse(schema) as JSONSchema;
  }

  static hasRefs(schema: JSONSchema): boolean {
    const traverse = (value: Immutable<any>): boolean => {
      if (isRecord(value)) {
        if (Array.isArray(value)) {
          for (const item of value) {
            if (traverse(item)) {
              return true;
            }
          }
        } else {
          for (const [_k, v] of Object.entries(value)) {
            if (traverse(v)) {
              return true;
            }
          }
        }
      }
      return false;
    };
    return traverse(schema);
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

  // Track the causes of pending nursery changes
  private pendingNurseryChanges = new MapSet<string, string>();

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
     * Storage subscription that needs to be notified when state of the replica
     * changes.
     */
    public subscription: IStorageSubscription,
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
    // Promises for commits that are in flight
    public commitPromises: Set<Consumer.TransactionResult<MemorySpace>> =
      new Set(),
    // Track the selectors used for top level docs -- we only add to this
    // once we've gotten our results (so the promise is resolved).
    private selectorTracker = new SelectorTracker<Result<Unit, Error>>(),
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
      select: { [this.space]: { [COMMIT_LOG_TYPE]: { "_": {} } } },
    });

    const reader = query.subscribe().getReader();
    while (true) {
      const next = await reader.read();
      if (next.done) {
        break;
      }
      this.integrate(next.value.revisions);
    }
  }

  /**
   * Pulls requested entries from the remote source and updates both in memory
   * cache and local store so they will be available for future reads. If
   * entries are not provided it will pull entries that have been loaded from
   * local store in this session.
   */
  async pull(
    entries: [BaseMemoryAddress, SchemaPathSelector?][] = this.queue.consume(),
  ): Promise<
    Result<Unit, PullError>
  > {
    // If requested entry list is empty there is nothing to fetch so we return
    // immediately.
    if (entries.length === 0) {
      return { ok: new Map() };
    }

    // Otherwise we build a query selector to fetch requested entries from the
    // remote.
    // this is the object with the of/the/cause nesting, then a SchemaPathSelector inside
    const schemaSelector = {};
    // We'll assert that we need all the classifications we expect to need.
    // If we don't actually have those, the server will reject our request.
    const classifications = new Set<string>();
    // Patch to have a valid selector for each entry
    const defaultSelector = { path: [], schemaContext: SchemaNone };
    const schemaEntries: [BaseMemoryAddress, SchemaPathSelector][] = entries
      .map((
        [address, schemaPathSelector],
      ) => [address, schemaPathSelector ?? defaultSelector]);
    const promises = [];
    const newEntries: [BaseMemoryAddress, SchemaPathSelector][] = [];
    for (const [address, selector] of schemaEntries) {
      // Even though we have our doc in local store, we may need to re-issue
      // our query, since our cached copy may have been run with a different
      // schema, and thus have different linked documents.
      // The superSelector may also just be an existing copy of our selector
      const [superSelector, superPromise] = this.selectorTracker
        .getSupersetSelector(
          address,
          selector,
          this.cfc,
        );
      if (superSelector !== undefined) {
        // If we already have a subscription that includes this query running
        // on the server, we don't need to send a new one -- however, that
        // may be in progress, so get the Promise
        promises.push(superPromise);
      } else {
        newEntries.push([address, selector]);
      }
    }

    for (const [address, selector] of newEntries) {
      // If we don't have a schema, use SchemaNone, which will only fetch the specified object
      setSelector(schemaSelector, address.id, address.type, "_", selector);
      // Since we're accessing the entire document, we should base our
      // classification on the rootSchema
      const rootSchema = selector.schemaContext?.rootSchema ?? false;
      ContextualFlowControl.joinSchema(
        classifications,
        rootSchema,
        rootSchema,
      );
    }

    // We provided schema for the top level fact that we selected, but we
    // will have undefined schema for the entries included as links.
    const queryArgs: SchemaQueryArgs = {
      selectSchema: schemaSelector,
      subscribe: true,
      excludeSent: true,
    };
    if (Object.entries(schemaSelector).length > 0) {
      if (classifications.size > 0) {
        const lubClassification = this.cfc.lub(classifications);
        queryArgs.classification = [lubClassification];
      }
      // TODO(@ubik2) we're not actually handling the data from this
      // subscription properly. We get the data through the commit changes,
      // because the server knows we're watching, but we should be able
      // to use the data from the subscription instead.
      const query = this.remote.query(queryArgs);
      // What we store in the selector tracker is the promise for when we've
      // not only gotten the server results back, but also integrated them into
      // the nursery/heap and sent out change information.
      const integratedPromise = query.promise.then(async (result) => {
        if (result.error) {
          logger.error(() => ["query failure", queryArgs, result.error]);
          return Promise.resolve({ error: result.error });
        } else {
          const integrated = await this.integrateResults(
            newEntries,
            result.ok.schemaFacts,
          );
          return Promise.resolve({ ok: {} });
        }
      });
      // Track this pending query and promise in the selector tracker
      for (const [address, selector] of newEntries) {
        this.selectorTracker.add(address, selector, integratedPromise);
      }
      // Add this to the front of promises
      promises.unshift(integratedPromise);
    }
    // If all the entries were already loaded we don't need to do anything
    // so we return immediately.
    const results = await Promise.all(promises);

    // Check for errors
    for (const result of results) {
      if ((result as any).error) {
        logger.error(() => ["query failure", queryArgs, (result as any).error]);
        return { error: (result as any).error as PullError };
      }
    }
    return { ok: {} };
  }

  // Integrate the query results triggered by a pull
  private async integrateResults(
    requestedEntries: [BaseMemoryAddress, SchemaPathSelector?][],
    fetchedEntries: [Revision<Fact>, SchemaPathSelector?][],
  ): Promise<Result<Unit, IStoreError>> {
    const revisions = fetchedEntries.map(([revision, _selector]) => revision);
    // resolved is the set of facts we received that were pending
    // current is the set of facts we received that are now live
    const { resolved, current } = this.updateLocalFacts(revisions);

    // We limit changes to the non-stale changes, since we don't have a good
    // way of determining that in the "pull" event handler.
    const changes = Differential.create().update(this, current);
    // Any current facts can be deleted from the nursery
    // (though we probably don't have any)
    this.nursery.merge(current, Nursery.delete);
    // We can put stale facts in the heap, but not in the nursery.
    // We also don't want to update the document map with the stale version.
    this.heap.merge(
      revisions,
      Replica.put,
      (revision) => revision === undefined || !resolved.has(revision),
    );

    // Remote may not have all the requested entries. We denitrify them by
    // looking up which of the facts are not available locally and then create
    // `unclaimed` revisions for those that we store. By doing this we can avoid
    // network round trips if such are pulled again in the future.
    const notFound = [];
    for (const [address, _selector] of requestedEntries) {
      if (!this.get(address)) {
        const unclaimedEntry = unclaimed({ of: address.id, the: address.type });
        // Note we use `-1` as `since` timestamp so that any change will appear greater.
        notFound.push({ ...unclaimedEntry, since: -1 });
      }
    }

    // Add notFound entries to the heap and also persist them in the cache.
    // Don't notify subscribers as if this were a server update.
    this.heap.merge(notFound, Replica.put, (_val) => false);
    // Add entries for the facts we have not found we don't need to compare
    // those as we already know we don't have them in the replica.
    // This method is really an "addAll"
    changes.set(notFound);

    // Notify storage subscription about changes that were pulled from the remote
    this.subscription.next({
      type: "pull",
      space: this.did(),
      changes: changes.close(),
    });

    // Store the revisions we got from the server in the cache
    const result = await this.cache.merge(revisions, Replica.put);

    if (result.error) {
      return result;
    } else {
      return { ok: {} };
    }
  }

  /**
   * Loads requested entries from the local store into a heap unless entries are
   * already loaded. If some of the entries are not available locally they will
   * be fetched from the remote.
   */
  async load(
    entries: [BaseMemoryAddress, SchemaPathSelector?][],
  ): Promise<Result<Unit, PullError>> {
    // First we identify entries that we need to load from the store.
    const need: [BaseMemoryAddress, SchemaPathSelector?][] = [];
    for (const [address, selector] of entries) {
      if (!this.get(address)) {
        need.push([address, selector]);
      } else if (selector !== undefined) {
        // Otherwise, add it to the set of things we need
        need.push([address, selector]);
      }
    }

    // We also include the commit entity to keep track of the current head.
    if (!this.get({ id: this.space, type: COMMIT_LOG_TYPE })) {
      need.unshift([{ id: this.space, type: COMMIT_LOG_TYPE }, undefined]);
    }

    // If all the entries were already loaded we don't need to do anything
    // so we return immediately.
    if (need.length === 0) {
      return { ok: {} };
    }

    // Otherwise we attempt pull needed entries from the local store.
    // We only do this for entries without a schema, since we'll want the server
    // to track our subscription for the entries with a schema.
    const schemaless = need
      .filter(([_addr, selector]) => selector === undefined)
      .map(([addr, _selector]) => {
        return { of: addr.id, the: addr.type };
      });
    const { ok: pulled, error } = await this.cache.pull(schemaless);

    if (error) {
      return { error };
    } else {
      const values = [...pulled.values()];
      // If number of pulled records is less than what we requested we have some
      // some records that we'll need to fetch.
      this.heap.merge(pulled.values(), Replica.put);

      // Notify storage subscribers that we have loaded some data.
      this.subscription.next({
        type: "load",
        space: this.did(),
        changes: Differential.load(values),
      });

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
        const simple = need.filter(([_addr, selector]) =>
          selector === undefined
        );
        // schedule an update for any entries without a schema.
        this.queue.add(simple);
        this.sync();
        return { ok: {} };
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
    // Generate the selectors for the various change objects
    const loadArgs: [BaseMemoryAddress, SchemaPathSelector?][] = changes.map((
      change,
    ) => {
      const schema = generateSchemaFromLabels(change);
      const selector = schema === undefined
        ? undefined
        : { path: [], schemaContext: { schema: schema, rootSchema: schema } };
      return [{ id: change.of, type: change.the }, selector];
    });
    // First we pull all the affected entries into heap so we can build a
    // transaction that is aware of latest state.
    const { error } = await this.load(loadArgs);
    if (error) {
      return { error };
    } else {
      // Collect facts so that we can derive desired state and a corresponding
      // transaction
      const facts: Fact[] = [];
      const claims: Invariant[] = [];
      for (const { the, of, is, claim } of changes) {
        const fact = this.get({ id: of, type: the });

        if (claim) {
          claims.push(claimState(fact!));
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

  async commit(transaction: ITransaction, source?: IStorageTransaction) {
    const { facts, claims } = transaction;
    const changes = Differential.create().update(this, facts);
    // Some facts may be redundant, so only include the changed ones.
    // This will also exclude facts that match the nursery version, but these
    // should have already been sent.
    const changedAddresses = [...changes].map((change) => change.address);
    // Generate pairs of address and facts
    const changedFactEntries = facts.map((
      fact,
    ) => [
      changedAddresses.find((addr) =>
        fact.of === addr.id && fact.the === addr.type
      ),
      fact,
    ]).filter(([addr, _fact]) => addr !== undefined) as [
      BaseMemoryAddress,
      Fact,
    ][];
    // Store facts in a nursery so that subsequent changes will be build
    // optimistically assuming that push will succeed.
    // We only add the changedFacts here, because the facts that are unchanged
    // will have an invalid cause chain (we're not going to write them).
    const changedFacts = changedFactEntries.map(([_addr, fact]) => fact);
    this.nursery.merge(changedFacts, Nursery.put);
    // Notify storage subscribers about the committed changes.
    this.subscription.next({
      type: "commit",
      space: this.did(),
      changes,
      source,
    });
    // Track all our pending changes
    changedFactEntries.map(([address, fact]) =>
      this.pendingNurseryChanges.add(
        toKey(address),
        fact.cause.toString(),
      )
    );

    // These push transaction that will commit desired state to a remote.
    const commitPromise = this.remote.transact({
      changes: getChanges([...claims, ...changedFacts] as Statement[]),
    });
    this.commitPromises.add(commitPromise);
    const result = await commitPromise;
    this.commitPromises.delete(commitPromise);

    // If transaction fails we delete facts from the nursery so that new
    // changes will not build upon rejected state. If there are other inflight
    // transactions that already were built upon our facts they will also fail.
    // It's possible we should also purge claims here, but I'm not doing that.
    if (result.error) {
      for (const [address, fact] of changedFactEntries) {
        this.pendingNurseryChanges.deleteValue(
          toKey(address),
          fact.cause.toString(),
        );
      }
      if (
        result.error.name === "ConflictError" &&
        result.error.conflict.existsInHistory
      ) {
        logger.info(() => ["Transaction failed (aready exists)", result.error]);
      } else {
        logger.warn(() => ["Transaction failed", result.error]);
      }

      // Checkout current state of facts so we can compute
      // changes after we update underlying stores.
      const checkout = Differential.checkout(this, changedFacts);

      // Any returned facts should be purged from the nursery
      this.nursery.merge(changedFacts, Nursery.delete);

      const fact = result.error.name === "ConflictError" &&
        result.error.conflict.actual;
      // We also update heap so it holds latest record
      if (fact) {
        this.heap.merge([fact], Replica.put);
      }

      // Notify storage subscribers about the reverted transaction.
      this.subscription.next({
        type: "revert",
        space: this.did(),
        changes: checkout.compare(this),
        reason: result.error,
        source,
      });
    } //
    // If transaction succeeded we promote facts from nursery into a heap.
    else {
      const commit = toRevision(result.ok);
      const { since } = commit.is;
      // Turn facts into revisions corresponding with the commit.
      const revisions = [
        ...changedFacts.map((fact) => ({ ...fact, since })),
        // We strip transaction info so we don't duplicate same data
        { ...commit, is: { since: commit.is.since } },
      ];
      // We only delete from the nursery when we've seen all of our pending
      // facts (or gotten a fact that did or will conflict).
      // Avoid sending out updates to subscribers if it's a fact we already
      // know about in the nursery.
      const { resolved, current } = this.updateLocalFacts(revisions);

      // Evict redundant facts which we'll merge into `heap` so that reads
      // will occur from `heap`. This way future changes upstream will not get
      // shadowed by prior local changes.
      // I only evict the current facts, but if you never have more than one
      // task in commit, this could be simpler and you could evict all of them.
      this.nursery.merge(current, Nursery.evict);
      // Turn facts into revisions corresponding with the commit.
      this.heap.merge(
        revisions,
        Replica.put,
        (revision) => revision === undefined || !resolved.has(revision),
      );

      // This is mostly redundant, since any current Fact isn't pending, but
      // this also purges Unclaimed items in case the server ever sends them.
      for (const fact of current) {
        const address = { id: fact.of, type: fact.the };
        this.pendingNurseryChanges.delete(toKey(address));
      }
    }

    return result;
  }

  subscribe(
    entry: BaseMemoryAddress,
    subscriber: (value?: Revision<State>) => void,
  ) {
    this.heap.subscribe(entry, subscriber);
  }
  unsubscribe(
    entry: BaseMemoryAddress,
    subscriber: (value?: Revision<State>) => void,
  ) {
    this.heap.unsubscribe(entry, subscriber);
  }

  integrate(revisions: Revision<State>[]) {
    // Store newer revisions into the heap.
    // It's possible to get the same fact (including cause) twice, but we
    // should have the same since on the second, so we can clear them from
    // tracking when we see them.
    const { resolved, current } = this.updateLocalFacts(revisions);

    const checkout = Differential.checkout(this, revisions);

    // Remove "fresh" facts which we are about to merge into `heap`
    this.nursery.merge(current, Nursery.delete);
    // We use put here instead of update, since we may have received new docs
    // that we weren't already tracking.
    this.heap.merge(
      revisions,
      Replica.put,
      (state) => state === undefined || !resolved.has(state),
    );

    this.subscription.next({
      type: "integrate",
      space: this.did(),
      changes: checkout.compare(this),
    });
    return this.cache.merge(revisions, Replica.update);
  }

  /**
   * Returns state corresponding to the requested entry. If there is a pending
   * state returns it otherwise returns recent state.
   */
  get(entry: BaseMemoryAddress): State | undefined {
    const nurseryState = this.nursery.get(entry);
    if (nurseryState) return nurseryState;

    const heapState = this.heap.get(entry);
    if (heapState) {
      // Remove `since` field from the state so that it can be used as a cause
      const { since: _since, ...state } = heapState;
      return state;
    }

    return undefined;
  }

  /**
   * When we push a new fact, we keep track of it in a MapSet.
   * When we receive that fact from the server, either as a result
   * of a commit, or as an entry in a pull response, we no longer
   * need to track it. However, if we receive a stale entry, we need
   * to know that, so that we don't propagate the stale entry.
   *
   * This function removes pending entries when we see them, and
   * returns a set containing the facts we already had sent, but have
   * now resolved, as well as the facts that are now current. When we
   * receive the last pending fact, it's current (and will be in both
   * collections).
   *
   * @param revisions the facts we received from the server
   * @returns an object with the set of pending facts that were resolved and
   *     an array with the facts that are current.
   */
  private updateLocalFacts(revisions: Revision<State>[]) {
    const current: Revision<State>[] = [];
    const resolved = new Set<Revision<State>>();
    for (const revision of revisions) {
      if (revision.cause === undefined) {
        // we couldn't have tracked an Unclaimed as pending
        current.push(revision);
        continue;
      }
      const address = { id: revision.of, type: revision.the };
      const heapVersion = this.heap.get(address);
      const revisionIsNew = heapVersion === undefined ||
        revision.since > heapVersion.since;
      const factKey = toKey(address);
      const changes = this.pendingNurseryChanges.get(factKey);
      const factCause = revision.cause.toString();
      if (changes?.has(factCause)) {
        changes.delete(factCause);
        resolved.add(revision);
        if (revisionIsNew && changes.size === 0) {
          current.push(revision);
        }
      } else if (revisionIsNew) {
        current.push(revision);
      }
    }
    return { resolved, current };
  }

  /**
   * Resets the Replica's internal state for reconnection scenarios.
   * Clears nursery tracking, heap facts, and selector tracking while
   * preserving heap subscribers.
   */
  reset() {
    // Clear nursery tracking
    this.pendingNurseryChanges = new MapSet<string, string>();
    // Clear the nursery itself
    this.nursery = new Nursery();
    // Save subscribers before clearing heap
    const savedSubscribers = new Map(this.heap.subscribers);
    // Clear heap and restore subscribers
    this.heap = new Heap();
    this.heap.subscribers = savedSubscribers;
    // Clear selector tracker to ensure fresh schema queries
    this.selectorTracker = new SelectorTracker();
    // Clear the pull queue
    this.queue = new PullQueue();

    this.subscription.next({
      type: "reset",
      space: this.did(),
    });
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
}

export interface RemoteStorageProviderOptions {
  session: Consumer.MemoryConsumer<MemorySpace>;
  subscription: IStorageSubscription;
  space: MemorySpace;
  the?: string;
  settings?: IRemoteStorageProviderSettings;
}

export const defaultSettings: IRemoteStorageProviderSettings = {
  maxSubscriptionsPerSpace: 50_000,
  connectionTimeout: 30_000,
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
  get replica() {
    return this.provider.replica;
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

    // If we did have connection, schedule reestablishment without blocking
    if (this.connectionCount > 1) {
      // Use queueMicrotask to ensure message pump starts first
      queueMicrotask(() => {
        this.provider.poll();
        this.provider.reestablishSubscriptions().catch((error) => {
          logger.error(() => ["Failed to reestablish subscriptions:", error]);
        });
      });
    }

    while (this.connection === socket) {
      // First drain the queued commands if we have them.
      for (const command of queue) {
        this.post(command);
        queue.delete(command);
      }

      // Then read next command
      const next = await reader.read();
      // if our connection changed while we were waiting on read we bail out
      // and let the reconnection logic pick up.
      if (this.connection !== socket || next.done) {
        break;
      }
      // otherwise we pass the command via web-socket.
      const command = next.value;
      this.post(command);
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
        throw new Error(`Socket is closing`);
      case WebSocket.CLOSED:
        throw new Error(`Socket is closed`);
      default:
        throw new Error(`Socket is in unknown state`);
    }
  }

  sink<T = any>(
    uri: URI,
    callback: (value: StorageValue<T>) => void,
  ) {
    return this.provider.sink(uri, callback);
  }

  sync(uri: URI, selector?: SchemaPathSelector) {
    return this.provider.sync(uri, selector);
  }

  synced() {
    return this.provider.synced();
  }

  get<T = any>(uri: URI): StorageValue<T> | undefined {
    return this.provider.get(uri);
  }
  send<T = any>(
    batch: { uri: URI; value: StorageValue<T> }[],
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
  subscription: IStorageSubscription;

  subscribers: Map<string, Set<(value: StorageValue<JSONValue>) => void>> =
    new Map();
  // Tracks server-side subscriptions so we can re-establish them after reconnection
  // These promises will sometimes be pending, since we also use this to avoid
  // sending a duplicate subscription.
  private serverSubscriptions = new SelectorTracker();

  static open(options: RemoteStorageProviderOptions) {
    return new this(options);
  }

  static connect(options: ConnectionOptions & RemoteStorageProviderOptions) {
    const provider = this.open(options);
    return provider.connect(options);
  }

  constructor({
    session,
    subscription,
    space,
    the = "application/json",
    settings = defaultSettings,
  }: RemoteStorageProviderOptions) {
    this.the = the;
    this.settings = settings;
    this.session = session;
    this.spaces = new Map();
    this.subscription = subscription;
    this.workspace = this.mount(space);
  }

  connect(options: ConnectionOptions) {
    return new ProviderConnection({
      id: options.id,
      provider: this,
      address: options.address,
    });
  }
  get replica() {
    return this.workspace;
  }

  mount(space: MemorySpace): Replica {
    const replica = this.spaces.get(space);
    if (replica) {
      return replica;
    } else {
      const session = this.session.mount(space);
      // FIXME(@ubik2): Disabling the cache while I ensure things work correctly
      const replica = new Replica(
        space,
        session,
        this.subscription,
        new NoCache(),
      );
      replica.poll();
      this.spaces.set(space, replica);
      return replica;
    }
  }

  sink<T = any>(
    uri: URI,
    callback: (value: StorageValue<T>) => void,
  ): Cancel {
    const { the } = this;
    // Capture workspace locally, so that if it changes later, our cancel
    // will unsubscribe with the same object.
    const { workspace } = this;
    const address = { id: uri, type: this.the };
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
    uri: URI,
    selector?: SchemaPathSelector,
  ) {
    const factAddress = { id: uri, type: this.the };
    if (selector) {
      // We track this server subscription, and don't re-issue it --
      // we will instead return the existing promise, so we can wait until
      // we have the response.
      const existingPromise = this.serverSubscriptions.getPromise(
        factAddress,
        selector,
      );
      if (existingPromise) {
        return existingPromise;
      }
      const promise = this.workspace.load([[factAddress, selector]]);
      this.serverSubscriptions.add(factAddress, selector, promise);
      return promise;
    } else {
      return this.workspace.load([[factAddress, undefined]]);
    }
  }

  synced() {
    return Promise.all([
      Promise.all(this.serverSubscriptions.getAllPromises()),
      Promise.all(this.workspace.commitPromises),
    ]) as unknown as Promise<void>;
  }

  get<T = any>(uri: URI): StorageValue<T> | undefined {
    const entity = this.workspace.get({ id: uri, type: this.the });

    return entity?.is as StorageValue<T> | undefined;
  }

  async send<T = any>(
    batch: { uri: URI; value: StorageValue<T> }[],
  ): Promise<
    Result<Unit, PushError>
  > {
    const { the, workspace } = this;
    const LABEL_TYPE = "application/label+json" as const;

    const changes = [];
    for (const { uri, value } of batch) {
      const content = value.value !== undefined
        ? JSON.stringify({ value: value.value, source: value.source })
        : undefined;

      const current = workspace.get({ id: uri, type: this.the });
      if (JSON.stringify(current?.is) !== content) {
        if (content !== undefined) {
          // ⚠️ We do JSON roundtrips to strip off the undefined values that
          // cause problems with serialization.
          changes.push({ of: uri, the, is: JSON.parse(content) as JSONValue });
        } else {
          changes.push({ of: uri, the });
        }
      }
      if (value.labels !== undefined) {
        const currentLabel = workspace.get({ id: uri, type: LABEL_TYPE });
        if (!deepEqual(currentLabel?.is, value.labels)) {
          if (value.labels !== undefined) {
            changes.push({
              of: uri,
              the: LABEL_TYPE,
              is: value.labels as JSONValue,
            });
          } else {
            changes.push({ of: uri, the: LABEL_TYPE });
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

    // Try to clear pending invocations from the consumer session
    try {
      const consumerSession = (this.workspace.remote as any).session;
      if (consumerSession?.invocations) {
        consumerSession.invocations.clear();
      }
    } catch (error) {
      // Ignore error
    }

    // Reset the existing Replica to clear its state
    this.workspace.reset();

    // Re-establish subscriptions
    const need: [BaseMemoryAddress, SchemaPathSelector?][] = [];

    // Always include the space commit object to ensure proper query context
    const spaceCommitAddress: BaseMemoryAddress = {
      type: COMMIT_LOG_TYPE,
      id: this.workspace.space,
    };
    need.push([spaceCommitAddress, undefined]);

    // Add all tracked subscriptions
    for (const { address: factAddress, selector } of subscriptions) {
      need.push([factAddress, selector]);
    }

    try {
      await this.workspace.pull(need);
    } catch (error) {
      logger.error(() => ["Failed to re-establish subscriptions:", error]);
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

export class StorageManager implements IStorageManager {
  address: URL;
  as: Signer;
  id: string;
  settings: IRemoteStorageProviderSettings;
  #providers: Map<string, IStorageProviderWithReplica> = new Map();
  #subscription = SubscriptionManager.create();

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

  protected connect(space: MemorySpace): IStorageProviderWithReplica {
    const { id, address, as, settings } = this;
    return Provider.connect({
      id,
      space,
      address,
      settings,
      subscription: this.#subscription,
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
    return Transaction.create(this);
  }

  /**
   * Subscribes to changes in the storage.
   */
  subscribe(subscription: IStorageSubscription): void {
    this.#subscription.subscribe(subscription);
  }

  /**
   * Wait for all pending syncs to complete + the microtask queue to flush, so
   * that they are also all processed.
   *
   * @returns Promise that resolves when all pending syncs are complete.
   */
  synced(): Promise<void> {
    const { resolve, promise } = Promise.withResolvers<void>();
    Promise.all(
      this.#providers.values().map((provider) => provider.synced()),
    ).finally(() => setTimeout(() => resolve(), 0));
    return promise;
  }

  async syncCell<T>(
    cell: Cell<T>,
  ): Promise<Cell<T>> {
    const { space, id, schema, rootSchema } = cell.getAsNormalizedFullLink();
    if (!space) throw new Error("No space set");
    const storageProvider = this.open(space);

    const schemaContext = schema === undefined
      ? { schema: false, rootSchema: false }
      : { schema, rootSchema: rootSchema ?? schema };

    const selector = schemaContext === undefined ? undefined : {
      path: cell.path.map((p) => p.toString()),
      schemaContext,
    };

    await storageProvider.sync(id, selector);
    return cell;
  }
}

/**
 * Converts a set of statements into the hierarchical structure used in some
 * parts of the code, like network protocol.
 *
 * @param statements statements to be converted
 * @returns a MemoryChange object that contains the changes
 */
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
const generateSchemaFromLabels = (
  change: Assert | Retract | Claim,
): JSONSchema | undefined => {
  if (isObject(change?.is) && "labels" in change.is) {
    return { ifc: change.is.labels } as JSONSchema;
  }
  return undefined;
};
