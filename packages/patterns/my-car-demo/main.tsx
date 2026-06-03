import {
  computed,
  handler,
  NAME,
  pattern,
  safeDateNow,
  UI,
  wish,
  Writable,
} from "commonfabric";
import { formatVehicle, normalizeVehicle } from "../vehicles.ts";
import { CAR_TAG, VehicleClaim } from "../my-car/claims.ts";
import {
  affiliatedFromClaims,
  classifyPlate,
  GuestVouch,
} from "./classification.ts";

// Org-side demo (DESIGN §3-§5): stands in for what parking-coordinator / lot-watch
// do. Discovers employees' cars via the profile-scoped `#car` wish ("ours"),
// lets any employee vouch for a guest's car (a same-space write, authored-by the
// voucher), and classifies a test plate ours/guest/unknown. No trust-provenance
// gating yet (Phase 4 SameAuthorAs); the wished claims and vouches are taken as
// trusted inputs here.

type WishedCar = { selfClaims?: VehicleClaim[] };

const vouchGuest = handler<void, {
  guestVouches: Writable<GuestVouch[]>;
  voucher: Writable<string>;
  plate: Writable<string>;
  state: Writable<string>;
  guestName: Writable<string>;
}>((_, s) => {
  const vehicle = normalizeVehicle({
    plateId: s.plate.get(),
    plateState: s.state.get(),
    color: "",
    make: "",
    model: "",
  });
  if (!vehicle.plateId) return;
  s.guestVouches.push({
    voucher: s.voucher.get() || "unknown",
    vehicle,
    vouchedAt: safeDateNow(),
    guestName: s.guestName.get() || undefined,
  });
  s.plate.set("");
  s.state.set("");
  s.guestName.set("");
});

export default pattern(
  () => {
    const carWish = wish<WishedCar>({
      query: `#${CAR_TAG}`,
      scope: ["profile"],
    });

    const guestVouches = new Writable.perSpace<GuestVouch[]>([]);

    const voucher = new Writable.perSession("");
    const vouchPlate = new Writable.perSession("");
    const vouchState = new Writable.perSession("");
    const guestName = new Writable.perSession("");

    const testPlate = new Writable.perSession("");
    const testState = new Writable.perSession("");

    const oursCount = computed(() =>
      affiliatedFromClaims(carWish.result?.selfClaims ?? []).length
    );
    const oursSummary = computed(() => {
      const ours = affiliatedFromClaims(carWish.result?.selfClaims ?? []);
      return ours.length ? ours.map(formatVehicle).join(" · ") : "none yet";
    });
    const guestCount = computed(() => guestVouches.get().length);
    const testClassification = computed(() =>
      classifyPlate(
        testPlate.get(),
        testState.get(),
        affiliatedFromClaims(carWish.result?.selfClaims ?? []),
        guestVouches.get(),
      )
    );

    return {
      [NAME]: "My Car — Org Demo",
      guestVouches,
      [UI]: (
        <cf-screen>
          <cf-vstack gap="4" style={{ padding: "1rem", maxWidth: "640px" }}>
            <h2 style={{ margin: 0, fontSize: "16px" }}>
              What the org sees & does
            </h2>

            <cf-vstack gap="1">
              <strong>Ours (employee cars, via #car wish): {oursCount}</strong>
              <span id="ours-summary">{oursSummary}</span>
            </cf-vstack>

            <cf-vstack gap="2">
              <strong>Vouch for a guest's car ({guestCount})</strong>
              <cf-input
                $value={voucher}
                placeholder="Your name/DID (the voucher)"
              />
              <cf-hstack gap="2">
                <cf-input $value={vouchPlate} placeholder="Guest plate" />
                <cf-input $value={vouchState} placeholder="State" />
                <cf-input $value={guestName} placeholder="Guest name (opt)" />
              </cf-hstack>
              <cf-button
                onClick={vouchGuest({
                  guestVouches,
                  voucher,
                  plate: vouchPlate,
                  state: vouchState,
                  guestName,
                })}
              >
                Vouch
              </cf-button>
              {guestVouches.map((vouch) => (
                <span>
                  {formatVehicle(vouch.vehicle)} — guest
                  {vouch.guestName ? ` (${vouch.guestName})` : ""}, vouched by
                  {" "}
                  {vouch.voucher}
                </span>
              ))}
            </cf-vstack>

            <cf-vstack gap="2">
              <strong>Classify a seen plate</strong>
              <cf-hstack gap="2">
                <cf-input $value={testPlate} placeholder="Plate" />
                <cf-input $value={testState} placeholder="State" />
              </cf-hstack>
              <div id="test-classification">
                Classification: {testClassification}
              </div>
            </cf-vstack>
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
