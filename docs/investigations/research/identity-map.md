# Identity & Shared-Profile Map (Common Fabric)

Research snapshot of the shared-profile / identity surface as of branch `main`
(post-merge of #3879/#3881/#3882/#3883). Audience: an agent that must render a
person, discover a profile, or know "who am I" from inside a pattern. All paths
absolute. Snippets are load-bearing excerpts only.

Related tickets: **CT-1645** (shared profile space — parent), **CT-1665**
(writeAuthorizedBy / verified-binding runtime blocker), **CT-1667** (cross-space
owner-field read — badge name). CT-1623/CT-1628 appear in adjacent code notes.

---

## TL;DR for the impatient

- **To show a person:** bind a profile *cell* to `<cf-profile-badge $profile={cell} />`
  (trusted, draws name + avatar + a DID-derived "verified" seal). For a raw,
  trust-free avatar use `<cf-avatar src name size shape />`. Both live in
  `packages/ui/src/v2/components/`.
- **There is NO hard doc rule** that says patterns MUST use these components
  instead of raw name strings. The strongest guidance is *aspirational* (an RFC)
  and *by-example* (specs/demos). Most shipped multiplayer patterns still render
  `participant.name` as plain text / `<img>`. (Section 2 — important finding.)
- **To discover the current viewer's profile:** `wish({ query: "#profile" })`
  (also `#profileName`, `#profileAvatar`, `#profileSpace`). Resolves *only the
  current viewer's* profile — there is no "list everyone's profiles" primitive.
- **"Who am I" inside a pattern body:** there is **no `currentUser()` / `getDID()`
  API exposed to user-space patterns.** You get per-user identity *implicitly*
  via scoped state (`PerUser<T>` / `Writable.perUser`) and the `#profile` wish.
  The raw `runtime.userIdentityDID` exists only in trusted runtime/builtin code.
- **Per-user vs shared state** is the actual identity model: `PerSpace<T>`
  (shared), `PerUser<T>` (this DID), `PerSession<T>` (this DID + tab). See
  `docs/common/patterns/multi-user-patterns.md`.

---

## 1. Identity UI components

Three `cf-*` components render a person. (`cf-badge` is a generic status pill,
NOT identity — excluded.)

### 1a. `cf-avatar` — generic avatar primitive (NO trust)

- File: `packages/ui/src/v2/components/cf-avatar/cf-avatar.ts`
- Renders one of three modes by precedence (`cf-avatar.ts:57-78`, render at
  `:175`):
  1. `src` that is a **`data:` URI** → `<img>` (falls back to initials on error)
  2. a short typed **glyph/emoji** → the glyph as-is
  3. otherwise → **initials** derived from `name` (`initialsForName`, `:46`)
- Security: external URLs are **never fetched**. Only `data:` URIs render as
  images; `http(s):`, `//host`, `blob:`, `/path` degrade to initials
  (`isAvatarImageUrl` `:27`, `isRemoteLikeSource` `:39`). Rationale in the
  doc-comment: it runs on the trusted main thread with a pattern-supplied `src`,
  so a remote `<img>` would be an exfil/tracking beacon.
- Public API (props / attrs, `:147-160`):
  | prop | type | default | notes |
  |---|---|---|---|
  | `src` | `string` | — | `data:` image URI, or glyph/emoji |
  | `name` | `string` | — | drives initials + alt text |
  | `alt` | `string` | — | explicit alt (defaults to `name`) |
  | `size` | `xs\|sm\|md\|lg\|xl` | `md` | reflected |
  | `shape` | `circle\|square` | `circle` | reflected |
- Doc-comment is explicit that it "carries NO trust claims, so any code —
  including sandboxed user-space patterns — may render it" (`:57-62`).
- Usage (story `packages/patterns/catalog/stories/cf-avatar-story.tsx:71-74`):
  ```tsx
  <cf-avatar size="lg" name="Ada Lovelace" src={ADA_IMG} /> // data-URI SVG
  <cf-avatar size="lg" name="Grace Hopper" src="🦊" />       // glyph
  <cf-avatar size="lg" name="Alan Turing" />                 // initials "AT"
  ```

### 1b. `cf-profile-badge` — trusted profile presentation (THE identity control)

- File: `packages/ui/src/v2/components/cf-profile-badge/cf-profile-badge.ts`
- Seal helper: `packages/ui/src/v2/components/cf-profile-badge/identity-seal.ts`
- What it renders: a pill = `cf-avatar` (composed) + the person's **name** + a
  shield "seal" mark. You bind a **profile cell**, not strings:
  `<cf-profile-badge $profile={profileCell} />`.
- It runs on the **trusted main thread** (outside the iframe sandbox), which is
  what lets it "draw an identity treatment a pattern cannot forge" (`:59-75`).
- Display extraction (`profileDisplayFromValue`, `:38-57`): prefers the profile's
  own editable **`name`** field, falling back to the cell's `[NAME]`. This
  ordering matters — on `main`, profile-home sets `[NAME]` to the static
  placeholder `"Profile"`, so trusting `[NAME]` first would render everyone as
  "Profile" (doc-comment `:28-37`; ties to CT-1667 below).
- Subscribes with a minimal schema (`{ [NAME]?, name?, avatar? }`, `:286-296`)
  so the runtime only resolves rendered fields.
- **Verified seal** (`_refreshVerification`, `:327-351`): reads the resolved
  cell's runtime-attested CFC label via `readCfcLabelView()` and looks for a
  `represents-principal` integrity atom (the owner DID). If present →
  `_state="verified"` and it derives a deterministic **generative aura** from
  that DID (`identitySeal(owner)`). Same DID → byte-identical aura everywhere, so
  it reads as a recognizable fingerprint; user-space can mimic the CSS but cannot
  mint the attestation. No label → plain `"presented"` state.
- Public API:
  | prop / attr | type | default |
  |---|---|---|
  | `$profile` (`profile`) | `CellHandle` (a profile cell) | `undefined` |
  | `size` | `xs\|sm\|md\|lg\|xl` | `md` (reflected) |
  | (consumes `runtimeContext`, `spaceContext` via `@lit/context`) | | |
  | states (internal): `presented` \| `verified` \| `unverified` | | `ProfileBadgeState` `:21` |
  | CSS parts: `root, aura, aura-ring, avatar, name, seal` | | |
- The seal API (`IdentitySeal`, identity-seal.ts:18-31): `{ did, hue, hues[],
  angle, ringGradient, accent }`, derived via FNV-1a → splitmix32 (deliberately a
  tiny *non-crypto* visual hash, not `content-hash`, `:33-47`).
- Real usage:
  - story `packages/patterns/catalog/stories/cf-profile-badge-story.tsx:80-82`:
    ```tsx
    <cf-profile-badge $profile={ada} size={size} />
    // ProfileValue = { [NAME]: string; name: string; avatar: string }
    ```
  - **home Profile tab** (`packages/patterns/system/home.tsx:210`): the canonical
    production wiring —
    ```tsx
    <cf-profile-badge $profile={profile} />
    <strong>{profileName}</strong>   // light-DOM mirror for tests
    ```
    (badge resolves the cross-space profile cell; comment `:201-209`).
  - `packages/patterns/catalog/preview-identity.tsx` — standalone deploy harness
    rendering both stories.
  - `packages/patterns/fair-share/main.tsx` — used in the "You" card (#3881).

### 1c. `cf-cfc-authorship` — verified *authorship* chip (adjacent, not profile)

- File: `packages/ui/src/v2/components/cf-cfc-authorship/cf-cfc-authorship.ts`
- Renders an author's name/initials + a verified/unverified state by reading a
  cell's CFC label (`authored-by` atom, vs profile-badge's `represents-principal`).
  Reuses `initialsForName` from `cf-avatar` (`:3`). Use this for "who wrote this
  message", not "who is this person".

### Shared trusted-label plumbing (how the trust is read)

- `packages/ui/src/v2/core/cfc-label.ts`:
  - `readCfcLabelView(value)` (`:38`) — resolves the cell if needed, calls
    `getCfcLabel()` (trusted IPC) → `CfcLabelView`.
  - `ownerPrincipalFromLabel(view)` (`:60`) — pulls the owner DID out of a
    `represents-principal` atom (string `represents-principal:<did>` or object
    `{kind, subject}`), scanning every entry (owner-protected fields carry it at
    their own path, not the root).
- `CfcLabelView` type comes from `@commonfabric/runner/cfc`.

---

## 2. The documented "right way" to render identity — FINDING: weak / mostly absent

**There is no authoritative rule that patterns MUST (or even SHOULD) use
`cf-profile-badge` / `cf-avatar` instead of raw name strings.** This is a genuine
gap. Evidence:

- `docs/common/components/COMPONENTS.md` — the component narrative reference — has
  **no entry** for `cf-profile-badge` or `cf-avatar`. Its only "identity" hit is
  `equals()` for *object* identity (`:341`), unrelated.
- `docs/common/concepts/identity.md` is **about object identity / the object
  graph and `equals()`**, NOT user identity. (Easy to be misled by the filename.)
- The components ARE catalogued: `packages/patterns/catalog/catalog.tsx:92-97`
  registers an `"Identity"` category with `avatar` + `profile-badge`. That's
  discovery, not prescription.
- The closest thing to prescriptive guidance is **aspirational**, in an RFC:
  commit `3a8e13ce6` "docs(rfc): multi-user identity & join for patterns" added
  `docs/specs/multi-user-identity-pattern.md`, whose stated goal is so multi-user
  patterns "stop reinventing 'who am I / who's in this' with dead name strings."
  **That file is not present on the current working tree** (the commit is in
  history but the doc isn't checked out on `main` — likely on an unmerged
  branch). So the "use real identity, not dead strings" principle exists as a
  *proposal*, not landed guidance.
- The shipped reference specs actively **recommend snapshotting plain
  name/avatar strings** for rosters (see §3 / §4 of
  `docs/specs/shared-profile-rosters.md`), and the reference roster renders
  "names and avatars straight from `participants`" — i.e. NOT necessarily via the
  trusted badge. The rosters spec's own demo even uses `<img src>` for avatars
  (cites `packages/patterns/group-chat-room.tsx`).

Practical read for an agent: **rendering a person via `cf-profile-badge` is the
intended "official/trusted" presentation, but it is opt-in and underspecified.**
Most existing multiplayer patterns render display names as plain text. If your
goal is correctness-by-convention, prefer the badge for the *current viewer's*
own profile cell (where the cell + attestation are reachable) and plain
strings/`cf-avatar` for *other* people in a shared roster.

---

## 3. The "wish" system for identity

`wish()` discovers pieces at runtime. Doc: `docs/common/conventions/wish.md`.
Implementation: `packages/runner/src/builtins/wish.ts`.

### 3a. Well-known identity/profile wish targets (built-in, not JSDoc-tag based)

These are hard-coded resolvers, NOT discovered via `#tag` JSDoc. Defined in
`resolveHomeSpaceTarget` (`wish.ts:620-778`); classified `home-target` in
`getResolutionKind` (`:138-146`):

| query | resolves to | code |
|---|---|---|
| `#profile` | the viewer's **profile default pattern** cell | `wish.ts:717-726` |
| `#profileName` | live `initialNameApplied`, falling back to home `profileName` mirror | `:728-759` |
| `#profileAvatar` | `profile.avatar` | `:761-766` |
| `#profileSpace` | the profile **space** cell | `:768-773` |
| `#learnedSummary` | `home.defaultPattern.learned.summary` (what `#profile` *used* to mean) | `:701-715` |

All resolve from `homeSpaceCell.defaultPattern.profile`
(`getProfileDefaultCell`, `wish.ts:279-309`). That link is owner-protected and
points **cross-space** into the profile space; if unset/unresolved it throws so
the caller can fall back to the profile-create surface.

`#profile` is special: when it errors (no profile yet) the wish renders the
**trusted profile-create pattern** (`profileCreateUI` → `launchProfileCreatePattern`,
`wish.ts:1431-1552`; loads `system/profile-create.tsx`). Submitting a name
creates the viewer's profile. Doc: `wish.md:98-121`.

Call shapes (`docs/common/conventions/wish.md:104-109`):
```tsx
wish({ query: "#profile" })       // profile default pattern (current viewer)
wish<string>({ query: "#profileName" })
wish<string>({ query: "#profileAvatar" })
wish({ query: "#profileSpace" })
```
Canonical render of the viewer's own profile:
`packages/patterns/shared-profile-demo/main.tsx:5-11` —
```tsx
const profileWish = wish({ query: "#profile" });
const profileNameWish = wish<string>({ query: "#profileName" });
const displayName = computed(() =>
  (profileWish.result as { initialNameApplied?: string })?.initialNameApplied
    ?? profileNameWish.result ?? "No profile");
```

### 3b. `#tag`-discoverable profile pieces (the JSDoc mechanism)

A pattern becomes wish-discoverable by a `/** ... #tag ... */` **JSDoc** comment
on its `Output` interface (double-asterisk; a plain `/* */` does NOT work). The
profile *blackboard* pattern is the prime example:

- `packages/patterns/profile.tsx:205-206`:
  ```tsx
  /** Profile blackboard for personal data coordination. #profile */
  export interface Output { ... self; vehicles; memberships; ... }
  ```
  Its own header documents the intended call (`profile.tsx:9-11`):
  ```tsx
  const profile = wish<ProfileOutput>({ query: "#profile" });
  profile?.memberships.push({ program: "Hilton Honors", memberNumber: "12345" });
  ```
  NOTE: this `profile.tsx` blackboard predates the shared-profile-space work and
  its `#profile` JSDoc tag now **collides conceptually** with the built-in
  `#profile` home-target resolver in `wish.ts` (which wins for the well-known
  path). Treat `profile.tsx` as the legacy rich-data model (§5).

### 3c. The `profile` wish scope (search the viewer's profile elements)

Beyond the well-known targets, any `#tag` can be searched **inside the current
viewer's shared-profile element list** via `scope: ["profile"]`:
- `docs/common/conventions/wish.md:76, 94-95`:
  ```tsx
  wish({ query: "#portfolio", scope: ["profile"] }) // profile elements
  ```
- Implementation: `searchProfileForHashtag` (`wish.ts:481-534`) reads
  `getProfileDefaultCell(ctx).key("elements")` and matches `userTags` first, then
  the schema `tag`. Scope dispatch in `searchByHashtag` (`:541-615`).
- Scope cheat-sheet (`wish.md:72-77`): `"~"` = home favorites (cross-space),
  `"."` = current-space mentionables, `"profile"` = current viewer's profile
  elements. Default (no scope) = favorites only.

`WishState<T>` result shape (`wish.md:14-23`): `{ result, candidates[], [UI],
error }`. Single match auto-confirms; multiple → framework picker.

---

## 4. "Who am I" + per-user state — CRITICAL

### 4a. There is no user-space "current user" function

Searched `packages/api`, `packages/runner/src`, and all patterns. **No
`currentUser()`, `getViewer()`, `whoami()`, `getDID()`, or similar is exported to
patterns.** The raw identity exists only in trusted runtime code:

- `packages/runner/src/runtime.ts:322` `readonly userIdentityDID: DID;`
  (set `:386` from `options.storageManager.as.did()`).
- `runtime.getHomeSpaceCell()` (`:932`) creates the home cell at
  `(space = userIdentityDID, cause = userIdentityDID)` — i.e. **home space DID ==
  user DID**. This is *the* identity anchor, but it's runtime-internal.
- `wish.ts` reads `ctx.runtime.userIdentityDID` for `#favorites`/`#profile`/etc.
  (e.g. `:335, :626, :718`) — again, builtin code, not patterns.

Implication: a pattern cannot ask "what is my DID". It instead:
1. resolves *its own* profile via `wish({ query: "#profile" / "#profileName" })`
   (the DID is implicit — the wish reads from the active user's home space), and
2. distinguishes its own data from shared data via **scoped cells** (below).

The handoff memory (`handoff_ct1645_profile_identity.md`) and the rosters spec
both phrase this as: patterns reinvent "who am I" with name strings *because*
there's no clean primitive — exactly what the unmerged RFC wants to fix.

### 4b. Per-user vs shared state — the real model

Authoritative doc: `docs/common/patterns/multi-user-patterns.md`.

| State kind | Scope | type / ctor |
|---|---|---|
| shared records, rooms, messages, role registries | `PerSpace<T>` | `Writable.perSpace(...)` |
| profile, display name, durable personal prefs/drafts | `PerUser<T>` | `Writable.perUser(...)` |
| selected tab/room, modal, filter text, focus | `PerSession<T>` | `Writable.perSession(...)` |

- Type aliases: `packages/api/index.ts:205-207`
  ```ts
  export type PerSpace<T> = Scoped<T, "space">;
  export type PerUser<T>  = Scoped<T, "user">;
  export type PerSession<T> = Scoped<T, "session">;
  ```
- Scoped constructors: `packages/api/index.ts:945-955` (`Writable.perSpace /
  perUser / perSession`); usage `multi-user-patterns.md:218-224`:
  ```ts
  const sharedBoard  = new Writable.perSpace(DEFAULT_BOARD);
  const displayName  = new Writable.perUser("");
  const selectedItem = new Writable.perSession<string | null>(null);
  ```
- Resolution semantics (`docs/development/SHARED_IDENTITY.md:128-167`):
  `PerUser<T>` is keyed by **active user DID**; `PerSession<T>` by user DID +
  memory session; `PerSpace`/unscoped is shared. "When CLI and browser
  identities differ, the failure mode is usually not 'storage is missing'; it is
  'the read is resolving a different scoped instance.'"
- Hard rules (`multi-user-patterns.md:199-202, 342-352`): **do NOT** store user
  DIDs / session ids / synthetic ids to fake isolation — let the scope select the
  instance; use `equals()` + references for identity, not `id` fields. Scopes are
  *addressing* boundaries, not *authorization* — use CFC for enforcement.

### 4c. "Me" pointer into a shared directory (idiom)

`multi-user-patterns.md:153-197`: keep the roster `PerSpace<DirectoryCell>` and a
`PerUser<MyUserCell>` pointer; the join handler pushes the viewer's entry and
records `me.set({ user: users.key(idx) })`. Reference impls:
`packages/patterns/scoped-user-directory/`, `packages/patterns/scrabble/scrabble.tsx`,
`packages/patterns/battleship/multiplayer/`.

### 4d. Author / owner via CFC (the trusted identity binding)

For *attested* identity (who really owns/wrote a value), patterns use CFC type
wrappers (compiled into integrity atoms the runtime verifies). The
`__ctCurrentPrincipal` placeholder is resolved to the writing identity's DID at
write time.

- `packages/api/cfc.ts`:
  - `RepresentsCurrentUser<T>` (`:259-264`) → `addIntegrity:
    [{kind:"represents-principal", subject:{__ctCurrentPrincipal:true}}]`. This is
    exactly the atom `cf-profile-badge` looks for to draw the verified seal.
  - `AuthoredByCurrentUser<T>` (`:266-271`) → `kind:"authored-by"` (what
    `cf-cfc-authorship` reads).
  - `WriteAuthorizedBy<T, Binding>` (`:342-344`) → `writeAuthorizedBy: Binding`;
    composed into `TrustedActionWrite` (`:364-369`) with a UI contract.
- Owner-protected profile fields are typed via a stack of these — see
  `packages/patterns/system/profile-home.tsx:21-31`:
  ```ts
  type OwnerProtectedProfileWrite<T, Binding> =
    RepresentsCurrentUser<Cfc<WriteAuthorizedBy<T, Binding>,
      { ownerPrincipal: CurrentPrincipal }>>;
  ```
  applied to `name` / `avatar` / `elements` (`profile-home.tsx:77-79`).
- Placeholder handling in the runner: `prepare.ts:106`
  `CURRENT_PRINCIPAL_PLACEHOLDER_KEY = "__ctCurrentPrincipal"`;
  `currentPrincipalIntegrityReason` (`:1057`+).

### 4e. Per-user *cell identity* (cleanest worked example of "who am I")

`packages/patterns/cfc-group-chat-demo/trusted.tsx` is the richest exemplar. Each
user's profile must be its **own** cell, isolated by active DID
(`applyTrustedProfileSave`, `:396-431`):
```ts
// per-user-scoped cell is isolated by active DID — each user a distinct entity
const profile = currentProfileCell(myProfile) ??
  Writable.perUser.of<TrustedProfile>(nextSnapshot);
```
The doc-comment (`:414-424`) explains the bug this fixes: a constant-cause
`Writable.for("profile")` gave every user the *same* underlying entity, so
authorship verification compared everyone against one shared (last-writer)
profile. Identity is keyed on the profile **cell** (compared via `equals()`),
never the mutable display name (`:288-338`).

---

## 5. Identity data model — what a profile *is*

Two distinct "profile" shapes exist; don't conflate them.

### 5a. Shared-profile-space model (the NEW one — CT-1645)

Spec: `docs/specs/shared-profile-space.md`. A profile is a **real space**, linked
from the user's home at `homeSpaceCell.defaultPattern.profile`. Its
`spaceCell.defaultPattern` is a profile-specific default pattern owning:

- the owner's **name** + **avatar** (owner-protected strings)
- a list of **profile elements** (pieces hosted in the profile space)
- owner-only handlers to add elements (catalog or pattern URL)

Defined in `packages/patterns/system/profile-home.tsx`:
- `ProfileHomeOutput` (`:74-85`): `name`, `avatar`, `elements:
  ProfileElement[]`, plus streams `setName / setAvatar / addElement /
  removeElement`, and `initialNameApplied` (the live display name the wish reads).
- `ProfileElement` (`:40-46`): `{ cell, tag, userTags[], title?, source?:
  "catalog"|"url" }`.
- Each field is `OwnerProtectedProfileWrite<...>` (RepresentsCurrentUser + CFC +
  WriteAuthorizedBy, §4d).
- `[NAME]` is set to the static placeholder `"Profile"` here — which is why the
  badge prefers `name` (§1b) and why CT-1667 matters (§6).

Creation: `packages/patterns/system/profile-create.tsx` — `submitProfileCreation`
(`:25-43`) does `ProfileHome.inSpace(name)({ initialName: name })` to spin up the
profile in a fresh, name-derived space; the link is stored on the home default
pattern. `PatternFactory.inSpace(...)` signature:
`packages/api/index.ts:1355`. (`.for(cause)` for stable cell identity:
`index.ts:903`+.)

So the **minimal shared profile is just `{ name, avatar, elements[] }`** — no
bio/DID fields yet (bio is a deferred CT-1645 child, CT-1648). The owner DID is
not a stored field; it lives in the `represents-principal` CFC label / the
profile *space* DID.

Multi-profile note: under PR #3830 a user may have multiple profiles; `#profile`
resolves the **default** and launches a picker for 2+ (rosters spec `:28-40`).
Resolver enumeration landed in commits `0d6e4d367` / `b214d8673`.

### 5b. Legacy `profile.tsx` blackboard (rich personal data — predates 5a)

`packages/patterns/profile.tsx` — a "blackboard / Schelling point" for personal
data, tagged `#profile` (`:205`). Far richer schema (`:63-159`): `Person`
(name, nickname, birthday, phones, emails, addresses, school…), `Vehicle`,
`Membership`, `Bank`, `Employment`, plus a `LearnedSection` (facts / preferences
/ openQuestions / personas / summary). This is the "popped-out entities" model
and is **not** the shared-profile-space contract; the home-target `#profile`
wish does not resolve to it.

### 5c. Chat profile (per-pattern)

`packages/patterns/cfc-group-chat-demo/logic.ts` `ChatProfile` = `{ name,
avatar?, accentColor? }` — a lightweight per-pattern profile, snapshotted into
shared messages/rosters (§4e).

---

## 6. Known gaps / runtime blockers

### CT-1665 — `writeAuthorizedBy` / verified-binding (blocks SAVING avatar + elements)

- **Symptom:** saving the profile **`avatar`** (and, before #3880, profile
  **elements**) fails under enforce-explicit:
  `writeAuthorizedBy requires a trusted verified binding identity at /avatar`.
- **Root cause (per handoff `handoff_ct1645_profile_identity.md`):** the
  write-time `implementationRef` for `setAvatar` is missing
  `verifiedBindingMetadata` in
  `packages/runner/src/harness/executable-registry.ts`. Curiously **`name` works
  but `avatar` doesn't**, despite structurally identical handlers
  (`profile-home.tsx:162-182`) and compiler/schema verified symmetric via
  `--show-transformed`. Suspected follow-on to commit `669260eee`
  (implementationRef stability).
- **What it blocks:** the deeper profile UX — a user editing their avatar (and
  the original element-save path) does not persist. Filed for runtime/CFC owners;
  not a pattern/UI fix.
- **Mechanism refs:** `WriteAuthorizedBy` type `packages/api/cfc.ts:342`;
  enforcement `packages/runner/src/cfc/prepare.ts:~271-327, 459, 1725-1731`;
  test coverage `packages/runner/test/profile-owner-cfc.test.ts` and
  `cfc-authoring-observe.test.ts` (e.g. the exact error string at
  `cfc-authoring-observe.test.ts:71`).
- **Adjacent (#3880, separate bug, now merged):** writing a freshly-created
  element link into the owner-protected `elements` array threw
  `StorageTransactionAborted: missing link source metadata at /elements/0`. Fixed
  by giving `ProfileElement.cell` an `addIntegrity:["profile-element"]` so the
  link carries a label (mirrors profile-link). PR #3880 was **closed** (handoff
  notes its test hand-models a schema structurally unlike production output, so
  end-to-end efficacy was unproven) — element-save remains effectively gated on
  the same verified-binding machinery as CT-1665.

### CT-1667 — cross-space owner-field read (badge shows "Profile", not the name)

- **Symptom:** the badge / home renders the static placeholder **"Profile"**
  instead of the person's actual name.
- **Why:** profile-home sets `[NAME] = "Profile"` (the static placeholder), and
  the real name lives in the owner-protected **`name`** field in the *profile
  space* (a different space from where the badge renders). Reading that
  cross-space owner-protected field back is the gap. `cf-profile-badge`'s
  `profileDisplayFromValue` already prefers `name` over `[NAME]` precisely to
  dodge this (`cf-profile-badge.ts:28-37`), and home keeps a light-DOM
  `profileName` *mirror* next to the badge as a workaround
  (`home.tsx:201-211`). The mirror is creation-latency cover; the durable fix is
  the cross-space read.
- **Cross-space context in code:** `home.tsx:157-171` (the link points
  cross-space; `profile.get()` is `undefined` until the profile space loads);
  `wish.ts:279-315` (`getProfileDefaultCell` / `getProfileSpaceCell` resolve the
  cross-space link).
- **What it blocks:** correct display of *other-than-current-viewer* profile
  names, and clean name display generally without the mirror hack.

### Other flagged gaps (from specs / handoff, not blockers)

- **No "list all profiles in a space" primitive** (`shared-profile-rosters.md:18-22`):
  profiles live per-user, reachable only from that user's home; `#profile`
  resolves only the current viewer. Rosters must have each user *contribute* their
  own entry on join (snapshot recommended; live cross-space links are the
  "advanced path", unverified end-to-end — rosters spec `:96-117`).
- **No user-space "who am I" API** (§4a) — the unmerged RFC
  (`docs/specs/multi-user-identity-pattern.md`, commit `3a8e13ce6`) proposes a
  reusable identity/join surface so patterns stop using dead name strings.
- **`#profile` tag collision** between legacy `profile.tsx` JSDoc and the
  built-in home-target resolver (§3b/§5b).
- **CT-1628** (type-system, noted in code): CFC wrapper types don't expose a
  typed cell ref / `.for()`, forcing `as any` casts in `profile-home.tsx:37-39`
  and `home.tsx:132-138`.

---

## Appendix — primary files

UI components:
- `packages/ui/src/v2/components/cf-avatar/cf-avatar.ts`
- `packages/ui/src/v2/components/cf-profile-badge/cf-profile-badge.ts`
- `packages/ui/src/v2/components/cf-profile-badge/identity-seal.ts`
- `packages/ui/src/v2/components/cf-cfc-authorship/cf-cfc-authorship.ts`
- `packages/ui/src/v2/core/cfc-label.ts`

Patterns:
- `packages/patterns/system/profile-home.tsx` (shared-profile default pattern)
- `packages/patterns/system/profile-create.tsx`
- `packages/patterns/system/home.tsx` (Profile tab; badge wiring; #profile link)
- `packages/patterns/profile.tsx` (legacy rich blackboard)
- `packages/patterns/shared-profile-demo/main.tsx` (canonical viewer render)
- `packages/patterns/cfc-group-chat-demo/trusted.tsx` + `logic.ts` (per-user cell idiom)
- `packages/patterns/catalog/stories/cf-avatar-story.tsx`,
  `.../cf-profile-badge-story.tsx`, `packages/patterns/catalog/preview-identity.tsx`

Runtime / API:
- `packages/runner/src/builtins/wish.ts` (wish + profile resolvers)
- `packages/runner/src/runtime.ts` (`userIdentityDID`, `getHomeSpaceCell`)
- `packages/runner/src/cfc/prepare.ts` (writeAuthorizedBy / current-principal)
- `packages/api/cfc.ts` (RepresentsCurrentUser / AuthoredByCurrentUser / WriteAuthorizedBy)
- `packages/api/index.ts` (PerSpace/PerUser/PerSession, scoped ctors, inSpace)

Docs:
- `docs/common/conventions/wish.md`
- `docs/common/patterns/multi-user-patterns.md`
- `docs/development/SHARED_IDENTITY.md`
- `docs/specs/shared-profile-space.md`, `docs/specs/shared-profile-rosters.md`
- `docs/investigations/pf-identity-e2e.md`
- (unmerged) `docs/specs/multi-user-identity-pattern.md` — RFC, commit `3a8e13ce6`
- NOTE: `docs/common/concepts/identity.md` is OBJECT identity, not user identity.
