/**
 * Parameterized atoms for the CFC information flow control system.
 *
 * Atoms are the primitive labels used to construct confidentiality and
 * integrity lattices.  Each variant carries the parameters that distinguish
 * one atom from another (e.g. a DID, a space identifier, a hash, …).
 */

// ---------------------------------------------------------------------------
// Confidentiality atoms
// ---------------------------------------------------------------------------

export interface UserAtom {
  kind: "User";
  did: string;
}

export interface SpaceAtom {
  kind: "Space";
  space: string;
}

export interface ResourceAtom {
  kind: "Resource";
  class: string;
  subject: string;
}

export interface ServiceAtom {
  kind: "Service";
  id: string;
}

export interface ClassificationAtom {
  kind: "Classification";
  level: string;
}

export interface ExpiresAtom {
  kind: "Expires";
  timestamp: number;
}

export interface PolicyPrincipalAtom {
  kind: "PolicyPrincipal";
  hash: string;
}

export type ConfidentialityAtom =
  | UserAtom
  | SpaceAtom
  | ResourceAtom
  | ServiceAtom
  | ClassificationAtom
  | ExpiresAtom
  | PolicyPrincipalAtom;

// ---------------------------------------------------------------------------
// Integrity atoms
// ---------------------------------------------------------------------------

export interface CodeHashAtom {
  kind: "CodeHash";
  hash: string;
}

export interface AuthoredByAtom {
  kind: "AuthoredBy";
  did: string;
}

export interface EndorsedByAtom {
  kind: "EndorsedBy";
  did: string;
}

export interface HasRoleAtom {
  kind: "HasRole";
  principal: string;
  space: string;
  role: string;
}

export interface AuthorizedRequestAtom {
  kind: "AuthorizedRequest";
  sink: string;
}

export type IntegrityAtom =
  | CodeHashAtom
  | AuthoredByAtom
  | EndorsedByAtom
  | HasRoleAtom
  | AuthorizedRequestAtom;

// ---------------------------------------------------------------------------
// Discriminated union of all atoms
// ---------------------------------------------------------------------------

export type Atom = ConfidentialityAtom | IntegrityAtom;

// ---------------------------------------------------------------------------
// Canonical serialization & equality
// ---------------------------------------------------------------------------

/** Deterministic JSON serialization with sorted keys. */
export function canonicalizeAtom(atom: Atom): string {
  const keys = Object.keys(atom).sort();
  const entries: string[] = [];
  for (const key of keys) {
    entries.push(
      JSON.stringify(key) +
        ":" +
        JSON.stringify((atom as unknown as Record<string, unknown>)[key]),
    );
  }
  return "{" + entries.join(",") + "}";
}

/** Structural equality via canonical form. */
export function atomEquals(a: Atom, b: Atom): boolean {
  return canonicalizeAtom(a) === canonicalizeAtom(b);
}

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

const CONFIDENTIALITY_KINDS: ReadonlySet<string> = new Set([
  "User",
  "Space",
  "Resource",
  "Service",
  "Classification",
  "Expires",
  "PolicyPrincipal",
]);

const INTEGRITY_KINDS: ReadonlySet<string> = new Set([
  "CodeHash",
  "AuthoredBy",
  "EndorsedBy",
  "HasRole",
  "AuthorizedRequest",
]);

export function isConfidentialityAtom(atom: Atom): atom is ConfidentialityAtom {
  return CONFIDENTIALITY_KINDS.has(atom.kind);
}

export function isIntegrityAtom(atom: Atom): atom is IntegrityAtom {
  return INTEGRITY_KINDS.has(atom.kind);
}

// ---------------------------------------------------------------------------
// Convenience constructors
// ---------------------------------------------------------------------------

export function userAtom(did: string): UserAtom {
  return { kind: "User", did };
}

export function spaceAtom(space: string): SpaceAtom {
  return { kind: "Space", space };
}

export function resourceAtom(cls: string, subject: string): ResourceAtom {
  return { kind: "Resource", class: cls, subject };
}

export function serviceAtom(id: string): ServiceAtom {
  return { kind: "Service", id };
}

export function classificationAtom(level: string): ClassificationAtom {
  return { kind: "Classification", level };
}

export function expiresAtom(timestamp: number): ExpiresAtom {
  return { kind: "Expires", timestamp };
}

export function policyPrincipalAtom(hash: string): PolicyPrincipalAtom {
  return { kind: "PolicyPrincipal", hash };
}

export function codeHashAtom(hash: string): CodeHashAtom {
  return { kind: "CodeHash", hash };
}

export function authoredByAtom(did: string): AuthoredByAtom {
  return { kind: "AuthoredBy", did };
}

export function endorsedByAtom(did: string): EndorsedByAtom {
  return { kind: "EndorsedBy", did };
}

export function hasRoleAtom(
  principal: string,
  space: string,
  role: string,
): HasRoleAtom {
  return { kind: "HasRole", principal, space, role };
}

export function authorizedRequestAtom(sink: string): AuthorizedRequestAtom {
  return { kind: "AuthorizedRequest", sink };
}
