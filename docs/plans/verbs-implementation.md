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

Four pull requests remain open against this work. They are listed here because
a driver needs to know what is already moving before scheduling anything new.

| PR | What | State |
| --- | --- | --- |
| #5501 | a verb's declared result reaches its module | ready; the decision below is made, and the producer half is green |
| #5504 | `@` marks a position in a field list | green, walkthrough 38/38 against a live toolshed. The two `notes@` assertions that failed there were the feature, not the test: a pattern result stores each field as a redirect link into the argument document, so the compose walk never saw the array. Markers now align against the source schema, as the mask already did |
| #5609 | a rejected position is not a required one | split out of #5504, because the defect it fixes is on main. A `$link` marker beside any other projection key returns nothing: the rejected position stays in the source's `required`, so the projected schema is unsatisfiable and the whole selection reads as absent |
| #5307 | closed-world verb event schemas | parked on #5589; the minting is built, and what stays red is a renderer-semantics ruling rather than an implementation gap |

**Most of the read layer has landed.** #5309, #5459, #5468, #5470, #5497 and
#5500 are on main. #5458 is closed rather than merged because its rename was
folded into #5470's squash; the shared read step it factored out is on main as
`packages/cli/lib/cell-selection.ts`. A reader who goes looking for #5458 should
not conclude the step was dropped.

**Two are back out: #5469 and #5505 were reverted by #5582.** They merged
twenty-six seconds apart, each green on a base that did not contain the other,
and the tree they made together type-failed — #5469 replaced `invocationId`
with an `invocation: {id, session}` pair, and #5505 added nine `piece call`
selection tests written against the old name. The revert restored the 22 files
they touched byte-for-byte.

Two consequences a driver has to carry:

- **`piece call` has no `--select` / `--schema` / `--filter` again.** That is a
  landed piece of item 6 going back out, not just a test fix.
- **The address change is no longer underneath anything.** `scopeCallerEventId`
  derives from `{caller, id, path, space}` with no identity in the address, so
  two callers choosing the same word — `add-comment-1` is the word two agents
  both pick — compute one address and read one receipt, and the second is told
  its call settled when it never ran. Item 4 was sequenced after item 7
  precisely so that a published address had stopped moving. **That precondition
  is gone, and item 4 must not start until it returns.**

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

The producer half satisfies that already — #5501 is built and green. **The
unknown is the consumer half, item 10.** A tool's pattern rides in the callable
cell's own value, so its branch just reads it; a handler's module lives in the
compiled graph, so the handler branch needs the verb's node looked up there.
That lookup is new code rather than a field already sitting in reach. If it
turns awkward, that is exactly the case the condition names, and the instruction
is to raise it rather than absorb it. Raising it early costs nothing; absorbing
it quietly spends the goodwill this decision was made on.

*What this unblocks.* Items 8 and 10 stop being provisional, and verb discovery
closes — `cf piece verbs` can answer both halves of its question.

*A correction owed to this document.* It priced the decision as "narrower than
first claimed", naming only narrowing on field selection and the pre-call check.
That is right about the value path and omits the command surface: the derivable
default, completion, and a help page that currently tells a caller the opposite
of the truth. A reader weighing the revisit condition will check it against this
pricing, so the pricing needs to be the honest one.

## Ready to build

Unblocked, small, and independent of the decision above.

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

## Landed, and what consumes it

**6. The read layer.** The shared read step, address markers with the
deepest-link rule, container inference, the flag split, and entity-URI intake
are on main. Two pieces are not: the `@` suffix (#5504) is still open, and call
selection went back out with #5505's revert.

**7. Session-scoped invocation ids.** **Reverted** — #5469 is out of main
again. It is the one address-changing commit, and the whole plan is ordered
around landing it before anything publishes a receipt address. Until it is
back, a receipt address is derived without identity in it, so it is not yet
something a caller can safely be handed. Item 4 depends on this; nothing else
does.

**8. Descriptive receipt schemas.** On main. Plain results only — a verb
returning anything reactive gets none, which is what item 1 decides.

**9. Closed-world event schemas and listing marks.** #5307 and #5309, from the
verb contract arc. Both unblocked; both wanted a courtesy review rather than a
gate.

**10. Listing rows carry a handler's declared result.** *(S)* `cf piece verbs`
already reports an `outputSchema` per row, and the type says why it is empty for
handlers: *"Tools only, until handlers gain declared results."* Item 1 is what
supplies them. This is the deferred half of verb discovery finally closing, and
it is a consumer change — the plumbing is built.

*A terminology collision made this look like more than it is.* A pattern's
**result-schema literal** is where its stream properties live, and the listing
marks are stamped there. A **verb's declared result** is what a handler returns.
The two share the words and nothing else, which is why the listing work and the
declared-result work read as coupled when they are independent. Only this item
joins them.

## Ordering

| Item | After | Why |
| --- | --- | --- |
| 6 | — | landed but for #5504, and for call selection, which #5582 reverted |
| 7 | — | **reverted; must land again before 4 can start** |
| 8, 9 | — | independent |
| 2 | 6 | changes what the flags accept |
| 3 | 6 | completes the suppression property |
| 4 | 7 | publishes an address, so the address must have stopped moving |
| 5 | 4 | the fourth and fifth arrivals inherit whatever a read costs |
| 10 | 1 | listing rows carry a handler's `outputSchema`; the plumbing exists for tools already |
| 1 | — | decided; 8 and 10 are no longer provisional, and item 10 carries the revisit condition |

Items 2, 3 and 5 touch one file heavily and want to land one at a time rather
than in parallel. Item 4 is the only one that touches the call envelope.

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

**#5307 and #5501 reconcile rather than order.** They touch no common source
file and neither depends on the other — a declared result rides a trailing
options argument, while event stamping keys on the first. But #5501's
handler-schema fixtures were compiled before event schemas closed, so once
#5307 lands they gain `additionalProperties: false` on their event literals.
Whichever merges second owes a golden regeneration. That is a note on the pair,
not an edge in the table above.

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
only confirm it. Twice now the fixture has been the thing that was wrong. When
a test cannot fail, the fixture is the first place to look.

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

This plan is exhausted when items 1-5 are decided or built and the open pull
requests have landed. Two arcs are queued behind it, and naming their
triggers here is what keeps them from being dropped when this document stops
being read.

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
