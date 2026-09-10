---
status: historical
created: 2026-08-31
archived: 2026-08-31
reason: "Decision record for the topics mention-universe contract break: `mentionable` became a derived index of two-string rows rather than the topics themselves."
---

# Topics mention-universe index contract break

The board's `mentionable` output stopped being the topics themselves and
became a derived index: one small document of
`{ [NAME], title, piece }` rows, where the two strings are copies and
`piece` is the topic held as a reference that nothing on the pattern side
reads through (`TopicMentionableRow` in `packages/patterns/topics/main.tsx`).

## The decision

`mentionable` is read by every topic on the board — each child's body editor
autocompletes over it — so whatever it is wired to is multiplied by the
board's own size. Wired to the raw topics list, every topic's declared
demand (two strings per sibling) crossed into every sibling topic, and
document-granular delivery shipped each one whole to serve those two
strings. Measured on the deployed board, that one watch class accounted for
8.17 MB and 6,203 documents of a topic resume's 9.9 MB frame — 82%, with
the next-largest root at 0.34 MB — and the multi-second
`session.watch.add` establishment walks share the same root.

The index bounds the product: one derivation reads the two strings out of
each topic, and every reader everywhere reads the one document the copies
land in. `piece` is deliberately NOT part of the `TopicMentionable` demand
the topic pattern declares, so the walks that warm and watch a topic's
argument never reach a sibling topic through its mention universe; the
editor reaches `piece` through its own declared contract
(`Mentionable.piece` in `packages/ui/src/v2/core/mentionable.ts`, the
`MentionRef.destination` shape) at the moment a completion is picked, so a
mention still stores the topic and never a row.

## What broke, on purpose

- `result.mentionable[].body` (and the rest of the `TopicDemand` surface the
  old alias carried — summary scalars, `mentions`) is gone from the
  published `mentionable` rows: a row carries the two strings the
  autocomplete needs and the piece reference, nothing else. The narrowness
  is the point — every field a row carried by value would be shipped to
  every reader of the universe.
- The stored `mentionable` output VALUE changed shape wholesale: it was a
  link to the board's `topics` list — an alias with no state of its own —
  and is now the derived rows. Nothing is stranded but the alias itself:
  the topics survive unchanged at their own addresses, still published
  through `topics` and `index`.

## Disposition of deployed pieces

Existing topics hold a `mentionable` argument link to the board's raw
`topics` list. Their declared element demand (`{ [NAME], title }`) is
satisfied by the index rows as-is, so the migration is the one-time
link-bind the input has documented for itself since it was introduced:
rewire each topic's `mentionable` argument to the board's `mentionable`
output. Until a piece is rewired it keeps reading the raw list — correct,
just at the old cost. Vintages captured before the change (both pinned
topics fixtures, `capturedThrough: 2026-08-06T23-04-13.189Z`) are forgiven
exactly the replaced path; vintages captured after hold index rows and are
compared with no exemption.
