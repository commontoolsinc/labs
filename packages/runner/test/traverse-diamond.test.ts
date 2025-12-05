/**
 * Test fixture for the diamond problem in DAG traversal memoization
 *
 * Background: When displaying multiple charms that share common documents,
 * the system was making 18,623 traversal calls for only 338 unique objects -
 * a 55x repetition factor causing 100% CPU usage.
 *
 * This test validates the WeakMap-based memoization fix prevents redundant
 * traversals while correctly handling the diamond pattern.
 *
 * See: commit 7688e5ad - "perf(runner): fix traverseDAG diamond problem with WeakMap memoization"
 * Design doc: https://gist.github.com/willkelly/f4d3a5b26c63f3346c4dcf8109d55696
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

/**
 * Instrumented cycle tracker to count traversal calls and cache behavior
 */
class InstrumentedCycleTracker extends CompoundCycleTracker<any, any> {
  public includeObjectCalls = 0;
  public includeDocumentCalls = 0;
  public cacheHits = 0;
  public cacheMisses = 0;

  override include(partialKey: any, extraKey: any, context?: unknown) {
    this.includeObjectCalls++;
    const result = super.include(partialKey, extraKey, context);

    if (result && "cached" in result) {
      this.cacheHits++;
    } else if (result !== null) {
      this.cacheMisses++;
    }

    return result;
  }

  override includeDocument(
    docId: string,
    path: readonly string[],
    schemaContext: unknown,
  ) {
    this.includeDocumentCalls++;
    return super.includeDocument(docId, path, schemaContext);
  }

  reset() {
    this.includeObjectCalls = 0;
    this.includeDocumentCalls = 0;
    this.cacheHits = 0;
    this.cacheMisses = 0;
  }

  getStats() {
    return {
      includeObjectCalls: this.includeObjectCalls,
      includeDocumentCalls: this.includeDocumentCalls,
      cacheHits: this.cacheHits,
      cacheMisses: this.cacheMisses,
    };
  }
}

describe("Diamond Problem - DAG Traversal Memoization", () => {
  it("demonstrates memoization with shared nested structures", () => {
    // Create a structure with shared nested objects
    // This tests object-level WeakMap memoization

    const sharedArray = [1, 2, 3, 4, 5];
    const sharedNested = {
      level1: {
        level2: {
          level3: {
            data: "deeply nested",
            arr: sharedArray,
          },
        },
      },
    };

    // Create a root structure that references the same objects multiple times
    const rootValue = {
      pathA: {
        shared: sharedNested,
        unique: "A",
      },
      pathB: {
        shared: sharedNested, // Same object reference
        unique: "B",
      },
      pathC: {
        shared: sharedNested, // Same object reference
        unique: "C",
      },
    };

    const store = new Map<string, Revision<State>>();
    const type = "application/json" as const;
    const rootUri = "of:root" as URI;
    const rootEntity = rootUri as Entity;

    store.set(rootUri + "/" + type, {
      the: type,
      of: rootEntity,
      is: { value: rootValue },
      cause: refer({ the: type, of: rootEntity }),
      since: 1,
    });

    const manager = new StoreObjectManager(store);
    const tracker = new InstrumentedCycleTracker();

    const traverser = new SchemaObjectTraverser(
      manager,
      {
        path: [],
        schemaContext: { schema: true, rootSchema: true },
      },
      tracker,
    );

    const attestation: IAttestation = {
      address: { id: rootUri, type, path: ["value"] },
      value: rootValue,
    };

    // First traversal - should cache the shared objects
    tracker.reset();
    const result1 = traverser.traverse(attestation);

    console.log("\n=== Shared Nested Objects Test ===");
    console.log("Structure: Root with 3 paths (A, B, C)");
    console.log("           Each path references the same nested object");
    console.log("\nFirst traversal stats:", tracker.getStats());

    // Verify structure
    expect(result1).toBeDefined();
    const res1 = result1 as any;
    expect(res1.pathA.shared).toEqual(sharedNested);
    expect(res1.pathB.shared).toEqual(sharedNested);
    expect(res1.pathC.shared).toEqual(sharedNested);

    // With memoization, all three should be the same object reference
    expect(res1.pathA.shared).toBe(res1.pathB.shared);
    expect(res1.pathB.shared).toBe(res1.pathC.shared);

    // Second traversal of the same structure
    tracker.reset();
    const result2 = traverser.traverse(attestation);

    console.log("Second traversal stats (cached):", tracker.getStats());

    // Should have cache hits now
    expect(tracker.cacheHits).toBeGreaterThan(0);
    console.log(
      "Cache hit rate: " +
        (100 * tracker.cacheHits / (tracker.cacheHits + tracker.cacheMisses))
          .toFixed(1) +
        "%",
    );

    // Results should be identical
    expect(result2).toEqual(result1);
  });

  it("validates memoization prevents redundant deep traversals", () => {
    // Create a large nested structure that appears multiple times
    const largeSharedObj = {
      metadata: { type: "large", version: 1 },
      items: Array.from({ length: 50 }, (_, i) => ({
        id: i,
        value: "item-" + i,
        nested: {
          a: i * 10,
          b: i * 20,
          c: { deep: i * 30 },
        },
      })),
    };

    // Reference this large object from 5 different places
    const rootValue = {
      ref1: { data: largeSharedObj },
      ref2: { data: largeSharedObj },
      ref3: { data: largeSharedObj },
      ref4: { data: largeSharedObj },
      ref5: { data: largeSharedObj },
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
    const tracker = new InstrumentedCycleTracker();

    const traverser = new SchemaObjectTraverser(
      manager,
      {
        path: [],
        schemaContext: { schema: true, rootSchema: true },
      },
      tracker,
    );

    const attestation: IAttestation = {
      address: { id: rootUri, type, path: ["value"] },
      value: rootValue,
    };

    tracker.reset();
    const result = traverser.traverse(attestation);

    console.log("\n=== Large Shared Object Test ===");
    console.log("Large object size: 50 items");
    console.log("Referenced from: 5 locations");
    console.log("Without memoization: ~250+ object traversals");
    console.log("With memoization:", tracker.includeObjectCalls, "traversals");
    console.log("\nTraversal stats:", tracker.getStats());

    // Verify all refs point to the same memoized result
    const res = result as any;
    expect(res.ref1.data).toBe(res.ref2.data);
    expect(res.ref2.data).toBe(res.ref3.data);
    expect(res.ref3.data).toBe(res.ref4.data);
    expect(res.ref4.data).toBe(res.ref5.data);

    // With memoization, should traverse far less than 250 times
    expect(tracker.includeObjectCalls).toBeLessThan(200);

    console.log(
      "Memoization saved ~" +
        (250 - tracker.includeObjectCalls) +
        " redundant traversals",
    );
  });

  it("stress test: many references to deeply nested shared structure", () => {
    // Create a complex deeply nested structure
    const deeplyNested = {
      l1: {
        l2: {
          l3: {
            l4: {
              l5: {
                data: Array.from({ length: 20 }, (_, i) => ({
                  id: i,
                  nested: { a: i, b: i * 2, c: { d: i * 3 } },
                })),
              },
            },
          },
        },
      },
    };

    // Create a root with 10 references to this structure
    const refs: any = {};
    for (let i = 0; i < 10; i++) {
      refs["ref" + i] = {
        id: i,
        shared: deeplyNested,
      };
    }

    const rootValue = { references: refs };

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
    const tracker = new InstrumentedCycleTracker();

    const traverser = new SchemaObjectTraverser(
      manager,
      {
        path: [],
        schemaContext: { schema: true, rootSchema: true },
      },
      tracker,
    );

    const attestation: IAttestation = {
      address: { id: rootUri, type, path: ["value"] },
      value: rootValue,
    };

    tracker.reset();
    const result = traverser.traverse(attestation);

    console.log("\n=== Stress Test: Deep Nesting + Many Refs ===");
    console.log("Structure depth: 5 levels");
    console.log("Array size: 20 items");
    console.log("Number of references: 10");
    console.log(
      "Potential traversals without memo: 10 refs × 20 items × 5 levels = 1000+",
    );
    console.log("Actual traversals with memo:", tracker.includeObjectCalls);
    console.log("\nFull stats:", tracker.getStats());

    // Verify all refs share the same memoized object
    const res = result as any;
    const firstShared = res.references.ref0.shared;

    for (let i = 1; i < 10; i++) {
      const key = "ref" + i;
      expect(res.references[key].shared).toBe(firstShared);
    }

    // Should be dramatically less than 1000 traversals
    expect(tracker.includeObjectCalls).toBeLessThan(300);

    const savingsPercent = ((1000 - tracker.includeObjectCalls) / 1000 * 100)
      .toFixed(1);
    console.log("Memoization savings: " + savingsPercent + "%");
  });
});
