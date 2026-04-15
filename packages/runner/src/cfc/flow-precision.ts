import { toDeepFrozenSchema } from "@commonfabric/data-model/schema-utils";
import type { JSONSchema } from "../builder/types.ts";
import type { ImplementationIdentity } from "./types.ts";

export const FLOW_TAINT_PRECISION_CONCEPT =
  "https://commonfabric.org/cfc/concepts/flow-taint-precision";

type FlowPrecisionClaimType =
  | "PointwisePresencePreserved"
  | "PointwiseWriteDependency"
  | "ElementLocalExpansion"
  | "StableRelativeOrder";

type FlowPrecisionClaim = {
  concept: typeof FLOW_TAINT_PRECISION_CONCEPT;
  claims: Array<{ type: FlowPrecisionClaimType }>;
};

const claimForBuiltin = (
  builtinId: string,
): FlowPrecisionClaim | undefined => {
  switch (builtinId) {
    case "map":
      return {
        concept: FLOW_TAINT_PRECISION_CONCEPT,
        claims: [
          { type: "PointwisePresencePreserved" },
          { type: "PointwiseWriteDependency" },
        ],
      };
    case "filter":
      return {
        concept: FLOW_TAINT_PRECISION_CONCEPT,
        claims: [
          { type: "ElementLocalExpansion" },
          { type: "StableRelativeOrder" },
        ],
      };
    case "flatMap":
      return {
        concept: FLOW_TAINT_PRECISION_CONCEPT,
        claims: [
          { type: "ElementLocalExpansion" },
          { type: "StableRelativeOrder" },
        ],
      };
    default:
      return undefined;
  }
};

export const flowPrecisionSchemaForBuiltin = (
  builtinId: string,
): JSONSchema | undefined => {
  const claim = claimForBuiltin(builtinId);
  if (!claim) {
    return undefined;
  }

  return toDeepFrozenSchema({
    type: "array",
    ifc: {
      flowPrecisionClaim: claim,
    },
  } as JSONSchema, true);
};

export const trustedFlowPrecisionSchemaForBuiltin = (
  identity: ImplementationIdentity | undefined,
  builtinId: string,
): JSONSchema | undefined => {
  if (identity?.kind !== "builtin" || identity.builtinId !== builtinId) {
    return undefined;
  }
  return flowPrecisionSchemaForBuiltin(builtinId);
};
