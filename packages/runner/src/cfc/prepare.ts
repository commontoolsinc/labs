import { internSchema } from "@commonfabric/data-model/schema-hash";
import { emptySchemaObject } from "@commonfabric/data-model/schema-utils";
import { deepEqual } from "@commonfabric/utils/deep-equal";
import type {
  FabricValue,
  MemorySpace,
  URI,
} from "@commonfabric/memory/interface";
import { isRecord } from "@commonfabric/utils/types";
import type { JSONSchema } from "../builder/types.ts";
import { normalizeCellScope } from "../scope.ts";
import { ignoreReadForScheduling } from "../scheduler.ts";
import type {
  IExtendedStorageTransaction,
  MediaType,
} from "../storage/interface.ts";
import {
  internalVerifierRead,
  isInternalVerifierRead,
} from "../storage/reactivity-log.ts";
import {
  isPrimitiveCellLink,
  isWriteRedirectLink,
  parseLink,
} from "../link-utils.ts";
import { getValueAtPath } from "../path-utils.ts";
import { encodePointer } from "../../../memory/v2/path.ts";
import { canonicalizeLogicalPath } from "./canonical.ts";
import { uniqueCfcAtoms } from "./observation.ts";
import { mergeCfcSchemaEnvelopes } from "./schema-merge.ts";
import {
  CFC_STRUCTURAL_PROVENANCE_SETUP_PROJECTION,
  type CfcMetadata,
  type IFCLabel,
  type ImplementationIdentity,
  type WritePolicyInput,
} from "./types.ts";
import {
  recordedTrustedEventProvenanceMatchesUiContract,
  uiContractsFromSchema,
} from "./ui-contract.ts";

const INTERNAL_VERIFIER_META = {
  ...ignoreReadForScheduling,
  ...internalVerifierRead,
};

const isPrefix = (
  prefix: readonly string[],
  path: readonly string[],
): boolean =>
  prefix.length <= path.length &&
  prefix.every((segment, index) =>
    segment === path[index] || segment === "*" || path[index] === "*"
  );

const labelAtPath = (
  metadata: CfcMetadata | undefined,
  path: readonly string[],
): IFCLabel | undefined => {
  if (!metadata) {
    return undefined;
  }
  let match:
    | {
      path: readonly string[];
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

const mergeLabelValues = (
  ...sources: Array<readonly unknown[] | undefined>
) => {
  // Structural dedup via `uniqueCfcAtoms()` rather than reference dedup
  // via `new Set()`. Atoms can be fabric-converted clones (each
  // `cloneIfNecessary()` produces a fresh frozen object), so two
  // logically-identical caveats may not share a JS reference.
  const merged = uniqueCfcAtoms(
    sources.flatMap((source) => source ? [...source] : []),
  );
  return merged.length > 0 ? merged : undefined;
};

const hasLabelValues = (label: IFCLabel): boolean =>
  (label.confidentiality?.length ?? 0) > 0 ||
  (label.integrity?.length ?? 0) > 0;

const metadataAppliesToPath = (
  metadata: CfcMetadata,
  path: readonly string[],
): boolean => {
  const logicalPath = canonicalizeLogicalPath(path);
  // A labelMap entry is persisted whenever the source schema had label values
  // OR a policy claim (writeAuthorizedBy / uiContract / exactCopyOf — see the
  // entry-construction site). The mere presence of the entry signals "policy
  // applies on this path"; do NOT filter on `hasLabelValues` here, or
  // claim-only entries get silently bypassed.
  return metadata.labelMap.entries.some((entry) =>
    isPrefix(entry.path, logicalPath) || isPrefix(logicalPath, entry.path)
  );
};

const metadataAppliesToAnyPath = (
  metadata: CfcMetadata,
  paths: readonly (readonly string[])[],
): boolean => paths.some((path) => metadataAppliesToPath(metadata, path));

const hasPersistedPolicyClaim = (schema: JSONSchema): boolean => {
  if (!isRecord(schema) || !isRecord(schema.ifc)) {
    return false;
  }
  return schema.ifc.writeAuthorizedBy !== undefined ||
    schema.ifc.uiContract !== undefined ||
    schema.ifc.exactCopyOf !== undefined;
};

const claimPathToLogicalPath = (
  claim: unknown,
): readonly string[] | undefined => {
  if (
    Array.isArray(claim) &&
    claim.every((segment) => typeof segment === "string")
  ) {
    return canonicalizeLogicalPath(claim);
  }
  if (typeof claim === "string") {
    if (claim.startsWith("/")) {
      return canonicalizeLogicalPath(
        claim.split("/").filter((segment) => segment.length > 0),
      );
    }
    return canonicalizeLogicalPath([claim]);
  }
  return undefined;
};

const writeAuthorizedByReason = (
  tx: IExtendedStorageTransaction,
  schema: JSONSchema,
  path: readonly string[],
): string | undefined => {
  if (!isRecord(schema) || !isRecord(schema.ifc)) {
    return undefined;
  }
  const claim = schema.ifc.writeAuthorizedBy;
  if (claim === undefined) {
    return undefined;
  }

  const trustSnapshot = tx.getCfcState().trustSnapshot;
  if (!trustSnapshot?.id || !trustSnapshot?.actingPrincipal) {
    return `writeAuthorizedBy requires a trust snapshot at /${path.join("/")}`;
  }

  const identity = tx.getCfcState().implementationIdentity;
  if (
    Array.isArray(claim) && claim.every((entry) => typeof entry === "string")
  ) {
    if (!identity || identity.kind !== "builtin") {
      return `writeAuthorizedBy requires a trusted builtin identity at /${
        path.join("/")
      }`;
    }
    if (!claim.includes(identity.builtinId)) {
      return `writeAuthorizedBy failed at /${path.join("/")}`;
    }
    return undefined;
  }

  const bindingIdentity = parseWriteAuthorizedByBindingIdentity(claim);
  if (!bindingIdentity) {
    return `unsupported trust-sensitive claim writeAuthorizedBy at /${
      path.join("/")
    }`;
  }
  if (!identity || identity.kind !== "verified" || !identity.bindingPath) {
    return `writeAuthorizedBy requires a trusted verified binding identity at /${
      path.join("/")
    }`;
  }
  if (
    typeof identity.bundleId !== "string" ||
    identity.bundleId.length === 0 ||
    identity.bundleId !== bindingIdentity.bundleId ||
    normalizeIdentitySource(identity.sourceFile) !==
      normalizeIdentitySource(bindingIdentity.file) ||
    !arraysEqual(identity.bindingPath, bindingIdentity.path)
  ) {
    return `writeAuthorizedBy failed at /${path.join("/")}`;
  }
  return undefined;
};

const parseWriteAuthorizedByBindingIdentity = (
  claim: unknown,
): { bundleId?: string; file: string; path: string[] } | undefined => {
  if (!isRecord(claim) || !isRecord(claim.__ctWriterIdentityOf)) {
    return undefined;
  }
  const identity = claim.__ctWriterIdentityOf;
  if (
    typeof identity.file !== "string" ||
    !Array.isArray(identity.path) ||
    !identity.path.every((entry) => typeof entry === "string")
  ) {
    return undefined;
  }
  return {
    ...(typeof identity.bundleId === "string"
      ? { bundleId: identity.bundleId }
      : {}),
    file: identity.file,
    path: [...identity.path],
  };
};

const arraysEqual = (
  left: readonly string[],
  right: readonly string[],
): boolean =>
  left.length === right.length &&
  left.every((value, index) => value === right[index]);

const normalizeIdentitySource = (
  source: string | undefined,
): string | undefined => {
  if (typeof source !== "string" || source.length === 0) {
    return undefined;
  }
  return source.startsWith("/") ? source : `/${source}`;
};

type StructuralProvenanceInput = Extract<
  WritePolicyInput,
  { kind: "structural-provenance" }
>;

type LinkWritePolicyInput = Extract<
  WritePolicyInput,
  { kind: "link-write" }
>;

const structuralProvenanceForPath = (
  tx: IExtendedStorageTransaction,
  target: {
    space: MemorySpace;
    id: URI;
    scope: ReturnType<typeof normalizeCellScope>;
  },
  path: readonly string[],
  claim: string,
): StructuralProvenanceInput | undefined => {
  const logicalPath = canonicalizeLogicalPath(path);
  return tx.getCfcState().writePolicyInputs.find((
    input,
  ): input is StructuralProvenanceInput =>
    input.kind === "structural-provenance" &&
    input.claim === claim &&
    input.target.space === target.space &&
    input.target.id === target.id &&
    input.target.scope === target.scope &&
    arraysEqual(canonicalizeLogicalPath(input.target.path), logicalPath)
  );
};

const setupProjectionSourceMatchesValue = (
  tx: IExtendedStorageTransaction,
  target: {
    space: MemorySpace;
    id: URI;
    scope: ReturnType<typeof normalizeCellScope>;
  },
  path: readonly string[],
): boolean => {
  const projection = structuralProvenanceForPath(
    tx,
    target,
    path,
    CFC_STRUCTURAL_PROVENANCE_SETUP_PROJECTION,
  );
  if (projection === undefined) {
    return false;
  }
  const targetValue = writeValueForTarget(tx, { ...target, path });
  if (!isWriteRedirectLink(targetValue)) {
    return false;
  }
  const projected = parseLink(targetValue);
  if (projected === undefined) {
    return false;
  }
  const projectedPath = projected.path.map((entry) => String(entry));
  return projection.sources.some((source) =>
    (projected.space === undefined || projected.space === source.space) &&
    (projected.id === undefined || projected.id === source.id) &&
    arraysEqual(projectedPath, source.path)
  );
};

const storedMetadataFor = (
  tx: IExtendedStorageTransaction,
  space: MemorySpace,
  id: URI,
  scope: ReturnType<typeof normalizeCellScope>,
  type: MediaType,
): CfcMetadata | undefined => {
  const document = tx.readOrThrow({
    space,
    id,
    scope,
    type,
    path: [],
  }, {
    meta: INTERNAL_VERIFIER_META,
  });
  return isRecord(document) && isRecord(document.cfc)
    ? document.cfc as CfcMetadata
    : undefined;
};

/**
 * This returns a map whose values are always interned schemas.
 */
const candidateSchemasByTarget = (
  inputs: readonly WritePolicyInput[],
  implementationIdentity?: ImplementationIdentity,
): Map<string, JSONSchema> => {
  const result = new Map<string, JSONSchema>();
  for (const input of inputs) {
    if (input.kind !== "schema" || input.schema === undefined) {
      continue;
    }
    const key = targetKey(input.target);
    const schema = rebindWriteAuthorizedByClaims(
      input.schema,
      implementationIdentity,
    );
    const candidate = schemaEnvelopeForTargetPath(
      schema,
      input.target.path,
    );
    const existing = result.get(key);
    result.set(
      key,
      existing === undefined
        ? internSchema(candidate)
        : mergeCfcSchemaEnvelopes(existing, candidate), // Guaranteed interned.
    );
  }
  return result;
};

const targetKey = (target: {
  space: MemorySpace;
  id: string;
  scope?: ReturnType<typeof normalizeCellScope>;
}): string =>
  `${target.space}\u0000${normalizeCellScope(target.scope)}\u0000${target.id}`;

const targetFromKey = (key: string): {
  space: MemorySpace;
  scope: ReturnType<typeof normalizeCellScope>;
  id: URI;
} => {
  const [space, scope, id] = key.split("\u0000") as [
    MemorySpace,
    ReturnType<typeof normalizeCellScope>,
    URI,
  ];
  return { space, scope, id };
};

const linkWritesByTarget = (
  inputs: readonly WritePolicyInput[],
): Map<string, LinkWritePolicyInput[]> => {
  const result = new Map<string, LinkWritePolicyInput[]>();
  for (const input of inputs) {
    if (input.kind !== "link-write") {
      continue;
    }
    const key = targetKey(input.target);
    const entries = result.get(key) ?? [];
    entries.push(input);
    result.set(key, entries);
  }
  return result;
};

const pathKey = (path: readonly string[]): string =>
  encodePointer(canonicalizeLogicalPath(path));

const pathsOverlap = (
  left: readonly string[],
  right: readonly string[],
): boolean => isPrefix(left, right) || isPrefix(right, left);

const linkWriteCoversAffectedPath = (
  writePath: readonly string[],
  entryPath: readonly string[],
  inputs: readonly LinkWritePolicyInput[],
): boolean =>
  inputs.some((input) => {
    const linkPath = canonicalizeLogicalPath(input.target.path);
    return pathsOverlap(linkPath, writePath) &&
      pathsOverlap(linkPath, entryPath);
  });

const linkWritesCoverCfcAffectedPaths = (
  metadata: CfcMetadata,
  writePaths: readonly (readonly string[])[],
  inputs: readonly LinkWritePolicyInput[],
): boolean =>
  writePaths.every((writePath) =>
    metadata.labelMap.entries.every((entry) => {
      const entryPath = canonicalizeLogicalPath(entry.path);
      return !pathsOverlap(entryPath, writePath) ||
        linkWriteCoversAffectedPath(writePath, entryPath, inputs);
    })
  );

const rebindWriteAuthorizedByClaims = (
  schema: JSONSchema,
  identity: ImplementationIdentity | undefined,
): JSONSchema => {
  if (
    !identity || identity.kind !== "verified" ||
    typeof identity.bundleId !== "string" ||
    identity.bundleId.length === 0
  ) {
    return schema;
  }
  return rebindWriteAuthorizedByClaimsInner(
    schema,
    identity.bundleId,
  ) as JSONSchema;
};

const rebindWriteAuthorizedByClaimsInner = (
  value: unknown,
  bundleId: string,
): unknown => {
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((entry) => {
      const rebound = rebindWriteAuthorizedByClaimsInner(entry, bundleId);
      changed ||= rebound !== entry;
      return rebound;
    });
    return changed ? next : value;
  }
  if (!isRecord(value)) {
    return value;
  }

  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    const rebound = rebindWriteAuthorizedByClaimsInner(entry, bundleId);
    changed ||= rebound !== entry;
    next[key] = rebound;
  }

  if (isRecord(value.ifc) && isRecord(value.ifc.writeAuthorizedBy)) {
    const claim = value.ifc.writeAuthorizedBy;
    if (
      isRecord(claim.__ctWriterIdentityOf) &&
      claim.__ctWriterIdentityOf.bundleId === undefined
    ) {
      const nextIfc = { ...value.ifc };
      nextIfc.writeAuthorizedBy = {
        ...claim,
        __ctWriterIdentityOf: {
          ...claim.__ctWriterIdentityOf,
          bundleId,
        },
      };
      next.ifc = nextIfc;
      changed = true;
    }
  }

  return changed ? next : value;
};

const schemaEnvelopeForTargetPath = (
  schema: JSONSchema,
  path: readonly string[],
): JSONSchema => {
  let envelope = schema;
  for (const segment of [...canonicalizeLogicalPath(path)].reverse()) {
    envelope = {
      type: "object",
      properties: {
        [segment]: envelope,
      },
    };
  }
  return envelope;
};

const valueWriteTargets = (
  tx: IExtendedStorageTransaction,
): Map<
  string,
  {
    space: MemorySpace;
    scope: ReturnType<typeof normalizeCellScope>;
    id: URI;
    type: MediaType;
    paths: (readonly string[])[];
  }
> => {
  const result = new Map<
    string,
    {
      space: MemorySpace;
      scope: ReturnType<typeof normalizeCellScope>;
      id: URI;
      type: MediaType;
      paths: (readonly string[])[];
    }
  >();
  const log = tx.getReactivityLog?.();
  const seenWriteSpaces = new Set<MemorySpace>(
    [...(log?.writes ?? []), ...(log?.potentialWrites ?? [])].map((write) =>
      write.space
    ),
  );
  for (const space of seenWriteSpaces) {
    for (const write of tx.getWriteDetails?.(space) ?? []) {
      const writePath = canonicalizeLogicalPath(write.address.path);
      if (
        write.address.id.startsWith("cid:") ||
        writePath[0] === "cfc" ||
        writePath[0] === "source" ||
        (
          writePath[0] === "internal" &&
          isPrimitiveCellLink(write.value)
        )
      ) {
        continue;
      }
      const key = targetKey(write.address);
      const existing = result.get(key);
      if (existing !== undefined) {
        existing.paths.push(writePath);
      } else {
        result.set(key, {
          space: write.address.space,
          scope: normalizeCellScope(write.address.scope),
          id: write.address.id as URI,
          type: (write.address.type ?? "application/json") as MediaType,
          paths: [writePath],
        });
      }
    }
  }
  return result;
};

const walkIfcSchema = (
  schema: JSONSchema,
  path: readonly string[] = [],
  entries: Array<
    { path: readonly string[]; label: IFCLabel; schema: JSONSchema }
  > = [],
): typeof entries => {
  if (typeof schema === "boolean") {
    return entries;
  }
  if (schema.ifc !== undefined) {
    entries.push({
      path,
      label: {
        integrity: schema.ifc.integrity ? [...schema.ifc.integrity] : undefined,
        confidentiality: schema.ifc.confidentiality
          ? [...schema.ifc.confidentiality]
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

const policyOnlySchema = (schema: JSONSchema): JSONSchema => {
  if (!isRecord(schema) || !isRecord(schema.ifc)) {
    return {};
  }
  return { ifc: { ...schema.ifc } } as JSONSchema;
};

const storedSchemaClaimsForLinkWrites = (
  schema: JSONSchema,
  inputs: readonly LinkWritePolicyInput[],
): JSONSchema => {
  let result: JSONSchema | undefined;
  const targetPaths = inputs.map((input) =>
    canonicalizeLogicalPath(input.target.path)
  );
  for (const entry of walkIfcSchema(schema)) {
    if (
      !targetPaths.some((targetPath) => pathsOverlap(targetPath, entry.path))
    ) {
      continue;
    }
    const envelope = schemaEnvelopeForTargetPath(
      policyOnlySchema(entry.schema),
      entry.path,
    );
    result = result === undefined
      ? envelope
      : mergeCfcSchemaEnvelopes(result, envelope);
  }
  return result ?? {};
};

const unsupportedTrustSensitiveReason = (
  schema: JSONSchema,
  path: readonly string[],
): string | undefined => {
  if (!isRecord(schema) || !isRecord(schema.ifc)) {
    return undefined;
  }
  const unsupportedKeys = [
    "projection",
    "collection",
  ] as const;
  for (const key of unsupportedKeys) {
    const value = schema.ifc[key];
    if (value !== undefined) {
      return `unsupported trust-sensitive claim ${key} at /${path.join("/")}`;
    }
  }
  return undefined;
};

const exactCopySourcePath = (
  schema: JSONSchema,
): readonly string[] | undefined => {
  if (!isRecord(schema) || !isRecord(schema.ifc)) {
    return undefined;
  }
  return claimPathToLogicalPath(schema.ifc.exactCopyOf);
};

const writeValueForTarget = (
  tx: IExtendedStorageTransaction,
  target: {
    space: MemorySpace;
    id: URI;
    scope: ReturnType<typeof normalizeCellScope>;
    path: readonly string[];
  },
): FabricValue => {
  const writeDetails = [...(tx.getWriteDetails?.(target.space) ?? [])];
  let matchingWrite:
    | {
      address: {
        id: URI;
        type?: MediaType;
        path: readonly string[];
      };
      value?: FabricValue;
    }
    | undefined;
  let matchingWritePath: string[] | undefined;
  for (const write of writeDetails) {
    if (write.address.id !== target.id) continue;
    if (normalizeCellScope(write.address.scope) !== target.scope) continue;
    if (write.address.path[0] !== "value") {
      continue;
    }
    const writePath = write.address.path.slice(1).map((entry) => String(entry));
    const targetPath = target.path.map((entry) => String(entry));
    if (writePath.length > targetPath.length) {
      continue;
    }
    if (!writePath.every((segment, index) => segment === targetPath[index])) {
      continue;
    }
    if (
      matchingWrite === undefined ||
      (matchingWritePath?.length ?? -1) < writePath.length
    ) {
      matchingWrite = write;
      matchingWritePath = writePath;
    }
  }

  const value = matchingWrite?.value;
  if (value === undefined || matchingWritePath === undefined) {
    return undefined;
  }
  const targetPath = target.path.map((entry) => String(entry));
  if (matchingWritePath.length === targetPath.length) {
    return value;
  }
  return getValueAtPath(value, targetPath.slice(matchingWritePath.length));
};

const verifyInputRequirements = (
  tx: IExtendedStorageTransaction,
  schema: JSONSchema,
  target: {
    space: MemorySpace;
    id: URI;
    scope: ReturnType<typeof normalizeCellScope>;
  },
): string | undefined => {
  const consumed = [...(tx.getReadActivities?.() ?? [])].filter((read) =>
    !isInternalVerifierRead(read.meta)
  ).map((read) => ({
    ...read,
    path: canonicalizeLogicalPath(read.path),
    label: labelAtPath(
      storedMetadataFor(
        tx,
        read.space,
        read.id,
        normalizeCellScope(read.scope),
        read.type ?? "application/json",
      ),
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
    const writeAuthorizedByFailure = writeAuthorizedByReason(
      tx,
      entry.schema,
      entry.path,
    );
    const setupProjection = setupProjectionSourceMatchesValue(
      tx,
      target,
      entry.path,
    );
    if (writeAuthorizedByFailure !== undefined && !setupProjection) {
      return writeAuthorizedByFailure;
    }
    const requiredIntegrity = ifc?.requiredIntegrity ?? [];
    if (requiredIntegrity.length > 0 && consumed.length > 0) {
      const ok = consumed.every((read) =>
        requiredIntegrity.every((required) =>
          (read.label?.integrity ?? []).some((actual) =>
            deepEqual(actual, required)
          )
        )
      );
      if (!ok) {
        return `requiredIntegrity failed at /${entry.path.join("/")}`;
      }
    }

    const maxConfidentiality = ifc?.maxConfidentiality ?? [];
    if (maxConfidentiality.length > 0 && consumed.length > 0) {
      const ok = consumed.every((read) =>
        (read.label?.confidentiality ?? []).every((value) =>
          maxConfidentiality.some((allowed) => deepEqual(allowed, value))
        )
      );
      if (!ok) {
        return `maxConfidentiality failed at /${entry.path.join("/")}`;
      }
    }
  }
  return undefined;
};

const verifyTrustedEventRequirements = (
  tx: IExtendedStorageTransaction,
  target: {
    space: MemorySpace;
    id: URI;
    scope: ReturnType<typeof normalizeCellScope>;
  },
  schema: JSONSchema,
): string | undefined => {
  for (const entry of uiContractsFromSchema(schema)) {
    if (setupProjectionSourceMatchesValue(tx, target, entry.path)) {
      continue;
    }
    const matched = tx.getCfcState().writePolicyInputs.some((input) =>
      input.kind === "trusted-event" &&
      input.target.space === target.space &&
      input.target.id === target.id &&
      input.target.scope === target.scope &&
      arraysEqual(input.target.path, entry.path) &&
      recordedTrustedEventProvenanceMatchesUiContract(
        input.provenance,
        entry.contract,
      )
    );
    if (!matched) {
      return `missing trusted-event policy input for ${target.id} at /${
        entry.path.join("/")
      }`;
    }
  }
  return undefined;
};

const verifyExactCopyRequirements = (
  tx: IExtendedStorageTransaction,
  target: {
    space: MemorySpace;
    id: URI;
    scope: ReturnType<typeof normalizeCellScope>;
  },
  schema: JSONSchema,
): string | undefined => {
  for (const entry of walkIfcSchema(schema)) {
    const sourcePath = exactCopySourcePath(entry.schema);
    if (sourcePath === undefined) {
      continue;
    }
    const targetValue = writeValueForTarget(tx, {
      ...target,
      path: entry.path,
    });
    const sourceValue = writeValueForTarget(tx, {
      ...target,
      path: sourcePath,
    });

    if (!deepEqual(sourceValue, targetValue)) {
      return `exactCopyOf failed at /${entry.path.join("/")}`;
    }
  }
  return undefined;
};

const derivePersistedLabel = (
  schema: JSONSchema,
  schemaLabel: IFCLabel,
  sourceEntryLabels?: Map<string, IFCLabel>,
): IFCLabel => {
  const ifc = isRecord(schema) ? schema.ifc : undefined;
  const copiedInputLabel = sourceEntryLabels && exactCopySourcePath(schema)
    ? sourceEntryLabels.get(pathKey(exactCopySourcePath(schema)!))
    : undefined;
  return {
    confidentiality: mergeLabelValues(
      schemaLabel.confidentiality,
      copiedInputLabel?.confidentiality,
    ),
    integrity: mergeLabelValues(
      schemaLabel.integrity,
      copiedInputLabel?.integrity,
      Array.isArray(ifc?.addIntegrity) ? ifc.addIntegrity : undefined,
    ),
  };
};

const persistedLabelFromSchemaAtPath = (
  schema: JSONSchema,
  path: readonly string[],
): IFCLabel | undefined => {
  const logicalPath = canonicalizeLogicalPath(path);
  const entries = walkIfcSchema(schema);
  let match:
    | { path: readonly string[]; label: IFCLabel; schema: JSONSchema }
    | undefined;
  for (const entry of entries) {
    if (!isPrefix(entry.path, logicalPath)) {
      continue;
    }
    if (match === undefined || match.path.length < entry.path.length) {
      match = entry;
    }
  }
  if (match === undefined) {
    return undefined;
  }
  const entryLabels = new Map<string, IFCLabel>(
    entries.map((entry) => [pathKey(entry.path), entry.label]),
  );
  return derivePersistedLabel(match.schema, match.label, entryLabels);
};

const mergeLabels = (
  left: IFCLabel | undefined,
  right: IFCLabel | undefined,
): IFCLabel => ({
  confidentiality: mergeLabelValues(
    left?.confidentiality,
    right?.confidentiality,
  ),
  integrity: mergeLabelValues(left?.integrity, right?.integrity),
});

const linkReferenceIntegrity = (input: LinkWritePolicyInput): unknown => ({
  type: "https://commonfabric.org/cfc/atom/LinkReference",
  source: {
    space: input.source.space,
    id: input.source.id,
    path: canonicalizeLogicalPath(input.source.path),
  },
  target: {
    space: input.target.space,
    id: input.target.id,
    path: canonicalizeLogicalPath(input.target.path),
  },
});

const rootLabelFromSchema = (schema: JSONSchema | undefined): IFCLabel => {
  if (schema === undefined) {
    return {};
  }
  const root = walkIfcSchema(schema).find((entry) => entry.path.length === 0);
  return root?.label ?? {};
};

const derivePersistedLinkLabel = (
  tx: IExtendedStorageTransaction,
  input: LinkWritePolicyInput,
  candidateSchemas: ReadonlyMap<string, JSONSchema>,
): { label?: IFCLabel; reason?: string } => {
  const sourceMetadata = storedMetadataFor(
    tx,
    input.source.space,
    input.source.id as URI,
    input.source.scope,
    "application/json",
  );
  const pendingSourceLabel = candidateSchemas.get(targetKey(input.source)) !==
      undefined
    ? persistedLabelFromSchemaAtPath(
      candidateSchemas.get(targetKey(input.source))!,
      input.source.path,
    )
    : undefined;
  const linkSchemaLabel = rootLabelFromSchema(input.linkSchema);
  const hasCarriedLabel =
    input.cfcLabelView?.entries.some((entry) => hasLabelValues(entry.label)) ??
      false;
  if (
    sourceMetadata === undefined && pendingSourceLabel === undefined &&
    !hasLabelValues(linkSchemaLabel) && !hasCarriedLabel
  ) {
    return {
      reason: `missing link source metadata for ${input.target.id} at /${
        input.target.path.join("/")
      }`,
    };
  }
  if (
    sourceMetadata === undefined && pendingSourceLabel === undefined &&
    !hasLabelValues(linkSchemaLabel) && hasCarriedLabel
  ) {
    return {};
  }
  const sourceLabel = mergeLabels(
    sourceMetadata === undefined ? undefined : labelAtPath(
      sourceMetadata,
      canonicalizeLogicalPath(input.source.path),
    ) ?? {},
    pendingSourceLabel,
  );
  const label: IFCLabel = {
    confidentiality: mergeLabelValues(
      sourceLabel.confidentiality,
      linkSchemaLabel.confidentiality,
    ),
    integrity: mergeLabelValues(
      sourceLabel.integrity,
      linkSchemaLabel.integrity,
      [linkReferenceIntegrity(input)],
    ),
  };
  return { label };
};

const cloneLabel = (label: IFCLabel): IFCLabel => ({
  ...(label.confidentiality !== undefined
    ? { confidentiality: [...label.confidentiality] }
    : {}),
  ...(label.integrity !== undefined ? { integrity: [...label.integrity] } : {}),
});

const coalesceLabelEntries = (
  entries: ReadonlyArray<{ path: readonly string[]; label: IFCLabel }>,
): Array<{ path: readonly string[]; label: IFCLabel }> => {
  const byPath = new Map<
    string,
    { path: readonly string[]; label: IFCLabel }
  >();
  for (const entry of entries) {
    const path = [...entry.path];
    const key = pathKey(path);
    const existing = byPath.get(key);
    byPath.set(key, {
      path,
      label: mergeLabels(existing?.label, cloneLabel(entry.label)),
    });
  }
  return [...byPath.values()].sort((left, right) => {
    const leftKey = pathKey(left.path);
    const rightKey = pathKey(right.path);
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
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
  return internSchema(existing.value as JSONSchema);
};

export const prepareBoundaryCommit = (
  tx: IExtendedStorageTransaction,
): string[] => {
  const reasons: string[] = [];
  const candidates = candidateSchemasByTarget(
    tx.getCfcState().writePolicyInputs,
    tx.getCfcState().implementationIdentity,
  );
  const linkWrites = linkWritesByTarget(tx.getCfcState().writePolicyInputs);
  for (const [key, target] of valueWriteTargets(tx)) {
    if (candidates.has(key)) {
      continue;
    }
    const existing = storedMetadataFor(
      tx,
      target.space,
      target.id,
      target.scope,
      target.type,
    );
    if (existing === undefined) {
      continue;
    }
    if (!metadataAppliesToAnyPath(existing, target.paths)) {
      continue;
    }
    const linkWriteInputs = linkWrites.get(key) ?? [];
    if (
      linkWriteInputs.length > 0 &&
      linkWritesCoverCfcAffectedPaths(
        existing,
        target.paths,
        linkWriteInputs,
      )
    ) {
      continue;
    }
    reasons.push(
      `missing schema write-policy input for ${target.id}`,
    );
  }
  const targetKeys = new Set([...candidates.keys(), ...linkWrites.keys()]);
  for (const key of targetKeys) {
    const candidateSchema = candidates.get(key);
    const schema = candidateSchema ?? emptySchemaObject();
    const undefinedCandidate = candidateSchema === undefined;
    const target = targetFromKey(key);
    const { space, id, scope } = target;
    const existing = storedMetadataFor(
      tx,
      space,
      id,
      scope,
      "application/json",
    );
    let storedSchema: JSONSchema | undefined;
    let mergedSchema = schema;
    if (existing !== undefined && undefinedCandidate) {
      try {
        storedSchema = loadSchemaDocument(tx, space, existing.schemaHash);
        mergedSchema = storedSchema;
      } catch (error) {
        reasons.push(
          error instanceof Error
            ? error.message
            : `schema load failed for ${id}`,
        );
        continue;
      }
    } else if (existing !== undefined) {
      try {
        storedSchema = loadSchemaDocument(tx, space, existing.schemaHash);
        mergedSchema = mergeCfcSchemaEnvelopes(storedSchema, schema);
      } catch (error) {
        reasons.push(
          error instanceof Error
            ? error.message
            : `schema merge failed for ${id}`,
        );
        continue;
      }
    }

    const linkWriteInputs = linkWrites.get(key) ?? [];
    const verificationSchema = storedSchema !== undefined &&
        linkWriteInputs.length > 0
      ? undefinedCandidate
        ? storedSchemaClaimsForLinkWrites(storedSchema, linkWriteInputs)
        : mergeCfcSchemaEnvelopes(
          schema,
          storedSchemaClaimsForLinkWrites(storedSchema, linkWriteInputs),
        )
      : schema;

    const requirementFailure = verifyInputRequirements(
      tx,
      verificationSchema,
      target,
    );
    if (requirementFailure) {
      reasons.push(requirementFailure);
      continue;
    }
    const trustedEventFailure = verifyTrustedEventRequirements(
      tx,
      target,
      verificationSchema,
    );
    if (trustedEventFailure) {
      reasons.push(trustedEventFailure);
      continue;
    }

    const exactCopyFailure = verifyExactCopyRequirements(
      tx,
      target,
      verificationSchema,
    );
    if (exactCopyFailure) {
      reasons.push(exactCopyFailure);
      continue;
    }

    const schemaAndHash = internSchema(mergedSchema, true);
    const mergedSchemaEntries = walkIfcSchema(schemaAndHash.schema);
    const mergedSchemaEntryLabels = new Map<string, IFCLabel>(
      mergedSchemaEntries.map((entry) => [
        pathKey(entry.path),
        entry.label,
      ]),
    );
    const persistedLabelEntries = mergedSchemaEntries.flatMap((entry) => {
      const label = derivePersistedLabel(
        entry.schema,
        entry.label,
        mergedSchemaEntryLabels,
      );
      return hasLabelValues(label) || hasPersistedPolicyClaim(entry.schema)
        ? [{
          path: entry.path,
          label,
        }]
        : [];
    });
    const currentLinkWritePaths = new Set(
      linkWriteInputs.map((input) => pathKey(input.target.path)),
    );
    for (const entry of existing?.labelMap.entries ?? []) {
      const entryPath = canonicalizeLogicalPath(entry.path);
      const key = pathKey(entryPath);
      if (mergedSchemaEntryLabels.has(key) || currentLinkWritePaths.has(key)) {
        continue;
      }
      if (hasLabelValues(entry.label)) {
        persistedLabelEntries.push({
          path: entryPath,
          label: cloneLabel(entry.label),
        });
      }
    }
    for (const input of linkWriteInputs) {
      const result = derivePersistedLinkLabel(tx, input, candidates);
      if (result.reason !== undefined) {
        reasons.push(result.reason);
        continue;
      }
      if (result.label !== undefined && hasLabelValues(result.label)) {
        persistedLabelEntries.push({
          path: canonicalizeLogicalPath(input.target.path),
          label: result.label,
        });
      }
      const targetPath = canonicalizeLogicalPath(input.target.path);
      for (const entry of input.cfcLabelView?.entries ?? []) {
        if (!hasLabelValues(entry.label)) {
          continue;
        }
        persistedLabelEntries.push({
          path: [
            ...targetPath,
            ...canonicalizeLogicalPath(entry.path),
          ],
          label: cloneLabel(entry.label),
        });
      }
    }

    const coalescedLabelEntries = coalesceLabelEntries(persistedLabelEntries);

    if (coalescedLabelEntries.length === 0) {
      continue;
    }

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
        entries: coalescedLabelEntries,
      },
    };

    tx.writeOrThrow({
      space,
      id,
      scope,
      type: "application/json",
      path: ["cfc"],
      // System-owned embedded metadata write. Boundary evaluation is driven by
      // user-surface reads/writes plus explicit policy inputs, not by recursive
      // attempted-target tracking of this internal metadata update.
    }, metadata as unknown as FabricValue);
  }
  return reasons;
};
