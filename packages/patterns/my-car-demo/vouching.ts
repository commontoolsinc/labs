// Pure logic for delegated, time-boxed vouching (DESIGN §13). An employee can
// vouch for a PERSON (one hop — a vouchee cannot re-vouch) who then self-claims
// "any of their cars", or for a specific guest CAR; both are time-boxed. The
// org's allowed set generalizes from "employees" to "employees ∪ currently-valid
// vouched principals". Composes with the provenance gate in provenance.ts.
//
// Deferred (CFC/runtime): `voucheeName` is voucher-controlled and Confidential
// (§7/§13) — here it's a plain optional field; the Confidential brand + reveal
// handshake are the gated substrate concern.

import { Vehicle } from "../vehicles.ts";
import { AuthoredClaim, trustedAffiliatedVehicles } from "./provenance.ts";
import { plateKey } from "./classification.ts";
import { VehicleClaim } from "../my-car/claims.ts";

// Bridge a VehicleClaim (carrying an optional `claimant` DID) to an AuthoredClaim
// for the provenance/vouching gate. NOTE: production resolves the author from the
// claim's CFC `represents-principal` atom via `getCfcLabel` (deferred — CT-1660 /
// the cf-cfc-authorship helper lift). Until then, `claimant` is the author key.
export const toAuthoredClaims = (
  claims: readonly VehicleClaim[],
): AuthoredClaim[] =>
  claims.map((claim) => ({
    vehicle: claim.vehicle,
    authorAtoms: claim.claimant
      ? [{ kind: "represents-principal", subject: claim.claimant }]
      : [],
  }));

export interface Window {
  validFrom: number; // safeDateNow() epoch ms
  validUntil: number;
}

export const isWithin = (now: number, w: Window): boolean =>
  now >= w.validFrom && now <= w.validUntil;

// (a) car-vouch — the friend has no profile; the employee enters/photographs the car.
export interface CarVouch extends Window {
  kind: "car";
  voucher: string; // employee DID (authored-by)
  vehicle: Vehicle;
  voucheeName?: string; // optional, voucher-controlled (Confidential in the real model)
}

// (b) person-vouch — the friend self-claims their own car(s) on their profile.
export interface PersonVouch extends Window {
  kind: "person";
  voucher: string; // employee DID (authored-by)
  vouchee: string; // friend's DID / profile-ref (NOT their name)
  voucheeName?: string; // optional, voucher-controlled
}

// The trusted-principal set at `now`: employees PLUS the vouchees of in-window
// person-vouches AUTHORED BY AN EMPLOYEE. The employee-author check is what
// enforces one hop — a vouchee's own person-vouch (voucher ∉ employees) grants
// nothing, so trust never chains past one delegation.
export const activeTrustedPrincipals = (
  employees: ReadonlySet<string>,
  personVouches: readonly PersonVouch[],
  now: number,
): Set<string> => {
  const trusted = new Set<string>(employees);
  for (const vouch of personVouches) {
    if (employees.has(vouch.voucher) && isWithin(now, vouch)) {
      trusted.add(vouch.vouchee);
    }
  }
  return trusted;
};

// Vehicles allowed via an in-window car-vouch authored by an employee.
export const activeCarVouchVehicles = (
  carVouches: readonly CarVouch[],
  employees: ReadonlySet<string>,
  now: number,
): Vehicle[] =>
  carVouches
    .filter((vouch) => employees.has(vouch.voucher) && isWithin(now, vouch))
    .map((vouch) => vouch.vehicle);

// The full allowed-vehicle set at `now`: self-claims whose author is a currently
// trusted principal (employee or in-window vouchee), plus in-window employee
// car-vouches. Reuses the provenance gate (trustedAffiliatedVehicles).
export const allowedVehicles = (
  claims: readonly AuthoredClaim[],
  employees: ReadonlySet<string>,
  personVouches: readonly PersonVouch[],
  carVouches: readonly CarVouch[],
  now: number,
): Vehicle[] => {
  const trusted = activeTrustedPrincipals(employees, personVouches, now);
  return [
    ...trustedAffiliatedVehicles(claims, trusted),
    ...activeCarVouchVehicles(carVouches, employees, now),
  ];
};

// Is a seen plate currently allowed (normalized match against the allowed set)?
export const isPlateAllowed = (
  plateId: string,
  plateState: string,
  allowed: readonly Vehicle[],
): boolean => {
  const key = plateKey(plateId, plateState);
  if (key === "|") return false;
  return allowed.some((v) => plateKey(v.plateId, v.plateState) === key);
};
