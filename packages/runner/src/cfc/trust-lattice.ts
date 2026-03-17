import {
  type CfcIntegrityTrustOptions,
  integrityRequirementSatisfied,
} from "./integrity-trust.ts";
import {
  type CfcImplementationIdentity,
  encodeImplementationIdentity,
} from "./implementation-identity.ts";

export const FLOW_TAINT_PRECISION_CONCEPT =
  "https://commonfabric.org/cfc/concepts/flow-taint-precision";

export type CfcImplementationTrustEvaluator = (
  identity: CfcImplementationIdentity | undefined,
  concept: string,
  options?: CfcIntegrityTrustOptions,
) => boolean;

export function isImplementationTrustedForConcept(
  identity: CfcImplementationIdentity | undefined,
  concept: string,
  options: CfcIntegrityTrustOptions = {},
): boolean {
  if (!identity || identity.kind === "unknown") {
    return false;
  }
  return integrityRequirementSatisfied(
    encodeImplementationIdentity(identity),
    concept,
    options,
  );
}
