# Shared-Profile Participant Rosters

## Status

Guidance + reference demo. Tracks **CT-1649** ("Document shared-profile
participant rosters"). Builds directly on the shared profile space work in
**CT-1645** (`docs/specs/shared-profile-space.md`) and the multi-profile
`#profile` resolution described there and in PR #3830.

## The problem

Multiplayer surfaces — chat rooms, lobbies, turn-based games — need to show
*who is here*: a roster of every participant with their name and avatar.

There is **no runtime primitive for "list all users' profiles in this space."**
Profiles live in each user's own profile space (CT-1645), reachable only from
that user's home space. A pattern running in a shared space cannot enumerate the
profile spaces of everyone who has visited. `wish({ query: "#profile" })`
resolves *the current viewer's* profile and nothing else.

## The recommended pattern

Keep the roster as ordinary, app-level shared state and have **each user
contribute their own entry when they join**:

- A `participants: PerSpace<...>` array is the shared roster. Everyone in the
  space reads and appends to it.
- Current-viewer identity (have-I-joined, my draft name) stays `PerUser<>` or
  `PerSession<>` — it is never broadcast directly; it only gates the join.
- The **join flow resolves the current viewer's shared profile** via
  `wish({ query: "#profile" })` (and the convenience targets `#profileName` /
  `#profileAvatar`). Under PR #3830 a user can have multiple profiles; the wish
  resolves the user's **default** profile in the headless/single-profile case
  and launches the framework picker when there are two or more. Patterns just
  read `wish(...).result`; the multi-profile selection is handled for them.
- The join handler writes that viewer's contribution into the shared roster —
  either a **link** to their live profile or a **stable snapshot** of
  name/avatar (see next section).
- Every other user renders names and avatars straight from `participants`. No
  cross-user profile enumeration is ever required.

This is the same shape used by `packages/patterns/scrabble/scrabble.tsx`
(a `PerSpace` `players` roster + a join handler that `push`es the current
player — its join now sources name/avatar from the shared profile this way) and
`packages/patterns/scoped-user-directory/main.tsx` (a `PerSpace` `directory` +
a `PerUser` `me` pointer). The only addition here is sourcing the display
name/avatar from the shared profile instead of a free-text field.

## Why links vs snapshots

A roster entry can store either a **live link** to the contributor's profile or
a **snapshot** of the values copied at join time. They are different
trade-offs.

### Snapshot (recommended default)

Copy the resolved `name` and `avatar` strings into the roster entry when the user
joins:

```ts
participants.push({ name, avatar, joinedAt: safeDateNow() });
```

- **Pros:** Self-contained — every other viewer renders from plain strings
  already in the shared space, no cross-space resolution, no dependency on the
  joiner's profile space being reachable later. Cheap, durable, and trivially
  serializable. Renders identically for all viewers.
- **Cons:** Goes stale. If the user renames themselves or changes their avatar
  after joining, the roster keeps the old values until they re-join / you add a
  refresh path.

### Live link

Store a reference to the contributor's profile cell (the `result` of their
`#profile` wish) and let consumers render it reactively (e.g. via
`cf-cell-link` / `cf-render`):

- **Pros:** Always current — a profile rename propagates to every roster that
  links it.
- **Cons:** Resolving the link requires reaching the *other* user's profile
  space. That is exactly the cross-space reachability the runtime does **not**
  guarantee for arbitrary users; it works cleanly for the current viewer's own
  profile but is not guaranteed for a roster full of other people's profile
  links. It also couples the roster's render to remote spaces' availability.

### Verdict

**Default to a snapshot.** It matches the "each user contributes their own data"
model, keeps the shared roster fully self-describing inside the space, and avoids
depending on other users' profile spaces being reachable. Reach for a live link
only when (a) freshness genuinely matters and (b) you have confirmed the linked
profiles resolve for *all* viewers in your deployment — and even then, consider a
**hybrid**: store the snapshot for reliable rendering *and* keep the link
alongside it for an explicit "refresh from profile" action.

> Uncertainty flagged: persisting another user's live profile cell into a
> `PerSpace` array and having *every* viewer dereference it across space
> boundaries is not something this spec verified end to end. The current
> viewer's own `#profile` result is known to render (see
> `packages/patterns/shared-profile-demo/main.tsx`). Treat the live-link roster
> as the advanced path and validate cross-space resolution before relying on it.

## Reference demo

A complete, copy-pasteable pattern. It uses the snapshot approach (the
recommended default) for *rendering* — name/avatar are copied at join time —
and additionally stores each joiner's profile **cell as the stable identity
key**, deduped with `equals()`. Note this is distinct from the "live link" path
above: the cell is used for *identity comparison*, not dereferenced for
cross-space render, so it does not depend on other users' profile spaces being
reachable. Every API used below is exercised elsewhere in the repo:

- `wish<string>({ query: "#profileName" | "#profileAvatar" })` and reading
  `.result` — `packages/patterns/shared-profile-demo/main.tsx`,
  `packages/patterns/chatbot.tsx`.
- `PerSpace` / `PerUser` roster + writable-cell aliases + a `push`ing join
  handler — `packages/patterns/scrabble/scrabble.tsx`,
  `packages/patterns/scoped-group-chat/main-plain-inputs.tsx`.
- `safeDateNow()` for timestamps in handlers —
  `packages/patterns/scoped-group-chat/main-plain-inputs.tsx`.
- avatar rendering from snapshot strings — `<img src={...}>` here for
  self-containment; production patterns use `<cf-avatar src name>`
  (`packages/patterns/group-chat-room.tsx`,
  `packages/patterns/profile-group-chat/main.tsx`).

```tsx
import {
  type Cell,
  computed,
  Default,
  equals,
  handler,
  NAME,
  pattern,
  type PerSession,
  type PerSpace,
  type PerUser,
  safeDateNow,
  Stream,
  UI,
  type VNode,
  wish,
  Writable,
} from "commonfabric";

// ---------------------------------------------------------------------------
// Roster shapes
// ---------------------------------------------------------------------------

/**
 * Stable identity for a participant: the contributor's own `#profile` cell.
 * Display name is mutable and not unique (two different people can both be
 * "Alex"), so it must NOT be the identity key. The profile cell is the stable
 * handle — a distinct entity per user — compared with `equals()`.
 */
export type ParticipantProfileCell = Cell<{ name?: string; avatar?: string }>;

/** One participant's contribution to the shared roster (a profile snapshot). */
export interface Participant {
  /** Link to the contributor's profile cell — the stable identity key. */
  profile: ParticipantProfileCell;
  /** Display name, snapshotted from the joiner's profile at join time. */
  name: string;
  /** Avatar URL/text, snapshotted from the joiner's profile (may be empty). */
  avatar: string;
  joinedAt: number;
}

export interface Roster {
  participants: Participant[] | Default<[]>;
}

/** Per-user marker so a viewer only joins once and can see "joined" state. */
export interface ViewerState {
  /** Set once this viewer has contributed their entry to the shared roster. */
  joined?: boolean;
  /** Display name shown on the join button after joining (cosmetic only). */
  joinedName?: string;
}

// Use explicit type annotations (not `satisfies`): a `{}` inferred from
// `satisfies ViewerState` loses the optional `joinedName`, so `viewer.joinedName`
// fails to type-check in the pattern body.
const DEFAULT_ROSTER: Roster = { participants: [] };
const EMPTY_VIEWER: ViewerState = {};

type RosterCell = Writable<Roster | Default<typeof DEFAULT_ROSTER>>;
type ViewerCell = Writable<ViewerState | Default<typeof EMPTY_VIEWER>>;

export type JoinEvent = Record<PropertyKey, never>;

// ---------------------------------------------------------------------------
// Join handler: contribute the current viewer's profile snapshot
// ---------------------------------------------------------------------------
//
// `name` / `avatar` (plain strings) and the live `profile` cell are resolved
// from the viewer's shared profile in the pattern body (via wish). The handler
// appends a snapshot to the shared roster and records that this viewer joined.
// Identity is keyed on the `profile` CELL — never the display name, which is
// mutable and may collide between distinct users. `profile` round-trips through
// `push` as a link and is compared with `equals()`, the cell-identity idiom.

const join = handler<JoinEvent, {
  roster: RosterCell;
  viewer: ViewerCell;
  // May be undefined until the viewer's `#profile` wish resolves; guarded below.
  profile: ParticipantProfileCell | undefined;
  name: string;
  avatar: string;
}>((_event, { roster, viewer, profile, name, avatar }) => {
  const trimmed = (name ?? "").trim();
  if (!trimmed) return; // No resolved profile name yet — nothing to contribute.
  if (!profile) return; // No resolved profile cell — no stable identity yet.

  // Idempotent: dedupe by profile-cell identity so a viewer who later renames
  // still counts as joined, and two distinct users sharing a display name don't
  // block each other.
  const participants = roster.key("participants");
  const already = participants.get().some((p) => equals(p.profile, profile));
  if (!already) {
    participants.push({
      profile,
      name: trimmed,
      avatar: (avatar ?? "").trim(),
      joinedAt: safeDateNow(),
    });
  }
  viewer.set({ joined: true, joinedName: trimmed });
});

// ---------------------------------------------------------------------------
// Pattern input / output
// ---------------------------------------------------------------------------

export interface RosterDemoInput {
  /** Shared roster — every user in the space reads & appends to this. */
  roster?: PerSpace<Roster | Default<typeof DEFAULT_ROSTER>>;
  /** Current viewer's join marker — follows the user, not broadcast directly. */
  viewer?: PerUser<ViewerState | Default<typeof EMPTY_VIEWER>>;
}

export interface RosterDemoOutput {
  [NAME]: string;
  [UI]: VNode;
  roster: PerSpace<Roster | Default<typeof DEFAULT_ROSTER>>;
  viewer: PerUser<ViewerState | Default<typeof EMPTY_VIEWER>>;
  participantCount: number;
  join: Stream<JoinEvent>;
}

export default pattern<RosterDemoInput, RosterDemoOutput>(
  ({ roster, viewer }) => {
    // Resolve THIS viewer's shared profile. Under PR #3830 this yields the
    // user's default profile (or the picker result if they have >= 2). `#profile`
    // gives the live profile CELL (the stable identity used to dedupe); the
    // convenience targets give just the snapshot strings.
    const profileWish = wish<{ name?: string; avatar?: string }>({
      query: "#profile",
    });
    const profileNameWish = wish<string>({ query: "#profileName" });
    const profileAvatarWish = wish<string>({ query: "#profileAvatar" });

    // Derived viewer-facing values. Falls back gracefully if the profile has
    // not resolved yet (e.g. user has no profile, or it is still loading).
    const myName = computed(() => profileNameWish.result ?? "");
    const myAvatar = computed(() => profileAvatarWish.result ?? "");
    // The live profile cell — passed to the join handler as the identity key.
    const myProfile = profileWish.result;

    const participants = roster.participants;
    const participantCount = participants.length;
    const hasJoined = computed(() => viewer.joined === true);
    // Inside a `computed` body, named `computed` values (hasJoined, myName)
    // auto-unwrap to their plain value — do NOT call `.get()` on them here.
    const joinLabel = computed(() =>
      hasJoined ? "Joined" : "Join as " + (myName || "...")
    );

    const boundJoin = join({
      roster,
      viewer,
      profile: myProfile,
      name: myName,
      avatar: myAvatar,
    });

    return {
      [NAME]: "Shared-profile roster",
      [UI]: (
        <cf-screen>
          <cf-vstack gap="3" style={{ padding: "1rem" }}>
            <cf-hstack justify="between" align="center">
              <cf-heading level={3}>
                Participants ({participantCount})
              </cf-heading>
              <cf-button onClick={boundJoin} disabled={hasJoined}>
                {joinLabel}
              </cf-button>
            </cf-hstack>

            {/* Other users' names/avatars rendered straight from the roster. */}
            <cf-vstack gap="2">
              {participants.map((p) => (
                <cf-hstack gap="2" align="center">
                  {p.avatar
                    ? (
                      <img
                        src={p.avatar}
                        style={{
                          width: "28px",
                          height: "28px",
                          borderRadius: "50%",
                          objectFit: "cover",
                        }}
                      />
                    )
                    : (
                      <div
                        style={{
                          width: "28px",
                          height: "28px",
                          borderRadius: "50%",
                          background: "var(--cf-theme-color-border, #ccc)",
                        }}
                      />
                    )}
                  <span>{p.name}</span>
                </cf-hstack>
              ))}
            </cf-vstack>
          </cf-vstack>
        </cf-screen>
      ),
      roster,
      viewer,
      participantCount,
      join: boundJoin,
    };
  },
);
```

### Notes on the demo

- **`myName` / `myAvatar` are passed as plain string state to the handler.** The
  CTS transformer auto-unwraps named `computed` values when used as handler
  state, so the handler receives the resolved string, not a cell. Do not call
  `.get()` on them inside the handler.
- **`participants.map(...)` runs on a direct input cell** (`roster.participants`),
  which is the form the transformer lowers to `.mapWithPattern(...)`. Mapping a
  cell reached through a nested map entry would not convert — keep the roster
  array a direct field as shown.
- **`viewer` stays `PerUser`.** Switch it to `PerSession` if "joined" should
  reset in a fresh tab; the join logic is unchanged either way.
- **No `.set()` before the pattern takes over.** The roster/viewer cells use
  `Default<>` so they start empty without any imperative seeding.

### Live-link variant (advanced)

If you adopt the live-link approach instead, resolve the whole profile and store
its cell reference, then render reactively. The current viewer's own result is
known to render via `cf-cell-link` / `cf-render`:

```tsx
const profileWish = wish({ query: "#profile" }); // result is ProfileHomeOutput-shaped
// In a handler that has access to the live cell, push { profile: profileWish.result, joinedAt }.
// Render an entry with: <cf-cell-link $cell={entry.profile} /> or <cf-render $cell={entry.profile} />.
```

Validate cross-space resolution for *all* viewers before shipping this — see the
uncertainty note above. A hybrid (snapshot for rendering + link for an explicit
refresh) is usually the safer way to get freshness.

## Recommended approach for chat/game patterns

1. Make the roster `participants: PerSpace<{ ... }[] | Default<[]>>`. Keep
   "have I joined" / draft text as `PerUser<>` (persists across the user's tabs)
   or `PerSession<>` (resets per tab). Never put user/session ids into ordinary
   shared data to fake isolation — use the scope wrappers.
2. On join, resolve the current viewer's shared profile with
   `wish({ query: "#profile" })` (or `#profileName` / `#profileAvatar` for just
   the fields). This returns the user's default profile under PR #3830, with the
   framework picker handling the multi-profile case.
3. **Store a snapshot** (name + avatar copied at join time) in the roster by
   default. Use a live link only when freshness matters and cross-space
   resolution is confirmed; prefer a hybrid if you need both.
4. Append idempotently — guard on "already joined" so re-renders and reconnects
   don't duplicate entries (see the `join` handler above).
5. Render every other participant's name/avatar directly from `participants`.
   Do not attempt to enumerate other users' profiles — there is no runtime
   primitive for it, and the contributed roster already has everything you need.

## Runnable pattern

A deployable version now lives at
[`packages/patterns/shared-profile-roster/main.tsx`](../../packages/patterns/shared-profile-roster/main.tsx).
It follows the snapshot model above and renders with the identity components:

- Participants render via **`<cf-avatar src={p.avatar} name={p.name} />`** — one
  component covering the image / glyph / initials cases uniformly (no hand-rolled
  `<img>` + placeholder `<div>`).
- The current viewer's own identity renders via the trusted
  **`<cf-profile-badge $profile={profileWish.result} />`** — the one place a live
  profile cell is reliably resolvable (the viewer's own `#profile`).

Verified deployed (`cf piece new … main.tsx`): renders with 0 console errors;
participant rows show image/emoji/initials avatars; the viewer badge shows the
profile (or a graceful "Unknown profile" fallback when the identity has none).

## Follow-ups (not done here)

- The runnable pattern uses a **snapshot** roster. A live-link / hybrid variant
  (rendering *other* users' rosters via `cf-profile-badge` bound to their profile
  cell) still needs the cross-space resolution validation called out above before
  it can be relied on for real multiplayer.

## References

- `docs/specs/shared-profile-space.md` — CT-1645 shared profile space, `wish`
  profile targets, owner-protected profile writes.
- `packages/runner/src/builtins/wish.ts` — `#profile`, `#profileName`,
  `#profileAvatar` resolution and the `WishState` result shape.
- `packages/patterns/system/profile-home.tsx` — `ProfileHomeOutput`
  (`name`, `avatar`, `elements`, `initialNameApplied`) that `#profile` resolves
  to.
- `packages/patterns/shared-profile-demo/main.tsx` — minimal `#profile` consumer.
- `packages/patterns/scrabble/scrabble.tsx`,
  `packages/patterns/scoped-user-directory/main.tsx`,
  `packages/patterns/scoped-group-chat/main-plain-inputs.tsx` — `PerSpace`
  roster + join-handler precedents.
- `docs/common/patterns/multi-user-patterns.md` — scope-boundary guidance.
