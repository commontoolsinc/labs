---
status: historical
created: 2026-08-12
archived: 2026-08-12
reason: "Executed plan; the cellFromUrl builtin, pasted mentions, the reference-definition block, and the read-only projection with its edit verb all shipped. The topics retirement was deliberately left undone."
---

# URLs as mentions

## The short version

A mention made through the editor's completion becomes a reference: the text
carries a short local key and
[the note's reference map](editor-mention-references.md) says
where it points. Text that names a cell any *other* way stays inert. Paste a
piece's URL into a note and it is a URL — not a mention, not a backlink, and
not something `$mentioned` or the backlinks index can see.

**One builtin closes that, and two things follow from it.**

`cellFromUrl` answers "does this URL name a cell, and which one". It is a
**builtin** rather than a helper function because the answer cannot stay
synchronous: recognizing which hosts are fabric hosts will mean probing them,
and resolving a space name to a DID is a lookup today and a network call later.
A builtin is how a pattern waits for an answer without a pattern having to
block, and the shape is the one every other builtin already uses.

```text
cellFromUrl({ url })  →  { pending, cell?: ReadonlyCell<{ [NAME]: string }> }
```

A URL that names no cell resolves with no `cell` — the honest answer to "not a
fabric URL", and not an error.

**One: pasted URLs become mentions.** A paste that names a cell is rewritten to
`[Name][key]` with the destination in the map, which is what the user meant by
pasting it. The label comes from the destination's own name, so `modifiedTitle`
starts false and the mention behaves like any other from then on.

**Two: the filesystem projection becomes read-only, and gets a verb.** Notes
are edited through FUSE today by writing the whole file back; that is what
stops a projected note from carrying its reference definitions. Replacing it
with an explicit edit verb makes the round trip ordinary pattern code.

`extractFidPayloads` (`packages/patterns/topics/topic.tsx`) is a hand-rolled
regex over pasted text that returns bare payload strings for callers to
re-address. It is not a model for this — but retiring it is also not a
one-for-one swap, and the difference matters. **Scanning prose for something
that looks like a cell and deciding what a URL names are two operations**, and
the scanner cannot do the second: it discards host, space, scheme, and path,
so a payload it lifts out of an external URL, or out of a link into another
space, resolves in the caller's space and names the wrong cell. A corpus
scanner stays a corpus scanner; what it hands to `cellFromUrl` has to be a
whole address, and `cellFromUrl` has to preserve every part of it.

## `cellFromUrl`

Three questions, on three different timelines. The builtin exists so the
surface does not have to change as each one gets slower.

**Which hosts are fabric hosts.** Its own, to begin with, plus any the runtime
is configured with. Later this has to probe an unknown host, which is the step
that makes the whole thing properly async.

**Which space.** A link can be cross-space, so a space *name* has to become a
DID. `resolveSpaceNameSync` (`packages/runner/src/runtime.ts`) answers from
cache; `resolveSpaceName` derives it through `createSession`, which the runtime
already flags as name-based and provisional. Fast enough to await today, a
network lookup later.

**Which cell.** The last path segment may be a slug rather than an id, and
turning one into the other is mechanical: `slugIdForSpace`
(`packages/runner/src/slugs.ts`) hashes `{ space, slug }`. No connection to the
space is needed, so this stays synchronous however the rest evolves.

- [x] Register `cellFromUrl` in `packages/runner/src/builtins/`, and declare it
      in `packages/api/index.ts` with the `Reactive<{ pending, … }>` shape the
      other builtins use.
- [x] Resolve synchronously to start with — a configured host list, a cached
      space name, a slug hash. The point of landing it as a builtin now is that
      making any of those a real lookup later changes no caller.
- [ ] Retire `extractFidPayloads` and `fidPayload` in topics onto it. Deferred
      deliberately: topics works, and rewriting it buys consistency rather than
      capability. This is the one stage keeping the plan live.

## The filesystem round trip

`writeFsFile` (`packages/fuse/cell-bridge.ts`) parses an edited file and writes
the **entire** body to `$FS.content`, which for a note is a write-redirecting
link to its own content cell. Anything generated into the projection therefore
comes back as note text on the first edit, and is generated again on the next
read.

**The projection becomes read-only, and the note exposes a verb that takes an
edited body.** No write hook, no special case in the bridge: an edit is a call,
like every other change to a piece.

The verb is a handler, as verbs are. What it does in its body is instantiate a
pattern — handlers and lifts can, and `note.tsx`'s own `createNewNote` already
builds a `Note` that way — because `cellFromUrl` is a builtin, and a builtin
resolves in the graph rather than inline. So the handler stands up this:

```text
edited markdown
  → computed: candidate URLs and reference definitions in the body
  → map: cellFromUrl over each candidate
  → computed: the new content and the new reference map
  → written to the content and references cells
```

Which makes the two halves of this plan one mechanism seen from two sides. A
URL that names a cell becomes a reference whether it arrives by paste or by
`vim`.

### What an edited definition means

The definition block is generated on the way out and **read as input on the way
back**. A person editing it through the filesystem is editing the note's
mentions, and that is a legitimate way to do it:

| The file comes back with | Meaning |
| --- | --- |
| a definition unchanged | no change; writing the file back untouched is not an edit |
| a well-formed definition added | a new reference, its URL resolved like any other |
| a definition's URL changed | that mention repoints; the key keeps its identity |
| a malformed definition | dropped |

Only the malformed case discards anything, and it discards the line rather than
the mention. Every other edit is taken at face value, which keeps the block
honest: it says what the mentions are, and saying something else changes them.

Repointing has one consequence worth stating. A label the user never claimed
(`modifiedTitle` false) is rewritten to the new destination's name by the
subscription the editor already keeps; a label they did claim stays as they
wrote it. That is the existing rule, reached from the filesystem instead of
from a rename.

- [x] Mark the note's `[FS]` projection read-only.
- [x] Read the definition block back: added and changed definitions are the
      user's edits, malformed lines are dropped.
- [x] An `editProjection`-shaped verb on the note: a handler that instantiates
      the pattern above and writes what it produces.
- [x] Emit the reference definitions beneath the content, now that they survive
      a round trip.
- [x] Paste handling in `cf-code-editor`, once the builtin exists.

## Risks

**A round trip that is not exact is worse than no round trip.** A file written
back unchanged must leave the content and the map unchanged, or every `touch`
becomes an edit. That is the demanding half of reading definitions back as
input: the parser has to produce exactly what the generator emitted for
unchanged text, so "no difference" is a case the round trip recognizes rather
than a diff it happens to compute as empty.

**A read-only projection is a behavior change for anyone editing notes through
FUSE.** The verb has to land first, and the change is worth announcing rather
than discovering.

**A pasted URL that becomes a mention is a paste that changed under the user.**
It should be undoable in one keystroke, and it should not fire while the URL is
still being typed out by hand.
