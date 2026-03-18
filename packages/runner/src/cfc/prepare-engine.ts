import type { JSONSchema } from "../builder/types.ts";
import { deepEqual } from "@commontools/utils/deep-equal";
import { ContextualFlowControl } from "../cfc.ts";
import type {
  ICfcInputRequirementViolationError,
  ICfcOutputTransitionViolationError,
  ICfcPolicyNonConvergenceError,
  ICfcPrepareSchemaUnavailableError,
  ICfcSchemaHashMismatchError,
  IExtendedStorageTransaction,
  IMemorySpaceAddress,
  Labels,
} from "../storage/interface.ts";
import { computeCfcActivityDigest } from "./activity-digest.ts";
import {
  type CanonicalBoundaryActivity,
  type CanonicalBoundaryRead,
  canonicalizeBoundaryActivity,
  canonicalizeStoragePath,
  escapeJsonPointerToken,
} from "./canonical-activity.ts";
import { partitionConsumedBoundaryReads } from "./consumed-reads.ts";
import {
  collectConsumedInputLabels,
  consumedReadEntityKey,
  type ConsumedReadWithEffectiveLabel,
} from "./consumed-input-labels.ts";
import {
  internalVerifierReadAnnotations,
  readMaxConfidentialityFromMeta,
  readRequiredIntegrityFromMeta,
} from "./internal-markers.ts";
import { markReadAsPotentialWriteMarker } from "../storage/read-metadata.ts";
import { getCfcWriteSchemaContext } from "./schema-context.ts";
import { computeCfcSchemaHash } from "./schema-hash.ts";
import { cfcSchemaBlobAddress } from "./schema-blob.ts";
import {
  cfcEntityKey,
  cfcLabelsAddress,
  normalizePersistedLabels,
} from "./shared.ts";
import type { CfcImplementationIdentity } from "./implementation-identity.ts";
import { canonicalLabelPathMatchesReadPath } from "./path-matching.ts";
import { selectFlowPrecisionConsumedReads } from "./flow-precision.ts";
import {
  type CfcTrustContext,
  integritySatisfiesRequiredIntegrity,
} from "./integrity-trust.ts";
import {
  type CfcPatternBindings,
  type CfcPatternBindingValue,
  matchPatternWithBindings,
  resolvePatternWithBindings,
} from "./policy-bindings.ts";
import { cfcPolicyStateAddress } from "./policy-state.ts";
import {
  type CfcAtom,
  type CfcConfidentialityLabel,
  type CfcIntegrityLabel,
  confidentialityDominates,
  confidentialityFromLegacyAtom,
  confidentialitySatisfiesMax,
  joinConfidentialityLabels,
  joinIntegrityLabels,
  normalizeConfidentialityLabel,
  normalizeIntegrityLabel,
} from "./label-algebra.ts";
import type { CfcImplementationTrustEvaluator } from "./trust-lattice.ts";

type EntityAddress = Pick<IMemorySpaceAddress, "space" | "id" | "type">;

export interface PrepareBoundaryCommitOptions {
  readonly allowSchemaHashMigration?: (
    entity: EntityAddress,
    expectedSchemaHash: string,
    actualSchemaHash: string,
  ) => boolean;
  readonly implementationIdentity?: CfcImplementationIdentity;
  readonly actingPrincipal?: string;
  readonly trustContext?: CfcTrustContext;
  readonly trustEvaluator?: CfcImplementationTrustEvaluator;
}

function CfcPrepareSchemaUnavailableError(
  entity: EntityAddress,
): ICfcPrepareSchemaUnavailableError {
  return {
    name: "CfcPrepareSchemaUnavailableError",
    message:
      "CFC prepare could not resolve schema for commit-bearing relevant write",
    space: entity.space,
    id: entity.id,
    type: entity.type,
  };
}

function CfcSchemaHashMismatchError(
  entity: EntityAddress,
  expectedSchemaHash: string,
  actualSchemaHash: string,
): ICfcSchemaHashMismatchError {
  return {
    name: "CfcSchemaHashMismatchError",
    message: "CFC prepare found existing schema hash that does not match",
    expectedSchemaHash,
    actualSchemaHash,
    space: entity.space,
    id: entity.id,
    type: entity.type,
  };
}

function CfcMaxConfidentialityViolationError(
  read: CanonicalBoundaryRead,
  maxConfidentiality: readonly string[],
  actualClassification: CfcConfidentialityLabel | undefined,
): ICfcInputRequirementViolationError {
  return {
    name: "CfcInputRequirementViolationError",
    message:
      "CFC prepare input requirement failed: consumed input exceeds maxConfidentiality",
    requirement: "maxConfidentiality",
    space: read.space as IMemorySpaceAddress["space"],
    id: read.id as IMemorySpaceAddress["id"],
    type: read.type,
    path: read.path,
    maxConfidentiality: [...maxConfidentiality],
    actualClassification,
  };
}

function CfcRequiredIntegrityViolationError(
  read: CanonicalBoundaryRead,
  requiredIntegrity: CfcIntegrityLabel,
  actualIntegrity: CfcIntegrityLabel | undefined,
  path = read.path,
): ICfcInputRequirementViolationError {
  return {
    name: "CfcInputRequirementViolationError",
    message:
      "CFC prepare input requirement failed: consumed input misses requiredIntegrity",
    requirement: "requiredIntegrity",
    space: read.space as IMemorySpaceAddress["space"],
    id: read.id as IMemorySpaceAddress["id"],
    type: read.type,
    path,
    requiredIntegrity: [...requiredIntegrity],
    actualIntegrity,
  };
}

function CfcStatePreconditionReadViolationError(
  entity: EntityAddress,
  path: string,
  requiredReadPath: string,
): ICfcInputRequirementViolationError {
  return {
    name: "CfcInputRequirementViolationError",
    message:
      "CFC prepare input requirement failed: state precondition required read was not observed in this attempt",
    requirement: "statePreconditionRead",
    space: entity.space,
    id: entity.id,
    type: entity.type,
    path,
    requiredReadPath,
  };
}

function CfcStatePreconditionPredicateViolationError(
  entity: EntityAddress,
  path: string,
  predicatePath: string,
  expectedValue: unknown,
  actualValue: unknown,
): ICfcInputRequirementViolationError {
  return {
    name: "CfcInputRequirementViolationError",
    message:
      "CFC prepare input requirement failed: state precondition predicate did not hold",
    requirement: "statePreconditionPredicate",
    space: entity.space,
    id: entity.id,
    type: entity.type,
    path,
    predicatePath,
    expectedValue,
    actualValue,
  };
}

function CfcOutputTransitionViolationError(
  entity: EntityAddress,
  path: string,
  minClassification: CfcConfidentialityLabel | undefined,
  actualClassification: CfcConfidentialityLabel | undefined,
): ICfcOutputTransitionViolationError {
  return {
    name: "CfcOutputTransitionViolationError",
    message:
      "CFC prepare output transition failed: write classification is not monotone with consumed input",
    requirement: "confidentialityMonotonicity",
    space: entity.space,
    id: entity.id,
    type: entity.type,
    path,
    minClassification,
    actualClassification,
  };
}

function CfcWriteAuthorizedByViolationError(
  entity: EntityAddress,
  path: string,
): ICfcOutputTransitionViolationError {
  return {
    name: "CfcOutputTransitionViolationError",
    message:
      "CFC prepare output transition failed: write implementation identity is not in writeAuthorizedBy",
    requirement: "writeAuthorizedBy",
    space: entity.space,
    id: entity.id,
    type: entity.type,
    path,
  };
}

function CfcOutputExactCopyViolationError(
  entity: EntityAddress,
  path: string,
  sourcePath: string,
): ICfcOutputTransitionViolationError {
  return {
    name: "CfcOutputTransitionViolationError",
    message:
      "CFC prepare output transition failed: exactCopyOf assertion was not satisfied",
    requirement: "exactCopyOf",
    space: entity.space,
    id: entity.id,
    type: entity.type,
    path,
    sourcePath,
  };
}

function CfcOutputProjectionViolationError(
  entity: EntityAddress,
  path: string,
  sourcePath: string,
  projectionPath: string,
): ICfcOutputTransitionViolationError {
  return {
    name: "CfcOutputTransitionViolationError",
    message:
      "CFC prepare output transition failed: projection assertion was not satisfied",
    requirement: "projection",
    space: entity.space,
    id: entity.id,
    type: entity.type,
    path,
    sourcePath,
    projectionPath,
  };
}

type CollectionTransitionRequirement =
  | "subsetOf"
  | "permutationOf"
  | "filteredFrom"
  | "lengthPreserved";

function CfcOutputCollectionViolationError(
  entity: EntityAddress,
  path: string,
  requirement: CollectionTransitionRequirement,
  sourcePath?: string,
): ICfcOutputTransitionViolationError {
  const detail = requirement === "lengthPreserved"
    ? "lengthPreserved assertion was not satisfied"
    : `${requirement} collection assertion was not satisfied`;
  return {
    name: "CfcOutputTransitionViolationError",
    message: `CFC prepare output transition failed: ${detail}`,
    requirement,
    space: entity.space,
    id: entity.id,
    type: entity.type,
    path,
    ...(sourcePath ? { sourcePath } : {}),
  };
}

function CfcOutputRecomposeProjectionsViolationError(
  entity: EntityAddress,
  path: string,
  sourcePath: string,
): ICfcOutputTransitionViolationError {
  return {
    name: "CfcOutputTransitionViolationError",
    message:
      "CFC prepare output transition failed: recomposeProjections assertion was not satisfied",
    requirement: "recomposeProjections",
    space: entity.space,
    id: entity.id,
    type: entity.type,
    path,
    sourcePath,
  };
}

function CfcPolicyNonConvergenceError(
  entity: EntityAddress,
  path: string,
  fuel: number,
): ICfcPolicyNonConvergenceError {
  return {
    name: "CfcPolicyNonConvergenceError",
    message:
      "CFC prepare policy evaluation did not converge before fuel exhaustion",
    space: entity.space,
    id: entity.id,
    type: entity.type,
    path,
    fuel,
  };
}

function collectWrittenEntities(
  canonical: CanonicalBoundaryActivity,
): EntityAddress[] {
  const entities = new Map<string, EntityAddress>();
  for (const write of canonical.attemptedWrites) {
    const entity: EntityAddress = {
      space: write.space as IMemorySpaceAddress["space"],
      id: write.id as IMemorySpaceAddress["id"],
      type: write.type as IMemorySpaceAddress["type"],
    };
    entities.set(cfcEntityKey(entity), entity);
  }
  return [...entities.values()];
}

function schemaHashAddress(entity: EntityAddress): IMemorySpaceAddress {
  return {
    space: entity.space,
    id: entity.id,
    type: entity.type,
    path: ["cfc", "schemaHash"],
  };
}

function schemaBlobAddress(
  entity: EntityAddress,
  schemaHash: string,
): IMemorySpaceAddress {
  return cfcSchemaBlobAddress(entity.space, schemaHash);
}

function computePreparedLabels(schema: JSONSchema): Record<string, Labels> {
  type LabelAccumulator = {
    classification?: CfcConfidentialityLabel;
    integrity?: CfcIntegrityLabel;
  };
  const byPath = new Map<string, LabelAccumulator>();

  const ensureAccumulator = (path: string): LabelAccumulator => {
    let accumulator = byPath.get(path);
    if (!accumulator) {
      accumulator = {};
      byPath.set(path, accumulator);
    }
    return accumulator;
  };

  const pushLabelsForPath = (
    path: string,
    classification: CfcConfidentialityLabel | undefined,
    integrity: CfcIntegrityLabel | undefined,
  ) => {
    if (!classification && !integrity) {
      return;
    }
    const accumulator = ensureAccumulator(path);
    accumulator.classification = joinConfidentialityLabels(
      accumulator.classification,
      classification,
    );
    accumulator.integrity = joinIntegrityLabels(
      accumulator.integrity,
      integrity,
    );
  };

  const resolveNodeRefs = (
    node: JSONSchema,
    fullSchema: JSONSchema,
  ): JSONSchema | undefined => {
    if (
      typeof node !== "object" || node === null || Array.isArray(node) ||
      !("$ref" in node)
    ) {
      return node;
    }
    return ContextualFlowControl.resolveSchemaRefs(node, fullSchema);
  };

  const collect = (
    node: JSONSchema | undefined,
    path: string,
    inheritedClassification: CfcConfidentialityLabel | undefined,
    inheritedIntegrity: CfcIntegrityLabel | undefined,
    fullSchema: JSONSchema,
    stack: Set<object>,
  ) => {
    if (!node || typeof node !== "object" || Array.isArray(node)) {
      return;
    }
    const resolved = resolveNodeRefs(node, fullSchema);
    if (!resolved || typeof resolved !== "object" || Array.isArray(resolved)) {
      return;
    }
    node = resolved;

    if (stack.has(node)) {
      return;
    }
    stack.add(node);

    const ifc = (node as { ifc?: unknown }).ifc;
    const localClassification = ifc && typeof ifc === "object" &&
        !Array.isArray(ifc)
      ? normalizeConfidentialityLabel(
        (ifc as { classification?: unknown }).classification,
      )
      : undefined;
    const localIntegrity = ifc && typeof ifc === "object" &&
        !Array.isArray(ifc)
      ? normalizeIntegrityLabel((ifc as { integrity?: unknown }).integrity)
      : undefined;

    const classification = joinConfidentialityLabels(
      inheritedClassification,
      localClassification,
    );
    const integrity = joinIntegrityLabels(
      inheritedIntegrity,
      localIntegrity,
    );

    pushLabelsForPath(path, classification, integrity);

    const properties = (node as { properties?: unknown }).properties;
    if (
      properties && typeof properties === "object" && !Array.isArray(properties)
    ) {
      for (const [key, child] of Object.entries(properties)) {
        const childPath = appendCanonicalSegment(path, key);
        collect(
          child as JSONSchema,
          childPath,
          classification,
          integrity,
          fullSchema,
          stack,
        );
      }
    }

    const additionalProperties =
      (node as { additionalProperties?: unknown }).additionalProperties;
    if (
      additionalProperties && typeof additionalProperties === "object" &&
      !Array.isArray(additionalProperties)
    ) {
      const childPath = appendCanonicalSegment(path, "*");
      collect(
        additionalProperties as JSONSchema,
        childPath,
        classification,
        integrity,
        fullSchema,
        stack,
      );
    }

    const items = (node as { items?: unknown }).items;
    if (items && typeof items === "object" && !Array.isArray(items)) {
      const childPath = appendCanonicalSegment(path, "*");
      collect(
        items as JSONSchema,
        childPath,
        classification,
        integrity,
        fullSchema,
        stack,
      );
    }

    const prefixItems = (node as { prefixItems?: unknown }).prefixItems;
    if (Array.isArray(prefixItems)) {
      for (let index = 0; index < prefixItems.length; index++) {
        collect(
          prefixItems[index] as JSONSchema,
          appendCanonicalSegment(path, String(index)),
          classification,
          integrity,
          fullSchema,
          stack,
        );
      }
    }

    const composed = [
      (node as { anyOf?: unknown }).anyOf,
      (node as { oneOf?: unknown }).oneOf,
      (node as { allOf?: unknown }).allOf,
    ];
    for (const options of composed) {
      if (!Array.isArray(options)) {
        continue;
      }
      for (const option of options) {
        collect(
          option as JSONSchema,
          path,
          classification,
          integrity,
          fullSchema,
          stack,
        );
      }
    }

    stack.delete(node);
  };

  collect(schema, "/", undefined, undefined, schema, new Set());

  const result: Record<string, Labels> = {};
  for (const [path, { classification, integrity }] of byPath) {
    if (!classification && !integrity) {
      continue;
    }
    result[path] = {
      ...(classification ? { classification } : {}),
      ...(integrity ? { integrity } : {}),
    };
  }
  return result;
}

type PreparedWriteSchema = {
  readonly entity: EntityAddress;
  readonly schema: JSONSchema;
  readonly labels: Record<string, Labels>;
  readonly actualSchemaHash: string;
  readonly shouldWriteSchemaHash: boolean;
};

function canonicalAncestorPaths(path: string): string[] {
  if (path === "/") {
    return ["/"];
  }

  const trimmed = path.startsWith("/") ? path.slice(1) : path;
  const segments = trimmed.length === 0
    ? []
    : trimmed.split("/").filter((segment) => segment.length > 0);
  const ancestors = ["/"];
  for (let index = 0; index < segments.length; index++) {
    ancestors.push(
      `/${segments.slice(0, index + 1).map(escapeJsonPointerToken).join("/")}`,
    );
  }
  return ancestors;
}

function mergeLabel(
  base: Labels | undefined,
  dynamic: Labels | undefined,
): Labels | undefined {
  if (!base && !dynamic) {
    return undefined;
  }

  const classification = joinConfidentialityLabels(
    base?.classification,
    dynamic?.classification,
  );
  const integrity = joinIntegrityLabels(base?.integrity, dynamic?.integrity);

  if (!classification && !integrity) {
    return undefined;
  }

  return {
    ...(classification ? { classification } : {}),
    ...(integrity ? { integrity } : {}),
  };
}

function mergePreparedLabels(
  baseLabels: Record<string, Labels>,
  dynamicLabels: Record<string, Labels> | undefined,
): Record<string, Labels> {
  if (!dynamicLabels) {
    return baseLabels;
  }

  const merged: Record<string, Labels> = { ...baseLabels };
  for (
    const path of new Set([
      ...Object.keys(baseLabels),
      ...Object.keys(dynamicLabels),
    ])
  ) {
    const label = mergeLabel(baseLabels[path], dynamicLabels[path]);
    if (label) {
      merged[path] = label;
    }
  }
  return merged;
}

function collectDynamicWriteIntegrity(
  consumedReadLabels: readonly ConsumedReadWithEffectiveLabel[],
): CfcIntegrityLabel | undefined {
  let integrity: CfcIntegrityLabel | undefined;
  for (const consumed of consumedReadLabels) {
    integrity = joinIntegrityLabels(
      integrity,
      consumed.effectiveLabel?.integrity,
    );
  }
  return integrity;
}

function recordDynamicWriteIntegrity(
  labelsByEntity: Map<string, Record<string, Labels>>,
  entity: EntityAddress,
  writePath: string,
  integrity: CfcIntegrityLabel | undefined,
): void {
  if (!integrity || integrity.length === 0) {
    return;
  }

  const entityKey = cfcEntityKey(entity);
  const labels = { ...(labelsByEntity.get(entityKey) ?? {}) };
  for (const path of canonicalAncestorPaths(writePath)) {
    const merged = mergeLabel(labels[path], { integrity });
    if (merged) {
      labels[path] = merged;
    }
  }
  labelsByEntity.set(entityKey, labels);
}

function recordDynamicWriteClassification(
  labelsByEntity: Map<string, Record<string, Labels>>,
  entity: EntityAddress,
  writePath: string,
  classification: CfcConfidentialityLabel | undefined,
): void {
  if (!classification || classification.length === 0) {
    return;
  }

  const entityKey = cfcEntityKey(entity);
  const labels = { ...(labelsByEntity.get(entityKey) ?? {}) };
  for (const path of canonicalAncestorPaths(writePath)) {
    const merged = mergeLabel(labels[path], { classification });
    if (merged) {
      labels[path] = merged;
    }
  }
  labelsByEntity.set(entityKey, labels);
}

function recordDynamicContainerClassification(
  labelsByEntity: Map<string, Record<string, Labels>>,
  entity: EntityAddress,
  writePath: string,
  classification: CfcConfidentialityLabel | undefined,
): void {
  if (!classification || classification.length === 0) {
    return;
  }

  const ancestorPaths = canonicalAncestorPaths(writePath);
  if (ancestorPaths.length <= 1) {
    return;
  }

  const entityKey = cfcEntityKey(entity);
  const labels = { ...(labelsByEntity.get(entityKey) ?? {}) };
  for (const path of ancestorPaths.slice(0, -1)) {
    const merged = mergeLabel(labels[path], {
      classification,
    });
    if (merged) {
      labels[path] = merged;
    }
  }
  labelsByEntity.set(entityKey, labels);
}

async function resolvePreparedWriteSchemas(
  tx: IExtendedStorageTransaction,
  writtenEntities: readonly EntityAddress[],
  options: PrepareBoundaryCommitOptions,
): Promise<PreparedWriteSchema[]> {
  const prepared: PreparedWriteSchema[] = [];
  const schemaHashCache = new Map<JSONSchema, string>();
  const labelsCache = new Map<JSONSchema, Record<string, Labels>>();

  for (const entity of writtenEntities) {
    const schema = getCfcWriteSchemaContext(tx, {
      ...entity,
      path: [],
    });
    if (!schema) {
      continue;
    }

    let actualSchemaHash = schemaHashCache.get(schema);
    if (!actualSchemaHash) {
      actualSchemaHash = await computeCfcSchemaHash(schema);
      schemaHashCache.set(schema, actualSchemaHash);
    }

    let labels = labelsCache.get(schema);
    if (!labels) {
      labels = computePreparedLabels(schema);
      labelsCache.set(schema, labels);
    }

    const existingSchemaHash = tx.readOrThrow(schemaHashAddress(entity), {
      cfc: internalVerifierReadAnnotations,
    });
    if (existingSchemaHash === undefined) {
      prepared.push({
        entity,
        schema,
        labels,
        actualSchemaHash,
        shouldWriteSchemaHash: true,
      });
      continue;
    }

    if (
      typeof existingSchemaHash !== "string" ||
      existingSchemaHash !== actualSchemaHash
    ) {
      const allowMigration = options.allowSchemaHashMigration?.(
        entity,
        String(existingSchemaHash),
        actualSchemaHash,
      ) ?? false;
      if (!allowMigration) {
        throw CfcSchemaHashMismatchError(
          entity,
          String(existingSchemaHash),
          actualSchemaHash,
        );
      }
      prepared.push({
        entity,
        schema,
        labels,
        actualSchemaHash,
        shouldWriteSchemaHash: true,
      });
      continue;
    }

    prepared.push({
      entity,
      schema,
      labels,
      actualSchemaHash,
      shouldWriteSchemaHash: false,
    });
  }

  return prepared;
}

function isSameOrDescendantCanonicalPath(
  basePath: string,
  candidatePath: string,
): boolean {
  if (basePath === "/") {
    return candidatePath.startsWith("/");
  }
  return candidatePath === basePath || candidatePath.startsWith(`${basePath}/`);
}

function effectiveLabelForPath(
  labelsByPath: Record<string, Labels>,
  path: string,
): Labels | undefined {
  let classification: CfcConfidentialityLabel | undefined;
  let integrity: CfcIntegrityLabel | undefined;
  for (const [labelPath, label] of Object.entries(labelsByPath)) {
    if (!canonicalLabelPathMatchesReadPath(labelPath, path)) {
      continue;
    }
    classification = joinConfidentialityLabels(
      classification,
      label.classification,
    );
    integrity = joinIntegrityLabels(integrity, label.integrity);
  }
  if (!classification && !integrity) {
    return undefined;
  }
  return {
    ...(classification ? { classification } : {}),
    ...(integrity ? { integrity } : {}),
  };
}

function classificationSatisfiesMaxConfidentiality(
  classification: CfcConfidentialityLabel | undefined,
  maxConfidentiality: readonly string[],
): boolean {
  if (maxConfidentiality.length === 0) {
    return true;
  }
  return maxConfidentiality.some((maxClassification) =>
    confidentialitySatisfiesMax(
      classification,
      confidentialityFromLegacyAtom(maxClassification),
    )
  );
}

function findRequiredIntegrityCoherenceViolation(
  labelsByPath: Record<string, Labels>,
  readPath: string,
  requiredIntegrity: CfcIntegrityLabel,
  options: PrepareBoundaryCommitOptions,
):
  | { path: string; actualIntegrity: CfcIntegrityLabel | undefined }
  | undefined {
  const sortedEntries = Object.entries(labelsByPath).sort(([a], [b]) =>
    a.localeCompare(b)
  );
  for (const [path, label] of sortedEntries) {
    if (!isSameOrDescendantCanonicalPath(readPath, path)) {
      continue;
    }
    const actualIntegrity = normalizeIntegrityLabel(label.integrity);
    if (
      !integritySatisfiesRequiredIntegrity(
        actualIntegrity,
        requiredIntegrity,
        options,
      )
    ) {
      return { path, actualIntegrity };
    }
  }
  return undefined;
}

function verifyInputRequirementsForAttempt(
  tx: IExtendedStorageTransaction,
  canonical: CanonicalBoundaryActivity,
  options: PrepareBoundaryCommitOptions = {},
): {
  readonly consumedReadLabels: readonly ConsumedReadWithEffectiveLabel[];
  readonly internalVerifierReads: readonly CanonicalBoundaryRead[];
} {
  const { consumedReads, internalVerifierReads } =
    partitionConsumedBoundaryReads(
      canonical,
    );
  const labelsByEntity = new Map<string, Record<string, Labels>>();

  for (const read of consumedReads) {
    const key = consumedReadEntityKey(read);
    if (labelsByEntity.has(key)) {
      continue;
    }
    const rawLabels = tx.readOrThrow(
      cfcLabelsAddress({
        space: read.space as IMemorySpaceAddress["space"],
        id: read.id as IMemorySpaceAddress["id"],
        type: read.type as IMemorySpaceAddress["type"],
      }),
      {
        cfc: internalVerifierReadAnnotations,
      },
    );
    labelsByEntity.set(key, normalizePersistedLabels(rawLabels));
  }

  const consumedReadLabels = collectConsumedInputLabels(
    consumedReads,
    labelsByEntity,
  );
  for (const consumed of consumedReadLabels) {
    const maxConfidentiality = readMaxConfidentialityFromMeta(
      consumed.read.cfc,
    );
    if (maxConfidentiality && maxConfidentiality.length > 0) {
      const actualClassification = normalizeConfidentialityLabel(
        consumed.effectiveLabel?.classification,
      );
      if (
        !classificationSatisfiesMaxConfidentiality(
          actualClassification,
          maxConfidentiality,
        )
      ) {
        throw CfcMaxConfidentialityViolationError(
          consumed.read,
          maxConfidentiality,
          actualClassification,
        );
      }
    }

    const requiredIntegrity = readRequiredIntegrityFromMeta(consumed.read.cfc);
    if (requiredIntegrity && requiredIntegrity.length > 0) {
      const labelsByPath =
        labelsByEntity.get(consumedReadEntityKey(consumed.read)) ??
          {};
      const coherenceViolation = findRequiredIntegrityCoherenceViolation(
        labelsByPath,
        consumed.read.path,
        requiredIntegrity,
        options,
      );
      if (coherenceViolation) {
        throw CfcRequiredIntegrityViolationError(
          consumed.read,
          requiredIntegrity,
          coherenceViolation.actualIntegrity,
          coherenceViolation.path,
        );
      }
      const actualIntegrity = normalizeIntegrityLabel(
        consumed.effectiveLabel?.integrity,
      );
      if (
        !integritySatisfiesRequiredIntegrity(
          actualIntegrity,
          requiredIntegrity,
          options,
        )
      ) {
        throw CfcRequiredIntegrityViolationError(
          consumed.read,
          requiredIntegrity,
          actualIntegrity,
        );
      }
    }
  }

  return { consumedReadLabels, internalVerifierReads };
}

function classificationDominates(
  actualClassification: CfcConfidentialityLabel | undefined,
  minClassification: CfcConfidentialityLabel | undefined,
): boolean {
  return confidentialityDominates(actualClassification, minClassification);
}

function strongestConsumedClassification(
  consumedReadLabels: readonly ConsumedReadWithEffectiveLabel[],
): CfcConfidentialityLabel | undefined {
  let consumed: CfcConfidentialityLabel | undefined;
  for (const read of consumedReadLabels) {
    consumed = joinConfidentialityLabels(
      consumed,
      read.effectiveLabel?.classification,
    );
  }
  return consumed;
}

function strongestContainerStructuralClassification(
  consumedReadLabels: readonly ConsumedReadWithEffectiveLabel[],
  sourceEntityKey: string | undefined,
  sourcePath: string | undefined,
): CfcConfidentialityLabel | undefined {
  if (!sourceEntityKey || !sourcePath) {
    return strongestConsumedClassification(consumedReadLabels);
  }

  return strongestConsumedClassification(
    consumedReadLabels.filter((consumed) =>
      consumedReadEntityKey(consumed.read) !== sourceEntityKey ||
      !isSameOrDescendantCanonicalPath(sourcePath, consumed.read.path)
    ),
  );
}

function fromCanonicalPath(path: string): string[] {
  if (path === "/" || path.length === 0) {
    return [];
  }
  if (!path.startsWith("/")) {
    throw new Error(
      `Malformed canonical path: expected "/" prefix, got "${path}"`,
    );
  }
  const rawParts = path.slice(1).split("/");
  return rawParts.filter(Boolean).map((part) =>
    part.replaceAll("~1", "/").replaceAll("~0", "~")
  );
}

function readExactCopyOf(schema: JSONSchema | undefined): string | undefined {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return undefined;
  }
  const rawIfc = (schema as { ifc?: unknown }).ifc;
  if (!rawIfc || typeof rawIfc !== "object" || Array.isArray(rawIfc)) {
    return undefined;
  }
  const rawExactCopyOf = (rawIfc as { exactCopyOf?: unknown }).exactCopyOf;
  if (typeof rawExactCopyOf !== "string" || !rawExactCopyOf.startsWith("/")) {
    return undefined;
  }
  return rawExactCopyOf;
}

type ProjectionSpec = {
  readonly from: string;
  readonly path: string;
};

type WriteAuthorizerSpec =
  | {
    readonly kind: "codeHash";
    readonly hash: string;
  }
  | {
    readonly kind: "builtin";
    readonly name: string;
  };

type CollectionConstraintSpec = {
  readonly subsetOf?: string;
  readonly permutationOf?: string;
  readonly filteredFrom?: string;
  readonly sourceCollection?: string;
  readonly lengthPreserved?: boolean;
};

type RecomposeProjectionPart = {
  readonly outputPath: string;
  readonly projectionPath: string;
};

type RecomposeProjectionsSpec = {
  readonly from: string;
  readonly baseIntegrityType: string;
  readonly parts: readonly RecomposeProjectionPart[];
};

type StatePreconditionSpec = {
  readonly requiredReadPath?: string;
  readonly predicatePath?: string;
  readonly equals?: unknown;
  readonly predicate?: string;
};

function readProjection(
  schema: JSONSchema | undefined,
): ProjectionSpec | undefined {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return undefined;
  }
  const rawIfc = (schema as { ifc?: unknown }).ifc;
  if (!rawIfc || typeof rawIfc !== "object" || Array.isArray(rawIfc)) {
    return undefined;
  }
  const rawProjection = (rawIfc as { projection?: unknown }).projection;
  if (
    !rawProjection || typeof rawProjection !== "object" ||
    Array.isArray(rawProjection)
  ) {
    return undefined;
  }
  const from = (rawProjection as { from?: unknown }).from;
  const path = (rawProjection as { path?: unknown }).path;
  if (
    typeof from !== "string" || !from.startsWith("/") ||
    typeof path !== "string" || !path.startsWith("/")
  ) {
    return undefined;
  }
  return { from, path };
}

function readWriteAuthorizedBy(
  schema: JSONSchema | undefined,
): readonly WriteAuthorizerSpec[] | undefined {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return undefined;
  }
  const rawIfc = (schema as { ifc?: unknown }).ifc;
  if (!rawIfc || typeof rawIfc !== "object" || Array.isArray(rawIfc)) {
    return undefined;
  }
  const rawWriteAuthorizedBy = (
    rawIfc as { writeAuthorizedBy?: unknown }
  ).writeAuthorizedBy;
  if (
    !Array.isArray(rawWriteAuthorizedBy) || rawWriteAuthorizedBy.length === 0
  ) {
    return undefined;
  }

  const authorizers: WriteAuthorizerSpec[] = [];
  for (const entry of rawWriteAuthorizedBy) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const type = (entry as { type?: unknown }).type;
    if (
      type === "https://commonfabric.org/cfc/atom/CodeHash" &&
      typeof (entry as { hash?: unknown }).hash === "string"
    ) {
      authorizers.push({
        kind: "codeHash",
        hash: (entry as { hash: string }).hash,
      });
      continue;
    }
    if (
      type === "https://commonfabric.org/cfc/atom/Builtin" &&
      typeof (entry as { name?: unknown }).name === "string"
    ) {
      authorizers.push({
        kind: "builtin",
        name: (entry as { name: string }).name,
      });
    }
  }

  return authorizers.length > 0 ? authorizers : undefined;
}

function isCanonicalPathString(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("/");
}

function readCollectionConstraints(
  schema: JSONSchema | undefined,
): CollectionConstraintSpec | undefined {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return undefined;
  }
  const rawIfc = (schema as { ifc?: unknown }).ifc;
  if (!rawIfc || typeof rawIfc !== "object" || Array.isArray(rawIfc)) {
    return undefined;
  }
  const rawCollection = (rawIfc as { collection?: unknown }).collection;
  if (
    !rawCollection || typeof rawCollection !== "object" ||
    Array.isArray(rawCollection)
  ) {
    return undefined;
  }

  const subsetOf = isCanonicalPathString(
      (rawCollection as { subsetOf?: unknown }).subsetOf,
    )
    ? (rawCollection as { subsetOf: string }).subsetOf
    : undefined;
  const permutationOf = isCanonicalPathString(
      (rawCollection as { permutationOf?: unknown }).permutationOf,
    )
    ? (rawCollection as { permutationOf: string }).permutationOf
    : undefined;
  const filteredFrom = isCanonicalPathString(
      (rawCollection as { filteredFrom?: unknown }).filteredFrom,
    )
    ? (rawCollection as { filteredFrom: string }).filteredFrom
    : undefined;
  const sourceCollection = isCanonicalPathString(
      (rawCollection as { sourceCollection?: unknown }).sourceCollection,
    )
    ? (rawCollection as { sourceCollection: string }).sourceCollection
    : undefined;
  const lengthPreserved = (rawCollection as { lengthPreserved?: unknown })
    .lengthPreserved === true;

  if (
    subsetOf === undefined &&
    permutationOf === undefined &&
    filteredFrom === undefined &&
    sourceCollection === undefined &&
    lengthPreserved === false
  ) {
    return undefined;
  }

  return {
    ...(subsetOf ? { subsetOf } : {}),
    ...(permutationOf ? { permutationOf } : {}),
    ...(filteredFrom ? { filteredFrom } : {}),
    ...(sourceCollection ? { sourceCollection } : {}),
    ...(lengthPreserved ? { lengthPreserved } : {}),
  };
}

function readRecomposeProjections(
  schema: JSONSchema | undefined,
): RecomposeProjectionsSpec | undefined {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return undefined;
  }
  const rawIfc = (schema as { ifc?: unknown }).ifc;
  if (!rawIfc || typeof rawIfc !== "object" || Array.isArray(rawIfc)) {
    return undefined;
  }
  const rawRecompose =
    (rawIfc as { recomposeProjections?: unknown }).recomposeProjections;
  if (
    !rawRecompose || typeof rawRecompose !== "object" ||
    Array.isArray(rawRecompose)
  ) {
    return undefined;
  }

  const from = (rawRecompose as { from?: unknown }).from;
  const baseIntegrityType = (rawRecompose as { baseIntegrityType?: unknown })
    .baseIntegrityType;
  const rawParts = (rawRecompose as { parts?: unknown }).parts;
  if (
    !isCanonicalPathString(from) ||
    typeof baseIntegrityType !== "string" || baseIntegrityType.length === 0 ||
    !Array.isArray(rawParts)
  ) {
    return undefined;
  }

  const parts: RecomposeProjectionPart[] = [];
  for (const rawPart of rawParts) {
    if (!rawPart || typeof rawPart !== "object" || Array.isArray(rawPart)) {
      return undefined;
    }
    const outputPath = (rawPart as { outputPath?: unknown }).outputPath;
    const projectionPath = (rawPart as { projectionPath?: unknown })
      .projectionPath;
    if (
      !isCanonicalPathString(outputPath) ||
      !isCanonicalPathString(projectionPath)
    ) {
      return undefined;
    }
    parts.push({ outputPath, projectionPath });
  }

  if (parts.length === 0) {
    return undefined;
  }

  return {
    from,
    baseIntegrityType,
    parts,
  };
}

function readStatePrecondition(
  schema: JSONSchema | undefined,
): StatePreconditionSpec | undefined {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return undefined;
  }
  const rawIfc = (schema as { ifc?: unknown }).ifc;
  if (!rawIfc || typeof rawIfc !== "object" || Array.isArray(rawIfc)) {
    return undefined;
  }
  const rawPrecondition =
    (rawIfc as { statePrecondition?: unknown }).statePrecondition;
  if (
    !rawPrecondition || typeof rawPrecondition !== "object" ||
    Array.isArray(rawPrecondition)
  ) {
    return undefined;
  }

  const requiredReadPath = isCanonicalPathString(
      (rawPrecondition as { requiredRead?: unknown }).requiredRead,
    )
    ? (rawPrecondition as { requiredRead: string }).requiredRead
    : undefined;
  const predicatePath = isCanonicalPathString(
      (rawPrecondition as { path?: unknown }).path,
    )
    ? (rawPrecondition as { path: string }).path
    : undefined;
  const predicate =
    typeof (rawPrecondition as { predicate?: unknown }).predicate ===
        "string"
      ? (rawPrecondition as { predicate: string }).predicate
      : undefined;
  const equals = (rawPrecondition as { equals?: unknown }).equals;

  if (
    requiredReadPath === undefined &&
    predicatePath === undefined &&
    predicate === undefined &&
    equals === undefined
  ) {
    return undefined;
  }

  return {
    ...(requiredReadPath ? { requiredReadPath } : {}),
    ...(predicatePath ? { predicatePath } : {}),
    ...(predicate ? { predicate } : {}),
    ...(equals !== undefined ? { equals } : {}),
  };
}

function readValueAtCanonicalPath(
  tx: IExtendedStorageTransaction,
  address: EntityAddress,
  path: string,
): unknown {
  return tx.readValueOrThrow(
    {
      ...address,
      path: fromCanonicalPath(path),
    },
    { cfc: internalVerifierReadAnnotations },
  );
}

type ConsumedSourceLookup = {
  readonly found: boolean;
  readonly value: unknown;
};

function sameEntityAddress(
  left: EntityAddress,
  right: EntityAddress,
): boolean {
  return left.space === right.space &&
    left.id === right.id &&
    left.type === right.type;
}

function resolveConsumedSourceValue(
  tx: IExtendedStorageTransaction,
  consumedReadLabels: readonly ConsumedReadWithEffectiveLabel[],
  sourcePath: string,
  preferredEntity?: EntityAddress,
): ConsumedSourceLookup {
  const seen = new Set<string>();
  let firstValue: unknown = undefined;
  let firstLabeledExternalValue: unknown = undefined;
  let firstExternalValue: unknown = undefined;
  let preferredValue: unknown = undefined;
  let preferredLabeledExternalValue: unknown = undefined;
  let preferredExternalValue: unknown = undefined;
  let hasFirstValue = false;
  let hasFirstLabeledExternalValue = false;
  let hasFirstExternalValue = false;
  let hasPreferredValue = false;
  let hasPreferredLabeledExternalValue = false;
  let hasPreferredExternalValue = false;
  for (const consumed of consumedReadLabels) {
    if (consumed.read.path !== sourcePath) {
      continue;
    }
    const key = [
      consumed.read.space,
      consumed.read.id,
      consumed.read.type,
      consumed.read.path,
    ].join("\u0000");
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const entity: EntityAddress = {
      space: consumed.read.space as EntityAddress["space"],
      id: consumed.read.id as EntityAddress["id"],
      type: consumed.read.type as EntityAddress["type"],
    };
    const value = readValueAtCanonicalPath(tx, entity, consumed.read.path);
    if (!hasFirstValue) {
      firstValue = value;
      hasFirstValue = true;
    }
    const isPotentialWriteRead =
      consumed.read.meta?.[markReadAsPotentialWriteMarker] === true;
    const isExternalConsumedRead = !isPotentialWriteRead;
    const hasEffectiveLabel = consumed.effectiveLabel !== undefined;
    if (isExternalConsumedRead && !hasFirstExternalValue) {
      firstExternalValue = value;
      hasFirstExternalValue = true;
    }
    if (
      isExternalConsumedRead &&
      hasEffectiveLabel &&
      !hasFirstLabeledExternalValue
    ) {
      firstLabeledExternalValue = value;
      hasFirstLabeledExternalValue = true;
    }
    if (preferredEntity && sameEntityAddress(entity, preferredEntity)) {
      if (!hasPreferredValue) {
        preferredValue = value;
        hasPreferredValue = true;
      }
      if (isExternalConsumedRead && !hasPreferredExternalValue) {
        preferredExternalValue = value;
        hasPreferredExternalValue = true;
      }
      if (
        isExternalConsumedRead &&
        hasEffectiveLabel &&
        !hasPreferredLabeledExternalValue
      ) {
        preferredLabeledExternalValue = value;
        hasPreferredLabeledExternalValue = true;
      }
    }
  }
  if (hasPreferredLabeledExternalValue) {
    return { found: true, value: preferredLabeledExternalValue };
  }
  if (hasFirstLabeledExternalValue) {
    return { found: true, value: firstLabeledExternalValue };
  }
  if (hasPreferredExternalValue) {
    return { found: true, value: preferredExternalValue };
  }
  if (hasFirstExternalValue) {
    return { found: true, value: firstExternalValue };
  }
  if (hasPreferredValue) {
    return { found: true, value: preferredValue };
  }
  if (!hasFirstValue) {
    return { found: false, value: undefined };
  }
  return { found: true, value: firstValue };
}

function observedReadValueForPath(
  tx: IExtendedStorageTransaction,
  entity: EntityAddress,
  path: string,
): ConsumedSourceLookup {
  let found = false;
  let value: unknown = undefined;
  for (const attestation of tx.journal.history(entity.space)) {
    if (
      attestation.address.id !== entity.id ||
      attestation.address.type !== entity.type
    ) {
      continue;
    }
    if (canonicalizeStoragePath(attestation.address.path) !== path) {
      continue;
    }
    found = true;
    value = attestation.value;
  }
  return { found, value };
}

function hasConsumedReadForPath(
  consumedReadLabels: readonly ConsumedReadWithEffectiveLabel[],
  entity: EntityAddress,
  path: string,
): boolean {
  return consumedReadLabels.some((consumed) =>
    consumed.read.space === entity.space &&
    consumed.read.id === entity.id &&
    consumed.read.type === entity.type &&
    consumed.read.path === path
  );
}

function evaluatePredicate(
  predicate: string | undefined,
  actualValue: unknown,
): boolean {
  if (!predicate || predicate === "equals") {
    return true;
  }
  if (predicate === "exists") {
    return actualValue !== undefined;
  }
  if (predicate === "notExists") {
    return actualValue === undefined;
  }
  if (predicate === "truthy") {
    return Boolean(actualValue);
  }
  if (predicate === "falsy") {
    return !actualValue;
  }
  // Unknown predicates are fail-closed.
  return false;
}

function valueAtCanonicalPath(value: unknown, path: string): unknown {
  const segments = fromCanonicalPath(path);
  let cursor = value;
  for (const segment of segments) {
    if (cursor === null || cursor === undefined) {
      return undefined;
    }
    if (typeof cursor !== "object") {
      return undefined;
    }
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

function arrayContainsByValue(
  values: readonly unknown[],
  value: unknown,
): number {
  for (let index = 0; index < values.length; index++) {
    if (deepEqual(values[index], value)) {
      return index;
    }
  }
  return -1;
}

function isSubsetMultiset(
  source: readonly unknown[],
  subset: readonly unknown[],
): boolean {
  const remaining = [...source];
  for (const member of subset) {
    const matchIndex = arrayContainsByValue(remaining, member);
    if (matchIndex < 0) {
      return false;
    }
    remaining.splice(matchIndex, 1);
  }
  return true;
}

function isPermutationMultiset(
  source: readonly unknown[],
  permutation: readonly unknown[],
): boolean {
  if (source.length !== permutation.length) {
    return false;
  }
  return isSubsetMultiset(source, permutation);
}

function readConsumedArraySource(
  tx: IExtendedStorageTransaction,
  consumedReadLabels: readonly ConsumedReadWithEffectiveLabel[],
  preferredEntity: EntityAddress,
  sourcePath: string,
): readonly unknown[] | undefined {
  const source = resolveConsumedSourceValue(
    tx,
    consumedReadLabels,
    sourcePath,
    preferredEntity,
  );
  if (!source.found || !Array.isArray(source.value)) {
    return undefined;
  }
  return source.value;
}

function lengthPreservedSourcePath(
  collection: CollectionConstraintSpec,
): string | undefined {
  return collection.sourceCollection ??
    collection.subsetOf ??
    collection.filteredFrom ??
    collection.permutationOf;
}

function appendCanonicalSegment(path: string, segment: string): string {
  const escaped = escapeJsonPointerToken(segment);
  return path === "/" ? `/${escaped}` : `${path}/${escaped}`;
}

function collectLeafPaths(
  value: unknown,
  path: string,
  leafPaths: Set<string>,
): void {
  if (value === null || typeof value !== "object") {
    leafPaths.add(path);
    return;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      leafPaths.add(path);
      return;
    }
    for (let index = 0; index < value.length; index++) {
      collectLeafPaths(
        value[index],
        appendCanonicalSegment(path, String(index)),
        leafPaths,
      );
    }
    return;
  }

  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) {
    leafPaths.add(path);
    return;
  }
  for (const [key, child] of entries) {
    collectLeafPaths(child, appendCanonicalSegment(path, key), leafPaths);
  }
}

function verifyRecomposeCoverage(
  outputValue: unknown,
  outputObjectPath: string,
  parts: readonly RecomposeProjectionPart[],
): boolean {
  if (
    outputValue === null || typeof outputValue !== "object" ||
    Array.isArray(outputValue)
  ) {
    return false;
  }
  const declared = new Set(parts.map((part) => part.outputPath));
  const actual = new Set<string>();
  collectLeafPaths(outputValue, outputObjectPath, actual);
  for (const leafPath of actual) {
    if (!declared.has(leafPath)) {
      return false;
    }
  }
  return true;
}

type PolicyPreConfScope = "targetClause" | "anywhere";

type PolicyRewriteRule = {
  readonly confidentialityPre: readonly CfcAtom[];
  readonly integrityPre: CfcIntegrityLabel;
  readonly preConfScope: PolicyPreConfScope;
  readonly policyState: readonly unknown[];
  readonly addAlternatives: readonly CfcAtom[];
  readonly addIntegrity: CfcIntegrityLabel;
  readonly removeMatchedClauses: boolean;
  readonly releaseCondition: unknown;
};

type PolicyRewriteConfig = {
  readonly fuel: number;
  readonly rules: readonly PolicyRewriteRule[];
};

type PolicyLabelState = {
  readonly confidentiality: CfcConfidentialityLabel;
  readonly integrity: CfcIntegrityLabel;
};

type PolicyFixpointResult =
  | { readonly nonConverged: true; readonly fuel: number }
  | {
    readonly nonConverged: false;
    readonly changed: boolean;
    readonly synthesizedClassification: CfcConfidentialityLabel | undefined;
    readonly label: PolicyLabelState;
    readonly fuel: number;
  };

type PolicyDowngradeDecision = {
  readonly allowed: boolean;
  readonly changed: boolean;
  readonly synthesizedClassification: CfcConfidentialityLabel | undefined;
  readonly nonConverged: boolean;
  readonly fuel: number;
  readonly label?: PolicyLabelState;
};

type PolicyConfidentialityMatch = {
  readonly bindings: CfcPatternBindings;
  readonly targetIndex: number;
};

const DEFAULT_POLICY_FUEL = 8;

function buildPolicyContextBindings(
  options: PrepareBoundaryCommitOptions = {},
): CfcPatternBindings {
  const bindings: Record<string, CfcPatternBindingValue> = {};
  if (options.actingPrincipal) {
    bindings.$actingUser = options.actingPrincipal;
  }
  return bindings;
}

function normalizePolicyAtomListOrdered(value: unknown): readonly CfcAtom[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const atoms: CfcAtom[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const normalized = normalizeIntegrityLabel([entry]);
    const atom = normalized?.[0];
    if (atom === undefined) {
      continue;
    }
    const key = JSON.stringify(atom);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    atoms.push(atom);
  }
  return atoms;
}

function normalizePolicyIntegrityAtoms(value: unknown): CfcIntegrityLabel {
  return normalizeIntegrityLabel(value) ?? [];
}

function readPolicyPreConfScope(
  value: unknown,
  fallback: PolicyPreConfScope,
): PolicyPreConfScope {
  return value === "anywhere" || value === "targetClause" ? value : fallback;
}

function parsePolicyRule(
  rawRule: unknown,
  defaultScope: PolicyPreConfScope,
): PolicyRewriteRule | undefined {
  if (!rawRule || typeof rawRule !== "object" || Array.isArray(rawRule)) {
    return undefined;
  }

  const preCondition = (rawRule as { preCondition?: unknown }).preCondition;
  const preConditionObject = (preCondition &&
      typeof preCondition === "object" &&
      !Array.isArray(preCondition))
    ? preCondition as {
      confidentiality?: unknown;
      integrity?: unknown;
    }
    : undefined;
  const postCondition = (rawRule as { postCondition?: unknown }).postCondition;
  const postConditionObject = (postCondition &&
      typeof postCondition === "object" &&
      !Array.isArray(postCondition))
    ? postCondition as {
      confidentiality?: unknown;
      integrity?: unknown;
    }
    : undefined;

  const confidentialityPre = normalizePolicyAtomListOrdered(
    (rawRule as { confidentialityPre?: unknown }).confidentialityPre ??
      preConditionObject?.confidentiality,
  );
  const integrityPre = normalizePolicyIntegrityAtoms(
    (rawRule as { integrityPre?: unknown }).integrityPre ??
      preConditionObject?.integrity,
  );
  const addAlternatives = normalizePolicyAtomListOrdered(
    (rawRule as { addAlternatives?: unknown }).addAlternatives ??
      postConditionObject?.confidentiality,
  );
  const addIntegrity = normalizePolicyIntegrityAtoms(
    (rawRule as { addIntegrity?: unknown }).addIntegrity ??
      postConditionObject?.integrity,
  );
  const removeMatchedClauses =
    (rawRule as { removeMatchedClauses?: unknown }).removeMatchedClauses ===
      true;
  const preConfScope = readPolicyPreConfScope(
    (rawRule as { preConfScope?: unknown }).preConfScope,
    defaultScope,
  );
  const policyState = Array.isArray(
      (rawRule as { policyState?: unknown }).policyState,
    )
    ? (rawRule as { policyState: readonly unknown[] }).policyState
    : Array.isArray(
        (rawRule as { guard?: { policyState?: unknown } }).guard?.policyState,
      )
    ? (
      rawRule as {
        guard: { policyState: readonly unknown[] };
      }
    ).guard.policyState
    : [];
  const releaseCondition =
    (rawRule as { releaseCondition?: unknown }).releaseCondition ??
      (rawRule as { guard?: { releaseCondition?: unknown } }).guard
        ?.releaseCondition;

  if (confidentialityPre.length === 0) {
    return undefined;
  }
  if (!removeMatchedClauses && addAlternatives.length === 0) {
    return undefined;
  }

  return {
    confidentialityPre,
    integrityPre,
    preConfScope,
    policyState,
    addAlternatives,
    addIntegrity,
    removeMatchedClauses,
    releaseCondition,
  };
}

function normalizePolicyFuel(rawFuel: unknown): number | undefined {
  if (
    typeof rawFuel === "number" && Number.isFinite(rawFuel) &&
    Number.isInteger(rawFuel) && rawFuel >= 0
  ) {
    return rawFuel;
  }
  return undefined;
}

function collectPolicyRulesFromRaw(
  rawConfig: unknown,
  defaultScope: PolicyPreConfScope,
  rules: PolicyRewriteRule[],
  fuel: { value: number | undefined },
): void {
  if (rawConfig === undefined) {
    return;
  }
  if (Array.isArray(rawConfig)) {
    for (const rawRule of rawConfig) {
      const parsed = parsePolicyRule(rawRule, defaultScope);
      if (parsed) {
        rules.push(parsed);
      }
    }
    return;
  }
  if (!rawConfig || typeof rawConfig !== "object") {
    return;
  }

  const rawFuel = normalizePolicyFuel((rawConfig as { fuel?: unknown }).fuel);
  if (rawFuel !== undefined) {
    fuel.value = fuel.value === undefined
      ? rawFuel
      : Math.min(fuel.value, rawFuel);
  }

  const nestedRules = (rawConfig as { rules?: unknown }).rules;
  if (Array.isArray(nestedRules)) {
    for (const rawRule of nestedRules) {
      const parsed = parsePolicyRule(rawRule, defaultScope);
      if (parsed) {
        rules.push(parsed);
      }
    }
    return;
  }

  const parsed = parsePolicyRule(rawConfig, defaultScope);
  if (parsed) {
    rules.push(parsed);
  }
}

function readPolicyRewriteConfig(
  schema: JSONSchema | undefined,
): PolicyRewriteConfig | undefined {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return undefined;
  }
  const rawIfc = (schema as { ifc?: unknown }).ifc;
  if (!rawIfc || typeof rawIfc !== "object" || Array.isArray(rawIfc)) {
    return undefined;
  }
  const defaultScope = readPolicyPreConfScope(
    (rawIfc as { preConfScope?: unknown }).preConfScope,
    "targetClause",
  );
  const rules: PolicyRewriteRule[] = [];
  const fuel = { value: undefined as number | undefined };

  collectPolicyRulesFromRaw(
    (rawIfc as { declassify?: unknown }).declassify,
    defaultScope,
    rules,
    fuel,
  );
  collectPolicyRulesFromRaw(
    (rawIfc as { exchange?: unknown }).exchange,
    defaultScope,
    rules,
    fuel,
  );

  if (rules.length === 0) {
    return undefined;
  }

  return {
    fuel: fuel.value ?? DEFAULT_POLICY_FUEL,
    rules,
  };
}

function buildPolicyLabelFromConsumedReads(
  consumedReadLabels: readonly ConsumedReadWithEffectiveLabel[],
): PolicyLabelState {
  let confidentiality: CfcConfidentialityLabel | undefined;
  let integrity: CfcIntegrityLabel | undefined;

  for (const consumed of consumedReadLabels) {
    confidentiality = joinConfidentialityLabels(
      confidentiality,
      consumed.effectiveLabel?.classification,
    );
    integrity = joinIntegrityLabels(
      integrity,
      consumed.effectiveLabel?.integrity,
    );
  }

  return {
    confidentiality: confidentiality ?? [],
    integrity: integrity ?? [],
  };
}

function findMatchingPolicyConditionBindings(
  candidates: readonly CfcAtom[],
  pattern: CfcAtom,
  bindings: CfcPatternBindings,
): CfcPatternBindings | undefined {
  for (const candidate of candidates) {
    const matched = matchPatternWithBindings(candidate, pattern, bindings);
    if (matched) {
      return matched;
    }
  }
  return undefined;
}

function policyRuleConfidentialityMatch(
  label: PolicyLabelState,
  clauseIndex: number,
  rule: PolicyRewriteRule,
  initialBindings: CfcPatternBindings = {},
): PolicyConfidentialityMatch | undefined {
  const clause = label.confidentiality[clauseIndex];
  const targetAtom = rule.confidentialityPre[0];
  if (!clause) {
    return undefined;
  }

  for (let targetIndex = 0; targetIndex < clause.length; targetIndex++) {
    const targetMatch = matchPatternWithBindings(
      clause[targetIndex],
      targetAtom,
      initialBindings,
    );
    if (!targetMatch) {
      continue;
    }

    let bindings = targetMatch;
    let matched = true;
    for (const sideCondition of rule.confidentialityPre.slice(1)) {
      const candidates = rule.preConfScope === "anywhere"
        ? label.confidentiality.flat()
        : clause;
      const nextBindings = findMatchingPolicyConditionBindings(
        candidates,
        sideCondition,
        bindings,
      );
      if (!nextBindings) {
        matched = false;
        break;
      }
      bindings = nextBindings;
    }

    if (matched) {
      return {
        bindings,
        targetIndex,
      };
    }
  }
  return undefined;
}

function policyRuleIntegrityMatches(
  label: PolicyLabelState,
  rule: PolicyRewriteRule,
  bindings: CfcPatternBindings,
  options: PrepareBoundaryCommitOptions = {},
): boolean {
  const resolvedIntegrity = resolvePatternWithBindings(
    rule.integrityPre,
    bindings,
  );
  if (!resolvedIntegrity) {
    return rule.integrityPre.length === 0;
  }
  if (resolvedIntegrity.length === 0) {
    return true;
  }
  return integritySatisfiesRequiredIntegrity(
    label.integrity,
    resolvedIntegrity,
    {
      actingPrincipal: options.actingPrincipal,
      trustContext: options.trustContext,
    },
  );
}

function evaluatePolicyReleaseCondition(
  condition: unknown,
  tx: IExtendedStorageTransaction,
  entity: EntityAddress,
  writePath: string,
): boolean {
  if (condition === undefined) {
    return true;
  }
  if (typeof condition === "boolean") {
    return condition;
  }
  if (!condition || typeof condition !== "object" || Array.isArray(condition)) {
    return false;
  }

  const allOf = (condition as { allOf?: unknown }).allOf;
  if (Array.isArray(allOf)) {
    return allOf.every((entry) =>
      evaluatePolicyReleaseCondition(entry, tx, entity, writePath)
    );
  }

  const anyOf = (condition as { anyOf?: unknown }).anyOf;
  if (Array.isArray(anyOf)) {
    return anyOf.some((entry) =>
      evaluatePolicyReleaseCondition(entry, tx, entity, writePath)
    );
  }

  const path = isCanonicalPathString((condition as { path?: unknown }).path)
    ? (condition as { path: string }).path
    : writePath;
  const actualValue = readValueAtCanonicalPath(tx, entity, path);
  if ("equals" in condition) {
    return deepEqual(actualValue, (condition as { equals?: unknown }).equals);
  }
  const predicate = typeof (condition as { predicate?: unknown }).predicate ===
      "string"
    ? (condition as { predicate: string }).predicate
    : undefined;
  if (predicate) {
    return evaluatePredicate(predicate, actualValue);
  }
  if (typeof (condition as { value?: unknown }).value === "boolean") {
    return (condition as { value: boolean }).value;
  }
  return false;
}

function addPolicyIntegrity(
  integrity: CfcIntegrityLabel,
  additions: CfcIntegrityLabel,
): CfcIntegrityLabel {
  if (additions.length === 0) {
    return integrity;
  }
  return joinIntegrityLabels(integrity, additions) ?? integrity;
}

function policyRuleStateMatches(
  tx: IExtendedStorageTransaction,
  entity: EntityAddress,
  rule: PolicyRewriteRule,
  bindings: CfcPatternBindings,
): boolean {
  for (const policyStatePattern of rule.policyState) {
    const resolved = resolvePatternWithBindings(policyStatePattern, bindings);
    if (!resolved) {
      return false;
    }

    const record = tx.readOrThrow(
      cfcPolicyStateAddress(entity.space, resolved),
      { cfc: internalVerifierReadAnnotations },
    );
    if (record === undefined || !deepEqual(record, resolved)) {
      return false;
    }
  }
  return true;
}

function applyPolicyRuleOnce(
  label: PolicyLabelState,
  rule: PolicyRewriteRule,
  tx: IExtendedStorageTransaction,
  entity: EntityAddress,
  writePath: string,
  options: PrepareBoundaryCommitOptions = {},
): {
  readonly changed: boolean;
  readonly label: PolicyLabelState;
  readonly synthesizedClassification?: CfcConfidentialityLabel;
} {
  const contextBindings = buildPolicyContextBindings(options);
  if (
    !evaluatePolicyReleaseCondition(
      rule.releaseCondition,
      tx,
      entity,
      writePath,
    )
  ) {
    return { changed: false, label };
  }

  for (
    let clauseIndex = 0;
    clauseIndex < label.confidentiality.length;
    clauseIndex++
  ) {
    const match = policyRuleConfidentialityMatch(
      label,
      clauseIndex,
      rule,
      contextBindings,
    );
    if (!match) {
      continue;
    }
    if (!policyRuleIntegrityMatches(label, rule, match.bindings, options)) {
      continue;
    }
    if (!policyRuleStateMatches(tx, entity, rule, match.bindings)) {
      continue;
    }
    const clause = [...label.confidentiality[clauseIndex]];
    if (match.targetIndex < 0 || match.targetIndex >= clause.length) {
      continue;
    }

    const resolvedAlternatives = resolvePatternWithBindings(
      rule.addAlternatives,
      match.bindings,
    );
    if (rule.addAlternatives.length > 0 && !resolvedAlternatives) {
      continue;
    }
    const resolvedIntegrity = resolvePatternWithBindings(
      rule.addIntegrity,
      match.bindings,
    );
    if (rule.addIntegrity.length > 0 && !resolvedIntegrity) {
      continue;
    }

    let clauseChanged = false;
    if (rule.removeMatchedClauses) {
      clause.splice(match.targetIndex, 1);
      clauseChanged = true;
    }

    for (const alternative of resolvedAlternatives ?? []) {
      if (!clause.some((atom) => deepEqual(atom, alternative))) {
        clause.push(alternative);
        clauseChanged = true;
      }
    }
    const nextIntegrity = addPolicyIntegrity(
      label.integrity,
      resolvedIntegrity ?? [],
    );
    const integrityChanged = !deepEqual(nextIntegrity, label.integrity);
    if (!clauseChanged && !integrityChanged) {
      continue;
    }

    const nextConfidentiality = label.confidentiality.map((
      entry,
    ) => [...entry]);
    if (clause.length === 0) {
      nextConfidentiality.splice(clauseIndex, 1);
    } else {
      nextConfidentiality[clauseIndex] = clause;
    }
    const normalizedConfidentiality =
      normalizeConfidentialityLabel(nextConfidentiality) ?? [];
    return {
      changed: true,
      synthesizedClassification: (resolvedAlternatives?.length ?? 0) > 0
        ? (normalizeConfidentialityLabel([clause]) ?? [])
        : undefined,
      label: {
        confidentiality: normalizedConfidentiality,
        integrity: nextIntegrity,
      },
    };
  }

  return { changed: false, label };
}

function evaluatePolicyOnce(
  label: PolicyLabelState,
  config: PolicyRewriteConfig,
  tx: IExtendedStorageTransaction,
  entity: EntityAddress,
  writePath: string,
  remainingFuel: number,
  options: PrepareBoundaryCommitOptions = {},
): {
  readonly changed: boolean;
  readonly label: PolicyLabelState;
  readonly synthesizedClassification: CfcConfidentialityLabel | undefined;
  readonly remainingFuel: number;
} {
  let current = label;
  let changed = false;
  let synthesizedClassification: CfcConfidentialityLabel | undefined;
  let fuel = remainingFuel;
  for (const rule of config.rules) {
    while (true) {
      if (fuel <= 0 && changed) {
        return {
          changed: true,
          label: current,
          synthesizedClassification,
          remainingFuel: 0,
        };
      }
      const applied = applyPolicyRuleOnce(
        current,
        rule,
        tx,
        entity,
        writePath,
        options,
      );
      if (!applied.changed) {
        break;
      }
      changed = true;
      current = applied.label;
      synthesizedClassification = joinConfidentialityLabels(
        synthesizedClassification,
        applied.synthesizedClassification,
      );
      fuel--;
    }
  }
  return {
    changed,
    label: current,
    synthesizedClassification,
    remainingFuel: fuel,
  };
}

function evaluatePolicyFixpoint(
  label: PolicyLabelState,
  config: PolicyRewriteConfig,
  tx: IExtendedStorageTransaction,
  entity: EntityAddress,
  writePath: string,
  options: PrepareBoundaryCommitOptions = {},
): PolicyFixpointResult {
  let current = label;
  let remainingFuel = config.fuel;
  let changed = false;
  let synthesizedClassification: CfcConfidentialityLabel | undefined;

  while (true) {
    const next = evaluatePolicyOnce(
      current,
      config,
      tx,
      entity,
      writePath,
      remainingFuel,
      options,
    );
    if (!next.changed) {
      return {
        nonConverged: false,
        changed,
        synthesizedClassification,
        label: current,
        fuel: config.fuel,
      };
    }
    changed = true;
    synthesizedClassification = joinConfidentialityLabels(
      synthesizedClassification,
      next.synthesizedClassification,
    );
    remainingFuel = next.remainingFuel;
    if (remainingFuel <= 0) {
      return { nonConverged: true, fuel: config.fuel };
    }
    current = next.label;
  }
}

function policyAllowsClassification(
  label: PolicyLabelState,
  classification: CfcConfidentialityLabel | undefined,
): boolean {
  return confidentialityDominates(classification, label.confidentiality);
}

function evaluatePolicyDowngradeDecision(
  tx: IExtendedStorageTransaction,
  entity: EntityAddress,
  writePath: string,
  schemaAtWritePath: JSONSchema | undefined,
  consumedReadLabels: readonly ConsumedReadWithEffectiveLabel[],
  outputClassification: CfcConfidentialityLabel | undefined,
  options: PrepareBoundaryCommitOptions = {},
): PolicyDowngradeDecision {
  const policyConfig = readPolicyRewriteConfig(schemaAtWritePath);
  if (!policyConfig) {
    return {
      allowed: false,
      changed: false,
      synthesizedClassification: undefined,
      nonConverged: false,
      fuel: 0,
    };
  }
  const initialLabel = buildPolicyLabelFromConsumedReads(consumedReadLabels);
  const policyResult = evaluatePolicyFixpoint(
    initialLabel,
    policyConfig,
    tx,
    entity,
    writePath,
    options,
  );
  if (policyResult.nonConverged) {
    return {
      allowed: false,
      changed: false,
      synthesizedClassification: undefined,
      nonConverged: true,
      fuel: policyResult.fuel,
    };
  }
  const effectiveOutputClassification = policyResult.synthesizedClassification
    ? joinConfidentialityLabels(
      outputClassification,
      policyResult.synthesizedClassification,
    )
    : outputClassification;
  return {
    allowed: policyAllowsClassification(
      policyResult.label,
      effectiveOutputClassification,
    ),
    changed: policyResult.changed,
    synthesizedClassification: policyResult.synthesizedClassification,
    nonConverged: false,
    fuel: policyResult.fuel,
    label: policyResult.label,
  };
}

function implementationIdentityMatchesWriteAuthorizer(
  implementationIdentity: CfcImplementationIdentity | undefined,
  authorizer: WriteAuthorizerSpec,
): boolean {
  if (!implementationIdentity || implementationIdentity.kind === "unknown") {
    return false;
  }
  if (authorizer.kind === "codeHash") {
    return implementationIdentity.kind === "codeHash" &&
      implementationIdentity.hash === authorizer.hash;
  }
  return implementationIdentity.kind === "builtin" &&
    implementationIdentity.name === authorizer.name;
}

function implementationIdentityAuthorizedForWrite(
  implementationIdentity: CfcImplementationIdentity | undefined,
  authorizers: readonly WriteAuthorizerSpec[] | undefined,
): boolean {
  if (!authorizers || authorizers.length === 0) {
    return true;
  }
  return authorizers.some((authorizer) =>
    implementationIdentityMatchesWriteAuthorizer(
      implementationIdentity,
      authorizer,
    )
  );
}

function verifyOutputTransitionsForAttempt(
  tx: IExtendedStorageTransaction,
  consumedReadLabels: readonly ConsumedReadWithEffectiveLabel[],
  internalVerifierReads: readonly CanonicalBoundaryRead[],
  canonical: CanonicalBoundaryActivity,
  options: PrepareBoundaryCommitOptions = {},
  rootSchemaByEntity?: ReadonlyMap<string, JSONSchema>,
): ReadonlyMap<string, Record<string, Labels>> {
  if (canonical.attemptedWrites.length === 0) {
    return new Map();
  }
  const cfc = new ContextualFlowControl();
  const dynamicLabelsByEntity = new Map<string, Record<string, Labels>>();
  const preparedLabelsByEntity = new Map<string, Record<string, Labels>>();

  for (const write of canonical.finalAttemptedWrites) {
    const entity: EntityAddress = {
      space: write.space as EntityAddress["space"],
      id: write.id as EntityAddress["id"],
      type: write.type as EntityAddress["type"],
    };
    const rootSchema = rootSchemaByEntity?.get(cfcEntityKey(entity)) ??
      getCfcWriteSchemaContext(tx, { ...entity, path: [] });
    if (!rootSchema) {
      // Entity has no schema context — check if it has persisted CFC labels.
      // If it does, something recorded labels but schema context was lost,
      // so fail closed. If not, the entity is genuinely unclassified and has
      // no output transitions to verify.
      const persistedLabels = tx.readOrThrow(cfcLabelsAddress(entity), {
        cfc: internalVerifierReadAnnotations,
      });
      if (persistedLabels !== undefined) {
        throw CfcPrepareSchemaUnavailableError(entity);
      }
      continue;
    }
    const schemaAtWritePath = cfc.getSchemaAtPath(
      rootSchema,
      fromCanonicalPath(write.path),
    );
    const writeAuthorizedBy = readWriteAuthorizedBy(schemaAtWritePath);
    if (
      !implementationIdentityAuthorizedForWrite(
        options.implementationIdentity,
        writeAuthorizedBy,
      )
    ) {
      throw CfcWriteAuthorizedByViolationError(entity, write.path);
    }
    const flowPrecisionSelection = selectFlowPrecisionConsumedReads(
      rootSchema,
      write.path,
      consumedReadLabels,
      internalVerifierReads,
      options.implementationIdentity,
      options.actingPrincipal,
      options.trustContext,
      options.trustEvaluator,
    );
    const effectiveConsumedReadLabels =
      flowPrecisionSelection.consumedReadLabels;
    const minClassification = strongestConsumedClassification(
      effectiveConsumedReadLabels,
    );
    let policyIntegrity = collectDynamicWriteIntegrity(
      effectiveConsumedReadLabels,
    );
    let preparedLabels = preparedLabelsByEntity.get(cfcEntityKey(entity));
    if (!preparedLabels) {
      preparedLabels = computePreparedLabels(rootSchema);
      preparedLabelsByEntity.set(cfcEntityKey(entity), preparedLabels);
    }
    const actualClassification = normalizeConfidentialityLabel(
      effectiveLabelForPath(
        preparedLabels,
        write.path,
      )?.classification,
    );
    if (
      !classificationDominates(
        actualClassification,
        minClassification,
      )
    ) {
      const decision = evaluatePolicyDowngradeDecision(
        tx,
        entity,
        write.path,
        schemaAtWritePath,
        effectiveConsumedReadLabels,
        actualClassification,
        options,
      );
      if (decision.nonConverged) {
        throw CfcPolicyNonConvergenceError(entity, write.path, decision.fuel);
      }
      if (!decision.allowed) {
        throw CfcOutputTransitionViolationError(
          entity,
          write.path,
          minClassification,
          actualClassification,
        );
      }
      if (
        decision.changed &&
        (!actualClassification || actualClassification.length === 0)
      ) {
        recordDynamicWriteClassification(
          dynamicLabelsByEntity,
          entity,
          write.path,
          decision.synthesizedClassification,
        );
      }
      policyIntegrity = joinIntegrityLabels(
        policyIntegrity,
        decision.label?.integrity,
      );
    }

    recordDynamicWriteIntegrity(
      dynamicLabelsByEntity,
      entity,
      write.path,
      policyIntegrity,
    );
    if (flowPrecisionSelection.mode === "elementLocalExpansion") {
      const conservativeClassification =
        strongestContainerStructuralClassification(
          consumedReadLabels,
          flowPrecisionSelection.sourceEntityKey,
          flowPrecisionSelection.sourcePath,
        );
      if (
        !classificationDominates(
          minClassification,
          conservativeClassification,
        )
      ) {
        recordDynamicContainerClassification(
          dynamicLabelsByEntity,
          entity,
          write.path,
          conservativeClassification,
        );
      }
    }

    const statePrecondition = readStatePrecondition(schemaAtWritePath);
    if (statePrecondition) {
      const requiredReadPath = statePrecondition.requiredReadPath ??
        statePrecondition.predicatePath;
      if (
        requiredReadPath &&
        !hasConsumedReadForPath(consumedReadLabels, entity, requiredReadPath)
      ) {
        throw CfcStatePreconditionReadViolationError(
          entity,
          write.path,
          requiredReadPath,
        );
      }

      const predicatePath = statePrecondition.predicatePath ??
        requiredReadPath ?? write.path;
      const observedRead = observedReadValueForPath(tx, entity, predicatePath);
      const actualValue = observedRead.found
        ? observedRead.value
        : readValueAtCanonicalPath(tx, entity, predicatePath);
      if (
        statePrecondition.equals !== undefined &&
        !deepEqual(actualValue, statePrecondition.equals)
      ) {
        throw CfcStatePreconditionPredicateViolationError(
          entity,
          write.path,
          predicatePath,
          statePrecondition.equals,
          actualValue,
        );
      }

      if (!evaluatePredicate(statePrecondition.predicate, actualValue)) {
        throw CfcStatePreconditionPredicateViolationError(
          entity,
          write.path,
          predicatePath,
          statePrecondition.predicate ?? "equals",
          actualValue,
        );
      }
    }

    const exactCopyOf = readExactCopyOf(schemaAtWritePath);
    if (exactCopyOf) {
      const source = resolveConsumedSourceValue(
        tx,
        consumedReadLabels,
        exactCopyOf,
        entity,
      );
      const outputValue = readValueAtCanonicalPath(tx, entity, write.path);
      if (!source.found || !deepEqual(source.value, outputValue)) {
        throw CfcOutputExactCopyViolationError(entity, write.path, exactCopyOf);
      }
    }

    const projection = readProjection(schemaAtWritePath);
    if (projection) {
      const source = resolveConsumedSourceValue(
        tx,
        consumedReadLabels,
        projection.from,
        entity,
      );
      const outputValue = readValueAtCanonicalPath(tx, entity, write.path);
      const expectedValue = valueAtCanonicalPath(source.value, projection.path);
      if (!source.found || !deepEqual(expectedValue, outputValue)) {
        throw CfcOutputProjectionViolationError(
          entity,
          write.path,
          projection.from,
          projection.path,
        );
      }
    }

    const collection = readCollectionConstraints(schemaAtWritePath);
    if (collection) {
      const outputValue = readValueAtCanonicalPath(tx, entity, write.path);
      const outputArray = Array.isArray(outputValue) ? outputValue : undefined;

      if (collection.subsetOf) {
        const sourceArray = readConsumedArraySource(
          tx,
          consumedReadLabels,
          entity,
          collection.subsetOf,
        );
        if (
          !sourceArray || !outputArray ||
          !isSubsetMultiset(sourceArray, outputArray)
        ) {
          throw CfcOutputCollectionViolationError(
            entity,
            write.path,
            "subsetOf",
            collection.subsetOf,
          );
        }
      }

      if (collection.permutationOf) {
        const sourceArray = readConsumedArraySource(
          tx,
          consumedReadLabels,
          entity,
          collection.permutationOf,
        );
        if (
          !sourceArray || !outputArray ||
          !isPermutationMultiset(sourceArray, outputArray)
        ) {
          throw CfcOutputCollectionViolationError(
            entity,
            write.path,
            "permutationOf",
            collection.permutationOf,
          );
        }
      }

      if (collection.filteredFrom) {
        const sourceArray = readConsumedArraySource(
          tx,
          consumedReadLabels,
          entity,
          collection.filteredFrom,
        );
        if (
          !sourceArray || !outputArray ||
          !isSubsetMultiset(sourceArray, outputArray)
        ) {
          throw CfcOutputCollectionViolationError(
            entity,
            write.path,
            "filteredFrom",
            collection.filteredFrom,
          );
        }
      }

      if (collection.lengthPreserved) {
        const sourcePath = lengthPreservedSourcePath(collection);
        const sourceArray = sourcePath
          ? readConsumedArraySource(tx, consumedReadLabels, entity, sourcePath)
          : undefined;
        if (
          !sourceArray || !outputArray ||
          sourceArray.length !== outputArray.length
        ) {
          throw CfcOutputCollectionViolationError(
            entity,
            write.path,
            "lengthPreserved",
            sourcePath,
          );
        }
      }
    }

    const recompose = readRecomposeProjections(schemaAtWritePath);
    if (recompose) {
      // The declaration is consumed for verification-side structure checks.
      // TODO(#cfc): enforce recompose.baseIntegrityType for integrity-level
      // verification of recomposed projections.

      const outputObjectValue = readValueAtCanonicalPath(
        tx,
        entity,
        write.path,
      );
      if (
        !verifyRecomposeCoverage(outputObjectValue, write.path, recompose.parts)
      ) {
        throw CfcOutputRecomposeProjectionsViolationError(
          entity,
          write.path,
          recompose.from,
        );
      }

      const source = resolveConsumedSourceValue(
        tx,
        consumedReadLabels,
        recompose.from,
        entity,
      );
      if (!source.found) {
        throw CfcOutputRecomposeProjectionsViolationError(
          entity,
          write.path,
          recompose.from,
        );
      }

      for (const part of recompose.parts) {
        const expected = valueAtCanonicalPath(
          source.value,
          part.projectionPath,
        );
        const actual = readValueAtCanonicalPath(tx, entity, part.outputPath);
        if (!deepEqual(expected, actual)) {
          throw CfcOutputRecomposeProjectionsViolationError(
            entity,
            write.path,
            recompose.from,
          );
        }
      }
    }
  }

  return dynamicLabelsByEntity;
}

export async function prepareBoundaryCommit(
  tx: IExtendedStorageTransaction,
  options: PrepareBoundaryCommitOptions = {},
): Promise<void> {
  const prepareScope = tx.resolveCfcPrepareScopeSnapshot();
  const effectiveOptions: PrepareBoundaryCommitOptions = {
    ...options,
    implementationIdentity: options.implementationIdentity ??
      prepareScope.implementationIdentity,
    actingPrincipal: options.actingPrincipal ?? prepareScope.actingPrincipal,
    trustContext: options.trustContext ?? prepareScope.trustContext,
  };
  const canonical = canonicalizeBoundaryActivity(tx.journal.activity());
  const writtenEntities = collectWrittenEntities(canonical);
  const hasIfcWriteReason = tx.cfcReasons.includes("ifc-write-schema");
  const preparedWriteSchemas = hasIfcWriteReason
    ? await resolvePreparedWriteSchemas(tx, writtenEntities, effectiveOptions)
    : [];

  if (
    hasIfcWriteReason && writtenEntities.length > 0 &&
    preparedWriteSchemas.length === 0
  ) {
    throw CfcPrepareSchemaUnavailableError(writtenEntities[0]);
  }

  const preparedRootSchemasByEntity = new Map<string, JSONSchema>();
  for (const prepared of preparedWriteSchemas) {
    preparedRootSchemasByEntity.set(
      cfcEntityKey(prepared.entity),
      prepared.schema,
    );
  }

  const { consumedReadLabels, internalVerifierReads } =
    verifyInputRequirementsForAttempt(
      tx,
      canonical,
      effectiveOptions,
    );
  const dynamicOutputLabels = verifyOutputTransitionsForAttempt(
    tx,
    consumedReadLabels,
    internalVerifierReads,
    canonical,
    effectiveOptions,
    preparedRootSchemasByEntity,
  );

  if (hasIfcWriteReason) {
    const writtenSchemaBlobKeys = new Set<string>();
    for (const prepared of preparedWriteSchemas) {
      const blobAddress = schemaBlobAddress(
        prepared.entity,
        prepared.actualSchemaHash,
      );
      const blobWriteKey = `${blobAddress.space}\u0000${blobAddress.id}`;
      if (!writtenSchemaBlobKeys.has(blobWriteKey)) {
        const existingBlobSchema = tx.readOrThrow(
          { ...blobAddress, path: ["value"] },
          { cfc: internalVerifierReadAnnotations },
        );
        if (existingBlobSchema === undefined) {
          tx.writeOrThrow(
            { ...blobAddress, path: ["value"] },
            prepared.schema,
          );
        }
        writtenSchemaBlobKeys.add(blobWriteKey);
      }

      if (prepared.shouldWriteSchemaHash) {
        tx.writeOrThrow(
          schemaHashAddress(prepared.entity),
          prepared.actualSchemaHash,
        );
      }
      tx.writeOrThrow(
        cfcLabelsAddress(prepared.entity),
        mergePreparedLabels(
          prepared.labels,
          dynamicOutputLabels.get(cfcEntityKey(prepared.entity)),
        ),
      );
    }
  }

  const digest = computeCfcActivityDigest(tx.journal.activity(), {
    implementationIdentity: effectiveOptions.implementationIdentity,
    actingPrincipal: effectiveOptions.actingPrincipal,
    trustContext: effectiveOptions.trustContext,
  });
  tx.markCfcPrepared(digest);
}
