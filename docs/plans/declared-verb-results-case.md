# What a declared verb result buys

The case for the one decision
[the verbs plan](verbs-implementation.md) says everything else waits behind:
**does a verb's declared result reach the runtime now, or only when the
Fabric-types stream supplies a durable one?**

The question is timing, not principle. A verb's declared result is expected to
reach the runtime eventually — supplying its durable form is part of what the
Fabric-types stream design exists to settle. What is open is whether to wire
it in the interim, on an existing field of a node's module, or leave the
surfaces that would read it waiting until the durable contract arrives.

This document argues for wiring it now: the interim road buys more today than
it will cost to replace, and it costs little to replace precisely because of
the property that makes it safe.

It is an argument, not a plan — the sequencing lives in the verbs plan, and the
model lives in [the pattern verb contract](pattern-verb-contract.md) and
[shaped reads and verb results](shaped-reads-and-verb-results.md).

The argument is told as a walkthrough of a session that does not run yet: a
work-item tracker driven entirely through `cf`, shown twice. Once as it reads
today, once as it reads with declared results. Nothing separates the two
except one field.

[A verb session, end to end](../common/verb-session-walkthrough.md) walks that
session in full, marking each step for whether it works today, is built and
merging, or is blocked. This document takes the one step the decision turns on.

## The claim

**`cf` is already a schema-driven command surface. It is finished on the input
side and unfinished on the output side, and the seam is one early return.**

A caller who reaches a piece today already gets flags derived from the verb's
input schema, per-flag type coercion and validation, a rendered help page, and
tab-completion over verb names against the live piece. None of it is authored
per pattern: it falls out of schema-on-read applied to the callable surface.

That machinery stops at the boundary between what a verb *takes* and what it
*gives back*, and it stops for one reason: a handler has no declared result to
read.

## What already works

None of this is proposed. All of it ships today.

| Surface | Where |
| --- | --- |
| Per-property flags from the input schema, with coercion, integer checks and enum validation | `parseInputFlags` / `FlagDescriptor`, `packages/cli/lib/exec-schema.ts` |
| A rendered help page: Usage, JSON input, Flags, Output | `renderPieceCallHelp` and `renderExecHelp`, same file |
| A machine-readable per-verb command spec | `renderExecHelpJson`, same file |
| One row per callable, with its input schema | `listPieceCallables`, `packages/cli/lib/piece.ts` |
| Verb-name completion against a live piece, bash and zsh | `shapeVerbCandidates` / `liveCandidates`, `packages/cli/lib/completion/providers.ts` |
| Slug addressing on every one of those paths | `resolvePieceConfigWithPieces`, `packages/cli/lib/piece.ts` |

So a command line that feels purpose-built for a pattern is not something to
build. It is something to *finish*.

## The asymmetry, as a caller meets it

`cf` has two callable contracts, and they diverge in `callableCommandSpec`
(`packages/cli/lib/callable.ts`):

```text
handler → { callableKind, defaultVerb, inputSchema }
tool    → { callableKind, defaultVerb, inputSchema, outputSchemaSummary }
```

A tool is a bound sub-pattern, and patterns already emit `resultSchema`, so a
tool's declared output flows straight through. A handler returns early, before
the field is ever considered.

Downstream, the consumers of that field are already written.
`renderPieceCallHelp` renders an `Output:` section from `outputSchemaSummary`
when it has one — and prints the literal string `"No output on success."` when
the callable is a handler.
`listPieceCallables` carries an `outputSchema` per row, whose type comment says
why it is empty: *"Tools only, until handlers gain declared results."*

The result is that two verbs on one piece document themselves very differently.
Sketched — the section headers are the real ones, the contents illustrative:

```text
$ cf piece call --piece board rollup --help        # a tool

Usage: ...
JSON input: ...
Flags after `--`:
  --depth <integer>
Output:
  open       integer
  blocked    integer
  byOwner    object
```

```text
$ cf piece call --piece board add --help           # a handler

Usage: ...
JSON input: ...
Flags after `--`:
  --title <string>
  --parent <string>
Output:
  No output on success.
```

`add` is the verb a caller actually needs to understand, and it is the one that
says nothing. The split has nothing to do with which verb is useful.

## The session, told twice

A work-item tracker: items in a tree, plus typed cross-links (`blocks`,
`duplicates`). One item is reachable by two paths — a child of one item and the
target of another's `blocks` edge. That shape is chosen because it is where
addresses stop being a convenience and start being the only correct answer.

A sketch of the verbs:

```tsx
// Shown for illustration only.
interface AddEvent {
  title: string;
  parent?: string;
}

interface AddResult {
  /** The item this call created — the piece itself, not a minted identifier. */
  item: ItemOutput;
  /** Depth in the tree, which the caller could not have computed. */
  depth: number;
}

interface BoardOutput {
  items: ItemOutput[];
  add: Stream<AddEvent, AddResult>;
}
```

### Today

A result already comes back. This is not a gap in the data — it is a gap in
what is *declared* about it.

```bash
cf piece call --piece board add -- --title "Fix login"
```

```json
{
  "invocation": "0f4c…",
  "status": "settled",
  "result": {
    "item": { "$NAME": "Fix login", "title": "Fix login",
              "children": [], "blocks": [], "…": "…" },
    "depth": 2
  }
}
```

The write lands and the verb's return arrives. What the caller gets at `item`
is the created piece's **value** — expanded, and expanded as far as the graph
goes, which is the unbounded read this work exists to bound.

**Identity is available too, by two routes.** `--show-links` returns a parallel
dictionary of RFC 6901 pointers naming the document behind each path:

```json
{
  "status": "settled",
  "result": { "item": { "$NAME": "Fix login", "…": "…" }, "depth": 2 },
  "links": {
    "/": { "space": "did:key:…", "id": "of:receipt…", "scope": "space" },
    "/item": { "space": "did:key:…", "id": "of:fid1:…", "scope": "space" }
  }
}
```

And once the read-layer stack merges, `--select 'item@,item.title'` renders the
address in place, bounded — with no declared result involved, because a `$link`
marker on a link position short-circuits before any source schema is consulted.

**So a declared result is not what makes identity or bounding possible.** Both
work without one.

It is also not that the caller is ignorant of the shape. A caller who does
anything useful with `item` and `depth` already knows what they are — from the
pattern's README, or from having written the pattern. Writing
`--select 'item@,item.title'` by hand is a mild cost, and it is honest to price
it as one.

**The party that does not know the shape is `cf`.** Every generic surface
between the caller and the pattern is blocked on that, and none of them can be
fixed by the caller knowing more:

- **No derivable default.** `cf` cannot choose scalars-inline,
  address-at-references, because it cannot tell which positions are which. The
  selection has to be supplied on every call, by someone who already knows it.
- **No check before a mutating call.** `--select 'itme@'` is accepted, the verb
  runs, the write commits, and the selection returns nothing. The outcome is
  recoverable — an `--invocation` replay re-reads the original receipt — but
  recovery is not free: a same-id retry re-runs the handler body and collides
  on the create-only receipt, because the guarantee is at-most-once *commit*,
  not at-most-once *execution* (the `invocationId` contract,
  `packages/cli/lib/callable.ts`). A verb whose body reaches outside its
  transaction — an LLM call, a fetch — repeats that work to recover from a
  typo. The refusal belongs before the effect, not after it.
- **No completion.** Nothing knows `item` and `depth` are the field names.
- **No skew detection on shape.** `cf piece verbs` reports the deployed
  pattern's source identity so a client can tell it is talking to a newer
  pattern than it was written against. It cannot compare the *shape* a client
  expects against the shape the pattern returns, because only one of them exists
  in the system.
- **No narrowing on the case that needs it most.** A receipt describes what it
  holds, but only where the result is plain: the derivation sits inside
  `handleJavaScriptHandlerResult`'s `!resultHasReactives` branch
  (`packages/runner/src/runner.ts`). A create returning the piece it made takes
  the other branch and gets no schema, so a shape is matched against a runtime
  value rather than a declaration — field names that happen to coincide.

The last two are the ones that are not ergonomics. A client and a pattern each
holding a shape, with nothing able to compare them, is how a caller selects a
field that was renamed two versions ago and reads `null` instead of an error.

### With a declared result

```bash
cf piece call --piece board add -- --title "Fix login"
```

```json
{
  "status": "settled",
  "result": {
    "item": { "$link": { "id": "of:fid1:…", "space": "did:key:…",
                         "scope": "space", "path": [] },
              "title": "Fix login" },
    "depth": 2
  }
}
```

Same command, same data, same rendering the `@` suffix would have produced by
hand. What changed is that **`cf` derived it** — every scalar, plus an address
at every reference position — because the shape was in the system rather than
only in the caller's head. Nobody designed that output. It fell out of the type
the pattern author already wrote.

For a caller who knows the pattern, that is a convenience. What it buys beyond
convenience is that the shape is now held in two places that can be compared: a
selection can be refused before the call, and a client written against an older
result can be told so rather than silently reading `null`.

From there the rest composes: `--select` completes on real field names, a typo
is refused before the call rather than after, and `cf piece verbs` can answer
"what does this piece do and what does each verb hand back" in one read.

That last one is the deferred half of verb discovery, and it is the property an
agent needs most — it is how a caller learns a surface it was not written
against.

## What replacing it later costs

This is the crux, because the interim road is explicitly meant to be replaced.

**No permanence obligation attaches, so there is nothing to migrate.** The
field does land in durable places — the compiled graph, re-emitted whole with
every version, and the receipt's write-once schema metadata, which describes
one invocation. What it never enters is anything with append-only or
compared-across-versions semantics. A baseline record is exactly a pattern's
argument schema, result schema, and name — no slot for a node's module — and
the compatibility gate never compares the field:
`assertPatternSchemasBackwardCompatible`
(`packages/piece/src/schema-compatibility.ts`) reads only that same top-level
pair and never walks the graph's nodes. Removing or re-sourcing the field
later is an ordinary graph edit, refused by nothing.

That is the same property that makes the interim road safe, and it is worth
naming as *one* property rather than two arguments. The earlier emission was
withdrawn for three recorded reasons. One is conceded outright: the value path
did not need a declared result, and nothing above claims it does. The other
two — a new keyword in durable schemas and append-only baselines hard-commits
a shape the Fabric-types stream is expected to replace, and the compatibility
rules built alongside it would have refused its later removal — are exactly
what the paragraph above shows a module field does not trip. So the thing that
answers the withdrawal is also the thing that makes the swap cheap: there is
no permanence to unwind.

[Shaped reads](shaped-reads-and-verb-results.md) already records the shape of
that swap for the receipt half — when declared result schemas arrive, "the same
slot takes a better-sourced value — a change to one argument, not a migration."
The command-surface half is the same story: `callableCommandSpec` reads the
field, and every consumer below it is indifferent to where the field came from.

So the replacement cost is a producer-side change in one place, plus
regenerating the golden fixtures that carry compiled handler schemas — a
coordination point the verbs plan already tracks for the pair of changes that
touch them.

## What waiting costs

Three things, and the third is the one that compounds.

**The consuming surfaces stay split or unstartable.** The help page, the
machine-readable per-verb spec, and the listing rows are built and working —
for tools, while a handler on the same piece shows its caller a falsehood. The
rest — the derivable default selection, completion over result fields, the
pre-flight refusal — is built for neither kind and cannot be started: each
needs a declared shape to read, and no amount of CLI work conjures one. The
input side is the demonstration that none of it is novel machinery; the output
side is the same machinery denied its schema.

**The shapes get written down anyway, somewhere nothing checks.** Callers do
know these shapes — that is exactly the point. The knowledge has to live
somewhere, and while the pattern does not carry it, it lives in prose in the
verb's description, in a skill file, in a client's own notes. This is already
happening: the Topics skill (`skills/topics/SKILL.md`) records that `addTopic`
returns the topic it created, and handles version skew by hand — "an older
`addTopic` returns nothing" — in prose. `check-skill-facts` verifies that
file's paths and imports; no gate reads its shapes. None of those homes is
compared against the pattern by anything, so they drift silently, and the
drift surfaces as a caller selecting a field that was renamed and reading
`null`. Waiting does not defer the writing-down; it only decides where it
lands and whether anything can check it.

**Fabric-types arrives against an unexercised surface.** Wiring now means the
consuming side — derivation, rendering, listing, pre-flight refusal — is built
and proven against a real source before the durable contract lands. Waiting
means discovering what those consumers need *after* the durable shape is fixed,
which is the expensive order: a consumer requirement found late against a
published contract is the one case where the permanence objection genuinely
bites.

## The plan's accounting is incomplete

The verbs plan prices this decision as "narrower than first claimed," naming
what it adds as narrowing on field selection and checking a selection before
the call.

That is accurate as far as it reaches, and it reaches two of the five gaps
above — the narrowing and the pre-flight check. It is also right about the
value path: a `$link` marker already renders an address and already suppresses
the fetch without a declared result, so nothing here is about the value path.
What the pricing omits is the command surface: the derivable default, the
completion, the shape half of skew detection, and a help page that currently
tells a caller the opposite of the truth. The plan does carry the listing half
as its own item and sizes it small — what it does not do is weigh any of this
where the decision is priced, which is where a reader deciding it will look.

## What is actually being asked

Two halves, one of which is already built.

The producer half is #5501: a verb's declared result type carried to
`module.resultSchema` and onto the receipt's write-once schema metadata,
end-to-end tested, every gate green. It sits in draft because the decision,
not the code, is what waits — it needs the owner who made the withdrawal call.

The consumer half is the seam this document walks, and it is honest to price
it as more than deleting the early return. A tool's pattern rides in the
callable cell's own value, which is why its branch of `callableCommandSpec`
just reads it; a handler's module lives in the compiled graph, so the handler
branch needs the verb's node looked up there — the graph is loadable today
(`getPattern()`, `packages/piece/src/ops/piece-controller.ts`), the lookup is
the new code — and `renderPieceCallHelp`'s handler branch has to yield to a
populated summary instead of printing its fixed string. The verbs plan carries
this as item 10 and sizes it small: a bounded lookup feeding consumers that
already render the field.

The decision needed:

- **Does a verb's declared result reach the runtime now, by the module-field
  road, rather than waiting for the Fabric-types stream?** If yes, the plan's
  items 8 and 10 stop being provisional and verb discovery closes.
- **If it waits, where do result shapes live in the meantime** — and what
  compares them against the pattern, given that the source-identity skew
  detector cannot?

Three things in the verbs plan hang on the first answer: whether `cf piece
verbs` can carry result schemas, whether a receipt for a verb returning
anything reactive is describable at all, and whether two items of descriptive
receipt work are worth their cost.

Wiring now does not decide anything about the durable contract. The module
field is a wire, not a commitment: no durable schema gains a keyword, no gate
gains a rule, and the field is replaced by assignment when a better source
exists. What the wire feeds *is* caller-visible, and that is the honest
residue — behavior seen is behavior relied on. But everything those surfaces
render derives from the pattern author's declared result type, the same source
the durable contract will carry, so swapping the wire changes nothing a caller
sees. The exposure is one case: the Fabric-types design concluding that
declared results should not reach the runtime at all. In that world the
derived default disappears and a caller who leaned on it supplies the same
selection by hand — which is the status quo this document describes, not a new
cost.

## An independent finding

Named here because it is what the walkthrough exposes, and because it is *not*
this decision — so it should not ride on the answer either way.

**An address is emitted but not accepted as an argument.** A result renders an
address a caller can use as the next command's target, and that composition
works. What refuses it is the argument position: a call payload is plain JSON,
and `normalizeCallableInputForExecution` (`packages/cli/lib/exec-schema.ts`)
does nothing with links. So relating two items to each other — `block`,
`duplicates`, `move`, a `remove` naming a child — has no way to name the second
one.

Declared results make an **output** self-describing. This is about what an
**input** accepts, and it stays open whichever way the timing question is
settled. [A verb session, end to end](../common/verb-session-walkthrough.md)
works the case through.
