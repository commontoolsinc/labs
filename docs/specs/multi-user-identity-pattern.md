<!-- STATUS: DRAFT / RFC — for review (cc: Bernhard). Not implemented. -->

# Multi-User Identity & Join for Patterns (RFC)

**Status:** Draft / request-for-comment — *not yet implemented*
**Author:** Alex (with Claude Code)
**Reviewers:** Bernhard (runtime), …
**Date:** 2026-06-04
**Driving pattern:** `packages/patterns/fair-share/main.tsx` (a shared expense ledger; the first consumer)

> **What I want from this review:** agreement on the data-model idiom for "participants in a multi-user pattern," and answers to the **Open Questions** (§8) — especially (a) cross-user profile readability, (b) the PerSpace-array-element reactive-traversal limitation, and (c) how much CFC a normal multi-user pattern should carry. If we get this right once, every multi-user pattern (polls, trips, chores, chat) can copy it.

---

## 1. TL;DR

Today every multi-user pattern re-invents "who am I / who's in this," usually as dead **name strings** (`names: string[]` + `myName: PerUser<string>`). That's the documented anti-pattern (`group-chat-lobby.tsx`) and it's exactly what `fair-share` does now: renames orphan references, two "Alex"es collide, and a viewer must type their name even though the product already knows it.

This RFC proposes a **pattern-native** identity model that leans on runtime affordances that are hard in normal frontends:

1. **Reference people as live profile references, not strings.** Each viewer contributes a reference to *their own* `PerUser` profile cell into the shared `PerSpace` roster (the "Shared Directories and 'Me'" idiom, `docs/common/patterns/multi-user-patterns.md:153-197`). Everyone resolves each person's **live** name/avatar through that reference → renames propagate everywhere for free; dedupe is reference identity via `equals()`, not string match.
2. **Seed identity from the shared profile.** `wish<string>({ query: "#profileName" }).result` gives the current viewer their own name automatically (per-user scoped) → one-tap "Join as <name>", no typing.
3. **First-run is free.** For a name-less viewer, embedding `{wish({ query: "#profile" })}` renders the runtime's **trusted profile-create surface** inline; creating a name there persists to the durable profile and is reused across every pattern.
4. **Profile-less people still work.** A roster entry is `{ name; profile? }`; "Grandma" (no app, no profile) is a name-only entry; expenses reference entries uniformly.
5. **Package it once.** Ship the above as a reusable drop-in identity/join surface so other multi-user patterns adopt it in one line — the "shining example."

---

## 2. Motivation

- **Consistency:** identity/join is reinvented per pattern, each with subtly different (often broken) semantics.
- **Correctness (money app):** `fair-share` references people by name in expenses; a rename or a duplicate name corrupts balances. Reference-identity removes that whole class of bug.
- **UX:** users shouldn't type a name the product already has; name-less users should be gently guided to set a profile name they can reuse everywhere.
- **Leverage:** cross-space reactive references + per-user/per-space scoping make "everyone sees everyone's live name/avatar with zero sync code" trivial in patterns and painful in a normal SPA. We should lean into that.

## 3. Goals / Non-goals

**Goals**
- A single idiomatic data model for "participants" reusable across multi-user patterns.
- Auto-pull each viewer's own profile name/avatar; one-tap self-join.
- Elegant first-run that helps name-less users create a durable profile name.
- Allow joining without a profile (one-off name).
- Rename- and dedupe-safe by construction.
- A reusable, documented drop-in component + a catalog entry.

**Non-goals**
- Real-time presence ("who's online now," cursors). Not supported today; out of scope (we use a guest-list framing, not online status).
- Editing an *existing* profile name from inside another pattern (CFC owner-protected; only first-run create is exposed).
- Replacing CFC admin/role machinery (orthogonal; `multi-user-patterns.md:230-288`).

## 4. Background — existing affordances (what we build on)

**4.1 Profile system (per-user, cross-space) — confirmed present on `main`.**
- Read the current viewer's name: `wish<string>({ query: "#profileName" }).result` → `string | undefined`, **auto per-user scoped** (resolution `packages/runner/src/builtins/wish.ts:728-759`; output narrowed to user scope via `usedHomeSpace` at `:264` / `:1200-1201`), reactive (subscribes to the live name at `:305-307`). Each viewer sees their own; no leakage (`integration/shared-profile.test.ts:65-97`).
- First-run create: rendering `{wish({ query: "#profile" })}` auto-renders the **trusted** `profile-create.tsx` surface when the viewer has no profile. Mechanism (worth knowing): `getProfileDefaultCell` *throws* for a name-less viewer (`wish.ts:287-292`), the throw is caught (`:1811-1815`), and the profile-persona target routes to the create surface (`:1539-1544`). Submitting it writes the durable profile + `profileName` mirror (`packages/patterns/system/profile-create.tsx:25-43`), after which `#profileName` resolves everywhere for that viewer. Canonical consumer: `packages/patterns/shared-profile-demo/main.tsx:5-27`. (Because it's an error-path render, a transient sync hiccup could momentarily flash the create surface — see §8.4.)
- `undefined` means *either* "no profile" *or* "still hydrating" (no distinct pending signal) — see Open Question §8.4.

**4.2 "Shared Directories and 'Me'" idiom — the blessed shape.**
`docs/common/patterns/multi-user-patterns.md:153-197` and `packages/patterns/scoped-user-directory/main.tsx`:
```ts
// shared, visible to all in the space
directory: PerSpace<{ users: User[] }>
// per authenticated viewer: a live pointer INTO the shared array
me:        PerUser<{ user?: User }>

const joinAs = handler(({ name }, { directory, me }) => {
  const users = directory.key("users");
  users.push({ displayName: name.trim() });
  me.set({ user: users.key(users.get().length - 1) }); // a LIVE reference, not a copy
});
```
`me.user` is a live cell reference; writing `me.key("user").key("displayName").set(...)` propagates back into the directory (`scoped-user-directory/main.tsx:39-59`; proven in its test). Rule from the guide: **"pass object/cell references … use `equals()` instead of custom `id` fields"** (`multi-user-patterns.md:199-202, 349`).

**4.3 Live profile references in shared records — `cfc-group-chat-demo`.**
Each user has a **per-user profile cell** (`Writable.perUser.of<TrustedProfile>(...)`, `trusted.tsx:425-429`); it's registered by reference into a shared list with `equals()` dedupe (`registerProfile`, `:382-394`); messages carry the **live** `authorProfile` cell + a **snapshot** `authorName` (`logic.ts:31-32`).

**The live-name render we need is shipping code.** The admin participant list renders each entry's live name from the shared `PerSpace` array with a bare `.map()` + a per-element `computed` that resolves the referenced cell — exactly §5.1's `entry.profile?.get()?.name`:
```tsx
// cfc-group-chat-demo/trusted.tsx:953-957
{profiles.map((entry) => {                 // bare reactive .map() over the PerSpace array
  const profile = entry.profile;            // per-entry cell reference
  const name = computed(() => profile.get()?.name ?? "Unnamed user"); // live resolve
```
The message transcript itself uses the **snapshot** `authorName` (`main.tsx:109`) plus CFC authorship verification — so "live name" and "snapshot" both appear, by choice. The base `multi-user-patterns.md:42-117` shows the same per-user-cell shape **without** CFC.

**Cross-user evidence (precise):** the integration test proves Bob's client sees Alice's *message* and that authorship *verifies* (`integration/cfc-group-chat-demo.test.ts:158-184`). It does **not** assert that an Alice *rename* propagates to Bob's view — that live-name-propagation path is exercised structurally (same `profiles.map` construct) but not asserted by a test. Closing that gap is in §10.

**Key fact:** cross-user visibility happens **because the reference lives in `PerSpace` storage that every space member can read** — *not* because profile spaces are globally readable. `#profileName`/`#profile` resolve only the *viewer's own* home space (`wish.ts:728-759`, user-scoped at `:1200-1201`); there is no `wish` target that reads another user's profile. See §8.1.

## 5. Proposed design

### 5.1 Data model

```ts
// A participant. `profile` is a live reference to that person's own PerUser
// profile cell when they've joined as themselves; absent for profile-less
// people (e.g. "Grandma") added by someone else.
interface RosterEntry {
  name: string;                 // snapshot/fallback label; also the only label for profile-less people
  profile?: ProfileCell;        // live ref: PerUser<{ name; avatar? }>, contributed on self-join
}

// Shared, visible to everyone in the space.
roster:   PerSpace<{ entries: RosterEntry[] }>
expenses: PerSpace<{ items: Expense[] }>

// Per authenticated viewer.
me:        PerUser<{ entry?: RosterEntry }>   // live pointer to my roster entry
myProfile: PerUser<ProfileCell>               // my live name/avatar cell (seeded from #profileName)
```

**Expenses reference participants by the live entry/profile reference, not by name:**
```ts
interface Expense {
  description: string;
  amount: number;               // integer-cents math as today
  paidBy: RosterEntry;          // a reference into roster.entries (equals-comparable)
  sharedBy: RosterEntry[];      // references; empty => everyone
  date: string;
}
```
- **Display name** anywhere = `entry.profile?.get()?.name ?? entry.name` (live for profiled people; snapshot for "Grandma").
- **Identity / dedupe** = `equals(a, b)` on the references (`multi-user-patterns.md:201-202`). Two real "Alex"es are distinct references; a rename changes only the displayed projection.
- **Balances/settle/total**: unchanged integer-cents algorithm, but keyed on entry references (via `equals`) instead of name strings.

### 5.2 Join flow ("represent me")

1. Ensure `myProfile` exists (a `PerUser` profile cell). Seed its `name` from `wish("#profileName").result` if present.
2. Push `{ name, profile: myProfile }` into `roster.entries` (dedupe by `equals`), and set `me.entry` to that new reference (mirrors `joinAs`, `scoped-user-directory/main.tsx:39-49`).
3. Expenses created later reference `me.entry` / other entries by reference.

### 5.3 First-run (name-less viewer)

Embed `{wish({ query: "#profile" })}` inline as the "set your name" surface (trusted create UI). On create, `#profileName` resolves and we auto-advance to one-tap self-join (using the `initialNameApplied` echo, `shared-profile-demo/main.tsx:8-11`). A quiet secondary "just use a name once" path writes a name-only entry (`profile` absent) for users who decline a profile.

### 5.4 Claim / dedupe (the J4 reconciliation)

A profile-less entry (e.g. "Grandma", or "Sam" added by the owner) is **claimed** by attaching the claimant's `profile` reference to the *existing* entry — never by renaming and never by adding a duplicate. Because expenses reference the entry, **all prior expenses stay valid** and immediately render the now-live name. Claiming is an **explicit tap** ("That's me"), never a silent auto-link — consent matters in a money app.

### 5.5 The reusable component (the "shining example")

A drop-in surface (sub-pattern composed `Identity({...})`, or a documented helper) with a minimal, generic contract:

```
Identity({
  roster,            // PerSpace directory cell
  me,                // PerUser pointer cell
  myProfile,         // PerUser profile cell
  profileNameWish,   // wish("#profileName")
  profileWish,       // wish("#profile") — for the first-run embed
  onJoin, onClaim,   // handlers the host wires (so the host decides what an entry means)
})
```
It renders exactly one state: **quiet** "You're <live name>" when joined (keyed off per-user `me`, which avoids the hydration flicker — §8.4); **"Join as <name>"** when profiled but not joined; **first-run create embed** when name-less; **"That's me"** claim affordance when an unclaimed entry matches. Host patterns supply what a roster entry means and how rows render; identity is handled. A poll, a trip splitter, a chore wheel all drop this in.

## 5A. Refinements adopted from stress-testing

Two reviews — a UX critique and a fabric-idiomaticity audit — sharpened §5. The recommended design = §5 **plus** the changes below (each cited to prior art). They make it more fabric-native and money-app-safe.

### Idiomaticity (lean harder on runtime affordances)
1. **Roster holds composed participant *pieces*, not bare cell refs.** Store a *minimal* participant piece — the `reading-item-detail` shape, **not** the 750-line `base/person.tsx` — exporting `[NAME]` (live name), `[UI]`, `profile`, and `mentionable`. This is the "store charm results, not raw data" idiom (`base/contacts.tsx:42-90`, `reading-list/reading-list.tsx:88-94`), and it buys per-person `[UI]`, `navigateTo`, and discoverability for free. (§9 originally called this "overkill" — that conflated a composed piece with a heavy editor piece.)
2. **Export `mentionable`** (the participants) and tag the ledger, so other patterns/agents in the space `wish` the people and the ledger (`reading-list.tsx:33,280`; `docs/common/conventions/wish.md:122-137`). This is the runtime-native form of the cross-pattern reuse §2 wants — better than a bespoke component contract.
3. **The reusable surface is a composed sub-pattern that exports `join`/`claim` `Stream`s and calls its own `wish`** — not a React-style `onJoin/onClaim` prop-bag. Matches `reading-list` stream exports (`:39-47`) and `system/profile-create.tsx:68`. Drops the `profileNameWish`/`profileWish` props (wish belongs at the sub-pattern's body level).
4. **Avatars are real in the model.** Resolve live from the contributed profile (`profile.get()?.avatar`) and/or seed from `#profileAvatar` (`wish.ts:761-766`), so §7's "avatars pulled live" is actually backed.
5. **Minimal CFC, not the full stack.** Wrap the self-contributed reference in a single `RepresentsCurrentUser<ProfileCell>` (`packages/api/cfc.ts:259`; `cfc-group-chat-demo/trusted.tsx:48-55`) to close the impersonation/claim hole with **one type** — explicitly *without* the trusted-surface `TrustedActionWrite` machinery (that exists for admin-protected writes, which fair-share lacks). Confirm enforceability with Berni (§8.3 / OQ-C).
6. **Self-describing expenses.** Carry payer/sharer references on each expense (already the model) and treat the standalone roster as the join/claim + expense-less-people surface; this sidesteps the concurrent-roster-push race (§8.8) for attribution. (`cfc-group-chat-demo` carries `authorProfile` on each message.)

### UX (usable + safe)
7. **Same-name disambiguation (P0).** Never show two bare "Alex" in the "Paid by" select, split chips, or balances — append a disambiguator ("· you" / relative join time / short ref-hash) and a color-distinct initials avatar. `equals()` correctness is invisible to the human *picking* a payer; surface it.
8. **Identity escape hatch (P0).** The quiet chip reads **"Posting as Ada ▾"** (states the consequence); tapping opens *This is you / I'm someone else (switch/un-join) / Edit name*. A money app must let a mis-joined user recover.
9. **Frame the first-run embed.** `profile-create` renders only a bare input + button (`system/profile-create.tsx:82-103`); the Identity surface must wrap it ("Add yourself to the ledger" + "saved to your profile, reused across apps") with an **equal-weight** one-off peer that states its cost ("use a name just for this ledger — you can claim it later").
10. **Ship an avatar fallback primitive.** There is no `cf-avatar`; cozy-poll/lunch-poll hand-roll initials circles (`cozy-poll/main.tsx:786-809`). The reusable component should render initials + accent color (profile-aware; neutral for profile-less) so adopters are consistent and same-named people differ by color. (Consider a real `cf-avatar` — OQ.)
11. **Anti-flicker for *others'* names.** Render the snapshot `name` immediately (muted), upgrade to the live name without layout shift; never blank-then-fill next to dollar amounts.
12. **Claim is explicit + confirmed.** "That's me" appears only on unclaimed (ideally name-matching) rows, gated by a confirm ("Her past expenses will show your name"); never silent.

## 6. User journeys (recommended design)

Each journey describes what the viewer *sees* and *does* under the recommended **Beacon-shell-over-roster-of-references** design. "Beacon" = the single adaptive identity affordance; "roster" = the people list of live profile references.

**J1 — Returning, profiled, already joined (the ~95% case).** The Beacon resolves off the durable per-user `me` pointer, so it renders immediately with no flicker: **"Posting as Ada ▾"**. Other people's rows show snapshot names instantly, upgrading to live names without layout shift as each profile cell syncs. Ada does nothing — every expense she adds is attributed to her entry by reference. Tapping the chip → *This is you / I'm someone else / Edit name*.

**J2 — Profiled, not joined yet.** Beacon shows **"Add yourself as Ada"** (name seeded from `#profileName`, no typing). One tap contributes `{ name: "Ada", profile: myProfile }` to the roster by reference and points `me` at it; the Beacon becomes the J1 chip. Ada never typed her name.

**J3 — No-profile newcomer.** Beacon's first-run state is a **framed create card**: heading "Add yourself to the ledger," the trusted `{wish("#profile")}` input, helper "Saved to your profile and reused across apps," and an equal-weight peer link "or use a name just for this ledger — you can claim it later." Creating a profile → `#profileName` resolves → auto-advances to one-tap join (via the `initialNameApplied` echo) and is recognized in future apps. The one-off path adds a profile-less entry `{ name }` and points `me` at it.

**J4 — Owner adds a non-app person ("Grandma"), who later claims it.** The owner adds "Grandma" as a name-only entry; expenses reference it; balances compute normally. Later Grandma opens the ledger: her unclaimed row surfaces **"That's me"** (name fuzzy-matches), gated by a confirm ("Claim 'Grandma' as you? Her past expenses will show your name."). On confirm, her `profile` reference is **attached to the existing entry** — never a rename, never a duplicate — so all prior expenses stay valid and immediately render her live name. No silent auto-link ever; consent is required.

**J5 — Concurrent newcomers (Ada + Grace at once).** Each self-joins from their own device, contributing a reference to *their own* profile cell; each sees their own name (per-user scoped, no leakage); both rows converge in the shared roster. *Defensive UX:* after self-join the Beacon confirms `me.entry`'s profile resolves to the viewer's own `myProfile` before showing "Posting as …"; if a concurrent-append index race (§8.8) leaves it unconfirmed, it shows "Finishing join…" with Retry rather than ever showing the wrong person.

**Edges.**
- *Two people named "Alex":* distinct references (`equals`), so balances never collide; every multi-person surface disambiguates ("Alex · you" / short ref-hash) + color-distinct avatar. Two bare "Alex" are never shown together.
- *Rename:* propagates live to every row, "Paid by" label, and past expense (`entry.profile.get()?.name`) — no stale strings.
- *Hydration flicker:* solved by keying the joined state off durable `me` (not the ambiguous `#profileName`); returning users never flash the create surface.
- *Offline / unsynced referenced profile:* `entry.profile.get()?.name` is `undefined` until B syncs A's cross-space cell → fall back to muted snapshot `entry.name`; names never blank out next to amounts.
- *Claim (general):* any profile-less entry can be claimed by attaching the claimant's own profile reference, behind a confirm; claiming never detaches/overwrites another's profile (see §8.3 / OQ-C).

## 7. Why this is pattern-native (vs naive `names: string[]`)

| Concern | Naive name-strings (today) | Live-reference roster |
|---|---|---|
| Rename | Stale strings; find/replace across the piece | `profile.get()?.name` updates everywhere reactively |
| Dedupe | Two "Alex" collide (string match) | `equals()` on references — distinct |
| Avatars | Copy + match by name | Pulled live from the one profile cell |
| Cross-user "who is this" | Just a string | Live reference; optional CFC-verified authorship |
| Reuse | Bespoke per pattern | The documented directory+me idiom; one drop-in |

## 8. Open questions (need Berni / runtime input)

**8.1 Cross-user profile readability — confirm the long-term mechanism.** We **commit** to the mechanism `cfc-group-chat-demo` already ships: each user *contributes* a reference to their own `PerUser` profile cell into `PerSpace`, which is then readable by all space members. We're not relying on ambient cross-user reads — there is no `wish` target that reads another user's profile, and `#profileSpace` cross-user readability is an **open question** in the profile spec (`docs/specs/shared-profile-space.md:426-430`) we are deliberately *not* depending on. The narrower questions: (a) is the contributed-per-user-cell-reference the intended long-term cross-user mechanism, or is a first-class "shareable profile handle" coming that we should target instead so we don't bake `{ profile: myProfileCell }` into the roster shape and migrate later? (b) Does a contributed reference to *my* profile cell let other members read my name/avatar but **not** mutate it (owner-protected), as desired?

**8.2 Live-name rendering from a shared array — *believed solved; please confirm the blessed form.***
The core render ("everyone sees everyone's live name") is **already shipping** in `cfc-group-chat-demo/trusted.tsx:953-957`: a bare `.map()` over the `PerSpace` array + a per-element `computed(() => entry.profile.get()?.name)`. We'll copy that exact form. Two adjacent footguns we'll avoid (confirm we've got them right):
- **Scalar field proxy-traversal of array elements is broken** — `directory.users[0]?.displayName` returns `undefined` reactively (`scoped-user-directory/main.test.tsx:50-51`). The working form resolves through a **cell reference** (`entry.profile.get()`), not an inline scalar; is that the right mental model (refs traverse, inline scalars don't)?
- **Don't wrap the `.map()` in `computed()`**, and don't chain `.filter()/.map()` on a reactive `.get()` array — both break transformer inference / rewrite to `*WithPattern` and throw (`fair-share/main.tsx:237-258`). Bare `.map()` + `findIndex(equals)` for removal is the safe shape. Is that the durable guidance?

**8.3 Integrity / CFC — likely first-class for a money app, not "later."** Without CFC, `roster.entries` is plain `PerSpace` state, so **any space member can push entries, rewrite an entry's `profile` reference, or "claim" (attach their profile to) someone else's entry** (§5.4). In an expense ledger that's a real integrity hole — member B could attribute debt to A or impersonate A. `cfc-group-chat-demo` mitigates with `RepresentsCurrentUser` integrity + trusted surfaces (`packages/api/cfc.ts:259`); `scoped-user-directory` / the `multi-user-patterns.md` base shape use plain per-user cells + `equals` with **no** CFC. **Questions:** (a) For the money use case, should identity contributions be CFC-authored (`RepresentsCurrentUser`) from day one — i.e., is the plain-cell shape only acceptable for low-stakes patterns? (b) What's the *minimum* CFC surface that's still simple enough to be an exemplary template others copy without cargo-culting the whole `cfc-group-chat-demo`? (c) Can `claim` be made safe (only the claimant may attach their own profile; nobody may detach/overwrite another's) with a small integrity type rather than a full trusted surface?

**8.4 Hydration / pending signal.** `#profileName.result` is `undefined` for *both* "no profile" and "still loading," so a naive first-run surface can flash at a user who actually has a profile. Our mitigation is to drive the joined/quiet state off the durable per-user `me` pointer (not off `#profileName`), so returning users never flash. Is there (or should there be) a `.pending`/loading signal on `wish` results so the first-run surface can be exact rather than relying on this indirection?

**8.5 Should "identity / join with profile" be a stdlib/runtime primitive?** Ground-truth says there's **no turnkey "represent me in this shared space" helper** today — each pattern wires per-user-cell + push-by-ref + dedupe by hand. Given we want this to be a cross-pattern best practice, should the reusable surface live as a shipped sub-pattern/helper (and where — `packages/patterns/…`, a stdlib, the catalog), or stay copy-from-example? Strong preference?

**8.6 Expenses-by-reference vs the transformer — *resolved; noted for completeness.*** Referencing entries by cell-reference in `PerSpace` arrays uses the `equals`/`comparable` schema-inference path that recently had bugs — but **CT-1639** (comparable inference dropped under `Default<>`) and **CT-1663** (array↔object differ) are **fixed on `main`** (#3841/#3855, #3871), and `fair-share` already removed its workaround and runs the `findIndex(equals)` removal on `Default<>` arrays (`fair-share/main.tsx:248-249`). So "reference in a `PerSpace` array, compared via `equals`, removed via `findIndex(equals)`" is now a trodden, safe path. (Flagging only so the reviewer knows we considered it; not an open ask unless you foresee an issue with references-to-cells specifically vs references-to-plain-objects.)

**8.7 Offline / not-yet-synced referenced cell.** When viewer B renders `entry.profile.get()?.name` for participant A, what happens before B's client has synced *A's* (cross-space) profile cell? We assume it returns `undefined` and we fall back to the snapshot `entry.name`. Is that the actual behavior (returns `undefined`, doesn't throw across a space boundary), and is "keep a snapshot `name` alongside the live ref" the blessed mitigation (as `cfc-group-chat-demo` does with `authorName`)?

**8.8 Concurrent join convergence + index race.** The join idiom does `users.push(...)` then `me.set({ entry: users.key(len-1) })` (`scoped-user-directory/main.tsx:47-48`). Two concurrent self-joins each read `len-1` — can the `me` pointer end up referencing the wrong index? What are the array-merge/convergence semantics for concurrent `push` into a `PerSpace` array (LWW vs CRDT-append), and is there a safe "append-and-get-my-ref" idiom?

**8.9 Storage / perf of N per-user cells in one space.** Each self-join contributes a cross-space per-user profile cell reference into the shared roster. For a large group, rendering the roster resolves N `profile.get()` across potentially N different spaces. Any read-amplification / sync-cost concerns, or a recommended cap / batching?

**8.10 `equals` on cross-space cell references.** Dedup and "is this my entry" rely on `equals()` over cell references that originate in different spaces (and survive re-sync). Is `equals` guaranteed to identify the same logical cell across space boundaries and across sessions, or only within a pattern instance?

### Idiomaticity questions (from the fabric audit)

- **OQ-A — composition in `PerSpace`.** Is storing *composed participant pieces* (charm results, à la `contacts.tsx:42`) in a `PerSpace` array supported and convergent under concurrent join, or is a bare cell reference the only blessed shape there? (Extends §8.8 to pieces.)
- **OQ-B — mentionable of cross-space pieces.** If roster entries are pieces holding cross-space profile refs, does exporting them as `mentionable` and `wish`-ing them from another pattern resolve the *live* cross-space name, or only what's synced locally? (Intersects §8.7/§8.9.)
- **OQ-C — CFC without a trusted surface.** Is `RepresentsCurrentUser<ProfileCell>` *enforced* on a contributed reference without a full trusted surface — i.e. can a member be prevented from forging/overwriting another's contributed ref with just that one type? (Sharper form of §8.3.)
- **OQ-D — discoverable reusable surface.** Should the reusable identity surface be a `#`-tagged `wish`-discoverable piece rather than a copied prop-contract component? What's the blessed home for a shipped, wish-able reusable sub-pattern (`packages/patterns/…`, a stdlib, the catalog)? (Sharper §8.5.)
- **OQ-E — `#profileAvatar` parity.** Does `#profileAvatar` (`wish.ts:761-766`) carry the same per-user scoping + first-run/hydration caveats as `#profileName`, so avatar resolution needs the same `me`-pointer flicker mitigation?

### UX questions (from the UX review)

- **OQ-F — same-name disambiguation surface.** What's the canonical disambiguator when two entries share a display name (the P0 issue)? "· you" + relative join time, a stable short ref hash, or a required distinguishing avatar — needs one blessed answer so every adopter does it identically.
- **OQ-G — escape-hatch semantics + orphan GC.** On "I'm someone else" / un-join, does `me.entry` null (orphaning the roster entry) or re-point? Do abandoned one-off / orphaned entries accumulate, and is there a GC/merge story?
- **OQ-H — first-run framing ownership.** Should the reusable Identity component own the chrome around `{wish("#profile")}` (heading + cross-app-reuse helper + one-off peer), so the value prop isn't lost when embedded raw? (Recommend: yes.)
- **OQ-I — ship a `cf-avatar`?** There is no avatar component; patterns hand-roll initials. Should this work ship a small profile-aware `cf-avatar` (initials + accent color, profile-less fallback) so "avatars resolve live" is true and consistent?
- **OQ-J — claim confirmation + provenance.** Should a claim be visible to other participants (a quiet activity note), and require the confirm we propose? A silently-mutating attribution in a money app may warrant a visible trail.

## 9. Alternatives considered

- **Naive `names: string[]` + `myName: PerUser<string>`** (today). Rejected: rename/dedupe corruption, manual typing, not pattern-native. (`multi-user-patterns.md:194-197` allows it only for "demos where names are immutable and unique enough.")
- **Per-person sub-pattern pieces** (à la `contacts.tsx` / `reading-list`): each participant is a composed piece. More powerful (per-person UI, `navigateTo`) but overkill for fair-share; reserve for patterns needing rich per-person surfaces.
- **Silent auto-link** (bind viewer to a same-named roster entry automatically). Rejected for a money app: can mis-attribute debt; claim must be explicit.
- **CFC-authored roster from day one** (`RepresentsCurrentUser` on every contribution). Strongest integrity (closes §8.3's forgeability hole) but more machinery to copy. Live option, not just "later hardening" — pending Berni's call on the right bar for a money app vs an exemplary-simple template.
- **Reference-on-record vs a separate roster.** `cfc-group-chat-demo` carries `authorProfile` directly on each *message*; we could likewise carry the payer/sharer references only on each *expense* and derive the roster, avoiding the concurrent-roster-push convergence problem (§8.8) for attribution. Trade-off: a standalone roster is needed anyway for "people with no expenses yet" and for the join/claim UX, so we keep the roster but note expenses could be self-describing.
- Five UX framings were explored and synthesized; the recommendation is the *adaptive single quiet affordance* shell over the *roster-of-references* substance. Full enumeration with verdicts is in **Appendix A**.

## 10. Rollout & testing (if approved)

- Implement on `fair-share` first (branch `fair-share-ux`), in verified increments (data model → join/claim → first-run embed → extract reusable component).
- Tests: pattern tests for join/claim/rename/dedupe state transitions; multi-user **integration** test (two identities, à la `cfc-group-chat-demo.test.ts`) asserting each viewer sees their own name and live updates; browser UX pass over J1–J5.
- Then document as a catalog best-practice + `packages/patterns/index.md` entry, and (pending §8.5) extract the reusable surface.

## Appendix A — Design space explored (UX concepts)

Five UX framings were generated (least → most chrome), then synthesized. Recorded with verdicts so future patterns don't re-litigate.

**Concept 1 — "You're already here" (zero-friction).** Render *nothing* in the common case; auto-link the viewer to a matching roster entry and just start. States: Resolved / AutoMatch / OneTapJoin / NamelessWelcome / OneOff. Pros: lowest friction. Cons: *silent* identity binding can mis-attribute debt in a money app; no recovery when it guesses wrong. **Verdict: rejected as the model; spirit kept** (minimal chrome for the returning case) but claim must be explicit, never silent.

**Concept 2 — "This Is You" (onboarding-first).** First run is a celebrated "set your name once, recognized everywhere," strictly gated to truly name-less viewers; quiet chip for returning users; guest→profile upsell. Pros: teaches the cross-app profile value exactly when it pays off. Cons: a hero on every load would nag; correctness depends on gating off the *durable* signal, not hydration-ambiguous `#profileName`. **Verdict: partially kept** — framed first-run card + strict gating (off durable `me`), but a framed card, not a takeover.

**Concept 3 — "Who's Here" (roster-centric).** The people list *is* the identity surface; you = a highlighted row; join/claim happen inline; dedupe is claim-as-metadata (attach a profile reference), never rename. Pros: one surface; claim/dedupe has a natural home; matches the data model 1:1. Cons: a bare list gives no guidance to a newcomer; grows unbounded on mobile. **Verdict: kept as the substance** (the roster-of-references), paired with the Beacon shell for a clear next action.

**Concept 4 — "The Rail" (presence/lobby).** A persistent identity strip (you + guest list) with a glyph language (◑ joined-not-synced / ● you / ○ profile-less). Pros: always-visible "who's in this"; honest *guest-list* framing. Cons: real-time presence is **out of scope**, so a rail that looks like presence over-promises; glyphs need teaching. **Verdict: rejected as a surface**, but its honesty discipline and the profile-less glyph survive as the avatar-fallback treatment.

**Concept 5 — "Beacon" (adaptive single affordance) — RECOMMENDED SHELL.** One component morphs over a state→action table and always presents *exactly one* next action; anti-flickers by keying off durable per-user `me` rather than `#profileName`.

| State | Shows | Action |
|---|---|---|
| Joined (durable `me`) | "Posting as <live name> ▾" | tap → confirm / switch / edit |
| Profiled, not joined | "Add yourself as <name>" | one tap → join by reference |
| Name-less | framed create embed + one-off peer | create profile *or* one-off |
| Unclaimed match present | "<name> on the list — that's you?" | explicit claim (confirm) |
| Hydrating | snapshot name, muted | (no action; settles) |

Pros: one predictable affordance; never two competing CTAs; flicker-safe; carries the escape hatch a money app needs. Cons: the state table must be exhaustively specified or it surprises; needs a confirm layer for claim/switch.

**Recommended synthesis:** **Beacon shell (Concept 5) over a roster-of-references substance (Concept 3)**, with Concept 2's framed first-run, Concept 1's quiet-when-resolved spirit (explicit, never silent), and Concept 4's honest guest-list framing + profile-less glyph.

## 11. References

- `docs/common/patterns/multi-user-patterns.md` (idiom + rules; "Shared Directories and 'Me'" §153-197)
- `packages/patterns/scoped-user-directory/main.tsx` + `main.test.tsx` (directory+me; reactive-traversal limitation note)
- `packages/patterns/cfc-group-chat-demo/{trusted.tsx,logic.ts}` + `integration/cfc-group-chat-demo.test.ts` (live profile refs, cross-user proof)
- `packages/patterns/shared-profile-demo/main.tsx` (`#profile`/`#profileName` + first-run embed)
- `packages/runner/src/builtins/wish.ts` (`#profile*` resolution, persona create UI, user-scoping)
- `packages/patterns/system/profile-create.tsx` (trusted create/write-back)
- `docs/specs/shared-profile-space.md` (profile spec; cross-user readability open question §429)
- `packages/api/cfc.ts` (`RepresentsCurrentUser` integrity)
- `packages/patterns/fair-share/main.tsx` (current name-string model; the migration target)
