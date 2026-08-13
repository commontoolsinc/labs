# Editor mention references

## The short version

A mention in `cf-code-editor` is a self-describing token spliced into the
user's prose: `[[Name (id)]]`. The destination's identity lives inside the
sentence, as a string, and everything else follows from that — a transaction
filter that protects a substring of the document from the person typing in it,
an atomic range so the cursor cannot reach that substring, and a decoration
layer that hides it again on the way out.

**The change: give the editor a reference map, and the destination leaves the
text.** A mention becomes a markdown reference link whose key is six random
characters, and the key resolves through a cell the host pattern owns:

```text
Doc text:    I read [Attention Framework][a3f9] last night.

References:  { a3f9: { destination: Cell<unknown>, modifiedTitle: false } }
```

**Three things that buys:**

- **The destination is a live cell.** `mentionIdFromCellId`
  (`packages/ui/src/v2/utils/mention-id.ts`) strips `of:` and throws on
  `computed:`, because a bare hash in prose cannot carry a URI scheme and the
  scheme is part of the identity. A cell-valued destination carries whatever it
  is, and the tripwire has nothing left to guard.
- **An edited label becomes the user's.** `modifiedTitle` records that the
  label and the destination's title have deliberately diverged, so a later
  title change on the destination stops overwriting a wording the user chose.
- **The label is ordinary text.** Only the `][a3f9]` suffix needs protecting,
  and it sits at the edge of the token rather than inside it.

**What it costs: self-containment.** `[[Name (id)]]` survives being copied
anywhere. `[Label][a3f9zz]` means nothing without the map, so text pasted into
another document reads as ordinary text there, and every consumer of raw note
content — the filesystem projection, an export, a prompt — sees a label with no
destination. Neither case is recovered by this arc; the reasoning is under
Stage 3, and it is the honest cost of moving identity out of the prose.

**The whole feature is opt-in.** With no `$references` cell the editor parses an
empty key set, produces no reference decorations, and mints wiki-links exactly
as it does now.

## What the editor does today

`features/backlinks.ts` is the machine, and it is worth naming its parts
because the reference form reuses all four:

| Part                                 | Job                                              |
| ------------------------------------ | ------------------------------------------------ |
| `backlinkField` (`StateField`)        | regex-parses the doc into `BacklinkInfo[]`       |
| `backlinkEditFilter`                  | blocks or truncates edits that reach into `(id)]]` |
| `atomicBacklinkRanges`                | the cursor skips `[[` and `(id)]]`               |
| `createBacklinkDecorationPlugin()`    | hides both, so the user sees a pill              |

`cf-code-editor.ts` adds the parts that touch cells: `$mentionable` feeds the
completion source, `$mentioned` is written back as the list of destinations
found in the text, and titles sync in **both** directions — editing a pill
writes `destination.title`, and an external `title` change rewrites the pill.

Downstream, `note-md.tsx` rewrites `[[Name (id)]]` to `[Name](/of:id)` before
handing content to `cf-markdown`.

## The contract

A reference key is six characters of `[0-9a-z]`, and the parser accepts six to
ten so that a collision has somewhere to go — see the mint under Stage 1. A
token is a mention when the map holds its key, and ordinary text otherwise:

| Token shape matches | Key in map | What the user sees                      |
| ------------------- | ---------- | --------------------------------------- |
| yes                 | yes        | a pill; cursor inside reveals `[Label]` |
| yes                 | no         | ordinary text — editable, unprotected   |
| no                  | —          | ordinary text                           |

**Membership rather than shape is what decides**, and the alternative is worth
naming because it is the tempting one. Six lowercase characters is a shape
ordinary prose reaches: deciding by shape would capture a hand-written
`[the docs][readme]`, put its `][readme]` beyond the keyboard, and leave the
user no way to fix it.

The cost is a window. A document whose text has loaded but whose map has not
shows its mentions as plain text until the map arrives — an effect announcing
the map's keys is what closes it, and the parse reruns on that as well as on a
document change. A token pasted from another document stays plain text, which
is what it is here.

**Writes are ordered map-first, and removal is ordered the other way.** The
document and the map are separate cells with separate timings — content is
debounced, the map is not. Writing the map entry before dispatching the text
means an interrupted mention leaves an unreferenced map entry, which is inert,
rather than a reference with no destination, which is a broken link.

Deleting an entry inverts that, for the same reason. A user who deletes a
mention leaves the document write pending under the debounce or blur strategy;
dropping the entry immediately, and then losing that pending write to a
disconnect, leaves the durable document holding a token whose destination is
gone. Collection therefore flushes the document write first and only then
removes the entry.

**Title sync gains a direction and loses one:**

| Event                            | Wiki-link mode              | Reference mode                             |
| -------------------------------- | --------------------------- | ------------------------------------------ |
| User edits the label             | writes `destination.title`  | sets `modifiedTitle`; destination untouched |
| Destination's title changes      | rewrites the label          | rewrites the label only when `modifiedTitle` is false |

Editing a label back into agreement with the destination's name clears
`modifiedTitle`, so the flag tracks divergence rather than accumulating.

Both forms are read at once. A document holding wiki-links keeps them, they
keep resolving, and nothing rewrites them; only newly minted mentions take the
reference form.

## Stage 1 — the editor

- [x] `packages/ui/src/v2/core/mention-refs.ts`: `MentionRef`,
      `MentionRefMap`, their schemas, and `mintRefKey`.

  ```typescript
  // Shown at module scope.
  export const MentionRefSchema = {
    type: "object",
    properties: {
      destination: { type: "object", properties: {}, asCell: ["cell"] },
      modifiedTitle: { type: "boolean", default: false },
    },
    required: ["destination"],
  } as const satisfies JSONSchema;

  export const MentionRefMapSchema = {
    type: "object",
    additionalProperties: MentionRefSchema,
  } as const satisfies JSONSchema;
  ```

  `mintRefKey` samples against the union of the map's keys and the keys already
  in the document, and widens by a character on collision rather than resampling
  one length in a loop. Widening is why the accepted shape is a range rather
  than a fixed six: a key the mint can produce and the parser would not accept
  is a mention that reads as ordinary text.

- [x] `features/mention-refs.ts`: the structural twin of `backlinks.ts` —
      `parseMentionRefs`, a `mentionRefField` that recomputes on `docChanged`
      **or** a `setKnownRefKeys` effect, `atomicMentionRefRanges` and
      `mentionRefEditFilter` over the `][key]` suffix, and a decoration plugin
      that renders a pill and reveals `[Label]` under the cursor. The label
      pattern excludes newlines, so a mention is a single-line range by
      construction rather than by a guard.
- [x] `cf-code-editor.ts`: the `references` property (`$references`), wrapped
      with `asSchema(MentionRefMapSchema)` and subscribed on change like
      `mentionable`; completion and novel-mention creation minting reference
      form when the map is present; `$mentioned` drawn from the union of both
      forms; label edits setting `modifiedTitle` instead of renaming;
      destination-title subscriptions honoring the flag.
- [x] Garbage collection: a map entry whose key has left the document is
      removed — conservatively (see risks) and never against a document that
      has not loaded.
- [x] `packages/html/src/jsx.d.ts`: `$references` and the label-change event on
      `CFCodeEditorAttributes`.
- [x] Unit tests mirroring `features/backlinks.test.ts`, plus key minting, plus
      an integration case pinning that **no map means wiki-link output,
      unchanged**.
- [x] `components/cf-code-editor/docs/mention-refs.md`, and a pointer from
      `docs/backlinks.md` naming the two coexisting forms.

## Stage 2 — the renderer

- [x] `note-md.tsx` takes the map as an input and extends `processedContent` to
      rewrite `[Label][key]` alongside the wiki-link form. A key with no entry
      keeps its literal text, so a broken reference degrades where a reader can
      see it.
- [x] Derive the link scheme from the resolved destination rather than
      prefixing `/of:`. That prefix is sound today only because the embed
      format rejects every other scheme; a cell-valued destination removes the
      guarantee along with the limitation.

## Stage 3 — the note pattern

- [ ] `note.tsx` owns a `references` cell, passes it to the editor, and threads
      it into `note-md`.
**`[FS]` is left alone, and that is a decision rather than an omission.** The
appealing idea is to emit the map as the markdown reference-definition block it
already resembles, so a projected note is self-contained standard markdown.
That cannot be done through `[FS].content` as it stands: `writeFsFile`
(`packages/fuse/cell-bridge.ts`) parses an edited file and writes the **entire**
body back to `$FS.content`, which for a note is its own content cell. Emitted
definitions would come straight back in as note text on the first edit through
the filesystem, and be appended again on the next projection.

Making it work needs one of two things this arc should not reach for: a
projection surface that is read-only, or an `[FS]` write-back contract that
knows how to strip a generated section before storing the rest. Until then a
projected note shows its reference tokens with no destinations — the same
shape a reader gets from a raw wiki-link, minus the id.

Other `$mentionable` consumers — `chat-note.tsx`, `daily-journal.tsx`,
`topic.tsx`, `agent.tsx`, `record-backup.tsx`, `compiler.tsx`, and the catalog
stories — pass no map and exercise the unchanged path. That is the bound on
this change's blast radius, and it is worth keeping true until the form has
lived in one pattern for a while.

## Risks

**Self-containment.** Named above and unrecovered for cross-document paste. A
reference pasted into another note reads as ordinary text — the label survives,
the destination does not, and re-picking the mention is the repair. The
alternative — resolving the key against a global registry — would restore the
property and give up the locality that makes short keys workable.

**Two cells, two clocks.** Map-first ordering handles the interrupted case.
The remaining exposure is a map write that fails while the text write succeeds,
which leaves the same label without a destination.

**Garbage collection against a concurrent editor.** Two clients editing one
note will each see keys the other just added and not yet received. A sweep that
deletes every key absent from the local text deletes the other client's work.
Collect conservatively: only keys observed in the document at load and since
removed locally.

**Reading a destination.** `destination` is a cell of `unknown`, and an object
read under `{ type: "unknown" }` returns `undefined` while rendering the same
path still works
([`../development/debugging/gotchas/unknown-typed-field-reads-undefined.md`](../development/debugging/gotchas/unknown-typed-field-reads-undefined.md)).
Reads of a destination's name go through `asSchema` first. This one type-checks
and fails silently, which is the combination worth a test rather than a
comment.

## Open question

The completion trigger stays `[[`, because the keymap, the Enter handling, and
the query extraction all hang off it, and the token is replaced wholesale when
a mention is accepted. It is now a trigger with no relationship to the output
form. Moving it to `@` is a coherent follow-up and not part of this work.
