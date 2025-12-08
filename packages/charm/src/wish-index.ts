import {
  type Cell,
  type IRuntime,
  type JSONSchema,
  type Schema,
  type WishIndexEntry,
} from "@commontools/runner";

// Constants
const MAX_ENTRIES = 100;
const STALENESS_DAYS = 7;
const STALENESS_MS = STALENESS_DAYS * 24 * 60 * 60 * 1000;

export const wishIndexEntrySchema = {
  type: "object",
  properties: {
    query: { type: "string" },
    resultCell: { not: true, asCell: true },
    patternUrl: { type: "string" },
    timestamp: { type: "number" },
  },
  required: ["query", "resultCell", "timestamp"],
} as const satisfies JSONSchema;

export type WishIndexEntrySchema = Schema<typeof wishIndexEntrySchema>;

export const wishIndexListSchema = {
  type: "array",
  items: wishIndexEntrySchema,
} as const satisfies JSONSchema;

export type WishIndexList = Schema<typeof wishIndexListSchema>;

/**
 * Get the wish index cell from the home space (singleton across all spaces).
 */
export function getWishIndex(runtime: IRuntime): Cell<WishIndexEntry[]> {
  return runtime.getHomeSpaceCell().key("wishIndex").asSchema(
    wishIndexListSchema,
  ) as Cell<WishIndexEntry[]>;
}

/**
 * Add an entry to the wish index.
 * Implements FIFO eviction when MAX_ENTRIES is exceeded.
 */
export async function addWishIndexEntry(
  runtime: IRuntime,
  entry: Omit<WishIndexEntry, "timestamp">,
): Promise<void> {
  const wishIndex = getWishIndex(runtime);
  await wishIndex.sync();

  await runtime.editWithRetry((tx) => {
    const indexWithTx = wishIndex.withTx(tx);
    const currentEntries = indexWithTx.get() || [];

    // Add new entry with timestamp at the front (most recent first)
    const newEntry: WishIndexEntry = {
      ...entry,
      timestamp: Date.now(),
    };
    let entries: WishIndexEntry[] = [newEntry, ...currentEntries];

    // FIFO eviction if over limit
    if (entries.length > MAX_ENTRIES) {
      entries = entries.slice(0, MAX_ENTRIES);
    }

    indexWithTx.set(entries);
  });

  await runtime.idle();
}

/**
 * Get recent (non-stale) entries from the wish index.
 * Returns entries from the last STALENESS_DAYS days.
 */
export function getRecentWishIndexEntries(
  runtime: IRuntime,
): WishIndexEntry[] {
  try {
    const wishIndex = getWishIndex(runtime);
    const entries = wishIndex.get() || [];
    const cutoff = Date.now() - STALENESS_MS;

    return [...entries].filter(
      (entry: WishIndexEntry) => entry.timestamp > cutoff,
    );
  } catch (_error) {
    // If we can't access the home space, return empty
    return [];
  }
}

/**
 * Remove a specific entry from the wish index.
 * Matches on query and timestamp to identify the entry.
 * @returns true if the entry was removed
 */
export async function removeWishIndexEntry(
  runtime: IRuntime,
  entry: Pick<WishIndexEntry, "query" | "timestamp">,
): Promise<boolean> {
  const wishIndex = getWishIndex(runtime);
  await wishIndex.sync();

  let removed = false;
  const result = await runtime.editWithRetry((tx) => {
    const indexWithTx = wishIndex.withTx(tx);
    const entries = indexWithTx.get() || [];
    const filtered: WishIndexEntry[] = [...entries].filter(
      (e) => e.query !== entry.query || e.timestamp !== entry.timestamp,
    );
    if (filtered.length !== entries.length) {
      indexWithTx.set(filtered);
      removed = true;
    }
  });

  return result.ok !== undefined && removed;
}

/**
 * Clear all entries from the wish index.
 */
export async function clearWishIndex(runtime: IRuntime): Promise<void> {
  const wishIndex = getWishIndex(runtime);
  await wishIndex.sync();

  await runtime.editWithRetry((tx) => {
    wishIndex.withTx(tx).set([]);
  });

  await runtime.idle();
}

/**
 * Get the staleness threshold in milliseconds.
 */
export function getStalenessMsThreshold(): number {
  return STALENESS_MS;
}

/**
 * Get the maximum number of entries allowed in the wish index.
 */
export function getMaxEntries(): number {
  return MAX_ENTRIES;
}
