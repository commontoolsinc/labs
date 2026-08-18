---
status: historical
created: 2026-08-19
archived: 2026-08-19
reason: "Decision record for the lunch-poll identity contract break: display-name identity replaced by profile cells, approved in person 2026-08-18; the second accepted break in the pattern-update registries."
---

# Lunch-poll identity contract break

The lunch poll's identity moved from display names to the viewer's shared
profile cell, compared with `equals()` — agreed in Discord and approved in
person on 2026-08-18. This is the second accepted break in the pattern-update
registries (`tasks/pattern-compat-accepted-breaks.ts`), after the topics
reference-graph break it follows procedurally.

## The decision

A display name was the primary key for votes, roster membership, and host
status: mutable, non-unique, and silently lossy (same-name participants shared
votes and host status; renames orphaned votes; the live roster carries
name-variant duplicates people created to work around silent join rejections).
Identity is now the `#profile` cell. A vote carries its voter's cell; roster
entries carry `profile` with name/avatar as cosmetic snapshots; joined-ness
and host status are derived by cell comparison, so no per-user state can go
stale. Joining requires an identity that reads as present — the typed-name
path is gone, and a rejected join says why (`joinMessage`).

## What broke, on purpose

The name-keyed admin surface, in all three contracts that carried it:
`adminName` (main's argument and result, and the join card's argument),
the card's published viewer-name identity (`result.me`), and the option
card's viewer-name input (`argument.me`, replaced by the `viewerProfile`
cell). No shape keeps a name-keyed surface while removing name-keyed
identity.

## What deliberately did NOT break

Stored state applies cleanly. The new identity fields (`users[].profile`,
`votes[].voter`, visit snapshots' `voterProfile`) are optional — every row
this pattern writes carries them, enforced by store-site gates that require
the identity to read as present — and the new display field (`loggedByName`)
carries a default. A piece holding name-keyed rows updates in place: legacy
rows become display ghosts (they match no viewer, tally anonymously, and
their people re-join with profiles as themselves). The Tier 2 state gate
passes with no accepted-drop entries.

## Disposition of deployed pieces

In-place update is possible and non-lossy, with the ghost-row cosmetics
above. The recommended rollout for the team's populated poll remains a fresh
piece; either way, participants create or pick a shared profile once (the
join card's empty state is that surface).
