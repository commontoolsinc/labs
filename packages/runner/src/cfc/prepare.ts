import { CFC_ATOM_TYPE } from "@commonfabric/api/cfc";
import {
  internSchema,
  internSchemaAsTaggedHashString,
} from "@commonfabric/data-model/schema-hash";
import { emptySchemaObject } from "@commonfabric/data-model/schema-utils";
import {
  cloneForMutation,
  type CloneForMutationResult,
} from "@commonfabric/data-model/fabric-value";
import { isArrayIndexPropertyName } from "@commonfabric/utils/arrays";
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
import { getValueAtPath, setValueAtPath } from "../path-utils.ts";
import { encodePointer } from "../../../memory/v2/path.ts";
import { ContextualFlowControl } from "../cfc.ts";
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
  pathPatternMatches,
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

const CURRENT_PRINCIPAL_PLACEHOLDER_KEY = "__ctCurrentPrincipal";
const CURRENT_PRINCIPAL_CLAIM_KINDS = new Set([
  "authored-by",
  "represents-principal",
]);

const isCurrentPrincipalPlaceholder = (value: unknown): boolean =>
  isRecord(value) && value[CURRENT_PRINCIPAL_PLACEHOLDER_KEY] === true;

const hasCurrentPrincipalPlaceholder = (value: unknown): boolean => {
  if (isCurrentPrincipalPlaceholder(value)) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.some(hasCurrentPrincipalPlaceholder);
  }
  if (isRecord(value)) {
    return Object.values(value).some(hasCurrentPrincipalPlaceholder);
  }
  return false;
};

const resolveCurrentPrincipalPlaceholders = (
  value: unknown,
  actingPrincipal: string,
): unknown => {
  if (isCurrentPrincipalPlaceholder(value)) {
    return actingPrincipal;
  }
  if (Array.isArray(value)) {
    return value.map((entry) =>
      resolveCurrentPrincipalPlaceholders(entry, actingPrincipal)
    );
  }
  if (!isRecord(value)) {
    return value;
  }

  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    const resolved = resolveCurrentPrincipalPlaceholders(
      entry,
      actingPrincipal,
    );
    changed ||= resolved !== entry;
    next[key] = resolved;
  }
  return changed ? next : value;
};

const resolveCurrentPrincipalLabelValues = (
  values: readonly unknown[] | undefined,
  actingPrincipal: string | undefined,
): readonly unknown[] | undefined => {
  if (!values) {
    return undefined;
  }
  const resolved = values.flatMap((value) => {
    if (!hasCurrentPrincipalPlaceholder(value)) {
      return [value];
    }
    return actingPrincipal
      ? [resolveCurrentPrincipalPlaceholders(value, actingPrincipal)]
      : [];
  });
  return resolved.length > 0 ? resolved : undefined;
};

const isCurrentPrincipalClaimAtom = (value: unknown): value is {
  readonly kind: string;
  readonly subject?: unknown;
} =>
  isRecord(value) &&
  typeof value.kind === "string" &&
  CURRENT_PRINCIPAL_CLAIM_KINDS.has(value.kind);

const hasLiteralDidCurrentPrincipalClaim = (value: unknown): boolean => {
  if (Array.isArray(value)) {
    return value.some(hasLiteralDidCurrentPrincipalClaim);
  }
  if (isCurrentPrincipalClaimAtom(value)) {
    return typeof value.subject === "string" &&
      value.subject.startsWith("did:");
  }
  if (isRecord(value)) {
    return Object.values(value).some(hasLiteralDidCurrentPrincipalClaim);
  }
  return false;
};

const literalDidSubjectsForPrincipalClaim = (
  value: unknown,
  kind: string,
  subjects: string[] = [],
): string[] => {
  if (Array.isArray(value)) {
    for (const entry of value) {
      literalDidSubjectsForPrincipalClaim(entry, kind, subjects);
    }
    return subjects;
  }
  if (isCurrentPrincipalClaimAtom(value) && value.kind === kind) {
    if (typeof value.subject === "string" && value.subject.startsWith("did:")) {
      subjects.push(value.subject);
    }
    return subjects;
  }
  if (isRecord(value)) {
    for (const entry of Object.values(value)) {
      literalDidSubjectsForPrincipalClaim(entry, kind, subjects);
    }
  }
  return subjects;
};

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
  targetIdentity?: ImplementationIdentity,
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

  // Verify against the identity that authored this target's writes. A write
  // recorded without an active identity stays unattributed (undefined) and
  // fails closed below; it must not borrow the transaction's current identity
  // (audit S13).
  const identity = targetIdentity;
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

// `writeAuthorizedBy` is a *modification* gate (CFC spec §8.15.10): it restricts
// who may edit an existing owner-protected value. It does not govern the trusted
// instantiation that first projects and initializes a field (§8.15.4 — defaults
// are installed by trusted runtime/pattern instantiation; write authorization
// applies to *subsequent* modifications).
//
// When the runtime instantiates a pattern whose result declares owner-protected
// fields, it records a setup-projection marker on the result cell whose
// `sources` point at the pattern's own projected (internal) cells — the cells
// that hold the field's value and carry its `writeAuthorizedBy` schema. The
// pattern initializing those fields (e.g. `avatar = ""`, `elements = []`) is its
// own trusted creation step, authored by the runtime's result projection, not by
// the per-field edit handler. Recognize a target as that trusted-creation site
// when it is the redirect *source* of a setup-projection marker recorded in this
// transaction, covering the field path.
//
// This is safe because the marker is recorded ONLY by the runtime's result
// projection — never by an arbitrary `cell.set` — and only when the projection
// STRUCTURE is established (instantiation), not on value edits (which leave the
// projection unchanged and so record no marker). Direct untrusted writes, no-op
// re-writes, and later field edits therefore remain fully enforced; the slot the
// pattern result is placed into is independently gated by its own
// `writeAuthorizedBy`, and the owner binding by `currentPrincipalIntegrityReason`.
const writeIsPatternSetupInitialization = (
  tx: IExtendedStorageTransaction,
  target: {
    space: MemorySpace;
    id: URI;
    scope: ReturnType<typeof normalizeCellScope>;
  },
  path: readonly string[],
): boolean => {
  const logicalPath = canonicalizeLogicalPath(path);
  return tx.getCfcState().writePolicyInputs.some((input) =>
    input.kind === "structural-provenance" &&
    input.claim === CFC_STRUCTURAL_PROVENANCE_SETUP_PROJECTION &&
    input.sources.some((source) => {
      if (
        source.space !== target.space || source.id !== target.id ||
        normalizeCellScope(source.scope) !== target.scope
      ) {
        return false;
      }
      // Only the redirect target itself, or a field nested under it, counts as
      // this pattern's trusted initialization: the marker's `source` path must
      // be a prefix of (or equal to) the field being written. We deliberately do
      // not exempt writes to an *ancestor* of the redirect target, which would
      // cover more than the projected field. (`concretePathHasPrefix(path,
      // prefix)` tests whether `prefix` is a prefix of `path`.)
      return concretePathHasPrefix(
        logicalPath,
        canonicalizeLogicalPath(source.path),
      );
    })
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
  identityForInput: (input: WritePolicyInput) =>
    | ImplementationIdentity
    | undefined,
): Map<string, JSONSchema> => {
  const result = new Map<string, JSONSchema>();
  for (const input of inputs) {
    if (input.kind !== "schema" || input.schema === undefined) {
      continue;
    }
    const key = targetKey(input.target);
    const schema = rebindWriteAuthorizedByClaims(
      input.schema,
      identityForInput(input),
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
        : schemasEqualIgnoringWriterBundleIds(existing, candidate)
        ? existing
        : mergeCfcSchemaEnvelopes(existing, candidate), // Guaranteed interned.
    );
  }
  return result;
};

/**
 * Maps each write target cell to the list of its write-authority-bearing inputs
 * (path + the implementation identity that authored each, captured when the
 * input was recorded). `writeAuthorizedBy` is verified per field, so we keep
 * each input's identity separately rather than collapsing a cell to a single
 * identity: a cell may carry several protected fields written under different
 * identities. Only `schema` and `link-write` inputs author the IFC entries that
 * `writeAuthorizedBy` checks (a value write and a link write into a protected
 * slot respectively); `trusted-event`, `structural-provenance` (setup markers),
 * `custom`, and `sink-request` inputs do not, so they must not contribute an
 * authoring identity (including them would let an unrelated input's identity be
 * borrowed for the writeAuthorizedBy check).
 */
const writePolicyIdentitiesByTarget = (
  inputs: readonly WritePolicyInput[],
  identityForInput: (input: WritePolicyInput) =>
    | ImplementationIdentity
    | undefined,
): Map<
  string,
  Array<
    { path: readonly string[]; identity: ImplementationIdentity | undefined }
  >
> => {
  const result = new Map<
    string,
    Array<
      { path: readonly string[]; identity: ImplementationIdentity | undefined }
    >
  >();
  for (const input of inputs) {
    if (input.kind !== "schema" && input.kind !== "link-write") {
      continue;
    }
    const key = targetKey(input.target);
    const list = result.get(key) ?? [];
    list.push({
      path: canonicalizeLogicalPath(input.target.path),
      identity: identityForInput(input),
    });
    result.set(key, list);
  }
  return result;
};

/**
 * The authoring identity for a field path: the schema input on this cell whose
 * own path is the longest prefix of (or equal to) the field path. That input is
 * the one whose schema contributed the IFC entry at this path, so its identity
 * is the one `writeAuthorizedBy` must be verified against.
 */
const identityForSchemaPath = (
  entries:
    | Array<
      { path: readonly string[]; identity: ImplementationIdentity | undefined }
    >
    | undefined,
  path: readonly string[],
): ImplementationIdentity | undefined => {
  if (entries === undefined) {
    return undefined;
  }
  let bestLength = -1;
  let bestIdentity: ImplementationIdentity | undefined;
  for (const entry of entries) {
    if (
      concretePathHasPrefix(path, entry.path) && entry.path.length > bestLength
    ) {
      bestLength = entry.path.length;
      bestIdentity = entry.identity;
    }
  }
  return bestIdentity;
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

const pathPatternsOverlap = (
  prefix: readonly string[],
  path: readonly string[],
): boolean =>
  prefix.length <= path.length &&
  prefix.every((segment, index) =>
    segment === "*" || path[index] === "*" || segment === path[index]
  );

const pathsOverlap = (
  left: readonly string[],
  right: readonly string[],
): boolean =>
  pathPatternsOverlap(left, right) || pathPatternsOverlap(right, left);

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

const stripWriterIdentityBundleIds = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(stripWriterIdentityBundleIds);
  }
  if (!isRecord(value)) {
    return value;
  }

  const next: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === "bundleId" && typeof value.file === "string") {
      continue;
    }
    next[key] = stripWriterIdentityBundleIds(entry);
  }
  return next;
};

const schemasEqualIgnoringWriterBundleIds = (
  left: JSONSchema,
  right: JSONSchema,
): boolean =>
  deepEqual(
    stripWriterIdentityBundleIds(left),
    stripWriterIdentityBundleIds(right),
  );

const storedSchemaCoversCandidateEnvelope = (
  stored: JSONSchema | undefined,
  candidate: JSONSchema | undefined,
): boolean => {
  if (stored === undefined || candidate === undefined) {
    return false;
  }
  if (schemasEqualIgnoringWriterBundleIds(stored, candidate)) {
    return true;
  }
  if (!isRecord(stored) || !isRecord(candidate)) {
    return false;
  }
  if (candidate.ifc !== undefined) {
    return false;
  }

  if (isRecord(candidate.properties)) {
    if (!isRecord(stored.properties)) {
      return false;
    }
    const storedProperties = stored.properties;
    return Object.entries(candidate.properties).every(([key, child]) =>
      storedSchemaCoversCandidateEnvelope(
        storedProperties[key] as JSONSchema | undefined,
        child as JSONSchema,
      )
    );
  }

  if (
    typeof candidate.items === "object" && candidate.items !== null &&
    typeof stored.items === "object" && stored.items !== null
  ) {
    return storedSchemaCoversCandidateEnvelope(stored.items, candidate.items);
  }

  return false;
};

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
    envelope = segment === "*"
      ? {
        type: "array",
        items: envelope,
      }
      : {
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
    [...(log?.writes ?? []), ...(log?.attemptedWrites ?? [])].map((write) =>
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
  root: JSONSchema = schema,
  active: Set<JSONSchema> = new Set(),
): typeof entries => {
  if (typeof schema === "boolean") {
    return entries;
  }
  if (active.has(schema)) {
    return entries;
  }
  active.add(schema);

  try {
    const schemaRoot = schema.$defs !== undefined ? schema : root;
    const resolved = typeof schema.$ref === "string"
      ? ContextualFlowControl.resolveSchemaRefs(schema, schemaRoot) ?? schema
      : schema;
    if (typeof resolved === "boolean") {
      return entries;
    }

    const childRoot = resolved.$defs !== undefined ? resolved : schemaRoot;
    if (resolved.ifc !== undefined) {
      entries.push({
        path,
        label: {
          integrity: resolved.ifc.integrity
            ? [...resolved.ifc.integrity]
            : undefined,
          confidentiality: resolved.ifc.confidentiality
            ? [...resolved.ifc.confidentiality]
            : undefined,
        },
        schema: resolved,
      });
    }

    if (resolved.properties) {
      for (const [key, child] of Object.entries(resolved.properties)) {
        walkIfcSchema(child, [...path, key], entries, childRoot, active);
      }
    }
    const compound = [
      ...(resolved.anyOf ?? []),
      ...(resolved.oneOf ?? []),
      ...(resolved.allOf ?? []),
    ];
    for (const child of compound) {
      walkIfcSchema(child, path, entries, childRoot, active);
    }
    if (typeof resolved.items === "object" && resolved.items !== null) {
      walkIfcSchema(resolved.items, [...path, "*"], entries, childRoot, active);
    }
    return entries;
  } finally {
    active.delete(schema);
  }
};

const policyOnlySchema = (schema: JSONSchema): JSONSchema => {
  if (!isRecord(schema) || !isRecord(schema.ifc)) {
    return {};
  }
  return { ifc: { ...schema.ifc } } as JSONSchema;
};

const linkWritePolicyOnlySchema = (
  schema: JSONSchema,
  path: readonly string[],
): JSONSchema => {
  const policy = policyOnlySchema(schema);
  if (!isRecord(policy) || !isRecord(policy.ifc) || !path.includes("*")) {
    return policy;
  }
  const { integrity: _integrity, ...ifc } = policy.ifc;
  return Object.keys(ifc).length === 0 ? {} : { ifc } as JSONSchema;
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
    const policySchema = linkWritePolicyOnlySchema(entry.schema, entry.path);
    if (isRecord(policySchema) && Object.keys(policySchema).length === 0) {
      continue;
    }
    const envelope = schemaEnvelopeForTargetPath(
      policySchema,
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
  // Claims the runner does not implement. A write to a path declaring one must
  // fail closed rather than be silently ignored (and dropped by schema-merge),
  // which would give an author no enforcement and no error (audit S10).
  const unsupportedKeys = [
    "projection",
    "collection",
    "opaque",
    "passThrough",
    "recomposeProjections",
    "combinedFrom",
    "combinationType",
    "transformation",
    "addedIntegrity",
  ] as const;
  const ifc = schema.ifc as Record<string, unknown>;
  for (const key of unsupportedKeys) {
    if (ifc[key] !== undefined) {
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

const currentPrincipalIntegrityReason = (
  tx: IExtendedStorageTransaction,
  schema: JSONSchema,
  path: readonly string[],
): string | undefined => {
  if (!isRecord(schema) || !isRecord(schema.ifc)) {
    return undefined;
  }

  const ifc = schema.ifc;
  const integrity = Array.isArray(ifc.integrity) ? ifc.integrity : [];
  const addIntegrity = Array.isArray(ifc.addIntegrity) ? ifc.addIntegrity : [];
  const currentPrincipalValues = [...integrity, ...addIntegrity];
  const ownerPrincipalSpec = ifc.ownerPrincipal;
  if (ownerPrincipalSpec !== undefined) {
    const trustSnapshot = tx.getCfcState().trustSnapshot;
    if (trustSnapshot === undefined) {
      return `ownerPrincipal requires a trust snapshot at /${path.join("/")}`;
    }
    if (!trustSnapshot.id) {
      return `ownerPrincipal requires a trust snapshot id at /${
        path.join("/")
      }`;
    }
    if (!trustSnapshot.actingPrincipal) {
      return `ownerPrincipal requires an acting principal at /${
        path.join("/")
      }`;
    }
    const ownerPrincipal = isCurrentPrincipalPlaceholder(ownerPrincipalSpec)
      ? trustSnapshot.actingPrincipal
      : ownerPrincipalSpec;
    if (
      typeof ownerPrincipal !== "string" ||
      !ownerPrincipal.startsWith("did:")
    ) {
      return `ownerPrincipal must be a DID at /${path.join("/")}`;
    }
    const resolvedCurrentPrincipalValues = resolveCurrentPrincipalLabelValues(
      currentPrincipalValues,
      trustSnapshot.actingPrincipal,
    ) ?? currentPrincipalValues;
    const representedOwners = literalDidSubjectsForPrincipalClaim(
      resolvedCurrentPrincipalValues,
      "represents-principal",
    );
    if (!representedOwners.some((subject) => subject === ownerPrincipal)) {
      return `ownerPrincipal requires matching represents-principal integrity at /${
        path.join("/")
      }`;
    }
    if (trustSnapshot.actingPrincipal !== ownerPrincipal) {
      return `ownerPrincipal mismatch at /${path.join("/")}`;
    }
    if (ifc.writeAuthorizedBy === undefined) {
      return `ownerPrincipal requires writeAuthorizedBy at /${path.join("/")}`;
    }
    return undefined;
  }
  if (currentPrincipalValues.length === 0) {
    return undefined;
  }
  if (hasLiteralDidCurrentPrincipalClaim(currentPrincipalValues)) {
    return `current-principal integrity subject must be runtime resolved at /${
      path.join("/")
    }`;
  }
  if (!currentPrincipalValues.some(hasCurrentPrincipalPlaceholder)) {
    return undefined;
  }

  const trustSnapshot = tx.getCfcState().trustSnapshot;
  if (trustSnapshot === undefined) {
    return `current-principal integrity requires a trust snapshot at /${
      path.join("/")
    }`;
  }
  if (!trustSnapshot.id) {
    return `current-principal integrity requires a trust snapshot id at /${
      path.join("/")
    }`;
  }
  if (!trustSnapshot.actingPrincipal) {
    return `current-principal integrity requires an acting principal at /${
      path.join("/")
    }`;
  }
  if (ifc.writeAuthorizedBy === undefined) {
    return `current-principal integrity requires writeAuthorizedBy at /${
      path.join("/")
    }`;
  }
  if (ifc.uiContract === undefined) {
    return `current-principal integrity requires uiContract at /${
      path.join("/")
    }`;
  }
  return undefined;
};

// Exported for unit testing of write-detail reconstruction (the granularity
// composition below). Not part of the public CFC surface.
export const writeDetailValueForTarget = (
  tx: IExtendedStorageTransaction,
  target: {
    space: MemorySpace;
    id: URI;
    scope: ReturnType<typeof normalizeCellScope>;
    path: readonly string[];
  },
  key: "value" | "previousValue",
): FabricValue => {
  const writeDetails = [...(tx.getWriteDetails?.(target.space) ?? [])];
  const targetPath = target.path.map((entry) => String(entry));
  let matchingWrite:
    | {
      address: {
        id: URI;
        type?: MediaType;
        path: readonly string[];
      };
      value?: FabricValue;
      previousValue?: FabricValue;
    }
    | undefined;
  let matchingWritePath: string[] | undefined;
  // Deeper ("descendant") writes under the target path are overlaid onto the
  // base value below, so a value recorded granularly (an envelope plus
  // per-field writes -- as happens when it is deep-frozen and so written
  // field-by-field) reconstructs the same as one recorded coarsely (a single
  // whole-object write). Reconstruction must not depend on write granularity.
  const descendants: { rel: string[]; value: FabricValue | undefined }[] = [];
  for (const write of writeDetails) {
    if (write.address.id !== target.id) continue;
    if (normalizeCellScope(write.address.scope) !== target.scope) continue;
    if (write.address.path[0] !== "value") {
      continue;
    }
    const writePath = write.address.path.slice(1).map((entry) => String(entry));
    if (writePath.length > targetPath.length) {
      // Descendant write: when `targetPath` is a prefix, keep it to overlay
      // onto the base value (composing granular field-writes).
      if (targetPath.every((segment, index) => segment === writePath[index])) {
        descendants.push({
          rel: writePath.slice(targetPath.length),
          value: write[key],
        });
      }
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

  const value = matchingWrite?.[key];
  if (value === undefined || matchingWritePath === undefined) {
    return undefined;
  }
  const baseValue = matchingWritePath.length === targetPath.length
    ? value
    : getValueAtPath(value, targetPath.slice(matchingWritePath.length));

  // Only the effective `value` composes deeper field-writes; the
  // `previousValue` of the longest ancestor write already captures the whole
  // pre-write subtree.
  if (key !== "value" || descendants.length === 0) {
    return baseValue;
  }

  if (!(isRecord(baseValue) || Array.isArray(baseValue))) {
    // Base isn't a container yet deeper writes exist (rare/incoherent): build a
    // fresh container and overlay onto it (it's freshly mutable -- no COW).
    const result: Record<PropertyKey, unknown> | unknown[] =
      descendants.every(({ rel }) => isArrayIndexPropertyName(rel[0]))
        ? []
        : {};
    for (const { rel, value: descendantValue } of descendants) {
      setValueAtPath(result, rel, descendantValue);
    }
    return result as FabricValue;
  }

  // Overlay the deeper field-writes onto the base via copy-on-write
  // spine-thawing: only the containers along each overlay path are shallow-
  // copied; large off-spine subtrees are preserved by reference, never
  // deep-copied. Process shallowest-first so an envelope write at a parent
  // path lands before writes to its children. `cloneForMutation` defaults to
  // `force: true`, so the shared (deep-frozen) base is never mutated.
  const ordered = [...descendants].sort((a, b) => a.rel.length - b.rel.length);
  let root: FabricValue = baseValue;
  for (const { rel, value: descendantValue } of ordered) {
    const leaf = rel[rel.length - 1]!;
    const thawed: CloneForMutationResult<FabricValue> = cloneForMutation(
      root,
      rel.slice(0, -1),
      { createMissing: true, nextKeyAfterPath: leaf },
    );
    setValueAtPath(
      thawed.pathValue as Record<PropertyKey, unknown> | unknown[],
      [leaf],
      descendantValue,
    );
    root = thawed.value;
  }
  return root;
};

const writeValueForTarget = (
  tx: IExtendedStorageTransaction,
  target: {
    space: MemorySpace;
    id: URI;
    scope: ReturnType<typeof normalizeCellScope>;
    path: readonly string[];
  },
): FabricValue => writeDetailValueForTarget(tx, target, "value");

const previousWriteValueForTarget = (
  tx: IExtendedStorageTransaction,
  target: {
    space: MemorySpace;
    id: URI;
    scope: ReturnType<typeof normalizeCellScope>;
    path: readonly string[];
  },
): FabricValue => writeDetailValueForTarget(tx, target, "previousValue");

const writeInstallsInitialSchemaDefault = (
  tx: IExtendedStorageTransaction,
  target: {
    space: MemorySpace;
    id: URI;
    scope: ReturnType<typeof normalizeCellScope>;
  },
  path: readonly string[],
  schema: JSONSchema | undefined,
): boolean => {
  if (!isRecord(schema) || !("default" in schema)) {
    return false;
  }
  const pathTarget = { ...target, path };
  return previousWriteValueForTarget(tx, pathTarget) === undefined &&
    deepEqual(writeValueForTarget(tx, pathTarget), schema.default);
};

const linkedWriteValueForPolicy = (
  tx: IExtendedStorageTransaction,
  baseTarget: {
    space: MemorySpace;
    id: URI;
    scope: ReturnType<typeof normalizeCellScope>;
  },
  value: unknown,
): unknown => {
  if (!isPrimitiveCellLink(value)) {
    return undefined;
  }

  const link = parseLink(value, { ...baseTarget, path: [] });
  if (link?.id === undefined || link.space === undefined) {
    return undefined;
  }

  const linkedTarget = {
    space: link.space,
    id: link.id as URI,
    scope: normalizeCellScope(link.scope),
    path: canonicalizeLogicalPath(link.path),
  };
  const written = writeValueForTarget(tx, linkedTarget);
  if (written !== undefined) {
    return written;
  }

  return tx.readValueOrThrow(linkedTarget, {
    meta: INTERNAL_VERIFIER_META,
  });
};

const valuesAtPatternPath = (
  value: unknown,
  path: readonly string[],
): unknown[] => {
  if (path.length === 0) {
    return [value];
  }

  const [head, ...rest] = path;
  if (head === "*") {
    if (!Array.isArray(value)) {
      return [];
    }
    return value.flatMap((item, index) =>
      index in value ? valuesAtPatternPath(item, rest) : []
    );
  }

  if (value === null || value === undefined || typeof value !== "object") {
    return [];
  }
  if (!(head in value)) {
    return [];
  }
  return valuesAtPatternPath((value as Record<string, unknown>)[head], rest);
};

const changedValuesAtPatternPath = (
  value: unknown,
  previousValue: unknown,
  path: readonly string[],
): unknown[] => {
  if (path.length === 0) {
    return deepEqual(value, previousValue) ? [] : [value];
  }

  const [head, ...rest] = path;
  if (head === "*") {
    if (!Array.isArray(value)) {
      return [];
    }
    const previousArray = Array.isArray(previousValue) ? previousValue : [];
    return value.flatMap((item, index) =>
      index in value
        ? changedValuesAtPatternPath(item, previousArray[index], rest)
        : []
    );
  }

  if (value === null || value === undefined || typeof value !== "object") {
    return [];
  }
  const previousChild = previousValue !== null &&
      previousValue !== undefined &&
      typeof previousValue === "object"
    ? (previousValue as Record<string, unknown>)[head]
    : undefined;
  if (!(head in value)) {
    return [];
  }
  return changedValuesAtPatternPath(
    (value as Record<string, unknown>)[head],
    previousChild,
    rest,
  );
};

const concretePathHasPrefix = (
  path: readonly string[],
  prefix: readonly string[],
): boolean =>
  prefix.length <= path.length &&
  prefix.every((segment, index) => segment === path[index]);

const schemaTypeMatchesValue = (
  type: unknown,
  value: unknown,
): boolean => {
  const types = Array.isArray(type) ? type : [type];
  return types.some((candidate) => {
    switch (candidate) {
      case "array":
        return Array.isArray(value);
      case "boolean":
        return typeof value === "boolean";
      case "integer":
        return typeof value === "number" && Number.isInteger(value);
      case "null":
        return value === null;
      case "number":
        return typeof value === "number";
      case "object":
        return isRecord(value) && !Array.isArray(value);
      case "string":
        return typeof value === "string";
      default:
        return true;
    }
  });
};

const policySchemaMatchesValue = (
  schema: JSONSchema,
  value: unknown,
): boolean => {
  // Keep this narrow matcher aligned with resolveSchemaForValue() in
  // schema.ts. This copy is intentionally local because CFC policy checks must
  // fail closed on unresolved refs and partial wildcard writes.
  if (typeof schema === "boolean") {
    return schema;
  }
  if (typeof schema.$ref === "string") {
    const resolved = ContextualFlowControl.resolveSchemaRefs(schema, schema);
    if (resolved === undefined) {
      return false;
    }
    return resolved !== schema
      ? policySchemaMatchesValue(resolved, value)
      : false;
  }
  if (schema.const !== undefined && !deepEqual(schema.const, value)) {
    return false;
  }
  if (
    Array.isArray(schema.enum) &&
    !schema.enum.some((candidate) => deepEqual(candidate, value))
  ) {
    return false;
  }
  if (
    schema.type !== undefined && !schemaTypeMatchesValue(schema.type, value)
  ) {
    return false;
  }
  if (Array.isArray(schema.anyOf)) {
    return schema.anyOf.some((branch) =>
      policySchemaMatchesValue(branch, value)
    );
  }
  if (Array.isArray(schema.oneOf)) {
    return schema.oneOf.filter((branch) =>
      policySchemaMatchesValue(branch, value)
    ).length === 1;
  }
  if (Array.isArray(schema.allOf)) {
    return schema.allOf.every((branch) =>
      policySchemaMatchesValue(branch, value)
    );
  }
  if (isRecord(value) && isRecord(schema.properties)) {
    return Object.entries(schema.properties).every(([key, childSchema]) =>
      value[key] === undefined ||
      policySchemaMatchesValue(childSchema, value[key])
    );
  }
  if (
    Array.isArray(value) && typeof schema.items === "object" &&
    schema.items !== null
  ) {
    const itemSchema = schema.items;
    return value.every((item) => policySchemaMatchesValue(itemSchema, item));
  }
  return true;
};

// Exported for unit testing of the unresolvable-link fail-closed branch (S17).
// Not part of the public CFC surface.
export const wildcardPolicyMatchesValue = (
  tx: IExtendedStorageTransaction,
  target: {
    space: MemorySpace;
    id: URI;
    scope: ReturnType<typeof normalizeCellScope>;
  },
  schema: JSONSchema | undefined,
  value: unknown,
): boolean => {
  if (schema === undefined) {
    return true;
  }

  if (!isPrimitiveCellLink(value)) {
    return policySchemaMatchesValue(schema, value);
  }

  const linkedValue = linkedWriteValueForPolicy(tx, target, value);
  if (linkedValue !== undefined) {
    return policySchemaMatchesValue(schema, linkedValue);
  }

  // The link's target value is unresolvable, so the policy's value condition
  // cannot be evaluated against real data. The link's embedded schema is
  // author-controlled and must not be trusted to exclude the policy (audit
  // S17): fail closed by treating the entry as applying.
  return true;
};

const ifcEntryAppliesToAttemptedWrite = (
  tx: IExtendedStorageTransaction,
  target: {
    space: MemorySpace;
    id: URI;
    scope: ReturnType<typeof normalizeCellScope>;
  },
  path: readonly string[],
  schema?: JSONSchema,
): boolean => {
  const wildcardIndex = path.indexOf("*");
  if (wildcardIndex === -1) {
    const writes = [...(tx.getWriteDetails?.(target.space) ?? [])];
    let touched = false;
    for (const write of writes) {
      if (write.address.id !== target.id) continue;
      if (normalizeCellScope(write.address.scope) !== target.scope) continue;
      if (write.address.path[0] !== "value") continue;
      const writePath = write.address.path.slice(1).map((entry) =>
        String(entry)
      );
      if (
        concretePathHasPrefix(path, writePath) ||
        concretePathHasPrefix(writePath, path)
      ) {
        touched = true;
        break;
      }
    }
    if (!touched) {
      const reactiveWrites = [
        ...(tx.getReactivityLog?.().writes ?? []),
        ...(tx.getReactivityLog?.().attemptedWrites ?? []),
      ];
      touched = reactiveWrites.some((write) => {
        if (write.space !== target.space) return false;
        if (write.id !== target.id) return false;
        if (normalizeCellScope(write.scope) !== target.scope) return false;
        const writePath = canonicalizeLogicalPath(write.path);
        return concretePathHasPrefix(path, writePath) ||
          concretePathHasPrefix(writePath, path);
      });
    }
    if (!touched) {
      return false;
    }
    const pathTarget = { ...target, path };
    const written = writeValueForTarget(tx, pathTarget);
    const value = written !== undefined ? written : (() => {
      try {
        return tx.readValueOrThrow(pathTarget, {
          meta: INTERNAL_VERIFIER_META,
        });
      } catch {
        return undefined;
      }
    })();
    if (path.length === 0) {
      return value === undefined ||
        wildcardPolicyMatchesValue(tx, target, schema, value);
    }
    if (value === undefined) {
      return previousWriteValueForTarget(tx, pathTarget) !== undefined;
    }
    return value !== undefined &&
      wildcardPolicyMatchesValue(tx, target, schema, value);
  }

  const exactAttemptedPaths = [
    ...(tx.getReactivityLog?.().writes ?? []),
    ...(tx.getReactivityLog?.().attemptedWrites ?? []),
  ].map((write) => ({
    write,
    path: canonicalizeLogicalPath(write.path),
  })).filter(({ write, path: writePath }) =>
    write.space === target.space &&
    write.id === target.id &&
    normalizeCellScope(write.scope) === target.scope &&
    pathPatternMatches(path, writePath) &&
    !writePath.includes("*")
  ).map(({ path }) => path);
  if (exactAttemptedPaths.length > 0) {
    return exactAttemptedPaths.some((writePath) =>
      wildcardPolicyMatchesValue(
        tx,
        target,
        schema,
        writeValueForTarget(tx, { ...target, path: writePath }),
      )
    );
  }

  const writes = [...(tx.getWriteDetails?.(target.space) ?? [])];
  let sawTargetWrite = false;
  const prefix = path.slice(0, wildcardIndex);
  for (const write of writes) {
    if (write.address.id !== target.id) continue;
    if (normalizeCellScope(write.address.scope) !== target.scope) continue;
    if (write.address.path[0] !== "value") continue;
    sawTargetWrite = true;
    const writePath = write.address.path.slice(1).map((entry) => String(entry));
    if (pathPatternMatches(path, writePath)) {
      return !deepEqual(write.value, write.previousValue) &&
        wildcardPolicyMatchesValue(tx, target, schema, write.value);
    }
    if (concretePathHasPrefix(prefix, writePath)) {
      const relativePrefix = prefix.slice(writePath.length);
      const value = getValueAtPath(write.value, relativePrefix);
      const previousValue = write.previousValue === undefined
        ? undefined
        : getValueAtPath(write.previousValue, relativePrefix);
      const matches = changedValuesAtPatternPath(
        value,
        previousValue,
        path.slice(wildcardIndex),
      );
      if (
        matches.some((match) =>
          wildcardPolicyMatchesValue(tx, target, schema, match)
        )
      ) {
        return true;
      }
    }
  }

  if (sawTargetWrite) {
    return false;
  }

  const value = writeValueForTarget(tx, { ...target, path: prefix });
  if (value === undefined) {
    return false;
  }
  const matches = valuesAtPatternPath(value, path.slice(wildcardIndex));
  return matches.some((match) =>
    wildcardPolicyMatchesValue(tx, target, schema, match)
  );
};

const verifyInputRequirements = (
  tx: IExtendedStorageTransaction,
  schema: JSONSchema,
  target: {
    space: MemorySpace;
    id: URI;
    scope: ReturnType<typeof normalizeCellScope>;
  },
  // Resolves the implementation identity that authored the schema write-policy
  // input covering a given field path (the longest-prefix schema input on this
  // cell). `writeAuthorizedBy` is verified per field against its authoring
  // identity, so two protected fields on the same cell written under different
  // identities are each checked against the correct one.
  identityForPath?: (
    path: readonly string[],
  ) => ImplementationIdentity | undefined,
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
    if (
      !ifcEntryAppliesToAttemptedWrite(tx, target, entry.path, entry.schema)
    ) {
      continue;
    }
    const ifc = isRecord(entry.schema) ? entry.schema.ifc : undefined;
    const unsupportedTrustSensitive = unsupportedTrustSensitiveReason(
      entry.schema,
      entry.path,
    );
    if (unsupportedTrustSensitive !== undefined) {
      return unsupportedTrustSensitive;
    }
    const currentPrincipalFailure = currentPrincipalIntegrityReason(
      tx,
      entry.schema,
      entry.path,
    );
    if (currentPrincipalFailure !== undefined) {
      return currentPrincipalFailure;
    }
    const writeAuthorizedByFailure = writeAuthorizedByReason(
      tx,
      entry.schema,
      entry.path,
      identityForPath?.(entry.path),
    );
    const setupProjection = setupProjectionSourceMatchesValue(
      tx,
      target,
      entry.path,
    ) || writeIsPatternSetupInitialization(tx, target, entry.path);
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

    // undefined means no ceiling; a declared (even empty) ceiling is enforced.
    // An empty ceiling is "public only": any consumed confidential atom fails.
    const maxConfidentiality = ifc?.maxConfidentiality;
    if (maxConfidentiality !== undefined && consumed.length > 0) {
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
    if (
      !ifcEntryAppliesToAttemptedWrite(tx, target, entry.path, entry.schema)
    ) {
      continue;
    }
    if (setupProjectionSourceMatchesValue(tx, target, entry.path)) {
      continue;
    }
    if (
      writeInstallsInitialSchemaDefault(tx, target, entry.path, entry.schema)
    ) {
      continue;
    }
    const matched = tx.getCfcState().writePolicyInputs.some((input) =>
      input.kind === "trusted-event" &&
      input.target.space === target.space &&
      input.target.id === target.id &&
      input.target.scope === target.scope &&
      pathPatternMatches(entry.path, input.target.path) &&
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
    // Only verify a claim whose target path the transaction actually wrote.
    // Without this gate an untouched entry compares undefined to undefined and
    // passes vacuously, accepting the claim (and copying its label) unverified.
    if (
      !ifcEntryAppliesToAttemptedWrite(tx, target, entry.path, entry.schema)
    ) {
      continue;
    }
    // Array-item (wildcard) exactCopyOf is unsupported: the per-path value
    // reconstruction matches segments literally, so "*" never resolves against a
    // concrete write and the comparison would pass vacuously. Fail closed
    // (audit W2.15).
    if (entry.path.includes("*") || sourcePath.includes("*")) {
      return `exactCopyOf under an array wildcard is unsupported at /${
        entry.path.join("/")
      }`;
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
  tx: IExtendedStorageTransaction,
  schema: JSONSchema,
  schemaLabel: IFCLabel,
  sourceEntryLabels?: Map<string, IFCLabel>,
): IFCLabel => {
  const ifc = isRecord(schema) ? schema.ifc : undefined;
  const actingPrincipal = tx.getCfcState().trustSnapshot?.actingPrincipal;
  const copiedInputLabel = sourceEntryLabels && exactCopySourcePath(schema)
    ? sourceEntryLabels.get(pathKey(exactCopySourcePath(schema)!))
    : undefined;
  return {
    confidentiality: mergeLabelValues(
      schemaLabel.confidentiality,
      copiedInputLabel?.confidentiality,
    ),
    integrity: mergeLabelValues(
      resolveCurrentPrincipalLabelValues(
        schemaLabel.integrity,
        actingPrincipal,
      ),
      copiedInputLabel?.integrity,
      resolveCurrentPrincipalLabelValues(
        Array.isArray(ifc?.addIntegrity) ? ifc.addIntegrity : undefined,
        actingPrincipal,
      ),
    ),
  };
};

// Integrity atom families that are concrete evidence minted only by trusted
// runtime code (the InjectionSafe sanitizer, code-identity/provenance minting,
// the harness prompt-slot binder). Untrusted schema authors must not be able to
// self-attach them and then satisfy a requiredIntegrity gate or the
// prompt-injection screen (audit S4). The current-principal claim family
// (authored-by / represents-principal) is gated separately by
// currentPrincipalIntegrityReason and intentionally not listed here.
const RUNTIME_MINTED_INTEGRITY_ATOM_TYPES = new Set<string>([
  CFC_ATOM_TYPE.InjectionSafe,
  CFC_ATOM_TYPE.Builtin,
  CFC_ATOM_TYPE.LinkReference,
  CFC_ATOM_TYPE.Origin,
  CFC_ATOM_TYPE.PromptSlotBound,
  CFC_ATOM_TYPE.PromptSlotInfluence,
  CFC_ATOM_TYPE.UserSurfaceInput,
]);

const isRuntimeMintedIntegrityAtom = (atom: unknown): boolean =>
  isRecord(atom) && typeof atom.type === "string" &&
  RUNTIME_MINTED_INTEGRITY_ATOM_TYPES.has(atom.type);

/**
 * Drops runtime-minted evidence atoms from a persisted label's integrity unless
 * the write was authored by a trusted builtin (the sanitizer, compile cache,
 * and link/provenance minting all run as builtins). Verified pattern code and
 * unattributed writes may not mint evidence (audit S4).
 */
const gateRuntimeMintedIntegrity = (
  label: IFCLabel,
  authoringIdentity: ImplementationIdentity | undefined,
): IFCLabel => {
  if (authoringIdentity?.kind === "builtin") {
    return label;
  }
  const integrity = label.integrity;
  if (integrity === undefined || integrity.length === 0) {
    return label;
  }
  const filtered = integrity.filter((atom) =>
    !isRuntimeMintedIntegrityAtom(atom)
  );
  if (filtered.length === integrity.length) {
    return label;
  }
  return {
    ...label,
    integrity: filtered.length > 0 ? filtered : undefined,
  };
};

const persistedLabelFromSchemaAtPath = (
  tx: IExtendedStorageTransaction,
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
  return derivePersistedLabel(tx, match.schema, match.label, entryLabels);
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
  type: CFC_ATOM_TYPE.LinkReference,
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

const rootLabelFromSchema = (
  tx: IExtendedStorageTransaction,
  schema: JSONSchema | undefined,
): IFCLabel => {
  if (schema === undefined) {
    return {};
  }
  const root = walkIfcSchema(schema).find((entry) => entry.path.length === 0);
  return root === undefined
    ? {}
    : derivePersistedLabel(tx, root.schema, root.label);
};

const derivePersistedLinkLabel = (
  tx: IExtendedStorageTransaction,
  input: LinkWritePolicyInput,
  candidateSchemas: ReadonlyMap<string, JSONSchema>,
  authoringIdentity: ImplementationIdentity | undefined,
): { label?: IFCLabel; reason?: string } => {
  const sourceMetadata = storedMetadataFor(
    tx,
    input.source.space,
    input.source.id as URI,
    input.source.scope,
    "application/json",
  );
  const pendingSourceSchema = candidateSchemas.get(targetKey(input.source));
  const pendingSourceLabel = pendingSourceSchema !== undefined
    ? persistedLabelFromSchemaAtPath(
      tx,
      pendingSourceSchema,
      input.source.path,
    )
    : undefined;
  const linkSchemaLabel = rootLabelFromSchema(tx, input.linkSchema);
  const hasCarriedLabel =
    input.cfcLabelView?.entries.some((entry) => hasLabelValues(entry.label)) ??
      false;
  if (
    sourceMetadata === undefined && pendingSourceSchema === undefined &&
    !hasLabelValues(linkSchemaLabel) && !hasCarriedLabel
  ) {
    return {
      reason: `missing link source metadata for ${input.target.id} at /${
        input.target.path.join("/")
      }`,
    };
  }
  if (
    sourceMetadata === undefined && pendingSourceSchema === undefined &&
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
  // The source/link-schema integrity is author-influenceable (a link value can
  // carry a forged link schema or label view). Gate runtime-minted evidence
  // atoms out of it unless a trusted builtin authored the link write, THEN add
  // the runtime-minted LinkReference — which is added here, never filtered, and
  // is the only evidence atom a link write legitimately mints (audit S4 review).
  const gatedIntegrity = gateRuntimeMintedIntegrity(
    {
      integrity: mergeLabelValues(
        sourceLabel.integrity,
        linkSchemaLabel.integrity,
      ),
    },
    authoringIdentity,
  ).integrity;
  const label: IFCLabel = {
    confidentiality: mergeLabelValues(
      sourceLabel.confidentiality,
      linkSchemaLabel.confidentiality,
    ),
    integrity: mergeLabelValues(
      gatedIntegrity,
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
  // Defense in depth: the content address must be the canonical hash of the
  // schema it names. A mismatch is a programming error in the caller; refuse it
  // rather than write a self-inconsistent cid: document (audit S5).
  const actualHash = internSchemaAsTaggedHashString(schema);
  if (actualHash !== schemaHash) {
    throw new Error(
      `cid schema document hash mismatch: claimed ${schemaHash}, actual ${actualHash}`,
    );
  }
  const id = `cid:${schemaHash}`;
  // Do not pre-read the content-addressed schema document here. A read-before-
  // write can make otherwise idempotent schema persistence fail with stale-read
  // conflicts when another transaction already installed the same CID.
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

// Exported for unit testing of the read-side content-address verification (S5).
export const loadSchemaDocument = (
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
  const schema = existing.value as JSONSchema;
  // The cid: document is content-addressed but stored on an unverified write
  // path that any same-space writer can reach. Re-derive its canonical hash and
  // reject a value that does not match the address it was loaded from; the
  // loaded schema drives label derivation for other principals' writes, so a
  // poisoned schema must not be trusted (audit S5).
  const actualHash = internSchemaAsTaggedHashString(schema);
  if (actualHash !== schemaHash) {
    throw new Error(
      `cid schema document hash mismatch for ${schemaHash}: content hashes to ${actualHash}`,
    );
  }
  return schema;
};

export const prepareBoundaryCommit = (
  tx: IExtendedStorageTransaction,
): string[] => {
  const reasons: string[] = [];
  const state = tx.getCfcState();
  const identityForInput = (
    input: WritePolicyInput,
  ): ImplementationIdentity | undefined =>
    // Honor the identity captured when the input was recorded, even when that
    // is undefined. Falling back to the transaction's current identity would
    // let a write recorded before any identity was set borrow a trusted
    // identity established later in the same transaction (audit S13). Every
    // recorded input is registered in this map, so a missing key cannot occur
    // for a real input; an unattributed write must fail closed.
    state.writePolicyInputIdentities.get(input);
  const candidates = candidateSchemasByTarget(
    state.writePolicyInputs,
    identityForInput,
  );
  const writeAuthorIdentities = writePolicyIdentitiesByTarget(
    state.writePolicyInputs,
    identityForInput,
  );
  const linkWrites = linkWritesByTarget(state.writePolicyInputs);
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
        mergedSchema =
          schemasEqualIgnoringWriterBundleIds(storedSchema, schema) ||
            storedSchemaCoversCandidateEnvelope(storedSchema, schema)
            ? storedSchema
            : mergeCfcSchemaEnvelopes(storedSchema, schema);
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
      (path) => identityForSchemaPath(writeAuthorIdentities.get(key), path),
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
    const mergedSchemaEntrySchemas = new Map<string, JSONSchema>(
      mergedSchemaEntries.map((entry) => [
        pathKey(entry.path),
        entry.schema,
      ]),
    );
    const existingConfidentialityByPath = new Map<string, readonly unknown[]>(
      (existing?.labelMap.entries ?? [])
        .filter((e) => (e.label.confidentiality?.length ?? 0) > 0)
        .map((e) => [
          pathKey(canonicalizeLogicalPath(e.path)),
          e.label.confidentiality as readonly unknown[],
        ]),
    );
    const persistedLabelEntries = mergedSchemaEntries.flatMap((entry) => {
      if (
        !ifcEntryAppliesToAttemptedWrite(tx, target, entry.path, entry.schema)
      ) {
        return [];
      }
      const derived = gateRuntimeMintedIntegrity(
        derivePersistedLabel(
          tx,
          entry.schema,
          entry.label,
          mergedSchemaEntryLabels,
        ),
        identityForSchemaPath(writeAuthorIdentities.get(key), entry.path),
      );
      // Store confidentiality is grow-only (§8.12.1): a re-write of a path must
      // not drop confidentiality the labelMap already carried beyond the schema
      // (e.g. link-derived or carried-view atoms). Merge the prior stored
      // confidentiality into the freshly derived label. Integrity is left as
      // derived (freshly gated) — it must not regrow (audit S9).
      const prior = existingConfidentialityByPath.get(pathKey(entry.path));
      const label = prior !== undefined
        ? {
          ...derived,
          confidentiality: mergeLabelValues(derived.confidentiality, prior),
        }
        : derived;
      return hasLabelValues(label) || hasPersistedPolicyClaim(entry.schema)
        ? [{
          path: entry.path,
          label,
        }]
        : [];
    });
    const persistedLabelEntryKeys = new Set(
      persistedLabelEntries.map((entry) => pathKey(entry.path)),
    );
    const currentLinkWritePaths = new Set(
      linkWriteInputs.map((input) => pathKey(input.target.path)),
    );
    for (const entry of existing?.labelMap.entries ?? []) {
      const entryPath = canonicalizeLogicalPath(entry.path);
      const key = pathKey(entryPath);
      if (persistedLabelEntryKeys.has(key) || currentLinkWritePaths.has(key)) {
        continue;
      }
      const schemaEntry = mergedSchemaEntrySchemas.get(key);
      if (
        hasLabelValues(entry.label) ||
        (schemaEntry !== undefined && hasPersistedPolicyClaim(schemaEntry))
      ) {
        persistedLabelEntries.push({
          path: entryPath,
          label: cloneLabel(entry.label),
        });
      }
    }
    for (const input of linkWriteInputs) {
      const linkIdentity = identityForInput(input);
      const result = derivePersistedLinkLabel(
        tx,
        input,
        candidates,
        linkIdentity,
      );
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
        // The carried label view is author-influenceable; gate runtime-minted
        // evidence atoms unless a builtin authored the link write (audit S4
        // review).
        persistedLabelEntries.push({
          path: [
            ...targetPath,
            ...canonicalizeLogicalPath(entry.path),
          ],
          label: gateRuntimeMintedIntegrity(
            cloneLabel(entry.label),
            linkIdentity,
          ),
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
      schemaAndHash.taggedHashString,
      schemaAndHash.schema,
    );
    const metadata: CfcMetadata = {
      version: 1,
      schemaHash: schemaAndHash.taggedHashString,
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
