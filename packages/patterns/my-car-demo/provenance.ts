// Pure provenance / trust-derivation core (Phase 4 — the SameAuthorAs primitive's
// logic). The org's allow rule (DESIGN §2/§4, Berni's profile-reference steer):
//
//   a self-claim is "ours" iff its AUTHOR is the same principal as the OWNER of
//   some member profile the org trusts.
//
// Both "author" and "owner" are CFC integrity atoms (`represents-principal` /
// `authored-by`). This module is the pure, atom-level logic — decoupled from the
// runtime `CfcLabelView` so it unit-tests with plain `deno test`. At runtime the
// atoms are read off a cell via `getCfcLabel()` (the same operation
// packages/ui/.../cf-cfc-authorship.ts does today) and fed in here.
//
// Deferred (Berni-domain, see voucher-last-mile-investigation.md): promoting
// `SameAuthorAs` into api/cfc.ts's CFC_CANONICAL_ALIAS_NAMES + a runner write-gate
// in prepare.ts, and DRY-consolidating with cf-cfc-authorship's CfcLabelView
// helpers. v1 enforces the rule as THIS derivation, not a write gate.

import { Vehicle } from "../vehicles.ts";

export interface IntegrityAtom {
  kind: string;
  subject?: string;
}

// "this value's author must be the same principal as the owner of <Reference>".
// A phantom brand documenting the intended primitive; it does NOT yet lower to a
// CFC ifc claim (that's the deferred api/cfc.ts + transformer work).
export type SameAuthorAs<T, Reference> = T & {
  readonly __sameAuthorAs?: Reference;
};

const subjectOfKind = (
  atoms: readonly IntegrityAtom[] | undefined,
  kind: string,
): string | undefined => atoms?.find((atom) => atom.kind === kind)?.subject;

// The owner of a profile is its `represents-principal` subject.
export const representsPrincipalSubject = (
  atoms: readonly IntegrityAtom[] | undefined,
): string | undefined => subjectOfKind(atoms, "represents-principal");

// A guest-vouch's author is its `authored-by` subject.
export const authoredBySubject = (
  atoms: readonly IntegrityAtom[] | undefined,
): string | undefined => subjectOfKind(atoms, "authored-by");

// The author of a value: self-claims carry `represents-principal` (the owner);
// org-space vouches carry `authored-by` (the voucher).
export const authorSubject = (
  atoms: readonly IntegrityAtom[] | undefined,
): string | undefined =>
  representsPrincipalSubject(atoms) ?? authoredBySubject(atoms);

// The SameAuthorAs core: is `valueAtoms`' author the same principal as the owner
// of the reference (e.g. a member profile)?
export const sameAuthorAsOwner = (
  valueAtoms: readonly IntegrityAtom[] | undefined,
  referenceOwnerAtoms: readonly IntegrityAtom[] | undefined,
): boolean => {
  const author = authorSubject(valueAtoms);
  const owner = representsPrincipalSubject(referenceOwnerAtoms);
  return author !== undefined && owner !== undefined && author === owner;
};

// The set of DIDs that own a member profile — the trust anchor, derived from
// each member profile's owner atom (replaces a hand-maintained roster of raw
// DIDs; see DESIGN §4 "Closing the last mile").
export const memberOwnerSet = (
  memberProfileOwnerAtoms: readonly (readonly IntegrityAtom[] | undefined)[],
): Set<string> => {
  const owners = new Set<string>();
  for (const atoms of memberProfileOwnerAtoms) {
    const subject = representsPrincipalSubject(atoms);
    if (subject !== undefined) owners.add(subject);
  }
  return owners;
};

// A claim carrying its author atoms (as read off the cell at runtime).
export interface AuthoredClaim {
  vehicle: Vehicle;
  authorAtoms?: readonly IntegrityAtom[];
}

// The trust gate: keep only claims whose author is a current member-profile
// owner, and return their vehicles (the "affiliated" / "ours" set). This is the
// provenance-checked replacement for classification.affiliatedFromClaims (which
// takes all claims as already trusted).
export const trustedAffiliatedVehicles = (
  claims: readonly AuthoredClaim[],
  memberOwners: Set<string>,
): Vehicle[] =>
  claims
    .filter((claim) => {
      const author = authorSubject(claim.authorAtoms);
      return author !== undefined && memberOwners.has(author);
    })
    .map((claim) => claim.vehicle);
