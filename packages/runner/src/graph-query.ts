/**
 * The driver a storage engine uses to resolve a schema graph query: given
 * documents the engine supplies, walk them under a schema and record every
 * document that schema reaches.
 *
 * A memory server resolves a subscriber's watch set with this, while a client
 * asks the same question of a live replica through `schema.ts`. Both run the
 * one traversal in `traverse.ts`, because a server and a client that disagree
 * about which documents a schema reaches leave the client waiting on a
 * document nobody will send. This module is the whole of what a storage engine
 * needs from the runtime to take part in that, and it re-exports the vocabulary
 * the two sides name in common so a caller reaches for one module rather than
 * the traversal's internals.
 */

import type { FabricValue } from "@commonfabric/data-model/fabric-value";
import { internPathSelector } from "@commonfabric/data-model/schema-utils";
import type { MemorySpace } from "@commonfabric/memory/interface";
import { isObjectNotArray } from "@commonfabric/utils/types";

import type { JSONSchema } from "./builder/types.ts";
import { ExtendedStorageTransaction } from "./storage/extended-storage-transaction.ts";
import {
  type BaseMemoryAddress,
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
  type SchemaMemo,
  SchemaObjectTraverser,
  type SchemaPathSelector,
  schemaTrackerCoversSelector,
  schemaTrackerKey,
  type TraversalContext,
} from "./traverse.ts";

export type {
  BaseMemoryAddress,
  IAttestation,
  ObjectStorageManager,
  SchemaPathSelector,
};
export {
  createSchemaMemo,
  MapSetStringToPathSelectors,
  type SchemaMemo,
  schemaTrackerCoversSelector,
  schemaTrackerKey,
};

/** Counters a walk accumulates, for query diagnostics and benchmarks. */
export type GraphQueryWalkStats = {
  coveredSelectorSkips: number;
  schemaTraversals: number;
  pointerTraversals: number;
  arrayTraversals: number;
  objectTraversals: number;
  dagTraversals: number;
  getDocAtPathCalls: number;
  schemaMemoHits: number;
};

export const createGraphQueryWalkStats = (): GraphQueryWalkStats => ({
  coveredSelectorSkips: 0,
  schemaTraversals: 0,
  pointerTraversals: 0,
  arrayTraversals: 0,
  objectTraversals: 0,
  dagTraversals: 0,
  getDocAtPathCalls: 0,
  schemaMemoHits: 0,
});

export type GraphQueryWalkOptions = {
  /** Supplies documents by address. */
  manager: ObjectStorageManager;
  /** Space the visited documents belong to. */
  space: MemorySpace;
  /**
   * Receives one entry per document the walk reached, keyed by
   * `schemaTrackerKey`. Share it across walks to accumulate the reach of a
   * whole query; the walk reads it too, and skips a document whose selector
   * it already covers.
   */
  schemaTracker: MapSetStringToPathSelectors;
  /** Schema-traversal results reused across walks that share it. */
  memo?: SchemaMemo;
  /** Counters to add into. */
  stats?: GraphQueryWalkStats;
};

/**
 * Resolves a schema query against documents a storage engine supplies, rather
 * than against a live replica: the traversal a memory server runs to decide
 * which documents a subscriber's schema reaches.
 *
 * A walk owns a pointer-cycle tracker, so a link cycle terminates. The schema
 * tracker and the memo are handed in instead, so several walks can share them
 * and accumulate the reach of one query between them.
 */
export class GraphQueryWalk {
  readonly #manager: ObjectStorageManager;
  readonly #space: MemorySpace;
  readonly #context: TraversalContext;
  readonly #memo: SchemaMemo;
  readonly stats: GraphQueryWalkStats;

  constructor(options: GraphQueryWalkOptions) {
    this.#manager = options.manager;
    this.#space = options.space;
    this.#context = createTraversalContext(
      new CompoundCycleTracker<FabricValue, JSONSchema | undefined>(),
      options.schemaTracker,
      true,
    );
    this.#memo = options.memo ?? createSchemaMemo();
    this.stats = options.stats ?? createGraphQueryWalkStats();
  }

  /**
   * Walks `document` under `selector`, recording every document the schema
   * reaches — including the metadata documents a reader needs to interpret
   * them — in the walk's schema tracker.
   */
  visit(document: IAttestation, selector: SchemaPathSelector): void {
    const effectiveSelector = selector.schema === undefined
      ? { ...selector, schema: false }
      : selector;

    const docKey = schemaTrackerKey(
      this.#space,
      document.address.id,
      document.address.scope,
    );
    const internedSelector = internPathSelector(effectiveSelector);
    if (
      schemaTrackerCoversSelector(
        this.#context.schemaTracker,
        docKey,
        internedSelector,
      )
    ) {
      this.stats.coveredSelectorSkips++;
      return;
    }
    this.#context.schemaTracker.add(docKey, internedSelector);

    if (!isObjectNotArray(document.value)) {
      return;
    }

    const tx = new ExtendedStorageTransaction(
      new ManagedStorageTransaction(this.#manager),
    );
    const value = (document.value as { value: FabricValue }).value;
    const root: IMemorySpaceValueAttestation = {
      address: { ...document.address, space: this.#space, path: ["value"] },
      value,
    };
    const [nextDoc, nextSelector] = getAtPath(
      tx,
      root,
      effectiveSelector.path.slice(1),
      this.#context,
      effectiveSelector,
    );
    if (
      nextDoc.value !== undefined &&
      nextSelector !== undefined &&
      nextSelector.schema !== false
    ) {
      const traverser = new SchemaObjectTraverser(
        tx,
        nextSelector,
        this.#context,
        undefined,
        this.#memo,
      );
      traverser.traverse(nextDoc);
      this.#addTraverserStats(traverser);
    }

    loadMetaLinkedDocs(
      tx,
      {
        address: { ...document.address, space: this.#space },
        value: document.value,
      },
      this.#context,
    );
  }

  #addTraverserStats(traverser: SchemaObjectTraverser<FabricValue>): void {
    this.stats.schemaTraversals += traverser.traverseWithSchemaCalls;
    this.stats.pointerTraversals += traverser.traversePointerCalls;
    this.stats.arrayTraversals += traverser.traverseArrayCalls;
    this.stats.objectTraversals += traverser.traverseObjectCalls;
    this.stats.dagTraversals += traverser.traverseDAGCalls;
    this.stats.getDocAtPathCalls += traverser.getDocAtPathCalls;
    this.stats.schemaMemoHits += traverser.schemaMemoHits;
  }
}
