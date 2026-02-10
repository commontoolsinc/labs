/**
 * Memory v2 Garbage Collection
 *
 * Reclaims space by removing old facts, orphaned values, and redundant
 * snapshots. GC is a background task that never runs during commits.
 *
 * @see spec 02-storage.md §7
 * @module v2-gc
 */

import type { Database } from "@db/sqlite";

// ---------------------------------------------------------------------------
// GC Options
// ---------------------------------------------------------------------------

export interface GCOptions {
  /**
   * Retention version: facts at or above this version are never collected.
   * Defaults to 0 (collect everything eligible).
   */
  retentionVersion?: number;
  /**
   * Whether to compact old snapshots (keep only the latest per entity/branch).
   * Defaults to true.
   */
  compactSnapshots?: boolean;
}

export interface GCResult {
  factsRemoved: number;
  valuesRemoved: number;
  snapshotsRemoved: number;
}

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

/**
 * Delete facts that are:
 * 1. Below the retention version
 * 2. Not referenced as `parent` by any other fact
 * 3. Not referenced by the head table (still the current head for an entity)
 */
const COMPACT_FACTS = `
DELETE FROM fact
WHERE version < ?
  AND hash NOT IN (SELECT parent FROM fact WHERE parent IS NOT NULL)
  AND hash NOT IN (SELECT fact_hash FROM head);
`;

/**
 * Delete values not referenced by any fact or snapshot.
 * The __empty__ sentinel is preserved.
 */
const REMOVE_ORPHANED_VALUES = `
DELETE FROM value
WHERE hash != '__empty__'
  AND hash NOT IN (SELECT value_ref FROM fact)
  AND hash NOT IN (SELECT value_ref FROM snapshot);
`;

/**
 * Delete old snapshots, keeping only the latest per entity per branch.
 */
const COMPACT_SNAPSHOTS = `
DELETE FROM snapshot
WHERE rowid NOT IN (
  SELECT rowid FROM snapshot s2
  WHERE s2.version = (
    SELECT MAX(s3.version)
    FROM snapshot s3
    WHERE s3.branch = s2.branch AND s3.id = s2.id
  )
);
`;

// ---------------------------------------------------------------------------
// GC execution
// ---------------------------------------------------------------------------

/**
 * Run garbage collection on a v2 space database.
 *
 * @see spec 02-storage.md §7
 */
export function runGC(store: Database, options: GCOptions = {}): GCResult {
  const retentionVersion = options.retentionVersion ?? 0;
  const compactSnapshots = options.compactSnapshots ?? true;

  return store.transaction(() => {
    // 1. Fact compaction
    const factsResult = store.prepare(COMPACT_FACTS).run(retentionVersion);
    const factsRemoved = factsResult;

    // 2. Orphaned values
    const valuesResult = store.prepare(REMOVE_ORPHANED_VALUES).run();
    const valuesRemoved = valuesResult;

    // 3. Snapshot compaction
    let snapshotsRemoved = 0;
    if (compactSnapshots) {
      const snapResult = store.prepare(COMPACT_SNAPSHOTS).run();
      snapshotsRemoved = snapResult;
    }

    return {
      factsRemoved: factsRemoved as unknown as number,
      valuesRemoved: valuesRemoved as unknown as number,
      snapshotsRemoved: snapshotsRemoved as unknown as number,
    };
  }).immediate();
}
