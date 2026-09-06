---
status: historical
created: 2026-09-05
archived: 2026-09-05
reason: "Record of the deliberate contract break taken when the collection-naming exemplar's mention-universe binding became readable, which is what makes a member re-sourceable."
---

# Collection naming: the exemplar's mention universe becomes a readable binding

An item of the exemplar board is wired to the board's mention universe at
creation, and declared that binding writable:

```ts
mentionable?: Writable<ItemMentionable[] | Default<[]>>;
```

The `boardNames` input directly above it was already readable, on the ground
that the table is the board's derivation and a member has no business writing
into it. The mention universe is a derivation of the board's in exactly the
same sense, and the exemplar was carrying the writable form beside the readable
one.

## What the writable form costs

A member holding one cannot be re-sourced at all, with any source including its
own bytes. Measured on 2026-09-05 against a local rehearsal store, on an item
the exemplar board's `addItem` had created:

```
$ cf piece setsrc --check --cell /of:<item> <the item's own source>
piece source is incompatible with retained input: input link at mentionable
schema is not compatible: input link at mentionable[].piece: newly required
argument field has no default
```

The mechanism is that a writable handle puts the board's whole published row
inside the retained link's proof, which proves both directions. The board's row
publishes `piece`; `ItemMentionable` names three fields and not that one; so
the write-back direction fails on a field the demand does not declare.

The same refusal, on the Topics board rather than the exemplar, is Finding 2 of
[`plans/collection-naming-s6-backfill-rehearsal-2026-09-05.md`](plans/collection-naming-s6-backfill-rehearsal-2026-09-05.md),
which named the readable declaration as the untried fix.

## Nothing writes through the binding

The item's only consumer of `mentionable` is the `$mentionable` prop of
`cf-code-editor`. That component makes one write through the handle it is
given: `_updatePieceName` in
`packages/ui/src/v2/components/cf-code-editor/cf-code-editor.ts` sets `title`
on the cell `findPieceById` returns, when a backlink's display text changes.

Which cell that is turns on whether an entry is an index row — an entry
carrying a `piece` property. The component re-reads its handle under
`MentionableArraySchema`, which declares `piece`, so the question is settled by
what the rows STORE rather than by what a member's demand selects. Every row
the board publishes is a `MentionableRow` from
`packages/patterns/collection-naming/mentionable.ts`, and every one of them
carries `piece`. For such an entry `findPieceById` returns the resolved piece
the row stands for, or `null` when resolution has not landed — never the row's
own sub-cell. So the write reaches the item a mention names, at that item's own
address, and never the universe the row sits in.

## Why this could not be done compatibly

`asCell` moves from `["cell"]` to `["readonly"]`, and the compatibility proof
compares that key for exact equality, so the transition is itself a break:

```
- argument.mentionable: asCell changed
```

No shape of the item avoids it while the binding is readable.

## What a piece holding the old contract loses

Nothing deployed. The exemplar has no instance beyond a throwaway local demo,
so no piece held the contract this replaces. A member deployed on the readable
contract is re-sourceable: the same `setsrc --check` that refuses an item
created by the writable-binding board accepts one created by the readable-
binding board, measured in the same rehearsal store on the same day.

## The paths this break blames

- `argument.mentionable` — the binding itself. `asCell` is a property of the
  whole demand rather than of an element, so the proof reports it there.

## What the next baseline gates against

The contract recorded once this break shipped — a readable mention universe
beside a readable names table — is a baseline no entry names, so the next
change to the item is gated against the shape this break left behind.
