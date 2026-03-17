import type { JSONValue } from "@commontools/api";

export type CfcAtom = JSONValue;
export type CfcIntegrityLabel = readonly CfcAtom[];
export type CfcConfidentialityClause = readonly CfcAtom[];
export type CfcConfidentialityLabel = readonly CfcConfidentialityClause[];
export type CfcConfidentialityLabelInput =
  | readonly CfcAtom[]
  | readonly CfcConfidentialityClause[];
export type CfcIntegrityLabelInput = readonly CfcAtom[];

function normalizeJsonValue(value: unknown): JSONValue | undefined {
  if (
    value === null || typeof value === "string" || typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (Array.isArray(value)) {
    const normalized = value.map((entry) => normalizeJsonValue(entry));
    return normalized.every((entry) => entry !== undefined)
      ? normalized as JSONValue
      : undefined;
  }
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const normalized: Record<string, JSONValue> = {};
  for (const key of Object.keys(value).sort()) {
    const entry = normalizeJsonValue((value as Record<string, unknown>)[key]);
    if (entry === undefined) {
      return undefined;
    }
    normalized[key] = entry;
  }
  return normalized;
}

function canonicalKey(value: JSONValue): string {
  return JSON.stringify(value);
}

function normalizeAtom(value: unknown): CfcAtom | undefined {
  return normalizeJsonValue(value);
}

function normalizeClause(
  value: unknown,
): CfcConfidentialityClause | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const atoms = value
    .map((entry) => normalizeAtom(entry))
    .filter((entry): entry is CfcAtom => entry !== undefined);
  if (atoms.length === 0) {
    return undefined;
  }

  const byKey = new Map<string, CfcAtom>();
  for (const atom of atoms) {
    byKey.set(canonicalKey(atom), atom);
  }
  return [...byKey.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, atom]) => atom);
}

function isLegacySingleClauseShape(value: readonly unknown[]): boolean {
  return value.every((entry) => !Array.isArray(entry));
}

export function normalizeConfidentialityLabel(
  value: unknown,
): CfcConfidentialityLabel | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const clauses = isLegacySingleClauseShape(value)
    ? [normalizeClause(value)]
    : value.map((entry) => normalizeClause(entry));
  const presentClauses = clauses.filter(
    (entry): entry is CfcConfidentialityClause => entry !== undefined,
  );
  if (presentClauses.length === 0) {
    return undefined;
  }

  const byKey = new Map<string, CfcConfidentialityClause>();
  for (const clause of presentClauses) {
    byKey.set(canonicalKey(clause as JSONValue), clause);
  }
  return [...byKey.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, clause]) => clause);
}

export function normalizeIntegrityLabel(
  value: unknown,
): CfcIntegrityLabel | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const byKey = new Map<string, CfcAtom>();
  for (const entry of value) {
    const atom = normalizeAtom(entry);
    if (atom === undefined) {
      continue;
    }
    byKey.set(canonicalKey(atom), atom);
  }

  if (byKey.size === 0) {
    return undefined;
  }

  return [...byKey.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, atom]) => atom);
}

export function joinConfidentialityLabels(
  left: CfcConfidentialityLabelInput | CfcConfidentialityLabel | undefined,
  right: CfcConfidentialityLabelInput | CfcConfidentialityLabel | undefined,
): CfcConfidentialityLabel | undefined {
  const normalizedLeft = normalizeConfidentialityLabel(left);
  const normalizedRight = normalizeConfidentialityLabel(right);

  if (!normalizedLeft) {
    return normalizedRight;
  }
  if (!normalizedRight) {
    return normalizedLeft;
  }

  const byKey = new Map<string, CfcConfidentialityClause>();
  for (const clause of [...normalizedLeft, ...normalizedRight]) {
    const key = canonicalKey(clause as JSONValue);
    if (!byKey.has(key)) {
      byKey.set(key, clause);
    }
  }
  return [...byKey.values()];
}

export function joinIntegrityLabels(
  left: CfcIntegrityLabelInput | CfcIntegrityLabel | undefined,
  right: CfcIntegrityLabelInput | CfcIntegrityLabel | undefined,
): CfcIntegrityLabel | undefined {
  const normalizedLeft = normalizeIntegrityLabel(left);
  const normalizedRight = normalizeIntegrityLabel(right);

  if (!normalizedLeft) {
    return normalizedRight;
  }
  if (!normalizedRight) {
    return normalizedLeft;
  }

  const byKey = new Map<string, CfcAtom>();
  for (const atom of [...normalizedLeft, ...normalizedRight]) {
    const key = canonicalKey(atom);
    if (!byKey.has(key)) {
      byKey.set(key, atom);
    }
  }
  return [...byKey.values()];
}

export function confidentialityDominates(
  actual: CfcConfidentialityLabel | undefined,
  minimum: CfcConfidentialityLabel | undefined,
): boolean {
  if (!minimum || minimum.length === 0) {
    return true;
  }
  if (!actual || actual.length === 0) {
    return false;
  }

  return minimum.every((minimumClause) => {
    const minimumKeys = new Set(
      minimumClause.map((atom) => canonicalKey(atom)),
    );
    return actual.some((actualClause) =>
      actualClause.every((atom) => minimumKeys.has(canonicalKey(atom)))
    );
  });
}

export function confidentialitySatisfiesMax(
  actual: CfcConfidentialityLabel | undefined,
  max: CfcConfidentialityLabel | undefined,
): boolean {
  return confidentialityDominates(max, actual);
}

export function confidentialityFromLegacyAtom(
  classification: string | undefined,
): CfcConfidentialityLabel | undefined {
  if (!classification || classification.length === 0) {
    return undefined;
  }
  return normalizeConfidentialityLabel([classification]);
}
