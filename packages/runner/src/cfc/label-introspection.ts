import { isRecord } from "@commonfabric/utils/types";
import { encodePointer, parsePointer } from "../../../memory/v2/path.ts";
import type { NormalizedFullLink } from "../link-utils.ts";
import { normalizeCellScope } from "../scope.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import { canonicalizeLogicalPath } from "./canonical.ts";
import { clauseAlternatives } from "./clause.ts";
import { classifyAtomField } from "./label-field-classification.ts";
import {
  commitmentAwareEquals,
  isCfcFieldCommitment,
} from "./label-representation.ts";
import { readStoredCfcMetadata } from "./metadata.ts";
import { uniqueCfcAtoms } from "./observation.ts";
import type { CfcMetadata, LabelMapEntry } from "./types.ts";

// Inv-12 Stage 2 (SC-25/SC-6; docs/specs/cfc-label-metadata-confidentiality.md
// §3/§5; spec §4.6.4.1-.2): the bounded first-layer label-introspection
// evaluator behind the `inspectConfLabel` builtin, plus the §4.6.4.2 interim
// population rule that labels each metadata observation it consumes.
//
// Scope discipline:
// - FIRST LAYER ONLY. A query addresses the confidentiality label stored at
//   one payload path (`/body` ↔ the `/value/body` envelope entry); the
//   labels-of-labels subtree (`/cfc/labels/...`) is runtime-enforced metadata
//   and is not introspectable (`parseConfLabelTargetPath` refuses `/cfc`).
// - EQUALITY PREDICATES ONLY, over the six §4.6.4.1 fields. An absent field
//   is no match (consulting absence is an atom-shape observation — public
//   under the default profile).
// - OUTCOME NORMALIZATION. Unobservable targets, missing metadata and
//   matching-but-unreadable atoms all collapse to one byte-identical
//   `{status:"notAvailable"}`; `ok` with empty atoms is returned only when
//   every per-atom field observation consulted to establish the miss was
//   observable (its population label exists), so the caller cannot
//   distinguish the hidden arms.
// - CONSUMPTION. Every `ok` outcome reports the joined population-rule
//   confidentiality of the field observations it consumed
//   (`consumedConfidentiality`); the transaction channel
//   (`recordCfcLabelMetadataObservation`) is wired by the builtin, not here —
//   this module stays pure over stored metadata.

/**
 * The §4.6.4.1 query: equality tests only. All six fields are supported even
 * where the runner has no mint site today (`policyName` matches the B2b
 * label-carried Policy/Context ref atoms; `originUri` currently matches
 * nothing) — an absent field on the candidate atom is simply no match.
 */
export type ConfLabelQuery = {
  atomType?: string;
  caveatKind?: string;
  source?: unknown;
  resourceClass?: string;
  policyName?: string;
  originUri?: string;
};

/**
 * One projected atom, addressed by its position in the STORED label at the
 * target path. The runner stores one `LabelMapEntry` per component at a path
 * and the effective label is their clause concatenation (`mergeLabel` joins
 * by clause concatenation), so `clauseIndex` runs across the concatenated
 * per-entry confidentiality clause lists in stored entry order.
 * `alternativeIndex` addresses the alternative inside an `{anyOf: [...]}`
 * clause (0 for a bare singleton atom). `atomIndex` is the atom's position
 * within the alternative — in this runtime an alternative IS one atom, so it
 * is always 0; the field exists so the projection shape matches the
 * §4.6.4.1 profile, whose addressing allows representations with grouped
 * alternatives.
 */
export type LabelAtomProjection = {
  targetPath: string;
  clauseIndex: number;
  alternativeIndex: number;
  atomIndex: number;
  atom: unknown;
};

export type InspectConfLabelResult =
  | { status: "ok"; atoms: LabelAtomProjection[] }
  | { status: "notAvailable" };

/**
 * The one spelling of the hidden outcome. Shared by every arm — unobservable
 * target, missing metadata, unevaluable query, unreadable match, and the
 * flow-off degradation — so the arms are indistinguishable by construction.
 */
export const CONF_LABEL_NOT_AVAILABLE: InspectConfLabelResult = Object.freeze({
  status: "notAvailable" as const,
});

export type ConfLabelQueryEvaluation = {
  result: InspectConfLabelResult;
  /**
   * Joined population-rule confidentiality of every labeled metadata
   * observation the evaluation consumed (per-field consultations and
   * whole-atom projections). Deduped. Always empty for `notAvailable`: the
   * hidden arms are value-independent of protected fields (the response is
   * the shared constant), so nothing protected flowed to the caller.
   */
  consumedConfidentiality: readonly unknown[];
};

/**
 * Parse the application-facing payload pointer of §4.6.4.1 into the canonical
 * entry path. `/body` addresses the payload label stored at the `/value/body`
 * envelope entry, whose labelMap path is the canonical (value-stripped)
 * `["body"]`; an explicit `/value` prefix is accepted as the envelope
 * spelling of the same path (mirroring `canonicalizeLogicalPath`).
 *
 * Returns `undefined` — the caller collapses to `notAvailable` — for the
 * envelope metadata subtree (`/cfc/...`): labels attached to label metadata
 * are runtime-enforced metadata, not introspectable payload (the §4.6.4.1
 * first-layer rule). A payload field literally named `cfc` at the root is
 * consequently not addressable through this API; the collision with the
 * metadata sibling fails closed.
 */
export const parseConfLabelTargetPath = (
  pointer: string,
): readonly string[] | undefined => {
  let segments: string[];
  try {
    segments = parsePointer(pointer);
  } catch {
    return undefined;
  }
  const canonical = canonicalizeLogicalPath(segments);
  if (canonical[0] === "cfc") {
    return undefined;
  }
  return canonical;
};

// ---------------------------------------------------------------------------
// The §4.6.4.2 interim population rule, computed from the entry in hand.

/**
 * Observation label of one atom field, or `undefined` when the field is
 * UNOBSERVABLE (population fails closed). An empty confidentiality array is a
 * PUBLIC observation.
 */
type FieldObservation = readonly unknown[] | undefined;

/**
 * Whether the entry's own effective confidentiality is a sound population
 * label for its source-bearing fields: true exactly for the components
 * produced by the §8.9.2 conservative join — `derived` (the per-tx flow
 * stamp) and `structure` (the same join stamped on container shape,
 * §8.5.6.1) — whose label contains each influencing source's confidentiality
 * by construction. Declared/authored entries, link-carried pointer labels,
 * the external-ingest mark and legacy (component-less) entries carry no such
 * containment guarantee and stay fail-closed (spec §4.6.4.2, merged via
 * specs#14).
 */
const entryHasDerivedContainment = (entry: LabelMapEntry): boolean =>
  entry.origin === "derived" || entry.origin === "structure";

/**
 * The interim population rule for one field of one atom in one entry:
 *
 * 1. `type`/`kind` at an atom root — and atom presence itself — are public
 *    (the normative §4.6.4.2 default).
 * 2. A field the Stage-0 classification table marks `public` (disclosure is
 *    the feature: authored attribution subjects, Policy/Context ref
 *    name/hash, `TransformedBy.identity.moduleIdentity`) is public.
 * 3. Every other present field is source-protected: its observation label is
 *    the source identity's confidentiality when known — no carrier exists
 *    for that today (the full per-field PathLabelTemplate profile under
 *    `/cfc/labels/...` is the SC-4/SC-8 co-build) — else, for
 *    derived-component entries only, the entry's own effective
 *    confidentiality (sound per the §8.9.2 containment argument); else
 *    UNOBSERVABLE (fail closed).
 *
 * A committed `{digestOf}` field keeps the same population label as its
 * plaintext form: the commitment hides the identity from casual observation
 * but stays probe-able, so observing it is still a protected observation.
 */
const fieldObservationLabel = (
  entry: LabelMapEntry,
  atom: unknown,
  field: string,
): FieldObservation => {
  if (field === "type" || field === "kind") {
    return [];
  }
  if (classifyAtomField(atom, [field]) === "public") {
    return [];
  }
  // Source-protected chain. Arm 1 (source identity confidentiality) has no
  // in-entry carrier today; arm 2 is the derived-component fallback; arm 3
  // fails closed.
  if (entryHasDerivedContainment(entry)) {
    return entry.label.confidentiality ?? [];
  }
  return undefined;
};

/**
 * Observation label of a WHOLE-ATOM projection: the join of the labels of
 * every field the projection reveals (§4.6.4.2 — "returning a whole
 * source-bearing atom remains source-protected even when `type` and `kind`
 * are public"). Walks nested records field-by-field with the classification
 * table's family-scoped addressing (a nested atom resets the field context,
 * mirroring the Stage 1 transform's walk), so a public wrapper cannot smuggle
 * a protected nested field out. Bare non-record atoms (string atoms) are
 * type-only tags — their entire content is the public type observation.
 *
 * Returns `undefined` when any revealed field is unobservable: the projection
 * — and with it the whole query (a matching-but-unreadable atom) — fails
 * closed.
 */
const atomProjectionLabel = (
  entry: LabelMapEntry,
  atom: unknown,
): FieldObservation => {
  const consumed: unknown[] = [];
  const walk = (value: unknown, contextAtom: unknown): boolean => {
    if (Array.isArray(value)) {
      return value.every((element) => walk(element, contextAtom));
    }
    if (!isRecord(value)) {
      return true;
    }
    if (isCfcFieldCommitment(value)) {
      // A bare commitment marker outside a classified field position (it
      // would have been consumed AS the field value below): protected.
      const label = entryHasDerivedContainment(entry)
        ? entry.label.confidentiality ?? []
        : undefined;
      if (label === undefined) return false;
      consumed.push(...label);
      return true;
    }
    // A record carrying a string `type` or `kind` is an atom for
    // classification purposes; plain nested records keep the enclosing
    // atom's context. Field-path depth beyond one segment (the
    // `TransformedBy.identity.*` rows) is handled by the recursion: the
    // nested record's fields are classified against the CONTEXT atom with
    // the single-segment path, and where that misses the table the field is
    // conservatively protected — strictly more protective than the Stage 1
    // transform's multi-segment resolution, never less.
    const isAtom = typeof (value as { type?: unknown }).type === "string" ||
      typeof (value as { kind?: unknown }).kind === "string";
    const context = isAtom ? value : contextAtom;
    for (const [key, field] of Object.entries(value)) {
      const observation = fieldObservationLabel(entry, context, key);
      if (observation === undefined) {
        return false;
      }
      if (observation.length > 0) {
        consumed.push(...observation);
        continue;
      }
      // Public field: recurse so a nested atom inside it (a `Caveat.by`
      // User atom) is still classified on its own terms. Scalar public
      // fields end the walk trivially.
      if (!walk(field, context)) {
        return false;
      }
    }
    return true;
  };
  return walk(atom, undefined) ? consumed : undefined;
};

// ---------------------------------------------------------------------------
// Query evaluation.

/** The atom field each §4.6.4.1 query predicate tests, by query key. */
const QUERY_FIELDS = {
  atomType: "type",
  caveatKind: "kind",
  source: "source",
  resourceClass: "class",
  policyName: "name",
  originUri: "uri",
} as const satisfies Record<keyof ConfLabelQuery, string>;

const entryPathMatchesTarget = (
  entry: LabelMapEntry,
  targetPath: readonly string[],
): boolean => {
  const entryPath = canonicalizeLogicalPath(entry.path);
  return entryPath.length === targetPath.length &&
    entryPath.every((segment, index) =>
      segment === targetPath[index] || segment === "*" ||
      targetPath[index] === "*"
    );
};

/**
 * Evaluate one §4.6.4.1 query against stored metadata. Pure: consumption is
 * REPORTED (see {@link ConfLabelQueryEvaluation}), not recorded — the caller
 * owns the transaction channel and the flow-dial degradation.
 *
 * `targetPath` is the canonical payload path (from
 * {@link parseConfLabelTargetPath}); only entries stored at exactly that path
 * participate (first-layer addressing — effective-label resolution across
 * ancestors is the display path's job, not introspection's).
 */
export const evaluateConfLabelQuery = (
  metadata: CfcMetadata | undefined,
  targetPath: readonly string[],
  query: ConfLabelQuery,
): ConfLabelQueryEvaluation => {
  if (metadata === undefined) {
    return {
      result: CONF_LABEL_NOT_AVAILABLE,
      consumedConfidentiality: [],
    };
  }
  const predicates = (Object.keys(QUERY_FIELDS) as (keyof ConfLabelQuery)[])
    .filter((key) => query[key] !== undefined)
    .map((key) => ({ field: QUERY_FIELDS[key], expected: query[key] }));
  const pointer = encodePointer(targetPath);
  const consumed: unknown[] = [];
  const atoms: LabelAtomProjection[] = [];
  let clauseIndex = 0;
  for (const entry of metadata.labelMap.entries) {
    if (!entryPathMatchesTarget(entry, targetPath)) {
      continue;
    }
    for (const clause of entry.label.confidentiality ?? []) {
      const alternatives = clauseAlternatives(clause);
      for (
        let alternativeIndex = 0;
        alternativeIndex < alternatives.length;
        alternativeIndex++
      ) {
        const atom = alternatives[alternativeIndex];
        let matched = true;
        for (const { field, expected } of predicates) {
          if (!isRecord(atom)) {
            // A bare string atom is a type-only atom: its entire content is
            // its (public) type tag, so `atomType` equality applies to the
            // atom itself; every other field is absent (no match, shape-only
            // consultation).
            matched = field === "type"
              ? commitmentAwareEquals(atom, expected)
              : false;
            if (!matched) break;
            continue;
          }
          if (!Object.hasOwn(atom, field)) {
            // Absent field = no match. Establishing absence is an atom-shape
            // observation — public under the default profile — so nothing
            // protected is consumed.
            matched = false;
            break;
          }
          const observation = fieldObservationLabel(entry, atom, field);
          if (observation === undefined) {
            // The query needs a field observation the population rule cannot
            // label: the WHOLE evaluation is unevaluable for this caller.
            // Bailing per-atom instead (skipping just this atom) would make
            // `ok` vs `notAvailable` depend on the unobservable field's
            // value — exactly the distinction normalization forbids.
            return {
              result: CONF_LABEL_NOT_AVAILABLE,
              consumedConfidentiality: [],
            };
          }
          // Testing equality observes the field whether it matches or not:
          // establishing a miss is a membership observation and consumes the
          // same per-field label (§4.6.4.2). Commitment-aware so a committed
          // `{digestOf}` field digest-matches its plaintext query form
          // (Stage 1 same-form matching).
          consumed.push(...observation);
          if (
            !commitmentAwareEquals(
              (atom as Record<string, unknown>)[field],
              expected,
            )
          ) {
            matched = false;
            break;
          }
        }
        if (!matched) {
          continue;
        }
        const projection = atomProjectionLabel(entry, atom);
        if (projection === undefined) {
          // Matching but unreadable: the projection would reveal a field the
          // population rule cannot label. Returning the other matches would
          // disclose (via ok-vs-notAvailable) facts about this atom; omitting
          // it would misreport a match as a miss. Collapse.
          return {
            result: CONF_LABEL_NOT_AVAILABLE,
            consumedConfidentiality: [],
          };
        }
        consumed.push(...projection);
        atoms.push({
          targetPath: pointer,
          clauseIndex,
          alternativeIndex,
          // An alternative is one atom in this runtime's representation; the
          // index exists for §4.6.4.1 shape fidelity (see
          // LabelAtomProjection).
          atomIndex: 0,
          // The STORED form, verbatim: committed fields stay committed
          // (never un-committed back to plaintext the caller supplied).
          atom,
        });
      }
      clauseIndex++;
    }
  }
  return {
    result: { status: "ok", atoms },
    consumedConfidentiality: uniqueCfcAtoms(consumed),
  };
};


/**
 * The full introspection step for one target, consuming on the transaction —
 * everything above the input plumbing the `inspectConfLabel` builtin owns:
 *
 * 1. Parse the payload pointer (a `/cfc/...` pointer — labels-of-labels — is
 *    refused: notAvailable).
 * 2. Read the resolved target's stored envelope through the SAME
 *    runtime-internal verifier seam prepare uses (`readStoredCfcMetadata`,
 *    INTERNAL_VERIFIER_META): the raw `["cfc"]` journal read stays excluded
 *    from flow/consumed derivations exactly as before (SC-6) — while still
 *    journaled, so reactivity re-runs the builtin when the envelope changes.
 *    A read ERROR is an unobservable target: notAvailable. Consumption
 *    happens through the explicit observation record below, never the raw
 *    read.
 * 3. Evaluate the §4.6.4.1 query (`evaluateConfLabelQuery`).
 * 4. The fail-closed dial rule (design §3 item 2; decision documented on the
 *    Stage 2 PR): a result whose evaluation consumed PROTECTED metadata
 *    observations is returned only when the transaction can carry the joined
 *    label onto the result — `cfcFlowLabels: "persist"` under a non-disabled
 *    enforcement mode, the one configuration where the derived component
 *    actually lands on the written result doc. Anywhere else the result
 *    would commit as an UNLABELED copy of protected label metadata, so it
 *    degrades to the same notAvailable as every hidden arm (indistinguishable
 *    by construction). Purely public results (empty consumed join) flow under
 *    every dial.
 * 5. Record the consumed observation (`recordCfcLabelMetadataObservation`):
 *    it joins the flow derivation (labeling the result through the normal
 *    per-tx J), the egress consumed set, the per-write input gate, and the
 *    prepared digest.
 */
export const inspectStoredConfLabel = (
  tx: IExtendedStorageTransaction,
  target: NormalizedFullLink,
  targetPath: string,
  query: ConfLabelQuery,
): InspectConfLabelResult => {
  const parsed = parseConfLabelTargetPath(targetPath);
  if (parsed === undefined) {
    return CONF_LABEL_NOT_AVAILABLE;
  }
  let metadata: CfcMetadata | undefined;
  try {
    metadata = readStoredCfcMetadata(tx, {
      space: target.space,
      id: target.id,
      scope: target.scope,
    });
  } catch {
    // Unobservable target — same constant as missing metadata below.
    return CONF_LABEL_NOT_AVAILABLE;
  }
  const payloadPath = [
    ...canonicalizeLogicalPath(target.path),
    ...parsed,
  ];
  const { result, consumedConfidentiality } = evaluateConfLabelQuery(
    metadata,
    payloadPath,
    query,
  );
  if (result.status !== "ok" || consumedConfidentiality.length === 0) {
    return result;
  }
  const state = tx.getCfcState();
  const carries = state.flowLabelsMode === "persist" &&
    state.enforcementMode !== "disabled";
  if (!carries) {
    tx.noteCfcDiagnostic(
      "label-introspection: protected metadata result withheld " +
        `(flowLabelsMode=${state.flowLabelsMode}, ` +
        `enforcementMode=${state.enforcementMode})`,
    );
    return CONF_LABEL_NOT_AVAILABLE;
  }
  tx.recordCfcLabelMetadataObservation({
    target: {
      space: target.space,
      id: target.id,
      scope: normalizeCellScope(target.scope),
      // The first-layer metadata subtree the observation is about
      // (§4.6.4.1): /cfc/labels/value/<payload path>.
      path: ["cfc", "labels", "value", ...payloadPath],
    },
    observes: "labelMetadata",
    confidentiality: [...consumedConfidentiality],
  });
  return result;
};
