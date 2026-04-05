import {
  CompoundCycleTracker,
  createSchemaMemo,
  getAtPath,
  type IAttestation,
  type IMemorySpaceValueAttestation,
  loadSource,
  ManagedStorageTransaction,
  MapSetStringToPathSelectors,
  type ObjectStorageManager,
  SchemaObjectTraverser,
  type SchemaPathSelector,
} from "@commonfabric/runner/traverse";
import type { JSONSchema } from "../../runner/src/builder/types.ts";
import { ExtendedStorageTransaction } from "../../runner/src/storage/extended-storage-transaction.ts";
import { ContextualFlowControl } from "../../runner/src/cfc.ts";
import { type Immutable, isObject } from "@commonfabric/utils/types";
import type { FabricValue, MemorySpace, URI } from "../interface.ts";
import {
  type EntitySnapshot,
  type GraphQuery,
  toDocumentSelector,
} from "../v2.ts";
import * as Engine from "./engine.ts";

export type QueryDocKey = `${string}/${string}/${string}`;

export interface TrackedGraphState {
  branch: string;
  tracker: MapSetStringToPathSelectors;
  entities: Map<QueryDocKey, EntitySnapshot>;
  memo: ReturnType<typeof createSchemaMemo>;
  manager: EngineObjectManager;
}

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
    private readonly readSeq?: number,
  ) {}

  readState(id: string): Engine.EntityState | null {
    return Engine.readState(this.engine, {
      id,
      branch: this.branch,
      ...(this.readSeq === undefined ? {} : { seq: this.readSeq }),
    });
  }

  load(address: { id: string; type: string }): IAttestation | null {
    const key = `${address.id}/${address.type}`;
    if (this.#attestations.has(key)) {
      return this.#attestations.get(key)!;
    }
    if (this.#missing.has(key)) {
      return null;
    }
    if (address.type !== "application/json") {
      this.#missing.add(key);
      return null;
    }

    const state = this.readState(address.id);
    this.#readCount++;
    if (state === null || state.document === null) {
      this.#missing.add(key);
      return null;
    }

    const attestation: IAttestation = {
      address: {
        id: address.id as URI,
        type: address.type,
        path: [],
      },
      value: state.document as unknown as Immutable<FabricValue>,
    };
    this.#attestations.set(key, attestation);
    this.#details.set(key, {
      seq: state.seq,
      document: state.document,
    });
    return attestation;
  }

  detail(address: { id: string; type: string }) {
    return this.#details.get(`${address.id}/${address.type}`);
  }

  get readCount(): number {
    return this.#readCount;
  }

  loadedAddresses(): Array<{ id: string; type: string }> {
    return [...this.#attestations.values()].map((attestation) => ({
      id: attestation.address.id,
      type: attestation.address.type,
    }));
  }

  invalidateIds(ids: Iterable<string>): void {
    for (const id of ids) {
      const key = `${id}/application/json`;
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

export interface QueryGraphReuseContext {
  managers?: Map<string, EngineObjectManager>;
}

export interface TrackGraphOptions {
  readSeq?: number;
}

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

  const manager = new EngineObjectManager(engine, state.branch);
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
  const { id, type } = fromDocKey(key);
  if (type !== "application/json") {
    return null;
  }
  const detail = manager.detail({ id, type });
  const state = detail === undefined ? manager.readState(id) : null;
  return {
    branch,
    id,
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
} => {
  const branch = query.branch ?? "";
  const managerKey = options.readSeq === undefined
    ? branch
    : `${branch}\0${options.readSeq}`;
  let manager = reuse?.managers?.get(managerKey);
  if (manager === undefined) {
    manager = new EngineObjectManager(engine, branch, options.readSeq);
    reuse?.managers?.set(managerKey, manager);
  }
  const tracker = new CompoundCycleTracker<
    Immutable<FabricValue>,
    JSONSchema | undefined
  >();
  const schemaTracker = new MapSetStringToPathSelectors(true);
  const cfc = new ContextualFlowControl();
  const sharedMemo = createSchemaMemo();

  for (const root of query.roots) {
    const selector = toDocumentSelector(root.selector);
    const loaded = manager.load({ id: root.id, type: "application/json" });
    if (loaded !== null) {
      loadFactsForDoc(
        manager,
        loaded,
        selector,
        tracker,
        cfc,
        space,
        schemaTracker,
        sharedMemo,
      );
    } else {
      schemaTracker.add(toDocKey(space, root.id, "application/json"), selector);
    }
  }

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
} => {
  const manager = state.manager;
  const previouslyLoaded = new Set(
    manager.loadedAddresses().map((address) => `${address.id}/${address.type}`),
  );
  const touched = new Set<QueryDocKey>();

  for (const root of query.roots) {
    const selector = toDocumentSelector(root.selector);
    const rootKey = toDocKey(space, root.id, "application/json");
    touched.add(rootKey);
    evaluateTrackedDocument(
      space,
      manager,
      { id: root.id, type: "application/json" },
      selector,
      state.tracker,
      state.memo,
    );
  }

  for (const address of manager.loadedAddresses()) {
    const key = `${address.id}/${address.type}`;
    if (previouslyLoaded.has(key)) {
      continue;
    }
    if (address.type === "application/json") {
      touched.add(toDocKey(space, address.id, address.type));
    }
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

  return {
    serverSeq: Engine.serverSeq(engine),
    updates,
  };
};

export const queryGraph = (
  space: string,
  engine: Engine.Engine,
  query: GraphQuery,
  reuse?: QueryGraphReuseContext,
): {
  serverSeq: number;
  entities: EntitySnapshot[];
} => {
  const tracked = trackGraph(space, engine, query, reuse, {
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
} | null => {
  const affectedDocs = new Map<QueryDocKey, Set<SchemaPathSelector>>();
  for (const dirtyId of dirtyIds) {
    const key = toDocKey(space, dirtyId, "application/json");
    const selectors = state.tracker.get(key);
    if (selectors !== undefined && selectors.size > 0) {
      affectedDocs.set(key, new Set(selectors));
    }
  }
  if (affectedDocs.size === 0) {
    return null;
  }

  const manager = new EngineObjectManager(engine, state.branch);
  const sharedMemo = createSchemaMemo();

  for (const key of affectedDocs.keys()) {
    state.tracker.delete(key);
  }

  for (const [key, selectors] of affectedDocs) {
    const { id, type } = fromDocKey(key);
    for (const selector of selectors) {
      evaluateTrackedDocument(
        space,
        manager,
        { id, type },
        selector,
        state.tracker,
        sharedMemo,
      );
    }
  }

  const touched = new Set<QueryDocKey>(affectedDocs.keys());
  for (const address of manager.loadedAddresses()) {
    if (address.type === "application/json") {
      touched.add(toDocKey(space, address.id, address.type));
    }
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

  state.manager.invalidateIds(dirtyIds);
  state.manager.mergeFrom(manager);

  return {
    serverSeq: Engine.serverSeq(engine),
    updates,
  };
};

const loadFactsForDoc = (
  manager: EngineObjectManager,
  fact: IAttestation,
  selector: SchemaPathSelector,
  tracker: CompoundCycleTracker<
    Immutable<FabricValue>,
    JSONSchema | undefined
  >,
  cfc: ContextualFlowControl,
  space: string,
  schemaTracker: MapSetStringToPathSelectors,
  sharedMemo: ReturnType<typeof createSchemaMemo>,
) => {
  if (selector.schema === undefined) {
    selector = { ...selector, schema: false };
  }

  const docKey = toDocKey(space, fact.address.id, fact.address.type);
  if (schemaTracker.hasValue(docKey, selector)) {
    return;
  }
  schemaTracker.add(docKey, selector);

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
    tracker,
    cfc,
    schemaTracker,
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
      tracker,
      schemaTracker,
      cfc,
      undefined,
      undefined,
      sharedMemo,
    );
    traverser.traverse(nextDoc);
  }

  loadSource(
    tx,
    {
      address: { ...fact.address, space: space as MemorySpace },
      value: fact.value,
    },
    new Set<string>(),
    schemaTracker,
  );
};

const evaluateTrackedDocument = (
  space: string,
  manager: EngineObjectManager,
  address: { id: string; type: string },
  selector: SchemaPathSelector,
  schemaTracker: MapSetStringToPathSelectors,
  sharedMemo: ReturnType<typeof createSchemaMemo>,
) => {
  const loaded = manager.load(address);
  if (loaded === null || loaded.value === undefined) {
    schemaTracker.add(toDocKey(space, address.id, address.type), selector);
    return;
  }
  const tracker = new CompoundCycleTracker<
    Immutable<FabricValue>,
    JSONSchema | undefined
  >();
  const cfc = new ContextualFlowControl();
  loadFactsForDoc(
    manager,
    loaded,
    selector,
    tracker,
    cfc,
    space,
    schemaTracker,
    sharedMemo,
  );
};

export const toDocKey = (
  space: string,
  id: string,
  type: string,
): QueryDocKey => `${space}/${id}/${type}`;

export const fromDocKey = (key: QueryDocKey) => {
  const match = /^([^/]+)\/(.+)\/application\/json$/.exec(key);
  if (match !== null) {
    const [, space, id] = match;
    return { space, id, type: "application/json" };
  }
  const [space, id, type] = key.split("/", 3);
  return { space, id, type };
};
