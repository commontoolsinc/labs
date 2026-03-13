import {
  CompoundCycleTracker,
  createSchemaMemo,
  getAtPath,
  type IAttestation,
  type IMemorySpaceValueAttestation,
  loadSource,
  ManagedStorageTransaction,
  MapSet,
  type ObjectStorageManager,
  SchemaObjectTraverser,
  type SchemaPathSelector,
} from "@commontools/runner/traverse";
import { ExtendedStorageTransaction } from "../../runner/src/storage/extended-storage-transaction.ts";
import { ContextualFlowControl } from "../../runner/src/cfc.ts";
import { type Immutable, isObject } from "@commontools/utils/types";
import type { MemorySpace, StorableDatum, URI } from "../interface.ts";
import type { EntitySnapshot, GraphQuery, Reference } from "../v2.ts";
import * as Engine from "./engine.ts";

type QueryDocKey = `${string}/${string}/${string}`;

class EngineObjectManager implements ObjectStorageManager {
  #attestations = new Map<string, IAttestation>();
  #details = new Map<string, { seq: number; hash: Reference }>();
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
    this.#details.set(key, { seq: state.seq, hash: state.hash });
    return attestation;
  }

  detail(address: { id: string; type: string }) {
    return this.#details.get(`${address.id}/${address.type}`);
  }
}

export const queryGraph = (
  space: string,
  engine: Engine.Engine,
  query: GraphQuery,
): {
  serverSeq: number;
  entities: EntitySnapshot[];
} => {
  const branch = query.branch ?? "";
  const manager = new EngineObjectManager(engine, branch);
  const tracker = new CompoundCycleTracker<
    Immutable<StorableDatum>,
    unknown
  >();
  const schemaTracker = new MapSet<QueryDocKey, SchemaPathSelector>(true);
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

  const entities = [...schemaTracker]
    .map(([key]) => key)
    .filter((key) => key.startsWith(`${space}/`))
    .map((key) => fromDocKey(key))
    .filter((entry) => entry.type === "application/json")
    .map(({ id, type }) => {
      const detail = manager.detail({ id, type });
      const state = Engine.readState(engine, {
        id,
        branch,
      });
      return {
        id,
        seq: detail?.seq ?? state?.seq ?? 0,
        hash: detail?.hash ?? state?.hash,
        document: state?.document ?? null,
      } satisfies EntitySnapshot;
    })
    .sort((left, right) => left.id.localeCompare(right.id));

  return {
    serverSeq: Engine.headSeq(engine, branch),
    entities,
  };
};

const loadFactsForDoc = (
  manager: EngineObjectManager,
  fact: IAttestation,
  selector: SchemaPathSelector,
  tracker: CompoundCycleTracker<Immutable<StorableDatum>, unknown>,
  cfc: ContextualFlowControl,
  space: string,
  schemaTracker: MapSet<QueryDocKey, SchemaPathSelector>,
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

const toDocKey = (space: string, id: string, type: string): QueryDocKey =>
  `${space}/${id}/${type}`;

const fromDocKey = (key: QueryDocKey) => {
  const match = /^([^/]+)\/(.+)\/application\/json$/.exec(key);
  if (match !== null) {
    const [, space, id] = match;
    return { space, id, type: "application/json" };
  }
  const [space, id, type] = key.split("/", 3);
  return { space, id, type };
};
