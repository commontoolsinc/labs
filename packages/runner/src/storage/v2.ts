import {
  cloneIfNecessary,
  cloneWithoutValueAtPath,
  cloneWithValueAtPath,
} from "@commonfabric/data-model/fabric-value";
import {
  type ConflictError as IConflictError,
  type ConnectionError as IConnectionError,
  type FabricValue,
  type MemorySpace,
  type MIME,
  type SchemaPathSelector,
  type Signer,
  type TransactionError,
  type URI,
} from "@commonfabric/memory/interface";
import { assert, unclaimed } from "@commonfabric/memory/fact";
import * as MemoryV2Client from "@commonfabric/memory/v2/client";
import {
  type CellScope,
  type ClientCommit,
  type DocumentPath,
  type EntityDocument,
  getPersistentSchedulerStateConfig,
  type PatchOp,
  type SchedulerActionSnapshotQuery,
  type SchedulerObservationCommit,
  type SchedulerSnapshotListResult,
  type SessionSync,
  toDocumentPath,
} from "@commonfabric/memory/v2";
import { parentPath, parsePointer } from "../../../memory/v2/path.ts";
import type { AppliedCommit } from "@commonfabric/memory/v2/engine";
import { getLogger } from "@commonfabric/utils/logger";
import { isObject, isRecord } from "@commonfabric/utils/types";
import type { Cell } from "../cell.ts";
import type { JSONSchema } from "../builder/types.ts";
import { ContextualFlowControl } from "../cfc.ts";
import { hashStringOf } from "@commonfabric/data-model/value-hash";
import { sortAndCompactPaths } from "../reactive-dependencies.ts";
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
  NativeStorageCommit,
  PullError,
  PushError,
  Result,
  State,
  StorageNotification,
  StorageTransactionRejected,
  Unit,
} from "./interface.ts";
import { SelectorTracker } from "./selector-tracker.ts";
import * as SubscriptionManager from "./subscription.ts";
import { getDirectTransactionReadActivities } from "./transaction-inspection.ts";
import { toTransactionDocumentValue } from "./v2-document.ts";
import { hasValueAtPath, readValueAtPath } from "./v2-path.ts";
import {
  compactWatchEntries,
  normalizeSyncEntries,
  watchIdForEntry,
} from "./v2-watch.ts";
import {
  RemoteSessionFactory,
  type SessionFactory,
} from "./v2-remote-session.ts";
import * as V2Transaction from "./v2-transaction.ts";
import { normalizeCellScope } from "../scope.ts";

export { watchIdForEntry } from "./v2-watch.ts";
export type { SessionFactory } from "./v2-remote-session.ts";

const logger = getLogger("storage.v2", {
  enabled: true,
  level: "error",
});

function withCommitTiming<T>(
  keys: string[],
  fn: () => T,
): T {
  logger.timeStart(...keys);
  try {
    return fn();
  } finally {
    logger.timeEnd(...keys);
  }
}

const DATA_URI_SYNC_CACHE_MAX = 10_000;
const dataURISyncCache = new Map<string, Promise<Cell<any>>>();
const DOCUMENT_MIME = "application/json" as const;
const UNCACHED_TRANSACTION_VALUE = Symbol("uncachedTransactionValue");

const toExplicitDocument = (value: FabricValue): EntityDocument => {
  if (!isObject(value)) {
    throw new Error(
      "memory v2 transactions require explicit full-document roots",
    );
  }
  return value as EntityDocument;
};

type CachedTransactionValue =
  | FabricValue
  | typeof UNCACHED_TRANSACTION_VALUE
  | undefined;

type MaterializedVersion = {
  value: EntityDocument | undefined;
  transactionValue: CachedTransactionValue;
};

type PendingVersion =
  | {
    localSeq: number;
    op: "set";
    value: EntityDocument;
  }
  | {
    localSeq: number;
    op: "patch";
    patches: PatchOp[];
    value: EntityDocument;
  }
  | {
    localSeq: number;
    op: "delete";
  };

type ConfirmedVersion = MaterializedVersion & {
  seq: number;
};

type PendingMaterializedPrefix = MaterializedVersion & {
  localSeq: number;
};

type PendingMaterializationCache = {
  confirmed: ConfirmedVersion;
  prefixes: PendingMaterializedPrefix[];
};

type DocumentRecord = {
  confirmed: ConfirmedVersion;
  pending: PendingVersion[];
  materialized?: PendingMaterializationCache;
};

type ConfirmedCommitRead = {
  id: URI;
  scope?: CellScope;
  path: DocumentPath;
  seq: number;
  nonRecursive?: boolean;
};

type PendingCommitRead = {
  id: URI;
  scope?: CellScope;
  path: DocumentPath;
  localSeq: number;
  nonRecursive?: boolean;
};

const pendingVersion = (
  localSeq: number,
  operation:
    | { op: "set"; value: EntityDocument }
    | { op: "patch"; patches: PatchOp[]; value: EntityDocument }
    | { op: "delete" },
): PendingVersion => ({ localSeq, ...operation });

const confirmedVersion = (
  seq: number,
  value: EntityDocument | undefined,
): ConfirmedVersion => ({
  seq,
  value,
  transactionValue: UNCACHED_TRANSACTION_VALUE,
});

const transactionValueForVersion = (
  version: MaterializedVersion,
): FabricValue | undefined => {
  if (version.transactionValue === UNCACHED_TRANSACTION_VALUE) {
    version.transactionValue = toTransactionDocumentValue(version.value);
  }
  return version.transactionValue;
};

const isPathPrefix = (
  prefix: readonly string[],
  path: readonly string[],
): boolean =>
  prefix.length <= path.length &&
  prefix.every((segment, index) => segment === path[index]);

const replayPathForPendingPatchTarget = (
  base: EntityDocument | undefined,
  pendingValue: EntityDocument,
  path: readonly string[],
): string[] => {
  if (path.length === 0) {
    return [...path];
  }
  const parent = parentPath(path);
  if (
    Array.isArray(readValueAtPath(base, parent)) ||
    Array.isArray(readValueAtPath(pendingValue, parent))
  ) {
    return parent;
  }
  return [...path];
};

const changedPathsForPendingPatch = (
  base: EntityDocument | undefined,
  pendingValue: EntityDocument,
  patches: readonly PatchOp[],
): string[][] =>
  patches.flatMap((patch) => {
    switch (patch.op) {
      case "replace":
      case "splice":
        return [parsePointer(patch.path)];
      case "add":
      case "remove": {
        const path = parsePointer(patch.path);
        return [replayPathForPendingPatchTarget(base, pendingValue, path)];
      }
      case "move": {
        const from = parsePointer(patch.from);
        const to = parsePointer(patch.path);
        return [
          replayPathForPendingPatchTarget(base, pendingValue, from),
          replayPathForPendingPatchTarget(base, pendingValue, to),
        ];
      }
    }
  });

const compactChangedPaths = (paths: readonly string[][]): string[][] => {
  const sorted = [...paths].sort((left, right) => left.length - right.length);
  const retained: string[][] = [];
  for (const path of sorted) {
    if (retained.some((existing) => isPathPrefix(existing, path))) {
      continue;
    }
    retained.push(path);
  }
  return retained;
};

const applyPendingVersion = (
  base: EntityDocument | undefined,
  pending: PendingVersion,
): EntityDocument | undefined => {
  switch (pending.op) {
    case "delete":
      return undefined;
    case "set":
      return cloneIfNecessary(pending.value as FabricValue) as EntityDocument;
    case "patch": {
      let next = base;
      for (
        const path of compactChangedPaths(
          changedPathsForPendingPatch(base, pending.value, pending.patches),
        )
      ) {
        if (hasValueAtPath(pending.value, path)) {
          next = cloneWithValueAtPath(
            next,
            path,
            readValueAtPath(pending.value, path),
          ) as EntityDocument;
          continue;
        }
        next = cloneWithoutValueAtPath(next, path) as
          | EntityDocument
          | undefined;
      }
      return next;
    }
  }
};

const ensurePendingMaterializationCache = (
  record: DocumentRecord,
): PendingMaterializationCache => {
  const existing = record.materialized;
  if (existing && existing.confirmed === record.confirmed) {
    return existing;
  }
  const cache: PendingMaterializationCache = {
    confirmed: record.confirmed,
    prefixes: [],
  };
  record.materialized = cache;
  return cache;
};

const materializedVersionThroughPending = (
  record: DocumentRecord,
  pendingCount = record.pending.length,
): MaterializedVersion => {
  if (pendingCount <= 0) {
    return record.confirmed;
  }

  const cache = ensurePendingMaterializationCache(record);
  while (cache.prefixes.length < pendingCount) {
    const nextIndex = cache.prefixes.length;
    const base = nextIndex === 0
      ? record.confirmed
      : cache.prefixes[nextIndex - 1]!;
    const pending = record.pending[nextIndex]!;
    cache.prefixes.push({
      localSeq: pending.localSeq,
      value: applyPendingVersion(base.value, pending),
      transactionValue: UNCACHED_TRANSACTION_VALUE,
    });
  }
  return cache.prefixes[pendingCount - 1]!;
};

const dropMaterializedSuffix = (
  record: DocumentRecord,
  pendingIndex: number,
): void => {
  if (pendingIndex <= 0) {
    record.materialized = undefined;
    return;
  }

  const cache = record.materialized;
  if (!cache) {
    return;
  }
  if (cache.confirmed !== record.confirmed) {
    record.materialized = undefined;
    return;
  }

  cache.prefixes.length = Math.min(cache.prefixes.length, pendingIndex);
  if (cache.prefixes.length === 0) {
    record.materialized = undefined;
  }
};

export interface Options {
  as: Signer;
  address: URL;
  id?: string;
  settings?: IRemoteStorageProviderSettings;
  spaceIdentity?: Signer;
}

export const defaultSettings: IRemoteStorageProviderSettings = {
  maxSubscriptionsPerSpace: 50_000,
  connectionTimeout: 30_000,
};

const comparePath = (left: readonly string[], right: readonly string[]) => {
  if (left.length !== right.length) {
    return left.length - right.length;
  }
  const limit = Math.min(left.length, right.length);
  for (let index = 0; index < limit; index++) {
    const a = left[index];
    const b = right[index];
    if (a !== b) {
      return a < b ? -1 : 1;
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
    const leftScope = normalizeCellScope(left.scope);
    const rightScope = normalizeCellScope(right.scope);
    if (leftScope !== rightScope) {
      return leftScope < rightScope ? -1 : 1;
    }

    if (left.id !== right.id) {
      return left.id < right.id ? -1 : 1;
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
      ? `confirmed:${
        normalizeCellScope(candidate.scope)
      }:${candidate.id}:${candidate.seq}`
      : `pending:${
        normalizeCellScope(candidate.scope)
      }:${candidate.id}:${candidate.localSeq}`;
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
        scope: read.scope,
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
    const leftScope = normalizeCellScope(left.scope);
    const rightScope = normalizeCellScope(right.scope);
    if (leftScope !== rightScope) {
      return leftScope < rightScope ? -1 : 1;
    }

    if (left.id !== right.id) {
      return left.id < right.id ? -1 : 1;
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

export class StorageManager implements IStorageManager {
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
      // Session principal drives user/session scoped storage. Even when we have
      // a derived space key for named spaces, the connection must authenticate
      // as the active user.
      const signer = this.as;
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

  async closeNow(): Promise<void> {
    if (this.#providers.size === 0) {
      return;
    }
    await Promise.all(
      [...this.#providers.values()].map((provider) => provider.destroyNow()),
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
    const { space, id, schema, scope } = cell.getAsNormalizedFullLink();
    if (!space) {
      throw new Error("No space set");
    }

    if (id.startsWith("data:")) {
      return this.syncDataURICell(cell, space, id, schema, scope);
    }

    const provider = this.open(space);
    await provider.sync(id, {
      path: cell.path.map((segment) => segment.toString()),
      schema: schema ?? false,
    }, scope);
    await this.syncCfcSchemaDocument(
      space,
      (provider as {
        get?: (uri: URI, scope?: CellScope) => EntityDocument | undefined;
      }).get?.(id, scope),
    );
    return cell;
  }

  private async syncCfcSchemaDocument(
    space: MemorySpace,
    document: EntityDocument | undefined,
  ): Promise<void> {
    const cfc = isRecord(document?.cfc) ? document.cfc : undefined;
    const schemaHash = cfc?.schemaHash;
    if (typeof schemaHash !== "string" || schemaHash.length === 0) {
      return;
    }
    await this.open(space).sync(`cid:${schemaHash}` as URI, {
      path: [],
      schema: false,
    });
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
    scope: CellScope | undefined,
  ): Promise<Cell<T>> {
    const pathStr = JSON.stringify(cell.path);
    const schemaStr = schema ? hashStringOf(schema) : "";
    const cacheKey = `${id}|${schemaStr}|${pathStr}|${space}|${
      normalizeCellScope(scope)
    }`;
    const existing = dataURISyncCache.get(cacheKey);
    if (existing) {
      return existing as Promise<Cell<T>>;
    }
    const promise = this.syncDataURICellUncached(
      cell,
      space,
      id,
      schema,
      scope,
    );
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
    scope: CellScope | undefined,
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
      scope: normalizeCellScope(scope),
      path: [],
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
          }, normalizeCellScope(link.scope as CellScope | undefined)),
        );
      }
      return;
    }

    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        const item = value[i];
        const itemSchema = schema
          ? cfc.getSchemaAtPath(schema, [String(i)])
          : undefined;
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

  sync(
    uri: URI,
    selector?: SchemaPathSelector,
    scope?: CellScope,
  ): Promise<Result<Unit, Error>> {
    return this.replica.sync(uri, selector, scope) as Promise<
      Result<Unit, Error>
    >;
  }

  synced(): Promise<void> {
    return this.replica.synced();
  }

  listSchedulerActionSnapshots(
    query: SchedulerActionSnapshotQuery = {},
  ): Promise<SchedulerSnapshotListResult> {
    return this.replica.listSchedulerActionSnapshots(query);
  }

  get(uri: URI, scope?: CellScope): EntityDocument | undefined {
    return this.replica.getDocument(uri, scope);
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

  async destroyNow(): Promise<void> {
    if (!this.#destroyed) {
      this.#destroyed = true;
    }
    await this.replica.closeNow();
  }

  getReplica(): string | undefined {
    return this.options.space;
  }
}

type SyncTask = {
  entries: [{ id: URI; type: MIME; scope?: CellScope }, SchemaPathSelector][];
  promise: Promise<Result<Unit, PullError>>;
};

type WatchRefreshBatch = {
  type: "pull" | "integrate";
  entries: Map<
    string,
    [{ id: URI; type: MIME; scope?: CellScope }, SchemaPathSelector]
  >;
  pending: PromiseWithResolvers<Result<Unit, PullError>>;
};

type NativeCommitOperation =
  | { op: "set"; id: URI; scope?: CellScope; value: EntityDocument }
  | {
    op: "patch";
    id: URI;
    scope?: CellScope;
    patches: PatchOp[];
    value: EntityDocument;
  }
  | { op: "delete"; id: URI; scope?: CellScope };

type SchedulerObservationBatchEntry = {
  commit: SchedulerObservationCommit;
  pending: PromiseWithResolvers<Result<Unit, StorageTransactionRejected>>;
};

const docKey = (id: URI, scope?: CellScope): string =>
  `${normalizeCellScope(scope)}\0${id}`;

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
  readonly #docs = new Map<string, DocumentRecord>();
  readonly #syncTasks = new Map<string, SyncTask>();
  readonly #commitPromises = new Set<
    Promise<Result<Unit, StorageTransactionRejected>>
  >();
  readonly #schedulerObservationBatch: SchedulerObservationBatchEntry[] = [];
  #schedulerObservationFlushScheduled = false;
  #schedulerObservationFlushPromise:
    | Promise<Result<Unit, StorageTransactionRejected>>
    | undefined;
  readonly #syncPromises = new Set<Promise<Result<Unit, PullError>>>();
  readonly #updatePromises = new Set<Promise<void>>();
  readonly #sinks = new Map<
    string,
    Set<(document: EntityDocument | undefined) => void>
  >();
  #watchView: MemoryV2Client.WatchView | null = null;
  #watchSelectorTracker = new SelectorTracker<Result<Unit, PullError>>();
  #watchedIds = new Set<string>();
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
    return this.getState(entry.id as URI, entry.scope);
  }

  async sync(
    uri: URI,
    selector?: SchemaPathSelector,
    scope?: CellScope,
  ): Promise<Result<Unit, PullError>> {
    return await this.pull([[
      { id: uri, type: DOCUMENT_MIME as MIME, scope },
      selector,
    ]]);
  }

  sinkDocument(
    uri: URI,
    callback: (document: EntityDocument | undefined) => void,
  ): Cancel {
    const key = docKey(uri);
    let subscribers = this.#sinks.get(key);
    if (!subscribers) {
      subscribers = new Set();
      this.#sinks.set(key, subscribers);
    }
    subscribers.add(callback);
    void this.sync(uri);
    return () => {
      const current = this.#sinks.get(key);
      current?.delete(callback);
      if (current && current.size === 0) {
        this.#sinks.delete(key);
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
    if (
      this.#schedulerObservationBatch.length > 0 ||
      this.#schedulerObservationFlushPromise
    ) {
      await this.flushSchedulerObservationBatch();
    }
    await Promise.all([...this.#syncPromises, ...this.#commitPromises]);
  }

  async listSchedulerActionSnapshots(
    query: SchedulerActionSnapshotQuery = {},
  ): Promise<SchedulerSnapshotListResult> {
    if (!getPersistentSchedulerStateConfig()) {
      return { serverSeq: 0, snapshots: [] };
    }
    const { session } = await this.sessionHandle();
    return await session.listSchedulerActionSnapshots(query);
  }

  getDocument(uri: URI, scope?: CellScope): EntityDocument | undefined {
    return this.visibleDocument(uri, scope);
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

  closeNow(): void {
    this.cancelQueuedWatchRefresh();
    this.#watchView?.close();
    this.#watchView = null;
    const sessionHandle = this.#sessionHandle;
    this.#sessionHandle = undefined;
    if (sessionHandle) {
      sessionHandle.then(({ client }) => client.close()).catch(() => {
        // The session never opened cleanly; there is nothing to close.
      });
    }
    void Promise.allSettled([...this.#updatePromises]);
    this.#syncTasks.clear();
    this.#watchSelectorTracker = new SelectorTracker<Result<Unit, PullError>>();
  }

  async load(
    entries: [
      { id: URI; type: MIME; scope?: CellScope },
      SchemaPathSelector | undefined,
    ][],
  ): Promise<Result<Unit, PullError>> {
    const known = entries
      .map(([address]) => this.getState(address.id, address.scope))
      .filter((state): state is State => state !== undefined);
    this.#subscription.next({
      type: "load",
      space: this.#space,
      changes: Differential.load(known),
    });
    return await this.pull(entries);
  }

  async pull(
    entries: [
      { id: URI; type: MIME; scope?: CellScope },
      SchemaPathSelector | undefined,
    ][],
  ): Promise<Result<Unit, PullError>> {
    if (entries.length === 0) {
      return { ok: {} };
    }

    const normalizedEntries = normalizeSyncEntries(entries);
    const key = hashStringOf(normalizedEntries.map(([address, selector]) => ({
      id: address.id,
      scope: normalizeCellScope(address.scope),
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
      const baseAddress = {
        id: address.id,
        type: DOCUMENT_MIME,
        scope: normalizeCellScope(address.scope),
      };
      const [superset] = this.#watchSelectorTracker.getSupersetSelector(
        baseAddress,
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
    const promise = this.enqueueWatchRefresh("pull", newEntries);
    task.promise = promise;
    for (const [address, selector] of newEntries) {
      const baseAddress = {
        id: address.id,
        type: DOCUMENT_MIME,
        scope: normalizeCellScope(address.scope),
      };
      this.#watchSelectorTracker.add(
        baseAddress,
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
          const baseAddress = {
            id: address.id,
            type: DOCUMENT_MIME,
            scope: normalizeCellScope(address.scope),
          };
          this.#watchSelectorTracker.delete(
            baseAddress,
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
    const schedulerObservation = getPersistentSchedulerStateConfig()
      ? transaction.schedulerObservation
      : undefined;
    const operations = withCommitTiming(
      ["commitNative", "normalize"],
      () =>
        transaction.operations
          .filter((operation) => operation.type === DOCUMENT_MIME)
          .map((operation) =>
            operation.op === "delete"
              ? {
                op: "delete" as const,
                id: operation.id,
                scope: operation.scope,
              }
              : operation.op === "patch"
              ? {
                op: "patch" as const,
                id: operation.id,
                scope: operation.scope,
                patches: operation.patches,
                value: toExplicitDocument(operation.value),
              }
              : {
                op: "set" as const,
                id: operation.id,
                scope: operation.scope,
                value: toExplicitDocument(operation.value),
              }
          ),
    );

    if (operations.length === 0 && schedulerObservation === undefined) {
      return { ok: {} };
    }

    return await withCommitTiming(
      ["commitNative", "commitOperations"],
      () => this.commitOperations(operations, source, schedulerObservation),
    );
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
    entries: Iterable<
      [{ id: URI; type: MIME; scope?: CellScope }, SchemaPathSelector]
    >,
    type: "pull" | "integrate" = "pull",
  ): Promise<Result<Unit, PullError>> {
    try {
      const { session } = await this.sessionHandle();
      const rawEntries = [...entries];
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
            scope: normalizeCellScope(address.scope),
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
    entries: [{ id: URI; type: MIME; scope?: CellScope }, SchemaPathSelector][],
  ): Promise<Result<Unit, PullError>> {
    if (this.#queuedWatchRefresh !== null) {
      for (const [address, selector] of entries) {
        this.#queuedWatchRefresh.entries.set(
          watchIdForEntry(address, selector, ""),
          [address, selector],
        );
      }
      return this.#queuedWatchRefresh.pending.promise;
    }

    const batch: WatchRefreshBatch = {
      type,
      entries: new Map(entries.map(([address, selector]) => [
        watchIdForEntry(address, selector, ""),
        [address, selector] as [
          { id: URI; type: MIME; scope?: CellScope },
          SchemaPathSelector,
        ],
      ])),
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
      batch.pending.resolve(
        await this.refreshWatchSet(batch.entries.values(), batch.type),
      );
    } catch (error) {
      batch.pending.resolve({ error: toConnectionError(error) });
    }
  }

  private cancelQueuedWatchRefresh(): void {
    this.#queuedWatchRefreshScheduled = false;
    if (this.#queuedWatchRefresh !== null) {
      this.#queuedWatchRefresh.pending.resolve({
        error: toConnectionError(new Error("memory replica closed")),
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

  private enqueueSchedulerObservationCommit(
    schedulerObservation: unknown,
    source?: IStorageTransaction,
  ): Promise<Result<Unit, StorageTransactionRejected>> {
    if (!getPersistentSchedulerStateConfig()) {
      return Promise.resolve({ ok: {} });
    }
    const localSeq = this.#nextLocalSeq++;
    const pending = Promise.withResolvers<
      Result<Unit, StorageTransactionRejected>
    >();
    this.#schedulerObservationBatch.push({
      commit: {
        localSeq,
        reads: this.buildReads(source, localSeq),
        schedulerObservation,
      },
      pending,
    });
    this.scheduleSchedulerObservationFlush();
    return pending.promise;
  }

  private scheduleSchedulerObservationFlush(): void {
    if (this.#schedulerObservationFlushScheduled) {
      return;
    }
    this.#schedulerObservationFlushScheduled = true;
    queueMicrotask(() => {
      this.#schedulerObservationFlushScheduled = false;
      void this.flushSchedulerObservationBatch();
    });
  }

  private async flushSchedulerObservationBatch(): Promise<
    Result<Unit, StorageTransactionRejected>
  > {
    let lastResult: Result<Unit, StorageTransactionRejected> = { ok: {} };
    while (true) {
      if (this.#schedulerObservationFlushPromise) {
        lastResult = await this.#schedulerObservationFlushPromise;
        if (
          this.#schedulerObservationBatch.length === 0 ||
          "error" in lastResult
        ) {
          return lastResult;
        }
        continue;
      }

      if (this.#schedulerObservationBatch.length === 0) {
        return lastResult;
      }

      lastResult = await this.startSchedulerObservationBatchFlush();
      if ("error" in lastResult) {
        return lastResult;
      }
    }
  }

  private startSchedulerObservationBatchFlush(): Promise<
    Result<Unit, StorageTransactionRejected>
  > {
    const entries = this.#schedulerObservationBatch.splice(0);
    const localSeq = this.#nextLocalSeq++;
    const commit: ClientCommit = {
      localSeq,
      reads: { confirmed: [], pending: [] },
      operations: [],
      schedulerObservationBatch: entries.map((entry) => entry.commit),
    };
    const promise = this.pushCommit(localSeq, [], commit, undefined)
      .then((result) => {
        for (const entry of entries) {
          entry.pending.resolve(result);
        }
        return result;
      }, (error) => {
        const rejection = toRejectedError(error, commit);
        const result = { error: rejection };
        for (const entry of entries) {
          entry.pending.resolve(result);
        }
        return result;
      });
    this.#schedulerObservationFlushPromise = promise;
    this.#commitPromises.add(promise);
    promise.finally(() => {
      this.#commitPromises.delete(promise);
      if (this.#schedulerObservationFlushPromise === promise) {
        this.#schedulerObservationFlushPromise = undefined;
      }
    });
    return promise;
  }

  private async commitOperations(
    operations: NativeCommitOperation[],
    source?: IStorageTransaction,
    schedulerObservation?: unknown,
  ): Promise<Result<Unit, StorageTransactionRejected>> {
    if (operations.length === 0) {
      if (schedulerObservation === undefined) {
        return { ok: {} };
      }
      return await this.enqueueSchedulerObservationCommit(
        schedulerObservation,
        source,
      );
    }

    const localSeq = this.#nextLocalSeq++;
    const commit = withCommitTiming(
      ["commitOperations", "buildCommit"],
      (): ClientCommit => ({
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
                scope: operation.scope,
                patches: operation.patches,
              };
            case "set":
              return {
                op: "set" as const,
                id: operation.id,
                scope: operation.scope,
                value: operation.value,
              };
          }
        }),
        ...(schedulerObservation !== undefined ? { schedulerObservation } : {}),
      }),
    );
    const touched = operations.map((operation) => ({
      id: operation.id,
      scope: operation.scope,
    }));
    const hasSemanticOperations = operations.length > 0;
    const shouldNotifySubscribers = hasSemanticOperations &&
      this.hasNotificationSubscribers();
    const shouldNotifySinks = hasSemanticOperations &&
      this.hasSinkSubscribers(touched);
    const before = withCommitTiming(
      ["commitOperations", "snapshotBefore"],
      () =>
        shouldNotifySubscribers
          ? Differential.checkout(
            this,
            touched.map(({ id, scope }) => snapshotState(this, id, scope)),
          )
          : undefined,
    );

    withCommitTiming(["commitOperations", "applyPending"], () => {
      for (const operation of operations) {
        this.applyPending(operation, localSeq);
      }
    });

    withCommitTiming(["commitOperations", "notifyOptimistic"], () => {
      if (before !== undefined) {
        const optimistic = before.compare(this);
        this.#subscription.next({
          type: "commit",
          space: this.#space,
          changes: optimistic,
          source,
        });
        if (shouldNotifySinks) {
          this.notifySinks(optimistic);
        }
      } else if (shouldNotifySinks) {
        this.notifySinksForIds(touched);
      }
    });

    const promise = withCommitTiming(
      ["commitOperations", "pushCommitStart"],
      () =>
        this.pushCommit(
          localSeq,
          operations,
          commit,
          source,
        ),
    );
    this.#commitPromises.add(promise);
    const result = await promise;
    this.#commitPromises.delete(promise);
    return result;
  }

  private async pushCommit(
    localSeq: number,
    operations: NativeCommitOperation[],
    commit: ClientCommit,
    source?: IStorageTransaction,
  ): Promise<Result<Unit, StorageTransactionRejected>> {
    try {
      if (
        operations.length > 0 &&
        (this.#schedulerObservationBatch.length > 0 ||
          this.#schedulerObservationFlushPromise)
      ) {
        const flushResult = await this.flushSchedulerObservationBatch();
        const rejection = flushResult.error;
        if (rejection !== undefined) {
          const error = new Error(rejection.message);
          error.name = rejection.name ?? "TransactionError";
          throw error;
        }
      }
      const { session } = await this.sessionHandle();
      const applied = await session.transact(commit);
      this.confirmPending(localSeq, operations, applied);
      return { ok: {} };
    } catch (error) {
      const rejection = toRejectedError(error, commit);
      const touched = operations.map((operation) => ({
        id: operation.id,
        scope: operation.scope,
      }));
      const hasSemanticOperations = operations.length > 0;
      const shouldNotifySubscribers = hasSemanticOperations &&
        this.hasNotificationSubscribers();
      const shouldNotifySinks = hasSemanticOperations &&
        this.hasSinkSubscribers(touched);
      const before = shouldNotifySubscribers
        ? Differential.checkout(
          this,
          touched.map(({ id, scope }) => snapshotState(this, id, scope)),
        )
        : undefined;
      this.dropPending(localSeq);
      if (before !== undefined) {
        const changes = before.compare(this);
        this.#subscription.next({
          type: "revert",
          space: this.#space,
          changes,
          reason: rejection,
          source,
        });
        if (shouldNotifySinks) {
          this.notifySinks(changes);
        }
      } else if (shouldNotifySinks) {
        this.notifySinksForIds(touched);
      }
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
      if (
        read.space !== this.#space ||
        (read.type ?? DOCUMENT_MIME) !== DOCUMENT_MIME ||
        read.id.startsWith("data:")
      ) {
        continue;
      }

      const scope = normalizeCellScope(read.scope);
      const record = this.#docs.get(docKey(read.id as URI, scope));
      const pendingLocalSeq = record?.pending
        .filter((version) => version.localSeq < localSeq)
        .at(-1)?.localSeq;
      if (pendingLocalSeq !== undefined) {
        pending.push({
          id: read.id as URI,
          scope,
          path: toCommitReadPath(read.path),
          localSeq: pendingLocalSeq,
          ...(read.nonRecursive === true ? { nonRecursive: true } : {}),
        });
      } else {
        confirmed.push({
          id: read.id as URI,
          scope,
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

    const touched = [
      ...sync.upserts.map((upsert) => ({
        id: upsert.id as URI,
        scope: upsert.scope,
      })),
      ...sync.removes.map((remove) => ({
        id: remove.id as URI,
        scope: remove.scope,
      })),
    ];

    const shouldNotifySubscribers = this.hasNotificationSubscribers();
    const shouldNotifySinks = this.hasSinkSubscribers(touched);
    const before = shouldNotifySubscribers
      ? Differential.checkout(
        this,
        touched.map(({ id, scope }) => snapshotState(this, id, scope)),
      )
      : undefined;

    for (const upsert of sync.upserts) {
      const record = this.record(upsert.id as URI, upsert.scope);
      // Watch refreshes can arrive after local confirmations. Never move the
      // confirmed base backwards; pending replay depends on monotonic bases.
      if (upsert.seq < record.confirmed.seq) {
        continue;
      }
      record.confirmed = confirmedVersion(
        upsert.seq,
        upsert.deleted === true ? undefined : upsert.doc,
      );
      record.materialized = undefined;
      this.#watchedIds.add(docKey(upsert.id as URI, upsert.scope));
    }
    for (const remove of sync.removes) {
      const id = remove.id as URI;
      const record = this.record(id, remove.scope);
      record.confirmed = confirmedVersion(0, undefined);
      record.materialized = undefined;
      this.#watchedIds.delete(docKey(id, remove.scope));
    }

    if (before !== undefined) {
      const changes = before.compare(this);
      if (type === "pull" || [...changes].length > 0) {
        this.#subscription.next({
          type,
          space: this.#space,
          changes,
        } as StorageNotification);
        if (shouldNotifySinks) {
          this.notifySinks(changes);
        }
      }
    } else if (shouldNotifySinks) {
      this.notifySinksForIds(touched);
    }
  }

  private record(id: URI, scope?: CellScope): DocumentRecord {
    const key = docKey(id, scope);
    let record = this.#docs.get(key);
    if (!record) {
      record = {
        confirmed: confirmedVersion(0, undefined),
        pending: [],
        materialized: undefined,
      };
      this.#docs.set(key, record);
    }
    return record;
  }

  private applyPending(
    operation: NativeCommitOperation,
    localSeq: number,
  ): void {
    const { id, scope, ...pending } = operation;
    const record = this.record(id, scope);
    record.pending.push(pendingVersion(localSeq, pending));
  }

  private confirmPending(
    localSeq: number,
    operations: NativeCommitOperation[],
    applied: AppliedCommit,
  ): void {
    const keys = new Map(
      operations.map((operation) => [
        docKey(operation.id, operation.scope),
        { id: operation.id, scope: operation.scope },
      ]),
    );
    for (const { id, scope } of keys.values()) {
      const record = this.record(id, scope);
      const pendingIndexes = record.pending.flatMap((entry, index) =>
        entry.localSeq === localSeq ? [index] : []
      );
      if (pendingIndexes.length === 0) {
        logger.warn?.(
          `confirmPending: no pending entry for localSeq=${localSeq} on ${id}`,
        );
        continue;
      }
      const firstPendingIndex = pendingIndexes[0]!;
      const lastPendingIndex = pendingIndexes[pendingIndexes.length - 1]!;
      const pending = record.pending[lastPendingIndex]!;
      const previousConfirmed = record.confirmed;
      let promoted: ConfirmedVersion | undefined;
      let reusedSuffix: PendingMaterializedPrefix[] | undefined;

      if (record.confirmed.seq < applied.seq) {
        if (firstPendingIndex === 0) {
          const prefix = materializedVersionThroughPending(
            record,
            lastPendingIndex + 1,
          );
          const cache = ensurePendingMaterializationCache(record);
          promoted = confirmedVersion(
            applied.seq,
            prefix.value,
          );
          promoted.transactionValue = prefix.transactionValue;
          if (cache.confirmed === previousConfirmed) {
            reusedSuffix = cache.prefixes.slice(lastPendingIndex + 1);
          }
        } else {
          promoted = confirmedVersion(
            applied.seq,
            applyPendingVersion(record.confirmed.value, pending),
          );
        }
      }

      record.pending = record.pending.filter((entry) =>
        entry.localSeq !== localSeq
      );

      if (promoted) {
        record.confirmed = promoted;
        record.materialized = reusedSuffix && reusedSuffix.length > 0
          ? {
            confirmed: promoted,
            prefixes: reusedSuffix,
          }
          : undefined;
        continue;
      }

      dropMaterializedSuffix(record, firstPendingIndex);
    }
  }

  private dropPending(localSeq: number): void {
    for (const record of this.#docs.values()) {
      const firstPendingIndex = record.pending.findIndex((entry) =>
        entry.localSeq === localSeq
      );
      if (firstPendingIndex === -1) {
        continue;
      }
      record.pending = record.pending.filter((entry) =>
        entry.localSeq !== localSeq
      );
      dropMaterializedSuffix(record, firstPendingIndex);
    }
  }

  private visibleVersion(id: URI, scope?: CellScope): {
    record: DocumentRecord;
    version: MaterializedVersion;
  } | undefined {
    const record = this.#docs.get(docKey(id, scope));
    if (!record) {
      return undefined;
    }
    return {
      record,
      version: materializedVersionThroughPending(record),
    };
  }

  private visibleValue(id: URI, scope?: CellScope): FabricValue | undefined {
    const visible = this.visibleVersion(id, scope);
    if (!visible) {
      return undefined;
    }
    return transactionValueForVersion(visible.version);
  }

  private getState(id: URI, scope?: CellScope): State | undefined {
    const visible = this.visibleVersion(id, scope);
    if (!visible) {
      return undefined;
    }
    const value = transactionValueForVersion(visible.version);
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
      scope: normalizeCellScope(scope),
      since: visible.record.confirmed.seq,
    } as State;
  }

  private visibleDocument(
    id: URI,
    scope?: CellScope,
  ): EntityDocument | undefined {
    return this.visibleVersion(id, scope)?.version.value;
  }

  private notifySinks(changes: IMergedChanges): void {
    const touched = new Map<string, { id: URI; scope?: CellScope }>();
    for (const change of changes) {
      const id = change.address.id as URI;
      const scope = change.address.scope;
      touched.set(docKey(id, scope), { id, scope });
    }
    this.notifySinksForIds(touched.values());
  }

  private notifySinksForIds(
    entries: Iterable<{ id: URI; scope?: CellScope }>,
  ): void {
    for (const { id, scope } of entries) {
      const current = this.visibleDocument(id, scope);
      for (const callback of this.#sinks.get(docKey(id, scope)) ?? []) {
        try {
          callback(current);
        } catch (error) {
          logger.error("sink-error", () => [`storage sink failed: ${error}`]);
        }
      }
    }
  }

  private hasNotificationSubscribers(): boolean {
    const candidate = this.#subscription as IStorageSubscription & {
      hasSubscribers?: () => boolean;
    };
    if (typeof candidate.hasSubscribers === "function") {
      return candidate.hasSubscribers();
    }
    return true;
  }

  private hasSinkSubscribers(
    entries: Iterable<{ id: URI; scope?: CellScope }>,
  ): boolean {
    for (const { id, scope } of entries) {
      if ((this.#sinks.get(docKey(id, scope))?.size ?? 0) > 0) {
        return true;
      }
    }
    return false;
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

const snapshotState = (
  replica: SpaceReplica,
  id: URI,
  scope?: CellScope,
): State => {
  return replica.get({ id, type: DOCUMENT_MIME, path: [], scope }) ??
    ({
      ...unclaimed({ of: id, the: DOCUMENT_MIME }),
      scope: normalizeCellScope(scope),
    } as State);
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
