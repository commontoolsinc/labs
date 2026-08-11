# References as arguments

**The ask: carry a declared reference into the emitted event schema, and honor
it at the two boundary sites that read one.**

A verb whose event declares a reference — `Writable<T>` on an event field —
cannot be called by anything outside the runtime. The declaration compiles, the
runtime honors it internally, and the emitted schema drops it, so nothing at the
serialized boundary can tell a reference position from a value position.

This is one change, and it is the completion of a mechanism that already
exists rather than a new capability.

## Why this matters, measured

[The pattern verb contract](pattern-verb-contract.md) states its goal as making
any pattern agent-drivable through its own verbs. That is currently false for a
specific and enumerable class of verbs.

Every event field across the shipped patterns that declares a reference:

```text
addPiece     Stream<{ piece: MentionablePiece }>
addPiece     Stream<{ piece: Writable<MentionablePiece> }>
addPiece     Stream<{ piece: Writable<RecordPiece> }>
appendLink   Stream<{ piece: Writable<MentionablePiece> }>
removeEvent  Stream<{ event: EventPiece }>
removeItem   Stream<{ item: DoItem }>
removeItem   Stream<{ item: ReadingItemPiece }>
removeItem   Stream<{ item: TodoItem }>
```

Eight of 238 verb declarations. The count is not the point — the **shape** is.
Every one is *put this existing thing here* or *take this existing thing out*,
which is precisely the class of operation that has to name something that
already exists. None of them can be invoked by an agent, a script, or the CLI.

The sharpest case is the root pattern's, since every space has one:

```bash
$ cf piece call --piece <root> addPiece '{"piece":"fid1:…"}'
Invalid input for "addPiece": piece: value does not match type object
```

`addPiece` on `packages/patterns/system/default-app.tsx` is how a piece is
registered in a space. It is reachable from inside the runtime — `pieces.add`
sends to exactly this stream — and unreachable through the verb surface.

## This is a correctness defect, not a missing feature

The boundary does not refuse an unusable payload. It accepts one and stores the
wrong thing.

Declaring `on: ItemOutput` on an event and calling it three ways:

| Payload | Result |
| --- | --- |
| `{"on": "fid1:…"}` | rejected — *value does not match type object* |
| the runtime link envelope | rejected — *missing required property title* |
| a literal `ItemOutput`-shaped object | **accepted** |

The accepted one settles, reports a plausible result, and stores a **detached
copy inside the caller's own document**. The edge does not point at the target.
Finishing the target would never unblock the blocked item, and nothing anywhere
reports an error. Reproduction and measured addresses:
[#5560](https://github.com/commontoolsinc/labs/issues/5560).

So the status quo is not "you cannot do this yet." It is "the obvious attempt
succeeds and writes a wrong graph."

## What already exists

Three of the four pieces are built. This is why the ask is small.

**The author-facing spelling.** `Writable<T>` on an event field is how a
reference position is declared, and shipped patterns use it — the list above is
that spelling in production.

**The runtime capability.** Those events carry live cells today. Piece
registration in every space runs through `addPiece`, so references in event
payloads are not novel; they are load-bearing.

**The wire encoding.** A rendered address — `{ id, space, scope, path }` — is
already what a `$link` read emits
([shaped reads](shaped-reads-and-verb-results.md)). Accepting the same shape
inbound makes an address round-trip, which is the property
[CLI surface shape](cli-surface-shape.md) already states for commands: an
address printed by one command is accepted by the next.

## What is missing

**The marker is dropped in emission.** An event field declared
`Writable<ItemOutput>` emits as `{"$ref": "#/$defs/ItemOutput"}` with no
`asCell` anywhere; an inline `Writable<{ title: string }>` disappears from the
emitted properties entirely. Measured both ways. Nothing downstream can
distinguish a reference position, because the emitted schema does not say there
is one.

Everything else follows from that one omission:

| Site | What it needs |
| --- | --- |
| handler-schema emission (`packages/ts-transformers/src/transformers/schema-injection.ts`) | carry the marker onto an event property declared `Writable<T>` |
| verb input validation | accept an address at a marked position instead of validating structurally |
| dispatch | resolve the address into a cell before the handler runs |

## Size

**Medium.** The emission change is the bulk of it and lands in the same file
that carries a verb's declared result, so whoever does one is in position to do
the other. The validation and resolution changes are each small and have
existing machinery to lean on — the runtime resolves links from addresses
throughout.

Nothing durable is written and no baseline records it, so the change is
reversible by assignment rather than migration.

## The one decision that gates the shape

**Is the argument path missing a reference vocabulary, or refusing one?**

Accepting an address as an argument lets a caller aim a pattern at a cell the
*caller* named, rather than one the pattern reached through its own inputs.
That is a confinement question, and it belongs to whoever owns CFC rather than
to the read model or the verb contract.

If references are excluded from the argument path deliberately, the answer is
not this change — it is this change plus a rights check, which is a materially
larger design with a different owner. **That question should be answered before
the work starts**, because the two roads differ in kind and not only in effort.

No evidence was found either way: the emission drops the marker without a
comment explaining whether that is deliberate.

## What does not wait for that answer

Refusing a structural copy where a reference is declared is correct under
either road. It needs no new vocabulary, no wire format, and no decision about
confinement — and it converts today's silent corruption into an error.
