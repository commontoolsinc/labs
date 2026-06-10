# Verified Identity Authoring Kit

Ground-truth kit for (1) writing canonical identity docs and (2) briefing a
builder to create a **read-only, multi-user identity exemplar pattern that
compiles**. All line refs verified against the working tree on branch
`ct-1674-meaning-qa`. Companion: `docs/investigations/research/identity-map.md`
(primitives reference — read it for the "why"; this kit is the "how + exact
code").

**Headline:** `packages/patterns/fair-share/main.tsx` is ALREADY a
gold-standard, compiling exemplar of exactly the target shape (viewer
`cf-profile-badge` + snapshot roster + `cf-avatar` for others, read-only
identity). A builder should adapt it, not start from scratch. `scoped-user-directory/main.tsx`
is the minimal join+roster skeleton with the **clean cell-reference "me" idiom**.

---

## 0. EXACT imports & types (literal lines from real patterns)

The import specifier is **`commonfabric`** (mapped to `packages/api/index.ts` —
`deno.json:131`). NOT `@commonfabric/api`. `commonfabric/schema` exists too
(`deno.json:132`) but identity patterns don't need it.

From `fair-share/main.tsx:23-35` (everything an identity+roster pattern needs):
```tsx
import {
  computed, Default, equals, handler, NAME, pattern,
  type PerUser, safeDateNow, UI, wish, Writable,
} from "commonfabric";
```
Add when your Output interface is explicit (`scoped-user-directory/main.tsx:1-12`):
```tsx
import { type PerSpace, Stream, type VNode } from "commonfabric";
```
`Cell` is also exported if you need the type name; **`Writable<T> = Cell<T>`** is
a pure alias (`packages/api/index.ts:1075`) — use `Writable` in patterns.

Exact export sites (so you can trust the names): `NAME`/`UI` `index.ts:151-152`;
`PerSpace`/`PerUser`/`PerSession` `index.ts:205-207`; `Default` `index.ts:2249`;
`wish` `index.ts:2454`; `equals` `index.ts:2458`.

### `WishState<T>` result shape — `packages/api/index.ts:2189-2195`
```ts
export type WishState<T> = {
  result: T | undefined;   // the resolved value (or undefined on failure/loading)
  candidates: T[];         // multi-match set (single match auto-confirms)
  error?: any;
  [UI]?: VNode;            // framework-rendered picker / profile-create surface
};
```
`wish<T>({...})` returns `OpaqueRef<WishState<T>>` (`index.ts:2198-2200`). In a
pattern body you read `.result` reactively (see §1).

### cf-* component tags need NO import — they are JSX intrinsics
Verified: NO pattern imports `cf-avatar`/`cf-profile-badge` as a symbol. (The one
grep hit, `catalog/preview-identity.tsx:3-4`, imports *story patterns*, not tags.)
The JSX runtime is `@commonfabric/html` (`deno.json:56` `jsxImportSource`), which
makes any `cf-*` element a valid intrinsic. Just write `<cf-profile-badge .../>`.

---

## 1. fair-share/main.tsx — viewer identity (THE exemplar)

### 1a. Resolve the current viewer's profile — `:169-178`
```tsx
const profileWish = wish({ query: "#profile" });            // the live profile CELL
const profileNameWish = wish<string>({ query: "#profileName" });
const profileAvatarWish = wish<string>({ query: "#profileAvatar" });
const myProfileName = computed(() => (profileNameWish.result ?? "").trim());
const myProfileAvatar = computed(() => (profileAvatarWish.result ?? "").trim());
const hasProfile = computed(() => (profileNameWish.result ?? "").trim() !== "");
```
Note: reads `profileNameWish.result` directly inside `computed()` (the OpaqueRef
auto-unwraps in a computed body). `#profile` resolves the **current viewer only**
(built-in home-target resolver). `#profileName`/`#profileAvatar` give the
snapshot-able strings.

### 1b. The viewer "You" `cf-profile-badge` card — `:255-278`
```tsx
<cf-card>
  <cf-vstack gap="3">
    <cf-hstack gap="3" align="center" wrap>
      <cf-label>You are</cf-label>
      <cf-profile-badge $profile={profileWish.result} size="sm" />
      <cf-button
        color="primary" variant="solid"
        disabled={computed(() => !hasProfile)}
        onClick={joinWithProfile({
          people, myName, name: myProfileName, avatar: myProfileAvatar,
        })}
      >Join with your profile</cf-button>
    </cf-hstack>
```
**Load-bearing:** the badge is bound to `profileWish.result` (the WishState's
`result` field = the cell), NOT to `profileWish` itself. `$profile` is the
bidirectional/cell-binding prop syntax.

### 1c. Declaring the profile in the Input schema — there is NONE
**Important / possibly counter-intuitive:** fair-share does **not** declare a
profile cell as a pattern input. The viewer profile arrives via `wish()` at
runtime, not via the Input `State`. Input only declares the shared ledger + the
per-user "me" name (`:69-73`):
```tsx
interface State {
  people: Writable<Person[] | Default<[]>>;     // shared (per-space default)
  expenses: Writable<Expense[] | Default<[]>>;  // shared
  myName: PerUser<string | Default<"">>;        // this viewer's selection
}
```
So a read-only exemplar needs **no profile input at all** — `wish("#profile")`
is the whole identity-acquisition story.

### 1d. PerUser / PerSpace / PerSession usage
- **Shared** (per-space): `people`, `expenses` are plain `Writable<...>` in
  `State` — cells default to per-space scope (header comment `:9-11`).
- **PerUser**: `myName: PerUser<string | Default<"">>` (`:72`) — each viewer's
  own "which person am I" selection.
- **PerSession** drafts (`:156-160`): `Writable.perSession.of<string>("")` for
  form inputs so concurrent viewers don't share half-typed state.

### 1e. Rendering OTHER participants — `cf-avatar` + plain name (NOT badge)
People chips (`:322-329`) and the balances roster (`:566-569`):
```tsx
<cf-avatar src={person.avatar} name={person.name} size="xs" />
...
<cf-hstack gap="2" align="center">
  <cf-avatar src={b.avatar} name={b.name} size="xs" />
  <span>{b.name === me ? `${b.name} (you)` : b.name}</span>
</cf-hstack>
```
Others get `cf-avatar` (snapshot only) + a plain `<span>` name — **never**
`cf-profile-badge**, because only the current viewer has a real profile cell +
attestation reachable. This is the correct read-only convention.

---

## 2. Join + snapshot roster idiom

### 2a. fair-share join handler — snapshots viewer's own name+avatar — `:129-150`
```tsx
const joinWithProfile = handler<unknown, {
  people: Writable<Person[]>; myName: Writable<string>;
  name: string; avatar: string;
}>((_event, { people, myName, name, avatar }) => {
  const n = (name ?? "").trim();
  if (!n) return;
  const av = (avatar ?? "").trim();
  const cur = people.get();
  const idx = cur.findIndex((p) => p.name === n);
  if (idx < 0) people.push(av ? { name: n, avatar: av } : { name: n });
  else if (av && !cur[idx].avatar)
    people.set(cur.toSpliced(idx, 1, { ...cur[idx], avatar: av }));
  myName.set(n);
});
```
The viewer contributes their OWN `#profile` snapshot on join (the roster idiom —
no "list everyone's profiles" primitive exists).

### 2b. scoped-user-directory — the CLEAN cell-reference "me" idiom
This is the better identity-correctness model (fair-share keys on name string for
ledger reasons; the directory keys on a cell reference).

Roster `PerSpace` + "me" `PerUser` declarations — `:36-37, 61-64`:
```tsx
type DirectoryCell = Writable<Directory | Default<typeof DEFAULT_DIRECTORY>>;
type MeCell = Writable<UserPointer | Default<Record<PropertyKey, never>>>;
// in Input:
directory?: PerSpace<Directory | Default<typeof DEFAULT_DIRECTORY>>;
me?: PerUser<UserPointer | Default<Record<PropertyKey, never>>>;
```
Join handler — snapshots, then records a **cell reference** to self — `:39-49`:
```tsx
const joinAs = handler<JoinAsEvent, { directory: DirectoryCell; me: MeCell }>(
  ({ name }, { directory, me }) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const users = directory.key("users");
    users.push({ displayName: trimmed });
    const idx = users.get().length - 1;
    me.set({ user: users.key(idx) });   // <-- "me" = a CELL REF, not a name
  });
```
`UserPointer = { user?: User }` (`:22-24`). `users.key(idx)` is the live
reference into the shared array; `me.user?.displayName` reads through it (`:82`).

### 2c. "Is this me / membership" — reference vs name
- **Directory (clean):** identity is the cell ref stored in `me.user`. Membership
  is the pointer's existence; `me.user?.displayName ?? "(not joined)"` (`:82`).
- **fair-share:** `b.name === me` (`:563, :568`) — name string, acceptable only
  because name is the enforced-unique natural key in that ledger.
- **scrabble (`scrabble/scrabble.tsx`):** uses **name-string** matching too —
  `players.find((p) => p.name === name)` and `currentName !== name`
  (`:629, :644`). **This is the dead-string anti-pattern the map (§4b) warns
  against.** For a gold-standard exemplar prefer the directory's
  `me.set({ user: users.key(idx) })` + `equals()`/reference checks, NOT name `===`.

---

## 3. Stories — exact JSX + data shapes

### 3a. `cf-profile-badge` — `catalog/stories/cf-profile-badge-story.tsx`
Data shape (`:19`): `type ProfileValue = { [NAME]: string; name: string; avatar: string }`.
Construct + bind (`:21-22, :80`):
```tsx
const makeProfile = (display: string, avatar: string) =>
  new Writable<ProfileValue>({ [NAME]: display, name: display, avatar });
...
<cf-profile-badge $profile={ada} size={size} />
```
`avatar` accepts a `data:` URI SVG (`:6-14`), an emoji glyph (`"🦊"`), or `""`
(→ initials). The badge stays in plain "presented" state in a story because it
can't mint the `represents-principal` attestation (`:88-94`) — verified seal only
renders for a real runtime-attested profile cell.

### 3b. `cf-avatar` — `catalog/stories/cf-avatar-story.tsx`
Three render modes (`:71-73`):
```tsx
<cf-avatar size="lg" name="Ada Lovelace" src={ADA_IMG} /> // data-URI img
<cf-avatar size="lg" name="Grace Hopper" src="🦊" />       // glyph
<cf-avatar size="lg" name="Alan Turing" />                 // initials "AT"
```
Full prop surface (`:62`): `<cf-avatar src name size shape />` where
`size ∈ xs|sm|md|lg|xl`, `shape ∈ circle|square`. Props bind reactive cells fine
(story passes `Writable`s). **Security:** only `data:` URIs render as `<img>`;
http(s)/blob/path degrade to initials (never fetched).

### 3c. `cf-cfc-authorship` — NO story exists
Confirmed: only `cf-avatar-story.tsx` + `cf-profile-badge-story.tsx` in
`catalog/stories/`. The component is real
(`packages/ui/src/v2/components/cf-cfc-authorship/cf-cfc-authorship.ts`) but
reads an `authored-by` CFC atom (who *wrote* a value) — **out of scope** for a
read-only person-display exemplar. Do not use it.

---

## 4. Component prop reference (for the docs you'll author)

| component | prop | type | binding | notes |
|---|---|---|---|---|
| `cf-profile-badge` | `$profile` | profile cell | cell (`$`) | reads `[NAME]`/`name`/`avatar`; draws verified seal from attestation |
| | `size` | `xs..xl` | value or cell | |
| `cf-avatar` | `src` | `string` | value or cell | `data:` URI / emoji / "" |
| | `name` | `string` | value or cell | drives initials + alt |
| | `size` | `xs..xl` | value or cell | |
| | `shape` | `circle\|square` | value or cell | |

`$`-prefixed prop = cell binding (`$profile`, `$value`). Plain prop = value (may
still be a reactive `computed`/cell, as the avatar story shows).

---

## 5. Feasibility constraints for a READ-ONLY exemplar

Goal: avoid CT-1665 (avatar/element *save* verified-binding blocker) and CT-1667
(cross-space owner-field *read* — "Profile" instead of name) by never writing
owner-protected profile fields and never reading another user's profile cell.

**CONFIRMED feasible** — fair-share already does exactly this and compiles/ships:
- `cf-profile-badge` is correct **only for the current viewer** — it needs a real
  profile cell (`wish("#profile").result`) plus the runtime attestation. ✅ Bind
  it once, for "You".
- OTHER roster members **must** use `cf-avatar` — only snapshots
  (name + avatar strings) are available; no cell, no attestation. ✅ §1e.
- `#profile` resolution works **read-only**: `wish()` only *reads* the viewer's
  home-space profile link; no write path is touched. The viewer "joins" by
  writing a **snapshot into the app's own shared roster** (`people`/`directory`,
  which the pattern owns) — NOT into the profile space. ✅ §2.

**Things that would block / must be avoided:**
- Do NOT call `setName`/`setAvatar`/`addElement` on the profile (those hit the
  CT-1665 `writeAuthorizedBy` blocker — saving avatar fails with
  `writeAuthorizedBy requires a trusted verified binding identity at /avatar`).
- Do NOT try to render `cf-profile-badge` for non-viewers or read their `name`
  field cross-space (CT-1667 — you'll get the static placeholder "Profile").
- The verified seal will NOT appear in `deno task ... --no-run` checks or stories
  (needs a live attested cell). That's expected, not a compile failure.
- **Uncertain — verify by running:** `#profile` when the viewer has NO profile
  yet makes the wish render the trusted profile-create surface via `[UI]`; binding
  `profileWish.result` (which is then `undefined`) to `$profile` is what
  fair-share does and is assumed safe (badge renders empty). If an exemplar must
  guard, gate the badge on `hasProfile` (`:176`). Not a compile risk, a UX one.

---

## 6. Smallest known-good skeleton to model from

**Use `scoped-user-directory/main.tsx` (99 lines) as the structural skeleton**
(cleanest `PerSpace` roster + `PerUser` "me" cell-ref + explicit Input/Output),
then graft fair-share's `wish("#profile")` + badge/avatar rendering (§1) onto it.

Skeleton (verbatim shape, `:61-99`):
```tsx
export interface ScopedUserDirectoryInput {
  directory?: PerSpace<Directory | Default<typeof DEFAULT_DIRECTORY>>;
  me?: PerUser<UserPointer | Default<Record<PropertyKey, never>>>;
}
export interface ScopedUserDirectoryOutput {
  [NAME]: string; [UI]: VNode;
  directory: PerSpace<Directory | Default<typeof DEFAULT_DIRECTORY>>;
  me: PerUser<UserPointer | Default<Record<PropertyKey, never>>>;
  userCount: number;
  joinAs: Stream<JoinAsEvent>;
  rename: Stream<RenameEvent>;
}

export default pattern<ScopedUserDirectoryInput, ScopedUserDirectoryOutput>(
  ({ directory, me }) => {
    const boundJoinAs = joinAs({ directory, me });    // bind handlers to cells
    const users = directory.users;
    const userCount = users.length;
    const myDisplayName = me.user?.displayName ?? "(not joined)";
    return {
      [NAME]: "Scoped user directory",
      [UI]: (<div><div>Users: {userCount}</div><div>Me: {myDisplayName}</div></div>),
      directory, me, userCount, joinAs: boundJoinAs, rename: boundRename,
    };
  },
);
```
Handler is `joinAs` from §2b. To make it the identity exemplar: add the §1a
`wish` block, render `<cf-profile-badge $profile={profileWish.result}/>` for
"You", store `{ displayName, avatar }` snapshots on join, and `.map()` the roster
with `<cf-avatar src name/>` + plain name (§1e).

### Recommended exemplar shape (synthesis — read-only)
1. Input: `roster: PerSpace<{members: Member[]}>` + `me: PerUser<{member?: Member}>`
   (cell-ref pointer, §2b). `Member = { displayName: string; avatar?: string }`.
2. Body: `wish("#profile" | "#profileName" | "#profileAvatar")` (§1a).
3. Join handler: snapshot `{ displayName: myProfileName, avatar: myProfileAvatar }`
   into `roster`, then `me.set({ member: members.key(idx) })`.
4. UI: viewer card → `<cf-profile-badge $profile={profileWish.result}/>`; roster
   list → `.map()` of `<cf-avatar>` + name; mark self via `equals()` on the
   `me.member` reference (NOT name string).

---

## 7. Gotcha checklist (compile/runtime — from the real exemplars)

- **Bare `.map()` for cell arrays in JSX** — do NOT wrap `people.map(...)` in
  `computed()`; it breaks `equals()` schema inference & removal (fair-share
  `:317-321`). But a `.map()` over a **derived** array (e.g. `balances`) IS
  wrapped in `computed()` (`:557`). Match the source: direct input cell → bare;
  computed value → `computed(() => arr.map(...))`.
- **Don't chain `.filter()/.map()` on `.get()` arrays in handlers** — the
  transformer rewrites them to `.filterWithPattern()/.mapWithPattern()` which
  throw; use plain for-loops + spreads (fair-share `:341-359`).
- **A single `computed()` must not flip between array and single node** — splits
  into list-computed + sibling empty-state-computed (fair-share `:551-556`,
  `:586-590`) or you get `TypeMismatchError`.
- **`$profile={profileWish.result}`** not `={profileWish}` — bind the `.result`.
- **`disabled={computed(() => !hasProfile)}`** — reactive booleans wrap in
  `computed` (fair-share `:269`).
- Identity by `equals()` + references, never synthetic `id` fields (they read as
  Cells in `.map()` and break `===`) — fair-share header `:16-18`.

---

## Appendix — primary files (all absolute)

- `/Users/ben/code/labs/packages/patterns/fair-share/main.tsx` — **gold exemplar**
- `/Users/ben/code/labs/packages/patterns/scoped-user-directory/main.tsx` — **skeleton**
- `/Users/ben/code/labs/packages/patterns/scrabble/scrabble.tsx` — roster (name-string anti-pattern; contrast only)
- `/Users/ben/code/labs/packages/patterns/catalog/stories/cf-profile-badge-story.tsx`
- `/Users/ben/code/labs/packages/patterns/catalog/stories/cf-avatar-story.tsx`
- `/Users/ben/code/labs/packages/api/index.ts` — `WishState` `:2189`, scoped types `:205-207`, `wish` `:2454`
- `/Users/ben/code/labs/packages/ui/src/v2/components/cf-profile-badge/cf-profile-badge.ts`
- `/Users/ben/code/labs/packages/ui/src/v2/components/cf-avatar/cf-avatar.ts`
- `/Users/ben/code/labs/docs/investigations/research/identity-map.md` — primitives reference
