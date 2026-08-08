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
