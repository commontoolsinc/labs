import type { ImmutableJSONValue, JSONSchema } from "@commonfabric/api";
import { deepEqual } from "@commonfabric/utils/deep-equal";
import { isRecord } from "@commonfabric/utils/types";
import { hashStringOf } from "@commonfabric/data-model/value-hash";
import {
  cfcLabelPathPrefixMatches,
  type CfcLabelView,
} from "./label-view-core.ts";
import { atomEntails, matchAtomPattern } from "./atom-pattern.ts";
import {
  clauseAlternatives,
  clausesEqual,
  clauseSubsumes,
  normalizeClause,
} from "./clause.ts";

export type CfcObservedConfidentiality = readonly unknown[];
export type CfcObservationMaxConfidentiality =
  | readonly unknown[]
  | undefined;

// Marker confidentiality atom injected when a cell's label could not be read
// because a metadata read ERRORED (as opposed to being cleanly absent), so the
// LLM-observation path can fail CLOSED on read errors (audit item 22): a
// swallowed read error must not let confidential data serialize to the model as
// if it were public. `cfcObservationFitsCeiling` treats this marker as
// UNGRANTABLE — an observation carrying it never fits a ceiling, even one that
// names the marker, so it cannot be allow-listed by an author-supplied ceiling.
export const CFC_LABEL_READ_FAILED_ATOM = "cfc:label-read-failed";

// A clause "bears" the ungrantable read-failed marker if the marker is the
// clause itself OR any of its alternatives. Checking alternatives (not just
// whole-clause equality) is load-bearing: a marker wrapped in an OR-clause —
// `{anyOf:[MARKER, …]}` — must still be ungrantable, otherwise a ceiling that
// names the marker would subsume the wrapping clause and admit it, reopening
// the allow-list bypass the marker exists to prevent (audit item 22).
const clauseBearsReadFailedMarker = (clause: unknown): boolean =>
  clauseAlternatives(clause).some((alternative) =>
    deepEqual(alternative, CFC_LABEL_READ_FAILED_ATOM)
  );

export interface CfcOpaqueLink {
  "@link": string;
}

export interface CfcObservationResult<T = unknown> {
  value: T;
  observedConfidentiality: CfcObservedConfidentiality;
}

export const uniqueCfcAtoms = (
  atoms: Iterable<unknown>,
): ImmutableJSONValue[] => {
  const unique: ImmutableJSONValue[] = [];
  for (const atom of atoms) {
    if (!unique.some((existing) => deepEqual(existing, atom))) {
      unique.push(atom as ImmutableJSONValue);
    }
  }
  return unique;
};

export const joinCfcObservedConfidentiality = (
  parts: Iterable<readonly unknown[] | undefined>,
): CfcObservedConfidentiality => {
  const joined: unknown[] = [];
  for (const part of parts) {
    if (Array.isArray(part)) {
      joined.push(...part);
    }
  }
  return uniqueCfcAtoms(joined);
};

// Per-class node consumption (C4, C0 §4/§7). What an observation of the
// node at `logicalPath` consumes from a class-carrying label view:
//
// - a `value` observation (serializing the node's content) consumes content
//   labels — covering and `value`-class entries — at-or-above the node
//   (ancestor content contains the node), plus `shape`/`enumerate` entries
//   AT the node itself: enumerating the node's own members reveals its
//   membership, but an ADDRESSED child does not inherit the container's
//   membership label (the C4 precision win — the caller named the path).
//   `followRef` entries are never content.
// - a `followRef` observation (rendering an opaque link handle: WHICH
//   reference sits here, without following it) consumes followRef-class
//   entries at-or-above the node and nothing else — the pointer's label,
//   not the target's content (C0 §7).
//
// Entries without a class (legacy views, carried views) stay covering for
// content — byte-identical to the pre-C4 join for value observations.
export const cfcConfidentialityForObservationNode = (
  options: {
    schema?: JSONSchema;
    labelView?: CfcLabelView;
    logicalPath?: readonly string[];
    observes?: "value" | "followRef";
  },
): CfcObservedConfidentiality => {
  const joined: unknown[] = [];
  const logicalPath = options.logicalPath ?? [];
  const observes = options.observes ?? "value";

  if (
    observes === "value" && isRecord(options.schema) &&
    isRecord(options.schema.ifc)
  ) {
    joined.push(...(options.schema.ifc.confidentiality ?? []));
  }

  if (options.labelView !== undefined) {
    for (const entry of options.labelView.entries) {
      if (!cfcLabelPathPrefixMatches(entry.path, logicalPath)) {
        continue;
      }
      const consumed = observes === "followRef"
        ? entry.observes === "followRef"
        : entry.observes === undefined || entry.observes === "value" ||
          ((entry.observes === "shape" || entry.observes === "enumerate") &&
            entry.path.length === logicalPath.length);
      if (consumed) {
        joined.push(...(entry.label.confidentiality ?? []));
      }
    }
  }

  return uniqueCfcAtoms(joined);
};

export const cfcObservationFitsCeiling = (
  confidentiality: readonly unknown[],
  observationMaxConfidentiality: CfcObservationMaxConfidentiality,
): boolean => {
  // undefined means no ceiling. A declared but empty ceiling means "public
  // only": no confidential atom is permitted. Public data (no confidentiality
  // atoms) fits any ceiling, including the empty one.
  if (observationMaxConfidentiality === undefined) {
    return true;
  }

  // The read-failed marker is UNGRANTABLE: an observation that carries it never
  // fits a declared ceiling, even one that names the marker. The atom is an
  // exported string, so an author-supplied ceiling could otherwise allow-list it
  // and defeat the fail-closed redaction (audit item 22). atomsOutsideCeiling
  // already forces the marker outside every declared ceiling; keep this explicit
  // rejection too as defense in depth for the redaction path. Inspect clause
  // alternatives, not just whole-clause equality, so a wrapped marker
  // (`{anyOf:[MARKER]}`) cannot slip past into subsumption.
  if (confidentiality.some(clauseBearsReadFailedMarker)) {
    return false;
  }

  return atomsOutsideCeiling(confidentiality, observationMaxConfidentiality)
    .length === 0;
};

/**
 * Does carried atom `actual` satisfy floor requirement `required`
 * (§8.10.3)? The requirement is an ATOM PATTERN — `matchAtomPattern`'s
 * subset-field semantics let a floor name exactly the fields it demands
 * (`{type: CaveatScreened, verdict: "pass"}` accepts any trusted mint with
 * those fields) — with `atomEntails` layered for the ordered families.
 * Exact structural equality is the degenerate case of both, so floors
 * authored as concrete atoms keep their meaning. Concept-valued
 * requirements via the trust closure are D5 (this stays a pure predicate).
 */
const integrityAtomSatisfies = (
  required: unknown,
  actual: unknown,
): boolean =>
  matchAtomPattern(required, actual) !== null || atomEntails(actual, required);

/**
 * Integrity-floor membership (§8.10.3 / §8.12.4.1): every required pattern
 * must be satisfied by some carried integrity atom. This is THE single
 * shared predicate for the read-side gate (`verifyInputRequirements`, via
 * the coherent form below), the write-side floor (`verifyWriteFloor`, Epic
 * D3), and the tool-input floor (llm-dialog, Epic D2), so D5's upgrade to
 * concept matching (`conceptSatisfied`) lands in ONE place instead of
 * diverging across three inlined copies.
 */
export const cfcIntegritySatisfiesFloor = (
  integrity: readonly unknown[],
  requiredIntegrity: readonly unknown[],
): boolean =>
  requiredIntegrity.every((required) =>
    integrity.some((actual) => integrityAtomSatisfies(required, actual))
  );

/**
 * Witness key of a floor match (§8.10.3 `witnessKeyForRequiredMatch`): the
 * canonical identity of the concrete atom that satisfied a requirement, used
 * to demand ONE shared witness across consumed leaves. Value-bound atoms
 * keyed by `scope.valueRef` drop `scope.projection` first — two projections
 * of the same bound value are the same witness. `null` when the atom does
 * not satisfy the requirement.
 */
export const cfcIntegrityWitnessKey = (
  required: unknown,
  actual: unknown,
): string | null => {
  if (!integrityAtomSatisfies(required, actual)) return null;
  if (
    isRecord(actual) && isRecord((actual as { scope?: unknown }).scope) &&
    (actual as { scope: { valueRef?: unknown } }).scope.valueRef !== undefined
  ) {
    const scope = { ...(actual as { scope: Record<string, unknown> }).scope };
    delete scope.projection;
    return hashStringOf({ ...actual, scope });
  }
  return hashStringOf(actual);
};

/**
 * Object-level coherent floor satisfaction (§8.10.3): when one
 * `requiredIntegrity` requirement spans MULTIPLE consumed descendant leaves,
 * each requirement must be satisfied by one SHARED witness atom across all
 * of them — per requirement, the intersection of the leaves' witness-key
 * sets must be non-empty. Heterogeneous per-leaf witnesses (leaf A satisfies
 * via one screening atom, leaf B via a different one) fail: "each part was
 * screened by someone" is not "the object was screened". The single-leaf
 * case reduces exactly to `cfcIntegritySatisfiesFloor`; an empty leaf set is
 * vacuously satisfied (nothing was consumed — the caller's quantification
 * decides whether the gate even runs).
 */
export const cfcIntegritySatisfiesFloorCoherently = (
  consumedIntegrity: readonly (readonly unknown[])[],
  requiredIntegrity: readonly unknown[],
): boolean =>
  requiredIntegrity.every((required) => {
    let common: Set<string> | undefined;
    for (const integrity of consumedIntegrity) {
      const keys = new Set<string>();
      for (const actual of integrity) {
        const key = cfcIntegrityWitnessKey(required, actual);
        if (key !== null) keys.add(key);
      }
      if (keys.size === 0) return false;
      common = common === undefined
        ? keys
        : new Set([...common].filter((key) => keys.has(key)));
      if (common.size === 0) return false;
    }
    return true;
  });

/**
 * The confidentiality CLAUSES in `confidentiality` that fall OUTSIDE `ceiling`
 * (the complement that makes `cfcObservationFitsCeiling` false). Fit is CNF
 * clause subsumption (spec §8.10.3, Epic A2): a label clause `l` is admitted
 * iff SOME ceiling clause `c` subsumes it — `alts(c) ⊆ alts(l)` — so a reader
 * the ceiling admits (satisfying `c`) is entitled to data guarded by `l`.
 *
 * On flat labels (every clause a singleton) this is byte-for-byte the previous
 * membership check: `clauseSubsumes(a, l)` reduces to `deepEqual(a, l)`, so
 * `∃ c ∈ ceiling: deepEqual(c, l)` ≡ "the atom is in the allowlist". The
 * clause form additionally makes a **reader-enumeration** ceiling clause
 * `{anyOf:[r₁,…,rₖ]}` require EVERY listed reader to satisfy each label clause
 * (`∀reader ∀clause`) — closing the quantifier hole where a multi-party label
 * `[User(A),User(B)]` (nobody alone may read) wrongly fit a flat `[A,B]`
 * ceiling and was then shown to A alone.
 *
 * `CFC_LABEL_READ_FAILED_ATOM` is UNGRANTABLE (audit item 22): it is always
 * outside a DECLARED ceiling, even one that explicitly lists it, so a config
 * naming the exported marker string cannot allow-list a swallowed label-read
 * error. An `undefined` ceiling still admits it — no bound declared means no
 * check at all, matching `cfcObservationFitsCeiling`'s early return (the
 * sink-request gate never consults this helper for an undeclared ceiling).
 *
 * Shared by the prepare-time sink-request ceiling check so the gate and the
 * fits-test agree on membership semantics — including the ungrantable marker —
 * by construction.
 */
export const atomsOutsideCeiling = (
  confidentiality: readonly unknown[],
  ceiling: CfcObservationMaxConfidentiality,
): ImmutableJSONValue[] => {
  if (ceiling === undefined) {
    return [];
  }
  return confidentiality.filter((clause) =>
    clauseBearsReadFailedMarker(clause) ||
    !ceiling.some((allowed) => clauseSubsumes(allowed, clause))
  ) as ImmutableJSONValue[];
};

/**
 * Meet two confidentiality ceilings (allowlists) into the effective bound that
 * satisfies BOTH: a label fits the result iff it fits each input — the
 * both-direction property `fits(L, meet(C1,C2)) ⟺ fits(L,C1) ∧ fits(L,C2)`,
 * tested exhaustively in `cfc-clause-meet.test.ts`.
 *
 * The clause meet is the pairwise alternative-set UNION (plan decision 6,
 * corrected 2026-07-02): for every pair `(c₁ ∈ a, c₂ ∈ b)` emit the clause
 * with alternatives `alts(c₁) ∪ alts(c₂)`. Ceiling clauses sit on the
 * demanding side of subsumption (`alts(c) ⊆ alts(l)`, see
 * `atomsOutsideCeiling`), so the union demands what both parents demand:
 * `alts(c₁) ∪ alts(c₂) ⊆ alts(l)` holds iff both `c₁` and `c₂` subsume `l`
 * (soundness), and any label clause fitting both ceilings has witnesses
 * `c₁, c₂` whose union subsumes it (completeness). Do NOT intersect
 * alternative sets — fewer alternatives is a WEAKER demand, so intersection
 * loosens: `meet([{anyOf:[A,B]}], [{anyOf:[B,C]}])` as intersection gives
 * `[B]`, admitting label `[B]` that ceiling `[{anyOf:[A,B]}]` alone rejects.
 *
 * Flat/flat behavior: an equal-atom pair unions to a singleton that
 * `normalizeClause` unwraps back to the bare atom, so shared atoms survive
 * exactly as under the previous atom intersection; a cross pair of distinct
 * atoms becomes `{anyOf:[a,b]}` — decision-equivalent for flat labels (a bare
 * label atom is never subsumed by a two-alternative clause) but strictly more
 * precise for OR-labels, which the plain intersection wrongly rejected. The
 * result is O(|a|·|b|) clauses; fine for the sole production consumer
 * (`effectiveObservationCeiling` in builtins/llm-dialog.ts: pattern bound ∧
 * per-sink deployment ceiling, both tiny). Should a large-ceiling consumer
 * appear, dropping cross pairs is a sound over-restriction (it only
 * tightens); intersecting alternative sets never is.
 *
 * Each union clause is normalized (`normalizeClause`: dedup + canonical
 * order + singleton unwrap) and result clauses dedup via `clausesEqual`, so
 * order-differing spellings of the same clause coalesce. No absorption pass:
 * a redundant wider clause may sit beside a narrower one that subsumes
 * strictly more — harmless, it admits only a subset of what the narrower
 * clause admits (decision 4: measure before optimizing).
 *
 * Edge cases (each preserves `cfcObservationFitsCeiling` semantics):
 * - `undefined` ceiling = "no ceiling" = allow everything, so it is the
 *   identity: `meet(undefined, x) === x` and `meet(x, undefined) === x`.
 * - A declared empty ceiling is "public only"; it forms no pairs, so
 *   `meet([], x)` is `[]` — the strict bound wins.
 * - A malformed empty-alternative clause `{anyOf:[]}` never subsumes
 *   (`clauseSubsumes` fails closed), so it contributes nothing to its own
 *   ceiling and must form no pairs either — pairing it would emit its
 *   partner clause verbatim and loosen the meet past the empty-clause
 *   parent.
 *
 * Used to fold a deployment per-sink ceiling into a pattern-supplied observation
 * bound so post-commit LLM tool-loop reads cannot exceed the deployment ceiling
 * (review follow-up to #3993).
 */
export const meetCfcObservationCeilings = (
  a: CfcObservationMaxConfidentiality,
  b: CfcObservationMaxConfidentiality,
): CfcObservationMaxConfidentiality => {
  if (a === undefined) return b;
  if (b === undefined) return a;
  const met: unknown[] = [];
  for (const clauseA of a) {
    const alternativesA = clauseAlternatives(clauseA);
    if (alternativesA.length === 0) continue;
    for (const clauseB of b) {
      const alternativesB = clauseAlternatives(clauseB);
      if (alternativesB.length === 0) continue;
      const union = normalizeClause({
        anyOf: [...alternativesA, ...alternativesB],
      });
      if (!met.some((existing) => clausesEqual(existing, union))) {
        met.push(union);
      }
    }
  }
  return met;
};

export const cfcJsonPointerForPath = (
  path: readonly (string | number)[],
): string =>
  path.length === 0
    ? ""
    : `/${
      path.map((segment) =>
        String(segment).replaceAll("~", "~0").replaceAll("/", "~1")
      ).join("/")
    }`;

export const cfcOpaqueLinkForPath = (
  opaqueHandleId: string,
  path: readonly (string | number)[],
): CfcOpaqueLink => ({
  "@link": `opaque:${encodeURIComponent(opaqueHandleId)}${
    path.length === 0 ? "" : `#${cfcJsonPointerForPath(path)}`
  }`,
});
