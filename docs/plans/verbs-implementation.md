# Verbs — implementation plan

Sequences the remaining work on verbs: what a verb declares, what a caller may
ask for, and what comes back. It carries the residue of two
implementation plans whose work is substantially landed —
[the pattern verb contract](pattern-verb-contract-implementation.md) and
[shaped reads and verb results](shaped-reads-implementation.md) — which are
archived once this replaces them.

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

Twelve pull requests are open against this work. They are listed here because a
driver needs to know what is already moving before scheduling anything new.

| PR | What | State |
| --- | --- | --- |
| #5307 | closed-world verb event schemas | update gate resolved, 336/336 patterns clean; held only for a courtesy nod |
| #5309 | wrapper-tier and deprecated listing marks | rebased current; compat classification landed ahead of emission |
| #5458 | the shared read step, factored out | open |
| #5459 | `--piece` accepts the `of:` entity URI | open |
| #5468 | receipts carry a descriptive schema | open |
| #5469 | invocation ids scoped to a session | open |
| #5470 | `$link` marks a position for its address | open |
| #5497 | a projection keyword names its container | open |
| #5500 | `--select` and `--schema` split | open |
| #5501 | a verb's declared result reaches its module | **draft — the open decision** |
| #5504 | `@` marks a position in a field list | open |
| #5505 | `piece call` takes the selection flags | open |

## The decision everything else waits behind

**1. Does a verb's declared result reach the runtime?** *(#5501, draft)*

The result-schema emission built in July was withdrawn for three recorded
reasons: the value path did not need it, a keyword in durable schemas and
append-only baselines would hard-commit a shape the Fabric-types stream
evolution is expected to replace, and the compatibility rules built alongside it
would have refused its later removal.

#5501 is a different road to the same property — an existing field on a node's
module rather than a new dialect keyword, with the compatibility gate untouched
— and the first two objections are answered on that road. What it buys is
narrower than first claimed: a `$link` marker already renders an address and
already suppresses the fetch without it. What it adds is narrowing on field
selection, and checking a selection before the call rather than after.

Three things hang off the answer:

- whether `cf piece verbs` can carry result schemas, which its own issue defers
  until this exists;
- whether a receipt for a verb returning anything reactive is describable at
  all, since the descriptive derivation runs only where the result is plain;
- whether items 8 and 9 below are worth their cost, since both improve a
  description nothing yet consumes.

It is a draft rather than a proposal because it needs the owner who made the
withdrawal call. Until then it blocks nothing, but it makes three other
decisions provisional.

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
reported nothing. It also generalizes the reserve-then-emit discipline #5309
applied by hand to its two marks.

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

## Landed, pending merge

**6. The read layer.** #5458, #5470, #5497, #5500, #5504, #5505, #5459 — the
shared read step, address markers with the deepest-link rule, container
inference, the flag split, the `@` suffix, call selection, and entity-URI
intake. All built and restacked onto current main.

**7. Session-scoped invocation ids.** #5469. The one address-changing commit;
it lands alone, ahead of anything that publishes a receipt address, so no caller
holds one that moves.

**8. Descriptive receipt schemas.** #5468. Plain results only — a verb returning
anything reactive gets none, which is what item 1 decides.

**9. Closed-world event schemas and listing marks.** #5307 and #5309, from the
verb contract arc. Both unblocked; both wanted a courtesy review rather than a
gate.

## Ordering

| Item | After | Why |
| --- | --- | --- |
| 6 | — | the stack merges bottom-up: #5458 → #5470 → #5497 → #5500 → {#5504, #5505} |
| 7 | — | independent of 6; must precede 4 |
| 8, 9 | — | independent |
| 2 | 6 | changes what the flags accept |
| 3 | 6 | completes the suppression property |
| 4 | 7 | publishes an address, so the address must have stopped moving |
| 5 | 4 | the fourth and fifth arrivals inherit whatever a read costs |
| 1 | — | blocks nothing; makes 8 and the verb listing provisional |

Items 2, 3 and 5 touch one file heavily and want to land one at a time rather
than in parallel. Item 4 is the only one that touches the call envelope.

## How this is driven

One agent owns this document and the ordering in it. Work is farmed out per
item, not per file, and an item comes back with its own tests rather than a
promise of them.

Two rules earn their place, both from what went wrong when this was three
plans:

**A shared golden is a coordination point, not a merge conflict.** Two branches
can modify a generated fixture without conflicting textually and still leave it
encoding only one change. Whoever lands second regenerates.

**A keyword is classified before it is emitted.** Adding one to a durable schema
is free and removing one is not, so the classification has to precede the first
emission or the keyword is permanent by accident. This is what withdrew the
July result-schema work, and what #5309 got right by hand.

## What comes after

This plan is exhausted when items 1-5 are decided or built and the twelve open
pull requests have landed. Two arcs are queued behind it, and naming their
triggers here is what keeps them from being dropped when this document stops
being read.

**The command surface** —
[The CLI surface](cli-surface-implementation.md), already sequenced. Its first
two stages add positional addresses and the top-level names, and they can start
as soon as the read layer has merged; they touch the same commands, so starting
earlier means resolving the same files twice. Its deprecation stage carries an
unanswered question of its own — what "carries traffic" means, given nothing
measures it — and that wants an answer before the stage rather than during it.

**Retention and CFC execution provenance** — extracted from the verb contract
arc into its own plan. Gated on a CFC review that has not happened. Nothing in
this plan advances it, and nothing in it blocks this plan.

Whoever drives this document owns that queue, not just this list. A plan that
finishes without naming its successor is how an arc goes quiet with work left
in it.

## Out of scope

**Retention and CFC execution provenance** — the `AgentActor` mint, its
propagation, metadata confidentiality, and retiring `AgentAuthoredEvent`. Gated
on a CFC review, sized large, and not about verbs: it is a program that was
filed under one. It moves to its own plan.

**The command surface** —
[The CLI surface](cli-surface-implementation.md) sequences positional addresses,
the top-level names, deprecation, and the merges. Kept apart because it renames
rather than adds, so every step of it can break a caller who learned the current
spelling.

**The designs.** Nothing here amends
[the pattern verb contract](pattern-verb-contract.md) or
[Reading Fabric data](fabric-read-model.md). An item that needs a design changed
says so and stops.
