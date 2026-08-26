# Bulk piece operations

*What is this, and why is it shaped this way?* A tour of surveying, repairing
and retargeting a collection of deployed pieces, walked act by act against a
board of 113 members. It assumes you can deploy a piece and call a verb; it
assumes nothing about the bulk surface.

## What this is for

A pattern ships, and the pieces already running it do not change. Their stored
documents were written by an older version of the source, against an older
shape, and nothing about a new deployment reaches back to them. So the work is
not "deploy the fix" but "carry every existing piece to it" — a hundred
documents to rewrite, or a hundred pieces to move onto a new source, one at a
time, without losing track of which ones were done.

The failures worth building against are the ones that leave no trace. A fixer
that throws, an answer the store cannot hold, a source that resolves to
something other than the identity a row recorded — those announce themselves,
and the surface names the row and stops. These four announce nothing on their
own. A run stops halfway and nobody knows where. A piece is missed because the
enumeration that found the others never held it. A write lands on a document
that changed since it was read. An apply exits zero and the caller believes it.
What they have in common is the ending they reach when nothing is built to stop
them: a caller who thinks the work is done, and a collection that says otherwise
weeks later, with nothing written down that would have said which pieces.

The surface is shaped around making that silent class loud, and three ideas
carry the whole of it.

### Three ideas, and then the commands make sense

**The plan is the unit of work, not the command line.** A survey emits a
line-oriented JSON file: a header accounting for the selection, then one row per
piece, in the order a run must work through them. Each row records the identity
that piece runs today and whether that source is still retained in the space —
the rollback question. A row carries no operation unless a stage put one there:
a survey's rows are a pre-state record until it is asked to stamp a retarget, or
until a repair's dry run emits rows of its own. The plan is what a later stage
consumes, so what was decided is written down before anything is written to.

**Dry is the default, and what an apply proves is per operation.** Neither write
stage writes without `--apply`, and what the dry run reports differs: a repair
prints the exact per-piece document diff, a retarget prints where each piece
stands against its own row's reference pair.

The precondition differs too, and the difference decides what happens when
something else is writing at the same time.

A repair row's precondition is the hash of the document its dry run read, and
the write is what proves it: the check runs inside the edit closure, which
re-runs against fresh state on a commit conflict, so a document that moved fails
its own row rather than being overwritten.

A retarget row's precondition is the reference pair it records, and the write
does not prove it. A row runs as a sequence — read the piece's current
reference, classify it against the pair, resolve the row's source from disk,
recompute the identity that source produces, then call `setPattern`, which loads
the current reference for itself and holds its own commit to that and never to
the pair the row recorded. The classification is a read taken some way before
the write, not a condition on it.

What the classification catches is a piece standing on neither of the row's two
references. At the preflight that reads every row before the first write, such a
piece keeps the run from starting at all; in a row's own read it stops the run
there, and every piece after it is named unattempted. What it does not catch has
two shapes, and a reader should assume neither is caught. A piece that something
else moved onto the row's own target classifies as landed — the same verdict a
resume produces — so the run leaves it alone and reports nothing unusual about
it. And a piece moved during the sequence above is carried to the row's target
from wherever it had been taken, because the row's pair is never consulted
again. A retarget plan is a record of what a run intended and a check on what it
finds, not an interlock against a second writer working the same pieces.

**The verdict is a second look, never the apply's exit code.** An apply that
exits zero says the writes it attempted returned success, which is not the same
question as whether the collection now holds what you wanted. For a retarget the
second look is a survey, held against the plan the run was made from, and the
two stay separate invocations on purpose. For a repair it is the fixer: a
reference diff is refused outright for a plan carrying repair rows, because a
repair moves the document and not the reference, so a diff would answer
`unchanged` about work it cannot see. Re-running the fixer is what verifies a
repair, and a document it no longer changes is a repaired one.

## The session, act by act

The demo deploys a board, files 113 members through its verb, and works the
collection from there. `$SPACE` is a throwaway space and `$WORK` a scratch
directory the session writes its plans into. `$RETARGET_FIXTURE` is a pattern
source in this repository, `board` is the slug the holder was deployed under,
and `fix-titles.ts` is a file Act 7 writes.

### Acts 1–2 · A collection the registry cannot enumerate

The board holds its members in its own `items` collection. `cf piece ls` reads
the space's piece registry, which is a different set — a handler-created piece
appears there only if something sent it to `addPiece`. So the enumeration the
bulk stages need is the holder's own, and reaching it means asking the holder.

### Act 3 · The survey

```bash
cf piece survey -s "$SPACE" --piece board --path items --out "$WORK/plan.jsonl"
```

One process, the whole collection: a plan row per member, the holder last, and a
tally that answers *do these pieces all agree?* without a reader having to walk
every row.

The header accounts for the selection — what was asked for, and how many pieces
that turned out to be. Each member row records the identity the piece runs today
and whether that source is retained in the space. That second field is the
rollback question, and the survey answers it before any write is planned rather
than after one has failed.

### Act 4 · One piece's pin, without running it

```bash
cf piece inspect -s "$SPACE" --piece board --pattern-identity
```

The same identity fact the survey reads per member, as a single lookup: no piece
started, no input or result pulled. This is what makes a board-sized survey one
cheap read per member rather than one execution per member.

### Acts 5–6 · A plan that carries the operation, from a live read

A survey can carry the work as well as the record. A retarget stamps an `op`
onto the rows whose phase matches it, and pins that op to the identity the
on-disk source produces — not to a path, which could drift between the plan and
the apply. A row is exempt when its piece already stands on the reference the op
names: there is nothing to do for that piece, and a row claiming otherwise could
not be verified afterward, landed and never-ran reading alike.

```bash
cf piece survey -s "$SPACE" --piece board --path items \
  --retarget "items=$RETARGET_FIXTURE@v2" --main-export Member \
  --out "$WORK/retarget.jsonl"
```

A row that carries an op carries both halves: `expect` is where the piece
stands, `op` is where this plan will take it.

The survey is a live read, so filing one more member and surveying again moves
the count. There is no cache to invalidate and nothing to refresh.

### Act 7 · A repair, where the fixer is the work

A **fixer** is a TypeScript module whose default export is a pure transform from
a piece's stored input document to the document it should hold. That is the
whole of what a caller writes. Selection, ordering, the write, the stop and the
resume belong to the tooling.

Purity is checked rather than assumed: the run evaluates the fixer twice over
one document and refuses it by name if the two answers differ. Four more
answers are refused the same way, before anything is written: one that is not a
document, one holding a value the store cannot keep, one that drops a field the
write would then zero — the write replaces the document whole — and one that
rewrote or dropped a link.

```bash
cf piece repair -s "$SPACE" --piece board --path items \
  --fixer "$WORK/fix-titles.ts" --out "$WORK/repair.jsonl"
```

Dry: the exact per-piece diff, and no write at all. The plan it emits holds one
row per member — a repair works the members and not the holder — and a row whose
document the fixer could evaluate records the hash that verdict was computed
from, the precondition the apply will prove, beside the fixer it was evaluated
for.

```bash
cf piece repair -s "$SPACE" --piece board --path items \
  --fixer "$WORK/fix-titles.ts" --plan "$WORK/repair.jsonl" --apply \
  --out "$WORK/applied.jsonl"
```

The plan drives the apply: its rows, in its order, each checked against its
recorded hash in the same transaction that writes it.

**Resume is the same command again.** A repaired document is one the fixer no
longer changes, so a completed plan re-runs as landed and writes nothing. That
property is what makes a run that stopped partway safe to simply re-issue: there
is no separate resume mode to get wrong, and no bookkeeping the caller has to
keep.

### Act 8 · The retarget, applied over grouped sessions

Where a repair rewrites documents, a retarget moves pieces onto a new source.
The plan is the whole input — it names the pieces, the reference each must still
be on, and the source each moves to — so the command carries no selection of its
own.

```bash
cf piece retarget -s "$SPACE" --plan "$WORK/retarget.jsonl" \
  --out "$WORK/dry.json"
```

Dry again: every row that carries an op classified against its own reference
pair, and nothing written. A row without one is not work — the holder's row is
the usual case — so the report leaves it out rather than reporting a verdict
about a piece this run will not touch.

```bash
cf piece retarget -s "$SPACE" --plan "$WORK/retarget.jsonl" \
  --group-size 25 --apply --out "$WORK/applied.json"
```

Sessions are grouped rather than opened per piece or held open for the whole
run. The warm-up amortizes across a group while the pieces live at once stay
bounded by it, and a group boundary is a resume point. Every row an apply
session worked on carries what it cost, because a run whose cost per piece is
unknown cannot be improved.

Re-invoking is the resume, on the same principle the repair uses: a piece
already on its row's target reads as landed and is not rewritten.

### Act 9 · The verification is a second survey

```bash
cf piece survey -s "$SPACE" --piece board --path items \
  --diff "$WORK/retarget.jsonl"
```

A row that carried an op lands in one of three outcomes — moved as planned,
still outstanding, or moved to something the plan did not ask for — and the
third is what an upgrade that half-converged looks like. A row the plan recorded
without one is not measured against a target it never had: it reads as unchanged
or as changed, the holder's row among them. A row whose piece the after-survey
no longer holds reads as gone from the selection. The command exits nonzero
unless every row is landed or unchanged, which is what "converged" means here.

A member filed after the plan was taken is none of those. It is named as held by
the space and not by the plan, rather than counted as though the plan had asked
for it.

### Act 10 · The refusal the survey exists to make

A silent subset is the failure bulk operations die of: a run reports success
over the pieces it knew about, and the ones it never enumerated stay behind at
the old shape with nothing recording that they were missed.

So when the registry knows a piece on an in-scope identity that the collection
does not hold, the survey names it and exits nonzero. The plan is still emitted
— to `--out`, or to stdout — because what was read is worth keeping; what it is
not is consumable. Its header carries the pieces the survey could not account
for, encoding and decoding preserve them, and every write stage refuses a plan
whose header names any. The incompleteness therefore rides the artifact rather
than the exit code: a plan that reached a write stage by another route, or was
kept and supplied later, refuses there just the same.

### Act 11 · A list survey claims only what it read

```bash
cf piece survey -s "$SPACE" --list board --out "$WORK/list.jsonl"
```

Naming pieces directly skips the containment check — and says so. The header
records the selector, so a reader of the plan knows no containment claim was
made. The orphan is still out there; this survey simply never claimed otherwise.

## How the story is kept honest

Every command above is one `packages/cli/integration/bulk-ops-demo.sh` runs.
The demo narrates each act and then executes it, and each act re-parses its own
displayed line and compares the words against the argv that ran — so a line a
reader retypes is the line that executed, checked rather than asserted.
`deno task check-verb-session-sync` holds this document to that script: a `cf`
line here either quotes a command the demo runs or carries a `# not in the demo`
comment saying why it cannot.

`packages/cli/integration/bulk-survey-drill.sh` asserts the same surface as
pass/fail in CI, which is what keeps the demo from drifting into a transcript
nobody runs.

## Running it yourself

```bash
API_URL=http://localhost:8000 packages/cli/integration/bulk-ops-demo.sh
```

The transcript is the artifact. Acts the mechanism does not yet cover appear at
the end marked pending, so what the surface will grow stays visible beside what
it does today.

## Where to read further

- [`docs/plans/piece-bulk-operations.md`](../../plans/piece-bulk-operations.md)
  — the design: what each stage owes, and what the later ones wait on
- [`packages/cli/README.md`](../../../packages/cli/README.md) — the reference
  for `survey`, `repair` and `retarget`, and the reference forms their
  selections take
- [The Verb Session](../verbs/the-verb-session.md) — the tour of the surface a
  collection is built through in the first place
