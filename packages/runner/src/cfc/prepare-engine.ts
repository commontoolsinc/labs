import type { JSONSchema } from "../builder/types.ts";
import { deepEqual } from "@commontools/utils/deep-equal";
import { ContextualFlowControl } from "../cfc.ts";
import type {
  ICfcInputRequirementViolationError,
  ICfcOutputTransitionViolationError,
  ICfcPrepareSchemaUnavailableError,
  ICfcSchemaHashMismatchError,
  IExtendedStorageTransaction,
  IMemorySpaceAddress,
  Labels,
} from "../storage/interface.ts";
import { computeCfcActivityDigest } from "./activity-digest.ts";
import {
  type CanonicalBoundaryRead,
  canonicalizeStoragePath,
  canonicalizeBoundaryActivity,
} from "./canonical-activity.ts";
import { partitionConsumedBoundaryReads } from "./consumed-reads.ts";
import {
  collectConsumedInputLabels,
  type ConsumedReadWithEffectiveLabel,
  consumedReadEntityKey,
} from "./consumed-input-labels.ts";
import {
  internalVerifierReadMeta,
  readMaxConfidentialityFromMeta,
  readRequiredIntegrityFromMeta,
} from "./internal-markers.ts";
import { getCfcWriteSchemaContext } from "./schema-context.ts";
import { computeCfcSchemaHash } from "./schema-hash.ts";

type EntityAddress = Pick<IMemorySpaceAddress, "space" | "id" | "type">;

function entityKey(entity: EntityAddress): string {
  return `${entity.space}\u0000${entity.id}\u0000${entity.type}`;
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
  actualClassification: string,
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
  requiredIntegrity: readonly string[],
  actualIntegrity: readonly string[],
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
    actualIntegrity: [...actualIntegrity],
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
  minClassification: string,
  actualClassification: string,
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

function collectWrittenEntities(
  tx: IExtendedStorageTransaction,
): EntityAddress[] {
  const canonical = canonicalizeBoundaryActivity(tx.journal.activity());
  const entities = new Map<string, EntityAddress>();
  for (const write of canonical.attemptedWrites) {
    const entity: EntityAddress = {
      space: write.space as IMemorySpaceAddress["space"],
      id: write.id as IMemorySpaceAddress["id"],
      type: write.type as IMemorySpaceAddress["type"],
    };
    entities.set(entityKey(entity), entity);
  }
  return [...entities.values()];
}

async function resolvePreparedSchemaHash(
  schema: JSONSchema,
): Promise<string> {
  return await computeCfcSchemaHash(schema);
}

function schemaHashAddress(entity: EntityAddress): IMemorySpaceAddress {
  return {
    space: entity.space,
    id: entity.id,
    type: entity.type,
    path: ["cfc", "schemaHash"],
  };
}

function readLabelsAddress(entity: EntityAddress): IMemorySpaceAddress {
  return {
    space: entity.space,
    id: entity.id,
    type: entity.type,
    path: ["cfc", "labels"],
  };
}

function labelsAddress(entity: EntityAddress): IMemorySpaceAddress {
  return {
    space: entity.space,
    id: entity.id,
    type: entity.type,
    path: ["cfc", "labels"],
  };
}

function normalizeLabelsByPath(value: unknown): Record<string, Labels> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const labelsByPath: Record<string, Labels> = {};
  for (const [path, rawLabel] of Object.entries(value)) {
    if (!path.startsWith("/")) {
      continue;
    }
    if (!rawLabel || typeof rawLabel !== "object" || Array.isArray(rawLabel)) {
      continue;
    }
    const rawClassification = (rawLabel as { classification?: unknown })
      .classification;
    const classification = Array.isArray(rawClassification)
      ? rawClassification.filter((entry): entry is string =>
        typeof entry === "string" && entry.length > 0
      )
      : [];
    const rawIntegrity = (rawLabel as { integrity?: unknown }).integrity;
    const integrity = Array.isArray(rawIntegrity)
      ? rawIntegrity.filter((entry): entry is string =>
        typeof entry === "string" && entry.length > 0
      )
      : [];
    if (classification.length === 0 && integrity.length === 0) {
      continue;
    }
    labelsByPath[path] = {
      ...(classification.length > 0 ? { classification } : {}),
      ...(integrity.length > 0 ? { integrity } : {}),
    };
  }
  return labelsByPath;
}

function computePreparedLabels(schema: JSONSchema): Record<string, Labels> {
  const cfc = new ContextualFlowControl();
  const rootClassification = cfc.lubSchema(schema);
  if (!rootClassification) {
    return {};
  }
  return {
    "/": {
      classification: [rootClassification],
    },
  };
}

function classificationSatisfiesMaxConfidentiality(
  classification: string,
  maxConfidentiality: readonly string[],
  cfc: ContextualFlowControl,
): boolean {
  for (const maxClassification of maxConfidentiality) {
    try {
      const joined = cfc.lub(new Set([classification, maxClassification]));
      if (joined === maxClassification) {
        return true;
      }
    } catch {
      // Unknown classifications are treated as non-matching for this bound.
    }
  }
  return false;
}

function integritySatisfiesRequiredIntegrity(
  actualIntegrity: readonly string[] | undefined,
  requiredIntegrity: readonly string[],
): boolean {
  if (requiredIntegrity.length === 0) {
    return true;
  }
  if (!actualIntegrity || actualIntegrity.length === 0) {
    return false;
  }
  const actualSet = new Set(actualIntegrity);
  return requiredIntegrity.every((atom) => actualSet.has(atom));
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

function findRequiredIntegrityCoherenceViolation(
  labelsByPath: Record<string, Labels>,
  readPath: string,
  requiredIntegrity: readonly string[],
): { path: string; actualIntegrity: readonly string[] } | undefined {
  const sortedEntries = Object.entries(labelsByPath).sort(([a], [b]) =>
    a.localeCompare(b)
  );
  for (const [path, label] of sortedEntries) {
    if (!isSameOrDescendantCanonicalPath(readPath, path)) {
      continue;
    }
    const actualIntegrity = label.integrity ?? [];
    if (!integritySatisfiesRequiredIntegrity(actualIntegrity, requiredIntegrity)) {
      return { path, actualIntegrity };
    }
  }
  return undefined;
}

function verifyInputRequirementsForAttempt(
  tx: IExtendedStorageTransaction,
): readonly ConsumedReadWithEffectiveLabel[] {
  const { consumedReads } = partitionConsumedBoundaryReads(tx.journal.activity());
  const labelsByEntity = new Map<string, Record<string, Labels>>();

  for (const read of consumedReads) {
    const key = consumedReadEntityKey(read);
    if (labelsByEntity.has(key)) {
      continue;
    }
    const rawLabels = tx.readOrThrow(readLabelsAddress({
      space: read.space as IMemorySpaceAddress["space"],
      id: read.id as IMemorySpaceAddress["id"],
      type: read.type as IMemorySpaceAddress["type"],
    }), {
      meta: internalVerifierReadMeta,
    });
    labelsByEntity.set(key, normalizeLabelsByPath(rawLabels));
  }

  const consumedReadLabels = collectConsumedInputLabels(consumedReads, labelsByEntity);
  const cfc = new ContextualFlowControl();
  for (const consumed of consumedReadLabels) {
    const maxConfidentiality = readMaxConfidentialityFromMeta(consumed.read.meta);
    if (maxConfidentiality && maxConfidentiality.length > 0) {
      const actualClassification =
        consumed.effectiveLabel?.classification?.[0] ?? "unclassified";
      if (
        !classificationSatisfiesMaxConfidentiality(
          actualClassification,
          maxConfidentiality,
          cfc,
        )
      ) {
        throw CfcMaxConfidentialityViolationError(
          consumed.read,
          maxConfidentiality,
          actualClassification,
        );
      }
    }

    const requiredIntegrity = readRequiredIntegrityFromMeta(consumed.read.meta);
    if (requiredIntegrity && requiredIntegrity.length > 0) {
      const labelsByPath = labelsByEntity.get(consumedReadEntityKey(consumed.read)) ??
        {};
      const coherenceViolation = findRequiredIntegrityCoherenceViolation(
        labelsByPath,
        consumed.read.path,
        requiredIntegrity,
      );
      if (coherenceViolation) {
        throw CfcRequiredIntegrityViolationError(
          consumed.read,
          requiredIntegrity,
          coherenceViolation.actualIntegrity,
          coherenceViolation.path,
        );
      }
      const actualIntegrity = consumed.effectiveLabel?.integrity ?? [];
      if (
        !integritySatisfiesRequiredIntegrity(
          actualIntegrity,
          requiredIntegrity,
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

  return consumedReadLabels;
}

function classificationDominates(
  actualClassification: string,
  minClassification: string,
  cfc: ContextualFlowControl,
): boolean {
  try {
    return cfc.lub(new Set([actualClassification, minClassification])) ===
      actualClassification;
  } catch {
    return false;
  }
}

function strongestConsumedClassification(
  consumedReadLabels: readonly ConsumedReadWithEffectiveLabel[],
  cfc: ContextualFlowControl,
): string {
  const consumed = new Set<string>();
  for (const read of consumedReadLabels) {
    consumed.add(read.effectiveLabel?.classification?.[0] ?? "unclassified");
  }
  if (consumed.size === 0) {
    return "unclassified";
  }
  return cfc.lub(consumed);
}

function fromCanonicalPath(path: string): string[] {
  if (path === "/" || path.length === 0) {
    return [];
  }
  const rawParts = path.startsWith("/") ? path.slice(1).split("/") : [];
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

function readProjection(schema: JSONSchema | undefined): ProjectionSpec | undefined {
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
  const predicate = typeof (rawPrecondition as { predicate?: unknown }).predicate ===
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
    { meta: internalVerifierReadMeta },
  );
}

type ConsumedSourceLookup = {
  readonly found: boolean;
  readonly value: unknown;
};

function resolveConsumedSourceValue(
  tx: IExtendedStorageTransaction,
  consumedReadLabels: readonly ConsumedReadWithEffectiveLabel[],
  sourcePath: string,
): ConsumedSourceLookup {
  const seen = new Set<string>();
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
    return {
      found: true,
      value: readValueAtCanonicalPath(tx, {
        space: consumed.read.space as EntityAddress["space"],
        id: consumed.read.id as EntityAddress["id"],
        type: consumed.read.type as EntityAddress["type"],
      }, consumed.read.path),
    };
  }
  return { found: false, value: undefined };
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
  sourcePath: string,
): readonly unknown[] | undefined {
  const source = resolveConsumedSourceValue(tx, consumedReadLabels, sourcePath);
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

function escapeCanonicalSegment(segment: string): string {
  return segment.replaceAll("~", "~0").replaceAll("/", "~1");
}

function appendCanonicalSegment(path: string, segment: string): string {
  const escaped = escapeCanonicalSegment(segment);
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

function verifyOutputTransitionsForAttempt(
  tx: IExtendedStorageTransaction,
  consumedReadLabels: readonly ConsumedReadWithEffectiveLabel[],
): void {
  const canonical = canonicalizeBoundaryActivity(tx.journal.activity());
  if (canonical.attemptedWrites.length === 0) {
    return;
  }

  const writtenEntities = collectWrittenEntities(tx);
  const cfc = new ContextualFlowControl();
  const minClassification = strongestConsumedClassification(consumedReadLabels, cfc);
  for (const entity of writtenEntities) {
    const schema = getCfcWriteSchemaContext(tx, {
      ...entity,
      path: [],
    });
    if (!schema) {
      continue;
    }

    const actualClassification = cfc.lubSchema(schema) ?? "unclassified";
    if (
      !classificationDominates(
        actualClassification,
        minClassification,
        cfc,
      )
    ) {
      throw CfcOutputTransitionViolationError(
        entity,
        "/",
        minClassification,
        actualClassification,
      );
    }
  }

  for (const write of canonical.finalAttemptedWrites) {
    const entity: EntityAddress = {
      space: write.space as EntityAddress["space"],
      id: write.id as EntityAddress["id"],
      type: write.type as EntityAddress["type"],
    };
    const rootSchema = getCfcWriteSchemaContext(tx, { ...entity, path: [] });
    if (!rootSchema) {
      continue;
    }
    const schemaAtWritePath = cfc.getSchemaAtPath(
      rootSchema,
      fromCanonicalPath(write.path),
    );
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
          collection.subsetOf,
        );
        if (!sourceArray || !outputArray || !isSubsetMultiset(sourceArray, outputArray)) {
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
          collection.filteredFrom,
        );
        if (!sourceArray || !outputArray || !isSubsetMultiset(sourceArray, outputArray)) {
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
          ? readConsumedArraySource(tx, consumedReadLabels, sourcePath)
          : undefined;
        if (!sourceArray || !outputArray || sourceArray.length !== outputArray.length) {
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
      void recompose.baseIntegrityType;

      const outputObjectValue = readValueAtCanonicalPath(tx, entity, write.path);
      if (!verifyRecomposeCoverage(outputObjectValue, write.path, recompose.parts)) {
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
      );
      if (!source.found) {
        throw CfcOutputRecomposeProjectionsViolationError(
          entity,
          write.path,
          recompose.from,
        );
      }

      for (const part of recompose.parts) {
        const expected = valueAtCanonicalPath(source.value, part.projectionPath);
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
}

export async function prepareBoundaryCommit(
  tx: IExtendedStorageTransaction,
): Promise<void> {
  const consumedReadLabels = verifyInputRequirementsForAttempt(tx);
  verifyOutputTransitionsForAttempt(tx, consumedReadLabels);

  const writtenEntities = collectWrittenEntities(tx);
  const hasIfcWriteReason = tx.cfcReasons.includes("ifc-write-schema");
  let enforcedSchemaHashCount = 0;

  if (hasIfcWriteReason) {
    for (const entity of writtenEntities) {
      const schema = getCfcWriteSchemaContext(tx, {
        ...entity,
        path: [],
      });
      if (!schema) {
        continue;
      }
      enforcedSchemaHashCount++;

      const actualSchemaHash = await resolvePreparedSchemaHash(schema);
      const address = schemaHashAddress(entity);
      const labels = computePreparedLabels(schema);
      const existingSchemaHash = tx.readOrThrow(address, {
        meta: internalVerifierReadMeta,
      });

      if (existingSchemaHash === undefined) {
        tx.writeOrThrow(address, actualSchemaHash);
        tx.writeOrThrow(labelsAddress(entity), labels);
        continue;
      }

      if (
        typeof existingSchemaHash !== "string" ||
        existingSchemaHash !== actualSchemaHash
      ) {
        throw CfcSchemaHashMismatchError(
          entity,
          String(existingSchemaHash),
          actualSchemaHash,
        );
      }

      tx.writeOrThrow(labelsAddress(entity), labels);
    }

    if (writtenEntities.length > 0 && enforcedSchemaHashCount === 0) {
      throw CfcPrepareSchemaUnavailableError(writtenEntities[0]);
    }
  }

  const digest = await computeCfcActivityDigest(tx.journal.activity());
  tx.markCfcPrepared(digest);
}
