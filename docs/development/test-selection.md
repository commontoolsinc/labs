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
score and its cost, the catches behind that score and how many distinct
sources they came from, when the most recent one was, its churn and flake
rate, and whether it is withheld and why. An identity the store has never
seen is reported as mandatory, which is what an identity with no history
is.

The identity resolves through `tasks/test-identity-aliases.jsonl` first,
so asking about a renamed test under either name finds the joined history.

### `dials`

Every number selection can be tuned by, with the unit its value counts,
where the value comes from, and which way you would move it.
[Every dial](#every-dial) lists them.

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

## Every dial

`tasks/test-selection/policy.ts` defines every one of these, and nothing
else defines any of them. `dials` prints the same content as the table
below, and `tasks/test-selection/policy.test.ts` holds the two to each
other: a dial added, removed, or reworded in `policy.ts` without the
matching edit here fails `deno task test`.

The **Units** column says what each number counts. Several of the dials
are bare fractions that do not mean the same thing, and the table holds
two different `0.25` values as it stands: `WEIGHT_BREADTH` is a share of a
test's score and `FILL_DENSITY_SHARE` is a share of the run's budget. A
share of an item's runs reads the same way again. Naming the unit is what
keeps them from being compared to each other.

The **Set by** column separates three kinds. A **chosen** value is a
decision somebody made, and editing it is how the decision changes. A
**measured** value is worked out from the data and written back by the
publisher, so the number in the file is only the seed used before there is
anything to measure, and editing it changes nothing after the first
publisher run. A **derived** value is computed from other dials and has no
expression of its own to edit: each lane budget is its run's bound less
the prologue and the safety margin, so a budget that does not fit inside
its own bound cannot be written down. The distinction matters because all
three look identical in a source file, and somebody who tunes a measured
value is arguing with a tape measure while somebody who tries to tune a
derived one is editing a line that is not there.

Three more numbers are measured, and they are not in the table because
they are not in `policy.ts`: `setupCost` for each capability, and
`suiteOverhead` and `correction` for each suite. They are fitted from the
lanes' own timing records and published in the manifest, one set per
publisher run, which is where to read them. Nothing hand-edits them, and a
manifest carrying a strange one is a measurement to look at rather than a
setting to fix.

| Dial | Default | Units | Set by | Why you would move it, and which way |
| --- | --- | --- | --- | --- |
| `LANES` | 5 | lanes | chosen | Up when pull-request feedback is too thin and runner capacity allows more; down when the wave crowds other workflows off the shared runners. |
| `LANE_BOUND_SECONDS` | 300 | seconds | chosen | Up when more should fit in a lane; down when five minutes is longer than anybody will wait for a first answer. The lane jobs that this bounds do not exist yet; when they do, their work-step and job timeouts in `deno.yml` have to move with it, and nothing checks that until they are written. |
| `LANE_PROLOGUE_SECONDS` | 40 | seconds | measured | Never. The publisher overwrites it from the lanes' own timing records, and the checked-in figure is only what the first lane uses before any lane has reported one. |
| `LANE_SAFETY_SECONDS` | 30 | seconds | chosen | Up when lanes overrun their bound on slow runners; down when they finish early every time and the headroom is buying nothing. |
| `LANE_BUDGET_SECONDS` | 230 | seconds | derived | Nothing edits this. It is the bound less the prologue and the safety margin, so a budget that does not fit inside its own bound cannot be written down. |
| `FULL_LANE_BOUND_SECONDS` | 600 | seconds | chosen | Up when the run on `main` uses more jobs than it needs; down when `main` takes too long to say something broke. |
| `FULL_LANE_BUDGET_SECONDS` | 530 | seconds | derived | Nothing edits this. It is the full run's bound less the same prologue and safety margin a pull request's lane pays, since a lane of either run is the same job doing the same setup on the same runner. |
| `FULL_RUN_LABEL` | ci: full | a label | chosen | Not a quantity. Change it only if the label collides with one the repository already uses for something else. |
| `UNMEASURED_COST_SECONDS` | 1 | seconds | chosen | Up when a lane holding new tests runs long; down when it finishes early. It is reached for only by a suite with no measured test at all, since a suite that has any charges an unmeasured one what its middle test costs. |
| `VALUE_FLOOR` | 0.05 | score | chosen | Up when the cheap tail is not being swept up; down when it crowds out tests with a record of catching things. |
| `WEIGHT_PROVEN` | 0.55 | share of the score | chosen | Up when a record of catching things should count for more. The three weights are shares of one score, so what this gains the other two lose. |
| `WEIGHT_BREADTH` | 0.25 | share of the score | chosen | Up when a test that several distinct sources have hit should count for more; down when breadth is mostly telling you about the environment rather than the test. |
| `WEIGHT_CHURN` | 0.15 | share of the score | chosen | Up when something going wrong right now should jump the queue faster; down when the queue keeps being jumped by noise. |
| `PROVEN_SATURATION` | 2 | catches | chosen | Where the `proven` term reaches half its ceiling. Up when the term should go on telling eight catches from four; down when one catch should already be worth nearly everything a test can earn. |
| `FRESHNESS_HALF_LIFE_DAYS` | 120 | days | chosen | Up when old catches should keep more of their value; down when a test that caught something a year ago crowds out one that caught something last week. |
| `FRESHNESS_FLOOR` | 0.3 | multiplier | chosen | Up when a very old catch should keep more of its worth; down when age should be allowed to retire one almost completely. |
| `CATCH_WEIGHT_LOCAL` | 2 | multiplier | chosen | Up when evidence from a workstation should count for more; down if local records ever arrive in volume and stop being the scarce signal they are today. |
| `CATCH_WEIGHT_PR` | 1 | multiplier | chosen | Neither. It is the unit the other two are expressed against, so move those instead. |
| `CATCH_WEIGHT_MAIN` | 1.5 | multiplier | chosen | Up when an escape should pull harder on what gets selected next; down when the failures on `main` are mostly environmental rather than real. |
| `BREADTH_SATURATION` | 2 | sources | chosen | Where the `breadth` term reaches half its ceiling. Up when the term should go on telling eight sources from four; down when one source should already be worth nearly all it can give. |
| `ENVIRONMENTAL_MIN_SOURCES` | 5 | sources | chosen | How many distinct sources a failure must span inside `CATCH_BREADTH_WINDOW_DAYS` before it reads as the environment. Up when a genuinely broad regression is written off; down when a broken runner's failures still count as catches. |
| `CHURN_HALF_LIFE_DAYS` | 14 | days | chosen | Up when recent trouble should stay relevant for longer; down when a problem already fixed keeps its tests selected for weeks afterwards. |
| `CHURN_WINDOW_DAYS` | 60 | days | chosen | How far back the decayed counts are read. Past this the weight is under one part in sixteen, so moving it is a performance decision rather than a policy one. |
| `FLAKE_WINDOW_DAYS` | 60 | days | chosen | Up when a flake rate swings about on too little evidence; down when a test that has since been fixed stays excluded. |
| `COST_WINDOW_DAYS` | 7 | days | chosen | Up when cost estimates are noisy; down when durations drift with the code or the runner image faster than the estimate follows. |
| `FILL_VALUE_SHARE` | 0.6 | share of the run's budget | chosen | Up when expensive high-value tests are crowded out by cheap ones; down when a lane spends its budget on a few slow tests and runs little else. The three shares sum to one. |
| `FILL_DENSITY_SHARE` | 0.25 | share of the run's budget | chosen | Up when more of the cheap tail should run; down when the tail is displacing tests with a record. |
| `FILL_EXPLORATION_SHARE` | 0.15 | share of the run's budget | chosen | Up when the unselected corpus is going stale; down when lanes spend the share on tests that never find anything. |
| `FLAKE_EXCLUSION_RATE` | 0.05 | share of runs | chosen | Up when fewer tests should be held back from pull requests; down when flakes are still blocking people. |
| `FLAKE_REPEAT_RATES` | 0.01, 0.03 | share of runs | chosen | Up when repeats cost more lane time than the intermittent failures they catch are worth; down when intermittent failures are still slipping through. Every band stays under `FLAKE_EXCLUSION_RATE`, or an item is excluded before it reaches the band and the band never fires. |
| `MAX_REPEATS` | 3 | runs of one item | chosen | Up when intermittent regressions still get through; down when repeats are crowding a lane. |
| `SUITE_FLAKE_PRIOR_RATE` | 0.02 | share of runs | chosen | Up when too many suites count as flake-prone and their new items are repeated needlessly; down when new tests in a noisy suite land unrepeated and then flake. |
| `COVERAGE_COMMENT_LINES` | 25 | lines | chosen | Up when coverage comments are too noisy; down when debt is climbing unnoticed. |
| `LOCAL_COVERAGE_MAX_SECONDS` | 30 | seconds | chosen | Up when too many packages are reported as expensive for the report to be worth reading; down when one is quietly eating a lane. Nothing is excluded either way; it only decides what the summary mentions. |
| `LOCAL_COVERAGE_MAX_PACKAGES` | 2 | packages | chosen | Up when broader changes should still be gated and the run can afford their packages' whole test sets; down when sweeping changes are crowding lanes. |
| `EXCLUDED_FROM_COVERAGE_GATE` | 9 | workspace members | chosen | Not a quantity. A line comes off when a package fits the run's budget or gains a Deno-only half, which turns its gate on. A line goes on when a package's own tests stop being what covers it. |
| `LOCAL_COVERAGE_BASELINE_DAYS` | 7 | days | chosen | Up when branches based further back are being reported for want of an ancestor baseline; down when the manifest carries more history than anybody reads. |
| `COVERAGE_TREND_WEEKS` | 3 | weeks | chosen | Up when the tile goes amber too readily; down when debt climbs for a month before anybody is told. |
| `CATCH_BREADTH_WINDOW_DAYS` | 2 | days | chosen | Up when a broken runner's failures are being counted as catches; down when genuine breadth is being written off as environmental. |
| `SAME_COMMIT_REACH_DAYS` | 2 | days | chosen | How far back the fold remembers a commit's outcomes, so that a rerun landing in a later batch than the run it repeats is still read as the test disagreeing with itself. Up when reruns land far enough behind that their disagreement is being counted as a catch; down when the fold's memory is the thing that will not fit. It costs the number of identities that have failed times the number of commits, so it is the dial to check first when a run runs out of memory. |
| `FLAKE_COMMIT_REACH` | 8 | commits | chosen | How many of the most recently observed commits the fold keeps every identity's outcomes at. Past that a commit keeps only the identities that have already failed, so this bounds a test's first failure: up when one lands more commits after the pass it disagrees with than this and is counted as a catch; down when the fold's memory is the thing that will not fit. |
| `RENAME_SIMILARITY` | 0.7 | share of the longer name's own part | chosen | Up when the run report offers rename pairings nobody meant; down when a rename that discarded history goes unoffered. It only decides what is suggested — nothing is written to the alias file without somebody appending it. |
| `RENAME_MARGIN` | 0.1 | share of the longer name's own part | chosen | Up when the run report pairs a deletion with an unrelated addition; down when a rename made alongside another rename in the same area goes unoffered. |
| `RENAME_SUGGESTIONS` | 5 | suggestions in one comment | chosen | Up when a change that renamed many tests has its later suggestions cut off; down when a comment carrying this many is one nobody reads. |
| `ALIAS_GATE_MIN_CATCHES` | off | catches | chosen | Off by default. Turn it on at a catch count to fail a pull request that discards that much history in a rename without an alias line, and lower the count as the alias file becomes routine. |

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

## The comment a run on the default branch leaves

Selection means some regressions land and the run on the default branch
catches them. When that happens, the change that caused it is told,
without anybody going looking.

`.github/workflows/pull-request-comments.yml` runs
`tasks/post-main-report.ts` in the base-repository context with a write
token. It follows the test workflow, because a `workflow_run` payload
describes the run it names and not the run that triggered it: a follower
of the relay would read the default branch and its tip whichever run's
records the relay had shipped. The repository squash-merges with the pull
request number in the subject, so the pull request behind a commit is
unambiguous; a commit pushed straight to the default branch has none, and
then nothing is posted.

Three runs are compared: the run at the commit, the run at the commit's
parent, and the pull request's own run. The two on the default branch are
read from their own `test-records-*` artifacts, which are readable the
moment a run ends where the store holds a run only once the relay has
shipped it — and two merges landing close together, which is the case
this exists for, is exactly when the earlier relay is still running.

The pull request's own run is read from the store instead, because the
relay is where the trust decision about it was made: records from a fork
run are authored by the fork, and the relay ships them only for a member.
What the store holds is what this repository was willing to believe.

The previous run is asked for by the parent commit's name rather than
taken from a listing. Pushes to the default branch are not cancelled by
their successors, so two of them overlap whenever two merges land close
together, and the run before this one in a listing of finished runs can
be the run two commits back.

Every conclusion that leaves records counts, a run killed at its bound
included: that is the shape a hanging test takes, and every note needs
evidence rather than the absence of it. A run whose records cannot be
found is a run nothing is known about, not a run that skipped every test
it did not record — and a run one of whose artifacts could not be
downloaded is read as nothing at all, because a run read in part reads
as a run that ran less, and a report built on that would withdraw one an
earlier attempt correctly made.

A commit whose subject names a number that is not a pull request gets
nothing. An issue takes comments the same way a pull request does, so
the number is looked up before anything is written.

The comment carries up to six notes, and it carries a note only when the
run found something the pull request's own run could not have found for
itself.

- **A test that failed for the first time at this commit.** Precisely
  that: it passed in the previous run on the default branch and failed in
  this one. A test that was already failing produces no note, which is
  what stops a break being attributed to whoever merged next. A test that
  both passed and failed at this commit produces no note either: that is
  the test disagreeing with itself, which the scorer calls flake evidence
  rather than a catch. Nor does a test the pull request's own run failed,
  because a failure that run reported is not something a later run found
  for it.
- **What the pull request's own run did with that test.** Its records say
  whether it ran the test, which is the only thing that settles it, and
  the manifest it resolved says why it did not. Ran and passed is a flake
  or an interaction between changes. Withheld is the store holding the
  test back as too flaky to judge a change by. Not selected is the
  expected cost of selection: the coverage this design traded away, so
  nothing was missed. A test the packing reached, or one the store has
  never seen, with no record either way is a run that recorded less than
  it ran — a test job that fails before it uploads leaves its share
  behind like that — which is said in those words rather than as a test
  the run did not reach. And a test its run recorded a skip for, where no
  manifest says selection is why, is a test that skips itself under some
  condition.
- **A rise in the repository's uncovered-line count** of at least
  `COVERAGE_COMMENT_LINES`, measured between the run before the commit
  and the run at it, with the source groups the change touched that rose
  with it. Naming those is as near as this gets to saying where a test
  would go, and it is also what separates the part of the rise the
  change is behind from the part that is somewhere else. Never a
  failure, and never for one line. A change that touched no source at
  all is not asked about, because the repository-wide figure moves a
  little between runs on its own.
- **A rise in a covered package's own-tests number**, naming what let it
  past the per-package gate. As with the repository-wide figure, a change
  that touched no source at all is not asked about. The routes are: the package is on
  `EXCLUDED_FROM_COVERAGE_GATE`; the change touched more covered packages
  than `LOCAL_COVERAGE_MAX_PACKAGES` allows, so the gate did not run; the
  change did not touch the package, so the gate had nothing to compare;
  or the gate did measure the package and passed it, which means the two
  measurements disagree. Each calls for something different, which is why
  the note names it. The number is the package's source measured by only
  the package's own tests, which a run measures whole however much of the
  corpus it ran. That is a different number from the source group of the
  same name, which is the package measured by every test in the run and
  which a selected run only samples; `ownTestsCoverageMetric` in
  `tasks/ci-check-lib.ts` is the one name the producer and the reader
  share. The per-package gate is what publishes it, so this note is
  silent until that gate lands.
- **A new test that turned out to be flaky.** A test this run ran, the
  previous run did not, and the store has never seen — that third
  condition is what stops a run that shipped part of its records making
  every test in the missing part look new — which passed and failed at
  this one commit, across the repeats a lane runs, across shards and
  across attempts.
- **A rename that discarded history**, with the number of catches it
  would bring back and the line to append to
  `tasks/test-identity-aliases.jsonl`. Four things have to hold: the
  departing test caught something; the unit it lived in produced records
  in this run, so its absence is a test that left rather than a suite
  that did not run; the arriving name is one the store has never seen;
  and the pairing is clear — alike past `RENAME_SIMILARITY`, ahead of
  every other candidate by `RENAME_MARGIN`, and pointed at by no other
  departure. Alikeness is the lower of two comparisons, one over the
  groups a name is nested under and one over the part that is the test's
  own, because either alone answers a different question: two tests under
  one group share the whole chain, and two tests under different groups
  routinely share a leaf. At most `RENAME_SUGGESTIONS` are offered. A rename is never inferred, so this
  is a suggestion: append the line if the pairing is right, and ignore it
  if it is not.

Five properties keep this on the right side of
[the wall's rule](../../packages/dashboard/README.md#philosophy-and-values)
that reporting is about the system and never about individuals. The
comment's subject is a commit and a test, and no author is named. Nothing
is counted per author, per team, or per anything, and no history is kept:
each comment is a pure function of one run, and no tile, report or query
rolls them up. A test the selector declined to run is described as
coverage this design traded away, because the author did not miss it. A
test the store knows disagrees with itself is labelled as one. And the
comment is edited in place rather than repeated, which the hidden marker
at the top makes possible; a later attempt that finds nothing withdraws
what an earlier one said.

If it ever stops being all five of those, it should be removed rather
than tuned.

Nothing gates on it. The reporter is best-effort throughout: a failure
becomes a warning annotation on the run and the workflow stays green,
because a comment nobody gates on must never turn a run red, and least of
all a run that has already passed. It reads two runs' worth of record
artifacts, so it takes minutes; nothing waits on it.

To see what it would say about a run, set `MAIN_REPORT_RUN_ID` to that
run and pass `--dry-run`, which posts nothing.

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
