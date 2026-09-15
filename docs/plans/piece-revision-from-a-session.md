# Revising a piece's source from an agent session

A person points at a piece they already have and says what should be
different. The session reads the piece's cells, schema and data through
handles, reads or edits its source deliberately, and the piece updates in
place: data intact, a revision that is visible and reversible.

This plan is the design for the cf-harness surface that does that. Seven
questions, each with a recommendation, the alternative it was chosen over,
and what that choice costs. Question 2 — whether program text enters a
model context — is ruled: the child that performs the revision may read
the source, the parent may not. The rest await a ruling, and the three that
are still open are listed at the end. It is a plan, not a spec: the design
of record for the lifecycle it sits on is
[`../specs/piece-source-lifecycle.md`](../specs/piece-source-lifecycle.md),
and the vocabulary below is that document's.

## What already exists

Almost all of the runtime half. Recording it first is what keeps the
harness surface small.

A piece carries an append-only log of source revisions. A revision names the
exact content-addressed pattern, the origin at that point, and one of eight
operations — `baseline`, `create`, `edit`, `origin-update`, `detach`,
`revert`, `follow`, `repoint`
([`runner.ts:1190`](../../packages/runner/src/runner.ts#L1190),
[`runner.ts:1200`](../../packages/runner/src/runner.ts#L1200)), read back by
[`getPieceSourceRevisions`](../../packages/runner/src/runner.ts#L11922).
[`readPieceSourceState`](../../packages/piece/src/ops/piece-origin.ts#L577)
returns every source fact one piece carries, including its authored files;
[`readPieceSourceRevision`](../../packages/piece/src/ops/piece-origin.ts#L607)
returns the retained files of any single revision.

Replacing a piece's source is two calls on the piece controller.
[`checkPattern`](../../packages/piece/src/ops/piece-controller.ts#L4647)
compiles a candidate without persisting it and answers every compatibility
reason at once — pattern schema, retained argument, retained links, and the
CFC schema envelope stored on the argument document.
[`setPattern`](../../packages/piece/src/ops/piece-controller.ts#L4713)
applies one, detaching the piece from any origin it follows and returning
the accepted setup transaction's receipt: the content-addressed pointer, the
source revision id, and the origin it detached.
[`changeSource`](../../packages/piece/src/ops/piece-controller.ts#L4207)
carries the other four actions, `restore` among them
([`piece-controller.ts:448`](../../packages/piece/src/ops/piece-controller.ts#L448)),
which is undo: it restores a selected revision's retained authored program
and appends a `revert` revision naming it.

Undo already has a face. The piece menu that `cf-render` gives every host,
the Weaver included, lists every recorded revision, and an earlier one
offers **Use this version**
([`piece-source-lifecycle.md`, "Trust model"](../specs/piece-source-lifecycle.md#trust-model)).

The harness already holds the controller that makes those calls: a fabric
session is a connected `PiecesController`
([`fabric-session.ts:21`](../../packages/cf-harness/src/fabric-session.ts#L21)).

And the pill already sends the piece. Loom's selected-instance path mints
each selected pattern instance as an ordinary input cell —
`{'name': 'pattern_N', 'ref': '/of:' + piece_id}`
([`src/lib/cf_harness_pattern_inputs.py:148`](https://github.com/commontoolsinc/loom/blob/cb1653bfc/src/lib/cf_harness_pattern_inputs.py#L148),
loom #5722) — so a handle over the piece's root cell reaches the session
today, under an operator-chosen name, and `describe_handle` answers shape,
labels and fill over it.

The half of question 2 that keeps source away from the parent is built too,
and built deliberately. The `pattern-author` subagent profile has its own
tool surface, its own return contract, and authority over that contract, so
a delegation cannot widen it
([`subagent.ts:86-113`](../../packages/cf-harness/src/contracts/subagent.ts#L86-L113),
[`subagent.ts:251-306`](../../packages/cf-harness/src/contracts/subagent.ts#L251-L306),
[`subagent.ts:509`](../../packages/cf-harness/src/contracts/subagent.ts#L509)).
That contract already states the rule this design needs, in its own words:
it has "no field for source, in any encoding, because a parent has no use
for source it should not be compiling".

What is missing is narrow: nothing tells a context that a handle names a
**piece** rather than a cell, no tool reads a piece's source under a label,
no profile is shaped to hold one, and no tool applies a revision.

## 1. The reference: how a piece reaches a session

**Recommendation: a piece handle, minted by the same mechanism as an input
cell, distinguished by what `describe_handle` says about it — not a new
`pieceRefs` channel.**

The wire already carries it. What the design adds is a fact about the
referent, not a new way to pass one: when a handle's referent is the root
of a piece, `describe_handle` says so, and adds four fields to what it
already returns:

- `piece: true`, and the piece's own name;
- `sourceRevisionId` — the current revision, the value a revision tool's
  precondition is written against;
- `revisions` — for each recorded revision, its id, timestamp and
  `operation`, and nothing else;
- `origin` — the origin kind and whether the piece is detached.

Everything else `describe_handle` already discloses over a cell — schema
shape, label atom types, fill — it keeps disclosing, and under exactly the
rules it applies now
([`describe-handle.ts:48-53`](../../packages/cf-harness/src/tools/describe-handle.ts#L48-L53)).

What it never discloses: **program text**, and every string in or derived
from it. Not the authored files, not file names, not the export symbol, not
the pattern identity, not the repository locator, not an origin URL's path.
`readPieceSourceState` returns all of those
([`piece-origin.ts:66`](../../packages/piece/src/ops/piece-origin.ts#L66));
the piece handle's disclosure is a strict subset of it, and question 2 is
where the rest goes — to the revising child, through a tool of its own, and
never to the parent. The revision list is ids, times and an eight-value
operation enum — a channel with no author-chosen text in it at all, which
is what lets undo be discussed in a context that never reads a line of the
program, which is the parent's whole position here.

**Alternative: a new `pieceRefs` channel on the task, parallel to
`patternRefs`.** Rejected. `patternRefs` names content-addressed entries in
the index and resolves them through it
([`pattern-refs.ts:74`](../../packages/cf-harness/src/pattern-refs.ts#L74));
a piece is not an index entry, is not content-addressed, and resolves
through the space. A second channel would duplicate the input-cell
grammar's space check, its name rule and its fail-closed mint
([`input-cells.ts:63`](../../packages/cf-harness/src/input-cells.ts#L63))
for a reference the existing channel already carries correctly.

**Cost of the recommendation.** Three things.

First, `pattern_1` is a bad name for what it names, and it is loom's to fix
— a handle's name is the whole of what the model is told the token stands
for. That is a one-line change in loom and it should ride with the first
cut.

Second, the disclosure is now conditional on the referent, so
`describe_handle` has one more shape to test and one more way to say too
much. The mitigation is that the added fields are a closed, non-textual
set; the moment one of them becomes author-chosen text, it belongs to
question 2's boundary instead.

Third — and this one is a real leak to rule on, not a caveat — the
**piece's own name** is author-chosen text, and today the pill already
shows it to the person. Including it makes the session able to say "your
bills piece" rather than "pattern_1", which is most of what makes the
experience feel like it is about their piece. Excluding it is the
conservative reading of CT-2199. Recommendation: include it, because the
person who typed the request into the pill selected that piece by that name
one second earlier; the name is not something the session learned by
reading their data.

## 2. Reading the source

**Recommendation (Ben's ruling, 2026-09-15): the child that performs the
revision may read the piece's source into its own context, through a
deliberate labeled read. The parent may not, ever.**

This is the same line `run_pattern`'s answer rule already draws, applied to
program text: a context that has to work with a thing holds it, and what
crosses back to the parent is a reference, a diagnostic and a receipt.

### The two halves

**The child half — a labeled read.** A `read_piece_source` tool, on the
revising child's surface and on no other, takes a piece handle and returns
the authored files of the piece's current revision. It is not a file read
and does not go through `read_file`: the piece is addressed by handle, the
read goes through `readPieceSourceState`
([`piece-origin.ts:577`](../../packages/piece/src/ops/piece-origin.ts#L577)),
and the reply carries

- the piece's live CFC labels, the same view `describe_handle` reports over
  the same referent — so the child's context ceiling rises to include them
  and every later boundary measures the child against that ceiling rather
  than against the ceiling it had before it read;
- an **authored-source integrity** statement: whether this revision's
  source was operator-provisioned, authored by this principal, or authored
  by another — which is the fact that decides how much the child should
  trust what it is reading, and is not derivable from the bytes;
- the current `sourceRevisionId`, so the read and the later write name the
  same revision.

The read is recorded in the run artifact as its own event, because
"deliberate" has to be legible afterwards: a reader of the run can see that
this child read this piece's source at this revision, which is the property
CT-2332 asks for in the words "deliberate and recorded".

**The parent half — the invariant, which is mostly already enforced.** The
`pattern-author` profile is already built to this shape and its reasoning is
already written down. Its tool surface has no `write_file` and no
`edit_file` because "its deliverable is a result reference, not a file"
([`subagent.ts:86-113`](../../packages/cf-harness/src/contracts/subagent.ts#L86-L113)).
Its return contract is a discriminated union with, in the contract's own
words, "no field for source, in any encoding, because a parent has no use
for source it should not be compiling"
([`subagent.ts:251-306`](../../packages/cf-harness/src/contracts/subagent.ts#L251-L306)).
And it holds authority over that contract — `returnContractAuthority:
"profile"`
([`subagent.ts:509`](../../packages/cf-harness/src/contracts/subagent.ts#L509))
— so a caller cannot widen the channel with a `returnSchema` of its own
([`subagent.ts:560-566`](../../packages/cf-harness/src/contracts/subagent.ts#L560-L566)),
which is the loophole a narrow channel otherwise has.

The part that makes the invariant hold rather than merely being intended is
smaller than it looks and is worth naming precisely. When a structured
return schema is in force and the child's return validates, the child's
free-form prose **does not reach the parent at all**: the summary the parent
sees is replaced by the fixed sentence "Subagent returned structured data
matching the requested schema."
([`prompt-loop.ts:1682-1687`](../../packages/cf-harness/src/prompt-loop.ts#L1682-L1687)).
Unconstrained strings inside the validated value are sealed as opaque links
rather than passed
([`structured-result.ts:60-75`](../../packages/runner/src/cfc/structured-result.ts#L60-L75)).
So the whole of the parent-facing channel is `ok`, a failure code from a
fixed vocabulary, a minted result token, and the revision receipt.

So the design's addition to the parent half is a revising profile that
inherits all of that, plus the one thing the profile machinery does not yet
give: `read_piece_source` on that surface and absent from the parent's.

### The invariant, stated so it can fail

*No program text, and no string derived from program text, reaches the
parent context of a revision.*

Three tests, each able to fail:

1. **Surface.** `read_piece_source` is absent from the parent's tool list
   and from every profile but the revising one. A test asserts the tool id
   sets, the way the existing profile surfaces are asserted.
2. **Channel.** A revising child that puts source in its return is
   refused by its own contract: the return schema has no string field a
   program could ride in, and the profile owns the schema so a delegation
   cannot add one. A test plants source in each branch and asserts the
   parent value holds none of it.
3. **The seam.** When validation *fails*, the parent's summary is
   `Subagent return validation failed: <validationError>`
   ([`prompt-loop.ts:1637-1639`](../../packages/cf-harness/src/prompt-loop.ts#L1637-L1639)),
   and that message comes from the schema validator
   ([`schema-sanitization.ts:1675`](../../packages/runner/src/cfc/schema-sanitization.ts#L1675)).
   Whether a validation message can quote the offending value is the one
   thing in this chain the design does not get for free, and it is the
   difference between an invariant and an intention. A test plants source
   in an invalid return and asserts the parent's summary quotes none of it;
   if it does, the fix is a fixed message with the detail in the artifact,
   which is the treatment `run_pattern` already gives thrown text.

### What each half costs

**The child gains what it needs and pays a ceiling.** It can see the code it
is changing, so "make the matching stricter" is ordinary work rather than a
schema-and-diagnostics guess. It pays by taking the piece's labels into its
context: a child that has read a piece holding `email` and `finance` data
is measured against those atoms at every later boundary, so a release it
would previously have made may now be withheld. That is correct rather than
unfortunate — it is the same treatment reading the *data* already gets, and
CT-2189 run 7 shows the withheld-release path working exactly this way. It
is also why the read belongs on the revising child and not the author
child by default: a child that never needs source should not carry the
ceiling that reading it mints.

**The parent loses nothing it had.** It never held source in this design.
What it holds is the handle, the revision id, the diagnostics, and the
receipt — which is what it needs to tell the person what changed.

**The system pays one thing, and it should be said plainly.** Program text
in a model context is still an unlabeled side channel in the sense CT-2199
describes: labeling the *read* raises the child's ceiling, but the program
text the child then writes into `revise_piece` carries no label of its own,
and the diagnostics quoting it are model-facing. This design narrows that
exposure to one context which is already at the data's ceiling and whose
outbound channel is a typed union — which is a far better position than the
parent holding it — but it does not close CT-2199, and it should not be
described as closing it. CT-2199's trigger for being picked up is a run
that shows program text carrying a labeled value across a boundary in a way
that matters to a reader; this design puts a recorded read in front of that
boundary, so if it happens, the record names it.

**Alternative: source never enters any model context** — the harness
retains it and the child edits blind against diagnostics. The
parent-facing half is identical; what differs is whether the child can see
what it is changing. Rejected on the ruling, and the honest statement of
what it would have bought is that the exposure above would not exist at
all, and the honest statement of what it costs is the "make the matching
stricter" class of request, which is most of what a person actually asks
for when iterating on a piece they already have. The retained-source
mechanism it needs is built anyway — question 5 — so this alternative
remains available per-profile if a later ceiling makes it necessary.

### What the author loses, measured

The measurement changes shape under the ruling: the question is no longer
"parent with source vs parent blind" but **"revising child with source vs
revising child blind"**, which is a comparison between the recommendation
and its alternative rather than between two postures for the parent.

The baseline is the series' attempt-to-success ratio on the bills task,
where the child **wrote** the source and could see all of it:

| | run 3 | run 4 | run 5 | run 6 | run 7 |
| --- | --- | --- | --- | --- | --- |
| `run_pattern` attempts | 4 | 5 | 4 | 8 | 5 |
| reaching `ok` | 1 | 2 | 1 | 1 | 1 |

(CT-2189 runs 3–7.) One in four to one in eight, with the whole program
visible. Every one of run 7's four failures was a compile error against
source the child had just written, so seeing the program is evidently not
sufficient for an attempt to succeed. What the ruling buys is not a better
ratio on that loop; it is the class of request that cannot be expressed at
all without reading — a revision described in terms of the code's behavior
rather than its schema.

Cut 1 measures that directly, and it is worth keeping even though the
ruling has settled the posture, because the number is what tells us whether
the blind form is worth keeping as a per-profile option: same piece, same
request, revising child with and without `read_piece_source`, attempts to
first `ok` and whether the blind arm can express the change at all.

## 3. The revision tool

**Recommendation: one tool, `revise_piece`.** The name is the spec's:
its transition table calls this row "Directly edit or wish an existing
piece to change", appending a **direct-edit** revision
([`piece-source-lifecycle.md`, "Source transitions"](../specs/piece-source-lifecycle.md#source-transitions)),
and `edit` is the operation the runner records
([`runner.ts:1190`](../../packages/runner/src/runner.ts#L1190)). Not
`update_pattern`: a pattern is not what is being updated, and the word is
already taken by `origin-update`, a different row of that same table.

**Whose surface it is on.** The revising child's, beside
`read_piece_source`, and not the parent's. The parent delegates a revision
the way it delegates authoring today and receives the receipt; it does not
hold a tool that writes a piece's source, for the same reason it does not
hold one that reads it. This is the profile machinery from question 2 doing
the work in both directions.

**Inputs.**

- `piece` — a handle token, from question 1.
- `sourceText` — the revised program, or `edits` against the retained
  source once question 5's primitive lands. Exactly one, the way
  `run_pattern` already takes exactly one of `sourceText` and `patternId`
  ([`run-pattern.ts:987`](../../packages/cf-harness/src/tools/run-pattern.ts#L987)).
  A child that has read the source can write either; the edit form is the
  cheaper one and is what makes attempt N+1 cost in proportion to its
  change.
- `description` — what this revision changes, in the person's terms.
- `expectedRevisionId` — the revision this change was written against,
  from `read_piece_source` or `describe_handle`. Optional for the first
  cut, required later.

**What it validates.** Nothing new: `checkPattern` first, then
`setPattern`, and the second revalidates independently of the first
([`piece-controller.ts:4647`](../../packages/piece/src/ops/piece-controller.ts#L4647)).
That gets pattern-schema compatibility, retained-argument validation,
retained-link continuity and the CFC schema-envelope check as one report
with every reason at once, which is the report the session needs to fix its
next attempt. `expectedRevisionId` maps onto `expectedPattern`, which the
apply path re-checks inside the write transaction, so a piece someone else
moved between the check and the apply is refused by name rather than
written over
([`piece-controller.ts:4713`](../../packages/piece/src/ops/piece-controller.ts#L4713)).

`dangerouslyAllowIncompatibleSchema` is **not** exposed. A session has no
way to obtain the informed consent that flag stands for, and the spec
requires explicit human confirmation bound to the exact compiled candidate
([`piece-source-lifecycle.md`, "Compatibility policy"](../specs/piece-source-lifecycle.md#compatibility-policy)).
An incompatible candidate is a refusal the session reports to the person.

**How it applies.** The runner's ordinary path, which under server
execution is the served `setsrc` verb: the setup transaction commits
directly to the store rather than sealing into the serving wave, because a
source update publishes module-update authority that requires a transaction
committing to storage itself
([`server-pattern-lifecycle.md`, "Direct commits"](../features/server-pattern-lifecycle.md#direct-commits)).
The harness does not choose this; it falls out of calling `setPattern` on a
connected controller.

**Rehearsal is not something this tool does.** The procedure requires a
server-side `VACUUM INTO` of the live store, a copy to the operator's
machine, and a human judging whether content survived
([`space-clone-rehearsal.md`](../development/space-clone-rehearsal.md)) —
none of which is in a session's reach, and rehearsal-by-agent would be a
claim the artifact could not back. Instead `revise_piece` **refuses** when
the rehearsal triggers fire on a populated space: the compat check fails,
or the candidate changes a result schema, or more than one pattern
generation is live. The refusal names the trigger and says a rehearsal is
required, and the operator runs it by hand. Additive input fields with
defaults and UI-only changes are exactly the cases the doc says need no
rehearsal, and exactly what the demo's revision is, so this refusal does
not stand between the demo and a pass — it stands between the tool and the
one case where it would be lying.

**What it returns.** The receipt, and no source: `revisionId`, the seq the
commit log accepted it at, the origin it detached, the refreshed result
handle, and on refusal the compatibility report. Never authored files,
never the pattern identity. The seq is worth returning because it is what
`cf inspect value-at --seq` and `diff --from` take
([`packages/cli/README.md`, "Updating piece source"](../../packages/cli/README.md)),
so the person's operator can read the piece at exactly the commit that
applied the change.

**Provenance.** CT-2297 is parked, and its ruling is that when picked up it
starts as a harness-local artifact of what a run consulted — no index
schema change, no runner change. So: a `piece-revision` sidecar beside the
tool output, holding the run id, the turn, the `revisionId` the receipt
returned, the skill pins the session held, the doc sections it read, and
the retained before-and-after source. That is entirely inside the harness's
artifact store, is readable from the Console beside every other sidecar,
and adds nothing to the space. The revision itself carries what the runner
already puts on it; the harness's record is what joins that id to the
session that caused it.

**Undo.** Already built, and it should stay where it is. `changeSource`
with `{ kind: "restore", revisionId }` restores a revision's retained
program and appends a `revert`
([`piece-controller.ts:4207`](../../packages/piece/src/ops/piece-controller.ts#L4207)),
and the piece menu every `cf-render` host shows — the Weaver included —
lists the revisions and offers **Use this version**. The person undoes in
the Weaver, not by asking the agent to. No harness tool for undo in this
design: a session that can revert is a session that can quietly discard a
person's change, and the thing it would buy is a button that already
exists.

**Alternative: two tools, `revise_piece` and `preview_revision`.** Rejected
for the first cut. `checkPattern` writes nothing and its verdict is a
point-in-time answer that the apply revalidates anyway
([`piece-controller.ts:4647`](../../packages/piece/src/ops/piece-controller.ts#L4647)),
so a separate preview tool costs a round trip and a model turn to learn
something the apply will re-derive. It earns its place only if the demo
shows a session wanting to describe a change to the person before making
it — which is a plausible outcome of cut 3 and would then be a small
addition, not a redesign.

## 4. Labels and CFC

**Recommendation: nothing new. The existing gates are the right gates, and
the design's job is not to route around them.**

Four claims, each resting on something already true.

**The existing data keeps its labels.** A source update replaces the
program; it does not touch the piece's argument or its stateful documents,
and it is refused outright if the retained argument does not satisfy the
candidate. The labels live on those documents.

**The revised program's derived values derive the same way.** They go
through the runner's commit boundary like any write. CT-2189 run 7 is the
receipt that this works over exactly the data the demo revises: 114 payload
label entries on the reconciliation document, every one carrying both the
`email` and `finance` atoms, read from the store.

**A revision that widens what a cell reads is caught where widening is
always caught.** Writer-fit is a per-transaction gate measured at commit
against the target's write ceiling, and it is a named refusal gate
([`refusal-detail.ts:68`](../../packages/runner/src/cfc/refusal-detail.ts#L68)),
rejecting at `enforce-strict` and flagging below it
([`prepare.ts:6234`](../../packages/runner/src/cfc/prepare.ts#L6234)). A
revised program that reads more broadly and writes the result somewhere
narrower is refused by the same rule that refuses a first-authored program
doing the same thing. The source update is not the boundary and should not
grow a second, weaker copy of that check.

**The update itself runs under the requester's authority.** The setup
transaction carries the requesting principal's CFC trust snapshot rather
than the serving identity's
([`server-pattern-lifecycle.md`, "Authority"](../features/server-pattern-lifecycle.md#authority)),
so a revision is attributed to the person whose session made it.

**The one genuinely open question: an integrity mark on the revision when
an untrusted skill was in context.** There is a precedent and it does not
reach. `acquire_skill` writes a fetched skill's text into a cell and stamps
`ExternalFetchIngest` on the transaction, so the mark derives only from
host-side metadata and touches no attacker bytes
([`acquire-skill.ts:231`](../../packages/cf-harness/src/tools/acquire-skill.ts#L231),
[`external-ingest.ts:44-58`](../../packages/runner/src/cfc/external-ingest.ts#L44-L58)).
A pattern's source closure gets no such stamp: it is written
content-addressed by `compileAndSavePattern`
([`piece-helpers.ts:356`](../../packages/runner/src/piece-helpers.ts#L356))
and carries compiler integrity for delegation, not contextual provenance —
the gap CT-2199's memo records at that surface.

**Recommendation: record it, do not mint it.** The harness's
`piece-revision` sidecar names the skill pins the session held when it
authored the revision; the revision in the space does not carry an atom
saying so. Minting an integrity atom on a source closure is a runner
change, it is CT-2297's territory, and CT-2297's own ruling is to build
nothing there until a demo run shows a reader needed something the record
did not have. Building it now would also be minting a claim this design
cannot yet honor: the closure is content-addressed, so the same source
authored twice — once with an untrusted skill in context and once without —
is the same document, and a mark on it is a mark on both.

**Alternative: mint a `TransformedBy`-style atom on the revision naming the
skill pins.** It is the right end state and it is what makes "the revised
source carries where it came from" true in the space rather than only in
the harness's artifacts. It needs the content-addressing question above
answered first — most likely by marking the *revision* rather than the
closure, since the revision is per-piece and per-act. That is a runner
design, not a harness one.

## 5. One primitive, two uses

CT-2299 and this issue are the same mechanism with two resolution paths,
and the shape to copy is one the harness already has.

`run_skill_script` runs a registry skill's script and an acquired skill's
through identical machinery. Which of the two is asked is decided by the
form of the name alone — a pin is an acquired skill's whole name, and a
registry name can never be one
([`run-skill-script.ts:955-987`](../../packages/cf-harness/src/tools/run-skill-script.ts#L955-L987)).
One tool, one execution path, one digest rule; the fork is resolution and
nothing else.

The retained-source primitive is the same. There is one host-side retained
source per editing target, one edit format, one applier, one compiler, one
diagnostic renderer. What differs is where the retained text came from:

| | CT-2299 | this issue |
| --- | --- | --- |
| retained source | what this run's last `run_pattern` compiled | what the piece's current revision holds |
| resolution | the run's own sidecar ([`prompt-loop.ts:3381`](../../packages/cf-harness/src/prompt-loop.ts#L3381)) | `readPieceSourceState` ([`piece-origin.ts:577`](../../packages/piece/src/ops/piece-origin.ts#L577)) |
| what applying it does | compile and run, producing a new piece | compile and `setPattern`, revising an existing one |
| author | this run's model | whoever authored that revision |
| what reading it mints | nothing — the child wrote it | the piece's labels, on the reading child's ceiling |

The last two rows are where question 2 lives, and both are properties of
the *resolution*, not of the primitive: the retained text is the same kind
of thing either way, and only the act of resolving it carries a label.
That is the test this design should be held to — if the edit applier ever
needs to know which fork it is serving, the fork has been drawn in the
wrong place.

Two consequences worth stating, because they are what "not a third way of
writing source" means concretely. The edit format is chosen once, and
whichever of CT-2299 and this lands first chooses it for both. And there is
no third writer of pattern source in the harness: `revise_piece` does not
compile-and-run its own way, it produces a program the same applier
produces and hands it to the piece controller.

## 6. Session-scoped results

**Recommendation: leave it to CT-2319. This design neither fixes it nor
depends on it.**

A piece whose values come from session-scoped queries renders blank in any
session but the one that ran them — `cf piece render` returns the full
shell with every count and list empty, because a render is a different
session (CT-2189, recorded on every run in the series). It is listed under
CT-2319 as needing an issue when picked up.

It is not this design's to change, for a reason worth being precise about:
session scoping is what makes a query legal under a confidentiality ceiling
in the first place — a space-scoped query is refused under a ceiling rather
than read
([`run-pattern.ts:343`](../../packages/cf-harness/src/tools/run-pattern.ts#L343)).
Whatever fixes the blank render has to answer for that, and the answer is
not a property of how a revision is applied.

**What this design owes it** is honesty in the demo. A revision to the
bills piece re-runs its queries in the revising session, so the proof that
the revision worked is read from the store or from that session, not from a
pane opened afterwards. Cut 3's acceptance says so explicitly rather than
letting a blank pane read as a failure of the revision.

**Alternative: make `revise_piece` re-run the piece's queries in the
viewer's session on open.** That is the CT-2319 fix wearing this issue's
clothes, and building it here would put the fix in the revision path, where
it would not help a piece nobody revised.

## 7. Sequence of cuts

Each is small, and each ends at something provable from the pill against
the bills piece on Ben's instance. The ruling on question 2 has settled the
posture, so the order now opens with the invariant that posture rests on:
the parent-never-sees-source property is worth having a failing test for
before there is a tool that could break it.

**Cut 1 — the revising profile and its invariant.** A `revise` subagent
profile, built the way `pattern-author` is: its own tool surface, its own
return schema with no string field a program could ride in, and
`returnContractAuthority: "profile"` so a delegation cannot widen it
([`subagent.ts:509`](../../packages/cf-harness/src/contracts/subagent.ts#L509)).
No new tool on it yet. *Proves:* the three tests of question 2's invariant
— surface, channel, and the validation-failure seam — with source planted
in each and the parent's view asserted to hold none of it. *Ends at:* three
tests that fail on the current code if the profile is removed, and a
recorded answer on whether a validation message can quote the value.

**Cut 2 — the piece handle.** `describe_handle` says `piece: true`, the
piece's name, `sourceRevisionId`, the revision list and the origin kind,
when the referent is a piece root. Loom names the handle after the piece
rather than `pattern_N`. No writing, and nothing reads source. *Proves,
from the pill:* "what is in my bills piece and when did it last change" is
answered by a parent that holds only a handle. *Ends at:* the demo run
showing the session naming the piece and its revision id without any
context in the run having read a line of source.

**Cut 3 — `read_piece_source` on the revising child.** The labeled read:
authored files, the piece's live labels, the authored-source integrity
statement, the revision id, recorded in the artifact as its own event.
Still no writing. *Proves:* a child that has read a labeled piece's source
is measured against that piece's atoms at its next boundary, and the parent
that delegated to it holds nothing but the handle — the same shape CT-2189
run 7's withheld release already shows for data. *Ends at:* the run
artifact showing the read event, the child's raised ceiling, and the
parent's transcript containing no source.

**Cut 4 — `revise_piece`, whole-source form.** The tool on the revising
child's surface, taking `sourceText`, with `checkPattern` then
`setPattern`, the rehearsal-trigger refusal, the receipt, and the
`piece-revision` sidecar. `expectedRevisionId` optional. *Proves, from the
pill:* the bills piece's classifier rules change, the piece's data
survives, the receipt names a new revision, and the Weaver's piece menu
offers the previous one as **Use this version** — the whole of CT-2332's
proof line, undo included. *Ends at:* the demo run, plus the sidecar read
back from the Console.

**Cut 5 — the retained-source edit form.** CT-2299's primitive, with both
resolution paths from question 5 at once. `revise_piece` takes `edits`;
`run_pattern` takes them against the run's own sidecar. *Proves:* attempt
N+1 costs in proportion to its change rather than to the program — the
falsifier CT-2299 already names — measured on both a fresh authoring run
and a revision run. *Ends at:* the two token-per-attempt curves.

**Cut 6 — `expectedRevisionId` required.** Once the demo has shown the
child reliably carries it. *Proves:* two sessions revising one piece, where
the second is refused by name rather than writing over the first.

**The measurement, which is no longer a cut.** Question 2's "with source
versus blind" comparison is now a question about whether to keep the blind
form as a per-profile option, not about which posture to ship. It runs
against cut 4 — same piece, same request, revising child with and without
`read_piece_source`, attempts to first `ok`, and whether the blind arm can
express the change at all — and its result is an option, not a gate.

Cuts 4 and 5 are independent of each other once cut 3 lands, and cut 5 is
CT-2299's issue rather than this one's — which is the point of question 5.

## Open for the ruling

Question 2 is ruled (Ben, 2026-09-15): the revising child reads, the parent
never does. What remains:

1. Question 1's last paragraph: does the piece's own name cross into the
   parent, or only its handle name. The child reading the source will see
   far more than the name, so this is a question about the parent's view
   alone.
2. Question 4's alternative: is recording the skill pins in the harness
   artifact enough for now, or does the revision need a mark in the space.
3. Whether the revising child is a profile of its own or the existing
   `pattern-author` profile extended. A separate profile keeps a child that
   only authors from carrying the ceiling that reading a piece mints, which
   is why cut 1 assumes one; reusing `pattern-author` is less machinery and
   one fewer contract to keep in agreement.
