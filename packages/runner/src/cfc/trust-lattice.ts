import {
  type CfcImplementationIdentity,
  encodeImplementationIdentity,
} from "./implementation-identity.ts";

export const FLOW_TAINT_PRECISION_CONCEPT =
  "https://commonfabric.org/cfc/concepts/flow-taint-precision";

const trustedConceptsByIdentity = new Map<string, ReadonlySet<string>>([
  [
    "Builtin(map)",
    new Set<string>([FLOW_TAINT_PRECISION_CONCEPT]),
  ],
]);

export function isImplementationTrustedForConcept(
  identity: CfcImplementationIdentity | undefined,
  concept: string,
): boolean {
  const trustedConcepts = trustedConceptsByIdentity.get(
    encodeImplementationIdentity(identity),
  );
  return trustedConcepts?.has(concept) === true;
}
