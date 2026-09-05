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
and the number of lanes the units would fill at the stand-in rate — and
says on the error stream that it did so, since a projection from costs
nobody has measured would be arithmetic over an invented figure.

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
day's thousands of raw objects. It reads a day whole or not at all: a
shard it could not read would leave the day partly folded, and recording
the day as done would then hide the rest of it from every later run. The
days it did take are recorded, so no later run over a wide window folds
their raw objects on top and doubles every catch in them.

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
