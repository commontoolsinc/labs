/**
 * CNF (Conjunctive Normal Form) confidentiality labels for information flow
 * control.
 *
 * A confidentiality label is a conjunction (AND) of disjunctive clauses (OR).
 * More clauses = more restrictive. The empty label [] means "no restrictions"
 * (the bottom element of the lattice).
 */

import { type Atom, canonicalizeAtom } from "./atoms.ts";

// ---------------------------------------------------------------------------
// Type
// ---------------------------------------------------------------------------

/** CNF: conjunction of disjunctive clauses. */
export type ConfidentialityLabel = Atom[][];

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

/** Bottom element — no restrictions. */
export function emptyConfidentiality(): ConfidentialityLabel {
  return [];
}

// ---------------------------------------------------------------------------
// Normalization helpers
// ---------------------------------------------------------------------------

function canonicalizeClause(clause: Atom[]): string {
  return clause.map(canonicalizeAtom).join("|");
}

/** Deduplicate atoms within a clause by canonical form. */
function deduplicateClause(clause: Atom[]): Atom[] {
  const seen = new Set<string>();
  const result: Atom[] = [];
  for (const atom of clause) {
    const key = canonicalizeAtom(atom);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(atom);
    }
  }
  return result;
}

/** Sort atoms within a clause by canonical form. */
function sortClause(clause: Atom[]): Atom[] {
  return [...clause].sort((a, b) =>
    canonicalizeAtom(a).localeCompare(canonicalizeAtom(b))
  );
}

/** Check if clause `a` is a subset of clause `b` (every atom in a exists in b). */
function clauseIsSubset(a: Atom[], b: Atom[]): boolean {
  const bSet = new Set(b.map(canonicalizeAtom));
  return a.every((atom) => bSet.has(canonicalizeAtom(atom)));
}

/**
 * Normalize a confidentiality label:
 * 1. Deduplicate atoms within each clause
 * 2. Sort atoms within each clause
 * 3. Sort clauses by stringified form
 * 4. Remove duplicate clauses
 * 5. Remove subsumed clauses (if A ⊆ B, remove B — A is stricter)
 */
export function normalizeConfidentiality(
  label: ConfidentialityLabel,
): ConfidentialityLabel {
  // Steps 1–2: clean each clause
  let clauses = label.map((clause) => sortClause(deduplicateClause(clause)));

  // Step 3–4: sort and deduplicate clauses
  const seen = new Set<string>();
  const unique: Atom[][] = [];
  clauses.sort((a, b) =>
    canonicalizeClause(a).localeCompare(canonicalizeClause(b))
  );
  for (const clause of clauses) {
    const key = canonicalizeClause(clause);
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(clause);
    }
  }
  clauses = unique;

  // Step 5: remove subsumed clauses.
  // If clause A ⊆ clause B (and A ≠ B), then B is weaker — remove B.
  const result: Atom[][] = [];
  for (let i = 0; i < clauses.length; i++) {
    let subsumed = false;
    for (let j = 0; j < clauses.length; j++) {
      if (i === j) continue;
      if (
        clauseIsSubset(clauses[j], clauses[i]) &&
        !clauseIsSubset(clauses[i], clauses[j])
      ) {
        // clauses[j] is a strict subset of clauses[i], so clauses[i] is subsumed
        subsumed = true;
        break;
      }
    }
    if (!subsumed) {
      result.push(clauses[i]);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Lattice operations
// ---------------------------------------------------------------------------

/**
 * Join (least upper bound): union of constraints — more restrictive.
 * Concatenate clauses from both labels, then normalize.
 */
export function joinConfidentiality(
  a: ConfidentialityLabel,
  b: ConfidentialityLabel,
): ConfidentialityLabel {
  return normalizeConfidentiality([...a, ...b]);
}

/**
 * Meet (greatest lower bound): for each pair of clauses (one from a, one from
 * b), produce a clause that is their union (disjunction). Then normalize.
 *
 * This is the distributive law applied to CNF:
 *   (A₁ ∧ A₂) ∧̣ (B₁ ∧ B₂) = (A₁∨B₁) ∧ (A₁∨B₂) ∧ (A₂∨B₁) ∧ (A₂∨B₂)
 */
export function meetConfidentiality(
  a: ConfidentialityLabel,
  b: ConfidentialityLabel,
): ConfidentialityLabel {
  // Meet with bottom (empty = no restrictions) returns empty.
  if (a.length === 0 || b.length === 0) {
    return emptyConfidentiality();
  }

  const clauses: Atom[][] = [];
  for (const clauseA of a) {
    for (const clauseB of b) {
      clauses.push([...clauseA, ...clauseB]);
    }
  }
  return normalizeConfidentiality(clauses);
}

/**
 * Partial order: a ≤ b iff b is at least as restrictive as a.
 *
 * For every clause in a, there must exist a clause in b that is a subset of
 * (or equal to) that clause — meaning b has a constraint at least as tight.
 */
export function confidentialityLeq(
  a: ConfidentialityLabel,
  b: ConfidentialityLabel,
): boolean {
  const na = normalizeConfidentiality(a);
  const nb = normalizeConfidentiality(b);

  return na.every((clauseA) =>
    nb.some((clauseB) => clauseIsSubset(clauseB, clauseA))
  );
}
