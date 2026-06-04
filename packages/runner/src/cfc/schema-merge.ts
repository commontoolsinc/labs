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
