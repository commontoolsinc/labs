# Choosing which tests a pull request runs

Status: in progress. Part one is built apart from the one-off bootstrap
dispatch and one dashboard tile; part two is built apart from its
continuous-integration configuration and the coverage work; part three has
not started. [The work](#the-work) carries the detail. The record store
this plan consumes is live and holds the data the design needs; the gaps
it does not yet hold are listed under [What the store is
missing](#what-the-store-is-missing) and closed by the first part of the
work.

Continuous integration for a pull request currently runs 67 jobs and every
test in the repository. This plan replaces that with five jobs that run a
chosen subset, chosen from what the test-record store already knows about
which tests have caught real regressions, refreshed every few hours, and
packed so that each of the five jobs finishes in about the same time and
within five minutes. A push to `main` still runs everything, and a label
on a pull request runs everything there too.

Selecting a subset breaks two things that depend on running the whole
suite, so the plan carries their replacements rather than leaving them
broken. Coverage becomes a trend somebody can act on rather than a gate,
except in the one place where a pull request can still measure the whole
of something and compare it honestly. And a regression that only `main`
catches gets reported back to the change that introduced it,
automatically, addressed at the change and never at a person.

The design is written so that adding a test, a new kind of test, or a new
configuration of existing tests is a change to one repository module and
never a change to the continuous-integration configuration. That property
is the point of the whole exercise: a selection system that has to be
rewired every time somebody adds a test surface costs more than it saves.

It should land in one pull request, with no flags and nothing to flip: it
is live the moment it merges. [The work](#the-work) sets out the three
parts it is built in, and why none of them needs a pull request of its
own.

## Status convention

- [ ] Not started
- [x] Complete and verified

Mark a parent checkbox complete only after all its children pass. Keep
this plan current in the same commits as the implementation. Once the work
has landed, archive it under
`docs/history/plans/` following
[`../README.md`](../README.md).

## The vocabulary, briefly

- An **identity** is the durable name of a test: the three required parts
  kind, scope, and name, plus an optional variant for a non-default
  configuration, defined by [the test-record
  spec](../specs/test-records.md). Everything here is built on the complete
  identity.
- An **item** is the smallest thing a runner can be asked to run on its
  own. It holds one identity or many, depending on the suite. For a
  pattern test the item is one file and the file supplies the name, so the
  two coincide. For a unit test the item is usually the file, and every
  `Deno.test` in it is a separate identity, which is where almost all of
  the repository's identities live. For the command-line integration
  script the item is a single-step dispatch arm, which records the one
  identity named for its step. [Selecting one test rather than one
  file](#selecting-one-test-rather-than-one-file) specifies how the item
  stops being the unit of selection.
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
  every item-level identity, and writes a manifest.
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

A successful `deno.yml` push build on 2026-08-25, [run
32899488580](https://github.com/commontoolsinc/labs/actions/runs/32899488580)
at commit `c8893b3a8`, is the reference throughout this plan. The workflow
contained 67 jobs. 66 ran and the pull-request `Status` job skipped. The
jobs consumed 181 minutes of runner time and took 15 minutes and 23
seconds of wall time from first start to last finish. Every pull request
pays nearly all of that, and pays it again on every push to the branch.

The same build's 59 stored test-record objects describe the recorded test
work. They hold 17,999 test executions under 17,995 distinct complete
identities. The runners' own measurements of those executions add up to
166 minutes and two seconds. The distribution is extremely skewed:

| Executions | Count | Share of executions | Summed duration | Share of summed duration |
| --- | --- | --- | --- | --- |
| Over 60 seconds | 15 | 0.08% | 30.2 minutes | 18% |
| Over 10 seconds | 163 | 0.9% | 78.0 minutes | 47% |
| Over 1 second | 1,831 | 10% | 148.6 minutes | 89% |
| Under 100 milliseconds | 14,032 | 78% | 2.6 minutes | 1.6% |

This was the latest successful `main` run when the census was taken. It
includes the server-execution record marking. The `server-execution`
variant contributes 386 executions under the same number of distinct
identities and 10 minutes and 32 seconds of measured time. The remaining
17,613 executions, under 17,609 identities, are the unmarked default
history. The census groups identities with the canonical three- or
four-part key and applies the duration thresholds to individual record
executions. It includes deliberately overlapping records such as an
`integration.sh` invocation and the steps inside it, so summed record
duration is not unique wall time and cannot be added directly into item
cost. None of these counts becomes a policy constant.

Both share columns are against the run's whole 17,999 executions, and the
first three rows nest: every execution over 60 seconds is also one
over 10. Read down the two together and the skew is the gap between them.
A tenth of the executions hold nine tenths of the time. Just under four
fifths finish in under a tenth of a second and hold one and a half
percent of it, which is 2 minutes and 35 seconds across all of them.

That skew is what makes this cheap. The objective is to run the tests that
find things, and those are few. What the skew adds is a bonus: the cheap
tail costs so little per test that a run can carry a large part of it as
well, so a pull request spends a small fraction of the time and still runs
most of the tests. Running the valuable tests is the requirement and
carrying the tail is the bonus. [What the census can
project](#what-the-census-can-project) treats them that way.

The second half of the problem is that the jobs themselves are hand-wired.
67 jobs come from about 18 job definitions in `deno.yml`, each with its
own setup steps, its own sharding scheme, its own artifact names, and its
own entry in three `needs:` lists. Adding a test surface today means
editing the workflow, the `Status` job's dependency list, the coverage
gate's dependency list, and often a sharding weight table. That cost is
what makes people put a new test in an existing job where it does not
belong.

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
9. Coverage keeps going up. It stops being a gate on `main`, where a
   landed change that adds one uncovered line must not turn anything
   red, and on pull requests for everything a pull request cannot
   measure whole. It keeps gating the one thing a pull request can still
   measure whole: a package whose own unit tests are what cover it,
   scored over its own source by those tests alone.
10. A regression that reaches `main` is reported back to the change that
    introduced it, without turning that into a record of who broke what.
11. Flaky tests are found, and the finding is used: to run intermittent
    things more often where that catches more, and to keep tests too
    noisy to judge from blocking anybody.
12. Every dial is in one documented place, and a pull request can opt out
    of selection entirely and run everything.

Requirement 8 is the one that shapes the architecture. Requirements 1
through 7 could be met by a script that hard-codes today's 18 job
definitions; requirement 8 cannot. Requirements 9 through 11 are what a
subset costs, paid for rather than written off.

## The shape of the system

Five pieces, with one direction of dependency between them.

**The topology** lives in the repository, at `tasks/test-topology.ts` and
the modules it pulls in. It declares each suite: what capabilities the
suite needs, how to list the suite's items from the working tree, how to
classify a record identity as belonging to an item or to the suite, and what
command runs a given set of items. It is the only place a new test surface
is registered.

**The publisher** is a scheduled workflow. Every four hours it reads the
record store, folds the new records into a rolling per-day aggregate,
scores every item-level identity, estimates every item's cost, packs the
result into five lanes, and writes one manifest object into the store. It
writes nothing into git.

**The lane runner** is `tasks/ci-lane.ts`. The five pull-request jobs all
run it, passing their lane number. It resolves the manifest from the date
on the commit it has checked out, reads the working tree through the
topology, adjusts the plan for what this particular pull request changed,
works out which batches belong to its own
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

  /** Every kind and scope this suite's records may carry. */
  recordSurfaces: Array<{ kind: string; scope: string }>;

  /** The non-default configuration in which every item runs. */
  variant?: string;

  /** Setup this suite needs before it can run. */
  needs: CapabilityRequest[];

  /** Environment variables its commands run with. */
  env?: Record<string, string>;

  /** Whether a subset of this suite is always run, and on what basis. */
  mandatory?: "always" | "changed";

  /** Every available item and every configured unavailability. */
  enumerate(): Promise<{
    items: Item[];
    unavailable: Array<{
      item: Item;
      leafName?: string;
      phase?: string;
      reason: string;
    }>;
  }>;

  /** Whether a recorded identity belongs to an item or to the suite. */
  locate(identity: TestIdentity):
    | { level: "item"; item: Item }
    | { level: "suite" }
    | undefined;

  /** The command and typed JUnit outputs for exactly these items. */
  command(items: Item[], output: OutputPaths): {
    run: Command;
    junit: Array<{
      path: string;
      kind: string;
      scope: string;
      filePrefix?: string;
    }>;
  };
}
```

The identity and execution members carry most of the design.

`recordSurfaces` lists the kinds and scopes a suite can emit. It is a list
because one runner does not imply one scope: `workspace-unit` spans every
workspace package, and the package integration command spans `runner`,
`runtime-client`, and `shell`. The optional `variant` is suite-wide because
the suite declares the configuration in which every one of its items runs.
Default suites omit it. The server-execution `opposite` suites derive their
variant from the posture they actually exercise: `server-execution` for ON or
`server-execution-off` for OFF. The registry's summary table states the
current default; the opposite suites' variant follows it.

`enumerate()` is what makes a new test visible without a workflow edit. It
reads the working tree — usually a file glob, sometimes a list parsed out
of a script — and returns the items that are available right now, plus any
item or exact leaf deliberately unavailable in this configuration. A test
file added by a pull request appears in `enumerate()` on that pull
request's own checkout, which is how a brand-new test gets run before any
record of it exists.

`locate()` is the bridge from history to execution. The store speaks in
identities; the runners take file paths and section names. For a pattern
test the identity name is its path, while the suite supplies its record
surface and variant. For a unit test `locate()` needs the file the identity
came from, which is metadata the store does not reliably carry today;
closing that gap is the first thing [part
one](#part-one--the-data-and-what-it-already-tells-us) does.

Most identities locate to an item and take part in scoring and item cost.
An overlapping task-level record locates only to the suite. For example,
`integration.sh` records the whole invocation in addition to its step
records, and the same task identity appears for several dispatch sections.
It proves that the topology knows the record surface, but it cannot identify
one item and must not be summed with its own steps. Suite-level records stay
available to reports. The lane runner's non-overlapping batch timing records
provide the cost calibration after lanes exist.

One identity locates to at most one item, even where several ways of
running it exist. The command-line script's dispatch table overlaps on
purpose: the `all` arm, the grouped arms, and the single-step arms each
begin some of the same recorded steps, so the step named `integration.sh
piece-values` is reachable from four different arms. Exactly one of those
arms is that step's item. The suite decides which by what `enumerate()`
returns, and it returns only the arms it means as items, so the arms that
exist for people running the script by hand never become items and never
make an identity ambiguous.

`locate()` accepts an identity only when its kind and scope are one of the
suite's declared record surfaces and its variant exactly matches the
suite's variant. This applies to both item and suite locations. An unmarked
record therefore maps only to a default suite, and a marked record maps only
to the matching non-default suite. The same source item may appear once in
a default suite and once in a variant suite; those are independently
selectable items with separate histories.

`command()` describes each JUnit output separately because one command may
produce reports for several record surfaces. Its descriptors supply the
kind, scope, and optional file prefix used to ingest each report. The
suite supplies the variant shared by all of them. Direct records already
carry their kind, scope, and name; the runner checks their record surface
against the suite before applying that same variant.

`mandatory` is the policy escape hatch. `"always"` means every item runs
on every pull request, with no exceptions of any kind — it outranks the
score, the budget, and both exclusion rules, and
[Two rules that keep a test out](#two-rules-that-keep-a-test-out) explains
why that has to be literal. `"changed"` means an item runs when the pull
request touches a file the item covers; the per-package type check is the
natural user, because the store already records one `typecheck` identity
per package group and the mapping from a changed file to a package is
direct.

Answering "what does this item cover" belongs to the suite, because a
unit that is not a path is one only its suite can map a diff onto. A
suite whose units are files needs to say nothing: the diff naming the
file is the whole of the question. A suite whose units are type-check
groups or binaries maps the diff itself, and a suite that maps it wrongly
runs too much or too little rather than reporting anything, so the answer
errs toward running. Absent the field, the suite is selected purely on value.

The `always` set is deliberately tiny, and every member of it is a gate
whose failure means the tree is broken rather than that one test is
unhappy: `deno fmt --check`, `deno lint`, and the topology drift guard.
Together they cost seconds. Nothing expensive belongs there, and adding to
the set is a decision to spend part of every lane's budget forever.

### Today's jobs as suites

The 18 job definitions in `deno.yml` become the following suites. This
table is the migration's checklist.

| Suite | Today's jobs | Record variant | Capabilities |
| --- | --- | --- | --- |
| `repo-gates` | `Check` (all but the type check) | — | `deno` |
| `typecheck` | `Check` (the type check) | — | `deno` |
| `workspace-unit` | `Test (1..8)` | — | `deno`, `fuse`, `browser` |
| `runner-unit` | `Runner Tests (1..8)` | — | `deno` |
| `cfcheck` | `CFC Pattern Check` | — | `deno` |
| `pattern-compat` | `Pattern Update Compatibility (1..3)` | — | `deno` |
| `pattern-vintage` | `Pattern Update State and Baseline Integrity` | — | `deno`, `git-history` |
| `generated-patterns` | `Generated Patterns Integration Tests (1..2)` | — | `deno`, `compile-cache` |
| `package-integration` | `Package Integration Tests (3 suites)` | — | `deno`, `toolshed`, `browser` |
| `package-integration-opposite` | the posture opposite the server-execution default | resolved arm variant | `deno`, `toolshed-baked-opposite`, `browser` |
| `deployed-topology` | the background-service and cf-harness default-posture gates | — | `deno`, `toolshed`, `bg-piece-service-binary` |
| `cli-core` | `CLI Integration Tests (3 suites)` | — | `deno`, `toolshed`, `cf`, `jq` |
| `cli-fuse` | the FUSE steps of the third CLI suite | — | `deno`, `toolshed`, `cf`, `fuse` |
| `cli-deno` | the Deno-based CLI integration step | — | `deno`, `toolshed`, `cf` |
| `pattern-integration` | `Pattern Integration Tests (1..10)` | — | `deno`, `toolshed`, `browser`, `compile-cache` |
| `pattern-integration-opposite` | the posture opposite the server-execution default | resolved arm variant | `deno`, `toolshed-baked-opposite`, `browser` |
| `pattern-reload` | `Pattern Reload Integration Tests` | — | `deno`, `local-dev-servers`, `browser` |
| `pattern-unit` | `Pattern Unit Tests (1..4)` | — | `deno`, `cf`, `compile-cache` |
| `binaries` | the compile inside `Build Binary (toolshed)` and the two beside it | — | `deno` |
| `binaries-opposite` | the toolshed compile whose shell is opposite the server-execution default | resolved arm variant | `deno` |

The server-execution suites now keep stable `default` and `opposite` roles.
`default` follows the one first-party constant without changing its unmarked
record identity. `opposite` explicitly selects the inverse, and its record
marker names that actual posture. No identity alias joins these histories: the
unmarked default continues by construction, and each non-default posture keeps
its own marker.

### Declared unavailable tests

A configuration-specific skip is neither an unknown test nor evidence that
the topology missed a surface. Whichever role resolves the server-execution ON
posture reads `tasks/server-execution-on-skips.ts` as part of its topology;
the role that resolves OFF runs every file. The skip registry remains the
single source of truth for the phase and reason; the selection system does not
grow a second list.

A whole-file entry removes that file from the variant suite's enumerated
items. The manifest reports it as unavailable under that suite and variant,
with the registry's phase and reason. A step-level entry leaves the file
item in the suite because every other step still runs. It marks only the
skipped leaf identity unavailable, so that leaf is excluded from the
unknown-identity and coverage-target rules while the rest of the file's
identities behave normally.

Removing either kind of skip makes the file or leaf ordinary topology
again. Until a full `main` run records it, it is unknown and therefore
mandatory. This gives removing a skip the same safe rollout behavior as
adding a new test. The existing rule that the skip registry must be empty
when server execution becomes the default remains unchanged.

The build jobs (`Build Binary (toolshed)` and the three beside it) do not
become suites for the reason they exist today. They are not tests; they
are setup, and as setup they become capability providers.

They do become suites for a different reason. A pull request runs its
servers and its command line from source and compiles nothing, so a
compile that breaks would be found on `main`, after the change that broke
it has merged — where today it is caught before it lands. So `binaries`
makes each shipped binary a unit whose test is that it still compiles,
and `binaries-opposite` does the same for the toolshed under the define
opposite the default, which is the same build in a different configuration and
therefore a variant of it rather than a second test.

Every one of those builds passes `--no-check`, so this is not a second
type check: `deno task check` owns that. What a compile catches that
nothing else does is resolving the whole import graph from an entry
point, bundling the browser shell, and embedding each `--include`d asset
from a path that has to still exist.

Nothing forces a build to run. A binary the store has never seen is
unknown and therefore mandatory, so each is built once; after that it
sits at the value floor until it catches something. When a compile does
break, `main` catches it, and a `main` catch is weighted half again for
being exactly the escape this system exists to stop — one of them lifts a
build from the floor to several times it, which is enough to be chosen
against a corpus where almost nothing has ever failed.

The alternative was a map from changed paths to the binaries they can
break. It is the kind of transcribed table [sharding stops being written
down](#sharding-stops-being-written-down) exists to delete: a compile
reaches the whole import graph from an entry point, no short list
describes that, and the list would go stale the first time an import
moved. The cost of leaving it out is that the first compile to break
reaches `main`, which is the trade this design makes everywhere else and
is what the feedback loop then closes. The deploy and attestation jobs stay exactly as they
are, since they only ever ran on `main`.

**`cli-fuse` carries the fine granularity the rest of this depends on.**
`packages/cli/integration/fuse-exec.sh` records an identity for each phase
it goes through, through the `cf_test_step_begin` markers `integration.sh`
also uses. Its 23 phases record under 25 names, because one of them
announces under one of three sentences depending on how deeply it probes,
and each of those is an identity of its own. Each marker leads the phase
it names, so a phase that fails is the record that carries the failure,
and the two phases that bring the mount up and wait for it to hydrate
record like the rest, so a mount that never comes up is reported as the
mount. Scoring, the flake rate and the 60-second ratchet each get a
number per phase where they had one covering a FUSE mount, a Toolshed
server and everything the script does with them.

The script also takes a section, so a lane can be pointed at part of it.
Which phases can stand alone was a question about the script rather than
about selection — the same independence question [asked of unit
tests](#skipping-assumes-tests-do-not-lean-on-each-other) — and the answer
is four sections rather than one per phase. A section is a group of phases over one
mount rather than a phase on its own, because the mount, the daemon and
the piece cost more than every phase together and each section needs all
three. Four phases therefore run whichever section was asked for, and are
not selectable. A fifth is not selectable for the same reason without
being in that group: the phase that puts the callable files in place is a
precondition of three of the four sections, so each of those runs it
first. The rule the topology applies covers both — a phase more than one
section runs names no single section, so it is a suite-level record
rather than one belonging to a unit.

Two dependencies decide where the boundaries fall, and both are about
state a phase leaves behind. The handler phases assert `messageCount` as
an absolute count up from the piece's initial zero, so they stay together
and in order. The source update ends by asserting `lastMessage` is the
empty string the truncate phase left, so it sits in the section holding
that phase. A third ordering is why the entity listing is one of the
phases that always runs: its assertion is that no entity payload has
crossed the memory proxy, read from a trace that accumulates over the
whole run, so nothing may hydrate the piece before it.

`packages/cli/test/fuse-sections.test.ts` holds the dispatch table to
those orderings, and to every phase being reachable — from `all`, from a
section smaller than `all`, and from what the workflow dispatches.

`pattern-reload` needs nothing done to it, and is not a special case
either. `packages/patterns/integration/reload/` holds a single file with a
single `it()`, which is a fact about what is in the directory rather than
a property of the suite: it runs `deno test` like the other integration
suites, and [the skip
list](#selecting-one-test-rather-than-one-file) reaches inside its file
without anything being threaded through `tasks/integration.ts` to get
there.

What that layer would block is subsetting the suite's *files*, if it ever
had more than one. `tasks/integration.ts` dispatches `patterns-reload` in
a branch ahead of the one honoring the name filter, so a filter handed to
that target is dropped without a word, and `packages/patterns`'
`integration:reload` task hard-codes its glob. Neither matters while the
directory holds one file. If a second reload case lands, moving that
branch below the filter branch is the whole of the fix.

`pattern-reload` also shows why capabilities are named rather than
implied. It needs a server, but not the one the other integration suites
need: its job downloads no binary and starts nothing, because
`deno task integration` brings up the whole local dev stack itself on a
chosen port offset. Calling that `toolshed` would be wrong, and a lane
that opened a Toolshed server for it would have paid for the wrong thing
and still failed.

### What a workspace member's own task decides

A member's test task cannot be handed a subset of its own files: almost
every one of them lists its own paths, so appending more would add to
what runs rather than restrict it. What the task does carry is everything
else a run needs — the permissions, `--no-check`, a fake-clock preload,
an `ENV` assignment in front — so the topology reads the task for those
and replaces its paths with the chosen ones.

Thirty-two of the forty-seven members are readable that way, which makes
1,342 test files individually selectable. The rest are one unit each and
run whole, which is what every member does today. A member whose task is
written as a dependency list resolves through it to the `deno test`
underneath, and the one command substitution the workspace writes —
naming the running Deno in an `--allow-run` list — is resolved rather
than treated as a shell metacharacter, so neither shape costs a member
its granularity.

Two things a member's own `deno test` would apply are applied during
enumeration instead: the task's `--ignore` globs and the member's
`exclude` list. Deno filters discovered modules through both and an
explicit path through neither, so a file arriving as a positional
argument would otherwise run in spite of being excluded.

### Sharding stops being written down

Four packages are hand-sharded today, and one is lifted out of the
workspace walk entirely, because a job can only be given a slice of work
by somebody deciding in advance what the slices are.
`INTERNALLY_SHARDED_PACKAGES` in `tasks/workspace-tests.ts` splits
`agents-host` three ways, `cli` ten, `piece` three, and `tasks` three.
`deno.yml` sets `TEST_DISABLED_PACKAGES: runner` on the workspace job and
runs `packages/runner` as eight `Runner Tests` shards of its own, chosen
by `tasks/select-runner-test-files.ts`. Each of those splits is balanced
by a table of numbers somebody transcribed from a green build:
`tasks/test-timing-weights.ts` holds five of them, one per sharded thing,
164 lines of relative costs that go stale the moment a test gets slower.

None of it survives the topology. An item's cost comes from the record
store, measured on every run rather than transcribed from one, and the
packer distributes items by that cost. A package with 675 test files is
675 items, and where they land is arithmetic. So
`tasks/test-timing-weights.ts`, `tasks/select-runner-test-files.ts`,
`tasks/run-sharded-test-files.ts`, `INTERNALLY_SHARDED_PACKAGES`,
`TEST_DISABLED_PACKAGES`, and the shard environment variables the
packages' own runners read all go, and `packages/runner` becomes the
`runner-unit` suite like any other. `tasks/weighted-shards.ts` is the one
piece that stays, because it is the packing algorithm rather than a table
of guesses, and the lane packer is its caller.

The same thing happens one level up. The shard matrices in `deno.yml` —
eight for the workspace tests, ten for the pattern integration tests,
three, four and two for the rest — are the same decision written in a
different file, and the full run's job matrix is computed from the
topology instead.

That is the deletion the topology buys, and it is worth naming separately
from the selection it enables. A repository that shards by hand pays a
maintenance cost every time a test's cost changes, and pays it in a file
nobody thinks about until a shard runs long. Nothing outside the machinery
listed here reads those tables, so the deletion is clean.

## Selecting one test rather than one file

The store scores identities and the packer chooses items, and for the unit
suites those are not the same size. A unit-test file holds many
identities, so choosing one test with a record of catching things drags in
every test beside it, and skipping one expensive test means skipping its
whole file. Almost all of the repository's identities sit behind that gap.

Closing it does not need a single test file edited. This section specifies
how, and says where the gain is real and where it is not.

### Why `deno test --filter` is not the mechanism

The obvious tool does not do the job. `--filter` takes a substring, or a
pattern between slashes which Deno compiles with Rust's regular expression
crate. That crate has no lookaround, so "run everything except these
names" cannot be written at all.

It fails in the worst available way. On Deno 2.9.4 a pattern the crate
cannot compile does not error: every test is filtered out and the run
exits zero. A malformed filter is a green run of nothing, which is the one
result continuous integration must never produce quietly.

Inclusion patterns do compile, and they are the wrong shape anyway: a
filter listing the tests to run silently drops a test the pull request
just added, because its name is not on a list built from records that
predate it.

### Most tests are not registered where you would think

A test's identity is the name its runner reports, which for a file written
with `describe` and `it` is [the describe chain joined with `" > "`
](../specs/test-records.md#identity). Deno reports the container as a
testcase too, and `dropContainerCases` in
`packages/test-support/src/records/junit.ts` throws it away, so what
reaches the store is one identity per `it`.

Registration does not follow that shape. `describe` registers one
`Deno.test` and every `it` inside it is a step within that one test. So an
interception on `Deno.test` sees the container and never the leaves, and
the two granularities come apart exactly where the tests are: 1,283 test
files use `describe` and `it`, 85 percent of those hold exactly one
top-level `describe`, and between them those files hold 15,191 `it`
blocks. For 1,096 files, skipping the registered `Deno.test` is skipping
the whole file, which is what items already do.

Reaching an `it` therefore needs a second interception, and both are
available without editing a test file.

### Two interception points, and no test file changed

The first is the preload
[part one](#part-one--the-data-and-what-it-already-tells-us) already adds
to `@commonfabric/test-support`, which wraps every `Deno.test` to capture
the module that registered it. It gains the skip list, and that reaches
every bare `Deno.test` — 511 files' worth.

The second is a line in the import map. `@std/testing/bdd` resolves to a
module in `@commonfabric/test-support` that re-exports the real one under
another specifier, tracks the enclosing `describe` chain, and registers a
listed `it` through `it.ignore` instead of `it`. Every file keeps its own
`import { describe, it } from "@std/testing/bdd"` unchanged; what that
specifier means changes once, centrally.

Neither interception needs anything from the layers between the workflow
and the test. The import map is repository-wide, and the skip list's
environment variable is inherited by whatever a task spawns, so a suite
reached through `tasks/integration.ts` or a package's own runner is
reached without those learning a new flag. `--filter` would have needed
every one of them to pass it along, and at least one does not:
`tasks/integration.ts` dispatches `patterns-reload` in a branch that sits
ahead of the one honoring the name filter, so a filter handed to that
target is dropped without a word. That suite is reachable here anyway.

One more thing recommends routing it through a module of ours.
`@std/testing/bdd` is deprecated: its own documentation says it will be
removed at 2.0.0, points at `node:test` instead, and describes the
migration as mostly a matter of changing the import. That specifier in
1,283 files has to change anyway. Sending it through one module now turns
that migration into an edit of one file rather than of all of them.

Both consult the same **skip list**: the identities this invocation is not
to run. A listed test is registered as ignored rather than dropped, so it
appears in the run's output and in its JUnit report as skipped, and the
store learns it was deliberately not run instead of watching the identity
disappear.

Four properties come from intercepting at registration rather than on the
command line. The list is a file named by an environment variable, so
nothing is bounded by argument length. Names match exactly, so nothing
needs escaping. The list is keyed by registering file and name together,
because the same test name occurs in more than one file and the preload
already computes the file for its attribution work. And no test file
changes at all: a suite that already passes `--preload` takes a second
one, since repeating the flag works where the comma-separated form does
not, and the import map is one line.

One consequence is worth stating because it looks like a bug when first
seen. Wrapping `Deno.test` moves Deno's own JUnit `classname` from the
test's file to the preload, for skipped and unskipped tests alike. That is
already why `ingestJUnit` joins on the preload's name-to-file map rather
than on `classname`, and it is a reason the two features belong in one
module rather than two.

### The list says what not to run, never what to run

An identity the store has never seen is not on the skip list, so it runs.
A test the pull request just added runs. A renamed test runs, because the
new name is not the old one. A test whose file moved runs.

This is [an identity with no records must
run](#two-rules-that-force-a-test-in) enforced by construction rather than
by a rule the packer has to remember, and it is the whole reason the
mechanism is a skip list rather than a selection list.

### Every invocation unit, and the identities inside it

There are eight kinds of invocation unit across the topology, and two of
them hold more than one identity. One of the two holds almost everything:
the workspace and runner unit shards alone carry 15,997 of the reference
build's 17,999 executions.

| Invocation unit | Suites | Identities inside it | Reaching one of them |
| --- | --- | --- | --- |
| A `deno test` file | `workspace-unit`, `runner-unit`, `pattern-integration` and its ON arm, `package-integration` and its ON arm, `generated-patterns`, `cli-deno`, `pattern-reload` | Every bare `Deno.test` in the file, and every `it`, named as its describe chain joined with `" > "`. The container testcase Deno also reports is dropped at ingestion, so a `describe` is not an identity | The skip list, through the preload for a bare `Deno.test` and through the remapped `describe`/`it` for the rest. This is the row the whole section is about. |
| A pattern file run by `cf test` | `pattern-unit` | One. The runner writes one record per pattern file | Nothing to reach: the file is the identity. |
| A pattern file checked by the compatibility gate | `pattern-compat` | One, named `pattern-compat <key>`, which the task appends itself as each file's verdict is known | Nothing to reach. The task already takes `--only` to restrict which files it reads. |
| A single-step arm of `integration.sh` | `cli-core` | One, named for its step | Nothing to reach. The script's own whole-invocation record is suite-level and belongs to no invocation unit at all. |
| One gate command | `repo-gates` | One, named for the gate that ran | Nothing to reach. |
| One `deno check` invocation | `typecheck` | One, named for the path group it checked, which the task records itself | Nothing to reach. |
| A whole task carrying one record | `cfcheck`, `pattern-vintage` | One, for everything the task did | Nothing to reach, and nothing finer exists: the suite is its own identity. |
| A section of `fuse-exec.sh` | `cli-fuse` | The phases that section alone selects. The phases more than one section runs record against the suite instead, since they name no single section | Nothing to reach below the section. A mount comes up for the section, not for the phase, so its phases run or are skipped together. |

Six of the eight rows are one identity per invocation, which is why this
change is smaller than removing a concept sounds. The topology does not
gain a mechanism for them; they simply stop being described as items
holding one identity each and start being described as identities. The
seventh, `cli-fuse`, holds the phases of whichever section ran, and there
is nothing finer for the topology to reach, since a mount comes up for the
section rather than for the phase.

`pattern-reload` is in the first row and not in a row of its own, which is
worth saying because the plan used to treat it as a special case. It runs
`deno test` over a directory that happens to hold one file holding one
`it`, and holding one of something is a fact about today's contents rather
than a property of the invocation unit. A second `it` would make it an
ordinary member of that row with nothing to change.

### What it reaches, and what it does not

The identity is the floor, and with both interceptions in place the floor
is reached everywhere the store has an identity to score. What is left
below it is a `t.step` inside a bare `Deno.test`, which the store does not
name separately either, so nothing is lost that selection could have used.

The module still loads. Skipping a test inside a file does not avoid
importing that file, and for some suites the import is most of the cost:
the reference build's eight runner unit shards hold 1,120 seconds of
measured tests inside 1,583 seconds of test steps, and the difference is
largely module loading. So what this buys is the tests' own time and not
the file's.

That is exactly where the time is. 1,831 executions run for over a second
and hold 148.6 minutes between them, and they are scattered through files
whose other tests are cheap. Being able to leave the slow ones out of a
file the lane is running anyway is the lever the item granularity was
hiding.

### Skipping assumes tests do not lean on each other

Not every identity can run on its own, and the mechanism does not make it
so. It stops the other tests running; it does nothing about what this one
needed them for.

Setup and teardown are not the problem. `beforeAll` and `afterAll` belong
to the `describe`, which still registers and still runs when some of its
`it`s are ignored, and `beforeEach` and `afterEach` run around each `it`
that survives. A test that gets everything it needs from those is
unaffected.

The problem is a test that reads what a sibling wrote.

The interface says that is not what an `it` is for. `@std/testing/bdd`
documents `it` as registering "an individual test case", and offers
`it.only`, `it.skip` and `it.ignore`, none of which means anything unless
one case can run without its siblings. Jasmine, Jest and Mocha use the
same vocabulary, and parts of that family shuffle declaration order by
default to keep the claim honest.

Nothing here enforces it. The module says nothing about ordering, Deno
runs the cases in the order they were declared, and no part of this
repository has ever run them in any other order. A dependence between two
cases is therefore not something anybody would have been told about, and
the reasonable prior is that some exist.

A scan finds over a hundred files in which one `it` assigns a binding
another `it` reads. It cannot tell a real dependence from a `beforeEach`
that resets the binding first, which is both why that number is a
suspicion rather than a count and why the property has to be measured
rather than read off the source. The check below is also the first thing
this repository would have that could detect one at all.

So independence is established per identity, never assumed. Until it is
established, an identity's siblings are not skipped and its file stays the
unit — which is today's behaviour, so the starting point is no worse than
what the repository has now, and it improves from there.

#### Establishing it

A test that passes as the only test running in its file depends on no
sibling: its `beforeAll` and `beforeEach` still ran and nothing else did.
So the check is one invocation per identity with every sibling skipped,
and the answer is a flag carried in the manifest beside the score.

It cannot be a sweep. One invocation per identity is around 18,000 of
them, against the roughly 2,000 the weekly coverage attribution job
already costs three and a half hours for. So `main` checks the identities
in the files its own run touched, plus a rotating slice of everything else.
The map fills in over weeks and stays current where the code is moving,
and an identity whose file changed loses its flag until it is checked
again.

#### When the flag is wrong

A flag is only ever granted by an identity passing alone, so the failure
that matters is the rarer one: a test that passed alone and fails when its
siblings are skipped, because it depended on a sibling in a way one solo
run did not expose. That fails a lane and passes on `main`, which is the
case [the reporter](#telling-a-pull-request-what-main-found) already
exists to explain. The failure is also evidence, and the identity loses
its flag.

### `granularity` goes with it

The `Suite` interface declared `granularity`, `"item"` or `"whole"`, so a
runner that could not be handed a subset could say so and the packer could
charge it for everything whenever anything in it was picked. Both halves
of that stop being needed.

Nothing is left to declare. Every invocation unit in the topology either
holds one identity, in which case skipping it is declining to invoke it
and no runner has to support anything, or it is a `deno test` file, in
which case the skip list reaches inside it. There is no third case, so an
enum with two values is describing a distinction the topology no longer
contains.

Nothing is left to charge, either. `whole` was a coarse way of saying that
running one thing costs you its neighbours, and
[`fileOverhead`](#what-it-costs-to-run-one-test) says that better: an
invocation with an empty skip list costs its overhead plus every identity
in it, which is exactly what `whole` meant, and it falls out of the cost
model rather than being a case in the packer.

What the enum was reaching for does survive, one level down. Whether the
identities inside an invocation unit can be skipped is a property of that
unit rather than of the suite around it, and the [table
above](#every-invocation-unit-and-the-identities-inside-it) is where it is
written down. `cli-fuse` is the illustration: its phases record
separately, and a section holding four of them cannot skip one of the
four, while a `deno test` file with four tests can. Those two suites
would have carried the same declaration under the old field and behaved
differently, which is the sign the field was in the wrong place.

### What replaces the item

The item was doing two jobs, and they separate cleanly.

The **selection unit** becomes the identity. Scores, costs, the two
exclusion rules, the two mandatory rules, repeats and the manifest all key
on the complete identity, which is what the store has always spoken in.

The **invocation unit** stays what it was: a file, a script arm, whatever
the suite's runner can be pointed at. It has to, because identities cannot
be enumerated from a working tree. Learning a test's name means running the
file that registers it, so a tree walk can only find containers. That is
also what keeps a brand-new file discoverable, and it is why `enumerate()`
survives this change unaltered.

So the topology contract moves by less than the vocabulary does.
`enumerate()` keeps its job and `locate()` keeps its job. What changes is
that `command()` takes identities rather than items, and returns one
invocation per file carrying that file's skip list, with a file whose every
identity is skipped not invoked at all.

### What it costs to run one test

The cost model gains one term:

```text
invocationCost(file) = fileOverhead(file)
                     + sum over the identities not skipped of cost(identity)
```

`fileOverhead` is fitted per file from the lane runner's own records,
exactly as `suiteOverhead` and `correction` are, and is measured rather
than chosen.

The packer changes shape because of it. An identity's cost now depends on
whether its file is already being invoked: the first identity chosen from
a file pays the overhead and every later one pays only itself. So the
density pass sorts by marginal cost rather than by cost, and choosing one
test from a file makes its siblings cheaper to add. That is a better model
of the machine than per-file items ever were, and it falls out rather than
being imposed.

### What does not change

- The per-package coverage gate runs a package's whole measured set, so
  its invocations carry no skip list.
- Suites that are not `deno test` need no mechanism. Every one of their
  invocation units holds a single identity, so skipping it is declining to
  invoke it.
- Both halves of the drift guard are unchanged: the tree half still claims
  files, the store half still claims identities.
- A repeat names an identity and invokes its file with every other
  identity in that file skipped.

### The work this adds

- [x] The preload reads a skip list keyed by registering file and name,
      and registers a listed bare `Deno.test` as ignored rather than
      dropping it.
- [x] `@commonfabric/test-support` gains a `describe` and `it` that
      re-export the real ones, track the enclosing describe chain, and
      route a listed `it` through `it.ignore`. The root import map points
      `@std/testing/bdd` at it and the real module at a second specifier.
      No test file's own import changes. A frame between the test file
      and `describe` moves the JUnit class name onto the re-export, the
      same consequence wrapping `Deno.test` already has, so ingestion
      declines a class name ending in either module and takes the file
      from the preload's name map.
- [x] Every `deno test` suite in the topology passes the preload, appended
      the way `--junit-path` already is.
- [ ] `cost` and the packing passes key on identities, with
      `fileOverhead(file)` fitted from the lane runner's records and the
      density pass sorting by marginal cost.
- [x] `command()` returns one invocation per file with its skip list, and
      omits a file whose every identity is skipped. A suite's runner takes
      several files at once, so the skip list is per file and the
      invocation is per package; module load is charged per file either
      way, which is what `unitOverhead` measures.
- [ ] The independence flag: a `main`-side check that runs an identity as
      the only test in its file, a rotating slice per run plus every
      identity whose file changed, the flag carried in the manifest, and
      the packer refusing to skip the siblings of an identity that has
      none.
- [x] A fixture proving the four properties that make this safe: an
      unlisted new test runs, a renamed test runs, a listed test is
      reported as skipped rather than missing, and two files holding the
      same test name skip independently.

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
fails if any of them is claimed by no suite's `enumerate()`, or more than
once under the same record surface and variant. A default suite and a
non-default suite may claim the same source item because they are distinct
execution surfaces. This is the half that catches a pull request adding a
test surface nobody registered, at the moment it is added, and it is cheap
enough to be unconditional. An entry in a configuration's declared skip
registry accounts for its unavailable file or leaf without pretending it
ran.

The **store half** runs on `main`. It reads the most recent successful
`main` build's records and fails if any recorded identity is one that no
suite's `locate()` claims, or that more than one suite claims. A claim names
either one item or the suite-level measurement set. The match uses the
complete identity, including an optional variant. This catches the subtler
case: a surface that is registered and whose files enumerate, but whose
recorded names or configuration do not map back to the topology — which
would leave those tests running in the full run and never selectable on a
pull request.

The reverse direction is reported rather than failed: an available item
that `enumerate()` returns and that no run has ever produced a record for
is either a test that never runs or a mapping that is wrong, and both are
worth knowing about without blocking anybody. Entries in its unavailable
list are reported separately and do not count as missing records.

Together these are what make "no continuous-integration change needed" a
checked property rather than a hope.

The failure they guard against is not hypothetical either. Until
2026-08-21 the two server-execution ON jobs were the only test jobs in
`deno.yml` with no spool directory and no ship step, so their failures
reached no report and no dashboard, and a census of 25 flakes in that lane
had to be reconstructed from raw Actions logs. The fix added a
workflow-shape invariant to `tasks/ci-workflow.test.ts` — every job
writing a JUnit file must spool and ship. Under this design that invariant
mostly stops being needed, because there is one ship step in one job
rather than one per suite, and a suite cannot be added without going
through the topology that the drift guard checks. The one ship step does
not assign identity: the lane runner stamps each batch's records before it
combines them, as described under [The lane job](#the-lane-job).

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
| `toolshed-baked-opposite` | The same, from a binary whose shell carries the server-execution define opposite the default | 42 seconds to build, or 17 to restore |
| `bg-piece-service-binary` | The compiled background service used by its deployed-topology gate | about 30 seconds to build, or under a second to restore |
| `cf` | The `cf` command-line tool on the path | as above |
| `compile-cache` | Restores a pattern compile byte cache | 3 seconds |

Two capabilities are worth explaining, because the choice made for them is
what keeps the five-minute budget reachable.

**`toolshed` runs from source.** Today a job that needs a server downloads
a compiled binary produced by a separate build job. On a pull request that
costs a build job on the critical path — 58 seconds, including its own
setup — plus 17 seconds of download in each consumer. Running the server
from source with `deno run` skips both. The dependency graph is already in
the Deno cache that the `deno` capability restores, so starting from
source costs a few seconds. The full run on `main` keeps the
compiled-binary path, because it needs the binary anyway for attestation
and deployment.

**`toolshed-baked-opposite` cannot.** The server-execution opposite arm depends
on a compile-time define baked into the browser shell inside the binary, and a
source run cannot reproduce that. So that capability has a different
provider: restore the binary from the Actions cache if the key hits, and
build it in place if it does not. The lane workflow carries one fixed
`actions/cache` step covering `.ci-cache`, keyed on a hash of the sources
the binaries are built from. Everything a lane wants to keep between runs
sits under that one directory — the built binaries, and the pattern
compile byte cache — because one step covering one directory is what
keeps the workflow independent of what the lane turns out to need. That step is in the workflow rather
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

The identity already carries an optional variant. Unmarked records made
before a non-default arm acquired a marker stay in the default history;
the publisher does not infer identity from a historical job name. The
`server-execution` histories therefore begin when those jobs started
emitting the marker. This loses the older ON arm's attribution but avoids
inventing an identity that the stored record did not carry.

The volume is real. The store took 11,432 objects on 2026-08-20, from 251
workflow runs, of which about one in six was a push to `main`. Even a
three-week read is about 250,000 objects. Nothing can afford that
on every publisher run, which is why the publisher keeps a rolling
aggregate; see [The publisher](#the-publisher). How far back each part of
the score reaches, and what a longer reach would cost, is [its own
section](#how-far-back-each-term-looks).

### What the store is missing

**Records do not carry the file for the suites that matter most.** The
`file` field is optional metadata, and today only the package integration
suites populate it, because their JUnit class names happen to be file
paths. A sample of 5,333 unit records carried it zero times. Without it,
`locate()` cannot map a unit identity to a file, and unit selection cannot
work at all.

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

**Compaction is live.** The compactor's identity was provisioned on
2026-08-31 and its daily workflow has rolled up every day from 2026-08-19
up to the newest day it has reached. The floor is where the store's
records begin. The ceiling moves with the daily run, which only touches
days that closed a week ago. Compaction collapses a day of raw records
into a manifest and a few tens of shards, which is the difference between
reading 15,000 objects for a historical day and reading a manifest and
seventeen shards. A day is a manifest and shards rather than a single
object: a day of records is over a gigabyte of NDJSON, against a maximum
string length of about half that, and an object has to fit in a string
both to be written and to be read.

**A re-run's earlier attempts can be stored a second time.** An object's
day partition comes from the run's start time, and GitHub reports that
per attempt rather than per run: across four re-run builds in this
repository every one reported a later start for its second attempt, one
of them nearly six hours later. Artifacts are scoped to the run rather
than to the attempt, so a later attempt's relay re-ships the earlier
attempts' as well as its own. Where two attempts fall either side of a
UTC midnight their partitions differ, so the re-shipped records are
written as a second object under the later day rather than colliding with
the first, and the publisher folds both because it keys on the object
name. A survey of five days of the store, 68,822 objects, found no run
identifier written into two partitions, so this has not happened yet.

What it would distort is narrower than it first looks, and the rest of
this paragraph is inference rather than measurement. Catches are safe by
construction, because each is attributed to the pair of the commit and
the source that saw it. Costs are a percentile over many observations and
would barely move. Duplicating a report doubles its failures and its runs
together, so a ratio over both is largely unmoved — but the report that
gets duplicated is the earlier attempt's, which is the one somebody
re-ran because it failed, so `churn` would carry those failures twice
against run counts that are only partly duplicated.

Fixing it means settling something this plan should not settle on its
own. The partition wants to be stable across attempts, while a record's
context honestly wants the attempt's own start, and one field is doing
both jobs today. The change reaches `ciObjectName`, the compactor, and
[the record spec](../specs/test-records.md), so it belongs to the store
rather than to selection, and it is its own piece of work.

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
scoring the two together was the mistake worth avoiding. A test failing 30
percent of the time carries almost no information per failure. A test that
has failed four times in two years, each time because somebody broke
something, carries a great deal. Flakiness is dealt with separately, in
[Flakes and repeats](#flakes-and-repeats), where it belongs.

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

For each complete identity that the topology locates to an item, the
publisher computes:

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
  halved every 14 days as they age.
- `flakeRate` — how often it disagrees with itself; see
  [Flakes and repeats](#flakes-and-repeats).
- `mainRed` — whether it failed in the most recent `main` run.
- `cost` — the ninetieth percentile of its measured durations over the
  last seven days. The ninetieth percentile rather than the maximum,
  because one unlucky runner should not permanently inflate an estimate,
  and rather than the mean, because a cost model that under-estimates
  blows the time budget.

Variants never fold into one another for scoring. A default test and its
`server-execution` counterpart have independent catches, flake rates,
costs, and red-on-`main` state. They may both be selected when their own
records justify it. History from one configuration does not make an
unseen configuration look established.

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
50-millisecond test that has never failed has a value-per-second of one,
which beats a 100-second integration test scoring 0.9 by a factor
of 100. That is the right answer, and it is what points the density pass
at the cheap tail before anything else.

### How far back each term looks

There is no single window. Each input looks back as far as it stays
meaningful and no further, because they want very different horizons and
one number damages most of them.

| Input | Horizon | Why |
| --- | --- | --- |
| `catches`, `lastCatch` | unbounded | The point of the reframing. A catch is a permanent fact about a test; `freshness` does the discounting, and it does it gently. Cost is a counter and a timestamp per identity. |
| `sources` | unbounded, alongside `catches` | Counted only over catches, so it does not saturate the way a count over all failures would. |
| `churn` | decayed, 14-day half-life, read over 60 days | Wants "is this going wrong now". A long undecayed window inverts it; see below. |
| `flakeRate` | 60 days | Flakiness is a property of the test as it stands, and tests get fixed. |
| `cost` | 7 days | Durations drift with the code and the runner image. |

The counts behind `churn` are decayed rather than cut off. That removes
the cliff a hard window has, where a failure on day 21 counts fully and
one on day 22 counts not at all, and it makes the read window a
performance choice rather than a policy one — past 60 days the weight is
under one part in 16.

**Why `churn` must decay.** An identity in the full matrix executes about
250 times a day. Take two tests: A started failing three days ago and has
failed every run since; B was broken for a week eight months ago, failing
about 60 percent of its runs that week, and has been green since.

| Window | A, failing now | B, fixed eight months ago |
| --- | --- | --- |
| 21 days, undecayed | 750 / 5,260 = **0.143** | 0 / 5,260 = **0.000** |
| 365 days, undecayed | 750 / 91,260 = **0.008** | 1,050 / 91,260 = **0.012** |

Over a long undecayed window the long-dead outage outranks the live
breakage, because a ratio over a long window measures total historical
brokenness rather than the current rate. Decay fixes it without a cut-off:
B's week contributes about one part in 5,000 after eight months. Note that
B still scores well overall — its catches are permanent — which is exactly
the intended behavior. What decays is the claim that something is wrong
*now*, not the claim that the test is good.

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
runner enforces it at item granularity: an available item that
`enumerate()` returns and that no known identity with the same variant
locates to at item level is mandatory. A suite-level measurement does not
make any item known. An identity explicitly declared unavailable by that
variant's skip registry is not unknown. History from the default
configuration does not satisfy this rule for a new variant. A newly marked
suite therefore runs in full, apart from its declared unavailable tests,
until a successful `main` run has produced records for it.

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
it looks: the topology maps records by kind, scope, and optional variant,
so a package rename without one orphans every configuration of the suite
at once.

Alias declarations name the three required identity parts and apply to
every variant. Resolution preserves the record's variant, so one rename
bridges the default and every non-default history without joining those
histories to each other.

The mechanism is there and so, by now, is the practice: the file holds
219 lines across nine dates, so renames are being bridged as they happen
rather than swept up once. What the reporter's suggestion adds is the
case nobody notices — a rename whose author had no reason to think the
history mattered.

Three things follow.

**The publisher resolves through `loadAliasResolver`.** The report tool
and the dashboard collector already do, and the publisher does. Without
it the file accomplishes nothing for selection.

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

15 percent of each lane's budget is reserved for items that the value
ordering did not pick. The draw is weighted toward items that have gone
longest without running, with random tie-breaking seeded from an
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
`main` catches within about 15 minutes and reports back.

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
in one run out of three is caught a third of the time by one run and 70
percent of the time by three. Two cases get them:

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
In the reference build the eight workspace unit shards recorded 2,737
seconds of measured test time inside 1,839 seconds of test steps. The
eight runner unit shards recorded only 1,120 seconds inside 1,583 seconds
of test steps, because work such as module loading is not part of a test's
own duration. That is about 1.49 seconds of measured tests for every
second of test step in the workspace shards and about 0.71 in the runner
shards. The two suites are a factor of two apart, so no one static
multiplier captures both.

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
lane that opens the Toolshed server has 40 fewer seconds for tests than
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
lanes times 230 seconds each, it fills in four passes.

1. **Mandatory.** Everything marked mandatory goes in first: the `always`
   suites, the items the diff touched directly, the items the coverage
   attribution map says execute the changed lines, every item of a
   covered package the diff touched as described in [The one coverage gate
   that survives](#the-one-coverage-gate-that-survives), and the items with
   no history. An item excluded above comes back into this pass if the
   change touches what it covers, since that is very likely a fix. Every
   item taken here leaves the selectable set, so no later pass can run one
   of them again. This pass can in principle put a lane past its budget;
   when it does, the runner says in the job summary how far past, rather
   than silently dropping work.
2. **Value first, 60 percent of the remaining budget.** Items in
   descending order of value, ignoring cost. This is what gets the
   expensive, genuinely broken integration test into the run.
3. **Density, 25 percent.** Items in descending order of value divided by
   cost. Because of the value floor, this pass sweeps up the cheap tail:
   thousands of sub-second tests at a value-per-second that nothing
   expensive can match.
4. **Exploration, 15 percent.** The draw described above.

Passes 2 and 3 both account for the setup a choice would open. An item
whose suite needs a capability no lane has opened is charged the
capability's setup cost the first time it is picked, so a lone cheap test
behind 40 seconds of setup correctly loses to 40 seconds of tests that
need nothing.

Repeats are applied last, to items already selected, and are charged their
full cost. An item that would be repeated but no longer fits gives up runs
until it does, down to one, rather than being dropped: one observation
beats none.

### Filling the lanes

Once the set is chosen it is packed into five lanes by longest-processing-
time scheduling, which is what `tasks/weighted-shards.ts` already
implements and what the existing shard selectors already use. Batches are
the units being packed and capability setup costs go in as the initial
loads, so a lane that has already opened the Toolshed server is the
cheapest place to put the next batch that needs it. That is the mechanism
by which "tests needing the same environment are grouped together" falls
out of the packing rather than being a special case in it.

The cheapest lane is chosen from among the lanes that can still hold the
work, which is what makes the 230 seconds a constraint on the packing
rather than a figure it aims at. When the cheapest lane is full the item
goes to the next-cheapest one with room for it, so a suite whose overhead
one lane has already paid collects that lane's share of the suite and no
more. The value, density and exploration passes each spend a share of the
whole run's budget, and none of the three puts a lane past its own. The
corpus holds far more than a run can fit, so between them those passes
fill every lane, and what the pull request waits on is 230 seconds rather
than whichever lane the grouping favored. Two things are allowed past a
lane's budget, and the next two paragraphs are about them: the mandatory
pass, and an item costing more than a whole lane.

The mandatory pass is the one allowed past a lane's budget. It takes its
items largest first, so an item filling most of a lane is offered the
lanes that are still empty; an item offered lanes that are already full
has nowhere to go but past one lane's budget. When a mandatory item fits
in no lane it goes where the lane's finishing time rises least, which
spreads an unavoidable overrun across the five rather than settling it on
one.

A batch that on its own exceeds a lane's budget is split, paying its
suite's setup twice. A single *item* cannot be split, so an item costing
more than the planned budget is given a lane to itself and allowed to run
up to the hard five-minute bound rather than the planned 230 seconds. The
lane carrying it carries nothing else, because everything else would have
to fit in what is left under the planned budget and there is nothing left.
Repeats get no such lane, since a repeat is what an item gives up to fit:
an item wanting three runs of a hundred seconds runs twice inside the
planned budget rather than three times inside the bound.

The refreshed census finds one item that does not fit. The `piece-call`
dispatch section of `packages/cli/integration/integration.sh` took 386
seconds in the test step, 86 seconds past the hard bound. Its eight
recorded steps are already separate identities, and the slowest took 87
seconds.

The fix is nearly free, because the script is already most of the way
split. Seven of those eight steps have an arm that runs them alone today:
`piece-call-retry`, `three-topic`, `verbs`, `verb-gaps`, `completion`,
`topics-drill`, and `bulk-survey-drill`. Only `run_piece_call` has no arm
of its own, because the `piece-call` arm runs it and then seven more. So
the script gains one arm, and `cli-core` enumerates the single-step arms as
its items and leaves the grouped arms to people running the script by hand.
Running the steps as separate invocations pays the script's own startup
once per step instead of once per group. That cost rises with the number of
items selected, which is the shape `correction(cli-core)` is fitted to
absorb.

The item-level dry run described below then determines whether anything
else is unschedulable; individual identity durations cannot answer that for
files containing several tests.

The manifest still carries an `unschedulable` list for new items that do
not fit, and the report tool surfaces it. The general fix is the 60-second
rule that
[`tasks/test-records-report.ts`](../development/test-records.md#reading-the-data)
already ratchets. 12 distinct identities currently break that rule; their
15 executions hold 18 percent of all measured test time. Getting them
split is valuable independently of this plan and becomes more valuable
with it.

### Why the lanes do not coordinate the plan

The five lanes do not talk to each other. Packing is a pure function of the
manifest, the diff, and the lane number, and all five lanes run the same
function over the same inputs, so they agree by construction. Adding a
mandatory item is part of that function, so the five agree about where it
lands too.

Joining what the lanes measured is a different thing and does happen, in
`Status`. The distinction is which side of the lanes the job sits on. A
job that decided the plan would sit *before* them, on the critical path,
and every lane would wait for it. A job that joins results sits *after*
them, in a position that has to be occupied anyway because GitHub wants
one required check to read. Nothing is bought by refusing to use it.

The full run on `main` does have a planning job before its lanes,
`plan-full`, because there the number of lanes is not fixed and GitHub
needs the matrix before it can start anything. A pull request needs no
planning job because `LANES` is a constant, so each lane can work out its
own share. What `plan-full` decides is the lane count and nothing else,
so `main`'s lanes work out their own shares the same way a pull request's
do.

What the two runs do differ in is two values handed to the same
function: the policy, which is `everything` for the full run and
`budgeted` for a pull request, and the diff, which the full run does not
have. Under `everything` every identity is required, so the exclusions
and the value, density and exploration passes have nothing to act on and
the rest of the packer behaves identically for both. Holding the
difference to those two values is what stops the two runs drifting into
enumerating different tests, applying a suite's settings unevenly, or
packing the same work in reliably different orders.

The function must therefore be deterministic: no wall clock, no unseeded
randomness, no dependence on anything but its inputs. The exploration
draw's seed comes from the manifest. `plan()` lives in
`tasks/test-selection/plan.ts`, is called by both the publisher and the
lane runner, and is straightforwardly testable offline against a recorded
manifest.

Re-running a single failed lane later must not shuffle the work. The lane
resolves the manifest as *the newest one generated at or before the
commit under test was made*, reading the committer date out of the
checkout.

What the moment has to be is stable rather than exact: every lane of a
run has to agree, and every later attempt has to agree with the first.
Nothing about the run satisfies that. GitHub reports `run_started_at`
per attempt rather than per run — measured across four re-run builds,
every one reported a later start for its second attempt, one of them
nearly six hours later — so an attempt resolving at its own start would
pick up whatever manifest is newest by then. Its five lanes would agree
with one another and disagree with the attempt before them, which is
worse than either: a test the first attempt placed in the lane that
failed can move to a lane the re-run does not run, leaving `Status` green
over a set no attempt ran whole.

The commit is stable by construction, and it needs nothing from the
service that scheduled the run — no credential, no request, and no
failure path where the request is refused. It is also the same value on a
workstation as in a job, so `plan --dry-run` answers the question a lane
would answer instead of resolving against the clock. And it is the better
anchor on its own terms: the manifest worth reading is the one that was
current when the tree under test came into being. The committer date
rather than the author's, because a rebased or cherry-picked commit keeps
the date it was first written.

## What the census can project

Working from the reference build's numbers, and from the budget in [The
budget, and why it is derived rather than
chosen](#the-budget-and-why-it-is-derived-rather-than-chosen).

Five lanes at 230 seconds inside the work step is 1,150 seconds.
Capability setup takes perhaps 200 of that across the five, leaving around
950 seconds of test execution.

The one-second-and-under tail is 16,168 executions holding about 1,046
seconds of measurement. What that costs in lane time depends on which
suite the executions come from, and the two unit suites in the reference
build are a factor of two apart. At the workspace shards' rate of 1.49 the
whole tail costs about 700 seconds. At the runner shards' rate of 0.71 it
costs about 1,480. The budget is 950. The tail may fit and it may not, and
this census cannot say which.

Two further things mean less of the tail is bought than either end of that
range would suggest, and neither can be quantified yet. Selection happens
at item granularity, and a
unit-test file holds cheap and expensive identities together, so there are
fewer independently selectable cheap items than there are cheap executions.
And the density pass that sweeps the tail up gets a quarter of what the
value-first pass leaves rather than the whole remainder.

**None of that puts the design in doubt, because keeping the whole cheap
tail was never the objective.** The objective is running the tests that
find things. The mandatory pass and the value-first pass are where that
happens, and both are served before the tail is considered at all. The tail
is a bonus, bought with what those two leave: cheap enough per unit of
value that the density pass takes a great deal of it, and when it no longer
fits entire the density pass takes as much as its share affords, in
descending value per second. A pull request that runs every valuable test
and a large share of the cheap ones is doing the job this system exists to
do.

What would put the design in doubt is the mandatory set alone not fitting
in five lanes, or the value-first pass being unable to afford the expensive
tests that actually catch regressions. Neither is what this census shows.

The earlier version of this plan claimed the cheap tail fit in under half
the budget, on a conversion rate of two and a half taken from the fastest
single shard of one build. That rate was the weakest number in the
document and it did not survive a census across all 16 unit shards. What
it supported was the bonus and not the requirement, which is why losing it
changes the expected selection rather than the plan.

`deno task test-selection plan --dry-run` over the reference records
replaces this range with the first defensible projection, once the
topology classifies every identity, maps every item-level identity to a
runnable item, and gives the `piece-call` steps their own items. It
reports selected item count, measured test time, capability setup,
repeats, and unschedulable items, and it runs offline over recorded data,
so it is a check the branch makes before merging rather than something to
wait for. All five lanes must fit with the 30-second safety margin intact.

The end-to-end target depends on none of it. A packed lane has 230 seconds
of planned work and 40 seconds of prologue, so the five parallel lanes
target about four and a half minutes against the reference build's 15
minutes and 23 seconds. The continuously fitted suite overhead and
correction values turn that target into measurement once lanes begin
running.

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
no `current.json`. The leading timestamp keeps object names
chronologically useful, but it does not decide publication order. When a
lane resolves a manifest, it lists object metadata once and takes the
newest object generated at or before the commit under test, using the
object name to break a tie. A manifest published while the run is going
is generated after that date, so it cannot change the answer, and every
lane and every later attempt reads the same commit and reaches the same
object. What the answer does depend on is retention: the manifests a
commit can resolve have to outlive the window in which that run may be
re-run, which is a retention setting on the bucket rather than anything
this reads.

The object carries:

- the schema version, the generation time, and the exploration seed;
- the `main` commit whose topology was enumerated, and how many runs the
  aggregate saw;
- every dial it was built with, so the manifest explains its own
  behavior and two manifests can be diffed for why they differ;
- the calibration numbers: `setupCost` per capability, and
  `suiteOverhead` and `correction` per suite;
- every item: its complete identity or identities, optional variants
  included, its suite, its file, its cost, its score, the inputs behind
  that score, its flake rate, its repeat count, and the last day
  anything ran it, which is what orders the exploration draw;
- the withheld sets — failing on `main`, and above the flake exclusion
  rate — each with the reason, so a lane can say why something is absent;
- the tests declared unavailable in a configuration-specific skip
  registry, with their suite, variant, phase, and reason;
- the reference packing into five lanes;
- the `unschedulable` list;
- a count and digest of the known item-level identities, for the
  unknown-item rule;
- the name of the newest coverage attribution map, which is published
  beside the manifest on its own weekly cadence rather than inside it.

The size is measured rather than bounded. A publisher run over one day of
the store — 18,849 objects holding 5,487,611 executions — produced 20,091
identities, and the manifest carrying them is 9.59 megabytes serialized
and 1.05 megabytes gzipped, which is 478 bytes an entry. Identity names
dominate that: a describe chain runs to a hundred characters and more, and
the numbers beside it are rounded to the digits that mean anything. One
megabyte is a fetch of no consequence at the start of a job.

The same source item in default and non-default suites appears as two
manifest items. Their suite identifiers and complete record identities
keep their selection and cost histories separate. The digest of known
identities uses the canonical test-record identity key, including the
fourth part only when a variant is present.

The manifest is untrusted input to the lane runner, and is validated the
same way record lines are: a malformed manifest is rejected whole, and a
manifest whose schema version the runner does not know is treated as
absent. Retention is a bucket lifecycle rule deleting manifests after 45
days.

## The publisher

`.github/workflows/test-selection.yml`, on a four-hourly cron and on
manual dispatch. Four hours rather than a fixed daily hour: aggregation is
incremental and therefore cheap, and a flake that appears at nine in the
morning should not wait until four the next morning to be prioritized.
Manual dispatch is there so that somebody who has just fixed something can
refresh without waiting.

The job:

1. Reads the newest state object, which holds the submission object names
   and source-and-date rollup receipts already folded, along with the
   aggregate they produced.
2. Applies the one input plan described below. In the steady state this is
   about 2,000 objects per run.
3. Folds them in, ages the decayed counters by a day, classifies each new
   failure as a catch or as flake evidence, scores everything, reads back
   the lane timing records to update the corrections, calls `plan()` with
   an empty diff to produce the reference packing, and writes a new state
   object and a new manifest.
4. Reports, in the job summary, the projected per-lane times, the spread
   between them, what fell off the budget, and anything unschedulable.

A cold start reads a much wider window. The bootstrap is a manual
dispatch with `--bootstrap --days 60`, run once, after which the
incremental path keeps up. Sixty days of raw objects is hundreds of
thousands at the volume the store now takes, which is more than one job
can read, and that is where the rollups earn their place: the bootstrap
takes one rollup for each closed continuous-integration day, standing in
for that day's thousands of objects, and reads raw only the days no
rollup covers and every local source.

### One input plan for bootstrap and ordinary publishing

Bootstrap is permission to start from an empty aggregate and a larger
default window. It is not a second way to choose inputs. Both modes apply
the same rule independently to each source and date:

1. A receipt in the aggregate says this pair was folded from its rollup.
   A rollup records neither the objects it covers nor a point it is
   complete through, so nothing can say how much a raw object of that
   pair would repeat. The pair is closed rather than combined with
   objects whose overlap is unknown.
2. When nothing of the pair is folded and a rollup covers it, the rollup
   is the baseline and a receipt is written for it. One object stands in
   for the day's thousands, which is what makes a cold start over a wide
   window affordable at all.
3. Everything else reads raw objects, and two different things reach it.
   A pair with raw contributions already stays raw, because a rollup
   written afterwards would overlap them. A pair no rollup covers is raw
   because there is nothing else to read, which is every local source:
   rollups cover the continuous-integration area alone.

The current rollups cover CI only. Local submissions always take the raw
path. A date-only `compactedDays` receipt is therefore not sufficient: it
can make a CI rollup suppress local submissions from the same date. The
receipt is scoped by source as well as by date.

This rule lets an ordinary publisher use a rollup for a previously unseen
old date, such as one reached while catching up after an outage or after
a window expands. It does not make a steady-state publisher switch a date
from raw objects to a rollup seven days later, after the raw
contributions are already in its aggregate.

The publisher needs a writer credential for its own prefix. That is the
`test-selection-labs` service account with `objectCreator` on
`labs/test-selection/`, reached through a Workload Identity provider
pinned to exactly this workflow file on `main` — the same pattern, and
the same security argument, as the relay already uses. The infra
repository owns the account and the provider under `tofu/test-records`,
and both are applied. Nothing else needs a credential: a lane reads the
manifest it resolves and writes nothing.

When the publisher fails, nothing breaks: the previous manifest is still
the newest and lanes keep using it. A manifest going stale degrades
selection quality slowly rather than failing anything, which is the right
direction for a system nothing should gate on.

## The lane job

Nothing runs before the lanes. Each one resolves the manifest from the
commit it has checked out, so five lanes reach the same answer without a
job to tell them what it is:

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
  permissions:
    contents: read
  strategy:
    fail-fast: false
    matrix:
      lane: [1, 2, 3, 4, 5]
  steps:
    - name: 📥 Checkout repository
      uses: actions/checkout@v7
      with:
        fetch-depth: 0
        persist-credentials: false
    - name: 🦕 Setup Deno
      uses: ./.github/actions/deno-setup
    - name: 🔍 Verify lock file & install dependencies
      uses: ./.github/actions/deno-install
    - name: ♻️ Restore the built-binary cache
      uses: actions/cache@v4
      with: { path: .ci-cache, key: ... }
    - name: 🧪 Run the lane
      timeout-minutes: *lane-work-timeout
      run: >-
        deno run -A tasks/ci-lane.ts
        --lane ${{ matrix.lane }} --of 5
        --base origin/${{ github.base_ref }}
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
`LANE_WORK_TIMEOUT_MINUTES` at five and `LANE_JOB_TIMEOUT_MINUTES` at 15,
satisfying the repository's rule that a job's bound is at least ten
minutes above its work step's. `tasks/ci-workflow.test.ts` enforces that
rule and needs the new anchors added to it.

The ship step carries neither a `variant` nor a `--junit` specification,
which is the last piece of per-suite knowledge to leave the workflow. A
lane may contain default and non-default batches, so the action's
job-wide `variant` input cannot represent it. The lane runner gives each
execution of a batch its own spool directory and output paths. This
includes every repeat. The suite's command describes each JUnit output
with its kind, scope, and optional file prefix. The suite's optional
variant applies to every direct and JUnit-derived record from that batch.

This uses the existing gather behavior rather than defining a second way
to apply variants. The part of `tasks/test-records-gather.ts` that reads
records, ingests JUnit, and applies a declared variant becomes a reusable
function. Both its command-line entry point and the lane runner call that
function.

When a suite declares a variant, the function writes that value onto every
record, replacing any value a producer supplied, exactly as the current
job-level `--variant` option does. When a suite is default, the value stays
absent.

A direct record carrying a variant in a default batch does not match that
batch's topology, and neither does one whose kind and scope are outside the
suite's declared record surfaces. The lane runner keeps both as the
producer wrote them, and names the conflict in the job summary. It does not
fail the batch: this is a metadata mistake, and the tests it came with
either passed or did not. The record then belongs to no suite, so the store
half of the topology drift guard fails on the next `main` run and names it,
which is where every other kind of topology drift is caught. Dropping the
record instead would put the only signal in a log line and leave the item
looking merely unrecorded, and an item with no records is reported and
never failed.

The final action only packages the already-complete lane spool. The lane's
own setup and batch-timing records remain unmarked. Their names contain the
suite identifier, and they measure the lane machinery rather than an
alternate execution of one test.

What the runner does, in order:

1. Resolve the manifest from the commit's date and fetch it, then fetch
   the attribution map that manifest names. No manifest at or before that
   date, or a fetch failure, takes the fallback (see [Failure
   modes](#failure-modes)).
2. Enumerate every suite against the working tree, and read the manifest
   against that enumeration. The tree decides which tests exist and the
   manifest decides what each is worth and costs, so an entry naming a
   unit the tree no longer has drops out and a unit the manifest has
   never seen gains a stand-in. Everything after this reads the result
   rather than the manifest the store gave, which is what keeps the full
   run and a pull request working from one answer about what exists.
3. Compute the diff against the merge base, and resolve the changed source
   lines through the attribution map to the items that execute them. The
   full run skips this: it has no diff.
4. Call `plan()`, take this lane's plan. The full run calls it with the
   `everything` policy, and with the empty diff step 3 left it. Those two
   values are the whole of the difference between the two runs.
5. Print the plan to the job summary: which batches, which items, what
   each is expected to cost, why each was chosen, which items were
   withheld and why, and which manifest the plan came from.
6. Set up the union of the capabilities the batches need, recording each
   one's duration.
7. Run each batch execution with fresh spool and JUnit output paths,
   recording planned and actual durations and continuing past a failure so
   that one failure does not hide later batches or repeats.
8. Immediately after each execution, gather its direct records and
   described JUnit outputs into the lane spool through the shared gather
   function. Validate record surfaces and apply the suite's optional
   variant before another execution can reuse any runner-owned path. Then
   convert the coverage this lane produced into one report per workspace
   member and upload it for `Status` to join.
9. Exit non-zero if any batch failed, or if any repeat of any item failed.

## The full run on `main`

A push to `main` still runs everything, and it runs it through the same
topology so that the two paths cannot drift.

`deno.yml` gains a small `plan-full` job that runs on push and emits one
integer: how many lanes the run needs. It gets that from `deno run -A
tasks/ci-lane.ts --full --lane-count`, which reads the working tree
against the manifest and raises the lane count while that reduces the
total by which the lanes are over the full run's budget. The total
rather than the worst lane: one test costing more than a whole lane
holds its own lane over budget at every count, so a search reading the
worst lane would stop at the first step and leave every other lane
packed far tighter than the budget it was given.

A `full-tests` job consumes the integer with `strategy.matrix:
fromJSON(...)` and runs the same `tasks/ci-lane.ts` with `--full`. The
build, attestation, coverage and deploy jobs keep their present shape
and depend on `full-tests` in place of the long dependency lists they
carry today.

An integer is deliberately the whole of what passes from the planning job
to the lanes. Each lane reads the same tree against the same manifest and
computes the same packing for itself, exactly as the pull-request lanes
do, so nothing about which tests run travels through a job output and
there is no second packing anywhere to disagree with theirs. A planning
job that emitted the packing would be a second planner, and the two would
drift.

The full run's packing needs durations but no selection, so it reads the
manifest for its cost table. Where nothing in the tree has a measured
cost it falls back to the larger of one lane per suite that has anything
to run and what packing the stand-ins asks for. Less even, still
complete, and requiring no committed weight table to maintain.

The condition is what the tree holds rather than whether a manifest
arrived, because those are not the same question. A manifest published
before most of a tree existed arrives and still knows almost none of it,
and a cost model reading that one is as blind as a cost model reading
nothing at all.

The fallback is a count rather than a cost model on purpose. Where
nothing is measured, a projection from costs is arithmetic over whatever
figure stands in for the ones nobody measured, and it is wrong by
however wrong that figure is. Against this repository the stand-in
figure puts the whole corpus at 2,403 seconds where the reference build
measured 9,960, and the count that follows from it is five lanes for a
run that today takes 67 jobs. The error is also in the direction that
breaks a run: too few lanes means every one of them runs past the bound
its job is killed at, where too many means some jobs finish early.

So a lane per suite with anything to run goes in as a floor. It needs no
number nobody measured, and it grows as test surfaces are added.

The packing is still asked what it would need, and the larger of the two
wins. Its answer is only as good as the stand-in costs behind it, which
is why it cannot be the whole of this — but those costs are what the
lanes will actually be packed against, so an answer below what they
imply is one the lanes cannot honor whatever else is true. That matters
most where a stand-in costs more than the bare unmeasured figure. A
suite whose measured units have all been renamed away carries its old
median onto every stand-in, and a count that assumed the bare figure
would be out by that whole multiple.

What comes out is a bound rather than a plan: the lanes still pack
themselves, and one of them may hold several suites.

A lane packing against stand-in costs says so in its summary, for the
same reason: a projected time that rests on nothing measured is a
different thing from one that rests on a week of records, and the job
summary is where somebody finds out which they are reading.

Before the pull-request path replaces the old matrix, `main` must complete
at least one successful full run whose records account for every item the
topology enumerates under its exact variant. The only permitted absences
are identities modeled as unavailable by a configuration-specific skip.
The store half of the topology drift guard must pass against those same
run records, and the publisher must produce a manifest from them. This
proves the complete identity-to-suite mapping and prevents a variant with
no records from making its entire suite mandatory on the first selected
pull request.

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

`Status` also joins what the lanes measured. Each lane uploads the
coverage it produced, one report per workspace member, and `Status`
downloads the five, adds them up per member, and runs the [per-package
coverage gate](#the-one-coverage-gate-that-survives) over the totals. It
is the only job in a position to do that, and it is a job that has to
exist regardless, so the gate costs a download and an arithmetic pass
rather than a job.

`Status` decides which packages the gate covers by running the same
function the lanes run, over the same diff and the same manifest, rather
than by trusting what a lane reported. That includes the cap on how many
covered packages a change may touch, so a lane cannot talk `Status` into
gating something or into skipping something.

Two rules keep the joined result honest. A coverage failure says in the
summary that it is a coverage failure, so it is never mistaken for a test
failure. And when any test in a covered package failed, that package is
reported rather than gated, because coverage measured through a failing
suite says nothing about whether the change was tested and the failure is
the thing to fix.

### What moves to `main`, and what happens to coverage

`Status` is a pull-request check and its `needs:` list becomes `pr-tests`
and `full-tests`, with the two-clause rule above.

Repository-wide coverage measurement moves to the full run and stops
gating; the per-package gate that stays on pull requests is in [The one
coverage gate that survives](#the-one-coverage-gate-that-survives), and it
runs inside a lane rather than in a job of its own. Concretely: the
`Coverage Check` job becomes push-only and reports rather than fails,
which takes a job off every pull request. The barrier it sat behind does
not go away, because `Status` is a barrier by construction, but what
happens at that barrier shrinks from a 12-artifact download and a
repository-wide metric to five small reports and an addition. The
compile-cache state recording that feeds it moves with it. The full run
converts each workspace member's coverage directory separately, so the
per-package baselines come out of it. And `coverage-comment.yml` is
generalized into the reporter described in [Telling a pull request what
`main` found](#telling-a-pull-request-what-main-found) rather than deleted
— it already does the hard part, which is posting to a pull request from a
trusted context with a write token.

## Coverage

Gating on the repository's whole coverage number cannot survive selection,
and saying so is not the same as giving up on coverage. That gate compares
a pull request's measured coverage against a `main` baseline; a pull
request that runs a fifth of the test time measures a fifth of the
coverage and reads as a catastrophe every single time. There is no
threshold that rescues that comparison, because the thing being compared
is no longer the same thing.

What the gate was actually for is worth separating from how it worked. It
was there so that coverage keeps going up, or at least stops going down
quietly. That goal survives, and it is served three ways: as a trend on
`main`, as a gate over the packages a pull request can still measure
whole, and as information about the diff itself.

### The repository-wide number is a trend, not a gate

Coverage debt across the repository is measured on `main`, from the full
run, and it gates nothing. Not on pull requests, where a run of a fifth of
the test time measures a fifth of the coverage, and not on `main`, where a
red build for one uncovered line would make `main`'s color mean nothing.
One narrower measurement does still gate pull requests, and it is the
subject of [the next section](#the-one-coverage-gate-that-survives).

It is a dashboard tile instead, and the tile follows [the wall's
rules](../../packages/dashboard/README.md#philosophy-and-values). It shows
the count of uncovered lines and, under it, what a median day does to that
count, which is the part somebody can act on. It is not a percentage:
a coverage percentage is exactly the kind of figure that stops meaning
anything the moment somebody optimizes for it. It goes amber when the
median day over the last three weeks is a rise, which takes more than half
the days in the window and so cannot be one bad day. And it reports on the
system: no per-person anything, no ranking, nothing that could be read as
a scoreboard.

That tile is live, ahead of the rest of this plan. It reads the
repository-wide `coverage-debt: workspace uncovered lines` figure out of
each `main` run's `perf-metrics` artifact, which the full run on `main`
produces today and goes on producing under selection.

The `ACCEPT_COVERAGE_DEBT` markers stay. They are how somebody says "yes,
knowingly", and they remain the right escape hatch whether or not anything
gates on them.

Nothing about coverage fails a run on `main`, and that includes the
per-package numbers the next section gates on. `main`'s job is to measure:
its full run produces the repository-wide figure for the trend and each
covered package's own-tests figure for the baselines, and a landed change
that added an uncovered line must not turn `main` red for it. What happens
instead is that the rise is reported back to the pull request that caused
it, by [the reporter](#telling-a-pull-request-what-main-found). The
ratchet has teeth in the one place a person can still act on it, which is
before the change lands.

### The one coverage gate that survives

What stops the repository-wide gate working under selection is that its
two sides no longer measure the same thing. There is a case where they
still do. Take a package that owns its own unit tests, score only that
package's source, and count as covered only what those tests reached. Run
every one of those tests and the measurement is complete, whatever
selection did anywhere else in the run. Nothing about it depends on how
many tests the pull request chose, so the comparison against `main` stays
honest, and so it can gate.

That is also the comparison an author most wants. It answers "did the
change I just made to this package leave more of this package untested
than before", which is a question about the diff in front of them.

#### The measurement is already being made and thrown away

`tasks/workspace-tests.ts` runs one `deno task test` per workspace member,
and it already points each one at a coverage directory named for that
member. The per-package split exists on disk in every workspace unit
shard today. `tasks/write-coverage-lcov.ts` then walks those directories
and merges everything under a shard into one report, which is where the
split is lost.

Converting each member's directory on its own instead yields, for every
package, exactly the coverage its own tests produced. On `main` that costs
no runner time at all, because those tests already ran that way and the
profiles are already written. It is a change to how the profiles are
converted, not to how anything runs.

The directory belongs to the member rather than to the walk that happens
to run it. A package whose tests are a suite of their own writes one the
same way, so nothing about the gate depends on which suite a package's
tests sit in.

The counting rules are the existing ones in `tasks/coverage-metrics.ts`,
including the rule that a file compiling to nothing is charged nothing, so
a declarations-only file costs a package nothing here either. The result
is a separate series from `coverage-debt: packages/<name> uncovered
lines`, which sums every job in the repository that loads those files. The
two are never compared against each other, and the manifest keeps them
under distinct names so nothing can.

#### Which directories are covered

Every workspace member under `packages/` carries the gate, at whatever
depth the member sits: `packages/memory`, `packages/connectors/github`,
and anything nested deeper the same way. The unit is the workspace member
rather than a fixed path depth, which is what makes depth stop mattering.
Adding a package means adding it to the `workspace` array in the root
`deno.jsonc`, because nothing in the repository knows a package exists
until it is there, so a new package is covered from the moment it exists.

Nothing else is. `tasks` is one coverage group rather than a directory
tree of them, and `scripts` is left out of coverage accounting entirely
today.

A member is out only by being named in `EXCLUDED_FROM_COVERAGE_GATE` in
`tasks/test-selection/policy.ts`, beside every other dial, each entry
carrying the reason it is there. A list is the right shape for this
because the alternative — a rule that measures each package and decides —
can take a package's gate away for a change nobody meant as a change to
coverage, and a gate that silently stops gating is worse than no gate. The
list is what it is today:

| Excluded | Why |
| --- | --- |
| `packages/generated-patterns` | Its test task is `echo 'No tests defined.'`. Its test files run in the generated-patterns integration job. |
| `packages/home-schemas` | It has no tests. |
| `packages/patterns/auth` | Its test task is `echo 'No tests defined.'`. |
| `packages/patterns` | Authored pattern code is measured by transformer instrumentation in the pattern unit and integration jobs. The package's own `deno test` ignores the pattern files deliberately. |
| `packages/runner` | Its whole set is past what all five lanes hold together: about 1,600 seconds of test steps in the reference build, against a budget of 1,150. |
| `packages/cli` | The command line's real coverage comes from the integration script rather than from these tests, so gating on them would ratchet the wrong number. |
| `packages/identity` | Every one of its tests runs in a browser through `deno-web-test`. It has no Deno-only half to measure. |
| `packages/deno-web-test` | Its tests drive the browser harness end to end. |
| `packages/toolshed` | Its tests want the service's own environment and its initialized database. |

That leaves 33 of the 42 members under `packages/` covered,
`packages/memory` among them. `packages/agents-host` and `packages/piece`
are two of them: both are hand-sharded today, and being hand-sharded stops
meaning anything once the packer does the sharding and `Status` joins what
the lanes measured.

One entry is there for size. Because `Status` joins the lanes' coverage, a
package's tests do not have to land in one lane, or even in one batch —
they are ordinary mandatory items that the packer distributes like any
others, and the totals meet again afterwards. What a package's tests have
to fit inside is the whole run's budget rather than a lane's, which is
five times the room. `packages/runner` still does not fit it, at around
1,600 seconds against about 1,150 for all five lanes together. Nothing
else comes close to that.

None of this is special to those packages any more either: [sharding stops
being written down](#sharding-stops-being-written-down) in the same pull
request, so `packages/runner` and the rest become ordinary suites whose
items the packer distributes like every other. The numbers are from the
reference build and are what the item-level dry run checks; a package
listed for a size it no longer has comes off.

The list is a starting position and is expected to shrink. The publisher
reports which listed packages would now fit the run's budget, the same way
it reports a covered package that has grown expensive, so a line comes off
because somebody read a measurement rather than because a threshold moved
on its own. Two entries are there because the package has no Deno-only
tests at all, and the moment one gains some, the same holds.

#### Adding a browser test must not cost a package its gate

A package that mixes Deno-only tests with tests that need a browser should
keep the gate over the Deno-only half rather than losing it. That is
practical here, and the repository is already most of the way to it,
because every package that mixes the two already separates them inside its
test task. `packages/static` names them as two tasks, `deno-test` and
`browser-test`, and joins them in `test`. `packages/ui` and
`packages/iframe-sandbox` write the same split as one string: a `deno test`
with the browser files listed in `--ignore`, then `&&`, then those same
files handed to the browser harness.

So the convention is the one `packages/static` already follows. A member
that has a Deno-only half names it `deno-test`. The gate measures
`deno-test` when a member defines one and `test` otherwise, and
`tasks/workspace-tests.ts` gives `deno-test` a coverage directory of its
own so that the baseline on `main` and the run on a pull request measure
the same half. A member with no `deno-test` is unchanged in every respect.

`packages/ui` and `packages/iframe-sandbox` get their one-string tasks
split into `deno-test` and `browser-test` the way `packages/static` writes
it. Both keep the gate over their Deno-only halves, which is coverage the
share-based rule this replaced would have taken away from them. Adding a
browser test to any covered package is then an edit to `browser-test`, and
the gate does not notice.

#### What a covered package costs is reported, never enforced

A package whose measured set grows past `LOCAL_COVERAGE_MAX_SECONDS` is
named in the publisher's summary, and by the `coverage` operator mode
below. Nothing happens to it automatically. Somebody then decides whether
to split the package's tests, let the run carry the cost, or add a line to
the exclusion list — all three being decisions about the repository rather
than about one pull request, which is why they belong to a person and not
to a threshold.

#### A change that touches more than two covered packages is not gated

The mandatory set a covered package adds is its whole measured test set,
and a change touching several packages adds all of theirs. A sweeping
change would spend most of a run re-running suites it barely touched, and
the gate's value falls as the change gets broader anyway: over three or
four packages at once, "did this leave more untested" stops being a
question about one thing somebody can look at.

So when the diff touches more than `LOCAL_COVERAGE_MAX_PACKAGES` covered
packages, the gate is off for that pull request entirely. No package's set
is forced whole, nothing is gated, and `Status` says the gate did not run
and why. The tests are still selected normally, and the items the diff
touched directly are still mandatory under [what the change touches must
run](#two-rules-that-force-a-test-in); it is only the run-the-whole-package
part that stops.

Off entirely rather than off for some of them. Gating two of the four
packages a change touched would mean the gate quietly ignored the other
two, which is the failure this design keeps refusing elsewhere. A cliff is
also predictable: an author can tell from the diff whether the gate
applies, without knowing what any package's tests cost.

Nothing is lost permanently. The full run on `main` measures every
package, so a rise that a skipped gate let through is caught there and
[reported back to the pull
request](#telling-a-pull-request-what-main-found), named as a rise the
gate would have caught.

#### What a pull request does

When the diff touches a covered package's tracked source or its tests, and
the pull request is under the cap above, every item in that package's
measured test set becomes mandatory, and runs once with coverage turned
on. They are packed like any other mandatory items, so a large package
spreads across lanes rather than filling one.

Run once is enforced rather than hoped for. A mandatory item leaves the
selectable set, so no later pass can pick it a second time, and repeats do
not apply to a measured item: running it twice covers nothing a first run
did not. Coverage makes those tests slower, so their items are costed from
the lane runner's recorded with-coverage durations rather than from the
ordinary ones, fitted the same way every other cost in this design is.

Each lane converts the coverage it produced into one report per workspace
member and uploads it. `Status` adds the five together, scores each
covered package the diff touched, and fails when the uncovered count has
risen. A rise is accepted with the marker the repository already has, in
the same form and with the same rebase-proof meaning:

```text
ACCEPT_COVERAGE_DEBT: packages/memory +12 lines
```

#### The baseline, and when it declines to fail

The manifest carries the per-package numbers for every full `main` run in
the last `LOCAL_COVERAGE_BASELINE_DAYS`, each against its commit. `Status`
picks the nearest ancestor of the merge base, which is the walk the
present ratchet does over downloaded artifacts, done here over data the
newest manifest already holds.

Two cases report instead of failing. A package with no baseline yet is
reported, because the first pull request to touch a new package should not
inherit the whole of that package's debt. And when the manifest holds no
run that is an ancestor of the merge base, the comparison is against a
tree the branch does not contain, so a rise measured against it is not the
branch's rise.

#### Why this one is sound

Both sides run the same complete set of tests over the same package.
Selection cannot skew it, because within that package nothing is selected.
Sharding cannot skew it, because the package is one invocation either way.
The count moves when the package's own source or its own tests change,
which is the change the author is looking at. That is the whole of the
argument, and it is why this gate keeps its teeth while the
repository-wide one gives them up.

### Coverage attribution, and what it unlocks

Deno writes one coverage profile per pair of test file and source file. A
test file that exercises a source file produces a profile naming that
source and counting only what that test file reached. This was checked
rather than assumed: two test files touching different functions of one
module produce two separate profiles for that module, with the counts
correctly separated, and it holds under `--parallel`.

The profiles carry no marker saying which test file produced them, so
attribution needs one coverage directory per test file, which needs one
`deno test` invocation per test file. At 2,000 test files that is around
three and a half hours of runner time — impossible per run, and entirely
affordable as a weekly job sharded across the same lane machinery. Pattern
coverage needs none of this: `cf test` already writes one coverage file
per test.

What that buys is an **attribution map**: for every source line, the test
items that execute it. Published beside the manifest, refreshed weekly,
and stale in exactly the way a weekly map is stale — which is fine,
because it is used to *add* tests to a run, never to remove them.

An attribution target is a suite item, not a bare file path. When the same
file runs in default and non-default suites, the map keeps those targets
separate. A changed line makes every configuration whose measured item
executes it mandatory; coverage from one variant does not silently stand
in for another. A whole file or exact leaf declared unavailable in a
configuration is not a coverage target for that configuration. The file's
remaining available leaves continue to participate normally.

### Choosing tests by what the change touches

With the map, a pull request's changed source lines resolve to the test
items that execute them, and those items become mandatory. This is the
thing today's continuous integration cannot do at all, and it makes a
selected run better at its actual job than a scope-based guess would be: a
change to one function in `packages/runner` runs the tests that execute
that function, rather than a sample of the 655 test files in that package.

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

This is what covers the ground the repository-wide gate used to. For a
package that carries the per-package gate the ratchet still says no. For
everything else the comment says where a test would go, which is more
likely to produce a test than a failure was.

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
- **A rise in a covered package's own-tests number**, named as one the
  per-package gate exists to catch. There are three ways one reaches
  `main`: the change touched more covered packages than the cap allows, so
  the gate did not run; a package the change touched is on the exclusion
  list; or a change somewhere else moved which lines of that package its
  own tests reach. The comment says which, because the three call for
  different things — nothing, a look at the exclusion list, and a look at
  the change respectively.
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
selector did not pick will merge, and `main` will go red about 15 minutes
later. That is the trade. What makes it bearable is that the blast radius
is one commit, the full run names the test, the change that caused it gets
told without anybody going looking, and the failure raises that test's
score so the next change in that area runs it. If the rate turns out to be
intolerable, the escape hatch is a merge queue, which restores the
guarantee at the cost of merge latency. This plan does not propose one; it
notes that the option exists and that nothing here forecloses it.

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

**Coverage stops being enforced across the repository, and stays enforced
per package.** Nothing will fail because a change lowered the repository's
whole coverage number. What replaces that is a weekly trend somebody has
to choose to look at, plus a comment saying where a test would go. Over
the 31 packages that carry the [per-package
gate](#the-one-coverage-gate-that-survives) the ratchet still fails a pull
request, because there both sides measure the same complete thing. The
reduction in enforcement is real and confined to what could no longer be
measured per change: the code covered by suites a pull request only
samples. If debt starts climbing there, the response is a conversation
about the trend, not a reinstated gate on a number a selected run cannot
produce.

**A developer whose pull request fails on a test they did not touch needs
a way forward.** The job summary names every item the lane ran and why it
was chosen — the catches behind its score, the change that made it
mandatory, or the exploration draw — which makes "this is not mine" a fast
conclusion rather than a guess. `--explain` answers the same question for
any identity. Re-running the lane runs the same set, because the manifest
is pinned to the commit's date. And if none of that settles it,
`ci: full` runs everything.

## Failure modes

| What goes wrong | What happens |
| --- | --- |
| The store is unreachable from a lane | The lane runs the mandatory set plus a deterministic slice of the corpus sized to its budget, prints that it is running unselected, and passes or fails on that. Pull requests keep flowing. |
| The publisher has not run for a day | Lanes use the last manifest. Selection quality decays slowly; nothing fails. |
| The manifest is malformed or a newer schema | Rejected whole, treated as absent, same path as unreachable. |
| A selected item no longer exists in the tree | Dropped with a line in the summary. A renamed test is simultaneously an unknown item, so it runs anyway. |
| A new test surface nobody registered | `check-test-topology` fails on the next `main` run and names the unclaimed identities. |
| A record's variant or record surface contradicts its batch | Kept as written and named in the lane summary. The identity then belongs to no suite, so the store half of the drift guard fails on the next `main` run. |
| A suite gains a new variant with no records | Every available item in that variant is mandatory until a successful full `main` run accounts for every enumerated item under that exact variant, the store drift guard passes, and the next publisher cycle includes the run. Other variants do not stand in for it. |
| A variant deliberately skips a file or leaf | The topology reads the existing skip registry and the manifest reports the test as unavailable with its phase and reason. It is not unknown or a coverage target. Removing the skip makes it mandatory until `main` records it. |
| One item is bigger than a lane's planned budget | It gets a lane to itself, up to the hard five-minute bound. Bigger than that, a mandatory item is still placed and its lane over-runs, while a discretionary one is listed as unschedulable in the manifest and reported; the 60-second ratchet is the fix. |
| The mandatory set alone exceeds the budget | The lane runs it anyway and over-runs, past the five-minute step bound where the set demands it. The summary says by how much, which is what argues for raising the bound. |
| A covered package has no baseline, or none from an ancestor of the merge base | The lane reports the comparison and does not fail. The next full `main` run supplies one. |
| A covered package gains a test needing a browser or a server | It goes in the package's `browser-test` half, which the gate does not measure, so the Deno-only half keeps its gate. A package with no such half yet names one. |
| A covered package's measured set grows expensive | Reported in the publisher's summary and by `deno task test-selection coverage`. Nothing is excluded automatically; somebody splits the tests or adds a line to the exclusion list. |
| A test in a covered package fails | That package is reported rather than gated. Coverage measured through a failing suite says nothing about whether the change was tested, and the failure is the thing to fix. |
| A change touches more than two covered packages | The per-package gate does not run at all, and `Status` says so. The full run on `main` still measures every package, and a rise it finds is reported back to the pull request. |
| A lane dies without uploading its coverage | `Status` is already failing for the dead lane. It says the coverage total is incomplete rather than gating on a partial one. |
| A lane exceeds five minutes repeatedly | The correction factors rise on the next publisher run and less is packed. If it persists, the publisher's summary shows the miss and somebody looks. |
| Two attempts of one run straddle a UTC midnight | The later attempt's relay writes the earlier attempt's records a second time, under the later day, and the publisher folds both. Not observed in the store so far; see [What the store is missing](#what-the-store-is-missing). |
| A fork pull request | Works unchanged. The manifest is world-readable, and the existing member gate decides whether the fork's records ship. |
| A re-run of one failed lane | Runs the same set, because the manifest is resolved by the commit's date, which no attempt changes. |
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
that pair is the one worth writing first, because getting it wrong turns a
test that is flaky on `main` into the highest-scoring test in the
repository. A failure appearing on 11 branches within an hour is
environmental, not 11 catches. A test with four catches from two years ago
still outranks a test with none. An identity that has never failed
anywhere scores exactly `VALUE_FLOOR`, and one whose only failures were
classified as non-catches scores the floor plus its churn term and never a
missing value. A default identity and a variant with the same kind, scope,
and name get independent scores. And an identity absent from the store
comes out mandatory even when another variant has history.

Each suite's `enumerate()` and `locate()` get their own tests, and
`check-test-topology` is the integration-level check that they are
complete against what really ran. Its fixtures prove that a source item
may belong to one default suite and one non-default suite, that two suites
cannot claim it under the same variant, and that each stored identity maps
only to the suite carrying its exact variant. Separate fixtures cover both
skip shapes from `tasks/server-execution-on-skips.ts`: a whole-file skip is
declared unavailable and is not enumerated, while a step-level skip leaves
the file and its other identities available but excludes the named leaf
from the unknown and coverage rules. A CLI fixture maps step identities to
items and the overlapping `integration.sh` task identity to the suite. The
task identity is claimed by the drift guard but contributes to neither
item score nor item cost, so it cannot double-count its steps. The same
fixture holds the dispatch table's overlapping arms and proves that a step
reachable from several of them still locates to exactly one item.

The lane runner gets a mixed-lane fixture containing a default batch and a
non-default batch. Both direct spool fragments and JUnit-derived records
from the default batch must omit `v`; both sources from the non-default
batch must carry its exact value. The final shipping step must remain
unmarked, proving that no job-wide marker can overwrite the mixed records.
The command-line gather path and the lane runner exercise the same gather
function and fixtures, including its existing overwrite behavior when a
variant is declared and its topology warning for a marked direct record in
a default batch. A repeated-item fixture gives every execution fresh paths
and proves that records from every execution reach the lane spool.

The per-package coverage gate is tested from recorded profile directories
rather than by running tests. A fixture holding one workspace member's
coverage directory proves that converting it alone gives that member's own
figure, and that merging it with its siblings gives today's shard figure,
so the two series are shown to be the two readings of one set of profiles.
A workspace fixture proves that every member under `packages/` is covered
at whatever depth it sits, that a member added to the fixture's workspace
array is covered without any other edit, and that only the members in
`EXCLUDED_FROM_COVERAGE_GATE` are left out. A member defining `deno-test`
proves that the gate measures that task, that its coverage directory is
separate from the rest of `test`, and that a test added to `browser-test`
moves neither the measured half nor the member's place in the gate. The
packer gets a fixture proving that a covered package's items are not
reachable by the value, density, or exploration pass, and are not
repeated. The join gets a fixture of five lanes' reports for one package
split across them, proving that the total equals the same tests measured
in one run, and that a package whose items landed in three lanes is scored
once. A diff touching one, two, and three covered packages proves the
cap: gated, gated, and not gated at all rather than gated for two of the
three. And the baseline walk is tested against recorded chains of `main`
commits: a rise against an ancestor fails, a rise against a run the merge
base does not contain reports, and a package with no baseline reports.

The reporter's attribution is where a bug would be most costly, because a
wrong comment lands on a person. It is tested against recorded pairs of
consecutive `main` runs, and the property that matters is the negative
one: a test already failing in the previous run produces no comment, so a
break never gets attributed to whoever merged next.

Everything a person types goes through one entry point, `deno task
test-selection`. Its modes are also how the system is tested by hand.

- `plan --dry-run` prints what would run — batches, items, repeats,
  capabilities, projected times, and what was withheld — and runs nothing.
  Given a lane number it answers "what would lane three do on my branch?",
  and given none it prints all five. Pointed at a recorded run rather than
  a working tree, it is the offline projection this plan's own numbers are
  checked against.
- `plan --verify` compares the identity set the topology produces against
  what a recorded run actually executed, and names the difference in both
  directions: identities the run produced that no suite claims, and items
  the topology enumerates that the run never recorded. This is what proves
  the topology accounts for everything before it replaces the old matrix.
- `explain <identity>` prints one test's score, the catches behind it
  with their dates and sources, its flake rate, and which item it maps to.
  A suite-level measurement instead says that it is not selectable. For an
  item identity, the output says whether the current manifest selects it,
  withholds it, or repeats it. The argument accepts the canonical three- or
  four-part identity key, and the output always names a present variant.
  This is what somebody uses to answer "why did my test not run?", which
  is the question this system will be asked most often and the one it
  would otherwise answer badly.
- `dials` prints every dial with its comment, its current value and the
  unit that value is in, saying of each whether it is chosen or measured,
  and for a measured one whether the figure shown is still the checked-in
  seed or one the publisher has since written back.
- `coverage` prints every workspace member, whether it carries the
  per-package coverage gate, the reason beside it when it does not, the
  task the gate measures, and the baseline the newest manifest holds for
  it. This is what somebody uses to answer "why is my package not gated?"
  and "what am I being compared against?".

`tasks/ci-lane.ts` keeps a `--dry-run` of its own, because that is how
continuous integration asks the same question from inside a job.
`plan --dry-run` is that code path with a person's output rather than a
job summary, so the two cannot disagree about what would run.

## Every dial in one place

`tasks/test-selection/policy.ts` holds every number this design can be
tuned by, and nothing else holds any of them. Each is a named export with
a comment saying what it does, which way to move it, and what moving it
costs. `deno task test-selection dials` prints the current values with
those comments, and every manifest records the values it was built with,
so a manifest is self-describing and a change in behavior can always be
traced to a change in a dial.

The **Units** column says what each number counts. Several of the dials
are bare fractions that do not mean the same thing, and the table holds
two different `0.25` values as it stands: `WEIGHT_BREADTH` is a share of a
test's score and `FILL_DENSITY_SHARE` is a share of a lane's budget. A
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

| Dial | Default | Units | Set by | Why you would move it, and which way |
| --- | --- | --- | --- | --- |
| `LANES` | 5 | lanes | Chosen | Up when pull-request feedback is too thin and runner capacity allows more; down when the wave crowds other workflows off the shared runners. |
| `LANE_BOUND_SECONDS` | 300 | seconds | Chosen | Up when more should fit in a lane; down when five minutes is longer than anybody will wait for a first answer. Either way `LANE_WORK_TIMEOUT_MINUTES` and `LANE_JOB_TIMEOUT_MINUTES` in `deno.yml` move with it. |
| `LANE_PROLOGUE_SECONDS` | 40 | seconds | Measured | Never. The publisher overwrites it from the lanes' own timing records, and the checked-in figure is only what the first lane uses before any lane has reported one. |
| `LANE_SAFETY_SECONDS` | 30 | seconds | Chosen | Up when lanes overrun their bound on slow runners; down when they finish early every time and the headroom is buying nothing. |
| `FULL_LANE_BOUND_SECONDS` | 600 | seconds | Chosen | Up when `main`'s run uses more jobs than it needs; down when `main` takes too long to say something broke. |
| `FULL_LANE_BUDGET_SECONDS` | 530 | seconds | Derived | Nothing edits this. It is the full run's bound less the same prologue and safety margin a pull request's lane pays, since a lane of either run is the same job doing the same setup on the same runner. |
| `FULL_RUN_LABEL` | `ci: full` | a label | Chosen | Not a quantity. Change it only if the label collides with one the repository already uses for something else. |
| `VALUE_FLOOR` | 0.05 | score | Chosen | Up when the cheap tail is not being swept up; down when it crowds out tests with a record of catching things. |
| `WEIGHT_PROVEN` | 0.55 | share of the score | Chosen | Up when a record of catching things should count for more. The three weights are shares of one score, so what this gains the other two lose. |
| `WEIGHT_BREADTH` | 0.25 | share of the score | Chosen | Up when a test that several distinct sources have hit should count for more; down when breadth is mostly telling you about the environment rather than the test. |
| `WEIGHT_CHURN` | 0.15 | share of the score | Chosen | Up when something going wrong right now should jump the queue faster; down when the queue keeps being jumped by noise. |
| `PROVEN_SATURATION` | 2 | catches | Chosen | Up when four catches should outrank one by more; down when one catch should already be worth nearly everything a test can earn. |
| `FRESHNESS_HALF_LIFE_DAYS` | 120 | days | Chosen | Up when old catches should keep more of their value; down when a test that caught something a year ago crowds out one that caught something last week. |
| `FRESHNESS_FLOOR` | 0.3 | multiplier | Chosen | Up when a very old catch should keep more of its worth; down when age should be allowed to retire one almost completely. |
| `CATCH_WEIGHT_LOCAL` | 2.0 | multiplier | Chosen | Up when evidence from a workstation should count for more; down if local records ever arrive in volume and stop being the scarce signal they are today. |
| `CATCH_WEIGHT_PR` | 1.0 | multiplier | Chosen | Neither. It is the unit the other two are expressed against, so move those instead. |
| `CATCH_WEIGHT_MAIN` | 1.5 | multiplier | Chosen | Up when an escape should pull harder on what gets selected next; down when `main`'s failures are mostly environmental rather than real. |
| `CHURN_HALF_LIFE_DAYS` | 14 | days | Chosen | Up when recent trouble should stay relevant for longer; down when a problem already fixed keeps its tests selected for weeks afterwards. |
| `FILL_VALUE_SHARE` | 0.60 | share of the budget | Chosen | Up when expensive high-value tests are crowded out by cheap ones; down when a lane spends its budget on a few slow tests and runs little else. The three shares sum to one. |
| `FILL_DENSITY_SHARE` | 0.25 | share of the budget | Chosen | Up when more of the cheap tail should run; down when the tail is displacing tests with a record. |
| `FILL_EXPLORATION_SHARE` | 0.15 | share of the budget | Chosen | Up when the unselected corpus is going stale; down when lanes spend the share on tests that never find anything. |
| `FLAKE_EXCLUSION_RATE` | 0.05 | share of runs | Chosen | Up when fewer tests should be held back from pull requests; down when flakes are still blocking people. |
| `FLAKE_REPEAT_RATES` | 0.01, 0.03 | share of runs | Chosen | Up when repeats cost more lane time than the intermittent failures they catch are worth; down when intermittent failures are still slipping through. Every band stays under `FLAKE_EXCLUSION_RATE`, or an item is excluded before it reaches the band and the band never fires. |
| `MAX_REPEATS` | 3 | runs of one item | Chosen | Up when intermittent regressions still get through; down when repeats are crowding a lane. |
| `SUITE_FLAKE_PRIOR_RATE` | 0.02 | share of runs | Chosen | Up when too many suites count as flake-prone and their new items are repeated needlessly; down when new tests in a noisy suite land unrepeated and then flake. |
| `COVERAGE_COMMENT_LINES` | 25 | lines | Chosen | Up when coverage comments are too noisy; down when debt is climbing unnoticed. |
| `LOCAL_COVERAGE_MAX_SECONDS` | 30 | seconds | Chosen | Up when too many packages are reported as expensive for the report to be worth reading; down when one is quietly eating a lane. Nothing is excluded either way; it only decides what the summary mentions. |
| `LOCAL_COVERAGE_MAX_PACKAGES` | 2 | packages | Chosen | Up when broader changes should still be gated and the run can afford their packages' whole test sets; down when sweeping changes are crowding lanes. |
| `EXCLUDED_FROM_COVERAGE_GATE` | nine | workspace members | Chosen | Not a quantity. A line comes off when a package fits the run's budget or gains a Deno-only half, which turns its gate on. A line goes on when a package's own tests stop being what covers it. |
| `LOCAL_COVERAGE_BASELINE_DAYS` | 7 | days | Chosen | Up when branches based further back are being reported for want of an ancestor baseline; down when the manifest carries more history than anybody reads. |
| `COVERAGE_TREND_WEEKS` | 3 | weeks | Chosen | Up when the tile goes amber too readily; down when debt climbs for a month before anybody is told. |
| `CATCH_BREADTH_WINDOW_DAYS` | 2 | days | Chosen | Up when a broken runner's failures are being counted as catches; down when genuine breadth is being written off as environmental. |
| `ENVIRONMENTAL_MIN_SOURCES` | 5 | sources | Chosen | How many distinct sources a failure spans inside that window before it reads as the environment. Up when a genuinely broad regression is written off; down when a broken runner's failures still count as catches. |
| `BREADTH_SATURATION` | 2 | sources | Chosen | Where the breadth term reaches half its ceiling. Up when four sources should outrank one by more; down when one source should already be worth nearly all of it. |
| `CHURN_WINDOW_DAYS` | 60 | days | Chosen | How far back the decayed counts are read. Past this the weight is under one part in sixteen, so this is a performance decision rather than a policy one. |
| `SAME_COMMIT_REACH_DAYS` | 2 | days | Chosen | How far back the fold remembers a commit's outcomes, so that a re-run landing in a later batch than the run it repeats is still read as the test disagreeing with itself. Up when re-runs land far enough behind that their disagreement is counted as a catch; down when the fold's memory is what will not fit. It costs the number of identities that have failed times the number of commits, so it is the first dial to look at when a publisher run runs out of memory. |
| `FLAKE_COMMIT_REACH` | 8 | commits | Chosen | How many of the most recently observed commits the fold keeps outcomes at, alongside the span above. Moves for the same two reasons and against the same cost. |
| `FLAKE_WINDOW_DAYS` | 60 | days | Chosen | Up when a flake rate swings about on too little evidence; down when a test since fixed stays excluded. |
| `COST_WINDOW_DAYS` | 7 | days | Chosen | Up when cost estimates are noisy; down when durations drift faster than the estimate follows. |
| `ATTRIBUTION_MAP_DAYS` | 7 | days | Chosen | Up when rebuilding the map costs more than its staleness does; down when changed lines keep resolving to tests that have moved. |
| `ALIAS_GATE_MIN_CATCHES` | off | catches | Chosen | Off by default. Turn it on at a catch count to fail a pull request that discards that much history in a rename without an alias line, and lower the count as the alias file becomes routine. |

Three more numbers are measured, and they are not in the table because
they are not in `policy.ts`: `setupCost` for each capability, and
`suiteOverhead` and `correction` for each suite. They are fitted from the
lanes' own timing records and published in the manifest, one set per
publisher run, which is where to read them. Nothing hand-edits them, and a
manifest carrying a strange one is a measurement to look at rather than a
setting to fix. They are listed here so that the answer to "what numbers
decide what runs" is complete rather than only complete for the ones a
person owns.

Of the chosen dials, three are worth revisiting first, because their right
values are empirical rather than structural. They stay chosen — nothing
measures them for us — but the evidence for moving them accumulates:
`FRESHNESS_HALF_LIFE_DAYS`, which decides how long a proven test stays
proven; `FLAKE_EXCLUSION_RATE`, which trades pull-request noise against
coverage; and `CHURN_HALF_LIFE_DAYS`.

## The work

**One pull request, unless something mechanical forces otherwise.** No
flags, no shadow systems, and nothing to flip. The three parts below are a
build order rather than three changes: each depends on the one before it,
and splitting them across pull requests buys a little caution at the price
of three review cycles, three rebases of a large change, and a stretch of
weeks in which the repository holds half a system and nobody can tell
which half.

The rest of this section is about what a single landing has to satisfy. It
is worth reading before assuming a split is needed, because two of the
three reasons that look like they force one turn out not to.

### The prerequisites that are not ours

The publisher needs a writer credential: the `test-selection-labs` service
account with `objectCreator` on the manifest and state prefixes, and a
Workload Identity provider pinned to
`.github/workflows/test-selection.yml` on `main`. Manifest and state
objects expire after 45 days, and that lifecycle rule is what a lane's
resolution rests on: a commit resolves the newest manifest at or before
its own date, so the manifests a run may need have to outlive the window
in which GitHub still permits that run to be re-run. Where the re-run
window is the longer of the two, the retention is what to raise. The same
infra root provisions the compactor principal.

All of that lives in the infra repository under `tofu/test-records`, and
all of it is applied: the accounts, the grants, the pinned providers, and
the lifecycle rule. Nothing outside this repository has to happen before
the work here publishes, so this is not a reason to split it.

### Proving the topology before merging, not after

The strongest argument for a separate pull request was that the topology
is only really proven by running, so it should carry `main` for a while
before any pull request depends on it. That argument does not survive
contact with the design, because the design already has the mechanism.

A pull request labelled `ci: full` runs `plan-full` and `full-tests`, the
same two jobs a push to `main` runs. So the branch can run exactly what
`main` would run, against its own tree, as many times as it takes, before
anything merges. That is the proof the extra pull request was there to
buy, and it costs a label.

The other pre-merge checks are all offline or read-only:

- `plan --verify` compares the identity set the topology produces against
  what the old matrix ran, from the store rather than by eye.
- The store half of the drift guard runs on the branch against the most
  recent `main` run's records, which is the same comparison it will make
  after merging.
- `plan --dry-run` over the reference records is a pure function over
  recorded data and needs nothing live.

What remains unproven until the topology actually carries `main` is
narrow: that a full run through the lane runner produces the same record
set as the old matrix did, on `main`'s own tree rather than on a branch.
The `ci: full` run makes that a small residual rather than the main risk.

### The window after merging, and why it is safe

A manifest cannot exist before the topology has produced a `main` run,
because there is nothing to build one from. So there is a window: merge,
`main`'s full run, the one-off publisher dispatch, and only then does
selection have data. That window is one `main` run and one manual
dispatch, not days.

Pull requests in that window are already handled. A lane that finds no
manifest takes the same path as a lane that cannot reach the store: it
runs the mandatory set plus a deterministic slice of the corpus sized to
its budget, and prints that it is running unselected. Feedback is weaker
than selection for one afternoon and no worse than a coin toss about which
tests run, which is what the old shard layout was anyway.

The calibration numbers converge over the days after that, from the lanes'
own timing records, which is what they were always going to do.

### Part one — the data, and what it already tells us

Nothing about what continuous integration runs changes. This pull request
only makes the store answer questions it cannot answer yet, and puts the
answers somewhere people can see them.

- [x] A preload module in `@commonfabric/test-support` that captures the
      registering module for every `Deno.test` and writes the name-to-file
      map into the spool; `ingestJUnit` joins on it; every `deno test`
      invocation carries the preload.
- [x] `packages/deno-web-test/runner.ts` sets `file` on the records it
      writes directly.
- [x] `tasks/test-selection/{policy,score,manifest,store}.ts` — the dials,
      the catch and flake derivation, the manifest format and its
      validators, and the reader and writer. Complete identities use the
      canonical test-record key, optional variants included, and variants
      score independently. Identities resolve through `loadAliasResolver`,
      as the report tool and dashboard collector already do. A
      reference-scale fixture records the serialized and gzipped manifest
      sizes instead of deriving item size from the identity count.
- [x] `tasks/test-selection/plan.ts`, the pure packing function, tested
      offline against recorded manifests.
- [x] `tasks/test-selection-publish.ts` and
      `.github/workflows/test-selection.yml`, on a four-hourly cron.
- [x] Hold manifest retention above the window in which GitHub still
      permits a run to be re-run. A lane resolves the newest manifest at or
      before the commit's date, so the answer is the same for every lane
      and every later attempt as long as the object it names still exists.
      A manifest that expires between an attempt and its re-run is the one
      way the two can disagree, and the lifecycle rule is where that is
      settled rather than in anything a lane reads.
- [x] One source-and-date input plan, which bootstrap and ordinary
      publishing both apply. A flag is permission to start from an empty
      aggregate and a wider default window, and nothing else decides what
      is read.
- [x] A source-scoped receipt in place of the date-only one, so that a
      rollup of the shared area cannot say a day is accounted for and
      take that day's local submissions with it. Local records stay on
      their raw path until they have rollups of their own.
- [ ] The one-off bootstrap dispatch.
- [x] Repeat the record census after `main` emitted server-execution
      variant records, and replace the plan's projection inputs.
- [ ] Dashboard tiles: the coverage debt trend, the flake list, what the
      newest manifest would select, and the escape rate — how often
      something reaches `main` that a test we already had caught there.
      That last one is measurable today, before any of this changes what
      runs, which makes it the baseline everything after is judged
      against.
  - [x] The flake list, and what the newest manifest would select.
  - [x] The coverage debt trend. It reads the repository-wide figure each
        `main` run's `perf-metrics` artifact already carries, so it needed
        nothing from the rest of this work.
  - [ ] The escape rate. Every manifest carries each identity's `main`
        catches, but over unbounded history, so a rate needs the state to
        keep those per day as well as in total.
- [x] The `deno task test-selection` entry point and its modes: `dials`,
      `coverage`, `explain <identity>`, and `plan` with `--dry-run` and
      `--verify`. Every mode that packs reads the topology, so the
      capability setup a lane opens is charged here as it is there.

On its own this part gives the repository a flake list derived from
evidence rather than from anecdote, and a coverage trend nobody has today.
If the rest never landed it would still have been worth it, which is why
it is the one part worth splitting off if the change has to be split at
all.

### Part two — the topology

The topology goes in, and both `main` and the `ci: full` label start using
it. Nothing here depends on selection, so this part can be finished and
exercised on the branch on its own.

- [x] `tasks/test-topology.ts` and one module per suite, including each
      suite's declared record surfaces and optional variant, and typed
      record-surface descriptors for every JUnit output. `locate()`
      distinguishes item identities from overlapping suite-level
      measurements, and returns at most one item for an identity that
      several arms or entry points can run. Add `tasks/ci-capabilities.ts`.
      Twenty-one suites currently hold 2,396 units. The repository gates are two
      suites rather than one, because `mandatory` belongs to a suite and
      the `always` set has to stay tiny: `repo-gates` holds formatting,
      linting and the drift guard, and `repo-checks` holds the rest of
      what the `Check` job runs, selected on value like anything else.
- [x] The server-execution ON configuration consumes
      `tasks/server-execution-on-skips.ts`: whole-file entries are declared
      unavailable and omitted from enumeration, while step entries exclude
      only the named leaf identity from unknown and coverage rules.
- [x] Give `packages/cli/integration/fuse-exec.sh` fine granularity.
  - [x] Every phase records, so the suite records 25 identities rather
        than one, across the 23 phases the script goes through. Each
        marker leads the phase it names, through the same
        `cf_test_step_begin` `integration.sh` uses, so a phase that fails
        is the record that carries the failure rather than the script's
        own record carrying it. The two phases that bring the mount up
        are the identities this adds beyond the phases that already
        named one.
  - [x] It gains a section dispatch over the four groups of phases that
        stand alone, so `cli-fuse` becomes an item suite like its sibling.
        A section is a group of phases over one mount, and the
        dependencies deciding where the boundaries fall are named in
        [today's jobs as suites](#todays-jobs-as-suites).
        `packages/cli/test/fuse-sections.test.ts` holds the dispatch table
        to the properties that make a section schedulable, the way
        `integration-sections.test.ts` holds its sibling's.
- [x] Split the `piece-call` CLI integration dispatch into its eight
      recorded steps. Seven already had an arm of their own; the missing
      one for `run_piece_call` is added, and so are the two the
      `piece-values` group hid, so every recorded step now has an arm that
      runs it alone. The grouped arms stay for hand runs and are not
      enumerated. Making those arms the `cli-core` items is the topology's
      part. `packages/cli/test/integration-sections.test.ts` holds the
      dispatch table to that property, and to every step being scheduled
      by some group rather than only by name.
- [x] `tasks/test-topology/binaries.ts`: each shipped binary is a unit
      whose test is that it still compiles, and the toolshed under the
      server-execution define is a variant of that rather than a second
      test. A pull request runs its servers and its command line from
      source and compiles nothing, so without these a broken compile
      would be found only on `main`.
- [x] `tasks/check-test-topology.ts`, both halves, wired into
      `repo-gates`, with exact variant matching and one source-item claim
      allowed per variant. Two test files under
      `packages/cf-harness/integration/` are reached only by a package
      task nothing dispatches; they are recorded with the reason each
      runs nowhere and reported rather than failed on, so a new
      unclaimed surface still fails. Eight paths that look like tests
      and are not are declared as the fixtures they are: the five
      projects under `packages/deno-web-test/test/` that the harness
      drives, and the three command-line tours the verb-session gate
      holds the documentation to rather than running.
- [x] Extract the part of `tasks/test-records-gather.ts` that reads records,
      ingests JUnit, and applies a declared variant as the shared gather
      function. Its command-line entry point and `tasks/ci-lane.ts` both
      use it. The lane runner gives every batch execution fresh spool and
      JUnit paths, gathers it before any repeat, and combines all records
      into the unmarked lane spool. It also includes `--full`, `--dry-run`,
      and repeats.
- [ ] `deno.yml`: `plan-full` and `full-tests` on push, with the build,
      attestation, coverage and deploy jobs repointed at them.
- [ ] The weekly coverage attribution job, and the map published beside
      the manifest.
- [ ] Repository-wide coverage measurement moves to the full run and stops
      failing anything.
- [ ] `tasks/write-coverage-lcov.ts` converts each workspace member's
      coverage directory on its own as well as merging them, so the full
      run yields a per-package own-tests figure beside the existing
      per-shard report. No test changes how it runs.
- [ ] Delete the hand-maintained sharding: `tasks/test-timing-weights.ts`,
      `tasks/select-runner-test-files.ts`,
      `tasks/run-sharded-test-files.ts`, `INTERNALLY_SHARDED_PACKAGES` and
      the shard environment variables the packages' own runners read, and
      `TEST_DISABLED_PACKAGES: runner` with the separate `Runner Tests`
      matrix. `tasks/weighted-shards.ts` stays and the lane packer calls
      it. Nothing may be balanced by a transcribed number afterwards, and
      `check-test-topology` is what proves the items are all still there.
- [ ] `tasks/workspace-tests.ts` gives a member's `deno-test` task, where
      it defines one, a coverage directory separate from the rest of its
      `test` task, and `packages/ui` and `packages/iframe-sandbox` split
      their one-string test tasks the way `packages/static` already writes
      the same split.
- [ ] The publisher carries each covered member's own-tests figure and its
      commit in the manifest, along with the exclusion list it used and
      the batches it found expensive.
- [ ] Before merging: `plan --verify` against the last `main` run, proving
      the manifest accounts for every item the topology enumerates under
      its exact variant, apart from explicitly unavailable skip entries,
      and the store half of the drift guard passes against the same run.
      Compare from the store rather than by eye.
- [ ] Before merging: at least one `ci: full` run on the branch, green,
      accounting for every item the topology enumerates under its exact
      variant apart from explicit unavailable entries. This is what
      running on `main` was going to prove, done where a mistake costs one
      branch.
- [ ] Before merging: `plan --dry-run` over the reference records, after
      classifying every identity and mapping every item-level identity to
      its runnable item. Record selected item count, measured test time,
      capability setup, repeats, and unschedulable items. All five lanes
      retain their 30-second safety margin.

### Part three — the pull-request path

- [ ] `deno.yml`: five `pr-tests` lanes replace every pull-request job;
      `Status` depends on `pr-tests` and `full-tests`, with `skipped`
      counting as success for the latter.
- [ ] The `ci: full` label.
- [ ] `coverage-comment.yml` generalized into the reporter, with the
      first-failure attribution, the selected-or-not line, the coverage
      note, the per-package rise note naming which of the three routes let
      it through, the flaky-new-test note, and the rename suggestion with
      its ready-to-append alias line.
- [ ] The per-package coverage gate, in two halves. `tasks/ci-lane.ts`
      makes every item of a covered package the diff touches mandatory,
      keeps those items out of later passes and out of repeats, and
      uploads one coverage report per workspace member. `Status`
      downloads the five, adds them per member, walks the manifest for the
      nearest-ancestor baseline, checks for a rise, and reads
      `ACCEPT_COVERAGE_DEBT` from the pull request's description. `Status`
      works out which packages the gate covers by running the same
      function the lanes run, cap included, rather than trusting a lane's
      report. A coverage failure names itself as one, a package with a
      failing test is reported rather than gated, and a change over the
      cap turns the gate off with a line saying so.
- [ ] `tasks/ci-workflow.test.ts` updated for the new anchors and shapes,
      including that the shared lane ship step carries no job-wide variant.
- [ ] Documentation, in the same pull request rather than after it:
      `docs/specs/test-selection.md` for the contract,
      `docs/development/test-selection.md` for the operating guide, the
      trust-boundary amendment and new dataset area in
      `docs/specs/test-records.md`, `docs/development/COVERAGE.md`
      rewritten around a trend for the repository-wide number and around
      the per-package gate that keeps its teeth,
      `docs/development/CI_PERFORMANCE.md` around lanes rather than shard
      balance, and `.claude/rules/github-workflows.md` and
      `.claude/rules/tests.md` where "add a job" becomes "add a suite".
      `.claude/rules/workspace-packages.md` gains the `deno-test`
      convention: a package that mixes Deno-only tests with tests needing
      a browser names the Deno-only half `deno-test`, and that half is
      what the coverage gate measures.
- [ ] This plan archived.

### What would force a split, and what to split first

Nothing mechanical does. The infra credential is already in place, the
topology can be proven on the branch with `ci: full`, and the window
before the first manifest is one `main` run that the lane fallback
already covers.

What could force one is review. This is a large change to the way the
repository tests itself, and a reviewer who cannot hold it at once is a
reason to split that is worth taking seriously — a change nobody has
really read is worse than a change that landed in two pieces.

If it comes to that, split part one off and leave parts two and three
together. Part one changes no behavior at all: it teaches the store to
answer questions it cannot answer yet and puts the answers on the
dashboard. It is separately useful even if the rest never lands, since it
gives the repository a flake list derived from evidence and a coverage
trend it does not have today. And it is the part with no dependency on
anything else, so landing it first costs nothing and removes a third of
the diff from the change that carries the risk.

Splitting parts two and three is the split to avoid. They share the
topology, the lane runner, and the manifest, and separating them means
writing the full run's job matrix twice: once against the old
pull-request layout and again when the lanes replace it.
