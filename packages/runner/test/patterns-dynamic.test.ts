// Dynamic pattern instantiation: patterns created at runtime inside lifts
// or handlers, and ensuring they execute in the correct dependency order.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { type JSONSchema } from "../src/builder/types.ts";
import { createBuilder } from "../src/builder/factory.ts";
import { Runtime } from "../src/runtime.ts";
import { type IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("Pattern Runner - Dynamic Patterns", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let lift: ReturnType<typeof createBuilder>["commontools"]["lift"];
  let pattern: ReturnType<typeof createBuilder>["commontools"]["pattern"];

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });

    tx = runtime.edit();

    const { commontools } = createBuilder();
    ({
      lift,
      pattern,
    } = commontools);
  });

  afterEach(async () => {
    await tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("should run dynamically instantiated patterns before reading their outputs", async () => {
    // This test reproduces a bug where:
    // 1. A lift dynamically instantiates patterns and pushes them to an array
    // 2. Another lift reads computed values from those array entries
    // 3. The dynamically instantiated patterns haven't executed yet, so their
    //    computed outputs are undefined
    //
    // The bug manifests with push-based scheduling (sink + idle) but not with
    // pull-based scheduling (pull()) because pull correctly traverses the
    // dependency chain.

    // Inner pattern that computes itemCount from a values array
    const itemCountPattern = pattern(
      ({ values }) => {
        // Compute item count from values
        const itemCount = lift(
          {
            type: "array",
            items: { type: "number" },
          } as const satisfies JSONSchema,
          { type: "number" } as const satisfies JSONSchema,
          (arr: number[]) => (Array.isArray(arr) ? arr.length : 0),
        )(values);

        return { values, itemCount };
      },
      // Input schema
      {
        type: "object",
        properties: {
          values: {
            type: "array",
            items: { type: "number" },
            default: [],
          },
        },
        required: ["values"],
      } as const satisfies JSONSchema,
      // Output schema
      {
        type: "object",
        properties: {
          values: { type: "array", items: { type: "number" } },
          itemCount: { type: "number" },
        },
      } as const satisfies JSONSchema,
    );

    // Lift that dynamically instantiates itemCountPattern for each group
    const instantiateGroups = lift(
      {
        type: "object",
        properties: {
          groups: {
            type: "array",
            items: {
              type: "object",
              properties: {
                values: { type: "array", items: { type: "number" } },
              },
              required: ["values"],
            },
            asCell: true,
          },
        },
        required: ["groups"],
      } as const satisfies JSONSchema,
      {
        type: "array",
        items: {
          type: "object",
          properties: {
            values: { type: "array", items: { type: "number" } },
            itemCount: { type: "number" },
          },
        },
      } as const satisfies JSONSchema,
      ({ groups }) => {
        const raw = groups.get();
        const list = Array.isArray(raw) ? raw : [];
        const children = [];
        for (let index = 0; index < list.length; index++) {
          const groupCell = groups.key(index)!;
          const valuesCell = groupCell.key("values");
          const child = itemCountPattern({
            values: valuesCell,
          });
          children.push(child);
        }
        return children;
      },
    );

    // Lift that sums itemCount from all groups
    const computeTotalItems = lift(
      {
        type: "array",
        items: {
          type: "object",
          properties: {
            itemCount: { type: "number" },
          },
        },
      } as const satisfies JSONSchema,
      { type: "number" } as const satisfies JSONSchema,
      (entries: Array<{ itemCount?: number }>) => {
        if (!Array.isArray(entries)) {
          return 0;
        }
        return entries.reduce((sum, entry) => {
          const count = entry?.itemCount;
          return typeof count === "number" ? sum + count : sum;
        }, 0);
      },
    );

    // Outer pattern that uses instantiateGroups and computeTotalItems
    const outerPattern = pattern(
      ({ groups: groupSeeds }) => {
        const groups = instantiateGroups({ groups: groupSeeds });
        const totalItems = computeTotalItems(groups);
        return { groups, totalItems };
      },
      {
        type: "object",
        properties: {
          groups: {
            type: "array",
            items: {
              type: "object",
              properties: {
                values: { type: "array", items: { type: "number" } },
              },
              required: ["values"],
            },
            default: [],
          },
        },
        required: ["groups"],
      } as const satisfies JSONSchema,
      {
        type: "object",
        properties: {
          groups: {
            type: "array",
            items: {
              type: "object",
              properties: {
                values: { type: "array", items: { type: "number" } },
                itemCount: { type: "number" },
              },
            },
          },
          totalItems: { type: "number" },
        },
      } as const satisfies JSONSchema,
    );

    const resultCell = runtime.getCell<{
      groups: Array<{ values: number[]; itemCount: number }>;
      totalItems: number;
    }>(
      space,
      "should run dynamically instantiated patterns before reading their outputs",
      undefined,
      tx,
    );

    const result = runtime.run(tx, outerPattern, {
      groups: [
        { values: [1, 2, 3] },
        { values: [4, 5] },
      ],
    }, resultCell);
    tx.commit();

    const value = await result.pull();

    // The bug: totalItems would be 0 because the dynamically instantiated
    // patterns haven't run yet when computeTotalItems executes
    expect(value.groups).toHaveLength(2);
    expect(value.groups![0].itemCount).toBe(3);
    expect(value.groups![1].itemCount).toBe(2);
    expect(value.totalItems).toBe(5); // This fails if nested patterns aren't run first
  });

  it("should use positional identity for inline values in map", async () => {
    // Inline values use positional identity (their cell's normalized link
    // includes the array index). When [1, 2, 3] becomes [1, 99, 2, 3]:
    //   - position 0 (value 1) → same key → reuse
    //   - position 1 (value 99) → was value 2's key → new run
    //   - position 2 (value 2) → was value 3's key → new run
    //   - position 3 (value 3) → new key → new run
    // This is the expected trade-off: inline values don't get cross-position
    // reuse. Cell links (the important case) do — see next test.

    let runCount = 0;
    const double = lift((x: number) => {
      runCount++;
      return x * 2;
    });

    // Pass `values` through in the return so we can mutate the input list
    // via the result cell (same technique as the CT-1158 test).
    const doubleArray = pattern<{ values: number[] }>(({ values }) => {
      return { values, doubled: values.map((x) => double(x)) };
    });

    const resultCell = runtime.getCell<{ values: number[]; doubled: number[] }>(
      space,
      "map-mid-insert-recompute",
      undefined,
      tx,
    );
    const result = runtime.run(tx, doubleArray, {
      values: [1, 2, 3],
    }, resultCell);
    tx.commit();
    tx = runtime.edit();

    await result.pull();
    expect(result.key("doubled").get()).toEqual([2, 4, 6]);

    // 3 elements → 3 runs of the op
    const runsAfterInit = runCount;
    expect(runsAfterInit).toBe(3);

    // Insert 99 at index 1: [1, 2, 3] → [1, 99, 2, 3]
    result.withTx(tx).key("values").set([1, 99, 2, 3]);
    tx.commit();
    tx = runtime.edit();

    await result.pull();
    expect(result.key("doubled").get()).toEqual([2, 198, 4, 6]);

    const recomputesAfterInsert = runCount - runsAfterInit;

    // 3 recomputes: positions 1, 2, 3 all get new runs because inline values
    // use positional identity. Only position 0 is reused (value 1, unchanged).
    expect(recomputesAfterInsert).toBe(3);
  });

  it("should reconcile cell-link elements by identity on mid-list insert", async () => {
    // When map elements are cell links (references to other cells), the map
    // builtin uses identity-based reconciliation: it tracks elements by their
    // entity ID and reuses existing pattern runs when elements shift positions.
    // This means inserting in the middle only triggers 1 new computation (the
    // inserted element), not N recomputes for shifted elements.

    let runCount = 0;
    const double = lift((x: number) => {
      runCount++;
      return x * 2;
    });

    // Create individual cells for each value so they have stable entity IDs
    const cellA = runtime.getCell<number>(space, "cell-a", undefined, tx);
    cellA.withTx(tx).set(1);
    const cellB = runtime.getCell<number>(space, "cell-b", undefined, tx);
    cellB.withTx(tx).set(2);
    const cellC = runtime.getCell<number>(space, "cell-c", undefined, tx);
    cellC.withTx(tx).set(3);

    // Pattern that takes a list of values and doubles each one
    const doubleArray = pattern<{ values: number[] }>(({ values }) => {
      return { values, doubled: values.map((x) => double(x)) };
    });

    const resultCell = runtime.getCell<{ values: number[]; doubled: number[] }>(
      space,
      "map-cell-link-reconcile",
      undefined,
      tx,
    );
    const result = runtime.run(tx, doubleArray, {
      values: [cellA, cellB, cellC],
    }, resultCell);
    tx.commit();
    tx = runtime.edit();

    await result.pull();
    expect(result.key("doubled").get()).toEqual([2, 4, 6]);

    // 3 elements → 3 runs of the op
    const runsAfterInit = runCount;
    expect(runsAfterInit).toBe(3);

    // Create a new cell and insert it at index 1: [A, B, C] → [A, X, B, C]
    const cellX = runtime.getCell<number>(space, "cell-x", undefined, tx);
    cellX.withTx(tx).set(99);

    result.withTx(tx).key("values").set([cellA, cellX, cellB, cellC]);
    tx.commit();
    tx = runtime.edit();

    await result.pull();
    expect(result.key("doubled").get()).toEqual([2, 198, 4, 6]);

    const recomputesAfterInsert = runCount - runsAfterInit;

    // With identity-based reconciliation: only 1 recompute (the new element X).
    // Elements A, B, C are recognized by their entity IDs and their existing
    // pattern runs are reused — no unnecessary recomputation.
    expect(recomputesAfterInsert).toBe(1);
  });

  it("should handle duplicate cell-link references in map", async () => {
    // When the same cell appears multiple times in a list (e.g. [A, B, A]),
    // each occurrence must get its own pattern run and result cell. Without
    // occurrence counting, both A references would collide to the same key
    // and share a single result cell.

    let runCount = 0;
    const double = lift((x: number) => {
      runCount++;
      return x * 2;
    });

    const cellA = runtime.getCell<number>(space, "dup-cell-a", undefined, tx);
    cellA.withTx(tx).set(5);
    const cellB = runtime.getCell<number>(space, "dup-cell-b", undefined, tx);
    cellB.withTx(tx).set(10);

    const doubleArray = pattern<{ values: number[] }>(({ values }) => {
      return { values, doubled: values.map((x) => double(x)) };
    });

    const resultCell = runtime.getCell<{ values: number[]; doubled: number[] }>(
      space,
      "map-duplicate-cell-links",
      undefined,
      tx,
    );
    const result = runtime.run(tx, doubleArray, {
      values: [cellA, cellB, cellA],
    }, resultCell);
    tx.commit();
    tx = runtime.edit();

    await result.pull();

    // Each position gets its own run, even though A appears twice
    expect(runCount).toBe(3);
    expect(result.key("doubled").get()).toEqual([10, 20, 10]);
  });
});
