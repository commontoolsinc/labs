/**
 * Integrity labels for information flow control.
 *
 * An integrity label is a conjunction (set) of atoms representing endorsements:
 * "this data was endorsed by X AND produced by code Y". More atoms means
 * higher integrity (more endorsements).
 *
 * Lattice structure:
 * - Top (weakest): empty set — no endorsements claimed
 * - Join (⊔): intersection — combining sources keeps only shared endorsements
 * - Meet (⊓): union — adding endorsements strengthens integrity
 * - Order: a ≤ b iff a.atoms ⊆ b.atoms (fewer endorsements = lower integrity)
 */

import { type Atom, canonicalizeAtom } from "./atoms.ts";

// ---------------------------------------------------------------------------
// Type
// ---------------------------------------------------------------------------

export type IntegrityLabel = { readonly atoms: readonly Atom[] };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalize(atoms: Atom[]): Atom[] {
  const seen = new Map<string, Atom>();
  for (const atom of atoms) {
    const key = canonicalizeAtom(atom);
    if (!seen.has(key)) {
      seen.set(key, atom);
    }
  }
  const entries = [...seen.entries()];
  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return entries.map(([, v]) => v);
}

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

/** Empty integrity label — no endorsements (top/weakest element). */
export function emptyIntegrity(): IntegrityLabel {
  return { atoms: [] };
}

/** Create an integrity label from a list of atoms, deduplicating and sorting. */
export function integrityFromAtoms(atoms: Atom[]): IntegrityLabel {
  return { atoms: normalize(atoms) };
}

// ---------------------------------------------------------------------------
// Lattice operations
// ---------------------------------------------------------------------------

/**
 * Join (⊔): intersection of atoms.
 *
 * Combining data from two sources means you can only claim endorsements that
 * BOTH sources have.
 */
export function joinIntegrity(
  a: IntegrityLabel,
  b: IntegrityLabel,
): IntegrityLabel {
  const bKeys = new Set(b.atoms.map(canonicalizeAtom));
  const result: Atom[] = [];
  for (const atom of a.atoms) {
    if (bKeys.has(canonicalizeAtom(atom))) {
      result.push(atom);
    }
  }
  return { atoms: normalize(result) };
}

/**
 * Meet (⊓): union of atoms.
 *
 * Adding an endorsement makes integrity stronger.
 */
export function meetIntegrity(
  a: IntegrityLabel,
  b: IntegrityLabel,
): IntegrityLabel {
  return { atoms: normalize([...a.atoms, ...b.atoms]) };
}

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

/**
 * `integrityLeq(a, b)` returns true iff a ≤ b in the integrity lattice,
 * meaning a is at most as trustworthy as b: a.atoms ⊆ b.atoms.
 */
export function integrityLeq(
  a: IntegrityLabel,
  b: IntegrityLabel,
): boolean {
  const bKeys = new Set(b.atoms.map(canonicalizeAtom));
  return a.atoms.every((atom) => bKeys.has(canonicalizeAtom(atom)));
}

// ---------------------------------------------------------------------------
// Membership
// ---------------------------------------------------------------------------

/** Check whether a specific atom is present in the label. */
export function integrityContains(
  label: IntegrityLabel,
  atom: Atom,
): boolean {
  const key = canonicalizeAtom(atom);
  return label.atoms.some((a) => canonicalizeAtom(a) === key);
}
