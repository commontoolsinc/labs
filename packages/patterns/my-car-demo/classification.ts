// Pure, runtime-import-free org-side classification logic (Phase 5). Kept out of
// the pattern entrypoint so it unit-tests with plain `deno test`.
//
// The org classifies a seen plate as:
//   - "ours"    — matches a current-employee SELF claim (the affiliated set)
//   - "guest"   — matches an employee's GuestVouch (a vouched visitor)
//   - "unknown" — no claim/vouch (the admin's long-tail curation queue)
// Priority: ours > guest > unknown (mirrors lot-watch's classifyPlate).
//
// Provenance gating (only count claims/vouches authored by a current employee /
// voucher) is the Phase-4 SameAuthorAs concern; here the affiliated set and the
// vouches are taken as already-trusted inputs.

import { normalizePlateId, Vehicle } from "../vehicles.ts";
import { VehicleClaim } from "../my-car/claims.ts";

export type Classification = "ours" | "guest" | "unknown";

// An employee's vouch for a legitimate guest's car, authored INTO the org space
// (authored-by the voucher — a same-space write, mirroring lot-watch's
// assignToPerson). The `voucher` DID is the new value over lot-watch's
// KnownVehicle: it makes the vouch attributable.
export interface GuestVouch {
  voucher: string; // DID of the vouching employee (the authored-by subject)
  vehicle: Vehicle;
  vouchedAt: number;
  guestName?: string;
  note?: string;
}

// Stable match key — normalized plate + uppercased state. Never match on plate
// alone when state is known (EF2: avoids cross-state collisions).
export const plateKey = (plateId: string, plateState: string): string =>
  `${normalizePlateId(plateId)}|${(plateState ?? "").toUpperCase().trim()}`;

// The "ours" set: vehicles from current-employee SELF claims.
export const affiliatedFromClaims = (
  claims: readonly VehicleClaim[],
): Vehicle[] =>
  claims.filter((claim) => claim.claimType === "self").map((claim) =>
    claim.vehicle
  );

export const classifyPlate = (
  plateId: string,
  plateState: string,
  affiliated: readonly Vehicle[],
  guestVouches: readonly GuestVouch[],
): Classification => {
  const key = plateKey(plateId, plateState);
  if (key === "|") return "unknown"; // empty plate never matches
  if (
    affiliated.some((vehicle) =>
      plateKey(vehicle.plateId, vehicle.plateState) === key
    )
  ) {
    return "ours";
  }
  if (
    guestVouches.some((vouch) =>
      plateKey(vouch.vehicle.plateId, vouch.vehicle.plateState) === key
    )
  ) {
    return "guest";
  }
  return "unknown";
};
