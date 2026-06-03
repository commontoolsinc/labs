import { computed, NAME, pattern, UI, wish } from "commonfabric";
import { formatVehicle } from "../vehicles.ts";
import { CAR_TAG, VehicleClaim } from "../my-car/claims.ts";

// Minimal consumer demo (DESIGN §3/§6): stands in for what an org-side pattern
// (parking-coordinator / lot-watch) does — discover the viewer's car via the
// profile-scoped `#car` wish and read its `selfClaims`. No trust derivation yet
// (that's Phase 4); this just proves the producer<->consumer CAR_TAG contract
// resolves across spaces.

type WishedCar = { selfClaims?: VehicleClaim[] };

export default pattern(
  () => {
    const carWish = wish<WishedCar>({
      query: `#${CAR_TAG}`,
      scope: ["profile"],
    });

    const count = computed(() => (carWish.result?.selfClaims ?? []).length);
    const summary = computed(() => {
      const claims = carWish.result?.selfClaims ?? [];
      return claims.length
        ? claims.map((claim) => formatVehicle(claim.vehicle)).join(" · ")
        : "No car shared yet";
    });

    return {
      [NAME]: "My Car — Consumer Demo",
      [UI]: (
        <cf-screen>
          <cf-vstack gap="3" style={{ padding: "1rem", maxWidth: "640px" }}>
            <h2 style={{ margin: 0, fontSize: "16px" }}>
              What the org sees (via #car wish)
            </h2>
            <div id="consumer-car-count">Cars discovered: {count}</div>
            <div id="consumer-car-summary">{summary}</div>
            <div id="consumer-wish-ui">{carWish}</div>
          </cf-vstack>
        </cf-screen>
      ),
    };
  },
  false as const,
  {
    type: "object",
    properties: {
      [NAME]: { type: "string" },
      [UI]: true,
    },
    required: [NAME, UI],
  },
);
