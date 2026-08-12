# Mention references in cf-code-editor

A mention can take either of two forms in the document. The wiki-link form,
`[[Name (id)]]`, carries its destination inside the sentence and is described in
[`backlinks.md`](backlinks.md). The reference form carries a short local key
instead, and the destination lives in a cell the host pattern owns:

```text
Doc text:    I read [Attention Framework][a3f9zz] last night.

$references: { a3f9zz: { destination: <cell>, modifiedTitle: false } }
```

The editor mints reference-form mentions when it is given a `$references` cell,
and wiki-links when it is not. Both forms are read whichever way it was given,
so a document part-way through a migration works.

## What a key is

Six characters over `[0-9a-z]`, minted by `mintRefKey` (`core/mention-refs.ts`)
against the keys the map already holds and the keys already in the document. It
is local to one document and means nothing outside it, which is what lets it be
short.

## Membership, not shape, decides

A token is a mention when **the map holds its key**. A token that looks like one
but whose key the map does not hold is ordinary text: not styled, not protected,
not collected. This is what keeps a hand-written reference link —
`[the docs][readme]` — editable, and it is worth being deliberate about, because
the alternative rule is tempting and wrong. Deciding by shape would capture that
link, make its `][readme]` unreachable from the keyboard, and give the user no
way to fix it.

The cost is a window: a document whose text has loaded but whose map has not
shows its mentions as plain text until the map arrives. The `setKnownRefKeys`
effect is what closes it — the field reparses on the effect as well as on a
document change.

## The four CM6 building blocks

The same four the wiki-link form uses, over `features/mention-refs.ts`:

| Part                                 | Job                                              |
| ------------------------------------ | ------------------------------------------------ |
| `mentionRefField` (`StateField`)     | parses the document against the known keys       |
| `mentionRefEditFilter`               | blocks or truncates edits reaching into `][key]` |
| `atomicMentionRefRanges`             | the cursor skips `[` and `][key]`                |
| `createMentionRefDecorationPlugin()` | hides both, so the user sees a pill              |

Only `][key]` needs protecting. The label is ordinary text and stays fully
editable, which is the point of the form.

| Cursor position     | What the user sees             |
| ------------------- | ------------------------------ |
| Outside the mention | the label, styled as a pill    |
| Inside the mention  | `[Label]`, with the key hidden |

## `modifiedTitle`

A mention's label starts as the destination's name and is kept in step with it:
`_setupRefDestinationSubscriptions` subscribes to each destination, and a rename
elsewhere rewrites the label here.

That subscription is on the destination rather than on its `title`, and it is
what makes the name readable at all. A destination arrives as a bare link with
nothing cached, so reading NAME off it returns undefined until a subscription
under a schema naming NAME has delivered a value. The wiki-link form watches
`title` for the opposite reason — it writes NAME's source and would otherwise
hear its own echo — which does not arise here, because this form never writes
the destination.

Editing the label ends that. `_detectRefLabelChanges` compares the edited label
against the destination's current name, and sets `modifiedTitle` when they
differ — the user has chosen a wording, and a later rename leaves it alone.
Editing the label back into agreement clears the flag, so it tracks divergence
rather than accumulating a history of edits.

The destination is never renamed from here. In the wiki-link form editing a pill
writes `destination.title`, which makes every local wording a rename; in the
reference form the label is local and the destination is untouched.

## Collection

An entry whose token has left the document is removed by
`_collectUnreferencedRefEntries`. Removing a key means writing the whole map
back, so only keys this editor saw when the document loaded, or minted itself,
are eligible: a key another client added since is one this editor cannot tell
apart from a key it deleted, and the conservative reading keeps it.

The collector will not run against an empty document. A document that has not
loaded names nothing, which is not the same as a document that names nothing.

## Ordering, when a mention is made

The map entry is written **before** the token reaches the document. If only one
of the two writes lands, an entry no token names is inert, while a token no
entry resolves is a dead link.

Creating a piece for a novel mention cannot follow that order — there is no
destination until the create resolves. The token goes in first with a key the
map does not hold, so it reads as ordinary text for as long as the create takes,
and is unwound to the bare label if the create fails.

## What the form gives up

`[[Name (id)]]` survives being copied anywhere. `[Label][a3f9zz]` means nothing
without the map, so text pasted into another document arrives as a label with no
destination, and a consumer reading raw content sees the same. Emitting the map
as a markdown reference-definition block is what makes an exported document
whole; a paste between two live documents is not recovered.
