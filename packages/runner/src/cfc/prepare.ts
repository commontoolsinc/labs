import { internSchema } from "@commonfabric/data-model/schema-hash";
import { toDeepFrozenSchema } from "@commonfabric/data-model/schema-utils";
import type {
  FabricValue,
  MemorySpace,
  URI,
} from "@commonfabric/memory/interface";
import { isRecord } from "@commonfabric/utils/types";
import type { JSONSchema } from "../builder/types.ts";
import { ignoreReadForScheduling } from "../scheduler.ts";
import type {
  IExtendedStorageTransaction,
  MediaType,
} from "../storage/interface.ts";
import {
  internalVerifierRead,
  isInternalVerifierRead,
} from "../storage/reactivity-log.ts";
import { canonicalizeLogicalPath } from "./canonical.ts";
import { mergeCfcSchemaEnvelopes } from "./schema-merge.ts";
import type { CfcMetadata, IFCLabel, WritePolicyInput } from "./types.ts";

const INTERNAL_VERIFIER_META = {
  ...ignoreReadForScheduling,
  ...internalVerifierRead,
};

const isPrefix = (
  prefix: readonly string[],
  path: readonly string[],
): boolean =>
  prefix.length <= path.length &&
  prefix.every((segment, index) => segment === path[index]);

const labelAtPath = (
  metadata: CfcMetadata | undefined,
  path: readonly string[],
): IFCLabel | undefined => {
  if (!metadata) {
    return undefined;
  }
  let match:
    | {
      path: string[];
      label: IFCLabel;
    }
    | undefined;
  for (const entry of metadata.labelMap.entries) {
    if (!isPrefix(entry.path, path)) {
      continue;
    }
    if (match === undefined || match.path.length < entry.path.length) {
      match = entry;
    }
  }
  return match?.label;
};

const storedMetadataFor = (
  tx: IExtendedStorageTransaction,
  space: MemorySpace,
  id: URI,
  type: MediaType,
): CfcMetadata | undefined => {
  const document = tx.readOrThrow({
    space,
    id,
    type,
    path: [],
  }, {
    meta: INTERNAL_VERIFIER_META,
  });
  return isRecord(document) && isRecord(document.cfc)
    ? document.cfc as CfcMetadata
    : undefined;
};

const candidateSchemasByTarget = (
  inputs: readonly WritePolicyInput[],
): Map<string, JSONSchema> => {
  const result = new Map<string, JSONSchema>();
  for (const input of inputs) {
    if (input.kind !== "schema" || input.schema === undefined) {
      continue;
    }
    const key =
      `${input.target.space}\u0000${input.target.id}\u0000${input.target.type}`;
    result.set(key, input.schema);
  }
  return result;
};

const valueWriteTargets = (
  tx: IExtendedStorageTransaction,
): Map<string, { space: MemorySpace; id: URI; type: MediaType }> => {
  const result = new Map<
    string,
    { space: MemorySpace; id: URI; type: MediaType }
  >();
  const log = tx.getReactivityLog?.();
  const seenWriteSpaces = new Set<MemorySpace>(
    (log?.writes ?? []).map((write) => write.space),
  );
  for (const space of seenWriteSpaces) {
    for (const write of tx.getWriteDetails?.(space) ?? []) {
      if (
        write.address.id.startsWith("cid:") ||
        write.address.path[0] === "cfc" ||
        write.address.path[0] === "source"
      ) {
        continue;
      }
      const key =
        `${write.address.space}\u0000${write.address.id}\u0000${write.address.type}`;
      result.set(key, {
        space: write.address.space,
        id: write.address.id as URI,
        type: write.address.type as MediaType,
      });
    }
  }
  return result;
};

const walkIfcSchema = (
  schema: JSONSchema,
  path: string[] = [],
  entries: Array<{ path: string[]; label: IFCLabel; schema: JSONSchema }> = [],
): typeof entries => {
  if (typeof schema === "boolean") {
    return entries;
  }
  if (schema.ifc !== undefined) {
    entries.push({
      path,
      label: {
        classification: schema.ifc.classification
          ? [...schema.ifc.classification]
          : undefined,
        integrity: schema.ifc.integrity ? [...schema.ifc.integrity] : undefined,
        confidentiality: schema.ifc.maxConfidentiality
          ? [...schema.ifc.maxConfidentiality]
          : undefined,
      },
      schema,
    });
  }

  if (schema.properties) {
    for (const [key, child] of Object.entries(schema.properties)) {
      walkIfcSchema(child, [...path, key], entries);
    }
  }
  if (typeof schema.items === "object" && schema.items !== null) {
    walkIfcSchema(schema.items, [...path, "*"], entries);
  }
  return entries;
};

const unsupportedTrustSensitiveReason = (
  schema: JSONSchema,
  path: readonly string[],
): string | undefined => {
  if (!isRecord(schema) || !isRecord(schema.ifc)) {
    return undefined;
  }
  const unsupportedKeys = [
    "writeAuthorizedBy",
    "exactCopyOf",
    "projection",
    "collection",
  ] as const;
  for (const key of unsupportedKeys) {
    const value = schema.ifc[key];
    if (Array.isArray(value) && value.length > 0) {
      return `unsupported trust-sensitive claim ${key} at /${path.join("/")}`;
    }
  }
  return undefined;
};

const verifyInputRequirements = (
  tx: IExtendedStorageTransaction,
  schema: JSONSchema,
): string | undefined => {
  const consumed = [...(tx.getReadActivities?.() ?? [])].filter((read) =>
    !isInternalVerifierRead(read.meta)
  ).map((read) => ({
    ...read,
    path: canonicalizeLogicalPath(read.path),
    label: labelAtPath(
      storedMetadataFor(tx, read.space, read.id, read.type),
      canonicalizeLogicalPath(read.path),
    ),
  })).filter((read) => read.label !== undefined);

  for (const entry of walkIfcSchema(schema)) {
    const ifc = isRecord(entry.schema) ? entry.schema.ifc : undefined;
    const unsupportedTrustSensitive = unsupportedTrustSensitiveReason(
      entry.schema,
      entry.path,
    );
    if (unsupportedTrustSensitive !== undefined) {
      return unsupportedTrustSensitive;
    }
    const requiredIntegrity = ifc?.requiredIntegrity ?? [];
    if (requiredIntegrity.length > 0 && consumed.length > 0) {
      const ok = consumed.every((read) =>
        requiredIntegrity.every((required: string) =>
          (read.label?.integrity ?? []).includes(required)
        )
      );
      if (!ok) {
        return `requiredIntegrity failed at /${entry.path.join("/")}`;
      }
    }

    const maxConfidentiality = ifc?.maxConfidentiality ?? [];
    if (maxConfidentiality.length > 0 && consumed.length > 0) {
      const ok = consumed.every((read) =>
        ((read.label?.classification ?? read.label?.confidentiality) ?? [])
          .every((value) => maxConfidentiality.includes(String(value)))
      );
      if (!ok) {
        return `maxConfidentiality failed at /${entry.path.join("/")}`;
      }
    }
  }
  return undefined;
};

const ensureSchemaDocument = (
  tx: IExtendedStorageTransaction,
  space: MemorySpace,
  schemaHash: string,
  schema: JSONSchema,
): void => {
  const id = `cid:${schemaHash}`;
  const existing = tx.readOrThrow({
    space,
    id: id as URI,
    type: "application/json",
    path: [],
  }, {
    meta: INTERNAL_VERIFIER_META,
  });
  if (existing !== undefined) {
    return;
  }
  tx.writeOrThrow({
    space,
    id: id as URI,
    type: "application/json",
    path: [],
  }, {
    // System-owned canonical schema document. This is intentionally outside the
    // phase-1 value-surface attempted-target model.
    value: schema as unknown as FabricValue,
  });
};

const loadSchemaDocument = (
  tx: IExtendedStorageTransaction,
  space: MemorySpace,
  schemaHash: string,
): JSONSchema => {
  const id = `cid:${schemaHash}`;
  const existing = tx.readOrThrow({
    space,
    id: id as URI,
    type: "application/json",
    path: [],
  }, {
    meta: INTERNAL_VERIFIER_META,
  });
  if (!isRecord(existing) || existing.value === undefined) {
    throw new Error(`stored schemaHash ${schemaHash} is missing or unreadable`);
  }
  return existing.value as JSONSchema;
};

export const prepareBoundaryCommit = (
  tx: IExtendedStorageTransaction,
): string[] => {
  const reasons: string[] = [];
  const candidates = candidateSchemasByTarget(
    tx.getCfcState().writePolicyInputs,
  );
  for (const [key, target] of valueWriteTargets(tx)) {
    if (candidates.has(key)) {
      continue;
    }
    reasons.push(
      `missing schema write-policy input for ${target.id}`,
    );
  }
  for (const [key, schema] of candidates) {
    const [space, id, type] = key.split("\u0000") as [
      MemorySpace,
      URI,
      MediaType,
    ];
    const frozen = toDeepFrozenSchema(schema, true) as JSONSchema;

    const requirementFailure = verifyInputRequirements(tx, frozen);
    if (requirementFailure) {
      reasons.push(requirementFailure);
      continue;
    }

    const existing = storedMetadataFor(tx, space, id, type);
    let mergedSchema = frozen;
    if (existing !== undefined) {
      try {
        const storedSchema = loadSchemaDocument(tx, space, existing.schemaHash);
        mergedSchema = mergeCfcSchemaEnvelopes(storedSchema, frozen);
      } catch (error) {
        reasons.push(
          error instanceof Error
            ? error.message
            : `schema merge failed for ${id}`,
        );
        continue;
      }
    }
    const schemaAndHash = internSchema(
      toDeepFrozenSchema(mergedSchema, true) as JSONSchema,
      true,
    );

    ensureSchemaDocument(
      tx,
      space,
      schemaAndHash.hashString,
      schemaAndHash.schema,
    );
    const metadata: CfcMetadata = {
      version: 1,
      schemaHash: schemaAndHash.hashString,
      labelMap: {
        version: 1,
        entries: walkIfcSchema(mergedSchema).map((entry) => ({
          path: entry.path,
          label: entry.label,
        })),
      },
    };

    tx.writeOrThrow({
      space,
      id,
      type,
      path: ["cfc"],
      // System-owned embedded metadata write. Boundary evaluation is driven by
      // user-surface reads/writes plus explicit policy inputs, not by recursive
      // attempted-target tracking of this internal metadata update.
    }, metadata as unknown as FabricValue);
  }
  return reasons;
};
