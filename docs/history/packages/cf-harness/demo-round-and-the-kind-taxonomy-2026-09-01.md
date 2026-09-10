---
status: historical
created: 2026-09-01
archived: 2026-09-01
reason: "Executed demo round on the post-collapse build, and the kind-classifier finding that a parameterized whole is invisible to the by-id reuse path."
---

# The demo round, and why a configurable application stops being reusable

This record covers the 2026-09-01 demo round, run after the Round-4
measurement and on a later build. It is a separate record rather than an
addition to
[the Round-4 record](round4-prompt-and-channel-2026-09-01.md), because the
build, the suite and the question all changed; that document stands as the
account of its own measurement.

Five demo phrases ran through the console, a sixth pattern was published
through the command line because the console cannot publish discoverably, and
an encore phrase was run against the corpus that publication created. The
console ran at `f5d4398aac` and the fabric server at `180d006f87`, with both
diagnostic collapses and the doc caps live. A cell-spec pre-flight enforced
the parent prompt by hash on both batches.

## What each finding changes

### A parameterized whole is invisible to the by-id reuse path

This is the round's finding, and it is a design question rather than a defect.

The published index classifies an entry by its `argumentSchema`: an object
schema makes it a `part`, an absent or `false` schema makes it an `app`. That
is a statement about whether the entry takes arguments. The console's parent
prompt reads `kind` as something else — a statement about whether the entry
answers the request whole — and routes on it: an `app` is run by
`patternId`, a `part` is attached to a delegation and wired by a child.

For an unparameterized application the two questions have the same answer,
which is why reuse worked in the Round-4 measurement: six `app` entries, six
by-id runs, no source authored. They come apart exactly when an entry is a
finished application that also takes arguments.

The encore is that case, observed end to end. A poll application whose
question and options are configurable was published to the corpus, and a later
session was asked in natural words for a board-game poll. The parent searched,
the new entry came back as the top hit at four of six matched terms, and
because the entry carries an object argument schema the endpoint called it a
`part`. The whole-answer branch never applied. The parent did the correct
thing for a part — attached it with a note and delegated — and the child wrote
a poll from scratch.

**The parameterization that makes an entry reusable is what excludes it from
the reuse path.** The corpus is being gardened toward parameterized atoms, and
every step in that direction shrinks what the by-id branch can answer.

Two directions follow, neither measured here: give the endpoint a
classification that answers the policy's question — whether an entry stands
alone — separately from whether it takes arguments; or teach the policy to
read shapes rather than `kind`, so that an entry whose arguments are all
optional answers whole whatever its schema shape. Both are testable against
the committed suites, since the corpus now holds a live instance of the case.

### The classifier is only the first half of the miss

The same encore shows the limit of fixing it. Read from the artifacts, the
parent attached the entry as a `patternRef`, and the child received the
generated block complete — exact description, import hint, argument shape and
result shape, no refusal. It then ran two patterns from source, imported
nothing, and composed nothing.

So correcting the classifier would have changed the parent's routing and
nothing else that was observed. The child held everything it needed to import
an entry that did exactly the requested job, and rebuilt it. That is the same
behaviour the Round-4 measurement recorded for one composition task, and which
appeared twice more in a cell run earlier the same day.

### The demo phrases got leaner, and stopped composing entirely

The five-phrase batch against the Round-4 demo cell:

| | Round 4 | this round |
| --- | ---: | ---: |
| `run_pattern` | 28 | **16** |
| ok | 5 | **7** |
| compile errors | 23 | **9** |
| ok share of attempts | 18% | **44%** |
| composing | 0 | 0 |

Every phrase completed and every piece was browser-verified as working.

The budget defect recorded in the Round-4 measurement did not recur, and the
pair is worth keeping. Two budget pieces were authored independently from
near-identical phrases: the Round-4 one rendered a committed total as
`$NaN.undefined` when an amount was left uncommitted, and this one rejected an
add that lacked a required date without changing state, then recomputed all
four summary metrics cleanly once the date was supplied. Same request, same
prompt, one piece with a coercion bug and one without. **The defect was a
property of an authoring run, not of the phrase** — which is what a measure
that reports `ok` for both cannot see.

Composition remained at zero across all five phrases. One parent attached a
reference; four attached none; no entry was run by id. The budget phrase is
the sharpest case: its parent searched three times and saw both a cents-ledger
`part` whose description is "sums them in integer cents, and shows the
formatted running total" and a `proven` expense-tracker `app`, attached
neither, and its child authored four patterns from source. Two rounds running,
the one task whose arithmetic a published part exists to perform has rebuilt
that arithmetic instead.

### Turn cost after a failure keeps falling, and is not yet at the floor

Measured on `responseCompleteDurationMs`, the field that times generation
rather than response start:

| Build | clean turn | post-failure turn | ratio |
| --- | ---: | ---: | ---: |
| earlier the same day | 35.6s (n=13) | 54.5s (n=19) | 1.53× |
| this round | 39.9s (n=25) | 46.6s (n=13) | **1.17×** |

The `ok` rate held and improved across the same interval, and the
two-prior-failure bucket sits below the clean mean, on four samples. The
penalty is close to parity and within noise at this size, but this batch
produced only five child failures, so the post-failure arm rests on thirteen
samples across three buckets. The direction is consistent across three builds;
one cell with a fuller failure arm would settle whether the effect is gone.

Children still spend 96-98% of wall clock in model turns.

### The console lags the command line, for the third time

The batch's loop-closure leg could not run: every entry a console session
publishes lands non-discoverable, because the flag that publishes discoverably
is command-line only. The publication that the encore then searched had to be
made through the CLI.

This is the third instance in this programme of a capability the CLI has and
the console does not, after skill acquisition and the subagent-profile policy.
Each was found by a measurement that assumed the console could do what the
command line can.

## Disclosed deviations

The published poll was authored from a task text that added "make the question
and options configurable" to the Round-4 poll phrase. That is demo
engineering rather than a measurement phrase, and it is what made the
published entry parameterized — which is to say, the finding above rests on an
entry created by a deliberately altered prompt. The encore phrase itself was
natural and named neither the index nor any pattern.

## What this round does not establish

The hypothesis that reading documentation competes with composing — raised by
a cell earlier the same day in which every child that read documentation
composed nothing and every child that read none composed everything — cannot
be tested here. Four of five children read documentation and composed nothing;
the fifth read none and also composed nothing. With no variance in the
outcome, this round is not a second observation of that alignment.

No console commit appears in any artifact. This was already recorded as a gap
and is now load-bearing, since the console and the fabric server ran at
different commits for the first time.

`ok` still means a pattern compiled and matched its schema. The five demo
pieces were browser-verified by hand; nothing else in this record was.
