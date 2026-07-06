import { internSchema } from "@commonfabric/data-model/schema-hash";
import { deepEqual } from "@commonfabric/utils/deep-equal";
import { isRecord } from "@commonfabric/utils/types";
import type { JSONSchema, JSONSchemaObj } from "../builder/types.ts";
import { normalizeClause } from "./clause.ts";

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

// The per-input provenance fields a verified write may have stamped onto a
// writer-identity claim. New claims carry only the content-addressed
// `moduleIdentity` (prepare's rebind; see implementation-identity.ts
// `resolveProvenanceImplementationIdentity`), but pre-migration stored/fixture
// claims may still carry a legacy `bundleId` — so reconciliation strips BOTH.
// The BINDING (file + path) is what the claim means; these fields only record
// which verified module/load produced the input.
const WRITER_CLAIM_STAMP_KEYS = ["bundleId", "moduleIdentity"] as const;

const writerClaimIsStamped = (identity: Record<string, unknown>): boolean =>
  WRITER_CLAIM_STAMP_KEYS.some((key) => identity[key] !== undefined);

const writerClaimWithoutStamp = (
  identity: Record<string, unknown>,
): Record<string, unknown> => {
  const rest = { ...identity };
  for (const key of WRITER_CLAIM_STAMP_KEYS) delete rest[key];
  return rest;
};

/**
 * Reconcile two `writeAuthorizedBy` writer-identity claims that differ only
 * by the presence of the provenance stamp (`moduleIdentity`, or a legacy
 * `bundleId` on pre-migration claims — one side recorded under a verified
 * identity, the other without one). Returns the stamped claim, or `undefined`
 * when the claims genuinely conflict (different bindings, or two different
 * stamps).
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
  const existingStamped = writerClaimIsStamped(existingIdentity);
  const candidateStamped = writerClaimIsStamped(candidateIdentity);
  // Exactly one side stamped — otherwise deepEqual already decided (equal
  // stamps) or this is a genuine conflict (two different stamps).
  if (existingStamped === candidateStamped) {
    return undefined;
  }
  if (
    !deepEqual(
      {
        ...existing,
        __ctWriterIdentityOf: writerClaimWithoutStamp(existingIdentity),
      },
      {
        ...candidate,
        __ctWriterIdentityOf: writerClaimWithoutStamp(candidateIdentity),
      },
    )
  ) {
    return undefined;
  }
  return existingStamped ? existing : candidate;
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
      // Confidentiality is CNF clauses (Epic A4): normalize each clause before
      // the subset/merge comparison so two order-differing OR-clauses
      // (`{anyOf:[A,B]}` vs `{anyOf:[B,A]}`) presented across schema inputs or
      // successive writes compare EQUAL — otherwise the raw-`deepEqual` subset
      // check would reject the re-presented clause as a weakening. This runs
      // before `derivePersistedLabel`'s persist-time normalization, closing
      // the same-transaction / two-input reorder gap. `normalizeClause` is
      // identity on flat atoms and integrity carries no OR-clauses, so the
      // other keys are untouched.
      const existingArray = key === "confidentiality"
        ? (existing as readonly unknown[]).map(normalizeClause)
        : existing as readonly unknown[];
      const candidateArray = key === "confidentiality"
        ? (candidate as readonly unknown[]).map(normalizeClause)
        : candidate as readonly unknown[];
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
          // authoring identity's provenance stamp and one recorded without an
          // identity (unstamped). The BINDING (file + path) is what the claim
          // means; the stamp is provenance added per input — keep the stamped
          // claim. Two DIFFERENT stamps (or different bindings) still
          // conflict.
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

  // `$defs` is not merged: `{...left, ...right}` lets a `right` envelope that
  // declares its own `$defs` replace `left`'s wholesale, which can leave a
  // surviving `items`/`properties` `$ref` (e.g. `#/$defs/Element`) pointing at
  // a dropped def. The merged envelope's ifc (incl. writeAuthorizedBy) still
  // rides on the node, so the policy matcher must not let the now-unresolvable
  // value-condition ref exclude the entry — `policySchemaMatchesValue` in
  // prepare.ts fails closed on unevaluable refs for exactly this reason.
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
