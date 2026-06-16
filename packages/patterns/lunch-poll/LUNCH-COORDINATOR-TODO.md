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

- ✅ Stored in a **SQLite `visits` table** (`sqliteDatabase(...)` in the pattern
  body), reworked from the original `history: PerSpace<HistoryEntry[]>` array as
  the team's first dogfood of the SQLite builtins (PRs #3776/#3848). Columns:
  `id, title, logged_by (TEXT name snapshot), logged_by_cf_link (cfLink<User>
  live pointer), went_at`.
  **No more 50-entry cap** — a table grows fine; the read query bounds itself
  with `LIMIT 8`. Appended via the host-only `logVisit` (`db.exec` INSERT). Each
  option still has a "✓ we went here" button.
- ✅ **Backdating:** a host "Log 'we went here' as of:" date field (blank =
  today) backdates the entry; `logVisit` also accepts an explicit `wentAt`. The
  date draft clears after each log so it defaults back to today.
- ✅ **Editing:** `removeHistoryEntry({ id })` (`db.exec` DELETE) drops a single
  mistaken entry via a per-row ✕; `clearHistory` (two-step confirm) truncates
  the table. Both host-only, and both also clear the matching `vote_history`
  rows.
- ✅ Shown as a **"Recently eaten" list below the options** (8 most recent,
  most-recent-first), a `db.query` rendered with the SAME plain-JSX `.map`
  idiom, labelled with each visit's own date ("Tuesday, May 20").
- Implementation notes (hard-won):
  - Visit labels derive **only from the stored `went_at`**, never from the
    current clock — `safeDateNow()` inside a `derive`/`computed` is
    non-idempotent (it belongs in handlers, like the backdate parse).
  - Interactive `onClick` handlers must live in **plain-ternary JSX**, not
    inside a `computed/lift`-returned VNode, or they mis-lower as lifts
    (`$event in inputs`). The `db.query` result is fed to the card via
    `computed(() => recentVisits.result ?? [])` — an OpaqueRef<row[]> shaped
    exactly like the old `recentHistory` array, so the plain-JSX `.map` (where
    the handlers live) is preserved unchanged.
  - **SQLite issues found while dogfooding** (see
    `session_outputs/2026-06-04_lunch-poll-sqlite/` for full writeups):
    1. _(worked around)_ The `@db/sqlite` binding truncates a bound JS number to
       32 bits, so a ms-epoch `went_at` round-trips as garbage. Workaround:
       store timestamps as zero-padded TEXT (`encodeTs`/`decodeTs`); 16-digit
       padding keeps `ORDER BY` correct.
    2. _(worked around, test-runner only)_ `reactOn: db` left the `recentVisits`
       query stale after writes in the emulated test runner; reacting on a
       `PerSpace<number>` `sqliteRev` counter the handlers bump is reliable.
    3. _(resolved by runtime PR #3967)_ On a _deployed_ piece, `db.exec` in the
       mutating handlers threw "invalid database handle" — the `SqliteDb` handle
       wasn't materialized on the deployed handler-input path (worked fine in
       the emulated `cf test` runner). Root cause was a **client-side dispatch
       race**: `cf piece call` dispatched the handler before its asCell input
       docs had synced into the local replica, so the synchronous handle read
       saw an empty doc. Fixed in the runtime by #3967 (merged) and verified
       end-to-end on a deployed prod piece — `db.exec` writes land and the
       migration is fully live. Full writeup in `SQLITE-DEPLOY-BUG.md`.

### 2026-06-15 — Durable vote-history snapshot

When the host logs a visit, snapshot **who voted what** at that moment into a
SQLite `vote_history` table tied to the visit. Live voting stays on the in-cell
`votes` array — only the durable record is in SQLite.

- ✅ `vote_history`
  (`id, visit_id, voter, voter_cf_link, option_title,
  vote_color, went_at`).
  `logVisit` loops the current votes and writes one row each (option title
  denormalized; voter as both a frozen name and a live `cfLink<User>`). All
  INSERTs fold into the one handler commit.
- ✅ Surfaced as a read-only **"📊 Lunch stats"** card (a `GROUP BY` query):
  per-place visit count + green/red tallies across the whole record.
