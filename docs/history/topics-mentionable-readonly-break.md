---
status: historical
created: 2026-09-05
archived: 2026-09-05
reason: "Decision record for the Topic `mentionable` contract break: the board's mention universe reaches a topic as a readable cell rather than a writable one."
---

# Topic mention-universe readable-cell contract break

`TopicInput.mentionable` in `packages/patterns/topics/topic.tsx` is declared
`ReadonlyCell<TopicMentionable[] | Default<[]>>`, matching the two board-wiring
inputs beside it, `boardCrossrefs` and `boardNames`. It was declared
`Writable<...>`, and the `asCell` marker the schema carries at that path changes
from `["cell"]` to `["readonly"]` with it.

## The decision

A writable handle is a two-way contract, and `cf piece setsrc` proves both
directions of it. `provePreservedContracts`
(`packages/piece/src/ops/piece-controller.ts`) proves the payload contract in
one direction normally, and adds the write-back leg when the destination handle
can write: a writable handle can send values back to the producer, so the
destination's payload contract must also fit the source's.

The two sides of this link have never agreed in that direction. The board
publishes `MentionableRow` (`packages/patterns/collection-naming/mentionable.ts`)
with a required `piece`; the topic demands `TopicMentionable`, three strings and
no `piece`, deliberately — the narrow demand is what keeps a warm or a watch of
one topic's argument from reaching every sibling topic through its mention
universe. So on the write-back leg `piece` reads as a newly required argument
field with no default, and the proof fails.

Nothing about that failure depends on the two sources differing, so every Topic
wired to a board's `mentionable` was refused its own bytes:

```
$ cf piece setsrc --cell "$TOPIC" ./out/topic.tsx --check
…/topic.tsx cannot replace the source for piece of:fid1:wU97rg…:
piece source is incompatible with retained input: input link at mentionable
schema is not compatible: input link at mentionable[].piece: newly required
argument field has no default
```

Declaring the narrower cell drops the write-back leg and leaves the ordinary
one-direction check, which passes.

## What the declaration does not do

It does not stop a write, and the decision rests on that being measured rather
than assumed. Two holder patterns differing in nothing but `Writable` against
`ReadonlyCell` were deployed over one list of member pieces — the "plain list
of the pieces themselves" shape — each rendering a `cf-code-editor` bound to
that list. In a real browser against a real store, the write
`cf-code-editor._updatePieceName` performs was run through each editor's own
handle, by both routes the component takes: the raw sub-cell
(`handle.key(i).key("title").set(...)`) and the cell `resolveAsCell()` follows
the entry's link to. All four attempts threw nothing, re-rendered the member's
title, and committed — the store read back the written titles afterwards. The
two declarations were indistinguishable.

So the marker states the contract and documents ownership; it is not a runtime
gate, and the editor's name write-back keeps working for a board whose universe
is the raw member list. Where the marker does bite is a piece operation
traversing the path; a whole-document apply and a terminal link-bind both return
before that check, so the operator's `cf piece link` rewire is unaffected.

What no write reaches, in any shape, is the index's own contents. `topic.tsx`
holds no `.set`, `.push` or `.update` on `mentionable`; its one consumer is the
`$mentionable` binding. The editor's write lands in a member's document, not in
the array of links. Where the universe IS the derived index, the raw sub-cell is
withheld — `findPieceById` answers "not found" for a row it has not resolved —
so the write reaches the topic behind the row. And the `mentionable.push(...)`
some other patterns run is driven by an `onbacklink-create` binding, which a
topic does not bind.

The alternative was to declare `piece` on the topic's projection, at the cost of
a demand naming a field the topic never reads, which is the cost the narrow
demand was adopted to avoid
(`docs/history/topics-mentionable-index-break.md`). Forcing each update past the
proof with `--dangerously-allow-incompatible-schema` was the third option, and
it costs the pre-flight signal permanently: with every Topic update forced,
`--check` can no longer tell a safe Topic update from an unsafe one.

## What broke, on purpose

- `argument.mentionable`: `asCell changed`. The semantic-extension keys are
  compared for exact equality by `assertPatternSchemasBackwardCompatible`
  (`packages/piece/src/schema-compatibility.ts`), so a cell that narrows from
  writable to readable is a break however narrow the narrowing is. The element
  type is untouched, and so is every other path.

The same break was taken on `boardCrossrefs` when it was narrowed the same way,
and is carried in the accepted-break entry covering the baselines through
`20260819T172917Z-K_8fL8hZtM4xYV7V`.

## Disposition of deployed pieces

A Topic already deployed at the writable declaration takes this one update with
`--dangerously-allow-incompatible-schema`, and every update after it is proven
again. Rehearsed on a local store, on a Topic filed through the board's
`addTopic` and therefore wired to the board's `mentionable`: the forced update
committed, the topic read back its `title`, `shortName` and `createdBy`
unchanged, and the next `setsrc --check` against the same source returned `can
replace the source`. A Topic deployed at the readable declaration is checkable
from the start.

Nothing is stranded. The argument link is the same link, pointing at the same
board output; what changes is the marker on the schema that describes it.
