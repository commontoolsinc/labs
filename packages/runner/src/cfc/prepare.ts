import {
  CFC_ATOM_TYPE,
  CFC_COMPILED_BY_ATOM_PREFIX,
  cfcAtom,
} from "@commonfabric/api/cfc";
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
import type { FabricValue } from "@commonfabric/api";
import type { MemorySpace, URI } from "@commonfabric/memory/interface";
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
  isLinkResolutionProbe,
  isSchedulerDependencyRead,
} from "../storage/reactivity-log.ts";
import {
  isPrimitiveCellLink,
  isWriteRedirectLink,
  parseLink,
} from "../link-utils.ts";
import { getValueAtPath, setValueAtPath } from "../path-utils.ts";
import { encodePointer } from "../../../memory/v2/path.ts";
import { ContextualFlowControl } from "../cfc.ts";
import { atomPropagationClass } from "./atom-classes.ts";
import { canonicalizeLogicalPath } from "./canonical.ts";
import { clauseAlternatives, isOrClause, normalizeClause } from "./clause.ts";
import { externalIngestStamp } from "./external-ingest.ts";
import {
  atomsOutsideCeiling,
  cfcIntegritySatisfiesFloor,
  uniqueCfcAtoms,
} from "./observation.ts";
import { mergeCfcSchemaEnvelopes } from "./schema-merge.ts";
import {
  CFC_STRUCTURAL_PROVENANCE_SEED_MATERIALIZATION,
  CFC_STRUCTURAL_PROVENANCE_SETUP_PROJECTION,
  type CfcMetadata,
  type IFCLabel,
  type ImplementationIdentity,
  type LabelMapEntry,
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
  // Per-component longest-prefix resolution: within one origin component a
  // more specific entry replaces its ancestor (§4.6.3 replace-down), but
  // components layer independently, so the effective label is the join of
  // each component's most-specific ancestor-or-equal entry. Legacy entries
  // (no origin) form one combined component, preserving the historical
  // single-map resolution for pre-component metadata.
  const matches = new Map<
    string,
    { path: readonly string[]; label: IFCLabel }
  >();
  for (const entry of metadata.labelMap.entries) {
    if (!isPrefix(entry.path, path)) {
      continue;
    }
    // Structure entries label the container's SHAPE: they apply when the
    // container node itself is observed (read at exactly the entry path),
    // not to reads strictly below it — slot pointer reads and dereferences
    // are pointer handling, and tainting them with shape would re-smear
    // the pointwise split the structure component exists to preserve.
    if (entry.origin === "structure" && entry.path.length !== path.length) {
      continue;
    }
    const component = entry.origin ?? "legacy";
    const match = matches.get(component);
    if (match === undefined || match.path.length < entry.path.length) {
      matches.set(component, entry);
    } else if (match.path.length === entry.path.length) {
      // Two equally specific prefixes of one queried path are the same
      // path; duplicate (path, origin) entries shouldn't survive
      // coalescing, but join defensively rather than drop one.
      matches.set(component, {
        path: match.path,
        label: mergeLabels(match.label, entry.label),
      });
    }
  }
  if (matches.size === 0) {
    return undefined;
  }
  let joined: IFCLabel | undefined;
  for (const match of matches.values()) {
    joined = joined === undefined
      ? match.label
      : mergeLabels(joined, match.label);
  }
  return joined;
};

// Effective label of a consumed read. A recursive read materializes the
// whole subtree under `path`, so its label is the most-specific
// ancestor-or-equal entry (§4.6.3 replace-down resolution) joined with
// every labelMap entry strictly below the read path — an ancestor read
// must not shadow descendant labels out of the consumed set (audit S7;
// e.g. `getRaw()` records one recursive root read and hands over labeled
// children with no further journal entries). Non-recursive reads observe
// only the node itself and keep ancestor-or-equal resolution.
const effectiveReadLabel = (
  metadata: CfcMetadata | undefined,
  path: readonly string[],
  nonRecursive: boolean | undefined,
  options?: { excludeLinkOrigin?: boolean },
): IFCLabel | undefined => {
  // `excludeLinkOrigin` implements the SC-8 pointer/content split for flow
  // derivation: link-origin entries label the *reference* as transport (so
  // links carry their target's sensitivity to wherever they land), but
  // reading a pointer is not reading the target's content. Flow taint
  // arrives when the target is actually dereferenced — which appears as an
  // ordinary read of the target document and resolves the target's own
  // entries. Without this split, every routing transaction (the list
  // builtins' coordinators, anything shuffling references) joins the labels
  // of everything it passes along, and blind passing stops being cheap.
  // Legacy (untagged) entries may conflate pointer and content labels and
  // stay included — over-taint, fail-safe.
  const excludeLink = options?.excludeLinkOrigin === true;
  const view = excludeLink && metadata !== undefined
    ? {
      ...metadata,
      labelMap: {
        ...metadata.labelMap,
        entries: metadata.labelMap.entries.filter((entry) =>
          entry.origin !== "link"
        ),
      },
    }
    : metadata;
  const base = labelAtPath(view, path);
  if (nonRecursive === true || view === undefined) {
    return base;
  }
  let joined = base;
  for (const entry of view.labelMap.entries) {
    if (entry.path.length <= path.length) continue;
    if (!isPrefix(path, entry.path)) continue;
    joined = mergeLabels(joined, entry.label);
  }
  return joined;
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
  //
  // Derived/structure (flow-label) entries are the exception: they record
  // taint, not authored policy. A plain value write replacing a
  // flow-labeled path is an ordinary overwrite (the flow components are
  // replaced/cleared by the flow stage), so it must not demand a schema
  // write-policy input.
  return metadata.labelMap.entries.some((entry) =>
    entry.origin !== "derived" && entry.origin !== "structure" &&
    (isPrefix(entry.path, logicalPath) || isPrefix(logicalPath, entry.path))
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
  // Identity arm (fail closed): the claim's content-addressed moduleIdentity
  // must match the live identity's. The legacy bundleId-only arm (stored
  // pre-#4009 claims) retired with the legacy read path (identity E5,
  // data-wipe decision): a claim without a moduleIdentity is rejected.
  const identityArmMatches =
    typeof bindingIdentity.moduleIdentity === "string" &&
    typeof identity.moduleIdentity === "string" &&
    identity.moduleIdentity.length > 0 &&
    identity.moduleIdentity === bindingIdentity.moduleIdentity;
  if (
    !identityArmMatches ||
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
): {
  moduleIdentity?: string;
  file: string;
  path: string[];
} | undefined => {
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
    ...(typeof identity.moduleIdentity === "string"
      ? { moduleIdentity: identity.moduleIdentity }
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
// `writeAuthorizedBy` gates *modification* of an existing owner-protected
// value (§8.15.10); the runtime materializing a runtime-constructed cell's
// initial value (`Writable(initialValue)` in a lift/handler frame — the CTS
// wraps derived initializers this way) is the trusted initialization step
// (§8.15.4), like the projection-marker case above. It is not (and cannot be)
// the claim-referenced edit handler. Recognize it by BOTH signals together:
// the seed-materialization marker — recorded ONLY by the runtime's
// cell-serialization path (data-updating.ts BRANCH_CELL), never reachable
// from arbitrary `cell.set` — AND the write creating the doc (a root-level
// write whose previousValue is undefined, the same signal
// `derivePersistedLinkLabel` uses for same-tx child docs). Edits to existing
// docs and direct unmarked writes stay fully enforced; ownerPrincipal /
// integrity minting is gated separately (`currentPrincipalIntegrityReason`
// runs before this).
const writeIsSeedMaterialization = (
  tx: IExtendedStorageTransaction,
  target: {
    space: MemorySpace;
    id: URI;
    scope: ReturnType<typeof normalizeCellScope>;
  },
): boolean => {
  const marked = tx.getCfcState().writePolicyInputs.some((input) =>
    input.kind === "structural-provenance" &&
    input.claim === CFC_STRUCTURAL_PROVENANCE_SEED_MATERIALIZATION &&
    input.sources.some((source) =>
      source.space === target.space && source.id === target.id &&
      normalizeCellScope(source.scope) === target.scope
    )
  );
  if (!marked) {
    return false;
  }
  return [...(tx.getWriteDetails?.(target.space) ?? [])].some((detail) =>
    detail.address.id === target.id &&
    normalizeCellScope(detail.address.scope) === target.scope &&
    detail.address.path.length <= 1 &&
    detail.previousValue === undefined
  );
};

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
        : schemasEqualIgnoringWriterStamp(existing, candidate)
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

// Strip the writer-identity provenance stamp from a binding's `{ file, path }`
// so schemas compare by BINDING, ignoring which verified module produced the
// input. New claims stamp the content-addressed `moduleIdentity`, but
// pre-migration stored/fixture claims may carry a legacy `bundleId` (inert
// under verification, which reads `moduleIdentity`) — strip both so a
// surviving `bundleId` can't manufacture a false schema difference.
const stripWriterIdentityStamp = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(stripWriterIdentityStamp);
  }
  if (!isRecord(value)) {
    return value;
  }

  const next: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (
      (key === "bundleId" || key === "moduleIdentity") &&
      typeof value.file === "string"
    ) {
      continue;
    }
    next[key] = stripWriterIdentityStamp(entry);
  }
  return next;
};

const schemasEqualIgnoringWriterStamp = (
  left: JSONSchema,
  right: JSONSchema,
): boolean =>
  deepEqual(
    stripWriterIdentityStamp(left),
    stripWriterIdentityStamp(right),
  );

const storedSchemaCoversCandidateEnvelope = (
  stored: JSONSchema | undefined,
  candidate: JSONSchema | undefined,
): boolean => {
  if (stored === undefined || candidate === undefined) {
    return false;
  }
  if (schemasEqualIgnoringWriterStamp(stored, candidate)) {
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
  if (!identity || identity.kind !== "verified") {
    return schema;
  }
  const moduleIdentity = typeof identity.moduleIdentity === "string" &&
      identity.moduleIdentity.length > 0
    ? identity.moduleIdentity
    : undefined;
  if (!moduleIdentity) {
    return schema;
  }
  // Only the function NAMED by a binding may stamp that binding's provenance
  // moduleIdentity. The writer's own binding (sourceFile + bindingPath) must
  // match the claim's binding (file + path); otherwise a foreign writer that
  // merely *initializes* the protected field — e.g. profile-create's
  // `submitProfileCreation` seeding a freshly `inSpace`'d ProfileHome whose
  // `elements` bind to profile-home's `mutateElements` — would stamp ITS module
  // identity onto someone else's binding. That stamp can never match the live
  // bound writer at verification time (CT-1740: seed stamped profile-create's
  // id, the card-add write stamped profile-home's → "writeAuthorizedBy must
  // remain stable"). Leaving the foreign-seeded claim unstamped lets the
  // genuine bound writer stamp it (one-stamped/one-unstamped reconciles).
  const writerFile = normalizeIdentitySource(identity.sourceFile);
  const writerPath = identity.bindingPath;
  return rebindWriteAuthorizedByClaimsInner(
    schema,
    { moduleIdentity, writerFile, writerPath },
  ) as JSONSchema;
};

const rebindWriteAuthorizedByClaimsInner = (
  value: unknown,
  ids: {
    moduleIdentity?: string;
    writerFile?: string;
    writerPath?: readonly string[];
  },
): unknown => {
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((entry) => {
      const rebound = rebindWriteAuthorizedByClaimsInner(entry, ids);
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
    const rebound = rebindWriteAuthorizedByClaimsInner(entry, ids);
    changed ||= rebound !== entry;
    next[key] = rebound;
  }

  if (isRecord(value.ifc) && isRecord(value.ifc.writeAuthorizedBy)) {
    const claim = value.ifc.writeAuthorizedBy;
    // Stamp an unstamped claim with the content-addressed moduleIdentity —
    // the only verification arm (the legacy bundleId arm retired with the
    // legacy read path, identity E5). A claim carrying a legacy bundleId
    // stamp is NOT unstamped: it is recognized as stamped — and unservable —
    // so it fails closed at verification instead of being silently re-bound
    // to whichever verified writer touches it next.
    const bindingFile = isRecord(claim.__ctWriterIdentityOf) &&
        typeof claim.__ctWriterIdentityOf.file === "string"
      ? normalizeIdentitySource(claim.__ctWriterIdentityOf.file)
      : undefined;
    const bindingPath = isRecord(claim.__ctWriterIdentityOf) &&
        Array.isArray(claim.__ctWriterIdentityOf.path)
      ? claim.__ctWriterIdentityOf.path as readonly string[]
      : undefined;
    // The writer must BE the function named by the binding (see the binding
    // match rationale in rebindWriteAuthorizedByClaims). When we can identify
    // both bindings, require they match; a mismatch means a foreign writer is
    // initializing the field, so we leave the claim unstamped.
    const writerOwnsBinding = ids.writerFile !== undefined &&
      ids.writerPath !== undefined && bindingFile !== undefined &&
      bindingPath !== undefined &&
      ids.writerFile === bindingFile &&
      arraysEqual(ids.writerPath, bindingPath);
    if (
      isRecord(claim.__ctWriterIdentityOf) &&
      claim.__ctWriterIdentityOf.bundleId === undefined &&
      claim.__ctWriterIdentityOf.moduleIdentity === undefined &&
      writerOwnsBinding
    ) {
      const nextIfc = { ...value.ifc };
      nextIfc.writeAuthorizedBy = {
        ...claim,
        __ctWriterIdentityOf: {
          ...claim.__ctWriterIdentityOf,
          ...(ids.moduleIdentity ? { moduleIdentity: ids.moduleIdentity } : {}),
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
    // Last written value per path (pathKey), for flow-label value-shape
    // classification (pure link structure is not stamped).
    valuesByPath: Map<string, unknown>;
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
      valuesByPath: Map<string, unknown>;
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
      const rawPath = write.address.path;
      const writePath = canonicalizeLogicalPath(rawPath);
      // The `cfc`/`source` surface exclusions key on the RAW storage path:
      // the runtime-internal surfaces are document-root siblings of `value`
      // (raw `["cfc", ...]`/`["source", ...]`), while user fields of the
      // same names live under `["value", ...]` and canonicalize to identical
      // logical paths. Keying on the canonical path would let a user write
      // to `value.source` dodge schema write policy and flow-label
      // attachment (#4011 review). The link-valued `internal` exclusion
      // stays canonical on purpose: it covers the runtime's link plumbing
      // both at the root surface and inside process-doc values; link writes
      // carry their labels via the link-write machinery, not here.
      if (
        write.address.id.startsWith("cid:") ||
        rawPath[0] === "cfc" ||
        rawPath[0] === "source" ||
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
        existing.valuesByPath.set(pathKey(writePath), write.value);
      } else {
        result.set(key, {
          space: write.address.space,
          scope: normalizeCellScope(write.address.scope),
          id: write.address.id as URI,
          type: (write.address.type ?? "application/json") as MediaType,
          paths: [writePath],
          valuesByPath: new Map([[pathKey(writePath), write.value]]),
        });
      }
    }
  }
  return result;
};

// ---------------------------------------------------------------------------
// S16 flow labels (default transition): one conservative confidentiality join
// per transaction — everything the transaction observed taints everything it
// wrote (§8.9.2/§8.9.3 collapsed to tx granularity). Reads of runtime-internal
// surfaces (verifier reads, `cid:` schema docs, `["cfc"]`/`["source"]` paths)
// are excluded, mirroring the write-side exclusions.

// Keyed on the RAW storage path: the runtime-internal surfaces are
// document-root siblings of `value` (raw `["cfc", ...]`/`["source", ...]`),
// while user fields of the same names live under `["value", ...]` and
// canonicalize to identical logical paths. Keying on the canonical path
// would drop reads of a user `value.source` field from the taint join
// (#4011 review). Exported for `addCfcTriggerReads`, which applies it at
// insertion time — the only point where the raw notification path exists
// (trigger reads are stored canonicalized).
export const flowReadExcluded = (
  id: string,
  rawPath: readonly string[],
): boolean =>
  id.startsWith("cid:") ||
  rawPath[0] === "cfc" ||
  rawPath[0] === "source";

// A written value made entirely of references (links at every leaf, or
// empty structure) carries no readable content of its own: the per-slot
// link entries label each reference precisely, so stamping the covering
// per-tx join on the shell would smear unrelated taint across everything
// a routing transaction shuffles — and feed a reconciler's own output
// taint back into its next run's J when it reads its previous output. Any
// non-link leaf (string, number, boolean, null) makes the value content.
// Such writes get `structure` (shape-only) stamps instead of covering
// `derived` ones — see `pureLinkContainerPaths`.
const isPureLinkStructure = (value: unknown): boolean => {
  if (value === undefined) return true;
  if (isPrimitiveCellLink(value)) return true;
  if (Array.isArray(value)) {
    return value.every((member) => isPureLinkStructure(member));
  }
  if (isRecord(value)) {
    return Object.values(value).every((member) => isPureLinkStructure(member));
  }
  return false;
};

// Container nodes (arrays/records — including empty ones) inside a
// pure-link-structure value. Their SHAPE — membership, key set, order,
// length — is information the writing transaction computed (a filter's
// predicate decides which slots survive, §8.5.6.1/SC-7), so each container
// node gets an exact-path `structure` stamp with the per-tx join. Bare
// link leaves get nothing: a pointer read at the leaf's own path is blind
// passing, and the link entry already carries the target's transport
// label. `undefined` (a removal) gets nothing either — "this path was
// cleared" stays in the SC-4 existence-channel residual.
const pureLinkContainerPaths = (
  value: unknown,
  path: readonly string[],
  out: (readonly string[])[],
): void => {
  if (isPrimitiveCellLink(value) || value === undefined) {
    return;
  }
  if (Array.isArray(value)) {
    out.push(path);
    value.forEach((member, index) =>
      pureLinkContainerPaths(member, [...path, String(index)], out)
    );
    return;
  }
  if (isRecord(value)) {
    out.push(path);
    for (const [key, member] of Object.entries(value)) {
      pureLinkContainerPaths(member, [...path, key], out);
    }
  }
};

const forEachFlowObservation = (
  tx: IExtendedStorageTransaction,
  consume: (
    space: MemorySpace,
    id: URI,
    scope: ReturnType<typeof normalizeCellScope>,
    type: MediaType,
    logicalPath: readonly string[],
    nonRecursive: boolean | undefined,
  ) => boolean,
): boolean => {
  for (const read of tx.getReadActivities?.() ?? []) {
    if (isInternalVerifierRead(read.meta)) {
      continue;
    }
    // Link-resolution probes are shape observations of link topology, not
    // content reads (SC-8): following a reference must not taint with the
    // target's content label unless something actually reads its value
    // (which appears as an ordinary, unmarked read).
    if (isLinkResolutionProbe(read.meta)) {
      continue;
    }
    // Scheduler dependency seeding materializes declared deps so the
    // reactivity log covers them; it is scheduling machinery, not handler
    // consumption (§8.10.1) — the action body's own reads carry the taint.
    if (isSchedulerDependencyRead(read.meta)) {
      continue;
    }
    if (flowReadExcluded(read.id, read.path)) {
      continue;
    }
    const logicalPath = canonicalizeLogicalPath(read.path);
    if (
      consume(
        read.space,
        read.id as URI,
        normalizeCellScope(read.scope),
        (read.type ?? "application/json") as MediaType,
        logicalPath,
        read.nonRecursive,
      )
    ) {
      return true;
    }
  }
  // Dereference traces deliberately do NOT contribute: following a
  // reference is a shape observation of the link (the resolution step), not
  // a read of the target's content. When a transaction actually reads a
  // value through a link, the target read appears in the journal as an
  // ordinary read activity and is covered above; counting trace ends too
  // would taint identity-only link handling (e.g. the list builtins'
  // coordinators resolving element links they never read) with the target's
  // full label — exactly the blind-passing idiom flow labels must keep
  // cheap (design D4, SC-8).
  // Trigger reads (§8.9.2): the addresses whose invalidating writes
  // scheduled this run. The decision to run now was influenced by their
  // values even when this run's branch never re-reads them — without this,
  // "dep changed" leaks one bit per change through the timing/existence of
  // writes the rerun makes. Runtime-surface addresses were already dropped
  // by `addCfcTriggerReads` (which sees the raw notification path before
  // canonicalization and applies `flowReadExcluded`); the `cid:` check
  // stays as defense in depth for trigger entries that arrive by other
  // construction paths.
  for (const trigger of tx.getCfcState().triggerReads) {
    if (trigger.id.startsWith("cid:")) {
      continue;
    }
    if (
      consume(
        trigger.space,
        trigger.id as URI,
        normalizeCellScope(trigger.scope),
        "application/json",
        trigger.path,
        false,
      )
    ) {
      return true;
    }
  }
  // Trigger reads (§8.9.2): the addresses whose invalidating writes
  // scheduled this run. The decision to run now was influenced by their
  // values even when this run's branch never re-reads them — without this,
  // "dep changed" leaks one bit per change through the timing/existence of
  // writes the rerun makes. Runtime-surface addresses were already dropped
  // by `addCfcTriggerReads` (which sees the raw notification path before
  // canonicalization), so no `flowReadExcluded` check here — the stored
  // path is canonical, where a user `value.source` is indistinguishable
  // from the raw `["source"]` surface.
  for (const trigger of tx.getCfcState().triggerReads) {
    if (
      consume(
        trigger.space,
        trigger.id as URI,
        normalizeCellScope(trigger.scope),
        "application/json",
        trigger.path,
        false,
      )
    ) {
      return true;
    }
  }
  return false;
};

const deriveFlowJoin = (
  tx: IExtendedStorageTransaction,
): { confidentiality: unknown[]; integrity: unknown[] } => {
  const atoms: unknown[] = [];
  // Class-aware integrity meet (§8.9.3 / §3.1.6.2): hereditary atoms
  // survive only when EVERY contributing observation carries them. An
  // observation with no resolved label has empty integrity and empties the
  // meet — weakest link, which is what carries PolicyCertified-class
  // certification honestly: a single uncertified input means the output is
  // uncertified. (In practice most transactions read some unlabeled doc,
  // so the meet is usually empty until inputs are universally certified —
  // staged conformance per SC-9, never over-claiming.)
  let hereditaryMeet: unknown[] | undefined;
  const metadataByDoc = new Map<string, CfcMetadata | undefined>();
  forEachFlowObservation(
    tx,
    (space, id, scope, type, logicalPath, nonRecursive) => {
      const key = targetKey({ space, id, scope });
      if (!metadataByDoc.has(key)) {
        metadataByDoc.set(key, storedMetadataFor(tx, space, id, scope, type));
      }
      const label = effectiveReadLabel(
        metadataByDoc.get(key),
        logicalPath,
        nonRecursive,
        { excludeLinkOrigin: true },
      );
      if (label?.confidentiality?.length) {
        atoms.push(...label.confidentiality);
      }
      const hereditary = (label?.integrity ?? []).filter((atom) =>
        atomPropagationClass(atom) === "hereditary"
      );
      hereditaryMeet = hereditaryMeet === undefined
        ? [...hereditary]
        : hereditaryMeet.filter((kept) =>
          hereditary.some((atom) => deepEqual(atom, kept))
        );
      return false;
    },
  );
  const confidentiality = uniqueCfcAtoms(atoms);
  const integrity: unknown[] = [...(hereditaryMeet ?? [])];
  // Derivation provenance (§8.9.3 TransformedBy, staged: identity binding
  // only — no per-input refs/witnesses yet). The flow join is one per-tx
  // label stamped on every written doc, so the identity must hold for the
  // whole tx: minted only when every non-privileged write was authored
  // under the same defined identity, captured at write time (see
  // `CfcTxState.writeIdentity`) — not whichever identity is current at
  // prepare, which a later run in the same tx may have changed and which
  // an unattributed write must not borrow. Ambiguity omits the atom
  // (fail-safe under-claim). Minted only alongside an entry that exists
  // anyway; runtime-minted (schema-forgery gated).
  const writeIdentity = tx.getCfcState().writeIdentity;
  const identity = writeIdentity.multiple ? undefined : writeIdentity.identity;
  if (
    identity !== undefined &&
    (confidentiality.length > 0 || integrity.length > 0)
  ) {
    integrity.push({ type: CFC_ATOM_TYPE.TransformedBy, identity });
  }
  return { confidentiality, integrity: uniqueCfcAtoms(integrity) };
};

/**
 * Cheap relevance trigger for the flow-labels dial: true when the
 * transaction observed any labeled document or wrote into one. Used by the
 * commit gate / prepare chokepoint to auto-mark relevance, so flow-label
 * derivation does not depend on callers remembering `markCfcRelevant`.
 */
export const flowLabelWorkExists = (
  tx: IExtendedStorageTransaction,
): boolean => {
  // Metadata minted by this transaction itself (raw `["cfc"]` seeding, or a
  // prior prepare pass) must not make the transaction flow-relevant: flow
  // labels exist to catch flows over *pre-existing* labels, and self-minted
  // metadata writes are either the CFC machinery's own or the raw-seed test
  // idiom. The raw-write surface itself is the S18 chokepoint seam, not a
  // relevance question.
  const selfMintedDocs = new Set<string>();
  const log = tx.getReactivityLog?.();
  const writeSpaces = new Set<MemorySpace>(
    [...(log?.writes ?? []), ...(log?.attemptedWrites ?? [])].map((write) =>
      write.space
    ),
  );
  for (const space of writeSpaces) {
    for (const write of tx.getWriteDetails?.(space) ?? []) {
      // Either a direct `["cfc"]` write or a whole-envelope root write whose
      // value embeds a `cfc` record (the raw-seed idiom).
      if (
        write.address.path[0] === "cfc" ||
        (write.address.path.length === 0 && isRecord(write.value) &&
          isRecord((write.value as { cfc?: unknown }).cfc))
      ) {
        selfMintedDocs.add(targetKey({
          space: write.address.space,
          id: write.address.id,
          scope: normalizeCellScope(write.address.scope),
        }));
      }
    }
  }
  const entriesByDoc = new Map<
    string,
    { any: boolean; nonLink: boolean }
  >();
  const docEntries = (
    space: MemorySpace,
    id: URI,
    scope: ReturnType<typeof normalizeCellScope>,
    type: MediaType,
  ): { any: boolean; nonLink: boolean } => {
    const key = targetKey({ space, id, scope });
    let known = entriesByDoc.get(key);
    if (known === undefined) {
      if (selfMintedDocs.has(key)) {
        known = { any: false, nonLink: false };
      } else {
        const entries =
          storedMetadataFor(tx, space, id, scope, type)?.labelMap.entries ??
            [];
        known = {
          any: entries.length > 0,
          nonLink: entries.some((entry) => entry.origin !== "link"),
        };
      }
      entriesByDoc.set(key, known);
    }
    return known;
  };
  // Read side mirrors the J derivation's pointer/content split: link-origin
  // entries don't contribute to J, so they don't make a tx relevant either.
  if (
    forEachFlowObservation(
      tx,
      (space, id, scope, type) => docEntries(space, id, scope, type).nonLink,
    )
  ) {
    return true;
  }
  // Write side keeps any-entry sensitivity: overwriting a link-labeled path
  // must run the flow stage to clear/replace the per-value components.
  for (const [, target] of valueWriteTargets(tx)) {
    if (docEntries(target.space, target.id, target.scope, target.type).any) {
      return true;
    }
  }
  return false;
};

/**
 * Relevance trigger for the per-sink confidentiality ceiling (audit item 21):
 * true when the transaction recorded a sink-request write-policy input whose
 * sink declares a ceiling. Used by the commit chokepoint to auto-mark
 * relevance, the same way `flowLabelWorkExists` does for the flow dial.
 *
 * Without this, a request assembled from a value pulled through a schema-less
 * link never marks the transaction relevant: the materializing read carries no
 * `ifc` schema and the read target's stored metadata is not consulted on that
 * read path, so nothing calls `markCfcRelevant`. The transaction then commits
 * without `prepareCfc`, and `verifySinkRequestCeilings` (which only runs inside
 * `prepareBoundaryCommit`) never gates the egress — the request leaves carrying
 * confidentiality outside the ceiling. Tying relevance to the egress act itself
 * closes that gap regardless of how the request's inputs were read: the same
 * transaction's consumed reads still supply the confidentiality the ceiling is
 * checked against (§5.2.1 / §7.3-7.5 egress gate).
 */
export const gatedSinkRequestExists = (
  tx: IExtendedStorageTransaction,
): boolean => {
  const state = tx.getCfcState();
  const ceilings = state.sinkMaxConfidentiality;
  if (ceilings === undefined) {
    return false;
  }
  return state.writePolicyInputs.some((input) =>
    input.kind === "sink-request" && ceilings[input.sink] !== undefined
  );
};

const walkIfcSchema = (
  schema: JSONSchema,
  path: readonly string[] = [],
  entries: Array<
    {
      path: readonly string[];
      label: IFCLabel;
      schema: JSONSchema;
      // Document carrying the `$defs` that resolves refs inside `schema`.
      // `schema` is the bare ifc node (no `$defs` of its own), so value-condition
      // refs only resolve against this root — thread it to the policy matcher.
      root: JSONSchema;
    }
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
        root: childRoot,
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

// Atom types forbidden as alternatives of an AUTHORED OR-clause (spec §3.1.8):
// alternatives must be principal-like. `Caveat` as an alternative would make a
// risk obligation dischargeable by identity ("readable by Bob OR if screened"),
// collapsing the caveat discipline; `Expires` semantics is most-restrictive-
// wins, which inverts to least-restrictive-wins as an alternative
// (`[[User(A) ∨ Expires(t)]]` world-readable until t). Both are conservative
// fail-closed rejections, relaxable later by a profile that defines the wanted
// semantics. (`Expires` is not yet a registered `CFC_ATOM_TYPE` — it arrives
// with the exchange-rule atoms in Epic B1 — so match its spec type URI too.)
const FORBIDDEN_OR_CLAUSE_ALTERNATIVE_TYPES = new Set<string>([
  CFC_ATOM_TYPE.Caveat,
  "https://commonfabric.org/cfc/atom/Expires",
]);

const disallowedAuthoredClauseReason = (
  schema: JSONSchema,
  path: readonly string[],
): string | undefined => {
  if (!isRecord(schema) || !isRecord(schema.ifc)) {
    return undefined;
  }
  const confidentiality = (schema.ifc as Record<string, unknown>)
    .confidentiality;
  if (!Array.isArray(confidentiality)) {
    return undefined;
  }
  for (const clause of confidentiality) {
    if (!isOrClause(clause)) {
      continue;
    }
    for (const alternative of clauseAlternatives(clause)) {
      if (
        isRecord(alternative) && typeof alternative.type === "string" &&
        FORBIDDEN_OR_CLAUSE_ALTERNATIVE_TYPES.has(alternative.type)
      ) {
        return `authored OR-clause alternative of type ${alternative.type} ` +
          `is not permitted at /${path.join("/")} (spec §3.1.8: alternatives ` +
          `must be principal-like; Expires/Caveat forbidden as alternatives)`;
      }
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
  // TODO(danfuzz): `deepEqual` mishandles `FabricValue` (see
  // `utils/deep-equal.ts`); `schema.default` can hold a `FabricValue`, so this
  // CFC write-policy check can compare wrong. Migrate to a `Fabric`-aware
  // equality once available.
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

// Thrown when a policy `$ref` cannot be resolved against its own document, so
// the value condition cannot be evaluated. It propagates past the matcher's
// boolean combinators (notably `oneOf`'s exactly-one count, where neither
// `true` nor `false` reliably biases toward "applies") and is caught at the
// `wildcardPolicyMatchesValue` boundary, which fails closed by treating the
// ifc entry as applying — mirroring the unresolvable-LINK branch (audit S17).
class UnevaluablePolicyRefError extends Error {}

const policySchemaMatchesValue = (
  schema: JSONSchema,
  value: unknown,
  // Schema document whose `$defs` resolves `$ref`s below the root node
  // (generated schemas put named types there, e.g. an array's items
  // `#/$defs/<name>` ref). Threaded through recursion so only a ref that is
  // unresolvable against its own document fails closed.
  root: JSONSchema = schema,
): boolean => {
  // Keep this narrow matcher aligned with resolveSchemaForValue() in
  // schema.ts. This copy is intentionally local because CFC policy checks must
  // fail closed on unresolved refs and partial wildcard writes.
  if (typeof schema === "boolean") {
    return schema;
  }
  const schemaRoot = schema.$defs !== undefined ? schema : root;
  if (typeof schema.$ref === "string") {
    const resolved = ContextualFlowControl.resolveSchemaRefs(
      schema,
      schemaRoot,
    );
    // An unresolvable policy ref (missing/dropped `$def`, or a ref that
    // resolves to itself with no progress) leaves the condition unevaluable.
    // Unlike S17's author-controlled LINK schema, this schema IS the policy we
    // enforce, but the same rule holds: an unevaluable condition must never
    // silently exclude the entry (fail open) — signal it so the boundary fails
    // closed.
    if (resolved === undefined || resolved === schema) {
      throw new UnevaluablePolicyRefError(schema.$ref);
    }
    return policySchemaMatchesValue(resolved, value, schemaRoot);
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
      policySchemaMatchesValue(branch, value, schemaRoot)
    );
  }
  if (Array.isArray(schema.oneOf)) {
    return schema.oneOf.filter((branch) =>
      policySchemaMatchesValue(branch, value, schemaRoot)
    ).length === 1;
  }
  if (Array.isArray(schema.allOf)) {
    return schema.allOf.every((branch) =>
      policySchemaMatchesValue(branch, value, schemaRoot)
    );
  }
  if (isRecord(value) && isRecord(schema.properties)) {
    return Object.entries(schema.properties).every(([key, childSchema]) =>
      value[key] === undefined ||
      policySchemaMatchesValue(childSchema, value[key], schemaRoot)
    );
  }
  if (
    Array.isArray(value) && typeof schema.items === "object" &&
    schema.items !== null
  ) {
    const itemSchema = schema.items;
    return value.every((item) =>
      policySchemaMatchesValue(itemSchema, item, schemaRoot)
    );
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
  // Schema document that resolves `$ref`s inside `schema`. walkIfcSchema
  // captures an ifc node WITHOUT the document's `$defs` (those live on the
  // outer root), so a value-condition ref like `items: {$ref: "#/$defs/X"}`
  // only resolves when the root carrying `$defs` is threaded in. Without it the
  // ref is spuriously unevaluable and the entry would fail closed on a perfectly
  // valid policy. Defaults to `schema` for callers whose schema is already
  // self-contained (e.g. the unit-test surface).
  root?: JSONSchema,
): boolean => {
  if (schema === undefined) {
    return true;
  }
  const resolutionRoot = root ?? schema;

  // An unevaluable policy `$ref` (UnevaluablePolicyRefError) fails closed:
  // treat the entry as applying rather than letting a broken/poisoned schema
  // envelope silently exclude its writeAuthorizedBy/maxConfidentiality checks.
  const matches = (candidate: unknown): boolean => {
    try {
      return policySchemaMatchesValue(schema, candidate, resolutionRoot);
    } catch (error) {
      if (error instanceof UnevaluablePolicyRefError) {
        return true;
      }
      throw error;
    }
  };

  if (!isPrimitiveCellLink(value)) {
    return matches(value);
  }

  const linkedValue = linkedWriteValueForPolicy(tx, target, value);
  if (linkedValue !== undefined) {
    return matches(linkedValue);
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
  // Document root that resolves `$ref`s inside `schema` (see
  // wildcardPolicyMatchesValue). Threaded from walkIfcSchema entries, whose
  // captured ifc node lacks the document's `$defs`.
  root?: JSONSchema,
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
        wildcardPolicyMatchesValue(tx, target, schema, value, root);
    }
    if (value === undefined) {
      return previousWriteValueForTarget(tx, pathTarget) !== undefined;
    }
    return value !== undefined &&
      wildcardPolicyMatchesValue(tx, target, schema, value, root);
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
        root,
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
        wildcardPolicyMatchesValue(tx, target, schema, write.value, root);
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
          wildcardPolicyMatchesValue(tx, target, schema, match, root)
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
    wildcardPolicyMatchesValue(tx, target, schema, match, root)
  );
};

// Structural-link provenance atoms the runtime mints when a value is
// dereferenced / fetched. They describe HOW a value was obtained, never an
// endorsement an author can require via requiredIntegrity.
const STRUCTURAL_LINK_PROVENANCE_ATOM_TYPES = new Set<string>([
  CFC_ATOM_TYPE.LinkReference,
  CFC_ATOM_TYPE.Origin,
]);

const isNonEndorsementProvenanceAtom = (atom: unknown): boolean =>
  (isRecord(atom) && typeof atom.type === "string" &&
    STRUCTURAL_LINK_PROVENANCE_ATOM_TYPES.has(atom.type)) ||
  // The current-principal claim family (authored-by / represents-principal) is
  // an identity provenance claim gated separately by
  // currentPrincipalIntegrityReason, never a requiredIntegrity target.
  isCurrentPrincipalClaimAtom(atom);

// A consumed read whose label carries no confidentiality and whose integrity is
// ENTIRELY non-endorsement provenance (a link reference / origin / a
// current-principal claim) is structural plumbing, not a data input. It must
// not gate a requiredIntegrity write: the transaction-global quantification
// would otherwise false-reject an unrelated protected write (audit S7 — e.g.
// cfc-group-chat-demo's admin grant reads adminRegistry.bootstrapAdmin.subject,
// label [represents-principal, LinkReference], and that lookup fails the admins
// list's requiredIntegrity:[group-chat-admin]). A read carrying ANY
// confidentiality, or any genuine endorsement integrity atom, stays in the gate
// — that keeps the cross-cell prompt-injection screen sound (its briefing reads
// carry confidentiality; its endorsement reads carry real integrity).
//
// TODO(data-flow): this exemption is an incremental scoping, not the end state
// (both follow-ons deliberately deferred by #4015): (a) per-write data-flow
// provenance — gate each protected write on the reads that actually fed it,
// not the transaction-global consumed set — via the dedicated write-attempt
// logging sketched in docs/plans/runner_cfc_implementation.md under "Potential
// and Final Write Sets"; (b) the audit #14 vacuous-pass tightening (a
// requiredIntegrity gate whose consumed set is empty passes today; see the
// "vacuous-pass S7 / Wave 2 #14" row in
// docs/specs/cfc-s16-default-transition-design.md §10), which is unsound to
// apply without (a) — it would over-reject.
const isProvenanceOnlyConsumedLabel = (label: IFCLabel): boolean => {
  if ((label.confidentiality?.length ?? 0) > 0) return false;
  const integrity = label.integrity ?? [];
  return integrity.length > 0 &&
    integrity.every(isNonEndorsementProvenanceAtom);
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
  // The consumed reads this gate quantifies over (provenance-only reads
  // excluded). Distinct from the egress side's transaction-global consumed
  // set (collectConsumedConfidentiality), which keeps every labeled read.
  const gatedReads = [...(tx.getReadActivities?.() ?? [])].filter((read) =>
    !isInternalVerifierRead(read.meta)
  ).map((read) => ({
    ...read,
    path: canonicalizeLogicalPath(read.path),
    label: effectiveReadLabel(
      storedMetadataFor(
        tx,
        read.space,
        read.id,
        normalizeCellScope(read.scope),
        read.type ?? "application/json",
      ),
      canonicalizeLogicalPath(read.path),
      read.nonRecursive,
    ),
  })).filter((read) =>
    read.label !== undefined &&
    // A present-but-empty label ({} — no atoms) is the same trust level as an
    // absent one (excluded above); whether metadata materialized an empty
    // entry is a persistence/sync artifact and must not decide gate
    // membership.
    hasLabelValues(read.label) &&
    // Provenance-only reads (link/origin/current-principal, no confidentiality)
    // are structural plumbing, not endorsable inputs — excluding them stops the
    // transaction-global quantification from false-rejecting unrelated
    // protected writes (audit S7). Confidentiality- or endorsement-bearing
    // reads stay, keeping the prompt-injection screen sound.
    !isProvenanceOnlyConsumedLabel(read.label)
  );

  for (const entry of walkIfcSchema(schema)) {
    if (
      !ifcEntryAppliesToAttemptedWrite(
        tx,
        target,
        entry.path,
        entry.schema,
        entry.root,
      )
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
    const disallowedClause = disallowedAuthoredClauseReason(
      entry.schema,
      entry.path,
    );
    if (disallowedClause !== undefined) {
      return disallowedClause;
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
    ) || writeIsPatternSetupInitialization(tx, target, entry.path) ||
      writeIsSeedMaterialization(tx, target);
    if (writeAuthorizedByFailure !== undefined && !setupProjection) {
      return writeAuthorizedByFailure;
    }
    const requiredIntegrity = ifc?.requiredIntegrity ?? [];
    if (requiredIntegrity.length > 0 && gatedReads.length > 0) {
      const ok = gatedReads.every((read) =>
        cfcIntegritySatisfiesFloor(
          read.label?.integrity ?? [],
          requiredIntegrity,
        )
      );
      if (!ok) {
        return `requiredIntegrity failed at /${entry.path.join("/")}`;
      }
    }

    // undefined means no ceiling; a declared (even empty) ceiling is enforced.
    // An empty ceiling is "public only": any consumed confidential atom fails.
    const maxConfidentiality = ifc?.maxConfidentiality;
    if (maxConfidentiality !== undefined && gatedReads.length > 0) {
      const ok = gatedReads.every((read) =>
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
      !ifcEntryAppliesToAttemptedWrite(
        tx,
        target,
        entry.path,
        entry.schema,
        entry.root,
      )
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
    // Normalize confidentiality clauses on persist (Epic A4): an authored or
    // copied `{anyOf:[…]}` clause is deduped/canonically-ordered/singleton-
    // unwrapped so the stored labelMap entry is canonical and two equivalent
    // clauses coalesce. `normalizeClause` is identity on flat atoms, so flat
    // labels are unchanged. Integrity carries no OR-clauses.
    confidentiality: mergeLabelValues(
      schemaLabel.confidentiality?.map(normalizeClause),
      copiedInputLabel?.confidentiality?.map(normalizeClause),
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
  // Hereditary certification must come from the certification process, not
  // a pattern-authored schema — forging it would survive every combination.
  CFC_ATOM_TYPE.PolicyCertified,
  CFC_ATOM_TYPE.PromptSlotBound,
  CFC_ATOM_TYPE.PromptSlotInfluence,
  // Derivation provenance is evidence minted by the flow stage (§8.9.3).
  CFC_ATOM_TYPE.TransformedBy,
  CFC_ATOM_TYPE.UserSurfaceInput,
  // External-ingest provenance is minted by the runtime-internal ingest seam
  // from verified channel metadata only (the split-mint). Gating it here is
  // load-bearing: the payload bytes are authored under the ordinary member
  // identity, so any ExternalIngest atom an attacker smuggles into the payload
  // is stripped — the trusted mark can only come from the builtin mint step.
  CFC_ATOM_TYPE.ExternalIngest,
  // LLM-derivation provenance is minted by the llm builtins at the point
  // model bytes enter the store (Epic D1). Gating it keeps the stamp honest
  // in BOTH directions: pattern code can neither forge it onto values the
  // model never produced nor author schemas that mint it.
  CFC_ATOM_TYPE.LlmDerived,
]);

const isRuntimeMintedIntegrityAtom = (atom: unknown): boolean =>
  (isRecord(atom) && typeof atom.type === "string" &&
    RUNTIME_MINTED_INTEGRITY_ATOM_TYPES.has(atom.type)) ||
  // Compile-cache attestation (string-shaped, see CFC_COMPILED_BY_ATOM):
  // marks a stored doc as system-compiler output, which the cache loader
  // then evaluates as trusted bodies — forging it from a pattern-authored
  // schema would be cross-user code injection.
  (typeof atom === "string" && atom.startsWith(CFC_COMPILED_BY_ATOM_PREFIX));

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

/**
 * The result schema a piece's setup wrote as the source doc's ["schema"] meta
 * — visible read-your-writes for a piece instantiated in THIS transaction
 * (e.g. a handler materializing a sub-pattern and linking it into a protected
 * list in one commit), and from storage for a piece set up earlier. A fresh
 * piece has no stored CFC metadata and no schema write-policy input (its value
 * is computed by later actions), but this is the same author-declared shape a
 * pending schema input carries, so the link-label derivation below trusts it
 * the same way; stored CFC metadata still takes precedence when present.
 */
const setupResultSchemaFor = (
  tx: IExtendedStorageTransaction,
  source: LinkWritePolicyInput["source"],
): JSONSchema | undefined => {
  const document = tx.readOrThrow({
    space: source.space,
    id: source.id as URI,
    scope: source.scope,
    type: "application/json",
    path: [],
  }, {
    meta: INTERNAL_VERIFIER_META,
  });
  if (!isRecord(document)) {
    return undefined;
  }
  const schema = (document as Record<string, unknown>).schema;
  return schema === undefined || schema === null
    ? undefined
    : schema as JSONSchema;
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
  let pendingSourceSchema = candidateSchemas.get(targetKey(input.source)) ??
    setupResultSchemaFor(tx, input.source);
  let pendingSourceLabel = pendingSourceSchema !== undefined
    ? persistedLabelFromSchemaAtPath(
      tx,
      pendingSourceSchema,
      input.source.path,
    )
    : undefined;
  if (pendingSourceSchema === undefined && sourceMetadata === undefined) {
    // Child docs minted by this same write: an array/object entry written
    // into a labeled location is split into its own doc by the data layer,
    // so the link's "source" is a doc this transaction just created to hold
    // an inline value. The writer's schema input covers the TARGET path —
    // derive the label the value would have carried inline. Gated to docs
    // this transaction CREATED (a root-level write with no previous value):
    // a pre-existing doc with persisted labels resolves through its stored
    // CFC metadata above, and one without stored metadata stays fail-closed
    // even when this tx touched one of its fields.
    const sourceCreatedInThisTx = [
      ...(tx.getWriteDetails?.(input.source.space) ?? []),
    ].some((detail) =>
      detail.address.id === input.source.id &&
      detail.address.path.length <= 1 &&
      detail.previousValue === undefined
    );
    if (sourceCreatedInThisTx) {
      const targetCandidate = candidateSchemas.get(targetKey(input.target));
      if (targetCandidate !== undefined) {
        pendingSourceSchema = targetCandidate;
        pendingSourceLabel = persistedLabelFromSchemaAtPath(
          tx,
          targetCandidate,
          input.target.path,
        );
      }
    }
  }
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
  entries: ReadonlyArray<LabelMapEntry>,
): Array<LabelMapEntry> => {
  // Coalesce per (path, origin): same-component entries at one path merge;
  // entries of different components stay separate so each can follow its
  // own update discipline (declared monotone, link/derived per-value).
  const byKey = new Map<string, LabelMapEntry>();
  for (const entry of entries) {
    const path = [...entry.path];
    const key = `${entry.origin ?? ""}\u0000${pathKey(path)}`;
    const existing = byKey.get(key);
    byKey.set(key, {
      path,
      label: mergeLabels(existing?.label, cloneLabel(entry.label)),
      ...(entry.origin !== undefined ? { origin: entry.origin } : {}),
    });
  }
  return [...byKey.values()].sort((left, right) => {
    const leftKey = pathKey(left.path);
    const rightKey = pathKey(right.path);
    if (leftKey !== rightKey) {
      return leftKey < rightKey ? -1 : 1;
    }
    const leftOrigin = left.origin ?? "";
    const rightOrigin = right.origin ?? "";
    return leftOrigin < rightOrigin ? -1 : leftOrigin > rightOrigin ? 1 : 0;
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

// Union of confidentiality atoms across every non-internal labeled read in the
// transaction, resolved from stored labels the same way verifyInputRequirements
// resolves them. Transaction-global by design: a sink request is built from
// whatever the handler read, and the sink-request input does not record its own
// read provenance, so the whole consumed set is the sound over-approximation.
const collectConsumedConfidentiality = (
  tx: IExtendedStorageTransaction,
): readonly unknown[] => {
  const atoms: unknown[] = [];
  for (const read of tx.getReadActivities?.() ?? []) {
    if (isInternalVerifierRead(read.meta)) continue;
    const metadata = storedMetadataFor(
      tx,
      read.space,
      read.id,
      normalizeCellScope(read.scope),
      read.type ?? "application/json",
    );
    if (metadata === undefined) continue;
    const path = canonicalizeLogicalPath(read.path);
    // A recursive read at `path` observes the value at `path` and everything
    // below it, so its confidentiality is the union of every labelMap entry
    // that is an ancestor-or-equal of `path` (a label that applies to it) OR a
    // DESCENDANT of `path` (a label on a field inside the value just read).
    // labelAtPath alone would only see the ancestor — so reading a whole object
    // and sending one confidential field would slip the ceiling (review on
    // #3993). A nonRecursive read sees ONLY the value at `path`, so it counts
    // ancestor-or-equal entries but NOT descendants — counting those would
    // false-reject valid commits (review round 2 on #3993).
    for (const entry of metadata.labelMap.entries) {
      const entryPath = canonicalizeLogicalPath(entry.path);
      // Structure entries label only the container node's shape: an
      // ancestor structure entry does not apply to a read strictly below
      // it (same exact-path rule as `labelAtPath`); as a descendant of a
      // recursive read it does apply (the read materializes the shape).
      const overlapsRead = entry.origin === "structure"
        ? (entryPath.length === path.length
          ? isPrefix(entryPath, path)
          : read.nonRecursive !== true && isPrefix(path, entryPath))
        : (isPrefix(entryPath, path) ||
          (read.nonRecursive !== true && isPrefix(path, entryPath)));
      if (!overlapsRead) continue;
      atoms.push(...(entry.label.confidentiality ?? []));
    }
  }
  // Structural dedup (deep-equal) — the same dedup the rest of CFC uses.
  return uniqueCfcAtoms(atoms);
};

// §5.2.1 / §7.3-7.5 egress gate: a recorded sink-request input whose sink
// declares a confidentiality ceiling must not carry confidentiality outside it.
// Rides the standard observe→enforce path (a reason invalidates prepare, which
// the commit gate turns into a reject only in enforcing modes).
const verifySinkRequestCeilings = (
  tx: IExtendedStorageTransaction,
): string[] => {
  const state = tx.getCfcState();
  const ceilings = state.sinkMaxConfidentiality;
  if (ceilings === undefined) return [];
  const gatedSinks = new Map<string, readonly unknown[]>();
  for (const input of state.writePolicyInputs) {
    if (input.kind !== "sink-request") continue;
    // Own-property lookup only: a sink named like an Object.prototype member
    // ("constructor", "hasOwnProperty", …) must mean "no ceiling declared",
    // not resolve an inherited function (review on #3993).
    const ceiling = Object.hasOwn(ceilings, input.sink)
      ? ceilings[input.sink]
      : undefined;
    if (ceiling !== undefined) gatedSinks.set(input.sink, ceiling);
  }
  if (gatedSinks.size === 0) return [];
  const consumed = collectConsumedConfidentiality(tx);
  if (consumed.length === 0) return [];
  const reasons: string[] = [];
  for (const [sink, ceiling] of gatedSinks) {
    // Same membership semantics as cfcObservationFitsCeiling (shared helper),
    // so the egress gate and the observation fits-test cannot drift.
    const offending = atomsOutsideCeiling(consumed, ceiling);
    if (offending.length > 0) {
      // Name the offending atom(s) so an observe-mode diagnostic identifies the
      // exact (sink, atom) pair that needs a ceiling entry (review on #3993).
      reasons.push(
        `sink-request confidentiality exceeds ceiling for ${sink}: ` +
          offending.map((atom) => JSON.stringify(atom)).join(", "),
      );
    }
  }
  return reasons;
};

export const prepareBoundaryCommit = (
  tx: IExtendedStorageTransaction,
): string[] => {
  const reasons: string[] = [];
  const state = tx.getCfcState();
  // A write to a document's ["cfc"] label-map path made outside the runtime's
  // privileged persistence scope forges the metadata that drives CFC derivation
  // for other writes (audit S18). Each was recorded at the extended-tx write
  // chokepoint; surface one fail-closed reason apiece so it rejects in enforce
  // mode and diagnoses in observe, uniformly with every other reason here.
  for (const target of state.unprivilegedSystemWrites ?? []) {
    reasons.push(`unprivileged write to protected cfc path ${target}`);
  }
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
  // S16 flow labels: the per-tx conservative join. In `persist` mode every
  // value write target gets a `derived` component carrying it; in `observe`
  // mode it only feeds diagnostics. Derivation never rejects.
  const flowMode = state.flowLabelsMode;
  const flowPersist = flowMode === "persist";
  const flowTargets = flowMode === "off" ? undefined : valueWriteTargets(tx);
  const flowJoin = flowMode === "off"
    ? { confidentiality: [], integrity: [] }
    : deriveFlowJoin(tx);
  const flowConfidentiality = flowJoin.confidentiality;
  const flowIntegrity = flowJoin.integrity;
  const flowHasLabels = flowConfidentiality.length > 0 ||
    flowIntegrity.length > 0;
  if (
    flowMode === "observe" &&
    flowTargets !== undefined &&
    flowTargets.size > 0 &&
    flowHasLabels
  ) {
    state.diagnostics.push(
      `flow-labels(observe): would derive ${flowConfidentiality.length} ` +
        `confidentiality / ${flowIntegrity.length} integrity atom(s) onto ` +
        `${flowTargets.size} written doc(s)`,
    );
  }
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
  // A vouched ingest writes its provenance mark even when the payload write
  // carries no schema candidate and flow labels are off, so the ingest target
  // must enter the persist loop on its own. The anchor is the cell the helper
  // declared, not whatever the value diff happened to touch (an array append
  // diffs to `[...P,"N"]`/`[...P,"length"]`, never `P`).
  const ingestStamp = externalIngestStamp(tx);
  const ingestKey = ingestStamp !== undefined
    ? targetKey({
      space: ingestStamp.target.space,
      scope: normalizeCellScope(ingestStamp.target.scope),
      id: ingestStamp.target.id,
    })
    : undefined;
  if (ingestKey !== undefined) {
    targetKeys.add(ingestKey);
  }
  if (flowPersist && flowTargets !== undefined) {
    // Flow targets enter the persist loop when there is taint to attach or
    // stale per-value components (derived/link) to replace under a written
    // path. Docs with neither stay on the fast path.
    for (const [key, target] of flowTargets) {
      if (targetKeys.has(key)) {
        continue;
      }
      if (flowHasLabels) {
        targetKeys.add(key);
        continue;
      }
      const existingMeta = storedMetadataFor(
        tx,
        target.space,
        target.id,
        target.scope,
        target.type,
      );
      if (
        existingMeta?.labelMap.entries.some((entry) =>
          (entry.origin === "derived" || entry.origin === "link" ||
            entry.origin === "structure") &&
          target.paths.some((written) => isPrefix(written, entry.path))
        )
      ) {
        targetKeys.add(key);
      }
    }
  }
  for (const key of targetKeys) {
    const candidateSchema = candidates.get(key);
    const schema = candidateSchema ?? emptySchemaObject();
    const undefinedCandidate = candidateSchema === undefined;
    const target = targetFromKey(key);
    const { space, id, scope } = target;
    const isIngestTarget = ingestKey !== undefined && key === ingestKey;
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
        mergedSchema = schemasEqualIgnoringWriterStamp(storedSchema, schema) ||
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
    // A verification failure records a reason (which rejects the whole commit
    // in enforcing modes) and skips persisting this target's declared label.
    // But the external-ingest MARK is runtime-authored provenance, orthogonal
    // to whether the payload satisfies its schema — it must still persist in the
    // non-rejecting modes the ingest path runs in (the mint runs even under
    // `disabled`, see runtime.ts). So the ingest target is exempt from the
    // skip: enforcing modes still abort the tx via the recorded reason (nothing
    // persists), while `disabled`/`observe` commit with the mark intact. The
    // DECLARED label is still skipped for a failed ingest target (see
    // ingestVerificationFailed below), so a non-rejecting commit stores only the
    // runtime's mark, never the payload's unverified policy metadata.
    let ingestVerificationFailed = false;
    if (requirementFailure) {
      reasons.push(requirementFailure);
      if (!isIngestTarget) continue;
      ingestVerificationFailed = true;
    }
    const trustedEventFailure = verifyTrustedEventRequirements(
      tx,
      target,
      verificationSchema,
    );
    if (trustedEventFailure) {
      reasons.push(trustedEventFailure);
      if (!isIngestTarget) continue;
      ingestVerificationFailed = true;
    }

    const exactCopyFailure = verifyExactCopyRequirements(
      tx,
      target,
      verificationSchema,
    );
    if (exactCopyFailure) {
      reasons.push(exactCopyFailure);
      if (!isIngestTarget) continue;
      ingestVerificationFailed = true;
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
    const flowWrittenPaths = flowPersist
      ? flowTargets?.get(key)?.paths ?? []
      : [];
    // The Wave 2 grow-only ratchet stood in for the missing default
    // transition: with flow labels persisting, taint rides the derived
    // component instead, and only legacy (untagged) entries keep the
    // ratchet. Folding link/derived atoms into freshly declared entries
    // would otherwise ratchet per-value taint into the monotone store
    // policy forever.
    const existingConfidentiality = (existing?.labelMap.entries ?? [])
      .filter((e) => !flowPersist || e.origin === undefined)
      .filter((e) => (e.label.confidentiality?.length ?? 0) > 0)
      .map((e) => ({
        path: canonicalizeLogicalPath(e.path),
        confidentiality: e.label.confidentiality as readonly unknown[],
      }));
    // When an ingest target failed verification we keep the runtime's mark
    // (appended below) but drop the payload's declared policy label — a
    // non-rejecting commit must not store claims that didn't verify.
    const persistedLabelEntries: LabelMapEntry[] = ingestVerificationFailed
      ? []
      : mergedSchemaEntries
        .flatMap((entry) => {
          if (
            !ifcEntryAppliesToAttemptedWrite(
              tx,
              target,
              entry.path,
              entry.schema,
              entry.root,
            )
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
          // (e.g. link-derived or carried-view atoms). Reads use longest-prefix
          // matching, so a new child entry shadows an ancestor — merge prior
          // confidentiality from this path AND every ancestor of it, not just an
          // exact-path match (audit S9, review follow-up). Integrity is left as
          // derived (freshly gated) — it must not regrow.
          const prior = existingConfidentiality
            .filter((e) => isPrefix(e.path, entry.path))
            .flatMap((e) => e.confidentiality);
          const label = prior.length > 0
            ? {
              ...derived,
              confidentiality: mergeLabelValues(derived.confidentiality, prior),
            }
            : derived;
          return hasLabelValues(label) || hasPersistedPolicyClaim(entry.schema)
            ? [{
              path: entry.path,
              label,
              origin: "declared" as const,
            }]
            : [];
        });
    const persistedLabelEntryKeys = new Set(
      persistedLabelEntries.map((entry) => pathKey(entry.path)),
    );
    const currentLinkWritePaths = new Set(
      linkWriteInputs.map((input) => pathKey(input.target.path)),
    );
    let flowCleared = false;
    for (const entry of existing?.labelMap.entries ?? []) {
      const entryPath = canonicalizeLogicalPath(entry.path);
      const key = pathKey(entryPath);
      if (persistedLabelEntryKeys.has(key) || currentLinkWritePaths.has(key)) {
        continue;
      }
      // A fresh ingest re-mints the ExternalIngest mark for this doc below, so
      // never carry the prior one forward — its payload digest is stale. The
      // anchor is an ancestor of the element-wise-diffed writes, so the
      // flow-style "written path covers entry" clear never fires for it;
      // drop it by origin instead.
      if (isIngestTarget && entry.origin === "external-ingest") {
        continue;
      }
      // Per-value components track the current value: a write at-or-above
      // them replaced that value, so stale derived/link/structure entries
      // under any written path are dropped (fresh ones for this tx are
      // appended below / by the link machinery). Declared and legacy
      // entries are never cleared here.
      if (
        flowPersist &&
        (entry.origin === "derived" || entry.origin === "link" ||
          entry.origin === "structure") &&
        flowWrittenPaths.some((written) => isPrefix(written, entryPath))
      ) {
        flowCleared = true;
        continue;
      }
      const schemaEntry = mergedSchemaEntrySchemas.get(key);
      if (
        hasLabelValues(entry.label) ||
        (schemaEntry !== undefined && hasPersistedPolicyClaim(schemaEntry))
      ) {
        // Carry-forward of an untouched path preserves the entry's
        // component (legacy entries stay legacy).
        persistedLabelEntries.push({
          path: entryPath,
          label: cloneLabel(entry.label),
          ...(entry.origin !== undefined ? { origin: entry.origin } : {}),
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
          origin: "link",
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
          origin: "link",
        });
      }
    }

    if (flowPersist && flowHasLabels) {
      // Attach the per-tx join at each written path. Within one tx every
      // write carries the same join, so deeper written paths are redundant
      // with a shallower written ancestor and are collapsed away (§4.6.4
      // operational guidance). Last-write-wins per path is trivially
      // satisfied for the same reason.
      //
      // Link-covered writes are skipped: the link machinery attaches the
      // source's own label at those paths — strictly finer than the per-tx
      // join. Stamping J there too would smear every reference a routing
      // transaction passes along with everything else it routed (the list
      // builtins' coordinators being the canonical case); the per-slot
      // link labels are exactly the pointwise answer.
      //
      // Pure-link-structure writes split per the pointer/content rule:
      // the references carry per-slot link labels (no covering stamp —
      // that would smear), but the container SHAPE (which slots exist —
      // a filter's membership decision, §8.5.6.1/SC-7) was computed by
      // this tx, so each container node gets an exact-path `structure`
      // stamp with J. Shape observers (reading the container itself,
      // length, enumeration) join it; slot pointer reads below it don't.
      const flowWrittenValues = flowTargets?.get(key)?.valuesByPath;
      const seenFlowPaths = new Set<string>();
      const derivedStampPaths: (readonly string[])[] = [];
      const structureStampPaths: (readonly string[])[] = [];
      for (const path of flowWrittenPaths) {
        const flowKey = pathKey(path);
        if (seenFlowPaths.has(flowKey)) {
          continue;
        }
        seenFlowPaths.add(flowKey);
        if (currentLinkWritePaths.has(flowKey)) {
          continue;
        }
        const written = flowWrittenValues?.get(flowKey);
        if (isPureLinkStructure(written)) {
          pureLinkContainerPaths(written, path, structureStampPaths);
          continue;
        }
        derivedStampPaths.push(path);
      }
      for (const path of derivedStampPaths) {
        // Deeper stamped paths are redundant with a stamped ancestor; only
        // collapse against paths that actually receive a covering entry.
        if (
          derivedStampPaths.some((other) =>
            other.length < path.length && isPrefix(other, path)
          )
        ) {
          continue;
        }
        persistedLabelEntries.push({
          path,
          label: {
            ...(flowConfidentiality.length > 0
              ? { confidentiality: [...flowConfidentiality] }
              : {}),
            ...(flowIntegrity.length > 0
              ? { integrity: [...flowIntegrity] }
              : {}),
          },
          origin: "derived",
        });
      }
      for (const path of structureStampPaths) {
        // A covering derived stamp at-or-above already labels the shape;
        // structure stamps don't cover each other (exact-path semantics),
        // so they only collapse against derived ancestors-or-equal.
        if (
          derivedStampPaths.some((other) =>
            other.length <= path.length && isPrefix(other, path)
          )
        ) {
          continue;
        }
        persistedLabelEntries.push({
          path,
          label: { confidentiality: [...flowConfidentiality] },
          origin: "structure",
        });
      }
    }

    if (isIngestTarget && ingestStamp !== undefined) {
      // The split-mint: a builtin-authored ExternalIngest provenance mark,
      // derived ONLY from the verified channel metadata the operator-side
      // helper stamped on this tx — channel, audience, receivedAt, and a digest
      // of the payload the helper wrote — touching zero attacker bytes. Pushed
      // with a runtime origin, so it bypasses gateRuntimeMintedIntegrity (the
      // member-authored payload's `declared` label above is still gated,
      // stripping any ExternalIngest atom an attacker smuggled into the
      // payload). Anchored at the declared ingest target path; the stale prior
      // mark for this doc was dropped from carry-forward above, so this
      // replaces rather than accumulates.
      persistedLabelEntries.push({
        path: canonicalizeLogicalPath(ingestStamp.target.path),
        label: {
          integrity: [cfcAtom.externalIngest(
            ingestStamp.channel,
            ingestStamp.audience,
            ingestStamp.receivedAt,
            ingestStamp.valueDigest,
          )],
        },
        origin: "external-ingest",
      });
    }

    const coalescedLabelEntries = coalesceLabelEntries(persistedLabelEntries);

    if (coalescedLabelEntries.length === 0 && !flowCleared) {
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
  reasons.push(...verifySinkRequestCeilings(tx));
  return reasons;
};
