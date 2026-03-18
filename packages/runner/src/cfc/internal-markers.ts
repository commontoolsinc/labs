import type { CfcIntegrityLabel } from "./label-algebra.ts";
import type { ICfcReadAnnotations } from "../storage/interface.ts";

export const internalVerifierReadAnnotations: ICfcReadAnnotations = {
  internalVerifierRead: true,
};

export function hasInternalVerifierReadMarker(
  cfc: ICfcReadAnnotations | undefined,
): boolean {
  return cfc?.internalVerifierRead === true;
}

export function readMaxConfidentialityFromMeta(
  cfc: ICfcReadAnnotations | undefined,
): readonly string[] | undefined {
  const values = cfc?.maxConfidentiality;
  return values && values.length > 0 ? values : undefined;
}

export function readRequiredIntegrityFromMeta(
  cfc: ICfcReadAnnotations | undefined,
): CfcIntegrityLabel | undefined {
  const values = cfc?.requiredIntegrity;
  return values && values.length > 0 ? values : undefined;
}
