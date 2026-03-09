// Per-path reads: verify that fine-grained scheduling only triggers sinks
// that actually read the changed sub-paths. The optimization makes the
// document-level read in validateAndTransform non-scheduling, and instead
// emits per-path reads for only the paths the schema actually consumes.
//
// The scenario: multiple consumers (via asSchema) read the SAME mutable cell
// with DIFFERENT schemas. Changing a field covered by one schema should NOT
// trigger the sink of the other schema.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import "@commontools/utils/equal-ignoring-symbols";

import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import type { JSONSchema } from "../src/builder/types.ts";
import { Runtime } from "../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("Per-path reads - schema-selective sinks", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();
  });

  afterEach(async () => {
    await tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("two asSchema views of the same cell: changing one field should not trigger the other view's sink", async () => {
    // Create a cell with nested data under two top-level fields
    const cell = runtime.getCell<{
      profile: { name: string; age: number };
      stats: { score: number; level: string };
    }>(space, "per-path-two-views");

    cell.withTx(tx).set({
      profile: { name: "Alice", age: 30 },
      stats: { score: 100, level: "gold" },
    });
    tx.commit();
    tx = runtime.edit();

    // Two views with disjoint schemas on the same cell
    const profileView = cell.asSchema<
      { profile: { name: string; age: number } }
    >(
      {
        type: "object",
        properties: {
          profile: {
            type: "object",
            properties: {
              name: { type: "string" },
              age: { type: "number" },
            },
            required: ["name", "age"],
          },
        },
        required: ["profile"],
      } as const satisfies JSONSchema,
    );

    const statsView = cell.asSchema<
      { stats: { score: number; level: string } }
    >(
      {
        type: "object",
        properties: {
          stats: {
            type: "object",
            properties: {
              score: { type: "number" },
              level: { type: "string" },
            },
            required: ["score", "level"],
          },
        },
        required: ["stats"],
      } as const satisfies JSONSchema,
    );

    const profileValues: string[] = [];
    const statsValues: string[] = [];

    profileView.sink((v) => {
      profileValues.push(`${v.profile.name}:${v.profile.age}`);
    });

    statsView.sink((v) => {
      statsValues.push(`${v.stats.score}:${v.stats.level}`);
    });

    await runtime.idle();

    // Initial values from both sinks
    expect(profileValues).toEqual(["Alice:30"]);
    expect(statsValues).toEqual(["100:gold"]);

    // Change profile only
    cell.withTx(tx).set({
      profile: { name: "Bob", age: 25 },
      stats: { score: 100, level: "gold" },
    });
    tx.commit();
    tx = runtime.edit();
    await runtime.idle();

    expect(profileValues).toEqual(["Alice:30", "Bob:25"]);
    // With per-path reads, stats sink should NOT have re-fired
    expect(statsValues).toEqual(["100:gold"]);

    // Change stats only
    cell.withTx(tx).set({
      profile: { name: "Bob", age: 25 },
      stats: { score: 200, level: "platinum" },
    });
    tx.commit();
    tx = runtime.edit();
    await runtime.idle();

    // Profile sink should NOT have re-fired
    expect(profileValues).toEqual(["Alice:30", "Bob:25"]);
    expect(statsValues).toEqual(["100:gold", "200:platinum"]);
  });

  it("deeply nested schema views: only the consumed sub-path triggers re-run", async () => {
    const cell = runtime.getCell<{
      config: {
        display: { theme: string; fontSize: number };
        network: { timeout: number; retries: number };
      };
    }>(space, "per-path-deep-nested");

    cell.withTx(tx).set({
      config: {
        display: { theme: "dark", fontSize: 14 },
        network: { timeout: 5000, retries: 3 },
      },
    });
    tx.commit();
    tx = runtime.edit();

    const displayView = cell.asSchema<{
      config: { display: { theme: string; fontSize: number } };
    }>(
      {
        type: "object",
        properties: {
          config: {
            type: "object",
            properties: {
              display: {
                type: "object",
                properties: {
                  theme: { type: "string" },
                  fontSize: { type: "number" },
                },
                required: ["theme", "fontSize"],
              },
            },
            required: ["display"],
          },
        },
        required: ["config"],
      } as const satisfies JSONSchema,
    );

    const networkView = cell.asSchema<{
      config: { network: { timeout: number; retries: number } };
    }>(
      {
        type: "object",
        properties: {
          config: {
            type: "object",
            properties: {
              network: {
                type: "object",
                properties: {
                  timeout: { type: "number" },
                  retries: { type: "number" },
                },
                required: ["timeout", "retries"],
              },
            },
            required: ["network"],
          },
        },
        required: ["config"],
      } as const satisfies JSONSchema,
    );

    const displayValues: string[] = [];
    const networkValues: string[] = [];

    displayView.sink((v) => {
      displayValues.push(
        `${v.config.display.theme}:${v.config.display.fontSize}`,
      );
    });

    networkView.sink((v) => {
      networkValues.push(
        `${v.config.network.timeout}:${v.config.network.retries}`,
      );
    });

    await runtime.idle();

    expect(displayValues).toEqual(["dark:14"]);
    expect(networkValues).toEqual(["5000:3"]);

    // Change only display.theme
    cell.withTx(tx).set({
      config: {
        display: { theme: "light", fontSize: 14 },
        network: { timeout: 5000, retries: 3 },
      },
    });
    tx.commit();
    tx = runtime.edit();
    await runtime.idle();

    expect(displayValues).toEqual(["dark:14", "light:14"]);
    // Network sink should NOT re-fire
    expect(networkValues).toEqual(["5000:3"]);

    // Change only network.timeout
    cell.withTx(tx).set({
      config: {
        display: { theme: "light", fontSize: 14 },
        network: { timeout: 10000, retries: 3 },
      },
    });
    tx.commit();
    tx = runtime.edit();
    await runtime.idle();

    // Display sink should NOT re-fire
    expect(displayValues).toEqual(["dark:14", "light:14"]);
    expect(networkValues).toEqual(["5000:3", "10000:3"]);
  });

  it("array vs object field: changing array should not trigger object-only sink", async () => {
    const cell = runtime.getCell<{
      items: Array<{ name: string; value: number }>;
      summary: { total: number; label: string };
    }>(space, "per-path-array-vs-object");

    cell.withTx(tx).set({
      items: [
        { name: "a", value: 10 },
        { name: "b", value: 20 },
      ],
      summary: { total: 30, label: "test" },
    });
    tx.commit();
    tx = runtime.edit();

    const itemsView = cell.asSchema<{
      items: Array<{ name: string; value: number }>;
    }>(
      {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                value: { type: "number" },
              },
              required: ["name", "value"],
            },
          },
        },
        required: ["items"],
      } as const satisfies JSONSchema,
    );

    const summaryView = cell.asSchema<{
      summary: { total: number; label: string };
    }>(
      {
        type: "object",
        properties: {
          summary: {
            type: "object",
            properties: {
              total: { type: "number" },
              label: { type: "string" },
            },
            required: ["total", "label"],
          },
        },
        required: ["summary"],
      } as const satisfies JSONSchema,
    );

    const itemsCounts: number[] = [];
    const summaryLabels: string[] = [];

    itemsView.sink((v) => {
      itemsCounts.push(v.items.length);
    });

    summaryView.sink((v) => {
      summaryLabels.push(v.summary.label);
    });

    await runtime.idle();

    expect(itemsCounts).toEqual([2]);
    expect(summaryLabels).toEqual(["test"]);

    // Change only items — reuse existing items (which carry IDs) and append a new one
    const oldItems = cell.withTx(tx).get()!.items;
    cell.withTx(tx).set({
      items: [...oldItems, { name: "c", value: 30 }],
      summary: { total: 30, label: "test" },
    });
    tx.commit();
    tx = runtime.edit();
    await runtime.idle();

    expect(itemsCounts).toEqual([2, 3]);
    // Summary sink should NOT re-fire
    expect(summaryLabels).toEqual(["test"]);

    // Change only summary — reuse existing items with their IDs
    const oldItems2 = cell.withTx(tx).get()!.items;
    cell.withTx(tx).set({
      items: [...oldItems2],
      summary: { total: 60, label: "updated" },
    });
    tx.commit();
    tx = runtime.edit();
    await runtime.idle();

    // Items sink should NOT re-fire
    expect(itemsCounts).toEqual([2, 3]);
    expect(summaryLabels).toEqual(["test", "updated"]);
  });

  it("reading array length creates a dependency: inserting an element triggers the sink", async () => {
    const cell = runtime.getCell<{ items: Array<{ name: string }> }>(
      space,
      "per-path-array-length-reactivity",
    );

    cell.withTx(tx).set({ items: [{ name: "a" }, { name: "b" }] });
    tx.commit();
    tx = runtime.edit();

    const lengths: number[] = [];
    const lengthView = cell.key("items").key("length");
    lengthView.sink((l) => {
      lengths.push(l);
    });

    await runtime.idle();
    expect(lengths).toEqual([2]);

    // Insert a new element — the sink reads .length, so it must re-fire.
    cell.withTx(tx).key("items").key(2).set({ name: "c" });
    tx.commit();
    tx = runtime.edit();
    await runtime.idle();

    expect(lengths).toEqual([2, 3]);
  });
});
