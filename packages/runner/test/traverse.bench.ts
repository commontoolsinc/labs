/**
 * Performance benchmarks for DAG traversal memoization
 *
 * Run with: deno bench -A test/traverse.bench.ts
 *
 * These benchmarks measure the performance of traversal with memoization
 * enabled, testing various sizes and configurations of shared object graphs.
 */

import { refer } from "merkle-reference/json";
import type {
  Entity,
  JSONValue,
  Revision,
  State,
  URI,
} from "@commontools/memory/interface";
import {
  CompoundCycleTracker,
  type IAttestation,
  SchemaObjectTraverser,
} from "../src/traverse.ts";
import { StoreObjectManager } from "../src/storage/query.ts";

// Helper to create a store with a single document
function createStore(rootValue: JSONValue): {
  store: Map<string, Revision<State>>;
  manager: StoreObjectManager;
  attestation: IAttestation;
} {
  const store = new Map<string, Revision<State>>();
  const type = "application/json" as const;
  const rootUri = "of:root" as URI;

  store.set(rootUri + "/" + type, {
    the: type,
    of: rootUri as Entity,
    is: { value: rootValue },
    cause: refer({ the: type, of: rootUri as Entity }),
    since: 1,
  });

  const manager = new StoreObjectManager(store);
  const attestation: IAttestation = {
    address: { id: rootUri, type, path: ["value"] },
    value: rootValue,
  };

  return { store, manager, attestation };
}

// Create shared nested structure for benchmarks
function createSharedNested(depth: number, arraySize: number): JSONValue {
  let obj: JSONValue = {
    data: Array.from({ length: arraySize }, (_, i) => ({
      id: i,
      nested: { a: i, b: i * 2, c: { d: i * 3 } },
    })),
  };

  for (let i = 0; i < depth; i++) {
    obj = { [`level${i}`]: obj };
  }

  return obj;
}

// --- Small structure benchmarks ---

Deno.bench({
  name: "traverse: 3 refs to shared object",
  group: "small",
  fn: () => {
    const shared = { data: "shared", nested: { a: 1, b: 2, c: 3 } };
    const rootValue = {
      ref1: { shared },
      ref2: { shared },
      ref3: { shared },
    };

    const { manager, attestation } = createStore(rootValue);
    const tracker = new CompoundCycleTracker();
    const traverser = new SchemaObjectTraverser(
      manager,
      { path: [], schemaContext: { schema: true, rootSchema: true } },
      tracker,
    );

    traverser.traverse(attestation);
  },
});

Deno.bench({
  name: "traverse: 3 refs without sharing (baseline)",
  group: "small",
  baseline: true,
  fn: () => {
    const rootValue = {
      ref1: { data: "shared1", nested: { a: 1, b: 2, c: 3 } },
      ref2: { data: "shared2", nested: { a: 1, b: 2, c: 3 } },
      ref3: { data: "shared3", nested: { a: 1, b: 2, c: 3 } },
    };

    const { manager, attestation } = createStore(rootValue);
    const tracker = new CompoundCycleTracker();
    const traverser = new SchemaObjectTraverser(
      manager,
      { path: [], schemaContext: { schema: true, rootSchema: true } },
      tracker,
    );

    traverser.traverse(attestation);
  },
});

// --- Medium structure benchmarks ---

Deno.bench({
  name: "traverse: 5 refs to 50-item shared array",
  group: "medium",
  fn: () => {
    const largeSharedObj = {
      metadata: { type: "large", version: 1 },
      items: Array.from({ length: 50 }, (_, i) => ({
        id: i,
        value: "item-" + i,
        nested: { a: i * 10, b: i * 20, c: { deep: i * 30 } },
      })),
    };

    const rootValue = {
      ref1: { data: largeSharedObj },
      ref2: { data: largeSharedObj },
      ref3: { data: largeSharedObj },
      ref4: { data: largeSharedObj },
      ref5: { data: largeSharedObj },
    };

    const { manager, attestation } = createStore(rootValue);
    const tracker = new CompoundCycleTracker();
    const traverser = new SchemaObjectTraverser(
      manager,
      { path: [], schemaContext: { schema: true, rootSchema: true } },
      tracker,
    );

    traverser.traverse(attestation);
  },
});

// --- Large structure benchmarks ---

Deno.bench({
  name: "traverse: 10 refs to deeply nested (5 levels, 20 items)",
  group: "large",
  fn: () => {
    const deeplyNested = createSharedNested(5, 20);

    const refs: any = {};
    for (let i = 0; i < 10; i++) {
      refs["ref" + i] = { id: i, shared: deeplyNested };
    }

    const rootValue = { references: refs };
    const { manager, attestation } = createStore(rootValue);
    const tracker = new CompoundCycleTracker();
    const traverser = new SchemaObjectTraverser(
      manager,
      { path: [], schemaContext: { schema: true, rootSchema: true } },
      tracker,
    );

    traverser.traverse(attestation);
  },
});

Deno.bench({
  name: "traverse: 20 refs to deeply nested (5 levels, 20 items)",
  group: "large",
  fn: () => {
    const deeplyNested = createSharedNested(5, 20);

    const refs: any = {};
    for (let i = 0; i < 20; i++) {
      refs["ref" + i] = { id: i, shared: deeplyNested };
    }

    const rootValue = { references: refs };
    const { manager, attestation } = createStore(rootValue);
    const tracker = new CompoundCycleTracker();
    const traverser = new SchemaObjectTraverser(
      manager,
      { path: [], schemaContext: { schema: true, rootSchema: true } },
      tracker,
    );

    traverser.traverse(attestation);
  },
});

// --- Repeated traversal benchmarks ---

Deno.bench({
  name: "traverse: repeated traversal (same tracker, cached)",
  group: "caching",
  fn: () => {
    const shared = createSharedNested(3, 10);
    const rootValue = {
      ref1: { shared },
      ref2: { shared },
      ref3: { shared },
    };

    const { manager, attestation } = createStore(rootValue);
    const tracker = new CompoundCycleTracker();
    const traverser = new SchemaObjectTraverser(
      manager,
      { path: [], schemaContext: { schema: true, rootSchema: true } },
      tracker,
    );

    // Traverse multiple times with same tracker (cached)
    traverser.traverse(attestation);
    traverser.traverse(attestation);
    traverser.traverse(attestation);
  },
});

Deno.bench({
  name: "traverse: repeated traversal (new tracker each time, baseline)",
  group: "caching",
  baseline: true,
  fn: () => {
    const shared = createSharedNested(3, 10);
    const rootValue = {
      ref1: { shared },
      ref2: { shared },
      ref3: { shared },
    };

    const { manager, attestation } = createStore(rootValue);

    // Traverse multiple times with fresh tracker each time (no cross-traversal cache)
    for (let i = 0; i < 3; i++) {
      const tracker = new CompoundCycleTracker();
      const traverser = new SchemaObjectTraverser(
        manager,
        { path: [], schemaContext: { schema: true, rootSchema: true } },
        tracker,
      );
      traverser.traverse(attestation);
    }
  },
});

// --- Stress test benchmarks ---

Deno.bench({
  name: "traverse: stress test (50 refs, 10 levels, 30 items)",
  group: "stress",
  fn: () => {
    const deeplyNested = createSharedNested(10, 30);

    const refs: any = {};
    for (let i = 0; i < 50; i++) {
      refs["ref" + i] = { id: i, shared: deeplyNested };
    }

    const rootValue = { references: refs };
    const { manager, attestation } = createStore(rootValue);
    const tracker = new CompoundCycleTracker();
    const traverser = new SchemaObjectTraverser(
      manager,
      { path: [], schemaContext: { schema: true, rootSchema: true } },
      tracker,
    );

    traverser.traverse(attestation);
  },
});
