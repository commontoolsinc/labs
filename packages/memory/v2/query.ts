import type { FabricValue } from "@commonfabric/api";
import {
  internPathSelector,
  REJECTING_SELECTOR,
} from "@commonfabric/data-model/schema-utils";
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
import { isObjectNotArray } from "@commonfabric/utils/types";

import type { JSONSchema } from "../../runner/src/builder/types.ts";
import { ExtendedStorageTransaction } from "../../runner/src/storage/extended-storage-transaction.ts";
import { collectExternalSchemaRefHashes } from "../../runner/src/schema-decompose.ts";
import {
  lookupSchemaDocument,
  registerSchemaDocument,
} from "../../runner/src/schema-registry.ts";
import { isSubschema } from "../../runner/src/schema-walk.ts";
import { internSchemaAsTaggedHashString } from "@commonfabric/data-model/schema-hash";
import type { MemorySpace, MIME, URI } from "../interface.ts";
import { mapLinkSchemas } from "./schema-table-links.ts";
import {
  type CellScope,
  type EntitySnapshot,
  type GraphQuery,
  toDocumentSelector,
} from "../v2.ts";
import * as Engine from "./engine.ts";

const DEFAULT_SCOPE: CellScope = "space";

export type QueryDocKey = `${string}/${CellScope}/${string}`;

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
  const tracker = state.tracker.clone();

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

// Per-version cache of document scans for embedded schema refs, so a
// version delivered again — by another session, query, or refresh — is
// not rescanned. Only canonical `"space"`-scoped snapshots are cached: a
// user- or session-scoped doc key names different content per principal,
// and sharing scans across principals could hand one principal's refs to
// another. Bounded; on overflow the cache clears and repopulates from
// live deliveries.
const SCHEMA_REF_SCAN_CACHE_MAX_ENTRIES = 4096;
const schemaRefScanCaches = new WeakMap<
  Engine.Engine,
  Map<QueryDocKey, { seq: number; refs: ReadonlySet<string> }>
>();

// Per-version record of schema documents that verified in this engine's
// store (`docKey -> seq`), so revalidating an established delivery state
// costs one map lookup per unchanged document. A version change drops the
// entry's usefulness by construction (the seq comparison fails).
const verifiedSchemaDocCaches = new WeakMap<
  Engine.Engine,
  Map<QueryDocKey, number>
>();

const EMPTY_SCHEMA_REFS: ReadonlySet<string> = new Set();

/**
 * The external schema-ref hashes a delivered document carries. For a
 * delivered schema document — decided by content-addressed identity,
 * since `cid:` also holds blobs: a document is a schema document exactly
 * when its id is the schema interning of its value — the document's own
 * hash is the single ref, and the closure walk verifies it and follows
 * its refs; its value is not link-scanned, because schema keywords such
 * as `default` may carry link-shaped DATA that is not a link position.
 * Every other document is scanned for link schemas anywhere in its value.
 */
const scanSnapshotSchemaRefs = (
  engine: Engine.Engine,
  key: QueryDocKey,
  snapshot: EntitySnapshot,
): ReadonlySet<string> => {
  const cacheable = (snapshot.scope ?? DEFAULT_SCOPE) === DEFAULT_SCOPE;
  let cache = schemaRefScanCaches.get(engine);
  if (cache === undefined) {
    cache = new Map();
    schemaRefScanCaches.set(engine, cache);
  }
  if (cacheable) {
    const cached = cache.get(key);
    if (cached !== undefined && cached.seq === snapshot.seq) {
      return cached.refs;
    }
  }
  const refs = new Set<string>();
  const doc = snapshot.document;
  if (isObjectNotArray(doc)) {
    const { id } = fromDocKey(key);
    let isSchemaDocument = false;
    if (id.startsWith("cid:")) {
      const hash = id.slice("cid:".length);
      const inner = (doc as { value?: unknown }).value;
      if (
        isSubschema(inner) &&
        internSchemaAsTaggedHashString(inner as JSONSchema) === hash
      ) {
        isSchemaDocument = true;
        refs.add(hash);
      }
    }
    if (!isSchemaDocument) {
      mapLinkSchemas(doc as FabricValue, (schema) => {
        for (
          const hash of collectExternalSchemaRefHashes(schema as JSONSchema)
        ) {
          refs.add(hash);
        }
        return schema;
      });
    }
  }
  const result = refs.size === 0 ? EMPTY_SCHEMA_REFS : refs;
  if (cacheable) {
    if (cache.size >= SCHEMA_REF_SCAN_CACHE_MAX_ENTRIES) cache.clear();
    cache.set(key, { seq: snapshot.seq, refs: result });
  }
  return result;
};

/**
 * Thrown when a query result's schema-document closure cannot be
 * assembled from the delivering space's own store: a referenced document
 * is missing, or its stored content does not hash to its id. The commit
 * boundary makes `cid:` documents immutable, so this is database
 * corruption, not a transient condition. Like every query/watch
 * evaluation exception, it closes the affected connection at the
 * server's evaluation boundary; reconnection reinstalls fresh state, and
 * a still-corrupt store fails loudly again.
 */
export class SchemaClosureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SchemaClosureError";
  }
}

/**
 * The read-side delivery guarantee, enforced at the result-assembly
 * boundary: every schema reference embedded in the documents being
 * delivered — a link schema anywhere in a document's value, or a delivered
 * schema document's own refs — must resolve to a verified schema document
 * in this space, and the whole closure joins the delivered set and the
 * watch set. A missing or forged closure document fails the query loudly
 * ({@link SchemaClosureError}): the write-side guarantee installs closures
 * with their referrers, so a hole is a consistency bug to surface, never
 * to repair around.
 *
 * Two-phase: the walk verifies everything into staging and returns the
 * tracker keys and snapshots to add — the caller commits them only after
 * the whole closure verified, so the walk itself mutates nothing. A
 * refresh caller whose traversal already advanced its tracker relies on
 * session termination instead: the failed session's graph state is
 * discarded whole. `established` extends validation over previously
 * delivered snapshots (a refresh): a corrupted dependency fails the
 * refresh even when its referrer did not change, and the per-version scan
 * and verification caches make an unchanged established set cost map
 * lookups.
 *
 * Verification is against THIS space's stored content — a verified copy in
 * the realm registry never stands in for the space's own (the
 * space-boundary rule in `docs/specs/content-addressed-schemas.md`).
 */
const assembleSchemaDocClosures = (
  space: string,
  engine: Engine.Engine,
  manager: EngineObjectManager,
  branch: string,
  tracker: MapSetStringToPathSelectors,
  delivered: ReadonlyMap<QueryDocKey, EntitySnapshot>,
  established?: ReadonlyMap<QueryDocKey, EntitySnapshot>,
): {
  trackerAdds: QueryDocKey[];
  additions: Map<QueryDocKey, EntitySnapshot>;
} => {
  const pending: string[] = [];
  const seen = new Set<string>();
  const enqueue = (hash: string) => {
    if (!seen.has(hash)) {
      seen.add(hash);
      pending.push(hash);
    }
  };
  for (const [key, snapshot] of delivered) {
    for (const hash of scanSnapshotSchemaRefs(engine, key, snapshot)) {
      enqueue(hash);
    }
  }
  if (established !== undefined) {
    for (const [key, snapshot] of established) {
      if (delivered.has(key)) continue;
      for (const hash of scanSnapshotSchemaRefs(engine, key, snapshot)) {
        enqueue(hash);
      }
    }
  }
  let verified = verifiedSchemaDocCaches.get(engine);
  if (verified === undefined) {
    verified = new Map();
    verifiedSchemaDocCaches.set(engine, verified);
  }
  const trackerAdds: QueryDocKey[] = [];
  const additions = new Map<QueryDocKey, EntitySnapshot>();
  while (pending.length > 0) {
    const hash = pending.pop()!;
    const id = `cid:${hash}`;
    const key = toDocKey(space, id, DEFAULT_SCOPE);
    manager.load({ id, scope: DEFAULT_SCOPE, type: "application/json" });
    const snapshot = snapshotForDocKey(space, manager, branch, key);
    const doc = snapshot?.document;
    const inner = isObjectNotArray(doc)
      ? (doc as { value?: unknown }).value
      : undefined;
    if (snapshot === null || inner === undefined) {
      throw new SchemaClosureError(
        `Query result requires schema document ${id}, which is not stored ` +
          `in this space. Every embedded schema ref must resolve within ` +
          `the delivered set (docs/specs/content-addressed-schemas.md).`,
      );
    }
    // This exact version verified here before: skip re-hashing, but keep
    // the registry entry warm (a registry clear may have dropped it).
    let registered = verified.get(key) === snapshot.seq
      ? lookupSchemaDocument(hash)
      : undefined;
    if (registered === undefined) {
      try {
        registered = registerSchemaDocument(hash, inner as JSONSchema);
      } catch {
        throw new SchemaClosureError(
          `Schema document ${id} did not verify in this space: its stored ` +
            `content does not hash to its id.`,
        );
      }
      if (verified.size >= SCHEMA_REF_SCAN_CACHE_MAX_ENTRIES) verified.clear();
      verified.set(key, snapshot.seq);
    }
    for (const dep of collectExternalSchemaRefHashes(registered)) {
      enqueue(dep);
    }
    if (!tracker.has(key)) {
      trackerAdds.push(key);
      if (!delivered.has(key)) {
        additions.set(key, snapshot);
      }
    }
  }
  return { trackerAdds, additions };
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
        toDocKey(space, root.id, rootScope),
        selector,
      );
    }
  }

  const entities = entitiesFromTracker(space, schemaTracker, manager, branch);
  const staged = assembleSchemaDocClosures(
    space,
    engine,
    manager,
    branch,
    schemaTracker,
    entities,
  );
  for (const key of staged.trackerAdds) {
    schemaTracker.add(key, REJECTING_SELECTOR);
  }
  for (const [key, snapshot] of staged.additions) {
    entities.set(key, snapshot);
  }

  stats.managerReads = manager.readCount - readCountBefore;

  return {
    serverSeq: Engine.serverSeq(engine),
    state: {
      branch,
      tracker: schemaTracker,
      entities,
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
    touched.add(toDocKey(space, address.id, address.scope));
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
    updates.set(key, snapshot);
  }

  // Assembly validates before anything commits to `state.entities`; the
  // caller stages the whole graph state (`cloneTrackedGraphState`), which
  // covers the tracker mutations the traversal above already made.
  const staged = assembleSchemaDocClosures(
    space,
    engine,
    manager,
    state.branch,
    state.tracker,
    updates,
  );
  for (const key of staged.trackerAdds) {
    state.tracker.add(key, REJECTING_SELECTOR);
  }
  for (const [key, snapshot] of staged.additions) {
    updates.set(key, snapshot);
  }
  for (const [key, snapshot] of updates) {
    state.entities.set(key, snapshot);
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
    const rootKey = toDocKey(space, root.id, root.scope ?? DEFAULT_SCOPE);
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
  for (const dirtyId of dirtyIds) {
    const { id, scope } = fromDirtyKey(dirtyId);
    let scopedIds = invalidations.get(scope);
    if (scopedIds === undefined) {
      scopedIds = new Set();
      invalidations.set(scope, scopedIds);
    }
    scopedIds.add(id);
    const key = toDocKey(space, id, scope);
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
    const key = toDocKey(space, address.id, address.scope);
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
    updates.set(key, snapshot);
  }

  // `established` extends validation over the whole previously delivered
  // state, so a corrupted dependency fails the refresh even when its
  // referrer did not change. A throw here corrupts nothing durable: the
  // caller terminates the session and discards its graph state whole,
  // partial tracker advances included.
  const staged = assembleSchemaDocClosures(
    space,
    engine,
    manager,
    state.branch,
    state.tracker,
    updates,
    state.entities,
  );
  for (const key of staged.trackerAdds) {
    state.tracker.add(key, REJECTING_SELECTOR);
  }
  for (const [key, snapshot] of staged.additions) {
    updates.set(key, snapshot);
  }

  for (const [key, snapshot] of updates) {
    state.entities.set(key, snapshot);
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
      toDocKey(space, address.id, address.scope ?? DEFAULT_SCOPE),
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
): QueryDocKey => `${space}/${scope}/${id}`;

export const fromDocKey = (key: QueryDocKey): {
  space: string;
  id: string;
  scope: CellScope;
} => {
  const parts = key.split("/");
  if (parts.length === 3) {
    const [space, scope, id] = parts;
    if (scope === "space" || scope === "user" || scope === "session") {
      return { space, scope, id };
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
