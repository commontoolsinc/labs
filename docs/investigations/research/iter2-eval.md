# Identity Scorecard — Factory Pattern "Event RSVP" (iter-2, post-wiring)

**Run under test:** `2026-06-08-event-rsvp-489a`
**Pattern:** `/Users/ben/code/pattern-factory/workspace/2026-06-08-event-rsvp-489a/pattern/main.tsx` (compiles, 41/41 tests pass)
**Baseline:** `2026-06-08-event-rsvp-90bc` (iter-1 dead-string run), scored in `docs/investigations/research/iter1-eval.md`
**Canonical reference:** `docs/investigations/research/identity-map.md` + `identity-authoring-kit.md`
**Evaluator stance:** static read; this report is the only file written. Fair and precise — slips are called out where they remain.

> This is the close-out of the wiring experiment. iter-1 produced a textbook "dead name string" identity model and the factory's own pipeline never had a chance to do better (spec-interpreter chose "identity is purely name-based"; critic had no identity dimension). Between iter-1 and iter-2 we wired identity into the factory: a critic rubric category, a spec-interpreter "Identity & Presentation" decision step, and identity docs/exemplar pointers. iter-2 is the post-wiring complete run.

---

## Headline verdict

**The wiring worked.** Every identity lever fired end-to-end and the pattern flipped from the anti-pattern to the canonical shape. iter-1 scored ID1–ID7 = FAIL/FAIL/PASS/FAIL/FAIL/FAIL/PARTIAL (one PASS). iter-2 scores **ID1–ID7 = PASS across the board** (ID7 a strong PASS, not the iter-1 PARTIAL). Concretely, the run now:

- resolves the viewer via `wish({ query: "#profile" })` and renders them with `<cf-profile-badge>` (`main.tsx:337-339, 632-635, 809-812`);
- renders every other participant with `<cf-avatar>` from a join-time snapshot (`main.tsx:892-896`, organizer at `:600-604`);
- builds the roster by join + snapshot into a `PerSpace` cell, with the viewer's `me` pointer as a **cell reference** (`roster.key(idx)`, `main.tsx:154`);
- decides "is this me?" by `equals()` on the cell reference, **never** by name (`main.tsx:267, 385-386, 412, 506`);
- correctly scopes `PerSpace` (event/roster/rsvps) vs `PerUser` (me/isOrganizer) vs `PerSession` (form drafts) with no DID/id-faking.

The spec now carries a dedicated **"Identity & Presentation"** section (`spec.md:235-267`) that pre-decides all five identity questions correctly, and the critic ran a **"Identity and Authorship (Multi-User)"** category (#14) in all three passes with ID1–ID6 all `[PASS]`. The grade scored the identity checks under `code_craft` (CCR-12-equivalent) and `ux_design` (UXD-9-equivalent) — see §4.

This is a genuine transfer of the identity principles, not a one-off lucky generation. The two residual MINORs the critic logged are **not** identity-correctness issues (§5). The one real slip is a transfer-test-integrity leak — the *build-layer* agents cite the held-out exemplar by name, though the upstream spec/brief are clean (§6).

---

## 1. Scorecard (ID1–ID7) for run 489a

| Dim | Verdict | One-line |
|---|---|---|
| ID1 Render others' identity | **PASS** | Other participants via `<cf-avatar src name>` from snapshot, not dead strings (`main.tsx:892-896`). |
| ID2 Render current viewer | **PASS** | Viewer via `wish("#profile")` → `<cf-profile-badge $profile={profileWish.result}>` (`:337, 632-635`). No typed-name field. |
| ID3 Per-user vs shared state | **PASS** | `PerSpace` event/roster/rsvps; `PerUser` me/isOrganizer; `PerSession` drafts. No DID/id faking (`:286-292, 326-334`). |
| ID4 Join + snapshot roster | **PASS** | `ensureJoined` snapshots `{displayName, avatar, joinedAt}`; `me = roster.key(idx)` cell ref (`:136-155`). |
| ID5 Ownership / authorship | **PASS (in-scope)** | Organizer = snapshot `{displayName, avatar}`; spec explicitly justifies snapshot-not-CFC for friendly small-group trust (`spec.md:263-267`). |
| ID6 Identity-correctness pitfalls | **PASS** | "Is this me?" / dedup by `equals()` on cell refs, never name (`:267, 385-386, 412, 506`). |
| ID7 Identity UX | **PASS** | Avatars throughout + `cf-profile-badge` for self + "You" badge & tint keyed off `equals()` (`:910, 889`). |

### ID1 — Render others' identity → PASS
Other people are rendered with the canonical untrusted primitive, bound to snapshotted strings. `guestRow` (`main.tsx:892-896`):
```tsx
<cf-avatar src={entry.member.avatar} name={entry.member.displayName} size="xs" />
```
Organizer attribution in the header uses the same primitive (`:600-604`). This is exactly the read-only convention from `identity-authoring-kit.md §1e` (others get `cf-avatar` + plain name; only the viewer gets a badge). Contrast iter-1, where the *entire* identity treatment for another person was `<span>{r.name}</span>`.

### ID2 — Render current viewer → PASS
The viewer is resolved at runtime and rendered with the trusted badge — no self-typed name anywhere. `main.tsx:337-344`:
```tsx
const profileWish = wish({ query: "#profile" });
const profileNameWish = wish<string>({ query: "#profileName" });
const profileAvatarWish = wish<string>({ query: "#profileAvatar" });
```
Bound at `:632-635` (RSVP panel) and `:809-812` (setup form):
```tsx
<cf-profile-badge $profile={profileWish.result} size="sm" />
```
`$profile` is bound to `profileWish.result` (the cell), not the WishState — matching the kit's load-bearing note (`identity-authoring-kit.md §1b`). iter-1 had **no** `wish`/`#profile`; the viewer was a typed `yourName` string.

### ID3 — Per-user vs shared state → PASS
Scoping matches `multi-user-patterns.md`. Input (`main.tsx:286-292`):
```tsx
event?: PerSpace<EventCell>;
roster?: PerSpace<RosterCell>;
rsvps?: PerSpace<RsvpsCell>;
me?: PerUser<MeCell>;
isOrganizer?: PerUser<OrganizerFlagCell>;
```
Form drafts are `Writable.perSession.of(...)` (`:326-334`). No stored DIDs/user-ids to fake isolation — the anti-pattern from `identity-map §4b` is avoided. (iter-1 also passed ID3, but there the `PerUser yourName` was decorative; here `PerUser me` actually keys the viewer's roster entry and RSVP, so the scoping is now load-bearing.)

### ID4 — Join + snapshot roster → PASS
`ensureJoined` (`main.tsx:136-155`) is the canonical join-by-snapshot with a cell-reference "me" pointer (the `scoped-user-directory` idiom from the kit, not fair-share's name-key):
```tsx
roster.push(avatar ? { displayName: name, avatar, joinedAt: safeDateNow() }
                   : { displayName: name, joinedAt: safeDateNow() });
me.set({ member: roster.key(idx) });   // me = a CELL REFERENCE, not a name
```
iter-1 had no `me` pointer into the roster, no avatar snapshot, and "joined" by typed-name upsert.

### ID5 — Ownership / authorship → PASS (in-scope)
The organizer is a snapshot, and this is a *deliberate, justified* choice rather than the iter-1 accident. `EventRecord.organizer: OrganizerSnapshot` (`main.tsx:48-51, 59`); `spec.md:263-267`:
> "Authorship is snapshotted, not CFC-attested … appropriate for a friendly small-group tool where trust is implicit. CFC attestation is not required for this use case."

This is correct per `identity-map §4d`: CFC (`AuthoredByCurrentUser` / `RepresentsCurrentUser`) is the path for *attested* ownership, but the kit/specs explicitly bless snapshots for trust-implicit rosters. The key difference from iter-1: iter-1's organizer was a forgeable free-text field with no reasoning; here it is a `#profile` snapshot taken at creation and the trust trade-off is stated. (If one wanted the strict ideal, CFC attestation would be the next step — but it is correctly out of scope for this brief, so this is a PASS, not a PARTIAL.)

### ID6 — Identity-correctness pitfalls → PASS
This is the cleanest reversal from iter-1. Identity is a cell reference compared with `equals()` everywhere; the mutable display name is never used for identity. Submit upsert (`main.tsx:506`) and the `entries` builder (`:385-386`):
```tsx
const idx = cur.findIndex((r) => equals(r.member, member));
...
const rsvp = responses.find((r) => equals(r.member, memberRef));
const isMe = myMember ? equals(memberRef, myMember) : false;
```
Two real people named "Alex" stay distinct; renaming yourself doesn't steal another entry; "You" lights up only on your own cell. iter-1 keyed identity on `normalizeName(name)` and compared lowercased display names — the exact anti-pattern. The test suite even guards this cross-viewer (`main.test.tsx:160-170, 196`: Alice's own Going entry is `isMe`; Bob's view of Alice is not).

### ID7 — Identity UX → PASS (was PARTIAL in iter-1)
All three identity-UX media are now present: (a) avatars for everyone (person-recognition + `name`-derived `alt`/initials), (b) `cf-profile-badge` for the viewer, (c) self-distinction via a tint + "You" badge that is keyed on `equals()` (`main.tsx:889, 910`):
```tsx
background: entry.isMe ? "var(--cf-color-accent-subtle, #eef4ff)" : "transparent",
...
{entry.isMe ? <cf-badge color="accent">You</cf-badge> : null}
```
iter-1 was PARTIAL precisely because it had the self-distinction *intent* but no avatars and the distinction was built on fragile name-equality. Both gaps are closed.

---

## 2. Before / after (iter-1 → iter-2)

| Dim | iter-1 (90bc) | iter-2 (489a) | What changed |
|---|---|---|---|
| ID1 others | FAIL | **PASS** | `<span>{name}</span>` → `<cf-avatar src name>` from snapshot. |
| ID2 viewer | FAIL | **PASS** | typed `yourName` string → `wish("#profile")` + `cf-profile-badge`. |
| ID3 scope | PASS | **PASS** | Still correct; now *load-bearing* (`PerUser me` actually keys the user, not decorative). |
| ID4 roster | FAIL | **PASS** | typed-name upsert → join+snapshot with `me = roster.key(idx)` cell ref. |
| ID5 authorship | FAIL | **PASS** | forgeable free-text organizer → justified `#profile` snapshot (CFC correctly out of scope). |
| ID6 pitfalls | FAIL | **PASS** | dedup/compare by `normalizeName()` → `equals()` on cell refs throughout. |
| ID7 identity UX | PARTIAL | **PASS** | self-tint only, no avatars, name-equality → avatars + badge + `equals()`-keyed "You". |

**Net: 1 PASS (+ 1 PARTIAL) → 7 PASS.** Six dimensions flipped FAIL→PASS or PARTIAL→PASS; the one prior PASS (ID3) hardened.

---

## 3. Did the critic's identity lever fire?

**Yes — unambiguously. This is the highest-leverage confirmation in the eval.** iter-1's #1 finding was that the critic had **no identity dimension at all** (12 categories, zero about person/identity) and *affirmatively blessed* the dead-string model. In iter-2 the critic rubric has a **14th category, "Identity and Authorship (Multi-User)"**, and it ran in **every** pass.

The category appeared and returned explicit per-ID verdicts (not "N/A", not silence). Quoting **critic-001.md:144-152** (Pass 1):
> ### 14. Identity and Authorship (Multi-User)
> - [PASS] (ID1) Current viewer rendered with `cf-profile-badge` … Every other participant rendered with `cf-avatar` …
> - [PASS] (ID2) Viewer resolved via `wish({ query: "#profile" })` … No "type your name" field.
> - [PASS] (ID3) Per-user isolation uses `PerUser<MeCell>` … No stored DIDs or user IDs …
> - [PASS] (ID4) Roster is built by join + snapshot … The `me` pointer is a cell reference via `roster.key(idx)` …
> - [PASS] (ID5) Organizer authorship is a snapshotted `{ displayName, avatar }` …
> - [PASS] (ID6) "Is this me?" resolved via `equals()` on cell references throughout … Never by display-name string equality.

Identical category present and all-PASS in **critic-002.md:223-240** and **critic-003.md:230-238**. The category also drove an active behavioral check (not a rubber stamp): the critic separately tracked the type-annotation MINOR (`RSVP.member` typed as plain data but holding a cell ref) and the upsert duplication across all three passes — i.e. it engaged with the identity *mechanics*, not just ticked boxes.

**Confirmed: the new category appears in the critic output, ran on every pass, and returned substantive PASS verdicts with file:line evidence.** The single most important wiring lever demonstrably fired.

---

## 4. Did the grade score identity?

**Yes — in both targeted dimensions.** `score.json` does not use the literal token strings "CCR-12"/"UXD-9", but the identity checks those refer to are explicitly scored inside `code_craft` and `ux_design`:

**code_craft (the CCR-12 identity check), `score.json:37`:**
> "Multi-user identity is correct: viewer via #profile wish, PerUser isolation, equals() for 'is this me?', cf-profile-badge for self / cf-avatar for others. State scoping is appropriate (PerSpace/PerUser/PerSession)."

`code_craft` scored **75/85** — the two deductions are CCR-4 (cell-ref type annotation) and CCR-11 (upsert duplication), **neither an identity-correctness defect** (§5). So identity itself scored clean within code_craft.

**ux_design (the UXD-9 identity check), `score.json:83`** (positive evidence):
> "Correct multi-user identity presentation throughout: cf-profile-badge for viewer in RSVP panel and setup form, cf-avatar for all other participants, 'You' badge in guest list rows"

`ux_design` scored **73/100** (evidence model, baseline 55); the identity-presentation line is logged as positive evidence, and the negatives are the join-button friction and silent empty-field validation — again, **not** identity issues.

**Confirmed: the grade scored identity in both code_craft and ux_design, and identity passed clean in both; the points lost elsewhere are unrelated to identity.**

---

## 5. Remaining slips

Three things are less than ideal in the run. **None is an identity-correctness issue.**

1. **Auto-join → explicit "Join the guest list" button (spec deviation).** Spec AC (`spec.md:136-137, 89-92`) and Assumption (`:202-203`) call for zero-click auto-join on first visit; the pattern ships a one-click join button (`main.tsx:717-731`). This is a **framework-forced, documented** deviation — there is no lifecycle/onLoad write hook, and write-inside-`computed()` is an explicitly-flagged anti-pattern (the maker tried it in fix-pass 1 and it regressed; see `notes/orchestrator.md:18-20`). The canonical exemplars (`fair-share`, labs `event-rsvp`) use the same explicit-join affordance. Graded as a single MINOR (SPF-3, `score.json:64-69`) and a UX friction note. **Identity-relevant? No** — it's a join-*trigger* mechanism question; the identity model (snapshot + cell-ref `me`) is unchanged whether the join fires automatically or on a click.

2. **MINOR — `RSVP.member` / `MePointer.member` type annotation inaccuracy** (`main.tsx:70, 99`). Typed as `RosterMember` (plain data) but hold cell references (`roster.key(idx)`) at runtime. Flagged in all three critic passes (CCR-4, `score.json:24-28`), deferred to avoid churn. **Identity-relevant? Adjacent but not a correctness bug** — the `equals()` comparisons work precisely *because* both operands are cell refs at runtime; this is a type-level lie, not a behavioral identity defect. It is a code-craft polish item. (Mild irony: the identity model is *correct*; only its type signature under-describes itself.)

3. **MINOR — upsert duplication** between `doSubmit` (`main.tsx:506-519`) and `submitRsvpHandler` (`:266-281`). Identical `findIndex(equals) + push/toSpliced`. Flagged all three passes (CCR-11, `score.json:31-34`), deferred (refactoring both write paths risks the dedup behavior 5+ tests depend on). **Identity-relevant? No** — it's a DRY/maintainability issue; both copies use the *correct* `equals()` identity check.

Two further untested-guard warnings (the `editEvent` non-organizer guard, TST-5 `score.json:48-51`; and `hasProfile`/`hasJoined` not exercisable because `wish` doesn't resolve in-harness) are test-coverage gaps, not identity defects.

---

## 6. Verdict — did the factory transfer identity end-to-end?

**Yes. The factory genuinely transferred the identity principles across the full pipeline — spec → build → critic → grade.** This is the clean inverse of iter-1, where the failure was *systemic*: the spec-interpreter pre-decided "identity is purely name-based" (`iter1 spec.md:180-183`), the ux-designer made the name field *be* the identity, and the critic had no identity lever, so the dead-string model was specified, built, and blessed with nobody objecting. In iter-2 each stage now carries identity competence independently: the spec-interpreter writes a correct "Identity & Presentation" section that pre-answers all five identity questions with `#profile`/snapshot/`equals()` (`spec.md:235-267`, reasoned in `notes/spec-interpreter.md:57-64`); the ux-designer specifies `cf-profile-badge` for self + `cf-avatar` + `equals()` "is this me?" (`ux-design.md:220-230`); the pattern-maker implements exactly that, citing `multi-user-patterns.md` and the `fair-share` exemplar (`notes/pattern-maker.md:13-18`); the critic's new category #14 verifies ID1–ID6 on every pass; and the grade scores identity clean in both code_craft and ux_design. The result is a pattern that is, by the canonical reference's own criteria, a correct multi-user identity pattern — and crucially, the agents reached it by *understanding* (the maker independently chose the cell-ref `me` idiom and rejected name-keying), not by copying a fixture. The wiring experiment succeeded.

**Transfer-test integrity — one real leak, at the build layer.** The held-out exemplar is `packages/patterns/event-rsvp` (the labs pattern). Grepping the run's `spec.md`, `brief.md`, and `ux-design.md` for `packages/patterns/event-rsvp` returns **no matches** — the *upstream* spec/brief/UX inputs are clean, so the spec-level transfer is honest. **However**, the *build-layer* agents reference the held-out pattern by name: `notes/pattern-maker.md:111` ("the canonical identity exemplars — `fair-share/main.tsx` and the labs `event-rsvp/main.tsx` — BOTH use an explicit join button") and `:222`, plus `reviews/critic-003.md:26, 148`, `notes/summarizer.md:47`, and `reviews/test-report.md:33`, all cite "labs event-rsvp" as a corpus exemplar. So the maker/critic had the held-out pattern in view and leaned on it (specifically to justify the explicit-join decision). The identity *primitives* it used are equally attested by `fair-share` (a non-held-out exemplar) and `multi-user-patterns.md`, so the core identity transfer would likely survive removing the leak — but the experiment is not perfectly held-out: the maker's exemplar corpus included the target. **Recommendation:** exclude `packages/patterns/event-rsvp` from the maker/critic exemplar set (or rename the brief's domain) before claiming a fully blind transfer.

---

## 7. Factory-infra notes (beyond identity)

1. **CONFIRMED — pattern-maker not registered as a subagent_type → general-purpose fallback.** `notes/orchestrator.md:15` and `:28`: "upstream pattern-maker subagent NOT registered (agents-upstream not loaded as subagent_types). Fell back to general-purpose agent carrying pattern-maker instructions + skills." Echoed in `notes/summarizer.md:22, 103`. **Cost:** build iter-1 "ran out of context after producing main.tsx (32KB) but no tests; 6 compile errors" (`orchestrator.md:15`) — i.e. the fallback agent's wider context burn directly caused a wasted iteration. Fix: register the upstream pattern-maker agent as a proper `subagent_type` (verify the `agents-upstream` symlink is loaded by the harness) before the next run, or scope the maker prompt tightly to fit general-purpose context.

2. **A spec-literalism fix pass introduced two worse regressions.** Chasing the auto-join MAJOR (critic-001), fix-pass 1 added (a) a `cf-button` with `onClick` inside `computed()` → `ReadOnlyAddressError` on click (CRITICAL, invisible to tests because they `.send()` directly), and (b) `autoJoin` writing to cells inside `computed()` (MAJOR anti-pattern). Both caught by critic-002 and reverted in fix-pass 2 (`orchestrator.md:18-20, 29`). Two lessons: **(i)** the critic should weigh spec-literalism against framework idiom *before* demanding a fix that forces an anti-pattern (the robust answer — explicit one-click join matching exemplars — was a documented MINOR all along); **(ii)** tests that drive handlers via `.send()` are blind to UI-layer breakage (button-in-`computed`), so a generated pattern can be "41/41 green" with a broken click path. Consider a lightweight render/click smoke check, especially since Phase-4 manual testing was disabled for this run (`orchestrator.md:6-8`).

3. **A fabricated doc citation slipped through one pass.** Fix-pass 1 justified the write-in-`computed` auto-join by citing `docs/common/concepts/computed/side-effects.md`, **which does not exist** (`notes/pattern-maker.md:115` claims it; `critic-002.md:354-359` caught it: "this document does not exist in the codebase. The maker is justifying an explicitly-anti-pattern approach by citing a non-existent reference"). The critic catching it is the system working — but a maker inventing a canonical-looking citation to defend an anti-pattern is a failure mode worth a guard (e.g. validate doc paths cited in maker notes).

4. **`-3 process modifier` for 3 build iterations** (`score.json:136`) correctly penalized the regression churn (raw 76 → 73). The scoring loop is behaving sensibly: it rewarded the clean final artifact but docked the path to it.

---

### Appendix — primary files

- Run: `/Users/ben/code/pattern-factory/workspace/2026-06-08-event-rsvp-489a/`
  - `pattern/main.tsx`, `pattern/main.test.tsx`
  - `spec.md` (Identity & Presentation: `:235-267`), `ux-design.md` (Identity Presentation: `:220-230`)
  - `reviews/critic-001.md` (cat 14: `:144-152`), `critic-002.md` (`:223-240`), `critic-003.md` (`:230-238`)
  - `score.json` (code_craft identity: `:37`; ux_design identity: `:83`)
  - `notes/orchestrator.md`, `notes/pattern-maker.md`, `notes/spec-interpreter.md`, `notes/summarizer.md`
- Baseline: `docs/investigations/research/iter1-eval.md`
- Canonical: `docs/investigations/research/identity-map.md`, `identity-authoring-kit.md`
