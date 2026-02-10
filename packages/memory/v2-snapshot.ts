/**
 * Memory v2 Snapshot Management
 *
 * Snapshots are materialized full values of entities at specific versions.
 * They accelerate reads by bounding the number of patches that must be replayed.
 *
 * @see spec 01-data-model.md §7
 * @module v2-snapshot
 */

import type { Database } from "@db/sqlite";
import type { EntityId, JSONValue, SnapshotPolicy } from "./v2-types.ts";
import { computeValueHash } from "./v2-reference.ts";
import { V2Space } from "./v2-space.ts";

/** Default snapshot policy: create snapshot after 10 patches. */
export const DEFAULT_SNAPSHOT_POLICY: SnapshotPolicy = {
  patchInterval: 10,
};

const COUNT_PATCHES_SINCE_SNAPSHOT = `
SELECT COUNT(*) as patch_count
FROM fact f
WHERE f.id = ?
  AND f.branch = ?
  AND f.fact_type = 'patch'
  AND f.version > COALESCE(
    (SELECT MAX(s.version) FROM snapshot s WHERE s.id = ? AND s.branch = ?),
    0
  )
  AND f.version <= ?;
`;

/**
 * Check whether a snapshot should be created for an entity after a patch.
 */
export function shouldCreateSnapshot(
  store: Database,
  branch: string,
  entityId: EntityId,
  version: number,
  policy: SnapshotPolicy = DEFAULT_SNAPSHOT_POLICY,
): boolean {
  const row = store.prepare(COUNT_PATCHES_SINCE_SNAPSHOT).get(
    entityId,
    branch,
    entityId,
    branch,
    version,
  ) as { patch_count: number } | undefined;

  return (row?.patch_count ?? 0) >= policy.patchInterval;
}

/**
 * Create a snapshot for an entity at a specific version.
 */
export function createSnapshot(
  space: V2Space,
  branch: string,
  entityId: EntityId,
  version: number,
  value: JSONValue,
): void {
  const valueHash = computeValueHash(value);
  const valueHashStr = valueHash.toString();
  space.insertValue(valueHashStr, JSON.stringify(value));
  space.insertSnapshot(entityId, version, valueHashStr, branch);
}
