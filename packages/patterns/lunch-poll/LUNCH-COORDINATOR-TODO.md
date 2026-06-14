# Lunch Coordinator: roadmap

`lunch-poll` started life as a collaborative "where should we eat?" poll (🟢
love it / 🟡 OK / 🔴 veto, fewest-reds-wins). The next evolution turns it into a
full **Lunch Coordinator** — the poll stays at the core, but it grows the
context a group actually needs to pick a place and go.

This doc tracks the features we plan to add. Feature #1 below is now built; the
rest are still backlog.

## Planned features

### 1. "Last days we went" history ✅ (shipped)

Keep a per-space log of where the group actually ended up eating, with dates, so
nobody suggests the same place three days running.

- ✅ `history: PerSpace<HistoryEntry[]>`
  (`{ id, title, loggedByName, wentAt }`), appended via a host-only `logVisit`
  handler. Each option has a "✓ we went here" button that logs that place. The
  stored log is capped at the 50 most recent visits so the PerSpace array can't
  grow without bound.
- ✅ **Backdating:** a host "Log 'we went here' as of:" date field (blank =
  today) backdates the entry; `logVisit` also accepts an explicit `wentAt`. The
  date draft clears after each log so it defaults back to today.
- ✅ **Editing:** `removeHistoryEntry({ id })` deletes a single mistaken entry
  ("we didn't actually eat there") via a per-row ✕; `clearHistory` (two-step
  confirm) wipes the whole log. Both host-only.
- ✅ Shown as a **"Recently eaten" list below the options** (8 most recent,
  most-recent-first), labelled with each visit's own date ("Tuesday, May 20").
  No per-option nudge — history lives in this one section.
- Implementation notes (hard-won; see also `scoped-cells-field-notes.md`):
  - Visit labels derive **only from the stored `wentAt`**, never from the
    current clock — calling `safeDateNow()` inside a `derive`/`computed` is
    non-idempotent (it belongs in handlers, like the backdate parse). This is
    also why there's no live "within the last N days" window; we show the
    visit's own date and let the human judge.
  - Interactive `onClick` handlers must live in **plain-ternary JSX**, not
    inside a `computed(() => …)`-returned VNode, or they mis-lower as lifts
    (`$event in inputs` → non-idempotent write).
  - Don't name a `.map((h) => …)` callback `h` when the body contains JSX — `h`
    is the JSX factory; shadowing it yields `TypeError: h is not a function`.

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
  those after the local-only features (history, favorites) which need no new
  capabilities.
