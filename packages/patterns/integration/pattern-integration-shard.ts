export interface PatternIntegrationShard {
  index: number;
  total: number;
}

/**
 * Root patterns pinned to a named shard, overriding the round-robin in
 * `selectPatternIntegrationShard`. A pin holds a measured-expensive pattern
 * away from whichever shard already carries the heavy work. `all.test.ts`
 * rejects a key that names a pattern it does not run, so an entry here cannot
 * outlive its pattern. Empty means every root pattern takes the round-robin.
 */
export const COMPILE_ALL_PATTERN_SHARD_ASSIGNMENTS: Readonly<
  Record<string, number>
> = {};

export function parsePatternIntegrationShard(
  raw: string | undefined,
): PatternIntegrationShard {
  if (raw === undefined) return { index: 1, total: 1 };

  const match = raw.match(/^([1-9][0-9]*)\/([1-9][0-9]*)$/);
  if (!match) {
    throw new Error(
      `Invalid PATTERN_INTEGRATION_SHARD "${raw}"; expected "i/n" (1-based).`,
    );
  }

  const index = Number(match[1]);
  const total = Number(match[2]);
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(total)) {
    throw new Error(
      `Invalid PATTERN_INTEGRATION_SHARD "${raw}"; shard values must be safe integers.`,
    );
  }
  if (index > total) {
    throw new Error(`PATTERN_INTEGRATION_SHARD "${raw}" out of range.`);
  }

  return { index, total };
}

export function currentPatternIntegrationShard(): PatternIntegrationShard {
  return parsePatternIntegrationShard(
    Deno.env.get("PATTERN_INTEGRATION_SHARD"),
  );
}

export function selectPatternIntegrationShard<T>(
  items: readonly T[],
  shard: PatternIntegrationShard,
  assignedShard?: (item: T) => number | undefined,
): T[] {
  if (shard.total === 1) return [...items];

  return items.filter((item, itemIndex) => {
    const assigned = assignedShard?.(item);
    if (assigned !== undefined) {
      if (
        !Number.isSafeInteger(assigned) || assigned < 1 ||
        assigned > shard.total
      ) {
        throw new Error(
          `Assigned pattern integration shard ${assigned} out of range.`,
        );
      }
      return assigned === shard.index;
    }
    return itemIndex % shard.total === shard.index - 1;
  });
}
