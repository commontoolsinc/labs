# DESIGN — "My Car" × Parking, a CFC worked example

**Status:** Design phase. No code, no implementation. Concrete and type-precise.
Built on the shared-profile / `wish()` substrate (PR #3762). A companion
`voucher-last-mile-investigation.md` works through Berni's profile-reference
primitive for §4's last mile — see §4 "Closing the last mile".

**Authoritative inputs:** `DESIGN-BRIEF.md` (the locked spine),
`naming-proposals.md` (the ratified vocabulary — used verbatim here),
`codebase-research.md` (machinery, with `file:line` refs), `ux-journeys.md`
(actors, journeys, edge cases — its "Dana" is standardized to **Alice** here),
`cardweb-synthesis.md` (conceptual framing, cited by card id).

---

## 0. Thesis & summary

**The org does not trust a car; it trusts a CLAIM made by someone trusted to
make it.** Trust travels with the claim's provenance, not with the bytes of a
plate. The org allows any vehicle whose claim was authored by a current employee
— a _provenance check_ on the CFC integrity atoms already in the runtime
(`authored-by` / `represents-principal`, `CURRENT_PRINCIPAL_CLAIM_KINDS`;
`prepare.ts:107`). This is "policies on data, not apps" (c-573): the allow
decision reads the claim's authorship, it does not consult an admin-maintained
roster of plates.

"Take a picture of your car" is just the ergonomic way to _author_ the claim.
The security substance is **whose identity the claim is attached to**.

This claim model **dissolves the central cross-space-write tension** that
`codebase-research.md:193` flagged (a foreign pattern cannot write your
owner-protected profile). Nobody writes where they are not entitled:

- **Self-claims** live on the claimant's own profile space, owner-protected
  (`represents-principal = claimant`), authored only by the claimant through
  trusted handlers — exactly the `profile-home.tsx` owner-integrity model.
- **Guest legs** (`GuestVouch`) are authored _into the org space_ by the
  voucher, mirroring `lot-watch`'s `assignToPerson` precedent
  (`lot-watch/main.tsx:822`) — a same-space write, never cross-space.
- The org-space patterns (`parking-coordinator`, `lot-watch`) only **READ +
  check provenance**. They never write a claim into anyone's profile.

The deliverable in this pass is the design itself plus an `EXPLAINER.md`.
Granularity policy is deferred (the seam is marked, §8). The one genuine unknown
is the **wish fan-out** (§6) — the coordinator needs _all_ employees' cars, and
`scope: ["profile"]` resolves only the viewer's.

---

## 1. Actors, spaces & topology

### Personas (ratified)

| Persona   | Role                            | What they do here                                                                                                       |
| --------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| **Alice** | Employee / self-claimant (hero) | Authors a **self** `VehicleClaim` ("this is my car") on her profile. Hero of J-A and J-B.                               |
| **Bob**   | Employee / voucher              | Authors a **`GuestVouch`** into the org space for a legitimate guest's car.                                             |
| **Carol** | Parking admin                   | Operates `parking-coordinator` + `lot-watch`; sees the `ResolvedIdentity` surface; curates the long-tail unknowns.      |
| **Dave**  | Lot-owner / trust anchor        | Signs the **`EmployeeRoster`**: the set of `voucher`-role DIDs. Attests _who is an employee_; does not operate the lot. |
| **Erin**  | Guest (optional, subject only)  | The subject of Bob's vouch. Has no profile in v1.                                                                       |

Carol ≠ Dave on purpose: Carol _operates_ the lot (curation, admin-gated); Dave
_attests membership_ (the trust anchor). Admin is not the owner of trust.

### Spaces & topology

Three space kinds, fed by the standing wish:

```
Alice's profile space (DID_A)          Bob's profile space (DID_B)        … N employees
┌───────────────────────────┐          ┌──────────────────────────┐
│ profile-home (owner-prot.) │          │ profile-home              │
│  elements[]:               │          │  elements[]:              │
│   • MyCar  (#car)          │          │   • MyCar (#car)          │
│     vehicles: Vehicle[]    │          │     vehicles: Vehicle[]   │
│     selfClaims:VehicleClaim│          │                           │
│     (represents-principal  │          │                           │
│       = DID_A)             │          │                           │
└───────────┬───────────────┘          └───────────┬──────────────┘
            │  wish(#car, scope:["profile"])  READS only (cross-space)
            │  ───────────────────────────────────────────────┐
            ▼                                                   ▼
┌────────────────────────────────────────────────────────────────────────┐
│                    Org / parking space (DID_ORG)                         │
│                                                                          │
│  parking-coordinator: spots, people, requests, adminRegistry            │
│  lot-watch:           sightings, knownVehicles, classifyPlate            │
│                                                                          │
│  guestVouches: PerSpace<GuestVouchesCell>   ← Bob authors here (in-space)│
│  voucherRegistry: PerSpace<VoucherRegistryCell> ← Dave signs (anchor)    │
│                                                                          │
│  claimedCars  = resolved self-claims (via wish, provenance-checked)      │
│  affiliatedVehicles = claimedCars ∪ people[].vehicles  → drives "ours"   │
└────────────────────────────────────────────────────────────────────────┘
```

Cross-space **reads** (the wish) are fine and are the whole mechanism.
Cross-space **writes** never happen. This is the multi-space weave
(c-319/c-873): your car lives on _your_ profile, not inside the parking app.

---

## 2. The claim model & the provenance-as-trust rule

### One primitive, two legs

```ts
export interface VehicleClaim {
  claimant: string; // DID of the claimant (the represents-principal subject)
  vehicle: Vehicle; // REUSED verbatim from vehicles.ts
  claimType: "self" | "guest"; // self = my own car; guest = a legitimate guest's car
  claimedAt: number; // safeDateNow() — matches Sighting.capturedAt
  note?: ConfidentialOwnerNote; // private owner note, admin-invisible by default (§7)
  share?: ShareLevel; // deferred granularity rung (§8)
}
```

`claimant` is a **DID**, not free-text — this is the whole point versus the
demo-only `selectedPersonName`/`reporterName` in the existing patterns
(`parking-coordinator/main.tsx:293-298`, `:381-387`). The free-text actor key is
the explicit "do not copy for production authorization" gap; the DID-keyed claim
closes it.

There is no `source` field on the claim. Provenance is carried by CFC integrity
atoms (`authored-by` / `represents-principal`), not duplicated in data — the
allow decision _is_ the provenance check.

### The allow rule (provenance as trust)

> A vehicle is **`"ours"`** iff there exists a `VehicleClaim` (self) or
> `GuestVouch` (guest) for its normalized `(plateId, plateState)` whose author
> is a current `voucher` per Dave's `EmployeeRoster`.

For a **self-claim**, the author check is: the value carries
`{ kind: "represents-principal", subject: DID }` (the owner atom shape,
`prepare.ts:1101`) and `DID ∈ voucherRegistry`. For a **`GuestVouch`**, the
author check is: the value carries
`{ kind: "authored-by", subject: voucherDID }` and
`voucherDID ∈ voucherRegistry`.

No plate is ever trusted on its own. A bare plate with no current-employee
author resolves to `"unknown"`, never `"ours"`. Absence of a claim yields
unknown — no fabrication (ux-journeys J-B honest-friction note; c-383 read-only
is the safe default).

---

## 3. Where claims live & the full cross-space data flow

### Self-claim — on the claimant's profile

A self-claim is authored by Alice into **her own** profile space, exactly like a
profile element. `MyCar` is the profile element (`userTags: ["car"]`, discovered
via `#car`); its `selfClaims: VehicleClaim[]` field is owner-protected with the
same wrapper `profile-home.tsx:21` uses for `elements`:

```ts
type OwnerProtectedProfileWrite<T, Binding> = RepresentsCurrentUser<
  Cfc<WriteAuthorizedBy<T, Binding>, { ownerPrincipal: CurrentPrincipal }>
>;
```

So `selfClaims` is `OwnerProtectedProfileWrite<VehicleClaim[], typeof addClaim>`
— mutated **only** through trusted handlers (`addClaim` / `removeClaim`, modeled
on `addElement`/`removeElement` at `profile-home.tsx:131,153`), and only from
the trusted UI surface (`data-ui-pattern` / `data-ui-action` markers,
`profile-home.tsx:276-290`). The runtime enforces
`ownerPrincipal ===
actingPrincipal` plus a matching `represents-principal` atom
plus `writeAuthorizedBy` (`prepare.ts:1070-1112`). Proven by
`profile-owner-cfc.test.ts`: Bob cannot write Alice's fields (`:252`).

Result: the self-claim is **portable** (it travels with Alice's profile across
orgs) and **owner-only-mutable**. The org cannot forge it; another employee
cannot forge it.

### Guest leg — authored into the org space

A guest vouch is **not** owner-protected and **not** on a profile. Bob authors a
`GuestVouch` directly into the org space's `guestVouches` cell, the same way
`lot-watch`'s `assignToPerson` (`:822`) writes a `Vehicle` into the space-local
`people` cell. Same-space write, no cross-space conflict:

```ts
export interface GuestVouch {
  voucher: string; // DID of the vouching employee (authored-by atom)
  vehicle: Vehicle; // REUSED from vehicles.ts
  vouchedAt: number; // safeDateNow()
  guestName?: string; // optional display name, mirrors KnownVehicle.name
  note?: string; // why this guest is here, e.g. "interviewing Tue AM"
}

guestVouches: PerSpace<GuestVouchesCell>;
```

`GuestVouch` carries a `voucher` DID that `KnownVehicle` lacks — that DID is the
new value (attribution). It is the authored-into-space representation of a
`VehicleClaim` with `claimType === "guest"`: same conceptual primitive,
different storage and provenance.

### The data flow, who-writes-where / who-reads-where

| Actor                   | Writes                                                      | Where                                | Reads                                                                                |
| ----------------------- | ----------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------ |
| Alice                   | self `VehicleClaim`                                         | her profile space (owner-prot.)      | —                                                                                    |
| Bob                     | `GuestVouch`                                                | org space `guestVouches` (in-space)  | —                                                                                    |
| Dave                    | `EmployeeRoster` (voucher DIDs)                             | org space `voucherRegistry` (anchor) | —                                                                                    |
| Carol (admin)           | curation (`markVehicle`, `assignToPerson`), reveal requests | org space cells (in-space)           | `ResolvedIdentity` projections                                                       |
| coordinator / lot-watch | **nothing into profiles**                                   | —                                    | `wish(#car)` → `claimedCars`; `guestVouches`; `voucherRegistry`; `people[].vehicles` |

**How this dissolves the cross-space-write tension**
(`codebase-research.md:193`): the previously-hard requirement was "the
coordinator resolves an offender to an employee and stores the identity back
onto the profile." We **delete** that write. The identity already exists as a
self-claim on the profile; the coordinator only _reads + provenance-checks_ it
and derives a _space-local_ `ResolvedIdentity` projection (§7). Every write
lands where its author is entitled to write. The "wish AND store-back" hard path
simply never needs to exist.

---

## 4. The trust anchor — `EmployeeRoster` / `voucher`

"Current employee" needs an oracle. We **cheat the last mile**: Dave (lot-owner)
signs a list of DIDs that are current employees / vouchers. This is a deliberate
convention, **not** a real org directory.

Harmonized with `cfc/admin/mod.ts` (`AdminRegistryValue<Role>` at `mod.ts:31`):

```ts
export const VOUCHER_INTEGRITY = "voucher" as const;

export interface EmployeeAttestation {
  subject: string; // DID attested as a current employee
  displayName: string; // "Alice", "Bob" — mirrors AdminRoleAssignment.displayName
}
export type VoucherRole = AddIntegrity<
  EmployeeAttestation,
  readonly [typeof VOUCHER_INTEGRITY]
>;

export type VoucherRegistryValue = AdminRegistryValue<VoucherRole>;
export type VoucherRegistryCell = Writable<VoucherRegistryValue>;

voucherRegistry: PerSpace<VoucherRegistryCell>;
```

We split the **human noun** (`employee`, the `displayName`) from the
**capability noun** (`voucher`, the role / integrity tag), exactly as the
codebase splits `ParkingAdminRole` from its display name. The role `voucher`
names the _power_ — "this DID's claims count as ours" — which is precisely what
the provenance check tests.

**Revocation falls out:** drop a DID from `voucherRegistry` → every claim that
DID authored (self _and_ guest) silently stops passing the provenance check and
re-classifies away from `"ours"`. No per-claim deletion needed; it is reactive.

**Honest caveat (be explicit):** vouching gives **attribution, not prevention**.
A careless Bob can vouch for a car that should not be allowed; the system does
not stop him. What it guarantees is that _we know who vouched_ — the `voucher`
DID is on the record. This is **scaled trust, not trustlessness** (c-757):
infrastructure that makes Dave's trust go further, with accountability, not a
claim of perfect gatekeeping.

### Closing the last mile — profile references (recommended; Berni's direction)

The roster-of-raw-DIDs above is the _initial_ cheat. The better shape (Bernhard
Seefeld, authoritative): make the trust leaf a **profile reference**, not a DID.
Define "current employee" as **"owner of a member profile,"** so the allow rule
becomes:

> a self-claim is `"ours"` iff its `represents-principal` subject equals the
> owner (`represents-principal` subject) of some **member profile** the org
> holds.

`voucherRegistry<RawDID>` becomes `memberProfiles: ProfileRef[]` — still
owner-signed by Dave via `AdminRegistryValue` (curation unchanged), but the leaf
is a profile whose owner atom is the system's _strongest_ guarantee
(`ownerPrincipal === actingPrincipal` + matching `represents-principal`,
`prepare.ts:1099-1110`; `profile-owner-cfc.test.ts:284`), not a bare string.

**Key finding (`voucher-last-mile-investigation.md`):** the hard operation —
resolve a referenced profile's owner DID and compare it to a value's author — is
**already working, tested code** in `cf-cfc-authorship.ts:243-307`
(`representsPrincipalSubjectForLabel` + `integrityAtomMatchesAuthor`), today a
read-time _verification badge_ in `packages/ui`. Our allow rule is itself a
read-time **derivation** (§5 `classifyPlate(affiliatedVehicles)`), not an
owner-protected write — so v1 needs **no new runner gate**: lift that helper
into a shared module and call it inside the coordinator's `computed()`. A
type-only alias `SameAuthorAs<T, Reference>` (`api/cfc.ts`, sibling to
`RepresentsCurrentUser` `cfc.ts:259`) carries the intent. Promoting it to a real
`prepare.ts:1057` write-gate is genuine-but-deferrable substrate growth (only if
`GuestVouch` _writes_ must be gated this way; it forces a cross-space owner-read
inside the write transaction — keep the rule in §5 derivation for v1).

**The cheat moves up one level; it does not disappear.** The owner-signed _set_
(now of profile refs) is still the last-mile oracle — the win is the leaf's
quality (a profile-bound, unforgeable owner atom) and the unification with the
fan-out (§6), not the elimination of an owner-curated membership list. Fully in
the spirit of "scaled trust, not trustlessness" (c-757).

---

## 5. The org-side allow-set & reactive retro-resolution

### Keep `lot-watch`'s classification literal

`lot-watch` ships `Classification = "ours" | "guest" | "offender" | "unknown"`
(`lot-watch/main.tsx:33`), a color map (`#166534` green for `"ours"`,
`#166534`), and the `classifyPlate` priority **ours > offender > guest >
unknown** (`:277`). We **do not** rename any of it — this worked example
composes _with_ these patterns, it does not refactor them. `"ours"` also reads
perfectly on Carol's screen ("that's _ours_").

### Name the feed precisely

Today `"ours"` derives only from `people.flatMap(p => p.vehicles)`
(`lot-watch/main.tsx:1055`). We add a second, richer source — self-claims via
the wish — and name the combined derived input:

```
affiliatedVehicles = claimedCars ∪ people[].vehicles
```

- `claimedCars` = the self `VehicleClaim`s discovered via `wish(#car)` whose
  author passes the provenance check (§4). (Two names, two stages: discover
  claims → derive the allow-set.)
- `affiliatedVehicles` = the deduped `Vehicle` set that actually drives the
  `"ours"` classification. "Affiliated" is the brief's own word and avoids
  collision with "vouched" (the guest leg).

`classifyPlate` stays a module-scope pure function (`:277`) so it can run inside
`computed()` without capturing cells; we feed it `affiliatedVehicles` as the
`ours` argument. Guest matching converges from two directions:
`knownVehicles(guest) ∪ guestVouches` → the existing `"guest"` chip. Admin
curation and employee vouching feed the same bucket (ux-journeys §3.D
self-shrinking list).

### Reactive retro-resolution (the hero M3 moment)

`lot-watch` already recomputes classification reactively over existing
sightings. The new requirement: it must recompute when the **wished**
`affiliatedVehicles` set changes, not only on local registry edits. Because
`affiliatedVehicles` is a `computed()` over the wish result, when Alice saves
her self-claim:

1. `wish(#car)` re-resolves → `claimedCars` gains Alice's car.
2. `affiliatedVehicles` recomputes → her `(plateId, plateState)` enters
   `"ours"`.
3. `classifyPlate` re-runs over all historic sightings of that plate.
4. The four prior sightings flip UNKNOWN/⚠offender → **`"ours"` (Alice)**.
5. Carol's untouched screen updates; the red "possible offender" flag clears
   itself.

This is M3 — reactive emergence across a space boundary, no human in the loop at
the moment of resolution (c-280/c-997 convergent gremlins; c-202 emergence is
amoral, the constraints make the good emergence bloom).

**Matching discipline (carried from `vehicles.ts` + lot-watch):** normalize via
`normalizePlateId` and uppercased 2-letter `plateState`; key on
`(plateId, plateState)`, never plate alone (ux-journeys EF2). If state is
illegible (`""`), stay `"unknown"` rather than risk a wrong auto-resolution
(false-positive avoidance > recall). On a plate that collides with curated
`offender` intel, priority puts `"ours"` first, **but surface a conflict** to
Carol — do not silently overwrite curated intel (ux-journeys EF7).

---

## 6. Discovery via `wish(#car)` and the fan-out open question

### The contract token

```ts
export const CAR_TAG = "car"; // exported once, imported by both sides
wish({ query: "#car", scope: ["profile"] }); // consumer side
// MyCar element: userTags: ["car"]
```

`scope: ["profile"]` **must be explicit** — default wish scope is favorites-only
(`codebase-research.md:197`). Element matching is `userTags`-first (exact,
lowercased, no `#`) then `tag` (`wish.ts:514`). `CAR_TAG` is the single
producer↔consumer contract token; defining it once as an exported constant makes
a typo a compile error rather than the silent EF3 failure ("the most likely
silent failure of the whole composition", ux-journeys EF3).

`#car`, not `#myCar`: the element is _definitionally_ the viewer's (it lives on
their profile, resolved `scope: ["profile"]`), so baking "my" into the tag is
redundant the way `#myProfile` would be next to `#profile`. Consumers read
`wish(#car)` as "find this employee's car." (Optional belt-and-suspenders:
`userTags: ["car", "myCar"]` so both wishes resolve, making EF3 impossible.)

### The fan-out — THE biggest unknown

`scope: ["profile"]` resolves the **current viewer's** profile. The org patterns
need **every** employee's car, not just whoever is looking at the screen
(ux-journeys §7.1). The options:

1. **Coordinator iterates the roster.** Walk the `voucherRegistry` DIDs and
   resolve each employee's `#car` profile element individually (one wish per
   DID, or a wish that accepts a DID set). _Pro:_ expressible on today's
   substrate; the roster we already need for trust doubles as the fan-out set.
   _Con:_ N cross-space resolutions; needs the wish to accept an explicit DID
   scope, and re-resolution as the roster changes.
2. **Org/collaborator-scoped wish (substrate growth).** The profile substrate
   grows an org-scoped wish so an org-space pattern can discover member profile
   elements directly, without enumerating DIDs. _Pro:_ clean, declarative.
   _Con:_ does not exist yet; intersects the spec's open question "should
   profile spaces be readable by all collaborators by default?"
   (`shared-profile-space.md`); has the broadest blast radius on the substrate.

**Recommendation to bring to Berni:** option (1) for v1 — it reuses the
`voucherRegistry` that the trust model already mandates (the same DID set is
both "who may vouch" and "whose profile we fan the wish over"), and it keeps the
trust boundary explicit (only attested employees' profiles are read). Option (2)
is the right _eventual_ shape and should be filed as substrate follow-up. Either
way, name the resolved aggregate `claimedCars`; the choice does not change any
other name in this design.

Trust-boundary note (ux-journeys EF5/PV3): fanning over `voucherRegistry` DIDs
_is_ the org-membership gate — a revoked employee leaves the roster, so their
profile is no longer fanned over and their plate drops out of `"ours"` on the
next recompute.

**Unification with §4 (per `voucher-last-mile-investigation.md`):** once the
trust leaf is a **profile reference** (§4 "Closing the last mile"), one
`memberProfiles: ProfileRef[]` is _simultaneously_ the trust anchor (own owner =
"ours") and the fan-out set (resolve each member's `#car`). One list, two jobs —
the unification this section was reaching for. The fan-out _mechanism_ is still
option (1) (iterate the refs, resolve each profile's `#car`); the org-scoped
wish of option (2) remains deferred substrate work, to be decided together with
`shared-profile-space.md:429` ("profiles readable by collaborators?").

---

## 7. Visibility & the confidentiality reveal handshake (first-class)

This selective-disclosure handshake is a **first-class CFC showcase**, not a
footnote. It is the cleanest demonstration in the whole example of
`Confidential` + `ProjectionOf` + a consent step (c-496: good privacy = you
don't have to think about privacy).

### Asymmetric visibility

Carol (admin) sees a **`ResolvedIdentity`** — a `ProjectionOf` the claim that
exposes only `{ resolvedClaimant (displayName), vehicle }`, **never** the note.
It is _derived_, not stored: the output of the wish-driven match (a resolution),
parallel to the demo's "the plate resolves to that employee." This is where
CFC's `ProjectionOf` / `FilteredFrom` (`api/cfc.ts`, aliases `:199-205`) earn
their place — the admin surface is a projection of the claim, so the note is
structurally absent from what Carol's pattern can read, not merely UI-hidden.

```ts
// admin-visible; the note is not in the projected shape at all
type ResolvedIdentity = ProjectionOf<VehicleClaim, "claimant" | "vehicle">;
// surfaced as { resolvedClaimant: displayName, vehicle }
```

### The private owner note

`ownerNote` (the claim's `note` field) is branded with the canonical CFC
`Confidential<T, X>` (`api/cfc.ts:197`) — not a hand-rolled "secret"/"private"
word. By default it is invisible to Carol.

```ts
note?: Confidential<string, /* admin-excluded audience */>;
```

### The reveal handshake (verb-first trusted streams)

Carol may _request_ a reveal; Alice approves or declines. Modeled as
trusted-handler streams, verb-first like `addElement` / `markVehicle` /
`assignToPerson`:

```ts
requestReveal: Stream<{ claimId: string }>; // Carol asks      (admin action, in org space)
approveReveal: Stream<{ claimId: string }>; // Alice consents  (owner-gated, on her profile)
declineReveal: Stream<{ claimId: string }>; // Alice declines  (owner-gated)
```

The in-between state is a **`RevealRequest`** record — noun for the data, verb
for the actions, matching parking-coordinator's existing
`SpotRequest`/`requestSpot` split:

```ts
interface RevealRequest {
  requestedBy: string; // Carol's DID
  claimId: string;
  status: "pending" | "approved" | "declined";
}
```

`approveReveal` is owner-gated on Alice's side (same trusted-handler binding as
her other owner-protected writes): only she can downgrade her own `Confidential`
note's audience. The reveal is _her_ act, computed by the runtime's trusted
container — Carol never reads the note unless Alice approves (c-097: untrusted
pattern, trusted container produces trusted output). Privacy here is structural,
not a prompt deluge (c-296/c-529).

---

## 8. Deferred granularity ladder (mark the seam)

A `share: ShareLevel` field on the claim, rungs **`"owner"` → `"description"` →
`"plate"`**, each naming the _most_ it reveals:

| rung            | reveals                          | consumer consequence                                            |
| --------------- | -------------------------------- | --------------------------------------------------------------- |
| `"owner"`       | only that an employee owns a car | name shown, no auto-resolution                                  |
| `"description"` | + color/make/model               | "a known employee's car, plate hidden — can't auto-clear" (PV2) |
| `"plate"`       | + plate; full auto-resolution    | the default                                                     |

**Where the control lives:** on the `MyCar` card, immediately after extraction
(ux-journeys J-A step 5 / PV1) — _"Share: ⦿ description + plate / ○ description
only / ○ just that I own a car."_ In this pass it is a **labeled, default-on
(`"plate"`), disabled placeholder** so reviewers see _where_ the consent
decision lives.

**Do NOT design the policy engine.** The rung _names_ and the card _placement_
are in scope; the projection logic that enforces each rung is out of scope.
Conceptually `ShareLevel` is a confidentiality lattice (c-246 redaction;
`Confidential`/`ProjectionOf`) and the field is the future home of a real CFC
projection — naming it `share` keeps the user-facing word warm while the type
can later be `Confidential`-branded. The seam is: a default-on `share` field
today, a `Confidential`-projected policy tomorrow.

---

## 9. Reuse map (concrete)

| Reuse                                                                    | From                                                              | How                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Vehicle` + `normalizeVehicle(s)` / `normalizePlateId` / `formatVehicle` | `packages/patterns/vehicles.ts:5,401,410,426`                     | **Verbatim.** `MyCar` produces this exact shape so plates match across spaces without translation. Never rename `plateId`/`plateState`/`color`/`make`/`model`.                                                                          |
| Owner-integrity skeleton                                                 | `profile-home.tsx:21,131,153,162,243-290`                         | Clone `OwnerProtectedProfileWrite`, the `addClaim`/`removeClaim` trusted handlers (modeled on `addElement`/`removeElement`), `.for(tag)` cell tagging, and `data-ui-pattern`/`data-ui-action` trusted-surface markers for `MyCar`.      |
| Profile-element mechanics                                                | `profile-home.tsx:40`, `wish.ts:485-534`                          | `MyCar` is a `ProfileElement { cell, tag, userTags: ["car"], title: "My Car", source }`, added via `addElement` (never push to `elements`).                                                                                             |
| Photo → `PlateExtraction`                                                | `lot-watch/main.tsx:530-575`                                      | Reuse the `<cf-image-input capture="environment" includeData>` + `generateObject<PlateExtraction>` recipe (system prompt + image/text `prompt` + JSON `schema` + `model: "anthropic:claude-sonnet-4-5"`). Editable result fields (EF1). |
| Classification + matching                                                | `lot-watch/main.tsx:33,277,1055`                                  | Keep `Classification` literals, `classifyPlate` priority (ours>offender>guest>unknown), normalized `(plateId, plateState)` key. Feed `affiliatedVehicles` as `ours`.                                                                    |
| `guestVouches` write idiom                                               | `lot-watch/main.tsx:822` (`assignToPerson`)                       | Same-space write of a structured vehicle record into a `PerSpace` cell — the precedent for authoring `GuestVouch` into the org space.                                                                                                   |
| Admin/role plumbing                                                      | `cfc/admin/mod.ts:10,15,20,31,42`                                 | `EmployeeRoster` reuses `AdminRegistryValue<Role>`, `adminRegistryEntries`, `AddIntegrity` generic over `VoucherRole`.                                                                                                                  |
| CFC confidentiality primitives                                           | `api/cfc.ts:197-205,342`                                          | `Confidential`, `ProjectionOf`/`FilteredFrom` for `ownerNote` + `ResolvedIdentity`; `WriteAuthorizedBy` / `RepresentsCurrentUser` for owner integrity.                                                                                  |
| Image-in-cell gotcha                                                     | `lot-watch/main.tsx:59`; `docs/.../persisting-images-in-cells.md` | Store blob `{url, name}` in durable cells; keep base64 `ImageData` transient in `PerSession`.                                                                                                                                           |

`MyCar` cell scopes (mirroring the existing patterns): `selfClaims` and the
profile element are owner-protected profile fields; the photo capture draft
(`draftImage: ImageData | null`) is `PerSession` (`lot-watch/main.tsx:500`); the
`share` placeholder is a profile field.

---

## 10. CFC-primitive mapping table

Each guarantee → the CFC primitive that delivers it.

| Guarantee                                               | Primitive                                                                                        | Where                                                              |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| Only Alice can mutate her self-claim                    | `represents-principal` atom + `ownerPrincipal === actingPrincipal`                               | `prepare.ts:1070-1112`; `profile-home.tsx:21`                      |
| Self-claim writes come from a trusted surface/handler   | `WriteAuthorizedBy<T, typeof addClaim>`                                                          | `prepare.ts:271,1144`; `profile-home.tsx:276-290`                  |
| Self-claim is bound to Alice's identity                 | `RepresentsCurrentUser`                                                                          | `api/cfc.ts:259`                                                   |
| A `GuestVouch` is attributable to Bob                   | `authored-by` atom (`AuthoredByCurrentUser`)                                                     | `api/cfc.ts:266`; `CURRENT_PRINCIPAL_CLAIM_KINDS` `prepare.ts:107` |
| "Current employee" gate / revocation                    | `VoucherRole = AddIntegrity<…, [VOUCHER_INTEGRITY]>` in `voucherRegistry` (`AdminRegistryValue`) | `cfc/admin/mod.ts:31`; `api/cfc.ts:255`                            |
| Allow decision = provenance check (no roster of plates) | read `represents-principal` / `authored-by` subject, test ∈ `voucherRegistry`                    | `prepare.ts:107`; c-573                                            |
| Owner note hidden from admin                            | `Confidential<string, X>`                                                                        | `api/cfc.ts:197`                                                   |
| Admin sees identity but never the note                  | `ProjectionOf<VehicleClaim, "claimant"\|"vehicle">` → `ResolvedIdentity`                         | `api/cfc.ts:199-205`                                               |
| Reveal is the owner's consented act                     | owner-gated `approveReveal` stream downgrading the `Confidential` audience                       | §7; `profile-home.tsx` trusted-handler model                       |
| Untrusted coordinator computes safely on the claim      | trusted-container execution; coordinator is read-only                                            | c-097; `prepare.ts` enforcement                                    |
| Deferred granularity (future projection)                | `share: ShareLevel` → future `Confidential`-branded projection                                   | §8; c-246                                                          |

---

## 11. Honest caveats

- **Attribution, not prevention.** Vouching does not stop a bad vouch; it
  records _who_ vouched (the `voucher` DID). Scaled trust with accountability,
  not trustlessness (c-757). Be explicit about this in any demo.
- **The trust anchor is a cheat.** `EmployeeRoster` is an owner-signed
  convention, not a real org directory. It is honest about being the "last mile"
  oracle. Its integrity is exactly Dave's diligence.
- **Registration is employee-initiated, fabric-propagated.** The hero flow (J-B
  v1) depends on Alice _choosing_ to author her self-claim after being flagged.
  If she never does, lot-watch correctly stays `"unknown"` — the fabric does not
  invent data (no false positives). Do not pretend registration is automatic.
- **LLM misreads plates.** The editable-fields + human-correct step is
  load-bearing, not decorative (EF1). Owner-corrected (Alice) is high-trust;
  admin-corrected (Carol) is audit-only.
- **Plate collisions / curated-intel conflicts.** Priority puts `"ours"` first,
  but a plate that collides with curated `offender` intel must surface a
  conflict to Carol, not silently overwrite (EF7).
- **Fan-out cost.** Option (1) is N cross-space resolutions; at large N this is
  a real performance question, not yet measured.

---

## 12. Open questions for Berni to sign off before implementation

1. **Wish fan-out (the big one).** Approve **option (1)** (coordinator iterates
   `voucherRegistry` DIDs and resolves each `#car`) for v1, with **option (2)**
   (org-scoped wish) filed as substrate follow-up? Needs the wish to accept an
   explicit DID-set scope — confirm that is in reach (§6).
2. **`voucherRegistry` doubles as the org-membership gate.** Is it acceptable
   that the _same_ DID set governs both "may vouch" and "whose profile we fan
   over"? (It is elegant, but couples two concerns; confirm.)
3. **`ResolvedIdentity` as `ProjectionOf`.** Confirm `ProjectionOf` /
   `FilteredFrom` can express "admin reads `{claimant, vehicle}` but
   structurally cannot read `note`" at the type level today, or whether v1 must
   approximate it (UI-hide the note) and mark the seam.
4. **Reveal handshake placement.** `requestReveal` is an org-space admin action;
   `approveReveal`/`declineReveal` are owner-gated on the profile. Confirm a
   cross-space request → owner-gated approval round-trip is expressible (it is a
   read of a `RevealRequest` the admin authored in-space, plus an owner write on
   the profile — no cross-space write).
5. **Conflict surface for EF7.** In/out of scope for v1? (Recommend a minimal
   "claimed plate collides with curated offender — review" banner.)
6. **Granularity seam confirmation.** Lock rung names `"owner"`/`"description"`/
   `"plate"` and card placement as the _only_ in-scope granularity work; policy
   engine deferred.

**Update (Berni's steer + `voucher-last-mile-investigation.md`):** Q1/Q2 now
have a recommended shape. Replace `voucherRegistry<RawDID>` with
`memberProfiles: ProfileRef[]` and define trust as "author == owner of a member
profile" (the `SameAuthorAs<T, Reference>` alias). v1 enforces it as a **§5
derivation** reusing the already-tested `cf-cfc-authorship` resolve+compare
helper (`:243-307`) — **no new runner primitive required**. Deferred to
substrate follow-up, to be decided together: (i) promoting `SameAuthorAs` to a
real `prepare.ts:1057` write-gate, and (ii) the org-scoped wish / cross-space
profile readability (`shared-profile-space.md:429`). Net: the last mile is no
longer an unknown — it's a small, grounded derivation, with the heavier
substrate options clearly bracketed.

---

## 13. Delegated, time-boxed person-vouching (extension)

An extension to the claim model (§2): an employee can vouch not just for a
specific guest car, but for a **person** — delegating the claim-making
capability one hop. Decided scope: **one hop only** (a vouchee cannot re-vouch)
and every vouch is **time-boxed**.

### Two vouch flavors (both time-boxed)

Generalize `GuestVouch` into a `Vouch` with two kinds, each authored into the
org space by an employee (authored-by the voucher), each carrying a validity
window (absolute timestamps via `safeDateNow()`):

```ts
type Window = { validFrom: number; validUntil: number };

// (a) car-vouch — the friend has no profile; the employee enters/photographs the car.
interface CarVouch extends Window {
  kind: "car";
  voucher: string; // employee DID (authored-by)
  vehicle: Vehicle;
  voucheeName?: Confidential<string> /* admin-excluded */; // voucher-controlled
}

// (b) person-vouch — the friend IS in the fabric and self-claims their own car(s)
//     ("any of their cars"). The employee delegates trust to the friend's DID.
interface PersonVouch extends Window {
  kind: "person";
  voucher: string; // employee DID (authored-by)
  vouchee: string; // friend's DID / profile-ref (NOT their name)
  voucheeName?: Confidential<string> /* admin-excluded */; // voucher-controlled
}
```

The person-vouch is the powerful one (the friend manages their own car(s) on
their own profile, exactly like an employee's self-claim); the car-vouch is the
lightweight fallback for a friend who isn't in the fabric.

### Generalized trust set + allow rule

The trusted-principal set (§4) gains a time-bounded delegation hop:

> **trustedPrincipals(now)** = `{employees}` ∪
> `{ v.vouchee : v is a person-vouch authored by an employee AND now ∈ v.window }`

and the "ours"/allowed derivation (§5) becomes:

> a vehicle is **allowed** iff its `(plateId, plateState)` matches **either** a
> self-claim whose author ∈ `trustedPrincipals(now)` **or** an in-window
> `CarVouch` authored by an employee.

A friend's self-claim is trusted because their DID was vouched by an employee
_for the window_. **One hop is enforced structurally:** only a vouch _authored
by an employee_ grants trust — a vouchee's own vouch isn't employee-authored, so
it grants nothing. This generalizes `trustedAffiliatedVehicles` (provenance.ts)
from "author ∈ employees" to "author ∈ employees ∪ currently-valid vouched
principals."

### Time-boxing — reactive, abuse-bounding, portable

- `now ∈ [validFrom, validUntil]` is part of the allow check; **expiry is
  reactive and free** (revocation's shape, clock-driven) — past the window the
  friend's car silently drops from "allowed."
- It **bounds the "any of their cars, forever" risk** — a vouch is inherently
  scoped to a window ("next Tuesday", "all next week").
- The friend's car is **permanent on their profile**; only _this org's trust_ in
  it is time-boxed. One friend, one car, many orgs each time-boxing their own
  trust via their own employee's vouch — the multi-space weave (c-319).

### Confidentiality — the org trusts _via the employee_, not _via knowing the guest_

The car/plate is **inherently public and required for matching** (it's on a
physical car, lot-watch reads it, auto-resolution needs it), so it cannot
usefully be hidden. The only real privacy lever is the **identity** — the join
"this plate = this named person." By default the org sees _"this plate is
allowed, vouched by Bob, valid `<window>`"_ — enough to let them park and to
follow up with Bob — **without the friend's identity.**

- **Name is voucher-controlled (decided):** `voucheeName` is an optional
  `Confidential` field the **voucher** (Bob) fills or reveals — not the friend.
  Matches the social reality (the org's relationship is with its employee; Bob
  mediates) and is low-friction. The friend's full profile identity is separate
  and never auto-exposed.
- **The reveal handshake (§7) generalizes by approver:** for a self-claim's
  `ownerNote` the approver is the **owner**; for a vouch's `voucheeName` the
  approver is the **voucher** (Bob). Carol can `requestReveal`; Bob approves /
  declines. Same machinery, different consenting party.

Principle: **scaled trust through a known party** (c-757) — the org extends
trust to a stranger via Bob, attributably and time-boxed, without surveilling
the stranger (c-689 "not creepy"; c-573 "policies on data").

### Personas & status

Bob (employee) vouches for his friend **Erin** (the vouchee); Erin self-claims
her car on her own profile, and Bob optionally attaches "Erin" to the vouch.
(The design conversation used "Gideon" informally for Bob's role.)

Design-only extension, deferred with the rest until CT-1658 + the
ESM/`SameAuthorAs` substrate land. It changes no earlier decision except the
`trustedAffiliatedVehicles` generalization above, and it **expands scope beyond
"employees only"** — a person-vouched friend has a profile and self-claims.

---

_Names used here are the ratified vocabulary from `naming-proposals.md`
("Recommended vocabulary at a glance"). Where this doc and `ux-journeys.md`
differ on the hero's name, **Alice** is canonical (ux-journeys' "Dana" is a
stale draft)._
