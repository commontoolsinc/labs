import { CFC_ATOM_TYPE } from "@commonfabric/api/cfc";
import { deepEqual } from "@commonfabric/utils/deep-equal";
import { isRecord } from "@commonfabric/utils/types";
import { hashStringOf } from "@commonfabric/data-model/value-hash";
import { atomEntails } from "./atom-pattern.ts";
import { uniqueCfcAtoms } from "./observation.ts";

/**
 * CNF confidentiality clauses (spec §3.1.8 / §4.2.1; Epic A of
 * docs/plans/cfc-future-work-implementation.md).
 *
 * A confidentiality label is a conjunction of clauses. Each clause is either
 * a bare atom (a singleton clause — every entry in today's flat labels) or an
 * authored/exchange-produced disjunction written as `{ anyOf: [atom, …] }`.
 * The `anyOf` wrapper is the wire discriminator, chosen so a clause-unaware
 * reader deep-equals the whole object against ceiling atoms, finds no match,
 * and treats the data as MORE restricted — never less (mixed-version
 * fail-closed by construction).
 *
 * The `anyOf` key is therefore reserved: an atom must never use it. To keep
 * accidental collisions fail-closed, only a record whose SOLE own key is
 * `anyOf` (with an array value) is recognized as a clause; any other shape
 * stays an opaque atom (unsatisfiable against ceilings — restrictive).
 */
export type CfcOrClause = { readonly anyOf: readonly unknown[] };

/** A confidentiality clause: a bare atom, or an OR of atoms. */
export type CfcConfClause = unknown;

export const isOrClause = (value: unknown): value is CfcOrClause =>
  isRecord(value) &&
  Array.isArray((value as { anyOf?: unknown }).anyOf) &&
  Object.keys(value).length === 1;

/** The alternatives of a clause; a bare atom is its own single alternative. */
export const clauseAlternatives = (
  clause: CfcConfClause,
): readonly unknown[] => isOrClause(clause) ? clause.anyOf : [clause];

const compareByCanonicalHash = (left: unknown, right: unknown): number => {
  const leftHash = hashStringOf(left);
  const rightHash = hashStringOf(right);
  return leftHash < rightHash ? -1 : leftHash > rightHash ? 1 : 0;
};

/**
 * Canonical form of a clause:
 * - a non-clause value (bare atom) is returned unchanged (identity — flat
 *   labels are byte-identical through canonicalization);
 * - an OR-clause gets its alternatives structurally deduped and sorted by
 *   canonical value hash, so two clauses that differ only in alternative
 *   insertion order canonicalize (and hash) identically;
 * - a singleton `{anyOf: [a]}` unwraps to the bare atom `a` (semantically
 *   identical, so the two spellings must not hash differently) — UNLESS `a`
 *   is itself clause-shaped: `{anyOf: [{anyOf: […]}]}` is malformed (the
 *   reserved key must not appear in atom position), and its sole alternative
 *   is an opaque, unsatisfiable atom. Unwrapping would PROMOTE that inner
 *   value into an active OR-clause, loosening what the raw label admits —
 *   the wrong direction. Malformed nesting stays wrapped and opaque;
 * - an empty `{anyOf: []}` is kept as-is: it is an unsatisfiable clause
 *   (see `clauseSubsumes` for how both positions treat it fail-closed).
 *
 * Canonicalization never merges clauses, never unions alternative sets
 * across clauses, and never dedups an atom across a singleton clause and an
 * OR-clause containing it — `[A]` and `[A ∨ B]` are different constraints
 * (spec §3.1.8 normalization prohibitions).
 */
export const normalizeClause = (clause: CfcConfClause): CfcConfClause => {
  if (!isOrClause(clause)) return clause;
  const unique = uniqueCfcAtoms(clause.anyOf);
  if (unique.length === 1 && !isOrClause(unique[0])) return unique[0];
  return { anyOf: unique.sort(compareByCanonicalHash) };
};

/** Structural clause equality, insensitive to alternative order. */
export const clausesEqual = (
  left: CfcConfClause,
  right: CfcConfClause,
): boolean => deepEqual(normalizeClause(left), normalizeClause(right));

/**
 * Clause subsumption — the ceiling-fit kernel (spec §8.10.3):
 * a ceiling clause `c` subsumes a label clause `l` when every alternative of
 * `c` appears among `l`'s alternatives (`alts(c) ⊆ alts(l)`) — then any
 * principal satisfying `c` satisfies `l`, so an observer admitted by the
 * ceiling clause is entitled to data guarded by the label clause.
 *
 * Deliberate fail-closed divergence from the pure set algebra: an EMPTY
 * ceiling clause never subsumes. Mathematically `∅ ⊆ alts(l)` holds and an
 * unsatisfiable destination-audience clause would admit any flow, but an
 * empty `anyOf` in an authored ceiling is far more likely malformed input
 * than a deliberate "nobody observes this" claim — so it contributes
 * nothing. (On the label side the algebra already fails closed: no
 * non-empty ceiling clause is a subset of an empty alternative set, so a
 * label containing `{anyOf: []}` never fits any ceiling.)
 *
 * Atom comparison is per-family entailment (`atomEntails`, Epic B1):
 * structural equality everywhere, plus the `Expires` timestamp order —
 * ceiling alternative `Expires(t_c)` entails label alternative `Expires(t_l)`
 * iff `t_c <= t_l` (every context the ceiling admits, `now <= t_c`, is one
 * the label allows). The clause generalization is per-alternative: `c ⟹ l`
 * for disjunctions iff EVERY alternative of `c` entails SOME alternative of
 * `l` — so the subset check becomes an entailment-witness check, reducing to
 * the previous deepEqual membership on order-free families.
 */
export const clauseSubsumes = (
  ceilingClause: CfcConfClause,
  labelClause: CfcConfClause,
): boolean => {
  const ceilingAlternatives = clauseAlternatives(ceilingClause);
  if (ceilingAlternatives.length === 0) return false;
  const labelAlternatives = clauseAlternatives(labelClause);
  return ceilingAlternatives.every((ceilingAtom) =>
    labelAlternatives.some((labelAtom) => atomEntails(ceilingAtom, labelAtom))
  );
};

// Atom types forbidden as alternatives of an AUTHORED OR-clause (spec §3.1.8):
// alternatives must be principal-like. `Caveat` as an alternative would make a
// risk obligation dischargeable by identity ("readable by Bob OR if screened"),
// collapsing the caveat discipline; `Expires` semantics is most-restrictive-
// wins, which inverts to least-restrictive-wins as an alternative
// (`[[User(A) ∨ Expires(t)]]` world-readable until t). Both are conservative
// fail-closed rejections, relaxable later by a profile that defines the wanted
// semantics. Shared by the authored-clause gate in prepare.ts and the grant
// audience validation in grants.ts (a grant audience entry IS a future clause
// alternative — §8.12.7 route 2a) so the two cannot drift.
export const FORBIDDEN_OR_CLAUSE_ALTERNATIVE_TYPES: ReadonlySet<string> =
  new Set([
    CFC_ATOM_TYPE.Caveat,
    CFC_ATOM_TYPE.Expires,
  ]);
