# Architectural Map: Multi-Pattern / Multi-Space Car Sharing in Common Fabric

## Orientation / Key Correction

The car/parking machinery is split across **three** sibling patterns, not one. Crucially, **license-plate extraction, image documentation, recurring-offender tracking, and known-vehicle matching live in `lot-watch`, NOT `parking-coordinator`.** `parking-coordinator/main.tsx` contains **no LLM, no images, no wish-for-profile** — its only `wish()` is `#now` (line 434). It only owns spots/people/requests/admin and (additively, via PR #3712) a `vehicles?: Vehicle[]` field on `Person`.

There is also currently **no wish-from-profile in any car pattern yet** — that is the greenfield work this map enables. The profile/wish primitives exist and are exercised only by `examples/profile-aware-writer.tsx` and the system profile patterns (`profile-home.tsx`, `profile-create.tsx`, `home.tsx`).

---

## 1. `parking-coordinator` (`packages/patterns/factory-outputs/parking-coordinator/main.tsx`, 2915 lines)

**Role:** canonical model of *our spots* and *our people*. Source of truth for the `ours` vehicle set.

**Domain types** (`main.tsx`):
- `ParkingSpot` (L42), `Person` (L51) — `Person.vehicles?: Vehicle[]` (L58) is the additive field that `lot-watch` reads.
- `SpotRequest` (L63), allocation algorithm `runAutoAllocation` (L356).
- `Vehicle` is imported from `../../vehicles.ts` (the shared catalog), re-exported (L36).

**Cells / scopes:**
- `PerSpace` durable: `spots` (L420), `people` (L421), `requests` (L422), `adminRegistry` (L428).
- `PerUser`: `adminManagerCredential` (L430), `selectedPersonName` (L441).
- `PerSession`: all form/draft/UI state incl. vehicle draft cells (L488–510).

**Inputs (the sharing seam, L135):** `spots?/people?/requests?/adminRegistry?` all `PerSpace<…>` — optional, so the pattern is standalone-capable but composable.

```ts
export interface ParkingCoordinatorInput {
  spots?: PerSpace<SpotsCell>;
  people?: PerSpace<PeopleCell>;
  requests?: PerSpace<RequestsCell>;
  adminRegistry?: PerSpace<ParkingAdminRegistryCell>;
}
```

**Authorization:** uses `packages/patterns/cfc/admin/mod.ts` — `AddIntegrity`/`RequiresIntegrity`-branded role lists, `AdminManagerCredential`, `adminRegistryEntries`, `adminManagerCredentialIsActive`. Integrity tag `PARKING_ADMIN_INTEGRITY = "parking-admin"` (L72). **Demo-only identity caveat** explicitly flagged at L293–298 / L381–387: actor identity is free-text `selectedPersonName`, *not* a DID — "Do not copy this for production authorization; use a stable user/profile cell." **This is exactly the gap a real `#car`-from-profile design closes.**

**Test:** `packages/patterns/integration/parking-coordinator-admin-view.test.ts` — drives the CFC manager→admin→admin-mode ceremony in-browser (enable manager L111, toggle admin L117, admin section gated L131). Asserts admin controls' enabled states only; no vehicle/profile assertions.

---

## 2. `lot-watch` (`packages/patterns/factory-outputs/lot-watch/main.tsx`, 2436 lines + `DESIGN.md`)

**Role:** mobile-first sighting capture → LLM plate extraction → classification → dedup/grouping → offender reporting. This is where all the "interesting" car intelligence lives. `DESIGN.md` is an excellent, accurate spec — read it.

**Domain types:**
- `Sighting` (L64): `image: SightingImage`, `description/plateNumber/plateState`, `extractionPending/Error`, `humanCorrected`, `classification`, `notes`.
- `SightingImage` (L59) — **GOTCHA, deliberate:** stores only blob `{ url, name }`, NOT full `ImageData`. The `data` field is ~700KB base64 and inlining it into the `PerSpace sightings` array destabilizes cell sync. See `docs/development/debugging/gotchas/persisting-images-in-cells.md`.
- `KnownVehicle` (L37): `category: "guest" | "offender"`, `org`, `label` — the Lot-Watch-owned registries.
- `PlateExtraction` (L48): LLM output `{ description, plateNumber, plateState, confidence }`.
- `Classification = "ours"|"guest"|"offender"|"unknown"` (L33).

**Cells/scopes:** `PerSpace`: `sightings` (L458), `knownVehicles` (L463), `people` (L469, read-only for "ours"), `spots`, `adminRegistry`. `PerUser`: `adminManagerCredential` (L479), `reporterName` (L484). `PerSession`: capture draft incl. `draftImage: ImageData|null` (L500).

**Image capture → LLM extraction:**
- Capture via `<cf-image-input capture="environment" includeData>` (DESIGN §7); handler pulls `detail.allImages[0]` into `draftImage`.
- **Extraction = `generateObject<PlateExtraction>`** (L530–575): `system` prompt + `prompt: computed(() => [{type:"image", image: img.data ?? img.url}, {type:"text", …}])` + explicit JSON `schema` + `model: "anthropic:claude-sonnet-4-5"`. Reactive `extraction.result/.pending/.error`. **This is the idiomatic image→structured-data primitive to reuse.**

**Classification** — `classifyPlate(plateNumber, plateState, ours, known)` (L277, module-scope pure so it's callable from `computed()` without capturing cells). Priority **ours > offender > guest > unknown**. `ours` = `people.flatMap(p => p.vehicles)` (L1055 etc.). Matching normalizes via `normalizePlateId` + uppercased 2-letter state.

**Recurring offenders / dedup** — `groupSightingsByPlate` (L336, module-scope pure) keyed on `plateNumber|plateState`; `PlateGroup.isRepeat = count >= 2` (L364). Reports tab ranks offender groups by count.

**Curation loop / write-back to `people`** — `markVehicle` (L960) writes guest/offender into `knownVehicles` and retro-classifies; `assignToPerson` (L822, admin-gated) is the **"oh, that's Gideon's car"** path: writes a coordinator-shaped `Vehicle` back into the shared `people` cell, *creating a new person if the name doesn't exist* (L883). This is the existing precedent for one pattern writing structured vehicle data into another's space-shared cell.

**Composition demo** — `packages/patterns/factory-outputs/lot-with-coordinator-demo/main.tsx`: instantiates both patterns wired to the *same* `Writable.perSpace<Person[]>` and `spots` cells (L63–77). Demonstrates the cell-wiring sharing idiom (same-space, `PerSpace` cell passed as input to both children). **Note the `as never` casts** (L70–77) needed because each pattern declares its own private `PeopleCell`/`SpotsCell` alias — structurally identical, nominally distinct.

---

## 3. Shared catalog `packages/patterns/vehicles.ts` (438 lines)

Single source of truth for vehicle hygiene. Exports `Vehicle` (L5), `VEHICLE_COLORS/MAKES/US_STATES/MODELS_BY_MAKE`, `modelsForMake`, `formatVehicle` (L386), `normalizePlateId` (L401: uppercase, strip non-alphanumeric), `normalizeVehicle` (L410: clamps color/make/model to catalog, defaults state to "CA"), `normalizeVehicles` (L426: dedupe by `plateId|plateState`).

```ts
export interface Vehicle {
  plateId: string;    // REQUIRED — normalized to uppercase alphanumerics
  plateState: string; // optional, default "CA"
  color: string;      // optional, "" or a member of VEHICLE_COLORS
  make: string;       // optional, "" or a member of VEHICLE_MAKES
  model: string;      // optional, "" or a member of MODELS_BY_MAKE[make]
}
```

**A "my car" pattern should reuse `Vehicle` + these normalizers verbatim** so plates match across spaces.

---

## 4. Shared-Profile Mechanism (PR #3762 + follow-ups)

Authoritative spec: **`docs/specs/shared-profile-space.md`** (read in full — it is the design bible for this work).

### Profile creation from home
- Home default pattern (`packages/patterns/system/home.tsx`) owns durable link `homeSpaceCell.defaultPattern.profile` (a cross-space cell link) + `profileName` mirror (L135–136).
- If link missing → renders `ProfileCreate` surface; submitting a name runs `submitProfileCreation` (`profile-create.tsx` L25) which calls `ProfileHome.inSpace(name)({ initialName: name })` (L37) — `PatternFactory.inSpace` creates a **new profile space** and the resolved DID is written to the durable link during async post-run. `profileName` mirror written alongside for creation-latency display.
- `hasProfile` existence check is keyed off the durable `profile` link, with `profileName` as a creation-latency fallback (`home.tsx` L165–167).
- PR #3812 (`8eaec6aec`) fixed the home Profile tab to reflect the created profile (avoiding a single-space "cross-space writes" guard error).

### Profile default pattern — the owner-integrity template
**`packages/patterns/system/profile-home.tsx`** is the canonical owner-protected pattern and the **direct structural template for "my car."** Key shape:
- Owner-protected output fields use `OwnerProtectedProfileWrite<T, Binding>` (L21) = `RepresentsCurrentUser<Cfc<WriteAuthorizedBy<T, Binding>, { ownerPrincipal: CurrentPrincipal }>>`. Applied to `name`/`avatar`/`elements` (L77–79).

```ts
type OwnerProtectedProfileWrite<T, Binding> = RepresentsCurrentUser<
  Cfc<
    WriteAuthorizedBy<T, Binding>,
    { ownerPrincipal: CurrentPrincipal }
  >
>;
```

- Writes flow through **trusted handlers** (`setName` L162, `setAvatar` L173, `addElement` L131, `removeElement` L153) — each named handler is the `WriteAuthorizedBy` binding.
- Cells declared with `.for("name")`, `.for("elements")` tags (L243–251) — the `.for(tag)` mechanism stabilizes cell identity and is also how profile elements become wish-discoverable.
- Trusted UI surface markers: `data-ui-pattern={TRUSTED_PROFILE_HOME_SURFACE}` + `data-ui-event-integrity` (L276–277), `data-ui-action={TRUSTED_PROFILE_EDIT_ACTION}` (L290). CFC enforces that owner-field writes originate from this trusted surface.
- `ProfileElement` (L40) = `{ cell, tag, userTags, title?, source? }`. Elements are added via `addElement` stream (never push to `elements` directly), created with `(SomePattern(...) as any).for(tag)`.

```ts
export type ProfileElement = {
  cell: any;
  tag: string;
  userTags: readonly string[];
  title?: string;
  source?: "catalog" | "url";
};

export type AddProfileElementEvent = {
  catalogId?: string;
  patternUrl?: string;
  title?: string;
  tag?: string;
  userTags?: readonly string[];
};
```

### `wish()` resolution (`packages/runner/src/builtins/wish.ts`, 1904 lines)
- Well-known home targets classified at L138–146; resolved at L717–773:
  - `#profile` (L717) → `getProfileDefaultCell(ctx)` (whole profile default pattern).
  - `#profileName` (L728) → live `profile.initialNameApplied`, falling back to home `profileName` mirror during creation latency.
  - `#profileAvatar` (L761), `#profileSpace` (L768).
- `getProfileDefaultCell` (L279) resolves `homeSpaceCell.defaultPattern.profile`, throws `WishError` if unset (link missing → profile not created). Pulls cross-space + subscribes to `initialNameApplied` so the wish re-runs once the new profile materializes.
- **Profile-element hashtag search** (L485–534): `scope: ["profile"]` reads `profileDefault.elements`, matches each element by `userTags` (exact, lowercased, no `#`) first, then `tag` via `tagMatchesHashtag` (L181). Maps matches → `element.cell`. Scope plumbing: `getArbitraryDIDs` excludes `"~"/"."/"profile"` (L248); search-order favorites → mentionables → profile → DIDs.

### Owner-integrity enforcement (CFC, runner-side)
`packages/runner/src/cfc/prepare.ts` is the enforcement point:
- `__ctCurrentPrincipal` placeholder (L106) resolves to the authenticated `actingPrincipal` (the user's DID, from `runtime.userIdentityDID` / `storageManager.as.did()`) at write time (`resolveCurrentPrincipalPlaceholders` L128).
- `CURRENT_PRINCIPAL_CLAIM_KINDS` = `{ "authored-by", "represents-principal" }` (L107).
- `ownerPrincipal` check (L1070–1112): requires a trust snapshot with `actingPrincipal === ownerPrincipal`, a matching `represents-principal` integrity atom on the value (L1101), AND `writeAuthorizedBy` present (L1111). The owner atom shape is `{ kind: "represents-principal", subject: ownerDid }`.
- `writeAuthorizedBy` (L271, L1144) gates *modification* to a trusted builtin/verified binding identity (the named handler).
- The profile **link** itself carries static `["profile-link"]` integrity + `WriteAuthorizedBy<…, typeof submitProfileCreation>` (`profile-create.tsx` `TrustedProfileLink` L45), separate from the owner `represents-principal` on profile fields.
- Tests proving semantics: `packages/runner/test/profile-owner-cfc.test.ts` — owner integrity persists on profile default fields (L166); Bob cannot write Alice's fields (L252, error contains `"ownerPrincipal"`); unauthenticated writes rejected (L291); untrusted writes rejected (`"writeAuthorizedBy requires a trusted builtin identity"` L347); `ownerPrincipal` without matching integrity rejected (L355). Commit `dbc1ff135` exempts a pattern's own owner-protected field *initialization* from the `writeAuthorizedBy` check.

### Public CFC API surface (`packages/api/cfc.ts`) — author-facing helpers
`Cfc<T,Meta>` (L9); `AddIntegrity` (L255), `RequiresIntegrity` (L273), `RepresentsCurrentUser` (L259), `AuthoredByCurrentUser` (L266), `WriteAuthorizedBy` (L342), `Integrity`/`Confidential`/`ExactCopy`/`FilteredFrom`/`ProjectionOf`/`SubsetOf` etc. Canonical alias names enumerated L199–205. All re-exported from `commonfabric`.

CFC admin module (`packages/patterns/cfc/admin/mod.ts`): `AdminSubject` (L8), `AdminRoleAssignment` (L10), `ActiveAdminRole` (L15), `AdminManagerCredential` (L20), `AdminRegistryValue` (L31), `adminManagerCredentialIsActive` (L35), `adminRegistryEntries` (L42), `adminRegistryEveryoneIsAdmin` (L52). Generic over `Role`, which is why one `adminRegistry` can carry both `parking-admin` and `lot-watch-admin` role types.

---

## 5. Authoritative Docs

| Doc | Use |
|---|---|
| `docs/specs/shared-profile-space.md` | **Primary spec** — profile creation, wish scope/targets, owner authorization, integration-test plan. |
| `docs/common/conventions/wish.md` | wish result shape, scopes (`~`/`.`/`profile`), well-known `#profile*` targets, `addPiece` via `#default`. |
| `docs/specs/scoped-cell-instances.md` | PerSpace/PerUser/PerSession cell-instance model. |
| `docs/development/scoped-cells-field-notes.md` + `docs/development/debugging/gotchas/scoped-cell-pitfalls.md` | Practical scoped-cell gotchas. |
| `docs/plans/cfc_typescript_authoring.md`, `docs/common/ai/cfc-helper-authoring-guide.md`, `docs/specs/ts-transformer/cfc_authoring_contract.md` | How to author CFC-protected fields. |
| `docs/plans/runner_cfc_implementation.md` | Runner-side CFC implementation plan. |
| `docs/specs/verifiable-execution/06-cfc-and-trust.md` | CFC + trust model. |
| `docs/development/debugging/gotchas/persisting-images-in-cells.md` | Why to store blob URL not `ImageData`. |
| `docs/development/debugging/gotchas/closure-capture-in-nested-map.md` + `persession-read-in-mapped-computed.md` | The two reactivity gotchas these patterns hit (also flagged inline in coordinator at L1281–1284, L1358–1366). |

---

## Cross-Space Data-Flow Summary (who writes where, who reads where)

- **Home space** (`space = userIdentityDID`): home default pattern owns `defaultPattern.profile` (durable cross-space link to the profile space) + `profileName` mirror + favorites/journal/learned/spaces. Written by the trusted profile-creation flow (`submitProfileCreation`), CFC-guarded by static `["profile-link"]` integrity.
- **Profile space** (a fresh DID, created via `ProfileHome.inSpace(name)`): profile default pattern (`profile-home.tsx`) owns owner-protected `name`/`avatar`/`elements`. Writes must satisfy `ownerPrincipal === actingPrincipal` (the authenticated user DID) AND originate from the trusted profile handlers/surface. **A "my car" piece would live here as a `ProfileElement` (or be the profile default pattern itself for the v1 demo).**
- **Collaboration space** (parking lot): `parking-coordinator` + `lot-watch` own space-shared `PerSpace` cells (`spots`, `people`, `sightings`, `knownVehicles`, `adminRegistry`). `lot-watch` reads `people[].vehicles` for the `ours` set and writes back via the admin-gated `assignToPerson` (same-space write only).
- **Wish reads cross-space:** `wish({query:"#car", scope:["profile"]})` from the parking space reads the viewing user's profile-space car element. Cross-space *reads* are fine. Cross-space *writes* into another's owner-protected profile fields are CFC-rejected.

---

## Extension Points, Idioms, Gotchas for a User-Owned "My Car" Pattern

### Idioms to mirror
1. **Clone `profile-home.tsx`'s owner-integrity skeleton.** Make `MyCar`'s `description`/`licensePlate`/`broadcastLevel` fields `RepresentsCurrentUser<Cfc<WriteAuthorizedBy<T, typeof setX>, { ownerPrincipal: CurrentPrincipal }>>`, mutated only via named trusted handlers, with `data-ui-pattern`/`data-ui-action` trusted-surface markers. This is the *only* idiomatic way to get real owner enforcement — and it directly fixes the demo-only identity caveat called out in both car patterns.
2. **Make the car a profile element.** Add it via `ProfileHome.addElement` (catalog or URL source) so it lands in `profileDefault.elements` with a `tag`/`userTags` (e.g. `userTags: ["car"]`). Then `parking-coordinator`/`lot-watch` discover it with `wish({ query: "#car", scope: ["profile"] })`. Element matching is `userTags`-first then `tag` (wish.ts L514).
3. **Reuse `vehicles.ts` `Vehicle` + normalizers** so plate matching is identical across spaces (`normalizePlateId`, `plateId|plateState` key).
4. **Reuse the `lot-watch` `generateObject` image→`PlateExtraction` recipe** if "my car" wants to auto-fill plate/description from a user photo.
5. **Graduated broadcast** maps cleanly to CFC **confidentiality** + projection helpers (`Confidential`, `FilteredFrom`/`ProjectionOf` in `api/cfc.ts`): owner→description→description+plate is a confidentiality lattice, not just UI hiding.

### Extension points / data-flow design
- **Who writes where:** User writes car details **only into their own profile space** (owner-protected, `represents-principal = ownerDid`). `parking-coordinator`/`lot-watch` **read** via `wish(scope:["profile"])` — cross-space *reads* are fine; they must not write the user's owner-protected car fields (CFC will reject — see `profile-owner-cfc.test.ts`).
- **The "wish AND store back" requirement** (parking-coordinator storing resolved car details on the user's profile) is the **hard part**: a foreign pattern writing into the owner's profile space conflicts with `ownerPrincipal` enforcement unless the write target is a *non-owner-protected* sub-cell or a separate "shared with parking" element the owner pre-authorized. The existing `assignToPerson` precedent (lot-watch L822) only writes into the *space-local* shared `people` cell, never cross-space into a profile. **This cross-space-write-to-profile path does not exist yet and is the central design question.** Likely resolution: the offender→identity resolution should write into the *parking space's* own cell (mirroring `assignToPerson`), with the profile being read-only source data — matching the spec's open question "Should profile spaces be readable by all collaborators by default?"

### Gotchas
- **Profile `wish` throws (not empty) when no profile exists** (`getProfileDefaultCell` L291). `wish({query:"#profile"})[UI]` renders the create-profile surface in that state — lean on that for onboarding.
- **`scope: ["profile"]` must be explicit** — default wish scope is favorites-only.
- **Cross-space cells read `undefined` on first render** until the space loads (home.tsx L155–165) — design for the reactive re-run, never assume synchronous availability.
- **Don't inline images into `PerSpace` arrays** — store `{url, name}`, keep base64 transient in `PerSession`.
- **`computed()` nested inside `.map()` can't read narrower `PerSession`/`PerUser` cells** — hoist those reads to a top-level `computed()` (coordinator L1358–1366; matches the `persession-in-mapped-computed-gotcha` memory note).
- **Array values across `send()`/space boundaries arrive as query-result proxies** that read empty — rematerialize to plain objects before sending (coordinator L1031–1040, L1108–1117).
- **Structural-but-nominal cell type mismatch** when wiring shared `PerSpace` cells into multiple patterns needs `as never` casts (lot-with-coordinator-demo L70–77).
- **Demo identity is free-text, not DID** in both existing car patterns — a profile-backed `#car` design should switch the actor key to the authenticated DID via the `RepresentsCurrentUser` machinery.
