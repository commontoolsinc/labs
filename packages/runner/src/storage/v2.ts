import { hashSchema } from "@commontools/data-model/schema-hash";
import {
  type ConflictError as IConflictError,
  type ConnectionError as IConnectionError,
  type MemorySpace,
  type MIME,
  type SchemaPathSelector,
  type Signer,
  type StorableDatum,
  type TransactionError,
  type URI,
} from "@commontools/memory/interface";
import { hashOf } from "@commontools/data-model/value-hash";
import { assert, unclaimed } from "@commontools/memory/fact";
import * as MemoryV2Client from "@commontools/memory/v2/client";
import {
  type DocumentPath,
  type EntityDocument,
  MEMORY_V2_PROTOCOL,
  type PatchOp,
  type SessionSync,
  toDocumentPath,
} from "@commontools/memory/v2";
import type { AppliedCommit } from "@commontools/memory/v2/engine";
import { getLogger } from "@commontools/utils/logger";
import { isObject, isRecord } from "@commontools/utils/types";
import type { Cell } from "../cell.ts";
import type { JSONSchema } from "../builder/types.ts";
import { ContextualFlowControl } from "../cfc.ts";
import { sortAndCompactPaths } from "../reactive-dependencies.ts";
import { stableHash } from "../traverse.ts";
import { getJSONFromDataURI } from "../uri-utils.ts";
import {
  isPrimitiveCellLink,
  type NormalizedLink,
  parseLinkPrimitive,
} from "../link-types.ts";
import type { Cancel } from "../cancel.ts";
import * as Differential from "./differential.ts";
import type {
  IMemoryAddress,
  IMergedChanges,
  IRemoteStorageProviderSettings,
  ISpaceReplica,
  IStorageManager,
  IStorageNotification,
  IStorageProviderWithReplica,
  IStorageSubscription,
  IStorageTransaction,
  MemoryVersion,
  NativeStorageCommit,
  PullError,
  PushError,
  Result,
  State,
  StorageNotification,
  StorageTransactionRejected,
  Unit,
} from "./interface.ts";
import { SelectorTracker } from "./cache.ts";
import * as SubscriptionManager from "./subscription.ts";
import { getDirectTransactionReadActivities } from "./transaction-inspection.ts";
import { toTransactionDocumentValue } from "./v2-document.ts";
import * as V2Transaction from "./v2-transaction.ts";

const logger = getLogger("storage.v2", {
  enabled: true,
  level: "error",
});

const DATA_URI_SYNC_CACHE_MAX = 10_000;
const dataURISyncCache = new Map<string, Promise<Cell<any>>>();
const DOCUMENT_MIME = "application/json" as const;
const UNCACHED_TRANSACTION_VALUE = Symbol("uncachedTransactionValue");

const toExplicitDocument = (value: StorableDatum): EntityDocument => {
  if (!isObject(value)) {
    throw new Error(
      "memory v2 transactions require explicit full-document roots",
    );
  }
  return value as EntityDocument;
};

type CachedTransactionValue =
  | StorableDatum
  | typeof UNCACHED_TRANSACTION_VALUE
  | undefined;

type PendingVersion = {
  localSeq: number;
  value: EntityDocument | undefined;
  transactionValue: CachedTransactionValue;
};

type ConfirmedVersion = {
  seq: number;
  value: EntityDocument | undefined;
  transactionValue: CachedTransactionValue;
};

type DocumentRecord = {
  confirmed: ConfirmedVersion;
  pending: PendingVersion[];
};

type ConfirmedCommitRead = {
  id: URI;
  path: DocumentPath;
  seq: number;
  nonRecursive?: boolean;
};

type PendingCommitRead = {
  id: URI;
  path: DocumentPath;
  localSeq: number;
  nonRecursive?: boolean;
};

const pendingVersion = (
  localSeq: number,
  value: EntityDocument | undefined,
): PendingVersion => ({
  localSeq,
  value,
  transactionValue: UNCACHED_TRANSACTION_VALUE,
});

const confirmedVersion = (
  seq: number,
  value: EntityDocument | undefined,
): ConfirmedVersion => ({
  seq,
  value,
  transactionValue: UNCACHED_TRANSACTION_VALUE,
});

const transactionValueForVersion = (
  version: PendingVersion | ConfirmedVersion,
): StorableDatum | undefined => {
  if (version.transactionValue === UNCACHED_TRANSACTION_VALUE) {
    version.transactionValue = toTransactionDocumentValue(version.value);
  }
  return version.transactionValue;
};

export interface Options {
  as: Signer;
  address: URL;
  id?: string;
  settings?: IRemoteStorageProviderSettings;
  memoryVersion?: MemoryVersion;
  spaceIdentity?: Signer;
}

export const defaultSettings: IRemoteStorageProviderSettings = {
  maxSubscriptionsPerSpace: 50_000,
  connectionTimeout: 30_000,
};

export interface SessionFactory {
  create(space: MemorySpace, signer?: Signer): Promise<{
    client: MemoryV2Client.Client;
    session: MemoryV2Client.SpaceSession;
  }>;
}

const comparePath = (left: readonly string[], right: readonly string[]) => {
  if (left.length !== right.length) {
    return left.length - right.length;
  }
  const limit = Math.min(left.length, right.length);
  for (let index = 0; index < limit; index++) {
    const compared = left[index].localeCompare(right[index]);
    if (compared !== 0) {
      return compared;
    }
  }
  return 0;
};

const compactCommitReads = <
  Read extends ConfirmedCommitRead | PendingCommitRead,
>(
  space: MemorySpace,
  reads: Read[],
): Read[] => {
  const sorted = [...reads].sort((left, right) => {
    const idCompared = left.id.localeCompare(right.id);
    if (idCompared !== 0) {
      return idCompared;
    }

    if ("seq" in left && "seq" in right && left.seq !== right.seq) {
      return left.seq - right.seq;
    }

    if (
      "localSeq" in left && "localSeq" in right &&
      left.localSeq !== right.localSeq
    ) {
      return left.localSeq - right.localSeq;
    }

    if (left.nonRecursive !== right.nonRecursive) {
      return left.nonRecursive === true ? 1 : -1;
    }

    return comparePath(left.path, right.path);
  });

  const grouped = new Map<string, {
    recursiveByPath: Map<string, Read>;
    nonRecursiveByPath: Map<string, Read>;
  }>();
  for (const candidate of sorted) {
    const dependencyKey = "seq" in candidate
      ? `confirmed:${candidate.id}:${candidate.seq}`
      : `pending:${candidate.id}:${candidate.localSeq}`;
    let group = grouped.get(dependencyKey);
    if (!group) {
      group = {
        recursiveByPath: new Map(),
        nonRecursiveByPath: new Map(),
      };
      grouped.set(dependencyKey, group);
    }
    const pathKey = candidate.path.join("\0");
    if (candidate.nonRecursive === true) {
      if (group.recursiveByPath.has(pathKey)) {
        continue;
      }
      group.nonRecursiveByPath.set(pathKey, candidate);
    } else {
      group.nonRecursiveByPath.delete(pathKey);
      group.recursiveByPath.set(pathKey, candidate);
    }
  }

  const compacted: Read[] = [];
  for (const group of grouped.values()) {
    const compactedRecursive = sortAndCompactPaths(
      [...group.recursiveByPath.values()].map((read) => ({
        space,
        id: read.id,
        type: DOCUMENT_MIME,
        path: read.path,
      })),
    );
    for (const address of compactedRecursive) {
      const read = group.recursiveByPath.get(address.path.join("\0"));
      if (read) {
        compacted.push(read);
      }
    }
    compacted.push(...group.nonRecursiveByPath.values());
  }

  return compacted.toSorted((left, right) => {
    const idCompared = left.id.localeCompare(right.id);
    if (idCompared !== 0) {
      return idCompared;
    }

    if ("seq" in left && "seq" in right && left.seq !== right.seq) {
      return left.seq - right.seq;
    }

    if (
      "localSeq" in left && "localSeq" in right &&
      left.localSeq !== right.localSeq
    ) {
      return left.localSeq - right.localSeq;
    }

    if (left.nonRecursive !== right.nonRecursive) {
      return left.nonRecursive === true ? -1 : 1;
    }

    return comparePath(left.path, right.path);
  });
};

const toCommitReadPath = (
  path: readonly (string | number)[],
): DocumentPath => toDocumentPath(path.map(String));

class WebSocketTransport implements MemoryV2Client.Transport {
  #receiver: (payload: string) => void = () => {};
  #closeReceiver: (error?: Error) => void = () => {};
  #socket: WebSocket | null = null;
  #opening: Promise<WebSocket> | null = null;

  constructor(private readonly address: URL) {}

  setReceiver(receiver: (payload: string) => void): void {
    this.#receiver = receiver;
  }

  setCloseReceiver(receiver: (error?: Error) => void): void {
    this.#closeReceiver = receiver;
  }

  async send(payload: string): Promise<void> {
    const socket = await this.open();
    socket.send(payload);
  }

  async close(): Promise<void> {
    const socket = this.#socket;
    this.#socket = null;
    this.#opening = null;
    if (!socket || socket.readyState === WebSocket.CLOSED) {
      return;
    }
    socket.close();
    await new Promise<void>((resolve) => {
      socket.addEventListener("close", () => resolve(), { once: true });
      socket.addEventListener("error", () => resolve(), { once: true });
    });
  }

  private async open(): Promise<WebSocket> {
    if (this.#socket?.readyState === WebSocket.OPEN) {
      return this.#socket;
    }
    if (this.#opening) {
      return await this.#opening;
    }
    const address = new URL(this.address);
    address.protocol = address.protocol === "https:" ? "wss:" : "ws:";
    this.#opening = new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(address);
      socket.addEventListener("open", () => {
        this.#socket = socket;
        resolve(socket);
      }, { once: true });
      socket.addEventListener("message", (event) => {
        if (typeof event.data === "string") {
          this.#receiver(event.data);
        }
      });
      socket.addEventListener("close", () => {
        this.#socket = null;
        this.#opening = null;
        this.#closeReceiver();
      });
      socket.addEventListener("error", (event) => {
        this.#socket = null;
        this.#opening = null;
        this.#closeReceiver(
          event instanceof ErrorEvent && event.error instanceof Error
            ? event.error
            : new Error("memory/v2 websocket transport error"),
        );
        reject(event);
      }, { once: true });
    });
    return await this.#opening;
  }
}

class RemoteSessionFactory implements SessionFactory {
  constructor(
    private readonly address: URL,
    private readonly defaultSigner: Signer,
  ) {}

  async #createSessionOpenAuth(
    signer: Signer,
    space: MemorySpace,
    session: MemoryV2Client.MountOptions,
  ): Promise<MemoryV2Client.SessionOpenAuth> {
    const invocation = {
      iss: signer.did(),
      cmd: "session.open",
      sub: space,
      args: {
        protocol: MEMORY_V2_PROTOCOL,
        session,
      },
    };
    const signature = await signer.sign(hashOf(invocation).bytes);
    if (signature.error) {
      throw signature.error;
    }
    return {
      invocation,
      authorization: {
        signature: signature.ok,
      },
    };
  }

  async create(space: MemorySpace, signer = this.defaultSigner) {
    const client = await MemoryV2Client.connect({
      transport: new WebSocketTransport(this.address),
    });
    const session = await client.mount(
      space,
      {},
      (targetSpace, descriptor) =>
        this.#createSessionOpenAuth(
          signer,
          targetSpace as MemorySpace,
          descriptor,
        ),
    );
    return { client, session };
  }
}

export class StorageManager implements IStorageManager {
  readonly memoryVersion: MemoryVersion = "v2";
  readonly id: string;
  readonly as: Signer;

  #settings: IRemoteStorageProviderSettings;
  #providers = new Map<MemorySpace, Provider>();
  #subscription = SubscriptionManager.create();
  #crossSpacePromises = new Set<Promise<void>>();
  #sessionFactory: SessionFactory;
  #spaceIdentity?: Signer;

  static open(options: Options) {
    return new this(
      options,
      new RemoteSessionFactory(options.address, options.as),
    );
  }

  protected constructor(
    options: Options,
    sessionFactory: SessionFactory,
  ) {
    this.id = options.id ?? crypto.randomUUID();
    this.as = options.as;
    this.#settings = options.settings ?? defaultSettings;
    this.#sessionFactory = sessionFactory;
    this.#spaceIdentity = options.spaceIdentity;
  }

  open(space: MemorySpace): IStorageProviderWithReplica {
    let provider = this.#providers.get(space);
    if (!provider) {
      const signer = this.#spaceIdentity?.did() === space
        ? this.#spaceIdentity
        : this.as;
      provider = new Provider({
        as: signer,
        space,
        settings: this.#settings,
        subscription: this.#subscription,
        createSession: () => this.#sessionFactory.create(space, signer),
      });
      this.#providers.set(space, provider);
    }
    return provider;
  }

  async close(): Promise<void> {
    if (this.#providers.size === 0) {
      return;
    }
    await this.synced();
    await Promise.all(
      [...this.#providers.values()].map((provider) => provider.destroy()),
    );
    this.#providers.clear();
  }

  edit(): IStorageTransaction {
    return V2Transaction.V2StorageTransaction.create(this);
  }

  synced(): Promise<void> {
    const { resolve, promise } = Promise.withResolvers<void>();
    Promise.all(
      [...this.#providers.values()].map((provider) => provider.synced()),
    ).finally(() => this.resolveCrossSpace(resolve));
    return promise;
  }

  addCrossSpacePromise(promise: Promise<void>): void {
    this.#crossSpacePromises.add(promise);
  }

  removeCrossSpacePromise(promise: Promise<void>): void {
    this.#crossSpacePromises.delete(promise);
  }

  subscribe(subscription: IStorageNotification): void {
    this.#subscription.subscribe(subscription);
  }

  unsubscribe(subscription: IStorageNotification): void {
    this.#subscription.unsubscribe(subscription);
  }

  async syncCell<T>(cell: Cell<T>): Promise<Cell<T>> {
    const { space, id, schema } = cell.getAsNormalizedFullLink();
    if (!space) {
      throw new Error("No space set");
    }

    if (id.startsWith("data:")) {
      return this.syncDataURICell(cell, space, id, schema);
    }

    await this.open(space).sync(id, {
      path: cell.path.map((segment) => segment.toString()),
      schema: schema ?? false,
    });
    return cell;
  }

  private resolveCrossSpace(resolve: () => void): Promise<void> {
    const promises = [...this.#crossSpacePromises.values()];
    if (promises.length === 0) {
      queueMicrotask(() => {
        if (this.#crossSpacePromises.size === 0) {
          resolve();
          return;
        }
        void this.resolveCrossSpace(resolve);
      });
      return Promise.resolve();
    }
    return Promise.all(promises)
      .then(() => undefined)
      .finally(() => this.resolveCrossSpace(resolve));
  }

  private syncDataURICell<T>(
    cell: Cell<T>,
    space: MemorySpace,
    id: string,
    schema: JSONSchema | undefined,
  ): Promise<Cell<T>> {
    const pathStr = JSON.stringify(cell.path);
    const schemaStr = schema ? stableHash(schema) : "";
    const cacheKey = `${id}|${schemaStr}|${pathStr}|${space}`;
    const existing = dataURISyncCache.get(cacheKey);
    if (existing) {
      return existing as Promise<Cell<T>>;
    }
    const promise = this.syncDataURICellUncached(cell, space, id, schema);
    if (dataURISyncCache.size >= DATA_URI_SYNC_CACHE_MAX) {
      dataURISyncCache.clear();
    }
    dataURISyncCache.set(cacheKey, promise);
    return promise;
  }

  private async syncDataURICellUncached<T>(
    cell: Cell<T>,
    space: MemorySpace,
    id: string,
    schema: JSONSchema | undefined,
  ): Promise<Cell<T>> {
    const json = getJSONFromDataURI(id);
    if (!isRecord(json)) {
      return cell;
    }
    let value = json["value"];
    for (const segment of [...cell.path.map(String)]) {
      if (!isRecord(value) && !Array.isArray(value)) {
        return cell;
      }
      value = (value as Record<string, unknown>)[segment];
    }

    const base: NormalizedLink = {
      space,
      id: id as any,
      path: [],
      type: DOCUMENT_MIME,
    };
    const promises: Promise<unknown>[] = [];
    this.collectLinkedCellSyncs(
      value,
      base,
      schema,
      new ContextualFlowControl(),
      promises,
      new Set(),
    );
    if (promises.length > 0) {
      await Promise.all(promises);
    }
    return cell;
  }

  private collectLinkedCellSyncs(
    value: unknown,
    base: NormalizedLink,
    schema: JSONSchema | undefined,
    cfc: ContextualFlowControl,
    promises: Promise<unknown>[],
    seen: Set<unknown>,
  ): void {
    if (value === null || value === undefined || seen.has(value)) {
      return;
    }
    if (typeof value !== "object") {
      return;
    }
    seen.add(value);

    if (isPrimitiveCellLink(value)) {
      const link = parseLinkPrimitive(value, base);
      if (link.id && !link.id.startsWith("data:")) {
        promises.push(
          this.open(link.space ?? base.space!).sync(link.id, {
            path: link.path.map((segment) => segment.toString()),
            schema: link.schema ?? schema ?? false,
          }),
        );
      }
      return;
    }

    if (Array.isArray(value)) {
      const schemaObj = isRecord(schema)
        ? schema as { items?: JSONSchema }
        : undefined;
      const itemSchema = schemaObj?.items
        ? schemaObj.items as JSONSchema
        : undefined;
      for (const item of value) {
        this.collectLinkedCellSyncs(
          item,
          base,
          itemSchema,
          cfc,
          promises,
          seen,
        );
      }
      return;
    }

    if (isRecord(value)) {
      for (const key of Object.keys(value)) {
        const child = value[key];
        if (
          child === null || child === undefined || typeof child !== "object"
        ) {
          continue;
        }
        const childSchema = schema
          ? cfc.getSchemaAtPath(schema, [key])
          : undefined;
        this.collectLinkedCellSyncs(
          child,
          base,
          childSchema,
          cfc,
          promises,
          seen,
        );
      }
    }
  }
}

type ProviderOptions = {
  as: Signer;
  space: MemorySpace;
  settings: IRemoteStorageProviderSettings;
  subscription: IStorageSubscription;
  createSession: () => Promise<{
    client: MemoryV2Client.Client;
    session: MemoryV2Client.SpaceSession;
  }>;
};

class Provider implements IStorageProviderWithReplica {
  readonly replica: SpaceReplica;
  #destroyed = false;

  constructor(
    readonly options: ProviderOptions,
  ) {
    this.replica = new SpaceReplica(options);
  }

  send(
    batch: { uri: URI; value: EntityDocument | undefined }[],
  ): Promise<Result<Unit, Error>> {
    return this.replica.send(batch.map(({ uri, value }) => ({
      uri,
      document: value,
    }))) as Promise<Result<Unit, Error>>;
  }

  sync(uri: URI, selector?: SchemaPathSelector): Promise<Result<Unit, Error>> {
    return this.replica.sync(uri, selector) as Promise<Result<Unit, Error>>;
  }

  synced(): Promise<void> {
    return this.replica.synced();
  }

  get(uri: URI): EntityDocument | undefined {
    return this.replica.getDocument(uri);
  }

  sink(
    uri: URI,
    callback: (value: EntityDocument | undefined) => void,
  ): Cancel {
    return this.replica.sinkDocument(uri, callback);
  }

  async destroy(): Promise<void> {
    if (this.#destroyed) {
      return;
    }
    this.#destroyed = true;
    await this.replica.synced();
    await this.replica.close();
  }

  getReplica(): string | undefined {
    return this.options.space;
  }
}

type SyncTask = {
  entries: [{ id: URI; type: MIME }, SchemaPathSelector][];
  promise: Promise<Result<Unit, PullError>>;
};

type WatchRefreshBatch = {
  type: "pull" | "integrate";
  pending: PromiseWithResolvers<Result<Unit, PullError>>;
};

const normalizeSyncSelector = (
  selector: SchemaPathSelector | undefined,
): SchemaPathSelector => {
  if (selector !== undefined && selector.schema !== false) {
    return selector;
  }
  return { path: [], schema: false };
};

const normalizeSyncEntries = (
  entries: [{ id: URI; type: MIME }, SchemaPathSelector | undefined][],
): [{ id: URI; type: MIME }, SchemaPathSelector][] =>
  entries.map((
    [address, selector],
  ) => [address, normalizeSyncSelector(selector)]);

const compactWatchEntries = (
  entries: [{ id: URI; type: MIME }, SchemaPathSelector][],
): [{ id: URI; type: MIME }, SchemaPathSelector][] => {
  const tracker = new SelectorTracker<Result<Unit, PullError>>();
  const cfc = new ContextualFlowControl();
  const compacted: [{ id: URI; type: MIME }, SchemaPathSelector][] = [];

  for (const entry of entries) {
    const [address, selector] = entry;
    const baseAddress = { id: address.id, type: address.type, path: [] };
    const [superset] = tracker.getSupersetSelector(
      baseAddress,
      selector,
      cfc,
    );
    if (superset !== undefined) {
      continue;
    }
    tracker.add(
      baseAddress,
      selector,
      Promise.resolve({ ok: {} } as Result<Unit, PullError>),
    );
    compacted.push(entry);
  }

  return compacted;
};

const selectorIdentity = (selector: SchemaPathSelector): string =>
  stableHash({
    path: selector.path,
    schemaHash: selector.schema === undefined
      ? ""
      : hashSchema(selector.schema).toString(),
  });

export const watchIdForEntry = (
  address: { id: URI; type: MIME },
  selector: SchemaPathSelector,
  branch = "",
): string =>
  `replica:${
    stableHash({
      branch,
      id: address.id,
      type: address.type,
      selector: selectorIdentity(selector),
    })
  }`;

class SpaceReplica implements ISpaceReplica {
  readonly #space: MemorySpace;
  readonly #subscription: IStorageSubscription;
  readonly #createSession: () => Promise<{
    client: MemoryV2Client.Client;
    session: MemoryV2Client.SpaceSession;
  }>;
  #sessionHandle?: Promise<{
    client: MemoryV2Client.Client;
    session: MemoryV2Client.SpaceSession;
  }>;
  readonly #docs = new Map<URI, DocumentRecord>();
  readonly #syncTasks = new Map<string, SyncTask>();
  readonly #commitPromises = new Set<
    Promise<Result<Unit, StorageTransactionRejected>>
  >();
  readonly #syncPromises = new Set<Promise<Result<Unit, PullError>>>();
  readonly #updatePromises = new Set<Promise<void>>();
  readonly #sinks = new Map<
    URI,
    Set<(document: EntityDocument | undefined) => void>
  >();
  #watchView: MemoryV2Client.WatchView | null = null;
  #watchSelectorTracker = new SelectorTracker<Result<Unit, PullError>>();
  #watchedIds = new Set<URI>();
  #nextLocalSeq = 1;
  #queuedWatchRefresh: WatchRefreshBatch | null = null;
  #queuedWatchRefreshScheduled = false;

  constructor(options: ProviderOptions) {
    this.#space = options.space;
    this.#subscription = options.subscription;
    this.#createSession = options.createSession;
  }

  did(): MemorySpace {
    return this.#space;
  }

  get(entry: IMemoryAddress): State | undefined {
    return this.getState(entry.id as URI);
  }

  async sync(
    uri: URI,
    selector?: SchemaPathSelector,
  ): Promise<Result<Unit, PullError>> {
    return await this.pull([[
      { id: uri, type: DOCUMENT_MIME as MIME },
      selector,
    ]]);
  }

  sinkDocument(
    uri: URI,
    callback: (document: EntityDocument | undefined) => void,
  ): Cancel {
    let subscribers = this.#sinks.get(uri);
    if (!subscribers) {
      subscribers = new Set();
      this.#sinks.set(uri, subscribers);
    }
    subscribers.add(callback);
    void this.sync(uri);
    return () => {
      const current = this.#sinks.get(uri);
      current?.delete(callback);
      if (current && current.size === 0) {
        this.#sinks.delete(uri);
      }
    };
  }

  async send(
    batch: { uri: URI; document: EntityDocument | undefined }[],
  ): Promise<Result<Unit, PushError>> {
    const operations = batch.map(({ uri, document }) =>
      document === undefined ? { op: "delete" as const, id: uri } : {
        op: "set" as const,
        id: uri,
        value: document,
      }
    );
    return await this.commitOperations(operations, undefined);
  }

  async synced(): Promise<void> {
    await Promise.all([...this.#syncPromises, ...this.#commitPromises]);
  }

  getDocument(uri: URI): EntityDocument | undefined {
    return this.visibleDocument(uri);
  }

  async close(): Promise<void> {
    await this.synced();
    this.cancelQueuedWatchRefresh();
    this.#watchView?.close();
    this.#watchView = null;
    const sessionHandle = this.#sessionHandle;
    this.#sessionHandle = undefined;
    if (sessionHandle) {
      let resolved:
        | {
          client: MemoryV2Client.Client;
          session: MemoryV2Client.SpaceSession;
        }
        | undefined;
      try {
        resolved = await sessionHandle;
      } catch {
        resolved = undefined;
      }
      if (resolved !== undefined) {
        await resolved.client.close();
      }
    }
    await Promise.allSettled([...this.#updatePromises]);
    this.#syncTasks.clear();
    this.#watchSelectorTracker = new SelectorTracker<Result<Unit, PullError>>();
  }

  async load(
    entries: [{ id: URI; type: MIME }, SchemaPathSelector | undefined][],
  ): Promise<Result<Unit, PullError>> {
    const known = entries
      .map(([address]) => this.getState(address.id))
      .filter((state): state is State => state !== undefined);
    this.#subscription.next({
      type: "load",
      space: this.#space,
      changes: Differential.load(known),
    });
    return await this.pull(entries);
  }

  async pull(
    entries: [{ id: URI; type: MIME }, SchemaPathSelector | undefined][],
  ): Promise<Result<Unit, PullError>> {
    if (entries.length === 0) {
      return { ok: {} };
    }

    const normalizedEntries = normalizeSyncEntries(entries);
    const key = stableHash(normalizedEntries.map(([address, selector]) => ({
      id: address.id,
      selector,
    })));
    const existing = this.#syncTasks.get(key);
    if (existing) {
      return await existing.promise;
    }

    const task: SyncTask = {
      entries: normalizedEntries,
      promise: Promise.resolve({ ok: {} } as Result<Unit, PullError>),
    };
    const cfc = new ContextualFlowControl();
    const newEntries = normalizedEntries.filter(([address, selector]) => {
      const [superset] = this.#watchSelectorTracker.getSupersetSelector(
        { id: address.id, type: address.type },
        selector,
        cfc,
      );
      return superset === undefined;
    });
    if (newEntries.length === 0) {
      return { ok: {} };
    }
    task.entries = newEntries;
    this.#syncTasks.set(key, task);
    const promise = this.enqueueWatchRefresh("pull");
    task.promise = promise;
    for (const [address, selector] of newEntries) {
      this.#watchSelectorTracker.add(
        { id: address.id, type: address.type },
        selector,
        promise,
      );
    }
    this.#syncPromises.add(promise);
    try {
      return await promise;
    } finally {
      this.#syncTasks.delete(key);
      this.#syncPromises.delete(promise);
      const result = await Promise.resolve(task.promise);
      if (result.error) {
        for (const [address, selector] of newEntries) {
          this.#watchSelectorTracker.delete(
            { id: address.id, type: address.type },
            selector,
          );
        }
      }
    }
  }

  async commitNative(
    transaction: NativeStorageCommit,
    source?: IStorageTransaction,
  ): Promise<Result<Unit, StorageTransactionRejected>> {
    const operations = transaction.operations
      .filter((operation) => operation.type === DOCUMENT_MIME)
      .map((operation) =>
        operation.op === "delete"
          ? { op: "delete" as const, id: operation.id }
          : operation.op === "patch"
          ? {
            op: "patch" as const,
            id: operation.id,
            patches: operation.patches,
            value: toExplicitDocument(operation.value),
          }
          : {
            op: "set" as const,
            id: operation.id,
            value: toExplicitDocument(operation.value),
          }
      );

    if (operations.length === 0) {
      return { ok: {} };
    }

    return await this.commitOperations(operations, source);
  }

  reset(): void {
    this.#docs.clear();
    this.#watchedIds.clear();
    this.cancelQueuedWatchRefresh();
    this.#watchSelectorTracker = new SelectorTracker<Result<Unit, PullError>>();
    this.#subscription.next({
      type: "reset",
      space: this.#space,
    });
  }

  private async refreshWatchSet(
    type: "pull" | "integrate" = "pull",
  ): Promise<Result<Unit, PullError>> {
    try {
      const { session } = await this.sessionHandle();
      const pendingEntries = new Map<
        string,
        [{ id: URI; type: MIME }, SchemaPathSelector]
      >();
      for (const task of this.#syncTasks.values()) {
        for (const entry of task.entries) {
          const [address, selector] = entry;
          pendingEntries.set(watchIdForEntry(address, selector, ""), entry);
        }
      }
      const rawEntries = [...pendingEntries.values()];
      const watchEntries = compactWatchEntries(rawEntries);
      if (watchEntries.length === 0) {
        return { ok: {} };
      }

      const watches = watchEntries.map(([address, selector]) => ({
        id: watchIdForEntry(address, selector, ""),
        kind: "graph" as const,
        query: {
          roots: [{
            id: address.id,
            selector,
          }],
        },
      }));

      const { view, sync } = await session.watchAddSync(watches);

      this.#watchView = view;
      this.applySessionSync(sync, type);
      if (this.#updatePromises.size === 0) {
        const updates = this.consumeUpdates(view.subscribeSync())
          .finally(() => this.#updatePromises.delete(updates));
        this.#updatePromises.add(updates);
      }
      return { ok: {} };
    } catch (error) {
      return { error: toConnectionError(error) };
    }
  }

  private enqueueWatchRefresh(
    type: "pull" | "integrate",
  ): Promise<Result<Unit, PullError>> {
    if (this.#queuedWatchRefresh !== null) {
      return this.#queuedWatchRefresh.pending.promise;
    }

    const batch: WatchRefreshBatch = {
      type,
      pending: Promise.withResolvers<Result<Unit, PullError>>(),
    };
    this.#queuedWatchRefresh = batch;
    this.#queuedWatchRefreshScheduled = true;
    queueMicrotask(() => {
      this.#queuedWatchRefreshScheduled = false;
      if (this.#queuedWatchRefresh !== batch) {
        return;
      }
      this.#queuedWatchRefresh = null;
      void this.flushWatchRefreshBatch(batch);
    });
    return batch.pending.promise;
  }

  private async flushWatchRefreshBatch(
    batch: WatchRefreshBatch,
  ): Promise<void> {
    try {
      batch.pending.resolve(await this.refreshWatchSet(batch.type));
    } catch (error) {
      batch.pending.resolve({ error: toConnectionError(error) });
    }
  }

  private cancelQueuedWatchRefresh(): void {
    this.#queuedWatchRefreshScheduled = false;
    if (this.#queuedWatchRefresh !== null) {
      this.#queuedWatchRefresh.pending.resolve({
        error: toConnectionError(new Error("memory/v2 replica closed")),
      });
      this.#queuedWatchRefresh = null;
    }
  }

  private async consumeUpdates(
    iterator: AsyncIterator<SessionSync>,
  ): Promise<void> {
    while (true) {
      const next = await iterator.next();
      if (next.done) {
        return;
      }
      this.applySessionSync(next.value, "integrate");
    }
  }

  private async commitOperations(
    operations: Array<
      | { op: "set"; id: URI; value: EntityDocument }
      | { op: "patch"; id: URI; patches: PatchOp[]; value: EntityDocument }
      | { op: "delete"; id: URI }
    >,
    source?: IStorageTransaction,
  ): Promise<Result<Unit, StorageTransactionRejected>> {
    const localSeq = this.#nextLocalSeq++;
    const commit = {
      localSeq,
      reads: this.buildReads(source, localSeq),
      operations: operations.map((operation) => {
        switch (operation.op) {
          case "delete":
            return operation;
          case "patch":
            return {
              op: "patch" as const,
              id: operation.id,
              patches: operation.patches,
            };
          case "set":
            return {
              op: "set" as const,
              id: operation.id,
              value: operation.value,
            };
        }
      }),
    };
    const touched = operations.map((operation) => operation.id);
    const before = Differential.checkout(
      this,
      touched.map((id) => snapshotState(this, id)),
    );

    for (const operation of operations) {
      this.applyPending(
        operation.id,
        localSeq,
        operation.op === "delete" ? undefined : operation.value,
      );
    }

    const optimistic = before.compare(this);
    this.#subscription.next({
      type: "commit",
      space: this.#space,
      changes: optimistic,
      source,
    });
    this.notifySinks(optimistic);

    const promise = this.pushCommit(
      localSeq,
      operations,
      commit as any,
      source,
    );
    this.#commitPromises.add(promise);
    const result = await promise;
    this.#commitPromises.delete(promise);
    return result;
  }

  private async pushCommit(
    localSeq: number,
    operations: Array<
      | { op: "set"; id: URI; value: EntityDocument }
      | { op: "patch"; id: URI; patches: PatchOp[]; value: EntityDocument }
      | { op: "delete"; id: URI }
    >,
    commit: any,
    source?: IStorageTransaction,
  ): Promise<Result<Unit, StorageTransactionRejected>> {
    try {
      const { session } = await this.sessionHandle();
      const applied = await session.transact(commit);
      this.confirmPending(localSeq, operations, applied);
      return { ok: {} };
    } catch (error) {
      const rejection = toRejectedError(error, commit);
      const before = Differential.checkout(
        this,
        operations.map((operation) => snapshotState(this, operation.id)),
      );
      this.dropPending(localSeq);
      const changes = before.compare(this);
      this.#subscription.next({
        type: "revert",
        space: this.#space,
        changes,
        reason: rejection,
        source,
      });
      this.notifySinks(changes);
      return { error: rejection };
    }
  }

  private buildReads(
    source: IStorageTransaction | undefined,
    localSeq: number,
  ) {
    const confirmed: ConfirmedCommitRead[] = [];
    const pending: PendingCommitRead[] = [];
    if (!source) {
      return { confirmed, pending };
    }

    const reads = getDirectTransactionReadActivities(source);
    if (!reads) {
      throw new Error(
        "Memory v2 commit tracking requires source.getReadActivities(); " +
          "journal.activity() fallback is unsupported.",
      );
    }

    for (const read of reads) {
      if (read.space !== this.#space || read.type !== DOCUMENT_MIME) {
        continue;
      }

      const record = this.#docs.get(read.id as URI);
      const pendingLocalSeq = record?.pending
        .filter((version) => version.localSeq < localSeq)
        .at(-1)?.localSeq;
      if (pendingLocalSeq !== undefined) {
        pending.push({
          id: read.id as URI,
          path: toCommitReadPath(read.path),
          localSeq: pendingLocalSeq,
          ...(read.nonRecursive === true ? { nonRecursive: true } : {}),
        });
      } else {
        confirmed.push({
          id: read.id as URI,
          path: toCommitReadPath(read.path),
          seq: typeof read.meta?.seq === "number"
            ? read.meta.seq
            : record?.confirmed.seq ?? 0,
          ...(read.nonRecursive === true ? { nonRecursive: true } : {}),
        });
      }
    }
    return {
      confirmed: compactCommitReads(this.#space, confirmed).map((
        { nonRecursive: _skip, ...read },
      ) => read),
      pending: compactCommitReads(this.#space, pending).map((
        { nonRecursive: _skip, ...read },
      ) => read),
    };
  }

  private applySessionSync(
    sync: SessionSync,
    type: "pull" | "integrate",
  ): void {
    if (sync.upserts.length === 0 && sync.removes.length === 0) {
      return;
    }

    const touchedIds = new Set<URI>([
      ...sync.upserts.map((upsert) => upsert.id as URI),
      ...sync.removes.map((remove) => remove.id as URI),
    ]);

    const before = Differential.checkout(
      this,
      [...touchedIds].map((id) => snapshotState(this, id)),
    );

    for (const upsert of sync.upserts) {
      const record = this.record(upsert.id as URI);
      record.confirmed = confirmedVersion(
        upsert.seq,
        upsert.deleted === true ? undefined : upsert.doc,
      );
      this.#watchedIds.add(upsert.id as URI);
    }
    for (const remove of sync.removes) {
      const id = remove.id as URI;
      const record = this.record(id);
      record.confirmed = confirmedVersion(0, undefined);
      this.#watchedIds.delete(id);
    }

    const changes = before.compare(this);
    if (type === "pull" || [...changes].length > 0) {
      this.#subscription.next({
        type,
        space: this.#space,
        changes,
      } as StorageNotification);
      this.notifySinks(changes);
    }
  }

  private record(id: URI): DocumentRecord {
    let record = this.#docs.get(id);
    if (!record) {
      record = {
        confirmed: confirmedVersion(0, undefined),
        pending: [],
      };
      this.#docs.set(id, record);
    }
    return record;
  }

  private applyPending(
    id: URI,
    localSeq: number,
    value: EntityDocument | undefined,
  ): void {
    const record = this.record(id);
    record.pending.push(pendingVersion(localSeq, value));
  }

  private confirmPending(
    localSeq: number,
    operations: Array<
      | { op: "set"; id: URI; value: EntityDocument }
      | { op: "patch"; id: URI; patches: PatchOp[]; value: EntityDocument }
      | { op: "delete"; id: URI }
    >,
    applied: AppliedCommit,
  ): void {
    for (const id of new Set(operations.map((operation) => operation.id))) {
      const record = this.record(id);
      const pending = [...record.pending].findLast((entry) =>
        entry.localSeq === localSeq
      );
      if (!pending) {
        logger.warn?.(
          `confirmPending: no pending entry for localSeq=${localSeq} on ${id}`,
        );
        continue;
      }
      record.confirmed = confirmedVersion(
        applied.seq,
        pending.value,
      );
      record.pending = record.pending.filter((entry) =>
        entry.localSeq !== localSeq
      );
    }
  }

  private dropPending(localSeq: number): void {
    for (const record of this.#docs.values()) {
      record.pending = record.pending.filter((entry) =>
        entry.localSeq !== localSeq
      );
    }
  }

  private visibleValue(id: URI): StorableDatum | undefined {
    const record = this.#docs.get(id);
    if (!record) {
      return undefined;
    }
    const pending = record.pending.at(-1);
    if (pending !== undefined) {
      return transactionValueForVersion(pending);
    }
    return transactionValueForVersion(record.confirmed);
  }

  private getState(id: URI): State | undefined {
    const value = this.visibleValue(id);
    if (value === undefined) {
      return undefined;
    }
    return {
      ...assert({
        the: DOCUMENT_MIME,
        of: id,
        is: value,
        cause: null,
      }),
      since: this.#docs.get(id)?.confirmed.seq ?? 0,
    } as State;
  }

  private visibleDocument(id: URI): EntityDocument | undefined {
    const record = this.#docs.get(id);
    if (!record) {
      return undefined;
    }
    const pending = record.pending.at(-1);
    if (pending !== undefined) {
      return pending.value;
    }
    return record.confirmed.value;
  }

  private notifySinks(changes: IMergedChanges): void {
    const ids = new Set<URI>();
    for (const change of changes) {
      ids.add(change.address.id as URI);
    }
    for (const id of ids) {
      const current = this.visibleDocument(id);
      for (const callback of this.#sinks.get(id) ?? []) {
        try {
          callback(current);
        } catch (error) {
          logger.error("sink-error", () => [`storage sink failed: ${error}`]);
        }
      }
    }
  }

  private sessionHandle(): Promise<{
    client: MemoryV2Client.Client;
    session: MemoryV2Client.SpaceSession;
  }> {
    if (this.#sessionHandle === undefined) {
      const handle = this.#createSession().catch((error) => {
        if (this.#sessionHandle === handle) {
          this.#sessionHandle = undefined;
        }
        throw error;
      });
      this.#sessionHandle = handle;
    }
    return this.#sessionHandle;
  }
}

const snapshotState = (replica: SpaceReplica, id: URI): State => {
  return replica.get({ id, type: DOCUMENT_MIME, path: [] }) ??
    unclaimed({ of: id, the: DOCUMENT_MIME });
};

const toConnectionError = (error: unknown): IConnectionError =>
  ({
    name: "ConnectionError",
    message: error instanceof Error ? error.message : String(error),
    address: "",
    cause: {
      name: "SystemError",
      message: error instanceof Error ? error.message : String(error),
      code: 500,
    },
  }) as IConnectionError;

const toRejectedError = (
  error: unknown,
  commit: unknown,
): StorageTransactionRejected => {
  const message = error instanceof Error ? error.message : String(error);
  if (
    (error instanceof Error && error.name === "ConflictError") ||
    message.includes("stale confirmed read") ||
    message.includes("pending dependency")
  ) {
    return {
      name: "ConflictError",
      message,
      transaction: commit as any,
      conflict: {
        expected: null,
        actual: null,
        existsInHistory: false,
        history: [],
      },
    } as unknown as IConflictError;
  }

  return {
    name: "TransactionError",
    message,
    cause: {
      name: "SystemError",
      message,
      code: 500,
    },
    transaction: commit as any,
  } as unknown as TransactionError;
};
