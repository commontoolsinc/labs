import { matchesCfcAtomPattern } from "./atom-patterns.ts";
import type { CfcEventEnvelope } from "./event-envelope.ts";

export interface CfcEventIntegrityViolationError extends Error {
  name: "CfcEventIntegrityViolationError";
  missingPatterns: readonly Record<string, unknown>[];
  receivedIntegrity: readonly unknown[];
  requirementLabel?: string;
}

function hasIntegrityAtom(
  integrity: readonly unknown[],
  pattern: Record<string, unknown>,
): boolean {
  return integrity.some((atom) =>
    matchesCfcAtomPattern(atom as never, pattern as never)
  );
}

export function findMissingEventIntegrityPatterns(
  integrity: readonly unknown[],
  requiredPatterns: readonly Record<string, unknown>[],
): readonly Record<string, unknown>[] {
  return requiredPatterns.filter((pattern) =>
    !hasIntegrityAtom(integrity, pattern)
  );
}

export function createCfcEventIntegrityViolationError(
  requiredPatterns: readonly Record<string, unknown>[],
  event: Pick<CfcEventEnvelope<unknown>, "integrity"> | undefined,
  requirementLabel?: string,
): CfcEventIntegrityViolationError {
  const receivedIntegrity = event?.integrity ?? [];
  const missingPatterns = findMissingEventIntegrityPatterns(
    receivedIntegrity,
    requiredPatterns,
  );
  const label = requirementLabel ? ` for ${requirementLabel}` : "";
  const error = new Error(
    `Missing required event integrity${label}: ${
      JSON.stringify(missingPatterns)
    }`,
  ) as CfcEventIntegrityViolationError;
  error.name = "CfcEventIntegrityViolationError";
  error.missingPatterns = missingPatterns;
  error.receivedIntegrity = receivedIntegrity;
  error.requirementLabel = requirementLabel;
  return error;
}

export function assertRequiredEventIntegrity(
  event: Pick<CfcEventEnvelope<unknown>, "integrity"> | undefined,
  requiredPatterns: readonly Record<string, unknown>[],
  requirementLabel?: string,
): void {
  const missingPatterns = findMissingEventIntegrityPatterns(
    event?.integrity ?? [],
    requiredPatterns,
  );
  if (missingPatterns.length === 0) return;
  throw createCfcEventIntegrityViolationError(
    requiredPatterns,
    event,
    requirementLabel,
  );
}
