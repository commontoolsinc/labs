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
});
