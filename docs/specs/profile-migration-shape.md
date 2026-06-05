# Profile Migration Shape — Legacy Learned Data → Shared Profile

## Status

Design proposal (CT-1646). DOC ONLY — no code changes implied by this file.

This document defines how the legacy "learned profile" data maps into the new
shared profile space. It is the written target the implementation issues derive
from. It intentionally does **not** propose inheriting the whole legacy shape.

## Context

Two prior pieces of work set up the world this proposal lives in:

- **Shared profile space** (CT-1645, `docs/specs/shared-profile-space.md`)
  introduced a real, owner-protected profile space with a small default-pattern
  contract (`name`, `avatar`, `elements`) and retargeted `wish({ query:
  "#profile" })` away from the old `learned.summary` shortcut to the profile
  default pattern.
- **Multiple profiles per user** (PR #3830,
  `feat(profiles): multiple profiles per user`) replaces the single home→profile
  link with a managed list. The home default pattern no longer owns a single
  `profile?: TrustedProfileLink`; it now owns:
  - `profiles` — durable list, appended on create
    (`packages/patterns/system/home.tsx`, new shape: `profiles: TrustedProfileList`)
  - `defaultProfile` — the profile `#profile` resolves to in headless / single
    callers and that orders first in the picker
  - `mru` — recency-ordered list driving the rest of picker ordering

  `wish({ query: "#profile" })` enumerates `defaultProfile` first then MRU, and
  launches `system/profile-picker.tsx` when ≥2 profiles exist; headless and
  single-profile callers get the default. `#profileName` / `#profileAvatar` /
  `#profileSpace` point at the default.

The shared profile default pattern shape today
(`packages/patterns/system/profile-home.tsx`, `ProfileHomeOutput`,
lines 74-85) is: `name`, `avatar`, `elements` (`ProfileElement[]`),
`initialNameApplied`, plus the owner-protected mutation streams. A `bio` /
`description` top-level field is being added separately in **CT-1648**; this
proposal assumes `bio` will exist as a top-level field and targets it.

### The problem

The legacy "learned" model is a large, low-precision blob populated by LLM
journal extraction. The new shared profile is small, explicit, and
**owner-protected and shared** (it is a real space other users / patterns can
read). Blindly inheriting the legacy shape would leak inferred, low-confidence,
and sometimes sensitive data into a shared surface. We must define a smaller,
explicit target first, and keep the inference machinery private.

## Legacy source of truth

The legacy model is `LearnedSection` in
`packages/patterns/profile.tsx` lines 139-159:

```ts
export interface LearnedSection {
  facts: Fact[];            // profile.tsx:141
  preferences: Preference[];// profile.tsx:142
  openQuestions: Question[];// profile.tsx:143
  personas: string[];       // profile.tsx:144
  lastJournalProcessed: number; // profile.tsx:145
  summary: string;          // profile.tsx:146
  summaryVersion: number;   // profile.tsx:147
}
```

Element shapes (also `profile.tsx`):

- `Fact` (lines 111-116): `content`, `confidence` (0-1), `source`
  (`"journal:..."` / `"user:direct"`), `timestamp`.
- `Preference` (lines 119-124): `key`, `value`, `confidence`, `source`.
- `Question` (lines 127-137): `id`, `question`, `category`, `priority`,
  `options?`, `status` (`"pending" | "asked" | "answered" | "skipped"`),
  `answer?`, `askedAt?`, `answeredAt?`.

`EMPTY_LEARNED` (lines 151-159) is the initialization default.

### Where the legacy data lives and how it is written

- The `learned` cell is a **home-private** `Writable<LearnedSection>` owned by
  the home default pattern: `home.tsx:129`
  (`new Writable<LearnedSection>(EMPTY_LEARNED).for("learned")`), exported as
  `learned` (`home.tsx:332`) and typed `learned: Writable<LearnedSection>`
  (`home.tsx:50`).
- The only first-party UI writer in production `home.tsx` is the **Profile
  Summary** textarea bound to `learned.key("summary")` (`home.tsx:224`). The
  comment at `home.tsx:216` is explicit that this free-form summary "lives on
  learned.summary, independent of the shared profile space" and is
  intentionally **not** resolved by the `#profile` wish.
- The richer inference (facts / preferences / personas / openQuestions /
  lastJournalProcessed) is populated by the LLM journal-extraction flow in
  `packages/patterns/system/home-ben.tsx` (e.g. `learned.set({...})` at
  `home-ben.tsx:263`, `:479`, `:503-506`; `lastJournalProcessed` at
  `home-ben.tsx:390`, `:478`). This is a derived, low-confidence, behavior-mined
  store — it is the part most dangerous to expose on a shared surface.
- `profile.tsx` itself only *renders* `learned` (read-only tables); it does not
  produce it. The pattern's own header even says journal watching / learning "is
  handled by home.tsx" (`profile.tsx:387-388`).

## Target categories

Every legacy field maps to exactly one of three destinations:

1. **top-level shared profile field** — a small, explicit, owner-protected field
   on `ProfileHomeOutput` (shared, readable by collaborators/patterns).
2. **profile element / typed section** — lives in the profile space but as a
   distinct piece in `elements[]` (or a future typed sub-section), not a
   top-level field. Still shared, but opt-in and self-contained.
3. **remains home-private** — stays on `home.defaultPattern.learned` in the
   private home space; never copied into the shared profile.

### Privacy model (grounding)

- **Home space** is the user's private singleton root (settings, favorites,
  journal, `learned`). It is not a shared/collaborative surface.
- **Profile space** is a real, *shared* space whose owner-controlled fields
  carry `represents-principal` owner integrity and are `WriteAuthorizedBy`
  trusted profile handlers / UI (`docs/specs/shared-profile-space.md`,
  "Authorization"). Other users and patterns can **read** it via `wish`.
- Therefore: moving data from `learned` (private) to the profile (shared) is a
  privacy *widening*. Default to keeping inferred and sensitive data private;
  only promote fields that are (a) intentionally user-authored and (b)
  appropriate to share.

## Field-by-field mapping

| Legacy field | Source (file:line) | Destination | Rationale | Privacy expectation |
|---|---|---|---|---|
| `summary` | `profile.tsx:146`; written via `home.tsx:224` | **top-level shared field** → `bio` (CT-1648) | User-authored free text describing themselves; exactly what a shared "bio" is. The single highest-value migration. | Owner-writable, world-readable within the profile space. Owner integrity + trusted-surface writes like `name`/`avatar`. User must be able to review before first publish (see migration semantics). |
| `summaryVersion` | `profile.tsx:147` | **remains home-private** (drop from profile) | Internal bookkeeping for "was the summary auto-regenerated"; meaningless once `bio` is a plain user-authored field. Not migrated; left on `learned` for any legacy reader. | Private. Never exposed on shared profile. |
| `personas` | `profile.tsx:144`; written by LLM in `home-ben.tsx` | **profile element / typed section** → optional `tags`/`personas` typed section, owner-curated | Short self-labels ("busy parent", "techie") are plausibly shareable and useful for discovery, BUT they are LLM-inferred. Do not auto-promote: surface as *suggested* tags the owner explicitly accepts into a profile section/element. | Inferred → starts private. Only the owner-accepted subset becomes shared. Unreviewed personas never auto-publish. |
| `facts` | `profile.tsx:141`; written by LLM in `home-ben.tsx` | **remains home-private** | Low-confidence, behavior-mined statements with `source`/`confidence`/`timestamp`. Sharing raw inferred facts on a collaborator-readable surface is the core privacy risk this proposal exists to prevent. The *signal* can still inform `bio`, but the raw store stays private. | Private. Never copied to profile. May be used locally to *draft* a `bio` suggestion the user edits/approves. |
| `preferences` | `profile.tsx:142`; written by LLM in `home-ben.tsx` | **remains home-private** | Same as `facts`: inferred key/value pairs with confidence/source. Useful for personalizing the user's own experience; not for a shared identity surface. | Private. Never copied to profile. |
| `openQuestions` | `profile.tsx:143`; written by LLM in `home-ben.tsx` | **remains home-private** | Clarification prompts and their answers are an interaction/onboarding artifact, not profile identity data. Answers may be sensitive. | Private. Never copied to profile. |
| `lastJournalProcessed` | `profile.tsx:145`; written by LLM in `home-ben.tsx` | **remains home-private** | Pure cursor/bookkeeping for the journal-extraction loop. No identity meaning. | Private. Never exposed. |

### Summary of the verdict

- **Exactly one** legacy field becomes a top-level shared field: `summary` →
  `bio`.
- **One** legacy field becomes a profile element / typed section, and only after
  owner review: `personas` → opt-in profile tags/personas section.
- **Everything else** (`facts`, `preferences`, `openQuestions`,
  `lastJournalProcessed`, `summaryVersion`) **remains home-private** and is never
  copied into the shared profile.

This deliberately keeps the shared profile small and high-precision, and keeps
the entire LLM inference store private.

## Proposed minimal target shared-profile shape (top-level fields only)

The shared profile default pattern (`ProfileHomeOutput`) top-level fields after
this migration:

```ts
type ProfileHomeOutput = {
  // existing (profile-home.tsx today)
  name: string;     // owner-protected
  avatar: string;   // owner-protected
  elements: ProfileElement[]; // owner-protected; profile-space pieces

  // added by CT-1648 (assumed), targeted by this migration
  bio: string;      // owner-protected free text  ← legacy `learned.summary`

  // unchanged plumbing
  initialNameApplied: string;
  // + owner-protected mutation streams (setName, setAvatar, addElement, ...)
};
```

No new top-level fields are introduced by *this* proposal beyond `bio`
(which CT-1648 owns). `facts` / `preferences` / `questions` / `personas` are
intentionally **absent** from the top-level shape. `personas`, if surfaced at
all, appears as an owner-curated profile element / typed section, not a
top-level field.

## Multi-profile migration semantics

A user now has zero, one, or many profiles (`profiles[]` + `defaultProfile` +
`mru` on the home default pattern, per PR #3830). The legacy `learned` blob is a
**single** home-private object. Mapping a single legacy blob onto a multi-profile
world:

- **Target = the default profile.** When migrating, the legacy `summary` →
  `bio` write lands on **`home.defaultProfile`** (the profile `#profile`
  resolves to headlessly). This matches user intuition ("my main profile") and
  the resolver's default-first ordering.

- **0 profiles (no profile yet).** Do **not** auto-create a profile space just to
  hold a migrated bio. Instead, leave `learned.summary` in place (it is already
  private and still rendered by the home Profile tab). The migration runs
  **on first profile creation**: when `submitProfileCreation` appends the first
  profile, seed that profile's `bio` from `learned.summary` (subject to owner
  review — see below). This avoids spinning up shared spaces for users who never
  opted in.

- **1 profile.** That profile is (or becomes) the default. Migrate
  `learned.summary` → `defaultProfile.bio` once. Idempotency guard: only seed if
  the target `bio` is empty, so a user who has already edited their bio is never
  overwritten.

- **Many profiles (Work / Personal / Family).** Migrate into the **default
  profile only**. Non-default profiles (Work, Family, …) start with an empty
  `bio` and are populated independently by the user. The legacy blob has no
  notion of multiple personas-as-profiles, so fanning it out would be wrong and
  privacy-leaky (e.g. personal facts bleeding into a Work profile).

- **Privacy gate / review.** Because this is a private→shared widening, the
  seed must be **owner-reviewable**, not silent. Recommended: seed `bio` as a
  *draft/suggestion* the owner confirms (or seed only on an explicit "import my
  summary" action in the profile/picker UI). At minimum, only seed when `bio` is
  empty and only the user-authored `summary` (never `facts`/`preferences`).

- **`personas` (if surfaced).** Same default-profile targeting and same
  owner-review gate. Inferred personas are offered as *suggested* tags on the
  default profile; nothing publishes without owner acceptance.

- **What never migrates.** `facts`, `preferences`, `openQuestions`,
  `lastJournalProcessed`, `summaryVersion` stay on `home.learned` regardless of
  profile count. The journal-extraction loop in `home-ben.tsx` keeps writing
  them privately and may keep informing local suggestions.

## Derived follow-up issues

Concrete sub-tasks that can become Linear issues from this proposal:

1. **Seed `bio` from `learned.summary` on first profile creation.**
   In `submitProfileCreation` (`packages/patterns/system/profile-create.tsx`),
   when the first profile is appended, copy `home.learned.summary` into the new
   default profile's `bio` (only if `bio` is empty). Depends on CT-1648 landing
   `bio`.

2. **Backfill `bio` for users who already have a default profile.**
   One-shot/idempotent migration that, for existing `home.defaultProfile` with
   empty `bio`, seeds it from `learned.summary`. Guard on empty target.

3. **Owner-review gate for the bio import.**
   Add an explicit "Import summary into bio" affordance (or a draft/confirm step)
   in the profile picker / profile-home UI so the private→shared promotion is
   never silent.

4. **Optional: surface `personas` as suggested profile tags.**
   Define the owner-curated personas/tags typed section or element shape on the
   profile, and an accept-suggestion flow that pulls from `learned.personas`.
   Lower priority; can be deferred.

5. **Decide the fate of the home "Profile Summary" textarea.**
   Once `bio` exists, decide whether the `home.tsx:224` textarea (bound to
   `learned.key("summary")`) becomes a read-only mirror, redirects to edit
   `defaultProfile.bio`, or is removed. Avoid two divergent editable copies.

6. **Confirm `learned` stays home-private and untouched by `#profile`.**
   Add/keep a test asserting `wish({ query: "#profile" })` never reads
   `learned.facts/preferences/openQuestions`, preserving the
   `home.tsx:216-219` intent under the multi-profile resolver.

7. **Document non-default profiles start with empty `bio`.**
   Ensure Work/Family profiles created via the picker do not inherit the default
   profile's migrated bio (no fan-out).

## Open questions

- Should the bio import be opt-in (explicit action) or opt-out (seeded as a
  draft the user can clear)? This proposal recommends owner-reviewed seeding;
  product can tighten to fully explicit.
- If a user has multiple profiles at backfill time but the *default* already has
  a non-empty bio, do we offer the legacy summary to a different profile, or
  drop it? Recommended: drop (leave it on `learned.summary`); never auto-fan-out.
- Does `personas` justify any shared surface in v1, or should it stay fully
  private until a dedicated tags feature exists?
