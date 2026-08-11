# References as arguments

## The short version

**A pattern handler that declares a reference should accept one — a live
read/write cell — from any external caller. Today only a model can pass one:**
the LLM dialog builtin resolves `{"@link": "…"}` into a live cell before
dispatch (`traverseAndCellify`). The CLI, a webhook, and the ingest path reach
the same handler, and none of them resolves a reference — the CLI rejects the
address, the webhook sends it through unresolved. **The shape-matching payload
the CLI does accept stores a detached copy instead of an edge, and reports
success.**

**The ask:** move that resolution to the boundary every external caller crosses.

**One constraint, not a second decision:** what is accepted inbound has to
include the shape a read already emits. Otherwise a caller still cannot submit
the address it was just handed, and the capability does not compose. Which
spelling wins is the implementer's call.

**Decide first:** whether accepting a caller-named address is a confinement
question — noting that the model, the least trusted caller in the system,
already has this capability. If it is, this is the wrong-sized change and CFC
owns it. If it is not, the work is medium and mostly relocating code that
already runs in production.

**True either way:** refusing the structural copy, instead of storing it, needs
no encoding decision and no confinement ruling.

The rest of this document is the evidence for the paragraphs above.

## The team already needed this and already built it

`traverseAndCellify` (`packages/runner/src/builtins/llm-dialog.ts`) walks an LLM
tool call's input, finds `{"@link": "…"}`, and resolves it through
`runtime.getCellFromLink()` before dispatch. Its output becomes
`invocationArgs`, which goes into the `handler` branch's stream send. Its
counterpart `traverseAndSerialize` renders cells *out* in the same shape, so
the LLM boundary has a complete round trip: a model is handed an address and
can hand it back.

That is proof of need from inside the codebase. Somebody hit this wall on a
surface that matters and built the resolution rather than working around it.

**The problem is where it lives.** It sits inside one builtin, so it serves one
consumer. Every other caller that crosses the same serialized boundary is
second-class:

| Consumer | Can pass a reference? |
| --- | --- |
| LLM tool call (`llm-dialog`) | **yes** — `@link`, resolved before dispatch |
| `cf piece call` | no — validated structurally, an address is rejected |
| Webhook POST (`sendToStream`, `packages/toolshed/routes/webhooks/`) | no — the raw payload is sent unresolved |
| [Ingest channels](ingest-channels-journal-sink.md) | no — builds on the same dispatch |
| `cf exec` and the FUSE projection | no — JSON in, same path as the CLI |

The same handler, reached two ways, accepts a reference from one and not the
other. Nothing about the verb differs; only the door the caller came through.

### Why the round trip is a constraint rather than a preference

Two spellings of an address are already in use, and they do not meet:

| Spelling | Where | Direction |
| --- | --- | --- |
| `{"@link": "…"}` | `llm-dialog` | in **and** out |
| `{"$link": {id, space, scope, path}}` | shaped reads ([shaped reads](shaped-reads-and-verb-results.md)) | out only |

So a caller that reads a result and submits the address it was handed has no
route that works — the form it received is not a form anything accepts. Picking
a spelling is the implementer's call; accepting the one a read emits is what
makes the capability compose, and it is the property
[CLI surface shape](cli-surface-shape.md) already states for commands.

## What this costs today, measured

Not "you cannot do this yet." The boundary **accepts a wrong payload and stores
the wrong thing.**

Declaring a reference on an event and calling it three ways:

| Payload | Result |
| --- | --- |
| `{"on": "fid1:…"}` | rejected — *value does not match type object* |
| the runtime link envelope | rejected — *missing required property title* |
| a literal shape-matching object | **accepted** |

The accepted one settles, reports a plausible result, and stores a **detached
copy inside the caller's own document**. The edge does not point at the target.
Nothing reports an error. Measured addresses and reproduction:
[#5560](https://github.com/commontoolsinc/labs/issues/5560).

The verbs this reaches are not hypothetical. Every event field across the
shipped patterns that declares a reference:

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

Every one is *put this existing thing here* or *take this existing thing out* —
the class of operation that must name something that already exists. The
sharpest is the root pattern's, since every space has one:

```bash
$ cf piece call --piece <root> addPiece '{"piece":"fid1:…"}'
Invalid input for "addPiece": piece: value does not match type object
```

`pieces.add` sends to that exact stream from inside the runtime. An LLM could
invoke it. A webhook could not, and neither can the CLI.

## What is missing

**Resolution at the shared boundary rather than in one consumer.**
`traverseAndCellify` is the working reference implementation; what it needs is a
home where every caller reaches it.

**A marker in the emitted event schema.** An event field declared
`Writable<ItemOutput>` emits as `{"$ref": "#/$defs/ItemOutput"}` with no
`asCell`; an inline `Writable<{ title: string }>` disappears from the emitted
properties entirely. Measured both ways. `llm-dialog` sidesteps this by
resolving schema-blind — it cellifies any `@link` it finds — but a boundary with
closed-world input validation cannot, because the gate has to know the position
takes an address before it can accept one there.

*Whether resolution should stay schema-blind or become schema-directed is an
implementation question this document does not settle.* Schema-blind is proven
and simpler; schema-directed is checkable and refuses a typo. The answer decides
whether the emission change is required or merely useful.

## Size

**Medium**, and smaller than it looks because the hard part is written. The
emission change lands in
`packages/ts-transformers/src/transformers/schema-injection.ts`, the same file
that carries a verb's declared result. Resolution is a lift-and-share of
existing, exercised code. Nothing durable is written, so it reverses by
assignment rather than migration.

## The decision that gates the shape

**Is the argument path missing a reference vocabulary, or refusing one?**

Accepting an address lets a caller aim a pattern at a cell the *caller* named
rather than one the pattern reached through its own inputs. That is a
confinement question and belongs to whoever owns CFC.

It is sharpened rather than answered by the LLM precedent: a model — the least
trusted caller in the system — can already do this. Either that is a considered
position and the same reasoning extends to other callers, or it is an
inconsistency worth knowing about. Both readings argue for deciding it
deliberately rather than leaving one door open and the rest shut by omission.

**This wants answering before the work starts.** If references are excluded
deliberately, the answer is not this change but this change plus a rights
check — a materially larger design with a different owner.

## What does not wait for that answer

Refusing a structural copy where a reference is declared is correct under either
road. It needs no new vocabulary, no encoding decision, and no confinement
ruling, and it converts today's silent corruption into an error.
