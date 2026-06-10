import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  activeCarVouchVehicles,
  activeTrustedPrincipals,
  allowedVehicles,
  CarVouch,
  isPlateAllowed,
  isWithin,
  PersonVouch,
  toAuthoredClaims,
} from "./vouching.ts";
import { AuthoredClaim, IntegrityAtom } from "./provenance.ts";
import { VehicleClaim } from "../my-car/claims.ts";

const ALICE = "did:key:alice"; // employee
const BOB = "did:key:bob"; // employee
const ERIN = "did:key:erin"; // Bob's friend (vouchee)
const MALLORY = "did:key:mallory"; // not vouched

const employees = new Set([ALICE, BOB]);
const owner = (did: string): IntegrityAtom[] => [
  { kind: "represents-principal", subject: did },
];
const v = (plateId: string, plateState = "CA"): {
  plateId: string;
  plateState: string;
  color: string;
  make: string;
  model: string;
} => ({ plateId, plateState, color: "", make: "", model: "" });

// Window helpers (epoch ms).
const NOW = 1_700_000_000_000;
const DAY = 86_400_000;
const open = { validFrom: NOW - DAY, validUntil: NOW + DAY }; // active
const past = { validFrom: NOW - 2 * DAY, validUntil: NOW - DAY }; // expired

describe("isWithin", () => {
  it("true inside, false before/after", () => {
    expect(isWithin(NOW, open)).toBe(true);
    expect(isWithin(NOW, past)).toBe(false);
    expect(isWithin(open.validFrom, open)).toBe(true); // inclusive
    expect(isWithin(open.validUntil, open)).toBe(true);
  });
});

describe("activeTrustedPrincipals", () => {
  it("employees are always trusted", () => {
    const set = activeTrustedPrincipals(employees, [], NOW);
    expect(set.has(ALICE)).toBe(true);
    expect(set.has(BOB)).toBe(true);
  });

  it("an in-window person-vouch by an employee adds the vouchee", () => {
    const pv: PersonVouch[] = [{
      kind: "person",
      voucher: BOB,
      vouchee: ERIN,
      ...open,
    }];
    expect(activeTrustedPrincipals(employees, pv, NOW).has(ERIN)).toBe(true);
  });

  it("an EXPIRED person-vouch does not add the vouchee (time-boxing)", () => {
    const pv: PersonVouch[] = [{
      kind: "person",
      voucher: BOB,
      vouchee: ERIN,
      ...past,
    }];
    expect(activeTrustedPrincipals(employees, pv, NOW).has(ERIN)).toBe(false);
  });

  it("ONE HOP: a vouch authored by a non-employee grants nothing", () => {
    // Erin (a vouchee, not an employee) tries to vouch for Mallory.
    const pv: PersonVouch[] = [{
      kind: "person",
      voucher: ERIN,
      vouchee: MALLORY,
      ...open,
    }];
    expect(activeTrustedPrincipals(employees, pv, NOW).has(MALLORY)).toBe(
      false,
    );
  });

  it("revocation: dropping the voucher-employee drops their vouchee", () => {
    const pv: PersonVouch[] = [{
      kind: "person",
      voucher: BOB,
      vouchee: ERIN,
      ...open,
    }];
    const withoutBob = new Set([ALICE]);
    expect(activeTrustedPrincipals(withoutBob, pv, NOW).has(ERIN)).toBe(false);
  });
});

describe("activeCarVouchVehicles", () => {
  it("includes an in-window employee car-vouch, excludes expired / non-employee", () => {
    const cvs: CarVouch[] = [
      { kind: "car", voucher: BOB, vehicle: v("GUEST01"), ...open },
      { kind: "car", voucher: BOB, vehicle: v("OLD01"), ...past },
      { kind: "car", voucher: MALLORY, vehicle: v("BAD01"), ...open },
    ];
    const out = activeCarVouchVehicles(cvs, employees, NOW).map((x) =>
      x.plateId
    );
    expect(out).toEqual(["GUEST01"]);
  });
});

describe("allowedVehicles (composite, time-aware)", () => {
  const claims: AuthoredClaim[] = [
    { vehicle: v("ALICE1"), authorAtoms: owner(ALICE) }, // employee self-claim
    { vehicle: v("ERINCAR"), authorAtoms: owner(ERIN) }, // friend self-claim
    { vehicle: v("MAL1"), authorAtoms: owner(MALLORY) }, // not trusted
  ];

  it("allows employee + in-window-vouched friend's self-claims + car-vouch", () => {
    const personVouches: PersonVouch[] = [
      { kind: "person", voucher: BOB, vouchee: ERIN, ...open },
    ];
    const carVouches: CarVouch[] = [
      { kind: "car", voucher: ALICE, vehicle: v("GUEST01"), ...open },
    ];
    const allowed = allowedVehicles(
      claims,
      employees,
      personVouches,
      carVouches,
      NOW,
    );
    const plates = allowed.map((x) => x.plateId).sort();
    expect(plates).toEqual(["ALICE1", "ERINCAR", "GUEST01"].sort());
    expect(isPlateAllowed("ERINCAR", "CA", allowed)).toBe(true);
    expect(isPlateAllowed("MAL1", "CA", allowed)).toBe(false);
  });

  it("once the vouch window passes, the friend's car drops out", () => {
    const personVouches: PersonVouch[] = [
      { kind: "person", voucher: BOB, vouchee: ERIN, ...past }, // expired
    ];
    const allowed = allowedVehicles(claims, employees, personVouches, [], NOW);
    expect(isPlateAllowed("ERINCAR", "CA", allowed)).toBe(false); // friend no longer trusted
    expect(isPlateAllowed("ALICE1", "CA", allowed)).toBe(true); // employee still is
  });
});

describe("toAuthoredClaims (claimant → author atom bridge)", () => {
  it("maps a claim's claimant DID to a represents-principal author atom", () => {
    const claims: VehicleClaim[] = [
      { vehicle: v("X1"), claimType: "self", claimedAt: NOW, claimant: ERIN },
    ];
    expect(toAuthoredClaims(claims)[0].authorAtoms).toEqual([
      { kind: "represents-principal", subject: ERIN },
    ]);
  });

  it("yields no author atoms when claimant is absent (so it won't be trusted)", () => {
    const claims: VehicleClaim[] = [
      { vehicle: v("X2"), claimType: "self", claimedAt: NOW },
    ];
    expect(toAuthoredClaims(claims)[0].authorAtoms).toEqual([]);
  });
});
