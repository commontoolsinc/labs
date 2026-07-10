# Lunch Coordinator: roadmap

`lunch-poll` started life as a collaborative "where should we eat?" poll (🟢
love it / 🟡 OK / 🔴 veto, fewest-reds-wins). The next evolution turns it into a
full **Lunch Coordinator** — the poll stays at the core, but it grows the
context a group actually needs to pick a place and go.

This doc separates shipped work from the remaining backlog so the roadmap stays
useful as the pattern evolves.

## Todo work

### 1. Per-option vote-history recap

Show a compact per-option history such as "last N times we did X: 🟢🟢🟡". This
likely needs a per-option query inside `options.map`, so it was deferred from
the durable vote-history snapshot work.

### 2. People's favorite foods

Let each participant record favorite foods / cuisines / dietary constraints on
their profile (per-user, in the space directory).

- Extend the `User` profile with `favorites: string[]` and
  `restrictions: string[]` (vegetarian, allergies, etc.).
- When an option is added, highlight whose favorites it matches and warn about
  restriction conflicts.
- Feeds future ranking/suggestion logic.

### 3. Calendar integration

Tie the poll to an actual lunch slot so coordination is real, not hypothetical.

- Read the group's availability / a shared lunch event from a calendar source.
- Show the target time alongside the poll; auto-close voting before that time.
- Optionally write the chosen place back as a calendar event with the location.

### 4. Map view

Show the candidate options on a map so distance and clustering are visible.

- Geocode each option (address / place name → lat-long).
- Render a map with pins for each option, colored by current vote standing.
- Show walking time / distance from a configurable origin (office).

### 5. Explorer mode

A discovery mode for when the group is bored of the usual rotation.

- Suggest nearby places the group hasn't tried (cross-reference the history log
  and the map).
- Pull in candidates by cuisine that match people's favorites.
- One-tap "add this as an option" from a suggestion into the live poll.

### 6. Open/closed days per location

Track which days of the week each place is closed (or open) so a location that's
shut today never even shows up as a votable option. Almost every spot in a real
rotation is dark at least one work day, and nothing's more deflating than the
poll picking a place that's closed when you walk over.

- Add a per-option `closedDays` field (e.g. a set of weekday indices, or
  `hours: PerWeekday<{ open, close } | "closed">` if we want open/close times
  later). Editable host-side when an option is added or via a per-option editor.
- Filter the live ballot by the **current weekday**: an option closed today is
  hidden from voting (or shown greyed-out and non-votable, "closed Mondays").
  Derive the weekday in a handler-fed cell, not inside a `computed`/`derive` —
  reading the clock in a derive is non-idempotent (same lesson as the history
  visit labels in feature #1).
- Keep hidden options in the data so they reappear automatically on a day
  they're open; don't delete them.
- Plays well with feature #3 (calendar): the target lunch slot's date decides
  which weekday we filter on, so a poll scheduled for tomorrow can already drop
  places closed tomorrow.

## Notes

- These features should layer on top of the existing scoped-cells identity model
  (`users` per-space directory, `myName` per-user, derived `isAdmin`). See
  [`ADMIN-FUTURE.md`](./ADMIN-FUTURE.md) for the planned move from pattern-level
  admin checks to CFC integrity claims — favorites and history writes are good
  candidates for the same authorship-claim treatment.
- Map, calendar, and explorer mode all imply external data sources; sequence
  those after local-only features that need no new capabilities.

## Completed work

Completed entries are ordered newest first. Dates use the local merge/commit
date for the completed work.

### 2026-06-16 — Pattern composition refactor and sub-pattern standards

The lunch poll now exercises pattern-to-pattern composition by factoring the
largest UI-bearing pieces out of `main.tsx` into sibling pattern modules:

- ✅ `generated-art.tsx`: fallback-backed generated food thumbnail. It exposes
  `[UI]`, `url`, and `fetchState`; callers can render it as JSX when they only
  need UI, or instantiate by function call when they need the generated URL.
- ✅ `poll-option-card.tsx`: one ranked restaurant option row, including vote
  buttons, vote-state styling, homepage display/edit/lookup, host-only
  remove/history actions, and generated-art persistence.
- ✅ `participant-identity-card.tsx`: join/admin identity surface. It exposes
  `me`, `isJoined`, `isAdmin`, `joinAs`, and `claimHost` for the parent to use
  when gating add-option controls, per-option voting, and host-only actions.

Standards established by this factoring:

- Each UI-bearing sub-pattern is its own module with `export default pattern`
  and exported `Input`/`Output` interfaces.
- Public contracts include `[NAME]` and static `[UI]: VNode`; `[UI]` is never
  wrapped in `computed`.
- The parent owns durable/shared state (`PerSpace`/`PerUser`/`PerSession` cells)
  and passes cells or resolved values down. Children may own only local
  per-session UI state.
- Use JSX instantiation when only embedding a child's UI; use function-call
  instantiation when the parent reads child outputs or streams.
- Field names are exact composition contracts, not auto-mapped. Imports are
  direct sibling imports, not barrel exports.
- Each factored pattern has an overview comment plus documented `Input` and
  `Output` fields so future consumers can evaluate functionality and contract.
- Focused pattern tests are part of the contract for non-trivial sub-patterns:
  test the public outputs, streams, and rendered states that would otherwise
  regress silently. Very small render-only wrappers can stay covered by parent
  or integration checks when a direct test would only assert VNode plumbing.

Gotchas preserved during extraction:

- `myName` is resolved once in `main.tsx` into `me` before `options.map(...)`;
  per-option children receive that resolved value, not the raw `PerUser` cell.
- The generated-art fallback remains a static CSS `background-image`; generated
  or stored `<img>` content is only overlaid once a safe non-empty URL resolves.

Verification added or run for this work:

- Focused tests for `poll-option-card.tsx` and `participant-identity-card.tsx`.
- Existing `main.test.tsx`, `multi-user.test.tsx`, and lunch-stats coverage kept
  green.
- Deployed locally to Toolshed and manually verified that the composed pattern
  loads and the extracted UI still runs.

### 2026-06-15 — "Last days we went" history

Keep a per-space log of where the group actually ended up eating, with dates, so
nobody suggests the same place three days running.

- ✅ Stored in a **`PerSpace<HistoryEntry[]>` array** (the `visits` input). Each
  new entry is a deterministic keyed entity containing
  `{ id, title, loggedByName (frozen), loggedBy (live Cell<User> link), wentAt,
  votes }`.
  The host-only `logVisit` migrates readable legacy rows to keyed links and uses
  a conflict-checked rewrite to keep the most-recent `MAX_HISTORY` (200)
  entries. Opaque pre-keying memberships are preserved and use best-effort
  capping rather than being silently deleted. Each option still has a "✓ we went
  here" button.
  - History was briefly on a **SQLite `visits` table** (#4144/#4145, the team's
    first dogfood of the SQLite builtins, #3776/#3848). It surfaced real builtin
    bugs (below), but SQLite wasn't the right fit for a small in-cell collection
    — it's now back on plain fabric storage.
- ✅ **Backdating:** a host "Log 'we went here' as of:" date field (blank =
  today) backdates the entry; `logVisit` also accepts an explicit `wentAt`. The
  date draft clears after each log so it defaults back to today.
- ✅ **Editing:** `removeHistoryEntry({ id })` drops keyed membership and clears
  its entity (with a positional fallback for readable legacy rows);
  `clearHistory` clears every readable keyed entity and then explicitly empties
  all membership, including opaque legacy links. Both are host-only. The
  embedded vote snapshot goes with a readable entry — no separate cascade to
  keep aligned. An opaque target document is not guessed at or destroyed when
  its membership is cleared.
- ✅ Shown as a **"Recently eaten" list below the options** (8 most recent,
  newest first), a `computed` over `visits` rendered with the plain-JSX `.map`
  idiom, labelled with each visit's own date ("Tuesday, May 20").
- Implementation notes (hard-won):
  - Visit labels derive **only from the stored `wentAt`**, never from the
    current clock — `safeDateNow()` inside a `derive`/`computed` is
    non-idempotent (it belongs in handlers, like the backdate parse).
  - Interactive `onClick` handlers must live in **plain-ternary JSX**, not
    inside a `computed/lift`-returned VNode, or they mis-lower as lifts
    (`$event in inputs`). `recentVisits` is an array-shaped `computed`, so the
    plain-JSX `.map` (where the handlers live) is preserved unchanged.
  - The SQLite era surfaced real builtin bugs, kept here as history (the
    fabric-array model has none of them): the `@db/sqlite` binding truncated
    bound JS numbers to 32 bits (worked around with TEXT-encoded timestamps);
    `reactOn: db` left queries stale after writes in the test runner (worked
    around with a `sqliteRev` write-counter); async query flushes landed after
    the light settle (needed `{ settle: true }` test steps); and a
    deployed-piece "invalid database handle" dispatch race (resolved by runtime
    PR #3967).

### 2026-06-15 — Durable vote-history snapshot

When the host logs a visit, snapshot **who voted what** at that moment, embedded
in the entry's `votes` list. Live voting stays on the in-cell `votes` array —
the log keeps its own frozen copy.

- ✅ Each entry's `votes` is
  `{ voter (frozen), voterLink (live Cell<User>),
  optionTitle (denormalized), color }[]`.
  `logVisit` loops the current votes and embeds one snapshot each (option title
  denormalized so the snapshot survives the option being removed).
- ✅ Surfaced as a read-only **"📊 Lunch stats"** card (the `summarizePlaces`
  group-by `computed`): per-place visit count + green/yellow/red tallies across
  the whole record, scoped to the votes cast for each visited place.
