# Lunch Coordinator: roadmap

`cozy-poll-scoped` started life as a collaborative "where should we eat?" poll
(🟢 love it / 🟡 OK / 🔴 veto, fewest-reds-wins). The next evolution turns it
into a full **Lunch Coordinator** — the poll stays at the core, but it grows the
context a group actually needs to pick a place and go.

This doc tracks the features we plan to add. Nothing here is built yet; it's the
backlog.

## Planned features

### 1. "Last days we went" history

Keep a per-space log of where the group actually ended up eating, with dates, so
nobody suggests the same place three days running.

- Append a history entry when a poll resolves (or via a manual "we went here"
  action).
- Surface recent history in the option list — e.g. dim or flag options visited
  in the last N days.
- Use it for a soft "you had this Tuesday" nudge rather than a hard block.

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

## Notes

- These features should layer on top of the existing scoped-cells identity model
  (`users` per-space directory, `myName` per-user, derived `isAdmin`). See
  [`ADMIN-FUTURE.md`](./ADMIN-FUTURE.md) for the planned move from pattern-level
  admin checks to CFC integrity claims — favorites and history writes are good
  candidates for the same authorship-claim treatment.
- Map, calendar, and explorer mode all imply external data sources; sequence
  those after the local-only features (history, favorites) which need no new
  capabilities.
