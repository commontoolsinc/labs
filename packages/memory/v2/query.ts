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
import { isObject } from "@commonfabric/utils/types";
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

  /** The scope INSTANCE an address resolves to for this manager: the
   * explicit key where the caller named one (protocol.md §2's read row),
   * else the manager's own bound identity. Cache keys use it, so an
   * explicit foreign instance never collides with the manager's own
   * (partition-equal to the scope-name form at cardinality 1 —
   * key-vocabulary.md §2). */
  #scopeKeyFor(scope: CellScope, explicit?: ScopeKey): ScopeKey {
    return explicit ??
      resolveScopeKey(scope, {
        principal: this.principal,
        sessionId: this.sessionId,
      });
  }

  readState(
    id: string,
    scope: CellScope = DEFAULT_SCOPE,
    scopeKey?: ScopeKey,
  ): Engine.EntityState | null {
    return Engine.readState(this.engine, {
      id,
      scope,
      ...(scopeKey === undefined ? {} : { scopeKey }),
      principal: this.principal,
      sessionId: this.sessionId,
      branch: this.branch,
      ...(this.readSeq === undefined ? {} : { seq: this.readSeq }),
    });
  }

  load(
    address: {
      id: string;
      type?: string;
      scope?: CellScope;
      scopeKey?: ScopeKey;
    },
  ): IAttestation | null {
    const type = address.type ?? "application/json";
    const scope = address.scope ?? DEFAULT_SCOPE;
    const scopeKey = this.#scopeKeyFor(scope, address.scopeKey);
    const key = `${scopeKey}/${address.id}/${type}`;
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

    const state = this.readState(address.id, scope, scopeKey);
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

  detail(
    address: {
      id: string;
      type?: string;
      scope?: CellScope;
      scopeKey?: ScopeKey;
    },
  ) {
    const scope = address.scope ?? DEFAULT_SCOPE;
    return this.#details.get(
      `${this.#scopeKeyFor(scope, address.scopeKey)}/${address.id}/${
        address.type ?? "application/json"
      }`,
    );
  }

  get readCount(): number {
    return this.#readCount;
  }

  loadedAddresses(): Array<
    { id: string; type: string; scope: CellScope; scopeKey: ScopeKey }
  > {
    return [...this.#attestations.keys()].map((key) => {
      const [scopeKey, id, ...typeParts] = key.split("/");
      return {
        id,
        type: typeParts.join("/"),
        scope: scopeOfScopeKey(scopeKey),
        scopeKey: scopeKey as ScopeKey,
      };
    });
  }

  invalidateIds(ids: Iterable<string>, scope: CellScope = DEFAULT_SCOPE): void {
    // Own-instance invalidation: the manager caches under its own bound
    // identity's keys (plus explicitly named instances, which dirty
    // marking addresses by exact key through the same construction).
    const scopeKey = this.#scopeKeyFor(scope);
    for (const id of ids) {
      const key = `${scopeKey}/${id}/application/json`;
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
  const { id, scope, scopeKey } = fromDocKey(key);
  const type = "application/json";
  const detail = manager.detail({ id, type, scope, scopeKey });
  const state = detail === undefined
    ? manager.readState(id, scope, scopeKey)
    : null;
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

/** The tracked doc key for a query root: the explicit instance where the
 * root names one (protocol.md §2's read row), else the session identity's
 * own — one construction for track/extend/coverage so the three never
 * disagree on which instance a root means. */
const rootDocKey = (
  space: string,
  root: GraphQuery["roots"][number],
  identity: ScopeKeyIdentity,
): QueryDocKey =>
  root.entityScopeKey !== undefined
    ? `${space}/${root.entityScopeKey}/${root.id}`
    : toDocKey(space, root.id, root.scope ?? DEFAULT_SCOPE, identity);

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
    // A root naming an explicit instance (protocol.md §2's read row —
    // lease-holder only, admission enforced at the server layer) reads
    // and tracks THAT instance; traversal beyond the root resolves under
    // the session identity as today (per-run deep threading is the
    // Phase 2 fan-out work).
    const loaded = manager.load({
      id: root.id,
      scope: rootScope,
      ...(root.entityScopeKey === undefined
        ? {}
        : { scopeKey: root.entityScopeKey }),
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
        rootDocKey(space, root, identityOf(manager)),
      );
    } else {
      schemaTracker.add(
        rootDocKey(space, root, identityOf(manager)),
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
      `${address.scopeKey}\0${address.id}`
    ),
  );
  const touched = new Set<QueryDocKey>();

  for (const root of query.roots) {
    const selector = toDocumentSelector(root.selector);
    const rootScope = root.scope ?? DEFAULT_SCOPE;
    const rootKey = rootDocKey(space, root, identityOf(manager));
    touched.add(rootKey);
    evaluateTrackedDocument(
      space,
      manager,
      {
        id: root.id,
        scope: rootScope,
        ...(root.entityScopeKey === undefined
          ? {}
          : { scopeKey: root.entityScopeKey }),
      },
      selector,
      state.tracker,
      state.memo,
      stats,
    );
  }

  for (const address of manager.loadedAddresses()) {
    const key = `${address.scopeKey}\0${address.id}`;
    if (previouslyLoaded.has(key)) {
      continue;
    }
    touched.add(`${space}/${address.scopeKey}/${address.id}`);
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
    const rootKey = rootDocKey(space, root, identityOf(state.manager));
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
    // Dirtiness arrives keyed by scope INSTANCE (M4, stage F): the dirty
    // key's scope_key segment IS the tracked doc key's middle segment, so
    // the affected-tracker lookup is a direct join — no session-identity
    // re-resolution, and another principal's instance simply never
    // matches this state's tracker.
    const { id, scopeKey, scope } = fromDirtyKey(dirtyId);
    // The manager's read cache keys by (scope name, id) under its ONE
    // bound identity, so invalidate only dirtiness aimed at THIS
    // identity's own instance — a foreign instance was never cached here.
    if (
      canResolveScopeKey(scope, identity) &&
      resolveScopeKey(scope, identity) === scopeKey
    ) {
      let scopedIds = invalidations.get(scope);
      if (scopedIds === undefined) {
        scopedIds = new Set();
        invalidations.set(scope, scopedIds);
      }
      scopedIds.add(id);
    }
    const key: QueryDocKey = `${space}/${scopeKey}/${id}`;
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
    const { id, scope, scopeKey } = fromDocKey(key);
    for (const selector of selectors) {
      evaluateTrackedDocument(
        space,
        manager,
        { id, scope, scopeKey },
        selector,
        state.tracker,
        sharedMemo,
        stats,
      );
    }
  }

  const touched = new Set<QueryDocKey>(affectedDocs.keys());
  for (const address of manager.loadedAddresses()) {
    const key: QueryDocKey = `${space}/${address.scopeKey}/${address.id}`;
    const previous = state.entities.get(key);
    const detail = manager.detail({
      id: address.id,
      scope: address.scope,
      scopeKey: address.scopeKey,
    });
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
  explicitDocKey?: QueryDocKey,
) => {
  if (selector.schema === undefined) {
    selector = { ...selector, schema: false };
  }

  const docKey = explicitDocKey ?? toDocKey(
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

  if (!isObject(fact.value)) {
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
  address: { id: string; scope?: CellScope; scopeKey?: ScopeKey },
  selector: SchemaPathSelector,
  schemaTracker: MapSetStringToPathSelectors,
  sharedMemo: ReturnType<typeof createSchemaMemo>,
  stats: QueryTraversalStats,
) => {
  const docKey: QueryDocKey = address.scopeKey !== undefined
    ? `${space}/${address.scopeKey}/${address.id}`
    : toDocKey(
      space,
      address.id,
      address.scope ?? DEFAULT_SCOPE,
      identityOf(manager),
    );
  const loaded = manager.load(address);
  if (loaded === null || loaded.value === undefined) {
    schemaTracker.add(docKey, internPathSelector(selector));
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
    docKey,
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
  scopeKey: ScopeKey;
} => {
  // Scope-key segments never contain "/" (their parts are
  // encodeURIComponent-encoded), so the three-way split is exact; the
  // scope NAME is recovered from the instance key because readers resolve
  // rows by (scope, session identity) as before. The instance key itself
  // is returned too: the M4/M1 paths (stage F) address rows by exact
  // instance rather than re-resolving from the session.
  const parts = key.split("/");
  if (parts.length === 3) {
    const [space, scopeKey, id] = parts;
    if (isScopeKey(scopeKey)) {
      return { space, scope: scopeOfScopeKey(scopeKey), scopeKey, id };
    }
  }
  throw new Error(`invalid memory v2 query doc key: ${key}`);
};

/**
 * Wake/sync dirty keys are per scope INSTANCE (scopes.md §7 M4, stage F):
 * `${scope_key}\0${id}`, the same shared vocabulary storage rows and
 * query doc keys use. Dirtiness and delivery both key by scope_key, so a
 * commit to one principal's instance touches only the sessions tracking
 * THAT instance (protocol.md §3) — the scope-NAME form collapsed every
 * principal's instances onto one key, quadratic waste once one server
 * hosts every instance. At cardinality 1 per session the re-keyed form
 * partitions exactly as the name form did (key-vocabulary.md §2).
 */
export const toDirtyKey = (
  id: string,
  scopeKey: ScopeKey = "space",
): string => `${scopeKey}\0${id}`;

export const fromDirtyKey = (
  key: string,
): { id: string; scopeKey: ScopeKey; scope: CellScope } => {
  const separator = key.indexOf("\0");
  if (separator > 0) {
    const scopeKey = key.slice(0, separator);
    if (isScopeKey(scopeKey)) {
      return {
        scopeKey,
        scope: scopeOfScopeKey(scopeKey),
        id: key.slice(separator + 1),
      };
    }
  }
  throw new Error(`invalid memory v2 dirty key: ${key}`);
};
