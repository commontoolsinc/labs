# Test selection

How to use the machinery that decides what a change's tests are worth
running, and how to answer the question it provokes most often, which is
"why did my test not run?". [The spec](../specs/test-selection.md) is the
normative description of the contract;
[the plan](../plans/pull-request-test-selection.md) carries the reasoning
and the parts still to be built.

Everything a person types goes through one entry point:

```
deno task test-selection <mode>
```

## The modes

### `explain <identity>`

What one test is worth, and what selection would do with it. The argument
is the canonical identity key, three parts or four when the test ran in a
non-default configuration:

```
deno task test-selection explain '["unit","memory","space > writes a fact"]'
deno task test-selection explain '["integration","patterns","counter.test.ts","server-execution"]'
```

It prints the suite and the invocation unit the identity belongs to, its
score and its cost, the catches behind that score with how many were on
the default branch and across how many distinct sources, when the most
recent one was, its churn and flake rate, and whether it is withheld and
why. An identity the store has never seen is reported as mandatory, which
is what an identity with no history is.

The identity resolves through `tasks/test-identity-aliases.jsonl` first,
so asking about a renamed test under either name finds the joined history.

### `dials`

Every number selection can be tuned by, with the unit its value counts,
whether somebody chose it or the publisher measures it, and which way you
would move it. `tasks/test-selection/policy.ts` is where they live and the
only place any of them lives.

The units are worth reading. Several dials are bare fractions that do not
mean the same thing — a share of a test's score and a share of a run's
budget read identically — and naming the unit is what keeps them from
being compared to each other.

A **measured** dial is not yours to edit. The publisher overwrites it from
the lanes' own timing records, and the number in the file is only the seed
used before anything has been measured. `setupCost` per capability, and
the overhead and correction per suite, are measured too, and are not in
`policy.ts` at all: they are published in each manifest, which is where to
read them.

### `coverage`

Every workspace member, whether it carries the per-package coverage gate,
the reason beside it when it does not, and the baseline the newest
manifest holds for it. This is what answers "why is my package not gated?"
and "what am I being compared against?".

### `plan --dry-run [--lane N]`

What would run, and what it would cost: how many identities this tree
holds, how many are withheld, and per lane the number of tests, the
projected seconds against the budget, the capabilities it would open, and
a count by why each test was chosen. Given a lane number it answers "what
would lane three do?", and given none it prints all of them.

The count is of this tree rather than of the manifest, because those are
different numbers and the plan beneath it is over the first. A manifest is
hours old, so it names units the tree has since dropped and misses units
the tree has since gained; the reconciliation of the two is what gets
packed, and it is what is counted here.

`--verify` compares the identity set the topology produces against what a
recorded run actually executed, in both directions: identities a run
produced that no suite claims, and units the topology enumerates that the
run never recorded.

### How many lanes the run on the default branch uses

A change's tests are packed into a fixed number of lanes, `LANES`. The run
on the default branch cannot be, because how much work there is decides
how many lanes it needs and the job matrix has to exist before anything
starts. So one job asks:

```
deno run -A tasks/ci-lane.ts --full --lane-count
```

and it answers with an integer and nothing else. The lanes then read the
same tree against the same manifest and work out their own shares, the
way a change's lanes do, so nothing about which tests run travels through
a job output.

Run it yourself to see how many jobs the default branch would take. Where
nothing in the tree has a measured cost it answers from the shape of the
tree instead — the larger of the number of suites with anything to run
and what packing the stand-ins asks for — and says on the error stream
that it did so, since a projection from costs nobody has measured would
be arithmetic over an invented figure.

## The publisher

`.github/workflows/test-selection.yml` runs every four hours and on manual
dispatch. Four-hourly rather than daily because aggregation is incremental
and therefore cheap, and a flake that appears in the morning should not
wait until the small hours to be prioritized. Manual dispatch is there so
that somebody who has just fixed something can refresh without waiting.

Each run reads the newest aggregate, fetches only the objects whose runs
are not already folded into it, folds them, ages the counters, scores
everything, and creates one manifest object and one aggregate object. It
reads and folds two hundred objects at a time, so what it holds is bounded
by the number of tests rather than by the number of runs.

**Nothing gates on it.** When the publisher fails, the previous manifest is
still the newest one and consumers keep using it. A manifest going stale
degrades selection quality slowly rather than failing anything, which is
the right direction for a system nothing should gate on.

That is why a run that cannot read the aggregate a previous run left
refuses to publish rather than starting from nothing. The aggregate is
where a test's catches live, and they accumulate over unbounded history:
a run that lost it and carried on would publish a manifest scoring every
test at the floor, and because it succeeded that manifest would be the
one every lane obeys. A stale manifest is recoverable; a confident wrong
one is not.

A cold start cannot read the whole window in one job, and is asked for
deliberately: the bootstrap is a manual dispatch with the bootstrap input
set, run once, and an incremental run that finds no aggregate at all says
so and stops. After that the incremental path keeps up.

A bootstrap replaces the score history rather than extending it. It folds
into an empty aggregate, so the state object it creates holds what its
window shows and nothing earlier, and every later run reads that one. A
test's catches accumulate over unbounded history, so the ones counted
before the window stop counting, and a bootstrap over a narrow window
throws away more than one over a wide window does. Nothing in the store
is removed: the publisher's identity holds create and not delete or
overwrite, so the state object a previous run left stays where it is and
stops being the newest.

The two paths look back over different windows. An incremental run reads
two days. A bootstrap reads sixty. The dispatch carries a days input
naming a window of its own, and it applies in either mode, so a bootstrap
over a shorter stretch of history is a matter of giving it.

The bootstrap input does not decide whether a run reads a rollup. One
rule is asked of each source and date the window covers. A pair whose
rollup is already folded is closed. A pair nothing is folded from is
taken from its rollup, where a rollup covers it. Everything else is read
raw. Both modes apply that rule. Their answers differ because their
aggregates differ, rather than because the input names a second way to
choose.

A run reaching a pair nothing is folded from takes that day whole from
its rollup, which is a manifest and a few tens of shards against the
day's thousands of raw objects. The publisher reads four shards at a time
and writes each run's observations to a temporary file. It keeps an offset
and timestamp per run in memory. The fold replays that file in time order
for each evidence pass and the classification pass, holding one run's
observations at a time. Shards are assigned by a hash of the raw object's
name, so shard order does not describe when the runs happened. Same-commit
disagreement and environmental failures also require evidence from the
whole day before any failure is classified.

A busy day is about six million observations, so the temporary file for
one runs to a gigabyte or two. One day is live at a time, and its file is
removed before the next day is read.

Keeping those observations in memory rather than in a file would fit
today. Folding the largest day so far peaks a little over a gigabyte with
the file, and holding what it spooled would add an estimated gigabyte and
a half to two gigabytes, against a heap V8 caps near four gigabytes. That
estimate comes from the size of an observation rather than from a measured
run without the file. The file is what leaves room for the corpus to grow
into.

The temporary file is removed when the day finishes or the read fails.
A shard that cannot be read ends the publisher run without writing a
manifest or aggregate. The previous manifest stays newest. Completed
days are recorded, so no later run over a wide window folds their raw
objects on top and doubles every catch in them.

A rollup is written by the one principal here whose credential exists as
key material, so it carries weaker provenance than the raw records it
summarizes, and
[the record spec](../specs/test-records.md#trust-boundaries-for-consumers)
asks a consumer that feeds decisions to treat it as a cache of a day
rather than the record of it. Seeding catch counts from days closed a
week or more ago is that use. The four-hourly path in its steady state
reaches no day it could read one from: compaction leaves a partition open
for a week, and that path reads two days. So a rollup is read by a
bootstrap, and by a run catching up after an outage or over a window
somebody widened.

`deno task test-records-compact` is what writes rollups, and an operator
runs it from a workstation with a downloaded key — nothing federated runs
it, so there is no workflow ref to pin an identity to. A day nobody has
compacted is folded from its raw objects, which is what a bootstrap does
for every day until the compactor has reached one.

Publishing needs the workflow's own federated identity, which is pinned
to that workflow file on the default branch and is the only principal
that can create a manifest. A personal reporting key cannot: it is scoped
to its holder's own submissions folder. So a person runs `--dry-run
--out` and reads what a run would have produced.

To run it by hand against the store without creating anything:

```bash
deno run --allow-read --allow-env --allow-net --allow-write \
  tasks/test-selection-publish.ts --days 1 --dry-run --out /tmp/selection
```

That writes the manifest and the aggregate as plain JSON where you can
read them, and creates nothing in the store.

## What a run leaves out

A run's log names two kinds of identity that did not reach the manifest.
The first is the design working. The second is either a set of identities
whose next record will say enough, or a surface whose records never say
enough, and the run says which.

The first is the identities that measure a whole invocation:

```
test selection: 8 identities measure a whole invocation rather than one
unit, so they are left out. The steps inside the invocation are measured
separately, so nothing is missing and there is nothing to act on.
```

A script that records each of its steps also records its own run from end
to end, and the topology tells the two apart. The whole-invocation record
names no unit, so no lane can be asked to run it, and adding its time to
the time of the steps inside it would count that work twice. The count is
that separation working. It changes when a suite gains or loses such a
record, and there is nothing to do about it either way.

The second is the identities the topology has no unit for:

```
test selection: the topology has no unit for 3295 identities, so no lane
can be asked to run one. An identity is left out until one of its records
says enough to work out which unit it is in.
test selection: those 3295 were recorded by 12 surface(s): unit:utils 742,
unit:runtime-client 509, unit:ts-transformers 379,
unit:schema-generator 314, unit:js-compiler 153, and 7 more
```

A surface is the kind of check a record is, the workspace member that owns
it, and the configuration it ran under where that is not the default one.
It says which part of the tree the count is about. The worst five are
named and the rest are counted, so that reading the count does not mean
reproducing the publisher against the store by hand.

What decides an identity's unit is its own records. Where a suite's units
are files, the answer is the file on the record, and a record has one when
the report it came from could name one: the registration preload captures
which module registered each test and leaves that map beside the report,
and ingestion otherwise reads the file from the report's own class names,
which needs the working directory the test process ran in. A report that
supplies neither has no file on any of its records, and neither does a
name that two files in one report both report. Where a suite's units are
not files — a dispatch arm, a pattern key — the answer is the recorded
name instead, and a name no suite recognizes leaves the identity without a
unit the same way. An identity that matches two suites is left out as
well, which is a topology defect the drift guard fails on separately. What
is not in the count is the lane measuring its own setup and its own
batches. Those records travel the same path as a test's, but nothing
enumerates them and no lane can be asked to run one, so no suite has a
unit for them and none should. `isLaneMeasurement` is what says so, and
everything that reads a recorded identity asks it: the drift guard, the
publisher, and the list the publisher keeps from one run to the next.

The publisher leaves all of those out rather than putting an entry in the
manifest that no lane could run. The next record that says enough puts the
identity back in.

A count on its own says nothing about which of the two it holds, so the
aggregate keeps the identities that have no unit and removes each one when
the topology has a unit for it, or when it names something the count no
longer holds. A run compares its own list against that one:

```
test selection: 2900 of them were in this count at the last publish too,
so more of their records have been read since and those records still do
not say which unit. A surface whose records never say which unit is worth
fixing. See docs/development/test-selection.md.
test selection: those 2900 were recorded by 9 surface(s): unit:utils 742,
unit:runtime-client 509, unit:ts-transformers 379,
unit:schema-generator 314, unit:js-compiler 153, and 4 more
```

The second line is the one to act on. It is the same breakdown, over the
part of the count that two runs both left without a unit.

A run reads each identity's records only from the objects it folded for
the first time, so every identity in its count was recorded in an object
no earlier publish had read. One that was already on the list has
therefore been recorded twice over and had no unit either time. That is a
surface whose records never say which unit, rather than an identity whose
next record will say. The list is kept across runs rather than replaced by
each one, because a surface recording less often than the publisher runs
is absent from most runs, and a list replaced each time would treat such a
surface as new every time it did record.

What to check is that surface's wiring, which
[the record guide](test-records.md#covering-a-new-test-surface) covers: a
JUnit path on the job's ship step, the `--preload` naming
`packages/test-support/src/records/preload.ts` where the surface is
`deno test`, and the working directory that relative class names are
joined onto. Where the records do have a file, the file is one no suite
has a unit for, and the answer is in the topology rather than in the job.

Where none of them were on the list, the run says so instead:

```
test selection: none of them were in this count at the last publish, so
nothing has been recorded twice with no unit.
```

A run folding into an empty aggregate has nothing to compare against, and
says neither.

## What the wall shows

Two tiles read the newest manifest. The flake tile reports how many tests
are too noisy to judge a change by, naming the worst few. The selection
tile reports what share of the corpus five lanes would run and how close
the fullest lane is to its budget; it goes amber when the manifest has
gone stale and red when a lane's projected work is past its bound.

Both follow [the wall's rules](../../packages/dashboard/README.md#philosophy-and-values):
they report on the system, they name tests, and nothing about either is
aggregated per person.

## Telling the machinery about a new test

Nothing, in the ordinary case. A test added to an existing suite is
recorded by that suite's runner, and an identity with no history is
mandatory until a run on the default branch records it, so a new test runs
before anything knows what it is worth.

Two things are worth knowing while writing one, and both are consequences
of the identity being the reported name:

- Prefer stable, content-derived wording over positional counters or
  interpolated identifiers, which mint a new identity every time they
  shift.
- A rename splits history unless a line is appended to
  `tasks/test-identity-aliases.jsonl`. Most renames cost nothing, because
  most tests have never caught anything; a rename of a test that has is
  worth the line.

A new test *surface* — a new job, script, or harness — needs wiring, which
[the record guide](test-records.md#covering-a-new-test-surface) covers.
