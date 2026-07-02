import type { ImmutableJSONValue, JSONSchema } from "@commonfabric/api";
import { deepEqual } from "@commonfabric/utils/deep-equal";
import { isRecord } from "@commonfabric/utils/types";
import {
  cfcLabelPathPrefixMatches,
  type CfcLabelView,
} from "./label-view-core.ts";
import { clauseSubsumes } from "./clause.ts";

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

export const cfcConfidentialityForObservationNode = (
  options: {
    schema?: JSONSchema;
    labelView?: CfcLabelView;
    logicalPath?: readonly string[];
  },
): CfcObservedConfidentiality => {
  const joined: unknown[] = [];
  const logicalPath = options.logicalPath ?? [];

  if (isRecord(options.schema) && isRecord(options.schema.ifc)) {
    joined.push(...(options.schema.ifc.confidentiality ?? []));
  }

  if (options.labelView !== undefined) {
    for (const entry of options.labelView.entries) {
      if (cfcLabelPathPrefixMatches(entry.path, logicalPath)) {
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
  // rejection too as defense in depth for the redaction path.
  if (
    confidentiality.some((value) =>
      deepEqual(value, CFC_LABEL_READ_FAILED_ATOM)
    )
  ) {
    return false;
  }

  return atomsOutsideCeiling(confidentiality, observationMaxConfidentiality)
    .length === 0;
};

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
    deepEqual(clause, CFC_LABEL_READ_FAILED_ATOM) ||
    !ceiling.some((allowed) => clauseSubsumes(allowed, clause))
  ) as ImmutableJSONValue[];
};

/**
 * Meet two confidentiality ceilings (allowlists) into the effective bound that
 * satisfies BOTH: a value fits the result iff it fits each input. Since fitting
 * means "every atom is a ceiling member" (`cfcObservationFitsCeiling`), fitting
 * both means the atom set sits within the set INTERSECTION of the two
 * allowlists.
 *
 * Edge cases (each preserves `cfcObservationFitsCeiling` semantics):
 * - `undefined` ceiling = "no ceiling" = allow everything, so it is the
 *   identity: `meet(undefined, x) === x` and `meet(x, undefined) === x`.
 * - A declared empty ceiling is "public only", and intersection with anything
 *   stays empty, so `meet([], x)` is public-only — the strict bound wins.
 *
 * Used to fold a deployment per-sink ceiling into a pattern-supplied observation
 * bound so post-commit LLM tool-loop reads cannot exceed the deployment ceiling
 * (review follow-up to #3993).
 *
 * Clause note (Epic A2): both operands are deployment/pattern-supplied ceilings,
 * which are flat atom lists today. An OR-clause is compared by structural
 * equality here — kept only when BOTH inputs list the identical clause — which
 * is the conservative (more-restrictive) direction and composes safely with the
 * clause-aware fit above (a dropped clause only removes a subsumer, tightening
 * the effective bound). A general clause-meet (pairwise alternative
 * intersection) is deferred until authored `anyOf` ceilings actually reach this
 * seam (Epic A4+); it needs a soundness proof first — naive pairwise
 * intersection is NOT sound (it can admit a label neither parent admits), so it
 * is intentionally not implemented here.
 */
export const meetCfcObservationCeilings = (
  a: CfcObservationMaxConfidentiality,
  b: CfcObservationMaxConfidentiality,
): CfcObservationMaxConfidentiality => {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return a.filter((value) => b.some((other) => deepEqual(other, value)));
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
