/**
 * Correctness tests for DAG traversal memoization (diamond problem fix)
 *
 * These tests verify that shared object references are correctly memoized
 * during traversal, ensuring the same object appears as the same reference
 * in the output.
 *
 * For performance benchmarks, see: traverse.bench.ts
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { refer } from "merkle-reference/json";
import type {
  Entity,
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

describe("Diamond Problem - Memoization Correctness", () => {
  it("shared objects return the same reference", () => {
    const sharedNested = {
      level1: {
        level2: {
          data: "deeply nested",
          arr: [1, 2, 3],
        },
      },
    };

    const rootValue = {
      pathA: { shared: sharedNested, unique: "A" },
      pathB: { shared: sharedNested, unique: "B" },
      pathC: { shared: sharedNested, unique: "C" },
    };

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
    const tracker = new CompoundCycleTracker();
    const traverser = new SchemaObjectTraverser(
      manager,
      { path: [], schemaContext: { schema: true, rootSchema: true } },
      tracker,
    );

    const attestation: IAttestation = {
      address: { id: rootUri, type, path: ["value"] },
      value: rootValue,
    };

    const result = traverser.traverse(attestation) as any;

    // Verify structure is correct
    expect(result.pathA.shared).toEqual(sharedNested);
    expect(result.pathB.shared).toEqual(sharedNested);
    expect(result.pathC.shared).toEqual(sharedNested);

    // Verify memoization: all paths share the same object reference
    expect(result.pathA.shared).toBe(result.pathB.shared);
    expect(result.pathB.shared).toBe(result.pathC.shared);
  });

  it("repeated traversals return cached results", () => {
    const sharedObj = { data: "shared", nested: { a: 1, b: 2 } };
    const rootValue = {
      ref1: { obj: sharedObj },
      ref2: { obj: sharedObj },
    };

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
    const tracker = new CompoundCycleTracker();
    const traverser = new SchemaObjectTraverser(
      manager,
      { path: [], schemaContext: { schema: true, rootSchema: true } },
      tracker,
    );

    const attestation: IAttestation = {
      address: { id: rootUri, type, path: ["value"] },
      value: rootValue,
    };

    // First traversal
    const result1 = traverser.traverse(attestation);

    // Second traversal should return cached result
    const result2 = traverser.traverse(attestation);

    expect(result1).toEqual(result2);
    expect(result1).toBe(result2); // Same reference due to caching
  });

  it("arrays with shared elements are memoized correctly", () => {
    const sharedItem = { id: 1, data: { nested: "value" } };
    const rootValue = {
      items: [sharedItem, sharedItem, sharedItem],
    };

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
    const tracker = new CompoundCycleTracker();
    const traverser = new SchemaObjectTraverser(
      manager,
      { path: [], schemaContext: { schema: true, rootSchema: true } },
      tracker,
    );

    const attestation: IAttestation = {
      address: { id: rootUri, type, path: ["value"] },
      value: rootValue,
    };

    const result = traverser.traverse(attestation) as any;

    // All array items should be the same reference
    expect(result.items[0]).toBe(result.items[1]);
    expect(result.items[1]).toBe(result.items[2]);
  });
});
