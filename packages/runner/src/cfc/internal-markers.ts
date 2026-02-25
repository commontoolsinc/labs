import type { Metadata } from "../storage/interface.ts";

export const INTERNAL_VERIFIER_READ_MARKER = "internalVerifierRead" as const;

export const internalVerifierReadMeta: Metadata = {
  [INTERNAL_VERIFIER_READ_MARKER]: true,
};

export function hasInternalVerifierReadMarker(
  meta: Metadata | undefined,
): boolean {
  return Boolean(meta?.[INTERNAL_VERIFIER_READ_MARKER]);
}
