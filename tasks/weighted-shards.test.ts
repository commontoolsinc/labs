import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { assignWeightedShards, weightedShardLoads } from "./weighted-shards.ts";

describe("weighted-shards", () => {
  it("balances the longest items before placing shorter items", () => {
    const items = [9, 8, 7, 6, 5, 4].map((weight) => ({
      name: `item-${weight}`,
      weight,
    }));

    expect(weightedShardLoads(items, 3)).toEqual([13, 13, 13]);
  });

  it("uses names to break equal-weight ties deterministically", () => {
    const assignments = assignWeightedShards([
      { name: "c", weight: 1 },
      { name: "a", weight: 1 },
      { name: "b", weight: 1 },
    ], 2);

    expect(Object.fromEntries(assignments)).toEqual({ a: 1, b: 2, c: 1 });
  });

  it("starts placement from existing shard loads", () => {
    const initialLoads = [10, 0];
    const items = [9, 8].map((weight) => ({
      name: `item-${weight}`,
      weight,
    }));

    expect(weightedShardLoads(items, 2, initialLoads)).toEqual([10, 17]);
    expect(initialLoads).toEqual([10, 0]);
  });

  it("validates existing shard loads", () => {
    expect(() => assignWeightedShards([], 2, [0])).toThrow(
      "Initial shard load count 1 does not match shard count 2.",
    );
    for (const load of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => assignWeightedShards([], 1, [load])).toThrow(
        "Initial shard loads must be non-negative and finite.",
      );
    }
  });

  it("rejects invalid shard counts", () => {
    for (const total of [0, -1, 1.5, Number.POSITIVE_INFINITY]) {
      expect(() => assignWeightedShards([], total)).toThrow(
        `Shard count must be a positive safe integer, got ${total}.`,
      );
    }
  });

  it("rejects invalid item weights", () => {
    for (const weight of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => assignWeightedShards([{ name: "item", weight }], 1))
        .toThrow("Weight for item must be positive and finite.");
    }
  });

  it("places grouped items on distinct shards", () => {
    const assignments = assignWeightedShards([
      { name: "piece-1", weight: 5, group: "piece" },
      { name: "piece-2", weight: 5, group: "piece" },
      { name: "piece-3", weight: 5, group: "piece" },
    ], 3);

    expect(new Set(assignments.values()).size).toBe(3);
  });

  it("reuses shards when a group has more items than shards", () => {
    const assignments = assignWeightedShards([
      { name: "a", weight: 1, group: "one" },
      { name: "b", weight: 1, group: "one" },
    ], 1);

    expect([...assignments.values()]).toEqual([1, 1]);
  });

  it("rejects duplicate item names", () => {
    expect(() =>
      assignWeightedShards([
        { name: "same", weight: 1 },
        { name: "same", weight: 2 },
      ], 2)
    ).toThrow("Weighted shard item same appears more than once.");
  });
});
