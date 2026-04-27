import { internSchema } from "@commonfabric/data-model/schema-hash";
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

const BUILTIN_IDS = ["map", "filter", "flatMap"] as const;
type BuiltinId = (typeof BUILTIN_IDS)[number];

const claimForBuiltin = (
  builtinId: BuiltinId,
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
  }
};

const internFlowPrecisionSchema = (builtinId: BuiltinId): JSONSchema => {
  const claim = claimForBuiltin(builtinId);

  // Note: `as JSONSchema` required since `ifc.flowPrecisionClaim` is not
  // defined as a property of `JSONSchema`.
  return internSchema({
    type: "array",
    ifc: {
      flowPrecisionClaim: claim,
    },
  } as JSONSchema);
};

const FLOW_PRECISION_SCHEMAS = new Map<string, JSONSchema>(
  BUILTIN_IDS.map((id) => [id, internFlowPrecisionSchema(id)]),
);

export const flowPrecisionSchemaForBuiltin = (
  builtinId: string,
): JSONSchema | undefined => {
  return FLOW_PRECISION_SCHEMAS.get(builtinId);
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
