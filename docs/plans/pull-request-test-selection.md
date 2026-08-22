# Choosing which tests a pull request runs

Status: proposed. Nothing here is built yet. The record store this plan
consumes is live and holds the data the design needs; the gaps it does not
yet hold are listed under [What the store is
missing](#what-the-store-is-missing) and closed by the first of the three
pull requests it lands in.

Continuous integration for a pull request currently runs sixty-seven jobs
and every test in the repository. This plan replaces that with five jobs
that run a chosen subset, chosen from what the test-record store already
knows about which tests have caught real regressions, refreshed every few
hours, and packed so that each of the five jobs finishes in about the same
time and within five minutes. A push to `main` still runs everything, and
a label on a pull request runs everything there too.

Selecting a subset breaks two things that depend on running the whole
suite, so the plan carries their replacements rather than leaving them
broken. Coverage stops being a gate anywhere and becomes a trend somebody
can act on. And a regression that only `main` catches gets reported back
to the change that introduced it, automatically, addressed at the change
and never at a person.

The design is written so that adding a test, a new kind of test, or a new
configuration of existing tests is a change to one repository module and
never a change to the continuous-integration configuration. That property
is the point of the whole exercise: a selection system that has to be
rewired every time somebody adds a test surface costs more than it saves.

It lands in three pull requests, with no flags and nothing to flip: each
one is live the moment it merges.

## Status convention

- [ ] Not started
- [x] Complete and verified

Mark a parent checkbox complete only after all its children pass. Keep
this plan current in the same commits as the implementation. When the last
of the three pull requests has landed, archive it under
`docs/history/plans/` following
[`../README.md`](../README.md).

## The vocabulary, briefly

- An **identity** is the durable name of a test: the triple of kind,
  scope, and name defined by [the test-record
  spec](../specs/test-records.md). Everything here is built on it.
- An **item** is the smallest thing a runner can be asked to run on its
  own. For a pattern test the item is one file and the file is also the
  identity. For a unit test the item is usually the file, which contains
  many identities. For the command-line integration script the item is a
  named section, which contains many identities.
- A **suite** is a named group of tests that share one runner and one
  environment: the workspace unit tests, the pattern integration tests,
  the pattern integration tests under the server-execution flag, and so
  on. A suite knows how to list its items and how to run a subset of
  them.
- A **capability** is one piece of environment setup: the Deno toolchain,
  a FUSE package, a running Toolshed server, a browser sandbox
  adjustment. A suite declares the capabilities it needs.
- A **batch** is the items of one suite that have been scheduled into one
  job.
- A **lane** is one of the five pull-request jobs. A lane runs several
  batches in sequence.
- The **topology** is the repository module that declares every suite and
  every capability. It is the single place a new test surface is
  registered.
- The **manifest** is the published selection data: every known item, its
  score, its estimated cost, and a reference packing into lanes. It lives
  in the record store, not in git.
- The **publisher** is the scheduled workflow that reads the store, scores
  every identity, and writes a manifest.
- The **lane runner** is the repository script the five pull-request jobs
  all run, differing only in which lane number they are given.
- A **catch** is one occasion on which a test failed and the evidence
  points at a change rather than at the test or the machine. Catches are
  what makes a test worth running; the whole score is built on them.
- A **flake** is a test that disagrees with itself: it passed and failed
  at the same commit, with nothing between the two runs but chance.
- A **repeat** is running one item more than once inside a lane, to raise
  the chance of catching something intermittent.

## The problem

The repository already measures everything this needs and throws none of
it away. What it does not do is act on it.

A recent successful push build of `deno.yml` ran sixty-seven jobs. Those
jobs consumed a hundred and eighty-seven minutes of runner time and took
twelve and a half minutes of wall time from first start to last finish.
Every pull request pays that, and pays it again on every push to the
branch.

The same build's test records say what that time went on. One run
recorded sixteen thousand three hundred and forty test executions under
sixteen thousand two hundred and sixty-one distinct identities, and the
runners' own measurements of those executions add up to a hundred and
forty-six and a half minutes. The distribution is extremely skewed:

| Tests | Count | Summed duration | Share of the total |
| --- | --- | --- | --- |
| Over sixty seconds | 14 | 24.4 minutes | 17% |
| Over ten seconds | 137 | 65.6 minutes | 45% |
| Over one second | 1,630 | 131.5 minutes | 90% |
| Under one hundred milliseconds | 12,902 | — | — |

Four fifths of the tests in this repository finish in under a tenth of a
second, and together they account for about fifteen minutes of measured
time. Nine tenths of the time is spent in one tenth of the tests.

That skew is the thing to exploit. A selection system that keeps the cheap
tail and chooses carefully among the expensive head can keep most of the
tests while spending a small fraction of the time. The arithmetic is in
[What we expect this to select](#what-we-expect-this-to-select).

The second half of the problem is that the jobs themselves are hand-wired.
Sixty-seven jobs come from about eighteen job definitions in
`deno.yml`, each with its own setup steps, its own sharding scheme, its
own artifact names, and its own entry in three `needs:` lists. Adding a
test surface today means editing the workflow, the `Status` job's
dependency list, the coverage gate's dependency list, and often a sharding
weight table. That cost is what makes people put a new test in an existing
job where it does not belong.

## What the design must satisfy

1. Pull-request continuous integration is exactly five jobs. Nothing else
   runs on a pull request, unless somebody asks for the full run by
   labelling the pull request, in which case the five do not run and the
   full run does. One or the other, never both.
2. Each of the five finishes within five minutes, setup included, and the
   five finish at about the same time as one another.
3. Selection is driven by three signals from the record store: how
   recently a test last failed, how many distinct sources have reported it
   failing, and what fraction of its runs fail.
4. A small share of each job runs tests drawn from outside the
   high-value set, so the unselected corpus keeps producing data and keeps
   being covered.
5. Tests that need the same setup are grouped so the setup is paid once
   for the group.
6. A push to `main` still runs every test.
7. Selection is recomputed every few hours, and what it produces is not
   stored in git.
8. Adding a test, a kind of test, or a configuration of existing tests
   does not change the continuous-integration configuration, and the
   addition is picked up both by the full run on `main` and by
   pull-request selection.
9. Coverage keeps going up. It stops being a gate — on pull requests
   because it cannot be measured there, and on `main` because a landed
   change that adds one uncovered line must not turn anything red.
10. A regression that reaches `main` is reported back to the change that
    introduced it, without turning that into a record of who broke what.
11. Flaky tests are found, and the finding is used: to run intermittent
    things more often where that catches more, and to keep tests too
    noisy to judge from blocking anybody.
12. Every dial is in one documented place, and a pull request can opt out
    of selection entirely and run everything.

Requirement 8 is the one that shapes the architecture. Requirements 1
through 7 could be met by a script that hard-codes today's eighteen job
definitions; requirement 8 cannot. Requirements 9 through 11 are what a
subset costs, paid for rather than written off.

## The shape of the system

Four pieces, with one direction of dependency between them.

**The topology** lives in the repository, at `tasks/test-topology.ts` and
the modules it pulls in. It declares each suite: what capabilities the
suite needs, how to list the suite's items from the working tree, how to
map a record identity to one of those items, and what command runs a given
set of items. It is the only place a new test surface is registered.

**The publisher** is a scheduled workflow. Every four hours it reads the
record store, folds the new records into a rolling per-day aggregate,
scores every identity, estimates every item's cost, packs the result into
five lanes, and writes one manifest object into the store. It writes
nothing into git.

**The lane runner** is `tasks/ci-lane.ts`. The five pull-request jobs all
run it, passing their lane number. It fetches the newest manifest, reads
the working tree through the topology, adjusts the plan for what this
particular pull request changed, works out which batches belong to its own
lane, sets up the capabilities those batches need, runs them, and records
the results the same way every other job in this repository does.

**The full run** on `main` uses the same topology and the same lane
runner, with selection switched off. Its job matrix is computed from the
topology rather than written out in the workflow, so a new suite appears
in the full run without a workflow edit. A pull request labelled
`ci: full` gets the same job, so opting out of selection is one click and
runs exactly what `main` runs.

**The reporter** follows every `main` run to completion, works out what
that run learned that the pull request behind it did not, and says so on
that pull request. A test that failed for the first time at this commit,
a coverage debt increase, a new test that turned out to be flaky: all
things the change's author wants to know and nobody currently tells
them.

The dependency direction matters: the publisher and the lane runner both
depend on the topology, and neither depends on the other's internals. The
manifest is the only thing that passes between them, and it is a validated
data format rather than a shared code path.

## The topology

A suite is a value with the following shape. This is the whole interface
that a new test surface has to implement.

```typescript
// Shown for illustration only.
interface Suite {
  /** Stable identifier. Appears in manifests, logs, and timing records. */
  id: string;

  /** The kind and scope its records carry, per the test-record spec. */
  identity: { kind: string; scope: string };

  /** Setup this suite needs before it can run. */
  needs: CapabilityRequest[];

  /** Environment variables its commands run with. */
  env?: Record<string, string>;

  /**
   * The finest subset the runner can execute. "item" means the runner
   * can be given an arbitrary set of items; "whole" means the suite
   * runs entirely or not at all.
   */
  granularity: "item" | "whole";

  /** Whether a subset of this suite is always run, and on what basis. */
  mandatory?: "always" | "changed";

  /** Every item that exists in the working tree right now. */
  enumerate(): Promise<Item[]>;

  /** Which item a recorded identity belongs to, if any. */
  locate(identity: TestIdentity): Item | undefined;

  /** The command that runs exactly these items. */
  command(items: Item[], output: OutputPaths): Command;
}
```

Three of those members carry the design.

`enumerate()` is what makes a new test visible without a workflow edit. It
reads the working tree — usually a file glob, sometimes a list parsed out
of a script — and returns the items that exist right now. A test file
added by a pull request appears in `enumerate()` on that pull request's
own checkout, which is how a brand-new test gets run before any record of
it exists.

`locate()` is the bridge from history to execution. The store speaks in
identities; the runners take file paths and section names. For a pattern
test the two coincide, because a pattern test's identity is its path. For
a unit test `locate()` needs the file the identity came from, which is
metadata the store does not reliably carry today; closing that gap is the
first thing the [first pull request](#one--the-data-and-what-it-already-tells-us)
does.

`granularity` is an honest declaration of what the runner can do, and the
packer respects it. A suite that can only run whole is charged for all of
its items whenever any one of them is selected. A suite that can run
arbitrary items is charged only for what is picked. Nothing pretends to a
precision the runner does not have.

`mandatory` is the policy escape hatch. `"always"` means every item runs
on every pull request, with no exceptions of any kind — it outranks the
score, the budget, and both exclusion rules, and
[Two rules that keep a test out](#two-rules-that-keep-a-test-out) explains
why that has to be literal. `"changed"` means an item runs when the pull
request touches a file the item covers; the per-package type check is the
natural user, because the store already records one `typecheck` identity
per package group and the mapping from a changed file to a package is
direct. Absent the field, the suite is selected purely on value.

The `always` set is deliberately tiny, and every member of it is a gate
whose failure means the tree is broken rather than that one test is
unhappy: `deno fmt --check`, `deno lint`, and the topology drift guard.
Together they cost seconds. Nothing expensive belongs there, and adding to
the set is a decision to spend part of every lane's budget forever.

### Today's jobs as suites

The eighteen job definitions in `deno.yml` become the following suites.
This table is the migration's checklist.

| Suite | Today's jobs | Capabilities | Granularity |
| --- | --- | --- | --- |
| `repo-gates` | `Check` (all but the type check) | `deno` | item |
| `typecheck` | `Check` (the type check) | `deno` | item |
| `workspace-unit` | `Test (1..8)` | `deno`, `fuse`, `browser` | item |
| `runner-unit` | `Runner Tests (1..8)` | `deno` | item |
| `cfcheck` | `CFC Pattern Check` | `deno` | item |
| `pattern-compat` | `Pattern Update Compatibility (1..3)` | `deno` | item |
| `pattern-vintage` | `Pattern Update State and Baseline Integrity` | `deno`, `git-history` | item |
| `generated-patterns` | `Generated Patterns Integration Tests (1..2)` | `deno`, `compile-cache` | item |
| `package-integration` | `Package Integration Tests (3 suites)` | `deno`, `toolshed`, `browser` | item |
| `package-integration-on` | the server-execution ON arm | `deno`, `toolshed-baked-on`, `browser` | item |
| `cli-core` | `CLI Integration Tests (3 suites)` | `deno`, `toolshed`, `cf`, `jq` | item |
| `cli-fuse` | the FUSE steps of the third CLI suite | `deno`, `toolshed`, `cf`, `fuse` | whole |
| `cli-deno` | the Deno-based CLI integration step | `deno`, `toolshed`, `cf` | item |
| `pattern-integration` | `Pattern Integration Tests (1..10)` | `deno`, `toolshed`, `browser`, `compile-cache` | item |
| `pattern-integration-on` | the server-execution ON arm | `deno`, `toolshed-baked-on`, `browser` | item |
| `pattern-reload` | `Pattern Reload Integration Tests` | `deno`, `local-dev-servers`, `browser` | whole |
| `pattern-unit` | `Pattern Unit Tests (1..4)` | `deno`, `cf`, `compile-cache` | item |

The build jobs (`Build Binary (toolshed)` and the three beside it) do not
become suites. They are not tests; they are setup, and they become
capability providers. The deploy and attestation jobs stay exactly as they
are, since they only ever ran on `main`.

`cli-fuse` and `pattern-reload` are declared `whole`, for two different
reasons that are worth telling apart.

`cli-fuse` is `whole` because `packages/cli/integration/fuse-exec.sh` takes
no section argument at all — unlike `integration.sh` beside it, which
dispatches on `CF_CLI_INTEGRATION_SECTION` and would be selectable
per-section. That is a limitation of the script, and the right fix is to
give it the same section dispatch its sibling has, rather than to work
around it here.

`pattern-reload` is `whole` because it *is* one item.
`packages/patterns/integration/reload/` holds a single file with a single
`it()`, so the finest subset the suite has and the whole suite are the same
thing, and declaring it `whole` costs nothing. Its runner could subset if
there were anything to subset: the underlying command is a plain
`deno test` over a glob, which takes file paths and `--filter` like every
other Deno suite. What stands in the way is two layers above it —
`tasks/integration.ts` dispatches `patterns-reload` in a branch that sits
ahead of the one honoring the name filter, so a filter passed to that
target is silently dropped, and `packages/patterns`' `integration:reload`
task hard-codes its glob. If a second reload case ever lands, moving that
branch below the filter branch is the whole of what makes the suite
`item`.

`pattern-reload` also shows why capabilities are named rather than
implied. It needs a server, but not the one the other integration suites
need: its job downloads no binary and starts nothing, because
`deno task integration` brings up the whole local dev stack itself on a
chosen port offset. Calling that `toolshed` would be wrong, and a lane
that opened a Toolshed server for it would have paid for the wrong thing
and still failed.

### The drift guard

The topology is only worth having if it stays complete. A new test surface
that nobody registers would silently vanish from the full run, which is a
far worse failure than the workflow edit it replaced.

`deno task check-test-topology` closes that, in two halves that catch the
two different ways a surface goes missing.

The **tree half** needs no store and runs on every pull request, in the
`repo-gates` suite marked `mandatory: "always"`. It walks the tree for
things that look like tests — `*.test.ts`, `*.test.tsx`, the integration
directories, the shell scripts under `packages/cli/integration/` — and
fails if any of them is claimed by no suite's `enumerate()`, or by more
than one. This is the half that catches a pull request adding a test
surface nobody registered, at the moment it is added, and it is cheap
enough to be unconditional.

The **store half** runs on `main`. It reads the most recent successful
`main` build's records and fails if any recorded identity is one that no
suite's `locate()` claims. This catches the subtler case: a surface that
is registered and whose files enumerate, but whose recorded names do not
map back to the items they came from — which would leave those tests
running in the full run and never selectable on a pull request.

The reverse direction is reported rather than failed: an item that
`enumerate()` returns and that no run has ever produced a record for is
either a test that never runs or a mapping that is wrong, and both are
worth knowing about without blocking anybody.

Together these are what make "no continuous-integration change needed" a
checked property rather than a hope.

The failure they guard against is not hypothetical either. Until
2026-08-21 the two server-execution ON jobs were the only test jobs in
`deno.yml` with no spool directory and no ship step, so their failures
reached no report and no dashboard, and a census of twenty-five flakes in
that lane had to be reconstructed from raw Actions logs. The fix added a
workflow-shape invariant to `tasks/ci-workflow.test.ts` — every job
writing a JUnit file must spool and ship. Under this design that invariant
mostly stops being needed, because there is one ship step in one job
rather than one per suite, and a suite cannot be added without going
through the topology that the drift guard checks.

## Capabilities and setup

A capability is a named piece of setup with an implementation that is
idempotent and that measures itself. The lane runner computes the union of
the capabilities its batches need, runs each one once, and then runs the
batches.

| Capability | What it does | Measured cost |
| --- | --- | --- |
| `deno` | Toolchain and dependency install | 7–14 seconds, always paid |
| `fuse` | `pkg-config gcc libfuse3-dev fuse3` | 2 seconds warm, about 15 cold |
| `jq` | `jq` | about 2 seconds |
| `browser` | Relaxes the AppArmor user-namespace restriction | under a second |
| `git-history` | Unshallows the checkout | 3–10 seconds |
| `toolshed` | A Toolshed server listening on an allocated port | see below |
| `local-dev-servers` | The whole local dev stack, brought up by `deno task integration` on a chosen port offset | 15–20 seconds |
| `toolshed-baked-on` | The same, from a binary whose shell carries the server-execution define | 42 seconds to build, or 17 to restore |
| `cf` | The `cf` command-line tool on the path | as above |
| `compile-cache` | Restores a pattern compile byte cache | 3 seconds |

Two capabilities are worth explaining, because the choice made for them is
what keeps the five-minute budget reachable.

**`toolshed` runs from source.** Today a job that needs a server downloads
a compiled binary produced by a separate build job. On a pull request that
costs a build job on the critical path — fifty-eight seconds, including
its own setup — plus seventeen seconds of download in each consumer.
Running the server from source with `deno run` skips both. The dependency
graph is already in the Deno cache that the `deno` capability restores, so
starting from source costs a few seconds. The full run on `main` keeps the
compiled-binary path, because it needs the binary anyway for attestation
and deployment.

**`toolshed-baked-on` cannot.** The server-execution ON arm depends on a
compile-time define baked into the browser shell inside the binary, and a
source run cannot reproduce that. So that capability has a different
provider: restore the binary from the Actions cache if the key hits, and
build it in place if it does not. The lane workflow carries one fixed
`actions/cache` step covering a single directory, keyed on a hash of the
sources the binaries are built from. That step is in the workflow rather
than in the runner because the cache service is only reachable through the
action, and it is written once and never touched again.

That split is the argument for having capabilities at all. Two ways of
providing "a Toolshed server" coexist, suites say which one they need, and
neither the workflow nor the other suites know the difference.

### What stays in the workflow

The lane job's steps are fixed and do not vary with what the lane runs:

1. Check out the repository at full depth.
2. Set up Deno.
3. Verify the lock file and install dependencies.
4. Restore the binary cache.
5. Run `deno run -A tasks/ci-lane.ts --lane N --of 5`.
6. Ship test records.

Everything conditional happens inside step 5. That is what makes the
workflow independent of the topology. The one cost is that a capability
which genuinely needs a GitHub Action — and today only the binary cache
does — has to be represented by a fixed step that runs unconditionally and
cheaply.

## What the store gives us and what it is missing

The store gives, for every execution of every test: the identity, the
outcome, the runner's own duration measurement, the commit, the branch,
the workflow run and job, whether the run was a push or a pull request,
whether it came from a fork, and for local runs the reporting person. That
is everything the scoring needs.

The volume is real. The store took eleven thousand four hundred and
thirty-two objects on 2026-08-20, from two hundred and fifty-one workflow
runs, of which about one in six was a push to `main`. Even a three-week
read is a quarter of a million objects. Nothing can afford that on every
publisher run, which is why the publisher keeps a rolling aggregate; see
[The publisher](#the-publisher). How far back each part of the score
reaches, and what a longer reach would cost, is
[its own section](#how-far-back-each-term-looks).

### What the store is missing

**Records do not carry the file for the suites that matter most.** The
`file` field is optional metadata, and today only the package integration
suites populate it, because their JUnit class names happen to be file
paths. A sample of five thousand three hundred and thirty-three unit
records carried it zero times. Without it, `locate()` cannot map a unit
identity to a file, and unit selection cannot work at all.

The reason is mechanical. Deno's JUnit output names a leaf case by its
describe chain and puts the describe chain in the class name too, so
`ingestJUnit` has nothing that looks like a path to join onto its
`filePrefix`. Only file-level suites, where the class name happens to be
the path, come out with a file.

Closing this comes first, and the mechanism that works without touching a
single test file is a preload module. `deno test --preload` already runs
in this repository — `packages/runner` uses it for its fake clock — and a
preload runs before every test module. A module in
`@commonfabric/test-support` wraps `Deno.test`, reads the registering
module out of the stack at registration time, and writes the resulting
name-to-file map into the spool beside the record fragments when the
process unloads.

A file written in the repository's `describe`/`it` style registers exactly
one `Deno.test`, named for its single top-level `describe()`, so the
captured map is from that title to the file. Every leaf identity from that
file begins with the same title followed by the separator, which is the
join `ingestJUnit` performs to set each leaf's file. Two files sharing a
top-level title make the join ambiguous, and that is already a name
collision the report tool surfaces as one.

This was tried before being written down: wrapping `Deno.test` from a
preload works on Deno 2.9.4, the stack names the registering module, and
the unload handler runs.

That covers everything built on `Deno.test`, which is the workspace unit
suites, the runner suite, and the generated-pattern suites. The browser
runner in `packages/deno-web-test/runner.ts` records through
`FragmentWriter` directly and sets the file there. The pattern suites need
nothing: their identity is the path already.

The record schema already carries the field, so no format changes, and
nothing downstream of the store has to know this happened.

**Nothing has compacted a day yet.** The `aggregated/` area is empty and
the compactor principal is not provisioned. Compaction collapses a day of
raw records into one object, which is the difference between reading
eleven thousand objects for a historical day and reading one. The
compactor is already designed and implemented; provisioning it is a small
infra change and this plan recommends doing it, but does not depend on it.

## Scoring

### What the score is trying to measure

A test earns its place in a pull request by having caught real breakage
before. That is a property of the test, not a symptom of a problem: a test
that found a regression once sits somewhere in the code where mistakes get
made, and it will find the next one. Somebody running it locally, finding
it red because of what they were writing, and fixing it, is the clearest
possible evidence — and it says the next person writing similar code
should have that test run for them in continuous integration, whether or
not they thought to run it themselves.

That is a different quantity from "this test is currently flaky", and
scoring the two together was the mistake worth avoiding. A test failing
thirty percent of the time carries almost no information per failure. A
test that has failed four times in two years, each time because somebody
broke something, carries a great deal. Flakiness is dealt with separately,
in [Flakes and repeats](#flakes-and-repeats), where it belongs.

So the score is built on **catches**, and it decays slowly. A test that
caught something two years ago has probably not stopped being a good test.
It might have — the code it guards may have been rewritten, or nobody may
work in that area any more — so the decay is not zero. But it is measured
in months, not days.

### What a catch is

For every failing record, the publisher asks whether the failure says
something about a change or something about the test.

A failure is a **catch** unless one of these holds:

- The identity also failed in the most recent `main` run at or before that
  commit. The test was already broken; this run learned nothing.
- The identity both passed and failed at the same commit. That is a flake
  observation, and it is recorded as one.
- The identity failed across many unrelated branches within the same short
  window. That is the environment or a dependency, not any one change.

What is left is a test that went red where its neighbours were green, and
that is the thing worth counting. Each catch is attributed to the pair of
the commit and the source that saw it, so re-running the same broken
commit ten times counts once.

### Where a catch happened changes what it means

A catch is always a point in the test's favor, and the place it happened
says something further. The three places are worth keeping apart, because
they answer different questions and one of them is the measure of whether
this whole design is working.

A **local catch** is somebody at a workstation, part way through writing
something, running a test and finding it red. It is the highest-quality
evidence this system can receive: no ambiguity about what changed, no
shared infrastructure to blame, and the person went on to fix it. It also
answers the question the score exists to answer — the next person writing
similar code, who will not think to run that test, should have it run for
them. It counts double.

A **pull-request catch** is the test going red on a change before it
landed. That is continuous integration doing its job, and each one is a
measured instance of the selector's own objective being met.

A **main catch** is the test going red on a change after it landed. It is
still a point in the test's favor — the test found something real — but it
is also a record of an escape: this test would have prevented a red `main`
if it had run on that pull request, and it did not. For selecting what to
run on the *next* change, that is the most directly relevant fact there
is, so a main catch is not discounted for having come late.

The distinction that matters most is what repetition means, and it depends
entirely on which of the three is repeating.

A test with a dozen local and pull-request catches over a year is not a
problem. It is one of the best tests in the repository: it keeps finding
things, each time before they reached anybody else, and every one of those
is an argument for running it more widely.

A test with a dozen `main` catches over a year is a different thing. Some
of it is the same fact — the test keeps finding real breakage — but the
pattern also says the same class of mistake keeps reaching `main`, and
either the test is not being run early enough or something about that area
invites the mistake. The first of those is this system's job to fix, and
it fixes it automatically, because main catches raise the score that gets
the test selected.

The aggregate of main catches across all tests is the number that says
whether selecting a subset was a good idea: how often something reaches
`main` that a test we already had would have caught. It goes on the wall
as a system measure, and it is the thing to watch after the lanes go live.

### The inputs

For each identity the publisher computes:

- `catches` — how many catches it has, over all of history, weighted by
  where each happened.
- `mainCatches` — how many of those were on `main`, kept separately
  because they measure escapes as well as the test.
- `lastCatch` — when the most recent one was.
- `sources` — how many distinct sources are among those catches. A source
  is the branch for a continuous-integration run and the reporting
  person's login for a local one, so a test that has caught things on five
  branches and for two people has seven.
- `churn` — recent failures over recent runs, with each day's counts
  halved every fourteen days as they age.
- `flakeRate` — how often it disagrees with itself; see
  [Flakes and repeats](#flakes-and-repeats).
- `mainRed` — whether it failed in the most recent `main` run.
- `cost` — the ninetieth percentile of its measured durations over the
  last seven days. The ninetieth percentile rather than the maximum,
  because one unlucky runner should not permanently inflate an estimate,
  and rather than the mean, because a cost model that under-estimates
  blows the time budget.

### The formula

```text
catches   = 2.0 * localCatches + 1.0 * prCatches + 1.5 * mainCatches

if catches == 0:
    record = 0                       # no lastCatch exists to measure from
else:
    proven    = 1 - 0.5 ** (catches / 2)
    freshness = 0.3 + 0.7 * 0.5 ** (daysSinceLastCatch / 120)
    record    = proven * freshness

value = 0.05 + 0.55 * record + 0.25 * breadth + 0.15 * churn

breadth = 1 - 0.5 ** (sources / 2)   # sources counted among catches, so 0 here
```

The no-catch branch is not decoration. A test with no catches has no
`lastCatch`, so `daysSinceLastCatch` does not exist, and an implementation
that reaches for it anyway gets a missing value rather than a large one.
Multiplying `proven`, which is zero, by a missing number yields a missing
number and not zero, and a missing score sorts unpredictably against real
ones. The branch has to be written, not left to the algebra.

What it guarantees is worth stating exactly, because "scores the floor" is
close to true but not true:

- A test that has **never failed anywhere** scores exactly
  `VALUE_FLOOR`. Every other term is zero by construction: no catches, no
  sources among catches, no recent failures.
- A test with **no catches but recent failures** — every one of them
  classified as flake evidence, or as a continuation of an already-red
  `main` — scores `VALUE_FLOOR + 0.15 * churn`. That is intended, not a
  leak: `churn` is the "something is going wrong right now" term and is
  deliberately independent of whether the failures were catches.

Both are worth a test, and the second one more than the first, since it is
the case where a plausible implementation quietly produces a missing
value.

The three catch weights say what the section above argued. A local catch
counts double for the quality of its evidence. A main catch counts one and
a half times, not because a late catch is better than an early one, but
because it is a recorded instance of exactly the mistake this system
exists to stop making: a test that would have caught something on a pull
request and was not run there. Weighting it up is the feedback loop that
fixes that on its own.

`proven` saturates: one pull-request catch is 0.29, two are 0.50, four are
0.75, and no number of them reaches one. A test that has caught four
separate things is already known to be a good test and a fifth catch
should not let it crowd out everything else.

`freshness` multiplies `proven` rather than adding to it, which is what
makes the decay slow and bounded. A catch last week keeps essentially all
of its value; one from four months ago keeps two thirds; one from two
years ago keeps a little over the floor of 0.3. A proven test never falls
back to being an unproven one, and that is deliberate.

`breadth` is the same saturating shape over distinct sources. Several
people and several branches independently hitting the same test is the
difference between "this test guards something one person touches" and
"this test guards something the team walks into".

`churn` is the only fast-moving term and it carries the least weight. It
is there so that something visibly going wrong right now gets attention
before the slow terms have caught up.

`0.05` is a floor under everything. A test that has never caught anything
scores exactly the floor, and without one its value-per-second would be
zero and it would only ever run through the exploration draw. With it, a
fifty-millisecond test that has never failed has a value-per-second of
one, which beats a hundred-second integration test scoring 0.9 by a factor
of a hundred. That is the right answer, and it is what lets the density
pass sweep up the whole cheap tail.

### How far back each term looks

There is no single window. Each input looks back as far as it stays
meaningful and no further, because they want very different horizons and
one number damages most of them.

| Input | Horizon | Why |
| --- | --- | --- |
| `catches`, `lastCatch` | unbounded | The point of the reframing. A catch is a permanent fact about a test; `freshness` does the discounting, and it does it gently. Cost is a counter and a timestamp per identity. |
| `sources` | unbounded, alongside `catches` | Counted only over catches, so it does not saturate the way a count over all failures would. |
| `churn` | decayed, fourteen-day half-life, read over sixty days | Wants "is this going wrong now". A long undecayed window inverts it; see below. |
| `flakeRate` | 60 days | Flakiness is a property of the test as it stands, and tests get fixed. |
| `cost` | 7 days | Durations drift with the code and the runner image. |

The counts behind `churn` are decayed rather than cut off. That removes
the cliff a hard window has, where a failure on day twenty-one counts
fully and one on day twenty-two counts not at all, and it makes the read
window a performance choice rather than a policy one — past sixty days the
weight is under one part in sixteen.

**Why `churn` must decay.** An identity in the full matrix executes about
two hundred and fifty times a day. Take two tests: A started failing three
days ago and has failed every run since; B was broken for a week eight
months ago, failing about sixty percent of its runs that week, and has
been green since.

| Window | A, failing now | B, fixed eight months ago |
| --- | --- | --- |
| 21 days, undecayed | 750 / 5,260 = **0.143** | 0 / 5,260 = **0.000** |
| 365 days, undecayed | 750 / 91,260 = **0.008** | 1,050 / 91,260 = **0.012** |

Over a long undecayed window the long-dead outage outranks the live
breakage, because a ratio over a long window measures total historical
brokenness rather than the current rate. Decay fixes it without a
cut-off: B's week contributes about one part in five thousand after eight
months. Note that B still scores well overall — its catches are
permanent — which is exactly the intended behavior. What decays is the
claim that something is wrong *now*, not the claim that the test is good.

### Two rules that keep a test out

Both of these are subtractions from the selectable set, and both make pull
requests less red rather than more.

**A test that failed in the most recent `main` run is not selected.** It
is already known to be broken, `main` owns it, and running it on a pull
request would fail that pull request for a reason its author cannot act
on. The exception is a pull request that touches files the failing test
covers, which is very likely a fix and must be allowed to prove itself.

**A test whose flake rate is above the threshold is not selected.** It is
too noisy to judge a change by. `main` still runs it, the dashboard still
shows it, and it appears on a work queue. This replaces the usual
quarantine list, and it is better than one in three ways: it is derived
from measurement rather than from somebody's judgement at one moment, it
needs no owner or expiry to stop it rotting, and it reverses on its own
the moment the test is fixed.

**Neither rule touches an `always` item.** Both exclusions exist to stop a
pull request failing for something its author cannot act on, and both
reason about *tests*, whose individual absence costs one signal. An
`always` item is not that. It is a gate the repository has decided must be
green, and the moment it is red the exclusion would remove it from every
pull request — including the pull requests that are about to make it
worse, and including, in the drift guard's case, the very pull request
that added the unregistered test surface it exists to catch. A guard that
switches itself off exactly when it starts firing is not a guard.

So `always` means always. Two consequences follow and both are intended.
An `always` item red on `main` blocks every pull request until it is
fixed. That is correct: with `deno fmt`, `deno lint`, and the topology
guard, a red one means the tree is broken, the fix is usually a minute's
work, and letting changes pile on top of it is how a minute becomes an
afternoon. And an `always` item above the flake threshold keeps running
rather than being hidden; a gate that is flaky is a defect in the gate,
reported as one on the wall, and concealing it would be worse than the
noise.

What the lane owes people in exchange is clarity about whose problem it
is. A failing `always` item that was already failing in the latest `main`
run is labelled in the job summary as pre-existing, with a link to the
`main` run that first showed it, so nobody spends time looking for it in
their own diff.

### Two rules that force a test in

**An identity with no records must run.** This is not a preference; [the
test-record spec](../specs/test-records.md#trust-boundaries-for-consumers)
requires it of any consumer that selects which tests run, on the grounds
that a selector which never runs the unselected starves its own data and
that a renamed test is an unknown identity until an alias lands. The lane
runner enforces it at item granularity: an item that `enumerate()` returns
and that no known identity maps to is mandatory.

**What the change touches must run.** A pull request that edits a test and
does not run it is not something this repository should permit, so a
changed test file's items are mandatory. A changed *source* file is
handled by the coverage attribution map, which knows which test files
execute which lines: see
[Choosing tests by what the change touches](#choosing-tests-by-what-the-change-touches).

### Renames, and the alias file

Renaming a test used to cost a little history. Under this design it costs
all of it, and the cost falls in the worst possible place.

`catches` accumulates over unbounded history and is the whole of what
makes a test worth running. Rename the test and the store's records still
sit under the old identity, the new name has none, and the best test in
that area drops to the floor — at the exact moment somebody is working
there, since renaming it is what they were doing. A test with four
catches, worth 0.75 on `proven`, becomes worth 0.05. It will still run,
because an unknown identity is mandatory, but only once, and then it
disappears into the tail.

`tasks/test-identity-aliases.jsonl` already solves this and the mechanism
needs no changes. A line maps an old identity, or a whole scope for a
package rename, to its replacement with the date of the rename. Readers
resolve transitively, prefer a full-identity mapping over a whole-scope
one, and apply an alias only to records from days strictly before its
date, so the two halves of a test's history join under today's name.
`deno task check-test-aliases` holds the file to append-only, at most one
mapping per identity, and acyclic. The scope form matters more here than
it looks: the topology keys suites by scope, so a package rename without
one orphans a whole suite's history at once.

What is missing is not mechanism, it is practice. The file is empty. On
2026-08-20 the store recorded `home rehydration churn (persistent
scheduler state) > reloading a populated home stays within one known
conflict`; the tree today has `home rehydration` with two
differently-named cases, and nothing bridges the split. Nobody did
anything wrong — there was no reason to care, because nothing read the
history. Now something does.

Three things follow.

**The publisher resolves through `loadAliasResolver`.** The report tool
and the dashboard collector already do; the publisher must, or the file
accomplishes nothing for selection. One line, and it is a requirement
rather than a nicety.

**The tooling writes the line for you.** Everything needed to spot a
rename is already computed: the drift guard knows which identities the
tree produces and which the store knows, so an identity that vanished from
a file at the same moment an unknown one appeared in it is a rename with
very high confidence. The reporter says so on the pull request, with the
exact line to append, the date filled in, and how many catches it would
preserve. `--explain` answers the same question from the other end: this
identity has no history, and six catches sit under a name that left the
same file in this change.

**Nothing is inferred.** The publisher never bridges a rename on its own,
however confident the evidence looks. A wrong bridge silently credits one
test with another's record, and since the whole score rests on catch
attribution there is no downstream check that would notice. Append-only,
human-authored, dated, and gated on shape is the right shape for a file
whose bad entries are invisible; suggesting a line is help, writing it
unasked is not.

Whether an unbridged rename should ever *fail* a pull request is a dial,
`ALIAS_GATE_MIN_CATCHES`, and it starts switched off. Most renames cost
nothing, because most tests have never caught anything, so a gate that
fired on every rename would be noise nobody reads. A gate that fires only
when real history is about to be discarded would be rare and
proportionate — but it is still a new way to be red, and the honest order
is to see how well the suggestion works before reaching for one.

### The exploration draw

Fifteen percent of each lane's budget is reserved for items that the
value ordering did not pick. The draw is weighted toward items that have
gone longest without running, with random tie-breaking seeded from an
identifier carried in the manifest, so the whole corpus is swept over time
rather than sampled with replacement forever. Preferring the
least-recently-run also means the draw automatically covers whatever the
value model is currently blind to.

The draw prefers items in environments the lane has already opened, so
that exploration is nearly free, and spends a small part of its budget
crossing into an environment nobody opened, so that an entire suite cannot
go unexercised because its setup is expensive.

### Trust, and why local records now matter more

[The spec](../specs/test-records.md#trust-boundaries-for-consumers) says a
decision consumer reads `submissions/ci/` only. This design reads
`submissions/local/` as well, and weighs a local catch double, so the
spec has to be amended in the same change and the reasoning has to be
better than "it seemed useful".

It is this. A local catch is the highest-quality evidence available about
whether a test is worth running. The person was writing code, ran a test,
and it went red because of what they had just written. There is no
ambiguity about what changed, no shared infrastructure to blame, and no
question about whether the failure was real, because they went on to fix
it. Everything the score is trying to measure, that observation measures
directly.

What this costs is that a local record can now displace another test from
a budgeted lane, rather than only ever adding to what runs. Three things
bound that. Local keys are held by people with repository write access,
which is the trust boundary the continuous-integration records already sit
inside. Every manifest records the inputs behind every score, so a strange
selection can be traced back to the records that produced it. And the
worst outcome is a pull request that ran a less useful set of tests, which
`main` catches within about twelve minutes and reports back.

Worth knowing while reading this: `submissions/local/` is empty today.
Nobody has set up a key, so the strongest signal in the design is
currently contributing nothing. `deno task test-records-key setup` is the
whole of what it takes, and this plan is the reason to bother.

### Flakes and repeats

A flake is a test that disagrees with itself. Sometimes that is directly
observable: the same identity, the same commit, one pass and one failure.
The store carries the commit on every context line, so those are found
without any inference at all.

That test misses the case that matters most, though, and missing it would
corrupt the catch count. Every push to `main` is a distinct commit with
one run, so a test that is flaky *on `main`* never produces two
observations at one commit — and every one of its spurious failures would
be counted as a catch. A test failing on `main` a dozen times a year would
then look like one of the most valuable tests in the repository while
being one of the least.

The second rule closes it, and it is the same distinction stated as a
question about what came next. **A failure on `main` that a change fixed
is a catch. A failure on `main` that went away by itself is a flake.**
Concretely: the identity failed at `main` commit C and passed at the next
`main` run, and nothing between the two touched any code the test covers.
The coverage attribution map is what answers "any code the test covers";
without it the fallback is the test's own file and scope, which is
coarser and errs toward calling things catches.

`flakeRate` is the share of a test's failures that fall under either rule.

Two things follow from knowing it.

**Too flaky to judge by, so not selected.** Above the threshold, an item
leaves the pull-request selectable set entirely, for the reason in [Two
rules that keep a test out](#two-rules-that-keep-a-test-out). It keeps
running on `main`, and it keeps appearing on the deflake work queue until
somebody fixes it.

**Below the threshold, some items are run more than once.** Repeats raise
the chance of catching something intermittent: a regression that shows up
in one run out of three is caught a third of the time by one run and
seventy percent of the time by three. Two cases get them:

- An item in a suite whose measured flake rate is high — the browser and
  server-backed suites, where intermittency is the norm — when the item
  itself is new and has no history of its own. The suite's rate is the
  prior; the item's own record replaces it as it accumulates. This is
  mostly a stability check on the new test, and catching a flaky new test
  on the pull request that introduces it is the cheapest possible moment
  to catch it.
- An item whose own flake rate is non-zero but below the exclusion
  threshold, where a repeat is what turns "probably fine" into an answer.

The repeat count comes from the flake rate and is capped, and an item is
only repeated when its cost times the count still fits the budget.

**A repeat is not a retry, and the distinction matters here.** This
repository bans retry loops, because a retry lets something that should
have failed pass on a later attempt, and the error is then missed. Repeats
run the other way: every repeat must pass, and any failure among them
fails the lane. Three runs of a test is strictly stricter than one, never
laxer. Nothing is retried and nothing is masked.

That does mean a flaky item below the threshold fails pull requests more
often in proportion to how often it is repeated. That is the honest cost,
and the exclusion threshold above it is what stops the cost being paid on
tests too noisy to be worth it.

Repeats also generate the cleanest flake data there is — several
observations at one commit in one environment — so the measurement
sharpens itself.

## Packing

### The cost model

A lane's wall time is modeled as:

```text
lane = prologue
     + sum over the capabilities the lane opens of setupCost(capability)
     + sum over the lane's batches of batchCost(batch)

batchCost(batch) = suiteOverhead(suite)
                 + correction(suite) * sum over items of cost(item)
```

The setup costs are the table in
[Capabilities and setup](#capabilities-and-setup).

`suiteOverhead(suite)` and `correction(suite)` are the two numbers that
make this work without constant tending, and they are fitted from
observation rather than written down. A suite's items do not cost what the
runners measured them at: suites run their items in parallel to differing
degrees, and they carry startup costs the per-test measurements never see.
In the reference build the workspace unit shard `Test (6/8)` executed
eight hundred and five seconds of measured test time inside about three
hundred seconds of work, so its correction is around 0.37. `Runner Tests
(2/8)` executed sixty-six seconds of measured test time in a job that took
two hundred, almost all of it module loading, so its overhead is large and
its correction is nearly irrelevant. No static model captures both cases.

So the model is fitted instead. Every batch the lane runner executes
records what it was planned to take and what it actually took. The
publisher regresses those pairs per suite over the last week — the
intercept is `suiteOverhead`, the slope multiplies into `correction` — and
publishes the result in the next manifest. Both start at zero and one
respectively, and converge within a few days of lanes running. Two numbers
per suite, both measured, neither maintained by hand.

The measurements travel through the machinery that already exists: the
lane runner writes them as ordinary test records of kind `gate` and scope
`ci`, named `ci-lane setup <capability>` and `ci-lane batch <suite>`. They
ship in the lane's normal test-records artifact, the relay stores them
like anything else, and the publisher reads them with the same reader it
uses for everything else. No new pipeline, and the numbers show up in the
existing dashboards for free.

### The budget, and why it is derived rather than chosen

The five-minute bound is the constraint; everything else follows from it,
and the budget the packer fills is what is left after the parts the packer
does not control.

```text
LANE_BOUND_SECONDS      300   the hard bound on the work step
LANE_PROLOGUE_SECONDS    40   checkout, Deno, cache restore, ship, job overhead
LANE_SAFETY_SECONDS      30   headroom for a slower-than-usual runner

LANE_BUDGET_SECONDS = 300 - 40 - 30 = 230
```

`LANE_BUDGET_SECONDS` is a derived value rather than a dial of its own,
which is what stops the three drifting apart into a budget that cannot fit
inside its own bound. It covers **everything inside the work step**: the
capability setup the lane opens and the batches it runs. Capability setup
is charged against it as the initial load when the lanes are packed, so a
lane that opens the Toolshed server has forty fewer seconds for tests than
one that does not, and the packer knows that while it is choosing.

The prologue is measured rather than assumed. The lane records it the same
way it records everything else, and the publisher feeds the observed value
back, so a slower checkout narrows the budget rather than silently eating
the safety margin.

The three numbers are the only place the five-minute promise lives. Raise
`LANE_BOUND_SECONDS` and the workflow's timeout anchors have to move with
it — `LANE_WORK_TIMEOUT_MINUTES`, and `LANE_JOB_TIMEOUT_MINUTES` ten
minutes above it, both checked by `tasks/ci-workflow.test.ts` — so the
dial's comment says so and the publisher refuses to emit a manifest whose
budget does not fit its bound.

### Choosing what to run

The packer starts by removing what must not run: items failing in the
latest `main` run, and items above the flake exclusion rate. Both are
listed in the job summary, so what was withheld is visible rather than
quietly absent.

From what is left, given every item's value and cost and a budget of five
lanes times two hundred and thirty seconds each, it fills in four passes.

1. **Mandatory.** Everything marked mandatory goes in first: the `always`
   suites, the items the diff touched directly, the items the coverage
   attribution map says execute the changed lines, and the items with no
   history. An item excluded above comes back into this pass if the change
   touches what it covers, since that is very likely a fix. This pass can
   in principle exceed the budget; when it does, the runner says so in the
   job summary rather than silently dropping work.
2. **Value first, sixty percent of the remaining budget.** Items in
   descending order of value, ignoring cost. This is what gets the
   expensive, genuinely broken integration test into the run.
3. **Density, twenty-five percent.** Items in descending order of value
   divided by cost. Because of the value floor, this pass sweeps up the
   cheap tail: thousands of sub-second tests at a value-per-second that
   nothing expensive can match.
4. **Exploration, fifteen percent.** The draw described above.

Passes 2 and 3 both account for the setup a choice would open. An item
whose suite needs a capability no lane has opened is charged the
capability's setup cost the first time it is picked, so a lone cheap test
behind forty seconds of setup correctly loses to forty seconds of tests
that need nothing.

Repeats are applied last, to items already selected, and are charged their
full cost. An item that would be repeated but no longer fits runs once
rather than being dropped: one observation beats none.

### Filling the lanes

Once the set is chosen it is packed into five lanes by longest-processing-
time scheduling, which is what `tasks/weighted-shards.ts` already
implements and what the existing shard selectors already use. Batches are
the units being packed and capability setup costs go in as the initial
loads, so a lane that has already opened the Toolshed server is the
cheapest place to put the next batch that needs it. That is the mechanism
by which "tests needing the same environment are grouped together" falls
out of the packing rather than being a special case in it.

A batch that on its own exceeds a lane's budget is split, paying its
suite's setup twice. A single *item* cannot be split, so an item costing
more than the planned budget is given a lane to itself and allowed to run
up to the hard five-minute bound rather than the planned two hundred and
ten seconds. The largest item in the reference build was `integration.sh
piece-call` at two hundred and seventeen seconds, which clears the planned
budget but sits inside the bound with its setup — so today nothing is
strictly unschedulable, and the margin is thin enough that one more slow
step would change that. The manifest carries an `unschedulable` list for
items that do not fit, the report tool surfaces it, and the fix is the
sixty-second rule that
[`tasks/test-records-report.ts`](../development/test-records.md#reading-the-data)
already ratchets. Fourteen tests currently break that rule and they hold
seventeen percent of all measured test time; getting them split is
valuable independently of this plan and becomes more valuable with it.

### Why there is no coordination job

The five lanes do not talk to each other and there is no sixth job to tell
them what to do. Packing is a pure function of the manifest, the diff, and
the lane number, and all five lanes run the same function over the same
inputs, so they agree by construction. Adding a mandatory item is part of
that function, so the five agree about where it lands too.

The function must therefore be deterministic: no wall clock, no unseeded
randomness, no dependence on anything but its inputs. The exploration
draw's seed comes from the manifest. `plan()` lives in
`tasks/test-selection/plan.ts`, is called by both the publisher and the
lane runner, and is straightforwardly testable offline against a recorded
manifest.

Re-running a single failed lane later must not shuffle the work. The lane
resolves the manifest as *the newest one generated at or before the
workflow run's start time*, which GitHub exposes as `run_started_at` and
which is constant across re-runs of the same run.

## What we expect this to select

Working from the reference build's numbers, and from the budget in [The
budget, and why it is derived rather than
chosen](#the-budget-and-why-it-is-derived-rather-than-chosen).

Five lanes at two hundred and thirty seconds inside the work step is
eleven hundred and fifty seconds. Capability setup takes perhaps two
hundred of that across the five, leaving around nine hundred and fifty
seconds of test execution.

The sub-second tail is fourteen thousand seven hundred items holding about
nine hundred seconds of measurement. Almost all of it is unit tests, which
a lane gets through about two and a half times faster than their summed
measurement and which need no setup beyond the toolchain, so the tail
costs something like three hundred and sixty seconds of lane time. **The
entire cheap tail fits in under half the budget.**

The remaining five hundred and ninety seconds buy from the sixteen hundred
and thirty items over one second, whose full cost is seven thousand eight
hundred and ninety seconds of measurement. Some of those are parallel unit
tests and some are serial integration tests, so at a blend those five
hundred and ninety seconds buy somewhere between five hundred and ninety
and fifteen hundred seconds of measurement — call it nine hundred, or
roughly a ninth of the expensive head, chosen by value.

That is the expected steady state: a pull request runs around ninety
percent of the test *count* and around a fifth of the test *time*. Each
lane finishes in about four and a half minutes — two hundred and seventy
of the three hundred seconds the bound allows — and because the five run
in parallel that is also roughly the end-to-end figure, against today's
twelve and a half minutes across sixty-seven runners.

### Where the slack is

Four assumptions carry that arithmetic, and they are not equally solid.
Naming which one gives first matters more than the total, because the
total is what gets checked against the bound.

The **thirty-second safety margin** is the intended slack and the first
thing spent. It exists so that a slow runner or a cold cache pushes a lane
from four and a half minutes to five rather than past it.

The **two-and-a-half-times execution rate** for the cheap tail is the
weakest assumption in the document. It comes from one shard of one build,
where `Test (6/8)` got through eight hundred and five seconds of measured
tests in about three hundred seconds of work. Another shard in the same
build managed far less, because module loading rather than test execution
dominated it. If the true blended rate is two rather than two and a half,
the tail costs four hundred and fifty seconds instead of three hundred and
sixty and the head's share shrinks by a fifth. The lanes still fit; less
runs in them. This is exactly what `correction(suite)` is fitted for, and
it is the number to watch first.

The **forty-second prologue** is measured from real builds and is the most
solid of the four, and it is measured again continuously once lanes are
live.

The **conversion of the expensive head** is a range, not a figure, because
it depends on which items get picked, and the range is wide: between five
hundred and ninety and fifteen hundred seconds of measurement for the same
lane time. The "roughly a ninth" is the middle of it and should be read as
such.

Two further things push the other way and are not in the figures at all.
Repeats charge their full cost, so a lane carrying several repeated
browser items has less room for everything else. And the two exclusion
rules take items out of the selectable set entirely, which frees budget
rather than consuming it.

These are projections from a single build and they should be read as such.
The calibration loop is what turns them into measurements, and the first
thing to look at once the lanes are live is whether they hold.

## The manifest

The manifest is one gzipped JSON object per publisher run, created —
never overwritten — under a new dataset area beside the records:

```text
labs/test-selection/v1/manifest-<ISO 8601 timestamp>-<ULID>.json.gz
labs/test-selection/v1/state/<yyyy-mm-dd>-<ULID>.json.gz
```

Write-once naming is not a stylistic choice: the store's writer
credentials hold `objectCreator` and nothing else, cannot overwrite, and
that is the property that makes the whole store trustworthy. So there is
no `current.json`. A reader lists the prefix, which sorts by timestamp
because the timestamp leads the name, and takes the newest that is not
after the time it is asking about.

The object carries:

- the schema version, the generation time, and the exploration seed;
- the `main` commit whose topology was enumerated, and how many runs the
  aggregate saw;
- every dial it was built with, so the manifest explains its own
  behavior and two manifests can be diffed for why they differ;
- the calibration numbers: `setupCost` per capability, and
  `suiteOverhead` and `correction` per suite;
- every item: its identity or identities, its suite, its file, its cost,
  its score, the inputs behind that score, its flake rate, and its
  repeat count;
- the withheld sets — failing on `main`, and above the flake exclusion
  rate — each with the reason, so a lane can say why something is absent;
- the reference packing into five lanes;
- the `unschedulable` list;
- a count and digest of the known identities, for the unknown-item rule;
- the name of the newest coverage attribution map, which is published
  beside the manifest on its own weekly cadence rather than inside it.

At sixteen thousand items and roughly two hundred bytes each that is
about three megabytes, well under a megabyte gzipped, which is a single
fetch of no consequence at the start of a job.

The manifest is untrusted input to the lane runner, and is validated the
same way record lines are: a malformed manifest is rejected whole, and a
manifest whose schema version the runner does not know is treated as
absent. Retention is a bucket lifecycle rule deleting manifests after
thirty days, which the infra change adds.

## The publisher

`.github/workflows/test-selection.yml`, on a four-hourly cron and on
manual dispatch. Four hours rather than a fixed daily hour: aggregation is
incremental and therefore cheap, and a flake that appears at nine in the
morning should not wait until four the next morning to be prioritized.
Manual dispatch is there so that somebody who has just fixed something can
refresh without waiting.

The job:

1. Reads the newest state object, which holds, per day in the window, the
   set of workflow run identifiers already folded in and the aggregate
   they produced.
2. Lists each day's prefix and fetches only the objects whose run
   identifier is not already in that day's set. Object names carry the run
   identifier, so this is exact rather than a timestamp heuristic, and it
   handles a relay re-ship of an old run correctly. In the steady state
   this is about two thousand objects per run.
3. Folds them in, ages the decayed counters by a day, classifies each new
   failure as a catch or as flake evidence, scores everything, reads back
   the lane timing records to update the corrections, calls `plan()` with
   an empty diff to produce the reference packing, and writes a new state
   object and a new manifest.
4. Reports, in the job summary, the projected per-lane times, the spread
   between them, what fell off the budget, and anything unschedulable.

A cold start cannot read a quarter of a million objects in one job. The
bootstrap is a manual dispatch with `--bootstrap --days 60` and high
concurrency, run once; after that the incremental path keeps up. If the
compactor is provisioned first, the bootstrap reads fifty-three rollup
objects and seven days of raw records instead, which is a much better
starting position, is the reason to do it in that order, and is what makes
any horizon longer than this one affordable later.

The publisher needs a writer credential for its own prefix. That is a new
service account with `objectCreator` on `labs/test-selection/`, reached
through a Workload Identity provider pinned to exactly this workflow file
on `main` — the same pattern, and the same security argument, as the relay
already uses. It is an infra-repository change under `tofu/test-records`,
and it must land and be applied before this workflow can do anything. It
is the one prerequisite [the work](#the-work) has that is not ours.

When the publisher fails, nothing breaks: the previous manifest is still
the newest and lanes keep using it. A manifest going stale degrades
selection quality slowly rather than failing anything, which is the right
direction for a system nothing should gate on.

## The lane job

```yaml
pr-tests:
  name: "PR Tests (${{ matrix.lane }}/5)"
  if: >-
    github.event_name == 'pull_request' &&
    !contains(github.event.pull_request.labels.*.name, 'ci: full')
  runs-on: ubuntu-latest
  timeout-minutes: *lane-job-timeout
  env:
    CF_TEST_RECORDS_DIR: ${{ github.workspace }}/test-records-spool
  strategy:
    fail-fast: false
    matrix:
      lane: [1, 2, 3, 4, 5]
  steps:
    - name: 📥 Checkout repository
      uses: actions/checkout@v7
      with:
        fetch-depth: 0
    - name: 🦕 Setup Deno
      uses: ./.github/actions/deno-setup
    - name: 🔍 Verify lock file & install dependencies
      uses: ./.github/actions/deno-install
    - name: ♻️ Restore the built-binary cache
      uses: actions/cache@v4
      with: { path: .ci-cache/binaries, key: ... }
    - name: 🧪 Run the lane
      timeout-minutes: *lane-work-timeout
      run: >-
        deno run -A tasks/ci-lane.ts
        --lane ${{ matrix.lane }} --of 5
        --base origin/${{ github.base_ref }}
        --run-started-at ${{ github.run_started_at }}
    - name: 📤 Ship test records
      if: always()
      uses: ./.github/actions/test-records-ship
      with:
        artifact: pr-lane-${{ matrix.lane }}
        job: PR Tests (${{ matrix.lane }}/5)
```

The full-depth checkout and the `origin/<base>` spelling are what the
`pattern-vintage` job already does to diff against the merge base, so the
mechanism is proven in this workflow rather than newly invented here.

Two new timeout anchors join the block at the top of the file:
`LANE_WORK_TIMEOUT_MINUTES` at five and `LANE_JOB_TIMEOUT_MINUTES` at
fifteen, satisfying the repository's rule that a job's bound is at least
ten minutes above its work step's. `tasks/ci-workflow.test.ts` enforces
that rule and needs the new anchors added to it.

The ship step carries no `--junit` specification, which is the last piece
of per-suite knowledge to leave the workflow. Instead the lane runner
ingests each batch's JUnit output into the spool itself, through
`ingestJUnit`, using the kind, scope, and prefix the topology already
declares. `tasks/workspace-tests.ts` already does exactly this, so the
path is proven.

What the runner does, in order:

1. Fetch the newest manifest at or before the run's start, and the
   attribution map it names. On failure, fall back (see [Failure
   modes](#failure-modes)).
2. Enumerate every suite against the working tree.
3. Compute the diff against the merge base, and resolve the changed source
   lines through the attribution map to the items that execute them.
4. Call `plan()`, take this lane's plan.
5. Print the plan to the job summary: which batches, which items, what
   each is expected to cost, why each was chosen, which items were
   withheld and why, and which manifest the plan came from.
6. Set up the union of the capabilities the batches need, recording each
   one's duration.
7. Run each batch, repeated items included, recording planned and actual
   durations, and continuing past a failing batch so that one failure does
   not hide the others.
8. Ingest JUnit output into the spool, and write the diff-coverage figure
   for the reporter to pick up.
9. Exit non-zero if any batch failed, or if any repeat of any item failed.

## The full run on `main`

A push to `main` still runs everything, and it runs it through the same
topology so that the two paths cannot drift.

`deno.yml` gains a small `plan-full` job that runs on push, calls the
topology, packs every item into as many lanes as a ten-minute budget
needs, and emits the result as a job output. A `full-tests` job consumes
it with `strategy.matrix: fromJSON(...)` and runs the same
`tasks/ci-lane.ts` with `--full`. The build, attestation, coverage and
deploy jobs keep their present shape and depend on `full-tests` in place
of the long dependency lists they carry today.

The full run's packing needs durations but no selection, so it reads the
manifest for its cost table. When the store is unreachable it falls back
to one lane per suite: less even, still complete, and requiring no
committed weight table to maintain.

### Running everything on a pull request

Label a pull request `ci: full` and the same `plan-full` and `full-tests`
jobs run on it, so opting out of selection runs exactly what `main` runs
rather than an approximation of it. A label rather than a phrase in the
description, because a label can be added and removed without a push and
re-runs pick it up.

**The five lanes do not run when the label is present.** One or the other,
never both. Running both would contradict the five-job contract, and it
would not be an opt-out at all — a pull request could still be blocked by
the selection path it had just asked to be excused from, which is the
opposite of what somebody reaching for the label wants. So `pr-tests`
carries `if: !contains(...)` and the two full-run jobs carry the converse,
and exactly one path runs.

The cost is that a labelled pull request stops exercising the selection
path. That is acceptable because the label is rare, `main` exercises the
lane runner continuously through `full-tests`, and `plan()` — the part
that differs between the two — is a pure function with its own tests and a
`--dry-run` mode.

`Status` grows one piece of logic it does not have today. Its rule is
currently "fail unless every dependency succeeded", and skipped counts as
not-succeeded. It becomes:

- every dependency is `success` or `skipped`, **and**
- at least one of `pr-tests` and `full-tests` is `success`.

The second clause is not tidiness. Without it, a state in which both are
skipped — a mislabelled pull request, a workflow-level condition that
excludes both, a future edit that gets an `if:` wrong — reports a green
`Status` on a pull request that ran no tests at all. That is the one
failure mode of this whole design that would be silent, so it is asserted
directly rather than reasoned about.

The natural users are a change nobody wants to be wrong about, a change to
the topology or to the test machinery itself, and the moment somebody
wants to know whether a lane failure is real.

### What moves to `main`, and what happens to coverage

`Status` is a pull-request check and its `needs:` list becomes `pr-tests`
and `full-tests`, with the two-clause rule above.

Coverage measurement moves to the full run and stops gating anywhere; the
design is in [Coverage](#coverage). Concretely: the `Coverage Check` job
becomes push-only and reports rather than fails, the compile-cache state
recording that feeds it moves with it, and `coverage-comment.yml` is
generalized into the reporter described in [Telling a pull request what
`main` found](#telling-a-pull-request-what-main-found) rather than
deleted — it already does the hard part, which is posting to a pull
request from a trusted context with a write token.

## Coverage

Coverage gating cannot survive selection, and saying so is not the same as
giving up on coverage. The gate compares a pull request's measured
coverage against a `main` baseline; a pull request that runs a fifth of
the test time measures a fifth of the coverage and reads as a catastrophe
every single time. There is no threshold that rescues that comparison,
because the thing being compared is no longer the same thing.

What the gate was actually for is worth separating from how it worked. It
was there so that coverage keeps going up, or at least stops going down
quietly. That goal survives; only the mechanism has to change.

### Coverage is a trend, not a gate

Coverage debt is measured on `main`, from the full run, and it is not a
gate anywhere. Not on pull requests, where it cannot be measured, and not
on `main`, where a red build for one uncovered line would make `main`'s
color mean nothing.

It becomes a dashboard tile instead, and the tile follows [the wall's
rules](../../packages/dashboard/README.md#philosophy-and-values). It shows
the direction over weeks rather than a number, because a coverage
percentage is exactly the kind of figure that stops meaning anything the
moment somebody optimizes for it. It goes amber when debt has risen
steadily for several weeks, not when it rose once. And it reports on the
system: no per-person anything, no ranking, nothing that could be read as
a scoreboard.

The `ACCEPT_COVERAGE_DEBT` markers stay. They are how somebody says "yes,
knowingly", and they remain the right escape hatch whether or not anything
gates on them.

### Coverage attribution, and what it unlocks

Deno writes one coverage profile per pair of test file and source file. A
test file that exercises a source file produces a profile naming that
source and counting only what that test file reached. This was checked
rather than assumed: two test files touching different functions of one
module produce two separate profiles for that module, with the counts
correctly separated, and it holds under `--parallel`.

The profiles carry no marker saying which test file produced them, so
attribution needs one coverage directory per test file, which needs one
`deno test` invocation per test file. At two thousand test files that is
around three and a half hours of runner time — impossible per run, and
entirely affordable as a weekly job sharded across the same lane
machinery. Pattern coverage needs none of this: `cf test` already writes
one coverage file per test.

What that buys is an **attribution map**: for every source line, the test
items that execute it. Published beside the manifest, refreshed weekly,
and stale in exactly the way a weekly map is stale — which is fine,
because it is used to *add* tests to a run, never to remove them.

### Choosing tests by what the change touches

With the map, a pull request's changed source lines resolve to the test
items that execute them, and those items become mandatory. This is the
thing today's continuous integration cannot do at all, and it makes a
selected run better at its actual job than a scope-based guess would be: a
change to one function in `packages/runner` runs the tests that execute
that function, rather than a sample of the six hundred and fifty-five test
files in that package.

Without the map — before it is first built, or for a brand-new source file
nothing covers yet — the fallback is the scope-level boost the score
already carries, and an uncovered new file is reported rather than
silently passed over.

### Diff coverage on a pull request, as information

The same map gives a number worth showing without gating on it: of the
lines this change adds or modifies, how many did the tests that actually
ran execute?

That number needs no baseline, which is what makes it survive selection.
It is a floor rather than a verdict — some tests that cover those lines
were not selected — and the comment says so. It appears as part of the
reporter's comment, framed as what it is: here are the lines your change
added that nothing ran, and here are the test files that cover the lines
next to them, which is where a new test would most naturally go.

This is the piece that replaces the gate's actual function. A gate told
people they had failed; this tells them where a test would go. The second
is more likely to produce a test.

## Telling a pull request what `main` found

Selection means some regressions land and `main` catches them. That is the
trade, and it is only acceptable if the change that caused it finds out
without anybody having to go looking.

A reporter workflow follows every `main` run to completion, in the
base-repository context with a write token, exactly as
`coverage-comment.yml` already does for the coverage comment. The repository
squash-merges with the pull request number in the subject, so the pull
request behind a `main` commit is unambiguous.

It comments once, on that pull request, when the run found something the
pull request's own run could not have:

- **A test that failed for the first time at this commit.** Precisely
  that: the identity passed in the previous `main` run and failed in this
  one. Attribution comes from the store rather than from an assumption,
  which is what stops the comment landing on whoever merged next after
  somebody else broke something.
- **Whether that test was selected on the pull request.** Only this system
  can answer it, and the answer changes what to do. Not selected is the
  expected cost of selection, and the failure will raise the test's score
  so the next change in that area runs it. Selected and passing is a flake
  or an interaction between changes, and it is a different conversation.
- **A coverage debt increase above the threshold**, with the lines and
  where a test would go. Never as a failure — the run is green — and never
  for one line.
- **A new test that turned out to be flaky**, when a test the pull request
  added has since disagreed with itself.
- **A rename that discarded history**, with the alias line to append and
  the number of catches it would bring back. See [Renames, and the alias
  file](#renames-and-the-alias-file).

### Keeping this on the right side of the line

The wall's rule is "report on the system, never on individuals: no
per-person leaderboards, no 'who broke the build', nothing that turns the
wall into a place to rank or shame people." A comment naming the change
that introduced a regression is close enough to that line to be worth
being deliberate about which side it is on.

It sits on the right side, and these are the properties that keep it
there, each of which is a constraint on the implementation rather than an
observation about it:

- **It addresses the change, not the person.** The comment's subject is a
  commit and a test. No author is named, no author is mentioned; GitHub's
  own subscription is what delivers it, the same as any other comment.
- **Nothing is aggregated, ever.** No count of regressions per author, per
  team, or per anything. No history. The comment exists on the pull
  request and nowhere else, and no tile, report, or query rolls them up.
- **It is not a judgement, because the system chose not to run the test.**
  When a test was not selected, the honest statement is that this design
  traded that coverage away, and the comment says so in those words. The
  author did not miss anything; the selector did.
- **It is accurate about flakes.** A test with a known flake rate is
  labelled as one, so nobody is told they broke something that breaks on
  its own.
- **It is actionable and it ends.** Every comment says what to do, and it
  is edited in place rather than repeated when the same thing recurs.

If it ever stops being all five of those, it should be removed rather than
tuned. A notification people learn to resent is worse than no
notification, for the same reason a wall of red tiles is worse than no
wall.

## Consequences we are choosing

These follow from the design rather than from any detail of it, and they
are the substance of the decision.

**More breakage reaches `main`.** A pull request that breaks a test the
selector did not pick will merge, and `main` will go red about twelve
minutes later. That is the trade. What makes it bearable is that the blast
radius is one commit, the full run names the test, the change that caused
it gets told without anybody going looking, and the failure raises that
test's score so the next change in that area runs it. If the rate turns
out to be intolerable, the escape hatch is a merge queue, which restores
the guarantee at the cost of merge latency. This plan does not propose
one; it notes that the option exists and that nothing here forecloses it.

**Pull requests should get *less* red, not more.** This is the opposite of
what an early draft of this design predicted, and the difference is the
two exclusion rules. A test that is currently failing on `main` is not
selected, so nobody's pull request fails for a break somebody else landed.
A test too flaky to judge by is not selected either. What is left to block
a pull request is stable tests with a record of catching real things —
which is the only category where a red build is worth having. Set against
that, a flaky-but-not-excluded item repeated three times fails three times
as often as it would have. The net is an empirical question and the
dashboard is where it gets answered.

**Whether this was a good idea is measurable, and the measurement exists
before the change does.** The escape rate — how often something reaches
`main` that a test the repository already had would have caught — can be
computed from the store today, while pull requests still run everything.
That gives a baseline taken under the old regime to judge the new one
against, rather than a number that only starts existing once there is
nothing to compare it to.

**Coverage stops being enforced.** Nothing will fail because a change
lowered coverage. What replaces it is a weekly trend somebody has to
choose to look at, plus a comment that says where a test would go. That is
a real reduction in enforcement, and it is deliberate: the alternative was
a gate that had stopped measuring what it claimed to. If debt starts
climbing, the response is a conversation about the trend, not a
reinstated gate on a number that can no longer be measured per change.

**A developer whose pull request fails on a test they did not touch needs
a way forward.** The job summary names every item the lane ran and why it
was chosen — the catches behind its score, the change that made it
mandatory, or the exploration draw — which makes "this is not mine" a fast
conclusion rather than a guess. `--explain` answers the same question for
any identity. Re-running the lane runs the same set, because the manifest
is pinned to the run's start time. And if none of that settles it,
`ci: full` runs everything.

## Failure modes

| What goes wrong | What happens |
| --- | --- |
| The store is unreachable from a lane | The lane runs the mandatory set plus a deterministic slice of the corpus sized to its budget, prints that it is running unselected, and passes or fails on that. Pull requests keep flowing. |
| The publisher has not run for a day | Lanes use the last manifest. Selection quality decays slowly; nothing fails. |
| The manifest is malformed or a newer schema | Rejected whole, treated as absent, same path as unreachable. |
| A selected item no longer exists in the tree | Dropped with a line in the summary. A renamed test is simultaneously an unknown item, so it runs anyway. |
| A new test surface nobody registered | `check-test-topology` fails on the next `main` run and names the unclaimed identities. |
| One item is bigger than a lane's planned budget | It gets a lane to itself, up to the hard five-minute bound. Bigger than that and it is listed as unschedulable in the manifest and reported; the sixty-second ratchet is the fix. |
| The mandatory set alone exceeds the budget | The lane runs it anyway and over-runs, up to the five-minute step bound. The summary says by how much. |
| A lane exceeds five minutes repeatedly | The correction factors rise on the next publisher run and less is packed. If it persists, the publisher's summary shows the miss and somebody looks. |
| A fork pull request | Works unchanged. The manifest is world-readable, and the existing member gate decides whether the fork's records ship. |
| A re-run of one failed lane | Runs the same set, because the manifest is resolved by the run's start time. |
| Both `pr-tests` and `full-tests` skip | `Status` fails. Its second clause requires one of them to have succeeded, so a pull request that ran no tests can never report green. |
| An `always` item is red on `main` | Every pull request fails on it, deliberately, and the job summary says it was already red and links the `main` run. See [Two rules that keep a test out](#two-rules-that-keep-a-test-out). |
| `main` is broken and stays broken | Every test failing in the latest `main` run leaves the selectable set, so pull requests are unaffected while it is fixed. They come back on their own. |
| The reporter cannot find the pull request behind a `main` commit | It logs the commit and posts nothing. A direct push to `main` with no pull request behind it is the ordinary case for this. |
| The reporter would comment on a test that is known flaky | It says so in the comment rather than implying the change caused it. |
| The attribution map is stale or missing | Changed-source selection falls back to the scope-level boost, and the diff-coverage figure says it is a floor. The map only ever adds tests to a run. |
| Somebody games the coverage number | There is nothing to game: no gate, no per-change target, and a tile that shows a multi-week direction rather than a figure. |

## Security and trust

The manifest can only change *which* tests run. It cannot change what a
test does, what a test asserts, or what the repository builds. The worst a
corrupted manifest achieves is a pull request that ran fewer tests than it
should have, which the full run on `main` catches. That bounds the whole
attack surface, and it is why the manifest is allowed to be an ordinary
public object rather than a signed artifact.

Write access to the manifest prefix is one service account reachable only
through a Workload Identity provider pinned to one workflow file on
`main`, exactly as the relay is. Nothing else in the organization can
write there, and the account cannot read, list, overwrite, or delete.

The lane runner treats the manifest as untrusted input and validates it
whole. The only field that reaches a shell is a suite identifier, which is
matched against the topology's own list rather than interpolated.

## Testing this

A system that decides which tests run is one whose own bugs are quiet, so
it is worth saying up front how each part is held down.

`plan()` is a pure function and gets the most attention: recorded
manifests become fixtures, and the properties worth asserting are that the
five lanes partition the selected set with no item in two lanes and none
in none, that every mandatory item appears, that no lane's projected time
exceeds its budget unless a single item forces it, that the same inputs
give the same output every time, and that a manifest naming suites the
topology does not have is rejected rather than partly obeyed.

Scoring and catch classification are tested against synthetic record sets
where the right answer is known by construction. A failure at a commit
where `main` was already red is not a catch. A failure at a commit that
also has a pass is flake evidence, not a catch. A failure on `main` that
the next `main` run passes with no intervening change to covered code is
flake evidence; the same failure with a fix in between is a catch, and
that pair is the one worth writing first, because getting it wrong turns
a test that is flaky on `main` into the highest-scoring test in the
repository. A failure appearing on eleven branches within an hour is
environmental, not eleven catches. A test with four catches from two years
ago still outranks a test with none. An identity that has never failed
anywhere scores exactly `VALUE_FLOOR`, and one whose only failures were
classified as non-catches scores the floor plus its churn term and never a
missing value. And an identity absent from the store comes out mandatory.

Each suite's `enumerate()` and `locate()` get their own tests, and
`check-test-topology` is the integration-level check that they are
complete against what really ran.

The reporter's attribution is where a bug would be most costly, because a
wrong comment lands on a person. It is tested against recorded pairs of
consecutive `main` runs, and the property that matters is the negative
one: a test already failing in the previous run produces no comment, so a
break never gets attributed to whoever merged next.

The lane runner grows three operator modes, which are also how it is
tested by hand:

- `--dry-run` prints the plan — batches, items, repeats, capabilities,
  projected times, and what was withheld — and runs nothing. This is what
  somebody uses to answer "what would lane three do on my branch?".
- `--explain <identity>` prints one test's score, the catches behind it
  with their dates and sources, its flake rate, which item it maps to, and
  whether the current manifest selects it, withholds it, or repeats it.
  This is what somebody uses to answer "why did my test not run?", which
  is the question this system will be asked most often and the one it
  would otherwise answer badly.
- `deno task test-selection dials` prints every dial with its comment and
  current value.

## Every dial in one place

`tasks/test-selection/policy.ts` holds every number this design can be
tuned by, and nothing else holds any of them. Each is a named export with
a comment saying what it does, which way to move it, and what moving it
costs. `deno task test-selection dials` prints the current values with
those comments, and every manifest records the values it was built with,
so a manifest is self-describing and a change in behavior can always be
traced to a change in a dial.

| Dial | Default | Turn it up when |
| --- | --- | --- |
| `LANES` | 5 | Pull-request feedback is too thin, and runner capacity allows more. |
| `LANE_BOUND_SECONDS` | 300 | More should fit in a lane. Moving this means moving `LANE_WORK_TIMEOUT_MINUTES` and `LANE_JOB_TIMEOUT_MINUTES` in `deno.yml` with it. |
| `LANE_PROLOGUE_SECONDS` | 40 | Measured, not chosen; the publisher overwrites it from the lanes' own timing records. |
| `LANE_SAFETY_SECONDS` | 30 | Lanes are overrunning their bound on slow runners. Down when they finish early every time. |
| `FULL_LANE_BUDGET_SECONDS` | 600 | `main`'s runs are using more jobs than they need to. |
| `FULL_RUN_LABEL` | `ci: full` | The label that swaps the five lanes for the full run. |
| `VALUE_FLOOR` | 0.05 | The cheap tail is not being swept up. Down when it crowds out proven tests. |
| `WEIGHT_PROVEN` | 0.55 | A test's record of catching things should count for more. |
| `WEIGHT_BREADTH` | 0.25 | Tests several people hit should count for more. |
| `WEIGHT_CHURN` | 0.15 | Something going wrong right now should jump the queue faster. |
| `PROVEN_SATURATION` | 2 catches | One catch should be worth more, or less, relative to four. |
| `FRESHNESS_HALF_LIFE_DAYS` | 120 | Old catches should keep more of their value. |
| `FRESHNESS_FLOOR` | 0.3 | A very old catch should keep more, or less, of its worth. |
| `CATCH_WEIGHT_LOCAL` | 2.0 | Evidence from a workstation should count for more. |
| `CATCH_WEIGHT_PR` | 1.0 | The unit the other two are expressed against. |
| `CATCH_WEIGHT_MAIN` | 1.5 | Escapes should pull harder on what gets selected next. |
| `CHURN_HALF_LIFE_DAYS` | 14 | Recent trouble should stay relevant for longer. |
| `FILL_VALUE_SHARE` | 0.60 | Expensive high-value tests are being crowded out by cheap ones. |
| `FILL_DENSITY_SHARE` | 0.25 | More of the cheap tail should run. |
| `FILL_EXPLORATION_SHARE` | 0.15 | The unselected corpus is going stale. Down when lanes waste time on nothing. |
| `FLAKE_EXCLUSION_RATE` | 0.05 | Fewer tests should be held back from pull requests. Down when flakes are still blocking people. |
| `FLAKE_REPEAT_RATES` | 0.01, 0.10 | The thresholds at which an item is run twice, then three times. |
| `MAX_REPEATS` | 3 | Intermittent regressions are still getting through. |
| `SUITE_FLAKE_PRIOR_RATE` | 0.02 | The rate above which a suite counts as flake-prone, so new items in it are repeated. |
| `COVERAGE_COMMENT_LINES` | 25 | Coverage comments are too noisy. Down when debt is climbing unnoticed. |
| `COVERAGE_TREND_WEEKS` | 3 | The tile goes amber too readily. |
| `CATCH_BREADTH_WINDOW_DAYS` | 2 | The window in which failures across many branches read as environmental rather than as catches. |
| `ATTRIBUTION_MAP_DAYS` | 7 | How stale the coverage attribution map may get before it is rebuilt. |
| `ALIAS_GATE_MIN_CATCHES` | off | Turn on, at a catch count, to fail a pull request that discards that much history in a rename without an alias line. |

The three worth revisiting first, because their right values are empirical
rather than structural: `FRESHNESS_HALF_LIFE_DAYS`, which decides how long
a proven test stays proven; `FLAKE_EXCLUSION_RATE`, which trades pull-
request noise against coverage; and `CHURN_HALF_LIFE_DAYS`.

## The work

Three pull requests. No flags, no shadow systems, and nothing to flip:
each one is live the moment it merges, and each is useful on its own even
if the next never lands.

One thing has to happen first and is not ours. The publisher needs a
writer credential, which is a `test-selection` service account with
`objectCreator` on `labs/test-selection/`, a Workload Identity provider
pinned to `.github/workflows/test-selection.yml` on `main`, and a
lifecycle rule deleting objects there after thirty days — the same
pattern, and the same security argument, as the relay already uses. It
also wants the compactor provisioned, which is already designed and
implemented and only needs its principal. That is an infra-repository
change under `tofu/test-records`, and it must land and be applied before
the first pull request here can publish anything.

### One — the data, and what it already tells us

Nothing about what continuous integration runs changes. This pull request
only makes the store answer questions it cannot answer yet, and puts the
answers somewhere people can see them.

- [ ] A preload module in `@commonfabric/test-support` that captures the
      registering module for every `Deno.test` and writes the name-to-file
      map into the spool; `ingestJUnit` joins on it; every `deno test`
      invocation carries the preload.
- [ ] `packages/deno-web-test/runner.ts` sets `file` on the records it
      writes directly.
- [ ] `tasks/test-selection/{policy,score,manifest,store}.ts` — the dials,
      the catch and flake derivation, the manifest format and its
      validators, and the reader and writer. Identities resolve through
      `loadAliasResolver`, as the report tool and dashboard collector
      already do.
- [ ] `tasks/test-selection/plan.ts`, the pure packing function, tested
      offline against recorded manifests.
- [ ] `tasks/test-selection-publish.ts` and
      `.github/workflows/test-selection.yml`, on a four-hourly cron.
- [ ] The one-off bootstrap dispatch.
- [ ] Dashboard tiles: the coverage debt trend, the flake list, what the
      newest manifest would select, and the escape rate — how often
      something reaches `main` that a test we already had caught there.
      That last one is measurable today, before any of this changes what
      runs, which makes it the baseline everything after is judged
      against.
- [ ] `deno task test-selection dials` and `--explain <identity>`.

On its own this pull request gives the repository a flake list derived
from evidence rather than from anecdote, and a coverage trend nobody has
today. If the rest never landed it would still have been worth it.

### Two — the topology, proven by `main`

The topology goes in and `main` starts using it. Pull requests are
untouched, so a mistake here is loud and cheap: `main` tells us within
twelve minutes and nobody's pull request is affected.

- [ ] `tasks/test-topology.ts` and one module per suite;
      `tasks/ci-capabilities.ts`.
- [ ] `tasks/check-test-topology.ts`, both halves, wired into
      `repo-gates`.
- [ ] `tasks/ci-lane.ts`, including `--full`, `--dry-run`, and repeats.
- [ ] `deno.yml`: `plan-full` and `full-tests` on push, with the build,
      attestation, coverage and deploy jobs repointed at them.
- [ ] The weekly coverage attribution job, and the map published beside
      the manifest.
- [ ] Coverage measurement moves to the full run and stops failing
      anything.
- [ ] Before merging: `plan --verify` against the last `main` run, proving
      the identity set the topology produces matches what the old matrix
      ran, compared from the store rather than by eye.

### Three — the pull-request path

- [ ] `deno.yml`: five `pr-tests` lanes replace every pull-request job;
      `Status` depends on `pr-tests` and `full-tests`, with `skipped`
      counting as success for the latter.
- [ ] The `ci: full` label.
- [ ] `coverage-comment.yml` generalized into the reporter, with the
      first-failure attribution, the selected-or-not line, the coverage
      note, the flaky-new-test note, and the rename suggestion with its
      ready-to-append alias line.
- [ ] `tasks/ci-workflow.test.ts` updated for the new anchors and shapes.
- [ ] Documentation, in the same pull request rather than after it:
      `docs/specs/test-selection.md` for the contract,
      `docs/development/test-selection.md` for the operating guide, the
      trust-boundary amendment and new dataset area in
      `docs/specs/test-records.md`, `docs/development/COVERAGE.md`
      rewritten around a trend rather than a gate,
      `docs/development/CI_PERFORMANCE.md` around lanes rather than shard
      balance, and `.claude/rules/github-workflows.md` and
      `.claude/rules/tests.md` where "add a job" becomes "add a suite".
- [ ] This plan archived.

### Why not two, or one

Two and three could merge. They should not: the topology is only really
proven by running, and if it lands together with the pull-request path
then a mistake in it breaks both paths at once, on everybody, at the same
moment. One extra pull request buys a window where the topology is live,
carrying `main`, and wrong in a way that costs nothing.

One is separable from both because it changes no behavior at all, and
because the calibration and the manifest want a few days of data before
anything depends on them.
