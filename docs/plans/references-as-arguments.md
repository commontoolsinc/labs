# References as arguments

A caller can be handed an address and cannot hand one back. This document
states the gap, shows what it already costs, and asks the one question that
decides whether the obvious fix is the right one.

It is a question, not a proposal. Nothing here amends
[Reading Fabric data](fabric-read-model.md) or
[the pattern verb contract](pattern-verb-contract.md).

## The asymmetry

[Reading Fabric data](fabric-read-model.md) settles that everything addressable
is a cell, and [shaped reads](shaped-reads-and-verb-results.md) gives a reader
a way to say *give me the address at this position, not the contents*. That is
the `$link` marker, and the reasoning behind it is explicit: `asCell` bundles a
traversal boundary with a **handle contract**, and a handle cannot cross a
serialized channel — only its address can.

That reasoning is symmetric, and only one side of it was built.

| | Read | Argument |
| --- | --- | --- |
| Declare "an address sits here" | `$link` beside `properties` | — |
| Wire encoding | declared `{ id, space, scope, path }` | — |
| Why not `asCell` | reasoned out, recorded | never asked |

**The runtime is not the limitation.** A pattern hands a piece to another
pattern constantly — `Item({ title, parent: self })` passes a reference, and
the graph that results is the normal shape of composed patterns. What has no
spelling is the *serialized* boundary: how an event type declares a reference
position, and how a caller outside the runtime encodes one.

## What it costs today

**Measured.** A verb declared to take another piece compiles, and then behaves
in a way no caller would predict.

```tsx
// Shown for illustration only.
interface BlockOnEvent {
  on: ItemOutput; // the piece itself, not a minted identifier
}
```

The generated event schema renders `on` as `{"$ref": "#/$defs/ItemOutput"}` —
the *shape*, with no `asCell` — and that definition requires every field of the
output, recursively. Three payloads, against item A blocking on item B:

| Payload | Result |
| --- | --- |
| `{"on": "fid1:…"}` | rejected — *value does not match type object* |
| the runtime link envelope | rejected — *missing required property title* |
| a literal `ItemOutput`-shaped object | **accepted** |

The accepted one is the problem. The call settles, reports a plausible result,
and stores a **detached copy inside the caller's own document** — the edge does
not point at B at all. Finishing B would never unblock A, and nothing reports
an error. Reproduction and measured addresses are on
[#5560](https://github.com/commontoolsinc/labs/issues/5560).

**Already paid, in a shipped pattern.** Topics cannot accept a topic reference,
so it recovers references by scanning prose. `extractFidPayloads`
(`packages/patterns/topics/topic.tsx`) matches, in its own words, "bare
`fid1:X`, storage-form `of:fid1:X`, page URLs `https://host/space/fid1:X`, and
share links where the colon is percent-encoded." The board's entire
topic-to-topic reference graph is derived that way.

That is not a stylistic choice. It is the only route available, and it is the
clearest statement of the cost: a pattern that wants a reference has to
regex one out of text a human typed.

## Where else the same shape appears

Any relation between two existing pieces, which is most of what a graph is
for — a dependency edge, a move between parents, an assignment, a tag, a
removal that names its target. It is invisible in a pure tree, because the
natural shape there is to call the verb *on* the parent, so the receiver
carries the relation and no address needs to be an argument. It appears the
moment two pieces must be related to each other.

A second instance sits one level out, on a command rather than an event:
`cf piece set-slug <slug> <source>` resolves its source positional through its
own path rather than the one `--piece` uses, so work making `--piece` accept an
entity URI does not reach it.

## The question that decides the shape of the answer

**Is the argument path missing a reference vocabulary, or refusing one?**

The obvious fix is the mirror of `$link`: a way for an event schema to declare
a reference position, an accepted wire encoding for an address, and resolution
before the handler sees the value. If nothing objects to that, it is a
well-understood piece of work whose shape the read side already established.

But accepting an address as an argument lets a caller direct a pattern at a
cell the *caller* named. That is a capability question, not a serialization
one, and it sits in CFC's territory rather than the read model's. If the event
path excludes references deliberately — so that a pattern only ever touches
cells reached through its own inputs and its own writes — then the answer is
not "add the marker" but "add it with a rights check," which is a materially
larger design and belongs to whoever owns confinement.

**Nobody should build the obvious fix until that is answered**, because the two
roads differ in more than effort: one is a schema keyword, the other is an
authorization boundary.

## What does not wait for the answer

Silently accepting a structural copy where a reference is meant is wrong under
either road. A caller doing the obvious thing gets a success, a plausible
result value, and a wrong graph.

Refusing that payload needs no new vocabulary and no decision about
confinement. It converts a corruption into an error, which is strictly better
whichever way the question above is settled.

## What this document is not

It is not a proposal to make verb arguments accept addresses. It is the
observation that the read side answered a question the write side was never
asked, that the gap is being paid for in production today, and that the
capability question has to be answered before the obvious fix is the right one.
