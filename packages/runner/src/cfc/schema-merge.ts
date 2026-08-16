import type { JSONValue } from "@commonfabric/api";
import type { CfcAtom } from "@commonfabric/api/cfc";
import {
  type FabricValue,
  valueEqual,
} from "@commonfabric/data-model/fabric-value";
import { internSchema } from "@commonfabric/data-model/schema-hash";
import { deepEqual } from "@commonfabric/utils/deep-equal";
import {
  isObjectNotArray,
  isObjectOrArray,
  isPlainObject,
} from "@commonfabric/utils/types";

import type { JSONSchema, JSONSchemaObj } from "../builder/types.ts";
import {
  forEachSubschema,
  isSubschema,
  mapSubschemas,
  type SubschemaKeyword,
} from "../schema-walk.ts";
import type { CfcConfClause } from "./clause.ts";
import { normalizeClause } from "./clause.ts";
import { CfcSchemaMigrationError } from "./migration-reason.ts";
import {
  cfcSchemaChildRoot,
  findCfcSchemaRefs,
  namespaceLocalDefinitionScope,
  pruneCfcSchemaDefinitions,
  resolveCfcSchemaRefRoot,
  resolveCfcSchemaRefsOrThrow,
  selectReferencedCfcSchemaDefs,
} from "./schema-refs.ts";
import { writerClaimFilesCorrespond } from "./writer-claim-correspondence.ts";
import type { CfcScalarTypeTransition } from "./types.ts";

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
  if (!isObjectOrArray(schema)) {
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
): CfcAtom[] => {
  const result: CfcAtom[] = [];
  for (const source of sources) {
    for (const value of source) {
      if (!result.some((candidate) => deepEqual(candidate, value))) {
        result.push(value as CfcAtom);
      }
    }
  }
  return result;
};

/** Adds confidentiality clauses to a schema's result root. */
export const addRootConfidentiality = (
  resultSchema: JSONSchema | undefined,
  additions: readonly JSONValue[],
): JSONSchema => {
  const unresolvedSchema = resultSchema === false
    ? { not: {} }
    : isObjectOrArray(resultSchema)
    ? resultSchema as JSONSchemaObj
    : {};
  const schema = typeof unresolvedSchema.$ref === "string"
    ? asSchemaObject(
      resolveCfcSchemaRefsOrThrow(unresolvedSchema, unresolvedSchema),
      "",
    )
    : unresolvedSchema;
  const ifc = isObjectOrArray(schema.ifc) ? schema.ifc : {};
  const confidentiality = Array.isArray(ifc.confidentiality)
    ? ifc.confidentiality
    : [];
  return {
    ...schema,
    ifc: {
      ...ifc,
      confidentiality: [
        ...confidentiality,
        ...additions.filter((addition) =>
          !confidentiality.some((existing) => deepEqual(existing, addition))
        ),
      ],
    },
  };
};

type WriterIdentityClaim = {
  __ctWriterIdentityOf: Record<string, unknown>;
};

const isWriterIdentityClaim = (value: unknown): value is WriterIdentityClaim =>
  isObjectNotArray(value) && isObjectNotArray(value.__ctWriterIdentityOf);

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

const writerClaimWithoutStampAndFile = (
  identity: Record<string, unknown>,
): Record<string, unknown> => {
  const rest = { ...identity };
  for (const key of WRITER_CLAIM_STAMP_KEYS) delete rest[key];
  // The file spelling is compared separately, tolerantly
  // (writerClaimFilesCorrespond) — never byte-wise.
  delete rest.file;
  return rest;
};

/**
 * Reconcile two `writeAuthorizedBy` writer-identity claims that mean the same
 * binding. The binding a claim MEANS is `path` (+ `moduleIdentity` once
 * stamped); the `file` spelling is resolver-dependent (the same module spells
 * differently across piece-deploy and HTTP compiles — labs#4772), so two
 * claims reconcile when their paths match, their file spellings CORRESPOND
 * (equal or one-leading-segment apart), and everything outside file + stamp
 * is equal. Returns the stamped side when exactly one carries the provenance
 * stamp (`moduleIdentity`, or a legacy `bundleId` on pre-migration claims),
 * and the existing side otherwise — both-unstamped, both same stamp, and
 * both stamped DIFFERENTLY (a version boundary: born-stamped claims make a
 * republished module re-present this binding under its new moduleIdentity
 * on every envelope write; the stored stamp is kept, never rotated, and the
 * successor's field writes are authorized at verification time by
 * authenticated `piece setsrc` module delegation — or fail closed loudly
 * without one — while the envelope's sibling writes keep committing).
 * `undefined` only when the claims name different bindings
 * (non-corresponding files or paths).
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
  if (
    !writerClaimFilesCorrespond(
      typeof existingIdentity.file === "string"
        ? existingIdentity.file
        : undefined,
      typeof candidateIdentity.file === "string"
        ? candidateIdentity.file
        : undefined,
    )
  ) {
    return undefined;
  }
  if (
    !deepEqual(
      {
        ...existing,
        __ctWriterIdentityOf: writerClaimWithoutStampAndFile(existingIdentity),
      },
      {
        ...candidate,
        __ctWriterIdentityOf: writerClaimWithoutStampAndFile(candidateIdentity),
      },
    )
  ) {
    return undefined;
  }
  const existingStamped = writerClaimIsStamped(existingIdentity);
  const candidateStamped = writerClaimIsStamped(candidateIdentity);
  if (existingStamped && candidateStamped) {
    // Both stamped, same binding: the stored claim wins either way. With
    // equal stamps this is plain stability (spelling included). With
    // DIFFERENT stamps it is a version boundary — claims are minted born
    // stamped, so a republished module re-presents this binding under its
    // new moduleIdentity on every envelope write. Keeping the stored stamp
    // (instead of conflict-aborting the transaction) preserves the
    // fail-closed posture at the right granularity: the new version's
    // writes to THIS field are rejected loudly at verification until the
    // setsrc-history delegation design authorizes the rotation, while the
    // envelope's sibling fields keep committing. Rotation never happens
    // here in either direction.
    return existing;
  }
  if (!existingStamped && !candidateStamped) {
    return existing;
  }
  return existingStamped ? existing : candidate;
};

const mergeSetLikeIfcArray = (
  key: string,
  existing: unknown,
  candidate: unknown,
  path: string,
  options: MergeCfcSchemaEnvelopeOptions,
): unknown => {
  if (existing === undefined) {
    return candidate;
  }
  if (candidate === undefined) {
    if (key === "addIntegrity" && options.allowAddIntegrityWeakening) {
      return undefined;
    }
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
        ? (existing as readonly CfcConfClause[]).map(normalizeClause)
        : existing as readonly unknown[];
      const candidateArray = key === "confidentiality"
        ? (candidate as readonly CfcConfClause[]).map(normalizeClause)
        : candidate as readonly unknown[];
      if (!arraySubsetOf(existingArray, candidateArray)) {
        if (
          key === "addIntegrity" && options.allowAddIntegrityWeakening &&
          arraySubsetOf(candidateArray, existingArray)
        ) {
          return candidateArray;
        }
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
          // claim. For two different stamps of the same binding, keep the
          // stored stamp (a version boundary, never a rotation here). Different
          // bindings still conflict.
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
  options: MergeCfcSchemaEnvelopeOptions,
): JSONSchemaObj["ifc"] => {
  if (existing === undefined) {
    return candidate;
  }
  if (candidate === undefined && !options.allowAddIntegrityWeakening) {
    return existing;
  }

  const existingIfc = existing as Record<string, unknown>;
  const candidateIfc = (candidate ?? {}) as Record<string, unknown>;
  const merged: Record<string, unknown> = {};
  for (const key of IFC_KEYS) {
    merged[key] = mergeSetLikeIfcArray(
      key,
      existingIfc[key],
      candidateIfc[key],
      path,
      options,
    );
  }
  // `observes` (C5) is a scalar consumption class, not a set-like claim:
  // agreement keeps the class through the merge; any disagreement —
  // including one covering side — merges to covering, the widest
  // consumption (over-taint, fail-safe).
  if (
    typeof existingIfc.observes === "string" &&
    existingIfc.observes === candidateIfc.observes
  ) {
    merged.observes = existingIfc.observes;
  }
  return merged as JSONSchemaObj["ifc"];
};

interface BranchIfcVisit {
  readonly schema: object;
  readonly root: object;
  readonly parent?: BranchIfcVisit;
}

const resolvedSchemaTreeContainsIfc = (
  schema: JSONSchema,
  inheritedRoot: JSONSchema,
  active?: BranchIfcVisit,
): boolean => {
  if (!isObjectOrArray(schema)) return false;
  const root = cfcSchemaChildRoot(schema, inheritedRoot);
  const rootKey = isObjectOrArray(root) ? root : schema;
  for (let cursor = active; cursor !== undefined; cursor = cursor.parent) {
    if (cursor.schema === schema && cursor.root === rootKey) return false;
  }
  const nextActive = { schema, root: rootKey, parent: active };
  const current = resolvedBranchCheckPosition(schema, inheritedRoot);
  if (!isObjectOrArray(current.schema)) return false;
  if ((current.schema as JSONSchemaObj).ifc !== undefined) return true;
  return forEachSubschema(
    current.schema,
    (child) => resolvedSchemaTreeContainsIfc(child, current.root, nextActive),
    { includeUnused: true },
  );
};

const correspondingSubschema = (
  schema: JSONSchema | undefined,
  keyword: SubschemaKeyword,
  key: string | undefined,
  index: number | undefined,
): JSONSchema | undefined => {
  if (!isObjectOrArray(schema)) return undefined;
  const value = schema[keyword];
  let child: unknown;
  if (key !== undefined) {
    child = isObjectOrArray(value)
      ? (value as Readonly<Record<string, unknown>>)[key]
      : undefined;
    if (
      child === undefined && keyword === "properties" &&
      isObjectOrArray(schema.additionalProperties)
    ) {
      child = schema.additionalProperties;
    }
  } else if (index !== undefined) {
    child = Array.isArray(value) ? value[index] : undefined;
    if (child === undefined && keyword === "prefixItems") {
      child = schema.items;
    }
  } else {
    child = value;
  }
  return isSubschema(child) ? child : undefined;
};

const resolvedBranchCheckPosition = (
  schema: JSONSchema,
  inheritedRoot: JSONSchema,
): { schema: JSONSchema; root: JSONSchema } => {
  const root = cfcSchemaChildRoot(schema, inheritedRoot);
  if (!isObjectOrArray(schema) || typeof schema.$ref !== "string") {
    return { schema, root };
  }
  const resolved = resolveCfcSchemaRefsOrThrow(schema, root);
  const resolvedRoot = resolveCfcSchemaRefRoot(schema, root);
  return {
    schema: resolved,
    root: cfcSchemaChildRoot(resolved, resolvedRoot),
  };
};

interface BranchCheckVisit {
  readonly schema: JSONSchema;
  readonly root: JSONSchema;
  readonly counterpart: JSONSchema;
  readonly counterpartRoot: JSONSchema;
  readonly parent?: BranchCheckVisit;
}

const branchComparisonValue = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(branchComparisonValue);
  }
  if (!isPlainObject(value)) return value;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (child === undefined) continue;
    Object.defineProperty(result, key, {
      value: branchComparisonValue(child),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return result;
};

const branchSchemasEqual = (
  left: JSONSchema,
  right: JSONSchema,
): boolean =>
  deepEqual(
    branchComparisonValue(pruneCfcSchemaDefinitions(left)),
    branchComparisonValue(pruneCfcSchemaDefinitions(right)),
  );

const schemaFragmentContainsRefs = (schema: JSONSchema): boolean => {
  const refs = new Set<string>();
  findCfcSchemaRefs(schema, refs);
  return refs.size > 0;
};

const BRANCH_EQUALITY_SINGLE_SUBSCHEMAS = new Set([
  "not",
  "items",
  "additionalProperties",
  "if",
  "then",
  "else",
  "contains",
  "propertyNames",
  "contentSchema",
]);
const BRANCH_EQUALITY_ARRAY_SUBSCHEMAS = new Set([
  "allOf",
  "anyOf",
  "oneOf",
  "prefixItems",
]);
const BRANCH_EQUALITY_RECORD_SUBSCHEMAS = new Set([
  "properties",
  "patternProperties",
  "dependentSchemas",
]);

const branchSchemasEquivalent = (
  left: JSONSchema,
  leftRoot: JSONSchema,
  right: JSONSchema,
  rightRoot: JSONSchema,
  active?: BranchCheckVisit,
  ignoreIfc = false,
): boolean => {
  for (let cursor = active; cursor !== undefined; cursor = cursor.parent) {
    if (
      cursor.schema === left && cursor.root === leftRoot &&
      cursor.counterpart === right && cursor.counterpartRoot === rightRoot
    ) {
      return true;
    }
  }
  const nextActive: BranchCheckVisit = {
    schema: left,
    root: leftRoot,
    counterpart: right,
    counterpartRoot: rightRoot,
    parent: active,
  };
  const resolvedLeft = resolvedBranchCheckPosition(left, leftRoot);
  const resolvedRight = resolvedBranchCheckPosition(right, rightRoot);
  if (
    typeof resolvedLeft.schema === "boolean" ||
    typeof resolvedRight.schema === "boolean"
  ) {
    return resolvedLeft.schema === resolvedRight.schema;
  }

  const leftObject = resolvedLeft.schema as JSONSchemaObj;
  const rightObject = resolvedRight.schema as JSONSchemaObj;
  const keys = new Set([
    ...Object.keys(leftObject),
    ...Object.keys(rightObject),
  ]);
  for (const key of keys) {
    // Branch conditions measure the resolved logical value. `asCell` controls
    // how that value is materialized and does not change the condition.
    if (
      key === "$defs" || key === "$ref" || key === "asCell" ||
      key === "default" || ignoreIfc && key === "ifc"
    ) continue;
    const leftValue = leftObject[key as keyof JSONSchemaObj];
    const rightValue = rightObject[key as keyof JSONSchemaObj];
    if (leftValue === undefined || rightValue === undefined) {
      if (leftValue !== rightValue) return false;
      continue;
    }
    if (BRANCH_EQUALITY_SINGLE_SUBSCHEMAS.has(key)) {
      if (
        !isSubschema(leftValue) || !isSubschema(rightValue) ||
        !branchSchemasEquivalent(
          leftValue,
          resolvedLeft.root,
          rightValue,
          resolvedRight.root,
          nextActive,
          ignoreIfc,
        )
      ) {
        return false;
      }
      continue;
    }
    if (BRANCH_EQUALITY_ARRAY_SUBSCHEMAS.has(key)) {
      if (
        !Array.isArray(leftValue) || !Array.isArray(rightValue) ||
        leftValue.length !== rightValue.length
      ) {
        return false;
      }
      for (let index = 0; index < leftValue.length; index++) {
        if (
          !isSubschema(leftValue[index]) ||
          !isSubschema(rightValue[index]) ||
          !branchSchemasEquivalent(
            leftValue[index],
            resolvedLeft.root,
            rightValue[index],
            resolvedRight.root,
            nextActive,
            ignoreIfc,
          )
        ) {
          return false;
        }
      }
      continue;
    }
    if (BRANCH_EQUALITY_RECORD_SUBSCHEMAS.has(key)) {
      if (!isObjectOrArray(leftValue) || !isObjectOrArray(rightValue)) {
        return false;
      }
      const childKeys = new Set([
        ...Object.keys(leftValue),
        ...Object.keys(rightValue),
      ]);
      const leftRecord = leftValue as Readonly<Record<string, unknown>>;
      const rightRecord = rightValue as Readonly<Record<string, unknown>>;
      for (const childKey of childKeys) {
        const leftChild = leftRecord[childKey];
        const rightChild = rightRecord[childKey];
        if (
          !isSubschema(leftChild) || !isSubschema(rightChild) ||
          !branchSchemasEquivalent(
            leftChild,
            resolvedLeft.root,
            rightChild,
            resolvedRight.root,
            nextActive,
            ignoreIfc,
          )
        ) {
          return false;
        }
      }
      continue;
    }
    if (!deepEqual(leftValue, rightValue)) return false;
  }
  return true;
};

const assertNoDivergentIfcBranches = (
  schema: JSONSchema,
  counterpart: JSONSchema | undefined,
  path = "",
  inheritedRoot: JSONSchema = schema,
  counterpartInheritedRoot: JSONSchema | undefined = counterpart,
  active?: BranchCheckVisit,
): void => {
  if (counterpart === undefined || counterpartInheritedRoot === undefined) {
    return;
  }
  for (let cursor = active; cursor !== undefined; cursor = cursor.parent) {
    if (
      cursor.schema === schema && cursor.root === inheritedRoot &&
      cursor.counterpart === counterpart &&
      cursor.counterpartRoot === counterpartInheritedRoot
    ) {
      return;
    }
  }
  const nextActive = {
    schema,
    root: inheritedRoot,
    counterpart,
    counterpartRoot: counterpartInheritedRoot,
    parent: active,
  };
  const current = resolvedBranchCheckPosition(schema, inheritedRoot);
  const counterpartCurrent = resolvedBranchCheckPosition(
    counterpart,
    counterpartInheritedRoot,
  );
  if (
    branchSchemasEqual(current.schema, counterpartCurrent.schema) &&
    !schemaFragmentContainsRefs(current.schema) &&
    !schemaFragmentContainsRefs(counterpartCurrent.schema)
  ) {
    return;
  }
  if (
    branchSchemasEquivalent(
      current.schema,
      current.root,
      counterpartCurrent.schema,
      counterpartCurrent.root,
    )
  ) {
    return;
  }
  if (!isObjectOrArray(current.schema)) return;
  const object = current.schema as JSONSchemaObj;
  const isPolicyFreeClosedEmptyObject = (
    branch: JSONSchema,
    root: JSONSchema,
  ): boolean => {
    const resolved = resolvedBranchCheckPosition(branch, root).schema;
    return isObjectOrArray(resolved) && resolved.type === "object" &&
      isObjectOrArray(resolved.properties) &&
      Object.keys(resolved.properties).length === 0 &&
      resolved.additionalProperties === false &&
      !resolvedSchemaTreeContainsIfc(branch, root);
  };
  const isDefaultedProjectionOfClosedEmptyUnion = (
    union: JSONSchemaObj,
    unionRoot: JSONSchema,
    projection: JSONSchemaObj,
    projectionRoot: JSONSchema,
  ): boolean => {
    if (!Object.hasOwn(projection, "default")) return false;
    return [union.anyOf, union.oneOf].some((branches) =>
      Array.isArray(branches) &&
      branches.some((branch) =>
        isPolicyFreeClosedEmptyObject(branch, unionRoot)
      ) &&
      branches.some((branch) =>
        !isPolicyFreeClosedEmptyObject(branch, unionRoot) &&
        branchSchemasEquivalent(
          branch,
          unionRoot,
          projection,
          projectionRoot,
          undefined,
          true,
        )
      )
    );
  };
  if (
    isObjectOrArray(counterpartCurrent.schema) &&
    (isDefaultedProjectionOfClosedEmptyUnion(
      object,
      current.root,
      counterpartCurrent.schema,
      counterpartCurrent.root,
    ) || isDefaultedProjectionOfClosedEmptyUnion(
      counterpartCurrent.schema,
      counterpartCurrent.root,
      object,
      current.root,
    ))
  ) {
    return;
  }
  const branchGroups = [
    object.anyOf ? ["anyOf", object.anyOf] as const : undefined,
    object.oneOf ? ["oneOf", object.oneOf] as const : undefined,
    object.allOf ? ["allOf", object.allOf] as const : undefined,
  ].filter((value) => value !== undefined);
  for (const [kind, branches] of branchGroups) {
    const counterpartBranches = isObjectOrArray(counterpartCurrent.schema)
      ? counterpartCurrent.schema[kind]
      : undefined;
    if (
      Array.isArray(counterpartBranches) &&
      branches.length === counterpartBranches.length &&
      branches.every((branch, index) =>
        branchSchemasEquivalent(
          branch,
          current.root,
          counterpartBranches[index],
          counterpartCurrent.root,
        )
      )
    ) {
      continue;
    }
    if (
      branches.some((branch) =>
        resolvedSchemaTreeContainsIfc(branch, current.root)
      )
    ) {
      throw new Error(
        `ifc inside divergent ${kind} branches is unsupported at ${
          path || "/"
        }`,
      );
    }
  }

  // Recurse over the shared keyword vocabulary so a divergent-ifc shape
  // cannot hide under a keyword this guard forgot (prefixItems and
  // additionalProperties previously escaped it). Combinator members are
  // technically redundant here — a member containing ifc anywhere already
  // threw via branchContainsIfc above — but descending them is harmless.
  forEachSubschema(object, (child, keyword, key, index) => {
    const childPath = keyword === "properties"
      ? `${path}/${key}`
      : keyword === "items" || keyword === "additionalProperties"
      ? `${path}/*`
      : keyword === "prefixItems"
      ? `${path}/${index}`
      : path;
    assertNoDivergentIfcBranches(
      child,
      correspondingSubschema(
        counterpartCurrent.schema,
        keyword,
        key,
        index,
      ),
      childPath,
      current.root,
      counterpartCurrent.root,
      nextActive,
    );
  });
};

export interface MergeCfcSchemaEnvelopeOptions {
  /**
   * Logical paths generated as outputs by the running module. A path covers
   * every required descendant below it; `[]` therefore exempts the whole
   * document, as it does for a pattern result projection that setup rewrites
   * in full. Required fields outside these paths still need defaults to
   * preserve older documents.
   */
  generatedOutputPaths?: readonly (readonly string[])[];
  /** Permit an authenticated source update to remove integrity it minted. */
  allowAddIntegrityWeakening?: boolean;
  /** Accept a confirmed change between scalar validation types. */
  allowIncompatibleScalarTypes?: boolean;
  /** Accept an exact reviewed scalar validation-type change. */
  allowIncompatibleScalarTypeChange?: (
    transition: CfcScalarTypeTransition,
  ) => boolean;
  /** Observe each accepted scalar validation-type change. */
  onIncompatibleScalarTypeChange?: (
    transition: CfcScalarTypeTransition,
  ) => void;
}

const generatedOutputCovers = (
  options: MergeCfcSchemaEnvelopeOptions,
  path: readonly string[],
): boolean =>
  options.generatedOutputPaths?.some((outputPath) =>
    outputPath.length <= path.length &&
    outputPath.every((segment, index) =>
      segment === path[index] ||
      (path[index] === "*" && /^(0|[1-9]\d*)$/.test(segment))
    )
  ) ?? false;

const mergeRequired = (
  existing: readonly string[] | undefined,
  candidate: readonly string[] | undefined,
  mergedProperties: Readonly<Record<string, JSONSchema>>,
  path: readonly string[],
  options: MergeCfcSchemaEnvelopeOptions,
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
    // A generated output is materialized by the module in this transaction,
    // so it has no older value to preserve. Inputs and ordinary document writes
    // remain default-gated: an older document may genuinely lack their newly
    // required field.
    if (generatedOutputCovers(options, [...path, name])) {
      continue;
    }
    const acceptsExplicitUndefinedDefault = isObjectOrArray(property) &&
      Object.hasOwn(property, "default") && property.default === undefined &&
      (property.type === "undefined" ||
        Array.isArray(property.type) && property.type.includes("undefined"));
    if (
      !isObjectOrArray(property) ||
      property.default === undefined && !acceptsExplicitUndefinedDefault
    ) {
      // Typed so the CFC prepare catch can tag this as the recoverable
      // schema-migration class (see migration-reason.ts) without sniffing the
      // message. The message text stays human-readable and unchanged.
      throw new CfcSchemaMigrationError(
        `required field ${name} needs a default to preserve old documents`,
      );
    }
  }
  return merged;
};

const mergeDefaults = (
  existing: JSONSchemaObj["default"],
  candidate: JSONSchemaObj["default"],
  existingHasDefault: boolean,
  candidateHasDefault: boolean,
): JSONSchemaObj["default"] => {
  if (!existingHasDefault) {
    return candidate;
  }
  if (!candidateHasDefault) {
    return existing;
  }
  if (
    valueEqual(existing as FabricValue, candidate as FabricValue)
  ) {
    return existing;
  }
  if (isPlainObject(existing) && isPlainObject(candidate)) {
    return { ...existing, ...candidate };
  }
  return candidate;
};

const mergeDefinitions = (
  existing: JSONSchemaObj["$defs"],
  candidate: JSONSchemaObj["$defs"],
): JSONSchemaObj["$defs"] => {
  if (existing === undefined) return candidate;
  if (candidate === undefined) return existing;
  if (existing === candidate) return existing;
  return { ...existing, ...candidate };
};

const namespaceCandidateDefinitionsForMerge = (
  existing: JSONSchemaObj,
  candidate: JSONSchemaObj,
): JSONSchemaObj => {
  const existingDefinitions = existing.$defs!;
  const candidateDefinitions = candidate.$defs!;
  const generatedName = /^__cfc_ref_site_(\d+)_/;
  const existingNames = Object.keys(existingDefinitions);
  const generatedCount =
    existingNames.filter((name) => generatedName.test(name)).length;
  for (let start = 0; start <= generatedCount; start++) {
    const reserved = new Set(
      existingNames.filter((name) => {
        const match = generatedName.exec(name);
        return match === null || Number(match[1]) < start;
      }),
    );
    const namespaced = namespaceLocalDefinitionScope(
      candidate,
      candidateDefinitions,
      reserved,
    );
    const compatible = Object.entries(namespaced.$defs ?? {}).every(
      ([name, definition]) =>
        !Object.hasOwn(existingDefinitions, name) ||
        deepEqual(existingDefinitions[name], definition),
    );
    if (compatible) return namespaced;
  }
  return namespaceLocalDefinitionScope(
    candidate,
    candidateDefinitions,
    new Set(existingNames),
  );
};

interface ActiveRefMerge {
  existingRoot: JSONSchema;
  candidateRoot: JSONSchema;
  existingRef: string | undefined;
  candidateRef: string | undefined;
  definitionName: string;
}

interface SchemaMergeContext {
  nextDefinition: number;
  syntheticDefinitions: Record<string, JSONSchema>;
  reservedDefinitionNames: Set<string>;
}

const schemaDefinitionNames = (schema: JSONSchema): Set<string> => {
  const names = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!isObjectOrArray(value)) return;
    for (const [key, child] of Object.entries(value)) {
      if (key === "$defs" && isObjectOrArray(child)) {
        for (const [name, definition] of Object.entries(child)) {
          names.add(name);
          visit(definition);
        }
      } else {
        visit(child);
      }
    }
  };
  visit(schema);
  return names;
};

const localDefinitionTarget = (
  root: JSONSchema,
  ref: string,
): JSONSchema | undefined => {
  const match = ref.match(/^#\/\$defs\/([^/]+)$/);
  if (match === null || !isObjectOrArray(root)) return undefined;
  const name = match[1].replaceAll("~1", "/").replaceAll("~0", "~");
  return root.$defs?.[name];
};

interface ResolvedLocalDefinitionTarget {
  scope: object;
  target: JSONSchema;
}

const localDefinitionScopeIdentity = (
  root: JSONSchema,
): object | undefined =>
  isObjectOrArray(root)
    ? isObjectOrArray(root.$defs) ? root.$defs : root
    : undefined;

const resolvedLocalDefinitionTarget = (
  root: JSONSchema,
  ref: string | undefined,
): ResolvedLocalDefinitionTarget | undefined => {
  if (ref === undefined) return undefined;
  let currentRoot = root;
  let target = localDefinitionTarget(currentRoot, ref);
  const seen = new Set<object>();
  while (
    isObjectOrArray(target) && typeof target.$ref === "string" &&
    !seen.has(target) &&
    Object.keys(target).every((key) => key === "$ref" || key === "$defs")
  ) {
    seen.add(target);
    currentRoot = cfcSchemaChildRoot(target, currentRoot);
    const next = localDefinitionTarget(currentRoot, target.$ref);
    if (next === undefined) break;
    target = next;
  }
  const scope = localDefinitionScopeIdentity(currentRoot);
  return target === undefined || scope === undefined
    ? undefined
    : { scope, target };
};

const localRefsResolveToSameTarget = (
  leftRoot: JSONSchema,
  leftRef: string | undefined,
  rightRoot: JSONSchema,
  rightRef: string | undefined,
): boolean => {
  const left = resolvedLocalDefinitionTarget(leftRoot, leftRef);
  const right = resolvedLocalDefinitionTarget(rightRoot, rightRef);
  return left !== undefined && right !== undefined &&
    left.scope === right.scope && left.target === right.target;
};

const reusableMergedDefinitionName = (
  ref: string | undefined,
  scope: JSONSchema,
): string | undefined => {
  const match = ref?.match(/^#\/\$defs\/(__cfc_merged_ref_[0-9]+)$/);
  const name = match?.[1];
  if (
    name === undefined || !isObjectOrArray(scope) ||
    !Object.hasOwn(scope.$defs ?? {}, name)
  ) return undefined;
  const target = scope.$defs![name];
  const ownedDefinitions = new Map<object, Set<object>>();
  const definitionIsOwned = (
    root: JSONSchema,
    definition: unknown,
  ): boolean => {
    const scopeIdentity = localDefinitionScopeIdentity(root);
    return scopeIdentity !== undefined && isObjectOrArray(definition) &&
      ownedDefinitions.get(scopeIdentity)?.has(definition) === true;
  };
  const addOwnedDefinition = (
    root: JSONSchema,
    definition: JSONSchema,
  ): void => {
    const scopeIdentity = localDefinitionScopeIdentity(root);
    if (scopeIdentity === undefined || !isObjectOrArray(definition)) return;
    const definitions = ownedDefinitions.get(scopeIdentity) ??
      new Set<object>();
    definitions.add(definition);
    ownedDefinitions.set(scopeIdentity, definitions);
  };
  addOwnedDefinition(scope, target);
  const visitedSchemas = new Map<object, Set<object>>();
  const markSchemaVisited = (
    root: JSONSchema,
    schema: JSONSchema,
  ): boolean => {
    const scopeIdentity = localDefinitionScopeIdentity(root);
    if (scopeIdentity === undefined || !isObjectOrArray(schema)) return false;
    const schemas = visitedSchemas.get(scopeIdentity) ?? new Set<object>();
    if (schemas.has(schema)) return false;
    schemas.add(schema);
    visitedSchemas.set(scopeIdentity, schemas);
    return true;
  };
  const collectOwnedDefinitions = (
    schema: JSONSchema,
    parentRoot: JSONSchema,
  ): void => {
    if (!isObjectOrArray(schema)) return;
    const currentRoot = cfcSchemaChildRoot(schema, parentRoot);
    if (!markSchemaVisited(currentRoot, schema)) return;
    if (typeof schema.$ref === "string") {
      const definition = localDefinitionTarget(currentRoot, schema.$ref);
      if (
        isObjectOrArray(definition) &&
        !definitionIsOwned(currentRoot, definition)
      ) {
        addOwnedDefinition(currentRoot, definition);
        collectOwnedDefinitions(definition, currentRoot);
      }
    }
    forEachSubschema(
      schema,
      (child) => collectOwnedDefinitions(child, currentRoot),
      { includeUnused: true },
    );
  };
  collectOwnedDefinitions(target, scope);
  let referenceSites = 0;
  const visit = (value: unknown, parentRoot: JSONSchema): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item, parentRoot);
      return;
    }
    if (!isObjectOrArray(value)) return;
    const currentRoot = cfcSchemaChildRoot(value, parentRoot);
    if (typeof value.$ref === "string") {
      const definition = localDefinitionTarget(currentRoot, value.$ref);
      if (definitionIsOwned(currentRoot, definition ?? false)) {
        referenceSites++;
      }
    }
    for (const [key, child] of Object.entries(value)) {
      if (key === "$ref") continue;
      if (key === "$defs" && isObjectOrArray(child)) {
        for (const definition of Object.values(child)) {
          if (!definitionIsOwned(currentRoot, definition)) {
            visit(definition, currentRoot);
          }
        }
      } else {
        visit(child, currentRoot);
      }
    }
  };
  visit(scope, scope);
  return referenceSites === 1 ? name : undefined;
};

const referencedTargetsHaveCorrespondingCycle = (
  leftRef: string,
  rightRef: string,
  leftRoot: JSONSchema,
  rightRoot: JSONSchema,
): boolean => {
  const backEdgePaths = (ref: string, root: JSONSchema): Set<string> => {
    const target = localDefinitionTarget(root, ref);
    const targetScope = localDefinitionScopeIdentity(root);
    if (!isObjectOrArray(target) || targetScope === undefined) return new Set();
    const paths = new Set<string>();
    type DefinitionStack = ReadonlyMap<object, ReadonlySet<object>>;
    const pushDefinition = (
      stack: DefinitionStack,
      scope: object,
      definition: object,
    ): DefinitionStack =>
      new Map(stack).set(
        scope,
        new Set([...(stack.get(scope) ?? []), definition]),
      );
    const visit = (
      schema: JSONSchema,
      parentRoot: JSONSchema,
      path: readonly string[],
      definitionStack: DefinitionStack,
    ): void => {
      if (!isObjectOrArray(schema)) return;
      const currentRoot = cfcSchemaChildRoot(schema, parentRoot);
      if (typeof schema.$ref === "string") {
        const resolved = localDefinitionTarget(currentRoot, schema.$ref);
        const resolvedScope = localDefinitionScopeIdentity(currentRoot);
        if (resolved === target && resolvedScope === targetScope) {
          paths.add(JSON.stringify(path));
        } else if (
          isObjectOrArray(resolved) && resolvedScope !== undefined &&
          !definitionStack.get(resolvedScope)?.has(resolved)
        ) {
          visit(
            resolved,
            currentRoot,
            path,
            pushDefinition(definitionStack, resolvedScope, resolved),
          );
        }
      }
      forEachSubschema(
        schema,
        (child, keyword, key, index) => {
          visit(
            child,
            currentRoot,
            [...path, `${keyword}:${key ?? index ?? ""}`],
            definitionStack,
          );
        },
        { includeUnused: true },
      );
    };
    visit(target, root, [], pushDefinition(new Map(), targetScope, target));
    return paths;
  };
  const leftPaths = backEdgePaths(leftRef, leftRoot);
  const rightPaths = backEdgePaths(rightRef, rightRoot);
  return leftPaths.size > 0 && leftPaths.size === rightPaths.size &&
    [...leftPaths].every((path) => rightPaths.has(path));
};

const mergedDefinitionName = (
  existingScope: JSONSchema,
  candidateScope: JSONSchema,
  context: SchemaMergeContext,
  reusable: string | undefined,
): string => {
  if (
    reusable !== undefined &&
    !Object.hasOwn(context.syntheticDefinitions, reusable)
  ) return reusable;
  const existingDefinitions = isObjectOrArray(existingScope)
    ? existingScope.$defs
    : undefined;
  const candidateDefinitions = isObjectOrArray(candidateScope)
    ? candidateScope.$defs
    : undefined;
  while (true) {
    const name = `__cfc_merged_ref_${context.nextDefinition++}`;
    if (
      !Object.hasOwn(existingDefinitions ?? {}, name) &&
      !Object.hasOwn(candidateDefinitions ?? {}, name) &&
      !Object.hasOwn(context.syntheticDefinitions, name) &&
      !context.reservedDefinitionNames.has(name)
    ) return name;
  }
};

const attachSyntheticDefinitions = (
  schema: JSONSchema,
  context: SchemaMergeContext,
): JSONSchema => {
  if (!isObjectOrArray(schema)) return schema;
  const withoutDefinitions = { ...schema };
  delete withoutDefinitions.$defs;
  const definitions = selectReferencedCfcSchemaDefs(
    withoutDefinitions,
    {
      ...(schema.$defs ?? {}),
      ...context.syntheticDefinitions,
    },
  );
  return definitions === undefined
    ? withoutDefinitions
    : { ...withoutDefinitions, $defs: definitions };
};

const storedRecursiveGraphCoversCandidate = (
  stored: JSONSchema,
  candidate: JSONSchema,
): boolean => {
  const visited = new WeakSet<object>();
  const containsDerivedSyntheticDefinition = (schema: unknown): boolean => {
    if (!isObjectOrArray(schema) || visited.has(schema)) return false;
    visited.add(schema);
    return forEachSubschema(
      schema,
      (child, keyword, key) =>
        keyword === "$defs" && key !== undefined &&
          /^__cfc_merged_ref_[0-9]+$/.test(key) &&
          isObjectOrArray(child) && Object.hasOwn(child, "ifc") &&
          Object.hasOwn(child, "required") ||
        containsDerivedSyntheticDefinition(child),
      { includeDefs: true, includeUnused: true },
    );
  };
  if (
    !isObjectOrArray(stored) || typeof stored.$ref === "string" ||
    !containsDerivedSyntheticDefinition(stored)
  ) return false;

  const objectIds = new WeakMap<object, number>();
  let nextObjectId = 0;
  const objectId = (value: object): number => {
    const existing = objectIds.get(value);
    if (existing !== undefined) return existing;
    const id = nextObjectId++;
    objectIds.set(value, id);
    return id;
  };
  const pairStates = new Map<string, "checking" | "covered" | "uncovered">();
  const unsupportedSingleApplicatorKeys = new Set([
    "not",
    "if",
    "then",
    "else",
    "contains",
    "propertyNames",
    "contentSchema",
  ]);
  const unsupportedArrayApplicatorKeys = new Set([
    "allOf",
    "anyOf",
    "oneOf",
  ]);
  const unsupportedRecordApplicatorKeys = new Set([
    "patternProperties",
    "dependentSchemas",
  ]);
  const schemaContainsRef = (schema: unknown): boolean =>
    isObjectOrArray(schema) &&
    (typeof schema.$ref === "string" ||
      forEachSubschema(
        schema,
        (child) => schemaContainsRef(child),
        { includeDefs: true, includeUnused: true },
      ));
  const refHasOnlyStructuralSiblings = (schema: JSONSchemaObj): boolean =>
    Object.entries(schema).every(([key, value]) =>
      key === "$ref" || key === "$defs" || value === undefined ||
      (key === "required" && Array.isArray(value) && value.length === 0)
    );
  const refSiblings = (schema: JSONSchemaObj): JSONSchemaObj =>
    Object.fromEntries(
      Object.entries(schema).filter(([key, value]) =>
        key !== "$ref" && key !== "$defs" && value !== undefined &&
        !(key === "required" && Array.isArray(value) && value.length === 0)
      ),
    ) as JSONSchemaObj;
  const resolveBareRef = (
    schema: JSONSchemaObj,
    parentRoot: JSONSchema,
  ): { node: JSONSchema; parentRoot: JSONSchema } | undefined => {
    let node: JSONSchema = schema;
    let root = parentRoot;
    const seen = new Set<string>();
    while (isObjectOrArray(node) && typeof node.$ref === "string") {
      root = cfcSchemaChildRoot(node, root);
      if (!refHasOnlyStructuralSiblings(node)) {
        return { node, parentRoot: root };
      }
      const target = localDefinitionTarget(root, node.$ref);
      const scope = localDefinitionScopeIdentity(root);
      if (target === undefined || scope === undefined) return undefined;
      if (isObjectOrArray(target)) {
        const key = `${objectId(scope)}:${objectId(target)}`;
        if (seen.has(key)) return undefined;
        seen.add(key);
      }
      node = target;
    }
    return { node, parentRoot: root };
  };

  const covers = (
    storedNode: JSONSchema,
    candidateNode: JSONSchema,
    storedParentRoot: JSONSchema,
    candidateParentRoot: JSONSchema,
  ): boolean => {
    if (storedNode === false || candidateNode === true) return true;
    if (storedNode === true || candidateNode === false) {
      return storedNode === candidateNode;
    }
    const storedRoot = cfcSchemaChildRoot(storedNode, storedParentRoot);
    const candidateRoot = cfcSchemaChildRoot(
      candidateNode,
      candidateParentRoot,
    );
    const storedScope = localDefinitionScopeIdentity(storedRoot);
    const candidateScope = localDefinitionScopeIdentity(candidateRoot);
    if (storedScope === undefined || candidateScope === undefined) return false;
    const pairKey = [
      objectId(storedNode),
      objectId(storedScope),
      objectId(candidateNode),
      objectId(candidateScope),
    ].join(":");
    const pairState = pairStates.get(pairKey);
    if (pairState === "checking" || pairState === "covered") return true;
    if (pairState === "uncovered") return false;
    pairStates.set(pairKey, "checking");

    let covered: boolean;
    if (typeof candidateNode.$ref === "string") {
      const candidateSiblings = refSiblings(candidateNode);
      if (Object.keys(candidateSiblings).length === 0) {
        const resolvedCandidate = resolveBareRef(candidateNode, candidateRoot);
        covered = resolvedCandidate !== undefined && covers(
          storedNode,
          resolvedCandidate.node,
          storedRoot,
          resolvedCandidate.parentRoot,
        );
      } else {
        const candidateTarget = localDefinitionTarget(
          candidateRoot,
          candidateNode.$ref,
        );
        covered = candidateTarget !== undefined &&
          covers(
            storedNode,
            candidateTarget,
            storedRoot,
            candidateRoot,
          ) &&
          covers(
            storedNode,
            candidateSiblings,
            storedRoot,
            candidateRoot,
          );
      }
    } else if (typeof storedNode.$ref === "string") {
      const storedSiblings = refSiblings(storedNode);
      if (Object.keys(storedSiblings).length === 0) {
        const resolvedStored = resolveBareRef(storedNode, storedRoot);
        covered = resolvedStored !== undefined && covers(
          resolvedStored.node,
          candidateNode,
          resolvedStored.parentRoot,
          candidateRoot,
        );
      } else {
        const storedTarget = localDefinitionTarget(storedRoot, storedNode.$ref);
        covered = storedTarget !== undefined &&
          (covers(
            storedTarget,
            candidateNode,
            storedRoot,
            candidateRoot,
          ) ||
            covers(
              storedSiblings,
              candidateNode,
              storedRoot,
              candidateRoot,
            ));
      }
    } else {
      covered = Object.entries(candidateNode).every(([key, candidateValue]) => {
        if (key === "$defs" || candidateValue === undefined) return true;
        const storedValue = storedNode[key as keyof JSONSchemaObj];
        if (key === "required") {
          return Array.isArray(candidateValue) && Array.isArray(storedValue) &&
            candidateValue.every((name) => storedValue.includes(name));
        }
        if (key === "ifc") {
          try {
            return deepEqual(
              mergeIfc(
                storedValue as JSONSchemaObj["ifc"],
                candidateValue as JSONSchemaObj["ifc"],
                "",
                {},
              ),
              mergeIfc(
                storedValue as JSONSchemaObj["ifc"],
                storedValue as JSONSchemaObj["ifc"],
                "",
                {},
              ),
            );
          } catch {
            return false;
          }
        }
        if (key === "properties") {
          if (
            !isObjectOrArray(candidateValue) || !isObjectOrArray(storedValue)
          ) {
            return false;
          }
          const storedRecord = storedValue as Record<string, JSONSchema>;
          return Object.entries(candidateValue).every(
            ([name, candidateChild]) =>
              Object.hasOwn(storedRecord, name) &&
              covers(
                storedRecord[name],
                candidateChild as JSONSchema,
                storedRoot,
                candidateRoot,
              ),
          );
        }
        if (key === "items") {
          return candidateNode.prefixItems === undefined &&
            storedNode.prefixItems === undefined && storedValue !== undefined &&
            covers(
              storedValue as JSONSchema,
              candidateValue as JSONSchema,
              storedRoot,
              candidateRoot,
            );
        }
        if (key === "additionalProperties") {
          if (
            candidateNode.patternProperties !== undefined ||
            storedNode.patternProperties !== undefined ||
            storedValue === undefined ||
            !covers(
              storedValue as JSONSchema,
              candidateValue as JSONSchema,
              storedRoot,
              candidateRoot,
            )
          ) return false;
          const candidateProperties = candidateNode.properties ?? {};
          return Object.entries(storedNode.properties ?? {}).every(
            ([name, storedProperty]) =>
              Object.hasOwn(candidateProperties, name) ||
              covers(
                storedProperty,
                candidateValue as JSONSchema,
                storedRoot,
                candidateRoot,
              ),
          );
        }
        if (key === "prefixItems") {
          return candidateNode.items === undefined &&
            Array.isArray(candidateValue) && Array.isArray(storedValue) &&
            candidateValue.length === storedValue.length &&
            candidateValue.every((candidateChild, index) =>
              covers(
                storedValue[index],
                candidateChild,
                storedRoot,
                candidateRoot,
              )
            );
        }
        if (unsupportedSingleApplicatorKeys.has(key)) {
          return !schemaContainsRef(storedValue) &&
            !schemaContainsRef(candidateValue) &&
            deepEqual(storedValue, candidateValue);
        }
        if (unsupportedArrayApplicatorKeys.has(key)) {
          return Array.isArray(storedValue) && Array.isArray(candidateValue) &&
            !storedValue.some(schemaContainsRef) &&
            !candidateValue.some(schemaContainsRef) &&
            deepEqual(storedValue, candidateValue);
        }
        if (unsupportedRecordApplicatorKeys.has(key)) {
          return isObjectOrArray(storedValue) &&
            isObjectOrArray(candidateValue) &&
            !Object.values(storedValue).some(schemaContainsRef) &&
            !Object.values(candidateValue).some(schemaContainsRef) &&
            deepEqual(storedValue, candidateValue);
        }
        return deepEqual(storedValue, candidateValue);
      });
    }
    pairStates.set(pairKey, covered ? "covered" : "uncovered");
    return covered;
  };

  return covers(stored, candidate, stored, candidate);
};

const mergeSchemaNode = (
  existing: JSONSchema,
  candidate: JSONSchema,
  path = "",
  logicalPath: readonly string[] = [],
  options: MergeCfcSchemaEnvelopeOptions = {},
  existingRoot: JSONSchema = existing,
  candidateRoot: JSONSchema = candidate,
  activeRefMerges: readonly ActiveRefMerge[] = [],
  context: SchemaMergeContext = {
    nextDefinition: 0,
    syntheticDefinitions: {},
    reservedDefinitionNames: new Set([
      ...schemaDefinitionNames(existingRoot),
      ...schemaDefinitionNames(candidateRoot),
    ]),
  },
): JSONSchema => {
  const left = asSchemaObject(existing, path);
  let right = asSchemaObject(candidate, path);
  if (
    isObjectOrArray(left.$defs) && isObjectOrArray(right.$defs) &&
    Object.keys(left.$defs).some((name) =>
      Object.hasOwn(right.$defs!, name) &&
      !deepEqual(left.$defs![name], right.$defs![name])
    )
  ) {
    right = namespaceCandidateDefinitionsForMerge(left, right);
  }
  const existingScope = cfcSchemaChildRoot(left, existingRoot);
  const candidateScope = cfcSchemaChildRoot(right, candidateRoot);
  if (typeof left.$ref === "string" || typeof right.$ref === "string") {
    const repeated = activeRefMerges.find((active) =>
      active.existingRoot === existingScope &&
      active.candidateRoot === candidateScope &&
      active.existingRef === left.$ref &&
      active.candidateRef === right.$ref
    ) ?? activeRefMerges.find((active) =>
      localRefsResolveToSameTarget(
        existingScope,
        left.$ref,
        active.existingRoot,
        active.existingRef,
      ) &&
      localRefsResolveToSameTarget(
        candidateScope,
        right.$ref,
        active.candidateRoot,
        active.candidateRef,
      )
    );
    if (repeated) {
      if (deepEqual(left, right)) {
        const repeatedRef = `#/$defs/${repeated.definitionName}`;
        return typeof left.$ref === "string" &&
            /^#\/\$defs\/__cfc_merged_ref_[0-9]+$/.test(left.$ref) &&
            left.$ref !== repeatedRef
          ? { ...left, $ref: repeatedRef }
          : left;
      }
      const referenceNames = (schema: JSONSchemaObj): string[] => [
        ...(typeof schema.$ref === "string" ? [schema.$ref] : []),
        ...(Array.isArray(schema.allOf) &&
            schema.allOf.every((branch) =>
              isObjectOrArray(branch) &&
              typeof branch.$ref === "string" &&
              Object.keys(branch).length === 1
            )
          ? schema.allOf.map((branch) =>
            (branch as JSONSchemaObj).$ref!
          )
          : []),
      ];
      const resolvedReferenceTargets = (
        schema: JSONSchemaObj,
        root: JSONSchema,
      ): JSONSchemaObj[] =>
        referenceNames(schema).map(($ref) =>
          asSchemaObject(
            resolveCfcSchemaRefsOrThrow({ $ref }, root),
            path,
          )
        );
      const resolvedLeft = resolvedReferenceTargets(left, existingScope);
      const resolvedRight = resolvedReferenceTargets(right, candidateScope);
      const withoutRefScopeAndRequired = (
        schema: JSONSchemaObj,
      ): JSONSchemaObj => {
        const sibling = { ...schema };
        delete sibling.$ref;
        delete sibling.$defs;
        delete sibling.required;
        if (
          Array.isArray(sibling.allOf) &&
          sibling.allOf.every((branch) =>
            isObjectOrArray(branch) &&
            typeof branch.$ref === "string" &&
            Object.keys(branch).length === 1
          )
        ) {
          delete sibling.allOf;
        }
        return sibling;
      };
      const mergedSiblings = asSchemaObject(
        mergeSchemaNode(
          withoutRefScopeAndRequired(left),
          withoutRefScopeAndRequired(right),
          path,
          logicalPath,
          options,
          existingScope,
          candidateScope,
          activeRefMerges,
        ),
        path,
      );
      const required = mergeRequired(
        [
          ...new Set([
            ...resolvedLeft.flatMap((schema) => schema.required ?? []),
            ...(left.required ?? []),
          ]),
        ],
        [
          ...new Set([
            ...resolvedRight.flatMap((schema) => schema.required ?? []),
            ...(right.required ?? []),
          ]),
        ],
        [
          ...resolvedLeft.map((schema) => ({
            properties: schema.properties,
            root: cfcSchemaChildRoot(schema, existingScope),
          })),
          { properties: left.properties, root: existingScope },
          ...resolvedRight.map((schema) => ({
            properties: schema.properties,
            root: cfcSchemaChildRoot(schema, candidateScope),
          })),
          { properties: right.properties, root: candidateScope },
        ].reduce<Record<string, JSONSchema>>((properties, source) => {
          for (
            const [name, unresolvedProperty] of Object.entries(
              source.properties ?? {},
            )
          ) {
            const property = isObjectOrArray(unresolvedProperty) &&
                typeof unresolvedProperty.$ref === "string"
              ? resolveCfcSchemaRefsOrThrow(
                unresolvedProperty,
                cfcSchemaChildRoot(unresolvedProperty, source.root),
              )
              : unresolvedProperty;
            const previous = properties[name];
            properties[name] = isObjectOrArray(previous) &&
                isObjectOrArray(property)
              ? {
                ...previous,
                ...property,
                ...(Object.hasOwn(previous, "default") ||
                    Object.hasOwn(property, "default")
                  ? {
                    default: mergeDefaults(
                      previous.default,
                      property.default,
                      Object.hasOwn(previous, "default"),
                      Object.hasOwn(property, "default"),
                    ),
                  }
                  : {}),
              }
              : property;
          }
          return properties;
        }, {}),
        logicalPath,
        options,
      );
      const localDefinitions = mergeDefinitions(left.$defs, right.$defs);
      return {
        $ref: `#/$defs/${repeated.definitionName}`,
        ...mergedSiblings,
        ...(required !== undefined ? { required } : {}),
        ...(localDefinitions !== undefined ? { $defs: localDefinitions } : {}),
      };
    }
    const resolvedLeft = typeof left.$ref === "string"
      ? resolveCfcSchemaRefsOrThrow({ $ref: left.$ref }, existingScope)
      : left;
    const resolvedRight = typeof right.$ref === "string"
      ? resolveCfcSchemaRefsOrThrow({ $ref: right.$ref }, candidateScope)
      : right;
    const correspondingCycle = typeof left.$ref === "string" &&
      typeof right.$ref === "string" &&
      referencedTargetsHaveCorrespondingCycle(
        left.$ref,
        right.$ref,
        existingScope,
        candidateScope,
      );
    const reusableDefinitionName = correspondingCycle
      ? reusableMergedDefinitionName(left.$ref, existingScope) ??
        reusableMergedDefinitionName(right.$ref, candidateScope)
      : undefined;
    const reusesDefinition = reusableDefinitionName !== undefined;
    const preservesReference = reusesDefinition ||
      correspondingCycle &&
        (activeRefMerges.length > 0 ||
          /^#\/\$defs\/__cfc_merged_ref_[0-9]+$/.test(left.$ref ?? "") ||
          /^#\/\$defs\/__cfc_merged_ref_[0-9]+$/.test(right.$ref ?? ""));
    const definitionName = mergedDefinitionName(
      existingScope,
      candidateScope,
      context,
      reusableDefinitionName,
    );
    const mergedResolved = mergeSchemaNode(
      resolvedLeft,
      resolvedRight,
      path,
      logicalPath,
      options,
      cfcSchemaChildRoot(resolvedLeft, existingScope),
      cfcSchemaChildRoot(resolvedRight, candidateScope),
      [...activeRefMerges, {
        existingRoot: existingScope,
        candidateRoot: candidateScope,
        existingRef: left.$ref,
        candidateRef: right.$ref,
        definitionName,
      }],
      context,
    );
    if (isObjectOrArray(mergedResolved)) {
      const definition = { ...mergedResolved };
      delete definition.$defs;
      const scopeDefinitions = mergeDefinitions(
        isObjectOrArray(existingScope) ? existingScope.$defs : undefined,
        isObjectOrArray(candidateScope) ? candidateScope.$defs : undefined,
      );
      const availableDependencies = {
        ...(scopeDefinitions ?? {}),
        ...(mergedResolved.$defs ?? {}),
      };
      for (
        const activeDefinitionName of [
          definitionName,
          ...activeRefMerges.map((active) => active.definitionName),
          ...Object.keys(context.syntheticDefinitions),
        ]
      ) {
        delete availableDependencies[activeDefinitionName];
      }
      const dependencies = selectReferencedCfcSchemaDefs(
        definition,
        availableDependencies,
      );
      if (dependencies === undefined) {
        context.syntheticDefinitions[definitionName] = definition;
      } else {
        const usedNames = new Set([
          definitionName,
          ...Object.keys(context.syntheticDefinitions),
          ...context.reservedDefinitionNames,
        ]);
        const renamed = new Map<string, string>();
        let suffix = 0;
        for (const name of Object.keys(dependencies).toSorted()) {
          let candidate: string;
          do {
            candidate =
              `__cfc_merged_dep_${definitionName}_${suffix++}_${name}`;
          } while (usedNames.has(candidate));
          usedNames.add(candidate);
          renamed.set(name, candidate);
        }
        const recursiveTargetNames = new Set(
          [left.$ref, right.$ref].flatMap((ref) => {
            const match = ref?.match(/^#\/\$defs\/([^/]+)$/);
            return match === null || match === undefined
              ? []
              : [match[1].replaceAll("~1", "/").replaceAll("~0", "~")];
          }),
        );
        const rewriteDependencyRefs = (fragment: JSONSchema): JSONSchema => {
          if (!isObjectOrArray(fragment) || fragment.$defs !== undefined) {
            return fragment;
          }
          let rewritten = fragment;
          if (typeof fragment.$ref === "string") {
            const match = fragment.$ref.match(/^#\/\$defs\/([^/]+)$/);
            const name = match?.[1].replaceAll("~1", "/").replaceAll(
              "~0",
              "~",
            );
            const nextName = name !== undefined &&
                recursiveTargetNames.has(name)
              ? definitionName
              : name === undefined
              ? undefined
              : renamed.get(name);
            if (nextName !== undefined) {
              rewritten = {
                ...fragment,
                $ref: `#/$defs/${
                  nextName.replaceAll("~", "~0").replaceAll("/", "~1")
                }`,
              };
            }
          }
          return mapSubschemas(
            rewritten,
            rewriteDependencyRefs,
            { includeUnused: true },
          );
        };
        const liftedDependencies = Object.fromEntries(
          Object.entries(dependencies).map(([name, dependency]) => [
            renamed.get(name)!,
            rewriteDependencyRefs(dependency),
          ]),
        );
        Object.assign(context.syntheticDefinitions, liftedDependencies);
        context.syntheticDefinitions[definitionName] = rewriteDependencyRefs(
          definition,
        );
      }
    } else {
      context.syntheticDefinitions[definitionName] = mergedResolved;
    }
    const refSiteSiblings = (schema: JSONSchemaObj): JSONSchemaObj => {
      if (typeof schema.$ref !== "string") return {};
      const siblings = { ...schema };
      delete siblings.$ref;
      delete siblings.$defs;
      delete siblings.required;
      return siblings;
    };
    const mergedSiteSiblings = asSchemaObject(
      mergeSchemaNode(
        refSiteSiblings(left),
        refSiteSiblings(right),
        path,
        logicalPath,
        options,
        existingScope,
        candidateScope,
        activeRefMerges,
        context,
      ),
      path,
    );
    const effectiveRequired = (
      schema: JSONSchemaObj,
      resolved: JSONSchema,
    ): string[] | undefined => {
      const required = [
        ...(isObjectOrArray(resolved) ? resolved.required ?? [] : []),
        ...(schema.required ?? []),
      ];
      return required.length === 0 ? undefined : [...new Set(required)];
    };
    const siteRequired = mergeRequired(
      effectiveRequired(left, resolvedLeft),
      effectiveRequired(right, resolvedRight),
      [
        {
          properties: isObjectOrArray(resolvedLeft)
            ? resolvedLeft.properties
            : undefined,
          root: cfcSchemaChildRoot(resolvedLeft, existingScope),
        },
        { properties: left.properties, root: existingScope },
        {
          properties: isObjectOrArray(resolvedRight)
            ? resolvedRight.properties
            : undefined,
          root: cfcSchemaChildRoot(resolvedRight, candidateScope),
        },
        { properties: right.properties, root: candidateScope },
      ].reduce<Record<string, JSONSchema>>((properties, source) => {
        for (
          const [name, unresolvedProperty] of Object.entries(
            source.properties ?? {},
          )
        ) {
          const property = isObjectOrArray(unresolvedProperty) &&
              typeof unresolvedProperty.$ref === "string"
            ? resolveCfcSchemaRefsOrThrow(
              unresolvedProperty,
              cfcSchemaChildRoot(unresolvedProperty, source.root),
            )
            : unresolvedProperty;
          const previous = properties[name];
          properties[name] = isObjectOrArray(previous) &&
              isObjectOrArray(property)
            ? {
              ...previous,
              ...property,
              ...(Object.hasOwn(previous, "default") ||
                  Object.hasOwn(property, "default")
                ? {
                  default: mergeDefaults(
                    previous.default,
                    property.default,
                    Object.hasOwn(previous, "default"),
                    Object.hasOwn(property, "default"),
                  ),
                }
                : {}),
            }
            : property;
        }
        return properties;
      }, {}),
      logicalPath,
      options,
    );
    const { required: _mergedRequired, ...siteSiblingsWithoutRequired } =
      mergedSiteSiblings;
    const siteSiblings: JSONSchemaObj = siteRequired === undefined
      ? siteSiblingsWithoutRequired
      : { ...siteSiblingsWithoutRequired, required: siteRequired };
    const definedSiteSiblings = Object.fromEntries(
      Object.entries(siteSiblings).filter(([, value]) => value !== undefined),
    ) as JSONSchemaObj;
    const syntheticScope = { $defs: context.syntheticDefinitions };
    const syntheticReference = `#/$defs/${definitionName}`;
    if (
      preservesReference &&
      (activeRefMerges.length > 0 ||
        referencedTargetsHaveCorrespondingCycle(
          syntheticReference,
          syntheticReference,
          syntheticScope,
          syntheticScope,
        ))
    ) {
      const reference = {
        $ref: syntheticReference,
        ...definedSiteSiblings,
      };
      return path === ""
        ? attachSyntheticDefinitions(reference, context)
        : reference;
    }
    if (!isObjectOrArray(mergedResolved)) return mergedResolved;
    return attachSyntheticDefinitions({
      ...mergedResolved,
      ...definedSiteSiblings,
      ifc: mergeIfc(
        mergedResolved.ifc,
        siteSiblings.ifc,
        path,
        options,
      ),
      required: mergeRequired(
        mergedResolved.required,
        siteSiblings.required,
        {
          ...mergedResolved.properties,
          ...siteSiblings.properties,
        },
        logicalPath,
        options,
      ),
      ...(Object.hasOwn(mergedResolved, "default") ||
          Object.hasOwn(siteSiblings, "default")
        ? {
          default: mergeDefaults(
            mergedResolved.default,
            siteSiblings.default,
            Object.hasOwn(mergedResolved, "default"),
            Object.hasOwn(siteSiblings, "default"),
          ),
        }
        : {}),
    }, context);
  }
  const requiredViewForMerge = (
    schema: JSONSchemaObj,
    root: JSONSchema,
  ): Pick<JSONSchemaObj, "properties" | "required"> => {
    if (typeof schema.$ref !== "string") {
      return schema;
    }
    const definitionRoot = isObjectOrArray(schema.$defs) ? schema : root;
    return asSchemaObject(
      resolveCfcSchemaRefsOrThrow(schema, definitionRoot),
      path,
    );
  };
  const leftRequiredView = requiredViewForMerge(left, existingScope);
  const rightRequiredView = requiredViewForMerge(right, candidateScope);

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
  const leftIsUnknown = leftTypes?.includes("unknown") === true;
  const rightIsUnknown = rightTypes?.includes("unknown") === true;
  const scalarTypes = new Set([
    "boolean",
    "integer",
    "null",
    "number",
    "string",
  ]);
  const scalarTypeChange =
    leftTypes?.every((type) => scalarTypes.has(type)) === true &&
    rightTypes?.every((type) => scalarTypes.has(type)) === true;
  const typesChanged = leftTypes !== undefined && rightTypes !== undefined &&
    (leftTypes.length !== rightTypes.length ||
      !arraySubsetOf(leftTypes, rightTypes) ||
      !arraySubsetOf(rightTypes, leftTypes));
  const permissiveUnknownChange = typesChanged &&
    (leftIsUnknown || rightIsUnknown);
  const scalarTransition = scalarTypeChange && typesChanged
    ? {
      path: [...logicalPath],
      storedTypes: leftTypes as string[],
      candidateTypes: rightTypes as string[],
    }
    : undefined;
  const confirmedScalarChange = scalarTransition !== undefined &&
    (options.allowIncompatibleScalarTypes === true ||
      options.allowIncompatibleScalarTypeChange?.(scalarTransition) === true);
  if (typesChanged && confirmedScalarChange) {
    options.onIncompatibleScalarTypeChange?.(scalarTransition);
  }
  if (
    typesChanged &&
    !confirmedScalarChange &&
    !permissiveUnknownChange
  ) {
    throw new Error(
      `type changed incompatibly at ${path || "/"}: ${
        JSON.stringify(leftTypes)
      } -> ${JSON.stringify(rightTypes)}`,
    );
  }

  // A side's claim about a named key is its properties[key] where declared,
  // else its object-valued additionalProperties (the rest claim covering
  // every undeclared key) — the record twin of the prefixItems/items rule
  // below. So a key only one side names still merges with the other side's
  // rest claim rather than winning wholesale.
  const leftAdditional = typeof left.additionalProperties === "object" &&
      left.additionalProperties !== null
    ? left.additionalProperties
    : undefined;
  const rightAdditional = typeof right.additionalProperties === "object" &&
      right.additionalProperties !== null
    ? right.additionalProperties
    : undefined;
  const mergedProperties: Record<string, JSONSchema> = {};
  for (
    const key of new Set([
      ...Object.keys(left.properties ?? {}),
      ...Object.keys(right.properties ?? {}),
    ])
  ) {
    const leftClaim = left.properties?.[key] ?? leftAdditional;
    const rightClaim = right.properties?.[key] ?? rightAdditional;
    mergedProperties[key] = leftClaim !== undefined &&
        rightClaim !== undefined
      ? mergeSchemaNode(
        leftClaim,
        rightClaim,
        `${path}/${key}`,
        [...logicalPath, key],
        options,
        existingScope,
        candidateScope,
        activeRefMerges,
        context,
      )
      : (rightClaim ?? leftClaim)!;
  }
  const requiredProperties = {
    ...leftRequiredView.properties,
    ...rightRequiredView.properties,
    ...mergedProperties,
  };

  // Object-valued rest claims merge like items; boolean forms keep the
  // spread's right-wins behavior (closed-object union semantics are
  // CT-1898's question, not this merge's).
  let mergedAdditionalProperties = left.additionalProperties;
  if (leftAdditional !== undefined && rightAdditional !== undefined) {
    mergedAdditionalProperties = mergeSchemaNode(
      leftAdditional,
      rightAdditional,
      `${path}/*`,
      [...logicalPath, "*"],
      options,
      existingScope,
      candidateScope,
      activeRefMerges,
      context,
    );
  } else if (right.additionalProperties !== undefined) {
    mergedAdditionalProperties = right.additionalProperties;
  }

  let mergedItems = left.items;
  if (left.items !== undefined && right.items !== undefined) {
    mergedItems = mergeSchemaNode(
      left.items,
      right.items,
      `${path}/*`,
      [...logicalPath, "*"],
      options,
      existingScope,
      candidateScope,
      activeRefMerges,
      context,
    );
  } else if (right.items !== undefined) {
    mergedItems = right.items;
  }

  // Tuple slots merge slot-wise like properties — the `{...left, ...right}`
  // spread below would otherwise let one side's prefixItems win wholesale,
  // dropping the other side's slot ifc/defaults. A side's claim about slot
  // index i is its prefixItems[i] where declared, else its rest `items`
  // (2020-12: `items` speaks for every index past that side's slots). So a
  // shorter side's `items` claim merges into the longer side's extra slots,
  // and a side introducing prefixItems beside an items-only side merges
  // each slot with that `items` claim rather than winning wholesale.
  let mergedPrefixItems: JSONSchema[] | undefined;
  if (left.prefixItems !== undefined || right.prefixItems !== undefined) {
    const slotClaim = (
      side: typeof left,
      index: number,
    ): JSONSchema | undefined =>
      side.prefixItems !== undefined && index < side.prefixItems.length
        ? side.prefixItems[index]
        : side.items;
    const length = Math.max(
      left.prefixItems?.length ?? 0,
      right.prefixItems?.length ?? 0,
    );
    const slots: JSONSchema[] = [];
    for (let index = 0; index < length; index++) {
      const leftSlot = slotClaim(left, index);
      const rightSlot = slotClaim(right, index);
      slots.push(
        leftSlot !== undefined && rightSlot !== undefined
          ? mergeSchemaNode(
            leftSlot,
            rightSlot,
            `${path}/${index}`,
            [...logicalPath, String(index)],
            options,
            existingScope,
            candidateScope,
            activeRefMerges,
            context,
          )
          : (rightSlot ?? leftSlot)!,
      );
    }
    mergedPrefixItems = slots;
  }

  // Unequal same-name definition scopes are namespaced before their reference
  // sites are merged. Equal definitions can share a name. Unreachable
  // definitions are pruned after the two definition maps are combined.
  const merged = {
    ...left,
    ...right,
    ...(permissiveUnknownChange && rightIsUnknown ? { type: left.type } : {}),
    ...(Object.keys(mergedProperties).length > 0
      ? { properties: mergedProperties }
      : {}),
    ...(mergedItems !== undefined ? { items: mergedItems } : {}),
    ...(mergedPrefixItems !== undefined
      ? { prefixItems: mergedPrefixItems }
      : {}),
    ...(mergedAdditionalProperties !== undefined
      ? { additionalProperties: mergedAdditionalProperties }
      : {}),
    ifc: mergeIfc(left.ifc, right.ifc, path, options),
    required: mergeRequired(
      leftRequiredView.required,
      rightRequiredView.required,
      requiredProperties,
      logicalPath,
      options,
    ),
    ...(Object.hasOwn(left, "default") || Object.hasOwn(right, "default")
      ? {
        default: mergeDefaults(
          left.default,
          right.default,
          Object.hasOwn(left, "default"),
          Object.hasOwn(right, "default"),
        ),
      }
      : {}),
  } as Record<string, unknown>;
  delete merged.$defs;
  const definitions = selectReferencedCfcSchemaDefs(
    merged as JSONSchemaObj,
    {
      ...mergeDefinitions(left.$defs, right.$defs),
      ...context.syntheticDefinitions,
    },
  );
  if (definitions !== undefined) merged.$defs = definitions;
  return merged as JSONSchemaObj;
};

export const mergeCfcSchemaEnvelopes = (
  existing: JSONSchema,
  candidate: JSONSchema,
  options: MergeCfcSchemaEnvelopeOptions = {},
): JSONSchema => {
  assertNoDivergentIfcBranches(existing, candidate);
  assertNoDivergentIfcBranches(candidate, existing);
  if (
    !options.allowAddIntegrityWeakening &&
    storedRecursiveGraphCoversCandidate(existing, candidate)
  ) {
    return internSchema(existing);
  }
  return internSchema(mergeSchemaNode(existing, candidate, "", [], options));
};

/** Why a stored envelope and a candidate envelope cannot be merged. */
export interface CfcSchemaMergeIssue {
  /** The merge's own human-readable reason, verbatim. */
  message: string;
  /**
   * True when the rejection is the additive-required migration class — an old
   * document predating a now-required field that declares no default. This is
   * the class the runnability backstop rolls forward on
   * (see {@link CfcSchemaMigrationError}); everything else is a hard
   * incompatibility that no roll-forward recovers.
   */
  migration: boolean;
}

/**
 * Would {@link mergeCfcSchemaEnvelopes} accept this candidate over this stored
 * envelope? `undefined` means yes.
 *
 * Why this exists: replacing a live piece's pattern source used to discover an
 * unmergeable envelope only by attempting the swap and taking a low-level
 * rejection from the setup commit. That is the failure `cf piece setsrc
 * --check` is supposed to predict, so the preflight drives THIS seam — the
 * same merge the commit runs, called in dry-run — rather than a second
 * implementation of the rules that would drift out of agreement with
 * enforcement and start green-lighting swaps the deploy then refuses.
 *
 * Pure: no transaction, no writes, because the merge itself is.
 */
export const cfcSchemaMergeIssue = (
  existing: JSONSchema,
  candidate: JSONSchema,
  options: MergeCfcSchemaEnvelopeOptions = {},
): CfcSchemaMergeIssue | undefined => {
  try {
    mergeCfcSchemaEnvelopes(existing, candidate, options);
    return undefined;
  } catch (error) {
    if (error instanceof CfcSchemaMigrationError) {
      return { message: error.message, migration: true };
    }
    return {
      message: error instanceof Error ? error.message : String(error),
      migration: false,
    };
  }
};

/** Exact scalar type transitions accepted by an otherwise valid merge. */
export const cfcScalarTypeTransitions = (
  existing: JSONSchema,
  candidate: JSONSchema,
  generatedOutputPaths?: readonly (readonly string[])[],
): readonly CfcScalarTypeTransition[] | undefined => {
  const transitions = new Map<string, CfcScalarTypeTransition>();
  try {
    mergeCfcSchemaEnvelopes(existing, candidate, {
      generatedOutputPaths,
      allowIncompatibleScalarTypes: true,
      onIncompatibleScalarTypeChange: (transition) => {
        transitions.set(JSON.stringify(transition), transition);
      },
    });
  } catch {
    return undefined;
  }
  return transitions.size > 0 ? [...transitions.values()] : undefined;
};
