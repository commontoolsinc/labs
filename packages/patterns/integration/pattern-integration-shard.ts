export interface PatternIntegrationShard {
  index: number;
  total: number;
}

export function parsePatternIntegrationShard(
  raw: string | undefined,
): PatternIntegrationShard {
  if (!raw) return { index: 1, total: 1 };

  const match = raw.match(/^([1-9][0-9]*)\/([1-9][0-9]*)$/);
  if (!match) {
    throw new Error(
      `Invalid PATTERN_INTEGRATION_SHARD "${raw}"; expected "i/n" (1-based).`,
    );
  }

  const index = Number(match[1]);
  const total = Number(match[2]);
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
): T[] {
  return items.filter((_, itemIndex) =>
    itemIndex % shard.total === shard.index - 1
  );
}
