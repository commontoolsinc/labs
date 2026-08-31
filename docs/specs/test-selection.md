# Choosing which tests a change runs

The contract of test selection: what a test is worth running, what the
manifest that says so contains, and what a consumer of one may and may
not conclude from it. This is the normative description of the shipped
parts; [the operating guide](../development/test-selection.md) says how to
use them, and
[the plan this comes from](../plans/pull-request-test-selection.md) carries
the reasoning and the parts still to be built. It rests on
[test-run records](test-records.md), whose store it reads and beside whose
dataset area it writes. The implementation is `tasks/test-selection/`, and
the manifest format itself is
`packages/test-support/src/records/selection.ts`, beside the record schema
it is the counterpart of.

## What the score measures

A test earns its place by having caught real breakage before. That is a
property of the test rather than a symptom of a problem: a test that found
a regression once sits somewhere mistakes get made, and it will find the
next one. So the score is built on catches and decays over months rather
than days.

That is a different quantity from "this test is currently flaky", and the
two are never scored together. A test failing a third of the time carries
almost no information per failure; a test that failed four times in two
years, each time because somebody broke something, carries a great deal.
Flakiness is dealt with separately, below.

### What a catch is

For every failing record, the publisher asks whether the failure says
something about a change or something about the test. A failure is a
**catch** unless one of these holds:

- The identity was already failing in the most recent run on the default
  branch. The test was already broken and this run learned nothing.
- The identity both passed and failed at the same commit, with nothing
  between the two runs but chance. That is a flake observation, and it is
  counted as one.
- The identity failed across at least `ENVIRONMENTAL_MIN_SOURCES` distinct
  sources within `CATCH_BREADTH_WINDOW_DAYS`. That is the environment or a
  dependency, not any one change.

Each catch is attributed to the pair of the commit and the source that saw
it, so re-running one broken commit ten times counts once. A source is the
branch for a continuous-integration run and the reporting person's login
for a local one.

A failure on the default branch cannot be judged when it happens. Every
push there is a distinct commit with one run, so a test that is flaky
there never contradicts itself, and counting each such failure as a catch
would make the least valuable test in the repository look like the most
valuable. Such a failure waits for the next run on that branch: still
failing is the same breakage continuing and nothing new is learned;
passing means the change between the two commits fixed it, which is what
the test caught. Telling a fix apart from a failure that healed itself
needs the coverage attribution map, and without one the judgement errs
toward calling a failure a catch.

### Where a catch happened

A catch is always a point in the test's favor, and the place says
something further.

- A **local catch** — somebody at a workstation, part way through writing
  something — is the highest-quality evidence this system can receive, and
  counts double.
- A **pull-request catch** is continuous integration doing its job.
- A **catch on the default branch** is a recorded escape: this test would
  have prevented a red default branch had it run on the pull request, and
  it did not. It counts one and a half times, which is the feedback loop
  that fixes that on its own.

### The formula

```text
catches   = CATCH_WEIGHT_LOCAL * localCatches
          + CATCH_WEIGHT_PR    * prCatches
          + CATCH_WEIGHT_MAIN  * mainCatches

if catches == 0:
    record = 0
else:
    proven    = 1 - 0.5 ** (catches / PROVEN_SATURATION)
    freshness = FRESHNESS_FLOOR + (1 - FRESHNESS_FLOOR)
                * 0.5 ** (daysSinceLastCatch / FRESHNESS_HALF_LIFE_DAYS)
    record    = proven * freshness

breadth = 1 - 0.5 ** (sources / BREADTH_SATURATION)

value = VALUE_FLOOR + WEIGHT_PROVEN * record
      + WEIGHT_BREADTH * breadth + WEIGHT_CHURN * churn
```

Two guarantees follow, and both are asserted rather than argued:

- A test that has **never failed anywhere** scores exactly `VALUE_FLOOR`.
- A test with **no catches but recent failures** — every one classified as
  flake evidence, or as a continuation of an already-broken default branch
  — scores `VALUE_FLOOR + WEIGHT_CHURN * churn`, and never a missing
  value. The branch for a test with no catches is written out rather than
  left to the algebra: there is no date to measure freshness from, and
  multiplying zero by a missing number yields a missing number, which
  sorts unpredictably against real scores.

`VALUE_FLOOR` is what points the packing at the cheap tail. A
fifty-millisecond test that has never failed has a value per second of
one, which beats a hundred-second integration test scoring 0.9 by a factor
of a hundred.

### How far back each input looks

There is no single window, because the inputs want very different horizons
and one number damages most of them.

| Input | Horizon |
| --- | --- |
| `catches`, `lastCatch` | unbounded; `freshness` does the discounting |
| `sources` | unbounded, counted only over catches |
| `churn` | decayed with a `CHURN_HALF_LIFE_DAYS` half-life, read over `CHURN_WINDOW_DAYS` |
| `flakeRate` | `FLAKE_WINDOW_DAYS` |
| `cost` | `COST_WINDOW_DAYS` |

The counts behind `churn` are decayed rather than cut off. A ratio over a
long undecayed window measures total historical brokenness rather than the
current rate, and a week of failures eight months ago would otherwise
outrank a test that is failing right now.

`cost` is the largest of the days' ninetieth percentiles inside its
window: the ninetieth rather than the maximum, because one unlucky runner
should not permanently inflate an estimate, and the largest across days
rather than an average, because a cost model that under-estimates blows
the time budget.

## Flakes

A flake is a test that disagrees with itself. Above
`FLAKE_EXCLUSION_RATE` an identity leaves the selectable set entirely: it
is too noisy to judge a change by. It keeps running on the default branch,
it appears on the wall, and the exclusion reverses on its own the moment
the test is fixed, which is what makes this better than a quarantine list
somebody has to remember to empty.

Below that rate, an identity may be run more than once inside one run, at
the bands `FLAKE_REPEAT_RATES` names, up to `MAX_REPEATS`. Every band
stays under the exclusion rate, or an identity would be excluded before it
reached the band and the band would never fire.

**A repeat is not a retry.** Every repeat must pass, and any failure among
them fails the run. Three runs of a test is strictly stricter than one,
never laxer. Nothing is retried and nothing is masked.

## What must run, and what must not

Two rules keep a test out. Both make a change less red rather than more,
and both exist so that nobody's change fails for something its author
cannot act on.

- An identity failing in the most recent run on the default branch is not
  selected.
- An identity above `FLAKE_EXCLUSION_RATE` is not selected.

Either comes back the moment the change touches what it covers, since that
is very likely a fix and has to be allowed to prove itself.

Two rules force a test in.

- **An identity with no records must run.** This is required of any
  consumer that selects which tests run, by
  [the record spec](test-records.md#trust-boundaries-for-consumers), on the
  grounds that a selector which never runs the unselected starves its own
  data and that a renamed test is an unknown identity until an alias line
  lands.
- **What the change touches must run.** A changed test file's identities
  are mandatory. A changed source file resolves through the coverage
  attribution map to the identities that execute its lines.

## The manifest

One gzipped JSON object per publisher run, created — never overwritten —
under the dataset area
[the record spec describes](test-records.md#the-store). It carries the
schema version, the generation time, the exploration seed, the commit
whose tree was enumerated, how many runs the aggregate saw, every dial it
was built with, the fitted calibration numbers, every identity with its
score and the inputs behind it, the withheld sets with their reasons, the
tests a configuration deliberately does not run, a reference packing into
lanes, the unschedulable list, a count and digest of known identities, and
the per-package coverage baselines.

A manifest is **untrusted input**. It is validated whole, and one bad
field rejects the object rather than leaving a consumer obeying half of
it. A manifest whose schema version a reader does not know is treated as
absent, because a reader that does not know a field cannot know what
obeying the rest would mean. A consumer that finds no manifest runs the
mandatory set and a deterministic slice of the corpus rather than failing.

That the manifest may be an ordinary public object rather than a signed
artifact follows from what it can do. It can only change *which* tests
run. It cannot change what a test does, what a test asserts, or what the
repository builds. The worst a corrupted manifest achieves is a change
that ran fewer tests than it should have, which the full run on the
default branch catches.

## Renames

Renaming a test costs it all of its history, and the cost falls in the
worst possible place: `catches` accumulates over unbounded history and is
the whole of what makes a test worth running, so the best test in an area
drops to the floor at the exact moment somebody is working there.

`tasks/test-identity-aliases.jsonl` is what bridges the two halves, and
every reader of the store resolves through it, the publisher included. A
rename is never inferred: a wrong bridge silently credits one test with
another's record, and since the whole score rests on catch attribution
there is no downstream check that would notice. Suggesting a line is help;
writing one unasked is not.

## Determinism

The packing function is pure. No clock, no unseeded randomness, no
dependence on anything but the manifest, the diff, and the lane number.
That is what lets every lane compute its own share and agree with the
others by construction, with no job ahead of them deciding and no lane
waiting on one. The exploration draw's seed comes from the manifest, so
the draw is the same in every lane and different between manifests.

A consumer resolves the manifest as the newest one generated at or before
its run's start time, rather than at or before now, which is what makes
re-running one failed lane run the same set as the lane it replaces.
