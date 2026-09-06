---
status: historical
created: 2026-09-05
archived: 2026-09-05
reason: "Record of the deliberate contract break taken when the collection-naming exemplar's `shortName` was aligned to the optional spelling Topics ships."
---

# Collection naming: the exemplar's `shortName` takes Topics' spelling

The exemplar in `packages/patterns/collection-naming/` exists to prove a
contract before it is grafted onto Topics. On `shortName` it proved a spelling
Topics does not ship, and the two diverged: the exemplar declared the property
defaulted and the Topics patterns declare it optional.

As the exemplar stood before this change, at `3d0f1e80ae`:

- `ItemIndexRow.shortName: string | Default<""> | undefined` in `board.tsx`,
  which is both the board's demand of a stored item (`ItemDemand` is that same
  interface) and the row the board publishes as `index`.
- `ItemOutput.shortName: string | undefined` in `item.tsx`, the item's own
  publication.
- `ItemMentionable.shortName: string | Default<"">` in `item.tsx`, what an
  item demands of an entry in the mention universe its editor completes over.

The Topics patterns declare the same property in the same four roles as
`shortName?: string`: `TopicDemand` and `TopicIndexRow` in `topics/main.tsx`,
and `TopicPiece` and `TopicMentionable` in `topics/topic.tsx`. Each carries a
doc comment saying the optional spelling is what keeps a demand applicable over
a board deployed before the namespace, and that a defaulted property there
moves the demand's defaults below an array constraint the compatibility proof
cannot show stable under default insertion. The second half of that is right
and the first half is not; see "What this record does not claim" below.

Two sites were already shared rather than divergent, and did not change.
`mentionable.ts` is one module both boards derive their mention universe
through. Its `MentionableRow.shortName: string | Default<"">` is a row of a
derived document of copies, not a demand over deployed members, and
`mentionableRowsOf` fills it for every member; the `mentionableIndex` lift's
own demand of a member already spells the property `shortName?: string`.

## What changed

The three divergent declarations became `shortName?: string`. Nothing else
about the naming moved: the item still reads its name out of the board's names
table through `ownName`, the board still publishes `index` as the items
themselves, and `naming.ts` is untouched. The mention universe's binding became
readable in the same change, which is a separate decision recorded in
[`collection-naming-mentionable-readonly-break.md`](collection-naming-mentionable-readonly-break.md).

The two halves have to move together. With the item publishing an optional
property and the board's row demanding a defaulted one, the pattern compiler
refuses the board at the two places an item meets the row type — the `addItem`
result and the push into `items` — reporting that `string | undefined` is not
assignable to `string | ("" & DefaultMarker<"">)`. That was measured at
`3d0f1e80ae` by declaring `ItemIndexRow.shortName: string | Default<"">`
against the aligned item and running `deno task cfcheck`, which named
`board.tsx` lines 230 and 253.

## Why this could not be done compatibly

`deno task pattern-compat` reports the alignment as incompatible against every
baseline that records the defaulted spelling, and no shape of the exemplar
avoids either issue while the property is optional.

`result.index[].shortName: result field is no longer required`, and
`result.shortName` the same on the item. An optional property is absent from
the schema's `required` list; the spelling the exemplar recorded,
`string | undefined`, is a required property whose type admits `undefined`, so
dropping the requirement is exactly the change being made.

`argument.items[]: defaults changed below a constraint that is not stable under
default insertion`, and `argument.mentionable[]` the same on the item. An
optional property carries no default, so removing the `Default<"">` moves the
demand's defaults.

## What a piece holding the old contract loses

Nothing deployed. The exemplar has no instance beyond a throwaway local demo,
so no piece held the contract this replaces.

## What this record does not claim

That the optional spelling deploys over a populated board. It does not, and
that was measured here rather than inferred.

A local rehearsal store on 2026-09-05 held two exemplar boards. Over a board
deployed at the defaulted spelling and holding two named items, the aligned
source is refused on both legs:

```
$ cf piece setsrc --check --cell /of:<board> <aligned board.tsx>
Pattern schemas are not backward compatible:
- argument.items[]: defaults changed below a constraint that is not stable under default insertion
- result.index[].shortName: result field is no longer required
piece source is incompatible with retained input: input link at items.0 schema
is not compatible: input link at items.0.shortName: a schema alternative
accepted previously is not accepted by the candidate
```

Over a second board, built from the aligned source with `shortName` removed
from the row demand and the item's publication — the shape of a collection
deployed before it numbered anything — and holding two items filed through its
own `addItem`, the aligned source is refused too, on the retained-link leg
alone:

```
$ cf piece setsrc --check --cell /of:<pre-namespace board> <aligned board.tsx>
piece source is incompatible with retained input: input link at items.0 schema
is not compatible: input link at items.0.shortName: an unconstrained schema is
no longer accepted
```

The checker was verified against a known answer first: re-checking a board with
the source it already runs is accepted. And the defaulted spelling is not an
alternative there, because with the item publishing an optional property it
does not compile at all.

That second refusal is the same one Finding 1 of
[`plans/collection-naming-s6-backfill-rehearsal-2026-09-05.md`](plans/collection-naming-s6-backfill-rehearsal-2026-09-05.md)
measured on a genuine pre-graft Topics clone, where a probe adding
`probeField?: string` and nothing else produced the identical message. What is
refused is any new property on a per-member demand, and the optional spelling
does not escape it. Neither `pattern-compat` nor `pattern-vintage` examines the
schema recorded on a link into a sibling piece, which is the check that fires.

What the optional spelling is proven to buy is the READ. That rehearsal
confirmed on a live board that a member publishing no `shortName` reads back as
an ordinary index row carrying a title and no name, with every row present.

## The paths this break blames

- `result.index[].shortName` and `result.shortName` — the published side: the
  board's row and the item's own publication stop requiring the name.
- `argument.items[]` and `argument.mentionable[]` — the demands: the row demand
  and the universe demand lose the property's default.

## What the next baseline gates against

The contract recorded once this break shipped — an optional `shortName` in all
four roles — is a baseline no entry names, so the next change to either pattern
is gated against the shape this break left behind.
