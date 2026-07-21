import { hashStringOf } from "@commonfabric/data-model/value-hash";
import { encodePointer } from "../../../memory/v2/path.ts";
import type {
  AttemptedWrite,
  CfcAddress,
  CfcDereferenceTrace,
  CfcLabelMetadataObservation,
  CfcMetadata,
  ConsultedGrant,
  ConsultedPolicyManifest,
  ConsumedRead,
  OrderedWriteAttempt,
  PreparedDigestInput,
  WritePolicyInput,
} from "./types.ts";
import { cloneCfcLabelView, type IFCLabel } from "./label-view-core.ts";
import { isOrClause, normalizeClause } from "./clause.ts";

/**
 * Returns a canonical-form logical path: any leading `"value"` element
 * stripped, deep-frozen so the array is safe to use as a cache key or
 * to retain in long-lived data structures. Callers may rely on
 * "canonical paths are immutable" as a system invariant.
 *
 * The result is normally a fresh array. As a fast path, if the input
 * is already frozen and already in canonical form (no leading
 * `"value"`), the input is returned unchanged — useful when
 * canonicalize* re-runs on already-canonical input (e.g. during a CFC
 * commit-recheck pass).
 */
export const canonicalizeLogicalPath = (
  path: readonly string[],
): readonly string[] => {
  if (path[0] !== "value" && Object.isFrozen(path)) {
    return path;
  }
  const next = path[0] === "value" ? path.slice(1) : path.slice();
  Object.freeze(next);
  return next;
};

/**
 * WeakMap cache mapping a path-array identity to its JSON-pointer
 * encoding. Only frozen paths are cached — `Object.isFrozen()` is
 * checked at insertion time so an unfrozen caller (whether internal
 * or, since this function is exported, an external one) can't seed
 * the cache with content that may later mutate behind the cache's
 * back. Entries are collected when the path array is GC'd.
 *
 * Real workloads (per runner-test instrumentation) hit
 * `compareAddress()` ~26k times in a 60s test pass, of which ~82%
 * reach the path step and call into here twice per pair; ~83% of
 * those calls hit the cache (most addresses share path identity
 * within a sort).
 */
const pathPointerCache = new WeakMap<readonly string[], string>();

export const logicalPathToPointer = (path: readonly string[]): string => {
  const cached = pathPointerCache.get(path);
  if (cached !== undefined) return cached;
  const pointer = encodePointer(canonicalizeLogicalPath(path));
  if (Object.isFrozen(path)) pathPointerCache.set(path, pointer);
  return pointer;
};

const compareAddress = (left: CfcAddress, right: CfcAddress): number => {
  if (left.space !== right.space) {
    return left.space < right.space ? -1 : 1;
  }
  if (left.id !== right.id) return left.id < right.id ? -1 : 1;
  if (left.scope !== right.scope) return left.scope < right.scope ? -1 : 1;
  const leftPointer = logicalPathToPointer(left.path);
  const rightPointer = logicalPathToPointer(right.path);
  return leftPointer < rightPointer ? -1 : leftPointer > rightPointer ? 1 : 0;
};

const compareConsultedGrant = (
  left: ConsultedGrant,
  right: ConsultedGrant,
): number => {
  if (left.space !== right.space) return left.space < right.space ? -1 : 1;
  if (left.id !== right.id) return left.id < right.id ? -1 : 1;
  return left.digest < right.digest ? -1 : left.digest > right.digest ? 1 : 0;
};

const compareConsultedPolicyManifest = (
  left: ConsultedPolicyManifest,
  right: ConsultedPolicyManifest,
): number => {
  const leftKey = hashStringOf(left.reference);
  const rightKey = hashStringOf(right.reference);
  if (leftKey !== rightKey) return leftKey < rightKey ? -1 : 1;
  return left.state < right.state ? -1 : left.state > right.state ? 1 : 0;
};

const compareLabelMetadataObservation = (
  left: CfcLabelMetadataObservation,
  right: CfcLabelMetadataObservation,
): number => {
  const primary = compareAddress(left.target, right.target);
  if (primary !== 0) return primary;
  // Same metadata address: total-order distinct records by canonical hash
  // (the compareWritePolicyInput tiebreaker idiom) so recording order cannot
  // perturb the digest.
  const leftHash = hashStringOf(left);
  const rightHash = hashStringOf(right);
  return leftHash < rightHash ? -1 : leftHash > rightHash ? 1 : 0;
};

const compareWritePolicyInput = (
  left: WritePolicyInput,
  right: WritePolicyInput,
): number => {
  if (left.kind < right.kind) return -1;
  if (left.kind > right.kind) return 1;

  // Same kind on both sides. Use a structurally meaningful sub-key
  // so canonical order is readable in debug output; fall back to the
  // canonical hash to give a total order on otherwise-distinct records.
  let primary = 0;
  switch (left.kind) {
    case "schema":
    case "structural-provenance":
    case "trusted-event":
    case "link-write": {
      const r = right as typeof left;
      primary = compareAddress(left.target, r.target);
      break;
    }
    case "custom": {
      const r = right as typeof left;
      primary = left.name < r.name ? -1 : left.name > r.name ? 1 : 0;
      break;
    }
    case "sink-request": {
      const r = right as typeof left;
      primary = left.effectId < r.effectId
        ? -1
        : left.effectId > r.effectId
        ? 1
        : 0;
      break;
    }
  }
  if (primary !== 0) return primary;
  const leftHash = hashStringOf(left);
  const rightHash = hashStringOf(right);
  return leftHash < rightHash ? -1 : leftHash > rightHash ? 1 : 0;
};

// Note: these `canonicalize*` helpers don't freeze their output. Records
// destined for CFC state are frozen at their entry chokepoints
// (`buildPreparedDigestInput`, `recordCfcDereferenceTrace`,
// `recordCfcWritePolicyInput`); `canonicalize*` is also called during
// `canonicalizePreparedDigestInput` re-canonicalization, where freezing
// every fresh wrapper would add measurable cost without a correctness
// benefit. The path-array invariant — every canonical path is frozen and
// safe to use as a cache key — is held by `canonicalizeLogicalPath`
// itself.
export const canonicalizeConsumedRead = (
  read: ConsumedRead,
): ConsumedRead => ({
  ...read,
  path: canonicalizeLogicalPath(read.path),
});

export const canonicalizeAttemptedWrite = (
  write: AttemptedWrite,
): AttemptedWrite => ({
  ...write,
  path: canonicalizeLogicalPath(write.path),
});

export const canonicalizeDereferenceTrace = (
  trace: CfcDereferenceTrace,
): CfcDereferenceTrace => ({
  ...trace,
  source: canonicalizeAttemptedWrite(trace.source),
  target: canonicalizeAttemptedWrite(trace.target),
});

export const canonicalizeWritePolicyInput = (
  input: WritePolicyInput,
): WritePolicyInput => {
  switch (input.kind) {
    case "schema":
      return { ...input, target: canonicalizeAttemptedWrite(input.target) };
    case "structural-provenance":
      return {
        ...input,
        target: canonicalizeAttemptedWrite(input.target),
        sources: [...input.sources].map(canonicalizeAttemptedWrite).sort(
          compareAddress,
        ),
      };
    case "trusted-event":
      return { ...input, target: canonicalizeAttemptedWrite(input.target) };
    // Clause-canonicalization coverage note: the digest hashes label-bearing
    // material in two places beyond the labelMap. Carried `link-write` label
    // views are RUNTIME-DERIVED (view merges can order alternatives
    // differently across derivations), so their clause interiors are
    // canonicalized here. `schema` inputs are deliberately NOT touched: a
    // schema is a content-addressed authored artifact whose bytes are its
    // identity (`schemaHash`) — rewriting `ifc` clause interiors inside the
    // digest view would diverge it from the schema's own hash, and a single
    // artifact's internal ordering is stable by construction anyway.
    case "link-write": {
      const cloned = cloneCfcLabelView(input.cfcLabelView);
      const cfcLabelView = cloned === undefined ? undefined : {
        version: cloned.version,
        entries: cloned.entries.map((entry) => ({
          path: entry.path,
          label: canonicalizeCfcLabel(entry.label),
        })),
      };
      return {
        ...input,
        target: canonicalizeAttemptedWrite(input.target),
        source: canonicalizeAttemptedWrite(input.source),
        ...(cfcLabelView !== undefined && { cfcLabelView }),
      };
    }
    case "custom":
      return input.target === undefined
        ? input
        : { ...input, target: canonicalizeAttemptedWrite(input.target) };
    case "sink-request":
      return input;
  }
};

/**
 * Canonical form of a label for digest purposes. Clause-INTERIOR
 * canonicalization only: each confidentiality entry that is an OR-clause gets
 * its alternatives deduped/sorted (and singletons unwrapped) via
 * `normalizeClause`, so two labels differing only in alternative insertion
 * order digest identically. The top-level entry lists (clause list, integrity
 * set) keep their given order — flat labels pass through byte-identical, and
 * persisted forms are never reordered by canonicalization (SC-11 idempotence
 * comparisons stay stable).
 */
export const canonicalizeCfcLabel = (label: IFCLabel): IFCLabel => {
  const confidentiality = label.confidentiality;
  if (
    !Array.isArray(confidentiality) || !confidentiality.some(isOrClause)
  ) {
    return label;
  }
  return {
    ...label,
    confidentiality: confidentiality.map(normalizeClause),
  };
};

export const canonicalizeCfcMetadata = (
  metadata: CfcMetadata,
): CfcMetadata => ({
  version: 1,
  schemaHash: metadata.schemaHash,
  labelMap: {
    version: 1,
    entries: [...metadata.labelMap.entries].map((entry) => ({
      path: canonicalizeLogicalPath(entry.path),
      label: canonicalizeCfcLabel(entry.label),
      ...(entry.origin !== undefined ? { origin: entry.origin } : {}),
      ...(entry.observes !== undefined ? { observes: entry.observes } : {}),
    })).sort((left, right) => {
      const leftKey = logicalPathToPointer(left.path);
      const rightKey = logicalPathToPointer(right.path);
      if (leftKey !== rightKey) {
        return leftKey < rightKey ? -1 : 1;
      }
      const leftOrigin = left.origin ?? "";
      const rightOrigin = right.origin ?? "";
      if (leftOrigin !== rightOrigin) {
        return leftOrigin < rightOrigin ? -1 : 1;
      }
      // Same (path, origin) can legitimately hold per-class entries (the C2
      // persist split writes `value` and `shape` siblings) — order by class
      // so canonicalization stays deterministic.
      const leftObserves = left.observes ?? "";
      const rightObserves = right.observes ?? "";
      return leftObserves < rightObserves
        ? -1
        : leftObserves > rightObserves
        ? 1
        : 0;
    }),
  },
});

export const canonicalizePreparedDigestInput = (
  input: PreparedDigestInput,
): PreparedDigestInput => ({
  consumedReads: [...input.consumedReads].map(canonicalizeConsumedRead).sort(
    compareAddress,
  ),
  attemptedWrites: [...input.attemptedWrites].map(canonicalizeAttemptedWrite)
    .sort(compareAddress),
  writes: [...input.writes].map(canonicalizeAttemptedWrite).sort(
    compareAddress,
  ),
  // ORDER-PRESERVING on purpose (sorted by journalIndex, which is unique
  // per record, so this is a total order): the log exists to bind the
  // temporal write sequence into the digest — an address-sort here would
  // discard exactly the information the write-prefix gate's decision
  // depends on (docs/specs/cfc-write-prefix-provenance.md §6). Paths stay
  // raw/verbatim for the same reason (surface fidelity).
  writeAttemptLog: [...(input.writeAttemptLog ?? [])].sort(
    (left: OrderedWriteAttempt, right: OrderedWriteAttempt) =>
      left.journalIndex - right.journalIndex,
  ),
  triggerReads: [...(input.triggerReads ?? [])].map(canonicalizeAttemptedWrite)
    .sort(compareAddress),
  dereferenceTraces: [...input.dereferenceTraces].map(
    canonicalizeDereferenceTrace,
  ).sort((left, right) => {
    const sourceCompare = compareAddress(left.source, right.source);
    if (sourceCompare !== 0) {
      return sourceCompare;
    }
    const targetCompare = compareAddress(left.target, right.target);
    if (targetCompare !== 0) return targetCompare;
    return left.kind < right.kind ? -1 : left.kind > right.kind ? 1 : 0;
  }),
  writePolicyInputs: [...input.writePolicyInputs].map(
    canonicalizeWritePolicyInput,
  ).sort(compareWritePolicyInput),
  implementationIdentity: input.implementationIdentity,
  trustSnapshot: input.trustSnapshot,
  ...(input.moduleDelegations !== undefined &&
      input.moduleDelegations.length > 0
    ? {
      moduleDelegations: [...input.moduleDelegations]
        .map((entry) => ({
          moduleIdentity: entry.moduleIdentity,
          delegatedModuleIdentities: [
            ...entry.delegatedModuleIdentities,
          ].sort(),
        }))
        .sort((left, right) =>
          left.moduleIdentity < right.moduleIdentity
            ? -1
            : left.moduleIdentity > right.moduleIdentity
            ? 1
            : 0
        ),
    }
    : {}),
  // Already canonical: a digest-only projection of the frozen policy
  // snapshot (Epic B5). Absent (no policies configured) stays absent so
  // pre-B5 digests are unchanged.
  policySnapshot: input.policySnapshot,
  // Consulted grants (§8.12.7 route 2a): address-sorted so recording order
  // cannot perturb the digest (order-insensitive by design — which guard
  // consulted a grant first is not decision content). An EMPTY set collapses
  // to ABSENT: "no grants consulted" has one spelling, and pre-grant digests
  // are unchanged.
  ...(input.consultedGrants !== undefined && input.consultedGrants.length > 0
    ? {
      consultedGrants: [...input.consultedGrants].sort(compareConsultedGrant),
    }
    : {}),
  ...(input.consultedPolicyManifests !== undefined &&
      input.consultedPolicyManifests.length > 0
    ? {
      consultedPolicyManifests: [...input.consultedPolicyManifests].sort(
        compareConsultedPolicyManifest,
      ),
    }
    : {}),
  // Label-metadata observations (inv-12 Stage 2): address-sorted with a
  // canonical-hash tiebreak, so recording order is not decision content.
  // Confidentiality arrays stay verbatim (they are population-rule joins,
  // already deduped at construction); an empty set collapses to absent so
  // pre-Stage-2 digests are unchanged.
  ...(input.labelMetadataObservations !== undefined &&
      input.labelMetadataObservations.length > 0
    ? {
      labelMetadataObservations: [...input.labelMetadataObservations].sort(
        compareLabelMetadataObservation,
      ),
    }
    : {}),
});

export const preparedDigestFor = (input: PreparedDigestInput): string =>
  hashStringOf(canonicalizePreparedDigestInput(input));
