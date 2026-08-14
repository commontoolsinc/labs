/** An independently runnable item with an optional placement group. */
export interface WeightedShardItem {
  /** Stable identifier used for assignment and tie-breaking. */
  name: string;
  /** Relative processing cost. */
  weight: number;
  /** Items in one group prefer different shards. */
  group?: string;
}

/**
 * Assigns weighted items to shards using longest-processing-time scheduling.
 *
 * Initial loads represent work already fixed to each shard. Placement adds
 * items to the lightest resulting load without modifying the supplied array.
 *
 * Items in the same group occupy distinct shards when the group fits. This
 * keeps slices of one package in separate workspace jobs when enough shards
 * are available; larger groups fall back to ordinary weighted placement.
 */
export function assignWeightedShards(
  items: WeightedShardItem[],
  total: number,
  initialLoads?: readonly number[],
): Map<string, number> {
  if (!Number.isSafeInteger(total) || total < 1) {
    throw new Error(
      `Shard count must be a positive safe integer, got ${total}.`,
    );
  }
  if (initialLoads && initialLoads.length !== total) {
    throw new Error(
      `Initial shard load count ${initialLoads.length} does not match shard count ${total}.`,
    );
  }

  const loads = initialLoads ? [...initialLoads] : Array(total).fill(0);
  for (const load of loads) {
    if (!Number.isFinite(load) || load < 0) {
      throw new Error("Initial shard loads must be non-negative and finite.");
    }
  }

  const groupCounts = new Map<string, number>();
  const names = new Set<string>();
  for (const item of items) {
    if (names.has(item.name)) {
      throw new Error(
        `Weighted shard item ${item.name} appears more than once.`,
      );
    }
    names.add(item.name);
    if (!Number.isFinite(item.weight) || item.weight <= 0) {
      throw new Error(`Weight for ${item.name} must be positive and finite.`);
    }
    if (!item.group) continue;
    groupCounts.set(item.group, (groupCounts.get(item.group) ?? 0) + 1);
  }

  const groupsByShard = Array.from(
    { length: total },
    () => new Set<string>(),
  );
  const assignments = new Map<string, number>();
  const sorted = [...items].sort((a, b) =>
    b.weight - a.weight || a.name.localeCompare(b.name)
  );

  for (const item of sorted) {
    let selected = -1;
    for (let shard = 0; shard < total; shard++) {
      if (
        item.group && (groupCounts.get(item.group) ?? 0) <= total &&
        groupsByShard[shard].has(item.group)
      ) continue;
      if (
        selected === -1 || loads[shard] < loads[selected] ||
        (loads[shard] === loads[selected] && shard < selected)
      ) {
        selected = shard;
      }
    }
    if (selected === -1) {
      throw new Error(`No shard can accept ${item.name}.`);
    }
    assignments.set(item.name, selected + 1);
    loads[selected] += item.weight;
    if (item.group) groupsByShard[selected].add(item.group);
  }

  return assignments;
}

/** Returns the modeled load carried by each shard. */
export function weightedShardLoads(
  items: WeightedShardItem[],
  total: number,
  initialLoads?: readonly number[],
): number[] {
  const assignments = assignWeightedShards(items, total, initialLoads);
  const loads = initialLoads ? [...initialLoads] : Array(total).fill(0);
  for (const item of items) {
    const shard = assignments.get(item.name);
    if (shard === undefined) throw new Error(`No assignment for ${item.name}.`);
    loads[shard - 1] += item.weight;
  }
  return loads;
}
