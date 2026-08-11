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

**The fix:** move that resolution to the boundary every external caller
crosses, and give the outer gates the link acceptance the dispatch gate already
has. Medium work, mostly relocating code that already runs in production.

**One constraint, not a second decision:** what is accepted inbound has to
include the shape a read already emits. Otherwise a caller still cannot submit
the address it was just handed, and the capability does not compose. Which
spelling wins is the implementer's call.

**Not a confinement decision — the runtime already took a position.** The
dispatch-side closed-world gate accepts a link value opaquely and defers its
schema check to the handler's own reads (`closedWorldEventRejection`,
`packages/runner/src/runner.ts`, via its `acceptOpaqueValue: isCellLink`
option). The CLI's pre-dispatch gate calls the same validator without that
option (`verbInputSchemaError`, `packages/cli/lib/callable.ts`); the webhook
path has no gate at all. The refusal is drift between the outer layers and the
gate they feed, not policy. CFC gets a heads-up — an existing capability
widening to external principals — not a ruling to wait for.

**Independent of all of it:** refusing the structural copy, instead of storing
it, needs no encoding decision and no gate change.

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
home where every caller reaches it. Beside it, the CLI's pre-dispatch gate
needs the `acceptOpaqueValue` option the dispatch gate already passes, so the
two gates stop disagreeing about link values.

**A schema emission fix, and a marker for one road only.** An event field
declared `Writable<ItemOutput>` emits as `{"$ref": "#/$defs/ItemOutput"}` with
no `asCell`; an inline `Writable<{ title: string }>` disappears from the
emitted properties entirely. Measured both ways. The disappearance needs fixing
under any road: a field the schema does not name cannot be validated or
documented, and once event schemas close (verb contract WS-C) cannot be
supplied at all. The `asCell` marker is needed only if resolution becomes
schema-directed — schema-blind acceptance already composes with closed-world
validation, as `closedWorldEventRejection` demonstrates: a link value passes
opaquely in any declared position while an undeclared key still rejects.

*Whether resolution should stay schema-blind or become schema-directed is an
implementation question this document does not settle.* Schema-blind is proven
twice — `traverseAndCellify` and the dispatch gate; schema-directed is
checkable and refuses a typo. The answer decides whether the `asCell` emission
is required or merely useful.

## Size

**Medium**, and smaller than it looks because the hard part is written. The
emission change lands in
`packages/ts-transformers/src/transformers/schema-injection.ts`, the same file
that carries a verb's declared result. Resolution is a lift-and-share of
existing, exercised code, and the gate alignment is one option at one call
site — pass the `acceptOpaqueValue` the dispatch gate already passes. Nothing
durable is written, so it reverses by assignment rather than migration.

## The refusal is drift, not policy

At what layer are references disallowed? None of them chooses to. The layers
disagree, and the innermost one already ruled in favor.

**The dispatch-side gate accepts links.** `closedWorldEventRejection`
(`packages/runner/src/runner.ts`) validates a present event payload with
`acceptOpaqueValue: (value) => isCellLink(value)`: a link value passes
unjudged, because its target cannot be read at dispatch and its schema check
belongs to the handler's own reactive reads. The same gate works out how to
stop a caller smuggling undeclared *keys* through links without ever banning
link *values*. That is a considered position on exactly this question, taken in
the layer most careful about what a caller may submit.

**The CLI gate is the same validator minus the option.** `verbInputSchemaError`
(`packages/cli/lib/callable.ts`) calls the identical `validateSchemaValue` with
no `acceptOpaqueValue`. It has no link concept, so it descends into a link
envelope as if it were the declared object — the measured rejections above.
The comments around that gate give its purpose: refuse a malformed payload
before it spends the invocation id. Nothing there elects to refuse references.

**The webhook path takes no position.** `sendToStream`
(`packages/toolshed/routes/webhooks/webhooks.utils.ts`) forwards the raw
payload with no gate and no traversal.

**And "data cannot name a cell" is not a core invariant.** A sigil link is a
link wherever it appears in stored data (`isLinkRef`,
`packages/data-model/src/cell-rep.ts`). Whether a sigil riding a webhook
payload survives `send()` as a live edge is untested; if it does, that door is
already open under the native spelling, and this plan names a capability rather
than adds one.

What remains for whoever owns CFC is a notification, not a ruling: opening the
outer doors widens an existing exposure — an external principal, not just the
user's own model session, gets to name an address a handler will act on with
its own authority. They should hear that and can object. But the precedent this
change extends is the runtime's own gate, not a workaround.

## What is correct regardless

Refusing a structural copy where a reference is declared stands on its own: no
new vocabulary, no encoding decision, no gate change, and it converts today's
silent corruption into an error.
