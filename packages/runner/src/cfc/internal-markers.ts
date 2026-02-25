import type { Metadata } from "../storage/interface.ts";

export const INTERNAL_VERIFIER_READ_MARKER = "internalVerifierRead" as const;
export const CFC_READ_MAX_CONFIDENTIALITY_MARKER =
  "cfcReadMaxConfidentiality" as const;

export const internalVerifierReadMeta: Metadata = {
  [INTERNAL_VERIFIER_READ_MARKER]: true,
};

export function hasInternalVerifierReadMarker(
  meta: Metadata | undefined,
): boolean {
  return Boolean(meta?.[INTERNAL_VERIFIER_READ_MARKER]);
}

export function readMaxConfidentialityFromMeta(
  meta: Metadata | undefined,
): readonly string[] | undefined {
  const raw = meta?.[CFC_READ_MAX_CONFIDENTIALITY_MARKER];
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const values = raw.filter((entry): entry is string =>
    typeof entry === "string" && entry.length > 0
  );
  return values.length > 0 ? values : undefined;
}
