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
import {
  canonicalizeCfcMetadata,
  canonicalizeLogicalPath,
} from "./canonical.ts";
import {
  clauseAlternatives,
  FORBIDDEN_OR_CLAUSE_ALTERNATIVE_TYPES,
  isOrClause,
  normalizeClause,
} from "./clause.ts";
import { collectDeclaredMonotonicityViolations } from "./declared-monotonicity.ts";
import { externalIngestStamp } from "./external-ingest.ts";
import {
  atomsOutsideCeiling,
  type CfcFloorTrustContext,
  cfcIntegritySatisfiesFloor,
  cfcIntegritySatisfiesFloorCoherently,
  uniqueCfcAtoms,
} from "./observation.ts";
import {
  type CfcGrantConsumptionContext,
  evaluateExchangeRules,
} from "./exchange-eval.ts";
import {
  createTxCfcGrantResolver,
  flushCfcGrantConsumptionClaims,
} from "./grants.ts";
import { cfcLabelViewFromMetadata } from "./label-view-state.ts";
import {
  deriveLabelMetadataTemplateEntries,
  isLabelMetadataTemplateEntry,
} from "./label-metadata-population.ts";
import {
  commitmentAwareEquals,
  containsCfcFieldCommitment,
  transformCfcLabelForCrossSpacePersist,
} from "./label-representation.ts";
import { createTrustResolver } from "./trust.ts";
import {
  type ReadClassSelection,
  readConsumesEntry,
  type ReadObservationShape,
} from "./observation-classes.ts";
import { mergeCfcSchemaEnvelopes } from "./schema-merge.ts";
import {
  CFC_STRUCTURAL_PROVENANCE_SEED_MATERIALIZATION,
  CFC_STRUCTURAL_PROVENANCE_SETUP_PROJECTION,
  cfcEnforcementStrictness,
  type CfcMetadata,
  type IFCLabel,
  type ImplementationIdentity,
  type LabelMapEntry,
  type LabelObservationClass,
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
): IFCLabel | undefined =>
  metadata === undefined
    ? undefined
    : labelForEntriesAtPath(metadata.labelMap.entries, path);

// A runtime-minted `*`-path class template (template-population §3.1): the
// membership/slot twins minted beside the container-anchored structure
// stamps (and any future derived-origin population entries of the same
// form). Declared `*` entries (items/additionalProperties schemas) are NOT
// templates in this sense — they keep the declared component's resolution
// untouched.
const isRuntimeMintedTemplate = (
  entry: Pick<LabelMapEntry, "path" | "origin">,
): boolean =>
  (entry.origin === "structure" || entry.origin === "derived") &&
  entry.path.includes("*");

const labelForEntriesAtPath = (
  entries: readonly LabelMapEntry[],
  path: readonly string[],
): IFCLabel | undefined => {
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
  for (const entry of entries) {
    if (!isPrefix(entry.path, path)) {
      continue;
    }
    const template = isRuntimeMintedTemplate(entry);
    // CONCRETE structure entries label the container's SHAPE: they apply
    // when the container node itself is observed (read at exactly the
    // entry path), not to reads strictly below it — slot pointer reads and
    // dereferences are pointer handling, and tainting them with shape
    // would re-smear the pointwise split the structure component exists to
    // preserve. `*`-path templates are the opposite by construction
    // (template-population §3.2): their whole point is consumption at
    // matching child paths, so the exact-path rule does not apply to them.
    if (
      entry.origin === "structure" && !template &&
      entry.path.length !== path.length
    ) {
      continue;
    }
    const component = entry.origin ?? "legacy";
    // Frozen-existence vs membership-template join (template-population
    // §3.2.1): a frozen concrete `shape` entry records departed HISTORY;
    // the `*` membership template records CURRENT shape. They answer
    // different questions under one class, so where both cover a read
    // their labels JOIN rather than compete in replace-down — replacing
    // would let a stale frozen label mask current membership taint or
    // vice versa. Scoped to structure/derived-origin shape-class
    // templates (a separate resolution bucket per component); everything
    // else keeps replace-down.
    const bucket = template && entry.observes === "shape"
      ? `${component}\u0000shape-template`
      : component;
    const match = matches.get(bucket);
    if (match === undefined || match.path.length < entry.path.length) {
      matches.set(bucket, entry);
    } else if (match.path.length === entry.path.length) {
      // Two equally specific prefixes of one queried path are the same
      // path — or, with wildcard segments, a concrete entry and a `*`
      // template covering the same slot; duplicate (path, origin) entries
      // shouldn't survive coalescing, but join defensively (fail-toward-
      // taint) rather than drop one.
      matches.set(bucket, {
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
//
// `consumes` selects entries by observation class (C1, C0 §4/§6): a read
// consumes only the entries whose class matches what it actually observed.
// This subsumes the old `excludeLinkOrigin` pointer/content split (SC-8):
// link-origin entries label the *reference* as transport (so links carry
// their target's sensitivity to wherever they land), but reading a value is
// not reading the pointer — value/shape reads skip them (the implicit
// `followRef` class of the C0 §3 carve-out), while followRef observations
// now consume exactly them. Content taint still arrives when the target is
// actually dereferenced, as an ordinary read of the target document.
// Covering (class-less) entries conflate the content channels and are
// consumed by every content read class (value/shape/enumerate) — over-taint,
// fail-safe — but never by followRef observations (C0 §6.1).
const effectiveReadLabel = (
  metadata: CfcMetadata | undefined,
  path: readonly string[],
  read: {
    nonRecursive: boolean | undefined;
    consumes: ReadClassSelection;
    /**
     * Entries excluded from this read's consumption on top of class
     * selection. Sole current user is `deriveFlowJoin`'s pair of template
     * machinery boundaries: the §8.12.8 replace-from-criteria readback
     * exclusion (a transaction re-deriving a container's membership stamps
     * must not consume the very entries it replaces — see
     * `ownRestampContainerPaths`) and the C0 §6.1 row-4 rule extended to
     * plain reads (trace-covered resolution machinery skips `*`
     * templates). Absent on every other call site (notably the
     * `"all"`-selection write gate, which stays over-inclusive by design).
     */
    excludeEntry?: (entry: LabelMapEntry) => boolean;
  },
): IFCLabel | undefined => {
  const view = (read.consumes === "all" && read.excludeEntry === undefined) ||
      metadata === undefined
    ? metadata
    : {
      ...metadata,
      labelMap: {
        ...metadata.labelMap,
        entries: metadata.labelMap.entries.filter((entry) =>
          (read.consumes === "all" ||
            readConsumesEntry(read.consumes, entry)) &&
          read.excludeEntry?.(entry) !== true
        ),
      },
    };
  const base = labelAtPath(view, path);
  if (read.nonRecursive === true || view === undefined) {
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

// Read-like shape (space/id/scope/path + a recursive read profile) for the
// addresses whose invalidating writes scheduled this run — the §8.9.2 trigger
// reads. Enabled only under the H5 gate (`triggerReadGating`); yields nothing
// otherwise, so the enforcement consumed sets are byte-identical to today when
// the flag is off. `cid:`/runtime-surface triggers are already excluded at
// ingest (`addCfcTriggerReads` applies `flowReadExcluded`), so entries here are
// user-data addresses only. Treated as RECURSIVE reads (the conservative
// direction: the whole triggering value could have influenced the decision to
// run). No `meta` — trigger entries never carry the internal-verifier marker,
// so they always count.
const triggerReadSources = (
  tx: IExtendedStorageTransaction,
): Array<{
  space: MemorySpace;
  id: URI;
  scope: ReturnType<typeof normalizeCellScope>;
  path: readonly string[];
  type: "application/json";
  nonRecursive?: boolean;
  meta: Record<never, never>;
}> => {
  if (!tx.getCfcState().triggerReadGating) return [];
  return tx.getCfcState().triggerReads.map((trigger) => ({
    space: trigger.space,
    id: trigger.id as URI,
    scope: normalizeCellScope(trigger.scope),
    path: canonicalizeLogicalPath(trigger.path),
    type: "application/json" as const,
    nonRecursive: false,
    meta: {},
  }));
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
  // OR a policy claim (writeAuthorizedBy / uiContract / exactCopyOf /
  // projection — see the entry-construction site). The mere presence of the
  // entry signals "policy
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
    schema.ifc.exactCopyOf !== undefined ||
    schema.ifc.projection !== undefined;
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
      // A document-root write carries the RAW envelope ({value, source, …}):
      // writeOrThrow's missing-doc retry materializes the whole document in
      // one write at storage path []. `writePath` is already logical, so the
      // recorded value must be too — the envelope's `value` member. Keeping
      // the raw envelope would let `pureLinkContainerPaths` walk through the
      // `value` wrapper and emit it as a stamp path, persisting membership
      // anchored at ["value"] where no canonical-path read consumes it; the
      // envelope's other members (`source`, `cfc`) are the runtime surfaces
      // the raw-path exclusions above keep out of flow labeling.
      const writtenValue = rawPath.length === 0
        ? (isRecord(write.value)
          ? (write.value as { value?: unknown }).value
          : undefined)
        : write.value;
      const key = targetKey(write.address);
      const existing = result.get(key);
      if (existing !== undefined) {
        existing.paths.push(writePath);
        existing.valuesByPath.set(pathKey(writePath), writtenValue);
      } else {
        result.set(key, {
          space: write.address.space,
          scope: normalizeCellScope(write.address.scope),
          id: write.address.id as URI,
          type: (write.address.type ?? "application/json") as MediaType,
          paths: [writePath],
          valuesByPath: new Map([[pathKey(writePath), writtenValue]]),
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
// label. `undefined` (a removal) mints no stamp of its own; if the removed
// path carried labels, the SC-4 grow folds them into the written path's
// existence entry (see `clearedExistence` in the persist region), so only
// the removal of never-labeled paths stays unrecorded.
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
    observation: {
      shape: ReadObservationShape;
      nonRecursive: boolean | undefined;
      // True when a same-tx dereference-trace source covers this read
      // at-or-above (the C0 §6.1 row-4 machinery predicate). Probe reads
      // never arrive covered (they are skipped outright); a covered PLAIN
      // read is the resolution machinery's ordinary journal shape at a
      // followed slot, and is excluded from `*`-template consumption in
      // `deriveFlowJoin`.
      coveredByTrace: boolean;
    },
  ) => boolean,
): boolean => {
  // Probe reads issued while FOLLOWING a reference are resolution machinery,
  // not observations of their own (C0 §4's dereference row): the follow is
  // journaled as a dereference trace, and the taint of what was actually
  // read arrives via the ordinary reads of the target document. Recognize
  // them by the recorded trace sources: a probe at-or-below a followed
  // slot's path in the same document belongs to that dereference.
  let traceSourcesByDoc: Map<string, (readonly string[])[]> | undefined;
  const probeBelongsToDereference = (
    space: MemorySpace,
    id: URI,
    scope: ReturnType<typeof normalizeCellScope>,
    logicalPath: readonly string[],
  ): boolean => {
    if (traceSourcesByDoc === undefined) {
      traceSourcesByDoc = new Map();
      for (const trace of tx.getCfcState().dereferenceTraces) {
        const key = targetKey({
          space: trace.source.space,
          id: trace.source.id as URI,
          scope: normalizeCellScope(trace.source.scope),
        });
        let sources = traceSourcesByDoc.get(key);
        if (sources === undefined) {
          sources = [];
          traceSourcesByDoc.set(key, sources);
        }
        sources.push(canonicalizeLogicalPath(trace.source.path));
      }
    }
    const sources = traceSourcesByDoc.get(targetKey({ space, id, scope }));
    return sources !== undefined &&
      sources.some((source) => isPrefix(source, logicalPath));
  };
  for (const read of tx.getReadActivities?.() ?? []) {
    if (isInternalVerifierRead(read.meta)) {
      continue;
    }
    // Scheduler dependency seeding materializes declared deps so the
    // reactivity log covers them; it is scheduling machinery, not handler
    // consumption (§8.10.1) — the action body's own reads carry the taint.
    // Checked before probe classification: seeding resolves links, and its
    // probes carry both markers (ambient meta merges), so they stay
    // machinery, not followRef observations.
    if (isSchedulerDependencyRead(read.meta)) {
      continue;
    }
    if (flowReadExcluded(read.id, read.path)) {
      continue;
    }
    // Read classification (C1, C0 §4): a link-resolution probe that is NOT
    // part of a dereference this transaction performed observed WHICH
    // reference sits at the slot without following it — a followRef
    // observation. These used to be skipped outright, which was the SC-8
    // residual: the fact-of-which-element went unlabeled. They now consume
    // followRef-class entries (the pointer's own link-origin label) — and
    // only those; the target's content taint still arrives only via an
    // ordinary read of the target document. `nonRecursive` reads (key-add,
    // length, count) observe shape and membership; everything else is a
    // recursive value read.
    const logicalPath = canonicalizeLogicalPath(read.path);
    const space = read.space;
    const id = read.id as URI;
    const scope = normalizeCellScope(read.scope);
    const coveredByTrace = probeBelongsToDereference(
      space,
      id,
      scope,
      logicalPath,
    );
    let shape: ReadObservationShape;
    if (isLinkResolutionProbe(read.meta)) {
      if (coveredByTrace) {
        continue;
      }
      shape = "followRef";
    } else {
      shape = read.nonRecursive === true ? "shape" : "value";
    }
    if (
      consume(
        space,
        id,
        scope,
        (read.type ?? "application/json") as MediaType,
        logicalPath,
        // `coveredByTrace` extends the C0 §6.1 row-3/row-4 boundary to
        // PLAIN reads for the one entry kind whose consumption at slot
        // paths is new (the `*`-path class templates): resolution
        // machinery journals ordinary reads at followed slots and inside
        // their link sigils, and those must stay pointer HANDLING, not
        // pointer observation — see the template exclusion in
        // `deriveFlowJoin`.
        { shape, nonRecursive: read.nonRecursive, coveredByTrace },
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
  // canonicalization and applies `flowReadExcluded`). The path half of that
  // exclusion cannot be rechecked here — stored paths are canonical, where
  // a user `value.source` is indistinguishable from the raw `["source"]`
  // surface — but the id-based `cid:` check stays as defense in depth for
  // trigger entries that arrive by other construction paths: `cid:` docs
  // sit on an unverified write path any same-space writer can reach (audit
  // S5), so a poisoned labelMap on one must not join the flow derivation.
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
        { shape: "value", nonRecursive: false, coveredByTrace: false },
      )
    ) {
      return true;
    }
  }
  return false;
};

// The containers whose membership stamps THIS transaction re-derives this
// attempt — the §8.12.8 replace-from-criteria readback exclusion set
// (template-population §3.1). Two re-stamp routes, mirroring the persist
// region: containers a list coordinator DECLARED this reconcile
// (`recordCfcStructureContainer`), and container nodes of pure-link-structure
// value writes. A reconciling coordinator reads its own previous output as
// diff/identity scaffolding; with the `*`-child class templates persisted,
// those readback reads would resolve the very entries this attempt drops and
// re-mints — joining J_prev into J on every reconcile and turning the
// normative replace-from-criteria into the accumulate-forever §8.12.8
// rejects. So the writer's own flow join skips exactly the REPLACED entries
// (the enumerate stamp and the `*`-child templates of its own re-stamped
// containers); the frozen existence entry is not replaced and not excluded.
// Foreign readers — and this transaction's reads of every OTHER container —
// consume templates in full, which is what closes the SC-4/SC-8 residuals.
const ownRestampContainerPaths = (
  tx: IExtendedStorageTransaction,
): Map<string, Set<string>> => {
  const result = new Map<string, Set<string>>();
  const add = (key: string, containerPath: readonly string[]) => {
    let paths = result.get(key);
    if (paths === undefined) {
      paths = new Set();
      result.set(key, paths);
    }
    paths.add(pathKey(containerPath));
  };
  for (const addr of tx.getCfcState().structureContainers) {
    add(
      targetKey({
        space: addr.space,
        id: addr.id as URI,
        scope: normalizeCellScope(addr.scope),
      }),
      canonicalizeLogicalPath(addr.path),
    );
  }
  for (const [key, target] of valueWriteTargets(tx)) {
    for (const path of target.paths) {
      const written = target.valuesByPath.get(pathKey(path));
      if (written === undefined || !isPureLinkStructure(written)) {
        continue;
      }
      const containers: (readonly string[])[] = [];
      pureLinkContainerPaths(written, path, containers);
      for (const container of containers) {
        add(key, container);
      }
    }
  }
  return result;
};

// Whether `entry` is one of the membership entries a re-stamp of the given
// container paths replaces: the container-anchored enumerate stamp, or a
// `*`-child class template of one of the containers.
const isReplacedMembershipEntry = (
  entry: LabelMapEntry,
  containers: ReadonlySet<string>,
): boolean => {
  if (entry.origin !== "structure") {
    return false;
  }
  const entryPath = canonicalizeLogicalPath(entry.path);
  if (entry.observes === "enumerate") {
    return containers.has(pathKey(entryPath));
  }
  return entryPath.length > 0 &&
    entryPath[entryPath.length - 1] === "*" &&
    containers.has(pathKey(entryPath.slice(0, -1)));
};

// Exported for tests: the trigger-read cid: guard above defends
// construction paths that bypass the addCfcTriggerReads ingest filter, and
// with the tx state sealed (getCfcState() is a read-only view) the only way
// to exercise it is to hand deriveFlowJoin a state carrying a smuggled
// entry directly.
export const deriveFlowJoin = (
  tx: IExtendedStorageTransaction,
  options?: {
    /**
     * Collect the spaces of observations that contributed label content to
     * the join (inv-12 Stage 1): the per-target cross-space predicate in
     * `prepareBoundaryCommit` tests whether any labeled contribution
     * originated outside the destination space. Opt-in so the default path
     * — every prepare with `cfcLabelMetadataProtection: "off"` — allocates
     * nothing for it.
     */
    collectLabeledSpaces?: boolean;
  },
): {
  confidentiality: unknown[];
  integrity: unknown[];
  labeledSpaces?: ReadonlySet<MemorySpace>;
} => {
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
  const labeledSpaces = options?.collectLabeledSpaces === true
    ? new Set<MemorySpace>()
    : undefined;
  const metadataByDoc = new Map<string, CfcMetadata | undefined>();
  // §8.12.8 readback exclusion: see `ownRestampContainerPaths`.
  const ownRestamps = ownRestampContainerPaths(tx);
  forEachFlowObservation(
    tx,
    (space, id, scope, type, logicalPath, observation) => {
      const key = targetKey({ space, id, scope });
      if (!metadataByDoc.has(key)) {
        metadataByDoc.set(key, storedMetadataFor(tx, space, id, scope, type));
      }
      const ownedContainers = ownRestamps.get(key);
      // `*`-template consumption keeps the C0 §6.1 row-3/row-4 boundary the
      // probe channel already has, extended to PLAIN reads: resolution
      // machinery journals ordinary reads at followed slots (the slot
      // scalar, the sigil interior) on its way to the target, and those
      // must not consume the slot templates — the follow's taint arrives
      // via the target's own reads (row 4), while STANDALONE slot
      // observations (no covering trace) consume in full (row 3, the SC-8
      // closures). Without this, every traversal hop through a stamped
      // container smears the container's J onto whatever the transaction
      // writes — re-importing the pointwise smear the S16 substrate
      // removed (measured: the phase-B pointwise map suite).
      const excludesTemplates = observation.coveredByTrace ||
        ownedContainers !== undefined;
      const label = effectiveReadLabel(
        metadataByDoc.get(key),
        logicalPath,
        {
          nonRecursive: observation.nonRecursive,
          consumes: observation.shape,
          ...(excludesTemplates
            ? {
              excludeEntry: (entry: LabelMapEntry) =>
                (observation.coveredByTrace &&
                  isRuntimeMintedTemplate({
                    origin: entry.origin,
                    path: canonicalizeLogicalPath(entry.path),
                  })) ||
                (ownedContainers !== undefined &&
                  isReplacedMembershipEntry(entry, ownedContainers)),
            }
            : {}),
        },
      );
      // Any observation with label CONTENT marks its space as a label
      // contributor. Deliberately over-approximate for integrity (an
      // observation whose hereditary atoms all meet away still marks its
      // space): the join does not attribute surviving atoms to sources, so
      // ambiguity fails toward protection (inv-12 Stage 1).
      if (
        labeledSpaces !== undefined && label !== undefined &&
        ((label.confidentiality?.length ?? 0) > 0 ||
          (label.integrity?.length ?? 0) > 0)
      ) {
        labeledSpaces.add(space);
      }
      if (label?.confidentiality?.length) {
        atoms.push(...label.confidentiality);
      }
      // followRef observations contribute confidentiality only. The
      // hereditary meet quantifies over the transformation's CONTENT inputs
      // (§8.9.3 derives certification for what the tx computed from);
      // pointer-topology observations are transport, whose integrity
      // evidence is the LinkReference chain on the link entry itself.
      // Letting them into the meet would empty it on every terminal
      // resolution probe (probes rarely resolve a label), silently ending
      // TransformedBy/PolicyCertified propagation everywhere.
      if (observation.shape === "followRef") {
        return false;
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
  // Label-metadata observations (inv-12 Stage 2, the SC-6 revisit): the
  // introspection surface's explicit records join the derivation with their
  // §4.6.4.2 population-rule labels. Confidentiality only, like followRef
  // observations above: observing label METADATA is not consuming content,
  // so it must neither seed nor empty the hereditary integrity meet. The
  // observation's space counts as a label contributor for the Stage 1
  // cross-space predicate — a foreign doc's metadata observed here makes the
  // stamped entry representation-eligible, same posture as a foreign labeled
  // read.
  for (const observation of tx.getCfcState().labelMetadataObservations) {
    if (observation.confidentiality.length === 0) continue;
    labeledSpaces?.add(observation.target.space);
    atoms.push(...observation.confidentiality);
  }
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
  return {
    confidentiality,
    integrity: uniqueCfcAtoms(integrity),
    ...(labeledSpaces !== undefined ? { labeledSpaces } : {}),
  };
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
    { any: boolean; entries: readonly LabelMapEntry[] }
  >();
  const docEntries = (
    space: MemorySpace,
    id: URI,
    scope: ReturnType<typeof normalizeCellScope>,
    type: MediaType,
  ): { any: boolean; entries: readonly LabelMapEntry[] } => {
    const key = targetKey({ space, id, scope });
    let known = entriesByDoc.get(key);
    if (known === undefined) {
      if (selfMintedDocs.has(key)) {
        known = { any: false, entries: [] };
      } else {
        const entries =
          storedMetadataFor(tx, space, id, scope, type)?.labelMap.entries ??
            [];
        known = { any: entries.length > 0, entries };
      }
      entriesByDoc.set(key, known);
    }
    return known;
  };
  // Read side mirrors the J derivation's class selection: an entry makes a
  // tx relevant only when a read class the tx performed consumes it. A doc
  // holding only link-origin (implicit followRef) entries is relevant to a
  // standalone probe read — the SC-8 consumption — but still not to
  // value/shape reads.
  if (
    forEachFlowObservation(
      tx,
      (space, id, scope, type, _logicalPath, observation) =>
        docEntries(space, id, scope, type).entries.some((entry) =>
          readConsumesEntry(observation.shape, entry)
        ),
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
    // Record-only `additionalProperties` descends as the same `*` segment
    // arrays get from `items` (template-population §4) — RESTRICTED to
    // record-only objects (no NAMED property). The restriction is
    // load-bearing: `isPrefix`'s `*` matches ANY segment, but
    // `additionalProperties` semantically covers only keys NOT listed under
    // `properties` (schemaAtPath consults it only on a properties miss), so
    // an unrestricted `*` entry from a mixed schema would over-taint the
    // named fields. Mixed fixed-plus-record-tail schemas therefore mint no
    // `*` entry (expressing them needs exclusion semantics §3.3 forbids).
    // An EMPTY `properties` object is still record-only — it names no key,
    // so every key is a properties miss and `additionalProperties` covers
    // all of them; schema helpers routinely emit that wrapper shape, and
    // skipping it would silently drop the declared map label (codex/cubic
    // review on this PR).
    if (
      (resolved.properties === undefined ||
        Object.keys(resolved.properties).length === 0) &&
      typeof resolved.additionalProperties === "object" &&
      resolved.additionalProperties !== null
    ) {
      walkIfcSchema(
        resolved.additionalProperties,
        [...path, "*"],
        entries,
        childRoot,
        active,
      );
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

// The consumption class an authored schema declares for its ifc label (C5).
// Only the four class values count; anything else (including absence) is
// covering — the over-taint direction, so a typo'd class can only widen
// consumption, never narrow it (fail-safe).
const declaredObservesClass = (
  schema: JSONSchema,
): LabelObservationClass | undefined => {
  const observes = isRecord(schema) && isRecord(schema.ifc)
    ? (schema.ifc as { observes?: unknown }).observes
    : undefined;
  return observes === "value" || observes === "shape" ||
      observes === "enumerate" || observes === "followRef"
    ? observes
    : undefined;
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

// FORBIDDEN_OR_CLAUSE_ALTERNATIVE_TYPES (the §3.1.8 principal-like
// discipline) moved to clause.ts — it is now shared with the grant-audience
// validation in grants.ts (§8.12.7 route 2a), which enforces the same
// rejection on grant audience entries at write time.
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

// §8.3 projection claims. The lowered authored form (`Projection` /
// `ProjectionOf` / `ProjectionPath` in @commonfabric/api/cfc) is
// `{ from, path }`: this entry's value is the field at JSON pointer `path`
// inside the structured value at logical path `from` of the SAME document
// (like `exactCopyOf`, cross-document claims are not expressible — a link at
// the source path compares as the link sigil and fails closed). Both
// pointers use the CanonicalPointer dialect: "/" is the root, segments are
// ~0/~1-escaped.
type ProjectionClaim = {
  // Logical path of the structured source value within the document.
  source: readonly string[];
  // Pointer segments of the projected field inside the source value.
  field: readonly string[];
};

const decodePointerSegment = (segment: string): string =>
  segment.replaceAll("~1", "/").replaceAll("~0", "~");

const parseCanonicalPointer = (
  pointer: unknown,
): readonly string[] | undefined => {
  if (typeof pointer !== "string" || !pointer.startsWith("/")) {
    return undefined;
  }
  if (pointer === "/") {
    return [];
  }
  return pointer.slice(1).split("/").map(decodePointerSegment);
};

// `undefined` = no claim on this schema; `"malformed"` = a claim is present
// but unparseable — the caller must fail closed (a schema arriving from
// storage or the wire is not typed; silently skipping verification would
// accept the claim unverified, audit S10's posture).
const projectionClaimSpec = (
  schema: JSONSchema,
): ProjectionClaim | "malformed" | undefined => {
  const ifc = isRecord(schema) && isRecord(schema.ifc)
    ? schema.ifc as { projection?: unknown }
    : undefined;
  const claim = ifc?.projection;
  if (claim === undefined) {
    return undefined;
  }
  if (!isRecord(claim)) {
    return "malformed";
  }
  const source = parseCanonicalPointer(claim.from);
  const field = parseCanonicalPointer(claim.path);
  if (source === undefined || field === undefined) {
    return "malformed";
  }
  return { source: canonicalizeLogicalPath(source), field };
};

// A schema-entry path (a `pathKey` — the canonical pointer encoding) parsed
// back to segments. Entry paths use "*" for array-item / record-value
// positions (walkIfcSchema).
const entryPathFromKey = (key: string): readonly string[] =>
  key === "" ? [] : key.slice(1).split("/").map(decodePointerSegment);

// Does a schema-entry path cover a PREFIX of a concrete source path? "*"
// matches any concrete segment: an items-level label applies uniformly to
// every element, so treating it as covering a concrete index is exact — the
// exact-`Map.get` alternative silently DROPPED the items-level label for a
// concrete-element projection (fail-open label loss; review P1).
const entryPathCoversPrefix = (
  entryPath: readonly string[],
  source: readonly string[],
): boolean =>
  entryPath.length <= source.length &&
  entryPath.every((segment, i) => segment === "*" || segment === source[i]);

// §8.3.2 scoped-integrity carry for a verified projection claim: the
// projected field inherits the source's confidentiality in full (§8.3.1) and
// carries the source's integrity SCOPED to the projected pointer — the
// projection can never claim whole-object integrity (§8.3.4 goal 1), while
// checked recomposition (`recomposeProjections`) stays unsupported. Every
// source schema entry covering the projected location contributes, each
// scoped by the pointer of the projected field RELATIVE to that entry (a
// deeper source location makes a longer residual claim); the entry AT the
// projected location itself is an exact copy, so its atoms carry unscoped
// (§8.3.4's interop note: no `projection: "/"`). Dropped, fail-closed:
// - string atoms (no field to carry the scope binding),
// - provenance-class atoms (facts about how a specific value came to be —
//   the propagation-class registry forbids any claim carrying them onto an
//   output; see atom-classes.ts),
// - atoms whose existing `scope` is not a record (cannot be extended).
// Like the `exactCopyOf` carry, the result feeds `derivePersistedLabel`,
// so `gateRuntimeMintedIntegrity` still strips runtime-minted evidence from
// non-builtin-authored writes downstream.
const projectedSourceLabel = (
  sourceEntryLabels: Map<string, IFCLabel>,
  claim: ProjectionClaim,
): IFCLabel => {
  const source = canonicalizeLogicalPath([...claim.source, ...claim.field]);
  const confidentiality: unknown[] = [];
  const integrity: unknown[] = [];
  // Map insertion order is the schema-walk order (parents before children),
  // so contributions stay ordered ancestor-first along the source lineage.
  for (const [key, label] of sourceEntryLabels) {
    const entryPath = entryPathFromKey(key);
    if (!entryPathCoversPrefix(entryPath, source)) {
      continue;
    }
    confidentiality.push(...label.confidentiality ?? []);
    const relative = source.slice(entryPath.length);
    for (const atom of label.integrity ?? []) {
      if (relative.length === 0) {
        integrity.push(atom);
        continue;
      }
      if (!isRecord(atom) || atomPropagationClass(atom) === "provenance") {
        continue;
      }
      const scope = (atom as { scope?: unknown }).scope;
      if (scope !== undefined && !isRecord(scope)) {
        continue;
      }
      integrity.push({
        ...atom,
        scope: { ...(scope ?? {}), projection: encodePointer(relative) },
      });
    }
  }
  return {
    confidentiality: confidentiality.length > 0 ? confidentiality : undefined,
    integrity: integrity.length > 0 ? integrity : undefined,
  };
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

// ---------------------------------------------------------------------------
// Epic D4 — per-write read-prefix provenance
// (docs/specs/cfc-write-prefix-provenance.md). Each protected write is gated
// on only the reads that could have fed it: those whose activity-clock
// position (journalIndex) precedes the LAST write attempt whose target
// overlaps the protected path — overlap in EITHER prefix direction, the same
// match as floor applicability (`ifcEntryAppliesToAttemptedWrite`). This is
// a structural precision fact of the journal order in the §8.9.1
// decomposition class, NOT a trusted flow-precision claim: the committed
// value of the subtree at P is fixed by its last overlapping write, so a
// read after it provably did not feed that value (doc §4), and dropping it
// needs no `flow-taint-precision` trust gate. The bound is deliberately NOT
// the write's first attempt (unsound under re-attempts — doc §3's
// counterexample: write P, read R, re-write P = f(R) would exclude R) and
// NOT keyed on the exact address (a later write to P.child re-creates the
// same escape one level down — doc §4).

type WritePrefixBounds = {
  /**
   * Activity-clock bound for a protected path on `target`: the journalIndex
   * of the last write attempt overlapping `path`, or +Infinity when the
   * order is unknown for that path — no logged overlapping attempt (e.g. an
   * attempted-but-unapplied write made the entry applicable) or a backend
   * without the activity clock. +Infinity degrades to transaction-global
   * gating: every read gates, today's conservative behavior — the fallback
   * can only over-gate, never admit a read the sound bound would exclude.
   */
  boundFor(
    target: {
      space: MemorySpace;
      id: URI;
      scope: ReturnType<typeof normalizeCellScope>;
    },
    path: readonly string[],
  ): number;
  /**
   * Stage-0 instrumentation only (docs/specs/cfc-value-level-provenance.md
   * §6): whether the transaction logged ANY value-surface write attempt.
   * False means the order source was absent or empty — every +Infinity
   * bound then degrades for lack of a clock, not for lack of an
   * overlapping attempt. Never consulted by enforcement.
   */
  sawLoggedAttempts(): boolean;
};

const buildWritePrefixBounds = (
  tx: IExtendedStorageTransaction,
): WritePrefixBounds => {
  let byTarget:
    | Map<string, Array<{ path: readonly string[]; journalIndex: number }>>
    | undefined;
  const load = () => {
    if (byTarget !== undefined) return byTarget;
    byTarget = new Map();
    for (const attempt of tx.getWriteAttemptLog?.() ?? []) {
      const raw = attempt.path;
      // Only value-surface writes finalize user-visible values. A raw
      // ["cfc"]/["source"] surface write is runtime bookkeeping — it never
      // rewrites the value at a protected path, so it must not extend the
      // path's prefix (the CFC label persistence in prepareBoundaryCommit
      // itself appends ["cfc"] attempts after verification; counting those
      // would also make the bound depend on prepare-internal activity). A
      // raw path-[] write replaces the whole envelope, value included; it
      // canonicalizes to the root path and overlaps every path in the
      // document.
      if (raw.length > 0 && raw[0] !== "value") continue;
      const key = targetKey({
        space: attempt.space,
        id: attempt.id as URI,
        scope: normalizeCellScope(attempt.scope),
      });
      let list = byTarget.get(key);
      if (list === undefined) {
        list = [];
        byTarget.set(key, list);
      }
      list.push({
        path: canonicalizeLogicalPath(raw),
        journalIndex: attempt.journalIndex,
      });
    }
    return byTarget;
  };
  return {
    boundFor(target, path) {
      const attempts = load().get(targetKey(target));
      if (attempts === undefined || attempts.length === 0) return Infinity;
      // Wildcard entries bound at their concrete prefix: every write
      // overlapping a concrete instantiation of the pattern also overlaps
      // the concrete prefix, so this can only raise the bound (gate more
      // reads) — conservative.
      const wildcardIndex = path.indexOf("*");
      const probe = wildcardIndex === -1 ? path : path.slice(0, wildcardIndex);
      let bound = -Infinity;
      for (const attempt of attempts) {
        if (
          concretePathHasPrefix(probe, attempt.path) ||
          concretePathHasPrefix(attempt.path, probe)
        ) {
          if (attempt.journalIndex > bound) bound = attempt.journalIndex;
        }
      }
      return bound === -Infinity ? Infinity : bound;
    },
    sawLoggedAttempts() {
      return load().size > 0;
    },
  };
};

// ---------------------------------------------------------------------------
// Stage 0 of the value-level-provenance design
// (docs/specs/cfc-value-level-provenance.md §6, SC-24): per-prepare
// precision counters measuring how much the shipped D4 prefix narrows the
// gated-read set versus the pre-D4 transaction-global gate, before any span
// machinery exists. Measurement only: nothing here feeds an enforcement
// decision, the summary is collected exclusively when a hook consumes it,
// and the hook-absent path pays one presence check.

/** How a protected write's activity-clock bound was obtained. */
export type CfcPrefixBoundSource =
  /** A logged overlapping write attempt — the prefix engaged. */
  | "real"
  /**
   * +Infinity fallback: the transaction logged write attempts, but none
   * overlapped this path (e.g. the entry was made applicable by an
   * attempted-but-unapplied write). Transaction-global gating for this
   * write.
   */
  | "infinityFallback"
  /**
   * The transaction logged no ordered write attempt at all — a backend
   * without the activity clock, or a transaction whose only overlapping
   * writes were never applied. Every bound degrades to +Infinity.
   */
  | "clockLess";

/** Per-protected-write detail row of a CfcPrefixProvenanceSummary. */
export type CfcPrefixProvenanceWrite = {
  /** Document id of the protected write's target. */
  id: string;
  /**
   * Protected schema-entry path as an RFC 6901 JSON pointer (e.g. "/out";
   * "" is the root; "~"/"/" in property names escape as "~0"/"~1"), so
   * consumers can recover the exact segments via parsePointer.
   */
  path: string;
  boundSource: CfcPrefixBoundSource;
  /** Gated reads within this write's D4 prefix (post-S7-exemption). */
  prefixGatedReads: number;
  /** What the pre-D4 transaction-global gate would have counted. */
  txGlobalGatedReads: number;
  /** Provenance-only reads within the prefix the S7 exemption excluded. */
  s7ExemptionFires: number;
};

/**
 * Per-prepare D4 precision summary, emitted at most once per
 * prepareBoundaryCommit — and only when at least one protected write
 * (a schema entry with requiredIntegrity or maxConfidentiality applying to
 * an attempted write) was measured.
 */
export type CfcPrefixProvenanceSummary = {
  /** Protected writes measured (may exceed writes.length — see the cap). */
  protectedWrites: number;
  /** Sum of per-write prefix-gated read counts. */
  prefixGatedReads: number;
  /** Sum of per-write pre-D4 transaction-global gated-read counts. */
  txGlobalGatedReads: number;
  /** Bound-source classification counts across protected writes. */
  boundSources: {
    real: number;
    infinityFallback: number;
    clockLess: number;
  };
  /** Total S7 provenance-only exemption fires within prefixes. */
  s7ExemptionFires: number;
  /**
   * Non-internal read activities without an activity-clock position,
   * treated at -Infinity (joining every prefix). Deliberate -Infinity
   * trigger reads are not counted. Same read set for every protected
   * write, so this is per-prepare, not per-write.
   */
  clockLessReads: number;
  /** Per-write detail, capped at CFC_PREFIX_PROVENANCE_MAX_WRITES. */
  writes: CfcPrefixProvenanceWrite[];
};

/** Cap on the per-write detail list in a CfcPrefixProvenanceSummary. */
export const CFC_PREFIX_PROVENANCE_MAX_WRITES = 16;

/** Optional measurement hooks threaded into prepareBoundaryCommit. */
export type CfcPrepareInstrumentation = {
  onPrefixProvenance?: (summary: CfcPrefixProvenanceSummary) => void;
};

const createPrefixProvenanceSummary = (): CfcPrefixProvenanceSummary => ({
  protectedWrites: 0,
  prefixGatedReads: 0,
  txGlobalGatedReads: 0,
  boundSources: { real: 0, infinityFallback: 0, clockLess: 0 },
  s7ExemptionFires: 0,
  clockLessReads: 0,
  writes: [],
});

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
// not gate a requiredIntegrity write: the quantification would otherwise
// false-reject an unrelated protected write (audit S7 — e.g.
// cfc-group-chat-demo's admin grant reads adminRegistry.bootstrapAdmin.subject,
// label [represents-principal, LinkReference], and that lookup fails the admins
// list's requiredIntegrity:[group-chat-admin]). A read carrying ANY
// confidentiality, or any genuine endorsement integrity atom, stays in the gate
// — that keeps the cross-cell prompt-injection screen sound (its briefing reads
// carry confidentiality; its endorsement reads carry real integrity).
//
// D4 scoped this exemption to each write's read prefix (both #4015 follow-ons
// landed — docs/specs/cfc-write-prefix-provenance.md §5): a provenance read
// past the last write overlapping a protected path no longer needs exempting
// (the prefix already excludes it), so the exemption only ever fires for
// provenance reads that could have fed the write. Provenance-only reads still
// count as "the write had labeled input" for the #14 empty-prefix arm — the
// group-chat admin-grant shape (provenance lookup + protected write, no
// endorsed read, no mint) must keep committing.
const isProvenanceOnlyConsumedLabel = (label: IFCLabel): boolean => {
  if ((label.confidentiality?.length ?? 0) > 0) return false;
  const integrity = label.integrity ?? [];
  return integrity.length > 0 &&
    integrity.every(isNonEndorsementProvenanceAtom);
};

// Trust context for CONCEPT-valued requiredIntegrity floors (Epic D5): the
// deployment trust closure plus the acting principal, built from tx CFC state
// exactly like `evaluateGatedConfidentiality` — SAME resolver, SAME acting
// principal — so the floor gates and the exchange-rule guards agree on concept
// satisfaction. A concept floor ("minted by a valid GPS measurement") then
// accepts any concrete atom above the concept in THIS user's closure; plain
// (concrete/pattern) floors ignore it (inv-11: concrete integrity portable,
// concept satisfaction acting-principal scoped).
const cfcFloorTrustContext = (
  tx: IExtendedStorageTransaction,
): CfcFloorTrustContext => {
  const state = tx.getCfcState();
  return {
    trustResolver: createTrustResolver(state.trustConfig),
    actingPrincipal: state.trustSnapshot?.actingPrincipal,
  };
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
  identityForPath: (
    path: readonly string[],
  ) => ImplementationIdentity | undefined,
  // D4 write-prefix provenance (docs/specs/cfc-write-prefix-provenance.md):
  // the per-path last-overlapping-write bounds each entry's input checks
  // quantify under.
  prefixBounds: WritePrefixBounds,
  // Stage-0 precision counters (docs/specs/cfc-value-level-provenance.md §6),
  // accumulated across the boundary pass. undefined — the default, whenever
  // no onPrefixProvenance hook is installed — skips all measurement.
  provenance?: CfcPrefixProvenanceSummary,
): string | undefined => {
  // The labeled reads the per-entry checks below quantify over, each carrying
  // its activity-clock position. Distinct from the egress side's consumed set
  // (collectConsumedLabel), which stays transaction-global — a sink request
  // records no per-write provenance, so the whole consumed set is the sound
  // over-approximation there (doc §7.4). Deliberately class-blind
  // (`consumes: "all"`): the gate is a screen over everything the tx
  // consumed, and over-inclusive quantification is the fail-safe direction
  // for it; per-class narrowing of consumers is C4.
  //
  // Provenance-only reads are NOT filtered here (unlike before D4): the S7
  // exemption is applied per entry, inside that entry's prefix.
  // Stage-0 measurement: read activities lacking a clock position (counted
  // below only while a hook collects; the enforcement path pays a
  // short-circuited presence check per read, nothing else).
  let clockLessReads = 0;
  const gatedReads = [
    ...[...(tx.getReadActivities?.() ?? [])].filter((read) =>
      !isInternalVerifierRead(read.meta)
    ).map((read) => {
      if (provenance !== undefined && read.journalIndex === undefined) {
        clockLessReads += 1;
      }
      return {
        ...read,
        // A read without a clock position (journal-less backend) is treated
        // as preceding every write: it joins every prefix — conservative.
        journalIndex: read.journalIndex ?? -Infinity,
      };
    }),
    // §8.9.2 / SC-3 (H5): the trigger reads join the gate when enabled — a
    // handler scheduled by a labeled write must satisfy requiredIntegrity even
    // if its branch never re-reads that write. Empty when the flag is off.
    // Trigger reads have no journal position — their invalidating writes
    // scheduled the run, so they logically precede every write in the attempt
    // and sit at -Infinity, joining EVERY protected write's prefix (doc §4);
    // anything else would let the scheduling channel escape the per-write
    // gate.
    ...triggerReadSources(tx).map((read) => ({
      ...read,
      journalIndex: -Infinity,
    })),
  ].map((read) => ({
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
      { nonRecursive: read.nonRecursive, consumes: "all" },
    ),
  })).filter((read) =>
    read.label !== undefined &&
    // A present-but-empty label ({} — no atoms) is the same trust level as an
    // absent one (excluded above); whether metadata materialized an empty
    // entry is a persistence/sync artifact and must not decide gate
    // membership.
    hasLabelValues(read.label)
  );
  // Label-metadata observations (inv-12 Stage 2) join the gate with their
  // pre-resolved §4.6.4.2 population labels. Like trigger reads they have no
  // journal position, so they sit at -Infinity and join EVERY protected
  // write's prefix — the conservative direction for a screen, and only new
  // introspection-using code ever records one (no existing flow regresses).
  // Confidentiality-only records: never provenance-only, never a floor
  // witness.
  for (const observation of tx.getCfcState().labelMetadataObservations) {
    gatedReads.push({
      space: observation.target.space,
      id: observation.target.id as URI,
      scope: normalizeCellScope(observation.target.scope),
      path: canonicalizeLogicalPath(observation.target.path),
      type: "application/json",
      meta: {},
      journalIndex: -Infinity,
      label: { confidentiality: [...observation.confidentiality] },
    });
  }

  // Stage-0 measurement: the pre-D4 comparison baseline. Before D4 the gate
  // quantified over every labeled read with the S7 provenance-only exemption
  // applied transaction-globally — so the baseline is the label filter
  // without the prefix condition. The gate-visible read set is the same on
  // every call within one prepare, hence assignment (not accumulation) for
  // the per-prepare clock-less count.
  const txGlobalGatedReads = provenance === undefined ? 0 : gatedReads
    .filter((read) => !isProvenanceOnlyConsumedLabel(read.label!))
    .length;
  if (provenance !== undefined) {
    provenance.clockLessReads = clockLessReads;
  }

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
      identityForPath(entry.path),
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
    const maxConfidentiality = ifc?.maxConfidentiality;
    const protectedEntry = requiredIntegrity.length > 0 ||
      maxConfidentiality !== undefined;
    // D4: quantify this entry's input checks over its own read prefix —
    // labeled reads whose clock position precedes the last write attempt
    // overlapping this path. A read at-or-after that write provably did not
    // feed the committed value here (structural fact, doc §4), so it no
    // longer gates this entry. A +Infinity bound (order unknown for this
    // path) keeps every read: transaction-global, the pre-D4 conservative
    // behavior.
    const bound = protectedEntry
      ? prefixBounds.boundFor(target, entry.path)
      : -Infinity;
    // Provenance-only reads (link/origin/current-principal, no
    // confidentiality) are structural plumbing, not endorsable inputs —
    // exempting them stops the quantification from false-rejecting unrelated
    // protected writes (audit S7), now only ever needed for reads WITHIN the
    // prefix. Confidentiality- or endorsement-bearing reads stay, keeping
    // the prompt-injection screen sound.
    const gating = gatedReads.filter((read) =>
      read.journalIndex < bound &&
      !isProvenanceOnlyConsumedLabel(read.label!)
    );
    // Stage-0 precision counters (cfc-value-level-provenance.md §6): what
    // the shipped prefix did for THIS protected write versus the pre-D4
    // transaction-global quantification. Recorded before the entry's own
    // checks so a rejecting write is still measured; nothing below reads
    // these values.
    if (provenance !== undefined && protectedEntry) {
      let inPrefix = 0;
      for (const read of gatedReads) {
        if (read.journalIndex < bound) inPrefix += 1;
      }
      // Within-prefix reads excluded as provenance-only structural plumbing
      // — exactly where the S7 exemption still fires under D4.
      const s7ExemptionFires = inPrefix - gating.length;
      const boundSource: CfcPrefixBoundSource = bound !== Infinity
        ? "real"
        : prefixBounds.sawLoggedAttempts()
        ? "infinityFallback"
        : "clockLess";
      provenance.protectedWrites += 1;
      provenance.prefixGatedReads += gating.length;
      provenance.txGlobalGatedReads += txGlobalGatedReads;
      provenance.boundSources[boundSource] += 1;
      provenance.s7ExemptionFires += s7ExemptionFires;
      if (provenance.writes.length < CFC_PREFIX_PROVENANCE_MAX_WRITES) {
        provenance.writes.push({
          id: target.id,
          // RFC 6901 escaping, so a consumer can round-trip the pointer to
          // the exact schema-entry segments even when a property name
          // contains "/" or "~" (parsePointer is the inverse). Deliberately
          // NOT logicalPathToPointer: entry.path is already value-relative,
          // and its canonicalization would strip a root property literally
          // named "value".
          path: encodePointer(entry.path),
          boundSource,
          prefixGatedReads: gating.length,
          txGlobalGatedReads,
          s7ExemptionFires,
        });
      }
    }
    // An empty gating set passes here — but it is NOT the pre-D4 vacuous
    // pass (audit #14, "a requiredIntegrity gate whose consumed set is empty
    // passes"). The prefix makes the empty case a sound DELEGATION: with no
    // read that could have fed the write, the only possible endorsement is
    // the one the written value itself carries, and that is exactly what the
    // D3 write floor verifies (same schema entry, same derivation —
    // `verifyWriteFloor` below) under its staged dial. Under
    // `cfcWriteFloor:"enforce"` an empty-prefix floored write with no
    // credited value rejects there ("write floor failed"); rejecting here
    // too would only duplicate that reason, and rejecting UNCONDITIONALLY
    // (dial off/observe) would break the floor's pinned byte-compat rollout
    // — the read-side half of #14 rides the same dial as the write-side
    // half by design.
    if (requiredIntegrity.length > 0 && gating.length > 0) {
      // Coherent satisfaction (§8.10.3, Epic B5): each requirement must be
      // met by ONE shared witness atom across every gated read, not by a
      // different witness per read — "each input was screened by someone"
      // is not "the inputs were screened". The single-read case reduces to
      // the plain floor. Quantifies over D4's per-write prefix `gating`, not
      // the transaction-global `gatedReads`.
      const ok = cfcIntegritySatisfiesFloorCoherently(
        gating.map((read) => read.label?.integrity ?? []),
        requiredIntegrity,
        cfcFloorTrustContext(tx),
      );
      if (!ok) {
        return `requiredIntegrity failed at /${entry.path.join("/")}`;
      }
    }

    // undefined means no ceiling; a declared (even empty) ceiling is enforced.
    // An empty ceiling is "public only": any consumed confidential atom fails.
    // Quantifies over the same prefix-scoped gating set as requiredIntegrity
    // (a read past the last overlapping write cannot have fed this value);
    // an empty set passes — a ceiling over nothing consumed is genuinely
    // satisfied. `maxConfidentiality` is declared with the D4 `bound` above.
    if (maxConfidentiality !== undefined && gating.length > 0) {
      // The pre-dial membership check, kept verbatim as the `off` path (and
      // the `observe` decision path — observe evaluates but never decides
      // differently) — EXCEPT for commitment forms (inv-12 Stage 1): a
      // consumed label whose clause was persisted committed
      // (`User({digestOf: H(alice)})`) must still fit a plaintext ceiling
      // naming the same principal, independent of the policy-evaluation
      // dial — the deepEqual freeze predates the representation transform
      // and would otherwise reject legitimately-protected cross-space
      // entries (codex/cubic P1 on the Stage 1 PR). Pre-Stage-1 data
      // carries no markers, so the extra arm is byte-inert for it; the
      // containment pre-check keeps the dominant plaintext path a single
      // deepEqual per pair.
      const fitsLegacy = (confidentiality: readonly unknown[]): boolean =>
        confidentiality.every((value) =>
          maxConfidentiality.some((allowed) =>
            deepEqual(allowed, value) ||
            ((containsCfcFieldCommitment(value) ||
              containsCfcFieldCommitment(allowed)) &&
              commitmentAwareEquals(allowed, value))
          )
        );
      const mode = tx.getCfcState().policyEvaluationMode;
      const ok = gating.every((read) => {
        const confidentiality = read.label?.confidentiality ?? [];
        if (mode === "off") return fitsLegacy(confidentiality);
        // Evaluate the consumed label to fixpoint (Epic B5). No boundary
        // atoms: this is a write-target input gate, not a sink. A gated
        // WRITE is a consuming site for single-use grants — the ceiling
        // decision persists with the written value — but only under the
        // enforce dial, where this evaluation's outcome IS the decision.
        const outcome = evaluateGatedConfidentiality(
          tx,
          confidentiality,
          read.label?.integrity ?? [],
          [],
          mode === "enforce" ? "consuming" : "observing",
        );
        if (mode === "enforce") {
          // Exhaustion fails closed; otherwise subsumption-fit the REWRITTEN
          // label (spec §8.10.3 clause fit — flat ceilings keep their
          // conjunctive meaning through atomsOutsideCeiling).
          return outcome.exhausted === false &&
            atomsOutsideCeiling(outcome.confidentiality, maxConfidentiality)
                .length === 0;
        }
        // observe: decide exactly as `off` would, diagnose the divergence.
        const decision = fitsLegacy(confidentiality);
        const rewrittenFits = outcome.exhausted === false &&
          atomsOutsideCeiling(outcome.confidentiality, maxConfidentiality)
              .length === 0;
        if (outcome.exhausted) {
          tx.noteCfcDiagnostic(
            `policy-evaluation(observe): fuel exhausted for input ` +
              `requirement at /${entry.path.join("/")}`,
          );
        } else if (decision !== rewrittenFits) {
          tx.noteCfcDiagnostic(
            `policy-evaluation(observe): rewrite would change ` +
              `maxConfidentiality at /${entry.path.join("/")} from ` +
              `${decision ? "fit" : "reject"} to ${
                rewrittenFits ? "fit" : "reject"
              } (${outcome.firings} firings)`,
          );
        }
        return decision;
      });
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

// §8.3 projection-claim verification, the exactCopyOf discipline applied to
// a sub-path: the written target value must equal the value at
// `from + path` inside the same document, reconstructed from this
// transaction's writes. A claim that cannot be verified (malformed shape,
// wildcard path) fails closed rather than being silently skipped.
const verifyProjectionRequirements = (
  tx: IExtendedStorageTransaction,
  target: {
    space: MemorySpace;
    id: URI;
    scope: ReturnType<typeof normalizeCellScope>;
  },
  schema: JSONSchema,
): string | undefined => {
  for (const entry of walkIfcSchema(schema)) {
    const claim = projectionClaimSpec(entry.schema);
    if (claim === undefined) {
      continue;
    }
    // Only verify a claim whose target path the transaction actually wrote
    // (mirrors verifyExactCopyRequirements: an untouched entry compares
    // undefined to undefined and would accept the claim — and copy its
    // label — unverified).
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
    if (claim === "malformed") {
      return `malformed projection claim at /${entry.path.join("/")}`;
    }
    const sourcePath = canonicalizeLogicalPath([
      ...claim.source,
      ...claim.field,
    ]);
    // Array-item (wildcard) claims are unsupported for the same reason as
    // exactCopyOf (audit W2.15): the per-path value reconstruction matches
    // segments literally, so "*" never resolves against a concrete write and
    // the comparison would pass vacuously. Fail closed.
    if (entry.path.includes("*") || sourcePath.includes("*")) {
      return `projection claim under an array wildcard is unsupported at /${
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
      return `projection claim failed at /${entry.path.join("/")}`;
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
  // §8.3 projection carry — full confidentiality, scoped integrity (see
  // projectedSourceLabel). A malformed claim carries nothing: verification
  // already rejects it fail-closed, and non-rejecting enforcement modes must
  // not copy a label the claim never earned.
  const projectionClaim = sourceEntryLabels !== undefined
    ? projectionClaimSpec(schema)
    : undefined;
  const projectedInputLabel =
    projectionClaim !== undefined && projectionClaim !== "malformed"
      ? projectedSourceLabel(sourceEntryLabels!, projectionClaim)
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
      projectedInputLabel?.confidentiality?.map(normalizeClause),
    ),
    integrity: mergeLabelValues(
      resolveCurrentPrincipalLabelValues(
        schemaLabel.integrity,
        actingPrincipal,
      ),
      copiedInputLabel?.integrity,
      projectedInputLabel?.integrity,
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
  // Exchange-rule evidence families (Epic B1, spec §15.4/§10.1): screening
  // verdicts, disclosure/acknowledgment/disclaimer events, assessor
  // judgments, role membership, and boundary context are all minted by
  // trusted runtime surfaces (detectors, the UI runtime, membership lookup,
  // the boundary evaluator). A pattern-authored schema that could self-attach
  // any of them would forge the guard evidence exchange rules fire on —
  // upgrading its own caveat tier or discharging its own material risk.
  CFC_ATOM_TYPE.BoundaryContext,
  CFC_ATOM_TYPE.CaveatAssessment,
  CFC_ATOM_TYPE.CaveatScreened,
  CFC_ATOM_TYPE.DisclaimerAttached,
  CFC_ATOM_TYPE.DisclosureAcknowledged,
  CFC_ATOM_TYPE.DisclosureRendered,
  CFC_ATOM_TYPE.HasRole,
  // Conceptual principals live in trust statements and rule guards, never in
  // carried integrity: concept guards resolve exclusively through the trust
  // closure (exchange-eval), so a literal Concept atom in a value label is
  // meaningless at best and bait for a config that pool-matches it at worst.
  // Belt: schemas cannot mint one.
  CFC_ATOM_TYPE.Concept,
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

// `sourceMetadata` is returned alongside the derived label so the persist
// loop can re-derive the source's sub-path entries from the same stored
// state without a second store read (inv-12 Stage 0, see the loop).
const derivePersistedLinkLabel = (
  tx: IExtendedStorageTransaction,
  input: LinkWritePolicyInput,
  candidateSchemas: ReadonlyMap<string, JSONSchema>,
  authoringIdentity: ImplementationIdentity | undefined,
): { label?: IFCLabel; reason?: string; sourceMetadata?: CfcMetadata } => {
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
  const withMetadata = sourceMetadata === undefined ? {} : { sourceMetadata };
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
  return { label, ...withMetadata };
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
  // Coalesce per (path, origin, observes): same-component same-class entries
  // at one path merge; entries of different components stay separate so each
  // can follow its own update discipline (declared monotone, link/derived
  // per-value), and entries of different observation classes stay separate
  // so each keeps its own consumers — merging a `value` and a `shape` entry
  // into one covering entry would both widen consumption and destroy the
  // SC-4 grow-vs-replace split (C2).
  const byKey = new Map<string, LabelMapEntry>();
  for (const entry of entries) {
    const path = [...entry.path];
    const key = `${entry.origin ?? ""}\u0000${entry.observes ?? ""}\u0000${
      pathKey(path)
    }`;
    const existing = byKey.get(key);
    byKey.set(key, {
      path,
      label: mergeLabels(existing?.label, cloneLabel(entry.label)),
      ...(entry.origin !== undefined ? { origin: entry.origin } : {}),
      ...(entry.observes !== undefined ? { observes: entry.observes } : {}),
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
    if (leftOrigin !== rightOrigin) {
      return leftOrigin < rightOrigin ? -1 : 1;
    }
    const leftObserves = left.observes ?? "";
    const rightObserves = right.observes ?? "";
    return leftObserves < rightObserves
      ? -1
      : leftObserves > rightObserves
      ? 1
      : 0;
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

// Union of confidentiality (and integrity) atoms across every non-internal labeled read in the
// transaction, resolved from stored labels the same way verifyInputRequirements
// resolves them. Transaction-global by design — deliberately NOT scoped to a
// D4 read prefix: a sink request is built from whatever the handler read, and
// the sink-request input does not record its own read provenance, so the whole
// consumed set is the sound over-approximation for the egress ceiling
// (docs/specs/cfc-write-prefix-provenance.md §7.4).
const collectConsumedLabel = (
  tx: IExtendedStorageTransaction,
): { confidentiality: readonly unknown[]; integrity: readonly unknown[] } => {
  const atoms: unknown[] = [];
  // Integrity evidence riding the same consumed entries: the guard pool the
  // exchange evaluator matches rule preconditions against (Epic B5). Same
  // transaction-global over-approximation as the confidentiality union —
  // rules bind kind/source structurally, so evidence still has to match the
  // clause it discharges.
  const integrityAtoms: unknown[] = [];
  for (
    const read of [
      ...(tx.getReadActivities?.() ?? []),
      // §8.9.2 / SC-3 (H5): a handler scheduled by a confidential write must not
      // egress past a sink ceiling just because its branch never re-read that
      // write. Empty when the trigger-read gate is off.
      ...triggerReadSources(tx),
    ]
  ) {
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
      // CONCRETE structure entries label only the container node's shape:
      // an ancestor structure entry does not apply to a read strictly
      // below it (same exact-path rule as `labelAtPath`); as a descendant
      // of a recursive read it does apply (the read materializes the
      // shape). `*`-path templates (template-population §3.2) exist to be
      // consumed at matching child paths, so they take the generic
      // ancestor-or-equal arm — this collector stays additive; templates
      // just participate.
      const overlapsRead = entry.origin === "structure" &&
          !isRuntimeMintedTemplate({ origin: entry.origin, path: entryPath })
        ? (entryPath.length === path.length
          ? isPrefix(entryPath, path)
          : read.nonRecursive !== true && isPrefix(path, entryPath))
        : (isPrefix(entryPath, path) ||
          (read.nonRecursive !== true && isPrefix(path, entryPath)));
      if (!overlapsRead) continue;
      atoms.push(...(entry.label.confidentiality ?? []));
      integrityAtoms.push(...(entry.label.integrity ?? []));
    }
  }
  // Label-metadata observations (inv-12 Stage 2): the introspection
  // surface's records enter the egress consumed set with their §4.6.4.2
  // population-rule labels — a request assembled after inspecting protected
  // label metadata is gated exactly like one assembled after reading the
  // protected value. Confidentiality only: a metadata observation carries no
  // evidence, so it contributes nothing to the exchange evaluator's guard
  // pool.
  for (const observation of tx.getCfcState().labelMetadataObservations) {
    atoms.push(...observation.confidentiality);
  }
  // Structural dedup (deep-equal) — the same dedup the rest of CFC uses.
  return {
    confidentiality: uniqueCfcAtoms(atoms),
    integrity: uniqueCfcAtoms(integrityAtoms),
  };
};

/**
 * Runs the exchange-rule evaluator over one gated confidentiality set under
 * the transaction's policy snapshot + trust config (Epic B5). Pure wiring:
 * the snapshot/trust/acting-principal come from tx CFC state; `boundary` is
 * the site-specific `BoundaryContext` pool. Exhaustion reports through the
 * `exhausted` flag with the ORIGINAL confidentiality (never a partial
 * rewrite) — the caller decides whether that fails closed (enforce) or is a
 * diagnostic (observe).
 *
 * `consumption` is the single-use-grant seam (design §2.2): the two callers
 * — the sink-request egress ceiling and the input-requirement gate on gated
 * writes — are exactly the sites where an evaluation outcome changes a
 * persisted/egress decision inside a writing transaction's prepare, so they
 * pass `"consuming"` when (and only when) the policy-evaluation dial is
 * `enforce` (the rewritten label IS the decision there; under `observe` the
 * decision is the raw label and the evaluation is diagnostics-only, which
 * must never spend a grant). Every other evaluation site (the render
 * ceiling's display boundary, hand-built contexts) never states a consuming
 * context, so single-use grants are unsatisfiable there — fail closed.
 * Claims registered by a consuming resolution are staged into receipt
 * writes at the end of `prepareBoundaryCommit` (the same pass), so
 * consumption commits atomically with the release.
 */
const evaluateGatedConfidentiality = (
  tx: IExtendedStorageTransaction,
  confidentiality: readonly unknown[],
  integrity: readonly unknown[],
  boundary: readonly unknown[],
  consumption: CfcGrantConsumptionContext,
): {
  confidentiality: readonly unknown[];
  exhausted: boolean;
  firings: number;
} => {
  const state = tx.getCfcState();
  const result = evaluateExchangeRules(
    { confidentiality: [...confidentiality] },
    state.policySnapshot,
    {
      integrity,
      boundary,
      trustResolver: createTrustResolver(state.trustConfig),
      actingPrincipal: state.trustSnapshot?.actingPrincipal,
      // Grant resolution for policyState guards (§8.12.7 route 2a): the
      // closure captures the transaction, point-reads grant documents under
      // internalVerifierRead (lookups never taint), and records each
      // consulted address+digest into the prepare state for the B5-style
      // digest binding. Rides the same cfcPolicyEvaluation dial as the rest
      // of this evaluation — this function only runs when the dial is on.
      grantResolver: createTxCfcGrantResolver(tx),
      grantConsumption: consumption,
    },
  );
  return {
    confidentiality: result.exhausted
      ? confidentiality
      : result.label.confidentiality ?? [],
    exhausted: result.exhausted,
    firings: result.firings.length,
  };
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
  const consumed = collectConsumedLabel(tx);
  if (consumed.confidentiality.length === 0) return [];
  const mode = state.policyEvaluationMode;
  const reasons: string[] = [];
  for (const [sink, ceiling] of gatedSinks) {
    let effective = consumed.confidentiality;
    if (mode !== "off") {
      // Boundary context for this release site (spec §8.10.5 / §15.4): the
      // sink name plus its class. Every sink in the initial inventory is a
      // NETWORK egress (fetch*/stream/llm*/generate*); the display class
      // arrives with H3b's render-ceiling work.
      const boundary = [
        cfcAtom.boundaryContext("sink", sink),
        cfcAtom.boundaryContext("sinkClass", "network"),
      ];
      // The sink egress gate is a consuming site for single-use grants
      // (design §2.2) under the enforce dial — the rewritten label decides
      // whether the request flushes past the ceiling. Observe evaluates for
      // diagnostics only and must never spend a grant.
      const outcome = evaluateGatedConfidentiality(
        tx,
        consumed.confidentiality,
        consumed.integrity,
        boundary,
        mode === "enforce" ? "consuming" : "observing",
      );
      if (mode === "enforce") {
        if (outcome.exhausted) {
          // Fail closed (invariant 6): a rule set that cannot converge
          // disables exchange, it never silently downgrades to a partial
          // rewrite or to the raw label.
          reasons.push(
            `cfc policy evaluation exhausted fuel for sink-request ${sink}`,
          );
          continue;
        }
        effective = outcome.confidentiality;
      } else {
        // observe: decide exactly as `off` would; diagnose what enforce
        // would have done differently.
        const rewrittenOffending = outcome.exhausted
          ? undefined
          : atomsOutsideCeiling(outcome.confidentiality, ceiling);
        const rawOffending = atomsOutsideCeiling(
          consumed.confidentiality,
          ceiling,
        );
        if (outcome.exhausted) {
          tx.noteCfcDiagnostic(
            `policy-evaluation(observe): fuel exhausted for sink-request ` +
              `${sink}`,
          );
        } else if (
          (rawOffending.length > 0) !== (rewrittenOffending!.length > 0)
        ) {
          tx.noteCfcDiagnostic(
            `policy-evaluation(observe): rewrite would change sink-request ` +
              `ceiling for ${sink} from ${
                rawOffending.length > 0 ? "reject" : "fit"
              } to ${
                rewrittenOffending!.length > 0 ? "reject" : "fit"
              } (${outcome.firings} firings)`,
          );
        }
      }
    }
    // Same membership semantics as cfcObservationFitsCeiling (shared helper),
    // so the egress gate and the observation fits-test cannot drift.
    const offending = atomsOutsideCeiling(effective, ceiling);
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

// Applied write paths at/under `path` on this target, from the storage-level
// write details. Used by the write floor to detect plain-data descendant
// writes that link contributions do not cover. Deliberately NOT the
// reactivity log (`ifcEntryAppliesToAttemptedWrite`'s second source): an
// attempted-but-unapplied write lands no value — the floor's per-path value
// probe excludes it anyway — and the structural skip decision still falls
// back to `ifcEntryAppliesToAttemptedWrite`, which consults the log.
const attemptedWritePathsUnder = (
  tx: IExtendedStorageTransaction,
  target: {
    space: MemorySpace;
    id: URI;
    scope: ReturnType<typeof normalizeCellScope>;
  },
  path: readonly string[],
): (readonly string[])[] => {
  const out: (readonly string[])[] = [];
  for (const write of tx.getWriteDetails?.(target.space) ?? []) {
    if (
      write.address.id !== target.id ||
      normalizeCellScope(write.address.scope) !== target.scope ||
      write.address.path[0] !== "value"
    ) {
      continue;
    }
    const writePath = write.address.path.slice(1).map((entry) => String(entry));
    if (concretePathHasPrefix(writePath, path)) out.push(writePath);
  }
  return out;
};

/**
 * Epic D3 — the write-side `requiredIntegrity` FLOOR (§8.12.4.1 / SC-18),
 * dual of the read-side gate in `verifyInputRequirements`: where that gate
 * quantifies over the transaction's consumed reads, the floor tests the
 * WRITTEN VALUE's integrity at each floor-declaring path. Per SC-18 the floor
 * is a minimum (above-floor writes pass); an overwrite is checked against the
 * declared floor only — never the prior value's integrity, no meet across
 * successive writes; a value with no (or only forged-then-stripped) integrity
 * on a floor-declaring path fails.
 *
 * What credits the value (mirrors what this commit persists at the path):
 * - the schema-derived label — `addIntegrity` mints plus `exactCopyOf` and
 *   `projection` carries, evidence-gated by the write's authoring identity
 *   (a pattern cannot forge runtime-minted evidence to pass its own floor);
 * - each link written at/under the path — the linked source's own label, the
 *   D2 by-reference contract on the write side. Every link must individually
 *   satisfy the floor (one endorsed sibling never launders another);
 * - the flow hereditary meet, when flow labels are on (`value` contributions
 *   carry the per-tx derived integrity).
 *
 * Scope (v1, exact-match membership — D5 upgrades to pattern/concept):
 * wildcard (`*`) floor entries stay read-gate-only; unlike `writeAuthorizedBy`
 * there is NO pattern-setup escape — the floor is a value requirement, so a
 * setup that writes a floored path must itself mint the required integrity
 * (`addIntegrity`), fail-closed; a pure delete (no written value) is not a
 * floored write — the floor governs values, not absence.
 */
const verifyWriteFloor = (
  tx: IExtendedStorageTransaction,
  schema: JSONSchema,
  target: {
    space: MemorySpace;
    id: URI;
    scope: ReturnType<typeof normalizeCellScope>;
  },
  ctx: {
    identityForPath: (
      path: readonly string[],
    ) => ImplementationIdentity | undefined;
    identityForInput: (
      input: WritePolicyInput,
    ) => ImplementationIdentity | undefined;
    linkWriteInputs: readonly LinkWritePolicyInput[];
    candidateSchemas: ReadonlyMap<string, JSONSchema>;
    flowIntegrity: readonly unknown[];
  },
): string[] => {
  const failures: string[] = [];
  // Built once per verify (not per entry/contribution): the closure and acting
  // principal are tx-wide. Concept floors on the written value resolve through
  // it; plain floors ignore it (Epic D5).
  const trust = cfcFloorTrustContext(tx);
  const entries = walkIfcSchema(schema);
  const entryLabels = new Map<string, IFCLabel>(
    entries.map((entry) => [pathKey(entry.path), entry.label]),
  );
  for (const entry of entries) {
    const ifc = isRecord(entry.schema) ? entry.schema.ifc : undefined;
    const floor = Array.isArray(ifc?.requiredIntegrity)
      ? ifc.requiredIntegrity
      : [];
    if (floor.length === 0) continue;
    if (entry.path.includes("*")) continue;
    // Floor applicability is STRUCTURAL — did anything land at/under the floor
    // path, or does a link cover it? It must never hinge solely on the
    // value-conditioned `ifcEntryAppliesToAttemptedWrite`, whose schema/value
    // matcher can return false for values that genuinely landed (e.g. a nested
    // link sigil at a typed slot) and would silently skip the floor — letting
    // unendorsed data through (review). The value-conditioned check remains
    // only as a widening fallback for ancestor-write shapes the structural
    // sources miss; over-applying a floor to a non-matching union arm
    // over-rejects (fail-closed), never leaks.
    const linksHere = ctx.linkWriteInputs.filter((input) =>
      concretePathHasPrefix(
        canonicalizeLogicalPath(input.target.path),
        entry.path,
      )
    );
    // A link written at a strict ANCESTOR swaps the whole container: the value
    // now living at the floor path is the linked source's value at the
    // corresponding nested path (for a fresh doc it reconstructs as
    // `undefined`, so this must not depend on the value matcher either).
    const ancestorLinks = ctx.linkWriteInputs.filter((input) => {
      const linkPath = canonicalizeLogicalPath(input.target.path);
      return linkPath.length < entry.path.length &&
        concretePathHasPrefix(entry.path, linkPath);
    });
    const writesUnder = attemptedWritePathsUnder(tx, target, entry.path);
    if (
      linksHere.length === 0 && ancestorLinks.length === 0 &&
      writesUnder.length === 0 &&
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

    // The label this commit persists at the path: schema integrity +
    // `addIntegrity` mints + `exactCopyOf`/`projection` carries,
    // evidence-gated so a pattern author cannot forge runtime-minted atoms
    // to satisfy their own floor.
    const base = gateRuntimeMintedIntegrity(
      derivePersistedLabel(tx, entry.schema, entry.label, entryLabels),
      ctx.identityForPath(entry.path),
    ).integrity ?? [];

    // One contribution per link written at/under the floor path (each linked
    // value must individually carry the floor), plus one `value` contribution
    // when plain data was written (crediting the flow meet when available).
    const contributions: (readonly unknown[])[] = [];
    for (const input of linksHere) {
      const derived = derivePersistedLinkLabel(
        tx,
        input,
        ctx.candidateSchemas,
        ctx.identityForInput(input),
      );
      // An underivable link (`reason` set, `label` undefined) contributes empty
      // integrity — it fails the floor, fail-closed, alongside the persist
      // loop's own missing-source reason (both reject).
      contributions.push(derived.label?.integrity ?? []);
    }
    for (const input of ancestorLinks) {
      // Re-point the derivation at the floor path INSIDE the linked source:
      // the value at the floor path is source.path + (floor − linkPath), so
      // the credit is the source's own label at that nested path (an endorsed
      // nested value passes; an unendorsed one fails, fail-closed).
      const linkPath = canonicalizeLogicalPath(input.target.path);
      const relative = entry.path.slice(linkPath.length);
      const derived = derivePersistedLinkLabel(
        tx,
        {
          ...input,
          source: {
            ...input.source,
            path: [
              ...canonicalizeLogicalPath(input.source.path),
              ...relative,
            ],
          },
          target: { ...input.target, path: entry.path },
        },
        ctx.candidateSchemas,
        ctx.identityForInput(input),
      );
      contributions.push(derived.label?.integrity ?? []);
    }
    const written = writeValueForTarget(tx, { ...target, path: entry.path });
    // A value contribution exists when plain data lands at/under the floor
    // path, judged three ways (any one suffices, fail-closed):
    // - the reconstructed value at the path is not pure link structure
    //   (plain/mixed data written at or above the path);
    // - some attempted write at/under the path carries a value and is not
    //   covered by a link input — the descendant-only mixed case (one child a
    //   link, a sibling plain data) where the parent may reconstruct as
    //   pure-link or undefined and would otherwise be judged by the link
    //   contributions alone (review). The per-path value probe keeps DELETE
    //   details (no value) out;
    // - nothing else contributed at all (a value-shaped write with no link
    //   inputs — e.g. a raw sigil smuggled without link policy inputs), so the
    //   floor is still evaluated, fail-closed.
    const descendantValueWrite = writesUnder.some((writePath) =>
      !linksHere.some((input) =>
        concretePathHasPrefix(
          writePath,
          canonicalizeLogicalPath(input.target.path),
        )
      ) &&
      writeValueForTarget(tx, { ...target, path: writePath }) !== undefined
    );
    // Nothing landed anywhere: a pure delete/clear — absence is not a floored
    // value (the floor governs values written, not removals).
    if (
      written === undefined && !descendantValueWrite &&
      contributions.length === 0
    ) {
      continue;
    }
    const valueWritten =
      (written !== undefined && !isPureLinkStructure(written)) ||
      descendantValueWrite ||
      contributions.length === 0;
    if (valueWritten) contributions.push(ctx.flowIntegrity);

    const misses = contributions.some((extra) =>
      !cfcIntegritySatisfiesFloor([...base, ...extra], floor, trust)
    );
    if (misses) {
      failures.push(
        `write floor failed at /${
          entry.path.join("/")
        } (requiredIntegrity, §8.12.4.1)`,
      );
    }
  }
  return failures;
};

export const prepareBoundaryCommit = (
  tx: IExtendedStorageTransaction,
  instrumentation?: CfcPrepareInstrumentation,
): string[] => {
  const reasons: string[] = [];
  const state = tx.getCfcState();
  // D4: per-target last-overlapping-write bounds over the ordered write-
  // attempt log, built once for the whole boundary pass. Each protected
  // write's input checks quantify over the reads in ITS prefix (see
  // verifyInputRequirements); the egress ceiling deliberately does not
  // (collectConsumedLabel stays transaction-global).
  const prefixBounds = buildWritePrefixBounds(tx);
  // Stage-0 precision counters (cfc-value-level-provenance.md §6): the
  // summary is allocated only when a hook will consume it — the default
  // path pays this one presence check.
  const prefixProvenance = instrumentation?.onPrefixProvenance !== undefined
    ? createPrefixProvenanceSummary()
    : undefined;
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
  // Inv-12 Stage 1 (SC-25): the cross-space label-metadata representation
  // dial. When active (observe/enforce), the flow join additionally collects
  // which spaces contributed label content, so the per-target predicate
  // below can tell a same-space join from one that consumed foreign labels.
  // `off` pays nothing — no space collection, no eligibility tracking.
  const labelProtectionMode = state.labelMetadataProtectionMode;
  const flowTargets = flowMode === "off" ? undefined : valueWriteTargets(tx);
  const flowJoin = flowMode === "off"
    ? { confidentiality: [], integrity: [] }
    : deriveFlowJoin(
      tx,
      labelProtectionMode !== "off"
        ? { collectLabeledSpaces: true }
        : undefined,
    );
  const flowConfidentiality = flowJoin.confidentiality;
  const flowIntegrity = flowJoin.integrity;
  const flowLabeledSpaces = flowJoin.labeledSpaces;
  const flowHasLabels = flowConfidentiality.length > 0 ||
    flowIntegrity.length > 0;
  // H4 (SC-18b): the writer-fit misfit REJECTS only at `enforce-strict`;
  // every mode below persists-and-flags, so `enforce-explicit` keeps the
  // shipped behavior where the derived component is a measurement, not a
  // write ceiling (§8.12.4, enforcement-matrix §4).
  const writerFitRejects = cfcEnforcementStrictness(state.enforcementMode) >=
    cfcEnforcementStrictness("enforce-strict");
  if (
    flowMode === "observe" &&
    flowTargets !== undefined &&
    flowTargets.size > 0 &&
    flowHasLabels
  ) {
    tx.noteCfcDiagnostic(
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
  // (S16) Result containers a list coordinator (filter/flatMap) declared this
  // tx: re-derive their `structure` label from J every reconcile, decoupled
  // from value writes. Membership taint (the predicate-result reads the
  // coordinator consumed) settles on a later pass than the container's root
  // value write, and incremental changes are slot/no-op writes that never
  // re-stamp the root — so without this the taint never lands. Only when there
  // IS taint (flowHasLabels): a transient empty-J reconcile must NOT clear a
  // correct prior structure label (resume/loading), so we leave the container
  // off the persist loop then (fail-safe: keep the existing label).
  const structureContainerPaths = new Map<string, readonly string[]>();
  if (flowPersist && flowHasLabels) {
    for (const addr of tx.getCfcState().structureContainers) {
      const containerKey = targetKey(addr);
      structureContainerPaths.set(
        containerKey,
        canonicalizeLogicalPath(addr.path),
      );
      targetKeys.add(containerKey);
    }
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
      const existingEntries = existingMeta?.labelMap.entries ?? [];
      if (
        existingEntries.some((entry) =>
          (entry.origin === "derived" || entry.origin === "link" ||
            entry.origin === "structure") &&
          target.paths.some((written) => isPrefix(written, entry.path))
        ) ||
        // Stage B healing, the template-ONLY arm (cubic P2 on the Stage B
        // PR): an envelope whose entries are ALL label-metadata templates
        // has no payload entry a written path could cover, so it would
        // never re-enter this loop — and its templates describe entries
        // that no longer exist. Admit it so the re-derivation writes the
        // healed (empty) label map. Envelopes with any payload entry heal
        // through the ordinary covering-write arm above (the re-derivation
        // rebuilds templates whenever payload entries are re-persisted).
        (existingEntries.length > 0 &&
          existingEntries.every((entry) => isLabelMetadataTemplateEntry(entry)))
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
    // Inv-12 Stage 1 (SC-25; spec §4.6.4.1): the per-target cross-space
    // predicate. An entry is ELIGIBLE for the representation transform when
    // the observations that fed it originate OUTSIDE this target's space:
    //
    // - link-origin entries (the source-path label, the re-derived label
    //   view, and the carried in-value `cfcLabelView`) when the link
    //   SOURCE's space differs from the target's — the source address on
    //   the link-write input is the provenance `derivePersistedLinkLabel`
    //   itself resolves metadata by;
    // - flow-derived stamps (`derived`/`structure` value/shape/enumerate)
    //   when any labeled flow observation came from another space. The join
    //   is one per-tx union with no per-atom attribution, so a single
    //   foreign labeled contribution makes the WHOLE stamped entry eligible
    //   — ambiguous provenance fails toward protection.
    //
    // NOT eligible (persist verbatim): `declared` entries (authored schema
    // policy — the schema document replicates to the destination anyway, so
    // transforming the mirror entries would protect nothing), carried-
    // forward existing entries (already at rest in this doc; migration
    // never rewrites persisted envelopes), and the local external-ingest
    // mark (minted from this tx's own channel stamp — no cross-space
    // observation feeds it; its atoms commit like any others if they later
    // flow into a foreign target through the join).
    const crossSpaceEligible = labelProtectionMode !== "off"
      ? new Set<LabelMapEntry>()
      : undefined;
    const flowJoinIsCrossSpace = flowLabeledSpaces !== undefined &&
      [...flowLabeledSpaces].some((labeled) => labeled !== space);
    const markFlowStampEntry = (entry: LabelMapEntry): LabelMapEntry => {
      if (flowJoinIsCrossSpace) crossSpaceEligible?.add(entry);
      return entry;
    };
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
      prefixBounds,
      prefixProvenance,
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

    // Copy-claim verification: exactCopyOf and its §8.3 sub-path
    // generalization share one failure branch — both are "the written value
    // must equal a claimed source value" checks.
    const exactCopyFailure = verifyExactCopyRequirements(
      tx,
      target,
      verificationSchema,
    ) ?? verifyProjectionRequirements(
      tx,
      target,
      verificationSchema,
    );
    if (exactCopyFailure) {
      reasons.push(exactCopyFailure);
      if (!isIngestTarget) continue;
      ingestVerificationFailed = true;
    }

    // Epic D3 (§8.12.4.1 / SC-18): the write-side requiredIntegrity floor —
    // the WRITTEN VALUE's integrity must satisfy each floor-declaring entry.
    // `observe` diagnoses; `enforce` records a reason (rejecting the commit
    // under the enforcing enforcement modes, mirroring requirementFailure).
    if (state.writeFloorMode !== "off") {
      const floorFailures = verifyWriteFloor(tx, verificationSchema, target, {
        identityForPath: (path) =>
          identityForSchemaPath(writeAuthorIdentities.get(key), path),
        identityForInput,
        linkWriteInputs,
        candidateSchemas: candidates,
        // Only PERSISTED flow integrity may credit the floor: `observe` mode
        // computes the join for diagnostics but stores nothing on the value, so
        // crediting it would let a plain write pass a floor with integrity that
        // never lands (codex/cubic review). Only `persist` writes the derived
        // component.
        flowIntegrity: flowPersist ? flowIntegrity : [],
      });
      if (floorFailures.length > 0) {
        if (state.writeFloorMode === "enforce") {
          reasons.push(...floorFailures);
          if (!isIngestTarget) continue;
          ingestVerificationFailed = true;
        } else {
          for (const failure of floorFailures) {
            tx.noteCfcDiagnostic(`write-floor(observe): ${failure}`);
          }
        }
      }
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
          // C5: an authored `ifc.observes` classes the declared entry (the
          // sqlite null-origin merge declares `observes:"value"` this way).
          // Anything but the four class values — including the absent
          // default — mints a covering entry: over-taint, fail-safe, and
          // wire-identical for pre-C readers.
          const observes = declaredObservesClass(entry.schema);
          return hasLabelValues(label) || hasPersistedPolicyClaim(entry.schema)
            ? [{
              path: entry.path,
              label,
              origin: "declared" as const,
              ...(observes !== undefined ? { observes } : {}),
            }]
            : [];
        });
    // WP5 (§8.12.1/§8.12.8; docs/specs/cfc-persisted-declassification.md §4
    // item 3): the declared-component monotonicity gate. Each declared entry
    // this walk is about to persist replaces the stored declared entry at
    // the same path (the carry-forward below skips replaced paths), so this
    // is the ONE point where the store policy can change — compare against
    // the stored entries per canUpdateStoreLabel before it does. The stored
    // metadata was read above under the internal-verifier meta
    // (storedMetadataFor), so the gate consumes no additional reads. Under
    // `enforce` a violation records fail-closed reasons and skips persisting
    // this target's labels (mirroring requirementFailure — the stored,
    // stronger entries stay in place under non-rejecting enforcement modes;
    // an ingest target keeps only the runtime's mark); under `observe` it
    // diagnoses and persists today's bytes; `off` runs nothing.
    if (state.declaredMonotonicityMode !== "off" && existing !== undefined) {
      const monotonicityViolations = collectDeclaredMonotonicityViolations({
        space,
        docId: id,
        storedEntries: existing.labelMap.entries,
        proposedEntries: persistedLabelEntries,
        exemption: state.declaredWideningExemption,
      });
      if (monotonicityViolations.length > 0) {
        if (state.declaredMonotonicityMode === "enforce") {
          reasons.push(...monotonicityViolations);
          if (!isIngestTarget) continue;
          // Mirror ingestVerificationFailed above: the runtime's ingest mark
          // (appended below) still persists in non-rejecting modes, but the
          // non-monotone declared claims must not.
          persistedLabelEntries.length = 0;
        } else {
          for (const violation of monotonicityViolations) {
            tx.noteCfcDiagnostic(
              `declared-monotonicity(observe): ${violation}`,
            );
          }
        }
      }
    }
    const persistedLabelEntryKeys = new Set(
      persistedLabelEntries.map((entry) => pathKey(entry.path)),
    );
    const currentLinkWritePaths = new Set(
      linkWriteInputs.map((input) => pathKey(input.target.path)),
    );
    let flowCleared = false;
    // Stage B: stored label-metadata templates this persist drops (they are
    // re-derived from the FINAL payload entry set below). Tracked so a
    // TEMPLATE-ONLY stale envelope — a mixed-version writer cleared the
    // payload entries while carrying the unknown-origin templates forward —
    // heals: dropping them counts as a clear, so an empty final label map
    // is WRITTEN rather than short-circuited into keeping the stale bytes
    // (cubic P2 on the Stage B PR). When the final entries are non-empty
    // the flag is inert — the SC-11 canonical comparison decides as usual.
    let droppedLabelMetadataTemplates = false;
    // SC-4 (C3, disciplines settled with the spec 2026-07-06 — freeze-at-
    // creation, specs branch cfc/existence-freeze-at-creation): existence
    // never shrinks, but it does not grow either. When a clear drops a
    // DERIVED entry under a written path, its confidentiality is collected
    // here and folded into the written path's `observes:"shape"` entry —
    // the departed subtree's existence history. MEMBERSHIP stamps
    // (`origin:"structure"`, `observes:"enumerate"`) are exempt:
    // §8.12.8's replace-on-overwrite is normative for recomputed
    // membership, and pooling them re-imports the label creep it rejects.
    // Frozen existence entries (`origin:"structure"`, `observes:"shape"`)
    // are never cleared at all (handled before the clears below). Legacy
    // covering structure entries (pre-C2: membership and existence
    // conflated) still pool once — the migration freeze absorbs them into
    // the container's frozen existence entry, conservatively. Link entries
    // are excluded: they label the pointer, and folding them into content
    // shape would re-smear the pointer/content split.
    const clearedExistence: Array<{
      path: readonly string[];
      confidentiality: readonly unknown[];
    }> = [];
    // Only pre-class LEGACY entries (no `observes`) pool: they conflated
    // existence with content/membership, and the one-time migration absorb
    // below freezes their accumulated confidentiality into the path's
    // shape entry. Post-C2 entries never pool — value/enumerate replace,
    // shape freezes.
    const poolsExistence = (entry: LabelMapEntry): boolean =>
      entry.observes === undefined &&
      (entry.origin === "derived" || entry.origin === "structure");
    for (const entry of existing?.labelMap.entries ?? []) {
      const entryPath = canonicalizeLogicalPath(entry.path);
      const key = pathKey(entryPath);
      // Label-metadata population templates (template-population Stage B,
      // spec §4.6.4.2) are a pure function of the payload entries in this
      // same envelope: never carried forward — re-derived below from the
      // FINAL payload entry set, so they replace on overwrite and clear
      // with the entries they describe by construction (and a stale
      // template left by a mixed-version writer heals on the next persist
      // here — see `droppedLabelMetadataTemplates` for the template-only
      // arm).
      if (isLabelMetadataTemplateEntry(entry)) {
        droppedLabelMetadataTemplates = true;
        continue;
      }
      // RUNTIME-MINTED shape-class (existence) entries survive every
      // overwrite of a still-existing path (freeze-at-creation): not the
      // flow-clear, not a link write replacing the slot, not a declared
      // re-mint. Origin-scoped to derived/structure: a DECLARED
      // observes:"shape" entry is policy, not measurement — it keeps the
      // declared component's own discipline (grow-only re-mint through
      // the schema walk) and must not be captured by the freeze carry
      // (review on this PR). `*`-path TEMPLATES are excluded too: the
      // shape-class membership template records CURRENT shape under
      // replace-from-criteria (template-population §3.1/§3.2.1), so
      // freezing it here would both unhinge it from the criteria and
      // accumulate stale J forever through the coalesce join. Known
      // residual: deletion leaves the frozen entry in place (over-taint)
      // and re-creation keeps it instead of re-minting at the re-creating
      // join — re-mint-on-recreation needs per-path previousValue
      // plumbing.
      if (
        (entry.origin === "derived" || entry.origin === "structure") &&
        entry.observes === "shape" &&
        !isRuntimeMintedTemplate({ origin: entry.origin, path: entryPath })
      ) {
        persistedLabelEntries.push({
          path: entryPath,
          label: cloneLabel(entry.label),
          ...(entry.origin !== undefined ? { origin: entry.origin } : {}),
          observes: "shape",
        });
        continue;
      }
      if (persistedLabelEntryKeys.has(key) || currentLinkWritePaths.has(key)) {
        // A link write replacing a previously content-labeled path — or a
        // declared entry re-minting at the same path — drops the old
        // derived entries here, through a different skip than the
        // flow-clear below; their existence history still folds into the
        // SC-4 pool like any other clear.
        if (
          flowPersist &&
          poolsExistence(entry) &&
          (entry.label.confidentiality?.length ?? 0) > 0
        ) {
          clearedExistence.push({
            path: entryPath,
            confidentiality: entry.label.confidentiality!,
          });
        }
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
      //
      // `*`-path templates clear only under a write that covers their
      // CONTAINER (template-population §3.1 "cleared on covering writes"):
      // `isPrefix`'s bidirectional wildcard would let a bare SLOT write
      // (["1"]) "cover" the ["*"] template — but a slot write replaces one
      // child, not the membership, and clearing there (with no re-mint;
      // slot writes stamp nothing) would open an unlabeled window until
      // the next declared reconcile. The container-anchored enumerate
      // stamp survives slot writes for exactly the same reason (exact-path
      // never matches a deeper write), so the twins match its discipline.
      const clearProbePath = isRuntimeMintedTemplate({
          origin: entry.origin,
          path: entryPath,
        }) && entryPath[entryPath.length - 1] === "*"
        ? entryPath.slice(0, -1)
        : entryPath;
      if (
        flowPersist &&
        (entry.origin === "derived" || entry.origin === "link" ||
          entry.origin === "structure") &&
        flowWrittenPaths.some((written) => isPrefix(written, clearProbePath))
      ) {
        flowCleared = true;
        if (
          poolsExistence(entry) &&
          (entry.label.confidentiality?.length ?? 0) > 0
        ) {
          clearedExistence.push({
            path: entryPath,
            confidentiality: entry.label.confidentiality!,
          });
        }
        continue;
      }
      const schemaEntry = mergedSchemaEntrySchemas.get(key);
      if (
        hasLabelValues(entry.label) ||
        (schemaEntry !== undefined && hasPersistedPolicyClaim(schemaEntry))
      ) {
        // Carry-forward of an untouched path preserves the entry's
        // component and consumption class (legacy entries stay legacy;
        // covering entries stay covering).
        persistedLabelEntries.push({
          path: entryPath,
          label: cloneLabel(entry.label),
          ...(entry.origin !== undefined ? { origin: entry.origin } : {}),
          ...(entry.observes !== undefined ? { observes: entry.observes } : {}),
        });
      }
    }
    for (const input of linkWriteInputs) {
      const linkIdentity = identityForInput(input);
      // Inv-12 Stage 1: link-origin entries are cross-space when the link
      // SOURCE lives in another space (see the predicate comment above).
      const markLinkEntry = (entry: LabelMapEntry): LabelMapEntry => {
        if (input.source.space !== space) crossSpaceEligible?.add(entry);
        return entry;
      };
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
        persistedLabelEntries.push(markLinkEntry({
          path: canonicalizeLogicalPath(input.target.path),
          label: result.label,
          origin: "link",
        }));
      }
      const targetPath = canonicalizeLogicalPath(input.target.path);
      // Inv-12 Stage 0 (SC-25 prerequisite): persist link-origin labels from
      // the worker-authoritative source — the source doc's STORED label map,
      // re-derived under the link source path — independent of the carried
      // view. The carried `cfcLabelView` round-trips through the main thread
      // (CellHandle refs) and is author-influenceable, so a tampered /
      // redacted / incomplete view must not be able to WEAKEN what the
      // stored metadata provides: entries re-derived here persist outright;
      // the view loop below can only add. (`derivePersistedLinkLabel` above
      // covers the label AT the source path; this covers the source's
      // sub-path entries, which previously rode only the view.) Same
      // evidence-mint gate as the carried entries (audit S4): a link write
      // may not re-mint runtime evidence at the target without builtin
      // authorship.
      // The emptiness check runs on the GATED label (cubic review on this
      // PR): the mint gate can strip an integrity-only entry down to
      // nothing, and pushing an empty origin:"link" entry at a more-specific
      // path would SHADOW an ancestor link entry's confidentiality under the
      // per-component longest-prefix read resolution — an under-labeling.
      const pushGatedLinkEntry = (entry: {
        path: readonly string[];
        label: IFCLabel;
      }) => {
        const gated = gateRuntimeMintedIntegrity(
          cloneLabel(entry.label),
          linkIdentity,
        );
        if (!hasLabelValues(gated)) {
          return;
        }
        persistedLabelEntries.push(markLinkEntry({
          path: [
            ...targetPath,
            ...canonicalizeLogicalPath(entry.path),
          ],
          label: gated,
          origin: "link",
        }));
      };
      const rederivedView = cfcLabelViewFromMetadata(
        result.sourceMetadata,
        input.source.path,
      );
      for (const entry of rederivedView?.entries ?? []) {
        pushGatedLinkEntry(entry);
      }
      // The carried label view is author-influenceable; gate runtime-minted
      // evidence atoms unless a builtin authored the link write (audit S4
      // review).
      //
      // "Can only add" must hold under LONGEST-PREFIX shadowing too (cubic
      // P1 on the Stage 1 PR): within the link component a more-specific
      // entry REPLACES its ancestor for reads at/below it, so a crafted
      // carried entry at a sub-path the authoritative state does not cover
      // would swap the ancestor's confidentiality for the view's — a
      // weakening through the very loop meant to be additive. Each carried
      // entry therefore JOINS the label of the most-specific AUTHORITATIVE
      // entry covering its path (the source-path label from
      // `derivePersistedLinkLabel`, or the nearest re-derived-view
      // ancestor-or-equal), so what it shadows rides along and the entry is
      // at least as restrictive as the resolution it displaces. Both halves
      // join: confidentiality is the leak the shadow would open; integrity
      // at the covered path (e.g. the LinkReference provenance) would
      // otherwise silently drop out of sub-path reads.
      const authoritativeEntries: Array<{
        path: readonly string[];
        label: IFCLabel;
      }> = [
        ...(result.label !== undefined && hasLabelValues(result.label)
          ? [{ path: [] as readonly string[], label: result.label }]
          : []),
        ...(rederivedView?.entries ?? []).map((entry) => ({
          path: canonicalizeLogicalPath(entry.path),
          label: entry.label,
        })),
      ];
      const authoritativeCoverFor = (
        entryPath: readonly string[],
      ): IFCLabel | undefined => {
        let best: { path: readonly string[]; label: IFCLabel } | undefined;
        for (const auth of authoritativeEntries) {
          if (!isPrefix(auth.path, entryPath)) continue;
          if (best === undefined || auth.path.length > best.path.length) {
            best = auth;
          } else if (auth.path.length === best.path.length) {
            // Source-path label and a re-derived root entry share path [];
            // join defensively rather than pick one.
            best = {
              path: best.path,
              label: mergeLabels(best.label, auth.label),
            };
          }
        }
        return best?.label;
      };
      for (const entry of input.cfcLabelView?.entries ?? []) {
        const gated = gateRuntimeMintedIntegrity(
          cloneLabel(entry.label),
          linkIdentity,
        );
        if (!hasLabelValues(gated)) {
          continue;
        }
        const entryPath = canonicalizeLogicalPath(entry.path);
        const cover = authoritativeCoverFor(entryPath);
        persistedLabelEntries.push(markLinkEntry({
          path: [...targetPath, ...entryPath],
          label: cover !== undefined ? mergeLabels(cover, gated) : gated,
          origin: "link",
        }));
      }
    }

    if (flowPersist && (flowHasLabels || clearedExistence.length > 0)) {
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
      // H4 writer-fit (SC-18b, §8.12.4 `canWrite`): the per-tx join landing
      // below as this target's `derived` value component is the measurement
      // of the written value's actual taint, and canWrite demands it fit the
      // store's DECLARED policy component at each path where it lands. The
      // policy component is the declared + legacy entries only — link/
      // derived/structure entries are per-value data components (§8.12.8),
      // not store policy — and of those, only the entries a VALUE read
      // consumes (C0 §4 class selection: covering/value/shape/enumerate; a
      // declared `observes:"followRef"` entry is pointer policy that value
      // readers never consume, so it must not admit a value write — bot
      // review on this PR). Resolution is the same per-component
      // longest-prefix rule reads use, so the fit test measures exactly the
      // declared floor a value reader of the path is tainted with. Only the
      // CURRENT join is measured: shape/existence atoms are historical
      // (SC-4 freeze-at-creation) and measuring them would permanently
      // misfit clean overwrites of a store created under taint.
      // A schema declaring a covering policy in this same tx passes by
      // construction — §8.12.5's monotone-safe upgrade route; the other two
      // outs are writing to a fitting store or not writing. Link-covered
      // writes carry per-slot link labels instead of the join and are
      // outside this v1 check, as is the pure-link-structure shape channel.
      const declaredPolicyEntries = flowConfidentiality.length > 0
        ? persistedLabelEntries.filter((entry) =>
          (entry.origin === undefined || entry.origin === "declared") &&
          readConsumesEntry("value", entry)
        )
        : [];
      // SC-4, freeze-at-creation form: a path's shape (existence) entry is
      // minted ONCE — at creation, or at the one-time migration of legacy
      // pre-class entries (whose accumulated confidentiality is absorbed
      // here, conservatively over-attributed to this first stamping) — and
      // is carried verbatim ever after. Consumed pool indices are tracked
      // so legacy conf not covered by a stamp still lands below.
      const attachedExistence = new Set<number>();
      // Clause-aware dedup: the fold is where STORED bytes (a peer may have
      // persisted {anyOf:["B","A"]}) meet this tx's normalized derivation
      // ({anyOf:["A","B"]}). uniqueCfcAtoms is deepEqual-based, so byte-
      // permuted forms of one clause would both survive — a doubled clause
      // list and one spurious envelope rewrite (the SC-11 churn class).
      // normalizeClause each clause first; non-clause atoms pass through.
      const foldedUnique = (atoms: readonly unknown[]): unknown[] =>
        uniqueCfcAtoms(atoms.map((atom) => normalizeClause(atom)));
      const frozenConfidentialityFor = (
        path: readonly string[],
      ): unknown[] => {
        const atoms: unknown[] = [...flowConfidentiality];
        clearedExistence.forEach((cleared, index) => {
          if (isPrefix(path, cleared.path)) {
            attachedExistence.add(index);
            atoms.push(...cleared.confidentiality);
          }
        });
        return foldedUnique(atoms);
      };
      // (S16) A declared list-coordinator container re-derives its MEMBERSHIP
      // stamp (origin structure, observes enumerate — replace-from-criteria,
      // §8.12.8-normative per #4546) from J this reconcile even with no value
      // write: drop the carried-forward enumerate entry at the exact container
      // path and re-stamp it below with the current J. The `*`-child class
      // templates minted beside it (template-population §3.1) follow the same
      // replace-from-criteria discipline, so the carried template twins at
      // [...container, "*"] are dropped and re-minted too — leaving them would
      // coalesce-JOIN with the fresh mints and accumulate stale J forever.
      // The frozen existence entry (observes shape, concrete path) and legacy
      // covering entries are left in place — deleting the frozen entry would
      // make the stamp loop re-mint it from the CURRENT join, silently
      // unfreezing it; legacy entries await the write-path migration absorb.
      const structureContainerPath = structureContainerPaths.get(key);
      if (structureContainerPath !== undefined) {
        const containerPathKey = pathKey(structureContainerPath);
        const containerTemplateKey = pathKey([
          ...structureContainerPath,
          "*",
        ]);
        for (let i = persistedLabelEntries.length - 1; i >= 0; i--) {
          const candidateEntry = persistedLabelEntries[i];
          if (
            candidateEntry.origin === "structure" &&
            ((candidateEntry.observes === "enumerate" &&
              pathKey(candidateEntry.path) === containerPathKey) ||
              pathKey(candidateEntry.path) === containerTemplateKey)
          ) {
            persistedLabelEntries.splice(i, 1);
          }
        }
        if (
          !structureStampPaths.some((p) => pathKey(p) === containerPathKey)
        ) {
          structureStampPaths.push(structureContainerPath);
        }
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
        if (flowConfidentiality.length > 0) {
          // Absent declared entries resolve to the EMPTY ceiling ("public
          // store"), never the undefined "no ceiling" — a tainted write to
          // an undeclared store is the canonical misfit, and fitting it
          // by default would hollow the rule out. Clause membership is the
          // shared subsumption predicate of the egress/observation gates,
          // so writer-fit cannot drift from what a ceiling admits — and the
          // ungrantable read-failed marker stays outside every declared
          // policy (a poisoned measurement never proves fit).
          const declaredCeiling =
            labelForEntriesAtPath(declaredPolicyEntries, path)
              ?.confidentiality ?? [];
          const offending = atomsOutsideCeiling(
            flowConfidentiality,
            declaredCeiling,
          );
          if (offending.length > 0) {
            // SC-18c error contract: a stable reason naming the rule id and
            // the target path, plus the offending clause(s) so a flag names
            // exactly what the store would need to declare (§8.12.5).
            const misfit =
              `writer-fit confidentiality misfit for ${id} at /${
                path.join("/")
              } (canWrite, §8.12.4): ` +
              offending.map((atom) => JSON.stringify(atom)).join(", ");
            if (writerFitRejects) {
              reasons.push(misfit);
            } else {
              tx.noteCfcDiagnostic(`writer-fit(persist-and-flag): ${misfit}`);
            }
          }
        }
        // C2 persist split (C0 §5/§8): the per-tx join lands as two
        // per-class entries instead of one covering entry. The `value`
        // entry carries the full J and keeps §8.12.8 replace-on-overwrite;
        // the `shape` (existence) entry carries confidentiality only —
        // existence is a confidentiality channel (SC-4: "this path was
        // once written"), and integrity there would be joined by the
        // grow-on-overwrite above, which for integrity claims is an
        // over-claim (integrity meets, never joins). A class-unaware
        // reader consuming both as covering entries sees today's label or
        // a wider one — additively safe, no dial (C0 §9).
        if (flowHasLabels) {
          persistedLabelEntries.push(markFlowStampEntry({
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
            observes: "value",
          }));
        }
        // Freeze-at-creation: mint the existence entry only when the path
        // has none (creation / legacy migration); a carried frozen entry
        // pushed above wins, and later writes to a still-existing path add
        // no existence information (a writer conditional on existence
        // journals that observation itself, §8.10.1/§8.9.2).
        // Only a runtime-minted existence entry suppresses the mint: a
        // DECLARED observes:"shape" entry is store policy for the shape
        // channel, not a record that creation happened — both coexist as
        // separate components (review on this PR).
        const hasShapeEntry = persistedLabelEntries.some((entry) =>
          (entry.origin === "derived" || entry.origin === "structure") &&
          entry.observes === "shape" && pathKey(entry.path) === pathKey(path)
        );
        if (!hasShapeEntry) {
          const shapeConfidentiality = frozenConfidentialityFor(path);
          if (shapeConfidentiality.length > 0) {
            persistedLabelEntries.push(markFlowStampEntry({
              path,
              label: { confidentiality: shapeConfidentiality },
              origin: "derived",
              observes: "shape",
            }));
          }
        }
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
        // C2: structure stamps state their class explicitly. Pre-C2
        // structure entries (absent `observes`) stay covering — unchanged
        // compat; the flow join is unaffected either way since value reads
        // consume the `shape` class too (C0 §4).
        // MEMBERSHIP stamp: the container's current selection, recomputed
        // from this attempt's journal — §8.12.8 replace-on-overwrite is
        // normative for it, so it carries the current J only, never the
        // pool. Labs-axis mapping note: the `observes` axis is read-op
        // shaped, so "enumerate" here approximates the spec's container-
        // level `iterate.{order,count}` classes.
        if (flowHasLabels && flowConfidentiality.length > 0) {
          persistedLabelEntries.push(markFlowStampEntry({
            path,
            label: { confidentiality: [...flowConfidentiality] },
            origin: "structure",
            observes: "enumerate",
          }));
        }
        // `*`-child CLASS TEMPLATES (template-population §3.1, closing the
        // SC-4/SC-8 residuals): the same J, minted once per class at
        // [...container, "*"] — O(1) in the container's size where the
        // spec's per-child `shape` encoding (§8.5.6.1) needed O(n).
        //  - `shape`: a per-child existence probe ("is /items/3
        //    present?", §8.10.1.1) consumes the membership decision;
        //  - `value`: materializing the reference scalar at a slot
        //    (§4.6.3 ref-container rule) consumes it too;
        //  - `followRef`: a slot-pointer probe/deref consumes the
        //    assignment J — WHICH element the reader resolves through
        //    was decided by it (inv-9) — while `shape`/`value` templates
        //    stay out of probes (readConsumesEntry), keeping blind
        //    pass-through clean of content taint. All three carry ONLY
        //    the membership J (confidentiality-only, like every
        //    structure stamp), never the container's content label.
        // Same replace-from-criteria discipline as the enumerate stamp:
        // dropped + re-minted from the current J each reconcile, cleared
        // (never pooled — `poolsExistence` requires a class-less entry)
        // on covering writes.
        //
        // DECLARED-CONTAINER ROUTE ONLY — a measured deviation from the
        // design's §3.1 "both routes" (documented in
        // cfc-template-population.md §6 Stage A). Minting templates on
        // EVERY pure-link-structure value write puts them on the runtime's
        // own builder/coordination plumbing (alias shells, internal
        // arrays), and the op-instantiation machinery reads those docs'
        // child paths (slot scalars, length) as scaffolding with NO
        // distinguishing journal marker — neither probe-classified nor
        // trace-covered — so each reconcile's J smears into the next
        // (measured: the phase-B pointwise map suite). The declared
        // list-coordinator containers (filter/flatMap results — the actual
        // §8.5.6.1/SC-7 membership subjects) are where the membership
        // decision lives; their templates close the SC-4/SC-8 residuals,
        // and the generic value-write route keeps today's
        // container-anchored stamps until machinery reads carry a marker.
        if (
          flowHasLabels && flowConfidentiality.length > 0 &&
          structureContainerPath !== undefined &&
          pathKey(structureContainerPath) === pathKey(path)
        ) {
          for (const observes of ["shape", "value", "followRef"] as const) {
            persistedLabelEntries.push(markFlowStampEntry({
              path: [...path, "*"],
              label: { confidentiality: [...flowConfidentiality] },
              origin: "structure",
              observes,
            }));
          }
        }
        // FROZEN existence entry (freeze-at-creation, spec branch
        // cfc/existence-freeze-at-creation): minted once — at the first
        // labeled stamping of this container (creation, or migration of
        // pre-existing data, over-attributing conservatively) — carrying
        // the creating attempt's join plus any cleared legacy covering
        // structure confidentiality at-or-below (the one-time migration
        // absorb). Never grown, never cleared; a carried entry above wins.
        const hasFrozenExistence = persistedLabelEntries.some((entry) =>
          (entry.origin === "derived" || entry.origin === "structure") &&
          entry.observes === "shape" && pathKey(entry.path) === pathKey(path)
        );
        if (!hasFrozenExistence) {
          const frozen = frozenConfidentialityFor(path);
          if (frozen.length > 0) {
            persistedLabelEntries.push(markFlowStampEntry({
              path,
              label: { confidentiality: frozen },
              origin: "structure",
              observes: "shape",
            }));
          }
        }
      }
      // Legacy migration conf not absorbed by any stamp path (a link write
      // replaced the slot, a declared entry re-minted at the path, or the
      // tx had no label of its own): the shallowest written path covering
      // the cleared legacy entry — or, when none does (a declared re-mint
      // without a write there), the entry's own path — receives the frozen
      // shape entry so the existence history survives the migration.
      const leftoverByPath = new Map<
        string,
        { path: readonly string[]; atoms: unknown[] }
      >();
      clearedExistence.forEach((cleared, index) => {
        if (attachedExistence.has(index)) {
          return;
        }
        let shallowest: readonly string[] | undefined;
        for (const written of flowWrittenPaths) {
          if (
            isPrefix(written, cleared.path) &&
            (shallowest === undefined || written.length < shallowest.length)
          ) {
            shallowest = written;
          }
        }
        const anchor = shallowest ?? cleared.path;
        const key = pathKey(anchor);
        const bucket = leftoverByPath.get(key) ??
          { path: anchor, atoms: [...flowConfidentiality] };
        bucket.atoms.push(...cleared.confidentiality);
        leftoverByPath.set(key, bucket);
      });
      for (const bucket of leftoverByPath.values()) {
        persistedLabelEntries.push(markFlowStampEntry({
          path: canonicalizeLogicalPath(bucket.path),
          label: { confidentiality: foldedUnique(bucket.atoms) },
          origin: "derived",
          observes: "shape",
        }));
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

    // Inv-12 Stage 1 (SC-25): apply the classification-governed
    // representation transform to every cross-space-eligible entry, BEFORE
    // coalescing (so post-transform duplicates dedup structurally) and
    // before the SC-11 canonical comparison below (so re-deriving an
    // unchanged label stays a no-op against the TRANSFORMED stored form —
    // equality is computed post-transform, per the §4.6.4 no-op rule).
    // `enforce` persists the transformed entries; `observe` persists
    // verbatim and emits one structured divergence diagnostic per target —
    // the rollout metric; `off` never reaches here (no entry is eligible).
    if (crossSpaceEligible !== undefined && crossSpaceEligible.size > 0) {
      let divergent = 0;
      for (let i = 0; i < persistedLabelEntries.length; i++) {
        const entry = persistedLabelEntries[i];
        if (!crossSpaceEligible.has(entry)) continue;
        const transformed = transformCfcLabelForCrossSpacePersist(entry.label);
        // Copy-on-write transform: same reference back = nothing to commit
        // in this entry (already-committed forms pass through idempotently).
        if (transformed === entry.label) continue;
        divergent += 1;
        if (labelProtectionMode === "enforce") {
          persistedLabelEntries[i] = { ...entry, label: transformed };
        }
      }
      if (labelProtectionMode === "observe" && divergent > 0) {
        tx.noteCfcDiagnostic(
          `label-metadata-protection(observe): would transform ${divergent} ` +
            `cross-space label entr${divergent === 1 ? "y" : "ies"} for ${id}`,
        );
      }
    }

    // Stage B (template-population §5/§6; spec §4.6.4.2): derive the
    // label-metadata population templates from the FINAL payload entries —
    // after every clear/carry/mint AND after the Stage-1 representation
    // transform above, so template label content is byte-identical to the
    // payload labels it describes (the transform applies to templates by
    // construction: they copy post-transform bytes — one transform, both
    // sinks). Deterministic per payload-entry set, so the SC-11 canonical
    // comparison below still skips unchanged recomputes; coalescing next
    // joins the per-entry population labels of same-path payload entries
    // (the C2 value/shape split) into one per-path template, which is what
    // the per-path §4.6.4.1 metadata addressing requires. No new dial: the
    // templates describe whatever payload entries the existing dials
    // persisted.
    persistedLabelEntries.push(
      ...deriveLabelMetadataTemplateEntries(persistedLabelEntries),
    );

    const coalescedLabelEntries = coalesceLabelEntries(persistedLabelEntries);

    if (
      coalescedLabelEntries.length === 0 && !flowCleared &&
      !droppedLabelMetadataTemplates
    ) {
      continue;
    }

    const metadata: CfcMetadata = {
      version: 1,
      schemaHash: schemaAndHash.taggedHashString,
      labelMap: {
        version: 1,
        entries: coalescedLabelEntries,
      },
    };

    // SC-11 idempotence: skip the envelope write when the derived metadata is
    // canonically identical to what is already stored. Re-deriving an unchanged
    // label must not rewrite the `["cfc"]` doc — that would bump the document
    // revision and churn the sync/conflict machinery on every recompute. This
    // is load-bearing once `cfcFlowLabels:"persist"` attaches a derived
    // component to EVERY value write (H2): the common case is a rerun that
    // reads the same inputs and derives the same labels, which must be a no-op.
    // `canonicalizeCfcMetadata` sorts entries + canonicalizes clauses, so the
    // comparison is order-insensitive and matches `cfcLabelViewsEqual`
    // semantics. The storage layer's raw deep-equal write elision does NOT
    // subsume this: a canonically-equal rebuild can differ from the stored
    // form byte-wise (entry order, OR-clause alternative order), and SC-11
    // demands equality over the canonical form (§4.1.3 c14n).
    //
    // Checked BEFORE ensureSchemaDocument so a skipped target writes nothing
    // at all: canonical equality implies metadata.schemaHash ===
    // existing.schemaHash, and that schema document was already loaded (and
    // content-verified) via loadSchemaDocument above — it exists, so there is
    // nothing to ensure.
    if (
      existing !== undefined &&
      deepEqual(
        canonicalizeCfcMetadata(existing),
        canonicalizeCfcMetadata(metadata),
      )
    ) {
      continue;
    }

    ensureSchemaDocument(
      tx,
      space,
      schemaAndHash.taggedHashString,
      schemaAndHash.schema,
    );
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
  // Single-use grant consumption (design §2.2): stage every claim the
  // consuming gates above registered — the receipt write plus its
  // create-only mark — into THIS transaction, inside the privileged scope
  // prepareCfc wraps this whole pass in (the receipt is reserved-namespace
  // policy state; the unprivileged arm is the S18 gate). After every gate so
  // all resolutions are registered; before the return so a claim that cannot
  // stage fails closed as a prepare reason. The staged write rides the
  // releasing commit: consumption is atomic with the release, a failed
  // commit consumes nothing (spec §6.5.2 no-consume-on-failure), and the
  // create-only race loser dies as a permanent `receipt-exists` rejection.
  reasons.push(...flushCfcGrantConsumptionClaims(tx));
  // Stage-0 summary: at most once per prepare, and only when a protected
  // write was measured — a prepare that gated nothing has no precision to
  // report.
  if (prefixProvenance !== undefined && prefixProvenance.protectedWrites > 0) {
    instrumentation!.onPrefixProvenance!(prefixProvenance);
  }
  return reasons;
};
