---
status: historical
created: 2026-09-03
archived: 2026-09-03
reason: "Record of the deliberate contract break taken when the collection-naming exemplar's index rows became the members themselves."
---

# Collection naming: the exemplar's index rows become the members

The exemplar board in `packages/patterns/collection-naming/` reached main on
2026-09-03 (#6882) with a derived index: one row document per item, addressed
by the item, carrying the item as an unread `member` reference, copies of
`title` and `createdAt`, and the board's `name` for it. Two baselines recorded
that contract — `20260904T001531Z-WRSzkgeFJQmQt1ZM` at the stage's first
commit, and `20260904T022635Z-OsLnrwxWR4PfC0gG` after its doc comments became
schema descriptions — and under it the board's argument demanded `title` and
`createdAt` of a stored item and nothing else.

Decision 13 of the plan (Mike, 2026-09-03) changed what an index row is. The
exemplar follows Topics' contract: a row IS the member, so a row's own address
is the member's address and `index[].@` survives the graft onto Topics; and a
member's name reaches its row through the member's own `shortName`, coalesced
with a default the way Topics' `commentCount` is. The rehearsal over the
unmodified Topic, which publishes no `shortName`, proves naming through the
names table and the reverse lookup, and never depended on the row shape.

## Why this could not be done compatibly

The compatibility proof reported two findings against both baselines, and
neither had a pattern-side fix.

`result.index[].member: existing result field was removed`. A row that is the
item has no `member` field; the item is the row. The field was removed by the
ruling rather than by accident, and no shape of the board both keeps it and
makes a row the member.

`argument.items[]: defaults changed below a constraint that is not stable
under default insertion`. The row demand gained
`shortName: string | Default<""> | undefined`. The default is what lets a board
holding members from before it numbered anything — or one created a moment
ago, whose lookup has not run — read whole. Dropping the `| undefined` arm was
tested: declared `shortName: string | Default<"">`, the pattern compiler
refused the board at both places an item is handed to the row type, the
`addItem` result and the push into `items`, because the item publishes
`shortName` as `string | undefined`. So the arm is required where an item
meets the row type, and the demand moved with it.

## What a piece holding the old contract loses

Nothing deployed. The exemplar had been on main for about an hour when the
decision was made and had no instance beyond a throwaway local demo toolshed,
so no piece held the old contract to become a casualty. The library,
`naming.ts`, kept its contract, and `item.tsx` did not change.

## The paths this break blames

- `result.index[].member` — the published side: the derived row document's
  reference to its item, gone with the derived row.
- `argument.items[]` — the demand: the row demand's defaulted `shortName`.

## What the next baseline gates against

The contract recorded once this break shipped — a row demand of `title`,
`createdAt`, and `shortName`; `index` as the items themselves through it; and
an `addItem` result of the item beside the allocated `name` — is a baseline no
entry names, so the next change to the board is gated against the shape this
break left behind.
