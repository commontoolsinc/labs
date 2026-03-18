import type { CfcAtom, CfcConfidentialityClause } from "./label-algebra.ts";

export function matchesCfcAtomPattern(
  actual: CfcAtom | undefined,
  pattern: CfcAtom,
): boolean {
  if (actual === undefined) {
    return false;
  }
  if (
    pattern === null || typeof pattern === "string" ||
    typeof pattern === "number" ||
    typeof pattern === "boolean"
  ) {
    return actual === pattern;
  }

  if (Array.isArray(pattern)) {
    if (!Array.isArray(actual) || actual.length !== pattern.length) {
      return false;
    }
    return pattern.every((entry, index) =>
      matchesCfcAtomPattern(actual[index] as CfcAtom | undefined, entry)
    );
  }

  if (!actual || typeof actual !== "object" || Array.isArray(actual)) {
    return false;
  }

  return Object.entries(pattern).every(([key, value]) =>
    matchesCfcAtomPattern(
      (actual as Record<string, CfcAtom | undefined>)[key],
      value as CfcAtom,
    )
  );
}

export function clauseMatchesAtomPatterns(
  clause: CfcConfidentialityClause,
  patterns: readonly CfcAtom[],
): boolean {
  return patterns.every((pattern) =>
    clause.some((atom) => matchesCfcAtomPattern(atom, pattern))
  );
}
