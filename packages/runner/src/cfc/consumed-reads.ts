import type {
  CanonicalBoundaryActivity,
  CanonicalBoundaryRead,
} from "./canonical-activity.ts";

export interface PartitionedBoundaryReads {
  readonly consumedReads: readonly CanonicalBoundaryRead[];
  readonly internalVerifierReads: readonly CanonicalBoundaryRead[];
}

export function partitionConsumedBoundaryReads(
  canonical: CanonicalBoundaryActivity,
): PartitionedBoundaryReads {
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
