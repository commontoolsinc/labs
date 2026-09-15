# Revising a piece's source from an agent session

A person points at a piece they already have and says what should be
different. The session reads the piece's cells, schema and data through
handles, reads or edits its source deliberately, and the piece updates in
place: data intact, a revision that is visible and reversible.

This plan is the design for the cf-harness surface that does that, for a
ruling before any of it is built. Seven questions, each with a
recommendation, the alternative it was chosen over, and what that choice
costs. It is a plan, not a spec: the design of record for the lifecycle it
sits on is [`../specs/piece-source-lifecycle.md`](../specs/piece-source-lifecycle.md),
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

What is missing is narrow: nothing tells the session that a handle names a
**piece** rather than a cell, nothing lets a session read a piece's source
under a label, and no tool applies a revision.

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
where the rest goes. The revision list is ids, times and an eight-value
operation enum — a channel with no author-chosen text in it at all, which
is what lets undo be discussed in a session that never reads a line of the
program.

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

This is the load-bearing question, and it is a choice between two costs
that fall on different people.

**Recommendation: the harness holds the source; the session edits it
blind, against diagnostics. Program text does not enter model context.**

The mechanism is CT-2299's. At the point the session takes a piece handle
into a revision, the harness reads the piece's current authored files with
`readPieceSourceState` and **retains** them host-side, exactly as
`#persistRunPatternSource` already retains the source of a `run_pattern`
call beside its output
([`prompt-loop.ts:3381`](../../packages/cf-harness/src/prompt-loop.ts#L3381)).
The session then expresses its change as edits against that retained text —
search/replace or hunks — which the harness applies host-side and compiles.
Compile diagnostics quote lines by number against the retained text and
come back model-facing, as `run_pattern`'s authored-source diagnostics do
today. Source never returns.

Two things make this the recommendation rather than a tie.

The retention justification does not survive the change of author. The
sidecar's own reason for keeping source without a label is that "the source
is the model's own writing, so nothing crosses a boundary by being kept"
([`prompt-loop.ts:3374-3379`](../../packages/cf-harness/src/prompt-loop.ts#L3374-L3379)).
An existing piece's source was written by someone else, possibly in another
session under other labels. Reading it into the model is the first time
this system would move program text **across an authorship boundary into a
model context**, and CT-2199's ruling names exactly that as the trigger for
picking the labeling work up. A design that never does it does not need
CT-2199 built first.

And the harness already has this shape and it is the one it trusts. The
indexed-source arm of `run_pattern` compiles source the model did not
author and withholds the diagnostic, in those words —
"the diagnostic is retained in the run artifact and withheld here, since it
quotes source you did not author"
([`run-pattern.ts:1207`](../../packages/cf-harness/src/tools/run-pattern.ts#L1207)).
The recommendation is that same posture, one notch less severe: the
diagnostic comes back, because a diagnostic against text the harness holds
can quote line numbers without quoting the line.

### What the author loses, measured

An agent that cannot read the source must locate its edit from
`describe_handle`'s schema, the person's words, and compile diagnostics
alone. On a search/replace edit form, a failed anchor is one more attempt.
The relevant number is the series' attempt-to-success ratio on the bills
task, where the agent **wrote** the source and still could not land it:

| | run 3 | run 4 | run 5 | run 6 | run 7 |
| --- | --- | --- | --- | --- | --- |
| `run_pattern` attempts | 4 | 5 | 4 | 8 | 5 |
| reaching `ok` | 1 | 2 | 1 | 1 | 1 |

(CT-2189 runs 3–7.) One in four to one in eight, with the whole program in
context. The honest reading is that reading the program is evidently not
what makes an attempt succeed here: every one of run 7's four failures was
a compile error against source the model had just written and could see in
full. What blind editing adds on top of that is anchor misses, and those
are cheap in a way compile errors are not — an anchor that does not match
is a host-side answer with no compile, no wave and no tokens beyond the
diagnostic. What it adds that is *not* cheap is the case where the person's
request needs a judgment about code the agent cannot see ("make the
matching stricter"), which becomes a schema-and-diagnostics guess.

**The falsifier, and it should be run before this is built out.** Take the
bills piece on Ben's instance and one real revision request. Run it twice:
once with the source read into context, once blind against the retained
text. Compare attempts to first `ok`. If blind editing costs more than
roughly one extra attempt, that is the number this ruling should be made
on, and it is cut 1 below.

**Alternative: a `read_piece_source` tool whose output is a labeled
value.** Source comes back to the model, carrying the piece's labels and
an integrity mark recording whether it was operator-provisioned or
model-authored, and the run records the read. What the author gains is
real: they can see the code they are changing, which is what every human
editing workflow assumes, and the "make the matching stricter" class of
request becomes ordinary work.

What it costs is that CT-2199 stops being recorded-and-parked and becomes a
prerequisite. Labeling the source is not the hard part — the hard part is
that once labeled source is in model context, every downstream boundary
that does not consult that label becomes a leak that this feature created:
the transcript, the collapse summaries, child returns, the Console
timeline, index publication. CT-2199's memo maps all of them and Ben's
ruling on it is posture C staged as B — redact diagnostics now, label and
gate later — which is a sequencing this feature would invert. It also
re-opens a question the piece-handle disclosure closes by construction: a
piece the person can select is not necessarily a piece whose source they
authored.

**If Ben rules for the alternative**, the smallest honest version is:
`read_piece_source` returns source only for a piece whose current revision
the *same principal* authored, refuses otherwise with a named code, and
records the read in the run artifact. That confines the new exposure to
"your own code, read back to you", which is the demo's case, and leaves
the cross-author case for CT-2199 to open.

## 3. The revision tool

**Recommendation: one tool, `revise_piece`.** The name is the spec's:
its transition table calls this row "Directly edit or wish an existing
piece to change", appending a **direct-edit** revision
([`piece-source-lifecycle.md`, "Source transitions"](../specs/piece-source-lifecycle.md#source-transitions)),
and `edit` is the operation the runner records
([`runner.ts:1190`](../../packages/runner/src/runner.ts#L1190)). Not
`update_pattern`: a pattern is not what is being updated, and the word is
already taken by `origin-update`, a different row of that same table.

**Inputs.**

- `piece` — a handle token, from question 1.
- `edits` — edits against the retained source (question 2), or `sourceText`
  for a whole-program replacement. Exactly one, the way `run_pattern`
  already takes exactly one of `sourceText` and `patternId`
  ([`run-pattern.ts:987`](../../packages/cf-harness/src/tools/run-pattern.ts#L987)).
- `description` — what this revision changes, in the person's terms.
- `expectedRevisionId` — the revision this change was written against,
  from `describe_handle`. Optional for the first cut, required later.

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

The last row is the whole of why question 2 is decided the way it is, and
it is a property of the *resolution*, not of the primitive. That is the
test this design should be held to: if the edit applier ever needs to know
which fork it is serving, the fork has been drawn in the wrong place.

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

Each is small, each ends at something provable from the pill against the
bills piece on Ben's instance, and cut 1 is a measurement rather than a
feature because question 2's ruling should rest on a number.

**Cut 1 — measure the cost of blind editing.** No harness change. Take the
bills piece and one real revision request; run it twice, once with the
source in context and once blind against retained text, and count attempts
to first `ok`. *Proves:* what question 2's recommendation costs the author,
against the run 3–7 baseline above. *Ends at:* a number in a comment on
CT-2332, and Ben's ruling on question 2.

**Cut 2 — the piece handle.** `describe_handle` says `piece: true`, the
piece's name, `sourceRevisionId`, the revision list and the origin kind,
when the referent is a piece root. Loom names the handle after the piece
rather than `pattern_N`. No writing. *Proves, from the pill:* "what is in
my bills piece and when did it last change" is answered by a session that
holds only a handle. *Ends at:* the demo run showing the session naming the
piece and its revision id without reading a line of source.

**Cut 3 — `revise_piece`, whole-source form.** The tool, taking
`sourceText`, with `checkPattern` then `setPattern`, the rehearsal-trigger
refusal, the receipt, and the `piece-revision` sidecar.
`expectedRevisionId` optional. *Proves, from the pill:* the bills piece's
classifier rules change, the piece's data survives, the receipt names a new
revision, and the Weaver's piece menu offers the previous one as **Use this
version** — which is the whole of CT-2332's proof line, undo included.
*Ends at:* the demo run, plus the sidecar read back from the Console.

**Cut 4 — the retained-source edit form.** CT-2299's primitive, with both
resolution paths from question 5 at once. `revise_piece` takes `edits`;
`run_pattern` takes them against the run's own sidecar. *Proves:* attempt
N+1 costs in proportion to its change rather than to the program — the
falsifier CT-2299 already names — measured on both a fresh authoring run
and a revision run. *Ends at:* the two token-per-attempt curves.

**Cut 5 — `expectedRevisionId` required.** Once the demo has shown the
session reliably carries it. *Proves:* two sessions revising one piece,
where the second is refused by name rather than writing over the first.

Cuts 3 and 4 are independent of each other once cut 2 lands, and cut 4 is
CT-2299's issue rather than this one's — which is the point of question 5.

## Open for the ruling

1. Question 2, on the measured cost from cut 1: blind editing, or
   `read_piece_source` with CT-2199 as a prerequisite.
2. Question 1's last paragraph: does the piece's own name cross into the
   session, or only its handle name.
3. Question 4's alternative: is recording the skill pins in the harness
   artifact enough for now, or does the revision need a mark in the space.
