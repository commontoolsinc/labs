import type { JSONSchema } from "../builder/types.ts";
import { ContextualFlowControl } from "../cfc.ts";
import type {
  ICfcInputRequirementViolationError,
  ICfcPrepareSchemaUnavailableError,
  ICfcSchemaHashMismatchError,
  IExtendedStorageTransaction,
  IMemorySpaceAddress,
  Labels,
} from "../storage/interface.ts";
import { computeCfcActivityDigest } from "./activity-digest.ts";
import {
  type CanonicalBoundaryRead,
  canonicalizeBoundaryActivity,
} from "./canonical-activity.ts";
import { partitionConsumedBoundaryReads } from "./consumed-reads.ts";
import {
  collectConsumedInputLabels,
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
): ICfcInputRequirementViolationError {
  return {
    name: "CfcInputRequirementViolationError",
    message:
      "CFC prepare input requirement failed: consumed input misses requiredIntegrity",
    requirement: "requiredIntegrity",
    space: read.space as IMemorySpaceAddress["space"],
    id: read.id as IMemorySpaceAddress["id"],
    type: read.type,
    path: read.path,
    requiredIntegrity: [...requiredIntegrity],
    actualIntegrity: [...actualIntegrity],
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

function verifyInputRequirementsForAttempt(
  tx: IExtendedStorageTransaction,
): void {
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
}

export async function prepareBoundaryCommit(
  tx: IExtendedStorageTransaction,
): Promise<void> {
  verifyInputRequirementsForAttempt(tx);

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
