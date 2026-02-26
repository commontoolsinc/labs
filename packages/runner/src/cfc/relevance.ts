import { isObject } from "@commontools/utils/types";
import type { JSONSchema } from "../builder/types.ts";
import type {
  IExtendedStorageTransaction,
  IMemorySpaceAddress,
  Labels,
} from "../storage/interface.ts";
import { canonicalizeStoragePath } from "./canonical-activity.ts";
import { internalVerifierReadAnnotations } from "./internal-markers.ts";

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

function normalizePersistedLabels(value: unknown): Record<string, Labels> {
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

function jsonPointerPrefixes(path: string): string[] {
  if (path === "/") {
    return ["/"];
  }

  const segments = path.slice(1).split("/");
  const prefixes = ["/"];
  let current = "";
  for (const segment of segments) {
    if (!segment) {
      continue;
    }
    current += `/${segment}`;
    prefixes.push(current);
  }
  return prefixes;
}

function hasEffectiveLabelConstraint(
  labelsByPath: Record<string, Labels>,
  canonicalPath: string,
): boolean {
  for (const prefix of jsonPointerPrefixes(canonicalPath)) {
    const label = labelsByPath[prefix];
    if (!label) {
      continue;
    }
    if ((label.classification?.length ?? 0) > 0) {
      return true;
    }
    if ((label.integrity?.length ?? 0) > 0) {
      return true;
    }
  }
  return false;
}

function labelsAddress(
  readAddress: Pick<IMemorySpaceAddress, "space" | "id" | "type">,
): IMemorySpaceAddress {
  return {
    space: readAddress.space,
    id: readAddress.id,
    type: readAddress.type,
    path: ["cfc", "labels"],
  };
}

export function markCfcRelevantForEffectiveLabels(
  tx: IExtendedStorageTransaction | undefined,
  readAddress: IMemorySpaceAddress,
  reason = "ifc-read-effective-label",
): void {
  if (!tx) {
    return;
  }

  const labelsValue = tx.readOrThrow(labelsAddress(readAddress), {
    cfc: internalVerifierReadAnnotations,
  });
  const labelsByPath = normalizePersistedLabels(labelsValue);
  if (Object.keys(labelsByPath).length === 0) {
    return;
  }

  const canonicalPath = canonicalizeStoragePath(readAddress.path);
  if (hasEffectiveLabelConstraint(labelsByPath, canonicalPath)) {
    tx.markCfcRelevant(reason);
  }
}
