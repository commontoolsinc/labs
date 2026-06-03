# Voucher Last-Mile Investigation — "same author as a profile reference" as a CFC primitive

**Question (Bernhard Seefeld's proposal):** Replace §4's owner-signed
`EmployeeRoster`/`voucherRegistry` of raw DIDs with a CFC primitive meaning
"authored by the same principal as the owner of `<profile reference>`." Trust
becomes: a claim is "ours" iff its author is the same principal as the owner of
one of the org's member-*profile* references — membership resolves *through a
profile*, not through a hardcoded DID list.

**Method / sources.** Read-only ground-truth pass over the committed design
(`DESIGN.md`, `DESIGN-BRIEF.md`, `codebase-research.md`) and the live runtime:
`packages/api/cfc.ts`, `packages/runner/src/cfc/prepare.ts`,
`packages/runner/src/cfc/types.ts`, `packages/runner/src/builtins/wish.ts`,
`packages/patterns/system/profile-home.tsx`, `packages/patterns/system/home.tsx`,
`packages/patterns/cfc/admin/mod.ts`,
`packages/ui/src/v2/components/cf-cfc-authorship/cf-cfc-authorship.ts`,
`packages/runner/test/profile-owner-cfc.test.ts`,
`docs/specs/shared-profile-space.md`.

Throughout, findings are tagged **[DOCUMENTED]** (spec/design says so),
**[IMPLEMENTED]** (code does so, with file:line), **[TESTED]** (a test asserts
it), or **[INFERRED]** (my reasoning from the above).

---

## (a) What exists today

### A1. The authorship/identity integrity primitives (the author-facing surface)

All live in `packages/api/cfc.ts` as compile-time alias carriers (the file's own
header: "compile-time carriers only"):

- `Cfc<T, Meta>` (`cfc.ts:9`) — the base carrier; every other alias is sugar
  over it. **[IMPLEMENTED]**
- `RepresentsCurrentUser<T>` (`cfc.ts:259`) — lowers to
  `addIntegrity: [{ kind: "represents-principal", subject: { __ctCurrentPrincipal: true } }]`.
  **[IMPLEMENTED]**
- `AuthoredByCurrentUser<T>` (`cfc.ts:266`) — lowers to
  `addIntegrity: [{ kind: "authored-by", subject: { __ctCurrentPrincipal: true } }]`.
  **[IMPLEMENTED]**
- `AddIntegrity<T, X>` (`cfc.ts:255`), `Integrity<T,X>` (`cfc.ts:251`),
  `RequiresIntegrity<T, X>` (`cfc.ts:273`) — attach / require literal integrity
  atom tuples. **[IMPLEMENTED]**
- `WriteAuthorizedBy<T, Binding>` (`cfc.ts:342`) — lowers to
  `writeAuthorizedBy: Binding`; the Binding is a *handler/builtin identity*, not
  a principal. **[IMPLEMENTED]**
- `Confidential` / `ProjectionOf` / `FilteredFrom` / `SubsetOf` etc.
  (`cfc.ts:247–334`) — confidentiality + collection-provenance carriers (used by
  §7's reveal handshake, not by the trust gate). **[IMPLEMENTED]**

**The decisive shape:** every principal-referencing primitive binds its
`subject` to the literal placeholder `{ __ctCurrentPrincipal: true }`
(`cfc.ts:262`, `:269`). There is **no** alias whose subject is "the owner of
some other cell." The vocabulary is closed and enumerated in
`CFC_CANONICAL_ALIAS_NAMES` (`cfc.ts:195–217`) — 21 names, none of which express
a cross-value author comparison. **[IMPLEMENTED]**

### A2. The runner enforcement point (`packages/runner/src/cfc/prepare.ts`)

- `CURRENT_PRINCIPAL_CLAIM_KINDS = { "authored-by", "represents-principal" }`
  (`prepare.ts:107`). **[IMPLEMENTED]**
- The `__ctCurrentPrincipal` placeholder is resolved by
  `resolveCurrentPrincipalPlaceholders(value, actingPrincipal)`
  (`prepare.ts:128`), driven by `isCurrentPrincipalPlaceholder`
  (`prepare.ts:112`). It substitutes **one** value: the
  `trustSnapshot.actingPrincipal`. **[IMPLEMENTED]**
- `currentPrincipalIntegrityReason(...)` (`prepare.ts:1057–1155`) is the
  owner/author gate. For an owner-protected field (`ifc.ownerPrincipal` present,
  `:1070`):
  - the owner DID is either the literal in the schema or, if it is the
    placeholder, `trustSnapshot.actingPrincipal` (`prepare.ts:1086–1088`);
  - it requires a matching `represents-principal` atom whose subject **equals
    that owner** (`prepare.ts:1099–1107`);
  - it requires `trustSnapshot.actingPrincipal === ownerPrincipal`
    (`prepare.ts:1108–1110`) — i.e. **the writer must BE the owner**;
  - it requires `writeAuthorizedBy` present (`prepare.ts:1111–1113`).
  **[IMPLEMENTED]**
- `TrustSnapshot` (`types.ts:164–168`) carries exactly `{ id, actingPrincipal?,
  revision? }`. There is **one** principal in scope at enforcement time: the
  current actor. No field references any *other* cell's owner. **[IMPLEMENTED]**

Proven by `profile-owner-cfc.test.ts`: the stored owner atom is
`{ kind: "represents-principal", subject: ownerDid }` (`:19–20`); the schema spec
carries `ownerPrincipal: { __ctCurrentPrincipal: true }` + represents-principal
placeholder (`:431–436`); Bob writing Alice's field fails with an
`"ownerPrincipal"` mismatch (`:284`, `:315`); an `ownerPrincipal` without a
matching integrity claim is rejected (`:355`, `:391`). **[TESTED]**

### A3. The §4 cheat as it stands

`EmployeeRoster`/`voucherRegistry` (DESIGN §4) reuses
`AdminRegistryValue<Role>` from `packages/patterns/cfc/admin/mod.ts:31`. The
registry stores `admins: Role[]` where each `Role` is an
`AddIntegrity<EmployeeAttestation, [VOUCHER_INTEGRITY]>` carrying a raw
`subject: string` DID (`mod.ts:10–18`, `:24–33`; `adminRegistryEntries`
`:42–49`). The allow rule then tests `subject ∈ voucherRegistry`. **[DOCUMENTED
in DESIGN §4; the substrate it reuses is IMPLEMENTED.]**

### A4. The one place "owner of a referenced cell" is ALREADY computed

`packages/ui/src/v2/components/cf-cfc-authorship/cf-cfc-authorship.ts` does,
**at the UI/display layer**, almost exactly the operation the proposal needs:

- `readLabelView(value, requiredRootIntegrityKind)` (`:168–193`) calls
  `value.getCfcLabel()` — a **cell-level capability to read a referenced value's
  CFC integrity atoms at runtime**. **[IMPLEMENTED]**
- `representsPrincipalSubjectForLabel(view)` (`:243–265`) walks the read label and
  extracts the `subject` of the `represents-principal` atom — i.e. **resolves a
  referenced profile/cell's owner DID**. **[IMPLEMENTED]**
- `integrityAtomMatchesAuthor(atom, author, kind)` (`:280–307`) and
  `authorshipStateForLabel(...)` (`:326–349`) then **compare** that owner subject
  against a value's `authored-by` / `represents-principal` atom, returning
  `verified | unverified | unknown`. **[IMPLEMENTED]**
- `refreshAuthorClaim()` (`:716–750`) wires it together: read a referenced
  author's `represents-principal` label, pull its subject, and present a
  verified/not badge.

This is the single most important finding for the proposal: **"resolve a
reference's owner principal, then compare it to a value's author" already exists
as working code** — but as a *read-time display/verification affordance in the UI
package*, **not** as an *enforcement gate in the runner*. **[INFERRED from the
two IMPLEMENTED facts above.]**

### A5. Membership-as-profile-references today

There is **no** org/collaborator membership modeled as a set of profile
references anywhere. **[IMPLEMENTED — by absence; searched.]**
- `home.tsx` has `favorites: Favorite[]` (`home.tsx:21–27`) and `spaces:
  SpaceEntry[]` (`:40–43`). `SpaceEntry = { name, did? }` is a raw-DID-or-name
  bag, not a profile reference; `Favorite` references a piece `cell`, a `tag`,
  and an optional `spaceDid` — again not a profile-owner reference.
- The single home→profile link is `homeSpaceCell.defaultPattern.profile` (a
  durable cross-space link, `wish.ts:279–309`), resolved by
  `getProfileDefaultCell`. It is **one self-link**, not a set of *other people's*
  member profiles. **[IMPLEMENTED]**
- `docs/specs/shared-profile-space.md:429–430` leaves open: "Should profile
  spaces be readable by all collaborators by default, or private until explicitly
  shared?" — so even *reading* member profiles cross-space is an unsettled
  substrate question, not a built capability. **[DOCUMENTED — as an open
  question.]**

---

## (b) The precise gap — is "same author as a reference" expressible now?

**No. Not at the enforcement layer.** Characterized exactly:

1. **The authorization frame is the *current actor*, never a *referenced
   value*.** Every principal the runner can name at gate time is
   `trustSnapshot.actingPrincipal` (`types.ts:164–168`; consumed at
   `prepare.ts:1086–1088`, `:1108`). The placeholder machinery substitutes that
   one value and only that one (`prepare.ts:128–155`). There is no API to say
   "resolve the principal *of cell X* and test the author against it."
   **[IMPLEMENTED]**

2. **The owner DID is static at the schema, not dynamic from a reference.** In
   `currentPrincipalIntegrityReason`, `ownerPrincipal` is either a literal DID
   baked into the schema or the current-principal placeholder
   (`prepare.ts:1086–1088`). There is no `ownerPrincipalFromReference` /
   `sameAuthorAs` branch. **[IMPLEMENTED]**

3. **The closed alias vocabulary cannot carry the idea.**
   `CFC_CANONICAL_ALIAS_NAMES` (`cfc.ts:195–217`) has no alias whose meta encodes
   "compare authorship to a referenced cell." The schema-lowering and the runner
   `ifc.*` switch (`prepare.ts` reads `ifc.integrity`, `ifc.addIntegrity`,
   `ifc.ownerPrincipal`, `ifc.writeAuthorizedBy`, `ifc.exactCopyOf`,
   `ifc.uiContract`, `ifc.projection`, `ifc.collection`) have no key for it.
   **[IMPLEMENTED]**

4. **Provenance comparison exists only at read/display time, in a different
   package.** `cf-cfc-authorship` (A4) proves the *resolution + comparison* is
   mechanically possible with today's primitives (`getCfcLabel()` +
   subject-extraction), but it lives in `packages/ui` as a non-authoritative
   verification badge — it does not, and cannot, *gate a write or a derivation*
   the way `prepare.ts` does. **[INFERRED.]**

**So the gap is narrow and specific:** the *capability* to read a referenced
cell's `represents-principal` subject and compare it to another value's author
**already exists** (A4) — what is missing is (i) a **named CFC primitive** to
express it in authored types, and (ii) a place to **evaluate it as policy**. The
design's allow rule is a *derivation over read data* (claimedCars →
affiliatedVehicles, DESIGN §5), not an owner-protected *write* — which means the
natural home for "same author as a member profile" is **pattern-level computed
logic over wished cells**, not the runner write-gate. That is the key
re-framing.

---

## (c) Sketch of the primitive and how it folds into the design

Two layers, mirroring how the codebase already splits "author-facing alias"
(`api/cfc.ts`) from "runtime check":

### C1. Author-facing alias (the *type/intent* carrier) — `packages/api/cfc.ts`

A new compile-time alias, sibling to `RepresentsCurrentUser` (`cfc.ts:259`):

```ts
// "this value's author must be the same principal as the owner of <Reference>"
export type SameAuthorAs<T, Reference> = Cfc<T, {
  authorMatchesOwnerOf: Reference;   // Reference is a profile-cell ref token
}>;
```

This is symmetric with the existing pattern: `RepresentsCurrentUser` carries an
intent that the runner later resolves against the trust snapshot;
`SameAuthorAs<T, Ref>` carries an intent the runner (or a trusted derivation)
resolves against the *referenced cell's* `represents-principal` subject. It
would be added to `CFC_CANONICAL_ALIAS_NAMES` (`cfc.ts:195–217`).

### C2. The actual trust rule lives in pattern-level derivation, not the write-gate

Because the allow decision is a **read-time derivation** (DESIGN §5
`classifyPlate(affiliatedVehicles)`), the cleanest v1 does **not** need a new
runner write-gate at all. It needs the *comparison primitive* applied inside the
coordinator's `computed()`:

- For each member-profile reference `P` the org holds, resolve `ownerOf(P)` =
  the `represents-principal` subject of `P` — exactly
  `representsPrincipalSubjectForLabel(getCfcLabel(P))` already implemented in
  `cf-cfc-authorship.ts:243–265` (lift that helper out of `packages/ui` into a
  shared, runner-adjacent module).
- A self-`VehicleClaim` is "ours" iff its `represents-principal` subject equals
  `ownerOf(P)` for some member profile `P` — `integrityAtomMatchesAuthor`
  (`cf-cfc-authorship.ts:280–307`) is the comparison, already written.
- This **replaces** DESIGN §4's `subject ∈ voucherRegistry` (raw-DID test) with
  `ownerOf(claim) ∈ { ownerOf(P) : P ∈ memberProfiles }` (profile-resolved test).

So §4's `EmployeeRoster`/`voucherRegistry<RawDID>` becomes
`memberProfiles: ProfileRef[]` — a list of *profile references*, and "current
employee" is defined as "owner of a member profile," never a hand-maintained DID.
The owner-signed nature stays (Dave still curates *which profiles* are members),
but the leaf is a profile, not a DID. **[INFERRED, grounded in A1–A4.]**

### C3. (Optional, stronger) a real runner gate

If we later want `GuestVouch`-style *writes* to be gated by "author must be a
member-profile owner," that is the genuine substrate growth: add an
`authorMatchesOwnerOf` branch to `currentPrincipalIntegrityReason`
(`prepare.ts:1057`) that (1) resolves the referenced profile cell, (2) reads its
`represents-principal` subject via the runner's label machinery, (3) tests the
writing value's author against it. This is heavier (cross-space label read inside
the write transaction; see risks) and is **not** needed for the §5 read-derived
allow-set. Recommend deferring it. **[INFERRED.]**

---

## (d) Does this also close the §6 wish fan-out?

**Partially — and elegantly, in the same direction the design already leans, but
it does not by itself remove the open substrate question.**

- DESIGN §6 option (1) already proposes the *roster doubles as the fan-out set*:
  walk `voucherRegistry` DIDs, resolve each `#car`. Swapping raw DIDs for
  **member-profile references** makes this *more* natural, not less: a profile
  reference is precisely a handle to that member's profile space, so the same
  `memberProfiles: ProfileRef[]` set is (i) the trust anchor (own owner =
  "ours") AND (ii) the fan-out set (resolve each member's `#car`). One list, two
  jobs — the unification §6 was reaching for. **[INFERRED, consistent with
  DESIGN §6 option (1) and the recommendation at DESIGN §12 Q2.]**
- It does **not** dissolve §6's deeper open question (option (2): an
  org/collaborator-scoped wish). `getProfileDefaultCell` resolves only the
  viewer's own single profile link (`wish.ts:279–309`); there is no built wish
  scope that fans over a *set of other people's* profiles. With profile
  references in hand, the coordinator can still only resolve them by iterating
  (`scope: ["profile"]` is viewer-only). And cross-space readability of member
  profiles is itself the unsettled `shared-profile-space.md:429–430` question.
  So: profile references make the *trust set* and the *fan-out set* the same
  object (a real simplification), but the *mechanism* of fanning out is
  unchanged and still wants substrate work. **[DOCUMENTED open question +
  IMPLEMENTED viewer-only resolution.]**

---

## (e) Implementation surface + risks

**Surface (concrete, by layer):**
1. `packages/api/cfc.ts:195–217, ~259` — add `SameAuthorAs<T, Reference>` alias +
   register the name. (Type-only; low blast radius.)
2. A shared helper module (lift `representsPrincipalSubjectForLabel` +
   `integrityAtomMatchesAuthor` out of
   `packages/ui/src/v2/components/cf-cfc-authorship/cf-cfc-authorship.ts:243–307`
   so both UI and patterns can call it) — this is the resolve+compare core, and
   it *already exists and is tested* in the UI package
   (`cf-cfc-authorship.test.ts`).
3. The design's coordinator pattern (greenfield, per `codebase-research.md:7` —
   no car pattern wishes a profile yet) consumes (2) inside its `computed()` to
   build `affiliatedVehicles` (DESIGN §5).
4. **Only if a write-gate is wanted (C3):** `prepare.ts:1057` (new
   `authorMatchesOwnerOf` branch) + `types.ts` (carry a resolved reference
   principal) + schema-merge (`schema-merge.ts:12,109` lists `ownerPrincipal`;
   a new key joins it). This is the heavy path; recommend deferring.

**Risks / forgery surface:**
- **Reference indirection / forged reference.** Trust now flows through "which
  profile references the org holds." If an attacker can inject a member-profile
  reference (or swap one), they redirect the owner-resolution. The reference set
  itself must be owner-protected (Dave-signed) — i.e. the *cheat does not vanish;
  it moves up one level* from "list of DIDs" to "list of profile refs," and that
  list still needs the same `AdminRegistryValue`/owner-integrity protection
  (`mod.ts:31`; `prepare.ts:1070`). **[INFERRED.]**
- **A forged `represents-principal` on a profile.** The whole scheme rests on a
  profile's owner atom being unforgeable. That holds *because* profile owner
  fields are gated by `ownerPrincipal === actingPrincipal` + matching
  represents-principal (`prepare.ts:1099–1110`, `profile-owner-cfc.test.ts:284`).
  Good news: the proposal *reuses* the strongest guarantee in the system as its
  root of trust instead of a bare string list. **[TESTED — the guarantee it
  leans on.]**
- **Cross-space resolution latency / availability.** Reading a referenced
  profile's label is a cross-space read; cross-space cells read `undefined` on
  first render (`codebase-research.md:198`). In a *derivation* this is fine
  (reactive re-run). In a *write-gate* (C3) it means a synchronous owner-resolve
  inside the write transaction — latency and a fail-closed/fail-open decision.
  Argues for keeping the rule in §5 derivation, not the gate. **[INFERRED.]**
- **Revocation semantics.** Dropping a profile reference re-derives the allow-set
  exactly like DESIGN §4's "drop a DID" (DESIGN §4 revocation note; §5 reactive
  retro-resolution). Same reactive cascade, cleaner key. **[INFERRED, consistent
  with DESIGN §4–5.]**
- **N cross-space resolutions** unchanged from §6 option (1) (DESIGN §11 fan-out
  cost caveat).

---

## (f) Recommendation

1. **Adopt the profile reference as the trust leaf; keep the resolve+compare in a
   *derivation*, not the runner write-gate, for v1.** Replace §4's
   `voucherRegistry<RawDID>` with `memberProfiles: ProfileRef[]` (still
   owner-signed by Dave via `AdminRegistryValue`), and define "ours" as "author ==
   owner of some member profile." The comparison primitive *already exists and is
   tested* (`cf-cfc-authorship.ts:243–307`); v1 lifts it into a shared helper and
   uses it inside the coordinator's `computed()`. This is the smallest honest
   change and it strictly improves the cheat: no raw-DID maintenance, revocation
   = drop a profile ref, and the root of trust becomes the system's strongest
   guarantee (owner-protected `represents-principal`) instead of a bare string.

2. **Fold §4 and §6 into one object.** Let `memberProfiles` be simultaneously the
   trust anchor and the §6 fan-out set (DESIGN §6 option (1), §12 Q2). This is
   the unification the design was reaching for and the profile-reference shape
   makes it natural.

3. **Add `SameAuthorAs<T, Reference>` as a type-only alias now** (`cfc.ts`) to
   carry intent, even though v1 enforces it in derivation. Defer the real runner
   write-gate (C3 / `prepare.ts:1057`) as substrate follow-up, alongside the
   already-open `shared-profile-space.md:429` "profiles readable by collaborators"
   question — they should be decided together.

4. **Be explicit that the cheat moves, not disappears.** The owner-signed *set*
   (now of profile refs) is still the last-mile oracle; the improvement is the
   leaf's quality (profile-bound, unforgeable owner atom) and the unification with
   fan-out, not the elimination of an owner-curated membership list. This is fully
   in the spirit of DESIGN §4's honest "scaled trust, not trustlessness" caveat.

**Bottom line:** the proposal is *implementable on today's substrate as a
derivation* because the hard part — resolving a referenced profile's owner DID
and comparing it to a value's author — is **already working code** in
`cf-cfc-authorship`. What is genuinely new is (a) naming it as a CFC primitive
and (b) optionally promoting it from a UI verification badge to a runner gate.
For this design, (a) plus a §5 derivation is enough; (b) is real-but-deferrable
substrate growth.
