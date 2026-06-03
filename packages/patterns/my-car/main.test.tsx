/**
 * MyCar Pattern Tests (Phase 1)
 *
 * Owner-integrity enforcement (ownerPrincipal === writer, represents-principal
 * atom, writeAuthorizedBy → addClaim) is validated structurally: MyCar's
 * `selfClaims` lowers to the SAME `ifc` shape as profile-home.tsx's
 * owner-protected `elements`, whose runtime enforcement is covered by
 * packages/runner/test/profile-owner-cfc.test.ts. Confirm the emitted contract
 * with: `deno task cf check packages/patterns/my-car/main.tsx --show-transformed`.
 *
 * These unit tests cover the pure, pattern-local logic: claim construction
 * (normalization + plate-required + defaults) and plate-keyed removal.
 */
import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  buildSelfClaim,
  CAR_TAG,
  filterOutPlate,
  VehicleClaim,
} from "./claims.ts";

const NOW = 1_700_000_000_000;

describe("MyCar buildSelfClaim", () => {
  it("normalizes the vehicle and stamps a self claim", () => {
    const claim = buildSelfClaim(
      {
        plateId: "7abc-123",
        plateState: "ca",
        color: "Black",
        make: "Subaru",
        model: "Outback",
      },
      NOW,
    );
    expect(claim).not.toBeNull();
    expect(claim!.claimType).toBe("self");
    expect(claim!.claimedAt).toBe(NOW);
    expect(claim!.share).toBe("plate");
    // normalizePlateId uppercases + strips non-alphanumerics
    expect(claim!.vehicle.plateId).toBe("7ABC123");
    expect(claim!.vehicle.plateState).toBe("CA");
    expect(claim!.vehicle.make).toBe("Subaru");
    expect(claim!.vehicle.model).toBe("Outback");
  });

  it("defaults an unknown/blank state to CA", () => {
    const claim = buildSelfClaim(
      { plateId: "ABC123", plateState: "", color: "", make: "", model: "" },
      NOW,
    );
    expect(claim!.vehicle.plateState).toBe("CA");
  });

  it("drops make/model not in the catalog", () => {
    const claim = buildSelfClaim(
      {
        plateId: "ABC123",
        plateState: "CA",
        color: "",
        make: "Spaceship",
        model: "Warp",
      },
      NOW,
    );
    expect(claim!.vehicle.make).toBe("");
    expect(claim!.vehicle.model).toBe("");
  });

  it("returns null when there is no plate (the cross-space match key)", () => {
    const claim = buildSelfClaim(
      { plateId: "  ", plateState: "CA", color: "Black", make: "", model: "" },
      NOW,
    );
    expect(claim).toBeNull();
  });
});

describe("MyCar filterOutPlate", () => {
  const claims: VehicleClaim[] = [
    {
      vehicle: {
        plateId: "7ABC123",
        plateState: "CA",
        color: "",
        make: "",
        model: "",
      },
      claimType: "self",
      claimedAt: NOW,
    },
    {
      vehicle: {
        plateId: "9XYZ555",
        plateState: "NV",
        color: "",
        make: "",
        model: "",
      },
      claimType: "self",
      claimedAt: NOW,
    },
  ];

  it("removes the matching (plateId, plateState) and keeps the rest", () => {
    const out = filterOutPlate(claims, "7ABC123", "CA");
    expect(out.length).toBe(1);
    expect(out[0].vehicle.plateId).toBe("9XYZ555");
  });

  it("matches on state too — same plateId in a different state is kept", () => {
    const out = filterOutPlate(claims, "7ABC123", "NV");
    expect(out.length).toBe(2);
  });
});

describe("MyCar contract token", () => {
  it("exports the canonical discovery tag", () => {
    expect(CAR_TAG).toBe("car");
  });
});
