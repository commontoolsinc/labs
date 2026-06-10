import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  affiliatedFromClaims,
  classifyPlate,
  GuestVouch,
  plateKey,
} from "./classification.ts";
import { VehicleClaim } from "../my-car/claims.ts";

const NOW = 1_700_000_000_000;
const v = (plateId: string, plateState = "CA"): {
  plateId: string;
  plateState: string;
  color: string;
  make: string;
  model: string;
} => ({ plateId, plateState, color: "", make: "", model: "" });

describe("plateKey", () => {
  it("normalizes plate + uppercases state", () => {
    expect(plateKey("7abc-123", "ca")).toBe("7ABC123|CA");
  });
});

describe("affiliatedFromClaims", () => {
  it("extracts vehicles from self claims only", () => {
    const claims: VehicleClaim[] = [
      { vehicle: v("AAA111"), claimType: "self", claimedAt: NOW },
      { vehicle: v("BBB222"), claimType: "guest", claimedAt: NOW },
    ];
    const out = affiliatedFromClaims(claims);
    expect(out.length).toBe(1);
    expect(out[0].plateId).toBe("AAA111");
  });
});

describe("classifyPlate", () => {
  const affiliated = [v("7ABC123", "CA")];
  const vouches: GuestVouch[] = [
    { voucher: "did:key:bob", vehicle: v("9XYZ555", "CA"), vouchedAt: NOW },
  ];

  it("classifies an employee self-claim as ours", () => {
    expect(classifyPlate("7abc123", "CA", affiliated, vouches)).toBe("ours");
  });

  it("classifies a vouched guest as guest", () => {
    expect(classifyPlate("9XYZ555", "CA", affiliated, vouches)).toBe("guest");
  });

  it("classifies an unmatched plate as unknown", () => {
    expect(classifyPlate("0NONE00", "CA", affiliated, vouches)).toBe("unknown");
  });

  it("is state-sensitive (same plate, different state = unknown)", () => {
    expect(classifyPlate("7ABC123", "NV", affiliated, vouches)).toBe("unknown");
  });

  it("prefers ours over guest when a plate is both", () => {
    const both: GuestVouch[] = [
      { voucher: "did:key:bob", vehicle: v("7ABC123", "CA"), vouchedAt: NOW },
    ];
    expect(classifyPlate("7ABC123", "CA", affiliated, both)).toBe("ours");
  });

  it("treats an empty plate as unknown", () => {
    expect(classifyPlate("", "", affiliated, vouches)).toBe("unknown");
  });
});
