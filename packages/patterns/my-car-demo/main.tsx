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
import { classifyPlate, GuestVouch, plateKey } from "./classification.ts";
import {
  activeCarVouchVehicles,
  activeTrustedPrincipals,
  allowedVehicles,
  CarVouch,
  isPlateAllowed,
  PersonVouch,
  toAuthoredClaims,
} from "./vouching.ts";
import { trustedAffiliatedVehicles } from "./provenance.ts";
import {
  isRevealed,
  requestReveal,
  RevealRequest,
  setRevealStatus,
} from "./reveal.ts";

// Org-side demo (DESIGN §2-§7, §13): stands in for what parking-coordinator /
// lot-watch do, now WIRED to the full trust model rather than taking inputs as
// pre-trusted. It:
//   - discovers users' cars via the profile-scoped `#car` wish,
//   - GATES them by provenance + delegated, time-boxed vouching: a car is
//     "allowed" iff its self-claim's author is a currently-trusted principal
//     (an employee, or an in-window vouchee of an employee), or it matches an
//     in-window employee car-vouch (provenance.ts + vouching.ts),
//   - classifies a seen plate ours / guest / unknown (classification.ts),
//   - runs the confidential-note reveal handshake (reveal.ts).
//
// AUTHOR KEY: the trust gate keys on each claim's `claimant` DID — the documented
// stand-in (claims.ts, vouching.ts:toAuthoredClaims). Production reads the claim's
// CFC `represents-principal` atom instead; that read (and a write-gate) is the
// deferred runner-substrate half of the SameAuthorAs primitive (CT-1660), not
// pattern-land. Everything here is the real rule, enforced by derivation.
//
// `now` is a stamped value (set by handlers / the Refresh button via
// safeDateNow()), never read inside a re-running computed — time stays out of
// reactive recomputation (SES). Advancing it past a vouch's window drops that
// vouch live, demonstrating time-boxing.

type WishedCar = { selfClaims?: VehicleClaim[] };

const DAY_MS = 86_400_000;

const stamp = (cell: Writable<number>) => cell.set(safeDateNow());

const addEmployee = handler<void, {
  employees: Writable<string[]>;
  newEmployee: Writable<string>;
  nowCell: Writable<number>;
}>((_, s) => {
  const did = s.newEmployee.get().trim();
  if (!did) return;
  if (!s.employees.get().includes(did)) s.employees.push(did);
  s.newEmployee.set("");
  stamp(s.nowCell);
});

const clearEmployees = handler<void, {
  employees: Writable<string[]>;
  nowCell: Writable<number>;
}>((_, s) => {
  s.employees.set([]);
  stamp(s.nowCell);
});

// §13(b) person-vouch: an employee vouches for a friend's DID; the friend then
// self-claims their own car(s). Time-boxed from now. One hop is enforced by the
// gate (a vouch whose voucher isn't an employee grants nothing).
const addPersonVouch = handler<void, {
  personVouches: Writable<PersonVouch[]>;
  voucher: Writable<string>;
  vouchee: Writable<string>;
  days: Writable<string>;
  nowCell: Writable<number>;
}>((_, s) => {
  const vouchee = s.vouchee.get().trim();
  if (!vouchee) return;
  const now = safeDateNow();
  const days = Number(s.days.get()) || 1;
  s.personVouches.push({
    kind: "person",
    voucher: s.voucher.get().trim() || "unknown",
    vouchee,
    validFrom: now,
    validUntil: now + days * DAY_MS,
  });
  s.vouchee.set("");
  s.nowCell.set(now);
});

// §13(a) car-vouch: an employee vouches for a specific guest CAR (the guest has
// no profile). Time-boxed.
const addCarVouch = handler<void, {
  carVouches: Writable<CarVouch[]>;
  voucher: Writable<string>;
  plate: Writable<string>;
  state: Writable<string>;
  days: Writable<string>;
  nowCell: Writable<number>;
}>((_, s) => {
  const vehicle = normalizeVehicle({
    plateId: s.plate.get(),
    plateState: s.state.get(),
    color: "",
    make: "",
    model: "",
  });
  if (!vehicle.plateId) return;
  const now = safeDateNow();
  const days = Number(s.days.get()) || 1;
  s.carVouches.push({
    kind: "car",
    voucher: s.voucher.get().trim() || "unknown",
    vehicle,
    validFrom: now,
    validUntil: now + days * DAY_MS,
  });
  s.plate.set("");
  s.state.set("");
  s.nowCell.set(now);
});

const refreshNow = handler<void, { nowCell: Writable<number> }>((_, s) => {
  stamp(s.nowCell);
});

// Reveal handshake, keyed on a typed claim id (the plate) to avoid per-row
// interactive handlers over the reactive wish array.
const requestRevealH = handler<void, {
  revealRequests: Writable<RevealRequest[]>;
  adminDid: Writable<string>;
  claimId: Writable<string>;
  nowCell: Writable<number>;
}>((_, s) => {
  const id = s.claimId.get().trim();
  if (!id) return;
  s.revealRequests.set(
    requestReveal(
      s.revealRequests.get(),
      s.adminDid.get().trim() || "admin",
      id,
    ),
  );
  stamp(s.nowCell);
});

const approveRevealH = handler<void, {
  revealRequests: Writable<RevealRequest[]>;
  adminDid: Writable<string>;
  claimId: Writable<string>;
}>((_, s) => {
  const id = s.claimId.get().trim();
  if (!id) return;
  s.revealRequests.set(
    setRevealStatus(
      s.revealRequests.get(),
      s.adminDid.get().trim() || "admin",
      id,
      "approved",
    ),
  );
});

const declineRevealH = handler<void, {
  revealRequests: Writable<RevealRequest[]>;
  adminDid: Writable<string>;
  claimId: Writable<string>;
}>((_, s) => {
  const id = s.claimId.get().trim();
  if (!id) return;
  s.revealRequests.set(
    setRevealStatus(
      s.revealRequests.get(),
      s.adminDid.get().trim() || "admin",
      id,
      "declined",
    ),
  );
});

export default pattern(
  () => {
    const carWish = wish<WishedCar>({
      query: `#${CAR_TAG}`,
      scope: ["profile"],
    });

    // Org-shared trust state.
    const employees = new Writable.perSpace<string[]>([]);
    const personVouches = new Writable.perSpace<PersonVouch[]>([]);
    const carVouches = new Writable.perSpace<CarVouch[]>([]);
    const revealRequests = new Writable.perSpace<RevealRequest[]>([]);

    // Stamped "current time" — set by handlers, read (not computed) below.
    const nowCell = new Writable.perSpace<number>(0);

    // This viewer's form/session state.
    const adminDid = new Writable.perSession("");
    const newEmployee = new Writable.perSession("");
    const pvVouchee = new Writable.perSession("");
    const pvDays = new Writable.perSession("7");
    const cvPlate = new Writable.perSession("");
    const cvState = new Writable.perSession("");
    const cvDays = new Writable.perSession("1");
    const testPlate = new Writable.perSession("");
    const testState = new Writable.perSession("");
    const revealClaimId = new Writable.perSession("");

    // The gated allowed set: provenance + time-boxed vouching (the real rule).
    // Recomputed inline per computed (cell reads must happen inside each
    // computed to register reactive deps — a computed can't read another's value).
    const allowedPlates = computed(() =>
      allowedVehicles(
        toAuthoredClaims(carWish.result?.selfClaims ?? []),
        new Set(employees.get()),
        personVouches.get(),
        carVouches.get(),
        nowCell.get(),
      ).map((v) => plateKey(v.plateId, v.plateState))
    );
    const allowedSummary = computed(() => {
      const a = allowedVehicles(
        toAuthoredClaims(carWish.result?.selfClaims ?? []),
        new Set(employees.get()),
        personVouches.get(),
        carVouches.get(),
        nowCell.get(),
      );
      return a.length ? a.map(formatVehicle).join(" · ") : "none yet";
    });
    const allowedCount = computed(() =>
      allowedVehicles(
        toAuthoredClaims(carWish.result?.selfClaims ?? []),
        new Set(employees.get()),
        personVouches.get(),
        carVouches.get(),
        nowCell.get(),
      ).length
    );
    const employeeCount = computed(() => employees.get().length);

    // Ours vs guest split for the classifier (mirrors the gated set).
    const testClassification = computed(() => {
      const claims = toAuthoredClaims(carWish.result?.selfClaims ?? []);
      const emp = new Set(employees.get());
      const n = nowCell.get();
      const ours = trustedAffiliatedVehicles(
        claims,
        activeTrustedPrincipals(emp, personVouches.get(), n),
      );
      const guests: GuestVouch[] = activeCarVouchVehicles(
        carVouches.get(),
        emp,
        n,
      ).map((vehicle) => ({ voucher: "", vehicle, vouchedAt: 0 }));
      return classifyPlate(testPlate.get(), testState.get(), ours, guests);
    });
    const testAllowed = computed(() =>
      isPlateAllowed(
          testPlate.get(),
          testState.get(),
          allowedVehicles(
            toAuthoredClaims(carWish.result?.selfClaims ?? []),
            new Set(employees.get()),
            personVouches.get(),
            carVouches.get(),
            nowCell.get(),
          ),
        )
        ? "yes"
        : "no"
    );

    const clockLabel = computed(() => {
      const n = nowCell.get();
      return n === 0 ? "not set — click Refresh" : `t=${n}`;
    });

    const revealView = computed(() => {
      const id = (revealClaimId.get() ?? "").trim();
      if (!id) return "Enter a claim's plate above to manage its note reveal.";
      const admin = (adminDid.get() ?? "").trim() || "admin";
      const claim = (carWish.result?.selfClaims ?? []).find((c) =>
        plateKey(c.vehicle.plateId, c.vehicle.plateState) ===
          plateKey(id, testState.get())
      );
      const req = revealRequests.get().find((r) =>
        r.requestedBy === admin && r.claimId === id
      );
      const status = req ? req.status : "no request";
      const note = isRevealed(revealRequests.get(), admin, id)
        ? (claim?.note ?? "(owner note is empty)")
        : "hidden — awaiting owner approval";
      return `request: ${status} · note: ${note}`;
    });

    return {
      [NAME]: "My Car — Org Demo",
      employees,
      personVouches,
      carVouches,
      revealRequests,
      allowedPlates,
      [UI]: (
        <cf-screen>
          <cf-vstack gap="4" style={{ padding: "1rem", maxWidth: "680px" }}>
            <h2 style={{ margin: 0, fontSize: "16px" }}>
              What the org sees & does
            </h2>
            <span style={{ opacity: 0.7 }}>
              Clock: {clockLabel}{" "}
              <cf-button onClick={refreshNow({ nowCell })}>Refresh</cf-button>
            </span>

            <cf-vstack gap="2">
              <strong>
                Allowed cars (provenance + in-window vouches): {allowedCount}
              </strong>
              <span id="allowed-summary">{allowedSummary}</span>
            </cf-vstack>

            <cf-vstack gap="2">
              <strong>Employee roster ({employeeCount})</strong>
              <cf-hstack gap="2">
                <cf-input
                  $value={newEmployee}
                  placeholder="Employee DID (trusted to claim/vouch)"
                />
                <cf-button
                  onClick={addEmployee({ employees, newEmployee, nowCell })}
                >
                  Add
                </cf-button>
                <cf-button onClick={clearEmployees({ employees, nowCell })}>
                  Reset (revoke all)
                </cf-button>
              </cf-hstack>
              {employees.map((did) => <span>· {did}</span>)}
            </cf-vstack>

            <cf-vstack gap="2">
              <strong>Vouch for a friend (one hop, time-boxed)</strong>
              <cf-input
                $value={adminDid}
                placeholder="Your employee DID (voucher)"
              />
              <cf-hstack gap="2">
                <cf-input
                  $value={pvVouchee}
                  placeholder="Friend's DID (they self-claim their car)"
                />
                <cf-input $value={pvDays} placeholder="days" />
                <cf-button
                  onClick={addPersonVouch({
                    personVouches,
                    voucher: adminDid,
                    vouchee: pvVouchee,
                    days: pvDays,
                    nowCell,
                  })}
                >
                  Vouch person
                </cf-button>
              </cf-hstack>
              {personVouches.map((v) => (
                <span>
                  · {v.voucher} → {v.vouchee} (until {v.validUntil})
                </span>
              ))}
            </cf-vstack>

            <cf-vstack gap="2">
              <strong>Vouch for a guest's car (time-boxed)</strong>
              <cf-hstack gap="2">
                <cf-input $value={cvPlate} placeholder="Guest plate" />
                <cf-input $value={cvState} placeholder="State" />
                <cf-input $value={cvDays} placeholder="days" />
                <cf-button
                  onClick={addCarVouch({
                    carVouches,
                    voucher: adminDid,
                    plate: cvPlate,
                    state: cvState,
                    days: cvDays,
                    nowCell,
                  })}
                >
                  Vouch car
                </cf-button>
              </cf-hstack>
              {carVouches.map((v) => (
                <span>
                  · {formatVehicle(v.vehicle)} by {v.voucher} (until{" "}
                  {v.validUntil})
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
                Classification: {testClassification} · allowed: {testAllowed}
              </div>
            </cf-vstack>

            <cf-vstack gap="2">
              <strong>Reveal a claim's private note</strong>
              <cf-hstack gap="2">
                <cf-input
                  $value={revealClaimId}
                  placeholder="Claim plate (the note's claim id)"
                />
                <cf-button
                  onClick={requestRevealH({
                    revealRequests,
                    adminDid,
                    claimId: revealClaimId,
                    nowCell,
                  })}
                >
                  Request
                </cf-button>
                <cf-button
                  onClick={approveRevealH({
                    revealRequests,
                    adminDid,
                    claimId: revealClaimId,
                  })}
                >
                  Approve (owner)
                </cf-button>
                <cf-button
                  onClick={declineRevealH({
                    revealRequests,
                    adminDid,
                    claimId: revealClaimId,
                  })}
                >
                  Decline (owner)
                </cf-button>
              </cf-hstack>
              <div id="reveal-view">{revealView}</div>
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
      employees: { type: "array", items: { type: "string" } },
      personVouches: { type: "array" },
      carVouches: { type: "array" },
      revealRequests: { type: "array" },
      allowedPlates: { type: "array", items: { type: "string" } },
    },
    required: [NAME, UI],
  },
);
