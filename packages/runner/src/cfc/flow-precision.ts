import { internSchema } from "@commonfabric/data-model/schema-hash";
import type { JSONSchema } from "../builder/types.ts";
import type { ListOpArgumentUsage } from "../builtins/list-op-argument-usage.ts";
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

// Claims asserting that each output position derives only from the corresponding
// input element. They are unsound when the op reads the whole `array` or
// data-bearing `params` (a cross-key dependency), so they are dropped in that
// case. The remaining claims (PointwisePresencePreserved, StableRelativeOrder)
// are purely structural and hold regardless of what the op reads.
const ELEMENT_LOCAL_CLAIMS: ReadonlySet<FlowPrecisionClaimType> = new Set([
  "PointwiseWriteDependency",
  "ElementLocalExpansion",
]);

const allClaimsForBuiltin = (
  builtinId: BuiltinId,
): FlowPrecisionClaimType[] => {
  switch (builtinId) {
    case "map":
      return ["PointwisePresencePreserved", "PointwiseWriteDependency"];
    case "filter":
    case "flatMap":
      return ["ElementLocalExpansion", "StableRelativeOrder"];
  }
};

const claimForBuiltin = (
  builtinId: BuiltinId,
  argumentUsage?: ListOpArgumentUsage,
): FlowPrecisionClaim | undefined => {
  // A cross-key dependency exists when the callback reads the whole input list
  // or potentially-data-bearing params. `params` may be config-only, but we
  // cannot tell, so we drop the element-local claims conservatively.
  const crossKey = argumentUsage !== undefined &&
    (argumentUsage.usesArray || argumentUsage.usesParams);
  const claims = allClaimsForBuiltin(builtinId)
    .filter((type) => !crossKey || !ELEMENT_LOCAL_CLAIMS.has(type))
    .map((type) => ({ type }));
  if (claims.length === 0) {
    return undefined;
  }
  return { concept: FLOW_TAINT_PRECISION_CONCEPT, claims };
};

const buildFlowPrecisionSchema = (
  builtinId: BuiltinId,
  argumentUsage?: ListOpArgumentUsage,
): JSONSchema => {
  const claim = claimForBuiltin(builtinId, argumentUsage);
  // Note: `as JSONSchema` required since `ifc.flowPrecisionClaim` is not
  // defined as a property of `JSONSchema`.
  return internSchema({
    type: "array",
    ...(claim !== undefined && { ifc: { flowPrecisionClaim: claim } }),
  } as JSONSchema);
};

const isBuiltinId = (builtinId: string): builtinId is BuiltinId =>
  (BUILTIN_IDS as readonly string[]).includes(builtinId);

export const flowPrecisionSchemaForBuiltin = (
  builtinId: string,
  itemSchema?: JSONSchema,
  argumentUsage?: ListOpArgumentUsage,
): JSONSchema | undefined => {
  if (!isBuiltinId(builtinId)) {
    return undefined;
  }
  const schema = buildFlowPrecisionSchema(builtinId, argumentUsage);
  if (itemSchema === undefined) {
    return schema;
  }
  if (typeof schema === "boolean") return schema;
  if (typeof itemSchema === "boolean") {
    return internSchema({
      ...schema,
      items: itemSchema,
    });
  }
  const { $defs, ...itemSchemaWithoutDefs } = itemSchema;
  return internSchema({
    ...schema,
    items: itemSchemaWithoutDefs,
    ...($defs !== undefined && {
      $defs: {
        ...schema.$defs,
        ...$defs,
      },
    }),
  });
};

export const trustedFlowPrecisionSchemaForBuiltin = (
  identity: ImplementationIdentity | undefined,
  builtinId: string,
  itemSchema?: JSONSchema,
  argumentUsage?: ListOpArgumentUsage,
): JSONSchema | undefined => {
  if (identity?.kind !== "builtin" || identity.builtinId !== builtinId) {
    return undefined;
  }
  return flowPrecisionSchemaForBuiltin(builtinId, itemSchema, argumentUsage);
};
