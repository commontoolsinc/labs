# Verbs — implementation plan

Sequences the remaining work on verbs: what a verb declares, what a caller may
ask for, and what comes back. It carries the residue of two implementation
plans whose work is substantially landed, and which are archived as the record
of what each decided:
[the pattern verb contract](../history/plans/pattern-verb-contract-implementation.md)
and
[shaped reads and verb results](../history/plans/shaped-reads-implementation.md).

**The designs are unchanged and are not restated here.**
[The pattern verb contract](pattern-verb-contract.md) says what a verb is.
[Reading Fabric data](fabric-read-model.md) and the two documents it points at
say how a caller reads. Read those for reasoning; read this for order.

## Why one sequencing plan over two

The two arcs describe genuinely different things — one the producer side, one
the consumer side — and their designs stay apart for that reason. But they meet
at exactly one point, and everything expensive about running them separately has
come from that meeting being implicit.

**The one intersection: whether a verb's declared result reaches the runtime.**
It is the withdrawn result-schema emission, the descriptive receipt schema that
stands in for it, the open proposal to carry a declared result onto
`module.resultSchema`, and the verb listing that wants result schemas before it
is complete. One question, four places.

Three agents rediscovered its consequences independently — the append-only
lesson, the update-gate refusal, and the withdrawal history — each paying full
price. That is what a shared sequence prevents. Ordering is temporal, so it
belongs in one document even when the reasoning belongs in two.

## State

Where every item stands. The sections below carry the detail and are what to
read before picking one up; this is the roll-up, so a driver can see the shape
without reconstructing it.

| Item | Status |
| --- | --- |
| 1. a verb's declared result reaches the runtime | on main (#5501) |
| 6. the read layer | on main, in full |
| 7. session-scoped invocation ids | on main (#5610) |
| 8. descriptive receipt schemas | on main |
| 9a. listing marks | on main (#5309) |
| 10. listing rows carry a handler's declared result | in review (#5629) |
| 9b. closed-world event emission | built, parked on #5589 (#5307) |
| 4. `receipt` as a top-level envelope field | not started — and its precondition now holds |
| 2. an unrecognized projection key is refused | not started |
| 3. a rejection propagates up through what holds it | not started |
| 5. `cf wish` and `cf exec` take the read options | not started |
| 11. a caller may name a reference | not started; sequenced, gated on one measurement |

Item 9 is split because its two halves have different fates: the marks landed,
the emission is parked.

These pull requests remain open against this work. They are listed here because
a driver needs to know what is already moving before scheduling anything new.

| PR | What | State |
| --- | --- | --- |
| #5629 | a verb listing row carries the handler's declared result | item 10, the consumer half of the declared result |
| #5307 | closed-world verb event schemas | parked on #5589; the minting is built, and what stays red is a renderer-semantics ruling rather than an implementation gap |

**Most of the read layer has landed.** #5309, #5459, #5468, #5470, #5497 and
#5500 are on main. #5458 is closed rather than merged because its rename was
folded into #5470's squash; the shared read step it factored out is on main as
`packages/cli/lib/cell-selection.ts`. A reader who goes looking for #5458 should
not conclude the step was dropped.

**The invocation pair and call selection are both on main**, re-landed together
by #5610. `scopeCallerEventId` takes the `{id, session}` pair rather than the id
alone, so two callers choosing the same word — `add-comment-1` is the word two
agents both pick — no longer compute one address and read one receipt. `piece
call` takes `--select` / `--schema` / `--filter` beside it.

**So item 4's precondition holds: a published receipt address has stopped
moving.** That is what item 4 was sequenced after item 7 to wait for, and the
wait is over. What it cost to get there is the merge-race hazard recorded under
"How this is driven" below, which is the part worth carrying forward.

## The decision that was waiting, and the condition it carries

**1. A verb's declared result reaches the runtime.** *(#5501)* Decided — and
the timing framing was confirmed rather than merely tolerated: the durable form
is where this eventually lands, so the only live question was whether to wire it
before then.

The July emission was withdrawn because a keyword in durable schemas and
append-only baselines would hard-commit a shape, and the compatibility rules
built alongside it would have refused its removal. Both objections attach to
where the shape was written. A module field enters no durable schema, so no
baseline records it and the gate has no rule to apply — which is why this road
was open when that one was not.

**The approval is conditional, and the condition binds work that is not built
yet.** It was given as: if it is easy to add now, go for it; but if it creates
more things to chase down, revisit rather than push through.

Both halves satisfy it. The producer is on main (#5501). The consumer, item 10,
is the lookup the condition was aimed at — a handler's module lives in the
compiled graph rather than sitting in reach the way a tool's pattern does — and
it cost one structural match and no change to `callableCommandSpec`'s
signature. What it did not reach is the command surface: `cf piece call <verb>
--help --json` still shows a handler no output, because serving it there needs
the graph at `resolvePieceCallable` too. That is raised rather than absorbed,
which is what the condition asks for.

*What this unblocks.* Items 8 and 10 stop being provisional, and verb discovery
closes — `cf piece verbs` can answer both halves of its question.

*A correction owed to this document.* It priced the decision as "narrower than
first claimed", naming only narrowing on field selection and the pre-call check.
That is right about the value path and omits the command surface: the derivable
default, completion, and a help page that currently tells a caller the opposite
of the truth. A reader weighing the revisit condition will check it against this
pricing, so the pricing needs to be the honest one.

## Ready to build

Unblocked and independent of the decision above. Not all small — items 2 and
11 are both (M); what these share is that nothing gates them.

**2. An unrecognized projection key is refused.** *(M)* Two denylists are
consulted and every key in neither is accepted and ignored, so a typo selects
nothing and says nothing, and any keyword given a meaning later changes
behavior no error ever warned about. Three tiers replace them: honored,
tolerated (the annotation and validation keywords, which a lifted source schema
carries), and refused by name.

This is the general form of a failure already fixed twice as instances — a
missing `type` and an untyped `items` root each returned an empty result and
reported nothing.

*Reservation records a class, not a spelling.* An allowlist that says only
"allowed" loses why, and a key admitted without its kind has its treatment
decided by whatever the checker happens to default to — the original trap, one
level up. So each reservation carries what it is: honored, tolerated because it
is an annotation, tolerated because it is a validation keyword. A later change
wanting to honor a tolerated key then knows it was deliberately ignored rather
than overlooked.

The same discipline, on a different registry, is what classifies keys for the
pattern compatibility checker — where the class decides whether adding and
removing a key are both free, and where getting it wrong is what withdrew the
July result-schema work. Sibling registries, not one: a projection is supplied
per read and never compared across versions, so it has no add-and-remove
semantics to get wrong. What transfers is classify-before-you-accept.

*The two registries meet at lifted schemas, and this item is what couples
them.* Today a projection ignores every key it does not recognize, so the
durable dialect can grow freely. Refusing unrecognized keys ends that: a caller
is told to lift a source schema and prune it, a lifted schema carries every
keyword the generator emits, and a keyword admitted to the compat dialect
without also reaching projection tolerance turns a projection over a marked
schema into a refusal — on exactly the keys made deliberately free elsewhere.

So the tolerated-as-annotation set is **derived from the compat checker's
annotation keys rather than restating them**. One edit admits a key to both, and
the vocabulary cannot fork. Where derivation is not possible, the fallback is a
test asserting every annotation key the checker knows is non-refused by the
projection reader — which converts a forgotten second list from a silent
projection failure into a red test naming both registries.

`tier` and `deprecated` are the newest annotation-class keys and the likeliest
to be missing from a set drafted out of the standard JSON Schema vocabulary.
They belong in the tolerated set on day one.

*Exit:* an unrecognized key is refused and the message names it; a tolerated
keyword is accepted and ignored. A command that ran only because a key was
silently dropped now fails loudly, which is the point rather than a regression.

**3. A rejection propagates up through what holds it.** *(S)* The projection
mask reduces an array whose items reject to `false`, but leaves an object whose
every property rejects as a live selector. So marking a field below a link loads
every element document — measured at four reads where one would do. The fix is
the symmetric reduction, which then cascades to the array above it.

*Exit:* a marked collection is one document read whether the marker sits on the
link or below it.

**4. `receipt` as a top-level envelope field.** *(S)* Published from the
handling receipt link, so a caller holds the address before the outcome exists —
including under `--no-wait`, which returns none today and is therefore a dead
end for collecting work later.

This is also what gives items 8 and 9 a consumer: a receipt's schema is read by
`piece get` against the address this publishes, not by the call path.

*Exit:* a detached call returns an address that reads back the outcome it
names.

**5. `cf wish` and `cf exec` take the read options.** *(S each)* The two
remaining arrivals. A vocabulary that works from two starting points and
silently does nothing from the other two teaches a rule that is false half the
time.

Two constraints carry from the design: a wish's selection runs *before* the walk
that strips handles, because a marker needs a live cell to read an address from;
and `exec` already prints its result cell as prose on stderr, in a spelling no
other command accepts, which this is the occasion to make the declared shape.

*Exit:* the same cell, reached four ways, renders identically under the same
selection.

**11. A caller may name a reference.** *(M)* A verb whose event declares
`Writable<T>` is callable by a model and by nothing else. `traverseAndCellify`
(`packages/runner/src/builtins/llm-dialog.ts`) resolves `{"@link": …}` into a
live cell before dispatch, so the LLM boundary has a complete round trip; the
CLI rejects the address and the webhook path forwards it unresolved. The
shape-matching payload the CLI *does* accept stores a detached copy and reports
success.

*The refusal is drift, not policy.* `closedWorldEventRejection`
(`packages/runner/src/runner.ts`) validates a present event payload with
`acceptOpaqueValue: (value) => isCellLink(value)` — a link passes unjudged,
because its target cannot be read at dispatch. `verbInputSchemaError`
(`packages/cli/lib/callable.ts`) calls the same `validateSchemaValue` with two
arguments, so the options object defaults to `{}`. Same validator; the outer
gate never got the option. The design is
[references as arguments](references-as-arguments.md).

*Measured: `send()` already resolves a native sigil.* A raw sigil link riding
an event payload reaches the handler as the **resolved target**, not an
envelope — probed against a local toolshed with an `any`-typed event field, so
nothing gated it: the handler saw the target's own properties and read its
`title`. That settles the question
[references as arguments](references-as-arguments.md) flagged untested, and it
means the door is already open under the native spelling. This item names a
capability rather than adding one.

Four parts. Two are independent of everything:

- **Refuse the structural copy.** Correct under any road, needs no vocabulary
  and no gate change, and converts silent corruption into an error.
- **Give the CLI gate the option the dispatch gate already passes.** One
  argument at one call site — and on the measurement above, *sufficient on its
  own* for the native sigil spelling, since the gate is the only thing between
  that payload and a `send()` that already resolves it. Worth confirming
  against a declared field rather than the `any` the probe used.
- **Lift resolution to a shared home**, beside `parseLink` and the LLM-friendly
  pair in `packages/runner/src/link-utils.ts`. This is what admits the *other*
  spellings — the `$link` shape a read emits, and the LLM-friendly form — so it
  serves composition rather than basic capability.
- **Fix event-schema emission.** An inline `Writable<{…}>` disappears from the
  emitted properties entirely. That half is independent and needed under any
  road, doubly once event schemas close, since a field the schema does not name
  cannot be supplied at all. Only the `asCell` marker hangs on the decision
  below.

*One decision inside the item:* schema-blind or schema-directed resolution.
Schema-blind is proven twice — `traverseAndCellify` and the dispatch gate;
schema-directed is checkable and refuses a typo. It decides whether the `asCell`
marker is required or merely useful, so reach it before starting that half.

*A constraint rather than a decision:* what is accepted inbound must include the
shape a read emits, or a caller cannot submit the address it was just handed.

*CFC gets a notification, not a ruling* — an existing capability widening from
the user's own model session to external principals.

*Exit:* `cf piece call --piece <root> addPiece '{"piece": <address>}'` registers
the piece — the root pattern's own verb, reachable today by `pieces.add` from
inside the runtime and by a model through the dialog builtin, and by no other
caller.

## Landed, and what consumes it

**6. The read layer.** On main in full: the shared read step, address markers
with the deepest-link rule, container inference, the flag split, entity-URI
intake, the `@` suffix, and call selection.

**7. Session-scoped invocation ids.** On main (#5610). It is the one
address-changing commit, and the whole plan is ordered around landing it before
anything publishes a receipt address — so a receipt address now carries
identity and is something a caller can safely be handed. Item 4 depends on
this; nothing else does.

**8. Descriptive receipt schemas.** On main. Plain results only — a verb
returning anything reactive gets none, which is what item 1 decides.

**9. Closed-world event schemas and listing marks.** Half landed: the listing
marks are on main (#5309). Closed-world emission (#5307) is built but parked on
#5589 — closing a verb's `$event` closes it against the browser too, and
whether a renderer's DOM-event envelope is governed by the verb's schema is a
semantics ruling rather than an implementation gap.

**10. Listing rows carry a handler's declared result.** *(S)* `cf piece verbs`
reports an `outputSchema` per row for a handler as well as for a tool, so verb
discovery answers both halves of its question: what a caller may send, and what
it gets back. A tool's result schema rides its callable cell and its branch
just reads it. A handler's rides the node it compiled to, so the listing
resolves the piece's pattern once and matches each handler node's `$event`
input against the result property exposing the same stream — one structural
comparison inside one compiled object. A stream two handler nodes share names
no single result, and a piece whose pattern will not resolve keeps every row
and loses only the schema.

*A terminology collision made this look like more than it is.* A pattern's
**result-schema literal** is where its stream properties live, and the listing
marks are stamped there. A **verb's declared result** is what a handler returns.
The two share the words and nothing else, which is why the listing work and the
declared-result work read as coupled when they are independent. Only this item
joins them.

## Ordering

**A defect this plan's own items caused is not a separate queue.** The items
build a verb surface; the issues below are that surface failing where it is
already built. Sequencing them apart would mean shipping items 4 and 5 onto a
read path known to break after a handler runs, so they are interleaved here and
each step names what it delivers.

Two rules set the order. **One file at a time** — two branches open on one file
is the merge race under "How this is driven", so steps sharing a file are
strictly sequential while separate files run in parallel. **A blocked step never
gates an unblocked one**, which is why everything waiting on a ruling sits in
its own track.

| # | Step | Delivers | After | Why here |
| --- | --- | --- | --- | --- |
| 1 | The doubly-linked tracker fixture and its walkthrough | **on main** (#5639, #5631) — repro for #5577, #5632, #5633, #5637; item 11's subject | — | Five things verify against a piece that holds a back-reference, and none could be demonstrated until one existed. `verb-session-gaps.sh` is where they are asserted, and four of its assertions expect a gap and fail loudly the day it closes — so a capability arriving announces itself instead of quietly turning a check green |
| 2 | A projected read survives a handler | #5633 | 1 | Breaks call-then-read-shaped, which is the loop items 4, 5, 10 and #5577 all demonstrate against. Diagnose before estimating: if it sits in runner materialization rather than the read path, it moves after step 7 rather than holding the line |
| 3 | Listing rows carry a handler's declared result | item 10, #5619 | — | The consumer half of item 1 |
| 4 | The forced-stream fallback stops inventing verbs | #5576 | 3 | Same file as step 3. It narrows the listing, so sweep the open branches for writers first |
| 5 | The help page stops claiming a verb returns nothing | #5558 (the false claim) | — | `Output: No output on success.` is wrong for a declared verb. Asserting there is no output is worse than saying nothing, and stopping it needs no schema and no decision, which is why it precedes the half that does |
| 5a | An author's prose reaches the caller | #5637 | 1 | Separate lane — what is missing is not in the CLI. See the measurement below: two of the three symptoms are emitted correctly and lost afterwards, so a fix aimed at the emitter would miss them |
| 6 | Help enumerates what a verb returns | #5558 (the missing fields) | 3, 5 | Step 3 builds the declared-result lookup; this is its second consumer, at the call path rather than the listing |
| 7 | A returned piece reads back through its own cycle | #5577 | 6 | The derived default selection bounds the readback, which is what turns the crash into a result |
| 8 | `receipt` as a top-level envelope field | item 4 | — | Its precondition is met, it touches the call envelope alone, and it is what gives items 8 and 9 a consumer. Runs beside steps 5-7 |
| 9 | A rejection propagates up through what holds it | item 3 | — | First of the projection work; the mask's asymmetry is what makes a marked field below a link load every element |
| 10 | Two identical projections stop colliding | #5523 | 9 | Same file. Reachable the moment anything long-lived reads twice, which the command surface invites |
| 11 | One piece, one address | #5632, #5498 | — | Trace where each id is minted; the outcome is a fix or a statement that they are aliases. Must precede step 13, which spreads the address vocabulary to two more commands |
| 12 | An unrecognized projection key is refused | item 2 | 9 | The largest remaining step and the only one with design surface, since it couples the projection reader to the compatibility checker's annotation keys |
| 13 | `cf wish` and `cf exec` take the read options | item 5 | 11, 12 | Last by construction: it spreads the vocabulary to two more starting points, so the vocabulary should have stopped moving |

**Waiting on a ruling, and running beside all of the above.** Closed-world event
emission (item 9b) is built and parked on #5589. When that answers, the branch
merges as-is, amends `closedWorldEventRejection`, or retreats — all three are
costed on #5307 — and it owes an item renumber, then a baseline re-record as its
final step. A caller naming a reference (item 11, #5560) waits on confirming
that a sigil resolves through a *declared* event field rather than an untyped
one; it decides nothing item 1 decides — a declared result makes an *output*
self-describing, this is what an *input* accepts — but it shares
`schema-injection.ts` with that emission, so the one-file rule applies to the
pair and one holder suits both.

**Where a doc comment actually goes, measured against the compile pipeline.**
Step 5a rests on this, and it is not what either symptom looked like from the
CLI:

| An author writes it on | In the compiled pattern |
| --- | --- |
| a verb (`Stream` property) | **present** — `resultSchema.properties.<verb>.description`, as a sibling of the `$ref` to the event's definition |
| an event field | **present** — `$defs.<Event>.properties.<field>.description` |
| the event interface itself | **absent** |

So only the third is an emission gap. The first two are emitted and lost
between the pattern and the caller: the schema a caller is served is the
resolved form — no `$defs`, no `$ref`, the target inlined — and both
descriptions are absent from it.

*The obvious explanation is not the explanation.* A `description` beside a
`$ref` is ignored under JSON Schema's own semantics, so a resolver that
substitutes the target would drop it. This one does not:
`resolveCfcSchemaRefsUncached` (`packages/runner/src/cfc/schema-refs.ts`)
collects ref-site siblings and merges them over the resolved target on purpose.
That rules out the tidy answer for the verb, and it never explained the event
field, whose description sits inside the `$def` rather than beside the ref.

*A lead, unverified.* `resolveSchema` (`packages/runner/src/schema.ts`) calls
`resolveSchemaRefs(schema)` with one argument, so the document consulted for
`#/$defs/...` defaults to the property schema itself — and a verb property
carries the `$ref` while the `$defs` live at the pattern's result-schema root.
Whoever takes this should confirm or discard that before assuming a single
cause: what is established is only that the emitter is not where two of the
three go missing, so a patch aimed there would close one symptom and leave two.

**Carried alongside, not sequenced.** A capability probe that covers nothing
(#5534) is a test asserting something it cannot observe, so it reports green
continuously until fixed; it belongs to whoever next touches that suite rather
than to a step here.

## How this is driven

One agent owns this document and the ordering in it. Work is farmed out per
item, not per file, and an item comes back with its own tests rather than a
promise of them.

**This document owns the record as well as the order.** The plans it replaces
are archived, so there is no longer a live plan for an author to strike a done
note into as their work lands; done state belongs in the State table above, and
keeping it current is this document's job rather than each author's. That is
worth stating because the alternative — several sessions editing one shared
plan as their PRs land — is the collision the per-agent split exists to avoid.

Two rules earn their place, both from what went wrong when this was three
plans:

**#5307 owes a golden regeneration, and it is the only thing it owes #5501.**
The two touch no common source file — a declared result rides a trailing
options argument, while event stamping keys on the first — so this is a note on
the pair rather than an edge in the sequence. But #5501's handler-schema
fixtures were compiled while event schemas were still open, so closing them
gives those fixtures `additionalProperties: false` on their event literals. The
second to land regenerates, and #5501 landed first.

**Two PRs can each be green and still break main together.** CI judges a PR
against a base, so when one branch narrows a type and another still writes to
the old shape, both stay green until they meet. #5469 and #5505 merged
twenty-six seconds apart and #5582 reverted both. Nothing in the checks catches
it; the only thing that does is a driver noticing that two open PRs touch one
vocabulary, and merging them far enough apart that the second rebases onto the
first. The tell is a green PR whose base predates a merge that changed
something it writes to — a rename is the obvious case, but any narrowing
counts.

The cost is worse than a red gate, because the stale field arrives as an
*excess property*, silently dropped rather than rejected. The nine tests #5505
added did not merely fail to compile: they dispatched with no invocation at all
and awaited a receipt that could never arrive. Type-checking is the only gate
that sees an excess property. A `--no-check` suite sees a value that is simply
absent — and the package suites run `--no-check`, so `172 passed | 0 failed`
reads identically either side of this bug and is not evidence about it.

**A test that inspects stored shape is testing the harness, not the runtime.**
A pattern result stores each field as a redirect link into the argument
document, while a unit fixture writes the value inline. So a check reading
`position.stored` succeeds against the fixture and never fires against a real
server. Anything asserting on how a value is *stored*, rather than on what a
read *returns*, wants a live-server case before it is believed.

This is the same shape as the rejected-position defect split out as #5609: the
`boardSchema` fixture declares no `required` while a generated pattern schema
does, so every fixture in that file agreed with the bug and the suite could
only confirm it. It is also the shape that hides in a double: a compiled
pattern is callable, so a double written as a plain object passes a guard that
rejects what the runtime actually hands over, and the suite stays green while
every real listing comes back empty.

Three instances make it a mechanism rather than a run of bad luck, and the
general form is worth more than any of them: **when a double stands in for
something the runtime constructs, check what the runtime constructs.** A
fixture is a claim about the world, and an unchecked one is the cheapest way to
build a test that cannot fail. When a test cannot fail, look at the fixture
first.

**A squash merge invalidates the fork point of everything stacked on it.**
Rebasing a child with `git rebase <new-base>` then replays commits the base
already contains, and the duplicate-commit conflicts look like real ones.
`git rebase --onto <new-base> <the branch's own first commit's parent>` is the
form that works. The cheapest tell that a fork point was wrong: the branch
suddenly touches files it has no business in.

**Archiving a document does not protect it from a rebase.** Git follows the
rename, so a branch that edited the live document applies its edit inside the
frozen copy — with no conflict, which is what makes it dangerous. Three separate
branches did this the day the predecessors were archived, and every one of them
rebased cleanly. After archiving anything, check whether an open branch still
edits it; the edit belongs wherever the live successor keeps that kind of
content, not in the record.

**`deno fmt` does not check anything under `docs/`.** The directory is in the
formatter's exclude list, so a passing `deno fmt --check` after a documentation
edit says nothing about that edit. The gates that do apply are `check-docs` for
code blocks, `check-conflict-markers`, and `docs-links --orphan`. Prose wrapping
is convention here rather than enforcement.

**A shared golden is a coordination point, not a merge conflict.** Two branches
can modify a generated fixture without conflicting textually and still leave it
encoding only one change. Whoever lands second regenerates.

**A keyword is classified before it is emitted.** Adding one to a durable schema
is free and removing one is not, so the classification has to precede the first
emission or the keyword is permanent by accident. This is what withdrew the
July result-schema work, and what #5309 got right by hand.

## What comes after

This plan is exhausted when the sequence above is walked and the issue tail is
empty — the items build the surface, and the tail is that surface failing where
it is already built, so neither alone finishes it. Two arcs are queued behind
it, and naming their triggers here is what keeps them from being dropped when
this document stops being read.

**The command surface** —
[The CLI surface](cli-surface-implementation.md), already sequenced. Its first
two stages add positional addresses and the top-level names, and they can start
as soon as the read layer has merged; they touch the same commands, so starting
earlier means resolving the same files twice. Its deprecation stage carries an
unanswered question of its own — what "carries traffic" means, given nothing
measures it — and that wants an answer before the stage rather than during it.

**Retention and CFC execution provenance** —
[its own plan](retention-and-provenance.md). Gated on a CFC review that has not
happened. Nothing in this plan advances it, and nothing in it blocks this plan.

Whoever drives this document owns that queue, not just this list. A plan that
finishes without naming its successor is how an arc goes quiet with work left
in it.

## The issue tail

Every open defect against this surface, and where it attaches. A defect absent
from a plan is one nobody schedules, which is the whole reason for this table.

| Issue | What | Attaches at |
| --- | --- | --- |
| #5633 | a projected read fails after an unrelated handler runs, while the same path unshaped succeeds | step 2 |
| #5619 | listing rows carry a handler's declared result | step 3 |
| #5576 | `cf piece verbs` lists data fields as handlers, so discovery reports what cannot be called | step 4 |
| #5558 | `piece call --help` claims every handler returns nothing, including one that declares a result | steps 5 and 6 — the false claim needs nothing, enumerating the fields needs the lookup |
| #5637 | an author's prose does not reach a caller: on a verb, on an event field, and on the event interface | step 5a — it absorbed #5559, which described one symptom and had its cause backwards |
| #5577 | a verb returning a child piece in a doubly-linked tree crashes readback on a cycle | step 7 |
| #5523 | two identical `piece get` projections in one runtime collide on the transform result cell | step 10 |
| #5632 | `--show-links` and a `$link` read return different entity ids for the same piece | step 11 |
| #5498 | `getEntityId()` strips the entity URI scheme, collapsing two kinds to one identity | step 11, if it proves to be the same root |
| #5589 | ruling: does a closed verb schema govern the renderer's DOM-event envelope? | the parked track — it is what unparks item 9b |
| #5560 | an address a call returns cannot be passed back as a verb argument | item 11 |
| #5534 | a capability probe passes while covering nothing: a dispatch rejection is not a synchronous throw | carried alongside |

**Filed against neighbouring subsystems, and not sequenced here.** `{ proxy:
true }` never reaching `module.writableProxy` for a transformed pattern
(#5502), an unnormalized external piece id upserting twice (#5499), and a
create that drops its navigation (#5530). Each is real and none is about the
verb surface; they are recorded so that reading this plan does not imply they
were triaged away.

## Out of scope

**Retention and CFC execution provenance** — the `AgentActor` mint, its
propagation, metadata confidentiality, and retiring `AgentAuthoredEvent`. Gated
on a CFC review, sized large, and not about verbs: it is a program that was
filed under one. It is sequenced in
[its own plan](retention-and-provenance.md).

**The command surface** —
[The CLI surface](cli-surface-implementation.md) sequences positional addresses,
the top-level names, deprecation, and the merges. Kept apart because it renames
rather than adds, so every step of it can break a caller who learned the current
spelling.

**The designs.** Nothing here amends
[the pattern verb contract](pattern-verb-contract.md) or
[Reading Fabric data](fabric-read-model.md). An item that needs a design changed
says so and stops.
