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
} from "@commontools/runner/traverse";
import { ExtendedStorageTransaction } from "../../runner/src/storage/extended-storage-transaction.ts";
import { ContextualFlowControl } from "../../runner/src/cfc.ts";
import { type Immutable, isObject } from "@commontools/utils/types";
import type { MemorySpace, StorableDatum, URI } from "../interface.ts";
import {
  encodeWireEntityDocument,
  type EntitySnapshot,
  type GraphQuery,
} from "../v2.ts";
import * as Engine from "./engine.ts";

export type QueryDocKey = `${string}/${string}/${string}`;

export interface TrackedGraphState {
  branch: string;
  tracker: MapSetStringToPathSelectors;
  entities: Map<QueryDocKey, EntitySnapshot>;
}

export class EngineObjectManager implements ObjectStorageManager {
  #attestations = new Map<string, IAttestation>();
  #details = new Map<string, {
    seq: number;
    document: NonNullable<Engine.EntityState["document"]>;
  }>();
  #missing = new Set<string>();

  constructor(
    private readonly engine: Engine.Engine,
    private readonly branch: string,
  ) {}

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

    const state = Engine.readState(this.engine, {
      id: address.id,
      branch: this.branch,
    });
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
      value: state.document as unknown as Immutable<StorableDatum>,
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

  loadedAddresses(): Array<{ id: string; type: string }> {
    return [...this.#attestations.values()].map((attestation) => ({
      id: attestation.address.id,
      type: attestation.address.type,
    }));
  }
}

export interface QueryGraphReuseContext {
  managers?: Map<string, EngineObjectManager>;
}

const snapshotForDocKey = (
  space: string,
  engine: Engine.Engine,
  branch: string,
  manager: EngineObjectManager,
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
  const state = detail === undefined
    ? Engine.readState(engine, {
      id,
      branch,
    })
    : null;
  return {
    branch,
    id,
    seq: detail?.seq ?? state?.seq ?? 0,
    document: detail?.document === undefined
      ? state?.document === null || state?.document === undefined
        ? null
        : encodeWireEntityDocument(state.document)
      : encodeWireEntityDocument(detail.document),
  } satisfies EntitySnapshot;
};

const entitiesFromTracker = (
  space: string,
  engine: Engine.Engine,
  branch: string,
  tracker: MapSetStringToPathSelectors,
  manager: EngineObjectManager,
): Map<QueryDocKey, EntitySnapshot> => {
  const entities = new Map<QueryDocKey, EntitySnapshot>();
  for (const [key] of tracker) {
    const snapshot = snapshotForDocKey(
      space,
      engine,
      branch,
      manager,
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
): {
  serverSeq: number;
  state: TrackedGraphState;
} => {
  const branch = query.branch ?? "";
  let manager = reuse?.managers?.get(branch);
  if (manager === undefined) {
    manager = new EngineObjectManager(engine, branch);
    reuse?.managers?.set(branch, manager);
  }
  const tracker = new CompoundCycleTracker<
    Immutable<StorableDatum>,
    unknown
  >();
  const schemaTracker = new MapSetStringToPathSelectors(true);
  const cfc = new ContextualFlowControl();
  const sharedMemo = createSchemaMemo();

  for (const root of query.roots) {
    const selector: SchemaPathSelector = {
      path: ["value", ...root.selector.path],
      schema: root.selector.schema ?? false,
    };
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
        engine,
        branch,
        schemaTracker,
        manager,
      ),
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
  const manager = new EngineObjectManager(engine, state.branch);
  const sharedMemo = createSchemaMemo();
  const touched = new Set<QueryDocKey>();

  for (const root of query.roots) {
    const selector: SchemaPathSelector = {
      path: ["value", ...root.selector.path],
      schema: root.selector.schema ?? false,
    };
    const rootKey = toDocKey(space, root.id, "application/json");
    touched.add(rootKey);
    evaluateTrackedDocument(
      space,
      manager,
      { id: root.id, type: "application/json" },
      selector,
      state.tracker,
      sharedMemo,
    );
  }

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
      engine,
      state.branch,
      manager,
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
  const tracked = trackGraph(space, engine, query, reuse);
  return {
    serverSeq: tracked.serverSeq,
    entities: [...tracked.state.entities.values()].toSorted((left, right) =>
      left.id.localeCompare(right.id)
    ),
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
      engine,
      state.branch,
      manager,
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

const loadFactsForDoc = (
  manager: EngineObjectManager,
  fact: IAttestation,
  selector: SchemaPathSelector,
  tracker: CompoundCycleTracker<Immutable<StorableDatum>, unknown>,
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
  const document = fact.value as { value: StorableDatum };
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
    Immutable<StorableDatum>,
    unknown
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
