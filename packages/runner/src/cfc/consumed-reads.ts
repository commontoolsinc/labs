import type { Activity } from "../storage/interface.ts";
import {
  type CanonicalBoundaryRead,
  canonicalizeBoundaryActivity,
} from "./canonical-activity.ts";

export interface PartitionedBoundaryReads {
  readonly consumedReads: readonly CanonicalBoundaryRead[];
  readonly internalVerifierReads: readonly CanonicalBoundaryRead[];
}

export function partitionConsumedBoundaryReads(
  activity: Iterable<Activity>,
): PartitionedBoundaryReads {
  const canonical = canonicalizeBoundaryActivity(activity);
  const consumedReads: CanonicalBoundaryRead[] = [];
  const internalVerifierReads: CanonicalBoundaryRead[] = [];

  for (const read of canonical.reads) {
    if (read.internalVerifierRead) {
      internalVerifierReads.push(read);
      continue;
    }
    consumedReads.push(read);
  }

  return { consumedReads, internalVerifierReads };
}
