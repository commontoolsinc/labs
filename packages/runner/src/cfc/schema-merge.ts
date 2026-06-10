import { internSchema } from "@commonfabric/data-model/schema-hash";
import { deepEqual } from "@commonfabric/utils/deep-equal";
import { isRecord } from "@commonfabric/utils/types";
import type { JSONSchema, JSONSchemaObj } from "../builder/types.ts";

const IFC_KEYS = [
  "confidentiality",
  "integrity",
  "addIntegrity",
  "requiredIntegrity",
  "maxConfidentiality",
  "ownerPrincipal",
  "writeAuthorizedBy",
  "exactCopyOf",
  "projection",
  "collection",
  // Reserved legacy key: no longer minted (the list builtins' per-element
  // transactions make pointwise precision structural) and consumed by
  // nothing, but already-persisted link schemas embed it, so merging must
  // keep tolerating it.
  "flowPrecisionClaim",
  "uiContract",
] as const;

const asSchemaObject = (
  schema: JSONSchema,
  path: string,
): JSONSchemaObj => {
  if (schema === true) {
    return {};
  }
  if (!isRecord(schema)) {
    throw new Error(`unsupported schema form at ${path || "/"}`);
  }
  return schema as JSONSchemaObj;
};

const arraySubsetOf = (
  subset: readonly unknown[],
  superset: readonly unknown[],
): boolean =>
  subset.every((value) =>
    superset.some((candidate) => deepEqual(candidate, value))
  );

const mergeArraySet = (
  ...sources: Array<readonly unknown[]>
): unknown[] => {
  const result: unknown[] = [];
  for (const source of sources) {
    for (const value of source) {
      if (!result.some((candidate) => deepEqual(candidate, value))) {
        result.push(value);
      }
    }
  }
  return result;
};

type WriterIdentityClaim = {
  __ctWriterIdentityOf: Record<string, unknown>;
};

const isWriterIdentityClaim = (value: unknown): value is WriterIdentityClaim =>
  isRecord(value) && isRecord(value.__ctWriterIdentityOf);

/**
 * Reconcile two `writeAuthorizedBy` writer-identity claims that differ only
 * by the presence of the `bundleId` provenance stamp (one side recorded under
 * a verified identity, the other without one). Returns the stamped claim, or
 * `undefined` when the claims genuinely conflict (different bindings, or two
 * different stamps).
 */
const reconcileWriterClaimStamp = (
  existing: unknown,
  candidate: unknown,
): unknown | undefined => {
  if (!isWriterIdentityClaim(existing) || !isWriterIdentityClaim(candidate)) {
    return undefined;
  }
  const existingIdentity = existing.__ctWriterIdentityOf;
  const candidateIdentity = candidate.__ctWriterIdentityOf;
  const existingStamp = existingIdentity.bundleId;
  const candidateStamp = candidateIdentity.bundleId;
  // Exactly one side stamped — otherwise deepEqual already decided (equal
  // stamps) or this is a genuine conflict (two different stamps).
  if ((existingStamp === undefined) === (candidateStamp === undefined)) {
    return undefined;
  }
  const { bundleId: _existingBundle, ...existingRest } = existingIdentity;
  const { bundleId: _candidateBundle, ...candidateRest } = candidateIdentity;
  if (
    !deepEqual(
      { ...existing, __ctWriterIdentityOf: existingRest },
      { ...candidate, __ctWriterIdentityOf: candidateRest },
    )
  ) {
    return undefined;
  }
  return existingStamp !== undefined ? existing : candidate;
};

const mergeSetLikeIfcArray = (
  key: string,
  existing: unknown,
  candidate: unknown,
  path: string,
): unknown => {
  if (existing === undefined) {
    return candidate;
  }
  if (candidate === undefined) {
    return existing;
  }

  switch (key) {
    case "requiredIntegrity":
    case "confidentiality":
    case "addIntegrity": {
      if (!Array.isArray(existing) || !Array.isArray(candidate)) {
        if (!deepEqual(existing, candidate)) {
          throw new Error(`${key} must remain stable at ${path || "/"}`);
        }
        return existing;
      }
      const existingArray = existing as readonly unknown[];
      const candidateArray = candidate as readonly unknown[];
      if (!arraySubsetOf(existingArray, candidateArray)) {
        throw new Error(`${key} cannot be weakened at ${path || "/"}`);
      }
      return mergeArraySet(existingArray, candidateArray);
    }
    case "integrity":
    case "maxConfidentiality":
    case "writeAuthorizedBy": {
      if (
        !Array.isArray(existing) || !Array.isArray(candidate) ||
        !existing.every((entry) => typeof entry === "string") ||
        !candidate.every((entry) => typeof entry === "string")
      ) {
        if (!deepEqual(existing, candidate)) {
          // One transaction can record the same protected field through a
          // schema input whose `writeAuthorizedBy` claim was rebound with the
          // authoring identity's bundleId and one recorded without an
          // identity (unstamped). The BINDING (file + path) is what the claim
          // means; the bundle stamp is provenance added per input. Mirror
          // prepare's `schemasEqualIgnoringWriterBundleIds` tolerance and
          // keep the stamped claim. Two DIFFERENT stamps (or different
          // bindings) still conflict.
          if (key === "writeAuthorizedBy") {
            const reconciled = reconcileWriterClaimStamp(existing, candidate);
            if (reconciled !== undefined) {
              return reconciled;
            }
          }
          throw new Error(`${key} must remain stable at ${path || "/"}`);
        }
        return existing;
      }
      const existingArray = existing as readonly unknown[];
      const candidateArray = candidate as readonly unknown[];
      if (!arraySubsetOf(candidateArray, existingArray)) {
        throw new Error(`${key} cannot be weakened at ${path || "/"}`);
      }
      return mergeArraySet(candidateArray);
    }
    case "exactCopyOf":
    case "projection":
    case "collection":
    case "ownerPrincipal":
      if (!deepEqual(existing, candidate)) {
        throw new Error(`${key} must remain stable at ${path || "/"}`);
      }
      return existing;
    case "flowPrecisionClaim":
    case "uiContract":
      if (!deepEqual(existing, candidate)) {
        throw new Error(`${key} must remain stable at ${path || "/"}`);
      }
      return existing;
    default:
      return candidate;
  }
};

const mergeIfc = (
  existing: JSONSchemaObj["ifc"],
  candidate: JSONSchemaObj["ifc"],
  path: string,
): JSONSchemaObj["ifc"] => {
  if (existing === undefined) {
    return candidate;
  }
  if (candidate === undefined) {
    return existing;
  }

  const existingIfc = existing as Record<string, unknown>;
  const candidateIfc = candidate as Record<string, unknown>;
  const merged: Record<string, unknown> = {};
  for (const key of IFC_KEYS) {
    merged[key] = mergeSetLikeIfcArray(
      key,
      existingIfc[key],
      candidateIfc[key],
      path,
    );
  }
  return merged as JSONSchemaObj["ifc"];
};

const branchContainsIfc = (schema: JSONSchema): boolean => {
  if (!isRecord(schema)) {
    return false;
  }
  const object = schema as JSONSchemaObj;
  if (object.ifc !== undefined) {
    return true;
  }
  return [
    ...(object.anyOf ?? []),
    ...(object.oneOf ?? []),
    ...(object.allOf ?? []),
    ...(object.prefixItems ?? []),
    ...(object.items ? [object.items] : []),
    ...(object.properties ? Object.values(object.properties) : []),
    ...(object.$defs ? Object.values(object.$defs) : []),
    ...(isRecord(object.additionalProperties)
      ? [object.additionalProperties as JSONSchema]
      : []),
  ].some(branchContainsIfc);
};

const assertNoDivergentIfcBranches = (
  schema: JSONSchema,
  path = "",
): void => {
  if (!isRecord(schema)) {
    return;
  }
  const object = schema as JSONSchemaObj;
  const branchGroups = [
    object.anyOf ? ["anyOf", object.anyOf] as const : undefined,
    object.oneOf ? ["oneOf", object.oneOf] as const : undefined,
    object.allOf ? ["allOf", object.allOf] as const : undefined,
  ].filter((value) => value !== undefined);

  for (const [kind, branches] of branchGroups) {
    if (branches.some(branchContainsIfc)) {
      throw new Error(
        `ifc inside divergent ${kind} branches is unsupported at ${
          path || "/"
        }`,
      );
    }
  }

  for (const [key, value] of Object.entries(object.properties ?? {})) {
    assertNoDivergentIfcBranches(value, `${path}/${key}`);
  }
  if (object.items !== undefined) {
    assertNoDivergentIfcBranches(object.items, `${path}/*`);
  }
};

const mergeRequired = (
  existing: readonly string[] | undefined,
  candidate: readonly string[] | undefined,
  mergedProperties: Readonly<Record<string, JSONSchema>>,
): readonly string[] | undefined => {
  if (existing === undefined && candidate === undefined) {
    return undefined;
  }
  const merged = [...new Set([...(existing ?? []), ...(candidate ?? [])])];
  for (const name of merged) {
    if ((existing ?? []).includes(name) || !(candidate ?? []).includes(name)) {
      continue;
    }
    const property = mergedProperties[name];
    if (!isRecord(property) || property.default === undefined) {
      throw new Error(
        `required field ${name} needs a default to preserve old documents`,
      );
    }
  }
  return merged;
};

const mergeDefaults = (
  existing: JSONSchemaObj["default"],
  candidate: JSONSchemaObj["default"],
): JSONSchemaObj["default"] => {
  if (existing === undefined) {
    return candidate;
  }
  if (candidate === undefined) {
    return existing;
  }
  if (isRecord(existing) && isRecord(candidate)) {
    return { ...existing, ...candidate };
  }
  return candidate;
};

const mergeSchemaNode = (
  existing: JSONSchema,
  candidate: JSONSchema,
  path = "",
): JSONSchema => {
  const left = asSchemaObject(existing, path);
  const right = asSchemaObject(candidate, path);

  const leftTypes = left.type === undefined
    ? undefined
    : Array.isArray(left.type)
    ? [...left.type]
    : [left.type];
  const rightTypes = right.type === undefined
    ? undefined
    : Array.isArray(right.type)
    ? [...right.type]
    : [right.type];
  if (
    leftTypes !== undefined &&
    rightTypes !== undefined &&
    (leftTypes.length !== rightTypes.length ||
      !arraySubsetOf(leftTypes, rightTypes) ||
      !arraySubsetOf(rightTypes, leftTypes))
  ) {
    throw new Error(
      `type changed incompatibly at ${path || "/"}: ${
        JSON.stringify(leftTypes)
      } -> ${JSON.stringify(rightTypes)}`,
    );
  }

  const mergedProperties: Record<string, JSONSchema> = {
    ...(left.properties ?? {}),
  };
  for (const [key, value] of Object.entries(right.properties ?? {})) {
    mergedProperties[key] = key in mergedProperties
      ? mergeSchemaNode(
        mergedProperties[key],
        value,
        `${path}/${key}`,
      )
      : value;
  }

  let mergedItems = left.items;
  if (left.items !== undefined && right.items !== undefined) {
    mergedItems = mergeSchemaNode(left.items, right.items, `${path}/*`);
  } else if (right.items !== undefined) {
    mergedItems = right.items;
  }

  return {
    ...left,
    ...right,
    ...(Object.keys(mergedProperties).length > 0
      ? { properties: mergedProperties }
      : {}),
    ...(mergedItems !== undefined ? { items: mergedItems } : {}),
    ifc: mergeIfc(left.ifc, right.ifc, path),
    required: mergeRequired(left.required, right.required, mergedProperties),
    default: mergeDefaults(left.default, right.default),
  };
};

export const mergeCfcSchemaEnvelopes = (
  existing: JSONSchema,
  candidate: JSONSchema,
): JSONSchema => {
  assertNoDivergentIfcBranches(existing);
  assertNoDivergentIfcBranches(candidate);
  return internSchema(mergeSchemaNode(existing, candidate));
};
