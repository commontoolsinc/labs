# Naming Proposals — "My Car(s)" × Parking, a CFC worked example

Vocabulary workshop for the design in `DESIGN-BRIEF.md`. **No code** — naming
only. Every proposal is pressure-tested against the existing repo conventions
documented in `codebase-research.md` and read directly from source:
`vehicles.ts`, `profile-home.tsx`, `lot-watch/main.tsx`,
`parking-coordinator/main.tsx`, `cfc/admin/mod.ts`, `wish.ts`, `api/cfc.ts`,
`docs/common/conventions/wish.md`, `docs/specs/shared-profile-space.md`.

**Hard constraints from the codebase (do not violate):**

- `Vehicle` + `normalizeVehicle(s)` / `normalizePlateId` / `formatVehicle` from
  `vehicles.ts` are **reused verbatim**. Field names are `plateId`,
  `plateState`, `color`, `make`, `model`. We never rename these.
- Profile elements are `{ cell, tag, userTags, title?, source? }`; discovery
  matches `userTags` first (exact, lowercased, no `#`), then `tag`. Added via
  the `addElement` stream. (`profile-home.tsx`, `wish.ts` L514.)
- Existing classification vocabulary in `lot-watch` is the enum
  `Classification = "ours" | "guest" | "offender" | "unknown"`, and the registry
  type `KnownVehicle { category: "guest" | "offender" }`. The "ours" set is
  derived, not stored.
- Owner integrity uses `RepresentsCurrentUser` / `WriteAuthorizedBy` with
  trusted handlers as the binding (`profile-home.tsx`).
- Admin/role plumbing follows the `cfc/admin/mod.ts` generics:
  `*AdminRoleAssignment`, `*AdminRole = AddIntegrity<…, [INTEGRITY]>`,
  `*AdminRegistryValue`, `*_ADMIN_INTEGRITY = "kebab-admin"`.
- Persona names: **Alice, Bob, Carol, Dave**. Never "Gideon".

A naming north-star for the explainer: the design's thesis is **"the org does
not trust a car; it trusts a claim made by someone trusted to make it."** The
vocabulary should keep the word _claim_ central and visible, because that is the
conceptual payload.

---

## 1. The employee-owned pattern + its discovery tag

The pattern an employee instantiates on their own profile (working title "My
Car(s)").

|                               |                                                                                |
| ----------------------------- | ------------------------------------------------------------------------------ |
| **Recommended pattern name**  | `MyCar` (file `my-car/main.tsx`, exported pattern `MyCar`, `[NAME]: "My Car"`) |
| **Profile-element title**     | `"My Car"`                                                                     |
| **Recommended discovery tag** | `userTags: ["car"]` → wished as **`#car`**                                     |
| **Alternatives (pattern)**    | (1) `MyCars` / "My Cars"; (2) `CarProfile`; (3) `VehicleProfile`               |
| **Alternatives (tag)**        | (1) `#myCar`; (2) `#vehicle`; (3) `#myVehicle`                                 |

**Why `MyCar` (singular pattern name, plural-capable inside):** The user's
mental model (ux-journeys §1.A) is "_this is my car, attached to me_" — singular
and possessive. The brief and journeys both write the product as **"My Car(s)"**
where the parens signal "internally a list." Mirror that: a singular, human-warm
pattern name (`MyCar`, like the existing `ProfileHome` is singular even though
it holds many elements), holding `vehicles: Vehicle[]` (plural data, matching
`Person.vehicles` and `normalizeVehicles`). Naming the pattern `MyCars` would
clash awkwardly with the singular `Vehicle` shape and read oddly as a type.

**Why the tag is `#car`, NOT `#myCar`:** This is the load-bearing tag decision.
Wish discovery matches on `userTags` lowercased with no `#`, and tags are a
_shared contract between producer and consumer_ (ux-journeys EF3 flags a tag
typo as "the most likely silent failure of the whole composition"). Three
reasons to prefer the bare noun `#car`:

1. **`userTags` already carries the possessive.** The element lives on the
   owner's profile and is resolved `scope: ["profile"]` — it is _definitionally_
   "the viewer's." Baking "my" into the tag is redundant the way `#myProfile`
   would be redundant next to the existing `#profile`. The well-known profile
   targets are `#profile` / `#profileName`, not `#myProfile` — follow that
   grain.
2. **Consumers read more naturally.**
   `wish({ query: "#car", scope: ["profile"]
   })` from the parking space reads
   as "find this employee's car," not "find this employee's _my-car_," which is
   grammatically broken from the consumer's vantage.
3. **Collision risk is low and acceptable.** `#car` is a profile-scoped userTag,
   not a global favorite; it only collides within one user's own profile element
   list, where one car pattern is expected. `#vehicle` is more collision-proof
   but colder and breaks the human "car" framing the whole demo leans on.

Keep the brief's `#myCar` only as a fallback if user-research shows people
expect the possessive in the tag; if so, set it as a **second** entry in
`userTags` (`["car", "myCar"]`) so both wishes resolve and EF3 is impossible.
**Recommendation: lock `userTags: ["car"]`, wished as `#car`.** Plural `#cars`
is rejected — wish matching is per-tag exact, and a single profile element holds
the whole list, so the tag names the _kind_ (car), not the cardinality.

---

## 2. The core claim record type + fields

The thing that is `{ claimant, Vehicle, claimType, ... }`.

|                                          |                                                                          |
| ---------------------------------------- | ------------------------------------------------------------------------ |
| **Recommended type name**                | `VehicleClaim`                                                           |
| **Recommended `claimType` field + enum** | `claimType: "self" \| "guest"`                                           |
| **Alternatives (type)**                  | (1) `CarClaim`; (2) `Claim`; (3) `VehicleVouch` / `Vouch`                |
| **Alternatives (frame)**                 | "vouch" / "attestation" / "affiliation" / "endorsement" / "registration" |

**Why "claim" over the alternatives:** The brief _names its own spine_ "the
spine: attributable claims" and repeats "claim" ~20×; the explainer thesis is
literally "trust travels with the claim." Naming the type anything but `*Claim`
would fight the document. Against the specific contenders:

- **vouch / vouchsafe** — too narrow: a vouch is inherently _about someone else_
  ("I vouch for X"). It fits the guest leg perfectly but is semantically wrong
  for a _self_-claim ("I vouch for my own car" is odd). Reserve "vouch" for the
  human verb of the guest leg only (see §3).
- **attestation** — reserve this for the _trust anchor_ (the lot-owner's signed
  list of employees, §5), which is a true attestation in the CFC/crypto sense.
  Using it for both blurs two distinct trust artifacts.
- **affiliation / endorsement / registration** — "registration" reintroduces the
  admin-roster mental model the design exists to _kill_ ("no admin-maintained
  roster"); "affiliation" is good as a _predicate adjective_ for the org-side
  set (§4) but weak as a record noun; "endorsement" is marketing-flavored.

**Why one type + a `claimType` enum, NOT two types:** The brief is explicit —
"Two claim types, one primitive" and
"`{ claimant DID, Vehicle, claimType: self
| guest, ... }`." One discriminated
type keeps the _spine_ literally true in the code, lets classification and
provenance checks treat both legs uniformly, and mirrors `lot-watch`'s own
precedent of a single `category: "guest" | "offender"` discriminator on
`KnownVehicle`. The enum values `"self" | "guest"` come straight from the brief
— keep them; they are short, lowercase, and parallel the existing
`Classification` literals.

**Recommended shape** (TS-ish; `claimant` is a DID, not free-text — this is the
whole point vs. the demo-only `selectedPersonName`/`reporterName`):

```ts
export interface VehicleClaim {
  claimant: string; // DID of the claimant (represents-principal subject)
  vehicle: Vehicle; // REUSED verbatim from vehicles.ts
  claimType: "self" | "guest"; // self = my own car; guest = a legit guest's car
  claimedAt: number; // safeDateNow() — matches lot-watch's capturedAt
  note?: ConfidentialOwnerNote; // private owner note, admin-invisible by default (§7)
  share?: ShareLevel; // granularity rung, default-on placeholder (§8)
}
```

Field-name rationale (harmonized with existing code):

- **`claimant`** not `owner`/`author` — "owner" is overloaded by the CFC
  `ownerPrincipal` machinery; "claimant" is unambiguous and ties to "claim."
- **`vehicle`** (lowercase field) holding the `Vehicle` type — exactly mirrors
  `Person.vehicles` / `Sighting` carrying vehicle fields. Singular here because
  one claim is about one car; the _pattern_ holds many claims.
- **`claimedAt: number`** — matches `Sighting.capturedAt: number` and the
  `safeDateNow()` convention already imported in `lot-watch`. Avoid `timestamp`
  (generic) and `validFrom/validTo` (implies an expiry policy that's out of
  scope — the brief defers validity; revocation is "drop the claim," not an
  expiry field).
- No `source` field on the claim itself — provenance (`authored-by` /
  `represents-principal`) is carried by CFC integrity atoms, not a duplicated
  data field (the brief: "the allow decision is a provenance check").

---

## 3. The guest-vouch as authored into the org space

The guest leg, written **into the org/parking space** (authored-by = voucher),
mirroring `lot-watch`'s `assignToPerson` precedent.

|                                    |                                                                          |
| ---------------------------------- | ------------------------------------------------------------------------ |
| **Recommended type name**          | `GuestVouch` (a space-local record)                                      |
| **Recommended cell name**          | `guestVouches: PerSpace<GuestVouchesCell>`                               |
| **Relationship to `KnownVehicle`** | **Stay distinct; let it feed/derive the same `"guest"` classification**  |
| **Alternatives (type)**            | (1) `GuestClaim`; (2) `VouchedGuest`; (3) extend `KnownVehicle` directly |
| **Alternatives (cell)**            | (1) `vouches`; (2) `guestClaims`; (3) `vouchedVehicles`                  |

**Why `GuestVouch` (vouch, here, deliberately):** This is the one place "vouch"
is exactly right — an employee asserts something _about someone else's_ car ("I,
Bob, vouch this guest is legit"). Naming it `GuestVouch` makes the human verb on
the card honest ("**Vouch** for a guest's car") and visibly distinguishes it
from the _self_-claim, even though both are `VehicleClaim`s under the hood. The
relationship to §2: `GuestVouch` is the **authored-into-space representation**
of a `VehicleClaim` whose `claimType === "guest"` — same conceptual primitive,
different storage location and provenance (authored-by the voucher, not
represents-principal the claimant).

**Why stay distinct from `KnownVehicle`, not unify:**

- `KnownVehicle` has a fundamentally different trust model. Its `category` is
  set by an **admin** curation action (`markVehicle`, admin-gated), and its
  `"offender"` arm is explicitly _adversarial_ intel. A `GuestVouch` is authored
  by **any employee** and is _attributable_ ("we know who vouched"). Collapsing
  them would lose the attribution that is the brief's entire honest caveat
  ("attribution, not prevention").
- But they should **converge at the classification layer**: a plate matched by a
  `GuestVouch` resolves to the existing `"guest"` `Classification`, exactly as a
  `KnownVehicle{category:"guest"}` does today. So the _output_ unifies (one blue
  "guest" chip) while the _provenance_ stays distinct. Concretely, the org-side
  "guest" set becomes `knownVehicles(guest) ∪ guestVouches` — admin curation and
  employee vouching feeding the same bucket from two directions (the ux-journeys
  §3.D "self-shrinking list" property).
- Keep `GuestVouch` carrying a `voucher` DID field that `KnownVehicle` lacks —
  this is the new value. Suggested shape:

```ts
export interface GuestVouch {
  voucher: string; // DID of the employee who vouched (authored-by)
  vehicle: Vehicle; // REUSED from vehicles.ts
  vouchedAt: number; // safeDateNow()
  guestName?: string; // optional display name, mirrors KnownVehicle.name
  note?: string; // why this guest is here, e.g. "interviewing Tue AM"
}
```

---

## 4. The org-side "allowed set" the claims feed

`lot-watch` currently calls this the **"ours"** set
(`Classification = "ours" | …`, derived from `people[].vehicles`).

|                  |                                                                                                                              |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **Recommended**  | **Keep `"ours"`** as the `Classification` literal; introduce `affiliatedVehicles` as the _name of the derivation_ feeding it |
| **Alternatives** | (1) rename literal to `"affiliated"`; (2) `"vouched"`; (3) `"knownGood"`                                                     |

**Why keep `"ours"`:** It is already shipped vocabulary in `lot-watch`'s
`Classification` enum, its color map (`#166534` green for `"ours"`), its
`classifyPlate` priority comment ("ours > offender > guest > unknown"), and its
tests. Renaming the literal is a breaking, cross-pattern churn for a _worked
example_ whose job is to compose **with** these patterns, not refactor them.
`"ours"` also reads beautifully on the admin's screen — "that's **ours**" is the
exact phrase the demo wants (ux-journeys M2).

**But name the _feed_ precisely.** Today `ours` is derived only from
`people[].vehicles`. This design adds a second, richer source: self-claims via
the `#car` wish. Name that derived input set **`affiliatedVehicles`** (or the
function `affiliatedPlates(claims)`): the set of `Vehicle`s whose claim was
authored by a current employee. "Affiliated" is precise (the self-claim says
"this car is _affiliated with me_" — the brief's exact word, §"Two claim types")
and avoids "vouched" (which is the _guest_ leg, §3) and "knownGood" (which
sounds like a curated allowlist, the very thing we're replacing). So:
`ours = affiliatedVehicles ∪ people[].vehicles` → drives the `"ours"`
classification. The user-facing word stays "ours"; the internal derivation is
"affiliated."

---

## 5. The trust-anchor concept (current-employee attestation)

The lot-owner's signed attestation that certain DIDs are current
employees/vouchers. Harmonize with `cfc/admin/mod.ts` vocabulary.

|                                  |                                                                                     |
| -------------------------------- | ----------------------------------------------------------------------------------- |
| **Recommended attestation type** | `EmployeeRoster` (the signed set) with entries `EmployeeAttestation`                |
| **Recommended role name**        | **`voucher`** (the capability), with `employee` as the human label                  |
| **Recommended registry/cell**    | `voucherRegistry: PerSpace<VoucherRegistryCell>`, modeled on `*AdminRegistry`       |
| **Integrity tag**                | `VOUCHER_INTEGRITY = "voucher"` (parallels `"parking-admin"` / `"lot-watch-admin"`) |
| **Alternatives (role)**          | (1) `member`; (2) `affiliate`; (3) `employee` (as the role too)                     |
| **Alternatives (type)**          | (1) `EmployeeList`; (2) `MembershipAttestation`; (3) `CurrentEmployees`             |

**Why split "the human noun" (employee) from "the capability noun" (voucher):**
The brief's anchor attests "these DIDs are current employees," and the
_capability_ it grants is "may author claims that count as ours / may vouch for
guests." The codebase models capabilities as **roles with an integrity tag**
(`ParkingAdminRole`, `LotWatchAdminRole`). Mirror that exactly: the
role/capability is **`voucher`** (the thing the DID is _permitted to do_), the
display label is **`employee`** (who they _are_). This parallels how
`AdminRoleAssignment` carries a `displayName` separate from the role's
integrity.

- **role = `voucher`** beats `member`/`affiliate` because it names the _power_
  (this DID's claims count), which is what the provenance check actually tests,
  and it ties cleanly to §3's `GuestVouch`. `member`/`affiliate` are vaguer
  about _what they may do_.
- This also lets revocation read exactly as the brief describes: "drop a DID
  from the `voucherRegistry` → all their claims (self + guest) silently stop
  counting as ours."

**Why `EmployeeRoster` for the attestation type, modeled on the admin
registry:** The admin module already gives us `AdminRegistryValue<Role>` =
`{ admins?: Role[]; everyoneIsAdmin?: boolean }`. Define the trust anchor as the
_same shape generic over a voucher role_, so it reuses `adminRegistryEntries`
and friends. The attestation is the lot-owner-signed registry value; the
human-facing name is "the employee roster." Reserve **`attestation`** vocabulary
(the field `attestedBy`, type `EmployeeAttestation`) for the signed nature of it
— this is the one place "attestation" is literally correct (a signed list),
which is why we kept it _out_ of §2's claim naming. Recommended shapes:

```ts
export const VOUCHER_INTEGRITY = "voucher" as const;

// One attested employee, parallel to AdminRoleAssignment
export interface EmployeeAttestation {
  subject: string; // DID attested as a current employee
  displayName: string; // "Alice", "Bob" — mirrors AdminRoleAssignment.displayName
}
export type VoucherRole = AddIntegrity<
  EmployeeAttestation,
  readonly [typeof VOUCHER_INTEGRITY]
>;

// The signed set, reusing the admin-registry shape generic over VoucherRole
export type VoucherRegistryValue = AdminRegistryValue<VoucherRole>;
export type VoucherRegistryCell = Writable<VoucherRegistryValue>;
```

(If a single human-facing noun is wanted for the _whole_ signed list in the
explainer, call it the **"employee roster"** — but note it is owner-attested,
not admin-maintained; that distinction is the design's pride.)

---

## 6. The wish(es) the org-space patterns issue

The query the parking-coordinator / lot-watch issue to discover self-claims.

|                                                    |                                                  |
| -------------------------------------------------- | ------------------------------------------------ |
| **Recommended query + scope**                      | `wish({ query: "#car", scope: ["profile"] })`    |
| **Recommended internal name for the resolved set** | `claimedCars` (→ feeds `affiliatedVehicles`, §4) |
| **Alternatives (query)**                           | (1) `#myCar`; (2) `#vehicle`; (3) `#carClaim`    |

**Why `#car` / `scope: ["profile"]`:** This is the §1 tag decision, viewed from
the consumer. The scope **must be explicit** `["profile"]` (default wish scope
is favorites-only — ux-journeys gotcha). `#car` is the single canonical
producer↔consumer contract token that EF3 demands be "shared in code between
producer and consumer"; define it **once** as an exported constant
(`export const CAR_TAG = "car";`) imported by both `MyCar` and the org-space
patterns, so a typo is a compile error, not a silent mismatch.

**The fan-out caveat (open question 7.1 in ux-journeys) is naming-relevant:**
`scope: ["profile"]` resolves the _current viewer's_ profile, but the org
patterns need _all_ employees'. Whatever the substrate answer (iterate the
`voucherRegistry` DIDs and resolve each, or a future org-scoped wish), name the
resolved aggregate **`claimedCars`** (the list of `VehicleClaim`s discovered via
the wish), distinct from `affiliatedVehicles` (the deduped `Vehicle` set that
actually drives classification). Two names because they are two stages: discover
claims → derive the allow-set.

---

## 7. Admin-visible identity surface vs. private owner note + reveal handshake

|                                            |                                                                                        |
| ------------------------------------------ | -------------------------------------------------------------------------------------- |
| **Recommended admin-visible surface**      | `ResolvedIdentity` (field: `resolvedClaimant`)                                         |
| **Recommended private note**               | `ownerNote`, typed `Confidential<string, …>`                                           |
| **Recommended confidentiality field name** | `note` on the claim, branded `Confidential`                                            |
| **Recommended reveal-handshake actions**   | `requestReveal` / `approveReveal` (streams), with `declineReveal`                      |
| **Alternatives (surface)**                 | (1) `MatchedIdentity`; (2) `ClaimAttribution`; (3) `IdentityChip`                      |
| **Alternatives (handshake)**               | (1) `askToReveal` / `grantReveal`; (2) `revealRequest` / `revealApprove`; (3) `unseal` |

**Admin-visible resolved identity — `ResolvedIdentity` / `resolvedClaimant`:**
The brief says the admin "sees the resolved identity — 'this is Alice's car'."
"Resolved" is the right word because it's the _output of the wish-driven match_
(a resolution), and it parallels the demo's "the plate **resolves** to that
employee" language (ux-journeys §0). It is **not** a stored roster entry — name
it as a derived/projected value, e.g. a `ProjectionOf` / `FilteredFrom` of the
claim that exposes only `{ claimant displayName, vehicle }` to the admin, never
the private note. This is where CFC's `ProjectionOf`/`FilteredFrom` (from
`api/cfc.ts`) earn their place: the admin surface is a _projection_ of the
claim.

**Private owner note — `ownerNote: Confidential<…>`:** The brief: "a private
note … NOT visible to the admin by default … maps to CFC `Confidential` + a
consent step." Name the field `ownerNote` (or just `note` on the claim, §2) and
brand it with the existing `Confidential<T, X>` type from `api/cfc.ts` — that is
the literal, in-codebase confidentiality primitive. Don't invent a new word like
"secret" or "private" when `Confidential` is the canonical CFC term enumerated
in `cfc.ts` L197.

**Reveal handshake — `requestReveal` / `approveReveal`:** Model these as the two
trusted-handler streams that drive the consent step, naming them as verb-first
stream events exactly like `addElement` / `setName` / `assignToPerson`:

```ts
requestReveal: Stream<{ claimId: string }>; // admin asks
approveReveal: Stream<{ claimId: string }>; // claimant consents (owner-gated)
declineReveal: Stream<{ claimId: string }>; // claimant declines
```

`requestReveal`/`approveReveal` beats `unseal` (too crypto-jargon for the demo
narrative) and beats `revealRequest`/`revealApprove` (noun-first reads worse as
a handler name; the codebase handlers are verb-first: `addElement`,
`markVehicle`, `assignToPerson`). The state in between is a `RevealRequest`
record (`{ requestedBy, claimId, status: "pending" | "approved" | "declined" }`)
— noun form for the _data_, verb form for the _actions_, matching the
`SpotRequest`/`requestSpot` split already in parking-coordinator.

---

## 8. The granularity ladder rungs (deferred policy)

Three levels; mark the seam, don't build the policy engine.

|                            |                                                                                                                         |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| **Recommended field**      | `share: ShareLevel` on the claim, default `"plate"`                                                                     |
| **Recommended rung names** | `"owner"` → `"description"` → `"plate"`                                                                                 |
| **Alternatives (field)**   | (1) `broadcastLevel`; (2) `visibility`; (3) `granularity`                                                               |
| **Alternatives (rungs)**   | (1) `"presence"`/`"details"`/`"full"`; (2) `"minimal"`/`"description"`/`"plate"`; (3) `"own"`/`"describe"`/`"identify"` |

**Why `share: ShareLevel` with rungs `"owner" | "description" | "plate"`:** The
ux-journeys (§5 PV1, J-A step 5) already verbalize the control as _"Share: ⦿
description + plate / ○ description only / ○ just that I own a car"_ and §6
names the field placeholder a **`share` enum**. Honor that. The three rung
literals are **cumulative and self-describing** — each names the _most_ it
reveals:

- `"owner"` — reveals only _that an employee owns a car_ (no description, no
  plate). Matches the journeys' "just that I own a car" and the brief's
  "owner-only" rung. (Named for _what is shared_ = the owner's existence.)
- `"description"` — adds the human description (color/make/model) but withholds
  the plate. Matches "description only." Consumer consequence is legible (PV2):
  "a known employee's car, plate hidden — can't auto-clear."
- `"plate"` — adds the plate; full auto-resolution works. The default (brief +
  journeys: "defaults to description + plate").

`share` beats `broadcastLevel`/`visibility`/`granularity` because the user verb
on the card is literally "**Share**," and the journeys use "share" and
"broadcast" interchangeably but settle on a `share` enum. The rung literals beat
`presence/details/full` (too abstract) and `minimal/maximal` (doesn't say
_what_) because they name the _new field unlocked at each rung_, which is
exactly the information a reviewer needs to see the seam. **The control is a
labeled, default-on, disabled placeholder** in this pass (PV1) — the _name_ is
in scope, the policy engine is not. Conceptually `ShareLevel` is a
confidentiality lattice (cardweb c-246 redaction; `Confidential`/`ProjectionOf`
in `cfc.ts`), so the field is the future home of a real CFC projection — naming
it `share` keeps the user-facing word warm while the type can later be
`Confidential`-branded.

---

## 9. Personas

Confirming roles against the brief ("Alice, Bob, Carol, Dave. Avoid Gideon").

| Persona   | Role                                                                                 | Rationale                                                                                                                                                             |
| --------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Alice** | **Employee / car-owner** (primary, the hero of J-A & J-B)                            | First name = primary actor; she authors the **self-claim** ("Alice's car"). The brief's running example is "this is Alice's car."                                     |
| **Bob**   | **Employee / voucher** (authors a **guest-vouch**)                                   | Second employee; in J-D he's the one who **vouches** for a guest's car — exercises the §3 `GuestVouch` leg without being the admin.                                   |
| **Carol** | **Parking admin / coordinator operator**                                             | The admin who sees the **`ResolvedIdentity`** surface (§7) and curates the long-tail unknowns (ux-journeys §1.B). Admin ≠ owner of trust, so she is _not_ persona #4. |
| **Dave**  | **Lot-owner / company-owner** (the trust anchor)                                     | Signs the **`EmployeeRoster`** attestation (§5) naming which DIDs are vouchers. Distinct from Carol: Dave attests _who is an employee_; Carol _operates the lot_.     |
| _(Guest)_ | The vouched-for visitor — unnamed, or **"Erin the guest"** if a fifth name is needed | The guest is the _subject_ of Bob's vouch, not an actor with a profile in v1; naming optional.                                                                        |

Note: ux-journeys uses "Dana" as the hero employee in J-B. **Recommend
standardizing on "Alice" per the brief's locked persona list** and treating
"Dana" as a stale draft name to be reconciled. (Flagging, not changing — this is
a naming proposal.)

---

## Recommended vocabulary at a glance (ratification cheat-sheet)

| Concept                                | Recommended name                                                                | Kind           |
| -------------------------------------- | ------------------------------------------------------------------------------- | -------------- |
| Employee-owned pattern                 | **`MyCar`** (`[NAME]: "My Car"`)                                                | pattern        |
| Profile-element title                  | **"My Car"**                                                                    | UI string      |
| Discovery tag (userTag)                | **`car`** → wished `#car`; exported `CAR_TAG = "car"`                           | tag            |
| Core claim type                        | **`VehicleClaim`** `{ claimant, vehicle, claimType, claimedAt, note?, share? }` | type           |
| Claim discriminator                    | **`claimType: "self" \| "guest"`**                                              | enum           |
| Claim timestamp                        | **`claimedAt: number`** (`safeDateNow()`)                                       | field          |
| Guest leg (org-space record)           | **`GuestVouch`** `{ voucher, vehicle, vouchedAt, guestName?, note? }`           | type           |
| Guest-vouch cell                       | **`guestVouches: PerSpace<GuestVouchesCell>`**                                  | cell           |
| Vouch vs `KnownVehicle`                | **distinct provenance, converge at `"guest"` classification**                   | decision       |
| Org allow-set (classification literal) | **`"ours"`** (keep — unchanged from lot-watch)                                  | enum literal   |
| Derivation feeding "ours"              | **`affiliatedVehicles`** = `claimedCars` ∪ `people[].vehicles`                  | derived set    |
| Discovery wish                         | **`wish({ query: "#car", scope: ["profile"] })`**                               | wish           |
| Resolved claims (pre-dedup)            | **`claimedCars`**                                                               | derived set    |
| Trust-anchor role / capability         | **`voucher`** (`VOUCHER_INTEGRITY = "voucher"`)                                 | role           |
| Trust-anchor human label               | **`employee`** (`displayName`)                                                  | label          |
| Trust-anchor attestation entry         | **`EmployeeAttestation`** `{ subject, displayName }`                            | type           |
| Trust-anchor role type                 | **`VoucherRole = AddIntegrity<EmployeeAttestation, [VOUCHER_INTEGRITY]>`**      | type           |
| Trust-anchor registry                  | **`voucherRegistry: PerSpace<VoucherRegistryCell>`** (admin-registry-shaped)    | cell           |
| Trust-anchor human name                | **"employee roster"** (owner-attested)                                          | UI string      |
| Admin-visible identity                 | **`ResolvedIdentity`** / field `resolvedClaimant` (a `ProjectionOf` claim)      | projection     |
| Private owner note                     | **`ownerNote`** / `note`, branded **`Confidential<…>`**                         | field          |
| Reveal request action                  | **`requestReveal`** `Stream<{ claimId }>`                                       | handler/stream |
| Reveal approve action                  | **`approveReveal`** `Stream<{ claimId }>` (owner-gated)                         | handler/stream |
| Reveal decline action                  | **`declineReveal`** `Stream<{ claimId }>`                                       | handler/stream |
| Reveal state record                    | **`RevealRequest`** `{ requestedBy, claimId, status }`                          | type           |
| Granularity field                      | **`share: ShareLevel`** (default `"plate"`)                                     | field          |
| Granularity rungs                      | **`"owner"` → `"description"` → `"plate"`**                                     | enum           |
| Persona — employee/self-claimant       | **Alice**                                                                       | persona        |
| Persona — employee/voucher             | **Bob**                                                                         | persona        |
| Persona — parking admin                | **Carol**                                                                       | persona        |
| Persona — lot-owner / trust anchor     | **Dave**                                                                        | persona        |
| Persona — guest (optional)             | _(unnamed)_ / "Erin"                                                            | persona        |

**One-line contract to lock first (highest blast radius if wrong):**
`export const CAR_TAG = "car"` + the `Vehicle` shape = the producer↔consumer
contract (ux-journeys §7.4, EF3). Everything else can evolve; this token cannot
drift between `MyCar` and the org-space consumers.
