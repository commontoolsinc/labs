# My Car(s) — UX Flows & User Journeys

**Status:** Design phase. No code. Scenario-driven UX document.
**Scope:** Employees only, single organization, one shared parking-coordinator /
lot-watch org space fed by many employee profile spaces.
**Related:**
`packages/patterns/factory-outputs/parking-coordinator/main.tsx` (canonical
`Person`/`Vehicle` model, classification consumer),
`packages/patterns/factory-outputs/lot-watch/DESIGN.md` (sighting capture,
LLM plate extraction, classification),
`docs/specs/shared-profile-space.md` (profile substrate, `wish()` profile scope),
`docs/common/conventions/wish.md` (wish result shape & scopes).

---

## 0. The one-paragraph pitch

An employee instantiates a **"My Car(s)"** pattern *on their own profile*. They
take one photo of their car; the fabric extracts the description and plate and
stores it as a profile element. They never touch the parking system. Meanwhile
the org's **parking-coordinator** has *wished* for employee car details. The
moment the employee's car becomes a profile element, the coordinator's "ours"
registry gains that plate — **with zero data entry on the admin side**. When an
employee's car later shows up in a lot-watch sighting flagged as a possible
repeat offender, the plate resolves to *that employee* automatically. The room
goes "ohhh — that's Dana's car." Nobody typed Dana's plate into the parking app.
That cross-space, wish-driven resolution is the whole demo.

Why this is hard the old way: the parking admin would have to collect everyone's
plate by email, type it in, keep it current when someone buys a new car, and
re-do it per tool (coordinator *and* lot-watch). Here the employee owns the data
once, on their profile, and every org tool that wishes for it stays in sync.

---

## 1. Actor inventory

### A. Employee / car-owner (primary)
- **Who:** Any employee at the org. Owns one shared profile space (per
  `shared-profile-space.md`). May own 0, 1, or several cars.
- **Goal:** "Make my car known to the building's parking tools so I'm not
  mistaken for an intruder — without manually registering in every tool, and
  without re-typing when I get a new car."
- **Mental model:** *"This is my car, attached to me."* They think of the car as
  a fact about themselves, not as a row in the parking admin's spreadsheet. They
  expect that once they say "this is my car," anything in the org that cares
  about cars just knows. They do **not** think in terms of spaces, DIDs, or
  wishes.
- **Secondary mental-model risk:** they may worry "who can see my plate?" — this
  is where the (future) granularity control surfaces (§5).

### B. Parking admin / coordinator operator
- **Who:** The 1–2 people running the parking-coordinator and lot-watch in the
  shared org space. May themselves be employees with their own profiles.
- **Goal:** "Know whose car is whose with as little manual roster maintenance as
  possible. When a car is flagged in a spot, tell me instantly if it's one of
  ours."
- **Mental model:** *"My tools have a roster of known cars; I curate the
  *unknowns*, not the *knowns*."* The admin expects the "ours" set to populate
  itself from employees and to stay current. The admin's real job is the
  long-tail: guests and genuine offenders that no employee will ever register.
- **Authority:** Curation (mark guest/offender, merge, delete) is admin-gated
  via the CFC admin registry. **Reading** an employee's broadcast car details is
  *not* an admin action — it is the employee's profile broadcast meeting the
  coordinator's wish.

### C. (Implicit) The fabric itself
Not a person, but worth naming as an actor in journeys because its reactive
behavior is the protagonist of the hero flow: it resolves wishes across spaces,
propagates profile changes, and re-runs classification — *with no human in the
loop at the moment of resolution.*

---

## 2. Starting-state matrix

Each row is a meaningful state a user can arrive in. "Wants to accomplish" is
the dominant goal from that state.

| # | Actor | Starting state | What they want | Primary journey |
|---|-------|----------------|----------------|-----------------|
| S1 | Employee | New employee, **no profile yet** | Get set up enough to register a car | Bootstrap profile (§3.0) → then J-A |
| S2 | Employee | Has a profile, **no car registered** | Register their car, ideally by photo | **J-A** (register via photo) |
| S3 | Employee | Car registered, **fully shared** (description + plate) | Confirm it's broadcasting; maybe add a 2nd car | Verify/extend (§3.5) |
| S4 | Employee | Car registered, **plate withheld** (description only) | Decide whether to reveal plate; understand consequences | Granularity (FUTURE, §5) |
| S5 | Employee | **Currently flagged** as a possible offender (their own car) | Prove "that's me, I belong here" fast | **J-B** (hero auto-resolution) |
| S6 | Employee | Got a **new car**; old one still registered | Replace/add without re-entering everything | Update car (§3.6) |
| S7 | Admin | Reviewing the **lot today**; just documented a car in a spot | Have it auto-match a known employee | **J-C** (document → auto-match) |
| S8 | Admin | Reviewing **still-unmatched plates** | Triage unknowns; decide guest vs offender vs "nudge an employee" | **J-D** (unmatched review) |
| S9 | Admin | A formerly-unknown plate **just became known** (employee registered after the fact) | See historic sightings retro-resolve | Emerges inside J-B / J-D |
| S10 | Employee | Profile exists but **car broadcast was never picked up** by the coordinator (wish mismatch / tag typo) | Understand why their car isn't "ours" | Failure case (§5) |

The interesting demo states are **S2, S5, S7, S8**. The hero is **S5 → J-B**.

---

## 3. Key journeys

Notation: **[U]** = what the user sees/does. **[F]** = what the fabric does
reactively, often across spaces.

### 3.0 Bootstrap (precondition for S1) — abbreviated

[U] New employee opens any org space; a profile-name input appears (the
`wish({ query: "#profile" })[UI]` missing-profile surface).
[U] Types their name → submits.
[F] Home pattern starts `profile-home` in a fresh profile space, writes the
`homeSpaceCell.defaultPattern.profile` link. Profile now exists.
This is existing shared-profile behavior; My Car(s) builds on top of it. From
here, the employee can add the My Car(s) element to their profile.

---

### J-A — Employee registers their car via "take a picture of my car" (S2)

**Frame:** The employee is not in the parking app at all. They are on **their own
profile**.

1. [U] On their profile, the employee adds the **"My Car(s)"** element (from the
   profile element catalog, the same `addElement` mechanism profiles already
   use). It appears as a card titled "My Car(s)" with an empty state:
   *"No cars yet. 📸 Take a picture of your car."*
2. [U] Taps **📸 Take a picture of your car**. Rear camera opens
   (`capture="environment"`). They photograph their own car in the company lot
   (or driveway — location doesn't matter).
3. [F] The fabric runs LLM extraction on the photo → `{ description: "Black
   Subaru Outback", plateId: "7ABC123", plateState: "CA", confidence: "high" }`.
   The card shows **"Reading your plate…"** then auto-fills *editable* fields.
4. [U] The employee sees the filled-in card: a description, a plate, a state.
   They can correct a misread character. (Honest friction: LLMs misread plates;
   the human-correct step is load-bearing, not decorative.)
5. [U] **Granularity choice surfaces here** (FUTURE, §5): a control like
   *"Share: ⦿ description + plate / ○ description only / ○ just that I own a
   car."* In the design-phase build this defaults to **description + plate** and
   the control is a labeled, disabled placeholder so reviewers see *where* the
   consent decision lives.
6. [U] Taps **Save**.
7. [F] My Car(s) writes the car as a **profile element** in the employee's
   profile space, tagged for discovery (e.g. `#myCar`, with the structured
   `Vehicle` shape from `vehicles.ts`). Owner integrity (`represents-principal`,
   per the profile auth model) brands it so only the employee can mutate it.
8. [F] **Across spaces, with no further user action:** the parking-coordinator
   in the org space has a standing `wish({ query: "#myCar", scope: ["profile"]
   })` (resolved per-viewer / per-employee — see §6). That wish now resolves to
   this car. The coordinator folds the plate into its **"ours"** set; lot-watch's
   classification consumes the same set. The employee's plate is now `ours`
   org-wide.
8b. [U] Back on the card, the empty state is replaced by the car, with a small
   reassuring line: *"✅ Your car is registered with the building."* The employee
   never opened the parking app.

**Magic moment in J-A:** step 8. The employee did a *self*-action on a *personal*
surface, and a *different pattern in a different space owned by a different team*
silently became correct. (See §4.M2.)

---

### J-B — The offender auto-resolution **hero flow**, end to end (S5 / S7 / S9)

This is the demo. It spans three surfaces: an admin in the **org space** doing
lot-watch, the **fabric**, and an employee on **their profile**. Two variants —
play whichever lands better live.

**Setup:** A car has been parked in spot #12 several times. Lot-watch has grouped
the sightings (dedup by normalized plate) and the group shows **"seen 4× — ⚠
possible recurring offender — UNKNOWN."** It's unknown because no registry —
neither the employee profiles nor the guest/offender lists — contains that plate
yet.

#### Variant 1 — "register now and watch it resolve" (best for a live audience)

1. [U-admin] In lot-watch (org space, Report tab), the admin points at the
   flagged group: *"This plate `7ABC123` has taken spot #12 four times. No idea
   whose it is. Red flag."*
2. [U-employee] The employee (Dana) realizes — *"wait, that's my car."* Dana
   opens **their own profile** (not the parking app) and runs **J-A**: 📸 photo
   of their car → extract → Save.
3. [F] Dana's car becomes a profile element. The coordinator's standing wish
   resolves it. The plate `7ABC123` enters the **"ours"** set.
4. [F] **Reactively, in the org space, lot-watch re-runs classification over
   existing sightings.** All 4 historic sightings of `7ABC123` flip from
   **UNKNOWN/⚠offender** to **`ours` (Dana)**. The red "possible offender" flag
   *disappears on its own.*
5. [U-admin] The admin's screen — which they did not touch — updates: the group
   now reads **"Dana's car · ours · seen 4×."** Mystery solved. **No one typed
   Dana's plate into the parking system.**

#### Variant 2 — "already registered, instant match" (best for the steady-state pitch)

1. [U-employee] Dana registered their car weeks ago (J-A), then forgot about it.
2. [U-admin] Admin documents a car in spot #12 (J-C). The photo's plate is
   `7ABC123`.
3. [F] On save, lot-watch classifies the new sighting. The plate is already in
   "ours" (sourced from Dana's profile via the wish). The sighting is born
   **`ours` (Dana)** — it *never* enters the offender funnel.
4. [U-admin] The sighting appears green, labeled "Dana." The "possible offender"
   path was never triggered. The system *prevented* a false accusation
   automatically.

**Why it's a hero, stated plainly:** the resolution happens *at the moment data
becomes available*, across a space boundary, with the two humans never
coordinating directly. The employee asserted a fact about themselves; the admin's
tool consumed it. Reactive emergence, not a sync job.

**Honest friction:** Variant 1 depends on the employee *choosing* to register
after being flagged. If they don't, lot-watch stays correct (it just stays
"unknown") — the fabric doesn't invent data. That's a feature (no false
positives) but the demo should not pretend registration is automatic; it's
*employee-initiated, fabric-propagated.*

---

### J-C — Admin documents a car in a spot and it auto-matches (S7)

This is lot-watch's existing capture flow (DESIGN.md §7) seen through the
"shared-profile feeds the match" lens.

1. [U-admin] Lot-watch, Capture tab. Taps **📸 Photograph the car**, shoots the
   car in spot #5, picks spot **#5**.
2. [F] LLM extraction → `{ description, plateNumber, plateState }`. Fields
   editable; admin fixes one misread digit.
3. [U-admin] Taps **Save**.
4. [F] On save, classification matches normalized `(plate, state)` against, in
   priority order: **ours** (employee profile cars, via the wish) → guest →
   offender → unknown.
   - **Match (the happy path):** plate is in "ours" → sighting is born green,
     labeled with the employee's name. **Auto-matched.** Done.
   - **No match:** sighting is `unknown` → enters the J-D funnel.
5. [U-admin] The sighting card shows the classification chip and (on match) the
   employee name — surfaced from the *employee's own broadcast*, not an admin
   roster entry.

**Magic moment:** the admin documented a car and the *owner's name appeared* —
contributed by the owner, never typed by the admin.

---

### J-D — Admin reviews still-unmatched plates (S8)

The curation loop. This is where the admin spends real effort — on the *unknowns*
the fabric *can't* resolve because no employee owns them.

1. [U-admin] Lot-watch, Sightings tab, filter = **Unknown**. Sees grouped
   unknown plates with counts: *"`9XYZ555` — seen 6× — taken spots #1, #12."*
2. [U-admin] For each unknown, decides:
   - **(a) It's probably an employee who hasn't registered.** The admin can
     *nudge*: a one-tap **"Ask employees: is this yours?"** that posts the
     anonymized description ("silver Honda, plate 9XYZ…") to a channel employees
     can claim from — pushing the work back to the owner where it belongs.
     *(Claim mechanism is future; flag the seam.)*
   - **(b) It's a guest.** Admin marks **guest** (admin-gated) → adds to the
     guest registry → all 6 sightings retro-classify to `guest` (blue).
   - **(c) It's a genuine offender** (e.g. the butcher shop's van). Admin marks
     **offender (org…)** → adds to offender registry → retro-classifies to
     `offender` (red) → it now appears on the repeat-offenders leaderboard.
3. [F] Any of (b)/(c) retro-classifies *all* sightings of that plate at once
   (DESIGN.md §8). The "unknown" bucket shrinks; the report sharpens.
4. [F] Crucially, if path (a) succeeds *later* — an employee registers that car
   on their profile — the plate moves out of "unknown" into "ours" **without the
   admin doing anything** (this is S9 / J-B variant 1, step 4). The admin's
   triage list self-cleans.

**Magic moment:** the unknown list is *self-shrinking from two directions* —
admin curation *and* employee self-registration — and the admin only has to
handle the residue that's genuinely external.

---

## 4. Magic moments (what the demo should spotlight)

These are the precise beats where the fabric's superpowers become *visible*. Each
is a "camera-stops-here" moment.

- **M1 — One photo becomes structured shared data.** (J-A step 3) Employee shoots
  one picture; description + plate appear as editable, *structured* fields. The
  superpower: LLM-on-photo → typed `Vehicle`, no form-filling. *Visible because*
  the fields populate themselves.

- **M2 — Cross-space silent correctness (the wish meets the broadcast).** (J-A
  step 8) The employee saves on their *profile*; the *parking-coordinator in the
  org space* becomes correct with no admin action. **This is the thesis.**
  *Visible because* you can put the admin's screen on a second monitor and watch
  the "ours" count tick up the instant the employee taps Save. Wish-based
  composition made concrete.

- **M3 — Reactive retro-resolution (the flag clears itself).** (J-B v1 step 4)
  An *existing* red "possible offender" flag turns green *on a screen no one is
  touching*, because data became available elsewhere. *Visible because* the admin
  literally watches a warning disappear. Reactive emergence across spaces.

- **M4 — Prevention, not just detection.** (J-B v2 / J-C) A registered car
  *never enters* the offender funnel. The system avoids a false accusation
  silently. *Visible because* you can show the same car flagged when unregistered
  and *never* flagged once registered — same photo, different outcome, no admin
  config change.

- **M5 — Single source of truth, multi-consumer.** Both parking-coordinator
  *and* lot-watch consume the *same* employee car broadcast. *Visible because*
  registering once lights up two tools. (And when the employee gets a new car,
  both update — §3.6.)

- **M6 — The triage list that shrinks itself.** (J-D step 4) The admin's
  "unknowns" pile drains from employee self-service. *Visible because* you can
  show the count dropping without the admin clicking.

Demo ordering recommendation: **M2 first** (establish the thesis on a calm
screen), then **M3** (the dramatic flag-clear), then **M4/M6** as "and here's why
it scales."

---

## 5. Edge / failure cases & where privacy choices later surface

Honest about friction. Privacy items are explicitly **FUTURE WORK** — we note
*where in the UX* the choice surfaces, not how the policy engine works.

### Privacy / granularity surfaces (FUTURE WORK)
- **PV1 — Granularity at registration (J-A step 5).** The "share description+plate
  / description only / just-own-a-car" control lives on the My Car(s) card right
  after extraction. *Design-phase: render it as a labeled, default-on, disabled
  placeholder* so reviewers see the seam. **Do not build the policy engine.**
- **PV2 — Plate-withheld state (S4).** If an employee broadcasts *description
  only*, the coordinator can show "a known employee's car (name hidden)" but
  can't auto-resolve a plate from a photo. The UX should make the *consequence*
  legible at the moment of choice: *"With plate hidden, the parking team can't
  automatically clear your car if it's flagged."* This is the honest tension —
  privacy vs. auto-resolution — and it belongs at PV1's control.
- **PV3 — Who can read the broadcast.** Open question from
  `shared-profile-space.md` ("profile readable by all collaborators vs. private
  until shared?"). Surfaces as: which org spaces' wishes are *allowed* to resolve
  the car. Future policy. Note the seam at §6's wish.
- **PV4 — Revocation.** Employee removes their car (or downgrades to
  description-only) → the coordinator's "ours" set must *reactively drop* it.
  Where it surfaces: a "Stop sharing / Remove car" action on the card. Reactive
  removal is in-scope conceptually (it's just the wish no longer resolving); the
  *policy* of what a downgrade means is future.

### Functional edge / failure cases
- **EF1 — LLM misreads the plate (J-A step 4 / J-C step 2).** Mitigated by the
  editable-fields + human-correct step. *Owner-corrected* on the employee side is
  high-trust; *admin-corrected* on a sighting is audit-only. Both kept (the
  original photo is retained per lot-watch DESIGN §2).
- **EF2 — Plate collision across states.** Two `7ABC123` in CA vs NV. Matching
  must key on **normalized `(plateId, plateState)`**, never plate alone. If state
  is illegible (`""`), match is *low-confidence* and should stay `unknown` rather
  than risk a wrong auto-resolution to an employee. (False-positive avoidance >
  recall.)
- **EF3 — Wish mismatch / tag typo (S10).** Employee registered a car but the
  coordinator never picked it up because the tag/scope didn't line up. Symptom:
  car shows "✅ registered" on the profile but stays `unknown` in lot-watch.
  *This is the most likely silent failure of the whole composition.* Mitigation:
  a coordinator-side "registered employees with no matched plate" diagnostic, and
  a single canonical tag (`#myCar`) shared in code between producer and consumer.
- **EF4 — Employee owns multiple cars.** My Car(s) is plural by design
  (`vehicles: Vehicle[]`). All of an employee's plates join "ours." A sighting
  matches whichever plate hits. Edge: shared/household car registered by two
  employees → both names could match; show both, don't pick one.
- **EF5 — Employee leaves the org.** Their profile (and car broadcast) may
  persist, or the org may revoke their wish access (PV3). Until then, their old
  plate still classifies as `ours`. Future: an org-membership signal gating which
  profiles the coordinator's wish trusts.
- **EF6 — No photo possible / plate not legible.** Fallback to manual entry of
  the `Vehicle` fields on the My Car(s) card (description + plate typed). The
  photo path is the *hero*, not the *only* path.
- **EF7 — Duplicate plate already an "offender."** An employee registers a plate
  that the admin had marked `offender` (e.g. someone fat-fingered a registry
  entry, or a real ownership change). Priority order puts **ours** first
  (DESIGN §8), so the employee's claim wins the *classification*, but the admin
  should get a *conflict surfaced* ("a plate you marked offender is now claimed
  by employee Dana — review"). Don't silently overwrite curated intel.

---

## 6. Data / capability requirements per journey

What the data model & wishes must support. This feeds the design doc.

### Shared types (reuse, don't re-invent)
- **`Vehicle`** (`packages/patterns/vehicles.ts`): `plateId`, `plateState`,
  `color`, `make`, `model`. **My Car(s) must produce this exact shape** so the
  coordinator/lot-watch consume it without translation (M5 depends on this).
- Normalization helpers (`normalizeVehicle(s)`, `formatVehicle`) — reused for
  match-safe `plateId`/`plateState`.

### My Car(s) pattern (employee-owned, lives on profile)
- Stores `vehicles: Vehicle[]` as a **profile element** (per
  `shared-profile-space.md`: a piece in the profile space, added via the
  profile's `addElement`, tagged for hashtag discovery).
- Owner integrity on the element (`{ kind: "represents-principal", subject:
  ownerDid }`) — only the employee can mutate (J-A step 7, PV4).
- A canonical discovery tag, **`#myCar`**, shared in code with consumers (EF3).
- **Capture capability:** rear-camera image input + LLM extraction
  (image → `{ description, plateId, plateState, confidence }`), mirroring
  lot-watch's `cf-image-input` + `generateObject` (J-A steps 2–3). Editable
  result fields (EF1).
- **Granularity field placeholder** on the element (e.g. a `share` enum) — *shape
  reserved, policy not built* (PV1/PV2).
- Plural: supports add / replace / remove car (S6, EF4, PV4).

### Parking-coordinator + lot-watch (org-space consumers)
- A standing **`wish({ query: "#myCar", scope: ["profile"] })`** that resolves
  employee car broadcasts into the **"ours"** set. Must resolve **per employee**
  across the org's known profiles — i.e. the consumer needs to fan the wish over
  the set of org employees (or the profile substrate must expose
  org-member profile elements to an org-space wish). **This is the central
  capability requirement and the most important open design question** (see PV3,
  EF5, and §7).
- Classification already keys on normalized `(plateId, plateState)` with priority
  **ours → guest → offender → unknown** (lot-watch DESIGN §8) — My Car(s) feeds
  the "ours" leg.
- **Reactive re-classification** of existing sightings when "ours" changes
  (J-B v1 step 4 / M3) — lot-watch already recomputes classification reactively;
  must confirm it recomputes when the *wished* "ours" set changes, not only on
  local registry edits.
- **Conflict surface** when a newly-claimed plate collides with curated guest/
  offender intel (EF7).
- **Diagnostic:** "employees whose car broadcast didn't match any sighting / any
  registered employee with no resolvable plate" (EF3).

### Cross-cutting
- Stable, **normalized** plate matching everywhere; never match on plate without
  state when state is known (EF2).
- Retain original photos (audit) on both producer and consumer sides (EF1).
- No fabrication: absence of a match yields `unknown`, never a guessed identity
  (J-B honest-friction note).

---

## 7. Open design questions to resolve before build

1. **Wish fan-out (the big one).** `scope: ["profile"]` resolves the *current
   viewer's* profile. The coordinator needs *all employees'* cars. Options:
   (a) coordinator iterates a known org-employee list and resolves each profile's
   `#myCar`; (b) profile substrate grows an org/collaborator-scoped wish so an
   org-space pattern can discover member profile elements directly. Pick one;
   everything in §3–§4 depends on it. *(Ref: `shared-profile-space.md` open
   question "profile readable by all collaborators by default?")*
2. **Trust boundary for "ours."** Which profiles is the coordinator *allowed* to
   trust as employees (EF5, PV3)? Needs an org-membership signal.
3. **Granularity semantics (deferred).** Confirm the three levels (owner /
   +description / +plate) are the right rungs, and that "description only" has a
   coherent consumer behavior (PV2). *Policy engine is out of scope; the rungs'
   names and the card placement are in scope to specify.*
4. **Canonical tag + shape contract.** Lock `#myCar` and the `Vehicle` shape as
   the producer↔consumer contract to avoid EF3.

---

*End of UX/journeys document. Design phase — no implementation.*
