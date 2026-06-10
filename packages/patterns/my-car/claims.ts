// Pure, runtime-import-free core for the MyCar pattern: the claim shape and the
// claim-building / removal logic. Kept out of main.tsx so it can be unit-tested
// with plain `deno test` (main.tsx imports `commonfabric`'s compile-only symbols
// like NAME/UI, which only resolve under the cf transformer).

import {
  modelsForMake,
  normalizeVehicle,
  Vehicle,
  VEHICLE_COLORS,
  VEHICLE_MAKES,
} from "../vehicles.ts";

// The single producer<->consumer contract token. Consumers discover a user's
// car via wish({ query: `#${CAR_TAG}`, scope: ["profile"] }); MyCar publishes it
// as the element's userTag. Defining it once makes a typo a compile error, not a
// silent wish mismatch (DESIGN §6).
export const CAR_TAG = "car";

// Deferred granularity ladder (DESIGN §8): the rung names are in scope, the
// policy engine is not. Field reserved; default behavior is full ("plate").
export type ShareLevel = "owner" | "description" | "plate";

// One primitive, two legs (DESIGN §2). MyCar only ever authors `claimType:
// "self"`; the guest leg is a separate org-space `GuestVouch` (Phase 5). The
// authoritative author is the `represents-principal` atom on the owner-protected
// `selfClaims` cell, not a data field — so `claimant` is an optional display hint.
export interface VehicleClaim {
  claimant?: string;
  vehicle: Vehicle;
  claimType: "self" | "guest";
  claimedAt: number;
  note?: string; // becomes Confidential<…> in Phase 6
  share?: ShareLevel; // deferred granularity (DESIGN §8)
}

// Pure, testable claim builder. Normalizes the vehicle to the catalog and
// requires a plate (the cross-space match key); returns null when there is no
// plate. `now` is injected so this stays free of `safeDateNow()` (SES: keep time
// out of re-running computations) and unit-testable.
export const buildSelfClaim = (
  input: Vehicle,
  now: number,
): VehicleClaim | null => {
  const vehicle = normalizeVehicle(input);
  if (!vehicle.plateId) return null;
  return { vehicle, claimType: "self", claimedAt: now, share: "plate" };
};

export const filterOutPlate = (
  claims: readonly VehicleClaim[],
  plateId: string,
  plateState: string,
): VehicleClaim[] =>
  claims.filter((claim) =>
    !(claim.vehicle.plateId === plateId &&
      claim.vehicle.plateState === plateState)
  );

// Structured result of LLM plate/vehicle extraction from a photo (same shape as
// lot-watch's PlateExtraction so the recipe is reused verbatim).
export interface PlateExtraction {
  description: string; // color + make + model in plain words; "" if unclear
  plateNumber: string; // characters only; "" if not legible
  plateState: string; // 2-letter US state; "" if not visible
  confidence: "high" | "medium" | "low";
}

export interface VehicleDraft {
  plateId: string;
  plateState: string;
  color: string;
  make: string;
  model: string;
}

// Find the first catalog entry mentioned in a free-text description (the LLM
// returns description as plain words like "white Toyota Corolla"). Case-
// insensitive substring match; skips the "Other" catch-all.
const firstMentioned = (
  text: string,
  options: readonly string[],
): string => {
  const lower = text.toLowerCase();
  return options.find((opt) =>
    opt && opt !== "Other" && lower.includes(opt.toLowerCase())
  ) ?? "";
};

// Map an LLM extraction onto editable Vehicle draft fields. Plate/state pass
// through (normalization happens later in buildSelfClaim); color/make/model are
// best-effort parsed from the free-text description and clamped to the catalog
// by normalizeVehicle. The user reviews/corrects before saving (EF1).
export const extractionToDraft = (e: PlateExtraction): VehicleDraft => {
  const make = firstMentioned(e.description, VEHICLE_MAKES);
  const model = make ? firstMentioned(e.description, modelsForMake(make)) : "";
  return {
    plateId: e.plateNumber,
    plateState: e.plateState,
    color: firstMentioned(e.description, VEHICLE_COLORS),
    make,
    model,
  };
};
