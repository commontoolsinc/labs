import {
  type ConflictError as IConflictError,
  type ConnectionError as IConnectionError,
  type MemorySpace,
  type MIME,
  type SchemaPathSelector,
  type Signer,
  type StorableDatum,
  type StorableValue,
  type TransactionError,
  type URI,
} from "@commontools/memory/interface";
import { assert, unclaimed } from "@commontools/memory/fact";
import * as MemoryV2Client from "@commontools/memory/v2/client";
import type { EntitySnapshot, GraphQueryResult } from "@commontools/memory/v2";
import type { AppliedCommit } from "@commontools/memory/v2/engine";
import { getLogger } from "@commontools/utils/logger";
import { isObject, isRecord } from "@commontools/utils/types";
import type { Cell } from "../cell.ts";
import type { JSONSchema } from "../builder/types.ts";
import { ContextualFlowControl } from "../cfc.ts";
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
  OptStorageValue,
  PullError,
  PushError,
  Result,
  State,
  StorageNotification,
  StorageTransactionRejected,
  StorageValue,
  Unit,
} from "./interface.ts";
import * as SubscriptionManager from "./subscription.ts";
import * as Transaction from "./transaction.ts";

const logger = getLogger("storage.v2", {
  enabled: true,
  level: "error",
});

const DATA_URI_SYNC_CACHE_MAX = 10_000;
const dataURISyncCache = new Map<string, Promise<Cell<any>>>();
const DOCUMENT_MIME = "application/json" as const;

type PendingVersion = {
  localSeq: number;
  value: StorableDatum | undefined;
};

type ConfirmedVersion = {
  seq: number;
  hash?: string;
  value: StorableDatum | undefined;
};

type DocumentRecord = {
  confirmed: ConfirmedVersion;
  pending: PendingVersion[];
};

export interface Options {
  as: Signer;
  address: URL;
  id?: string;
  settings?: IRemoteStorageProviderSettings;
  memoryVersion?: MemoryVersion;
}

export const defaultSettings: IRemoteStorageProviderSettings = {
  maxSubscriptionsPerSpace: 50_000,
  connectionTimeout: 30_000,
};

export interface SessionFactory {
  create(space: MemorySpace): Promise<{
    client: MemoryV2Client.Client;
    session: MemoryV2Client.SpaceSession;
  }>;
}

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
  constructor(private readonly address: URL) {}

  async create(space: MemorySpace) {
    const client = await MemoryV2Client.connect({
      transport: new WebSocketTransport(this.address),
    });
    const session = await client.mount(space);
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

  static open(options: Options) {
    return new this(options, new RemoteSessionFactory(options.address));
  }

  protected constructor(
    options: Options,
    sessionFactory: SessionFactory,
  ) {
    this.id = options.id ?? crypto.randomUUID();
    this.as = options.as;
    this.#settings = options.settings ?? defaultSettings;
    this.#sessionFactory = sessionFactory;
  }

  open(space: MemorySpace): IStorageProviderWithReplica {
    let provider = this.#providers.get(space);
    if (!provider) {
      provider = new Provider({
        as: this.as,
        space,
        settings: this.#settings,
        subscription: this.#subscription,
        createSession: () => this.#sessionFactory.create(space),
      });
      this.#providers.set(space, provider);
    }
    return provider;
  }

  async close(): Promise<void> {
    await this.synced();
    await Promise.all(
      [...this.#providers.values()].map((provider) => provider.destroy()),
    );
    this.#providers.clear();
  }

  edit(): IStorageTransaction {
    return Transaction.create(this);
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
      setTimeout(resolve, 0);
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
      const itemSchema = schema && isObject(schema) && schema.items
        ? schema.items as JSONSchema
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

  send<T extends StorableValue = StorableValue>(
    batch: { uri: URI; value: StorageValue<T> }[],
  ): Promise<Result<Unit, Error>> {
    return this.replica.send(batch) as Promise<Result<Unit, Error>>;
  }

  sync(uri: URI, selector?: SchemaPathSelector): Promise<Result<Unit, Error>> {
    return this.replica.sync(uri, selector) as Promise<Result<Unit, Error>>;
  }

  synced(): Promise<void> {
    return this.replica.synced();
  }

  get<T extends StorableValue = StorableValue>(uri: URI): OptStorageValue<T> {
    return this.replica.getStorageValue(uri) as OptStorageValue<T>;
  }

  sink<T extends StorableValue = StorableValue>(
    uri: URI,
    callback: (value: StorageValue<T>) => void,
  ): Cancel {
    return this.replica.sink(uri, callback as (value: StorageValue) => void);
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
  promise: Promise<Result<Unit, PullError>>;
  iterator?: AsyncIterator<GraphQueryResult>;
  updates?: Promise<void>;
};

class SpaceReplica implements ISpaceReplica {
  readonly #space: MemorySpace;
  readonly #subscription: IStorageSubscription;
  readonly #sessionHandle: Promise<{
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
  readonly #sinks = new Map<URI, Set<(value: StorageValue) => void>>();
  #nextLocalSeq = 1;

  constructor(options: ProviderOptions) {
    this.#space = options.space;
    this.#subscription = options.subscription;
    this.#sessionHandle = options.createSession();
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

  sink(uri: URI, callback: (value: StorageValue) => void): Cancel {
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
    batch: { uri: URI; value: StorageValue }[],
  ): Promise<Result<Unit, PushError>> {
    const operations = batch.map(({ uri, value }) =>
      value.value === undefined
        ? { op: "delete" as const, id: uri }
        : { op: "set" as const, id: uri, value: toStoredDocument(value) }
    );
    return await this.commitOperations(operations, undefined);
  }

  async synced(): Promise<void> {
    await Promise.all([...this.#syncPromises, ...this.#commitPromises]);
  }

  getStorageValue(uri: URI): OptStorageValue {
    const visible = this.visibleValue(uri);
    return visible === undefined ? undefined : visible as OptStorageValue;
  }

  async close(): Promise<void> {
    await this.synced();
    const { client } = await this.#sessionHandle;
    await client.close();
    await Promise.allSettled([...this.#updatePromises]);
    this.#syncTasks.clear();
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

    const key = stableHash(entries.map(([address, selector]) => ({
      id: address.id,
      selector: selector ?? { path: [], schema: false },
    })));
    const existing = this.#syncTasks.get(key);
    if (existing) {
      return await existing.promise;
    }

    const task = {
      promise: Promise.resolve({ ok: {} } as Result<Unit, PullError>),
    };
    const promise = this.startSync(entries, task);
    task.promise = promise;
    this.#syncTasks.set(key, task);
    this.#syncPromises.add(promise);
    try {
      return await promise;
    } finally {
      this.#syncPromises.delete(promise);
    }
  }

  async commit(
    transaction: { facts: any[]; claims: any[] },
    source?: IStorageTransaction,
  ): Promise<Result<Unit, StorageTransactionRejected>> {
    const operations = transaction.facts
      .filter((fact) => fact.the === DOCUMENT_MIME)
      .map((fact) =>
        fact.is === undefined
          ? { op: "delete" as const, id: fact.of as URI }
          : {
            op: "set" as const,
            id: fact.of as URI,
            value: toStoredDocument(fact.is as StorableDatum),
          }
      );

    if (operations.length === 0) {
      return { ok: {} };
    }

    return await this.commitOperations(operations, source);
  }

  reset(): void {
    this.#docs.clear();
    this.#subscription.next({
      type: "reset",
      space: this.#space,
    });
  }

  private async startSync(
    entries: [{ id: URI; type: MIME }, SchemaPathSelector | undefined][],
    task: SyncTask,
  ): Promise<Result<Unit, PullError>> {
    try {
      const { session } = await this.#sessionHandle;
      const view = await session.queryGraph({
        subscribe: true,
        roots: entries.map(([address, selector]) => ({
          id: address.id,
          selector: selector ?? { path: [], schema: false },
        })),
      });

      this.applyQueryResult(view.entities, "pull");
      const iterator = view.subscribe();
      task.iterator = iterator;
      const updates = this.consumeUpdates(iterator)
        .finally(() => this.#updatePromises.delete(updates));
      this.#updatePromises.add(updates);
      task.updates = updates;
      return { ok: {} };
    } catch (error) {
      return { error: toConnectionError(error) };
    }
  }

  private async consumeUpdates(
    iterator: AsyncIterator<GraphQueryResult>,
  ): Promise<void> {
    while (true) {
      const next = await iterator.next();
      if (next.done) {
        return;
      }
      this.applyQueryResult(next.value.entities, "integrate");
    }
  }

  private async commitOperations(
    operations: Array<
      | { op: "set"; id: URI; value: StorableDatum }
      | { op: "delete"; id: URI }
    >,
    source?: IStorageTransaction,
  ): Promise<Result<Unit, StorageTransactionRejected>> {
    const localSeq = this.#nextLocalSeq++;
    const commit = {
      localSeq,
      reads: this.buildReads(source, localSeq),
      operations: operations.map((operation) =>
        operation.op === "delete"
          ? operation
          : { ...operation, value: operation.value as any }
      ),
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
      | { op: "set"; id: URI; value: StorableDatum }
      | { op: "delete"; id: URI }
    >,
    commit: any,
    source?: IStorageTransaction,
  ): Promise<Result<Unit, StorageTransactionRejected>> {
    try {
      const { session } = await this.#sessionHandle;
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
    const confirmed: Array<{ id: URI; path: string[]; seq: number }> = [];
    const pending: Array<{ id: URI; path: string[]; localSeq: number }> = [];
    if (!source) {
      return { confirmed, pending };
    }

    const seen = new Set<string>();
    for (const activity of source.journal.activity()) {
      if (!("read" in activity)) {
        continue;
      }
      const read = activity.read;
      if (!read) {
        continue;
      }
      if (read.space !== this.#space || read.type !== DOCUMENT_MIME) {
        continue;
      }
      const key = `${read.id}|${read.path.join("/")}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);

      const record = this.#docs.get(read.id as URI);
      const pendingLocalSeq = record?.pending
        .filter((version) => version.localSeq < localSeq)
        .at(-1)?.localSeq;
      if (pendingLocalSeq !== undefined) {
        pending.push({
          id: read.id as URI,
          path: ["value", ...read.path.map(String)],
          localSeq: pendingLocalSeq,
        });
      } else {
        confirmed.push({
          id: read.id as URI,
          path: ["value", ...read.path.map(String)],
          seq: typeof read.meta?.seq === "number"
            ? read.meta.seq
            : record?.confirmed.seq ?? 0,
        });
      }
    }
    return { confirmed, pending };
  }

  private applyQueryResult(
    entities: EntitySnapshot[],
    type: "pull" | "integrate",
  ): void {
    const before = Differential.checkout(
      this,
      entities.map((entity) => snapshotState(this, entity.id as URI)),
    );

    for (const entity of entities) {
      const record = this.record(entity.id as URI);
      record.confirmed = {
        seq: entity.seq,
        hash: entity.hash,
        value: entity.document as unknown as StorableDatum | undefined ??
          undefined,
      };
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
        confirmed: { seq: 0, value: undefined },
        pending: [],
      };
      this.#docs.set(id, record);
    }
    return record;
  }

  private applyPending(
    id: URI,
    localSeq: number,
    value: StorableDatum | undefined,
  ): void {
    const record = this.record(id);
    record.pending.push({ localSeq, value });
  }

  private confirmPending(
    localSeq: number,
    operations: Array<
      | { op: "set"; id: URI; value: StorableDatum }
      | { op: "delete"; id: URI }
    >,
    applied: AppliedCommit,
  ): void {
    for (const operation of operations) {
      const record = this.record(operation.id);
      const fact = applied.facts.find((entry) => entry.id === operation.id);
      const pending = record.pending.find((entry) =>
        entry.localSeq === localSeq
      );
      if (!pending) {
        continue;
      }
      record.confirmed = {
        seq: applied.seq,
        hash: fact?.hash,
        value: pending.value,
      };
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
      return pending.value;
    }
    return record.confirmed.value;
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

  private notifySinks(changes: IMergedChanges): void {
    const ids = new Set<URI>();
    for (const change of changes) {
      ids.add(change.address.id as URI);
    }
    for (const id of ids) {
      const current = this.getStorageValue(id) ?? {} as StorageValue;
      for (const callback of this.#sinks.get(id) ?? []) {
        try {
          callback(current);
        } catch (error) {
          logger.error("sink-error", () => [`storage sink failed: ${error}`]);
        }
      }
    }
  }
}

const snapshotState = (replica: SpaceReplica, id: URI): State => {
  return replica.get({ id, type: DOCUMENT_MIME, path: [] }) ??
    unclaimed({ of: id, the: DOCUMENT_MIME });
};

const toStoredDocument = (
  value: StorageValue | StorableDatum,
): StorableDatum => {
  if (
    isRecord(value) &&
    ("value" in value || "source" in value)
  ) {
    return {
      ...("value" in value ? { value: value.value as StorableValue } : {}),
      ...("source" in value && value.source !== undefined
        ? { source: value.source }
        : {}),
    } as StorableDatum;
  }
  return { value } as StorableDatum;
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
