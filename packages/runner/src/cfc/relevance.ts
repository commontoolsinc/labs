import { isObject } from "@commontools/utils/types";
import type { JSONSchema } from "../builder/types.ts";
import type {
  IExtendedStorageTransaction,
  IMemorySpaceAddress,
} from "../storage/interface.ts";
import { ignoreReadForSchedulingMarker } from "../storage/read-metadata.ts";
import { canonicalizeStoragePath } from "./canonical-activity.ts";
import { internalVerifierReadAnnotations } from "./internal-markers.ts";
import {
  cfcLabelsAddress,
  normalizePersistedPathLabels,
  resolveObservationLabel,
} from "./shared.ts";

const ignoreReadForSchedulingMeta = {
  [ignoreReadForSchedulingMarker]: true,
} as const;

function hasIfcInObjectSchema(
  schema: Record<string, unknown>,
  visited: Set<object>,
): boolean {
  if (visited.has(schema)) {
    return false;
  }
  visited.add(schema);

  if (schema.ifc !== undefined) {
    return true;
  }

  const properties = schema.properties;
  if (isObject(properties)) {
    for (const value of Object.values(properties)) {
      if (
        isObject(value) &&
        hasIfcInObjectSchema(value as Record<string, unknown>, visited)
      ) {
        return true;
      }
    }
  }

  const additionalProperties = schema.additionalProperties;
  if (
    isObject(additionalProperties) &&
    hasIfcInObjectSchema(
      additionalProperties as Record<string, unknown>,
      visited,
    )
  ) {
    return true;
  }

  const items = schema.items;
  if (
    isObject(items) &&
    hasIfcInObjectSchema(items as Record<string, unknown>, visited)
  ) {
    return true;
  }

  const prefixItems = schema.prefixItems;
  if (Array.isArray(prefixItems)) {
    for (const item of prefixItems) {
      if (
        isObject(item) &&
        hasIfcInObjectSchema(item as Record<string, unknown>, visited)
      ) {
        return true;
      }
    }
  }

  const composition = [
    schema.anyOf,
    schema.oneOf,
    schema.allOf,
  ];
  for (const options of composition) {
    if (!Array.isArray(options)) {
      continue;
    }
    for (const option of options) {
      if (
        isObject(option) &&
        hasIfcInObjectSchema(option as Record<string, unknown>, visited)
      ) {
        return true;
      }
    }
  }

  const defs = schema.$defs;
  if (isObject(defs)) {
    for (const value of Object.values(defs)) {
      if (
        isObject(value) &&
        hasIfcInObjectSchema(value as Record<string, unknown>, visited)
      ) {
        return true;
      }
    }
  }

  const legacyDefs = schema.definitions;
  if (isObject(legacyDefs)) {
    for (const value of Object.values(legacyDefs)) {
      if (
        isObject(value) &&
        hasIfcInObjectSchema(value as Record<string, unknown>, visited)
      ) {
        return true;
      }
    }
  }

  return false;
}

export function schemaHasIfcAnnotations(
  schema: JSONSchema | undefined,
): boolean {
  if (!isObject(schema)) {
    return false;
  }
  return hasIfcInObjectSchema(schema as Record<string, unknown>, new Set());
}

export function markCfcRelevantForSchema(
  tx: IExtendedStorageTransaction | undefined,
  schema: JSONSchema | undefined,
  reason: string,
): void {
  if (!tx) {
    return;
  }
  if (schemaHasIfcAnnotations(schema)) {
    tx.markCfcRelevant(reason);
  }
}

function hasEffectiveLabelConstraint(
  labelsByPath: ReturnType<typeof normalizePersistedPathLabels>,
  canonicalPath: string,
  op: "shape" | "value" | "enumerate" | "count" | "followRef" = "value",
): boolean {
  const label = resolveObservationLabel(labelsByPath, canonicalPath, op);
  return Boolean(
    (label?.classification?.length ?? 0) > 0 ||
      (label?.integrity?.length ?? 0) > 0,
  );
}

export function markCfcRelevantForEffectiveLabels(
  tx: IExtendedStorageTransaction | undefined,
  readAddress: IMemorySpaceAddress,
  reason = "ifc-read-effective-label",
  op: "shape" | "value" | "enumerate" | "count" | "followRef" = "value",
): void {
  if (!tx) {
    return;
  }

  const labelsValue = tx.readOrThrow(cfcLabelsAddress(readAddress), {
    meta: ignoreReadForSchedulingMeta,
    cfc: internalVerifierReadAnnotations,
  });
  const labelsByPath = normalizePersistedPathLabels(labelsValue);
  if (Object.keys(labelsByPath).length === 0) {
    return;
  }

  const canonicalPath = canonicalizeStoragePath(readAddress.path);
  if (hasEffectiveLabelConstraint(labelsByPath, canonicalPath, op)) {
    tx.markCfcRelevant(reason);
  }
}
