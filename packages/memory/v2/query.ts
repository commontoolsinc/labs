import {
  CompoundCycleTracker,
  createSchemaMemo,
  createTraversalContext,
  getAtPath,
  type IAttestation,
  type IMemorySpaceValueAttestation,
  loadMetaLinkedDocs,
  ManagedStorageTransaction,
  MapSetStringToPathSelectors,
  type ObjectStorageManager,
  SchemaObjectTraverser,
  type SchemaPathSelector,
  schemaTrackerCoversSelector,
  type TraversalContext,
} from "@commonfabric/runner/traverse";
import type { JSONSchema } from "../../runner/src/builder/types.ts";
import { ExtendedStorageTransaction } from "../../runner/src/storage/extended-storage-transaction.ts";
import { isObjectNotArray } from "@commonfabric/utils/types";
import type { FabricValue } from "@commonfabric/api";
import type { MemorySpace, MIME, URI } from "../interface.ts";
import { internPathSelector } from "@commonfabric/data-model/schema-utils";
import {
  canResolveScopeKey,
  type CellScope,
  type EntitySnapshot,
  type GraphQuery,
  isScopeKey,
  resolveScopeKey,
  type ScopeKey,
  type ScopeKeyIdentity,
  scopeOfScopeKey,
  toDocumentSelector,
} from "../v2.ts";
import * as Engine from "./engine.ts";

const DEFAULT_SCOPE: CellScope = "space";

/**
 * Query/watch doc keys are per scope INSTANCE (scopes.md §7 M2, stage E):
 * the middle segment is the shared scope_key vocabulary, resolved against
 * the querying session's identity — the same identity the manager resolves
 * scoped reads with, so a key names exactly the instance the tracked read
 * saw. Per tracked-graph state the identity is fixed, so this re-keying
 * partitions state exactly as the scope-NAME form did (key-vocabulary.md
 * §2).
 */
export type QueryDocKey = `${string}/${ScopeKey}/${string}`;

export type TrackedGraphState = {
  branch: string;
  tracker: MapSetStringToPathSelectors;
  entities: Map<QueryDocKey, EntitySnapshot>;
  memo: ReturnType<typeof createSchemaMemo>;
  manager: EngineObjectManager;
};

export type QueryTraversalStats = {
  managerReads: number;
  coveredSelectorSkips: number;
  schemaTraversals: number;
  pointerTraversals: number;
  arrayTraversals: number;
  objectTraversals: number;
  dagTraversals: number;
  getDocAtPathCalls: number;
  schemaMemoHits: number;
};

const createQueryTraversalStats = (): QueryTraversalStats => ({
  managerReads: 0,
  coveredSelectorSkips: 0,
  schemaTraversals: 0,
  pointerTraversals: 0,
  arrayTraversals: 0,
  objectTraversals: 0,
  dagTraversals: 0,
  getDocAtPathCalls: 0,
  schemaMemoHits: 0,
});

const addTraverserStats = (
  stats: QueryTraversalStats,
  traverser: SchemaObjectTraverser<FabricValue>,
): void => {
  stats.schemaTraversals += traverser.traverseWithSchemaCalls;
  stats.pointerTraversals += traverser.traversePointerCalls;
  stats.arrayTraversals += traverser.traverseArrayCalls;
  stats.objectTraversals += traverser.traverseObjectCalls;
  stats.dagTraversals += traverser.traverseDAGCalls;
  stats.getDocAtPathCalls += traverser.getDocAtPathCalls;
  stats.schemaMemoHits += traverser.schemaMemoHits;
};

/**
 * The identity a manager's tracked-graph keys resolve against: the
 * querying session's own (the same identity the manager threads into every
 * scoped engine read).
 */
const identityOf = (manager: EngineObjectManager): ScopeKeyIdentity => ({
  principal: manager.principal,
  sessionId: manager.sessionId,
});

export class EngineObjectManager implements ObjectStorageManager {
  #attestations = new Map<string, IAttestation>();
  #details = new Map<string, {
    seq: number;
    document: NonNullable<Engine.EntityState["document"]>;
  }>();
  #missing = new Set<string>();
  #readCount = 0;

  constructor(
    private readonly engine: Engine.Engine,
    private readonly branch: string,
    readonly principal?: string,
    readonly sessionId?: string,
    private readonly readSeq?: number,
  ) {}

  readState(
    id: string,
    scope: CellScope = DEFAULT_SCOPE,
  ): Engine.EntityState | null {
    return Engine.readState(this.engine, {
      id,
      scope,
      principal: this.principal,
      sessionId: this.sessionId,
      branch: this.branch,
      ...(this.readSeq === undefined ? {} : { seq: this.readSeq }),
    });
  }

  load(
    address: { id: string; type?: string; scope?: CellScope },
  ): IAttestation | null {
    const type = address.type ?? "application/json";
    const scope = address.scope ?? DEFAULT_SCOPE;
    const key = `${scope}/${address.id}/${type}`;
    if (this.#attestations.has(key)) {
      return this.#attestations.get(key)!;
    }
    if (this.#missing.has(key)) {
      return null;
    }
    if (type !== "application/json") {
      this.#missing.add(key);
      return null;
    }

    const state = this.readState(address.id, scope);
    this.#readCount++;
    if (state === null || state.document === null) {
      this.#missing.add(key);
      return null;
    }

    const attestation: IAttestation = {
      address: {
        id: address.id as URI,
        scope,
        type: type as MIME,
        path: [],
      },
      value: state.document,
    };
    this.#attestations.set(key, attestation);
    this.#details.set(key, {
      seq: state.seq,
      document: state.document,
    });
    return attestation;
  }

  detail(address: { id: string; type?: string; scope?: CellScope }) {
    return this.#details.get(
      `${address.scope ?? DEFAULT_SCOPE}/${address.id}/${
        address.type ?? "application/json"
      }`,
    );
  }

  get readCount(): number {
    return this.#readCount;
  }

  loadedAddresses(): Array<{ id: string; type: string; scope: CellScope }> {
    return [...this.#attestations.values()].map((attestation) => ({
      id: attestation.address.id,
      type: attestation.address.type ?? "application/json",
      scope: attestation.address.scope ?? DEFAULT_SCOPE,
    }));
  }

  invalidateIds(ids: Iterable<string>, scope: CellScope = DEFAULT_SCOPE): void {
    for (const id of ids) {
      const key = `${scope}/${id}/application/json`;
      this.#attestations.delete(key);
      this.#details.delete(key);
      this.#missing.delete(key);
    }
  }

  mergeFrom(other: EngineObjectManager): void {
    for (const key of other.#missing) {
      this.#attestations.delete(key);
      this.#details.delete(key);
      this.#missing.add(key);
    }
    for (const [key, value] of other.#attestations) {
      this.#attestations.set(key, value);
      const detail = other.#details.get(key);
      if (detail !== undefined) {
        this.#details.set(key, detail);
      }
      this.#missing.delete(key);
    }
  }
}

export type QueryGraphReuseContext = {
  managers?: Map<string, EngineObjectManager>;
};

export type TrackGraphOptions = {
  readSeq?: number;
  principal?: string;
  sessionId?: string;
};

export const cloneTrackedGraphState = (
  engine: Engine.Engine,
  state: TrackedGraphState,
): TrackedGraphState => {
  const tracker = new MapSetStringToPathSelectors(true);
  for (const [key, selectors] of state.tracker) {
    for (const selector of selectors) {
      tracker.add(key, selector);
    }
  }

  const manager = new EngineObjectManager(
    engine,
    state.branch,
    state.manager.principal,
    state.manager.sessionId,
  );
  manager.mergeFrom(state.manager);

  return {
    branch: state.branch,
    tracker,
    entities: new Map(state.entities),
    memo: new Map(state.memo),
    manager,
  };
};

const snapshotForDocKey = (
  space: string,
  manager: EngineObjectManager,
  branch: string,
  key: QueryDocKey,
): EntitySnapshot | null => {
  if (!key.startsWith(`${space}/`)) {
    return null;
  }
  const { id, scope } = fromDocKey(key);
  const type = "application/json";
  const detail = manager.detail({ id, type, scope });
  const state = detail === undefined ? manager.readState(id, scope) : null;
  return {
    branch,
    id,
    ...(scope !== DEFAULT_SCOPE ? { scope } : {}),
    seq: detail?.seq ?? state?.seq ?? 0,
    document: detail?.document === undefined
      ? state?.document === null || state?.document === undefined
        ? null
        : state.document
      : detail.document,
  } satisfies EntitySnapshot;
};

const entitiesFromTracker = (
  space: string,
  tracker: MapSetStringToPathSelectors,
  manager: EngineObjectManager,
  branch: string,
): Map<QueryDocKey, EntitySnapshot> => {
  const entities = new Map<QueryDocKey, EntitySnapshot>();
  for (const [key] of tracker) {
    const snapshot = snapshotForDocKey(
      space,
      manager,
      branch,
      key as QueryDocKey,
    );
    if (snapshot !== null) {
      entities.set(key as QueryDocKey, snapshot);
    }
  }
  return entities;
};

export const trackGraph = (
  space: string,
  engine: Engine.Engine,
  query: GraphQuery,
  reuse?: QueryGraphReuseContext,
  options: TrackGraphOptions = {},
): {
  serverSeq: number;
  state: TrackedGraphState;
  stats: QueryTraversalStats;
} => {
  const branch = query.branch ?? "";
  const managerKey = options.readSeq === undefined
    ? `${branch}\0${options.principal ?? ""}\0${options.sessionId ?? ""}`
    : `${branch}\0${options.readSeq}\0${options.principal ?? ""}\0${
      options.sessionId ?? ""
    }`;
  let manager = reuse?.managers?.get(managerKey);
  if (manager === undefined) {
    manager = new EngineObjectManager(
      engine,
      branch,
      options.principal,
      options.sessionId,
      options.readSeq,
    );
    reuse?.managers?.set(managerKey, manager);
  }
  const tracker = new CompoundCycleTracker<
    FabricValue,
    JSONSchema | undefined
  >();
  const schemaTracker = new MapSetStringToPathSelectors(true);
  const traversalContext = createTraversalContext(
    tracker,
    schemaTracker,
    identityOf(manager),
    true,
  );
  const sharedMemo = createSchemaMemo();
  const stats = createQueryTraversalStats();
  const readCountBefore = manager.readCount;

  for (const root of query.roots) {
    const selector = toDocumentSelector(root.selector);
    const rootScope = root.scope ?? DEFAULT_SCOPE;
    const loaded = manager.load({
      id: root.id,
      scope: rootScope,
      type: "application/json",
    });
    if (loaded !== null) {
      loadFactsForDoc(
        manager,
        loaded,
        selector,
        traversalContext,
        space,
        sharedMemo,
        stats,
      );
    } else {
      schemaTracker.add(
        toDocKey(space, root.id, rootScope, identityOf(manager)),
        selector,
      );
    }
  }

  stats.managerReads = manager.readCount - readCountBefore;

  return {
    serverSeq: Engine.serverSeq(engine),
    state: {
      branch,
      tracker: schemaTracker,
      entities: entitiesFromTracker(
        space,
        schemaTracker,
        manager,
        branch,
      ),
      memo: sharedMemo,
      manager,
    },
    stats,
  };
};

export const extendTrackedGraph = (
  space: string,
  engine: Engine.Engine,
  state: TrackedGraphState,
  query: GraphQuery,
): {
  serverSeq: number;
  updates: Map<QueryDocKey, EntitySnapshot>;
  stats: QueryTraversalStats;
} => {
  const manager = state.manager;
  const stats = createQueryTraversalStats();
  const readCountBefore = manager.readCount;
  const previouslyLoaded = new Set(
    manager.loadedAddresses().map((address) =>
      `${address.scope}\0${address.id}`
    ),
  );
  const touched = new Set<QueryDocKey>();

  for (const root of query.roots) {
    const selector = toDocumentSelector(root.selector);
    const rootScope = root.scope ?? DEFAULT_SCOPE;
    const rootKey = toDocKey(
      space,
      root.id,
      rootScope,
      identityOf(manager),
    );
    touched.add(rootKey);
    evaluateTrackedDocument(
      space,
      manager,
      { id: root.id, scope: rootScope },
      selector,
      state.tracker,
      state.memo,
      stats,
    );
  }

  for (const address of manager.loadedAddresses()) {
    const key = `${address.scope}\0${address.id}`;
    if (previouslyLoaded.has(key)) {
      continue;
    }
    touched.add(
      toDocKey(space, address.id, address.scope, identityOf(manager)),
    );
  }

  const updates = new Map<QueryDocKey, EntitySnapshot>();
  for (const key of touched) {
    if (!state.tracker.has(key)) {
      continue;
    }
    const snapshot = snapshotForDocKey(
      space,
      manager,
      state.branch,
      key,
    );
    if (snapshot === null) {
      continue;
    }
    state.entities.set(key, snapshot);
    updates.set(key, snapshot);
  }

  stats.managerReads = manager.readCount - readCountBefore;

  return {
    serverSeq: Engine.serverSeq(engine),
    updates,
    stats,
  };
};

export const isGraphQueryCoveredByState = (
  space: string,
  state: TrackedGraphState,
  query: GraphQuery,
): boolean =>
  query.roots.every((root) => {
    const selector = toDocumentSelector(root.selector);
    const rootKey = toDocKey(
      space,
      root.id,
      root.scope ?? DEFAULT_SCOPE,
      identityOf(state.manager),
    );
    return schemaTrackerCoversSelector(state.tracker, rootKey, selector);
  });

export const queryGraph = (
  space: string,
  engine: Engine.Engine,
  query: GraphQuery,
  reuse?: QueryGraphReuseContext,
  options: TrackGraphOptions = {},
): {
  serverSeq: number;
  entities: EntitySnapshot[];
} => {
  const tracked = trackGraph(space, engine, query, reuse, {
    ...options,
    readSeq: query.atSeq,
  });
  return {
    serverSeq: tracked.serverSeq,
    entities: [...tracked.state.entities.values()]
      .toSorted((left, right) => left.id.localeCompare(right.id)),
  };
};

export const refreshTrackedGraph = (
  space: string,
  engine: Engine.Engine,
  state: TrackedGraphState,
  dirtyIds: ReadonlySet<string>,
): {
  serverSeq: number;
  updates: Map<QueryDocKey, EntitySnapshot>;
  stats: QueryTraversalStats;
} | null => {
  const affectedDocs = new Map<QueryDocKey, Set<SchemaPathSelector>>();
  const invalidations = new Map<CellScope, Set<string>>();
  const identity = identityOf(state.manager);
  for (const dirtyId of dirtyIds) {
    const { id, scope } = fromDirtyKey(dirtyId);
    let scopedIds = invalidations.get(scope);
    if (scopedIds === undefined) {
      scopedIds = new Set();
      invalidations.set(scope, scopedIds);
    }
    scopedIds.add(id);
    // Dirtiness arrives keyed by scope NAME (the M4 wake path — instance
    // keying of push is stage F). A scope this state's session holds no
    // identity for cannot have tracker entries — its loads throw for this
    // session — so there is no instance key to build; skip rather than
    // let the shared constructor throw on the watch path.
    if (!canResolveScopeKey(scope, identity)) {
      continue;
    }
    const key = toDocKey(space, id, scope, identity);
    const selectors = state.tracker.get(key);
    if (selectors !== undefined && selectors.size > 0) {
      affectedDocs.set(key, new Set(selectors));
    }
  }
  if (affectedDocs.size === 0) {
    return null;
  }

  const manager = new EngineObjectManager(
    engine,
    state.branch,
    state.manager.principal,
    state.manager.sessionId,
  );
  const sharedMemo = createSchemaMemo();
  const stats = createQueryTraversalStats();
  const readCountBefore = manager.readCount;

  for (const key of affectedDocs.keys()) {
    state.tracker.delete(key);
  }

  for (const [key, selectors] of affectedDocs) {
    const { id, scope } = fromDocKey(key);
    for (const selector of selectors) {
      evaluateTrackedDocument(
        space,
        manager,
        { id, scope },
        selector,
        state.tracker,
        sharedMemo,
        stats,
      );
    }
  }

  const touched = new Set<QueryDocKey>(affectedDocs.keys());
  for (const address of manager.loadedAddresses()) {
    const key = toDocKey(space, address.id, address.scope, identity);
    const previous = state.entities.get(key);
    const detail = manager.detail({ id: address.id, scope: address.scope });
    if (previous !== undefined && detail?.seq === previous.seq) {
      continue;
    }
    touched.add(key);
  }

  const updates = new Map<QueryDocKey, EntitySnapshot>();
  for (const key of touched) {
    if (!state.tracker.has(key)) {
      continue;
    }
    const snapshot = snapshotForDocKey(
      space,
      manager,
      state.branch,
      key,
    );
    if (snapshot === null) {
      continue;
    }
    state.entities.set(key, snapshot);
    updates.set(key, snapshot);
  }

  for (const [scope, ids] of invalidations) {
    state.manager.invalidateIds(ids, scope);
  }
  state.manager.mergeFrom(manager);

  stats.managerReads = manager.readCount - readCountBefore;

  return {
    serverSeq: Engine.serverSeq(engine),
    updates,
    stats,
  };
};

const loadFactsForDoc = (
  manager: EngineObjectManager,
  fact: IAttestation,
  selector: SchemaPathSelector,
  traversalContext: TraversalContext,
  space: string,
  sharedMemo: ReturnType<typeof createSchemaMemo>,
  stats: QueryTraversalStats,
) => {
  if (selector.schema === undefined) {
    selector = { ...selector, schema: false };
  }

  const docKey = toDocKey(
    space,
    fact.address.id,
    fact.address.scope ?? DEFAULT_SCOPE,
    identityOf(manager),
  );
  const internedSelector = internPathSelector(selector);
  if (
    schemaTrackerCoversSelector(
      traversalContext.schemaTracker,
      docKey,
      internedSelector,
    )
  ) {
    stats.coveredSelectorSkips++;
    return;
  }
  traversalContext.schemaTracker.add(docKey, internedSelector);

  if (!isObjectNotArray(fact.value)) {
    return;
  }

  const tx = new ExtendedStorageTransaction(
    new ManagedStorageTransaction({
      load(address) {
        return manager.load(address);
      },
    }),
  );
  const document = fact.value as { value: FabricValue };
  const factValue: IMemorySpaceValueAttestation = {
    address: { ...fact.address, space: space as MemorySpace, path: ["value"] },
    value: document.value,
  };
  const [nextDoc, nextSelector] = getAtPath(
    tx,
    factValue,
    selector.path.slice(1),
    traversalContext,
    selector,
  );
  if (
    nextDoc.value !== undefined &&
    nextSelector !== undefined &&
    nextSelector.schema !== false
  ) {
    const traverser = new SchemaObjectTraverser(
      tx,
      nextSelector,
      traversalContext,
      undefined,
      sharedMemo,
    );
    traverser.traverse(nextDoc);
    addTraverserStats(stats, traverser);
  }

  loadMetaLinkedDocs(
    tx,
    {
      address: { ...fact.address, space: space as MemorySpace },
      value: fact.value,
    },
    traversalContext,
  );
};

const evaluateTrackedDocument = (
  space: string,
  manager: EngineObjectManager,
  address: { id: string; scope?: CellScope },
  selector: SchemaPathSelector,
  schemaTracker: MapSetStringToPathSelectors,
  sharedMemo: ReturnType<typeof createSchemaMemo>,
  stats: QueryTraversalStats,
) => {
  const loaded = manager.load(address);
  if (loaded === null || loaded.value === undefined) {
    schemaTracker.add(
      toDocKey(
        space,
        address.id,
        address.scope ?? DEFAULT_SCOPE,
        identityOf(manager),
      ),
      internPathSelector(selector),
    );
    return;
  }
  const tracker = new CompoundCycleTracker<
    FabricValue,
    JSONSchema | undefined
  >();
  const traversalContext = createTraversalContext(
    tracker,
    schemaTracker,
    identityOf(manager),
    true,
  );
  loadFactsForDoc(
    manager,
    loaded,
    selector,
    traversalContext,
    space,
    sharedMemo,
    stats,
  );
};

export const toDocKey = (
  space: string,
  id: string,
  scope: CellScope = DEFAULT_SCOPE,
  identity: ScopeKeyIdentity,
): QueryDocKey => `${space}/${resolveScopeKey(scope, identity)}/${id}`;

export const fromDocKey = (key: QueryDocKey): {
  space: string;
  id: string;
  scope: CellScope;
} => {
  // Scope-key segments never contain "/" (their parts are
  // encodeURIComponent-encoded), so the three-way split is exact; the
  // scope NAME is recovered from the instance key because readers resolve
  // rows by (scope, session identity) as before.
  const parts = key.split("/");
  if (parts.length === 3) {
    const [space, scopeKey, id] = parts;
    if (isScopeKey(scopeKey)) {
      return { space, scope: scopeOfScopeKey(scopeKey), id };
    }
  }
  throw new Error(`invalid memory v2 query doc key: ${key}`);
};

export const toDirtyKey = (
  id: string,
  scope: CellScope = DEFAULT_SCOPE,
): string => `${scope}\0${id}`;

export const fromDirtyKey = (
  key: string,
): { id: string; scope: CellScope } => {
  const separator = key.indexOf("\0");
  if (separator > 0) {
    const scope = key.slice(0, separator);
    if (scope === "space" || scope === "user" || scope === "session") {
      return { scope, id: key.slice(separator + 1) };
    }
  }
  throw new Error(`invalid memory v2 dirty key: ${key}`);
};
