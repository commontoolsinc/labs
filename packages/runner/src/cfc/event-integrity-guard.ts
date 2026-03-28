import type { CfcEventEnvelope } from "./event-envelope.ts";
import { integrityRequirementSatisfied, type CfcIntegrityTrustOptions } from "./integrity-trust.ts";
import type { CfcAtom } from "./label-algebra.ts";

export interface CfcEventIntegrityViolationError extends Error {
  name: "CfcEventIntegrityViolationError";
  missingPatterns: readonly CfcAtom[];
  receivedIntegrity: readonly unknown[];
  requirementLabel?: string;
}

function hasIntegrityAtom(
  integrity: readonly CfcAtom[],
  requirement: CfcAtom,
  options: CfcIntegrityTrustOptions = {},
): boolean {
  return integrity.some((atom) =>
    integrityRequirementSatisfied(atom, requirement, options)
  );
}

export function findMissingEventIntegrityPatterns(
  integrity: readonly unknown[],
  requiredPatterns: readonly CfcAtom[],
  options: CfcIntegrityTrustOptions = {},
): readonly CfcAtom[] {
  const actualIntegrity = integrity.filter((atom): atom is CfcAtom =>
    typeof atom === "string" ||
    Boolean(atom && typeof atom === "object" && !Array.isArray(atom))
  );
  return requiredPatterns.filter((pattern) =>
    !hasIntegrityAtom(actualIntegrity, pattern, options)
  );
}

export function createCfcEventIntegrityViolationError(
  requiredPatterns: readonly CfcAtom[],
  event: Pick<CfcEventEnvelope<unknown>, "integrity"> | undefined,
  requirementLabel?: string,
  options: CfcIntegrityTrustOptions = {},
): CfcEventIntegrityViolationError {
  const receivedIntegrity = event?.integrity ?? [];
  const missingPatterns = findMissingEventIntegrityPatterns(
    receivedIntegrity,
    requiredPatterns,
    options,
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
  requiredPatterns: readonly CfcAtom[],
  requirementLabel?: string,
  options: CfcIntegrityTrustOptions = {},
): void {
  const missingPatterns = findMissingEventIntegrityPatterns(
    event?.integrity ?? [],
    requiredPatterns,
    options,
  );
  if (missingPatterns.length === 0) return;
  throw createCfcEventIntegrityViolationError(
    requiredPatterns,
    event,
    requirementLabel,
    options,
  );
}
