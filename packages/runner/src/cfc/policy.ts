/**
 * Policy records — named collections of exchange rules that govern
 * declassification within a space.
 */

import type { ExchangeRule } from "./exchange-rules.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PolicyRecord = {
  readonly id: string;
  readonly exchangeRules: ExchangeRule[];
  readonly version: number;
};

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

/**
 * Simple djb2 string hash. This is used for identity (content addressing),
 * not for security purposes.
 */
function djb2(input: string): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash + input.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(16);
}

/** JSON.stringify with sorted keys for deterministic serialization. */
function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return JSON.stringify(value);
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map(stableStringify).join(",") + "]";
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const entries = keys.map(
    (k) =>
      JSON.stringify(k) +
      ":" +
      stableStringify((value as Record<string, unknown>)[k]),
  );
  return "{" + entries.join(",") + "}";
}

/** Compute a deterministic content hash for a policy (excluding its id). */
export function hashPolicy(policy: Omit<PolicyRecord, "id">): string {
  return djb2(stableStringify(policy));
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

/** Create a policy record with a computed content-hash id. */
export function createPolicy(
  rules: ExchangeRule[],
  version: number = 1,
): PolicyRecord {
  const body = { exchangeRules: rules, version };
  return { id: hashPolicy(body), ...body };
}

// ---------------------------------------------------------------------------
// Default policy
// ---------------------------------------------------------------------------

/**
 * Default policy: no exchange rules. The static label checks in the
 * confidentiality/integrity lattice handle backwards-compatible classification
 * behavior without any declassification.
 */
export const DEFAULT_POLICY: PolicyRecord = createPolicy([], 1);
